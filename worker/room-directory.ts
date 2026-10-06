import { DurableObject } from "cloudflare:workers";
import { generateRoomCode } from "../shared/protocol";

export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
/** Validade de uma sala criada que ainda não recebeu nenhum JOIN_ROOM. */
export const UNCLAIMED_ROOM_TTL_MS = 10 * 60 * 1000;
/** Criações por endereço (IPv4 ou prefixo IPv6 /48) por minuto. */
export const CREATE_PER_ADDRESS = 5;
/** Criações por endereço (IPv4 ou prefixo IPv6 /48) por hora. */
export const CREATE_PER_ADDRESS_HOUR = 20;
/** Tentativas de entrada por endereço (IPv4 ou prefixo IPv6 /64) por minuto. */
export const CONNECT_PER_ADDRESS = 20;
/** Criações por hora no serviço inteiro. */
export const CREATE_PER_HOUR = 250;
/** Salas ativas: CREATE_PER_HOUR × TTL de 2 h, então o teto só é atingido no limite da cota global. */
export const MAX_ACTIVE_ROOMS = CREATE_PER_HOUR * (ROOM_TTL_MS / 3_600_000);
/** Registros de cota guardados ao mesmo tempo. */
export const MAX_WINDOWS = 2000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

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
 * /64 troca de endereço sem custo) ou /48 na criação de salas, já que blocos
 * /48 são comuns em VPS. IPv4 mapeado em IPv6 volta a ser IPv4.
 */
export function addressKey(ip: string, prefix: 48 | 64 = 64): string {
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, prefix / 16).map((g) => g.toString(16)).join(":")}::/${prefix}`;
}

type DirectoryRequest = { ip?: string; action?: string; code?: string };

/**
 * Um único diretório coordena a criação de salas entre isolates do Worker.
 * O estado fica em memória e só é gravado quando a resposta é 200: recusas
 * (429/404) não escrevem no storage nem reagendam o alarm.
 */
export class RoomDirectory extends DurableObject<Env> {
  private state: State | null = null;
  private loading: Promise<State> | null = null;

  async fetch(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as DirectoryRequest | null;
    const action = body?.action;
    if (action === "claim") return this.claim(body?.code);
    const ip = body?.ip;
    if (!ip || typeof ip !== "string" || ip.length > 64 || (action !== "create" && action !== "connect")) {
      return new Response(null, { status: 400 });
    }
    const state = await this.load();
    const now = Date.now();
    prune(state, now);

    if (action === "create") {
      const address = addressKey(ip, 48);
      const allowed = reserve(state, now, [
        { key: `create:${address}`, max: CREATE_PER_ADDRESS, ttl: MINUTE_MS },
        { key: `create-hour:${address}`, max: CREATE_PER_ADDRESS_HOUR, ttl: HOUR_MS },
      ]);
      const global = state.global ?? { count: 0, until: now + HOUR_MS };
      if (!allowed || Object.keys(state.rooms).length >= MAX_ACTIVE_ROOMS || global.count >= CREATE_PER_HOUR) {
        return tooMany();
      }
      global.count++;
      state.global = global;
      let room: string;
      do {
        room = generateRoomCode(8);
      } while (state.rooms[room]);
      const expiresAt = now + UNCLAIMED_ROOM_TTL_MS;
      state.rooms[room] = expiresAt;
      await this.save(now);
      return Response.json({ code: room, expiresAt });
    }

    const code = body?.code;
    if (!reserve(state, now, [{ key: `connect:${addressKey(ip)}`, max: CONNECT_PER_ADDRESS, ttl: MINUTE_MS }])) {
      return tooMany();
    }
    if (!code || !state.rooms[code]) return new Response(null, { status: 404 });
    await this.save(now);
    return Response.json({ code, expiresAt: state.rooms[code] });
  }

  async alarm() {
    const state = await this.load();
    const now = Date.now();
    prune(state, now);
    if (!Object.keys(state.rooms).length && !Object.keys(state.windows).length && !state.global) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.put("directory", state);
      await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    }
  }

  /**
   * Chamado pelo GameRoom quando a sala recebe jogadores: a sala passa da
   * validade curta para a normal. A validade é calculada aqui, pelo relógio do
   * diretório, e devolvida ao GameRoom. Só o Worker fala com o diretório e ele
   * nunca repassa esta ação a partir de uma requisição externa.
   */
  private async claim(code: unknown): Promise<Response> {
    if (typeof code !== "string") return new Response(null, { status: 400 });
    const now = Date.now();
    const state = await this.load();
    prune(state, now);
    if (!state.rooms[code]) return new Response(null, { status: 404 });
    state.rooms[code] = Math.max(state.rooms[code], now + ROOM_TTL_MS);
    await this.save(now);
    return Response.json({ code, expiresAt: state.rooms[code] });
  }

  private load(): Promise<State> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= this.ctx.storage.get<State>("directory").then((stored) => {
      this.state = stored ?? { rooms: {}, windows: {} };
      return this.state;
    });
    return this.loading;
  }

  private async save(now: number) {
    await this.ctx.storage.put("directory", this.state);
    if (await this.ctx.storage.getAlarm() == null) {
      await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    }
  }
}

function tooMany() {
  return Response.json({}, { status: 429, headers: { "retry-after": "60" } });
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

type Quota = { key: string; max: number; ttl: number };

/**
 * Conta uma tentativa em cada janela se todas tiverem espaço. Com o teto de
 * registros cheio, descarta o registro que expira primeiro em vez de recusar
 * a requisição: entrada e reconexão em sala existente nunca dependem de
 * espaço livre na tabela.
 */
function reserve(state: State, now: number, quotas: Quota[]) {
  if (quotas.some(({ key, max }) => (state.windows[key]?.count ?? 0) >= max)) return false;
  for (const { key, ttl } of quotas) {
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
      window = { count: 0, until: now + ttl };
      state.windows[key] = window;
    }
    window.count++;
  }
  return true;
}
