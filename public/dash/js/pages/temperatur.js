import { css, fmt1, ageText, bandChart, esc, api, apiSWR, ensureChart } from "../util.js";

const REFRESH_MS = 60000;      // Kacheln
const SERIES_EVERY = 5;        // Verlauf alle 5 Kachel-Updates

export function mount(el) {
  el.innerHTML = `
    <div class="sub" id="updated">Lade Daten …</div>
    <div class="grid" id="grid"></div>
    <div class="note" id="note" hidden></div>
    <section class="sheet" id="sheet" hidden>
      <div class="dhead">
        <h2 id="dtitle"></h2>
        <div class="dctl">
          <div class="ranges" id="ranges">
            <button data-r="24h" class="active">24 h</button>
            <button data-r="7d">7 Tage</button>
            <button data-r="30d">30 Tage</button>
            <button data-r="1y">1 Jahr</button>
          </div>
          <button class="close" id="close" aria-label="Schliessen">✕</button>
        </div>
      </div>
      <div class="charts">
        <div class="panel"><div class="chartlabel">Temperatur (°C) – Mittelwert mit Min/Max-Band</div>
          <div class="chartbox"><canvas id="cTemp"></canvas></div></div>
        <div class="panel"><div class="chartlabel" id="lblHum">Luftfeuchtigkeit (%)</div>
          <div class="chartbox"><canvas id="cHum"></canvas></div></div>
      </div>
      <div class="err" id="derr" hidden></div>
    </section>`;

  const $ = id => el.querySelector("#" + id);
  let current = null, range = "24h", charts = {}, ticks = 0, alive = true;

  // ---- Kacheln ----
  function tileRows(s) {
    const range = `<div class="row"><span>24h range</span><b>${fmt1(s.temp_min24)}–${fmt1(s.temp_max24)} °C</b></div>`;
    const hum = `<div class="row"><span>Humidity</span><b>${s.hum == null ? "–" : Math.round(s.hum) + " %"}</b></div>`;
    if (s.kind === "mystrom") {
      const relay = s.relay == null ? "–" : (s.relay ? "on" : "off");
      return `<div class="row"><span>Power</span><b>${s.power == null ? "–" : fmt1(s.power) + " W"}</b></div>
              <div class="row"><span>Relay</span><b>${relay}</b></div>${range}`;
    }
    if (s.kind === "outdoor") {
      return `${hum}${range}
              <div class="sums">24h: rain <b>${fmt1(s.precip24)} mm</b> · sun <b>${fmt1(s.sun24_h)} h</b></div>`;
    }
    return `${hum}${range}
            <div class="row"><span>Battery</span><b>${s.battery == null ? "–" : Math.round(s.battery) + " %"}</b></div>`;
  }

  let innerD = null, outerD = null, errs = {};

  function paint() {
    if (!alive) return;
    const sensors = (innerD || []).slice().sort((x, y) => x.name.localeCompare(y.name, "de"));
    const tiles = outerD ? [outerD, ...sensors] : sensors;
    const grid = $("grid");
    grid.innerHTML = "";
    for (const s of tiles) {
      const a = s.date ? ageText(s.date, s.kind === "outdoor" ? 40 : 30) : { t: "no data", stale: true };
      const b = document.createElement("button");
      b.className = "tile";
      b.innerHTML = `
        <div class="name"><span class="dot ${a.stale ? "stale" : ""}"></span>${esc(s.name)}</div>
        <div class="temp">${fmt1(s.temp)}<small> °C</small></div>${tileRows(s)}
        <div class="age">Updated: ${a.t}</div>`;
      b.onclick = () => openDetail(s);
      grid.appendChild(b);
    }
    const msgs = Object.values(errs);
    const note = $("note");
    note.hidden = !msgs.length;
    note.textContent = msgs.join(" · ");
    $("updated").textContent = msgs.length && !tiles.length ? "Keine Daten verfügbar"
      : "Aktualisiert " + new Date().toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
  }

  // Zwischenspeicher zeigt sofort etwas an, die frischen Daten ersetzen es (beide Quellen parallel)
  async function loadLatest() {
    await Promise.allSettled([
      apiSWR("latest", d => { innerD = d; delete errs.inner; paint(); })
        .catch(e => { errs.inner = "Innensensoren: " + e.message; paint(); }),
      apiSWR("outdoor/latest", d => { outerD = d; delete errs.outer; paint(); })
        .catch(e => { errs.outer = "Aussen Kloten: " + e.message; paint(); }),
    ]);
  }

  // ---- Verlauf ----
  function openDetail(s) {
    current = s;
    $("dtitle").textContent = s.name;
    $("sheet").hidden = false;
    loadSeries();
  }

  function draw(id, points, opts) {
    if (charts[id]) charts[id].destroy();
    charts[id] = bandChart($(id), points, { ...opts, range });
  }

  async function loadSeries() {
    if (!current) return;
    const err = $("derr");
    err.hidden = true;
    try {
      const url = current.kind === "outdoor"
        ? `outdoor/series?range=${range}`
        : `series?sensor=${encodeURIComponent(current.id)}&range=${range}`;
      const [d] = await Promise.all([api(url), ensureChart()]);
      if (!alive) return;
      draw("cTemp", d.temp, { color: css("--temp"), unit: "°C", dec: 1, minSpan: 1 });
      if (d.power) {
        $("lblHum").textContent = "Leistung (W)";
        draw("cHum", d.power, { color: css("--hum"), unit: "W", dec: 0, minSpan: 10, floor0: true });
      } else {
        $("lblHum").textContent = "Luftfeuchtigkeit (%)";
        draw("cHum", d.hum, { color: css("--hum"), unit: "%", dec: 0, minSpan: 5 });
      }
    } catch (e) {
      err.textContent = "Fehler beim Laden des Verlaufs: " + e.message;
      err.hidden = false;
    }
  }

  $("ranges").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    range = b.dataset.r;
    el.querySelectorAll("#ranges button").forEach(x => x.classList.toggle("active", x === b));
    loadSeries();
  };
  $("close").onclick = () => { $("sheet").hidden = true; current = null; };

  loadLatest();
  const timer = setInterval(() => {
    loadLatest();
    if (current && ++ticks % SERIES_EVERY === 0) loadSeries();
  }, REFRESH_MS);

  return () => { alive = false; clearInterval(timer); Object.values(charts).forEach(c => c.destroy()); };
}
