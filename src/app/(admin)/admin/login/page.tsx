import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Logo from "@/components/Logo";
import { hasAdminSession } from "@/lib/auth/session";
import { resolveAdminEnv } from "@/lib/env";
import LoginForm from "./LoginForm";

export const metadata: Metadata = { title: "Anmelden" };

function isConfigured(): boolean {
  try {
    resolveAdminEnv(process.env);
    return true;
  } catch {
    return false;
  }
}

export default async function LoginPage() {
  if (await hasAdminSession()) redirect("/admin");
  const configured = isConfigured();

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <section className="glass-card w-full max-w-sm p-7">
        <Logo className="mx-auto h-20" priority />
        <h1 className="mt-4 text-center text-xl font-bold tracking-tight">Adminportal</h1>
        <p className="text-ink-soft mt-1 text-center text-sm">DOC Bern Quiz</p>
        {configured ? (
          <LoginForm />
        ) : (
          <p role="alert" className="text-danger mt-6 text-sm">
            Das Adminportal ist nicht konfiguriert. Die Variablen ADMIN_PASSWORD (mindestens 8 Zeichen) und
            SESSION_SECRET (mindestens 32 Zeichen) müssen in Vercel gesetzt sein, danach ist ein neues Deployment nötig.
          </p>
        )}
      </section>
    </main>
  );
}
