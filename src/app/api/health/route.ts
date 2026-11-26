/**
 * Health Check: prüft Neon, Upstash (REST und TCP) und zeigt die Laufzeit Region.
 *
 * Zugriff:
 * 1. Ausserhalb der Produktion sind alle Details frei sichtbar (nur Namen und Zeiten, keine Werte).
 * 2. In der Produktion liefert die Route ohne Token nur { ok: true } und berührt weder Neon noch
 *    Redis. So kann niemand von aussen die Datenbank aufwecken oder das Befehlskontingent verbrauchen.
 *    Mit dem Header x-health-token (Wert der Variable HEALTH_TOKEN) gibt es die vollen Details.
 */
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  DB_URL_NAMES,
  DB_URL_UNPOOLED_NAMES,
  EnvError,
  REDIS_REST_TOKEN_NAMES,
  REDIS_REST_URL_NAMES,
  REDIS_TCP_URL_NAMES,
  presentNames,
  resolveDbEnv,
  resolveDeploymentEnv,
  resolveKeyPrefix,
  resolveRedisRestEnv,
  resolveRedisTcpEnv,
} from "@/lib/env";
import { redisKey } from "@/lib/redis/keys";
import { getRedis } from "@/lib/redis/rest";
import { createTcpRedis } from "@/lib/redis/tcp";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const EXPECTED_REGION = "fra1";
const EXPECTED_TABLES = ["quizzes", "questions", "answer_options", "game_sessions", "players", "responses"];

type CheckResult = {
  status: "ok" | "error" | "skipped";
  /** Dauer der ersten Anfrage (zeigt einen Kaltstart von Neon) und einer zweiten, warmen Anfrage. */
  firstMs?: number;
  warmMs?: number;
  message?: string;
  detail?: Record<string, unknown>;
};

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: Zeitüberschreitung nach ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Zeigt Fehler ohne Verbindungsdaten: nur die Meldung, auf eine Zeile gekürzt. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 200);
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    resolveDbEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) return { status: "skipped", message: error.message };
    throw error;
  }
  try {
    const db = getDb();
    const first = await timed(() => withTimeout(db.execute(sql`select 1`), 20_000, "Neon"));
    const warm = await timed(() => db.execute(sql`select 1`));
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const present = tables.rows.map((row) => row.table_name);
    const missing = EXPECTED_TABLES.filter((name) => !present.includes(name));
    return {
      status: missing.length === 0 ? "ok" : "error",
      firstMs: first.ms,
      warmMs: warm.ms,
      message: missing.length === 0 ? undefined : `Migration fehlt, Tabellen nicht vorhanden: ${missing.join(", ")}`,
      detail: { tablesPresent: EXPECTED_TABLES.length - missing.length, tablesExpected: EXPECTED_TABLES.length },
    };
  } catch (error) {
    return { status: "error", message: describeError(error) };
  }
}

async function checkRedisRest(): Promise<CheckResult> {
  try {
    resolveRedisRestEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) return { status: "skipped", message: error.message };
    throw error;
  }
  try {
    const redis = getRedis();
    const key = redisKey("health", "probe");
    // SET mit Ablauf und GET: zwei Befehle. PING zählt bei Upstash nicht als Befehl.
    const first = await timed(() => redis.set(key, "1", { ex: 30 }));
    const warm = await timed(() => redis.get(key));
    const roundTripOk = first.value === "OK" && String(warm.value) === "1";
    return {
      status: roundTripOk ? "ok" : "error",
      firstMs: first.ms,
      warmMs: warm.ms,
      message: roundTripOk ? undefined : "Schreiben und Lesen lieferten nicht das erwartete Ergebnis",
    };
  } catch (error) {
    return { status: "error", message: describeError(error) };
  }
}

async function checkRedisTcp(): Promise<CheckResult> {
  try {
    resolveRedisTcpEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) return { status: "skipped", message: error.message };
    throw error;
  }
  const client = createTcpRedis("health");
  try {
    // Die erste Messung enthält den Verbindungsaufbau mit TLS, die zweite nur den Befehl.
    const first = await timed(() => withTimeout(client.ping(), 10_000, "Redis TCP"));
    const warm = await timed(() => client.ping());
    return { status: first.value === "PONG" ? "ok" : "error", firstMs: first.ms, warmMs: warm.ms };
  } catch (error) {
    return { status: "error", message: describeError(error) };
  } finally {
    client.disconnect();
  }
}

function hasValidToken(request: Request): boolean {
  const expected = process.env.HEALTH_TOKEN;
  const given = request.headers.get("x-health-token");
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<NextResponse> {
  const deployment = resolveDeploymentEnv(process.env);
  const detailsAllowed = deployment !== "production" || hasValidToken(request);

  if (!detailsAllowed) {
    return NextResponse.json({ ok: true, service: "doc-quiz" }, { headers: { "Cache-Control": "no-store" } });
  }

  const [database, redisRest, redisTcp] = await Promise.all([checkDatabase(), checkRedisRest(), checkRedisTcp()]);
  const checks = { database, redisRest, redisTcp };
  const ok = Object.values(checks).every((check) => check.status === "ok");
  const region = process.env.VERCEL_REGION ?? null;

  const body = {
    ok,
    service: "doc-quiz",
    deployment,
    region,
    expectedRegion: EXPECTED_REGION,
    // Auf einem lokalen Rechner gibt es keine Region, dann ist die Prüfung nicht anwendbar.
    regionOk: region === null ? null : region === EXPECTED_REGION,
    node: process.version,
    keyPrefix: resolveKeyPrefix(process.env),
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    // Nur die Namen gesetzter Variablen, niemals Werte.
    envPresent: {
      database: presentNames(process.env, [...DB_URL_NAMES, ...DB_URL_UNPOOLED_NAMES]),
      redisRest: presentNames(process.env, [...REDIS_REST_URL_NAMES, ...REDIS_REST_TOKEN_NAMES]),
      redisTcp: presentNames(process.env, REDIS_TCP_URL_NAMES),
    },
    checks,
  };

  return NextResponse.json(body, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
