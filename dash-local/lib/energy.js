// Energy: liest vom Solar-Manager-Viewer (Container solarmanager-viewer, Port 8053).
//   GET /api/latest                    → letzte Messungen (W)
//   GET /api/day?from=ISO[&to=ISO]     → { energy:{pv_kwh,cons_kwh,import_kwh,export_kwh}, points:[{t,pv,cons,grid}] }
// Netz-Leistung: >0 Bezug, <0 Einspeisung. Fehlende Messwerte (null) werden ignoriert.
const BASE = (process.env.SOLAR_API_URL || '').replace(/\/+$/, '');
const TZ = 'Europe/Zurich';
export const energyEnabled = () => !!BASE;

async function get(path) {
  if (!BASE) throw new Error('SOLAR_API_URL nicht gesetzt');
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Solar viewer: ${j.error || r.status}`);
  return j;
}

// ---- Zeitrechnung in Zürcher Ortszeit (Tages-/Monats-/Jahresbeginn) ----
function offsetMs(utcMs) {            // Zürich-Offset (ms) zum gegebenen Zeitpunkt
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
export function zurichStart(kind, now = Date.now()) {   // 'day' | 'month' | 'year' → UTC-ms
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(now)).map(x => [x.type, Number(x.value)]));
  const m = kind === 'year' ? 1 : kind === 'month' ? p.month : p.month;
  const d = kind === 'day' ? p.day : 1;
  const local = Date.UTC(p.year, m - 1, d);
  let t = local - offsetMs(local);
  t = local - offsetMs(t);              // zweiter Durchgang bei Zeitumstellung
  return t;
}

const n = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const pct = (a, b) => (a == null || b == null || b <= 0 ? null : r1(Math.max(0, Math.min(100, a / b * 100))));

export function mapEnergy(e) {
  e = e || {};
  const pv = n(e.pv_kwh), cons = n(e.cons_kwh), imp = n(e.import_kwh), exp = n(e.export_kwh);
  return {
    consumption: r2(cons), production: r2(pv), fromGrid: r2(imp), toGrid: r2(exp),
    selfPct: pv != null && exp != null ? pct(pv - exp, pv) : null,        // Eigenverbrauchsanteil an der PV-Erzeugung
    autarkyPct: cons != null && imp != null ? pct(cons - imp, cons) : null, // Anteil des Verbrauchs aus eigener Erzeugung
  };
}

export async function energyLatest() {
  const d = await get('/api/latest');
  const rows = (d.rows || []).filter(r => r && r.t);
  const c = rows[0];
  if (!c) return null;
  const grid = n(c.grid);
  return {
    t: new Date(c.t).toISOString(),
    consumption: n(c.cons), production: n(c.pv),
    fromGrid: grid == null ? null : Math.max(0, grid),
    toGrid: grid == null ? null : Math.max(0, -grid),
  };
}

export async function energySummary(now = Date.now()) {
  const to = encodeURIComponent(new Date(now).toISOString());
  const one = async kind => {
    const from = encodeURIComponent(new Date(zurichStart(kind, now)).toISOString());
    const d = await get(`/api/day?from=${from}&to=${to}`);
    return mapEnergy(d.energy);
  };
  const [today, mtd, ytd] = await Promise.all([one('day'), one('month'), one('year')]);
  return { today, mtd, ytd };
}

// Punkte in 6-Minuten-Fenster verdichten (10 Punkte/h): Mittelwert je Grösse, null-Werte ignoriert
export const BUCKET_MS = 6 * 60e3;
export function bucket6(points, bucketMs = BUCKET_MS) {
  const g = new Map();
  for (const p of points || []) {
    const ms = Date.parse(p.t);
    if (!Number.isFinite(ms)) continue;
    const k = Math.floor(ms / bucketMs) * bucketMs;
    const a = g.get(k) || { pv: [0, 0], cons: [0, 0], grid: [0, 0] };
    for (const key of ['pv', 'cons', 'grid']) { const v = n(p[key]); if (v != null) { a[key][0] += v; a[key][1]++; } }
    g.set(k, a);
  }
  return [...g.keys()].sort((a, b) => a - b).map(k => {
    const a = g.get(k), avg = ([s, c]) => (c ? Math.round(s / c) : null);
    return { t: new Date(k).toISOString(), production: avg(a.pv), consumption: avg(a.cons), grid: avg(a.grid) };
  });
}

export async function energySeries(range, now = Date.now()) {
  const from = range === '7d' ? now - 7 * 86400e3 : range === '24h' ? now - 86400e3 : zurichStart('day', now);
  const d = await get(`/api/day?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(now).toISOString())}`);
  return { points: bucket6(d.points, range === '7d' ? 30 * 60e3 : BUCKET_MS) };   // 7 Tage: 30 min (identisch zur Online-Version)
}
