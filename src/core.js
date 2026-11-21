// The monitoring engine: simulator tick -> detection -> issue -> notification/escalation -> remediation -> losses -> history.
const { SIG, KEYS, FAULTS, sample, smooth } = require('./sim');
const { IssueDetector, DT } = require('./ml/detector');
const { TYPES, ACTIONS, STATION_OF } = require('./catalog');
const loss = require('./loss');
const unusual = require('./unusual');
const workorders = require('./workorders');

const OPEN_AFTER = 6;      // consecutive anomalous ticks (3 s) before an issue is opened
const CLEAR_AFTER = 20;    // consecutive normal ticks (10 s) before an issue clears by itself
const TEMP_LIMIT = 75;     // °C, gearbox failure threshold used for remaining-life estimate
const LOW_CONFIDENCE = 0.6; // below this, or resting on a single sensor, a diagnosis is treated as uncertain
const RANK = { operator: 1, technician: 2, manager: 3 };

class Forbidden extends Error {}
class BadRequest extends Error {}

class Sentinel {
  constructor({ db, model, modelVersionId = null, notifiers, actuator, escalateAfterS = 20, timeScale = 60, simulated = false, now = () => Date.now() }) {
    Object.assign(this, { db, modelVersionId, notifiers, actuator, escalateAfterS, timeScale, simulated, now });
    this.detector = new IssueDetector(model);
    this.machineId = 1;
    this.machine = db.prepare('SELECT * FROM machines WHERE id = 1').get();
    this.t = Math.random() * 1000; this.tickNo = 0; this.seq = 0;
    this.fault = null; this.faultAt = 0; this.faultSpeed = 1; this.faultSev = 1; this.stopped = false; this.ew = null;
    this.quirk = null; this.frozen = null;   // demo-only sensor oddities, see src/unusual.js
    this.ring = []; this.streak = 0; this.calm = 0; this.cooldown = 0; this.active = null; this.last = null;
  }

  // ---- helpers -------------------------------------------------------------
  costs() { return this.db.prepare('SELECT * FROM cost_params WHERE machine_id = ?').get(this.machineId); }
  setting(key) { const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; }
  need(user, role) { if (!user || RANK[user.role] < RANK[role]) throw new Forbidden(`This needs the ${role} role`); }

  event(type, actorType, actor, summary, { issueId = null, refTable = null, refId = null, data = null } = {}) {
    this.db.prepare('INSERT INTO events (machine_id, ts, type, actor_type, actor, issue_id, ref_table, ref_id, summary, data, is_simulated) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(this.machineId, this.now(), type, actorType, actor, issueId, refTable, refId, summary, data ? JSON.stringify(data) : null, this.simulated ? 1 : 0);
  }
  audit(user, action, detail) { this.db.prepare('INSERT INTO audit_log (ts, user_id, action, detail) VALUES (?,?,?,?)').run(this.now(), user ? user.id : null, action, detail ? JSON.stringify(detail) : null); }

  // ---- one simulator step --------------------------------------------------
  tick() {
    this.t += DT; this.tickNo++;
    this.prevRaw = this.raw;
    this.raw = sample(this.t, this.fault, (this.t - this.faultAt) * this.faultSpeed, this.stopped, this.faultSev);
    this.ew = smooth(this.ew, this.raw);
    unusual.applyQuirk(this);
    unusual.everyTick(this);
    // readings outside the sensor's physical range are not shown to the fault model
    const p = this.stopped || this.cooldown > 0 ? { anomaly: false, score: 0, z: {}, contributions: [], maxAbsZ: 0 } : this.detector.predict(this.machineId, unusual.maskImplausible(this));
    if (this.cooldown > 0) this.cooldown--;
    this.last = p;
    (this.zHist = this.zHist || []).push(p.z); if (this.zHist.length > 6) this.zHist.shift();
    const v = {}; KEYS.forEach((k) => { v[k] = +this.ew[k].toFixed(SIG[k].dp + 1); });
    this.ring.push({ seq: ++this.seq, ts: this.now(), v, a: p.anomaly ? 1 : 0, s: p.score });
    if (this.ring.length > 240) this.ring.shift();
    if (this.tickNo % 2 === 0) this.db.prepare('INSERT INTO readings (ts, machine_id, data, anomaly, score) VALUES (?,?,?,?,?)').run(this.now(), this.machineId, JSON.stringify(v), p.anomaly ? 1 : 0, p.score);

    if (p.anomaly) { this.streak++; this.calm = 0; } else { this.streak = 0; this.calm++; }
    if (!this.active && this.streak >= OPEN_AFTER) this.openIssue(p);
    if (this.active) {
      this.accrue(p);
      this.crossCheck(p);
      if (!this.stopped && this.calm >= CLEAR_AFTER) this.resolve(this.active.id, null, { system: true });
      else if (this.tickNo % 2 === 0) { this.persistActive(); this.escalate(); }
    }
    if (this.tickNo % 2 === 0) unusual.check(this);
    return p;
  }

  // ---- issues --------------------------------------------------------------
  // Turns the model's raw verdict into what people are shown, after three cross-checks:
  //  1. if the activity monitor distrusts a sensor the verdict depends on AND no trusted sensor backs the verdict up, it becomes a possible sensor fault;
  //  2. if the verdict rests on one sensor while everything else looks normal, its confidence is lowered;
  //  3. if confidence ends up below the unknown threshold, no fault is named: it is an unclassified anomaly to inspect.
  diagnose(p, extraKeys = []) {
    const T0 = TYPES[p.type] || TYPES.unknown;
    const keys = [...new Set([...p.contributions.map((x) => x.key), ...extraKeys])];
    // a signal counts as deviating only if it has been off in at least 5 of the last 6 readings, so one noisy sample neither creates nor hides support
    const hist = this.zHist && this.zHist.length >= 6 ? this.zHist : [p.z];
    const deviating = KEYS.filter((k) => hist.filter((z) => Math.abs(z[k] || 0) > 3).length >= Math.min(5, hist.length));
    const suspects = unusual.suspectKeys(this), hit = keys.find((k) => suspects[k]);
    let sensorNote = null;
    if (hit) {
      // Corroboration: do sensors we still trust move the way this fault predicts?
      const expected = this.detector.expected(p.type);
      const support = deviating.filter((k) => !suspects[k] && (expected ? expected[k] === Math.sign(p.z[k]) : true));
      const name = SIG[hit].label.toLowerCase();
      if (!support.length) {
        const T = TYPES.sensor;
        return { type: 'sensor', T, keys, title: `Possible sensor fault: check the ${name} sensor`, comp: [STATION_OF[hit]], severity: T.sev, confidence: p.confidence, low: false, single: null, candidate: null, sensorNote: null,
          sensor: { key: hit, label: SIG[hit].label, why: suspects[hit].why }, original: { type: p.type, label: T0.label, title: T0.title, confidence: p.confidence },
          cause: `The ${name} sensor ${suspects[hit].why}, and no other sensor backs this diagnosis up. ${T.cause}`, note: null };
      }
      sensorNote = `The ${name} sensor ${suspects[hit].why}, but ${support.map((k) => SIG[k].label.toLowerCase()).join(', ')} ${support.length === 1 ? 'agrees' : 'agree'} with this diagnosis, so it is treated as a real machine fault. Check the sensor as well.`;
    }
    const single = deviating.length === 1 ? deviating[0] : null;
    const confidence = single ? +Math.min(0.5, p.confidence * 0.6).toFixed(3) : p.confidence;
    const stored = Number(this.setting('unknown_threshold')), threshold = Number.isFinite(stored) ? stored : 0.4;   // 0 is a valid setting: name everything
    const singleNote = single ? `Confidence lowered from ${Math.round(p.confidence * 100)} % to ${Math.round(confidence * 100)} %: this diagnosis rests on one sensor (${SIG[single].label.toLowerCase()}) while every other reading looks normal. It could be the machine or the sensor.` : null;
    if (p.type === 'unknown' || confidence < threshold) {
      const T = TYPES.unknown, candidate = p.type === 'unknown' ? null : { type: p.type, label: T0.label, title: T0.title, confidence };
      const note = candidate ? `Most likely "${T0.label}", but at ${Math.round(confidence * 100)} % confidence, below the ${Math.round(threshold * 100)} % needed to name a fault.${singleNote ? ' ' + singleNote : ''}` : 'The pattern does not match any fault the model was trained on.';
      return { type: 'unknown', T, keys, title: T.title, comp: candidate ? T0.comp : [], severity: T.sev, confidence, low: false, single, candidate, sensorNote, sensor: null, original: null, cause: T.cause, note };
    }
    const low = !!single || confidence < LOW_CONFIDENCE;
    const note = singleNote || (low ? `Low confidence (${Math.round(confidence * 100)} %): the readings only loosely match this fault.` : null);
    return { type: p.type, T: T0, keys, title: T0.title, comp: T0.comp, severity: T0.sev, confidence, low, single, candidate: null, sensorNote, sensor: null, original: null, cause: T0.cause, note };
  }

  explain(p, d) {
    return { summary: d.cause, contributions: p.contributions, score: p.score, threshold: +this.detector.model.thr.toFixed(4), max_deviation: p.maxAbsZ, type_similarity: p.typeSimilarity,
      recommended: d.T.action, sensor: d.sensor, original: d.original, candidate: d.candidate, sensor_note: d.sensorNote, confidence_note: d.note, single_sensor: d.single, model_confidence: p.confidence };
  }

  openIssue(p) {
    const d = this.diagnose(p), T = d.T, c = this.costs(), now = this.now();
    const projected = loss.projectedLoss(T.failProb, T.failure, c);
    const id = Number(this.db.prepare('INSERT INTO issues (machine_id, component, type, title, severity, confidence, fail_prob, explanation, model_version_id, status, is_simulated, detected_at, projected_loss) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(this.machineId, d.comp[0] || null, d.type, d.title, d.severity, d.confidence, T.failProb, JSON.stringify(this.explain(p, d)), this.modelVersionId, 'detected', this.simulated ? 1 : 0, now, projected).lastInsertRowid);
    this.active = { id, type: d.type, modelType: p.type, title: d.title, cause: d.cause, comp: d.comp, keys: d.keys, low: d.low, single: d.single, note: d.note, sensor: d.sensor, original: d.original, candidate: d.candidate, sensorNote: d.sensorNote,
      severity: d.severity, confidence: d.confidence, openType: d.type, openConfidence: d.confidence, detectedAt: now, downtime_h: 0, scrap_kg: 0, level: 0, lastNotifyAt: 0, acked: false, rul: null };
    const extra = d.original ? `. If the sensor is correct: ${d.original.title}` : d.candidate ? `. Most likely, low confidence: ${d.candidate.title}` : '';
    this.event('issue_detected', 'model', `model v${this.modelVersionId ?? 0}`, `${d.title} (${d.severity}, ${Math.round(d.confidence * 100)} % confidence)${extra}${d.note ? '. ' + d.note : ''}${d.sensorNote ? ' ' + d.sensorNote : ''}`, { issueId: id, refTable: 'issues', refId: id, data: { contributions: p.contributions.map((x) => x.text) } });
    this.notifyLevel(1);
    this.planActions(p);
    return id;
  }

  // Re-checks an open issue on every tick. A change of diagnosis must hold for 3 seconds before it is applied.
  //   any diagnosis -> possible sensor fault   when its sensor is flagged and nothing backs the diagnosis up
  //   sensor fault  -> machine fault           when trusted sensors come to agree, or the sensor is no longer flagged
  //   unclassified  -> named fault             when confidence reaches the threshold
  crossCheck(p) {
    const a = this.active;
    if (!a || this.stopped || !p.anomaly) return;
    const d = this.diagnose(p, a.keys);
    const change = (d.type === 'sensor' && a.type !== 'sensor') || (a.type === 'sensor' && d.type !== 'sensor') || (a.type === 'unknown' && d.type !== 'unknown');
    if (change) {
      a.pending = a.pending && a.pending.type === d.type ? { type: d.type, n: a.pending.n + 1 } : { type: d.type, n: 1 };
      if (a.pending.n >= OPEN_AFTER) { a.pending = null; this.reclassify(d, p); }
      return;
    }
    a.pending = null;
    if (d.type !== a.type) return;
    if (d.sensorNote && !a.sensorNote) { a.sensorNote = d.sensorNote; this.patchExplanation({ sensor_note: d.sensorNote }); this.event('sensor_note', 'system', 'cross-check', d.sensorNote, { issueId: a.id }); }
    if (a.low && !d.low) {
      a.low = false; a.single = null; a.note = null; a.confidence = d.confidence;
      this.patchExplanation({ confidence_note: null, single_sensor: null, confirmed: 'Other sensors now agree with this diagnosis.' }, d.confidence);
      this.db.prepare("UPDATE actions SET reason = replace(reason, 'Low confidence. Check the machine before approving. ', '') WHERE issue_id = ? AND status = 'pending_approval'").run(a.id);
      this.event('confidence_raised', 'model', `model v${this.modelVersionId ?? 0}`, `Confidence raised to ${Math.round(d.confidence * 100)} %: other sensors now agree with the diagnosis. Low-confidence warning removed.`, { issueId: a.id });
    }
  }

  patchExplanation(fields, confidence = null) {
    const a = this.active, ex = JSON.parse(this.db.prepare('SELECT explanation FROM issues WHERE id = ?').get(a.id).explanation);
    Object.assign(ex, fields);
    this.db.prepare('UPDATE issues SET explanation = ?, confidence = COALESCE(?, confidence) WHERE id = ?').run(JSON.stringify(ex), confidence, a.id);
  }

  reclassify(d, p) {
    const a = this.active, T = d.T, now = this.now(), prev = { type: a.type, title: a.title };
    if (d.type === 'sensor') d.original = a.original || (a.candidate ? { ...a.candidate } : { type: a.type, label: (TYPES[a.type] || TYPES.unknown).label, title: a.title, confidence: a.confidence });
    const why = d.type === 'sensor' ? `The ${d.sensor.label.toLowerCase()} sensor ${d.sensor.why} and no other sensor backs the diagnosis up. If the sensor is correct: ${d.original.title}.`
      : prev.type === 'sensor' ? (d.sensorNote || 'The sensor is no longer flagged, so the machine diagnosis stands.')
      : `Confidence reached ${Math.round(d.confidence * 100)} %.`;
    this.db.prepare('UPDATE issues SET type = ?, title = ?, component = ?, severity = ?, confidence = ?, fail_prob = ?, projected_loss = ?, explanation = ? WHERE id = ?')
      .run(d.type, d.title, d.comp[0] || null, d.severity, d.confidence, T.failProb, loss.projectedLoss(T.failProb, T.failure, this.costs()), JSON.stringify(this.explain(p, d)), a.id);
    const keep = T.actions.map(() => '?').join(',');
    const cancelled = this.db.prepare(`UPDATE actions SET status = 'cancelled', decided_at = ? WHERE issue_id = ? AND status IN ('pending_approval', 'suggested') AND kind NOT IN (${keep})`).run(now, a.id, ...T.actions).changes;
    Object.assign(a, { type: d.type, title: d.title, cause: d.cause, comp: d.comp, severity: d.severity, confidence: d.confidence, low: d.low, single: d.single, note: d.note, sensor: d.sensor, original: d.original, candidate: d.candidate, sensorNote: d.sensorNote });
    if (d.type !== 'bearing') a.rul = null;
    this.event('reclassified', 'system', 'cross-check', `Changed from "${prev.title}" to "${d.title}". ${why}${cancelled ? ` ${cancelled} waiting action${cancelled === 1 ? '' : 's'} withdrawn.` : ''}`, { issueId: a.id });
    this.planActions(p);
    this.notifyLevel(Math.max(1, a.level));
  }

  accrue(p) {
    const a = this.active, dtH = (DT * this.timeScale) / 3600, rate = this.ew.rate, target = this.machine.target_kg_h;
    a.downtime_h += Math.max(0, 1 - Math.min(1, rate / target)) * dtH;
    a.scrap_kg += rate * dtH * Math.max(0, this.ew.defect - this.detector.model.base.defect.mean) / 100;
    if (a.type === 'bearing' && !this.stopped) {
      const past = this.ring[this.ring.length - 21];
      const slope = past ? (this.ew.temp_gear - past.v.temp_gear) / 10 : 0;       // °C per real second = per demo minute
      a.rul = slope > 0.02 && this.ew.temp_gear < TEMP_LIMIT ? Math.round((TEMP_LIMIT - this.ew.temp_gear) / slope) : this.ew.temp_gear >= TEMP_LIMIT ? 0 : a.rul;
      if (a.severity !== 'critical' && p.z.temp_gear > 8) {
        a.severity = 'critical';
        this.db.prepare('UPDATE issues SET severity = ? WHERE id = ?').run('critical', a.id);
        this.event('severity_raised', 'model', `model v${this.modelVersionId ?? 0}`, 'Severity raised to critical: gearbox temperature keeps climbing', { issueId: a.id });
      }
    }
  }

  liveLoss(a = this.active) { return loss.actualLoss({ downtime_h: a.downtime_h, scrap_kg: a.scrap_kg }, this.costs()).total; }
  persistActive() { const a = this.active; this.db.prepare('UPDATE issues SET downtime_h = ?, scrap_kg = ?, actual_loss = ?, rul_min = ? WHERE id = ?').run(a.downtime_h, a.scrap_kg, this.liveLoss(a), a.rul, a.id); }

  ack(issueId, user) {
    this.need(user, 'operator');
    const a = this.active;
    if (!a || a.id !== issueId) throw new BadRequest('This issue is no longer active');
    if (a.acked) return;
    a.acked = true;
    this.db.prepare("UPDATE issues SET acked_at = ?, acked_by = ?, status = 'acknowledged' WHERE id = ?").run(this.now(), user.id, issueId);
    this.db.prepare("UPDATE notifications SET acked_at = ?, status = 'acknowledged' WHERE issue_id = ? AND acked_at IS NULL").run(this.now(), issueId);
    this.event('acknowledged', 'user', user.name, `${user.name} acknowledged the issue`, { issueId });
  }

  // Resolve = the problem is fixed. In this demo that also clears the simulated fault and restarts the machine.
  resolve(issueId, user, { note = '', system = false } = {}) {
    if (!system) this.need(user, 'technician');
    const a = this.active;
    if (!a || a.id !== issueId) throw new BadRequest('This issue is no longer active');
    const T = TYPES[a.type] || TYPES.unknown, c = this.costs(), now = this.now();
    const repair = system ? { repair_h: 0, parts: 0 } : T.preventive;
    const actual = loss.actualLoss({ downtime_h: a.downtime_h, scrap_kg: a.scrap_kg, repair_h: repair.repair_h, parts: repair.parts }, c).total;
    const savings = system ? 0 : loss.savingsFromEarlyDetection(T.failure, T.preventive, c);
    const by = system ? 'system' : user.name;
    this.db.prepare("UPDATE issues SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?, downtime_h = ?, scrap_kg = ?, actual_loss = ?, savings = ?, rul_min = ? WHERE id = ?")
      .run(now, by, system ? 'Readings returned to normal without a repair being recorded' : (note || T.action), a.downtime_h, a.scrap_kg, actual, savings, a.rul, issueId);
    this.db.prepare("UPDATE actions SET status = 'cancelled', decided_at = ? WHERE issue_id = ? AND status IN ('pending_approval', 'suggested')").run(now, issueId);
    this.event('resolved', system ? 'system' : 'user', by, system ? 'Issue cleared: readings returned to normal' : `${by} resolved the issue: ${note || T.action}`, { issueId, data: { actual_loss: actual, savings } });
    if (!system) {
      if (this.fault) this.fault = null;
      if (this.stopped) { this.stopped = false; this.event('machine_restarted', 'user', by, 'Machine restarted after repair', { issueId }); }
      this.ew = null; this.cooldown = 10;
    }
    this.active = null; this.streak = 0; this.calm = 0;
  }

  verify(issueId, user) {
    this.need(user, 'manager');
    const r = this.db.prepare("UPDATE issues SET status = 'verified', verified_at = ?, verified_by = ? WHERE id = ? AND status = 'resolved'").run(this.now(), user.id, issueId);
    if (!r.changes) throw new BadRequest('Only a resolved issue can be verified');
    this.event('verified', 'user', user.name, `${user.name} verified the repair`, { issueId });
  }

  // ---- notifications and escalation ----------------------------------------
  onDuty(level) {
    const all = this.db.prepare('SELECT u.* FROM responsibilities r JOIN users u ON u.id = r.user_id WHERE r.machine_id = ? AND r.level = ?').all(this.machineId, level);
    const h = new Date(this.now()).getHours(), shift = h >= 8 && h < 20 ? 'day' : 'night';
    const duty = all.filter((u) => u.shift === 'any' || u.shift === shift);
    return duty.length ? duty : all;
  }

  notifyLevel(level) {
    const a = this.active, T = TYPES[a.type] || TYPES.unknown, now = this.now();
    const people = this.onDuty(level);
    const text = `${a.type === 'sensor' ? 'Sensor issue on ' : ''}${this.machine.name}: ${a.title}. Severity ${a.severity}. ${T.action}`;
    for (const user of people) for (const n of this.notifiers) {
      if (n.channel === 'telegram' && !['high', 'critical'].includes(a.severity)) continue;
      const res = n.send({ user, issue: a, text });
      const id = Number(this.db.prepare('INSERT INTO notifications (issue_id, user_id, channel, level, status, sent_at, delivered_at) VALUES (?,?,?,?,?,?,?)')
        .run(a.id, user.id, n.channel, level, res.status, now, res.status === 'delivered' ? now : null).lastInsertRowid);
      this.event('notification', 'system', 'notifier', `${n.channel === 'in_app' ? 'In-app alert' : 'Telegram message'} to ${user.name} (level ${level}): ${res.status.replace('_', ' ')}`, { issueId: a.id, refTable: 'notifications', refId: id, data: { note: res.note } });
    }
    a.level = level; a.lastNotifyAt = now;
    if (level === 1) this.db.prepare('UPDATE issues SET notified_at = ? WHERE id = ?').run(now, a.id);
  }

  escalate() {
    const a = this.active;
    if (!a || a.acked || a.level >= 3) return false;
    if (this.now() - a.lastNotifyAt < this.escalateAfterS * 1000) return false;
    this.event('escalated', 'system', 'escalation', `Nobody acknowledged within ${this.escalateAfterS} s: escalating to level ${a.level + 1}`, { issueId: a.id });
    this.notifyLevel(a.level + 1);
    return true;
  }

  // ---- remediation with guardrails -----------------------------------------
  planActions(p) {
    const a = this.active, T = TYPES[a.type] || TYPES.unknown, now = this.now();
    const auto = this.setting('automation_enabled') === '1';
    const base = `${T.label} detected with ${Math.round(a.confidence * 100)} % confidence`;
    for (const kind of T.actions) {
      const A = ACTIONS[kind];
      if (this.db.prepare("SELECT 1 FROM actions WHERE issue_id = ? AND kind = ? AND status <> 'cancelled'").get(a.id, kind)) continue;
      // a machine action on an uncertain diagnosis always goes to the manager, whatever the settings say
      const needsApproval = A.risk === 'physical' && (a.low || this.setting('approval_' + kind) !== '0');
      const reason = A.risk === 'physical' && a.low ? `Low confidence. Check the machine before approving. ${base}` : base;
      const runNow = auto && !needsApproval;
      const status = runNow ? 'done' : A.risk === 'physical' ? 'pending_approval' : 'suggested';
      const id = Number(this.db.prepare('INSERT INTO actions (issue_id, machine_id, kind, risk, status, reason, confidence, created_at, executed_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(a.id, this.machineId, kind, A.risk, status, reason, a.confidence, now, runNow ? now : null).lastInsertRowid);
      if (runNow) { this.execute(kind, a.id); this.event('action_auto', 'rule', 'remediation', `Done automatically: ${A.label}. Reason: ${reason}`, { issueId: a.id, refTable: 'actions', refId: id }); }
      else if (status === 'pending_approval') this.event('approval_requested', 'rule', 'remediation', `Waiting for manager approval: ${A.label}. Reason: ${reason}`, { issueId: a.id, refTable: 'actions', refId: id });
      else this.event('action_suggested', 'rule', 'remediation', `Suggested (automation is off): ${A.label}`, { issueId: a.id, refTable: 'actions', refId: id });
    }
  }

  execute(kind, issueId) {
    const res = this.actuator.execute(kind, this.machineId);
    workorders.onAction(this, kind, issueId);   // work-order actions become real work orders
    if (kind === 'stop_feed' || kind === 'safe_shutdown') this.stopped = true;   // effect on the simulated machine
    this.db.prepare('UPDATE issues SET action_at = COALESCE(action_at, ?) WHERE id = ?').run(this.now(), issueId);
    return res;
  }

  decide(actionId, user, approve) {
    const act = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
    if (!act) throw new BadRequest('No such action');
    this.need(user, act.risk === 'physical' ? 'manager' : 'technician');
    if (!['pending_approval', 'suggested'].includes(act.status)) throw new BadRequest('This action is no longer waiting for a decision');
    const now = this.now(), A = ACTIONS[act.kind];
    if (approve) {
      this.execute(act.kind, act.issue_id);
      this.db.prepare("UPDATE actions SET status = 'done', decided_at = ?, decided_by = ?, executed_at = ? WHERE id = ?").run(now, user.id, now, actionId);
      this.event('action_approved', 'user', user.name, `${user.name} approved: ${A.label}`, { issueId: act.issue_id, refTable: 'actions', refId: actionId });
    } else {
      this.db.prepare("UPDATE actions SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?").run(now, user.id, actionId);
      this.event('action_rejected', 'user', user.name, `${user.name} rejected: ${A.label}`, { issueId: act.issue_id, refTable: 'actions', refId: actionId });
    }
    this.audit(user, approve ? 'approve_action' : 'reject_action', { actionId, kind: act.kind });
  }

  revert(actionId, user) {
    const act = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
    if (!act) throw new BadRequest('No such action');
    const A = ACTIONS[act.kind];
    this.need(user, act.risk === 'physical' ? 'manager' : 'technician');
    if (act.status !== 'done' || !A.reversible) throw new BadRequest('This action cannot be undone');
    this.actuator.revert(act.kind, this.machineId);
    if (act.kind === 'stop_feed' || act.kind === 'safe_shutdown') { this.stopped = false; this.ew = null; this.cooldown = 10; }
    this.db.prepare("UPDATE actions SET status = 'reverted', reverted_at = ? WHERE id = ?").run(this.now(), actionId);
    this.event('action_reverted', 'user', user.name, `${user.name} undid: ${A.label}`, { issueId: act.issue_id, refTable: 'actions', refId: actionId });
    this.audit(user, 'revert_action', { actionId, kind: act.kind });
  }

  // ---- settings and demo control -------------------------------------------
  setSetting(key, value, user) {
    this.need(user, 'manager');
    if (!['automation_enabled', 'approval_stop_feed', 'approval_safe_shutdown'].includes(key)) throw new BadRequest('Unknown setting');
    const v = value ? '1' : '0';
    this.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, key);
    this.event('config_changed', 'user', user.name, `${user.name} set ${key.replace(/_/g, ' ')} to ${value ? 'on' : 'off'}`);
    this.audit(user, 'set_setting', { key, value: v });
    unusual.configChanged(this, key, !!value, user);
  }

  setCosts(body, user) {
    this.need(user, 'manager');
    const cur = this.costs(), next = {};
    for (const k of ['production_value_h', 'idle_labour_h', 'repair_labour_h', 'scrap_kg', 'energy_kwh']) {
      const n = Number(body[k]); next[k] = Number.isFinite(n) && n >= 0 ? n : cur[k];
    }
    this.db.prepare('UPDATE cost_params SET production_value_h = ?, idle_labour_h = ?, repair_labour_h = ?, scrap_kg = ?, energy_kwh = ? WHERE machine_id = ?')
      .run(next.production_value_h, next.idle_labour_h, next.repair_labour_h, next.scrap_kg, next.energy_kwh, this.machineId);
    this.event('config_changed', 'user', user.name, `${user.name} changed the cost parameters`, { data: { from: cur, to: next } });
    this.audit(user, 'set_costs', next);
  }

  injectFault(fault, user) {
    this.need(user, 'operator');
    if (fault && (!FAULTS[fault] || FAULTS[fault].untrained)) throw new BadRequest('Unknown fault');
    this.fault = fault || null; this.faultAt = this.t; this.faultSpeed = 1; this.faultSev = 1;
    this.event('demo_fault', 'user', user.name, fault ? `Demo: "${FAULTS[fault].name}" played into the simulated machine` : 'Demo: simulated machine set back to normal');
  }

  // Confidence below which no fault is named.
  setUnknownThreshold(value, user) {
    this.need(user, 'manager');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new BadRequest('The threshold must be between 0 and 1');
    const old = this.setting('unknown_threshold');
    this.db.prepare("UPDATE settings SET value = ? WHERE key = 'unknown_threshold'").run(String(n));
    this.event('config_changed', 'user', user.name, `${user.name} changed the unknown-anomaly threshold from ${Math.round(old * 100)} % to ${Math.round(n * 100)} %`);
    this.audit(user, 'set_unknown_threshold', { from: Number(old), to: n });
  }

  // Assumed values behind the risk projection and the simulator.
  assumptions() { return JSON.parse(this.setting('assumptions')); }
  setAssumptions(body, user) {
    this.need(user, 'manager');
    const cur = this.assumptions(), next = { rates_30d: {}, ttf_min: {} };
    const num = (v, old, lo, hi) => { const n = Number(v); return v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n >= lo && n <= hi ? n : old; };
    for (const k of Object.keys(cur.rates_30d)) next.rates_30d[k] = num((body.rates_30d || {})[k], cur.rates_30d[k], 0, 1000);
    for (const k of Object.keys(cur.ttf_min)) next.ttf_min[k] = num((body.ttf_min || {})[k], cur.ttf_min[k], 1, 100000);
    next.early_catch = num(body.early_catch, cur.early_catch, 0, 1);
    next.bearing_age_days = num(body.bearing_age_days, cur.bearing_age_days, 0, 100000);
    this.db.prepare("UPDATE settings SET value = ? WHERE key = 'assumptions'").run(JSON.stringify(next));
    this.event('config_changed', 'user', user.name, `${user.name} changed the projection assumptions`, { data: { from: cur, to: next } });
    this.audit(user, 'set_assumptions', next);
    return next;
  }

  // Demo control for unusual activity: freeze the pressure sensor, or leave the pump drawing power while stopped.
  setQuirk(quirk, user) {
    this.need(user, 'operator');
    if (quirk && !unusual.QUIRKS.includes(quirk)) throw new BadRequest('Unknown test');
    this.quirk = quirk || null;
    this.event('demo_fault', 'user', user.name, quirk ? `Demo: unusual-activity test "${quirk}" switched on` : 'Demo: unusual-activity test switched off');
  }

  // ---- live state for the dashboard ----------------------------------------
  state(since = 0, user = null) {
    const a = this.active, p = this.last || { maxAbsZ: 0, z: {} };
    const sevHealth = { critical: 12, high: 35, medium: 60, low: 80 };
    const health = this.stopped ? 0 : a ? sevHealth[a.severity] : Math.round(100 - Math.min(15, p.maxAbsZ * 2.5));
    const out = {
      seq: this.seq, ticks: this.ring.filter((r) => r.seq > since),
      machine: { id: this.machineId, name: this.machine.name, model: this.machine.model, target: this.machine.target_kg_h, stopped: this.stopped, fault: this.fault, quirk: this.quirk, health, status: this.stopped ? 'stopped' : a ? a.severity : 'ok' },
      z: p.z, automation: this.setting('automation_enabled') === '1', escalateAfterS: this.escalateAfterS, active: null, actions: [], inbox: [], flagAlerts: [],
    };
    if (a) {
      const T = TYPES[a.type] || TYPES.unknown;
      out.active = { id: a.id, type: a.type, label: T.label, title: a.title, cause: a.cause, check: T.check, comp: a.comp, severity: a.severity, confidence: a.confidence, low: a.low, note: a.note, original: a.original, sensor: a.sensor, candidate: a.candidate, sensorNote: a.sensorNote,
        detectedAt: a.detectedAt, acked: a.acked, level: a.level, rul: a.rul, loss: this.liveLoss(a), contributions: (this.last && this.last.contributions.length ? this.last.contributions : []).map((x) => x.text) };
      out.actions = this.db.prepare('SELECT id, kind, risk, status, reason FROM actions WHERE issue_id = ? ORDER BY id').all(a.id).map((x) => ({ ...x, label: ACTIONS[x.kind].label, reversible: ACTIONS[x.kind].reversible, warn: x.reason.startsWith('Low confidence') }));
    }
    if (user) out.flagAlerts = this.db.prepare("SELECT a.id, a.flag_id, a.sent_at, f.title, f.explanation, f.severity FROM flag_alerts a JOIN unusual_flags f ON f.id = a.flag_id WHERE a.user_id = ? AND a.channel = 'in_app' AND a.read_at IS NULL ORDER BY a.id DESC LIMIT 5").all(user.id);
    if (user) out.inbox = this.db.prepare("SELECT n.id, n.issue_id, n.level, n.sent_at, i.type, i.title AS issue_title, i.severity FROM notifications n JOIN issues i ON i.id = n.issue_id WHERE n.user_id = ? AND n.channel = 'in_app' AND n.acked_at IS NULL AND i.status = 'detected' ORDER BY n.id DESC LIMIT 5").all(user.id)
      .map((n) => ({ ...n, title: n.issue_title || (TYPES[n.type] || TYPES.unknown).title }));
    return out;
  }
}

module.exports = { Sentinel, Forbidden, BadRequest, RANK };
