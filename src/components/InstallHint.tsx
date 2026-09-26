import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallHint() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!deferred || hidden) return null;

  return (
    <div className="mb-3 flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm">
      <p className="flex-1 text-slate-300">Instale no celular para jogar em tela cheia.</p>
      <button
        type="button"
        className="min-h-10 rounded-lg bg-amber-400 px-3 font-semibold text-slate-950"
        onClick={() => {
          void deferred.prompt().then(async () => {
            await deferred.userChoice;
            setDeferred(null);
          });
        }}
      >
        Instalar
      </button>
      <button
        type="button"
        className="min-h-10 px-2 text-slate-400"
        onClick={() => setHidden(true)}
        aria-label="Dispensar"
      >
        ×
      </button>
    </div>
  );
}
