"use client";

import { useState, useTransition } from "react";
import Notice from "@/components/Notice";
import { deleteQuizAction, duplicateQuizAction } from "../actions";

export default function QuizActions({
  quizId,
  deleteBlockedReason,
}: {
  quizId: string;
  /** Gesetzt, wenn das Löschen nicht erlaubt ist (zum Beispiel wegen Durchführungen). */
  deleteBlockedReason?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);

  function run(action: () => Promise<{ ok: boolean; errors?: string[] } | void>) {
    setErrors([]);
    startTransition(async () => {
      // Bei Erfolg leiten die Actions selbst weiter, ein Ergebnis kommt nur bei einem Fehler zurück.
      const result = await action();
      if (result && !result.ok && result.errors) setErrors(result.errors);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => run(() => duplicateQuizAction(quizId))}>
          Duplizieren
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ color: "#c40511" }}
          disabled={pending || Boolean(deleteBlockedReason)}
          title={deleteBlockedReason}
          onClick={() => {
            if (window.confirm("Quiz mit allen Fragen endgültig löschen? Das lässt sich nicht rückgängig machen.")) {
              run(() => deleteQuizAction(quizId));
            }
          }}
        >
          Löschen
        </button>
      </div>
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
