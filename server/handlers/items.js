'use strict';
const db = require('../db');
const { HttpError, requirePermission, logActivity, num, str, nowISO } = require('../helpers');

function listItems(ctx) {
  const session = requirePermission(ctx, 'items.read');
  const includeDeleted = ctx.query && ctx.query.all === '1';
  const sql = includeDeleted
    ? 'SELECT * FROM items ORDER BY name'
    : 'SELECT * FROM items WHERE is_deleted = 0 ORDER BY name';
  const items = db.prepare(sql).all();
  if (session.role === 'أمين مخزن') return { data: items.map(({ price_wholesale, price_office, price_normal, avg_cost_per_kg, ...item }) => item) };
  return { data: items };
}
function createItem(ctx) {
  const session = requirePermission(ctx, 'items.manage');
  const name = str(ctx.body.name);
  if (!name) throw new HttpError(400, 'أدخل اسم المادة');
  const bagWeight = num(ctx.body.bagWeight, 1), stockKg = num(ctx.body.stockKg), lowStock = num(ctx.body.lowStock, 200);
  const openingCost = num(ctx.body.openingCost), wholesale = num(ctx.body.priceWholesale), office = num(ctx.body.priceOffice), normal = num(ctx.body.priceNormal);
  if (bagWeight <= 0 || stockKg < 0 || lowStock < 0 || openingCost < 0 || wholesale < 0 || office < 0 || normal < 0) throw new HttpError(400, 'الأوزان والكميات والتكاليف والأسعار يجب أن تكون صفراً أو أكبر، ووزن الكيس أكبر من صفر');
  if (session.role === 'أمين مخزن' && (openingCost || wholesale || office || normal)) throw new HttpError(403, 'لا يملك أمين المخزن صلاحية تحديد التكلفة أو أسعار البيع');
  const info = db.prepare(`
    INSERT INTO items (name, bag_weight, stock_kg, low_stock, avg_cost_per_kg, price_wholesale, price_office, price_normal, expiry_date, sale_count, barcode)
    VALUES (?,?,?,?,?,?,?,?,?,0,?)
  `).run(
    name, bagWeight, stockKg, lowStock,
    openingCost, wholesale, office, normal,
    ctx.body.expiryDate || null, str(ctx.body.barcode) || null
  );
  logActivity(ctx, 'إضافة مادة', name);
  return { status: 201, data: { id: Number(info.lastInsertRowid) } };
}
function updateItem(ctx, id) {
  const session = requirePermission(ctx, 'items.manage');
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!it) throw new HttpError(404, 'المادة غير موجودة');
  const name = str(ctx.body.name) || it.name;
  const bagWeight = num(ctx.body.bagWeight, it.bag_weight), lowStock = num(ctx.body.lowStock, it.low_stock);
  const wholesale = num(ctx.body.priceWholesale, it.price_wholesale), office = num(ctx.body.priceOffice, it.price_office), normal = num(ctx.body.priceNormal, it.price_normal);
  if (bagWeight <= 0 || lowStock < 0 || wholesale < 0 || office < 0 || normal < 0) throw new HttpError(400, 'وزن الكيس يجب أن يكون أكبر من صفر والأسعار والحدود لا يمكن أن تكون سالبة');
  if (session.role === 'أمين مخزن' && (wholesale !== it.price_wholesale || office !== it.price_office || normal !== it.price_normal)) throw new HttpError(403, 'لا يملك أمين المخزن صلاحية تعديل أسعار البيع');
  // NOTE: stock_kg is intentionally omitted from direct update — inventory must only change
  // via sales, purchases, returns, or formal stock adjustments (adjustItem) with recorded reason.
  db.prepare(`
    UPDATE items SET name=?, bag_weight=?, low_stock=?, price_wholesale=?, price_office=?, price_normal=?, expiry_date=?, barcode=?
    WHERE id=?
  `).run(
    name, bagWeight, lowStock,
    wholesale, office, normal,
    ctx.body.expiryDate || it.expiry_date, str(ctx.body.barcode) || it.barcode || null, id
  );
  logActivity(ctx, 'تعديل مادة', name);
  return { data: { ok: true } };
}
function deleteItem(ctx, id) {
  requirePermission(ctx, 'items.manage');
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
  requirePermission(ctx, 'inventory.adjust');
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
