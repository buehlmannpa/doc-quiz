import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "./origin";

describe("isAllowedOrigin", () => {
  const hosts = ["quiz.example.ch", null];

  it("erlaubt die eigene Adresse", () => {
    expect(isAllowedOrigin("https://quiz.example.ch", hosts)).toBe(true);
    expect(isAllowedOrigin("https://QUIZ.example.ch", hosts)).toBe(true);
  });

  it("erlaubt Clients ohne Origin (keine Browser)", () => {
    expect(isAllowedOrigin(null, hosts)).toBe(true);
  });

  it("lehnt fremde Adressen ab, auch ähnlich aussehende", () => {
    for (const origin of [
      "https://evil.example.com",
      "https://quiz.example.ch.evil.com",
      "https://evilquiz.example.ch",
      "https://quiz.example.ch:8443",
      "http://other.quiz.example.ch",
    ]) {
      expect(isAllowedOrigin(origin, hosts), origin).toBe(false);
    }
  });

  it("lehnt ungültige Angaben und den Wert null ab", () => {
    for (const origin of ["null", "", "kein url", "javascript:alert(1)"]) {
      expect(isAllowedOrigin(origin, hosts), origin).toBe(false);
    }
  });

  it("berücksichtigt auch den weitergeleiteten Host und Ports", () => {
    expect(isAllowedOrigin("https://quiz.example.ch", [null, "quiz.example.ch"])).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", ["localhost:3000"])).toBe(true);
    expect(isAllowedOrigin("http://localhost:3001", ["localhost:3000"])).toBe(false);
  });

  it("lehnt alles ab, wenn kein Host bekannt ist", () => {
    expect(isAllowedOrigin("https://quiz.example.ch", [null, undefined, ""])).toBe(false);
  });
});
