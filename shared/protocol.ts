/** Shared WebSocket protocol (client + Durable Object). */

export const PROTOCOL_VERSION = 1 as const;

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

export type WsMessage = ClientMessage | ServerMessage;

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

export function generateRoomCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}
