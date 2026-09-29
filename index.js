// Aggregiert täglich um 04:00 UTC die Shelly-Rohwerte des Vortags
// (Lokalzeit-Kalendertag) zu einem Tagesmittel pro ParameterID.
// Rohwerte: date = 'YYYY-MM-DD HH:MM:SS', source = 'shellyhtg3-*'
// Aggregat: date = 'YYYY-MM-DD',          source = 'shelly-daily-avg'

const AGG = `
  INSERT INTO seestrasse52b_values (date, ParameterID, value, source, comments)
  SELECT date(date), ParameterID, ROUND(AVG(value), 2),
         'shelly-daily-avg', COUNT(*) || ' Messwerte'
  FROM seestrasse52b_values
  WHERE source LIKE 'shellyhtg3-%'
    AND length(date) > 10
    AND date(date) = date('now', '-1 day')
  GROUP BY date(date), ParameterID
  ON CONFLICT(date, ParameterID) DO UPDATE SET
    value = excluded.value,
    source = excluded.source,
    comments = excluded.comments,
    modified_at = datetime('now')`;

const CLEANUP = `
  DELETE FROM seestrasse52b_values
  WHERE source LIKE 'shellyhtg3-%'
    AND length(date) > 10
    AND date(date) = date('now', '-1 day')`;

async function run(env) {
  // Ein Batch = eine Transaktion: entweder beides oder nichts
  const res = await env.DB.batch([env.DB.prepare(AGG), env.DB.prepare(CLEANUP)]);
  const msg = `aggregiert: ${res[0].meta.changes}, gelöscht: ${res[1].meta.changes}`;
  console.log(msg);
  return msg;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
