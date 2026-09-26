import { describe, expect, it } from "vitest";
import { compareRound, dealDecks, highestStat, statValue } from "./game";

describe("statValue", () => {
  it("reads gen1 seed for bulbasaur hp", () => {
    expect(statValue(1, "hp")).toBe(45);
  });
});

describe("highestStat", () => {
  it("picks the max base stat on mewtwo", () => {
    // mewtwo id 150: special-attack 154
    expect(highestStat(150)).toBe("special-attack");
  });
});

describe("compareRound", () => {
  it("awards p1 when higher", () => {
    const result = compareRound(25, 1, "speed"); // pikachu vs bulbasaur
    expect(result.winner).toBe("p1");
    expect(result.p1Val).toBeGreaterThan(result.p2Val);
  });

  it("returns null winner on equal values", () => {
    const result = compareRound(1, 1, "hp");
    expect(result.winner).toBeNull();
    expect(result.p1Val).toBe(result.p2Val);
  });
});

describe("dealDecks", () => {
  it("deals disjoint decks of the requested size", () => {
    const decks = dealDecks(["a", "b"], 5, 151, () => 0.42);
    expect(decks.a).toHaveLength(5);
    expect(decks.b).toHaveLength(5);
    const set = new Set([...decks.a, ...decks.b]);
    expect(set.size).toBe(10);
  });
});
