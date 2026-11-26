"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/session";
import { applyMigrations } from "@/lib/db/migrations";
import { describeError } from "@/lib/health";

export type MigrationActionState = { ok: boolean; message: string } | null;

/** Wendet die offenen Datenbank Migrationen an. Nur für den angemeldeten Admin. */
export async function runMigrationsAction(): Promise<MigrationActionState> {
  await requireAdmin();
  try {
    const { appliedNow } = await applyMigrations();
    revalidatePath("/admin/system");
    return {
      ok: true,
      message:
        appliedNow === 0
          ? "Es gab nichts anzuwenden, die Datenbank ist aktuell."
          : `${appliedNow} Migration(en) angewendet.`,
    };
  } catch (error) {
    return { ok: false, message: `Die Migration ist fehlgeschlagen: ${describeError(error)}` };
  }
}
