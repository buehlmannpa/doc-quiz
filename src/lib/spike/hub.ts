/**
 * Spike: WebSocket Hub einer Funktionsinstanz.
 *
 * Zweck der Messung (Meilenstein 1):
 * 1. Läuft upgradeWebSocket auf dem Hobby Plan in Frankfurt stabil?
 * 2. Wie verteilen sich 20 oder mehr Verbindungen auf Funktionsinstanzen?
 * 3. Erreicht eine Publish Nachricht über Redis (TCP Subscriber mit ioredis) alle Verbindungen
 *    auf allen Instanzen, und mit welcher Latenz?
 * 4. Nach wie vielen Sekunden schliesst die Plattform die Verbindung, und mit welchem Close Code?
 *
 * Aufbau, der später in Meilenstein 3 zum richtigen Hub wird:
 * Pro Instanz gibt es genau einen Redis Subscriber, egal wie viele Sockets die Instanz bedient.
 * Eingehende Redis Nachrichten werden im Speicher an alle lokalen Sockets verteilt.
 */
import { randomUUID } from "node:crypto";
import type { WebSocketData } from "@vercel/functions";
import type { WebSocket } from "ws";
import { createTcpRedis, type TcpRedis } from "@/lib/redis/tcp";
import { spikeChannel } from "./guard";

/** Kennung dieser Funktionsinstanz, damit der Test sieht, wie sich Verbindungen verteilen. */
const instanceId = randomUUID().slice(0, 8);
const instanceStartedAt = Date.now();
const sockets = new Set<WebSocket>();
let subscriber: TcpRedis | null = null;

/** Die Plattform beendet die Verbindung bei 300 s. Ab 285 s warnt der Server den Client. */
const CLOSING_SOON_AFTER_MS = 285_000;
const MAX_INCOMING_BYTES = 2_048;

function rawToString(data: WebSocketData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function log(event: string, data: Record<string, unknown>): void {
  // Strukturiertes Log, in den Vercel Logs gut zu filtern.
  console.log(JSON.stringify({ evt: event, instanceId, ...data }));
}

/** Verteilt eine Redis Nachricht an alle lokalen Sockets. */
function deliver(message: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const receivedAt = Date.now();
  for (const ws of sockets) {
    send(ws, { type: "pub", instanceId, receivedAt, ...(parsed as Record<string, unknown>) });
  }
}

function ensureSubscriber(): void {
  if (subscriber) return;
  const client = createTcpRedis("spike");
  subscriber = client;
  client.on("message", (_channel: string, message: string) => deliver(message));
  client.on("ready", () => log("redis_ready", { sockets: sockets.size }));
  client.on("end", () => log("redis_end", {}));
  client
    .subscribe(spikeChannel())
    .then(() => log("redis_subscribed", { sockets: sockets.size }))
    .catch((error: unknown) => log("redis_subscribe_failed", { message: String(error) }));
}

function releaseSubscriberIfIdle(): void {
  if (sockets.size > 0 || !subscriber) return;
  subscriber.disconnect();
  subscriber = null;
  log("redis_released", {});
}

/** Wird von der Route nach dem Upgrade aufgerufen. */
export function registerSpikeSocket(ws: WebSocket): void {
  const connectedAt = Date.now();
  sockets.add(ws);
  ensureSubscriber();
  log("ws_open", { sockets: sockets.size, instanceAgeMs: connectedAt - instanceStartedAt });

  send(ws, {
    type: "hello",
    instanceId,
    connectedAt,
    instanceAgeMs: connectedAt - instanceStartedAt,
    sockets: sockets.size,
  });

  // Dieser Timer gehört zur einzelnen Verbindung und wird beim Schliessen entfernt.
  // Er dient nur der Messung und ist keine Spiellogik.
  const warnTimer = setTimeout(() => {
    send(ws, { type: "closing_soon", ageMs: Date.now() - connectedAt });
  }, CLOSING_SOON_AFTER_MS);

  ws.on("message", (data: WebSocketData) => {
    const text = rawToString(data);
    if (text.length > MAX_INCOMING_BYTES) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const { type, t0 } = message as { type?: unknown; t0?: unknown };
    if (type === "ping" && typeof t0 === "number") {
      // serverTime erlaubt dem Client, den Unterschied zwischen seiner Uhr und der Serveruhr zu schätzen.
      send(ws, { type: "pong", t0, serverTime: Date.now(), instanceId });
    }
  });

  ws.on("error", (error: Error) => {
    log("ws_error", { message: error.message });
  });

  ws.on("close", (code: number, reason: Buffer) => {
    clearTimeout(warnTimer);
    sockets.delete(ws);
    log("ws_close", {
      code,
      reason: reason.toString("utf8").slice(0, 100),
      ageMs: Date.now() - connectedAt,
      sockets: sockets.size,
    });
    releaseSubscriberIfIdle();
  });
}
