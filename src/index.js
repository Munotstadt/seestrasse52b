/**
 * Seestrasse 52B – Cloudflare Worker
 * - Dient statische Assets aus /public (Workers Assets)
 * - Stellt /api/query bereit: generisches, parametrisiertes SQL gegen D1
 *
 * Hinweis: Das taegliche Anwenden der Default-Werte (seestrasse52b_defaults)
 * uebernimmt der separate Cloudflare_worker_daylength-niederhasli Worker
 * (laeuft ohnehin taeglich, schreibt fuer denselben Tag auch die Taglaenge).
 * Dieser Worker hier hat daher bewusst keinen eigenen Cron/scheduled()-Job
 * fuer Defaults.
 *
 * Sicherheitsmodell:
 * Der Zugriff auf die gesamte Domain (52b.munot.app) läuft über
 * Cloudflare Access (Google als Identity Provider). Nur eingeloggte,
 * autorisierte Google-Accounts erreichen den Worker überhaupt.
 * Als Defense-in-Depth prüfen wir zusätzlich, dass Access den
 * "Cf-Access-Authenticated-User-Email"-Header gesetzt hat, bevor
 * /api/query ausgeführt wird (schützt z.B. vor direktem Zugriff über
 * die *.workers.dev-URL, falls die Access-Policy dort mal fehlt).
 */

const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/query' && request.method === 'POST') {
      return handleQuery(request, env);
    }

    if (url.pathname === '/api/whoami') {
      const email = request.headers.get(ACCESS_EMAIL_HEADER) || null;
      return json({ email });
    }

    // Alles andere: statische Dateien aus /public (Workers Assets)
    return env.ASSETS.fetch(request);
  }
};

async function handleQuery(request, env) {
  const email = request.headers.get(ACCESS_EMAIL_HEADER);
  if (!email) {
    return json({ error: 'Nicht authentifiziert (Cloudflare Access)' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Ungültiges JSON im Request-Body' }, 400);
  }

  const { sql, args } = body || {};
  if (!sql || typeof sql !== 'string') {
    return json({ error: "Feld 'sql' fehlt oder ist kein String" }, 400);
  }
  if (args !== undefined && !Array.isArray(args)) {
    return json({ error: "Feld 'args' muss ein Array sein" }, 400);
  }

  try {
    const stmt = env.DB.prepare(sql);
    const bound = args && args.length ? stmt.bind(...args) : stmt;

    const isSelect = /^\s*(select|pragma)/i.test(sql);
    if (isSelect) {
      const { results } = await bound.all();
      return json({ results });
    } else {
      const result = await bound.run();
      return json({
        results: [],
        meta: {
          changes: result.meta?.changes ?? 0,
          last_row_id: result.meta?.last_row_id ?? null
        }
      });
    }
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
