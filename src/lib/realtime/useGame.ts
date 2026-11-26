"use client";

/**
 * React Hook für die Echtzeit Verbindung eines Geräts mit einem Spiel. Gemeinsam für Smartphone, Beamer und Admin.
 *
 * Der Hook baut den RealtimeClient auf, hält Zustand und Status für React bereit und sorgt dafür, dass die
 * Verbindung den Alltag eines Smartphones übersteht:
 * 1. Wird die Seite wieder sichtbar (Bildschirmsperre, App Wechsel), prüft er mit einem Ping, ob die Verbindung noch lebt.
 * 2. Kommt das Netz zurück, prüft er ebenfalls.
 * 3. Wo der Browser es kann, hält er den Bildschirm während des Spiels wach (Wake Lock).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeClient, type AckResult, type ClientStatus, type SocketLike } from "./client";
import type { PublicGameState } from "./game-state";
import type { Command, Role } from "./protocol";
import { websocketUrl } from "./url";

export type MineAnswer = { q: number; option?: number; value?: number };

export type UseGameOptions = {
  code: string;
  role: Role;
  token?: string;
  /** Bei false wird nichts aufgebaut (zum Beispiel solange das Token noch aus dem Browser geladen wird). */
  enabled?: boolean;
  /** Bildschirm wach halten, nur sinnvoll für Smartphones und Beamer. */
  keepAwake?: boolean;
  /** Wartezeit nach Ablauf der Frist, bevor dieses Gerät den Zeithinweis sendet. Beamer und Admin 0, Smartphones mehr. */
  tickExtraDelayMs?: number | null;
  rotateAfterResolveMs?: number;
  onNudge?: (playerId: string) => void;
};

export type GameFatal = { code: number; message: string };

export type UseGame = {
  state: PublicGameState | null;
  status: ClientStatus;
  fatal: GameFatal | null;
  /** Zahl der Antworten auf die aktuelle Frage (nur Beamer und Admin). */
  answered: number;
  /** Die eigene Antwort auf die aktuelle Frage. */
  mine: MineAnswer | null;
  answer: (payload: { option: number } | { value: number }) => Promise<AckResult>;
  command: (command: Command) => Promise<AckResult>;
  nudge: () => void;
  /** Serverzeit in Millisekunden für Countdowns. */
  serverNow: () => number;
};

function createSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export function useGame(options: UseGameOptions): UseGame {
  const { code, role, token, enabled = true, keepAwake = false, tickExtraDelayMs = null, rotateAfterResolveMs } = options;
  const [state, setState] = useState<PublicGameState | null>(null);
  const [status, setStatus] = useState<ClientStatus>("idle");
  const [fatal, setFatal] = useState<GameFatal | null>(null);
  const [progress, setProgress] = useState<{ q: number; n: number } | null>(null);
  const [mineAnswer, setMineAnswer] = useState<MineAnswer | null>(null);
  const clientRef = useRef<RealtimeClient | null>(null);
  const stateRef = useRef<PublicGameState | null>(null);
  const nudgeRef = useRef(options.onNudge);
  // Die neueste Funktion merken, ohne die Verbindung bei jedem Aufbau der Seite neu zu öffnen.
  useEffect(() => {
    nudgeRef.current = options.onNudge;
  });

  useEffect(() => {
    if (!enabled) return;
    const client = new RealtimeClient({
      url: () => {
        return websocketUrl();
      },
      role,
      code,
      ...(token ? { token } : {}),
      createSocket,
      onState: (next) => {
        stateRef.current = next;
        setState(next);
      },
      onStatus: (next) => {
        setStatus(next);
        // Ein neuer Verbindungsaufbau hebt einen früheren endgültigen Fehler auf.
        if (next === "connecting") setFatal(null);
      },
      onEvent: (event) => {
        if (event.type === "fatal") setFatal({ code: event.code, message: event.message });
      },
      onProgress: setProgress,
      onMine: setMineAnswer,
      onNudge: (playerId) => nudgeRef.current?.(playerId),
      autoTick: tickExtraDelayMs === null ? false : { extraDelayMs: tickExtraDelayMs },
      ...(rotateAfterResolveMs !== undefined ? { rotateAfterResolveMs } : {}),
    });
    clientRef.current = client;
    client.start();

    // Nach Bildschirmsperre, App Wechsel oder Netzwechsel ist die Verbindung oft halb tot. Ein Ping klärt das.
    const check = () => {
      if (document.visibilityState === "visible") client.checkAlive();
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    window.addEventListener("pageshow", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      window.removeEventListener("pageshow", check);
      client.stop();
      clientRef.current = null;
    };
  }, [code, role, token, enabled, tickExtraDelayMs, rotateAfterResolveMs]);

  // Bildschirm wach halten, solange die Seite sichtbar ist. Der Browser gibt die Sperre beim Verbergen selbst frei.
  useEffect(() => {
    if (!keepAwake || !enabled) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) void lock.release();
        else sentinel = lock;
      } catch {
        // Nicht jeder Browser erlaubt es. Das Spiel läuft auch ohne.
      }
    };
    void request();
    const onVisible = () => void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [keepAwake, enabled]);

  const answer = useCallback(async (payload: { option: number } | { value: number }): Promise<AckResult> => {
    const client = clientRef.current;
    const current = stateRef.current;
    if (!client || !current?.question) return { ok: false, error: "offline" };
    const q = current.question.index;
    const result = await client.answer(q, payload);
    if (result.ok) setMineAnswer({ q, ...payload });
    return result;
  }, []);

  const command = useCallback(async (cmd: Command): Promise<AckResult> => {
    const client = clientRef.current;
    if (!client) return { ok: false, error: "offline" };
    // Die erwartete Version ist die der Ansicht, auf der geklickt wurde: Ein doppelter Klick überspringt nichts.
    return client.command(cmd, stateRef.current?.version);
  }, []);

  const nudge = useCallback(() => clientRef.current?.nudge(), []);
  const serverNow = useCallback(() => clientRef.current?.serverNow() ?? Date.now(), []);

  const questionIndex = state?.question?.index;
  return {
    state,
    status,
    fatal,
    answered: progress !== null && progress.q === questionIndex ? progress.n : 0,
    mine: mineAnswer !== null && mineAnswer.q === questionIndex ? mineAnswer : null,
    answer,
    command,
    nudge,
    serverNow,
  };
}

/**
 * Verbleibende Zeit bis zu einem Zeitpunkt in Serverzeit, in Millisekunden. Aktualisiert sich regelmässig.
 * Ohne Zeitpunkt ist der Wert null.
 */
export function useRemainingMs(deadline: number | null, serverNow: () => number, intervalMs = 100): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (deadline === null) return;
    const update = () => setRemaining(Math.max(0, deadline - serverNow()));
    update();
    const timer = setInterval(update, intervalMs);
    return () => clearInterval(timer);
  }, [deadline, serverNow, intervalMs]);
  return deadline === null ? null : remaining;
}
