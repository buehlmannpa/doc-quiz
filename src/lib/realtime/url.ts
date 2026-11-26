/**
 * Adresse des WebSocket Endpunkts, vom Browser aus gesehen.
 *
 * Normalerweise dieselbe Adresse wie die Seite (wss auf Vercel). Für die lokale Entwicklung läuft der Endpunkt in
 * einem eigenen Prozess (npm run dev:ws), weil next dev keinen WebSocket Upgrade kennt. Dann zeigt die Variable
 * NEXT_PUBLIC_WS_URL darauf, zum Beispiel ws://localhost:3001/api/ws.
 */
export function websocketUrl(): string {
  const override = process.env.NEXT_PUBLIC_WS_URL;
  if (override) return override;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/ws`;
}
