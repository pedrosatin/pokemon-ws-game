import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressKey,
  CREATE_PER_HOUR,
  MAX_ACTIVE_ROOMS,
  MAX_WINDOWS,
  RoomDirectory,
  ROOM_TTL_MS,
} from "./room-directory";
import { GameRoom } from "./game-room";
import worker from "./index";
import { makeEnvelope, ROOM_CODE_PATTERN } from "../shared/protocol";

type FakeSocket = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  serializeAttachment: ReturnType<typeof vi.fn>;
  deserializeAttachment: () => null;
};

function context(sockets: FakeSocket[] = []) {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn(async () => {
      values.clear();
    }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(storage),
  };
  return {
    storage,
    getWebSockets: () => sockets,
    acceptWebSocket: vi.fn(),
    setWebSocketAutoResponse: vi.fn(),
    blockConcurrencyWhile: async (cb: () => Promise<void>) => cb(),
  } as unknown as DurableObjectState;
}

/** Simula o runtime: close com código reservado lança InvalidAccessError. */
function fakeSocket(): FakeSocket {
  return {
    send: vi.fn(),
    close: vi.fn((code?: number) => {
      if (code === 1005 || code === 1006) throw new TypeError(`Invalid WebSocket close code: ${code}`);
    }),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => null,
  };
}

const reserve = (room: RoomDirectory, action: string, ip = "1.2.3.4", code?: string) =>
  room.fetch(new Request("https://directory/", {
    method: "POST",
    body: JSON.stringify({ action, ip, code }),
  }));

const CODE = "ABC23456";

async function openRoom() {
  const ctx = context();
  const room = new GameRoom(ctx, {} as Env);
  await Promise.resolve();
  await Promise.resolve();
  const init = await room.fetch(new Request("https://room/init", {
    method: "POST",
    body: JSON.stringify({ code: CODE, expiresAt: Date.now() + ROOM_TTL_MS }),
  }));
  expect(init.ok).toBe(true);
  return { ctx, room };
}

const sessions = (room: GameRoom) => (room as unknown as { sessions: Map<unknown, unknown> }).sessions;
const sentErrors = (ws: FakeSocket) => ws.send.mock.calls
  .map(([raw]) => JSON.parse(raw as string) as { type: string; payload: { code?: string } })
  .filter((m) => m.type === "ERROR")
  .map((m) => m.payload.code);
const join = (clientId: string) => JSON.stringify(makeEnvelope("JOIN_ROOM", CODE, { code: CODE, clientId, displayName: "P" }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("address grouping", () => {
  it("groups IPv6 by /64 and keeps IPv4 per address", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0DB8:0001:0002:ffff:0:0:9")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(addressKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(addressKey("local")).toBe("local");
  });
});

describe("persistent room provisioning", () => {
  it("coordinates per-address creation quotas across instances and expires rooms", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const a = new RoomDirectory(ctx, {} as Env);
    const b = new RoomDirectory(ctx, {} as Env);
    let code = "";
    for (let i = 0; i < 5; i++) {
      const res = await reserve(i % 2 ? a : b, "create");
      expect(res.status).toBe(200);
      code = (await res.json() as { code: string }).code;
    }
    expect(code).toMatch(ROOM_CODE_PATTERN);
    expect((await reserve(a, "create")).status).toBe(429);
    expect((await reserve(a, "connect", "other", "UNKNOWN1")).status).toBe(404);
    expect((await reserve(a, "connect", "other", code)).status).toBe(200);
    vi.advanceTimersByTime(ROOM_TTL_MS + 1);
    expect((await reserve(a, "connect", "other", code)).status).toBe(404);
  });

  it("shares the quota across addresses of the same IPv6 /64", async () => {
    const directory = new RoomDirectory(context(), {} as Env);
    for (let i = 1; i <= 5; i++) {
      expect((await reserve(directory, "create", `2001:db8:1:2::${i}`)).status).toBe(200);
    }
    expect((await reserve(directory, "create", "2001:db8:1:2::6")).status).toBe(429);
    expect((await reserve(directory, "create", "2001:db8:1:2:abcd::1")).status).toBe(429);
    expect((await reserve(directory, "create", "2001:db8:1:3::1")).status).toBe(200);
  });

  it("limits global provisioning and connection attempts", async () => {
    expect(MAX_ACTIVE_ROOMS).toBe(CREATE_PER_HOUR * 2);
    const directory = new RoomDirectory(context(), {} as Env);
    for (let i = 0; i < CREATE_PER_HOUR; i++) {
      expect((await reserve(directory, "create", `ip-${i}`)).status).toBe(200);
    }
    expect((await reserve(directory, "create", "new-ip")).status).toBe(429);
    for (let i = 0; i < 20; i++) {
      expect((await reserve(directory, "connect", "scanner", "UNKNOWN1")).status).toBe(404);
    }
    expect((await reserve(directory, "connect", "scanner", "UNKNOWN1")).status).toBe(429);
  });

  it("an IPv6 flood needs CREATE_PER_HOUR / 5 distinct /64 prefixes to exhaust creation", async () => {
    const directory = new RoomDirectory(context(), {} as Env);
    let created = 0;
    for (let host = 1; host <= 200; host++) {
      if ((await reserve(directory, "create", `2001:db8:1:2::${host}`)).status === 200) created++;
    }
    expect(created).toBe(5);
    expect((await reserve(directory, "create", "198.51.100.1")).status).toBe(200);
  });

  it("keeps joins to existing rooms and new creations working with the record table full", async () => {
    const directory = new RoomDirectory(context(), {} as Env);
    const created = await reserve(directory, "create", "198.51.100.1");
    const { code } = await created.json() as { code: string };
    for (let i = 0; i < MAX_WINDOWS; i++) {
      const prefix = `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::1`;
      expect((await reserve(directory, "connect", prefix, "UNKNOWN1")).status).toBe(404);
    }
    expect((await reserve(directory, "connect", "203.0.113.9", code)).status).toBe(200);
    expect((await reserve(directory, "connect", "2001:db8:ffff::1", code)).status).toBe(200);
    expect((await reserve(directory, "create", "203.0.113.10")).status).toBe(200);
  });

  it("never selects a game object for a nonexistent room", async () => {
    const getByName = vi.fn();
    const env = {
      GAME_ROOM: { getByName },
      ROOM_DIRECTORY: { getByName: () => ({ fetch: async () => new Response(null, { status: 404 }) }) },
    } as unknown as Env;
    const res = await worker.fetch(new Request("https://game.example/ws?room=ABCD2345", {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "1.2.3.4" },
    }), env);
    expect(res.status).toBe(404);
    expect(getByName).not.toHaveBeenCalled();
    const malformed = await worker.fetch(new Request("https://game.example/ws?room=UNKNOWN1", {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "1.2.3.4" },
    }), env);
    expect(malformed.status).toBe(400);
  });

  it("rejects foreign origins before touching the directory", async () => {
    const directoryFetch = vi.fn(async () => Response.json({ code: CODE, expiresAt: Date.now() + ROOM_TTL_MS }));
    const env = {
      GAME_ROOM: { getByName: () => ({ fetch: async () => Response.json({ code: CODE }) }) },
      ROOM_DIRECTORY: { getByName: () => ({ fetch: directoryFetch }) },
    } as unknown as Env;
    const post = (origin: string) => worker.fetch(new Request("https://game.example/api/room", {
      method: "POST",
      headers: { Origin: origin, "CF-Connecting-IP": "1.2.3.4" },
    }), env);
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("http://localhost:5173")).status).toBe(403);
    expect(directoryFetch).not.toHaveBeenCalled();
    const ok = await post("https://game.example");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ code: CODE });
  });
});

describe("game room sessions", () => {
  it("cleans expired storage and warns players before closing on alarm", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const { ctx, room } = await openRoom();
    vi.spyOn(ctx, "getWebSockets").mockReturnValue([socket as unknown as WebSocket]);
    vi.advanceTimersByTime(ROOM_TTL_MS + 1);
    await room.alarm();
    expect(sentErrors(socket)).toEqual(["ROOM_EXPIRED"]);
    expect(socket.close).toHaveBeenCalledWith(1000, "Room expired");
    expect(ctx.storage.deleteAll).toHaveBeenCalled();
    expect((await room.fetch(new Request("https://room/state"))).status).toBe(404);
  });

  it("rejects a second identity on a bound connection", async () => {
    const { room } = await openRoom();
    const ws = fakeSocket();
    await room.webSocketMessage(ws as unknown as WebSocket, join(crypto.randomUUID()));
    await room.webSocketMessage(ws as unknown as WebSocket, join(crypto.randomUUID()));
    expect(sentErrors(ws)).toEqual(["ALREADY_JOINED"]);
  });

  it("closes and forgets sockets over the message limit", async () => {
    const { room } = await openRoom();
    const flooder = fakeSocket();
    await room.webSocketMessage(flooder as unknown as WebSocket, join(crypto.randomUUID()));
    expect(sessions(room).size).toBe(1);
    for (let i = 0; i < 30; i++) await room.webSocketMessage(flooder as unknown as WebSocket, "ping?");
    expect(flooder.close).toHaveBeenCalledWith(1008, "Message limit");
    expect(sessions(room).size).toBe(0);

    const big = fakeSocket();
    await room.webSocketMessage(big as unknown as WebSocket, "x".repeat(5000));
    expect(big.close).toHaveBeenCalledWith(1008, "Message limit");
  });

  it("validates the init payload and refuses a second init", async () => {
    const { room } = await openRoom();
    const again = await room.fetch(new Request("https://room/init", { method: "POST", body: JSON.stringify({ code: CODE, expiresAt: 1 }) }));
    expect(again.status).toBe(409);
    const fresh = new GameRoom(context(), {} as Env);
    await Promise.resolve();
    const bad = await fresh.fetch(new Request("https://room/init", { method: "POST", body: JSON.stringify({ code: 1 }) }));
    expect(bad.status).toBe(400);
  });

  it("does not leave the room full after abnormal closes (1006)", async () => {
    const pending: FakeSocket[] = [];
    vi.stubGlobal("WebSocketPair", class {
      0 = fakeSocket();
      1 = fakeSocket();
      constructor() {
        pending.push(this[1]);
      }
    });
    // O Response do Node não aceita 101; o runtime do Workers aceita.
    vi.stubGlobal("Response", class extends Response {
      constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      }
    });
    const { room } = await openRoom();
    const upgrade = () => room.fetch(new Request("https://room/ws", { headers: { Upgrade: "websocket" } }));
    for (let i = 0; i < 17; i++) {
      expect((await upgrade()).status).not.toBe(429);
      const ws = pending.at(-1)!;
      if (i % 2) await room.webSocketMessage(ws as unknown as WebSocket, join(crypto.randomUUID()));
      await room.webSocketClose(ws as unknown as WebSocket, 1006, "");
    }
    expect(sessions(room).size).toBe(0);
    expect((await upgrade()).status).not.toBe(429);
  });
});
