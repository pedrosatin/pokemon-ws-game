import type { ConnectionStatus } from "../hooks/useGameSocket";

type Props = {
  status: ConnectionStatus;
};

export function ConnectionBanner({ status }: Props) {
  if (status !== "reconnecting" && status !== "connecting") return null;

  return (
    <div
      role="status"
      className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center text-sm text-amber-100"
    >
      {status === "reconnecting"
        ? "Conexão caída. Reconectando e sincronizando a partida…"
        : "Abrindo sala…"}
    </div>
  );
}
