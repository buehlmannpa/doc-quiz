import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit lädt .env, aber nicht .env.local. Deshalb laden wir beide Dateien selbst.
config({ path: [".env.local", ".env"], quiet: true });

// Migrationen laufen über die direkte Verbindung (ohne PgBouncer), so empfiehlt es Neon.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

// "generate" braucht keine Verbindung, "migrate" schon. Ein klarer Fehler hilft hier mehr
// als die Meldung von drizzle-kit.
if (!url && process.argv.some((arg) => arg === "migrate" || arg === "push")) {
  throw new Error(
    "DATABASE_URL_UNPOOLED (oder DATABASE_URL) ist nicht gesetzt. Siehe docs/SETUP.md, Abschnitt Migrationen.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: url ?? "" },
});
