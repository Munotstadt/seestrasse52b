// Seite «Car» online: liest skoda_collector_tbl aus der D1-Datenbank «car» (Binding CAR; gefüllt vom Worker «skoda_collector»).
// Spaltennamen = MariaDB-Tabelle auf dem NAS → die lokale Version kann später mit denselben Abfragen auf D1 umgestellt werden.
import { num, toIso, sqlTime, dayPrefix } from './util.js';

export function mapCar(r) {
  const power = num(r.charge_power_kw);
  return {
    collectedAt: toIso(r.collected_at_utc),
    reportedAt: toIso(r.charging_captured_at_utc || r.status_captured_at_utc || r.collected_at_utc),
    soc: num(r.soc_percent),
    rangeKm: num(r.range_km),
    plugged: r.plug_connection_state ? r.plug_connection_state === 'CONNECTED' : null,
    chargingState: r.charging_state || null,
    charging: r.charging_state === 'CHARGING' || (power != null && power > 0),
    powerKw: power,
    targetSoc: num(r.target_soc_percent),
    minutesToFull: num(r.remaining_minutes_to_full),
    address: r.address || null,
    parking: r.parking_state || null,
    rateLimitRemaining: num(r.rate_limit_remaining),
    apiKeyExpiresAt: toIso(r.api_key_expires_at_utc),
  };
}

const need = env => { if (!env.CAR) { const e = new Error('Datenbank «car» nicht verbunden (Binding CAR)'); e.status = 503; throw e; } };

export async function carStatus(env) {
  need(env);
  const row = await env.CAR.prepare(
    `SELECT collected_at_utc, charging_captured_at_utc, status_captured_at_utc,
            soc_percent, range_km, charge_power_kw, charging_state, plug_connection_state,
            target_soc_percent, remaining_minutes_to_full, address, parking_state,
            rate_limit_remaining, api_key_expires_at_utc
       FROM skoda_collector_tbl WHERE soc_percent IS NOT NULL
      ORDER BY collected_at_utc DESC LIMIT 1`).first();
  if (!row) { const e = new Error('Noch keine Fahrzeugdaten in D1 (Collector aktiv?)'); e.status = 404; throw e; }
  // online nur Anzeige: Steuerung/Aufträge gibt es nur lokal
  return { ...mapCar(row), control: { enabled: false, rateLimitRemaining: null, minBudget: 0, keyExpiresAt: null }, jobs: [], pendingTarget: null };
}

export async function carSeries(env, range) {
  need(env);
  const week = range === '7d';
  const bucketSec = week ? 3600 : 600;
  const since = Date.now() - (week ? 168 : 24) * 3600e3;
  const { results } = await env.CAR.prepare(
    `SELECT (CAST(strftime('%s', collected_at_utc) AS INTEGER) / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS b,
            AVG(soc_percent) AS sa, MIN(soc_percent) AS sl, MAX(soc_percent) AS sh,
            AVG(range_km) AS ra, MIN(range_km) AS rl, MAX(range_km) AS rh
       FROM skoda_collector_tbl
      WHERE collected_at_utc >= ?2 AND datetime(collected_at_utc) >= datetime(?3) AND soc_percent IS NOT NULL
      GROUP BY b ORDER BY b`).bind(bucketSec, dayPrefix(since), sqlTime(since)).all();
  const r1 = v => Math.round(v * 10) / 10;
  const t = b => new Date(b * 1000).toISOString();
  return {
    soc: results.map(x => ({ t: t(x.b), avg: r1(x.sa), min: x.sl, max: x.sh })),
    range: results.filter(x => x.ra != null).map(x => ({ t: t(x.b), avg: r1(x.ra), min: x.rl, max: x.rh })),
  };
}
