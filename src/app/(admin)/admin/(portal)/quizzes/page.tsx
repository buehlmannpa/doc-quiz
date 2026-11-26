import type { Metadata } from "next";
import Link from "next/link";
import Notice from "@/components/Notice";
import StatusPill from "@/components/StatusPill";
import { requireAdmin } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { describeError } from "@/lib/health";
import { getQuizRepository, type QuizSummary } from "@/lib/quiz/repository";
import { STATUS_LABELS, type QuizStatus } from "@/lib/quiz/rules";
import CreateQuizForm from "./CreateQuizForm";

export const metadata: Metadata = { title: "Quizzes" };
// Die Liste muss nach jeder Änderung aktuell sein und liest bei jedem Aufruf aus der Datenbank.
export const dynamic = "force-dynamic";
// Genug Zeit für den Kaltstart der Neon Datenbank.
export const maxDuration = 30;

const TONE: Record<QuizStatus, "neutral" | "ok" | "warn"> = { draft: "neutral", ready: "ok", completed: "warn" };

export default async function QuizzesPage() {
  await requireAdmin();

  let quizzes: QuizSummary[] = [];
  let loadError: string | null = null;
  try {
    quizzes = await getQuizRepository().listQuizzes();
  } catch (error) {
    loadError = describeError(error);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Quizzes</h1>
        <p className="text-ink-soft mt-1 text-sm">
          Entwürfe vorbereiten, als Bereit markieren und nach dem Einsatz archivieren.
        </p>
      </header>

      {loadError ? (
        <Notice tone="error">
          <p className="font-semibold">Die Quizzes konnten nicht geladen werden.</p>
          <p className="mt-1">
            Prüfen Sie auf der Seite <Link href="/admin/system" className="underline">System</Link>, ob die Datenbank erreichbar
            und migriert ist. Meldung: {loadError}
          </p>
        </Notice>
      ) : (
        <>
          <CreateQuizForm />

          <section className="glass-card overflow-hidden">
            {quizzes.length === 0 ? (
              <p className="text-ink-soft p-6 text-sm">Noch kein Quiz vorhanden. Legen Sie oben das erste an.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead>
                    <tr className="text-ink-soft text-xs uppercase" style={{ borderBottom: "1px solid var(--hairline)" }}>
                      <th scope="col" className="px-5 py-3 font-semibold">
                        Titel
                      </th>
                      <th scope="col" className="px-5 py-3 font-semibold">
                        Status
                      </th>
                      <th scope="col" className="px-5 py-3 text-right font-semibold">
                        Fragen
                      </th>
                      <th scope="col" className="px-5 py-3 text-right font-semibold">
                        Durchführungen
                      </th>
                      <th scope="col" className="px-5 py-3 font-semibold">
                        Geändert
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {quizzes.map((quiz) => (
                      <tr key={quiz.id} style={{ borderBottom: "1px solid var(--hairline)" }}>
                        <td className="px-5 py-3">
                          <Link href={`/admin/quizzes/${quiz.id}`} className="font-semibold hover:underline">
                            {quiz.title}
                          </Link>
                        </td>
                        <td className="px-5 py-3">
                          <StatusPill tone={TONE[quiz.status]}>{STATUS_LABELS[quiz.status]}</StatusPill>
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">{quiz.questionCount}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{quiz.sessionCount}</td>
                        <td className="text-ink-soft px-5 py-3 whitespace-nowrap">{formatDateTime(quiz.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
