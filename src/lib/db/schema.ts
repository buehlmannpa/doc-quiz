/**
 * Datenbankschema (Neon Postgres, Drizzle ORM).
 *
 * Bezeichner sind Englisch, die Oberfläche ist Deutsch (Entscheid in CLAUDE.md).
 * Neon ist das Langzeitgedächtnis: Quiz, Fragen, Optionen, Durchführungen und Resultate.
 * Während eines Spiels wird Neon nicht gelesen oder geschrieben, der Spielstand liegt in Redis.
 *
 * Regeln, die sich nicht als einzelne CHECK Bedingung ausdrücken lassen, prüft die Anwendung
 * mit Zod (Meilenstein 2):
 * 1. Multiple Choice: 2 bis 4 Optionen, mindestens eine richtig.
 * 2. Umfrage: 2 bis 4 Optionen, keine als richtig markiert.
 * 3. Schätzfrage: keine Optionen.
 * 4. Ein Quiz mit Durchführung kann nicht mehr bearbeitet werden (Quiz duplizieren).
 * 5. Es läuft höchstens eine Durchführung gleichzeitig.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const quizStatusEnum = pgEnum("quiz_status", ["draft", "ready", "completed"]);
export const questionTypeEnum = pgEnum("question_type", ["multiple_choice", "estimate", "poll"]);
export const sessionStatusEnum = pgEnum("session_status", [
  "lobby",
  "running",
  "finished",
  "cancelled",
]);

/** Quiz. Status: draft (Entwurf), ready (Bereit), completed (Abgeschlossen, archiviert). */
export const quizzes = pgTable(
  "quizzes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: quizStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check("quizzes_title_length", sql`char_length(${t.title}) between 1 and 120`)],
);

/**
 * Frage. Das Zeitlimit ist auf 5 bis 120 Sekunden begrenzt, weil eine WebSocket Verbindung
 * auf dem Hobby Plan nach 300 Sekunden endet und eine Frage nicht über diese Grenze laufen soll.
 */
export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: questionTypeEnum("type").notNull(),
    prompt: text("prompt").notNull(),
    timeLimitSeconds: integer("time_limit_seconds").notNull().default(20),
    maxPoints: integer("max_points").notNull().default(1000),
    /** Nur Schätzfrage: richtiger Wert, Einheit (zum Beispiel "km") und Toleranz. */
    correctValue: doublePrecision("correct_value"),
    unit: text("unit"),
    tolerance: doublePrecision("tolerance"),
  },
  (t) => [
    // Keine UNIQUE Bedingung auf der Position: Beim Sortieren werden die Positionen
    // in einer Transaktion neu geschrieben, eine UNIQUE Bedingung würde dabei kurz verletzt.
    index("questions_quiz_position_idx").on(t.quizId, t.position),
    check("questions_position_nonneg", sql`${t.position} >= 0`),
    check("questions_prompt_length", sql`char_length(${t.prompt}) between 1 and 300`),
    check("questions_time_limit_range", sql`${t.timeLimitSeconds} between 5 and 120`),
    check("questions_max_points_range", sql`${t.maxPoints} between 0 and 10000`),
    // Schätzfrage braucht Wert und Toleranz grösser 0. Andere Typen dürfen sie nicht haben.
    check(
      "questions_estimate_fields",
      sql`(${t.type} = 'estimate' and ${t.correctValue} is not null and ${t.tolerance} is not null and ${t.tolerance} > 0)
        or (${t.type} <> 'estimate' and ${t.correctValue} is null and ${t.tolerance} is null and ${t.unit} is null)`,
    ),
    // Umfragen vergeben keine Punkte.
    check("questions_poll_no_points", sql`${t.type} <> 'poll' or ${t.maxPoints} = 0`),
  ],
);

/** Antwortoption (Multiple Choice und Umfrage). */
export const answerOptions = pgTable(
  "answer_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    isCorrect: boolean("is_correct").notNull().default(false),
  },
  (t) => [
    index("answer_options_question_position_idx").on(t.questionId, t.position),
    check("answer_options_position_range", sql`${t.position} between 0 and 3`),
    check("answer_options_text_length", sql`char_length(${t.text}) between 1 and 120`),
  ],
);

/** Durchführung eines Quiz. Der Spielcode ist sechsstellig und nur unter aktiven Durchführungen eindeutig. */
export const gameSessions = pgTable(
  "game_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Ein Quiz mit Durchführungen kann nicht gelöscht werden (RESTRICT), Resultate bleiben erhalten.
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "restrict" }),
    joinCode: text("join_code").notNull(),
    status: sessionStatusEnum("status").notNull().default("lobby"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("game_sessions_active_join_code_idx")
      .on(t.joinCode)
      .where(sql`${t.status} in ('lobby', 'running')`),
    index("game_sessions_quiz_idx").on(t.quizId),
    check("game_sessions_join_code_format", sql`${t.joinCode} ~ '^[0-9]{6}$'`),
  ],
);

/**
 * Teilnehmende einer Durchführung. Gespeichert werden nur Spielname und Icon (keine Personendaten).
 * Der Token liegt nur als Hash in der Datenbank. totalPoints, totalAnswerTimeMs und finalRank
 * werden beim Spielende gesetzt, damit die Resultatansicht ohne Neuberechnung auskommt.
 */
export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    avatar: smallint("avatar").notNull().default(0),
    tokenHash: text("token_hash").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    totalPoints: integer("total_points"),
    totalAnswerTimeMs: integer("total_answer_time_ms"),
    finalRank: integer("final_rank"),
  },
  (t) => [
    // Der Spielname ist pro Durchführung eindeutig, ohne Beachtung der Gross und Kleinschreibung.
    uniqueIndex("players_session_name_idx").on(t.sessionId, sql`lower(${t.name})`),
    check("players_name_length", sql`char_length(${t.name}) between 1 and 20`),
    check("players_avatar_range", sql`${t.avatar} between 0 and 63`),
  ],
);

/**
 * Antwort eines Spielers auf eine Frage. Pro Spieler und Frage gibt es höchstens eine Antwort.
 * Wer nicht antwortet, hat keine Zeile (0 Punkte).
 */
export const responses = pgTable(
  "responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** Gewählte Option (Multiple Choice und Umfrage). */
    optionId: uuid("option_id").references(() => answerOptions.id, { onDelete: "restrict" }),
    /** Geschätzter Wert (Schätzfrage). */
    numericValue: doublePrecision("numeric_value"),
    /** Antwortzeit in Millisekunden, serverseitig gemessen. */
    answerTimeMs: integer("answer_time_ms").notNull(),
    pointsAwarded: integer("points_awarded").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("responses_player_question_idx").on(t.playerId, t.questionId),
    index("responses_session_question_idx").on(t.sessionId, t.questionId),
    check("responses_answer_time_nonneg", sql`${t.answerTimeMs} >= 0`),
    // Entweder eine Option oder ein Zahlenwert, nie beides und nie nichts.
    check("responses_option_xor_value", sql`(${t.optionId} is not null) <> (${t.numericValue} is not null)`),
  ],
);

export type Quiz = typeof quizzes.$inferSelect;
export type NewQuiz = typeof quizzes.$inferInsert;
export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type AnswerOption = typeof answerOptions.$inferSelect;
export type NewAnswerOption = typeof answerOptions.$inferInsert;
export type GameSession = typeof gameSessions.$inferSelect;
export type NewGameSession = typeof gameSessions.$inferInsert;
export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type Response = typeof responses.$inferSelect;
export type NewResponse = typeof responses.$inferInsert;
