/**
 * Passwortvergleich ohne Zeitunterschiede.
 *
 * Beide Werte werden zuerst mit einem HMAC auf gleiche Länge gebracht. So verrät weder die Länge
 * noch die Stelle des ersten Unterschieds etwas über das richtige Passwort.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function checkPassword(input: string, expected: string, secret: string): boolean {
  const digest = (value: string) => createHmac("sha256", secret).update(`pw:${value}`).digest();
  return timingSafeEqual(digest(input), digest(expected));
}
