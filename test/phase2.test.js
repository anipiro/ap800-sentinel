const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { train } = require('../src/ml/detector');
const { Sentinel, Forbidden } = require('../src/core');
const { MockNotifier, MockActuator } = require('../src/adapters');
const { runScenario } = require('../src/sandbox');
const risk = require('../src/risk');
const unusual = require('../src/unusual');

const model = train();
const U = { op: { id: 1, name: 'Nino', role: 'operator' }, tech: { id: 2, name: 'Giorgi', role: 'technician' }, mgr: { id: 5, name: 'Mariam', role: 'manager' } };
const TABLES = ['issues', 'events', 'notifications', 'actions', 'readings', 'unusual_flags', 'audit_log', 'simulations'];

function rig(hour = 9) {
  const db = open(':memory:');
  let clock = new Date(2026, 0, 5, hour, 0, 0).getTime();
  const notifier = new MockNotifier('in_app'), actuator = new MockActuator();   // stand-ins for the REAL notifier and actuator of the live machine
  const eng = new Sentinel({ db, model, modelVersionId: 1, notifiers: [notifier], actuator, now: () => clock });
  const run = (ticks) => { for (let i = 0; i < ticks; i++) { clock += 500; eng.tick(); } };
  const counts = () => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  return { db, eng, notifier, actuator, run, counts };
}

// ---- sandbox isolation ------------------------------------------------------
test('a simulation never touches the live machine, its history, its notifier or its actuator', () => {
  const live = rig(); live.run(20);
  const before = live.counts(), tickBefore = live.eng.tickNo;
  for (const fault of ['jam', 'bearing', 'starve']) {
    const r = runScenario({ fault, responseMin: 5, lateMin: 60 }, { model, modelVersionId: 1, costs: live.eng.costs() });
    assert.ok(r.early.detected, `${fault} should be detected in the sandbox`);
    assert.ok(r.early.mockMessages > 0, 'sandbox alerts go to mock notifiers');
    assert.ok(r.early.events.length > 0);
  }
  assert.deepEqual(live.counts(), before, 'no rows added to any live table');
  assert.equal(live.notifier.sent.length, 0, 'live notifier was never called');
  assert.equal(live.actuator.commands.length, 0, 'live actuator was never called');
  assert.equal(live.eng.active, null); assert.equal(live.eng.fault, null); assert.equal(live.eng.stopped, false);
  assert.equal(live.eng.tickNo, tickBefore, 'live machine was not advanced');
});
test('simulation results are labelled as simulated and physical actions inside them hit only the mock actuator', () => {
  const r = runScenario({ fault: 'jam', responseMin: 5 }, { model });
  assert.equal(r.simulated, true);
  assert.ok(r.early.mockCommands > 0, 'the approved shutdown went to the sandbox mock actuator');
  assert.ok(r.early.actions.some((a) => a.risk === 'physical' && a.status === 'done'));
});

// ---- scenario behaviour -----------------------------------------------------
test('responding late costs more than responding early; not responding costs most', () => {
  for (const fault of ['jam', 'starve', 'bearing']) {
    const r = runScenario({ fault, responseMin: 5, lateMin: 120 }, { model });
    assert.ok(r.early.loss < r.late.loss, `${fault}: early ${r.early.loss} should be below late ${r.late.loss}`);
    assert.ok(r.late.loss <= r.never.loss * 1.01, `${fault}: late ${r.late.loss} should not exceed never ${r.never.loss}`);   // equal when the late response arrives after the breakdown
  }
});
test('what-if parameters change the outcome: night shift, slow response, weak fault', () => {
  assert.match(runScenario({ fault: 'jam', startHour: 23 }, { model }).early.notified[0].name, /^Luka/);
  assert.match(runScenario({ fault: 'jam', startHour: 10 }, { model }).early.notified[0].name, /^Giorgi/);
  const slow = runScenario({ fault: 'starve', responseMin: 60 }, { model });
  assert.ok(slow.early.escalations >= 2, 'an hour without acknowledgement escalates to the manager');
  assert.ok(slow.early.notified.some((n) => n.name.startsWith('Mariam')));
  const weak = runScenario({ fault: 'cell', severity: 0.2 }, { model });
  assert.equal(weak.early.detected, false);
  const peak = runScenario({ fault: 'jam', peak: true }, { model }), normal = runScenario({ fault: 'jam' }, { model });
  assert.ok(peak.never.loss > normal.never.loss);
});

// ---- Monte Carlo ------------------------------------------------------------
test('risk projection is ordered, grows with the horizon and writes nothing', () => {
  const { db, counts } = rig(); const before = counts();
  const p = risk.project(db, model, { runs: 1500 });
  assert.deepEqual(p.horizons.map((h) => h.days), [7, 30, 90]);
  for (const h of p.horizons) { assert.ok(h.p5 <= h.expected_loss && h.expected_loss <= h.p95); assert.ok(h.expected_loss < h.expected_loss_without_monitoring); assert.ok(h.p_failure >= 0 && h.p_failure <= 1); }
  assert.ok(p.horizons[0].p_failure < p.horizons[2].p_failure);
  assert.ok(p.horizons[0].expected_loss < p.horizons[2].expected_loss);
  assert.equal(p.heatmap[0].weeks.length, 13);
  assert.ok(Math.abs(p.horizons[1].histogram.reduce((s, b) => s + b.share, 0) - 1) < 0.01);
  for (let i = 1; i < p.ranking.length; i++) assert.ok(p.ranking[i - 1].expected_loss_30d >= p.ranking[i].expected_loss_30d);
  assert.deepEqual(counts(), before);
});
test('an open issue raises the near-term risk of its own type', () => {
  const { db } = rig();
  const p = risk.project(db, model, { runs: 500, active: { type: 'bearing', fail_prob: 0.7 } });
  assert.ok(p.heatmap.find((h) => h.type === 'bearing').weeks[0] >= 0.7);
});

// ---- unusual activity -------------------------------------------------------
test('a frozen sensor is flagged, and "expected" silences the repeat', () => {
  const { db, eng, run } = rig(); run(40);
  assert.equal(unusual.list(db).length, 0, 'normal running raises nothing');
  eng.setQuirk('freeze', U.op); run(70);
  const flags = unusual.list(db);
  assert.equal(flags.length, 1); assert.equal(flags[0].kind, 'frozen_sensor'); assert.equal(flags[0].key, 'press');
  assert.match(flags[0].explanation, /Filling pressure has read exactly/);
  assert.equal(eng.active, null, 'a frozen sensor is not a machine fault');
  assert.throws(() => unusual.verdict(eng, flags[0].id, U.op, 'expected'), Forbidden);
  unusual.verdict(eng, flags[0].id, U.tech, 'expected'); run(60);
  assert.equal(unusual.list(db).length, 1, 'not raised again within 24 hours');
});
test('three "expected" verdicts lower the severity of that kind', () => {
  const { db, eng } = rig();
  for (let i = 0; i < 3; i++) unusual.verdict(eng, unusual.raise(eng, 'frozen_sensor', 'k' + i, 'test'), U.tech, 'expected');
  const id = unusual.raise(eng, 'frozen_sensor', 'k9', 'test');
  assert.equal(db.prepare('SELECT severity FROM unusual_flags WHERE id = ?').get(id).severity, 'low');
});
test('energy use while stopped, running off-hours and loosened safeguards are flagged', () => {
  const a = rig(); a.run(20); a.eng.stopped = true; a.eng.setQuirk('idle_draw', U.op); a.run(20);
  assert.ok(unusual.list(a.db).some((f) => f.kind === 'idle_energy'));
  const b = rig(23); b.run(10);
  assert.ok(unusual.list(b.db).some((f) => f.kind === 'off_hours'));
  const c = rig(); c.eng.setSetting('approval_safe_shutdown', false, U.mgr);
  const f = unusual.list(c.db).find((x) => x.kind === 'config_change');
  assert.ok(f); assert.match(f.explanation, /Mariam switched off/);
  c.eng.setSetting('approval_safe_shutdown', true, U.mgr);
  assert.equal(unusual.list(c.db).filter((x) => x.kind === 'config_change').length, 1, 'switching a safeguard back on is not flagged');
});
test('escalating a flag alerts the manager', () => {
  const { eng, notifier } = rig();
  const id = unusual.raise(eng, 'repeated_overrides', 'd', 'test');
  unusual.verdict(eng, id, U.tech, 'escalate');
  assert.ok(notifier.sent.some((m) => m.user.name.startsWith('Mariam')));
});
