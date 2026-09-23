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

  // 4. Create performance & search indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_items_active ON items(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
  `);
}

runMigrations();
module.exports = { runMigrations };
