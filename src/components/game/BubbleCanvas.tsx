"use client";

/**
 * Canvas mit den Bubbles der Teilnehmenden im Warteraum. Die Physik steckt in lib/game/bubbles.ts, hier wird nur
 * gezeichnet. Glasoptik ohne teuren Weichzeichner: ein Farbverlauf, ein heller Rand und ein Glanzpunkt.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { avatarEmoji } from "@/lib/game/avatars";
import { advance, createWorld, nudge, resize, syncBubbles, type World } from "@/lib/game/bubbles";
import type { PublicPlayer } from "@/lib/realtime/game-state";

export type BubbleCanvasHandle = { nudge: (playerId: string) => void };

type Props = { players: readonly PublicPlayer[] };

function draw(context: CanvasRenderingContext2D, world: World, players: ReadonlyMap<string, PublicPlayer>): void {
  context.clearRect(0, 0, world.width, world.height);
  for (const bubble of world.bubbles) {
    const player = players.get(bubble.id);
    if (!player) continue;
    const glow = Math.max(0, Math.min(1, (bubble.glowUntil - world.time) / 0.8));

    // Körper: heller Verlauf mit leichtem Rot, bei einem Sprung stärker.
    const gradient = context.createRadialGradient(
      bubble.x - bubble.r * 0.3,
      bubble.y - bubble.r * 0.35,
      bubble.r * 0.1,
      bubble.x,
      bubble.y,
      bubble.r,
    );
    gradient.addColorStop(0, `rgba(255, 255, 255, ${0.95})`);
    gradient.addColorStop(0.7, `rgba(255, ${235 - glow * 90}, ${235 - glow * 120}, 0.82)`);
    gradient.addColorStop(1, `rgba(${227}, ${6 + (1 - glow) * 60}, 19, ${0.18 + glow * 0.35})`);
    context.beginPath();
    context.arc(bubble.x, bubble.y, bubble.r, 0, Math.PI * 2);
    context.fillStyle = gradient;
    context.fill();
    context.lineWidth = 2 + glow * 3;
    context.strokeStyle = `rgba(227, 6, 19, ${0.25 + glow * 0.6})`;
    context.stroke();

    // Glanzpunkt.
    context.beginPath();
    context.ellipse(bubble.x - bubble.r * 0.35, bubble.y - bubble.r * 0.45, bubble.r * 0.22, bubble.r * 0.12, -0.6, 0, Math.PI * 2);
    context.fillStyle = "rgba(255, 255, 255, 0.75)";
    context.fill();

    // Icon und Name.
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `${Math.round(bubble.r * 0.85)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    context.fillStyle = "#1d1d1f";
    context.fillText(avatarEmoji(player.avatar), bubble.x, bubble.y - bubble.r * 0.12);
    const fontSize = Math.max(11, Math.round(bubble.r * 0.26));
    context.font = `700 ${fontSize}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    let label = player.name;
    const maxWidth = bubble.r * 1.7;
    while (label.length > 2 && context.measureText(label).width > maxWidth) label = `${label.slice(0, -2)}…`;
    context.fillText(label, bubble.x, bubble.y + bubble.r * 0.58);
  }
}

const BubbleCanvas = forwardRef<BubbleCanvasHandle, Props>(function BubbleCanvas({ players }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<World>(createWorld(800, 500));
  const playersRef = useRef<Map<string, PublicPlayer>>(new Map());

  useImperativeHandle(ref, () => ({
    nudge: (playerId) => {
      nudge(worldRef.current, playerId);
    },
  }));

  useEffect(() => {
    playersRef.current = new Map(players.map((player) => [player.id, player]));
    syncBubbles(
      worldRef.current,
      players.map((player) => player.id),
    );
  }, [players]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const world = worldRef.current;

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      resize(world, rect.width, rect.height);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);

    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      advance(world, (now - last) / 1000);
      last = now;
      draw(context, world, playersRef.current);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="h-full w-full" role="img" aria-label={`${players.length} Teilnehmende als Bubbles`} />;
});

export default BubbleCanvas;
