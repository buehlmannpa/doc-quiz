/**
 * Integrationstests der Spiel Engine gegen einen echten Redis Server (TEST_REDIS_URL).
 * Die Uhr ist steuerbar, damit Fristen und Gnadenfrist genau geprüft werden können.
 */
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublicGameState } from "@/lib/realtime/game-state";
import { ioredisPort } from "@/lib/realtime/redis-port";
import { GameStore } from "@/lib/realtime/store";
import { ANSWER_GRACE_MS, GameEngine, type EngineHooks, type GameOutcome } from "./engine";
import type { GameQuiz } from "./snapshot";

const url = process.env.TEST_REDIS_URL;
const SECRET = "ein sehr langes testgeheimnis fuer die engine";
const prefix = `e${Math.random().toString(36).slice(2, 10)}`;
let counter = 0;
const nextCode = () => String(200_000 + (counter += 1));

const quiz: GameQuiz = {
  quizId: "quiz-1",
  title: "Testquiz",
  questions: [
    {
      id: "q1",
      type: "multiple_choice",
      prompt: "Welche Farbe hat eine Ducati?",
      timeLimitSeconds: 20,
      maxPoints: 1000,
      options: [
        { id: "o0", text: "Blau", isCorrect: false },
        { id: "o1", text: "Rot", isCorrect: true },
        { id: "o2", text: "Grün", isCorrect: false },
      ],
      correctValue: null,
      unit: null,
      tolerance: null,
    },
    {
      id: "q2",
      type: "estimate",
      prompt: "Wie viele PS hat die Panigale V4?",
      timeLimitSeconds: 20,
      maxPoints: 1000,
      options: [],
      correctValue: 216,
      unit: "PS",
      tolerance: 50,
    },
    {
      id: "q3",
      type: "multiple_choice",
      prompt: "In welcher Stadt steht das Werk?",
      timeLimitSeconds: 10,
      maxPoints: 500,
      options: [
        { id: "p0", text: "Bologna", isCorrect: true },
        { id: "p1", text: "Mailand", isCorrect: false },
      ],
      correctValue: null,
      unit: null,
      tolerance: null,
    },
  ],
};

describe.skipIf(!url)("GameEngine (echtes Redis)", () => {
  let redis: IORedis;
  let store: GameStore;
  let clock = 1_000_000;
  const now = () => clock;
  const logs: { event: string; data: Record<string, unknown> }[] = [];

  beforeAll(() => {
    redis = new IORedis(url as string);
    store = new GameStore(ioredisPort(redis), { prefix, tokenSecret: SECRET });
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  function makeEngine(hooks: EngineHooks = {}) {
    return new GameEngine(store, {
      now,
      hooks,
      log: (event, data) => logs.push({ event, data }),
      persistRetryDelaysMs: [5, 5],
    });
  }

  /** Legt ein Spiel mit Quiz und n Spielern an. */
  async function setup(playerCount: number, game: GameQuiz = quiz) {
    const code = nextCode();
    expect(await store.createGame(code, game)).toBe(true);
    const ids: string[] = [];
    for (let index = 0; index < playerCount; index += 1) {
      const joined = await store.joinPlayer(code, { name: `Person ${index}`, avatar: index % 64 });
      if (!joined.ok) throw new Error(`Beitritt fehlgeschlagen: ${joined.reason}`);
      ids.push(joined.player.id);
    }
    return { code, ids };
  }

  async function stateOf(code: string): Promise<PublicGameState> {
    const state = await store.getState(code);
    if (!state) throw new Error("Spiel fehlt");
    return state;
  }

  it("verlangt mindestens einen Spieler zum Start und startet nur einmal", async () => {
    const engine = makeEngine();
    const { code } = await setup(0);
    expect(await engine.start(code)).toEqual({ ok: false, reason: "no_players" });
    const filled = await setup(1);
    const started = await engine.start(filled.code);
    expect(started.ok && started.value.phase).toBe("question");
    expect(await engine.start(filled.code)).toEqual({ ok: false, reason: "wrong_phase" });
  });

  it("setzt Start und Ablauf der Frage nach Serverzeit", async () => {
    const engine = makeEngine();
    const { code } = await setup(2);
    clock = 5_000_000;
    await engine.start(code);
    const state = await stateOf(code);
    expect(state.question).toMatchObject({ index: 0, total: 3, startedAt: 5_000_000, deadline: 5_020_000, timeLimitSeconds: 20 });
    expect(state.question?.options.map((option) => option.text)).toEqual(["Blau", "Rot", "Grün"]);
  });

  it("verrät die richtige Antwort nicht im öffentlichen Zustand, solange die Frage läuft", async () => {
    const engine = makeEngine();
    const { code } = await setup(2);
    await engine.start(code);
    const raw = JSON.stringify(await stateOf(code));
    expect(raw).not.toContain("isCorrect");
    expect(raw).not.toContain("correctOptions\":[1]");
    expect(raw).not.toContain("correctValue\":216");
    const state = await stateOf(code);
    expect(state.resolution).toBeNull();
    expect(state.results).toEqual({});
  });

  it("führt ein ganzes Quiz durch: Antworten, Auflösung, nächste Frage, Siegerbildschirm", async () => {
    const outcomes: GameOutcome[] = [];
    const started: string[] = [];
    const engine = makeEngine({
      onStarted: async ({ code }) => void started.push(code),
      onFinished: async (outcome) => void outcomes.push(outcome),
    });
    const { code, ids } = await setup(3);
    const [a, b, c] = ids as [string, string, string];

    clock = 10_000_000;
    await engine.start(code);
    expect(started).toEqual([code]);

    // Frage 1: A richtig und schnell, B richtig und langsam, C falsch. Die dritte Antwort löst automatisch auf.
    clock += 1000;
    expect(await engine.answer(code, a, { q: 0, option: 1 }, null)).toEqual({ ok: true });
    clock += 9000;
    expect(await engine.answer(code, b, { q: 0, option: 1 }, null)).toEqual({ ok: true });
    expect((await stateOf(code)).phase).toBe("question");
    clock += 1000;
    expect(await engine.answer(code, c, { q: 0, option: 0 }, null)).toEqual({ ok: true });

    let state = await stateOf(code);
    expect(state.phase).toBe("resolved");
    expect(state.resolution).toMatchObject({ correctOptions: [1], distribution: [1, 2, 0], answered: 3 });
    expect(state.results[a]).toMatchObject({ correct: true, points: 975, rank: 1, total: 975 });
    expect(state.results[b]).toMatchObject({ correct: true, points: 750, rank: 2 });
    expect(state.results[c]).toMatchObject({ correct: false, points: 0, rank: 3 });
    expect(state.resolution?.top.map((row) => row.name)).toEqual(["Person 0", "Person 1", "Person 2"]);

    // Frage 2 (Schätzfrage): C trifft genau, A und B liegen weit daneben. Zeit läuft ab, ein Gerät stösst die Auflösung an.
    clock += 2000;
    expect((await engine.next(code)).ok).toBe(true);
    state = await stateOf(code);
    expect(state.question?.index).toBe(1);
    expect(state.results).toEqual({});
    expect(state.resolution).toBeNull();
    clock += 400;
    await engine.answer(code, c, { q: 1, value: 216 }, null);
    await engine.answer(code, a, { q: 1, value: 10 }, null);
    // Vor Ablauf der Frist bewirkt der Hinweis nichts.
    await engine.tick(code, null);
    expect((await stateOf(code)).phase).toBe("question");
    clock += 20_000;
    await engine.tick(code, null);
    state = await stateOf(code);
    expect(state.phase).toBe("resolved");
    expect(state.results[c]).toMatchObject({ points: 1000, accuracy: 1, deviation: 0, rank: 1, delta: 2 });
    expect(state.results[b]).toMatchObject({ answered: false, points: 0 });
    expect(state.resolution?.estimates).toEqual([10, 216]);

    // Frage 3 ist die letzte: Alle antworten, danach springt der Zustand direkt auf das verdeckte Podest.
    clock += 1000;
    await engine.next(code);
    clock += 300;
    await engine.answer(code, a, { q: 2, option: 0 }, null);
    await engine.answer(code, b, { q: 2, option: 1 }, null);
    await engine.answer(code, c, { q: 2, option: 0 }, null);
    state = await stateOf(code);
    expect(state.phase).toBe("podium");
    expect(state.podium).toEqual({ size: 3, revealed: 0, places: [], ranking: null });
    // Handys sehen richtig oder falsch und Punkte, aber weder Rang noch Gesamtpunkte.
    expect(state.results[a]).toMatchObject({ correct: true, rank: null, delta: null, total: null });
    expect(state.results[b]).toMatchObject({ correct: false, rank: null, total: null });
    expect(state.resolution?.top).toEqual([]);
    // Die Resultate wurden genau einmal übergeben und sind vollständig.
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.records).toHaveLength(3);
    expect(outcome?.finalRows.map((row) => row.playerId)).toEqual([c, a, b]);
    expect(outcome?.records[1]?.get(c)).toMatchObject({ total: 1975 - 975, points: 1000, answered: true, value: 216 });

    // Enthüllung von unten nach oben, die Rangliste erst nach Platz 1.
    const revealOne = await engine.reveal(code);
    expect(revealOne.ok && revealOne.value.podium).toMatchObject({ revealed: 1, ranking: null });
    expect((await stateOf(code)).podium?.places.map((row) => row.playerId)).toEqual([b]);
    expect((await stateOf(code)).podium?.ranking).toBeNull();
    await engine.reveal(code);
    expect((await stateOf(code)).podium?.ranking).toBeNull();
    expect(await engine.finish(code)).toEqual({ ok: false, reason: "wrong_phase" });
    await engine.reveal(code);
    state = await stateOf(code);
    expect(state.podium?.places.map((row) => row.playerId)).toEqual([b, a, c]);
    expect(state.podium?.ranking?.map((row) => row.playerId)).toEqual([c, a, b]);
    expect(await engine.reveal(code)).toEqual({ ok: false, reason: "wrong_phase" });

    const finished = await engine.finish(code);
    expect(finished.ok && finished.value.phase).toBe("finished");
  });

  it("enthüllt bei zwei Teilnehmenden zwei Plätze", async () => {
    const engine = makeEngine();
    const short: GameQuiz = { ...quiz, questions: [quiz.questions[0] as GameQuiz["questions"][number]] };
    const { code, ids } = await setup(2, short);
    await engine.start(code);
    clock += 100;
    await engine.answer(code, ids[0] as string, { q: 0, option: 1 }, null);
    await engine.answer(code, ids[1] as string, { q: 0, option: 0 }, null);
    expect((await stateOf(code)).podium?.size).toBe(2);
    await engine.reveal(code);
    await engine.reveal(code);
    const state = await stateOf(code);
    expect(state.podium?.ranking).toHaveLength(2);
    expect(state.podium?.places.map((row) => row.playerId)).toEqual([ids[1], ids[0]]);
  });

  describe("Antworten", () => {
    async function running(playerCount = 3) {
      const engine = makeEngine();
      const setupResult = await setup(playerCount);
      clock = 20_000_000;
      await engine.start(setupResult.code);
      return { engine, ...setupResult };
    }

    it("nimmt nur eine Antwort pro Spieler und Frage an", async () => {
      const { engine, code, ids } = await running();
      const first = await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, null);
      expect(first).toEqual({ ok: true, value: 1 });
      expect(await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 0 }, null)).toEqual({ ok: false, reason: "already_answered" });
      // Die erste Antwort bleibt massgebend.
      expect(await engine.mine(code, ids[0] as string, 0)).toEqual({ option: 1 });
    });

    it("lehnt Antworten auf eine andere Frage, von Unbekannten und mit falscher Form ab", async () => {
      const { engine, code, ids } = await running();
      const player = ids[0] as string;
      expect(await engine.submitAnswer(code, player, { q: 1, option: 1 }, null)).toEqual({ ok: false, reason: "stale" });
      expect(await engine.submitAnswer(code, "unbekannt", { q: 0, option: 1 }, null)).toEqual({ ok: false, reason: "invalid" });
      expect(await engine.submitAnswer(code, player, { q: 0, option: 3 }, null)).toEqual({ ok: false, reason: "invalid" });
      expect(await engine.submitAnswer(code, player, { q: 0, value: 5 }, null)).toEqual({ ok: false, reason: "invalid" });
      expect(await engine.submitAnswer(code, player, { q: 0 }, null)).toEqual({ ok: false, reason: "invalid" });
      expect(await engine.submitAnswer(code, player, { q: 0, option: 1, value: 3 }, null)).toEqual({ ok: false, reason: "invalid" });
      // Nach all diesen Fehlversuchen ist die Antwort noch frei.
      expect((await engine.submitAnswer(code, player, { q: 0, option: 1 }, null)).ok).toBe(true);
    });

    it("lehnt Zahlen ausserhalb des Bereichs und Nicht Zahlen bei Schätzfragen ab", async () => {
      const engine = makeEngine();
      const { code, ids } = await setup(2);
      await engine.start(code);
      await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 0 }, null);
      await engine.submitAnswer(code, ids[1] as string, { q: 0, option: 0 }, null);
      await engine.next(code);
      expect(await engine.submitAnswer(code, ids[0] as string, { q: 1, value: Number.NaN }, null)).toEqual({ ok: false, reason: "invalid" });
      expect(await engine.submitAnswer(code, ids[0] as string, { q: 1, option: 0 }, null)).toEqual({ ok: false, reason: "invalid" });
      expect((await engine.submitAnswer(code, ids[0] as string, { q: 1, value: 215.5 }, null)).ok).toBe(true);
    });

    it("rechnet die Antwortzeit mit der Serverzeit und gewährt eine kurze Gnadenfrist", async () => {
      const { engine, code, ids } = await running();
      const all = await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, null);
      expect(all.ok).toBe(true);
      // Knapp nach Ablauf (innerhalb der Gnadenfrist) wird noch angenommen und zählt mit der vollen Zeit.
      clock = 20_000_000 + 20_000 + ANSWER_GRACE_MS - 1;
      expect((await engine.submitAnswer(code, ids[1] as string, { q: 0, option: 1 }, null)).ok).toBe(true);
      // Danach nicht mehr.
      clock += 2;
      expect(await engine.submitAnswer(code, ids[2] as string, { q: 0, option: 1 }, null)).toEqual({ ok: false, reason: "too_late" });
      await engine.tick(code, null);
      const state = await stateOf(code);
      expect(state.results[ids[0] as string]?.points).toBe(1000);
      // Halbe Punkte bei voller Zeit.
      expect(state.results[ids[1] as string]?.points).toBe(500);
      expect(state.results[ids[2] as string]?.answered).toBe(false);
    });

    it("lehnt Antworten nach der Auflösung ab, auch wenn der Hinweis noch die offene Frage zeigt", async () => {
      const { engine, code, ids } = await running();
      const hint = await stateOf(code);
      expect((await engine.resolve(code, { reason: "manual" })).ok).toBe(true);
      // Veralteter Hinweis: Die Instanz kennt die Auflösung noch nicht. Die Sperre in Redis hält trotzdem.
      expect(await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, hint)).toEqual({ ok: false, reason: "too_late" });
      expect((await stateOf(code)).resolution?.answered).toBe(0);
    });

    it("nimmt viele gleichzeitige Antworten ohne Verlust an und löst genau einmal auf", async () => {
      const { engine, code, ids } = await running(60);
      const before = await stateOf(code);
      const results = await Promise.all(
        ids.map((id, index) => engine.submitAnswer(code, id, { q: 0, option: index % 3 }, before)),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      const state = await stateOf(code);
      expect(state.phase).toBe("resolved");
      expect(state.version).toBe(before.version + 1);
      expect(state.resolution?.answered).toBe(60);
      expect(state.resolution?.distribution).toEqual([20, 20, 20]);
      expect(Object.keys(state.results)).toHaveLength(60);
    });

    it("meldet Fortschritt und eigene Antwort für die Wiederverbindung", async () => {
      const { engine, code, ids } = await running();
      expect(await engine.progress(code, 0)).toBe(0);
      expect(await engine.mine(code, ids[0] as string, 0)).toBeNull();
      await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 2 }, null);
      await engine.submitAnswer(code, ids[1] as string, { q: 0, option: 1 }, null);
      expect(await engine.progress(code, 0)).toBe(2);
      expect(await engine.mine(code, ids[0] as string, 0)).toEqual({ option: 2 });
    });

    it("veröffentlicht den Fortschritt als flüchtige Nachricht", async () => {
      const { engine, code, ids } = await running();
      const subscriber = new IORedis(url as string);
      const received: string[] = [];
      subscriber.on("message", (_channel, message) => received.push(message));
      await subscriber.subscribe(store.channel(code));
      await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, null);
      await new Promise((resolve) => setTimeout(resolve, 100));
      subscriber.disconnect();
      expect(received.map((raw) => JSON.parse(raw))).toContainEqual({ k: "progress", q: 0, n: 1 });
    });
  });

  describe("Auflösung", () => {
    it("löst bei gleichzeitigen Auslösern genau einmal auf", async () => {
      const engine = makeEngine();
      const second = makeEngine();
      const { code, ids } = await setup(4);
      clock = 30_000_000;
      await engine.start(code);
      await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, null);
      await engine.submitAnswer(code, ids[1] as string, { q: 0, option: 0 }, null);
      const before = await stateOf(code);
      clock += 25_000;
      // Zeitablauf auf zwei Instanzen, Klick des Admins und Hinweis zugleich.
      const results = await Promise.all([
        engine.tick(code, null),
        second.tick(code, null),
        engine.resolve(code, { reason: "manual" }),
        second.resolve(code, { reason: "timeout", questionIndex: 0 }),
      ]);
      expect(results[2]).toEqual({ ok: true, value: undefined });
      const state = await stateOf(code);
      expect(state.phase).toBe("resolved");
      expect(state.version).toBe(before.version + 1);
      expect(state.resolution?.answered).toBe(2);
    });

    it("lässt eine manuelle Auflösung vor Ablauf der Zeit zu, den Zeithinweis aber nicht", async () => {
      const engine = makeEngine();
      const { code, ids } = await setup(2);
      clock = 40_000_000;
      await engine.start(code);
      await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, null);
      expect(await engine.resolve(code, { reason: "timeout", questionIndex: 0 })).toEqual({ ok: false, reason: "too_early" });
      expect((await stateOf(code)).phase).toBe("question");
      expect((await engine.resolve(code, { reason: "manual" })).ok).toBe(true);
      expect((await stateOf(code)).phase).toBe("resolved");
    });

    it("lehnt Befehle mit veralteter Version ab (doppelter Klick)", async () => {
      const engine = makeEngine();
      const { code, ids } = await setup(2);
      await engine.start(code);
      const version = (await stateOf(code)).version;
      expect(await engine.command(code, "resolve", version)).toEqual({ ok: true });
      // Zweiter Klick mit derselben (jetzt veralteten) Version: nicht noch eine Phase weiter.
      expect(await engine.command(code, "next", version)).toEqual({ ok: false, error: "stale" });
      expect((await stateOf(code)).phase).toBe("resolved");
      expect(await engine.command(code, "next", version + 1)).toEqual({ ok: true });
      expect((await stateOf(code)).question?.index).toBe(1);
      expect(ids).toHaveLength(2);
    });

    it("wiederholt eine Auflösung ohne die Punkte zu verändern", async () => {
      const engine = makeEngine();
      const { code, ids } = await setup(2);
      clock = 50_000_000;
      await engine.start(code);
      clock += 2000;
      await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, null);
      await engine.resolve(code, { reason: "manual" });
      const once = await stateOf(code);
      expect(await engine.resolve(code, { reason: "timeout", questionIndex: 0 })).toEqual({ ok: true, value: undefined });
      expect(await stateOf(code)).toEqual(once);
    });
  });

  describe("Abbruch und Speichern", () => {
    it("bricht das Spiel in jeder Phase vor dem Siegerbildschirm ab", async () => {
      const aborted: string[] = [];
      const engine = makeEngine({ onAborted: async ({ code }) => void aborted.push(code) });
      const lobby = await setup(1);
      expect((await engine.abort(lobby.code)).ok).toBe(true);
      expect(aborted).toEqual([lobby.code]);
      expect(await stateOf(lobby.code)).toMatchObject({ phase: "finished", podium: null, question: null });
      expect(await engine.abort(lobby.code)).toEqual({ ok: false, reason: "wrong_phase" });

      const midway = await setup(2);
      await engine.start(midway.code);
      expect((await engine.abort(midway.code)).ok).toBe(true);
      expect((await stateOf(midway.code)).podium).toBeNull();
    });

    it("wiederholt das Speichern der Resultate und lässt das Spiel bei Fehlern weiterlaufen", async () => {
      let attempts = 0;
      const outcomes: GameOutcome[] = [];
      const engine = makeEngine({
        onFinished: async (outcome) => {
          attempts += 1;
          if (attempts < 3) throw new Error("Datenbank nicht erreichbar");
          outcomes.push(outcome);
        },
      });
      const short: GameQuiz = { ...quiz, questions: [quiz.questions[0] as GameQuiz["questions"][number]] };
      const { code, ids } = await setup(1, short);
      await engine.start(code);
      await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, null);
      expect(attempts).toBe(3);
      expect(outcomes).toHaveLength(1);
      expect((await stateOf(code)).phase).toBe("podium");
    });

    it("meldet, wenn das Speichern endgültig scheitert, und kann es später wiederholen", async () => {
      let fail = true;
      const outcomes: GameOutcome[] = [];
      const engine = makeEngine({
        onFinished: async (outcome) => {
          if (fail) throw new Error("Datenbank nicht erreichbar");
          outcomes.push(outcome);
        },
      });
      const short: GameQuiz = { ...quiz, questions: [quiz.questions[0] as GameQuiz["questions"][number]] };
      const { code, ids } = await setup(1, short);
      await engine.start(code);
      await engine.submitAnswer(code, ids[0] as string, { q: 0, option: 1 }, null);
      expect((await stateOf(code)).phase).toBe("podium");
      expect(outcomes).toHaveLength(0);
      expect(logs.some((entry) => entry.event === "results_save_failed")).toBe(true);
      fail = false;
      expect(await engine.persist(code)).toBe(true);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.players).toHaveLength(1);
    });

    it("liefert die Resultate erst, wenn das Spiel beendet ist", async () => {
      const engine = makeEngine();
      const { code } = await setup(1);
      expect(await engine.collectOutcome(code)).toBeNull();
    });
  });

  it("lehnt Befehle ab, wenn ein Spiel unbekannt ist", async () => {
    const engine = makeEngine();
    expect(await engine.command("999998", "start", undefined)).toEqual({ ok: false, error: "not_found" });
    expect(await engine.command("999998", "resolve", undefined)).toEqual({ ok: false, error: "not_found" });
  });

  it("verweigert den Start eines Spiels ohne Quiz", async () => {
    const engine = makeEngine();
    const code = nextCode();
    await store.createGame(code);
    await store.joinPlayer(code, { name: "Anna", avatar: 1 });
    expect(await engine.start(code)).toEqual({ ok: false, reason: "no_quiz" });
  });
});
