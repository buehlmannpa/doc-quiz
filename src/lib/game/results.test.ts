import { describe, expect, it } from "vitest";
import { computeQuestionStats, type ResultQuestion, type ResultResponse } from "./results";

const mc: ResultQuestion = {
  id: "q1",
  type: "multiple_choice",
  prompt: "Farbe?",
  correctValue: null,
  options: [
    { id: "a", position: 0, text: "Blau", isCorrect: false },
    { id: "b", position: 1, text: "Rot", isCorrect: true },
  ],
};
const est: ResultQuestion = { id: "q2", type: "estimate", prompt: "PS?", correctValue: 200, options: [] };
const poll: ResultQuestion = {
  id: "q3",
  type: "poll",
  prompt: "Tour?",
  correctValue: null,
  options: [
    { id: "c", position: 0, text: "Furka", isCorrect: false },
    { id: "d", position: 1, text: "Grimsel", isCorrect: false },
  ],
};

const r = (questionId: string, extra: Partial<ResultResponse>): ResultResponse => ({
  questionId,
  optionId: null,
  numericValue: null,
  answerTimeMs: 1000,
  pointsAwarded: 0,
  ...extra,
});

describe("Kennzahlen pro Frage", () => {
  const responses = [
    r("q1", { optionId: "b", answerTimeMs: 2000, pointsAwarded: 900 }),
    r("q1", { optionId: "b", answerTimeMs: 4000, pointsAwarded: 800 }),
    r("q1", { optionId: "a", answerTimeMs: 3000 }),
    r("q2", { numericValue: 190, answerTimeMs: 5000, pointsAwarded: 400 }),
    r("q2", { numericValue: 230, answerTimeMs: 7000, pointsAwarded: 100 }),
    r("q3", { optionId: "d" }),
  ];
  const stats = computeQuestionStats([mc, est, poll], responses, 4);

  it("zählt Antworten, richtige Antworten und Verteilung bei Multiple Choice", () => {
    expect(stats[0]).toMatchObject({
      answered: 3,
      answeredShare: 0.75,
      correct: 2,
      correctShare: 0.5,
      avgAnswerTimeMs: 3000,
      distribution: [1, 2],
    });
    // Durchschnitt über alle Teilnehmenden, wer nicht antwortet, hat 0 Punkte.
    expect(stats[0]?.avgPoints).toBe((900 + 800) / 4);
  });

  it("berechnet Median, Spannweite und mittlere Abweichung bei Schätzfragen", () => {
    expect(stats[1]?.estimate).toEqual({ median: 210, min: 190, max: 230, meanAbsoluteDeviation: 20 });
    expect(stats[1]?.correct).toBeNull();
  });

  it("gibt bei Umfragen keine Punkte und keine richtigen Antworten an", () => {
    expect(stats[2]).toMatchObject({ answered: 1, correct: null, avgPoints: null, distribution: [0, 1] });
  });

  it("kommt mit leeren Daten und ohne Teilnehmende zurecht", () => {
    const empty = computeQuestionStats([mc, est], [], 0);
    expect(empty[0]).toMatchObject({ answered: 0, answeredShare: 0, correct: 0, avgAnswerTimeMs: null, distribution: [0, 0] });
    expect(empty[1]?.estimate).toBeNull();
  });
});
