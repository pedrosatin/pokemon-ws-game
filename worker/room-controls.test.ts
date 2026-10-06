import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomDirectory, ROOM_TTL_MS } from "./room-directory";
import { GameRoom } from "./game-room";
import worker from "./index";

function context(sockets: { close: ReturnType<typeof vi.fn> }[] = []) {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn(async () => { values.clear(); }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(storage),
  };
  return { storage, getWebSockets: () => sockets, setWebSocketAutoResponse: vi.fn(),
    blockConcurrencyWhile: async (cb: () => Promise<void>) => cb() } as unknown as DurableObjectState;
}
const reserve = (room: RoomDirectory, action: string, ip = "1.2.3.4", code?: string) => room.fetch(new Request("https://directory/", {
  method: "POST", body: JSON.stringify({ action, ip, code }),
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("persistent room provisioning", () => {
  it("coordinates per-address creation quotas across instances and expires rooms", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const a = new RoomDirectory(ctx, {} as Env);
    const b = new RoomDirectory(ctx, {} as Env);
    let code = "";
    for (let i = 0; i < 5; i++) {
      const res = await reserve(i % 2 ? a : b, "create");
      expect(res.status).toBe(200); code = (await res.json() as { code: string }).code;
    }
    expect((await reserve(a, "create")).status).toBe(429);
    expect((await reserve(a, "connect", "other", "UNKNOWN1")).status).toBe(404);
    expect((await reserve(a, "connect", "other", code)).status).toBe(200);
    vi.advanceTimersByTime(ROOM_TTL_MS + 1);
    expect((await reserve(a, "connect", "other", code)).status).toBe(404);
  });
  it("limits global provisioning and connection attempts", async () => {
    const directory = new RoomDirectory(context(), {} as Env);
    for (let i = 0; i < 100; i++) expect((await reserve(directory, "create", `ip-${i}`)).status).toBe(200);
    expect((await reserve(directory, "create", "new-ip")).status).toBe(429);
    for (let i = 0; i < 20; i++) expect((await reserve(directory, "connect", "scanner", "UNKNOWN1")).status).toBe(404);
    expect((await reserve(directory, "connect", "scanner", "UNKNOWN1")).status).toBe(429);
  });
  it("never selects a game object for a nonexistent room", async () => {
    const getByName = vi.fn();
    const env = { GAME_ROOM: { getByName }, ROOM_DIRECTORY: { getByName: () => ({ fetch: async () => new Response(null, { status: 404 }) }) } } as unknown as Env;
    const res = await worker.fetch(new Request("https://game.example/ws?room=UNKNOWN1", {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "1.2.3.4" },
    }), env);
    expect(res.status).toBe(404); expect(getByName).not.toHaveBeenCalled();
  });
  it("cleans expired storage and closes sockets on alarm", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocketRequestResponsePair", class {});
    const socket = { close: vi.fn() };
    const ctx = context([]);
    const room = new GameRoom(ctx, {} as Env);
    await Promise.resolve(); await Promise.resolve();
    const expiresAt = Date.now() + ROOM_TTL_MS;
    expect((await room.fetch(new Request("https://room/init", { method: "POST", body: JSON.stringify({ code: "ABC23456", expiresAt }) }))).ok).toBe(true);
    vi.spyOn(ctx, "getWebSockets").mockReturnValue([socket as unknown as WebSocket]);
    vi.advanceTimersByTime(ROOM_TTL_MS + 1);
    await room.alarm();
    expect(socket.close).toHaveBeenCalled(); expect(ctx.storage.deleteAll).toHaveBeenCalled();
    expect((await room.fetch(new Request("https://room/state"))).status).toBe(404);
  });
});
