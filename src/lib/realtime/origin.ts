/**
 * Prüfung des Origin Headers beim Aufbau einer WebSocket Verbindung.
 *
 * Browser senden bei jedem WebSocket Aufbau den Origin der Seite, die ihn auslöst. Eine fremde Webseite könnte
 * sonst im Browser des angemeldeten Admins eine Verbindung zu unserem Server öffnen (Cross Site WebSocket
 * Hijacking). Wir lassen nur Verbindungen von Seiten zu, die unter derselben Adresse laufen wie der Server.
 *
 * Fehlt der Origin ganz, stammt die Anfrage nicht aus einem Browser (zum Beispiel ein Testskript). Solche
 * Clients haben kein Cookie des Admins und können nichts missbrauchen, deshalb sind sie erlaubt.
 */
export function isAllowedOrigin(origin: string | null, hosts: readonly (string | null | undefined)[]): boolean {
  if (origin === null || origin === undefined) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Ungültige Angaben und der Wert "null" (zum Beispiel aus einem abgeschotteten Rahmen) sind nicht erlaubt.
    return false;
  }
  return hosts.some((host) => typeof host === "string" && host.length > 0 && host.toLowerCase() === originHost.toLowerCase());
}
