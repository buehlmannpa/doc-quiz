/**
 * Integrationstests des Hubs: echte WebSockets, echtes Redis, zwei simulierte Funktionsinstanzen.
 * Laufen nur mit TEST_REDIS_URL (siehe store.test.ts). Kein WebSocket Upgrade von Next.js nötig, die Tests
 * hängen den Hub an einen eigenen WebSocketServer, genau wie es der Endpunkt mit upgradeWebSocket tut.
 */
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import IORedis from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RealtimeHub, type HubLimits } from "./hub";
import { CLOSE_CODES, serverMessageSchema, type ServerMessage } from "./protocol";
import { ioredisPort } from "./redis-port";
import { GameStore } from "./store";
import { ioredisSubscriber, type SubscriberPort } from "./subscriber";

const redisUrl = process.env.TEST_REDIS_URL;
const SECRET = "ein sehr langes testgeheimnis fuer den hub";
const prefix = `h${Math.random().toString(36).slice(2, 10)}`;
let codeCounter = 0;
const nextCode = () => String(300_000 + (codeCounter += 1));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wartet, bis eine Bedingung wahr ist. */
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 3000, what = "Bedingung"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`Zeitüberschreitung beim Warten auf: ${what}`);
}

class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      this.messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.ws.on("error", () => {});
  }

  async open(): Promise<this> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        this.ws.once("open", () => resolve());
        this.ws.once("error", reject);
      });
    }
    return this;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  hello(role: "player" | "screen" | "admin", code: string, token?: string): void {
    this.send({ type: "hello", protocol: 1, role, code, ...(token ? { token } : {}) });
  }

  states() {
    return this.messages.flatMap((message) => (message.type === "state" ? [message] : []));
  }

  versions(): number[] {
    return this.states().map((message) => message.version);
  }

  lastVersion(): number {
    return this.versions().at(-1) ?? -1;
  }

  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  }

  async waitForClose(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    await until(() => this.closed !== null, timeoutMs, "Schliessen der Verbindung");
    return this.closed as { code: number; reason: string };
  }

  close(): void {
    this.ws.close();
  }
}

type Instance = {
  hub: RealtimeHub;
  url: string;
  subscriber: SubscriberPort;
  redis: IORedis;
  stop: () => Promise<void>;
};

describe.skipIf(!redisUrl)("RealtimeHub (echte WebSockets, echtes Redis)", () => {
  let control: IORedis;
  let store: GameStore;
  const instances: Instance[] = [];
  const clients: TestClient[] = [];

  beforeAll(() => {
    control = new IORedis(redisUrl as string);
    store = new GameStore(ioredisPort(control), { prefix, tokenSecret: SECRET });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate();
    for (const instance of instances.splice(0)) await instance.stop();
  });

  afterAll(async () => {
    const keys = await control.keys(`${prefix}:*`);
    if (keys.length > 0) await control.del(...keys);
    control.disconnect();
  });

  /**
   * Startet eine simulierte Funktionsinstanz: eigener Hub, eigener Subscriber, eigener WebSocketServer.
   * Der Parameter wrap erlaubt Tests, den Subscriber zu manipulieren.
   */
  async function startInstance(
    limits: Partial<HubLimits> = {},
    wrap: (subscriber: SubscriberPort) => SubscriberPort = (s) => s,
  ): Promise<Instance> {
    const redis = new IORedis(redisUrl as string);
    const subscriber = wrap(ioredisSubscriber(redis));
    const hub = new RealtimeHub({ store, subscriber, limits });
    const wss = new WebSocketServer({ port: 0, maxPayload: 4096 });
    wss.on("connection", (ws, request: IncomingMessage) => {
      // Wie der echte Endpunkt: Die Berechtigung wird beim Aufbau festgelegt, nicht aus Nachrichten abgeleitet.
      hub.attach(ws, { isAdmin: request.url?.includes("admin=1") ?? false, ip: "127.0.0.1" });
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const { port } = wss.address() as AddressInfo;
    const instance: Instance = {
      hub,
      url: `ws://127.0.0.1:${port}`,
      subscriber,
      redis,
      stop: async () => {
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await hub.close();
      },
    };
    instances.push(instance);
    return instance;
  }

  async function connect(instance: Instance, path = ""): Promise<TestClient> {
    const client = new TestClient(instance.url + path);
    clients.push(client);
    return client.open();
  }

  async function newGame(): Promise<string> {
    const code = nextCode();
    await store.createGame(code);
    return code;
  }

  async function numSub(channel: string): Promise<number> {
    const reply = (await control.pubsub("NUMSUB", channel)) as (string | number)[];
    return Number(reply[1]);
  }

  // ------------------------------------------------------------------------------------------------------
  // Anmeldung und Zustandsabgleich
  // ------------------------------------------------------------------------------------------------------

  it("sendet dem Bildschirm beim Verbinden willkommen und den vollständigen Zustand", async () => {
    const a = await startInstance();
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.states().length === 1, 3000, "erster Zustand");

    const welcome = client.of("welcome")[0];
    expect(welcome).toMatchObject({ role: "screen", protocol: 1, instanceId: a.hub.instanceId });
    expect(Math.abs((welcome?.serverTime ?? 0) - Date.now())).toBeLessThan(2000);
    expect(client.states()[0]?.state).toMatchObject({ code, version: 0, phase: "lobby", players: [] });
    expect(client.messages[0]?.type).toBe("welcome");
  });

  it("meldet Spieler mit Token an und nennt ihnen ihre Spielerdaten", async () => {
    const a = await startInstance();
    const code = await newGame();
    const joined = await store.joinPlayer(code, { name: "Anna", avatar: 4 });
    if (!joined.ok) throw new Error("Beitritt fehlgeschlagen");

    const client = await connect(a);
    client.hello("player", code, joined.token);
    await until(() => client.states().length === 1);
    expect(client.of("welcome")[0]?.player).toEqual(joined.player);
    expect(client.states()[0]?.state.players).toHaveLength(1);
  });

  it("liefert nach einem Verbindungsabbruch sofort den aktuellen Stand, auch wenn sich alles geändert hat", async () => {
    const a = await startInstance();
    const code = await newGame();
    const joined = await store.joinPlayer(code, { name: "Anna", avatar: 0 });
    if (!joined.ok) throw new Error("Beitritt fehlgeschlagen");

    const first = await connect(a);
    first.hello("player", code, joined.token);
    await until(() => first.states().length === 1);
    first.ws.terminate();

    // Während der Abwesenheit passiert einiges.
    await store.joinPlayer(code, { name: "Berta", avatar: 1 });
    await store.setPhase(code, "question");
    await store.touch(code);

    const second = await connect(a);
    second.hello("player", code, joined.token);
    await until(() => second.states().length >= 1);
    // Der Statusabgleich beim Verbinden ist massgebend: genau der aktuelle Zustand, nicht der alte.
    expect(second.states()[0]?.version).toBe(4);
    expect(second.states()[0]?.state.phase).toBe("question");
    expect(second.states()[0]?.state.players.map((p) => p.name)).toEqual(["Anna", "Berta"]);
  });

  it("beantwortet ping mit pong und Serverzeit", async () => {
    const a = await startInstance();
    const client = await connect(a);
    client.send({ type: "ping", t0: 1234.5 });
    await until(() => client.of("pong").length === 1);
    const pong = client.of("pong")[0];
    expect(pong?.t0).toBe(1234.5);
    expect(Math.abs((pong?.serverTime ?? 0) - Date.now())).toBeLessThan(2000);
  });

  // ------------------------------------------------------------------------------------------------------
  // Abweisung
  // ------------------------------------------------------------------------------------------------------

  it("weist ein ungültiges Token mit Code 4003 ab", async () => {
    const a = await startInstance();
    const code = await newGame();
    const client = await connect(a);
    client.hello("player", code, "a".repeat(32));
    expect((await client.waitForClose()).code).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(client.of("error")[0]?.code).toBe("unauthorized");
    expect(client.states()).toHaveLength(0);
  });

  it("weist ein formal falsches Token ab, ohne Redis zu fragen", async () => {
    const a = await startInstance();
    const code = await newGame();
    const client = await connect(a);
    client.hello("player", code, "kurz");
    expect((await client.waitForClose()).code).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  it("meldet ein unbekanntes Spiel mit Code 4004", async () => {
    const a = await startInstance();
    const client = await connect(a);
    client.hello("screen", "654321");
    expect((await client.waitForClose()).code).toBe(CLOSE_CODES.GAME_NOT_FOUND);
  });

  it("lässt die Admin Rolle nur mit Berechtigung beim Aufbau zu", async () => {
    const a = await startInstance();
    const code = await newGame();

    const denied = await connect(a);
    denied.hello("admin", code);
    expect((await denied.waitForClose()).code).toBe(CLOSE_CODES.UNAUTHORIZED);

    const allowed = await connect(a, "/?admin=1");
    allowed.hello("admin", code);
    await until(() => allowed.states().length === 1);
    expect(allowed.of("welcome")[0]?.role).toBe("admin");
  });

  it("schliesst nach der Frist, wenn keine Anmeldung kommt (Code 4009)", async () => {
    const a = await startInstance({ helloTimeoutMs: 150 });
    const client = await connect(a);
    expect((await client.waitForClose()).code).toBe(CLOSE_CODES.HELLO_TIMEOUT);
  });

  it("weist ungültige Nachrichten ab (Code 4001)", async () => {
    const a = await startInstance();
    const code = await newGame();
    for (const bad of ["kein json", JSON.stringify({ type: "cmd" }), JSON.stringify({ type: "hello" }), JSON.stringify([1, 2])]) {
      const client = await connect(a);
      client.ws.send(bad);
      expect((await client.waitForClose()).code, bad).toBe(CLOSE_CODES.INVALID_MESSAGE);
    }
    const binary = await connect(a);
    binary.ws.send(Buffer.from([1, 2, 3]));
    expect((await binary.waitForClose()).code).toBe(CLOSE_CODES.INVALID_MESSAGE);

    const twice = await connect(a);
    twice.hello("screen", code);
    twice.hello("screen", code);
    expect((await twice.waitForClose()).code).toBe(CLOSE_CODES.INVALID_MESSAGE);
  });

  it("schliesst zu grosse Nachrichten (Code 1009 des Servers)", async () => {
    const a = await startInstance();
    const client = await connect(a);
    client.ws.send("x".repeat(10_000));
    expect((await client.waitForClose()).code).toBe(1009);
  });

  it("begrenzt die Nachrichtenrate pro Verbindung (Code 4008)", async () => {
    const a = await startInstance({ burst: 5, messagesPerSecond: 1 });
    const client = await connect(a);
    for (let i = 0; i < 30; i += 1) client.send({ type: "ping", t0: i });
    expect((await client.waitForClose()).code).toBe(CLOSE_CODES.RATE_LIMITED);
  });

  it("begrenzt die Zahl gleichzeitiger Verbindungen pro Instanz und gibt den Platz wieder frei", async () => {
    const a = await startInstance({ maxConnections: 3 });
    const code = await newGame();
    const accepted: TestClient[] = [];
    for (let i = 0; i < 3; i += 1) {
      const client = await connect(a);
      client.hello("screen", code);
      accepted.push(client);
    }
    await until(() => accepted.every((client) => client.states().length === 1));

    const refused = await connect(a);
    expect((await refused.waitForClose()).code).toBe(1013);
    expect(a.hub.stats().connections).toBe(3);

    // Wird ein Platz frei, kommt die nächste Verbindung durch.
    accepted[0]?.close();
    await accepted[0]?.waitForClose();
    await until(() => a.hub.stats().connections === 2);
    const next = await connect(a);
    next.hello("screen", code);
    await until(() => next.states().length === 1);
  });

  it("löst bei abgewiesenen Anmeldungen kein Abonnement aus", async () => {
    const a = await startInstance();
    const code = await newGame();
    const attempts: TestClient[] = [];
    for (let i = 0; i < 10; i += 1) {
      const client = await connect(a);
      client.hello("player", code, "x".repeat(32));
      attempts.push(client);
    }
    const unknown = await connect(a);
    unknown.hello("screen", "555555");
    await Promise.all([...attempts, unknown].map((client) => client.waitForClose()));
    expect(a.hub.stats().games).toBe(0);
    expect(await numSub(store.channel(code))).toBe(0);
    expect(await numSub(store.channel("555555"))).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------------
  // Verteilung über mehrere Instanzen
  // ------------------------------------------------------------------------------------------------------

  it("verteilt eine Änderung an Clients auf zwei verschiedenen Instanzen, genau einmal", async () => {
    const a = await startInstance();
    const b = await startInstance();
    const code = await newGame();

    const screen = await connect(a);
    screen.hello("screen", code);
    const watcher = await connect(b);
    watcher.hello("screen", code);
    await until(() => screen.states().length === 1 && watcher.states().length === 1);

    await store.joinPlayer(code, { name: "Anna", avatar: 0 });
    await until(() => screen.lastVersion() === 1 && watcher.lastVersion() === 1);

    expect(screen.versions()).toEqual([0, 1]);
    expect(watcher.versions()).toEqual([0, 1]);
    expect(screen.states()[1]?.state.players.map((p) => p.name)).toEqual(["Anna"]);
    expect(watcher.of("welcome")[0]?.instanceId).not.toBe(screen.of("welcome")[0]?.instanceId);
  });

  it("verwendet pro Instanz nur einen Kanal, egal wie viele Clients dort verbunden sind", async () => {
    const a = await startInstance();
    const b = await startInstance();
    const code = await newGame();
    const many: TestClient[] = [];
    for (let i = 0; i < 12; i += 1) {
      const client = await connect(i % 2 === 0 ? a : b);
      client.hello("screen", code);
      many.push(client);
    }
    await until(() => many.every((client) => client.states().length === 1));
    // Zwei Instanzen, also genau zwei Abonnements des Kanals.
    expect(await numSub(store.channel(code))).toBe(2);
    expect(a.hub.stats()).toMatchObject({ connections: 6, games: 1 });
  });

  it("liefert bei vielen schnellen Änderungen jede Version genau einmal und in aufsteigender Reihenfolge", async () => {
    const a = await startInstance();
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.states().length === 1);

    for (let i = 0; i < 30; i += 1) await store.touch(code);
    await until(() => client.lastVersion() === 30, 4000, "Version 30");
    expect(client.versions()).toEqual(Array.from({ length: 31 }, (_, i) => i));
  });

  it("verliert keine Änderung, die genau beim Verbinden geschieht (Wettlauf zwischen Lesen und Abonnieren)", async () => {
    // Mehrere Runden mit frischen Spielen und neuen Instanzen, damit das Abonnement jedes Mal erst beim Verbinden
    // entsteht und die Änderungen in das Zeitfenster zwischen Lesen und Abonnieren fallen können.
    for (let round = 0; round < 8; round += 1) {
      const a = await startInstance();
      const code = await newGame();
      const writer = (async () => {
        for (let i = 0; i < 25; i += 1) {
          await store.touch(code);
          await sleep(Math.random() * 3);
        }
      })();
      await sleep(Math.random() * 10);
      const client = await connect(a);
      client.hello("screen", code);
      await writer;
      await until(() => client.lastVersion() === 25, 4000, `Version 25 in Runde ${round}`);
      // Aufsteigend und ohne Doppelte, auch wenn der erste Zustand mitten in der Folge liegt.
      const versions = client.versions();
      expect([...versions].sort((x, y) => x - y)).toEqual(versions);
      expect(new Set(versions).size).toBe(versions.length);
      client.ws.terminate();
      await a.stop();
      instances.splice(instances.indexOf(a), 1);
    }
  }, 60_000);

  it("verliert keine Änderung zwischen Lesen und Abonnieren (deterministisch)", async () => {
    // Das Abonnement wird absichtlich verzögert. Die Änderung geschieht, nachdem der Hub den Zustand gelesen hat,
    // aber bevor Redis das Abonnement kennt. Die Nachricht geht ins Leere, und es folgt keine weitere Änderung.
    // Nur das erneute Lesen nach dem Abonnieren holt sie nach.
    let readHappened = false;
    const a = await startInstance({}, (inner) => ({
      subscribe: async (channel, handler) => {
        readHappened = true;
        await sleep(250);
        return inner.subscribe(channel, handler);
      },
      unsubscribe: (channel) => inner.unsubscribe(channel),
      onReconnect: (handler) => inner.onReconnect(handler),
      close: () => inner.close(),
    }));
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => readHappened, 3000, "Beginn des Abonnierens");
    await sleep(60);
    await store.touch(code); // Version 1, veröffentlicht, solange noch niemand zuhört.

    await until(() => client.states().length >= 1, 3000, "erster Zustand");
    await until(() => client.lastVersion() === 1, 3000, "Version 1 nach dem erneuten Lesen");
    expect(client.states().at(-1)?.state.version).toBe(1);
  });

  it("ignoriert veraltete und doppelte Nachrichten, übernimmt aber neuere", async () => {
    const holder: { inject: ((raw: string) => void) | null } = { inject: null };
    const a = await startInstance({}, (inner) => ({
      subscribe: (channel, handler) => {
        holder.inject = handler;
        return inner.subscribe(channel, handler);
      },
      unsubscribe: (channel) => inner.unsubscribe(channel),
      onReconnect: (handler) => inner.onReconnect(handler),
      close: () => inner.close(),
    }));
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.states().length === 1);
    for (let i = 0; i < 3; i += 1) await store.touch(code);
    await until(() => client.lastVersion() === 3);

    const current = await store.getState(code);
    const inject = holder.inject;
    if (!current || !inject) throw new Error("Zustand oder Handler fehlt");
    const message = (version: number) => JSON.stringify({ k: "state", v: version, state: { ...current, version } });
    const before = client.states().length;

    inject(message(2)); // veraltet
    inject(message(3)); // doppelt
    inject(message(1)); // veraltet
    await sleep(100);
    expect(client.states()).toHaveLength(before);

    inject(message(4)); // neuer
    await until(() => client.lastVersion() === 4);
    inject(message(4)); // jetzt doppelt
    await sleep(100);
    expect(client.states()).toHaveLength(before + 1);
  });

  it("ignoriert unlesbare und ungültige Nachrichten auf dem Kanal", async () => {
    const holder: { inject: ((raw: string) => void) | null } = { inject: null };
    const a = await startInstance({}, (inner) => ({
      subscribe: (channel, handler) => {
        holder.inject = handler;
        return inner.subscribe(channel, handler);
      },
      unsubscribe: (channel) => inner.unsubscribe(channel),
      onReconnect: (handler) => inner.onReconnect(handler),
      close: () => inner.close(),
    }));
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.states().length === 1);
    const inject = holder.inject;
    if (!inject) throw new Error("Handler fehlt");
    for (const garbage of ["kein json", "{}", JSON.stringify({ v: 9, state: { code: "x" } }), "null"]) inject(garbage);
    await sleep(100);
    expect(client.states()).toHaveLength(1);
    expect(client.closed).toBeNull();
    // Das Spiel läuft danach normal weiter.
    await store.touch(code);
    await until(() => client.lastVersion() === 1);
  });

  it("verteilt ein neues Spiel unter demselben Code, obwohl seine Versionen kleiner sind als die des alten", async () => {
    const a = await startInstance({ idleUnsubscribeMs: 5000 });
    const code = await newGame();
    const first = await connect(a);
    first.hello("screen", code);
    await until(() => first.states().length === 1);
    for (let i = 0; i < 5; i += 1) await store.touch(code);
    await until(() => first.lastVersion() === 5);
    first.close();
    await first.waitForClose();

    // Die Gruppe lebt noch (Frist 5 Sekunden). Das Spiel wird gelöscht und mit demselben Code neu angelegt.
    await store.deleteGame(code);
    await sleep(5);
    await store.createGame(code);
    const second = await connect(a);
    second.hello("screen", code);
    await until(() => second.states().length >= 1);
    expect(second.states()[0]?.version).toBe(0); // der frische Zustand, nicht der zwischengespeicherte alte

    // Und die Änderungen des neuen Spiels kommen an, auch wenn ihre Versionen kleiner sind als 5.
    await store.touch(code);
    await store.touch(code);
    await until(() => second.lastVersion() === 2, 3000, "Version 2 des neuen Spiels");
  });

  // ------------------------------------------------------------------------------------------------------
  // Kanal Verwaltung
  // ------------------------------------------------------------------------------------------------------

  it("gibt den Kanal nach der Frist frei und abonniert ihn bei Bedarf wieder", async () => {
    const a = await startInstance({ idleUnsubscribeMs: 150 });
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.states().length === 1);
    expect(await numSub(store.channel(code))).toBe(1);

    client.close();
    await until(async () => (await numSub(store.channel(code))) === 0, 3000, "Kanal freigegeben");
    expect(a.hub.stats().games).toBe(0);

    const again = await connect(a);
    again.hello("screen", code);
    await until(() => again.states().length === 1);
    expect(await numSub(store.channel(code))).toBe(1);
  });

  it("behält den Kanal beim kontrollierten Neuaufbau (neue Verbindung öffnen, dann die alte schliessen)", async () => {
    const a = await startInstance({ idleUnsubscribeMs: 300 });
    const code = await newGame();
    const first = await connect(a);
    first.hello("screen", code);
    await until(() => first.states().length === 1);

    const second = await connect(a);
    second.hello("screen", code);
    await until(() => second.states().length === 1);
    first.close();
    await first.waitForClose();
    await sleep(100);
    expect(await numSub(store.channel(code))).toBe(1);

    await store.touch(code);
    await until(() => second.lastVersion() === 1);
  });

  // ------------------------------------------------------------------------------------------------------
  // Alter der Verbindung
  // ------------------------------------------------------------------------------------------------------

  it("kündigt das Ende der Verbindung an und beendet sie dann selbst (Code 4012)", async () => {
    const a = await startInstance({ maxAgeNoticeMs: 150, maxAgeCloseMs: 300 });
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.of("reconnect").length === 1, 2000, "Ankündigung");
    expect(client.of("reconnect")[0]?.reason).toBe("max_age");
    expect((await client.waitForClose()).code).toBe(CLOSE_CODES.ROTATE);
  });

  // ------------------------------------------------------------------------------------------------------
  // Heilung nach Verlust von Nachrichten und nach Wiederverbindung des Subscribers
  // ------------------------------------------------------------------------------------------------------

  it("holt verlorene Nachrichten nach, sobald der Subscriber eine Wiederverbindung meldet", async () => {
    // Ein Subscriber, der Nachrichten verschlucken kann, wie in der Lücke einer Wiederverbindung.
    let dropping = false;
    let reconnect: (() => void) | null = null;
    const a = await startInstance({}, (inner) => ({
      subscribe: (channel, handler) => inner.subscribe(channel, (message) => (dropping ? undefined : handler(message))),
      unsubscribe: (channel) => inner.unsubscribe(channel),
      onReconnect: (handler) => {
        reconnect = handler;
        inner.onReconnect(handler);
      },
      close: () => inner.close(),
    }));
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.states().length === 1);

    dropping = true;
    await store.touch(code);
    await store.touch(code);
    await store.touch(code);
    await sleep(150);
    expect(client.lastVersion()).toBe(0); // Nichts angekommen, die Nachrichten sind verloren.

    dropping = false;
    (reconnect as (() => void) | null)?.();
    await until(() => client.lastVersion() === 3, 3000, "Neuabgleich");
    expect(client.states().at(-1)?.state.version).toBe(3);
  });

  it("empfängt nach einem echten Abbruch der Subscriber Verbindung wieder Änderungen", async () => {
    const a = await startInstance();
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.states().length === 1);
    await store.touch(code);
    await until(() => client.lastVersion() === 1);

    // Redis trennt alle Subscriber Verbindungen, so wie bei einem Netzwerkfehler oder einem Neustart.
    await control.call("CLIENT", "KILL", "TYPE", "pubsub");
    // Änderungen während und nach dem Abbruch. Die Reihenfolge der Ereignisse im Netz ist nicht festgelegt.
    await store.touch(code);
    await sleep(50);
    await store.touch(code);
    await until(() => client.lastVersion() === 3, 8000, "Version 3 nach dem Abbruch");
    expect(await numSub(store.channel(code))).toBe(1);
    const versions = client.versions();
    expect([...versions].sort((x, y) => x - y)).toEqual(versions);
  }, 20_000);

  // ------------------------------------------------------------------------------------------------------
  // Statistik und Herunterfahren
  // ------------------------------------------------------------------------------------------------------

  it("zählt Verbindungen nach Rolle und räumt beim Schliessen auf", async () => {
    const a = await startInstance();
    const code = await newGame();
    const joined = await store.joinPlayer(code, { name: "Anna", avatar: 0 });
    if (!joined.ok) throw new Error("Beitritt fehlgeschlagen");

    const screen = await connect(a);
    screen.hello("screen", code);
    const player = await connect(a);
    player.hello("player", code, joined.token);
    const admin = await connect(a, "/?admin=1");
    admin.hello("admin", code);
    await until(() => [screen, player, admin].every((client) => client.states().length >= 1));
    expect(a.hub.stats().byRole).toEqual({ player: 1, screen: 1, admin: 1 });

    player.close();
    await player.waitForClose();
    await until(() => a.hub.stats().byRole.player === 0);
    expect(a.hub.stats().connections).toBe(2);
  });

  it("schliesst beim Herunterfahren alle Verbindungen mit Code 4013", async () => {
    const a = await startInstance();
    const code = await newGame();
    const client = await connect(a);
    client.hello("screen", code);
    await until(() => client.states().length === 1);
    await a.hub.close();
    expect((await client.waitForClose()).code).toBe(CLOSE_CODES.SERVER_ERROR);
  });
});
