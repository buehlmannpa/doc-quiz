/**
 * Spielertoken.
 *
 * Beim Beitritt erhält jedes Smartphone ein zufälliges Token, das der Browser speichert. Bei jeder
 * Verbindung sendet der Client es wieder. Der Server speichert nur einen Hash des Tokens (HMAC mit dem
 * Geheimnis der App). Wer in Redis liest, kann daraus kein Token herstellen. Das Token ist 192 Bit
 * zufällig und damit nicht erratbar.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";

/** Zufälliges Token, 32 Zeichen URL sicher. */
export function generatePlayerToken(): string {
  return randomBytes(24).toString("base64url");
}

export function generatePlayerId(): string {
  return randomUUID();
}

/** Hash des Tokens für die Ablage in Redis. */
export function hashPlayerToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(`player-token:v1:${token}`).digest("hex");
}

/** Formale Prüfung, bevor ein Token überhaupt nachgeschlagen wird (verhindert unnötige Redis Anfragen). */
export function looksLikePlayerToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}
