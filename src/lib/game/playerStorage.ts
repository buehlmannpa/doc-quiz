/**
 * Das Token eines Spielers liegt nur im Browser (localStorage). Der Zugriff kann fehlschlagen (privates Fenster,
 * gesperrter Speicher), deshalb ist jeder Aufruf abgesichert und die Seite funktioniert auch ohne.
 */
export type StoredPlayer = { token: string; playerId: string; name: string; avatar: number };

const key = (code: string) => `doc-quiz:player:${code}`;

export function loadPlayer(code: string): StoredPlayer | null {
  try {
    const raw = window.localStorage.getItem(key(code));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredPlayer> | null;
    if (
      value &&
      typeof value.token === "string" &&
      typeof value.playerId === "string" &&
      typeof value.name === "string" &&
      typeof value.avatar === "number"
    ) {
      return { token: value.token, playerId: value.playerId, name: value.name, avatar: value.avatar };
    }
  } catch {
    // Nicht lesbar oder kein Zugriff: so tun, als gäbe es nichts.
  }
  return null;
}

export function savePlayer(code: string, player: StoredPlayer): boolean {
  try {
    window.localStorage.setItem(key(code), JSON.stringify(player));
    return true;
  } catch {
    return false;
  }
}

export function clearPlayer(code: string): void {
  try {
    window.localStorage.removeItem(key(code));
  } catch {
    // Nichts zu tun.
  }
}

const snapshots = new Map<string, { raw: string | null; player: StoredPlayer | null }>();

/**
 * Stabiler Schnappschuss für useSyncExternalStore: Solange der gespeicherte Text gleich bleibt, kommt dasselbe
 * Objekt zurück. Sonst würde React bei jedem Vergleich eine Änderung sehen.
 */
export function getPlayerSnapshot(code: string): StoredPlayer | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key(code));
  } catch {
    raw = null;
  }
  const cached = snapshots.get(code);
  if (cached && cached.raw === raw) return cached.player;
  const player = raw === null ? null : loadPlayer(code);
  snapshots.set(code, { raw, player });
  return player;
}

export function subscribePlayer(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}
