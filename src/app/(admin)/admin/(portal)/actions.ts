"use server";

import { redirect } from "next/navigation";
import { destroyAdminSession } from "@/lib/auth/session";

/** Meldet den Admin ab und leitet zur Anmeldung. */
export async function logoutAction(): Promise<void> {
  await destroyAdminSession();
  redirect("/admin/login");
}
