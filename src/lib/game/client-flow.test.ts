/**
 * Der Browser Client im Zusammenspiel mit Hub und Engine: Quittungen, Zeithinweise, Erneuerung der Verbindung
 * nach der Auflösung und Wiederaufnahme der eigenen Antwort. Echte WebSockets, echtes Redis (TEST_REDIS_URL).
 */
import IORedis from "ioredis";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RealtimeClient, type ClientEvent, type ClientTiming, type SocketLike } from "@/lib/realtime/client";
import type { PublicGameState } from "@/lib/realtime/game-state";
import type { Role } from "@/lib/realtime/protocol";
import { ioredisPort } from "@/lib/realtime/redis-port";
import { GameStore } from "@/lib/realtime/store";
import { sleep, startTestInstance, until, type TestInstance } from "@/lib/realtime/testing/harness";
import { GameEngine } from "./engine";
import type { GameQuiz } from "./snapshot";

const redisUrl = process.env.TEST_REDIS_URL;
const SECRET = "ein sehr langes testgeheimnis fuer den client ablauf";
const prefix = `g${Math.random().toString(36).slice(2, 10)}`;
let counter = 0;
const nextCode = () => String(600_000 + (counter += 1));

const FAST: Partial<ClientTiming> = {
  backoffBaseMs: 20,
  backoffMaxMs: 200,
  handshakeTimeoutMs: 800,
  pingCount: 2,
  pingIntervalMs: 20,
  heartbeatMs: 10_000,
  maxAgeMs: 600_000,
  ackTimeoutMs: 1500,
  tickRetryMs: 300,
};

const quiz: GameQuiz = {
  quizId: "q",
  title: "Client",
  questions: [
    {
      id: "q1",
      type: "multiple_choice",
      prompt: "Farbe?",
      timeLimitSeconds: 5,
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
      timeLimitSeconds: 5,
      maxPoints: 1000,
      options: [],
      correctValue: 200,
      unit: "PS",
      tolerance: 100,
    },
  ],
};

describe.skipIf(!redisUrl)("RealtimeClient im Spielablauf", () => {
  let control: IORedis;
  let store: GameStore;
  const instances: TestInstance[] = [];
  const clients: RealtimeClient[] = [];

  beforeAll(() => {
    control = new IORedis(redisUrl as string);
    store = new GameStore(ioredisPort(control), { prefix, tokenSecret: SECRET });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.stop();
    for (const instance of instances.splice(0)) await instance.stop();
  });

  afterAll(async () => {
    const keys = await control.keys(`${prefix}:*`);
    if (keys.length > 0) await control.del(...keys);
    control.disconnect();
  });

  async function instance(): Promise<TestInstance> {
    const started = await startTestInstance({ store, redisUrl: redisUrl as string, controller: new GameEngine(store) });
    instances.push(started);
    return started;
  }

  async function newGame(names: string[]) {
    const code = nextCode();
    await store.createGame(code, quiz);
    const tokens: string[] = [];
    for (const name of names) {
      const joined = await store.joinPlayer(code, { name, avatar: 0 });
      if (!joined.ok) throw new Error(joined.reason);
      tokens.push(joined.token);
    }
    return { code, tokens };
  }

  function make(
    target: TestInstance,
    role: Role,
    code: string,
    token?: string,
    extra: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {},
  ) {
    const states: PublicGameState[] = [];
    const events: ClientEvent[] = [];
    const url = role === "admin" ? `${target.url}/?admin=1` : target.url;
    const client = new RealtimeClient({
      url,
      role,
      code,
      ...(token ? { token } : {}),
      createSocket: (u) => new WebSocket(u) as unknown as SocketLike,
      onState: (state) => states.push(state),
      onEvent: (event) => events.push(event),
      timing: FAST,
      ...extra,
    });
    clients.push(client);
    return { client, states, events };
  }

  const phase = (client: RealtimeClient) => client.getState()?.phase;

  it("quittiert Befehle und Antworten und meldet Fehler", async () => {
    const a = await instance();
    const { code, tokens } = await newGame(["Anna", "Beat"]);
    const admin = make(a, "admin", code);
    const anna = make(a, "player", code, tokens[0]);
    admin.client.start();
    anna.client.start();
    await until(() => admin.client.getStatus() === "open" && anna.client.getStatus() === "open", 3000, "verbunden");

    expect(await anna.client.command("start")).toEqual({ ok: false, error: "forbidden" });
    expect(await admin.client.command("start", admin.client.getState()?.version)).toEqual({ ok: true });
    await until(() => phase(anna.client) === "question", 3000, "Frage");
    expect(await anna.client.answer(0, { option: 1 })).toEqual({ ok: true });
    expect(await anna.client.answer(0, { option: 0 })).toEqual({ ok: false, error: "already_answered" });
    expect(await anna.client.answer(5, { option: 0 })).toEqual({ ok: false, error: "stale" });
  });

  it("meldet ohne Verbindung sofort einen Fehler", async () => {
    const a = await instance();
    const { code, tokens } = await newGame(["Anna"]);
    const anna = make(a, "player", code, tokens[0]);
    expect(await anna.client.answer(0, { option: 1 })).toEqual({ ok: false, error: "offline" });
    anna.client.start();
    await until(() => anna.client.getStatus() === "open", 3000, "verbunden");
    anna.client.stop();
    expect(await anna.client.answer(0, { option: 1 })).toEqual({ ok: false, error: "offline" });
  });

  it("löst nach Ablauf der Frist über den Zeithinweis auf, ohne dass der Admin etwas tut", async () => {
    const a = await instance();
    const { code, tokens } = await newGame(["Anna", "Beat"]);
    const admin = make(a, "admin", code);
    const screen = make(a, "screen", code, undefined, { autoTick: { extraDelayMs: 0 } });
    const anna = make(a, "player", code, tokens[0]);
    for (const handle of [admin, screen, anna]) handle.client.start();
    await until(() => [admin, screen, anna].every((h) => h.client.getStatus() === "open"), 3000, "verbunden");

    await admin.client.command("start");
    await until(() => phase(screen.client) === "question", 3000, "Frage");
    await anna.client.answer(0, { option: 1 });
    // Beat antwortet nie. Nach 5 Sekunden löst der Beamer über den Zeithinweis auf.
    await until(() => phase(screen.client) === "resolved", 9000, "Auflösung durch Zeithinweis");
    expect(screen.client.getState()?.resolution?.answered).toBe(1);
    expect(anna.client.getState()?.results).toBeDefined();
  }, 15_000);

  it("zeigt dem Beamer den Fortschritt und meldet die eigene Antwort nach der Wiederverbindung", async () => {
    const [a, b] = [await instance(), await instance()];
    const { code, tokens } = await newGame(["Anna", "Beat"]);
    const progress: { q: number; n: number }[] = [];
    const mine: { q: number; option?: number; value?: number }[] = [];
    const admin = make(a, "admin", code);
    const screen = make(b, "screen", code, undefined, { onProgress: (p) => progress.push(p) });
    const anna = make(a, "player", code, tokens[0], { onMine: (m) => mine.push(m) });
    for (const handle of [admin, screen, anna]) handle.client.start();
    await until(() => [admin, screen, anna].every((h) => h.client.getStatus() === "open"), 3000, "verbunden");
    await admin.client.command("start");
    await until(() => phase(anna.client) === "question", 3000, "Frage");

    await anna.client.answer(0, { option: 1 });
    await until(() => progress.some((p) => p.n === 1), 3000, "Fortschritt");

    anna.client.simulateDrop();
    await until(() => mine.length >= 1, 4000, "eigene Antwort nach Wiederverbindung");
    expect(mine[0]).toEqual({ q: 0, option: 1 });
  });

  it("baut die Verbindung nach der Auflösung kontrolliert neu auf", async () => {
    const a = await instance();
    const { code, tokens } = await newGame(["Anna"]);
    const admin = make(a, "admin", code);
    const anna = make(a, "player", code, tokens[0], { rotateAfterResolveMs: 100 });
    admin.client.start();
    anna.client.start();
    await until(() => admin.client.getStatus() === "open" && anna.client.getStatus() === "open", 3000, "verbunden");
    await admin.client.command("start");
    await until(() => phase(anna.client) === "question", 3000, "Frage");
    const acceptedBefore = a.accepted();
    await anna.client.answer(0, { option: 1 });
    await until(() => phase(anna.client) === "podium" || phase(anna.client) === "resolved", 3000, "aufgelöst");
    await until(() => anna.events.some((e) => e.type === "rotate" && e.why === "after_resolution"), 3000, "Neuaufbau");
    await until(() => anna.events.filter((e) => e.type === "ready" && e.reason === "rotate").length === 1, 3000, "neue Verbindung bereit");
    expect(a.accepted()).toBeGreaterThan(acceptedBefore);
    // Der Spieler bleibt dabei verbunden und kennt weiterhin den aktuellen Zustand.
    expect(anna.client.getStatus()).toBe("open");
    expect(phase(anna.client)).not.toBe("question");
    await sleep(50);
  });
});
