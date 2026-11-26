/**
 * Health Check: prüft Neon, Upstash (REST und TCP) und zeigt die Laufzeit Region.
 *
 * Zugriff:
 * 1. Ausserhalb der Produktion sind alle Details frei sichtbar (nur Namen und Zeiten, keine Werte).
 * 2. In der Produktion liefert die Route ohne Token nur { ok: true } und berührt weder Neon noch
 *    Redis. So kann niemand von aussen die Datenbank aufwecken oder das Befehlskontingent verbrauchen.
 *    Mit dem Header x-health-token (Wert der Variable HEALTH_TOKEN) gibt es die vollen Details.
 *    Der angemeldete Admin sieht dieselben Details auf der Seite /admin/system.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveDeploymentEnv } from "@/lib/env";
import { runHealthChecks } from "@/lib/health";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function hasValidToken(request: Request): boolean {
  const expected = process.env.HEALTH_TOKEN;
  const given = request.headers.get("x-health-token");
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<NextResponse> {
  const detailsAllowed = resolveDeploymentEnv(process.env) !== "production" || hasValidToken(request);

  if (!detailsAllowed) {
    return NextResponse.json({ ok: true, service: "doc-quiz" }, { headers: { "Cache-Control": "no-store" } });
  }

  const report = await runHealthChecks();
  return NextResponse.json(report, { status: report.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
