type Tone = "ok" | "error" | "neutral" | "warn";

const STYLES: Record<Tone, { background: string; color: string }> = {
  ok: { background: "rgba(52, 199, 89, 0.15)", color: "#18772f" },
  error: { background: "rgba(227, 6, 19, 0.12)", color: "#c40511" },
  warn: { background: "rgba(255, 149, 0, 0.18)", color: "#8a4b00" },
  neutral: { background: "rgba(0, 0, 0, 0.06)", color: "#6e6e73" },
};

/** Kleine Pille für Zustände. Die Farbe ist nie das einzige Merkmal, der Text sagt es ebenfalls. */
export default function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className="tag" style={STYLES[tone]}>
      {children}
    </span>
  );
}
