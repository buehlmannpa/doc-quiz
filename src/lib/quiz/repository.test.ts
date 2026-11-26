/**
 * Integrationstests gegen eine echte Postgres Datenbank.
 *
 * Sie laufen nur, wenn TEST_DATABASE_URL gesetzt ist, zum Beispiel:
 *   TEST_DATABASE_URL=postgres://quiz:quiz@127.0.0.1:5432/quiztest npm test
 * Die Datenbank wird vor dem Lauf migriert. Jeder Test räumt seine eigenen Quizzes wieder auf.
 * Verwenden Sie niemals die Datenbank von Produktion oder Preview.
 */
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { gameSessions, questions, quizzes } from "@/lib/db/schema";
import { createQuizRepository, QuizError } from "./repository";
import { LIMITS, type QuestionInput } from "./schema";

const url = process.env.TEST_DATABASE_URL;

const mcQuestion = (prompt: string, correct = 0): QuestionInput => ({
  type: "multiple_choice",
  prompt,
  timeLimitSeconds: 20,
  maxPoints: 1000,
  options: ["A", "B", "C", "D"].map((text, index) => ({ text, isCorrect: index === correct })),
});

const estimateQuestion = (prompt: string): QuestionInput => ({
  type: "estimate",
  prompt,
  timeLimitSeconds: 30,
  maxPoints: 800,
  correctValue: 216,
  unit: "PS",
  tolerance: 50,
});

const pollQuestion = (prompt: string): QuestionInput => ({
  type: "poll",
  prompt,
  timeLimitSeconds: 15,
  maxPoints: 0,
  options: ["Rot", "Schwarz"].map((text) => ({ text, isCorrect: false })),
});

describe.skipIf(!url)("Quiz Repository (echte Datenbank)", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repo: ReturnType<typeof createQuizRepository>;
  const createdQuizIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    repo = createQuizRepository(db);
  });

  afterEach(async () => {
    if (createdQuizIds.length === 0) return;
    // Durchführungen zuerst entfernen, sonst verhindert der Fremdschlüssel das Löschen der Quizzes.
    await db.delete(gameSessions).where(inArray(gameSessions.quizId, createdQuizIds));
    await db.delete(quizzes).where(inArray(quizzes.id, createdQuizIds));
    createdQuizIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function newQuiz(title = "Testquiz"): Promise<string> {
    const { id } = await repo.createQuiz({ title, description: "Beschreibung" });
    createdQuizIds.push(id);
    return id;
  }

  async function addSession(quizId: string): Promise<void> {
    await db.insert(gameSessions).values({ quizId, joinCode: String(100_000 + Math.floor(Math.random() * 899_999)), status: "finished" });
  }

  async function expectError(promise: Promise<unknown>, code: QuizError["code"]): Promise<QuizError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(QuizError);
      expect((error as QuizError).code).toBe(code);
      return error as QuizError;
    }
    throw new Error("Es wurde kein Fehler geworfen.");
  }

  it("legt ein Quiz als Entwurf an und liest es wieder", async () => {
    const id = await newQuiz("Ducati Quiz");
    const detail = await repo.getQuizDetail(id);
    expect(detail?.quiz.title).toBe("Ducati Quiz");
    expect(detail?.quiz.status).toBe("draft");
    expect(detail?.questions).toEqual([]);
    expect(detail?.sessionCount).toBe(0);
    expect(await repo.getQuizDetail("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("speichert Fragen aller Typen in der richtigen Reihenfolge samt Antworten", async () => {
    const id = await newQuiz();
    await repo.saveQuestion(id, null, mcQuestion("Erste"));
    await repo.saveQuestion(id, null, estimateQuestion("Zweite"));
    await repo.saveQuestion(id, null, pollQuestion("Dritte"));

    const detail = await repo.getQuizDetail(id);
    expect(detail?.questions.map((q) => [q.position, q.type, q.prompt])).toEqual([
      [0, "multiple_choice", "Erste"],
      [1, "estimate", "Zweite"],
      [2, "poll", "Dritte"],
    ]);
    const [mc, estimate, poll] = detail?.questions ?? [];
    expect(mc?.options.map((o) => [o.position, o.text, o.isCorrect])).toEqual([
      [0, "A", true],
      [1, "B", false],
      [2, "C", false],
      [3, "D", false],
    ]);
    expect(estimate).toMatchObject({ correctValue: 216, unit: "PS", tolerance: 50, maxPoints: 800 });
    expect(estimate?.options).toEqual([]);
    expect(poll).toMatchObject({ maxPoints: 0, correctValue: null, unit: null, tolerance: null });
    expect(poll?.options.every((o) => !o.isCorrect)).toBe(true);
  });

  it("ersetzt beim Bearbeiten die Antworten und räumt beim Typwechsel die Felder auf", async () => {
    const id = await newQuiz();
    const { id: questionId } = await repo.saveQuestion(id, null, mcQuestion("Frage", 2));

    // Multiple Choice wird zur Schätzfrage: Antworten verschwinden, Schätzfelder entstehen.
    await repo.saveQuestion(id, questionId, estimateQuestion("Frage neu"));
    let question = await repo.getQuestion(id, questionId);
    expect(question).toMatchObject({ type: "estimate", prompt: "Frage neu", correctValue: 216, tolerance: 50 });
    expect(question?.options).toEqual([]);

    // Zurück zu Multiple Choice: Schätzfelder werden wieder null (die Datenbank würde sonst ablehnen).
    await repo.saveQuestion(id, questionId, mcQuestion("Frage MC", 1));
    question = await repo.getQuestion(id, questionId);
    expect(question).toMatchObject({ type: "multiple_choice", correctValue: null, unit: null, tolerance: null });
    expect(question?.options.map((o) => o.isCorrect)).toEqual([false, true, false, false]);
    expect((await repo.getQuizDetail(id))?.questions).toHaveLength(1);
  });

  it("speichert eine Schätzfrage ohne Einheit mit null", async () => {
    const id = await newQuiz();
    const { id: questionId } = await repo.saveQuestion(id, null, { ...(estimateQuestion("Ohne") as Extract<QuestionInput, { type: "estimate" }>), unit: "" });
    expect((await repo.getQuestion(id, questionId))?.unit).toBeNull();
  });

  it("verschiebt Fragen nach oben und unten, am Rand geschieht nichts", async () => {
    const id = await newQuiz();
    const ids: string[] = [];
    for (const prompt of ["Eins", "Zwei", "Drei"]) ids.push((await repo.saveQuestion(id, null, mcQuestion(prompt))).id);
    const order = async () => (await repo.getQuizDetail(id))?.questions.map((q) => q.prompt);

    // Ausgangslage: Eins, Zwei, Drei
    await repo.moveQuestion(id, ids[2] as string, "up");
    expect(await order()).toEqual(["Eins", "Drei", "Zwei"]);
    await repo.moveQuestion(id, ids[0] as string, "down");
    expect(await order()).toEqual(["Drei", "Eins", "Zwei"]);
    // Am unteren Rand (Zwei) geht es nicht weiter nach unten, am oberen Rand (Drei) nicht weiter nach oben.
    await repo.moveQuestion(id, ids[1] as string, "down");
    expect(await order()).toEqual(["Drei", "Eins", "Zwei"]);
    await repo.moveQuestion(id, ids[2] as string, "up");
    expect(await order()).toEqual(["Drei", "Eins", "Zwei"]);
    // Zwei zweimal nach oben bringt es an die Spitze.
    await repo.moveQuestion(id, ids[1] as string, "up");
    await repo.moveQuestion(id, ids[1] as string, "up");
    expect(await order()).toEqual(["Zwei", "Drei", "Eins"]);
    expect((await repo.getQuizDetail(id))?.questions.map((q) => q.position)).toEqual([0, 1, 2]);
    await expectError(repo.moveQuestion(id, "00000000-0000-0000-0000-000000000000", "up"), "not_found");
  });

  it("löscht eine Frage und schliesst die Lücke bei den Positionen", async () => {
    const id = await newQuiz();
    const ids: string[] = [];
    for (const prompt of ["Eins", "Zwei", "Drei"]) ids.push((await repo.saveQuestion(id, null, mcQuestion(prompt))).id);
    await repo.deleteQuestion(id, ids[1] as string);
    const detail = await repo.getQuizDetail(id);
    expect(detail?.questions.map((q) => [q.position, q.prompt])).toEqual([
      [0, "Eins"],
      [1, "Drei"],
    ]);
    await expectError(repo.deleteQuestion(id, ids[1] as string), "not_found");
    // Antworten der gelöschten Frage sind mit verschwunden.
    const orphan = await db.select().from(schema.answerOptions).where(eq(schema.answerOptions.questionId, ids[1] as string));
    expect(orphan).toEqual([]);
  });

  it("vergibt bei gleichzeitigem Hinzufügen lückenlose, eindeutige Positionen", async () => {
    const id = await newQuiz();
    await Promise.all(Array.from({ length: 8 }, (_, i) => repo.saveQuestion(id, null, mcQuestion(`Frage ${i}`))));
    const positions = (await repo.getQuizDetail(id))?.questions.map((q) => q.position);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("begrenzt die Anzahl der Fragen pro Quiz", async () => {
    const id = await newQuiz();
    const rows = Array.from({ length: LIMITS.questionsPerQuiz }, (_, position) => ({
      quizId: id,
      position,
      type: "estimate" as const,
      prompt: `F${position}`,
      correctValue: 1,
      tolerance: 1,
    }));
    await db.insert(questions).values(rows);
    await expectError(repo.saveQuestion(id, null, mcQuestion("Eine zu viel")), "invalid");
  });

  it("verlangt für den Status Bereit mindestens eine Frage", async () => {
    const id = await newQuiz();
    await expectError(repo.setStatus(id, "ready"), "forbidden");
    await repo.saveQuestion(id, null, mcQuestion("Frage"));
    await repo.setStatus(id, "ready");
    expect((await repo.getQuizDetail(id))?.quiz.status).toBe("ready");
    await repo.setStatus(id, "draft");
    expect((await repo.getQuizDetail(id))?.quiz.status).toBe("draft");
  });

  it("verweigert Bereit, wenn eine gespeicherte Frage ungültig ist", async () => {
    const id = await newQuiz();
    const { id: questionId } = await repo.saveQuestion(id, null, mcQuestion("Frage"));
    // Jemand ändert die Datenbank von Hand: keine Antwort mehr als richtig markiert.
    await db.update(schema.answerOptions).set({ isCorrect: false }).where(eq(schema.answerOptions.questionId, questionId));
    const error = await expectError(repo.setStatus(id, "ready"), "invalid");
    expect(error.message).toMatch(/Frage 1/);
  });

  it("sperrt ein abgeschlossenes Quiz vollständig, erlaubt aber Duplizieren", async () => {
    const id = await newQuiz();
    const { id: questionId } = await repo.saveQuestion(id, null, mcQuestion("Frage"));
    await repo.setStatus(id, "completed");

    await expectError(repo.updateQuizMeta(id, { title: "Neu", description: "" }), "forbidden");
    await expectError(repo.saveQuestion(id, null, mcQuestion("Neu")), "forbidden");
    await expectError(repo.saveQuestion(id, questionId, mcQuestion("Geändert")), "forbidden");
    await expectError(repo.deleteQuestion(id, questionId), "forbidden");
    await expectError(repo.moveQuestion(id, questionId, "down"), "forbidden");
    await expectError(repo.setStatus(id, "draft"), "forbidden");

    const copy = await repo.duplicateQuiz(id);
    createdQuizIds.push(copy.id);
    expect((await repo.getQuizDetail(copy.id))?.quiz.status).toBe("draft");
  });

  it("sperrt Änderungen, sobald eine Durchführung existiert", async () => {
    const id = await newQuiz();
    const { id: questionId } = await repo.saveQuestion(id, null, mcQuestion("Frage"));
    await repo.setStatus(id, "ready");
    await addSession(id);

    const error = await expectError(repo.updateQuizMeta(id, { title: "Neu", description: "" }), "forbidden");
    expect(error.message).toMatch(/dupliz/i);
    await expectError(repo.saveQuestion(id, questionId, mcQuestion("Geändert")), "forbidden");
    await expectError(repo.saveQuestion(id, null, mcQuestion("Neu")), "forbidden");
    await expectError(repo.deleteQuestion(id, questionId), "forbidden");
    await expectError(repo.moveQuestion(id, questionId, "up"), "forbidden");
    await expectError(repo.setStatus(id, "draft"), "forbidden");
    await expectError(repo.deleteQuiz(id), "forbidden");

    // Abschliessen und Duplizieren bleiben möglich.
    await repo.setStatus(id, "completed");
    const copy = await repo.duplicateQuiz(id);
    createdQuizIds.push(copy.id);
    expect((await repo.getQuizDetail(copy.id))?.sessionCount).toBe(0);
  });

  it("dupliziert Quiz, Fragen und Antworten unabhängig vom Original", async () => {
    const id = await newQuiz("Original");
    await repo.saveQuestion(id, null, mcQuestion("MC", 3));
    await repo.saveQuestion(id, null, estimateQuestion("Schätzung"));
    await repo.saveQuestion(id, null, pollQuestion("Umfrage"));
    await repo.setStatus(id, "ready");

    const copy = await repo.duplicateQuiz(id);
    createdQuizIds.push(copy.id);
    const original = await repo.getQuizDetail(id);
    const duplicate = await repo.getQuizDetail(copy.id);

    expect(duplicate?.quiz.title).toBe("Original (Kopie)");
    expect(duplicate?.quiz.status).toBe("draft");
    expect(duplicate?.questions.map((q) => [q.position, q.type, q.prompt])).toEqual(
      original?.questions.map((q) => [q.position, q.type, q.prompt]),
    );
    expect(duplicate?.questions[0]?.options.map((o) => o.isCorrect)).toEqual([false, false, false, true]);
    expect(duplicate?.questions[1]).toMatchObject({ correctValue: 216, unit: "PS", tolerance: 50 });
    // Neue Kennungen, das Original bleibt unberührt.
    const originalIds = new Set(original?.questions.map((q) => q.id));
    expect(duplicate?.questions.every((q) => !originalIds.has(q.id))).toBe(true);
    expect(original?.quiz.status).toBe("ready");

    // Änderungen an der Kopie verändern das Original nicht.
    await repo.deleteQuestion(copy.id, duplicate?.questions[0]?.id as string);
    expect((await repo.getQuizDetail(id))?.questions).toHaveLength(3);
  });

  it("kürzt beim Duplizieren einen sehr langen Titel auf die erlaubte Länge", async () => {
    const id = await newQuiz("x".repeat(LIMITS.title));
    const copy = await repo.duplicateQuiz(id);
    createdQuizIds.push(copy.id);
    const title = (await repo.getQuizDetail(copy.id))?.quiz.title ?? "";
    expect(title.length).toBeLessThanOrEqual(LIMITS.title);
    expect(title.endsWith(" (Kopie)")).toBe(true);
  });

  it("löscht ein Quiz ohne Durchführung samt Fragen und Antworten", async () => {
    const id = await newQuiz();
    const { id: questionId } = await repo.saveQuestion(id, null, mcQuestion("Frage"));
    await repo.deleteQuiz(id);
    expect(await repo.getQuizDetail(id)).toBeNull();
    expect(await db.select().from(schema.answerOptions).where(eq(schema.answerOptions.questionId, questionId))).toEqual([]);
    await expectError(repo.deleteQuiz(id), "not_found");
  });

  it("listet Quizzes mit Anzahl Fragen und Durchführungen, zuletzt geänderte zuerst", async () => {
    const first = await newQuiz("Erstes");
    const second = await newQuiz("Zweites");
    await repo.saveQuestion(first, null, mcQuestion("Frage"));
    await repo.saveQuestion(first, null, mcQuestion("Frage 2"));
    await addSession(first);
    // Bearbeiten von "Zweites" macht es zum zuletzt geänderten.
    await repo.updateQuizMeta(second, { title: "Zweites neu", description: "" });

    const list = (await repo.listQuizzes()).filter((q) => createdQuizIds.includes(q.id));
    expect(list.map((q) => q.title)).toEqual(["Zweites neu", "Erstes"]);
    expect(list.find((q) => q.id === first)).toMatchObject({ questionCount: 2, sessionCount: 1 });
    expect(list.find((q) => q.id === second)).toMatchObject({ questionCount: 0, sessionCount: 0 });
  });
});
