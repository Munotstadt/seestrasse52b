// Schreibt public/dash/version.json = Hash über alle UI-Dateien (ohne version.json selbst).
// Läuft in CI vor dem Worker-Deploy UND im NAS-Deploy-Skript → zeigen beide Ansichten denselben Hash im Kopfbereich,
// sind sie inhaltlich und layouttechnisch identisch. Zeilenenden werden normalisiert (Windows/Linux gleich).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'dash');
const TEXT = /\.(html|js|css|json|svg|webmanifest)$/;

function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function uiHash() {
  const h = createHash('sha256');
  const files = walk(ROOT).map(f => relative(ROOT, f).split(sep).join('/')).filter(f => f !== 'version.json').sort();
  for (const f of files) {
    let buf = readFileSync(join(ROOT, f));
    if (TEXT.test(f)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'));
    h.update(f + '\0').update(buf).update('\0');
  }
  return { hash: h.digest('hex'), files: files.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const v = uiHash();
  writeFileSync(join(ROOT, 'version.json'), JSON.stringify(v) + '\n');
  console.log(`dash UI ${v.hash.slice(0, 7)} (${v.files} Dateien)`);
}
