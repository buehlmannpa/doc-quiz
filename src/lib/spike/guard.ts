/**
 * Schutz der Spike Endpunkte (Messungen in Meilenstein 1).
 *
 * Die Endpunkte sind doppelt gesichert: Sie brauchen SPIKE_ENABLED=1 und sie sind in der
 * Produktion grundsätzlich gesperrt, auch wenn die Variable dort versehentlich gesetzt wäre.
 * Nach der Auswertung werden die Endpunkte entfernt.
 */
import { isSpikeEnabled, resolveDeploymentEnv } from "@/lib/env";
import { redisChannel } from "@/lib/redis/keys";

/** Liefert eine 404 Antwort, wenn die Spike Endpunkte nicht freigegeben sind, sonst null. */
export function spikeGuard(): Response | null {
  const allowed = isSpikeEnabled(process.env) && resolveDeploymentEnv(process.env) !== "production";
  return allowed ? null : new Response("Not found", { status: 404 });
}

/** Gemeinsamer Kanal für den WebSocket Test (Publisher und alle Instanzen). */
export function spikeChannel(): string {
  return redisChannel("spike", "main");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Perzentil einer sortierten oder unsortierten Liste (nearest rank), gerundet auf 0.1. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round((sorted[rank] ?? 0) * 10) / 10;
}
