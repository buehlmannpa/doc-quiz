"use client";

import { useEffect, useRef, useState } from "react";
import Logo from "@/components/Logo";
import type { BubbleCanvasHandle } from "@/components/game/BubbleCanvas";
import { useControls } from "@/components/game/Controls";
import { ScreenFinished, ScreenLobby, ScreenPodium, ScreenQuestion, ScreenResolved } from "@/components/game/ScreenViews";
import { CLOSE_CODES } from "@/lib/realtime/protocol";
import { useGame } from "@/lib/realtime/useGame";

type Props = { code: string; isAdmin: boolean; joinUrl: string; qr: string };

/** Konfetti beim Enthüllen von Platz 1. Nur wenn die Bewegungsreduktion nicht gewünscht ist. */
async function fireConfetti(): Promise<void> {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const { default: confetti } = await import("canvas-confetti");
  const burst = (originX: number, angle: number) =>
    confetti({ particleCount: 90, spread: 70, angle, origin: { x: originX, y: 0.75 }, colors: ["#e30613", "#ffffff", "#1d1d1f", "#ffd60a"] });
  burst(0.1, 60);
  burst(0.9, 120);
  setTimeout(() => confetti({ particleCount: 140, spread: 120, startVelocity: 45, origin: { x: 0.5, y: 0.5 }, colors: ["#e30613", "#ffffff", "#ffd60a"] }), 350);
}

export default function ScreenClient({ code, isAdmin, joinUrl, qr }: Props) {
  const bubbles = useRef<BubbleCanvasHandle>(null);
  const game = useGame({
    code,
    role: isAdmin ? "admin" : "screen",
    keepAwake: true,
    // Der Beamer meldet den Zeitablauf als Erster, die Smartphones sind nur die Absicherung.
    tickExtraDelayMs: 0,
    rotateAfterResolveMs: 1500,
    onNudge: (playerId) => bubbles.current?.nudge(playerId),
  });
  const controls = useControls(game, { keys: isAdmin });
  const [barVisible, setBarVisible] = useState(true);

  const state = game.state;
  const revealed = state?.podium?.revealed ?? null;
  const size = state?.podium?.size ?? 0;
  const previousRevealed = useRef<number | null>(null);

  // Konfetti nur in dem Moment, in dem Platz 1 enthüllt wird, nicht beim Neuaufbau der Verbindung.
  useEffect(() => {
    const before = previousRevealed.current;
    previousRevealed.current = revealed;
    if (before !== null && revealed !== null && size > 0 && before < size && revealed >= size) void fireConfetti();
  }, [revealed, size]);

  // Taste H blendet die Steuerleiste ein und aus.
  useEffect(() => {
    if (!isAdmin) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "h" && !event.metaKey && !event.ctrlKey && !event.altKey) setBarVisible((visible) => !visible);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isAdmin]);

  let body: React.ReactNode;
  if (game.fatal) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-[2vmin] text-center">
        <Logo className="h-[16vmin]" />
        <h1 className="screen-title">{game.fatal.code === CLOSE_CODES.GAME_NOT_FOUND ? "Spiel nicht gefunden" : "Kein Zugriff"}</h1>
        <p className="screen-small">Spielcode {code}</p>
      </div>
    );
  } else if (!state) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-[2vmin] text-center">
        <Logo className="h-[16vmin]" />
        <h1 className="screen-title">DOC Bern Quiz</h1>
        <p className="screen-small">Verbindung wird aufgebaut …</p>
      </div>
    );
  } else {
    switch (state.phase) {
      case "lobby":
        body = <ScreenLobby ref={bubbles} state={state} joinUrl={joinUrl} qr={qr} />;
        break;
      case "question":
        body = <ScreenQuestion key={state.question?.index} state={state} answered={game.answered} serverNow={game.serverNow} />;
        break;
      case "resolved":
        body = <ScreenResolved state={state} />;
        break;
      case "podium":
        body = <ScreenPodium state={state} />;
        break;
      case "finished":
        body = <ScreenFinished state={state} />;
        break;
    }
  }

  const action = controls.action;
  return (
    <div className="screen-root relative p-[3vmin]">
      <div className="h-full">{body}</div>

      {game.status === "reconnecting" && state ? (
        <p className="absolute top-[1.5vmin] right-[2vmin] rounded-full bg-[rgba(255,149,0,0.9)] px-[2vmin] py-[0.6vmin] text-[1.8vmin] font-semibold" role="status">
          Verbindung wird wiederhergestellt …
        </p>
      ) : null}

      {isAdmin ? (
        barVisible ? (
          <div
            className="glass-strong absolute right-[2vmin] bottom-[2vmin] left-[2vmin] z-20 flex flex-wrap items-center gap-[1.6vmin] rounded-[2vmin] px-[2.4vmin] py-[1.4vmin] text-[1.9vmin]"
            role="toolbar"
            aria-label="Steuerung"
          >
            <span className="font-semibold">Steuerung</span>
            {action ? (
              <button type="button" className="btn btn-primary !min-h-[5vmin] !text-[2vmin]" disabled={controls.busy || action.disabled} onClick={() => void controls.primary()}>
                {action.label}
              </button>
            ) : (
              <span className="text-ink-soft">Das Quiz ist beendet.</span>
            )}
            {action?.disabledReason ? <span className="text-ink-soft">{action.disabledReason}</span> : null}
            {controls.abortable ? (
              <button type="button" className="btn btn-secondary !min-h-[5vmin] !text-[2vmin]" disabled={controls.busy} onClick={() => void controls.abort()}>
                Abbrechen
              </button>
            ) : null}
            {controls.error ? (
              <span role="alert" className="font-semibold text-[#a50410]">
                {controls.error}
              </span>
            ) : null}
            <span className="text-ink-soft ml-auto hidden md:inline">Leertaste oder Pfeil rechts: weiter, H: ausblenden</span>
            <button type="button" className="btn btn-secondary !min-h-[5vmin] !text-[2vmin]" onClick={() => setBarVisible(false)} aria-label="Steuerleiste ausblenden">
              Ausblenden
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="absolute right-[2vmin] bottom-[2vmin] z-20 rounded-full bg-black/5 px-[1.6vmin] py-[0.8vmin] text-[1.6vmin] opacity-30 transition-opacity hover:opacity-100 focus-visible:opacity-100"
            onClick={() => setBarVisible(true)}
          >
            Steuerung einblenden (H)
          </button>
        )
      ) : null}
    </div>
  );
}
