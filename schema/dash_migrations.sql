-- /dash: einmalig in D1 «seestrasse52b» ausführen (Škoda-Tabellen: siehe car_db.sql, eigene DB «car»)
--   npx wrangler d1 execute seestrasse52b --remote --file=schema/dash_migrations.sql

-- Schnellere Verläufe der Innensensoren (Temperatur-Seite): Abfrage nach Parameter + Zeitraum
CREATE INDEX IF NOT EXISTS idx_values_param_date ON seestrasse52b_values(ParameterID, date);
