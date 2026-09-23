'use strict';
const db = require('../db');
const { requirePermission, requireRole, localDateStr } = require('../helpers');

function dailyReport(ctx) {
  requirePermission(ctx, 'reports');
  const today = localDateStr(new Date().toISOString());
  const invoices = db.prepare('SELECT * FROM invoices WHERE voided=0').all().filter(i => localDateStr(i.date) === today);
  const cash = db.prepare('SELECT * FROM cashbox').all().filter(c => localDateStr(c.date) === today);
  const payments = db.prepare("SELECT * FROM payments WHERE type != 'debt'").all().filter(p => localDateStr(p.date) === today);

  const totalSales = invoices.reduce((s, i) => s + i.total, 0);
  const creditSales = invoices.reduce((s, i) => s + i.remaining, 0);
  const cashIn = cash.filter(c => c.type === 'in').reduce((s, c) => s + c.amount, 0);
  const cashOut = cash.filter(c => c.type === 'out').reduce((s, c) => s + c.amount, 0);
  const debtRepaid = payments.reduce((s, p) => s + p.amount, 0);
  let kg = 0, count = invoices.length;
  const lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?');
  invoices.forEach(inv => lines.all(inv.id).forEach(l => kg += l.weight_kg));

  return { data: { totalSales, creditSales, cashIn, cashOut, debtRepaid, count, kg } };
}

function profitReport(ctx) {
  requirePermission(ctx, 'reports');
  const { from, to } = ctx.query;
  const inRange = iso => { const d = localDateStr(iso); return (!from || d >= from) && (!to || d <= to); };

  const invoices = db.prepare('SELECT * FROM invoices WHERE voided=0').all().filter(i => inRange(i.date));
  const lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?');
  const agg = {};
  for (const inv of invoices) {
    for (const l of lines.all(inv.id)) {
      if (!agg[l.item_name]) agg[l.item_name] = { kg: 0, revenue: 0, cost: 0 };
      agg[l.item_name].kg += l.weight_kg;
      agg[l.item_name].revenue += l.total;
      agg[l.item_name].cost += l.weight_kg * (l.cost_per_kg_at_sale || 0);
    }
  }
  const returns = db.prepare('SELECT * FROM returns').all().filter(r => inRange(r.date));
  for (const r of returns) {
    if (!agg[r.item_name]) agg[r.item_name] = { kg: 0, revenue: 0, cost: 0 };
    agg[r.item_name].kg -= r.weight_kg;
    agg[r.item_name].revenue -= r.amount;
    agg[r.item_name].cost -= r.weight_kg * (r.cost_per_kg_at_return || 0);
  }
  const adjustments = db.prepare('SELECT * FROM adjustments WHERE cost_impact > 0').all().filter(a => inRange(a.date));
  for (const a of adjustments) {
    const key = a.item_name + ' (تلف/فقد مخزون)';
    if (!agg[key]) agg[key] = { kg: 0, revenue: 0, cost: 0 };
    agg[key].cost += a.cost_impact;
  }
  const rows = Object.entries(agg).map(([name, v]) => ({ name, ...v, profit: v.revenue - v.cost }));
  return { data: rows };
}

function weeklyReport(ctx) {
  requirePermission(ctx, 'reports');
  const { from, to } = ctx.query;
  const inRange = iso => { const d = localDateStr(iso); return (!from || d >= from) && (!to || d <= to); };

  const invoices = db.prepare('SELECT * FROM invoices WHERE voided=0').all().filter(i => inRange(i.date));
  const cash = db.prepare('SELECT * FROM cashbox').all().filter(c => inRange(c.date));
  const totalCashIn = cash.filter(c => c.type === 'in').reduce((s, c) => s + c.amount, 0);
  const totalCashOut = cash.filter(c => c.type === 'out').reduce((s, c) => s + c.amount, 0);
  const manualExpense = cash.filter(c => c.type === 'out' && c.source === 'يدوي').reduce((s, c) => s + c.amount, 0);
  const creditSales = invoices.reduce((s, i) => s + i.remaining, 0);
  const totalSales = invoices.reduce((s, i) => s + i.total, 0);

  const byCustomer = {};
  for (const inv of invoices) {
    if (!byCustomer[inv.customer_id]) byCustomer[inv.customer_id] = { count: 0, total: 0, paid: 0, remaining: 0 };
    byCustomer[inv.customer_id].count++;
    byCustomer[inv.customer_id].total += inv.total;
    byCustomer[inv.customer_id].paid += inv.paid;
    byCustomer[inv.customer_id].remaining += inv.remaining;
  }
  const customers = Object.entries(byCustomer).map(([id, v]) => {
    const c = db.prepare('SELECT name FROM customers WHERE id=?').get(id);
    return { customerId: Number(id), name: c ? c.name : 'زبون محذوف', ...v };
  });

  return {
    data: {
      totalCashIn, totalCashOut, creditSales, totalSales,
      manualExpense, netCashFlow: totalCashIn - totalCashOut,
      customers
    }
  };
}

function dashboardStats(ctx) {
  requirePermission(ctx, 'reports');
  const today = localDateStr(new Date().toISOString());

  // Today's sales & invoice count
  const todaySalesRow = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS count, COALESCE(SUM(remaining), 0) AS credit
    FROM invoices
    WHERE voided = 0 AND substr(date, 1, 10) = ?
  `).get(today);

  // Cashbox balance
  const cashInRow = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM cashbox WHERE type = 'in'").get();
  const cashOutRow = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM cashbox WHERE type = 'out'").get();
  const cashBalance = (cashInRow ? cashInRow.total : 0) - (cashOutRow ? cashOutRow.total : 0);

  // Total active customer debts
  const debtRow = db.prepare("SELECT COALESCE(SUM(balance), 0) AS total FROM customers WHERE is_deleted = 0 AND balance > 0").get();

  // Low stock items
  const lowStockItems = db.prepare("SELECT id, name, stock_kg, low_stock FROM items WHERE is_deleted = 0 AND stock_kg <= low_stock ORDER BY stock_kg ASC LIMIT 10").all();
  const lowStockCount = db.prepare("SELECT COUNT(*) AS count FROM items WHERE is_deleted = 0 AND stock_kg <= low_stock").get().count;

  // Recent invoices
  const recentInvoices = db.prepare(`
    SELECT i.id, i.date, i.total, i.paid, i.remaining, c.name AS customer_name
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.voided = 0
    ORDER BY i.id DESC
    LIMIT 6
  `).all();

  return {
    data: {
      todaySales: todaySalesRow ? todaySalesRow.total : 0,
      todayInvoicesCount: todaySalesRow ? todaySalesRow.count : 0,
      todayCreditSales: todaySalesRow ? todaySalesRow.credit : 0,
      cashBalance,
      totalDebts: debtRow ? debtRow.total : 0,
      lowStockCount,
      lowStockItems,
      recentInvoices
    }
  };
}

function activityLog(ctx) {
  requireRole(ctx, ['المالك']);
  const rows = db.prepare('SELECT * FROM activity_log ORDER BY date DESC LIMIT 300').all();
  return { data: rows };
}

module.exports = { dailyReport, profitReport, weeklyReport, activityLog, dashboardStats };
