import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth/session";
import LabClient from "./LabClient";

export const metadata: Metadata = { title: "Verbindungslabor" };
export const dynamic = "force-dynamic";

export default async function LabPage() {
  await requireAdmin();
  // Messmodus: Der Server beendet Verbindungen nicht mehr selbst, die Grenze der Plattform wird sichtbar.
  const platformLimitMode = Boolean(process.env.REALTIME_MAX_AGE_NOTICE_MS || process.env.REALTIME_MAX_AGE_CLOSE_MS);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Verbindungslabor</h1>
        <p className="text-ink-soft mt-1 max-w-3xl text-sm">
          Prüft die Echtzeit Verbindung mit bis zu 60 simulierten Teilnehmenden direkt aus diesem Browser. Es misst, wie sich die
          Verbindungen auf die Funktionsinstanzen verteilen, wie schnell eine Änderung ankommt, wie die Wiederverbindung nach
          Abbrüchen funktioniert und ob der kontrollierte Neuaufbau ohne Unterbruch klappt. Es braucht keine Software auf Ihrem Rechner.
          Das Labor funktioniert nur auf Vercel, lokal braucht es den Hilfsserver (siehe docs/VERBINDUNGSTEST.md).
        </p>
      </header>
      <LabClient platformLimitMode={platformLimitMode} />
    </div>
  );
}
