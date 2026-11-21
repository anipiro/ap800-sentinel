// Integrations: a read-only REST API for other systems, and a webhook that posts new issues to a URL.
// The API token comes from the API_TOKEN environment variable; without it the API is switched off.
const crypto = require('crypto');
const reports = require('./reports');
const kpi = require('./kpi');
const { TYPES } = require('./catalog');

const ENDPOINTS = ['/api/v1/issues', '/api/v1/losses', '/api/v1/kpis?period=1h|24h|7d'];

function tokenOk(header, token) {
  const given = /^Bearer (.+)$/.exec(header || '');
  if (!given) return false;
  const a = Buffer.from(given[1]), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns { status, body } for /api/v1 paths, or null if the path is not part of the API. GET only: nothing here writes.
function handle({ method, path, query = {}, authorization, token = process.env.API_TOKEN }, db, { timeScale = 60, target = 495, now = Date.now() } = {}) {
  if (!path.startsWith('/api/v1/')) return null;
  if (!token) return { status: 503, body: { error: 'The API is switched off. Set the API_TOKEN environment variable and restart the server.' } };
  if (!tokenOk(authorization, token)) return { status: 401, body: { error: 'Send the token as "Authorization: Bearer <token>".' } };
  if (method !== 'GET') return { status: 405, body: { error: 'This API is read-only.' } };
  if (path === '/api/v1/issues') {
    const limit = Math.max(1, Math.min(Number(query.limit) || 100, 1000));
    const rows = reports.issues(db, { limit }).map((i) => ({ id: i.id, type: i.type, title: i.title, severity: i.severity, status: i.status, confidence: i.confidence,
      detected_at: new Date(i.detected_at).toISOString(), acknowledged_at: i.acked_at ? new Date(i.acked_at).toISOString() : null, resolved_at: i.resolved_at ? new Date(i.resolved_at).toISOString() : null,
      downtime_hours: i.downtime_h, actual_loss: i.actual_loss, projected_loss: i.projected_loss, savings: i.savings }));
    return { status: 200, body: { machine: 'Dumpling line 1', count: rows.length, issues: rows } };
  }
  if (path === '/api/v1/losses') {
    const f = reports.finance(db);
    return { status: 200, body: { currency: f.currency, placeholder_costs: true, totals: f.totals, by_issue_type: f.byType.map((r) => ({ type: r.type, label: r.label, issues: r.n, loss: r.loss, savings: r.savings, downtime_hours: r.downtime })), by_day: f.byDay } };
  }
  if (path === '/api/v1/kpis') return { status: 200, body: kpi.kpis(db, { period: query.period, now, timeScale, target }) };
  return { status: 404, body: { error: 'Unknown endpoint.', endpoints: ENDPOINTS } };
}

// ---- webhook -----------------------------------------------------------------------
const webhookUrl = (db) => db.prepare("SELECT value FROM settings WHERE key = 'webhook_url'").get().value;

function setWebhook(eng, url, user) {
  eng.need(user, 'manager');
  const u = String(url || '').trim();
  if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw Object.assign(new Error('The webhook address must start with http:// or https://'), { status: 400 });
  if (u.length > 500) throw Object.assign(new Error('That address is too long'), { status: 400 });
  eng.db.prepare("UPDATE settings SET value = ? WHERE key = 'webhook_url'").run(u);
  eng.event('config_changed', 'user', user.name, u ? `${user.name} set the new-issue webhook to ${u}` : `${user.name} switched the new-issue webhook off`);
  eng.audit(user, 'set_webhook', { url: u });
}

// Posts a new issue to the configured URL. fetchImpl is injectable so tests never touch the network.
async function notifyIssue(db, issueId, { fetchImpl = fetch, now = Date.now() } = {}) {
  const url = webhookUrl(db);
  if (!url) return null;
  const i = db.prepare('SELECT id, type, title, severity, confidence, detected_at, is_simulated FROM issues WHERE id = ?').get(issueId);
  if (!i || i.is_simulated) return null;
  const payload = { event: 'issue.created', machine: 'Dumpling line 1', issue: { id: i.id, type: i.type, title: i.title || (TYPES[i.type] || TYPES.unknown).title, severity: i.severity, confidence: i.confidence, detected_at: new Date(i.detected_at).toISOString() } };
  let status;
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ap800-sentinel' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    status = res.ok ? `delivered (${res.status})` : `refused (${res.status})`;
  } catch (e) { status = 'failed: ' + String(e.message || e).slice(0, 80); }
  db.prepare('INSERT INTO webhook_log (ts, issue_id, url, status) VALUES (?,?,?,?)').run(now, i.id, url, status);
  return { payload, status };
}

const deliveries = (db) => db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 8').all();

module.exports = { handle, setWebhook, notifyIssue, webhookUrl, deliveries, ENDPOINTS };
