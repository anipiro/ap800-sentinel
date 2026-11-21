// Spare parts stock and the shift handover summary. Read-mostly helpers on top of the existing records.
const { TYPES } = require('./catalog');

const level = (p, need = 1) => (p.stock < need ? 'out' : p.stock <= p.min_stock ? 'low' : 'ok');

function list(db) {
  const links = db.prepare('SELECT * FROM part_links').all();
  return db.prepare('SELECT * FROM parts ORDER BY id').all().map((p) => ({ ...p, level: level(p), used_for: links.filter((l) => l.part_id === p.id).map((l) => (TYPES[l.issue_type] || TYPES.unknown).label) }));
}

// Parts a repair of this issue type needs, with a plain warning when stock is short.
function forIssueType(db, type) {
  return db.prepare('SELECT p.*, l.qty FROM part_links l JOIN parts p ON p.id = l.part_id WHERE l.issue_type = ?').all(type).map((p) => {
    const lv = level(p, p.qty);
    const warning = lv === 'out' ? `${p.name}: none in stock, ${p.qty} needed. Order now: delivery takes ${p.lead_time_days} days, and the repair cannot be finished until it arrives.`
      : lv === 'low' ? `${p.name}: ${p.stock} in stock, which is the minimum. Reorder now: delivery takes ${p.lead_time_days} days.` : null;
    return { id: p.id, name: p.name, stock: p.stock, min_stock: p.min_stock, qty: p.qty, lead_time_days: p.lead_time_days, level: lv, warning };
  });
}

function setStock(eng, id, stock, user) {
  eng.need(user, 'manager');
  const n = Number(stock), p = eng.db.prepare('SELECT * FROM parts WHERE id = ?').get(id);
  if (!p || !Number.isInteger(n) || n < 0 || n > 100000) throw Object.assign(new Error('Stock must be a whole number of zero or more'), { status: 400 });
  eng.db.prepare('UPDATE parts SET stock = ? WHERE id = ?').run(n, id);
  eng.event('config_changed', 'user', user.name, `${user.name} set the stock of "${p.name}" from ${p.stock} to ${n}`);
  eng.audit(user, 'set_part_stock', { part: p.name, from: p.stock, to: n });
}

// What happened this shift, what is still open, and what the next shift should watch.
function handover(db, now = Date.now()) {
  const d = new Date(now), h = d.getHours(), day = h >= 8 && h < 20;
  const start = new Date(now); start.setHours(day ? 8 : 20, 0, 0, 0); if (!day && h < 8) start.setDate(start.getDate() - 1);
  const since = start.getTime(), cur = db.prepare('SELECT currency FROM cost_params WHERE machine_id = 1').get().currency;
  const title = (i) => i.title || (TYPES[i.type] || TYPES.unknown).title;
  const issues = db.prepare('SELECT * FROM issues WHERE detected_at >= ? ORDER BY id').all(since);
  const open = db.prepare("SELECT * FROM issues WHERE status IN ('detected','acknowledged') ORDER BY id").all();
  const orders = db.prepare("SELECT w.*, u.name AS assignee FROM work_orders w LEFT JOIN users u ON u.id = w.assigned_to WHERE w.status NOT IN ('completed','verified') ORDER BY w.window_start").all();
  const approvals = db.prepare("SELECT COUNT(*) n FROM actions WHERE status = 'pending_approval'").get().n;
  const flags = db.prepare("SELECT * FROM unusual_flags WHERE verdict IS NULL OR verdict = 'investigate' ORDER BY id").all();
  const short = list(db).filter((p) => p.level !== 'ok');
  const loss = issues.reduce((s, i) => s + i.actual_loss, 0), down = issues.reduce((s, i) => s + i.downtime_h, 0);
  const happened = issues.length ? issues.map((i) => `${title(i)} (${i.severity}): ${i.resolved_at ? (i.resolved_by === 'system' ? 'cleared by itself' : `fixed by ${i.resolved_by}`) : 'still open'}.`) : ['No issues this shift.'];
  const watch = [];
  for (const i of open) watch.push(`Open issue: ${title(i)}${i.acked_at ? '' : ', not yet acknowledged'}.`);
  if (approvals) watch.push(`${approvals} machine action${approvals === 1 ? ' is' : 's are'} waiting for manager approval.`);
  for (const o of orders) watch.push(`Work order ${o.id} (${o.title}) is ${o.status.replace('_', ' ')}${o.assignee ? `, with ${o.assignee}` : ', not assigned'}; suggested window starts ${new Date(o.window_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
  for (const f of flags) watch.push(`Unusual activity still open: ${f.title}.`);
  for (const p of short) watch.push(`${p.name} is ${p.level === 'out' ? 'out of stock' : 'at minimum stock'} (delivery ${p.lead_time_days} days).`);
  if (!watch.length) watch.push('Nothing is open. The line is running normally.');
  return { shift: day ? 'Day shift (08:00 to 20:00)' : 'Night shift (20:00 to 08:00)', since, generated_at: now, currency: cur,
    counts: { issues: issues.length, open: open.length, work_orders_open: orders.length, flags_open: flags.length, loss: Math.round(loss), downtime_min: Math.round(down * 60) }, happened, watch };
}

module.exports = { list, forIssueType, setStock, handover, level };
