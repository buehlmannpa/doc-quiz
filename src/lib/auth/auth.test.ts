import { describe, expect, it } from "vitest";
import { checkPassword } from "./password";
import { createSessionToken, verifySessionToken } from "./token";

const SECRET = "ein sehr langes geheimes testgeheimnis mit mehr als 32 zeichen";
const NOW = 1_800_000_000_000; // fester Zeitpunkt in Millisekunden

describe("Session Token", () => {
  it("ist unmittelbar nach dem Erstellen gültig", () => {
    const token = createSessionToken(SECRET, NOW, 3600);
    const check = verifySessionToken(SECRET, token, NOW + 1000);
    expect(check.valid).toBe(true);
    if (check.valid) expect(check.expiresAt).toBe(Math.floor(NOW / 1000) + 3600);
  });

  it("läuft zum angegebenen Zeitpunkt ab", () => {
    const token = createSessionToken(SECRET, NOW, 3600);
    expect(verifySessionToken(SECRET, token, NOW + 3599 * 1000).valid).toBe(true);
    const expired = verifySessionToken(SECRET, token, NOW + 3600 * 1000);
    expect(expired).toEqual({ valid: false, reason: "expired" });
  });

  it("lehnt ein Token mit falschem Geheimnis ab", () => {
    const token = createSessionToken(SECRET, NOW, 3600);
    expect(verifySessionToken("ein ganz anderes geheimnis, auch lang genug", token, NOW)).toEqual({
      valid: false,
      reason: "signature",
    });
  });

  it("lehnt ein verändertes Ablaufdatum ab", () => {
    const token = createSessionToken(SECRET, NOW, 60);
    const [, nonce, signature] = token.split(".");
    const forged = `${Math.floor(NOW / 1000) + 999_999}.${nonce}.${signature}`;
    expect(verifySessionToken(SECRET, forged, NOW)).toEqual({ valid: false, reason: "signature" });
  });

  it("lehnt eine veränderte Signatur und falsche Formate ab", () => {
    const token = createSessionToken(SECRET, NOW, 3600);
    expect(verifySessionToken(SECRET, token.slice(0, -1) + "x", NOW).valid).toBe(false);
    for (const bad of [undefined, "", "abc", "1.2", "a.b.c", "1.2.3.4", "123456.zzzzzzzzzzzzzzzz.AAAA"]) {
      expect(verifySessionToken(SECRET, bad, NOW).valid).toBe(false);
    }
  });

  it("erzeugt bei jedem Aufruf ein anderes Token", () => {
    expect(createSessionToken(SECRET, NOW, 3600)).not.toBe(createSessionToken(SECRET, NOW, 3600));
  });
});

describe("checkPassword", () => {
  it("akzeptiert das richtige und lehnt jedes andere Passwort ab", () => {
    expect(checkPassword("geheim123", "geheim123", SECRET)).toBe(true);
    expect(checkPassword("geheim124", "geheim123", SECRET)).toBe(false);
    expect(checkPassword("", "geheim123", SECRET)).toBe(false);
    expect(checkPassword("geheim123 ", "geheim123", SECRET)).toBe(false);
    expect(checkPassword("GEHEIM123", "geheim123", SECRET)).toBe(false);
  });

  it("funktioniert bei sehr unterschiedlichen Längen", () => {
    expect(checkPassword("x".repeat(500), "kurz", SECRET)).toBe(false);
    expect(checkPassword("k", "k".repeat(500), SECRET)).toBe(false);
  });
});
