/**
 * Beitritt zu einem Spiel und Prüfung eines Spielcodes.
 *
 * POST /api/join   { code, name, avatar }  legt den Spieler an und liefert sein Token (nur einmal, es steht danach
 *                  nur im Browser des Spielers und in Redis als Hash).
 * GET  /api/join?code=123456               sagt, ob es das Spiel gibt und ob ein Beitritt noch möglich ist.
 *
 * Schutz: Origin Prüfung gegen fremde Seiten, Begrenzung pro IP (rateLimit), Zod für alle Eingaben.
 * Das Token wird nie protokolliert.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getClientIp } from "@/lib/auth/session";
import { AVATAR_COUNT, JOIN_FAILURE_MESSAGES, type JoinFailure } from "@/lib/realtime/game-state";
import { getGameStore } from "@/lib/realtime/instance";
import { isAllowedOrigin } from "@/lib/realtime/origin";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const joinSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: z.string().max(200),
  avatar: z.number().int().min(0).max(AVATAR_COUNT - 1),
});

const STATUS: Record<JoinFailure, number> = {
  not_found: 404,
  closed: 409,
  name_taken: 409,
  invalid_name: 400,
  invalid_avatar: 400,
  full: 409,
  busy: 503,
};

/** Beitritte pro IP und Zeitfenster. Ein Club WLAN teilt sich eine IP, deshalb ist die Grenze grosszügig. */
const JOIN_LIMIT = { limit: 120, windowSeconds: 600 };

function originAllowed(request: NextRequest): boolean {
  const hosts = [request.headers.get("host"), request.headers.get("x-forwarded-host")];
  return isAllowedOrigin(request.headers.get("origin"), hosts);
}

function failure(reason: JoinFailure | "rate_limited" | "unavailable", message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, reason, message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!originAllowed(request)) return failure("unavailable", "Anfrage nicht erlaubt.", 403);

  const limited = await rateLimit("join", await getClientIp(), JOIN_LIMIT);
  if (!limited.allowed) {
    return failure("rate_limited", "Zu viele Versuche. Bitte warten Sie einen Moment.", 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("invalid_name", "Die Anfrage ist ungültig.", 400);
  }
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) return failure("invalid_name", JOIN_FAILURE_MESSAGES.invalid_name, 400);

  try {
    const result = await getGameStore().joinPlayer(parsed.data.code, { name: parsed.data.name, avatar: parsed.data.avatar });
    if (!result.ok) return failure(result.reason, JOIN_FAILURE_MESSAGES[result.reason], STATUS[result.reason]);
    return NextResponse.json(
      { ok: true, token: result.token, player: result.player },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[join] Fehler:", error instanceof Error ? error.message : String(error));
    return failure("unavailable", "Der Dienst ist vorübergehend nicht verfügbar. Bitte versuchen Sie es gleich noch einmal.", 503);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code") ?? "";
  if (!/^\d{6}$/.test(code)) return failure("not_found", JOIN_FAILURE_MESSAGES.not_found, 404);

  const limited = await rateLimit("join-check", await getClientIp(), JOIN_LIMIT);
  if (!limited.allowed) return failure("rate_limited", "Zu viele Versuche. Bitte warten Sie einen Moment.", 429);

  try {
    const state = await getGameStore().getState(code);
    if (!state) return failure("not_found", JOIN_FAILURE_MESSAGES.not_found, 404);
    return NextResponse.json(
      { ok: true, open: state.phase === "lobby", title: state.quiz?.title ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[join] Fehler:", error instanceof Error ? error.message : String(error));
    return failure("unavailable", "Der Dienst ist vorübergehend nicht verfügbar.", 503);
  }
}
