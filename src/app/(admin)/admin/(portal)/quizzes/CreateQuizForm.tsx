"use client";

import { useActionState } from "react";
import Notice from "@/components/Notice";
import { createQuizAction, type FormState } from "./actions";

export default function CreateQuizForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(createQuizAction, null);

  return (
    <form action={formAction} className="glass-card space-y-4 p-6">
      <h2 className="text-lg font-semibold">Neues Quiz</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="new-title" className="mb-1 block text-sm font-semibold">
            Titel
          </label>
          <input id="new-title" name="title" required maxLength={120} className="field" placeholder="Zum Beispiel Ducati Wissen" />
        </div>
        <div>
          <label htmlFor="new-description" className="mb-1 block text-sm font-semibold">
            Beschreibung (optional)
          </label>
          <input id="new-description" name="description" maxLength={500} className="field" />
        </div>
      </div>
      {state && state.errors.length > 0 ? (
        <Notice tone="error">
          {state.errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </Notice>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Wird angelegt …" : "Quiz anlegen"}
      </button>
    </form>
  );
}
