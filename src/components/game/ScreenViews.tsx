"use client";

/**
 * Ansichten der Beamer Seite nach Phase. Alle Grössen skalieren mit vmin (kleinere Seite des Fensters), damit
 * derselbe Bildschirm vom Laptop bis zum Full HD Beamer gut lesbar bleibt, ohne zu scrollen.
 */
import { forwardRef } from "react";
import AnswerSymbol from "@/components/AnswerSymbol";
import Logo from "@/components/Logo";
import BubbleCanvas, { type BubbleCanvasHandle } from "@/components/game/BubbleCanvas";
import { ANSWER_SLOTS } from "@/lib/design";
import { avatarEmoji } from "@/lib/game/avatars";
import { formatNumber } from "@/lib/quiz/number";
import type { FinalRow, PublicGameState, RankingRow } from "@/lib/realtime/game-state";
import { useRemainingMs } from "@/lib/realtime/useGame";

function groupedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

// ---------------------------------------------------------------------------------------------------------
// Warteraum
// ---------------------------------------------------------------------------------------------------------

export const ScreenLobby = forwardRef<BubbleCanvasHandle, { state: PublicGameState; joinUrl: string; qr: string }>(
  function ScreenLobby({ state, joinUrl, qr }, ref) {
    const count = state.players.length;
    return (
      <div className="flex h-full gap-[3vmin]">
        <aside className="glass-card flex w-[34%] shrink-0 flex-col items-center justify-center gap-[2.2vmin] p-[3vmin] text-center">
          <Logo className="h-[9vmin]" />
          <div
            className="aspect-square w-full max-w-[34vmin] overflow-hidden rounded-[2vmin] bg-white p-[1vmin]"
            role="img"
            aria-label={`QR Code zum Beitreten: ${joinUrl}`}
            // Der SVG Text stammt vom Server aus unserer eigenen Beitrittsadresse (siehe lib/game/qr.ts).
            dangerouslySetInnerHTML={{ __html: qr }}
          />
          <p className="text-[2.1vmin] font-semibold">Scannen oder Code eingeben</p>
          <p className="text-accent text-[7vmin] leading-none font-extrabold tracking-widest tabular-nums">{groupedCode(state.code)}</p>
          <p className="text-ink-soft text-[1.8vmin] break-all">{joinUrl.replace(/^https?:\/\//, "").replace(/\/join\/\d{6}$/, "/join")}</p>
        </aside>

        <section className="relative flex min-w-0 flex-1 flex-col">
          <header className="mb-[1.5vmin] flex items-end justify-between gap-[2vmin]">
            <div>
              <h1 className="screen-title">{state.quiz?.title ?? "DOC Bern Quiz"}</h1>
              <p className="screen-small">Warteraum. Das Quiz beginnt gleich.</p>
            </div>
            <p className="text-[3.4vmin] font-bold tabular-nums" aria-live="polite">
              {count === 0 ? "Noch niemand da" : count === 1 ? "1 Person" : `${count} Personen`}
            </p>
          </header>
          <div className="glass-card relative min-h-0 flex-1 overflow-hidden">
            <BubbleCanvas ref={ref} players={state.players} />
            {count === 0 ? (
              <p className="screen-text text-ink-soft absolute inset-0 flex items-center justify-center text-center">
                Scannen Sie den QR Code, um mitzuspielen.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------------------------------------
// Frage
// ---------------------------------------------------------------------------------------------------------

export function ScreenQuestion({ state, answered, serverNow }: { state: PublicGameState; answered: number; serverNow: () => number }) {
  const question = state.question;
  const remaining = useRemainingMs(question?.deadline ?? null, serverNow, 100);
  if (!question) return null;
  const total = question.timeLimitSeconds * 1000;
  const fraction = remaining === null ? 1 : Math.max(0, Math.min(1, remaining / total));
  const seconds = remaining === null ? null : Math.ceil(remaining / 1000);
  const players = state.players.length;
  const columns = question.options.length > 2 ? "grid-cols-2" : "grid-cols-1";

  return (
    <div className="flex h-full flex-col gap-[2.5vmin]">
      <header className="flex items-center gap-[3vmin]">
        <p className="screen-text shrink-0">
          Frage {question.index + 1} von {question.total}
          {question.type === "poll" ? " · Umfrage" : ` · ${formatNumber(question.maxPoints)} Punkte`}
        </p>
        <div className="h-[2.4vmin] flex-1 overflow-hidden rounded-full bg-black/10" role="presentation">
          <div
            className="h-full rounded-full"
            style={{ width: `${fraction * 100}%`, background: fraction < 0.25 ? "#e30613" : "#1d1d1f", transition: "width 0.12s linear" }}
          />
        </div>
        <p className="w-[11vmin] shrink-0 text-right text-[7vmin] leading-none font-extrabold tabular-nums" role="timer" aria-label={`Noch ${seconds ?? 0} Sekunden`}>
          {seconds ?? "–"}
        </p>
      </header>

      <section className="glass-card flex flex-1 items-center justify-center px-[4vmin] py-[3vmin] text-center">
        <h1 className="text-[5.6vmin] leading-tight font-extrabold tracking-tight">{question.prompt}</h1>
      </section>

      {question.type === "estimate" ? (
        <section className="glass-card flex items-center justify-center gap-[2vmin] px-[4vmin] py-[3.5vmin] text-center">
          <p className="text-[4vmin] font-bold">Schätzen Sie auf Ihrem Smartphone{question.unit ? ` (in ${question.unit})` : ""}.</p>
        </section>
      ) : (
        <div className={`grid gap-[2vmin] ${columns}`}>
          {question.options.map((option) => {
            const slot = ANSWER_SLOTS[option.index as 0 | 1 | 2 | 3];
            return (
              <div
                key={option.index}
                className="flex items-center gap-[2vmin] rounded-[2.2vmin] px-[3vmin] py-[3.2vmin]"
                style={{ background: slot.background, color: slot.foreground }}
              >
                <span className="shrink-0">
                  <AnswerSymbol shape={slot.shape} size="5vmin" />
                </span>
                <span className="text-[4vmin] leading-tight font-bold">{option.text}</span>
              </div>
            );
          })}
        </div>
      )}

      <footer className="flex items-center gap-[2vmin] pr-[11vmin]" aria-live="polite">
        <div className="h-[1.6vmin] flex-1 overflow-hidden rounded-full bg-black/10">
          <div
            className="h-full rounded-full bg-[#34c759]"
            style={{ width: `${players > 0 ? Math.min(100, (answered / players) * 100) : 0}%`, transition: "width 0.3s ease" }}
          />
        </div>
        <p className="screen-small shrink-0 font-semibold" style={{ color: "var(--color-ink)" }}>
          {answered} von {players} haben geantwortet
        </p>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Auflösung
// ---------------------------------------------------------------------------------------------------------

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function EstimateStrip({ state }: { state: PublicGameState }) {
  const resolution = state.resolution;
  const question = state.question;
  if (!resolution || !question || resolution.correctValue === null) return null;
  const correct = resolution.correctValue;
  const tolerance = resolution.tolerance ?? 0;
  const unit = resolution.unit ? ` ${resolution.unit}` : "";
  const values = resolution.estimates;
  const low = Math.min(correct - tolerance, ...values);
  const high = Math.max(correct + tolerance, ...values);
  const span = high - low || 1;
  const at = (value: number) => `${((value - low) / span) * 100}%`;

  return (
    <div className="flex h-full flex-col justify-center gap-[1.4vmin]">
      <p className="text-[2.6vmin] font-semibold">Richtiger Wert</p>
      <p className="text-[8vmin] leading-none font-extrabold">
        {formatNumber(correct)}
        {unit}
      </p>
      <div className="relative mt-[1vmin] h-[8vmin]" role="img" aria-label="Verteilung der Schätzungen">
        <div className="absolute top-1/2 right-0 left-0 h-[0.6vmin] -translate-y-1/2 rounded-full bg-black/15" />
        <div
          className="absolute top-1/2 h-[3.4vmin] -translate-y-1/2 rounded-full"
          style={{ left: at(correct - tolerance), width: `calc(${at(correct + tolerance)} - ${at(correct - tolerance)})`, background: "rgba(52,199,89,0.28)" }}
        />
        {values.map((value, index) => (
          <span
            key={index}
            className="absolute top-1/2 h-[2.2vmin] w-[2.2vmin] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: at(value), background: "rgba(227,6,19,0.65)", border: "0.25vmin solid #fff" }}
          />
        ))}
        <span className="absolute top-0 bottom-0 w-[0.7vmin] -translate-x-1/2 rounded-full bg-[#18772f]" style={{ left: at(correct) }} />
      </div>
      <p className="screen-small">
        {values.length === 0
          ? "Es gab keine Schätzungen."
          : `${values.length} Schätzungen, Median ${formatNumber(median(values))}${unit}, von ${formatNumber(values[0] as number)}${unit} bis ${formatNumber(values[values.length - 1] as number)}${unit}`}
      </p>
    </div>
  );
}

function ChoiceDistribution({ state }: { state: PublicGameState }) {
  const resolution = state.resolution;
  const question = state.question;
  if (!resolution || !question) return null;
  const max = Math.max(1, ...resolution.distribution);
  const correctTexts = resolution.correctOptions.map((index) => question.options.find((o) => o.index === index)?.text).filter(Boolean);

  return (
    <div className="flex h-full flex-col gap-[1.2vmin]">
      <p className="text-[3vmin] font-bold">
        Richtig: <span className="text-[#18772f]">{correctTexts.join(" oder ")}</span>
      </p>
      <div className="flex min-h-0 flex-1 items-end gap-[2vmin]">
        {question.options.map((option) => {
          const slot = ANSWER_SLOTS[option.index as 0 | 1 | 2 | 3];
          const count = resolution.distribution[option.index] ?? 0;
          const correct = resolution.correctOptions.includes(option.index);
          return (
            <div key={option.index} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-[0.8vmin]" style={{ opacity: correct ? 1 : 0.55 }}>
              <p className="text-center text-[3vmin] leading-none font-extrabold tabular-nums">{count}</p>
              <div
                className="rounded-t-[1vmin]"
                style={{
                  height: `${Math.max(2, (count / max) * 100) * 0.62}%`,
                  background: slot.background,
                  outline: correct ? "0.6vmin solid #18772f" : "none",
                  outlineOffset: "0.3vmin",
                }}
              />
              <div className="flex items-center justify-center gap-[0.8vmin] text-[2.2vmin] font-semibold">
                <span style={{ color: slot.background === "#ff9500" ? "#a35f00" : slot.background === "#34c759" ? "#18772f" : slot.background }}>
                  <AnswerSymbol shape={slot.shape} size="3vmin" />
                </span>
                {correct ? <span aria-label="richtig">✓</span> : null}
                <span className="truncate">{option.text}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PollResult({ state }: { state: PublicGameState }) {
  const resolution = state.resolution;
  const question = state.question;
  if (!resolution || !question) return null;
  const answered = Math.max(1, resolution.answered);
  return (
    <div className="flex h-full flex-col gap-[3vmin]">
      <section className="glass-card px-[4vmin] py-[3vmin] text-center">
        <p className="screen-small">Umfrage</p>
        <h1 className="text-[5vmin] leading-tight font-extrabold">{question.prompt}</h1>
      </section>
      <div className="flex flex-1 flex-col justify-center gap-[2.6vmin]">
        {question.options.map((option) => {
          const slot = ANSWER_SLOTS[option.index as 0 | 1 | 2 | 3];
          const count = resolution.distribution[option.index] ?? 0;
          const percent = Math.round((count / answered) * 100);
          return (
            <div key={option.index} className="space-y-[0.8vmin]">
              <div className="flex items-center justify-between text-[3.6vmin] font-bold">
                <span className="flex items-center gap-[1.4vmin]">
                  <AnswerSymbol shape={slot.shape} size="4vmin" />
                  {option.text}
                </span>
                <span className="tabular-nums">
                  {percent} % <span className="text-ink-soft text-[2.6vmin] font-semibold">({count})</span>
                </span>
              </div>
              <div className="h-[4.4vmin] overflow-hidden rounded-full bg-black/10">
                <div className="h-full rounded-full" style={{ width: `${percent}%`, background: slot.background, transition: "width 0.8s ease" }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="screen-small text-center">{resolution.answered} Stimmen</p>
    </div>
  );
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="w-[8vmin]" />;
  if (delta === 0) return <span className="text-ink-soft w-[8vmin] text-center text-[2.6vmin] font-bold">–</span>;
  const up = delta > 0;
  return (
    <span className="w-[8vmin] text-center text-[2.8vmin] font-extrabold tabular-nums" style={{ color: up ? "#18772f" : "#c40511" }} aria-label={up ? `${delta} Plätze aufgestiegen` : `${-delta} Plätze abgestiegen`}>
      {up ? "▲" : "▼"} {Math.abs(delta)}
    </span>
  );
}

function RankingTop({ rows }: { rows: readonly RankingRow[] }) {
  return (
    <ol className="flex h-full flex-col justify-center gap-[1.4vmin]" aria-label="Rangliste, die besten fünf">
      {rows.map((row, index) => (
        <li
          key={row.playerId}
          className="rise glass-card flex items-center gap-[2vmin] px-[2.6vmin] py-[1.5vmin]"
          style={{ animationDelay: `${index * 90}ms` }}
        >
          <span className="w-[6vmin] text-center text-[4.4vmin] font-extrabold tabular-nums">{row.rank}</span>
          <span className="text-[4.6vmin]" aria-hidden="true">{avatarEmoji(row.avatar)}</span>
          <span className="min-w-0 flex-1 truncate text-[3.8vmin] font-bold">{row.name}</span>
          <span className="w-[14vmin] text-right text-[3vmin] font-bold tabular-nums" style={{ color: row.points > 0 ? "#18772f" : "var(--color-ink-soft)" }}>
            +{formatNumber(row.points)}
          </span>
          <span className="w-[16vmin] text-right text-[3.6vmin] font-extrabold tabular-nums">{formatNumber(row.total)}</span>
          <DeltaBadge delta={row.delta} />
        </li>
      ))}
    </ol>
  );
}

export function ScreenResolved({ state }: { state: PublicGameState }) {
  const question = state.question;
  const resolution = state.resolution;
  if (!question || !resolution) return null;

  if (question.type === "poll") return <PollResult state={state} />;

  return (
    <div className="flex h-full flex-col gap-[2vmin]">
      <section className="glass-card h-[33%] shrink-0 overflow-hidden px-[3.5vmin] py-[2vmin]" aria-label="Richtige Antwort">
        {question.type === "estimate" ? <EstimateStrip state={state} /> : <ChoiceDistribution state={state} />}
      </section>
      <section className="min-h-0 flex-1" aria-label="Rangliste">
        <RankingTop rows={resolution.top} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Siegerbildschirm
// ---------------------------------------------------------------------------------------------------------

const PLACE_STYLES = [
  { height: "78%", color: "#e0a800", label: "1" },
  { height: "58%", color: "#9aa0a6", label: "2" },
  { height: "42%", color: "#b4713a", label: "3" },
] as const;

function PodiumPlace({ position, row, revealed }: { position: 1 | 2 | 3; row: FinalRow | null; revealed: boolean }) {
  const style = PLACE_STYLES[position - 1] ?? PLACE_STYLES[0];
  return (
    <div className="flex h-full w-[27%] flex-col items-center justify-end" aria-label={revealed && row ? `Platz ${row.rank}: ${row.name}` : `Platz ${position} noch verdeckt`}>
      {revealed && row ? (
        <div key={row.playerId} className="rise mb-[1.5vmin] flex flex-col items-center gap-[0.6vmin] text-center">
          <span className="text-[9vmin] leading-none" aria-hidden="true">{avatarEmoji(row.avatar)}</span>
          <span className="max-w-full truncate text-[4vmin] font-extrabold">{row.name}</span>
          <span className="text-[3.2vmin] font-bold tabular-nums">{formatNumber(row.points)} Punkte</span>
        </div>
      ) : (
        <div className="mb-[1.5vmin] text-[9vmin] leading-none opacity-30" aria-hidden="true">?</div>
      )}
      <div
        className="flex w-full items-start justify-center rounded-t-[2vmin] pt-[1.6vmin] text-[8vmin] leading-none font-extrabold text-white"
        style={{ height: style.height, background: revealed ? style.color : "rgba(0,0,0,0.12)", transition: "background 0.6s ease" }}
      >
        {revealed && row ? row.rank : style.label}
      </div>
    </div>
  );
}

export function ScreenPodium({ state }: { state: PublicGameState }) {
  const podium = state.podium;
  if (!podium) return null;
  const { size, revealed, places, ranking } = podium;
  // Eine Position ist enthüllt, sobald sie unter den zuletzt aufgedeckten Plätzen liegt. Die Liste places steht in der
  // Reihenfolge der Enthüllung (zuerst der unterste Platz).
  const rowFor = (position: number): FinalRow | null => (position > size - revealed ? (places[size - position] ?? null) : null);
  const rest = ranking ? ranking.slice(3, 10) : [];

  return (
    <div className="flex h-full flex-col gap-[2vmin]">
      <header className="text-center">
        <h1 className="screen-title">{ranking ? "Gratulation!" : "Das Ergebnis"}</h1>
        <p className="screen-small">{ranking ? "Die Siegerinnen und Sieger" : "Wer steht auf dem Podest?"}</p>
      </header>
      <div className="flex min-h-0 flex-1 gap-[3vmin]">
        <div className={`flex min-w-0 flex-1 items-end justify-center gap-[1.6vmin] ${rest.length > 0 ? "" : "px-[8vmin]"}`}>
          {size >= 2 ? <PodiumPlace position={2} row={rowFor(2)} revealed={revealed > size - 2} /> : null}
          <PodiumPlace position={1} row={rowFor(1)} revealed={revealed >= size && size > 0} />
          {size >= 3 ? <PodiumPlace position={3} row={rowFor(3)} revealed={revealed > size - 3} /> : null}
        </div>
        {rest.length > 0 ? (
          <aside className="glass-card rise w-[32%] shrink-0 self-center overflow-hidden p-[2.4vmin]" aria-label="Weitere Plätze">
            <ol className="flex flex-col justify-center gap-[1vmin]">
              {rest.map((row) => (
                <li key={row.playerId} className="flex items-center gap-[1.6vmin] text-[2.8vmin]">
                  <span className="w-[5vmin] text-center font-extrabold tabular-nums">{row.rank}</span>
                  <span aria-hidden="true">{avatarEmoji(row.avatar)}</span>
                  <span className="min-w-0 flex-1 truncate font-bold">{row.name}</span>
                  <span className="font-bold tabular-nums">{formatNumber(row.points)}</span>
                </li>
              ))}
            </ol>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export function ScreenFinished({ state }: { state: PublicGameState }) {
  const ranking = state.podium?.ranking ?? null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-[3vmin] text-center">
      <Logo className="h-[18vmin]" />
      <h1 className="screen-title">{ranking ? "Danke fürs Mitspielen!" : "Das Quiz wurde beendet"}</h1>
      {ranking ? (
        <ol className="glass-card w-[70%] space-y-[0.8vmin] p-[2.4vmin] text-left">
          {ranking.slice(0, 8).map((row) => (
            <li key={row.playerId} className="flex items-center gap-[2vmin] text-[3vmin]">
              <span className="w-[6vmin] text-center font-extrabold tabular-nums">{row.rank}</span>
              <span aria-hidden="true">{avatarEmoji(row.avatar)}</span>
              <span className="min-w-0 flex-1 truncate font-bold">{row.name}</span>
              <span className="font-bold tabular-nums">{formatNumber(row.points)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
