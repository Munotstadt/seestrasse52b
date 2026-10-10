# /dash – Dashboard lokal (NAS) und online (52b.munot.app/dash)

Ein UI, zwei Backends. Das UI (`public/dash/**`) ist **dieselbe Dateien-Sammlung** lokal und online. Nur die
Datenquelle und `config.js` unterscheiden sich.

```
public/dash/                 ← gemeinsames UI (HTML, CSS, JS, Chart.js)   ← hier ändern, sonst nirgends
src/dash/                    ← Online-Backend (Worker, nur D1, nur lesen)
dash-local/                  ← NAS-Backend (Node/Docker: Sensor-Container, MariaDB, Wiser, myStrom, Škoda-Steuerung)
scripts/dash-check.mjs       ← prüft: lokal = online (Routen, Seiten, pendent-Liste)
scripts/dash-contract.json   ← der Vertrag zwischen UI und beiden Backends
scripts/dash-version.mjs     ← Hash des UI-Stands (Badge im Kopf: «lokal · 679a12b» / «online · 679a12b»)
workers/skoda-collector/     ← Škoda API → D1 (löst später den NAS-Collector ab)
schema/dash_migrations.sql   ← einmalig in D1 ausführen
```

## Synchron halten

| Was ändert sich | Wo ändern | Wirkung |
|---|---|---|
| Inhalt/Layout einer Seite | `public/dash/js/pages/*.js`, `css/app.css` | gilt automatisch lokal **und** online |
| Neue Seite | `public/dash/js/app.js` (PAGES) + `CONFIG.pages` in **beiden** Backends | `dash-check` schlägt an, wenn eines fehlt |
| Neuer Datenpunkt / neue Route | UI + `scripts/dash-contract.json` + beide Backends | `dash-check` prüft Route lokal und online |
| Seite online noch ohne Daten | `CONFIG.pages` online `'pending'` + `pendingOnline` im Vertrag | Reiter grau, Hinweis «pendent» |

Kontrolle mit blossem Auge: Der Hash im Kopf (ab 900 px Breite sichtbar) ist lokal und online **identisch**, wenn beide
Ansichten denselben UI-Stand ausliefern. `dash-check` läuft zusätzlich vor jedem Deploy in GitHub Actions.

Ablauf bei einer Änderung: im Repo ändern → `node scripts/dash-check.mjs` → committen/pushen (Online-Deploy automatisch)
→ `.\dash-local\deploy-nas.ps1` (NAS).

## Ladegeschwindigkeit

- Statische Dateien kommen direkt aus dem Cloudflare-Edge (Workers Assets), ohne Worker-Aufruf. Chart.js (205 KB) ist
  `immutable` gecacht und wird erst geladen, wenn ein Diagramm gebraucht wird (Energy lädt es parallel zu den Daten).
- Übrige Dateien: 60 s frisch, danach sofort aus dem Cache und im Hintergrund erneuert (`public/_headers`; lokal identisch
  in `dash-local/server.js`, zusätzlich Brotli/gzip).
- Daten: Antworten liegen 15–300 s im Edge-Cache (`cachedJson`), mehrere D1-Abfragen laufen in einem `batch`, Verdichtung
  (6 min / 10 min / 30 min) passiert in SQL, nicht im Browser.
- Browser zeigt beim Öffnen sofort die letzte Antwort (localStorage), frische Daten ersetzen sie (`apiSWR`).
- `/dash` (ohne Slash) wird ohne Redirect ausgeliefert.

## Online-Umfang

| Seite | Online | Quelle |
|---|---|---|
| Temperatur | live | Innen: `seestrasse52b_values` (Shelly), Aussen Kloten: D1 `meteo` |
| Energy | live | D1 `energy` (Live-Punkte + `solarmanager_data`) |
| Car | live, sobald Collector läuft | `skoda_enyaq_api` in D1 `seestrasse52b` |
| Water | pendent | – |
| Blinds/Light | pendent | – (Wiser-Gateway nur im Heimnetz) |

Online ist nur lesend (keine Steuerung). Zugriff: Cloudflare Access wie für die ganze Domain.

## Einrichten (einmalig)

1. **D1-Migration:** `npx wrangler d1 execute seestrasse52b --remote --file=schema/dash_migrations.sql`
   (Tabellen `skoda_enyaq_api`, `skoda_enyaq_raw`, Index für schnellere Innensensor-Verläufe).
2. **Push auf `main`** → Deploy-Workflow baut und deployt den Worker inkl. `/dash` (neue D1-Bindings `METEO`, `ENERGY`).
3. **NAS:** `.\dash-local\deploy-nas.ps1`. Danach lokal unter `http://192.168.86.30:8888/dash/` (`/` leitet weiter).
4. **Škoda-Umstieg (Reihenfolge einhalten, das API-Limit von 20 Aufrufen/h gilt pro Fahrzeug für alle Clients zusammen):**
   1. `npx wrangler secret put SKODA_API_KEY --config workers/skoda-collector/wrangler.jsonc`
   2. NAS-Collector `skoda-enyaq-collector` stoppen.
   3. In `workers/skoda-collector/wrangler.jsonc` `COLLECT_ENABLED` auf `"1"`, pushen.
   4. Nach 1–2 Läufen die Daten prüfen (`SELECT * FROM skoda_enyaq_api ORDER BY id DESC LIMIT 3` und `skoda_enyaq_raw`).
   Die lokale Steuerung (Target SoC, Start/Stopp) braucht weiterhin das Kontingent: 12 Aufrufe/h Collector + Befehle.
   Später kann die lokale Car-Seite ihre Statusdaten aus D1 lesen (gleiche Spaltennamen) und der NAS-Collector entfällt.

## Annahmen, die du kurz prüfen solltest (ich hatte keinen Zugriff auf deine D1)

- **Innensensoren:** Zuordnung Gerät → Parameter-IDs steht in `src/dash/temperatur.js` (`SENSORS`: 11/22 und 7/18).
  Angezeigter Name = `Label` bzw. `Name` ohne «(Temp)». Zeitstempel der Roh-Zeilen werden als UTC gelesen.
  Prüfen: `SELECT date, ParameterID, value, source FROM seestrasse52b_values WHERE ParameterID IN (7,11,18,22) ORDER BY date DESC LIMIT 8;`
- **Energy:** «Heute» wird aus 6-Minuten-Mitteln der Live-Punkte hochgerechnet; MtD/YtD = `solarmanager_data` (bis gestern)
  plus heute. Fehlt dort ein abgeschlossener Tag (Pipeline-Lücke), fehlt er auch in MtD/YtD.
- **Škoda-Felder:** Das Mapping der API-Antwort ist tolerant geschrieben, aber ungetestet gegen die echte Antwort.
  Die letzte Rohantwort liegt in `skoda_enyaq_raw` – Abweichungen lassen sich in `mapVehicle()` korrigieren, ohne das
  API-Limit zu belasten.
- Die Zeile «Battery» der Temperatur-Kacheln ist online leer (Batteriestand liegt nicht in D1).
