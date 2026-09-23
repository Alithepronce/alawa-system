'use strict';
const db = require('../db');
const { HttpError, requireRole } = require('../helpers');
const autoBackup = require('../auto_backup');

const EXCLUDED_TABLES = new Set(['sessions', 'login_attempts']);
const OPTIONAL_TABLES = new Set(['supplier_openings', 'invoice_requests']);

function exportBackup(ctx) {
  requireRole(ctx, ['المالك']);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(row => row.name).filter(name => !EXCLUDED_TABLES.has(name));
  const payload = { format: 'alawa-data-backup-v1', generatedAt: new Date().toISOString(), tables: {} };
  for (const table of tables) payload.tables[table] = db.prepare(`SELECT * FROM "${table}"`).all();
  return { data: { backup: payload, filename: `alawa-backup-${new Date().toISOString().slice(0,10)}.alawa.json` } };
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
  const backup = ctx.body.backup;
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
    .run(session.name, session.role, 'استيراد نسخة احتياطية', `تم الاستيراد بعد إنشاء نسخة أمان: ${safetyCopy.filename}`);
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

module.exports = { exportBackup, importBackup, listAutoBackups, triggerAutoBackup };
