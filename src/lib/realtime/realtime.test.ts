import { describe, expect, it } from "vitest";
import {
  addPlayer,
  AVATAR_COUNT,
  createInitialState,
  GameRuleError,
  isValidAvatar,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  nameKey,
  normalizePlayerName,
  publicGameStateSchema,
  type PublicGameState,
} from "./game-state";
import { clientMessageSchema, serverMessageSchema, FATAL_CLOSE_CODES, CLOSE_CODES } from "./protocol";
import { generatePlayerId, generatePlayerToken, hashPlayerToken, looksLikePlayerToken } from "./tokens";

const base = (): PublicGameState => createInitialState("123456", 1_800_000_000_000);
const player = (id: string, name: string, avatar = 0) => ({ id, name, avatar });

describe("normalizePlayerName", () => {
  it("kürzt Leerraum am Rand und fasst mehrfache Leerzeichen zusammen", () => {
    expect(normalizePlayerName("  Patrick  ")).toEqual({ ok: true, name: "Patrick" });
    expect(normalizePlayerName("Max   Muster")).toEqual({ ok: true, name: "Max Muster" });
    expect(normalizePlayerName("a\t\nb")).toEqual({ ok: true, name: "a b" });
  });

  it("normalisiert Unicode, damit gleich aussehende Namen gleich sind", () => {
    // "e" plus kombinierender Akzent wird zum einzelnen Zeichen é.
    expect(normalizePlayerName("René")).toEqual({ ok: true, name: "René" });
  });

  it("lehnt leere Namen und zu lange Namen ab, gezählt in Zeichen", () => {
    expect(normalizePlayerName("").ok).toBe(false);
    expect(normalizePlayerName("   ").ok).toBe(false);
    expect(normalizePlayerName("x".repeat(MAX_NAME_LENGTH)).ok).toBe(true);
    expect(normalizePlayerName("x".repeat(MAX_NAME_LENGTH + 1)).ok).toBe(false);
    // Ein Emoji ist ein Zeichen, aber zwei Einheiten in UTF 16.
    expect(normalizePlayerName("😀".repeat(MAX_NAME_LENGTH)).ok).toBe(true);
    expect(normalizePlayerName("😀".repeat(MAX_NAME_LENGTH + 1)).ok).toBe(false);
  });

  it("lehnt Steuerzeichen und unsichtbare Zeichen ab", () => {
    expect(normalizePlayerName("a\u0000b").ok).toBe(false);
    expect(normalizePlayerName("a​b").ok).toBe(false); // Zero Width Space
    expect(normalizePlayerName("a‮b").ok).toBe(false); // Umkehrung der Schreibrichtung
    expect(normalizePlayerName("​").ok).toBe(false);
  });

  it("erlaubt Umlaute, Akzente und Emojis", () => {
    for (const name of ["Zoë", "Jürg", "Ñandú", "Ducati 🏍️"]) expect(normalizePlayerName(name).ok, name).toBe(true);
  });
});

describe("nameKey", () => {
  it("vergleicht ohne Beachtung der Gross und Kleinschreibung", () => {
    expect(nameKey("PATRICK")).toBe(nameKey("patrick"));
    expect(nameKey("ÄPFEL")).toBe(nameKey("äpfel"));
    expect(nameKey("a")).not.toBe(nameKey("b"));
  });
});

describe("isValidAvatar", () => {
  it("erlaubt nur ganze Zahlen im Bereich", () => {
    expect(isValidAvatar(0)).toBe(true);
    expect(isValidAvatar(AVATAR_COUNT - 1)).toBe(true);
    for (const bad of [-1, AVATAR_COUNT, 1.5, Number.NaN]) expect(isValidAvatar(bad), String(bad)).toBe(false);
  });
});

describe("addPlayer", () => {
  it("fügt einen Spieler hinzu, ohne den alten Zustand zu verändern", () => {
    const state = base();
    const next = addPlayer(state, player("1", "Anna"));
    expect(next.players).toHaveLength(1);
    expect(state.players).toHaveLength(0);
  });

  it("lehnt doppelte Namen ab, auch bei anderer Schreibweise", () => {
    const state = addPlayer(base(), player("1", "Anna"));
    expect(() => addPlayer(state, player("2", "anna"))).toThrowError(GameRuleError);
    try {
      addPlayer(state, player("2", "ANNA"));
    } catch (error) {
      expect((error as GameRuleError).reason).toBe("name_taken");
    }
  });

  it("lässt den Beitritt nur im Warteraum zu", () => {
    for (const phase of ["question", "finished"] as const) {
      try {
        addPlayer({ ...base(), phase }, player("1", "Anna"));
        expect.unreachable();
      } catch (error) {
        expect((error as GameRuleError).reason).toBe("closed");
      }
    }
  });

  it("begrenzt die Zahl der Teilnehmenden", () => {
    let state = base();
    for (let i = 0; i < MAX_PLAYERS; i += 1) state = addPlayer(state, player(`id${i}`, `Spieler ${i}`));
    try {
      addPlayer(state, player("zuviel", "Zu viel"));
      expect.unreachable();
    } catch (error) {
      expect((error as GameRuleError).reason).toBe("full");
    }
  });
});

describe("publicGameStateSchema", () => {
  it("akzeptiert einen gültigen Zustand und lehnt Ungültiges ab", () => {
    expect(publicGameStateSchema.safeParse(base()).success).toBe(true);
    expect(publicGameStateSchema.safeParse({ ...base(), code: "12" }).success).toBe(false);
    expect(publicGameStateSchema.safeParse({ ...base(), phase: "unbekannt" }).success).toBe(false);
    expect(publicGameStateSchema.safeParse({ ...base(), version: -1 }).success).toBe(false);
    expect(publicGameStateSchema.safeParse({ ...base(), players: [{ id: "1", name: "A", avatar: 99 }] }).success).toBe(false);
  });
});

describe("Spielertoken", () => {
  it("sind zufällig, lang genug und formal erkennbar", () => {
    const a = generatePlayerToken();
    const b = generatePlayerToken();
    expect(a).not.toBe(b);
    expect(looksLikePlayerToken(a)).toBe(true);
    expect(generatePlayerId()).not.toBe(generatePlayerId());
  });

  it("werden mit dem Geheimnis gehasht, nie im Klartext abgelegt", () => {
    const token = generatePlayerToken();
    const hash = hashPlayerToken(token, "geheimnis eins");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashPlayerToken(token, "geheimnis eins")).toBe(hash);
    expect(hashPlayerToken(token, "geheimnis zwei")).not.toBe(hash);
    expect(hashPlayerToken(generatePlayerToken(), "geheimnis eins")).not.toBe(hash);
  });

  it("lehnt formal unmögliche Token ab", () => {
    for (const bad of ["", "kurz", "a".repeat(31), "a".repeat(33), "a".repeat(31) + "!", "a b".repeat(11)]) {
      expect(looksLikePlayerToken(bad), bad).toBe(false);
    }
  });
});

describe("Protokoll: Nachrichten des Clients", () => {
  const token = generatePlayerToken();

  it("akzeptiert hello für Spieler mit Token, für Bildschirm und Admin ohne Token", () => {
    expect(clientMessageSchema.safeParse({ type: "hello", protocol: 1, role: "player", code: "123456", token }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "hello", protocol: 1, role: "screen", code: "123456" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "hello", protocol: 1, role: "admin", code: "123456" }).success).toBe(true);
  });

  it("verlangt für Spieler ein Token", () => {
    expect(clientMessageSchema.safeParse({ type: "hello", protocol: 1, role: "player", code: "123456" }).success).toBe(false);
  });

  it("lehnt falsche Protokollversion, ungültigen Code und unbekannte Rolle ab", () => {
    const ok = { type: "hello", protocol: 1, role: "screen", code: "123456" };
    expect(clientMessageSchema.safeParse({ ...ok, protocol: 2 }).success).toBe(false);
    for (const code of ["12345", "1234567", "abcdef", "12 456", ""]) {
      expect(clientMessageSchema.safeParse({ ...ok, code }).success, code).toBe(false);
    }
    expect(clientMessageSchema.safeParse({ ...ok, role: "root" }).success).toBe(false);
  });

  it("akzeptiert ping und lehnt alles andere ab", () => {
    expect(clientMessageSchema.safeParse({ type: "ping", t0: 12345 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "ping", t0: Number.NaN }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "ping" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "cmd", name: "reset" }).success).toBe(false);
    expect(clientMessageSchema.safeParse("hello").success).toBe(false);
    expect(clientMessageSchema.safeParse(null).success).toBe(false);
  });
});

describe("Protokoll: Nachrichten des Servers", () => {
  it("erkennt gültige Nachrichten", () => {
    const state = base();
    expect(serverMessageSchema.safeParse({ type: "state", version: 0, state }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ type: "pong", t0: 1, serverTime: 2 }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ type: "reconnect", reason: "max_age" }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ type: "error", code: "x", message: "y" }).success).toBe(true);
    expect(
      serverMessageSchema.safeParse({ type: "welcome", protocol: 1, role: "screen", serverTime: 1, instanceId: "a" }).success,
    ).toBe(true);
  });

  it("lehnt ungültige Zustände ab", () => {
    expect(serverMessageSchema.safeParse({ type: "state", version: 1, state: { code: "x" } }).success).toBe(false);
  });
});

describe("Close Codes", () => {
  it("liegen im privaten Bereich und sind eindeutig", () => {
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toBeGreaterThanOrEqual(4000);
    for (const code of codes) expect(code).toBeLessThan(5000);
  });

  it("nur Berechtigung und fehlendes Spiel sind endgültig", () => {
    expect([...FATAL_CLOSE_CODES].sort()).toEqual([CLOSE_CODES.UNAUTHORIZED, CLOSE_CODES.GAME_NOT_FOUND].sort());
  });
});
