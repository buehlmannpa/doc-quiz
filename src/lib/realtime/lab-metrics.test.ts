import { describe, expect, it } from "vitest";
import { countBy, isLabCode, percentile, randomLabCode, summarize, summarizeBroadcast } from "./lab-metrics";

describe("percentile und summarize", () => {
  it("liefert null bei leerer Eingabe", () => {
    expect(percentile([], 50)).toBeNull();
    expect(summarize([])).toEqual({ count: 0, min: null, p50: null, p95: null, max: null });
  });

  it("berechnet Perzentile nach Nearest Rank, ohne die Eingabe zu verändern", () => {
    const values = [90, 10, 50, 30, 70, 20, 80, 60, 100, 40];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 0)).toBe(10);
    expect(values[0]).toBe(90);
    expect(summarize(values)).toEqual({ count: 10, min: 10, p50: 50, p95: 100, max: 100 });
  });

  it("rundet auf eine Nachkommastelle", () => {
    expect(percentile([1.234], 50)).toBe(1.2);
  });
});

describe("summarizeBroadcast", () => {
  const sends = [
    { version: 1, sentServerTime: 1000 },
    { version: 2, sentServerTime: 2000 },
  ];

  it("berechnet Zustellung und Laufzeit", () => {
    const a = new Map([[1, 1010], [2, 2020]]);
    const b = new Map([[1, 1030], [2, 2040]]);
    const result = summarizeBroadcast(sends, [a, b]);
    expect(result).toMatchObject({ sends: 2, receivers: 2, expected: 4, delivered: 4, missing: 0 });
    expect(result.latencyMs).toMatchObject({ count: 4, min: 10, max: 40 });
  });

  it("zählt fehlende Zustellungen", () => {
    const complete = new Map([[1, 1010], [2, 2010]]);
    const partial = new Map([[2, 2050]]);
    const result = summarizeBroadcast(sends, [complete, partial]);
    expect(result).toMatchObject({ expected: 4, delivered: 3, missing: 1 });
  });

  it("wertet negative Laufzeiten wegen Uhrenabweichung als 0", () => {
    const result = summarizeBroadcast([{ version: 1, sentServerTime: 1000 }], [new Map([[1, 990]])]);
    expect(result.latencyMs.min).toBe(0);
  });

  it("kommt mit leeren Eingaben zurecht", () => {
    expect(summarizeBroadcast([], [])).toMatchObject({ expected: 0, delivered: 0, missing: 0 });
    expect(summarizeBroadcast(sends, [])).toMatchObject({ expected: 0, receivers: 0 });
  });
});

describe("countBy", () => {
  it("zählt Werte", () => {
    expect(countBy(["a", "b", "a", "a"])).toEqual({ a: 3, b: 1 });
    expect(countBy([4012, 1006, 4012])).toEqual({ "4012": 2, "1006": 1 });
    expect(countBy([])).toEqual({});
  });
});

describe("Spielcodes des Labors", () => {
  it("liegen von echten Spielen getrennt im Bereich 9xxxxx", () => {
    expect(isLabCode("900000")).toBe(true);
    expect(isLabCode("999999")).toBe(true);
    for (const code of ["899999", "100000", "90000", "9000000", "9abcde", ""]) expect(isLabCode(code), code).toBe(false);
  });

  it("erzeugt gültige Codes über den ganzen Bereich", () => {
    expect(randomLabCode(() => 0)).toBe("900000");
    expect(randomLabCode(() => 0.999999)).toBe("999999");
    for (let i = 0; i < 100; i += 1) expect(isLabCode(randomLabCode())).toBe(true);
  });
});
