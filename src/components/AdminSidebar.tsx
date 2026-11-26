"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Logo from "@/components/Logo";

type NavItem = { href: string; label: string; availableFrom?: string };

/** Einträge, die noch nicht gebaut sind, werden ausgegraut und nennen den Meilenstein. */
const NAV_ITEMS: readonly NavItem[] = [
  { href: "/admin", label: "Übersicht" },
  { href: "/admin/quizzes", label: "Quizzes", availableFrom: "Meilenstein 2" },
  { href: "/admin/games", label: "Durchführung", availableFrom: "Meilenstein 4" },
  { href: "/admin/results", label: "Resultate", availableFrom: "Meilenstein 7" },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
}

/**
 * Navigation des Adminportals. Auf dem PC eine feste Seitenleiste links (wie in der Club App),
 * auf schmalen Fenstern eine Leiste oben.
 */
export default function AdminSidebar() {
  const pathname = usePathname();

  return (
    <>
      {/* PC: Seitenleiste */}
      <aside
        className="glass-strong fixed top-0 left-0 z-40 hidden h-dvh w-64 flex-col lg:flex"
        style={{ borderRight: "1px solid var(--hairline)" }}
      >
        <div className="flex h-16 flex-shrink-0 items-center gap-3 px-5" style={{ borderBottom: "1px solid var(--hairline)" }}>
          <Logo className="h-10" />
          <div className="min-w-0">
            <div className="text-sm leading-tight font-bold tracking-tight">DOC Bern Quiz</div>
            <div className="text-ink-soft text-[11px] leading-tight">Adminportal</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Adminportal">
          <p className="text-ink-soft mb-2 px-3 text-[10px] font-semibold tracking-wider uppercase">Menü</p>
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              if (item.availableFrom) {
                return (
                  <li key={item.href}>
                    <span
                      className="text-ink-soft flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold opacity-60"
                      aria-disabled="true"
                    >
                      {item.label}
                      <span className="tag bg-black/5 text-[10px]">{item.availableFrom}</span>
                    </span>
                  </li>
                );
              }
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className="flex items-center rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors"
                    style={{
                      background: active ? "rgba(var(--accent), 0.1)" : "transparent",
                      color: active ? "var(--accent-hex)" : "var(--color-ink)",
                    }}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      {/* Schmales Fenster: Leiste oben */}
      <header className="glass-strong sticky top-0 z-40 lg:hidden">
        <div className="flex h-14 items-center gap-3 px-4">
          <Logo className="h-9" />
          <span className="text-base font-bold tracking-tight">Adminportal</span>
        </div>
      </header>
    </>
  );
}
