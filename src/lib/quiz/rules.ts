/**
 * Geschäftsregeln für Quiz und Fragen als reine Funktionen (ohne Datenbank), damit sie leicht testbar sind.
 *
 * Kernregeln aus der Spezifikation und den Entscheiden:
 * 1. Status: Entwurf, Bereit, Abgeschlossen. Ein abgeschlossenes Quiz ist archiviert: nicht mehr
 *    bearbeitbar und nicht mehr spielbar, bleibt aber mit seinen Resultaten einsehbar.
 * 2. Sobald ein Quiz eine Durchführung hat, wird es nicht mehr bearbeitet. Die Resultate beziehen sich
 *    auf genau diese Fragen. Wer etwas ändern will, dupliziert das Quiz.
 * 3. Ein Quiz kann nur Bereit werden, wenn es mindestens eine Frage hat und alle Fragen gültig sind.
 */
import { questionInputSchema, type QuestionType } from "./schema";

export type QuizStatus = "draft" | "ready" | "completed";

export const STATUS_LABELS: Record<QuizStatus, string> = {
  draft: "Entwurf",
  ready: "Bereit",
  completed: "Abgeschlossen",
};

export const TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: "Multiple Choice",
  estimate: "Schätzfrage",
  poll: "Umfrage",
};

export type Check = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: Check = { allowed: true };
const deny = (reason: string): Check => ({ allowed: false, reason });

/** Darf das Quiz (Titel, Fragen, Antworten) bearbeitet werden? */
export function checkEditable(quiz: { status: QuizStatus; sessionCount: number }): Check {
  if (quiz.status === "completed") {
    return deny("Das Quiz ist abgeschlossen und archiviert. Es kann nicht mehr bearbeitet werden. Sie können es duplizieren.");
  }
  if (quiz.sessionCount > 0) {
    return deny(
      "Dieses Quiz wurde bereits durchgeführt und kann nicht mehr bearbeitet werden. Duplizieren Sie es, um Änderungen vorzunehmen.",
    );
  }
  return ALLOWED;
}

/** Darf das Quiz gelöscht werden? Mit Durchführungen nicht, die Resultate bleiben erhalten. */
export function checkDeletable(quiz: { sessionCount: number }): Check {
  if (quiz.sessionCount > 0) {
    return deny("Ein Quiz mit Durchführungen kann nicht gelöscht werden. Sie können es abschliessen und archivieren.");
  }
  return ALLOWED;
}

export type StatusContext = { sessionCount: number; questionCount: number };

/** Prüft einen Statuswechsel. */
export function checkTransition(from: QuizStatus, to: QuizStatus, context: StatusContext): Check {
  if (from === "completed") return deny("Ein abgeschlossenes Quiz bleibt archiviert und kann nicht mehr verändert werden.");
  if (from === to) return deny("Das Quiz hat bereits diesen Status.");
  if (to === "ready" && context.questionCount < 1) return deny("Fügen Sie mindestens eine Frage hinzu, bevor das Quiz Bereit wird.");
  if (to === "draft" && context.sessionCount > 0) {
    return deny("Dieses Quiz wurde bereits durchgeführt und kann nicht in den Entwurf zurück.");
  }
  return ALLOWED;
}

/** Mögliche Statuswechsel für die Bedienelemente, mit Begründung bei gesperrten. */
export function statusOptions(
  from: QuizStatus,
  context: StatusContext,
): { to: QuizStatus; check: Check }[] {
  const targets: QuizStatus[] = (["draft", "ready", "completed"] as const).filter((status) => status !== from);
  return from === "completed" ? [] : targets.map((to) => ({ to, check: checkTransition(from, to, context) }));
}

/** Kann das Quiz gespielt werden? Nur im Status Bereit. */
export function isPlayable(status: QuizStatus): boolean {
  return status === "ready";
}

/** Verschiebt ein Element um eine Position. Gibt null zurück, wenn es am Rand steht und nicht weiter kann. */
export function moveInOrder<T>(items: readonly T[], index: number, direction: "up" | "down"): T[] | null {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return null;
  const result = [...items];
  const moved = result[index] as T;
  result[index] = result[target] as T;
  result[target] = moved;
  return result;
}

/** Frage in der Form, wie sie aus der Datenbank kommt. */
export type StoredQuestion = {
  type: QuestionType;
  prompt: string;
  timeLimitSeconds: number;
  maxPoints: number;
  correctValue: number | null;
  unit: string | null;
  tolerance: number | null;
  options: { text: string; isCorrect: boolean }[];
};

/** Wandelt eine gespeicherte Frage in die Eingabeform für die Prüfung. */
export function toFormInput(question: StoredQuestion) {
  if (question.type === "estimate") {
    return {
      type: "estimate" as const,
      prompt: question.prompt,
      timeLimitSeconds: question.timeLimitSeconds,
      maxPoints: question.maxPoints,
      correctValue: question.correctValue ?? Number.NaN,
      unit: question.unit ?? "",
      tolerance: question.tolerance ?? Number.NaN,
    };
  }
  if (question.type === "poll") {
    return {
      type: "poll" as const,
      prompt: question.prompt,
      timeLimitSeconds: question.timeLimitSeconds,
      options: question.options,
    };
  }
  return {
    type: "multiple_choice" as const,
    prompt: question.prompt,
    timeLimitSeconds: question.timeLimitSeconds,
    maxPoints: question.maxPoints,
    options: question.options,
  };
}

/**
 * Prüft, ob ein Quiz spielbar ist. Liefert eine Liste von Problemen, leer bedeutet in Ordnung.
 * Auch gespeicherte Fragen werden erneut geprüft, falls jemand die Datenbank von Hand verändert hat.
 */
export function validateReadyToPlay(questions: readonly StoredQuestion[]): string[] {
  if (questions.length === 0) return ["Das Quiz hat keine Fragen."];
  const problems: string[] = [];
  questions.forEach((question, index) => {
    const result = questionInputSchema.safeParse(toFormInput(question));
    if (!result.success) {
      for (const issue of new Set(result.error.issues.map((item) => item.message))) {
        problems.push(`Frage ${index + 1}: ${issue}`);
      }
    }
  });
  return problems;
}
