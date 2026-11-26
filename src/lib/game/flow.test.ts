/**
 * Gesamtablauf über echte WebSockets: Spieler, Beamer und Admin an zwei simulierten Funktionsinstanzen, dazu
 * Engine und Hub, alles gegen echtes Redis (TEST_REDIS_URL).
 */
import IORedis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ioredisPort } from "@/lib/realtime/redis-port";
import { GameStore } from "@/lib/realtime/store";
import { sleep, startTestInstance, TestSocket, until, type TestInstance } from "@/lib/realtime/testing/harness";
import { GameEngine } from "./engine";
import type { GameQuiz } from "./snapshot";

const redisUrl = process.env.TEST_REDIS_URL;
const SECRET = "ein sehr langes testgeheimnis fuer den ablauf";
const prefix = `f${Math.random().toString(36).slice(2, 10)}`;
let counter = 0;
const nextCode = () => String(500_000 + (counter += 1));

const quiz: GameQuiz = {
  quizId: "q",
  title: "Ablauf",
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
      type: "poll",
      prompt: "Tour?",
      timeLimitSeconds: 5,
      maxPoints: 0,
      options: [
        { id: "c", text: "Furka", isCorrect: false },
        { id: "d", text: "Grimsel", isCorrect: false },
      ],
      correctValue: null,
      unit: null,
      tolerance: null,
    },
  ],
};

describe.skipIf(!redisUrl)("Spielablauf über WebSockets", () => {
  let control: IORedis;
  let store: GameStore;
  const instances: TestInstance[] = [];
  const sockets: TestSocket[] = [];

  beforeAll(() => {
    control = new IORedis(redisUrl as string);
    store = new GameStore(ioredisPort(control), { prefix, tokenSecret: SECRET });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.ws.terminate();
    for (const instance of instances.splice(0)) await instance.stop();
  });

  afterAll(async () => {
    const keys = await control.keys(`${prefix}:*`);
    if (keys.length > 0) await control.del(...keys);
    control.disconnect();
  });

  async function instance(): Promise<TestInstance> {
    const engine = new GameEngine(store);
    const started = await startTestInstance({ store, redisUrl: redisUrl as string, controller: engine });
    instances.push(started);
    return started;
  }

  async function connect(target: TestInstance, role: "player" | "screen" | "admin", code: string, token?: string) {
    const socket = new TestSocket(role === "admin" ? `${target.url}/?admin=1` : target.url);
    sockets.push(socket);
    await socket.open();
    socket.hello(role, code, token);
    await until(() => socket.of("state").length >= 1, 3000, `Zustand für ${role}`);
    return socket;
  }

  async function newGame(players: string[]) {
    const code = nextCode();
    await store.createGame(code, quiz);
    const tokens: string[] = [];
    for (const name of players) {
      const joined = await store.joinPlayer(code, { name, avatar: 1 });
      if (!joined.ok) throw new Error(joined.reason);
      tokens.push(joined.token);
    }
    return { code, tokens };
  }

  it("führt Spieler, Beamer und Admin über zwei Instanzen durch ein Quiz", async () => {
    const [a, b] = [await instance(), await instance()];
    const { code, tokens } = await newGame(["Anna", "Beat"]);
    const admin = await connect(a, "admin", code);
    const screen = await connect(b, "screen", code);
    const anna = await connect(a, "player", code, tokens[0]);
    const beat = await connect(b, "player", code, tokens[1]);

    // Start durch den Admin. Antworten mit der erwarteten Version werden akzeptiert.
    admin.send({ type: "cmd", id: "c1", cmd: "start", expectedVersion: admin.lastState()?.version });
    await until(() => screen.lastState()?.phase === "question", 3000, "Frage auf dem Beamer");
    expect(admin.of("ack")[0]).toMatchObject({ id: "c1", ok: true });
    expect(beat.lastState()?.question?.prompt).toBe("Farbe?");

    // Anna antwortet: Der Beamer sieht den Fortschritt, die Handys nicht.
    anna.send({ type: "answer", id: "a1", q: 0, option: 1 });
    await until(() => screen.of("progress").some((m) => m.n === 1), 3000, "Fortschritt 1");
    expect(anna.of("ack")[0]).toMatchObject({ id: "a1", ok: true });
    expect(beat.of("progress")).toHaveLength(0);
    // Doppelte Antwort wird abgelehnt.
    anna.send({ type: "answer", id: "a2", q: 0, option: 0 });
    await until(() => anna.of("ack").length === 2, 3000, "zweite Quittung");
    expect(anna.of("ack")[1]).toMatchObject({ id: "a2", ok: false, error: "already_answered" });

    // Beats Antwort ist die letzte, die Frage löst sich von selbst auf, ohne Befehl des Admins.
    beat.send({ type: "answer", id: "b1", q: 0, option: 0 });
    await until(() => screen.lastState()?.phase === "resolved", 3000, "automatische Auflösung");
    const resolved = anna.lastState();
    expect(resolved?.results[Object.keys(resolved.results)[0] as string]).toBeDefined();
    expect(screen.lastState()?.resolution?.distribution).toEqual([1, 1]);

    // Nächste Frage (Umfrage), Admin löst manuell auf, danach das verdeckte Podest.
    admin.send({ type: "cmd", id: "c2", cmd: "next", expectedVersion: admin.lastState()?.version });
    await until(() => screen.lastState()?.phase === "question", 3000, "Umfrage");
    anna.send({ type: "answer", q: 1, option: 0 });
    await sleep(100);
    admin.send({ type: "cmd", id: "c3", cmd: "resolve" });
    await until(() => screen.lastState()?.phase === "podium", 3000, "Podest");
    expect(screen.lastState()?.podium).toMatchObject({ revealed: 0, places: [], ranking: null });
  });

  it("nimmt Befehle nur vom Admin an und Antworten nur von Spielern", async () => {
    const a = await instance();
    const { code, tokens } = await newGame(["Anna"]);
    const screen = await connect(a, "screen", code);
    const anna = await connect(a, "player", code, tokens[0]);

    anna.send({ type: "cmd", id: "x1", cmd: "start" });
    screen.send({ type: "cmd", id: "x2", cmd: "start" });
    screen.send({ type: "answer", id: "x3", q: 0, option: 0 });
    await until(() => anna.of("ack").length === 1 && screen.of("ack").length === 2, 3000, "Quittungen");
    expect(anna.of("ack")[0]).toMatchObject({ ok: false, error: "forbidden" });
    expect(screen.of("ack").map((m) => m.error)).toEqual(["forbidden", "forbidden"]);
    expect((await store.getState(code))?.phase).toBe("lobby");
  });

  it("nimmt vor der Anmeldung keine Spielnachrichten an", async () => {
    const a = await instance();
    const { code } = await newGame(["Anna"]);
    const socket = new TestSocket(a.url);
    sockets.push(socket);
    await socket.open();
    socket.send({ type: "cmd", cmd: "start" });
    await until(() => socket.closed !== null, 3000, "Schliessen");
    expect(socket.closed?.code).toBe(4001);
    expect((await store.getState(code))?.phase).toBe("lobby");
  });

  it("löst nach dem Zeithinweis eines Geräts auf, aber nicht vor Ablauf der Frist", async () => {
    const a = await instance();
    const { code, tokens } = await newGame(["Anna", "Beat"]);
    const admin = await connect(a, "admin", code);
    const screen = await connect(a, "screen", code);
    const anna = await connect(a, "player", code, tokens[0]);
    admin.send({ type: "cmd", cmd: "start" });
    await until(() => screen.lastState()?.phase === "question", 3000, "Frage");
    anna.send({ type: "answer", q: 0, option: 1 });
    await sleep(50);
    // Zu früh: Der Server prüft die Frist selbst und ignoriert den Hinweis.
    screen.send({ type: "tick" });
    await sleep(200);
    expect(screen.lastState()?.phase).toBe("question");
    // Nach Ablauf der Frist (5 Sekunden Zeitlimit) wirkt der Hinweis.
    const deadline = screen.lastState()?.question?.deadline ?? 0;
    await sleep(Math.max(0, deadline - Date.now()) + 50);
    screen.send({ type: "tick" });
    await until(() => screen.lastState()?.phase === "resolved", 3000, "Auflösung nach Ablauf");
    expect(screen.lastState()?.resolution?.answered).toBe(1);
  }, 15_000);

  it("meldet nach einer Wiederverbindung die eigene Antwort und den Fortschritt", async () => {
    const [a, b] = [await instance(), await instance()];
    const { code, tokens } = await newGame(["Anna", "Beat"]);
    const admin = await connect(a, "admin", code);
    const anna = await connect(a, "player", code, tokens[0]);
    admin.send({ type: "cmd", cmd: "start" });
    await until(() => anna.lastState()?.phase === "question", 3000, "Frage");
    anna.send({ type: "answer", q: 0, option: 1 });
    await until(() => anna.of("ack").length === 1, 3000, "Quittung");
    anna.ws.terminate();

    const again = await connect(b, "player", code, tokens[0]);
    await until(() => again.of("mine").length === 1, 3000, "eigene Antwort");
    expect(again.of("mine")[0]).toMatchObject({ q: 0, option: 1 });
    const screen = await connect(b, "screen", code);
    await until(() => screen.of("progress").length === 1, 3000, "Fortschritt");
    expect(screen.of("progress")[0]).toMatchObject({ q: 0, n: 1 });
  });

  it("lässt Bubbles im Warteraum hüpfen, höchstens einmal in zwei Sekunden, nur Beamer und Admin sehen es", async () => {
    const a = await instance();
    const { code, tokens } = await newGame(["Anna", "Beat"]);
    const screen = await connect(a, "screen", code);
    const anna = await connect(a, "player", code, tokens[0]);
    const beat = await connect(a, "player", code, tokens[1]);
    anna.send({ type: "nudge" });
    anna.send({ type: "nudge" });
    anna.send({ type: "nudge" });
    await until(() => screen.of("nudge").length >= 1, 3000, "Sprung");
    await sleep(200);
    expect(screen.of("nudge")).toHaveLength(1);
    expect(beat.of("nudge")).toHaveLength(0);
    expect(anna.of("nudge")).toHaveLength(0);
  });

  it("ignoriert das Hüpfen ausserhalb des Warteraums", async () => {
    const a = await instance();
    const { code, tokens } = await newGame(["Anna"]);
    const admin = await connect(a, "admin", code);
    const screen = await connect(a, "screen", code);
    const anna = await connect(a, "player", code, tokens[0]);
    admin.send({ type: "cmd", cmd: "start" });
    await until(() => screen.lastState()?.phase === "question", 3000, "Frage");
    anna.send({ type: "nudge" });
    await sleep(200);
    expect(screen.of("nudge")).toHaveLength(0);
  });
});
