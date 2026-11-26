/** Anzeige von Datum und Zeit in Schweizer Schreibweise und Schweizer Zeit. */
const dateTime = new Intl.DateTimeFormat("de-CH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Zurich",
});

export function formatDateTime(date: Date): string {
  return dateTime.format(date);
}
