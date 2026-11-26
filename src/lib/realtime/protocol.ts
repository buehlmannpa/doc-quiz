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

export const clientMessageSchema = z.discriminatedUnion("type", [helloSchema, pingSchema]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type HelloMessage = z.infer<typeof helloSchema>;

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
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Nachricht auf dem Redis Kanal: der vollständige öffentliche Zustand samt Version. */
export const channelMessageSchema = z.object({ v: z.number().int().min(0), state: publicGameStateSchema });
export type ChannelMessage = z.infer<typeof channelMessageSchema>;
