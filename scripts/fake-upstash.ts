/**
 * Startet den Ersatzserver für die REST Schnittstelle von Upstash (nur für die Entwicklung).
 *
 * Auf Vercel läuft der Spielspeicher über das Upstash SDK (HTTP). Mit diesem Server lässt sich derselbe Weg lokal
 * prüfen, gegen einen lokalen Redis. Das hat einen echten Fehler aufgedeckt: Das echte Upstash liefert HGETALL als
 * flaches Array, ioredis als Objekt. Ein Lauf nur über TCP merkt das nicht.
 *
 * Verwendung:
 *   npm run dev:fake-upstash                       (Port 8079, Redis aus REDIS_URL oder redis://127.0.0.1:6379)
 *   UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079 UPSTASH_REDIS_REST_TOKEN=test npm run dev:ws
 *
 * Er ersetzt keinen Test gegen das echte Upstash, sondern prüft, dass unsere Logik mit der Form der Antworten
 * zurechtkommt, die das SDK liefert.
 */
import { config } from "dotenv";
import { startFakeUpstash } from "@/lib/realtime/testing/fake-upstash";

config({ path: [".env.local", ".env"], quiet: true });

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const port = Number(process.env.FAKE_UPSTASH_PORT ?? 8079);

startFakeUpstash(redisUrl, port)
  .then((server) => console.log(`[fake-upstash] bereit auf ${server.url}, Redis ${redisUrl.replace(/\/\/.*@/, "//***@")}`))
  .catch((error: unknown) => {
    console.error("[fake-upstash] Start fehlgeschlagen:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
