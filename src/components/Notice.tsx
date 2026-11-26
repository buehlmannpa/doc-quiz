type Tone = "error" | "info" | "warn";

const STYLES: Record<Tone, { background: string; color: string; border: string }> = {
  error: { background: "rgba(227, 6, 19, 0.07)", color: "#a50410", border: "rgba(227, 6, 19, 0.25)" },
  warn: { background: "rgba(255, 149, 0, 0.12)", color: "#7a4300", border: "rgba(255, 149, 0, 0.35)" },
  info: { background: "rgba(0, 0, 0, 0.04)", color: "#1d1d1f", border: "rgba(0, 0, 0, 0.08)" },
};

/** Hinweisfeld. Fehler werden als Alarm angekündigt, damit Screenreader sie vorlesen. */
export default function Notice({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const style = STYLES[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="rounded-2xl px-4 py-3 text-sm"
      style={{ background: style.background, color: style.color, border: `1px solid ${style.border}` }}
    >
      {children}
    </div>
  );
}
