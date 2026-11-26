/**
 * Integrationstests der Durchführungen gegen echtes Postgres (TEST_DATABASE_URL) und, für den Gesamtablauf,
 * echtes Redis (TEST_REDIS_URL). Nie die Datenbank von Produktion oder Preview verwenden.
 */
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import IORedis from "ioredis";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { gameSessions, players, quizzes, responses } from "@/lib/db/schema";
import { ioredisPort } from "@/lib/realtime/redis-port";
import { GameStore } from "@/lib/realtime/store";
import { createQuizRepository } from "@/lib/quiz/repository";
import type { QuestionInput } from "@/lib/quiz/schema";
import { GameEngine } from "./engine";
import { createSessionRepository, SessionError } from "./sessions";

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

const mc = (prompt: string): QuestionInput => ({
  type: "multiple_choice",
  prompt,
  timeLimitSeconds: 20,
  maxPoints: 1000,
  options: ["Rot", "Blau", "Grün"].map((text, index) => ({ text, isCorrect: index === 0 })),
});
const estimate: QuestionInput = {
  type: "estimate",
  prompt: "Wie viele PS?",
  timeLimitSeconds: 30,
  maxPoints: 800,
  correctValue: 216,
  unit: "PS",
  tolerance: 50,
};
const poll: QuestionInput = {
  type: "poll",
  prompt: "Welche Tour?",
  timeLimitSeconds: 15,
  maxPoints: 0,
  options: ["Furka", "Grimsel"].map((text) => ({ text, isCorrect: false })),
};

let codeCounter = 0;
const nextCode = () => String(700_000 + (codeCounter += 1));

describe.skipIf(!dbUrl)("Durchführungen (echte Datenbank)", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let quizRepo: ReturnType<typeof createQuizRepository>;
  let repo: ReturnType<typeof createSessionRepository>;
  const quizIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    quizRepo = createQuizRepository(db);
    repo = createSessionRepository(db);
    // Reste früherer Läufe, die eine aktive Durchführung hinterlassen haben, würden den Start blockieren.
    await db.update(gameSessions).set({ status: "cancelled" }).where(inArray(gameSessions.status, ["lobby", "running"]));
  });

  afterEach(async () => {
    if (quizIds.length === 0) return;
    await db.delete(gameSessions).where(inArray(gameSessions.quizId, quizIds));
    await db.delete(quizzes).where(inArray(quizzes.id, quizIds));
    quizIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function readyQuiz(title: string, inputs: QuestionInput[] = [mc("Farbe?"), estimate, poll]): Promise<string> {
    const { id } = await quizRepo.createQuiz({ title, description: "" });
    quizIds.push(id);
    for (const input of inputs) await quizRepo.saveQuestion(id, null, input);
    await quizRepo.setStatus(id, "ready");
    return id;
  }

  it("legt eine Durchführung an und liefert den Snapshot mit richtigen Antworten", async () => {
    const quizId = await readyQuiz("Snapshot");
    const code = nextCode();
    const { sessionId, snapshot } = await repo.createSession(quizId, code);
    expect(snapshot.questions.map((question) => question.type)).toEqual(["multiple_choice", "estimate", "poll"]);
    expect(snapshot.questions[0]?.options.map((option) => [option.text, option.isCorrect])).toEqual([
      ["Rot", true],
      ["Blau", false],
      ["Grün", false],
    ]);
    expect(snapshot.questions[1]).toMatchObject({ correctValue: 216, tolerance: 50, unit: "PS" });
    const [row] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(row).toMatchObject({ joinCode: code, status: "lobby" });
  });

  it("verlangt den Status Bereit", async () => {
    const { id } = await quizRepo.createQuiz({ title: "Entwurf", description: "" });
    quizIds.push(id);
    await quizRepo.saveQuestion(id, null, mc("Farbe?"));
    await expect(repo.createSession(id, nextCode())).rejects.toMatchObject({ code: "not_playable" });
    await expect(repo.createSession("00000000-0000-0000-0000-000000000000", nextCode())).rejects.toMatchObject({ code: "not_found" });
  });

  it("erlaubt höchstens eine aktive Durchführung, auch bei gleichzeitigem Start", async () => {
    const [a, b, c] = [await readyQuiz("A"), await readyQuiz("B"), await readyQuiz("C")];
    const results = await Promise.allSettled([
      repo.createSession(a, nextCode()),
      repo.createSession(b, nextCode()),
      repo.createSession(c, nextCode()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "active_exists" });
    }
    const active = await repo.getActive();
    expect(active?.status).toBe("lobby");
  });

  it("gibt den Platz nach Abbruch wieder frei", async () => {
    const quizId = await readyQuiz("Abbruch");
    const code = nextCode();
    await repo.createSession(quizId, code);
    await expect(repo.createSession(quizId, nextCode())).rejects.toBeInstanceOf(SessionError);
    expect(await repo.markCancelled(code)).toBe(true);
    expect(await repo.markCancelled(code)).toBe(false);
    await expect(repo.createSession(quizId, nextCode())).resolves.toBeDefined();
  });

  it("meldet einen schon vergebenen aktiven Spielcode", async () => {
    // Der Code ist nur unter aktiven Durchführungen eindeutig. Die Prüfung "nur eine aktive" greift zuerst, deshalb
    // wird der Konflikt direkt in der Datenbank ausgelöst.
    const quizId = await readyQuiz("Code");
    const code = nextCode();
    await db.insert(gameSessions).values({ quizId, joinCode: code, status: "lobby" });
    await expect(repo.createSession(quizId, code)).rejects.toMatchObject({ code: expect.stringMatching(/active_exists|code_taken/) });
  });

  it("wechselt auf running", async () => {
    const quizId = await readyQuiz("Läuft");
    const code = nextCode();
    await repo.createSession(quizId, code);
    await repo.markRunning(code);
    const found = await repo.getByCode(code);
    expect(found?.status).toBe("running");
    expect(found?.startedAt).toBeInstanceOf(Date);
  });

  describe.skipIf(!redisUrl)("Gesamtablauf mit Redis und Engine", () => {
    let redis: IORedis;
    let store: GameStore;
    const prefix = `s${Math.random().toString(36).slice(2, 10)}`;

    beforeAll(() => {
      redis = new IORedis(redisUrl as string);
      store = new GameStore(ioredisPort(redis), { prefix, tokenSecret: "ein sehr langes testgeheimnis fuer sessions" });
    });

    afterAll(async () => {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
    });

    it("speichert Spieler, Antworten und Rangliste beim Ende der letzten Frage und ist wiederholbar", async () => {
      const quizId = await readyQuiz("Gesamtablauf");
      const code = nextCode();
      const { snapshot } = await repo.createSession(quizId, code);
      expect(await store.createGame(code, snapshot)).toBe(true);

      let clock = 1_000_000;
      const engine = new GameEngine(store, {
        now: () => clock,
        hooks: {
          onStarted: async ({ code: started }) => repo.markRunning(started),
          onFinished: async (outcome) => void (await repo.saveOutcome(outcome)),
        },
      });

      const joined = [];
      for (const name of ["Anna", "Beat", "Clara"]) {
        const result = await store.joinPlayer(code, { name, avatar: 3 });
        if (!result.ok) throw new Error(result.reason);
        joined.push(result.player.id);
      }
      const [anna, beat, clara] = joined as [string, string, string];

      await engine.start(code);
      expect((await repo.getByCode(code))?.status).toBe("running");

      // Frage 1 (Multiple Choice): Anna und Beat richtig, Clara falsch.
      clock += 2_000;
      await engine.answer(code, anna, { q: 0, option: 0 }, null);
      clock += 3_000;
      await engine.answer(code, beat, { q: 0, option: 0 }, null);
      await engine.answer(code, clara, { q: 0, option: 2 }, null);
      await engine.next(code);
      // Frage 2 (Schätzfrage): Clara trifft, Beat liegt daneben, Anna antwortet nicht.
      clock += 500;
      await engine.answer(code, clara, { q: 1, value: 216 }, null);
      await engine.answer(code, beat, { q: 1, value: 230 }, null);
      clock += 40_000;
      await engine.tick(code, null);
      await engine.next(code);
      // Frage 3 (Umfrage, letzte): alle antworten.
      clock += 300;
      await engine.answer(code, anna, { q: 2, option: 1 }, null);
      await engine.answer(code, beat, { q: 2, option: 0 }, null);
      await engine.answer(code, clara, { q: 2, option: 0 }, null);

      const summary = await repo.getByCode(code);
      expect(summary).toMatchObject({ status: "finished", playerCount: 3 });
      const [session] = await db.select().from(gameSessions).where(eq(gameSessions.joinCode, code));
      const stored = await db.select().from(players).where(eq(players.sessionId, session?.id as string));
      expect(stored).toHaveLength(3);
      expect(stored.every((player) => player.tokenHash.length === 64)).toBe(true);
      const byName = Object.fromEntries(stored.map((player) => [player.name, player]));
      // Beat gewinnt (zwei richtige Antworten), danach Anna (eine richtige), zuletzt Clara (Frage 1 falsch).
      const final = (await engine.collectOutcome(code))?.finalRows ?? [];
      expect(final.map((row) => [row.name, row.rank])).toEqual([
        ["Beat", 1],
        ["Anna", 2],
        ["Clara", 3],
      ]);
      expect(byName["Beat"]).toMatchObject({ finalRank: 1, totalPoints: final[0]?.points });
      expect(byName["Anna"]?.finalRank).toBe(2);
      expect(byName["Clara"]?.finalRank).toBe(3);
      expect(byName["Beat"]?.totalPoints).toBeGreaterThan(byName["Anna"]?.totalPoints ?? 0);

      const rows = await db.select().from(responses).where(eq(responses.sessionId, session?.id as string));
      // Anna: Frage 1 und 3. Beat: 1, 2, 3. Clara: 1, 2, 3. Zusammen 8 Antworten, Annas Frage 2 fehlt.
      expect(rows).toHaveLength(8);
      const estimateRows = rows.filter((row) => row.numericValue !== null);
      expect(estimateRows).toHaveLength(2);
      expect(estimateRows.every((row) => row.optionId === null)).toBe(true);
      expect(rows.filter((row) => row.optionId !== null && row.numericValue === null)).toHaveLength(6);
      // Umfrage: keine Punkte.
      const pollQuestionId = snapshot.questions[2]?.id;
      expect(rows.filter((row) => row.questionId === pollQuestionId).every((row) => row.pointsAwarded === 0)).toBe(true);
      // Die Punkte der Antworten ergeben die Gesamtpunkte der Spieler.
      for (const player of stored) {
        const sum = rows.filter((row) => row.playerId === player.id).reduce((total, row) => total + row.pointsAwarded, 0);
        expect(sum).toBe(player.totalPoints);
      }

      // Wiederholtes Speichern verändert nichts, auch nicht nach Abschluss.
      const again = await engine.persist(code);
      expect(again).toBe(true);
      expect(await db.select().from(responses).where(eq(responses.sessionId, session?.id as string))).toHaveLength(8);
      expect(await db.select().from(players).where(eq(players.sessionId, session?.id as string))).toHaveLength(3);
    });

    it("bricht ab, ohne Resultate zu schreiben", async () => {
      const quizId = await readyQuiz("Abbruch mit Spiel");
      const code = nextCode();
      const { snapshot } = await repo.createSession(quizId, code);
      await store.createGame(code, snapshot);
      const engine = new GameEngine(store, { hooks: { onAborted: async ({ code: aborted }) => void (await repo.markCancelled(aborted)) } });
      await store.joinPlayer(code, { name: "Anna", avatar: 1 });
      await engine.start(code);
      await engine.abort(code);
      expect((await repo.getByCode(code))?.status).toBe("cancelled");
      const [session] = await db.select().from(gameSessions).where(eq(gameSessions.joinCode, code));
      expect(await db.select().from(players).where(eq(players.sessionId, session?.id as string))).toHaveLength(0);
    });
  });
});
