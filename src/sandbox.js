// Failure scenario simulator. Every run gets its own throw-away in-memory database, its own engine,
// mock notifiers and a mock actuator. Nothing here can reach the live machine, its history or real people:
// the live engine, database, notifiers and actuator are never passed in.
const { open } = require('./db');
const { Sentinel } = require('./core');
const { MockNotifier, MockActuator } = require('./adapters');
const { SIG, KEYS, FAULTS } = require('./sim');
const { TYPES, ACTIONS } = require('./catalog');
const loss = require('./loss');

const WARMUP = 20;          // ticks of normal running before the fault starts
const TICKS_PER_MIN = 2;    // demo clock: one tick is half a minute
const DT_H = 0.5 / 60;      // hours of production per tick
const REC = KEYS.filter((k) => k !== 'motion');
const DEFAULT_TTF = { bearing: 60, wrap: 30, block: 45, jam: 20 };   // assumed minutes from detection to breakdown if nobody acts
// What it costs if a scenario the model was not trained on is never dealt with (placeholder figures).
const UNTRAINED_COST = {
  sensor_frozen:  { downtime_h: 0.25, repair_h: 1, parts: 350 },
  sensor_dropout: { downtime_h: 0.25, repair_h: 1, parts: 350 },
  sensor_drift:   { downtime_h: 0.25, repair_h: 1, parts: 350 },
  power_surge:    { downtime_h: 3, repair_h: 2, parts: 1500 },
  perf_drop:      { downtime_h: 0, repair_h: 2, parts: 200 },
};

// How the same model handled the untrained scenarios BEFORE the activity monitor was connected to it (recorded 21 Nov 2026, commit 2fd5f08).
const BEFORE_CROSSCHECK = {
  sensor_frozen:  { outcome: 'missed',   text: 'Missed by the fault model. The activity monitor flagged a frozen sensor at about minute 14, but nobody was alerted.' },
  sensor_dropout: { outcome: 'misnamed', text: 'Named "Filling starvation" after 2.5 min at 83 % confidence. Stopping the feed was recommended. The monitor flagged an impossible jump at minute 0, but the two were not connected.' },
  sensor_drift:   { outcome: 'misnamed', text: 'Named "Filling blockage" after about 36 min at 52 % confidence. A shutdown was recommended, and acting on it cost more than doing nothing.' },
  power_surge:    { outcome: 'unknown',  text: 'Seen as an unclassified anomaly after 2.5 min, then cleared by itself.' },
  perf_drop:      { outcome: 'misnamed', text: 'Named "Sheet tear" after about an hour at 55 % confidence. Stopping the feed was recommended.' },
};

function runOne({ model, modelVersionId, costs, ttfMin, fault, severity, speed, startHour, peak, delayMin }) {
  const db = open(':memory:');
  costs = costs || db.prepare('SELECT * FROM cost_params WHERE machine_id = 1').get();
  db.prepare('UPDATE cost_params SET production_value_h = ?, idle_labour_h = ?, repair_labour_h = ?, scrap_kg = ?, energy_kwh = ? WHERE machine_id = 1')
    .run(costs.production_value_h * (peak ? 1.5 : 1), costs.idle_labour_h, costs.repair_labour_h, costs.scrap_kg, costs.energy_kwh);
  const start = new Date(); start.setHours(startHour, 0, 0, 0);
  let clock = start.getTime();
  const notifiers = [new MockNotifier('in_app'), new MockNotifier('telegram')], actuator = new MockActuator();
  const eng = new Sentinel({ db, model, modelVersionId, notifiers, actuator, escalateAfterS: 20, simulated: true, now: () => clock });
  const tech = eng.onDuty(1)[0], mgr = db.prepare("SELECT * FROM users WHERE role = 'manager'").get();
  const F = FAULTS[fault], trained = !F.untrained;
  const ttfBase = (ttfMin || DEFAULT_TTF)[fault];
  const ttf = ttfBase ? ttfBase / speed : null, tooLate = delayMin !== null && ttf !== null && delayMin > ttf;
  if (tooLate) delayMin = null;
  const points = [], target = eng.machine.target_kg_h, baseDefect = model.base.defect.mean;
  let det = null, issueId = null, responded = false, resolved = false, repairUntil = 0, endAt = Infinity, lastLoss = 0, injectClock = 0;
  let shadowDown = 0, shadowScrap = 0;   // lost output and scrap whether or not anything was detected

  for (let i = 0; i < 2600; i++) {
    clock += 500;
    if (i === WARMUP) { eng.fault = fault; eng.faultAt = eng.t; eng.faultSpeed = speed; eng.faultSev = severity; injectClock = clock; }
    eng.tick();
    if (i >= WARMUP && eng.ew) { shadowDown += Math.max(0, 1 - Math.min(1, eng.ew.rate / target)) * DT_H; shadowScrap += eng.ew.rate * DT_H * Math.max(0, eng.ew.defect - baseDefect) / 100; }
    if (det === null && eng.active) { det = i; issueId = eng.active.id; }
    if (det !== null && !eng.active && !resolved) { resolved = true; endAt = i + 20; }                    // cleared by itself
    if (delayMin !== null && det !== null && !responded && i >= det + delayMin * TICKS_PER_MIN && eng.active) {
      responded = true;
      eng.ack(issueId, tech);
      repairUntil = i + Math.round((TYPES[eng.active.type] || TYPES.unknown).preventive.downtime_h * 60 * TICKS_PER_MIN);
    }
    // After responding, the manager approves waiting machine actions, except ones carrying a low-confidence warning.
    if (responded && !resolved && eng.active) for (const a of db.prepare("SELECT id FROM actions WHERE issue_id = ? AND status = 'pending_approval' AND reason NOT LIKE 'Low confidence%'").all(issueId)) eng.decide(a.id, mgr, true);
    if (responded && !resolved && i >= repairUntil && eng.active) { eng.resolve(issueId, tech, { note: 'Simulated repair' }); resolved = true; endAt = i + 20; }
    if (eng.active) lastLoss = eng.liveLoss();
    if (i % 2 === 0 && eng.ew) { const v = {}; REC.forEach((k) => { v[k] = +eng.ew[k].toFixed(SIG[k].dp + 1); }); points.push({ m: (i - WARMUP) / TICKS_PER_MIN, v, a: eng.last.anomaly ? 1 : 0, loss: Math.round(lastLoss) }); }
    if (i >= endAt) break;
    if (delayMin === null && det !== null && i >= det + (tooLate ? ttf : 90) * TICKS_PER_MIN) break;      // nobody responds: watch 90 minutes
    if (det === null && i >= WARMUP + 120 * TICKS_PER_MIN) break;                                          // never detected: watch two hours
  }

  const c = eng.costs(), minute = (ts) => +(((ts - injectClock) / 1000)).toFixed(1);     // demo clock: 1 s = 1 min
  const issue = issueId ? db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) : null;
  const T = issue ? (TYPES[issue.type] || TYPES.unknown) : null;
  const missedCost = trained ? loss.eventCost(TYPES[fault].failure, c) : loss.eventCost(UNTRAINED_COST[fault], c);
  const flags = db.prepare('SELECT ts, kind, title, explanation FROM unusual_flags ORDER BY id').all().map((f) => ({ m: minute(f.ts), kind: f.kind, title: f.title, explanation: f.explanation }));
  const flagAlerts = db.prepare("SELECT u.name, a.channel, a.sent_at, f.title FROM flag_alerts a JOIN users u ON u.id = a.user_id JOIN unusual_flags f ON f.id = a.flag_id ORDER BY a.id").all().map((a) => ({ name: a.name, channel: a.channel, m: minute(a.sent_at), title: a.title }));
  const ex = issue ? JSON.parse(issue.explanation) : {};
  const held = db.prepare("SELECT COUNT(*) n FROM actions WHERE reason LIKE 'Low confidence%' AND status IN ('pending_approval', 'cancelled')").get().n;

  let total, note;
  if (!issue) { total = loss.round2(loss.actualLoss({ downtime_h: shadowDown, scrap_kg: shadowScrap }, c).total + missedCost); note = 'The fault model raised no issue, so nobody is alerted. The loss is what accrued over two hours plus the assumed cost of dealing with it later.'; }
  else if (issue.resolved_at && issue.resolved_by !== 'system') { total = issue.actual_loss; note = `Repaired after a response delay of ${delayMin} min.`; }
  else if (issue.resolved_at) { total = issue.actual_loss; note = 'The readings returned to normal by themselves before anyone acted.'; }
  else { total = loss.round2(issue.actual_loss + (trained ? loss.eventCost(T.failure, c) : missedCost)); note = tooLate ? `The response would come after the assumed ${Math.round(ttf)} min to breakdown, so the machine fails first.` : 'Nobody responds. The loss is what accrued while it ran on plus the cost of the eventual failure.'; }

  // Plain statement of how the model coped with this scenario.
  let handling, outcome;
  if (!issue) { outcome = 'missed'; handling = flags.length ? `Missed by the fault model. The activity monitor did catch it: "${flags[0].title}" at minute ${Math.floor(flags[0].m)}${flagAlerts.length ? `, and alerted ${flagAlerts[0].name} as a sensor issue` : ''}.` : 'Missed. Neither the fault model nor the activity monitor raised anything.'; }
  else if (issue.type === 'sensor') { outcome = F.sensor ? 'sensor' : 'sensor_wrong'; handling = `Shown as "${issue.title}", with "${ex.original.title}" listed as the diagnosis if the sensor is correct. ${F.sensor ? 'That is the right call: the sensor is the problem.' : 'That is wrong: the machine really has a fault.'} No shutdown or feed stop was recommended; a work order to check the sensor was created and the technician was alerted as a sensor issue.`; }
  else if (issue.type === fault) { outcome = 'correct'; handling = `Detected and named correctly as "${T.label}".`; }
  else if (issue.type === 'unknown') { outcome = 'unknown'; handling = 'Detected as an unclassified anomaly. The model sees that something is wrong but cannot say what, so the advice is generic.'; }
  else { outcome = 'misnamed'; handling = `Detected, but named "${T.label}", which is wrong. ${F.truth || ''} The cause, checks and actions shown to the operator would be for the wrong problem.`; }
  if (issue && issue.type !== 'sensor' && (ex.confidence_note || held)) handling += ` ${ex.confidence_note || 'The diagnosis was marked low confidence.'}${held ? ' The machine action carried a low-confidence warning and was not approved; this run assumes the manager heeds that warning.' : ''}`;
  if (outcome === 'misnamed' && responded && actuator.commands.length) note += ' The machine was stopped for a problem it did not have.';
  if (issue && flags.length) handling += ` The activity monitor also flagged "${flags[0].title}" at minute ${Math.floor(flags[0].m)}.`;

  return {
    delayMin: tooLate ? null : delayMin, failedFirst: tooLate, detected: !!issue, detectMin: det === null ? null : (det - WARMUP) / TICKS_PER_MIN,
    type: issue ? issue.type : null, label: T ? T.label : null, title: issue ? (issue.title || T.title) : null, original: ex.original || null, outcome, handling, flagAlerts,
    severity: issue ? issue.severity : null, confidence: issue ? issue.confidence : null, loss: Math.round(total), note,
    downtimeMin: Math.round((issue ? issue.downtime_h : shadowDown) * 60), scrapKg: Math.round(issue ? issue.scrap_kg : shadowScrap), flags,
    notified: db.prepare('SELECT u.name, n.channel, n.level, n.sent_at FROM notifications n JOIN users u ON u.id = n.user_id ORDER BY n.id').all().map((n) => ({ name: n.name, channel: n.channel, level: n.level, m: minute(n.sent_at) })),
    escalations: db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'escalated'").get().n,
    actions: db.prepare('SELECT kind, risk, status FROM actions ORDER BY id').all().map((a) => ({ label: ACTIONS[a.kind].label, risk: a.risk, status: a.status })),
    events: db.prepare("SELECT ts, type, actor, summary FROM events WHERE type <> 'demo_fault' ORDER BY id").all().map((e) => ({ m: minute(e.ts), type: e.type, actor: e.actor, summary: e.summary })),
    points, mockMessages: notifiers.reduce((p, n) => p + n.sent.length, 0), mockCommands: actuator.commands.length,
  };
}

// Runs one scenario three ways: caught early, caught late, never acted on.
function runScenario(params, { model, modelVersionId = null, costs = null, ttfMin = null }) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const p = {
    fault: FAULTS[params.fault] ? params.fault : 'bearing',
    severity: num(params.severity, 1, 0.2, 2), speed: num(params.speed, 1, 0.25, 4),
    startHour: Math.round(num(params.startHour, 10, 0, 23)), peak: !!params.peak,
    responseMin: Math.round(num(params.responseMin, 10, 0, 240)), lateMin: Math.round(num(params.lateMin, 120, 1, 480)),
  };
  const F = FAULTS[p.fault];
  const base = { model, modelVersionId, costs, ttfMin, fault: p.fault, severity: p.severity, speed: p.speed, startHour: p.startHour, peak: p.peak };
  const early = runOne({ ...base, delayMin: p.responseMin });
  const late = runOne({ ...base, delayMin: p.responseMin + p.lateMin });
  const never = runOne({ ...base, delayMin: null });
  return { simulated: true, params: p, scenario: F.name, trained: !F.untrained, truth: F.truth || null, before: BEFORE_CROSSCHECK[p.fault] || null, early, late, never };
}

// Runs the five untrained scenarios with default settings and pairs each with its recorded result from before the cross-check.
function crossCheckComparison(ctx) {
  return Object.keys(BEFORE_CROSSCHECK).map((key) => { const r = runScenario({ fault: key }, ctx), v = r.early;
    return { key, name: r.scenario, truth: r.truth, before: r.before, after: { outcome: v.outcome, text: v.handling, detectMin: v.detectMin, shown: v.title, confidence: v.confidence, losses: { early: r.early.loss, late: r.late.loss, never: r.never.loss } } }; });
}

module.exports = { runScenario, runOne, crossCheckComparison, DEFAULT_TTF, BEFORE_CROSSCHECK };
