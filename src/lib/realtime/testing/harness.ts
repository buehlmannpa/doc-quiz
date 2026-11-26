/**
 * Hilfen für Integrationstests: eine simulierte Funktionsinstanz mit eigenem Hub, Subscriber und WebSocketServer.
 * Sie hängt den Hub an einen eigenen Server, genau wie es der Endpunkt mit upgradeWebSocket tut.
 */
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import IORedis from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import type { GameController } from "../controller";
import { RealtimeHub, type HubLimits } from "../hub";
import { serverMessageSchema, type ServerMessage } from "../protocol";
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
  /** Spiellogik, die Antworten und Befehle bearbeitet. */
  controller?: GameController;
  /** Eigene Uhr des Hubs, um eine Abweichung der Serveruhr zu simulieren. */
  now?: () => number;
  /** Fester Port, um eine gestoppte Instanz am selben Ort neu zu starten. */
  port?: number;
}): Promise<TestInstance> {
  const redis = new IORedis(options.redisUrl);
  const hub = new RealtimeHub({
    store: options.store,
    subscriber: ioredisSubscriber(redis),
    controller: options.controller,
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

/** Ein einfacher WebSocket Client für Tests, der alle Nachrichten des Servers prüft und sammelt. */
export class TestSocket {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      this.messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.ws.on("error", () => {});
  }

  async open(): Promise<this> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        this.ws.once("open", () => resolve());
        this.ws.once("error", reject);
      });
    }
    return this;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  hello(role: "player" | "screen" | "admin", code: string, token?: string): void {
    this.send({ type: "hello", protocol: 1, role, code, ...(token ? { token } : {}) });
  }

  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  }

  /** Der zuletzt empfangene Zustand. */
  lastState() {
    return this.of("state").at(-1)?.state ?? null;
  }

  close(): void {
    this.ws.close();
  }
}
