import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Adminportal" };

export default async function AdminHomePage() {
  await requireAdmin();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Adminportal</h1>
        <p className="text-ink-soft mt-1 text-sm">Quizzes verwalten und später Durchführungen steuern.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Link href="/admin/quizzes" className="glass-card block p-6 transition-transform hover:-translate-y-0.5">
          <h2 className="text-lg font-semibold">Quizzes</h2>
          <p className="text-ink-soft mt-1 text-sm">Quizzes und Fragen erstellen, bearbeiten, sortieren und archivieren.</p>
        </Link>
        <Link href="/admin/system" className="glass-card block p-6 transition-transform hover:-translate-y-0.5">
          <h2 className="text-lg font-semibold">System</h2>
          <p className="text-ink-soft mt-1 text-sm">Verbindungen zu Neon und Redis, Region und Datenbank Migrationen.</p>
        </Link>
      </div>
    </div>
  );
}
