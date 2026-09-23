'use strict';
const db = require('../db');
const { HttpError, requireAuth, requireRole, logActivity, num, str, nowISO } = require('../helpers');

function listCustomers(ctx) {
  requireAuth(ctx);
  const includeDeleted = ctx.query && ctx.query.all === '1';
  const sql = includeDeleted
    ? 'SELECT * FROM customers ORDER BY name'
    : 'SELECT * FROM customers WHERE is_deleted = 0 ORDER BY name';
  return { data: db.prepare(sql).all() };
}
function createCustomer(ctx) {
  requireAuth(ctx);
  const name = str(ctx.body.name);
  if (!name) throw new HttpError(400, 'أدخل اسم الزبون');
  const info = db.prepare(`
    INSERT INTO customers (name, nickname, phone, category, credit_limit, balance)
    VALUES (?,?,?,?,?,0)
  `).run(name, str(ctx.body.nickname), str(ctx.body.phone), str(ctx.body.category) || 'عادي', num(ctx.body.creditLimit));
  logActivity(ctx, 'إضافة زبون', name);
  return { status: 201, data: { id: Number(info.lastInsertRowid) } };
}
function updateCustomer(ctx, id) {
  requireAuth(ctx);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  const name = str(ctx.body.name) || c.name;
  db.prepare(`UPDATE customers SET name=?, nickname=?, phone=?, category=?, credit_limit=? WHERE id=?`)
    .run(name, str(ctx.body.nickname), str(ctx.body.phone), str(ctx.body.category) || c.category, num(ctx.body.creditLimit, c.credit_limit), id);
  logActivity(ctx, 'تعديل زبون', name);
  return { data: { ok: true } };
}
function deleteCustomer(ctx, id) {
  requireAuth(ctx);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new HttpError(404, 'الزبون غير موجود');

  // Prevent deletion if customer has non-zero balance
  if (Math.abs(c.balance) > 0.01) {
    throw new HttpError(400, `لا يمكن حذف الزبون "${c.name}" لوجود رصيد متبقي (${c.balance}). يجب تصفية الحساب أولاً`);
  }

  // Check for existing invoices or transactions
  const invCount = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE customer_id=?').get(id).c;
  if (invCount > 0) {
    throw new HttpError(400, `لا يمكن حذف الزبون "${c.name}" لوجود (${invCount}) فواتير مرتبطة به في النظام. يمكنك تعديل بياناته بدلاً من ذلك`);
  }

  const payCount = db.prepare('SELECT COUNT(*) as c FROM payments WHERE customer_id=?').get(id).c;
  if (payCount > 0) {
    throw new HttpError(400, `لا يمكن حذف الزبون "${c.name}" لوجود دفعات مالية مسجلة باسمه في السجل`);
  }

  // Check if soft delete column exists or use soft delete if available
  try {
    db.prepare('UPDATE customers SET is_deleted=1, deleted_at=datetime(\'now\') WHERE id=?').run(id);
  } catch (_) {
    db.prepare('DELETE FROM customers WHERE id=?').run(id);
  }

  logActivity(ctx, 'حذف زبون', `${c.name} — كان رصيده ${c.balance}`);
  return { data: { ok: true } };
}
function customerPayment(ctx, id) {
  requireAuth(ctx);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  const amount = num(ctx.body.amount);
  if (amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً');
  const note = str(ctx.body.note);
  const date = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO payments (customer_id, amount, date, note, type, created_by) VALUES (?,?,?,?,\'receipt\',?)')
      .run(id, amount, date, note, ctx.session.id);
    db.prepare('UPDATE customers SET balance = balance - ? WHERE id=?').run(amount, id);
    db.prepare('INSERT INTO cashbox (date, type, amount, source, note, customer_name, created_by) VALUES (?,\'in\',?,\'قبض من زبون\',?,?,?)')
      .run(date, amount, c.name + (note ? ' - ' + note : ''), c.name, ctx.session.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'تسجيل قبض', `${c.name}: ${amount}`);
  return { data: { ok: true } };
}
function customerDebt(ctx, id) {
  requireAuth(ctx);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  const amount = num(ctx.body.amount);
  if (amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً');
  const note = str(ctx.body.note);
  const date = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO payments (customer_id, amount, date, note, type, created_by) VALUES (?,?,?,?,\'debt\',?)')
      .run(id, amount, date, note, ctx.session.id);
    db.prepare('UPDATE customers SET balance = balance + ? WHERE id=?').run(amount, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'إضافة دين يدوي', `${c.name}: ${amount}`);
  return { data: { ok: true } };
}
function customerLedger(ctx, id) {
  requireAuth(ctx);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  const invoices = db.prepare('SELECT * FROM invoices WHERE customer_id=? AND voided=0 ORDER BY date').all(id);
  const invLines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?');
  const rows = [];
  for (const inv of invoices) {
    const lines = invLines.all(inv.id);
    rows.push({
      date: inv.date, desc: `قائمة مبيعات #${inv.id}`, debit: inv.total, credit: inv.paid,
      material: lines.map(l => l.item_name).join('، '),
      qty: lines.map(l => `${l.qty} ${l.unit}`).join('، ')
    });
  }
  const payments = db.prepare('SELECT * FROM payments WHERE customer_id=? ORDER BY date').all(id);
  for (const p of payments) {
    if (p.type === 'debt') rows.push({ date: p.date, desc: 'إضافة دين' + (p.note ? ' - ' + p.note : ''), debit: p.amount, credit: 0 });
    else rows.push({ date: p.date, desc: 'دفعة مقبوضة' + (p.note ? ' - ' + p.note : ''), debit: 0, credit: p.amount });
  }
  const returns = db.prepare('SELECT * FROM returns WHERE customer_id=? ORDER BY date').all(id);
  for (const r of returns) {
    const label = r.method === 'credit' ? 'إرجاع مادة (خصم من الدين): ' : 'إرجاع مادة (نقدي): ';
    rows.push({ date: r.date, desc: label + r.item_name, debit: 0, credit: r.method === 'credit' ? r.amount : 0, material: r.item_name, qty: `${r.qty} ${r.unit}` });
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { data: { rows, balance: c.balance, customer: c } };
}

function customerLastPrices(ctx, id) {
  requireAuth(ctx);
  const rows = db.prepare(`
    SELECT il.item_id, il.item_name, il.unit_price, il.unit, i.date
    FROM invoice_lines il
    JOIN invoices i ON il.invoice_id = i.id
    WHERE i.customer_id = ? AND i.voided = 0
    ORDER BY i.date DESC, il.id DESC
  `).all(id);

  const priceMap = {};
  for (const r of rows) {
    if (!priceMap[r.item_id]) {
      priceMap[r.item_id] = {
        price: r.unit_price,
        unit: r.unit,
        date: r.date,
        name: r.item_name
      };
    }
  }
  return { data: priceMap };
}

module.exports = { listCustomers, createCustomer, updateCustomer, deleteCustomer, customerPayment, customerDebt, customerLedger, customerLastPrices };
