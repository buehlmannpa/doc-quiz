"use client";

import { useState, useTransition } from "react";
import Notice from "@/components/Notice";
import type { QuizStatus } from "@/lib/quiz/rules";
import { setQuizStatusAction } from "../actions";

export type StatusOption = { to: QuizStatus; allowed: boolean; reason?: string };

const LABELS: Record<QuizStatus, string> = {
  draft: "Zurück in den Entwurf",
  ready: "Als Bereit markieren",
  completed: "Abschliessen und archivieren",
};

const CONFIRM_COMPLETED =
  "Quiz abschliessen und archivieren?\n\nEin abgeschlossenes Quiz kann nicht mehr bearbeitet oder gespielt werden. Es bleibt mit seinen Resultaten einsehbar. Dieser Schritt lässt sich nicht rückgängig machen.";

export default function StatusControls({ quizId, options }: { quizId: string; options: StatusOption[] }) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);

  function change(to: QuizStatus) {
    if (to === "completed" && !window.confirm(CONFIRM_COMPLETED)) return;
    setErrors([]);
    startTransition(async () => {
      const result = await setQuizStatusAction(quizId, to);
      if (!result.ok) setErrors(result.errors);
    });
  }

  if (options.length === 0) return null;
  const blocked = options.filter((option) => !option.allowed && option.reason);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.to}
            type="button"
            className={`btn ${option.to === "ready" ? "btn-primary" : "btn-secondary"}`}
            disabled={pending || !option.allowed}
            title={option.allowed ? undefined : option.reason}
            onClick={() => change(option.to)}
          >
            {LABELS[option.to]}
          </button>
        ))}
      </div>
      {blocked.map((option) => (
        <p key={option.to} className="text-ink-soft text-sm">
          {option.reason}
        </p>
      ))}
      {errors.length > 0 ? (
        <Notice tone="error">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </Notice>
      ) : null}
    </div>
  );
}
