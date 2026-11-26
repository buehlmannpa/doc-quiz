/**
 * Lokaler WebSocket Server für die Entwicklung.
 *
 * next dev kennt keinen WebSocket Upgrade (den gibt es nur in der Vercel Laufzeit). Dieser Prozess stellt denselben
 * Hub bereit, den auch der Endpunkt /api/ws auf Vercel verwendet, und braucht nur einen lokalen Redis Server.
 *
 * Verwendung in zwei Terminals:
 *   npm run dev:ws     (dieser Server, Port 3001)
 *   npm run dev        (die App, mit NEXT_PUBLIC_WS_URL=ws://localhost:3001/api/ws in .env.local)
 *
 * Nur für die Entwicklung. Der Origin wird hier nicht geprüft, weil die App auf einem anderen Port läuft.
 */
import { config } from "dotenv";
import IORedis from "ioredis";
import { WebSocketServer } from "ws";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { verifySessionToken } from "@/lib/auth/token";
import { getKeyPrefix, resolveRealtimeLimits, resolveRedisTcpEnv, resolveSessionSecret } from "@/lib/env";
import { GameEngine } from "@/lib/game/engine";
import { RealtimeHub } from "@/lib/realtime/hub";
import { createSessionHooks } from "@/lib/realtime/instance";
import { ioredisPort } from "@/lib/realtime/redis-port";
import { GameStore } from "@/lib/realtime/store";
import { ioredisSubscriber } from "@/lib/realtime/subscriber";

config({ path: [".env.local", ".env"], quiet: true });

const port = Number(process.env.DEV_WS_PORT ?? 3001);
const redisUrl = resolveRedisTcpEnv(process.env).url;
const secret = resolveSessionSecret(process.env);

const store = new GameStore(ioredisPort(new IORedis(redisUrl)), { prefix: getKeyPrefix(), tokenSecret: secret });
// Neon wird nur bei Gebrauch angesprochen. Ohne DATABASE_URL läuft das Spiel trotzdem, nur ohne Speichern der Resultate.
const engine = new GameEngine(store, {
  hooks: createSessionHooks(),
  log: (event, data) => console.log(`[engine] ${event} ${JSON.stringify(data)}`),
});
const hub = new RealtimeHub({
  store,
  controller: engine,
  subscriber: ioredisSubscriber(new IORedis(redisUrl)),
  limits: resolveRealtimeLimits(process.env),
  log: (event, data) => {
    if (event === "ws_open" || event === "ws_close" || event === "resync" || event === "game_replaced") {
      console.log(`[hub] ${event} ${JSON.stringify(data)}`);
    }
  },
});

function hasAdminCookie(header: string | undefined): boolean {
  if (!header) return false;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return verifySessionToken(secret, rest.join("="), Date.now()).valid;
  }
  return false;
}

const wss = new WebSocketServer({ port, path: "/api/ws", maxPayload: 4096 });
wss.on("connection", (ws, request) => {
  hub.attach(ws, { isAdmin: hasAdminCookie(request.headers.cookie), ip: request.socket.remoteAddress ?? "lokal" });
});
wss.on("listening", () => console.log(`[hub] WebSocket Server bereit auf ws://localhost:${port}/api/ws (Instanz ${hub.instanceId})`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void hub.close().finally(() => process.exit(0));
  });
}
