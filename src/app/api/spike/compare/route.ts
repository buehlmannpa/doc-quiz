/**
 * Spike: vergleicht zwei Wege für Redis SUBSCRIBE innerhalb einer einzigen Funktion.
 *
 * Weg A: ioredis über TCP (Adresse REDIS_URL).
 * Weg B: das Upstash SDK über REST und Server Sent Events (redis.subscribe).
 *
 * Beide abonnieren denselben Testkanal. Die Funktion veröffentlicht danach Nachrichten und misst
 * pro Weg, wie viele ankommen, wie schnell und ob etwas fehlt oder doppelt ist. Gemessen wird mit
 * performance.now() im selben Prozess, es gibt also keine Uhrenabweichung zwischen Geräten.
 *
 * Aufruf: GET /api/spike/compare?count=50&interval=20&idle=0
 * Mit idle=30 wartet die Funktion nach dem Abonnieren 30 Sekunden, bevor sie veröffentlicht.
 * So zeigt sich, ob eine ruhende Subscription still abreisst.
 *
 * Nur mit SPIKE_ENABLED=1 und nie in der Produktion (siehe guard.ts).
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { redisChannel } from "@/lib/redis/keys";
import { getRedis } from "@/lib/redis/rest";
import { createTcpRedis } from "@/lib/redis/tcp";
import { percentile, sleep, spikeGuard } from "@/lib/spike/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

type Collector = {
  name: string;
  readyMs: number | null;
  latencies: number[];
  seen: Set<number>;
  duplicates: number;
  errors: string[];
};

function makeCollector(name: string): Collector {
  return { name, readyMs: null, latencies: [], seen: new Set(), duplicates: 0, errors: [] };
}

function record(collector: Collector, raw: unknown): void {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  let parsed: { seq?: unknown; t?: unknown };
  try {
    parsed = JSON.parse(text) as { seq?: unknown; t?: unknown };
  } catch {
    collector.errors.push("Nachricht ist kein gültiges JSON");
    return;
  }
  if (typeof parsed.seq !== "number" || typeof parsed.t !== "number") return;
  if (collector.seen.has(parsed.seq)) {
    collector.duplicates += 1;
    return;
  }
  collector.seen.add(parsed.seq);
  collector.latencies.push(performance.now() - parsed.t);
}

function summarize(collector: Collector, expected: number) {
  const missing: number[] = [];
  for (let seq = 1; seq <= expected; seq += 1) if (!collector.seen.has(seq)) missing.push(seq);
  return {
    name: collector.name,
    subscribeReadyMs: collector.readyMs === null ? null : Math.round(collector.readyMs),
    received: collector.seen.size,
    expected,
    missingCount: missing.length,
    missingFirst: missing.slice(0, 10),
    duplicates: collector.duplicates,
    latencyMs: {
      p50: percentile(collector.latencies, 50),
      p95: percentile(collector.latencies, 95),
      max: percentile(collector.latencies, 100),
    },
    errors: collector.errors.slice(0, 5),
  };
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export async function GET(request: Request): Promise<NextResponse | Response> {
  const blocked = spikeGuard();
  if (blocked) return blocked;

  const url = new URL(request.url);
  const count = intParam(url, "count", 50, 1, 200);
  const intervalMs = intParam(url, "interval", 20, 0, 500);
  const idleSeconds = intParam(url, "idle", 0, 0, 120);

  const channel = redisChannel("spike", "cmp", randomUUID().slice(0, 8));
  const redis = getRedis();
  const started = performance.now();

  const tcpResult = makeCollector("ioredis über TCP");
  const sdkResult = makeCollector("Upstash SDK über REST und SSE");

  // Weg A: ioredis.
  const tcp = createTcpRedis("spike-compare");
  tcp.on("message", (_channel: string, message: string) => record(tcpResult, message));
  let sdkSubscription: ReturnType<typeof redis.subscribe<string>> | null = null;

  try {
    try {
      await tcp.subscribe(channel);
      tcpResult.readyMs = performance.now() - started;
    } catch (error) {
      tcpResult.errors.push(error instanceof Error ? error.message : String(error));
    }

    // Weg B: Upstash SDK. Das Ereignis "subscribe" bestätigt, dass der Server das Abonnement kennt.
    sdkSubscription = redis.subscribe<string>(channel);
    const sdkReady = new Promise<void>((resolve) => {
      sdkSubscription?.on("subscribe", () => {
        sdkResult.readyMs = performance.now() - started;
        resolve();
      });
    });
    sdkSubscription.on("message", (data) => record(sdkResult, data.message));
    sdkSubscription.on("error", (error) => sdkResult.errors.push(error.message));
    await Promise.race([sdkReady, sleep(5_000)]);
    if (sdkResult.readyMs === null) sdkResult.errors.push("Kein subscribe Ereignis innerhalb von 5 s");

    if (idleSeconds > 0) await sleep(idleSeconds * 1000);

    for (let seq = 1; seq <= count; seq += 1) {
      await redis.publish(channel, JSON.stringify({ seq, t: performance.now() }));
      if (intervalMs > 0 && seq < count) await sleep(intervalMs);
    }
    // Nachzügler abwarten.
    await sleep(2_000);
  } finally {
    tcp.disconnect();
    try {
      await sdkSubscription?.unsubscribe();
    } catch {
      // Das Aufräumen darf das Messergebnis nicht verhindern.
    }
  }

  return NextResponse.json({
    region: process.env.VERCEL_REGION ?? null,
    count,
    intervalMs,
    idleSeconds,
    results: [summarize(tcpResult, count), summarize(sdkResult, count)],
  });
}
