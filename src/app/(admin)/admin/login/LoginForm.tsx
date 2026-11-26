"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

const INITIAL: LoginState = { error: null };

export default function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL);

  return (
    <form action={formAction} className="mt-6 space-y-3">
      <label className="block text-sm font-semibold" htmlFor="password">
        Passwort
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        maxLength={200}
        className="field"
        aria-describedby={state.error ? "login-error" : undefined}
      />
      {state.error ? (
        <p id="login-error" role="alert" className="text-danger text-sm">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Anmelden …" : "Anmelden"}
      </button>
    </form>
  );
}
