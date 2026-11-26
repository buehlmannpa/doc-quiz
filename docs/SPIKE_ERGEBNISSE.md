# Ergebnisse der Messungen (Spike)

Dieses Blatt wird nach den Messungen ausgefüllt. Anleitung: `docs/SPIKE.md`.

## Messumgebung

* Datum:
* Adresse des Preview Deployments:
* Region laut `/api/health`:
* Neon: Plan und Region:
* Upstash: Plan und Region:

## A: Vergleich der Subscribe Wege

Ohne Wartezeit (`idle=0`):

* ioredis über TCP: empfangen von erwartet, fehlend, p50, p95, max, Bereitzeit:
* Upstash SDK über SSE: empfangen von erwartet, fehlend, p50, p95, max, Bereitzeit:

Mit 60 Sekunden Wartezeit (`idle=60`):

* ioredis über TCP:
* Upstash SDK über SSE:

## B: WebSocket

20 Clients, 100 Nachrichten:

* Verbindungen ok und fehlgeschlagen:
* Anzahl Instanzen und Verteilung:
* Roundtrip (p50, p95):
* Verluste und Doppelte:
* Latenz der Zustellung (p50, p95, max):

60 Clients, 100 Nachrichten, Warten bis zum Schliessen:

* Verbindungen ok und fehlgeschlagen:
* Anzahl Instanzen und Verteilung:
* Verluste und Doppelte:
* Alter beim Schliessen (Sekunden):
* Close Codes:
* Vorwarnung bei 285 Sekunden erhalten (Anzahl):

## Beobachtungen und Entscheide

* Subscribe Weg für Meilenstein 3:
* Besonderheiten (Fehler, Auffälligkeiten):
* Verbrauch laut Vercel und Upstash nach den Läufen (Active CPU, Provisioned Memory, Redis Befehle):
