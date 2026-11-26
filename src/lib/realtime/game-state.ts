/**
 * Öffentlicher Spielzustand und die reinen Regeln dafür (Meilenstein 3).
 *
 * "Öffentlich" heisst: Alles in diesem Zustand darf jeder Client sehen, auch die Beamer Ansicht und die
 * Smartphones. Geheimnisse (zum Beispiel die richtigen Antworten vor der Auflösung) gehören nie hierher.
 * Sie liegen in eigenen Redis Schlüsseln und gelangen erst bei der Auflösung in den öffentlichen Zustand.
 *
 * Die Version steigt bei jeder Änderung um genau 1. Ein Client darf jede Nachricht verwerfen, deren Version
 * nicht grösser ist als die zuletzt gesehene. So sind doppelte, verspätete und verlorene Nachrichten
 * harmlos: Die nächste Nachricht enthält immer den vollständigen Zustand.
 *
 * Die Phasen werden in Meilenstein 5 verfeinert (Frage, Auflösung, Siegerbildschirm). Meilenstein 3 braucht nur
 * die Grundlage: Warteraum, Spiel läuft, Spiel beendet.
 */
import { z } from "zod";

export const GAME_PHASES = ["lobby", "running", "finished"] as const;
export type GamePhase = (typeof GAME_PHASES)[number];

/** Obergrenze der Teilnehmenden. Vorgabe waren rund 60, die Grenze schützt vor Missbrauch über den QR Code. */
export const MAX_PLAYERS = 100;
export const MAX_NAME_LENGTH = 20;
export const AVATAR_COUNT = 64;

export const publicPlayerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  avatar: z.number().int().min(0).max(AVATAR_COUNT - 1),
});
export type PublicPlayer = z.infer<typeof publicPlayerSchema>;

export const publicGameStateSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  version: z.number().int().min(0),
  phase: z.enum(GAME_PHASES),
  /** Zeitpunkt der Erstellung in Millisekunden seit 1970 (Serverzeit). */
  createdAt: z.number().int().min(0),
  players: z.array(publicPlayerSchema).max(MAX_PLAYERS),
});
export type PublicGameState = z.infer<typeof publicGameStateSchema>;

export type JoinFailure = "not_found" | "closed" | "name_taken" | "invalid_name" | "invalid_avatar" | "full" | "busy";

export const JOIN_FAILURE_MESSAGES: Record<JoinFailure, string> = {
  not_found: "Dieses Spiel gibt es nicht. Bitte prüfen Sie den Spielcode.",
  closed: "Das Quiz hat bereits begonnen. Ein Beitritt ist nicht mehr möglich.",
  name_taken: "Dieser Name ist schon vergeben. Bitte wählen Sie einen anderen.",
  invalid_name: `Bitte geben Sie einen Namen mit 1 bis ${MAX_NAME_LENGTH} Zeichen ein.`,
  invalid_avatar: "Das gewählte Icon ist ungültig.",
  full: "Das Spiel ist voll.",
  busy: "Gerade sind viele Beitritte gleichzeitig. Bitte versuchen Sie es noch einmal.",
};

/** Fehler einer Spielregel. Der Speicher wandelt ihn in ein Ergebnis um, er verlässt die Schicht nicht. */
export class GameRuleError extends Error {
  constructor(public readonly reason: JoinFailure) {
    super(reason);
    this.name = "GameRuleError";
  }
}

export type NameCheck = { ok: true; name: string } | { ok: false };

/**
 * Bereinigt einen Spielnamen: Unicode normalisieren (NFC), Leerzeichen am Rand entfernen, mehrfache
 * Leerzeichen zusammenfassen. Steuerzeichen und unsichtbare Formatzeichen sind nicht erlaubt, damit niemand
 * einen Namen einschmuggeln kann, der leer aussieht oder die Anzeige stört. Die Länge zählt Zeichen,
 * nicht Bytes (wie die Datenbank).
 */
export function normalizePlayerName(input: string): NameCheck {
  const name = input.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (name.length === 0) return { ok: false };
  if ([...name].length > MAX_NAME_LENGTH) return { ok: false };
  // Steuerzeichen (Cc), Formatzeichen (Cf, zum Beispiel unsichtbare Leerzeichen) und nicht zugewiesene Zeichen.
  if (/[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}]/u.test(name)) return { ok: false };
  return { ok: true, name };
}

/** Schlüssel für den Vergleich von Namen ohne Beachtung der Gross und Kleinschreibung. */
export function nameKey(name: string): string {
  return name.toLocaleLowerCase("de-CH");
}

export function isValidAvatar(avatar: number): boolean {
  return Number.isInteger(avatar) && avatar >= 0 && avatar < AVATAR_COUNT;
}

/** Fügt einen Spieler hinzu oder wirft einen GameRuleError. Der Zustand wird nicht verändert, sondern kopiert. */
export function addPlayer(state: PublicGameState, player: PublicPlayer): PublicGameState {
  if (state.phase !== "lobby") throw new GameRuleError("closed");
  if (state.players.length >= MAX_PLAYERS) throw new GameRuleError("full");
  const key = nameKey(player.name);
  if (state.players.some((existing) => nameKey(existing.name) === key)) throw new GameRuleError("name_taken");
  return { ...state, players: [...state.players, player] };
}

export function createInitialState(code: string, now: number): PublicGameState {
  return { code, version: 0, phase: "lobby", createdAt: now, players: [] };
}
