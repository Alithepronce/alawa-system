// auth.js — password hashing (scrypt, built into Node's crypto — no bcrypt dependency needed)
// and server-side session management. This is what makes authorization REAL: unlike the
// old client-only app, a user cannot bypass these checks by editing browser JavaScript,
// because every sensitive decision is made here, on the server, not in the browser.
'use strict';
const crypto = require('node:crypto');
const db = require('./db');

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 30 * 1000; // 30 seconds, matches the old client-side lockout window

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // constant-time compare — prevents timing attacks
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.token, s.expires_at, u.id, u.name, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, name: row.name, role: row.role, must_change_password: row.must_change_password, token };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Login throttling: checked per user_id (by name lookup) using recent attempts in the DB,
// so it survives server restarts and can't be bypassed by clearing browser state.
function isLockedOut(userId) {
  if (!userId) return false;
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM login_attempts
    WHERE user_id = ? AND success = 0 AND at > ?
  `).get(userId, since);
  return row.c >= MAX_FAILED_ATTEMPTS;
}

function recordAttempt(userId, ip, success) {
  db.prepare('INSERT INTO login_attempts (user_id, ip, success) VALUES (?, ?, ?)').run(userId || null, ip || null, success ? 1 : 0);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

module.exports = {
  hashPassword, verifyPassword, createSession, getSessionUser, destroySession,
  isLockedOut, recordAttempt, parseCookies, SESSION_TTL_MS
};
