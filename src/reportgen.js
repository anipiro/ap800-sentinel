// Daily and weekly reports: one object built from the app's own records, rendered as a self-contained HTML file.
// "Sending" goes to a mock notifier: the send is recorded, nothing leaves the machine.
const { TYPES } = require('./catalog');
const { MockNotifier } = require('./adapters');
const kpi = require('./kpi');
const risk = require('./risk');
const parts = require('./parts');

const PERIODS = { daily: { ms: 24 * 3600000, kpi: '24h', label: 'Daily report', span: 'last 24 hours' }, weekly: { ms: 7 * 24 * 3600000, kpi: '7d', label: 'Weekly report', span: 'last 7 days' } };
const mock = new MockNotifier('report');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (x, cur) => Math.round(x || 0).toLocaleString('en') + ' ' + cur;

function build(db, { period = 'daily', now = Date.now(), model, health = null, timeScale = 60, target = 495, assumptions = null }) {
  const P = PERIODS[period] || PERIODS.daily, key = PERIODS[period] ? period : 'daily', since = now - P.ms;
  const cur = db.prepare('SELECT currency FROM cost_params WHERE machine_id = 1').get().currency;
  const issues = db.prepare('SELECT id, type, title, severity, status, detected_at, resolved_at, resolved_by, downtime_h, actual_loss, savings FROM issues WHERE detected_at >= ? ORDER BY id').all(since)
    .map((i) => ({ ...i, title: i.title || (TYPES[i.type] || TYPES.unknown).title }));
  const sum = (f) => issues.reduce((s, i) => s + (i[f] || 0), 0);
  const projection = risk.project(db, model, { runs: 800, assumptions });
  const horizon = projection.horizons.find((h) => h.days === (key === 'daily' ? 7 : 30));
  return {
    period: key, label: P.label, span: P.span, from: since, to: now, generated_at: now, currency: cur, machine: db.prepare('SELECT name, model FROM machines WHERE id = 1').get(),
    health, kpis: kpi.kpis(db, { period: P.kpi, now, timeScale, target }),
    issues, totals: { issues: issues.length, open: issues.filter((i) => !i.resolved_at).length, downtime_min: Math.round(sum('downtime_h') * 60), loss: Math.round(sum('actual_loss')), savings: Math.round(sum('savings')) },
    top_risks: projection.ranking.slice(0, 3).map((r) => ({ label: r.label, chance_30d: r.p_event_30d, expected_loss_30d: r.expected_loss_30d, cost_if_missed: r.cost_if_missed })),
    outlook: { days: horizon.days, expected_loss: horizon.expected_loss, p5: horizon.p5, p95: horizon.p95 },
    open_work_orders: db.prepare("SELECT COUNT(*) n FROM work_orders WHERE status NOT IN ('completed','verified')").get().n,
    parts_short: parts.list(db).filter((p) => p.level !== 'ok').map((p) => ({ name: p.name, level: p.level, lead_time_days: p.lead_time_days })),
  };
}

function toHtml(r) {
  const pc = (x) => (x === null ? 'n/a' : (x * 100).toFixed(1) + ' %'), d = (ms) => new Date(ms).toLocaleString('en-GB');
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.label)}: ${esc(r.machine.name)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#16202b;line-height:1.45}h1{margin-bottom:0}h2{margin-top:28px;border-bottom:2px solid #16202b;padding-bottom:4px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 10px;border-bottom:1px solid #c7cfd8}th{font-size:.85em;color:#55626e}.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.kv b{display:block;font-size:1.4em}.note{color:#55626e;font-size:.9em}</style></head><body>
<h1>${esc(r.label)}</h1><p class="note">${esc(r.machine.name)}, ${esc(r.machine.model)}. Covers the ${esc(r.span)}: ${d(r.from)} to ${d(r.to)}.</p>
<h2>Health and key figures</h2><div class="kv"><div>Line health now<b>${r.health === null ? 'n/a' : r.health + ' / 100'}</b></div><div>OEE<b>${pc(r.kpis.oee)}</b></div><div>Availability<b>${pc(r.kpis.availability)}</b></div><div>Unplanned stops<b>${r.kpis.unplanned_stops}</b></div><div>Downtime<b>${r.totals.downtime_min} min</b></div><div>Losses<b>${money(r.totals.loss, r.currency)}</b></div><div>Saved by early detection<b>${money(r.totals.savings, r.currency)}</b></div><div>Issues, still open<b>${r.totals.issues}, ${r.totals.open}</b></div></div>
<h2>Issues</h2><table><tr><th>No.</th><th>Detected</th><th>Issue</th><th>Severity</th><th>Outcome</th><th>Downtime</th><th>Loss</th></tr>
${r.issues.map((i) => row([i.id, d(i.detected_at), esc(i.title), i.severity, i.resolved_at ? (i.resolved_by === 'system' ? 'cleared by itself' : 'fixed by ' + esc(i.resolved_by)) : 'open', Math.round(i.downtime_h * 60) + ' min', money(i.actual_loss, r.currency)])).join('') || row(['', '', 'No issues in this period.', '', '', '', ''])}</table>
<h2>Top risks, next 30 days</h2><table><tr><th>Risk</th><th>Chance of at least one</th><th>Expected loss</th><th>Cost if missed</th></tr>
${r.top_risks.map((t) => row([esc(t.label), Math.round(t.chance_30d * 100) + ' %', money(t.expected_loss_30d, r.currency), money(t.cost_if_missed, r.currency)])).join('')}</table>
<p>Expected loss over the next ${r.outlook.days} days: ${money(r.outlook.expected_loss, r.currency)} (likely range ${money(r.outlook.p5, r.currency)} to ${money(r.outlook.p95, r.currency)}).</p>
<h2>To follow up</h2><ul><li>${r.open_work_orders} work order${r.open_work_orders === 1 ? '' : 's'} open.</li>${r.parts_short.map((p) => `<li>${esc(p.name)}: ${p.level === 'out' ? 'out of stock' : 'at minimum stock'}, delivery ${p.lead_time_days} days.</li>`).join('')}</ul>
<p class="note">Machine signals are simulated and times use the demo clock. Costs, stock and risk rates are placeholder assumptions. Generated ${d(r.generated_at)}.</p></body></html>`;
}

// Record a send through the mock notifier. Recipients are the managers.
function send(eng, report, byName) {
  const people = eng.db.prepare("SELECT name FROM users WHERE role = 'manager'").all().map((u) => u.name);
  mock.send({ users: people, period: report.period, subject: `${report.label}: ${report.machine.name}`, html: toHtml(report) });
  const id = Number(eng.db.prepare('INSERT INTO report_sends (ts, period, recipients, channel, status, by_name) VALUES (?,?,?,?,?,?)').run(eng.now(), report.period, people.join(', '), 'mock', 'recorded by the mock notifier, not sent', byName).lastInsertRowid);
  eng.event('report_sent', byName === 'schedule' ? 'system' : 'user', byName, `${report.label} handed to the mock notifier for ${people.join(', ')} (recorded, not sent)`, { refTable: 'report_sends', refId: id });
  return id;
}

// Called once a minute: daily report at 08:00, weekly report on Mondays at 08:00. Each goes out once.
function runSchedule(eng, makeReport) {
  const now = eng.now(), d = new Date(now), out = [];
  if (d.getHours() !== 8) return out;
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const due = ['daily', ...(d.getDay() === 1 ? ['weekly'] : [])];
  for (const period of due) {
    if (eng.db.prepare("SELECT 1 FROM report_sends WHERE period = ? AND by_name = 'schedule' AND ts >= ?").get(period, dayStart.getTime())) continue;
    send(eng, makeReport(period), 'schedule'); out.push(period);
  }
  return out;
}

const sends = (db) => db.prepare('SELECT * FROM report_sends ORDER BY id DESC LIMIT 10').all();

module.exports = { build, toHtml, send, runSchedule, sends, mock, PERIODS };
