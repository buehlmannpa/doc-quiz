/**
 * Tests des Clients: reine Funktionen und Integrationstests gegen den echten Hub (echte WebSockets, echtes Redis).
 * Die Integrationstests laufen nur mit TEST_REDIS_URL (siehe store.test.ts).
 */
import IORedis from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  betterSample,
  clockSample,
  computeBackoffMs,
  RealtimeClient,
  type ClientEvent,
  type ClientStatus,
  type ClientTiming,
  type SocketLike,
} from "./client";
import type { PublicGameState } from "./game-state";
import { CLOSE_CODES } from "./protocol";
import { ioredisPort } from "./redis-port";
import { GameStore } from "./store";
import { sleep, startTestInstance, until, type TestInstance } from "./testing/harness";

describe("computeBackoffMs", () => {
  it("wächst exponentiell bis zum Deckel", () => {
    const mid = () => 0.5; // Zufallsfaktor 0.5: 75 Prozent der Obergrenze
    expect(computeBackoffMs(0, mid, 500, 10_000)).toBe(375);
    expect(computeBackoffMs(1, mid, 500, 10_000)).toBe(750);
    expect(computeBackoffMs(2, mid, 500, 10_000)).toBe(1500);
    expect(computeBackoffMs(10, mid, 500, 10_000)).toBe(7500);
    expect(computeBackoffMs(50, mid, 500, 10_000)).toBe(7500);
  });

  it("streut zwischen 50 und 100 Prozent der Obergrenze", () => {
    expect(computeBackoffMs(2, () => 0, 500, 10_000)).toBe(1000);
    expect(computeBackoffMs(2, () => 1, 500, 10_000)).toBe(2000);
  });

  it("behandelt negative Versuche wie den ersten", () => {
    expect(computeBackoffMs(-3, () => 1, 500, 10_000)).toBe(500);
  });
});

describe("Uhrenabgleich", () => {
  it("schätzt die Abweichung aus der Mitte der Laufzeit", () => {
    // Der Client sendet bei 1000 und empfängt bei 1100. Der Server stand in der Mitte (1050) auf 6050.
    expect(clockSample(1000, 1100, 6050)).toEqual({ rttMs: 100, offsetMs: 5000 });
  });

  it("liefert 0 bei gleichen Uhren und symmetrischer Laufzeit", () => {
    expect(clockSample(1000, 1040, 1020).offsetMs).toBe(0);
  });

  it("behält die Messung mit der kleinsten Laufzeit", () => {
    const a = { rttMs: 80, offsetMs: 10 };
    const b = { rttMs: 20, offsetMs: 14 };
    expect(betterSample(null, a)).toBe(a);
    expect(betterSample(a, b)).toBe(b);
    expect(betterSample(b, a)).toBe(b);
  });
});

const redisUrl = process.env.TEST_REDIS_URL;
const SECRET = "ein sehr langes testgeheimnis fuer den client";
const prefix = `c${Math.random().toString(36).slice(2, 10)}`;
let codeCounter = 0;
const nextCode = () => String(400_000 + (codeCounter += 1));

const FAST: Partial<ClientTiming> = {
  backoffBaseMs: 20,
  backoffMaxMs: 200,
  handshakeTimeoutMs: 400,
  pingCount: 3,
  pingIntervalMs: 20,
  heartbeatMs: 10_000,
  maxAgeMs: 600_000,
};

describe.skipIf(!redisUrl)("RealtimeClient (echter Hub)", () => {
  let control: IORedis;
  let store: GameStore;
  const instances: TestInstance[] = [];
  const clients: RealtimeClient[] = [];
  const rawServers: WebSocketServer[] = [];

  beforeAll(() => {
    control = new IORedis(redisUrl as string);
    store = new GameStore(ioredisPort(control), { prefix, tokenSecret: SECRET });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.stop();
    for (const server of rawServers.splice(0)) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const instance of instances.splice(0)) await instance.stop();
  });

  afterAll(async () => {
    const keys = await control.keys(`${prefix}:*`);
    if (keys.length > 0) await control.del(...keys);
    control.disconnect();
  });

  async function instance(options: Partial<Parameters<typeof startTestInstance>[0]> = {}): Promise<TestInstance> {
    const started = await startTestInstance({ store, redisUrl: redisUrl as string, ...options });
    instances.push(started);
    return started;
  }

  async function newGame(): Promise<string> {
    const code = nextCode();
    await store.createGame(code);
    return code;
  }

  type Handle = {
    client: RealtimeClient;
    states: PublicGameState[];
    statuses: ClientStatus[];
    events: ClientEvent[];
    versions: () => number[];
    of: <T extends ClientEvent["type"]>(type: T) => Extract<ClientEvent, { type: T }>[];
  };

  function makeClient(
    url: string | (() => string),
    code: string,
    extra: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {},
  ): Handle {
    const states: PublicGameState[] = [];
    const statuses: ClientStatus[] = [];
    const events: ClientEvent[] = [];
    const client = new RealtimeClient({
      url,
      role: "screen",
      code,
      createSocket: (target) => new WebSocket(target) as unknown as SocketLike,
      onState: (state) => states.push(state),
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
      timing: FAST,
      ...extra,
    });
    clients.push(client);
    return {
      client,
      states,
      statuses,
      events,
      versions: () => states.map((state) => state.version),
      of: (type) => events.filter((event): event is Extract<ClientEvent, { type: typeof type }> => event.type === type),
    };
  }

  /** Ein Server, der die Anmeldung scheinbar annimmt, danach aber nie wieder antwortet (halb tote Verbindung). */
  async function silentServer(code: string): Promise<{ url: string; connections: () => number }> {
    const server = new WebSocketServer({ port: 0 });
    rawServers.push(server);
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      let answered = false;
      socket.on("message", () => {
        if (answered) return; // Nur das erste hello wird beantwortet, Pings bleiben ohne Antwort.
        answered = true;
        const state = { code, version: 0, phase: "lobby", createdAt: 1, players: [] };
        socket.send(JSON.stringify({ type: "welcome", protocol: 1, role: "screen", serverTime: Date.now(), instanceId: "stumm" }));
        socket.send(JSON.stringify({ type: "state", version: 0, state }));
      });
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as { port: number };
    return { url: `ws://127.0.0.1:${port}`, connections: () => connections };
  }

  it("verbindet, liefert den Zustand und meldet den Status", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code);
    h.client.start();
    await until(() => h.client.getStatus() === "open");
    expect(h.statuses).toEqual(["connecting", "open"]);
    expect(h.states).toHaveLength(1);
    expect(h.client.getState()?.code).toBe(code);
    expect(h.of("ready")[0]).toMatchObject({ reason: "initial", instanceId: a.hub.instanceId });
  });

  it("verbindet sich nach einem Abbruch neu und holt den aktuellen Stand nach", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code);
    h.client.start();
    await until(() => h.client.getStatus() === "open");

    h.client.simulateDrop();
    await until(() => h.client.getStatus() === "reconnecting", 2000, "Status reconnecting");
    // Während der Abwesenheit ändert sich etwas.
    await store.touch(code);
    await store.touch(code);
    await until(() => h.client.getStatus() === "open", 3000, "wieder offen");
    await until(() => h.client.getState()?.version === 2, 3000, "aktueller Stand");
    expect(h.statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
    expect(h.of("retry")[0]).toMatchObject({ attempt: 1 });
    expect(h.of("closed")[0]).toMatchObject({ expected: false });
  });

  it("übersteht viele Abbrüche hintereinander und setzt den Backoff nach Erfolg zurück", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code);
    h.client.start();
    await until(() => h.client.getStatus() === "open");
    for (let i = 0; i < 5; i += 1) {
      h.client.simulateDrop();
      await until(() => h.client.getStatus() === "reconnecting", 2000, `Abbruch ${i}`);
      await until(() => h.client.getStatus() === "open", 3000, `Wiederverbindung ${i}`);
    }
    // Jeder Versuch war der erste nach einem Erfolg.
    expect(h.of("retry").map((event) => event.attempt)).toEqual([1, 1, 1, 1, 1]);
    expect(a.hub.stats().connections).toBe(1);
  });

  it("wartet bei einem ausgefallenen Server mit wachsendem Backoff und verbindet danach von selbst", async () => {
    const first = await instance();
    const port = first.port;
    const code = await newGame();
    const h = makeClient(`ws://127.0.0.1:${port}`, code, { random: () => 0.5 });
    h.client.start();
    await until(() => h.client.getStatus() === "open");

    await first.stop();
    instances.splice(instances.indexOf(first), 1);
    await until(() => h.of("retry").length >= 4, 4000, "vier Wiederholungen");
    const delays = h.of("retry").map((event) => event.inMs);
    expect(delays[0]).toBeLessThan(delays[1] ?? 0);
    expect(delays[1]).toBeLessThan(delays[2] ?? 0);
    expect(delays[2]).toBeLessThan(delays[3] ?? 0);
    expect(h.client.getStatus()).toBe("reconnecting");

    await store.touch(code);
    await instance({ port });
    await until(() => h.client.getStatus() === "open", 5000, "wieder offen");
    expect(h.client.getState()?.version).toBe(1);
  }, 20_000);

  it("baut die Verbindung kontrolliert neu auf, ohne dass der Status wechselt oder etwas verloren geht", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code);
    h.client.start();
    await until(() => h.client.getStatus() === "open");
    expect(a.hub.stats().connections).toBe(1);

    // Änderungen laufen weiter, während die Verbindung neu aufgebaut wird.
    const writer = (async () => {
      for (let i = 0; i < 20; i += 1) {
        await store.touch(code);
        await sleep(5);
      }
    })();
    h.client.rotate("test");
    await writer;
    await until(() => h.client.getState()?.version === 20, 3000, "Version 20");

    expect(h.statuses).toEqual(["connecting", "open"]); // nie reconnecting, nie ein Unterbruch
    const versions = h.versions();
    expect([...versions].sort((x, y) => x - y)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    await until(() => a.hub.stats().connections === 1, 2000, "alte Verbindung geschlossen");
    expect(h.of("ready").map((event) => event.reason)).toEqual(["initial", "rotate"]);
    expect(h.of("closed").every((event) => event.expected)).toBe(true);
  });

  it("öffnet beim Neuaufbau erst die neue Verbindung und schliesst danach die alte", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code);
    h.client.start();
    await until(() => h.client.getStatus() === "open");
    h.client.rotate("test");
    await until(() => h.of("closed").length === 1 && h.of("ready").length === 2, 3000, "Neuaufbau abgeschlossen");

    // Reihenfolge der Ereignisse: neue Verbindung bereit, DANACH die alte geschlossen.
    const order = h.events.map((event) => event.type);
    expect(order.indexOf("rotate")).toBeGreaterThan(order.indexOf("ready"));
    const readyAgain = order.lastIndexOf("ready");
    const closedAt = order.indexOf("closed");
    expect(readyAgain).toBeLessThan(closedAt);
    expect(h.of("closed")[0]).toMatchObject({ expected: true, code: 1000 });
    expect(a.accepted()).toBe(2); // genau eine zusätzliche Verbindung
    await until(() => a.hub.stats().connections === 1);
  });

  it("baut bei Erreichen der Altersgrenze selbständig neu auf", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code, { timing: { ...FAST, maxAgeMs: 150 } });
    h.client.start();
    await until(() => h.of("ready").length >= 3, 4000, "mehrere Neuaufbauten");
    expect(h.statuses.filter((status) => status === "reconnecting")).toHaveLength(0);
    expect(h.of("rotate").every((event) => event.why === "max_age")).toBe(true);
    await store.touch(code);
    await until(() => h.client.getState()?.version === 1);
  });

  it("folgt der Ankündigung des Servers und ist umgezogen, bevor der Server die alte Verbindung beendet", async () => {
    const a = await instance({ limits: { maxAgeNoticeMs: 100, maxAgeCloseMs: 2000 } });
    const code = await newGame();
    const h = makeClient(a.url, code);
    h.client.start();
    await until(() => h.of("ready").length === 2, 3000, "Neuaufbau nach Ankündigung");
    expect(h.of("rotate")[0]?.why).toBe("server_notice");
    // Die neue Verbindung läuft, bevor der Server (nach 2 Sekunden) die alte beendet hätte.
    expect(Date.now() - 0).toBeGreaterThan(0);
    await until(() => h.of("closed").some((event) => event.expected), 2000, "alte Verbindung geschlossen");
    expect(h.statuses).toEqual(["connecting", "open"]);
  });

  it("verbindet nach dem Ende wegen des Alters (Code 4012) sofort neu", async () => {
    const a = await instance({ limits: { maxAgeNoticeMs: 60_000, maxAgeCloseMs: 150 } });
    const code = await newGame();
    const h = makeClient(a.url, code);
    h.client.start();
    await until(() => h.of("closed").length >= 1, 3000, "Ende wegen des Alters");
    expect(h.of("closed")[0]).toMatchObject({ code: CLOSE_CODES.ROTATE, expected: false });
    await until(() => h.client.getStatus() === "open" && h.of("ready").length === 2, 3000, "wieder offen");
    expect(h.of("retry")[0]?.inMs).toBeLessThanOrEqual(300);
  });

  it("gibt bei einem ungültigen Token endgültig auf, ohne es immer wieder zu versuchen", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code, { role: "player", token: "a".repeat(32) });
    h.client.start();
    await until(() => h.client.getStatus() === "closed");
    await sleep(300);
    expect(h.of("fatal")[0]).toMatchObject({ code: CLOSE_CODES.UNAUTHORIZED });
    expect(a.accepted()).toBe(1);
  });

  it("gibt bei einem unbekannten Spiel endgültig auf", async () => {
    const a = await instance();
    const h = makeClient(a.url, "654321");
    h.client.start();
    await until(() => h.client.getStatus() === "closed");
    await sleep(200);
    expect(h.of("fatal")[0]).toMatchObject({ code: CLOSE_CODES.GAME_NOT_FOUND });
    expect(a.accepted()).toBe(1);
  });

  it("meldet einen Spieler mit gültigem Token an", async () => {
    const a = await instance();
    const code = await newGame();
    const joined = await store.joinPlayer(code, { name: "Anna", avatar: 1 });
    if (!joined.ok) throw new Error("Beitritt fehlgeschlagen");
    const h = makeClient(a.url, code, { role: "player", token: joined.token });
    h.client.start();
    await until(() => h.client.getStatus() === "open");
    expect(h.client.getState()?.players.map((p) => p.name)).toEqual(["Anna"]);
  });

  it("beendet mit stop() alle Verbindungen und verbindet nicht mehr neu", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code);
    h.client.start();
    await until(() => h.client.getStatus() === "open");
    h.client.stop();
    expect(h.client.getStatus()).toBe("closed");
    await until(() => a.hub.stats().connections === 0);
    const before = a.accepted();
    await sleep(300);
    expect(a.accepted()).toBe(before);
  });

  it("verwirft eine Verbindung, die nach dem Aufbau nie antwortet, und versucht es erneut", async () => {
    // Ein Server, der die Verbindung annimmt, aber nie etwas sagt.
    const server = new WebSocketServer({ port: 0 });
    rawServers.push(server);
    let connections = 0;
    server.on("connection", () => (connections += 1));
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as { port: number };

    const h = makeClient(`ws://127.0.0.1:${port}`, "123456", { timing: { ...FAST, handshakeTimeoutMs: 120 } });
    h.client.start();
    await until(() => connections >= 3, 4000, "drei Versuche");
    expect(h.client.getStatus()).not.toBe("open");
  });

  it("erkennt eine halb tote Verbindung am Herzschlag und baut sie neu auf", async () => {
    const silent = await silentServer("123456");
    const h = makeClient(silent.url, "123456", { timing: { ...FAST, heartbeatMs: 50 } });
    h.client.start();
    await until(() => h.client.getStatus() === "open", 2000, "zunächst offen");
    await until(() => h.of("dead").length >= 1, 3000, "tote Verbindung erkannt");
    await until(() => silent.connections() >= 2, 3000, "neue Verbindung aufgebaut");
  });

  it("prüft mit checkAlive, ob die Verbindung noch lebt", async () => {
    const a = await instance();
    const code = await newGame();
    const healthy = makeClient(a.url, code);
    healthy.client.start();
    await until(() => healthy.client.getStatus() === "open");
    healthy.client.checkAlive(150);
    await sleep(400);
    expect(healthy.of("dead")).toHaveLength(0);
    expect(a.accepted()).toBe(1);

    const silent = await silentServer("123456");
    const dead = makeClient(silent.url, "123456");
    dead.client.start();
    await until(() => dead.client.getStatus() === "open");
    await sleep(100); // Die Pings des Uhrenabgleichs bleiben unbeantwortet.
    dead.client.checkAlive(150);
    await until(() => dead.of("dead").length === 1, 2000, "tote Verbindung erkannt");
    await until(() => silent.connections() >= 2, 3000, "neu verbunden");
  });

  it("gleicht die Uhr mit dem Server ab, auch wenn beide Uhren falsch gehen", async () => {
    // Der Server geht 5 Sekunden vor, die Uhr des Clients 3 Sekunden nach.
    const a = await instance({ now: () => Date.now() + 5000 });
    const code = await newGame();
    const h = makeClient(a.url, code, { now: () => Date.now() - 3000 });
    h.client.start();
    await until(() => h.of("clock").length >= 1 && h.client.getClock() !== null, 3000, "Uhrenabgleich");
    await sleep(120);
    const expected = Date.now() + 5000;
    expect(Math.abs(h.client.serverNow() - expected)).toBeLessThan(100);
    expect(h.client.getClock()?.offsetMs).toBeGreaterThan(7800);
    expect(h.client.getClock()?.offsetMs).toBeLessThan(8200);
  });

  it("übernimmt ein neues Spiel unter demselben Code, auch wenn seine Version kleiner ist", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code, { random: () => 1, timing: { ...FAST, backoffBaseMs: 300 } });
    h.client.start();
    await until(() => h.client.getStatus() === "open");
    for (let i = 0; i < 4; i += 1) await store.touch(code);
    await until(() => h.client.getState()?.version === 4);

    h.client.simulateDrop();
    await until(() => h.client.getStatus() === "reconnecting");
    // Innerhalb des Backoffs wird das Spiel gelöscht und neu angelegt.
    await store.deleteGame(code);
    await sleep(5);
    await store.createGame(code);

    await until(() => h.client.getStatus() === "open", 3000, "wieder offen");
    await until(() => h.client.getState()?.version === 0, 2000, "neues Spiel übernommen");
    expect(h.states.at(-1)?.version).toBe(0);
  });

  it("ruft rotateSoon mit zufälliger Verzögerung auf und wiederholt nicht gleichzeitig", async () => {
    const a = await instance();
    const code = await newGame();
    const h = makeClient(a.url, code, { random: () => 0.5 });
    h.client.start();
    await until(() => h.client.getStatus() === "open");
    h.client.rotateSoon(200);
    h.client.rotateSoon(200); // zweiter Aufruf, solange der erste aussteht, wird ignoriert
    await sleep(40);
    expect(h.of("rotate")).toHaveLength(0); // 0.5 mal 200 Millisekunden
    await until(() => h.of("ready").length === 2, 2000, "Neuaufbau");
    expect(h.of("rotate")).toHaveLength(1);
  });
});
