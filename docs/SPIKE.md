# Messungen in Meilenstein 1 (Spike)

Dieser Test beantwortet vier Fragen, bevor Meilenstein 3 darauf aufbaut. Er läuft auf einem Preview Deployment in Frankfurt. Die Endpunkte sind nur mit `SPIKE_ENABLED=1` aktiv und in der Produktion immer gesperrt. Nach der Auswertung werden sie entfernt.

Fragen:

1. Läuft `upgradeWebSocket` auf dem Hobby Plan in Frankfurt stabil?
2. Wie verteilen sich 60 Verbindungen auf Funktionsinstanzen?
3. Erreicht eine Publish Nachricht alle Verbindungen auf allen Instanzen, ohne Verlust und schnell? Welcher Weg für SUBSCRIBE ist zuverlässiger: ioredis über TCP oder das Upstash SDK über SSE?
4. Nach wie vielen Sekunden und mit welchem Close Code schliesst die Plattform eine Verbindung?

Was lokal bereits geprüft ist: Die Messlogik wurde gegen Ersatzserver mit demselben Protokoll getestet. Das sagt nichts über das Verhalten von Vercel und Upstash. Genau das soll dieser Test klären.

## Vorbereitung

1. Einrichtung nach `docs/SETUP.md` abschliessen, der Systemcheck muss `"ok": true` zeigen.
2. In Vercel die Variable `SPIKE_ENABLED=1` setzen, nur für Preview. Danach ein Redeploy auslösen.
3. Die Adresse des Preview Deployments notieren.

## Messung A: Vergleich der Subscribe Wege (im Browser)

Öffnen Sie, angemeldet bei Vercel, diese Adressen im Browser und speichern Sie die Antworten:

1. `https://IHR-PREVIEW/api/spike/compare?count=50&interval=20`
2. `https://IHR-PREVIEW/api/spike/compare?count=50&interval=20&idle=60`

Die zweite Messung wartet nach dem Abonnieren 60 Sekunden, bevor sie veröffentlicht. So zeigt sich, ob eine ruhende Subscription still abreisst. Das SDK beendet seine Schleife bei einem Stream Ende ohne Meldung (siehe `src/lib/redis/rest.ts`).

Wichtige Felder pro Weg:

* `received` gegen `expected`: Fehlende Nachrichten sind `missingCount`.
* `latencyMs`: p50, p95 und max. Gemessen im selben Prozess, ohne Uhrenabweichung.
* `subscribeReadyMs`: Zeit bis das Abonnement bestätigt ist.
* `errors`: Fehlermeldungen.

## Messung B: WebSocket mit vielen Verbindungen (Skript)

Das Skript läuft auf Ihrem Rechner (Node 22, nach `npm install`) und öffnet echte WebSocket Verbindungen zum Preview Deployment.

Zugang bei aktivem Vercel Schutz: Das Skript kann kein Browser Login. Zwei Möglichkeiten:

1. In den Projekteinstellungen von Vercel (Deployment Protection) ein Token für den automatisierten Zugriff erzeugen und mit `--bypass TOKEN` übergeben. Das Skript sendet den Header `x-vercel-protection-bypass`. Ob diese Funktion im Hobby Plan verfügbar ist, habe ich nicht geprüft.
2. Den Schutz für das Preview Deployment vorübergehend ausschalten. Das ist bei diesem Test vertretbar, weil die Spike Endpunkte nur mit `SPIKE_ENABLED=1` antworten. Danach wieder einschalten.

Eigene Header gehen mit `--header "Name: Wert"`.

Läufe (jeweils im Projektordner):

```bash
npm run spike:ws -- --url https://IHR-PREVIEW --clients 20 --publishes 100
npm run spike:ws -- --url https://IHR-PREVIEW --clients 60 --publishes 100 --hold 330
```

Der zweite Lauf entspricht der Spielgrösse und wartet bis zu 330 Sekunden, um das Schliessen durch die Plattform zu beobachten. Das Skript schreibt das Ergebnis nach `spike-result.json` (nicht im Repository) und gibt es aus.

Wichtige Felder:

* `connect`: wie viele Verbindungen klappen, mit Fehlern und Dauer.
* `instances`: auf wie viele Instanzen sich die Verbindungen verteilen.
* `ping.rttMs`: Roundtrip Zeit zwischen Ihrem Rechner und der Funktion.
* `delivery`: Verluste, Doppelte und Latenz der Zustellung. `serverLatencyMs` vergleicht zwei Serveruhren und `endToEndMs` ist nur ein Richtwert.
* `hold`: Alter beim Schliessen in Sekunden und die Close Codes. `closingSoonReceived` zählt, wie viele Clients die Vorwarnung bei 285 Sekunden erhalten haben.

Kosten der Messungen: Ein Lauf mit 100 Nachrichten verbraucht etwa 100 Redis Befehle. Das Monatskontingent von 500'000 Befehlen bleibt praktisch unberührt.

## Logs ansehen

In den Vercel Logs des Deployments erscheinen strukturierte Einträge. Filtern Sie nach `ws_close`: Sie zeigen Close Code, Alter der Verbindung und die Instanz. Weitere Einträge sind `ws_open`, `redis_subscribed` und `redis_released`.

## Auswertung

Meine Vorschläge für die Beurteilung (Richtwerte, keine Vorgabe aus der Spezifikation):

1. **Zustellung:** `missingCount` und `totalMissing` sollen 0 sein, ohne Doppelte.
2. **Latenz:** p95 der Zustellung unter 100 Millisekunden innerhalb der Region.
3. **Verteilung:** Egal wie viele Instanzen entstehen, alle Verbindungen müssen jede Nachricht erhalten.
4. **Plattformgrenze:** Die Verbindung endet bei etwa 300 Sekunden. Wir halten den Close Code fest. Der Client behandelt in jedem Fall jeden Abbruch gleich.
5. **Subscribe Weg:** ioredis bleibt die Wahl, solange es zuverlässig ist. Das SDK über SSE würde nur in Frage kommen, wenn es sich in beiden Messungen gleich gut verhält. Wegen der fehlenden Wiederverbindung bleibt es auch dann nur zweite Wahl.

## Ergebnisse eintragen

Bitte tragen Sie die Resultate in `docs/SPIKE_ERGEBNISSE.md` ein oder senden Sie mir die beiden Ausgaben. Ich übernehme die Entscheide dann in `CLAUDE.md`.

## Aufräumen

Nach der Auswertung entferne ich diese Dateien: `src/app/api/spike/`, `src/lib/spike/`, `scripts/spike-ws.mjs` und den Eintrag `spike:ws` in `package.json`. Der Hub in `src/lib/spike/hub.ts` ist die Vorlage für den echten Hub in Meilenstein 3.
