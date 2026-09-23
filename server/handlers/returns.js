'use strict';
const db = require('../db');
const { HttpError, requirePermission, logActivity, num, str, nowISO, weightKg } = require('../helpers');

function createReturn(ctx) {
  const session = requirePermission(ctx, 'returns');
  const { customerId, itemId, method } = ctx.body;
  const qty = num(ctx.body.qty), unit = str(ctx.body.unit) || 'كيس', price = num(ctx.body.price);
  if (!customerId || !itemId) throw new HttpError(400, 'اختر الزبون والمادة');
  if (qty <= 0) throw new HttpError(400, 'أدخل كمية صحيحة');
  if (!['كيس', 'كغم', 'طن'].includes(unit)) throw new HttpError(400, 'وحدة الإرجاع غير صحيحة');
  if (price <= 0) throw new HttpError(400, 'سعر الإرجاع يجب أن يكون أكبر من صفر');
  if (!['cash','credit'].includes(method)) throw new HttpError(400, 'طريقة إرجاع غير صحيحة');
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!customer || !item) throw new HttpError(404, 'بيانات غير موجودة');
  const wKg = weightKg(qty, unit, item.bag_weight);
  const sold = db.prepare(`SELECT COALESCE(SUM(weight_kg),0) AS kg, COALESCE(SUM(total),0) AS amount FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id WHERE i.customer_id=? AND il.item_id=? AND i.voided=0`).get(customerId, itemId);
  const returned = db.prepare('SELECT COALESCE(SUM(weight_kg),0) AS kg, COALESCE(SUM(amount),0) AS amount FROM returns WHERE customer_id=? AND item_id=?').get(customerId, itemId);
  if (wKg > sold.kg - returned.kg + 0.001) throw new HttpError(400, 'كمية الإرجاع تتجاوز صافي ما اشتراه هذا الزبون من المادة');
  const amount = qty * price;
  const maxRefundForQuantity = sold.kg > 0 ? (sold.amount / sold.kg) * wKg : 0;
  if (amount > Math.min(sold.amount - returned.amount, maxRefundForQuantity) + 0.005) throw new HttpError(400, 'قيمة الإرجاع تتجاوز القيمة المتبقية للكمية المباعة');
  if (method === 'cash') {
    const paidShare = db.prepare(`SELECT COALESCE(SUM(il.total * CASE WHEN i.total>0 THEN i.paid/i.total ELSE 0 END),0) AS amount
      FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id
      WHERE i.customer_id=? AND il.item_id=? AND i.voided=0`).get(customerId,itemId).amount;
    const priorCash = db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM returns WHERE customer_id=? AND item_id=? AND method='cash'").get(customerId,itemId).amount;
    if (amount > paidShare - priorCash + 0.005) throw new HttpError(400, 'لا يمكن رد نقد أكثر من المبلغ المقبوض فعلياً عن مبيعات هذه المادة');
  }
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
  const session = requirePermission(ctx, 'supplier.returns');
  const { supplierId, itemId, method } = ctx.body;
  const qty = num(ctx.body.qty), unit = str(ctx.body.unit) || 'كيس';
  if (!supplierId || !itemId) throw new HttpError(400, 'اختر المورد والمادة');
  if (qty <= 0) throw new HttpError(400, 'أدخل كمية صحيحة');
  if (!['كيس', 'كغم', 'طن'].includes(unit)) throw new HttpError(400, 'وحدة الإرجاع غير صحيحة');
  if (!['cash','credit'].includes(method)) throw new HttpError(400, 'طريقة إرجاع غير صحيحة');
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!supplier || !item) throw new HttpError(404, 'بيانات غير موجودة');
  const wKg = weightKg(qty, unit, item.bag_weight);
  const cost = session.role === 'أمين مخزن'
    ? (item.avg_cost_per_kg || 0) * (unit === 'كيس' ? item.bag_weight : unit === 'طن' ? 1000 : 1)
    : num(ctx.body.cost);
  if (cost <= 0) throw new HttpError(400, 'تكلفة الإرجاع يجب أن تكون أكبر من صفر');
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
