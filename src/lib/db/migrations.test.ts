import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countPending, MigrationError, readJournal } from "./migrations";

describe("countPending", () => {
  const entries = [
    { tag: "0000_init", when: 1_000 },
    { tag: "0001_next", when: 2_000 },
    { tag: "0002_more", when: 3_000 },
  ];

  it("zählt alle, wenn nichts angewendet ist", () => {
    expect(countPending(entries, 0)).toBe(3);
  });

  it("zählt nur Migrationen nach der zuletzt angewendeten", () => {
    expect(countPending(entries, 1_000)).toBe(2);
    expect(countPending(entries, 2_000)).toBe(1);
    expect(countPending(entries, 3_000)).toBe(0);
  });
});

describe("readJournal", () => {
  it("liest das Journal des Repositorys", () => {
    const entries = readJournal(path.join(process.cwd(), "drizzle"));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.tag).toBe("0000_init");
  });

  it("meldet einen fehlenden Ordner mit einer klaren Meldung", () => {
    expect(() => readJournal(path.join(os.tmpdir(), "gibt-es-nicht-xyz"))).toThrow(MigrationError);
  });

  it("lehnt ein ungültiges Journal ab", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-"));
    fs.mkdirSync(path.join(dir, "meta"));
    fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ entries: [{ tag: 1 }] }));
    expect(() => readJournal(dir)).toThrow(MigrationError);
    fs.rmSync(dir, { recursive: true });
  });
});
