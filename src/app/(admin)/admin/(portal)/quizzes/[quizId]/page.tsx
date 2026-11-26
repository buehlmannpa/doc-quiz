import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import AnswerSymbol from "@/components/AnswerSymbol";
import Notice from "@/components/Notice";
import StatusPill from "@/components/StatusPill";
import { requireAdmin } from "@/lib/auth/session";
import { ANSWER_SLOTS } from "@/lib/design";
import { formatDateTime } from "@/lib/format";
import { formatNumber } from "@/lib/quiz/number";
import { getQuizRepository, type QuestionWithOptions } from "@/lib/quiz/repository";
import {
  checkDeletable,
  checkEditable,
  STATUS_LABELS,
  statusOptions,
  TYPE_LABELS,
  type QuizStatus,
} from "@/lib/quiz/rules";
import { LIMITS } from "@/lib/quiz/schema";
import QuestionRowActions from "./QuestionRowActions";
import QuizActions from "./QuizActions";
import QuizMetaForm from "./QuizMetaForm";
import StatusControls from "./StatusControls";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata: Metadata = { title: "Quiz" };

const TONE: Record<QuizStatus, "neutral" | "ok" | "warn"> = { draft: "neutral", ready: "ok", completed: "warn" };

function QuestionCard({
  question,
  index,
  total,
  quizId,
  locked,
}: {
  question: QuestionWithOptions;
  index: number;
  total: number;
  quizId: string;
  locked: boolean;
}) {
  return (
    <li className="glass-card p-5">
      <div className="flex items-start gap-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/5 text-sm font-bold">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold break-words">{question.prompt}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusPill tone="neutral">{TYPE_LABELS[question.type]}</StatusPill>
            <StatusPill tone="neutral">{question.timeLimitSeconds} Sekunden</StatusPill>
            <StatusPill tone="neutral">
              {question.type === "poll" ? "keine Punkte" : `${formatNumber(question.maxPoints)} Punkte`}
            </StatusPill>
          </div>

          {question.type === "estimate" ? (
            <p className="mt-3 text-sm">
              Richtiger Wert: <strong>{formatNumber(question.correctValue ?? 0)}</strong>
              {question.unit ? ` ${question.unit}` : ""}, Toleranz <strong>{formatNumber(question.tolerance ?? 0)}</strong>
            </p>
          ) : (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {question.options.map((option, optionIndex) => {
                const slot = ANSWER_SLOTS[optionIndex % 4] ?? ANSWER_SLOTS[0];
                return (
                  <li key={option.id} className="flex items-center gap-2 text-sm">
                    <span
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                      style={{ background: slot.background, color: slot.foreground }}
                      aria-hidden="true"
                    >
                      <AnswerSymbol shape={slot.shape} size={16} />
                    </span>
                    <span className="min-w-0 break-words">{option.text}</span>
                    {option.isCorrect ? <StatusPill tone="ok">richtig</StatusPill> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <QuestionRowActions quizId={quizId} questionId={question.id} index={index} total={total} locked={locked} />
      </div>
    </li>
  );
}

export default async function QuizPage({ params }: { params: Promise<{ quizId: string }> }) {
  await requireAdmin();
  const { quizId } = await params;
  if (!z.uuid().safeParse(quizId).success) notFound();

  const detail = await getQuizRepository().getQuizDetail(quizId);
  if (!detail) notFound();
  const { quiz, questions, sessionCount } = detail;

  const editable = checkEditable({ status: quiz.status, sessionCount });
  const deletable = checkDeletable({ sessionCount });
  const options = statusOptions(quiz.status, { sessionCount, questionCount: questions.length }).map((option) => ({
    to: option.to,
    allowed: option.check.allowed,
    reason: option.check.allowed ? undefined : option.check.reason,
  }));
  const atLimit = questions.length >= LIMITS.questionsPerQuiz;

  return (
    <div className="space-y-6">
      <nav aria-label="Brotkrumen" className="text-ink-soft text-sm">
        <Link href="/admin/quizzes" className="hover:underline">
          Quizzes
        </Link>{" "}
        / <span className="text-ink">{quiz.title}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight break-words">{quiz.title}</h1>
            <StatusPill tone={TONE[quiz.status]}>{STATUS_LABELS[quiz.status]}</StatusPill>
          </div>
          <p className="text-ink-soft mt-1 text-sm">
            {questions.length} {questions.length === 1 ? "Frage" : "Fragen"}, {sessionCount}{" "}
            {sessionCount === 1 ? "Durchführung" : "Durchführungen"}. Zuletzt geändert {formatDateTime(quiz.updatedAt)}.
          </p>
        </div>
        <QuizActions quizId={quiz.id} deleteBlockedReason={deletable.allowed ? undefined : deletable.reason} />
      </header>

      {!editable.allowed ? <Notice tone="warn">{editable.reason}</Notice> : null}

      <section className="glass-card space-y-4 p-6">
        <h2 className="text-lg font-semibold">Allgemein</h2>
        <QuizMetaForm quizId={quiz.id} title={quiz.title} description={quiz.description} locked={!editable.allowed} />
      </section>

      {options.length > 0 ? (
        <section className="glass-card space-y-4 p-6">
          <h2 className="text-lg font-semibold">Status</h2>
          <p className="text-ink-soft text-sm">
            Entwurf: wird vorbereitet. Bereit: kann durchgeführt werden. Abgeschlossen: archiviert, nicht mehr bearbeitbar und
            nicht mehr spielbar, die Resultate bleiben einsehbar.
          </p>
          <StatusControls quizId={quiz.id} options={options} />
        </section>
      ) : null}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Fragen ({questions.length})</h2>
          {editable.allowed && !atLimit ? (
            <Link href={`/admin/quizzes/${quiz.id}/questions/new`} className="btn btn-primary">
              Frage hinzufügen
            </Link>
          ) : null}
        </div>
        {editable.allowed && atLimit ? (
          <Notice tone="info">Ein Quiz kann höchstens {LIMITS.questionsPerQuiz} Fragen enthalten.</Notice>
        ) : null}
        {questions.length === 0 ? (
          <p className="text-ink-soft glass-card p-6 text-sm">Noch keine Fragen. Fügen Sie die erste hinzu.</p>
        ) : (
          <ol className="space-y-3">
            {questions.map((question, index) => (
              <QuestionCard
                key={question.id}
                question={question}
                index={index}
                total={questions.length}
                quizId={quiz.id}
                locked={!editable.allowed}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
