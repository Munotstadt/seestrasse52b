import { esc, API_BASE } from "../util.js";

const POLL_MS = 5000;
const pct = v => (v == null ? null : Math.round(v / 100));   // Licht: Helligkeit %, Blinds: % geschlossen (0 = offen)

// Stockwerke: UG/Keller, EG, 1. OG, 2. OG … , sonst alphabetisch am Ende
function floorRank(f) {
  if (/^(UG|Keller)/i.test(f)) return -1;
  if (/^EG/i.test(f)) return 0;
  const m = f.match(/^(\d+)\./);
  return m ? Number(m[1]) : 99;
}
const collator = new Intl.Collator("de-CH", { numeric: true });

export function mount(el) {
  let lights = [], blinds = [], alive = true, lastSig = "", busy = 0, loadErr = "", cmdErr = "";

  el.innerHTML = `<div class="rooms" id="rview"><div class="chartlabel">Loading …</div></div><div class="note" id="rerr" hidden></div>`;
  const view = el.querySelector("#rview");
  const errBox = el.querySelector("#rerr");
  const showErr = () => { const m = cmdErr || loadErr; errBox.hidden = !m; errBox.textContent = m; };

  async function api(method, url, body) {
    const r = await fetch(API_BASE + url.replace(/^\/api\//, ""), { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.status);
    return d;
  }

  async function load() {
    try {
      const [l, b] = await Promise.all([api("GET", "/api/lichter"), api("GET", "/api/storen")]);
      if (!alive) return;
      lights = l.data || []; blinds = b.data || [];
      loadErr = "";
      const sig = JSON.stringify([lights, blinds]);
      if (sig !== lastSig) { lastSig = sig; render(); }
    } catch (e) { if (alive) loadErr = "Gateway not reachable: " + e.message; }
    if (alive) showErr();
  }
  const soon = (ms = 1000) => setTimeout(() => { if (alive) { lastSig = ""; load(); } }, ms);

  async function send(method, url, body, label) {
    cmdErr = ""; showErr();
    try { await api(method, url, body); }
    catch (e) { cmdErr = `${label}: ${e.message}`; showErr(); }
    soon(1000); soon(3500);
  }

  function lightRow(l) {
    const p = pct(l.bri), dim = l.type === "dim";
    const row = document.createElement("div");
    row.className = "rrow" + (l.on ? " on" : "");
    row.innerHTML = `
      <div class="rtop"><span class="rname">${esc(l.name)}</span>${l.fault ? '<span class="rtag">fault</span>' : ""}
        <span class="rpos">${l.on ? (dim && p != null ? p + " %" : "on") : "off"}</span></div>
      ${dim ? `<input type="range" min="0" max="100" step="1" value="${p ?? 0}" aria-label="Brightness in percent">` : ""}
      <div class="rbtns"><button class="rbtn" data-a="t">${l.on ? "Turn off" : "Turn on"}</button></div>`;
    const sl = row.querySelector("input");
    if (sl) {
      sl.addEventListener("input", () => { if (!sl.dataset.d) { sl.dataset.d = "1"; busy++; } row.querySelector(".rpos").textContent = sl.value + " %"; });
      sl.addEventListener("change", async () => { delete sl.dataset.d; busy = Math.max(0, busy - 1); await send("PUT", `/api/lichter/${l.id}/dim`, { bri: Number(sl.value) * 100 }, l.name); });
    }
    row.querySelector("[data-a=t]").onclick = async ev => {
      const b = ev.currentTarget; b.disabled = true;
      await send("PUT", `/api/lichter/${l.id}/switch`, { on: !l.on }, l.name);
    };
    return row;
  }

  function blindRow(b) {
    const p = pct(b.level);
    const row = document.createElement("div");
    row.className = "rrow";
    row.innerHTML = `
      <div class="rtop"><span class="rname">${esc(b.name)}</span>${b.moving ? '<span class="rtag">moving</span>' : ""}${b.fault ? '<span class="rtag">fault</span>' : ""}
        <span class="rpos">${p == null ? "–" : p + " % closed"}</span></div>
      <div class="rbar"><i style="width:${p ?? 0}%"></i></div>
      <input type="range" min="0" max="100" step="1" value="${p ?? 0}" aria-label="Position in percent closed">
      <div class="rbtns">
        <button class="rbtn dir" data-d="up" title="Up">▲</button>
        <button class="rbtn dir" data-d="stop" title="Stop">■</button>
        <button class="rbtn dir" data-d="down" title="Down">▼</button>
        ${b.relay || b.tilt == null ? "" : `<label class="rtilt">Slats
          <select aria-label="Slat step">${[...Array(10)].map((_, i) => `<option value="${i}" ${i === b.tilt ? "selected" : ""}>${i}</option>`).join("")}</select></label>`}
      </div>`;
    const sl = row.querySelector("input");
    sl.addEventListener("input", () => { if (!sl.dataset.d) { sl.dataset.d = "1"; busy++; } row.querySelector(".rpos").textContent = sl.value + " % closed"; row.querySelector(".rbar i").style.width = sl.value + "%"; });
    sl.addEventListener("change", async () => { delete sl.dataset.d; busy = Math.max(0, busy - 1); await send("PUT", `/api/storen/${b.id}/target`, { level: Number(sl.value) * 100 }, b.name); });
    row.querySelectorAll("[data-d]").forEach(btn => btn.onclick = async () => {
      btn.disabled = true;
      await send("POST", `/api/storen/${b.id}/move`, { direction: btn.dataset.d }, b.name);
      btn.disabled = false;
    });
    const sel = row.querySelector("select");
    if (sel) sel.addEventListener("change", () => send("PUT", `/api/storen/${b.id}/target`, { level: b.level ?? 0, tilt: Number(sel.value) }, b.name));
    return row;
  }

  function render() {
    const a = document.activeElement;
    if (busy || (a && el.contains(a) && (a.tagName === "SELECT" || a.type === "range"))) { lastSig = ""; return; }   // nicht unter dem Finger neu zeichnen
    const rooms = new Map();
    const add = (item, kind) => {
      if (!item.named || !item.room) return;            // nicht zugeordnete Geräte ausblenden
      const key = item.floor + "\u0000" + item.room;
      if (!rooms.has(key)) rooms.set(key, { floor: item.floor, room: item.room, lights: [], blinds: [] });
      rooms.get(key)[kind].push(item);
    };
    lights.forEach(l => add(l, "lights"));
    blinds.forEach(b => add(b, "blinds"));
    const list = [...rooms.values()].sort((x, y) => floorRank(x.floor) - floorRank(y.floor) || collator.compare(x.floor, y.floor) || collator.compare(x.room, y.room));
    view.textContent = "";
    if (!list.length) { view.innerHTML = '<div class="chartlabel">No rooms assigned yet</div>'; return; }
    let curFloor = null, grid = null;
    for (const r of list) {
      if (r.floor !== curFloor) {
        curFloor = r.floor;
        const h = document.createElement("div");
        h.className = "chartlabel rfloor"; h.textContent = r.floor || "Other";
        view.appendChild(h);
        grid = document.createElement("div"); grid.className = "rgrid";
        view.appendChild(grid);
      }
      const card = document.createElement("section");
      card.className = "wcard room";
      const title = document.createElement("div");
      title.className = "wname rtitle"; title.textContent = r.room;
      card.appendChild(title);
      const sec = (label, items, fn) => {
        if (!items.length) return;
        const s = document.createElement("div"); s.className = "rsec";
        const t = document.createElement("div"); t.className = "chartlabel"; t.textContent = label;
        s.appendChild(t);
        items.sort((x, y) => collator.compare(x.name, y.name)).forEach(i => s.appendChild(fn(i)));
        card.appendChild(s);
      };
      sec("Light", r.lights, lightRow);
      sec("Blinds", r.blinds, blindRow);
      grid.appendChild(card);
    }
  }

  load();
  const poll = setInterval(load, POLL_MS);
  return () => { alive = false; clearInterval(poll); };
}
