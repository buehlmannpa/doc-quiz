"use client";

import { useActionState } from "react";
import Notice from "@/components/Notice";
import { startGameAction, type GameFormState } from "./actions";

export type StartableQuiz = { id: string; title: string; questionCount: number };

export default function StartGameForm({ quizzes }: { quizzes: StartableQuiz[] }) {
  const [state, formAction, pending] = useActionState<GameFormState, FormData>(startGameAction, null);

  if (quizzes.length === 0) {
    return (
      <Notice tone="info">
        Es gibt kein Quiz im Status Bereit. Legen Sie unter Quizzes ein Quiz an, fügen Sie Fragen hinzu und markieren Sie es als Bereit.
      </Notice>
    );
  }

  return (
    <form action={formAction} className="glass-card space-y-4 p-6">
      <h2 className="text-lg font-semibold">Neue Durchführung</h2>
      <div>
        <label htmlFor="quizId" className="mb-1 block text-sm font-semibold">
          Quiz
        </label>
        <select id="quizId" name="quizId" required className="field" defaultValue="">
          <option value="" disabled>
            Bitte wählen
          </option>
          {quizzes.map((quiz) => (
            <option key={quiz.id} value={quiz.id}>
              {quiz.title} ({quiz.questionCount} {quiz.questionCount === 1 ? "Frage" : "Fragen"})
            </option>
          ))}
        </select>
      </div>
      <p className="text-ink-soft text-sm">
        Es entsteht ein Warteraum mit QR Code. Teilnehmende scannen ihn und treten bei. Mit dem Start des Quiz ist kein Beitritt mehr möglich.
      </p>
      {state?.error ? <Notice tone="error">{state.error}</Notice> : null}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Wird angelegt …" : "Warteraum öffnen"}
      </button>
    </form>
  );
}
