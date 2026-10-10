// Seite «Energy» online: D1 «energy» (Binding ENERGY), gefüllt vom Solar-Manager-Collector.
//   Live/Verlauf  → solarmanager_live_points (fetched_at UTC; W; grid > 0 = Bezug, < 0 = Einspeisung)
//   Tageswerte    → solarmanager_data (kWh je Zürcher Kalendertag; «heute» existiert dort erst ab Folgetag)
// Heute wird – wie beim lokalen Solar-Viewer – aus den Live-Punkten hochgerechnet (6-Minuten-Mittel × Dauer).
import { num, sqlTime, dayPrefix } from './util.js';

const TZ = 'Europe/Zurich';
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const pct = (a, b) => (a == null || b == null || b <= 0 ? null : r1(Math.max(0, Math.min(100, a / b * 100))));

// Identische Berechnung wie dash-local/lib/energy.js (mapEnergy)
function mapEnergy({ pv, cons, imp, exp }) {
  return {
    consumption: r2(cons), production: r2(pv), fromGrid: r2(imp), toGrid: r2(exp),
    selfPct: pv != null && exp != null ? pct(pv - exp, pv) : null,
    autarkyPct: cons != null && imp != null ? pct(cons - imp, cons) : null,
  };
}

// ---- Zürcher Ortszeit ----
const parts = (utcMs, opt) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', ...opt })
  .formatToParts(new Date(utcMs)).map(x => [x.type, Number(x.value)]));
function offsetMs(utcMs) {
  const p = parts(utcMs, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
export function zurichStart(kind, now = Date.now()) {   // 'day' | 'month' | 'year' → UTC-ms
  const p = parts(now, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const local = Date.UTC(p.year, kind === 'year' ? 0 : p.month - 1, kind === 'day' ? p.day : 1);
  let t = local - offsetMs(local);
  t = local - offsetMs(t);
  return t;
}
const zurichIso = ms => { const p = parts(ms, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };

// ---- Zeitfenster-Mittel direkt in SQL (nur wenige Zeilen verlassen D1). CAST nötig: D1 bindet JS-Zahlen als REAL → sonst Gleitkomma-Division ----
async function buckets(env, fromMs, bucketSec) {
  const { results } = await env.ENERGY.prepare(
    `SELECT (CAST(strftime('%s', fetched_at) AS INTEGER) / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS b,
            AVG(current_pv_generation) AS pv, AVG(current_power_consumption) AS cons, AVG(current_grid_power) AS grid
       FROM solarmanager_live_points
      WHERE fetched_at >= ?2 AND datetime(fetched_at) >= datetime(?3)
      GROUP BY b ORDER BY b`).bind(bucketSec, dayPrefix(fromMs), sqlTime(fromMs)).all();
  return results || [];
}

export async function energyLatest(env) {
  const { results } = await env.ENERGY.prepare(
    `SELECT fetched_at, current_pv_generation AS pv, current_power_consumption AS cons, current_grid_power AS grid
       FROM solarmanager_live_points ORDER BY fetched_at DESC LIMIT 1`).all();
  const c = results?.[0];
  if (!c) return null;
  const grid = num(c.grid);
  const t = String(c.fetched_at).replace(' ', 'T');
  return {
    t: new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : t + 'Z').toISOString(),
    consumption: num(c.cons), production: num(c.pv),
    fromGrid: grid == null ? null : Math.max(0, grid),
    toGrid: grid == null ? null : Math.max(0, -grid),
  };
}

// kWh aus 6-Minuten-Leistungsmitteln (W)
function integrate(rows, bucketSec = 360) {
  const h = bucketSec / 3600 / 1000;   // W · h → kWh
  let pv = 0, cons = 0, imp = 0, exp = 0;
  for (const r of rows) {
    pv += (num(r.pv) ?? 0) * h; cons += (num(r.cons) ?? 0) * h;
    const g = num(r.grid) ?? 0;
    if (g > 0) imp += g * h; else exp += -g * h;
  }
  return { pv, cons, imp, exp };
}

export async function energySummary(env, now = Date.now()) {
  const dayStart = zurichStart('day', now), monthStart = zurichStart('month', now), yearStart = zurichStart('year', now);
  const today = zurichIso(now);
  const [pts, daily] = await Promise.all([
    buckets(env, dayStart, 360),
    env.ENERGY.prepare(
      `SELECT Date_ISO AS d, Consumption_kWh AS cons, Production_kWh AS pv, GridFrom_kWh AS imp, GridTo_kWh AS exp
         FROM solarmanager_data WHERE Date_ISO >= ? AND Date_ISO < ?`).bind(zurichIso(yearStart), today).all(),
  ]);
  const t = integrate(pts);
  const sum = fromIso => {
    const a = { ...t };
    for (const r of daily.results || []) if (r.d >= fromIso) {
      a.pv += num(r.pv) ?? 0; a.cons += num(r.cons) ?? 0; a.imp += num(r.imp) ?? 0; a.exp += num(r.exp) ?? 0;
    }
    return a;
  };
  return {
    today: mapEnergy(t),
    mtd: mapEnergy(sum(zurichIso(monthStart))),
    ytd: mapEnergy(sum(zurichIso(yearStart))),
  };
}

export async function energySeries(env, range, now = Date.now()) {
  const from = range === '7d' ? now - 7 * 86400e3 : range === '24h' ? now - 86400e3 : zurichStart('day', now);
  const bucketSec = range === '7d' ? 1800 : 360;   // 7 Tage: 30 min (identisch zu dash-local/lib/energy.js)
  const rows = await buckets(env, from, bucketSec);
  const avg = v => (v == null ? null : Math.round(v));
  return {
    points: rows.map(r => ({ t: new Date(r.b * 1000).toISOString(), production: avg(r.pv), consumption: avg(r.cons), grid: avg(r.grid) })),
  };
}
