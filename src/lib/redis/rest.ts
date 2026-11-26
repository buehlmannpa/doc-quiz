/**
 * Redis über REST (HTTP) mit dem Upstash SDK.
 *
 * Verwendung: alle normalen Befehle (lesen, schreiben, publish). Das ist verbindungslos und
 * funktioniert in jeder Funktionsinstanz ohne Verbindungsverwaltung.
 *
 * Nicht verwendet wird die subscribe Methode dieses SDKs. Im Quellcode (Version 1.41.1) endet
 * der SSE Stream bei einem Abbruch still, ohne Wiederverbindung und ohne Fehlerereignis.
 * Eine tote Subscription würde unbemerkt Nachrichten verlieren. Für subscribe dient ioredis
 * über TCP, siehe tcp.ts.
 */
import { Redis } from "@upstash/redis";
import { resolveRedisRestEnv } from "@/lib/env";

const g = globalThis as unknown as { __quizRedisRest?: Redis };

export function getRedis(): Redis {
  if (!g.__quizRedisRest) {
    const { url, token } = resolveRedisRestEnv(process.env);
    g.__quizRedisRest = new Redis({
      url,
      token,
      // Wichtig: Das SDK würde Werte sonst automatisch als JSON lesen und zum Beispiel den Text
      // "123" in die Zahl 123 verwandeln. Wir speichern JSON bewusst als Text und prüfen es mit Zod.
      automaticDeserialization: false,
      // Wenige Wiederholungen, damit ein Fehler schnell sichtbar wird statt die Latenz aufzublähen.
      retry: { retries: 2, backoff: (attempt) => 50 * 2 ** attempt },
    });
  }
  return g.__quizRedisRest;
}
