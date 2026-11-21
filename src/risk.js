// Monte Carlo risk projection. Read-only: draws random futures from event rates and returns statistics.
// Event rates are placeholders blended with whatever real issue history exists; they are not measured AP800 failure rates.
const { TYPES } = require('./catalog');
const loss = require('./loss');

// Assumed events per 30 operating days before any history is recorded.
const PRIOR_30D = { hopper: 6, tear: 4, wrap: 1.5, starve: 5, block: 1, cell: 3, bearing: 0.3, jam: 1.2 };
const PRIOR_WEIGHT_DAYS = 30;
const BEARING = { ageDays: 150, scaleDays: 420, shape: 3 };   // wear-out: risk climbs with days since the bearing was last changed
const HORIZONS = [7, 30, 90];

function poisson(lambda) { if (lambda <= 0) return 0; const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; }
const weibullCum = (d) => Math.pow(d / BEARING.scaleDays, BEARING.shape);
// expected number of events of a type between day a and day b from now
function expected(type, ratePerDay, a, b) {
  if (type !== 'bearing') return ratePerDay * (b - a);
  const wear = weibullCum(BEARING.ageDays + b) - weibullCum(BEARING.ageDays + a);
  return wear + ratePerDay * (b - a) * 0.3;
}

function project(db, model, { runs = 2000, runtimeDays = 0, active = null } = {}) {
  const c = db.prepare('SELECT * FROM cost_params WHERE machine_id = 1').get();
  const seen = Object.fromEntries(db.prepare('SELECT type, COUNT(*) n FROM issues WHERE is_simulated = 0 GROUP BY type').all().map((r) => [r.type, r.n]));
  const detect = Math.min(0.98, model.metrics.recall);       // chance an event is caught early, capped: synthetic recall is optimistic
  const types = Object.keys(PRIOR_30D).map((k) => {
    const T = TYPES[k];
    return { type: k, label: T.label, station: T.comp[0], rate: (PRIOR_30D[k] + (seen[k] || 0)) / (PRIOR_WEIGHT_DAYS + runtimeDays), fail: loss.eventCost(T.failure, c), prev: loss.eventCost(T.preventive, c), observed: seen[k] || 0 };
  });

  const horizons = HORIZONS.map((days) => {
    const totals = new Float64Array(runs), without = new Float64Array(runs); let withFailure = 0;
    const perType = Object.fromEntries(types.map((t) => [t.type, 0]));
    for (let r = 0; r < runs; r++) {
      let sum = 0, sumNo = 0, failed = false;
      for (const t of types) {
        let n = poisson(expected(t.type, t.rate, 0, days));
        if (active && active.type === t.type && Math.random() < active.fail_prob) n++;      // an open issue adds its own failure chance
        for (let i = 0; i < n; i++) { const caught = Math.random() < detect; const cost = caught ? t.prev : t.fail; if (!caught) failed = true; sum += cost; sumNo += t.fail; perType[t.type] += cost; }
      }
      totals[r] = sum; without[r] = sumNo; if (failed) withFailure++;
    }
    const sorted = Array.from(totals).sort((a, b) => a - b), mean = (a) => a.reduce((p, x) => p + x, 0) / a.length;
    const out = { days, p_failure: +(withFailure / runs).toFixed(3), expected_loss: Math.round(mean(sorted)), p5: Math.round(sorted[Math.floor(runs * 0.05)]), p95: Math.round(sorted[Math.floor(runs * 0.95)]),
      expected_loss_without_monitoring: Math.round(mean(Array.from(without))), perType: Object.fromEntries(Object.entries(perType).map(([k, v]) => [k, Math.round(v / runs)])) };
    if (days === 30) {
      const lo = sorted[0], hi = sorted[sorted.length - 1], bins = 24, w = (hi - lo) / bins || 1, counts = new Array(bins).fill(0);
      for (const v of sorted) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
      out.histogram = counts.map((n, i) => ({ from: Math.round(lo + i * w), to: Math.round(lo + (i + 1) * w), share: +(n / runs).toFixed(4) }));
    }
    return out;
  });

  const h30 = horizons.find((h) => h.days === 30);
  const ranking = types.map((t) => ({ type: t.type, label: t.label, station: t.station, observed: t.observed, events_30d: +expected(t.type, t.rate, 0, 30).toFixed(2),
    p_event_30d: +(1 - Math.exp(-expected(t.type, t.rate, 0, 30))).toFixed(3), expected_loss_30d: h30.perType[t.type], cost_if_missed: t.fail }))
    .sort((a, b) => b.expected_loss_30d - a.expected_loss_30d);
  const weeks = 13;
  const heatmap = ranking.map((r) => { const t = types.find((x) => x.type === r.type);
    return { type: r.type, label: r.label, weeks: Array.from({ length: weeks }, (_, w) => { let p = 1 - Math.exp(-expected(t.type, t.rate, w * 7, w * 7 + 7)); if (w === 0 && active && active.type === t.type) p = Math.max(p, active.fail_prob); return +p.toFixed(3); }) }; });
  const upcoming = ranking.filter((r) => r.p_event_30d > 0.5).map((r) => ({ label: r.label, station: r.station, p: r.p_event_30d, cost_if_missed: r.cost_if_missed }));
  return { simulated: true, runs, detect, currency: c.currency, horizons, ranking, heatmap, upcoming,
    assumptions: `Rates start from placeholder values and move toward recorded history as issues accumulate. Bearing risk assumes the bearing was last changed ${BEARING.ageDays} days ago. An event is assumed caught early ${Math.round(detect * 100)} % of the time.` };
}

module.exports = { project, PRIOR_30D };
