/* AP800 Sentinel dashboard. The server runs the machine simulator, the ML detector and all records;
   this file only draws what the server reports and sends the user's decisions back. */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HIST = 200;
  let ME = null, SIG = {}, BASE = {}, ALERT_Z = 6, FAULTS = {}, SCENARIOS = [], MODEL = null;
  let seq = 0, state = null, muted = false, lastIssueId = null, activeSig = '';
  const ticks = [];   // { v, a }

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
  const RANK = { operator: 1, technician: 2, manager: 3 };
  const can = (role) => ME && RANK[ME.role] >= RANK[role];

  // ---- formatting ----------------------------------------------------------
  const fmt = (k, v) => Number(v).toFixed(SIG[k].dp);
  const money = (x) => Math.round(x || 0).toLocaleString('en') + ' GEL';
  const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const stamp = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const mins = (ms) => (ms === null || ms === undefined ? 'n/a' : Math.round(ms / 1000) + ' min');   // demo clock: 1 s = 1 min
  const sevLabel = { ok: 'Running normally', low: 'Minor issue', medium: 'Warning', high: 'Serious issue', critical: 'Critical fault', stopped: 'Machine stopped' };

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { showLogin(); throw new Error('Sign in first'); }
    const j = r.status === 204 ? {} : await r.json();
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }
  // run an action from a button, show any refusal next to it
  async function act(btn, path, body = {}) {
    btn.disabled = true;
    try { await api(path, body); await poll(); route(true); }
    catch (e) { const box = btn.closest('.panel') && btn.closest('.panel').querySelector('.err'); if (box) box.textContent = e.message; }
    btn.disabled = false;
  }

  // ---- sign-in -------------------------------------------------------------
  async function showLogin() {
    $('#app').hidden = true; $('#login').hidden = false; ME = null;
    const people = await (await fetch('api/people')).json();
    $('#people').innerHTML = people.map((p) => `<button data-id="${p.id}"><span>${esc(p.name)}</span><span class="muted">${p.role}</span></button>`).join('');
  }
  $('#people').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    await api('api/login', { user_id: Number(b.dataset.id) }); start();
  });
  $('#logout').addEventListener('click', async () => { await api('api/logout', {}); showLogin(); });

  // ---- alarm ---------------------------------------------------------------
  let audio = null;
  document.addEventListener('click', () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ } }, { once: true });
  function beep() {
    if (muted || !audio) return;
    try { [0, 0.25].forEach((o) => { const osc = audio.createOscillator(), g = audio.createGain(); osc.frequency.value = 880; g.gain.value = 0.08; osc.connect(g); g.connect(audio.destination); osc.start(audio.currentTime + o); osc.stop(audio.currentTime + o + 0.15); }); } catch (e) { /* ignore */ }
  }
  $('#mute').addEventListener('click', (e) => { muted = !muted; e.target.setAttribute('aria-pressed', muted); e.target.textContent = muted ? 'Alarm muted' : 'Mute alarm'; });

  // ---- line view -----------------------------------------------------------
  function buildLine() {
    const W = 150, H = 70;
    let s = `<svg viewBox="0 0 1100 345" role="img" aria-label="The machine as six stations and the filling pump, each coloured by health">
      <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
      <path class="dash" d="M815 70 V28 H95 V68" marker-end="url(#ar)"/><text class="cap" x="455" y="20" text-anchor="middle">dough offcuts return to the hopper</text>
      <path class="wire" d="M878 270 V144" marker-end="url(#ar)"/><text class="cap" x="870" y="250" text-anchor="end">filling</text>`;
    for (let i = 0; i < 5; i++) s += `<path class="wire" d="M${172 + i * 180} 105 H${197 + i * 180}" marker-end="url(#ar)"/>`;
    STATIONS.forEach((st) => {
      s += `<g class="st" id="st-${st.id}"><rect x="${st.x}" y="${st.y}" width="${W}" height="${H}" rx="3"/>
        <text class="nm" x="${st.x + W / 2}" y="${st.y + 28}" text-anchor="middle">${st.name}</text>
        <text class="hl" id="hl-${st.id}" x="${st.x + W / 2}" y="${st.y + 50}" text-anchor="middle">OK</text></g>`;
      st.sig.forEach((k, j) => { const x = st.side ? st.x + W + 12 : st.x + 4, y = st.side ? st.y + 26 + j * 20 : st.y + H + 22 + j * 19; s += `<text class="lv" id="lv-${k}" x="${x}" y="${y}"></text>`; });
    });
    $('#line').innerHTML = s + '</svg>';
  }
  function renderLine(v) {
    const a = state.active, stopped = state.machine.stopped;
    STATIONS.forEach((st) => {
      const hit = a && a.comp.includes(st.id);
      const cls = stopped ? 'off' : hit ? (['critical', 'high'].includes(a.severity) ? 'crit' : 'warn') : 'ok';
      $('#st-' + st.id).setAttribute('class', 'st ' + cls);
      $('#hl-' + st.id).textContent = { off: 'Stopped', ok: 'OK', warn: 'Warning', crit: 'Fault' }[cls];
      st.sig.forEach((k) => { const el = $('#lv-' + k); el.textContent = `${SIG[k].short} ${fmt(k, v[k])} ${SIG[k].unit}`; el.setAttribute('class', 'lv' + (Math.abs(state.z[k] || 0) > ALERT_Z ? ' bad' : '')); });
    });
  }

  // ---- charts --------------------------------------------------------------
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const colours = () => ({ band: css('--accent-soft'), fg: css('--fg'), crit: css('--crit') });
  function drawSeries(cv, data, flags, base, col, span) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h || !data.length) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    let lo = Math.min(...data), hi = Math.max(...data);
    if (base) { lo = Math.min(lo, base.mean - (ALERT_Z + 2) * base.sd); hi = Math.max(hi, base.mean + (ALERT_Z + 2) * base.sd); }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const n = Math.max(span || data.length, 2), y = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6), x = (i) => (i / (n - 1)) * w;
    if (base) { c.fillStyle = col.band; const y1 = y(base.mean + ALERT_Z * base.sd), y2 = y(base.mean - ALERT_Z * base.sd); c.fillRect(0, y1, w, y2 - y1); }
    c.lineWidth = 1.6;
    for (let i = 1; i < data.length; i++) { c.beginPath(); c.moveTo(x(i - 1), y(data[i - 1])); c.lineTo(x(i), y(data[i])); c.strokeStyle = flags && flags[i] ? col.crit : col.fg; c.stroke(); }
    const last = data.length - 1; c.beginPath(); c.arc(x(last), y(data[last]), 2.6, 0, 7); c.fillStyle = flags && flags[last] ? col.crit : col.fg; c.fill();
  }
  function buildCharts() {
    $('#charts').innerHTML = CHARTS.map((k) => `<div class="chart" id="ch-${k}"><span class="lab">${SIG[k].label}</span><span class="val"><span id="cv-${k}">0</span> <small>${SIG[k].unit}</small></span><canvas id="cc-${k}"></canvas></div>`).join('');
  }
  function renderCharts(v) {
    const col = colours(), flags = ticks.map((t) => t.a);
    CHARTS.forEach((k) => {
      const bad = Math.abs(state.z[k] || 0) > ALERT_Z;
      $('#ch-' + k).className = 'chart' + (bad ? ' bad' : '');
      $('#cv-' + k).textContent = fmt(k, v[k]);
      drawSeries($('#cc-' + k), ticks.map((t) => t.v[k]), bad ? flags : null, BASE[k], col, HIST);
    });
    const ph = state.phone;
    $('#dev-state').textContent = ph.live ? 'Connected' : ph.hist.length ? 'No recent readings' : 'Not connected';
    $('#dev-chart').hidden = !ph.hist.length; $('#dev-help').hidden = ph.live;
    if (ph.hist.length) { $('#dev-val').textContent = ph.hist[ph.hist.length - 1].toFixed(2); drawSeries($('#dev-cv'), ph.hist, null, null, col, 120); }
  }

  // ---- active issue --------------------------------------------------------
  function actionRow(a) {
    const st = { done: 'Done', pending_approval: 'Waiting for manager approval', suggested: 'Suggested', rejected: 'Rejected', reverted: 'Undone', cancelled: 'Cancelled' }[a.status] || a.status;
    let b = '';
    const role = a.risk === 'physical' ? 'manager' : 'technician';
    if (['pending_approval', 'suggested'].includes(a.status) && can(role)) b = `<button class="btn go" data-act="approve" data-id="${a.id}">${a.status === 'suggested' ? 'Run' : 'Approve'}</button><button class="btn plain" data-act="reject" data-id="${a.id}">Reject</button>`;
    else if (a.status === 'done' && a.reversible && can(role)) b = `<button class="btn plain" data-act="revert" data-id="${a.id}">Undo</button>`;
    return `<div class="act"><span style="flex:1 1 200px"><b>${esc(a.label)}</b><br><span class="muted">${st}${a.risk === 'physical' ? ', changes what the machine does' : ''}</span>${a.warn && a.status === 'pending_approval' ? '<br><span class="warnline">Low confidence. Check the machine before approving.</span>' : ''}</span><span class="row">${b}</span></div>`;
  }
  function renderActive() {
    const a = state.active, box = $('#active');
    $('#auto-state').textContent = state.automation ? 'Automation on' : 'Automation off';
    if (!a) {
      if (activeSig !== 'none') { activeSig = 'none'; box.innerHTML = `<p class="empty">${state.machine.stopped ? 'The machine is stopped. Undo the stop on the last issue to restart it.' : 'No active issue. When the model detects a problem it appears here with the reason, the people alerted and the actions taken.'}</p>`; }
      return;
    }
    const sig = JSON.stringify([a.id, a.title, a.low, a.note, a.sensorNote, a.severity, a.acked, a.level, state.actions.map((x) => x.status + x.warn), ME.role, state.machine.stopped]);
    if (sig !== activeSig) {
      activeSig = sig;
      box.innerHTML = `<div class="issue ${a.severity}">
        <div class="head"><h3>${esc(a.title)}</h3><span class="sev ${a.severity}">${a.severity}</span></div>
        <span class="small muted">${esc(a.label)}, model confidence ${Math.round(a.confidence * 100)} %, detected ${clock(a.detectedAt)}</span>
        ${a.original ? `<p class="small"><b>If the sensor is correct:</b> ${esc(a.original.title)} (${Math.round(a.original.confidence * 100)} % model confidence). No machine action is recommended until the sensor has been checked.</p>` : ''}
        ${a.candidate ? `<p class="small"><b>Most likely, low confidence:</b> ${esc(a.candidate.title)} (${Math.round(a.candidate.confidence * 100)} %). No machine action is recommended; inspect the machine first.</p>` : ''}
        ${a.note ? `<p class="warnline">${esc(a.note)}</p>` : ''}
        ${a.sensorNote ? `<p class="small"><b>Sensor note:</b> ${esc(a.sensorNote)}</p>` : ''}
        <p class="small">${esc(a.cause)}</p>
        <div><span class="small muted">Why the model flagged it</span><ul class="list" id="a-why"></ul></div>
        <div><span class="small muted">What to check</span><ul class="list">${a.check.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
        <dl class="kv"><div><dt>Loss so far</dt><dd id="a-loss"></dd></div><div><dt>Time to failure</dt><dd id="a-rul"></dd></div><div><dt>Alerted</dt><dd>Level ${a.level} of 3</dd></div></dl>
        <span class="small ${a.acked ? '' : 'muted'}">${a.acked ? 'Acknowledged. Escalation stopped.' : `Not acknowledged yet. Escalates to the next person every ${state.escalateAfterS} s.`}</span>
        <div class="acts">${state.actions.map(actionRow).join('')}</div>
        <div class="row">${a.acked ? '' : `<button class="btn go" data-issue="ack" data-id="${a.id}">Acknowledge</button>`}
          ${can('technician') ? `<input id="a-note" placeholder="What was fixed" aria-label="What was fixed" style="flex:1 1 140px"><button class="btn" data-issue="resolve" data-id="${a.id}">Mark resolved</button>` : ''}
          <a class="btn plain" href="#issue-${a.id}">Full record</a></div>
        <p class="err"></p></div>`;
    }
    $('#a-why').innerHTML = (a.contributions.length ? a.contributions : ['Readings are returning to normal']).map((t) => `<li>${esc(t)}</li>`).join('');
    $('#a-loss').textContent = money(a.loss);
    $('#a-rul').textContent = a.rul === null ? 'n/a' : a.rul + ' min';
  }
  $('#active').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act) act(b, `api/actions/${b.dataset.id}/${b.dataset.act}`);
    if (b.dataset.issue) act(b, `api/issues/${b.dataset.id}/${b.dataset.issue}`, { note: ($('#a-note') || {}).value || '' });
  });
  function renderInbox() {
    $('#inbox-panel').hidden = !state.inbox.length && !state.flagAlerts.length;
    $('#inbox').innerHTML = state.flagAlerts.map((n) => `<div class="act"><span style="flex:1 1 200px"><b>Unusual activity: ${esc(n.title)}</b><br><span class="muted">${esc(n.explanation)}<br>Sent to you ${clock(n.sent_at)}</span></span><span class="row"><a class="btn plain" href="#risk">Open Risk</a><button class="btn go" data-alert="${n.id}">Mark as read</button></span></div>`).join('') + state.inbox.map((n) => `<div class="act"><span><b>${esc(n.title)}</b><br><span class="muted">Sent to you ${clock(n.sent_at)}, escalation level ${n.level}</span></span><button class="btn go" data-id="${n.issue_id}">Acknowledge</button></div>`).join('');
  }
  $('#inbox').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.alert) act(b, `api/flag-alerts/${b.dataset.alert}/read`); else act(b, `api/issues/${b.dataset.id}/ack`); });

  // ---- fault injector ------------------------------------------------------
  function buildFaults() {
    $('#faults').innerHTML = Object.entries(FAULTS).map(([k, n]) => `<button class="btn" data-fault="${k}" aria-pressed="false">${esc(n)}</button>`).join('') + '<button class="btn plain" data-fault="">Back to normal</button>';
  }
  $('#faults').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) act(b, 'api/demo/fault', { fault: b.dataset.fault || null }); });

  // ---- camera analysis (real pixels from the footage) ----------------------
  const VW = 320, VH = 180, off = document.createElement('canvas'); off.width = VW; off.height = VH;
  const octx = off.getContext('2d', { willReadFrequently: true });
  let boxes = [];
  function analyse() {
    const v = $('#vid'); if (!state || $('#v-live').hidden || v.readyState < 2) return;
    let px; try { octx.drawImage(v, 0, 0, VW, VH); px = octx.getImageData(0, 0, VW, VH).data; } catch (e) { return; }
    const n = VW * VH, blue = new Uint8Array(n), cream = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) { const r = px[p], g = px[p + 1], b = px[p + 2]; blue[i] = b > r + 45 && b > g + 12 && b > 90 ? 1 : 0; cream[i] = r > 165 && g > 155 && b > 105 && r - b > 12 && r - b < 90 ? 1 : 0; }
    const IW = VW + 1, integ = new Int32Array(IW * (VH + 1));
    for (let y = 0; y < VH; y++) { let row = 0; for (let x = 0; x < VW; x++) { row += blue[y * VW + x]; integ[(y + 1) * IW + x + 1] = integ[y * IW + x + 1] + row; } }
    const R = 12, mask = new Uint8Array(n);
    for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
      const i = y * VW + x; if (!cream[i]) continue;
      const x0 = Math.max(0, x - R), x1 = Math.min(VW, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(VH, y + R + 1);
      if (integ[y1 * IW + x1] - integ[y0 * IW + x1] - integ[y1 * IW + x0] + integ[y0 * IW + x0] > 75) mask[i] = 1;
    }
    boxes = []; const stack = [];
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
    const cv = $('#ov'), c = cv.getContext('2d'), k = cv.width / VW, v2 = ticks.length ? ticks[ticks.length - 1].v : null;
    c.clearRect(0, 0, cv.width, cv.height);
    const frozen = state.machine.stopped || state.machine.fault === 'jam', starved = !frozen && v2 && v2.rate < 170;
    if (frozen && !v.paused) v.pause(); if (!frozen && v.paused) v.play().catch(() => {});
    $('#veil').hidden = !(frozen || starved); $('#veil').textContent = frozen ? 'Belt stopped' : 'Simulated: no product reaching the belt';
    const pBad = state.active && v2 ? Math.min(0.9, v2.defect / 100) : 0; let bad = 0;
    if (!starved) boxes.forEach((b) => { const isBad = Math.random() < pBad; if (isBad) bad++; c.lineWidth = isBad ? 3 : 1.5; c.strokeStyle = isBad ? '#ff5a4d' : '#59e08c'; c.strokeRect(b.x * k - 2, b.y * k - 2, b.w * k + 4, b.h * k + 4); });
    $('#v-count').textContent = starved ? 0 : boxes.length; $('#v-bad').textContent = bad;
  }

  // ---- live loop -----------------------------------------------------------
  async function poll() {
    if (!ME) return;
    let s; try { s = await api('api/state?since=' + seq); } catch (e) { return; }
    state = s; seq = s.seq;
    s.ticks.forEach((t) => ticks.push({ v: t.v, a: t.a })); while (ticks.length > HIST) ticks.shift();
    if (!ticks.length) return;
    const v = ticks[ticks.length - 1].v, m = s.machine;
    const pill = $('#status'); pill.className = 'pill ' + m.status; pill.textContent = sevLabel[m.status];
    $('#s-health').textContent = m.health; $('#s-rate').textContent = Math.round(v.rate); $('#s-def').textContent = v.defect.toFixed(1);
    if (s.active && s.active.id !== lastIssueId) { lastIssueId = s.active.id; beep(); }
    if (!$('#v-live').hidden) {
      renderLine(v); renderCharts(v); renderActive(); renderInbox();
      document.querySelectorAll('#faults [data-fault]').forEach((b) => b.setAttribute('aria-pressed', !!m.fault && b.dataset.fault === m.fault));
    }
  }

  // ---- other views ---------------------------------------------------------
  const table = (heads, rows) => `<div class="scroll"><table><thead><tr>${heads.map((h) => `<th${h.startsWith('#') ? ' class="num"' : ''}>${h.replace(/^#/, '')}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${heads.length}" class="muted">Nothing recorded yet.</td></tr>`}</tbody></table></div>`;
  const statusText = { detected: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved', verified: 'Verified' };

  async function viewIssues() {
    const list = await api('api/issues');
    $('#v-issues').innerHTML = `<section class="panel"><div class="head"><h2>Issues</h2><a class="btn plain" href="api/issues.csv">Export CSV</a></div>
      ${table(['No.', 'Detected', 'Issue', 'Severity', 'Status', '#Confidence', '#Downtime', '#Loss', '#Saved'], list.map((i) => `<tr class="click" data-href="#issue-${i.id}"><td>${i.id}</td><td>${stamp(i.detected_at)}</td><td>${esc(i.title)}</td>
        <td><span class="sev ${i.severity}">${i.severity}</span></td><td>${statusText[i.status]}${i.resolved_by === 'system' ? ', cleared by itself' : ''}</td><td class="num">${Math.round(i.confidence * 100)} %</td>
        <td class="num">${(i.downtime_h * 60).toFixed(0)} min</td><td class="num">${money(i.actual_loss)}</td><td class="num">${money(i.savings)}</td></tr>`))}</section>`;
  }
  document.addEventListener('click', (e) => { const r = e.target.closest('tr.click'); if (r && r.dataset.href) location.hash = r.dataset.href; });

  async function viewIssue(id) {
    const i = await api('api/issues/' + id), el = $('#v-issue'), ex = i.explanation;
    let prev = i.detected_at;
    const steps = i.steps.map((s) => { const d = s.at ? s.at - prev : null; if (s.at) prev = s.at; return `<li class="${s.at ? 'done' : ''}"><b>${s.name}</b><span>${s.at ? clock(s.at) : 'not yet'}</span><span class="muted">${s.at && s.name !== 'Detected' ? 'after ' + mins(d) : ''}</span></li>`; }).join('');
    const keys = [...new Set([...(ex.contributions || []).map((c) => c.key), 'rate', 'defect'])].slice(0, 6);
    el.innerHTML = `<section class="panel"><div class="head"><h2>Issue ${i.id}: ${esc(i.title)}</h2><span class="row"><span class="sev ${i.severity}">${i.severity}</span><span class="sev none">${i.is_simulated ? 'SIMULATED RUN' : statusText[i.status]}</span></span></div>
        <span class="small muted">${esc(i.label)} (${esc(i.category)}), model version ${i.model_version_id}, detected ${stamp(i.detected_at)}</span>
        <ol class="steps">${steps}</ol>
        <dl class="kv"><div><dt>Model confidence</dt><dd>${Math.round(i.confidence * 100)} %</dd></div><div><dt>Chance of failure if ignored</dt><dd>${Math.round(i.fail_prob * 100)} %</dd></div>
          <div><dt>Time to failure at detection</dt><dd>${i.rul_min === null ? 'n/a' : Math.round(i.rul_min) + ' min'}</dd></div>
          <div><dt>Downtime</dt><dd>${(i.downtime_h * 60).toFixed(0)} min</dd></div><div><dt>Actual loss</dt><dd>${money(i.actual_loss)}</dd></div>
          <div><dt>Projected loss if not fixed</dt><dd>${money(i.projected_loss)}</dd></div><div><dt>Saved by early detection</dt><dd>${money(i.savings)}</dd></div></dl>
        ${i.status === 'resolved' && can('manager') ? `<div class="row"><button class="btn go" id="verify">Verify the repair</button></div>` : ''}<p class="err"></p></section>
      <div class="half"><section class="panel"><h2>What was detected and why</h2><p>${esc(ex.summary)}</p>
          <ul class="list">${(ex.contributions || []).map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>
          ${ex.original ? `<p><b>If the sensor is correct:</b> ${esc(ex.original.title)} (${esc(ex.original.label)}, ${Math.round(ex.original.confidence * 100)} % model confidence). The ${esc(ex.sensor.label.toLowerCase())} sensor ${esc(ex.sensor.why)}, so no machine action was recommended.</p>` : ''}
          ${ex.candidate ? `<p><b>Most likely, low confidence:</b> ${esc(ex.candidate.title)} (${esc(ex.candidate.label)}, ${Math.round(ex.candidate.confidence * 100)} %). No machine action was recommended.</p>` : ''}
          ${ex.sensor_note ? `<p><b>Sensor note:</b> ${esc(ex.sensor_note)}</p>` : ''}
          ${ex.confidence_note ? `<p class="warnline">${esc(ex.confidence_note)}</p>` : ''}${ex.confirmed ? `<p class="small">${esc(ex.confirmed)}</p>` : ''}
          <p class="small muted">Anomaly score ${ex.score} against a threshold of ${ex.threshold}. Largest deviation ${ex.max_deviation} standard deviations. Pattern match with "${esc(i.label)}": ${Math.round((ex.type_similarity || 0) * 100)} %.</p>
          <p><b>Recommended:</b> ${esc(i.recommended)}</p>${i.resolution ? `<p><b>Resolution:</b> ${esc(i.resolution)} (${esc(i.resolved_by)})</p>` : ''}</section>
        <section class="panel"><h2>Actions</h2>${table(['Action', 'Risk', 'Status', 'Decided by'], i.actions.map((a) => `<tr><td>${esc(a.label)}<br><span class="muted small">${esc(a.reason)}</span></td><td>${a.risk}</td><td>${a.status.replace('_', ' ')}</td><td>${esc(a.decided_name || (a.status === 'done' ? 'automatic' : ''))}</td></tr>`))}
          <h2>People alerted</h2>${table(['Person', 'Channel', 'Level', 'Sent', 'Status'], i.notifications.map((n) => `<tr><td>${esc(n.name)}</td><td>${n.channel.replace('_', '-')}</td><td>${n.level}</td><td>${clock(n.sent_at)}</td><td>${n.status.replace('_', ' ')}</td></tr>`))}</section></div>
      <section class="panel"><div class="head"><h2>Readings before, during and after</h2><span class="small muted">Red = flagged by the model</span></div><div class="charts big">${keys.map((k) => `<div class="chart"><span class="lab">${SIG[k].label} (${SIG[k].unit})</span><canvas id="ic-${k}"></canvas></div>`).join('')}</div></section>
      <section class="panel"><div class="head"><h2>Replay this incident</h2><span class="small muted">Real record, minute by minute on the demo clock</span></div><div id="iss-replay"></div></section>
      <section class="panel"><h2>Timeline</h2>${table(['Time', 'Who or what', 'What happened'], i.events.map((e) => `<tr><td>${clock(e.ts)}</td><td>${esc(e.actor)} <span class="muted">(${e.actor_type})</span></td><td>${esc(e.summary)}</td></tr>`))}</section>`;
    const col = colours(), flags = i.readings.map((r) => r.a);
    keys.forEach((k) => drawSeries($('#ic-' + k), i.readings.map((r) => r.v[k]), flags, BASE[k], col));
    mountReplay($('#iss-replay'), { points: i.readings.map((r) => ({ m: (r.ts - i.detected_at) / 1000, v: r.v, a: r.a })), events: i.events.map((e) => ({ m: (e.ts - i.detected_at) / 1000, summary: e.summary })) }, false);
    const vb = $('#verify'); if (vb) vb.onclick = () => act(vb, `api/issues/${i.id}/verify`);
  }

  let histQuery = '';
  async function viewHistory() {
    const d = await api('api/history?' + histQuery), p = d.profile, el = $('#v-history'), q = new URLSearchParams(histQuery);
    const types = ['issue_detected', 'notification', 'escalated', 'acknowledged', 'action_auto', 'approval_requested', 'action_approved', 'action_rejected', 'action_reverted', 'severity_raised', 'resolved', 'verified', 'machine_restarted', 'config_changed', 'demo_fault'];
    el.innerHTML = `<section class="panel"><h2>Machine profile</h2><dl class="kv"><div><dt>Machine</dt><dd>${esc(p.name)}</dd></div><div><dt>Installed</dt><dd>${p.installed_at}</dd></div><div><dt>Runtime recorded</dt><dd>${p.runtime_h} h</dd></div>
        <div><dt>Issues</dt><dd>${p.failures}</dd></div><div><dt>Mean time between issues</dt><dd>${p.mtbf_h === null ? 'n/a' : p.mtbf_h + ' h'}</dd></div><div><dt>Downtime</dt><dd>${p.downtime_h} h</dd></div><div><dt>Total loss</dt><dd>${money(p.total_loss)}</dd></div>
        <div><dt>Most frequent</dt><dd style="font-size:.9rem">${esc(p.top_types.join(', ') || 'none yet')}</dd></div></dl></section>
      <section class="panel"><div class="head"><h2>History</h2><a class="btn plain" href="api/history.csv?${esc(histQuery)}">Export CSV</a></div>
        <form class="filters" id="hf"><label>Event type<select name="type"><option value="">All</option>${types.map((t) => `<option ${q.get('type') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Done by<select name="actor"><option value="">Anyone</option>${['user', 'model', 'rule', 'system'].map((t) => `<option ${q.get('actor') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Issue no.<input name="issue" inputmode="numeric" size="5" value="${esc(q.get('issue') || '')}"></label><label>Search<input name="q" value="${esc(q.get('q') || '')}"></label><button class="btn">Filter</button></form>
        ${table(['Time', 'Type', 'Who or what', 'What happened', 'Issue'], d.events.map((e) => `<tr><td>${stamp(e.ts)}</td><td>${e.type.replace(/_/g, ' ')}</td><td>${esc(e.actor)} <span class="muted">(${e.actor_type})</span></td><td>${esc(e.summary)}</td><td>${e.issue_id ? `<a href="#issue-${e.issue_id}">${e.issue_id}</a>` : ''}</td></tr>`))}
        <p class="note">Records are append-only: the database rejects edits and deletions. Newest first, up to 300 rows.</p></section>`;
    $('#hf').onsubmit = (e) => { e.preventDefault(); histQuery = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v)).toString(); viewHistory(); };
  }

  async function viewSummary() {
    const s = await api('api/summary');
    $('#v-summary').innerHTML = `<section class="panel"><div class="head"><h2>Summary, ${s.period}</h2><span class="row noprint"><a class="btn plain" href="api/issues.csv">Export CSV</a><button class="btn plain" onclick="window.print()">Print or save as PDF</button></span></div>
        <dl class="kv big"><div><dt>Line health now</dt><dd>${s.health} / 100</dd></div><div><dt>Active issues</dt><dd>${s.active}</dd></div><div><dt>Issues detected</dt><dd>${s.issues}</dd></div>
          <div><dt>Fixed by people</dt><dd>${s.resolved_by_people}</dd></div><div><dt>Cleared by themselves</dt><dd>${s.cleared_by_itself}</dd></div>
          <div><dt>Automatic actions</dt><dd>${s.actions_auto}</dd></div><div><dt>Approved by a manager</dt><dd>${s.actions_approved}</dd></div>
          <div><dt>Average time to acknowledge</dt><dd>${mins(s.avg_ack_ms)}</dd></div><div><dt>Average time to fix</dt><dd>${mins(s.avg_fix_ms)}</dd></div><div><dt>Escalations</dt><dd>${s.escalations}</dd></div>
          <div><dt>Losses</dt><dd>${money(s.loss)}</dd></div><div><dt>Saved by early detection</dt><dd>${money(s.savings)}</dd></div></dl></section>
      <section class="panel"><h2>What stands out</h2><ul class="list" style="font-size:1rem;gap:8px">${s.insights.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <p class="note">Times use the demo clock. Money figures come from placeholder cost settings.</p></section>`;
  }

  async function viewMoney() {
    const f = await api('api/finance'), c = f.costs;
    const fields = [['production_value_h', 'Production value per hour'], ['idle_labour_h', 'Idle crew cost per hour'], ['repair_labour_h', 'Technician cost per hour'], ['scrap_kg', 'Scrap cost per kg'], ['energy_kwh', 'Energy price per kWh']];
    $('#v-money').innerHTML = `<section class="panel"><h2>Losses and savings</h2>
        <dl class="kv big"><div><dt>Actual losses</dt><dd>${money(f.totals.loss)}</dd></div><div><dt>Saved by early detection</dt><dd>${money(f.totals.savings)}</dd></div><div><dt>At risk in open issues</dt><dd>${money(f.totals.projected_open)}</dd></div>
          <div><dt>Downtime</dt><dd>${(f.totals.downtime_h * 60).toFixed(0)} min</dd></div><div><dt>Return on the monitoring kit</dt><dd>${f.roi.ratio === null ? 'n/a' : f.roi.ratio + ' ×'}</dd></div></dl>
        <p class="note">Return = savings ÷ an assumed kit cost of ${money(f.roi.module_cost)}. All cost inputs below are placeholders, not measured figures.</p></section>
      <div class="half"><section class="panel"><h2>By issue type</h2>${table(['Issue type', 'Station', '#Count', '#Downtime', '#Loss', '#Saved'], f.byType.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc((STATIONS.find((s) => s.id === r.component) || {}).name || "")}</td><td class="num">${r.n}</td><td class="num">${(r.downtime * 60).toFixed(0)} min</td><td class="num">${money(r.loss)}</td><td class="num">${money(r.savings)}</td></tr>`))}</section>
        <section class="panel"><h2>By day</h2>${table(['Day', '#Issues', '#Loss', '#Saved'], f.byDay.map((r) => `<tr><td>${r.day}</td><td class="num">${r.n}</td><td class="num">${money(r.loss)}</td><td class="num">${money(r.savings)}</td></tr>`))}</section></div>
      <section class="panel"><h2>What each failure would cost</h2>${table(['Issue type', '#Chance of failure if ignored', '#Cost if it fails', '#Cost if fixed early', '#Saving'], f.failureCosts.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${Math.round(r.fail_prob * 100)} %</td><td class="num">${money(r.failure_cost)}</td><td class="num">${money(r.preventive_cost)}</td><td class="num">${money(r.saving)}</td></tr>`))}</section>
      <section class="panel"><h2>Cost settings</h2><form class="form" id="cf">${fields.map(([k, l]) => `<label>${l} (GEL)<input id="c-${k}" name="${k}" type="number" step="any" min="0" value="${c[k]}"></label>`).join('')}<div class="row" style="align-items:end"><button class="btn go">Save costs</button></div></form><p class="err"></p></section>`;
    $('#cf').onsubmit = (e) => { e.preventDefault(); act(e.target.querySelector('button'), 'api/costs', Object.fromEntries(new FormData(e.target))); };
  }

  async function viewSetup() {
    const s = await api('api/settings'), m = MODEL.metrics, A = await api('api/assumptions');
    const sw = [['automation_enabled', 'Automation', 'When off, nothing runs by itself. Every action waits for a person.'], ['approval_stop_feed', 'Stopping the feed needs manager approval', ''], ['approval_safe_shutdown', 'Shutting the machine down needs manager approval', '']];
    $('#v-setup').innerHTML = `<div class="half"><section class="panel"><h2>Automation and safety</h2>
          ${sw.map(([k, l, h]) => `<div class="switch"><span><b>${l}</b>${h ? `<br><span class="small muted">${h}</span>` : ''}</span><button class="btn" data-key="${k}" data-on="${s.settings[k] ? 1 : 0}" aria-pressed="${s.settings[k]}">${s.settings[k] ? 'On' : 'Off'}</button></div>`).join('')}
          <form class="switch" id="tf"><label for="th-value" style="flex:1"><b>Name a fault only above this confidence</b><br><span class="small muted">Below it, the issue is shown as "Unclassified anomaly: inspect the machine" with the top candidate listed, and no machine action is recommended.</span></label><span class="row"><input id="th-value" name="pct" type="number" min="0" max="100" step="1" value="${Math.round(s.unknownThreshold * 100)}" style="width:5.5em"> %<button class="btn">Save</button></span></form>
          <p class="note">There is no control link to the AP800. Machine commands go to a mock that records them and stops the simulated machine.</p><p class="err"></p></section>
        <section class="panel"><h2>Who is called</h2>${table(['Level', 'Person', 'Role', 'Shift'], s.chain.map((r) => `<tr><td>${r.level}</td><td>${esc(r.name)}</td><td>${r.role}</td><td>${r.shift}</td></tr>`))}
          <p class="note">Level 1 is alerted first, by whoever is on shift (day is 08:00 to 20:00). If nobody acknowledges within ${s.escalateAfterS} s the next level is alerted. Telegram messages are recorded but not sent: no bot token is configured.</p></section></div>
      <section class="panel"><div class="head"><h2>Projection assumptions</h2><span class="sev medium">assumed, not measured</span></div>
        <p class="small muted">The Risk tab and the Simulator use these until real history replaces them. Change them to match what you know about the line.</p>
        <form id="af"><div class="form"><label>Share of events caught early (0 to 1)<input id="as-catch" name="early_catch" type="number" step="0.01" min="0" max="1" value="${A.early_catch}"></label><label>Days since the gearbox bearing was changed<input id="as-age" name="bearing_age_days" type="number" min="0" value="${A.bearing_age_days}"></label></div>
          ${table(['Problem', 'Events per 30 operating days', 'Minutes from detection to breakdown if nobody acts'], Object.keys(A.rates_30d).map((k) => `<tr><td>${esc(FAULTS[k] || k)}</td><td><input id="as-rate-${k}" name="rate:${k}" type="number" step="any" min="0" value="${A.rates_30d[k]}" aria-label="Events per 30 days, ${esc(FAULTS[k] || k)}" size="6"></td><td>${A.ttf_min[k] !== undefined ? `<input id="as-ttf-${k}" name="ttf:${k}" type="number" min="1" value="${A.ttf_min[k]}" aria-label="Minutes to breakdown, ${esc(FAULTS[k] || k)}" size="6">` : '<span class="muted">no breakdown assumed</span>'}</td></tr>`))}
          <div class="row" style="margin-top:10px"><button class="btn go">Save assumptions</button></div></form><p class="err"></p></section>
      <section class="panel"><h2>Detection model</h2><dl class="kv"><div><dt>Version</dt><dd>${MODEL.version}</dd></div><div><dt>Trained</dt><dd style="font-size:.9rem">${stamp(Date.parse(MODEL.trained_at))}</dd></div><div><dt>Precision</dt><dd>${(m.precision * 100).toFixed(1)} %</dd></div><div><dt>Recall</dt><dd>${(m.recall * 100).toFixed(1)} %</dd></div><div><dt>False-positive rate</dt><dd>${(m.false_positive_rate * 100).toFixed(2)} %</dd></div><div><dt>Fault type named correctly</dt><dd>${(m.type_accuracy * 100).toFixed(1)} %</dd></div></dl>
        <p class="note">Isolation Forest plus a deviation check, then a nearest-pattern classifier. Measured on ${m.test_samples} synthetic test samples from the simulator, not on a real machine. Forest alone: recall ${(m.forest_only.recall * 100).toFixed(1)} %. Retrain with <code>npm run train</code>.</p></section>
      <section class="panel"><h2>Audit log</h2>${table(['Time', 'Person', 'Action', 'Detail'], s.audit.map((a) => `<tr><td>${stamp(a.ts)}</td><td>${esc(a.name || '')}</td><td>${a.action.replace(/_/g, ' ')}</td><td class="small">${esc(a.detail || '')}</td></tr>`))}</section>`;
    $('#tf').onsubmit = (e) => { e.preventDefault(); act(e.target.querySelector('button'), 'api/threshold', { value: Number($('#th-value').value) / 100 }); };
    $('#af').onsubmit = (e) => { e.preventDefault(); const body = { rates_30d: {}, ttf_min: {} }; for (const [k, v] of new FormData(e.target)) { const [g, key] = k.split(':'); if (g === 'rate') body.rates_30d[key] = v; else if (g === 'ttf') body.ttf_min[key] = v; else body[k] = v; } act(e.target.querySelector('button'), 'api/assumptions', body); };
    $('#v-setup').onclick = (e) => { const b = e.target.closest('button[data-key]'); if (b) act(b, 'api/settings', { key: b.dataset.key, value: b.dataset.on !== '1' }); };
  }

  // ---- replay: step through an incident minute by minute ---------------------
  // data: { points: [{ m, v, a, loss? }], events: [{ m, summary, actor? }] }  m = minutes from the start of the fault (demo clock)
  let replayTimer = null;
  function mountReplay(el, data, simulated) {
    clearInterval(replayTimer);
    const pts = data.points; if (!pts.length) { el.innerHTML = '<p class="empty">No readings stored for this incident.</p>'; return; }
    const keys0 = Object.keys(pts[0].v).filter((k) => SIG[k]);
    const spread = (k) => { let lo = Infinity, hi = -Infinity; for (const p of pts) { if (p.v[k] < lo) lo = p.v[k]; if (p.v[k] > hi) hi = p.v[k]; } return (hi - lo) / (BASE[k] ? BASE[k].sd : 1); };
    const keys = [...new Set([...keys0.filter((k) => k !== 'rate' && k !== 'defect').sort((a, b) => spread(b) - spread(a)).slice(0, 3), 'rate', 'defect'])].filter((k) => keys0.includes(k));
    el.innerHTML = `<div class="row"><button class="btn go" data-r="play">Play</button><input type="range" data-r="pos" min="0" max="${pts.length - 1}" value="${pts.length - 1}" aria-label="Position in the incident" style="flex:1 1 200px"><b data-r="clock" style="min-width:9ch;text-align:right"></b></div>
      <div class="charts big">${keys.map((k) => `<div class="chart"><span class="lab">${SIG[k].label}</span><span class="val"><span data-rv="${k}"></span> <small>${SIG[k].unit}</small></span><canvas data-rc="${k}"></canvas></div>`).join('')}
        ${pts[0].loss !== undefined ? '<div class="chart"><span class="lab">Loss so far</span><span class="val" data-r="loss"></span></div>' : ''}</div>
      <div class="scroll" style="max-height:230px;overflow-y:auto"><table><tbody data-r="events"></tbody></table></div>`;
    const q = (s) => el.querySelector(s), pos = q('[data-r=pos]'), flags = pts.map((p) => p.a);
    const draw = () => {
      const i = Number(pos.value), p = pts[i], col = colours();
      q('[data-r=clock]').textContent = (p.m < 0 ? 'before' : 'minute ' + Math.floor(p.m));
      keys.forEach((k) => { q(`[data-rv="${k}"]`).textContent = fmt(k, p.v[k]); drawSeries(q(`[data-rc="${k}"]`), pts.slice(0, i + 1).map((x) => x.v[k]), flags, BASE[k], col, pts.length); });
      if (q('[data-r=loss]')) q('[data-r=loss]').textContent = money(p.loss);
      const seen = data.events.filter((e) => e.m <= p.m);
      q('[data-r=events]').innerHTML = seen.slice().reverse().map((e) => `<tr><td class="num">min ${Math.max(0, Math.floor(e.m))}</td><td>${esc(e.summary)}</td></tr>`).join('') || '<tr><td class="muted">Nothing has happened yet at this point.</td></tr>';
    };
    pos.oninput = draw;
    q('[data-r=play]').onclick = (e) => {
      if (replayTimer) { clearInterval(replayTimer); replayTimer = null; e.target.textContent = 'Play'; return; }
      if (Number(pos.value) >= pts.length - 1) pos.value = 0;
      e.target.textContent = 'Pause';
      replayTimer = setInterval(() => { if (!document.body.contains(el) || Number(pos.value) >= pts.length - 1) { clearInterval(replayTimer); replayTimer = null; e.target.textContent = 'Play'; return; } pos.value = Number(pos.value) + 1; draw(); }, 120);
    };
    draw();
  }

  // ---- risk overview ---------------------------------------------------------
  const pct = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + ' %';
  async function viewRisk() {
    const d = await api('api/risk'), p = d.projection, el = $('#v-risk'), h30 = p.horizons.find((h) => h.days === 30);
    const maxShare = Math.max(...h30.histogram.map((b) => b.share));
    const open = d.flags.filter((f) => !f.verdict || f.verdict === 'investigate');
    const verdictText = { expected: 'Marked as expected', investigate: 'Being investigated', escalate: 'Escalated to the manager' };
    el.innerHTML = `<section class="panel"><div class="head"><h2>Risk now</h2><span class="small muted">Live machine</span></div>
        ${d.active ? `<div class="issue ${d.active.severity}"><div class="head"><h3>${esc(d.active.title)}</h3><span class="sev ${d.active.severity}">${d.active.severity}</span></div>
          <dl class="kv"><div><dt>Chance of failure if ignored</dt><dd>${pct(d.active.fail_prob)}</dd></div><div><dt>Projected loss if not fixed</dt><dd>${money(d.active.projected_loss)}</dd></div><div><dt>Time to failure</dt><dd>${d.active.rul_min === null ? 'n/a' : Math.round(d.active.rul_min) + ' min'}</dd></div></dl>
          <a class="btn plain" href="#issue-${d.active.id}" style="align-self:flex-start">Open the issue</a></div>` : '<p class="empty">No active issue on the machine.</p>'}
        <h3>Unusual activity</h3>
        ${d.flags.length ? `<div class="acts">${d.flags.map((f) => `<div class="act"><span style="flex:1 1 320px"><b>${esc(f.title)}</b> <span class="sev ${f.severity}">${f.severity}</span><br>${esc(f.explanation)}<br><span class="muted">${stamp(f.ts)}${f.verdict ? `, ${verdictText[f.verdict].toLowerCase()} by ${esc(f.verdict_by)}` : ''}</span></span>
          ${!f.verdict || f.verdict === 'investigate' ? `<span class="row">${f.verdict ? '' : `<button class="btn plain" data-flag="${f.id}" data-v="investigate">Investigate</button>`}<button class="btn plain" data-flag="${f.id}" data-v="expected">Mark as expected</button><button class="btn" data-flag="${f.id}" data-v="escalate">Escalate</button></span>` : ''}</div>`).join('')}</div>`
          : '<p class="empty">Nothing unusual recorded. The monitor watches for frozen sensors, energy use while stopped, running outside scheduled hours, loosened safeguards, repeated overrides and gaps in the data.</p>'}
        <div class="row"><span class="small muted">Demo: test the monitor on the live simulated machine</span>
          ${[['freeze', 'Freeze the pressure sensor'], ['spike', 'Temperature sensor reads 180 °C'], ['idle_draw', 'Pump keeps drawing power when stopped'], ['night', 'Treat the time as 23:30'], ['overrides', 'Count three extra overrides']].map(([k, l]) => `<button class="btn plain" data-quirk="${k}" aria-pressed="${d.quirk === k}">${l}</button>`).join('')}
          <button class="btn plain" data-quirk="">Switch tests off</button></div>
        <p class="note">Open flags: ${open.length}. One test runs at a time. A frozen sensor takes about 15 seconds to be flagged; the others take a second or two. The power test only shows while the machine is stopped. A flag that has been given a verdict is not raised again for 24 hours.</p><p class="err"></p></section>
      <section class="panel sim"><div class="head"><h2>Projected losses</h2><span class="simtag">PROJECTION from ${p.runs} simulated futures</span></div>
        ${table(['Next', '#Chance of a failure nobody catches', '#Expected loss', '#Likely range (5th to 95th percentile)', '#Expected loss without monitoring'], p.horizons.map((h) => `<tr><td>${h.days} days</td><td class="num">${pct(h.p_failure)}</td><td class="num">${money(h.expected_loss)}</td><td class="num">${money(h.p5)} to ${money(h.p95)}</td><td class="num">${money(h.expected_loss_without_monitoring)}</td></tr>`))}
        <p class="note">These figures come from the assumed values below, not from measured failure data.</p></section>
      <section class="panel"><div class="head"><h2>Assumed values behind the projection</h2><span class="row"><span class="sev medium">assumed</span>${can('manager') ? '<a class="btn plain" href="#setup">Edit on the Setup page</a>' : '<span class="small muted">The manager edits these on the Setup page</span>'}</span></div>
        <dl class="kv"><div><dt>Events caught early</dt><dd>${pct(p.assumed.early_catch)} <span class="sev medium">assumed</span></dd></div><div><dt>Days since the gearbox bearing was changed</dt><dd>${p.assumed.bearing_age_days} <span class="sev medium">assumed</span></dd></div><div><dt>Real history blended in</dt><dd>${p.assumed.history_issues} issues over ${p.assumed.history_days} operating days</dd></div></dl>
        ${table(['Problem', '#Events per 30 operating days (assumed)', '#Minutes from detection to breakdown if nobody acts (assumed)'], Object.keys(p.assumed.rates_30d).map((k) => `<tr><td>${esc(FAULTS[k] || k)}</td><td class="num">${p.assumed.rates_30d[k]}</td><td class="num">${d.assumptions.ttf_min[k] ?? 'no breakdown assumed'}</td></tr>`))}
        <p class="note">Rates start from these values and move toward the recorded history as real issues accumulate.</p></section>
      <div class="half"><section class="panel sim"><div class="head"><h2>Risk ranking, next 30 days</h2><span class="simtag">PROJECTION</span></div>
          ${table(['Risk', 'Station', '#Expected events', '#Chance of at least one', '#Expected loss', '#Cost if missed'], p.ranking.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc((STATIONS.find((s) => s.id === r.station) || {}).name || '')}</td><td class="num">${r.events_30d}</td><td class="num">${pct(r.p_event_30d)}</td><td class="num">${money(r.expected_loss_30d)}</td><td class="num">${money(r.cost_if_missed)}</td></tr>`))}</section>
        <section class="panel sim"><div class="head"><h2>Loss distribution, next 30 days</h2><span class="simtag">PROJECTION</span></div>
          <div class="hist" role="img" aria-label="Histogram of simulated 30-day losses from ${money(h30.histogram[0].from)} to ${money(h30.histogram[h30.histogram.length - 1].to)}, most likely around ${money(h30.expected_loss)}">${h30.histogram.map((b) => `<i style="height:${Math.max(1, (100 * b.share) / maxShare)}%" title="${money(b.from)} to ${money(b.to)}: ${pct(b.share)} of futures"></i>`).join('')}</div>
          <div class="head small muted"><span>${money(h30.histogram[0].from)}</span><span>expected ${money(h30.expected_loss)}</span><span>${money(h30.histogram[h30.histogram.length - 1].to)}</span></div></section></div>
      <section class="panel sim"><div class="head"><h2>Risk heatmap: chance of each problem, week by week</h2><span class="simtag">PROJECTION</span></div>
        <div class="scroll"><table class="heat"><thead><tr><th>Risk</th>${p.heatmap[0].weeks.map((_, i) => `<th class="num">W${i + 1}</th>`).join('')}</tr></thead><tbody>
          ${p.heatmap.map((r) => `<tr><td>${esc(r.label)}</td>${r.weeks.map((w) => `<td class="num" style="background:color-mix(in srgb, var(--crit) ${Math.round(w * 85)}%, transparent)">${Math.round(w * 100)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="note">Numbers are percent chance of at least one event in that week. Darker means more likely.</p></section>`;
    el.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.flag) act(b, `api/flags/${b.dataset.flag}/verdict`, { verdict: b.dataset.v });
      if (b.dataset.quirk !== undefined) act(b, 'api/demo/quirk', { quirk: b.dataset.quirk || null });
    };
  }

  // ---- failure scenario simulator (sandbox) ----------------------------------
  let simResult = null, simVariant = 'early';
  const OUTCOME_OLD = { correct: 'Handled correctly', sensor: 'Flagged as a possible sensor fault', unknown: 'Seen, but not understood', misnamed: 'Wrong diagnosis', missed: 'Missed by the fault model' };
  const OUTCOME = { correct: 'Handled correctly', sensor: 'Flagged as a possible sensor fault', sensor_wrong: 'Wrongly blamed on a sensor', unknown: 'Unclassified anomaly, sent for inspection', misnamed: 'Wrong diagnosis', missed: 'Missed by the fault model' };
  // one entry per way the scenario was run; a low-confidence warning adds an "ignored" twin
  const simVariants = (r) => { const ig = r.ignored || {}; return [
    ['early', r.early, 'Caught early' + (ig.early ? ', warning heeded' : '')], ...(ig.early ? [['earlyIgnored', ig.early, 'Caught early, warning ignored']] : []),
    ['late', r.late, 'Caught late' + (ig.late ? ', warning heeded' : '')], ...(ig.late ? [['lateIgnored', ig.late, 'Caught late, warning ignored']] : []),
    ['never', r.never, 'Nobody acts']]; };
  function renderSim() {
    const box = $('#sim-out'); if (!box) return;
    if (!simResult) { box.innerHTML = '<p class="empty">Choose a scenario and run it. The run happens in a sandbox: it cannot alert real people, stop the machine or appear in the real history.</p>'; return; }
    const r = simResult, vars = simVariants(r), names = Object.fromEntries(vars.map(([k, , n]) => [k, n])), v = (vars.find(([k]) => k === simVariant) || vars[0])[1], e = r.early;
    box.innerHTML = `<div class="head"><h2>Run ${r.id}: ${esc(r.scenario)}</h2><span class="simtag">SIMULATED, not real data</span></div>
      <p class="small muted">${r.trained ? 'The model was trained on this fault.' : 'The model was <b>not trained</b> on this scenario.'}${r.truth ? ' What is really happening: ' + esc(r.truth) : ''}</p>
      <div class="verdict ${v.outcome}"><b>${OUTCOME[v.outcome]}</b><span>${esc(v.handling)}</span></div>
      ${r.round1 ? `<div class="verdict before"><b>After round 1: ${OUTCOME_OLD[r.round1.outcome]}</b><span>${esc(r.round1.text)}</span></div>` : ''}${r.before ? `<div class="verdict before"><b>Before cross-check: ${OUTCOME_OLD[r.before.outcome]}</b><span>${esc(r.before.text)}</span></div>` : ''}
      <p>${v.detected ? `An issue was raised <b>${v.detectMin} min</b> after it started, shown as "${esc(v.title)}" (${v.severity}), ${Math.round(v.confidence * 100)} % confidence.${v.original ? ` If the sensor is correct: ${esc(v.original.title)}.` : ''}` : '<b>The fault model raised no issue.</b>'}</p>
      <div class="three">${vars.map(([k, x, n]) => `<button class="variant" data-variant="${k}" aria-pressed="${k === simVariant}"><span class="small muted">${n}${x.delayMin !== null && x.delayMin !== undefined ? `, response after ${x.delayMin} min` : ''}</span><b>${money(x.loss)}</b><span class="small">${esc(x.note)}${x.warned ? (x.ignoreWarning ? ' The manager approves the machine action despite the low-confidence warning.' : ' The manager heeds the low-confidence warning and does not approve the machine action.') : ''}</span></button>`).join('')}</div>
      ${(r.ignored || {}).early || (r.ignored || {}).late ? '<p class="note">A machine action in this scenario carried a low-confidence warning. Both outcomes are shown: the manager heeding it and the manager approving anyway.</p>' : ''}
      <div class="half"><div><h3>Who would be alerted (${names[simVariant].toLowerCase()})</h3>${table(['Minute', 'Person', 'Channel', 'Level'], v.notified.map((n) => `<tr><td class="num">${Math.floor(n.m)}</td><td>${esc(n.name)}</td><td>${n.channel.replace('_', '-')}</td><td>${n.level}</td></tr>`))}</div>
        <div><h3>What the system would do</h3>${table(['Action', 'Outcome'], v.actions.map((a) => `<tr><td>${esc(a.label)}</td><td>${a.status === 'done' ? (a.risk === 'physical' ? 'Run after manager approval' : 'Run automatically') : a.status === 'pending_approval' ? 'Still waiting for approval' : a.status.replace('_', ' ')}</td></tr>`))}
          <p class="note">Downtime ${v.downtimeMin ?? 'n/a'} min, scrap ${v.scrapKg ?? 'n/a'} kg, escalations ${v.escalations}. ${v.mockMessages} alerts and ${v.mockCommands} machine commands went to sandbox mocks only.</p></div></div>
      <h3>What the activity monitor flagged</h3>${table(['Minute', 'Flag', 'Why', 'Sensor alert sent to'], v.flags.map((f) => `<tr><td class="num">${Math.floor(f.m)}</td><td>${esc(f.title)}</td><td class="small">${esc(f.explanation)}</td><td>${esc([...new Set(v.flagAlerts.filter((a) => a.title === f.title).map((a) => a.name))].join(', ') || 'nobody')}</td></tr>`))}
      <h3>Replay, ${names[simVariant].toLowerCase()}</h3><div id="sim-replay"></div>`;
    mountReplay($('#sim-replay'), v, true);
  }
  async function viewSim() {
    const runs = await api('api/sim/runs'), el = $('#v-sim'), cmp = await api('api/sim/crosscheck');
    const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === 10 ? 'selected' : ''}>${String(h).padStart(2, '0')}:00${h >= 8 && h < 20 ? ' (day shift)' : ' (night shift)'}</option>`).join('');
    el.innerHTML = `<section class="panel"><div class="head"><h2>What could go wrong</h2><span class="small muted">Sandbox, separate from the live machine</span></div>
        <form class="form" id="sf"><label>Scenario<select id="sf-fault" name="fault"><optgroup label="Faults the model was trained on">${SCENARIOS.filter((s) => s.trained).map((s) => `<option value="${s.key}" ${s.key === 'bearing' ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</optgroup><optgroup label="Not in the training data">${SCENARIOS.filter((s) => !s.trained).map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join('')}</optgroup></select></label>
          <label>How severe (1 = typical)<input id="sf-sev" name="severity" type="number" min="0.2" max="2" step="0.1" value="1"></label>
          <label>How fast it develops (1 = typical)<input id="sf-speed" name="speed" type="number" min="0.25" max="4" step="0.25" value="1"></label>
          <label>Time of day<select id="sf-hour" name="startHour">${hours}</select></label>
          <label>Response delay, minutes<input id="sf-resp" name="responseMin" type="number" min="0" max="240" value="10"></label>
          <label>A late response is this many minutes later<input id="sf-late" name="lateMin" type="number" min="1" max="480" value="120"></label>
          <label style="flex-direction:row;align-items:center;gap:8px;color:var(--fg);font-size:.9rem"><input id="sf-peak" name="peak" type="checkbox"> During peak production (value per hour × 1.5)</label>
          <div class="row" style="align-items:end"><button class="btn go">Run scenario</button></div></form><p class="err"></p></section>
      <section class="panel sim" id="sim-out"></section>
      <section class="panel sim"><div class="head"><h2>Every scenario: before the cross-check, after round 1, after round 2</h2><span class="simtag">SIMULATED</span></div>
        <p class="small muted">The same model throughout; it has not been retrained. The first two columns are recorded results. "After round 2" was just re-run with default settings, so slow scenarios near the threshold can come out differently from one run to the next.</p>
        ${table(['Scenario', 'Before cross-check', 'After round 1', 'After round 2', '#Opened at', '#Loss if caught early', '#Loss if nobody acts'], cmp.map((c) => `<tr><td><b>${esc(c.name)}</b><br><span class="small muted">${c.trained ? 'Trained fault' : esc(c.truth)}</span></td><td><b>${OUTCOME_OLD[c.before.outcome]}</b>${c.trained ? '' : `<br><span class="small">${esc(c.before.text)}</span>`}</td><td><b>${OUTCOME_OLD[c.round1.outcome]}</b>${c.trained ? '' : `<br><span class="small">${esc(c.round1.text)}</span>`}</td><td><b>${OUTCOME[c.after.outcome]}</b><br><span class="small">${esc(c.after.text)}</span></td><td class="num">${c.after.openConfidence === null ? 'no issue' : Math.round(c.after.openConfidence * 100) + ' %'}</td><td class="num">${c.after.losses.earlyIgnored === null ? money(c.after.losses.early) : `heeded ${money(c.after.losses.early)}<br>ignored ${money(c.after.losses.earlyIgnored)}`}</td><td class="num">${money(c.after.losses.never)}</td></tr>`))}
        <p class="note">"Opened at" is the confidence when the issue was first raised. A trained fault must open above the unknown-anomaly threshold to be named from the start.</p></section>
      <section class="panel sim"><div class="head"><h2>Stored runs</h2><span class="row"><span class="simtag">SIMULATED</span><a class="btn plain" href="api/sim/runs.csv">Export CSV</a></span></div>
        ${table(['Run', 'When', 'By', 'Scenario', 'Settings', '#Detected after', '#Caught early', '#Caught late', '#Nobody acts'], runs.map((r) => `<tr class="click" data-run="${r.id}"><td>${r.id}</td><td>${stamp(r.created_at)}</td><td>${esc((r.created_by || '').replace(/ \(.*/, ''))}</td><td>${esc(r.scenario)}${(SCENARIOS.find((s) => s.name === r.scenario) || {}).trained === false ? ' <span class="sev medium">untrained</span>' : ''}</td>
          <td class="small">severity ${r.params.severity}, speed ${r.params.speed}, ${String(r.params.startHour).padStart(2, '0')}:00${r.params.peak ? ', peak' : ''}, response ${r.params.responseMin} min, late +${r.params.lateMin} min</td>
          <td class="num">${r.detect_min === null ? 'not detected' : r.detect_min + ' min'}</td><td class="num">${money(r.loss_early)}</td><td class="num">${money(r.loss_late)}</td><td class="num">${money(r.loss_never)}</td></tr>`))}
        <p class="note">Select a row to load that run and compare. Stored runs are kept apart from the real issue list and history.</p></section>`;
    renderSim();
    $('#sf').onsubmit = async (e) => {
      e.preventDefault(); const btn = e.target.querySelector('button'), f = Object.fromEntries(new FormData(e.target)); f.peak = !!f.peak;
      btn.disabled = true; btn.textContent = 'Running…';
      try { simResult = await api('api/sim/run', f); simVariant = 'early'; await viewSim(); } catch (err) { el.querySelector('.err').textContent = err.message; btn.disabled = false; btn.textContent = 'Run scenario'; }
    };
    el.onclick = async (e) => {
      const vb = e.target.closest('[data-variant]'); if (vb) { simVariant = vb.dataset.variant; renderSim(); return; }
      const row = e.target.closest('tr[data-run]'); if (row) { simResult = await api('api/sim/runs/' + row.dataset.run); simVariant = 'early'; renderSim(); $('#sim-out').scrollIntoView({ block: 'start' }); }
    };
  }

  // ---- work orders and maintenance calendar ---------------------------------
  const WO_STEPS = ['created', 'assigned', 'in_progress', 'completed', 'verified'];
  const WO_NAME = { created: 'Created', assigned: 'Assigned', in_progress: 'In progress', completed: 'Completed', verified: 'Verified' };
  const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayName = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  function woButtons(o, people) {
    const mine = o.assigned_to === ME.id || can('manager');
    if (o.status === 'created' && can('manager')) return `<select id="wo-who-${o.id}" aria-label="Assign work order ${o.id} to">${people.map((p) => `<option value="${p.id}">${esc(p.name.replace(/ \(.*/, ''))}</option>`).join('')}</select><button class="btn go" data-wo="${o.id}" data-op="assign">Assign</button>`;
    if (o.status === 'created' && can('technician')) return `<button class="btn go" data-wo="${o.id}" data-op="assign">Take it</button>`;
    if (o.status === 'assigned' && can('technician') && mine) return `<button class="btn go" data-wo="${o.id}" data-op="start">Start work</button>`;
    if (o.status === 'in_progress' && can('technician') && mine) return `<input id="wo-note-${o.id}" placeholder="What was done" aria-label="What was done on work order ${o.id}" size="14"><button class="btn go" data-wo="${o.id}" data-op="complete">Complete</button>`;
    if (o.status === 'completed' && can('manager')) return `<button class="btn go" data-wo="${o.id}" data-op="verify">Verify</button>`;
    return '';
  }
  async function viewWork() {
    const d = await api('api/workorders'), el = $('#v-work');
    const open = d.orders.filter((o) => o.status !== 'completed' && o.status !== 'verified').sort((a, b) => a.window_start - b.window_start);
    el.innerHTML = `<section class="panel"><div class="head"><h2>Maintenance calendar</h2><span class="small muted">Peak production ${d.peak.map(([a, b]) => `${a}:00 to ${b}:00`).join(' and ')} (placeholder hours)</span></div>
        ${table(['Day', 'Suggested window', 'Work order', 'Assigned to', 'Why this window'], open.map((o) => `<tr><td>${dayName(o.window_start)}</td><td><b>${hm(o.window_start)} to ${hm(o.window_end)}</b>${o.in_peak ? ' <span class="sev critical">in peak</span>' : ''}<br><span class="small muted">must finish by ${hm(o.deadline)}, ${dayName(o.deadline)}</span></td><td>${o.id}: ${esc(o.title)}</td><td>${esc((o.assignee || 'nobody yet').replace(/ \(.*/, ''))}</td><td class="small">${esc(o.window_reason)}</td></tr>`))}
        <p class="note">Each window is the earliest slot long enough for the job that avoids peak production and ends before the predicted failure. If no such slot exists, the job is scheduled at once and marked "in peak".</p></section>
      <section class="panel"><div class="head"><h2>Work orders</h2><span class="small muted">Created automatically from detected issues</span></div>
        ${table(['No.', 'Work order', 'Progress', 'Assigned to', 'Issue', ''], d.orders.map((o) => `<tr><td>${o.id}</td><td>${esc(o.title)}<br><span class="small muted">${o.duration_h} h job, created ${stamp(o.created_at)}${o.notes ? ', done: ' + esc(o.notes) : ''}</span></td>
          <td><div class="flow">${WO_STEPS.map((s, i) => `<span class="${s === o.status ? 'on' : i < WO_STEPS.indexOf(o.status) ? 'past' : ''}">${WO_NAME[s]}</span>`).join('')}</div></td>
          <td>${esc((o.assignee || '').replace(/ \(.*/, ''))}</td><td>${o.issue_id ? `<a href="#issue-${o.issue_id}">${o.issue_id}</a>` : ''}</td><td><span class="row">${woButtons(o, d.people)}</span></td></tr>`))}
        <p class="err"></p></section>`;
    el.onclick = (e) => {
      const b = e.target.closest('button[data-wo]'); if (!b) return;
      const id = b.dataset.wo, body = {};
      if (b.dataset.op === 'assign' && $('#wo-who-' + id)) body.user_id = Number($('#wo-who-' + id).value);
      if (b.dataset.op === 'complete') body.notes = ($('#wo-note-' + id) || {}).value || '';
      act(b, `api/workorders/${id}/${b.dataset.op}`, body);
    };
  }

  // ---- routing -------------------------------------------------------------
  const VIEWS = { live: null, issues: viewIssues, history: viewHistory, summary: viewSummary, work: viewWork, risk: viewRisk, sim: viewSim, money: viewMoney, setup: viewSetup };
  function route(refreshOnly) {
    if (!ME) return;
    let h = location.hash.slice(1) || 'live', id = null;
    const m = /^issue-(\d+)$/.exec(h); if (m) { h = 'issue'; id = m[1]; }
    if (h !== 'issue' && !(h in VIEWS)) h = 'live';
    if ((h === 'money' || h === 'setup') && !can('manager')) h = 'live';
    if ((h === 'risk' || h === 'sim') && !can('technician')) h = 'live';
    clearInterval(replayTimer); replayTimer = null;
    if (refreshOnly === true && h === 'live') return;
    document.querySelectorAll('#app main').forEach((el) => { el.hidden = el.id !== 'v-' + h; });
    document.querySelectorAll('#tabs a').forEach((a) => { const on = a.getAttribute('href') === '#' + (h === 'issue' ? 'issues' : h); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
    const fn = h === 'issue' ? () => viewIssue(id) : VIEWS[h];
    if (fn) fn().catch((e) => { $('#v-' + h).innerHTML = `<section class="panel"><p class="err">${esc(e.message)}</p></section>`; });
    if (h === 'live') activeSig = '';
  }
  window.addEventListener('hashchange', () => route());

  async function start() {
    let me; try { me = await api('api/me'); } catch (e) { return; }
    ME = me.user; SIG = me.signals; BASE = me.baseline; ALERT_Z = me.alertZ; FAULTS = me.faults; SCENARIOS = me.scenarios; MODEL = me.model;
    $('#login').hidden = true; $('#app').hidden = false;
    $('#s-user').textContent = ME.name.replace(/ \(.*/, '') + ', ' + ME.role;
    document.querySelectorAll('#tabs a[data-role]').forEach((a) => { a.hidden = !can(a.dataset.role); });
    seq = 0; ticks.length = 0; activeSig = '';
    buildLine(); buildCharts(); buildFaults();
    await poll(); route();
  }

  setInterval(poll, 1000);
  setInterval(analyse, 250);
  start();
})();
