import type { PokemonView } from "../lib/pokemon";

type Props = {
  pokemon?: PokemonView | undefined;
  loading?: boolean;
  hidden?: boolean;
  label?: string;
};

export function PokemonCard({ pokemon, loading, hidden, label }: Props) {
  return (
    <article className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80">
      {label ? (
        <p className="border-b border-slate-800 px-3 py-2 text-xs font-medium tracking-wide text-slate-400 uppercase">
          {label}
        </p>
      ) : null}
      <div className="flex flex-col items-center gap-2 p-4">
        <div className="flex h-36 w-36 items-center justify-center rounded-xl bg-slate-950">
          {hidden ? (
            <span className="text-5xl text-slate-600">?</span>
          ) : loading ? (
            <span className="text-sm text-slate-500">Carregando…</span>
          ) : pokemon?.sprite ? (
            <img
              src={pokemon.sprite}
              alt={pokemon.name}
              className="h-32 w-32 object-contain"
              decoding="async"
            />
          ) : (
            <span className="text-sm text-slate-500">Sem arte</span>
          )}
        </div>
        <h3 className="text-lg font-semibold capitalize">
          {hidden ? "Oculto" : (pokemon?.name ?? "—")}
        </h3>
      </div>
    </article>
  );
}
