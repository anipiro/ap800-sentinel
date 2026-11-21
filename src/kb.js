// Root-cause knowledge base: what was really wrong and how it was fixed, recorded when an issue is resolved,
// and shown again when a similar issue appears.
const { TYPES } = require('./catalog');

function record(db, { issueId, rootCause, fix, parts, minutes, by, now = Date.now() }) {
  const i = db.prepare('SELECT id, type, title FROM issues WHERE id = ?').get(issueId);
  if (!i) return null;
  const clean = (s, n) => String(s || '').trim().slice(0, n);
  if (!clean(rootCause, 300) && !clean(fix, 300)) return null;          // nothing worth keeping
  const mins = Number(minutes);
  return Number(db.prepare('INSERT INTO kb_entries (issue_id, type, title, root_cause, fix, parts, minutes, recorded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(i.id, i.type, i.title || (TYPES[i.type] || TYPES.unknown).title, clean(rootCause, 300) || 'Not recorded', clean(fix, 300) || 'Not recorded', clean(parts, 200) || null, Number.isFinite(mins) && mins >= 0 ? mins : null, by || null, now).lastInsertRowid);
}

// Past fixes for the same kind of issue, newest first. A sensor issue matches on its exact title (which names the sensor).
function similar(db, { type, title = null, excludeIssue = null, limit = 3 }) {
  const rows = type === 'sensor' && title
    ? db.prepare('SELECT * FROM kb_entries WHERE type = ? AND title = ? AND issue_id IS NOT ? ORDER BY id DESC LIMIT ?').all(type, title, excludeIssue, limit)
    : db.prepare('SELECT * FROM kb_entries WHERE type = ? AND issue_id IS NOT ? ORDER BY id DESC LIMIT ?').all(type, excludeIssue, limit);
  return rows;
}

function search(db, q = '', limit = 100) {
  const like = `%${String(q).trim()}%`;
  return db.prepare('SELECT * FROM kb_entries WHERE title LIKE ? OR root_cause LIKE ? OR fix LIKE ? OR parts LIKE ? ORDER BY id DESC LIMIT ?').all(like, like, like, like, limit)
    .map((e) => ({ ...e, label: (TYPES[e.type] || TYPES.unknown).label }));
}

module.exports = { record, similar, search };
