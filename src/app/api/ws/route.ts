/**
 * WebSocket Endpunkt für Spieler, Bildschirm und Admin.
 *
 * Ablauf: Origin prüfen, Admin Berechtigung aus dem Cookie bestimmen, Verbindung hochstufen und dem Hub übergeben.
 * Die weitere Anmeldung (Rolle, Spielcode, Token) geschieht mit der ersten Nachricht (hello), siehe protocol.ts.
 *
 * Wichtig: Die Admin Berechtigung wird hier einmal beim Aufbau bestimmt, nie aus Nachrichten des Clients abgeleitet.
 * upgradeWebSocket gibt es nur in der Vercel Laufzeit. Lokal mit next dev antwortet die Route mit 501.
 */
import { upgradeWebSocket } from "@vercel/functions";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { verifySessionToken } from "@/lib/auth/token";
import { resolveSessionSecret } from "@/lib/env";
import { getHub } from "@/lib/realtime/instance";
import { isAllowedOrigin } from "@/lib/realtime/origin";

export const dynamic = "force-dynamic";
// Hobby: 300 Sekunden sind Standard und Maximum. Danach schliesst die Plattform die Verbindung.
export const maxDuration = 300;

/** Grösste erlaubte Nachricht in Bytes. Alle Nachrichten des Clients sind sehr klein. */
const MAX_PAYLOAD_BYTES = 4096;

function hasAdminCookie(request: NextRequest): boolean {
  try {
    const secret = resolveSessionSecret(process.env);
    return verifySessionToken(secret, request.cookies.get(SESSION_COOKIE)?.value, Date.now()).valid;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const hosts = [request.headers.get("host"), request.headers.get("x-forwarded-host")];
  if (!isAllowedOrigin(request.headers.get("origin"), hosts)) {
    return new Response("Forbidden", { status: 403 });
  }

  let hub: ReturnType<typeof getHub>;
  try {
    hub = getHub();
  } catch (error) {
    console.error("[ws] Dienst nicht verfügbar:", error instanceof Error ? error.message : String(error));
    return new Response("Der Dienst ist nicht konfiguriert.", { status: 503 });
  }

  const isAdmin = hasAdminCookie(request);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unbekannt";

  try {
    return await upgradeWebSocket(
      (ws) => {
        hub.attach(ws, { isAdmin, ip });
      },
      { maxPayload: MAX_PAYLOAD_BYTES },
    );
  } catch (error) {
    // Ausserhalb der Vercel Laufzeit gibt es keinen WebSocket Upgrade. Das ist erwartet und kein Serverfehler.
    if (error instanceof Error && /not available in the current runtime/.test(error.message)) {
      return new Response("WebSocket Upgrade ist nur in der Vercel Laufzeit verfügbar.", { status: 501 });
    }
    throw error;
  }
}
