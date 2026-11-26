"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { deleteQuestionAction, moveQuestionAction } from "../actions";

export default function QuestionRowActions({
  quizId,
  questionId,
  index,
  total,
  locked,
}: {
  quizId: string;
  questionId: string;
  index: number;
  total: number;
  locked: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; errors?: string[] }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.errors?.join(" ") ?? "Die Aktion ist fehlgeschlagen.");
    });
  }

  const iconButton = "btn btn-secondary !min-h-10 !px-3 text-sm";

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className={iconButton}
          aria-label={`Frage ${index + 1} nach oben`}
          disabled={locked || pending || index === 0}
          onClick={() => run(() => moveQuestionAction(quizId, questionId, "up"))}
        >
          ↑
        </button>
        <button
          type="button"
          className={iconButton}
          aria-label={`Frage ${index + 1} nach unten`}
          disabled={locked || pending || index === total - 1}
          onClick={() => run(() => moveQuestionAction(quizId, questionId, "down"))}
        >
          ↓
        </button>
        {locked ? null : (
          <Link href={`/admin/quizzes/${quizId}/questions/${questionId}`} className={iconButton}>
            Bearbeiten
          </Link>
        )}
        <button
          type="button"
          className={iconButton}
          style={{ color: "#c40511" }}
          disabled={locked || pending}
          onClick={() => {
            if (window.confirm(`Frage ${index + 1} löschen?`)) run(() => deleteQuestionAction(quizId, questionId));
          }}
        >
          Löschen
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
