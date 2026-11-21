// Unusual activity: behaviour that is not a machine fault but does not fit normal operation.
// Runs on the live machine only. People's verdicts feed back: "expected" silences a repeat for 24 h
// and, after three such verdicts for one kind, lowers its severity.
const { SIG, KEYS } = require('./sim');

const KINDS = {
  frozen_sensor:      { sev: 'medium', title: 'A sensor reading has stopped changing' },
  idle_energy:        { sev: 'medium', title: 'Energy use while the machine is stopped' },
  off_hours:          { sev: 'low',    title: 'Machine running outside scheduled hours' },
  config_change:      { sev: 'medium', title: 'A safety setting was changed' },
  repeated_overrides: { sev: 'high',   title: 'Repeated overrides on this machine' },
  data_gap:           { sev: 'medium', title: 'Gap in machine data' },
};
const LOWER = { critical: 'high', high: 'medium', medium: 'low', low: 'low' };
const SCHEDULE = { from: 6, to: 22 };   // placeholder production hours
const DAY = 24 * 3600 * 1000;

// Demo-only sensor oddities, switched on from the "Test unusual activity" buttons.
function applyQuirk(eng) {
  if (eng._bootTs === undefined) { const r = eng.db.prepare('SELECT MAX(ts) m FROM readings WHERE machine_id = ?').get(eng.machineId); eng._bootTs = r ? r.m : null; }
  if (eng.quirk === 'freeze') { if (eng.frozen === null) eng.frozen = eng.ew.press; eng.ew.press = eng.frozen; } else eng.frozen = null;
  if (eng.quirk === 'idle_draw' && eng.stopped) eng.ew.cur_pump = SIG.cur_pump.base;
}

function raise(eng, kind, key, explanation, data = null) {
  const K = KINDS[kind], now = eng.now(), db = eng.db;
  const open = db.prepare("SELECT 1 FROM unusual_flags WHERE kind = ? AND key = ? AND (verdict IS NULL OR verdict = 'investigate' OR verdict_at > ?)").get(kind, key, now - DAY);
  if (open) return null;
  const expected = db.prepare("SELECT COUNT(*) n FROM unusual_flags WHERE kind = ? AND verdict = 'expected'").get(kind).n;
  const severity = expected >= 3 ? LOWER[K.sev] : K.sev;
  const id = Number(db.prepare('INSERT INTO unusual_flags (machine_id, ts, kind, key, severity, title, explanation, data) VALUES (?,?,?,?,?,?,?,?)')
    .run(eng.machineId, now, kind, key, severity, K.title, explanation, data ? JSON.stringify(data) : null).lastInsertRowid);
  eng.event('unusual_activity', 'system', 'activity monitor', `${K.title}: ${explanation}`, { refTable: 'unusual_flags', refId: id });
  return id;
}

function check(eng) {
  if (eng.simulated) return;
  const now = eng.now(), ring = eng.ring;

  if (eng._bootTs !== undefined && !eng._gapChecked) {
    eng._gapChecked = true;
    const gap = eng._bootTs ? now - eng._bootTs : 0;
    if (gap > 15000) raise(eng, 'data_gap', String(eng._bootTs), `No readings were recorded for ${Math.round(gap / 1000)} seconds. The data link or the monitoring server was down.`, { from: eng._bootTs, to: now });
  }

  if (!eng.stopped && ring.length >= 30) {
    const last = ring.slice(-30);
    for (const k of KEYS) {
      let lo = Infinity, hi = -Infinity;
      for (const r of last) { if (r.v[k] < lo) lo = r.v[k]; if (r.v[k] > hi) hi = r.v[k]; }
      if (hi - lo < 1e-9) raise(eng, 'frozen_sensor', k, `${SIG[k].label} has read exactly ${lo} ${SIG[k].unit} for 15 seconds while the machine is running. A live sensor always moves a little, so this points to a failed sensor, a loose cable or tampering.`, { signal: k, value: lo });
    }
  }

  eng._stoppedTicks = eng.stopped ? (eng._stoppedTicks || 0) + 1 : 0;
  if (eng._stoppedTicks >= 5) {
    const live = KEYS.filter((k) => k.startsWith('cur_') && eng.ew[k] > 0.3 * SIG[k].base);
    if (live.length) raise(eng, 'idle_energy', live.join(','), `The machine is stopped but ${live.map((k) => SIG[k].label.toLowerCase()).join(', ')} still shows load (${live.map((k) => eng.ew[k].toFixed(2) + ' A').join(', ')}). Something is running that should be off.`, { signals: live });
  }

  const d = new Date(now), h = d.getHours();
  if (!eng.stopped && eng.ew.rate > 100 && (h < SCHEDULE.from || h >= SCHEDULE.to))
    raise(eng, 'off_hours', d.toISOString().slice(0, 10), `The line is producing at ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}, outside the scheduled ${SCHEDULE.from}:00 to ${SCHEDULE.to}:00.`, { hour: h });

  if (eng.tickNo % 10 === 0) {
    const n = eng.db.prepare("SELECT COUNT(*) n FROM events WHERE machine_id = ? AND ts > ? AND type IN ('action_rejected', 'action_reverted')").get(eng.machineId, now - DAY).n;
    if (n >= 3) raise(eng, 'repeated_overrides', new Date(now).toISOString().slice(0, 10), `Recommended actions were rejected or undone ${n} times in the last 24 hours. Either the recommendations are wrong for this machine or warnings are being ignored.`, { count: n });
  }
}

function configChanged(eng, key, value, user) {
  if (value) return;   // only loosening a guardrail is unusual
  raise(eng, 'config_change', `${key}:${eng.now()}`, `${user.name} switched off "${key.replace(/_/g, ' ')}". The machine now has one safeguard fewer.`, { key, by: user.name });
}

function verdict(eng, id, user, v) {
  eng.need(user, 'technician');
  if (!['expected', 'investigate', 'escalate'].includes(v)) throw Object.assign(new Error('Unknown verdict'), { status: 400 });
  const f = eng.db.prepare('SELECT * FROM unusual_flags WHERE id = ?').get(id);
  if (!f) throw Object.assign(new Error('No such flag'), { status: 400 });
  eng.db.prepare('UPDATE unusual_flags SET verdict = ?, verdict_by = ?, verdict_at = ? WHERE id = ?').run(v, user.name, eng.now(), id);
  const words = { expected: 'marked as expected', investigate: 'opened for investigation', escalate: 'escalated to the manager' }[v];
  eng.event('unusual_verdict', 'user', user.name, `${f.title}: ${words} by ${user.name}`, { refTable: 'unusual_flags', refId: id });
  if (v === 'escalate') for (const person of eng.onDuty(3)) for (const n of eng.notifiers) n.send({ user: person, issue: null, text: `${eng.machine.name}: ${f.title}. ${f.explanation}` });
}

function list(db, limit = 30) {
  return db.prepare('SELECT * FROM unusual_flags ORDER BY id DESC LIMIT ?').all(limit).map((f) => ({ ...f, data: f.data ? JSON.parse(f.data) : null }));
}

module.exports = { applyQuirk, check, raise, configChanged, verdict, list, KINDS };
