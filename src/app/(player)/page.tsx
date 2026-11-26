import Link from "next/link";
import Logo from "@/components/Logo";

export default function HomePage() {
  return (
    <section className="glass-card px-6 pt-7 pb-7 text-center">
      <Logo className="mx-auto h-28" />
      <h1 className="mt-4 text-2xl font-bold tracking-tight">DOC Bern Quiz</h1>
      <p className="text-ink-soft mt-2 text-sm">
        Scanne den QR Code auf dem Bildschirm oder gib den Spielcode ein.
      </p>
      <Link href="/join" className="btn btn-primary mt-6 w-full">
        Spiel beitreten
      </Link>
    </section>
  );
}
