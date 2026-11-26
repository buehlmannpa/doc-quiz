/**
 * Zahlen in Schweizer Schreibweise lesen und anzeigen.
 *
 * In der Schweiz sind sowohl Punkt als auch Komma als Dezimaltrennzeichen üblich, Tausender werden mit
 * Apostroph oder Leerzeichen getrennt. Beispiele: 1'250.5, 1’250,5, 3,5, 42, -2.
 */

/** Liest eine Zahl aus Benutzereingabe. Gibt null zurück, wenn die Eingabe keine gültige Zahl ist. */
export function parseDecimal(input: string): number | null {
  // Tausendertrenner entfernen: Apostroph (gerade und typografisch), Leerzeichen, geschütztes Leerzeichen.
  const cleaned = input.trim().replace(/['’   ]/g, "");
  if (cleaned === "") return null;
  // Optionales Minus, Ziffern, höchstens ein Dezimaltrennzeichen mit mindestens einer Nachkommastelle.
  if (!/^-?\d+([.,]\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

const formatter = new Intl.NumberFormat("de-CH", { maximumFractionDigits: 6 });

/** Zahl für die Anzeige, zum Beispiel 1’250.5. */
export function formatNumber(value: number): string {
  return formatter.format(value);
}
