// Gemeinsame Helfer für die Online-Version von /dash (Gegenstück zu dash-local/server.js).

export const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
export const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Antwort für ttlSec Sekunden im Edge-Cache (pro Standort) halten – wiederholte Aufrufe/Polling erreichen D1 nicht.
 * Fehler werden nie gecacht. Der Browser darf die Antwort ebenfalls kurz behalten.
 */
export async function cachedJson(request, ctx, ttlSec, producer) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = json(await producer(), 200, { 'Cache-Control': `public, max-age=${ttlSec}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// D1 liefert Zeiten als UTC ohne Suffix ("YYYY-MM-DD HH:MM:SS") oder als ISO. → immer ISO-UTC mit Z.
export function toIso(s) {
  if (!s) return null;
  s = String(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T12:00:00Z';
  s = s.replace(' ', 'T');
  return /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + 'Z';
}
export const ms = s => Date.parse(toIso(s));

export const sqlTime = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');   // 'YYYY-MM-DD HH:MM:SS' (UTC)
export const dayPrefix = d => new Date(d).toISOString().slice(0, 10);                  // 'YYYY-MM-DD' (UTC), für Indexbereiche
