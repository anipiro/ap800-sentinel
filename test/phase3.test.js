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

// ---- KPIs ---------------------------------------------------------------------
const { kpis } = require('../src/kpi');
test('KPIs: healthy running gives full availability; a stop lowers OEE and is counted', () => {
  const { db, eng, run } = rig();
  run(120);
  const now = () => eng.now();
  let k = kpis(db, { period: '1h', now: now() });
  assert.equal(k.availability, 1); assert.equal(k.unplanned_stops, 0); assert.equal(k.downtime_h, 0);
  assert.ok(k.performance > 0.97 && k.performance <= 1); assert.ok(k.quality > 0.97 && k.quality < 1);
  assert.ok(Math.abs(k.oee - k.availability * k.performance * k.quality) < 0.002);
  assert.equal(k.mtbf_h, null); assert.equal(k.mttr_h, null);
  eng.injectFault('jam', U.op); run(60);
  eng.resolve(eng.active.id, U.tech, { note: 'Belt cleared' }); run(60);
  k = kpis(db, { period: '1h', now: now() });
  assert.equal(k.unplanned_stops, 1); assert.ok(k.downtime_h > 0); assert.ok(k.availability < 1); assert.ok(k.oee < 0.95);
  assert.equal(k.faults, 1); assert.equal(k.repairs, 1); assert.ok(k.mtbf_h > 0); assert.ok(k.mttr_h > 0);
  assert.ok(Math.abs(k.recorded_h - (k.producing_h + k.downtime_h)) < 0.01);
  const empty = kpis(db, { period: '1h', now: now() + 5 * 3600000 });
  assert.equal(empty.oee, null); assert.equal(empty.recorded_h, 0);
});

// ---- knowledge base -------------------------------------------------------------
const kb = require('../src/kb');
test('knowledge base: fixes are recorded on resolve and offered on the next similar issue', () => {
  const { db, eng, run } = rig();
  run(30); eng.injectFault('jam', U.op); run(20);
  const first = eng.active.id;
  assert.deepEqual(kb.similar(db, { type: 'jam', excludeIssue: first }), []);
  eng.resolve(first, U.tech, { note: 'Cleared the belt' });
  const id = kb.record(db, { issueId: first, rootCause: 'Dumplings stuck under the belt at the transfer point', fix: 'Cleared the belt', parts: 'none', minutes: 12, by: 'Giorgi', now: eng.now() });
  assert.ok(id);
  assert.equal(kb.record(db, { issueId: first, rootCause: '', fix: '' }), null, 'empty entries are not stored');
  assert.equal(kb.record(db, { issueId: 9999, rootCause: 'x', fix: 'y' }), null);
  run(40); eng.injectFault('jam', U.op); run(20);
  const again = eng.active.id; assert.notEqual(again, first);
  const sim = kb.similar(db, { type: 'jam', excludeIssue: again });
  assert.equal(sim.length, 1); assert.equal(sim[0].issue_id, first); assert.equal(sim[0].minutes, 12); assert.match(sim[0].root_cause, /transfer point/);
  assert.equal(kb.similar(db, { type: 'bearing', excludeIssue: again }).length, 0);
  assert.equal(kb.search(db, 'transfer').length, 1); assert.equal(kb.search(db, 'gearbox').length, 0); assert.equal(kb.search(db, '').length, 1);
  assert.equal(kb.search(db, 'belt')[0].label, 'Belt jam');
});

// ---- spare parts and shift handover ---------------------------------------------
const parts = require('../src/parts');
test('spare parts: a needed part that is low or out raises a warning with its delivery time', () => {
  const { db, eng } = rig();
  const jam = parts.forIssueType(db, 'jam');
  assert.equal(jam.length, 1); assert.equal(jam[0].level, 'out'); assert.match(jam[0].warning, /Exit belt: none in stock.*delivery takes 10 days/);
  assert.match(parts.forIssueType(db, 'bearing')[0].warning, /which is the minimum.*14 days/);
  assert.equal(parts.forIssueType(db, 'block')[0].warning, null);
  assert.deepEqual(parts.forIssueType(db, 'tear'), []);
  assert.throws(() => parts.setStock(eng, 2, 3, U.tech), Forbidden);
  assert.throws(() => parts.setStock(eng, 2, -1, U.mgr), /whole number/);
  parts.setStock(eng, 2, 3, U.mgr);
  assert.equal(parts.forIssueType(db, 'jam')[0].warning, null);
  assert.equal(parts.list(db).find((p) => p.id === 2).level, 'ok');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'set_part_stock'").get().n, 1);
});
test('shift handover lists what happened, what is open and what to watch', () => {
  const { db, eng, run } = rig();
  let h = parts.handover(db, eng.now());
  assert.equal(h.shift, 'Day shift (08:00 to 20:00)'); assert.deepEqual(h.happened, ['No issues this shift.']);
  assert.ok(h.watch.some((w) => /Exit belt is out of stock/.test(w)));
  run(30); eng.injectFault('jam', U.op); run(20);
  h = parts.handover(db, eng.now());
  assert.equal(h.counts.issues, 1); assert.equal(h.counts.open, 1); assert.equal(h.counts.work_orders_open, 1);
  assert.match(h.happened[0], /Exit belt jammed \(critical\): still open/);
  assert.ok(h.watch.some((w) => /Open issue: Exit belt jammed, not yet acknowledged/.test(w)));
  assert.ok(h.watch.some((w) => /1 machine action is waiting for manager approval/.test(w)));
  assert.ok(h.watch.some((w) => /Work order 1 .* is created, not assigned/.test(w)));
  eng.resolve(eng.active.id, U.tech, { note: 'Cleared' });
  h = parts.handover(db, eng.now());
  assert.equal(h.counts.open, 0); assert.match(h.happened[0], /fixed by Giorgi/); assert.ok(h.counts.loss > 0);
});
