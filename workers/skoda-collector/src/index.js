/**
 * Worker «skoda-collector»: Škoda Enyaq → D1-Datenbank «car», Tabelle skoda_collector_tbl (Ersatz für den NAS-Collector «skoda-enyaq-collector»).
 *
 * Alle 10 Minuten ein Aufruf der MyŠkoda Public API (6 von 20 erlaubten Aufrufen/Stunde). Der NAS-Collector braucht
 * dasselbe Kontingent (12/h) → am besten stoppen (COLLECT_ENABLED siehe wrangler.jsonc).
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

export function mapVehicle(root, headers) {
  const v = root.vehicle ?? root;   // die API verpackt alles unter «vehicle»
  const st = v.charging?.status || {};
  const meters = num(pick(st, 'battery.remainingCruisingRangeInMeters', 'remainingCruisingRangeInMeters'));
  const reset = headers.get('X-API-Key-Expires-At');
  return {
    charging_captured_at_utc: sql(pick(v, 'charging.carCapturedTimestamp')),
    status_captured_at_utc: sql(pick(v, 'status.carCapturedTimestamp', 'odometer.carCapturedTimestamp')),
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

// force = manueller Lauf: ignoriert COLLECT_ENABLED, hält aber den Mindestabstand ein (Škoda: nie schneller als alle 180 s)
async function collect(env, { force = false } = {}) {
  if (!force && env.COLLECT_ENABLED !== '1') { console.log('Collector deaktiviert (COLLECT_ENABLED != 1)'); return { ok: false, skipped: 'COLLECT_ENABLED != 1' }; }
  if (!env.SKODA_API_KEY) throw new Error('Secret SKODA_API_KEY fehlt');

  if (force) {
    const last = await env.DB.prepare('SELECT collected_at_utc AS t FROM skoda_collector_tbl ORDER BY id DESC LIMIT 1').first();
    const age = last ? (Date.now() - Date.parse(last.t.replace(' ', 'T') + 'Z')) / 1000 : Infinity;
    if (age < 180) return { ok: false, skipped: `letzter Abruf vor ${Math.round(age)} s – Mindestabstand 180 s (API-Limit)` };
  }

  const r = await fetch(`${BASE}/api/v1/vehicles/${encodeURIComponent(env.SKODA_VIN)}?include=charging,odometer,parkingPosition,status`, {
    headers: { 'X-API-Key': env.SKODA_API_KEY },
    signal: AbortSignal.timeout(20000),
  });
  const remaining = num(r.headers.get('RateLimit-Remaining'));
  if (!r.ok) {
    const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    console.error(`Škoda API ${r.status}`, body, 'remaining', remaining);
    return { ok: false, apiStatus: r.status, apiBody: body, rateLimitRemaining: remaining };   // kein Retry – nächster Lauf in 10 min (Limit schonen)
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
  return { ok: true, collected_at_utc: now, soc_percent: m.soc_percent, range_km: m.range_km, charging_state: m.charging_state,
           address: m.address, rateLimitRemaining: remaining };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(collect(env)); },

  // Manuell auslösen:  https://<worker>.workers.dev/run?token=<RUN_TOKEN>
  // Nur mit dem Secret RUN_TOKEN (Variablen → Secret anlegen, frei wählbarer langer Text). Ohne Secret ist der Auslöser aus.
  // Hält den Mindestabstand von 180 s ein, damit auch ein geleaktes Token das API-Limit nicht verbrauchen kann.
  async fetch(request, env) {
    const url = new URL(request.url);
    const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    if (url.pathname !== '/run') return json({ error: 'nicht gefunden' }, 404);
    if (!env.RUN_TOKEN || url.searchParams.get('token') !== env.RUN_TOKEN) return json({ error: 'Token fehlt oder falsch' }, 401);
    try { return json(await collect(env, { force: true })); }
    catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
  },
};
