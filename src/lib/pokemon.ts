import { GEN1_STATS } from "../../shared/gen1-stats";
import type { StatKey } from "../../shared/protocol";

export type PokemonView = {
  id: number;
  name: string;
  sprite: string;
  stats: Record<StatKey, number>;
};

type PokeApiPokemon = {
  id: number;
  name: string;
  sprites: {
    other?: {
      "official-artwork"?: { front_default?: string | null };
    };
    front_default?: string | null;
  };
  stats: Array<{ base_stat: number; stat: { name: string } }>;
};

export function pokemonQueryKey(id: number) {
  return ["pokemon", id] as const;
}

export async function fetchPokemon(id: number): Promise<PokemonView> {
  const seed = GEN1_STATS[id];
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
    if (!res.ok) throw new Error(`PokéAPI ${res.status}`);
    const data = (await res.json()) as PokeApiPokemon;
    const stats = {} as Record<StatKey, number>;
    for (const row of data.stats) {
      const key = row.stat.name as StatKey;
      stats[key] = row.base_stat;
    }
    return {
      id: data.id,
      name: data.name,
      sprite:
        data.sprites.other?.["official-artwork"]?.front_default ||
        data.sprites.front_default ||
        "",
      stats,
    };
  } catch {
    // Fallback offline/seed: stats locais, sprite oficial por CDN estático
    if (!seed) throw new Error(`Pokémon ${id} indisponível`);
    return {
      id: seed.id,
      name: seed.name,
      sprite: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`,
      stats: seed.stats,
    };
  }
}
