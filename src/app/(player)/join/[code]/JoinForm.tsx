"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Notice from "@/components/Notice";
import { AVATARS } from "@/lib/game/avatars";
import { loadPlayer, savePlayer } from "@/lib/game/playerStorage";
import { MAX_NAME_LENGTH } from "@/lib/realtime/game-state";

type Availability = { state: "loading" } | { state: "open"; title: string | null } | { state: "closed" } | { state: "missing"; message: string };

export default function JoinForm({ code }: { code: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<number | null>(null);
  const [availability, setAvailability] = useState<Availability>({ state: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Wer schon beigetreten ist (Neuladen, zurück im Browser), geht direkt ins Spiel.
    if (loadPlayer(code)) {
      router.replace(`/play/${code}`);
      return;
    }
    let cancelled = false;
    // Ein zufälliges Icon vorwählen, damit niemand ohne Auswahl hängen bleibt. Das geschieht erst nach der
    // Antwort des Servers, so stimmt die erste Darstellung mit der des Servers überein.
    const preselect = () => setAvatar((current) => current ?? Math.floor(Math.random() * AVATARS.length));
    fetch(`/api/join?code=${code}`, { cache: "no-store" })
      .then((response) => response.json() as Promise<{ ok: boolean; open?: boolean; title?: string | null; message?: string }>)
      .then((body) => {
        if (cancelled) return;
        preselect();
        if (!body.ok) setAvailability({ state: "missing", message: body.message ?? "Dieses Spiel gibt es nicht." });
        else if (!body.open) setAvailability({ state: "closed" });
        else setAvailability({ state: "open", title: body.title ?? null });
      })
      .catch(() => {
        if (cancelled) return;
        preselect();
        setAvailability({ state: "open", title: null });
      });
    return () => {
      cancelled = true;
    };
  }, [code, router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (avatar === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name, avatar }),
      });
      const body = (await response.json()) as
        | { ok: true; token: string; player: { id: string; name: string; avatar: number } }
        | { ok: false; message: string };
      if (!body.ok) {
        setError(body.message);
        return;
      }
      const stored = savePlayer(code, { token: body.token, playerId: body.player.id, name: body.player.name, avatar: body.player.avatar });
      if (!stored) {
        setError(
          "Ihr Browser erlaubt kein Speichern. Ohne Speicher kann das Quiz nicht fortgesetzt werden, wenn die Seite neu geladen wird. Bitte schalten Sie das private Surfen aus.",
        );
      }
      router.push(`/play/${code}`);
    } catch {
      setError("Keine Verbindung. Bitte prüfen Sie Ihr Netz und versuchen Sie es noch einmal.");
    } finally {
      setBusy(false);
    }
  }

  if (availability.state === "missing" || availability.state === "closed") {
    return (
      <section className="glass-card space-y-4 px-6 py-7">
        <h1 className="text-xl font-bold tracking-tight">
          {availability.state === "closed" ? "Das Quiz hat bereits begonnen" : "Spiel nicht gefunden"}
        </h1>
        <Notice tone={availability.state === "closed" ? "warn" : "error"}>
          {availability.state === "closed"
            ? "Ein Beitritt ist nicht mehr möglich. Wenn Sie schon dabei waren, öffnen Sie die Seite auf dem Gerät, mit dem Sie beigetreten sind."
            : availability.message}
        </Notice>
        <Link href="/join" className="btn btn-secondary w-full">
          Anderen Code eingeben
        </Link>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="glass-card space-y-5 px-6 py-7" noValidate>
      <div>
        <h1 className="text-xl font-bold tracking-tight">Mitspielen</h1>
        <p className="text-ink-soft mt-1 text-sm">
          Spielcode {code.slice(0, 3)} {code.slice(3)}
          {availability.state === "open" && availability.title ? `, ${availability.title}` : ""}
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="name" className="text-sm font-semibold">
          Ihr Name auf dem Bildschirm
        </label>
        <input
          id="name"
          name="name"
          className="field"
          autoComplete="off"
          autoCapitalize="words"
          maxLength={MAX_NAME_LENGTH}
          placeholder="Zum Beispiel Anna"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          aria-describedby="name-hint"
        />
        <p id="name-hint" className="text-ink-soft text-xs">
          Höchstens {MAX_NAME_LENGTH} Zeichen. Der Name muss im Spiel einmalig sein.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Ihr Icon</legend>
        <div className="grid grid-cols-8 gap-1.5" role="radiogroup" aria-label="Icon wählen">
          {AVATARS.map((emoji, index) => (
            <button
              key={emoji}
              type="button"
              role="radio"
              aria-checked={avatar === index}
              aria-label={`Icon ${index + 1}`}
              onClick={() => setAvatar(index)}
              className="flex aspect-square min-h-10 items-center justify-center rounded-xl text-xl transition-transform"
              style={{
                background: avatar === index ? "rgba(227, 6, 19, 0.12)" : "var(--field-bg)",
                outline: avatar === index ? "2px solid var(--accent-hex)" : "none",
                transform: avatar === index ? "scale(1.1)" : undefined,
              }}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <button type="submit" className="btn btn-primary w-full" disabled={busy || name.trim().length === 0 || avatar === null || availability.state === "loading"}>
        {busy ? "Einen Moment …" : "Beitreten"}
      </button>
    </form>
  );
}
