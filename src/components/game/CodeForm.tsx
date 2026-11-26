"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Notice from "@/components/Notice";

/** Eingabe des Spielcodes. Prüft vor dem Wechsel, ob es das Spiel gibt und ob ein Beitritt noch möglich ist. */
export default function CodeForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) {
      setError("Der Spielcode besteht aus sechs Ziffern.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/join?code=${clean}`, { cache: "no-store" });
      const body = (await response.json()) as { ok: boolean; open?: boolean; message?: string };
      if (!body.ok) {
        setError(body.message ?? "Dieses Spiel gibt es nicht.");
      } else {
        router.push(`/join/${clean}`);
      }
    } catch {
      setError("Keine Verbindung. Bitte prüfen Sie Ihr Netz und versuchen Sie es noch einmal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <label htmlFor="code" className="text-sm font-semibold">
        Spielcode
      </label>
      <input
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="off"
        pattern="[0-9]*"
        maxLength={7}
        placeholder="123456"
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ""))}
        className="field text-center text-2xl font-bold tracking-[0.3em]"
        aria-describedby={error ? "code-error" : undefined}
      />
      {error ? (
        <div id="code-error">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? "Einen Moment …" : "Weiter"}
      </button>
    </form>
  );
}
