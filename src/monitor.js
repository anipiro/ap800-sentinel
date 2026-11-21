// Model monitoring: is the data the model sees still like the data it was trained on?
// Every 60 healthy readings the average of each signal is compared with its training baseline.
// Drift score = the largest shift of any signal's average, in training standard deviations.
// A healthy line stays well under 1. A sustained shift means the baseline is stale (recipe change, new sensor, wear).
const { SIG, KEYS } = require('./sim');
const unusual = require('./unusual');

const WINDOW = 60;

function summarise(zRows) {
  let drift = 0, worst = null; const means = {};
  for (const k of KEYS) {
    const m = zRows.reduce((s, z) => s + (z[k] || 0), 0) / zRows.length;
    means[k] = +m.toFixed(2);
    if (Math.abs(m) > drift) { drift = Math.abs(m); worst = k; }
  }
  return { drift: +drift.toFixed(3), worst, means };
}

// Called on every tick of the live machine. Only clean readings count: no open issue, no anomaly, machine running.
function observe(eng, p) {
  if (eng.simulated || eng.stopped || eng.cooldown > 0 || eng.active || p.anomaly || !p.z || p.z.rate === undefined) return null;
  const m = (eng._mon = eng._mon || { z: [], score: 0 });
  m.z.push(p.z); m.score += p.score;
  if (m.z.length < WINDOW) return null;
  const s = summarise(m.z), meanScore = +(m.score / m.z.length).toFixed(4);
  eng._mon = { z: [], score: 0 };
  eng.db.prepare('INSERT INTO model_stats (ts, model_version_id, samples, drift, worst_signal, mean_score, detail) VALUES (?,?,?,?,?,?,?)').run(eng.now(), eng.modelVersionId, WINDOW, s.drift, s.worst, meanScore, JSON.stringify(s.means));
  const threshold = Number(eng.setting('drift_threshold')) || 2;
  if (s.drift > threshold) {
    const text = `The average ${SIG[s.worst].label.toLowerCase()} has moved ${s.drift.toFixed(1)} standard deviations from what the model was trained on (limit ${threshold}). The model's idea of "normal" is going stale; retrain it or check that sensor.`;
    const id = unusual.raise(eng, 'model_drift', new Date(eng.now()).toISOString().slice(0, 10), text, { drift: s.drift, signal: s.worst, threshold });
    if (id) unusual.alertPeople(eng, id, 3, `${eng.machine.name}: detection model drift. ${text}`, 'model drift');
  }
  return s;
}

function feedback(eng, issueId, verdict, user) {
  eng.need(user, 'technician');
  if (!['real', 'false_alarm'].includes(verdict)) throw Object.assign(new Error('Feedback must be "real" or "false_alarm"'), { status: 400 });
  const i = eng.db.prepare('SELECT id, title, type FROM issues WHERE id = ?').get(issueId);
  if (!i) throw Object.assign(new Error('No such issue'), { status: 400 });
  eng.db.prepare('INSERT INTO issue_feedback (issue_id, verdict, by_name, ts) VALUES (?,?,?,?)').run(issueId, verdict, user.name, eng.now());
  eng.event('model_feedback', 'user', user.name, `${user.name} marked issue ${issueId} as ${verdict === 'real' ? 'a real fault' : 'a false alarm'}`, { issueId });
}

function health(db, model, versionId, now = Date.now()) {
  const week = now - 7 * 24 * 3600000;
  const threshold = Number(db.prepare("SELECT value FROM settings WHERE key = 'drift_threshold'").get().value) || 2;
  const stats = db.prepare('SELECT ts, drift, worst_signal, mean_score FROM model_stats ORDER BY id DESC LIMIT 40').all().reverse();
  const last = stats[stats.length - 1] || null;
  const conf = db.prepare('SELECT AVG(confidence) c, COUNT(*) n FROM (SELECT confidence FROM issues ORDER BY id DESC LIMIT 20)').get();
  // the latest verdict per issue is the one that counts
  const fb = db.prepare('SELECT f.verdict, COUNT(*) n FROM issue_feedback f WHERE f.ts >= ? AND f.id = (SELECT MAX(id) FROM issue_feedback WHERE issue_id = f.issue_id) GROUP BY f.verdict').all(week);
  const falseAlarms = (fb.find((r) => r.verdict === 'false_alarm') || { n: 0 }).n, confirmed = (fb.find((r) => r.verdict === 'real') || { n: 0 }).n;
  const issues7d = db.prepare('SELECT COUNT(*) n FROM issues WHERE detected_at >= ?').get(week).n;
  const unversioned = db.prepare('SELECT COUNT(*) n FROM issues WHERE model_version_id IS NULL').get().n;
  return {
    version: versionId, trained_at: model.trainedAt, training_data: 'synthetic',
    drift: last ? last.drift : null, drift_signal: last ? (SIG[last.worst_signal] || {}).label || last.worst_signal : null, drift_threshold: threshold,
    status: !last ? 'collecting' : last.drift > threshold ? 'drifting' : 'ok', checked_at: last ? last.ts : null, windows: stats.length,
    trend: stats.map((s) => s.drift), mean_score: last ? last.mean_score : null, score_threshold: +model.thr.toFixed(4),
    avg_confidence: conf.n ? +conf.c.toFixed(3) : null, issues_7d: issues7d, false_alarms_7d: falseAlarms, confirmed_7d: confirmed, feedback_given_7d: falseAlarms + confirmed,
    issues_without_model_version: unversioned,
  };
}

function setDriftThreshold(eng, value, user) {
  eng.need(user, 'manager');
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 20) throw Object.assign(new Error('The drift limit must be between 0 and 20'), { status: 400 });
  const old = eng.setting('drift_threshold');
  eng.db.prepare("UPDATE settings SET value = ? WHERE key = 'drift_threshold'").run(String(n));
  eng.event('config_changed', 'user', user.name, `${user.name} changed the model drift limit from ${old} to ${n}`);
  eng.audit(user, 'set_drift_threshold', { from: Number(old), to: n });
}

module.exports = { observe, summarise, feedback, health, setDriftThreshold, WINDOW };
