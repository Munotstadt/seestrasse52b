// Škoda Enyaq: liest den letzten Datensatz aus MariaDB (Tabelle skoda_enyaq_api, vom skoda-enyaq-collector gefüllt).
// Es werden nur die nötigen Spalten gelesen – raw_json (enthält u. a. VIN/Kennzeichen) verlässt die Datenbank nie.
import mysql from 'mysql2/promise';

let pool;
function getPool() {
  const { DB_HOST, DB_USER } = process.env;
  if (!DB_HOST || !DB_USER) throw new Error('DB_HOST / DB_USER / DB_PASSWORD nicht gesetzt');
  pool ??= mysql.createPool({
    host: DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '52b_seestrasse_logger',
    dateStrings: true,        // DATETIME als Text (UTC) statt Date-Objekt
    connectionLimit: 2,
    connectTimeout: 8000,
  });
  return pool;
}

const iso = s => (s ? String(s).replace(' ', 'T') + 'Z' : null);   // DB speichert UTC ohne Suffix
const num = v => (v == null ? null : Number(v));

export function mapCar(r) {
  const power = num(r.charge_power_kw);
  return {
    collectedAt: iso(r.collected_at_utc),
    reportedAt: iso(r.charging_captured_at_utc || r.status_captured_at_utc || r.collected_at_utc),
    soc: num(r.soc_percent),
    rangeKm: num(r.range_km),
    odometerKm: num(r.odometer_km),
    plugged: r.plug_connection_state ? r.plug_connection_state === 'CONNECTED' : null,
    chargingState: r.charging_state || null,
    charging: r.charging_state === 'CHARGING' || (power != null && power > 0),
    powerKw: power,
    targetSoc: num(r.target_soc_percent),
    minutesToFull: num(r.remaining_minutes_to_full),
    address: r.address || null,
    parking: r.parking_state || null,
    rateLimitRemaining: num(r.rate_limit_remaining),
    apiKeyExpiresAt: iso(r.api_key_expires_at_utc),
  };
}

export async function carStatus() {
  const [rows] = await getPool().query(
    `SELECT collected_at_utc, charging_captured_at_utc, status_captured_at_utc,
            soc_percent, range_km, charge_power_kw, charging_state, plug_connection_state,
            target_soc_percent, remaining_minutes_to_full, odometer_km, address, parking_state,
            rate_limit_remaining, api_key_expires_at_utc
       FROM skoda_enyaq_api
      WHERE soc_percent IS NOT NULL
      ORDER BY collected_at_utc DESC LIMIT 1`);
  return rows[0] ? mapCar(rows[0]) : null;
}

// Verbleibende API-Aufrufe der aktuellen Stunde (letzte Abfrage des Collectors) – Grundlage für den Limit-Schutz
export async function latestRateLimit() {
  const [rows] = await getPool().query(
    `SELECT rate_limit_remaining FROM skoda_enyaq_api
      WHERE rate_limit_remaining IS NOT NULL ORDER BY collected_at_utc DESC LIMIT 1`);
  return rows[0] ? Number(rows[0].rate_limit_remaining) : null;
}

// Verlauf: DB-Zeilen (Collector alle ~5 min) in gleich grosse Zeitfenster verdichten (Mittel/Min/Max)
const r1 = v => Math.round(v * 10) / 10;
export function bucketSeries(rows, bucketMs) {
  const groups = new Map();
  for (const r of rows) {
    const ms = Date.parse(String(r.t).replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ms)) continue;
    const key = Math.floor(ms / bucketMs) * bucketMs;
    const g = groups.get(key) || { soc: [], rng: [], odo: [] };
    if (r.soc != null) g.soc.push(Number(r.soc));
    if (r.rng != null) g.rng.push(Number(r.rng));
    if (r.odo != null) g.odo.push(Number(r.odo));
    groups.set(key, g);
  }
  const agg = (vals, key) => vals.length
    ? { t: new Date(key).toISOString(), avg: r1(vals.reduce((a, b) => a + b, 0) / vals.length), min: Math.min(...vals), max: Math.max(...vals) }
    : null;
  const keys = [...groups.keys()].sort((a, b) => a - b);
  return {
    soc: keys.map(k => agg(groups.get(k).soc, k)).filter(Boolean),
    range: keys.map(k => agg(groups.get(k).rng, k)).filter(Boolean),
    odometer: keys.map(k => agg(groups.get(k).odo, k)).filter(Boolean),
  };
}

export async function carSeries(range) {
  const hours = { '24h': 24, '7d': 168, '30d': 720 }[range] || 24;
  const since = new Date(Date.now() - hours * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  const [rows] = await getPool().query(
    `SELECT collected_at_utc AS t, soc_percent AS soc, range_km AS rng, odometer_km AS odo
       FROM skoda_enyaq_api
      WHERE collected_at_utc >= ? AND soc_percent IS NOT NULL
      ORDER BY collected_at_utc`, [since]);
  return bucketSeries(rows, { '24h': 600e3, '7d': 3600e3, '30d': 21600e3 }[range] || 600e3);   // 24 h: 10 min, 7 Tage: 1 h, 30 Tage: 6 h
}
