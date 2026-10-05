import { generateRoomCode } from "../shared/protocol";
import { GameRoom } from "./game-room";

export { GameRoom };

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, init);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "pokemon-ws-game",
        freeTier: true,
      });
    }

    if (url.pathname === "/api/room" && request.method === "POST") {
      const code = generateRoomCode(6);
      const stub = env.GAME_ROOM.getByName(code);
      const state = (await stub
        .fetch(new Request("https://room/state"))
        .then((r: Response) => r.json())) as { code: string };
      return json({ code: state.code || code });
    }

    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade?.toLowerCase() !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const origin = request.headers.get("Origin");
      if (origin) {
        try {
          const originHost = new URL(origin).hostname;
          const host = url.hostname;
          if (originHost !== host && originHost !== "localhost" && originHost !== "127.0.0.1") {
            return new Response("Origin not allowed", { status: 403 });
          }
        } catch {
          return new Response("Invalid Origin header", { status: 400 });
        }
      }

      const roomId = (url.searchParams.get("room") ?? "").trim().toUpperCase();
      if (!roomId || !/^[A-Z0-9]{4,10}$/.test(roomId)) {
        return new Response("Invalid room query param", { status: 400 });
      }

      const stub = env.GAME_ROOM.getByName(roomId);
      return stub.fetch(request);
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
