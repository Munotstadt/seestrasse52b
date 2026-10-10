// Seitenregister. Der Zustand jeder Seite je Umgebung kommt aus config.js (vom Backend geliefert):
//   cfg.pages[id] = "live"    → Seite aktiv
//               "pending" → Reiter sichtbar, aber ausgegraut («pendent»)
// Eine neue Subpage freischalten = hier eintragen + in beiden config.js (lokal: dash-local/server.js, online: src/dash/index.js).
// Jedes Seitenmodul exportiert mount(el) und liefert eine unmount()-Funktion zurück.
import cfg from "../config.js";

export const PAGES = [
  { id: "temperatur", label: "Temperatur",   module: "./pages/temperatur.js" },
  { id: "water",      label: "Water",        module: "./pages/water.js" },
  { id: "storen",     label: "Blinds/Light", module: "./pages/rooms.js" },
  { id: "energy",     label: "Energy",       module: "./pages/energy.js" },
  { id: "car",        label: "Car",          module: "./pages/car.js" },
];
const state = id => (cfg.pages && cfg.pages[id]) || "live";
const isLive = p => p.module && state(p.id) === "live";

// ?theme=dark|light erzwingt ein Farbschema (sonst System-Einstellung)
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

const nav = document.getElementById("nav");
const view = document.getElementById("view");
let unmount = null, token = 0;

nav.innerHTML = PAGES.map(p => isLive(p)
  ? `<a class="tab" data-id="${p.id}" href="#/${p.id}">${p.label}</a>`
  : `<a class="tab disabled" data-id="${p.id}" href="#/${p.id}" title="pendent">${p.label}<small>pendent</small></a>`).join("");

async function route() {
  const id = location.hash.replace(/^#\//, "");
  const wanted = PAGES.find(p => p.id === id && p.module);
  const page = wanted || PAGES.find(isLive);
  const my = ++token;
  if (unmount) { try { unmount(); } catch {} unmount = null; }
  view.innerHTML = "";
  nav.querySelectorAll("a.tab").forEach(a => a.classList.toggle("active", a.dataset.id === page.id));
  if (!isLive(page)) {   // «pendent»: Seite gehört dazu, hat in dieser Umgebung aber noch keine Datenquelle
    view.innerHTML = `<div class="pending">${page.label}: in dieser Ansicht noch pendent.</div>`;
    return;
  }
  try {
    const mod = await import(page.module);
    if (my !== token) return;
    unmount = (await mod.mount(view)) || null;
  } catch (e) {
    view.innerHTML = `<div class="note">Seite konnte nicht geladen werden: ${String(e.message || e)}</div>`;
  }
}
window.addEventListener("hashchange", route);
route();

const clock = document.getElementById("clock");
const tick = () => { clock.textContent = new Date().toLocaleString("de-CH", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
tick(); setInterval(tick, 15000);

// Badge: Umgebung + Hash des ausgelieferten UI-Stands. Zeigen beide Ansichten denselben Hash, sind sie synchron.
fetch("version.json").then(r => r.json()).then(v => {
  document.getElementById("ver").innerHTML = `${cfg.mode === "local" ? "lokal" : "online"} · <b>${String(v.hash || "").slice(0, 7)}</b>`;
}).catch(() => { document.getElementById("ver").textContent = cfg.mode === "local" ? "lokal" : "online"; });
