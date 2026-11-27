/**
 * Kleine Schnittstelle zu Redis mit genau den Operationen, die der Spielspeicher braucht.
 *
 * Produktiv läuft sie über das Upstash SDK (REST, verbindungslos). In den Tests läuft dieselbe Logik über
 * ioredis gegen einen echten lokalen Redis Server. So ist die Spiellogik nicht an einen Client gebunden.
 */
import type { Redis } from "@upstash/redis";
import type IORedis from "ioredis";

export interface RedisPort {
  /** Führt ein Lua Skript aus. Zahlen in args werden als Text übergeben, wie es Redis erwartet. */
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  /** Liest mehrere Hash Felder aus verschiedenen Schlüsseln in einer einzigen Anfrage. */
  hgetBatch(requests: readonly { key: string; field: string }[]): Promise<(string | null)[]>;
  hset(key: string, field: string, value: string): Promise<void>;
  hdel(key: string, field: string): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  del(...keys: string[]): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Setzt einen Wert mit Ablauf. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Setzt einen Wert nur, wenn es den Schlüssel noch nicht gibt. Gibt zurück, ob er gesetzt wurde. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Alle Felder eines Hashes, leer wenn es ihn nicht gibt. */
  hgetall(key: string): Promise<Record<string, string>>;
  /** Setzt viele Felder eines Hashes und verlängert dessen Ablauf. */
  hsetMany(key: string, entries: Record<string, string>, ttlSeconds: number): Promise<void>;
}

/**
 * Wandelt die Antwort von HGETALL in ein Objekt Feld zu Wert um.
 *
 * Redis und das echte Upstash liefern ein flaches Array (Feld, Wert, Feld, Wert ...). Das Upstash SDK wandelt es nur
 * mit automatischer Deserialisierung in ein Objekt um. Wir arbeiten mit automaticDeserialization: false (siehe rest.ts),
 * dann reicht das SDK das Array unverändert durch. ioredis liefert dagegen ein Objekt. Diese Funktion kennt beide
 * Formen. Ein leerer Hash oder ein fehlender Schlüssel ergibt ein leeres Objekt.
 */
export function hashReplyToRecord(reply: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(reply)) {
    for (let index = 0; index + 1 < reply.length; index += 2) result[String(reply[index])] = String(reply[index + 1]);
  } else if (reply !== null && typeof reply === "object") {
    for (const [field, value] of Object.entries(reply)) result[field] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}

/** Adapter für das Upstash SDK. Der Client muss mit automaticDeserialization: false laufen (siehe rest.ts). */
export function upstashPort(redis: Redis): RedisPort {
  return {
    eval: (script, keys, args) => redis.eval(script, keys, args),
    async hgetBatch(requests) {
      const first = requests[0];
      if (requests.length === 1 && first) {
        return [(await redis.hget<string>(first.key, first.field)) ?? null];
      }
      // Eine Pipeline schickt alle Lesebefehle in einer HTTP Anfrage.
      const pipeline = redis.pipeline();
      for (const request of requests) pipeline.hget(request.key, request.field);
      const results = await pipeline.exec<(string | null)[]>();
      return results.map((value) => (value === null || value === undefined ? null : String(value)));
    },
    async hset(key, field, value) {
      await redis.hset(key, { [field]: value });
    },
    async hdel(key, field) {
      await redis.hdel(key, field);
    },
    async expire(key, seconds) {
      await redis.expire(key, seconds);
    },
    publish: (channel, message) => redis.publish(channel, message),
    async del(...keys) {
      if (keys.length > 0) await redis.del(...keys);
    },
    async get(key) {
      return (await redis.get<string>(key)) ?? null;
    },
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, { ex: ttlSeconds });
    },
    async setIfAbsent(key, value, ttlSeconds) {
      return (await redis.set(key, value, { ex: ttlSeconds, nx: true })) === "OK";
    },
    async hgetall(key) {
      return hashReplyToRecord(await redis.hgetall(key));
    },
    async hsetMany(key, entries, ttlSeconds) {
      if (Object.keys(entries).length === 0) return;
      await redis.hset(key, entries);
      await redis.expire(key, ttlSeconds);
    },
  };
}

/** Adapter für ioredis, gedacht für Tests und lokale Entwicklung. */
export function ioredisPort(client: IORedis): RedisPort {
  return {
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args.map(String)),
    async hgetBatch(requests) {
      const pipeline = client.pipeline();
      for (const request of requests) pipeline.hget(request.key, request.field);
      const results = (await pipeline.exec()) ?? [];
      return results.map(([error, value]) => {
        if (error) throw error;
        return value === null || value === undefined ? null : String(value);
      });
    },
    async hset(key, field, value) {
      await client.hset(key, field, value);
    },
    async hdel(key, field) {
      await client.hdel(key, field);
    },
    async expire(key, seconds) {
      await client.expire(key, seconds);
    },
    publish: (channel, message) => client.publish(channel, message),
    async del(...keys) {
      if (keys.length > 0) await client.del(...keys);
    },
    get: (key) => client.get(key),
    async set(key, value, ttlSeconds) {
      await client.set(key, value, "EX", ttlSeconds);
    },
    async setIfAbsent(key, value, ttlSeconds) {
      return (await client.set(key, value, "EX", ttlSeconds, "NX")) === "OK";
    },
    async hgetall(key) {
      return hashReplyToRecord(await client.hgetall(key));
    },
    async hsetMany(key, entries, ttlSeconds) {
      if (Object.keys(entries).length === 0) return;
      await client.hset(key, entries);
      await client.expire(key, ttlSeconds);
    },
  };
}
