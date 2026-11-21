const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { train, IssueDetector } = require('../src/ml/detector');
const { TRAINED, sample, smooth } = require('../src/sim');
const { Sentinel, Forbidden } = require('../src/core');
const { MockNotifier, MockActuator } = require('../src/adapters');
const loss = require('../src/loss');

const model = train();
const C = { production_value_h: 3000, idle_labour_h: 40, repair_labour_h: 30, scrap_kg: 4, energy_kwh: 0.25 };
const U = { op: { id: 1, name: 'Nino', role: 'operator' }, tech: { id: 2, name: 'Giorgi', role: 'technician' }, mgr: { id: 5, name: 'Mariam', role: 'manager' } };

function rig(opts = {}) {
  const db = open(':memory:');
  let clock = Date.UTC(2026, 0, 5, 9, 0, 0);
  const notifier = new MockNotifier('in_app'), actuator = new MockActuator();
  const eng = new Sentinel({ db, model, modelVersionId: 1, notifiers: [notifier], actuator, escalateAfterS: 20, now: () => clock, ...opts });
  const run = (ticks) => { for (let i = 0; i < ticks; i++) { clock += 500; eng.tick(); } };
  return { db, eng, notifier, actuator, run };
}

// ---- loss formulas ----------------------------------------------------------
test('actual loss = downtime × (production + idle labour) + repair + scrap + energy', () => {
  const r = loss.actualLoss({ downtime_h: 2, repair_h: 3, parts: 100, scrap_kg: 50, extra_kwh: 40 }, C);
  assert.equal(r.downtime, 6080); assert.equal(r.repair, 190); assert.equal(r.scrap, 200); assert.equal(r.energy, 10);
  assert.equal(r.total, 6480);
});
test('projected loss = failure probability × failure cost, probability clamped to 0..1', () => {
  const spec = { downtime_h: 1, repair_h: 1, parts: 0 };           // 3040 + 30 = 3070
  assert.equal(loss.projectedLoss(0.5, spec, C), 1535);
  assert.equal(loss.projectedLoss(7, spec, C), 3070);
});
test('savings = failure cost − preventive cost, never negative', () => {
  assert.equal(loss.savingsFromEarlyDetection({ downtime_h: 2, repair_h: 0, parts: 0 }, { downtime_h: 0.5, repair_h: 0, parts: 0 }, C), 4560);
  assert.equal(loss.savingsFromEarlyDetection({ downtime_h: 0, repair_h: 0, parts: 0 }, { downtime_h: 1, repair_h: 0, parts: 0 }, C), 0);
});

// ---- detection pipeline -----------------------------------------------------
test('detector stays quiet on normal running and names every trained fault', () => {
  const det = new IssueDetector(model);
  let ew = null, t = 0, falseAlarms = 0;
  for (let i = 0; i < 1500; i++) { ew = smooth(ew, sample((t += 0.5), null, 0)); if (i > 12 && det.predict(1, ew).anomaly) falseAlarms++; }
  assert.ok(falseAlarms <= 8, `too many false alarms: ${falseAlarms}`);
  for (const f of TRAINED) {
    let e = null, tt = 0, hit = null;
    for (let i = 0; i < 12; i++) e = smooth(e, sample((tt += 0.5), null, 0));
    for (let i = 0; i < 60; i++) { e = smooth(e, sample((tt += 0.5), f, i * 0.5)); hit = det.predict(1, e); }
    assert.ok(hit.anomaly, `${f} not detected`); assert.equal(hit.type, f);
    assert.ok(hit.contributions.length > 0, `${f} has no explanation`);
  }
});
test('model metrics are recorded', () => {
  for (const k of ['precision', 'recall', 'false_positive_rate']) assert.equal(typeof model.metrics[k], 'number');
  assert.ok(model.metrics.recall > 0.9);
});

// ---- engine: issue, notification, escalation --------------------------------
test('a fault opens one issue, notifies the level-1 technician, and escalates when nobody acknowledges', () => {
  const { db, eng, notifier, run } = rig();
  run(30); assert.equal(eng.active, null);
  eng.injectFault('starve', U.op); run(30);
  assert.ok(eng.active); assert.equal(eng.active.type, 'starve');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issues').get().n, 1);
  assert.deepEqual(notifier.sent.map((m) => m.user.name), ['Giorgi (technician, day shift)']);   // 09:00 is day shift
  run(50);                                                                                        // 25 s more, past the 20 s limit
  assert.equal(eng.active.level, 2);
  assert.ok(notifier.sent.some((m) => m.user.name.startsWith('Tamar')));
  eng.ack(eng.active.id, U.tech); run(100);
  assert.equal(eng.active.level, 2, 'no escalation after acknowledgement');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE acked_at IS NULL").get().n, 0);
});

// ---- remediation guardrails -------------------------------------------------
test('low-risk actions run automatically; physical actions wait for a manager', () => {
  const { db, eng, actuator, run } = rig();
  run(20); eng.injectFault('jam', U.op); run(20);
  const acts = db.prepare('SELECT * FROM actions ORDER BY id').all();
  assert.equal(acts.find((a) => a.kind === 'create_work_order').status, 'done');
  const shutdown = acts.find((a) => a.kind === 'safe_shutdown');
  assert.equal(shutdown.status, 'pending_approval');
  assert.ok(!actuator.commands.some((c) => c.kind === 'safe_shutdown'), 'shutdown must not run without approval');
  assert.equal(eng.stopped, false);
  assert.throws(() => eng.decide(shutdown.id, U.tech, true), Forbidden);
  assert.throws(() => eng.decide(shutdown.id, U.op, true), Forbidden);
  eng.decide(shutdown.id, U.mgr, true);
  assert.equal(eng.stopped, true);
  assert.ok(actuator.commands.some((c) => c.kind === 'safe_shutdown' && c.op === 'execute'));
  eng.revert(shutdown.id, U.mgr);
  assert.equal(eng.stopped, false);
  assert.equal(db.prepare('SELECT status FROM actions WHERE id = ?').get(shutdown.id).status, 'reverted');
});
test('with automation switched off nothing runs by itself', () => {
  const { db, eng, actuator, run } = rig();
  eng.setSetting('automation_enabled', false, U.mgr);
  run(20); eng.injectFault('block', U.op); run(20);
  assert.ok(eng.active);
  assert.equal(actuator.commands.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM actions WHERE status = 'done'").get().n, 0);
});
test('every automatic action is logged with reason and confidence', () => {
  const { db, eng, run } = rig();
  run(20); eng.injectFault('tear', U.op); run(20);
  const a = db.prepare("SELECT * FROM actions WHERE status = 'done'").get();
  assert.match(a.reason, /detected with \d+ % confidence/); assert.ok(a.confidence > 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'action_auto'").get().n >= 1);
});

// ---- resolution and losses --------------------------------------------------
test('resolving records loss and savings, clears the fault and restarts the machine', () => {
  const { db, eng, run } = rig();
  run(20); eng.injectFault('bearing', U.op); run(60);
  const id = eng.active.id;
  assert.throws(() => eng.resolve(id, U.op), Forbidden);
  eng.resolve(id, U.tech, { note: 'Bearing replaced' });
  const i = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  assert.equal(i.status, 'resolved'); assert.ok(i.actual_loss > 0); assert.ok(i.savings > 0);
  assert.equal(eng.fault, null); assert.equal(eng.active, null);
  run(80); assert.equal(eng.active, null, 'no new issue after the repair');
  assert.throws(() => eng.verify(id, U.tech), Forbidden);
  eng.verify(id, U.mgr);
  assert.equal(db.prepare('SELECT status FROM issues WHERE id = ?').get(id).status, 'verified');
});

// ---- permissions and history ------------------------------------------------
test('only managers change settings and costs', () => {
  const { eng } = rig();
  assert.throws(() => eng.setSetting('automation_enabled', false, U.tech), Forbidden);
  assert.throws(() => eng.setCosts({ production_value_h: 1 }, U.op), Forbidden);
  eng.setCosts({ production_value_h: 2500 }, U.mgr);
  assert.equal(eng.costs().production_value_h, 2500);
});
test('history and audit log are append-only', () => {
  const { db, eng } = rig();
  eng.event('note', 'system', 'test', 'first entry'); eng.audit(U.mgr, 'test');
  assert.throws(() => db.prepare("UPDATE events SET summary = 'edited'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM events').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
});
