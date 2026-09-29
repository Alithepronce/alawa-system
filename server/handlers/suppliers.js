'use strict';
const db = require('../db');
const auth = require('../auth');
const { HttpError, requirePermission, logActivity, num, str, nowISO } = require('../helpers');

function verifyOwnerPassword(value, ctx) {
  const password = str(value);
  const owners = db.prepare("SELECT id,salt,password_hash FROM users WHERE role='المالك'").all();
  if (!owners.length) throw new HttpError(403, 'حساب المالك غير موجود');
  if (owners.some(owner => auth.isLockedOut(owner.id))) throw new HttpError(429, 'محاولات رمز المالك كثيرة — حاول بعد 30 ثانية');
  const configuredPin = db.prepare("SELECT value FROM settings WHERE key='ownerOverridePinHash'").get();
  const pinSalt = db.prepare("SELECT value FROM settings WHERE key='ownerOverridePinSalt'").get();
  const valid = configuredPin && pinSalt
    ? auth.verifyPassword(password, pinSalt.value, configuredPin.value)
    : owners.some(owner => auth.verifyPassword(password, owner.salt, owner.password_hash));
  for (const owner of owners) auth.recordAttempt(owner.id, ctx.ip, valid);
  if (!valid) throw new HttpError(403, configuredPin ? 'رمز تأكيد المالك غير صحيح' : 'رمز مرور المالك غير صحيح');
}

function findLegacyCashboxRow(payment, supplierName) {
  const rows = db.prepare(`SELECT id,note FROM cashbox WHERE type='out' AND source='تسديد لمورد'
    AND date=? AND ABS(amount-?)<0.005
    AND id NOT IN (SELECT cashbox_id FROM supplier_payments WHERE cashbox_id IS NOT NULL) ORDER BY id`)
    .all(payment.date, payment.amount);
  const exact = rows.filter(row => row.note === supplierName);
  return exact.length ? exact[0] : rows.length === 1 ? rows[0] : null;
}

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
  if (db.prepare('SELECT COUNT(*) as c FROM supplier_entries WHERE supplier_id=?').get(id).c > 0) {
    throw new HttpError(400, `لا يمكن حذف المورد "${s.name}" لوجود قيود مسجلة في كشف حسابه`);
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
    const cashbox = db.prepare('INSERT INTO cashbox (date, type, amount, source, note, created_by) VALUES (?,\'out\',?,\'تسديد لمورد\',?,?)').run(date, amount, s.name, ctx.session.id);
    db.prepare('INSERT INTO supplier_payments (supplier_id, amount, date, created_by, cashbox_id) VALUES (?,?,?,?,?)')
      .run(id, amount, date, ctx.session.id, Number(cashbox.lastInsertRowid));
    db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id=?').run(amount, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'تسديد لمورد', `${s.name}: ${amount}`);
  return { data: { ok: true } };
}

function editSupplierPayment(ctx, supplierId, paymentId) {
  requirePermission(ctx, 'suppliers.finance');
  verifyOwnerPassword(ctx.body.ownerPassword, ctx);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  const payment = db.prepare('SELECT * FROM supplier_payments WHERE id=? AND supplier_id=?').get(paymentId, supplierId);
  if (!supplier || !payment) throw new HttpError(404, 'دفعة المورد غير موجودة');
  const amount = num(ctx.body.amount, NaN);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً أكبر من صفر');
  if (payment.cashbox_id == null && !findLegacyCashboxRow(payment, supplier.name)) {
    throw new HttpError(409, 'تعذر مطابقة حركة الصندوق لهذه الدفعة؛ لم يتم تعديل أي مبلغ');
  }
  const delta = amount - payment.amount;
  db.exec('BEGIN');
  try {
    let cashboxId = payment.cashbox_id;
    if (cashboxId == null) {
      cashboxId = findLegacyCashboxRow(payment, supplier.name)?.id;
      if (!cashboxId) throw new HttpError(409, 'تعذر مطابقة حركة الصندوق لهذه الدفعة');
      db.prepare('UPDATE supplier_payments SET cashbox_id=? WHERE id=?').run(cashboxId, payment.id);
    }
    db.prepare('UPDATE supplier_payments SET amount=? WHERE id=?').run(amount, payment.id);
    db.prepare('UPDATE suppliers SET balance=balance-? WHERE id=?').run(delta, supplier.id);
    const updatedCashbox = db.prepare('UPDATE cashbox SET amount=? WHERE id=? AND type=\'out\' AND source=\'تسديد لمورد\'').run(amount, cashboxId);
    if (updatedCashbox.changes !== 1) throw new HttpError(409, 'تعذر تحديث حركة الصندوق؛ أُلغي تعديل الدفعة');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  logActivity(ctx, 'تعديل مبلغ تسديد مورد', `${supplier.name}: ${payment.amount} ← ${amount}`);
  return { data: { ok: true } };
}
// Manual balance entry with no cash movement. credit = we owe the supplier more (له);
// debit = the supplier owes us / our debt to him shrinks (عليه).
function supplierEntry(ctx, id) {
  requirePermission(ctx, 'suppliers.finance');
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!s) throw new HttpError(404, 'المورد غير موجود');
  const direction = str(ctx.body.direction);
  if (!['credit', 'debit'].includes(direction)) throw new HttpError(400, 'حدد نوع القيد: له أو عليه');
  const amount = num(ctx.body.amount);
  if (amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً');
  const note = str(ctx.body.note);
  if (!note) throw new HttpError(400, 'اكتب سبب القيد لتوثيقه في كشف الحساب');
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO supplier_entries (supplier_id, direction, amount, note, date, created_by) VALUES (?,?,?,?,?,?)')
      .run(id, direction, amount, note, nowISO(), ctx.session.id);
    db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id=?').run(direction === 'credit' ? amount : -amount, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, direction === 'credit' ? 'إضافة دين للمورد (له)' : 'قيد على المورد (عليه)', `${s.name}: ${amount} — ${note}`);
  return { data: { ok: true } };
}

function editSupplierEntry(ctx, supplierId, entryId) {
  requirePermission(ctx, 'suppliers.finance');
  verifyOwnerPassword(ctx.body.ownerPassword, ctx);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  const entry = db.prepare('SELECT * FROM supplier_entries WHERE id=? AND supplier_id=?').get(entryId, supplierId);
  if (!supplier || !entry) throw new HttpError(404, 'قيد المورد غير موجود');
  const amount = num(ctx.body.amount, NaN);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً أكبر من صفر');
  const delta = amount - entry.amount;
  const signedDelta = entry.direction === 'credit' ? delta : -delta;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE supplier_entries SET amount=? WHERE id=?').run(amount, entry.id);
    db.prepare('UPDATE suppliers SET balance=balance+? WHERE id=?').run(signedDelta, supplier.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  logActivity(ctx, 'تعديل مبلغ قيد مورد', `${supplier.name}: ${entry.amount} ← ${amount} — ${entry.note}`);
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
      qty: lines.map(l => `${l.qty} كغم (${Math.round(l.qty / 10) / 100} طن)`).join('، ')
    });
  }
  const payments = db.prepare('SELECT * FROM supplier_payments WHERE supplier_id=? ORDER BY date').all(id);
  for (const p of payments) rows.push({ date: p.date, desc: 'دفعة مسددة', debit: p.amount, credit: 0, paymentId: p.id, amount: p.amount });
  const returns = db.prepare('SELECT * FROM supplier_returns WHERE supplier_id=? ORDER BY date').all(id);
  for (const r of returns) {
    const label = r.method === 'credit' ? 'إرجاع مواد (خصم من الرصيد): ' : 'إرجاع مواد (نقدي): ';
    rows.push({ date: r.date, desc: `${label}${r.item_name} — ${r.amount}`, debit: r.method === 'credit' ? r.amount : 0, credit: 0, material: r.item_name, qty: `${r.qty} ${r.unit}` });
  }
  const entries = db.prepare('SELECT * FROM supplier_entries WHERE supplier_id=? ORDER BY date').all(id);
  for (const e of entries) {
    const label = e.direction === 'credit' ? 'دين مضاف للمورد (له)' : 'قيد على المورد (عليه)';
    rows.push({ date: e.date, desc: label + (e.note ? ' - ' + e.note : ''), debit: e.direction === 'debit' ? e.amount : 0, credit: e.direction === 'credit' ? e.amount : 0, entryId: e.id, amount: e.amount });
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { data: { rows, balance: s.balance, supplier: s } };
}

module.exports = { listSuppliers, createSupplier, updateSupplier, deleteSupplier, supplierPayment, editSupplierPayment, supplierEntry, editSupplierEntry, supplierLedger };
