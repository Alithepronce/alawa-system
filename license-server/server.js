'use strict';
// Deploy behind HTTPS. ADMIN_TOKEN must be long, random, and stored as a secret.
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const { DatabaseSync } = require('node:sqlite');
const PORT = Number(process.env.PORT || 8080); const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const PRIVATE_KEY_FILE = process.env.LICENSE_PRIVATE_KEY_FILE || path.join(__dirname, 'license-private.pem');
if (!ADMIN_TOKEN || !fs.existsSync(PRIVATE_KEY_FILE)) throw new Error('Set ADMIN_TOKEN and LICENSE_PRIVATE_KEY_FILE before starting.');
const privateKey = fs.readFileSync(PRIVATE_KEY_FILE, 'utf8'); const db = new DatabaseSync(process.env.LICENSE_DB || path.join(__dirname, 'licenses.db'));
db.exec('CREATE TABLE IF NOT EXISTS licenses (license_key TEXT PRIMARY KEY, expires_at TEXT NOT NULL, device_fingerprint TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
const reply = (res, code, body) => { const b=JSON.stringify(body); res.writeHead(code, {'content-type':'application/json','content-length':Buffer.byteLength(b)}); res.end(b); };
const sign = row => {
  const now = Date.now(), expiresAt = Date.parse(row.expires_at);
  const payload = JSON.stringify({ licenseKey: row.license_key, fingerprint: row.device_fingerprint, expiresAt: row.expires_at, revoked: !!row.revoked, checkedAt: new Date(now).toISOString(), offlineUntil: new Date(Math.min(expiresAt, now + 7 * 864e5)).toISOString() });
  return { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64') };
};
const body = req => new Promise((resolve,reject)=>{
  let s=''; req.on('data',c=>{ s+=c; if(s.length>65536){ reject(new Error('Request too large')); req.destroy(); } });
  req.on('end',()=>{ try { const value=JSON.parse(s || '{}'); if(!value || Array.isArray(value) || typeof value!=='object') throw new Error(); resolve(value); } catch(_){ reject(new Error('Invalid JSON')); } });
});
const attempts = new Map();
http.createServer(async (req,res)=>{
  try {
    if (req.method !== 'POST') return reply(res,405,{error:'Method not allowed'});
    const ip = req.socket.remoteAddress || 'unknown', now = Date.now();
    const rec = attempts.get(ip);
    if (rec && now - rec.start < 60000 && rec.count >= 60) return reply(res,429,{error:'Too many requests'});
    attempts.set(ip, !rec || now-rec.start>=60000 ? {start:now,count:1} : {...rec,count:rec.count+1});
    const b = await body(req);
    if (req.url === '/v1/activate' || req.url === '/v1/validate') {
      const key = String(b.licenseKey || ''), fingerprint = String(b.fingerprint || '');
      if (!/^ALAWA-[A-F0-9]{16}$/.test(key) || !/^[a-f0-9]{32,128}$/i.test(fingerprint)) return reply(res,400,{error:'بيانات الترخيص غير صالحة'});
      const row=db.prepare('SELECT * FROM licenses WHERE license_key=?').get(key);
      if(!row || row.revoked) return reply(res,403,{error:'مفتاح الترخيص غير صالح'});
      const expiry = Date.parse(row.expires_at);
      if(!Number.isFinite(expiry) || expiry<=Date.now()) return reply(res,403,{error:'انتهت صلاحية الترخيص'});
      if(row.device_fingerprint && row.device_fingerprint!==fingerprint) return reply(res,403,{error:'هذا المفتاح مفعّل لجهاز آخر'});
      if(!row.device_fingerprint) db.prepare('UPDATE licenses SET device_fingerprint=? WHERE license_key=?').run(fingerprint,row.license_key);
      return reply(res,200,sign(db.prepare('SELECT * FROM licenses WHERE license_key=?').get(row.license_key)));
    }
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return reply(res,401,{error:'Unauthorized'});
    if(req.url==='/admin/licenses'){
      const expiresAt = Date.parse(b.expiresAt);
      if(!Number.isFinite(expiresAt) || expiresAt<=Date.now()) return reply(res,400,{error:'تاريخ انتهاء الترخيص غير صالح'});
      const key='ALAWA-'+crypto.randomBytes(8).toString('hex').toUpperCase();
      db.prepare('INSERT INTO licenses (license_key,expires_at) VALUES (?,?)').run(key,new Date(expiresAt).toISOString());
      return reply(res,201,{licenseKey:key});
    }
    if(req.url==='/admin/reset-device' || req.url==='/admin/revoke'){
      const update = req.url==='/admin/revoke' ? 'UPDATE licenses SET revoked=1 WHERE license_key=?' : 'UPDATE licenses SET device_fingerprint=NULL WHERE license_key=?';
      const result=db.prepare(update).run(String(b.licenseKey || ''));
      return result.changes ? reply(res,200,{ok:true}) : reply(res,404,{error:'License not found'});
    }
    return reply(res,404,{error:'Not found'});
  } catch(e){ if (!res.headersSent) reply(res,400,{error:e.message}); }
}).listen(PORT,'127.0.0.1',()=>console.log(`License server on 127.0.0.1:${PORT} (place behind HTTPS reverse proxy)`));
