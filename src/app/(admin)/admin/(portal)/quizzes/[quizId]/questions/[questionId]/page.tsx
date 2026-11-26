import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import Notice from "@/components/Notice";
import { requireAdmin } from "@/lib/auth/session";
import { getQuizRepository } from "@/lib/quiz/repository";
import { checkEditable } from "@/lib/quiz/rules";
import QuestionForm, { type QuestionFormInitial } from "../QuestionForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Frage bearbeiten" };

export default async function EditQuestionPage({
  params,
}: {
  params: Promise<{ quizId: string; questionId: string }>;
}) {
  await requireAdmin();
  const { quizId, questionId } = await params;
  if (!z.uuid().safeParse(quizId).success || !z.uuid().safeParse(questionId).success) notFound();

  const detail = await getQuizRepository().getQuizDetail(quizId);
  if (!detail) notFound();
  const index = detail.questions.findIndex((question) => question.id === questionId);
  const question = detail.questions[index];
  if (!question) notFound();

  const editable = checkEditable({ status: detail.quiz.status, sessionCount: detail.sessionCount });
  const initial: QuestionFormInitial = {
    type: question.type,
    prompt: question.prompt,
    timeLimitSeconds: question.timeLimitSeconds,
    maxPoints: question.maxPoints,
    options: question.options.map((option) => ({ text: option.text, isCorrect: option.isCorrect })),
    correctValue: question.correctValue,
    unit: question.unit,
    tolerance: question.tolerance,
  };

  return (
    <div className="max-w-3xl space-y-6">
      <nav aria-label="Brotkrumen" className="text-ink-soft text-sm">
        <Link href="/admin/quizzes" className="hover:underline">
          Quizzes
        </Link>{" "}
        /{" "}
        <Link href={`/admin/quizzes/${quizId}`} className="hover:underline">
          {detail.quiz.title}
        </Link>{" "}
        / <span className="text-ink">Frage {index + 1}</span>
      </nav>
      <h1 className="text-2xl font-bold tracking-tight">Frage {index + 1} bearbeiten</h1>

      {!editable.allowed ? (
        <Notice tone="warn">{editable.reason}</Notice>
      ) : (
        <div className="glass-card p-6">
          <QuestionForm quizId={quizId} questionId={questionId} initial={initial} />
        </div>
      )}
    </div>
  );
}
