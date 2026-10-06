import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PlayerPublic,
  RoomPhase,
  ServerMessage,
  StatKey,
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

export function useGameSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const displayNameRef = useRef("Jogador");
  const codeRef = useRef("");
  const intentionalCloseRef = useRef(false);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [room, setRoom] = useState<RoomView>(initialRoom);
  const [match, setMatch] = useState<MatchView>(initialMatch);

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (typeof msg.seq === "number") {
      lastSeqRef.current = msg.seq;
    }

    switch (msg.type) {
      case "ROOM_STATE":
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

  const connect = useCallback(
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

      ws.addEventListener("close", () => {
        if (intentionalCloseRef.current) {
          setStatus("closed");
          return;
        }
        setStatus((prev) => (prev === "connecting" ? "closed" : "reconnecting"));
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
    const timer = window.setTimeout(() => {
      connect(codeRef.current, displayNameRef.current);
      window.setTimeout(() => requestSync(), 300);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [status, connect, requestSync]);

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
