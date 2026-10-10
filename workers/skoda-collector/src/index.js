/**
 * Worker «skoda-collector»: Škoda Enyaq → D1-Datenbank «car», Tabelle skoda_collector_tbl (Ersatz für den NAS-Collector «skoda-enyaq-collector»).
 *
 * Alle 5 Minuten ein Aufruf der MyŠkoda Public API (12 von 20 erlaubten Aufrufen/Stunde). Der NAS-Collector braucht
 * dasselbe Kontingent → nie beide gleichzeitig laufen lassen (COLLECT_ENABLED siehe wrangler.jsonc).
 *
 * Das Mapping der API-Antwort auf Spalten ist bewusst tolerant (mehrere mögliche Feldpfade); die letzte Rohantwort
 * liegt in skoda_collector_raw. Weicht ein Feld ab, genügt es, pick(...) unten anzupassen.
 */
const BASE = 'https://public.api.connect.skoda-auto.cz';

const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const pick = (o, ...paths) => { for (const p of paths) { const v = get(o, p); if (v !== undefined && v !== null && v !== '') return v; } return null; };
const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const sql = s => (s ? new Date(s).toISOString().slice(0, 19).replace('T', ' ') : null);

function addressOf(v) {
  const pp = v.parkingPosition || {};
  const a = pp.address || pp.parkingPosition?.address || null;
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') {
    return [[a.street, a.houseNumber].filter(Boolean).join(' '), [a.zipCode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
  }
  return pick(pp, 'formattedAddress', 'parkingPosition.formattedAddress');
}

export function mapVehicle(v, headers) {
  const st = v.charging?.status || {};
  const meters = num(pick(st, 'battery.remainingCruisingRangeInMeters', 'remainingCruisingRangeInMeters'));
  const reset = headers.get('X-API-Key-Expires-At');
  return {
    charging_captured_at_utc: sql(pick(st, 'carCapturedTimestamp')),
    status_captured_at_utc: sql(pick(v, 'status.carCapturedTimestamp', 'status.overall.carCapturedTimestamp')),
    soc_percent: num(pick(st, 'battery.stateOfChargeInPercent', 'stateOfChargeInPercent')),
    range_km: meters == null ? null : Math.round(meters / 100) / 10,
    charge_power_kw: num(pick(st, 'chargePowerInKw')),
    charging_state: pick(st, 'state'),
    plug_connection_state: pick(st, 'plugConnectionState'),
    target_soc_percent: num(pick(v, 'charging.settings.targetStateOfChargeInPercent')),
    remaining_minutes_to_full: num(pick(st, 'remainingTimeToFullyChargedInMinutes', 'remainingToCompleteInMinutes')),
    odometer_km: num(pick(v, 'odometer.mileageInKm')),
    address: addressOf(v),
    parking_state: pick(v, 'parkingPosition.state') ?? (v.parkingPosition ? 'PARKED' : null),
    api_key_expires_at_utc: reset ? sql(reset) : null,
  };
}

async function collect(env) {
  if (env.COLLECT_ENABLED !== '1') { console.log('Collector deaktiviert (COLLECT_ENABLED != 1)'); return; }
  if (!env.SKODA_API_KEY) throw new Error('Secret SKODA_API_KEY fehlt');

  const r = await fetch(`${BASE}/api/v1/vehicles/${encodeURIComponent(env.SKODA_VIN)}?include=charging,odometer,parkingPosition,status`, {
    headers: { 'X-API-Key': env.SKODA_API_KEY },
    signal: AbortSignal.timeout(20000),
  });
  const remaining = num(r.headers.get('RateLimit-Remaining'));
  if (!r.ok) {
    console.error(`Škoda API ${r.status}`, (await r.text().catch(() => '')).slice(0, 200), 'remaining', remaining);
    return;   // kein Retry in derselben Minute – das nächste Intervall kommt in 5 min (Limit schonen)
  }
  const v = await r.json();
  const m = mapVehicle(v, r.headers);
  const now = sql(Date.now());

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO skoda_collector_tbl
        (collected_at_utc, charging_captured_at_utc, status_captured_at_utc, soc_percent, range_km, charge_power_kw,
         charging_state, plug_connection_state, target_soc_percent, remaining_minutes_to_full, odometer_km,
         address, parking_state, rate_limit_remaining, api_key_expires_at_utc)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      now, m.charging_captured_at_utc, m.status_captured_at_utc, m.soc_percent, m.range_km, m.charge_power_kw,
      m.charging_state, m.plug_connection_state, m.target_soc_percent, m.remaining_minutes_to_full, m.odometer_km,
      m.address, m.parking_state, remaining, m.api_key_expires_at_utc),
    env.DB.prepare(`INSERT INTO skoda_collector_raw (id, collected_at_utc, raw_json) VALUES (1, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET collected_at_utc = excluded.collected_at_utc, raw_json = excluded.raw_json`)
      .bind(now, JSON.stringify(v)),
  ]);
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(collect(env)); },
  // Kein HTTP-Auslöser: ein Aufruf von aussen würde das knappe API-Limit (20/h) verbrauchen
  async fetch() { return new Response('skoda-enyaq-collector-d1: nur per Cron', { status: 404 }); },
};
