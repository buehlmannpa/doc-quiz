/**
 * Spielspeicher in Redis (das Kurzzeitgedächtnis während eines Spiels).
 *
 * Aufbau in Redis, alle Schlüssel mit dem Präfix der Umgebung:
 * 1. game:CODE      Hash mit zwei Feldern. v ist die Version, s ist der vollständige öffentliche Zustand als JSON.
 *                   Ein einziger Lesebefehl liefert also den ganzen Zustand.
 * 2. game:CODE:tok  Hash von Token Hash zu Spieler Kennung, für die Anmeldung der Smartphones.
 * 3. Kanal ch:game:CODE  Bei jeder Änderung wird der vollständige Zustand veröffentlicht.
 *
 * Änderungen laufen über einen Versionsvergleich in einem Lua Skript, das atomar in Redis ausgeführt wird:
 * Es schreibt nur, wenn die Version noch die ist, die der Aufrufer gelesen hat. Sonst liefert es den aktuellen
 * Zustand zurück, und der Aufrufer rechnet damit neu (ohne zusätzlichen Lesebefehl). Dasselbe Skript
 * veröffentlicht die Änderung im selben atomaren Schritt. So kann es keinen Zustand ohne Nachricht geben,
 * auch nicht, wenn eine Funktionsinstanz mittendrin stirbt.
 *
 * Wenn Upstash PUBLISH innerhalb von Lua nicht erlaubt (nicht bestätigt), schaltet der Speicher automatisch auf
 * eine Variante um, die nach dem Schreiben getrennt veröffentlicht. Das ist etwas weniger robust, aber
 * funktionsgleich. Die Variante zeigt store.publishMode.
 */
import { buildChannel, buildKey } from "@/lib/redis/keys";
import {
  addPlayer,
  createInitialState,
  GameRuleError,
  isValidAvatar,
  normalizePlayerName,
  publicGameStateSchema,
  type JoinFailure,
  type PublicGameState,
  type PublicPlayer,
} from "./game-state";
import type { RedisPort } from "./redis-port";
import { generatePlayerId, generatePlayerToken, hashPlayerToken } from "./tokens";

/** Ein Spiel lebt höchstens 6 Stunden nach der letzten Änderung. Danach räumt Redis es selbständig auf. */
export const DEFAULT_GAME_TTL_SECONDS = 6 * 60 * 60;

const CREATE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 's', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

// KEYS[1] Spiel. ARGV: erwartete Version, neue Version, neuer Zustand, TTL, Kanal, Nachricht.
// Rückgabe: {1} bei Erfolg, sonst {0, aktueller Zustand oder nil, wenn das Spiel nicht existiert}.
const UPDATE_SCRIPT_WITH_PUBLISH = `
local current = redis.call('HGET', KEYS[1], 'v')
if current ~= ARGV[1] then
  return {0, redis.call('HGET', KEYS[1], 's')}
end
redis.call('HSET', KEYS[1], 'v', ARGV[2], 's', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('PUBLISH', ARGV[5], ARGV[6])
return {1}
`;

const UPDATE_SCRIPT_WITHOUT_PUBLISH = `
local current = redis.call('HGET', KEYS[1], 'v')
if current ~= ARGV[1] then
  return {0, redis.call('HGET', KEYS[1], 's')}
end
redis.call('HSET', KEYS[1], 'v', ARGV[2], 's', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {1}
`;

export type StoreOptions = {
  /** Präfix der Umgebung (prod, preview, dev, local). */
  prefix: string;
  /** Geheimnis für den Hash der Spielertoken. */
  tokenSecret: string;
  ttlSeconds?: number;
  now?: () => number;
  /** Höchstzahl der Versuche bei gleichzeitigen Änderungen. */
  maxAttempts?: number;
};

export type UpdateOutcome =
  | { ok: true; state: PublicGameState }
  | { ok: false; reason: "not_found" | "busy" };

export type JoinResult =
  | { ok: true; token: string; player: PublicPlayer; state: PublicGameState }
  | { ok: false; reason: JoinFailure };

export type AuthResult =
  | { ok: true; state: PublicGameState; player: PublicPlayer }
  | { ok: false; reason: "not_found" | "bad_token" };

type ScriptResult = { status: "ok" } | { status: "missing" } | { status: "conflict"; current: PublicGameState };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseState(raw: string): PublicGameState {
  return publicGameStateSchema.parse(JSON.parse(raw));
}

export class GameStore {
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private publishInScript = true;

  constructor(
    private readonly port: RedisPort,
    private readonly options: StoreOptions,
  ) {
    this.ttl = options.ttlSeconds ?? DEFAULT_GAME_TTL_SECONDS;
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? 60;
  }

  /** Ob die Änderung im selben Skript veröffentlicht wird oder in einem getrennten Schritt. */
  get publishMode(): "script" | "separate" {
    return this.publishInScript ? "script" : "separate";
  }

  gameKey(code: string): string {
    return buildKey(this.options.prefix, "game", code);
  }

  private tokenKey(code: string): string {
    return buildKey(this.options.prefix, "game", code, "tok");
  }

  channel(code: string): string {
    return buildChannel(this.options.prefix, "game", code);
  }

  /** Legt ein neues Spiel im Warteraum an. Gibt false zurück, wenn der Code schon belegt ist. */
  async createGame(code: string): Promise<boolean> {
    const state = createInitialState(code, this.now());
    const result = await this.port.eval(
      CREATE_SCRIPT,
      [this.gameKey(code)],
      [state.version, JSON.stringify(state), this.ttl],
    );
    return Number(result) === 1;
  }

  async getState(code: string): Promise<PublicGameState | null> {
    const [raw] = await this.port.hgetBatch([{ key: this.gameKey(code), field: "s" }]);
    return raw ? parseState(raw) : null;
  }

  async deleteGame(code: string): Promise<void> {
    await this.port.del(this.gameKey(code), this.tokenKey(code));
  }

  /**
   * Ändert den Zustand. mutate bekommt den aktuellen Zustand und gibt den neuen zurück oder wirft einen
   * GameRuleError. Die Version setzt der Speicher selbst auf die alte plus 1. Bei gleichzeitigen Änderungen
   * wird mutate mit dem neueren Zustand erneut aufgerufen, mutate muss also frei von Nebenwirkungen sein.
   */
  async update(
    code: string,
    mutate: (state: PublicGameState) => PublicGameState,
    known?: PublicGameState,
  ): Promise<UpdateOutcome> {
    let current = known ?? (await this.getState(code));
    if (!current) return { ok: false, reason: "not_found" };

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const next: PublicGameState = { ...mutate(current), version: current.version + 1 };
      const result = await this.runUpdate(code, current.version, next);
      if (result.status === "ok") return { ok: true, state: next };
      if (result.status === "missing") return { ok: false, reason: "not_found" };
      current = result.current;
      // Kleine zufällige Pause, damit gleichzeitige Aufrufer nicht im Gleichschritt kollidieren.
      await sleep(Math.random() * 15);
    }
    return { ok: false, reason: "busy" };
  }

  private async runUpdate(code: string, expected: number, next: PublicGameState): Promise<ScriptResult> {
    const message = JSON.stringify({ v: next.version, state: next });
    const keys = [this.gameKey(code)];
    const common = [expected, next.version, JSON.stringify(next), this.ttl];

    let raw: unknown;
    if (this.publishInScript) {
      try {
        raw = await this.port.eval(UPDATE_SCRIPT_WITH_PUBLISH, keys, [...common, this.channel(code), message]);
      } catch (error) {
        // Eine Redis Variante, die PUBLISH in Lua nicht erlaubt, meldet das mit einem Fehler, der PUBLISH nennt.
        if (!/publish/i.test(error instanceof Error ? error.message : String(error))) throw error;
        console.warn("[store] PUBLISH in Lua nicht erlaubt, veröffentliche künftig getrennt.");
        this.publishInScript = false;
        return this.runUpdate(code, expected, next);
      }
    } else {
      raw = await this.port.eval(UPDATE_SCRIPT_WITHOUT_PUBLISH, keys, common);
      if (Array.isArray(raw) && Number(raw[0]) === 1) await this.port.publish(this.channel(code), message);
    }

    if (!Array.isArray(raw)) throw new Error("Unerwartete Antwort des Update Skripts.");
    if (Number(raw[0]) === 1) return { status: "ok" };
    const currentRaw = raw[1];
    if (typeof currentRaw !== "string") return { status: "missing" };
    return { status: "conflict", current: parseState(currentRaw) };
  }

  /** Setzt die Phase des Spiels. Gedacht für Meilenstein 4 und 5, in Meilenstein 3 für Tests und das Labor. */
  async setPhase(code: string, phase: PublicGameState["phase"]): Promise<UpdateOutcome> {
    return this.update(code, (state) => ({ ...state, phase }));
  }

  /** Erhöht nur die Version und veröffentlicht den unveränderten Zustand. Dient Messungen. */
  async touch(code: string): Promise<UpdateOutcome> {
    return this.update(code, (state) => state);
  }

  /**
   * Nimmt einen Spieler auf. Der Name wird bereinigt und muss pro Spiel eindeutig sein (ohne Beachtung der
   * Gross und Kleinschreibung). Beitritt ist nur im Warteraum möglich.
   */
  async joinPlayer(code: string, input: { name: string; avatar: number }): Promise<JoinResult> {
    const name = normalizePlayerName(input.name);
    if (!name.ok) return { ok: false, reason: "invalid_name" };
    if (!isValidAvatar(input.avatar)) return { ok: false, reason: "invalid_avatar" };

    const existing = await this.getState(code);
    if (!existing) return { ok: false, reason: "not_found" };

    const player: PublicPlayer = { id: generatePlayerId(), name: name.name, avatar: input.avatar };
    const token = generatePlayerToken();
    const tokenHash = hashPlayerToken(token, this.options.tokenSecret);
    const tokenKey = this.tokenKey(code);

    // Das Token wird vor dem Zustand gespeichert. Ein übrig gebliebenes Token ohne Spieler ist wirkungslos,
    // ein Spieler ohne Token wäre ein Geist im Warteraum, der sich nie wieder verbinden kann.
    await this.port.hset(tokenKey, tokenHash, player.id);
    await this.port.expire(tokenKey, this.ttl);

    let outcome: UpdateOutcome;
    try {
      outcome = await this.update(code, (state) => addPlayer(state, player), existing);
    } catch (error) {
      await this.port.hdel(tokenKey, tokenHash);
      if (error instanceof GameRuleError) return { ok: false, reason: error.reason };
      throw error;
    }
    if (!outcome.ok) {
      await this.port.hdel(tokenKey, tokenHash);
      return { ok: false, reason: outcome.reason === "busy" ? "busy" : "not_found" };
    }
    return { ok: true, token, player, state: outcome.state };
  }

  /**
   * Prüft ein Spielertoken und liefert den aktuellen Zustand. Zustand und Token werden in einer einzigen
   * Anfrage gelesen. Das ist der Zustandsabgleich beim Verbinden.
   */
  async authenticatePlayer(code: string, token: string): Promise<AuthResult> {
    const tokenHash = hashPlayerToken(token, this.options.tokenSecret);
    const [rawState, playerId] = await this.port.hgetBatch([
      { key: this.gameKey(code), field: "s" },
      { key: this.tokenKey(code), field: tokenHash },
    ]);
    if (!rawState) return { ok: false, reason: "not_found" };
    const state = parseState(rawState);
    const player = playerId ? state.players.find((candidate) => candidate.id === playerId) : undefined;
    if (!player) return { ok: false, reason: "bad_token" };
    return { ok: true, state, player };
  }
}
