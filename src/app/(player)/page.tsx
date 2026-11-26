import Logo from "@/components/Logo";
import CodeForm from "@/components/game/CodeForm";

export default function HomePage() {
  return (
    <section className="glass-card px-6 pt-7 pb-7">
      <Logo className="mx-auto h-24" />
      <h1 className="mt-4 text-center text-2xl font-bold tracking-tight">DOC Bern Quiz</h1>
      <p className="text-ink-soft mt-2 mb-6 text-center text-sm">
        Scannen Sie den QR Code auf dem Bildschirm oder geben Sie den Spielcode ein.
      </p>
      <CodeForm />
    </section>
  );
}
