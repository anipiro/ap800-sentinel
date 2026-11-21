const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { train } = require('../src/ml/detector');
const { Sentinel } = require('../src/core');
const { MockNotifier, MockActuator } = require('../src/adapters');
const unusual = require('../src/unusual');
const audit = require('../src/audit');

const model = train();
const U = { op: { id: 1, name: 'Nino', role: 'operator' }, tech: { id: 2, name: 'Giorgi', role: 'technician' }, mgr: { id: 5, name: 'Mariam', role: 'manager' } };
function rig(extra = {}) {
  const db = open(':memory:');
  let clock = new Date(2026, 0, 5, 9, 0, 0).getTime();
  const notifier = new MockNotifier('in_app');
  const eng = new Sentinel({ db, model, modelVersionId: 1, notifiers: [notifier], actuator: new MockActuator(), now: () => clock, ...extra });
  const run = (ticks) => { for (let i = 0; i < ticks; i++) { clock += 500; eng.tick(); } };
  return { db, eng, notifier, run, jump: (ms) => { clock += ms; } };
}

// ---- 1. audit log ---------------------------------------------------------------
test('audit log gathers sign-ins, setting changes, approvals, rejections, overrides and automated actions', () => {
  const { db, eng, run } = rig();
  eng.audit(U.mgr, 'login'); eng.audit(U.tech, 'login');
  eng.setSetting('automation_enabled', true, U.mgr);
  run(30); eng.injectFault('jam', U.op); run(20);
  const shut = db.prepare("SELECT id FROM actions WHERE kind = 'safe_shutdown'").get().id;
  eng.decide(shut, U.mgr, true); eng.revert(shut, U.mgr);
  eng.resolve(eng.active.id, U.tech); run(40);
  eng.injectFault('block', U.op); run(20);
  eng.decide(db.prepare("SELECT id FROM actions WHERE status = 'pending_approval'").get().id, U.mgr, false);
  unusual.verdict(eng, unusual.raise(eng, 'repeated_overrides', 'd', 'x'), U.tech, 'expected');
  const all = audit.entries(db), c = audit.counts(db);
  assert.equal(c.login, 2); assert.equal(c.setting, 1); assert.equal(c.approval, 1); assert.equal(c.rejection, 1); assert.ok(c.override >= 2); assert.ok(c.automated >= 2);
  assert.equal(all.length, Object.values(c).reduce((a, b) => a + b, 0));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].ts >= all[i].ts, 'newest first');
  assert.ok(audit.entries(db, { category: 'approval' }).every((r) => r.category === 'approval' && /approved/.test(r.what)));
  assert.ok(audit.entries(db, { q: 'giorgi' }).length >= 1); assert.ok(audit.entries(db, { q: 'giorgi' }).every((r) => /giorgi/i.test(r.who + r.what)));
  assert.equal(audit.entries(db, { category: 'login', q: 'mariam' }).length, 1);
  assert.equal(audit.entries(db, { from: eng.now() + 1 }).length, 0);
  assert.ok(all.find((r) => r.category === 'rejection').issue_id > 0);
});

// ---- 2. model monitoring ----------------------------------------------------------
const monitor = require('../src/monitor');
test('model monitoring: clean running gives a low drift score and no alert', () => {
  const { db, eng, notifier, run } = rig();
  run(200);
  const stats = db.prepare('SELECT * FROM model_stats ORDER BY id').all();
  assert.ok(stats.length >= 3); for (const s of stats) { assert.ok(s.drift < 1.5, `drift ${s.drift}`); assert.equal(s.model_version_id, 1); assert.equal(s.samples, 60); }
  const h = monitor.health(db, model, 1, eng.now());
  assert.equal(h.status, 'ok'); assert.equal(h.version, 1); assert.equal(h.trend.length, stats.length); assert.equal(h.issues_without_model_version, 0);
  assert.ok(!unusual.list(db).some((f) => f.kind === 'model_drift')); assert.equal(notifier.sent.length, 0);
});
test('model monitoring: a shifted input distribution raises the drift score and alerts the manager', () => {
  const shifted = JSON.parse(JSON.stringify(model));
  shifted.base.thick.mean += 3 * shifted.base.thick.sd;          // the line now runs a different thickness than the model learned
  const { db, eng, notifier, run } = rig({ model: shifted });
  run(140);
  const h = monitor.health(db, shifted, 1, eng.now());
  assert.equal(h.status, 'drifting'); assert.ok(h.drift > 2); assert.equal(h.drift_signal, 'Sheet thickness');
  const flag = unusual.list(db).find((f) => f.kind === 'model_drift');
  assert.ok(flag); assert.match(flag.explanation, /sheet thickness has moved .* standard deviations/);
  assert.ok(notifier.sent.some((m) => m.user.name.startsWith('Mariam') && /model drift/.test(m.text)));
  assert.equal(eng.state(0, U.mgr).flagAlerts.length, 1);
  run(200); assert.equal(unusual.list(db).filter((f) => f.kind === 'model_drift').length, 1, 'one alert, not one per check');
});
test('model monitoring: every issue carries its model version; feedback is counted; limit is manager-only', () => {
  const { db, eng, run } = rig();
  run(30); eng.injectFault('jam', U.op); run(20);
  const id = eng.active.id;
  assert.equal(db.prepare('SELECT model_version_id FROM issues WHERE id = ?').get(id).model_version_id, 1);
  assert.throws(() => monitor.feedback(eng, id, 'false_alarm', U.op), /technician/);
  assert.throws(() => monitor.feedback(eng, id, 'maybe', U.tech), /real/);
  monitor.feedback(eng, id, 'false_alarm', U.tech);
  let h = monitor.health(db, model, 1, eng.now());
  assert.equal(h.false_alarms_7d, 1); assert.equal(h.issues_7d, 1); assert.ok(h.avg_confidence > 0.5);
  monitor.feedback(eng, id, 'real', U.tech);                    // changed their mind: the latest verdict counts
  h = monitor.health(db, model, 1, eng.now());
  assert.equal(h.false_alarms_7d, 0); assert.equal(h.confirmed_7d, 1);
  assert.throws(() => monitor.setDriftThreshold(eng, 3, U.tech), /manager/);
  monitor.setDriftThreshold(eng, 3, U.mgr);
  assert.equal(monitor.health(db, model, 1, eng.now()).drift_threshold, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'set_drift_threshold'").get().n, 1);
});
