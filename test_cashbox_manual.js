'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alawa-cashbox-test-'));
process.env.ALAWA_DATA_DIR = dataDir;

const db = require('./server/db');
const { createCashboxManual } = require('./server/handlers/cashbox');
const session = { id: 1, name: 'اختبار', role: 'المالك' };
const context = body => ({ body, session });
function expectHttpError(body, status) {
  assert.throws(() => createCashboxManual(context(body)), error => error.httpStatus === status);
}

try {
  db.prepare("INSERT INTO users (id,name,role,password_hash,salt) VALUES (1,'اختبار','المالك','x','x')").run();
  const customer = db.prepare('INSERT INTO customers (name,balance) VALUES (?,?)').run('زبون اختبار', 100000);
  const customerId = Number(customer.lastInsertRowid);

  expectHttpError({ kind: 'customer_receipt', amount: 5000 }, 400);
  expectHttpError({ kind: 'other_income', amount: 5000, note: '' }, 400);
  expectHttpError({ kind: 'expense', amount: 5000, note: 'مصروف' , customerId }, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cashbox').get().n, 0);
  assert.equal(db.prepare('SELECT balance FROM customers WHERE id=?').get(customerId).balance, 100000);

  createCashboxManual(context({ kind: 'other_income', amount: 5000, note: 'رأس مال افتتاحي' }));
  createCashboxManual(context({ kind: 'expense', amount: 1200, note: 'أجور نقل' }));
  createCashboxManual(context({ kind: 'customer_receipt', amount: 20000, note: 'وصل 1', customerId }));

  expectHttpError({ kind: 'customer_receipt', amount: 1000, customerId: 999999 }, 404);
  const receipts = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE customer_id=? AND type='receipt'").get(customerId).n;
  const balance = db.prepare('SELECT balance FROM customers WHERE id=?').get(customerId).balance;
  const rows = db.prepare('SELECT type,source,note FROM cashbox ORDER BY id').all();
  assert.equal(receipts, 1);
  assert.equal(balance, 80000);
  assert.deepEqual(rows.map(row => [row.type, row.source]), [
    ['in', 'وارد آخر'], ['out', 'مصروف يدوي'], ['in', 'قبض من زبون']
  ]);
  console.log('Cashbox manual-entry regression checks passed.');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
