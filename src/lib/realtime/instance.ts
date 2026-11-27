/**
 * Verdrahtung des Echtzeit Dienstes für den Betrieb auf Vercel.
 *
 * Pro Funktionsinstanz gibt es einen Spielspeicher (Upstash über REST) und einen Hub mit einem einzigen Redis
 * Subscriber (ioredis über TCP). Beides wird beim ersten Gebrauch angelegt und bleibt für die Lebensdauer der
 * Instanz bestehen. globalThis überlebt auch das Neuladen im Entwicklungsmodus.
 */
import { EnvError, getKeyPrefix, resolveRealtimeLimits, resolveRedisRestEnv, resolveSessionSecret } from "@/lib/env";
import { getRedis } from "@/lib/redis/rest";
import { createTcpRedis } from "@/lib/redis/tcp";
import { GameEngine, type EngineHooks } from "@/lib/game/engine";
import { getSessionRepository } from "@/lib/game/sessions";
import { RealtimeHub } from "./hub";
import { ioredisPort, upstashPort, type RedisPort } from "./redis-port";
import { GameStore } from "./store";
import { ioredisSubscriber } from "./subscriber";

type Instances = { __quizGameStore?: GameStore; __quizHub?: RealtimeHub; __quizEngine?: GameEngine };
const g = globalThis as unknown as Instances;

/**
 * Auf Vercel läuft der Spielspeicher über die REST Schnittstelle von Upstash. Fehlt sie (lokale Entwicklung mit
 * einem eigenen Redis Server), arbeitet er über TCP mit REDIS_URL. Beide Wege führen dieselbe Logik aus.
 */
export function createRedisPort(): RedisPort {
  try {
    resolveRedisRestEnv(process.env);
    return upstashPort(getRedis());
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    return ioredisPort(createTcpRedis("store"));
  }
}

export function getGameStore(): GameStore {
  if (!g.__quizGameStore) {
    g.__quizGameStore = new GameStore(createRedisPort(), {
      prefix: getKeyPrefix(),
      tokenSecret: resolveSessionSecret(process.env),
    });
  }
  return g.__quizGameStore;
}

/**
 * Hooks, die den Spielablauf mit Neon verbinden. Neon wird erst bei Gebrauch angesprochen, nicht beim Anlegen der
 * Engine, damit ein Spiel ohne erreichbare Datenbank (zum Beispiel das Verbindungslabor) trotzdem läuft.
 */
export function createSessionHooks(): EngineHooks {
  return {
    onStarted: async ({ code }) => getSessionRepository().markRunning(code),
    onAborted: async ({ code }) => void (await getSessionRepository().markCancelled(code)),
    onFinished: async (outcome) => void (await getSessionRepository().saveOutcome(outcome)),
  };
}

/** Die Engine des Spielablaufs. Sie hält keinen Spielzustand, alles liegt in Redis. */
export function getEngine(): GameEngine {
  if (!g.__quizEngine) {
    g.__quizEngine = new GameEngine(getGameStore(), {
      hooks: createSessionHooks(),
      persistInBackground: true,
      log: (event, data) => console.log(JSON.stringify({ evt: event, ...data })),
    });
  }
  return g.__quizEngine;
}

export function getHub(): RealtimeHub {
  if (!g.__quizHub) {
    g.__quizHub = new RealtimeHub({
      store: getGameStore(),
      controller: getEngine(),
      subscriber: ioredisSubscriber(createTcpRedis("hub")),
      limits: resolveRealtimeLimits(process.env),
      // Strukturierte Zeilen, in den Vercel Logs gut zu filtern (zum Beispiel nach ws_close).
      log: (event, data) => console.log(JSON.stringify({ evt: event, ...data })),
    });
  }
  return g.__quizHub;
}
