import {
  makeEnvelope,
  type ClientMessage,
  type ServerMessage,
  type StatKey,
} from "../../shared/protocol";
import { getOrCreateClientId } from "./client-id";

export function roomWsUrl(code: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws?room=${encodeURIComponent(code)}`;
}

export function createJoinMessage(
  code: string,
  displayName: string,
): ClientMessage {
  return makeEnvelope("JOIN_ROOM", code, {
    code,
    displayName,
    clientId: getOrCreateClientId(),
  });
}

export function createReadyMessage(code: string, ready: boolean): ClientMessage {
  return makeEnvelope("READY", code, { ready });
}

export function createSyncMessage(code: string, lastSeq: number): ClientMessage {
  return makeEnvelope("REQUEST_SYNC", code, { lastSeq });
}

export function createSelectStatMessage(
  code: string,
  roundId: string,
  stat: StatKey,
): ClientMessage {
  return makeEnvelope("SELECT_STAT", code, { roundId, stat });
}

export function createRematchMessage(code: string): ClientMessage {
  return makeEnvelope("REMATCH", code, {});
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}
