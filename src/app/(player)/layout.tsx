import Link from "next/link";
import Logo from "@/components/Logo";

/**
 * Layout der Spieleransicht (Smartphone, mobile first).
 * Eine schmale Spalte, keine Navigation, grosse Bedienelemente und Rücksicht auf die Sicherheitsränder.
 */
export default function PlayerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="glass-strong safe-top sticky top-0 z-40">
        <div className="mx-auto flex h-14 max-w-md items-center gap-2.5 px-4">
          <Link href="/" aria-label="Zur Startseite">
            <Logo className="h-9" priority />
          </Link>
          <span className="text-base font-bold tracking-tight">DOC Bern Quiz</span>
        </div>
      </header>
      <main className="safe-bottom mx-auto w-full max-w-md flex-1 px-4 pt-6">{children}</main>
    </div>
  );
}
