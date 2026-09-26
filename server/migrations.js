'use strict';
const db = require('./db');

function runMigrations() {
  function getColumns(table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  }

  // 1. Soft delete columns for customers
  const custCols = getColumns('customers');
  if (!custCols.includes('is_deleted')) {
    db.exec('ALTER TABLE customers ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;');
  }
  if (!custCols.includes('deleted_at')) {
    db.exec('ALTER TABLE customers ADD COLUMN deleted_at TEXT;');
  }

  // 2. Soft delete and barcode columns for items
  const itemCols = getColumns('items');
  if (!itemCols.includes('is_deleted')) {
    db.exec('ALTER TABLE items ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;');
  }
  if (!itemCols.includes('deleted_at')) {
    db.exec('ALTER TABLE items ADD COLUMN deleted_at TEXT;');
  }
  if (!itemCols.includes('barcode')) {
    db.exec('ALTER TABLE items ADD COLUMN barcode TEXT;');
  }

  // 3. Soft delete columns for suppliers
  const suppCols = getColumns('suppliers');
  if (!suppCols.includes('is_deleted')) {
    db.exec('ALTER TABLE suppliers ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;');
  }
  if (!suppCols.includes('deleted_at')) {
    db.exec('ALTER TABLE suppliers ADD COLUMN deleted_at TEXT;');
  }
  if (!getColumns('payments').includes('is_deposit')) db.exec('ALTER TABLE payments ADD COLUMN is_deposit INTEGER NOT NULL DEFAULT 0;');
  const userCols = getColumns('users');
  if (!userCols.includes('must_change_password')) db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;');
  const auth = require('./auth');
  for (const user of db.prepare('SELECT id,salt,password_hash,must_change_password FROM users').all()) {
    if (!user.must_change_password && auth.verifyPassword('1234', user.salt, user.password_hash)) {
      db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(user.id);
    }
  }

  // 4. Create performance & search indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_items_active ON items(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
    CREATE TABLE IF NOT EXISTS supplier_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS supplier_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      direction TEXT NOT NULL CHECK(direction IN ('credit','debit')),
      amount REAL NOT NULL,
      note TEXT,
      date TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      note TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
      date TEXT NOT NULL,
      currency TEXT NOT NULL CHECK(currency IN ('IQD','USD')),
      direction TEXT NOT NULL CHECK(direction IN ('debit','credit')),
      amount REAL NOT NULL,
      note TEXT,
      with_cash INTEGER NOT NULL DEFAULT 0,
      voided INTEGER NOT NULL DEFAULT 0,
      voided_at TEXT,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);
    CREATE TABLE IF NOT EXISTS invoice_requests (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, request_id)
    );
  `);
  db.exec(`
    INSERT INTO supplier_openings (supplier_id,amount,date,created_by)
    SELECT s.id,s.balance,datetime('now'),NULL FROM suppliers s
    WHERE ABS(s.balance)>0.01
      AND NOT EXISTS (SELECT 1 FROM supplier_openings o WHERE o.supplier_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.supplier_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM supplier_payments p WHERE p.supplier_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM supplier_returns r WHERE r.supplier_id=s.id);
  `);
}

runMigrations();
module.exports = { runMigrations };
