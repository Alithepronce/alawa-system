'use strict';
// Checks for supplier manual entries, adding stock to an item, and the personal accounts book.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alawa-accounts-test-'));
process.env.ALAWA_DATA_DIR = dataDir;

const db = require('./server/db');
require('./server/migrations');
const suppliers = require('./server/handlers/suppliers');
const items = require('./server/handlers/items');
const accounts = require('./server/handlers/accounts');
const backup = require('./server/handlers/backup');
const settings = require('./server/handlers/settings');
const authHandlers = require('./server/handlers/auth_handlers');
const auth = require('./server/auth');
const { localDateStr } = require('./server/helpers');

const owner = { id: 1, name: 'اختبار', role: 'المالك' };
const accountant = { id: 2, name: 'محاسب', role: 'محاسب' };
const ctx = (body = {}, query = {}, session = owner) => ({ body, query, session });
const httpError = (fn, status) => assert.throws(fn, e => e.httpStatus === status);
const cashRows = () => db.prepare('SELECT type, amount, source FROM cashbox ORDER BY id').all().map(r => ({ ...r }));
const today = localDateStr(new Date().toISOString());

try {
  const ownerLogin = auth.hashPassword('owner-login-123');
  db.prepare("INSERT INTO users (id,name,role,password_hash,salt) VALUES (1,'اختبار','المالك',?,?), (2,'محاسب','محاسب','x','x')")
    .run(ownerLogin.hash, ownerLogin.salt);
  authHandlers.setOwnerOverridePin(ctx({ currentPassword: 'owner-login-123', pin: '5599' }));
  assert.equal(settings.getSettings(ctx()).data.ownerOverridePinConfigured, true);
  assert.equal(JSON.stringify(settings.getSettings(ctx())).includes(ownerLogin.hash), false, 'secrets are not returned from settings');
  const selectedBackupDir = path.join(dataDir, 'selected-backups');
  assert.equal(backup.setBackupDirectory(ctx({ directory: selectedBackupDir })).data.directory, selectedBackupDir);
  const immediateBackup = backup.triggerAutoBackup(ctx()).data;
  assert.ok(fs.existsSync(path.join(selectedBackupDir, immediateBackup.filename)));
  assert.equal(backup.backupStatus(ctx()).data.scheduleHours, 6);
  httpError(() => backup.setBackupDirectory(ctx({ directory: 'relative-path' })), 400);

  // Supplier manual entries: credit raises what we owe, debit lowers it (and can go negative).
  const sid = suppliers.createSupplier(ctx({ name: 'مورد' })).data.id;
  suppliers.supplierEntry(ctx({ direction: 'credit', amount: 300000, note: 'دين قديم' }), sid);
  suppliers.supplierEntry(ctx({ direction: 'debit', amount: 500000, note: 'بضاعة تالفة على حسابه' }), sid);
  assert.equal(db.prepare('SELECT balance FROM suppliers WHERE id=?').get(sid).balance, -200000);
  httpError(() => suppliers.supplierEntry(ctx({ direction: 'credit', amount: 100 }), sid), 400); // note required
  httpError(() => suppliers.supplierEntry(ctx({ direction: 'x', amount: 100, note: 'n' }), sid), 400);
  const sLedger = suppliers.supplierLedger(ctx(), sid).data.rows;
  assert.deepEqual(sLedger.map(r => [r.debit, r.credit]), [[0, 300000], [500000, 0]]);
  assert.equal(cashRows().length, 0, 'supplier entries never touch the cashbox');
  const supplierEntryIds = db.prepare('SELECT id FROM supplier_entries WHERE supplier_id=? ORDER BY id').all(sid).map(row => row.id);
  httpError(() => suppliers.editSupplierEntry(ctx({ amount: 250000, ownerPassword: 'bad' }), sid, supplierEntryIds[0]), 403);
  suppliers.editSupplierEntry(ctx({ amount: 250000, ownerPassword: '5599' }), sid, supplierEntryIds[0]);
  suppliers.editSupplierEntry(ctx({ amount: 450000, ownerPassword: '5599' }), sid, supplierEntryIds[1]);
  assert.equal(db.prepare('SELECT balance FROM suppliers WHERE id=?').get(sid).balance, -200000);
  assert.deepEqual(suppliers.supplierLedger(ctx(), sid).data.rows.map(row => [row.debit, row.credit]), [[0, 250000], [450000, 0]]);
  httpError(() => suppliers.deleteSupplier(ctx(), sid), 400);

  // Editing an old supplier payment keeps its linked cashbox amount and supplier balance in sync.
  const paidSupplierId = suppliers.createSupplier(ctx({ name: 'مورد دفعات', openingBalance: 150000 })).data.id;
  suppliers.supplierPayment(ctx({ amount: 30000 }), paidSupplierId);
  const payment = db.prepare('SELECT * FROM supplier_payments WHERE supplier_id=?').get(paidSupplierId);
  db.prepare('UPDATE supplier_payments SET cashbox_id=NULL WHERE id=?').run(payment.id); // legacy row backfill path
  httpError(() => suppliers.editSupplierPayment(ctx({ amount: 40000, ownerPassword: 'wrong' }), paidSupplierId, payment.id), 403);
  suppliers.editSupplierPayment(ctx({ amount: 50000, ownerPassword: '5599' }), paidSupplierId, payment.id);
  assert.equal(db.prepare('SELECT balance FROM suppliers WHERE id=?').get(paidSupplierId).balance, 100000);
  assert.equal(db.prepare('SELECT amount FROM cashbox WHERE id=(SELECT cashbox_id FROM supplier_payments WHERE id=?)').get(payment.id).amount, 50000);
  httpError(() => suppliers.editSupplierPayment(ctx({ amount: 0, ownerPassword: '5599' }), paidSupplierId, payment.id), 400);

  // Add stock: bag conversion and weighted average cost.
  db.prepare("INSERT INTO items (id,name,bag_weight,stock_kg,avg_cost_per_kg) VALUES (1,'طحين',50,1000,400)").run();
  items.addStock(ctx({ qty: 20, unit: 'كيس', costPerKg: 700 }), 1);
  let it = db.prepare('SELECT stock_kg, avg_cost_per_kg FROM items WHERE id=1').get();
  assert.equal(it.stock_kg, 2000);
  assert.equal(it.avg_cost_per_kg, 550);
  items.addStock(ctx({ qty: 1, unit: 'طن' }), 1); // no cost: keeps the average
  it = db.prepare('SELECT stock_kg, avg_cost_per_kg FROM items WHERE id=1').get();
  assert.equal(it.stock_kg, 3000);
  assert.equal(it.avg_cost_per_kg, 550);
  httpError(() => items.addStock(ctx({ qty: 0, unit: 'كغم' }), 1), 400);
  httpError(() => items.addStock(ctx({ qty: 5, unit: 'باكيت' }), 1), 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM adjustments WHERE reason='إضافة مخزون'").get().n, 2);

  // Accounts book: separate IQD/USD balances, optional cashbox link for IQD only.
  const aid = accounts.createAccount(ctx({ name: 'أبو علي', phone: '0770' }, {}, accountant)).data.id;
  accounts.addEntry(ctx({ direction: 'debit', currency: 'IQD', amount: 1000000, note: 'سلفة', withCash: true }), aid);
  accounts.addEntry(ctx({ direction: 'credit', currency: 'IQD', amount: 400000, note: 'تسديد جزء', withCash: true }), aid);
  accounts.addEntry(ctx({ direction: 'credit', currency: 'USD', amount: 500, note: 'أمانة دولار' }), aid);
  const noCash = accounts.addEntry(ctx({ direction: 'debit', currency: 'IQD', amount: 50000, note: 'فرق حساب', withCash: false }), aid).data.id;
  httpError(() => accounts.addEntry(ctx({ direction: 'debit', currency: 'USD', amount: 5, note: 'x', withCash: true }), aid), 400);
  httpError(() => accounts.addEntry(ctx({ direction: 'debit', currency: 'EUR', amount: 5, note: 'x' }), aid), 400);
  httpError(() => accounts.addEntry(ctx({ direction: 'debit', currency: 'IQD', amount: -5, note: 'x' }), aid), 400);

  let list = accounts.listAccounts(ctx()).data;
  assert.deepEqual(list[0].balances, { IQD: 650000, USD: -500 });
  assert.deepEqual(cashRows(), [
    { type: 'out', amount: 50000, source: 'تسديد لمورد' },
    { type: 'out', amount: 1000000, source: 'صيرفة - دفع' },
    { type: 'in', amount: 400000, source: 'صيرفة - قبض' }
  ]);

  const st = accounts.accountStatement(ctx({}, { currency: 'IQD' }), aid).data;
  assert.deepEqual(st.rows.map(r => r.balance), [1000000, 600000, 650000]);
  assert.equal(st.closing, 650000);
  const future = accounts.accountStatement(ctx({}, { currency: 'IQD', from: '2999-01-01' }), aid).data;
  assert.equal(future.opening, 650000);
  assert.equal(future.rows.length, 0);
  assert.equal(accounts.accountStatement(ctx({}, { currency: 'IQD', from: today, to: today }), aid).data.rows.length, 3);

  // Void: owner only; reverses cash when the entry moved it; balance recomputed.
  const firstId = st.rows[0].id;
  httpError(() => accounts.voidEntry(ctx({}, {}, accountant), firstId), 403);
  accounts.voidEntry(ctx(), firstId);
  httpError(() => accounts.voidEntry(ctx(), firstId), 400);
  accounts.voidEntry(ctx(), noCash);
  list = accounts.listAccounts(ctx()).data;
  assert.deepEqual(list[0].balances, { IQD: -400000, USD: -500 });
  assert.deepEqual(cashRows().slice(3), [{ type: 'in', amount: 1000000, source: 'صيرفة - إلغاء قيد' }]);
  const afterVoid = accounts.accountStatement(ctx({}, { currency: 'IQD' }), aid).data;
  assert.equal(afterVoid.rows.length, 3);
  assert.ok(afterVoid.rows[0].voided);
  assert.equal(afterVoid.closing, -400000);

  httpError(() => accounts.deleteAccount(ctx(), aid), 400);
  const emptyId = accounts.createAccount(ctx({ name: 'فارغ' })).data.id;
  accounts.deleteAccount(ctx(), emptyId);
  assert.equal(accounts.listAccounts(ctx()).data.length, 1);

  // Warehouse keeper cannot use the accounts book.
  httpError(() => accounts.listAccounts(ctx({}, {}, { id: 3, name: 'م', role: 'أمين مخزن' })), 403);

  // Print settings are validated.
  settings.putSettings(ctx({ printPaper: 'A4', printMarginMm: 8, printFontScale: 110, printOffsetXmm: -1.5, printOffsetYmm: 2 }));
  assert.equal(settings.getSettings(ctx()).data.printPaper, 'A4');
  httpError(() => settings.putSettings(ctx({ printPaper: 'A3' })), 400);
  httpError(() => settings.putSettings(ctx({ printOffsetXmm: 50 })), 400);

  // New tables survive a backup round trip, and backups made before they existed still import.
  const { sql } = backup.exportSql(ctx()).data;
  assert.equal(sql.includes('ownerOverridePinHash'), false, 'backup SQL excludes the local owner PIN');
  assert.equal(sql.includes('autoBackupDirectory'), false, 'backup SQL excludes machine-specific backup paths');
  backup.importSql(ctx({ sql }));
  assert.equal(backup.backupStatus(ctx()).data.autoBackupDirectory, selectedBackupDir);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM supplier_entries').get().n, 2);
  const legacy = backup.exportBackup(ctx()).data.backup;
  assert.equal(legacy.tables.settings.some(row => row.key === 'ownerOverridePinHash' || row.key === 'autoBackupDirectory'), false);
  legacy.tables.settings.push({ key: 'autoBackupDirectory', value: path.join(dataDir, 'untrusted-path') });
  legacy.tables.settings.push({ key: 'ownerOverridePinHash', value: 'untrusted-hash' });
  for (const t of ['supplier_entries', 'ledger_accounts', 'ledger_entries']) delete legacy.tables[t];
  backup.importBackup(ctx({ backup: legacy }));
  assert.equal(backup.backupStatus(ctx()).data.autoBackupDirectory, selectedBackupDir);
  assert.notEqual(db.prepare("SELECT value FROM settings WHERE key='ownerOverridePinHash'").get().value, 'untrusted-hash');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n, 0);

  console.log('Accounts, supplier entry and add-stock tests passed');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
