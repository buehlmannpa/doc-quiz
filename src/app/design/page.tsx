import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AnswerSymbol from "@/components/AnswerSymbol";
import Logo from "@/components/Logo";
import { ANSWER_SLOTS } from "@/lib/design";
import { resolveDeploymentEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Design" };

/**
 * Entwicklungsseite: zeigt Farben, Bedienelemente und Muster der drei Ansichten nebeneinander.
 * In der Produktion gibt es diese Seite nicht.
 */
export default function DesignPage() {
  if (resolveDeploymentEnv(process.env) === "production") notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 py-8">
      <header className="flex items-center gap-4">
        <Logo className="h-16" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Design Vorschau</h1>
          <p className="text-ink-soft text-sm">Nur ausserhalb der Produktion sichtbar.</p>
        </div>
      </header>

      <Section title="Farben">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Swatch name="Ducati Rot" value="#e30613" textColor="#ffffff" />
          <Swatch name="Text" value="#1d1d1f" textColor="#ffffff" />
          <Swatch name="Seitengrund" value="#f5f5f7" textColor="#1d1d1f" bordered />
          <Swatch name="Fläche" value="#ffffff" textColor="#1d1d1f" bordered />
        </div>
      </Section>

      <Section title="Antwortbuttons (Spieler)">
        <div className="mx-auto grid max-w-md grid-cols-1 gap-3">
          {ANSWER_SLOTS.map((slot, i) => (
            <button
              key={slot.index}
              type="button"
              className="answer-btn"
              style={{ background: slot.background, color: slot.foreground }}
              aria-label={`Antwort ${i + 1}, ${slot.label}`}
            >
              <AnswerSymbol shape={slot.shape} />
              <span>Antwort {i + 1}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Knöpfe und Eingabe">
        <div className="glass-card flex max-w-md flex-col gap-3 p-5">
          <input className="field" placeholder="Spielname" inputMode="text" aria-label="Spielname" />
          <button type="button" className="btn btn-primary">
            Los
          </button>
          <button type="button" className="btn btn-secondary">
            Abbrechen
          </button>
          <div className="flex gap-2">
            <span className="tag" style={{ background: "rgba(227,6,19,0.12)", color: "#e30613" }}>
              Bereit
            </span>
            <span className="tag bg-black/5 text-ink-soft">Entwurf</span>
          </div>
        </div>
      </Section>

      <Section title="Bubbles im Warteraum (Beispiel)">
        <div className="glass-card flex flex-wrap items-end justify-center gap-6 p-6">
          <Bubble icon="🏍️" name="Patrick" size={96} />
          <Bubble icon="🏁" name="Luca" size={72} />
          <Bubble icon="🏆" name="Sandra" size={84} />
          <Bubble icon="⚡" name="Marco" size={64} />
          <Bubble icon="🔥" name="Nina" size={78} />
        </div>
      </Section>

      <Section title="Rangliste (Beispiel)">
        <div className="glass-card divide-y divide-black/5 overflow-hidden">
          <RankRow rank={1} icon="🏍️" name="Patrick" gained={920} delta={2} total={2650} />
          <RankRow rank={2} icon="🏁" name="Luca" gained={870} delta={-1} total={2540} />
          <RankRow rank={3} icon="🏆" name="Sandra" gained={0} delta={0} total={2310} />
          <RankRow rank={4} icon="🔥" name="Nina" gained={640} delta={1} total={2105} />
          <RankRow rank={5} icon="⚡" name="Marco" gained={0} delta={-2} total={1980} />
        </div>
      </Section>

      <Section title="Beamer: Auflösung (oben 1/3 Antwort, unten 2/3 Rangliste)">
        <div className="bg-canvas relative aspect-video w-full overflow-hidden rounded-2xl border border-black/10">
          <div className="flex h-1/3 items-center justify-center gap-6 border-b border-black/10 bg-white px-8">
            <span
              className="grid h-14 w-14 place-items-center rounded-xl"
              style={{ background: ANSWER_SLOTS[1].background, color: ANSWER_SLOTS[1].foreground }}
            >
              <AnswerSymbol shape="diamond" size={32} />
            </span>
            <div>
              <p className="text-ink-soft text-xs">Richtige Antwort</p>
              <p className="text-2xl font-extrabold">Monster</p>
            </div>
          </div>
          <div className="h-2/3 space-y-1.5 px-8 py-4">
            {[
              ["1", "🏍️", "Patrick", "+920", "2650"],
              ["2", "🏁", "Luca", "+870", "2540"],
              ["3", "🏆", "Sandra", "+0", "2310"],
            ].map(([rank, icon, name, gained, total]) => (
              <div key={rank} className="flex items-center gap-4 rounded-xl bg-white px-4 py-2">
                <span className="w-6 text-lg font-extrabold">{rank}</span>
                <span className="text-xl">{icon}</span>
                <span className="flex-1 text-base font-bold">{name}</span>
                <span className="text-ink-soft text-sm">{gained}</span>
                <span className="text-base font-extrabold">{total}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ name, value, textColor, bordered = false }: { name: string; value: string; textColor: string; bordered?: boolean }) {
  return (
    <div
      className="flex h-24 flex-col justify-end rounded-2xl p-3"
      style={{ background: value, color: textColor, border: bordered ? "1px solid rgba(0,0,0,0.1)" : undefined }}
    >
      <span className="text-sm font-semibold">{name}</span>
      <span className="text-xs opacity-80">{value}</span>
    </div>
  );
}

/** Bubble in Glasoptik ohne Weichzeichner, damit auch 60 Stück flüssig laufen. */
function Bubble({ icon, name, size }: { icon: string; name: string; size: number }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className="grid place-items-center rounded-full"
        style={{
          width: size,
          height: size,
          fontSize: size * 0.45,
          background:
            "radial-gradient(circle at 30% 25%, #ffffff 0%, rgba(255,255,255,0.9) 35%, rgba(227,6,19,0.12) 100%)",
          boxShadow: "inset 0 0 0 3px rgba(227,6,19,0.85), 0 6px 18px rgba(0,0,0,0.10)",
        }}
        aria-hidden="true"
      >
        {icon}
      </div>
      <span className="text-sm font-semibold">{name}</span>
    </div>
  );
}

function RankRow({
  rank,
  icon,
  name,
  gained,
  delta,
  total,
}: {
  rank: number;
  icon: string;
  name: string;
  gained: number;
  delta: number;
  total: number;
}) {
  const movement = delta > 0 ? `▲ ${delta}` : delta < 0 ? `▼ ${Math.abs(delta)}` : "gleich";
  const movementColor = delta > 0 ? "#1f8a3b" : delta < 0 ? "#e30613" : "var(--color-ink-soft)";
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="w-6 text-lg font-extrabold">{rank}</span>
      <span className="text-2xl" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1 font-semibold">{name}</span>
      <span className="text-ink-soft text-sm">+{gained}</span>
      <span className="w-14 text-right text-sm font-semibold" style={{ color: movementColor }}>
        {movement}
      </span>
      <span className="w-16 text-right text-lg font-extrabold">{total}</span>
    </div>
  );
}
