import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressKey,
  CREATE_PER_ADDRESS_HOUR,
  CREATE_PER_HOUR,
  MAX_ACTIVE_ROOMS,
  MAX_WINDOWS,
  RoomDirectory,
  ROOM_TTL_MS,
  UNCLAIMED_ROOM_TTL_MS,
} from "./room-directory";
import {
  CLAIM_RETRY_MS,
  GameRoom,
  JOIN_TIMEOUT_MS,
  MAX_CLAIM_ATTEMPTS,
  MAX_PENDING_SESSIONS,
  MAX_SESSIONS_PER_ROOM,
} from "./game-room";
import worker from "./index";
import { CLOSE_JOIN_REFUSED, CLOSE_REPLACED, makeEnvelope, ROOM_CODE_PATTERN } from "../shared/protocol";

type FakeSocket = {
  readyState: number;
  attachment: unknown;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  serializeAttachment: ReturnType<typeof vi.fn>;
  deserializeAttachment: () => unknown;
};

/** Storage e sockets em memória. getWebSockets só lista sockets abertos. */
function context(sockets: FakeSocket[] = []) {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => values.get(key),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    getAlarm: async () => alarm,
    setAlarm: vi.fn(async (at: number) => {
      alarm = at;
    }),
    deleteAlarm: vi.fn(async () => {
      alarm = null;
    }),
    deleteAll: vi.fn(async () => {
      values.clear();
    }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(storage),
  };
  return {
    storage,
    getWebSockets: () => sockets.filter((ws) => ws.readyState < 2),
    acceptWebSocket: vi.fn((ws: FakeSocket) => {
      sockets.push(ws);
    }),
    setWebSocketAutoResponse: vi.fn(),
    blockConcurrencyWhile: async (cb: () => Promise<void>) => cb(),
  } as unknown as DurableObjectState & { storage: typeof storage };
}

/** Simula o runtime: close com código reservado lança InvalidAccessError. */
function fakeSocket(): FakeSocket {
  const ws: FakeSocket = {
    readyState: 1,
    attachment: null,
    send: vi.fn(),
    close: vi.fn((code?: number) => {
      ws.readyState = 3;
      if (code === 1005 || code === 1006) throw new TypeError(`Invalid WebSocket close code: ${code}`);
    }),
    serializeAttachment: vi.fn((value: unknown) => {
      ws.attachment = value;
    }),
    deserializeAttachment: () => ws.attachment,
  };
  return ws;
}

const reserve = (room: RoomDirectory, action: string, ip = "1.2.3.4", code?: string) =>
  room.fetch(new Request("https://directory/", {
    method: "POST",
    body: JSON.stringify({ action, ip, code }),
  }));

const CODE = "ABC23456";

async function openRoom(env = {} as Env) {
  const ctx = context();
  const room = new GameRoom(ctx, env);
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
const join = (clientId: string, displayName = "P") =>
  JSON.stringify(makeEnvelope("JOIN_ROOM", CODE, { code: CODE, clientId, displayName }));
const ready = (value = true) => JSON.stringify(makeEnvelope("READY", CODE, { ready: value }));
const leave = () => JSON.stringify(makeEnvelope("LEAVE", CODE, {}));
const sentTypes = (ws: FakeSocket) => ws.send.mock.calls.map(([raw]) => (JSON.parse(raw as string) as { type: string }).type);
const roomState = async (room: GameRoom) =>
  await (await room.fetch(new Request("https://room/state"))).json() as { phase: string; pendingForfeit: unknown; players: unknown[] };

/** Troca WebSocketPair e Response pelos do runtime; devolve os sockets do servidor. */
function stubUpgrade() {
  const server: FakeSocket[] = [];
  vi.stubGlobal("WebSocketPair", class {
    0 = fakeSocket();
    1 = fakeSocket();
    constructor() {
      server.push(this[1]);
    }
  });
  // O Response do Node não aceita 101; o runtime do Workers aceita.
  vi.stubGlobal("Response", class extends Response {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    }
  });
  return server;
}

const upgrade = (room: GameRoom) => room.fetch(new Request("https://room/ws", { headers: { Upgrade: "websocket" } }));
const message = (room: GameRoom, ws: FakeSocket, data: string | ArrayBuffer) =>
  room.webSocketMessage(ws as unknown as WebSocket, data);

/** Diretório falso; responde ao claim com a validade de 2 h ou com o status pedido. */
function claimingEnv(status = () => 200) {
  const fetch = vi.fn(async (_request: Request) => {
    const code = status();
    return code === 200 ? Response.json({ expiresAt: Date.now() + ROOM_TTL_MS }) : new Response(null, { status: code });
  });
  return { env: { ROOM_DIRECTORY: { getByName: () => ({ fetch }) } } as unknown as Env, fetch };
}

/** Sala inicializada com a validade curta de uma sala recém-criada. */
async function openUnclaimedRoom(env: Env) {
  const ctx = context();
  const room = new GameRoom(ctx, env);
  await Promise.resolve();
  await room.fetch(new Request("https://room/init", {
    method: "POST",
    body: JSON.stringify({ code: CODE, expiresAt: Date.now() + UNCLAIMED_ROOM_TTL_MS }),
  }));
  return { ctx, room };
}

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
  it("groups IPv6 by /64 (or /48 for creation) and keeps IPv4 per address", () => {
    expect(addressKey("2001:db8:1:2::1", 48)).toBe("2001:db8:1::/48");
    expect(addressKey("203.0.113.7", 48)).toBe("203.0.113.7");
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
    let code = "";
    for (let i = 0; i < 3; i++) expect((await reserve(a, "create")).status).toBe(200);
    // Uma instância nova (DO recriado) parte do que foi gravado.
    const b = new RoomDirectory(ctx, {} as Env);
    for (let i = 0; i < 2; i++) {
      const res = await reserve(b, "create");
      expect(res.status).toBe(200);
      code = (await res.json() as { code: string }).code;
    }
    expect(code).toMatch(ROOM_CODE_PATTERN);
    expect((await reserve(b, "create")).status).toBe(429);
    expect((await reserve(b, "connect", "other", "UNKNOWN1")).status).toBe(404);
    expect((await reserve(b, "connect", "other", code)).status).toBe(200);
    vi.advanceTimersByTime(ROOM_TTL_MS + 1);
    expect((await reserve(b, "connect", "other", code)).status).toBe(404);
  });

  it("shares the creation quota across addresses of the same IPv6 /48", async () => {
    const directory = new RoomDirectory(context(), {} as Env);
    for (let i = 1; i <= 5; i++) {
      expect((await reserve(directory, "create", `2001:db8:1:2::${i}`)).status).toBe(200);
    }
    expect((await reserve(directory, "create", "2001:db8:1:2::6")).status).toBe(429);
    expect((await reserve(directory, "create", "2001:db8:1:2:abcd::1")).status).toBe(429);
    expect((await reserve(directory, "create", "2001:db8:1:3::1")).status).toBe(429);
    expect((await reserve(directory, "create", "2001:db8:2::1")).status).toBe(200);
  });

  it("limits creations per address per hour", async () => {
    vi.useFakeTimers();
    const directory = new RoomDirectory(context(), {} as Env);
    let created = 0;
    for (let minute = 0; minute < 60; minute++) {
      for (let i = 0; i < 5; i++) {
        if ((await reserve(directory, "create", "198.51.100.7")).status === 200) created++;
      }
      vi.advanceTimersByTime(60_000);
    }
    expect(created).toBe(CREATE_PER_ADDRESS_HOUR);
    expect((await reserve(directory, "create", "198.51.100.8")).status).toBe(200);
  });

  it("expires unclaimed rooms after the short TTL and computes the claimed TTL itself", async () => {
    vi.useFakeTimers();
    const directory = new RoomDirectory(context(), {} as Env);
    const create = async () => (await (await reserve(directory, "create", "198.51.100.9")).json() as { code: string; expiresAt: number });
    const idle = await create();
    const claimed = await create();
    expect(idle.expiresAt).toBe(Date.now() + UNCLAIMED_ROOM_TTL_MS);
    const claim = (body: object) => directory.fetch(new Request("https://directory/", {
      method: "POST", body: JSON.stringify({ action: "claim", ...body }),
    }));
    // O expiresAt enviado é ignorado: a validade vem do relógio do diretório.
    const res = await claim({ code: claimed.code, expiresAt: Date.now() + ROOM_TTL_MS * 10 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: claimed.code, expiresAt: Date.now() + ROOM_TTL_MS });
    expect((await claim({ code: "UNKNOWN1" })).status).toBe(404);
    expect((await claim({})).status).toBe(400);
    vi.advanceTimersByTime(UNCLAIMED_ROOM_TTL_MS + 1);
    expect((await reserve(directory, "connect", "203.0.113.1", idle.code)).status).toBe(404);
    expect((await reserve(directory, "connect", "203.0.113.1", claimed.code)).status).toBe(200);
  });

  it("does not write storage or reschedule the alarm on 429 and 404", async () => {
    const ctx = context();
    const directory = new RoomDirectory(ctx, {} as Env);
    for (let i = 0; i < 5; i++) expect((await reserve(directory, "create", "198.51.100.10")).status).toBe(200);
    expect(ctx.storage.setAlarm).toHaveBeenCalledTimes(1);
    ctx.storage.put.mockClear();
    ctx.storage.setAlarm.mockClear();
    for (let i = 0; i < 50; i++) expect((await reserve(directory, "create", "198.51.100.10")).status).toBe(429);
    for (let i = 0; i < 20; i++) expect((await reserve(directory, "connect", "scanner", "UNKNOWN1")).status).toBe(404);
    for (let i = 0; i < 50; i++) expect((await reserve(directory, "connect", "scanner", "UNKNOWN1")).status).toBe(429);
    expect(ctx.storage.put).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
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

  it("an IPv6 flood from one /48 creates at most the per-address quota", async () => {
    const directory = new RoomDirectory(context(), {} as Env);
    let created = 0;
    for (let prefix = 1; prefix <= 200; prefix++) {
      if ((await reserve(directory, "create", `2001:db8:1:${prefix.toString(16)}::1`)).status === 200) created++;
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
    const server = stubUpgrade();
    const { room } = await openRoom();
    for (let i = 0; i < 17; i++) {
      expect((await upgrade(room)).status).not.toBe(429);
      const ws = server.at(-1)!;
      if (i % 2) await message(room, ws, join(crypto.randomUUID()));
      await room.webSocketClose(ws as unknown as WebSocket, 1006, "");
    }
    expect(sessions(room).size).toBe(0);
    expect((await upgrade(room)).status).not.toBe(429);
  });

  it("closes the socket on LEAVE so JOIN/LEAVE loops cannot bypass the limits", async () => {
    const server = stubUpgrade();
    const { ctx, room } = await openRoom();
    await upgrade(room);
    const victim = server.at(-1)!;
    await message(room, victim, join(crypto.randomUUID()));

    for (let i = 0; i < 40; i++) {
      expect((await upgrade(room)).status).toBe(200);
      const attacker = server.at(-1)!;
      await message(room, attacker, join(crypto.randomUUID()));
      await message(room, attacker, leave());
      expect(attacker.close).toHaveBeenCalledWith(1000, "left");
      // O attachment de jogador some: após hibernação o socket não volta como jogador.
      expect(attacker.attachment).toBeNull();
      expect(ctx.getWebSockets().length).toBeLessThanOrEqual(MAX_SESSIONS_PER_ROOM);
    }
    expect(ctx.getWebSockets()).toEqual([victim]);
    expect(sessions(room).size).toBe(1);
  });

  it("keeps the rate-limit window until close and counts open sockets from the runtime", async () => {
    const server = stubUpgrade();
    const { ctx, room } = await openRoom();
    await upgrade(room);
    const ws = server.at(-1)!;
    await message(room, ws, join(crypto.randomUUID()));
    for (let i = 0; i < 28; i++) await message(room, ws, "ping?");
    // Sem o close no LEAVE, a janela era zerada aqui.
    await message(room, ws, leave());
    expect(ws.close).toHaveBeenCalledWith(1000, "left");
    const windows = (room as unknown as { messageWindows: Map<unknown, { count: number }> }).messageWindows;
    expect(windows.get(ws)?.count).toBe(30);
    await room.webSocketClose(ws as unknown as WebSocket, 1000, "left");
    expect(windows.has(ws)).toBe(false);

    // Sockets abertos sem attachment (fora do Map de sessões) também contam.
    for (let i = 0; i < MAX_SESSIONS_PER_ROOM; i++) {
      ctx.acceptWebSocket(fakeSocket() as unknown as WebSocket);
    }
    expect((await upgrade(room)).status).toBe(429);
  });

  it("closes connections that do not JOIN in time and caps pending sockets", async () => {
    vi.useFakeTimers();
    const server = stubUpgrade();
    const { ctx, room } = await openRoom();
    await upgrade(room);
    const idle = server.at(-1)!;
    expect(ctx.storage.setAlarm).toHaveBeenLastCalledWith(Date.now() + JOIN_TIMEOUT_MS);
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS);
    await room.alarm();
    expect(idle.close).toHaveBeenCalledWith(1008, "Join timeout");
    expect(sessions(room).size).toBe(0);

    for (let i = 0; i < MAX_PENDING_SESSIONS + 3; i++) {
      expect((await upgrade(room)).status).toBe(200);
      vi.advanceTimersByTime(100);
    }
    expect(ctx.getWebSockets().length).toBe(MAX_PENDING_SESSIONS);
    expect(server.slice(1, 4).every((ws) => ws.close.mock.calls[0]?.[0] === 1013)).toBe(true);

    // Socket pending não recebe broadcast da sala.
    const player = server.at(-1)!;
    await message(room, player, join(crypto.randomUUID()));
    const lurker = server.at(-2)!;
    expect(lurker.send).not.toHaveBeenCalled();
  });

  it("finds a slot for a registered player with the room full and replaces their old socket", async () => {
    const server = stubUpgrade();
    const { env } = claimingEnv();
    const { room } = await openRoom(env);
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    await upgrade(room);
    const a1 = server.at(-1)!;
    await message(room, a1, join(alice));
    await upgrade(room);
    const b1 = server.at(-1)!;
    await message(room, b1, join(bob));
    // Quem já estava na sala recebe a lista com o novo jogador.
    expect(sentTypes(a1).filter((t) => t === "ROOM_STATE").length).toBeGreaterThanOrEqual(2);
    await message(room, a1, ready());
    await message(room, b1, ready());

    // Atacante lota a sala com conexões sem JOIN; Alice cai.
    for (let i = 0; i < MAX_SESSIONS_PER_ROOM; i++) await upgrade(room);
    await room.webSocketClose(a1 as unknown as WebSocket, 1006, "");
    expect(sentTypes(b1)).toContain("ERROR");
    expect((await upgrade(room)).status).toBe(200);
    const a2 = server.at(-1)!;
    await message(room, a2, join(alice));
    expect(await roomState(room)).toMatchObject({ phase: "playing", pendingForfeit: null });

    // Uma segunda conexão da mesma Alice derruba a anterior.
    await upgrade(room);
    const a3 = server.at(-1)!;
    await message(room, a3, join(alice));
    expect(a2.close).toHaveBeenCalledWith(CLOSE_REPLACED, "Replaced by new connection");
    const bound = [...sessions(room).values()].filter((s) => (s as { clientId: string }).clientId === alice);
    expect(bound).toHaveLength(1);

    // Um terceiro jogador é recusado e o socket fecha.
    await upgrade(room);
    const carol = server.at(-1)!;
    await message(room, carol, join(crypto.randomUUID()));
    expect(carol.close).toHaveBeenCalledWith(CLOSE_JOIN_REFUSED, "Room busy");
  });

  it("only persists JOIN and READY when the room state changes", async () => {
    const server = stubUpgrade();
    const { env, fetch } = claimingEnv();
    const { ctx, room } = await openRoom(env);
    const alice = crypto.randomUUID();
    await upgrade(room);
    const ws = server.at(-1)!;
    await message(room, ws, join(alice));
    expect(fetch).toHaveBeenCalledTimes(1);
    await message(room, ws, ready());
    ctx.storage.put.mockClear();
    ctx.storage.setAlarm.mockClear();
    for (let i = 0; i < 10; i++) {
      await message(room, ws, join(alice));
      await message(room, ws, ready());
    }
    expect(ctx.storage.put).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    await message(room, ws, join(alice, "Novo nome"));
    expect(ctx.storage.put).toHaveBeenCalledTimes(1);
  });

  it("starts with a short TTL and uses the expiry returned by the directory on the first JOIN", async () => {
    vi.useFakeTimers();
    const server = stubUpgrade();
    const { env, fetch } = claimingEnv();
    const { room } = await openUnclaimedRoom(env);
    await upgrade(room);
    await message(room, server.at(-1)!, join(crypto.randomUUID()));
    expect(await fetch.mock.calls[0][0].json()).toEqual({ action: "claim", code: CODE });
    vi.advanceTimersByTime(UNCLAIMED_ROOM_TTL_MS + 1);
    expect((await room.fetch(new Request("https://room/state"))).status).toBe(200);
  });

  it("retries a failed claim on READY, match start and alarm so the match outlives the short TTL", async () => {
    vi.useFakeTimers();
    const server = stubUpgrade();
    let failures = 3;
    const { env, fetch } = claimingEnv(() => (failures-- > 0 ? 503 : 200));
    const { ctx, room } = await openUnclaimedRoom(env);
    const socks: FakeSocket[] = [];
    for (const id of [crypto.randomUUID(), crypto.randomUUID()]) {
      await upgrade(room);
      socks.push(server.at(-1)!);
      await message(room, socks.at(-1)!, join(id));
    }
    // JOIN, JOIN e READY falham; o READY que começa a partida tenta de novo.
    await message(room, socks[0], ready());
    expect(fetch).toHaveBeenCalledTimes(3);
    await message(room, socks[1], ready());
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect((await roomState(room)).phase).toBe("playing");
    vi.advanceTimersByTime(UNCLAIMED_ROOM_TTL_MS + 1);
    await room.alarm();
    expect(ctx.storage.deleteAll).not.toHaveBeenCalled();
    expect((await room.fetch(new Request("https://room/state"))).status).toBe(200);
  });

  it("tries the claim from the alarm before expiring and gives up after the attempt limit", async () => {
    vi.useFakeTimers();
    const server = stubUpgrade();
    let directoryUp = false;
    const { env, fetch } = claimingEnv(() => (directoryUp ? 200 : 503));
    const { ctx, room } = await openUnclaimedRoom(env);
    await upgrade(room);
    await message(room, server.at(-1)!, join(crypto.randomUUID()));
    expect(ctx.storage.setAlarm).toHaveBeenLastCalledWith(Date.now() + CLAIM_RETRY_MS);
    vi.advanceTimersByTime(CLAIM_RETRY_MS);
    await room.alarm();
    expect(fetch).toHaveBeenCalledTimes(2);
    directoryUp = true;
    vi.advanceTimersByTime(UNCLAIMED_ROOM_TTL_MS);
    await room.alarm();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(ctx.storage.deleteAll).not.toHaveBeenCalled();

    // Com o diretório fora do ar, as tentativas param no limite.
    const down = claimingEnv(() => 503);
    const other = await openUnclaimedRoom(down.env);
    await upgrade(other.room);
    await message(other.room, server.at(-1)!, join(crypto.randomUUID()));
    for (let i = 0; i < MAX_CLAIM_ATTEMPTS + 5; i++) {
      vi.advanceTimersByTime(CLAIM_RETRY_MS);
      await other.room.alarm();
    }
    vi.advanceTimersByTime(UNCLAIMED_ROOM_TTL_MS);
    await other.room.alarm();
    expect(down.fetch).toHaveBeenCalledTimes(MAX_CLAIM_ATTEMPTS);
    expect(other.ctx.storage.deleteAll).toHaveBeenCalled();
  });

  it("clears a stale forfeit when the player is connected instead of looping the alarm", async () => {
    vi.useFakeTimers();
    const server = stubUpgrade();
    const { room, ctx } = await openRoom(claimingEnv().env);
    const socks: FakeSocket[] = [];
    for (const id of [crypto.randomUUID(), crypto.randomUUID()]) {
      await upgrade(room);
      socks.push(server.at(-1)!);
      await message(room, socks.at(-1)!, join(id));
    }
    for (const ws of socks) await message(room, ws, ready());
    (room as unknown as { pendingForfeit: unknown }).pendingForfeit = {
      playerId: (sessions(room).get(socks[0]) as { playerId: string }).playerId,
      at: Date.now() - 1,
    };
    ctx.storage.setAlarm.mockClear();
    await room.alarm();
    await room.alarm();
    expect((room as unknown as { pendingForfeit: unknown }).pendingForfeit).toBeNull();
    for (const [at] of ctx.storage.setAlarm.mock.calls) expect(at).toBeGreaterThan(Date.now());
  });

  it("rate-limits and closes binary frames", async () => {
    const { room } = await openRoom();
    const binary = fakeSocket();
    await message(room, binary, new ArrayBuffer(8));
    expect(sentErrors(binary)).toEqual(["INVALID_PAYLOAD"]);
    expect(binary.close).toHaveBeenCalledWith(1003, "Text frames only");

    const big = fakeSocket();
    await message(room, big, new ArrayBuffer(512 * 1024));
    expect(big.close).toHaveBeenCalledWith(1008, "Message limit");
    expect(big.send).not.toHaveBeenCalled();

    const flooder = fakeSocket();
    for (let i = 0; i < 30; i++) await message(room, flooder, "ping?");
    await message(room, flooder, new ArrayBuffer(8));
    expect(flooder.close).toHaveBeenCalledWith(1008, "Message limit");
  });
});
