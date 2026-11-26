/**
 * Integrationstests des Spielspeichers gegen einen echten Redis Server.
 *
 * Sie laufen nur, wenn TEST_REDIS_URL gesetzt ist, zum Beispiel:
 *   TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
 * Jeder Lauf verwendet ein eigenes Präfix und räumt seine Schlüssel danach wieder auf.
 * Verwenden Sie niemals die Redis Datenbank von Produktion oder Preview.
 */
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AVATAR_COUNT, MAX_PLAYERS } from "./game-state";
import { channelMessageSchema } from "./protocol";
import { ioredisPort, type RedisPort } from "./redis-port";
import { GameStore } from "./store";

const url = process.env.TEST_REDIS_URL;
const SECRET = "ein sehr langes testgeheimnis fuer die spielertoken";
const prefix = `t${Math.random().toString(36).slice(2, 10)}`;

let counter = 0;
const nextCode = () => String(100_000 + ((counter += 1) % 800_000));

describe.skipIf(!url)("GameStore (echtes Redis)", () => {
  let client: IORedis;
  let subscriber: IORedis;
  let port: RedisPort;
  let store: GameStore;

  beforeAll(() => {
    client = new IORedis(url as string);
    subscriber = new IORedis(url as string);
    port = ioredisPort(client);
    store = new GameStore(port, { prefix, tokenSecret: SECRET });
  });

  afterAll(async () => {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) await client.del(...keys);
    subscriber.disconnect();
    client.disconnect();
  });

  async function newGame(): Promise<string> {
    const code = nextCode();
    expect(await store.createGame(code)).toBe(true);
    return code;
  }

  it("legt ein Spiel im Warteraum an, nur einmal pro Code, und setzt ein Ablaufdatum", async () => {
    const code = nextCode();
    expect(await store.createGame(code)).toBe(true);
    expect(await store.createGame(code)).toBe(false);
    const state = await store.getState(code);
    expect(state).toMatchObject({ code, version: 0, phase: "lobby", players: [] });
    const ttl = await client.ttl(store.gameKey(code));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(6 * 60 * 60);
  });

  it("liefert null für ein unbekanntes Spiel", async () => {
    expect(await store.getState("999999")).toBeNull();
  });

  it("nimmt Spieler auf, erhöht die Version und liefert ein Token, mit dem man sich anmelden kann", async () => {
    const code = await newGame();
    const joined = await store.joinPlayer(code, { name: "  Anna  ", avatar: 3 });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.player).toMatchObject({ name: "Anna", avatar: 3 });
    expect(joined.state.version).toBe(1);

    const auth = await store.authenticatePlayer(code, joined.token);
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.player.id).toBe(joined.player.id);
      expect(auth.state.players).toHaveLength(1);
    }
  });

  it("legt kein Token im Klartext ab", async () => {
    const code = await newGame();
    const joined = await store.joinPlayer(code, { name: "Geheim", avatar: 0 });
    if (!joined.ok) throw new Error("Beitritt fehlgeschlagen");
    const stored = await client.hgetall(`${prefix}:game:${code}:tok`);
    expect(Object.keys(stored)).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(joined.token);
    expect(await client.hget(store.gameKey(code), "s")).not.toContain(joined.token);
  });

  it("lehnt ungültige Namen und Icons ab, ohne etwas zu speichern", async () => {
    const code = await newGame();
    expect(await store.joinPlayer(code, { name: "   ", avatar: 0 })).toEqual({ ok: false, reason: "invalid_name" });
    expect(await store.joinPlayer(code, { name: "x".repeat(21), avatar: 0 })).toEqual({ ok: false, reason: "invalid_name" });
    expect(await store.joinPlayer(code, { name: "ok", avatar: AVATAR_COUNT })).toEqual({ ok: false, reason: "invalid_avatar" });
    expect((await store.getState(code))?.version).toBe(0);
    expect(await client.hlen(`${prefix}:game:${code}:tok`)).toBe(0);
  });

  it("verweigert doppelte Namen unabhängig von der Schreibweise und räumt das Token wieder auf", async () => {
    const code = await newGame();
    expect((await store.joinPlayer(code, { name: "Anna", avatar: 0 })).ok).toBe(true);
    expect(await store.joinPlayer(code, { name: "ANNA", avatar: 1 })).toEqual({ ok: false, reason: "name_taken" });
    expect(await client.hlen(`${prefix}:game:${code}:tok`)).toBe(1);
    expect((await store.getState(code))?.players).toHaveLength(1);
  });

  it("meldet ein unbekanntes Spiel, ohne Schlüssel anzulegen", async () => {
    expect(await store.joinPlayer("888888", { name: "Anna", avatar: 0 })).toEqual({ ok: false, reason: "not_found" });
    expect(await client.exists(`${prefix}:game:888888:tok`)).toBe(0);
  });

  it("lässt nach dem Start keine neuen Teilnehmenden mehr zu", async () => {
    const code = await newGame();
    const first = await store.joinPlayer(code, { name: "Anna", avatar: 0 });
    expect((await store.setPhase(code, "running")).ok).toBe(true);
    expect(await store.joinPlayer(code, { name: "Berta", avatar: 1 })).toEqual({ ok: false, reason: "closed" });
    // Wer schon dabei ist, kann sich weiterhin verbinden.
    if (!first.ok) throw new Error("Beitritt fehlgeschlagen");
    expect((await store.authenticatePlayer(code, first.token)).ok).toBe(true);
  });

  it("begrenzt die Zahl der Teilnehmenden", async () => {
    const code = await newGame();
    const results = [];
    for (let i = 0; i < MAX_PLAYERS; i += 1) results.push(await store.joinPlayer(code, { name: `Spieler ${i}`, avatar: i % AVATAR_COUNT }));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await store.joinPlayer(code, { name: "Einer zu viel", avatar: 0 })).toEqual({ ok: false, reason: "full" });
  }, 30_000);

  it("nimmt gleichzeitige Beitritte alle auf, mit lückenlosen Versionen und eindeutigen Namen", async () => {
    const code = await newGame();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => store.joinPlayer(code, { name: `Fahrer ${i}`, avatar: i % AVATAR_COUNT })),
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const versions = results.map((result) => (result.ok ? result.state.version : -1)).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    const state = await store.getState(code);
    expect(state?.version).toBe(40);
    expect(new Set(state?.players.map((p) => p.name)).size).toBe(40);
    expect(new Set(state?.players.map((p) => p.id)).size).toBe(40);
  }, 30_000);

  it("lässt bei gleichzeitigem Beitritt mit demselben Namen genau einen durch", async () => {
    const code = await newGame();
    const results = await Promise.all(Array.from({ length: 6 }, () => store.joinPlayer(code, { name: "Doppelt", avatar: 0 })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "name_taken")).toHaveLength(5);
    expect((await store.getState(code))?.players).toHaveLength(1);
  });

  it("serialisiert gleichzeitige Änderungen: keine geht verloren", async () => {
    const code = await newGame();
    await Promise.all([store.touch(code), store.touch(code), store.touch(code), store.setPhase(code, "running")]);
    const state = await store.getState(code);
    expect(state?.version).toBe(4);
    expect(state?.phase).toBe("running");
  });

  it("weist ein falsches Token, ein Token eines anderen Spiels und ein unbekanntes Spiel ab", async () => {
    const codeA = await newGame();
    const codeB = await newGame();
    const joined = await store.joinPlayer(codeA, { name: "Anna", avatar: 0 });
    if (!joined.ok) throw new Error("Beitritt fehlgeschlagen");
    expect(await store.authenticatePlayer(codeA, "a".repeat(32))).toEqual({ ok: false, reason: "bad_token" });
    expect(await store.authenticatePlayer(codeB, joined.token)).toEqual({ ok: false, reason: "bad_token" });
    expect(await store.authenticatePlayer("777777", joined.token)).toEqual({ ok: false, reason: "not_found" });
  });

  it("erkennt Token nicht mehr, wenn das Geheimnis ein anderes ist", async () => {
    const code = await newGame();
    const joined = await store.joinPlayer(code, { name: "Anna", avatar: 0 });
    if (!joined.ok) throw new Error("Beitritt fehlgeschlagen");
    const other = new GameStore(port, { prefix, tokenSecret: "ein ganz anderes geheimnis fuer die token" });
    expect(await other.authenticatePlayer(code, joined.token)).toEqual({ ok: false, reason: "bad_token" });
  });

  it("veröffentlicht jede Änderung mit dem vollständigen Zustand", async () => {
    const code = await newGame();
    const received: string[] = [];
    subscriber.on("message", (_channel, message) => received.push(message));
    await subscriber.subscribe(store.channel(code));

    const joined = await store.joinPlayer(code, { name: "Anna", avatar: 5 });
    await store.setPhase(code, "running");
    await new Promise((resolve) => setTimeout(resolve, 150));

    const messages = received.map((raw) => channelMessageSchema.parse(JSON.parse(raw)));
    expect(messages.map((m) => m.v)).toEqual([1, 2]);
    expect(messages[0]?.state.players).toHaveLength(1);
    expect(messages[1]?.state.phase).toBe("running");
    expect(joined.ok && messages[0]?.state.players[0]?.id === joined.player.id).toBe(true);
    await subscriber.unsubscribe(store.channel(code));
    subscriber.removeAllListeners("message");
  });

  it("veröffentlicht nichts bei einer abgelehnten Änderung", async () => {
    const code = await newGame();
    await store.joinPlayer(code, { name: "Anna", avatar: 0 });
    const received: string[] = [];
    subscriber.on("message", (_channel, message) => received.push(message));
    await subscriber.subscribe(store.channel(code));
    await store.joinPlayer(code, { name: "anna", avatar: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual([]);
    await subscriber.unsubscribe(store.channel(code));
    subscriber.removeAllListeners("message");
  });

  it("schaltet auf getrenntes Veröffentlichen um, wenn PUBLISH in Lua nicht erlaubt ist", async () => {
    const strictPort: RedisPort = {
      ...port,
      eval: async (script, keys, args) => {
        if (/PUBLISH/.test(script)) throw new Error("ERR This Redis command is not allowed from script: PUBLISH");
        return port.eval(script, keys, args);
      },
    };
    const fallbackStore = new GameStore(strictPort, { prefix, tokenSecret: SECRET });
    const code = nextCode();
    await fallbackStore.createGame(code);
    expect(fallbackStore.publishMode).toBe("script");

    const received: string[] = [];
    subscriber.on("message", (_channel, message) => received.push(message));
    await subscriber.subscribe(fallbackStore.channel(code));

    const joined = await fallbackStore.joinPlayer(code, { name: "Anna", avatar: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(joined.ok).toBe(true);
    expect(fallbackStore.publishMode).toBe("separate");
    expect(received).toHaveLength(1);
    expect(channelMessageSchema.parse(JSON.parse(received[0] as string)).v).toBe(1);
    await subscriber.unsubscribe(fallbackStore.channel(code));
    subscriber.removeAllListeners("message");
  });

  it("gibt andere Skriptfehler weiter, statt still umzuschalten", async () => {
    const brokenPort: RedisPort = {
      ...port,
      eval: async () => {
        throw new Error("ERR Verbindung verloren");
      },
    };
    const brokenStore = new GameStore(brokenPort, { prefix, tokenSecret: SECRET });
    const code = await newGame();
    await expect(brokenStore.touch(code)).rejects.toThrow("Verbindung verloren");
    expect(brokenStore.publishMode).toBe("script");
  });

  it("verlängert das Ablaufdatum bei jeder Änderung", async () => {
    const shortStore = new GameStore(port, { prefix, tokenSecret: SECRET, ttlSeconds: 100 });
    const code = nextCode();
    await shortStore.createGame(code);
    await client.expire(shortStore.gameKey(code), 5);
    await shortStore.touch(code);
    const ttl = await client.ttl(shortStore.gameKey(code));
    expect(ttl).toBeGreaterThan(50);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it("löscht Spiel und Token", async () => {
    const code = await newGame();
    await store.joinPlayer(code, { name: "Anna", avatar: 0 });
    await store.deleteGame(code);
    expect(await store.getState(code)).toBeNull();
    expect(await client.exists(`${prefix}:game:${code}:tok`)).toBe(0);
  });

  it("meldet einen beschädigten Zustand als Fehler, statt ihn zu verwenden", async () => {
    const code = await newGame();
    await client.hset(store.gameKey(code), "s", '{"code":"nope"}');
    await expect(store.getState(code)).rejects.toThrow();
  });
});
