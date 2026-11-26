/**
 * Datenbank Migrationen aus der App heraus.
 *
 * Normalerweise läuft "npm run db:migrate" auf einem Entwicklerrechner (siehe docs/SETUP.md). Wenn das
 * nicht möglich ist, etwa wegen einer Geschäftspolicy, kann der angemeldete Admin die Migrationen auf der
 * Seite /admin/system anwenden. Es werden ausschliesslich die Dateien aus dem Ordner drizzle/ ausgeführt,
 * die im Repository liegen. Es gibt keine Möglichkeit, eigenes SQL einzugeben.
 *
 * Sicherheit und Korrektheit:
 * 1. Die Migration läuft über die direkte Adresse DATABASE_URL_UNPOOLED, wie von Neon empfohlen.
 * 2. Ein Advisory Lock verhindert, dass zwei gleichzeitige Klicks dieselbe Migration doppelt ausführen.
 * 3. Drizzle führt jede Migration in einer Transaktion aus und merkt sich die angewendeten Migrationen
 *    in der Tabelle drizzle.__drizzle_migrations. Wiederholtes Ausführen ist harmlos.
 */
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { z } from "zod";
import { getPool } from "@/lib/db/client";
import { getDbEnv } from "@/lib/env";

/** Ordner mit den SQL Dateien. Auf Vercel wird er über next.config.ts in die Funktion eingebunden. */
const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/** Beliebige feste Zahl als Name des Advisory Locks. */
const LOCK_ID = 727_001;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export type MigrationStatus = {
  /** Anzahl Migrationen im Repository. */
  available: number;
  /** Anzahl bereits angewendeter Migrationen in der Datenbank. */
  applied: number;
  pending: number;
  /** Ob DATABASE_URL_UNPOOLED gesetzt ist, was zum Anwenden nötig ist. */
  directUrlConfigured: boolean;
};

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number() })),
});

export type JournalEntry = { tag: string; when: number };

/** Liest die Liste der Migrationen aus drizzle/meta/_journal.json. */
export function readJournal(folder: string = MIGRATIONS_FOLDER): JournalEntry[] {
  const file = path.join(folder, "meta", "_journal.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new MigrationError(
      "Die Migrationsdateien wurden in der Funktion nicht gefunden (Ordner drizzle). Bitte melden Sie das.",
    );
  }
  const parsed = journalSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new MigrationError("Das Migrationsjournal ist ungültig.");
  return parsed.data.entries;
}

/**
 * Drizzle wendet eine Migration an, wenn ihr Zeitstempel grösser ist als der der zuletzt angewendeten.
 * Dieselbe Regel verwenden wir, um die offenen Migrationen zu zählen.
 */
export function countPending(entries: readonly JournalEntry[], lastAppliedMillis: number): number {
  return entries.filter((entry) => entry.when > lastAppliedMillis).length;
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
  const entries = readJournal();
  const pool = getPool();

  const exists = await pool.query<{ present: boolean }>(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
  );
  let applied = 0;
  let lastAppliedMillis = 0;
  if (exists.rows[0]?.present) {
    const result = await pool.query<{ applied: number; last: string }>(
      "select count(*)::int as applied, coalesce(max(created_at), 0)::text as last from drizzle.__drizzle_migrations",
    );
    applied = result.rows[0]?.applied ?? 0;
    lastAppliedMillis = Number(result.rows[0]?.last ?? 0);
  }

  return {
    available: entries.length,
    applied,
    pending: countPending(entries, lastAppliedMillis),
    directUrlConfigured: Boolean(getDbEnv().databaseUrlUnpooled),
  };
}

/** Wendet alle offenen Migrationen an. Gibt die Anzahl der neu angewendeten Migrationen zurück. */
export async function applyMigrations(): Promise<{ appliedNow: number }> {
  const { databaseUrlUnpooled } = getDbEnv();
  if (!databaseUrlUnpooled) {
    throw new MigrationError("DATABASE_URL_UNPOOLED ist nicht gesetzt. Die Migration braucht die direkte Adresse von Neon.");
  }
  const before = await getMigrationStatus();

  // Eigener Pool nur für diesen Vorgang, mit einer einzigen Verbindung.
  const pool = new Pool({ connectionString: databaseUrlUnpooled, max: 1, connectionTimeoutMillis: 20_000 });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1)", [LOCK_ID]);
    } catch {
      // Beim Schliessen der Verbindung gibt der Server den Lock ohnehin frei.
    }
    client.release();
    await pool.end();
  }

  return { appliedNow: before.pending };
}
