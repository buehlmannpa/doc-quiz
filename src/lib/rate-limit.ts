/**
 * Einfaches Rate Limiting.
 *
 * Primär zählt Redis (gemeinsam für alle Funktionsinstanzen). Ist Redis nicht erreichbar oder nicht
 * eingerichtet, zählt jede Instanz für sich im Speicher. So bleibt der Login immer nutzbar und ist
 * trotzdem geschützt (die Grenze gilt dann pro Instanz).
 *
 * Gezählt wird mit einem festen Zeitfenster. Pro Treffer braucht Redis einen Befehl (INCR), beim
 * ersten Treffer eines Fensters einen zweiten (EXPIRE). IP Adressen werden nie im Klartext gespeichert.
 */
import { createHash } from "node:crypto";
import { redisKey } from "@/lib/redis/keys";
import { getRedis } from "@/lib/redis/rest";

export type RateLimitResult = {
  allowed: boolean;
  /** Verbleibende Versuche im aktuellen Fenster. */
  remaining: number;
  /** Obergrenze der Wartezeit bis zum nächsten Versuch. */
  retryAfterSeconds: number;
};

export type MemoryLimiter = {
  hit(key: string): RateLimitResult;
};

/** Zähler im Speicher mit festem Zeitfenster. Die Uhr ist austauschbar, damit der Test sie steuern kann. */
export function createMemoryLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): MemoryLimiter {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    hit(key) {
      const current = now();
      // Abgelaufene Einträge entfernen, damit die Tabelle nicht unbegrenzt wächst.
      if (buckets.size > 1_000) {
        for (const [k, bucket] of buckets) if (bucket.resetAt <= current) buckets.delete(k);
      }
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= current) {
        bucket = { count: 0, resetAt: current + options.windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - current) / 1000));
      return {
        allowed: bucket.count <= options.limit,
        remaining: Math.max(0, options.limit - bucket.count),
        retryAfterSeconds,
      };
    },
  };
}

/** Kurzer, nicht umkehrbarer Schlüssel für einen Wert wie eine IP Adresse. */
export function hashKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

const fallbackLimiters = new Map<string, MemoryLimiter>();
let warnedAboutFallback = false;

export async function rateLimit(
  name: string,
  keyPart: string,
  options: { limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  try {
    const redis = getRedis();
    const key = redisKey("rl", name, hashKeyPart(keyPart));
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, options.windowSeconds);
    return {
      allowed: count <= options.limit,
      remaining: Math.max(0, options.limit - count),
      retryAfterSeconds: options.windowSeconds,
    };
  } catch (error) {
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      console.warn(
        "[rate-limit] Redis nicht verfügbar, die Begrenzung gilt nur pro Instanz:",
        error instanceof Error ? error.message : String(error),
      );
    }
    const id = `${name}:${options.limit}:${options.windowSeconds}`;
    let limiter = fallbackLimiters.get(id);
    if (!limiter) {
      limiter = createMemoryLimiter({ limit: options.limit, windowMs: options.windowSeconds * 1000 });
      fallbackLimiters.set(id, limiter);
    }
    return limiter.hit(keyPart);
  }
}
