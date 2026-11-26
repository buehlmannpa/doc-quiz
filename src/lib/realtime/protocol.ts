/**
 * Nachrichten zwischen Browser und Server (WebSocket), als Zod Schemas.
 * Alles, was vom Netz kommt, wird zuerst geprüft. Das gilt in beide Richtungen.
 *
 * Ablauf einer Verbindung:
 * 1. Der Client öffnet die Verbindung und sendet innert 5 Sekunden "hello" (Rolle, Spielcode, Token).
 * 2. Der Server prüft, liest den vollständigen Zustand aus Redis und antwortet mit "welcome" und "state".
 *    Dieser Zustandsabgleich beim Verbinden ist massgebend, egal was der Client vorher wusste.
 * 3. Danach kommen "state" Nachrichten bei jeder Änderung. "ping" und "pong" dienen dem Uhrenabgleich.
 */
import { z } from "zod";
import { publicGameStateSchema, publicPlayerSchema } from "./game-state";

export const PROTOCOL_VERSION = 1;

export const ROLES = ["player", "screen", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Close Codes im privaten Bereich 4000 bis 4999. Die Plattform sendet beim Erreichen der maximalen
 * Laufzeit einen eigenen Code, der nicht dokumentiert ist. Deshalb behandelt der Client jeden Abbruch
 * ausser den unten genannten endgültigen Fehlern gleich: Er verbindet sich neu.
 */
export const CLOSE_CODES = {
  /** Ungültige oder unerwartete Nachricht. */
  INVALID_MESSAGE: 4001,
  /** Token ungültig oder keine Admin Berechtigung. Endgültig, ein neuer Versuch mit denselben Angaben ist sinnlos. */
  UNAUTHORIZED: 4003,
  /** Das Spiel gibt es nicht (mehr). Endgültig. */
  GAME_NOT_FOUND: 4004,
  /** Zu viele Nachrichten. */
  RATE_LIMITED: 4008,
  /** Kein "hello" innerhalb der Frist. */
  HELLO_TIMEOUT: 4009,
  /** Der Client liest zu langsam, der Sendepuffer des Servers wäre überlaufen. */
  SLOW_CONSUMER: 4011,
  /** Der Server beendet die Verbindung, bevor die Plattform es tut. Der Client verbindet sich sofort neu. */
  ROTATE: 4012,
  /** Die Plattform oder der Server fährt herunter. */
  SERVER_ERROR: 4013,
} as const;

/** Codes, nach denen der Client nicht mehr versucht, sich zu verbinden. */
export const FATAL_CLOSE_CODES: readonly number[] = [CLOSE_CODES.UNAUTHORIZED, CLOSE_CODES.GAME_NOT_FOUND];

const gameCode = z.string().regex(/^\d{6}$/, "Der Spielcode besteht aus sechs Ziffern.");

export const helloSchema = z
  .object({
    type: z.literal("hello"),
    protocol: z.literal(PROTOCOL_VERSION),
    role: z.enum(ROLES),
    code: gameCode,
    token: z.string().min(1).max(100).optional(),
  })
  .refine((hello) => hello.role !== "player" || hello.token !== undefined, {
    message: "Spieler brauchen ein Token.",
    path: ["token"],
  });

export const pingSchema = z.object({ type: z.literal("ping"), t0: z.number().finite() });

/**
 * Antwort eines Spielers. q ist die Nummer der Frage, auf die sich die Antwort bezieht (schützt vor Antworten auf
 * eine frühere Frage). Genau eines von option (Multiple Choice, Umfrage) und value (Schätzfrage).
 */
export const answerSchema = z
  .object({
    type: z.literal("answer"),
    id: z.string().max(40).optional(),
    q: z.number().int().min(0).max(1000),
    option: z.number().int().min(0).max(3).optional(),
    value: z.number().finite().min(-1e12).max(1e12).optional(),
  })
  .refine((answer) => (answer.option !== undefined) !== (answer.value !== undefined), {
    message: "Genau eines von option und value ist nötig.",
  });

/** Steuerbefehle des Admins. expectedVersion schützt vor doppelten Klicks und veralteten Bildschirmen. */
export const COMMANDS = ["start", "resolve", "next", "reveal", "finish", "abort"] as const;
export type Command = (typeof COMMANDS)[number];
export const cmdSchema = z.object({
  type: z.literal("cmd"),
  id: z.string().max(40).optional(),
  cmd: z.enum(COMMANDS),
  expectedVersion: z.number().int().min(0).optional(),
});

/** Hinweis eines Geräts, dass seine Zeit abgelaufen ist. Der Server prüft selbst, ob es stimmt. */
export const tickSchema = z.object({ type: z.literal("tick") });
/** Lässt die eigene Bubble im Warteraum hüpfen. */
export const nudgeSchema = z.object({ type: z.literal("nudge") });

export const clientMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  pingSchema,
  answerSchema,
  cmdSchema,
  tickSchema,
  nudgeSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type HelloMessage = z.infer<typeof helloSchema>;
export type AnswerMessage = z.infer<typeof answerSchema>;
export type CmdMessage = z.infer<typeof cmdSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    protocol: z.literal(PROTOCOL_VERSION),
    role: z.enum(ROLES),
    /** Uhrzeit des Servers in Millisekunden seit 1970. */
    serverTime: z.number(),
    /** Kennung der Funktionsinstanz, nur für Diagnose und Messungen. */
    instanceId: z.string(),
    player: publicPlayerSchema.optional(),
  }),
  z.object({ type: z.literal("state"), version: z.number().int().min(0), state: publicGameStateSchema }),
  z.object({ type: z.literal("pong"), t0: z.number(), serverTime: z.number() }),
  z.object({ type: z.literal("reconnect"), reason: z.enum(["max_age", "server_shutdown"]) }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  /** Antwort auf eine Antwort oder einen Befehl. id ist die Kennung aus der Anfrage. */
  z.object({ type: z.literal("ack"), id: z.string().optional(), ok: z.boolean(), error: z.string().optional() }),
  /** Zahl der bisher eingegangenen Antworten auf die aktuelle Frage. */
  z.object({ type: z.literal("progress"), q: z.number().int().min(0), n: z.number().int().min(0) }),
  /** Eine Bubble hüpft im Warteraum. */
  z.object({ type: z.literal("nudge"), id: z.string() }),
  /** Dieser Spieler hat die Frage q schon beantwortet (nach einer Wiederverbindung). */
  z.object({
    type: z.literal("mine"),
    q: z.number().int().min(0),
    option: z.number().int().optional(),
    value: z.number().optional(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * Nachrichten auf dem Redis Kanal eines Spiels. "state" trägt den vollständigen öffentlichen Zustand samt Version.
 * "progress" und "nudge" sind flüchtig und werden nicht gespeichert: Gehen sie verloren, ist das harmlos.
 */
export const channelMessageSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("state"), v: z.number().int().min(0), state: publicGameStateSchema }),
  z.object({ k: z.literal("progress"), q: z.number().int().min(0), n: z.number().int().min(0) }),
  z.object({ k: z.literal("nudge"), id: z.string() }),
]);
export type ChannelMessage = z.infer<typeof channelMessageSchema>;
