import type { AnswerShape } from "@/lib/design";

const PATHS: Record<AnswerShape, string> = {
  triangle: "M12 3 L22 20 L2 20 Z",
  diamond: "M12 2 L22 12 L12 22 L2 12 Z",
  circle: "M12 3 A9 9 0 1 1 11.99 3 Z",
  square: "M4 4 H20 V20 H4 Z",
};

/** Symbol eines Antwortslots. Übernimmt die Textfarbe der Umgebung. */
export default function AnswerSymbol({ shape, size = 28 }: { shape: AnswerShape; size?: number | string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={PATHS[shape]} />
    </svg>
  );
}
