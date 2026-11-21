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
const REC = KEYS.filter((k) => k !== 'motion');
// Assumed minutes from detection until the fault turns into a breakdown if nobody acts (placeholder values).
const TTF_MIN = { bearing: 60, wrap: 30, block: 45, jam: 20 };

function runOne({ model, modelVersionId, costs, fault, severity, speed, startHour, peak, delayMin }) {
  const db = open(':memory:');
  costs = costs || db.prepare('SELECT * FROM cost_params WHERE machine_id = 1').get();
  db.prepare('UPDATE cost_params SET production_value_h = ?, idle_labour_h = ?, repair_labour_h = ?, scrap_kg = ?, energy_kwh = ? WHERE machine_id = 1')
    .run(costs.production_value_h * (peak ? 1.5 : 1), costs.idle_labour_h, costs.repair_labour_h, costs.scrap_kg, costs.energy_kwh);
  const start = new Date(); start.setHours(startHour, 0, 0, 0);
  let clock = start.getTime();
  const notifiers = [new MockNotifier('in_app'), new MockNotifier('telegram')], actuator = new MockActuator();
  const eng = new Sentinel({ db, model, modelVersionId, notifiers, actuator, escalateAfterS: 20, simulated: true, now: () => clock });
  const tech = eng.onDuty(1)[0], mgr = db.prepare("SELECT * FROM users WHERE role = 'manager'").get();
  const T0 = TYPES[fault];
  const points = [];
  const ttf = TTF_MIN[fault] ? TTF_MIN[fault] / speed : null, tooLate = delayMin !== null && ttf !== null && delayMin > ttf;
  if (tooLate) delayMin = null;
  let det = null, issueId = null, responded = false, resolved = false, repairUntil = 0, endAt = Infinity, lastLoss = 0, injectClock = 0;

  for (let i = 0; i < 2600; i++) {
    clock += 500;
    if (i === WARMUP) { eng.fault = fault; eng.faultAt = eng.t; eng.faultSpeed = speed; eng.faultSev = severity; injectClock = clock; }
    eng.tick();
    if (det === null && eng.active) { det = i; issueId = eng.active.id; }
    if (det !== null && !eng.active && !resolved) { resolved = true; endAt = i + 20; }                    // cleared by itself
    if (delayMin !== null && det !== null && !responded && i >= det + delayMin * TICKS_PER_MIN && eng.active) {
      responded = true;
      eng.ack(issueId, tech);
      for (const a of db.prepare("SELECT id FROM actions WHERE issue_id = ? AND status = 'pending_approval'").all(issueId)) eng.decide(a.id, mgr, true);
      repairUntil = i + Math.round((TYPES[eng.active.type] || TYPES.unknown).preventive.downtime_h * 60 * TICKS_PER_MIN);
    }
    if (responded && !resolved && i >= repairUntil && eng.active) { eng.resolve(issueId, tech, { note: 'Simulated repair' }); resolved = true; endAt = i + 20; }
    if (eng.active) lastLoss = eng.liveLoss();
    if (i % 2 === 0 && eng.ew) { const v = {}; REC.forEach((k) => { v[k] = +eng.ew[k].toFixed(SIG[k].dp + 1); }); points.push({ m: (i - WARMUP) / TICKS_PER_MIN, v, a: eng.last.anomaly ? 1 : 0, loss: Math.round(lastLoss) }); }
    if (i >= endAt) break;
    if (delayMin === null && det !== null && i >= det + (tooLate ? ttf : 90) * TICKS_PER_MIN) break;      // nobody responds: watch 90 minutes
    if (det === null && i >= WARMUP + 120 * TICKS_PER_MIN) break;                        // never detected
  }

  const c = eng.costs(), minute = (ts) => +(((ts - injectClock) / 1000)).toFixed(1);     // demo clock: 1 s = 1 min
  const issue = issueId ? db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) : null;
  const T = issue ? (TYPES[issue.type] || TYPES.unknown) : T0;
  let total, note;
  if (!issue) { total = loss.eventCost(T0.failure, c); note = 'The model did not detect this scenario, so it runs to failure.'; }
  else if (issue.resolved_at && issue.resolved_by !== 'system') { total = issue.actual_loss; note = `Repaired after a response delay of ${delayMin} min.`; }
  else if (issue.resolved_at) { total = issue.actual_loss; note = 'The readings returned to normal by themselves.'; }
  else { total = loss.round2(issue.actual_loss + loss.eventCost(T.failure, c)); note = tooLate ? `The response would come after the assumed ${Math.round(ttf)} min to breakdown, so the machine fails first.` : 'Nobody responds. The loss is what accrued while it ran on plus the cost of the eventual failure.'; }

  return {
    delayMin: tooLate ? null : delayMin, failedFirst: tooLate, detected: !!issue, detectMin: det === null ? null : (det - WARMUP) / TICKS_PER_MIN, type: issue ? issue.type : null, label: T.label, title: T.title,
    severity: issue ? issue.severity : null, confidence: issue ? issue.confidence : null, loss: Math.round(total), note,
    downtimeMin: issue ? Math.round(issue.downtime_h * 60) : null, scrapKg: issue ? Math.round(issue.scrap_kg) : null,
    notified: db.prepare('SELECT u.name, n.channel, n.level, n.sent_at FROM notifications n JOIN users u ON u.id = n.user_id ORDER BY n.id').all().map((n) => ({ name: n.name, channel: n.channel, level: n.level, m: minute(n.sent_at) })),
    escalations: db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'escalated'").get().n,
    actions: db.prepare('SELECT kind, risk, status FROM actions ORDER BY id').all().map((a) => ({ label: ACTIONS[a.kind].label, risk: a.risk, status: a.status })),
    events: db.prepare("SELECT ts, type, actor, summary FROM events WHERE type <> 'demo_fault' ORDER BY id").all().map((e) => ({ m: minute(e.ts), type: e.type, actor: e.actor, summary: e.summary })),
    points, mockMessages: notifiers.reduce((p, n) => p + n.sent.length, 0), mockCommands: actuator.commands.length,
  };
}

// Runs one scenario three ways: caught early, caught late, never acted on.
function runScenario(params, { model, modelVersionId = null, costs = null }) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const p = {
    fault: FAULTS[params.fault] ? params.fault : 'bearing',
    severity: num(params.severity, 1, 0.2, 2), speed: num(params.speed, 1, 0.25, 4),
    startHour: Math.round(num(params.startHour, 10, 0, 23)), peak: !!params.peak,
    responseMin: Math.round(num(params.responseMin, 10, 0, 240)), lateMin: Math.round(num(params.lateMin, 120, 1, 480)),
  };
  const base = { model, modelVersionId, costs, fault: p.fault, severity: p.severity, speed: p.speed, startHour: p.startHour, peak: p.peak };
  const early = runOne({ ...base, delayMin: p.responseMin });
  const late = runOne({ ...base, delayMin: p.responseMin + p.lateMin });
  const never = runOne({ ...base, delayMin: null });
  return { simulated: true, params: p, scenario: FAULTS[p.fault].name, early, late, never };
}

module.exports = { runScenario, runOne };
