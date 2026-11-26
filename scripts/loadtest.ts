/**
 * Lasttest: simuliert ein ganzes Quiz mit vielen Smartphones, einem Beamer und dem Admin.
 *
 * Die simulierten Geräte benutzen dieselbe Client Bibliothek wie die echten (RealtimeClient mit Wiederverbindung,
 * Neuaufbau nach jeder Auflösung, Zeithinweisen). Sie treten bei, antworten zufällig verzögert, brechen auf Wunsch
 * mitten in der Frage ab und verbinden sich neu, und ein Admin spielt das Quiz bis zum Siegerbildschirm durch.
 *
 * Zwei Betriebsarten:
 *
 * 1. Lokal (Standard). Das Skript legt ein eigenes Testspiel mit einem Quiz aus Testfragen in Redis an (Code im Bereich
 *    900000 bis 999999, wie beim Verbindungslabor) und erzeugt das Admin Cookie selbst. Gebraucht werden REDIS_URL und
 *    SESSION_SECRET (aus .env.local oder der Umgebung) und ein oder mehrere laufende Hubs (npm run dev:ws).
 *      npm run loadtest -- --players 60 --ws ws://localhost:3001/api/ws,ws://localhost:3002/api/ws
 *
 * 2. Gegen eine laufende App (zum Beispiel auf Vercel). Zuerst im Adminportal eine Durchführung anlegen (Warteraum), dann:
 *      npm run loadtest -- --code 123456 --api https://meine-app.vercel.app --ws wss://meine-app.vercel.app/api/ws \
 *        --admin-cookie "WERT DES COOKIES doc_quiz_admin" --players 60
 *    Das Skript tritt über die Beitritts Schnittstelle bei und steuert das Quiz mit dem Cookie. Achtung: Es wird die
 *    echte Durchführung gespielt, die Resultate landen in Neon. Nur mit Testquizzes verwenden.
 *
 * Optionen: --players (Standard 60), --questions (5, nur lokal), --time-limit (Sekunden, 8, nur lokal),
 * --drop (Anteil der Geräte, die pro Frage abbrechen, 0.1), --no-answer (Anteil ohne Antwort, 0.03),
 * --report Datei.md (schreibt den Bericht zusätzlich in eine Datei), --seed (Zufallszahl für wiederholbare Läufe).
 */
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import IORedis from "ioredis";
import { WebSocket } from "ws";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { createSessionToken } from "@/lib/auth/token";
import { getKeyPrefix, resolveSessionSecret } from "@/lib/env";
import type { GameQuiz } from "@/lib/game/snapshot";
import { RealtimeClient, type ClientEvent, type SocketLike } from "@/lib/realtime/client";
import type { PublicGameState } from "@/lib/realtime/game-state";
import { ioredisPort } from "@/lib/realtime/redis-port";
import { GameStore } from "@/lib/realtime/store";

config({ path: [".env.local", ".env"], quiet: true });

// ---------------------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) result[key] = "true";
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

/** Wiederholbarer Zufall (mulberry32), damit ein Lauf mit demselben Seed gleich abläuft. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Summary = { count: number; min: number; p50: number; p95: number; max: number };

function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return { count: sorted.length, min: sorted[0] as number, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] as number };
}

const ms = (value: number) => `${Math.round(value)} ms`;
const line = (label: string, summary: Summary | null) =>
  summary ? `${label}: Median ${ms(summary.p50)}, p95 ${ms(summary.p95)}, grösster Wert ${ms(summary.max)} (${summary.count} Werte)` : `${label}: keine Werte`;

// ---------------------------------------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const players = Math.max(1, Math.min(100, Number(args.players ?? 60)));
const wsUrls = (args.ws ?? "ws://localhost:3001/api/ws").split(",").map((url) => url.trim()).filter(Boolean);
const apiBase = args.api?.replace(/\/$/, "") ?? null;
const remoteCode = args.code ?? null;
const dropShare = Number(args.drop ?? 0.1);
const noAnswerShare = Number(args["no-answer"] ?? 0.03);
const questionCount = Math.max(1, Math.min(50, Number(args.questions ?? 5)));
const timeLimit = Math.max(5, Math.min(120, Number(args["time-limit"] ?? 8)));
const seed = Number(args.seed ?? Date.now() % 1_000_000);
const random = createRandom(seed);
const remote = remoteCode !== null;

if (remote && (!apiBase || !args["admin-cookie"])) {
  console.error("Gegen eine laufende App brauchen --code, --api und --admin-cookie.");
  process.exit(2);
}

function syntheticQuiz(): GameQuiz {
  const questions: GameQuiz["questions"] = [];
  for (let index = 0; index < questionCount; index += 1) {
    const kind = index === questionCount - 1 ? "multiple_choice" : (["multiple_choice", "estimate", "poll"] as const)[index % 3]!;
    if (kind === "estimate") {
      questions.push({ id: `q${index}`, type: "estimate", prompt: `Schätzfrage ${index + 1}`, timeLimitSeconds: timeLimit, maxPoints: 1000, options: [], correctValue: 100, unit: "km", tolerance: 50 });
    } else {
      questions.push({
        id: `q${index}`,
        type: kind,
        prompt: `Frage ${index + 1}`,
        timeLimitSeconds: timeLimit,
        maxPoints: kind === "poll" ? 0 : 1000,
        options: ["A", "B", "C", "D"].map((text, position) => ({ id: `q${index}o${position}`, text, isCorrect: kind === "multiple_choice" && position === index % 4 })),
        correctValue: null,
        unit: null,
        tolerance: null,
      });
    }
  }
  return { quizId: "loadtest", title: "Lasttest", questions };
}

// ---------------------------------------------------------------------------------------------------------
// Messwerte
// ---------------------------------------------------------------------------------------------------------

const metrics = {
  joinMs: [] as number[],
  connectMs: [] as number[],
  commandToStateMs: [] as number[],
  answerAckMs: [] as number[],
  reconnectMs: [] as number[],
  rotateMs: [] as number[],
  answersSent: 0,
  answersOk: 0,
  answersRejected: new Map<string, number>(),
  drops: 0,
  fatal: 0,
  rotations: 0,
  retries: 0,
  clientErrors: [] as string[],
};

function createSocket(cookie?: string): (url: string) => SocketLike {
  return (url) => new WebSocket(url, cookie ? { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } } : undefined) as unknown as SocketLike;
}

type Bot = {
  index: number;
  name: string;
  token: string;
  playerId: string;
  client: RealtimeClient;
  /** Zeitpunkt, an dem jede Version des Zustands bei diesem Gerät ankam. */
  receivedAt: Map<number, number>;
  answered: Map<number, boolean>;
  accepted: Map<number, boolean>;
  dropAt: number | null;
  lastDropAt: number | null;
};

// ---------------------------------------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = Date.now();
  let redis: IORedis | null = null;
  let store: GameStore | null = null;
  let code: string;
  let adminCookie: string;
  let commandsBefore: number | null = null;
  let statsBefore: Map<string, number> | null = null;

  if (remote) {
    code = remoteCode as string;
    adminCookie = args["admin-cookie"] as string;
  } else {
    const redisUrl = process.env.REDIS_URL ?? process.env.KV_URL;
    if (!redisUrl) throw new Error("REDIS_URL fehlt (lokaler Redis Server, zum Beispiel redis://127.0.0.1:6379).");
    const secret = resolveSessionSecret(process.env);
    redis = new IORedis(redisUrl);
    store = new GameStore(ioredisPort(redis), { prefix: getKeyPrefix(), tokenSecret: secret });
    adminCookie = createSessionToken(secret, Date.now(), 3600);
    code = "";
    for (let attempt = 0; attempt < 20 && !code; attempt += 1) {
      const candidate = String(900_000 + Math.floor(random() * 99_999));
      if (await store.createGame(candidate, syntheticQuiz())) code = candidate;
    }
    if (!code) throw new Error("Kein freier Testcode gefunden.");
    commandsBefore = await redisCommandCount(redis);
    statsBefore = await redisCommandStats(redis);
  }
  console.log(`Lasttest: ${players} Geräte, Spielcode ${code}, ${wsUrls.length} Instanz(en), ${remote ? "gegen laufende App" : `${questionCount} Testfragen`}, Seed ${seed}`);

  // ---- Admin und Beamer
  const adminStates: PublicGameState[] = [];
  const admin = new RealtimeClient({
    url: () => wsUrls[0] as string,
    role: "admin",
    code,
    createSocket: createSocket(adminCookie),
    autoTick: { extraDelayMs: 0 },
    rotateAfterResolveMs: 1500,
    onState: (state) => adminStates.push(state),
    onEvent: (event) => noteEvent("admin", event),
  });
  const screenStates: { state: PublicGameState; at: number }[] = [];
  const screen = new RealtimeClient({
    url: () => wsUrls[wsUrls.length - 1] as string,
    role: "screen",
    code,
    createSocket: createSocket(),
    autoTick: { extraDelayMs: 0 },
    rotateAfterResolveMs: 1500,
    onState: (state) => screenStates.push({ state, at: Date.now() }),
    onEvent: (event) => noteEvent("screen", event),
  });
  admin.start();
  screen.start();
  await waitFor(() => admin.getStatus() === "open" && screen.getStatus() === "open", 15_000, "Admin und Beamer verbinden");

  // ---- Geräte treten bei und verbinden sich
  const bots: Bot[] = [];
  const joinTasks: Promise<void>[] = [];
  for (let index = 0; index < players; index += 1) {
    joinTasks.push(
      (async () => {
        await sleep(random() * 3000);
        const name = `Gerät ${index + 1}`;
        const joinedAt = Date.now();
        const joined = apiBase ? await joinViaApi(code, name, index % 64) : await joinViaStore(store as GameStore, code, name, index % 64);
        metrics.joinMs.push(Date.now() - joinedAt);
        const bot: Bot = {
          index,
          name,
          token: joined.token,
          playerId: joined.playerId,
          receivedAt: new Map(),
          answered: new Map(),
          accepted: new Map(),
          dropAt: null,
          lastDropAt: null,
          client: null as unknown as RealtimeClient,
        };
        const target = wsUrls[index % wsUrls.length] as string;
        const connectStart = Date.now();
        let firstState = true;
        bot.client = new RealtimeClient({
          url: () => target,
          role: "player",
          code,
          token: bot.token,
          createSocket: createSocket(),
          autoTick: { extraDelayMs: 1500 },
          rotateAfterResolveMs: 3000,
          onState: (state) => {
            bot.receivedAt.set(state.version, Date.now());
            if (firstState) {
              firstState = false;
              metrics.connectMs.push(Date.now() - connectStart);
            }
            onBotState(bot, state);
          },
          onEvent: (event) => noteEvent(bot.name, event, bot),
        });
        bot.client.start();
        bots.push(bot);
      })(),
    );
  }
  await Promise.all(joinTasks);
  await waitFor(() => bots.every((bot) => bot.client.getStatus() === "open"), 30_000, "alle Geräte verbunden");
  await waitFor(() => (admin.getState()?.players.length ?? 0) >= players, 15_000, "Beitritte beim Admin sichtbar");
  console.log(`Alle ${players} Geräte sind verbunden. Das Quiz startet.`);
  await sleep(500);

  // ---- Das Quiz durchspielen
  const records: { index: number; answered: number; ackedOk: number; durationMs: number }[] = [];
  const pointsSeen = new Map<string, number>();
  let phaseChanges = 0;

  const send = async (cmd: Parameters<RealtimeClient["command"]>[0]): Promise<number> => {
    const before = admin.getState()?.version ?? -1;
    const sentAt = Date.now();
    const result = await admin.command(cmd, before);
    if (!result.ok) throw new Error(`Befehl ${cmd} abgelehnt: ${result.error}`);
    // Warten, bis jedes Gerät die neue Version gesehen hat, und die Laufzeit vom Befehl bis dahin messen.
    await waitFor(() => (admin.getState()?.version ?? -1) > before, 5000, `Zustand nach ${cmd}`);
    const version = admin.getState()?.version ?? before + 1;
    await waitFor(() => bots.every((bot) => bot.receivedAt.has(version) || (bot.client.getState()?.version ?? -1) >= version), 15_000, `alle Geräte sehen Version ${version}`);
    for (const bot of bots) {
      const at = bot.receivedAt.get(version);
      if (at !== undefined) metrics.commandToStateMs.push(at - sentAt);
    }
    phaseChanges += 1;
    return version;
  };

  await send("start");
  const questionTotal = admin.getState()?.question?.total ?? questionCount;
  for (let q = 0; q < questionTotal; q += 1) {
    const questionStarted = Date.now();
    const limitMs = (admin.getState()?.question?.timeLimitSeconds ?? timeLimit) * 1000;
    await waitFor(
      () => {
        const phase = admin.getState()?.phase;
        return phase === "resolved" || phase === "podium";
      },
      limitMs + 30_000,
      `Frage ${q + 1} aufgelöst`,
    );
    const resolved = admin.getState();
    const acked = bots.filter((bot) => bot.accepted.get(q) === true).length;
    records.push({ index: q, answered: resolved?.resolution?.answered ?? -1, ackedOk: acked, durationMs: Date.now() - questionStarted });
    for (const [playerId, result] of Object.entries(resolved?.results ?? {})) pointsSeen.set(playerId, (pointsSeen.get(playerId) ?? 0) + result.points);
    if (resolved?.phase === "resolved") {
      await sleep(1500 + random() * 1000);
      await send("next");
    }
  }
  // Siegerbildschirm enthüllen.
  const size = admin.getState()?.podium?.size ?? 0;
  for (let step = 0; step < size; step += 1) {
    await sleep(300);
    await send("reveal");
  }
  await sleep(300);
  await send("finish");
  await sleep(500);

  // ---- Prüfungen
  const finalState = admin.getState();
  const ranking = finalState?.podium?.ranking ?? [];
  const problems: string[] = [];
  if (ranking.length !== players) problems.push(`Rangliste hat ${ranking.length} statt ${players} Einträge.`);
  let pointsMismatch = 0;
  for (const row of ranking) {
    if ((pointsSeen.get(row.playerId) ?? 0) !== row.points) pointsMismatch += 1;
  }
  if (pointsMismatch > 0) problems.push(`Bei ${pointsMismatch} Geräten stimmen die Punkte der einzelnen Fragen nicht mit der Rangliste überein.`);
  for (const record of records) {
    if (record.answered !== record.ackedOk) problems.push(`Frage ${record.index + 1}: Der Server wertete ${record.answered} Antworten aus, ${record.ackedOk} wurden quittiert.`);
  }
  const ghost = bots.filter((bot) => bot.client.getStatus() !== "open").length;
  if (ghost > 0) problems.push(`${ghost} Geräte waren am Ende nicht mehr verbunden.`);

  const commandsAfter = redis ? await redisCommandCount(redis) : null;
  const statsAfter = redis ? await redisCommandStats(redis) : null;
  const breakdown: string[] = [];
  if (statsBefore && statsAfter) {
    const deltas = [...statsAfter.entries()]
      .map(([name, calls]) => [name, calls - (statsBefore?.get(name) ?? 0)] as const)
      .filter(([name, delta]) => delta > 0 && name !== "info")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    breakdown.push(deltas.map(([name, delta]) => `${name.toUpperCase()} ${delta}`).join(", "));
  }
  const finishedAt = Date.now();
  const instanceCounts = new Map<string, number>();
  for (const bot of bots) {
    const id = bot.client.getInstanceId() ?? "unbekannt";
    instanceCounts.set(id, (instanceCounts.get(id) ?? 0) + 1);
  }

  // ---- Bericht
  const rejected = [...metrics.answersRejected.entries()].map(([reason, count]) => `${reason} ${count}`).join(", ") || "keine";
  const report = [
    `# Lasttest vom ${new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}`,
    "",
    `* Geräte: ${players}, Spielcode ${code}, Instanzen: ${wsUrls.length}, Seed ${seed}`,
    `* Betriebsart: ${remote ? "gegen laufende App" : `lokal mit ${questionTotal} Testfragen zu ${timeLimit} Sekunden`}`,
    `* Dauer insgesamt: ${Math.round((finishedAt - startedAt) / 1000)} Sekunden`,
    `* Abbrüche pro Frage: Anteil ${dropShare}, Anteil ohne Antwort ${noAnswerShare}`,
    "",
    "## Messwerte",
    "",
    `* ${line("Beitritt (HTTP oder Speicher)", summarize(metrics.joinMs))}`,
    `* ${line("Verbindungsaufbau bis zum ersten Zustand", summarize(metrics.connectMs))}`,
    `* ${line("Befehl des Admins bis Anzeige auf dem Gerät", summarize(metrics.commandToStateMs))}`,
    `* ${line("Antwort bis Quittung des Servers", summarize(metrics.answerAckMs))}`,
    `* ${line("Wiederverbindung nach Abbruch", summarize(metrics.reconnectMs))}`,
    `* ${line("Kontrollierter Neuaufbau (neue Verbindung bereit)", summarize(metrics.rotateMs))}`,
    `* Antworten gesendet ${metrics.answersSent}, angenommen ${metrics.answersOk}, abgelehnt: ${rejected}`,
    `* Absichtliche Abbrüche ${metrics.drops}, Neuaufbauten nach Auflösung ${metrics.rotations}, Wiederholungen von Antworten ${metrics.retries}`,
    `* Endgültige Fehler ${metrics.fatal}, Phasenwechsel ${phaseChanges}`,
    `* Verteilung der Geräte auf Instanzen: ${[...instanceCounts.entries()].map(([id, count]) => `${id}: ${count}`).join(", ")}`,
    ...(commandsBefore !== null && commandsAfter !== null
      ? [
          `* Redis Befehle während des Spiels (lokal gemessen): ${commandsAfter - commandsBefore - 3}, das sind ${((commandsAfter - commandsBefore - 3) / Math.max(1, questionTotal)).toFixed(0)} pro Frage`,
          `* Aufteilung nach Befehl: ${breakdown[0] ?? "unbekannt"}. Ein lokaler Redis zählt auch die Befehle innerhalb der Lua Skripte einzeln (HEXISTS, HSETNX, HLEN, EXPIRE, HSET), ein gehosteter Dienst zählt womöglich weniger.`,
        ]
      : []),
    "",
    "## Auflösung pro Frage",
    "",
    ...records.map((record) => `* Frage ${record.index + 1}: ${record.answered} Antworten ausgewertet, ${record.ackedOk} quittiert, ${Math.round(record.durationMs / 100) / 10} Sekunden`),
    "",
    "## Prüfungen",
    "",
    ...(problems.length === 0
      ? ["* Alle Prüfungen bestanden: Jede quittierte Antwort wurde ausgewertet, die Punkte der Fragen ergeben die Endrangliste, alle Geräte blieben bis zum Ende verbunden."]
      : problems.map((problem) => `* FEHLER: ${problem}`)),
    ...(metrics.clientErrors.length > 0 ? ["", "## Meldungen der Geräte", "", ...metrics.clientErrors.slice(0, 15).map((message) => `* ${message}`)] : []),
    "",
  ].join("\n");
  console.log(`\n${report}`);
  if (args.report) {
    writeFileSync(args.report, report, "utf8");
    console.log(`Bericht geschrieben: ${args.report}`);
  }

  for (const bot of bots) bot.client.stop();
  admin.stop();
  screen.stop();
  if (store) await store.deleteGame(code);
  if (redis) redis.disconnect();
  process.exit(problems.length === 0 ? 0 : 1);

  // -------------------------------------------------------------------------------------------------------
  // Verhalten eines Geräts
  // -------------------------------------------------------------------------------------------------------

  function onBotState(bot: Bot, state: PublicGameState): void {
    const question = state.question;
    if (state.phase !== "question" || !question) return;
    const q = question.index;
    if (bot.answered.has(q)) return;
    bot.answered.set(q, true);
    const answers = random() >= noAnswerShare;
    const delay = 300 + random() * Math.max(500, Math.min(question.timeLimitSeconds * 1000 * 0.7, 5500));
    if (random() < dropShare) {
      // Ein Gerät verliert mitten in der Frage die Verbindung, noch bevor oder nachdem es geantwortet hat.
      bot.dropAt = Date.now();
      setTimeout(() => {
        if (bot.client.getState()?.question?.index !== q) return;
        metrics.drops += 1;
        bot.lastDropAt = Date.now();
        bot.client.simulateDrop();
      }, delay * (0.3 + random() * 0.8));
    }
    if (!answers) return;
    setTimeout(() => void answerWithRetries(bot, q), delay);
  }

  async function answerWithRetries(bot: Bot, q: number): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = bot.client.getState();
      if (current?.question?.index !== q || current.phase !== "question") return;
      const question = current.question;
      const payload = question.type === "estimate" ? { value: Math.round(100 + (random() - 0.5) * 160) } : { option: Math.floor(random() * question.options.length) };
      metrics.answersSent += 1;
      const sentAt = Date.now();
      const result = await bot.client.answer(q, payload);
      if (result.ok || result.error === "already_answered") {
        // "already_answered" nach einer Wiederholung heisst: Die erste Antwort kam an, der Server hat sie gezählt.
        if (result.ok) metrics.answerAckMs.push(Date.now() - sentAt);
        metrics.answersOk += result.ok ? 1 : 0;
        bot.accepted.set(q, true);
        return;
      }
      metrics.answersRejected.set(result.error, (metrics.answersRejected.get(result.error) ?? 0) + 1);
      if (result.error === "too_late" || result.error === "stale" || result.error === "wrong_phase") return;
      metrics.retries += 1;
      await sleep(400 + random() * 600);
    }
  }

  function noteEvent(who: string, event: ClientEvent, bot?: Bot): void {
    if (event.type === "ready") {
      if (event.reason === "retry" && bot?.lastDropAt) {
        metrics.reconnectMs.push(Date.now() - bot.lastDropAt);
        bot.lastDropAt = null;
      }
      if (event.reason === "rotate") metrics.rotateMs.push(event.connectMs);
    }
    if (event.type === "rotate" && event.why === "after_resolution") metrics.rotations += 1;
    if (event.type === "fatal") {
      metrics.fatal += 1;
      metrics.clientErrors.push(`${who}: endgültiger Fehler ${event.code} ${event.message}`);
    }
    if (event.type === "dead") metrics.clientErrors.push(`${who}: Verbindung als tot erkannt nach ${event.silentMs} ms`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Beitritt
// ---------------------------------------------------------------------------------------------------------

async function joinViaApi(code: string, name: string, avatar: number): Promise<{ token: string; playerId: string }> {
  const response = await fetch(`${apiBase}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: apiBase as string },
    body: JSON.stringify({ code, name, avatar }),
  });
  const body = (await response.json()) as { ok: boolean; token?: string; player?: { id: string }; message?: string };
  if (!body.ok || !body.token || !body.player) throw new Error(`Beitritt abgelehnt (${response.status}): ${body.message ?? "unbekannt"}`);
  return { token: body.token, playerId: body.player.id };
}

async function joinViaStore(store: GameStore, code: string, name: string, avatar: number): Promise<{ token: string; playerId: string }> {
  const result = await store.joinPlayer(code, { name, avatar });
  if (!result.ok) throw new Error(`Beitritt abgelehnt: ${result.reason}`);
  return { token: result.token, playerId: result.player.id };
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(25);
  }
  throw new Error(`Zeitüberschreitung beim Warten auf: ${what}`);
}

/** Aufrufe pro Befehl aus INFO commandstats (lokaler Server). */
async function redisCommandStats(redis: IORedis): Promise<Map<string, number>> {
  const info = await redis.info("commandstats");
  const stats = new Map<string, number>();
  for (const match of info.matchAll(/cmdstat_(\w+):calls=(\d+)/g)) stats.set(match[1] as string, Number(match[2]));
  return stats;
}

/** Zahl der von Redis bisher bearbeiteten Befehle (INFO). Gilt für den lokalen Server. */
async function redisCommandCount(redis: IORedis): Promise<number> {
  const info = await redis.info("stats");
  const match = info.match(/total_commands_processed:(\d+)/);
  return match ? Number(match[1]) : 0;
}

main().catch((error: unknown) => {
  console.error("Lasttest abgebrochen:", error instanceof Error ? error.message : String(error));
  process.exit(2);
});
