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

// Manual cashbox entry. If a customerId is supplied with type='in', this is treated as a
// real receipt against that customer's debt (not just an untracked generic cash movement).
function createCashboxManual(ctx) {
  const session = requirePermission(ctx, 'cashbox');
  const type = str(ctx.body.type);
  const amount = num(ctx.body.amount);
  const note = str(ctx.body.note);
  if (!['in','out'].includes(type)) throw new HttpError(400, 'نوع غير صحيح');
  if (amount <= 0) throw new HttpError(400, 'أدخل مبلغاً صحيحاً');
  const date = nowISO();

  if (type === 'in' && ctx.body.customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(ctx.body.customerId);
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

  db.prepare('INSERT INTO cashbox (date, type, amount, source, note, created_by) VALUES (?,?,?,\'يدوي\',?,?)').run(date, type, amount, note, session.id);
  logActivity(ctx, 'حركة صندوق يدوية', `${type === 'in' ? 'داخل' : 'خارج'}: ${amount}${note ? ' - ' + note : ''}`);
  return { status: 201, data: { ok: true } };
}

module.exports = { listCashbox, createCashboxManual };
