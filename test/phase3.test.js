const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { train } = require('../src/ml/detector');
const { Sentinel, Forbidden } = require('../src/core');
const { MockNotifier, MockActuator } = require('../src/adapters');
const { runScenario } = require('../src/sandbox');
const wo = require('../src/workorders');

const model = train();
const U = { op: { id: 1, name: 'Nino', role: 'operator' }, tech: { id: 2, name: 'Giorgi', role: 'technician' }, tech2: { id: 4, name: 'Tamar', role: 'technician' }, mgr: { id: 5, name: 'Mariam', role: 'manager' } };
function rig() {
  const db = open(':memory:');
  let clock = new Date(2026, 0, 5, 9, 0, 0).getTime();
  const eng = new Sentinel({ db, model, modelVersionId: 1, notifiers: [new MockNotifier('in_app')], actuator: new MockActuator(), now: () => clock });
  const run = (ticks) => { for (let i = 0; i < ticks; i++) { clock += 500; eng.tick(); } };
  return { db, eng, run };
}
const at = (h, m = 0) => new Date(2026, 0, 5, h, m, 0).getTime(), H = 3600000;

test('repair window avoids peak production and comes before the predicted failure', () => {
  let w = wo.suggestWindow(at(7, 10), 1, at(20));
  assert.equal(w.start, at(7, 30)); assert.equal(w.inPeak, false);
  w = wo.suggestWindow(at(9, 40), 1, at(20));            // 10:00 to 14:00 is peak, and a 1 h job starting now would run into it
  assert.equal(w.start, at(14)); assert.equal(w.end, at(15)); assert.equal(w.inPeak, false);
  assert.match(w.reason, /outside peak production and before the predicted failure/);
  w = wo.suggestWindow(at(10, 5), 2, at(13));            // failure predicted at 13:00, inside peak: cannot wait
  assert.equal(w.start, at(10, 30)); assert.equal(w.inPeak, true); assert.match(w.reason, /cannot wait/);
  w = wo.suggestWindow(at(17, 45), 1.5, null);           // no deadline: skip the evening peak
  assert.equal(w.start, at(21)); assert.equal(w.end - w.start, 1.5 * H);
});
test('work-order actions create work orders linked to the issue', () => {
  const { db, eng, run } = rig();
  run(30); eng.injectFault('bearing', U.op); run(40);
  const orders = wo.list(db);
  assert.deepEqual(orders.map((o) => o.kind).sort(), ['create_work_order', 'schedule_maintenance']);
  for (const o of orders) { assert.equal(o.issue_id, eng.active.id); assert.equal(o.status, 'created'); assert.ok(o.window_start >= o.created_at); assert.ok(o.window_end > o.window_start); assert.match(o.title, /Rolling gearbox bearing is wearing/); assert.ok(o.window_reason.length > 10); }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'work_order_created'").get().n, 2);
  run(60); assert.equal(wo.list(db).length, 2, 'no duplicates while the issue stays open');
});
test('work order lifecycle: created, assigned, in progress, completed, verified, with role checks', () => {
  const { db, eng, run } = rig();
  run(30); eng.injectFault('jam', U.op); run(20);
  const id = wo.list(db)[0].id, row = () => db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
  assert.throws(() => wo.move(eng, id, U.op, 'assign'), Forbidden);
  assert.throws(() => wo.move(eng, id, U.tech, 'start'), /cannot be moved/);
  wo.move(eng, id, U.mgr, 'assign', { user_id: 2 });
  assert.equal(row().status, 'assigned'); assert.equal(row().assigned_to, 2);
  assert.throws(() => wo.move(eng, id, U.tech2, 'start'), /assigned to someone else/);
  wo.move(eng, id, U.tech, 'start'); assert.equal(row().status, 'in_progress');
  assert.throws(() => wo.move(eng, id, U.tech, 'verify'), Forbidden);
  wo.move(eng, id, U.tech, 'complete', { notes: 'Belt cleared' }); assert.equal(row().status, 'completed'); assert.equal(row().notes, 'Belt cleared');
  wo.move(eng, id, U.mgr, 'verify'); assert.equal(row().status, 'verified'); assert.equal(row().verified_by, 5);
  assert.throws(() => wo.move(eng, id, U.mgr, 'verify'), /cannot be moved/);
  for (const t of ['work_order_assigned', 'work_order_started', 'work_order_completed', 'work_order_verified']) assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE type = ?').get(t).n, 1);
});
test('simulations create no work orders on the live machine', () => {
  const { db, run } = rig(); run(20);
  runScenario({ fault: 'jam' }, { model });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM work_orders').get().n, 0);
});
