-- /dash: einmalig in D1 «seestrasse52b» ausführen
--   npx wrangler d1 execute seestrasse52b --remote --file=schema/dash_migrations.sql

-- 1) Škoda Enyaq (befüllt vom Worker workers/skoda-collector). Spaltennamen = MariaDB-Tabelle skoda_enyaq_api auf dem NAS.
CREATE TABLE IF NOT EXISTS skoda_enyaq_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collected_at_utc TEXT NOT NULL,            -- 'YYYY-MM-DD HH:MM:SS' (UTC)
  charging_captured_at_utc TEXT,
  status_captured_at_utc TEXT,
  soc_percent REAL,
  range_km REAL,
  charge_power_kw REAL,
  charging_state TEXT,
  plug_connection_state TEXT,
  target_soc_percent REAL,
  remaining_minutes_to_full REAL,
  odometer_km REAL,
  address TEXT,
  parking_state TEXT,
  rate_limit_remaining INTEGER,
  api_key_expires_at_utc TEXT
);
CREATE INDEX IF NOT EXISTS idx_skoda_collected ON skoda_enyaq_api(collected_at_utc);

-- Letzte Rohantwort der API (1 Zeile). So lässt sich das Spalten-Mapping korrigieren, ohne neu abzufragen
-- (Limit: 20 Aufrufe/Stunde). Enthält VIN/Kennzeichen und wird vom Dashboard nie ausgelesen.
CREATE TABLE IF NOT EXISTS skoda_enyaq_raw (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  collected_at_utc TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

-- 2) Schnellere Verläufe der Innensensoren (Temperatur-Seite): Abfrage nach Parameter + Zeitraum
CREATE INDEX IF NOT EXISTS idx_values_param_date ON seestrasse52b_values(ParameterID, date);
