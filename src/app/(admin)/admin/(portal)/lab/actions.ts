"use server";

/**
 * Server Actions des Verbindungslabors. Sie legen ein Testspiel im Bereich 9xxxxx an, nehmen simulierte
 * Teilnehmende auf und verändern den Zustand. Echte Spiele (100000 bis 899999) werden nie berührt.
 * Alle Actions prüfen die Anmeldung.
 */
import { requireAdmin } from "@/lib/auth/session";
import { describeError } from "@/lib/health";
import { AVATAR_COUNT } from "@/lib/realtime/game-state";
import { getGameStore } from "@/lib/realtime/instance";
import { isLabCode, randomLabCode } from "@/lib/realtime/lab-metrics";

export type LabResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export type LabPlayerCredentials = { index: number; name: string; token: string };

const MAX_PLAYERS_PER_CALL = 20;

export async function createLabGameAction(): Promise<LabResult<{ code: string; publishMode: string }>> {
  await requireAdmin();
  try {
    const store = getGameStore();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = randomLabCode();
      if (await store.createGame(code)) return { ok: true, code, publishMode: store.publishMode };
    }
    return { ok: false, error: "Es konnte kein freier Testcode gefunden werden." };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** Nimmt count Testspieler ab dem Index from auf. Die Tokens gehen an den Browser, der damit die Verbindungen aufbaut. */
export async function joinLabPlayersAction(
  code: string,
  from: number,
  count: number,
): Promise<LabResult<{ players: LabPlayerCredentials[] }>> {
  await requireAdmin();
  if (!isLabCode(code) || !Number.isInteger(from) || !Number.isInteger(count) || from < 0 || count < 1 || count > MAX_PLAYERS_PER_CALL) {
    return { ok: false, error: "Ungültige Eingabe." };
  }
  try {
    const store = getGameStore();
    const players: LabPlayerCredentials[] = [];
    // Nicht alle gleichzeitig: Das schont die Datenbank und bildet realistischere Beitritte nach.
    const results = await Promise.all(
      Array.from({ length: count }, (_, offset) => {
        const index = from + offset;
        return store.joinPlayer(code, { name: `Test ${String(index + 1).padStart(2, "0")}`, avatar: index % AVATAR_COUNT });
      }),
    );
    for (const [offset, result] of results.entries()) {
      if (!result.ok) return { ok: false, error: `Beitritt ${from + offset + 1} fehlgeschlagen: ${result.reason}` };
      players.push({ index: from + offset, name: result.player.name, token: result.token });
    }
    return { ok: true, players };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** Erhöht die Version und veröffentlicht den Zustand. Liefert die Serverzeit der Veröffentlichung für die Messung. */
export async function touchLabGameAction(
  code: string,
): Promise<LabResult<{ version: number; sentServerTime: number }>> {
  await requireAdmin();
  if (!isLabCode(code)) return { ok: false, error: "Ungültiger Testcode." };
  try {
    const outcome = await getGameStore().touch(code);
    if (!outcome.ok) return { ok: false, error: outcome.reason === "busy" ? "Redis ist ausgelastet." : "Das Testspiel gibt es nicht mehr." };
    return { ok: true, version: outcome.state.version, sentServerTime: Date.now() };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export async function deleteLabGameAction(code: string): Promise<LabResult<Record<never, never>>> {
  await requireAdmin();
  if (!isLabCode(code)) return { ok: false, error: "Ungültiger Testcode." };
  try {
    await getGameStore().deleteGame(code);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
