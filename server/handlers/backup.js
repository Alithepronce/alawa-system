'use strict';
const db = require('../db');
const { HttpError, requireRole } = require('../helpers');
const autoBackup = require('../auto_backup');

const EXCLUDED_TABLES = new Set(['sessions', 'login_attempts']);
const OPTIONAL_TABLES = new Set(['supplier_openings', 'invoice_requests']);

const SQL_FORMAT_TAG = '-- alawa-sql-backup-v1';
const LAST_EXTERNAL_BACKUP_KEY = 'lastExternalBackupAt';

function dataTables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(row => row.name).filter(name => !EXCLUDED_TABLES.has(name));
}

// A copy that leaves this machine (downloaded file or Drive upload) is what protects the data from
// a dead disk; local auto-backups do not. Record when one was last produced for the warning banner.
function markExternalBackup() {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(LAST_EXTERNAL_BACKUP_KEY, new Date().toISOString());
}

function backupStatus(ctx) {
  requireRole(ctx, ['المالك']);
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(LAST_EXTERNAL_BACKUP_KEY);
  return { data: { lastExternalBackupAt: row ? row.value : null } };
}

function exportBackup(ctx) {
  requireRole(ctx, ['المالك']);
  markExternalBackup(); // before reading, so the file itself carries its own timestamp
  const payload = { format: 'alawa-data-backup-v1', generatedAt: new Date().toISOString(), tables: {} };
  for (const table of dataTables()) payload.tables[table] = db.prepare(`SELECT * FROM "${table}"`).all();
  return { data: { backup: payload, filename: `alawa-backup-${new Date().toISOString().slice(0,10)}.alawa.json` } };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function exportSql(ctx) {
  requireRole(ctx, ['المالك']);
  markExternalBackup();
  const out = [SQL_FORMAT_TAG, `-- generated: ${new Date().toISOString()}`, 'BEGIN TRANSACTION;'];
  for (const table of dataTables()) {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
    out.push('', ddl.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?/i, 'CREATE TABLE IF NOT EXISTS ') + ';');
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
    const names = columns.map(c => `"${c}"`).join(',');
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      out.push(`INSERT OR REPLACE INTO "${table}" (${names}) VALUES (${columns.map(c => sqlLiteral(row[c])).join(',')});`);
    }
  }
  out.push('COMMIT;', '');
  return { data: { sql: out.join('\n'), filename: `alawa-backup-${new Date().toISOString().slice(0,10)}.sql` } };
}

// Split a script into statements on semicolons outside string literals and drop -- comments.
function splitSqlStatements(text) {
  const statements = [];
  let current = '', i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      const end = findStringEnd(text, i);
      current += text.slice(i, end + 1); i = end + 1; continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1; continue;
    }
    if (ch === ';') { if (current.trim()) statements.push(current.trim()); current = ''; i++; continue; }
    current += ch; i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function findStringEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "'") { if (text[i + 1] === "'") { i += 2; continue; } return i; }
    i++;
  }
  throw new HttpError(400, 'ملف SQL تالف: نص غير مغلق');
}

// Parse "v1,v2,..." where each value is NULL, a number, or a quoted string.
function parseValues(text) {
  const values = [];
  let i = 0;
  const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  while (true) {
    skipWs();
    if (text[i] === "'") {
      const end = findStringEnd(text, i);
      values.push(text.slice(i + 1, end).replace(/''/g, "'")); i = end + 1;
    } else {
      const m = /^(NULL|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/i.exec(text.slice(i));
      if (!m) throw new HttpError(400, 'ملف SQL يحتوي قيمة غير مدعومة');
      values.push(m[1].toUpperCase() === 'NULL' ? null : Number(m[1])); i += m[1].length;
    }
    skipWs();
    if (i >= text.length) return values;
    if (text[i] !== ',') throw new HttpError(400, 'ملف SQL يحتوي صيغة غير مدعومة');
    i++;
  }
}

// Only the exact statements exportSql writes are accepted; the file is converted to rows and
// restored through the same validated path as the JSON backup, never executed as SQL.
function parseSqlBackup(text) {
  if (typeof text !== 'string' || !text.startsWith(SQL_FORMAT_TAG)) throw new HttpError(400, 'هذا الملف ليس نسخة SQL صادرة من هذا النظام');
  const tables = {};
  for (const stmt of splitSqlStatements(text)) {
    if (/^(BEGIN TRANSACTION|COMMIT)$/i.test(stmt)) continue;
    const create = /^CREATE TABLE IF NOT EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i.exec(stmt);
    if (create) { tables[create[1]] = tables[create[1]] || []; continue; }
    const insert = /^INSERT OR REPLACE INTO "([A-Za-z_][A-Za-z0-9_]*)" \(([^)]*)\) VALUES \(([\s\S]*)\)$/.exec(stmt);
    if (!insert) throw new HttpError(400, 'ملف SQL يحتوي أوامر غير مسموحة');
    const columns = insert[2].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const values = parseValues(insert[3]);
    if (values.length !== columns.length) throw new HttpError(400, `عدد القيم لا يطابق الأعمدة في جدول ${insert[1]}`);
    const row = {};
    columns.forEach((c, idx) => { row[c] = values[idx]; });
    (tables[insert[1]] = tables[insert[1]] || []).push(row);
  }
  return { format: 'alawa-data-backup-v1', tables };
}

function validateBackup(backup) {
  if (!backup || backup.format !== 'alawa-data-backup-v1' || !backup.tables || typeof backup.tables !== 'object' || Array.isArray(backup.tables)) {
    throw new HttpError(400, 'صيغة النسخة الاحتياطية غير مدعومة');
  }
  const schema = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(row => row.name).filter(name => !EXCLUDED_TABLES.has(name));
  const inputNames = Object.keys(backup.tables);
  if (!inputNames.length || inputNames.some(name => !schema.includes(name))) throw new HttpError(400, 'تحتوي النسخة على جداول غير معروفة');
  const missingRequired = schema.filter(name => !OPTIONAL_TABLES.has(name) && !inputNames.includes(name));
  if (missingRequired.length) throw new HttpError(400, 'النسخة ناقصة ولا تحتوي كل جداول البيانات المطلوبة');
  let rowCount = 0;
  for (const table of schema) {
    const rows = backup.tables[table] ?? [];
    if (!Array.isArray(rows)) throw new HttpError(400, `بيانات جدول ${table} مفقودة أو غير صالحة`);
    const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name));
    for (const row of rows) {
      rowCount++;
      if (rowCount > 500000) throw new HttpError(413, 'النسخة الاحتياطية تتجاوز الحد المسموح');
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !columns.has(key))) {
        throw new HttpError(400, `سجل غير صالح في جدول ${table}`);
      }
      for (const value of Object.values(row)) {
        if (value !== null && !['string', 'number'].includes(typeof value)) throw new HttpError(400, 'نوع قيمة غير مسموح في النسخة');
        if (typeof value === 'number' && !Number.isFinite(value)) throw new HttpError(400, 'تحتوي النسخة قيمة رقمية غير صالحة');
      }
    }
  }
  return schema;
}

function importBackup(ctx) {
  const session = requireRole(ctx, ['المالك']);
  return restoreBackup(session, ctx.body.backup, 'استيراد نسخة احتياطية');
}

function importSql(ctx) {
  const session = requireRole(ctx, ['المالك']);
  return restoreBackup(session, parseSqlBackup(ctx.body.sql), 'استيراد نسخة SQL');
}

function restoreBackup(session, backup, action) {
  const schema = validateBackup(backup);
  const safetyCopy = autoBackup.createBackup();
  if (!safetyCopy) throw new HttpError(500, 'تعذر إنشاء نسخة أمان قبل الاستيراد؛ لم يتم تغيير البيانات');

  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM login_attempts').run();
    for (const table of [...schema].reverse()) db.exec(`DELETE FROM "${table}"`);
    for (const table of schema) {
      const rows = backup.tables[table] ?? [];
      for (const row of rows) {
        const columns = Object.keys(row);
        if (!columns.length) throw new Error(`سجل فارغ في جدول ${table}`);
        const names = columns.map(column => `"${column}"`).join(',');
        const marks = columns.map(() => '?').join(',');
        db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${marks})`).run(...columns.map(column => row[column]));
      }
    }
    const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (fkErrors.length) throw new Error('تحتوي النسخة على مراجع غير متطابقة بين الجداول');
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('فشل فحص سلامة قاعدة البيانات بعد الاستيراد');
    db.exec('COMMIT; PRAGMA foreign_keys=ON;');
  } catch (error) {
    try { db.exec('ROLLBACK; PRAGMA foreign_keys=ON;'); } catch (_) {}
    throw new HttpError(400, `فشل الاستيراد ولم تُعتمد البيانات الجديدة: ${error.message}`);
  }

  db.prepare('INSERT INTO activity_log (user_id,user_name,role,action,details) VALUES (NULL,?,?,?,?)')
    .run(session.name, session.role, action, `تم الاستيراد بعد إنشاء نسخة أمان: ${safetyCopy.filename}`);
  return { data: { ok: true, safetyCopy: safetyCopy.filename } };
}

function listAutoBackups(ctx) {
  requireRole(ctx, ['المالك']);
  return { data: autoBackup.listBackups() };
}

function triggerAutoBackup(ctx) {
  requireRole(ctx, ['المالك']);
  const result = autoBackup.createBackup();
  return { data: result };
}

module.exports = { exportBackup, importBackup, exportSql, importSql, backupStatus, parseSqlBackup, listAutoBackups, triggerAutoBackup };
