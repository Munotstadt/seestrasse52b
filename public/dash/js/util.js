// ---------- Gemeinsame Basis für lokale (NAS) und Online-Version ----------
// Alle Seiten sprechen nur diese zwei Dinge an: api() und cfg (config.js wird vom jeweiligen Backend geliefert).
export const API_BASE = new URL("api/", document.baseURI).pathname;   // "/dash/api/"

export async function api(path, opts) {
  const r = await fetch(API_BASE + path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}

// Stale-while-revalidate für GET: zeigt sofort die letzte Antwort (localStorage), lädt danach frisch nach.
// cb(daten, { cached }) wird 0–2× aufgerufen. Gibt das Promise der frischen Antwort zurück (wirft bei Fehler).
const SWR_MAX_AGE = 6 * 3600e3;
export async function apiSWR(path, cb) {
  const key = "dash:" + path;
  try {
    const hit = JSON.parse(localStorage.getItem(key) || "null");
    if (hit && Date.now() - hit.t < SWR_MAX_AGE) cb(hit.d, { cached: true });
  } catch {}
  const d = await api(path);
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch {}
  cb(d, { cached: false });
  return d;
}

// Chart.js (205 KB) wird nur geladen, wenn ein Diagramm gebraucht wird
let chartP = null;
export function ensureChart() {
  if (window.Chart) return Promise.resolve();
  return chartP ??= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = new URL("vendor/chart.umd.js", document.baseURI).href;
    s.onload = ok; s.onerror = () => { chartP = null; fail(new Error("Chart.js nicht ladbar")); };
    document.head.appendChild(s);
  });
}

export const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const fmt1 = v => (v == null ? "–" : Number(v).toFixed(1));
export const fmtN = (v, dec) => Number(v).toFixed(dec);
export const parseLocal = s => new Date(s);   // API liefert ISO-UTC, der Browser rechnet in Ortszeit um
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function ageText(s, staleMin = 30) {
  const min = Math.round((Date.now() - parseLocal(s)) / 60000);
  if (min < 1) return { t: "now", stale: false };
  if (min < 60) return { t: `${min} min`, stale: min > staleMin };
  const h = Math.floor(min / 60);
  if (h < 48) return { t: `${h} h`, stale: true };
  return { t: `${Math.floor(h / 24)} d`, stale: true };
}

export function xLabel(t, range) {
  const d = parseLocal(t);
  const time = d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
  if (range === "24h") return time;
  const date = d.toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit" });
  return range === "1y" ? date : `${date} ${time}`;
}

// Liniendiagramm mit Min/Max-Band. dec = Nachkommastellen der Y-Achse,
// minSpan = Mindestspanne der Y-Achse, floor0 = Achse nie unter 0.
export function bandChart(canvas, points, { color, unit, dec, minSpan, floor0, range }) {
  const vals = points.flatMap(p => [p.min, p.max, p.avg]).filter(v => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const yRange = {};
  if (vals.length && hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    yRange.min = Math.floor((mid - minSpan / 2) * 10 ** dec) / 10 ** dec;
    yRange.max = Math.ceil((mid + minSpan / 2) * 10 ** dec) / 10 ** dec;
    if (floor0 && yRange.min < 0) { yRange.max -= yRange.min; yRange.min = 0; }
  } else if (floor0 && vals.length && lo >= 0) {
    yRange.min = 0;
  }
  return new Chart(canvas, {
    type: "line",
    data: {
      labels: points.map(p => xLabel(p.t, range)),
      datasets: [
        { label: "Min", data: points.map(p => p.min), borderWidth: 0, pointRadius: 0, fill: false },
        { label: "Max", data: points.map(p => p.max), borderWidth: 0, pointRadius: 0, fill: "-1", backgroundColor: color + "33" },
        { label: "Mittel", data: points.map(p => p.avg), borderColor: color, borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 4, tension: .25, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt1(c.parsed.y)} ${unit}` } } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, maxRotation: 0, color: css("--muted") }, grid: { display: false } },
        y: { ...yRange,
             ticks: { color: css("--muted"), precision: dec, callback: v => fmtN(v, dec) + " " + unit },
             grid: { color: css("--line") } },
      },
    },
  });
}
