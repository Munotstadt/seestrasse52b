// Prüft, dass die lokale (NAS) und die Online-Version von /dash denselben Vertrag erfüllen.
//   node scripts/dash-check.mjs        (läuft auch in CI; Exit-Code 1 bei Abweichung)
// Geprüft wird:
//   1. Jeder API-Pfad, den das gemeinsame UI aufruft, ist in scripts/dash-contract.json beschrieben
//   2. Lokal (dash-local/server.js) UND online (src/dash/index.js) implementieren jeden GET-Pfad des Vertrags
//   3. Seiten-IDs im UI (js/app.js), in CONFIG lokal und CONFIG online sind identisch
//   4. Ein Online-Pfad mit state "pending" ist im Vertrag als solcher markiert
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const contract = JSON.parse(read('scripts/dash-contract.json'));
const errors = [];
const fail = m => errors.push(m);

// 1. API-Aufrufe des UI sammeln
const ui = ['public/dash/js/app.js', 'public/dash/js/util.js',
  ...readdirSync(join(root, 'public/dash/js/pages')).map(f => 'public/dash/js/pages/' + f)];
const used = new Set();
for (const f of ui) {
  const src = read(f);
  for (const m of src.matchAll(/\b(?:api|apiSWR|getJson)\(\s*[`"']([^`"'$?]+)/g)) used.add(m[1].replace(/\/$/, ''));
  for (const m of src.matchAll(/API_BASE \+ "([^"?]+)/g)) used.add(m[1]);
  for (const m of src.matchAll(/["'`]\/api\/([^"'`$?]+)/g)) used.add(m[1].replace(/\/$/, ''));   // logische Pfade /api/… in car/water/rooms
}
const known = Object.keys(contract.routes);
const covered = p => known.some(k => k === p || (k.endsWith('/*') && p.startsWith(k.slice(0, -1))));
for (const p of used) if (!/^(GET|PUT|POST)$/.test(p) && !covered(p) && !/^(lichter|storen|car|water)\//.test(p)) fail(`UI ruft api/${p} auf – fehlt in scripts/dash-contract.json`);

// 2. Backends
const local = read('dash-local/server.js'), online = read('src/dash/index.js');
for (const [route, spec] of Object.entries(contract.routes)) {
  if (route.endsWith('/*')) continue;
  const inLocal = spec.local === 'proxy' ? local.includes('return proxy(req, res') : (local.includes(`'/api/${route}'`) || local.includes(`"/api/${route}"`));
  const inOnline = online.includes(`case '${route}'`);
  if (spec.local && !inLocal) fail(`lokal fehlt Route /api/${route}`);
  if (spec.online === 'live' && !inOnline) fail(`online fehlt Route /dash/api/${route}`);
}

// 3. Seiten
const pagesUi = [...read('public/dash/js/app.js').matchAll(/id: "(\w+)"/g)].map(m => m[1]).sort().join();
const cfgPages = src => { const m = src.match(/pages:\s*\{([^}]*)\}/); return m ? [...m[1].matchAll(/(\w+):/g)].map(x => x[1]).sort().join() : ''; };
if (cfgPages(local) !== pagesUi) fail(`CONFIG.pages lokal (${cfgPages(local)}) ≠ UI (${pagesUi})`);
if (cfgPages(online) !== pagesUi) fail(`CONFIG.pages online (${cfgPages(online)}) ≠ UI (${pagesUi})`);

// 4. Pending-Seiten online
const pendingOnline = [...(online.match(/pages:\s*\{([^}]*)\}/)?.[1] || '').matchAll(/(\w+):\s*'pending'/g)].map(m => m[1]);
for (const id of pendingOnline) if (!contract.pendingOnline.includes(id)) fail(`Seite ${id} ist online «pending», aber nicht in dash-contract.json pendingOnline`);
for (const id of contract.pendingOnline) if (!pendingOnline.includes(id)) fail(`dash-contract.json: ${id} ist pendingOnline, online aber 'live'`);

// 5. Platzhalter der Car-Datenbank (install.ps1 hat noch nicht gelaufen) darf nie deployt werden
for (const f of ['wrangler.jsonc', 'workers/skoda-collector/wrangler.jsonc']) {
  if (read(f).includes('__CAR_DB_ID__')) fail(`${f}: __CAR_DB_ID__ fehlt noch – workers/skoda-collector/install.ps1 ausführen`);
}

if (errors.length) { console.error('dash-check: ' + errors.length + ' Abweichung(en)\n - ' + errors.join('\n - ')); process.exit(1); }
console.log(`dash-check OK – ${known.length} Routen, ${pagesUi.split(',').length} Seiten, lokal = online`);
