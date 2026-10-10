// Licht & Blinds: leitet an den Container wiser-storen (Port 8085, Schneider Wiser Gateway) weiter.
// Es werden bewusst nur Anzeige und Bedienung durchgereicht (kein Umbenennen/Zuordnen/Identifizieren).
//   GET  /api/lichter | /api/storen
//   PUT  /api/lichter/:id/switch {on}          PUT  /api/lichter/:id/dim {bri 0–10000}
//   PUT  /api/storen/:id/target {level 0–10000, tilt 0–9?}     POST /api/storen/:id/move {direction up|down|stop}
// level: 0 = offen, 10000 = geschlossen.
const BASE = (process.env.WISER_API_URL || '').replace(/\/+$/, '');
export const wiserEnabled = () => !!BASE;

export class WiserError extends Error {
  constructor(message, httpStatus = 502) { super(message); this.httpStatus = httpStatus; }
}

async function call(method, path, body) {
  if (!BASE) throw new WiserError('WISER_API_URL not set');
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new WiserError('Gateway service not reachable: ' + e.message); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new WiserError(j.error || `Gateway service error [${r.status}]`);
  return j;
}

const KINDS = { lichter: 'lights', storen: 'blinds' };
const cache = new Map();            // kind → { exp, val }  (schont das langsame Gateway)
const TTL = 2000;

const fault = f => !!(f && (f.over_current || f.timeout || f.locked || f.under_current));
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

export function mapLight(l) {
  return { id: l.id, name: String(l.name ?? ''), named: !!l.named, floor: l.floor || '', room: l.room || '',
           type: l.type === 'dim' ? 'dim' : 'onoff', on: !!l.on, bri: l.bri ?? null, fault: fault(l.flags) };
}
export function mapBlind(b) {
  return { id: b.id, name: String(b.name ?? ''), named: !!b.named, floor: b.floor || '', room: b.room || '',
           relay: b.subType === 'relay', level: b.level ?? null, tilt: b.tilt ?? null,
           moving: !!(b.moving && b.moving !== 'stop'), fault: fault(b.flags) };
}

export async function wiserList(kind) {
  if (!KINDS[kind]) throw new WiserError('unknown', 404);
  const hit = cache.get(kind);
  if (hit && hit.exp > Date.now()) return hit.val;
  const j = await call('GET', '/api/' + kind);
  const map = kind === 'lichter' ? mapLight : mapBlind;
  const val = { live: !!j.live, data: (j.data || []).map(map) };
  cache.set(kind, { exp: Date.now() + TTL, val });
  return val;
}

// Prüft den Befehl und gibt {method, body} zurück – nur bekannte, eng begrenzte Aufrufe
export function buildCommand(kind, action, httpMethod, body = {}) {
  if (kind === 'lichter' && action === 'switch' && httpMethod === 'PUT') {
    if (typeof body.on !== 'boolean') throw new WiserError('on must be true/false', 400);
    return { body: { on: body.on } };
  }
  if (kind === 'lichter' && action === 'dim' && httpMethod === 'PUT') {
    const bri = int(Math.round(Number(body.bri)), 0, 10000);
    if (bri == null) throw new WiserError('bri must be 0–10000', 400);
    return { body: { bri } };
  }
  if (kind === 'storen' && action === 'target' && httpMethod === 'PUT') {
    const level = int(Math.round(Number(body.level)), 0, 10000);
    if (level == null) throw new WiserError('level must be 0–10000', 400);
    const out = { level };
    if (body.tilt != null) {
      const tilt = int(Number(body.tilt), 0, 9);
      if (tilt == null) throw new WiserError('tilt must be 0–9', 400);
      out.tilt = tilt;
    }
    return { body: out };
  }
  if (kind === 'storen' && action === 'move' && httpMethod === 'POST') {
    if (!['up', 'down', 'stop'].includes(body.direction)) throw new WiserError('direction must be up, down or stop', 400);
    return { body: { direction: body.direction } };
  }
  throw new WiserError('unknown command', 404);
}

export async function wiserCommand(kind, id, action, httpMethod, body) {
  if (!/^\d{1,6}$/.test(String(id))) throw new WiserError('invalid id', 400);
  const cmd = buildCommand(kind, action, httpMethod, body);
  const r = await call(httpMethod, `/api/${kind}/${id}/${action}`, cmd.body);
  cache.delete(kind);
  return r;
}
