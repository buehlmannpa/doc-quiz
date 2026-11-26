"use client";

/**
 * Ansichten der Smartphones nach Phase des Spiels. Alles in einer schmalen Spalte, grosse Knöpfe, keine Details,
 * die ablenken. Die richtige Antwort sehen die Geräte erst bei der Auflösung (der Zustand enthält sie vorher nicht).
 */
import { useState } from "react";
import AnswerSymbol from "@/components/AnswerSymbol";
import Notice from "@/components/Notice";
import { avatarEmoji } from "@/lib/game/avatars";
import { ANSWER_SLOTS } from "@/lib/design";
import { formatNumber, parseDecimal } from "@/lib/quiz/number";
import type { PlayerResult, PublicGameState } from "@/lib/realtime/game-state";
import { useRemainingMs, type UseGame } from "@/lib/realtime/useGame";

type Me = { playerId: string; name: string; avatar: number };

const ANSWER_ERRORS: Record<string, string> = {
  too_late: "Zu spät. Die Zeit ist abgelaufen.",
  stale: "Diese Frage ist schon vorbei.",
  wrong_phase: "Diese Frage ist schon vorbei.",
  invalid: "Die Antwort ist ungültig.",
  offline: "Keine Verbindung. Bitte versuchen Sie es noch einmal.",
  timeout: "Keine Antwort vom Server. Bitte prüfen Sie Ihre Verbindung.",
  disconnected: "Die Verbindung wurde unterbrochen. Bitte versuchen Sie es noch einmal.",
  server_error: "Der Server hat Probleme. Bitte versuchen Sie es noch einmal.",
  forbidden: "Das ist nicht erlaubt.",
};

export function Waiting({ title, text }: { title: string; text?: string }) {
  return (
    <section className="glass-card pop-in space-y-2 px-6 py-10 text-center">
      <h1 className="text-xl font-bold tracking-tight">{title}</h1>
      {text ? <p className="text-ink-soft text-sm">{text}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Warteraum
// ---------------------------------------------------------------------------------------------------------

export function LobbyView({ me, state, onNudge }: { me: Me; state: PublicGameState; onNudge: () => void }) {
  const [hopKey, setHopKey] = useState(0);
  const [lastHop, setLastHop] = useState(0);

  function hop() {
    // Die eigene Bubble hüpft sofort, der Server begrenzt auf einmal pro 2 Sekunden und gibt es an den Beamer weiter.
    setHopKey((key) => key + 1);
    const now = Date.now();
    if (now - lastHop >= 2000) {
      setLastHop(now);
      onNudge();
    }
  }

  return (
    <section className="glass-card pop-in space-y-5 px-6 py-8 text-center">
      <h1 className="text-xl font-bold tracking-tight">Sie sind dabei!</h1>
      <button
        type="button"
        onClick={hop}
        aria-label="Ihre Bubble auf dem Bildschirm hüpfen lassen"
        className="mx-auto flex h-36 w-36 flex-col items-center justify-center rounded-full"
        style={{ background: "rgba(227, 6, 19, 0.08)", border: "2px solid rgba(227, 6, 19, 0.25)" }}
      >
        <span key={hopKey} className={hopKey > 0 ? "hop block text-6xl" : "block text-6xl"} aria-hidden="true">
          {avatarEmoji(me.avatar)}
        </span>
      </button>
      <p className="text-lg font-bold">{me.name}</p>
      <p className="text-ink-soft text-sm">Tippen Sie auf Ihr Icon, dann hüpft Ihre Bubble auf dem Bildschirm.</p>
      <p className="text-sm font-semibold">
        {state.players.length === 1 ? "Eine Person ist dabei." : `${state.players.length} Personen sind dabei.`}
      </p>
      <p className="text-ink-soft text-xs">Das Quiz beginnt, sobald der Spielleiter es startet.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Frage
// ---------------------------------------------------------------------------------------------------------

function CountdownBar({ remainingMs, totalMs }: { remainingMs: number | null; totalMs: number }) {
  const fraction = remainingMs === null ? 1 : Math.max(0, Math.min(1, remainingMs / totalMs));
  const seconds = remainingMs === null ? null : Math.ceil(remainingMs / 1000);
  return (
    <div className="flex items-center gap-3" role="timer" aria-live="off" aria-label={seconds === null ? "Zeit" : `Noch ${seconds} Sekunden`}>
      <div className="h-3 flex-1 overflow-hidden rounded-full" style={{ background: "rgba(0,0,0,0.08)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${fraction * 100}%`, background: fraction < 0.25 ? "#e30613" : "#1d1d1f", transition: "width 0.12s linear" }}
        />
      </div>
      <span className="w-10 text-right text-lg font-bold tabular-nums">{seconds ?? "–"}</span>
    </div>
  );
}

export function QuestionView({ game, state }: { game: UseGame; state: PublicGameState }) {
  const question = state.question;
  const remaining = useRemainingMs(question?.deadline ?? null, game.serverNow);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAnyway, setSentAnyway] = useState<number | null>(null);
  const [input, setInput] = useState("");

  if (!question) return null;
  const total = question.timeLimitSeconds * 1000;
  const answered = game.mine !== null || sentAnyway === question.index;
  const over = remaining !== null && remaining <= 0;

  async function send(payload: { option: number } | { value: number }) {
    if (sending) return;
    setSending(true);
    setError(null);
    const result = await game.answer(payload);
    setSending(false);
    if (!result.ok) {
      // "schon beantwortet" heisst: Die erste Antwort ist angekommen (zum Beispiel nach einer Verbindungsstörung).
      if (result.error === "already_answered") setSentAnyway(question!.index);
      else setError(ANSWER_ERRORS[result.error] ?? "Die Antwort konnte nicht gesendet werden.");
    }
  }

  function sendEstimate(event: React.FormEvent) {
    event.preventDefault();
    const value = parseDecimal(input);
    if (value === null) {
      setError("Bitte geben Sie eine Zahl ein.");
      return;
    }
    void send({ value });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-ink-soft flex items-center justify-between text-sm font-semibold">
          <span>
            Frage {question.index + 1} von {question.total}
          </span>
          {question.type === "poll" ? <span className="tag bg-black/5">Umfrage</span> : <span>{formatNumber(question.maxPoints)} Punkte</span>}
        </div>
        <CountdownBar remainingMs={remaining} totalMs={total} />
      </div>

      <section className="glass-card px-5 py-5">
        <h1 className="text-xl leading-snug font-bold">{question.prompt}</h1>
      </section>

      {answered ? (
        <section className="glass-card pop-in space-y-2 px-5 py-6 text-center" role="status">
          <p className="text-lg font-bold">Antwort gesendet</p>
          {game.mine?.option !== undefined ? (
            <p className="text-ink-soft text-sm">Ihre Wahl: {question.options.find((o) => o.index === game.mine?.option)?.text}</p>
          ) : null}
          {game.mine?.value !== undefined ? (
            <p className="text-ink-soft text-sm">
              Ihre Schätzung: {formatNumber(game.mine.value)}
              {question.unit ? ` ${question.unit}` : ""}
            </p>
          ) : null}
          <p className="text-ink-soft text-sm">Warten auf die anderen …</p>
        </section>
      ) : over ? (
        <Notice tone="warn">Die Zeit ist abgelaufen. Gleich geht es weiter.</Notice>
      ) : question.type === "estimate" ? (
        <form onSubmit={sendEstimate} className="glass-card space-y-3 px-5 py-5" noValidate>
          <label htmlFor="estimate" className="text-sm font-semibold">
            Ihre Schätzung{question.unit ? ` in ${question.unit}` : ""}
          </label>
          <input
            id="estimate"
            className="field text-center text-2xl font-bold"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={sending}
          />
          <button type="submit" className="btn btn-primary w-full" disabled={sending || input.trim() === ""}>
            {sending ? "Wird gesendet …" : "Antwort senden"}
          </button>
        </form>
      ) : (
        <div className="space-y-3" role="group" aria-label="Antworten">
          {question.options.map((option) => {
            const slot = ANSWER_SLOTS[option.index as 0 | 1 | 2 | 3];
            return (
              <button
                key={option.index}
                type="button"
                className="answer-btn w-full"
                style={{ background: slot.background, color: slot.foreground }}
                disabled={sending}
                onClick={() => void send({ option: option.index })}
                aria-label={`${slot.label}: ${option.text}`}
              >
                <AnswerSymbol shape={slot.shape} />
                <span className="flex-1">{option.text}</span>
              </button>
            );
          })}
        </div>
      )}

      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Auflösung und Siegerbildschirm
// ---------------------------------------------------------------------------------------------------------

function rankText(result: PlayerResult): string | null {
  if (result.rank === null) return null;
  if (result.delta === null || result.delta === 0) return result.delta === 0 ? "Rang unverändert" : null;
  const places = Math.abs(result.delta);
  return result.delta > 0
    ? `▲ ${places} ${places === 1 ? "Platz" : "Plätze"} aufgestiegen`
    : `▼ ${places} ${places === 1 ? "Platz" : "Plätze"} abgestiegen`;
}

export function ResultView({ state, me }: { state: PublicGameState; me: Me }) {
  const question = state.question;
  const resolution = state.resolution;
  const result = state.results[me.playerId];
  if (!question || !resolution) return <Waiting title="Einen Moment …" />;

  if (!result) {
    return <Waiting title="Auflösung" text="Für Sie gibt es kein Ergebnis zu dieser Frage." />;
  }

  const isPoll = question.type === "poll";
  const isEstimate = question.type === "estimate";
  const good = result.correct === true || (isEstimate && (result.accuracy ?? 0) > 0);
  const headline = isPoll
    ? "Danke für Ihre Stimme!"
    : !result.answered
      ? "Keine Antwort"
      : isEstimate
        ? (result.accuracy ?? 0) >= 0.995
          ? "Volltreffer!"
          : (result.accuracy ?? 0) > 0
            ? "Nicht schlecht!"
            : "Leider zu weit weg"
        : result.correct
          ? "Richtig!"
          : "Leider falsch";
  const tone = isPoll ? "#1d1d1f" : good ? "#18772f" : "#c40511";
  const background = isPoll ? "rgba(0,0,0,0.05)" : good ? "rgba(52, 199, 89, 0.15)" : "rgba(227, 6, 19, 0.1)";
  const rank = rankText(result);
  const unit = question.unit ? ` ${question.unit}` : "";

  return (
    <div className="space-y-4">
      <section className="pop-in rounded-[20px] px-6 py-8 text-center" style={{ background, color: tone }} role="status">
        <h1 className="text-3xl font-extrabold tracking-tight">{headline}</h1>
        {!isPoll ? <p className="mt-2 text-2xl font-bold tabular-nums">+{formatNumber(result.points)} Punkte</p> : null}
      </section>

      {isEstimate && result.value !== null ? (
        <section className="glass-card space-y-1 px-5 py-4 text-sm">
          <p>
            Ihre Schätzung: <strong>{formatNumber(result.value)}{unit}</strong>
          </p>
          <p>
            Richtig war: <strong>{resolution.correctValue !== null ? `${formatNumber(resolution.correctValue)}${unit}` : "–"}</strong>
          </p>
          {result.deviation !== null ? (
            <p>
              Abweichung: <strong>{formatNumber(Math.abs(result.deviation))}{unit}</strong>
            </p>
          ) : null}
          {result.accuracy !== null ? (
            <p>
              Genauigkeit: <strong>{Math.round(result.accuracy * 100)} %</strong>
            </p>
          ) : null}
        </section>
      ) : null}

      {question.type === "multiple_choice" && result.correct === false ? (
        <section className="glass-card px-5 py-4 text-sm">
          Richtig war: <strong>{resolution.correctOptions.map((index) => question.options.find((o) => o.index === index)?.text).join(" oder ")}</strong>
        </section>
      ) : null}

      {isPoll ? (
        <section className="glass-card space-y-2 px-5 py-4">
          {question.options.map((option) => {
            const count = resolution.distribution[option.index] ?? 0;
            const percent = resolution.answered > 0 ? Math.round((count / resolution.answered) * 100) : 0;
            return (
              <div key={option.index} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className={result.option === option.index ? "font-bold" : ""}>{option.text}</span>
                  <span className="tabular-nums">{percent} %</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full" style={{ background: "rgba(0,0,0,0.08)" }}>
                  <div className="h-full rounded-full" style={{ width: `${percent}%`, background: ANSWER_SLOTS[option.index as 0 | 1 | 2 | 3].background }} />
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {result.rank !== null ? (
        <section className="glass-card space-y-1 px-5 py-4 text-center">
          <p className="text-ink-soft text-sm">Ihr Rang</p>
          <p className="text-3xl font-extrabold tabular-nums">{result.rank}.</p>
          {rank ? <p className="text-sm font-semibold">{rank}</p> : null}
          {result.total !== null ? <p className="text-ink-soft text-sm">{formatNumber(result.total)} Punkte insgesamt</p> : null}
        </section>
      ) : null}

      <p className="text-ink-soft text-center text-xs">Schauen Sie auf den Bildschirm. Die nächste Frage kommt gleich.</p>
    </div>
  );
}

const MEDALS = ["🥇", "🥈", "🥉"];

export function PodiumPhoneView({ state, me }: { state: PublicGameState; me: Me }) {
  const ranking = state.podium?.ranking ?? null;
  const own = ranking?.find((row) => row.playerId === me.playerId);

  if (ranking && own) {
    return (
      <div className="space-y-4">
        <section className="glass-card pop-in space-y-2 px-6 py-8 text-center">
          <p className="text-5xl" aria-hidden="true">
            {MEDALS[own.rank - 1] ?? avatarEmoji(me.avatar)}
          </p>
          <h1 className="text-3xl font-extrabold tracking-tight">Platz {own.rank}</h1>
          <p className="text-ink-soft">{formatNumber(own.points)} Punkte</p>
          {own.rank === 1 ? <p className="text-lg font-bold">Gratulation, Sie haben gewonnen!</p> : null}
        </section>
        <p className="text-ink-soft text-center text-xs">Danke fürs Mitspielen.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {state.question ? <ResultViewLastQuestion state={state} me={me} /> : null}
      <section className="glass-card pop-in space-y-2 px-6 py-8 text-center">
        <p className="text-4xl" aria-hidden="true">
          📺
        </p>
        <h2 className="text-xl font-bold tracking-tight">Schauen Sie auf den Bildschirm</h2>
        <p className="text-ink-soft text-sm">Dort wird gleich der Siegerbildschirm enthüllt.</p>
      </section>
    </div>
  );
}

/** Nach der letzten Frage: richtig oder falsch und Punkte, aber noch kein Rang. */
function ResultViewLastQuestion({ state, me }: { state: PublicGameState; me: Me }) {
  const result = state.results[me.playerId];
  const question = state.question;
  if (!result || !question) return null;
  const isPoll = question.type === "poll";
  const isEstimate = question.type === "estimate";
  const good = result.correct === true || (isEstimate && (result.accuracy ?? 0) > 0);
  const headline = isPoll
    ? "Danke für Ihre Stimme!"
    : !result.answered
      ? "Keine Antwort"
      : isEstimate
        ? good
          ? "Gute Schätzung!"
          : "Leider zu weit weg"
        : result.correct
          ? "Richtig!"
          : "Leider falsch";
  return (
    <section
      className="pop-in rounded-[20px] px-6 py-6 text-center"
      style={{
        background: isPoll ? "rgba(0,0,0,0.05)" : good ? "rgba(52, 199, 89, 0.15)" : "rgba(227, 6, 19, 0.1)",
        color: isPoll ? "#1d1d1f" : good ? "#18772f" : "#c40511",
      }}
      role="status"
    >
      <h1 className="text-2xl font-extrabold tracking-tight">{headline}</h1>
      {!isPoll ? <p className="mt-1 text-xl font-bold tabular-nums">+{formatNumber(result.points)} Punkte</p> : null}
      {isEstimate && result.accuracy !== null ? (
        <p className="mt-1 text-sm">
          Abweichung {formatNumber(Math.abs(result.deviation ?? 0))}
          {question.unit ? ` ${question.unit}` : ""}, Genauigkeit {Math.round(result.accuracy * 100)} %
        </p>
      ) : null}
    </section>
  );
}

export function FinishedView({ state, me }: { state: PublicGameState; me: Me }) {
  if (state.podium?.ranking) return <PodiumPhoneView state={state} me={me} />;
  return <Waiting title="Das Quiz ist beendet" text="Danke fürs Mitspielen." />;
}
