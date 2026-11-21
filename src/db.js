// SQLite connection and migration runner (node:sqlite, built into Node).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function open(file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sentinel.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT)');
  const dir = path.join(__dirname, '..', 'migrations');
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      db.prepare('INSERT INTO _migrations VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

module.exports = { open };
