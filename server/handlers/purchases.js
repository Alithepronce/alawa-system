'use strict';
const db = require('../db');
const { HttpError, requirePermission, logActivity, num, str, nowISO } = require('../helpers');

function createPurchase(ctx) {
  const session = requirePermission(ctx, 'purchases');
  const supplierId = ctx.body.supplierId;
  const lines = Array.isArray(ctx.body.lines) ? ctx.body.lines : [];
  if (!supplierId) throw new HttpError(400, 'اختر المورد');
  if (lines.length === 0) throw new HttpError(400, 'أضف مادة واحدة على الأقل');
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  if (!supplier) throw new HttpError(404, 'المورد غير موجود');

  const items = {};
  let totalQty = 0;
  for (const l of lines) {
    const item = db.prepare('SELECT * FROM items WHERE id=?').get(l.itemId);
    if (!item) throw new HttpError(400, `مادة غير موجودة (${l.itemId})`);
    const qty = num(l.qty), cost = num(l.cost);
    if (qty <= 0) throw new HttpError(400, 'كمية غير صحيحة');
    if (cost < 0) throw new HttpError(400, 'تكلفة الشراء لا يمكن أن تكون سالبة');
    items[l.itemId] = item;
    totalQty += qty;
  }

  const transportCost = num(ctx.body.transportCost);
  const loadingCost = num(ctx.body.loadingCost);
  if (transportCost < 0 || loadingCost < 0) throw new HttpError(400, 'أجور النقل والتحميل لا يمكن أن تكون سالبة');
  const extraPerKg = totalQty > 0 ? (transportCost + loadingCost) / totalQty : 0;
  let subtotal = 0;
  lines.forEach(l => subtotal += num(l.qty) * num(l.cost));
  const total = subtotal + transportCost + loadingCost;
  const paid = Math.max(0, num(ctx.body.paid));
  if (total <= 0) throw new HttpError(400, 'إجمالي الشراء يجب أن يكون أكبر من صفر');
  if (paid > total + 0.005) throw new HttpError(400, 'المبلغ المدفوع لا يمكن أن يتجاوز إجمالي الشراء');
  const remaining = Math.max(total - paid, 0);
  const date = nowISO();

  let purchaseId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO purchases (supplier_id, date, transport_cost, loading_cost, total, paid, remaining, created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(supplierId, date, transportCost, loadingCost, total, paid, remaining, session.id);
    purchaseId = Number(info.lastInsertRowid);

    const insLine = db.prepare('INSERT INTO purchase_lines (purchase_id, item_id, qty, cost, true_cost_per_kg) VALUES (?,?,?,?,?)');
    for (const l of lines) {
      const qty = num(l.qty), cost = num(l.cost);
      const trueCost = cost + extraPerKg;
      insLine.run(purchaseId, l.itemId, qty, cost, trueCost);
      const item = db.prepare('SELECT * FROM items WHERE id=?').get(l.itemId); // re-read for latest stock within tx
      const oldValue = item.stock_kg * (item.avg_cost_per_kg || 0);
      const newValue = qty * trueCost;
      const newStock = item.stock_kg + qty;
      const newAvgCost = newStock > 0 ? (oldValue + newValue) / newStock : trueCost;
      db.prepare('UPDATE items SET stock_kg=?, avg_cost_per_kg=? WHERE id=?').run(newStock, newAvgCost, l.itemId);
    }
    db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id=?').run(remaining, supplierId);
    if (paid > 0) {
      db.prepare(`INSERT INTO cashbox (date, type, amount, source, note, created_by) VALUES (?,'out',?,'شراء',?,?)`)
        .run(date, paid, `فاتورة شراء #${purchaseId} - ${supplier.name}`, session.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  logActivity(ctx, 'فاتورة شراء', `#${purchaseId} من ${supplier.name} بقيمة ${total}`);
  return { status: 201, data: { id: purchaseId } };
}

module.exports = { createPurchase };
