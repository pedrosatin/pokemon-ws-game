const STORAGE_KEY = "trunfo-stats:clientId";

export function getOrCreateClientId(): string {
  const existing = sessionStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem(STORAGE_KEY, id);
  return id;
}
