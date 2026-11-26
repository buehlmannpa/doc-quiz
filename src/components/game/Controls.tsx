"use client";

/**
 * Steuerung des Quiz für den Admin, gemeinsam für das Adminportal und die Steuerleiste der Beamer Ansicht.
 * Jeder Klick trägt die Version der Ansicht, auf der geklickt wurde. Ein doppelter Klick oder gleichzeitige
 * Bedienung von Portal und Beamer überspringt so keine Phase, der Server lehnt den zweiten Befehl ab.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { canAbort, nextAdminAction, type AdminAction } from "@/lib/game/nextAction";
import type { Command } from "@/lib/realtime/protocol";
import type { UseGame } from "@/lib/realtime/useGame";

const ERRORS: Record<string, string> = {
  stale: "Die Ansicht war nicht mehr aktuell. Bitte noch einmal klicken.",
  wrong_phase: "Das ist im Moment nicht möglich.",
  no_players: "Es ist noch niemand beigetreten.",
  too_early: "Die Zeit ist noch nicht abgelaufen.",
  forbidden: "Dafür fehlt die Berechtigung. Bitte melden Sie sich im Adminportal an.",
  offline: "Keine Verbindung zum Server.",
  timeout: "Keine Antwort vom Server.",
  disconnected: "Die Verbindung wurde unterbrochen. Bitte noch einmal klicken.",
  server_error: "Der Server hat Probleme.",
  no_quiz: "Zu diesem Spiel gehört kein Quiz.",
};

export type Controls = {
  action: AdminAction | null;
  busy: boolean;
  error: string | null;
  abortable: boolean;
  run: (command: Command) => Promise<void>;
  primary: () => Promise<void>;
  abort: () => Promise<void>;
};

export function useControls(game: UseGame, options: { keys: boolean }): Controls {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const state = game.state;
  const action = nextAdminAction(state);
  const abortable = canAbort(state);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (command: Command) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const result = await game.command(command);
      busyRef.current = false;
      setBusy(false);
      if (!result.ok) {
        setError(ERRORS[result.error] ?? "Der Befehl konnte nicht ausgeführt werden.");
        if (errorTimer.current) clearTimeout(errorTimer.current);
        errorTimer.current = setTimeout(() => setError(null), 5000);
      }
    },
    [game],
  );

  const primary = useCallback(async () => {
    if (!action || action.disabled) return;
    await run(action.command);
  }, [action, run]);

  const abort = useCallback(async () => {
    if (!abortable) return;
    if (!window.confirm("Das Quiz wirklich abbrechen? Es werden keine Resultate gespeichert.")) return;
    await run("abort");
  }, [abortable, run]);

  useEffect(() => () => void (errorTimer.current && clearTimeout(errorTimer.current)), []);

  useEffect(() => {
    if (!options.keys) return;
    const onKey = (event: KeyboardEvent) => {
      // Tasten in Eingabefeldern gehören dem Feld.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === " " || event.key === "ArrowRight") {
        event.preventDefault();
        if (!event.repeat) void primary();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options.keys, primary]);

  return { action, busy, error, abortable, run, primary, abort };
}
