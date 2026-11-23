"use strict";

/* The MAP tab (Step 6).

   What it draws, using Leaflet (a map library; the files are in dashboard/vendor/leaflet, so it works offline):
   - the flight track, one point per GPS update (about once a second), with gaps where the GPS fix was lost
   - HOME (the first GPS position this page has seen), distance rings around it, and the drone's marker
   - alert pins: a flag where each active alert began
   - a metre grid as the base map (works with no internet), or real map tiles when you are online

   app.js calls three things:
     FlightMap.add(msg)     for every telemetry message, so the track is collected even while this tab is hidden
     FlightMap.touch(ctx)   after every render: "something changed, redraw soon"
     FlightMap.show()/hide() when the tab opens or closes
   The track is only drawn onto the map while the tab is open; opening the tab draws everything collected so far. */
const FlightMap = (() => {
  // ---------- settings ----------
  const DEFAULT_CENTER = [12.9237, 77.4989];   // where the map starts until the first GPS position arrives
  const DEFAULT_ZOOM = 18;
  const SAMPLE_MS = 950;          // one track point per GPS update, about once a second
  const MIN_STEP_M = 0.5;         // while standing still no points are added
  const MAX_POINTS = 5000;        // about 80 minutes of flight
  const DOT_CAP = 1500;           // the little dots on each fix stop being drawn after this many
  const REFRESH_MS = 250;
  const BUCKETS = 16;             // how many shades the ALT / SPEED trail uses
  const TRAIL = { alt: { lo: 0, hi: 100, unit: "m" }, spd: { lo: 0, hi: 12, unit: "m/s" } };  // same ends as the cards' bars
  const PLAIN = "#9FB4C9";
  const RINGS = [50, 100, 150, 200, 500, 1000, 2000];   // metres around HOME
  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  // metre-grid line spacing: [thin line, thick line] in metres, picked so thin lines are never closer than about 24 px
  const GRID_STEPS = [[1, 5], [2, 10], [5, 25], [10, 50], [20, 100], [50, 250], [100, 500], [200, 1000], [500, 2500], [1000, 5000], [2000, 10000], [5000, 25000]];
  const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const rad = (d) => (d * Math.PI) / 180;

  // ---------- the data (collected all the time) ----------
  const pts = [];          // { lat, lon, alt, spd, rx, brk }   brk = the line does not connect to the point before
  let home = null;         // { lat, lon }
  let lenM = 0;            // track length in metres
  let rangeM = 0;          // farthest distance from home
  let gapPending = false;  // the fix was lost: the next point starts a new line
  let pos = null;          // newest position seen, even without a fix: { lat, lon, fix }
  let lastHdg = 0;

  function distM(a, b) {                 // haversine, metres
    const R = 6371000;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {               // degrees clockwise from north, a to b
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  function fm(m) { return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m"; }

  function add(msg) {
    if (!Number.isFinite(msg.lat) || !Number.isFinite(msg.lon)) return;
    pos = { lat: msg.lat, lon: msg.lon, fix: msg.fix };
    if (msg.heading_deg !== null && msg.heading_deg !== undefined) lastHdg = msg.heading_deg;
    if (msg.fix !== 1) { gapPending = pts.length > 0; return; }   // an old position is not a new track point

    const last = pts[pts.length - 1];
    const rx = msg.rx_unix_ms;
    if (last && !gapPending) {
      const dt = rx - last.rx;
      if (dt >= 0 && dt < SAMPLE_MS) return;                      // too soon: wait for the next GPS update
      if (distM(last, msg) < MIN_STEP_M) return;                  // not moving
    }
    if (pts.length >= MAX_POINTS) return;
    const brk = !last || gapPending;
    const d = brk ? 0 : distM(last, msg);
    const p = { lat: msg.lat, lon: msg.lon, alt: msg.alt_rel_m ?? 0, spd: msg.speed_mps ?? 0, rx, brk };
    if (!home) home = { lat: p.lat, lon: p.lon };
    lenM += d;
    rangeM = Math.max(rangeM, distM(home, p));
    gapPending = false;
    pts.push(p);
  }

  // ---------- the Leaflet map (built the first time the tab opens) ----------
  let map = null, visible = false, dirty = false, ctx = null;
  let baseMode = "grid", viewMode = "follow", trailMode = "plain";
  let gridLayer = null, tileLayer = null;
  let trackGroup = null, dotsGroup = null, ringsGroup = null;
  let homeMarker = null, uavMarker = null, uavEl = null;
  let drawn = 0, curLine = null, curBucket = -1, drawnMode = "plain";
  let homeDrawn = false, ringLayers = [];
  let tileErrors = 0, tileLoads = 0;
  let fitCount = -1, homeCentred = false;
  const pins = new Map();     // alert parameter -> { marker, key }
  const chipsText = { v: "" };

  // The metre grid: a transparent layer of thin and thick lines, drawn tile by tile.
  // Lines are laid out from HOME, so HOME always sits on a crossing.
  function makeGridLayer() {
    const Grid = L.GridLayer.extend({
      initialize(options) {
        L.GridLayer.prototype.initialize.call(this, options);
        this._origin = { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1] };
      },
      setOrigin(lat, lon) { this._origin = { lat, lon }; this.redraw(); },
      createTile(coords) {
        const size = this.getTileSize();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const tile = L.DomUtil.create("canvas", "leaflet-tile");
        tile.width = size.x * dpr; tile.height = size.y * dpr;
        const g = tile.getContext("2d");
        g.scale(dpr, dpr);

        const world = 2 * Math.PI * 6378137;                 // width of the whole map in projected metres
        const tileM = world / Math.pow(2, coords.z);
        const x0 = -world / 2 + coords.x * tileM;            // projected metres at the tile's left edge
        const yTop = world / 2 - coords.y * tileM;           // ... and top edge
        const cosLat = Math.cos(rad(this._origin.lat));
        const mPerPx = 156543.03392 * cosLat / Math.pow(2, coords.z);   // real ground metres per screen pixel
        const [minor, major] = gridSteps(mPerPx);
        const o = L.CRS.EPSG3857.project(L.latLng(this._origin.lat, this._origin.lon));
        const stepP = minor / cosLat;                        // projected metres between thin lines
        const ratio = Math.round(major / minor);
        const pxPerP = size.x / tileM;

        const lines = (thick) => {
          g.beginPath();
          const nx0 = Math.ceil((x0 - o.x) / stepP), nx1 = Math.floor((x0 + tileM - o.x) / stepP);
          for (let n = nx0; n <= nx1; n++) {
            if ((n % ratio === 0) !== thick) continue;
            const px = Math.round((o.x + n * stepP - x0) * pxPerP) + 0.5;
            g.moveTo(px, 0); g.lineTo(px, size.y);
          }
          const ny0 = Math.ceil((yTop - tileM - o.y) / stepP), ny1 = Math.floor((yTop - o.y) / stepP);
          for (let n = ny0; n <= ny1; n++) {
            if ((n % ratio === 0) !== thick) continue;
            const py = Math.round((yTop - (o.y + n * stepP)) * pxPerP) + 0.5;
            g.moveTo(0, py); g.lineTo(size.x, py);
          }
          g.stroke();
        };
        g.lineWidth = 1;
        g.strokeStyle = "#18202A"; lines(false);
        g.strokeStyle = "#2B3744"; lines(true);
        return tile;
      },
    });
    return new Grid({ tileSize: 256, minZoom: 10, maxZoom: 21 });
  }
  function gridSteps(mPerPx) {
    for (const s of GRID_STEPS) if (s[0] / mPerPx >= 24) return s;
    return GRID_STEPS[GRID_STEPS.length - 1];
  }
  const mPerPxNow = () => 156543.03392 * Math.cos(rad(map.getCenter().lat)) / Math.pow(2, map.getZoom());

  function ensureMap() {
    if (map) return true;
    if (typeof L === "undefined") {
      $("mapvp").innerHTML = '<p class="nolib">The map library was not found. Check that dashboard/vendor/leaflet/leaflet.js exists.</p>';
      return false;
    }
    map = L.map("mapvp", {
      zoomControl: false, attributionControl: false, scrollWheelZoom: false,   // wheel scrolls the page area, not the map
      zoomSnap: 1, minZoom: 10, maxZoom: 21, inertia: true,
    });
    const start = pos || { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1] };
    map.setView([start.lat, start.lon], DEFAULT_ZOOM);

    gridLayer = makeGridLayer();
    tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxNativeZoom: 19, maxZoom: 21, minZoom: 10 });
    tileLayer.on("tileerror", () => { tileErrors++; dirty = true; });
    tileLayer.on("tileload", () => { tileLoads++; dirty = true; });
    if (home) gridLayer.setOrigin(home.lat, home.lon);
    gridLayer.addTo(map);

    ringsGroup = L.layerGroup().addTo(map);
    trackGroup = L.layerGroup().addTo(map);
    dotsGroup = L.layerGroup().addTo(map);

    map.on("dragstart", () => setView(null));       // the person is moving the map: stop following
    map.on("zoomend moveend", () => { dirty = true; updateRings(); });
    new ResizeObserver(() => { if (visible && map) { map.invalidateSize(); dirty = true; } }).observe($("mapvp"));
    return true;
  }

  // ---------- track drawing ----------
  const ramp = (f) => {
    const a = [58, 78, 98], b = [236, 243, 250];
    return "rgb(" + a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(",") + ")";
  };
  function bucketOf(p) {
    if (trailMode === "plain") return 0;
    const t = TRAIL[trailMode];
    const v = trailMode === "alt" ? p.alt : p.spd;
    return Math.round(clamp((v - t.lo) / (t.hi - t.lo), 0, 1) * (BUCKETS - 1));
  }
  const colourOf = (b) => (trailMode === "plain" ? PLAIN : ramp(b / (BUCKETS - 1)));

  function drawFrom(i0) {
    for (let i = i0; i < pts.length; i++) {
      const p = pts[i], prev = pts[i - 1];
      const ll = [p.lat, p.lon];
      const b = bucketOf(p);
      if (i < DOT_CAP) {
        L.circleMarker(ll, { radius: 3.5, color: "#0B0F13", weight: 1, fillColor: colourOf(b), fillOpacity: 1, interactive: false }).addTo(dotsGroup);
      }
      if (p.brk || !prev) { curLine = null; continue; }                // pen lifted: do not join across a gap
      if (curLine && curBucket === b) {
        curLine.addLatLng(ll);                                         // same shade: keep extending one line
      } else {
        curLine = L.polyline([[prev.lat, prev.lon], ll], { color: colourOf(b), weight: 3, opacity: 1, lineJoin: "round", interactive: false }).addTo(trackGroup);
        curBucket = b;
      }
    }
    drawn = pts.length;
  }
  function rebuildTrack() {
    trackGroup.clearLayers(); dotsGroup.clearLayers();
    curLine = null; curBucket = -1; drawn = 0; drawnMode = trailMode;
    drawFrom(0);
  }
  function syncTrack() {
    if (drawnMode !== trailMode) rebuildTrack();
    else if (drawn < pts.length) drawFrom(drawn);
  }

  // ---------- home, rings, the drone ----------
  const icon = (html) => L.divIcon({ className: "lfm", html, iconSize: [0, 0], iconAnchor: [0, 0] });

  function syncHome() {
    if (!home || homeDrawn) return;
    homeDrawn = true;
    homeMarker = L.marker([home.lat, home.lon], { icon: icon('<div class="home">H<em>HOME</em></div>'), interactive: false, keyboard: false, zIndexOffset: 200 }).addTo(map);
    gridLayer.setOrigin(home.lat, home.lon);
    ringLayers = RINGS.map((r) => ({
      r,
      circle: L.circle([home.lat, home.lon], { radius: r, color: "#34404D", weight: 1, dashArray: "4 4", fill: false, interactive: false }),
      label: L.marker([home.lat + r / 111320, home.lon], { icon: icon('<span class="rg-label">' + fm(r) + "</span>"), interactive: false, keyboard: false }),
      on: false,
    }));
    updateRings();
  }
  function updateRings() {
    if (!map) return;
    const mpp = mPerPxNow();
    for (const R of ringLayers) {
      const px = R.r / mpp;
      const want = px >= 40 && px <= 1400;
      if (want && !R.on) { R.circle.addTo(ringsGroup); R.label.addTo(ringsGroup); R.on = true; }
      else if (!want && R.on) { ringsGroup.removeLayer(R.circle); ringsGroup.removeLayer(R.label); R.on = false; }
    }
  }

  function syncUav() {
    if (!pos) return;
    const ll = [pos.lat, pos.lon];
    if (!uavMarker) {
      uavMarker = L.marker(ll, { icon: icon('<div class="uav"><span class="ring3"></span><span class="ray"></span><span class="tri"></span></div>'), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
      uavEl = uavMarker.getElement().querySelector(".uav");
    } else {
      uavMarker.setLatLng(ll);
    }
    const c = ctx || {};
    const stale = !c.live || pos.fix !== 1;
    uavEl.className = "uav" + (stale ? " o" : c.overall === "crit" ? " c" : c.overall === "warn" ? " w" : "") + (c.live && !c.headingValid ? " h" : "");
    const rot = "rotate(" + lastHdg + "deg)";
    uavEl.querySelector(".ray").style.transform = rot;
    uavEl.querySelector(".tri").style.transform = rot;
  }

  // Alert pins: a flag at the place on the track where each active alert began.
  function pinSpot(a) {
    if (!pts.length) return null;
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].rx <= a.since_unix_ms) return pts[i];
    return pts[0];
  }
  function syncPins() {
    const c = ctx || {};
    const seen = new Set();
    for (const a of c.alerts || []) {
      if (a.parameter === "link") continue;
      const spot = pinSpot(a);
      if (!spot) continue;
      seen.add(a.parameter);
      const key = a.severity + "|" + a.message + "|" + a.since_unix_ms;
      const have = pins.get(a.parameter);
      if (have && have.key === key) continue;
      if (have) map.removeLayer(have.marker);
      const cls = a.severity === "CRITICAL" ? "c" : "w";
      const el = '<button class="pin ' + cls + '" type="button" aria-label="' + a.severity + ' ' + a.message + '"><i></i><b></b></button>';
      const marker = L.marker([spot.lat, spot.lon], { icon: icon(el), keyboard: false, zIndexOffset: 500 }).addTo(map);
      marker.getElement().querySelector("b").textContent = a.severity + " · " + a.message;
      marker.on("click", () => { if (FlightMap.onPin) FlightMap.onPin(a.parameter); });
      pins.set(a.parameter, { marker, key, ll: [spot.lat, spot.lon] });
    }
    for (const [param, p] of pins) if (!seen.has(param)) { map.removeLayer(p.marker); pins.delete(param); }
  }
  function flyToPin(param) {
    const p = pins.get(param);
    if (!p || !map) return false;
    setView(null);
    map.setView(p.ll, Math.max(map.getZoom(), 18), { animate: true });
    return true;
  }

  // ---------- view, base and trail buttons ----------
  function setPressed(attr, value) {
    document.querySelectorAll("[" + attr + "]").forEach((b) => {
      const on = b.getAttribute(attr) === value;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
  function setView(mode) {
    viewMode = mode;
    homeCentred = false; fitCount = -1;
    setPressed("data-view", mode || "");
    dirty = true;
  }
  function setBase(mode) {
    baseMode = mode;
    if (map) {
      if (mode === "tiles") { map.removeLayer(gridLayer); tileLayer.addTo(map); tileErrors = 0; tileLoads = 0; }
      else { map.removeLayer(tileLayer); gridLayer.addTo(map); }
      $("mapvp").classList.toggle("tiles", mode === "tiles");
    }
    setPressed("data-base", mode);
    dirty = true;
  }
  function setTrail(mode) {
    trailMode = mode;
    setPressed("data-trail", mode);
    $("legend").hidden = mode === "plain";
    if (mode !== "plain") {
      const t = TRAIL[mode];
      $("legA").textContent = t.lo + " " + t.unit;
      $("legB").textContent = t.hi + " " + t.unit;
    }
    dirty = true;
  }
  function fit() {
    if (!pts.length) return;
    const b = L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
    if (home) b.extend([home.lat, home.lon]);
    map.fitBounds(b, { padding: [90, 90], maxZoom: 19, animate: false });
  }
  function syncView() {
    if (viewMode === "follow" && pos) {
      map.panTo([pos.lat, pos.lon], { animate: true, duration: 0.25, easeLinearity: 1, noMoveStart: true });
    } else if (viewMode === "home" && home && !homeCentred) {
      map.setView([home.lat, home.lon], map.getZoom(), { animate: false });
      homeCentred = true;
    } else if (viewMode === "fit" && pts.length !== fitCount) {
      fit();
      fitCount = pts.length;
    }
  }

  // ---------- the text around the map ----------
  function paintStats() {
    const c = ctx || {};
    const has = pos && home;
    const here = has ? pos : null;
    $("m-dist").textContent = here ? fm(distM(home, here)) : "--";
    $("m-brg").textContent = here ? "BEARING " + Math.round(bearing(home, here)) + "° " + DIRS[Math.round(bearing(home, here) / 45) % 8] : "BEARING --";
    $("m-len").textContent = pts.length ? fm(lenM) : "--";
    $("m-nfix").textContent = pts.length + " GPS FIX" + (pts.length === 1 ? "" : "ES");

    const mpp = mPerPxNow();
    let nice = NICE[0];
    for (const n of NICE) if (n / mpp <= 150) nice = n;
    $("sbar").style.width = Math.round(nice / mpp) + "px";
    const [minor, major] = gridSteps(mpp);
    $("scaleText").textContent = fm(nice) + (baseMode === "grid" ? " · GRID " + minor + " M / " + major + " M" : "");

    $("zoomIn").disabled = map.getZoom() >= map.getMaxZoom();
    $("zoomOut").disabled = map.getZoom() <= map.getMinZoom();

    const veil = $("mapveil");
    veil.hidden = !c.veilText;
    if (c.veilText) $("mapveilText").textContent = c.veilText;
  }
  function paintChips() {
    const c = ctx || {};
    const list = [];
    for (const a of (c.alerts || []).slice(0, 2)) list.push([a.severity === "CRITICAL" ? "c" : "w", a.severity + " · " + a.message]);
    if (c.live && pos && pos.fix !== 1) list.push(["c", "NO GPS FIX · MARKER SHOWS THE LAST KNOWN POSITION"]);
    if (!pos) list.push(["n", "WAITING FOR THE FIRST GPS POSITION"]);
    if (baseMode === "tiles") {
      list.push(["n", tileErrors > 2 && tileLoads === 0
        ? "MAP TILES NOT LOADING · NO INTERNET? USE GRID"
        : "MAP © OPENSTREETMAP CONTRIBUTORS"]);
    }
    const sig = list.map((x) => x.join(":")).join("|");
    if (sig === chipsText.v) return;
    chipsText.v = sig;
    const host = $("mapchips");
    host.textContent = "";
    for (const [cls, text] of list) {
      const s = document.createElement("span");
      s.className = "chip2 " + cls;
      s.textContent = text;
      host.appendChild(s);
    }
  }

  function paint() {
    if (!map) return;
    dirty = false;
    syncTrack();
    syncHome();
    syncUav();
    syncPins();
    syncView();
    paintStats();
    paintChips();
  }

  // ---------- what app.js can call ----------
  function touch(c) { ctx = c; dirty = true; }
  function show() {
    visible = true;
    if (!ensureMap()) return;
    map.invalidateSize();
    setBase(baseMode);
    homeCentred = false; fitCount = -1;
    paint();
  }
  function hide() { visible = false; }
  function stats() { return { lenM, rangeM, n: pts.length }; }

  function init() {
    document.querySelectorAll("[data-base]").forEach((b) => b.addEventListener("click", () => setBase(b.getAttribute("data-base"))));
    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
      setView(b.getAttribute("data-view"));
      if (map && visible) paint();
    }));
    document.querySelectorAll("[data-trail]").forEach((b) => b.addEventListener("click", () => setTrail(b.getAttribute("data-trail"))));
    $("zoomIn").addEventListener("click", () => { if (map) { if (viewMode === "fit") setView(null); map.zoomIn(); } });
    $("zoomOut").addEventListener("click", () => { if (map) { if (viewMode === "fit") setView(null); map.zoomOut(); } });
    setInterval(() => { if (visible && dirty) paint(); }, REFRESH_MS);
  }
  init();

  return { add, touch, show, hide, stats, flyToPin, onPin: null };
})();
