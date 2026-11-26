import type { Metadata } from "next";
import StatusPill from "@/components/StatusPill";
import { requireAdmin } from "@/lib/auth/session";
import { getMigrationStatus, type MigrationStatus } from "@/lib/db/migrations";
import { describeError, runHealthChecks, type CheckResult } from "@/lib/health";
import MigrateButton from "./MigrateButton";

export const metadata: Metadata = { title: "System" };
// Der Systemcheck braucht aktuelle Werte, und ein Kaltstart von Neon kann einige Sekunden dauern.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function loadMigrationStatus(): Promise<{ status: MigrationStatus } | { error: string }> {
  try {
    return { status: await getMigrationStatus() };
  } catch (error) {
    return { error: describeError(error) };
  }
}

function CheckRow({ label, check }: { label: string; check: CheckResult }) {
  const pill =
    check.status === "ok" ? (
      <StatusPill tone="ok">in Ordnung</StatusPill>
    ) : check.status === "skipped" ? (
      <StatusPill tone="warn">nicht eingerichtet</StatusPill>
    ) : (
      <StatusPill tone="error">Fehler</StatusPill>
    );
  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="font-semibold">{label}</span>
        {pill}
      </div>
      {check.firstMs !== undefined ? (
        <p className="text-ink-soft mt-1 text-sm">
          Erste Anfrage {check.firstMs} ms, zweite Anfrage {check.warmMs} ms
        </p>
      ) : null}
      {check.message ? <p className="mt-1 text-sm">{check.message}</p> : null}
    </li>
  );
}

export default async function SystemPage() {
  await requireAdmin();
  const [report, migrations] = await Promise.all([runHealthChecks(), loadMigrationStatus()]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">System</h1>
        <p className="text-ink-soft mt-1 text-sm">
          Zustand der Verbindungen zu Neon und Redis, Region der Funktionen und Datenbank Migrationen.
        </p>
      </header>

      <section className="glass-card p-6">
        <h2 className="text-lg font-semibold">Umgebung</h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Region der Funktionen</dt>
            <dd className="flex items-center gap-2 font-semibold">
              {report.region ?? "lokal"}
              {report.regionOk === true ? <StatusPill tone="ok">Frankfurt</StatusPill> : null}
              {report.regionOk === false ? <StatusPill tone="error">erwartet {report.expectedRegion}</StatusPill> : null}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Deployment</dt>
            <dd className="font-semibold">{report.deployment}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Präfix der Redis Schlüssel</dt>
            <dd className="font-semibold">{report.keyPrefix}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Version (Commit)</dt>
            <dd className="font-semibold">{report.commit ?? "unbekannt"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Node</dt>
            <dd className="font-semibold">{report.node}</dd>
          </div>
        </dl>
      </section>

      <section className="glass-card p-6">
        <h2 className="text-lg font-semibold">Verbindungen</h2>
        <ul className="divide-y divide-black/5">
          <CheckRow label="Neon Postgres" check={report.checks.database} />
          <CheckRow label="Upstash Redis über REST" check={report.checks.redisRest} />
          <CheckRow label="Upstash Redis über TCP (Subscriber)" check={report.checks.redisTcp} />
        </ul>
        <p className="text-ink-soft mt-3 text-xs">
          Gesetzte Variablen (nur Namen): Datenbank {report.envPresent.database.join(", ") || "keine"}. Redis REST{" "}
          {report.envPresent.redisRest.join(", ") || "keine"}. Redis TCP {report.envPresent.redisTcp.join(", ") || "keine"}.
        </p>
      </section>

      <section className="glass-card p-6">
        <h2 className="text-lg font-semibold">Datenbank Migrationen</h2>
        {"error" in migrations ? (
          <p className="text-danger mt-3 text-sm">Der Stand konnte nicht gelesen werden: {migrations.error}</p>
        ) : (
          <div className="mt-3 space-y-4">
            <p className="text-sm">
              Angewendet: <strong>{migrations.status.applied}</strong> von <strong>{migrations.status.available}</strong>.
              Offen: <strong>{migrations.status.pending}</strong>.
            </p>
            {!migrations.status.directUrlConfigured ? (
              <p className="text-danger text-sm">
                Die Variable DATABASE_URL_UNPOOLED fehlt. Sie wird zum Anwenden der Migrationen benötigt.
              </p>
            ) : null}
            {migrations.status.pending === 0 ? (
              <p className="text-ink-soft text-sm">Die Datenbank ist auf dem aktuellen Stand.</p>
            ) : (
              <p className="text-ink-soft text-sm">
                Der Knopf führt ausschliesslich die Migrationsdateien aus dem Repository aus. Eigenes SQL ist nicht möglich.
              </p>
            )}
            <MigrateButton
              disabled={migrations.status.pending === 0 || !migrations.status.directUrlConfigured}
            />
          </div>
        )}
      </section>
    </div>
  );
}
