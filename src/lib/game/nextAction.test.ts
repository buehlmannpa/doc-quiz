import { describe, expect, it } from "vitest";
import { createInitialState, type PublicGameState } from "@/lib/realtime/game-state";
import { AVATARS } from "./avatars";
import { canAbort, nextAdminAction } from "./nextAction";

const lobby = createInitialState("123456", 1);
const withPlayer: PublicGameState = { ...lobby, players: [{ id: "a", name: "Anna", avatar: 1 }] };

describe("nächste Aktion des Admins", () => {
  it("verlangt im Warteraum mindestens einen Spieler", () => {
    expect(nextAdminAction(lobby)).toMatchObject({ command: "start", disabled: true });
    expect(nextAdminAction(withPlayer)).toMatchObject({ command: "start", disabled: false });
  });

  it("beendet die Frage, startet die nächste und beschriftet sie mit der Nummer", () => {
    const question = { index: 0, total: 3 } as NonNullable<PublicGameState["question"]>;
    expect(nextAdminAction({ ...withPlayer, phase: "question", question })).toMatchObject({ command: "resolve" });
    expect(nextAdminAction({ ...withPlayer, phase: "resolved", question })).toMatchObject({ command: "next", label: "Frage 2 starten" });
  });

  it("enthüllt von Platz 3 bis Platz 1 und beendet danach", () => {
    const base = { ...withPlayer, phase: "podium" as const };
    const podium = (revealed: number) => ({ size: 3, revealed, places: [], ranking: null });
    expect(nextAdminAction({ ...base, podium: podium(0) })).toMatchObject({ command: "reveal", label: "Platz 3 enthüllen" });
    expect(nextAdminAction({ ...base, podium: podium(1) })).toMatchObject({ label: "Platz 2 enthüllen" });
    expect(nextAdminAction({ ...base, podium: podium(2) })).toMatchObject({ label: "Platz 1 enthüllen", hint: "Mit Konfetti." });
    expect(nextAdminAction({ ...base, podium: podium(3) })).toMatchObject({ command: "finish" });
  });

  it("bietet am Ende nichts mehr an und erlaubt den Abbruch nur davor", () => {
    expect(nextAdminAction({ ...withPlayer, phase: "finished" })).toBeNull();
    expect(nextAdminAction(null)).toBeNull();
    expect(canAbort(lobby)).toBe(true);
    expect(canAbort({ ...lobby, phase: "question" })).toBe(true);
    expect(canAbort({ ...lobby, phase: "podium" })).toBe(false);
    expect(canAbort({ ...lobby, phase: "finished" })).toBe(false);
    expect(canAbort(null)).toBe(false);
  });
});

describe("Icons", () => {
  it("gibt es genau 64 verschiedene", () => {
    expect(AVATARS).toHaveLength(64);
    expect(new Set(AVATARS).size).toBe(64);
  });
});
