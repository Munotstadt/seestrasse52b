// Steuerung des Enyaq: sofortige Befehle und zeitgesteuerte Start/Stopp-Aufträge.
// Aufträge liegen im Container (nicht im Browser) und überleben Neustarts (DATA_DIR/car-jobs.json).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { skodaCommand, SkodaError } from './skoda.js';

export const MIN_BUDGET = 2;          // darunter werden keine Befehle abgesetzt (Limit: 20 Aufrufe/h, Collector braucht ~12)
export const MAX_AHEAD_MS = 7 * 86400e3;
export const MIN_AHEAD_MS = 30e3;
const GRACE_MS = 10 * 60e3;           // nach einem Ausfall nur noch Aufträge nachholen, die <10 min überfällig sind
const RETRY_MS = 120e3;
const MAX_ATTEMPTS = 5;
const KEEP_FAILED_MS = 24 * 3600e3;

let file = null;
let remaining = async () => null;     // liefert verbleibende API-Aufrufe (aus der DB), null = unbekannt
let jobs = [];
const timers = new Map();
let pending = null;                   // zuletzt gesendetes Ladelimit, bis die DB es bestätigt

async function save() {
  if (!file) return;
  try {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(jobs));
  } catch (e) { console.error('Auftragsliste nicht gespeichert:', e.message); }
}

async function checkBudget() {
  let left = null;
  try { left = await remaining(); } catch { /* unbekannt → nicht blockieren */ }
  if (left != null && left < MIN_BUDGET)
    throw new SkodaError(`API budget low (${left} calls left this hour)`, { retriable: true, httpStatus: 429 });
}

function arm(job, delay = Math.max(0, job.at - Date.now())) {
  clearTimeout(timers.get(job.id));
  timers.set(job.id, setTimeout(() => run(job), delay));
}

async function run(job) {
  timers.delete(job.id);
  if (!jobs.includes(job) || job.status !== 'pending') return;
  job.attempts += 1;
  try {
    await checkBudget();
    await skodaCommand(job.type);
    jobs = jobs.filter(j => j !== job);
    console.log(`Car: geplanter Befehl "${job.type}" abgesetzt`);
  } catch (e) {
    job.error = e.message;
    if (e.retriable && job.attempts < MAX_ATTEMPTS) {
      console.error(`Car: "${job.type}" fehlgeschlagen (Versuch ${job.attempts}), neuer Versuch in 2 min:`, e.message);
      arm(job, RETRY_MS);
    } else {
      job.status = 'failed';
      console.error(`Car: "${job.type}" endgültig fehlgeschlagen:`, e.message);
    }
  }
  await save();
}

export async function init({ dataDir, getRemaining }) {
  file = join(dataDir, 'car-jobs.json');
  if (getRemaining) remaining = getRemaining;
  try {
    const list = JSON.parse(await readFile(file, 'utf8'));
    jobs = (Array.isArray(list) ? list : []).filter(j => j && j.id && ['start', 'stop'].includes(j.type) && Number(j.at));
  } catch { jobs = []; }
  const now = Date.now();
  jobs = jobs.filter(j => !(j.status === 'failed' && now - j.at > KEEP_FAILED_MS));
  for (const j of jobs) {
    if (j.status !== 'pending') continue;
    if (j.at + GRACE_MS < now) { j.status = 'failed'; j.error = 'Missed (dashboard was not running at that time)'; continue; }
    arm(j);
  }
  await save();
}

export function listJobs() {
  return jobs.map(j => ({ id: j.id, type: j.type, at: new Date(j.at).toISOString(), status: j.status, error: j.error || null, attempts: j.attempts }));
}

export async function schedule(type, atMs) {
  if (!['start', 'stop'].includes(type)) throw new SkodaError('Unknown action', { httpStatus: 400 });
  const now = Date.now();
  if (!(atMs >= now + MIN_AHEAD_MS && atMs <= now + MAX_AHEAD_MS)) throw new SkodaError('Time must be between 1 minute and 7 days ahead', { httpStatus: 400 });
  const job = { id: randomUUID(), type, at: atMs, status: 'pending', attempts: 0, error: null, created: now };
  jobs.push(job);
  arm(job);
  await save();
  return job.id;
}

export async function cancel(id) {
  const job = jobs.find(j => j.id === id);
  if (!job) throw new SkodaError('Job not found', { httpStatus: 404 });
  clearTimeout(timers.get(id)); timers.delete(id);
  jobs = jobs.filter(j => j !== job);
  await save();
}

export async function runNow(type) {
  await checkBudget();
  await skodaCommand(type);
}

export async function setTarget(percent) {
  await checkBudget();
  await skodaCommand('limit', { targetStateOfChargeInPercent: percent });
  pending = { value: percent, at: Date.now() };
}

// Ladelimit, das gesendet, aber von der DB noch nicht bestätigt wurde
export function pendingTarget(currentTarget) {
  if (pending && (Date.now() - pending.at > 20 * 60e3 || currentTarget === pending.value)) pending = null;
  return pending ? pending.value : null;
}
