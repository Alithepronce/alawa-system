'use strict';
const db = require('../db');
const auth = require('../auth');
const { HttpError, requireAuth, requireRole, logActivity, num, str, nowISO, weightKg } = require('../helpers');

function priceForItem(item, unit, category) {
  const perBag = category === 'جملة' ? item.price_wholesale : category === 'مكاتب' ? item.price_office : item.price_normal;
  if (unit === 'كيس') return perBag;
  const perKg = perBag / (item.bag_weight || 1);
  if (unit === 'طن') return perKg * 1000;
  return perKg;
}

function listInvoices(ctx) {
  requireAuth(ctx);
  const { from, to, customerId } = ctx.query;
  let sql = 'SELECT * FROM invoices WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND date(date) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(date) <= date(?)'; params.push(to); }
  if (customerId) { sql += ' AND customer_id = ?'; params.push(customerId); }
  sql += ' ORDER BY date DESC';
  const invoices = db.prepare(sql).all(...params);
  const linesStmt = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?');
  for (const inv of invoices) inv.lines = linesStmt.all(inv.id);
  return { data: invoices };
}

// The core sale transaction. Every check that used to live only in browser JavaScript
// (and could be bypassed by editing it) is re-verified here, server-side, against the
// database as it actually is right now — not as the client believes it to be.
function createInvoice(ctx) {
  const session = requireAuth(ctx);
  const customerId = ctx.body.customerId;
  const lines = Array.isArray(ctx.body.lines) ? ctx.body.lines : [];
  if (!customerId) throw new HttpError(400, 'اختر الزبون');
  if (lines.length === 0) throw new HttpError(400, 'أضف مادة واحدة على الأقل');

  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  if (!customer) throw new HttpError(404, 'الزبون غير موجود');

  // Load and lock-in item data for this transaction
  const itemIds = [...new Set(lines.map(l => l.itemId))];
  const items = {};
  for (const id of itemIds) {
    const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!it) throw new HttpError(400, `مادة غير موجودة (${id})`);
    items[id] = it;
  }

  // Aggregate required weight per item across all lines (fixes the "same item sold in
  // two units in one sale" oversell bug from the client-only version) and validate stock.
  const neededByItem = {};
  const computedLines = [];
  let total = 0;
  for (const l of lines) {
    const item = items[l.itemId];
    const qty = num(l.qty);
    const unit = str(l.unit) || 'كيس';
    if (qty <= 0) throw new HttpError(400, 'كمية غير صحيحة');
    const wKg = weightKg(qty, unit, item.bag_weight);
    neededByItem[l.itemId] = (neededByItem[l.itemId] || 0) + wKg;
    const price = l.priceOverride != null ? num(l.priceOverride) : priceForItem(item, unit, customer.category);
    const lineTotal = price * qty;
    total += lineTotal;
    computedLines.push({ itemId: item.id, itemName: item.name, qty, unit, weightKg: wKg, price, total: lineTotal, costPerKgAtSale: item.avg_cost_per_kg || 0 });
  }
  for (const [itemId, needed] of Object.entries(neededByItem)) {
    const item = items[itemId];
    if (needed > item.stock_kg + 0.001) {
      throw new HttpError(400, `الكمية الإجمالية المطلوبة من "${item.name}" (${needed.toFixed(2)} كغم) أكبر من المخزون المتاح (${item.stock_kg.toFixed(2)} كغم)`);
    }
  }

  const paid = Math.max(0, num(ctx.body.paid));
  const remaining = Math.max(total - paid, 0);
  const prevDebt = customer.balance;
  const projected = customer.balance + remaining;
  let overridden = false;

  if (projected > customer.credit_limit) {
    overridden = true;
    // Owners may always proceed. Non-owners must supply a valid owner PIN, verified
    // server-side against real password hashes — this cannot be faked from the browser.
    if (session.role !== 'المالك') {
      const overridePin = str(ctx.body.overridePin);
      if (!overridePin) throw new HttpError(409, 'تجاوز سقف الدين — يتطلب تأكيد المالك');
      const owners = db.prepare("SELECT * FROM users WHERE role='المالك'").all();
      const ok = owners.some(o => auth.verifyPassword(overridePin, o.salt, o.password_hash));
      if (!ok) throw new HttpError(403, 'رمز المالك غير صحيح');
    }
  }

  const date = nowISO();
  let invoiceId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO invoices (customer_id, date, due_date, total, paid, remaining, prev_debt, driver_name, driver_phone, overridden, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(customerId, date, ctx.body.dueDate || null, total, paid, remaining, prevDebt, str(ctx.body.driverName), str(ctx.body.driverPhone), overridden ? 1 : 0, session.id);
    invoiceId = Number(info.lastInsertRowid);

    const insLine = db.prepare(`
      INSERT INTO invoice_lines (invoice_id, item_id, item_name, qty, unit, weight_kg, price, total, cost_per_kg_at_sale)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    for (const l of computedLines) {
      insLine.run(invoiceId, l.itemId, l.itemName, l.qty, l.unit, l.weightKg, l.price, l.total, l.costPerKgAtSale);
      db.prepare('UPDATE items SET stock_kg = stock_kg - ?, sale_count = sale_count + 1 WHERE id=?').run(l.weightKg, l.itemId);
    }
    db.prepare('UPDATE customers SET balance = balance + ? WHERE id=?').run(remaining, customerId);
    if (paid > 0) {
      db.prepare(`INSERT INTO cashbox (date, type, amount, source, note, customer_name, created_by) VALUES (?,'in',?,'بيع',?,?,?)`)
        .run(date, paid, `قائمة #${invoiceId} - ${customer.name}`, customer.name, session.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  if (overridden) logActivity(ctx, 'تجاوز سقف الدين', `القائمة #${invoiceId} للزبون ${customer.name} — رصيد متوقع ${projected.toFixed(2)}`);

  // Warn about any item that's now low on stock (informational, mirrors client behavior)
  const lowStockWarnings = [];
  for (const l of computedLines) {
    const fresh = db.prepare('SELECT * FROM items WHERE id=?').get(l.itemId);
    if (fresh.stock_kg <= fresh.low_stock) lowStockWarnings.push(fresh.name);
  }

  const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  invoice.lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?').all(invoiceId);
  return { status: 201, data: { invoice, lowStockWarnings } };
}

function voidInvoice(ctx, id) {
  const session = requireAuth(ctx);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
  if (!invoice) throw new HttpError(404, 'الفاتورة غير موجودة');
  if (invoice.voided) throw new HttpError(400, 'الفاتورة ملغاة مسبقاً');
  // Voiding is owner-only OR requires a valid owner PIN from a non-owner, same rule as credit override
  if (session.role !== 'المالك') {
    const overridePin = str(ctx.body.overridePin);
    const owners = db.prepare("SELECT * FROM users WHERE role='المالك'").all();
    const ok = overridePin && owners.some(o => auth.verifyPassword(overridePin, o.salt, o.password_hash));
    if (!ok) throw new HttpError(403, 'إلغاء الفاتورة يتطلب تأكيد المالك');
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(invoice.customer_id);
  const lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?').all(id);
  const date = nowISO();
  db.exec('BEGIN');
  try {
    for (const l of lines) {
      if (l.item_id) db.prepare('UPDATE items SET stock_kg = stock_kg + ? WHERE id=?').run(l.weight_kg, l.item_id);
    }
    if (customer) db.prepare('UPDATE customers SET balance = balance - ? WHERE id=?').run(invoice.remaining, customer.id);
    if (invoice.paid > 0) {
      db.prepare(`INSERT INTO cashbox (date, type, amount, source, note, customer_name, created_by) VALUES (?,'out',?,'إلغاء فاتورة',?,?,?)`)
        .run(date, invoice.paid, `إلغاء قائمة #${id}` + (customer ? ' - ' + customer.name : ''), customer ? customer.name : null, session.id);
    }
    db.prepare('UPDATE invoices SET voided=1, voided_at=? WHERE id=?').run(date, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'إلغاء فاتورة', `القائمة #${id}` + (customer ? ' للزبون ' + customer.name : '') + ` — إجمالي ${invoice.total}`);
  return { data: { ok: true } };
}

module.exports = { listInvoices, createInvoice, voidInvoice };
