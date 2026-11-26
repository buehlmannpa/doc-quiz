import { describe, expect, it } from "vitest";
import { buildChannel, buildKey } from "./keys";

describe("buildKey", () => {
  it("setzt Präfix und Teile mit Doppelpunkt zusammen", () => {
    expect(buildKey("prod", "game", "123456", "state")).toBe("prod:game:123456:state");
  });

  it("trennt Umgebungen: gleicher Code, anderes Präfix, anderer Schlüssel", () => {
    expect(buildKey("prod", "game", "123456")).not.toBe(buildKey("preview", "game", "123456"));
  });

  it("erlaubt UUIDs", () => {
    expect(buildKey("dev", "player", "3f2b8c1e-9a4d-4c55-8f0e-1d2c3b4a5f60")).toContain("3f2b8c1e");
  });

  it("verbietet Platzhalter, Leerzeichen und Trennzeichen in Teilen", () => {
    for (const bad of ["*", "a b", "a:b", "x?", "[a]", "", "a\nb", "a".repeat(65)]) {
      expect(() => buildKey("prod", "game", bad)).toThrow();
    }
  });

  it("verlangt mindestens einen Teil", () => {
    expect(() => buildKey("prod")).toThrow();
  });
});

describe("buildChannel", () => {
  it("unterscheidet Kanäle von Schlüsseln", () => {
    expect(buildChannel("prod", "game", "123456")).toBe("prod:ch:game:123456");
    expect(buildChannel("prod", "game", "123456")).not.toBe(buildKey("prod", "game", "123456"));
  });
});
