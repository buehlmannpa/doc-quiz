import { describe, expect, it } from "vitest";
import { advance, bubbleRadius, createWorld, hash01, nudge, resize, step, syncBubbles } from "./bubbles";

const ids = (count: number) => Array.from({ length: count }, (_, index) => `spieler-${index}`);

function run(world: ReturnType<typeof createWorld>, seconds: number): void {
  for (let index = 0; index < seconds * 60; index += 1) step(world);
}

describe("Bubble Physik", () => {
  it("hält alle Bubbles innerhalb der Fläche", () => {
    const world = createWorld(900, 600);
    syncBubbles(world, ids(40));
    run(world, 20);
    for (const bubble of world.bubbles) {
      expect(bubble.x).toBeGreaterThanOrEqual(bubble.r - 0.001);
      expect(bubble.x).toBeLessThanOrEqual(world.width - bubble.r + 0.001);
      expect(bubble.y).toBeGreaterThanOrEqual(bubble.r - 0.001);
      expect(bubble.y).toBeLessThanOrEqual(world.height - bubble.r + 0.001);
      expect(Number.isFinite(bubble.x + bubble.y + bubble.vx + bubble.vy)).toBe(true);
    }
  });

  it("verhindert starke Überlappungen auch bei 60 Bubbles", () => {
    const world = createWorld(1280, 720);
    syncBubbles(world, ids(60));
    run(world, 15);
    let worst = 0;
    for (let i = 0; i < world.bubbles.length; i += 1) {
      for (let j = i + 1; j < world.bubbles.length; j += 1) {
        const a = world.bubbles[i]!;
        const b = world.bubbles[j]!;
        const overlap = a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y);
        worst = Math.max(worst, overlap / (a.r + b.r));
      }
    }
    // Eine kleine Überlappung während der Bewegung ist erlaubt, tiefe Überlagerung nicht.
    expect(worst).toBeLessThan(0.25);
  });

  it("ist wiederholbar: gleiche Eingaben ergeben gleiche Bewegung", () => {
    const a = createWorld(800, 500);
    const b = createWorld(800, 500);
    syncBubbles(a, ids(10));
    syncBubbles(b, ids(10));
    run(a, 5);
    run(b, 5);
    expect(a.bubbles.map((bubble) => [bubble.x, bubble.y])).toEqual(b.bubbles.map((bubble) => [bubble.x, bubble.y]));
  });

  it("lässt neue Bubbles erscheinen, entfernt fehlende und behält die anderen", () => {
    const world = createWorld(800, 500);
    syncBubbles(world, ids(3));
    const first = world.bubbles[0]!;
    run(world, 1);
    const position = { x: first.x, y: first.y };
    syncBubbles(world, [...ids(2), "neu"]);
    expect(world.bubbles.map((bubble) => bubble.id)).toEqual(["spieler-0", "spieler-1", "neu"]);
    expect(world.bubbles[0]).toBe(first);
    expect(first.x).toBe(position.x);
  });

  it("gibt einer gesprungenen Bubble einen Impuls nach oben und lässt sie leuchten", () => {
    const world = createWorld(800, 500);
    syncBubbles(world, ids(3));
    run(world, 2);
    const bubble = world.bubbles[1]!;
    expect(nudge(world, bubble.id)).toBe(true);
    expect(bubble.vy).toBeLessThan(-100);
    expect(bubble.glowUntil).toBeGreaterThan(world.time);
    expect(nudge(world, "unbekannt")).toBe(false);
  });

  it("passt Radius und Positionen an eine neue Fenstergrösse an", () => {
    const world = createWorld(800, 400);
    syncBubbles(world, ids(12));
    run(world, 2);
    resize(world, 1600, 800);
    for (const bubble of world.bubbles) {
      expect(bubble.x).toBeLessThanOrEqual(1600);
      expect(bubble.y).toBeLessThanOrEqual(800);
    }
    expect(world.bubbles[0]?.r).toBeCloseTo(bubbleRadius(12, 1600, 800));
  });

  it("wählt den Radius so, dass alle Platz haben", () => {
    expect(bubbleRadius(1, 1000, 600)).toBeLessThanOrEqual(110);
    expect(bubbleRadius(60, 1000, 600)).toBeGreaterThanOrEqual(28);
    expect(bubbleRadius(5, 1000, 600)).toBeGreaterThan(bubbleRadius(60, 1000, 600));
  });

  it("begrenzt die Schritte pro Bild nach einem langen Stillstand", () => {
    const world = createWorld(800, 500);
    syncBubbles(world, ids(5));
    advance(world, 30);
    expect(world.time).toBeLessThan(8 / 60 + 0.001);
  });

  it("läuft auf schnellen Bildschirmen gleich schnell wie auf langsamen", () => {
    const slow = createWorld(800, 500);
    const fast = createWorld(800, 500);
    syncBubbles(slow, ids(6));
    syncBubbles(fast, ids(6));
    // Eine Sekunde als 60 Bilder zu je 1/60 und als 144 Bilder zu je 1/144.
    for (let index = 0; index < 60; index += 1) advance(slow, 1 / 60 + 1e-9);
    for (let index = 0; index < 144; index += 1) advance(fast, 1 / 144);
    expect(Math.abs(slow.time - fast.time)).toBeLessThan(0.03);
    expect(fast.time).toBeGreaterThan(0.95);
  });

  it("liefert stabile Zufallszahlen aus Zeichenketten", () => {
    expect(hash01("abc")).toBe(hash01("abc"));
    expect(hash01("abc")).not.toBe(hash01("abd"));
    expect(hash01("abc", 2)).toBeGreaterThanOrEqual(0);
    expect(hash01("abc", 2)).toBeLessThan(1);
  });
});
