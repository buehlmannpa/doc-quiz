"use server";

import { redirect } from "next/navigation";
import { checkPassword } from "@/lib/auth/password";
import { createAdminSession, getClientIp } from "@/lib/auth/session";
import { resolveAdminEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";

export type LoginState = { error: string | null };

const WINDOW_SECONDS = 15 * 60;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Anmeldung mit dem Passwort aus ADMIN_PASSWORD.
 *
 * Schutz gegen Raten: pro IP höchstens 8 Versuche und für alle zusammen höchstens 40 Versuche in
 * 15 Minuten. Nach einem Fehlversuch wartet der Server kurz, bevor er antwortet.
 */
export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const password = formData.get("password");
  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    return { error: "Bitte geben Sie das Passwort ein." };
  }

  let env: ReturnType<typeof resolveAdminEnv>;
  try {
    env = resolveAdminEnv(process.env);
  } catch {
    return { error: "Das Adminportal ist nicht konfiguriert. ADMIN_PASSWORD und SESSION_SECRET fehlen oder sind zu kurz." };
  }

  const ip = await getClientIp();
  const perIp = await rateLimit("login_ip", ip, { limit: 8, windowSeconds: WINDOW_SECONDS });
  const overall = await rateLimit("login_all", "alle", { limit: 40, windowSeconds: WINDOW_SECONDS });
  if (!perIp.allowed || !overall.allowed) {
    const minutes = Math.ceil(Math.max(perIp.retryAfterSeconds, overall.retryAfterSeconds) / 60);
    return { error: `Zu viele Versuche. Bitte warten Sie etwa ${minutes} Minuten.` };
  }

  if (!checkPassword(password, env.adminPassword, env.sessionSecret)) {
    await sleep(600);
    return { error: "Das Passwort stimmt nicht." };
  }

  await createAdminSession();
  // redirect() wirft absichtlich einen Sonderfall und muss deshalb ausserhalb von try und catch stehen.
  redirect("/admin");
}
