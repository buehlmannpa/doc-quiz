/**
 * Aufbau von Redis Schlüsseln und Publish/Subscribe Kanälen.
 *
 * Jeder Name beginnt mit dem Umgebungspräfix (prod, preview, dev oder local), weil sich alle
 * Umgebungen eine einzige Upstash Datenbank teilen (Free Plan). Die Teile werden streng
 * geprüft: Platzhalter wie * oder ? oder Leerzeichen sind verboten, damit ein manipulierter
 * Spielcode niemals einen fremden Schlüssel oder ein Muster treffen kann.
 */
import { getKeyPrefix } from "@/lib/env";

const SAFE_PART = /^[A-Za-z0-9_.\-]{1,64}$/;

function assertParts(parts: readonly string[]): void {
  if (parts.length === 0) throw new Error("Ein Redis Schlüssel braucht mindestens einen Teil.");
  for (const part of parts) {
    if (!SAFE_PART.test(part)) {
      throw new Error(`Ungültiger Teil für einen Redis Schlüssel: ${JSON.stringify(part)}`);
    }
  }
}

/** Baut einen Schlüssel mit explizitem Präfix, zum Beispiel prod:game:123456:state. */
export function buildKey(prefix: string, ...parts: string[]): string {
  assertParts(parts);
  return [prefix, ...parts].join(":");
}

/** Baut einen Kanalnamen mit explizitem Präfix, zum Beispiel prod:ch:game:123456. */
export function buildChannel(prefix: string, ...parts: string[]): string {
  assertParts(parts);
  return [prefix, "ch", ...parts].join(":");
}

/** Schlüssel für die aktuelle Umgebung. */
export function redisKey(...parts: string[]): string {
  return buildKey(getKeyPrefix(), ...parts);
}

/** Kanal für die aktuelle Umgebung. */
export function redisChannel(...parts: string[]): string {
  return buildChannel(getKeyPrefix(), ...parts);
}
