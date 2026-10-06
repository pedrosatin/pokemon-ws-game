import { useEffect, useMemo, useState } from "react";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { InstallHint } from "./components/InstallHint";
import { MatchPanel } from "./components/MatchPanel";
import { OfflineBanner } from "./components/OfflineBanner";
import { useGameSocket } from "./hooks/useGameSocket";

type Mode = "home" | "room";

function statusLabel(status: string) {
  switch (status) {
    case "connected":
      return "Conectado";
    case "connecting":
      return "Conectando…";
    case "reconnecting":
      return "Reconectando…";
    case "closed":
      return "Desconectado";
    default:
      return "Pronto";
  }
}

export default function App() {
  const [mode, setMode] = useState<Mode>("home");
  const [displayName, setDisplayName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const {
    status,
    room,
    match,
    connect,
    disconnect,
    setReady,
    selectStat,
    requestRematch,
  } = useGameSocket();

  const me = useMemo(
    () => room.players.find((p) => p.playerId === room.youAre) ?? null,
    [room.players, room.youAre],
  );

  const inMatch = room.phase === "playing" || room.phase === "finished";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    if (roomParam) {
      setJoinCode(roomParam.toUpperCase());
    }
  }, []);

  async function createRoom() {
    setBusy(true);
    try {
      const res = await fetch("/api/room", { method: "POST" });
      if (!res.ok) throw new Error("Falha ao criar sala");
      const data = (await res.json()) as { code: string };
      const code = data.code.toUpperCase();
      const url = new URL(window.location.href);
      url.searchParams.set("room", code);
      window.history.replaceState({}, "", url);
      setMode("room");
      connect(code, displayName || "Jogador");
    } catch (err) {
      console.error(err);
      alert("Não foi possível criar a sala. Tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  function enterRoom() {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    window.history.replaceState({}, "", url);
    setMode("room");
    connect(code, displayName || "Jogador");
  }

  function leaveRoom() {
    disconnect();
    setMode("home");
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url);
  }

  async function copyInvite() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", room.code);
    try {
      await navigator.clipboard.writeText(url.toString());
      alert("Link copiado.");
    } catch {
      prompt("Copie o link:", url.toString());
    }
  }

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
        <header className="mb-4">
          <p className="text-xs font-semibold tracking-wide text-amber-400 uppercase">
            Fan demo · Cloudflare Free
          </p>
          <h1 className="mt-1 text-2xl font-bold text-balance">
            Super Trunfo de Stats
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            1v1 no celular via WebSocket. Instale como PWA e jogue em tela cheia.
          </p>
        </header>

        <OfflineBanner />
        <InstallHint />
        {mode === "room" ? <ConnectionBanner status={status} /> : null}

        {mode === "home" ? (
          <main className="flex flex-1 flex-col gap-4">
            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">Apelido</span>
              <input
                className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base outline-none ring-amber-400 focus:ring-2"
                maxLength={16}
                placeholder="Ex.: Ash"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="nickname"
              />
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={() => void createRoom()}
              className="min-h-12 rounded-xl bg-amber-400 px-4 text-base font-semibold text-slate-950 disabled:opacity-60"
            >
              {busy ? "Criando sala…" : "Criar sala"}
            </button>

            <div className="relative my-2 text-center text-xs text-slate-500">
              <span className="bg-slate-950 px-2">ou entrar</span>
              <div className="absolute inset-x-0 top-1/2 -z-10 h-px bg-slate-800" />
            </div>

            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">Código</span>
              <input
                className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 font-mono text-base tracking-widest uppercase outline-none ring-amber-400 focus:ring-2"
                maxLength={8}
                placeholder="ABCD2345"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect="off"
              />
            </label>

            <button
              type="button"
              onClick={enterRoom}
              className="min-h-12 rounded-xl border border-slate-600 px-4 text-base font-semibold"
            >
              Entrar na sala
            </button>
          </main>
        ) : (
          <main className="flex flex-1 flex-col gap-4">
            <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs text-slate-400">Sala</p>
                  <p className="font-mono text-2xl tracking-[0.2em]">{room.code}</p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    status === "connected"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-amber-500/15 text-amber-200"
                  }`}
                >
                  {statusLabel(status)}
                </span>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void copyInvite()}
                  className="min-h-11 flex-1 rounded-xl bg-slate-800 text-sm font-medium"
                >
                  Copiar link
                </button>
                <button
                  type="button"
                  onClick={leaveRoom}
                  className="min-h-11 rounded-xl px-4 text-sm text-slate-300"
                >
                  Sair
                </button>
              </div>
            </section>

            {inMatch ? (
              <MatchPanel
                room={room}
                match={match}
                selectStat={selectStat}
                requestRematch={requestRematch}
                onLeave={leaveRoom}
              />
            ) : (
              <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <h2 className="text-sm font-semibold text-slate-200">Jogadores</h2>
                <ul className="mt-3 space-y-2">
                  {[0, 1].map((slot) => {
                    const player = room.players[slot];
                    return (
                      <li
                        key={slot}
                        className="flex min-h-12 items-center justify-between rounded-xl bg-slate-950/80 px-3"
                      >
                        {player ? (
                          <>
                            <span>
                              {player.displayName}
                              {player.playerId === room.youAre ? " (você)" : ""}
                            </span>
                            <span
                              className={`text-xs ${player.ready ? "text-emerald-300" : "text-slate-500"}`}
                            >
                              {player.ready ? "Pronto" : "Aguardando"}
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-500">Slot vazio</span>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {me ? (
                  <button
                    type="button"
                    onClick={() => setReady(!me.ready)}
                    className="mt-4 min-h-12 w-full rounded-xl bg-amber-400 text-base font-semibold text-slate-950"
                  >
                    {me.ready ? "Cancelar pronto" : "Estou pronto"}
                  </button>
                ) : null}

                {room.lastError ? (
                  <p className="mt-3 text-sm text-red-300" role="alert">
                    {room.lastError}
                  </p>
                ) : null}

                <p className="mt-4 text-sm text-slate-500">
                  Quando os 2 estiverem prontos, o servidor distribui 5 cartas
                  (gen 1) e começa o Super Trunfo.
                </p>
              </section>
            )}
          </main>
        )}

        <footer className="mt-auto space-y-2 pt-8 text-center text-[11px] leading-relaxed text-slate-500">
          <p>
            Projeto fan/educacional. Sem afiliação à Nintendo, Game Freak,
            Creatures ou The Pokémon Company. Nomes e sprites via PokéAPI; stats
            resolvidos no servidor a partir de um seed local.
          </p>
          <p>
            Não é um simulador oficial de batalha. É um Super Trunfo de atributos
            para estudar WebSockets na edge.
          </p>
          <p className="text-slate-600">
            Criado por{" "}
            <a
              href="https://github.com/pedrosatin"
              className="underline hover:text-slate-400"
            >
              @pedrosatin
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
