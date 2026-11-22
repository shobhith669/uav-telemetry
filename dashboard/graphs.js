"use strict";

/* Black Box dashboard, Step 5: the GRAPHS tab.

   Every telemetry message is stored as one "sample". Eight strips (one per channel) draw the last
   15 s / 30 s / 1 min / whole flight of samples, using Apache ECharts (bundled in dashboard/vendor/
   so it works without internet). Hover to read every strip at one moment, click to hold the cursor.

   The page loads this file before app.js. The helpers it uses from app.js (state, cardStatus, fmt)
   are only called later, once both files are loaded. */

const Graphs = (() => {
  // ---------- settings ----------
  const MAX_SAMPLES = 20000;   // about 30 minutes at 10 per second; older samples are dropped
  const GAP_S = 0.5;           // more than this between two packets counts as a gap in the data
  const REFRESH_MS = 250;      // the graphs redraw at most 4 times a second
  const MAX_POINTS = 2000;     // never draw more points than this per line
  const WINDOWS = [["15 S", 15], ["30 S", 30], ["1 MIN", 60], ["ALL", Infinity]];
  const DEFAULT_WINDOW = 2;    // 1 MIN
  const COLORS = { line: "#9FB4C9", roll: "#6F8AA6", pitch: "#E3ECF5", grid: "#1D242C", axis: "#8E99A8",
                   warn: "#FFC233", crit: "#FF6B6B", cursor: "#FF6A1F", off: "#5A6572", ok: "#EDF1F5" };

  // The eight strips. y0/y1 is the normal range of the axis (it grows if a value goes outside it),
  // step is the gap between the axis numbers. "limit" says which rule in config/thresholds.yaml
  // belongs to the strip, so the warning and critical zones are drawn from the real limits.
  const CHANNELS = [
    { id: "alt",  ch: "CH 01", name: "ALTITUDE · REL",  unit: "m",    y0: 0,   y1: 100, step: 25,  digits: 1, area: true,
      series: [{ key: "alt_rel_m" }] },
    { id: "att",  ch: "CH 02", name: "ATTITUDE",        unit: "°",    y0: -90, y1: 90,  step: 45,  digits: 1, signed: true,
      param: "tilt", limit: { cfg: "tilt", kind: "abs" },
      series: [{ key: "roll_deg", label: "ROLL", color: COLORS.roll, swatch: "r1" },
               { key: "pitch_deg", label: "PITCH", color: COLORS.pitch, swatch: "r2" }] },
    { id: "batt", ch: "CH 03", name: "BATTERY",         unit: "V",    y0: 3.0, y1: 4.4, step: 0.4, digits: 2, area: true,
      param: "battery_voltage", limit: { cfg: "battery_voltage", kind: "below" },
      series: [{ key: "vbat_v" }] },
    { id: "vs",   ch: "CH 04", name: "VERTICAL SPEED",  unit: "m/s",  y0: -16, y1: 8,   step: 8,   digits: 1, signed: true, area: true,
      param: "descent_rate", limit: { cfg: "descent_rate", kind: "descent" },
      series: [{ key: "vspeed_mps" }] },
    { id: "spd",  ch: "CH 05", name: "GROUND SPEED",    unit: "m/s",  y0: 0,   y1: 15,  step: 5,   digits: 1, area: true, needsFix: true,
      series: [{ key: "speed_mps" }] },
    { id: "g",    ch: "CH 06", name: "G-FORCE",         unit: "g",    y0: 0,   y1: 8,   step: 2,   digits: 2, area: true,
      param: "total_acceleration", limit: { cfg: "total_acceleration", kind: "above" },
      series: [{ key: "accel_total_g" }] },
    { id: "temp", ch: "CH 07", name: "TEMPERATURE",     unit: "°C",   y0: 20,  y1: 80,  step: 15,  digits: 1, area: true,
      param: "enclosure_temperature", limit: { cfg: "enclosure_temperature", kind: "above" },
      series: [{ key: "temp_c" }] },
    { id: "sats", ch: "CH 08", name: "GPS SATELLITES",  unit: "sats", y0: 0,   y1: 16,  step: 4,   digits: 0, area: true, stepped: true,
      param: "gps_satellites", limit: { cfg: "gps_satellites", kind: "below" },
      series: [{ key: "sats" }] },
  ];
  const SEVERITY_RANK = { INFO: 0, WARNING: 1, CRITICAL: 2 };
  const PARAM_TO_CHANNEL = {};
  for (const c of CHANNELS) if (c.param) PARAM_TO_CHANNEL[c.param] = c.id;

  // ---------- what we have recorded ----------
  let samples = [];            // {t, ...fields}; {t, brk: true} marks a break in the line
  let gaps = [];               // finished gaps: {t0, t1}
  let events = [];             // alerts that started: {t, ch, sev, text}
  let active = {};             // alert parameter -> severity, to spot new alerts
  let lastT = null;            // flight time (s) of the newest sample

  // ---------- what the person is doing ----------
  let winIdx = DEFAULT_WINDOW;
  let pinned = false;          // true while the cursor is held
  let cursorT = null;          // time the readouts show; null = the newest sample
  let frozen = null;           // the x range kept still while the cursor is held
  let range = { min: 0, max: 60 };  // x range of the last drawing
  let thresholds = null;       // from /api/thresholds
  let charts = null;
  let visible = false;
  let dirty = true;

  const $ = (id) => document.getElementById(id);
  const mmss = (s, decimals) => {
    const v = Math.max(0, s);
    const m = Math.floor(v / 60);
    const sec = v - m * 60;
    return String(m).padStart(2, "0") + ":" + (decimals ? sec.toFixed(1).padStart(4, "0") : String(Math.floor(sec)).padStart(2, "0"));
  };

  // ---------- recording ----------
  function reset() {
    samples = []; gaps = []; events = []; active = {}; lastT = null;
    pinned = false; cursorT = null; frozen = null;
  }

  function add(msg) {
    const t = msg.t_ms / 1000;
    if (lastT !== null && t < lastT - 2) reset();      // the drone restarted: begin a new recording
    if (lastT !== null && t <= lastT) return;           // a repeat (for example after a reconnect)
    if (lastT !== null && t - lastT > GAP_S) {
      samples.push({ t: lastT + 0.001, brk: true });    // lift the pen: no line across missing data
      gaps.push({ t0: lastT, t1: t });
    }
    samples.push({
      t, alt_rel_m: msg.alt_rel_m, roll_deg: msg.roll_deg, pitch_deg: msg.pitch_deg, vbat_v: msg.vbat_v,
      vspeed_mps: msg.vspeed_mps, speed_mps: msg.speed_mps, fix: msg.fix, accel_total_g: msg.accel_total_g,
      temp_c: msg.temp_c, sats: msg.sats,
    });
    lastT = t;

    // remember when each alert started or got worse
    const now = {};
    for (const a of msg.alerts || []) {
      if (a.parameter === "link") continue;
      now[a.parameter] = a.severity;
      const before = active[a.parameter];
      const worse = before === undefined || SEVERITY_RANK[a.severity] > SEVERITY_RANK[before];
      const ch = PARAM_TO_CHANNEL[a.parameter];
      if (worse && ch) {
        const last = events.filter((e) => e.ch === ch).pop();
        if (last && t - last.t < 2) {          // WARNING then CRITICAL within 2 s: one marker, the worse one
          last.sev = a.severity; last.text = a.message;
        } else {
          events.push({ t, ch, sev: a.severity, text: a.message });
        }
      }
    }
    active = now;

    if (samples.length > MAX_SAMPLES) {
      samples.splice(0, 1000);
      const first = samples[0].t;
      gaps = gaps.filter((g) => g.t1 >= first);
      events = events.filter((e) => e.t >= first);
    }
    dirty = true;
  }

  function touch() { dirty = true; }

  // ---------- the limits drawn on each strip ----------
  // lines: dashed lines with a label; zones: shaded bands. Infinity means "to the edge of the strip".
  function limitsFor(ch) {
    const cfg = thresholds && ch.limit && thresholds[ch.limit.cfg];
    if (!cfg) return { lines: [], zones: [] };
    const u = ch.unit === "sats" ? "" : ch.unit === "°" ? "°" : " " + ch.unit;
    const L = (v, lvl, name) => ({ v, lvl, text: name + " " + v + u });
    const kind = ch.limit.kind;
    if (kind === "below") {
      const w = cfg.warning_below, c = cfg.critical_below;
      return { lines: [L(w, "w", "WARN"), L(c, "c", "CRIT")],
               zones: [{ a: c, b: w, lvl: "w" }, { a: -Infinity, b: c, lvl: "c" }] };
    }
    const w = cfg.warning_above, c = cfg.critical_above;
    if (kind === "above") {
      return { lines: [L(w, "w", "WARN"), L(c, "c", "CRIT")],
               zones: [{ a: w, b: c, lvl: "w" }, { a: c, b: Infinity, lvl: "c" }] };
    }
    if (kind === "descent") {   // the limits are descent speeds, drawn below zero
      return { lines: [L(-w, "w", "WARN"), L(-c, "c", "CRIT")],
               zones: [{ a: -c, b: -w, lvl: "w" }, { a: -Infinity, b: -c, lvl: "c" }] };
    }
    // "abs": tilt is the larger of |roll| and |pitch|, so both signs are drawn
    return { lines: [L(w, "w", "WARN"), L(c, "c", "CRIT"), { v: -w, lvl: "w", text: "" }, { v: -c, lvl: "c", text: "" }],
             zones: [{ a: w, b: c, lvl: "w" }, { a: c, b: Infinity, lvl: "c" }, { a: -c, b: -w, lvl: "w" }, { a: -Infinity, b: -c, lvl: "c" }] };
  }

  // ---------- page structure ----------
  function buildStrips() {
    const host = $("strips");
    host.innerHTML = "";
    for (const ch of CHANNELS) {
      const reads = ch.series.map((s, i) =>
        '<span class="rd">' + (ch.series.length > 1 ? '<i class="sw ' + s.swatch + '"></i><span class="k">' + s.label + "</span>" : "") +
        '<span class="v mono" id="rd-' + ch.id + "-" + i + '">--</span><span class="u">' + ch.unit + "</span></span>").join("");
      const sec = document.createElement("section");
      sec.className = "strip";
      sec.id = "s-" + ch.id;
      sec.innerHTML =
        '<div class="sh"><div class="shl"><div class="shn"><span class="chn mono">' + ch.ch + '</span><h2 class="sn">' + ch.name +
        '</h2><span class="tag" id="stag-' + ch.id + '">WAIT</span></div><div class="smm mono" id="smm-' + ch.id + '">MIN -- · MAX --</div></div>' +
        '<div class="shr">' + reads + "</div></div>" +
        '<div class="plot" id="plot-' + ch.id + '" tabindex="0" role="img" aria-label="' + ch.name.toLowerCase() +
        ' over time. Click to hold the cursor, use the left and right arrow keys to move it, Escape to follow live."></div>';
      host.appendChild(sec);
    }
  }

  function buildTools() {
    const box = $("wins");
    box.innerHTML = "";
    WINDOWS.forEach(([label], i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bb sq";
      b.textContent = label;
      b.setAttribute("aria-pressed", String(i === winIdx));
      b.addEventListener("click", () => { winIdx = i; unpin(); paintTools(); dirty = true; });
      box.appendChild(b);
    });
    $("followBtn").addEventListener("click", unpin);
  }

  function paintTools() {
    [...$("wins").children].forEach((b, i) => b.setAttribute("aria-pressed", String(i === winIdx)));
    $("followBtn").hidden = !pinned;
    const hover = cursorT !== null;
    $("cursText").textContent = pinned ? "HELD · T+ " + mmss(cursorT, true)
      : hover ? "CURSOR · T+ " + mmss(cursorT, true)
      : state.linkDown ? "NO DATA" : "LIVE";
    $("cursText").classList.toggle("held", pinned);
  }

  // ---------- the cursor ----------
  function pinAt(t) {
    if (lastT === null) return;
    const first = samples[0].t;
    cursorT = Math.min(lastT, Math.max(first, t));
    if (!pinned) frozen = { min: range.min, max: range.max };
    pinned = true;
    updateReadouts();
    paintTools();
    dirty = true;
  }

  function unpin() {
    pinned = false; cursorT = null; frozen = null;
    updateReadouts();
    paintTools();
    dirty = true;
  }

  function sampleAt(t) {
    // the real sample closest to time t, or null if t falls in a gap
    if (!samples.length) return null;
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t < t) lo = mid + 1; else hi = mid;
    }
    let best = null;
    for (const i of [lo - 2, lo - 1, lo, lo + 1]) {
      const s = samples[i];
      if (s && !s.brk && (best === null || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s;
    }
    return best && Math.abs(best.t - t) <= GAP_S ? best : null;
  }

  function newestSample() {
    for (let i = samples.length - 1; i >= 0; i--) if (!samples[i].brk) return samples[i];
    return null;
  }

  function updateReadouts() {
    const s = cursorT === null ? newestSample() : sampleAt(cursorT);
    for (const ch of CHANNELS) {
      ch.series.forEach((ser, i) => {
        $("rd-" + ch.id + "-" + i).textContent = s ? fmt(s[ser.key], ch.digits, ch.signed) : "--";
      });
    }
  }

  function onPointer(ev) {
    const a = ev.axesInfo && ev.axesInfo.find((x) => x.axisDim === "x");
    if (!a || pinned) return;
    cursorT = a.value;
    updateReadouts();
    paintTools();
  }
  function onLeave() {
    if (pinned || cursorT === null) return;
    cursorT = null;
    updateReadouts();
    paintTools();
  }
  function onKey(ev) {
    if (lastT === null) return;
    const big = ev.shiftKey ? 5 : 0.5;
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      const from = pinned ? cursorT : lastT;
      pinAt(from + (ev.key === "ArrowLeft" ? -big : big));
    } else if (ev.key === "Enter" || ev.key === " ") {
      if (pinned) unpin(); else pinAt(lastT);
    } else if (ev.key === "Escape") {
      unpin();
    } else {
      return;
    }
    ev.preventDefault();
  }

  // ---------- drawing ----------
  function baseOption(ch) {
    const yfmt = (v) => {
      const s = ch.step < 1 ? v.toFixed(1) : String(Math.round(v));
      return ch.signed && v > 0 ? "+" + s : s;
    };
    return {
      animation: false,
      textStyle: { fontFamily: '"Cascadia Mono", Consolas, monospace' },
      grid: { left: 48, right: 14, top: 8, bottom: 22 },
      tooltip: { trigger: "axis", showContent: false, axisPointer: { type: "line", lineStyle: { color: COLORS.cursor, width: 1 } } },
      xAxis: { type: "value", axisLabel: { color: COLORS.axis, fontSize: 10, formatter: (v) => mmss(v), showMinLabel: false },
               axisLine: { lineStyle: { color: "#232A33" } }, axisTick: { show: false },
               splitLine: { show: true, lineStyle: { color: "#1A2028" } } },
      yAxis: { type: "value", axisLabel: { color: COLORS.axis, fontSize: 10, formatter: yfmt },
               axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: COLORS.grid } } },
      series: ch.series.map((s) => ({
        type: "line", data: [], symbol: "none", connectNulls: false, step: ch.stepped ? "end" : false,
        lineStyle: { width: 1.6, color: s.color || COLORS.line }, itemStyle: { color: s.color || COLORS.line },
        emphasis: { disabled: true },
        areaStyle: ch.area ? { origin: ch.id === "vs" ? "auto" : "start",
          color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(159,180,201,.32)" }, { offset: 1, color: "rgba(159,180,201,.03)" }] } } : undefined,
      })),
    };
  }

  function ensureCharts() {
    if (charts) return true;
    if (typeof echarts === "undefined") {
      $("strips").innerHTML = '<p class="nolib">The graph library was not found. Check that dashboard/vendor/echarts.min.js exists.</p>';
      return false;
    }
    charts = CHANNELS.map((ch) => {
      const chart = echarts.init($("plot-" + ch.id), null, { renderer: "canvas" });
      chart.group = "fdr";
      chart.setOption(baseOption(ch));
      chart.on("updateAxisPointer", onPointer);
      chart.on("globalout", onLeave);
      chart.getZr().on("click", (e) => {
        const p = [e.offsetX, e.offsetY];
        if (chart.containPixel("grid", p)) pinAt(chart.convertFromPixel({ gridIndex: 0 }, p)[0]);
      });
      return chart;
    });
    echarts.connect("fdr");
    for (const ch of CHANNELS) $("plot-" + ch.id).addEventListener("keydown", onKey);
    new ResizeObserver(() => { if (visible) charts.forEach((c) => c.resize()); }).observe($("strips"));
    return true;
  }

  function statusFor(ch) {
    const m = state.last;
    if (!m) return { cls: "", tag: "WAIT" };
    return cardStatus(ch.param || null, ch.needsFix && m.fix === 0 ? { cls: "st-stale", tag: "OLD" } : null);
  }

  function pointColor(status) {
    return status.cls === "st-crit" ? COLORS.crit : status.cls === "st-warn" ? COLORS.warn : status.cls === "st-stale" ? COLORS.off : COLORS.ok;
  }

  function firstIndexAtOrAfter(t) {
    let lo = 0, hi = samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function render() {
    if (!charts || !visible) return;
    const first = samples.length ? samples[0].t : 0;
    const now = lastT === null ? 0 : lastT + (state.linkDown ? state.sinceLast : 0);
    const win = WINDOWS[winIdx][1];
    let xmin, xmax;
    if (pinned && frozen) {
      xmin = frozen.min; xmax = frozen.max;
    } else {
      xmin = Math.max(first, now - win);
      xmax = Math.max(xmin + 5, now);
    }
    range = { min: xmin, max: xmax };

    // the samples that are on screen (plus one on each side so the line reaches the edges)
    const i0 = Math.max(0, firstIndexAtOrAfter(xmin) - 1);
    const i1 = Math.min(samples.length, firstIndexAtOrAfter(xmax) + 1);
    let slice = samples.slice(i0, i1);
    if (slice.length > MAX_POINTS) {
      const stride = Math.ceil(slice.length / MAX_POINTS);
      slice = slice.filter((s, i) => s.brk || i % stride === 0 || i === slice.length - 1);
    }

    // gaps: the finished ones that touch the screen, plus the one going on right now
    const shownGaps = gaps.filter((g) => g.t1 >= xmin && g.t0 <= xmax).map((g) => [g.t0, g.t1]);
    if (state.linkDown && lastT !== null) shownGaps.push([lastT, now]);

    CHANNELS.forEach((ch, ci) => {
      const status = statusFor(ch);
      const lim = limitsFor(ch);

      // data and min / max over what is on screen
      let dmin = Infinity, dmax = -Infinity;
      const datasets = ch.series.map((ser) => slice.map((s) => {
        const v = s.brk ? null : s[ser.key];
        if (v !== null && v !== undefined) { dmin = Math.min(dmin, v); dmax = Math.max(dmax, v); }
        return [s.t, v === undefined ? null : v];
      }));

      // axis range: the normal one, made bigger in whole steps if a value goes outside it
      const slack = (ch.y1 - ch.y0) * 0.02;   // ignore noise just outside the range (e.g. altitude -0.1 m)
      let ymin = ch.y0, ymax = ch.y1;
      if (dmax > ymax + slack) ymax += Math.ceil((dmax - ymax) / ch.step) * ch.step;
      if (dmin < ymin - slack) ymin -= Math.ceil((ymin - dmin) / ch.step) * ch.step;
      // after a big excursion keep the axis readable: no more than about 6 numbers
      const interval = ch.step * Math.max(1, Math.ceil((ymax - ymin) / ch.step / 6));

      const lineData = lim.lines.map((l) => ({
        yAxis: l.v,
        lineStyle: { color: l.lvl === "c" ? COLORS.crit : COLORS.warn, type: "dashed", width: 1, opacity: 0.8 },
        label: { show: !!l.text, formatter: l.text, position: "insideStartTop", color: l.lvl === "c" ? COLORS.crit : COLORS.warn, fontSize: 9 },
      }));
      for (const e of events) {
        if (e.ch !== ch.id || e.t < xmin || e.t > xmax) continue;
        const crit = e.sev === "CRITICAL";
        const nearRight = (e.t - xmin) / (xmax - xmin) > 0.6;   // then the text goes to the left of the line
        lineData.push({
          xAxis: e.t,
          lineStyle: { color: crit ? "#FF4D4D" : COLORS.warn, type: "dashed", width: 1 },
          label: { show: true, formatter: e.text.toUpperCase().startsWith(crit ? "CRITICAL" : "WARNING") ? e.text : (crit ? "CRIT" : "WARN") + " · " + e.text, position: "insideEndTop", rotate: 0,
                   align: nearRight ? "right" : "left", verticalAlign: "top", offset: [nearRight ? -4 : 4, 2],
                   color: crit ? "#FF6B6B" : COLORS.warn, fontSize: 9 },
        });
      }
      if (pinned && cursorT !== null) {
        lineData.push({ xAxis: cursorT, lineStyle: { color: COLORS.cursor, type: "solid", width: 1.5 }, label: { show: false } });
      }

      const areaData = lim.zones.map((z) => [
        { yAxis: Math.max(ymin, z.a), itemStyle: { color: z.lvl === "c" ? "rgba(255,77,77,.10)" : "rgba(255,194,51,.07)" } },
        { yAxis: Math.min(ymax, z.b) },
      ]);
      for (const [g0, g1] of shownGaps) {
        areaData.push([
          { xAxis: Math.max(xmin, g0), name: "NO DATA",
            itemStyle: { color: "rgba(10,12,15,.7)", borderColor: COLORS.crit, borderType: "dashed", borderWidth: 1 },
            label: { show: true, color: COLORS.crit, fontSize: 9, position: "insideTop", formatter: "NO DATA" } },
          { xAxis: Math.min(xmax, g1) },
        ]);
      }

      const newest = [...slice].reverse().find((s) => !s.brk);
      const decorations = {
        markLine: { silent: true, symbol: "none", animation: false, data: lineData },
        markArea: { silent: true, animation: false, data: areaData },
      };
      const series = ch.series.map((ser, si) => {
        const out = { data: datasets[si] };
        if (si === 0) Object.assign(out, decorations);
        const v = newest ? newest[ser.key] : null;
        out.markPoint = { silent: true, animation: false, symbol: "circle", symbolSize: 9,
          itemStyle: { color: pointColor(status) },
          data: newest && v !== null && v !== undefined && !state.linkDown ? [{ coord: [newest.t, v] }] : [] };
        return out;
      });

      charts[ci].setOption({
        xAxis: { min: xmin, max: xmax },
        yAxis: { min: ymin, max: ymax, interval },
        series,
      });

      // the strip header
      const sec = $("s-" + ch.id);
      sec.classList.remove("st-warn", "st-crit", "st-stale");
      if (status.cls) sec.classList.add(status.cls);
      $("stag-" + ch.id).textContent = status.tag;
      const span = win === Infinity ? "WHOLE FLIGHT" : "LAST " + WINDOWS[winIdx][0];
      $("smm-" + ch.id).textContent = dmin === Infinity ? "NO DATA YET"
        : "MIN " + fmt(dmin, ch.digits, ch.signed) + " · MAX " + fmt(dmax, ch.digits, ch.signed) + " · " + span;
    });

    updateReadouts();
    paintTools();
  }

  // ---------- showing and hiding ----------
  function show() {
    visible = true;
    if (!ensureCharts()) return;
    charts.forEach((c) => c.resize());
    dirty = true;
    render();
    dirty = false;
  }
  function hide() { visible = false; }

  function init() {
    buildStrips();
    buildTools();
    fetch("/api/thresholds").then((r) => r.json()).then((cfg) => { thresholds = cfg; dirty = true; }).catch(() => {});
    setInterval(() => { if (dirty && visible) { dirty = false; render(); } }, REFRESH_MS);
  }

  init();
  return { add, touch, show, hide };
})();
