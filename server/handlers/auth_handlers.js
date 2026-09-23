'use strict';
const db = require('../db');
const auth = require('../auth');
const { HttpError, requireAuth, logActivity, str } = require('../helpers');

function handleLogin(ctx) {
  const name = str(ctx.body.name);
  const password = str(ctx.body.password);
  if (!name || !password) throw new HttpError(400, 'أدخل الاسم والرمز');
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!user) { auth.recordAttempt(null, ctx.ip, false); throw new HttpError(401, 'بيانات الدخول غير صحيحة'); }
  if (auth.isLockedOut(user.id)) throw new HttpError(429, 'محاولات كثيرة خاطئة — حاول بعد 30 ثانية');
  const ok = auth.verifyPassword(password, user.salt, user.password_hash);
  auth.recordAttempt(user.id, ctx.ip, ok);
  if (!ok) throw new HttpError(401, 'بيانات الدخول غير صحيحة');
  const { token } = auth.createSession(user.id);
  logActivity({ session: { id: user.id, name: user.name, role: user.role } }, 'تسجيل دخول', '');
  const cookie = `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(auth.SESSION_TTL_MS/1000)}`;
  return { setCookie: cookie, data: { id: user.id, name: user.name, role: user.role } };
}
function handleLogout(ctx) {
  const cookies = auth.parseCookies(ctx.req);
  auth.destroySession(cookies.session);
  return { setCookie: 'session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0', data: { ok: true } };
}
function handleMe(ctx) {
  const s = requireAuth(ctx);
  return { data: { id: s.id, name: s.name, role: s.role } };
}

module.exports = { handleLogin, handleLogout, handleMe };
