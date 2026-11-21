// Trained model on disk (models/model.json) plus a row per version in model_versions.
const fs = require('fs');
const path = require('path');
const { train } = require('./ml/detector');

const FILE = path.join(__dirname, '..', 'models', 'model.json');

function register(db, model) {
  db.prepare('UPDATE model_versions SET active = 0').run();
  return Number(db.prepare('INSERT INTO model_versions (trained_at, metrics, active) VALUES (?, ?, 1)').run(model.trainedAt, JSON.stringify(model.metrics)).lastInsertRowid);
}

function retrain(db) {
  const model = train();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(model));
  return { model, versionId: register(db, model) };
}

function loadOrTrain(db) {
  if (!fs.existsSync(FILE)) return retrain(db);
  const model = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const row = db.prepare('SELECT id FROM model_versions WHERE trained_at = ?').get(model.trainedAt);
  return { model, versionId: row ? row.id : register(db, model) };
}

module.exports = { loadOrTrain, retrain, FILE };
