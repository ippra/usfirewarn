// engine.js - US FireWarn.
//
// Loads data/manifest.json and data/warnings.geojson, which
// 02_build_warnings.R wrote, and draws them with MapLibre. Every count on the
// page is taken from the same filtered rows, so the map, the tiles, the
// rankings and the list always describe the same selection. The timeline
// counts the warnings the search and filters keep, across every date, so it
// shows where in time the selection could move.

import * as maplibregl from "./assets/vendor/maplibre-gl-6.10.0/maplibre-gl.mjs";

window.USF_ENGINE_LOADED = true;

const DAY_MS = 86400000;
const REFRESH_MS = 10 * 60 * 1000;
const US_BOUNDS = [[-125.0, 24.5], [-66.5, 49.5]];
// Rows the warning list and the rankings show before "Show all".
const LIST_N = 30;
const RANK_N = 8;
const HISTORY_N = 5;
// Width of the open warning drawer, which the map pads its fits around.
const DETAIL_W = 540;

// Palettes ---------------------------------------------------------------------
// Fire Warnings are violet on every IPPRA fire map (OK FireWarn checked it
// against each base map's background with the dataviz palette validator); the
// selected warning takes the base map's strongest contrast instead of a
// second hue.
const PALETTE = {
  dark: { warn: "#9085e9", ring: "#0e0e0e", stateLine: "rgba(255,255,255,0.55)", selected: "#ffffff" },
  light: { warn: "#4a3aa7", ring: "#fafaf8", stateLine: "rgba(40,30,20,0.6)", selected: "#1c1b19" },
};

const CARTO = "https://basemaps.cartocdn.com/gl/";
const BASEMAPS = {
  dark: { label: "Dark", tone: "dark", style: CARTO + "dark-matter-gl-style/style.json" },
  light: { label: "Light", tone: "light", style: CARTO + "positron-gl-style/style.json" },
  streets: { label: "Streets", tone: "light", style: CARTO + "voyager-gl-style/style.json" },
  satellite: {
    label: "Satellite",
    tone: "dark",
    style: {
      version: 8,
      sources: {
        imagery: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          maxzoom: 19,
          attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
        },
        // CARTO's raster label tiles now need an API key and return a tile
        // reading "API KEY REQUIRED" without one; Esri's reference layer,
        // drawn for use over its imagery, does not.
        labels: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          maxzoom: 19,
          attribution: "Labels &copy; Esri",
        },
      },
      layers: [
        { id: "imagery", type: "raster", source: "imagery" },
        { id: "sat-labels", type: "raster", source: "labels" },
      ],
    },
  },
};

const PRESETS = [
  { id: "all", label: "All years" },
  { id: "12m", label: "12 months", len: 365 },
  { id: "ytd", label: "Year to date" },
  { id: "90d", label: "90 days", len: 90 },
];
const DEFAULT_PRESET = "all";

const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const stateName = (s) => STATE_NAMES[s] || s;

// State ------------------------------------------------------------------------
const state = {
  start: 0,
  end: 0,
  preset: DEFAULT_PRESET,
  basemap: "dark",
  zoom: "all",
  office: "",
  st: "",
  q: "",
  rank: "office",
  selected: null, // product id of the warning open in the drawer
};

let manifest = null;
let epochMs = 0;
let warnings = []; // features from 02_build_warnings.R, in issue order
let byId = new Map();
let haystack = []; // lowercased searchable text per warning
let warningText = null; // full product text, fetched on first need
let textRequest = null;
let cumulative = null; // prefix sums of warnings issued per day, filters applied
let current = null; // the last selection drawn
let styleReady = false;
let showAllWarnings = false;
let showAllRank = false;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");
const plural = (n, one, many = one + "s") => `${nf.format(n)} ${n === 1 ? one : many}`;

function emptyFC() {
  return { type: "FeatureCollection", features: [] };
}

// Dates ------------------------------------------------------------------------
// Day indexes count local calendar days from the epoch: each warning is dated
// where it was issued. They are handled as UTC midnights so that no browser
// time zone can shift a date by one.
const dayDate = (d) => new Date(epochMs + d * DAY_MS);
const iso = (d) => dayDate(d).toISOString().slice(0, 10);
const isoToDay = (s) => Math.round((Date.parse(s + "T00:00:00Z") - epochMs) / DAY_MS);
const fmtDay = (d, o = {}) =>
  dayDate(d).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", ...o });
const clampDay = (d) => Math.max(0, Math.min(manifest.latest_day, d));

function fmtRange(a, b) {
  if (a === b) return fmtDay(a, { weekday: "short" });
  const da = dayDate(a), db = dayDate(b);
  const sameYear = da.getUTCFullYear() === db.getUTCFullYear();
  return `${fmtDay(a, sameYear ? { year: undefined } : {})} – ${fmtDay(b)}`;
}

// A warning's own local time: the build stores each one's offset from UTC, so
// the minutes are shifted and then printed as if UTC.
const fmtLocal = (minute, w, o) =>
  new Date((minute + w.off) * 60000).toLocaleString("en-US", { timeZone: "UTC", ...o });

function fmtIssued(w) {
  return `${fmtLocal(w.t0, w, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })} ${w.tz}`;
}

function fmtUntil(w) {
  const sameDay = w.d0 === w.d1;
  const o = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { weekday: "short", hour: "numeric", minute: "2-digit" };
  return `${fmtLocal(w.t1, w, o)} ${w.tz}`;
}

// Data -------------------------------------------------------------------------
async function fetchManifest() {
  const r = await fetch(`data/manifest.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
  return r.json();
}

async function fetchWarnings(build) {
  const r = await fetch(`data/warnings.geojson?v=${build}`);
  if (!r.ok) throw new Error(`warnings.geojson: HTTP ${r.status}`);
  const fc = await r.json();
  fc.features.forEach((f, i) => { f.id = i; });
  return fc.features;
}

function applyData(m, features) {
  manifest = m;
  epochMs = Date.parse(m.epoch + "T00:00:00Z");
  warnings = features;
  byId = new Map(features.map((f) => [f.properties.id, f]));
  warningText = null;
  textRequest = null;
  buildHaystack();
}

// The full text is half a megabyte, so it waits for the first search or the
// first warning opened.
function loadText() {
  if (warningText) return Promise.resolve(warningText);
  if (!textRequest) {
    textRequest = fetch(`data/warning_text.json?v=${manifest.build}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((t) => { warningText = t; buildHaystack(); return t; })
      .catch((e) => { textRequest = null; throw e; });
  }
  return textRequest;
}

// Products are hard-wrapped at about 69 characters, so a phrase typed on one
// line is often split across two in the text. Whitespace is collapsed on both
// sides before matching.
const squish = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

function buildHaystack() {
  haystack = warnings.map((f) => {
    const w = f.properties;
    const parts = [w.id, w.office, w.office_name, w.areas, w.requested_by, w.summary];
    if (warningText) parts.push(warningText[w.id]);
    return squish(parts.join(" "));
  });
}

// Selection --------------------------------------------------------------------
function matchesFilters(f) {
  const w = f.properties;
  if (state.office && w.office !== state.office) return false;
  if (state.st && !w.states.split(",").includes(state.st)) return false;
  if (state.q && !haystack[f.id].includes(state.q)) return false;
  return true;
}

// A warning belongs to every local day it was in force.
const inDates = (w) => w.d0 <= state.end && w.d1 >= state.start;

function buildCumulative() {
  const n = manifest.latest_day + 2;
  const perDay = new Uint32Array(n);
  for (const f of warnings) if (matchesFilters(f)) perDay[clampDay(f.properties.d0)]++;
  cumulative = new Uint32Array(n + 1);
  for (let d = 0; d < n; d++) cumulative[d + 1] = cumulative[d] + perDay[d];
}

const countDays = (a, b) => cumulative[Math.min(b, manifest.latest_day) + 1] - cumulative[Math.max(a, 0)];

function tally(rows, keys) {
  const counts = new Map();
  for (const f of rows) for (const k of keys(f.properties)) counts.set(k, (counts.get(k) || 0) + 1);
  return [...counts].sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])));
}

function update({ fit = false } = {}) {
  const rows = warnings
    .filter((f) => matchesFilters(f) && inDates(f.properties))
    .sort((x, y) => y.properties.t0 - x.properties.t0);
  current = { rows, a: state.start, b: state.end };
  renderMap();
  renderTiles();
  renderLegend();
  renderRank();
  renderWarnings();
  syncControls();
  drawTimeline();
  writeHash();
  if (fit) fitToRows();
}

// Search and filters change which warnings the timeline counts; dates do not.
function filtersChanged() {
  buildCumulative();
  showAllWarnings = false;
  update({ fit: true });
}

// Map --------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: BASEMAPS.dark.style,
  bounds: US_BOUNDS,
  fitBoundsOptions: { padding: mapPadding() },
  minZoom: 2.5,
  maxZoom: 16,
  attributionControl: { compact: true },
  canvasContextAttributes: { preserveDrawingBuffer: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.FullscreenControl({ container: $("stage") }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

const tone = () => BASEMAPS[state.basemap].tone;
const wide = () => window.matchMedia("(min-width: 821px)").matches;

function mapPadding() {
  const drawer = !$("detail").hidden && wide() ? DETAIL_W : 0;
  return { top: 60, bottom: 170, left: 40, right: 40 + drawer };
}

function addOverlays() {
  const P = PALETTE[tone()];
  const layers = map.getStyle().layers;
  const firstSymbol = layers.find((l) => l.type === "symbol" || l.id === "sat-labels");
  const before = firstSymbol ? firstSymbol.id : undefined;

  map.addSource("usf-states", { type: "geojson", data: "data/states.geojson?v=" + manifest.build });
  map.addSource("usf-warnings", { type: "geojson", data: emptyFC() });
  map.addSource("usf-marks", { type: "geojson", data: emptyFC() });
  map.addSource("usf-selected", { type: "geojson", data: emptyFC() });

  map.addLayer({
    id: "usf-state-line", type: "line", source: "usf-states",
    paint: { "line-color": P.stateLine, "line-width": 0.8 },
  }, before);
  // Fills are faint so that warnings stacked on one place read as darker
  // ground. A warning drawn from whole counties, with no polygon of its own,
  // is dashed.
  map.addLayer({
    id: "usf-warn-fill", type: "fill", source: "usf-warnings",
    paint: { "fill-color": P.warn, "fill-opacity": 0.12 },
  }, before);
  map.addLayer({
    id: "usf-warn-line", type: "line", source: "usf-warnings",
    filter: ["==", ["get", "polygon"], true],
    paint: { "line-color": P.warn, "line-width": 1.8 },
  }, before);
  map.addLayer({
    id: "usf-warn-county", type: "line", source: "usf-warnings",
    filter: ["==", ["get", "polygon"], false],
    paint: { "line-color": P.warn, "line-width": 1.4, "line-dasharray": [2, 1.5] },
  }, before);
  // A warning polygon is a few miles across and vanishes on a national map, so
  // each warning also gets a dot that fades out as the shapes become visible.
  map.addLayer({
    id: "usf-marks", type: "circle", source: "usf-marks",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3, 7, 5],
      "circle-color": P.warn,
      "circle-stroke-color": P.ring,
      "circle-stroke-width": 1,
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 0.85, 8.5, 0],
      "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 0.85, 8.5, 0],
    },
  });
  map.addLayer({
    id: "usf-selected-line", type: "line", source: "usf-selected",
    filter: ["!=", ["geometry-type"], "Point"],
    paint: { "line-color": P.selected, "line-width": 3 },
  });
  map.addLayer({
    id: "usf-selected-mark", type: "circle", source: "usf-selected",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 7,
      "circle-color": P.warn,
      "circle-stroke-color": P.selected,
      "circle-stroke-width": 2.5,
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 1, 8.5, 0],
      "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 1, 8.5, 0],
    },
  });
  styleReady = true;
}

function markOf(f) {
  const w = f.properties;
  return { type: "Feature", id: f.id, properties: {}, geometry: { type: "Point", coordinates: [w.lon, w.lat] } };
}

function renderMap() {
  if (!styleReady || !current) return;
  map.getSource("usf-warnings").setData({ type: "FeatureCollection", features: current.rows });
  map.getSource("usf-marks").setData({ type: "FeatureCollection", features: current.rows.map(markOf) });
  renderSelected();
}

// The open warning stays outlined even when the dates or filters no longer
// include it, so the drawer never describes something the map does not show.
function renderSelected() {
  if (!styleReady) return;
  const f = byId.get(state.selected);
  map.getSource("usf-selected").setData({
    type: "FeatureCollection",
    features: f ? [f, markOf(f)] : [],
  });
}

function boundsOf(features) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
      y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
    } else c.forEach(walk);
  };
  for (const f of features) walk(f.geometry.coordinates);
  return [[x0, y0], [x1, y1]];
}

// The whole archive is framed as the country; anything narrower as the
// warnings it holds.
function fitToRows() {
  if (!current.rows.length) return;
  const all = !state.office && !state.st && !state.q && state.preset === "all";
  map.fitBounds(all ? US_BOUNDS : boundsOf(current.rows), { padding: mapPadding(), maxZoom: 9 });
}

// Map Interaction --------------------------------------------------------------
const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px", offset: 8 });

function warningsAt(point) {
  if (!styleReady) return [];
  const pad = 5;
  const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
  const hits = [
    ...map.queryRenderedFeatures(box, { layers: ["usf-marks"] }),
    ...map.queryRenderedFeatures(point, { layers: ["usf-warn-fill"] }),
  ];
  return [...new Set(hits.map((f) => f.id))]
    .map((i) => warnings[i])
    .sort((x, y) => y.properties.t0 - x.properties.t0);
}

map.on("click", (e) => {
  const hits = warningsAt(e.point);
  if (!hits.length) return;
  if (hits.length === 1) { selectWarning(hits[0].properties.id); return; }
  // Several warnings cover the spot: the reader picks one.
  const el = document.createElement("div");
  line(el, "pop-warn", `${hits.length} Fire Warnings here`);
  const list = document.createElement("ol");
  list.className = "warning-list";
  for (const f of hits) list.appendChild(warningRow(f, () => popup.remove()));
  el.appendChild(list);
  popup.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
});

map.on("mousemove", (e) => {
  map.getCanvas().style.cursor = warningsAt(e.point).length ? "pointer" : "";
});

map.on("moveend", () => writeHash());

function line(parent, cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  parent.appendChild(d);
  return d;
}

// Warning Drawer ---------------------------------------------------------------
function selectWarning(id, { fly = true } = {}) {
  const f = byId.get(id);
  if (!f) return;
  state.selected = id;
  renderDetail(f);
  renderSelected();
  markSelectedRow();
  if (fly) map.fitBounds(boundsOf([f]), { padding: mapPadding(), maxZoom: 10 });
  writeHash();
}

function closeDetail() {
  state.selected = null;
  $("detail").hidden = true;
  renderSelected();
  markSelectedRow();
  writeHash();
}

function renderDetail(f) {
  const w = f.properties;
  const body = $("detail-body");
  body.textContent = "";
  line(body, "pop-warn", "⚠ Fire Warning").setAttribute("aria-label", "Fire Warning");
  line(body, "detail-when", `${fmtIssued(w)} until ${fmtUntil(w)}`);
  line(body, "detail-where", w.areas);
  line(body, "pop-meta", w.office_name + (w.eas ? " · EAS activation requested" : ""));
  if (w.requested_by) line(body, "pop-meta", `Requested by ${w.requested_by}`);
  line(body, "pop-meta", w.polygon
    ? "The outline is the polygon in the warning."
    : "No polygon issued: shown as the whole of each county named.");

  const links = document.createElement("div");
  links.className = "pop-links";
  const zoom = document.createElement("button");
  zoom.type = "button";
  zoom.className = "link-btn";
  zoom.textContent = "Zoom to it";
  zoom.addEventListener("click", () => map.fitBounds(boundsOf([f]), { padding: mapPadding(), maxZoom: 11 }));
  const day = document.createElement("button");
  day.type = "button";
  day.className = "link-btn";
  day.textContent = "Everything that day";
  day.addEventListener("click", () => setRange(w.d0, w.d0, { fit: true }));
  const iem = document.createElement("a");
  iem.href = w.url;
  iem.target = "_blank";
  iem.rel = "noopener";
  iem.textContent = "Original at IEM";
  links.append(zoom, day, iem);
  body.appendChild(links);

  const pre = document.createElement("pre");
  pre.className = "detail-text";
  pre.textContent = w.summary;
  body.appendChild(pre);
  loadText()
    .then((t) => { if (state.selected === w.id) pre.textContent = (t[w.id] || "").trim(); })
    .catch((err) => toast("Could not load the warning text: " + err.message));

  $("detail").hidden = false;
  $("detail").scrollTop = 0;
}

function markSelectedRow() {
  for (const b of document.querySelectorAll(".warning-list button[data-id]")) {
    b.setAttribute("aria-pressed", String(b.dataset.id === state.selected));
  }
}

$("detail-close").addEventListener("click", closeDetail);

// Base Maps --------------------------------------------------------------------
function setBasemap(id, { initial = false } = {}) {
  if (!BASEMAPS[id]) id = "dark";
  const changed = id !== state.basemap || initial;
  state.basemap = id;
  syncBasemapButtons();
  if (!changed) return;
  styleReady = false;
  currentStyleLoaded = false;
  usingFallback = false;
  map.setStyle(BASEMAPS[id].style, { diff: false });
  writeHash();
}

// Every style load, the first included, wipes our sources and layers. The
// first one can finish before the manifest arrives, so overlays wait for both.
// If a base map's style cannot be fetched, fall back to a plain background so
// the state lines and every warning still draw.
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0e0e0e" } }],
};
let usingFallback = false;
let currentStyleLoaded = false;
map.on("error", (e) => {
  const msg = String((e && e.error && e.error.message) || "");
  if (usingFallback || currentStyleLoaded || !/style|Failed to fetch|NetworkError|Load failed/i.test(msg)) return;
  usingFallback = true;
  toast("The base map could not load; showing warnings on a plain background.", 6000);
  map.setStyle(FALLBACK_STYLE, { diff: false });
});

let firstStyleLoaded = false;
map.on("style.load", () => {
  firstStyleLoaded = true;
  currentStyleLoaded = true;
  if (!manifest) return;
  addOverlays();
  if (current) renderMap();
});

function syncBasemapButtons() {
  for (const b of $("basemaps").children) b.setAttribute("aria-checked", String(b.dataset.basemap === state.basemap));
}

// Timeline ---------------------------------------------------------------------
const tl = { canvas: $("timeline"), drag: null, colors: null, layout: null };

function readColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  tl.colors = { out: v("--bar-out"), grid: v("--grid"), muted: v("--muted"), text: v("--text"), accent: v("--accent"), warn: v("--warn") };
}

function timelineDomain() {
  const latest = manifest.latest_day;
  if (state.zoom === "all") return [0, latest];
  if (state.zoom === "year") {
    // The calendar year the range ends in, stretched back when the range
    // starts earlier so the selection is never cut off.
    const y = dayDate(state.end).getUTCFullYear();
    const a = Math.min(state.start, isoToDay(`${y}-01-01`)), b = isoToDay(`${y}-12-31`);
    return [Math.max(0, a), Math.min(latest, b)];
  }
  const len = state.end - state.start + 1;
  const pad = Math.max(10, Math.round(len * 0.25));
  return [Math.max(0, state.start - pad), Math.min(latest, state.end + pad)];
}

const BIN_UNITS = { 1: "day", 2: "2 days", 7: "week", 14: "2 weeks", 28: "4 weeks", 91: "13 weeks", 182: "26 weeks", 364: "52 weeks" };

function drawTimeline() {
  if (!manifest || !cumulative) return;
  const cv = tl.canvas;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const C = tl.colors;

  const [d0, d1] = timelineDomain();
  const span = d1 - d0 + 1;
  const L = 30, R = 8, T = 8, B = 18;
  const pw = W - L - R, ph = H - T - B;
  const binDays = [1, 2, 7, 14, 28, 91, 182].find((k) => (pw / span) * k >= 2.5) || 364;
  const x = (d) => L + ((d - d0) / span) * pw;
  tl.layout = { d0, d1, span, L, pw, binDays, x };

  const bins = [];
  let max = 0;
  for (let s = Math.floor(d0 / binDays) * binDays; s <= d1; s += binDays) {
    const a = Math.max(s, d0), b = Math.min(s + binDays - 1, d1);
    const v = countDays(a, b);
    bins.push({ a, b, v });
    if (v > max) max = v;
  }
  const niceMax = (() => {
    if (max <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    return [1, 2, 4, 5, 10].map((m) => m * p).find((m) => m >= max);
  })();
  const y = (v) => T + ph - (v / niceMax) * ph;

  // Gridlines and y labels
  ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const g of [niceMax / 2, niceMax]) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, Math.round(y(g)) + 0.5);
    ctx.lineTo(W - R, Math.round(y(g)) + 0.5);
    ctx.stroke();
    ctx.fillStyle = C.muted;
    ctx.fillText(nf.format(g), L - 6, y(g));
  }

  // Selection band
  const [sa, sb] = [state.start, state.end];
  const sx0 = x(sa), sx1 = Math.max(x(sb + 1), sx0 + 3);
  ctx.fillStyle = C.accent;
  ctx.globalAlpha = 0.1;
  ctx.fillRect(sx0, T, sx1 - sx0, ph);
  ctx.globalAlpha = 1;

  // Bars
  for (const bin of bins) {
    const bx0 = x(bin.a), bx1 = x(bin.b + 1);
    const gap = bx1 - bx0 >= 4 ? 1 : 0;
    const top = y(bin.v);
    const hgt = T + ph - top;
    if (hgt <= 0) continue;
    const inSel = bin.b >= sa && bin.a <= sb;
    ctx.fillStyle = inSel ? C.warn : C.out;
    const w = Math.max(1, bx1 - bx0 - gap);
    const r = Math.min(2, w / 2, hgt);
    ctx.beginPath();
    ctx.roundRect(bx0, top, w, Math.max(hgt, 1), [r, r, 0, 0]);
    ctx.fill();
  }

  ctx.fillStyle = C.out;
  ctx.fillRect(L, T + ph, pw, 1);

  // Selection edges
  ctx.fillStyle = C.accent;
  ctx.fillRect(sx0 - 1, T, 2, ph);
  ctx.fillRect(sx1 - 1, T, 2, ph);

  // X ticks
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const startDate = dayDate(d0);
  const ticks = [];
  if (span > 800) {
    for (let yr = startDate.getUTCFullYear(); ; yr++) {
      const d = isoToDay(`${yr}-01-01`);
      if (d > d1) break;
      if (d >= d0) ticks.push([d, String(yr)]);
    }
  } else if (span > 60) {
    const cur = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    const step = span > 400 ? 3 : 1;
    while (true) {
      const d = Math.round((cur.getTime() - epochMs) / DAY_MS);
      if (d > d1) break;
      if (d >= d0 && cur.getUTCMonth() % step === 0) {
        const lab = cur.getUTCMonth() === 0
          ? String(cur.getUTCFullYear())
          : cur.toLocaleDateString("en-US", { timeZone: "UTC", month: "short" });
        ticks.push([d, lab]);
      }
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
  } else {
    const every = span > 21 ? 7 : span > 8 ? 2 : 1;
    for (let d = d0; d <= d1; d++) if ((d - d0) % every === 0) ticks.push([d, fmtDay(d, { year: undefined })]);
  }
  ctx.fillStyle = C.muted;
  let lastRight = -Infinity;
  for (const [d, lab] of ticks) {
    const tx = x(d);
    const w = ctx.measureText(lab).width;
    ctx.fillRect(tx, T + ph, 1, 4);
    if (tx + 3 > lastRight + 6 && tx + 3 + w < W) {
      ctx.fillText(lab, tx + 3, H - 3);
      lastRight = tx + 3 + w;
    }
  }

  const filtered = state.office || state.st || state.q;
  $("timeline-title").textContent = `Warnings issued per ${BIN_UNITS[binDays]}${filtered ? " · " + filterLabel() : ""}`;
}

function dayAtX(px) {
  const { L, pw, d0, span } = tl.layout;
  return clampDay(Math.floor(d0 + ((px - L) / pw) * span));
}

tl.canvas.addEventListener("pointerdown", (e) => {
  if (!tl.layout) return;
  const px = e.offsetX;
  const { x } = tl.layout;
  const edgeA = x(state.start), edgeB = x(state.end + 1);
  const d = dayAtX(px);
  if (Math.abs(px - edgeA) <= 6) tl.drag = { mode: "a" };
  else if (Math.abs(px - edgeB) <= 6) tl.drag = { mode: "b" };
  else if (px > edgeA && px < edgeB && state.preset !== "all") tl.drag = { mode: "move", offset: d - state.start, len: state.end - state.start };
  else tl.drag = { mode: "new", anchor: d };
  tl.drag.moved = false;
  tl.canvas.setPointerCapture(e.pointerId);
  $("timeline-tip").hidden = true;
});

tl.canvas.addEventListener("pointermove", (e) => {
  if (!tl.layout) return;
  const d = dayAtX(e.offsetX);
  if (!tl.drag) { showTimelineTip(e.offsetX, e.offsetY); return; }
  const g = tl.drag;
  g.moved = true;
  if (g.mode === "new") [state.start, state.end] = [Math.min(g.anchor, d), Math.max(g.anchor, d)];
  else if (g.mode === "a") [state.start, state.end] = [Math.min(d, state.end), Math.max(d, state.end)];
  else if (g.mode === "b") [state.start, state.end] = [Math.min(state.start, d), Math.max(state.start, d)];
  else {
    const s = Math.max(0, Math.min(manifest.latest_day - g.len, d - g.offset));
    [state.start, state.end] = [s, s + g.len];
  }
  state.preset = null;
  syncDateControls();
  drawTimeline();
});

const endDrag = () => {
  if (!tl.drag) return;
  const g = tl.drag;
  tl.drag = null;
  if (g.mode === "new" && !g.moved) {
    // A click without a drag picks the bin under the pointer.
    const b = tl.layout.binDays;
    const s = Math.max(tl.layout.d0, Math.floor(g.anchor / b) * b);
    [state.start, state.end] = [s, clampDay(s + b - 1)];
    state.preset = null;
  }
  if (g.moved || g.mode === "new") { showAllWarnings = false; update(); }
};
tl.canvas.addEventListener("pointerup", endDrag);
tl.canvas.addEventListener("pointercancel", endDrag);
tl.canvas.addEventListener("pointerleave", () => { if (!tl.drag) $("timeline-tip").hidden = true; });

tl.canvas.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  step(e.key === "ArrowLeft" ? -1 : 1);
});

function showTimelineTip(px, py) {
  const { binDays, d0, d1 } = tl.layout;
  const d = dayAtX(px);
  const s = Math.max(d0, Math.floor(d / binDays) * binDays);
  const e = Math.min(d1, s + binDays - 1);
  const n = countDays(s, e);
  const tip = $("timeline-tip");
  tip.textContent = "";
  const b = document.createElement("b");
  b.textContent = nf.format(n);
  tip.append(b, ` warning${n === 1 ? "" : "s"} issued · ${fmtRange(s, e)}`);
  tip.hidden = false;
  const W = tl.canvas.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = Math.max(0, Math.min(W - tw, px - tw / 2)) + "px";
  tip.style.top = Math.max(-34, py - 40) + "px";
}

// Controls ---------------------------------------------------------------------
function applyPreset(id) {
  const latest = manifest.latest_day;
  const preset = PRESETS.find((p) => p.id === id);
  if (preset && preset.id === "all") [state.start, state.end] = [0, latest];
  else if (preset && preset.id === "ytd") {
    [state.start, state.end] = [clampDay(isoToDay(`${dayDate(latest).getUTCFullYear()}-01-01`)), latest];
  } else if (preset) [state.start, state.end] = [clampDay(latest - preset.len + 1), latest];
  else if (/^y\d{4}$/.test(id)) {
    const y = Number(id.slice(1));
    const a = isoToDay(`${y}-01-01`), b = isoToDay(`${y}-12-31`);
    if (b < 0 || a > latest) return false;
    [state.start, state.end] = [clampDay(a), clampDay(b)];
  } else return false;
  state.preset = id;
  return true;
}

function setRange(a, b, { fit = false } = {}) {
  [state.start, state.end] = [clampDay(Math.min(a, b)), clampDay(Math.max(a, b))];
  state.preset = null;
  showAllWarnings = false;
  update({ fit });
}

// Moves the range by its own length, so a single day steps a day and a year
// steps a year.
function step(dir) {
  if (state.preset === "all") return;
  const len = state.end - state.start + 1;
  const s = Math.max(0, Math.min(manifest.latest_day - len + 1, state.start + dir * len));
  setRange(s, s + len - 1);
}

function filterLabel() {
  const parts = [];
  if (state.office) parts.push(officeName(state.office));
  if (state.st) parts.push(stateName(state.st));
  if (state.q) parts.push(`“${state.q}”`);
  return parts.join(" · ");
}

function officeName(id) {
  const f = warnings.find((x) => x.properties.office === id);
  return f ? f.properties.office_name : id;
}

function fillSelect(el, first, options, value) {
  el.textContent = "";
  el.appendChild(new Option(first, ""));
  for (const [v, label] of options) el.appendChild(new Option(label, v));
  el.value = value;
}

function buildFilterOptions() {
  const offices = tally(warnings, (w) => [w.office])
    .map(([id, n]) => [id, `${officeName(id)} (${n})`])
    .sort((x, y) => x[1].localeCompare(y[1]));
  fillSelect($("office"), "All offices", offices, state.office);
  const states = tally(warnings, (w) => w.states.split(","))
    .map(([s, n]) => [s, `${stateName(s)} (${n})`])
    .sort((x, y) => x[1].localeCompare(y[1]));
  fillSelect($("state"), "All states", states, state.st);
}

function buildControls() {
  const presets = $("presets");
  presets.textContent = "";
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.preset = p.id;
    b.textContent = p.label;
    b.addEventListener("click", () => { applyPreset(p.id); showAllWarnings = false; update(); });
    presets.appendChild(b);
  }
  const years = document.createElement("select");
  years.id = "year-select";
  years.setAttribute("aria-label", "A single year");
  years.appendChild(new Option("Year…", ""));
  const y1 = dayDate(manifest.latest_day).getUTCFullYear();
  for (let y = y1; y >= dayDate(0).getUTCFullYear(); y--) years.appendChild(new Option(String(y), "y" + y));
  years.addEventListener("change", () => {
    if (years.value && applyPreset(years.value)) { showAllWarnings = false; update(); }
  });
  presets.appendChild(years);

  const dateChanged = () => {
    const a = isoToDay($("date-start").value), b = isoToDay($("date-end").value);
    if (Number.isFinite(a) && Number.isFinite(b)) setRange(a, b);
  };
  $("date-start").addEventListener("change", dateChanged);
  $("date-end").addEventListener("change", dateChanged);
  $("step-back").addEventListener("click", () => step(-1));
  $("step-fwd").addEventListener("click", () => step(1));

  buildFilterOptions();
  $("office").addEventListener("change", () => { state.office = $("office").value; filtersChanged(); });
  $("state").addEventListener("change", () => { state.st = $("state").value; filtersChanged(); });

  let searchTimer = null;
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = squish($("search").value);
      if (q === state.q) return;
      // The summaries are searchable at once; the full text joins them when
      // it has loaded.
      if (q) await loadText().catch((err) => toast("Searching summaries only: the full text could not load (" + err.message + ")", 5000));
      state.q = q;
      filtersChanged();
    }, 220);
  });
  $("clear-filters").addEventListener("click", () => {
    state.office = "";
    state.st = "";
    state.q = "";
    filtersChanged();
  });

  for (const b of $("rank-seg").children) {
    b.addEventListener("click", () => { state.rank = b.dataset.rank; showAllRank = false; renderRank(); syncControls(); writeHash(); });
  }
  $("rank-more").addEventListener("click", () => { showAllRank = !showAllRank; renderRank(); });
  $("warning-more").addEventListener("click", () => { showAllWarnings = true; renderWarnings(); });

  for (const b of $("zoom-seg").children) {
    b.addEventListener("click", () => { state.zoom = b.dataset.zoom; syncControls(); drawTimeline(); writeHash(); });
  }

  const basemaps = $("basemaps");
  for (const [id, bm] of Object.entries(BASEMAPS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.basemap = id;
    b.textContent = bm.label;
    b.addEventListener("click", () => setBasemap(id));
    basemaps.appendChild(b);
  }

  $("copy-link").addEventListener("click", async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Link copied");
    } catch { toast("Copy the address from the address bar"); }
  });
  $("save-png").addEventListener("click", savePng);
  $("download-csv").addEventListener("click", downloadCsv);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("detail").hidden) closeDetail();
  });
}

function syncDateControls() {
  $("date-start").value = iso(state.start);
  $("date-end").value = iso(state.end);
  $("date-start").min = $("date-end").min = iso(0);
  $("date-start").max = $("date-end").max = iso(manifest.latest_day);
  $("range-label").textContent = fmtRange(state.start, state.end);
  for (const b of $("presets").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset));
  $("year-select").value = /^y/.test(state.preset || "") ? state.preset : "";
  const whole = state.preset === "all";
  $("step-back").disabled = whole || state.start === 0;
  $("step-fwd").disabled = whole || state.end === manifest.latest_day;
}

function syncControls() {
  syncDateControls();
  $("office").value = state.office;
  $("state").value = state.st;
  if (squish($("search").value) !== state.q) $("search").value = state.q;
  $("clear-filters").hidden = !(state.office || state.st || state.q);
  for (const b of $("rank-seg").children) b.setAttribute("aria-checked", String(b.dataset.rank === state.rank));
  for (const b of $("zoom-seg").children) b.setAttribute("aria-checked", String(b.dataset.zoom === state.zoom));
  syncBasemapButtons();
}

// Panel ------------------------------------------------------------------------
function tile(parent, value, key, sub, onClick) {
  const t = document.createElement("div");
  t.className = "tile";
  const v = document.createElement(onClick ? "button" : "div");
  v.className = "v";
  v.textContent = value;
  if (onClick) { v.type = "button"; v.addEventListener("click", onClick); }
  t.appendChild(v);
  line(t, "k", key);
  if (sub) line(t, "s", sub);
  parent.appendChild(t);
}

function renderTiles() {
  const box = $("tiles");
  box.textContent = "";
  const rows = current.rows;
  const offices = tally(rows, (w) => [w.office]);
  const states = tally(rows, (w) => w.states.split(","));
  const days = tally(rows, (w) => [w.d0]);
  tile(box, nf.format(rows.length), rows.length === 1 ? "Fire Warning" : "Fire Warnings", fmtRange(state.start, state.end));
  tile(box, nf.format(offices.length), offices.length === 1 ? "office issued them" : "offices issued them",
    offices.length ? `Most: ${officeName(offices[0][0])}, ${nf.format(offices[0][1])}` : null);
  tile(box, nf.format(states.length), states.length === 1 ? "state" : "states",
    states.length ? `Most: ${stateName(states[0][0])}, ${nf.format(states[0][1])}` : null);
  if (days.length) {
    const [d, n] = days[0];
    tile(box, fmtDay(d), "busiest day", `${plural(n, "warning")} issued`, () => setRange(d, d, { fit: true }));
  } else tile(box, "–", "busiest day", "No warnings in this selection");
}

function renderLegend() {
  const box = $("legend");
  box.textContent = "";
  const rows = current.rows;
  const own = rows.filter((f) => f.properties.polygon).length;
  const row = (cls, text, n) => {
    const r = document.createElement("div");
    r.className = "row";
    const s = document.createElement("span");
    s.className = cls;
    const t = document.createElement("span");
    t.textContent = text;
    const c = document.createElement("span");
    c.className = "n";
    c.textContent = n == null ? "" : nf.format(n);
    r.append(s, t, c);
    box.appendChild(r);
  };
  row("swatch warn-swatch", "The warning's own polygon", own);
  row("swatch warn-swatch dashed", "Whole counties named, no polygon issued", rows.length - own);
  row("dot warn-dot", "A dot marks each warning until the map is zoomed in");
}

function rankRow(list, label, count, max, pressed, onClick) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("aria-pressed", String(pressed));
  const name = document.createElement("span");
  name.textContent = label;
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = nf.format(count);
  const bar = document.createElement("span");
  bar.className = "bar";
  const fill = document.createElement("span");
  fill.style.width = `${(count / max) * 100}%`;
  bar.appendChild(fill);
  b.append(name, n, bar);
  b.addEventListener("click", onClick);
  li.appendChild(b);
  list.appendChild(li);
}

// Clicking a row filters to it; clicking it again clears the filter.
function renderRank() {
  const list = $("rank-list");
  list.textContent = "";
  const byOffice = state.rank === "office";
  const counts = tally(current.rows, byOffice ? (w) => [w.office] : (w) => w.states.split(","));
  if (!counts.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No warnings in this selection.";
    list.appendChild(li);
  }
  const max = counts.length ? counts[0][1] : 1;
  for (const [key, n] of showAllRank ? counts : counts.slice(0, RANK_N)) {
    const active = byOffice ? state.office === key : state.st === key;
    rankRow(list, byOffice ? officeName(key) : stateName(key), n, max, active, () => {
      if (byOffice) state.office = active ? "" : key;
      else state.st = active ? "" : key;
      filtersChanged();
    });
  }
  const more = $("rank-more");
  more.hidden = counts.length <= RANK_N;
  more.textContent = showAllRank ? "Show fewer" : `Show all ${counts.length} ${byOffice ? "offices" : "states"}`;
}

function warningRow(f, after) {
  const w = f.properties;
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.id = w.id;
  b.setAttribute("aria-pressed", String(w.id === state.selected));
  line(b, "when", fmtIssued(w));
  line(b, "where", `${w.areas} · ${w.office_name}`);
  b.addEventListener("click", () => { selectWarning(w.id); if (after) after(); });
  li.appendChild(b);
  return li;
}

function renderWarnings() {
  const list = $("warning-list");
  list.textContent = "";
  const rows = current.rows;
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No Fire Warnings match. Widen the dates or clear the search.";
    list.appendChild(li);
  }
  for (const f of showAllWarnings ? rows : rows.slice(0, LIST_N)) list.appendChild(warningRow(f));
  const more = $("warning-more");
  more.hidden = showAllWarnings || rows.length <= LIST_N;
  more.textContent = `Show all ${nf.format(rows.length)}`;
}

// The days with the most warnings issued, across the whole archive.
function renderHistory() {
  const list = $("history-days");
  list.textContent = "";
  const days = tally(warnings, (w) => [w.d0]).slice(0, HISTORY_N);
  const max = days.length ? days[0][1] : 1;
  for (const [d, n] of days) {
    rankRow(list, fmtDay(d, { weekday: "short" }), n, max, false, () => {
      state.office = "";
      state.st = "";
      state.q = "";
      buildCumulative();
      setRange(d, d, { fit: true });
    });
  }
}

// Sharing ----------------------------------------------------------------------
function writeHash() {
  if (!manifest) return;
  const p = new URLSearchParams();
  if (state.preset && !/^y/.test(state.preset)) { if (state.preset !== DEFAULT_PRESET) p.set("p", state.preset); }
  else if (state.preset) p.set("y", state.preset.slice(1));
  else p.set("d", `${iso(state.start)}_${iso(state.end)}`);
  if (state.office) p.set("o", state.office);
  if (state.st) p.set("s", state.st);
  if (state.q) p.set("q", state.q);
  if (state.rank !== "office") p.set("r", state.rank);
  if (state.basemap !== "dark") p.set("b", state.basemap);
  if (state.zoom !== "all") p.set("t", state.zoom);
  if (state.selected) p.set("id", state.selected);
  const c = map.getCenter();
  p.set("map", `${map.getZoom().toFixed(2)}/${c.lat.toFixed(3)}/${c.lng.toFixed(3)}`);
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("p")) applyPreset(p.get("p")) || applyPreset(DEFAULT_PRESET);
  else if (p.has("y")) applyPreset("y" + p.get("y")) || applyPreset(DEFAULT_PRESET);
  else if (p.has("d")) {
    const [a, b] = p.get("d").split("_").map(isoToDay);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      [state.start, state.end] = [clampDay(Math.min(a, b)), clampDay(Math.max(a, b))];
      state.preset = null;
    } else applyPreset(DEFAULT_PRESET);
  } else applyPreset(DEFAULT_PRESET);
  if (warnings.some((f) => f.properties.office === p.get("o"))) state.office = p.get("o");
  if (STATE_NAMES[p.get("s")]) state.st = p.get("s");
  if (p.get("q")) state.q = squish(p.get("q"));
  if (p.get("r") === "state") state.rank = "state";
  if (BASEMAPS[p.get("b")]) state.basemap = p.get("b");
  if (["all", "year", "fit"].includes(p.get("t"))) state.zoom = p.get("t");
  if (byId.has(p.get("id"))) state.selected = p.get("id");
  const m = (p.get("map") || "").split("/").map(Number);
  if (m.length === 3 && m.every(Number.isFinite)) map.jumpTo({ zoom: m[0], center: [m[2], m[1]] });
}

function savePng() {
  map.once("render", () => {
    const src = map.getCanvas();
    const dpr = src.width / src.clientWidth;
    const head = Math.round(64 * dpr), foot = Math.round(26 * dpr);
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height + head + foot;
    const ctx = out.getContext("2d");
    const dark = tone() === "dark";
    ctx.fillStyle = dark ? "#0e0e0e" : "#fafaf8";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, head);
    const ink = dark ? "#f4f3ef" : "#1c1b19", sub = dark ? "#c3c2b7" : "#52514e";
    const font = getComputedStyle(document.body).fontFamily;
    ctx.fillStyle = ink;
    ctx.font = `600 ${20 * dpr}px ${font}`;
    ctx.fillText("National Weather Service Fire Warnings", 16 * dpr, 28 * dpr);
    ctx.fillStyle = sub;
    ctx.font = `${13.5 * dpr}px ${font}`;
    const filters = filterLabel();
    ctx.fillText(`${fmtRange(current.a, current.b)} · ${plural(current.rows.length, "Fire Warning")}${filters ? " · " + filters : ""}`, 16 * dpr, 50 * dpr);
    ctx.font = `${11 * dpr}px ${font}`;
    const credit = state.basemap === "satellite" ? "Imagery and labels © Esri, Maxar, Earthstar Geographics" : "Base map © CARTO, OpenStreetMap contributors";
    ctx.fillText(`Data: Iowa Environmental Mesonet · IPPRA, University of Oklahoma · ${credit}`, 16 * dpr, out.height - 9 * dpr);
    out.toBlob((blob) => saveBlob(blob, `us_fire_warnings_${iso(current.a)}_${iso(current.b)}.png`));
  });
  map.triggerRepaint();
}

function downloadCsv() {
  const rows = current ? current.rows : [];
  if (!rows.length) { toast("No warnings to download"); return; }
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const utc = (minute) => new Date(minute * 60000).toISOString().slice(0, 16) + "Z";
  const head = ["product_id", "issued_utc", "expires_utc", "issued_local_date", "time_zone", "office", "office_name", "states", "areas", "own_polygon", "eas_requested", "requested_by", "summary", "iem_url"];
  const out = [head.join(",")];
  for (const f of [...rows].reverse()) {
    const w = f.properties;
    out.push([w.id, utc(w.t0), utc(w.t1), iso(w.d0), w.tz, w.office, w.office_name, w.states.replace(/,/g, " "), w.areas, w.polygon, w.eas, w.requested_by, w.summary, w.url].map(cell).join(","));
  }
  saveBlob(new Blob([out.join("\n") + "\n"], { type: "text/csv" }), `us_fire_warnings_${iso(current.a)}_${iso(current.b)}.csv`);
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

let toastTimer = null;
function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Freshness --------------------------------------------------------------------
// Fire Warnings are rare, so the newest one is often weeks old. What says the
// archive is current is when IEM was last asked.
function renderFreshness() {
  const checked = Date.parse(manifest.checked_utc);
  const ageH = (Date.now() - checked) / 3600000;
  const newest = warnings.length ? warnings[warnings.length - 1].properties : null;
  const when = new Date(checked).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  $("freshness-text").textContent =
    (newest ? `Newest warning ${fmtDay(newest.d0)} · ` : "") + `archive checked ${when}`;
  $("freshness").classList.toggle("stale", ageH > 24);
  $("freshness").title = ageH > 24
    ? "The archive was last checked for new warnings more than a day ago."
    : "The archive is checked for new warnings every three hours.";
}

async function checkForUpdate() {
  let m;
  try { m = await fetchManifest(); } catch { return; }
  if (m.build === manifest.build) return;
  let features;
  try { features = await fetchWarnings(m.build); } catch { return; }
  const added = m.total - manifest.total;
  const followLatest = state.preset && !/^y/.test(state.preset);
  const atLatest = state.end === manifest.latest_day;
  applyData(m, features);
  if (state.q) await loadText().catch(() => {});
  if (followLatest) applyPreset(state.preset);
  else if (atLatest) {
    const len = state.end - state.start;
    [state.start, state.end] = [clampDay(m.latest_day - len), m.latest_day];
  }
  buildFilterOptions();
  buildCumulative();
  renderHistory();
  renderAbout();
  renderFreshness();
  update();
  if (state.selected && byId.has(state.selected)) renderDetail(byId.get(state.selected));
  if (added > 0) toast(`${plural(added, "new Fire Warning")} loaded`, 5000);
}

function renderAbout() {
  const m = manifest;
  const box = $("about");
  box.textContent = "";
  const p = (html) => { const e = document.createElement("p"); e.innerHTML = html; box.appendChild(e); };
  const first = warnings.length ? fmtDay(warnings[0].properties.d0, { month: "long" }) : "";
  p(`A <strong>Fire Warning</strong> is a National Weather Service message telling people that a wildfire or structure fire threatens them and that they may need to act, usually to evacuate. The Weather Service does not decide to issue one: local or state officials ask for it, and the forecast office relays it over NOAA Weather Radio and the Emergency Alert System.`);
  p(`<strong>Coverage.</strong> ${nf.format(m.total)} Fire Warnings from every forecast office, from ${first} on, taken from the <a href="https://mesonet.agron.iastate.edu/wx/afos/list.phtml">Iowa Environmental Mesonet</a> text archive, which begins in January 2006. A corrected warning replaces the one it corrects.`);
  p(`<strong>Shapes.</strong> ${nf.format(m.polygons)} warnings carry their own polygon, drawn solid: every one since 2022 and a few from 2017 and 2019. The other ${nf.format(m.total - m.polygons)} named counties or forecast zones only, and are drawn dashed as the whole of each county named, which is usually far more ground than the fire threatened.`);
  p(`<strong>Dates and times</strong> are local to where the warning was issued, in the time zone printed on the warning itself. A warning belongs to every day it was in force, so an evening warning running past midnight shows on both days.`);
  p(`<strong>Counts are not fire activity.</strong> Offices and the agencies they serve differ in whether they use Fire Warnings at all. NWS Norman and NWS Amarillo issued more than half the archive; most offices have never issued one. A state with few warnings may simply warn people about fire another way.`);
  p(`<strong>Summaries</strong> are the first paragraph of each message, and the requesting agency is read from its header; both are extracted by rule and can be clumsy. The full text is the record.`);
  p(`<strong>Updates.</strong> The archive is refreshed from IEM automatically, and this page checks for a newer build every 10 minutes while it is open.`);
  p(`Built by the <a href="https://ippra.net">Institute for Public Policy Research and Analysis</a> at the University of Oklahoma. Oklahoma's warnings are mapped with satellite fire detections and Wireless Emergency Alerts on <a href="https://ippra.net/okfirewarn">OK FireWarn</a>.`);
}

// Themes -----------------------------------------------------------------------
// The "Adjust colors" menu the institute's dashboards share. index.html sets
// the theme before paint; this only switches it. The timeline is a canvas, so
// it is redrawn in the new theme's colors.
function buildThemeMenu() {
  const btn = $("theme-btn"), menu = $("theme-menu");
  const mark = () => {
    for (const b of menu.querySelectorAll("button")) {
      b.classList.toggle("active", b.dataset.theme === document.documentElement.dataset.theme);
    }
  };
  const toggle = (open) => {
    menu.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(menu.classList.contains("open")));
  };
  btn.addEventListener("click", () => toggle());
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-theme]");
    if (!b) return;
    document.documentElement.dataset.theme = b.dataset.theme;
    try { sessionStorage.setItem("usfirewarn-theme", b.dataset.theme); } catch { /* private mode */ }
    mark();
    toggle(false);
    readColors();
    drawTimeline();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#theme-switch")) toggle(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggle(false); });
  mark();
}

// Boot -------------------------------------------------------------------------
async function boot() {
  readColors();
  buildThemeMenu();

  const m = await fetchManifest();
  applyData(m, await fetchWarnings(m.build));
  const hadView = /(^|[#&])map=/.test(location.hash);
  readHash();
  if (state.q) await loadText().catch(() => {});
  buildControls();
  buildCumulative();
  renderHistory();
  renderAbout();
  renderFreshness();

  const initialBasemap = state.basemap;
  state.basemap = "dark";
  if (initialBasemap !== "dark") setBasemap(initialBasemap);
  else if (firstStyleLoaded) addOverlays();

  new ResizeObserver(() => drawTimeline()).observe(tl.canvas);
  update();
  if (state.selected) selectWarning(state.selected, { fly: !hadView });
  $("boot").hidden = true;

  setInterval(checkForUpdate, REFRESH_MS);
  setInterval(renderFreshness, 60000);
}

boot().catch((e) => {
  const l = $("boot");
  l.hidden = false;
  l.classList.add("boot-failed");
  l.textContent = "The map failed to start.\n\n" + (e && e.message ? e.message : String(e));
  console.error(e);
});
