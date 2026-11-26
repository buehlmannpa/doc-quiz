# Verbindungstest und lokale Entwicklung der Echtzeit Schicht

Das Verbindungslabor im Adminportal (`/admin/lab`) prüft die Echtzeit Verbindung mit bis zu 60 simulierten Teilnehmenden direkt aus dem Browser. Es verwendet denselben Client, denselben Endpunkt `/api/ws` und denselben Hub wie später die Smartphones. Gemessen wird also der echte Weg. Es braucht weder Node noch ein Skript noch ein Zugangstoken auf Ihrem Rechner.

Das Labor ersetzt die Messung aus Meilenstein 1.

## Auf Vercel testen

Voraussetzung ist ein Deployment, auf dem der Login funktioniert und das System Seite "in Ordnung" zeigt (siehe `docs/SETUP.md`). Es genügt ein Preview Deployment.

1. Im Adminportal im Menü "Verbindungslabor" öffnen.
2. Schritt 1: "Testspiel anlegen". Es entsteht ein Testspiel mit einem Code im Bereich 900000 bis 999999. Echte Spiele sind davon nicht betroffen.
3. Schritt 2: Anzahl wählen (zum Beispiel 20, später 60) und "Verbinden" klicken.
4. Schritt 3: die Tests durchführen (siehe unten).
5. Am Ende "Ergebnis kopieren" und mir den Text senden, dann "Beenden und aufräumen".

Lassen Sie den Browser Tab im Vordergrund. Hintergrund Tabs werden vom Browser gedrosselt, das verfälscht die Zeiten.

## Empfohlene Messreihe

1. **20 Teilnehmende, 10 Mal ändern:** Erwartet "Zustellung 200 von 200". Notieren Sie Median und p95 der Zustellung.
2. **60 Teilnehmende:** Anzahl auf 60 setzen, nachverbinden und noch einmal 10 Mal ändern (dann "600 von 600"). Notieren Sie, auf wie viele Instanzen sich die Verbindungen verteilen.
3. **30 Prozent trennen:** Simuliert Netzabbrüche. Alle müssen wieder "open" sein. Notieren Sie die Zeit der Wiederverbindung.
4. **Alle neu aufbauen:** Der kontrollierte Wechsel der Verbindung. Erwartet "60 von 60 ohne Unterbruch".
5. **Stehen lassen:** Lassen Sie die Verbindungen 6 Minuten offen. Der Client baut sie nach 240 Sekunden von selbst neu auf, der Server hätte sie bei 290 Sekunden beendet. Im Protokoll sollten keine unerwarteten Abbrüche stehen.
6. **Optional, Grenze der Plattform messen:**
   1. In Vercel die Variablen `REALTIME_MAX_AGE_NOTICE_MS` und `REALTIME_MAX_AGE_CLOSE_MS` auf `1000000` setzen und neu deployen. Der Server beendet Verbindungen dann nicht mehr selbst.
   2. Im Labor das Kästchen "Automatischen Neuaufbau ausschalten" wählen, dann 20 Teilnehmende verbinden und mindestens 6 Minuten warten.
   3. Das Protokoll zeigt "Verbindung beendet (Code …, Alter … s)". So erfahren wir den Close Code der Plattform und die genaue Dauer. Die Dokumentation von Vercel nennt beides nicht.
   4. Die Variablen danach wieder entfernen.

## Was ich aus den Ergebnissen ablese

Die Richtwerte sind meine Vorschläge. Die Spezifikation macht dazu keine Vorgabe.

1. **Zustellung:** fehlende Zustellungen sollen 0 sein.
2. **Latenz der Zustellung:** p95 unter 100 Millisekunden. Der Wert enthält den Weg bis zu Ihrem Browser, er hängt also auch von Ihrer Verbindung ab. Er ist eine Schätzung auf Basis des Uhrenabgleichs.
3. **Veröffentlichung:** Das Protokoll zeigt "script" oder "separate". "script" heisst, Upstash erlaubt PUBLISH innerhalb von Lua. "separate" heisst, der Speicher ist automatisch auf den Ersatzweg gewechselt. Beides funktioniert, "script" ist robuster.
4. **Verteilung:** Wie viele Instanzen entstehen, und ob alle Teilnehmenden jede Änderung erhalten.
5. **Neuaufbau:** Alle ohne Unterbruch.
6. **Kosten:** Notieren Sie vor und nach dem Lauf den Befehlszähler in der Upstash Konsole und den Verbrauch von Active CPU und Provisioned Memory im Vercel Dashboard. Daran sehen wir, was Publish und Subscribe Nachrichten kosten und was ruhende Verbindungen verbrauchen. Das ist in der Dokumentation nicht festgehalten.

## Grenzen des Labors

1. Alle simulierten Personen teilen sich Ihren Browser, Ihre IP und Ihre Verbindung. Mobilfunk und Netzwechsel echter Smartphones bildet das Labor nicht nach. Ein Lasttest mit erzwungenen Abbrüchen folgt in Meilenstein 8.
2. Browser begrenzen die Zahl gleichzeitiger Verbindungen. Bei 60 ist das nach meinem Kenntnisstand kein Problem (nicht geprüft).
3. Die Zeiten der Zustellung sind Schätzungen, weil die Uhren der beteiligten Instanzen leicht voneinander abweichen können.
4. Testspiele leben höchstens 6 Stunden und werden mit "Beenden und aufräumen" sofort gelöscht.

## Lokal entwickeln

`next dev` kennt keinen WebSocket Upgrade, den gibt es nur in der Vercel Laufzeit. Für die Entwicklung startet ein eigener Prozess denselben Hub. Gebraucht wird nur ein lokaler Redis Server.

1. Redis starten, zum Beispiel mit `redis-server`.
2. In `.env.local` eintragen: `REDIS_URL=redis://localhost:6379`, `SESSION_SECRET` (mindestens 32 Zeichen), `ADMIN_PASSWORD` und `NEXT_PUBLIC_WS_URL=ws://localhost:3001/api/ws`.
3. In einem Terminal `npm run dev:ws` (WebSocket Server auf Port 3001) und in einem zweiten `npm run dev`.

Ohne die REST Zugangsdaten von Upstash arbeitet der Spielspeicher automatisch über `REDIS_URL`. `NEXT_PUBLIC_WS_URL` wird beim Start fest eingebaut, nach einer Änderung also beide Prozesse neu starten. Der lokale Server prüft den Origin nicht, weil die App auf einem anderen Port läuft. Er ist nur für die Entwicklung gedacht.

## Tests der Echtzeit Schicht

Die Tests der Echtzeit Schicht laufen gegen einen echten Redis Server und echte WebSockets, ohne Vercel. Sie werden nur ausgeführt, wenn `TEST_REDIS_URL` gesetzt ist:

```bash
TEST_REDIS_URL=redis://localhost:6379 npm test
```

Sie decken unter anderem ab: gleichzeitige Beitritte, Verteilung über zwei simulierte Instanzen, den Wettlauf zwischen Lesen und Abonnieren, verlorene Nachrichten und die Heilung nach einer Wiederverbindung des Subscribers, den kontrollierten Neuaufbau unter laufenden Änderungen, halb tote Verbindungen und den Uhrenabgleich. Verwenden Sie niemals die Redis Datenbank von Produktion oder Preview, die Tests legen eigene Schlüssel an und räumen sie wieder auf.
