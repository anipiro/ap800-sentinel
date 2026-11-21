// "Ask the data": answers a fixed set of question types from the app's own records. No AI service, no free-form
// understanding: each question is matched against patterns, and anything else gets the list of what is supported.
// Read-only. Every answer links to the records it came from.
const { TYPES, STATION_OF } = require('./catalog');
const kpi = require('./kpi');
const risk = require('./risk');
const parts = require('./parts');

const STATION_NAME = { hopper: 'Dough hopper', r12: 'Rollers, stages 1–2', r3: 'Two 3-roller groups', cal: 'Calibrating rollers', drum: 'Forming drums', belt: 'Exit belt', pump: 'Filling pump' };
const SUPPORTED = [
  'Which machine cost the most this week?',
  'Why did the last issue happen?',
  'What should we fix first?',
  'How many unplanned stops today?',
  'What is the OEE this week?',
  'How much did we lose and save today?',
  'What is open right now?',
  'Which work orders are open?',
  'Which spare parts are low?',
  'How fast did we respond this week?',
  'Who was alerted for the last issue?',
  'What happened this shift?',
  'What are the biggest risks?',
];
const money = (x, cur) => Math.round(x || 0).toLocaleString('en') + ' ' + cur;
const title = (i) => i.title || (TYPES[i.type] || TYPES.unknown).title;
const mins = (ms) => (ms === null || ms === undefined ? null : Math.round(ms / 1000));          // demo clock: 1 s = 1 min

function period(q) {
  if (/\bhour\b/.test(q)) return { key: '1h', ms: 3600000, words: 'in the last hour' };
  if (/week|7 days|seven days/.test(q)) return { key: '7d', ms: 7 * 24 * 3600000, words: 'in the last 7 days' };
  return { key: '24h', ms: 24 * 3600000, words: 'in the last 24 hours' };
}

const INTENTS = [
  ['why_last', /\bwhy\b/],
  ['alerted', /\bwho\b.*(alert|notif|called|told)|(alert|notif).*\bwho\b/],
  ['stops', /(how many|number of|count).*(stop)|unplanned stop/],
  ['oee', /\boee\b|availability|\bperformance\b|\bquality\b|\bmtbf\b|\bmttr\b/],
  ['parts', /spare|\bparts?\b|\bstock\b|reorder/],
  ['work_orders', /work order|maintenance (plan|calendar|window)/],
  ['response', /how (fast|quick|long)|respon|acknowledg|react/],
  ['shift', /shift|handover|hand over/],
  ['risk', /risk|likely|predict|forecast|could go wrong/],
  ['cost_most', /(cost|expensive|lost|lose|loss).*\bmost\b|\bmost\b.*(cost|expensive|loss)|(which|what).*(machine|station|problem).*(cost|expensive)/],
  ['money', /how much|total (loss|cost|saving)|\b(lose|lost|loss|losses|saved?|savings?)\b/],
  ['fix_first', /fix|priorit|what should we|what (do|to) (we )?do|first/],
  ['open', /open|active|current|right now|status|what is (wrong|happening)|any (issue|problem|fault)/],
];

function ask(db, question, { model, status = null, canMoney = false, now = Date.now(), timeScale = 60, target = 495, assumptions = null } = {}) {
  const q = String(question || '').toLowerCase().trim().slice(0, 300);
  const found = INTENTS.find(([, re]) => re.test(q));
  const P = period(q), since = now - P.ms;
  const cur = db.prepare('SELECT currency FROM cost_params WHERE machine_id = 1').get().currency;
  const out = (intent, answer, links = [], extra = {}) => ({ understood: true, intent, question: String(question || '').trim(), answer, links, supported: SUPPORTED, ...extra });
  if (!q || !found) return { understood: false, intent: null, question: String(question || '').trim(), answer: 'I can only answer the kinds of question listed below. Try one of them, or rephrase yours to match.', links: [], supported: SUPPORTED };
  const intent = found[0];
  const last = db.prepare('SELECT * FROM issues ORDER BY id DESC LIMIT 1').get();
  const noMoney = 'Money figures are only shown to the manager. Sign in as the manager to ask this.';

  if (intent === 'why_last') {
    if (!last) return out(intent, 'No issue has been recorded yet, so there is nothing to explain.');
    const ex = JSON.parse(last.explanation || '{}');
    const why = (ex.contributions || []).map((c) => c.text).join('; ');
    return out(intent, `The last issue was "${title(last)}" (${last.severity}), detected ${new Date(last.detected_at).toLocaleTimeString('en-GB')}. ${ex.summary || ''}${why ? ` The readings behind it: ${why}.` : ''}${last.resolution ? ` Outcome: ${last.resolution}.` : ' It is still open.'}`, [{ label: `Issue ${last.id}`, href: `#issue-${last.id}` }]);
  }
  if (intent === 'alerted') {
    if (!last) return out(intent, 'No issue has been recorded yet, so nobody has been alerted.');
    const n = db.prepare('SELECT u.name, n.channel, n.level, n.status FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.issue_id = ? ORDER BY n.id').all(last.id);
    const people = [...new Set(n.map((x) => `${x.name} (level ${x.level})`))];
    return out(intent, n.length ? `For "${title(last)}": ${people.join(', ')}. ${last.acked_at ? `It was acknowledged after ${mins(last.acked_at - last.detected_at)} min.` : 'Nobody has acknowledged it.'}` : `Nobody was alerted for "${title(last)}".`, [{ label: `Issue ${last.id}`, href: `#issue-${last.id}` }]);
  }
  if (intent === 'stops' || intent === 'oee') {
    const k = kpi.kpis(db, { period: P.key, now, timeScale, target });
    const pc = (x) => (x === null ? 'not available' : (x * 100).toFixed(1) + ' %');
    if (intent === 'stops') return out(intent, `${k.unplanned_stops} unplanned stop${k.unplanned_stops === 1 ? '' : 's'} ${P.words}, with ${k.downtime_h} production hours of downtime out of ${k.recorded_h} recorded.`, [{ label: 'Key figures', href: '#summary' }]);
    return out(intent, `OEE ${P.words} is ${pc(k.oee)}: availability ${pc(k.availability)}, performance ${pc(k.performance)}, quality ${pc(k.quality)}. Mean time between faults ${k.mtbf_h === null ? 'not available' : k.mtbf_h + ' h'}, mean time to repair ${k.mttr_h === null ? 'not available' : k.mttr_h + ' h'}.`, [{ label: 'Key figures', href: '#summary' }]);
  }
  if (intent === 'parts') {
    const low = parts.list(db).filter((p) => p.level !== 'ok');
    return out(intent, low.length ? `${low.length} part${low.length === 1 ? ' is' : 's are'} short: ${low.map((p) => `${p.name} (${p.level === 'out' ? 'out of stock' : p.stock + ' left, at minimum'}, delivery ${p.lead_time_days} days)`).join('; ')}.` : 'Every spare part is above its minimum stock.', [{ label: 'Spare parts', href: '#work' }]);
  }
  if (intent === 'work_orders') {
    const wo = db.prepare("SELECT w.*, u.name AS assignee FROM work_orders w LEFT JOIN users u ON u.id = w.assigned_to WHERE w.status NOT IN ('completed','verified') ORDER BY w.window_start").all();
    return out(intent, wo.length ? `${wo.length} work order${wo.length === 1 ? ' is' : 's are'} open: ${wo.map((o) => `${o.id} "${o.title}" (${o.status.replace('_', ' ')}${o.assignee ? ', ' + o.assignee : ', not assigned'}, window from ${new Date(o.window_start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`).join('; ')}.` : 'No work orders are open.', [{ label: 'Work orders', href: '#work' }]);
  }
  if (intent === 'response') {
    const r = db.prepare("SELECT AVG(acked_at - detected_at) ack, AVG(CASE WHEN resolved_by <> 'system' THEN resolved_at - detected_at END) fix, COUNT(*) n, SUM(acked_at IS NOT NULL) acked FROM issues WHERE detected_at >= ?").get(since);
    const esc = db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'escalated' AND ts >= ?").get(since).n;
    if (!r.n) return out(intent, `No issues ${P.words}, so there is no response time to report.`, [{ label: 'Summary', href: '#summary' }]);
    return out(intent, `${r.n} issue${r.n === 1 ? '' : 's'} ${P.words}; ${r.acked || 0} acknowledged, on average after ${r.ack === null ? 'n/a' : mins(r.ack) + ' min'}. Average time to fix: ${r.fix === null ? 'n/a' : mins(r.fix) + ' min'}. ${esc} escalation${esc === 1 ? '' : 's'}. Times are on the demo clock.`, [{ label: 'Summary', href: '#summary' }]);
  }
  if (intent === 'shift') {
    const h = parts.handover(db, now);
    return out(intent, `${h.shift}: ${h.happened.join(' ')} To watch: ${h.watch.join(' ')}`, [{ label: 'Shift handover', href: '#summary' }]);
  }
  if (intent === 'risk') {
    const p = risk.project(db, model, { runs: 600, assumptions });
    const top = p.ranking.slice(0, 3);
    return out(intent, `Top risks for the next 30 days: ${top.map((t) => `${t.label} (${Math.round(t.p_event_30d * 100)} % chance${canMoney ? `, ${money(t.cost_if_missed, cur)} if missed` : ''})`).join('; ')}. These come from assumed event rates, not measured failure data.`, [{ label: 'Risk', href: '#risk' }]);
  }
  if (intent === 'cost_most') {
    if (!canMoney) return out(intent, noMoney);
    const rows = db.prepare('SELECT type, component, COUNT(*) n, SUM(actual_loss) loss FROM issues WHERE detected_at >= ? GROUP BY type ORDER BY loss DESC').all(since);
    if (!rows.length) return out(intent, `There is one machine, Dumpling line 1, and it had no issues ${P.words}, so nothing has cost anything.`, [{ label: 'Losses', href: '#money' }]);
    const t = rows[0], total = rows.reduce((s, r) => s + r.loss, 0), T = TYPES[t.type] || TYPES.unknown;
    const ids = db.prepare('SELECT id FROM issues WHERE detected_at >= ? AND type = ? ORDER BY id DESC LIMIT 3').all(since, t.type);
    return out(intent, `There is one machine, Dumpling line 1. It cost ${money(total, cur)} ${P.words}. The most expensive problem was ${T.label.toLowerCase()} at the ${(STATION_NAME[t.component] || 'line').toLowerCase()}: ${money(t.loss, cur)} across ${t.n} issue${t.n === 1 ? '' : 's'}.`, [{ label: 'Losses', href: '#money' }, ...ids.map((i) => ({ label: `Issue ${i.id}`, href: `#issue-${i.id}` }))]);
  }
  if (intent === 'money') {
    if (!canMoney) return out(intent, noMoney);
    const r = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(actual_loss),0) loss, COALESCE(SUM(savings),0) savings, COALESCE(SUM(downtime_h),0) down FROM issues WHERE detected_at >= ?').get(since);
    return out(intent, `${P.words.replace(/^in/, 'In')}: ${money(r.loss, cur)} lost across ${r.n} issue${r.n === 1 ? '' : 's'} (${Math.round(r.down * 60)} min of downtime), and ${money(r.savings, cur)} saved by catching problems early. Cost inputs are placeholders.`, [{ label: 'Losses', href: '#money' }]);
  }
  if (intent === 'fix_first') {
    const open = db.prepare("SELECT * FROM issues WHERE status IN ('detected','acknowledged') ORDER BY projected_loss DESC").all();
    if (open.length) { const i = open[0], T = TYPES[i.type] || TYPES.unknown; return out(intent, `Fix "${title(i)}" first: it is open now, ${i.severity}${canMoney ? `, with ${money(i.projected_loss, cur)} at risk if ignored` : ''}. Recommended: ${T.action}`, [{ label: `Issue ${i.id}`, href: `#issue-${i.id}` }, { label: 'Live', href: '#live' }]); }
    const wo = db.prepare("SELECT * FROM work_orders WHERE status NOT IN ('completed','verified') ORDER BY deadline LIMIT 1").get();
    if (wo) return out(intent, `Nothing is failing right now. The most urgent job is work order ${wo.id}, "${wo.title}", which must finish by ${new Date(wo.deadline).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`, [{ label: 'Work orders', href: '#work' }]);
    const top = risk.project(db, model, { runs: 600, assumptions }).ranking[0], low = parts.list(db).filter((p) => p.level === 'out');
    return out(intent, `Nothing is open. The biggest projected risk is ${top.label.toLowerCase()} (${Math.round(top.p_event_30d * 100)} % chance in 30 days).${low.length ? ` Order ${low.map((p) => p.name).join(', ')} first: out of stock.` : ''}`, [{ label: 'Risk', href: '#risk' }, { label: 'Spare parts', href: '#work' }]);
  }
  // open
  const open = db.prepare("SELECT * FROM issues WHERE status IN ('detected','acknowledged') ORDER BY id").all();
  const head = status ? `The line is ${{ ok: 'running normally', stopped: 'stopped' }[status.status] || 'running with a ' + status.status + ' issue'}, health ${status.health} of 100. ` : '';
  return out('open', head + (open.length ? `${open.length} issue${open.length === 1 ? ' is' : 's are'} open: ${open.map((i) => `"${title(i)}" (${i.severity}${i.acked_at ? ', acknowledged' : ', not acknowledged'})`).join('; ')}.` : 'No issues are open.'), [{ label: 'Live', href: '#live' }, ...open.map((i) => ({ label: `Issue ${i.id}`, href: `#issue-${i.id}` }))]);
}

module.exports = { ask, SUPPORTED };
