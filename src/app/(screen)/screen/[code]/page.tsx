import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Logo from "@/components/Logo";

export const metadata: Metadata = { title: "Bildschirm" };

/**
 * Beamer Ansicht. Vollbild, sehr grosse Schrift, kein Scrollen.
 * Warteraum mit QR Code und Bubbles folgt in Meilenstein 4.
 */
export default async function ScreenPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // Der Spielcode ist immer sechsstellig. Alles andere ist eine ungültige Adresse.
  if (!/^\d{6}$/.test(code)) notFound();

  return (
    <div className="screen-root flex flex-col items-center justify-center gap-[3vmin] text-center">
      <Logo className="h-[24vmin]" priority />
      <h1 className="screen-title">DOC Bern Quiz</h1>
      <p className="screen-text">
        Spielcode{" "}
        <span className="text-accent font-extrabold tracking-widest">
          {code.slice(0, 3)} {code.slice(3)}
        </span>
      </p>
      <p className="screen-small">Der Warteraum mit QR Code und Bubbles folgt in Meilenstein 4.</p>
    </div>
  );
}
