import { DurableObject } from "cloudflare:workers";
import { generateRoomCode } from "../shared/protocol";

export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
type State = {
  rooms: Record<string, number>;
  windows: Record<string, { count: number; until: number }>;
};

/** One directory coordinates provisioning across Worker isolates. */
export class RoomDirectory extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const { ip, action, code } = await request.json() as { ip: string; action: string; code?: string };
    if (!ip || ip.length > 64 || !["create", "connect"].includes(action)) return new Response(null, { status: 400 });
    return this.ctx.storage.transaction(async (tx) => {
      const now = Date.now();
      const state = await tx.get<State>("directory") ?? { rooms: {}, windows: {} };
      for (const [key, until] of Object.entries(state.rooms)) if (until <= now) delete state.rooms[key];
      for (const [key, window] of Object.entries(state.windows)) if (window.until <= now) delete state.windows[key];
      const reserve = (key: string, max: number, duration: number) => {
        const window = state.windows[key] ?? { count: 0, until: now + duration };
        if (window.count >= max) return false;
        window.count++;
        state.windows[key] = window;
        return true;
      };
      // Keep persistent records bounded even under a distributed flood.
      if (Object.keys(state.windows).length >= 2000) return new Response(null, { status: 429 });
      let status = 200;
      let result: { code?: string; expiresAt?: number } = {};
      if (!reserve(`${action}:${ip}`, action === "create" ? 5 : 20, 60_000)) status = 429;
      else if (action === "create") {
        if (Object.keys(state.rooms).length >= 500 || !reserve("global:create", 100, 3_600_000)) status = 429;
        else {
          let room: string;
          do { room = generateRoomCode(8); } while (state.rooms[room]);
          const expiresAt = now + ROOM_TTL_MS;
          state.rooms[room] = expiresAt;
          result = { code: room, expiresAt };
        }
      } else if (!code || !state.rooms[code]) status = 404;
      else result = { code, expiresAt: state.rooms[code] };
      await tx.put("directory", state);
      await tx.setAlarm(now + ROOM_TTL_MS);
      return Response.json(result, { status, headers: status === 429 ? { "retry-after": "60" } : {} });
    });
  }

  async alarm() {
    const state = await this.ctx.storage.get<State>("directory");
    if (!state) return;
    const now = Date.now();
    for (const [key, until] of Object.entries(state.rooms)) if (until <= now) delete state.rooms[key];
    for (const [key, window] of Object.entries(state.windows)) if (window.until <= now) delete state.windows[key];
    if (!Object.keys(state.rooms).length && !Object.keys(state.windows).length) await this.ctx.storage.deleteAll();
    else {
      await this.ctx.storage.put("directory", state);
      await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    }
  }
}
