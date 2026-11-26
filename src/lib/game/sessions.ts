/**
 * Durchführungen in Neon (das Langzeitgedächtnis).
 *
 * Während eines Spiels wird Neon weder gelesen noch geschrieben. Es gibt drei Zeitpunkte:
 * 1. Anlegen: Die Durchführung entsteht im Status "lobby" und der Snapshot des Quiz wird gebildet.
 * 2. Start: Der Status wechselt auf "running".
 * 3. Ende der letzten Frage: Spieler und Antworten werden in einer einzigen Transaktion gespeichert, der Status
 *    wechselt auf "finished". Das Speichern ist wiederholbar: Ist die Durchführung schon "finished", tut es nichts.
 *
 * Es läuft höchstens eine Durchführung gleichzeitig. Das sichert ein Advisory Lock auf Datenbankebene, denn zwei
 * gleichzeitige Starts für verschiedene Quizzes würden sonst beide die Prüfung "keine aktive Durchführung" bestehen.
 * Das Lock der Quizzeile (FOR UPDATE) verhindert ausserdem, dass das Quiz zwischen Prüfung und Anlegen bearbeitet wird.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { gameSessions, players, quizzes, responses } from "@/lib/db/schema";
import { isPlayable, validateReadyToPlay } from "@/lib/quiz/rules";
import { loadQuestions, toStoredQuestion } from "@/lib/quiz/repository";
import type { GameOutcome } from "./engine";
import { buildSnapshot, type GameQuiz } from "./snapshot";

type Db = NodePgDatabase<typeof schema>;

export type SessionErrorCode = "not_found" | "not_playable" | "active_exists" | "code_taken" | "invalid";

/** Fehler mit einer Meldung, die der Admin lesen darf. */
export class SessionError extends Error {
  constructor(
    public readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

/** Beliebiger, aber fester Schlüssel für das Advisory Lock "Start einer Durchführung". */
const START_LOCK_KEY = 8_172_635;

const CHUNK = 400;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function isUniqueViolation(error: unknown): boolean {
  // pg meldet den SQLSTATE als code, Drizzle verpackt den Fehler teilweise in cause.
  const code = (error as { code?: string; cause?: { code?: string } } | null) ?? {};
  return code.code === "23505" || code.cause?.code === "23505";
}

export type SessionSummary = {
  id: string;
  quizId: string;
  quizTitle: string;
  joinCode: string;
  status: (typeof gameSessions.$inferSelect)["status"];
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  playerCount: number;
  winner: string | null;
};

export function createSessionRepository(db: Db) {
  /** Zusammenfassungen für eine Auswahl von Durchführungen. */
  async function summarize(rows: (typeof gameSessions.$inferSelect & { quizTitle: string })[]): Promise<SessionSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const playerRows = await db
      .select({ sessionId: players.sessionId, name: players.name, finalRank: players.finalRank, totalPoints: players.totalPoints })
      .from(players)
      .where(inArray(players.sessionId, ids))
      .orderBy(asc(players.finalRank), desc(players.totalPoints));
    return rows.map((row) => {
      const own = playerRows.filter((player) => player.sessionId === row.id);
      const best = own.find((player) => player.finalRank === 1);
      return {
        id: row.id,
        quizId: row.quizId,
        quizTitle: row.quizTitle,
        joinCode: row.joinCode,
        status: row.status,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        playerCount: own.length,
        winner: row.status === "finished" ? (best?.name ?? null) : null,
      };
    });
  }

  return {
    /**
     * Legt eine Durchführung im Status "lobby" an und liefert den Snapshot des Quiz für Redis.
     * Der Aufrufer wählt den Spielcode. Ist er unter den aktiven Durchführungen vergeben, kommt "code_taken".
     */
    async createSession(quizId: string, joinCode: string): Promise<{ sessionId: string; snapshot: GameQuiz }> {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(${START_LOCK_KEY})`);
          const [quiz] = await tx.select().from(quizzes).where(eq(quizzes.id, quizId)).for("update");
          if (!quiz) throw new SessionError("not_found", "Das Quiz wurde nicht gefunden.");
          if (!isPlayable(quiz.status)) {
            throw new SessionError("not_playable", "Nur ein Quiz im Status Bereit kann gestartet werden.");
          }
          const [active] = await tx
            .select({ id: gameSessions.id, joinCode: gameSessions.joinCode })
            .from(gameSessions)
            .where(inArray(gameSessions.status, ["lobby", "running"]))
            .limit(1);
          if (active) {
            throw new SessionError(
              "active_exists",
              `Es läuft bereits eine Durchführung (Spielcode ${active.joinCode}). Beenden oder brechen Sie sie zuerst ab.`,
            );
          }
          const loaded = await loadQuestions(tx, quizId);
          const problems = validateReadyToPlay(loaded.map(toStoredQuestion));
          if (problems.length > 0) throw new SessionError("invalid", problems.join(" "));
          const [session] = await tx
            .insert(gameSessions)
            .values({ quizId, joinCode, status: "lobby" })
            .returning({ id: gameSessions.id });
          if (!session) throw new SessionError("invalid", "Die Durchführung konnte nicht angelegt werden.");
          return { sessionId: session.id, snapshot: buildSnapshot({ quiz: { id: quiz.id, title: quiz.title }, questions: loaded }) };
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new SessionError("code_taken", "Dieser Spielcode ist schon vergeben.");
        throw error;
      }
    },

    /** Die Durchführung hat begonnen. */
    async markRunning(joinCode: string): Promise<void> {
      await db
        .update(gameSessions)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(gameSessions.joinCode, joinCode), eq(gameSessions.status, "lobby")));
    },

    /** Die Durchführung wurde abgebrochen. Es gibt keine Resultate. Wirkt nur auf aktive Durchführungen. */
    async markCancelled(joinCode: string): Promise<boolean> {
      const updated = await db
        .update(gameSessions)
        .set({ status: "cancelled", endedAt: new Date() })
        .where(and(eq(gameSessions.joinCode, joinCode), inArray(gameSessions.status, ["lobby", "running"])))
        .returning({ id: gameSessions.id });
      return updated.length > 0;
    },

    /**
     * Speichert Spieler und Antworten und schliesst die Durchführung ab, alles in einer Transaktion. Idempotent:
     * Eine schon abgeschlossene Durchführung bleibt unverändert, ein wiederholter Aufruf ist harmlos.
     * Die Spieler Kennung aus Redis ist eine UUID und wird als Kennung in Neon übernommen, so lassen sich
     * Antworten ohne Zuordnung nach Namen schreiben.
     */
    async saveOutcome(outcome: GameOutcome): Promise<{ saved: boolean; sessionId: string | null }> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${START_LOCK_KEY})`);
        const [session] = await tx
          .select()
          .from(gameSessions)
          .where(and(eq(gameSessions.joinCode, outcome.code), inArray(gameSessions.status, ["lobby", "running"])))
          .for("update");
        // Keine aktive Durchführung zu diesem Code: entweder schon gespeichert oder abgebrochen. Nichts zu tun.
        if (!session) return { saved: false, sessionId: null };

        const finalByPlayer = new Map(outcome.finalRows.map((row) => [row.playerId, row]));
        const playerRows = outcome.players.map((player) => {
          const final = finalByPlayer.get(player.id);
          return {
            id: player.id,
            sessionId: session.id,
            name: player.name,
            avatar: player.avatar,
            tokenHash: outcome.tokenHashes[player.id] ?? "unbekannt",
            totalPoints: final?.points ?? 0,
            totalAnswerTimeMs: final?.timeMs ?? 0,
            finalRank: final?.rank ?? null,
          };
        });
        for (const part of chunks(playerRows)) await tx.insert(players).values(part).onConflictDoNothing();

        const responseRows: (typeof responses.$inferInsert)[] = [];
        for (const [index, question] of outcome.quiz.questions.entries()) {
          const records = outcome.records[index];
          if (!records) continue;
          for (const player of outcome.players) {
            const record = records.get(player.id);
            if (!record || !record.answered) continue;
            const option = record.option !== null ? question.options[record.option] : undefined;
            // Genau eines von Option und Wert, so verlangt es die Datenbank.
            if (question.type === "estimate" ? record.value === null : !option) continue;
            responseRows.push({
              sessionId: session.id,
              questionId: question.id,
              playerId: player.id,
              optionId: question.type === "estimate" ? null : (option?.id ?? null),
              numericValue: question.type === "estimate" ? record.value : null,
              answerTimeMs: record.answerTimeMs ?? 0,
              pointsAwarded: record.points,
            });
          }
        }
        for (const part of chunks(responseRows)) await tx.insert(responses).values(part).onConflictDoNothing();

        await tx.update(gameSessions).set({ status: "finished", endedAt: new Date() }).where(eq(gameSessions.id, session.id));
        return { saved: true, sessionId: session.id };
      });
    },

    /** Die aktive Durchführung (Warteraum oder laufend), falls es eine gibt. */
    async getActive(): Promise<SessionSummary | null> {
      const rows = await db
        .select({ ...gameSessionColumns, quizTitle: quizzes.title })
        .from(gameSessions)
        .innerJoin(quizzes, eq(gameSessions.quizId, quizzes.id))
        .where(inArray(gameSessions.status, ["lobby", "running"]))
        .limit(1);
      return (await summarize(rows))[0] ?? null;
    },

    async getByCode(joinCode: string): Promise<SessionSummary | null> {
      const rows = await db
        .select({ ...gameSessionColumns, quizTitle: quizzes.title })
        .from(gameSessions)
        .innerJoin(quizzes, eq(gameSessions.quizId, quizzes.id))
        .where(eq(gameSessions.joinCode, joinCode))
        .orderBy(desc(gameSessions.createdAt))
        .limit(1);
      return (await summarize(rows))[0] ?? null;
    },

    /** Alle Durchführungen, neueste zuerst. */
    async listSessions(limit = 200): Promise<SessionSummary[]> {
      const rows = await db
        .select({ ...gameSessionColumns, quizTitle: quizzes.title })
        .from(gameSessions)
        .innerJoin(quizzes, eq(gameSessions.quizId, quizzes.id))
        .orderBy(desc(gameSessions.createdAt))
        .limit(limit);
      return summarize(rows);
    },

    /** Alle Angaben für die Resultatansicht einer Durchführung. */
    async getSessionDetail(sessionId: string) {
      const [session] = await db
        .select({ ...gameSessionColumns, quizTitle: quizzes.title })
        .from(gameSessions)
        .innerJoin(quizzes, eq(gameSessions.quizId, quizzes.id))
        .where(eq(gameSessions.id, sessionId));
      if (!session) return null;
      const [loadedQuestions, playerRows, responseRows] = await Promise.all([
        loadQuestions(db, session.quizId),
        db.select().from(players).where(eq(players.sessionId, sessionId)).orderBy(asc(players.finalRank), desc(players.totalPoints), asc(players.totalAnswerTimeMs)),
        db.select().from(responses).where(eq(responses.sessionId, sessionId)),
      ]);
      const [summary] = await summarize([session]);
      return { summary: summary as SessionSummary, questions: loadedQuestions, players: playerRows, responses: responseRows };
    },
  };
}

const gameSessionColumns = {
  id: gameSessions.id,
  quizId: gameSessions.quizId,
  joinCode: gameSessions.joinCode,
  status: gameSessions.status,
  createdAt: gameSessions.createdAt,
  startedAt: gameSessions.startedAt,
  endedAt: gameSessions.endedAt,
};

export type SessionRepository = ReturnType<typeof createSessionRepository>;
export type SessionDetail = NonNullable<Awaited<ReturnType<SessionRepository["getSessionDetail"]>>>;

export function getSessionRepository(): SessionRepository {
  return createSessionRepository(getDb());
}
