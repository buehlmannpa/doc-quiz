/**
 * Signierte Session Token für den Admin.
 *
 * Aufbau: "<Ablauf in Sekunden>.<Zufallswert>.<Signatur>"
 * Die Signatur ist ein HMAC SHA 256 über Ablauf und Zufallswert mit dem Geheimnis SESSION_SECRET.
 * Das Token enthält keine Personendaten. Es gibt nur einen Admin, deshalb braucht es keinen Benutzernamen.
 *
 * Wer das Geheimnis nicht kennt, kann kein gültiges Token herstellen. Ein verändertes Ablaufdatum
 * macht die Signatur ungültig. Die Funktionen sind rein (Zeit als Parameter) und deshalb testbar.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SessionCheck =
  | { valid: true; expiresAt: number }
  | { valid: false; reason: "format" | "signature" | "expired" };

function sign(secret: string, payload: string): string {
  // Der Präfix trennt diese Signatur von anderen Verwendungen desselben Geheimnisses.
  return createHmac("sha256", secret).update(`session:v1:${payload}`).digest("base64url");
}

export function createSessionToken(secret: string, nowMs: number, ttlSeconds: number): string {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const nonce = randomBytes(12).toString("base64url");
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySessionToken(secret: string, token: string | undefined, nowMs: number): SessionCheck {
  if (!token) return { valid: false, reason: "format" };
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "format" };
  const [expiresRaw, nonce, signature] = parts;
  if (expiresRaw === undefined || nonce === undefined || signature === undefined) {
    return { valid: false, reason: "format" };
  }
  if (!/^\d{1,12}$/.test(expiresRaw) || !/^[A-Za-z0-9_-]{16}$/.test(nonce)) {
    return { valid: false, reason: "format" };
  }

  const expected = Buffer.from(sign(secret, `${expiresRaw}.${nonce}`));
  const given = Buffer.from(signature);
  // timingSafeEqual verlangt gleich lange Eingaben, die Länge selbst ist kein Geheimnis.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, reason: "signature" };
  }

  const expiresAt = Number(expiresRaw);
  if (expiresAt <= Math.floor(nowMs / 1000)) return { valid: false, reason: "expired" };
  return { valid: true, expiresAt };
}
