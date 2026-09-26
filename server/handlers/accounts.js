'use strict';
// Personal accounts book (صيرفة): people or parties who are neither customers nor suppliers.
// Every movement is a debit (مدين — عليه لنا) or a credit (دائن — له علينا) in IQD or USD.
// Balance per currency = debits − credits: positive means he owes us, negative means we owe him.
// Entries are never edited or deleted; a mistake is voided, which reverses any cash it moved.
const db = require('../db');
const { HttpError, requirePermission, requireRole, logActivity, num, str, nowISO, localDateStr } = require('../helpers');

const CURRENCIES = ['IQD', 'USD'];
const round2 = n => Math.round(n * 100) / 100;

function getAccount(id) {
  const a = db.prepare('SELECT * FROM ledger_accounts WHERE id=?').get(id);
  if (!a) throw new HttpError(404, 'الحساب غير موجود');
  return a;
}

function balances(accountId) {
  const out = { IQD: 0, USD: 0 };
  const rows = db.prepare(`SELECT currency, SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) AS bal
    FROM ledger_entries WHERE account_id=? AND voided=0 GROUP BY currency`).all(accountId);
  for (const r of rows) out[r.currency] = round2(r.bal || 0);
  return out;
}

function listAccounts(ctx) {
  requirePermission(ctx, 'ledger');
  const accounts = db.prepare('SELECT * FROM ledger_accounts WHERE is_deleted=0 ORDER BY name').all();
  return { data: accounts.map(a => ({ ...a, balances: balances(a.id) })) };
}

function createAccount(ctx) {
  requirePermission(ctx, 'ledger');
  const name = str(ctx.body.name);
  if (!name) throw new HttpError(400, 'أدخل اسم صاحب الحساب');
  const info = db.prepare('INSERT INTO ledger_accounts (name, phone, note) VALUES (?,?,?)').run(name, str(ctx.body.phone), str(ctx.body.note));
  logActivity(ctx, 'فتح حساب صيرفة', name);
  return { status: 201, data: { id: Number(info.lastInsertRowid) } };
}

function updateAccount(ctx, id) {
  requirePermission(ctx, 'ledger');
  const a = getAccount(id);
  const name = str(ctx.body.name) || a.name;
  db.prepare('UPDATE ledger_accounts SET name=?, phone=?, note=? WHERE id=?').run(name, str(ctx.body.phone), str(ctx.body.note), id);
  logActivity(ctx, 'تعديل حساب صيرفة', name);
  return { data: { ok: true } };
}

function deleteAccount(ctx, id) {
  requirePermission(ctx, 'ledger');
  const a = getAccount(id);
  const b = balances(a.id);
  if (Math.abs(b.IQD) > 0.005 || Math.abs(b.USD) > 0.005) throw new HttpError(400, `لا يمكن حذف حساب "${a.name}" قبل تصفية رصيده`);
  db.prepare('UPDATE ledger_accounts SET is_deleted=1 WHERE id=?').run(id);
  logActivity(ctx, 'حذف حساب صيرفة', a.name);
  return { data: { ok: true } };
}

// withCash moves the IQD cash drawer: a debit (we hand him money) is cash out,
// a credit (he hands us money) is cash in. USD never touches the IQD drawer.
function addEntry(ctx, id) {
  const session = requirePermission(ctx, 'ledger');
  const a = getAccount(id);
  if (a.is_deleted) throw new HttpError(400, 'الحساب محذوف');
  const direction = str(ctx.body.direction);
  if (!['debit', 'credit'].includes(direction)) throw new HttpError(400, 'حدد نوع القيد: مدين (عليه) أو دائن (له)');
  const currency = str(ctx.body.currency) || 'IQD';
  if (!CURRENCIES.includes(currency)) throw new HttpError(400, 'العملة غير مدعومة');
  const amount = num(ctx.body.amount);
  if (!(amount > 0)) throw new HttpError(400, 'أدخل مبلغاً صحيحاً');
  const note = str(ctx.body.note);
  if (!note) throw new HttpError(400, 'اكتب بيان القيد');
  const withCash = ctx.body.withCash === true;
  if (withCash && currency !== 'IQD') throw new HttpError(400, 'حركة الصندوق متاحة للدينار فقط');
  const date = nowISO();
  let entryId;
  db.exec('BEGIN');
  try {
    const info = db.prepare('INSERT INTO ledger_entries (account_id, date, currency, direction, amount, note, with_cash, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, date, currency, direction, amount, note, withCash ? 1 : 0, session.id);
    entryId = Number(info.lastInsertRowid);
    if (withCash) {
      db.prepare('INSERT INTO cashbox (date, type, amount, source, note, customer_name, created_by) VALUES (?,?,?,?,?,?,?)')
        .run(date, direction === 'credit' ? 'in' : 'out', amount, direction === 'credit' ? 'صيرفة - قبض' : 'صيرفة - دفع', `${a.name} - ${note}`, a.name, session.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logActivity(ctx, direction === 'debit' ? 'قيد صيرفة مدين (عليه)' : 'قيد صيرفة دائن (له)', `${a.name}: ${amount} ${currency} — ${note}${withCash ? ' (مع الصندوق)' : ''}`);
  return { status: 201, data: { id: entryId, balances: balances(id) } };
}

function voidEntry(ctx, entryId) {
  const session = requireRole(ctx, ['المالك']);
  const e = db.prepare('SELECT * FROM ledger_entries WHERE id=?').get(entryId);
  if (!e) throw new HttpError(404, 'القيد غير موجود');
  if (e.voided) throw new HttpError(400, 'القيد ملغى مسبقاً');
  const a = getAccount(e.account_id);
  const date = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE ledger_entries SET voided=1, voided_at=? WHERE id=?').run(date, e.id);
    if (e.with_cash) {
      db.prepare('INSERT INTO cashbox (date, type, amount, source, note, customer_name, created_by) VALUES (?,?,?,?,?,?,?)')
        .run(date, e.direction === 'credit' ? 'out' : 'in', e.amount, 'صيرفة - إلغاء قيد', `${a.name} - إلغاء قيد #${e.id}`, a.name, session.id);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  logActivity(ctx, 'إلغاء قيد صيرفة', `#${e.id} ${a.name}: ${e.amount} ${e.currency}`);
  return { data: { ok: true } };
}

// Statement for one currency: balance brought forward before `from`, then every entry in the
// range with a running balance. Voided entries are listed but do not move the balance.
function accountStatement(ctx, id) {
  requirePermission(ctx, 'ledger');
  const a = getAccount(id);
  const currency = str(ctx.query.currency) || 'IQD';
  if (!CURRENCIES.includes(currency)) throw new HttpError(400, 'العملة غير مدعومة');
  const from = str(ctx.query.from), to = str(ctx.query.to);
  const all = db.prepare('SELECT * FROM ledger_entries WHERE account_id=? AND currency=? ORDER BY date, id').all(id, currency);
  let opening = 0;
  const rows = [];
  let running = 0, totalDebit = 0, totalCredit = 0;
  for (const e of all) {
    const d = localDateStr(e.date);
    const signed = e.voided ? 0 : (e.direction === 'debit' ? e.amount : -e.amount);
    if (from && d < from) { opening += signed; continue; }
    if (to && d > to) continue;
    if (!rows.length) running = opening;
    running += signed;
    if (!e.voided) { if (e.direction === 'debit') totalDebit += e.amount; else totalCredit += e.amount; }
    rows.push({
      id: e.id, date: e.date, note: e.note, voided: !!e.voided, withCash: !!e.with_cash,
      debit: e.direction === 'debit' ? e.amount : 0, credit: e.direction === 'credit' ? e.amount : 0,
      balance: round2(running)
    });
  }
  return {
    data: {
      account: a, currency, from, to,
      opening: round2(opening), rows,
      totalDebit: round2(totalDebit), totalCredit: round2(totalCredit),
      closing: round2(opening + totalDebit - totalCredit),
      balances: balances(id)
    }
  };
}

module.exports = { listAccounts, createAccount, updateAccount, deleteAccount, addEntry, voidEntry, accountStatement };
