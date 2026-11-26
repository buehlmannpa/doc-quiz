/**
 * Quiz Snapshot: die Kopie des Quiz, die beim Spielstart nach Redis geladen wird. Während des Spiels wird Neon
 * nicht mehr gelesen. Der Snapshot enthält die richtigen Antworten und bleibt deshalb auf dem Server. Clients
 * bekommen nur PublicQuestion (ohne Angabe der richtigen Antwort).
 */
import { z } from "zod";
import type { PublicQuestion } from "@/lib/realtime/game-state";
import { QUESTION_TYPES } from "@/lib/quiz/schema";

export const snapshotQuestionSchema = z.object({
  id: z.string(),
  type: z.enum(QUESTION_TYPES),
  prompt: z.string(),
  timeLimitSeconds: z.number().int().min(1),
  maxPoints: z.number().int().min(0),
  options: z.array(z.object({ id: z.string(), text: z.string(), isCorrect: z.boolean() })).max(4),
  correctValue: z.number().nullable(),
  unit: z.string().nullable(),
  tolerance: z.number().nullable(),
});
export type SnapshotQuestion = z.infer<typeof snapshotQuestionSchema>;

export const gameQuizSchema = z.object({
  quizId: z.string(),
  title: z.string(),
  questions: z.array(snapshotQuestionSchema).min(1).max(50),
});
export type GameQuiz = z.infer<typeof gameQuizSchema>;

/** Eingabe für den Snapshot: so viel von einem Quiz aus der Datenbank wird gebraucht. */
export type SnapshotSource = {
  quiz: { id: string; title: string };
  questions: {
    id: string;
    type: SnapshotQuestion["type"];
    prompt: string;
    timeLimitSeconds: number;
    maxPoints: number;
    correctValue: number | null;
    unit: string | null;
    tolerance: number | null;
    options: { id: string; position: number; text: string; isCorrect: boolean }[];
  }[];
};

/** Baut den Snapshot. Fragen und Antworten stehen in der Reihenfolge ihrer Position. */
export function buildSnapshot(source: SnapshotSource): GameQuiz {
  return gameQuizSchema.parse({
    quizId: source.quiz.id,
    title: source.quiz.title,
    questions: source.questions.map((question) => ({
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      timeLimitSeconds: question.timeLimitSeconds,
      maxPoints: question.maxPoints,
      options: [...question.options]
        .sort((a, b) => a.position - b.position)
        .map((option) => ({ id: option.id, text: option.text, isCorrect: option.isCorrect })),
      correctValue: question.correctValue,
      unit: question.unit,
      tolerance: question.tolerance,
    })),
  });
}

/** Die Frage, wie alle Clients sie sehen dürfen. */
export function toPublicQuestion(
  question: SnapshotQuestion,
  index: number,
  total: number,
  startedAt: number,
): PublicQuestion {
  return {
    index,
    total,
    type: question.type,
    prompt: question.prompt,
    timeLimitSeconds: question.timeLimitSeconds,
    maxPoints: question.maxPoints,
    options: question.options.map((option, position) => ({ index: position, text: option.text })),
    unit: question.type === "estimate" ? question.unit : null,
    startedAt,
    deadline: startedAt + question.timeLimitSeconds * 1000,
  };
}
