'use strict';
// Debt engine checks: statements and the debts report must always reconcile to customers.balance.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alawa-debts-test-'));
process.env.ALAWA_DATA_DIR = dataDir;

const db = require('./server/db');
require('./server/migrations');
const customers = require('./server/handlers/customers');
const invoices = require('./server/handlers/invoices');
const returns = require('./server/handlers/returns');
const debts = require('./server/handlers/debts');
const { localDateStr } = require('./server/helpers');

const session = { id: 1, name: 'اختبار', role: 'المالك' };
const ctx = (body = {}, query = {}) => ({ body, query, session });
const today = localDateStr(new Date().toISOString());
const balance = id => db.prepare('SELECT balance FROM customers WHERE id=?').get(id).balance;
const sell = (customerId, qty, paid) => invoices.createInvoice(ctx({ customerId, requestId: crypto.randomUUID(), paid, lines: [{ itemId: 1, qty, unit: 'كيس' }] })).data.id;
const statement = (id, from = '2000-01-01', to = today) => debts.customerStatement(ctx({}, { from, to }), id).data;

try {
  db.prepare("INSERT INTO users (id,name,role,password_hash,salt) VALUES (1,'اختبار','المالك','x','x')").run();
  db.prepare("INSERT INTO items (id,name,bag_weight,stock_kg,price_normal,avg_cost_per_kg) VALUES (1,'طحين',50,10000,40000,500)").run();

  // A: opening debt, part-paid sale, receipt, credit return, cash return, and a voided sale.
  const a = customers.createCustomer(ctx({ name: 'أ', openingDebt: 100000, creditLimit: 10000000 })).data.id;
  sell(a, 3, 20000);                                   // +120000 −20000
  customers.customerPayment(ctx({ amount: 50000 }), a); // −50000
  returns.createReturn(ctx({ customerId: a, itemId: 1, qty: 1, unit: 'كيس', price: 40000, method: 'credit' })); // −40000
  sell(a, 1, 40000);
  returns.createReturn(ctx({ customerId: a, itemId: 1, qty: 1, unit: 'كيس', price: 40000, method: 'cash' }));   // no balance effect
  const voided = sell(a, 2, 0);
  invoices.voidInvoice(ctx(), voided);
  assert.equal(balance(a), 110000);

  // B: deposit first, then withdraw goods against it.
  const b = customers.createCustomer(ctx({ name: 'ب', creditLimit: 0 })).data.id;
  customers.customerPayment(ctx({ amount: 500000, deposit: true }), b);
  sell(b, 5, 0);
  assert.equal(balance(b), -300000);

  // C: legacy balance with no recorded movements becomes an explicit carried-forward line.
  const c = Number(db.prepare("INSERT INTO customers (name,balance) VALUES ('ج',70000)").run().lastInsertRowid);

  for (const id of [a, b, c]) assert.equal(statement(id).closing, balance(id), `statement closes on stored balance for ${id}`);

  const sb = statement(b);
  assert.equal(sb.totals.deposits, 500000);
  assert.equal(sb.totals.sales, 200000);
  assert.equal(sb.rows.at(-1).balance, -300000);
  assert.equal(sb.goods[0].kg, 250);
  assert.equal(statement(c).rows[0].kind, 'carried');

  const sa = statement(a);
  assert.equal(sa.totals.invoices, 2, 'voided invoice excluded');
  assert.equal(sa.totals.returnsCredit, 40000);
  assert.equal(sa.totals.returnsCash, 40000);

  // Movements before the period roll into the opening balance.
  db.prepare("UPDATE payments SET date='2026-01-10T09:00:00.000Z' WHERE customer_id=? AND type='debt'").run(a);
  const later = statement(a, '2026-02-01', today);
  assert.equal(later.opening, 100000);
  assert.equal(later.closing, balance(a));

  const report = debts.debtsReport(ctx({}, { from: '2026-02-01', to: today })).data;
  assert.equal(report.totals.closing, balance(a) + balance(b) + balance(c));
  assert.equal(report.totals.owedToUs, 180000);
  assert.equal(report.totals.depositsHeld, 300000);

  const salesReport = debts.customerSalesReport(ctx({}, { from: today, to: today, customerId: String(b) })).data;
  assert.equal(salesReport.groups.length, 1);
  assert.equal(salesReport.groups[0].entries[0].lines[0].qty, 5);

  assert.throws(() => debts.debtsReport(ctx({}, { from: today, to: '2000-01-01' })), e => e.httpStatus === 400);
  console.log('Debt engine tests passed');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
