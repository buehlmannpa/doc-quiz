/**
 * Redis Subscriber einer Funktionsinstanz.
 *
 * Pro Instanz gibt es genau eine solche Verbindung (ioredis über TCP), egal wie viele Spiele und Sockets die
 * Instanz bedient. Sie verteilt eingehende Nachrichten an die Handler der jeweiligen Kanäle.
 *
 * Wiederverbindung: ioredis verbindet sich nach einem Abbruch selbständig neu und abonniert die Kanäle wieder.
 * Nachrichten, die in der Lücke veröffentlicht wurden, gehen dabei verloren. Deshalb meldet onReady() jede
 * Wiederverbindung, und der Hub liest dann den Zustand aller aktiven Spiele neu aus Redis.
 */
import type IORedis from "ioredis";

export interface SubscriberPort {
  /** Abonniert einen Kanal. Das Versprechen löst sich, sobald Redis das Abonnement bestätigt hat. */
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  /** Wird nach jeder Wiederverbindung aufgerufen, sobald die Kanäle wieder abonniert sind. */
  onReconnect(handler: () => void): void;
  close(): void;
}

export function ioredisSubscriber(client: IORedis): SubscriberPort {
  const handlers = new Map<string, (message: string) => void>();
  const reconnectHandlers: (() => void)[] = [];
  let connectedBefore = false;

  client.on("message", (channel: string, message: string) => {
    handlers.get(channel)?.(message);
  });

  client.on("ready", () => {
    // "ready" kommt beim ersten Verbinden und bei jeder Wiederverbindung. Nur die Wiederverbindung braucht Heilung.
    const isReconnect = connectedBefore;
    connectedBefore = true;
    if (!isReconnect) return;
    // Ein PING im Subscribe Modus wird nach den Befehlen zum Neuabonnieren beantwortet. Wenn er zurückkommt,
    // sind die Abonnements wieder aktiv, und das Neulesen des Zustands verpasst nichts mehr.
    setTimeout(() => {
      client
        .ping()
        .then(() => {
          for (const handler of reconnectHandlers) handler();
        })
        .catch(() => {
          // Bricht die Verbindung erneut ab, kommt ein weiteres "ready" und ein neuer Versuch.
        });
    }, 0);
  });

  return {
    async subscribe(channel, handler) {
      handlers.set(channel, handler);
      await client.subscribe(channel);
    },
    async unsubscribe(channel) {
      handlers.delete(channel);
      await client.unsubscribe(channel);
    },
    onReconnect(handler) {
      reconnectHandlers.push(handler);
    },
    close() {
      client.disconnect();
    },
  };
}
