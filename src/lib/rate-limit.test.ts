import { describe, expect, it } from "vitest";
import { createMemoryLimiter, hashKeyPart } from "./rate-limit";

describe("createMemoryLimiter", () => {
  it("lässt die erlaubte Anzahl durch und blockiert danach", () => {
    let now = 0;
    const limiter = createMemoryLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.hit("a")).toMatchObject({ allowed: false, remaining: 0 });
    now = 1000;
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("zählt jeden Schlüssel getrennt", () => {
    const limiter = createMemoryLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("b").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("beginnt nach Ablauf des Zeitfensters von vorn", () => {
    let now = 0;
    const limiter = createMemoryLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
    now = 1000;
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("nennt die Wartezeit bis zum Ende des Fensters", () => {
    let now = 0;
    const limiter = createMemoryLimiter({ limit: 1, windowMs: 10_000, now: () => now });
    limiter.hit("a");
    now = 4_000;
    expect(limiter.hit("a").retryAfterSeconds).toBe(6);
  });
});

describe("hashKeyPart", () => {
  it("liefert einen stabilen, kurzen Wert ohne Rückschluss auf die Eingabe", () => {
    const hash = hashKeyPart("203.0.113.7");
    expect(hash).toBe(hashKeyPart("203.0.113.7"));
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain("203");
    expect(hash).not.toBe(hashKeyPart("203.0.113.8"));
  });
});
