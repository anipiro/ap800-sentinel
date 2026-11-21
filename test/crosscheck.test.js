// Cross-check between the activity monitor and the fault model. The model itself is unchanged and not retrained.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { train } = require('../src/ml/detector');
const { Sentinel } = require('../src/core');
const { MockNotifier, MockActuator } = require('../src/adapters');
const { TRAINED } = require('../src/sim');
const { runScenario, crossCheckComparison, BEFORE_CROSSCHECK } = require('../src/sandbox');
const unusual = require('../src/unusual');

const model = train();
const U = { op: { id: 1, name: 'Nino', role: 'operator' }, tech: { id: 2, name: 'Giorgi', role: 'technician' }, mgr: { id: 5, name: 'Mariam', role: 'manager' } };

function rig() {
  const db = open(':memory:');
  let clock = new Date(2026, 0, 5, 9, 0, 0).getTime();
  const notifier = new MockNotifier('in_app'), actuator = new MockActuator();
  const eng = new Sentinel({ db, model, modelVersionId: 1, notifiers: [notifier], actuator, now: () => clock });
  const run = (ticks) => { for (let i = 0; i < ticks; i++) { clock += 500; eng.tick(); } };
  const start = (fault) => { eng.fault = fault; eng.faultAt = eng.t; };   // untrained scenarios are refused by injectFault, so tests set them directly
  const issue = () => { const i = db.prepare('SELECT * FROM issues ORDER BY id DESC LIMIT 1').get(); return i && { ...i, explanation: JSON.parse(i.explanation) }; };
  const actions = () => db.prepare('SELECT kind, risk, status, reason FROM actions ORDER BY id').all();
  return { db, eng, notifier, actuator, run, start, issue, actions };
}
const autoEverything = (eng) => { eng.setSetting('approval_stop_feed', false, U.mgr); eng.setSetting('approval_safe_shutdown', false, U.mgr); };

// ---- 1. a flagged sensor turns the diagnosis into a possible sensor fault ----
test('a diagnosis that depends on a flagged sensor is shown as a possible sensor fault and never stops the machine', () => {
  const { eng, notifier, actuator, run, start, issue, actions } = rig();
  autoEverything(eng);                                   // worst case: machine actions allowed to run without approval
  run(30); start('sensor_dropout'); run(40);
  const i = issue();
  assert.equal(i.type, 'sensor');
  assert.equal(i.title, 'Possible sensor fault: check the filling pressure sensor');
  assert.equal(i.explanation.original.type, 'starve', 'the model\'s own diagnosis is kept as "if the sensor is correct"');
  assert.equal(i.explanation.original.title, 'Filling is not reaching the drums');
  assert.equal(i.explanation.sensor.key, 'press');
  assert.deepEqual(actions().map((a) => a.kind), ['sensor_work_order'], 'only a work order to check the sensor');
  assert.equal(actuator.commands.filter((c) => c.kind === 'stop_feed' || c.kind === 'safe_shutdown').length, 0);
  assert.equal(eng.stopped, false);
  const st = eng.state(0, U.tech).active;
  assert.equal(st.title, i.title); assert.equal(st.original.title, 'Filling is not reaching the drums'); assert.deepEqual(st.comp, ['pump']);
  assert.ok(notifier.sent.some((m) => m.user.name.startsWith('Giorgi') && m.text.startsWith('Sensor issue on')), 'the technician is alerted as a sensor issue');
});
test('an issue that is already open is reclassified when its sensor is flagged later, and its machine action is withdrawn', () => {
  const { db, eng, actuator, run, issue, actions } = rig();
  run(30); eng.injectFault('starve', U.op); run(30);
  assert.equal(issue().type, 'starve');
  assert.equal(actions().find((a) => a.kind === 'stop_feed').status, 'pending_approval');
  eng.setQuirk('freeze', U.op); run(80);                 // the pressure sensor the diagnosis leans on now reads one fixed value
  const i = issue();
  assert.equal(i.type, 'sensor'); assert.match(i.title, /filling pressure sensor/);
  assert.equal(i.explanation.original.type, 'starve');
  assert.equal(actions().find((a) => a.kind === 'stop_feed').status, 'cancelled');
  assert.ok(actions().some((a) => a.kind === 'sensor_work_order' && a.status === 'done'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'reclassified'").get().n, 1);
  assert.equal(actuator.commands.filter((c) => c.kind === 'stop_feed').length, 0);
});
test('trained machine faults are not turned into sensor faults', () => {
  for (const fault of TRAINED) { const r = runScenario({ fault }, { model }); assert.equal(r.early.outcome, 'correct', `${fault} should still be diagnosed correctly`); assert.equal(r.before, null); }
});

// ---- 2. single-sensor diagnoses lose confidence and cannot act alone --------
test('a diagnosis resting on one sensor has lowered confidence, says so, and its machine action waits for the manager with a warning', () => {
  const { eng, run, start, issue, actions } = rig();
  autoEverything(eng);
  run(30); start('sensor_drift'); run(160);
  const i = issue();
  assert.equal(i.type, 'block', 'the model still names a blockage: it was not retrained');
  assert.ok(i.confidence <= 0.5);
  assert.ok(i.confidence < i.explanation.model_confidence);
  assert.equal(i.explanation.single_sensor, 'press');
  assert.match(i.explanation.confidence_note, /rests on one sensor \(filling pressure\)/);
  const shutdown = actions().find((a) => a.kind === 'safe_shutdown');
  assert.equal(shutdown.status, 'pending_approval', 'approval is forced even though the setting allows automatic shutdown');
  assert.match(shutdown.reason, /^Low confidence\. Check the machine before approving\./);
  assert.equal(eng.stopped, false);
  const st = eng.state(0, U.mgr);
  assert.equal(st.active.low, true); assert.ok(st.actions.find((a) => a.kind === 'safe_shutdown').warn);
});
test('the same setting lets a well-supported diagnosis act automatically', () => {
  const { eng, run, issue, actions } = rig();
  autoEverything(eng);
  run(30); eng.injectFault('block', U.op); run(30);
  assert.equal(issue().type, 'block'); assert.equal(issue().explanation.single_sensor, null);
  assert.equal(actions().find((a) => a.kind === 'safe_shutdown').status, 'done');
  assert.equal(eng.stopped, true);
});
test('when more sensors come to agree, confidence is restored and the warning is removed', () => {
  const { db, eng, run, issue, actions } = rig();
  run(30); eng.injectFault('bearing', U.op); run(120);
  const i = issue();
  assert.equal(i.type, 'bearing'); assert.ok(i.confidence >= 0.6); assert.equal(i.explanation.confidence_note, null);
  assert.ok(!actions().find((a) => a.kind === 'safe_shutdown').reason.startsWith('Low confidence'));
  if (db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'confidence_raised'").get().n) assert.equal(i.explanation.confirmed, 'Other sensors now agree with this diagnosis.');
});

// ---- 3. hidden out-of-range readings still raise a flag and alert someone ----
test('an out-of-range reading is hidden from the model but still flagged and sent to the technician', () => {
  const { db, eng, notifier, run } = rig();
  run(30); eng.setQuirk('spike', U.op); run(30);
  assert.equal(eng.active, null, 'the fault model never saw the impossible value');
  const flag = unusual.list(db).find((f) => f.kind === 'implausible');
  assert.ok(flag, 'the activity monitor flagged it'); assert.equal(flag.key, 'temp_gear');
  const alerts = db.prepare('SELECT a.*, u.name FROM flag_alerts a JOIN users u ON u.id = a.user_id WHERE a.flag_id = ?').all(flag.id);
  assert.equal(alerts.length, 1); assert.match(alerts[0].name, /^Giorgi/); assert.equal(alerts[0].channel, 'in_app');
  assert.ok(notifier.sent.some((m) => /^Sensor issue on/.test(m.text) && /180\.0 °C/.test(m.text)));
  const inbox = eng.state(0, U.tech).flagAlerts;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].title, 'A sensor reading is physically impossible');
  assert.equal(eng.state(0, U.mgr).flagAlerts.length, 0, 'not escalated to the manager unless someone escalates it');
  assert.ok(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'notification' AND summary LIKE '%sensor issue%'").get().n >= 1);
});

// ---- 4. before / after comparison -------------------------------------------
test('the comparison keeps the recorded "before" results and reruns the five untrained scenarios', () => {
  const rows = crossCheckComparison({ model });
  assert.deepEqual(rows.map((r) => r.key), ['sensor_frozen', 'sensor_dropout', 'sensor_drift', 'power_surge', 'perf_drop']);
  for (const r of rows) { assert.deepEqual(r.before, BEFORE_CROSSCHECK[r.key]); assert.ok(r.after.text.length > 20); assert.notEqual(r.after.outcome, 'correct'); }
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.sensor_dropout.before.outcome, 'misnamed'); assert.equal(by.sensor_dropout.after.outcome, 'sensor');
  assert.equal(by.sensor_frozen.after.outcome, 'missed'); assert.match(by.sensor_frozen.after.text, /alerted Giorgi/);
  assert.equal(by.sensor_drift.after.outcome, 'misnamed'); assert.match(by.sensor_drift.after.text, /rests on one sensor/);
  assert.ok(by.sensor_drift.after.confidence <= 0.5);
});
