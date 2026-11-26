import type { Metadata } from "next";

export const metadata: Metadata = { title: "Beitreten" };

export default function JoinPage() {
  return (
    <section className="glass-card px-6 py-7">
      <h1 className="text-xl font-bold tracking-tight">Spiel beitreten</h1>
      <p className="text-ink-soft mt-2 text-sm">
        Der Beitritt mit Spielcode, Name und Icon wird in Meilenstein 4 freigeschaltet.
      </p>
    </section>
  );
}
