# Einrichtung: GitHub, Vercel, Neon und Upstash

Diese Anleitung führt Schritt für Schritt vom leeren Konto zum laufenden Systemcheck. Sie gehört zu Meilenstein 1.

Die Bezeichnungen in den Oberflächen von Vercel, Neon und Upstash ändern sich gelegentlich. Wo ich eine Angabe nicht in der offiziellen Dokumentation bestätigen konnte, steht ein Vermerk "nicht bestätigt". Bitte melden Sie Abweichungen, damit die Anleitung korrigiert wird.

## Überblick

1. GitHub: Das Repository `buehlmannpa/doc-quiz` existiert bereits.
2. Vercel: Projekt anlegen und mit dem Repository verbinden.
3. Neon: Datenbank über den Vercel Marketplace anlegen (Region Frankfurt).
4. Upstash: Redis über den Vercel Marketplace anlegen (Region Frankfurt).
5. Eigene Variablen setzen.
6. Datenbank Tabellen anlegen (Migration).
7. Deployen und den Systemcheck aufrufen.

Alle Dienste laufen im jeweils kostenlosen Plan. Die Vercel Funktionen laufen in Frankfurt (`fra1`), das legt die Datei `vercel.json` fest.

## Schritt 1: GitHub

Das Repository gehört zum Konto `buehlmannpa`. Die Entwicklung läuft auf dem Branch `claude/realtime-quiz-platform-hjdvqz`. Vercel erstellt für jeden Branch ein Preview Deployment mit eigener Adresse. Der Branch `main` wird später zur Produktion. Es ist nichts weiter einzurichten.

## Schritt 2: Vercel Projekt

1. Im Vercel Dashboard ein neues Projekt anlegen und das GitHub Repository `doc-quiz` importieren.
2. Das Framework wird als Next.js erkannt. Build Einstellungen nicht ändern.
3. Noch nicht deployen oder das erste Deployment fehlschlagen lassen. Die Datenbanken fehlen noch.

Region und Laufzeit:

* `vercel.json` setzt die Region `fra1` und aktiviert Fluid Compute. WebSockets brauchen Fluid Compute. Laut Vercel Dokumentation ist es für Projekte ab dem 23. April 2025 standardmässig aktiv.
* Der Hobby Plan erlaubt nur eine Region. Ob `fra1` auf Hobby gewählt werden kann, steht nicht in der Dokumentation (nicht bestätigt). Schlägt das Deployment wegen der Region fehl, bitte die Fehlermeldung melden.
* Nach dem ersten erfolgreichen Deployment zeigt der Systemcheck (Schritt 7) die tatsächliche Region.

## Schritt 3: Neon (Postgres) über den Vercel Marketplace

1. Im Vercel Dashboard den Marketplace öffnen (Bereich Integrations, Browse Marketplace) und Neon auswählen.
2. Installieren, den kostenlosen Plan wählen und einen Datenbanknamen vergeben, zum Beispiel `doc-quiz`.
3. Als Region Frankfurt wählen (AWS Europe Central 1). Ob dieser Standort im kostenlosen Plan angeboten wird, ist nicht bestätigt. Wird er nicht angeboten, bitte melden und die nächstgelegene europäische Region wählen.
4. Die Datenbank mit dem Projekt verbinden, für alle Umgebungen (Production, Preview, Development).

Neon setzt laut Neon Dokumentation unter anderem diese Variablen:

* `DATABASE_URL`: gepoolte Verbindung, für die App.
* `DATABASE_URL_UNPOOLED`: direkte Verbindung, für Migrationen.

Gut zu wissen: Der kostenlose Plan schaltet die Datenbank nach 5 Minuten Inaktivität ab. Die erste Abfrage danach dauert laut Neon wenige hundert Millisekunden länger. Während eines Spiels liegt Neon nicht im kritischen Pfad.

Empfehlung für Preview Deployments: Der kostenlose Neon Plan erlaubt 10 Branches pro Projekt. Ein eigener Neon Branch für Preview trennt Testdaten von echten Daten. Das ist optional und kann später nachgezogen werden.

## Schritt 4: Upstash (Redis) über den Vercel Marketplace

1. Im Marketplace "Upstash for Redis" auswählen und installieren.
2. Den kostenlosen Plan wählen, einen Namen vergeben (zum Beispiel `doc-quiz`) und als Region Frankfurt (eu central 1) wählen. Ob Frankfurt angeboten wird, ist nicht bestätigt.
3. Die Datenbank mit dem Projekt verbinden, für alle Umgebungen.

Variablennamen: Die offizielle Dokumentation nennt nicht, welche Variablen diese Integration setzt (nicht bestätigt). Die App erkennt deshalb mehrere Namen:

* REST Adresse: `UPSTASH_REDIS_REST_URL` oder `KV_REST_API_URL`.
* REST Token: `UPSTASH_REDIS_REST_TOKEN` oder `KV_REST_API_TOKEN`.
* TCP Adresse (für den Subscriber): `REDIS_URL` oder `KV_URL`. Sie muss mit `rediss://` beginnen (TLS).

Bitte prüfen Sie nach der Installation unter Settings, Environment Variables, welche Namen vorhanden sind. Der Systemcheck zeigt ebenfalls, welche der bekannten Namen gesetzt sind (nur Namen, keine Werte). Fehlt die TCP Adresse, kopieren Sie in der Upstash Konsole die TLS Adresse der Datenbank (beginnt mit `rediss://`) und tragen sie in Vercel als `REDIS_URL` ein.

Wichtig: Der kostenlose Plan erlaubt nur eine Datenbank pro Konto und 500'000 Befehle pro Monat. Produktion, Preview und lokale Entwicklung teilen sich diese Datenbank. Die App trennt sie über ein Präfix bei allen Schlüsseln und Kanälen (`prod`, `preview`, `dev`, `local`).

## Schritt 5: Eigene Variablen

Unter Settings, Environment Variables im Vercel Projekt:

* `ADMIN_PASSWORD`: Passwort für das Adminportal, mindestens 8 Zeichen. Wird ab Meilenstein 2 gebraucht.
* `SESSION_SECRET`: langer Zufallswert, mindestens 32 Zeichen. Erzeugen mit `openssl rand -base64 48`. Es gibt keinen Ersatzwert: Ohne dieses Geheimnis startet der Adminbereich nicht.
* `HEALTH_TOKEN` (optional): damit der Systemcheck in der Produktion die Details zeigt.
* `REALTIME_MAX_AGE_NOTICE_MS` und `REALTIME_MAX_AGE_CLOSE_MS` (optional, nur für eine Messung): siehe `docs/VERBINDUNGSTEST.md`. Im Normalbetrieb nicht setzen.

## Schritt 6: Tabellen anlegen (Migration)

Die Tabellen entstehen mit Drizzle Kit. Die Migration läuft über die direkte Adresse `DATABASE_URL_UNPOOLED` und einmal pro Änderung, nicht bei jedem Deployment. Es gibt zwei Wege.

### Variante A: im Adminportal (ohne eigenen Rechner)

Seit Meilenstein 2 kann der angemeldete Admin die Migrationen im Browser anwenden. Das ist der Weg, wenn auf dem Rechner kein Node oder keine Datenbankverbindung erlaubt ist.

1. `ADMIN_PASSWORD` und `SESSION_SECRET` müssen in Vercel gesetzt sein (Schritt 5), und zwar auch für die Umgebung Preview, wenn Sie ein Preview Deployment verwenden.
2. `DATABASE_URL` und `DATABASE_URL_UNPOOLED` müssen für dieselbe Umgebung gesetzt sein (Schritt 3).
3. Das Deployment abwarten. Öffnen Sie dessen Adresse mit dem Zusatz `/admin` und melden Sie sich mit `ADMIN_PASSWORD` an.
4. Öffnen Sie im Menü die Seite System. Dort stehen die Verbindungen und der Stand der Migrationen, zum Beispiel "Angewendet: 0 von 1".
5. Klicken Sie auf "Migrationen anwenden". Erwartet wird "1 Migration(en) angewendet" und danach "Angewendet: 1 von 1". Die Zeile "Neon Postgres" zeigt dann "in Ordnung".

Der Knopf führt ausschliesslich die Migrationsdateien aus dem Repository aus. Eigenes SQL ist nicht möglich. Ein mehrfacher Klick ist harmlos, weil Drizzle sich angewendete Migrationen merkt und eine Datenbanksperre gleichzeitige Läufe verhindert.

### Variante B: auf Ihrem Rechner

Auf Ihrem Rechner mit Node 22:

```bash
git clone https://github.com/buehlmannpa/doc-quiz.git
cd doc-quiz
git checkout claude/realtime-quiz-platform-hjdvqz
npm install
cp .env.example .env.local
```

Tragen Sie in `.env.local` die Adresse `DATABASE_URL_UNPOOLED` ein. Sie finden sie in Vercel unter Settings, Environment Variables oder in der Neon Konsole bei der Verbindungsangabe (Auswahl der direkten Verbindung ohne Pooler). Falls Vercel Werte als vertraulich schützt und nicht anzeigt, nehmen Sie die Adresse aus der Neon Konsole (nicht bestätigt, wie Vercel hier genau reagiert). Danach:

```bash
npm run db:migrate
```

Erwartet wird die Meldung "migrations applied successfully". Danach gibt es sechs Tabellen: `quizzes`, `questions`, `answer_options`, `game_sessions`, `players`, `responses`.

Wird später das Schema geändert, erzeugt `npm run db:generate` eine neue Migrationsdatei im Ordner `drizzle/`. Diese wird mit dem Code committet und mit `npm run db:migrate` angewendet.

## Schritt 7: Deployen und Systemcheck

Die Seite System im Adminportal zeigt dieselben Angaben wie `/api/health`, auch in der Produktion, ohne `HEALTH_TOKEN`, aber mit Anmeldung. Sie ist der bequemste Weg zur Kontrolle. Die folgenden Angaben zu `/api/health` gelten sinngemäss.

1. Den Branch pushen oder im Vercel Dashboard ein Redeploy auslösen.
2. Die Adresse des Preview Deployments öffnen (Sie sehen sie im Vercel Dashboard beim Deployment) und `/api/health` anhängen. Preview Deployments sind in der Regel durch Vercel Authentication geschützt. Im Browser genügt es, bei Vercel angemeldet zu sein.

Erwartete Antwort (gekürzt):

```json
{
  "ok": true,
  "deployment": "preview",
  "region": "fra1",
  "regionOk": true,
  "keyPrefix": "preview",
  "envPresent": { "database": ["DATABASE_URL", "DATABASE_URL_UNPOOLED"], "redisRest": ["..."], "redisTcp": ["..."] },
  "checks": {
    "database": { "status": "ok", "firstMs": 0, "warmMs": 0, "detail": { "tablesPresent": 6, "tablesExpected": 6 } },
    "redisRest": { "status": "ok", "firstMs": 0, "warmMs": 0 },
    "redisTcp": { "status": "ok", "firstMs": 0, "warmMs": 0 }
  }
}
```

So lesen Sie die Werte:

* `region` muss `fra1` sein. Sonst läuft die Funktion nicht in Frankfurt. Die Variable `VERCEL_REGION` stammt aus den Systemvariablen von Vercel. Dass sie in dieser Form gesetzt ist, habe ich nicht in der Dokumentation geprüft.
* `firstMs` ist die erste Anfrage, `warmMs` die zweite. Ein hoher `firstMs` bei Neon zeigt den Kaltstart nach Inaktivität. Bei Redis über TCP enthält `firstMs` den Verbindungsaufbau mit TLS.
* `status` ist `skipped`, wenn die Variablen fehlen. Die Meldung nennt dann die erwarteten Namen.

Häufige Probleme:

* `Migration fehlt`: Schritt 6 ausführen.
* `redisTcp` ist `skipped`: `REDIS_URL` fehlt oder beginnt nicht mit `rediss://`.
* `regionOk` ist `false`: Funktionsregion prüfen (Schritt 2).

In der Produktion antwortet `/api/health` ohne Token nur mit `{ "ok": true }` und berührt weder Neon noch Redis. Mit dem Header `x-health-token` (Wert von `HEALTH_TOKEN`) erscheinen die Details.

## Lokale Entwicklung

```bash
npm install
cp .env.example .env.local   # Werte eintragen
npm run dev
```

Grenzen der lokalen Entwicklung:

* Die WebSocket Funktion von Vercel gibt es nur in der Vercel Laufzeit. Lokal antwortet `/api/ws` mit 501. Für die Entwicklung startet `npm run dev:ws` einen eigenen WebSocket Server mit demselben Hub (Port 3001). Setzen Sie dafür in `.env.local` die Variable `NEXT_PUBLIC_WS_URL=ws://localhost:3001/api/ws` und starten Sie beide Prozesse. Details in `docs/VERBINDUNGSTEST.md`.
* Ein lokaler Redis Server (`redis://localhost:6379`) und ein lokales Postgres reichen für die Entwicklung. Ohne die REST Zugangsdaten von Upstash arbeitet der Spielspeicher automatisch über `REDIS_URL`.

Nützliche Befehle:

```bash
npm run lint        # Code Qualität
npm run typecheck   # TypeScript Prüfung
npm test            # Unit Tests (Integrationstests brauchen TEST_DATABASE_URL und TEST_REDIS_URL)
npm run dev:ws      # lokaler WebSocket Server für die Entwicklung
npm run build       # Produktionsbuild
```

## Kontingente im Blick behalten

* Upstash Free: 500'000 Befehle pro Monat. Der Systemcheck braucht pro Aufruf 2 Befehle (PING zählt laut Upstash nicht). Das Verbindungslabor (`docs/VERBINDUNGSTEST.md`) verbraucht pro Lauf mit 60 Teilnehmenden einige hundert bis wenige tausend Befehle.
* Vercel Hobby: 4 Stunden Active CPU, 360 GB Stunden Provisioned Memory und 1 Million Aufrufe pro Monat. Wie viel eine ruhende WebSocket Verbindung davon verbraucht, ist nicht dokumentiert. Das wird in Meilenstein 8 gemessen.
* Neon Free: 100 CU Stunden pro Monat und 5 GB Transfer.

Hinweis zu den Nutzungsbedingungen: Der Hobby Plan von Vercel ist nach meinem Kenntnisstand für nicht kommerzielle Nutzung gedacht. Bitte prüfen Sie die Bedingungen von Vercel für Ihren Club.
