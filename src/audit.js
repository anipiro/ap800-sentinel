// Audit trail for the manager: who signed in, who changed what, who approved, rejected or overrode what,
// and what the system did by itself. Read-only view over the existing append-only records (audit_log and events).
const CATEGORIES = {
  login: 'Sign-in',
  setting: 'Setting change',
  approval: 'Approval',
  rejection: 'Rejection',
  override: 'Override',
  automated: 'Automated action',
};
// which history event types fall into which audit category
const EVENT_CATEGORY = {
  config_changed: 'setting', action_approved: 'approval', action_rejected: 'rejection', action_reverted: 'override',
  unusual_verdict: 'override', action_auto: 'automated', reclassified: 'automated', work_order_created: 'automated', work_order_verified: 'approval',
};

function entries(db, { category = '', q = '', from = null, to = null, limit = 500 } = {}) {
  const rows = [];
  for (const a of db.prepare("SELECT a.id, a.ts, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.action = 'login'").all())
    rows.push({ ts: a.ts, category: 'login', who: a.name || 'unknown', what: `${a.name || 'Someone'} signed in`, issue_id: null, source: 'audit_log:' + a.id });
  const types = Object.keys(EVENT_CATEGORY);
  for (const e of db.prepare(`SELECT id, ts, type, actor_type, actor, issue_id, summary FROM events WHERE type IN (${types.map(() => '?').join(',')})`).all(...types))
    rows.push({ ts: e.ts, category: EVENT_CATEGORY[e.type], who: e.actor_type === 'user' ? e.actor : `${e.actor} (${e.actor_type})`, what: e.summary, issue_id: e.issue_id, source: 'events:' + e.id });
  const needle = String(q || '').trim().toLowerCase();
  return rows
    .filter((r) => (!category || r.category === category) && (!from || r.ts >= Number(from)) && (!to || r.ts <= Number(to)) && (!needle || r.who.toLowerCase().includes(needle) || r.what.toLowerCase().includes(needle)))
    .sort((a, b) => b.ts - a.ts || (a.source < b.source ? 1 : -1))
    .slice(0, Math.min(Number(limit) || 500, 5000))
    .map((r) => ({ ...r, category_label: CATEGORIES[r.category] }));
}

function counts(db) {
  const out = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  for (const r of entries(db, { limit: 5000 })) out[r.category]++;
  return out;
}

module.exports = { entries, counts, CATEGORIES };
