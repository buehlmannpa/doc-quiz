"use client";

import { useActionState } from "react";
import { runMigrationsAction, type MigrationActionState } from "./actions";

export default function MigrateButton({ disabled }: { disabled: boolean }) {
  const [state, formAction, pending] = useActionState<MigrationActionState>(runMigrationsAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <button type="submit" className="btn btn-primary" disabled={disabled || pending}>
        {pending ? "Migration läuft …" : "Migrationen anwenden"}
      </button>
      {state ? (
        <p role="status" className={`text-sm ${state.ok ? "text-ink" : "text-danger"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
