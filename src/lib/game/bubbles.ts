/**
 * Physik der Bubbles im Warteraum. Reine Funktionen ohne Canvas, Browser oder Zufall, damit alles testbar ist.
 *
 * Jede Bubble ist ein Kreis, der langsam schwebt, an den Rändern abprallt und sich mit anderen Bubbles nicht
 * überlappt. Ein Sprung ("nudge") gibt der Bubble einen Impuls nach oben, danach zieht eine leichte Schwerkraft
 * sie wieder zurück in die Schwebe. Die Simulation läuft mit festem Zeitschritt, damit sie unabhängig von der
 * Bildrate gleich aussieht.
 */
export type Bubble = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius in Pixeln. */
  r: number;
  /** Bis zu diesem Zeitpunkt (Sekunden Simulationszeit) leuchtet die Bubble nach einem Sprung. */
  glowUntil: number;
};

export type World = {
  width: number;
  height: number;
  time: number;
  /** Zeit, die noch nicht für einen ganzen Schritt gereicht hat (Sekunden). Sie geht nicht verloren. */
  carry: number;
  bubbles: Bubble[];
};

export const STEP = 1 / 60;
const MAX_SPEED = 160;
const DRIFT = 14;
const DAMPING = 0.995;

/** Radius abhängig von der Zahl der Bubbles und der Grösse der Fläche, damit alle Platz haben. */
export function bubbleRadius(count: number, width: number, height: number): number {
  const area = width * height;
  const perBubble = area / Math.max(1, count);
  // Etwa 45 Prozent der Fläche sollen mit Bubbles gefüllt sein.
  const radius = Math.sqrt((perBubble * 0.45) / Math.PI);
  return Math.max(28, Math.min(radius, Math.min(width, height) / 5, 110));
}

/** Einfache, wiederholbare Zahl zwischen 0 und 1 aus einer Zeichenkette (für Startpositionen). */
export function hash01(text: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100_000) / 100_000;
}

export function createWorld(width: number, height: number): World {
  return { width, height, time: 0, carry: 0, bubbles: [] };
}

/** Gleicht die Bubbles mit den Teilnehmenden ab: neue erscheinen, fehlende verschwinden, die anderen bleiben. */
export function syncBubbles(world: World, ids: readonly string[]): void {
  const radius = bubbleRadius(ids.length, world.width, world.height);
  const known = new Map(world.bubbles.map((bubble) => [bubble.id, bubble]));
  world.bubbles = ids.map((id) => {
    const existing = known.get(id);
    if (existing) {
      existing.r = radius;
      return existing;
    }
    // Neue Bubbles starten oben, schwebend. Position und Richtung ergeben sich aus der Kennung.
    const angle = hash01(id, 1) * Math.PI * 2;
    return {
      id,
      x: radius + hash01(id, 2) * Math.max(1, world.width - 2 * radius),
      y: radius + hash01(id, 3) * Math.max(1, world.height - 2 * radius) * 0.3,
      vx: Math.cos(angle) * DRIFT,
      vy: Math.sin(angle) * DRIFT,
      r: radius,
      glowUntil: 0,
    };
  });
}

export function resize(world: World, width: number, height: number): void {
  const sx = world.width > 0 ? width / world.width : 1;
  const sy = world.height > 0 ? height / world.height : 1;
  world.width = width;
  world.height = height;
  const radius = bubbleRadius(world.bubbles.length, width, height);
  for (const bubble of world.bubbles) {
    bubble.x *= sx;
    bubble.y *= sy;
    bubble.r = radius;
  }
}

/** Die Bubble hüpft: Impuls nach oben und ein kurzes Leuchten. */
export function nudge(world: World, id: string): boolean {
  const bubble = world.bubbles.find((candidate) => candidate.id === id);
  if (!bubble) return false;
  bubble.vy = -Math.max(220, bubble.r * 4.5);
  bubble.vx += (hash01(id, Math.floor(world.time * 10)) - 0.5) * 80;
  bubble.glowUntil = world.time + 0.8;
  return true;
}

/** Ein Zeitschritt: Bewegung, Reibung, sanfte Schwerkraft nach unten, Ränder und Abstossung. */
export function step(world: World, dt = STEP): void {
  world.time += dt;
  const { width, height, bubbles } = world;
  for (const bubble of bubbles) {
    // Leichte Schwerkraft, damit Sprünge wieder abklingen. Die Mitte der Fläche zieht schwach an.
    bubble.vy += 120 * dt;
    bubble.vx += ((width / 2 - bubble.x) / width) * 6 * dt;
    bubble.vx *= DAMPING;
    bubble.vy *= DAMPING;
    // Ruhende Bubbles sollen sanft weiterschweben und nicht stillstehen.
    const speed = Math.hypot(bubble.vx, bubble.vy);
    if (speed < DRIFT * 0.4) {
      const angle = hash01(bubble.id, Math.floor(world.time * 2)) * Math.PI * 2;
      bubble.vx += Math.cos(angle) * DRIFT * dt * 6;
      bubble.vy += Math.sin(angle) * DRIFT * dt * 6;
    }
    if (speed > MAX_SPEED * 3) {
      bubble.vx = (bubble.vx / speed) * MAX_SPEED * 3;
      bubble.vy = (bubble.vy / speed) * MAX_SPEED * 3;
    }
    bubble.x += bubble.vx * dt;
    bubble.y += bubble.vy * dt;

    if (bubble.x < bubble.r) {
      bubble.x = bubble.r;
      bubble.vx = Math.abs(bubble.vx) * 0.8;
    } else if (bubble.x > width - bubble.r) {
      bubble.x = width - bubble.r;
      bubble.vx = -Math.abs(bubble.vx) * 0.8;
    }
    if (bubble.y < bubble.r) {
      bubble.y = bubble.r;
      bubble.vy = Math.abs(bubble.vy) * 0.6;
    } else if (bubble.y > height - bubble.r) {
      bubble.y = height - bubble.r;
      bubble.vy = -Math.abs(bubble.vy) * 0.55;
    }
  }

  // Abstossung: Überlappende Bubbles werden auseinandergeschoben und tauschen etwas Geschwindigkeit aus.
  for (let i = 0; i < bubbles.length; i += 1) {
    const a = bubbles[i];
    if (!a) continue;
    for (let j = i + 1; j < bubbles.length; j += 1) {
      const b = bubbles[j];
      if (!b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minDistance = a.r + b.r;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= minDistance * minDistance) continue;
      const distance = Math.sqrt(distanceSquared) || 0.001;
      const nx = distance > 0.001 ? dx / distance : 1;
      const ny = distance > 0.001 ? dy / distance : 0;
      const overlap = (minDistance - distance) / 2;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;
      const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (relative < 0) {
        const impulse = relative * 0.9;
        a.vx += nx * impulse;
        a.vy += ny * impulse;
        b.vx -= nx * impulse;
        b.vy -= ny * impulse;
      }
    }
  }

  // Das Auseinanderschieben darf keine Bubble über den Rand drücken. Bei dichtem Gedränge bleibt eine kleine
  // Überlappung bestehen, das ist besser als eine Bubble ausserhalb der Fläche.
  for (const bubble of bubbles) {
    bubble.x = Math.min(Math.max(bubble.x, bubble.r), Math.max(bubble.r, width - bubble.r));
    bubble.y = Math.min(Math.max(bubble.y, bubble.r), Math.max(bubble.r, height - bubble.r));
  }
}

/**
 * Mehrere feste Schritte für eine verstrichene Zeit. Der Rest, der für keinen ganzen Schritt reicht, wird
 * übertragen: Auf einem Bildschirm mit 144 Hz ist ein Bild kürzer als ein Schritt, die Simulation läuft trotzdem
 * gleich schnell. Die Zahl der Schritte ist begrenzt, damit ein langer Stillstand (Tab im Hintergrund) nicht rast.
 */
export function advance(world: World, elapsedSeconds: number): void {
  world.carry += Math.max(0, elapsedSeconds);
  let steps = 0;
  while (world.carry >= STEP && steps < 8) {
    step(world);
    world.carry -= STEP;
    steps += 1;
  }
  if (steps >= 8) world.carry = 0;
}
