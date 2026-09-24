'use strict';
const db = require('../db');
const { HttpError, requirePermission, logActivity, num, str, nowISO } = require('../helpers');

function listCashbox(ctx) {
  requirePermission(ctx, 'cashbox');
  const { from, to } = ctx.query;
  let sql = 'SELECT * FROM cashbox WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND date(date) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(date) <= date(?)'; params.push(to); }
  sql += ' ORDER BY date DESC';
  return { data: db.prepare(sql).all(...params) };
}

// Manual cash receipts must be explicitly classified. Customer receipts always require a
// customer so the payment and balance update cannot be silently bypassed in the UI/API.
function createCashboxManual(ctx) {
  const session = requirePermission(ctx, 'cashbox');
  const kind = str(ctx.body.kind);
  const amount = num(ctx.body.amount);
  const note = str(ctx.body.note);
  if (!['customer_receipt', 'other_income', 'expense'].includes(kind)) throw new HttpError(400, 'تصنيف الحركة غير صحيح');
  if (amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً');
  const date = nowISO();

  if (kind === 'customer_receipt') {
    const customerId = Number(ctx.body.customerId);
    if (!Number.isSafeInteger(customerId) || customerId <= 0) throw new HttpError(400, 'اختر الزبون الذي سدّد المبلغ');
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
    if (!customer) throw new HttpError(404, 'الزبون غير موجود');
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO payments (customer_id, amount, date, note, type, created_by) VALUES (?,?,?,?,\'receipt\',?)')
        .run(customer.id, amount, date, note, session.id);
      db.prepare('UPDATE customers SET balance = balance - ? WHERE id=?').run(amount, customer.id);
      db.prepare(`INSERT INTO cashbox (date, type, amount, source, note, customer_name, created_by) VALUES (?,'in',?,'قبض من زبون',?,?,?)`)
        .run(date, amount, customer.name + (note ? ' - ' + note : ''), customer.name, session.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    logActivity(ctx, 'قبض من زبون (عبر الصندوق)', `${customer.name}: ${amount}`);
    return { status: 201, data: { ok: true } };
  }

  if (ctx.body.customerId !== undefined && ctx.body.customerId !== null && str(ctx.body.customerId) !== '') {
    throw new HttpError(400, 'لا تربط الوارد الآخر أو المصروف بزبون؛ اختر تصنيف قبض من زبون لإثبات التسديد');
  }
  if (!note) throw new HttpError(400, 'سبب الحركة مطلوب لتوثيقها');
  const type = kind === 'other_income' ? 'in' : 'out';
  const source = kind === 'other_income' ? 'وارد آخر' : 'مصروف يدوي';
  db.prepare('INSERT INTO cashbox (date, type, amount, source, note, created_by) VALUES (?,?,?,?,?,?)').run(date, type, amount, source, note, session.id);
  logActivity(ctx, kind === 'other_income' ? 'وارد نقدي آخر' : 'مصروف نقدي يدوي', `${amount} - ${note}`);
  return { status: 201, data: { ok: true } };
}

module.exports = { listCashbox, createCashboxManual };
