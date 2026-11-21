// Work orders: created by remediation actions, moved through a lifecycle by people,
// each with a suggested repair window that avoids peak production and comes before the predicted failure.
const { TYPES } = require('./catalog');

const KINDS = ['create_work_order', 'sensor_work_order', 'inspection_work_order', 'schedule_maintenance'];
const PEAK = [[10, 14], [18, 21]];                      // placeholder peak production hours
const HORIZON_H = { critical: 2, high: 8, medium: 24, low: 72 };   // how long each severity can wait if no failure time is predicted
const NEXT = { created: 'assigned', assigned: 'in_progress', in_progress: 'completed', completed: 'verified' };
const HALF = 30 * 60 * 1000;

const inPeak = (ms) => { const h = new Date(ms).getHours() + new Date(ms).getMinutes() / 60; return PEAK.some(([a, b]) => h >= a && h < b); };
const slotInPeak = (start, durationH) => { for (let t = start; t < start + durationH * 3600000; t += HALF) if (inPeak(t)) return true; return false; };

// Earliest half-hour slot of the given length that avoids peak production and ends before the deadline.
// If no such slot exists the repair cannot wait: the first slot is returned and marked as inside peak.
function suggestWindow(nowMs, durationH, deadlineMs = null) {
  const first = Math.ceil(nowMs / HALF) * HALF, len = durationH * 3600000;
  for (let t = first; t < first + 7 * 24 * 3600000; t += HALF) {
    if (deadlineMs !== null && t + len > deadlineMs) break;
    if (!slotInPeak(t, durationH)) return { start: t, end: t + len, inPeak: false, reason: deadlineMs !== null ? 'Earliest window outside peak production and before the predicted failure.' : 'Earliest window outside peak production.' };
  }
  const peak = slotInPeak(first, durationH);
  return { start: first, end: first + len, inPeak: peak, reason: peak ? 'Failure is predicted before the next quiet period, so the repair cannot wait for one. This window is inside peak production.' : 'Failure is predicted soon, so the first available window is used.' };
}

// Called when a remediation action runs. Creates the matching work order, linked to the issue.
function onAction(eng, kind, issueId) {
  if (!KINDS.includes(kind)) return null;
  const db = eng.db, now = eng.now();
  if (db.prepare('SELECT 1 FROM work_orders WHERE issue_id = ? AND kind = ?').get(issueId, kind)) return null;
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
  const T = TYPES[issue.type] || TYPES.unknown;
  const durationH = Math.max(0.5, Math.ceil((T.preventive.repair_h + T.preventive.downtime_h) * 2) / 2);
  const rul = eng.active && eng.active.id === issueId && eng.active.rul !== null ? eng.active.rul / 60 : Infinity;      // predicted time to failure, hours
  const deadline = now + Math.min(HORIZON_H[issue.severity] || 24, rul) * 3600000;
  const w = suggestWindow(now, durationH, deadline);
  const title = `${{ create_work_order: 'Repair', sensor_work_order: 'Check the sensor', inspection_work_order: 'Inspect the machine', schedule_maintenance: 'Planned maintenance' }[kind]}: ${issue.title || T.title}`;
  const id = Number(db.prepare('INSERT INTO work_orders (issue_id, machine_id, kind, title, duration_h, window_start, window_end, window_reason, in_peak, deadline, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(issueId, eng.machineId, kind, title, durationH, w.start, w.end, w.reason, w.inPeak ? 1 : 0, deadline, now).lastInsertRowid);
  eng.event('work_order_created', 'rule', 'remediation', `Work order ${id} created: ${title}`, { issueId, refTable: 'work_orders', refId: id });
  return id;
}

function move(eng, id, user, op, body = {}) {
  const db = eng.db, now = eng.now();
  const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!wo) throw bad('No such work order');
  const target = { assign: 'assigned', start: 'in_progress', complete: 'completed', verify: 'verified' }[op];
  if (!target) throw bad('Unknown step');
  eng.need(user, op === 'verify' ? 'manager' : 'technician');
  if (NEXT[wo.status] !== target) throw bad(`A work order that is "${wo.status.replace('_', ' ')}" cannot be moved to "${target.replace('_', ' ')}"`);
  if (op === 'assign') {
    const who = body.user_id && user.role === 'manager' ? db.prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('technician','manager')").get(Number(body.user_id)) : { id: user.id, name: user.name };
    if (!who) throw bad('That person cannot be assigned work orders');
    db.prepare("UPDATE work_orders SET status = 'assigned', assigned_to = ?, assigned_at = ? WHERE id = ?").run(who.id, now, id);
    eng.event('work_order_assigned', 'user', user.name, `Work order ${id} assigned to ${who.name}`, { issueId: wo.issue_id, refTable: 'work_orders', refId: id });
  } else {
    if (op !== 'verify' && wo.assigned_to !== user.id && user.role !== 'manager') throw bad('This work order is assigned to someone else');
    if (op === 'start') db.prepare("UPDATE work_orders SET status = 'in_progress', started_at = ? WHERE id = ?").run(now, id);
    if (op === 'complete') db.prepare("UPDATE work_orders SET status = 'completed', completed_at = ?, notes = ? WHERE id = ?").run(now, String(body.notes || '').slice(0, 300) || null, id);
    if (op === 'verify') db.prepare("UPDATE work_orders SET status = 'verified', verified_at = ?, verified_by = ? WHERE id = ?").run(now, user.id, id);
    const word = { start: 'started', complete: 'completed', verify: 'verified' }[op];
    eng.event('work_order_' + word, 'user', user.name, `Work order ${id} ${word} by ${user.name}`, { issueId: wo.issue_id, refTable: 'work_orders', refId: id });
  }
}

function list(db, { userId = null } = {}) {
  const rows = db.prepare('SELECT w.*, u.name AS assignee, i.severity, i.status AS issue_status FROM work_orders w LEFT JOIN users u ON u.id = w.assigned_to LEFT JOIN issues i ON i.id = w.issue_id ORDER BY w.id DESC LIMIT 200').all();
  return userId ? rows.filter((r) => r.assigned_to === userId) : rows;
}

module.exports = { suggestWindow, onAction, move, list, PEAK, KINDS, HORIZON_H };
