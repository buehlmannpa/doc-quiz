/**
 * Auswertung einer Frage und Aufbau des Siegerbildschirms. Reine Funktionen ohne Redis und ohne Uhr.
 *
 * Die Auswertung ist deterministisch: Gleiche Antworten ergeben immer dasselbe Ergebnis. Das ist wichtig, weil
 * zwei Instanzen gleichzeitig auflösen können (zum Beispiel der Server nach der letzten Antwort und der Browser
 * des Admins bei Zeitablauf). Beide rechnen dasselbe, nur eine Änderung gewinnt den Versionsvergleich.
 *
 * Zeitannahmen (siehe docs/ANNAHMEN.md):
 * 1. Wer nicht antwortet, bekommt 0 Punkte und für den Gleichstand die volle Zeitlimite als Antwortzeit.
 * 2. Umfragen zählen weder bei den Punkten noch bei den Zeitsummen.
 * 3. Nach der letzten Frage sind Rang und Rangänderung in den Ergebnissen leer. Sie folgen erst im Siegerbildschirm.
 */
import { z } from "zod";
import type {
  FinalRow,
  PlayerResult,
  PublicPlayer,
  RankingRow,
  Resolution,
} from "@/lib/realtime/game-state";
import type { SnapshotQuestion } from "./snapshot";
import {
  clampAnswerTime,
  estimateAccuracy,
  estimatePoints,
  multipleChoicePoints,
  rankDelta,
  rankPlayers,
  type Ranked,
  type ScoreEntry,
} from "./scoring";

/** Eine gespeicherte Antwort. o ist die gewählte Option, v die Schätzung, t die Antwortzeit in Millisekunden. */
export type StoredAnswer = { o?: number; v?: number; t: number };

/**
 * Stand und Antwort eines Spielers nach einer Frage. Wird pro Frage in Redis abgelegt (ein Hash pro Frage, deshalb
 * lässt sich die Auflösung gefahrlos wiederholen) und beim Spielende nach Neon geschrieben.
 */
export const playerScoreSchema = z.object({
  /** Gesamtpunkte, Summe der Antwortzeiten (Millisekunden), Rang und Anzeigeplatz nach dieser Frage. */
  total: z.number().int(),
  timeMs: z.number().int(),
  rank: z.number().int().min(1),
  position: z.number().int().min(1),
  /** Punkte dieser Frage. */
  points: z.number().int(),
  answered: z.boolean(),
  /** Gewählte Option oder Schätzung, begrenzte Antwortzeit und Richtigkeit (nur bei Multiple Choice). */
  option: z.number().int().nullable(),
  value: z.number().nullable(),
  answerTimeMs: z.number().int().nullable(),
  correct: z.boolean().nullable(),
});
export type PlayerScore = z.infer<typeof playerScoreSchema>;

export type EvaluationInput = {
  question: SnapshotQuestion;
  /** Position der Frage im Quiz ab 0 und Gesamtzahl der Fragen. */
  index: number;
  questionCount: number;
  players: readonly PublicPlayer[];
  /** Antworten nach Spieler Kennung. */
  answers: ReadonlyMap<string, StoredAnswer>;
  /** Stand nach der Vorfrage, leer vor der ersten Frage. */
  prior: ReadonlyMap<string, PlayerScore>;
};

export type Evaluation = {
  resolution: Resolution;
  results: Record<string, PlayerResult>;
  scores: Record<string, PlayerScore>;
  isLast: boolean;
};

function isValidAnswer(question: SnapshotQuestion, answer: StoredAnswer): boolean {
  if (question.type === "estimate") return typeof answer.v === "number" && Number.isFinite(answer.v);
  return typeof answer.o === "number" && Number.isInteger(answer.o) && answer.o >= 0 && answer.o < question.options.length;
}

export function evaluateQuestion(input: EvaluationInput): Evaluation {
  const { question, index, questionCount, players, answers, prior } = input;
  const isLast = index === questionCount - 1;
  const isPoll = question.type === "poll";
  const limitMs = question.timeLimitSeconds * 1000;

  const correctOptions = question.options.flatMap((option, position) => (option.isCorrect ? [position] : []));
  const distribution = question.type === "estimate" ? [] : question.options.map(() => 0);
  const estimates: number[] = [];

  type Row = {
    player: PublicPlayer;
    points: number;
    timeMs: number;
    answerTimeMs: number;
    result: Omit<PlayerResult, "total" | "rank" | "delta">;
  };
  const rows: Row[] = [];
  let answered = 0;

  for (const player of players) {
    const stored = answers.get(player.id);
    const answer = stored && isValidAnswer(question, stored) ? stored : undefined;
    let points = 0;
    let correct: boolean | null = null;
    let deviation: number | null = null;
    let accuracy: number | null = null;
    let timeMs = isPoll ? 0 : limitMs;
    let answerTime = limitMs;

    if (answer) {
      answered += 1;
      answerTime = clampAnswerTime(answer.t, question.timeLimitSeconds);
      if (!isPoll) timeMs = answerTime;
      if (question.type === "estimate") {
        const value = answer.v as number;
        estimates.push(value);
        if (question.correctValue !== null && question.tolerance !== null) {
          deviation = value - question.correctValue;
          accuracy = estimateAccuracy(value, question.correctValue, question.tolerance);
          points = estimatePoints(
            value,
            question.correctValue,
            question.tolerance,
            answerTime,
            question.timeLimitSeconds,
            question.maxPoints,
          );
        }
      } else {
        const option = answer.o as number;
        distribution[option] = (distribution[option] ?? 0) + 1;
        if (question.type === "multiple_choice") {
          correct = correctOptions.includes(option);
          points = multipleChoicePoints(correct, answerTime, question.timeLimitSeconds, question.maxPoints);
        }
      }
    } else if (question.type === "multiple_choice") {
      correct = false;
    }

    rows.push({
      player,
      points,
      timeMs,
      answerTimeMs: answerTime,
      result: {
        answered: answer !== undefined,
        correct,
        points,
        option: answer && question.type !== "estimate" ? (answer.o ?? null) : null,
        value: answer && question.type === "estimate" ? (answer.v ?? null) : null,
        deviation,
        accuracy,
      },
    });
  }
  estimates.sort((a, b) => a - b);

  // Stand nach dieser Frage: Gesamtpunkte und Zeitsumme fortschreiben, dann ranken.
  const entries: (ScoreEntry & { points: number })[] = rows.map((row) => {
    const before = prior.get(row.player.id);
    return {
      id: row.player.id,
      name: row.player.name,
      points: row.points,
      total: (before?.total ?? 0) + row.points,
      timeMs: (before?.timeMs ?? 0) + row.timeMs,
    };
  });
  const ranked = rankPlayers(entries);
  const rankedById = new Map<string, Ranked<ScoreEntry & { points: number }>>(ranked.map((entry) => [entry.id, entry]));

  const scores: Record<string, PlayerScore> = {};
  const results: Record<string, PlayerResult> = {};
  for (const row of rows) {
    const entry = rankedById.get(row.player.id);
    if (!entry) continue;
    scores[row.player.id] = {
      total: entry.total,
      timeMs: entry.timeMs,
      rank: entry.rank,
      position: entry.position,
      points: row.points,
      answered: row.result.answered,
      option: row.result.option,
      value: row.result.value,
      answerTimeMs: row.result.answered ? row.answerTimeMs : null,
      correct: row.result.correct,
    };
    const hideRank = isPoll || isLast;
    results[row.player.id] = {
      ...row.result,
      total: entry.total,
      rank: hideRank ? null : entry.rank,
      delta: hideRank ? null : rankDelta(prior.get(row.player.id)?.rank, entry.rank),
    };
  }

  const playersById = new Map(players.map((player) => [player.id, player]));
  const top: RankingRow[] = [];
  if (!isPoll && !isLast) {
    for (const entry of ranked.slice(0, 5)) {
      const player = playersById.get(entry.id);
      if (!player) continue;
      top.push({
        playerId: entry.id,
        name: entry.name,
        avatar: player.avatar,
        rank: entry.rank,
        points: entry.points,
        total: entry.total,
        delta: rankDelta(prior.get(entry.id)?.rank, entry.rank),
      });
    }
  }

  return {
    resolution: {
      type: question.type,
      correctOptions: question.type === "multiple_choice" ? correctOptions : [],
      correctValue: question.type === "estimate" ? question.correctValue : null,
      tolerance: question.type === "estimate" ? question.tolerance : null,
      unit: question.type === "estimate" ? question.unit : null,
      distribution,
      estimates,
      answered,
      top,
    },
    results,
    scores,
    isLast,
  };
}

/**
 * Endrangliste aus dem Stand nach der letzten Frage. Die Reihenfolge ist die Anzeigereihenfolge (position),
 * gleiche Punkte haben denselben Rang.
 */
export function buildFinalRows(players: readonly PublicPlayer[], scores: ReadonlyMap<string, PlayerScore>): FinalRow[] {
  const entries: ScoreEntry[] = players.map((player) => {
    const score = scores.get(player.id);
    return { id: player.id, name: player.name, total: score?.total ?? 0, timeMs: score?.timeMs ?? 0 };
  });
  const playersById = new Map(players.map((player) => [player.id, player]));
  return rankPlayers(entries).map((entry) => ({
    playerId: entry.id,
    name: entry.name,
    avatar: playersById.get(entry.id)?.avatar ?? 0,
    rank: entry.rank,
    position: entry.position,
    points: entry.total,
    timeMs: entry.timeMs,
  }));
}

/** Anzahl der Plätze auf dem Podest: höchstens 3, bei weniger Teilnehmenden entsprechend weniger. */
export function podiumSize(playerCount: number): number {
  return Math.min(3, Math.max(0, playerCount));
}

/**
 * Die Plätze, die nach `revealed` Enthüllungen sichtbar sind. Die Enthüllung läuft von unten nach oben: Bei drei
 * Plätzen kommt zuerst Platz 3, dann Platz 2, dann Platz 1. Das Ergebnis steht in der Reihenfolge der Enthüllung.
 */
export function revealedPlaces(finalRows: readonly FinalRow[], size: number, revealed: number): FinalRow[] {
  const podium = finalRows.slice(0, size);
  const places: FinalRow[] = [];
  for (let step = 0; step < revealed && step < size; step += 1) {
    const place = podium[size - 1 - step];
    if (place) places.push(place);
  }
  return places;
}
