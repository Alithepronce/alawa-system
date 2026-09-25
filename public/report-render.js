// Shared renderer for debt & sales reports: the same markup is shown inside the app
// and on the printable A4 page (print/report.html), so screen and PDF never disagree.
'use strict';
const RPT = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const tons = kg => (Math.round((Number(kg) || 0) / 10) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const weight = kg => `${num(kg)} كغم <span class="rpt-ton">(${tons(kg)} طن)</span>`;
  const date = iso => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleDateString('en-GB'); };
  const dateTime = iso => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
  // Positive balance = the customer owes us; negative = deposit we hold for them.
  const bal = n => Math.abs(n) < 0.01 ? '<span class="rpt-zero">0</span>'
    : n > 0 ? `<span class="rpt-owe">${num(n)} عليه</span>` : `<span class="rpt-dep">${num(-n)} له</span>`;
  const units = u => Object.entries(u).filter(([, q]) => Math.abs(q) > 0.001).map(([unit, q]) => `${num(q)} ${esc(unit)}`).join(' + ') || '-';
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Period presets. Weeks start on Saturday, matching the rest of the system.
  function period(kind, anchor) {
    const a = anchor ? new Date(anchor + 'T12:00:00') : new Date();
    let from = new Date(a), to = new Date(a), label;
    if (kind === 'week') {
      from.setDate(a.getDate() - ((a.getDay() + 1) % 7));
      to = new Date(from); to.setDate(from.getDate() + 6);
      label = 'أسبوعي';
    } else if (kind === 'month') {
      from = new Date(a.getFullYear(), a.getMonth(), 1, 12);
      to = new Date(a.getFullYear(), a.getMonth() + 1, 0, 12);
      label = 'شهري';
    } else if (kind === 'year') {
      from = new Date(a.getFullYear(), 0, 1, 12);
      to = new Date(a.getFullYear(), 11, 31, 12);
      label = 'سنوي';
    } else label = 'يومي';
    return { from: ymd(from), to: ymd(to), label };
  }
  const periodText = (from, to) => from === to ? `ليوم ${date(from)}` : `من ${date(from)} إلى ${date(to)}`;

  const card = (label, value, cls = '') => `<div class="rpt-card ${cls}"><div class="rpt-card-l">${label}</div><div class="rpt-card-v">${value}</div></div>`;
  const table = (head, body, foot = '') => `<div class="rpt-tbl"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>`;

  function goodsTable(goods) {
    if (!goods.length) return '<div class="rpt-empty">لا توجد بضاعة مسحوبة في هذه الفترة</div>';
    const rows = goods.map(g => `<tr><td><strong>${esc(g.name)}</strong></td><td>${units(g.units)}</td><td class="n">${weight(g.kg)}</td><td class="n">${num(g.amount)}</td></tr>`).join('');
    const kg = goods.reduce((s, g) => s + g.kg, 0), amount = goods.reduce((s, g) => s + g.amount, 0);
    return table(['المادة', 'الكمية', 'الوزن', 'المبلغ'], rows, `<tr><td colspan="2">المجموع</td><td class="n">${weight(kg)}</td><td class="n">${num(amount)}</td></tr>`);
  }

  function linesList(lines) {
    return `<div class="rpt-lines">${lines.map(l => `<div>• ${esc(l.item_name)}: ${num(l.qty)} ${esc(l.unit)} (${num(l.weight_kg)} كغم) × ${num(l.price)} = <strong>${num(l.total)}</strong></div>`).join('')}</div>`;
  }

  function statement(d) {
    const t = d.totals, c = d.customer;
    const rows = d.rows.map(r => `
      <tr class="rpt-k-${r.kind}">
        <td class="n">${dateTime(r.date)}</td>
        <td><strong>${esc(r.desc)}</strong>${r.kind === 'invoice' ? `<div class="rpt-sub">المبلغ ${num(r.total)} — الواصل نقداً ${num(r.paid)} — الباقي ${num(r.remaining)}${r.driver ? ' — السائق: ' + esc(r.driver) : ''}</div>` : ''}${r.lines ? linesList(r.lines) : ''}</td>
        <td class="n">${r.debit ? num(r.debit) : '-'}</td>
        <td class="n">${r.credit ? num(r.credit) : '-'}</td>
        <td class="n">${bal(r.balance)}</td>
      </tr>`).join('');
    return `
      <div class="rpt-head">
        <div><div class="rpt-title">كشف حساب زبون تفصيلي</div><div class="rpt-meta">${periodText(d.from, d.to)}</div></div>
        <div class="rpt-party"><strong>${esc(c.name)}</strong>${c.nickname ? ` (${esc(c.nickname)})` : ''}<div class="rpt-meta">${esc(c.phone || '')} · فئة ${esc(c.category)} · سقف الدين ${num(c.credit_limit)}</div></div>
      </div>
      <div class="rpt-cards">
        ${card('الرصيد أول المدة', bal(d.opening))}
        ${card('قيمة البضاعة المسحوبة', num(t.sales), 'rpt-c-debit')}
        ${card('الواصل نقداً مع القوائم', num(t.paidAtSale), 'rpt-c-credit')}
        ${card('التسديدات', num(t.receipts), 'rpt-c-credit')}
        ${card('الإيداعات المقدّمة', num(t.deposits), 'rpt-c-credit')}
        ${card('ديون مضافة', num(t.debts), 'rpt-c-debit')}
        ${card('مرتجعات مخصومة', num(t.returnsCredit), 'rpt-c-credit')}
        ${card('الرصيد آخر المدة', bal(d.closing), 'rpt-c-main')}
      </div>
      <div class="rpt-meta" style="margin-bottom:8px;">عدد القوائم: <strong>${t.invoices}</strong> · إجمالي الوزن المسحوب: <strong>${weight(t.kg)}</strong> · الرصيد الحالي الآن: <strong>${bal(d.currentBalance)}</strong></div>
      <h4 class="rpt-h">حركة الحساب</h4>
      ${d.rows.length ? table(['التاريخ', 'البيان والتفاصيل', 'عليه (+)', 'له (−)', 'الرصيد'],
        `<tr class="rpt-open"><td>—</td><td><strong>رصيد أول المدة</strong></td><td></td><td></td><td class="n">${bal(d.opening)}</td></tr>${rows}`,
        `<tr><td colspan="2">المجموع</td><td class="n">${num(t.debit)}</td><td class="n">${num(t.credit)}</td><td class="n">${bal(d.closing)}</td></tr>`)
        : '<div class="rpt-empty">لا توجد حركات في هذه الفترة</div>'}
      <h4 class="rpt-h">ملخص البضاعة المسحوبة</h4>
      ${goodsTable(d.goods)}`;
  }

  function debts(d) {
    const t = d.totals;
    const rows = d.rows.map(r => `
      <tr>
        <td><strong>${esc(r.name)}</strong><div class="rpt-sub">${esc(r.phone || '')}</div></td>
        <td class="n">${bal(r.opening)}</td>
        <td class="n">${num(r.sales)}</td>
        <td class="n">${num(r.paidAtSale)}</td>
        <td class="n">${num(r.receipts)}</td>
        <td class="n">${num(r.deposits)}</td>
        <td class="n">${num(r.debts)}</td>
        <td class="n">${num(r.returnsCredit)}</td>
        <td class="n"><strong>${bal(r.closing)}</strong></td>
      </tr>`).join('');
    const series = d.series.map(s => `<tr><td class="n">${d.byMonth ? esc(s.key) : date(s.key)}</td><td class="n">${num(s.sales)}</td><td class="n">${num(s.collected)}</td><td class="n">${num(s.creditSales)}</td><td class="n">${num(s.deposits)}</td><td class="n">${s.net >= 0 ? '+' : '−'}${num(Math.abs(s.net))}</td></tr>`).join('');
    return `
      <div class="rpt-head"><div><div class="rpt-title">تقرير الديون</div><div class="rpt-meta">${periodText(d.from, d.to)}</div></div></div>
      <div class="rpt-cards">
        ${card('ديون أول المدة (صافي)', bal(t.opening))}
        ${card('المبيعات', num(t.sales), 'rpt-c-debit')}
        ${card('المقبوض (مع القوائم + تسديدات)', num(t.paidAtSale + t.receipts), 'rpt-c-credit')}
        ${card('الإيداعات المقدّمة', num(t.deposits), 'rpt-c-credit')}
        ${card('ديون مضافة يدوياً', num(t.debts), 'rpt-c-debit')}
        ${card('مرتجعات مخصومة', num(t.returnsCredit), 'rpt-c-credit')}
        ${card('ديون لنا آخر المدة', num(t.owedToUs), 'rpt-c-main')}
        ${card('إيداعات بذمتنا آخر المدة', num(t.depositsHeld), 'rpt-c-dep')}
      </div>
      <h4 class="rpt-h">الحركة ${d.byMonth ? 'حسب الشهر' : 'حسب اليوم'}</h4>
      ${series ? table([d.byMonth ? 'الشهر' : 'اليوم', 'المبيعات', 'المقبوض', 'الآجل', 'الإيداعات', 'تغيّر الديون'], series) : '<div class="rpt-empty">لا توجد حركات في هذه الفترة</div>'}
      <h4 class="rpt-h">الديون حسب الزبون</h4>
      ${rows ? table(['الزبون', 'أول المدة', 'مبيعات', 'واصل مع القوائم', 'تسديدات', 'إيداعات', 'ديون مضافة', 'مرتجعات', 'آخر المدة'], rows,
        `<tr><td>المجموع</td><td class="n">${bal(t.opening)}</td><td class="n">${num(t.sales)}</td><td class="n">${num(t.paidAtSale)}</td><td class="n">${num(t.receipts)}</td><td class="n">${num(t.deposits)}</td><td class="n">${num(t.debts)}</td><td class="n">${num(t.returnsCredit)}</td><td class="n">${bal(t.closing)}</td></tr>`)
        : '<div class="rpt-empty">لا يوجد زبائن بديون أو حركات في هذه الفترة</div>'}`;
  }

  function sales(d) {
    const groups = d.groups.map(g => {
      const rows = g.entries.map(e => {
        const sign = e.kind === 'invoice' ? '' : '−';
        const head = e.kind === 'invoice'
          ? `<tr class="rpt-inv"><td colspan="6"><strong>قائمة #${e.ref}</strong> · ${dateTime(e.date)}${e.driver ? ' · السائق: ' + esc(e.driver) : ''}</td><td class="n">المبلغ ${num(e.total)} · واصل ${num(e.paid)} · باقي ${num(e.remaining)}</td></tr>`
          : `<tr class="rpt-inv rpt-ret"><td colspan="7"><strong>${esc(e.desc)}</strong> · ${dateTime(e.date)}</td></tr>`;
        return head + e.lines.map(l => `<tr><td></td><td>${esc(l.item_name)}</td><td class="n">${sign}${num(l.qty)} ${esc(l.unit)}</td><td class="n">${sign}${num(l.weight_kg)}</td><td class="n">${tons(l.weight_kg)}</td><td class="n">${num(l.price)}</td><td class="n">${sign}${num(l.total)}</td></tr>`).join('');
      }).join('');
      const t = g.totals;
      return `
        <div class="rpt-group">
          <div class="rpt-group-h"><strong>${esc(g.name)}</strong> <span class="rpt-meta">${esc(g.phone || '')}</span><span class="rpt-meta" style="margin-inline-start:auto;">الرصيد الحالي: ${bal(g.balance)}</span></div>
          <div class="rpt-meta">القوائم: <strong>${t.invoices}</strong> · المبلغ: <strong>${num(t.sales)}</strong> · الواصل: <strong>${num(t.paidAtSale)}</strong> · الآجل: <strong>${num(t.sales - t.paidAtSale)}</strong> · الوزن: <strong>${weight(t.kg)}</strong>${t.returnsCredit + t.returnsCash ? ` · مرتجعات: <strong>${num(t.returnsCredit + t.returnsCash)}</strong>` : ''}</div>
          ${table(['', 'المادة', 'الكمية', 'الوزن (كغم)', 'طن', 'السعر', 'المبلغ'], rows)}
          <div class="rpt-meta" style="margin:6px 0 2px;"><strong>البضاعة المأخوذة:</strong></div>
          ${goodsTable(g.goods)}
        </div>`;
    }).join('');
    const t = d.totals;
    return `
      <div class="rpt-head"><div><div class="rpt-title">قوائم البيع حسب الزبون</div><div class="rpt-meta">${periodText(d.from, d.to)}</div></div></div>
      <div class="rpt-cards">
        ${card('عدد القوائم', t.invoices)}
        ${card('إجمالي المبيعات', num(t.sales), 'rpt-c-debit')}
        ${card('الواصل نقداً', num(t.paidAtSale), 'rpt-c-credit')}
        ${card('الآجل', num(t.sales - t.paidAtSale), 'rpt-c-main')}
        ${card('إجمالي الوزن', weight(t.kg))}
      </div>
      <h4 class="rpt-h">إجمالي البضاعة المباعة</h4>
      ${goodsTable(d.goods)}
      <h4 class="rpt-h">التفاصيل حسب الزبون</h4>
      ${groups || '<div class="rpt-empty">لا توجد مبيعات في هذه الفترة</div>'}`;
  }

  return { period, statement, debts, sales, weight, tons, num };
})();
