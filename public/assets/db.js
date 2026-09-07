/* Seestrasse 52B – DB-Client + Helpers (Cloudflare D1 via Worker)
   Ersetzt die alte turso.js komplett. Auth läuft über Cloudflare Access
   (Google-Login) VOR dieser App — kein Token im Frontend nötig.

   Tabellen (bestehendes, produktives Schema — siehe seestrasse52b_parameter /
   seestrasse52b_values in D1):
     seestrasse52b_parameter(ParameterID, Name, Einheit, Active, ParaType,
                              Label, ParaGroup, table_field, created_at, modified_at, table_name)
     seestrasse52b_values(date, ParameterID, value, source, comments, created_at, modified_at)
       UNIQUE(date, ParameterID) — ein Wert pro Parameter und Tag.
*/

class D1Client{
  async execute(sql, args = []){
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, args })
    });
    if(res.status === 401){
      throw new Error('Nicht eingeloggt (Cloudflare Access) – bitte Seite neu laden.');
    }
    if(!res.ok){
      throw new Error(`API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    return data; // { results:[ {col:val,...}, ... ], meta?:{changes,last_row_id} }
  }
}

const _client = new D1Client();
function getClient(){ return _client; }

function rowsToObjects(result){
  return (result && Array.isArray(result.results)) ? result.results : [];
}

/* ---- Read-Cache (sessionStorage, 60-Min TTL, Write-Invalidation) ---- */

const CACHE_PREFIX = 'munotstadt_seestrasse52b_cache_';
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 Minuten

function cacheGet(key){
  try{
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data;
  }catch(e){ return null; }
}

function cacheSet(key, data){
  try{
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data }));
  }catch(e){ /* best effort */ }
}

function cacheInvalidate(keyPrefix){
  try{
    const toRemove = [];
    for(let i = 0; i < sessionStorage.length; i++){
      const k = sessionStorage.key(i);
      if(k && k.startsWith(CACHE_PREFIX + keyPrefix)) toRemove.push(k);
    }
    toRemove.forEach(k => sessionStorage.removeItem(k));
  }catch(e){ /* best effort */ }
}

async function queryCached(client, cacheKey, sql, args = []){
  const cached = cacheGet(cacheKey);
  if(cached !== null) return cached;
  const result = await client.execute(sql, args);
  const rows = rowsToObjects(result);
  cacheSet(cacheKey, rows);
  return rows;
}

/* ---- Datum-Helpers ----
   Speicherung in DB: reines Datum "YYYY-MM-DD" (ein Wert pro Tag/Parameter).
   Anzeige: DD.MM.YYYY. */

function fmtDate(d){
  if(!d) return '';
  const dt = new Date(d.length <= 10 ? d + 'T00:00:00' : d);
  if(isNaN(dt)) return d;
  const p = n => String(n).padStart(2,'0');
  return `${p(dt.getDate())}.${p(dt.getMonth()+1)}.${dt.getFullYear()}`;
}

function fmtDateTime(d){
  if(!d) return '';
  const dt = new Date(d.length <= 10 ? d + 'T00:00:00' : d);
  if(isNaN(dt)) return d;
  const p = n => String(n).padStart(2,'0');
  return `${p(dt.getDate())}.${p(dt.getMonth()+1)}.${dt.getFullYear()} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

function todayISODate(){
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function nowISO(){
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s){
  if(s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showMsg(el, text, type){
  el.textContent = text;
  el.className = 'msg ' + (type === 'ok' ? 'ok' : 'err');
  el.style.display = 'block';
}
