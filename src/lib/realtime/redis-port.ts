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
  };
}
