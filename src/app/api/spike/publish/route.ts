/**
 * Spike: veröffentlicht Testnachrichten über Redis (REST) an den Kanal des WebSocket Tests.
 * Aufruf: POST mit JSON { "count": 100, "intervalMs": 50 }.
 * Nur mit SPIKE_ENABLED=1 und nie in der Produktion (siehe guard.ts).
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getRedis } from "@/lib/redis/rest";
import { sleep, spikeChannel, spikeGuard } from "@/lib/spike/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  // Höchstens 500 Befehle pro Aufruf, damit ein Test das Monatskontingent von Upstash nicht aufbraucht.
  count: z.number().int().min(1).max(500).default(100),
  intervalMs: z.number().int().min(0).max(1000).default(50),
});

export async function POST(request: Request): Promise<NextResponse | Response> {
  const blocked = spikeGuard();
  if (blocked) return blocked;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { count, intervalMs } = parsed.data;

  const redis = getRedis();
  const channel = spikeChannel();
  const runId = randomUUID().slice(0, 8);
  const reached: number[] = [];
  const startedAt = Date.now();

  for (let seq = 1; seq <= count; seq += 1) {
    // publish liefert die Anzahl der Abonnenten, die die Nachricht erhalten haben.
    const receivers = await redis.publish(channel, JSON.stringify({ runId, seq, publishedAt: Date.now() }));
    reached.push(receivers);
    if (intervalMs > 0 && seq < count) await sleep(intervalMs);
  }

  return NextResponse.json({
    runId,
    published: count,
    durationMs: Date.now() - startedAt,
    receiversMin: Math.min(...reached),
    receiversMax: Math.max(...reached),
  });
}
