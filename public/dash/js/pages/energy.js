import { css, esc, ageText, fmtN, api, ensureChart } from "../util.js";

const POLL_MS = 30000;
const RANGES = [["today", "Today"], ["24h", "24 h"], ["7d", "7 days"]];
const COLORS = { production: "#f2b705", consumption: "#d62728", grid: "#6b7280" };

const kw = w => (w == null ? "–" : fmtN(w / 1000, 2));
const kwh = v => (v == null ? "–" : fmtN(v, v >= 100 ? 0 : 1));
const net = (a, b) => (a == null || b == null ? null : a - b);   // Bezug – Einspeisung (> 0 = Bezug)
const pct = v => (v == null ? "–" : fmtN(v, 0));

export function mount(el) {
  let range = "today", chart = null, alive = true;

  el.innerHTML = `
    <div class="energy">
      <div class="chartlabel egroup">Current <span id="eage"></span></div>
      <div class="grid" id="enow">
        ${["Consumption", "Production", "Grid (net)", "from Grid", "to Grid"].map((n, i) =>
          `<div class="tile"><div class="name">${n}</div><div class="big" id="en${i}">–<small> kW</small></div></div>`).join("")}
      </div>
      <div class="chartlabel egroup">Energy</div>
      <div class="grid esum" id="esum"></div>
      <div class="chartlabel egroup">Power</div>
      <div class="panel echart">
        <div class="ranges" id="eranges">
          ${RANGES.map(([r, l]) => `<button data-r="${r}" class="${r === range ? "active" : ""}">${l}</button>`).join("")}
        </div>
        <div class="chartbox"><canvas id="ecanvas"></canvas></div>
        <div class="elegend">
          <span><i style="background:${COLORS.production}"></i>Production</span>
          <span><i style="background:${COLORS.consumption}"></i>Consumption</span>
          <span><i style="background:${COLORS.grid}"></i>Grid (&gt;0 from, &lt;0 to)</span>
        </div>
      </div>
      <div class="chartlabel egroup">Last 15 months</div>
      <div class="panel etable" id="emonths"></div>
      <div class="chartlabel egroup">Years</div>
      <div class="panel etable" id="eyears"></div>
      <div class="note" id="eerr" hidden></div>
    </div>`;
  const $ = id => el.querySelector("#" + id);
  const setErr = m => { $("eerr").hidden = !m; $("eerr").textContent = m || ""; };

  const getJson = path => api(path);

  async function loadNow() {
    try {
      const d = await getJson("energy/latest");
      if (!alive) return;
      if (!d) { setErr("No data yet"); return; }
      [d.consumption, d.production, net(d.fromGrid, d.toGrid), d.fromGrid, d.toGrid].forEach((v, i) => {
        $("en" + i).innerHTML = `${kw(v)}<small> kW</small>`;
      });
      const a = ageText(d.t, 10);
      $("eage").textContent = "· updated " + a.t;
      $("eage").style.color = a.stale ? "#c0392b" : "";
      setErr("");
    } catch (e) { if (alive) setErr(e.message); }
  }

  const ROWS = [["Consumption", "consumption", "kWh", kwh], ["Production", "production", "kWh", kwh],
    ["Grid (net)", "netGrid", "kWh", kwh], ["from Grid", "fromGrid", "kWh", kwh], ["to Grid", "toGrid", "kWh", kwh],
    ["Self", "selfPct", "%", pct], ["Autarky", "autarkyPct", "%", pct]];

  async function loadSummary() {
    try {
      const d = await getJson("energy/summary");
      if (!alive) return;
      $("esum").innerHTML = [["Today", d.today], ["MtD", d.mtd], ["YtD", d.ytd]].map(([title, v]) => `
        <div class="wcard">
          <div class="wtop"><span class="wname">${esc(title)}</span></div>
          ${ROWS.map(([l, k, u, f]) => `<div class="crow"><span>${l}</span><b>${f(k === "netGrid" ? net(v?.fromGrid, v?.toGrid) : v?.[k])} ${u}</b></div>`).join("")}
        </div>`).join("");
    } catch (e) { if (alive) setErr(e.message); }
  }

  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const table = (rows, label) => `<table><thead><tr><th>${label}</th>${["Consumption", "Production", "Grid (net)", "from Grid", "to Grid"].map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
    rows.map(r => `<tr><td>${esc(r.label)}</td>${[r.consumption, r.production, net(r.fromGrid, r.toGrid), r.fromGrid, r.toGrid].map(v => `<td>${kwh(v)}</td>`).join("")}</tr>`).join("")
  }</tbody></table><div class="eunit">kWh</div>`;

  async function loadHistory() {
    try {
      const d = await getJson("energy/history");
      if (!alive) return;
      $("emonths").innerHTML = table((d.months || []).map(r => ({ ...r, label: `${MON[+r.k.slice(5) - 1]} ${r.k.slice(0, 4)}` })), "Month");
      $("eyears").innerHTML = table((d.years || []).map(r => ({ ...r, label: r.k })), "Year");
    } catch (e) { if (alive) setErr(e.message); }
  }

  async function loadChart() {
    try {
      const [d] = await Promise.all([getJson("energy/series?range=" + range), ensureChart()]);
      if (!alive) return;
      const pts = d.points || [];
      const fmtT = t => {
        const x = new Date(t);
        const time = x.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
        return range === "7d" ? `${x.toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit" })} ${time}` : time;
      };
      const ds = (label, key, dash) => ({ label, data: pts.map(p => p[key]), borderColor: COLORS[key], borderWidth: 2,
        pointRadius: 0, pointHoverRadius: 4, tension: .2, spanGaps: false, borderDash: dash || [] });
      if (chart) chart.destroy();
      chart = new Chart($("ecanvas"), {
        type: "line",
        data: { labels: pts.map(p => fmtT(p.t)), datasets: [ds("Production", "production"), ds("Consumption", "consumption"), ds("Grid", "grid", [5, 3])] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { display: false },
            tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? "–" : fmtN(c.parsed.y / 1000, 2)} kW` } } },
          scales: {
            x: { ticks: { maxTicksLimit: 6, maxRotation: 0, color: css("--muted") }, grid: { display: false } },
            y: { ticks: { color: css("--muted"), callback: v => fmtN(v / 1000, 1) + " kW" }, grid: { color: css("--line") } },
          },
        },
      });
      setErr("");
    } catch (e) { if (alive) setErr("Chart: " + e.message); }
  }

  $("eranges").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    range = b.dataset.r;
    el.querySelectorAll("#eranges button").forEach(x => x.classList.toggle("active", x === b));
    loadChart();
  };

  ensureChart();   // parallel zu den Daten vorladen
  const refresh = () => { loadNow(); loadSummary(); loadChart(); };
  loadHistory();   // ändert sich nur täglich → nicht im 30-s-Poll
  const histPoll = setInterval(loadHistory, 600000);
  refresh();
  const poll = setInterval(refresh, POLL_MS);
  return () => { alive = false; clearInterval(poll); clearInterval(histPoll); if (chart) chart.destroy(); };
}
