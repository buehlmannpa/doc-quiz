import { describe, expect, it } from "vitest";
import {
  clampAnswerTime,
  estimateAccuracy,
  estimatePoints,
  FULL_POINTS_BELOW_MS,
  multipleChoicePoints,
  rankDelta,
  rankPlayers,
  timeFactor,
} from "./scoring";

describe("Zeitfaktor", () => {
  it("ist 1 bei sehr schneller Antwort und fällt linear bis 0.5 beim Ablauf", () => {
    expect(timeFactor(0, 20)).toBe(1);
    expect(timeFactor(FULL_POINTS_BELOW_MS - 1, 20)).toBe(1);
    expect(timeFactor(10_000, 20)).toBeCloseTo(0.75, 10);
    expect(timeFactor(20_000, 20)).toBe(0.5);
  });

  it("hat bei genau 0.5 Sekunden einen kleinen Sprung (wörtliche Umsetzung der Vorgabe)", () => {
    expect(timeFactor(499, 20)).toBe(1);
    expect(timeFactor(500, 20)).toBeCloseTo(0.9875, 10);
  });

  it("begrenzt Antwortzeiten ausserhalb des Bereichs", () => {
    expect(timeFactor(-50, 20)).toBe(1);
    expect(timeFactor(25_000, 20)).toBe(0.5); // Gnadenfrist: zählt wie die volle Zeit
    expect(clampAnswerTime(25_000, 20)).toBe(20_000);
    expect(clampAnswerTime(-5, 20)).toBe(0);
    expect(clampAnswerTime(Number.NaN, 20)).toBe(20_000);
    expect(clampAnswerTime(1234.6, 20)).toBe(1235);
  });
});

describe("multipleChoicePoints", () => {
  it("gibt unter 0.5 Sekunden die volle Punktzahl", () => {
    expect(multipleChoicePoints(true, 0, 20, 1000)).toBe(1000);
    expect(multipleChoicePoints(true, 499, 20, 1000)).toBe(1000);
  });

  it("rechnet die Formel von Kahoot", () => {
    expect(multipleChoicePoints(true, 10_000, 20, 1000)).toBe(750);
    expect(multipleChoicePoints(true, 20_000, 20, 1000)).toBe(500);
    expect(multipleChoicePoints(true, 5_000, 20, 800)).toBe(700);
    expect(multipleChoicePoints(true, 1_000, 10, 1000)).toBe(950);
  });

  it("rundet auf die nächste ganze Zahl, 0.5 nach oben", () => {
    // (1 minus 0.5 durch 20 durch 2) mal 1000 ergibt genau 987.5
    expect(multipleChoicePoints(true, 500, 20, 1000)).toBe(988);
    expect(multipleChoicePoints(true, 7_000, 15, 1000)).toBe(Math.round(1000 * (1 - 7 / 15 / 2)));
  });

  it("gibt für falsche Antworten und ungültige Eingaben 0 Punkte", () => {
    expect(multipleChoicePoints(false, 0, 20, 1000)).toBe(0);
    expect(multipleChoicePoints(true, 0, 20, 0)).toBe(0);
    expect(multipleChoicePoints(true, 0, 0, 1000)).toBe(0);
    expect(multipleChoicePoints(true, 0, 20, -5)).toBe(0);
  });

  it("liefert nie mehr als die maximalen Punkte und nie weniger als die Hälfte", () => {
    for (let time = 0; time <= 25_000; time += 137) {
      const points = multipleChoicePoints(true, time, 20, 1000);
      expect(points).toBeLessThanOrEqual(1000);
      expect(points).toBeGreaterThanOrEqual(500);
    }
  });

  it("sinkt mit der Zeit nie wieder (monoton)", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let time = 0; time <= 20_000; time += 50) {
      const points = multipleChoicePoints(true, time, 20, 1000);
      expect(points).toBeLessThanOrEqual(previous);
      previous = points;
    }
  });
});

describe("Schätzfrage", () => {
  it("bewertet die Genauigkeit linear bis zur Toleranz", () => {
    expect(estimateAccuracy(216, 216, 50)).toBe(1);
    expect(estimateAccuracy(241, 216, 50)).toBeCloseTo(0.5, 10);
    expect(estimateAccuracy(191, 216, 50)).toBeCloseTo(0.5, 10);
    expect(estimateAccuracy(266, 216, 50)).toBe(0);
    expect(estimateAccuracy(1000, 216, 50)).toBe(0);
    expect(estimateAccuracy(-1000, 216, 50)).toBe(0);
  });

  it("gibt bei ungültigen Werten Genauigkeit 0", () => {
    expect(estimateAccuracy(Number.NaN, 1, 1)).toBe(0);
    expect(estimateAccuracy(1, 1, 0)).toBe(0);
    expect(estimateAccuracy(1, 1, -2)).toBe(0);
    expect(estimateAccuracy(Number.POSITIVE_INFINITY, 1, 1)).toBe(0);
  });

  it("multipliziert Genauigkeit und Zeitfaktor", () => {
    // genau richtig und schnell: volle Punkte
    expect(estimatePoints(216, 216, 50, 100, 30, 1000)).toBe(1000);
    // halbe Genauigkeit, schnell: die Hälfte
    expect(estimatePoints(241, 216, 50, 100, 30, 1000)).toBe(500);
    // genau richtig, nach der halben Zeit: 75 Prozent
    expect(estimatePoints(216, 216, 50, 15_000, 30, 1000)).toBe(750);
    // halbe Genauigkeit und halbe Zeit: 0.5 mal 0.75
    expect(estimatePoints(241, 216, 50, 15_000, 30, 1000)).toBe(375);
  });

  it("gibt 0 Punkte ausserhalb der Toleranz", () => {
    expect(estimatePoints(266, 216, 50, 0, 30, 1000)).toBe(0);
    expect(estimatePoints(900, 216, 50, 0, 30, 1000)).toBe(0);
  });

  it("kommt mit Dezimalzahlen und negativen Werten zurecht", () => {
    expect(estimatePoints(-2.5, -2, 1, 0, 20, 1000)).toBe(500);
    expect(estimatePoints(0.3, 0.25, 0.1, 0, 20, 1000)).toBe(500);
  });
});

describe("rankPlayers", () => {
  const p = (id: string, name: string, total: number, timeMs: number) => ({ id, name, total, timeMs });

  it("sortiert nach Punkten und bei Gleichstand nach der kleineren Zeitsumme", () => {
    const ranked = rankPlayers([p("a", "Anna", 500, 9000), p("b", "Ben", 800, 20000), p("c", "Cleo", 500, 4000)]);
    expect(ranked.map((r) => r.name)).toEqual(["Ben", "Cleo", "Anna"]);
  });

  it("vergibt bei gleichen Punkten den gleichen Rang und überspringt danach", () => {
    const ranked = rankPlayers([p("a", "Anna", 500, 100), p("b", "Ben", 500, 200), p("c", "Cleo", 300, 100), p("d", "Dan", 800, 100)]);
    expect(ranked.map((r) => [r.name, r.rank, r.position])).toEqual([
      ["Dan", 1, 1],
      ["Anna", 2, 2],
      ["Ben", 2, 3],
      ["Cleo", 4, 4],
    ]);
  });

  it("sortiert bei völligem Gleichstand nach Name und ist stabil bei jeder Eingabereihenfolge", () => {
    const entries = [p("c", "Cleo", 100, 100), p("a", "Anna", 100, 100), p("b", "Ben", 100, 100)];
    const forward = rankPlayers(entries).map((r) => r.name);
    const backward = rankPlayers([...entries].reverse()).map((r) => r.name);
    expect(forward).toEqual(["Anna", "Ben", "Cleo"]);
    expect(backward).toEqual(forward);
    expect(rankPlayers(entries).every((r) => r.rank === 1)).toBe(true);
  });

  it("verändert die Eingabe nicht und behandelt eine leere Liste", () => {
    const entries = [p("a", "Anna", 1, 1), p("b", "Ben", 2, 1)];
    rankPlayers(entries);
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(rankPlayers([])).toEqual([]);
  });

  it("behält zusätzliche Felder", () => {
    const ranked = rankPlayers([{ id: "a", name: "Anna", total: 1, timeMs: 1, avatar: 7 }]);
    expect(ranked[0]?.avatar).toBe(7);
  });

  it("sortiert Umlaute nach deutscher Regel", () => {
    const ranked = rankPlayers([p("1", "Zoë", 0, 0), p("2", "Ärger", 0, 0), p("3", "Anna", 0, 0)]);
    expect(ranked.map((r) => r.name)).toEqual(["Anna", "Ärger", "Zoë"]);
  });
});

describe("rankDelta", () => {
  it("ist positiv bei Aufstieg, negativ bei Abstieg und null ohne früheren Rang", () => {
    expect(rankDelta(5, 2)).toBe(3);
    expect(rankDelta(2, 5)).toBe(-3);
    expect(rankDelta(3, 3)).toBe(0);
    expect(rankDelta(null, 3)).toBeNull();
    expect(rankDelta(undefined, 3)).toBeNull();
  });
});
