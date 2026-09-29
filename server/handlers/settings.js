'use strict';
const db = require('../db');
const { HttpError, requireAuth, requireRole, logActivity } = require('../helpers');

const DEFAULT_SETTINGS = {
  storeName: 'مكتب الجبوري', storePhone: '', currency: 'د.ع',
  defCredit: '500000', lowStock: '200', ownerPhone: '', gdriveClientId: '',
  usdRate: '1530',
  // Invoice printing: paper size, margins, text size and a calibration offset for the printer.
  printPaper: '80mm', printMarginMm: '3', printFontScale: '100', printOffsetXmm: '0', printOffsetYmm: '0'
};
function getSettings(ctx) {
  const session = requireAuth(ctx);
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  rows.forEach(r => out[r.key] = r.value);
  if (session.role === 'المالك') out.ownerOverridePinConfigured = !!out.ownerOverridePinHash;
  delete out.ownerOverridePinHash;
  delete out.ownerOverridePinSalt;
  if (session.role !== 'المالك') { delete out.gdriveClientId; delete out.ownerPhone; }
  return { data: out };
}
function putSettings(ctx) {
  requireRole(ctx, ['المالك']);
  const allowed = ['storeName','storePhone','currency','defCredit','lowStock','ownerPhone','gdriveClientId','usdRate',
    'printPaper','printMarginMm','printFontScale','printOffsetXmm','printOffsetYmm'];
  if (ctx.body.printPaper !== undefined && !['80mm', '58mm', 'A5', 'A4'].includes(String(ctx.body.printPaper))) throw new HttpError(400, 'حجم ورق غير مدعوم');
  for (const [k, min, max] of [['printMarginMm', 0, 30], ['printFontScale', 60, 200], ['printOffsetXmm', -20, 20], ['printOffsetYmm', -20, 20]]) {
    if (ctx.body[k] === undefined) continue;
    const v = Number(ctx.body[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `قيمة إعداد الطباعة خارج الحدود (${min} إلى ${max})`);
  }
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of allowed) {
    if (ctx.body[k] !== undefined) upsert.run(k, String(ctx.body[k]));
  }
  logActivity(ctx, 'تعديل الإعدادات', '');
  return { data: { ok: true } };
}

module.exports = { getSettings, putSettings };
