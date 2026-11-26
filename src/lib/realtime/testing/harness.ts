/**
 * Hilfen für Integrationstests: eine simulierte Funktionsinstanz mit eigenem Hub, Subscriber und WebSocketServer.
 * Sie hängt den Hub an einen eigenen Server, genau wie es der Endpunkt mit upgradeWebSocket tut.
 */
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import IORedis from "ioredis";
import { WebSocketServer } from "ws";
import { RealtimeHub, type HubLimits } from "../hub";
import type { GameStore } from "../store";
import { ioredisSubscriber } from "../subscriber";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wartet, bis eine Bedingung wahr ist, und wirft sonst einen verständlichen Fehler. */
export async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  what = "Bedingung",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`Zeitüberschreitung beim Warten auf: ${what}`);
}

export type TestInstance = {
  hub: RealtimeHub;
  url: string;
  port: number;
  /** Anzahl der bisher angenommenen WebSocket Verbindungen. */
  accepted: () => number;
  stop: () => Promise<void>;
};

export async function startTestInstance(options: {
  store: GameStore;
  redisUrl: string;
  limits?: Partial<HubLimits>;
  /** Eigene Uhr des Hubs, um eine Abweichung der Serveruhr zu simulieren. */
  now?: () => number;
  /** Fester Port, um eine gestoppte Instanz am selben Ort neu zu starten. */
  port?: number;
}): Promise<TestInstance> {
  const redis = new IORedis(options.redisUrl);
  const hub = new RealtimeHub({
    store: options.store,
    subscriber: ioredisSubscriber(redis),
    limits: options.limits,
    now: options.now,
  });
  const wss = new WebSocketServer({ port: options.port ?? 0, maxPayload: 4096 });
  let accepted = 0;
  wss.on("connection", (ws, request: IncomingMessage) => {
    accepted += 1;
    hub.attach(ws, { isAdmin: request.url?.includes("admin=1") ?? false, ip: "127.0.0.1" });
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;
  return {
    hub,
    port,
    url: `ws://127.0.0.1:${port}`,
    accepted: () => accepted,
    stop: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await hub.close();
    },
  };
}
