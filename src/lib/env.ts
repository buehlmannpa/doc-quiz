/**
 * Zentrale Prüfung der Umgebungsvariablen.
 *
 * Grundsätze:
 * 1. Jede Funktion bekommt die Quelle (normalerweise process.env) als Argument.
 *    So lässt sich die Logik ohne Umgebung testen.
 * 2. Fehlermeldungen nennen nur Variablennamen, niemals Werte (keine Zugangsdaten in Logs).
 * 3. Für die Marketplace Integrationen von Vercel sind die genauen Variablennamen in der
 *    offiziellen Doku nicht festgehalten. Deshalb werden mehrere übliche Namen akzeptiert.
 *    Die tatsächlich gesetzten Namen zeigt /api/health (ohne Werte).
 */
import { z } from "zod";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/** Bekannte Variablennamen, in der Reihenfolge ihrer Priorität. */
export const DB_URL_NAMES = ["DATABASE_URL"] as const;
export const DB_URL_UNPOOLED_NAMES = ["DATABASE_URL_UNPOOLED"] as const;
export const REDIS_REST_URL_NAMES = ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"] as const;
export const REDIS_REST_TOKEN_NAMES = ["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"] as const;
export const REDIS_TCP_URL_NAMES = ["REDIS_URL", "KV_URL"] as const;

/** Liefert den ersten gesetzten, nicht leeren Wert aus einer Liste von Variablennamen. */
function pick(
  source: EnvSource,
  names: readonly string[],
): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = source[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

/** Namen der gesetzten Variablen aus einer Liste (ohne Werte), für die Diagnose. */
export function presentNames(source: EnvSource, names: readonly string[]): string[] {
  return names.filter((name) => Boolean(source[name]?.trim()));
}

function fail(what: string, names: readonly string[], reason?: string): never {
  const list = names.join(" oder ");
  throw new EnvError(
    `${what} fehlt oder ist ungültig. Erwartet wird die Umgebungsvariable ${list}.` +
      (reason ? ` Grund: ${reason}` : ""),
  );
}

// ---------------------------------------------------------------------------
// Neon Postgres
// ---------------------------------------------------------------------------

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "muss mit postgres:// oder postgresql:// beginnen");

export type DbEnv = {
  /** Gepoolte Verbindung (PgBouncer). Für den normalen Betrieb der App. */
  databaseUrl: string;
  /** Direkte Verbindung. Für Migrationen mit Drizzle Kit. */
  databaseUrlUnpooled: string | undefined;
};

export function resolveDbEnv(source: EnvSource): DbEnv {
  const pooled = pick(source, DB_URL_NAMES);
  if (!pooled) fail("Die Datenbank Adresse", DB_URL_NAMES);
  const parsed = postgresUrl.safeParse(pooled.value);
  if (!parsed.success) fail("Die Datenbank Adresse", DB_URL_NAMES, parsed.error.issues[0]?.message);

  const direct = pick(source, DB_URL_UNPOOLED_NAMES);
  return { databaseUrl: pooled.value, databaseUrlUnpooled: direct?.value };
}

// ---------------------------------------------------------------------------
// Upstash Redis
// ---------------------------------------------------------------------------

export type RedisRestEnv = { url: string; token: string };

export function resolveRedisRestEnv(source: EnvSource): RedisRestEnv {
  const url = pick(source, REDIS_REST_URL_NAMES);
  if (!url) fail("Die Redis REST Adresse", REDIS_REST_URL_NAMES);
  // Produktiv ist TLS Pflicht. Unverschlüsseltes http:// ist nur für einen lokalen Ersatzserver erlaubt.
  const secure = url.value.startsWith("https://");
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url.value);
  if (!secure && !local) {
    fail("Die Redis REST Adresse", REDIS_REST_URL_NAMES, "muss mit https:// beginnen, nur lokal ist http:// erlaubt");
  }
  const token = pick(source, REDIS_REST_TOKEN_NAMES);
  if (!token) fail("Das Redis REST Token", REDIS_REST_TOKEN_NAMES);
  return { url: url.value, token: token.value };
}

export type RedisTcpEnv = { url: string };

/**
 * Adresse für die TCP Verbindung (Subscriber). Produktiv ist TLS Pflicht (rediss://).
 * Unverschlüsseltes redis:// ist nur für einen lokalen Redis Server erlaubt.
 */
export function resolveRedisTcpEnv(source: EnvSource): RedisTcpEnv {
  const entry = pick(source, REDIS_TCP_URL_NAMES);
  if (!entry) fail("Die Redis TCP Adresse", REDIS_TCP_URL_NAMES);
  const value = entry.value;
  const secure = value.startsWith("rediss://");
  const local = /^redis:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value);
  if (!secure && !local) {
    fail(
      "Die Redis TCP Adresse",
      REDIS_TCP_URL_NAMES,
      "muss mit rediss:// beginnen (TLS), nur lokal ist redis:// erlaubt",
    );
  }
  return { url: value };
}

// ---------------------------------------------------------------------------
// Admin Zugang (Meilenstein 2)
// ---------------------------------------------------------------------------

const adminSchema = z.object({
  ADMIN_PASSWORD: z.string().min(8, "mindestens 8 Zeichen"),
  SESSION_SECRET: z.string().min(32, "mindestens 32 Zeichen"),
});

export type AdminEnv = { adminPassword: string; sessionSecret: string };

/** Es gibt bewusst keinen Ersatzwert: Ohne SESSION_SECRET startet der Admin Bereich nicht. */
export function resolveAdminEnv(source: EnvSource): AdminEnv {
  const parsed = adminSchema.safeParse({
    ADMIN_PASSWORD: source.ADMIN_PASSWORD,
    SESSION_SECRET: source.SESSION_SECRET,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${String(issue.path[0])}: ${issue.message}`)
      .join(", ");
    throw new EnvError(`Der Admin Zugang ist nicht korrekt konfiguriert (${details}).`);
  }
  return {
    adminPassword: parsed.data.ADMIN_PASSWORD,
    sessionSecret: parsed.data.SESSION_SECRET,
  };
}

/**
 * Nur das Geheimnis, ohne das Admin Passwort. Es signiert das Admin Cookie und dient als Schlüssel für den Hash
 * der Spielertoken. Der Spielbetrieb soll nicht vom Admin Passwort abhängen. Wird das Geheimnis geändert,
 * werden alle Anmeldungen und alle Spielertoken ungültig.
 */
export function resolveSessionSecret(source: EnvSource): string {
  const parsed = adminSchema.shape.SESSION_SECRET.safeParse(source.SESSION_SECRET);
  if (!parsed.success) {
    throw new EnvError("SESSION_SECRET fehlt oder ist zu kurz (mindestens 32 Zeichen).");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Umgebung, Schlüsselpräfix, Schalter
// ---------------------------------------------------------------------------

export type DeploymentEnv = "production" | "preview" | "development" | "local";

export function resolveDeploymentEnv(source: EnvSource): DeploymentEnv {
  const value = source.VERCEL_ENV;
  if (value === "production" || value === "preview" || value === "development") return value;
  return "local";
}

/**
 * Präfix für alle Redis Schlüssel und Kanäle.
 * Upstash Free erlaubt nur eine Datenbank. Produktion, Preview und lokale Entwicklung
 * teilen sich diese Datenbank und werden über das Präfix getrennt.
 */
export function resolveKeyPrefix(source: EnvSource): string {
  const override = source.APP_KEY_PREFIX?.trim();
  if (override) {
    if (!/^[a-z0-9]{1,16}$/.test(override)) {
      throw new EnvError("APP_KEY_PREFIX darf nur aus Kleinbuchstaben und Ziffern bestehen (1 bis 16 Zeichen).");
    }
    return override;
  }
  switch (resolveDeploymentEnv(source)) {
    case "production":
      return "prod";
    case "preview":
      return "preview";
    case "development":
      return "dev";
    default:
      return "local";
  }
}

/** Die Test Endpunkte (Spike) sind nur aktiv, wenn SPIKE_ENABLED=1 gesetzt ist. */
export function isSpikeEnabled(source: EnvSource): boolean {
  return source.SPIKE_ENABLED === "1";
}

// ---------------------------------------------------------------------------
// Zwischengespeicherte Zugriffe auf process.env
// ---------------------------------------------------------------------------

let dbEnvCache: DbEnv | undefined;
let keyPrefixCache: string | undefined;

export function getDbEnv(): DbEnv {
  return (dbEnvCache ??= resolveDbEnv(process.env));
}

export function getKeyPrefix(): string {
  return (keyPrefixCache ??= resolveKeyPrefix(process.env));
}
