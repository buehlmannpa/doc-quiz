/**
 * Spielablauf: Start, Antworten, Auflösung, nächste Frage, Siegerbildschirm, Ende.
 *
 * Die Engine hält keinen Zustand im Speicher, ausser einem kleinen Cache des unveränderlichen Quiz Snapshots. Alles
 * Veränderliche liegt in Redis. Jede Funktion darf auf jeder Funktionsinstanz laufen, auch gleichzeitig auf mehreren.
 *
 * Grundregeln (siehe CLAUDE.md, Architekturentscheide):
 * 1. Der Server ist die einzige Wahrheit. Die Antwortzeit ist die Serverzeit der Annahme minus der Startzeit der Frage.
 * 2. Pro Spieler und Frage wird genau eine Antwort angenommen (HSETNX im Lua Skript).
 * 3. Die Auflösung schliesst zuerst die Antworten (Flagge im selben atomaren Schritt, in dem sie gelesen werden) und
 *    rechnet dann. Spätere Antworten werden abgelehnt. Zwei gleichzeitige Auflösungen lesen dieselben Antworten und
 *    rechnen dasselbe, nur eine gewinnt den Versionsvergleich, die andere erkennt das und tut nichts.
 * 4. Befehle tragen optional die erwartete Version. Ein doppelter Klick oder zwei Bedienstellen (Portal und Beamer)
 *    überspringen so keine Phase.
 * 5. Geheimnisse (richtige Antworten, Endrangliste) bleiben in eigenen Schlüsseln und gelangen erst mit der jeweiligen
 *    Enthüllung in den öffentlichen Zustand.
 *
 * Redis Schlüssel eines Spiels (alle mit Ablauf):
 *   game:CODE:quiz        Snapshot des Quiz (legt der Spielspeicher beim Erstellen an)
 *   game:CODE:ans:Q       Hash Spieler Kennung zu Antwort, dazu das Feld #closed nach der Auflösung
 *   game:CODE:scores:Q    Hash Spieler Kennung zu Stand nach Frage Q (Gesamtpunkte, Rang, Antwort)
 *   game:CODE:final       Endrangliste als JSON, erst nach der letzten Frage vorhanden
 */
import {
  finalRowSchema,
  GameRuleError,
  type FinalRow,
  type PublicGameState,
  type PublicPlayer,
  type RuleFailure,
} from "@/lib/realtime/game-state";
import type { ControllerResult, GameController } from "@/lib/realtime/controller";
import type { Command } from "@/lib/realtime/protocol";
import type { GameStore } from "@/lib/realtime/store";
import { z } from "zod";
import { clampAnswerTime } from "./scoring";
import {
  buildFinalRows,
  evaluateQuestion,
  playerScoreSchema,
  podiumSize,
  revealedPlaces,
  type PlayerScore,
  type StoredAnswer,
} from "./evaluate";
import { toPublicQuestion, type GameQuiz } from "./snapshot";

/**
 * Gnadenfrist für Antworten, die knapp nach Ablauf eintreffen (Netzlaufzeit). Solche Antworten zählen mit der vollen
 * Zeitlimite als Antwortzeit. Danach lehnt der Server ab.
 */
export const ANSWER_GRACE_MS = 300;

export type EngineFailure =
  | "not_found"
  | "wrong_phase"
  | "stale"
  | "no_players"
  | "invalid"
  | "too_late"
  | "too_early"
  | "already_answered"
  | "busy"
  | "no_quiz";

export const ENGINE_MESSAGES: Record<EngineFailure, string> = {
  not_found: "Dieses Spiel gibt es nicht.",
  wrong_phase: "Das ist im Moment nicht möglich.",
  stale: "Die Ansicht war nicht mehr aktuell. Bitte versuchen Sie es noch einmal.",
  no_players: "Das Quiz kann erst starten, wenn mindestens eine Person beigetreten ist.",
  invalid: "Die Eingabe ist ungültig.",
  too_late: "Zu spät. Die Zeit ist abgelaufen.",
  too_early: "Die Zeit ist noch nicht abgelaufen.",
  already_answered: "Sie haben diese Frage schon beantwortet.",
  busy: "Gerade ist viel los. Bitte versuchen Sie es noch einmal.",
  no_quiz: "Zu diesem Spiel gehört kein Quiz.",
};

export type EngineResult<T = undefined> = { ok: true; value: T } | { ok: false; reason: EngineFailure };

/** Alles, was für das Speichern der Resultate in Neon nötig ist. */
export type GameOutcome = {
  code: string;
  createdAt: number;
  quiz: GameQuiz;
  players: PublicPlayer[];
  finalRows: FinalRow[];
  /** Pro Frage (Index) der Stand aller Spieler nach der Frage, nach Spieler Kennung. */
  records: Map<string, PlayerScore>[];
};

export type EngineHooks = {
  /** Nach dem erfolgreichen Start. Fehler werden protokolliert und stoppen das Spiel nicht. */
  onStarted?: (info: { code: string; createdAt: number }) => Promise<void>;
  /** Nach der letzten Frage. Wird bei einem Fehler bis zu dreimal versucht. */
  onFinished?: (outcome: GameOutcome) => Promise<void>;
  /** Wenn der Admin das Spiel vor dem Ende der letzten Frage abbricht. */
  onAborted?: (info: { code: string; createdAt: number }) => Promise<void>;
};

export type EngineOptions = {
  now?: () => number;
  hooks?: EngineHooks;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Wartezeiten zwischen den Versuchen, die Resultate zu speichern. Für Tests kurz. */
  persistRetryDelaysMs?: number[];
};

// KEYS[1] Antworten. ARGV: Spieler Kennung, Antwort, Ablauf. Rückgabe: Zahl der Antworten, -1 geschlossen, -2 doppelt.
const ANSWER_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], '#closed') == 1 then return -1 end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return -2 end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('HLEN', KEYS[1])
`;

// KEYS[1] Antworten. ARGV: Ablauf. Schliesst die Frage und liefert alle Antworten, in einem atomaren Schritt.
const CLOSE_AND_READ_SCRIPT = `
redis.call('HSET', KEYS[1], '#closed', '1')
redis.call('EXPIRE', KEYS[1], ARGV[1])
return redis.call('HGETALL', KEYS[1])
`;

const CLOSED_FIELD = "#closed";

const storedAnswerSchema = z.object({
  o: z.number().int().optional(),
  v: z.number().finite().optional(),
  t: z.number().finite(),
});

const finalRowsSchema = z.array(finalRowSchema);

/** Wandelt die flache Antwort von HGETALL (Feld, Wert, Feld, Wert, ...) in eine Zuordnung um. */
function pairsToRecord(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let index = 0; index + 1 < raw.length; index += 2) result[String(raw[index])] = String(raw[index + 1]);
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) result[key] = String(value);
  }
  return result;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GameEngine implements GameController {
  private readonly now: () => number;
  private readonly hooks: EngineHooks;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private readonly retryDelays: number[];
  /** Der Snapshot ändert sich während eines Spiels nie, deshalb darf er pro Instanz gemerkt werden. */
  private readonly quizCache = new Map<string, { createdAt: number; quiz: GameQuiz }>();

  constructor(
    private readonly store: GameStore,
    options: EngineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.hooks = options.hooks ?? {};
    this.log = options.log ?? (() => {});
    this.retryDelays = options.persistRetryDelaysMs ?? [300, 1_000];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------------------------------------

  private async loadQuiz(code: string, state: PublicGameState): Promise<GameQuiz | null> {
    const cached = this.quizCache.get(code);
    if (cached && cached.createdAt === state.createdAt) return cached.quiz;
    const quiz = await this.store.getQuiz(code);
    if (!quiz) return null;
    if (this.quizCache.size >= 20) {
      const oldest = this.quizCache.keys().next().value;
      if (oldest !== undefined) this.quizCache.delete(oldest);
    }
    this.quizCache.set(code, { createdAt: state.createdAt, quiz });
    return quiz;
  }

  private answersKey(code: string, index: number): string {
    return this.store.subKey(code, "ans", index);
  }

  private scoresKey(code: string, index: number): string {
    return this.store.subKey(code, "scores", index);
  }

  private finalKey(code: string): string {
    return this.store.subKey(code, "final");
  }

  /** Setzt einen Regelverstoss in ein Ergebnis um. Alles andere ist ein echter Fehler und wird weitergereicht. */
  private failure(error: unknown): EngineResult<never> {
    if (error instanceof GameRuleError) return { ok: false, reason: toEngineFailure(error.reason) };
    throw error;
  }

  /** Führt eine Zustandsänderung aus und übersetzt Regelverstösse. */
  private async change(
    code: string,
    known: PublicGameState | null,
    mutate: (state: PublicGameState) => PublicGameState,
  ): Promise<EngineResult<PublicGameState>> {
    try {
      const outcome = await this.store.update(code, mutate, known ?? undefined);
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      return { ok: true, value: outcome.state };
    } catch (error) {
      return this.failure(error);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Befehle des Admins
  // ---------------------------------------------------------------------------------------------------------

  async command(code: string, command: Command, expectedVersion?: number): Promise<ControllerResult> {
    let result: EngineResult<unknown>;
    switch (command) {
      case "start":
        result = await this.start(code, expectedVersion);
        break;
      case "resolve":
        result = await this.resolve(code, { reason: "manual", expectedVersion });
        break;
      case "next":
        result = await this.next(code, expectedVersion);
        break;
      case "reveal":
        result = await this.reveal(code, expectedVersion);
        break;
      case "finish":
        result = await this.finish(code, expectedVersion);
        break;
      case "abort":
        result = await this.abort(code, expectedVersion);
        break;
    }
    return result.ok ? { ok: true } : { ok: false, error: result.reason };
  }

  /** Warteraum zur ersten Frage. Braucht mindestens einen Spieler (Annahme, siehe docs/ANNAHMEN.md). */
  async start(code: string, expectedVersion?: number): Promise<EngineResult<PublicGameState>> {
    const state = await this.store.getState(code);
    if (!state) return { ok: false, reason: "not_found" };
    const quiz = await this.loadQuiz(code, state);
    if (!quiz) return { ok: false, reason: "no_quiz" };
    const first = quiz.questions[0];
    if (!first) return { ok: false, reason: "no_quiz" };

    // Der Snapshot muss so lange leben wie das Spiel, auch wenn der Warteraum lange offen war.
    await this.store.port.expire(this.store.subKey(code, "quiz"), this.store.ttlSeconds);

    const result = await this.change(code, state, (current) => {
      this.checkVersion(current, expectedVersion);
      if (current.phase !== "lobby") throw new GameRuleError("wrong_phase");
      if (current.players.length === 0) throw new GameRuleError("no_players");
      return {
        ...current,
        phase: "question",
        question: toPublicQuestion(first, 0, quiz.questions.length, this.now()),
        resolution: null,
        results: {},
        podium: null,
      };
    });
    if (result.ok) {
      this.log("game_started", { code, players: result.value.players.length });
      await this.runHook("onStarted", () => this.hooks.onStarted?.({ code, createdAt: result.value.createdAt }));
    }
    return result;
  }

  private checkVersion(state: PublicGameState, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && state.version !== expectedVersion) throw new GameRuleError("stale");
  }

  /** Nach dem Ende einer Frage zur nächsten. */
  async next(code: string, expectedVersion?: number): Promise<EngineResult<PublicGameState>> {
    const state = await this.store.getState(code);
    if (!state) return { ok: false, reason: "not_found" };
    const quiz = await this.loadQuiz(code, state);
    if (!quiz) return { ok: false, reason: "no_quiz" };

    return this.change(code, state, (current) => {
      this.checkVersion(current, expectedVersion);
      if (current.phase !== "resolved" || !current.question) throw new GameRuleError("wrong_phase");
      const index = current.question.index + 1;
      const question = quiz.questions[index];
      if (!question) throw new GameRuleError("wrong_phase");
      return {
        ...current,
        phase: "question",
        question: toPublicQuestion(question, index, quiz.questions.length, this.now()),
        resolution: null,
        results: {},
      };
    });
  }

  /** Enthüllt den nächsten Platz des Siegerbildschirms, zuerst den untersten. */
  async reveal(code: string, expectedVersion?: number): Promise<EngineResult<PublicGameState>> {
    const state = await this.store.getState(code);
    if (!state) return { ok: false, reason: "not_found" };
    if (state.phase !== "podium" || !state.podium) return { ok: false, reason: "wrong_phase" };
    const finalRows = await this.readFinalRows(code);
    if (!finalRows) return { ok: false, reason: "wrong_phase" };

    return this.change(code, state, (current) => {
      this.checkVersion(current, expectedVersion);
      const podium = current.podium;
      if (current.phase !== "podium" || !podium || podium.revealed >= podium.size) throw new GameRuleError("wrong_phase");
      const revealed = podium.revealed + 1;
      const done = revealed >= podium.size;
      return {
        ...current,
        podium: {
          ...podium,
          revealed,
          places: revealedPlaces(finalRows, podium.size, revealed),
          // Die vollständige Rangliste folgt erst, wenn Platz 1 enthüllt ist.
          ranking: done ? finalRows : null,
        },
      };
    });
  }

  /** Beendet das Quiz nach der vollständigen Enthüllung. */
  async finish(code: string, expectedVersion?: number): Promise<EngineResult<PublicGameState>> {
    return this.change(code, null, (current) => {
      this.checkVersion(current, expectedVersion);
      const podium = current.podium;
      if (current.phase !== "podium" || !podium || podium.revealed < podium.size) throw new GameRuleError("wrong_phase");
      return { ...current, phase: "finished" };
    });
  }

  /**
   * Bricht das Spiel ab. Vor dem Ende der letzten Frage gibt es keine Resultate (Status "abgebrochen"). Das Spiel
   * erscheint danach als beendet ohne Siegerbildschirm.
   */
  async abort(code: string, expectedVersion?: number): Promise<EngineResult<PublicGameState>> {
    const result = await this.change(code, null, (current) => {
      this.checkVersion(current, expectedVersion);
      if (current.phase === "podium" || current.phase === "finished") throw new GameRuleError("wrong_phase");
      return { ...current, phase: "finished", question: null, resolution: null, results: {}, podium: null };
    });
    if (result.ok) {
      this.log("game_aborted", { code });
      await this.runHook("onAborted", () => this.hooks.onAborted?.({ code, createdAt: result.value.createdAt }));
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Antworten
  // ---------------------------------------------------------------------------------------------------------

  async answer(
    code: string,
    playerId: string,
    message: { q: number; option?: number; value?: number },
    hint: PublicGameState | null,
  ): Promise<ControllerResult> {
    const result = await this.submitAnswer(code, playerId, message, hint);
    return result.ok ? { ok: true } : { ok: false, error: result.reason };
  }

  async submitAnswer(
    code: string,
    playerId: string,
    message: { q: number; option?: number; value?: number },
    hint: PublicGameState | null,
  ): Promise<EngineResult<number>> {
    // Der bekannte Zustand der Instanz spart den Lesebefehl. Ist er nicht brauchbar, wird frisch gelesen.
    let state = hint;
    if (!state || state.phase !== "question" || state.question?.index !== message.q) {
      state = await this.store.getState(code);
    }
    if (!state) return { ok: false, reason: "not_found" };
    const question = state.question;
    if (state.phase !== "question" || !question) return { ok: false, reason: "too_late" };
    if (message.q !== question.index) return { ok: false, reason: "stale" };
    if (!state.players.some((player) => player.id === playerId)) return { ok: false, reason: "invalid" };

    const arrivedAt = this.now();
    if (arrivedAt > question.deadline + ANSWER_GRACE_MS) return { ok: false, reason: "too_late" };

    // Form der Antwort zur Art der Frage prüfen.
    const stored: StoredAnswer = { t: clampAnswerTime(arrivedAt - question.startedAt, question.timeLimitSeconds) };
    if (question.type === "estimate") {
      if (typeof message.value !== "number" || !Number.isFinite(message.value) || message.option !== undefined) {
        return { ok: false, reason: "invalid" };
      }
      stored.v = message.value;
    } else {
      if (typeof message.option !== "number" || message.value !== undefined) return { ok: false, reason: "invalid" };
      if (!question.options.some((option) => option.index === message.option)) return { ok: false, reason: "invalid" };
      stored.o = message.option;
    }

    const count = Number(
      await this.store.port.eval(
        ANSWER_SCRIPT,
        [this.answersKey(code, question.index)],
        [playerId, JSON.stringify(stored), this.store.ttlSeconds],
      ),
    );
    if (count === -1) return { ok: false, reason: "too_late" };
    if (count === -2) return { ok: false, reason: "already_answered" };

    // Der Fortschritt ist flüchtig. Geht er verloren, zeigt der Beamer die Zahl eben erst bei der nächsten Antwort.
    this.store.publishEphemeral(code, { k: "progress", q: question.index, n: count }).catch(() => {});

    // Haben alle geantwortet, endet die Frage sofort. Das erledigt der Server selbst, ohne den Browser des Admins.
    if (count >= state.players.length) {
      const resolved = await this.resolve(code, { reason: "all_answered", questionIndex: question.index }, state);
      if (!resolved.ok) this.log("auto_resolve_failed", { code, reason: resolved.reason });
    }
    return { ok: true, value: count };
  }

  async mine(code: string, playerId: string, q: number): Promise<{ option?: number; value?: number } | null> {
    const [raw] = await this.store.port.hgetBatch([{ key: this.answersKey(code, q), field: playerId }]);
    if (!raw) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = storedAnswerSchema.safeParse(json);
    if (!parsed.success) return null;
    return {
      ...(parsed.data.o !== undefined ? { option: parsed.data.o } : {}),
      ...(parsed.data.v !== undefined ? { value: parsed.data.v } : {}),
    };
  }

  async progress(code: string, q: number): Promise<number> {
    const all = await this.store.port.hgetall(this.answersKey(code, q));
    return Object.keys(all).filter((field) => field !== CLOSED_FIELD).length;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Auflösung
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Ein Gerät meldet, dass seine Zeit abgelaufen ist. Der Server glaubt das nicht, er prüft die Frist selbst.
   * Der Hinweis ist nur ein Anstoss, weil es keine Server Timer gibt.
   */
  async tick(code: string, hint: PublicGameState | null): Promise<void> {
    let state = hint;
    if (!state || state.phase !== "question" || !state.question) state = await this.store.getState(code);
    if (!state || state.phase !== "question" || !state.question) return;
    if (this.now() < state.question.deadline) return;
    await this.resolve(code, { reason: "timeout", questionIndex: state.question.index }, state);
  }

  /**
   * Beendet die aktuelle Frage und wertet sie aus.
   * questionIndex: Wird er angegeben und läuft inzwischen eine andere Frage oder die Frage ist schon aufgelöst, ist
   * das kein Fehler, sondern ein Erfolg ohne Wirkung (idempotent). So dürfen mehrere Auslöser gleichzeitig feuern.
   */
  async resolve(
    code: string,
    options: { reason: "manual" | "all_answered" | "timeout"; expectedVersion?: number; questionIndex?: number },
    known: PublicGameState | null = null,
  ): Promise<EngineResult<undefined>> {
    let state = known;
    if (!state || state.phase !== "question") state = await this.store.getState(code);
    if (!state) return { ok: false, reason: "not_found" };

    const question = state.question;
    if (state.phase !== "question" || !question) {
      return options.questionIndex !== undefined ? { ok: true, value: undefined } : { ok: false, reason: "wrong_phase" };
    }
    if (options.questionIndex !== undefined && question.index !== options.questionIndex) return { ok: true, value: undefined };
    if (options.expectedVersion !== undefined && state.version !== options.expectedVersion) return { ok: false, reason: "stale" };
    if (options.reason === "timeout" && this.now() < question.deadline) return { ok: false, reason: "too_early" };

    const quiz = await this.loadQuiz(code, state);
    if (!quiz) return { ok: false, reason: "no_quiz" };
    const snapshot = quiz.questions[question.index];
    if (!snapshot) return { ok: false, reason: "invalid" };

    // 1. Antworten schliessen und lesen, atomar. Danach nimmt der Server keine Antwort mehr an.
    const rawAnswers = pairsToRecord(
      await this.store.port.eval(CLOSE_AND_READ_SCRIPT, [this.answersKey(code, question.index)], [this.store.ttlSeconds]),
    );
    const answers = new Map<string, StoredAnswer>();
    for (const [playerId, raw] of Object.entries(rawAnswers)) {
      if (playerId === CLOSED_FIELD) continue;
      try {
        const parsed = storedAnswerSchema.safeParse(JSON.parse(raw));
        if (parsed.success) answers.set(playerId, parsed.data);
      } catch {
        // Eine unlesbare Antwort zählt wie keine Antwort.
      }
    }

    // 2. Stand nach der Vorfrage lesen und auswerten.
    const prior = question.index > 0 ? await this.readScores(code, question.index - 1) : new Map<string, PlayerScore>();
    const evaluation = evaluateQuestion({
      question: snapshot,
      index: question.index,
      questionCount: quiz.questions.length,
      players: state.players,
      answers,
      prior,
    });

    // 3. Stand dieser Frage ablegen. Der Schlüssel hängt an der Fragenummer: Eine wiederholte Auflösung schreibt
    //    denselben Inhalt noch einmal.
    const serialized: Record<string, string> = {};
    for (const [playerId, score] of Object.entries(evaluation.scores)) serialized[playerId] = JSON.stringify(score);
    await this.store.port.hsetMany(this.scoresKey(code, question.index), serialized, this.store.ttlSeconds);

    // 4. Nach der letzten Frage die Endrangliste vorbereiten. Sie bleibt geheim, bis der Admin enthüllt.
    if (evaluation.isLast) {
      const finalRows = buildFinalRows(state.players, new Map(Object.entries(evaluation.scores)));
      await this.store.port.set(this.finalKey(code), JSON.stringify(finalRows), this.store.ttlSeconds);
    }

    // 5. Zustand ändern. Nur eine von mehreren gleichzeitigen Auflösungen gewinnt.
    const changed = await this.change(code, state, (current) => {
      this.checkVersion(current, options.expectedVersion);
      if (current.phase !== "question" || current.question?.index !== question.index) throw new GameRuleError("wrong_phase");
      if (evaluation.isLast) {
        return {
          ...current,
          phase: "podium",
          resolution: evaluation.resolution,
          results: evaluation.results,
          podium: { size: podiumSize(current.players.length), revealed: 0, places: [], ranking: null },
        };
      }
      return { ...current, phase: "resolved", resolution: evaluation.resolution, results: evaluation.results };
    });

    if (!changed.ok) {
      // Eine andere Auflösung war schneller (zum Beispiel Klick des Admins und Zeitablauf im selben Moment). Das
      // Ergebnis ist dasselbe, also ist nichts zu tun und es ist kein Fehler.
      if (changed.reason === "wrong_phase") return { ok: true, value: undefined };
      return changed;
    }

    this.log("question_resolved", { code, q: question.index, reason: options.reason, answered: evaluation.resolution.answered });
    if (evaluation.isLast) await this.persist(code);
    return { ok: true, value: undefined };
  }

  private async readScores(code: string, index: number): Promise<Map<string, PlayerScore>> {
    const raw = await this.store.port.hgetall(this.scoresKey(code, index));
    const scores = new Map<string, PlayerScore>();
    for (const [playerId, value] of Object.entries(raw)) {
      try {
        const parsed = playerScoreSchema.safeParse(JSON.parse(value));
        if (parsed.success) scores.set(playerId, parsed.data);
      } catch {
        // Unlesbare Einträge werden übergangen, der Spieler startet dann ohne Vorstand.
      }
    }
    return scores;
  }

  private async readFinalRows(code: string): Promise<FinalRow[] | null> {
    const raw = await this.store.port.get(this.finalKey(code));
    if (!raw) return null;
    const parsed = finalRowsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Resultate speichern
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Stellt die Resultate eines beendeten Spiels aus Redis zusammen. Funktioniert nach der letzten Frage, solange
   * das Spiel in Redis lebt. Wird auch für das erneute Speichern aus dem Adminportal gebraucht.
   */
  async collectOutcome(code: string): Promise<GameOutcome | null> {
    const state = await this.store.getState(code);
    if (!state || !state.quiz || !state.podium) return null;
    const quiz = await this.loadQuiz(code, state);
    if (!quiz) return null;
    const finalRows = await this.readFinalRows(code);
    if (!finalRows) return null;
    const records = await Promise.all(quiz.questions.map((_, index) => this.readScores(code, index)));
    return { code, createdAt: state.createdAt, quiz, players: state.players, finalRows, records };
  }

  /** Speichert die Resultate mit bis zu drei Versuchen. Ein Fehler stoppt das Spiel nicht, die Resultate bleiben in Redis. */
  async persist(code: string): Promise<boolean> {
    const hook = this.hooks.onFinished;
    if (!hook) return true;
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt += 1) {
      try {
        const outcome = await this.collectOutcome(code);
        if (!outcome) throw new Error("Die Resultate sind nicht mehr in Redis.");
        await hook(outcome);
        this.log("results_saved", { code, attempt: attempt + 1 });
        return true;
      } catch (error) {
        this.log("results_save_failed", {
          code,
          attempt: attempt + 1,
          message: error instanceof Error ? error.message : String(error),
        });
        const delay = this.retryDelays[attempt];
        if (delay === undefined) break;
        await sleep(delay);
      }
    }
    return false;
  }

  private async runHook(name: string, run: () => Promise<void> | undefined): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.log("hook_failed", { hook: name, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function toEngineFailure(reason: RuleFailure): EngineFailure {
  switch (reason) {
    case "not_found":
    case "wrong_phase":
    case "stale":
    case "no_players":
    case "invalid":
    case "busy":
      return reason;
    default:
      return "wrong_phase";
  }
}
