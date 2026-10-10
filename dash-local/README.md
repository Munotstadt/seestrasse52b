# Dashboard Seestrasse 52b (lokal, NAS)

> Dieses Verzeichnis ist das **lokale Backend**. Das UI liegt gemeinsam mit der Online-Version unter `public/dash/` im Repo – siehe `../DASH.md`.
> Deployment: `.\dash-local\deploy-nas.ps1` (aus dem Repo-Ordner). Aufruf: `http://192.168.86.30:8888/dash/` (`/` leitet weiter).

Smarthome-Dashboard, gehostet als Docker-Container auf dem NAS und im lokalen WLAN abrufbar (iPad, iPhone, später 7"-Raspberry-Pi-Display mit 800 × 480).

## Aufbau

- `server.js` – Node-Server ohne Abhängigkeiten: liefert `public/` aus, liest **Aussen Kloten** aus Cloudflare D1 (`/api/outdoor/*`) und leitet alle übrigen `/api/*` (`/api/latest`, `/api/series`) an den bestehenden Sensor-Container weiter.
- `public/dash/index.html` – Rahmen mit Eyebrow-Navigation (gemeinsam mit der Online-Version, wird beim Deployment mitgeliefert).
- `public/dash/js/app.js` – Seitenregister + Hash-Router (`#/temperatur`). Neue Subpage: in `PAGES` eintragen und `CONFIG.pages` in `server.js` **und** `src/dash/index.js` ergänzen (`scripts/dash-check.mjs` prüft das).
- `public/js/pages/temperatur.js` – Temperatur-Seite (Innenkacheln + Aussen Kloten, Verlauf mit 24 h / 7 Tage / 30 Tage / 1 Jahr).
- Chart.js liegt lokal in `public/vendor/` (läuft auch ohne Internet).

## Deployment auf dem NAS

1. `.\dash-local\deploy-nas.ps1` kopiert Server + gemeinsames UI nach `/volume1/docker/dashboard52b/` (`scp -O`) und baut den Container. `secrets/.env` bleibt unangetastet.
2. `cp secrets/.env.example secrets/.env` und ausfüllen (Ordner `secrets/` wird weder ins Docker-Image kopiert noch eingecheckt):
   - `SENSOR_API_URL` – Adresse des bestehenden Sensor-Containers (z. B. `http://192.168.86.30:<Port>`)
   - `CF_ACCOUNT_ID`, `CF_API_TOKEN` – Cloudflare-Token mit Berechtigung *D1 – Lesen*
3. `docker compose up -d --build`
4. Aufruf im WLAN: `http://192.168.86.30:8888/dash/`

## iPad / iPhone

Seite in Safari öffnen (`http://192.168.86.30:8888/dash/`), dann Teilen → «Zum Home-Bildschirm». Sie startet danach als Vollbild-App ohne Browserleiste.

## Raspberry Pi (Kiosk, später)

```
chromium-browser --kiosk --noerrdialogs --disable-infobars "http://192.168.86.30:8888/dash/#/temperatur"
```

Dunkles Farbschema erzwingen: `?theme=dark` an die URL anhängen (vor dem `#`).

## Datenquellen Kloten

Tabelle `meteo_klo_frequently` (10-Minuten-Werte) in D1 `meteo`; 24 h-Summen = Summe `precip_mm` bzw. `sunshine_min / 60` der letzten 24 Stunden. Der 1-Jahres-Verlauf stammt aus `meteo_klo_daily`.

## Seite «Car» (Škoda Enyaq)

Liest den letzten Datensatz aus MariaDB (`52b_seestrasse_logger.skoda_enyaq_api`, gefüllt vom `skoda-enyaq-collector`). Verbindungsdaten in `secrets/.env` (`DB_*`).

Nur-Lese-Benutzer für das Dashboard anlegen (SQL in einfachen Anführungszeichen, wegen der Backticks):

```
sudo docker exec -it mariadb mariadb -u root -p -e 'CREATE USER `dashboard_ro`@`%` IDENTIFIED BY "<passwort>"; GRANT SELECT ON `52b_seestrasse_logger`.`skoda_enyaq_api` TO `dashboard_ro`@`%`; FLUSH PRIVILEGES;'
```

Hinweis: Die Anzeige ist so aktuell wie der Collector (Intervall) und das Fahrzeug selbst – «Car reported» zeigt, wann das Auto zuletzt gemeldet hat.

### Car: Steuerung (Target SoC, Start/Stopp)

Befehle gehen über die MyŠkoda Public API (`SKODA_API_KEY`, `SKODA_VIN` in `secrets/.env`; derselbe Key wie im `skoda-enyaq-collector`).

- **Target SoC** 40–100 % in 10er-Schritten (`PUT …/charging/limit`).
- **Start/Stopp** sofort oder zu einer gewählten Zeit (bis 7 Tage voraus). Zeitgesteuerte Aufträge speichert der Container (Volume `/data`), sie überleben einen Neustart. Wer länger als 10 Minuten nach der Zeit wieder startet, holt den Auftrag nicht mehr nach (er wird als «Missed» markiert). Bei vorübergehenden Fehlern gibt es bis zu 5 Versuche im Abstand von 2 Minuten.
- **Antwort 202** bedeutet nur «übermittelt». Das Auto bestätigt über den nächsten Collector-Lauf (bis 5 Minuten).
- **Limit:** 20 API-Aufrufe pro Stunde und Fahrzeug, der Collector verbraucht ca. 12. Bei weniger als 2 verbleibenden Aufrufen (`rate_limit_remaining`) pausiert die Seite sofortige Befehle.
- **Zugriff:** Die Seite hat keine Anmeldung – jeder im WLAN kann Befehle auslösen.


## Energy (Solar Manager)

Die Seite liest vom Container `solarmanager-viewer` (`/api/latest`, `/api/day`). In `secrets/.env`:

```
SOLAR_API_URL=http://192.168.86.30:8053
```

Falls der Container die NAS-IP nicht erreicht (wie bei MariaDB): Netzwerk des Viewers in `docker-compose.yml` als `external` eintragen und `SOLAR_API_URL=http://solarmanager-viewer:8053` setzen.
MtD/YtD zählen ab Datenbeginn des Collectors, falls dieser später als der Monats-/Jahresbeginn gestartet ist.


## Blinds/Light (Wiser)

Die Seite zeigt Licht und Blinds pro Raum (gruppiert nach Stockwerk) und leitet Befehle an den Container `wiser-storen` (Port 8085) weiter.
Zuordnung der Geräte zu Räumen und Namen bleibt in der Wiser-Seite (`/lichter.html`, «Zuordnen»); nicht zugeordnete Geräte werden ausgeblendet.

```
WISER_API_URL=http://192.168.86.30:8085
```

`wiser-storen` läuft im Host-Netzwerk. Falls das Dashboard die NAS-IP nicht erreicht (Timeout), stattdessen
`WISER_API_URL=http://host.docker.internal:8085` setzen (der Eintrag `extra_hosts` steht in `docker-compose.yml`).
Blinds: Position in % geschlossen (0 = offen), Lamellenstufen 0–9. Durchgereicht werden nur Schalten/Dimmen und Hoch/Stopp/Runter/Position/Lamellen.
