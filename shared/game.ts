import { STAT_KEYS, type StatKey } from "./protocol";
import { GEN1_STATS } from "./gen1-stats";

export function statValue(cardId: number, stat: StatKey): number {
  return GEN1_STATS[cardId]?.stats[stat] ?? 0;
}

export function highestStat(cardId: number): StatKey {
  let best: StatKey = "hp";
  let bestVal = -1;
  for (const key of STAT_KEYS) {
    const val = statValue(cardId, key);
    if (val > bestVal) {
      bestVal = val;
      best = key;
    }
  }
  return best;
}

export function compareRound(
  p1Card: number,
  p2Card: number,
  stat: StatKey,
): { p1Val: number; p2Val: number; winner: "p1" | "p2" | null } {
  const p1Val = statValue(p1Card, stat);
  const p2Val = statValue(p2Card, stat);
  if (p1Val > p2Val) return { p1Val, p2Val, winner: "p1" };
  if (p2Val > p1Val) return { p1Val, p2Val, winner: "p2" };
  return { p1Val, p2Val, winner: null };
}

export function shuffleInPlace<T>(arr: T[], random = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function dealDecks(
  playerIds: [string, string],
  deckSize: number,
  maxId: number,
  random = Math.random,
): Record<string, number[]> {
  const pool = shuffleInPlace(
    Array.from({ length: maxId }, (_, i) => i + 1),
    random,
  );
  return {
    [playerIds[0]]: pool.slice(0, deckSize),
    [playerIds[1]]: pool.slice(deckSize, deckSize * 2),
  };
}
