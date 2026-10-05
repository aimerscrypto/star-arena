'use strict';

/**
 * Star Arena server entry point.
 * One process, one port: serves the static client over HTTP and the game over
 * WebSocket (/ws). Deploys as a single web service (e.g. Render).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { Game } = require('./game');

const ROOT = path.join(__dirname, '..');
const STATIC_DIRS = {
  '/shared/': path.join(ROOT, 'shared'),
  '/': path.join(ROOT, 'client'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const game = new Game(config);

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { urlPath = '/'; }

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (urlPath === '/api/stats') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(game.lastStats || {}));
  }

  const prefix = urlPath.startsWith('/shared/') ? '/shared/' : '/';
  const base = STATIC_DIRS[prefix];
  let rel = urlPath.slice(prefix.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) { // path traversal guard
    res.writeHead(403);
    return res.end();
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const etag = '"' + st.size.toString(36) + '-' + st.mtimeMs.toString(36) + '"';
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // always revalidate; unchanged files answer 304
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    loadCached(file, etag, (err2, entry) => {
      if (err2) { res.writeHead(500); return res.end(); }
      const gzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      if (gzip) headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      res.end(gzip ? entry.gz : entry.raw);
    });
  });
}

// Small in-memory cache with pre-gzipped text assets (pixi.min.js is ~800 KB raw, ~230 KB gzipped).
const fileCache = new Map();
function loadCached(file, etag, cb) {
  const hit = fileCache.get(file);
  if (hit && hit.etag === etag) return cb(null, hit);
  fs.readFile(file, (err, raw) => {
    if (err) return cb(err);
    const text = /\.(js|css|html|svg|json)$/.test(file);
    const entry = { etag, raw, gz: text && raw.length > 1024 ? zlib.gzipSync(raw) : null };
    fileCache.set(file, entry);
    cb(null, entry);
  });
}

const server = http.createServer(serveStatic);

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: config.MAX_MSG_BYTES,
  perMessageDeflate: false, // compression costs CPU per client; we send compact binary instead
});
wss.on('connection', (ws) => game.addConnection(ws));

server.listen(config.PORT, () => {
  console.log(`Star Arena running on http://localhost:${config.PORT}  (bots: ${config.BOT_COUNT}, tick: 20 Hz)`);
});

game.start();
