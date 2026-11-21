// Retrain the detection model on freshly generated synthetic data and make it the active version.
// Usage: npm run train     (restart the server afterwards to load it)
const { open } = require('../src/db');
const { retrain, FILE } = require('../src/model-store');

const db = open();
const { model, versionId } = retrain(db);
console.log(`Model version ${versionId} trained at ${model.trainedAt}`);
console.log(`Saved to ${FILE}`);
console.log('Metrics on a fresh synthetic test set (not real machine data):');
console.log(JSON.stringify(model.metrics, null, 2));
