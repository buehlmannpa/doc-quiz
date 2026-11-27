/**
 * Ersatzserver für die REST Schnittstelle von Upstash, nur für Tests.
 *
 * Er nimmt Befehle als HTTP Anfragen entgegen (einzeln unter / und gebündelt unter /pipeline) und führt sie
 * auf einem echten lokalen Redis aus. So läuft das echte Upstash SDK in den Tests durch seinen normalen Weg
 * (JSON über HTTP), ohne dass ein Konto oder Netzwerk nötig ist.
 *
 * Grenzen: Der Server bildet das Verhalten von Upstash nicht vollständig nach. Er ersetzt keinen Test gegen
 * die echte Datenbank, sondern prüft, dass unser Adapter das SDK richtig benutzt.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import IORedis from "ioredis";

export type FakeUpstash = { url: string; close: () => Promise<void> };

type CallArg = string | number;

export async function startFakeUpstash(redisUrl: string, listenPort = 0): Promise<FakeUpstash> {
  const redis = new IORedis(redisUrl);

  const run = (command: unknown): Promise<unknown> => {
    if (!Array.isArray(command) || command.length === 0) throw new Error("ERR Ungültiger Befehl");
    const [name, ...args] = command.map((part) => (typeof part === "number" ? part : String(part))) as CallArg[];
    // ioredis wandelt die Antwort von HGETALL selbst in ein Objekt um, auch bei call(). Das echte Upstash liefert, wie
    // Redis, ein flaches Array (Feld, Wert, Feld, Wert ...). Ein Skript umgeht die Umwandlung und bildet die echte
    // Antwort nach. Ein früherer Fehler blieb genau deshalb unentdeckt: Der Adapter bekam im Test ein Objekt, in Betrieb ein Array.
    if (String(name).toLowerCase() === "hgetall") {
      return redis.eval("return redis.call('HGETALL', KEYS[1])", 1, String(args[0]));
    }
    return redis.call(String(name), ...args.map(String));
  };

  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    try {
      if (request.url?.startsWith("/pipeline")) {
        const results: unknown[] = [];
        for (const command of body as unknown[]) {
          try {
            results.push({ result: await run(command) });
          } catch (error) {
            results.push({ error: error instanceof Error ? error.message : String(error) });
          }
        }
        send(200, results);
      } else {
        send(200, { result: await run(body) });
      }
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(listenPort, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      redis.disconnect();
    },
  };
}
