'use strict';
// Debt engine: rebuilds every balance movement of every customer from the source tables,
// so period statements (daily/weekly/monthly/yearly) always reconcile to customers.balance.
const db = require('../db');
const { HttpError, requirePermission, localDateStr } = require('../helpers');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readRange(ctx) {
  const from = String(ctx.query.from || ''), to = String(ctx.query.to || '');
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new HttpError(400, 'حدد الفترة بتاريخ بداية ونهاية صحيحين');
  if (from > to) throw new HttpError(400, 'تاريخ البداية بعد تاريخ النهاية');
  return { from, to };
}

// All balance movements, grouped by customer and sorted by time.
// Each entry: debit raises what the customer owes, credit lowers it (deposits push it below zero).
function loadEntries(customerId) {
  const where = customerId ? ' AND customer_id = ?' : '';
  const args = customerId ? [customerId] : [];
  const byCustomer = new Map();
  const push = (cid, e) => {
    if (!byCustomer.has(cid)) byCustomer.set(cid, []);
    byCustomer.get(cid).push(e);
  };

  const lines = new Map();
  const lineRows = db.prepare(`SELECT il.* FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE i.voided = 0${where.replace('customer_id', 'i.customer_id')} ORDER BY il.id`).all(...args);
  for (const l of lineRows) {
    if (!lines.has(l.invoice_id)) lines.set(l.invoice_id, []);
    lines.get(l.invoice_id).push({ item_name: l.item_name, qty: l.qty, unit: l.unit, weight_kg: l.weight_kg, price: l.price, total: l.total });
  }
  for (const inv of db.prepare(`SELECT * FROM invoices WHERE voided = 0${where}`).all(...args)) {
    push(inv.customer_id, {
      date: inv.date, kind: 'invoice', ref: inv.id, desc: `قائمة بيع #${inv.id}`,
      debit: inv.total, credit: inv.paid, total: inv.total, paid: inv.paid, remaining: inv.remaining,
      driver: inv.driver_name || '', lines: lines.get(inv.id) || []
    });
  }
  for (const p of db.prepare(`SELECT * FROM payments WHERE 1=1${where}`).all(...args)) {
    const note = p.note ? ' — ' + p.note : '';
    if (p.type === 'debt') push(p.customer_id, { date: p.date, kind: 'debt', ref: p.id, desc: 'إضافة دين' + note, debit: p.amount, credit: 0 });
    else if (p.is_deposit) push(p.customer_id, { date: p.date, kind: 'deposit', ref: p.id, desc: 'إيداع مبلغ مقدّم' + note, debit: 0, credit: p.amount });
    else push(p.customer_id, { date: p.date, kind: 'receipt', ref: p.id, desc: 'تسديد / قبض' + note, debit: 0, credit: p.amount });
  }
  for (const r of db.prepare(`SELECT * FROM returns WHERE 1=1${where}`).all(...args)) {
    const credit = r.method === 'credit' ? r.amount : 0;
    push(r.customer_id, {
      date: r.date, kind: r.method === 'credit' ? 'return_credit' : 'return_cash', ref: r.id,
      desc: (r.method === 'credit' ? 'إرجاع بضاعة (خصم من الحساب): ' : 'إرجاع بضاعة (رُدّ نقداً): ') + r.item_name,
      debit: 0, credit, amount: r.amount,
      lines: [{ item_name: r.item_name, qty: r.qty, unit: r.unit, weight_kg: r.weight_kg, price: r.price, total: r.amount }]
    });
  }
  for (const list of byCustomer.values()) list.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'invoice' ? -1 : 1));
  return byCustomer;
}

// Balances set before every movement was recorded (older versions, imports) show up as one
// explicit carried-forward line, so the statement always ends on the real stored balance.
function withCarriedForward(customer, entries) {
  const net = entries.reduce((s, e) => s + e.debit - e.credit, 0);
  const diff = round2(customer.balance - net);
  if (Math.abs(diff) < 0.01) return entries;
  const first = entries.length ? entries[0].date : customer.created_at;
  const date = customer.created_at && customer.created_at < first ? customer.created_at : first;
  return [{ date: date || '1970-01-01', kind: 'carried', ref: null, desc: 'رصيد سابق مُرحَّل', debit: diff > 0 ? diff : 0, credit: diff < 0 ? -diff : 0 }, ...entries];
}

function emptyTotals() {
  return { sales: 0, paidAtSale: 0, receipts: 0, deposits: 0, debts: 0, returnsCredit: 0, returnsCash: 0, invoices: 0, kg: 0, debit: 0, credit: 0 };
}
function addToTotals(t, e) {
  t.debit += e.debit; t.credit += e.credit;
  if (e.kind === 'invoice') { t.sales += e.total; t.paidAtSale += e.paid; t.invoices++; t.kg += e.lines.reduce((s, l) => s + l.weight_kg, 0); }
  else if (e.kind === 'receipt') t.receipts += e.credit;
  else if (e.kind === 'deposit') t.deposits += e.credit;
  else if (e.kind === 'debt' || e.kind === 'carried') t.debts += e.debit - e.credit;
  else if (e.kind === 'return_credit') t.returnsCredit += e.credit;
  else if (e.kind === 'return_cash') t.returnsCash += e.amount;
}
function roundTotals(t) { for (const k of Object.keys(t)) t[k] = round2(t[k]); return t; }

// Goods taken in the period, aggregated per item and unit.
function goodsSummary(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.kind !== 'invoice' && e.kind !== 'return_credit' && e.kind !== 'return_cash') continue;
    const sign = e.kind === 'invoice' ? 1 : -1;
    for (const l of e.lines) {
      if (!map.has(l.item_name)) map.set(l.item_name, { name: l.item_name, units: {}, kg: 0, amount: 0 });
      const g = map.get(l.item_name);
      g.units[l.unit] = round2((g.units[l.unit] || 0) + sign * l.qty);
      g.kg = round2(g.kg + sign * l.weight_kg);
      g.amount = round2(g.amount + sign * l.total);
    }
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

function splitByPeriod(customer, entries, from, to) {
  const all = withCarriedForward(customer, entries);
  let opening = 0;
  const inRange = [];
  for (const e of all) {
    const d = localDateStr(e.date);
    if (d < from) opening += e.debit - e.credit;
    else if (d <= to) inRange.push(e);
  }
  return { opening: round2(opening), inRange };
}

function customerStatement(ctx, id) {
  requirePermission(ctx, 'customers.ledger');
  const { from, to } = readRange(ctx);
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!customer) throw new HttpError(404, 'الزبون غير موجود');
  const entries = loadEntries(customer.id).get(customer.id) || [];
  const { opening, inRange } = splitByPeriod(customer, entries, from, to);
  const totals = emptyTotals();
  let running = opening;
  const rows = inRange.map(e => {
    addToTotals(totals, e);
    running += e.debit - e.credit;
    return { ...e, balance: round2(running) };
  });
  return {
    data: {
      customer: { id: customer.id, name: customer.name, nickname: customer.nickname, phone: customer.phone, category: customer.category, credit_limit: customer.credit_limit },
      from, to, opening, closing: round2(running), currentBalance: round2(customer.balance),
      rows, totals: roundTotals(totals), goods: goodsSummary(inRange)
    }
  };
}

function bucketKey(dateStr, byMonth) { return byMonth ? dateStr.slice(0, 7) : dateStr; }

function debtsReport(ctx) {
  requirePermission(ctx, 'reports');
  const { from, to } = readRange(ctx);
  const days = (Date.parse(to) - Date.parse(from)) / 864e5;
  const byMonth = days > 62;
  const all = loadEntries();
  const customers = db.prepare('SELECT * FROM customers').all();
  const grand = { ...emptyTotals(), opening: 0, closing: 0, owedToUs: 0, depositsHeld: 0 };
  const buckets = new Map();
  const rows = [];

  for (const c of customers) {
    const { opening, inRange } = splitByPeriod(c, all.get(c.id) || [], from, to);
    const t = emptyTotals();
    for (const e of inRange) {
      addToTotals(t, e);
      const key = bucketKey(localDateStr(e.date), byMonth);
      if (!buckets.has(key)) buckets.set(key, { key, sales: 0, creditSales: 0, collected: 0, deposits: 0, debit: 0, credit: 0 });
      const b = buckets.get(key);
      b.debit += e.debit; b.credit += e.credit;
      if (e.kind === 'invoice') { b.sales += e.total; b.creditSales += e.remaining; b.collected += e.paid; }
      else if (e.kind === 'receipt') b.collected += e.credit;
      else if (e.kind === 'deposit') b.deposits += e.credit;
    }
    const closing = round2(opening + t.debit - t.credit);
    if (Math.abs(opening) < 0.01 && Math.abs(closing) < 0.01 && !inRange.length) continue;
    rows.push({ id: c.id, name: c.name, phone: c.phone, opening, closing, ...roundTotals(t) });
    grand.opening += opening; grand.closing += closing;
    if (closing > 0) grand.owedToUs += closing; else grand.depositsHeld -= closing;
    for (const k of Object.keys(t)) grand[k] += t[k];
  }
  rows.sort((a, b) => b.closing - a.closing);
  const series = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)).map(b => {
    for (const k of Object.keys(b)) if (k !== 'key') b[k] = round2(b[k]);
    return { ...b, net: round2(b.debit - b.credit) };
  });
  return { data: { from, to, byMonth, rows, totals: roundTotals(grand), series } };
}

function customerSalesReport(ctx) {
  requirePermission(ctx, 'reports');
  const { from, to } = readRange(ctx);
  const onlyId = ctx.query.customerId ? Number(ctx.query.customerId) : null;
  if (ctx.query.customerId && !Number.isSafeInteger(onlyId)) throw new HttpError(400, 'زبون غير صالح');
  const all = loadEntries(onlyId);
  const customers = db.prepare(onlyId ? 'SELECT * FROM customers WHERE id=?' : 'SELECT * FROM customers').all(...(onlyId ? [onlyId] : []));
  const groups = [];
  const grand = emptyTotals();
  for (const c of customers) {
    const inRange = (all.get(c.id) || []).filter(e => { const d = localDateStr(e.date); return d >= from && d <= to; });
    const sales = inRange.filter(e => e.kind === 'invoice' || e.kind === 'return_credit' || e.kind === 'return_cash');
    if (!sales.length) continue;
    const t = emptyTotals();
    for (const e of sales) { addToTotals(t, e); addToTotals(grand, e); }
    groups.push({ id: c.id, name: c.name, phone: c.phone, balance: round2(c.balance), entries: sales, totals: roundTotals(t), goods: goodsSummary(sales) });
  }
  groups.sort((a, b) => b.totals.sales - a.totals.sales);
  const allSales = groups.flatMap(g => g.entries);
  return { data: { from, to, groups, totals: roundTotals(grand), goods: goodsSummary(allSales) } };
}

module.exports = { customerStatement, debtsReport, customerSalesReport, loadEntries, withCarriedForward };
