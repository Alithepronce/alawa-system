'use strict';
const db = require('../db');
const auth = require('../auth');
const { HttpError, requireAuth, logActivity, str } = require('../helpers');
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 30_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of loginFailures) if (now - value.firstAt > LOGIN_WINDOW_MS) loginFailures.delete(key);
  while (loginFailures.size > 10000) loginFailures.delete(loginFailures.keys().next().value);
}, LOGIN_WINDOW_MS).unref();

function handleLogin(ctx) {
  const name = str(ctx.body.name);
  const password = str(ctx.body.password);
  if (!name || !password) throw new HttpError(400, 'أدخل الاسم والرمز');
  const attemptKey = `${ctx.ip || 'local'}:${name.toLocaleLowerCase()}`;
  const recent = loginFailures.get(attemptKey);
  if (recent && recent.count >= 5 && Date.now() - recent.firstAt < LOGIN_WINDOW_MS) throw new HttpError(429, 'محاولات كثيرة خاطئة — حاول بعد 30 ثانية');
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!user) {
    auth.recordAttempt(null, ctx.ip, false);
    const current = loginFailures.get(attemptKey);
    loginFailures.set(attemptKey, current && Date.now() - current.firstAt < LOGIN_WINDOW_MS ? { firstAt: current.firstAt, count: current.count + 1 } : { firstAt: Date.now(), count: 1 });
    throw new HttpError(401, 'بيانات الدخول غير صحيحة');
  }
  if (auth.isLockedOut(user.id)) throw new HttpError(429, 'محاولات كثيرة خاطئة — حاول بعد 30 ثانية');
  const ok = auth.verifyPassword(password, user.salt, user.password_hash);
  auth.recordAttempt(user.id, ctx.ip, ok);
  if (!ok) {
    const current = loginFailures.get(attemptKey);
    loginFailures.set(attemptKey, current && Date.now() - current.firstAt < LOGIN_WINDOW_MS ? { firstAt: current.firstAt, count: current.count + 1 } : { firstAt: Date.now(), count: 1 });
    throw new HttpError(401, 'بيانات الدخول غير صحيحة');
  }
  loginFailures.delete(attemptKey);
  const { token } = auth.createSession(user.id);
  logActivity({ session: { id: user.id, name: user.name, role: user.role } }, 'تسجيل دخول', '');
  const isHttps = !!ctx.req.socket.encrypted || (process.env.ALAWA_TRUST_PROXY === '1' && ctx.req.headers['x-forwarded-proto'] === 'https');
  const cookie = `session=${token}; HttpOnly; Path=/; SameSite=Strict;${isHttps ? ' Secure;' : ''} Max-Age=${Math.floor(auth.SESSION_TTL_MS/1000)}`;
  return { setCookie: cookie, data: { id: user.id, name: user.name, role: user.role, mustChangePassword: !!user.must_change_password } };
}
function changeOwnPassword(ctx) {
  const session = requireAuth(ctx);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(session.id);
  if (!user || !auth.verifyPassword(str(ctx.body.currentPassword), user.salt, user.password_hash)) throw new HttpError(403, 'رمز الدخول الحالي غير صحيح');
  const password = str(ctx.body.newPassword);
  if (password.length < 6) throw new HttpError(400, 'اختر رمزاً جديداً من 6 أحرف أو أرقام على الأقل');
  const { hash, salt } = auth.hashPassword(password);
  db.prepare('UPDATE users SET password_hash=?,salt=?,must_change_password=0 WHERE id=?').run(hash,salt,session.id);
  logActivity(ctx, 'تغيير رمز الدخول', '');
  return { data: { ok: true } };
}
function handleLogout(ctx) {
  const cookies = auth.parseCookies(ctx.req);
  auth.destroySession(cookies.session);
  return { setCookie: 'session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0', data: { ok: true } };
}
function handleMe(ctx) {
  const s = requireAuth(ctx);
  return { data: { id: s.id, name: s.name, role: s.role, mustChangePassword: !!s.must_change_password } };
}

module.exports = { handleLogin, handleLogout, handleMe, changeOwnPassword };
