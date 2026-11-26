import AdminSidebar from "@/components/AdminSidebar";

/**
 * Layout des Adminportals (PC). Breiter Inhaltsbereich mit Seitenleiste.
 *
 * Der Zugriffsschutz steckt nicht hier, sondern in jeder Seite und Server Action (requireAdmin).
 * Ein Layout wird bei der Navigation nicht neu geprüft und schützt deshalb nicht zuverlässig.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <AdminSidebar />
      <div className="lg:pl-64">
        <main className="mx-auto max-w-6xl px-4 pt-6 pb-12 lg:px-10 lg:pt-10">{children}</main>
      </div>
    </div>
  );
}
