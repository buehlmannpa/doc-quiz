/**
 * Prüft den Adapter für das Upstash SDK: dieselbe Spiellogik wie in den Tests des Speichers, aber über das
 * echte SDK und HTTP gegen den Ersatzserver in testing/fake-upstash.ts.
 * Läuft nur mit TEST_REDIS_URL (siehe store.test.ts).
 */
import { Redis } from "@upstash/redis";
import { GameEngine } from "@/lib/game/engine";
import type { GameQuiz } from "@/lib/game/snapshot";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channelMessageSchema } from "./protocol";
import { upstashPort } from "./redis-port";
import { GameStore } from "./store";
import { startFakeUpstash, type FakeUpstash } from "./testing/fake-upstash";

/** Liest eine Kanalnachricht und erwartet einen Zustand (die flüchtigen Nachrichten sind hier nicht gefragt). */
function stateMessage(raw: string) {
  const message = channelMessageSchema.parse(JSON.parse(raw));
  if (message.k !== "state") throw new Error("Es wurde keine Zustandsnachricht erwartet.");
  return message;
}

const url = process.env.TEST_REDIS_URL;
const prefix = `u${Math.random().toString(36).slice(2, 10)}`;
let counter = 0;
const nextCode = () => String(200_000 + (counter += 1));

describe.skipIf(!url)("Upstash Adapter (SDK über HTTP)", () => {
  let fake: FakeUpstash;
  let direct: IORedis;
  let subscriber: IORedis;
  let store: GameStore;

  beforeAll(async () => {
    fake = await startFakeUpstash(url as string);
    direct = new IORedis(url as string);
    subscriber = new IORedis(url as string);
    // Genau die Einstellungen wie in src/lib/redis/rest.ts.
    const redis = new Redis({ url: fake.url, token: "test", automaticDeserialization: false, retry: false });
    store = new GameStore(upstashPort(redis), { prefix, tokenSecret: "ein sehr langes testgeheimnis fuer den adapter" });
  });

  afterAll(async () => {
    const keys = await direct.keys(`${prefix}:*`);
    if (keys.length > 0) await direct.del(...keys);
    subscriber.disconnect();
    direct.disconnect();
    await fake.close();
  });

  it("legt Spiele an, nimmt Spieler auf und meldet sie mit dem Token an", async () => {
    const code = nextCode();
    expect(await store.createGame(code)).toBe(true);
    expect(await store.createGame(code)).toBe(false);

    const joined = await store.joinPlayer(code, { name: "Anna", avatar: 7 });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.state.version).toBe(1);

    const auth = await store.authenticatePlayer(code, joined.token);
    expect(auth.ok && auth.player.name === "Anna").toBe(true);
    expect(await store.authenticatePlayer(code, "b".repeat(32))).toEqual({ ok: false, reason: "bad_token" });
    expect(await store.getState("999998")).toBeNull();
  });

  it("verwendet das Skript mit Veröffentlichung, und die Nachricht kommt an", async () => {
    const code = nextCode();
    await store.createGame(code);
    const received: string[] = [];
    subscriber.on("message", (_channel, message) => received.push(message));
    await subscriber.subscribe(store.channel(code));

    await store.joinPlayer(code, { name: "Berta", avatar: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(store.publishMode).toBe("script");
    expect(received).toHaveLength(1);
    expect(stateMessage(received[0] as string).state.players[0]?.name).toBe("Berta");
    await subscriber.unsubscribe(store.channel(code));
    subscriber.removeAllListeners("message");
  });

  it("verarbeitet gleichzeitige Beitritte über HTTP ohne Verlust", async () => {
    const code = nextCode();
    await store.createGame(code);
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => store.joinPlayer(code, { name: `Fahrer ${i}`, avatar: i })));
    expect(results.every((result) => result.ok)).toBe(true);
    const state = await store.getState(code);
    expect(state?.version).toBe(25);
    expect(new Set(state?.players.map((p) => p.id)).size).toBe(25);
  }, 30_000);

  it("liest Zustand und Token mit einer einzigen gebündelten Anfrage", async () => {
    const code = nextCode();
    await store.createGame(code);
    const joined = await store.joinPlayer(code, { name: "Clara", avatar: 2 });
    if (!joined.ok) throw new Error("Beitritt fehlgeschlagen");
    const auth = await store.authenticatePlayer(code, joined.token);
    expect(auth.ok).toBe(true);
  });

  it("bedient die zusätzlichen Operationen der Spiellogik über das SDK", async () => {
    const port = upstashPort(new Redis({ url: fake.url, token: "test", automaticDeserialization: false, retry: false }));
    const key = `${prefix}:ops:${nextCode()}`;
    // Werte, die wie JSON oder Zahlen aussehen, müssen als Text zurückkommen (keine automatische Umwandlung).
    await port.set(key, '{"a":1}', 60);
    expect(await port.get(key)).toBe('{"a":1}');
    expect(await port.get(`${key}:fehlt`)).toBeNull();
    expect(await port.setIfAbsent(key, "neu", 60)).toBe(false);
    expect(await port.setIfAbsent(`${key}:neu`, "123", 60)).toBe(true);
    expect(await port.get(`${key}:neu`)).toBe("123");

    const hash = `${key}:hash`;
    expect(await port.hgetall(hash)).toEqual({});
    await port.hsetMany(hash, { eins: '{"x":1}', zwei: "2", drei: "true" }, 60);
    expect(await port.hgetall(hash)).toEqual({ eins: '{"x":1}', zwei: "2", drei: "true" });
    expect(await direct.ttl(hash)).toBeGreaterThan(0);
    await port.hsetMany(hash, {}, 60);
    await port.del(key, `${key}:neu`, hash);
    expect(await port.get(key)).toBeNull();
  });

  it("spielt ein ganzes Quiz mit der Engine über das SDK", async () => {
    const quiz: GameQuiz = {
      quizId: "q",
      title: "SDK",
      questions: [
        {
          id: "q1",
          type: "multiple_choice",
          prompt: "Farbe?",
          timeLimitSeconds: 20,
          maxPoints: 1000,
          options: [
            { id: "a", text: "Blau", isCorrect: false },
            { id: "b", text: "Rot", isCorrect: true },
          ],
          correctValue: null,
          unit: null,
          tolerance: null,
        },
        {
          id: "q2",
          type: "estimate",
          prompt: "PS?",
          timeLimitSeconds: 20,
          maxPoints: 1000,
          options: [],
          correctValue: 200,
          unit: "PS",
          tolerance: 100,
        },
      ],
    };
    const code = nextCode();
    expect(await store.createGame(code, quiz)).toBe(true);
    const ids: string[] = [];
    for (const name of ["Anna", "Beat"]) {
      const joined = await store.joinPlayer(code, { name, avatar: 1 });
      if (!joined.ok) throw new Error(joined.reason);
      ids.push(joined.player.id);
    }
    const saved: number[] = [];
    let clock = 1_000_000;
    const engine = new GameEngine(store, { now: () => clock, hooks: { onFinished: async (outcome) => void saved.push(outcome.finalRows.length) } });

    expect((await engine.start(code)).ok).toBe(true);
    clock += 1000;
    expect(await engine.answer(code, ids[0] as string, { q: 0, option: 1 }, null)).toEqual({ ok: true });
    expect(await engine.answer(code, ids[0] as string, { q: 0, option: 0 }, null)).toEqual({ ok: false, error: "already_answered" });
    expect(await engine.progress(code, 0)).toBe(1);
    expect(await engine.mine(code, ids[0] as string, 0)).toEqual({ option: 1 });
    expect(await engine.answer(code, ids[1] as string, { q: 0, option: 0 }, null)).toEqual({ ok: true });
    let state = await store.getState(code);
    expect(state?.phase).toBe("resolved");
    expect(state?.results[ids[0] as string]).toMatchObject({ correct: true, rank: 1 });
    expect(state?.results[ids[1] as string]).toMatchObject({ correct: false, rank: 2 });

    expect((await engine.next(code)).ok).toBe(true);
    clock += 500;
    await engine.answer(code, ids[0] as string, { q: 1, value: 190 }, null);
    await engine.answer(code, ids[1] as string, { q: 1, value: 200 }, null);
    state = await store.getState(code);
    expect(state?.phase).toBe("podium");
    expect(saved).toEqual([2]);
    expect((await engine.reveal(code)).ok).toBe(true);
    expect((await engine.reveal(code)).ok).toBe(true);
    state = await store.getState(code);
    expect(state?.podium?.ranking?.map((row) => row.name)).toEqual(["Anna", "Beat"]);
    expect((await engine.finish(code)).ok).toBe(true);
  });

});
