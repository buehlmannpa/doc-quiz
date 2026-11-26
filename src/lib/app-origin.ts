import { headers } from "next/headers";

/** Adresse dieser App, wie sie der Browser sieht (hinter Vercel Proxy mit den Weiterleitungs Kopfzeilen). */
export async function appOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const forwardedProto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${forwardedProto ?? (local ? "http" : "https")}://${host}`;
}
