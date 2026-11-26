"use server";

/**
 * Server Actions der Quizverwaltung.
 *
 * Jede Action prüft zuerst die Anmeldung (requireAdmin) und behandelt alle Argumente als unvertrauenswürdig:
 * Kennungen und Eingaben werden mit Zod geprüft, auch wenn sie aus unserem eigenen Formular stammen.
 * Fachliche Fehler (zum Beispiel "Quiz ist gesperrt") kommen als lesbare Meldung zurück.
 * Unerwartete Fehler werden protokolliert und dem Admin ohne technische Einzelheiten gezeigt.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { getQuizRepository, QuizError } from "@/lib/quiz/repository";
import type { QuizStatus } from "@/lib/quiz/rules";
import { issueMessages, questionInputSchema, quizMetaSchema } from "@/lib/quiz/schema";

export type ActionResult = { ok: true } | { ok: false; errors: string[] };
/** Zustand eines Formulars: Fehlermeldungen und ob zuletzt erfolgreich gespeichert wurde. */
export type FormState = { errors: string[]; saved: boolean } | null;

const idSchema = z.uuid({ error: "Ungültige Kennung." });
const statusSchema = z.enum(["draft", "ready", "completed"]);
const directionSchema = z.enum(["up", "down"]);

const UNEXPECTED = "Es ist ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut.";

function toErrors(error: unknown): string[] {
  if (error instanceof QuizError) return [error.message];
  // Nur die Meldung protokollieren, nie das ganze Objekt (könnte Verbindungsdaten enthalten).
  console.error("[quiz] Unerwarteter Fehler:", error instanceof Error ? error.message : String(error));
  return [UNEXPECTED];
}

function refresh(quizId?: string): void {
  revalidatePath("/admin/quizzes");
  if (quizId) revalidatePath(`/admin/quizzes/${quizId}`);
}

/** Legt ein Quiz an und öffnet es. */
export async function createQuizAction(_previous: FormState, formData: FormData): Promise<FormState> {
  await requireAdmin();
  const parsed = quizMetaSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
  });
  if (!parsed.success) return { errors: issueMessages(parsed.error), saved: false };

  let id: string;
  try {
    ({ id } = await getQuizRepository().createQuiz(parsed.data));
  } catch (error) {
    return { errors: toErrors(error), saved: false };
  }
  refresh();
  // redirect() wirft absichtlich und steht deshalb ausserhalb von try und catch.
  redirect(`/admin/quizzes/${id}`);
}

/** Speichert Titel und Beschreibung. */
export async function updateQuizMetaAction(
  quizId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();
  const id = idSchema.safeParse(quizId);
  if (!id.success) return { errors: ["Ungültige Kennung."], saved: false };
  const parsed = quizMetaSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
  });
  if (!parsed.success) return { errors: issueMessages(parsed.error), saved: false };

  try {
    await getQuizRepository().updateQuizMeta(id.data, parsed.data);
  } catch (error) {
    return { errors: toErrors(error), saved: false };
  }
  refresh(id.data);
  return { errors: [], saved: true };
}

/** Wechselt den Status (Entwurf, Bereit, Abgeschlossen). */
export async function setQuizStatusAction(quizId: string, target: QuizStatus): Promise<ActionResult> {
  await requireAdmin();
  const id = idSchema.safeParse(quizId);
  const status = statusSchema.safeParse(target);
  if (!id.success || !status.success) return { ok: false, errors: ["Ungültige Eingabe."] };
  try {
    await getQuizRepository().setStatus(id.data, status.data);
  } catch (error) {
    return { ok: false, errors: toErrors(error) };
  }
  refresh(id.data);
  return { ok: true };
}

/** Löscht ein Quiz ohne Durchführung. */
export async function deleteQuizAction(quizId: string): Promise<ActionResult> {
  await requireAdmin();
  const id = idSchema.safeParse(quizId);
  if (!id.success) return { ok: false, errors: ["Ungültige Kennung."] };
  try {
    await getQuizRepository().deleteQuiz(id.data);
  } catch (error) {
    return { ok: false, errors: toErrors(error) };
  }
  refresh();
  redirect("/admin/quizzes");
}

/** Kopiert ein Quiz als neuen Entwurf und öffnet die Kopie. */
export async function duplicateQuizAction(quizId: string): Promise<ActionResult> {
  await requireAdmin();
  const id = idSchema.safeParse(quizId);
  if (!id.success) return { ok: false, errors: ["Ungültige Kennung."] };
  let copyId: string;
  try {
    ({ id: copyId } = await getQuizRepository().duplicateQuiz(id.data));
  } catch (error) {
    return { ok: false, errors: toErrors(error) };
  }
  refresh();
  redirect(`/admin/quizzes/${copyId}`);
}

/** Legt eine Frage an (questionId ist null) oder ersetzt eine bestehende. Die Eingabe wird hier verbindlich geprüft. */
export async function saveQuestionAction(
  quizId: string,
  questionId: string | null,
  input: unknown,
): Promise<ActionResult> {
  await requireAdmin();
  const quiz = idSchema.safeParse(quizId);
  const question = questionId === null ? { success: true as const, data: null } : idSchema.safeParse(questionId);
  if (!quiz.success || !question.success) return { ok: false, errors: ["Ungültige Kennung."] };

  const parsed = questionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: issueMessages(parsed.error) };

  try {
    await getQuizRepository().saveQuestion(quiz.data, question.data, parsed.data);
  } catch (error) {
    return { ok: false, errors: toErrors(error) };
  }
  refresh(quiz.data);
  return { ok: true };
}

export async function deleteQuestionAction(quizId: string, questionId: string): Promise<ActionResult> {
  await requireAdmin();
  const quiz = idSchema.safeParse(quizId);
  const question = idSchema.safeParse(questionId);
  if (!quiz.success || !question.success) return { ok: false, errors: ["Ungültige Kennung."] };
  try {
    await getQuizRepository().deleteQuestion(quiz.data, question.data);
  } catch (error) {
    return { ok: false, errors: toErrors(error) };
  }
  refresh(quiz.data);
  return { ok: true };
}

export async function moveQuestionAction(
  quizId: string,
  questionId: string,
  direction: "up" | "down",
): Promise<ActionResult> {
  await requireAdmin();
  const quiz = idSchema.safeParse(quizId);
  const question = idSchema.safeParse(questionId);
  const dir = directionSchema.safeParse(direction);
  if (!quiz.success || !question.success || !dir.success) return { ok: false, errors: ["Ungültige Eingabe."] };
  try {
    await getQuizRepository().moveQuestion(quiz.data, question.data, dir.data);
  } catch (error) {
    return { ok: false, errors: toErrors(error) };
  }
  refresh(quiz.data);
  return { ok: true };
}
