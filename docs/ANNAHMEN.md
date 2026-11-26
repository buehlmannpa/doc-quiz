# Annahmen und offene Fragen

Dieses Dokument sammelt alle Annahmen, die ich beim eigenständigen Umsetzen der Meilensteine 4 bis 8 getroffen habe. Zu jeder Annahme steht, was ich getan habe und was ich Ihnen vorschlage zu klären.

## Die wichtigsten Fragen für die Besprechung

1. Soll das Quiz auch ohne Teilnehmende gestartet werden können (Annahme 1)?
2. Passt die Gnadenfrist von 300 Millisekunden für späte Antworten, oder soll die Frist strikt sein (Annahme 2)?
3. Dürfen Beamer und Smartphones das Ende einer Frage auslösen, wenn der Admin Browser schläft (Annahme 10)?
4. Was soll geschehen, wenn jemand sein Smartphone wechselt oder die Browserdaten löscht und wieder beitreten will (Annahme 25)?
5. Zeigen die Antwortbuttons auf dem Smartphone nur das Symbol, oder wie jetzt auch den kurzen Text (Annahme 15)?
6. Meilenstein 3 ist auf Vercel noch nicht gemessen. Das Verbindungslabor liefert die Zahlen, der Lasttest ebenfalls (Annahme 22 und `docs/LASTTEST.md`).

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

## Ergänzungen während der Umsetzung

23. **Gesamtpunkte nach der letzten Frage:** Die Ergebnisse aller Spieler gehen an alle Geräte (ein einziger Zustand für alle). Nach der letzten Frage enthalten sie deshalb nur die Punkte dieser Frage, nicht die Gesamtpunkte. Sonst könnte ein Gerät die Rangliste vor der Enthüllung selbst ausrechnen. Die Auflösung der letzten Frage (richtige Antwort, Verteilung) bleibt im Zustand, der Beamer zeigt sie aber nicht.
24. **Eigene Antwort der anderen:** Die Ergebnisse enthalten bei der Auflösung auch, was jede Person gewählt oder geschätzt hat. Das ist erst nach Ende der Frage sichtbar und enthält nichts Vertrauliches. Ich halte es für unbedenklich. Frage: Soll das ausgeblendet werden?
25. **Verlorenes Token:** Das Token liegt nur im Browser. Wer die Browserdaten löscht, ein privates Fenster schliesst oder das Gerät wechselt, kann dem laufenden Spiel nicht mehr beitreten, weil der Beitritt nach dem Start gesperrt ist. Im Warteraum kann die Person einfach mit einem anderen Namen neu beitreten. Frage: Soll der Admin einen Platz freigeben oder ein Wiedereintritt über den Namen möglich sein? Das wäre ein Risiko, weil dann jemand fremde Plätze übernehmen könnte.
26. **Zeithinweis der Smartphones:** Smartphones melden den Zeitablauf erst 1.5 Sekunden nach Ablauf, Beamer und Admin Browser sofort. Das Ende der Frage verzögert sich bei schlafendem Admin Laptop also um etwa diese Zeit. Der Hinweis wird alle 2 Sekunden wiederholt, bis die Frage aufgelöst ist.
27. **Top 5 bei Gleichstand an der Grenze:** Die Rangliste auf dem Beamer zeigt genau fünf Einträge. Teilen sich Platz 5 und 6 denselben Rang, entscheidet die Zeitsumme, wer sichtbar ist.
28. **Podest:** Es zeigt höchstens drei Plätze. Nach der Enthüllung von Platz 1 erscheinen die Plätze 4 bis 10 in einer Liste neben dem Podest, am Ende erscheinen die ersten 8 Plätze. Bei gleichen Punkten steht auf dem Podest derselbe Rang mehrfach (zum Beispiel zweimal "1").
29. **Anzeige der Schätzung auf dem Smartphone:** Abweichung als Betrag (ohne Vorzeichen), Genauigkeit in Prozent, dazu die erreichten Punkte. Es gibt bewusst kein "richtig" oder "falsch". Auf dem Beamer zeigt eine Skala alle Schätzungen als Punkte, den richtigen Wert als Strich und die Toleranz als grünen Bereich.
30. **Keine Änderung einer Antwort:** Die erste Antwort gilt, auch bei Netzproblemen. Ein zweiter Versuch (zum Beispiel nach einer Wiederverbindung) wird vom Server als "schon beantwortet" erkannt und gilt als geglückt, weil die erste Antwort angekommen ist.
31. **Spiele verfallen nach 6 Stunden:** Ein Spiel in Redis verfällt 6 Stunden nach der letzten Änderung. Bleibt die Durchführung in Neon dann auf "Warteraum" oder "Läuft", bietet die Steuerung "Durchführung abbrechen" an.
32. **Tasten:** Leertaste und Pfeil rechts lösen die nächste Aktion aus, H blendet die Steuerleiste ein oder aus. Die Tasten gelten nur auf der Beamer Ansicht mit Admin Anmeldung, im Adminportal gibt es sie nicht (zu leicht versehentlich).
33. **Abbrechen:** Im Warteraum, während einer Frage und in der Auflösung möglich, mit Rückfrage. Ab dem Siegerbildschirm nicht mehr, weil die Resultate dann schon gespeichert sind.
34. **Demo Quiz:** `npm run seed:demo` legt ein Quiz mit sechs Fragen an (alle Fragetypen). Es ist nur zum Ausprobieren gedacht.
35. **Einheit bei Schätzfragen:** Leer ist erlaubt (zum Beispiel für ein Jahr). Dann steht keine Einheit hinter den Zahlen.
36. **Bubbles:** Eigene einfache Physik auf Canvas. Die Grösse passt sich der Zahl der Teilnehmenden an (bei 60 Personen kleiner). Ein Sprung wird nicht gespeichert.
37. **Beitrittsprüfung:** Die Seite zum Beitritt fragt vorher bei der Schnittstelle nach, ob es das Spiel gibt und ob es noch offen ist. Das verrät niemandem mehr als der Beitritt selbst, ist aber ebenfalls pro IP begrenzt.
