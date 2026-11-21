// Round 2 of the cross-check: corroboration, unknown-anomaly threshold, warning heeded/ignored, data gaps. The model is still not retrained.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { train } = require('../src/ml/detector');
const { Sentinel, Forbidden, BadRequest } = require('../src/core');
const { MockNotifier, MockActuator } = require('../src/adapters');
const { TRAINED } = require('../src/sim');
const { runScenario, crossCheckComparison, AFTER_ROUND1 } = require('../src/sandbox');
const unusual = require('../src/unusual');

const model = train();
const U = { op: { id: 1, name: 'Nino', role: 'operator' }, tech: { id: 2, name: 'Giorgi', role: 'technician' }, mgr: { id: 5, name: 'Mariam', role: 'manager' } };

function rig() {
  const db = open(':memory:');
  let clock = new Date(2026, 0, 5, 9, 0, 0).getTime();
  const notifier = new MockNotifier('in_app'), actuator = new MockActuator();
  const eng = new Sentinel({ db, model, modelVersionId: 1, notifiers: [notifier], actuator, now: () => clock });
  const run = (ticks) => { for (let i = 0; i < ticks; i++) { clock += 500; eng.tick(); } };
  const untilIssue = (max = 600) => { for (let i = 0; i < max && !eng.active; i++) run(1); assert.ok(eng.active, 'an issue should open'); };
  const jump = (ms) => { clock += ms; };                                  // time passes with no readings: a gap in the data
  const start = (fault, speed = 1, sev = 1) => { eng.fault = fault; eng.faultAt = eng.t; eng.faultSpeed = speed; eng.faultSev = sev; };
  const issue = () => { const i = db.prepare('SELECT * FROM issues ORDER BY id DESC LIMIT 1').get(); return i && { ...i, explanation: JSON.parse(i.explanation) }; };
  const actions = () => db.prepare('SELECT kind, risk, status, reason FROM actions ORDER BY id').all();
  const events = (type) => db.prepare('SELECT summary FROM events WHERE type = ? ORDER BY id').all(type).map((e) => e.summary);
  return { db, eng, notifier, actuator, run, untilIssue, jump, start, issue, actions, events };
}

// ---- 1. corroboration before blaming the sensor ------------------------------
test('a real blockage at maximum speed and severity stays a blockage and the stop is still recommended', () => {
  const { db, eng, run, start, issue, actions } = rig();
  run(30); start('block', 4, 2); run(40);
  const flags = unusual.list(db).filter((f) => f.kind === 'implausible');
  assert.ok(flags.some((f) => f.key.startsWith('press')), 'the pressure sensor really was flagged, so the cross-check was exercised');
  const i = issue();
  assert.equal(i.type, 'block'); assert.equal(i.title, 'Filling line blocked');
  assert.match(i.explanation.sensor_note, /filling pressure sensor .* but .* with this diagnosis, so it is treated as a real machine fault/);
  const shutdown = actions().find((a) => a.kind === 'safe_shutdown');
  assert.equal(shutdown.status, 'pending_approval', 'the shutdown is still recommended');
  assert.ok(!shutdown.reason.startsWith('Low confidence'));
  assert.ok(!actions().some((a) => a.kind === 'sensor_work_order'));
  eng.decide(db.prepare("SELECT id FROM actions WHERE kind = 'safe_shutdown'").get().id, U.mgr, true);
  assert.equal(eng.stopped, true);
  const sim = runScenario({ fault: 'block', severity: 2, speed: 4 }, { model });
  assert.equal(sim.early.outcome, 'correct'); assert.ok(sim.early.actions.some((a) => a.risk === 'physical' && a.status === 'done'));
});
test('a real fault keeps its diagnosis and actions when its sensor is flagged later, with the flag shown as a note', () => {
  const { eng, run, issue, actions, events } = rig();
  run(30); eng.injectFault('starve', U.op); run(30);
  eng.setQuirk('freeze', U.op); run(80);                 // pressure sensor freezes, but pump current and defect rate still show the starvation
  const i = issue();
  assert.equal(i.type, 'starve');
  assert.match(i.explanation.sensor_note, /has stopped changing, but .* agree/);
  assert.equal(actions().find((a) => a.kind === 'stop_feed').status, 'pending_approval');
  assert.equal(events('sensor_note').length, 1); assert.equal(events('reclassified').length, 0);
  assert.equal(eng.state(0, U.tech).active.sensorNote, i.explanation.sensor_note);
});
test('with nothing to back it up, the same flag still makes it a possible sensor fault', () => {
  const { run, start, issue, actions } = rig();
  run(30); start('sensor_dropout'); run(40);
  assert.equal(issue().type, 'sensor'); assert.deepEqual(actions().map((a) => a.kind), ['sensor_work_order']);
});

// ---- 2. unknown-anomaly threshold --------------------------------------------
test('below the threshold nothing is named: unclassified anomaly, candidate listed, inspection order, technician alerted, no machine action', () => {
  const { eng, notifier, actuator, untilIssue, run, start, issue, actions } = rig();
  eng.setSetting('approval_safe_shutdown', false, U.mgr); eng.setSetting('approval_stop_feed', false, U.mgr);
  run(30); start('sensor_drift'); untilIssue();
  const i = issue();
  assert.equal(i.type, 'unknown'); assert.equal(i.title, 'Unclassified anomaly: inspect the machine');
  assert.ok(i.confidence < 0.4);
  assert.equal(i.explanation.candidate.type, 'block'); assert.equal(i.explanation.candidate.label, 'Filling blockage');
  assert.match(i.explanation.confidence_note, /Most likely "Filling blockage", but at \d+ % confidence, below the 40 % needed to name a fault/);
  assert.deepEqual(actions().map((a) => `${a.kind}:${a.risk}:${a.status}`), ['inspection_work_order:low:done']);
  assert.equal(actuator.commands.filter((c) => c.kind === 'safe_shutdown' || c.kind === 'stop_feed').length, 0);
  assert.ok(notifier.sent.some((m) => m.user.name.startsWith('Giorgi') && /Unclassified anomaly: inspect the machine/.test(m.text)));
  const st = eng.state(0, U.tech).active;
  assert.equal(st.candidate.title, 'Filling line blocked'); assert.equal(st.title, i.title);
});
test('the threshold is a manager setting, validated and audit-logged', () => {
  const { db, eng, events } = rig();
  assert.equal(eng.setting('unknown_threshold'), '0.4');
  assert.throws(() => eng.setUnknownThreshold(0.5, U.tech), Forbidden);
  assert.throws(() => eng.setUnknownThreshold(1.5, U.mgr), BadRequest);
  assert.throws(() => eng.setUnknownThreshold('abc', U.mgr), BadRequest);
  eng.setUnknownThreshold(0.55, U.mgr);
  assert.equal(Number(eng.setting('unknown_threshold')), 0.55);
  assert.match(events('config_changed')[0], /from 40 % to 55 %/);
  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'set_unknown_threshold'").get();
  assert.equal(audit.user_id, 5); assert.deepEqual(JSON.parse(audit.detail), { from: 0.4, to: 0.55 });
});
test('an unclassified anomaly is named once confidence reaches the threshold', () => {
  const { eng, untilIssue, run, issue, actions, events } = rig();
  eng.setUnknownThreshold(0.95, U.mgr);                  // set high so a clogged cell certainly starts unclassified
  run(30); eng.injectFault('cell', U.op); untilIssue();
  assert.equal(issue().type, 'unknown'); assert.equal(issue().explanation.candidate.type, 'cell');
  run(40); assert.equal(issue().type, 'unknown', 'stays unclassified while confidence is under the threshold');
  eng.setUnknownThreshold(0.3, U.mgr); run(20);          // now its confidence is above the threshold
  const i = issue();
  assert.equal(i.type, 'cell'); assert.ok(i.confidence >= 0.3);
  assert.match(events('reclassified')[0], /Changed from "Unclassified anomaly: inspect the machine" to "More defective products than normal"\. Confidence reached \d+ %/);
  assert.ok(actions().some((a) => a.kind === 'schedule_maintenance'));
});

// ---- 3. simulator shows both ways when a warning decides the outcome ----------
test('a low-confidence warning produces both a "heeded" and an "ignored" result', () => {
  const r = runScenario({ fault: 'sensor_drift', responseMin: 30 }, { model, unknownThreshold: 0 });   // threshold off so the blockage is named and the warned shutdown exists
  assert.equal(r.early.warned, true); assert.equal(r.early.ignoreWarning, false);
  assert.ok(r.ignored.early, 'the ignored variant was run'); assert.equal(r.ignored.early.ignoreWarning, true);
  assert.equal(r.early.machineCommands, 0, 'heeded: nothing stopped the machine');
  assert.ok(r.ignored.early.machineCommands > 0, 'ignored: the manager approved the shutdown');
  assert.ok(r.ignored.early.loss > r.early.loss, 'stopping a healthy machine costs more');
  assert.match(r.early.handling, /manager heeded it and did not approve/); assert.match(r.ignored.early.handling, /manager approved it anyway/);
  const jam = runScenario({ fault: 'jam' }, { model });
  assert.equal(jam.early.warned, false); assert.equal(jam.ignored.early, null); assert.equal(jam.ignored.late, null);
});

// ---- 4. data gap, without a restart -------------------------------------------
test('a gap in the readings makes the next single-sensor diagnosis a possible sensor fault, until the suspicion lapses', () => {
  const { db, eng, run, jump, untilIssue, issue, events } = rig();
  run(40);
  assert.equal(unusual.list(db).length, 0);
  jump(60000); run(1);                                   // one minute with no readings, server still running
  const gap = unusual.list(db).find((f) => f.kind === 'data_gap');
  assert.ok(gap); assert.match(gap.explanation, /No readings were recorded for 6[01] seconds/);
  assert.equal(Object.keys(unusual.suspectKeys(eng)).length, 15, 'every sensor is distrusted just after the gap');
  eng.injectFault('cell', U.op); untilIssue(40);
  const first = issue();
  assert.equal(first.type, 'sensor'); assert.equal(first.title, 'Possible sensor fault: check the defect rate sensor');
  assert.equal(first.explanation.original.type, 'cell'); assert.match(first.explanation.sensor.why, /gap in its data/);
  run(120);                                              // the fault persists long after the gap
  const later = issue();
  assert.equal(later.type, 'cell', 'once the gap is well behind, the machine diagnosis stands');
  assert.match(events('reclassified')[0], /The sensor is no longer flagged, so the machine diagnosis stands/);
  assert.equal(Object.keys(unusual.suspectKeys(eng)).length, 0);
});
test('steady ticking raises no data-gap flag', () => {
  const { db, run } = rig(); run(200);
  assert.ok(!unusual.list(db).some((f) => f.kind === 'data_gap'));
});

// ---- 5. all thirteen scenarios after round 2 ----------------------------------
test('the eight trained faults are still diagnosed correctly and none opens below the threshold', () => {
  const rows = crossCheckComparison({ model });
  assert.equal(rows.length, 13);
  const trained = rows.filter((r) => r.trained);
  assert.deepEqual(trained.map((r) => r.key).sort(), [...TRAINED].sort());
  for (const r of trained) {
    assert.equal(r.after.outcome, 'correct', `${r.key} outcome`);
    assert.equal(r.after.openType, r.key, `${r.key} must be named from the start, not opened as unclassified or sensor`);
    assert.ok(r.after.openConfidence >= 0.4, `${r.key} opened at ${r.after.openConfidence}`);
    assert.equal(r.before.outcome, 'correct'); assert.equal(r.round1.outcome, 'correct');
  }
  for (const r of rows.filter((x) => !x.trained)) { assert.deepEqual(r.round1, AFTER_ROUND1[r.key]); assert.notEqual(r.after.outcome, 'correct'); }
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.sensor_dropout.after.outcome, 'sensor');
  assert.ok(['unknown', 'misnamed'].includes(by.perf_drop.after.outcome), 'a slow performance drop sits near the threshold: unclassified in some runs, named Sheet tear in others');
  assert.equal(by.power_surge.after.outcome, 'unknown');
});
