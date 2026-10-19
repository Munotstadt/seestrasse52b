// Seite «Temperatur» online:
//   Innen  → seestrasse52b_values (Shelly H&T Gen3 via MQTT-Logger), D1 «seestrasse52b»   (/dash/api/latest, /dash/api/series)
//   Aussen → meteo_klo_* in D1 «meteo»                                                      (/dash/api/outdoor/*)
// Antwortformate sind identisch zu dash-local/server.js bzw. dem Sensor-Container.
import { r1, num, ms, toIso, dayPrefix, sqlTime } from './util.js';

// Sensor → Parameter-IDs in seestrasse52b_parameter (temp / hum / bat; hum und bat optional). Neuen Sensor hier eintragen (und nur hier).
// 4 und 8 senden aktuell nicht mehr (Kachel zeigt dann «Updated: …» mit grauem Punkt).
export const SENSORS = [
  { id: 'eve-4',  temp: 4,  hum: 17 },
  { id: 'eve-7',  temp: 7,  hum: 18, bat: 26 },
  { id: 'eve-8',  temp: 8,  hum: 19 },
  { id: 'eve-9',  temp: 9,  hum: 20, bat: 27 },
  { id: 'eve-10', temp: 10, hum: 21, bat: 28 },
  { id: 'eve-11', temp: 11, hum: 22, bat: 25 },
  { id: 'eve-29', temp: 29 },
];
const paramsOf = s => [s.temp, s.hum, s.bat].filter(x => x != null);
const PARAM_IDS = SENSORS.flatMap(paramsOf);
const TEMP_IDS = SENSORS.map(s => s.temp);
const IN = PARAM_IDS.join(',');

// «Wohnzimmer (Temp)» / «Wohnzimmer Temperatur» → «Wohnzimmer»
const roomName = p => String(p?.Label || p?.Name || '').replace(/\s*[\[(]?\s*(temp(eratur)?\.?|luftf(euchtigkeit|\.)?|humidity)\s*[\])]?\s*$/i, '').trim();

export async function innerLatest(env) {
  const since = dayPrefix(Date.now() - 2 * 86400e3);
  // 1 Round-Trip: Namen, letzte 2 Tage (für Min/Max 24 h), letzter Wert je Parameter (falls Sensor länger still)
  const [names, recent, ...lasts] = await env.DB.batch([
    env.DB.prepare(`SELECT ParameterID, Name, Label FROM seestrasse52b_parameter WHERE ParameterID IN (${IN})`),
    env.DB.prepare(`SELECT ParameterID AS p, date AS d, value AS v FROM seestrasse52b_values
                     WHERE date >= ? AND ParameterID IN (${TEMP_IDS.join(',')}) ORDER BY date LIMIT 20000`).bind(since),
    ...PARAM_IDS.map(id => env.DB.prepare(
      `SELECT ParameterID AS p, date AS d, value AS v FROM seestrasse52b_values WHERE ParameterID = ? ORDER BY date DESC LIMIT 1`).bind(id)),
  ]);
  const nm = new Map((names.results || []).map(r => [r.ParameterID, r]));
  const rows = recent.results || [];
  const last = new Map(lasts.map(r => r.results?.[0]).filter(Boolean).map(r => [r.p, r]));
  const cut = Date.now() - 24 * 3600e3;

  return SENSORS.map(s => {
    const mine = id => rows.filter(r => r.p === id && ms(r.d) >= cut).map(r => num(r.v)).filter(v => v != null);
    const t = last.get(s.temp), h = last.get(s.hum), bt = last.get(s.bat);
    const t24 = mine(s.temp);
    return {
      id: s.id, name: roomName(nm.get(s.temp)) || s.id, kind: 'shelly',
      date: toIso(t?.d || h?.d), temp: r1(num(t?.v)), hum: r1(num(h?.v)), battery: r1(num(bt?.v)),
      temp_min24: t24.length ? r1(Math.min(...t24)) : null,
      temp_max24: t24.length ? r1(Math.max(...t24)) : null,
    };
  });
}

const RANGE = { '24h': { hours: 24, bucket: 1800e3 }, '7d': { hours: 168, bucket: 10800e3 }, '30d': { hours: 720, bucket: 43200e3 }, '1y': { hours: 8760, bucket: 86400e3 } };

function bucketize(rows, bucketMs) {
  const g = new Map();
  for (const r of rows) {
    const v = num(r.v), t = ms(r.d);
    if (v == null || !Number.isFinite(t)) continue;
    const k = Math.floor(t / bucketMs) * bucketMs;
    const a = g.get(k) || { s: 0, n: 0, lo: Infinity, hi: -Infinity };
    a.s += v; a.n++; a.lo = Math.min(a.lo, v); a.hi = Math.max(a.hi, v);
    g.set(k, a);
  }
  return [...g.keys()].sort((a, b) => a - b).map(k => {
    const a = g.get(k);
    return { t: new Date(k).toISOString(), avg: r1(a.s / a.n), min: r1(a.lo), max: r1(a.hi) };
  });
}

export async function innerSeries(env, sensorId, range) {
  const s = SENSORS.find(x => x.id === sensorId);
  if (!s) { const e = new Error('Sensor unbekannt'); e.status = 404; throw e; }
  const { hours, bucket } = RANGE[range] || RANGE['24h'];
  const since = Date.now() - hours * 3600e3;
  const { results } = await env.DB.prepare(
    `SELECT ParameterID AS p, date AS d, value AS v FROM seestrasse52b_values
      WHERE ParameterID IN (?, ?) AND date >= ? ORDER BY date LIMIT 40000`).bind(s.temp, s.hum ?? s.temp, dayPrefix(since)).all();
  const rows = (results || []).filter(r => ms(r.d) >= since - 43200e3);   // Datumsvergleich war grob → exakt nachfiltern
  return {
    temp: bucketize(rows.filter(r => r.p === s.temp), bucket),
    hum: s.hum == null ? [] : bucketize(rows.filter(r => r.p === s.hum), bucket),
  };
}

// ---------- Aussen Kloten (D1 «meteo») ----------
export async function outdoorLatest(env) {
  const since = sqlTime(Date.now() - 24 * 3600e3);
  const [lastR, aggR] = await env.METEO.batch([
    env.METEO.prepare(`SELECT obs_datetime_utc AS t, temp_c, humidity_pct FROM meteo_klo_frequently
                        WHERE temp_c IS NOT NULL ORDER BY obs_datetime_utc DESC LIMIT 1`),
    env.METEO.prepare(`SELECT MIN(temp_c) AS tmin, MAX(temp_c) AS tmax, SUM(precip_mm) AS precip,
                              SUM(sunshine_min) AS sun_min, COUNT(*) AS n
                         FROM meteo_klo_frequently WHERE obs_datetime_utc >= ?`).bind(since),
  ]);
  const last = lastR.results?.[0], a = aggR.results?.[0];
  if (!last) return { id: 'outdoor-klo', name: 'Aussen Kloten', kind: 'outdoor', date: null };
  return {
    id: 'outdoor-klo', name: 'Aussen Kloten', kind: 'outdoor',
    date: toIso(last.t), temp: r1(last.temp_c), hum: r1(last.humidity_pct),
    temp_min24: r1(a?.tmin), temp_max24: r1(a?.tmax),
    precip24: r1(a?.precip ?? 0), sun24_h: r1((a?.sun_min ?? 0) / 60), samples: a?.n ?? 0,
  };
}

const O_BUCKET = { '24h': 1800, '7d': 10800, '30d': 43200 };   // Sekunden

export async function outdoorSeries(env, range) {
  if (range === '1y') {
    const since = new Date(Date.now() - 365 * 86400e3).toISOString().slice(0, 10);
    const { results: rows } = await env.METEO.prepare(
      `SELECT obs_date AS d, temp_mean_c AS a, temp_min_c AS lo, temp_max_c AS hi, humidity_pct AS h
         FROM meteo_klo_daily WHERE obs_date >= ? ORDER BY obs_date`).bind(since).all();
    return {
      temp: rows.map(x => ({ t: x.d + 'T12:00:00Z', avg: r1(x.a), min: r1(x.lo), max: r1(x.hi) })),
      hum: rows.map(x => ({ t: x.d + 'T12:00:00Z', avg: r1(x.h), min: r1(x.h), max: r1(x.h) })),
    };
  }
  const sec = O_BUCKET[range] || O_BUCKET['24h'];
  const hours = { '24h': 24, '7d': 168, '30d': 720 }[range] || 24;
  const since = sqlTime(Date.now() - hours * 3600e3);
  const { results: rows } = await env.METEO.prepare(
    `SELECT datetime((CAST(strftime('%s', obs_datetime_utc) AS INTEGER) / ${sec}) * ${sec}, 'unixepoch') AS b,
            AVG(temp_c) AS ta, MIN(temp_c) AS tl, MAX(temp_c) AS th,
            AVG(humidity_pct) AS ha, MIN(humidity_pct) AS hl, MAX(humidity_pct) AS hh
       FROM meteo_klo_frequently WHERE obs_datetime_utc >= ?
      GROUP BY b ORDER BY b`).bind(since).all();
  const T = x => x.b.replace(' ', 'T') + 'Z';
  return {
    temp: rows.map(x => ({ t: T(x), avg: r1(x.ta), min: r1(x.tl), max: r1(x.th) })),
    hum: rows.map(x => ({ t: T(x), avg: r1(x.ha), min: r1(x.hl), max: r1(x.hh) })),
  };
}
