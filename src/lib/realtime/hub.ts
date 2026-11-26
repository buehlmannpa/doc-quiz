/**
 * Hub einer Funktionsinstanz: nimmt WebSocket Verbindungen entgegen und verteilt Spielzustände.
 *
 * Grundgedanken:
 * 1. Eine Verbindung ist an genau eine Funktionsinstanz gebunden. Die Teilnehmenden eines Spiels sind auf
 *    mehrere Instanzen verteilt. Redis Publish/Subscribe verbindet die Instanzen.
 * 2. Pro Instanz gibt es EINEN Redis Subscriber (siehe subscriber.ts). Der Hub führt pro Spiel eine "Gruppe"
 *    mit den lokalen Verbindungen. Die erste Verbindung eines Spiels abonniert den Kanal, nach der letzten
 *    wird er mit etwas Verzögerung wieder freigegeben. Die Verzögerung überbrückt den kontrollierten
 *    Neuaufbau der Verbindungen (erst neu verbinden, dann die alte schliessen), ohne das Abonnement zu verlieren.
 * 3. Jede Nachricht enthält den vollständigen Zustand mit Version. Der Hub sendet nur Versionen, die grösser
 *    sind als die zuletzt an die Verbindung gesendete. Doppelte und verspätete Nachrichten sind so harmlos.
 * 4. Beim Verbinden liest der Hub den Zustand immer frisch aus Redis. Dieser Zustandsabgleich ist massgebend,
 *    egal was der Client vorher wusste.
 *
 * Reihenfolge beim Verbinden, damit zwischen Lesen und Abonnieren keine Änderung verloren geht:
 *   a) Zustand lesen und Berechtigung prüfen. Nur wer berechtigt ist, löst ein Abonnement aus.
 *   b) Gruppe anlegen, Kanal abonnieren und die Bestätigung abwarten.
 *   c) Wurde das Abonnement erst nach dem Lesen aktiv, den Zustand noch einmal lesen.
 */
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import type { PublicGameState, PublicPlayer } from "./game-state";
import {
  channelMessageSchema,
  clientMessageSchema,
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type HelloMessage,
  type Role,
  type ServerMessage,
} from "./protocol";
import type { GameStore } from "./store";
import type { SubscriberPort } from "./subscriber";
import { looksLikePlayerToken } from "./tokens";

export type ConnectionContext = {
  /** Ob die Anfrage ein gültiges Admin Cookie trug. Wird vom Endpunkt beim Aufbau geprüft. */
  isAdmin: boolean;
  /** IP Adresse, nur für Logs. */
  ip: string;
};

export type HubLimits = {
  /** Frist für die erste Nachricht (hello) nach dem Aufbau. */
  helloTimeoutMs: number;
  /** Frist für die Bearbeitung der Anmeldung (Redis lesen, abonnieren). Danach gilt der Dienst als nicht verfügbar. */
  joinTimeoutMs: number;
  /** Ab diesem Alter kündigt der Server an, dass die Verbindung bald endet. */
  maxAgeNoticeMs: number;
  /** Ab diesem Alter beendet der Server die Verbindung selbst, bevor es die Plattform bei 300 Sekunden tut. */
  maxAgeCloseMs: number;
  /** Erlaubte Nachrichten pro Sekunde und Verbindung, im Mittel und als kurzer Stoss. */
  messagesPerSecond: number;
  burst: number;
  /** Ab so vielen ungesendeten Bytes gilt ein Client als zu langsam. */
  maxBufferedBytes: number;
  /** So lange bleibt ein Kanal nach der letzten Verbindung noch abonniert. */
  idleUnsubscribeMs: number;
  /**
   * Höchstzahl gleichzeitiger Verbindungen pro Instanz, angemeldet oder nicht. Schützt den Speicher vor vielen
   * unangemeldeten Verbindungen. Ein Quiz braucht rund 60 Verbindungen, die Grenze lässt viel Spielraum.
   */
  maxConnections: number;
};

export const DEFAULT_HUB_LIMITS: HubLimits = {
  helloTimeoutMs: 5_000,
  joinTimeoutMs: 15_000,
  maxAgeNoticeMs: 270_000,
  maxAgeCloseMs: 290_000,
  messagesPerSecond: 10,
  burst: 20,
  maxBufferedBytes: 1_000_000,
  idleUnsubscribeMs: 15_000,
  maxConnections: 300,
};

export type HubOptions = {
  store: GameStore;
  subscriber: SubscriberPort;
  instanceId?: string;
  limits?: Partial<HubLimits>;
  now?: () => number;
  /** Strukturiertes Protokoll. Standardmässig stumm. */
  log?: (event: string, data: Record<string, unknown>) => void;
};

type Group = {
  code: string;
  conns: Set<Connection>;
  /** Löst sich, sobald das Abonnement bestätigt ist. */
  ready: Promise<void>;
  /** Zeitpunkt der Bestätigung, null solange sie aussteht. */
  readyAt: number | null;
  latestVersion: number;
  latestPayload: string | null;
  /** Erstellungszeit des Spiels, dessen Zustand zuletzt gesehen wurde. Unterscheidet zwei Spiele mit demselben Code. */
  createdAt: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

type Connection = {
  id: number;
  ws: WebSocket;
  ctx: ConnectionContext;
  role: Role | null;
  player: PublicPlayer | null;
  group: Group | null;
  connectedAt: number;
  lastSentVersion: number;
  tokens: number;
  refilledAt: number;
  helloStarted: boolean;
  closed: boolean;
  /** Frist für die erste Nachricht. Wird nach dem Eintreffen von hello entfernt. */
  helloTimer: ReturnType<typeof setTimeout> | null;
  /** Weitere Timer der Verbindung (Ankündigung und Ende wegen Alters). */
  timers: ReturnType<typeof setTimeout>[];
};

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export class RealtimeHub {
  readonly instanceId: string;
  private readonly store: GameStore;
  private readonly subscriber: SubscriberPort;
  private readonly limits: HubLimits;
  private readonly now: () => number;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private readonly groups = new Map<string, Group>();
  private readonly connections = new Set<Connection>();
  private nextId = 1;

  constructor(options: HubOptions) {
    this.store = options.store;
    this.subscriber = options.subscriber;
    this.instanceId = options.instanceId ?? randomUUID().slice(0, 8);
    this.limits = { ...DEFAULT_HUB_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    // Nach einer Wiederverbindung des Subscribers den Zustand aller aktiven Spiele neu lesen.
    this.subscriber.onReconnect(() => void this.resyncAll());
  }

  /** Übernimmt einen frisch aufgebauten Socket. Wird vom Endpunkt nach dem WebSocket Upgrade aufgerufen. */
  attach(ws: WebSocket, ctx: ConnectionContext): void {
    if (this.connections.size >= this.limits.maxConnections) {
      // 1013 bedeutet "später noch einmal versuchen". Der Client verbindet sich mit Backoff neu, vielleicht auf einer anderen Instanz.
      this.log("ws_refused", { instanceId: this.instanceId, connections: this.connections.size });
      ws.close(1013, "busy");
      return;
    }
    const now = this.now();
    const conn: Connection = {
      id: this.nextId++,
      ws,
      ctx,
      role: null,
      player: null,
      group: null,
      connectedAt: now,
      lastSentVersion: -1,
      tokens: this.limits.burst,
      refilledAt: now,
      helloStarted: false,
      closed: false,
      helloTimer: null,
      timers: [],
    };
    this.connections.add(conn);
    this.log("ws_open", { instanceId: this.instanceId, conn: conn.id, connections: this.connections.size });

    // Wer sich nicht innert kurzer Frist meldet, belegt nur eine Verbindung. Diese Frist verhindert das.
    conn.helloTimer = setTimeout(
      () => this.reject(conn, CLOSE_CODES.HELLO_TIMEOUT, "hello_timeout", "Es kam keine Anmeldung."),
      this.limits.helloTimeoutMs,
    );
    conn.timers.push(
      setTimeout(() => this.send(conn, { type: "reconnect", reason: "max_age" }), this.limits.maxAgeNoticeMs),
      setTimeout(() => this.closeNow(conn, CLOSE_CODES.ROTATE, "max_age"), this.limits.maxAgeCloseMs),
    );

    ws.on("message", (data: RawData, isBinary: boolean) => this.onMessage(conn, data, isBinary));
    ws.on("close", () => this.onClose(conn));
    ws.on("error", (error: Error) => this.log("ws_error", { conn: conn.id, message: error.message }));
  }

  stats(): { instanceId: string; connections: number; games: number; byRole: Record<Role, number> } {
    const byRole: Record<Role, number> = { player: 0, screen: 0, admin: 0 };
    for (const conn of this.connections) if (conn.role) byRole[conn.role] += 1;
    return { instanceId: this.instanceId, connections: this.connections.size, games: this.groups.size, byRole };
  }

  /** Beendet alle Verbindungen und gibt Ressourcen frei. Für Tests und das geordnete Herunterfahren. */
  async close(): Promise<void> {
    for (const conn of [...this.connections]) this.closeNow(conn, CLOSE_CODES.SERVER_ERROR, "shutdown");
    for (const group of this.groups.values()) if (group.idleTimer) clearTimeout(group.idleTimer);
    this.groups.clear();
    this.subscriber.close();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Nachrichten vom Client
  // ---------------------------------------------------------------------------------------------------------

  private onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    if (conn.closed) return;
    if (!this.takeToken(conn)) {
      this.reject(conn, CLOSE_CODES.RATE_LIMITED, "rate_limited", "Zu viele Nachrichten.");
      return;
    }
    if (isBinary) {
      this.reject(conn, CLOSE_CODES.INVALID_MESSAGE, "invalid_message", "Nur Textnachrichten sind erlaubt.");
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(rawToString(data));
    } catch {
      this.reject(conn, CLOSE_CODES.INVALID_MESSAGE, "invalid_message", "Die Nachricht ist kein gültiges JSON.");
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.reject(conn, CLOSE_CODES.INVALID_MESSAGE, "invalid_message", "Die Nachricht ist ungültig.");
      return;
    }

    const message = parsed.data;
    if (message.type === "ping") {
      this.send(conn, { type: "pong", t0: message.t0, serverTime: this.now() });
      return;
    }
    // Ab hier ist es ein "hello". Es ist nur genau eines erlaubt.
    if (conn.helloStarted) {
      this.reject(conn, CLOSE_CODES.INVALID_MESSAGE, "invalid_message", "Die Anmeldung wurde bereits gesendet.");
      return;
    }
    conn.helloStarted = true;
    void this.handleHello(conn, message).catch((error: unknown) => {
      this.log("hello_failed", { conn: conn.id, message: error instanceof Error ? error.message : String(error) });
      this.reject(conn, CLOSE_CODES.SERVER_ERROR, "server_error", "Der Dienst ist vorübergehend nicht verfügbar.");
    });
  }

  /** Token Bucket: erlaubt kurze Stösse und begrenzt den Dauerdurchsatz. */
  private takeToken(conn: Connection): boolean {
    const now = this.now();
    const elapsedSeconds = (now - conn.refilledAt) / 1000;
    conn.tokens = Math.min(this.limits.burst, conn.tokens + elapsedSeconds * this.limits.messagesPerSecond);
    conn.refilledAt = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  private async handleHello(conn: Connection, hello: HelloMessage): Promise<void> {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    // Hängt Redis, soll die Anmeldung nicht ewig offen bleiben.
    const guard = setTimeout(
      () => this.reject(conn, CLOSE_CODES.SERVER_ERROR, "server_error", "Der Dienst ist vorübergehend nicht verfügbar."),
      this.limits.joinTimeoutMs,
    );
    try {
      await this.completeHello(conn, hello);
    } finally {
      clearTimeout(guard);
    }
  }

  private async completeHello(conn: Connection, hello: HelloMessage): Promise<void> {

    if (hello.role === "admin" && !conn.ctx.isAdmin) {
      this.reject(conn, CLOSE_CODES.UNAUTHORIZED, "unauthorized", "Keine Berechtigung.");
      return;
    }

    // a) Zustand lesen und Berechtigung prüfen, noch ohne Abonnement.
    const readStartedAt = this.now();
    let state: PublicGameState | null;
    let player: PublicPlayer | null = null;
    if (hello.role === "player") {
      const token = hello.token ?? "";
      if (!looksLikePlayerToken(token)) {
        this.reject(conn, CLOSE_CODES.UNAUTHORIZED, "unauthorized", "Das Token ist ungültig.");
        return;
      }
      const auth = await this.store.authenticatePlayer(hello.code, token);
      if (!auth.ok) {
        if (auth.reason === "not_found") this.reject(conn, CLOSE_CODES.GAME_NOT_FOUND, "game_not_found", "Dieses Spiel gibt es nicht.");
        else this.reject(conn, CLOSE_CODES.UNAUTHORIZED, "unauthorized", "Das Token ist ungültig.");
        return;
      }
      state = auth.state;
      player = auth.player;
    } else {
      state = await this.store.getState(hello.code);
      if (!state) {
        this.reject(conn, CLOSE_CODES.GAME_NOT_FOUND, "game_not_found", "Dieses Spiel gibt es nicht.");
        return;
      }
    }
    if (conn.closed) return;

    // b) Gruppe und Abonnement. Erst jetzt, damit unberechtigte Anfragen kein Abonnement auslösen.
    const group = this.ensureGroup(hello.code);
    group.conns.add(conn);
    if (group.idleTimer) {
      clearTimeout(group.idleTimer);
      group.idleTimer = null;
    }
    conn.group = group;
    conn.role = hello.role;
    conn.player = player;
    try {
      await group.ready;
    } catch (error) {
      this.dropFromGroup(conn);
      throw error;
    }
    if (conn.closed) return;

    // c) War das Abonnement beim Lesen noch nicht aktiv, könnte dazwischen eine Änderung verloren gegangen sein.
    if (group.readyAt !== null && group.readyAt >= readStartedAt) {
      const fresh = await this.store.getState(hello.code);
      if (fresh && fresh.version >= state.version) state = fresh;
      if (conn.closed) return;
    }

    this.adoptGame(group, state);

    this.send(conn, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      role: hello.role,
      serverTime: this.now(),
      instanceId: this.instanceId,
      ...(player ? { player } : {}),
    });

    // Hat die Gruppe inzwischen eine neuere Version gesehen, bekommt der Client diese statt des gelesenen Zustands.
    if (group.latestPayload !== null && group.latestVersion > state.version) {
      this.sendRaw(conn, group.latestPayload, group.latestVersion);
    } else {
      const payload = JSON.stringify({ type: "state", version: state.version, state } satisfies ServerMessage);
      if (state.version > group.latestVersion) {
        group.latestVersion = state.version;
        group.latestPayload = payload;
      }
      this.sendRaw(conn, payload, state.version);
    }
    this.log("ws_ready", { conn: conn.id, role: hello.role, code: hello.code, version: state.version });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Gruppen und Verteilung
  // ---------------------------------------------------------------------------------------------------------

  private ensureGroup(code: string): Group {
    const existing = this.groups.get(code);
    if (existing) return existing;
    const group: Group = {
      code,
      conns: new Set(),
      ready: Promise.resolve(),
      readyAt: null,
      latestVersion: -1,
      latestPayload: null,
      createdAt: null,
      idleTimer: null,
    };
    group.ready = this.subscriber
      .subscribe(this.store.channel(code), (raw) => this.onPublished(group, raw))
      .then(() => {
        group.readyAt = this.now();
      })
      .catch((error: unknown) => {
        // Ein gescheitertes Abonnement darf nicht in der Tabelle bleiben, sonst bliebe es für immer kaputt.
        if (this.groups.get(code) === group) this.groups.delete(code);
        throw error;
      });
    this.groups.set(code, group);
    return group;
  }

  private onPublished(group: Group, raw: string): void {
    let parsed: ReturnType<typeof channelMessageSchema.safeParse>;
    try {
      parsed = channelMessageSchema.safeParse(JSON.parse(raw));
    } catch {
      return;
    }
    if (!parsed.success) {
      this.log("channel_message_invalid", { code: group.code });
      return;
    }
    this.deliver(group, parsed.data.v, parsed.data.state);
  }

  /**
   * Erkennt ein neues Spiel unter demselben Code. Ein Code wird nach dem Ende eines Spiels wiederverwendet, und die
   * Gruppe lebt nach der letzten Verbindung noch eine Weile weiter. Beginnt dann ein neues Spiel bei Version 0,
   * dürfen die gemerkten Versionen des alten Spiels nicht mehr gelten, sonst würde das neue Spiel unterdrückt.
   */
  private adoptGame(group: Group, state: PublicGameState): void {
    if (group.createdAt !== null && group.createdAt !== state.createdAt) {
      group.latestVersion = -1;
      group.latestPayload = null;
      for (const conn of group.conns) conn.lastSentVersion = -1;
      this.log("game_replaced", { code: group.code });
    }
    group.createdAt = state.createdAt;
  }

  /** Sendet einen Zustand an alle lokalen Verbindungen des Spiels, sofern er neuer ist als der bekannte. */
  private deliver(group: Group, version: number, state: PublicGameState): void {
    this.adoptGame(group, state);
    if (version <= group.latestVersion) return;
    group.latestVersion = version;
    // Der Text ist für alle gleich und wird nur einmal gebaut.
    const payload = JSON.stringify({ type: "state", version, state } satisfies ServerMessage);
    group.latestPayload = payload;
    for (const conn of group.conns) this.sendRaw(conn, payload, version);
  }

  /** Liest nach einer Wiederverbindung des Subscribers den Zustand aller aktiven Spiele neu. */
  private async resyncAll(): Promise<void> {
    this.log("resync", { instanceId: this.instanceId, games: this.groups.size });
    for (const group of [...this.groups.values()]) {
      try {
        const state = await this.store.getState(group.code);
        if (state) this.deliver(group, state.version, state);
      } catch (error) {
        this.log("resync_failed", { code: group.code, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private dropFromGroup(conn: Connection): void {
    const group = conn.group;
    if (!group) return;
    group.conns.delete(conn);
    conn.group = null;
    if (group.conns.size > 0 || group.idleTimer) return;
    // Letzte Verbindung weg: den Kanal erst nach einer Frist freigeben. Ein kontrollierter Neuaufbau öffnet die
    // neue Verbindung, bevor die alte schliesst, die Frist deckt aber auch den Moment dazwischen ab.
    group.idleTimer = setTimeout(() => {
      if (group.conns.size > 0 || this.groups.get(group.code) !== group) return;
      this.groups.delete(group.code);
      this.subscriber.unsubscribe(this.store.channel(group.code)).catch(() => {
        // Beim Freigeben kann nichts schiefgehen, das für uns wichtig wäre.
      });
    }, this.limits.idleUnsubscribeMs);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Senden und Schliessen
  // ---------------------------------------------------------------------------------------------------------

  private send(conn: Connection, message: ServerMessage): void {
    if (conn.closed || conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(message));
  }

  private sendRaw(conn: Connection, payload: string, version: number): void {
    if (conn.closed || conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.lastSentVersion >= version) return;
    if (conn.ws.bufferedAmount > this.limits.maxBufferedBytes) {
      this.closeNow(conn, CLOSE_CODES.SLOW_CONSUMER, "slow_consumer");
      return;
    }
    conn.lastSentVersion = version;
    conn.ws.send(payload);
  }

  /** Meldet einen Fehler und schliesst die Verbindung mit einem Close Code. */
  private reject(conn: Connection, code: number, key: string, message: string): void {
    this.send(conn, { type: "error", code: key, message });
    this.closeNow(conn, code, key);
  }

  private closeNow(conn: Connection, code: number, reason: string): void {
    if (conn.closed) return;
    this.log("ws_close_request", { conn: conn.id, code, reason, ageMs: this.now() - conn.connectedAt });
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
    // Aufräumen sofort, nicht erst wenn das Close Ereignis kommt, damit nichts mehr gesendet wird.
    this.cleanup(conn);
  }

  private onClose(conn: Connection): void {
    this.log("ws_close", { conn: conn.id, ageMs: this.now() - conn.connectedAt, connections: this.connections.size - 1 });
    this.cleanup(conn);
  }

  private cleanup(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    for (const timer of conn.timers) clearTimeout(timer);
    conn.timers = [];
    this.connections.delete(conn);
    this.dropFromGroup(conn);
  }
}
