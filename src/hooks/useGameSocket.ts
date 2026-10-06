import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLOSE_JOIN_REFUSED,
  CLOSE_REPLACED,
  type PlayerPublic,
  type RoomPhase,
  type ServerMessage,
  type StatKey,
} from "../../shared/protocol";
import {
  createJoinMessage,
  createReadyMessage,
  createRematchMessage,
  createSelectStatMessage,
  createSyncMessage,
  parseServerMessage,
  roomWsUrl,
} from "../lib/ws";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

type RoomView = {
  code: string;
  phase: RoomPhase;
  players: PlayerPublic[];
  youAre: string | null;
  scores: Record<string, number>;
  lastError: string | null;
};

type MatchView = {
  deck: number[];
  roundCount: number;
  roundId: string | null;
  roundIndex: number;
  yourCardId: number | null;
  turnPlayerId: string | null;
  deadlineMs: number;
  lastResult: Extract<ServerMessage, { type: "ROUND_RESULT" }>["payload"] | null;
  matchWinnerId: string | null;
};

const initialRoom: RoomView = {
  code: "",
  phase: "lobby",
  players: [],
  youAre: null,
  scores: {},
  lastError: null,
};

const initialMatch: MatchView = {
  deck: [],
  roundCount: 5,
  roundId: null,
  roundIndex: 0,
  yourCardId: null,
  turnPlayerId: null,
  deadlineMs: 0,
  lastResult: null,
  matchWinnerId: null,
};

/** Tentativas de reconexão depois de uma queda, com espera de 1, 2, 4, 8… s (máx. 60 s). */
const MAX_RECONNECT_ATTEMPTS = 10;
const reconnectDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 60_000);

export function useGameSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const displayNameRef = useRef("Jogador");
  const codeRef = useRef("");
  const intentionalCloseRef = useRef(false);
  /** O servidor já reconheceu este cliente como jogador da sala. */
  const joinedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [room, setRoom] = useState<RoomView>(initialRoom);
  const [match, setMatch] = useState<MatchView>(initialMatch);

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (typeof msg.seq === "number") {
      lastSeqRef.current = msg.seq;
    }

    switch (msg.type) {
      case "ROOM_STATE":
        if (msg.payload.youAre) {
          joinedRef.current = true;
          reconnectAttemptRef.current = 0;
        }
        setRoom({
          code: msg.payload.code,
          phase: msg.payload.phase,
          players: msg.payload.players,
          youAre: msg.payload.youAre,
          scores: msg.payload.scores ?? {},
          lastError: msg.payload.lastError ?? null,
        });
        if (msg.payload.phase === "lobby") {
          setMatch(initialMatch);
        }
        break;
      case "PLAYER_JOINED":
        setRoom((prev) =>
          prev.players.some((p) => p.playerId === msg.payload.playerId)
            ? prev
            : {
                ...prev,
                players: [
                  ...prev.players,
                  { playerId: msg.payload.playerId, displayName: msg.payload.displayName, ready: false },
                ],
              },
        );
        break;
      case "DEAL":
        setMatch((prev) => ({
          ...prev,
          deck: msg.payload.yourDeck,
          roundCount: msg.payload.roundCount,
          lastResult: null,
          matchWinnerId: null,
        }));
        break;
      case "ROUND_START":
        setMatch((prev) => ({
          ...prev,
          roundId: msg.payload.roundId,
          roundIndex: msg.payload.roundIndex,
          yourCardId: msg.payload.yourCardId,
          turnPlayerId: msg.payload.turnPlayerId,
          deadlineMs: msg.payload.deadlineMs,
          lastResult: null,
        }));
        break;
      case "ROUND_RESULT":
        setMatch((prev) => ({
          ...prev,
          lastResult: msg.payload,
          roundId: null,
          turnPlayerId: null,
        }));
        setRoom((prev) => ({ ...prev, scores: msg.payload.scores }));
        break;
      case "MATCH_COMPLETED":
        setMatch((prev) => ({
          ...prev,
          matchWinnerId: msg.payload.winnerPlayerId,
          roundId: null,
          turnPlayerId: null,
        }));
        setRoom((prev) => ({
          ...prev,
          phase: "finished",
          scores: msg.payload.scores,
        }));
        break;
      case "ERROR":
        if (msg.payload.code === "ROOM_EXPIRED") {
          // Sala apagada no servidor: não tenta reconectar.
          intentionalCloseRef.current = true;
          setRoom((prev) => ({ ...prev, lastError: msg.payload.message }));
          break;
        }
        setRoom((prev) => ({
          ...prev,
          lastError: `${msg.payload.code}: ${msg.payload.message}`,
        }));
        break;
      default:
        break;
    }
  }, []);

  const openSocket = useCallback(
    (code: string, displayName: string) => {
      const normalized = code.trim().toUpperCase();
      if (!normalized) return;

      intentionalCloseRef.current = false;
      displayNameRef.current = displayName.trim() || "Jogador";
      codeRef.current = normalized;
      setStatus("connecting");
      setRoom((prev) => ({ ...prev, code: normalized, lastError: null }));

      wsRef.current?.close();
      const ws = new WebSocket(roomWsUrl(normalized));
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        setStatus("connected");
        ws.send(
          JSON.stringify(createJoinMessage(normalized, displayNameRef.current)),
        );
      });

      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        if (event.data === "pong") return;
        const parsed = parseServerMessage(event.data);
        if (parsed) handleMessage(parsed);
      });

      ws.addEventListener("close", (event) => {
        // Um socket já substituído por outro não mexe no estado da conexão.
        if (wsRef.current !== ws) return;
        if (event.code === CLOSE_REPLACED || event.code === CLOSE_JOIN_REFUSED) {
          // Fechamento definitivo do servidor: outra aba assumiu o jogador ou
          // a entrada foi recusada. Reconectar só repetiria o problema.
          intentionalCloseRef.current = true;
          if (event.code === CLOSE_REPLACED) {
            setRoom((prev) => ({ ...prev, lastError: "Esta sala foi aberta em outra aba." }));
          }
        }
        if (intentionalCloseRef.current) {
          setStatus("closed");
          return;
        }
        // Só reconecta quem já entrou na sala; a primeira tentativa que falha
        // (código errado, sala expirada) termina em "closed".
        if (!joinedRef.current) {
          setStatus("closed");
          return;
        }
        if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setRoom((prev) => ({ ...prev, lastError: "Não foi possível reconectar à sala." }));
          setStatus("closed");
          return;
        }
        setStatus("reconnecting");
      });

      ws.addEventListener("error", () => {
        setRoom((prev) => ({
          ...prev,
          lastError: "Falha na conexão WebSocket.",
        }));
      });
    },
    [handleMessage],
  );

  const connect = useCallback(
    (code: string, displayName: string) => {
      joinedRef.current = false;
      reconnectAttemptRef.current = 0;
      openSocket(code, displayName);
    },
    [openSocket],
  );

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("closed");
    setMatch(initialMatch);
  }, []);

  const setReady = useCallback((ready: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(createReadyMessage(codeRef.current, ready)));
  }, []);

  const selectStat = useCallback((roundId: string, stat: StatKey) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify(createSelectStatMessage(codeRef.current, roundId, stat)),
    );
  }, []);

  const requestRematch = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(createRematchMessage(codeRef.current)));
  }, []);

  const requestSync = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify(createSyncMessage(codeRef.current, lastSeqRef.current)),
    );
  }, []);

  useEffect(() => {
    if (status !== "reconnecting" || !codeRef.current) return;
    const delay = reconnectDelay(reconnectAttemptRef.current);
    reconnectAttemptRef.current += 1;
    const timer = window.setTimeout(() => {
      openSocket(codeRef.current, displayNameRef.current);
      window.setTimeout(() => requestSync(), 300);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [status, openSocket, requestSync]);

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, []);

  return {
    status,
    room,
    match,
    connect,
    disconnect,
    setReady,
    selectStat,
    requestRematch,
    requestSync,
  };
}
