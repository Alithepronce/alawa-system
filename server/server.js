// server.js — the whole backend, using only Node's built-in modules (http, node:sqlite, crypto).
// Run with:  node server/server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const db = require('./db');
const auth = require('./auth');
const api = require('./api');
const license = require('./license');
require('./migrations');
const autoBackup = require('./auto_backup');

const PORT = process.env.PORT || 3000;
const HOST = process.env.ALAWA_HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Alawa-System': 'desktop',
    'Content-Length': Buffer.byteLength(body),
    // Basic hardening headers
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX = 20 * 1024 * 1024; // 20MB — maximum structured JSON backup/import payload
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) { reject(new Error('حجم الطلب كبير جداً')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON غير صالح')); }
    });
    req.on('error', reject);
  });
}

// Simple in-memory sliding-window rate limiter per IP for API endpoints
const ipRequests = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 300;

function checkRateLimit(ip) {
  const now = Date.now();
  let record = ipRequests.get(ip);
  if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
    record = { startTime: now, count: 1 };
    ipRequests.set(ip, record);
    return true;
  }
  record.count++;
  return record.count <= MAX_REQUESTS_PER_WINDOW;
}

// Cleanup stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipRequests.entries()) {
    if (now - rec.startTime > RATE_LIMIT_WINDOW_MS * 2) {
      ipRequests.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname);
  // Prevent path traversal outside the public directory
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  // 30 seconds request timeout
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.writeHead(408, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('انتهت مهلة الطلب (Request Timeout)');
    }
    req.destroy();
  });

  const parsed = url.parse(req.url, true);
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); }
  catch (_) { return sendJSON(res, 400, { error: 'مسار الطلب غير صالح' }); }

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  // Rate limiting check on API endpoints
  const clientIp = req.socket.remoteAddress || '127.0.0.1';
  if (!checkRateLimit(clientIp)) {
    return sendJSON(res, 429, { error: 'طلبات كثيرة جداً — يرجى الانتظار قليلاً' });
  }

  // No business API is available until a signed, device-bound licence exists.
  const licenseRoutes = new Set(['/api/license/status', '/api/license/request', '/api/license/activate', '/api/license/refresh']);
  if (!licenseRoutes.has(pathname) && !license.status().valid) {
    return sendJSON(res, 402, { error: 'يلزم تفعيل ترخيص النظام لهذا الجهاز', license: license.status() });
  }

  // ---- Auth context for every /api/ request ----
  const cookies = auth.parseCookies(req);
  const session = auth.getSessionUser(cookies.session);
  const ctx = { req, res, query: parsed.query, session, ip: clientIp };

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  ctx.body = body;

  try {
    const result = await api.route(req.method, pathname, ctx);
    if (result === null) return sendJSON(res, 404, { error: 'غير موجود' });
    if (result.setCookie) res.setHeader('Set-Cookie', result.setCookie);
    sendJSON(res, result.status || 200, result.data);
  } catch (e) {
    if (e.httpStatus) return sendJSON(res, e.httpStatus, { error: e.message });
    console.error(e);
    sendJSON(res, 500, { error: 'خطأ داخلي في الخادم' });
  }
});

let shuttingDown = false;
function sendProcessMessage(message, callback = () => {}) {
  if (typeof process.send !== 'function') return callback();
  try { process.send(message, callback); } catch (_) { callback(); }
}

function shutdownServer() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(error => {
    if (error) {
      shuttingDown = false;
      return sendProcessMessage({ type: 'shutdown-failed', error: error.message });
    }
    try {
      const backup = autoBackup.createBackup();
      if (!backup) throw new Error('قاعدة البيانات غير موجودة لإنشاء نسخة احتياطية');
      db.exec('PRAGMA wal_checkpoint(FULL);');
      db.close();
      sendProcessMessage({ type: 'shutdown-complete', backupFile: backup.filename }, () => process.exit(0));
    } catch (shutdownError) {
      // Keep the service available if the verified backup cannot be created.
      server.listen(PORT, HOST, () => {
        shuttingDown = false;
        sendProcessMessage({ type: 'shutdown-failed', error: shutdownError.message });
      });
    }
  });
}

if (typeof process.send === 'function') {
  process.on('message', message => {
    if (message?.type === 'shutdown') shutdownServer();
  });
}
process.on('SIGINT', shutdownServer);
process.on('SIGTERM', shutdownServer);

function checkDatabaseIntegrity() {
  try {
    const row = db.prepare('PRAGMA integrity_check;').get();
    const result = Object.values(row)[0];
    if (result === 'ok') {
      console.log('  Database integrity: OK (سليمة)');
    } else {
      console.error('  WARNING: Database integrity issues detected:', result);
    }
  } catch (err) {
    console.error('  Failed to run integrity check:', err.message);
  }
}

function seedDefaultOwner() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return;
  const auth2 = require('./auth');
  const defaultPin = '1234';
  const { hash, salt } = auth2.hashPassword(defaultPin);
  db.prepare('INSERT INTO users (name, role, password_hash, salt, must_change_password) VALUES (?,?,?,?,1)').run('المالك', 'المالك', hash, salt);
  console.log('  Default owner account created — name: المالك — PIN: 1234');
  console.log('  Change this PIN immediately from the Users screen after first login.\n');
}

checkDatabaseIntegrity();
seedDefaultOwner();
license.initLicense();

server.listen(PORT, HOST, () => {
  console.log(`\n  Alawa Management System — server is running`);
  console.log(`  Open your browser at: http://localhost:${PORT}\n`);
});
