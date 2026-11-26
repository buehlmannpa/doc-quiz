/**
 * Redis über TCP mit ioredis.
 *
 * Verwendung: ausschliesslich für Subscriber (Publish/Subscribe). SUBSCRIBE braucht eine
 * dauerhafte, eigene Verbindung. Die Upstash Doku zeigt für SUBSCRIBE ioredis mit der TLS Adresse.
 *
 * Eine Verbindung im Subscribe Modus darf keine normalen Befehle ausführen. Dafür dient der REST
 * Client in rest.ts.
 *
 * Wiederverbindung: ioredis verbindet sich nach einem Abbruch selbständig neu und abonniert die
 * Kanäle wieder (autoResubscribe, Vorgabe von ioredis). Nachrichten, die während der Lücke
 * veröffentlicht werden, gehen verloren. Deshalb tragen alle Spielnachrichten eine Versionsnummer,
 * und die Clients gleichen den Zustand bei einer Lücke neu ab (Meilenstein 3).
 */
import IORedis from "ioredis";
import { resolveRedisTcpEnv } from "@/lib/env";

export type TcpRedis = IORedis;

/** Wartezeit vor dem nächsten Verbindungsversuch: 100 ms bis 3 s, mit etwas Zufall gegen Gleichtakt. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(100 * 2 ** Math.min(attempt, 5), 3_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

export function createTcpRedis(label: string): TcpRedis {
  const { url } = resolveRedisTcpEnv(process.env);
  const client = new IORedis(url, {
    connectTimeout: 10_000,
    // Für Subscriber gibt es keine Befehle, die auf eine Antwort warten würden.
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => reconnectDelayMs(attempt),
    keepAlive: 10_000,
  });
  // Ohne error Handler würde ioredis den Fehler als unbehandeltes Ereignis werfen.
  client.on("error", (error) => {
    console.error(`[redis:${label}] Fehler:`, error.message);
  });
  client.on("reconnecting", (delay: number) => {
    console.warn(`[redis:${label}] Wiederverbindung in ${delay} ms`);
  });
  return client;
}
