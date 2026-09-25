'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alawa-opening-debt-test-'));
process.env.ALAWA_DATA_DIR = dataDir;

const db = require('./server/db');
require('./server/migrations');
const customers = require('./server/handlers/customers');
const session = { id: 1, name: 'اختبار', role: 'المالك' };
const context = body => ({ body, session });

try {
  db.prepare("INSERT INTO users (id,name,role,password_hash,salt) VALUES (1,'اختبار','المالك','x','x')").run();

  assert.throws(() => customers.createCustomer(context({ name: 'سالب', openingDebt: -5 })), e => e.httpStatus === 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 0);

  const { id } = customers.createCustomer(context({ name: 'زبون قديم', openingDebt: 250000 })).data;
  assert.equal(db.prepare('SELECT balance FROM customers WHERE id=?').get(id).balance, 250000);
  const ledger = customers.customerLedger(context({}), id).data;
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].debit, 250000);

  const plain = customers.createCustomer(context({ name: 'زبون جديد' })).data.id;
  assert.equal(db.prepare('SELECT balance FROM customers WHERE id=?').get(plain).balance, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE customer_id=?').get(plain).n, 0);
  console.log('Opening debt tests passed');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
