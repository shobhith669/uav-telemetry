"use strict";

/* Black Box dashboard, Step 4.
   1. Open a WebSocket to the backend (ws://localhost:8000/ws).
   2. Every message that arrives updates `state`.
   3. render() redraws the header, the caution band and the nine cards from `state`.
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

// ---------- what we currently know ----------
const state = {
  connected: false,   // is the WebSocket open?
  last: null,         // newest telemetry message
  linkDown: false,    // true while the backend says "no packets"
  sinceLast: 0,       // seconds since the last packet (from the link message)
  alerts: [],         // active alerts, replaced by every message
  min: {},            // lowest value seen on each card since the page opened
  max: {},            // highest value seen
};

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
function paintTile(tileId, tagId, status) {
  const tile = $(tileId);
  tile.classList.remove("st-warn", "st-crit", "st-stale");
  if (status.cls) tile.classList.add(status.cls);
  $(tagId).textContent = status.tag;
}

// ---------- drawing ----------
function renderHeader() {
  const m = state.last;
  const live = state.connected && m && !state.linkDown;

  $("seq").textContent = m ? m.seq : "--";
  if (m) {
    const secs = Math.floor(m.t_ms / 1000);
    $("flightTime").textContent = "T+ " + String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
  } else {
    $("flightTime").textContent = "T+ --:--";
  }
  $("lossChip").textContent = "LOST " + (m ? m.packets_lost : 0) + " · BAD " + (m ? m.packets_invalid : 0);

  // recording light and reels
  $("rec").classList.toggle("off", !live);
  document.querySelector("#rec .recdot").classList.toggle("hollow", !live);
  $("recText").textContent = live ? "REC" : (state.connected ? "NO DATA" : "OFFLINE");
  $("reel1").classList.toggle("still", !live);
  $("reel2").classList.toggle("still", !live);

  // link chip
  const chip = $("linkChip");
  chip.classList.remove("good", "bad");
  if (!state.connected) { chip.classList.add("bad"); $("linkText").textContent = "BACKEND DISCONNECTED"; }
  else if (!m) { $("linkText").textContent = "WAITING FOR DATA"; }
  else if (state.linkDown) { chip.classList.add("bad"); $("linkText").textContent = "NO DATA · " + state.sinceLast.toFixed(1) + " S"; }
  else { chip.classList.add("good"); $("linkText").textContent = "LINK OK"; }
}

function renderBand() {
  const band = $("band");
  band.className = "band";
  const list = sortedAlerts().filter((a) => a.parameter !== "link");
  let cls, t1, t2;

  if (!state.connected) {
    cls = "b-gap"; t1 = "BACKEND DISCONNECTED"; t2 = "Trying again every " + RECONNECT_MS / 1000 + " s";
  } else if (!state.last) {
    cls = "b-gap"; t1 = "WAITING FOR FIRST PACKET"; t2 = "Start the simulator or switch the drone on";
  } else if (state.linkDown) {
    cls = "b-gap"; t1 = "NO DATA · " + state.sinceLast.toFixed(1) + " S"; t2 = "No packets are arriving. The cards show the last known values.";
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
  band.classList.add(cls);
  $("bandTitle").textContent = t1;
  $("bandText").textContent = t2;
}

function renderNumberCards() {
  const m = state.last;
  for (const c of NUMBER_CARDS) {
    const v = m ? m[c.key] : null;
    const old = c.needsFix && m && m.fix === 0;           // position-based values are old without a fix
    const missing = !m || v === null || v === undefined;
    const status = !m ? { cls: "", tag: "WAIT" }
      : cardStatus(c.param, old ? { cls: "st-stale", tag: "OLD" } : (missing ? { cls: "", tag: "WAIT" } : null));

    $("val-" + c.id).textContent = fmt(v, c.digits, c.signed);
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
    $("foot-" + c.id).textContent = mmText(c);
    paintTile("t-" + c.id, "tag-" + c.id, status);
  }
}

function renderGps() {
  const m = state.last;
  const noFix = m && m.fix === 0;
  $("val-sats").textContent = m ? m.sats : "--";
  $("lat").textContent = m ? m.lat.toFixed(6) : "--";
  $("lon").textContent = m ? m.lon.toFixed(6) : "--";
  $("coords").classList.toggle("old", !!noFix);
  const chip = $("fixchip");
  chip.textContent = noFix ? "NO FIX" : (m ? "FIX OK" : "NO FIX");
  chip.classList.toggle("bad", !m || !!noFix);
  $("foot-gps").textContent = !m ? "WAITING FOR GPS" : (noFix ? "FIX LOST · LAST KNOWN POSITION" : "UPDATES ABOUT ONCE A SECOND");
  paintTile("t-gps", "tag-gps", m ? cardStatus("gps_satellites") : { cls: "", tag: "WAIT" });
}

function renderAttitude() {
  const m = state.last;
  $("val-roll").textContent = m ? fmt(m.roll_deg, 1, true) + "°" : "--";
  $("val-pitch").textContent = m ? fmt(m.pitch_deg, 1, true) + "°" : "--";
  // Right wing down (+roll) tilts the horizon the other way; nose up (+pitch) pushes it down.
  const roll = m ? m.roll_deg : 0;
  const shift = m ? clamp(m.pitch_deg * 0.5, -22, 22) : 0;
  $("horizon").style.transform = "rotate(" + -roll + "deg) translateY(" + shift + "px)";
  $("foot-att").textContent = m ? "TILT " + Math.max(Math.abs(m.roll_deg), Math.abs(m.pitch_deg)).toFixed(1) + "°" : "TILT --";
  paintTile("t-att", "tag-att", m ? cardStatus("tilt") : { cls: "", tag: "WAIT" });
}

function renderHeading() {
  const m = state.last;
  const has = m && m.heading_deg !== null && m.heading_deg !== undefined;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  $("val-hdg").textContent = has ? Math.round(m.heading_deg) + "°" : "--";
  $("dir-hdg").textContent = has ? names[Math.round(m.heading_deg / 45) % 8] : " ";
  $("needle").style.transform = "rotate(" + (has ? m.heading_deg : 0) + "deg)";
  let special = null;
  if (!m || !has) special = { cls: "", tag: "WAIT" };
  else if (!m.heading_valid) special = { cls: "st-stale", tag: m.fix === 0 ? "OLD" : "HOLD" };
  $("foot-hdg").textContent = !has ? "NEEDS GPS AND MOVEMENT" : (m.heading_valid ? "DIRECTION OF TRAVEL" : "LAST GOOD DIRECTION");
  paintTile("t-hdg", "tag-hdg", m ? cardStatus(null, special) : { cls: "", tag: "WAIT" });
}

function render() {
  renderHeader();
  renderBand();
  renderNumberCards();
  renderGps();
  renderAttitude();
  renderHeading();
}

// ---------- messages from the backend ----------
function handle(msg) {
  if (msg.type === "telemetry") {
    state.last = msg;
    state.linkDown = false;
    state.alerts = msg.alerts || [];
    for (const c of NUMBER_CARDS) {
      if (c.needsFix && msg.fix === 0) continue;  // an old repeated value says nothing new
      trackMinMax(c.id, msg[c.key]);
    }
  } else if (msg.type === "link") {
    state.linkDown = true;
    state.sinceLast = msg.since_last_packet_s;
    state.alerts = msg.alerts || [];
  } else {
    return;  // a message type we do not know: ignore it (rule 1 of the agreement)
  }
  render();
}

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
