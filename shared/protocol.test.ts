import { describe, expect, it } from "vitest";
import { generateRoomCode, makeEnvelope, parseClientMessage, ROOM_CODE_PATTERN } from "./protocol";
const code = "ABC23456";
const parse = (type: string, payload: unknown) => parseClientMessage(JSON.stringify(makeEnvelope(type, code, payload)), code);
describe("client message validation", () => {
  it("rejects absent or malformed payloads without throwing", () => {
    for (const payload of [undefined, null, [], 123, { ready: "yes" }]) expect(parse("READY", payload)).toBeNull();
    expect(parse("JOIN_ROOM", { code, clientId: "", displayName: 42 })).toBeNull();
    expect(parse("SELECT_STAT", { roundId: "bad", stat: "attack" })).toBeNull();
    expect(parse("REQUEST_SYNC", { lastSeq: -1 })).toBeNull();
    expect(parseClientMessage("{", code)).toBeNull();
    expect(parseClientMessage("x".repeat(4097), code)).toBeNull();
  });
  it("validates room binding and accepts every legitimate variant", () => {
    expect(parse("READY", { ready: true })?.type).toBe("READY");
    expect(parse("JOIN_ROOM", { code, clientId: crypto.randomUUID(), displayName: "Player" })?.type).toBe("JOIN_ROOM");
    expect(parse("SELECT_STAT", { roundId: crypto.randomUUID(), stat: "attack" })?.type).toBe("SELECT_STAT");
    expect(parse("REQUEST_SYNC", { lastSeq: 0 })?.type).toBe("REQUEST_SYNC");
    expect(parse("LEAVE", {})?.type).toBe("LEAVE");
    expect(parse("REMATCH", {})?.type).toBe("REMATCH");
    expect(parseClientMessage(JSON.stringify(makeEnvelope("READY", "OTHER123", { ready: true })), code)).toBeNull();
  });
  it("generates codes that match the accepted room format", () => {
    for (let i = 0; i < 200; i++) expect(generateRoomCode()).toMatch(ROOM_CODE_PATTERN);
    for (const bad of ["ABC123", "ABCDEFGI", "ABCDEFG0", "abcd2345", "ABCD23456"]) expect(ROOM_CODE_PATTERN.test(bad)).toBe(false);
  });
});
