'use strict';
const authH = require('./handlers/auth_handlers');
const users = require('./handlers/users');
const settings = require('./handlers/settings');
const customers = require('./handlers/customers');
const items = require('./handlers/items');
const suppliers = require('./handlers/suppliers');
const invoices = require('./handlers/invoices');
const purchases = require('./handlers/purchases');
const returns = require('./handlers/returns');
const cashbox = require('./handlers/cashbox');
const reports = require('./handlers/reports');
const backup = require('./handlers/backup');
const updater = require('./updater');
const license = require('./handlers/license');
const debts = require('./handlers/debts');

// Route table: [method, path pattern with :param placeholders, handler]
const routes = [
  ['GET',  '/api/license/status', () => license.getStatus()],
  ['GET',  '/api/license/request', () => license.getActivationRequest()],
  ['POST', '/api/license/activate', (ctx) => license.activate(ctx)],
  ['POST', '/api/license/refresh', () => license.refresh()],
  ['POST', '/api/login', (ctx) => authH.handleLogin(ctx)],
  ['POST', '/api/logout', (ctx) => authH.handleLogout(ctx)],
  ['GET',  '/api/me', (ctx) => authH.handleMe(ctx)],
  ['POST', '/api/me/password', (ctx) => authH.changeOwnPassword(ctx)],

  ['GET',    '/api/users', (ctx) => users.listUsers(ctx)],
  ['POST',   '/api/users', (ctx) => users.createUser(ctx)],
  ['PUT',    '/api/users/:id', (ctx, id) => users.updateUser(ctx, id)],
  ['DELETE', '/api/users/:id', (ctx, id) => users.deleteUser(ctx, id)],

  ['GET', '/api/settings', (ctx) => settings.getSettings(ctx)],
  ['PUT', '/api/settings', (ctx) => settings.putSettings(ctx)],

  ['GET',    '/api/customers', (ctx) => customers.listCustomers(ctx)],
  ['POST',   '/api/customers', (ctx) => customers.createCustomer(ctx)],
  ['PUT',    '/api/customers/:id', (ctx, id) => customers.updateCustomer(ctx, id)],
  ['DELETE', '/api/customers/:id', (ctx, id) => customers.deleteCustomer(ctx, id)],
  ['POST',   '/api/customers/:id/payment', (ctx, id) => customers.customerPayment(ctx, id)],
  ['POST',   '/api/customers/:id/debt', (ctx, id) => customers.customerDebt(ctx, id)],
  ['GET',    '/api/customers/:id/ledger', (ctx, id) => customers.customerLedger(ctx, id)],
  ['GET',    '/api/customers/:id/last-prices', (ctx, id) => customers.customerLastPrices(ctx, id)],

  ['GET',    '/api/items', (ctx) => items.listItems(ctx)],
  ['POST',   '/api/items', (ctx) => items.createItem(ctx)],
  ['PUT',    '/api/items/:id', (ctx, id) => items.updateItem(ctx, id)],
  ['DELETE', '/api/items/:id', (ctx, id) => items.deleteItem(ctx, id)],
  ['POST',   '/api/items/:id/adjust', (ctx, id) => items.adjustItem(ctx, id)],

  ['GET',    '/api/suppliers', (ctx) => suppliers.listSuppliers(ctx)],
  ['POST',   '/api/suppliers', (ctx) => suppliers.createSupplier(ctx)],
  ['PUT',    '/api/suppliers/:id', (ctx, id) => suppliers.updateSupplier(ctx, id)],
  ['DELETE', '/api/suppliers/:id', (ctx, id) => suppliers.deleteSupplier(ctx, id)],
  ['POST',   '/api/suppliers/:id/payment', (ctx, id) => suppliers.supplierPayment(ctx, id)],
  ['GET',    '/api/suppliers/:id/ledger', (ctx, id) => suppliers.supplierLedger(ctx, id)],

  ['GET',  '/api/invoices', (ctx) => invoices.listInvoices(ctx)],
  ['POST', '/api/invoices', (ctx) => invoices.createInvoice(ctx)],
  ['POST', '/api/invoices/:id/void', (ctx, id) => invoices.voidInvoice(ctx, id)],

  ['POST', '/api/purchases', (ctx) => purchases.createPurchase(ctx)],

  ['POST', '/api/returns', (ctx) => returns.createReturn(ctx)],
  ['POST', '/api/supplier-returns', (ctx) => returns.createSupplierReturn(ctx)],

  ['GET',  '/api/cashbox', (ctx) => cashbox.listCashbox(ctx)],
  ['POST', '/api/cashbox', (ctx) => cashbox.createCashboxManual(ctx)],

  ['GET', '/api/reports/dashboard', (ctx) => reports.dashboardStats(ctx)],
  ['GET', '/api/reports/daily', (ctx) => reports.dailyReport(ctx)],
  ['GET', '/api/reports/profit', (ctx) => reports.profitReport(ctx)],
  ['GET', '/api/reports/weekly', (ctx) => reports.weeklyReport(ctx)],
  ['GET', '/api/reports/debts', (ctx) => debts.debtsReport(ctx)],
  ['GET', '/api/reports/customer-sales', (ctx) => debts.customerSalesReport(ctx)],
  ['GET', '/api/customers/:id/statement', (ctx, id) => debts.customerStatement(ctx, id)],
  ['GET', '/api/activity-log', (ctx) => reports.activityLog(ctx)],

  ['GET',  '/api/backup/export', (ctx) => backup.exportBackup(ctx)],
  ['POST', '/api/backup/import', (ctx) => backup.importBackup(ctx)],
  ['GET',  '/api/backup/list', (ctx) => backup.listAutoBackups(ctx)],
  ['POST', '/api/backup/create', (ctx) => backup.triggerAutoBackup(ctx)],

  ['GET',  '/api/updater/check', (ctx) => updater.checkUpdate(ctx)],
  ['POST', '/api/updater/apply', (ctx) => updater.applyUpdate(ctx)],
];

// Compile each path pattern (e.g. "/api/customers/:id/payment") into a regex once.
const compiled = routes.map(([method, pattern, handler]) => {
  const regexStr = '^' + pattern.replace(/:[^/]+/g, () => '([^/]+)') + '$';
  return { method, regex: new RegExp(regexStr), handler };
});

async function route(method, pathname, ctx) {
  for (const r of compiled) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;
    const params = m.slice(1);
    return await r.handler(ctx, ...params);
  }
  return null;
}

module.exports = { route };
