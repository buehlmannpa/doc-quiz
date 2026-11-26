import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ScreenClient from "@/components/game/ScreenClient";
import { appOrigin } from "@/lib/app-origin";
import { hasAdminSession } from "@/lib/auth/session";
import { qrSvg } from "@/lib/game/qr";

export const metadata: Metadata = { title: "Bildschirm" };

/**
 * Beamer Ansicht. Vollbild, sehr grosse Schrift, kein Scrollen. Öffentlich und nur lesend, wer den Spielcode kennt,
 * kann zuschauen. Ist der Admin angemeldet, verbindet sich die Ansicht mit Admin Berechtigung und zeigt die
 * Steuerleiste. Die Berechtigung wird beim Verbindungsaufbau aus dem Cookie bestimmt, nie aus dem Seiteninhalt.
 */
export default async function ScreenPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // Der Spielcode ist immer sechsstellig. Alles andere ist eine ungültige Adresse.
  if (!/^\d{6}$/.test(code)) notFound();

  const [isAdmin, origin] = await Promise.all([hasAdminSession(), appOrigin()]);
  const joinUrl = `${origin}/join/${code}`;
  const qr = await qrSvg(joinUrl);
  return <ScreenClient code={code} isAdmin={isAdmin} joinUrl={joinUrl} qr={qr} />;
}
