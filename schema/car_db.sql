-- Datenbank «car» (D1): Škoda Enyaq, befüllt vom Worker «skoda-collector»
--   npx wrangler d1 execute car --remote --file=schema/car_db.sql        (macht install.ps1)
-- Bestehende Datenbank nachrüsten:  ALTER TABLE skoda_collector_tbl ADD COLUMN last_seen_utc TEXT;  UPDATE skoda_collector_tbl SET last_seen_utc = collected_at_utc WHERE last_seen_utc IS NULL;
-- Spaltennamen = MariaDB-Tabelle skoda_enyaq_api auf dem NAS → die lokale Version kann später dieselben Abfragen nutzen.
CREATE TABLE IF NOT EXISTS skoda_collector_tbl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collected_at_utc TEXT NOT NULL,            -- 'YYYY-MM-DD HH:MM:SS' (UTC): Beginn des Zustands (erster Abruf, z. B. Ankunft)
  last_seen_utc TEXT,                        -- letzter Abruf mit demselben Zustand (Standzeit = last_seen_utc − collected_at_utc)
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
CREATE INDEX IF NOT EXISTS idx_skoda_collected ON skoda_collector_tbl(collected_at_utc);

-- Letzte Rohantwort der API (1 Zeile). So lässt sich das Spalten-Mapping korrigieren, ohne neu abzufragen
-- (Limit: 20 Aufrufe/Stunde). Enthält VIN/Kennzeichen und wird vom Dashboard nie ausgelesen.
CREATE TABLE IF NOT EXISTS skoda_collector_raw (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  collected_at_utc TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

-- Fahrtenstatistik aus MyŠkoda (CSV-Export, einmaliger Import 21.04.–10.10.2026); Zeiten in UTC
CREATE TABLE IF NOT EXISTS skoda_trips_tbl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_utc TEXT NOT NULL UNIQUE,            -- 'YYYY-MM-DD HH:MM:SS' (UTC), aus MyŠkoda-Fahrtenstatistik (lokale Zeit nach UTC umgerechnet)
  end_utc TEXT,
  classification TEXT,
  start_address TEXT, end_address TEXT,
  start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
  distance_km REAL,
  start_odometer_km REAL, end_odometer_km REAL,
  driving_minutes REAL, travel_minutes REAL,
  avg_speed_kmh REAL,
  consumption_kwh REAL, consumption_kwh_per_100km REAL,
  start_soc_percent REAL, end_soc_percent REAL,
  start_range_km REAL, end_range_km REAL,   -- Reichweite bei Start/Ende (nicht im CSV-Export, daher fuer Altdaten NULL)
  public_charging_stops INTEGER, public_charge_soc_gained_percent REAL,
  short_trip INTEGER                         -- 1 = kurze Fahrt
);
CREATE INDEX IF NOT EXISTS idx_skoda_trips_end ON skoda_trips_tbl(end_utc);
