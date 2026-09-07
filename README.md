# Seestrasse 52B — Cloudflare-Migration

Dieses Repo ersetzt `Munotstadt/ManagerSeestrasse52B` (GitHub Pages + Turso).
Neu: **Cloudflare Worker** (Static Assets + API) + **D1** + **Cloudflare Access
(Google-Login)** auf `52b.munot.app`.

## Was sich geändert hat

- **Datenbank:** Nicht mehr Turso, sondern die bereits produktiv befüllte
  D1-Datenbank `seestrasse52b` (`8114362a-d78d-4c17-9f47-9abee82f3e26`).
  Tabellen: `seestrasse52b_parameter`, `seestrasse52b_values`
  (Spalten: `date, ParameterID, value, source, comments, created_at, modified_at`,
  `UNIQUE(date, ParameterID)` — **ein Wert pro Parameter und Tag**, keine `LogID` mehr).
- **Eve-Räume:** Temperatur und Luftfeuchtigkeit sind pro Raum zwei eigenständige
  Parameter (`ParaGroup='Eve Räume'`, `ParaType='Sensor'`, `Label=Raumname`,
  `Name` endet auf `(Temp)`/`(Luftf.)`) statt einer separaten Sensor/ValueType-Struktur.
- **Auth:** Kein Turso-Token mehr im Frontend. Die komplette Domain
  `52b.munot.app` liegt hinter Cloudflare Access (Google als Identity Provider).
  Der Worker vertraut dem `Cf-Access-Authenticated-User-Email`-Header.
- **Bereits laufend, NICHT Teil dieses Repos:** Der tägliche "at home"-Heartbeat
  und der `Cloudflare_worker_daylength-niederhasli`-Worker schreiben bereits in
  dieselbe D1-DB und bleiben unverändert bestehen.
- **Bekannte Verhaltensänderung:** Da nur noch ein Wert pro Tag/Parameter möglich
  ist, überschreibt beim Skoda-Import die letzte Fahrt des Tages eine frühere
  Fahrt desselben Tages (Uhrzeit/Adresse landet im Kommentarfeld). Bei Bedarf
  gesondert ansprechen, falls untertägige Mehrfachwerte doch gebraucht werden.

## Von mir bereits erledigt

- [x] D1-Anbindung geprüft, echtes Schema ausgelesen
- [x] Alle Seiten (`index`, `admin`, `log`, `parameter`, `eve-data`, `uploader`)
      auf das reale D1-Schema umgeschrieben
- [x] `assets/db.js`: neuer schlanker Client, der `/api/query` auf dem Worker
      aufruft (keine Zugangsdaten im Frontend)
- [x] `src/index.js`: Worker mit `/api/query`-Endpoint (D1-Bindung) + Auslieferung
      der statischen Seiten, mit Defense-in-Depth-Check auf den Access-Header
- [x] `wrangler.jsonc`: D1-Binding, Static Assets, Custom-Domain-Route für
      `52b.munot.app`
- [x] `.github/workflows/deploy.yml`: Deploy bei Push auf `main`

## Was du noch manuell machen musst

Diese Schritte kann ich über die verfügbaren Cloudflare-Tools nicht ausführen
(nur D1-Verwaltung und Doku-Suche sind angebunden — kein Zero-Trust/Access,
keine DNS-/Custom-Domain-Verwaltung, kein Worker-Deploy).

1. **Neues GitHub-Repo befüllen**
   Diesen Ordner nach `https://github.com/Munotstadt/seestrasse52b.git` pushen
   (z.B. via github.dev: neues Repo anlegen, Dateien hochladen/committen).

2. **Cloudflare API-Token für den Deploy-Workflow**
   Im Cloudflare-Dashboard unter *My Profile → API Tokens* einen Token mit
   Rechten `Workers Scripts:Edit`, `D1:Edit`, `Zone:DNS Edit` (für die Zone
   `munot.app`, wegen der Custom Domain) erstellen.
   Als GitHub-Secrets im neuen Repo hinterlegen:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

3. **Erster Deploy**
   Entweder lokal `npx wrangler login && npx wrangler deploy` (einmalig) oder
   den GitHub-Actions-Workflow manuell auslösen (Tab *Actions* → *Deploy to
   Cloudflare Workers* → *Run workflow*). Das legt automatisch den Worker,
   die Route und (via `custom_domain: true`) den DNS-Eintrag für
   `52b.munot.app` an — vorausgesetzt `munot.app` liegt bereits als Zone in
   diesem Cloudflare-Account.

4. **Cloudflare Access einrichten (Google-Login)**
   Im Dashboard: *Zero Trust → Access → Applications → Add an application →
   Self-hosted*.
   - Domain: `52b.munot.app`
   - Identity Provider: Google (unter *Settings → Authentication* einmalig als
     Login-Methode hinzufügen, falls noch nicht vorhanden)
   - Policy: z.B. "Allow" für deine Google-Adresse(n) (Email-Domain oder
     einzelne Adressen)
   Damit ist die komplette App inkl. `/api/query` erst nach Google-Login
   erreichbar.

5. **Smoke-Test**
   `52b.munot.app` aufrufen → Google-Login → Übersicht sollte die bestehenden
   Parameter (Wasserhärte, at home, Eve-Räume, Auto Skoda, …) mit den echten
   Werten zeigen. Danach admin.html/log.html/eve-data.html/uploader.html
   durchklicken.

## Struktur

```
├── src/index.js          Worker: /api/query (D1) + statische Auslieferung
├── wrangler.jsonc         D1-Binding, Assets, Custom-Domain-Route
├── package.json
├── .github/workflows/
│   └── deploy.yml         Deploy bei Push auf main
└── public/
    ├── index.html          Übersicht
    ├── admin.html          Parameter verwalten
    ├── log.html            Generischer Log-Eintrag
    ├── parameter.html      Detail-Chart pro Parameter
    ├── eve-data.html       Eve-Weather-Upload + Charts
    ├── uploader.html       Manueller/Eve-/Skoda-Upload
    └── assets/
        ├── style.css
        └── db.js           D1-Client (ruft same-origin /api/query auf)
```
