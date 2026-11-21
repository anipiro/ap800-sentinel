// AP800 Sentinel server. No npm dependencies. Start with: npm start   then open http://localhost:4800
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('./src/db');
const { loadOrTrain } = require('./src/model-store');
const { Sentinel, Forbidden, BadRequest } = require('./src/core');
const { InAppNotifier, TelegramNotifier, MockActuator } = require('./src/adapters');
const { SIG, FAULTS } = require('./src/sim');
const reports = require('./src/reports');

const PUB = path.join(__dirname, 'public');
const PORT = process.env.PORT || 4800;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp4': 'video/mp4', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const db = open();
const { model, versionId } = loadOrTrain(db);
const engine = new Sentinel({ db, model, modelVersionId: versionId, notifiers: [new InAppNotifier(), new TelegramNotifier()], actuator: new MockActuator(), escalateAfterS: Number(process.env.ESCALATE_AFTER_S) || 20 });
setInterval(() => { try { engine.tick(); } catch (e) { console.error('tick failed:', e); } }, 500);

// ---- sessions (demo sign-in: pick a person, no password) --------------------
const sessions = new Map();
const userOf = (req) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const id = m && sessions.get(m[1]);
  return id ? db.prepare('SELECT id, name, role, shift FROM users WHERE id = ?').get(id) : null;
};

// ---- phone sensor ----------------------------------------------------------
const phone = { hist: [], last: 0 };

const wrap = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 20000) { reject(new BadRequest('Request too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new BadRequest('Body must be JSON')); } });
});
const csv = (res, name, rows) => { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }); res.end(reports.toCsv(rows)); };

async function api(req, res, url) {
  const p = url.pathname, q = Object.fromEntries(url.searchParams), user = userOf(req);
  const GET = req.method === 'GET', POST = req.method === 'POST';
  let m;

  if (p === '/api/health') return send(res, 200, { ok: true });
  if (p === '/api/people' && GET) return send(res, 200, db.prepare('SELECT id, name, role FROM users ORDER BY id').all());
  if (p === '/api/login' && POST) {
    const body = await readBody(req);
    const u = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(Number(body.user_id));
    if (!u) throw new BadRequest('Unknown person');
    const sid = crypto.randomBytes(24).toString('hex'); sessions.set(sid, u.id);
    engine.audit(u, 'login');
    return send(res, 200, u, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
  }
  if (p === '/api/ingest' && POST) {
    const body = await readBody(req), v = Number(body.vib_rms);
    if (!Number.isFinite(v)) throw new BadRequest('Body must be JSON like {"vib_rms":0.42}');
    phone.hist.push(+v.toFixed(3)); if (phone.hist.length > 120) phone.hist.shift(); phone.last = Date.now();
    res.writeHead(204); return res.end();
  }

  if (!user) return send(res, 401, { error: 'Sign in first' });
  if (p === '/api/me') return send(res, 200, { user, signals: SIG, faults: Object.fromEntries(Object.entries(FAULTS).map(([k, f]) => [k, f.name])), model: { version: versionId, trained_at: model.trainedAt, metrics: model.metrics }, baseline: model.base, alertZ: 6, timeScale: engine.timeScale });
  if (p === '/api/logout' && POST) { const c = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (c) sessions.delete(c[1]); return send(res, 200, {}, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); }
  if (p === '/api/state' && GET) return send(res, 200, { ...engine.state(Number(q.since) || 0, user), phone: { hist: phone.hist, live: Date.now() - phone.last < 5000 } });

  if (p === '/api/issues' && GET) return send(res, 200, reports.issues(db));
  if ((m = /^\/api\/issues\/(\d+)$/.exec(p)) && GET) { const d = reports.issueDetail(db, Number(m[1])); return d ? send(res, 200, d) : send(res, 404, { error: 'No such issue' }); }
  if ((m = /^\/api\/issues\/(\d+)\/(ack|resolve|verify)$/.exec(p)) && POST) {
    const body = await readBody(req), id = Number(m[1]);
    if (m[2] === 'ack') engine.ack(id, user); else if (m[2] === 'resolve') engine.resolve(id, user, { note: String(body.note || '').slice(0, 300) }); else engine.verify(id, user);
    return send(res, 200, { ok: true });
  }
  if ((m = /^\/api\/actions\/(\d+)\/(approve|reject|revert)$/.exec(p)) && POST) {
    const id = Number(m[1]);
    if (m[2] === 'revert') engine.revert(id, user); else engine.decide(id, user, m[2] === 'approve');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/demo/fault' && POST) { const body = await readBody(req); engine.injectFault(body.fault || null, user); return send(res, 200, { ok: true }); }

  if (p === '/api/history' && GET) return send(res, 200, { events: reports.history(db, q), profile: reports.profile(db, engine.timeScale) });
  if (p === '/api/history.csv' && GET) return csv(res, 'ap800-history.csv', reports.history(db, { ...q, limit: 2000 }).map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })));
  if (p === '/api/summary' && GET) return send(res, 200, reports.summary(db, engine.state(engine.seq).machine.health));
  if (p === '/api/issues.csv' && GET) return csv(res, 'ap800-issues.csv', reports.issues(db, { limit: 2000 }).map((i) => ({ ...i, detected_at: new Date(i.detected_at).toISOString(), acked_at: i.acked_at && new Date(i.acked_at).toISOString(), resolved_at: i.resolved_at && new Date(i.resolved_at).toISOString() })));

  if (p === '/api/finance' && GET) { engine.need(user, 'manager'); return send(res, 200, reports.finance(db)); }
  if (p === '/api/settings' && GET) { engine.need(user, 'manager'); return send(res, 200, { settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value === '1'])), costs: engine.costs(),
    chain: db.prepare('SELECT r.level, u.name, u.role, u.shift FROM responsibilities r JOIN users u ON u.id = r.user_id ORDER BY r.level, u.id').all(), escalateAfterS: engine.escalateAfterS,
    audit: db.prepare('SELECT a.ts, u.name, a.action, a.detail FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 40').all() }); }
  if (p === '/api/settings' && POST) { const body = await readBody(req); engine.setSetting(String(body.key), !!body.value, user); return send(res, 200, { ok: true }); }
  if (p === '/api/costs' && POST) { engine.setCosts(await readBody(req), user); return send(res, 200, { ok: true }); }

  return send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => {
      if (e instanceof Forbidden) return send(res, 403, { error: e.message });
      if (e instanceof BadRequest) return send(res, 400, { error: e.message });
      console.error(e); send(res, 500, { error: 'Something went wrong on the server' });
    });
    return;
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch (e) { res.writeHead(400).end(); return; }
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (rel === '/index.html') { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(wrap(fs.readFileSync(file, 'utf8'))); return; }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    }
  });
}).listen(PORT, () => console.log(`AP800 Sentinel running at http://localhost:${PORT} (model v${versionId})`));
