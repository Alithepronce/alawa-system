'use strict';
const db = require('../db');
const { HttpError, requireAuth, requirePermission, logActivity, num, str, nowISO } = require('../helpers');

function listCustomers(ctx) {
  const session = requirePermission(ctx, 'customers.read');
  const includeDeleted = ctx.query && ctx.query.all === '1';
  const sql = includeDeleted
    ? 'SELECT * FROM customers ORDER BY name'
    : 'SELECT * FROM customers WHERE is_deleted = 0 ORDER BY name';
  const customers = db.prepare(sql).all();
  if (session.role === 'أمين مخزن') return { data: customers.map(({ balance, credit_limit, category, ...customer }) => customer) };
  return { data: customers };
}
function createCustomer(ctx) {
  requirePermission(ctx, 'customers.manage');
  const name = str(ctx.body.name);
  if (!name) throw new HttpError(400, 'أدخل اسم الزبون');
  const category = str(ctx.body.category) || 'عادي';
  const creditLimit = num(ctx.body.creditLimit);
  if (!['عادي', 'جملة', 'مكاتب'].includes(category)) throw new HttpError(400, 'فئة الزبون غير صحيحة');
  if (creditLimit < 0) throw new HttpError(400, 'سقف الدين لا يمكن أن يكون سالباً');
  // Debt carried over from before the system; recorded as a ledger 'debt' entry so the balance stays traceable.
  const openingDebt = num(ctx.body.openingDebt);
  if (openingDebt < 0) throw new HttpError(400, 'الديون السابقة لا يمكن أن تكون سالبة');
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO customers (name, nickname, phone, category, credit_limit, balance)
      VALUES (?,?,?,?,?,?)
    `).run(name, str(ctx.body.nickname), str(ctx.body.phone), category, creditLimit, openingDebt);
    id = Number(info.lastInsertRowid);
    if (openingDebt > 0) {
      db.prepare('INSERT INTO payments (customer_id, amount, date, note, type, created_by) VALUES (?,?,?,?,\'debt\',?)')
        .run(id, openingDebt, nowISO(), 'ديون سابقة (رصيد افتتاحي)', ctx.session.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, 'إضافة زبون', openingDebt > 0 ? `${name} — ديون سابقة ${openingDebt}` : name);
  return { status: 201, data: { id } };
}
function updateCustomer(ctx, id) {
  requirePermission(ctx, 'customers.manage');
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  const name = str(ctx.body.name) || c.name;
  const category = str(ctx.body.category) || c.category;
  const creditLimit = num(ctx.body.creditLimit, c.credit_limit);
  if (!['عادي', 'جملة', 'مكاتب'].includes(category)) throw new HttpError(400, 'فئة الزبون غير صحيحة');
  if (creditLimit < 0) throw new HttpError(400, 'سقف الدين لا يمكن أن يكون سالباً');
  db.prepare(`UPDATE customers SET name=?, nickname=?, phone=?, category=?, credit_limit=? WHERE id=?`)
    .run(name, str(ctx.body.nickname), str(ctx.body.phone), category, creditLimit, id);
  logActivity(ctx, 'تعديل زبون', name);
  return { data: { ok: true } };
}
function deleteCustomer(ctx, id) {
  requirePermission(ctx, 'customers.manage');
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
  requirePermission(ctx, 'customers.finance');
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  const amount = num(ctx.body.amount);
  if (amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً');
  const note = str(ctx.body.note);
  // A deposit is money paid in advance; it drives the balance below zero and later sales draw it down.
  const deposit = ctx.body.deposit === true;
  const date = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO payments (customer_id, amount, date, note, type, created_by, is_deposit) VALUES (?,?,?,?,\'receipt\',?,?)')
      .run(id, amount, date, note, ctx.session.id, deposit ? 1 : 0);
    db.prepare('UPDATE customers SET balance = balance - ? WHERE id=?').run(amount, id);
    db.prepare('INSERT INTO cashbox (date, type, amount, source, note, customer_name, created_by) VALUES (?,\'in\',?,?,?,?,?)')
      .run(date, amount, deposit ? 'إيداع زبون' : 'قبض من زبون', c.name + (note ? ' - ' + note : ''), c.name, ctx.session.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, deposit ? 'إيداع مبلغ مقدّم' : 'تسجيل قبض', `${c.name}: ${amount}`);
  return { data: { ok: true } };
}
function customerDebt(ctx, id) {
  requirePermission(ctx, 'customers.finance');
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
  requirePermission(ctx, 'customers.ledger');
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
    else rows.push({ date: p.date, desc: (p.is_deposit ? 'إيداع مبلغ مقدّم' : 'دفعة مقبوضة') + (p.note ? ' - ' + p.note : ''), debit: 0, credit: p.amount });
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
  requirePermission(ctx, 'customers.ledger');
  const rows = db.prepare(`
    SELECT il.item_id, il.item_name, il.price, il.unit, i.date
    FROM invoice_lines il
    JOIN invoices i ON il.invoice_id = i.id
    WHERE i.customer_id = ? AND i.voided = 0
    ORDER BY i.date DESC, il.id DESC
  `).all(id);

  const priceMap = {};
  for (const r of rows) {
    if (!priceMap[r.item_id]) {
      priceMap[r.item_id] = {
        price: r.price,
        unit: r.unit,
        date: r.date,
        name: r.item_name
      };
    }
  }
  return { data: priceMap };
}

module.exports = { listCustomers, createCustomer, updateCustomer, deleteCustomer, customerPayment, customerDebt, customerLedger, customerLastPrices };
