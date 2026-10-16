/**
 * /dash – Online-Gegenstück zum lokalen Dashboard auf dem NAS (dash-local/server.js).
 *
 * Gleiche URL-Struktur, gleicher JSON-Vertrag, gleiches UI (public/dash/**). Unterschiede nur hier:
 *   - Datenquelle ist ausschliesslich D1 (nie NAS/Heimnetz)
 *   - nur lesen: keine Steuerung (Storen, Licht, Wasser, Laden)
 *   - Seiten ohne D1-Daten sind «pendent» (siehe CONFIG.pages)
 *
 * Statische Dateien (/dash/css, /dash/js, /dash/vendor …) liefert Workers Assets direkt am Edge aus – ohne diesen Code.
 * Dieser Worker läuft nur für /dash (ohne Slash), /dash/config.js und /dash/api/*.
 */
import { json, cachedJson } from './util.js';
import { innerLatest, innerSeries, outdoorLatest, outdoorSeries } from './temperatur.js';
import { energyLatest, energySummary, energySeries, energyHistory } from './energy.js';
import { carStatus, carSeries } from './car.js';

// Online-Gegenstück zu CONFIG in dash-local/server.js. Neue Seite online freischalten: 'pending' → 'live'.
const CONFIG = {
  mode: 'remote',
  pages: { temperatur: 'live', water: 'pending', storen: 'pending', energy: 'live', car: 'live' },
  control: { water: false, blinds: false, car: false },
};
const CONFIG_JS = `export default ${JSON.stringify(CONFIG)};\n`;

const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

export async function handleDash(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;

  // /dash → UI-Einstieg (ohne Redirect; <base href="/dash/"> in index.html löst die relativen Pfade auf)
  if (p === '/dash') return env.ASSETS.fetch(new Request(new URL('/dash/', url), request));

  if (p === '/dash/config.js') {
    return new Response(CONFIG_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=60, stale-while-revalidate=600' } });
  }

  if (!p.startsWith('/dash/api/')) return null;   // alles andere → statische Dateien

  // Defense-in-Depth wie bei /api/query: Cloudflare Access muss davor gewesen sein
  if (!request.headers.get(ACCESS_EMAIL_HEADER) && env.DASH_ALLOW_ANON !== '1') {
    return json({ error: 'Nicht authentifiziert (Cloudflare Access)' }, 401);
  }
  if (request.method !== 'GET') return json({ error: 'Nur lesen' }, 405);

  const route = p.slice('/dash/api/'.length);
  const q = url.searchParams;
  try {
    switch (route) {
      case 'latest':          return await cachedJson(request, ctx, 30, () => innerLatest(env));
      case 'series':          return await cachedJson(request, ctx, 120, () => innerSeries(env, q.get('sensor'), oneOf(q.get('range'), ['24h', '7d', '30d', '1y'], '24h')));
      case 'outdoor/latest':  return await cachedJson(request, ctx, 60, () => outdoorLatest(env));
      case 'outdoor/series':  return await cachedJson(request, ctx, 300, () => outdoorSeries(env, oneOf(q.get('range'), ['24h', '7d', '30d', '1y'], '24h')));
      case 'energy/latest':   return await cachedJson(request, ctx, 15, () => energyLatest(env));
      case 'energy/summary':  return await cachedJson(request, ctx, 60, () => energySummary(env));
      case 'energy/history':  return await cachedJson(request, ctx, 300, () => energyHistory(env));
      case 'energy/series':   return await cachedJson(request, ctx, 60, () => energySeries(env, oneOf(q.get('range'), ['today', '24h', '7d'], 'today')));
      case 'car/status':      return await cachedJson(request, ctx, 20, () => carStatus(env));
      case 'car/series':      return await cachedJson(request, ctx, 120, () => carSeries(env, oneOf(q.get('range'), ['24h', '7d'], '24h')));
    }
    // Water / Blinds+Light: online «pendent» (kein Gegenstück in D1)
    if (/^(water|lichter|storen)(\/|$)/.test(route)) return json({ error: 'Nur im Heimnetz verfügbar (pendent)' }, 404);
    return json({ error: 'unbekannt' }, 404);
  } catch (e) {
    if (!e.status) console.error('dash', route, e.message);
    return json({ error: String(e.message || e) }, e.status || 502);
  }
}
