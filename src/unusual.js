// Unusual activity: behaviour that is not a machine fault but does not fit normal operation.
// People's verdicts feed back: "expected" silences a repeat for 24 h and, after three such verdicts
// for one kind, lowers its severity.
const { SIG, KEYS, FAULTS } = require('./sim');

const KINDS = {
  frozen_sensor:      { sev: 'medium', title: 'A sensor reading has stopped changing' },
  implausible:        { sev: 'high',   title: 'A sensor reading is physically impossible' },
  idle_energy:        { sev: 'medium', title: 'Energy use while the machine is stopped' },
  off_hours:          { sev: 'low',    title: 'Machine running outside scheduled hours' },
  config_change:      { sev: 'medium', title: 'A safety setting was changed' },
  repeated_overrides: { sev: 'high',   title: 'Repeated overrides on this machine' },
  data_gap:           { sev: 'medium', title: 'Gap in machine data' },
};
const LOWER = { critical: 'high', high: 'medium', medium: 'low', low: 'low' };
const SCHEDULE = { from: 6, to: 22 };   // placeholder production hours
const DAY = 24 * 3600 * 1000;

// Physical range of each sensor on this machine. A value outside it cannot be a real measurement.
const LIMITS = {
  cur_feed: [0, 4], cur_r12: [0, 8], cur_r3: [0, 9], cur_cal: [0, 7], cur_drum: [0, 10], cur_pump: [0, 11], cur_belt: [0, 3],
  press: [0, 0.6], thick: [0.3, 2.2], vib_roll: [0, 25], vib_drum: [0, 25], temp_gear: [-10, 120], defect: [0, 100], rate: [0, 880], motion: [0, 100],
};
// Fastest change the physical quantity can make, per second. Steel does not heat 6 °C in a second; filling pressure does not vanish in half a second.
const MAX_RATE = { press: 0.42, temp_gear: 6, thick: 0.3 };

// Demo-only oddities, switched on from the test buttons on the Risk tab.
//   freeze     pressure sensor stuck            spike      temperature sensor reads 180 °C
//   idle_draw  pump draws power while stopped   night      schedule check treats the time as 23:30
//   overrides  override check counts three extra rejections
const QUIRKS = ['freeze', 'idle_draw', 'spike', 'night', 'overrides'];

function applyQuirk(eng) {
  if (eng._bootTs === undefined) { const r = eng.db.prepare('SELECT MAX(ts) m FROM readings WHERE machine_id = ?').get(eng.machineId); eng._bootTs = r ? r.m : null; }
  const freezeKey = eng.quirk === 'freeze' ? 'press' : eng.fault && FAULTS[eng.fault] && FAULTS[eng.fault].freeze;
  if (freezeKey && !eng.stopped) { if (!eng.frozen || eng.frozen.key !== freezeKey) eng.frozen = { key: freezeKey, value: eng.ew[freezeKey] }; eng.ew[freezeKey] = eng.frozen.value; } else eng.frozen = null;
  if (eng.quirk === 'idle_draw' && eng.stopped) eng.ew.cur_pump = SIG.cur_pump.base;
  if (eng.quirk === 'spike' && !eng.stopped) eng.ew.temp_gear = 180;
}

const outOfRange = (eng) => (eng.stopped ? [] : KEYS.filter((k) => eng.ew[k] < LIMITS[k][0] || eng.ew[k] > LIMITS[k][1]));

// What the fault model is allowed to see: impossible values are replaced by the normal value for that signal.
function maskImplausible(eng) {
  const bad = outOfRange(eng);
  if (!bad.length) return eng.ew;
  const copy = { ...eng.ew };
  for (const k of bad) copy[k] = eng.detector.model.base[k].mean;
  return copy;
}

// Sensors the monitor currently distrusts. The fault model's diagnoses are cross-checked against this list.
const SENSOR_KINDS = ['frozen_sensor', 'implausible', 'data_gap'];
const SUSPECT_TICKS = 60;
function mark(eng, key, kind, why) { (eng.suspects = eng.suspects || {})[key] = { kind, why, last: eng.tickNo }; }
function suspectKeys(eng) {
  const out = {};
  for (const [k, s] of Object.entries(eng.suspects || {})) if (eng.tickNo - s.last <= SUSPECT_TICKS) out[k] = s;
  return out;
}

// Tell people about a flag. Each in_app row is that person's inbox entry.
function alertPeople(eng, flagId, level, text, about) {
  const now = eng.now();
  for (const person of eng.onDuty(level)) for (const n of eng.notifiers) {
    const res = n.send({ user: person, issue: null, text });
    eng.db.prepare('INSERT INTO flag_alerts (flag_id, user_id, channel, status, sent_at) VALUES (?,?,?,?,?)').run(flagId, person.id, n.channel, res.status, now);
    eng.event('notification', 'system', 'notifier', `${n.channel === 'in_app' ? 'In-app alert' : 'Telegram message'} to ${person.name} about ${about}: ${res.status.replace('_', ' ')}`, { refTable: 'unusual_flags', refId: flagId });
  }
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
  if (SENSOR_KINDS.includes(kind)) alertPeople(eng, id, 1, `Sensor issue on ${eng.machine.name}: ${K.title}. ${explanation}`, 'a sensor issue');   // the technician on duty hears about every sensor problem
  return id;
}

function dataGap(eng, from, to) {
  for (const k of KEYS) { mark(eng, k, 'gap', 'had a gap in its data just before'); eng.suspects[k].last = eng.tickNo - SUSPECT_TICKS / 2; }   // distrust every sensor for the next 15 seconds
  eng._steady = 0;
  raise(eng, 'data_gap', String(from), `No readings were recorded for ${Math.round((to - from) / 1000)} seconds. The data link or the monitoring server was down.`, { from, to });
}

// Runs on every tick: impossible jumps only show between two consecutive raw samples.
function everyTick(eng) {
  const now = eng.now();
  if (eng._lastTickTs && now - eng._lastTickTs > 15000) dataGap(eng, eng._lastTickTs, now);
  eng._lastTickTs = now;
  eng._steady = eng.stopped || eng.cooldown > 0 || !eng.prevRaw ? 0 : (eng._steady || 0) + 1;
  for (const [k, s] of Object.entries(eng.suspects || {})) if (s.kind === 'rate' && eng.last && Math.abs(eng.last.z[k] || 0) > 3) s.last = eng.tickNo;   // still reading abnormally: stay suspicious
  if (eng._steady < 12) return;
  for (const k of Object.keys(MAX_RATE)) {
    const perS = Math.abs(eng.raw[k] - eng.prevRaw[k]) / 0.5;
    if (perS > MAX_RATE[k]) mark(eng, k, 'rate', 'changed faster than is physically possible');
    if (perS > MAX_RATE[k]) raise(eng, 'implausible', k + ':rate', `${SIG[k].label} jumped from ${eng.prevRaw[k].toFixed(SIG[k].dp)} to ${eng.raw[k].toFixed(SIG[k].dp)} ${SIG[k].unit} in half a second. The real quantity cannot change that fast (limit ${MAX_RATE[k]} ${SIG[k].unit} per second), so this is the sensor or its wiring, not the machine.`, { signal: k, from: eng.prevRaw[k], to: eng.raw[k] });
  }
}

function check(eng) {
  const now = eng.now(), ring = eng.ring, demo = ' This flag was triggered by the demo test button, not by real activity.';

  if (!eng.simulated && eng._bootTs !== undefined && !eng._gapChecked) {
    eng._gapChecked = true;
    const gap = eng._bootTs ? now - eng._bootTs : 0;
    if (gap > 15000) dataGap(eng, eng._bootTs, now);
  }

  for (const k of outOfRange(eng)) mark(eng, k, 'range', 'reads outside its physical range');
  for (const k of outOfRange(eng))
    raise(eng, 'implausible', k, `${SIG[k].label} reads ${eng.ew[k].toFixed(SIG[k].dp)} ${SIG[k].unit}. This sensor's physical range on the machine is ${LIMITS[k][0]} to ${LIMITS[k][1]} ${SIG[k].unit}, so the value cannot be real. The fault model ignores this reading until it is back in range.`, { signal: k, value: eng.ew[k], limits: LIMITS[k] });

  if (!eng.stopped && ring.length >= 30) {
    const last = ring.slice(-30), impossible = outOfRange(eng);
    for (const k of KEYS) {
      if (impossible.includes(k)) continue;   // already flagged as physically impossible
      let lo = Infinity, hi = -Infinity;
      for (const r of last) { if (r.v[k] < lo) lo = r.v[k]; if (r.v[k] > hi) hi = r.v[k]; }
      if (hi - lo < 1e-9 && lo !== 0) mark(eng, k, 'frozen', 'has stopped changing');
      if (hi - lo < 1e-9 && lo !== 0) raise(eng, 'frozen_sensor', k, `${SIG[k].label} has read exactly ${lo} ${SIG[k].unit} for 15 seconds while the machine is running. A live sensor always moves a little, so this points to a failed sensor, a loose cable or tampering.`, { signal: k, value: lo });
    }
  }

  eng._stoppedTicks = eng.stopped ? (eng._stoppedTicks || 0) + 1 : 0;
  if (eng._stoppedTicks >= 5) {
    const live = KEYS.filter((k) => k.startsWith('cur_') && eng.ew[k] > 0.3 * SIG[k].base);
    if (live.length) raise(eng, 'idle_energy', live.join(','), `The machine is stopped but ${live.map((k) => SIG[k].label.toLowerCase()).join(', ')} still shows load (${live.map((k) => eng.ew[k].toFixed(2) + ' A').join(', ')}). Something is running that should be off.`, { signals: live });
  }

  const night = eng.quirk === 'night', d = night ? new Date(new Date(now).setHours(23, 30, 0, 0)) : new Date(now), h = d.getHours();
  if (!eng.stopped && eng.ew.rate > 100 && (h < SCHEDULE.from || h >= SCHEDULE.to))
    raise(eng, 'off_hours', new Date(now).toISOString().slice(0, 10), `The line is producing at ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}, outside the scheduled ${SCHEDULE.from}:00 to ${SCHEDULE.to}:00.${night ? demo : ''}`, { hour: h, demo: night });

  if (eng.tickNo % 10 === 0 || eng.quirk === 'overrides') {
    const real = eng.db.prepare("SELECT COUNT(*) n FROM events WHERE machine_id = ? AND ts > ? AND type IN ('action_rejected', 'action_reverted')").get(eng.machineId, now - DAY).n;
    const extra = eng.quirk === 'overrides' ? 3 : 0, n = real + extra;
    if (n >= 3) raise(eng, 'repeated_overrides', new Date(now).toISOString().slice(0, 10), `Recommended actions were rejected or undone ${n} times in the last 24 hours. Either the recommendations are wrong for this machine or warnings are being ignored.${extra ? ` ${real} of these are real; three were added by the demo test button.` : ''}`, { count: n, real, demo: !!extra });
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
  const now = eng.now();
  eng.db.prepare('UPDATE unusual_flags SET verdict = ?, verdict_by = ?, verdict_at = ? WHERE id = ?').run(v, user.name, now, id);
  const words = { expected: 'marked as expected', investigate: 'opened for investigation', escalate: 'escalated to the manager' }[v];
  eng.event('unusual_verdict', 'user', user.name, `${f.title}: ${words} by ${user.name}`, { refTable: 'unusual_flags', refId: id });
  if (v === 'escalate') alertPeople(eng, id, 3, `${eng.machine.name}: ${f.title}. ${f.explanation}`, 'unusual activity');
}

function markAlertRead(eng, alertId, user) {
  const r = eng.db.prepare('UPDATE flag_alerts SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(eng.now(), alertId, user.id);
  if (!r.changes) throw Object.assign(new Error('No such alert in your inbox'), { status: 400 });
}

function list(db, limit = 30) {
  return db.prepare('SELECT * FROM unusual_flags ORDER BY id DESC LIMIT ?').all(limit).map((f) => ({ ...f, data: f.data ? JSON.parse(f.data) : null }));
}

module.exports = { suspectKeys, SENSOR_KINDS, applyQuirk, everyTick, maskImplausible, check, raise, configChanged, verdict, markAlertRead, list, KINDS, QUIRKS, LIMITS, MAX_RATE };
