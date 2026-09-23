'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { getMachineFingerprint } = require('./machine');
const DATA_DIR = require('./data-path');
const LICENSE_FILE = path.join(DATA_DIR, '.license.json');
const CONFIG_FILE = path.join(DATA_DIR, 'license-config.json');
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, 'license-public-key.pem'), 'utf8');
const GRACE_MS = 7 * 864e5;
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const save = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
function signed(record) {
  if (!record || !record.payload || !record.signature || !crypto.verify(null, Buffer.from(record.payload), PUBLIC_KEY, Buffer.from(record.signature, 'base64'))) return null;
  try { return JSON.parse(record.payload); } catch (_) { return null; }
}
function status() {
  const record = read(LICENSE_FILE); const token = signed(record); const serverUrl = (read(CONFIG_FILE) || {}).serverUrl || '';
  if (!token) return { valid: false, reason: 'NOT_ACTIVATED', serverUrl };
  if (token.fingerprint !== getMachineFingerprint()) return { valid: false, reason: 'DEVICE_MISMATCH', serverUrl };
  const now = Date.now(), expiry = Date.parse(token.expiresAt), offlineUntil = Date.parse(token.offlineUntil);
  if (token.revoked || !Number.isFinite(expiry) || now > expiry) return { valid: false, reason: 'EXPIRED', serverUrl };
  if (!Number.isFinite(offlineUntil) || now > offlineUntil) return { valid: false, reason: 'CHECK_REQUIRED', serverUrl };
  if (Date.parse(record.lastValidatedAt || 0) > now + 5 * 60 * 1000) return { valid: false, reason: 'CLOCK_ROLLBACK', serverUrl };
  if (Date.now() - Date.parse(record.lastValidatedAt || 0) > GRACE_MS) return { valid: false, reason: 'CHECK_REQUIRED', serverUrl };
  return { valid: true, expiresAt: token.expiresAt, lastValidatedAt: record.lastValidatedAt, licenseKey: token.licenseKey };
}
function call(serverUrl, endpoint, body) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(endpoint, serverUrl); } catch (_) { return reject(new Error('عنوان خادم الترخيص غير صالح')); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return reject(new Error('خادم الترخيص يجب أن يستخدم HTTPS'));
    const data = Buffer.from(JSON.stringify(body)); const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 10000 }, res => { let raw=''; res.on('data', c => raw += c); res.on('end', () => { try { const v=JSON.parse(raw); res.statusCode < 300 ? resolve(v) : reject(new Error(v.error || 'فشل التحقق')); } catch (_) { reject(new Error('استجابة غير صالحة')); } }); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('انتهت مهلة الاتصال'))); req.end(data);
  });
}
async function activate({ licenseKey, serverUrl }) {
  const record = await call(serverUrl, '/v1/activate', { licenseKey: String(licenseKey || '').trim(), fingerprint: getMachineFingerprint() });
  if (!signed(record)) throw new Error('توقيع الترخيص غير صالح');
  save(LICENSE_FILE, { ...record, lastValidatedAt: new Date().toISOString() }); save(CONFIG_FILE, { serverUrl }); return status();
}
async function refresh() {
  const record = read(LICENSE_FILE); const token = signed(record); const serverUrl = (read(CONFIG_FILE) || {}).serverUrl;
  if (!token || !serverUrl) return status();
  const fresh = await call(serverUrl, '/v1/validate', { licenseKey: token.licenseKey, fingerprint: getMachineFingerprint() });
  if (!signed(fresh)) throw new Error('توقيع الترخيص غير صالح');
  save(LICENSE_FILE, { ...fresh, lastValidatedAt: new Date().toISOString() }); return status();
}
function initLicense() { refresh().catch(() => {}); return status().valid; }
module.exports = { status, activate, refresh, initLicense };
