'use strict';
const db = require('../db');
const { requireAuth, requireRole, logActivity } = require('../helpers');

const DEFAULT_SETTINGS = {
  storeName: 'مكتب الجبوري', storePhone: '', currency: 'د.ع',
  defCredit: '500000', lowStock: '200', ownerPhone: '', gdriveClientId: '',
  usdRate: '1530'
};
function getSettings(ctx) {
  const session = requireAuth(ctx);
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  rows.forEach(r => out[r.key] = r.value);
  if (session.role !== 'المالك') { delete out.gdriveClientId; delete out.ownerPhone; }
  return { data: out };
}
function putSettings(ctx) {
  requireRole(ctx, ['المالك']);
  const allowed = ['storeName','storePhone','currency','defCredit','lowStock','ownerPhone','gdriveClientId','usdRate'];
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of allowed) {
    if (ctx.body[k] !== undefined) upsert.run(k, String(ctx.body[k]));
  }
  logActivity(ctx, 'تعديل الإعدادات', '');
  return { data: { ok: true } };
}

module.exports = { getSettings, putSettings };
