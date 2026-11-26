"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useControls } from "@/components/game/Controls";
import Notice from "@/components/Notice";
import StatusPill from "@/components/StatusPill";
import { avatarEmoji } from "@/lib/game/avatars";
import { CLOSE_CODES } from "@/lib/realtime/protocol";
import { useGame, useRemainingMs } from "@/lib/realtime/useGame";
import { cancelGameAction, retrySaveAction } from "../actions";

type Props = {
  code: string;
  sessionId: string;
  quizTitle: string;
  dbStatus: "lobby" | "running" | "finished" | "cancelled";
  joinUrl: string;
  qr: string;
};

const PHASE_LABEL = {
  lobby: "Warteraum",
  question: "Frage läuft",
  resolved: "Auflösung",
  podium: "Siegerbildschirm",
  finished: "Beendet",
} as const;

export default function GameControl({ code, sessionId, quizTitle, dbStatus, joinUrl, qr }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  // Der Admin Browser meldet den Zeitablauf (es gibt keine Server Timer). Zusammen mit dem Beamer ist das doppelt gesichert.
  const game = useGame({ code, role: "admin", tickExtraDelayMs: 0, rotateAfterResolveMs: 2000 });
  const controls = useControls(game, { keys: false });
  const state = game.state;
  const phase = state?.phase;
  const remaining = useRemainingMs(state?.phase === "question" ? (state.question?.deadline ?? null) : null, game.serverNow);

  // Nach dem Ende der letzten Frage und nach einem Abbruch holt die Seite den Status der Datenbank neu.
  useEffect(() => {
    if (phase !== "podium" && phase !== "finished") return;
    const timer = setTimeout(() => router.refresh(), 1500);
    return () => clearTimeout(timer);
  }, [phase, router]);

  const gone = game.fatal?.code === CLOSE_CODES.GAME_NOT_FOUND;
  const isActive = dbStatus === "lobby" || dbStatus === "running";
  const needsSave = (phase === "podium" || phase === "finished") && dbStatus === "running";

  function cancelInDatabase() {
    if (!window.confirm("Die Durchführung abbrechen?")) return;
    startTransition(async () => {
      const result = await cancelGameAction(code);
      if (!result.ok) setMessage({ tone: "error", text: result.error });
      else router.refresh();
    });
  }

  function retrySave() {
    startTransition(async () => {
      const result = await retrySaveAction(code);
      setMessage(result.ok ? { tone: "info", text: "Die Resultate wurden gespeichert." } : { tone: "error", text: result.error });
      router.refresh();
    });
  }

  const question = state?.question;
  const action = controls.action;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{quizTitle}</h1>
        <StatusPill tone={state ? (phase === "finished" ? "neutral" : "ok") : "warn"}>
          {state && phase ? PHASE_LABEL[phase] : "Verbinden …"}
        </StatusPill>
        {game.status === "reconnecting" ? <StatusPill tone="warn">Verbindung wird wiederhergestellt</StatusPill> : null}
      </header>

      {gone && isActive ? (
        <Notice tone="warn">
          <p>Das Spiel ist in Redis nicht mehr vorhanden (Spiele verfallen 6 Stunden nach der letzten Änderung). Sie können die Durchführung abbrechen.</p>
          <button type="button" className="btn btn-secondary mt-3" onClick={cancelInDatabase} disabled={pending}>
            Durchführung abbrechen
          </button>
        </Notice>
      ) : null}
      {game.fatal && !gone ? <Notice tone="error">Keine Berechtigung für diese Verbindung. Bitte melden Sie sich neu an.</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <section className="glass-card space-y-4 p-6" aria-label="Steuerung">
            <h2 className="text-lg font-semibold">Steuerung</h2>
            {question && (phase === "question" || phase === "resolved") ? (
              <div className="space-y-1">
                <p className="text-ink-soft text-sm font-semibold">
                  Frage {question.index + 1} von {question.total}
                </p>
                <p className="text-lg font-semibold">{question.prompt}</p>
                {phase === "question" ? (
                  <p className="text-ink-soft text-sm tabular-nums">
                    Noch {remaining === null ? "–" : Math.ceil(remaining / 1000)} Sekunden, {game.answered} von {state?.players.length ?? 0} haben geantwortet.
                  </p>
                ) : null}
              </div>
            ) : null}
            {phase === "podium" && state?.podium ? (
              <p className="text-ink-soft text-sm">
                {state.podium.revealed} von {state.podium.size} Plätzen enthüllt.
              </p>
            ) : null}
            {phase === "lobby" ? (
              <p className="text-ink-soft text-sm">Teilnehmende scannen den QR Code und erscheinen unten. Starten Sie, sobald alle da sind.</p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              {action ? (
                <button type="button" className="btn btn-primary" disabled={controls.busy || action.disabled || game.status !== "open"} onClick={() => void controls.primary()}>
                  {action.label}
                </button>
              ) : phase === "finished" ? (
                <Link href={`/admin/results/${sessionId}`} className="btn btn-primary">
                  Resultate ansehen
                </Link>
              ) : null}
              {controls.abortable ? (
                <button type="button" className="btn btn-secondary" disabled={controls.busy} onClick={() => void controls.abort()}>
                  Abbrechen
                </button>
              ) : null}
              <a href={`/screen/${code}`} target="_blank" rel="noreferrer" className="btn btn-secondary">
                Beamer Ansicht öffnen
              </a>
            </div>
            {action ? (
              <p className="text-ink-soft text-sm">{action.disabled && action.disabledReason ? action.disabledReason : action.hint}</p>
            ) : null}
            {controls.error ? <Notice tone="error">{controls.error}</Notice> : null}
          </section>

          {needsSave ? (
            <Notice tone="warn">
              <p>Die Resultate sind noch nicht in der Datenbank gespeichert. Das geschieht automatisch, bei einem Fehler können Sie es hier wiederholen.</p>
              <button type="button" className="btn btn-secondary mt-3" onClick={retrySave} disabled={pending}>
                Resultate erneut speichern
              </button>
            </Notice>
          ) : null}
          {(phase === "podium" || phase === "finished") && dbStatus === "finished" ? (
            <Notice tone="info">
              Die Resultate sind gespeichert.{" "}
              <Link href={`/admin/results/${sessionId}`} className="font-semibold underline">
                Zu den Resultaten
              </Link>
            </Notice>
          ) : null}

          <section className="glass-card space-y-3 p-6" aria-label="Teilnehmende">
            <h2 className="text-lg font-semibold">Teilnehmende ({state?.players.length ?? 0})</h2>
            {state && state.players.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {state.players.map((player) => (
                  <li key={player.id} className="tag bg-black/5 text-sm">
                    <span aria-hidden="true" className="mr-1.5">
                      {avatarEmoji(player.avatar)}
                    </span>
                    {player.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-soft text-sm">Noch niemand beigetreten.</p>
            )}
          </section>
        </div>

        <aside className="glass-card h-fit space-y-3 p-6 text-center" aria-label="Beitritt">
          <h2 className="text-lg font-semibold">Beitritt</h2>
          {phase === "lobby" || !state ? (
            <div
              className="mx-auto aspect-square w-full max-w-[260px] overflow-hidden rounded-2xl bg-white p-2"
              role="img"
              aria-label={`QR Code zum Beitreten: ${joinUrl}`}
              // Der SVG Text stammt vom Server aus unserer eigenen Beitrittsadresse.
              dangerouslySetInnerHTML={{ __html: qr }}
            />
          ) : (
            <p className="text-ink-soft text-sm">Das Quiz hat begonnen, ein Beitritt ist nicht mehr möglich.</p>
          )}
          <p className="text-accent text-4xl font-extrabold tracking-widest tabular-nums">
            {code.slice(0, 3)} {code.slice(3)}
          </p>
          <p className="text-ink-soft text-xs break-all">{joinUrl}</p>
        </aside>
      </div>
    </div>
  );
}
