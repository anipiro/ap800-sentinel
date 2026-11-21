// Mentor feedback: thermal camera, blast freezer, motor drive, line chain, data sources. All simulated.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { train } = require('../src/ml/detector');
const { Sentinel } = require('../src/core');
const { MockNotifier, MockActuator } = require('../src/adapters');
const { KEYS, TRAINED } = require('../src/sim');
const { runScenario } = require('../src/sandbox');
const unusual = require('../src/unusual');
const chain = require('../src/chain');

const model = train();
const U = { op: { id: 1, name: 'Nino', role: 'operator' }, tech: { id: 2, name: 'Giorgi', role: 'technician' }, mgr: { id: 5, name: 'Mariam', role: 'manager' } };
function rig() {
  const db = open(':memory:');
  let clock = new Date(2026, 0, 5, 9, 0, 0).getTime();
  const notifier = new MockNotifier('in_app');
  const eng = new Sentinel({ db, model, modelVersionId: 1, notifiers: [notifier], actuator: new MockActuator(), now: () => clock });
  const run = (ticks) => { for (let i = 0; i < ticks; i++) { clock += 500; eng.tick(); } };
  const issue = () => { const i = db.prepare('SELECT * FROM issues ORDER BY id DESC LIMIT 1').get(); return i && { ...i, explanation: JSON.parse(i.explanation) }; };
  return { db, eng, notifier, run, issue };
}

test('normal running: the whole chain is OK and nothing is flagged', () => {
  const { db, eng, run } = rig(); run(120);
  const v = chain.view(eng);
  assert.deepEqual(v.stages.map((s) => s.id), ['forming', 'conveyor', 'freezer', 'packaging']);
  assert.ok(v.stages.every((s) => s.status === 'ok'), JSON.stringify(v.stages.map((s) => s.status)));
  assert.equal(v.problem_at, null); assert.equal(v.simulated, true);
  assert.ok(Math.abs(v.values.vfd_amps - 6.2) < 0.5); assert.ok(v.values.entry < 18); assert.ok(v.values.chamber < -31); assert.equal(v.values.ptc_trip, false);
  assert.equal(unusual.list(db).length, 0); assert.equal(eng.active, null);
});
test('warm product at freezer entry raises the quality alert, loads the freezer and alerts the technician', () => {
  const { db, eng, notifier, run } = rig(); run(60);
  const before = chain.view(eng).values;
  chain.setWarm(eng, true, U.op); run(160);
  const v = chain.view(eng);
  assert.ok(v.values.entry > v.entry_limit, `entry ${v.values.entry}`);
  assert.ok(v.values.chamber > before.chamber + 2, 'chamber warms'); assert.ok(v.values.compressor > before.compressor + 3, 'compressor works harder');
  assert.equal(v.stages.find((s) => s.id === 'freezer').status, 'warning'); assert.equal(v.problem_at, 'Conveyor'); assert.match(v.freezer_risk, /Freezer load is up/);
  const flags = unusual.list(db).filter((f) => f.kind === 'warm_product');
  assert.equal(flags.length, 1); assert.match(flags[0].explanation, /entering the blast freezer at \d+\.\d °C; the limit is 18 °C/); assert.equal(flags[0].severity, 'high');
  assert.ok(notifier.sent.some((m) => m.user.name.startsWith('Giorgi') && /too warm at freezer entry/.test(m.text)));
  assert.equal(eng.state(0, U.tech).flagAlerts.length, 1);
  assert.equal(eng.active, null, 'a warm product is a quality warning, not a machine fault');
  chain.setWarm(eng, false, U.op); run(200);
  assert.ok(chain.view(eng).values.entry < 18); assert.equal(chain.view(eng).stages.find((s) => s.id === 'freezer').status, 'ok');
});
test('the freezer entry limit is a manager setting', () => {
  const { db, eng, run } = rig(); run(60);
  assert.throws(() => chain.setEntryLimit(eng, 12, U.tech), /manager/); assert.throws(() => chain.setEntryLimit(eng, 99, U.mgr), /between/);
  chain.setEntryLimit(eng, 12, U.mgr); run(20);                               // normal product at about 15.5 °C is now over the limit
  assert.ok(unusual.list(db).some((f) => f.kind === 'warm_product'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'set_freezer_entry_limit'").get().n, 1);
});
test('high motor drive current is attached to a jam and to a bearing diagnosis as supporting evidence', () => {
  for (const [fault, ticks] of [['jam', 30], ['bearing', 140]]) {
    const { db, eng, run, issue } = rig(); run(40);
    const normal = chain.view(eng).values.vfd_amps;
    eng.injectFault(fault, U.op); run(ticks);
    const v = chain.view(eng), i = issue();
    assert.equal(i.type, fault);
    assert.ok(v.values.vfd_amps > normal * 1.15, `${fault}: drive current ${v.values.vfd_amps} vs ${normal}`);
    assert.match(v.support, /Main drive current from the motor drive \(VFD\) is \d+ % above normal/);
    assert.equal(i.explanation.support, eng.active.support);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'supporting_evidence'").get().n, 1);
    assert.ok(v.values.winding > 68, 'the winding warms under load');
  }
  const { eng, run } = rig(); run(40); eng.injectFault('starve', U.op); run(40);
  assert.equal(chain.view(eng).support, null, 'a filling fault does not load the main drive');
});
test('a jam shows where the problem is in the chain and starves packaging', () => {
  const { eng, run } = rig(); run(40); eng.injectFault('jam', U.op); run(40);
  const v = chain.view(eng);
  assert.equal(v.stages.find((s) => s.id === 'forming').status, 'fault'); assert.equal(v.stages.find((s) => s.id === 'conveyor').status, 'fault');
  assert.equal(v.stages.find((s) => s.id === 'packaging').status, 'waiting'); assert.equal(v.problem_at, 'Forming (AP800)');
  assert.equal(v.freezer_risk, null, 'no product is arriving, so the freezer is not being loaded');
});
test('the chain view is safe to read in the instant after a repair, before the next reading', () => {
  const { eng, run } = rig(); run(40); eng.injectFault('jam', U.op); run(30);
  eng.resolve(eng.active.id, U.tech, { note: 'Cleared' });
  assert.equal(eng.ew, null);
  const v = chain.view(eng);
  assert.equal(v.stages[0].detail, 'Restarting'); assert.equal(v.stages.length, 4);
  run(1); assert.ok(chain.view(eng).stages[0].detail.endsWith("kg/h"));
});
test('every reading has a source and a signal type', () => {
  const keys = chain.SOURCES.map((s) => s.key);
  for (const k of KEYS) assert.ok(keys.includes(k), `no source for ${k}`);
  for (const s of chain.SOURCES) { assert.ok(s.label && s.device && s.protocol && s.type, s.key); assert.match(s.source, / — /); assert.equal(s.simulated, true); }
  const src = Object.fromEntries(chain.SOURCES.map((s) => [s.key, s.source]));
  assert.equal(src.vfd_amps, 'Motor drive (VFD), main drive — Modbus TCP'); assert.equal(src.winding, 'Motor PT100, winding — 4–20 mA via PLC');
  assert.match(src.product, /IR camera.* — Ethernet/); assert.equal(src.chamber, 'Freezer controller — Modbus'); assert.equal(src.rate, 'Line PLC — OPC UA');
  assert.equal(chain.SOURCES.find((s) => s.key === 'ptc_trip').type, 'on/off');
});
test('the chain is not an input to the fault model: detection is unchanged', () => {
  assert.equal(KEYS.length, 15); assert.deepEqual(Object.keys(model.base).sort(), [...KEYS].sort());
  for (const fault of TRAINED) assert.equal(runScenario({ fault }, { model }).early.outcome, 'correct', fault);
  const { eng, run } = rig(); run(40); eng.injectFault('jam', U.op); run(30);
  const withSupport = eng.active.confidence;
  assert.ok(withSupport > 0.9 && withSupport <= 0.99, 'supporting evidence does not change the confidence');
});
