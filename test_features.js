'use strict';
// Checks for the cashbox summary, weekly report fields, customer credit balance and SQL backup round trip.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alawa-features-test-'));
process.env.ALAWA_DATA_DIR = dataDir;
// Baghdad is UTC+3: a movement at 00:30 local time is still the previous day in UTC.
process.env.TZ = 'Asia/Baghdad';

const db = require('./server/db');
require('./server/migrations');
const customers = require('./server/handlers/customers');
const invoices = require('./server/handlers/invoices');
const cashbox = require('./server/handlers/cashbox');
const reports = require('./server/handlers/reports');
const backup = require('./server/handlers/backup');
const { localDateStr } = require('./server/helpers');

const session = { id: 1, name: 'اختبار', role: 'المالك' };
const ctx = (body = {}, query = {}) => ({ body, query, session });
const today = localDateStr(new Date().toISOString());
const balance = id => db.prepare('SELECT balance FROM customers WHERE id=?').get(id).balance;

try {
  db.prepare("INSERT INTO users (id,name,role,password_hash,salt) VALUES (1,'اختبار','المالك','x','x')").run();
  db.prepare("INSERT INTO items (id,name,bag_weight,stock_kg,price_normal,price_wholesale,avg_cost_per_kg) VALUES (1,'طحين',50,10000,40000,40000,500)").run();
  const cid = customers.createCustomer(ctx({ name: 'جعوص', category: 'جملة', creditLimit: 500000 })).data.id;

  // Overpayment with no debt becomes a credit balance (negative balance).
  customers.customerPayment(ctx({ amount: 10000000 }), cid);
  assert.equal(balance(cid), -10000000);

  // A sale draws the credit down; half of it paid in cash.
  invoices.createInvoice(ctx({ customerId: cid, requestId: crypto.randomUUID(), paid: 40000, lines: [{ itemId: 1, qty: 2, unit: 'كيس' }] }));
  cashbox.createCashboxManual(ctx({ kind: 'expense', amount: 5000, note: 'أجور' }));

  const sm = cashbox.cashboxSummary(ctx({}, { from: today, to: today })).data;
  assert.equal(sm.directSales, 40000);
  assert.equal(sm.creditSales, 40000);
  assert.equal(sm.collections, 10000000);
  assert.equal(sm.expenses, 5000);
  assert.equal(sm.net, 10040000 - 5000);

  // Local-midnight movement: stored UTC date is yesterday, local date is today.
  const [y, m, d] = today.split('-').map(Number);
  const justAfterMidnight = new Date(y, m - 1, d, 0, 30).toISOString();
  assert.notEqual(justAfterMidnight.slice(0, 10), today);
  db.prepare("INSERT INTO cashbox (date,type,amount,source,note) VALUES (?,'in',777,'وارد آخر','منتصف الليل')").run(justAfterMidnight);
  const listed = cashbox.listCashbox(ctx({}, { from: today, to: today })).data;
  assert.ok(listed.some(c => c.amount === 777), 'movement after local midnight must appear under today');

  const wk = reports.weeklyReport(ctx({}, { from: today, to: today })).data;
  assert.equal(wk.cashSales, 40000);
  assert.equal(wk.collected, 10000000);
  assert.equal(wk.customerCashIn, 10040000);
  assert.equal(wk.netAfterManual, 10040000 - 5000);
  assert.equal(wk.customers.length, 1);

  // SQL backup: status is recorded, the file round-trips, and foreign statements are rejected.
  assert.equal(backup.backupStatus(ctx()).data.lastExternalBackupAt, null);
  const { sql, filename } = backup.exportSql(ctx()).data;
  assert.ok(filename.endsWith('.sql'));
  assert.ok(backup.backupStatus(ctx()).data.lastExternalBackupAt);
  assert.match(sql, /^-- alawa-sql-backup-v1/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/);

  const tricky = "O'Brien; -- not a comment\nسطر ثاني";
  db.prepare('UPDATE customers SET nickname=? WHERE id=?').run(tricky, cid);
  const snapshot = backup.exportSql(ctx()).data.sql;
  const countsBefore = ['customers', 'invoices', 'invoice_lines', 'payments', 'cashbox', 'users'].map(t => db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n);

  db.prepare("INSERT INTO cashbox (date,type,amount,source,note) VALUES (?,'out',1,'مصروف يدوي','بعد النسخة')").run(new Date().toISOString());
  db.prepare('UPDATE customers SET balance=0, nickname=NULL WHERE id=?').run(cid);

  backup.importSql(ctx({ sql: snapshot }));
  const countsAfter = ['customers', 'invoices', 'invoice_lines', 'payments', 'cashbox', 'users'].map(t => db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n);
  assert.deepEqual(countsAfter, countsBefore);
  assert.equal(balance(cid), -10000000 + 40000);
  assert.equal(db.prepare('SELECT nickname FROM customers WHERE id=?').get(cid).nickname, tricky);

  const reject = (text, why) => assert.throws(() => backup.importSql(ctx({ sql: text })), e => e.httpStatus === 400, why);
  reject('DROP TABLE customers;', 'missing format tag');
  reject(snapshot + '\nDROP TABLE customers;', 'non-insert statement');
  reject(snapshot.replace('BEGIN TRANSACTION;', "BEGIN TRANSACTION;\nATTACH DATABASE 'x' AS y;"), 'attach statement');
  reject(snapshot.replace(/INSERT OR REPLACE INTO "customers" \(([^)]*)\) VALUES \(/, 'INSERT OR REPLACE INTO "customers" ($1) VALUES (1,'), 'value count mismatch');
  assert.equal(balance(cid), -10000000 + 40000, 'rejected imports must not change data');

  console.log('Feature tests passed');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
