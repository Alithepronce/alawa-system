'use strict';
const db = require('../db');
const { HttpError, requireAuth, logActivity, num, str, nowISO, weightKg } = require('../helpers');

function createReturn(ctx) {
  const session = requireAuth(ctx);
  const { customerId, itemId, method } = ctx.body;
  const qty = num(ctx.body.qty), unit = str(ctx.body.unit) || 'كيس', price = num(ctx.body.price);
  if (!customerId || !itemId) throw new HttpError(400, 'اختر الزبون والمادة');
  if (qty <= 0) throw new HttpError(400, 'أدخل كمية صحيحة');
  if (!['cash','credit'].includes(method)) throw new HttpError(400, 'طريقة إرجاع غير صحيحة');
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!customer || !item) throw new HttpError(404, 'بيانات غير موجودة');
  const wKg = weightKg(qty, unit, item.bag_weight);
  const amount = qty * price;
  const date = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE items SET stock_kg = stock_kg + ? WHERE id=?').run(wKg, itemId);
    db.prepare(`INSERT INTO returns (customer_id, item_id, item_name, qty, unit, weight_kg, price, amount, method, cost_per_kg_at_return, date, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(customerId, itemId, item.name, qty, unit, wKg, price, amount, method, item.avg_cost_per_kg || 0, date, session.id);
    if (method === 'cash') {
      db.prepare(`INSERT INTO cashbox (date, type, amount, source, note, customer_name, created_by) VALUES (?,'out',?,'مرتجع نقدي',?,?,?)`)
        .run(date, amount, `إرجاع ${item.name} - ${customer.name}`, customer.name, session.id);
    } else {
      db.prepare('UPDATE customers SET balance = balance - ? WHERE id=?').run(amount, customerId);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'إرجاع مواد', `${item.name} من ${customer.name} بقيمة ${amount}`);
  return { status: 201, data: { ok: true } };
}

function createSupplierReturn(ctx) {
  const session = requireAuth(ctx);
  const { supplierId, itemId, method } = ctx.body;
  const qty = num(ctx.body.qty), unit = str(ctx.body.unit) || 'كيس', cost = num(ctx.body.cost);
  if (!supplierId || !itemId) throw new HttpError(400, 'اختر المورد والمادة');
  if (qty <= 0) throw new HttpError(400, 'أدخل كمية صحيحة');
  if (!['cash','credit'].includes(method)) throw new HttpError(400, 'طريقة إرجاع غير صحيحة');
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!supplier || !item) throw new HttpError(404, 'بيانات غير موجودة');
  const wKg = weightKg(qty, unit, item.bag_weight);
  if (wKg > item.stock_kg + 0.001) throw new HttpError(400, 'الكمية المرتجعة أكبر من المخزون المتاح');
  const amount = qty * cost;
  const date = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE items SET stock_kg = stock_kg - ? WHERE id=?').run(wKg, itemId);
    db.prepare(`INSERT INTO supplier_returns (supplier_id, item_id, item_name, qty, unit, weight_kg, cost, amount, method, date, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(supplierId, itemId, item.name, qty, unit, wKg, cost, amount, method, date, session.id);
    if (method === 'cash') {
      db.prepare(`INSERT INTO cashbox (date, type, amount, source, note, created_by) VALUES (?,'in',?,'مرتجع مشتريات',?,?)`)
        .run(date, amount, `إرجاع ${item.name} - ${supplier.name}`, session.id);
    } else {
      db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id=?').run(amount, supplierId);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'إرجاع لمورد', `${item.name} إلى ${supplier.name} بقيمة ${amount}`);
  return { status: 201, data: { ok: true } };
}

module.exports = { createReturn, createSupplierReturn };
