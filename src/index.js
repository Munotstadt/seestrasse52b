/**
 * Seestrasse 52B – Cloudflare Worker
 * - Dient statische Assets aus /public (Workers Assets)
 * - Stellt /api/query bereit: generisches, parametrisiertes SQL gegen D1
 * - Täglicher Cron-Job: trägt Default-Werte (seestrasse52b_defaults) für
 *   den aktuellen Wochentag in seestrasse52b_values ein, sofern für den
 *   Tag noch kein Wert existiert (bestehende/manuelle Werte werden nie
 *   überschrieben).
 *
 * Sicherheitsmodell:
 * Der Zugriff auf die gesamte Domain (52b.munot.app) läuft über
 * Cloudflare Access (Google als Identity Provider). Nur eingeloggte,
 * autorisierte Google-Accounts erreichen den Worker überhaupt.
 * Als Defense-in-Depth prüfen wir zusätzlich, dass Access den
 * "Cf-Access-Authenticated-User-Email"-Header gesetzt hat, bevor
 * /api/query bzw. /api/run-defaults ausgeführt wird (schützt z.B. vor
 * direktem Zugriff über die *.workers.dev-URL, falls die Access-Policy
 * dort mal fehlt). Der scheduled()-Cron läuft ohne HTTP-Request und
 * damit ohne Access-Header – das ist normal und kein Sicherheitsproblem,
 * da er nur lesend auf seestrasse52b_defaults zugreift.
 */

const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';
const DEFAULTS_SOURCE = 'seestrasse52b-defaults-job';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/query' && request.method === 'POST') {
      return handleQuery(request, env);
    }

    if (url.pathname === '/api/run-defaults') {
      return handleRunDefaults(request, env);
    }

    if (url.pathname === '/api/whoami') {
      const email = request.headers.get(ACCESS_EMAIL_HEADER) || null;
      return json({ email });
    }

    // Alles andere: statische Dateien aus /public (Workers Assets)
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runDefaultsJob(env).then(
        (result) => console.log(`[Defaults OK] ${JSON.stringify(result)}`),
        (err) => console.error(`[Defaults FEHLER] ${err.message}`)
      )
    );
  }
};

async function handleRunDefaults(request, env) {
  const email = request.headers.get(ACCESS_EMAIL_HEADER);
  if (!email) {
    return json({ error: 'Nicht authentifiziert (Cloudflare Access)' }, 401);
  }
  try {
    const result = await runDefaultsJob(env);
    return json({ status: 'ok', ...result });
  } catch (e) {
    return json({ status: 'error', message: String(e.message || e) }, 500);
  }
}

/**
 * Ermittelt Datum (YYYY-MM-DD) und ISO-Wochentag (1=Mo ... 7=So) für "jetzt"
 * in der Zeitzone Europe/Zurich (unabhängig von der UTC-Ausführungszeit des Workers).
 */
function getZurichDateAndWeekday(now) {
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Zurich', weekday: 'short'
  }).format(now);
  const WEEKDAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { dateStr, weekday: WEEKDAY_MAP[weekdayShort] };
}

/**
 * Trägt für den aktuellen Wochentag alle konfigurierten Default-Werte ein.
 * Nutzt ON CONFLICT DO NOTHING: existiert für (date, ParameterID) bereits
 * ein Wert (manuell oder von einem anderen Job gesetzt), wird er NICHT
 * überschrieben – Defaults sind reine Fallback-Werte.
 */
async function runDefaultsJob(env) {
  const { dateStr, weekday } = getZurichDateAndWeekday(new Date());

  const { results } = await env.DB.prepare(
    'SELECT ParameterID, value FROM seestrasse52b_defaults WHERE weekday = ?1'
  ).bind(weekday).all();

  const applied = [];
  const skipped = [];
  for (const row of results) {
    const res = await env.DB.prepare(
      `INSERT INTO seestrasse52b_values (date, ParameterID, value, source)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(date, ParameterID) DO NOTHING`
    ).bind(dateStr, row.ParameterID, row.value, DEFAULTS_SOURCE).run();

    if (res.meta?.changes) {
      applied.push(row.ParameterID);
    } else {
      skipped.push(row.ParameterID); // bereits ein Wert vorhanden -> nicht überschrieben
    }
  }

  return { date: dateStr, weekday, checked: results.length, applied, skipped };
}

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
