import { fmt1, ageText, esc, css, bandChart, api, API_BASE, ensureChart } from "../util.js";
import cfg from "../../config.js";

const POLL_MS = 30000;
const TARGETS = [40, 50, 60, 70, 80, 90, 100];
const API_PER_HOUR = 20;

const STATES = {
  CHARGING: "Charging", READY_FOR_CHARGING: "Ready", CONSERVING: "Conserving",
  NOT_READY_FOR_CHARGING: "Not ready", CHARGE_ERROR: "Error", CONNECT_CABLE: "Connect cable",
};
function stateLabel(c) {
  if (!c.chargingState) return "Not charging";
  return STATES[c.chargingState] || c.chargingState.toLowerCase().replace(/_/g, " ").replace(/^./, m => m.toUpperCase());
}
function mins(m) {
  if (m == null || m <= 0) return "–";
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}
const pad = n => String(n).padStart(2, "0");
const localInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const when = iso => new Date(iso).toLocaleString("de-CH", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
function defaultAt() {   // nächste volle Viertelstunde, mindestens 45 min in der Zukunft
  const d = new Date(Date.now() + 45 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return d;
}

export function mount(el) {
  el.innerHTML = `
    <div class="car">
      <section class="wcard">
        <div class="wtop"><span class="dot stale" id="kdot"></span><span class="wname">Enyaq</span><span class="wstate" id="kpark"></span><button class="mini" id="khist">History</button></div>
        <div class="csoc" id="ksoc">–<small> %</small></div>
        <div class="cbar"><div id="kfill"></div><i id="ktick" hidden></i></div>
        <div class="crow"><span>Range</span><b id="krange">–</b></div>
        <div class="crow"><span>Target SoC</span><b id="ktarget">–</b></div>
      </section>
      <section class="wcard">
        <div class="wtop"><span class="wname">Charging</span></div>
        <div class="crow"><span>Plugged</span><b id="kplug">–</b></div>
        <div class="crow"><span>Status</span><b id="kstate">–</b></div>
        <div class="crow"><span>Power</span><b id="kpower">–</b></div>
        <div class="crow"><span>Time to full</span><b id="kfull">–</b></div>
      </section>

      <section class="wcard" data-ctl>
        <div class="chartlabel">Target SoC</div>
        <div class="chips" id="ktchips">
          ${TARGETS.map(t => `<button data-t="${t}">${t}</button>`).join("")}
        </div>
        <button class="btn apply" id="ktapply" hidden>Set target</button>
      </section>
      <section class="wcard" data-ctl>
        <div class="chartlabel">Charging control</div>
        <div class="chips" id="kwhen">
          <button data-w="now" class="active">Now</button>
          <button data-w="at">At time</button>
          <input type="datetime-local" id="kat" hidden>
        </div>
        <div class="wbtns">
          <button class="btn start" id="kstart" disabled>Start charging</button>
          <button class="btn stop" id="kstop" disabled>Stop charging</button>
        </div>
        <div class="kjobs" id="kjobs"></div>
      </section>

      <section class="wcard cwide">
        <div class="chartlabel">Location</div>
        <div class="caddr" id="kaddr">–</div>
        <div class="wmeta" id="kage">Loading …</div>
        <div class="wmeta" id="kbudget"></div>
      </section>
    </div>
    <div class="wmeta kmsg" id="kmsg" hidden></div>
    <div class="note" id="kerr" hidden></div>
    <section class="sheet" id="ksheet" hidden>
      <div class="dhead">
        <h2>Battery history</h2>
        <div class="dctl">
          <div class="ranges" id="kranges">
            <button data-r="24h" class="active">24 h</button>
            <button data-r="7d">7 days</button>
          </div>
          <button class="close" id="kclose" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="charts">
        <div class="panel"><div class="chartlabel">State of charge (%)</div><div class="chartbox"><canvas id="kcSoc"></canvas></div></div>
        <div class="panel"><div class="chartlabel">Range (km)</div><div class="chartbox"><canvas id="kcRange"></canvas></div></div>
      </div>
      <div class="err" id="kcerr" hidden></div>
    </section>`;

  const $ = id => el.querySelector("#" + id);
  const canControl = !!(cfg.control && cfg.control.car);   // online nur Anzeige: Bedienelemente ausblenden
  if (!canControl) el.querySelectorAll("[data-ctl]").forEach(n => { n.hidden = true; });
  let car = null, alive = true, busy = false, loadErr = false;
  let selTarget = null, mode = "now";
  let hrange = "24h", charts = {};
  $("kat").value = localInput(defaultAt());

  const low = () => car && car.control && car.control.rateLimitRemaining != null && car.control.rateLimitRemaining < car.control.minBudget;
  const enabled = () => !!(car && car.control && car.control.enabled);

  function setMsg(text, isErr) {
    const m = $("kmsg"), e = $("kerr");
    m.hidden = isErr || !text; m.textContent = isErr ? "" : text;
    e.hidden = !isErr || !text; e.textContent = isErr ? text : "";
  }

  function renderJobs() {
    const box = $("kjobs");
    box.innerHTML = "";
    for (const j of (car && car.jobs) || []) {
      const row = document.createElement("div");
      row.className = "kjob" + (j.status === "failed" ? " failed" : "");
      const label = document.createElement("span");
      label.textContent = `${j.type === "start" ? "Start" : "Stop"} · ${when(j.at)}` +
        (j.status === "failed" ? ` – failed: ${j.error || "error"}` : j.error ? ` – retrying (${j.error})` : "");
      const x = document.createElement("button");
      x.textContent = "✕"; x.setAttribute("aria-label", "Remove");
      x.onclick = () => post("/api/car/cancel", { id: j.id }, "Removed.");
      row.append(label, x);
      box.appendChild(row);
    }
  }

  function renderControls() {
    el.querySelectorAll("#ktchips button").forEach(b => {
      const t = Number(b.dataset.t);
      b.classList.toggle("cur", car && car.targetSoc === t);
      b.classList.toggle("active", selTarget === t);
    });
    const apply = $("ktapply");
    apply.hidden = selTarget == null || (car && selTarget === car.targetSoc);
    apply.textContent = `Set target to ${selTarget} %`;
    apply.disabled = busy || !enabled() || low();
    const nowMode = mode === "now";
    $("kat").hidden = nowMode;
    const blocked = busy || !enabled() || (nowMode && low());
    $("kstart").disabled = blocked;
    $("kstop").disabled = blocked;
    $("kstart").textContent = nowMode ? "Start charging" : "Schedule start";
    $("kstop").textContent = nowMode ? "Stop charging" : "Schedule stop";
  }

  function render() {
    if (!car) return;
    const fresh = car.collectedAt && Date.now() - new Date(car.collectedAt) < 15 * 60000;
    $("kdot").className = "dot" + (fresh ? "" : " stale");
    $("kpark").textContent = car.parking ? car.parking.toUpperCase() : "";
    $("ksoc").innerHTML = `${car.soc ?? "–"}<small> %</small>`;
    $("ksoc").classList.toggle("charging", !!car.charging);
    $("kfill").style.width = (car.soc ?? 0) + "%";
    $("ktick").hidden = car.targetSoc == null;
    if (car.targetSoc != null) $("ktick").style.left = car.targetSoc + "%";
    $("krange").textContent = car.rangeKm == null ? "–" : Math.round(car.rangeKm) + " km";
    const pend = car.pendingTarget != null && car.pendingTarget !== car.targetSoc ? ` → ${car.pendingTarget} % (sent)` : "";
    $("ktarget").textContent = car.targetSoc == null ? "–" : car.targetSoc + " %" + pend;
    $("kplug").textContent = car.plugged == null ? "–" : car.plugged ? "Yes" : "No";
    $("kstate").textContent = stateLabel(car);
    $("kpower").textContent = car.powerKw == null ? "–" : fmt1(car.powerKw) + " kW";
    $("kfull").textContent = car.charging ? mins(car.minutesToFull) : "–";
    $("kaddr").innerHTML = car.address ? esc(car.address) : "–";
    const rep = car.reportedAt ? ageText(car.reportedAt, 120).t : "–";
    const chk = car.collectedAt ? ageText(car.collectedAt, 15).t : "–";
    $("kage").textContent = `Car reported: ${rep} · checked: ${chk}`;
    const c = car.control || {};
    $("kbudget").textContent = !canControl ? ""
      : !c.enabled
      ? "Control is not configured on the server (SKODA_API_KEY missing)."
      : c.rateLimitRemaining != null
        ? `API calls left this hour: ${c.rateLimitRemaining} / ${API_PER_HOUR} (shared with the data collector)` + (low() ? " – commands paused, scheduling still possible" : "")
        : "";
    renderJobs();
    renderControls();
  }

  async function load() {
    try {
      const r = await fetch(API_BASE + "car/status");
      const d = await r.json().catch(() => ({}));
      if (!alive) return;
      if (!r.ok) { if (d.jobs) { car = { ...(car || {}), jobs: d.jobs, control: d.control }; render(); } throw new Error(d.error || r.status); }
      car = d;
      if (loadErr) { $("kerr").hidden = true; loadErr = false; }   // nur Ladefehler zurücknehmen, nicht Fehler von Befehlen
      render();
    } catch (e) {
      if (!alive) return;
      loadErr = true;
      setMsg(e.message, true);
    }
  }

  async function post(url, body, okMsg) {
    busy = true; renderControls(); setMsg("");
    try {
      const r = await fetch(API_BASE + url.replace(/^\/api\//, ""), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.status);
      if (alive) { setMsg(typeof okMsg === "function" ? okMsg(d) : okMsg); }
    } catch (e) {
      if (alive) setMsg(e.message, true);
    } finally {
      busy = false;
      if (alive) await load();
    }
  }

  $("ktchips").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    selTarget = Number(b.dataset.t);
    renderControls();
  };
  $("ktapply").onclick = async () => {
    const t = selTarget;
    await post("/api/car/target", { percent: t }, `Target ${t} % sent – the car confirms within a few minutes.`);
    selTarget = null; renderControls();
  };
  $("kwhen").onclick = e => {
    const b = e.target.closest("button[data-w]"); if (!b) return;
    mode = b.dataset.w;
    el.querySelectorAll("#kwhen button").forEach(x => x.classList.toggle("active", x === b));
    renderControls();
  };

  function charge(action) {
    const label = action === "start" ? "Start" : "Stop";
    if (mode === "now") return post("/api/car/charge", { action }, `${label} command sent – the car confirms within a few minutes.`);
    const v = $("kat").value;
    const at = v ? new Date(v) : null;
    if (!at || !(at.getTime() > Date.now() + 60000)) return setMsg("Pick a time at least 1 minute in the future.", true);
    return post("/api/car/charge", { action, at: at.toISOString() }, `${label} scheduled for ${when(at.toISOString())}.`);
  }
  $("kstart").onclick = () => charge("start");
  $("kstop").onclick = () => charge("stop");

  // ---- Verlauf (SoC + Reichweite) ----
  function draw(id, points, opts) {
    if (charts[id]) charts[id].destroy();
    charts[id] = bandChart($(id), points, { ...opts, range: hrange });
  }
  async function loadSeries() {
    const err = $("kcerr");
    err.hidden = true;
    try {
      const [d] = await Promise.all([api(`car/series?range=${hrange}`), ensureChart()]);
      if (!alive || $("ksheet").hidden) return;
      draw("kcSoc", d.soc, { color: css("--ok"), unit: "%", dec: 0, minSpan: 10 });
      draw("kcRange", d.range, { color: css("--hum"), unit: "km", dec: 0, minSpan: 20 });
    } catch (e) {
      err.textContent = "Could not load history: " + e.message;
      err.hidden = false;
    }
  }
  $("khist").onclick = () => { $("ksheet").hidden = false; loadSeries(); };
  $("kclose").onclick = () => { $("ksheet").hidden = true; };
  $("kranges").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    hrange = b.dataset.r;
    el.querySelectorAll("#kranges button").forEach(x => x.classList.toggle("active", x === b));
    loadSeries();
  };

  load();
  const poll = setInterval(load, POLL_MS);
  const tick = setInterval(render, 30000);
  return () => { alive = false; clearInterval(poll); clearInterval(tick); Object.values(charts).forEach(c => c.destroy()); };
}
