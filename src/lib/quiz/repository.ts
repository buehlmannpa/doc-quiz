/**
 * Datenbankzugriff für Quizzes und Fragen (Neon, Drizzle).
 *
 * Jede ändernde Operation läuft in einer Transaktion und sperrt zuerst die Zeile des Quiz (FOR UPDATE).
 * Das hat zwei Gründe:
 * 1. Zwei gleichzeitige Änderungen am selben Quiz (zum Beispiel zwei offene Browser Fenster) werden
 *    nacheinander ausgeführt, die Positionen der Fragen bleiben lückenlos und eindeutig.
 * 2. Die Prüfung "wurde das Quiz schon durchgeführt?" und die Änderung geschehen atomar. Der Start einer
 *    Durchführung (Meilenstein 4) muss dieselbe Zeile sperren, dann kann zwischen Prüfung und Änderung
 *    keine Durchführung entstehen.
 */
import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  answerOptions,
  gameSessions,
  questions,
  quizzes,
  type AnswerOption,
  type Question,
  type Quiz,
} from "@/lib/db/schema";
import {
  checkDeletable,
  checkEditable,
  checkTransition,
  moveInOrder,
  validateReadyToPlay,
  type Check,
  type QuizStatus,
  type StoredQuestion,
} from "./rules";
import { LIMITS, type QuestionInput, type QuizMetaInput } from "./schema";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export type QuizErrorCode = "not_found" | "forbidden" | "invalid";

/** Fehler mit einer Meldung, die der Admin lesen darf. */
export class QuizError extends Error {
  constructor(
    public readonly code: QuizErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QuizError";
  }
}

export type QuestionWithOptions = Question & { options: AnswerOption[] };
export type QuizSummary = Quiz & { questionCount: number; sessionCount: number };
export type QuizDetail = { quiz: Quiz; questions: QuestionWithOptions[]; sessionCount: number };

function assertAllowed(check: Check): void {
  if (!check.allowed) throw new QuizError("forbidden", check.reason);
}

/** Sperrt die Zeile des Quiz bis zum Ende der Transaktion. */
async function lockQuiz(tx: Tx, quizId: string): Promise<Quiz> {
  const [quiz] = await tx.select().from(quizzes).where(eq(quizzes.id, quizId)).for("update");
  if (!quiz) throw new QuizError("not_found", "Das Quiz wurde nicht gefunden.");
  return quiz;
}

async function countSessions(executor: Executor, quizId: string): Promise<number> {
  const [row] = await executor.select({ n: count() }).from(gameSessions).where(eq(gameSessions.quizId, quizId));
  return row?.n ?? 0;
}

/** Fragen mit ihren Antworten, in der Reihenfolge des Quiz. */
export async function loadQuestions(executor: Executor, quizId: string): Promise<QuestionWithOptions[]> {
  const rows = await executor
    .select()
    .from(questions)
    .where(eq(questions.quizId, quizId))
    .orderBy(asc(questions.position), asc(questions.id));
  if (rows.length === 0) return [];
  const options = await executor
    .select()
    .from(answerOptions)
    .where(
      inArray(
        answerOptions.questionId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(answerOptions.position));
  return rows.map((row) => ({ ...row, options: options.filter((option) => option.questionId === row.id) }));
}

export function toStoredQuestion(question: QuestionWithOptions): StoredQuestion {
  return {
    type: question.type,
    prompt: question.prompt,
    timeLimitSeconds: question.timeLimitSeconds,
    maxPoints: question.maxPoints,
    correctValue: question.correctValue,
    unit: question.unit,
    tolerance: question.tolerance,
    options: question.options.map((option) => ({ text: option.text, isCorrect: option.isCorrect })),
  };
}

/** Spalten einer Frage aus der geprüften Eingabe. Felder anderer Typen werden bewusst auf null gesetzt. */
function questionColumns(input: QuestionInput) {
  return {
    type: input.type,
    prompt: input.prompt,
    timeLimitSeconds: input.timeLimitSeconds,
    maxPoints: input.type === "poll" ? 0 : input.maxPoints,
    correctValue: input.type === "estimate" ? input.correctValue : null,
    unit: input.type === "estimate" && input.unit !== "" ? input.unit : null,
    tolerance: input.type === "estimate" ? input.tolerance : null,
  };
}

/** Schreibt die Positionen 0, 1, 2 ... in der übergebenen Reihenfolge, nur wo sich etwas ändert. */
async function rewritePositions(tx: Tx, quizId: string, orderedIds: readonly string[]): Promise<void> {
  const current = await tx
    .select({ id: questions.id, position: questions.position })
    .from(questions)
    .where(eq(questions.quizId, quizId));
  const byId = new Map(current.map((row) => [row.id, row.position]));
  for (const [index, id] of orderedIds.entries()) {
    if (byId.get(id) !== index) await tx.update(questions).set({ position: index }).where(eq(questions.id, id));
  }
}

export function createQuizRepository(db: Db) {
  return {
    /** Alle Quizzes, zuletzt geänderte zuerst, mit Anzahl Fragen und Durchführungen. */
    async listQuizzes(): Promise<QuizSummary[]> {
      // Drei einfache Abfragen statt Unterabfragen: Drizzle lässt bei einer einzelnen Tabelle den
      // Tabellennamen weg, dann würde "id" in einer Unterabfrage auf die innere Tabelle zeigen.
      const [rows, questionCounts, sessionCounts] = await Promise.all([
        db.select().from(quizzes).orderBy(desc(quizzes.updatedAt)),
        db.select({ quizId: questions.quizId, n: count() }).from(questions).groupBy(questions.quizId),
        db.select({ quizId: gameSessions.quizId, n: count() }).from(gameSessions).groupBy(gameSessions.quizId),
      ]);
      const questionsBy = new Map(questionCounts.map((row) => [row.quizId, row.n]));
      const sessionsBy = new Map(sessionCounts.map((row) => [row.quizId, row.n]));
      return rows.map((quiz) => ({
        ...quiz,
        questionCount: questionsBy.get(quiz.id) ?? 0,
        sessionCount: sessionsBy.get(quiz.id) ?? 0,
      }));
    },

    async getQuizDetail(quizId: string): Promise<QuizDetail | null> {
      const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, quizId));
      if (!quiz) return null;
      const [loaded, sessionCount] = await Promise.all([loadQuestions(db, quizId), countSessions(db, quizId)]);
      return { quiz, questions: loaded, sessionCount };
    },

    async getQuestion(quizId: string, questionId: string): Promise<QuestionWithOptions | null> {
      const all = await loadQuestions(db, quizId);
      return all.find((question) => question.id === questionId) ?? null;
    },

    async createQuiz(meta: QuizMetaInput): Promise<{ id: string }> {
      const [row] = await db
        .insert(quizzes)
        .values({ title: meta.title, description: meta.description })
        .returning({ id: quizzes.id });
      if (!row) throw new QuizError("invalid", "Das Quiz konnte nicht angelegt werden.");
      return row;
    },

    async updateQuizMeta(quizId: string, meta: QuizMetaInput): Promise<void> {
      await db.transaction(async (tx) => {
        const quiz = await lockQuiz(tx, quizId);
        assertAllowed(checkEditable({ status: quiz.status, sessionCount: await countSessions(tx, quizId) }));
        await tx.update(quizzes).set({ title: meta.title, description: meta.description }).where(eq(quizzes.id, quizId));
      });
    },

    async setStatus(quizId: string, target: QuizStatus): Promise<void> {
      await db.transaction(async (tx) => {
        const quiz = await lockQuiz(tx, quizId);
        const sessionCount = await countSessions(tx, quizId);
        const loaded = await loadQuestions(tx, quizId);
        assertAllowed(checkTransition(quiz.status, target, { sessionCount, questionCount: loaded.length }));
        if (target === "ready") {
          const problems = validateReadyToPlay(loaded.map(toStoredQuestion));
          if (problems.length > 0) throw new QuizError("invalid", problems.join(" "));
        }
        await tx.update(quizzes).set({ status: target }).where(eq(quizzes.id, quizId));
      });
    },

    async deleteQuiz(quizId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await lockQuiz(tx, quizId);
        assertAllowed(checkDeletable({ sessionCount: await countSessions(tx, quizId) }));
        // Fragen und Antworten werden über die Fremdschlüssel mitgelöscht (CASCADE).
        await tx.delete(quizzes).where(eq(quizzes.id, quizId));
      });
    },

    /** Kopiert Quiz, Fragen und Antworten als neuen Entwurf. Das Original bleibt unverändert. */
    async duplicateQuiz(quizId: string): Promise<{ id: string }> {
      return db.transaction(async (tx) => {
        const source = await lockQuiz(tx, quizId);
        const loaded = await loadQuestions(tx, quizId);
        const suffix = " (Kopie)";
        const [created] = await tx
          .insert(quizzes)
          .values({
            title: `${source.title.slice(0, LIMITS.title - suffix.length)}${suffix}`,
            description: source.description,
            status: "draft",
          })
          .returning({ id: quizzes.id });
        if (!created) throw new QuizError("invalid", "Das Quiz konnte nicht dupliziert werden.");

        for (const [index, question] of loaded.entries()) {
          const [copy] = await tx
            .insert(questions)
            .values({
              quizId: created.id,
              position: index,
              type: question.type,
              prompt: question.prompt,
              timeLimitSeconds: question.timeLimitSeconds,
              maxPoints: question.maxPoints,
              correctValue: question.correctValue,
              unit: question.unit,
              tolerance: question.tolerance,
            })
            .returning({ id: questions.id });
          if (!copy) throw new QuizError("invalid", "Eine Frage konnte nicht kopiert werden.");
          if (question.options.length > 0) {
            await tx.insert(answerOptions).values(
              question.options.map((option) => ({
                questionId: copy.id,
                position: option.position,
                text: option.text,
                isCorrect: option.isCorrect,
              })),
            );
          }
        }
        return created;
      });
    },

    /** Legt eine Frage an (questionId ist null) oder ersetzt eine bestehende vollständig, inklusive Antworten. */
    async saveQuestion(quizId: string, questionId: string | null, input: QuestionInput): Promise<{ id: string }> {
      return db.transaction(async (tx) => {
        const quiz = await lockQuiz(tx, quizId);
        assertAllowed(checkEditable({ status: quiz.status, sessionCount: await countSessions(tx, quizId) }));

        const columns = questionColumns(input);
        let id: string;
        if (questionId === null) {
          const [stats] = await tx
            .select({ total: count(), last: max(questions.position) })
            .from(questions)
            .where(eq(questions.quizId, quizId));
          if ((stats?.total ?? 0) >= LIMITS.questionsPerQuiz) {
            throw new QuizError("invalid", `Ein Quiz kann höchstens ${LIMITS.questionsPerQuiz} Fragen enthalten.`);
          }
          const [created] = await tx
            .insert(questions)
            .values({ quizId, position: (stats?.last ?? -1) + 1, ...columns })
            .returning({ id: questions.id });
          if (!created) throw new QuizError("invalid", "Die Frage konnte nicht gespeichert werden.");
          id = created.id;
        } else {
          const [updated] = await tx
            .update(questions)
            .set(columns)
            .where(and(eq(questions.id, questionId), eq(questions.quizId, quizId)))
            .returning({ id: questions.id });
          if (!updated) throw new QuizError("not_found", "Die Frage wurde nicht gefunden.");
          id = updated.id;
          await tx.delete(answerOptions).where(eq(answerOptions.questionId, id));
        }

        if (input.type !== "estimate") {
          await tx.insert(answerOptions).values(
            input.options.map((option, position) => ({
              questionId: id,
              position,
              text: option.text,
              isCorrect: option.isCorrect,
            })),
          );
        }
        await tx.update(quizzes).set({ updatedAt: new Date() }).where(eq(quizzes.id, quizId));
        return { id };
      });
    },

    async deleteQuestion(quizId: string, questionId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const quiz = await lockQuiz(tx, quizId);
        assertAllowed(checkEditable({ status: quiz.status, sessionCount: await countSessions(tx, quizId) }));
        const removed = await tx
          .delete(questions)
          .where(and(eq(questions.id, questionId), eq(questions.quizId, quizId)))
          .returning({ id: questions.id });
        if (removed.length === 0) throw new QuizError("not_found", "Die Frage wurde nicht gefunden.");
        const remaining = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(eq(questions.quizId, quizId))
          .orderBy(asc(questions.position), asc(questions.id));
        await rewritePositions(tx, quizId, remaining.map((row) => row.id));
        await tx.update(quizzes).set({ updatedAt: new Date() }).where(eq(quizzes.id, quizId));
      });
    },

    /** Verschiebt eine Frage um eine Stelle. Am Rand geschieht nichts. */
    async moveQuestion(quizId: string, questionId: string, direction: "up" | "down"): Promise<void> {
      await db.transaction(async (tx) => {
        const quiz = await lockQuiz(tx, quizId);
        assertAllowed(checkEditable({ status: quiz.status, sessionCount: await countSessions(tx, quizId) }));
        const ordered = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(eq(questions.quizId, quizId))
          .orderBy(asc(questions.position), asc(questions.id));
        const ids = ordered.map((row) => row.id);
        const index = ids.indexOf(questionId);
        if (index < 0) throw new QuizError("not_found", "Die Frage wurde nicht gefunden.");
        const moved = moveInOrder(ids, index, direction);
        if (!moved) return;
        await rewritePositions(tx, quizId, moved);
        await tx.update(quizzes).set({ updatedAt: new Date() }).where(eq(quizzes.id, quizId));
      });
    },
  };
}

export type QuizRepository = ReturnType<typeof createQuizRepository>;

/** Repository mit der Datenbank der App. */
export function getQuizRepository(): QuizRepository {
  return createQuizRepository(getDb());
}
