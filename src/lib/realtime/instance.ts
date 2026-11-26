/**
 * Verdrahtung des Echtzeit Dienstes für den Betrieb auf Vercel.
 *
 * Pro Funktionsinstanz gibt es einen Spielspeicher (Upstash über REST) und einen Hub mit einem einzigen Redis
 * Subscriber (ioredis über TCP). Beides wird beim ersten Gebrauch angelegt und bleibt für die Lebensdauer der
 * Instanz bestehen. globalThis überlebt auch das Neuladen im Entwicklungsmodus.
 */
import { getKeyPrefix, resolveSessionSecret } from "@/lib/env";
import { getRedis } from "@/lib/redis/rest";
import { createTcpRedis } from "@/lib/redis/tcp";
import { RealtimeHub } from "./hub";
import { upstashPort } from "./redis-port";
import { GameStore } from "./store";
import { ioredisSubscriber } from "./subscriber";

type Instances = { __quizGameStore?: GameStore; __quizHub?: RealtimeHub };
const g = globalThis as unknown as Instances;

export function getGameStore(): GameStore {
  if (!g.__quizGameStore) {
    g.__quizGameStore = new GameStore(upstashPort(getRedis()), {
      prefix: getKeyPrefix(),
      tokenSecret: resolveSessionSecret(process.env),
    });
  }
  return g.__quizGameStore;
}

export function getHub(): RealtimeHub {
  if (!g.__quizHub) {
    g.__quizHub = new RealtimeHub({
      store: getGameStore(),
      subscriber: ioredisSubscriber(createTcpRedis("hub")),
      // Strukturierte Zeilen, in den Vercel Logs gut zu filtern (zum Beispiel nach ws_close).
      log: (event, data) => console.log(JSON.stringify({ evt: event, ...data })),
    });
  }
  return g.__quizHub;
}
