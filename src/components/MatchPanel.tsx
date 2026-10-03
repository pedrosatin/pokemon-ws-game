import { useEffect, useMemo, useState } from "react";
import type { StatKey } from "../../shared/protocol";
import { usePokemon, usePrefetchDeck } from "../hooks/usePokemon";
import type { useGameSocket } from "../hooks/useGameSocket";
import type { PokemonView } from "../lib/pokemon";
import { PokemonCard } from "./PokemonCard";
import { StatButtons } from "./StatButtons";

type Socket = ReturnType<typeof useGameSocket>;
type Room = Socket["room"];
type Match = Socket["match"];
type RoundResult = NonNullable<Match["lastResult"]>;
type SideResult = RoundResult["p1"];

type Props = {
  room: Room;
  match: Match;
  selectStat: Socket["selectStat"];
  requestRematch: Socket["requestRematch"];
  onLeave: () => void;
};

function formatStat(stat: StatKey) {
  return stat.replace("special-", "sp. ");
}

function scoreLine(room: Room) {
  return room.players
    .map((p) => `${p.displayName}: ${room.scores[p.playerId] ?? 0}`)
    .join(" · ");
}

function sidesFromResult(
  result: RoundResult | null,
  youAre: string | null,
): { mine: SideResult | null; opponent: SideResult | null } {
  if (!result || !youAre) {
    return { mine: null, opponent: null };
  }
  if (result.p1.playerId === youAre) {
    return { mine: result.p1, opponent: result.p2 };
  }
  return { mine: result.p2, opponent: result.p1 };
}

function useRoundSecondsLeft(deadlineMs: number, roundId: string | null) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!deadlineMs || !roundId) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [deadlineMs, roundId]);

  return useMemo(() => {
    if (!deadlineMs || !roundId) return null;
    return Math.max(0, Math.ceil((deadlineMs - now) / 1000));
  }, [deadlineMs, roundId, now]);
}

function finishedTitle(room: Room, matchWinnerId: string | null) {
  const winner = room.players.find((p) => p.playerId === matchWinnerId);
  if (!winner) return "Empate";
  if (winner.playerId === room.youAre) return "Você venceu!";
  return `${winner.displayName} venceu`;
}

function roundOutcomeLabel(result: RoundResult, youAre: string | null) {
  if (result.winnerPlayerId == null) return "Empate";
  if (result.winnerPlayerId === youAre) return "Você levou o ponto";
  return "Oponente levou o ponto";
}

function MatchFinishedPanel({
  room,
  matchWinnerId,
  requestRematch,
  onLeave,
}: {
  room: Room;
  matchWinnerId: string | null;
  requestRematch: Props["requestRematch"];
  onLeave: () => void;
}) {
  return (
    <section className="flex flex-1 flex-col gap-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-center">
        <p className="text-xs tracking-wide text-slate-400 uppercase">Fim de jogo</p>
        <h2 className="mt-2 text-2xl font-bold">
          {finishedTitle(room, matchWinnerId)}
        </h2>
        <p className="mt-2 text-sm text-slate-400">{scoreLine(room)}</p>
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

function RoundHeader({
  match,
  room,
}: {
  match: Match;
  room: Room;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <p className="text-slate-300">
        Rodada {Math.min(match.roundIndex + 1, match.roundCount)}/{match.roundCount}
      </p>
      <p className="font-mono text-xs text-slate-400">{scoreLine(room)}</p>
    </div>
  );
}

function TurnCountdown({
  secondsLeft,
  isMyTurn,
}: {
  secondsLeft: number | null;
  isMyTurn: boolean;
}) {
  if (secondsLeft == null) return null;
  return (
    <p
      className={`text-center text-sm ${isMyTurn ? "text-amber-300" : "text-slate-400"}`}
    >
      {isMyTurn ? "Sua vez" : "Vez do oponente"} · {secondsLeft}s
    </p>
  );
}

function RoundResultReveal({
  result,
  youAre,
  myPokemon,
  myResult,
  revealedOpp,
  oppResult,
}: {
  result: RoundResult;
  youAre: string | null;
  myPokemon: PokemonView | undefined;
  myResult: SideResult | null;
  revealedOpp: PokemonView | undefined;
  oppResult: SideResult | null;
}) {
  return (
    <div className="rounded-2xl border border-emerald-900/50 bg-emerald-950/30 p-3 text-sm">
      <p className="font-medium text-emerald-200">
        {formatStat(result.stat)} · {roundOutcomeLabel(result, youAre)}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <PokemonCard pokemon={myPokemon} label={`Você (${myResult?.value})`} />
        <PokemonCard
          pokemon={revealedOpp}
          label={`Rival (${oppResult?.value})`}
        />
      </div>
    </div>
  );
}

function OpponentSlot({
  result,
  youAre,
  myPokemon,
  myResult,
  revealedOpp,
  oppResult,
}: {
  result: RoundResult | null;
  youAre: string | null;
  myPokemon: PokemonView | undefined;
  myResult: SideResult | null;
  revealedOpp: PokemonView | undefined;
  oppResult: SideResult | null;
}) {
  if (!result) {
    return <PokemonCard hidden label="Carta rival" />;
  }
  return (
    <RoundResultReveal
      result={result}
      youAre={youAre}
      myPokemon={myPokemon}
      myResult={myResult}
      revealedOpp={revealedOpp}
      oppResult={oppResult}
    />
  );
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
  const { mine: myResult, opponent: oppResult } = sidesFromResult(
    result,
    room.youAre,
  );
  const { data: revealedOpp } = usePokemon(oppResult?.cardId);

  const isMyTurn = Boolean(
    match.roundId && room.youAre && match.turnPlayerId === room.youAre,
  );
  const secondsLeft = useRoundSecondsLeft(match.deadlineMs, match.roundId);

  if (room.phase === "finished") {
    return (
      <MatchFinishedPanel
        room={room}
        matchWinnerId={match.matchWinnerId}
        requestRematch={requestRematch}
        onLeave={onLeave}
      />
    );
  }

  return (
    <section className="flex flex-1 flex-col gap-4">
      <RoundHeader match={match} room={room} />
      <TurnCountdown secondsLeft={secondsLeft} isMyTurn={isMyTurn} />

      <PokemonCard
        pokemon={myPokemon}
        loading={isLoading}
        label="Sua carta"
      />

      <OpponentSlot
        result={result}
        youAre={room.youAre}
        myPokemon={myPokemon}
        myResult={myResult}
        revealedOpp={revealedOpp}
        oppResult={oppResult}
      />

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
