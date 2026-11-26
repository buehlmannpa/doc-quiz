/**
 * Die nächste sinnvolle Aktion des Admins in der aktuellen Phase. Portal und Beamer Steuerleiste zeigen dieselbe
 * Aktion, und die Tasten (Leertaste, Pfeil rechts) lösen sie aus.
 */
import type { PublicGameState } from "@/lib/realtime/game-state";
import type { Command } from "@/lib/realtime/protocol";

export type AdminAction = {
  command: Command;
  label: string;
  /** Kurze Erklärung unter dem Knopf. */
  hint: string;
  disabled: boolean;
  disabledReason?: string;
};

export function nextAdminAction(state: PublicGameState | null): AdminAction | null {
  if (!state) return null;
  switch (state.phase) {
    case "lobby":
      return state.players.length === 0
        ? {
            command: "start",
            label: "Quiz starten",
            hint: "Der QR Code verschwindet, danach ist kein Beitritt mehr möglich.",
            disabled: true,
            disabledReason: "Es ist noch niemand beigetreten.",
          }
        : {
            command: "start",
            label: "Quiz starten",
            hint: "Der QR Code verschwindet, danach ist kein Beitritt mehr möglich.",
            disabled: false,
          };
    case "question":
      return {
        command: "resolve",
        label: "Frage jetzt beenden",
        hint: "Sonst endet die Frage von selbst, sobald alle geantwortet haben oder die Zeit abgelaufen ist.",
        disabled: false,
      };
    case "resolved": {
      const number = (state.question?.index ?? 0) + 2;
      return { command: "next", label: `Frage ${number} starten`, hint: "Zeigt die nächste Frage auf allen Geräten.", disabled: false };
    }
    case "podium": {
      const podium = state.podium;
      if (!podium) return null;
      if (podium.revealed < podium.size) {
        const place = podium.size - podium.revealed;
        return {
          command: "reveal",
          label: `Platz ${place} enthüllen`,
          hint: place === 1 ? "Mit Konfetti." : "Die Enthüllung läuft von unten nach oben.",
          disabled: false,
        };
      }
      return { command: "finish", label: "Quiz beenden", hint: "Schliesst die Durchführung ab.", disabled: false };
    }
    case "finished":
      return null;
  }
}

/** Ob in dieser Phase ein Abbruch möglich ist. Mit Siegerbildschirm sind die Resultate schon gespeichert. */
export function canAbort(state: PublicGameState | null): boolean {
  return state !== null && (state.phase === "lobby" || state.phase === "question" || state.phase === "resolved");
}
