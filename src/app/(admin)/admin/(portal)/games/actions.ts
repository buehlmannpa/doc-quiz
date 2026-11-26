"use server";

/**
 * Server Actions für Durchführungen. Wie bei der Quizverwaltung prüft jede Action zuerst die Anmeldung und behandelt
 * alle Argumente als unvertrauenswürdig.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { cancelGame, createGame } from "@/lib/game/lifecycle";
import { getSessionRepository } from "@/lib/game/sessions";
import { getEngine, getGameStore } from "@/lib/realtime/instance";

export type GameFormState = { error: string } | null;
export type SimpleResult = { ok: true } | { ok: false; error: string };

const idSchema = z.uuid({ error: "Ungültige Kennung." });
const codeSchema = z.string().regex(/^\d{6}$/, "Ungültiger Spielcode.");

const UNEXPECTED = "Es ist ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut.";

function logError(error: unknown): void {
  // Nur die Meldung protokollieren, nie das ganze Objekt (könnte Verbindungsdaten enthalten).
  console.error("[game] Unerwarteter Fehler:", error instanceof Error ? error.message : String(error));
}

/** Legt eine Durchführung an und öffnet die Steuerung. */
export async function startGameAction(_previous: GameFormState, formData: FormData): Promise<GameFormState> {
  await requireAdmin();
  const quizId = idSchema.safeParse(formData.get("quizId"));
  if (!quizId.success) return { error: "Bitte wählen Sie ein Quiz." };

  let code: string;
  try {
    const result = await createGame({ sessions: getSessionRepository(), store: getGameStore() }, quizId.data);
    if (!result.ok) return { error: result.message };
    code = result.code;
  } catch (error) {
    logError(error);
    return { error: UNEXPECTED };
  }
  revalidatePath("/admin/games");
  // redirect() wirft absichtlich und steht deshalb ausserhalb von try und catch.
  redirect(`/admin/games/${code}`);
}

/** Bricht eine Durchführung ab, auch wenn das Spiel in Redis schon abgelaufen ist. */
export async function cancelGameAction(code: string): Promise<SimpleResult> {
  await requireAdmin();
  const parsed = codeSchema.safeParse(code);
  if (!parsed.success) return { ok: false, error: "Ungültiger Spielcode." };
  try {
    const result = await cancelGame({ engine: getEngine(), sessions: getSessionRepository() }, parsed.data);
    revalidatePath("/admin/games");
    revalidatePath(`/admin/games/${parsed.data}`);
    revalidatePath("/admin/results");
    return result.ok ? { ok: true } : { ok: false, error: result.message };
  } catch (error) {
    logError(error);
    return { ok: false, error: UNEXPECTED };
  }
}

/** Speichert die Resultate eines beendeten Spiels erneut (zum Beispiel nach einem Datenbankfehler). */
export async function retrySaveAction(code: string): Promise<SimpleResult> {
  await requireAdmin();
  const parsed = codeSchema.safeParse(code);
  if (!parsed.success) return { ok: false, error: "Ungültiger Spielcode." };
  try {
    const saved = await getEngine().persist(parsed.data);
    revalidatePath("/admin/games");
    revalidatePath(`/admin/games/${parsed.data}`);
    revalidatePath("/admin/results");
    return saved
      ? { ok: true }
      : { ok: false, error: "Die Resultate konnten nicht gespeichert werden. Bitte prüfen Sie die Datenbank unter System." };
  } catch (error) {
    logError(error);
    return { ok: false, error: UNEXPECTED };
  }
}
