'use strict';
const db = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.httpStatus = status; }
}

function requireAuth(ctx) {
  if (!ctx.session) throw new HttpError(401, 'يجب تسجيل الدخول');
  return ctx.session;
}
function requireRole(ctx, roles) {
  const s = requireAuth(ctx);
  if (!roles.includes(s.role)) throw new HttpError(403, 'لا تملك صلاحية لهذا الإجراء');
  return s;
}
function logActivity(ctx, action, details) {
  const s = ctx.session;
  db.prepare('INSERT INTO activity_log (user_id, user_name, role, action, details) VALUES (?,?,?,?,?)')
    .run(s ? s.id : null, s ? s.name : null, s ? s.role : null, action, details || '');
}
function num(v, fallback = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function nowISO() { return new Date().toISOString(); }
function localDateStr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// Weight conversion shared by invoices, purchases, and returns
function weightKg(qty, unit, bagWeight) {
  if (unit === 'كيس') return qty * (bagWeight || 1);
  if (unit === 'طن') return qty * 1000;
  return qty; // كغم
}

module.exports = { HttpError, requireAuth, requireRole, logActivity, num, str, nowISO, localDateStr, weightKg };
