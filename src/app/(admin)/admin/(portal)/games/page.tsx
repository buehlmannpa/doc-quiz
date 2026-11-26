import type { Metadata } from "next";
import Link from "next/link";
import Notice from "@/components/Notice";
import StatusPill from "@/components/StatusPill";
import { requireAdmin } from "@/lib/auth/session";
import { getSessionRepository } from "@/lib/game/sessions";
import { formatDateTime } from "@/lib/format";
import { getQuizRepository } from "@/lib/quiz/repository";
import { isPlayable } from "@/lib/quiz/rules";
import StartGameForm from "./StartGameForm";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata: Metadata = { title: "Durchführung" };

const STATUS_LABEL = { lobby: "Warteraum", running: "Läuft", finished: "Beendet", cancelled: "Abgebrochen" } as const;

export default async function GamesPage() {
  await requireAdmin();

  let active: Awaited<ReturnType<ReturnType<typeof getSessionRepository>["getActive"]>> = null;
  let quizzes: Awaited<ReturnType<ReturnType<typeof getQuizRepository>["listQuizzes"]>> = [];
  let failed = false;
  try {
    [active, quizzes] = await Promise.all([getSessionRepository().getActive(), getQuizRepository().listQuizzes()]);
  } catch (error) {
    failed = true;
    console.error("[games] Laden fehlgeschlagen:", error instanceof Error ? error.message : String(error));
  }
  const startable = quizzes
    .filter((quiz) => isPlayable(quiz.status) && quiz.questionCount > 0)
    .map((quiz) => ({ id: quiz.id, title: quiz.title, questionCount: quiz.questionCount }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Durchführung</h1>
        <p className="text-ink-soft mt-1 text-sm">Ein Quiz live spielen. Es läuft höchstens eine Durchführung gleichzeitig.</p>
      </header>

      {failed ? <Notice tone="error">Die Durchführungen konnten nicht geladen werden. Bitte prüfen Sie die Datenbank unter System.</Notice> : null}

      {active ? (
        <section className="glass-card space-y-3 p-6">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Aktive Durchführung</h2>
            <StatusPill tone={active.status === "running" ? "ok" : "warn"}>{STATUS_LABEL[active.status]}</StatusPill>
          </div>
          <p>
            <strong>{active.quizTitle}</strong>, Spielcode{" "}
            <span className="tabular-nums">
              {active.joinCode.slice(0, 3)} {active.joinCode.slice(3)}
            </span>
            , angelegt {formatDateTime(active.createdAt)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={`/admin/games/${active.joinCode}`} className="btn btn-primary">
              Steuerung öffnen
            </Link>
            <a href={`/screen/${active.joinCode}`} target="_blank" rel="noreferrer" className="btn btn-secondary">
              Beamer Ansicht öffnen
            </a>
          </div>
        </section>
      ) : failed ? null : (
        <StartGameForm quizzes={startable} />
      )}
    </div>
  );
}
