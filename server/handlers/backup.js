'use strict';
const db = require('../db');
const { HttpError, requireRole, logActivity } = require('../helpers');

function formatSQLValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return v.toString();
  return `'${String(v).replace(/'/g, "''")}'`;
}

// A real SQL dump: reads the actual table definitions from SQLite's own schema catalog,
// so it stays correct automatically even if the schema changes later.
const EXCLUDED_TABLES = new Set(['sessions', 'login_attempts']);

function buildSQLDump() {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .filter(t => !EXCLUDED_TABLES.has(t.name));
  let out = `-- Alawa Management System — SQL backup\n-- Generated: ${new Date().toISOString()}\n\n`;
  out += 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n';
  for (const t of tables) {
    out += `DROP TABLE IF EXISTS ${t.name};\n${t.sql};\n`;
    const rows = db.prepare(`SELECT * FROM ${t.name}`).all();
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      for (const row of rows) {
        const vals = cols.map(c => formatSQLValue(row[c]));
        out += `INSERT INTO ${t.name} (${cols.join(',')}) VALUES (${vals.join(',')});\n`;
      }
    }
    out += '\n';
  }
  out += 'COMMIT;\nPRAGMA foreign_keys=ON;\n';
  return out;
}

function exportSQL(ctx) {
  requireRole(ctx, ['المالك']);
  const sql = buildSQLDump();
  logActivity(ctx, 'تصدير نسخة SQL', `${sql.length} حرف`);
  return { data: { sql, filename: `alawa-backup-${new Date().toISOString().slice(0,10)}.sql` } };
}

// Import replaces the ENTIRE database with the uploaded dump. This only accepts a dump
// this same system generated (DROP TABLE / CREATE TABLE / INSERT statements), executed
// as one real SQLite transaction — either all of it applies, or none of it does.
function importSQL(ctx) {
  requireRole(ctx, ['المالك']);
  const sql = ctx.body.sql;
  if (!sql || typeof sql !== 'string' || sql.trim().length === 0) throw new HttpError(400, 'الملف فارغ أو غير صالح');
  if (!/CREATE TABLE/i.test(sql)) throw new HttpError(400, 'هذا لا يبدو ملف نسخة احتياطية صحيحًا من هذا النظام');
  try {
    db.exec(sql);
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (e2) { /* nothing was open — fine */ }
    throw new HttpError(400, 'فشل الاستيراد: ' + e.message);
  }
  logActivity(ctx, 'استيراد نسخة SQL', `${sql.length} حرف`);
  return { data: { ok: true } };
}

const autoBackup = require('../auto_backup');

function listAutoBackups(ctx) {
  requireRole(ctx, ['المالك']);
  return { data: autoBackup.listBackups() };
}

function triggerAutoBackup(ctx) {
  requireRole(ctx, ['المالك']);
  const result = autoBackup.createBackup();
  if (result) {
    logActivity(ctx, 'إنشاء نسخة احتياطية محلية', result.filename);
  }
  return { data: result };
}

module.exports = { exportSQL, importSQL, listAutoBackups, triggerAutoBackup };

