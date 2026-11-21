const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { train } = require('../src/ml/detector');
const { Sentinel, Forbidden, BadRequest } = require('../src/core');
const { MockNotifier, MockActuator } = require('../src/adapters');
const { FAULTS, TRAINED } = require('../src/sim');
const { runScenario } = require('../src/sandbox');
const risk = require('../src/risk');
const unusual = require('../src/unusual');

const model = train();
const U = { op: { id: 1, name: 'Nino', role: 'operator' }, tech: { id: 2, name: 'Giorgi', role: 'technician' }, mgr: { id: 5, name: 'Mariam', role: 'manager' } };

function rig(hour = 9) {
  const db = open(':memory:');
  let clock = new Date(2026, 0, 5, hour, 0, 0).getTime();
  const notifier = new MockNotifier('in_app'), actuator = new MockActuator();
  const eng = new Sentinel({ db, model, modelVersionId: 1, notifiers: [notifier], actuator, now: () => clock });
  const run = (ticks) => { for (let i = 0; i < ticks; i++) { clock += 500; eng.tick(); } };
  const kinds = () => unusual.list(db).map((f) => f.kind);
  return { db, eng, notifier, actuator, run, kinds };
}

// ---- 1. scenarios the model was not trained on ------------------------------
test('the model is trained only on the eight machine faults', () => {
  assert.deepEqual(Object.keys(model.centroids).sort(), [...TRAINED].sort());
  assert.equal(TRAINED.length, 8);
  for (const k of ['sensor_frozen', 'sensor_dropout', 'sensor_drift', 'power_surge', 'perf_drop']) assert.equal(FAULTS[k].untrained, true);
});
test('untrained scenarios are never reported as correctly diagnosed', () => {
  for (const fault of ['sensor_frozen', 'sensor_dropout', 'sensor_drift', 'power_surge', 'perf_drop']) {
    const r = runScenario({ fault }, { model });
    assert.equal(r.trained, false);
    assert.ok(r.truth, 'the real cause is stated');
    for (const v of [r.early, r.late, r.never]) { assert.notEqual(v.outcome, 'correct', `${fault} must not be shown as correct`); assert.ok(v.handling.length > 20); }
  }
  assert.equal(runScenario({ fault: 'bearing' }, { model }).early.outcome, 'correct');
});
test('frozen sensor: missed by the fault model, caught by the activity monitor', () => {
  const r = runScenario({ fault: 'sensor_frozen' }, { model }).never;
  assert.equal(r.detected, false); assert.equal(r.outcome, 'missed');
  assert.ok(r.flags.some((f) => f.kind === 'frozen_sensor'));
  assert.equal(r.notified.length, 0, 'nobody is alerted about an issue that was not raised');
});
test('sensor drop-out: the model raises an issue but the monitor flags the impossible jump', () => {
  const r = runScenario({ fault: 'sensor_dropout' }, { model }).never;
  assert.equal(r.detected, true); assert.equal(r.outcome, 'sensor');
  assert.ok(r.flags.some((f) => f.kind === 'implausible'));
});
test('untrained scenarios cannot be played into the live machine', () => {
  const { eng } = rig();
  assert.throws(() => eng.injectFault('power_surge', U.op), BadRequest);
});

// ---- 2. physically implausible readings -------------------------------------
test('a reading outside the sensor range is flagged and kept away from the fault model', () => {
  const { db, eng, run, kinds } = rig(); run(30);
  eng.setQuirk('spike', U.op); run(30);
  const f = unusual.list(db).find((x) => x.kind === 'implausible');
  assert.ok(f); assert.equal(f.key, 'temp_gear'); assert.match(f.explanation, /180\.0 °C/);
  assert.equal(eng.active, null, 'an impossible value must not open a machine issue');
  assert.equal(kinds().filter((k) => k === 'implausible').length, 1);
});
test('real faults, stops and restarts do not look implausible', () => {
  for (const fault of TRAINED) {
    const { db, eng, run, kinds } = rig(); run(30);
    eng.injectFault(fault, U.op); run(80);
    for (const a of db.prepare("SELECT id FROM actions WHERE status = 'pending_approval'").all()) eng.decide(a.id, U.mgr, true);
    run(20);
    if (eng.active) eng.resolve(eng.active.id, U.tech); run(60);
    assert.ok(!kinds().includes('implausible'), `${fault} raised an implausible-reading flag`);
    assert.ok(!kinds().includes('frozen_sensor'), `${fault} raised a frozen-sensor flag`);
  }
});

// ---- 3. escalated flags reach the manager's inbox ----------------------------
test('escalating a flag puts it in the manager inbox and nobody else\'s', () => {
  const { db, eng, notifier } = rig();
  const id = unusual.raise(eng, 'repeated_overrides', 'day', 'test explanation');
  assert.equal(eng.state(0, U.mgr).flagAlerts.length, 0);
  unusual.verdict(eng, id, U.tech, 'escalate');
  const inbox = eng.state(0, U.mgr).flagAlerts;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].flag_id, id); assert.equal(inbox[0].title, 'Repeated overrides on this machine');
  assert.equal(eng.state(0, U.tech).flagAlerts.length, 0);
  assert.ok(notifier.sent.some((m) => m.user.name.startsWith('Mariam')));
  assert.throws(() => unusual.markAlertRead(eng, inbox[0].id, U.tech), /No such alert/);
  unusual.markAlertRead(eng, inbox[0].id, U.mgr);
  assert.equal(eng.state(0, U.mgr).flagAlerts.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM flag_alerts WHERE read_at IS NOT NULL').get().n, 1);
});

// ---- 4. demo triggers for every check ---------------------------------------
test('off-hours and repeated-override checks can be triggered for a demo and say so', () => {
  const a = rig(10); a.run(10);
  assert.ok(!a.kinds().includes('off_hours'));
  a.eng.setQuirk('night', U.op); a.run(4);
  const off = unusual.list(a.db).find((f) => f.kind === 'off_hours');
  assert.ok(off); assert.match(off.explanation, /23:30/); assert.match(off.explanation, /demo test button/);
  const b = rig(10); b.run(10);
  b.eng.setQuirk('overrides', U.op); b.run(4);
  const ov = unusual.list(b.db).find((f) => f.kind === 'repeated_overrides');
  assert.ok(ov); assert.match(ov.explanation, /0 of these are real/);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM events WHERE type IN ('action_rejected','action_reverted')").get().n, 0, 'the demo adds no fake history');
  assert.throws(() => b.eng.setQuirk('nonsense', U.op), BadRequest);
});

// ---- 5. editable assumptions -------------------------------------------------
test('only the manager edits assumptions; bad values are ignored; changes are recorded', () => {
  const { db, eng } = rig();
  assert.throws(() => eng.setAssumptions({ early_catch: 0.5 }, U.tech), Forbidden);
  const before = eng.assumptions();
  const after = eng.setAssumptions({ early_catch: 0.8, bearing_age_days: 300, rates_30d: { jam: 9, tear: -4, hopper: 'abc' }, ttf_min: { bearing: 15 } }, U.mgr);
  assert.equal(after.early_catch, 0.8); assert.equal(after.bearing_age_days, 300); assert.equal(after.rates_30d.jam, 9); assert.equal(after.ttf_min.bearing, 15);
  assert.equal(after.rates_30d.tear, before.rates_30d.tear); assert.equal(after.rates_30d.hopper, before.rates_30d.hopper);
  assert.deepEqual(eng.assumptions(), after);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'config_changed'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'set_assumptions'").get().n, 1);
});
test('assumptions drive the projection and the simulator', () => {
  const { db, eng } = rig();
  const base = risk.project(db, model, { runs: 1500, assumptions: eng.assumptions() });
  assert.equal(base.assumed.early_catch, 0.98);
  eng.setAssumptions({ early_catch: 0.5 }, U.mgr);
  const worse = risk.project(db, model, { runs: 1500, assumptions: eng.assumptions() });
  assert.ok(worse.horizons[1].expected_loss > base.horizons[1].expected_loss * 1.5, 'catching fewer events early must cost more');
  eng.setAssumptions({ bearing_age_days: 400 }, U.mgr);
  const old = risk.project(db, model, { runs: 300, assumptions: eng.assumptions() });
  assert.ok(old.ranking.find((r) => r.type === 'bearing').p_event_30d > base.ranking.find((r) => r.type === 'bearing').p_event_30d);
  const ok = runScenario({ fault: 'bearing', responseMin: 10 }, { model, ttfMin: { bearing: 60 } });
  const tight = runScenario({ fault: 'bearing', responseMin: 10 }, { model, ttfMin: { bearing: 5 } });
  assert.equal(ok.early.failedFirst, false); assert.equal(tight.early.failedFirst, true);
  assert.ok(tight.early.loss > ok.early.loss * 3);
});
