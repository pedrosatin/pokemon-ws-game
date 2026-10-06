import { DurableObject } from "cloudflare:workers";
import {
  DECK_SIZE,
  GEN1_MAX_ID,
  INTER_ROUND_MS,
  RECONNECT_GRACE_MS,
  TURN_MS,
} from "../shared/constants";
import {
  compareRound,
  dealDecks,
  highestStat,
} from "../shared/game";
import {
  CLOSE_JOIN_REFUSED,
  CLOSE_REPLACED,
  MAX_MESSAGE_LENGTH,
  parseClientMessage,
  makeEnvelope,
  STAT_KEYS,
  type ClientMessage,
  type PlayerPublic,
  type RoomPhase,
  type ServerMessage,
  type StatKey,
} from "../shared/protocol";
import { track } from "./analytics";

type SessionAttachment = {
  clientId: string;
  playerId: string;
  displayName: string;
  /** Momento da conexão; usado para o prazo do JOIN_ROOM de sockets "pending". */
  connectedAt?: number;
};

type RoomPlayer = {
  playerId: string;
  clientId: string;
  displayName: string;
  ready: boolean;
};

type MatchState = {
  playerOrder: string[];
  decks: Record<string, number[]>;
  roundIndex: number;
  roundId: string | null;
  turnPlayerId: string | null;
  deadlineMs: number;
  rematchVotes: string[];
};

type PendingForfeit = {
  playerId: string;
  at: number;
};

type AlarmKind = "turn" | "nextRound" | "forfeit" | "expire" | "join" | "claim";

const MESSAGE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 30;
/**
 * Conexões abertas na sala, contadas pelos sockets ativos do runtime. Na
 * prática o teto efetivo é 6 (2 jogadores + MAX_PENDING_SESSIONS); este valor
 * fica como proteção.
 */
export const MAX_SESSIONS_PER_ROOM = 16;
/** Conexões que ainda não mandaram JOIN_ROOM. A mais antiga cede a vaga. */
export const MAX_PENDING_SESSIONS = 4;
/** Prazo para o JOIN_ROOM depois da conexão. */
export const JOIN_TIMEOUT_MS = 10_000;
/** Intervalo entre tentativas de claim no diretório depois de uma falha. */
export const CLAIM_RETRY_MS = 30_000;
/** Tentativas de claim por instância do objeto. */
export const MAX_CLAIM_ATTEMPTS = 10;

/**
 * Sala autoritativa: lobby + Super Trunfo + reconnect com grace 60s.
 */
export class GameRoom extends DurableObject<Env> {
  private sessions = new Map<WebSocket, SessionAttachment>();
  private players = new Map<string, RoomPlayer>();
  private phase: RoomPhase = "lobby";
  private code = "";
  private seq = 0;
  private expiresAt = 0;
  private messageWindows = new Map<WebSocket, { count: number; until: number }>();
  private scores: Record<string, number> = {};
  private match: MatchState | null = null;
  private pendingForfeit: PendingForfeit | null = null;
  private nextRoundAt: number | null = null;
  /** O diretório já trocou a validade curta da sala pela normal. */
  private claimed = false;
  private claimAttempts = 0;
  private claimRetryAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<{
        code: string;
        expiresAt?: number;
        phase: RoomPhase;
        seq: number;
        scores: Record<string, number>;
        players: RoomPlayer[];
        match: MatchState | null;
        pendingForfeit: PendingForfeit | null;
        nextRoundAt: number | null;
        claimed?: boolean;
      }>("room");
      if (stored) {
        this.code = stored.code;
        this.expiresAt = stored.expiresAt ?? Date.now();
        this.phase = stored.phase;
        this.seq = stored.seq;
        this.scores = stored.scores;
        this.players = new Map(stored.players.map((p) => [p.playerId, p]));
        this.match = stored.match;
        this.pendingForfeit = stored.pendingForfeit ?? null;
        this.nextRoundAt = stored.nextRoundAt ?? null;
        // Salas gravadas antes da validade curta já nasceram com 2 h.
        this.claimed = stored.claimed ?? true;
        await this.scheduleAlarm();
      }
    });

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (attachment) this.sessions.set(ws, attachment);
    }

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/init") {
      if (this.expiresAt) return new Response(null, { status: 409 });
      const room = await request.json().catch(() => null) as { code?: unknown; expiresAt?: unknown } | null;
      if (typeof room?.code !== "string" || typeof room.expiresAt !== "number" || !Number.isFinite(room.expiresAt)) {
        return new Response(null, { status: 400 });
      }
      this.code = room.code;
      this.expiresAt = room.expiresAt;
      this.claimed = false;
      await this.persist();
      await this.scheduleAlarm();
      return Response.json({ code: this.code });
    }
    if (!this.expiresAt || this.expiresAt <= Date.now()) return new Response("Room expired", { status: 404 });
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return Response.json({
        code: this.code,
        phase: this.phase,
        players: this.publicPlayers(),
        pendingForfeit: this.pendingForfeit,
      });
    }

    if (request.method !== "GET") {
      return new Response("Expected GET", { status: 400 });
    }

    const now = Date.now();
    await this.closeExpiredPending(now);
    // Sockets sem JOIN_ROOM não seguram a sala: o mais antigo cede a vaga, então
    // a conexão nova de um jogador registrado sempre encontra lugar.
    for (const [ws] of this.pendingSessions()) {
      if (this.pendingSessions().length < MAX_PENDING_SESSIONS && this.openSockets().length < MAX_SESSIONS_PER_ROOM) break;
      await this.closeSession(ws, 1013, "Too many pending connections");
    }
    if (this.openSockets().length >= MAX_SESSIONS_PER_ROOM) {
      return new Response("Room is full", { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const provisional: SessionAttachment = {
      clientId: "pending",
      playerId: crypto.randomUUID(),
      displayName: "",
      connectedAt: now,
    };
    server.serializeAttachment(provisional);
    this.sessions.set(server, provisional);
    const deadline = now + JOIN_TIMEOUT_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > deadline) await this.ctx.storage.setAlarm(deadline);
    track("ws_connected", { roomId: this.code, isReconnect: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const now = Date.now();
    const window = this.messageWindows.get(ws) ?? { count: 0, until: now + MESSAGE_WINDOW_MS };
    if (window.until <= now) {
      window.count = 0;
      window.until = now + MESSAGE_WINDOW_MS;
    }
    this.messageWindows.set(ws, window);
    window.count += 1;
    // O servidor fecha antes de fazer o parse; parseClientMessage repete o
    // limite de tamanho para continuar seguro quando usado isoladamente.
    // Frames binários contam na janela e no tamanho como os de texto.
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (window.count > MAX_MESSAGES_PER_WINDOW || size > MAX_MESSAGE_LENGTH) {
      await this.closeSession(ws, 1008, "Message limit");
      return;
    }
    if (typeof message !== "string") {
      this.send(ws, this.error("INVALID_PAYLOAD", "Mensagem deve ser JSON texto."));
      await this.closeSession(ws, 1003, "Text frames only");
      return;
    }
    const session = this.sessions.get(ws);
    if (session && this.isJoinOverdue(session, now)) {
      await this.closeSession(ws, 1008, "Join timeout");
      return;
    }
    if (this.expiresAt <= now) {
      this.send(ws, this.roomExpiredError());
      await this.closeSession(ws, 1008, "Room expired");
      return;
    }
    const parsed = parseClientMessage(message, this.code);
    if (!parsed) {
      this.send(ws, this.error("INVALID_PAYLOAD", "Mensagem inválida."));
      return;
    }

    switch (parsed.type) {
      case "JOIN_ROOM":
        await this.handleJoin(ws, parsed);
        break;
      case "READY":
        await this.handleReady(ws, parsed.payload.ready);
        break;
      case "SELECT_STAT":
        await this.handleSelectStat(ws, parsed.payload.roundId, parsed.payload.stat);
        break;
      case "REQUEST_SYNC":
        await this.resyncPlayer(ws);
        break;
      case "LEAVE":
        // Sair encerra a conexão: o socket não continua aberto fora do teto
        // de sessões nem com a janela de mensagens zerada.
        await this.closeSession(ws, 1000, "left");
        break;
      case "REMATCH":
        await this.handleRematch(ws);
        break;
      default:
        this.send(ws, this.error("UNKNOWN", "Tipo de mensagem desconhecido."));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    track("ws_disconnected", { roomId: this.code, code, reason: reason || "" });
    this.messageWindows.delete(ws);
    // 1005/1006 são códigos reservados e ws.close lança com eles; a limpeza
    // da sessão roda antes e independe do fechamento.
    await this.closeSession(ws, code, reason, reason || "closed");
  }

  async webSocketError(ws: WebSocket) {
    this.messageWindows.delete(ws);
    await this.handleLeave(ws, "error");
  }

  async alarm() {
    const now = Date.now();
    // Sala com jogadores e claim pendente: tenta o claim antes de expirar,
    // para uma falha passageira do diretório não encerrar a partida.
    if (this.expiresAt <= now && !this.claimed && this.players.size > 0 && await this.claim()) {
      await this.persist();
    }
    if (this.expiresAt <= now) {
      const expired = this.roomExpiredError();
      for (const ws of this.ctx.getWebSockets()) {
        this.send(ws, expired);
        try {
          ws.close(1000, "Room expired");
        } catch {
          // socket já fechado
        }
      }
      this.sessions.clear();
      this.messageWindows.clear();
      this.players.clear();
      this.expiresAt = 0;
      this.match = null;
      this.code = "";
      this.phase = "lobby";
      this.seq = 0;
      this.scores = {};
      this.pendingForfeit = null;
      this.nextRoundAt = null;
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.closeExpiredPending(now);

    if (this.claimRetryAt && this.claimRetryAt <= now) {
      this.claimRetryAt = null;
      if (await this.claim()) await this.persist();
    }

    if (this.pendingForfeit && this.pendingForfeit.at <= now) {
      if (!this.isPlayerConnected(this.pendingForfeit.playerId)) {
        await this.forfeitPlayer(this.pendingForfeit.playerId);
        return;
      }
      // O jogador voltou sem passar pelo JOIN_ROOM: consome o evento para não
      // agendar o alarm no passado em loop.
      this.pendingForfeit = null;
      await this.persist();
    }

    if (this.nextRoundAt && this.nextRoundAt <= now) {
      this.nextRoundAt = null;
      await this.persist();
      if (this.phase === "playing") await this.beginRound();
      else await this.scheduleAlarm();
      return;
    }

    if (
      this.phase === "playing" &&
      this.match?.roundId &&
      this.match.turnPlayerId &&
      this.match.deadlineMs <= now
    ) {
      const cardId = this.currentCardFor(this.match.turnPlayerId);
      if (cardId != null) {
        const stat = highestStat(cardId);
        await this.resolveRound(this.match.roundId, this.match.turnPlayerId, stat, true);
        return;
      }
    }

    await this.scheduleAlarm();
  }

  private async handleJoin(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "JOIN_ROOM" }>,
  ) {
    const { clientId, displayName } = msg.payload;
    const existingSession = this.sessions.get(ws);
    if (existingSession && existingSession.clientId !== "pending" && existingSession.clientId !== clientId) {
      this.send(ws, this.error("ALREADY_JOINED", "Conexão já vinculada a um jogador."));
      return;
    }
    const name = displayName.trim().slice(0, 16) || "Jogador";

    let player = [...this.players.values()].find((p) => p.clientId === clientId);

    if (!player && this.phase !== "lobby") {
      this.send(ws, this.error("ROOM_BUSY", "Partida já em andamento."));
      await this.closeSession(ws, CLOSE_JOIN_REFUSED, "Room busy");
      return;
    }

    if (!player && this.players.size >= 2) {
      this.send(ws, this.error("ROOM_FULL", "Sala cheia (máx. 2)."));
      await this.closeSession(ws, CLOSE_JOIN_REFUSED, "Room full");
      return;
    }

    const isReconnect = Boolean(player);
    let changed = !isReconnect;

    if (!player) {
      player = {
        playerId: crypto.randomUUID(),
        clientId,
        displayName: name,
        ready: false,
      };
      this.players.set(player.playerId, player);
      this.broadcast(
        makeEnvelope("PLAYER_JOINED", this.code, {
          playerId: player.playerId,
          displayName: player.displayName,
        }),
      );
    } else if (player.displayName !== name) {
      player.displayName = name;
      changed = true;
    }

    const attachment: SessionAttachment = {
      clientId,
      playerId: player.playerId,
      displayName: player.displayName,
    };
    ws.serializeAttachment(attachment);
    this.sessions.set(ws, attachment);

    // Um socket por jogador: a conexão nova substitui a antiga.
    for (const [other, session] of [...this.sessions]) {
      if (other !== ws && session.clientId !== "pending" && session.playerId === player.playerId) {
        await this.closeSession(other, CLOSE_REPLACED, "Replaced by new connection");
      }
    }

    if (await this.claim()) changed = true;

    if (isReconnect) {
      if (this.pendingForfeit?.playerId === player.playerId) {
        this.pendingForfeit = null;
        changed = true;
      }
      track("reconnect_recovered", {
        roomId: this.code,
        playerId: player.playerId,
        via: "JOIN_ROOM",
      });
      track("ws_connected", { roomId: this.code, isReconnect: true });
    }

    // JOIN repetido sem mudança de estado não grava no storage.
    if (changed) {
      await this.persist();
      await this.scheduleAlarm();
    } else if (this.claimRetryAt) {
      await this.scheduleAlarm();
    }
    await this.resyncPlayer(ws);
    // O jogador que já estava na sala também recebe a lista atualizada.
    if (!isReconnect) this.broadcastRoomState(ws);
  }

  /**
   * Pede ao diretório a validade normal da sala depois que ela recebe
   * jogadores. Uma falha não impede o jogo: a tentativa se repete no próximo
   * JOIN, no READY, no início da partida e pelo alarm, até MAX_CLAIM_ATTEMPTS.
   * Devolve true quando a validade mudou.
   */
  private async claim(): Promise<boolean> {
    if (this.claimed || this.players.size === 0 || this.claimAttempts >= MAX_CLAIM_ATTEMPTS) return false;
    this.claimAttempts += 1;
    try {
      const res = await this.env.ROOM_DIRECTORY.getByName("rooms").fetch(new Request("https://directory/", {
        method: "POST",
        body: JSON.stringify({ action: "claim", code: this.code }),
      }));
      const body = res.ok ? await res.json() as { expiresAt?: unknown } : null;
      if (typeof body?.expiresAt === "number" && Number.isFinite(body.expiresAt)) {
        this.claimed = true;
        this.claimRetryAt = null;
        this.expiresAt = Math.max(this.expiresAt, body.expiresAt);
        return true;
      }
    } catch {
      // diretório indisponível: tenta de novo mais tarde
    }
    this.claimRetryAt = this.claimAttempts < MAX_CLAIM_ATTEMPTS ? Date.now() + CLAIM_RETRY_MS : null;
    return false;
  }

  private async handleReady(ws: WebSocket, ready: boolean) {
    if (this.phase !== "lobby") {
      this.send(ws, this.error("NOT_LOBBY", "Pronto só no lobby."));
      return;
    }
    const session = this.requireSession(ws);
    if (!session) return;
    const player = this.players.get(session.playerId);
    if (!player) {
      this.send(ws, this.error("NOT_JOINED", "Jogador não encontrado."));
      return;
    }
    if (player.ready === ready) return;
    player.ready = ready;
    this.players.set(player.playerId, player);
    await this.claim();
    await this.persist();
    if (this.claimRetryAt) await this.scheduleAlarm();
    this.broadcastRoomState();

    if (
      this.players.size === 2 &&
      [...this.players.values()].every((p) => p.ready)
    ) {
      await this.startMatch();
    }
  }

  private async handleSelectStat(ws: WebSocket, roundId: string, stat: StatKey) {
    const session = this.requireSession(ws);
    if (!session) return;
    if (!STAT_KEYS.includes(stat)) {
      this.send(ws, this.error("INVALID_STAT", "Stat inválido."));
      return;
    }
    if (this.phase !== "playing" || !this.match) {
      this.send(ws, this.error("NOT_PLAYING", "Nenhuma rodada ativa."));
      return;
    }
    if (this.match.roundId !== roundId) {
      this.send(ws, this.error("STALE_ROUND", "Rodada expirada."));
      return;
    }
    if (this.match.turnPlayerId !== session.playerId) {
      this.send(ws, this.error("NOT_YOUR_TURN", "Não é a sua vez."));
      return;
    }

    track("stat_selected", { roomId: this.code, stat, playerId: session.playerId });
    this.broadcast(
      makeEnvelope("STAT_SELECTED", this.code, {
        roundId,
        playerId: session.playerId,
        stat,
      }),
    );
    await this.resolveRound(roundId, session.playerId, stat, false);
  }

  private async handleRematch(ws: WebSocket) {
    const session = this.requireSession(ws);
    if (!session) return;
    if (this.phase !== "finished") {
      this.send(ws, this.error("NOT_FINISHED", "Rematch só após o fim."));
      return;
    }
    if (!this.match) {
      this.match = {
        playerOrder: [...this.players.keys()],
        decks: {},
        roundIndex: 0,
        roundId: null,
        turnPlayerId: null,
        deadlineMs: 0,
        rematchVotes: [],
      };
    }
    if (!this.match.rematchVotes.includes(session.playerId)) {
      this.match.rematchVotes.push(session.playerId);
    }
    await this.persist();

    if (this.match.rematchVotes.length >= 2) {
      for (const p of this.players.values()) p.ready = true;
      await this.startMatch();
    } else {
      this.broadcastRoomState();
    }
  }

  /** Remove a sessão e fecha o socket; o close nunca impede a limpeza. */
  private async closeSession(ws: WebSocket, code: number, reason: string, leaveReason = reason) {
    try {
      await this.handleLeave(ws, leaveReason);
    } finally {
      try {
        ws.close(code, reason);
      } catch {
        // código reservado (1005/1006) ou socket já fechado
      }
    }
  }

  private roomExpiredError(): ServerMessage {
    return this.error("ROOM_EXPIRED", "A sala expirou. Crie uma sala nova para jogar de novo.");
  }

  /**
   * Tira o socket da sala. A janela de mensagens só é apagada no evento de
   * close, e o attachment é limpo para o socket não voltar como jogador
   * depois de uma hibernação.
   */
  private async handleLeave(ws: WebSocket, reason: string) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    try {
      ws.serializeAttachment(null);
    } catch {
      // socket já fechado
    }
    if (!session || session.clientId === "pending") return;

    if (this.isPlayerConnected(session.playerId)) return;

    if (this.phase === "lobby") {
      this.players.delete(session.playerId);
      delete this.scores[session.playerId];
      await this.persist();
      this.broadcast(
        makeEnvelope("PLAYER_LEFT", this.code, {
          playerId: session.playerId,
          reason,
        }),
      );
      this.broadcastRoomState();
      return;
    }

    if (this.phase === "playing") {
      this.pendingForfeit = {
        playerId: session.playerId,
        at: Date.now() + RECONNECT_GRACE_MS,
      };
      await this.persist();
      await this.scheduleAlarm();
      this.broadcastRoomState();
      this.broadcast(
        makeEnvelope("ERROR", this.code, {
          code: "PEER_RECONNECTING",
          message: "Oponente desconectou. Aguardando reconexão (60s).",
        }),
      );
    }
  }

  private async forfeitPlayer(playerId: string) {
    const opponent = [...this.players.keys()].find((id) => id !== playerId) ?? null;
    this.pendingForfeit = null;
    this.nextRoundAt = null;
    this.phase = "finished";
    if (this.match) {
      this.match.roundId = null;
      this.match.turnPlayerId = null;
    }
    await this.ctx.storage.deleteAlarm();
    track("match_completed", {
      roomId: this.code,
      reason: "disconnect",
      winner: opponent ? "p" : "draw",
    });
    this.broadcast(
      makeEnvelope("MATCH_COMPLETED", this.code, {
        winnerPlayerId: opponent,
        scores: this.scores,
      }),
    );
    await this.persist();
    this.broadcastRoomState();
    await this.scheduleAlarm();
  }

  private async startMatch() {
    const order = [...this.players.keys()];
    if (order.length !== 2) return;

    // Última chance antes da partida; o alarm continua tentando se falhar.
    await this.claim();
    await this.ctx.storage.deleteAlarm();
    this.pendingForfeit = null;
    this.nextRoundAt = null;

    this.phase = "playing";
    this.scores = { [order[0]]: 0, [order[1]]: 0 };
    const decks = dealDecks([order[0], order[1]], DECK_SIZE, GEN1_MAX_ID);

    this.match = {
      playerOrder: order,
      decks,
      roundIndex: 0,
      roundId: null,
      turnPlayerId: null,
      deadlineMs: 0,
      rematchVotes: [],
    };

    for (const p of this.players.values()) p.ready = false;

    track("match_started", { roomId: this.code, deckSize: DECK_SIZE });
    await this.persist();
    this.broadcastRoomState();
    this.sendDeals();
    await this.beginRound();
  }

  private sendDeal(ws: WebSocket, playerId: string) {
    if (!this.match) return;
    const yourDeck = this.match.decks[playerId] ?? [];
    this.send(
      ws,
      makeEnvelope(
        "DEAL",
        this.code,
        {
          roundCount: DECK_SIZE,
          yourDeck,
          opponentDeckCount: DECK_SIZE,
        },
        this.nextSeq(),
      ),
    );
  }

  private sendDeals() {
    if (!this.match) return;
    for (const [ws, session] of this.sessions) {
      if (session.clientId === "pending") continue;
      this.sendDeal(ws, session.playerId);
    }
  }

  private async beginRound() {
    if (!this.match) return;
    this.nextRoundAt = null;

    if (this.match.roundIndex >= DECK_SIZE) {
      await this.finishMatch("score");
      return;
    }

    const roundId = crypto.randomUUID();
    const turnPlayerId = this.match.playerOrder[this.match.roundIndex % 2];
    const deadlineMs = Date.now() + TURN_MS;
    this.match.roundId = roundId;
    this.match.turnPlayerId = turnPlayerId;
    this.match.deadlineMs = deadlineMs;

    track("round_started", { roomId: this.code, roundIndex: this.match.roundIndex });
    await this.persist();
    await this.scheduleAlarm();

    for (const [ws, session] of this.sessions) {
      if (session.clientId === "pending") continue;
      const yourCardId = this.match.decks[session.playerId]?.[this.match.roundIndex];
      if (yourCardId == null) continue;
      this.send(
        ws,
        makeEnvelope(
          "ROUND_START",
          this.code,
          {
            roundId,
            roundIndex: this.match.roundIndex,
            yourCardId,
            turnPlayerId,
            deadlineMs,
          },
          this.nextSeq(),
        ),
      );
    }
  }

  private async resolveRound(
    roundId: string,
    chooserId: string,
    stat: StatKey,
    fromAlarm: boolean,
  ) {
    if (!this.match || this.match.roundId !== roundId) return;

    const [p1Id, p2Id] = this.match.playerOrder;
    const p1Card = this.match.decks[p1Id][this.match.roundIndex];
    const p2Card = this.match.decks[p2Id][this.match.roundIndex];
    const { p1Val, p2Val, winner } = compareRound(p1Card, p2Card, stat);

    let winnerPlayerId: string | null = null;
    if (winner === "p1") winnerPlayerId = p1Id;
    if (winner === "p2") winnerPlayerId = p2Id;
    if (winnerPlayerId) {
      this.scores[winnerPlayerId] = (this.scores[winnerPlayerId] ?? 0) + 1;
    }

    track("round_resolved", {
      roomId: this.code,
      stat,
      fromAlarm,
      draw: winnerPlayerId == null,
      chooserId,
    });

    this.broadcast(
      makeEnvelope(
        "ROUND_RESULT",
        this.code,
        {
          roundId,
          stat,
          p1: { playerId: p1Id, cardId: p1Card, value: p1Val },
          p2: { playerId: p2Id, cardId: p2Card, value: p2Val },
          winnerPlayerId,
          scores: { ...this.scores },
        },
        this.nextSeq(),
      ),
    );

    this.match.roundIndex += 1;
    this.match.roundId = null;
    this.match.turnPlayerId = null;
    this.match.deadlineMs = 0;

    if (this.match.roundIndex >= DECK_SIZE) {
      await this.finishMatch("score");
      return;
    }

    this.nextRoundAt = Date.now() + INTER_ROUND_MS;
    await this.persist();
    this.broadcastRoomState();
    await this.scheduleAlarm();
  }

  private async finishMatch(reason: "score" | "disconnect") {
    if (!this.match) return;
    await this.ctx.storage.deleteAlarm();
    this.nextRoundAt = null;
    this.pendingForfeit = null;
    this.phase = "finished";
    this.match.roundId = null;
    this.match.turnPlayerId = null;
    this.match.rematchVotes = [];

    const [p1, p2] = this.match.playerOrder;
    const s1 = this.scores[p1] ?? 0;
    const s2 = this.scores[p2] ?? 0;
    let winnerPlayerId: string | null = null;
    if (s1 > s2) winnerPlayerId = p1;
    else if (s2 > s1) winnerPlayerId = p2;

    track("match_completed", {
      roomId: this.code,
      reason,
      rounds: DECK_SIZE,
      winner: winnerPlayerId ? "p" : "draw",
    });

    this.broadcast(
      makeEnvelope(
        "MATCH_COMPLETED",
        this.code,
        { winnerPlayerId, scores: { ...this.scores } },
        this.nextSeq(),
      ),
    );
    await this.persist();
    this.broadcastRoomState();
    await this.scheduleAlarm();
  }

  private async resyncPlayer(ws: WebSocket) {
    this.sendRoomState(ws);
    const session = this.sessions.get(ws);
    if (!session || session.clientId === "pending" || !this.match) return;

    if (this.phase === "playing" || this.phase === "finished") {
      this.sendDeal(ws, session.playerId);
    }

    if (this.phase === "playing" && this.match.roundId && this.match.turnPlayerId) {
      const yourCardId = this.match.decks[session.playerId]?.[this.match.roundIndex];
      if (yourCardId != null) {
        this.send(
          ws,
          makeEnvelope(
            "ROUND_START",
            this.code,
            {
              roundId: this.match.roundId,
              roundIndex: this.match.roundIndex,
              yourCardId,
              turnPlayerId: this.match.turnPlayerId,
              deadlineMs: this.match.deadlineMs,
            },
            this.nextSeq(),
          ),
        );
      }
    }
  }

  /** Um único alarm DO: escolhe o próximo evento mais cedo. */
  private async scheduleAlarm() {
    const candidates: Array<{ at: number; kind: AlarmKind }> = this.expiresAt
      ? [{ at: this.expiresAt, kind: "expire" }]
      : [];
    if (this.pendingForfeit) {
      candidates.push({ at: this.pendingForfeit.at, kind: "forfeit" });
    }
    if (this.nextRoundAt) {
      candidates.push({ at: this.nextRoundAt, kind: "nextRound" });
    }
    if (!this.claimed && this.claimRetryAt) {
      candidates.push({ at: this.claimRetryAt, kind: "claim" });
    }
    for (const [, session] of this.pendingSessions()) {
      candidates.push({ at: (session.connectedAt ?? 0) + JOIN_TIMEOUT_MS, kind: "join" });
    }
    if (
      this.phase === "playing" &&
      this.match?.roundId &&
      this.match.deadlineMs > 0
    ) {
      candidates.push({ at: this.match.deadlineMs, kind: "turn" });
    }

    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    candidates.sort((a, b) => a.at - b.at);
    await this.ctx.storage.setAlarm(candidates[0].at);
  }

  /** Sockets abertos segundo o runtime; inclui os que nunca mandaram JOIN_ROOM. */
  private openSockets(): WebSocket[] {
    // readyState 2/3 = CLOSING/CLOSED: o runtime ainda pode listar o socket
    // logo depois do close iniciado pelo servidor.
    return this.ctx.getWebSockets().filter((ws) => !(ws.readyState >= 2));
  }

  /** Sockets sem JOIN_ROOM, do mais antigo para o mais novo. */
  private pendingSessions(): Array<[WebSocket, SessionAttachment]> {
    return [...this.sessions]
      .filter(([, s]) => s.clientId === "pending")
      .sort(([, a], [, b]) => (a.connectedAt ?? 0) - (b.connectedAt ?? 0));
  }

  private isJoinOverdue(session: SessionAttachment, now: number) {
    return session.clientId === "pending" && (session.connectedAt ?? 0) + JOIN_TIMEOUT_MS <= now;
  }

  private async closeExpiredPending(now: number) {
    for (const [ws, session] of this.pendingSessions()) {
      if (this.isJoinOverdue(session, now)) await this.closeSession(ws, 1008, "Join timeout");
    }
  }

  private isPlayerConnected(playerId: string): boolean {
    return [...this.sessions.values()].some(
      (s) => s.playerId === playerId && s.clientId !== "pending",
    );
  }

  private requireSession(ws: WebSocket): SessionAttachment | null {
    const session = this.sessions.get(ws);
    if (!session || session.clientId === "pending") {
      this.send(ws, this.error("NOT_JOINED", "Entre na sala antes."));
      return null;
    }
    return session;
  }

  private currentCardFor(playerId: string): number | null {
    if (!this.match) return null;
    return this.match.decks[playerId]?.[this.match.roundIndex] ?? null;
  }

  private publicPlayers(): PlayerPublic[] {
    return [...this.players.values()].map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      ready: p.ready,
    }));
  }

  private nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  private sendRoomState(ws: WebSocket) {
    const session = this.sessions.get(ws);
    this.send(
      ws,
      makeEnvelope(
        "ROOM_STATE",
        this.code,
        {
          phase: this.phase,
          players: this.publicPlayers(),
          code: this.code,
          youAre:
            session && session.clientId !== "pending" ? session.playerId : null,
          scores: this.scores,
          lastError: this.pendingForfeit
            ? "Aguardando reconexão de um jogador…"
            : undefined,
        },
        this.nextSeq(),
      ),
    );
  }

  /** Sockets que já passaram pelo JOIN_ROOM; os "pending" não recebem broadcast. */
  private joinedSockets(): WebSocket[] {
    return [...this.sessions].filter(([, s]) => s.clientId !== "pending").map(([ws]) => ws);
  }

  private broadcastRoomState(except?: WebSocket) {
    for (const ws of this.joinedSockets()) {
      if (ws !== except) this.sendRoomState(ws);
    }
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.joinedSockets()) {
      try {
        ws.send(data);
      } catch {
        // ignore
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  private error(code: string, message: string): ServerMessage {
    return makeEnvelope("ERROR", this.code || "unknown", { code, message });
  }

  private async persist() {
    await this.ctx.storage.put("room", {
      code: this.code,
      expiresAt: this.expiresAt,
      phase: this.phase,
      seq: this.seq,
      scores: this.scores,
      players: [...this.players.values()],
      match: this.match,
      pendingForfeit: this.pendingForfeit,
      nextRoundAt: this.nextRoundAt,
      claimed: this.claimed,
    });
  }
}
