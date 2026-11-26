import type { Metadata } from "next";
import Link from "next/link";
import Notice from "@/components/Notice";
import StatusPill from "@/components/StatusPill";
import { requireAdmin } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { getSessionRepository, type SessionSummary } from "@/lib/game/sessions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata: Metadata = { title: "Resultate" };

const STATUS = {
  lobby: { label: "Warteraum", tone: "warn" },
  running: { label: "Läuft", tone: "warn" },
  finished: { label: "Beendet", tone: "ok" },
  cancelled: { label: "Abgebrochen", tone: "neutral" },
} as const;

export default async function ResultsPage() {
  await requireAdmin();
  let sessions: SessionSummary[] = [];
  let failed = false;
  try {
    sessions = await getSessionRepository().listSessions();
  } catch (error) {
    failed = true;
    console.error("[results] Laden fehlgeschlagen:", error instanceof Error ? error.message : String(error));
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Resultate</h1>
        <p className="text-ink-soft mt-1 text-sm">Alle Durchführungen mit Siegerin oder Sieger. Einzelne Durchführungen zeigen die ganze Rangliste und Auswertungen pro Frage.</p>
      </header>

      {failed ? <Notice tone="error">Die Resultate konnten nicht geladen werden. Bitte prüfen Sie die Datenbank unter System.</Notice> : null}

      {!failed && sessions.length === 0 ? <Notice tone="info">Es gab noch keine Durchführung.</Notice> : null}

      {sessions.length > 0 ? (
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-ink-soft border-b border-black/5 text-xs">
                <th className="px-5 py-3 font-semibold">Datum</th>
                <th className="px-5 py-3 font-semibold">Quiz</th>
                <th className="px-5 py-3 font-semibold">Code</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 text-right font-semibold">Teilnehmende</th>
                <th className="px-5 py-3 font-semibold">Siegerin oder Sieger</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="border-b border-black/5 last:border-0">
                  <td className="px-5 py-3 whitespace-nowrap">{formatDateTime(session.createdAt)}</td>
                  <td className="px-5 py-3 font-semibold">{session.quizTitle}</td>
                  <td className="px-5 py-3 tabular-nums">{session.joinCode}</td>
                  <td className="px-5 py-3">
                    <StatusPill tone={STATUS[session.status].tone}>{STATUS[session.status].label}</StatusPill>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{session.playerCount}</td>
                  <td className="px-5 py-3">{session.winner ?? "–"}</td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    {session.status === "finished" ? (
                      <Link href={`/admin/results/${session.id}`} className="font-semibold text-[var(--accent-hex)]">
                        Ansehen
                      </Link>
                    ) : session.status === "lobby" || session.status === "running" ? (
                      <Link href={`/admin/games/${session.joinCode}`} className="font-semibold text-[var(--accent-hex)]">
                        Steuern
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
