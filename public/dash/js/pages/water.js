import { fmt1, API_BASE } from "../util.js";

const DURATIONS = [15, 30, 45, 60, 120];   // Minuten
const POLL_MS = 5000;

const pad = n => String(n).padStart(2, "0");
function clock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function mount(el) {
  let sel = 30;
  try { const v = Number(localStorage.getItem("water.min")); if (DURATIONS.includes(v)) sel = v; } catch {}

  el.innerHTML = `
    <div class="water">
      <section class="wcard">
        <div class="wtop"><span class="dot stale" id="wdot"></span><span class="wname">Water pump</span><span class="wstate" id="wstate">…</span></div>
        <div class="wcount" id="wcount">--:--</div>
        <div class="wbar"><div id="wfill"></div></div>
        <div class="wmeta" id="wmeta">Loading …</div>
      </section>
      <section class="wcard">
        <div class="chartlabel">Run time</div>
        <div class="chips" id="chips">
          ${DURATIONS.map(m => `<button data-m="${m}" class="${m === sel ? "active" : ""}">${m} min</button>`).join("")}
        </div>
        <div class="wbtns">
          <button class="btn start" id="start" disabled>Start</button>
          <button class="btn stop" id="stop" disabled>Stop</button>
        </div>
      </section>
    </div>
    <div class="note" id="werr" hidden></div>`;

  const $ = id => el.querySelector("#" + id);
  let st = null, recvAt = 0, busy = false, alive = true, refetchArmed = false;

  function remaining() {
    if (!st || st.remainingSec == null) return null;
    return st.remainingSec - (Date.now() - recvAt) / 1000;
  }

  function render() {
    const on = st && st.relay === true;
    const offline = !st || !st.online;
    $("wdot").className = "dot" + (offline || !on ? " stale" : "");
    $("wstate").textContent = offline ? "Offline" : on ? "ON" : "OFF";
    $("wstate").className = "wstate" + (on ? " on" : "");
    const rem = remaining();
    const total = st && st.totalSec;
    if (offline) {
      $("wcount").textContent = "--:--";
      $("wfill").style.width = "0";
      $("wmeta").textContent = st ? "Pump not reachable" : "Loading …";
    } else if (on && rem != null) {
      $("wcount").textContent = clock(rem);
      $("wfill").style.width = total ? Math.max(0, Math.min(100, rem / total * 100)) + "%" : "0";
      const stop = new Date(st.offAt).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
      $("wmeta").textContent = `Stops at ${stop}` + (st.power != null ? ` · ${fmt1(st.power)} W` : "");
    } else if (on) {
      $("wcount").textContent = "No timer";
      $("wfill").style.width = "0";
      $("wmeta").textContent = "Switched on manually" + (st.power != null ? ` · ${fmt1(st.power)} W` : "");
    } else {
      $("wcount").textContent = "–";
      $("wfill").style.width = "0";
      $("wmeta").textContent = "Ready";
    }
    $("start").textContent = on ? "Restart timer" : "Start";
    $("start").disabled = busy || offline;
    $("stop").disabled = busy || offline || !on;

    // Countdown abgelaufen → Status kurz danach bestätigen lassen
    if (on && rem != null && rem <= 0 && !refetchArmed) {
      refetchArmed = true;
      setTimeout(() => { refetchArmed = false; if (alive) load(); }, 2000);
    }
  }

  function setErr(msg) {
    const n = $("werr");
    n.hidden = !msg; n.textContent = msg || "";
  }

  function apply(d) { st = d; recvAt = Date.now(); render(); }

  async function load() {
    try {
      const r = await fetch(API_BASE + "water/status");
      const d = await r.json();
      if (!alive) return;
      if (!r.ok) throw new Error(d.error || r.status);
      setErr(d.online ? "" : (d.error || ""));
      apply(d);
    } catch (e) {
      if (!alive) return;
      st = { online: false }; recvAt = Date.now(); setErr(e.message); render();
    }
  }

  async function post(url, body) {
    busy = true; render(); setErr("");
    try {
      const r = await fetch(API_BASE + url.replace(/^\/api\//, ""), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      if (alive) apply(d);
    } catch (e) {
      if (alive) setErr(e.message);
    } finally {
      busy = false; if (alive) render();
    }
  }

  $("chips").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    sel = Number(b.dataset.m);
    try { localStorage.setItem("water.min", sel); } catch {}
    el.querySelectorAll("#chips button").forEach(x => x.classList.toggle("active", x === b));
  };
  $("start").onclick = () => post("/api/water/on", { minutes: sel });
  $("stop").onclick = () => post("/api/water/off");

  load();
  const poll = setInterval(load, POLL_MS);
  const tick = setInterval(render, 1000);
  return () => { alive = false; clearInterval(poll); clearInterval(tick); };
}
