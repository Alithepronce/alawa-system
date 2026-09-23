'use strict';
const db = require('../db');
const { HttpError, requirePermission, logActivity, num, str, nowISO } = require('../helpers');

function listSuppliers(ctx) {
  const session = requirePermission(ctx, 'suppliers.read');
  const includeDeleted = ctx.query && ctx.query.all === '1';
  const sql = includeDeleted
    ? 'SELECT * FROM suppliers ORDER BY name'
    : 'SELECT * FROM suppliers WHERE is_deleted = 0 ORDER BY name';
  const suppliers = db.prepare(sql).all();
  if (session.role === 'أمين مخزن') return { data: suppliers.map(({ balance, ...supplier }) => supplier) };
  return { data: suppliers };
}
function createSupplier(ctx) {
  requirePermission(ctx, 'suppliers.manage');
  const name = str(ctx.body.name);
  if (!name) throw new HttpError(400, 'أدخل اسم المورد');
  const openingBalance = num(ctx.body.openingBalance);
  let info;
  db.exec('BEGIN');
  try {
    info = db.prepare('INSERT INTO suppliers (name, phone, balance) VALUES (?,?,?)').run(name, str(ctx.body.phone), openingBalance);
    if (openingBalance !== 0) db.prepare('INSERT INTO supplier_openings (supplier_id,amount,date,created_by) VALUES (?,?,?,?)').run(Number(info.lastInsertRowid), openingBalance, nowISO(), ctx.session.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  logActivity(ctx, 'إضافة مورد', name);
  return { status: 201, data: { id: Number(info.lastInsertRowid) } };
}
function updateSupplier(ctx, id) {
  requirePermission(ctx, 'suppliers.manage');
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!s) throw new HttpError(404, 'المورد غير موجود');
  const name = str(ctx.body.name) || s.name;
  db.prepare('UPDATE suppliers SET name=?, phone=? WHERE id=?').run(name, str(ctx.body.phone), id);
  logActivity(ctx, 'تعديل مورد', name);
  return { data: { ok: true } };
}
function deleteSupplier(ctx, id) {
  requirePermission(ctx, 'suppliers.manage');
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!s) throw new HttpError(404, 'المورد غير موجود');

  // Prevent deletion if supplier has non-zero balance
  if (Math.abs(s.balance) > 0.01) {
    throw new HttpError(400, `لا يمكن حذف المورد "${s.name}" لوجود رصيد متبقي (${s.balance}). يجب تصفية الحساب أولاً`);
  }

  // Check for existing purchases
  const purchCount = db.prepare('SELECT COUNT(*) as c FROM purchases WHERE supplier_id=?').get(id).c;
  if (purchCount > 0) {
    throw new HttpError(400, `لا يمكن حذف المورد "${s.name}" لوجود (${purchCount}) فواتير شراء مرتبطة به في النظام`);
  }

  const payCount = db.prepare('SELECT COUNT(*) as c FROM supplier_payments WHERE supplier_id=?').get(id).c;
  if (payCount > 0) {
    throw new HttpError(400, `لا يمكن حذف المورد "${s.name}" لوجود دفعات مالية مسجلة في سجله`);
  }

  try {
    db.prepare('UPDATE suppliers SET is_deleted=1, deleted_at=datetime(\'now\') WHERE id=?').run(id);
  } catch (_) {
    db.prepare('DELETE FROM suppliers WHERE id=?').run(id);
  }

  logActivity(ctx, 'حذف مورد', `${s.name} — رصيد ${s.balance}`);
  return { data: { ok: true } };
}
function supplierPayment(ctx, id) {
  requirePermission(ctx, 'suppliers.finance');
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!s) throw new HttpError(404, 'المورد غير موجود');
  const amount = num(ctx.body.amount);
  if (amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً');
  const date = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO supplier_payments (supplier_id, amount, date, created_by) VALUES (?,?,?,?)').run(id, amount, date, ctx.session.id);
    db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id=?').run(amount, id);
    db.prepare('INSERT INTO cashbox (date, type, amount, source, note, created_by) VALUES (?,\'out\',?,\'تسديد لمورد\',?,?)').run(date, amount, s.name, ctx.session.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'تسديد لمورد', `${s.name}: ${amount}`);
  return { data: { ok: true } };
}
function supplierLedger(ctx, id) {
  requirePermission(ctx, 'suppliers.ledger');
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!s) throw new HttpError(404, 'المورد غير موجود');
  const rows = [];
  const opening = db.prepare('SELECT * FROM supplier_openings WHERE supplier_id=? ORDER BY date').all(id);
  for (const o of opening) rows.push({ date: o.date, desc: 'رصيد افتتاحي', debit: o.amount < 0 ? Math.abs(o.amount) : 0, credit: o.amount > 0 ? o.amount : 0 });
  const purchases = db.prepare('SELECT * FROM purchases WHERE supplier_id=? ORDER BY date').all(id);
  const plines = db.prepare('SELECT * FROM purchase_lines WHERE purchase_id=?');
  for (const p of purchases) {
    const lines = plines.all(p.id);
    rows.push({
      date: p.date, desc: `فاتورة شراء #${p.id}`, debit: 0, credit: p.total,
      material: lines.map(l => { const it = db.prepare('SELECT name FROM items WHERE id=?').get(l.item_id); return it ? it.name : '-'; }).join('، '),
      qty: lines.map(l => `${l.qty} كغم`).join('، ')
    });
  }
  const payments = db.prepare('SELECT * FROM supplier_payments WHERE supplier_id=? ORDER BY date').all(id);
  for (const p of payments) rows.push({ date: p.date, desc: 'دفعة مسددة', debit: p.amount, credit: 0 });
  const returns = db.prepare('SELECT * FROM supplier_returns WHERE supplier_id=? ORDER BY date').all(id);
  for (const r of returns) {
    const label = r.method === 'credit' ? 'إرجاع مواد (خصم من الرصيد): ' : 'إرجاع مواد (نقدي): ';
    rows.push({ date: r.date, desc: `${label}${r.item_name} — ${r.amount}`, debit: r.method === 'credit' ? r.amount : 0, credit: 0, material: r.item_name, qty: `${r.qty} ${r.unit}` });
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { data: { rows, balance: s.balance, supplier: s } };
}

module.exports = { listSuppliers, createSupplier, updateSupplier, deleteSupplier, supplierPayment, supplierLedger };
