# Lasttest (Meilenstein 8)

Das Skript `scripts/loadtest.ts` spielt ein ganzes Quiz mit vielen simulierten Smartphones, einem Beamer und einem Admin durch. Die simulierten Geräte benutzen dieselbe Client Bibliothek wie die echten Smartphones (Wiederverbindung, kontrollierter Neuaufbau nach jeder Auflösung, Zeithinweise). So wird der echte Weg geprüft und nicht ein Ersatz.

## Was das Skript macht

1. Es legt ein Testspiel an (lokal) oder verwendet eine Durchführung, die Sie vorbereitet haben (gegen Vercel).
2. Bis zu 100 Geräte treten bei (60 ist der Standard) und verbinden sich, verteilt auf eine oder mehrere Hub Instanzen.
3. Der Admin startet das Quiz und spielt es bis zum Siegerbildschirm durch, inklusive Enthüllung und Ende.
4. Jedes Gerät antwortet zufällig verzögert. Ein einstellbarer Anteil bricht mitten in der Frage die Verbindung ab und verbindet sich neu, ein anderer Anteil antwortet gar nicht (die Frage endet dann durch Zeitablauf).
5. Am Ende prüft es und schreibt einen Bericht (Befehl `--report Datei.md`).

Die Prüfungen am Ende:

1. Jede vom Server quittierte Antwort wurde ausgewertet (Zahl der Antworten pro Frage stimmt).
2. Die Punkte der einzelnen Fragen ergeben für jede Person genau die Punkte der Endrangliste.
3. Die Rangliste enthält alle Geräte.
4. Alle Geräte waren am Ende noch verbunden und es gab keine endgültigen Fehler.

## Lokal ausführen

Voraussetzungen: ein lokaler Redis Server, eine `.env.local` mit `REDIS_URL` und `SESSION_SECRET` (siehe `docs/SETUP.md`) und mindestens ein laufender Hub. Mit zwei Hubs sieht man die Verteilung auf mehrere Instanzen.

```bash
redis-server --port 6379 --save "" --appendonly no --daemonize yes
```

```bash
npm run dev:ws
```

```bash
DEV_WS_PORT=3002 npm run dev:ws
```

```bash
npm run loadtest -- --players 60 --ws ws://localhost:3001/api/ws,ws://localhost:3002/api/ws --report lasttest-bericht.md
```

Optionen:

1. `--players` Zahl der Geräte (Standard 60, höchstens 100).
2. `--ws` Adressen der Hubs, durch Kommas getrennt. Die Geräte verteilen sich der Reihe nach.
3. `--questions` und `--time-limit` Zahl der Testfragen (Standard 5) und Sekunden pro Frage (Standard 8). Nur lokal.
4. `--drop` Anteil der Geräte, die pro Frage die Verbindung verlieren (Standard 0.1).
5. `--no-answer` Anteil der Geräte, die nicht antworten (Standard 0.03).
6. `--seed` Zahl für einen wiederholbaren Ablauf.
7. `--report` schreibt den Bericht zusätzlich in eine Datei.

Das Testspiel erhält einen Code im Bereich 900000 bis 999999. Echte Spiele sind davon nicht betroffen. Es wird am Ende wieder aus Redis entfernt.

## Gegen Vercel ausführen

Das ist die Messung, die wirklich zählt, weil sie Netz, Funktionsinstanzen und Upstash einschliesst. Sie läuft in Ihrem Beisein am besten mit einem Preview Deployment und einem Testquiz.

1. Im Adminportal ein Testquiz mit ein paar Fragen anlegen, als Bereit markieren und unter "Durchführung" den Warteraum öffnen. Der Spielcode steht auf der Seite.
2. Das Admin Cookie kopieren: Im Browser die Entwicklerwerkzeuge öffnen, "Application" oder "Speicher", Cookies der App, den Wert des Cookies `doc_quiz_admin` kopieren. Es ist 12 Stunden gültig und gibt Admin Rechte. Geben Sie es niemandem weiter.
3. Das Skript auf Ihrem Rechner starten:

```bash
npm run loadtest -- --code 123456 --api https://IHRE-APP.vercel.app --ws wss://IHRE-APP.vercel.app/api/ws --admin-cookie "WERT" --players 60 --report lasttest-vercel.md
```

Achtung: Es wird die echte Durchführung gespielt. Die Resultate landen in Neon, und der Verbrauch zählt gegen die Kontingente von Vercel und Upstash. Das Testquiz danach nicht mehr verwenden oder abschliessen und archivieren.

Beobachten Sie während des Laufs zusätzlich im Vercel Dashboard die Logs (Zeilen mit `ws_open`, `ws_close`, `question_resolved`) und im Upstash Dashboard die Zahl der Befehle. Der Bericht des Skripts nennt die Verteilung der Geräte auf Instanzen.

## Ergebnisse vom 26. November 2026 (lokal)

Umgebung: ein Rechner, lokaler Redis, zwei Hub Instanzen, 60 Geräte. Die Latenzen sind deshalb sehr klein und sagen nichts über Vercel aus. Sie zeigen, dass die Logik unter Last stimmt.

Lauf 1, 5 Fragen zu 8 Sekunden, 10 Prozent Abbrüche pro Frage, 3 Prozent ohne Antwort (Seed 21):

1. Beitritt: Median 1 ms. Verbindungsaufbau bis zum ersten Zustand: Median 3 ms, p95 6 ms.
2. Befehl des Admins bis Anzeige auf dem Gerät: Median 6 ms, p95 13 ms, grösster Wert 19 ms (540 Werte).
3. Antwort bis Quittung: Median 1 ms, p95 1 ms.
4. Wiederverbindung nach Abbruch: Median 357 ms, p95 474 ms (29 Abbrüche). Der Wert besteht fast nur aus der Wartezeit vor dem Neuversuch (500 Millisekunden Basis mit Zufall).
5. Kontrollierter Neuaufbau nach jeder Auflösung: 286 Mal, Median 2 ms, ohne Unterbruch.
6. 299 Antworten gesendet, 295 angenommen. Die 4 abgelehnten wurden wiederholt (Verbindung gerade weg), danach alle angenommen.
7. Keine endgültigen Fehler. Alle Prüfungen bestanden. Die Fragen mit Geräten ohne Antwort endeten durch Zeitablauf nach 8.1 Sekunden, ohne dass jemand eingreifen musste (die Beamer und Admin Clients lösen den Zeithinweis aus).

Lauf 2, härter: 6 Fragen zu 10 Sekunden, 50 Prozent der Geräte verlieren pro Frage die Verbindung, alle antworten (Seed 5):

1. 176 absichtliche Abbrüche, alle Geräte verbanden sich wieder. Wiederverbindung Median 366 ms, p95 485 ms.
2. 401 Antworten gesendet, 360 angenommen. 41 wurden wegen der gerade unterbrochenen Verbindung abgelehnt und danach erfolgreich wiederholt.
3. Jede Frage zählte genau 60 von 60 Antworten und endete nach etwa 5.6 Sekunden von selbst, sobald die letzte Antwort da war.
4. Alle Prüfungen bestanden, keine endgültigen Fehler.

## Redis Befehle

Das Skript liest die Zahl der Befehle aus dem lokalen Redis (`INFO`). In Lauf 1 waren es 3'269 Befehle für 5 Fragen mit 60 Geräten, also rund 650 pro Frage. Wichtig für die Einordnung:

1. Ein lokaler Redis zählt auch die Befehle innerhalb der Lua Skripte einzeln (HEXISTS, HSETNX, HLEN, EXPIRE und HSET pro Antwort). Wie Upstash das zählt, ist nicht dokumentiert. Zählt es nur den Aufruf des Skripts, liegt der Wert eher bei 380 bis 400 pro Frage.
2. Den grössten Anteil haben die Lesebefehle (HGET, 1'001 in Lauf 1): Jedes Gerät liest bei jedem Neuaufbau der Verbindung den Zustand und prüft sein Token. Der Neuaufbau nach jeder Auflösung ist die Verbindungsstrategie aus der Spezifikation.
3. Pro Antwort fallen ein Skriptaufruf und eine Veröffentlichung an (Fortschrittsanzeige auf dem Beamer).

Grobe Rechnung für ein Quiz mit 20 Fragen und 60 Personen: etwa 7'600 bis 13'000 Befehle je nach Zählweise, dazu der Beitritt. Das Free Kontingent von Upstash (500'000 Befehle pro Monat) reicht dann für etwa 35 bis 65 solche Quizzes im Monat. Das ist für einen Club mehr als genug, sollte aber auf Vercel mit dem Upstash Dashboard nachgemessen werden.

## Offene Punkte

1. Messung auf Vercel (Latenz über das echte Netz, Zahl der Instanzen bei 60 Verbindungen, Verhalten bei 300 Sekunden, Zählweise von Upstash). Dafür gibt es das Verbindungslabor und den Lasttest gegen die laufende App.
2. Ob die kleinen Latenzen auch bei 60 echten Smartphones im Clublokal erreicht werden, hängt vor allem vom WLAN ab. Ein Probelauf mit ein paar echten Geräten vor dem Anlass ist sinnvoll.
