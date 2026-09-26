import { useEffect, useMemo, useState } from "react";
import type { StatKey } from "../../shared/protocol";
import { usePokemon, usePrefetchDeck } from "../hooks/usePokemon";
import type { useGameSocket } from "../hooks/useGameSocket";
import { PokemonCard } from "./PokemonCard";
import { StatButtons } from "./StatButtons";

type Socket = ReturnType<typeof useGameSocket>;

type Props = {
  room: Socket["room"];
  match: Socket["match"];
  selectStat: Socket["selectStat"];
  requestRematch: Socket["requestRematch"];
  onLeave: () => void;
};

function formatStat(stat: StatKey) {
  return stat.replace("special-", "sp. ");
}

export function MatchPanel({
  room,
  match,
  selectStat,
  requestRematch,
  onLeave,
}: Props) {
  usePrefetchDeck(match.deck);
  const { data: myPokemon, isLoading } = usePokemon(match.yourCardId);
  const result = match.lastResult;
  const myResult =
    result && room.youAre
      ? result.p1.playerId === room.youAre
        ? result.p1
        : result.p2
      : null;
  const oppResult =
    result && room.youAre
      ? result.p1.playerId === room.youAre
        ? result.p2
        : result.p1
      : null;
  const { data: revealedOpp } = usePokemon(oppResult?.cardId);

  const isMyTurn = Boolean(
    match.roundId && room.youAre && match.turnPlayerId === room.youAre,
  );

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!match.deadlineMs || !match.roundId) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [match.deadlineMs, match.roundId]);

  const secondsLeft = useMemo(() => {
    if (!match.deadlineMs || !match.roundId) return null;
    return Math.max(0, Math.ceil((match.deadlineMs - now) / 1000));
  }, [match.deadlineMs, match.roundId, now]);

  const scoreLine = room.players
    .map((p) => `${p.displayName}: ${room.scores[p.playerId] ?? 0}`)
    .join(" · ");

  if (room.phase === "finished") {
    const winner = room.players.find((p) => p.playerId === match.matchWinnerId);
    return (
      <section className="flex flex-1 flex-col gap-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-center">
          <p className="text-xs tracking-wide text-slate-400 uppercase">Fim de jogo</p>
          <h2 className="mt-2 text-2xl font-bold">
            {winner
              ? winner.playerId === room.youAre
                ? "Você venceu!"
                : `${winner.displayName} venceu`
              : "Empate"}
          </h2>
          <p className="mt-2 text-sm text-slate-400">{scoreLine}</p>
        </div>
        <button
          type="button"
          onClick={requestRematch}
          className="min-h-12 rounded-xl bg-amber-400 text-base font-semibold text-slate-950"
        >
          Pedir rematch
        </button>
        <button
          type="button"
          onClick={onLeave}
          className="min-h-11 rounded-xl border border-slate-700 text-sm"
        >
          Sair da sala
        </button>
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-between gap-2 text-sm">
        <p className="text-slate-300">
          Rodada {Math.min(match.roundIndex + 1, match.roundCount)}/{match.roundCount}
        </p>
        <p className="font-mono text-xs text-slate-400">{scoreLine}</p>
      </div>

      {secondsLeft != null ? (
        <p
          className={`text-center text-sm ${isMyTurn ? "text-amber-300" : "text-slate-400"}`}
        >
          {isMyTurn ? "Sua vez" : "Vez do oponente"} · {secondsLeft}s
        </p>
      ) : null}

      <PokemonCard
        pokemon={myPokemon}
        loading={isLoading}
        label="Sua carta"
      />

      {result ? (
        <div className="rounded-2xl border border-emerald-900/50 bg-emerald-950/30 p-3 text-sm">
          <p className="font-medium text-emerald-200">
            {formatStat(result.stat)} ·{" "}
            {result.winnerPlayerId == null
              ? "Empate"
              : result.winnerPlayerId === room.youAre
                ? "Você levou o ponto"
                : "Oponente levou o ponto"}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <PokemonCard pokemon={myPokemon} label={`Você (${myResult?.value})`} />
            <PokemonCard
              pokemon={revealedOpp}
              label={`Rival (${oppResult?.value})`}
            />
          </div>
        </div>
      ) : (
        <PokemonCard hidden label="Carta rival" />
      )}

      <StatButtons
        stats={myPokemon?.stats}
        disabled={!isMyTurn}
        onSelect={(stat) => {
          if (match.roundId) selectStat(match.roundId, stat);
        }}
      />
    </section>
  );
}
