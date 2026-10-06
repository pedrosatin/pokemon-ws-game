import { RoomDirectory } from "./room-directory";
import { GameRoom } from "./game-room";
import { ROOM_CODE_PATTERN } from "../shared/protocol";

export { GameRoom, RoomDirectory };

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

    const isLocal = ["localhost", "127.0.0.1"].includes(url.hostname);
    const ip = request.headers.get("CF-Connecting-IP") ?? (isLocal ? "local" : "");
    const origin = request.headers.get("Origin");
    if (!ip) return new Response("Client address required", { status: 403 });
    if (origin) {
      try {
        if (origin !== url.origin && !(isLocal && ["localhost", "127.0.0.1"].includes(new URL(origin).hostname))) {
          return new Response("Origin not allowed", { status: 403 });
        }
      } catch { return new Response("Invalid Origin", { status: 400 }); }
    }
    const directory = env.ROOM_DIRECTORY.getByName("rooms");
    if (url.pathname === "/api/room" && request.method === "POST") {
      const response = await directory.fetch(new Request("https://directory/", {
        method: "POST", body: JSON.stringify({ action: "create", ip }),
      }));
      if (!response.ok) return response;
      const room = await response.json() as { code: string; expiresAt: number };
      const stub = env.GAME_ROOM.getByName(room.code);
      const initialized = await stub.fetch(new Request("https://room/init", { method: "POST", body: JSON.stringify(room) }));
      if (!initialized.ok) return new Response("Room unavailable", { status: 503 });
      return json({ code: room.code });
    }

    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade?.toLowerCase() !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const roomId = (url.searchParams.get("room") ?? "").trim().toUpperCase();
      if (!ROOM_CODE_PATTERN.test(roomId)) {
        return new Response("Invalid room query param", { status: 400 });
      }

      const response = await directory.fetch(new Request("https://directory/", {
        method: "POST", body: JSON.stringify({ action: "connect", ip, code: roomId }),
      }));
      if (!response.ok) return response;
      const stub = env.GAME_ROOM.getByName(roomId);
      return stub.fetch(request);
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
