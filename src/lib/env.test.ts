import { describe, expect, it } from "vitest";
import {
  EnvError,
  isSpikeEnabled,
  presentNames,
  resolveAdminEnv,
  resolveDbEnv,
  resolveDeploymentEnv,
  resolveKeyPrefix,
  resolveRedisRestEnv,
  resolveRedisTcpEnv,
} from "./env";

const PG = "postgresql://user:pw@host.example.neon.tech/db?sslmode=require";

describe("resolveDbEnv", () => {
  it("liest die gepoolte und die direkte Adresse", () => {
    const env = resolveDbEnv({ DATABASE_URL: PG, DATABASE_URL_UNPOOLED: PG + "&x=1" });
    expect(env.databaseUrl).toBe(PG);
    expect(env.databaseUrlUnpooled).toBe(PG + "&x=1");
  });

  it("verlangt DATABASE_URL", () => {
    expect(() => resolveDbEnv({})).toThrow(EnvError);
    expect(() => resolveDbEnv({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL/);
  });

  it("lehnt fremde Protokolle ab", () => {
    expect(() => resolveDbEnv({ DATABASE_URL: "mysql://x" })).toThrow(/postgres/);
  });

  it("nennt in Fehlermeldungen niemals den Wert", () => {
    try {
      resolveDbEnv({ DATABASE_URL: "mysql://geheim:passwort@host" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("passwort");
    }
  });
});

describe("resolveRedisRestEnv", () => {
  it("akzeptiert die Upstash Namen", () => {
    const env = resolveRedisRestEnv({
      UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t1",
    });
    expect(env).toEqual({ url: "https://x.upstash.io", token: "t1" });
  });

  it("akzeptiert die KV Namen als Ersatz", () => {
    const env = resolveRedisRestEnv({
      KV_REST_API_URL: "https://y.upstash.io",
      KV_REST_API_TOKEN: "t2",
    });
    expect(env).toEqual({ url: "https://y.upstash.io", token: "t2" });
  });

  it("bevorzugt die Upstash Namen vor den KV Namen", () => {
    const env = resolveRedisRestEnv({
      UPSTASH_REDIS_REST_URL: "https://a.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "a",
      KV_REST_API_URL: "https://b.upstash.io",
      KV_REST_API_TOKEN: "b",
    });
    expect(env.url).toBe("https://a.upstash.io");
  });

  it("verlangt https für entfernte Server und ein Token", () => {
    expect(() =>
      resolveRedisRestEnv({ UPSTASH_REDIS_REST_URL: "http://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }),
    ).toThrow(/https/);
    expect(() => resolveRedisRestEnv({ UPSTASH_REDIS_REST_URL: "https://x" })).toThrow(/TOKEN/);
  });

  it("erlaubt unverschlüsseltes http nur lokal", () => {
    expect(
      resolveRedisRestEnv({ UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079", UPSTASH_REDIS_REST_TOKEN: "t" }).url,
    ).toBe("http://127.0.0.1:8079");
    expect(() =>
      resolveRedisRestEnv({ UPSTASH_REDIS_REST_URL: "http://localhost.evil.example", UPSTASH_REDIS_REST_TOKEN: "t" }),
    ).toThrow(/https/);
  });
});

describe("resolveRedisTcpEnv", () => {
  it("verlangt TLS für entfernte Server", () => {
    expect(resolveRedisTcpEnv({ REDIS_URL: "rediss://default:t@x.upstash.io:6379" }).url).toContain(
      "rediss://",
    );
    expect(() => resolveRedisTcpEnv({ REDIS_URL: "redis://default:t@x.upstash.io:6379" })).toThrow(
      /rediss/,
    );
  });

  it("erlaubt unverschlüsselt nur lokal", () => {
    expect(resolveRedisTcpEnv({ REDIS_URL: "redis://localhost:6379" }).url).toBe("redis://localhost:6379");
    expect(resolveRedisTcpEnv({ REDIS_URL: "redis://127.0.0.1:6379/0" }).url).toBe(
      "redis://127.0.0.1:6379/0",
    );
    // Ein Server, dessen Name nur mit localhost beginnt, ist nicht lokal.
    expect(() => resolveRedisTcpEnv({ REDIS_URL: "redis://localhost.evil.example:6379" })).toThrow();
  });

  it("akzeptiert KV_URL als Ersatz", () => {
    expect(resolveRedisTcpEnv({ KV_URL: "rediss://default:t@x.upstash.io:6379" }).url).toContain("upstash");
  });
});

describe("resolveAdminEnv", () => {
  it("verlangt ein langes Geheimnis und ein Passwort", () => {
    const ok = resolveAdminEnv({ ADMIN_PASSWORD: "geheim123", SESSION_SECRET: "x".repeat(32) });
    expect(ok.adminPassword).toBe("geheim123");
    expect(() => resolveAdminEnv({ ADMIN_PASSWORD: "geheim123", SESSION_SECRET: "kurz" })).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => resolveAdminEnv({ SESSION_SECRET: "x".repeat(32) })).toThrow(/ADMIN_PASSWORD/);
  });

  it("hat keinen Ersatzwert für das Geheimnis", () => {
    expect(() => resolveAdminEnv({ ADMIN_PASSWORD: "geheim123" })).toThrow(EnvError);
  });
});

describe("Umgebung und Schlüsselpräfix", () => {
  it("erkennt die Vercel Umgebung", () => {
    expect(resolveDeploymentEnv({ VERCEL_ENV: "production" })).toBe("production");
    expect(resolveDeploymentEnv({ VERCEL_ENV: "preview" })).toBe("preview");
    expect(resolveDeploymentEnv({ VERCEL_ENV: "development" })).toBe("development");
    expect(resolveDeploymentEnv({})).toBe("local");
    expect(resolveDeploymentEnv({ VERCEL_ENV: "unbekannt" })).toBe("local");
  });

  it("trennt die Umgebungen über das Präfix", () => {
    expect(resolveKeyPrefix({ VERCEL_ENV: "production" })).toBe("prod");
    expect(resolveKeyPrefix({ VERCEL_ENV: "preview" })).toBe("preview");
    expect(resolveKeyPrefix({ VERCEL_ENV: "development" })).toBe("dev");
    expect(resolveKeyPrefix({})).toBe("local");
  });

  it("erlaubt ein Präfix per APP_KEY_PREFIX, aber nur in sicherer Form", () => {
    expect(resolveKeyPrefix({ APP_KEY_PREFIX: "test1", VERCEL_ENV: "production" })).toBe("test1");
    expect(() => resolveKeyPrefix({ APP_KEY_PREFIX: "a:b" })).toThrow(EnvError);
    expect(() => resolveKeyPrefix({ APP_KEY_PREFIX: "*" })).toThrow(EnvError);
  });
});

describe("Hilfsfunktionen", () => {
  it("meldet gesetzte Namen ohne Werte", () => {
    expect(presentNames({ A: "x", B: "", C: "  ", D: "y" }, ["A", "B", "C", "D", "E"])).toEqual(["A", "D"]);
  });

  it("schaltet die Spike Endpunkte nur mit SPIKE_ENABLED=1 frei", () => {
    expect(isSpikeEnabled({ SPIKE_ENABLED: "1" })).toBe(true);
    expect(isSpikeEnabled({ SPIKE_ENABLED: "true" })).toBe(false);
    expect(isSpikeEnabled({})).toBe(false);
  });
});
