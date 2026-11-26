/**
 * Punkteberechnung und Rangliste. Reine Funktionen ohne Zustand, vollständig getestet.
 *
 * Multiple Choice (wie Kahoot):
 *   Punkte = runden((1 minus (Antwortzeit durch Zeitlimit) durch 2) mal maximale Punkte)
 *   Unter 0.5 Sekunden gibt es die volle Punktzahl. Falsch oder keine Antwort: 0 Punkte.
 * Schätzfrage:
 *   Genauigkeit = max(0, 1 minus |Schätzung minus richtiger Wert| durch Toleranz)
 *   Punkte = runden(Genauigkeit mal (1 minus (Antwortzeit durch Zeitlimit) durch 2) mal maximale Punkte)
 * Umfrage: keine Punkte.
 *
 * Die Zeitwertung wird mit ganzen Zahlen gerechnet (Millisekunden). So entstehen keine Rundungsfehler durch
 * Fliesskommazahlen, und eine Punktzahl wie 987.5 wird zuverlässig zu 988.
 */

/** Unter dieser Antwortzeit gibt es die volle Punktzahl. */
export const FULL_POINTS_BELOW_MS = 500;

function limitMs(timeLimitSeconds: number): number {
  return Math.round(timeLimitSeconds * 1000);
}

/** Antwortzeit begrenzt auf 0 bis zum Zeitlimit (eine Antwort in der Gnadenfrist zählt mit der vollen Zeit). */
export function clampAnswerTime(answerTimeMs: number, timeLimitSeconds: number): number {
  if (!Number.isFinite(answerTimeMs)) return limitMs(timeLimitSeconds);
  return Math.min(Math.max(0, Math.round(answerTimeMs)), limitMs(timeLimitSeconds));
}

/**
 * Anteil der Punkte, der von der Geschwindigkeit übrig bleibt, als Bruch (Zähler, Nenner) in ganzen Zahlen.
 * Schnell ergibt 1, mit Ablauf der Zeit sinkt er linear bis auf die Hälfte.
 */
function timeFraction(answerTimeMs: number, timeLimitSeconds: number): { numerator: number; denominator: number } {
  const limit = limitMs(timeLimitSeconds);
  const time = clampAnswerTime(answerTimeMs, timeLimitSeconds);
  if (time < FULL_POINTS_BELOW_MS) return { numerator: 1, denominator: 1 };
  return { numerator: 2 * limit - time, denominator: 2 * limit };
}

/** Zeitfaktor zwischen 0.5 und 1 (nur für die Anzeige und für Tests, die Berechnung nutzt ganze Zahlen). */
export function timeFactor(answerTimeMs: number, timeLimitSeconds: number): number {
  const { numerator, denominator } = timeFraction(answerTimeMs, timeLimitSeconds);
  return numerator / denominator;
}

export function multipleChoicePoints(
  isCorrect: boolean,
  answerTimeMs: number,
  timeLimitSeconds: number,
  maxPoints: number,
): number {
  if (!isCorrect || !(maxPoints > 0) || !(timeLimitSeconds > 0)) return 0;
  const { numerator, denominator } = timeFraction(answerTimeMs, timeLimitSeconds);
  return Math.round((maxPoints * numerator) / denominator);
}

/** Genauigkeit einer Schätzung zwischen 0 (zu weit weg) und 1 (genau richtig). */
export function estimateAccuracy(value: number, correctValue: number, tolerance: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(correctValue) || !(tolerance > 0)) return 0;
  return Math.max(0, 1 - Math.abs(value - correctValue) / tolerance);
}

export function estimatePoints(
  value: number,
  correctValue: number,
  tolerance: number,
  answerTimeMs: number,
  timeLimitSeconds: number,
  maxPoints: number,
): number {
  const accuracy = estimateAccuracy(value, correctValue, tolerance);
  if (accuracy === 0 || !(maxPoints > 0) || !(timeLimitSeconds > 0)) return 0;
  const { numerator, denominator } = timeFraction(answerTimeMs, timeLimitSeconds);
  return Math.round((accuracy * maxPoints * numerator) / denominator);
}

// ---------------------------------------------------------------------------------------------------------
// Rangliste
// ---------------------------------------------------------------------------------------------------------

export type ScoreEntry = {
  id: string;
  name: string;
  /** Gesamtpunkte. */
  total: number;
  /** Summe der Antwortzeiten in Millisekunden (für den Gleichstand). */
  timeMs: number;
};

export type Ranked<T extends ScoreEntry = ScoreEntry> = T & {
  /** Rang. Gleiche Punkte ergeben gleichen Rang (zum Beispiel 1, 1, 3). */
  rank: number;
  /** Platz in der Anzeigereihenfolge ab 1, immer eindeutig. */
  position: number;
};

/**
 * Sortiert nach Punkten (absteigend), dann nach der kleineren Zeitsumme, dann nach Name. Der Rang hängt nur von
 * den Punkten ab: Gleiche Punkte haben denselben Rang, die Reihenfolge der Anzeige entscheidet die Zeitsumme.
 */
export function rankPlayers<T extends ScoreEntry>(entries: readonly T[]): Ranked<T>[] {
  const sorted = [...entries].sort(
    (a, b) =>
      b.total - a.total ||
      a.timeMs - b.timeMs ||
      a.name.localeCompare(b.name, "de-CH") ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const ranked: Ranked<T>[] = [];
  for (const [index, entry] of sorted.entries()) {
    const previous = ranked[index - 1];
    const rank = previous && previous.total === entry.total ? previous.rank : index + 1;
    ranked.push({ ...entry, rank, position: index + 1 });
  }
  return ranked;
}

/** Veränderung des Rangs: positiv heisst aufgestiegen. Null, wenn es keinen früheren Rang gibt. */
export function rankDelta(previousRank: number | null | undefined, newRank: number): number | null {
  if (previousRank === null || previousRank === undefined) return null;
  return previousRank - newRank;
}
