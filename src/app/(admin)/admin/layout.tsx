import AdminSidebar from "@/components/AdminSidebar";

/**
 * Layout des Adminportals (PC). Breiter Inhaltsbereich mit Seitenleiste.
 * Login und Schutz der Seiten folgen in Meilenstein 2.
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
