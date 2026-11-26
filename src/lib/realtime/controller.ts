/**
 * Schnittstelle zwischen dem Hub (Transport) und der Spiellogik. Der Hub kennt die Spiellogik nicht, er reicht nur
 * Nachrichten weiter. So bleibt der Transport ohne die Logik testbar und umgekehrt.
 */
import type { PublicGameState } from "./game-state";
import type { Command } from "./protocol";

export type ControllerResult = { ok: true } | { ok: false; error: string };

export interface GameController {
  /** Antwort eines Spielers. hint ist der zuletzt bekannte Zustand der Instanz und erspart einen Lesebefehl. */
  answer(
    code: string,
    playerId: string,
    message: { q: number; option?: number; value?: number },
    hint: PublicGameState | null,
  ): Promise<ControllerResult>;
  /** Steuerbefehl des Admins. */
  command(code: string, command: Command, expectedVersion: number | undefined): Promise<ControllerResult>;
  /** Hinweis eines Geräts, dass die Zeit der aktuellen Frage abgelaufen ist. Der Server prüft das selbst. */
  tick(code: string, hint: PublicGameState | null): Promise<void>;
  /** Die eigene Antwort eines Spielers auf die Frage q, falls vorhanden (für die Wiederverbindung). */
  mine(code: string, playerId: string, q: number): Promise<{ option?: number; value?: number } | null>;
  /** Zahl der bisher eingegangenen Antworten auf die Frage q (für die Wiederverbindung von Beamer und Admin). */
  progress(code: string, q: number): Promise<number>;
}
