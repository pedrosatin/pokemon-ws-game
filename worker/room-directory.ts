import { DurableObject } from "cloudflare:workers";
import { generateRoomCode } from "../shared/protocol";

export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
/** Criações por endereço (IPv4 ou prefixo IPv6 /64) por minuto. */
export const CREATE_PER_ADDRESS = 5;
/** Tentativas de entrada por endereço por minuto. */
export const CONNECT_PER_ADDRESS = 20;
/** Criações por hora no serviço inteiro. */
export const CREATE_PER_HOUR = 250;
/** Salas ativas: CREATE_PER_HOUR × TTL de 2 h, então o teto só é atingido no limite da cota global. */
export const MAX_ACTIVE_ROOMS = CREATE_PER_HOUR * (ROOM_TTL_MS / 3_600_000);
/** Registros de cota guardados ao mesmo tempo. */
export const MAX_WINDOWS = 2000;

type Window = { count: number; until: number };
type State = {
  rooms: Record<string, number>;
  windows: Record<string, Window>;
  global?: Window;
};

function expandIpv6(ip: string): number[] | null {
  let address = ip.toLowerCase().split("%")[0];
  const v4 = address.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const bytes = v4.slice(2).map(Number);
    if (bytes.some((b) => b > 255)) return null;
    address = `${v4[1]}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Chave de cota: IPv4 por endereço, IPv6 pelo prefixo /64 (quem controla um
 * /64 troca de endereço sem custo). IPv4 mapeado em IPv6 volta a ser IPv4.
 */
export function addressKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** Um único diretório coordena a criação de salas entre isolates do Worker. */
export class RoomDirectory extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const { ip, action, code } = await request.json() as { ip: string; action: string; code?: string };
    if (!ip || ip.length > 64 || !["create", "connect"].includes(action)) {
      return new Response(null, { status: 400 });
    }
    return this.ctx.storage.transaction(async (tx) => {
      const now = Date.now();
      const state = await tx.get<State>("directory") ?? { rooms: {}, windows: {} };
      prune(state, now);

      const key = `${action}:${addressKey(ip)}`;
      const limit = action === "create" ? CREATE_PER_ADDRESS : CONNECT_PER_ADDRESS;
      let status = 200;
      let result: { code?: string; expiresAt?: number } = {};

      if (!reserve(state, key, limit, now)) {
        status = 429;
      } else if (action === "create") {
        const global = state.global ?? { count: 0, until: now + 3_600_000 };
        if (Object.keys(state.rooms).length >= MAX_ACTIVE_ROOMS || global.count >= CREATE_PER_HOUR) {
          status = 429;
        } else {
          global.count++;
          state.global = global;
          let room: string;
          do {
            room = generateRoomCode(8);
          } while (state.rooms[room]);
          const expiresAt = now + ROOM_TTL_MS;
          state.rooms[room] = expiresAt;
          result = { code: room, expiresAt };
        }
      } else if (!code || !state.rooms[code]) {
        status = 404;
      } else {
        result = { code, expiresAt: state.rooms[code] };
      }

      await tx.put("directory", state);
      await tx.setAlarm(now + ROOM_TTL_MS);
      return Response.json(result, { status, headers: status === 429 ? { "retry-after": "60" } : {} });
    });
  }

  async alarm() {
    const state = await this.ctx.storage.get<State>("directory");
    if (!state) return;
    const now = Date.now();
    prune(state, now);
    if (!Object.keys(state.rooms).length && !Object.keys(state.windows).length && !state.global) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.put("directory", state);
      await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    }
  }
}

function prune(state: State, now: number) {
  for (const [key, until] of Object.entries(state.rooms)) {
    if (until <= now) delete state.rooms[key];
  }
  for (const [key, window] of Object.entries(state.windows)) {
    if (window.until <= now) delete state.windows[key];
  }
  if (state.global && state.global.until <= now) delete state.global;
}

/**
 * Conta uma tentativa na janela de 60 s da chave. Com o teto de registros
 * cheio, descarta o registro que expira primeiro em vez de recusar a
 * requisição: entrada e reconexão em sala existente nunca dependem de espaço
 * livre na tabela.
 */
function reserve(state: State, key: string, max: number, now: number) {
  let window = state.windows[key];
  if (!window) {
    const keys = Object.keys(state.windows);
    if (keys.length >= MAX_WINDOWS) {
      let oldest = keys[0];
      for (const candidate of keys) {
        if (state.windows[candidate].until < state.windows[oldest].until) oldest = candidate;
      }
      delete state.windows[oldest];
    }
    window = { count: 0, until: now + 60_000 };
  }
  if (window.count >= max) return false;
  window.count++;
  state.windows[key] = window;
  return true;
}
