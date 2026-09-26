import { STAT_KEYS, type StatKey } from "../../shared/protocol";

const LABELS: Record<StatKey, string> = {
  hp: "HP",
  attack: "Ataque",
  defense: "Defesa",
  "special-attack": "Sp. Atk",
  "special-defense": "Sp. Def",
  speed: "Speed",
};

type Props = {
  stats: Record<StatKey, number> | undefined;
  disabled: boolean;
  onSelect: (stat: StatKey) => void;
};

export function StatButtons({ stats, disabled, onSelect }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {STAT_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          disabled={disabled || !stats}
          onClick={() => onSelect(key)}
          className="flex min-h-12 items-center justify-between rounded-xl border border-slate-700 bg-slate-900 px-3 text-left text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span>{LABELS[key]}</span>
          <span className="font-mono text-amber-300">{stats?.[key] ?? "—"}</span>
        </button>
      ))}
    </div>
  );
}
