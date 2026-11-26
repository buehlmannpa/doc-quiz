/**
 * Auswertung der Messungen im Verbindungslabor. Reine Funktionen, deshalb einzeln testbar.
 */

/** Perzentil nach dem Nearest Rank Verfahren, auf eine Nachkommastelle gerundet. Null bei leerer Eingabe. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round((sorted[rank] ?? 0) * 10) / 10;
}

export type Summary = { count: number; min: number | null; p50: number | null; p95: number | null; max: number | null };

export function summarize(values: readonly number[]): Summary {
  return {
    count: values.length,
    min: percentile(values, 0),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: percentile(values, 100),
  };
}

export type BroadcastSend = { version: number; sentServerTime: number };

export type BroadcastResult = {
  /** Anzahl der gesendeten Änderungen und der verbundenen Teilnehmenden zu diesem Zeitpunkt. */
  sends: number;
  receivers: number;
  /** Wie viele Zustellungen erwartet waren und wie viele angekommen sind. */
  expected: number;
  delivered: number;
  missing: number;
  /** Laufzeit von der Veröffentlichung bis zum Eintreffen, in Millisekunden. */
  latencyMs: Summary;
};

/**
 * Wertet eine Reihe von Änderungen aus. arrivals enthält pro Teilnehmenden die Serverzeit (aus Sicht seines
 * Clients) beim Eintreffen jeder Version. Die Laufzeit ist eine Schätzung, weil sie auf dem Uhrenabgleich beruht
 * und die Uhren der beteiligten Instanzen leicht voneinander abweichen können. Negative Werte, die allein durch
 * diese Abweichung entstehen, werden als 0 gezählt, statt das Ergebnis zu verfälschen.
 */
export function summarizeBroadcast(
  sends: readonly BroadcastSend[],
  arrivals: readonly ReadonlyMap<number, number>[],
): BroadcastResult {
  const latencies: number[] = [];
  let delivered = 0;
  for (const send of sends) {
    for (const received of arrivals) {
      const at = received.get(send.version);
      if (at === undefined) continue;
      delivered += 1;
      latencies.push(Math.max(0, at - send.sentServerTime));
    }
  }
  const expected = sends.length * arrivals.length;
  return {
    sends: sends.length,
    receivers: arrivals.length,
    expected,
    delivered,
    missing: expected - delivered,
    latencyMs: summarize(latencies),
  };
}

/** Zählt, wie oft jeder Wert vorkommt, zum Beispiel Instanzen oder Close Codes. */
export function countBy<T extends string | number>(values: readonly T[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[String(value)] = (result[String(value)] ?? 0) + 1;
  return result;
}

/** Spielcodes des Labors liegen im Bereich 900000 bis 999999. Echte Spiele nutzen 100000 bis 899999. */
export const LAB_CODE_PATTERN = /^9\d{5}$/;

export function isLabCode(code: string): boolean {
  return LAB_CODE_PATTERN.test(code);
}

export function randomLabCode(random: () => number = Math.random): string {
  return String(900_000 + Math.floor(random() * 100_000));
}
