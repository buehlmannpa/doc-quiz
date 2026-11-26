import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import Notice from "@/components/Notice";
import { requireAdmin } from "@/lib/auth/session";
import { getQuizRepository } from "@/lib/quiz/repository";
import { checkEditable } from "@/lib/quiz/rules";
import { LIMITS } from "@/lib/quiz/schema";
import QuestionForm from "../QuestionForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Neue Frage" };

export default async function NewQuestionPage({ params }: { params: Promise<{ quizId: string }> }) {
  await requireAdmin();
  const { quizId } = await params;
  if (!z.uuid().safeParse(quizId).success) notFound();
  const detail = await getQuizRepository().getQuizDetail(quizId);
  if (!detail) notFound();

  const editable = checkEditable({ status: detail.quiz.status, sessionCount: detail.sessionCount });
  const atLimit = detail.questions.length >= LIMITS.questionsPerQuiz;

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
        / <span className="text-ink">Neue Frage</span>
      </nav>
      <h1 className="text-2xl font-bold tracking-tight">Neue Frage</h1>

      {!editable.allowed ? (
        <Notice tone="warn">{editable.reason}</Notice>
      ) : atLimit ? (
        <Notice tone="info">Ein Quiz kann höchstens {LIMITS.questionsPerQuiz} Fragen enthalten.</Notice>
      ) : (
        <div className="glass-card p-6">
          <QuestionForm quizId={quizId} questionId={null} initial={null} />
        </div>
      )}
    </div>
  );
}
