import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appOrigin } from "@/lib/app-origin";
import { requireAdmin } from "@/lib/auth/session";
import { qrSvg } from "@/lib/game/qr";
import { getSessionRepository } from "@/lib/game/sessions";
import GameControl from "./GameControl";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata: Metadata = { title: "Steuerung" };

export default async function GameControlPage({ params }: { params: Promise<{ code: string }> }) {
  await requireAdmin();
  const { code } = await params;
  if (!/^\d{6}$/.test(code)) notFound();

  const session = await getSessionRepository().getByCode(code);
  if (!session) notFound();

  const joinUrl = `${await appOrigin()}/join/${code}`;
  const qr = await qrSvg(joinUrl);
  return (
    <GameControl
      code={code}
      sessionId={session.id}
      quizTitle={session.quizTitle}
      dbStatus={session.status}
      joinUrl={joinUrl}
      qr={qr}
    />
  );
}
