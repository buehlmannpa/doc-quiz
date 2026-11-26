"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { FinishedView, LobbyView, PodiumPhoneView, QuestionView, ResultView, Waiting } from "@/components/game/PlayViews";
import Notice from "@/components/Notice";
import { clearPlayer, getPlayerSnapshot, subscribePlayer } from "@/lib/game/playerStorage";
import { CLOSE_CODES } from "@/lib/realtime/protocol";
import { useGame } from "@/lib/realtime/useGame";

export default function PlayClient({ code }: { code: string }) {
  const router = useRouter();
  // Auf dem Server gibt es keinen Browser Speicher (undefined), im Browser entweder das Token oder null.
  const stored = useSyncExternalStore(
    subscribePlayer,
    () => getPlayerSnapshot(code),
    () => undefined,
  );

  useEffect(() => {
    if (stored === null) router.replace(`/join/${code}`);
  }, [stored, code, router]);

  const game = useGame({
    code,
    role: "player",
    token: stored?.token,
    enabled: !!stored,
    keepAwake: true,
    // Die Smartphones sind nur die Absicherung für den Zeithinweis. Beamer und Admin melden zuerst.
    tickExtraDelayMs: 1500,
    rotateAfterResolveMs: 3000,
  });

  if (!stored) return <Waiting title="Einen Moment …" />;

  if (game.fatal) {
    const unknownGame = game.fatal.code === CLOSE_CODES.GAME_NOT_FOUND;
    return (
      <section className="glass-card space-y-4 px-6 py-7">
        <h1 className="text-xl font-bold tracking-tight">{unknownGame ? "Spiel nicht gefunden" : "Anmeldung nicht möglich"}</h1>
        <Notice tone="error">
          {unknownGame
            ? "Dieses Spiel gibt es nicht mehr."
            : "Ihre Anmeldung ist für dieses Spiel nicht gültig. Das passiert, wenn ein neues Spiel mit demselben Code gestartet wurde."}
        </Notice>
        <Link href="/join" className="btn btn-primary w-full" onClick={() => clearPlayer(code)}>
          Neu beitreten
        </Link>
      </section>
    );
  }

  const state = game.state;
  if (!state) {
    return <Waiting title="Verbinden …" text="Einen Moment, die Verbindung wird aufgebaut." />;
  }

  const me = { playerId: stored.playerId, name: stored.name, avatar: stored.avatar };
  const banner =
    game.status === "reconnecting" ? (
      <div className="mb-3">
        <Notice tone="warn">Die Verbindung wird wiederhergestellt …</Notice>
      </div>
    ) : null;

  let body: React.ReactNode;
  switch (state.phase) {
    case "lobby":
      body = <LobbyView me={me} state={state} onNudge={game.nudge} />;
      break;
    case "question":
      // Der Schlüssel setzt die Ansicht für jede neue Frage zurück (Eingabe, Fehlermeldung).
      body = <QuestionView key={state.question?.index ?? 0} game={game} state={state} />;
      break;
    case "resolved":
      body = <ResultView state={state} me={me} />;
      break;
    case "podium":
      body = <PodiumPhoneView state={state} me={me} />;
      break;
    case "finished":
      body = <FinishedView state={state} me={me} />;
      break;
  }

  return (
    <>
      {banner}
      {body}
    </>
  );
}
