"use client";

import { useActionState } from "react";
import Notice from "@/components/Notice";
import { updateQuizMetaAction, type FormState } from "../actions";

export default function QuizMetaForm({
  quizId,
  title,
  description,
  locked,
}: {
  quizId: string;
  title: string;
  description: string;
  locked: boolean;
}) {
  const action = updateQuizMetaAction.bind(null, quizId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, null);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="title" className="mb-1 block text-sm font-semibold">
          Titel
        </label>
        <input id="title" name="title" defaultValue={title} required maxLength={120} className="field" disabled={locked} />
      </div>
      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-semibold">
          Beschreibung
        </label>
        <textarea
          id="description"
          name="description"
          defaultValue={description}
          maxLength={500}
          rows={3}
          className="field min-h-24 py-3"
          disabled={locked}
        />
      </div>
      {state && state.errors.length > 0 ? (
        <Notice tone="error">
          {state.errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </Notice>
      ) : null}
      {!locked ? (
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "Wird gespeichert …" : "Speichern"}
          </button>
          {state?.saved ? (
            <span role="status" className="text-sm font-semibold" style={{ color: "#18772f" }}>
              Gespeichert.
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
