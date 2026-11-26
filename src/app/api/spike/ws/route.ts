/**
 * Spike: WebSocket Endpunkt für die Messungen in Meilenstein 1.
 * Nur mit SPIKE_ENABLED=1 und nie in der Produktion (siehe guard.ts).
 */
import { upgradeWebSocket } from "@vercel/functions";
import { registerSpikeSocket } from "@/lib/spike/hub";
import { spikeGuard } from "@/lib/spike/guard";

export const dynamic = "force-dynamic";
// Hobby: 300 Sekunden sind Standard und Maximum. Die Verbindung wird bei Erreichen dieser Dauer geschlossen.
export const maxDuration = 300;

export async function GET(): Promise<Response> {
  const blocked = spikeGuard();
  if (blocked) return blocked;
  try {
    return await upgradeWebSocket((ws) => {
      registerSpikeSocket(ws);
    });
  } catch (error) {
    // Ausserhalb der Vercel Laufzeit (zum Beispiel mit next dev) gibt es keinen WebSocket Upgrade.
    // Das ist erwartet und soll nicht als Serverfehler erscheinen. Alles andere wird weitergereicht.
    if (error instanceof Error && /not available in the current runtime/.test(error.message)) {
      return new Response("WebSocket Upgrade ist nur in der Vercel Laufzeit verfügbar.", { status: 501 });
    }
    throw error;
  }
}
