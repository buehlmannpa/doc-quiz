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
3. **Keine Server Timer.** Funktionen haben keine dauerhaften Hintergrundprozesse. Das Ende einer Frage löst aus: der Server selbst, sobald alle geantwortet haben, sonst ein Browser bei Zeitablauf (zuerst Beamer und Admin Browser, als Absicherung nach 1.5 Sekunden auch die Smartphones). Der Server prüft den Ablauf selbst und handelt nur, wenn die Zeit wirklich abgelaufen ist. Die Spezifikation verlangte, dass das Spiel wartet, wenn der Admin Browser nicht verbunden ist. Das ist bewusst abgeschwächt (Annahme 10 in `docs/ANNAHMEN.md`, zu bestätigen). Manuell geht jederzeit.
4. **Eine Verbindung pro Gerät, ein Subscriber pro Instanz.** Jede WebSocket Verbindung ist an eine Funktionsinstanz gebunden. Pro Instanz und Spiel gibt es genau einen Redis Subscriber, der Nachrichten im Speicher an die lokalen Sockets verteilt.
5. **Subscribe über ioredis (TCP), nicht über das Upstash SDK.** Im Quellcode des SDK (Version 1.41.1) endet der SSE Stream bei einem Abbruch still, ohne Wiederverbindung und ohne Fehlerereignis, und Lesefehler gehen nur an `console.error`. Eine tote Subscription würde unbemerkt Nachrichten verlieren. ioredis ist der in der Upstash Dokumentation gezeigte Client für SUBSCRIBE und verbindet sich selbständig neu. Der Entscheid ist in der Echtzeit Schicht umgesetzt und mit einem echten Redis getestet, einschliesslich eines erzwungenen Abbruchs der Subscriber Verbindung. Auf Vercel bestätigt ihn das Verbindungslabor (`docs/VERBINDUNGSTEST.md`).
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

## Adminportal und Quizverwaltung (Meilenstein 2)

1. **Seiten:** `/admin/login`, `/admin` (Übersicht), `/admin/quizzes` (Liste und Neues Quiz), `/admin/quizzes/[quizId]` (Titel, Status, Fragen), `.../questions/new` und `.../questions/[questionId]`, `/admin/system` (Verbindungen, Region, Migrationen). Alle ausser dem Login sind geschützt.
2. **Schichten:** Zod Schemas in `src/lib/quiz/schema.ts` (gleiche Regeln im Formular und auf dem Server), reine Regeln in `src/lib/quiz/rules.ts`, Datenbankzugriff in `src/lib/quiz/repository.ts`, Server Actions in `quizzes/actions.ts`. Actions prüfen Anmeldung, Kennungen und Eingaben und geben lesbare Meldungen zurück.
3. **Transaktionen:** Jede Änderung sperrt zuerst die Zeile des Quiz (`FOR UPDATE`). Gleichzeitige Änderungen laufen nacheinander, die Positionen der Fragen bleiben lückenlos. Der Start einer Durchführung (Meilenstein 4) muss dieselbe Zeile sperren, damit zwischen der Prüfung "keine Durchführung" und der Änderung keine entstehen kann.
4. **Status:** Entwurf, Bereit, Abgeschlossen. Bereit braucht mindestens eine Frage, und alle gespeicherten Fragen werden dabei erneut geprüft. Zurück in den Entwurf nur ohne Durchführung. Abgeschlossen ist endgültig (archiviert, nicht bearbeitbar, nicht spielbar) und lässt sich nur duplizieren. Spielbar ist nur der Status Bereit (`isPlayable`).
5. **Sperre:** Ein Quiz mit Durchführung oder im Status Abgeschlossen ist nicht mehr bearbeitbar. Duplizieren bleibt möglich und erzeugt einen neuen Entwurf mit "(Kopie)" im Titel. Löschen ist nur ohne Durchführung möglich.
6. **Fragen:** Typ Multiple Choice, Schätzfrage oder Umfrage. Höchstens 50 Fragen pro Quiz, Zeitlimit 5 bis 120 Sekunden, maximale Punkte 1 bis 10000 (Umfrage 0). Leere Antwortzeilen im Formular werden ignoriert. Beim Speichern einer Frage werden die Antworten vollständig ersetzt, beim Typwechsel werden Felder anderer Typen auf null gesetzt.
7. **Zahlen:** Eingaben dürfen mit Punkt oder Komma geschrieben werden, auch mit Apostroph als Tausendertrenner (`src/lib/quiz/number.ts`). Anzeige in Schweizer Schreibweise (zum Beispiel 1'000 und 216.5).
8. **Tests:** Reine Logik hat Unit Tests. Das Repository hat 16 Integrationstests gegen eine echte Postgres Datenbank, die nur mit `TEST_DATABASE_URL` laufen (Befehl unter Befehle). Nie die Datenbank von Produktion oder Preview verwenden.
9. **Migrationen aus dem Portal:** siehe Architekturentscheid 11.

## Echtzeit Schicht (Meilenstein 3)

1. **Dateien in `src/lib/realtime`:** `game-state.ts` (öffentlicher Zustand und Regeln), `protocol.ts` (Nachrichten mit Zod und Close Codes), `tokens.ts`, `redis-port.ts` (Adapter für Upstash REST und ioredis), `store.ts` (Spielspeicher), `subscriber.ts`, `hub.ts`, `origin.ts`, `client.ts`, `instance.ts` (Verdrahtung auf Vercel), `lab-metrics.ts`, `url.ts`.
2. **Zustand:** Ein Hash `game:CODE` mit der Version `v` und dem vollständigen öffentlichen Zustand `s` als JSON. Ein Lesebefehl liefert alles. Ein Hash `game:CODE:tok` verbindet den Hash eines Tokens mit der Spieler Kennung. Ein Spiel verfällt 6 Stunden nach der letzten Änderung.
3. **Änderungen:** Ein Lua Skript schreibt nur, wenn die Version noch die gelesene ist, und veröffentlicht im selben Schritt den vollständigen Zustand. Bei einem Konflikt liefert es den aktuellen Zustand zurück, der Aufrufer rechnet damit neu. Gleichzeitige Beitritte sind getestet (40 gleichzeitig, 100 nacheinander bis zur Obergrenze). Der Ersatzweg bei nicht erlaubtem PUBLISH in Lua ist ebenfalls getestet.
4. **Öffentlicher Zustand:** Er enthält nie Geheimnisse. Richtige Antworten liegen in eigenen Schlüsseln und gelangen erst bei der Auflösung in den Zustand (ab Meilenstein 5). Für die Phasen gilt vorerst Warteraum, läuft, beendet, sie werden in Meilenstein 5 verfeinert.
5. **Spielertoken:** zufällig mit 192 Bit, in Redis nur als HMAC Hash mit `SESSION_SECRET`. Wird das Geheimnis geändert, werden alle Token ungültig. Namen werden bereinigt (Unicode NFC, Leerraum, keine Steuerzeichen), sind 1 bis 20 Zeichen lang und pro Spiel ohne Beachtung der Gross und Kleinschreibung eindeutig. Höchstens 100 Teilnehmende.
6. **Hub:** Pro Instanz ein Subscriber und pro Spiel eine Gruppe lokaler Verbindungen. Beim Verbinden wird der Zustand immer frisch aus Redis gelesen. Reihenfolge: lesen und Berechtigung prüfen, erst dann abonnieren, danach bei Bedarf erneut lesen, damit zwischen Lesen und Abonnieren nichts verloren geht. Unberechtigte Anfragen lösen kein Abonnement aus. Nach der letzten Verbindung bleibt der Kanal noch 15 Sekunden abonniert, damit der kontrollierte Neuaufbau ihn nicht verliert.
7. **Versionen:** Jede Verbindung bekommt nur Versionen, die grösser sind als die zuletzt gesendete. Ein neues Spiel unter demselben Code (andere Erstellungszeit) setzt die Versionen zurück, im Hub und im Client.
8. **Heilung:** Meldet der Subscriber eine Wiederverbindung, liest der Hub den Zustand aller aktiven Spiele neu. Die Tests erzwingen einen Abbruch der Subscriber Verbindung (`CLIENT KILL`) und prüfen, dass Änderungen danach wieder ankommen.
9. **Grenzen pro Verbindung:** 5 Sekunden für hello, 15 Sekunden für die Anmeldung, Nachrichten höchstens 4 KB, 10 Nachrichten pro Sekunde (Stoss von 20), Sendepuffer höchstens 1 MB, höchstens 300 Verbindungen pro Instanz (danach Code 1013, der Client versucht es mit Backoff erneut), Ankündigung des Endes bei 270 Sekunden und eigenes Ende bei 290 Sekunden (Close Code 4012). Close Codes: 4001 ungültig, 4003 keine Berechtigung (endgültig), 4004 Spiel unbekannt (endgültig), 4008 Rate, 4009 hello Frist, 4011 zu langsam, 4012 Alter, 4013 Server.
10. **Endpunkt `/api/ws`:** prüft den Origin (Schutz gegen Cross Site WebSocket Hijacking, Browser ohne passenden Origin werden mit 403 abgewiesen), bestimmt die Admin Berechtigung einmal beim Aufbau aus dem Cookie und übergibt dem Hub. Die Rolle Admin ist nur mit dieser Berechtigung möglich.
11. **Client:** Neuaufbau (erst neue Verbindung, dann die alte schliessen), Backoff mit Zufall (500 Millisekunden bis 10 Sekunden), Altersgrenze 240 Sekunden, Herzschlag alle 15 Sekunden (nach 45 Sekunden Stille gilt die Verbindung als tot), `checkAlive` für das Aufwachen aus dem Standby, Uhrenabgleich mit der Messung der kleinsten Laufzeit, endgültige Fehler stoppen den Client. Die Anbindung an die Seite (Sichtbarkeit, Wake Lock, React Hook) folgt in Meilenstein 4 mit den Ansichten.
12. **Lokale Entwicklung:** `npm run dev:ws` startet einen eigenen WebSocket Server mit demselben Hub, weil `next dev` keinen Upgrade kennt. Ohne REST Zugang von Upstash arbeitet der Spielspeicher über `REDIS_URL`.
13. **Tests:** Tests der Echtzeit Schicht gegen echtes Redis und echte WebSockets (zwei simulierte Instanzen), dazu Mutationsprüfungen der kritischen Logik (erneutes Lesen nach dem Abonnieren, Versionsprüfung, Neuabgleich, wiederverwendeter Code). Der Adapter für das Upstash SDK läuft über einen Ersatzserver (`testing/fake-upstash.ts`), auch mit einem ganzen Quiz der Engine.
14. **Verbindungslabor** (`/admin/lab`): misst im Browser mit bis zu 60 simulierten Teilnehmenden. Siehe `docs/VERBINDUNGSTEST.md`.

## Spielablauf Schicht (Meilensteine 4 bis 8)

Umgesetzt und lokal im Browser geprüft (Playwright mit Beamer, Admin und vier Smartphones), aber noch nicht abgenommen und auf Vercel nicht gemessen. Alle getroffenen Annahmen stehen in `docs/ANNAHMEN.md`.

1. **Dateien in `src/lib/game`:** `scoring.ts` (Punkte und Rangliste, ganze Zahlen), `evaluate.ts` (Auswertung einer Frage, Podest), `snapshot.ts` (Kopie des Quiz für Redis), `engine.ts` (Spielablauf), `sessions.ts` (Durchführungen in Neon), `lifecycle.ts` (Anlegen und Abbrechen), `results.ts` (Kennzahlen pro Frage), `nextAction.ts` (nächste Aktion des Admins), `avatars.ts`, `bubbles.ts` (Physik), `playerStorage.ts` (Token im Browser), `qr.ts`. `src/lib/realtime/controller.ts` ist die Schnittstelle zwischen Hub und Engine, `useGame.ts` der React Hook.
2. **Zustand:** Phasen `lobby`, `question`, `resolved`, `podium`, `finished`. Der öffentliche Zustand trägt Quiz Titel, aktuelle Frage (ohne richtige Antwort), Auflösung, Ergebnisse aller Spieler und das Podest. `finished` ohne Podest heisst abgebrochen.
3. **Redis Schlüssel pro Spiel:** `game:CODE:quiz` (Snapshot mit richtigen Antworten, nur auf dem Server), `game:CODE:ans:Q` (Antworten, plus Feld `#closed` nach der Auflösung), `game:CODE:scores:Q` (Stand und Antwort jedes Spielers nach Frage Q, pro Frage ein Hash, deshalb ist die Auflösung wiederholbar), `game:CODE:final` (Endrangliste, bleibt geheim bis zur Enthüllung).
4. **Antwort annehmen:** Ein Lua Skript prüft die Flagge `#closed`, setzt die Antwort mit HSETNX (eine pro Spieler) und liefert die Zahl der Antworten. Die Antwortzeit ist die Serverzeit der Annahme minus Start der Frage. Antworten bis 300 Millisekunden nach Ablauf zählen mit der vollen Zeit, danach lehnt der Server ab. Haben alle geantwortet, löst der Server sofort auf.
5. **Auflösen:** Ein Lua Skript schliesst die Antworten und liest sie im selben Schritt. Danach wird gerechnet (deterministisch), der Stand der Frage abgelegt und der Zustand mit Versionsvergleich geändert. Zwei gleichzeitige Auslöser (Klick, Zeitablauf, letzte Antwort) rechnen dasselbe, nur einer gewinnt, der andere erkennt es und tut nichts.
6. **Befehle** (`start`, `resolve`, `next`, `reveal`, `finish`, `abort`) tragen die erwartete Version der Ansicht, auf der geklickt wurde. Der Hub nimmt sie nur von der Rolle Admin an, Antworten nur von Spielern, bei jeder Nachricht geprüft. Fehler kommen als Quittung (`ack`) zurück und beenden die Verbindung nicht.
7. **Zeithinweis:** Der Client meldet mit `tick`, dass die Zeit abgelaufen ist, und wiederholt es alle 2 Sekunden, bis die Frage aufgelöst ist. Der Server prüft die Frist selbst. Pro Hub läuft höchstens eine Prüfung gleichzeitig.
8. **Flüchtige Nachrichten:** `progress` (Zahl der Antworten, nur an Beamer und Admin) und `nudge` (Bubble hüpft, nur an Beamer und Admin, höchstens alle 2 Sekunden und Person) gehen über denselben Kanal, werden aber nicht gespeichert. Nach einer Wiederverbindung meldet der Server Spielern die eigene Antwort (`mine`) und Beamer und Admin den Fortschritt.
9. **Geheimhaltung:** Richtige Antworten und die Endrangliste verlassen den Server erst mit der Auflösung beziehungsweise der Enthüllung. Nach der letzten Frage enthalten die Ergebnisse keine Gesamtpunkte und keinen Rang, bis Platz 1 enthüllt ist. Tests prüfen das (Mutationsprüfung der Gesamtpunkte).
10. **Neon:** Anlegen einer Durchführung sperrt die Quizzeile und nimmt ein Advisory Lock (nur eine aktive Durchführung, auch bei gleichzeitigem Start), prüft Status Bereit und bildet den Snapshot. Der Start setzt `running`. Mit dem Ende der letzten Frage werden Spieler und Antworten in einer Transaktion gespeichert und die Durchführung wird `finished` (wiederholbar, mit bis zu drei Versuchen und einem Knopf zum Wiederholen). Im Betrieb läuft das Speichern im Hintergrund, damit ein kalter Start von Neon die Quittung der letzten Antwort nicht aufhält. Die Spieler Kennung aus Redis (UUID) ist auch die Kennung in Neon. Ein Abbruch gibt `cancelled` ohne Resultate.
11. **Beitritt:** `POST /api/join` mit Origin Prüfung, Begrenzung pro IP (120 in 10 Minuten) und Zod. Das Token erhält nur der Browser des Spielers (localStorage). `GET /api/join?code=` sagt, ob das Spiel offen ist.
12. **Oberflächen:** Smartphone `/join`, `/join/[code]`, `/play/[code]`. Beamer `/screen/[code]` (öffentlich, nur lesend, mit Admin Cookie zusätzlich Steuerleiste, Tasten Leertaste und Pfeil rechts, H blendet aus). Admin `/admin/games` (Start), `/admin/games/[code]` (Steuerung), `/admin/results` und `/admin/results/[sessionId]`. Konfetti mit `canvas-confetti` beim Enthüllen von Platz 1, nur ohne Bewegungsreduktion.
13. **Verbindung der Geräte:** Nach jeder Auflösung baut jedes Gerät die Verbindung nach zufälliger Wartezeit (Smartphones bis 3 Sekunden, Beamer und Admin bis 1.5 Sekunden) neu auf. Smartphones prüfen beim Sichtbarwerden der Seite mit einem Ping, ob die Verbindung noch lebt, und halten den Bildschirm wach.
14. **Tests:** Auswertung und Punkte (reine Logik), Engine gegen echtes Redis mit steuerbarer Uhr, Gesamtablauf über WebSockets und zwei Instanzen, Client im Spielablauf, Neon Durchführungen gegen echtes Postgres, Upstash Adapter mit einem ganzen Quiz über das SDK (inklusive Summe der Punkte über mehrere Fragen). Der Ersatzserver (`testing/fake-upstash.ts`) bildet die Antwortform des echten Upstash nach (HGETALL als flaches Array). Browser Durchläufe und Lasttest sollten auch über diesen REST Weg laufen (`npm run dev:fake-upstash`), weil Produktion so arbeitet. Mutationsprüfungen: Schliessflagge, HSETNX, Versionsprüfung der Befehle, Zeitprüfung des Hinweises, Gnadenfrist, Verbergen der Gesamtpunkte.
15. **Lasttest:** `scripts/loadtest.ts`, Bericht und Anleitung in `docs/LASTTEST.md`. Lokal mit 60 Geräten über zwei Instanzen und bis zu 50 Prozent Abbrüchen pro Frage: jede quittierte Antwort wurde gezählt, alle Prüfungen bestanden. Auf Vercel nicht gemessen.

## Redis Schlüssel und Kanäle

1. Alle Namen entstehen über `redisKey(...)` und `redisChannel(...)` in `src/lib/redis/keys.ts`. Niemals Schlüssel von Hand zusammensetzen.
2. Teile sind auf `A bis Z`, `a bis z`, `0 bis 9`, Punkt, Unterstrich und Bindestrich beschränkt. Keine Platzhalter, Leerzeichen, Doppelpunkte oder Kommas. Kommas sind verboten, weil das SDK Nachrichten kommagetrennt liest.
3. Werte werden als JSON Text gespeichert und mit Zod gelesen. Der REST Client läuft mit `automaticDeserialization: false`, damit zum Beispiel "123" nicht zur Zahl 123 wird. Folge: `HGETALL` liefert über das SDK ein flaches Array (Feld, Wert, Feld, Wert), über ioredis ein Objekt. Deshalb liest der Code Hashes nur über `port.hgetall` (Adapter mit `hashReplyToRecord`). Ein früherer Fehler, bei dem sich die Punkte der Fragen nicht summierten, entstand genau hier, weil der Ersatzserver in den Tests ein Objekt lieferte.
4. Alle Schlüssel haben ein Ablaufdatum.
5. Redis Befehle sparen: Upstash Free erlaubt 500'000 pro Monat. Der Zustand eines Spiels liegt so, dass ein einzelner Lesebefehl den vollen Zustand liefert. Rangliste und Punkte werden beim Auflösen im Code berechnet und als ein Wert gespeichert. Eine grobe, ungemessene Schätzung liegt bei 8'000 bis 10'000 Befehlen pro Spiel mit 60 Personen und 20 Fragen. Wie Publish und Subscribe Nachrichten gezählt werden, ist nicht dokumentiert und wird gemessen.

## Sicherheit und Datenschutz

1. Gespeichert werden nur Spielname und Icon, keine Personendaten.
2. Eingaben werden serverseitig mit Zod geprüft.
3. Rate Limiting: Beitritt pro IP über Redis, Antworten über die Regel "eine Antwort pro Frage" und eine Begrenzung pro Verbindung im Speicher der Instanz.
4. Nur der Admin darf Steuerbefehle senden, serverseitig bei jeder Nachricht geprüft.
5. Adminlogin (umgesetzt): Passwort aus `ADMIN_PASSWORD`, verglichen ohne Zeitunterschiede (`src/lib/auth/password.ts`). Session Cookie `doc_quiz_admin` mit HMAC SHA 256 und Ablauf nach 12 Stunden (`src/lib/auth/token.ts`), HttpOnly, Secure auf Vercel, SameSite Strict. `SESSION_SECRET` ist Pflicht und hat keinen Ersatzwert. Den Auth Code der Club App übernehmen wir bewusst nicht.
5a. Rate Limit des Logins: höchstens 8 Versuche pro IP und 40 insgesamt in 15 Minuten, gezählt in Redis (IP nur als Hash), mit Ersatz im Speicher der Instanz, falls Redis nicht erreichbar ist. Nach einem Fehlversuch antwortet der Server verzögert.
5b. Zugriffsschutz in drei Schichten: `src/proxy.ts` leitet ohne gültige Session um, `requireAdmin()` steht am Anfang jeder Seite und jeder Server Action, und das Repository prüft die Regeln erneut. Layouts allein schützen nicht, weil sie bei der Navigation nicht neu geprüft werden. `requireAdmin()` liest das Cookie zuerst, damit Seiten immer dynamisch bleiben (sonst würde Next beim Bauen eine Umleitung vorrendern).
6. Der Systemcheck `/api/health` gibt in der Produktion ohne Token nur `ok` zurück und berührt weder Neon noch Redis.
7. Die Seite `/design` ist in der Produktion gesperrt. Das Verbindungslabor ist nur für den angemeldeten Admin erreichbar und schreibt ausschliesslich Testspiele im Bereich 900000 bis 999999.
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
* `src/app/api/ws`: WebSocket Endpunkt. `src/lib/realtime`: Spielspeicher, Hub, Client und Protokoll (siehe unten). `src/app/(admin)/admin/(portal)/lab`: Verbindungslabor.
* `scripts/dev-ws-server.ts`: lokaler WebSocket Server für die Entwicklung.
* `src/app/design`: Gestaltungsvorschau (nicht in der Produktion).
* `src/lib/env.ts`: Umgebungsvariablen. `src/lib/db`: Schema und Client. `src/lib/redis`: Schlüssel, REST Client, TCP Client.
* `src/lib/design.ts`: Antwortfarben und Symbole. `src/components`: gemeinsame Bausteine.
* `src/proxy.ts`: erste Schranke für `/admin`. `src/lib/auth`: Token, Passwort, Session. `src/lib/rate-limit.ts`: Rate Limit.
* `src/lib/quiz`: Schema, Regeln, Zahlenformat und Repository der Quizverwaltung. `src/lib/health.ts`: Systemprüfung. `src/lib/db/migrations.ts`: Migrationen aus dem Portal.
* `src/lib/game`: Spielablauf (siehe Abschnitt Spielablauf Schicht). `src/components/game`: Ansichten für Smartphone, Beamer und Steuerung. `src/app/api/join`: Beitritt.
* `src/app/(player)/join`, `src/app/(player)/play`: Smartphone. `src/app/(screen)/screen/[code]`: Beamer. `src/app/(admin)/admin/(portal)/games`, `.../results`: Durchführung und Resultate.
* `drizzle/`: Migrationen. `docs/`: Anleitungen (`SETUP.md`, `VERBINDUNGSTEST.md`, `LASTTEST.md`, `ANNAHMEN.md`). `scripts/`: Entwicklungsserver, Demo Quiz, Lasttest.

## Befehle

```bash
npm run dev          # lokale Entwicklung
npm run lint         # ESLint
npm run typecheck    # TypeScript
npm test             # Unit Tests (Integrationstests werden ohne TEST_DATABASE_URL und TEST_REDIS_URL übersprungen)
TEST_DATABASE_URL=postgres://BENUTZER:PASSWORT@localhost:5432/quiztest TEST_REDIS_URL=redis://localhost:6379 npm test   # mit Integrationstests
npm run build        # Produktionsbuild
npm run db:generate  # neue Migration aus Schemaänderung
npm run db:migrate   # Migration anwenden (DATABASE_URL_UNPOOLED)
npm run dev:ws       # lokaler WebSocket Server für die Entwicklung (Port 3001, weitere Instanz mit DEV_WS_PORT=3002)
npm run dev:fake-upstash   # Ersatzserver für Upstash REST (Port 8079), Hub und App darüber betreiben: UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079 UPSTASH_REDIS_REST_TOKEN=test
npm run seed:demo    # legt ein Demo Quiz mit sechs Fragen an (Status Bereit)
npm run loadtest     # Lasttest mit simulierten Geräten, siehe docs/LASTTEST.md
```

## Meilensteine

1. Projektgerüst, Region, Verbindungen, Schema, Dokumentation: **umgesetzt und abgenommen**.
2. Adminlogin und CMS: **umgesetzt und abgenommen**, auf Vercel in Betrieb.
3. WebSocket Endpunkt, Publish/Subscribe, Spielertoken, Statusabgleich, Verbindungsstrategie: **umgesetzt, wartet auf Bestätigung**. Lokal mit echtem Redis und echten WebSockets getestet. Auf Vercel noch nicht gemessen, dafür gibt es das Verbindungslabor.
4. Warteraum mit Bubbles, QR Code, Beitritt, Beamer Ansicht: **umgesetzt, wartet auf Bestätigung**.
5. Spielablauf mit oberem Drittel der Auflösung: **umgesetzt, wartet auf Bestätigung**.
6. Punkteberechnung, Rangliste, Podest, Siegerbildschirm: **umgesetzt, wartet auf Bestätigung**.
7. Spielende, Resultate nach Neon, Resultatansicht: **umgesetzt, wartet auf Bestätigung**.
8. Lasttest mit 60 simulierten Clients und Bericht: **umgesetzt, lokal gemessen** (`docs/LASTTEST.md`), auf Vercel noch zu messen.

Die Meilensteine 4 bis 8 entstanden in einem Zug ohne Rückfragen. Offene Punkte und Annahmen stehen in `docs/ANNAHMEN.md` und sollen vor einer Abnahme besprochen werden.

## Nicht bestätigt oder offen

Diese Punkte sind in den offiziellen Quellen nicht festgehalten oder noch nicht gemessen:

1. Ob `fra1` im Hobby Plan wählbar ist, und ob Neon und Upstash im kostenlosen Plan Frankfurt anbieten.
2. Die Namen der Variablen der Upstash Marketplace Integration. Die App akzeptiert `UPSTASH_REDIS_REST_*`, `KV_REST_API_*`, `REDIS_URL` und `KV_URL`.
3. Wie Upstash Publish und Subscribe Nachrichten zählt.
4. Ob eine ruhende WebSocket Verbindung Active CPU oder Provisioned Memory verbraucht, und welchen Close Code die Plattform beim Erreichen von 300 Sekunden sendet. Beides misst das Verbindungslabor (`docs/VERBINDUNGSTEST.md`).
5. Ob `upgradeWebSocket` lokal mit `vercel dev` läuft. Mit `next dev` oder `next start` gibt es keinen WebSocket Upgrade.
6. Ob die 0.5 Sekunden Regel auch für Schätzfragen gilt. Die Spezifikation nennt sie nur bei Multiple Choice. Umgesetzt wie bei Multiple Choice (Annahme 4), zu bestätigen.
7. Die Nutzungsbedingungen des Hobby Plans für einen Club.
8. Ob Upstash den Befehl PUBLISH innerhalb von Lua erlaubt. Der Spielspeicher wechselt bei einem Fehler automatisch auf getrenntes Veröffentlichen. Das Labor zeigt, welcher Weg aktiv ist.
9. Wie viele Funktionsinstanzen bei 60 Verbindungen entstehen und wie schnell Änderungen auf Vercel ankommen.
10. Wie Upstash die Befehle innerhalb von Lua Skripten zählt. Lokal gemessen sind es etwa 650 Befehle pro Frage mit 60 Personen (inklusive der Befehle innerhalb der Skripte), siehe `docs/LASTTEST.md`.
11. Die Entscheide der Meilensteine 4 bis 8 aus `docs/ANNAHMEN.md`, vor allem: Start nur mit Teilnehmenden, Gnadenfrist von 300 Millisekunden, Zeithinweis auch durch Smartphones, kein Wiedereintritt nach dem Start bei verlorenem Token.

## Quellen der Recherche (Stand 26. November 2026)

Offizielle Seiten von Vercel (WebSockets, Limits, Duration, Region, Fluid Compute), Upstash (Subscribe, Billing, REST API), Neon (Plans, Scale to Zero, Verbindungswahl, Vercel Integration), Drizzle (Kit, Neon), sowie der Quellcode der veröffentlichten Pakete `@vercel/functions` 3.11.4 und `@upstash/redis` 1.41.1.
