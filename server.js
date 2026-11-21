// AP800 Sentinel local server. No dependencies: `node server.js`, then open http://localhost:4800
// Serves the website, accepts sensor readings on POST /api/ingest and relays them to open dashboards on GET /api/stream.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, 'public');
const PORT = process.env.PORT || 4800;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp4': 'video/mp4', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const clients = new Set();

// index.html is written as a page fragment (so it can also be published as an artifact); wrap it for normal browsers.
const wrap = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/ingest' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body);
        const msg = JSON.stringify({ device: String(m.device || 'phone').slice(0, 40), vib_rms: Number(m.vib_rms), vib_peak: Number(m.vib_peak), ts: Date.now() });
        clients.forEach((c) => c.write(`data: ${msg}\n\n`));
        res.writeHead(204).end();
      } catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Body must be JSON like {"vib_rms":0.42}'); }
    });
    return;
  }

  if (url.pathname === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, dashboards: clients.size })); return; }

  // static files
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
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
}).listen(PORT, () => console.log(`AP800 Sentinel running at http://localhost:${PORT}`));
