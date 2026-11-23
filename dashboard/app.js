"use strict";

/* Black Box dashboard, Steps 4 to 6.
   (The GRAPHS tab is in graphs.js and the MAP tab is in map.js. Both are loaded before this file.)
   1. Open a WebSocket to the backend (ws://localhost:8000/ws).
   2. Every message that arrives updates `state`.
   3. render() redraws everything from `state`: header, caution band, the 3D simulation, the nine cards,
      the alert and link panels on the right, and the attitude / heading / record panels on the MAP tab.
   Message format: docs/websocket-message.md. Null means "not known yet", shown as "--". */

// ---------- settings ----------
// How the dashboard connects. Served by the backend, so the address is the page's own address.
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + (location.host || "localhost:8000") + "/ws";
const RECONNECT_MS = 3000;

// The cards that show one number. lo/hi are only the ends of the little bar (display range).
// The alert limits are NOT here: they live in config/thresholds.yaml and arrive as alerts.
const NUMBER_CARDS = [
  { id: "g",    key: "accel_total_g", digits: 2, lo: 0,   hi: 6,   param: "total_acceleration" },
  { id: "temp", key: "temp_c",        digits: 1, lo: 20,  hi: 70,  param: "enclosure_temperature" },
  { id: "alt",  key: "alt_rel_m",     digits: 1, lo: 0,   hi: 100, param: null },
  { id: "vs",   key: "vspeed_mps",    digits: 1, lo: -10, hi: 10,  param: "descent_rate", signed: true, centered: true },
  { id: "spd",  key: "speed_mps",     digits: 1, lo: 0,   hi: 12,  param: null, needsFix: true },
  { id: "batt", key: "vbat_v",        digits: 2, lo: 3.0, hi: 4.2, param: "battery_voltage" },
];

// Names used in the alert list, and which card / graph strip each alert belongs to (for click-to-find).
const ALERT_NAME = {
  battery_voltage: "BATTERY", tilt: "ATTITUDE", total_acceleration: "G-FORCE", descent_rate: "VERTICAL SPEED",
  enclosure_temperature: "TEMPERATURE", gps_satellites: "GPS", link: "LINK",
};
const TILE_OF = {
  battery_voltage: "t-batt", tilt: "t-att", total_acceleration: "t-g", descent_rate: "t-vs",
  enclosure_temperature: "t-temp", gps_satellites: "t-gps", altitude: "t-alt", speed: "t-spd", heading: "t-hdg",
};
const STRIP_OF = {
  battery_voltage: "s-batt", tilt: "s-att", total_acceleration: "s-g", descent_rate: "s-vs",
  enclosure_temperature: "s-temp", gps_satellites: "s-sats", altitude: "s-alt", speed: "s-spd",
};

// ---------- what we currently know ----------
const state = {
  connected: false,   // is the WebSocket open?
  last: null,         // newest telemetry message
  linkDown: false,    // true while the backend says "no packets"
  sinceLast: 0,       // seconds since the last packet (from the link message)
  alerts: [],         // active alerts, replaced by every message
  min: {},            // lowest value seen on each card since the page opened
  max: {},            // highest value seen
  maxTilt: 0,         // biggest tilt seen (for the flight record)
  rx: [],             // arrival times of the last few packets, to work out the packet rate
  arrivedAt: null,    // browser clock at the newest live packet (for "LAST PACKET")
  cam: "chase",       // 3D camera
  focus: null,        // alert / card the person clicked
  copyNote: null,     // "COPIED" for a moment after tapping the coordinates
  tilt: { warn: 45, crit: 70 },   // marks on the tilt bar; replaced by the real limits from /api/thresholds
};
const statuses = {};  // colour and tag of every card, worked out once per render and reused by the simulation HUD
let activeTab = "flight";

const $ = (id) => document.getElementById(id);

// ---------- small helpers ----------
function fmt(v, digits, signed) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  let s = v.toFixed(digits);
  if (Number(s) === 0) s = s.replace("-", "");  // never show "-0.0"
  return signed && Number(s) > 0 ? "+" + s : s;
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pct = (v, lo, hi) => clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const isLive = () => !!(state.connected && state.last && !state.linkDown);
const setText = (id, text) => { const e = $(id); if (e.textContent !== text) e.textContent = text; };

function sortedAlerts() {
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return [...state.alerts].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}
function alertFor(param) {
  return sortedAlerts().find((a) => a.parameter === param) || null;
}
function mmText(c) {
  return "MIN " + fmt(state.min[c.id], c.digits, c.signed) + " · MAX " + fmt(state.max[c.id], c.digits, c.signed);
}
function trackMinMax(id, v) {
  if (v === null || v === undefined) return;
  if (state.min[id] === undefined || v < state.min[id]) state.min[id] = v;
  if (state.max[id] === undefined || v > state.max[id]) state.max[id] = v;
}
function flightTime(m) {
  if (!m) return "T+ --:--";
  const secs = Math.floor(m.t_ms / 1000);
  return "T+ " + String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
}
function duration(s) {
  s = Math.max(0, s);
  return s < 60 ? s.toFixed(1) + " S" : Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") + " MIN";
}

// The heading is an angle that jumps from 359 to 0. A turning picture would spin the long way round at that jump,
// so the pictures use an "unwrapped" heading that keeps counting (358, 359, 360, 361 ...).
const hdgTrack = { prev: null, value: 0 };
function unwrapHeading(h) {
  if (hdgTrack.prev === null) hdgTrack.value = h;
  else hdgTrack.value += ((h - hdgTrack.prev + 540) % 360) - 180;
  hdgTrack.prev = h;
}

// Work out a card's colour and tag. Order: no data > alert > special case > normal.
function cardStatus(param, special) {
  if (!state.connected) return { cls: "st-stale", tag: "OFFLINE" };
  if (state.linkDown) return { cls: "st-stale", tag: "NO DATA" };
  const a = param ? alertFor(param) : null;
  if (a) {
    if (a.severity === "CRITICAL") return { cls: "st-crit", tag: "CRIT" };
    if (a.severity === "WARNING") return { cls: "st-warn", tag: "WARN" };
    return { cls: "", tag: "INFO" };
  }
  return special || { cls: "", tag: "OK" };
}
// Paint a card (or any box) with a status. The same function serves the cards, the simulation boxes and the panels.
function paintTile(tileId, tagId, status) {
  const tile = $(tileId);
  tile.classList.remove("st-warn", "st-crit", "st-stale");
  if (status.cls) tile.classList.add(status.cls);
  setText(tagId, status.tag);
}
function overall() {
  if (!isLive()) return "off";
  if (state.alerts.some((a) => a.severity === "CRITICAL")) return "crit";
  if (state.alerts.some((a) => a.severity === "WARNING")) return "warn";
  return "ok";
}
function veilText() {
  if (!state.connected) return "OFFLINE";
  if (!state.last) return "WAITING FOR DATA";
  if (state.linkDown) return "NO DATA";
  return null;
}

// ---------- drawing: header and caution band ----------
function renderHeader() {
  const m = state.last;
  const live = isLive();

  setText("seq", m ? String(m.seq) : "--");
  setText("flightTime", flightTime(m));
  setText("lossChip", "LOST " + (m ? m.packets_lost : 0) + " · BAD " + (m ? m.packets_invalid : 0));

  // recording light and reels
  $("rec").classList.toggle("off", !live);
  document.querySelector("#rec .recdot").classList.toggle("hollow", !live);
  setText("recText", live ? "REC" : (state.connected ? "NO DATA" : "OFFLINE"));
  $("reel1").classList.toggle("still", !live);
  $("reel2").classList.toggle("still", !live);

  // link chip
  const chip = $("linkChip");
  chip.classList.remove("good", "bad");
  if (!state.connected) { chip.classList.add("bad"); setText("linkText", "BACKEND DISCONNECTED"); }
  else if (!m) { setText("linkText", "WAITING FOR DATA"); }
  else if (state.linkDown) { chip.classList.add("bad"); setText("linkText", "NO DATA · " + state.sinceLast.toFixed(1) + " S"); }
  else { chip.classList.add("good"); setText("linkText", "LINK OK"); }
}

function renderBand() {
  const band = $("band");
  const list = sortedAlerts().filter((a) => a.parameter !== "link");
  let cls, t1, t2;

  if (!state.connected) {
    cls = "b-gap"; t1 = "BACKEND DISCONNECTED"; t2 = "Trying again every " + RECONNECT_MS / 1000 + " s";
  } else if (!state.last) {
    cls = "b-gap"; t1 = "WAITING FOR FIRST PACKET"; t2 = "Start the simulator or switch the drone on";
  } else if (state.linkDown) {
    cls = "b-gap"; t1 = "NO DATA · " + state.sinceLast.toFixed(1) + " S"; t2 = "No packets are arriving. Everything shown is the last known value.";
  } else if (list.length) {
    const crit = list[0].severity === "CRITICAL";
    const word = crit ? "CRITICAL" : "WARNING";
    const text = list[0].message.toUpperCase();
    cls = crit ? "b-crit" : "b-warn";
    t1 = text.startsWith(word) ? text : word + " · " + text;  // the word, not just the colour, tells the level
    t2 = list.length > 1 ? list.slice(1).map((a) => a.message).join(" · ") : "Check the highlighted card";
  } else {
    cls = "b-ok"; t1 = "ALL SYSTEMS NORMAL"; t2 = "No active alerts";
  }
  const want = "band " + cls;
  if (band.className !== want) band.className = want;
  setText("bandTitle", t1);
  setText("bandText", t2);
}

// ---------- drawing: the nine cards ----------
function renderNumberCards() {
  const m = state.last;
  for (const c of NUMBER_CARDS) {
    const v = m ? m[c.key] : null;
    const old = c.needsFix && m && m.fix === 0;           // position-based values are old without a fix
    const missing = !m || v === null || v === undefined;
    const status = !m ? { cls: "", tag: "WAIT" }
      : cardStatus(c.param, old ? { cls: "st-stale", tag: "OLD" } : (missing ? { cls: "", tag: "WAIT" } : null));
    statuses[c.id] = status;

    setText("val-" + c.id, fmt(v, c.digits, c.signed));
    const fill = $("fill-" + c.id);
    if (missing) {
      fill.style.width = "0%";
    } else if (c.centered) {
      const p = pct(v, c.lo, c.hi);
      fill.style.left = Math.min(50, p) + "%";
      fill.style.width = Math.abs(p - 50) + "%";
    } else {
      fill.style.width = pct(v, c.lo, c.hi) + "%";
    }
    setText("foot-" + c.id, mmText(c));
    paintTile("t-" + c.id, "tag-" + c.id, status);
  }
}

function renderGps() {
  const m = state.last;
  const noFix = m && m.fix === 0;
  setText("val-sats", m ? String(m.sats) : "--");
  const hasPos = m && Number.isFinite(m.lat) && Number.isFinite(m.lon);
  const lat = hasPos ? m.lat.toFixed(6) : "--", lon = hasPos ? m.lon.toFixed(6) : "--";
  setText("lat", lat); setText("lon", lon);
  setText("mlat", lat + (hasPos ? " N" : "")); setText("mlon", lon + (hasPos ? " E" : ""));
  $("coords").classList.toggle("old", !!noFix);
  $("mcoords").classList.toggle("old", !!noFix);
  const chip = $("fixchip");
  chip.textContent = noFix ? "NO FIX" : (m ? "FIX OK" : "NO FIX");
  chip.classList.toggle("bad", !m || !!noFix);
  const foot = state.copyNote || (!m ? "WAITING FOR GPS" : (noFix ? "FIX LOST · LAST KNOWN POSITION" : "TAP COORDINATES TO COPY"));
  setText("foot-gps", foot);
  setText("mhint", state.copyNote || (noFix ? "LAST KNOWN POSITION" : "TAP TO COPY"));
  const st = m ? cardStatus("gps_satellites") : { cls: "", tag: "WAIT" };
  statuses.gps = st;
  paintTile("t-gps", "tag-gps", st);
  paintTile("mb-pos", "mt-pos", st);
  $("mb-sats").classList.remove("st-warn", "st-crit", "st-stale");
  if (st.cls) $("mb-sats").classList.add(st.cls);
  setText("m-sats", m ? String(m.sats) : "--");
  setText("m-fix", m && m.fix === 1 ? "FIX" : "NO FIX");
}

function renderAttitude() {
  const m = state.last;
  const roll = m ? m.roll_deg : 0, pitch = m ? m.pitch_deg : 0;
  const rollT = m ? fmt(m.roll_deg, 1, true) + "°" : "--", pitchT = m ? fmt(m.pitch_deg, 1, true) + "°" : "--";
  setText("val-roll", rollT); setText("val-pitch", pitchT);
  setText("hv-roll", rollT); setText("hv-pitch", pitchT);
  setText("pv-roll", rollT); setText("pv-pitch", pitchT);
  // Right wing down (+roll) tilts the horizon the other way; nose up (+pitch) pushes it down.
  $("horizon").style.transform = "rotate(" + -roll + "deg) translateY(" + clamp(pitch * 0.5, -22, 22) + "px)";
  $("ahzw").style.transform = "rotate(" + -roll + "deg) translateY(" + clamp(pitch * 2, -60, 60) + "px)";
  $("rptr").style.transform = "rotate(" + -roll + "deg)";
  const tilt = m ? Math.max(Math.abs(roll), Math.abs(pitch)) : null;
  setText("foot-att", m ? "TILT " + tilt.toFixed(1) + "°" : "TILT --");
  setText("p-tilt", (m ? "TILT " + tilt.toFixed(1) + "°" : "TILT --") + " · LIMITS " + state.tilt.warn + "° / " + state.tilt.crit + "°");
  $("p-tiltfill").style.width = (m ? pct(tilt, 0, 90) : 0) + "%";
  $("p-tick1").style.left = pct(state.tilt.warn, 0, 90) + "%";
  $("p-tick2").style.left = pct(state.tilt.crit, 0, 90) + "%";
  const st = m ? cardStatus("tilt") : { cls: "", tag: "WAIT" };
  statuses.att = st;
  paintTile("t-att", "tag-att", st);
  paintTile("hb-att", "ht-att", st);
  paintTile("p-att", "ptag-att", st);
}

function renderHeading() {
  const m = state.last;
  const has = m && m.heading_deg !== null && m.heading_deg !== undefined;
  const hdgT = has ? Math.round(m.heading_deg) % 360 + "°" : "--";
  const dirT = has ? DIRS[Math.round(m.heading_deg / 45) % 8] : "";
  setText("val-hdg", hdgT); setText("hv-hdg", hdgT); setText("pv-hdg", hdgT);
  setText("dir-hdg", dirT || " "); setText("hd-hdg", dirT || " "); setText("pv-dir", dirT || "--");
  const turn = "rotate(" + hdgTrack.value + "deg)";
  $("needle").style.transform = turn;
  $("pneedle").style.transform = turn;
  let special = null;
  if (!m || !has) special = { cls: "", tag: "WAIT" };
  else if (!m.heading_valid) special = { cls: "st-stale", tag: m.fix === 0 ? "OLD" : "HOLD" };
  setText("foot-hdg", !has ? "NEEDS GPS AND MOVEMENT" : (m.heading_valid ? "DIRECTION OF TRAVEL" : "LAST GOOD DIRECTION"));
  let note = "Direction of travel from GPS, valid while moving faster than 1 m/s. It is not where the nose points.";
  if (!m) note = "Waiting for data.";
  else if (state.linkDown) note = "NO DATA. Last known value shown.";
  else if (!has) note = "Needs a GPS fix and some movement before a direction can be worked out.";
  else if (!m.heading_valid) note = m.fix === 0 ? "No GPS fix. Last known direction shown." : "Last good value. The drone is not moving fast enough for a new one.";
  setText("p-hdgnote", note);
  const st = m ? cardStatus(null, special) : { cls: "", tag: "WAIT" };
  statuses.hdg = st;
  paintTile("t-hdg", "tag-hdg", st);
  paintTile("hb-hdg", "ht-hdg", st);
  paintTile("p-hdg", "ptag-hdg", st);
}

// ---------- drawing: the 3D simulation and its HUD ----------
let sceneH = 600;   // height of the simulation picture in pixels, kept up to date when the window changes size
if (window.ResizeObserver) new ResizeObserver((entries) => { sceneH = entries[0].contentRect.height || sceneH; if (state.last) renderScene(); }).observe($("stage"));
function renderScene() {
  const m = state.last;
  const live = isLive();
  const alt = m && m.alt_rel_m != null ? m.alt_rel_m : 0;
  const roll = m ? m.roll_deg : 0, pitch = m ? m.pitch_deg : 0;
  const spd = m && m.speed_mps != null ? m.speed_mps : 0;
  const rawHdg = m && m.heading_deg != null ? m.heading_deg : 0;

  // the picture: the drone tilts and turns with the data; the ground grid slides under it.
  // The climb is drawn smaller in a short window, so the drone never leaves the top of the picture.
  const altPx = clamp(alt, 0, 120) * 1.6 * clamp(sceneH / 600, 0.55, 1.25);
  const shS = 120 + clamp(alt, 0, 120) * 0.9;
  $("drone").style.transform = "translateY(" + (87 - altPx).toFixed(1) + "px) rotateY(" + (-hdgTrack.value).toFixed(1) + "deg) rotateX(" + (-pitch).toFixed(1) + "deg) rotateZ(" + roll.toFixed(1) + "deg)";
  const line = { top: (118 - altPx).toFixed(1) + "px", height: altPx.toFixed(1) + "px" };
  Object.assign($("aline").style, line); Object.assign($("aline2").style, line);
  Object.assign($("shadow").style, {
    width: shS.toFixed(0) + "px", height: shS.toFixed(0) + "px", margin: (-shS / 2).toFixed(0) + "px 0 0 " + (-shS / 2).toFixed(0) + "px",
    opacity: clamp(0.85 - alt * 0.004, 0.3, 0.85).toFixed(2),
  });
  $("gridrot").style.transform = "rotate(" + hdgTrack.value.toFixed(1) + "deg)";
  const flow = live && m && m.fix === 1 && spd > 0.5;
  $("grid").style.animationDuration = (spd > 0.5 ? 6 / spd : 4).toFixed(2) + "s";
  $("grid").style.animationPlayState = flow ? "running" : "paused";

  const ov = overall();
  const battA = alertFor("battery_voltage");
  const droneCls = "drone led-" + ov + " " + (battA ? (battA.severity === "CRITICAL" ? "bat-crit" : "bat-warn") : "bat-ok") + (live ? "" : " halt");
  if ($("drone").className !== droneCls) $("drone").className = droneCls;
  const ringCls = "ring rc-" + ov;
  if ($("ring").className !== ringCls) $("ring").className = ringCls;
  const worldCls = "world cam-" + state.cam;
  if ($("world").className !== worldCls) $("world").className = worldCls;
  $("stage").setAttribute("aria-label", m
    ? "Flight simulation. Roll " + fmt(roll, 1, true) + " degrees, pitch " + fmt(pitch, 1, true) + " degrees, heading " + Math.round(rawHdg) + " degrees, altitude " + fmt(alt, 1) + " metres."
    : "Flight simulation. No data yet.");

  // the notices
  const vt = veilText();
  $("veil").hidden = !vt;
  if (vt) setText("veilText", vt);
  $("snote").hidden = !(live && m.fix === 0);

  // the boxes laid over the picture
  const old = (text) => (!m ? "NO DATA" : state.linkDown ? state.sinceLast.toFixed(1) + " S OLD" : text);
  setText("hv-alt", fmt(m ? alt : null, 1));
  $("hfill-alt").style.height = pct(alt, 0, 100) + "%";
  setText("hc-alt", old("ABOVE TAKEOFF"));
  paintTile("hb-alt", "ht-alt", statuses.alt);

  const vs = m ? m.vspeed_mps : null;
  setText("hv-vs", fmt(vs, 1, true));
  const arrow = vs === null || vs === undefined ? "lv" : vs > 0.5 ? "up" : vs < -0.5 ? "dn" : "lv";
  $("harr-vs").className = "arr " + arrow;
  setText("hc-vs", old(arrow === "up" ? "CLIMBING" : arrow === "dn" ? "DESCENDING" : "LEVEL"));
  paintTile("hb-vs", "ht-vs", statuses.vs);

  setText("hv-spd", fmt(m ? m.speed_mps : null, 1));
  setText("hc-spd", old(m && m.fix === 1 ? (spd * 3.6).toFixed(1) + " KM/H" : "LAST KNOWN"));
  paintTile("hb-spd", "ht-spd", statuses.spd);

  setText("hv-batt", fmt(m ? m.vbat_v : null, 2));
  $("hfill-batt").style.width = (m ? pct(m.vbat_v, 3.0, 4.2) : 0) + "%";
  paintTile("hb-batt", "ht-batt", statuses.batt);

  // heading tape: the compass points slide past a fixed marker
  const tape = $("tape2");
  const labels = tape.children;
  for (let i = 0; i < 8; i++) {
    const delta = (((i * 45 - rawHdg + 540) % 360) + 360) % 360 - 180;
    labels[i].style.left = (50 + (delta / 90) * 50).toFixed(1) + "%";
    labels[i].style.opacity = Math.abs(delta) <= 100 ? "1" : "0";
  }
  tape.style.backgroundPosition = (150 - (((rawHdg % 10) + 10) % 10) * 1.6667).toFixed(2) + "px bottom";

  // chips at the top: the two most important alerts
  const chips = sortedAlerts().slice(0, 2).map((a) => [a.severity === "CRITICAL" ? "c" : "w", a.severity + " · " + a.message + " · " + alertValue(a)]);
  const sig = chips.map((c) => c.join(":")).join("|");
  const host = $("hchips");
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.textContent = "";
    for (const [cls, text] of chips) {
      const s = document.createElement("span");
      s.className = "chip2 " + cls;
      s.textContent = text;
      host.appendChild(s);
    }
  }
}

// ---------- drawing: alert panel and link panel (right side, always visible) ----------
function alertValue(a) {
  const v = a.value;
  if (v === null || v === undefined) return "";
  switch (a.parameter) {
    case "battery_voltage": return v.toFixed(2) + " V";
    case "tilt": return v.toFixed(1) + "°";
    case "total_acceleration": return v.toFixed(2) + " g";
    case "descent_rate": return v.toFixed(1) + " m/s DOWN";
    case "enclosure_temperature": return v.toFixed(1) + " °C";
    case "gps_satellites": return Math.round(v) + " SATS" + (state.last && state.last.fix === 0 ? ", NO FIX" : "");
    case "link": return v.toFixed(1) + " S";
    default: return String(v);
  }
}

const alertRows = new Map();   // parameter -> its row, so the rows are updated in place instead of rebuilt 10 times a second
function makeRow(param) {
  const el = document.createElement("button");
  el.type = "button";
  el.innerHTML = '<span class="sev"></span><span class="abody"><span class="am"></span><span class="ad"></span></span>';
  el.addEventListener("click", () => focusParam(param));
  return el;
}
function renderAlerts() {
  const list = state.connected ? sortedAlerts() : [];
  const host = $("alertList");
  const seen = new Set();
  list.forEach((a, i) => {
    let row = alertRows.get(a.parameter);
    if (!row) { row = makeRow(a.parameter); alertRows.set(a.parameter, row); }
    seen.add(a.parameter);
    const sev = a.severity === "CRITICAL" ? "c" : a.severity === "WARNING" ? "w" : "n";
    const cls = "arow " + sev + (state.focus === a.parameter ? " f" : "");
    if (row.className !== cls) row.className = cls;
    const [sevEl, body] = [row.children[0], row.children[1]];
    if (sevEl.className !== "sev " + sev) sevEl.className = "sev " + sev;
    if (sevEl.textContent !== a.severity) sevEl.textContent = a.severity;
    if (body.children[0].textContent !== a.message) body.children[0].textContent = a.message;
    const since = state.last ? (state.last.rx_unix_ms - a.since_unix_ms) / 1000 : 0;
    const detail = a.parameter === "link"
      ? "LINK · " + state.sinceLast.toFixed(1) + " S WITHOUT DATA"
      : (ALERT_NAME[a.parameter] || a.parameter.toUpperCase()) + " · " + alertValue(a) + " · FOR " + duration(since);
    if (body.children[1].textContent !== detail) body.children[1].textContent = detail;
    row.setAttribute("aria-label", a.severity + ". " + a.message + ". " + detail);
    if (host.children[i] !== row) host.insertBefore(row, host.children[i] || null);
  });
  for (const [param, row] of alertRows) if (!seen.has(param)) { row.remove(); alertRows.delete(param); }

  setText("alertCount", !state.connected || !state.last ? "--" : list.length + " ACTIVE");
  const clear = $("clearBox");
  clear.hidden = list.length > 0;
  const idle = !state.connected || !state.last;
  clear.classList.toggle("idle", idle);
  clear.querySelector(".ct").textContent = !state.connected ? "NO CONNECTION" : !state.last ? "WAITING" : "ALL CLEAR";
  clear.querySelector(".cs").textContent = !state.connected ? "The backend is not connected. Alerts appear here once it is."
    : !state.last ? "Waiting for the first packet."
    : "No active alerts. Every monitored value is inside its limits.";
}

function packetRate() {
  const r = state.rx;
  if (r.length < 2) return null;
  const span = (r[r.length - 1] - r[0]) / 1000;
  return span > 0 ? (r.length - 1) / span : null;
}
function renderLink() {
  const m = state.last;
  const down = state.connected && state.linkDown;
  const ok = isLive();
  const stateTxt = !state.connected ? "DISCONNECTED" : !m ? "WAITING" : down ? "NO DATA" : "OK";
  setText("linkState", stateTxt);
  $("linkState").classList.toggle("bad", !state.connected || down);
  $("p-link").classList.remove("st-crit", "st-stale");
  if (down) $("p-link").classList.add("st-crit"); else if (!state.connected) $("p-link").classList.add("st-stale");
  setText("lk-backend", state.connected ? "CONNECTED" : "DISCONNECTED");
  $("lk-backend").classList.toggle("bad", !state.connected);
  const rate = packetRate();
  setText("lk-rate", down ? "0 Hz" : ok && rate ? rate.toFixed(1) + " Hz" : "--");
  $("lk-rate").classList.toggle("bad", down);
  setText("lk-loss", (m ? m.packets_lost : 0) + " / " + (m ? m.packets_invalid : 0));
  renderLastPacket();
}
function renderLastPacket() {   // also runs on a timer, so the number keeps counting while nothing arrives
  const el = $("lk-last");
  if (!state.connected || state.arrivedAt === null) { setText("lk-last", "--"); el.classList.remove("bad"); return; }
  const s = (performance.now() - state.arrivedAt) / 1000;
  setText("lk-last", s.toFixed(1) + " s ago");
  el.classList.toggle("bad", state.linkDown);
}

// ---------- drawing: the panels under the map ----------
function renderRecord() {
  const m = state.last;
  const ms = FlightMap.stats();
  setText("p-tc", flightTime(m));
  setText("r-alt", state.max.alt === undefined ? "--" : fmt(state.max.alt, 1) + " m");
  setText("r-spd", state.max.spd === undefined ? "--" : fmt(state.max.spd, 1) + " m/s");
  const km = (x) => (x >= 1000 ? (x / 1000).toFixed(2) + " km" : Math.round(x) + " m");
  setText("r-range", ms.n ? km(ms.rangeM) : "--");
  setText("r-len", ms.n ? km(ms.lenM) : "--");
  setText("r-batt", state.min.batt === undefined ? "--" : fmt(state.min.batt, 2) + " V");
  setText("r-tilt", m ? state.maxTilt.toFixed(1) + "°" : "--");
}

function render() {
  renderHeader();
  renderBand();
  renderNumberCards();
  renderGps();
  renderAttitude();
  renderHeading();
  renderScene();        // uses the statuses worked out above
  renderAlerts();
  renderLink();
  renderRecord();
  Graphs.touch();       // the strips on the GRAPHS tab take their colours from the same state
  FlightMap.touch({
    live: isLive(), veilText: veilText(), overall: overall(), alerts: state.alerts,
    headingValid: !!(state.last && state.last.heading_valid),
  });
}

// ---------- messages from the backend ----------
function applyTelemetry(msg) {
  state.last = msg;
  state.linkDown = false;
  state.alerts = msg.alerts || [];
  for (const c of NUMBER_CARDS) {
    if (c.needsFix && msg.fix === 0) continue;  // an old repeated value says nothing new
    trackMinMax(c.id, msg[c.key]);
  }
  if (Number.isFinite(msg.roll_deg) && Number.isFinite(msg.pitch_deg)) {
    state.maxTilt = Math.max(state.maxTilt, Math.abs(msg.roll_deg), Math.abs(msg.pitch_deg));
  }
  if (msg.heading_deg !== null && msg.heading_deg !== undefined) unwrapHeading(msg.heading_deg);
  state.rx.push(msg.rx_unix_ms);
  if (state.rx.length > 20) state.rx.shift();
  Graphs.add(msg);                              // the GRAPHS tab keeps the history
  FlightMap.add(msg);                           // the MAP tab keeps the track
}

function handle(msg) {
  if (msg.type === "telemetry") {
    applyTelemetry(msg);
    state.arrivedAt = performance.now();
  } else if (msg.type === "history") {
    // sent once when the page opens: the recent past, so a refreshed page does not start with empty graphs
    for (const m of msg.messages || []) applyTelemetry(m);
    hdgTrack.value = hdgTrack.prev === null ? 0 : hdgTrack.prev;   // start the live pictures from a plain 0-360 heading
  } else if (msg.type === "link") {
    state.linkDown = true;
    state.sinceLast = msg.since_last_packet_s;
    state.alerts = msg.alerts || [];
  } else {
    return;  // a message type we do not know: ignore it (rule 1 of the agreement)
  }
  render();
}

// ---------- clicking: find the card, strip or map pin that belongs to an alert ----------
let focusTimer = null;
const smooth = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
function paintFocus() {
  document.querySelectorAll(".tile.focus, .strip.focus, #p-link.focus").forEach((e) => e.classList.remove("focus"));
  const f = state.focus;
  if (!f) return;
  const ids = f === "link" ? ["p-link"] : [TILE_OF[f], STRIP_OF[f]];
  for (const id of ids) { const e = id && $(id); if (e) e.classList.add("focus"); }
}
function setFocus(param) {
  state.focus = param;
  clearTimeout(focusTimer);
  paintFocus();
  renderAlerts();
  if (param) focusTimer = setTimeout(() => setFocus(null), 6000);   // the highlight fades after a few seconds
}
function focusParam(param) {
  setFocus(state.focus === param ? null : param);
  if (!state.focus) return;
  const row = alertRows.get(param);
  if (row) row.scrollIntoView({ block: "nearest", behavior: smooth() });
  const target = activeTab === "flight" ? $(TILE_OF[param]) : activeTab === "graphs" ? $(STRIP_OF[param]) : null;
  if (target) target.scrollIntoView({ block: "nearest", behavior: smooth() });
  if (activeTab === "map") FlightMap.flyToPin(param);
}
FlightMap.onPin = (param) => {          // clicking an alert flag on the map highlights its row on the right
  setFocus(param);
  const row = alertRows.get(param);
  if (row) row.scrollIntoView({ block: "nearest", behavior: smooth() });
};
document.querySelectorAll("[data-focus]").forEach((b) => b.addEventListener("click", () => focusParam(b.getAttribute("data-focus"))));
$("p-link").addEventListener("click", () => focusParam("link"));

// ---------- copy the coordinates ----------
let copyTimer = null;
function copyCoords() {
  const m = state.last;
  if (!m || !Number.isFinite(m.lat) || !Number.isFinite(m.lon)) return;
  const text = m.lat.toFixed(6) + ", " + m.lon.toFixed(6);
  const done = (ok) => {
    state.copyNote = ok ? "COPIED" : "COPY FAILED";
    renderGps();
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { state.copyNote = null; renderGps(); }, 1600);
  };
  try {
    navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
  } catch (e) { done(false); }
}
$("coords").addEventListener("click", copyCoords);
$("mcoords").addEventListener("click", copyCoords);

// ---------- camera buttons ----------
document.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => {
  state.cam = b.getAttribute("data-cam");
  document.querySelectorAll("[data-cam]").forEach((x) => {
    const on = x === b;
    x.classList.toggle("on", on);
    x.setAttribute("aria-pressed", String(on));
  });
  renderScene();
}));

// ---------- tabs ----------
const TABS = { flight: "pane-flight", graphs: "pane-graphs", map: "pane-map" };

function selectTab(name) {
  activeTab = name;
  for (const [tab, paneId] of Object.entries(TABS)) {
    $(paneId).hidden = tab !== name;
    $("tab-" + tab).classList.toggle("on", tab === name);
    $("tab-" + tab).setAttribute("aria-pressed", String(tab === name));
  }
  $("gtools").hidden = name !== "graphs";
  if (name === "graphs") Graphs.show(); else Graphs.hide();
  if (name === "map") FlightMap.show(); else FlightMap.hide();
  history.replaceState(null, "", name === "flight" ? location.pathname : "#" + name);  // a refresh keeps the tab
  paintFocus();
}
for (const tab of Object.keys(TABS)) $("tab-" + tab).addEventListener("click", () => selectTab(tab));

// ---------- small one-time set-up ----------
(function buildDecorations() {
  // eight compass letters for the heading tape
  const tape = $("tape2");
  ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].forEach((t) => {
    const s = document.createElement("span");
    s.className = "tl";
    s.textContent = t;
    tape.appendChild(s);
  });
  // the roll scale on the big attitude indicator: marks every 10 to 30 degrees, then 45 and 60, on both sides
  const ticks = $("rticks");
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const i = document.createElement("i");
    i.className = "rt" + (a === 0 ? " z" : "");
    i.style.transform = "rotate(" + a + "deg)";
    ticks.appendChild(i);
  }
})();

// The tilt bar's marks come from the same limits the alert engine uses.
fetch("/api/thresholds").then((r) => r.json()).then((cfg) => {
  if (cfg && cfg.tilt) { state.tilt = { warn: cfg.tilt.warning_above, crit: cfg.tilt.critical_above }; render(); }
}).catch(() => {});

// ---------- connection ----------
function connect() {
  const ws = new WebSocket(WS_URL);
  ws.onopen = () => { state.connected = true; render(); };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    handle(msg);
  };
  ws.onclose = () => {
    state.connected = false;
    render();
    setTimeout(connect, RECONNECT_MS);  // try again in a few seconds
  };
}

render();
connect();
setInterval(renderLastPacket, 250);
if (location.hash === "#graphs") selectTab("graphs");
else if (location.hash === "#map") selectTab("map");
