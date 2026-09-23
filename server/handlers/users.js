'use strict';
const db = require('../db');
const auth = require('../auth');
const { HttpError, requireRole, logActivity, str } = require('../helpers');

function listUsers(ctx) {
  requireRole(ctx, ['المالك']);
  const rows = db.prepare('SELECT id, name, role, created_at FROM users ORDER BY id').all();
  return { data: rows };
}
function createUser(ctx) {
  requireRole(ctx, ['المالك']);
  const name = str(ctx.body.name), role = str(ctx.body.role), password = str(ctx.body.password);
  if (!name) throw new HttpError(400, 'أدخل اسم المستخدم');
  if (!['المالك','محاسب','أمين مخزن'].includes(role)) throw new HttpError(400, 'صفة غير صحيحة');
  if (!password || password.length < 4) throw new HttpError(400, 'رمز الدخول يجب أن يكون 4 أحرف على الأقل');
  const existing = db.prepare('SELECT id FROM users WHERE name=?').get(name);
  if (existing) throw new HttpError(400, 'يوجد مستخدم بنفس الاسم مسبقاً');
  const { hash, salt } = auth.hashPassword(password);
  const info = db.prepare('INSERT INTO users (name, role, password_hash, salt) VALUES (?,?,?,?)').run(name, role, hash, salt);
  logActivity(ctx, 'إضافة مستخدم', `${name} (${role})`);
  return { status: 201, data: { id: Number(info.lastInsertRowid), name, role } };
}
function updateUser(ctx, id) {
  requireRole(ctx, ['المالك']);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) throw new HttpError(404, 'المستخدم غير موجود');
  const name = str(ctx.body.name) || user.name;
  const role = str(ctx.body.role) || user.role;
  const password = str(ctx.body.password);
  if (!['المالك','محاسب','أمين مخزن'].includes(role)) throw new HttpError(400, 'صفة غير صحيحة');
  if (role !== 'المالك' && user.role === 'المالك') {
    const ownerCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='المالك'").get().c;
    if (ownerCount <= 1) throw new HttpError(400, 'لا يمكن تغيير صفة آخر حساب مالك');
  }
  if (password) {
    if (password.length < 4) throw new HttpError(400, 'رمز الدخول يجب أن يكون 4 أحرف على الأقل');
    const { hash, salt } = auth.hashPassword(password);
    db.prepare('UPDATE users SET name=?, role=?, password_hash=?, salt=? WHERE id=?').run(name, role, hash, salt, id);
  } else {
    db.prepare('UPDATE users SET name=?, role=? WHERE id=?').run(name, role, id);
  }
  logActivity(ctx, 'تعديل مستخدم', `${name} (${role})`);
  return { data: { ok: true } };
}
function deleteUser(ctx, id) {
  requireRole(ctx, ['المالك']);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) throw new HttpError(404, 'المستخدم غير موجود');
  if (user.role === 'المالك') {
    const ownerCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='المالك'").get().c;
    if (ownerCount <= 1) throw new HttpError(400, 'لا يمكن حذف آخر حساب مالك');
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  logActivity(ctx, 'حذف مستخدم', `${user.name} (${user.role})`);
  return { data: { ok: true } };
}

module.exports = { listUsers, createUser, updateUser, deleteUser };
