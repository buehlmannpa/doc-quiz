/**
 * Datenbank Zugriff (Neon Postgres über node-postgres und Drizzle ORM).
 *
 * Neon empfiehlt für Vercel Fluid Compute den Treiber pg mit einem Pool. Der Pool wird pro
 * Funktionsinstanz einmal angelegt (globalThis überlebt Hot Reload und mehrere Aufrufe).
 *
 * Neon Free schaltet die Datenbank nach 5 Minuten Inaktivität ab (nicht deaktivierbar). Die erste
 * Abfrage danach dauert laut Neon wenige hundert Millisekunden länger. Das Zeitlimit für den
 * Verbindungsaufbau ist deshalb grosszügig. Im Spiel selbst wird Neon nicht gebraucht.
 */
import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getDbEnv } from "@/lib/env";
import * as schema from "./schema";

type DbGlobals = { __quizPool?: Pool; __quizDb?: NodePgDatabase<typeof schema> };
const g = globalThis as unknown as DbGlobals;

export function getPool(): Pool {
  if (!g.__quizPool) {
    const { databaseUrl } = getDbEnv();
    const pool = new Pool({
      connectionString: databaseUrl,
      // Klein halten: Eine Instanz bedient viele WebSocket Verbindungen, aber nur wenige DB Abfragen.
      max: 5,
      // Reicht für das Aufwecken einer abgeschalteten Neon Datenbank.
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 10_000,
    });
    // Ohne diesen Handler würde ein Fehler auf einer ruhenden Verbindung den Prozess beenden.
    pool.on("error", (error) => {
      console.error("[db] Fehler auf einer ruhenden Verbindung:", error.message);
    });
    // Hält die Funktionsinstanz am Leben, bis ruhende Verbindungen sauber geschlossen sind.
    attachDatabasePool(pool);
    g.__quizPool = pool;
  }
  return g.__quizPool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  return (g.__quizDb ??= drizzle(getPool(), { schema }));
}

export { schema };
