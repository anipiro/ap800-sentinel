// Issue detection: Isolation Forest + deviation check for "is something wrong",
// nearest-centroid classifier for "what is it", per-signal deviation for "why".
// All training data is synthetic (src/sim.js). Metrics describe the simulator, not a real machine.
const { SIG, KEYS, TRAINED, sample, smooth } = require('../sim');
const iforest = require('./iforest');

const DT = 0.5, CLIP = 40, Z_ALERT = 6;
const GRACE = { tear: 3, hopper: 5, wrap: 4, starve: 3, block: 3, cell: 3, bearing: 8, jam: 2 }; // seconds before a fault is expected to be visible

function sequence(fault, ticks) {
  let ew = null, t = Math.random() * 5000;
  for (let i = 0; i < 12; i++) { ew = smooth(ew, sample(t, null, 0)); t += DT; }   // warm up
  const out = [];
  for (let i = 0; i < ticks; i++) { ew = smooth(ew, sample(t, fault, i * DT)); t += DT; out.push({ v: ew, age: i * DT }); }
  return out;
}

const zvec = (base, v) => KEYS.map((k) => Math.max(-CLIP, Math.min(CLIP, (v[k] - base[k].mean) / base[k].sd)));
const unit = (a) => { const n = Math.hypot(...a) || 1; return a.map((x) => x / n); };
const meanVec = (rows) => rows[0].map((_, j) => rows.reduce((p, r) => p + r[j], 0) / rows.length);

function train() {
  const normal = sequence(null, 4000).map((s) => s.v);
  const base = {};
  KEYS.forEach((k) => {
    const a = normal.map((v) => v[k]), mean = a.reduce((p, c) => p + c, 0) / a.length;
    const sd = Math.sqrt(a.reduce((p, c) => p + (c - mean) ** 2, 0) / a.length);
    base[k] = { mean, sd: Math.max(sd, 0.02 * Math.abs(mean), SIG[k].floor || 1e-6) };
  });
  const Xn = normal.map((v) => zvec(base, v));

  // fault examples: used as contamination for the forest and as class centroids
  const centroids = {}, Xf = [];
  for (const f of TRAINED) {
    const early = [], late = [];
    for (let run = 0; run < 6; run++) for (const s of sequence(f, 140)) {
      if (s.age < GRACE[f]) continue;
      const z = zvec(base, s.v); Xf.push(z);
      if (s.age <= GRACE[f] + 8) early.push(unit(z)); else if (s.age >= 25) late.push(unit(z));
    }
    centroids[f] = [unit(meanVec(early)), unit(meanVec(late))];
  }
  const contamination = Xf.filter(() => Math.random() < (0.06 * Xn.length) / Xf.length);
  const forest = iforest.fit(Xn.concat(contamination), { trees: 100, sample: 256 });
  const ns = Xn.map((x) => iforest.score(forest, x)).sort((a, b) => a - b);
  const thr = ns[Math.floor(ns.length * 0.999)] + 0.01;

  const model = { version: 1, trainedAt: new Date().toISOString(), base, forest, thr, centroids };
  model.metrics = evaluate(model);
  return model;
}

// Fresh synthetic test set. Sample-level metrics, fault samples inside the grace period are ignored.
function evaluate(model) {
  const det = new IssueDetector(model);
  let tp = 0, fp = 0, tn = 0, fn = 0, tpIf = 0, fpIf = 0, typed = 0;
  for (const s of sequence(null, 3000)) { const p = det.predict(1, s.v); p.anomaly ? fp++ : tn++; if (p.forestHit) fpIf++; }
  for (const f of TRAINED) for (let run = 0; run < 3; run++) for (const s of sequence(f, 140)) {
    if (s.age < GRACE[f]) continue;
    const p = det.predict(1, s.v);
    if (p.anomaly) { tp++; if (p.type === f) typed++; } else fn++;
    if (p.forestHit) tpIf++;
  }
  const r4 = (x) => Math.round(x * 10000) / 10000;
  return {
    data: 'synthetic', test_samples: tp + fp + tn + fn,
    precision: r4(tp / Math.max(1, tp + fp)), recall: r4(tp / Math.max(1, tp + fn)), false_positive_rate: r4(fp / Math.max(1, fp + tn)),
    type_accuracy: r4(typed / Math.max(1, tp)),
    forest_only: { precision: r4(tpIf / Math.max(1, tpIf + fpIf)), recall: r4(tpIf / Math.max(1, tp + fn)), false_positive_rate: r4(fpIf / Math.max(1, fp + tn)) },
  };
}

class IssueDetector {
  constructor(model) { this.model = model; }

  // readings: smoothed value per signal. Returns the verdict plus what drove it.
  predict(machineId, readings) {
    const m = this.model, z = zvec(m.base, readings);
    const score = iforest.score(m.forest, z);
    const maxAbs = Math.max(...z.map(Math.abs));
    const forestHit = score > m.thr, zHit = maxAbs > Z_ALERT;
    const anomaly = forestHit || zHit;

    const u = unit(z);
    let type = 'unknown', sim = 0;
    for (const [name, cs] of Object.entries(m.centroids)) for (const cv of cs) {
      const d = cv.reduce((p, x, i) => p + x * u[i], 0);
      if (d > sim) { sim = d; type = name; }
    }
    if (sim < 0.45) type = 'unknown';
    const strength = 1 - Math.exp(-Math.max(0, maxAbs - Z_ALERT) / 8);
    const confidence = anomaly ? Math.min(0.99, (0.55 + 0.45 * strength) * (0.6 + 0.4 * Math.max(sim, 0))) : 0;

    const contributions = KEYS.map((k, i) => ({ key: k, z: z[i] }))
      .filter((c) => Math.abs(c.z) > 3).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 4)
      .map((c) => {
        const s = SIG[c.key], value = readings[c.key], normal = m.base[c.key].mean;
        const pct = Math.round((100 * Math.abs(value - normal)) / Math.abs(normal));
        return { key: c.key, label: s.label, unit: s.unit, value: +value.toFixed(s.dp), normal: +normal.toFixed(s.dp), z: +c.z.toFixed(1),
          text: `${s.label} is ${pct} % ${value > normal ? 'above' : 'below'} normal (${value.toFixed(s.dp)} ${s.unit}, normal ${normal.toFixed(s.dp)})` };
      });
    const zmap = {}; KEYS.forEach((k, i) => { zmap[k] = +z[i].toFixed(2); });
    return { machineId, anomaly, forestHit, score: +score.toFixed(4), type, typeSimilarity: +sim.toFixed(3), confidence: +confidence.toFixed(3), maxAbsZ: +maxAbs.toFixed(1), z: zmap, contributions };
  }
}

module.exports = { train, evaluate, IssueDetector, DT };
