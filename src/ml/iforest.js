// Isolation Forest (Liu, Ting, Zhou 2008). Plain JS, JSON-serialisable.
const c = (n) => (n <= 1 ? 0 : n === 2 ? 1 : 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n);

function build(X, depth, maxDepth) {
  if (depth >= maxDepth || X.length <= 1) return { n: X.length };
  const dim = X[0].length;
  // pick a feature that actually varies in this node
  for (let tries = 0; tries < 8; tries++) {
    const f = Math.floor(Math.random() * dim);
    let lo = Infinity, hi = -Infinity;
    for (const x of X) { if (x[f] < lo) lo = x[f]; if (x[f] > hi) hi = x[f]; }
    if (hi - lo < 1e-12) continue;
    const s = lo + Math.random() * (hi - lo);
    const L = [], R = [];
    for (const x of X) (x[f] < s ? L : R).push(x);
    return { f, s, l: build(L, depth + 1, maxDepth), r: build(R, depth + 1, maxDepth) };
  }
  return { n: X.length };
}

function fit(X, { trees = 100, sample = 256 } = {}) {
  const psi = Math.min(sample, X.length), maxDepth = Math.ceil(Math.log2(psi));
  const forest = [];
  for (let t = 0; t < trees; t++) {
    const sub = [];
    for (let i = 0; i < psi; i++) sub.push(X[Math.floor(Math.random() * X.length)]);
    forest.push(build(sub, 0, maxDepth));
  }
  return { psi, forest };
}

function pathLength(node, x) {
  let d = 0;
  while (node.f !== undefined) { node = x[node.f] < node.s ? node.l : node.r; d++; }
  return d + c(node.n);
}

// Anomaly score in (0, 1): about 0.5 is ordinary, close to 1 is isolated quickly.
function score(model, x) {
  let sum = 0;
  for (const tree of model.forest) sum += pathLength(tree, x);
  return Math.pow(2, -(sum / model.forest.length) / c(model.psi));
}

module.exports = { fit, score };
