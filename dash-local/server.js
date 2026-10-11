// Dashboard Seestrasse 52b (LOKAL, NAS) – schlanker Server (Node >= 20)
//  Gleiche URL-Struktur wie online (52b.munot.app/dash):  /dash/…  und  /dash/api/…
//  Das UI (public/dash) ist dieselbe Dateien-Sammlung wie online – nur dieses Backend und config.js unterscheiden sich.
//  - liefert public/dash unter /dash/ aus (gzip/brotli, Cache-Header wie online)
//  - /api/outdoor/*  → liest Kloten-Messwerte aus Cloudflare D1 (Token bleibt serverseitig)
//  - /api/water/*   → Wasserpumpe (myStrom Switch) schalten, Laufzeit/Countdown serverseitig
//  - /api/car/*     → Škoda Enyaq: Status aus MariaDB (skoda_enyaq_api), Befehle über die MyŠkoda Public API
//  - alle übrigen /api/* → Proxy auf den bestehenden Sensor-Container (SENSOR_API_URL)
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { carStatus, carSeries, latestRateLimit } from './lib/car.js';
import { energyLatest, energySummary, energySeries } from './lib/energy.js';
import { wiserList, wiserCommand, WiserError } from './lib/wiser.js';
import { skodaEnabled } from './lib/skoda.js';
import * as carctl from './lib/carcontrol.js';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');   // enthält dash/
const SENSOR_API_URL = (process.env.SENSOR_API_URL || '').replace(/\/+$/, '');
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '';
const METEO_DB = process.env.CF_D1_METEO_ID || '17e827ee-3f96-4ce9-b93c-be3cea624448';

// ---------- Umgebungs-Konfiguration fürs UI (online-Gegenstück: src/dash/index.js → CONFIG) ----------
// pages: "live" = aktiv, "pending" = Reiter ausgegraut.  control: Bedienelemente einblenden.
const CONFIG = {
  mode: 'local',
  pages: { temperatur: 'live', water: 'live', storen: 'live', energy: 'live', car: 'live' },
  control: { water: true, blinds: true, car: true },
};
const CONFIG_JS = `export default ${JSON.stringify(CONFIG)};\n`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// ---------- D1 ----------
async function d1(sql, params = []) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) throw new Error('CF_ACCOUNT_ID / CF_API_TOKEN nicht gesetzt');
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${METEO_DB}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15000),
    });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`D1: ${j.errors?.[0]?.message || r.status}`);
  return j.result?.[0]?.results ?? [];
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { exp: Date.now() + ttlMs, val });
  return val;
}

const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const iso = s => (s ? s + 'Z' : null);   // D1 speichert UTC ohne Suffix

// ---------- Aussen Kloten ----------
async function outdoorLatest() {
  const [last] = await d1(
    `SELECT obs_datetime_utc AS t, temp_c, humidity_pct
       FROM meteo_klo_frequently WHERE temp_c IS NOT NULL
      ORDER BY obs_datetime_utc DESC LIMIT 1`);
  if (!last) return { id: 'outdoor-klo', name: 'Aussen Kloten', kind: 'outdoor', date: null };
  const since = new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 19);
  const [a] = await d1(
    `SELECT MIN(temp_c) AS tmin, MAX(temp_c) AS tmax,
            SUM(precip_mm) AS precip, SUM(sunshine_min) AS sun_min, COUNT(*) AS n
       FROM meteo_klo_frequently WHERE obs_datetime_utc >= ?`, [since]);
  return {
    id: 'outdoor-klo', name: 'Aussen Kloten', kind: 'outdoor',
    date: iso(last.t), temp: r1(last.temp_c), hum: r1(last.humidity_pct),
    temp_min24: r1(a?.tmin), temp_max24: r1(a?.tmax),
    precip24: r1(a?.precip ?? 0), sun24_h: r1((a?.sun_min ?? 0) / 60), samples: a?.n ?? 0,
  };
}

const BUCKET = { '24h': 1800, '7d': 10800, '30d': 43200 };   // Sekunden

async function outdoorSeries(range) {
  if (range === '1y') {
    const since = new Date(Date.now() - 365 * 86400e3).toISOString().slice(0, 10);
    const rows = await d1(
      `SELECT obs_date AS d, temp_mean_c AS a, temp_min_c AS lo, temp_max_c AS hi, humidity_pct AS h
         FROM meteo_klo_daily WHERE obs_date >= ? ORDER BY obs_date`, [since]);
    return {
      temp: rows.map(x => ({ t: x.d + 'T12:00:00Z', avg: r1(x.a), min: r1(x.lo), max: r1(x.hi) })),
      hum: rows.map(x => ({ t: x.d + 'T12:00:00Z', avg: r1(x.h), min: r1(x.h), max: r1(x.h) })),
    };
  }
  const sec = BUCKET[range] || BUCKET['24h'];
  const hours = { '24h': 24, '7d': 168, '30d': 720 }[range] || 24;
  const since = new Date(Date.now() - hours * 3600e3).toISOString().slice(0, 19);
  const rows = await d1(
    `SELECT datetime((CAST(strftime('%s', obs_datetime_utc) AS INTEGER) / ${sec}) * ${sec}, 'unixepoch') AS b,
            AVG(temp_c) AS ta, MIN(temp_c) AS tl, MAX(temp_c) AS th,
            AVG(humidity_pct) AS ha, MIN(humidity_pct) AS hl, MAX(humidity_pct) AS hh
       FROM meteo_klo_frequently WHERE obs_datetime_utc >= ?
      GROUP BY b ORDER BY b`, [since]);
  const T = x => x.b.replace(' ', 'T') + 'Z';
  return {
    temp: rows.map(x => ({ t: T(x), avg: r1(x.ta), min: r1(x.tl), max: r1(x.th) })),
    hum: rows.map(x => ({ t: T(x), avg: r1(x.ha), min: r1(x.hl), max: r1(x.hh) })),
  };
}

// ---------- Wasserpumpe (myStrom) ----------
// Der Countdown läuft hier im Container (nicht im Browser) und überlebt Neustarts (Zustand in DATA_DIR).
const WATER_HOST = process.env.wasserpumpe || process.env.WASSERPUMPE || '';
const DATA_DIR = process.env.DATA_DIR || join(fileURLToPath(new URL('.', import.meta.url)), 'data');
const WATER_FILE = join(DATA_DIR, 'water.json');
const WATER_MAX_MIN = 240;
let waterOffAt = null, waterMinutes = null, waterTimer = null;

async function waterSave() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(WATER_FILE, JSON.stringify({ offAt: waterOffAt, minutes: waterMinutes }));
  } catch (e) { console.error('Wasser-Zustand nicht gespeichert:', e.message); }
}

async function pump(path) {
  if (!WATER_HOST) throw new Error('Umgebungsvariable "wasserpumpe" nicht gesetzt');
  const r = await fetch(`http://${WATER_HOST}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('myStrom HTTP ' + r.status);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return {}; }
}

function waterArm() {
  clearTimeout(waterTimer); waterTimer = null;
  if (!waterOffAt) return;
  waterTimer = setTimeout(waterExpire, Math.max(0, waterOffAt - Date.now()));
}

async function waterExpire() {
  try {
    await pump('/relay?state=0');
    waterOffAt = null; waterMinutes = null; waterTimer = null;
    await waterSave();
    console.log('Wasserpumpe: Laufzeit abgelaufen, ausgeschaltet');
  } catch (e) {
    console.error('Wasserpumpe ausschalten fehlgeschlagen, neuer Versuch in 10 s:', e.message);
    waterTimer = setTimeout(waterExpire, 10000);
  }
}

async function waterLoad() {
  try {
    const j = JSON.parse(await readFile(WATER_FILE, 'utf8'));
    const off = Number(j.offAt);
    if (off && off < Date.now() + (WATER_MAX_MIN + 5) * 60e3) { waterOffAt = off; waterMinutes = Number(j.minutes) || null; }
  } catch { /* noch kein Zustand */ }
  waterArm();   // abgelaufene Timer schalten sofort aus
}

async function waterStatus() {
  let rep = null, error = null;
  try { rep = await pump('/report'); } catch (e) { error = e.message; }
  if (rep && rep.relay === false && waterOffAt) {   // extern ausgeschaltet → Timer hinfällig
    waterOffAt = null; waterMinutes = null; waterArm(); await waterSave();
  }
  return {
    online: !!rep, error,
    relay: rep ? !!rep.relay : null,
    power: rep && rep.power != null ? Math.round(rep.power * 10) / 10 : null,
    offAt: waterOffAt ? new Date(waterOffAt).toISOString() : null,
    remainingSec: waterOffAt ? Math.max(0, Math.round((waterOffAt - Date.now()) / 1000)) : null,
    totalSec: waterOffAt && waterMinutes ? waterMinutes * 60 : null,
  };
}

async function waterOn(minutes) {
  await pump('/relay?state=1');
  waterOffAt = Date.now() + minutes * 60e3; waterMinutes = minutes;
  await waterSave(); waterArm();
  return waterStatus();
}

async function waterOff() {
  await pump('/relay?state=0');
  waterOffAt = null; waterMinutes = null; waterArm();
  await waterSave();
  return waterStatus();
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 2048) throw new Error('Body zu gross'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}

async function waterRoute(req, res, p) {
  try {
    if (p === '/api/water/status' && req.method === 'GET') return json(res, 200, await waterStatus());
    if ((p === '/api/water/on' || p === '/api/water/off') && req.method === 'POST') {
      // nur echte JSON-Aufrufe der Seite (Preflight-pflichtig → keine fremden Webseiten im WLAN)
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON erwartet' });
      if (p === '/api/water/off') return json(res, 200, await waterOff());
      const m = Number((await readJson(req)).minutes);
      if (!Number.isInteger(m) || m < 1 || m > WATER_MAX_MIN) return json(res, 400, { error: `minutes 1–${WATER_MAX_MIN}` });
      return json(res, 200, await waterOn(m));
    }
    return json(res, 404, { error: 'unbekannt' });
  } catch (e) {
    console.error('Wasserpumpe:', e.message);
    return json(res, 502, { error: 'Pumpe nicht erreichbar: ' + e.message });
  }
}

// ---------- Car (Škoda Enyaq) ----------
const controlInfo = car => ({
  enabled: skodaEnabled(),
  rateLimitRemaining: car?.rateLimitRemaining ?? null,
  minBudget: carctl.MIN_BUDGET,
  keyExpiresAt: car?.apiKeyExpiresAt ?? null,
});
const CAR_TARGETS = [40, 50, 60, 70, 80, 90, 100];

async function wiserRoute(req, res, p) {
  try {
    let m;
    if ((m = p.match(/^\/api\/(lichter|storen)$/)) && req.method === 'GET') return json(res, 200, await wiserList(m[1]));
    if ((m = p.match(/^\/api\/(lichter|storen)\/(\d+)\/(switch|dim|target|move)$/)) && (req.method === 'PUT' || req.method === 'POST')) {
      // nur echte JSON-Aufrufe der Seite (Preflight-pflichtig → keine fremden Webseiten im WLAN)
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON erwartet' });
      return json(res, 200, { ok: true, ...(await wiserCommand(m[1], m[2], m[3], req.method, await readJson(req))) });
    }
    return json(res, 404, { error: 'unbekannt' });
  } catch (e) {
    if (!(e instanceof WiserError) || e.httpStatus >= 500) console.error('Wiser:', e.message);
    return json(res, e.httpStatus || 502, { error: e.message });
  }
}

async function carRoute(req, res, p) {
  try {
    if (p === '/api/car/series' && req.method === 'GET') {
      const r = new URL(req.url, 'http://x').searchParams.get('range');
      const range = ['24h', '7d', '30d'].includes(r) ? r : '24h';
      try { return json(res, 200, await cached('car-series-' + range, 120e3, () => carSeries(range))); }
      catch (e) { console.error('Car:', e.message); return json(res, 502, { error: 'Verlauf nicht lesbar: ' + e.message }); }
    }
    if (p === '/api/car/status' && req.method === 'GET') {
      let car = null, error = null;
      try { car = await cached('car-status', 20e3, carStatus); }
      catch (e) { error = 'Fahrzeugdaten nicht lesbar: ' + e.message; console.error('Car:', e.message); }
      const extra = { control: controlInfo(car), jobs: carctl.listJobs(), pendingTarget: carctl.pendingTarget(car?.targetSoc) };
      return error ? json(res, 502, { error, ...extra }) : json(res, 200, { ...car, ...extra });
    }
    if (req.method === 'POST') {
      // nur echte JSON-Aufrufe der Seite (Preflight-pflichtig → keine fremden Webseiten im WLAN)
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON erwartet' });
      const body = await readJson(req);
      if (p === '/api/car/target') {
        const pct = Number(body.percent);
        if (!CAR_TARGETS.includes(pct)) return json(res, 400, { error: 'percent must be one of ' + CAR_TARGETS.join(', ') });
        await carctl.setTarget(pct);
        cache.delete('car-status');
        return json(res, 200, { ok: true, pendingTarget: pct });
      }
      if (p === '/api/car/charge') {
        if (!['start', 'stop'].includes(body.action)) return json(res, 400, { error: 'action must be start or stop' });
        if (body.at) {
          const atMs = Date.parse(body.at);
          if (!Number.isFinite(atMs)) return json(res, 400, { error: 'invalid time' });
          const id = await carctl.schedule(body.action, atMs);
          return json(res, 200, { ok: true, scheduled: true, id });
        }
        await carctl.runNow(body.action);
        return json(res, 200, { ok: true, scheduled: false });
      }
      if (p === '/api/car/cancel') {
        await carctl.cancel(String(body.id || ''));
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'unbekannt' });
  } catch (e) {
    console.error('Car:', e.message);
    return json(res, e.httpStatus || 502, { error: e.message });
  }
}

// ---------- HTTP ----------
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function proxy(req, res, pathAndQuery) {
  if (!SENSOR_API_URL) return json(res, 502, { error: 'SENSOR_API_URL nicht gesetzt' });
  try {
    const up = await fetch(SENSOR_API_URL + pathAndQuery, { signal: AbortSignal.timeout(10000) });
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, {
      'Content-Type': up.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    json(res, 502, { error: 'Sensor-API nicht erreichbar: ' + e.message });
  }
}

const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);
const fileCache = new Map();   // Pfad → { mtime, buf, br, gz }  (Dateien ändern sich nur beim Deployment)

async function serveStatic(pathname, req, res) {
  // /dash und /dash/ → index.html; alles unter /dash/ kommt aus ROOT/dash
  const rel = (pathname === '/dash' || pathname === '/dash/') ? '/dash/index.html' : decodeURIComponent(pathname);
  if (!rel.startsWith('/dash/')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(join(ROOT, 'dash') + sep)) { res.writeHead(403); return res.end(); }
  try {
    let e = fileCache.get(file);
    if (!e) {
      const buf = await readFile(file);
      const ext = extname(file);
      e = { buf, br: TEXT.has(ext) && buf.length > 1024 ? brotliCompressSync(buf) : null, gz: TEXT.has(ext) && buf.length > 1024 ? gzipSync(buf) : null };
      fileCache.set(file, e);
    }
    const ae = String(req.headers['accept-encoding'] || '');
    const enc = e.br && /\bbr\b/.test(ae) ? 'br' : e.gz && /\bgzip\b/.test(ae) ? 'gzip' : null;
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      // identisch zu public/_headers (online): vendor unveränderlich, Rest kurz cachen + im Hintergrund erneuern
      'Cache-Control': rel.startsWith('/dash/vendor/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60, stale-while-revalidate=600',
      'Vary': 'Accept-Encoding',
      ...(enc ? { 'Content-Encoding': enc } : {}),
    });
    res.end(enc === 'br' ? e.br : enc === 'gzip' ? e.gz : e.buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nicht gefunden');
  }
}

await waterLoad();
await carctl.init({ dataDir: DATA_DIR, getRemaining: latestRateLimit });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true });
    if (p === '/') { res.writeHead(302, { Location: '/dash/' }); return res.end(); }   // alte Lesezeichen (Fragment bleibt erhalten)
    if (p === '/dash/config.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'public, max-age=60, stale-while-revalidate=600' });
      return res.end(CONFIG_JS);
    }
    // /dash/api/… ist der Vertrag mit dem UI; die internen Routen unten heissen weiterhin /api/…
    const apiPath = p.startsWith('/dash/api/') ? p.slice(5) : p;
    if (apiPath !== p) { p = apiPath; }
    if (p === '/api/outdoor/latest') return json(res, 200, await cached('o-latest', 60e3, outdoorLatest));
    if (p === '/api/outdoor/series') {
      const range = ['24h', '7d', '30d', '1y'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '24h';
      return json(res, 200, await cached('o-series-' + range, 300e3, () => outdoorSeries(range)));
    }
    if (p.startsWith('/api/energy/')) {
      try {
        if (p === '/api/energy/latest') return json(res, 200, await cached('e-latest', 15e3, energyLatest));
        if (p === '/api/energy/summary') return json(res, 200, await cached('e-summary', 60e3, () => energySummary()));
        if (p === '/api/energy/series') {
          const r = url.searchParams.get('range');
          const range = ['today', '24h', '7d'].includes(r) ? r : 'today';
          return json(res, 200, await cached('e-series-' + range, 60e3, () => energySeries(range)));
        }
      } catch (e) { console.error('Energy:', e.message); return json(res, 502, { error: e.message }); }
      return json(res, 404, { error: 'Unbekannt' });
    }
    if (p === '/api/lichter' || p === '/api/storen' || p.startsWith('/api/lichter/') || p.startsWith('/api/storen/')) return wiserRoute(req, res, p);
    if (p.startsWith('/api/car/')) return carRoute(req, res, p);
    if (p.startsWith('/api/water/')) return waterRoute(req, res, p);
    if (p.startsWith('/api/')) return proxy(req, res, p + url.search);
    return serveStatic(p, req, res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Dashboard Seestrasse 52b läuft auf Port ${PORT} (lokal, /dash/)`));
