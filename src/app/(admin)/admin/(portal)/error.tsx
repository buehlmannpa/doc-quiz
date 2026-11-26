"use client";

import Link from "next/link";
import { useEffect } from "react";

/** Fängt unerwartete Fehler im Adminportal ab und zeigt eine verständliche Meldung statt einer leeren Seite. */
export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Die Meldung gelangt in die Logs. Details sieht der Admin hier bewusst nicht.
    console.error("[admin] Fehler:", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="glass-card max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-bold tracking-tight">Etwas ist schiefgelaufen</h1>
      <p className="text-ink-soft text-sm">
        Die Seite konnte nicht geladen werden. Oft hilft ein neuer Versuch. Wenn es wieder passiert, prüfen Sie auf der Seite
        System, ob die Datenbank erreichbar ist.
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Erneut versuchen
        </button>
        <Link href="/admin/system" className="btn btn-secondary">
          Zur Seite System
        </Link>
      </div>
    </div>
  );
}
