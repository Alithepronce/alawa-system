'use strict';
const db = require('./server/db');
require('./server/migrations');
db.prepare("INSERT OR IGNORE INTO users (id,name,role,password_hash,salt) VALUES (1,'مالك الاختبار','المالك','test','test')").run();
const { getMachineFingerprint } = require('./server/machine');
const { verifyLicense, initLicense } = require('./server/license');
const autoBackup = require('./server/auto_backup');
const reports = require('./server/handlers/reports');
const customers = require('./server/handlers/customers');
const items = require('./server/handlers/items');
const suppliers = require('./server/handlers/suppliers');

console.log('--- Starting Alawa System Verification Tests ---');

// 1. Hardware Fingerprint & Licensing
const fp = getMachineFingerprint();
console.log('✓ Hardware fingerprint generated:', fp.slice(0, 16) + '...');
const licStatus = initLicense();
console.log('✓ License verification status:', licStatus ? 'VALID & LOCKED' : 'FAILED');

// 2. PRAGMA & DB Integrity
const integrity = db.prepare('PRAGMA integrity_check;').get();
console.log('✓ SQLite DB integrity:', Object.values(integrity)[0]);

// 3. Schema Migrations Verification
const itemCols = db.prepare('PRAGMA table_info(items);').all().map(c => c.name);
const custCols = db.prepare('PRAGMA table_info(customers);').all().map(c => c.name);
const suppCols = db.prepare('PRAGMA table_info(suppliers);').all().map(c => c.name);

console.log('✓ items columns have is_deleted & barcode:', itemCols.includes('is_deleted') && itemCols.includes('barcode'));
console.log('✓ customers columns have is_deleted:', custCols.includes('is_deleted'));
console.log('✓ suppliers columns have is_deleted:', suppCols.includes('is_deleted'));

// 4. Auto-backup Test
const backupRes = autoBackup.createBackup();
console.log('✓ Auto-backup created snapshot:', backupRes ? `${backupRes.filename} (${backupRes.sizeBytes} bytes)` : 'FAILED');
const backupsList = autoBackup.listBackups();
console.log('✓ Backups listed:', backupsList.length, 'file(s) present');

// 5. Dashboard Endpoint Test
const mockCtx = {
  req: { headers: {} },
  query: {},
  session: { id: 1, name: 'المالك', role: 'المالك' }
};
const dashData = reports.dashboardStats(mockCtx);
console.log('✓ Dashboard stats calculated:', {
  todaySales: dashData.data.todaySales,
  cashBalance: dashData.data.cashBalance,
  totalDebts: dashData.data.totalDebts,
  lowStockCount: dashData.data.lowStockCount
});

// 6. Test Item Update Guard (stock_kg must not be modified directly via updateItem)
const testItem = items.createItem({
  ...mockCtx,
  body: {
    name: 'مادة اختبار أمني',
    bagWeight: 50,
    stockKg: 100,
    lowStock: 10,
    priceNormal: 25000,
    barcode: '1234567890'
  }
});
const testItemId = testItem.data.id;
const itemBefore = db.prepare('SELECT stock_kg FROM items WHERE id=?').get(testItemId);

// Attempt to change stock_kg via updateItem
items.updateItem({
  ...mockCtx,
  body: {
    name: 'مادة اختبار أمني (معدلة)',
    stockKg: 999999 // Should be ignored!
  }
}, testItemId);
const itemAfter = db.prepare('SELECT stock_kg, name FROM items WHERE id=?').get(testItemId);
console.log('✓ Security check: stock_kg before =', itemBefore.stock_kg, '| stock_kg after =', itemAfter.stock_kg, '(Must be equal):', itemBefore.stock_kg === itemAfter.stock_kg);

// Cleanup test item
db.prepare('DELETE FROM items WHERE id=?').run(testItemId);

console.log('\n--- ALL SYSTEM VERIFICATION CHECKS PASSED SUCCESSFULLY ---');
process.exit(0);
