"use client";

/**
 * Verbindungslabor: baut aus diesem Browser viele simulierte Verbindungen zu einem Testspiel auf und misst
 * Verteilung auf Instanzen, Laufzeit, Zustellung, Wiederverbindung und Neuaufbau. Es nutzt denselben Client und
 * denselben Endpunkt wie später die Smartphones, misst also den echten Weg und keinen Ersatz.
 *
 * Die Messwerte liegen in veränderlichen Referenzen und werden alle 500 Millisekunden in die Anzeige übernommen.
 * So lösen 60 Verbindungen mit vielen Ereignissen keine Flut von Neuzeichnungen aus.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Notice from "@/components/Notice";
import { websocketUrl } from "@/lib/realtime/url";
import { RealtimeClient, type ClientStatus, type SocketLike } from "@/lib/realtime/client";
import {
  countBy,
  summarize,
  summarizeBroadcast,
  type BroadcastResult,
  type BroadcastSend,
  type Summary,
} from "@/lib/realtime/lab-metrics";
import { createLabGameAction, deleteLabGameAction, joinLabPlayersAction, touchLabGameAction } from "./actions";

type LabPlayer = {
  index: number;
  name: string;
  client: RealtimeClient;
  startedAt: number;
  firstReadyMs: number | null;
  status: ClientStatus;
  instanceId: string | null;
  unexpectedCloses: number;
  dropAt: number | null;
  reconnectMs: number[];
  /** Version, Serverzeit aus Sicht des Clients beim Eintreffen. */
  arrivals: Map<number, number>;
  sawReconnectingDuringRotation: boolean;
};

type LogEntry = { at: number; text: string };

type Snapshot = {
  gameCode: string | null;
  publishMode: string | null;
  screenVersion: number | null;
  screenPlayers: number | null;
  total: number;
  byStatus: Record<string, number>;
  byInstance: Record<string, number>;
  connect: Summary;
  rtt: Summary;
  reconnect: Summary;
  unexpectedByCode: Record<string, number>;
  series: BroadcastResult[];
  rotation: { total: number; withoutInterruption: number } | null;
  log: LogEntry[];
};

const EMPTY: Summary = { count: 0, min: null, p50: null, p95: null, max: null };
const INITIAL: Snapshot = {
  gameCode: null,
  publishMode: null,
  screenVersion: null,
  screenPlayers: null,
  total: 0,
  byStatus: {},
  byInstance: {},
  connect: EMPTY,
  rtt: EMPTY,
  reconnect: EMPTY,
  unexpectedByCode: {},
  series: [],
  rotation: null,
  log: [],
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const format = (value: number | null) => (value === null ? "–" : `${value} ms`);

function createSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl bg-black/[0.03] p-4">
      <div className="text-ink-soft text-xs font-semibold">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
      {hint ? <div className="text-ink-soft mt-0.5 text-xs">{hint}</div> : null}
    </div>
  );
}

function SummaryLine({ summary }: { summary: Summary }) {
  if (summary.count === 0) return <span>noch keine Werte</span>;
  return (
    <span className="tabular-nums">
      Median {format(summary.p50)}, p95 {format(summary.p95)}, grösster Wert {format(summary.max)} ({summary.count} Werte)
    </span>
  );
}

export default function LabClient({ platformLimitMode }: { platformLimitMode: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(INITIAL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState("20");
  const [rotationOff, setRotationOff] = useState(false);
  const [copied, setCopied] = useState(false);

  const gameRef = useRef<{ code: string; publishMode: string } | null>(null);
  const playersRef = useRef<LabPlayer[]>([]);
  const screenRef = useRef<{ client: RealtimeClient; version: number | null; players: number | null } | null>(null);
  const sendsRef = useRef<BroadcastSend[]>([]);
  const seriesRef = useRef<BroadcastResult[]>([]);
  const rotationRef = useRef<{ total: number; withoutInterruption: number } | null>(null);
  const rotationOpenRef = useRef(false);
  const logRef = useRef<LogEntry[]>([]);
  /** Close Codes aller unerwarteten Abbrüche, für die Auswertung nach Code. */
  const unexpectedCodesRef = useRef<number[]>([]);

  const log = useCallback((text: string) => {
    logRef.current.push({ at: Date.now(), text });
    if (logRef.current.length > 300) logRef.current.splice(0, logRef.current.length - 300);
  }, []);

  const refresh = useCallback(() => {
    const players = playersRef.current;
    setSnapshot({
      gameCode: gameRef.current?.code ?? null,
      publishMode: gameRef.current?.publishMode ?? null,
      screenVersion: screenRef.current?.version ?? null,
      screenPlayers: screenRef.current?.players ?? null,
      total: players.length,
      byStatus: countBy(players.map((player) => player.status)),
      byInstance: countBy(players.flatMap((player) => (player.instanceId ? [player.instanceId] : []))),
      connect: summarize(players.flatMap((player) => (player.firstReadyMs === null ? [] : [player.firstReadyMs]))),
      rtt: summarize(players.flatMap((player) => {
        const rtt = player.client.getClock()?.rttMs;
        return rtt === undefined ? [] : [rtt];
      })),
      reconnect: summarize(players.flatMap((player) => player.reconnectMs)),
      unexpectedByCode: countBy(unexpectedCodesRef.current),
      series: [...seriesRef.current],
      rotation: rotationRef.current,
      log: logRef.current.slice(-80),
    });
  }, []);

  // Anzeige alle 500 Millisekunden aktualisieren, solange die Seite offen ist.
  useEffect(() => {
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [refresh]);

  const closeAllClients = useCallback(() => {
    for (const player of playersRef.current) player.client.stop();
    screenRef.current?.client.stop();
    playersRef.current = [];
    screenRef.current = null;
  }, []);

  // Beim Verlassen der Seite alle Verbindungen schliessen.
  useEffect(() => closeAllClients, [closeAllClients]);

  async function run(name: string, work: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
      refresh();
    }
  }

  function clientTiming() {
    return rotationOff ? { maxAgeMs: 3_600_000 } : {};
  }

  function startScreen(code: string) {
    const entry = { client: null as unknown as RealtimeClient, version: null as number | null, players: null as number | null };
    entry.client = new RealtimeClient({
      url: websocketUrl,
      role: "screen",
      code,
      createSocket,
      timing: clientTiming(),
      onState: (state) => {
        entry.version = state.version;
        entry.players = state.players.length;
      },
      onEvent: (event) => {
        if (event.type === "closed" && !event.expected) log(`Bildschirm: Verbindung beendet (Code ${event.code}, Alter ${Math.round(event.ageMs / 1000)} s)`);
        if (event.type === "fatal") log(`Bildschirm: endgültiger Fehler (Code ${event.code})`);
      },
    });
    screenRef.current = entry;
    entry.client.start();
  }

  function createPlayer(index: number, name: string, token: string, code: string): LabPlayer {
    const startedAt = performance.now();
    const player: LabPlayer = {
      index,
      name,
      client: null as unknown as RealtimeClient,
      startedAt,
      firstReadyMs: null,
      status: "idle",
      instanceId: null,
      unexpectedCloses: 0,
      dropAt: null,
      reconnectMs: [],
      arrivals: new Map(),
      sawReconnectingDuringRotation: false,
    };
    player.client = new RealtimeClient({
      url: websocketUrl,
      role: "player",
      code,
      token,
      createSocket,
      timing: clientTiming(),
      onState: (state) => {
        player.arrivals.set(state.version, player.client.serverNow());
      },
      onStatus: (status) => {
        player.status = status;
        if (status === "reconnecting" && rotationOpenRef.current) player.sawReconnectingDuringRotation = true;
      },
      onEvent: (event) => {
        if (event.type === "ready") {
          player.instanceId = event.instanceId;
          if (player.firstReadyMs === null) player.firstReadyMs = Math.round(performance.now() - player.startedAt);
          if (player.dropAt !== null) {
            player.reconnectMs.push(Math.round(performance.now() - player.dropAt));
            player.dropAt = null;
          }
        }
        if (event.type === "closed" && !event.expected) {
          player.unexpectedCloses += 1;
          unexpectedCodesRef.current.push(event.code);
          log(`${name}: Verbindung beendet (Code ${event.code}, Alter ${Math.round(event.ageMs / 1000)} s)`);
        }
        if (event.type === "closed" && event.expected && event.code !== 1000) log(`${name}: erwartetes Ende (Code ${event.code})`);
        if (event.type === "dead") log(`${name}: Verbindung ohne Antwort, wird neu aufgebaut`);
        if (event.type === "fatal") log(`${name}: endgültiger Fehler (Code ${event.code})`);
      },
    });
    return player;
  }

  async function createGame() {
    await run("Testspiel anlegen", async () => {
      closeAllClients();
      const result = await createLabGameAction();
      if (!result.ok) throw new Error(result.error);
      gameRef.current = { code: result.code, publishMode: result.publishMode };
      sendsRef.current = [];
      seriesRef.current = [];
      rotationRef.current = null;
      unexpectedCodesRef.current = [];
      logRef.current = [];
      log(`Testspiel ${result.code} angelegt (Veröffentlichung: ${result.publishMode})`);
      startScreen(result.code);
    });
  }

  async function connectPlayers() {
    const game = gameRef.current;
    if (!game) return;
    const wanted = Math.min(60, Math.max(1, Math.floor(Number(count)) || 1));
    await run(`${wanted} Teilnehmende verbinden`, async () => {
      const from = playersRef.current.length;
      const missing = wanted - from;
      if (missing <= 0) throw new Error("Es sind schon so viele Teilnehmende verbunden. Wählen Sie eine grössere Zahl.");
      for (let done = 0; done < missing; done += 10) {
        const batch = Math.min(10, missing - done);
        const result = await joinLabPlayersAction(game.code, from + done, batch);
        if (!result.ok) throw new Error(result.error);
        for (const credentials of result.players) {
          const player = createPlayer(credentials.index, credentials.name, credentials.token, game.code);
          playersRef.current.push(player);
          player.client.start();
          await sleep(15);
        }
        refresh();
      }
      log(`${missing} Teilnehmende aufgenommen und verbunden`);
    });
  }

  async function touchSeries(times: number) {
    const game = gameRef.current;
    if (!game) return;
    await run(`Zustand ${times} Mal ändern`, async () => {
      const sends: BroadcastSend[] = [];
      for (let i = 0; i < times; i += 1) {
        const result = await touchLabGameAction(game.code);
        if (!result.ok) throw new Error(result.error);
        sends.push({ version: result.version, sentServerTime: result.sentServerTime });
        await sleep(250);
      }
      // Nachzügler abwarten, dann auswerten.
      await sleep(3000);
      sendsRef.current.push(...sends);
      const connected = playersRef.current.filter((player) => player.status === "open");
      const result = summarizeBroadcast(sends, connected.map((player) => player.arrivals));
      seriesRef.current.push(result);
      log(`Reihe mit ${times} Änderungen: ${result.delivered} von ${result.expected} zugestellt, Median ${format(result.latencyMs.p50)}`);
    });
  }

  async function dropShare(share: number) {
    await run(`${Math.round(share * 100)} Prozent trennen`, async () => {
      const players = playersRef.current.filter((player) => player.status === "open");
      const shuffled = [...players].sort(() => Math.random() - 0.5);
      const chosen = shuffled.slice(0, Math.max(1, Math.round(players.length * share)));
      const now = performance.now();
      for (const player of chosen) {
        player.dropAt = now;
        player.client.simulateDrop();
      }
      log(`${chosen.length} Verbindungen abgebrochen`);
      await sleep(4000);
    });
  }

  async function rotateAll() {
    await run("Alle neu aufbauen", async () => {
      const players = playersRef.current.filter((player) => player.status === "open");
      for (const player of players) player.sawReconnectingDuringRotation = false;
      rotationOpenRef.current = true;
      for (const player of players) player.client.rotateSoon(2000, "labor");
      await sleep(7000);
      rotationOpenRef.current = false;
      const withoutInterruption = players.filter((player) => !player.sawReconnectingDuringRotation).length;
      rotationRef.current = { total: players.length, withoutInterruption };
      log(`Neuaufbau: ${withoutInterruption} von ${players.length} ohne Unterbruch`);
    });
  }

  async function finish() {
    await run("Beenden", async () => {
      const code = gameRef.current?.code;
      closeAllClients();
      if (code) {
        const result = await deleteLabGameAction(code);
        if (!result.ok) throw new Error(result.error);
      }
      gameRef.current = null;
      log("Testspiel beendet und gelöscht");
    });
  }

  async function copyResult() {
    const players = playersRef.current;
    const report = {
      zeitpunkt: new Date().toISOString(),
      adresse: window.location.host,
      browser: navigator.userAgent,
      testspiel: snapshot.gameCode,
      veroeffentlichung: snapshot.publishMode,
      teilnehmende: snapshot.total,
      statusAnzahl: snapshot.byStatus,
      instanzen: snapshot.byInstance,
      verbindungsaufbauMs: snapshot.connect,
      laufzeitMs: snapshot.rtt,
      wiederverbindungMs: snapshot.reconnect,
      unerwarteteAbbruecheNachCode: snapshot.unexpectedByCode,
      reihen: snapshot.series,
      neuaufbau: snapshot.rotation,
      neuaufbauAusgeschaltet: rotationOff,
      protokoll: logRef.current.slice(-100).map((entry) => `${new Date(entry.at).toISOString()} ${entry.text}`),
      einzelneVerbindungen: players.map((player) => ({ name: player.name, status: player.status, instanz: player.instanceId, abbrueche: player.unexpectedCloses })),
    };
    const text = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt("Kopieren Sie das Ergebnis mit Strg C:", text);
    }
  }

  const connected = snapshot.byStatus.open ?? 0;
  const hasGame = snapshot.gameCode !== null;
  const lastSeries = snapshot.series.at(-1) ?? null;

  return (
    <div className="space-y-6">
      {platformLimitMode ? (
        <Notice tone="warn">
          Messmodus für die Plattformgrenze ist aktiv (REALTIME_MAX_AGE Variablen sind gesetzt). Der Server beendet Verbindungen
          nicht mehr selbst nach 290 Sekunden. Entfernen Sie die Variablen nach der Messung wieder.
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <section className="glass-card space-y-4 p-6">
        <h2 className="text-lg font-semibold">1. Testspiel</h2>
        <p className="text-ink-soft text-sm">
          Legt ein Testspiel mit einem Code im Bereich 900000 bis 999999 an. Echte Spiele sind davon nicht betroffen.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" disabled={busy !== null || hasGame} onClick={createGame}>
            Testspiel anlegen
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy !== null || !hasGame} onClick={finish}>
            Beenden und aufräumen
          </button>
          {hasGame ? (
            <span className="text-sm">
              Code <strong className="tabular-nums">{snapshot.gameCode}</strong>, Bildschirm sieht Version{" "}
              <strong>{snapshot.screenVersion ?? "–"}</strong> und <strong>{snapshot.screenPlayers ?? "–"}</strong> Teilnehmende
            </span>
          ) : null}
        </div>
      </section>

      <section className="glass-card space-y-4 p-6">
        <h2 className="text-lg font-semibold">2. Teilnehmende verbinden</h2>
        <p className="text-ink-soft text-sm">
          Jede simulierte Person bekommt ein eigenes Token und eine eigene WebSocket Verbindung aus diesem Browser. Die
          Verbindungen verteilen sich auf die Funktionsinstanzen von Vercel.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="count" className="mb-1 block text-sm font-semibold">
              Anzahl (1 bis 60)
            </label>
            <input id="count" inputMode="numeric" className="field !w-28" value={count} onChange={(event) => setCount(event.target.value)} />
          </div>
          <button type="button" className="btn btn-primary" disabled={busy !== null || !hasGame} onClick={connectPlayers}>
            Verbinden
          </button>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rotationOff} onChange={(event) => setRotationOff(event.target.checked)} className="h-5 w-5" style={{ accentColor: "#e30613" }} />
            Automatischen Neuaufbau ausschalten (vor dem Verbinden wählen)
          </label>
        </div>
      </section>

      <section className="glass-card space-y-4 p-6">
        <h2 className="text-lg font-semibold">3. Tests</h2>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn btn-secondary" disabled={busy !== null || connected === 0} onClick={() => touchSeries(10)}>
            Zustand 10 Mal ändern
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy !== null || connected === 0} onClick={() => dropShare(0.3)}>
            30 Prozent trennen
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy !== null || connected === 0} onClick={rotateAll}>
            Alle neu aufbauen
          </button>
          <button type="button" className="btn btn-secondary" disabled={snapshot.total === 0} onClick={copyResult}>
            {copied ? "Kopiert" : "Ergebnis kopieren"}
          </button>
        </div>
        {busy ? <p role="status" className="text-sm font-semibold">Läuft: {busy} …</p> : null}
        <p className="text-ink-soft text-xs">
          Zustand ändern misst, wie schnell eine Änderung bei allen ankommt. Trennen simuliert Netzabbrüche und misst die
          Wiederverbindung. Neu aufbauen testet den kontrollierten Wechsel der Verbindung ohne Unterbruch.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Ergebnisse</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Verbunden" value={`${connected} von ${snapshot.total}`} hint={Object.entries(snapshot.byStatus).map(([k, v]) => `${k} ${v}`).join(", ") || undefined} />
          <Stat label="Instanzen" value={Object.keys(snapshot.byInstance).length} hint={Object.entries(snapshot.byInstance).map(([k, v]) => `${k}: ${v}`).join(", ") || undefined} />
          <Stat label="Zustellung (letzte Reihe)" value={lastSeries ? `${lastSeries.delivered} von ${lastSeries.expected}` : "–"} hint={lastSeries ? `fehlend ${lastSeries.missing}` : undefined} />
          <Stat label="Neuaufbau ohne Unterbruch" value={snapshot.rotation ? `${snapshot.rotation.withoutInterruption} von ${snapshot.rotation.total}` : "–"} />
        </div>
        <div className="glass-card space-y-2 p-6 text-sm">
          <p>
            <strong>Verbindungsaufbau bis zum ersten Zustand:</strong> <SummaryLine summary={snapshot.connect} />
          </p>
          <p>
            <strong>Laufzeit Hin und Zurück (beste von 3 Messungen):</strong> <SummaryLine summary={snapshot.rtt} />
          </p>
          <p>
            <strong>Zustellung einer Änderung bis zum Gerät:</strong>{" "}
            {lastSeries ? <SummaryLine summary={lastSeries.latencyMs} /> : "noch keine Reihe"}
          </p>
          <p>
            <strong>Wiederverbindung nach Abbruch:</strong> <SummaryLine summary={snapshot.reconnect} />
          </p>
          <p>
            <strong>Unerwartete Abbrüche nach Close Code:</strong>{" "}
            {Object.keys(snapshot.unexpectedByCode).length === 0
              ? "keine"
              : Object.entries(snapshot.unexpectedByCode).map(([code, n]) => `${code}: ${n}`).join(", ")}
          </p>
          <p className="text-ink-soft text-xs">
            Die Laufzeit der Zustellung ist eine Schätzung auf Basis des Uhrenabgleichs, die Uhren der Instanzen können leicht
            voneinander abweichen.
          </p>
        </div>
        <div className="glass-card p-4">
          <h3 className="mb-2 text-sm font-semibold">Protokoll</h3>
          <pre className="max-h-72 overflow-auto text-xs leading-relaxed whitespace-pre-wrap">
            {snapshot.log.length === 0 ? "Noch keine Einträge." : snapshot.log.map((entry) => `${new Date(entry.at).toLocaleTimeString("de-CH")}  ${entry.text}`).join("\n")}
          </pre>
        </div>
      </section>
    </div>
  );
}
