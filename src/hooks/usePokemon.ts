import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { fetchPokemon, pokemonQueryKey } from "../lib/pokemon";

export function usePokemon(id: number | null | undefined) {
  return useQuery({
    queryKey: pokemonQueryKey(id ?? 0),
    queryFn: () => fetchPokemon(id!),
    enabled: typeof id === "number" && id > 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 1000 * 60 * 60 * 24,
  });
}

/** Prefetch the whole dealt deck as soon as DEAL arrives. */
export function usePrefetchDeck(deck: number[]) {
  const queryClient = useQueryClient();
  useEffect(() => {
    for (const id of deck) {
      void queryClient.prefetchQuery({
        queryKey: pokemonQueryKey(id),
        queryFn: () => fetchPokemon(id),
        staleTime: Number.POSITIVE_INFINITY,
      });
    }
  }, [deck, queryClient]);
}
