/* AP800 Sentinel MVP: simulated machine signals, baseline learning, rule-based fault detection,
   live camera analysis of recorded belt footage, optional phone sensor over the local server. */
(() => {
  const TICK_MS = 500, DT = TICK_MS / 1000;
  const params = new URLSearchParams(location.search);
  const LEARN_TICKS = params.has('fast') ? 10 : 40;
  const HIST = 160, Z = 5;
  const $ = (s) => document.querySelector(s);

  // ---- Signals -------------------------------------------------------------
  const SIG = {
    cur_feed:  { label: 'Feeder current',              short: 'Current',   unit: 'A',    base: 1.1,  noise: 0.03,  dp: 2 },
    cur_r12:   { label: 'Rollers 1–2 current',         short: 'Current',   unit: 'A',    base: 2.4,  noise: 0.05,  dp: 2 },
    cur_r3:    { label: '3-roller groups current',     short: 'Current',   unit: 'A',    base: 2.8,  noise: 0.05,  dp: 2 },
    cur_cal:   { label: 'Calibrating rollers current', short: 'Current',   unit: 'A',    base: 2.0,  noise: 0.04,  dp: 2 },
    cur_drum:  { label: 'Drum drive current',          short: 'Current',   unit: 'A',    base: 3.1,  noise: 0.06,  dp: 2 },
    cur_pump:  { label: 'Pump current',                short: 'Current',   unit: 'A',    base: 3.4,  noise: 0.06,  dp: 2 },
    cur_belt:  { label: 'Belt motor current',          short: 'Current',   unit: 'A',    base: 0.6,  noise: 0.015, dp: 2 },
    press:     { label: 'Filling pressure',            short: 'Pressure',  unit: 'MPa',  base: 0.25, noise: 0.004, dp: 3 },
    thick:     { label: 'Sheet thickness',             short: 'Thickness', unit: 'mm',   base: 0.8,  noise: 0.008, dp: 2 },
    vib_roll:  { label: 'Rolling gearbox vibration',   short: 'Vibration', unit: 'mm/s', base: 1.8,  noise: 0.08,  dp: 2 },
    vib_drum:  { label: 'Drum vibration',              short: 'Vibration', unit: 'mm/s', base: 2.2,  noise: 0.1,   dp: 2 },
    temp_gear: { label: 'Rolling gearbox temperature', short: 'Gearbox',   unit: '°C',   base: 48,   noise: 0.25,  dp: 1 },
    defect:    { label: 'Defect rate',                 short: 'Defects',   unit: '%',    base: 1.2,  noise: 0.35,  dp: 1, floor: 0.5 },
    rate:      { label: 'Output',                      short: 'Output',    unit: 'kg/h', base: 495,  noise: 4,     dp: 0 },
    motion:    { label: 'Belt movement',               short: 'Movement',  unit: '%',    base: 6,    noise: 0.4,   dp: 1 },
  };
  const KEYS = Object.keys(SIG);
  const CHARTS = ['cur_feed', 'cur_r12', 'cur_r3', 'cur_cal', 'cur_drum', 'cur_pump', 'cur_belt', 'press', 'thick', 'vib_roll', 'temp_gear', 'defect'];

  const STATIONS = [
    { id: 'hopper', name: 'Dough hopper',        x: 20,  y: 70,  sig: ['cur_feed'] },
    { id: 'r12',    name: 'Rollers, stages 1–2', x: 200, y: 70,  sig: ['cur_r12', 'vib_roll', 'temp_gear'] },
    { id: 'r3',     name: 'Two 3-roller groups', x: 380, y: 70,  sig: ['cur_r3'] },
    { id: 'cal',    name: 'Calibrating rollers', x: 560, y: 70,  sig: ['cur_cal', 'thick'] },
    { id: 'drum',   name: 'Forming drums',       x: 740, y: 70,  sig: ['cur_drum', 'vib_drum'] },
    { id: 'belt',   name: 'Exit belt',           x: 920, y: 70,  sig: ['cur_belt', 'defect'] },
    { id: 'pump',   name: 'Filling pump',        x: 740, y: 270, sig: ['press', 'cur_pump'], side: true },
  ];

  // ---- Faults that can be played into the simulator ------------------------
  // Each returns multipliers / offsets for the signals, as a function of r(tau) = 1 - exp(-age/tau).
  const FAULTS = {
    tear:    { name: 'Dough sheet tears',     fx: (r) => ({ mul: { cur_cal: 1 - 0.55 * r(2), cur_drum: 1 - 0.5 * r(3), rate: 1 - r(4) } }) },
    hopper:  { name: 'Hopper runs empty',     fx: (r) => ({ mul: { cur_feed: 1 - 0.6 * r(3), cur_r12: 1 - 0.55 * r(5), thick: 1 - 0.3 * r(6), cur_r3: 1 - 0.4 * r(8), cur_cal: 1 - 0.4 * r(10), cur_drum: 1 - 0.35 * r(12), rate: 1 - r(12) } }) },
    wrap:    { name: 'Dough wraps a roller',  fx: (r) => ({ mul: { cur_r3: 1 + 0.7 * r(3), vib_roll: 1 + 0.5 * r(3), cur_cal: 1 - 0.5 * r(4), cur_drum: 1 - 0.45 * r(5), rate: 1 - r(5) } }) },
    starve:  { name: 'Filling runs out',      fx: (r) => ({ mul: { press: 1 - 0.7 * r(3), cur_pump: 1 - 0.4 * r(3), rate: 1 - 0.3 * r(5) }, add: { defect: 55 * r(5) } }) },
    block:   { name: 'Filling nozzle blocks', fx: (r) => ({ mul: { press: 1 + 0.7 * r(2), cur_pump: 1 + 0.35 * r(2) }, add: { defect: 40 * r(4) } }) },
    cell:    { name: 'Drum cell clogs',       fx: (r) => ({ mul: { vib_drum: 1 + 0.12 * r(2) }, add: { defect: 9 * r(2) } }) },
    bearing: { name: 'Gearbox bearing wears', fx: (r) => ({ mul: { vib_roll: 1 + 2.2 * r(25) }, add: { temp_gear: 22 * r(40) } }) },
    jam:     { name: 'Exit belt jams',        fx: (r) => ({ mul: { cur_belt: 1 + 1.8 * r(1.5), motion: 1 - r(0.6), rate: 1 - r(3) } }) },
  };

  // ---- Detection rules -----------------------------------------------------
  const RULES = [
    { id: 'hopper', comp: ['hopper', 'r12'], sev: 'crit', hold: 4, sig: ['cur_feed', 'cur_r12'],
      title: 'Dough is not reaching the first rollers',
      cause: 'The hopper is empty or the dough has bridged above the feeder.',
      check: ['Look into the dough hopper and refill it', 'Break up any dough stuck above the feeder'],
      when: (d) => d.lo('cur_feed') && d.lo('cur_r12') },
    { id: 'tear', comp: ['cal', 'r3'], sev: 'crit', hold: 4, sig: ['cur_cal', 'cur_drum'],
      title: 'Dough sheet torn before the calibrating rollers',
      cause: 'The first rollers are loaded but the calibrating rollers and drums are running empty.',
      check: ['Stop the feed and re-thread the sheet', 'Check dough moisture and the sag setting'],
      when: (d) => d.lo('cur_cal') && d.lo('cur_drum') && !d.lo('cur_r12') && !d.hi('cur_r3') },
    { id: 'wrap', comp: ['r3'], sev: 'crit', hold: 4, sig: ['cur_r3', 'cur_cal'],
      title: 'Dough wrapped around a roller',
      cause: 'Load on the 3-roller groups is climbing while nothing arrives downstream.',
      check: ['Stop the machine', 'Clear the wrapped dough and clean the scraper', 'Check the air blow nozzles'],
      when: (d) => d.hi('cur_r3') && d.lo('cur_cal') },
    { id: 'starve', comp: ['pump', 'drum'], sev: 'crit', hold: 4, sig: ['press', 'cur_pump', 'defect'],
      title: 'Filling is not reaching the drums',
      cause: 'Pump outlet pressure has fallen. The pump hopper is empty or has an air pocket.',
      check: ['Refill the 140 L pump hopper', 'Check the pump agitator is turning', 'Hold the products made in the last minute for inspection'],
      when: (d) => d.lo('press') },
    { id: 'block', comp: ['pump', 'drum'], sev: 'crit', hold: 4, sig: ['press', 'cur_pump', 'defect'],
      title: 'Filling line blocked',
      cause: 'Pump outlet pressure is well above working level. The slot nozzle or hose is blocked.',
      check: ['Stop the pump', 'Strip and clean the slot nozzle', 'Check the filling for bone or frozen lumps'],
      when: (d) => d.hi('press') },
    { id: 'cell', comp: ['drum'], sev: 'warn', hold: 6, sig: ['defect', 'press'],
      title: 'More defective products than normal',
      cause: 'Filling pressure and drive loads are normal, so the likely cause is a clogged drum cell or a stuck pusher.',
      check: ['Watch the belt for the same lane failing each drum turn', 'Clean the drum cells at the next stop', 'Check the pusher cam'],
      when: (d) => d.hi('defect') && !d.lo('press') && !d.hi('press') },
    { id: 'vib', comp: ['r12'], sev: 'warn', hold: 6, sig: ['vib_roll', 'temp_gear'],
      title: 'Rolling gearbox vibration is rising',
      cause: 'Vibration has left its normal band while the load is unchanged. This is the usual sign of bearing wear or low oil.',
      check: ['Check the gearbox oil level', 'Listen for bearing noise', 'Plan a bearing inspection'],
      when: (d) => d.hi('vib_roll') && !d.hi('cur_r3') },
    { id: 'heat', comp: ['r12'], sev: 'crit', hold: 6, sig: ['temp_gear', 'vib_roll'],
      title: 'Rolling gearbox is overheating',
      cause: 'Housing temperature is well above normal for this recipe.',
      check: ['Stop the machine before the drive seizes', 'Check oil level and bearings'],
      when: (d) => d.hi('temp_gear') },
    { id: 'jam', comp: ['belt'], sev: 'crit', hold: 3, sig: ['cur_belt', 'motion'],
      title: 'Exit belt jammed',
      cause: 'The belt motor is overloaded and the camera sees no movement on the belt.',
      check: ['Stop the machine', 'Clear product from under the belt and the transfer point'],
      when: (d) => d.hi('cur_belt') || d.val('motion') < 0.2 * d.mean('motion') },
  ];

  // ---- State ---------------------------------------------------------------
  const S = {
    tick: 0, t: 0, fault: null, faultAt: 0, rateFactor: 1,
    vals: {}, ew: {}, z: {}, hist: {}, learn: {}, base: null,
    rules: {}, incidents: [], nextId: 1, dirty: true, muted: false,
    vision: { live: false, count: 0, motion: 0, boxes: [] },
  };
  KEYS.forEach((k) => { S.hist[k] = []; S.learn[k] = []; });
  RULES.forEach((r) => { S.rules[r.id] = { on: 0, off: 0, inc: null, snooze: 0 }; });

  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const fmt = (k, v) => v.toFixed(SIG[k].dp);

  // ---- Simulator -----------------------------------------------------------
  function simulate() {
    const age = S.fault ? S.t - S.faultAt : 0;
    const r = (tau) => 1 - Math.exp(-age / tau);
    const fx = S.fault ? FAULTS[S.fault].fx(r) : {};
    const mul = fx.mul || {}, add = fx.add || {};
    S.rateFactor = mul.rate ?? 1;
    KEYS.forEach((k, i) => {
      const s = SIG[k];
      let v = (s.base * (1 + 0.01 * Math.sin(S.t / 37 + i)) + gauss() * s.noise) * (mul[k] ?? 1) + (add[k] ?? 0);
      if (k === 'motion' && S.vision.live) v = S.vision.motion;   // measured from the footage
      S.vals[k] = Math.max(0, v);
    });
  }

  // ---- Baseline + detection ------------------------------------------------
  function learnOrScore() {
    KEYS.forEach((k) => {
      const v = S.vals[k];
      S.ew[k] = S.ew[k] === undefined ? v : 0.6 * S.ew[k] + 0.4 * v;
      S.hist[k].push(v); if (S.hist[k].length > HIST) S.hist[k].shift();
      if (!S.base) S.learn[k].push(v);
    });
    if (!S.base && S.tick >= LEARN_TICKS) {
      S.base = {};
      KEYS.forEach((k) => {
        const a = S.learn[k], mean = a.reduce((p, c) => p + c, 0) / a.length;
        const sd = Math.sqrt(a.reduce((p, c) => p + (c - mean) ** 2, 0) / a.length);
        S.base[k] = { mean, sd: Math.max(sd, 0.02 * Math.abs(mean), SIG[k].floor || 1e-6) };
      });
      S.dirty = true;
    }
    if (!S.base) return;
    KEYS.forEach((k) => { S.z[k] = (S.ew[k] - S.base[k].mean) / S.base[k].sd; });
    const d = { lo: (k) => S.z[k] < -Z, hi: (k) => S.z[k] > Z, val: (k) => S.ew[k], mean: (k) => S.base[k].mean };
    RULES.forEach((rule) => {
      const rs = S.rules[rule.id];
      if (rule.when(d)) {
        rs.on++; rs.off = 0;
        if (!rs.inc && rs.on >= rule.hold && S.t >= rs.snooze) openIncident(rule, rs);
      } else {
        rs.on = 0;
        if (rs.inc && ++rs.off >= 10) { rs.inc.status = 'cleared'; rs.inc.end = new Date(); rs.inc = null; S.dirty = true; }
      }
    });
  }

  function openIncident(rule, rs) {
    const ev = rule.sig.map((k) => `${SIG[k].label} ${fmt(k, S.ew[k])} ${SIG[k].unit}, normal ${fmt(k, S.base[k].mean)}`);
    rs.inc = { id: S.nextId++, rule, at: new Date(), status: 'open', evidence: ev };
    S.incidents.unshift(rs.inc); S.incidents.length = Math.min(S.incidents.length, 12);
    S.dirty = true;
    if (rule.sev === 'crit') beep();
  }

  const active = () => S.incidents.filter((i) => i.status === 'open' || i.status === 'ack');
  const worst = (list) => list.some((i) => i.rule.sev === 'crit') ? 'crit' : list.length ? 'warn' : 'ok';

  // ---- Alarm sound ---------------------------------------------------------
  let audio = null;
  document.addEventListener('click', () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ } }, { once: true });
  function beep() {
    if (S.muted || !audio) return;
    try {
      [0, 0.25].forEach((off) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + off); o.stop(audio.currentTime + off + 0.15);
      });
    } catch (e) { /* ignore */ }
  }

  // ---- Line view -----------------------------------------------------------
  function buildLine() {
    const W = 150, H = 70;
    let s = `<svg viewBox="0 0 1100 345" role="img" aria-label="The machine as six stations and the filling pump, each coloured by health">
      <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
      <path class="dash" d="M815 70 V28 H95 V68" marker-end="url(#ar)"/>
      <text class="cap" x="455" y="20" text-anchor="middle">dough offcuts return to the hopper</text>
      <path class="wire" d="M878 270 V144" marker-end="url(#ar)"/>
      <text class="cap" x="870" y="250" text-anchor="end">filling</text>`;
    for (let i = 0; i < 5; i++) s += `<path class="wire" d="M${172 + i * 180} 105 H${197 + i * 180}" marker-end="url(#ar)"/>`;
    STATIONS.forEach((st) => {
      s += `<g class="st learn" id="st-${st.id}"><rect x="${st.x}" y="${st.y}" width="${W}" height="${H}" rx="3"/>
        <text class="nm" x="${st.x + W / 2}" y="${st.y + 28}" text-anchor="middle">${st.name}</text>
        <text class="hl" id="hl-${st.id}" x="${st.x + W / 2}" y="${st.y + 50}" text-anchor="middle">Learning</text></g>`;
      st.sig.forEach((k, j) => {
        const x = st.side ? st.x + W + 12 : st.x + 4, y = st.side ? st.y + 26 + j * 20 : st.y + H + 22 + j * 19;
        s += `<text class="lv" id="lv-${k}" x="${x}" y="${y}"></text>`;
      });
    });
    $('#line').innerHTML = s + '</svg>';
  }

  function renderLine() {
    const act = active();
    STATIONS.forEach((st) => {
      const mine = act.filter((i) => i.rule.comp.includes(st.id));
      const h = S.base ? worst(mine) : 'learn';
      $('#st-' + st.id).setAttribute('class', 'st ' + h);
      $('#hl-' + st.id).textContent = { learn: 'Learning', ok: 'OK', warn: 'Warning', crit: 'Fault' }[h];
      st.sig.forEach((k) => {
        const el = $('#lv-' + k);
        el.textContent = `${SIG[k].short} ${fmt(k, S.ew[k])} ${SIG[k].unit}`;
        el.setAttribute('class', 'lv' + (S.base && Math.abs(S.z[k]) > Z ? ' off' : ''));
      });
    });
  }

  // ---- Charts --------------------------------------------------------------
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function buildCharts() {
    $('#charts').innerHTML = CHARTS.map((k) => `<div class="chart" id="ch-${k}"><span class="lab">${SIG[k].label}</span>
      <span class="val"><span id="cv-${k}">0</span> <small>${SIG[k].unit}</small></span><canvas id="cc-${k}"></canvas></div>`).join('');
  }
  function drawSeries(cv, data, base, off, col) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    let lo = Math.min(...data), hi = Math.max(...data);
    if (base) { lo = Math.min(lo, base.mean - (Z + 2) * base.sd); hi = Math.max(hi, base.mean + (Z + 2) * base.sd); }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const y = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6), x = (i) => (i / (HIST - 1)) * w;
    if (base) { c.fillStyle = col.band; const y1 = y(base.mean + Z * base.sd), y2 = y(base.mean - Z * base.sd); c.fillRect(0, y1, w, y2 - y1); }
    c.beginPath(); data.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
    c.lineWidth = 1.6; c.strokeStyle = off ? col.crit : col.fg; c.stroke();
    if (data.length) { c.beginPath(); c.arc(x(data.length - 1), y(data[data.length - 1]), 2.6, 0, 7); c.fillStyle = off ? col.crit : col.fg; c.fill(); }
  }
  function renderCharts() {
    const col = { band: css('--accent-soft'), fg: css('--fg'), crit: css('--crit') };
    CHARTS.forEach((k) => {
      const off = !!S.base && Math.abs(S.z[k]) > Z;
      $('#ch-' + k).className = 'chart' + (off ? ' off' : '');
      $('#cv-' + k).textContent = fmt(k, S.ew[k]);
      drawSeries($('#cc-' + k), S.hist[k], S.base && S.base[k], off, col);
    });
    if (!$('#dev-chart').hidden) drawSeries($('#dev-cv'), DEV.hist, DEV.base, DEV.off, col);
  }

  // ---- Incidents -----------------------------------------------------------
  const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function renderIncidents() {
    if (!S.dirty) return; S.dirty = false;
    $('#inc-empty').hidden = S.incidents.length > 0;
    $('#incidents').innerHTML = S.incidents.map((i) => {
      const live = i.status === 'open' || i.status === 'ack', r = i.rule;
      const sev = !live ? (i.status === 'false' ? 'Marked false alarm' : 'Cleared ' + clock(i.end)) : (r.sev === 'crit' ? 'Critical' : 'Warning') + (i.status === 'ack' ? ', acknowledged' : '');
      return `<li class="${live ? r.sev : 'done'}"><div class="top"><h3>${r.title}</h3><span class="sev">${sev}</span></div>
        <span class="small muted">${clock(i.at)}</span>
        ${live ? `<p class="small">${r.cause}</p><div class="ev">${i.evidence.join('<br>')}</div>
        <ul>${r.check.map((c) => `<li>${c}</li>`).join('')}</ul>
        <div class="row">${i.status === 'open' ? `<button class="btn" data-ack="${i.id}">Acknowledge</button>` : ''}<button class="btn plain" data-false="${i.id}">False alarm</button></div>` : ''}</li>`;
    }).join('');
  }
  $('#incidents').addEventListener('click', (e) => {
    const a = e.target.dataset.ack, f = e.target.dataset.false;
    const inc = S.incidents.find((i) => i.id === Number(a || f)); if (!inc) return;
    if (a) inc.status = 'ack';
    if (f) { inc.status = 'false'; inc.end = new Date(); const rs = S.rules[inc.rule.id]; if (rs) { rs.inc = null; rs.snooze = S.t + 60; } else DEV.inc = null; }
    S.dirty = true; renderIncidents();
  });
  $('#mute').addEventListener('click', (e) => { S.muted = !S.muted; e.target.setAttribute('aria-pressed', S.muted); e.target.textContent = S.muted ? 'Alarm muted' : 'Mute alarm'; });

  // ---- Fault injector ------------------------------------------------------
  function buildFaults() {
    $('#faults').innerHTML = Object.entries(FAULTS).map(([k, f]) => `<button class="btn" data-fault="${k}" aria-pressed="false" disabled>${f.name}</button>`).join('') +
      '<button class="btn plain" data-fault="" disabled>Back to normal</button>';
    $('#faults').addEventListener('click', (e) => { if (e.target.dataset.fault !== undefined) setFault(e.target.dataset.fault || null); });
  }
  function setFault(k) {
    S.fault = k; S.faultAt = S.t;
    document.querySelectorAll('#faults [data-fault]').forEach((b) => b.setAttribute('aria-pressed', !!k && b.dataset.fault === k));
    const v = $('#vid'); if (k === 'jam') v.pause(); else v.play().catch(() => {});
  }

  // ---- Camera analysis (real pixels from the footage) ----------------------
  const VW = 320, VH = 180;
  const off = document.createElement('canvas'); off.width = VW; off.height = VH;
  const octx = off.getContext('2d', { willReadFrequently: true });
  let prevGray = null;
  function analyse() {
    const v = $('#vid'); if (v.readyState < 2) return;
    let px;
    try { octx.drawImage(v, 0, 0, VW, VH); px = octx.getImageData(0, 0, VW, VH).data; } catch (e) { S.vision.live = false; return; }
    const n = VW * VH, blue = new Uint8Array(n), cream = new Uint8Array(n), gray = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = px[p], g = px[p + 1], b = px[p + 2];
      blue[i] = b > r + 45 && b > g + 12 && b > 90 ? 1 : 0;
      cream[i] = r > 165 && g > 155 && b > 105 && r - b > 12 && r - b < 90 ? 1 : 0;
      gray[i] = (r + g + b) / 3;
    }
    // movement: share of pixels that changed since the last look
    if (prevGray) { let ch = 0; for (let i = 0; i < n; i++) if (Math.abs(gray[i] - prevGray[i]) > 18) ch++; S.vision.motion = (100 * ch) / n; }
    prevGray = gray;
    // integral image of belt-blue, so a product only counts if it sits on the belt
    const IW = VW + 1, integ = new Int32Array(IW * (VH + 1));
    for (let y = 0; y < VH; y++) { let row = 0; for (let x = 0; x < VW; x++) { row += blue[y * VW + x]; integ[(y + 1) * IW + x + 1] = integ[y * IW + x + 1] + row; } }
    const R = 12, mask = new Uint8Array(n);
    for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
      const i = y * VW + x; if (!cream[i]) continue;
      const x0 = Math.max(0, x - R), x1 = Math.min(VW, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(VH, y + R + 1);
      const sum = integ[y1 * IW + x1] - integ[y0 * IW + x1] - integ[y1 * IW + x0] + integ[y0 * IW + x0];
      if (sum > 75) mask[i] = 1;
    }
    // connected blobs
    const boxes = [], stack = [];
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      let x0 = VW, x1 = 0, y0 = VH, y1 = 0, size = 0; stack.push(i); mask[i] = 0;
      while (stack.length) {
        const j = stack.pop(), x = j % VW, y = (j / VW) | 0; size++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[j - 1]) { mask[j - 1] = 0; stack.push(j - 1); }
        if (x < VW - 1 && mask[j + 1]) { mask[j + 1] = 0; stack.push(j + 1); }
        if (y > 0 && mask[j - VW]) { mask[j - VW] = 0; stack.push(j - VW); }
        if (y < VH - 1 && mask[j + VW]) { mask[j + VW] = 0; stack.push(j + VW); }
      }
      if (size >= 12 && size <= 400) boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    S.vision.boxes = boxes; S.vision.count = boxes.length; S.vision.live = true;
    renderCamera();
  }
  function renderCamera() {
    const cv = $('#ov'), c = cv.getContext('2d'), k = cv.width / VW;
    c.clearRect(0, 0, cv.width, cv.height);
    const starved = S.rateFactor < 0.35 && S.fault !== 'jam';
    const veil = $('#veil');
    veil.hidden = !(starved || S.fault === 'jam');
    veil.textContent = S.fault === 'jam' ? 'Belt stopped' : 'Simulated: no product reaching the belt';
    const pBad = Math.min(0.9, (S.vals.defect || 0) / 100);
    let bad = 0;
    if (!starved) S.vision.boxes.forEach((b) => {
      const isBad = S.fault && S.fault !== 'jam' && Math.random() < pBad; if (isBad) bad++;
      c.lineWidth = isBad ? 3 : 1.5; c.strokeStyle = isBad ? '#ff5a4d' : '#59e08c';
      c.strokeRect(b.x * k - 2, b.y * k - 2, b.w * k + 4, b.h * k + 4);
    });
    $('#v-count').textContent = starved ? 0 : S.vision.count;
    $('#v-bad').textContent = bad;
    $('#v-move').textContent = S.vision.motion.toFixed(1) + ' %';
  }

  // ---- Phone sensor over the local server ----------------------------------
  const DEV = { hist: [], learn: [], base: null, off: false, hot: 0, inc: null, last: 0 };
  const DEV_RULE = { id: 'device', comp: [], sev: 'warn', title: 'Phone sensor: vibration above normal',
    cause: 'The vibration measured by the phone has left the range it learned.', check: ['Check what the phone is mounted on'] };
  function onDevice(m) {
    const v = Number(m.vib_rms); if (!isFinite(v)) return;
    DEV.last = Date.now();
    $('#dev-chart').hidden = false; $('#dev-relearn').hidden = false; $('#dev-help').hidden = true;
    $('#dev-val').textContent = v.toFixed(2);
    DEV.hist.push(v); if (DEV.hist.length > HIST) DEV.hist.shift();
    if (!DEV.base) {
      DEV.learn.push(v); $('#dev-state').textContent = `Learning, ${DEV.learn.length} of 15`;
      if (DEV.learn.length >= 15) {
        const a = DEV.learn, mean = a.reduce((p, c) => p + c, 0) / a.length;
        const sd = Math.sqrt(a.reduce((p, c) => p + (c - mean) ** 2, 0) / a.length);
        DEV.base = { mean, sd: Math.max(sd, 0.1 * mean, 0.02) };
      }
      return;
    }
    DEV.off = (v - DEV.base.mean) / DEV.base.sd > Z;
    DEV.hot = DEV.off ? DEV.hot + 1 : 0;
    $('#dev-state').textContent = DEV.off ? 'Above normal' : 'Connected, normal';
    if (DEV.hot >= 2 && !DEV.inc) {
      DEV.inc = { id: S.nextId++, rule: DEV_RULE, at: new Date(), status: 'open', evidence: [`Vibration ${v.toFixed(2)} m/s², normal ${DEV.base.mean.toFixed(2)}`] };
      S.incidents.unshift(DEV.inc); S.dirty = true; beep();
    } else if (!DEV.off && DEV.inc && DEV.inc.status !== 'false') { DEV.inc.status = 'cleared'; DEV.inc.end = new Date(); DEV.inc = null; S.dirty = true; }
    else if (!DEV.off) DEV.inc = null;
  }
  $('#dev-relearn').addEventListener('click', () => { DEV.base = null; DEV.learn = []; DEV.hot = 0; });
  try {
    const es = new EventSource('api/stream');
    es.onmessage = (e) => { try { onDevice(JSON.parse(e.data)); } catch (err) { /* bad message */ } };
    es.onerror = () => { if (es.readyState === 2) $('#dev-state').textContent = 'Not connected'; };
  } catch (e) { /* static hosting: no server */ }

  // ---- Header + loop -------------------------------------------------------
  function renderHeader() {
    const pill = $('#status'), act = active();
    if (!S.base) { pill.className = 'pill learn'; pill.textContent = 'Learning normal running'; }
    else { const w = worst(act); pill.className = 'pill ' + w; pill.textContent = { ok: 'Running normally', warn: 'Warning', crit: 'Fault' }[w]; }
    $('#s-rate').textContent = Math.round(S.ew.rate);
    $('#s-def').textContent = S.ew.defect.toFixed(1);
    const sec = Math.floor(S.t); $('#s-time').textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
    const bar = $('#learn-bar');
    if (!S.base) bar.firstElementChild.style.width = Math.min(100, (100 * S.tick) / LEARN_TICKS) + '%';
    else if (!bar.hidden) {
      bar.hidden = true; $('#learn-text').textContent = 'Normal range learned. The device is watching for departures from it.';
      document.querySelectorAll('#faults button').forEach((b) => { b.disabled = false; });
      if (params.get('fault') && FAULTS[params.get('fault')]) setFault(params.get('fault'));
    }
  }

  function step() {
    S.tick++; S.t += DT;
    simulate(); learnOrScore();
    renderHeader(); renderLine(); renderCharts(); renderIncidents();
    if (!S.vision.live) renderCamera();
  }

  buildLine(); buildCharts(); buildFaults();
  step();
  setInterval(step, TICK_MS);
  setInterval(analyse, 200);
})();
