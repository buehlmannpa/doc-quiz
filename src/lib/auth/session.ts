/**
 * Zugriff auf die Admin Session in Server Komponenten, Server Actions und Route Handlers.
 *
 * Wichtig: requireAdmin() gehört in JEDE Seite und JEDE Server Action des Adminportals, nahe an den
 * Daten. Die proxy.ts ist nur die erste Schranke. Layouts allein genügen nicht, weil sie bei der
 * Navigation nicht neu geprüft werden (Hinweis der Next.js Dokumentation).
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveAdminEnv } from "@/lib/env";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./constants";
import { createSessionToken, verifySessionToken } from "./token";

/** Meldet den Admin an: setzt das signierte Cookie. */
export async function createAdminSession(): Promise<void> {
  const { sessionSecret } = resolveAdminEnv(process.env);
  const token = createSessionToken(sessionSecret, Date.now(), SESSION_TTL_SECONDS);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Auf Vercel läuft alles über HTTPS. Lokal mit next dev ist es nicht nötig.
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroyAdminSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Wahr, wenn ein gültiges, nicht abgelaufenes Session Cookie vorliegt. Ohne Konfiguration immer falsch. */
export async function hasAdminSession(): Promise<boolean> {
  // Das Cookie wird ZUERST gelesen. Das macht jede Seite, die diese Funktion nutzt, zu einer dynamischen
  // Seite. Würde man zuerst die Konfiguration prüfen, könnte Next beim Bauen (ohne Variablen) die
  // Umleitung zur Anmeldung vorrendern und für immer festhalten.
  const store = await cookies();
  let secret: string;
  try {
    secret = resolveAdminEnv(process.env).sessionSecret;
  } catch {
    return false;
  }
  return verifySessionToken(secret, store.get(SESSION_COOKIE)?.value, Date.now()).valid;
}

/** Leitet auf die Anmeldung um, wenn keine gültige Session vorliegt. */
export async function requireAdmin(): Promise<void> {
  if (!(await hasAdminSession())) redirect("/admin/login");
}

/** Erste IP Adresse aus der Weiterleitungskette. Wird nur gehasht für das Rate Limiting verwendet. */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip") || "unbekannt";
}
