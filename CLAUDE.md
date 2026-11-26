# DOC Bern Quiz: Projektleitfaden

Dieses Dokument hält Architekturentscheide und Konventionen fest. Es wird mit jedem Meilenstein nachgeführt. Wer am Projekt arbeitet, liest es zuerst.

## Ziel

Echtzeit Quiz für den Ducati Official Club Bern, ähnlich Kahoot. Teilnehmende scannen mit dem Smartphone einen QR Code, landen im Warteraum und antworten live. Die Fragen erscheinen auf einem Beamer. Tiefe Latenz ist die zentrale Anforderung.

Rahmen: rund 60 gleichzeitige Teilnehmende, ein einziger Admin, Oberfläche auf Deutsch in Schweizer Schreibweise, Smartphone zuerst für Spieler, Adminportal für den PC, keine Bilder in Fragen.

## Stack

1. Next.js 16.4.6 (App Router) mit TypeScript, strikt (inklusive `noUncheckedIndexedAccess`). Hosting auf Vercel Hobby, Fluid Compute, Region `fra1` (gesetzt in `vercel.json`).
2. Neon Postgres (Free) über den Vercel Marketplace, Zugriff mit Drizzle ORM 0.45 und `pg` (Pool). Migrationen mit Drizzle Kit 0.31.
3. Upstash Redis (Free) über den Vercel Marketplace. `@upstash/redis` über REST für Befehle, `ioredis` über TCP nur für Subscriber.
4. WebSocket über `upgradeWebSocket` aus `@vercel/functions` (ab Version 3.10.0, der frühere Name `experimental_upgradeWebSocket` ist veraltet). Braucht das Paket `ws`.
5. Tailwind CSS 4, Zod 4 für Validierung, Vitest 5 für Tests. Node 22.
6. ESLint bleibt bei Version 9. Version 10 läuft zwar, liegt aber ausserhalb der erlaubten Peer Bereiche der Plugins von `eslint-config-next` 16.4.6 (react, import, jsx a11y). Bei der Installation meldet npm, ESLint 9.39.5 werde nicht mehr unterstützt. Das ist bekannt und nur ein Hinweis, die Prüfung läuft. Bei einem Update von `eslint-config-next` neu prüfen.

## Architekturentscheide

1. **Neon ist das Langzeitgedächtnis, Redis das Kurzzeitgedächtnis.** Beim Spielstart wird das Quiz einmal aus Neon als Snapshot nach Redis geladen. Während des Spiels wird Neon weder gelesen noch geschrieben. Die Resultate gehen gesammelt nach Neon, sobald die letzte Frage endet.
2. **Der Server ist die einzige Wahrheit.** Zeitmessung, Annahme von Antworten und Punkteberechnung geschehen serverseitig mit Serverzeitstempeln. Pro Frage gibt es Start und Ablaufzeit. Antworten nach Ablauf lehnt der Server ab. Pro Spieler und Frage wird nur eine Antwort angenommen (`HSETNX`).
3. **Keine Server Timer.** Funktionen haben keine dauerhaften Hintergrundprozesse. Das Ende einer Frage löst aus: der Server selbst, sobald alle geantwortet haben, sonst der Browser des Admins bei Zeitablauf. Der Server prüft den Ablauf. Ist der Admin Browser nicht verbunden, wartet das Spiel. Manuell geht jederzeit.
4. **Eine Verbindung pro Gerät, ein Subscriber pro Instanz.** Jede WebSocket Verbindung ist an eine Funktionsinstanz gebunden. Pro Instanz und Spiel gibt es genau einen Redis Subscriber, der Nachrichten im Speicher an die lokalen Sockets verteilt.
5. **Subscribe über ioredis (TCP), nicht über das Upstash SDK.** Im Quellcode des SDK (Version 1.41.1) endet der SSE Stream bei einem Abbruch still, ohne Wiederverbindung und ohne Fehlerereignis, und Lesefehler gehen nur an `console.error`. Eine tote Subscription würde unbemerkt Nachrichten verlieren. ioredis ist der in der Upstash Dokumentation gezeigte Client für SUBSCRIBE und verbindet sich selbständig neu. Der Entscheid wird durch die Messungen in `docs/SPIKE.md` bestätigt oder angepasst.
6. **Nachrichten tragen eine Zustandsversion.** Eine Lücke bei einer Nachricht (zum Beispiel während einer Wiederverbindung des Subscribers) führt zu einem Neuabgleich des vollständigen Zustands aus Redis. Ein verlorenes Publish bleibt so folgenlos.
7. **Befehle tragen die erwartete Zustandsversion.** Ein doppelter Klick oder gleichzeitige Steuerung aus Portal und Beamer überspringt keine Phase.
8. **Geheimhaltung.** Richtige Antworten gelangen erst bei der Auflösung an die Clients.
9. **Mehrere Umgebungen teilen sich eine Redis Datenbank** (Upstash Free erlaubt nur eine). Alle Schlüssel und Kanäle tragen ein Präfix: `prod`, `preview`, `dev` oder `local`. Es wird in `src/lib/env.ts` bestimmt und in `src/lib/redis/keys.ts` angewendet.
10. **Neon Treiber:** `pg` mit Pool und `attachDatabasePool`, wie von Neon für Vercel Fluid Compute empfohlen. Interaktive Transaktionen sind nötig (Fragen sortieren, Optionen ersetzen). Der HTTP Treiber kann das nicht.
11. **Migrationen** laufen mit der direkten Adresse `DATABASE_URL_UNPOOLED`, einmal pro Änderung und nie im Build. Normalerweise mit `npm run db:migrate`. Wo das nicht möglich ist (Geschäftspolicy), wendet der angemeldete Admin sie auf der Seite `/admin/system` an (`src/lib/db/migrations.ts`). Dieser Weg führt nur die Dateien aus `drizzle/` aus, nutzt einen Advisory Lock gegen doppelte Läufe und braucht keine Zugangsdaten ausserhalb von Vercel.

## Verbindungsstrategie

1. Hauptstrategie: Nach jeder Auflösung baut jeder Client zuerst eine neue Verbindung auf, erhält den vollen Zustand und schliesst dann erst die alte. Das geschieht mit zufälliger Verzögerung. So wird die Grenze von 300 Sekunden (Hobby, Standard und Maximum) während einer Frage nie erreicht.
2. Zusätzlich gilt eine Altersgrenze von 240 Sekunden, auch im Warteraum. Der Server kündigt bei etwa 285 Sekunden eine Wiederverbindung an.
3. Absicherung: Wiederverbindung mit Backoff bei jedem unerwarteten Abbruch (Bildschirmsperre, Netzwechsel, Neuladen). Der Close Code der Plattform ist nicht dokumentiert, jeder Abbruch wird gleich behandelt. Wo der Browser es unterstützt, hält der Client den Bildschirm während des Spiels wach.
4. Beim Beitritt erhält jedes Smartphone einen Spielertoken (im Browser gespeichert, in der Datenbank nur als Hash). Bei jeder Verbindung sendet der Client den Token und erhält sofort den vollständigen Zustand. Der Zustandsabgleich beim Verbinden ist massgebend. So geht auch bei einem Neuaufbau zum Start der nächsten Frage nichts verloren.
5. Ein Zeitlimit pro Frage von höchstens 120 Sekunden, damit eine Frage nie über die 300 Sekunden Grenze läuft.

## Spielablauf (Stand der Freigabe)

1. **Warteraum:** QR Code, Spielcode und die Teilnehmenden als schwebende Bubbles mit Icon und Name (keine Liste). Ein Tipp auf dem Smartphone lässt die eigene Bubble hüpfen (höchstens einmal pro 2 Sekunden, nicht gespeichert).
2. **Quizstart:** Der QR Code verschwindet. Der Server lehnt neue Beitritte ab. Wer schon dabei ist, kann sich mit dem Token neu verbinden.
3. **Frage:** Countdown auf Beamer und Smartphones. Das Zeitlimit stellt der Admin pro Frage ein (Vorgabe im Formular: 20 Sekunden).
4. **Ende der Frage:** automatisch, wenn alle geantwortet haben oder die Zeit abgelaufen ist.
5. **Auflösungsbildschirm:** oben ein Drittel mit der richtigen Antwort und der Verteilung (bei Schätzfragen richtiger Wert und Streuung), unten zwei Drittel mit der Rangliste (Top 5) samt Punkten dieser Frage und Rangveränderung. Smartphones zeigen gleichzeitig richtig oder falsch, Punkte und Rang. Bei Schätzfragen zeigen sie Abweichung, Genauigkeit in Prozent und Punkte, ohne Label richtig oder falsch. **Umfragen** vergeben keine Punkte, ihr Auflösungsbildschirm zeigt nur die Verteilung im ganzen Bildschirm (Annahme, nicht ausdrücklich bestätigt).
6. **Nächste Frage:** der Admin schaltet sie per Klick auf.
7. **Ende des Quiz:** Sobald die letzte Frage endet, wechselt der Beamer direkt auf den noch verdeckten Siegerbildschirm. Die Auflösung der letzten Frage erscheint nicht auf dem Beamer. Der Admin enthüllt Platz 3, dann 2, dann 1 per Klick, bei Platz 1 mit Konfetti. Der Enthüllungsstand liegt im Spielzustand. Smartphones zeigen für die letzte Frage richtig oder falsch und Punkte, den Rang aber erst nach der Enthüllung von Platz 1. Bis dahin steht dort "Schau auf den Bildschirm". Die Resultate gehen beim Ende der letzten Frage nach Neon.
8. **Steuerung:** im Adminportal und zusätzlich in der Beamer Ansicht. Wer dort als Admin angemeldet ist, sieht eine ausblendbare Steuerleiste, dazu Tasten (Leertaste und Pfeil rechts für Weiter). Ohne Admin Anmeldung ist die Beamer Ansicht nur lesend und öffentlich über den Spielcode erreichbar.
9. Es läuft höchstens eine Durchführung gleichzeitig. Der Spielcode ist sechsstellig.

## Punkteberechnung (Modul in Meilenstein 6, mit Unit Tests)

1. **Multiple Choice:** Punkte = runden((1 minus (Antwortzeit durch Zeitlimit) durch 2) mal maximale Punkte). Unter 0.5 Sekunden volle Punktzahl, danach die Formel mit der echten Antwortzeit (ein kleiner Sprung bei 0.5 Sekunden, bewusst wörtlich umgesetzt). Falsch oder keine Antwort: 0 Punkte. Mehrere richtige Optionen sind erlaubt, gewählt wird genau eine, jede als richtig markierte Option zählt.
2. **Schätzfrage:** Genauigkeit = max(0, 1 minus |Schätzung minus richtiger Wert| durch Toleranz). Punkte = runden(Genauigkeit mal (1 minus (Antwortzeit durch Zeitlimit) durch 2) mal maximale Punkte). Die Toleranz ist absolut, in der Einheit der Frage, und grösser als 0.
3. **Umfrage:** keine Punkte, nur Verteilung.
4. **Rangliste:** Gleiche Punkte ergeben gleichen Rang, die Reihenfolge bestimmt die kleinere Summe der Antwortzeiten.

## Datenmodell (Neon)

Bezeichner sind Englisch, die Oberfläche ist Deutsch. Tabellen: `quizzes`, `questions`, `answer_options`, `game_sessions`, `players`, `responses`. Definition in `src/lib/db/schema.ts`, Migrationen in `drizzle/`.

Abweichungen und Ergänzungen gegenüber dem Vorschlag der Spezifikation:

1. `players` hat zusätzlich `avatar` (Icon), `total_points`, `total_answer_time_ms` und `final_rank`. Sie werden beim Spielende gesetzt, damit die Resultatansicht ohne Neuberechnung auskommt.
2. Der Spielcode ist nur unter aktiven Durchführungen (Status lobby oder running) eindeutig, danach wiederverwendbar.
3. Grenzen als CHECK Bedingungen: Zeitlimit 5 bis 120 Sekunden, maximale Punkte 0 bis 10000, Spielname 1 bis 20 Zeichen, Titel höchstens 120 Zeichen, Fragetext höchstens 300 Zeichen, Antworttext höchstens 120 Zeichen. Eine Umfrage hat 0 Punkte, eine Schätzfrage braucht Wert und Toleranz grösser 0.
4. Ein Quiz mit Durchführungen kann nicht gelöscht werden (RESTRICT). Die Anwendung sperrt zudem das Bearbeiten, sobald eine Durchführung existiert. Stattdessen gibt es "Quiz duplizieren".
5. Der Spielname ist pro Durchführung eindeutig, ohne Beachtung der Gross und Kleinschreibung.
6. Nicht in der Datenbank erzwungen, sondern mit Zod in der Anwendung: 2 bis 4 Optionen, mindestens eine richtig bei Multiple Choice, keine richtige bei Umfragen, höchstens eine aktive Durchführung.

## Redis Schlüssel und Kanäle

1. Alle Namen entstehen über `redisKey(...)` und `redisChannel(...)` in `src/lib/redis/keys.ts`. Niemals Schlüssel von Hand zusammensetzen.
2. Teile sind auf `A bis Z`, `a bis z`, `0 bis 9`, Punkt, Unterstrich und Bindestrich beschränkt. Keine Platzhalter, Leerzeichen, Doppelpunkte oder Kommas. Kommas sind verboten, weil das SDK Nachrichten kommagetrennt liest.
3. Werte werden als JSON Text gespeichert und mit Zod gelesen. Der REST Client läuft mit `automaticDeserialization: false`, damit zum Beispiel "123" nicht zur Zahl 123 wird.
4. Alle Schlüssel haben ein Ablaufdatum.
5. Redis Befehle sparen: Upstash Free erlaubt 500'000 pro Monat. Der Zustand eines Spiels liegt so, dass ein einzelner Lesebefehl den vollen Zustand liefert. Rangliste und Punkte werden beim Auflösen im Code berechnet und als ein Wert gespeichert. Eine grobe, ungemessene Schätzung liegt bei 8'000 bis 10'000 Befehlen pro Spiel mit 60 Personen und 20 Fragen. Wie Publish und Subscribe Nachrichten gezählt werden, ist nicht dokumentiert und wird gemessen.

## Sicherheit und Datenschutz

1. Gespeichert werden nur Spielname und Icon, keine Personendaten.
2. Eingaben werden serverseitig mit Zod geprüft.
3. Rate Limiting: Beitritt pro IP über Redis, Antworten über die Regel "eine Antwort pro Frage" und eine Begrenzung pro Verbindung im Speicher der Instanz.
4. Nur der Admin darf Steuerbefehle senden, serverseitig bei jeder Nachricht geprüft.
5. Adminlogin: Passwort aus `ADMIN_PASSWORD` mit zeitkonstantem Vergleich, Session Cookie (HttpOnly, Secure, SameSite Strict) mit HMAC und Ablaufdatum. `SESSION_SECRET` ist Pflicht ohne Ersatzwert. Den Auth Code der Club App übernehmen wir bewusst nicht.
6. Der Systemcheck `/api/health` gibt in der Produktion ohne Token nur `ok` zurück und berührt weder Neon noch Redis.
7. Test Endpunkte (`/api/spike/...`) und die Seite `/design` sind in der Produktion gesperrt.
8. Zugangsdaten stehen nie in Fehlermeldungen oder Logs. Umgebungsvariablen nur über `src/lib/env.ts` lesen.

## Konventionen

1. **Sprache:** Oberfläche, Dokumentation und Kommentare auf Deutsch in Schweizer Schreibweise, immer "ss", nie das scharfe S. Bezeichner im Code sind Englisch.
2. **Kommentare:** Echtzeitlogik gut kommentieren, vor allem Reihenfolgen, Zeitannahmen und Gründe. Kommentare erklären das Warum.
3. **TypeScript:** strikt, keine `any`. Eingaben von aussen (WebSocket Nachrichten, Formulare, Redis Werte) werden mit Zod geprüft, bevor sie verwendet werden.
4. **Tests:** Reine Logik (Punkte, Zustandsautomat, Schlüssel, Konfiguration) hat Unit Tests mit Vitest neben der Datei (`*.test.ts`). Spiellogik ist vom Transport getrennt, damit sie ohne WebSocket testbar ist.
5. **Design:** Helles Corporate Design des Ducati Official Club Bern, abgeleitet von der Club App. Nur heller Modus. Farben und Klassen in `src/app/globals.css`. Ducati Rot `#e30613`. Antwortfarben Rot, Blau, Orange und Grün jeweils mit Symbol (Dreieck, Raute, Kreis, Quadrat). Auf Orange und Grün steht dunkle Schrift (Kontrast), auf Rot und Blau weisse Schrift.
6. **Drei Layouts:** Spieler (`src/app/(player)`, Smartphone, schmale Spalte, Knöpfe mindestens 48 Pixel, Antwortbuttons mindestens 64 Pixel, Eingaben mit 16 Pixel Schrift), Admin (`src/app/(admin)`, PC, Seitenleiste), Beamer (`src/app/(screen)`, Vollbild, Schrift skaliert mit `vmin`).
7. **Bubbles:** Eigene einfache Physik auf Canvas ohne zusätzliche Bibliothek, Glasoptik ohne teuren Weichzeichner. Icons zunächst als Emoji.
8. **Git:** Entwicklung auf dem Branch `claude/realtime-quiz-platform-hjdvqz`. Pull Requests nur auf ausdrückliche Anweisung.

## Verzeichnisstruktur

* `src/app/(player)`, `src/app/(admin)`, `src/app/(screen)`: die drei Ansichten.
* `src/app/api/health`: Systemcheck.
* `src/app/api/spike` und `src/lib/spike`: Messungen aus Meilenstein 1, werden entfernt.
* `src/app/design`: Gestaltungsvorschau (nicht in der Produktion).
* `src/lib/env.ts`: Umgebungsvariablen. `src/lib/db`: Schema und Client. `src/lib/redis`: Schlüssel, REST Client, TCP Client.
* `src/lib/design.ts`: Antwortfarben und Symbole. `src/components`: gemeinsame Bausteine.
* `drizzle/`: Migrationen. `docs/`: Anleitungen. `scripts/`: Messskripte.

## Befehle

```bash
npm run dev          # lokale Entwicklung
npm run lint         # ESLint
npm run typecheck    # TypeScript
npm test             # Unit Tests
npm run build        # Produktionsbuild
npm run db:generate  # neue Migration aus Schemaänderung
npm run db:migrate   # Migration anwenden (DATABASE_URL_UNPOOLED)
npm run spike:ws     # Messungen, siehe docs/SPIKE.md
```

## Meilensteine

1. Projektgerüst, Region, Verbindungen, Schema, Dokumentation, Spike: **umgesetzt, wartet auf Bestätigung und auf die Messungen auf Vercel**.
2. Adminlogin und CMS.
3. WebSocket Endpunkt, Publish/Subscribe, Spielertoken, Statusabgleich, Verbindungsstrategie.
4. Warteraum mit Bubbles, QR Code, Beitritt, Beamer Ansicht.
5. Spielablauf mit oberem Drittel der Auflösung.
6. Punkteberechnung, Rangliste, Podest, Siegerbildschirm.
7. Spielende, Resultate nach Neon, Resultatansicht.
8. Lasttest mit 60 simulierten Clients und Bericht.

## Nicht bestätigt oder offen

Diese Punkte sind in den offiziellen Quellen nicht festgehalten oder noch nicht gemessen:

1. Ob `fra1` im Hobby Plan wählbar ist, und ob Neon und Upstash im kostenlosen Plan Frankfurt anbieten.
2. Die Namen der Variablen der Upstash Marketplace Integration. Die App akzeptiert `UPSTASH_REDIS_REST_*`, `KV_REST_API_*`, `REDIS_URL` und `KV_URL`.
3. Wie Upstash Publish und Subscribe Nachrichten zählt.
4. Ob eine ruhende WebSocket Verbindung Active CPU oder Provisioned Memory verbraucht, und welchen Close Code die Plattform beim Erreichen von 300 Sekunden sendet.
5. Ob `upgradeWebSocket` lokal mit `vercel dev` läuft. Mit `next dev` oder `next start` gibt es keinen WebSocket Upgrade.
6. Ob die 0.5 Sekunden Regel auch für Schätzfragen gilt. Die Spezifikation nennt sie nur bei Multiple Choice. Offen für Meilenstein 6, Vorschlag: gleicher Zeitfaktor wie bei Multiple Choice.
7. Die Nutzungsbedingungen des Hobby Plans für einen Club.

## Quellen der Recherche (Stand 26. November 2026)

Offizielle Seiten von Vercel (WebSockets, Limits, Duration, Region, Fluid Compute), Upstash (Subscribe, Billing, REST API), Neon (Plans, Scale to Zero, Verbindungswahl, Vercel Integration), Drizzle (Kit, Neon), sowie der Quellcode der veröffentlichten Pakete `@vercel/functions` 3.11.4 und `@upstash/redis` 1.41.1.
