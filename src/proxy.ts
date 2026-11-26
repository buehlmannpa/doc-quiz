/**
 * Erste Schranke für das Adminportal: Wer keine gültige Session hat, wird zur Anmeldung geleitet.
 *
 * Das ersetzt die Prüfung in den Seiten und Server Actions NICHT. Die eigentliche Prüfung geschieht
 * dort mit requireAdmin(), nahe an den Daten. Diese Datei verhindert nur, dass geschützte Seiten
 * überhaupt gerendert werden, und setzt für das Adminportal "no-store", damit nichts zwischengespeichert wird.
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { verifySessionToken } from "@/lib/auth/token";
import { resolveAdminEnv } from "@/lib/env";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/admin/login") return NextResponse.next();

  let valid = false;
  try {
    const { sessionSecret } = resolveAdminEnv(process.env);
    valid = verifySessionToken(sessionSecret, request.cookies.get(SESSION_COOKIE)?.value, Date.now()).valid;
  } catch {
    // Ohne Konfiguration gilt niemand als angemeldet. Die Anmeldeseite erklärt das Problem.
    valid = false;
  }

  if (!valid) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: ["/admin/:path*"],
};
