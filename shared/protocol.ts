/** Shared WebSocket protocol (client + Durable Object). */

const PROTOCOL_VERSION = 1 as const;

export type StatKey =
  | "hp"
  | "attack"
  | "defense"
  | "special-attack"
  | "special-defense"
  | "speed";

export const STAT_KEYS: readonly StatKey[] = [
  "hp",
  "attack",
  "defense",
  "special-attack",
  "special-defense",
  "speed",
] as const;

export type RoomPhase = "lobby" | "playing" | "finished";

export type Envelope<T extends string, P> = {
  v: typeof PROTOCOL_VERSION;
  type: T;
  ts: number;
  roomId: string;
  seq?: number;
  payload: P;
};

export type PlayerPublic = {
  playerId: string;
  displayName: string;
  ready: boolean;
};

/** Client → server */
export type ClientMessage =
  | Envelope<"JOIN_ROOM", { code: string; displayName: string; clientId: string }>
  | Envelope<"READY", { ready: boolean }>
  | Envelope<"SELECT_STAT", { roundId: string; stat: StatKey }>
  | Envelope<"REQUEST_SYNC", { lastSeq: number }>
  | Envelope<"LEAVE", Record<string, never>>
  | Envelope<"REMATCH", Record<string, never>>;

/** Server → client */
export type ServerMessage =
  | Envelope<
      "ROOM_STATE",
      {
        phase: RoomPhase;
        players: PlayerPublic[];
        code: string;
        youAre: string | null;
        scores?: Record<string, number>;
        lastError?: string;
      }
    >
  | Envelope<"PLAYER_JOINED", { playerId: string; displayName: string }>
  | Envelope<"PLAYER_LEFT", { playerId: string; reason: string }>
  | Envelope<
      "DEAL",
      { roundCount: number; yourDeck: number[]; opponentDeckCount: number }
    >
  | Envelope<
      "ROUND_START",
      {
        roundId: string;
        roundIndex: number;
        yourCardId: number;
        turnPlayerId: string;
        deadlineMs: number;
      }
    >
  | Envelope<"STAT_SELECTED", { roundId: string; playerId: string; stat: StatKey }>
  | Envelope<
      "ROUND_RESULT",
      {
        roundId: string;
        stat: StatKey;
        p1: { playerId: string; cardId: number; value: number };
        p2: { playerId: string; cardId: number; value: number };
        winnerPlayerId: string | null;
        scores: Record<string, number>;
      }
    >
  | Envelope<
      "MATCH_COMPLETED",
      { winnerPlayerId: string | null; scores: Record<string, number> }
    >
  | Envelope<"ERROR", { code: string; message: string }>;

export function makeEnvelope<T extends string, P>(
  type: T,
  roomId: string,
  payload: P,
  seq?: number,
): Envelope<T, P> {
  return {
    v: PROTOCOL_VERSION,
    type,
    ts: Date.now(),
    roomId,
    ...(seq !== undefined ? { seq } : {}),
    payload,
  };
}

/** Formato exato produzido por generateRoomCode(8). */
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

/** Tamanho máximo de uma mensagem do cliente, em caracteres. */
export const MAX_MESSAGE_LENGTH = 4096;

export function generateRoomCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

export function parseClientMessage(raw: string, roomId: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_LENGTH) return null;
  try {
    const msg: unknown = JSON.parse(raw);
    if (!msg || typeof msg !== "object") return null;
    const m = msg as Record<string, unknown>;
    if (m.v !== 1 || m.roomId !== roomId || typeof m.ts !== "number" || !Number.isFinite(m.ts) ||
        (m.seq !== undefined && (!Number.isSafeInteger(m.seq) || Number(m.seq) < 0)) ||
        !m.payload || typeof m.payload !== "object" || Array.isArray(m.payload)) return null;
    const p = m.payload as Record<string, unknown>;
    const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    let valid = false;
    switch (m.type) {
      case "JOIN_ROOM": valid = p.code === roomId && uuid(p.clientId) && typeof p.displayName === "string" && p.displayName.length <= 64; break;
      case "READY": valid = typeof p.ready === "boolean"; break;
      case "SELECT_STAT": valid = uuid(p.roundId) && STAT_KEYS.includes(p.stat as StatKey); break;
      case "REQUEST_SYNC": valid = Number.isSafeInteger(p.lastSeq) && Number(p.lastSeq) >= 0; break;
      case "LEAVE": case "REMATCH": valid = Object.keys(p).length === 0; break;
    }
    return valid ? m as unknown as ClientMessage : null;
  } catch { return null; }
}
