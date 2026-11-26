/**
 * Lebenslauf einer Durchführung aus Sicht des Adminportals: anlegen, abbrechen, Resultate erneut speichern.
 *
 * Anlegen berührt Neon und Redis. Die Reihenfolge ist so gewählt, dass nie ein halbes Spiel zurückbleibt:
 * 1. Zuerst die Durchführung in Neon (prüft Status, Eindeutigkeit und liefert den Snapshot).
 * 2. Dann das Spiel in Redis. Ist der Code dort noch belegt (ein altes Spiel lebt bis zu 6 Stunden weiter), wird die
 *    Durchführung wieder abgebrochen und ein neuer Code gewählt. Schlägt Redis ganz fehl, wird ebenfalls abgebrochen.
 */
import { randomInt } from "node:crypto";
import type { GameEngine } from "./engine";
import { SessionError, type SessionRepository } from "./sessions";
import type { GameStore } from "@/lib/realtime/store";

/** Echte Spiele nutzen die Codes 100000 bis 899999, das Verbindungslabor 900000 bis 999999. */
export function generateGameCode(random: (min: number, max: number) => number = randomInt): string {
  return String(random(100_000, 900_000));
}

export type CreateGameResult = { ok: true; code: string; sessionId: string } | { ok: false; message: string };

export async function createGame(
  deps: { sessions: SessionRepository; store: GameStore; generateCode?: () => string },
  quizId: string,
): Promise<CreateGameResult> {
  const generate = deps.generateCode ?? generateGameCode;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generate();
    let created: Awaited<ReturnType<SessionRepository["createSession"]>>;
    try {
      created = await deps.sessions.createSession(quizId, code);
    } catch (error) {
      if (error instanceof SessionError && error.code === "code_taken") continue;
      if (error instanceof SessionError) return { ok: false, message: error.message };
      throw error;
    }

    let freeInRedis = false;
    try {
      freeInRedis = await deps.store.createGame(code, created.snapshot);
    } catch (error) {
      await deps.sessions.markCancelled(code);
      console.error("[game] Redis nicht erreichbar:", error instanceof Error ? error.message : String(error));
      return { ok: false, message: "Das Spiel konnte nicht angelegt werden, weil Redis nicht erreichbar ist." };
    }
    if (freeInRedis) return { ok: true, code, sessionId: created.sessionId };
    // Der Code ist in Redis noch von einem früheren Spiel belegt. Neuen Code versuchen.
    await deps.sessions.markCancelled(code);
  }
  return { ok: false, message: "Es konnte kein freier Spielcode gefunden werden. Bitte versuchen Sie es noch einmal." };
}

export type CancelGameResult = { ok: true } | { ok: false; message: string };

/**
 * Bricht eine Durchführung ab. Lebt das Spiel noch in Redis, führt die Engine den Abbruch aus (und meldet ihn an
 * Neon). Ist es dort nicht mehr vorhanden (zum Beispiel nach 6 Stunden), wird nur der Eintrag in Neon abgeschlossen.
 * Ein Spiel mit Siegerbildschirm ist nicht mehr abbrechbar, seine Resultate sind fertig.
 */
export async function cancelGame(
  deps: { engine: GameEngine; sessions: SessionRepository },
  code: string,
): Promise<CancelGameResult> {
  const result = await deps.engine.abort(code);
  if (result.ok) return { ok: true };
  if (result.reason === "not_found") {
    await deps.sessions.markCancelled(code);
    return { ok: true };
  }
  return { ok: false, message: "Das Spiel ist bereits beendet und kann nicht mehr abgebrochen werden." };
}
