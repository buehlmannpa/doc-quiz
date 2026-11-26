#!/usr/bin/env node
/**
 * Messskript für den WebSocket Spike (Meilenstein 1).
 *
 * Es öffnet mehrere WebSocket Verbindungen zum Spike Endpunkt eines Preview Deployments und misst:
 * 1. Verbindungsaufbau und die Verteilung auf Funktionsinstanzen.
 * 2. Roundtrip Zeit per Ping und Pong.
 * 3. Zustellung von Publish Nachrichten über Redis an alle Verbindungen (Verluste, Doppelte, Latenz).
 * 4. Optional (--hold): wie lange die Verbindungen leben und mit welchem Close Code sie enden.
 *
 * Beispiel:
 *   npm run spike:ws -- --url https://MEIN-PREVIEW.vercel.app --clients 20 --publishes 100
 *   npm run spike:ws -- --url https://MEIN-PREVIEW.vercel.app --clients 5 --publishes 20 --hold 330
 *
 * Schutz des Preview Deployments: Ist der Vercel Schutz aktiv, braucht das Skript einen Zugang.
 * Mit --bypass TOKEN wird der Header x-vercel-protection-bypass gesendet. Eigene Header gehen mit
 * --header "Name: Wert" (mehrfach möglich). Siehe docs/SPIKE.md.
 */
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

function parseArgs(argv) {
  const out = { header: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (value !== true) i += 1;
    if (key === "header") out.header.push(String(value));
    else out[key] = value;
  }
  return out;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[rank] * 10) / 10;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const args = parseArgs(process.argv.slice(2));
if (!args.url || args.url === true) {
  console.error("Fehlende Angabe: --url https://DEIN-PREVIEW.vercel.app");
  process.exit(2);
}
const base = new URL(String(args.url));
const wsUrl = `${base.protocol === "http:" ? "ws:" : "wss:"}//${base.host}/api/spike/ws`;
const publishUrl = `${base.origin}/api/spike/publish`;
const clients = Number(args.clients ?? 20);
const publishes = Number(args.publishes ?? 100);
const intervalMs = Number(args.interval ?? 50);
const pingCount = Number(args.pings ?? 10);
const holdSeconds = Number(args.hold ?? 0);

const headers = {};
if (args.bypass && args.bypass !== true) headers["x-vercel-protection-bypass"] = String(args.bypass);
for (const line of args.header) {
  const idx = line.indexOf(":");
  if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
}

function connectClient(index) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const client = {
      index,
      ws: null,
      instanceId: null,
      connectMs: null,
      error: null,
      pings: [],
      offsets: [],
      pubs: [],
      closingSoonAtMs: null,
      close: null,
    };
    const ws = new WebSocket(wsUrl, { headers, handshakeTimeout: 15_000 });
    client.ws = ws;
    const timer = setTimeout(() => {
      client.error ??= "Zeitüberschreitung beim Verbinden";
      resolve(client);
    }, 20_000);

    ws.on("unexpected-response", (_req, res) => {
      client.error = `HTTP ${res.statusCode}`;
      clearTimeout(timer);
      resolve(client);
    });
    ws.on("error", (error) => {
      client.error ??= error.message;
    });
    ws.on("message", (data) => {
      const receivedLocal = Date.now();
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type === "hello") {
        client.instanceId = message.instanceId;
        client.connectMs = receivedLocal - startedAt;
        clearTimeout(timer);
        resolve(client);
      } else if (message.type === "pong") {
        const rtt = receivedLocal - message.t0;
        client.pings.push(rtt);
        client.offsets.push(message.serverTime - (message.t0 + rtt / 2));
      } else if (message.type === "pub") {
        client.pubs.push({ ...message, receivedLocal });
      } else if (message.type === "closing_soon") {
        client.closingSoonAtMs = receivedLocal - startedAt;
      }
    });
    ws.on("close", (code, reason) => {
      client.close = { code, reason: reason.toString(), ageMs: Date.now() - startedAt };
      clearTimeout(timer);
      resolve(client);
    });
  });
}

async function main() {
  console.log(`Verbinde ${clients} Clients mit ${wsUrl} ...`);
  const all = [];
  for (let i = 0; i < clients; i += 1) {
    all.push(connectClient(i));
    await sleep(25);
  }
  const connected = await Promise.all(all);
  const ok = connected.filter((c) => c.instanceId);
  const failed = connected.filter((c) => !c.instanceId);

  const distribution = {};
  for (const c of ok) distribution[c.instanceId] = (distribution[c.instanceId] ?? 0) + 1;

  // Ping und Pong, damit wir Roundtrip Zeit und Uhrenabweichung kennen.
  for (let round = 0; round < pingCount; round += 1) {
    for (const c of ok) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: "ping", t0: Date.now() }));
    await sleep(200);
  }

  // Redis Zustellung: Alle Instanzen sollten jede Nachricht erhalten.
  await sleep(1_000);
  let publishResult = null;
  if (publishes > 0) {
    console.log(`Veröffentliche ${publishes} Nachrichten im Abstand von ${intervalMs} ms ...`);
    const response = await fetch(publishUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ count: publishes, intervalMs }),
    });
    if (!response.ok) {
      console.error(`Publish fehlgeschlagen: HTTP ${response.status}`);
    } else {
      publishResult = await response.json();
    }
    await sleep(3_000);
  }

  const serverLatency = [];
  const endToEnd = [];
  let clientsComplete = 0;
  let totalMissing = 0;
  let totalDuplicates = 0;
  for (const c of ok) {
    const own = c.pubs.filter((p) => publishResult && p.runId === publishResult.runId);
    const seen = new Set();
    for (const p of own) {
      if (seen.has(p.seq)) totalDuplicates += 1;
      seen.add(p.seq);
      // Beide Uhren sind Serveruhren, aber unter Umständen von verschiedenen Instanzen.
      serverLatency.push(p.receivedAt - p.publishedAt);
      const offset = c.offsets.length ? percentile(c.offsets, 50) : 0;
      endToEnd.push(p.receivedLocal + offset - p.publishedAt);
    }
    const missing = publishResult ? publishes - seen.size : 0;
    totalMissing += missing;
    if (publishResult && missing === 0) clientsComplete += 1;
  }

  // Optional: warten, bis die Plattform die Verbindungen schliesst.
  let hold = null;
  if (holdSeconds > 0) {
    console.log(`Halte die Verbindungen bis zu ${holdSeconds} s offen und warte auf das Schliessen ...`);
    const deadline = Date.now() + holdSeconds * 1000;
    while (Date.now() < deadline && ok.some((c) => !c.close)) await sleep(1_000);
    const closed = ok.filter((c) => c.close);
    hold = {
      closedCount: closed.length,
      stillOpen: ok.length - closed.length,
      closeAgesSeconds: closed.map((c) => Math.round(c.close.ageMs / 100) / 10),
      closeCodes: Object.fromEntries(
        [...new Set(closed.map((c) => c.close.code))].map((code) => [code, closed.filter((c) => c.close.code === code).length]),
      ),
      closingSoonReceived: ok.filter((c) => c.closingSoonAtMs !== null).length,
    };
  }

  for (const c of ok) if (c.ws.readyState === WebSocket.OPEN) c.ws.close(1000, "Messung beendet");

  const allPings = ok.flatMap((c) => c.pings);
  const summary = {
    config: { url: wsUrl, clients, publishes, intervalMs, pingCount, holdSeconds },
    connect: {
      ok: ok.length,
      failed: failed.length,
      errors: [...new Set(failed.map((c) => c.error ?? (c.close ? `geschlossen mit Code ${c.close.code}` : "unbekannt")))],
      connectMs: { p50: percentile(ok.map((c) => c.connectMs), 50), p95: percentile(ok.map((c) => c.connectMs), 95) },
    },
    instances: { count: Object.keys(distribution).length, distribution },
    ping: { rttMs: { p50: percentile(allPings, 50), p95: percentile(allPings, 95), max: percentile(allPings, 100) } },
    delivery: publishResult
      ? {
          expectedPerClient: publishes,
          clientsComplete,
          clientsWithLoss: ok.length - clientsComplete,
          totalMissing,
          totalDuplicates,
          receiversReportedByRedis: { min: publishResult.receiversMin, max: publishResult.receiversMax },
          serverLatencyMs: { p50: percentile(serverLatency, 50), p95: percentile(serverLatency, 95), max: percentile(serverLatency, 100) },
          endToEndMs: { p50: percentile(endToEnd, 50), p95: percentile(endToEnd, 95), max: percentile(endToEnd, 100) },
          note: "endToEnd nutzt die geschätzte Uhrenabweichung pro Client und ist nur ein Richtwert. serverLatency vergleicht zwei Serveruhren.",
        }
      : null,
    hold,
  };

  writeFileSync("spike-result.json", JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log("Ergebnis gespeichert in spike-result.json");
  process.exit(failed.length === 0 && (!summary.delivery || summary.delivery.totalMissing === 0) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
