// Read-only queries: history, issue detail, finance, summary, machine profile, CSV.
const { TYPES, ACTIONS } = require('./catalog');
const loss = require('./loss');

const MODULE_COST = 20000;   // placeholder: assumed one-off cost of the monitoring kit, used only for the ROI line
const r2 = loss.round2;
const typeOf = (t) => TYPES[t] || TYPES.unknown;

function history(db, { type, issue, q, from, to, actor, limit = 300 } = {}) {
  const where = ['machine_id = 1'], args = [];
  if (type) { where.push('type = ?'); args.push(type); }
  if (issue) { where.push('issue_id = ?'); args.push(Number(issue)); }
  if (actor) { where.push('actor_type = ?'); args.push(actor); }
  if (from) { where.push('ts >= ?'); args.push(Number(from)); }
  if (to) { where.push('ts <= ?'); args.push(Number(to)); }
  if (q) { where.push('(summary LIKE ? OR actor LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  return db.prepare(`SELECT id, ts, type, actor_type, actor, issue_id, summary, is_simulated FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 300, 2000));
}

function issues(db, { limit = 100 } = {}) {
  return db.prepare('SELECT id, type, severity, status, confidence, detected_at, acked_at, resolved_at, resolved_by, actual_loss, projected_loss, savings, downtime_h FROM issues ORDER BY id DESC LIMIT ?').all(limit)
    .map((i) => ({ ...i, label: typeOf(i.type).label, title: typeOf(i.type).title }));
}

function issueDetail(db, id) {
  const i = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!i) return null;
  const T = typeOf(i.type), end = i.resolved_at || Date.now();
  const steps = [['Detected', i.detected_at], ['Notified', i.notified_at], ['Acknowledged', i.acked_at], ['Action taken', i.action_at], ['Resolved', i.resolved_at], ['Verified', i.verified_at]]
    .map(([name, at]) => ({ name, at }));
  return {
    ...i, explanation: JSON.parse(i.explanation || '{}'), label: T.label, category: T.category, title: T.title, cause: T.cause, check: T.check, recommended: T.action,
    steps,
    events: db.prepare('SELECT ts, type, actor_type, actor, summary FROM events WHERE issue_id = ? ORDER BY id').all(id),
    actions: db.prepare('SELECT a.*, u.name AS decided_name FROM actions a LEFT JOIN users u ON u.id = a.decided_by WHERE a.issue_id = ? ORDER BY a.id').all(id).map((a) => ({ ...a, label: ACTIONS[a.kind].label, reversible: ACTIONS[a.kind].reversible })),
    notifications: db.prepare('SELECT n.*, u.name FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.issue_id = ? ORDER BY n.id').all(id),
    readings: db.prepare('SELECT ts, data, anomaly FROM readings WHERE machine_id = 1 AND ts BETWEEN ? AND ? ORDER BY ts').all(i.detected_at - 45000, end + 20000).map((r) => ({ ts: r.ts, a: r.anomaly, v: JSON.parse(r.data) })),
  };
}

function finance(db) {
  const c = db.prepare('SELECT * FROM cost_params WHERE machine_id = 1').get();
  const tot = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(actual_loss),0) loss, COALESCE(SUM(savings),0) savings, COALESCE(SUM(downtime_h),0) downtime FROM issues').get();
  const open = db.prepare("SELECT COALESCE(SUM(projected_loss),0) p FROM issues WHERE status IN ('detected','acknowledged')").get();
  const byType = db.prepare('SELECT type, COUNT(*) n, SUM(actual_loss) loss, SUM(savings) savings, SUM(downtime_h) downtime FROM issues GROUP BY type ORDER BY loss DESC').all()
    .map((r) => ({ ...r, label: typeOf(r.type).label, component: typeOf(r.type).comp[0] || '', loss: r2(r.loss), savings: r2(r.savings), downtime: r2(r.downtime) }));
  const byDay = db.prepare("SELECT date(detected_at / 1000, 'unixepoch', 'localtime') day, COUNT(*) n, SUM(actual_loss) loss, SUM(savings) savings FROM issues GROUP BY day ORDER BY day DESC LIMIT 31").all()
    .map((r) => ({ ...r, loss: r2(r.loss), savings: r2(r.savings) }));
  const failureCosts = Object.entries(TYPES).filter(([k]) => k !== 'unknown').map(([k, T]) => ({ type: k, label: T.label, fail_prob: T.failProb,
    failure_cost: loss.eventCost(T.failure, c), preventive_cost: loss.eventCost(T.preventive, c), saving: loss.savingsFromEarlyDetection(T.failure, T.preventive, c) }));
  return { currency: c.currency, costs: c, placeholder: true,
    totals: { issues: tot.n, loss: r2(tot.loss), savings: r2(tot.savings), downtime_h: r2(tot.downtime), projected_open: r2(open.p) },
    roi: { module_cost: MODULE_COST, savings: r2(tot.savings), ratio: loss.roi(tot.savings, MODULE_COST), net: r2(tot.savings - tot.loss) },
    byType, byDay, failureCosts };
}

function summary(db, health) {
  const since = Date.now() - 24 * 3600 * 1000;
  const g = (sql, ...a) => db.prepare(sql).get(...a);
  const iss = g('SELECT COUNT(*) n, COALESCE(SUM(actual_loss),0) loss, COALESCE(SUM(savings),0) savings FROM issues WHERE detected_at >= ?', since);
  const active = g("SELECT COUNT(*) n FROM issues WHERE status IN ('detected','acknowledged')").n;
  const resolvedSystem = g("SELECT COUNT(*) n FROM issues WHERE detected_at >= ? AND resolved_by = 'system'", since).n;
  const resolvedPeople = g("SELECT COUNT(*) n FROM issues WHERE detected_at >= ? AND resolved_at IS NOT NULL AND resolved_by <> 'system'", since).n;
  const act = g("SELECT SUM(decided_by IS NULL AND status = 'done') auto, SUM(decided_by IS NOT NULL AND status IN ('done','reverted')) approved, SUM(status = 'rejected') rejected FROM actions WHERE created_at >= ?", since);
  const resp = g('SELECT AVG(acked_at - detected_at) ack, AVG(resolved_at - detected_at) fix FROM issues WHERE detected_at >= ?', since);
  const esc = g("SELECT COUNT(*) n FROM events WHERE type = 'escalated' AND ts >= ?", since).n;
  const cur = g('SELECT currency FROM cost_params WHERE machine_id = 1').currency;
  const insights = db.prepare('SELECT type, COUNT(*) n, SUM(actual_loss) loss FROM issues WHERE detected_at >= ? GROUP BY type ORDER BY loss DESC', since).all()
    .map((r) => `${typeOf(r.type).label} happened ${r.n} time${r.n === 1 ? '' : 's'} in the last 24 hours; estimated loss ${Math.round(r.loss).toLocaleString('en')} ${cur}; recommended: ${typeOf(r.type).action.replace(/\.$/, '').toLowerCase()}.`);
  if (esc) insights.push(`${esc} alert${esc === 1 ? ' was' : 's were'} escalated because nobody acknowledged in time. Check who is on duty for this machine.`);
  if (!insights.length) insights.push('No issues in the last 24 hours.');
  return { period: 'last 24 hours', currency: cur, health, active, issues: iss.n, loss: r2(iss.loss), savings: r2(iss.savings),
    resolved_by_people: resolvedPeople, cleared_by_itself: resolvedSystem, actions_auto: act.auto || 0, actions_approved: act.approved || 0, actions_rejected: act.rejected || 0,
    avg_ack_ms: resp.ack, avg_fix_ms: resp.fix, escalations: esc, insights };
}

function profile(db, timeScale) {
  const m = db.prepare('SELECT * FROM machines WHERE id = 1').get();
  const run = db.prepare("SELECT COUNT(*) n FROM readings WHERE machine_id = 1 AND CAST(json_extract(data, '$.rate') AS REAL) > 100").get().n;   // one row per second
  const runtime_h = (run * timeScale) / 3600;
  const t = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(actual_loss),0) loss, COALESCE(SUM(downtime_h),0) down FROM issues').get();
  const top = db.prepare('SELECT type, COUNT(*) n FROM issues GROUP BY type ORDER BY n DESC LIMIT 3').all().map((r) => `${typeOf(r.type).label} (${r.n})`);
  return { name: m.name, model: m.model, installed_at: m.installed_at, runtime_h: r2(runtime_h), failures: t.n, mtbf_h: t.n ? r2(runtime_h / t.n) : null, total_loss: r2(t.loss), downtime_h: r2(t.down), top_types: top };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

module.exports = { history, issues, issueDetail, finance, summary, profile, toCsv, MODULE_COST };
