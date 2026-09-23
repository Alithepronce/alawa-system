'use strict';
const db = require('../db');
const { HttpError, requireAuth, logActivity, num, str, nowISO } = require('../helpers');

function listItems(ctx) {
  requireAuth(ctx);
  const includeDeleted = ctx.query && ctx.query.all === '1';
  const sql = includeDeleted
    ? 'SELECT * FROM items ORDER BY name'
    : 'SELECT * FROM items WHERE is_deleted = 0 ORDER BY name';
  return { data: db.prepare(sql).all() };
}
function createItem(ctx) {
  requireAuth(ctx);
  const name = str(ctx.body.name);
  if (!name) throw new HttpError(400, 'أدخل اسم المادة');
  const info = db.prepare(`
    INSERT INTO items (name, bag_weight, stock_kg, low_stock, avg_cost_per_kg, price_wholesale, price_office, price_normal, expiry_date, sale_count, barcode)
    VALUES (?,?,?,?,?,?,?,?,?,0,?)
  `).run(
    name, num(ctx.body.bagWeight, 1), num(ctx.body.stockKg), num(ctx.body.lowStock, 200),
    num(ctx.body.openingCost), num(ctx.body.priceWholesale), num(ctx.body.priceOffice), num(ctx.body.priceNormal),
    ctx.body.expiryDate || null, str(ctx.body.barcode) || null
  );
  logActivity(ctx, 'إضافة مادة', name);
  return { status: 201, data: { id: Number(info.lastInsertRowid) } };
}
function updateItem(ctx, id) {
  requireAuth(ctx);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!it) throw new HttpError(404, 'المادة غير موجودة');
  const name = str(ctx.body.name) || it.name;
  // NOTE: stock_kg is intentionally omitted from direct update — inventory must only change
  // via sales, purchases, returns, or formal stock adjustments (adjustItem) with recorded reason.
  db.prepare(`
    UPDATE items SET name=?, bag_weight=?, low_stock=?, price_wholesale=?, price_office=?, price_normal=?, expiry_date=?, barcode=?
    WHERE id=?
  `).run(
    name, num(ctx.body.bagWeight, it.bag_weight), num(ctx.body.lowStock, it.low_stock),
    num(ctx.body.priceWholesale, it.price_wholesale), num(ctx.body.priceOffice, it.price_office), num(ctx.body.priceNormal, it.price_normal),
    ctx.body.expiryDate || it.expiry_date, str(ctx.body.barcode) || it.barcode || null, id
  );
  logActivity(ctx, 'تعديل مادة', name);
  return { data: { ok: true } };
}
function deleteItem(ctx, id) {
  requireAuth(ctx);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!it) throw new HttpError(404, 'المادة غير موجودة');

  // Prevent deleting items with remaining physical stock
  if (it.stock_kg > 0.001) {
    throw new HttpError(400, `لا يمكن حذف مادة "${it.name}" وما زال يوجد منها مخزون في المستودع (${it.stock_kg} كغم). قم بتصفير المخزون عبر تسوية المخزون أولاً`);
  }

  // Prevent deleting items that have historical sales records
  const salesCount = db.prepare('SELECT COUNT(*) as c FROM invoice_lines WHERE item_id=?').get(id).c;
  if (salesCount > 0) {
    throw new HttpError(400, `لا يمكن حذف مادة "${it.name}" لوجود (${salesCount}) عمليات بيع مسجلة بها في فواتير سابقة. يمكنك إخفاؤها أو تعديلها`);
  }

  // Prevent deleting items that have historical purchase records
  const purchCount = db.prepare('SELECT COUNT(*) as c FROM purchase_lines WHERE item_id=?').get(id).c;
  if (purchCount > 0) {
    throw new HttpError(400, `لا يمكن حذف مادة "${it.name}" لوجود (${purchCount}) عمليات شراء مسجلة بها في فواتير شراء سابقة`);
  }

  try {
    db.prepare('UPDATE items SET is_deleted=1, deleted_at=datetime(\'now\') WHERE id=?').run(id);
  } catch (_) {
    db.prepare('DELETE FROM items WHERE id=?').run(id);
  }

  logActivity(ctx, 'حذف مادة', `${it.name} — كان مخزونها ${it.stock_kg} كغم`);
  return { data: { ok: true } };
}
// Stock adjustment: reason required; any DECREASE is costed against profit as wastage,
// instead of silently vanishing from inventory with no financial trace.
function adjustItem(ctx, id) {
  requireAuth(ctx);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!it) throw new HttpError(404, 'المادة غير موجودة');
  const newStock = num(ctx.body.newStock, NaN);
  if (!Number.isFinite(newStock) || newStock < 0) throw new HttpError(400, 'قيمة غير صحيحة');
  const reason = str(ctx.body.reason) || 'أخرى';
  const note = str(ctx.body.note);
  const diffKg = newStock - it.stock_kg;
  const costImpact = diffKg < 0 ? Math.abs(diffKg) * (it.avg_cost_per_kg || 0) : 0;
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO adjustments (item_id, item_name, date, old_stock, new_stock, diff_kg, reason, note, cost_impact, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, it.name, nowISO(), it.stock_kg, newStock, diffKg, reason, note, costImpact, ctx.session.id);
    db.prepare('UPDATE items SET stock_kg=? WHERE id=?').run(newStock, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'تسوية مخزون', `${it.name}: من ${it.stock_kg} إلى ${newStock} كغم (${reason})${costImpact > 0 ? ' — خسارة تقديرية ' + costImpact.toFixed(2) : ''}`);
  return { data: { ok: true, costImpact } };
}

module.exports = { listItems, createItem, updateItem, deleteItem, adjustItem };
