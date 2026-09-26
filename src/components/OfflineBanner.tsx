import { useEffect, useState } from "react";

export function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="alert"
      className="mb-3 rounded-xl border border-red-500/40 bg-red-950/50 px-3 py-2 text-center text-sm text-red-100"
    >
      Sem rede. O lobby pode abrir offline, mas a partida precisa de WebSocket.
    </div>
  );
}
