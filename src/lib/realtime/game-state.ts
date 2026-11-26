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
 * Phasen: Warteraum, Frage, Auflösung, Siegerbildschirm (Podest) und beendet. Beim Siegerbildschirm sendet der
 * Server nur die bereits enthüllten Plätze. Die vollständige Rangliste folgt erst nach der Enthüllung von Platz 1.
 */
import { z } from "zod";
import { QUESTION_TYPES } from "@/lib/quiz/schema";

export const GAME_PHASES = ["lobby", "question", "resolved", "podium", "finished"] as const;
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

/** Die aktuelle Frage, wie alle sie sehen dürfen: ohne Angabe, welche Antwort richtig ist. */
export const publicQuestionSchema = z.object({
  index: z.number().int().min(0),
  total: z.number().int().min(1),
  type: z.enum(QUESTION_TYPES),
  prompt: z.string(),
  timeLimitSeconds: z.number().int().min(1),
  maxPoints: z.number().int().min(0),
  options: z.array(z.object({ index: z.number().int().min(0).max(3), text: z.string() })).max(4),
  unit: z.string().nullable(),
  /** Beginn und Ablauf in Serverzeit (Millisekunden seit 1970). Die Geräte zeigen den Countdown daraus an. */
  startedAt: z.number(),
  deadline: z.number(),
});
export type PublicQuestion = z.infer<typeof publicQuestionSchema>;

export const rankingRowSchema = z.object({
  playerId: z.string(),
  name: z.string(),
  avatar: z.number().int().min(0).max(AVATAR_COUNT - 1),
  rank: z.number().int().min(1),
  /** Punkte dieser Frage. */
  points: z.number().int(),
  total: z.number().int(),
  /** Veränderung des Rangs gegenüber der Vorfrage, positiv heisst aufgestiegen. Null ohne Vergleich. */
  delta: z.number().int().nullable(),
});
export type RankingRow = z.infer<typeof rankingRowSchema>;

/** Was nach dem Ende einer Frage auf dem Bildschirm steht. */
export const resolutionSchema = z.object({
  type: z.enum(QUESTION_TYPES),
  /** Positionen der richtigen Antworten (Multiple Choice). */
  correctOptions: z.array(z.number().int().min(0).max(3)),
  correctValue: z.number().nullable(),
  tolerance: z.number().nullable(),
  unit: z.string().nullable(),
  /** Anzahl Antworten pro Option (Multiple Choice und Umfrage). */
  distribution: z.array(z.number().int().min(0)),
  /** Alle Schätzungen, aufsteigend sortiert (Schätzfrage). */
  estimates: z.array(z.number()),
  answered: z.number().int().min(0),
  /** Die besten fünf nach dieser Frage. Leer bei Umfragen und nach der letzten Frage. */
  top: z.array(rankingRowSchema).max(5),
});
export type Resolution = z.infer<typeof resolutionSchema>;

/** Ergebnis eines einzelnen Spielers für die aktuelle Frage. */
export const playerResultSchema = z.object({
  answered: z.boolean(),
  /** Richtig oder falsch bei Multiple Choice, sonst null. */
  correct: z.boolean().nullable(),
  points: z.number().int(),
  total: z.number().int(),
  /** Rang und Veränderung, null bei Umfragen und nach der letzten Frage (der Rang folgt erst im Siegerbildschirm). */
  rank: z.number().int().nullable(),
  delta: z.number().int().nullable(),
  option: z.number().int().nullable(),
  value: z.number().nullable(),
  /** Abweichung und Genauigkeit (0 bis 1) bei Schätzfragen. */
  deviation: z.number().nullable(),
  accuracy: z.number().nullable(),
});
export type PlayerResult = z.infer<typeof playerResultSchema>;

export const finalRowSchema = z.object({
  playerId: z.string(),
  name: z.string(),
  avatar: z.number().int().min(0).max(AVATAR_COUNT - 1),
  rank: z.number().int().min(1),
  /** Platz in der Anzeigereihenfolge, immer eindeutig. */
  position: z.number().int().min(1),
  points: z.number().int(),
  timeMs: z.number().int(),
});
export type FinalRow = z.infer<typeof finalRowSchema>;

export const podiumSchema = z.object({
  /** Anzahl der Plätze auf dem Podest (höchstens 3, bei wenigen Teilnehmenden weniger). */
  size: z.number().int().min(0).max(3),
  /** Wie viele davon schon enthüllt sind. Die Enthüllung läuft von unten nach oben. */
  revealed: z.number().int().min(0).max(3),
  /** Nur die enthüllten Plätze, in der Reihenfolge der Enthüllung (zuerst der unterste). */
  places: z.array(finalRowSchema).max(3),
  /** Die vollständige Rangliste, erst nach der Enthüllung des ersten Platzes. */
  ranking: z.array(finalRowSchema).max(MAX_PLAYERS).nullable(),
});
export type Podium = z.infer<typeof podiumSchema>;

export const quizInfoSchema = z.object({ title: z.string(), questionCount: z.number().int().min(0) });

export const publicGameStateSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  version: z.number().int().min(0),
  phase: z.enum(GAME_PHASES),
  /** Zeitpunkt der Erstellung in Millisekunden seit 1970 (Serverzeit). */
  createdAt: z.number().int().min(0),
  players: z.array(publicPlayerSchema).max(MAX_PLAYERS),
  /** Titel und Anzahl Fragen des Quiz, null bei Testspielen ohne Quiz. */
  quiz: quizInfoSchema.nullable(),
  question: publicQuestionSchema.nullable(),
  resolution: resolutionSchema.nullable(),
  /** Ergebnisse aller Spieler für die aktuelle Frage, nach Spieler Kennung. */
  results: z.record(z.string(), playerResultSchema),
  podium: podiumSchema.nullable(),
});
export type PublicGameState = z.infer<typeof publicGameStateSchema>;

export type JoinFailure = "not_found" | "closed" | "name_taken" | "invalid_name" | "invalid_avatar" | "full" | "busy";

/** Verletzung einer Spielregel beim Ändern des Zustands. Beitrittsfehler sind eine Teilmenge. */
export type RuleFailure = JoinFailure | "wrong_phase" | "stale" | "no_players" | "invalid";

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
  constructor(public readonly reason: RuleFailure) {
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

export function createInitialState(
  code: string,
  now: number,
  quiz: z.infer<typeof quizInfoSchema> | null = null,
): PublicGameState {
  return {
    code,
    version: 0,
    phase: "lobby",
    createdAt: now,
    players: [],
    quiz,
    question: null,
    resolution: null,
    results: {},
    podium: null,
  };
}
