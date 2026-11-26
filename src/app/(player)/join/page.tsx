import type { Metadata } from "next";
import CodeForm from "@/components/game/CodeForm";

export const metadata: Metadata = { title: "Beitreten" };

export default function JoinPage() {
  return (
    <section className="glass-card px-6 py-7">
      <h1 className="mb-1 text-xl font-bold tracking-tight">Spiel beitreten</h1>
      <p className="text-ink-soft mb-5 text-sm">Geben Sie den Spielcode vom Bildschirm ein.</p>
      <CodeForm />
    </section>
  );
}
