import type { Metadata } from "next";

export const metadata: Metadata = { title: "Adminportal" };

export default function AdminHomePage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Adminportal</h1>
        <p className="text-ink-soft mt-1 text-sm">Hier entsteht die Verwaltung der Quizzes und die Spielsteuerung.</p>
      </header>

      <section className="glass-card p-6">
        <h2 className="text-lg font-semibold">Stand</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li>Meilenstein 1: Projektgerüst, Datenbankschema, Verbindungstests (in Arbeit).</li>
          <li>Meilenstein 2: Login und Quizverwaltung (folgt).</li>
        </ul>
        <p className="text-ink-soft mt-4 text-sm">
          Systemstatus für Neon, Redis und Region: <code className="rounded bg-black/5 px-1.5 py-0.5">/api/health</code>
        </p>
      </section>
    </div>
  );
}
