/**
 * Gemeinsame Gestaltungswerte für Spieler, Beamer und Admin.
 * Die Farben sind auch in globals.css als Variablen hinterlegt.
 */

export type AnswerShape = "triangle" | "diamond" | "circle" | "square";

export type AnswerSlot = {
  /** Position der Antwortoption (0 bis 3). */
  index: 0 | 1 | 2 | 3;
  shape: AnswerShape;
  /** Füllfarbe des Buttons. */
  background: string;
  /** Schriftfarbe mit ausreichendem Kontrast zur Füllfarbe. */
  foreground: string;
  /** Name für Screenreader. */
  label: string;
};

/**
 * Vier Antwortslots. Jeder hat Farbe und Symbol, damit die Antworten auch bei Farbschwäche
 * unterscheidbar sind. Kontraste: Weiss auf Rot 4.9, Weiss auf Blau 4.0 (grosse Schrift),
 * dunkle Schrift auf Orange 7.7 und auf Grün 7.6.
 */
export const ANSWER_SLOTS: readonly [AnswerSlot, AnswerSlot, AnswerSlot, AnswerSlot] = [
  { index: 0, shape: "triangle", background: "#e30613", foreground: "#ffffff", label: "Rot, Dreieck" },
  { index: 1, shape: "diamond", background: "#007aff", foreground: "#ffffff", label: "Blau, Raute" },
  { index: 2, shape: "circle", background: "#ff9500", foreground: "#1d1d1f", label: "Orange, Kreis" },
  { index: 3, shape: "square", background: "#34c759", foreground: "#1d1d1f", label: "Grün, Quadrat" },
];
