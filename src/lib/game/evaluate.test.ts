import { describe, expect, it } from "vitest";
import type { PublicPlayer } from "@/lib/realtime/game-state";
import {
  buildFinalRows,
  evaluateQuestion,
  podiumSize,
  revealedPlaces,
  type PlayerScore,
  type StoredAnswer,
} from "./evaluate";
import type { SnapshotQuestion } from "./snapshot";

const players: PublicPlayer[] = [
  { id: "a", name: "Anna", avatar: 1 },
  { id: "b", name: "Beat", avatar: 2 },
  { id: "c", name: "Clara", avatar: 3 },
];

function mc(overrides: Partial<SnapshotQuestion> = {}): SnapshotQuestion {
  return {
    id: "q1",
    type: "multiple_choice",
    prompt: "Welche Farbe hat eine Ducati?",
    timeLimitSeconds: 20,
    maxPoints: 1000,
    options: [
      { id: "o0", text: "Blau", isCorrect: false },
      { id: "o1", text: "Rot", isCorrect: true },
      { id: "o2", text: "Grün", isCorrect: false },
    ],
    correctValue: null,
    unit: null,
    tolerance: null,
    ...overrides,
  };
}

const estimateQuestion: SnapshotQuestion = {
  id: "q2",
  type: "estimate",
  prompt: "Wie viele PS hat die Panigale V4?",
  timeLimitSeconds: 20,
  maxPoints: 1000,
  options: [],
  correctValue: 216,
  unit: "PS",
  tolerance: 50,
};

const pollQuestion: SnapshotQuestion = {
  id: "q3",
  type: "poll",
  prompt: "Welche Tour gefällt Ihnen?",
  timeLimitSeconds: 20,
  maxPoints: 0,
  options: [
    { id: "o0", text: "Furka", isCorrect: false },
    { id: "o1", text: "Grimsel", isCorrect: false },
  ],
  correctValue: null,
  unit: null,
  tolerance: null,
};

const answers = (entries: Record<string, StoredAnswer>) => new Map(Object.entries(entries));
const noPrior = new Map<string, PlayerScore>();

function evaluate(question: SnapshotQuestion, given: Record<string, StoredAnswer>, options: { index?: number; count?: number; prior?: Map<string, PlayerScore> } = {}) {
  return evaluateQuestion({
    question,
    index: options.index ?? 0,
    questionCount: options.count ?? 3,
    players,
    answers: answers(given),
    prior: options.prior ?? noPrior,
  });
}

describe("Auswertung Multiple Choice", () => {
  it("vergibt Punkte nach Richtigkeit und Zeit, falsche und fehlende Antworten geben 0", () => {
    const result = evaluate(mc(), { a: { o: 1, t: 100 }, b: { o: 0, t: 100 } });
    expect(result.results.a).toMatchObject({ answered: true, correct: true, points: 1000, option: 1 });
    expect(result.results.b).toMatchObject({ answered: true, correct: false, points: 0, option: 0 });
    expect(result.results.c).toMatchObject({ answered: false, correct: false, points: 0, option: null });
    expect(result.resolution.distribution).toEqual([1, 1, 0]);
    expect(result.resolution.answered).toBe(2);
    expect(result.resolution.correctOptions).toEqual([1]);
  });

  it("zählt bei mehreren richtigen Optionen jede als richtig", () => {
    const question = mc({
      options: [
        { id: "o0", text: "Rot", isCorrect: true },
        { id: "o1", text: "Weiss", isCorrect: true },
        { id: "o2", text: "Blau", isCorrect: false },
      ],
    });
    const result = evaluate(question, { a: { o: 0, t: 10_000 }, b: { o: 1, t: 10_000 }, c: { o: 2, t: 10_000 } });
    expect(result.results.a?.correct).toBe(true);
    expect(result.results.b?.correct).toBe(true);
    expect(result.results.c?.correct).toBe(false);
    expect(result.resolution.correctOptions).toEqual([0, 1]);
    // Halbe Zeit, also 75 Prozent der Punkte.
    expect(result.results.a?.points).toBe(750);
  });

  it("ignoriert ungültige Optionen wie keine Antwort", () => {
    const result = evaluate(mc(), { a: { o: 7, t: 100 } });
    expect(result.results.a?.answered).toBe(false);
    expect(result.resolution.answered).toBe(0);
  });

  it("rechnet nicht antwortende Spieler mit der vollen Zeitlimite in die Zeitsumme", () => {
    const result = evaluate(mc(), { a: { o: 1, t: 3000 } });
    expect(result.scores.a?.timeMs).toBe(3000);
    expect(result.scores.c?.timeMs).toBe(20_000);
  });
});

describe("Auswertung Schätzfrage", () => {
  it("berechnet Abweichung, Genauigkeit und Punkte und sortiert die Schätzungen", () => {
    const result = evaluate(estimateQuestion, { a: { v: 216, t: 100 }, b: { v: 241, t: 100 }, c: { v: 400, t: 100 } });
    expect(result.results.a).toMatchObject({ points: 1000, deviation: 0, accuracy: 1, correct: null, value: 216 });
    expect(result.results.b).toMatchObject({ points: 500, deviation: 25, accuracy: 0.5 });
    expect(result.results.c).toMatchObject({ points: 0, accuracy: 0 });
    expect(result.resolution.estimates).toEqual([216, 241, 400]);
    expect(result.resolution.correctValue).toBe(216);
    expect(result.resolution.tolerance).toBe(50);
    expect(result.resolution.unit).toBe("PS");
    expect(result.resolution.distribution).toEqual([]);
  });
});

describe("Auswertung Umfrage", () => {
  it("vergibt keine Punkte, zählt nur die Verteilung und blendet Rang und Rangliste aus", () => {
    const result = evaluate(pollQuestion, { a: { o: 0, t: 500 }, b: { o: 1, t: 500 }, c: { o: 1, t: 500 } });
    expect(result.resolution.distribution).toEqual([1, 2]);
    expect(result.resolution.top).toEqual([]);
    for (const player of players) {
      expect(result.results[player.id]).toMatchObject({ points: 0, rank: null, delta: null, correct: null });
    }
  });

  it("verändert Punkte und Zeitsummen nicht", () => {
    const prior = new Map<string, PlayerScore>(
      players.map((player, index) => [
        player.id,
        { total: 900 - index * 100, timeMs: 5000, rank: index + 1, position: index + 1, points: 0, answered: true, option: 0, value: null, answerTimeMs: 0, correct: true },
      ]),
    );
    const result = evaluate(pollQuestion, { a: { o: 0, t: 500 } }, { index: 1, prior });
    expect(result.scores.a).toMatchObject({ total: 900, timeMs: 5000, rank: 1 });
    expect(result.scores.c).toMatchObject({ total: 700, timeMs: 5000, rank: 3 });
  });
});

describe("Rangliste und Rangveränderung", () => {
  const first = evaluate(mc(), { a: { o: 1, t: 1000 }, b: { o: 1, t: 4000 }, c: { o: 0, t: 1000 } });

  it("ordnet nach Punkten, bei Gleichstand nach der Zeitsumme, und zeigt die Top 5", () => {
    expect(first.resolution.top.map((row) => row.name)).toEqual(["Anna", "Beat", "Clara"]);
    expect(first.resolution.top[0]).toMatchObject({ rank: 1, points: first.results.a?.points, delta: null });
  });

  it("berechnet die Rangänderung gegenüber der Vorfrage", () => {
    const prior = new Map(Object.entries(first.scores));
    // Clara gewinnt die zweite Frage mit grossem Vorsprung.
    const second = evaluate(estimateQuestion, { a: { v: 100, t: 5000 }, b: { v: 100, t: 5000 }, c: { v: 216, t: 200 } }, { index: 1, prior });
    const clara = second.resolution.top.find((row) => row.name === "Clara");
    expect(clara?.rank).toBe(1);
    expect(clara?.delta).toBe(2);
    expect(second.results.c).toMatchObject({ rank: 1, delta: 2, total: 1000 });
  });

  it("gibt gleichen Punkten den gleichen Rang und entscheidet die Reihenfolge nach der Zeit", () => {
    const tied = evaluate(mc(), { a: { o: 1, t: 10_000 }, b: { o: 1, t: 10_000 }, c: { o: 1, t: 10_000 } });
    expect(tied.results.a?.rank).toBe(1);
    expect(tied.results.b?.rank).toBe(1);
    expect(tied.results.c?.rank).toBe(1);
    // Gleiche Zeiten: die Anzeigereihenfolge ist trotzdem eindeutig.
    expect(new Set(Object.values(tied.scores).map((score) => score.position)).size).toBe(3);
  });

  it("zeigt nach der letzten Frage weder Rang noch Rangliste, rechnet aber den Stand", () => {
    const last = evaluate(mc(), { a: { o: 1, t: 1000 } }, { index: 2, count: 3 });
    expect(last.isLast).toBe(true);
    expect(last.resolution.top).toEqual([]);
    expect(last.results.a).toMatchObject({ rank: null, delta: null, total: null, correct: true });
    expect(last.scores.a?.rank).toBe(1);
  });

  it("begrenzt die Top Liste auf fünf Einträge", () => {
    const many: PublicPlayer[] = Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, name: `Person ${index}`, avatar: 0 }));
    const result = evaluateQuestion({ question: mc(), index: 0, questionCount: 2, players: many, answers: new Map(), prior: noPrior });
    expect(result.resolution.top).toHaveLength(5);
  });
});

describe("Siegerbildschirm", () => {
  const scores = new Map<string, PlayerScore>([
    ["a", { total: 3000, timeMs: 9000, rank: 1, position: 1, points: 0, answered: true, option: null, value: null, answerTimeMs: null, correct: null }],
    ["b", { total: 3000, timeMs: 12_000, rank: 1, position: 2, points: 0, answered: true, option: null, value: null, answerTimeMs: null, correct: null }],
    ["c", { total: 100, timeMs: 1000, rank: 3, position: 3, points: 0, answered: true, option: null, value: null, answerTimeMs: null, correct: null }],
  ]);
  const rows = buildFinalRows(players, scores);

  it("baut die Endrangliste mit gleichem Rang und eindeutiger Reihenfolge", () => {
    expect(rows.map((row) => [row.name, row.rank, row.position])).toEqual([
      ["Anna", 1, 1],
      ["Beat", 1, 2],
      ["Clara", 3, 3],
    ]);
  });

  it("zeigt höchstens drei Plätze und bei wenigen Teilnehmenden entsprechend weniger", () => {
    expect([podiumSize(0), podiumSize(1), podiumSize(2), podiumSize(3), podiumSize(60)]).toEqual([0, 1, 2, 3, 3]);
  });

  it("enthüllt von unten nach oben", () => {
    expect(revealedPlaces(rows, 3, 0)).toEqual([]);
    expect(revealedPlaces(rows, 3, 1).map((row) => row.name)).toEqual(["Clara"]);
    expect(revealedPlaces(rows, 3, 2).map((row) => row.name)).toEqual(["Clara", "Beat"]);
    expect(revealedPlaces(rows, 3, 3).map((row) => row.name)).toEqual(["Clara", "Beat", "Anna"]);
    expect(revealedPlaces(rows, 3, 9).map((row) => row.name)).toEqual(["Clara", "Beat", "Anna"]);
  });

  it("enthüllt bei zwei Plätzen zuerst Platz 2", () => {
    expect(revealedPlaces(rows, 2, 1).map((row) => row.name)).toEqual(["Beat"]);
    expect(revealedPlaces(rows, 1, 1).map((row) => row.name)).toEqual(["Anna"]);
  });
});
