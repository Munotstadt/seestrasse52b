// MyŠkoda Public API – nur die drei Befehle, die das Dashboard braucht.
// Auth: Header X-API-Key (gleicher Key wie der skoda-enyaq-collector). Der Key bleibt im Container.
// Antwort 2xx (meist 202) heisst nur "übermittelt", nicht "ausgeführt".
const BASE = (process.env.SKODA_API_URL || 'https://public.api.connect.skoda-auto.cz').replace(/\/+$/, '');
const KEY = process.env.SKODA_API_KEY || '';
const VIN = process.env.SKODA_VIN || '';

export const skodaEnabled = () => !!(KEY && VIN);

export class SkodaError extends Error {
  constructor(message, { retriable = false, httpStatus = 502 } = {}) {
    super(message);
    this.retriable = retriable;
    this.httpStatus = httpStatus;
  }
}

const OPS = {
  start: ['POST', 'charging/start'],
  stop: ['POST', 'charging/stop'],
  limit: ['PUT', 'charging/limit'],
};

const HINT = {
  401: 'API key expired or invalid (renew it in the MyŠkoda app)',
  403: 'API key not authorized for this car, or the car rejected the command',
  422: 'Operation not supported or disabled by the car',
  429: 'Rate limit reached – try again later',
};

export async function skodaCommand(op, body) {
  if (!skodaEnabled()) throw new SkodaError('Control not configured (SKODA_API_KEY / SKODA_VIN missing)');
  const [method, path] = OPS[op] || [];
  if (!method) throw new SkodaError('Unknown operation: ' + op);
  let r;
  try {
    r = await fetch(`${BASE}/api/v1/vehicles/${encodeURIComponent(VIN)}/${path}`, {
      method,
      headers: { 'X-API-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new SkodaError('Škoda API not reachable: ' + e.message, { retriable: true });
  }
  if (r.status >= 200 && r.status < 300) return { status: r.status };
  const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
  const msg = `${HINT[r.status] || 'Škoda API error'} [${r.status}]${text ? ' ' + text : ''}`;
  throw new SkodaError(msg, { retriable: r.status === 429 || r.status >= 500, httpStatus: r.status === 429 ? 429 : 502 });
}
