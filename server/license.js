'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { getMachineFingerprint, getLegacyMachineFingerprint } = require('./machine');
const DATA_DIR = require('./data-path');
const LICENSE_FILE = path.join(DATA_DIR, '.license.json');
const CONFIG_FILE = path.join(DATA_DIR, 'license-config.json');
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, 'license-public-key.pem'), 'utf8');
const PRODUCT = 'alawa-system';
const GRACE_MS = 7 * 864e5;
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
function save(f, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempPath = `${f}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, f);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
    throw error;
  }
}
function matchesCurrentDevice(token) {
  const fingerprint = token?.fingerprint;
  return fingerprint === getMachineFingerprint() || fingerprint === getLegacyMachineFingerprint();
}
function signed(record) {
  if (!record || typeof record.payload !== 'string' || typeof record.signature !== 'string') return null;
  if (!crypto.verify(null, Buffer.from(record.payload), PUBLIC_KEY, Buffer.from(record.signature, 'base64'))) return null;
  try { return JSON.parse(record.payload); } catch (_) { return null; }
}
function status() {
  const record = read(LICENSE_FILE); const token = signed(record);
  if (!token) return { valid: false, reason: 'NOT_ACTIVATED' };
  if (token.product === PRODUCT && token.licenseType === 'offline') {
    if (!matchesCurrentDevice(token)) return { valid: false, reason: 'DEVICE_MISMATCH' };
    if (token.expiresAt !== null) {
      const expiry = Date.parse(token.expiresAt);
      if (!Number.isFinite(expiry) || Date.now() > expiry) return { valid: false, reason: 'EXPIRED' };
    }
    return { valid: true, licenseType: 'offline', expiresAt: token.expiresAt, licenseKey: token.licenseKey };
  }

  // Keep previously issued server licences working during their signed offline grace period.
  if (!matchesCurrentDevice(token)) return { valid: false, reason: 'DEVICE_MISMATCH' };
  const now = Date.now(), expiry = Date.parse(token.expiresAt), offlineUntil = Date.parse(token.offlineUntil);
  if (token.revoked || !Number.isFinite(expiry) || now > expiry) return { valid: false, reason: 'EXPIRED' };
  if (!Number.isFinite(offlineUntil) || now > offlineUntil) return { valid: false, reason: 'CHECK_REQUIRED' };
  if (Date.parse(record.lastValidatedAt || 0) > now + 5 * 60 * 1000) return { valid: false, reason: 'CLOCK_ROLLBACK' };
  if (Date.now() - Date.parse(record.lastValidatedAt || 0) > GRACE_MS) return { valid: false, reason: 'CHECK_REQUIRED' };
  return { valid: true, licenseType: 'legacy-online', expiresAt: token.expiresAt, lastValidatedAt: record.lastValidatedAt, licenseKey: token.licenseKey };
}
function createActivationRequest() {
  return {
    format: 'alawa-activation-request-v1',
    product: PRODUCT,
    requestId: crypto.randomUUID(),
    fingerprint: getMachineFingerprint(),
    createdAt: new Date().toISOString()
  };
}
function activate({ license } = {}) {
  const token = signed(license);
  if (!token) throw new Error('ملف الترخيص غير صالح أو توقيعه غير صحيح');
  if (token.product !== PRODUCT || token.licenseType !== 'offline') throw new Error('هذا الملف ليس ترخيصاً دون اتصال لهذا البرنامج');
  if (!/^ALAWA-[A-F0-9]{16}$/.test(String(token.licenseKey || ''))) throw new Error('رقم الترخيص داخل الملف غير صالح');
  if (!/^[a-f0-9]{64}$/i.test(String(token.fingerprint || '')) || token.fingerprint !== getMachineFingerprint()) throw new Error('هذا الترخيص صادر لجهاز آخر');
  if (token.expiresAt !== null) {
    const expiry = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiry) || Date.now() > expiry) throw new Error('انتهت صلاحية ملف الترخيص');
  }
  if (!token.requestId || typeof token.issuedAt !== 'string') throw new Error('بيانات الترخيص ناقصة');
  save(LICENSE_FILE, { payload: license.payload, signature: license.signature });
  try { fs.rmSync(CONFIG_FILE, { force: true }); } catch (_) {}
  return status();
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
async function refresh() {
  const record = read(LICENSE_FILE); const token = signed(record); const serverUrl = (read(CONFIG_FILE) || {}).serverUrl;
  if (!token || !serverUrl || token.licenseType === 'offline') return status();
  const fresh = await call(serverUrl, '/v1/validate', { licenseKey: token.licenseKey, fingerprint: getMachineFingerprint() });
  if (!signed(fresh)) throw new Error('توقيع الترخيص غير صالح');
  save(LICENSE_FILE, { ...fresh, lastValidatedAt: new Date().toISOString() }); return status();
}
function initLicense() { refresh().catch(() => {}); return status().valid; }
module.exports = { status, createActivationRequest, activate, refresh, initLicense };
