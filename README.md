# DOC Bern Quiz

Echtzeit Quiz für den Ducati Official Club Bern, ähnlich Kahoot. Teilnehmende scannen einen QR Code, antworten auf dem Smartphone, die Fragen erscheinen auf dem Beamer.

Stack: Next.js (App Router) mit TypeScript, Vercel (Frankfurt), Neon Postgres, Upstash Redis, WebSockets über Vercel Functions.

## Schnellstart

```bash
npm install
cp .env.example .env.local   # Werte eintragen
npm run dev
```

## Dokumentation

* `CLAUDE.md`: Architekturentscheide und Konventionen.
* `docs/SETUP.md`: Einrichtung von GitHub, Vercel, Neon und Upstash.
* `docs/VERBINDUNGSTEST.md`: Verbindungslabor für Messungen mit vielen Verbindungen und lokale Entwicklung der Echtzeit Schicht.

## Befehle

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run db:generate
npm run db:migrate
```

## Stand

Meilenstein 2 von 8: Adminlogin, Quizverwaltung, Systemseite mit Migrationen. Siehe `CLAUDE.md` für die Übersicht.
