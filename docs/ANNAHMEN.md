# Annahmen und offene Fragen

Dieses Dokument sammelt alle Annahmen, die ich beim eigenständigen Umsetzen der Meilensteine 4 bis 8 getroffen habe. Zu jeder Annahme steht, was ich getan habe und was ich Ihnen vorschlage zu klären. Es wird während der Arbeit ergänzt.

## Spielablauf und Regeln

1. **Start nur mit Teilnehmenden:** Das Quiz lässt sich erst starten, wenn mindestens eine Person beigetreten ist. Frage: Soll ein Start ohne Teilnehmende möglich sein?
2. **Gnadenfrist für Antworten:** Der Server nimmt Antworten bis 300 Millisekunden nach Ablauf an, damit ein Tipp im letzten Moment bei kleinen Netzverzögerungen nicht verloren geht. Die Spezifikation verlangt strikte Ablehnung nach Ablauf. Frage: Soll die Frist ganz strikt sein, oder passt die Gnadenfrist?
3. **Zeitwertung bei verspäteter Antwort:** Eine Antwort in der Gnadenfrist zählt mit der vollen Zeit des Limits.
4. **Regel unter 0.5 Sekunden bei Schätzfragen:** Sie gilt auch für Schätzfragen (volle Zeitwertung unter 0.5 Sekunden), wie bei Multiple Choice.
5. **Zeitsumme für den Gleichstand:** Wer eine Frage nicht beantwortet, erhält für die Reihenfolge die volle Zeitlimit Dauer als Antwortzeit, damit Nichtantworten bei Punktgleichheit nicht vorne landen. Umfragen zählen nicht in die Zeitsumme.
6. **Rangliste bei Gleichstand:** Gleiche Punkte ergeben gleichen Rang (zum Beispiel 1, 1, 3). Die Anzeigereihenfolge entscheidet die kleinere Zeitsumme.
7. **Umfragen:** Der Auflösungsbildschirm zeigt nur die Verteilung im ganzen Bildschirm, ohne Rangliste. Die Rangliste ändert sich nicht.
8. **Nach der letzten Frage:** Der Beamer wechselt direkt auf den verdeckten Siegerbildschirm. Smartphones sehen für die letzte Frage richtig oder falsch und die Punkte, aber keinen Rang. Der Rang des einzelnen Geräts erscheint erst nach der Enthüllung von Platz 1. Die Rangdaten werden dazu vom Server erst dann gesendet (nicht nur ausgeblendet).
9. **Podest bei wenigen Personen:** Bei weniger als drei Personen gibt es entsprechend weniger Enthüllungsschritte.
10. **Auflösen bei Zeitablauf:** Neben dem Admin Browser lösen auch Beamer und Smartphones aus, wenn ihr Countdown abgelaufen ist. Der Server prüft den Ablauf selbst und handelt nur, wenn die Zeit wirklich abgelaufen ist. So steht das Spiel nicht still, wenn der Laptop des Admins schläft. Das weicht von der Vorgabe ab, dass das Spiel dann wartet.
11. **Spiel beenden vor der letzten Frage:** Wird das Spiel vorzeitig abgebrochen, bekommt die Durchführung den Status "abgebrochen" und es werden keine Resultate gespeichert.
12. **Neuaufbau der Verbindung:** Jedes Gerät baut seine Verbindung nach jeder Auflösung mit einer zufälligen Verzögerung von bis zu 3 Sekunden neu auf (wie in der Spezifikation).

## Beitritt und Oberfläche

13. **Ratenbegrenzung beim Beitritt:** Höchstens 120 Beitritte pro IP und 10 Minuten. Alle Personen im Clublokal teilen sich oft eine öffentliche IP Adresse.
14. **Icons:** 64 Emoji (Motorrad, Sport, Tiere und Weiteres). Jede Person bekommt ein zufällig vorgewähltes Icon und kann ein anderes wählen.
15. **Antwortbuttons zeigen auch den Text:** Die Spezifikation nennt Buttons ohne Text (der Fragetext steht auf dem Bildschirm). Ich zeige Symbol und den kurzen Antworttext, weil das bei schlechter Sicht auf den Beamer hilft.
16. **Hüpfen der Bubble:** Ein Tipp im Warteraum lässt die Bubble hüpfen, höchstens einmal pro 2 Sekunden und Person.
17. **Beamer ohne Anmeldung:** Die Beamer Ansicht ist über den Spielcode öffentlich, aber nur lesend. Wer als Admin angemeldet ist, sieht eine ausblendbare Steuerleiste.
18. **Name der App und Design:** "DOC Bern Quiz", helles Design wie die Club App.

## Technik

19. **Eine aktive Durchführung:** Nur eine Durchführung (Warteraum oder laufend) gleichzeitig, geprüft in Neon.
20. **Spielcodes:** Echte Spiele 100000 bis 899999, das Verbindungslabor 900000 bis 999999.
21. **Resultate werden gespeichert**, sobald die letzte Frage aufgelöst ist, mit bis zu drei Versuchen. Schlägt das fehl, zeigt das Steuerpult einen Hinweis und einen Knopf zum Wiederholen.
22. **Lasttest:** Der Lasttest lief lokal (eine oder zwei Hub Instanzen und ein lokales Redis), nicht auf Vercel. Die Zahlen gelten also nur für diese Umgebung. Auf Vercel misst das Verbindungslabor.
