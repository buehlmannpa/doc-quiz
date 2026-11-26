/**
 * Client der Echtzeit Verbindung mit der Verbindungsstrategie. Unabhängig von Browser und React.
 * Im Browser nimmt er den WebSocket des Browsers, in Tests die Bibliothek ws.
 *
 * Verbindungsstrategie (siehe CLAUDE.md):
 * 1. Kontrollierter Neuaufbau ("rotate"): Erst wird eine NEUE Verbindung aufgebaut und angemeldet. Sobald sie den
 *    vollständigen Zustand geliefert hat, wird die alte geschlossen. Für die Teilnehmenden ist das unsichtbar,
 *    und auch eine Änderung genau in diesem Moment geht nicht verloren, weil der Zustand beim Verbinden massgebend ist.
 *    Ausgelöst wird er nach jeder Auflösung (rotateSoon, mit zufälliger Verzögerung), durch die Altersgrenze
 *    von 240 Sekunden und durch die Ankündigung des Servers.
 * 2. Absicherung: Bei jedem unerwarteten Abbruch (Bildschirmsperre, Netzwechsel, Neuladen, Plattformgrenze)
 *    verbindet sich der Client mit Backoff neu. Der Close Code der Plattform ist nicht dokumentiert, deshalb gilt
 *    jeder Abbruch ausser den endgültigen Fehlern (keine Berechtigung, Spiel gibt es nicht) als vorübergehend.
 * 3. Versionen: Eine Nachricht wird nur übernommen, wenn ihre Version grösser ist als die bekannte. Beim
 *    Neuaufbau laufen kurz zwei Verbindungen, die Doppelten fallen so weg.
 * 4. Uhrenabgleich: Mit wenigen Ping Pong Runden schätzt der Client den Unterschied zu seiner Uhr (kleinste
 *    Laufzeit gewinnt). serverNow() liefert die Serverzeit für den Countdown.
 * 5. Spielablauf: answer() und command() senden Nachrichten und warten auf die Quittung des Servers. Mit
 *    autoTick meldet der Client dem Server, dass die Zeit einer Frage abgelaufen ist (es gibt keine Server Timer).
 *    Der Server prüft die Frist selbst. Mit rotateAfterResolveMs baut der Client nach jeder Auflösung die Verbindung
 *    kontrolliert neu auf, damit sie die Grenze von 300 Sekunden nie während einer Frage erreicht.
 */
import type { PublicGameState } from "./game-state";
import {
  CLOSE_CODES,
  FATAL_CLOSE_CODES,
  PROTOCOL_VERSION,
  serverMessageSchema,
  type Command,
  type Role,
  type ServerMessage,
} from "./protocol";

/** Die wenigen Eigenschaften eines WebSockets, die der Client braucht. Browser und ws erfüllen sie beide. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export type ClientStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";
export type ConnectReason = "initial" | "retry" | "rotate";

export type ClientEvent =
  | { type: "connecting"; reason: ConnectReason; attempt: number }
  | { type: "ready"; reason: ConnectReason; instanceId: string; connectMs: number }
  | { type: "closed"; code: number; reason: string; ageMs: number; expected: boolean }
  | { type: "retry"; attempt: number; inMs: number }
  | { type: "rotate"; why: string }
  | { type: "fatal"; code: number; message: string }
  | { type: "clock"; offsetMs: number; rttMs: number }
  | { type: "dead"; silentMs: number };

export type AckResult = { ok: true } | { ok: false; error: string };

export type ClientTiming = {
  /** Ab diesem Alter einer Verbindung wird sie kontrolliert neu aufgebaut. Der Server beendet sie bei 290 Sekunden. */
  maxAgeMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Frist, bis nach dem Aufbau Willkommen und Zustand da sein müssen. */
  handshakeTimeoutMs: number;
  pingCount: number;
  pingIntervalMs: number;
  /** Abstand der Herzschläge. Kommt dreimal so lange nichts vom Server, gilt die Verbindung als tot. */
  heartbeatMs: number;
  /** Wie lange auf die Quittung einer Antwort oder eines Befehls gewartet wird. */
  ackTimeoutMs: number;
  /** Abstand der Zeithinweise, solange eine abgelaufene Frage nicht aufgelöst ist. */
  tickRetryMs: number;
};

export const DEFAULT_CLIENT_TIMING: ClientTiming = {
  maxAgeMs: 240_000,
  backoffBaseMs: 500,
  backoffMaxMs: 10_000,
  handshakeTimeoutMs: 10_000,
  pingCount: 5,
  pingIntervalMs: 150,
  heartbeatMs: 15_000,
  ackTimeoutMs: 6_000,
  tickRetryMs: 2_000,
};

export type ClientOptions = {
  url: string | (() => string);
  role: Role;
  code: string;
  token?: string;
  createSocket: SocketFactory;
  onState?: (state: PublicGameState) => void;
  onStatus?: (status: ClientStatus) => void;
  onEvent?: (event: ClientEvent) => void;
  /** Fortschritt der Antworten (nur Beamer und Admin erhalten ihn). */
  onProgress?: (progress: { q: number; n: number }) => void;
  /** Eine Bubble hüpft (nur Beamer und Admin). */
  onNudge?: (playerId: string) => void;
  /** Die eigene Antwort auf die Frage q, nach einer Wiederverbindung. */
  onMine?: (mine: { q: number; option?: number; value?: number }) => void;
  /**
   * Zeithinweise an den Server, sobald die Zeit einer Frage abgelaufen ist. extraDelayMs ist die Wartezeit nach dem
   * Ablauf (Beamer und Admin 0, Smartphones etwas länger, sie sind nur die Absicherung).
   */
  autoTick?: { extraDelayMs: number } | false;
  /** Nach der Auflösung einer Frage die Verbindung nach zufälliger Wartezeit bis zu diesem Wert neu aufbauen. */
  rotateAfterResolveMs?: number;
  timing?: Partial<ClientTiming>;
  random?: () => number;
  now?: () => number;
};

/** Wartezeit vor dem nächsten Verbindungsversuch: exponentiell wachsend, mit Zufall zwischen 50 und 100 Prozent. */
export function computeBackoffMs(
  attempt: number,
  random: () => number = Math.random,
  baseMs = DEFAULT_CLIENT_TIMING.backoffBaseMs,
  maxMs = DEFAULT_CLIENT_TIMING.backoffMaxMs,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(cap / 2 + random() * (cap / 2));
}

export type ClockSample = { offsetMs: number; rttMs: number };

/**
 * Eine Messung für den Uhrenabgleich. t0 ist die Zeit des Clients beim Senden, t1 beim Empfang der Antwort.
 * Die Serverzeit gilt als Mitte der Laufzeit. Der Fehler ist höchstens die halbe Laufzeit.
 */
export function clockSample(t0: number, t1: number, serverTime: number): ClockSample {
  const rttMs = t1 - t0;
  return { rttMs, offsetMs: serverTime - (t0 + rttMs / 2) };
}

/** Behält die Messung mit der kleinsten Laufzeit, sie ist die genaueste. */
export function betterSample(current: ClockSample | null, candidate: ClockSample): ClockSample {
  return current === null || candidate.rttMs < current.rttMs ? candidate : current;
}

const OPEN = 1;

type Session = {
  id: number;
  socket: SocketLike;
  reason: ConnectReason;
  openedAt: number;
  welcomed: boolean;
  instanceId: string | null;
  /** Wird beabsichtigt geschlossen (Neuaufbau, stop). Dann ist das Schliessen erwartet. */
  closing: boolean;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  pingTimers: ReturnType<typeof setTimeout>[];
};

export class RealtimeClient {
  private readonly timing: ClientTiming;
  private readonly random: () => number;
  private readonly now: () => number;
  private status: ClientStatus = "idle";
  private active: Session | null = null;
  private pending: Session | null = null;
  private state: PublicGameState | null = null;
  private lastVersion = -1;
  private attempt = 0;
  private stopped = false;
  private clock: ClockSample | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private ageTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSessionId = 1;
  private nextMessageId = 1;
  /** Auf Quittung wartende Antworten und Befehle nach Kennung. */
  private readonly acks = new Map<string, { resolve: (result: AckResult) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Kennungen der Sitzungen, auf denen schon ein Zustand angekommen ist (Anmeldung abgeschlossen). */
  private readonly seen = new Set<number>();
  /** Zeitpunkt der letzten Nachricht von der aktiven Verbindung, für die Lebendprüfung. */
  private lastMessageAt = 0;

  constructor(private readonly options: ClientOptions) {
    this.timing = { ...DEFAULT_CLIENT_TIMING, ...options.timing };
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  getStatus(): ClientStatus {
    return this.status;
  }

  getState(): PublicGameState | null {
    return this.state;
  }

  /** Serverzeit in Millisekunden. Vor der ersten Messung entspricht sie der eigenen Uhr. */
  serverNow(): number {
    return this.now() + (this.clock?.offsetMs ?? 0);
  }

  getClock(): ClockSample | null {
    return this.clock;
  }

  /** Kennung der Instanz, auf der die aktive Verbindung läuft. Nur für Diagnose. */
  getInstanceId(): string | null {
    return this.active?.instanceId ?? null;
  }

  /**
   * Sendet die Antwort auf eine Frage. Das Ergebnis ist die Quittung des Servers. Ohne Verbindung oder ohne
   * Quittung innert der Frist ist es ein Fehler: Bei "timeout" ist offen, ob der Server die Antwort noch erhalten hat.
   * Nach einer Wiederverbindung meldet der Server die eigene Antwort (onMine), so lässt sich das klären.
   */
  answer(q: number, answer: { option: number } | { value: number }): Promise<AckResult> {
    return this.request({ type: "answer", q, ...answer });
  }

  /** Sendet einen Steuerbefehl des Admins. expectedVersion schützt vor doppelten Klicks. */
  command(cmd: Command, expectedVersion?: number): Promise<AckResult> {
    return this.request({ type: "cmd", cmd, ...(expectedVersion !== undefined ? { expectedVersion } : {}) });
  }

  /** Lässt die eigene Bubble im Warteraum hüpfen. Der Server begrenzt auf einmal pro 2 Sekunden. */
  nudge(): void {
    this.sendRaw({ type: "nudge" });
  }

  /** Meldet dem Server, dass die Zeit der Frage abgelaufen ist. Er prüft die Frist selbst. */
  tick(): void {
    this.sendRaw({ type: "tick" });
  }

  private sendRaw(message: object): boolean {
    const active = this.active;
    if (!active || active.socket.readyState !== OPEN || !this.seen.has(active.id)) return false;
    active.socket.send(JSON.stringify(message));
    return true;
  }

  private request(message: { type: "answer" | "cmd" } & Record<string, unknown>): Promise<AckResult> {
    const id = `m${this.nextMessageId++}`;
    return new Promise<AckResult>((resolve) => {
      if (!this.sendRaw({ ...message, id })) {
        resolve({ ok: false, error: "offline" });
        return;
      }
      const timer = setTimeout(() => {
        this.acks.delete(id);
        resolve({ ok: false, error: "timeout" });
      }, this.timing.ackTimeoutMs);
      this.acks.set(id, { resolve, timer });
    });
  }

  private settleAck(id: string, result: AckResult): void {
    const entry = this.acks.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.acks.delete(id);
    entry.resolve(result);
  }

  /** Bricht alle wartenden Quittungen ab, wenn die aktive Verbindung weg ist. Ob die Nachricht ankam, ist dann offen. */
  private failAcks(error: string): void {
    for (const id of [...this.acks.keys()]) this.settleAck(id, { ok: false, error });
  }

  start(): void {
    if (this.status !== "idle" && this.status !== "closed") return;
    this.stopped = false;
    this.attempt = 0;
    this.open("initial");
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    for (const session of [this.active, this.pending]) {
      if (session) this.closeSession(session, 1000, "stop");
    }
    this.active = null;
    this.pending = null;
    this.failAcks("offline");
    this.setStatus("closed");
  }

  /**
   * Kontrollierter Neuaufbau: neue Verbindung öffnen, und erst wenn sie den Zustand geliefert hat, die alte
   * schliessen. Ohne aktive Verbindung ist es ein gewöhnlicher Neuaufbau.
   */
  rotate(why = "manual"): void {
    if (this.stopped) return;
    this.options.onEvent?.({ type: "rotate", why });
    if (!this.active) {
      this.reconnectNow();
      return;
    }
    if (this.pending) return; // Ein Neuaufbau läuft schon.
    this.open("rotate");
  }

  /** Neuaufbau nach einer zufälligen Wartezeit. So melden sich nicht alle Geräte im selben Moment. */
  rotateSoon(maxJitterMs: number, why = "scheduled"): void {
    if (this.stopped || this.rotateTimer) return;
    this.rotateTimer = setTimeout(() => {
      this.rotateTimer = null;
      this.rotate(why);
    }, Math.round(this.random() * maxJitterMs));
  }

  /** Verbindet sofort, ohne den Backoff abzuwarten. Zum Beispiel wenn die Seite wieder sichtbar wird. */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.status === "open" && this.active) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.active || this.pending) return; // Ein Versuch läuft schon.
    this.open(this.status === "idle" ? "initial" : "retry");
  }

  /** Bricht die aktive Verbindung ab, als wäre das Netz weg. Nur für Tests und das Labor. */
  simulateDrop(code = 4000): void {
    this.active?.socket.close(code, "simulierter Abbruch");
  }

  // ---------------------------------------------------------------------------------------------------------

  private setStatus(status: ClientStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private clearTimers(): void {
    for (const timer of [this.retryTimer, this.ageTimer, this.rotateTimer, this.tickTimer]) if (timer) clearTimeout(timer);
    this.retryTimer = this.ageTimer = this.rotateTimer = this.tickTimer = null;
    this.stopHeartbeat();
  }

  private open(reason: ConnectReason): void {
    const url = typeof this.options.url === "function" ? this.options.url() : this.options.url;
    const socket = this.options.createSocket(url);
    const session: Session = {
      id: this.nextSessionId++,
      socket,
      reason,
      openedAt: this.now(),
      welcomed: false,
      instanceId: null,
      closing: false,
      handshakeTimer: null,
      pingTimers: [],
    };

    if (reason === "rotate") this.pending = session;
    else {
      this.active = session;
      this.setStatus(reason === "initial" && this.state === null ? "connecting" : "reconnecting");
    }
    this.options.onEvent?.({ type: "connecting", reason, attempt: this.attempt });

    // Kommen Willkommen und Zustand nicht rechtzeitig, gilt die Verbindung als gescheitert.
    session.handshakeTimer = setTimeout(() => {
      // Hat die Sitzung bis jetzt keinen Zustand bekommen, ist sie gescheitert. Das Schliessen löst den Neuversuch aus.
      if (!this.seen.has(session.id)) this.closeSession(session, 4000, "handshake_timeout", false);
    }, this.timing.handshakeTimeoutMs);

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          role: this.options.role,
          code: this.options.code,
          ...(this.options.token ? { token: this.options.token } : {}),
        }),
      );
    };
    socket.onmessage = (event) => this.onMessage(session, event.data);
    socket.onclose = (event) => this.onClose(session, event.code, event.reason);
    socket.onerror = () => {
      // Auf einen Fehler folgt immer ein Schliessen, dort wird er behandelt.
    };
  }

  private closeSession(session: Session, code: number, reason: string, expected = true): void {
    session.closing = expected;
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    for (const timer of session.pingTimers) clearTimeout(timer);
    session.pingTimers = [];
    try {
      session.socket.close(code, reason);
    } catch {
      // Eine bereits geschlossene Verbindung braucht kein weiteres Schliessen.
    }
  }

  private onMessage(session: Session, data: unknown): void {
    if (typeof data !== "string") return;
    if (session === this.active) this.lastMessageAt = this.now();
    let message: ServerMessage;
    try {
      const parsed = serverMessageSchema.safeParse(JSON.parse(data));
      if (!parsed.success) return;
      message = parsed.data;
    } catch {
      return;
    }

    switch (message.type) {
      case "welcome":
        session.welcomed = true;
        session.instanceId = message.instanceId;
        this.startClockSync(session);
        break;
      case "state":
        this.onState(session, message.state);
        break;
      case "pong": {
        const sample = clockSample(message.t0, this.now(), message.serverTime);
        const best = betterSample(this.clock, sample);
        if (best !== this.clock) {
          this.clock = best;
          this.options.onEvent?.({ type: "clock", offsetMs: best.offsetMs, rttMs: best.rttMs });
        }
        break;
      }
      case "ack":
        if (message.id !== undefined) {
          this.settleAck(message.id, message.ok ? { ok: true } : { ok: false, error: message.error ?? "unknown" });
        }
        break;
      case "progress":
        this.options.onProgress?.({ q: message.q, n: message.n });
        break;
      case "nudge":
        this.options.onNudge?.(message.id);
        break;
      case "mine":
        this.options.onMine?.({
          q: message.q,
          ...(message.option !== undefined ? { option: message.option } : {}),
          ...(message.value !== undefined ? { value: message.value } : {}),
        });
        break;
      case "reconnect":
        // Der Server kündigt das Ende dieser Verbindung an. Jetzt ist der beste Moment für den Neuaufbau.
        if (session === this.active) this.rotate("server_notice");
        break;
      case "error":
        // Die Verbindung wird gleich geschlossen. Dort wird entschieden, ob es ein endgültiger Fehler ist.
        break;
    }
  }

  private onState(session: Session, state: PublicGameState): void {
    this.seen.add(session.id);
    // Ein anderes Spiel unter demselben Code (Erstellungszeit anders) beginnt wieder bei Version 0.
    const isNewGame = this.state !== null && state.createdAt !== this.state.createdAt;
    if (isNewGame) this.lastVersion = -1;

    if (state.version > this.lastVersion) {
      const previous = this.state;
      this.lastVersion = state.version;
      this.state = state;
      this.options.onState?.(state);
      this.onStateAccepted(previous, state);
    }

    // Die erste Nachricht einer Verbindung schliesst deren Anmeldung ab.
    if (session === this.pending) {
      this.promote(session);
    } else if (session === this.active && this.status !== "open") {
      this.attempt = 0;
      this.setStatus("open");
      this.armAgeTimer();
      this.startHeartbeat();
      this.options.onEvent?.({
        type: "ready",
        reason: session.reason,
        instanceId: session.instanceId ?? "",
        connectMs: this.now() - session.openedAt,
      });
    }
  }

  /** Reaktionen auf einen neuen Zustand: Zeithinweis planen, nach der Auflösung die Verbindung erneuern. */
  private onStateAccepted(previous: PublicGameState | null, state: PublicGameState): void {
    this.armTick(state);
    const resolvedNow =
      previous !== null &&
      previous.createdAt === state.createdAt &&
      previous.phase === "question" &&
      (state.phase === "resolved" || state.phase === "podium");
    if (resolvedNow && this.options.rotateAfterResolveMs !== undefined) {
      this.rotateSoon(this.options.rotateAfterResolveMs, "after_resolution");
    }
  }

  /**
   * Plant den Zeithinweis. Ablauf der Frist nach der geschätzten Serverzeit plus eine kleine Reserve, damit der Server
   * den Hinweis nicht als zu früh ablehnt. Bleibt die Frage danach offen (zu früh gemeldet, Hinweis verloren), wird
   * der Hinweis wiederholt. Das ersetzt die fehlenden Server Timer.
   */
  private armTick(state: PublicGameState): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    const config = this.options.autoTick;
    if (!config || state.phase !== "question" || !state.question) return;
    const questionIndex = state.question.index;
    const createdAt = state.createdAt;
    const fire = () => {
      const current = this.state;
      if (!current || current.createdAt !== createdAt || current.phase !== "question" || current.question?.index !== questionIndex) return;
      this.tick();
      this.tickTimer = setTimeout(fire, this.timing.tickRetryMs);
    };
    const wait = state.question.deadline - this.serverNow() + 150 + config.extraDelayMs;
    this.tickTimer = setTimeout(fire, Math.max(50, wait));
  }

  /** Die neue Verbindung hat den Zustand geliefert: Sie wird aktiv, die alte wird geschlossen. */
  private promote(session: Session): void {
    const old = this.active;
    this.active = session;
    this.pending = null;
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    this.attempt = 0;
    this.lastMessageAt = this.now();
    this.armAgeTimer();
    this.startHeartbeat();
    if (old) this.closeSession(old, 1000, "rotated");
    this.setStatus("open");
    this.options.onEvent?.({
      type: "ready",
      reason: "rotate",
      instanceId: session.instanceId ?? "",
      connectMs: this.now() - session.openedAt,
    });
  }

  /**
   * Herzschlag: In regelmässigen Abständen ein Ping. Der Server antwortet sofort. Kommt dreimal so lange nichts
   * mehr an, ist die Verbindung halb tot (Netzwechsel, Standby), obwohl der Browser sie noch für offen hält.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const active = this.active;
      if (!active || active.socket.readyState !== OPEN) return;
      const silentMs = this.now() - this.lastMessageAt;
      if (silentMs > this.timing.heartbeatMs * 3) {
        this.options.onEvent?.({ type: "dead", silentMs });
        this.closeSession(active, 4000, "heartbeat_timeout", false);
        return;
      }
      active.socket.send(JSON.stringify({ type: "ping", t0: this.now() }));
    }, this.timing.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * Lebendprüfung, zum Beispiel wenn die Seite wieder sichtbar wird oder das Netz zurückkommt: Ein Ping, und wenn
   * innert der Frist nichts ankommt, wird die Verbindung verworfen und neu aufgebaut.
   */
  checkAlive(timeoutMs = 3000): void {
    const active = this.active;
    if (this.stopped) return;
    if (!active || active.socket.readyState !== OPEN) {
      this.reconnectNow();
      return;
    }
    const before = this.lastMessageAt;
    active.socket.send(JSON.stringify({ type: "ping", t0: this.now() }));
    setTimeout(() => {
      if (this.active === active && this.lastMessageAt === before) {
        this.options.onEvent?.({ type: "dead", silentMs: timeoutMs });
        this.closeSession(active, 4000, "alive_check_failed", false);
      }
    }, timeoutMs);
  }

  private armAgeTimer(): void {
    if (this.ageTimer) clearTimeout(this.ageTimer);
    this.ageTimer = setTimeout(() => this.rotate("max_age"), this.timing.maxAgeMs);
  }

  private startClockSync(session: Session): void {
    for (let i = 0; i < this.timing.pingCount; i += 1) {
      session.pingTimers.push(
        setTimeout(() => {
          if (session.socket.readyState === OPEN) session.socket.send(JSON.stringify({ type: "ping", t0: this.now() }));
        }, i * this.timing.pingIntervalMs),
      );
    }
  }

  private onClose(session: Session, code: number, reason: string): void {
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    for (const timer of session.pingTimers) clearTimeout(timer);
    session.pingTimers = [];
    this.seen.delete(session.id);
    this.options.onEvent?.({
      type: "closed",
      code,
      reason,
      ageMs: this.now() - session.openedAt,
      expected: session.closing,
    });

    if (session === this.pending) {
      // Der Neuaufbau ist gescheitert. Die alte Verbindung bleibt, bis sie selbst endet.
      this.pending = null;
      if (FATAL_CLOSE_CODES.includes(code)) this.fail(code, reason);
      else if (!this.active && !this.stopped && !session.closing) this.scheduleRetry(code);
      return;
    }
    if (session !== this.active) return; // Eine alte Verbindung, die wir selbst geschlossen haben.

    this.active = null;
    this.failAcks("disconnected");
    if (this.ageTimer) clearTimeout(this.ageTimer);
    this.ageTimer = null;
    this.stopHeartbeat();
    if (session.closing || this.stopped) return;
    if (FATAL_CLOSE_CODES.includes(code)) {
      this.fail(code, reason);
      return;
    }
    if (this.pending) return; // Die neue Verbindung übernimmt, sobald sie bereit ist.
    this.scheduleRetry(code);
  }

  private fail(code: number, reason: string): void {
    this.stopped = true;
    this.clearTimers();
    this.setStatus("closed");
    this.options.onEvent?.({ type: "fatal", code, message: reason });
  }

  private scheduleRetry(closeCode: number): void {
    this.setStatus("reconnecting");
    // Beendet der Server die Verbindung wegen des Alters (4012), ist das erwartet: sofort neu verbinden, nur mit
    // etwas Zufall, damit nicht alle Geräte im selben Moment kommen.
    const delay =
      closeCode === CLOSE_CODES.ROTATE
        ? Math.round(this.random() * 300)
        : computeBackoffMs(this.attempt, this.random, this.timing.backoffBaseMs, this.timing.backoffMaxMs);
    this.attempt += 1;
    this.options.onEvent?.({ type: "retry", attempt: this.attempt, inMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && !this.active) this.open("retry");
    }, delay);
  }
}
