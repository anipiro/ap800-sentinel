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
