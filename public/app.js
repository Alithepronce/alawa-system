'use strict';
/* =========================================================
   ALAWA MANAGEMENT SYSTEM — CLIENT LOGIC v2
   Soft Minimalist POS & ERP Application
   Verified Server-Side Security + Robust Local Workflows
========================================================= */

let currentUser = null;
let state = { customers: [], items: [], suppliers: [], settings: {} };

/* =========================================================
   API HELPER & UTILITIES
========================================================= */
async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || 'حدث خطأ غير متوقع');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function fmtNum(n) {
  n = Math.round((Number(n) || 0) * 100) / 100;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function curr() {
  return state.settings.currency || 'د.ع';
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toastCont');
  if (!c) return;
  const t = document.createElement('div');
  const cls = type === 'ok' ? 'toast-ok' : (type === 'err' ? 'toast-err' : 'toast-info');
  t.className = `toast ${cls}`;
  t.innerHTML = `<span>${type === 'ok' ? '✓' : (type === 'err' ? '✕' : 'ℹ')}</span><span>${esc(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-10px)';
    t.style.transition = 'all 0.2s';
    setTimeout(() => t.remove(), 200);
  }, 3400);
}

function closeModal() {
  const root = document.getElementById('modalRoot');
  if (root) root.innerHTML = '';
}

/* Custom Accessible Confirmation Modal */
function confirmDialog(title, message, confirmBtnText = 'نعم، تأكيد', isDanger = true) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    root.innerHTML = `
      <div class="modal-overlay" onclick="if(event.target===this){closeModal(); resolve(false);}">
        <div class="modal-box" style="max-width:420px;">
          <div class="modal-header">
            <h3>${esc(title)}</h3>
            <button class="modal-close" onclick="closeModal(); window.__confirmResolve(false);">✕</button>
          </div>
          <div class="modal-body" style="padding:24px 20px;text-align:center;">
            <div style="font-size:36px;margin-bottom:12px;">${isDanger ? '⚠️' : '❓'}</div>
            <p style="font-size:14px;color:var(--text-body);line-height:1.6;">${esc(message)}</p>
          </div>
          <div class="modal-footer" style="justify-content:center;gap:12px;">
            <button class="btn btn-secondary" onclick="closeModal(); window.__confirmResolve(false);">إلغاء</button>
            <button class="btn ${isDanger ? 'btn-danger' : 'btn-primary'}" onclick="closeModal(); window.__confirmResolve(true);">${esc(confirmBtnText)}</button>
          </div>
        </div>
      </div>
    `;
    window.__confirmResolve = resolve;
  });
}

/* =========================================================
   LOGIN & AUTHENTICATION
========================================================= */
async function doLogin() {
  const name = document.getElementById('loginName').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errBox = document.getElementById('loginError');
  errBox.style.display = 'none';

  if (!name || !password) {
    errBox.textContent = 'يرجى إدخال اسم المستخدم ورمز الدخول';
    errBox.style.display = 'block';
    return;
  }

  try {
    const user = await api('POST', '/login', { name, password });
    currentUser = user;
    await afterLogin();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.style.display = 'block';
  }
}

async function doLogout() {
  try {
    await api('POST', '/logout');
  } catch (_) {}
  currentUser = null;
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginPassword').value = '';
}

async function afterLogin() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';

  // Update user badge in sidebar
  const roleEl = document.getElementById('roleLbl');
  const userEl = document.getElementById('userNameLbl');
  const avEl = document.getElementById('avatarInitial');
  if (roleEl) roleEl.textContent = currentUser.role;
  if (userEl) userEl.textContent = currentUser.name;
  if (avEl) avEl.textContent = (currentUser.name || 'م').slice(0, 1);

  applyRolePermissions();
  await loadAllData();
  showScreen('dashboard');
}

function applyRolePermissions() {
  const isOwner = currentUser && currentUser.role === 'المالك';
  document.querySelectorAll('.owner-only').forEach(el => {
    el.style.display = isOwner ? '' : 'none';
  });
}

async function loadAllData() {
  try {
    const [customers, items, suppliers, settings] = await Promise.all([
      api('GET', '/customers'),
      api('GET', '/items'),
      api('GET', '/suppliers'),
      api('GET', '/settings')
    ]);
    state.customers = customers;
    state.items = items;
    state.suppliers = suppliers;
    state.settings = settings;

    const storeName = settings.storeName || 'نظام إدارة العلوة';
    const sbTitle = document.getElementById('sidebarStoreName');
    const lgTitle = document.getElementById('loginStoreName');
    if (sbTitle) sbTitle.textContent = storeName;
    if (lgTitle) lgTitle.textContent = storeName;
    document.title = storeName;

    updateLowStockBadge();
  } catch (err) {
    console.error('Failed to load initial data:', err);
  }
}

function updateLowStockBadge() {
  const badge = document.getElementById('navLowStockBadge');
  if (!badge) return;
  const count = state.items.filter(i => Number(i.stock_kg) <= Number(i.low_stock || 200)).length;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

/* =========================================================
   NAVIGATION & SCREENS
========================================================= */
const SCREEN_TITLES = {
  dashboard: { title: 'لوحة المعلومات', sub: 'نظرة عامة على نشاط اليوم والمؤشرات المالية للمكتب' },
  pos: { title: 'نقطة البيع (POS)', sub: 'تسجيل قائمة بيع جديدة مع دعم الباركود والطباعة' },
  customers: { title: 'إدارة الزبائن', sub: 'دليل الزبائن، متابعة الديون، وتحديد سقوف الائتمان' },
  inventory: { title: 'المخزون والمواد', sub: 'إدارة أصناف الطحين والأعلاف، الأوزان، والأسعار' },
  suppliers: { title: 'الموردون والمشتريات', sub: 'فواتير الشراء، تكاليف النقل والتحميل، وأرصدة الموردين' },
  cashbox: { title: 'صندوق النقدية', sub: 'حركات السيولة النقدية الفعلية اليومية وتتبع المقبوضات' },
  reports: { title: 'التقارير والأرباح', sub: 'تحليل المبيعات اليومية، كشوف الحسابات، وأرباح المواد' },
  backup: { title: 'النسخ الاحتياطي والحماية', sub: 'نسخ احتياطية تلقائية ومحلية لحماية البيانات من التلف' },
  users: { title: 'المستخدمون والصلاحيات', sub: 'إدارة حسابات الدخول وتعيين الأدوار (محاسب، أمين مخزن، مالك)' },
  activitylog: { title: 'سجل العمليات والتدقيق', sub: 'سجل زمني لجميع عمليات البيع والقبض والحذف والتعديل' },
  settings: { title: 'إعدادات النظام', sub: 'بيانات المكتب، العملة، وسقوف الائتمان الافتراضية' }
};

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.navbtn').forEach(b => b.classList.remove('active'));

  const target = document.getElementById('screen-' + name);
  if (target) target.classList.add('active');

  const btn = document.querySelector(`.navbtn[data-scr="${name}"]`);
  if (btn) btn.classList.add('active');

  // Update topbar header text
  const meta = SCREEN_TITLES[name] || { title: name, sub: '' };
  const titleEl = document.getElementById('topbarTitle');
  const subEl = document.getElementById('topbarSubtitle');
  if (titleEl) titleEl.textContent = meta.title;
  if (subEl) subEl.textContent = meta.sub;

  // Screen-specific renders
  if (name === 'dashboard') renderDashboard();
  if (name === 'pos') renderPOS();
  if (name === 'customers') renderCustomersScreen();
  if (name === 'inventory') renderInventoryScreen();
  if (name === 'suppliers') renderSuppliersScreen();
  if (name === 'cashbox') renderCashboxScreen();
  if (name === 'reports') renderReportsScreen();
  if (name === 'users') renderUsersScreen();
  if (name === 'backup') renderBackupScreen();
  if (name === 'activitylog') renderActivityLogScreen();
  if (name === 'settings') renderSettingsScreen();
}

/* =========================================================
   DASHBOARD SCREEN
========================================================= */
async function renderDashboard() {
  try {
    const stats = await api('GET', '/reports/dashboard');

    const sToday = document.getElementById('dashTodaySales');
    const sTodaySub = document.getElementById('dashTodaySalesSub');
    const sCash = document.getElementById('dashCashBalance');
    const sDebt = document.getElementById('dashTotalDebts');
    const sLowStock = document.getElementById('dashLowStockCount');

    if (sToday) sToday.textContent = `${fmtNum(stats.todaySales)} ${curr()}`;
    if (sTodaySub) sTodaySub.textContent = `${stats.todayInvoicesCount} قوائم بيع مسجلة اليوم`;
    if (sCash) sCash.textContent = `${fmtNum(stats.cashBalance)} ${curr()}`;
    if (sDebt) sDebt.textContent = `${fmtNum(stats.totalDebts)} ${curr()}`;
    if (sLowStock) sLowStock.textContent = stats.lowStockCount;

    // Render Recent Invoices
    const invBody = document.getElementById('dashRecentInvoicesBody');
    if (invBody) {
      if (!stats.recentInvoices || stats.recentInvoices.length === 0) {
        invBody.innerHTML = '<tr><td colspan="5" class="empty-state">لا توجد فواتير مبيعات مسجلة حتى الآن</td></tr>';
      } else {
        invBody.innerHTML = stats.recentInvoices.map(i => `
          <tr>
            <td class="num">#${i.id}</td>
            <td><strong>${esc(i.customer_name || 'زبون عام')}</strong></td>
            <td class="num">${fmtNum(i.total)}</td>
            <td class="num"><span class="badge badge-sage">${fmtNum(i.paid)}</span></td>
            <td class="num"><span class="badge ${i.remaining > 0 ? 'badge-danger' : 'badge-sage'}">${fmtNum(i.remaining)}</span></td>
          </tr>
        `).join('');
      }
    }

    // Render Low Stock Items Alert
    const lowBody = document.getElementById('dashLowStockBody');
    if (lowBody) {
      if (!stats.lowStockItems || stats.lowStockItems.length === 0) {
        lowBody.innerHTML = '<tr><td colspan="4" class="empty-state">المخزون في حالة ممتازة ولا توجد مواد منخفضة</td></tr>';
      } else {
        lowBody.innerHTML = stats.lowStockItems.map(item => `
          <tr>
            <td><strong>${esc(item.name)}</strong></td>
            <td class="num"><strong style="color:var(--danger-text);">${fmtNum(item.stock_kg)} كغم</strong></td>
            <td class="num">${fmtNum(item.low_stock)} كغم</td>
            <td><span class="badge badge-danger">مخزون منخفض</span></td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Failed to render dashboard:', err);
  }
}

function refreshDashboard() {
  renderDashboard();
  loadAllData();
  toast('تم تحديث بيانات لوحة المعلومات', 'ok');
}

/* =========================================================
   POS (POINT OF SALE)
========================================================= */
let posInvoice = { customerId: null, lines: [] };
let customerLastPricesMap = {};
let heldInvoices = JSON.parse(localStorage.getItem('alawa_held_invoices') || '[]');

function updateHeldBadge() {
  const badge = document.getElementById('heldCountBadge');
  if (badge) {
    badge.textContent = heldInvoices.length;
    badge.style.display = heldInvoices.length > 0 ? 'inline-block' : 'none';
  }
}

function renderPOS() {
  document.getElementById('posDueDate').value = todayStr();
  updateHeldBadge();
  posFilterCustomers();
  posRenderCustSelected();
  posRenderLines();
}

function posFilterCustomers() {
  const q = document.getElementById('posCustSearch').value.trim();
  const box = document.getElementById('posCustResults');
  if (!q) { box.innerHTML = ''; return; }
  const res = state.customers.filter(c => c.name.includes(q) || (c.phone || '').includes(q) || (c.nickname || '').includes(q)).slice(0, 6);
  box.innerHTML = res.map(c => `
    <div class="quick-item" onclick="posSelectCustomer(${c.id})">
      <span>👤 ${esc(c.name)} ${c.nickname ? `(${esc(c.nickname)})` : ''}</span>
      <span class="num" style="float:left;font-size:12px;color:var(--text-secondary);">الرصيد: ${fmtNum(c.balance)}</span>
    </div>
  `).join('') || '<div class="sub" style="padding:6px;">لا توجد نتائج مطابقة</div>';
}

async function posSelectCustomer(id) {
  posInvoice.customerId = id;
  document.getElementById('posCustSearch').value = '';
  document.getElementById('posCustResults').innerHTML = '';
  customerLastPricesMap = {};
  try {
    const res = await api('GET', `/customers/${id}/last-prices`);
    customerLastPricesMap = res || {};
  } catch (err) {
    console.error('Failed to load customer last prices:', err);
  }
  posRenderCustSelected();
  posRenderLines();
  // Auto-focus item search for fast POS workflow
  const itSearch = document.getElementById('posItemSearch');
  if (itSearch) itSearch.focus();
}

function posRenderCustSelected() {
  const box = document.getElementById('posCustSelected');
  const prevBox = document.getElementById('posPrevDebtBox');
  const lbl = document.getElementById('posPrevDebtLbl');
  const val = document.getElementById('posPrevDebt');

  if (!posInvoice.customerId) {
    box.innerHTML = '';
    lbl.textContent = 'الدين السابق على الزبون';
    val.textContent = '0';
    prevBox.style.borderRightColor = 'var(--border-light)';
    return;
  }

  const c = state.customers.find(x => x.id === posInvoice.customerId);
  if (!c) {
    posInvoice.customerId = null;
    box.innerHTML = '';
    return;
  }

  const isOver = c.balance > c.credit_limit;
  box.innerHTML = `
    <div class="badge badge-sage" style="font-size:13px;padding:8px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:10px;width:100%;">
      <span>👤 <strong>${esc(c.name)}</strong> (${esc(c.category)})</span>
      <button class="btn btn-sm btn-secondary" onclick="posInvoice.customerId=null;customerLastPricesMap={};posRenderCustSelected();posRenderLines();">تغيير الزبون</button>
    </div>
    ${isOver ? `
      <div style="margin-top:8px;padding:8px 12px;background:var(--danger-bg);color:var(--danger-text);border:1px solid var(--danger-border);border-radius:var(--r-xs);font-size:12px;font-weight:700;">
        ⚠️ تحذير: رصيد الزبون (${fmtNum(c.balance)}) تجاوز سقف الدين المسموح (${fmtNum(c.credit_limit)})
      </div>
    ` : ''}
  `;

  if (c.balance < 0) {
    lbl.textContent = 'رصيد دائن للزبون (له بذمتنا)';
    val.textContent = fmtNum(Math.abs(c.balance));
    val.style.color = 'var(--success-text)';
  } else {
    lbl.textContent = 'الدين السابق على الزبون';
    val.textContent = fmtNum(c.balance);
    val.style.color = isOver ? 'var(--danger-text)' : 'var(--text-heading)';
  }
}

function posFilterItems() {
  const q = document.getElementById('posItemSearch').value.trim();
  const box = document.getElementById('posItemResults');
  if (!q) { box.innerHTML = ''; return; }
  const res = state.items.filter(i => i.name.includes(q) || (i.barcode && i.barcode.includes(q))).slice(0, 6);
  box.innerHTML = res.map(i => `
    <div class="quick-item" onclick="posAddLine(${i.id})">
      <span style="font-weight:700;">📦 ${esc(i.name)}</span>
      <span class="num" style="float:left;font-size:12px;">المخزون: ${fmtNum(i.stock_kg)} كغم</span>
    </div>
  `).join('') || '<div class="sub" style="padding:6px;">لا توجد مواد مطابقة</div>';
}

function posPriceFor(item, unit, customer) {
  const cat = customer ? customer.category : 'عادي';
  let p = item.price_normal;
  if (cat === 'جملة') p = item.price_wholesale;
  if (cat === 'مكاتب') p = item.price_office;
  if (unit === 'كيس') return p;
  if (unit === 'كغم') return (p || 0) / (item.bag_weight || 1);
  if (unit === 'طن') return ((p || 0) / (item.bag_weight || 1)) * 1000;
  return p;
}

function posAddLine(itemId) {
  const existing = posInvoice.lines.find(l => l.itemId === itemId && l.unit === 'كيس');
  if (existing) {
    existing.qty += 1;
  } else {
    const item = state.items.find(i => i.id === itemId);
    const customer = state.customers.find(c => c.id === posInvoice.customerId);
    let price = posPriceFor(item, 'كيس', customer);
    // If we have customer price memory for this item in 'كيس', use it as default!
    if (customerLastPricesMap[itemId] && customerLastPricesMap[itemId].unit === 'كيس') {
      price = customerLastPricesMap[itemId].price;
    }
    posInvoice.lines.push({ itemId, qty: 1, unit: 'كيس', priceOverride: price });
  }
  document.getElementById('posItemSearch').value = '';
  document.getElementById('posItemResults').innerHTML = '';
  posRenderLines();
}

function posRenderLines() {
  const body = document.getElementById('posLinesBody');
  if (posInvoice.lines.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">لم يتم إضافة مواد بعد. اختر مادة أعلاه لإضافتها للقائمة</td></tr>';
    posRecalc();
    return;
  }

  const customer = state.customers.find(c => c.id === posInvoice.customerId);
  body.innerHTML = posInvoice.lines.map((line, idx) => {
    const item = state.items.find(i => i.id === line.itemId);
    const weightKg = line.unit === 'كيس' ? line.qty * (item.bag_weight || 1) : (line.unit === 'طن' ? line.qty * 1000 : line.qty);
    const total = line.qty * line.priceOverride;
    const lastP = customerLastPricesMap[line.itemId];
    const showPriceHint = lastP && Math.abs(lastP.price - line.priceOverride) > 0.01;

    return `
      <tr>
        <td><strong>${esc(item.name)}</strong></td>
        <td style="width:130px;">
          <div style="display:flex;align-items:center;gap:4px;">
            <input type="number" class="form-control is-num" style="padding:4px 6px;font-size:13px;" value="${line.qty}" min="0.01" step="any" onchange="posUpdateLine(${idx}, 'qty', this.value)">
            <button type="button" class="btn-calc" onclick="openBagsCalcModal(${idx})" title="حاسبة الصناديق والأكياس وطرح الفارغ (F9)">🧮</button>
          </div>
        </td>
        <td style="width:90px;">
          <select class="form-control" style="padding:4px 6px;font-size:12px;" onchange="posUpdateLine(${idx}, 'unit', this.value)">
            <option value="كيس" ${line.unit === 'كيس' ? 'selected' : ''}>كيس</option>
            <option value="كغم" ${line.unit === 'كغم' ? 'selected' : ''}>كغم</option>
            <option value="طن" ${line.unit === 'طن' ? 'selected' : ''}>طن</option>
          </select>
        </td>
        <td style="width:130px;">
          <input type="number" class="form-control is-num" style="padding:4px 8px;font-size:13px;" value="${line.priceOverride}" min="0" step="any" onchange="posUpdateLine(${idx}, 'price', this.value)">
          ${showPriceHint ? `
            <div class="last-price-chip" onclick="posApplyLastPrice(${idx}, ${lastP.price})" title="انقر لتطبيق آخر سعر بيع مسجل لهذا الزبون">
              📌 آخر بيع: ${fmtNum(lastP.price)}
            </div>
          ` : ''}
        </td>
        <td class="num"><strong style="font-size:14px;">${fmtNum(total)}</strong></td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="posRemoveLine(${idx})">✕</button>
        </td>
      </tr>
    `;
  }).join('');

  posRecalc();
}

function posApplyLastPrice(idx, price) {
  const line = posInvoice.lines[idx];
  if (!line) return;
  line.priceOverride = Number(price);
  posRenderLines();
  toast(`تم تطبيق آخر سعر بيع: ${fmtNum(price)}`, 'ok');
}

function posUpdateLine(idx, field, val) {
  const line = posInvoice.lines[idx];
  if (!line) return;
  if (field === 'qty') line.qty = Math.max(parseFloat(val) || 0, 0.01);
  if (field === 'price') line.priceOverride = Math.max(parseFloat(val) || 0, 0);
  if (field === 'unit') {
    line.unit = val;
    const item = state.items.find(i => i.id === line.itemId);
    const customer = state.customers.find(c => c.id === posInvoice.customerId);
    line.priceOverride = posPriceFor(item, val, customer);
  }
  posRenderLines();
}

function posRemoveLine(idx) {
  posInvoice.lines.splice(idx, 1);
  posRenderLines();
}

function posRecalc() {
  let total = 0;
  for (const line of posInvoice.lines) {
    total += line.qty * line.priceOverride;
  }
  const paid = parseFloat(document.getElementById('posPaid').value) || 0;
  const remain = Math.max(total - paid, 0);

  document.getElementById('posTotal').textContent = fmtNum(total);
  document.getElementById('posRemain').textContent = fmtNum(remain);

  // Dual Currency equivalent calculation
  const rate = parseFloat(state.settings.usdRate) || 1530;
  const usdVal = total > 0 ? (total / rate).toFixed(2) : '0.00';
  const usdEl = document.getElementById('posTotalUSD');
  if (usdEl) {
    usdEl.textContent = `≈ $ ${usdVal} (صرف 100$: ${fmtNum(rate * 100)} د.ع)`;
  }

  const c = state.customers.find(x => x.id === posInvoice.customerId);
  const overrideWrap = document.getElementById('posOverrideWrap');
  if (c && currentUser && currentUser.role !== 'المالك' && (c.balance + remain) > c.credit_limit) {
    overrideWrap.style.display = 'block';
  } else {
    overrideWrap.style.display = 'none';
  }
}

function posSetQuickPaid(mode) {
  let total = 0;
  for (const line of posInvoice.lines) total += line.qty * line.priceOverride;
  const paidInput = document.getElementById('posPaid');
  if (!paidInput) return;
  if (mode === 'full') {
    paidInput.value = total > 0 ? total : 0;
  } else if (mode === 'zero') {
    paidInput.value = 0;
  }
  posRecalc();
}

function posAddQuickCash(amount) {
  const paidInput = document.getElementById('posPaid');
  if (!paidInput) return;
  const current = parseFloat(paidInput.value) || 0;
  paidInput.value = current + amount;
  posRecalc();
}

/* Bags & Crates Net-weight Calculator */
let currentCalcLineIdx = null;
function openBagsCalcModal(lineIdx) {
  currentCalcLineIdx = lineIdx;
  const line = posInvoice.lines[lineIdx];
  if (!line) return;
  const item = state.items.find(i => i.id === line.itemId);
  const defBagWeight = item ? (item.bag_weight || 50) : 50;

  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box" style="max-width:440px;">
        <div class="modal-header">
          <h3>🧮 حاسبة العلوة: الأكياس والصناديق وطرح الفارغ</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <p class="sub" style="margin-bottom:12px;">المادة: <strong>${esc(item ? item.name : '')}</strong></p>
          <div class="grid2">
            <div class="form-group">
              <label class="form-label">عدد الصناديق / الأكياس</label>
              <input type="number" class="form-control is-num" id="calcBagsCount" value="1" min="1" step="any" oninput="recalcBagsTotal()">
            </div>
            <div class="form-group">
              <label class="form-label">الوزن القائم للواحد (كغم)</label>
              <input type="number" class="form-control is-num" id="calcGrossWeight" value="${defBagWeight}" min="0.1" step="any" oninput="recalcBagsTotal()">
            </div>
          </div>
          <div class="grid2">
            <div class="form-group">
              <label class="form-label">وزن الفارغ (العلبة/الطرد) للواحد</label>
              <input type="number" class="form-control is-num" id="calcTareWeight" value="0" min="0" step="any" oninput="recalcBagsTotal()">
            </div>
            <div class="form-group">
              <label class="form-label">وزن فرط / إضافي (كغم)</label>
              <input type="number" class="form-control is-num" id="calcExtraWeight" value="0" step="any" oninput="recalcBagsTotal()">
            </div>
          </div>
          <div style="padding:14px;background:var(--bg-raised);border-radius:var(--r-sm);border:1px solid var(--border-light);text-align:center;margin-top:6px;">
            <div class="sub">الوزن الصافي الإجمالي المحسوب</div>
            <div class="num" id="calcNetResult" style="font-size:24px;font-weight:800;color:var(--sage-600);margin-top:4px;">0 كغم</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-primary" onclick="applyBagsCalc()">تطبيق الوزن في الفاتورة</button>
        </div>
      </div>
    </div>
  `;
  recalcBagsTotal();
}

function recalcBagsTotal() {
  const count = parseFloat(document.getElementById('calcBagsCount').value) || 0;
  const gross = parseFloat(document.getElementById('calcGrossWeight').value) || 0;
  const tare = parseFloat(document.getElementById('calcTareWeight').value) || 0;
  const extra = parseFloat(document.getElementById('calcExtraWeight').value) || 0;
  const netPerUnit = Math.max(gross - tare, 0);
  const totalNet = (count * netPerUnit) + extra;
  const resEl = document.getElementById('calcNetResult');
  if (resEl) {
    resEl.textContent = `${fmtNum(totalNet)} كغم`;
    resEl.dataset.val = totalNet;
  }
}

function applyBagsCalc() {
  if (currentCalcLineIdx === null) return;
  const resEl = document.getElementById('calcNetResult');
  const netVal = parseFloat(resEl.dataset.val) || 0;
  if (netVal <= 0) {
    toast('يرجى التأكد من الأوزان المدخلة', 'err');
    return;
  }
  const line = posInvoice.lines[currentCalcLineIdx];
  if (line) {
    line.qty = Math.round(netVal * 100) / 100;
    line.unit = 'كغم';
    const item = state.items.find(i => i.id === line.itemId);
    const customer = state.customers.find(c => c.id === posInvoice.customerId);
    line.priceOverride = posPriceFor(item, 'كغم', customer);
  }
  closeModal();
  posRenderLines();
  toast(`تم تطبيق الوزن الصافي: ${fmtNum(netVal)} كغم`, 'ok');
}

/* Held Invoices System */
function holdCurrentInvoice() {
  if (!posInvoice.customerId && posInvoice.lines.length === 0) {
    toast('لا توجد بيانات أو مواد في الفاتورة لتعليقها', 'err');
    return;
  }
  const customer = state.customers.find(c => c.id === posInvoice.customerId);
  const cName = customer ? customer.name : 'زبون عام';
  let total = 0;
  for (const l of posInvoice.lines) total += l.qty * l.priceOverride;

  const item = {
    id: Date.now(),
    customerId: posInvoice.customerId,
    customerName: cName,
    lines: JSON.parse(JSON.stringify(posInvoice.lines)),
    paid: document.getElementById('posPaid').value || '0',
    dueDate: document.getElementById('posDueDate').value,
    driverName: document.getElementById('posDriverName').value,
    driverPhone: document.getElementById('posDriverPhone').value,
    total,
    savedAt: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
  };

  heldInvoices.push(item);
  localStorage.setItem('alawa_held_invoices', JSON.stringify(heldInvoices));
  updateHeldBadge();
  clearPOS();
  toast(`تم تعليق الفاتورة بنجاح باسم: ${cName} (يمكن استرجاعها عبر F8)`, 'ok');
}

function openHeldInvoicesModal() {
  if (heldInvoices.length === 0) {
    toast('لا توجد فواتير معلقة حالياً', 'info');
    return;
  }
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box" style="max-width:540px;">
        <div class="modal-header">
          <h3>🗂️ الفواتير المعلقة (${heldInvoices.length})</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body" style="max-height:420px;overflow-y:auto;">
          ${heldInvoices.map((h) => `
            <div class="held-card">
              <div>
                <div style="font-weight:700;font-size:14px;color:var(--text-heading);">👤 ${esc(h.customerName)}</div>
                <div class="sub" style="margin-top:2px;">
                  ⏰ علقت عند: ${h.savedAt} • ${h.lines.length} مواد • الإجمالي: <strong class="num">${fmtNum(h.total)}</strong> ${curr()}
                </div>
              </div>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-sm btn-primary" onclick="resumeHeldInvoice(${h.id})">استرجاع</button>
                <button class="btn btn-sm btn-danger" onclick="discardHeldInvoice(${h.id})">حذف</button>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إغلاق</button>
        </div>
      </div>
    </div>
  `;
}

async function resumeHeldInvoice(id) {
  const item = heldInvoices.find(x => x.id === id);
  if (!item) return;
  if (posInvoice.lines.length > 0) {
    const ok = await confirmDialog('استرجاع فاتورة معلقة', 'الفاتورة الحالية تحتوي على مواد. هل تريد استبدالها بالفاتورة المعلقة؟', 'نعم، استبدال', false);
    if (!ok) return;
  }

  posInvoice.customerId = item.customerId;
  posInvoice.lines = JSON.parse(JSON.stringify(item.lines));
  document.getElementById('posPaid').value = item.paid || '';
  document.getElementById('posDueDate').value = item.dueDate || todayStr();
  document.getElementById('posDriverName').value = item.driverName || '';
  document.getElementById('posDriverPhone').value = item.driverPhone || '';

  heldInvoices = heldInvoices.filter(x => x.id !== id);
  localStorage.setItem('alawa_held_invoices', JSON.stringify(heldInvoices));
  updateHeldBadge();
  closeModal();

  posRenderCustSelected();
  posRenderLines();
  toast('تم استرجاع الفاتورة المعلقة إلى شاشة البيع', 'ok');
}

function discardHeldInvoice(id) {
  heldInvoices = heldInvoices.filter(x => x.id !== id);
  localStorage.setItem('alawa_held_invoices', JSON.stringify(heldInvoices));
  updateHeldBadge();
  openHeldInvoicesModal();
  toast('تم حذف الفاتورة المعلقة', 'ok');
}

function clearPOS() {
  posInvoice = { customerId: null, lines: [] };
  customerLastPricesMap = {};
  document.getElementById('posPaid').value = '';
  document.getElementById('posDriverName').value = '';
  document.getElementById('posDriverPhone').value = '';
  document.getElementById('posOverridePin').value = '';
  posRenderCustSelected();
  posRenderLines();
}

async function saveInvoice() {
  if (!posInvoice.customerId) {
    toast('يرجى اختيار الزبون أولاً (F3)', 'err');
    return;
  }
  if (posInvoice.lines.length === 0) {
    toast('يرجى إضافة مادة واحدة على الأقل للقائمة (F4)', 'err');
    return;
  }
  const paid = parseFloat(document.getElementById('posPaid').value) || 0;
  const body = {
    customerId: posInvoice.customerId,
    lines: posInvoice.lines.map(l => ({ itemId: l.itemId, qty: l.qty, unit: l.unit, priceOverride: l.priceOverride })),
    paid,
    dueDate: document.getElementById('posDueDate').value,
    driverName: document.getElementById('posDriverName').value,
    driverPhone: document.getElementById('posDriverPhone').value,
    overridePin: document.getElementById('posOverridePin').value
  };

  try {
    const res = await api('POST', '/invoices', body);
    const invoiceId = res.id;
    toast('تم حفظ القائمة بنجاح', 'ok');

    // Prompt for instant printing or print preview
    triggerPrintPrompt(invoiceId);

    // Show instant success modal with print & WhatsApp direct share
    showInvoiceSuccessModal(invoiceId, body.customerId);

    clearPOS();
    await loadAllData();
    renderPOS();
    if (document.getElementById('screen-dashboard').classList.contains('active')) {
      renderDashboard();
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

function triggerPrintPrompt(invoiceId) {
  if (!invoiceId) return;
  // Open 80mm thermal print template
  const printUrl = `/print/invoice.html?id=${invoiceId}`;
  const win = window.open(printUrl, 'InvoicePrint', 'width=380,height=600,scrollbars=yes');
  if (win) win.focus();
}

function showInvoiceSuccessModal(invoiceId, customerId) {
  const cust = state.customers.find(c => c.id === customerId);
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box" style="max-width:440px;">
        <div class="modal-header">
          <h3>✅ تم حفظ الفاتورة بنجاح</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body" style="text-align:center;padding:20px 16px;">
          <div style="font-size:38px;margin-bottom:8px;">🧾</div>
          <div style="font-size:16px;font-weight:700;color:var(--text-heading);margin-bottom:4px;">فاتورة مبيعات رقم: #${invoiceId}</div>
          <div class="sub" style="margin-bottom:18px;">الزبون: <strong>${esc(cust ? cust.name : 'زبون عام')}</strong></div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn btn-primary" style="padding:10px;" onclick="triggerPrintPrompt(${invoiceId})">
              <span>🖨️</span> طباعة الفاتورة الفورية (80 مم)
            </button>
            <button class="btn btn-whatsapp" style="padding:10px;" onclick="shareInvoiceWhatsApp(${invoiceId})">
              <span>💬</span> إرسال تفاصيل الفاتورة عبر واتساب
            </button>
          </div>
        </div>
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn btn-secondary" onclick="closeModal()">➕ متابعة البيع (Esc)</button>
        </div>
      </div>
    </div>
  `;
}

/* =========================================================
   CUSTOMERS SCREEN
========================================================= */
function renderCustomersScreen() {
  renderCustomersTable();
}

function renderCustomersTable() {
  const q = document.getElementById('custSearchMain').value.trim();
  const list = state.customers.filter(c => !q || c.name.includes(q) || (c.phone || '').includes(q) || (c.nickname || '').includes(q));
  const body = document.getElementById('customersTableBody');

  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state">لا يوجد زبائن مطابقين للبحث</div></td></tr>';
    return;
  }

  body.innerHTML = list.map(c => {
    const over = c.balance > c.credit_limit;
    return `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td>${esc(c.nickname) || '-'}</td>
        <td class="num">${esc(c.phone) || '-'}</td>
        <td><span class="badge badge-slate">${esc(c.category)}</span></td>
        <td class="num">${fmtNum(c.credit_limit)}</td>
        <td class="num">
          <span class="badge ${over ? 'badge-danger' : (c.balance > 0 ? 'badge-warning' : 'badge-sage')}">
            ${fmtNum(c.balance)}
          </span>
        </td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm btn-secondary" onclick="openLedgerFor('customer', ${c.id})">كشف حساب</button>
          <button class="btn btn-sm btn-success" onclick="openPaymentModal(${c.id})">قبض</button>
          <button class="btn btn-sm btn-secondary" onclick="openDebtModal(${c.id})">دين</button>
          <button class="btn btn-sm btn-secondary" onclick="openCustomerModal(${c.id})">تعديل</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCustomer(${c.id})">حذف</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openCustomerModal(id) {
  const c = id ? state.customers.find(x => x.id === id) : null;
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>${c ? 'تعديل بيانات الزبون' : 'إضافة زبون جديد'}</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">الاسم الكامل *</label><input class="form-control" id="cName" value="${c ? esc(c.name) : ''}"></div>
          <div class="grid2">
            <div class="form-group"><label class="form-label">اللقب / الشهرة</label><input class="form-control" id="cNick" value="${c ? esc(c.nickname) : ''}"></div>
            <div class="form-group"><label class="form-label">رقم الهاتف</label><input class="form-control is-num" id="cPhone" value="${c ? esc(c.phone) : ''}"></div>
          </div>
          <div class="grid2">
            <div class="form-group">
              <label class="form-label">فئة التسعير</label>
              <select class="form-control" id="cCat">
                <option ${c && c.category === 'جملة' ? 'selected' : ''}>جملة</option>
                <option ${c && c.category === 'مكاتب' ? 'selected' : ''}>مكاتب</option>
                <option ${!c || c.category === 'عادي' ? 'selected' : ''}>عادي</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">سقف الدين المسموح</label>
              <input type="number" class="form-control is-num" id="cLimit" value="${c ? c.credit_limit : (state.settings.defCredit || 500000)}">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-primary" onclick="saveCustomer(${c ? c.id : 'null'})">حفظ البيانات</button>
        </div>
      </div>
    </div>
  `;
}

async function saveCustomer(id) {
  const body = {
    name: document.getElementById('cName').value.trim(),
    nickname: document.getElementById('cNick').value.trim(),
    phone: document.getElementById('cPhone').value.trim(),
    category: document.getElementById('cCat').value,
    creditLimit: document.getElementById('cLimit').value
  };
  try {
    if (id) await api('PUT', `/customers/${id}`, body);
    else await api('POST', '/customers', body);
    closeModal();
    toast('تم حفظ بيانات الزبون بنجاح', 'ok');
    await loadAllData();
    renderCustomersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deleteCustomer(id) {
  const c = state.customers.find(x => x.id === id);
  if (!c) return;
  const ok = await confirmDialog('حذف الزبون', `هل أنت متأكد من حذف الزبون "${c.name}"؟`, 'نعم، حذف الزبون');
  if (!ok) return;

  try {
    await api('DELETE', `/customers/${id}`);
    toast('تم حذف الزبون بنجاح', 'ok');
    await loadAllData();
    renderCustomersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function openPaymentModal(id) {
  const c = state.customers.find(x => x.id === id);
  if (!c) return;
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>تسجيل دفعة قبض من: ${esc(c.name)}</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="stat-card" style="margin-bottom:14px;background:var(--bg-raised);">
            <div class="stat-label">الدين الحالي المستحق</div>
            <div class="stat-value" style="color:var(--danger-text);">${fmtNum(c.balance)} ${curr()}</div>
          </div>
          <div class="form-group"><label class="form-label">المبلغ المقبوض *</label><input type="number" class="form-control is-num" id="payAmount" placeholder="0"></div>
          <div class="form-group"><label class="form-label">ملاحظات أو بيان القبض</label><input class="form-control" id="payNote" placeholder="اختياري"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-success" onclick="saveCustomerPayment(${id})">تسجيل القبض</button>
        </div>
      </div>
    </div>
  `;
}

async function saveCustomerPayment(id) {
  try {
    await api('POST', `/customers/${id}/payment`, {
      amount: document.getElementById('payAmount').value,
      note: document.getElementById('payNote').value
    });
    closeModal();
    toast('تم تسجيل الدفعة وإيداعها في الصندوق', 'ok');
    await loadAllData();
    renderCustomersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function openDebtModal(id) {
  const c = state.customers.find(x => x.id === id);
  if (!c) return;
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>إضافة دين يدوي على: ${esc(c.name)}</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">المبلغ المضاف *</label><input type="number" class="form-control is-num" id="debtAmount" placeholder="0"></div>
          <div class="form-group"><label class="form-label">السبب أو البيان</label><input class="form-control" id="debtNote" placeholder="سبب الدين"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-danger" onclick="saveCustomerDebt(${id})">إضافة الدين</button>
        </div>
      </div>
    </div>
  `;
}

async function saveCustomerDebt(id) {
  try {
    await api('POST', `/customers/${id}/debt`, {
      amount: document.getElementById('debtAmount').value,
      note: document.getElementById('debtNote').value
    });
    closeModal();
    toast('تمت إضافة الدين بنجاح', 'ok');
    await loadAllData();
    renderCustomersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* =========================================================
   INVENTORY SCREEN
========================================================= */
function renderInventoryScreen() {
  renderInventoryTable();
}

function renderInventoryTable() {
  const q = document.getElementById('itemSearchMain').value.trim();
  const list = state.items.filter(i => !q || i.name.includes(q) || (i.barcode && i.barcode.includes(q)));
  const body = document.getElementById('inventoryTableBody');

  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="8"><div class="empty-state">لا توجد مواد مطابقة للبحث</div></td></tr>';
    return;
  }

  body.innerHTML = list.map(i => {
    const low = i.stock_kg <= i.low_stock;
    return `
      <tr>
        <td><strong>${esc(i.name)}</strong></td>
        <td class="num">${fmtNum(i.bag_weight)}</td>
        <td class="num">
          <span class="badge ${low ? 'badge-danger' : 'badge-sage'}">
            ${fmtNum(i.stock_kg)}
          </span>
        </td>
        <td class="num">${fmtNum(i.price_wholesale)}</td>
        <td class="num">${fmtNum(i.price_office)}</td>
        <td class="num">${fmtNum(i.price_normal)}</td>
        <td class="num">${esc(i.barcode) || '<span style="color:var(--text-muted);">-</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm btn-secondary" onclick="openAdjustModal(${i.id})">تسوية مخزون</button>
          <button class="btn btn-sm btn-secondary" onclick="openItemModal(${i.id})">تعديل</button>
          <button class="btn btn-sm btn-danger" onclick="deleteItem(${i.id})">حذف</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openItemModal(id) {
  const it = id ? state.items.find(x => x.id === id) : null;
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>${it ? 'تعديل بيانات المادة' : 'إضافة مادة جديدة للمخزون'}</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">اسم المادة *</label><input class="form-control" id="iName" value="${it ? esc(it.name) : ''}"></div>
          <div class="grid2">
            <div class="form-group"><label class="form-label">وزن الكيس (كغم)</label><input type="number" class="form-control is-num" id="iBagWeight" value="${it ? it.bag_weight : 50}"></div>
            <div class="form-group"><label class="form-label">المخزون الأولي (كغم)</label><input type="number" class="form-control is-num" id="iStock" value="${it ? it.stock_kg : 0}" ${it ? 'disabled title="لتعديل المخزون استخدم زر تسوية المخزون"' : ''}></div>
          </div>
          <div class="form-group"><label class="form-label">الباركود (Barcode) — اختياري</label><input class="form-control is-num" id="iBarcode" value="${it ? esc(it.barcode || '') : ''}" placeholder="امسح الباركود بجهاز القارئ"></div>
          ${!it ? `<div class="form-group"><label class="form-label">تكلفة الكيلو الافتتاحية</label><input type="number" class="form-control is-num" id="iOpenCost" value="0"></div>` : ''}
          <div class="grid3">
            <div class="form-group"><label class="form-label">سعر الجملة</label><input type="number" class="form-control is-num" id="pWholesale" value="${it ? it.price_wholesale : 0}"></div>
            <div class="form-group"><label class="form-label">سعر المكاتب</label><input type="number" class="form-control is-num" id="pOffice" value="${it ? it.price_office : 0}"></div>
            <div class="form-group"><label class="form-label">سعر العادي</label><input type="number" class="form-control is-num" id="pNormal" value="${it ? it.price_normal : 0}"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-primary" onclick="saveItem(${it ? it.id : 'null'})">حفظ المادة</button>
        </div>
      </div>
    </div>
  `;
}

async function saveItem(id) {
  const body = {
    name: document.getElementById('iName').value.trim(),
    bagWeight: document.getElementById('iBagWeight').value,
    barcode: document.getElementById('iBarcode').value.trim() || null,
    priceWholesale: document.getElementById('pWholesale').value,
    priceOffice: document.getElementById('pOffice').value,
    priceNormal: document.getElementById('pNormal').value
  };
  if (!id) {
    body.stockKg = document.getElementById('iStock').value;
    body.openingCost = document.getElementById('iOpenCost').value;
  }

  try {
    if (id) await api('PUT', `/items/${id}`, body);
    else await api('POST', '/items', body);
    closeModal();
    toast('تم حفظ المادة بنجاح', 'ok');
    await loadAllData();
    renderInventoryScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deleteItem(id) {
  const it = state.items.find(x => x.id === id);
  if (!it) return;
  const ok = await confirmDialog('حذف المادة', `هل تريد بالتأكيد حذف المادة "${it.name}" من النظام؟`, 'نعم، حذف المادة');
  if (!ok) return;

  try {
    await api('DELETE', `/items/${id}`);
    toast('تم الحذف بنجاح', 'ok');
    await loadAllData();
    renderInventoryScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function openAdjustModal(id) {
  const it = state.items.find(x => x.id === id);
  if (!it) return;
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>تسوية جرد المخزون: ${esc(it.name)}</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <p class="sub" style="margin-bottom:12px;">المخزون المسجل بالنظام حالياً: <strong class="num">${fmtNum(it.stock_kg)}</strong> كغم</p>
          <div class="form-group"><label class="form-label">الكمية الفعلية الموجودة في المستودع (كغم) *</label><input type="number" class="form-control is-num" id="adjStock" value="${it.stock_kg}"></div>
          <div class="form-group">
            <label class="form-label">سبب التسوية *</label>
            <select class="form-control" id="adjReason">
              <option>خطأ جرد سابق</option>
              <option>تلف / هالك</option>
              <option>رطوبة / نقص طبيعي</option>
              <option>سرقة / فقدان</option>
              <option>زيادة فعلية بالجرد</option>
              <option>أخرى</option>
            </select>
          </div>
          <div class="form-group"><label class="form-label">ملاحظات إضافية</label><input class="form-control" id="adjNote" placeholder="اختياري"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-primary" onclick="saveAdjust(${id})">تأكيد التسوية</button>
        </div>
      </div>
    </div>
  `;
}

async function saveAdjust(id) {
  try {
    const res = await api('POST', `/items/${id}/adjust`, {
      newStock: document.getElementById('adjStock').value,
      reason: document.getElementById('adjReason').value,
      note: document.getElementById('adjNote').value
    });
    closeModal();
    toast(res.costImpact > 0 ? `تمت تسوية المخزون — خسارة تقديرية ${fmtNum(res.costImpact)} ${curr()}` : 'تمت تسوية المخزون بنجاح', 'ok');
    await loadAllData();
    renderInventoryScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* =========================================================
   SUPPLIERS SCREEN
========================================================= */
function renderSuppliersScreen() {
  const body = document.getElementById('suppliersTableBody');
  if (state.suppliers.length === 0) {
    body.innerHTML = '<tr><td colspan="4"><div class="empty-state">لا يوجد موردون مسجلون</div></td></tr>';
    return;
  }
  body.innerHTML = state.suppliers.map(s => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td class="num">${esc(s.phone) || '-'}</td>
      <td class="num">
        <span class="badge ${s.balance > 0 ? 'badge-danger' : 'badge-sage'}">
          ${fmtNum(s.balance)}
        </span>
      </td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm btn-secondary" onclick="openLedgerFor('supplier', ${s.id})">كشف حساب</button>
        <button class="btn btn-sm btn-success" onclick="openSupplierPaymentModal(${s.id})">تسديد دفعة</button>
        <button class="btn btn-sm btn-secondary" onclick="openSupplierModal(${s.id})">تعديل</button>
        <button class="btn btn-sm btn-danger" onclick="deleteSupplier(${s.id})">حذف</button>
      </td>
    </tr>
  `).join('');
}

function openSupplierModal(id) {
  const s = id ? state.suppliers.find(x => x.id === id) : null;
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>${s ? 'تعديل بيانات المورد' : 'إضافة مورد جديد'}</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">اسم المورد *</label><input class="form-control" id="sName" value="${s ? esc(s.name) : ''}"></div>
          <div class="form-group"><label class="form-label">رقم الهاتف</label><input class="form-control is-num" id="sPhone" value="${s ? esc(s.phone) : ''}"></div>
          <div class="grid2">
            <div class="form-group"><label class="form-label">رصيد دائن (له بذمتنا)</label><input type="number" class="form-control is-num" id="sBalance" value="${s ? s.balance : 0}"></div>
            <div class="form-group"><label class="form-label">رصيد مدين (لنا عنده)</label><input type="number" class="form-control is-num" id="sCredit" value="${s ? s.credit_from_supplier : 0}"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-primary" onclick="saveSupplier(${s ? s.id : 'null'})">حفظ البيانات</button>
        </div>
      </div>
    </div>
  `;
}

async function saveSupplier(id) {
  const body = {
    name: document.getElementById('sName').value.trim(),
    phone: document.getElementById('sPhone').value.trim(),
    balance: document.getElementById('sBalance').value,
    creditFromSupplier: document.getElementById('sCredit').value
  };
  try {
    if (id) await api('PUT', `/suppliers/${id}`, body);
    else await api('POST', '/suppliers', body);
    closeModal();
    toast('تم حفظ بيانات المورد', 'ok');
    await loadAllData();
    renderSuppliersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deleteSupplier(id) {
  const s = state.suppliers.find(x => x.id === id);
  if (!s) return;
  const ok = await confirmDialog('حذف المورد', `هل تريد بالتأكيد حذف المورد "${s.name}"؟`, 'نعم، حذف المورد');
  if (!ok) return;

  try {
    await api('DELETE', `/suppliers/${id}`);
    toast('تم حذف المورد', 'ok');
    await loadAllData();
    renderSuppliersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function openSupplierPaymentModal(id) {
  const s = state.suppliers.find(x => x.id === id);
  if (!s) return;
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>تسديد دفعة للمورد: ${esc(s.name)}</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <p class="sub" style="margin-bottom:12px;">المبلغ المستحق للمورد: <strong class="num">${fmtNum(s.balance)}</strong> ${curr()}</p>
          <div class="form-group"><label class="form-label">المبلغ المسدد *</label><input type="number" class="form-control is-num" id="sPayAmount" placeholder="0"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-success" onclick="saveSupplierPayment(${id})">تسجيل التسديد</button>
        </div>
      </div>
    </div>
  `;
}

async function saveSupplierPayment(id) {
  try {
    await api('POST', `/suppliers/${id}/payment`, { amount: document.getElementById('sPayAmount').value });
    closeModal();
    toast('تم تسجيل التسديد وصرف المبلغ من الصندوق', 'ok');
    await loadAllData();
    renderSuppliersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* PURCHASES MODAL */
let purchaseLines = [];
function openPurchaseModal() {
  purchaseLines = [];
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box" style="width:620px;">
        <div class="modal-header">
          <h3>فاتورة شراء بضاعة جديدة من مورد</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">المورد *</label>
            <select class="form-control" id="pSupplier">
              ${state.suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="grid3">
            <div class="form-group"><label class="form-label">المادة</label><select class="form-control" id="pItem">${state.items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></div>
            <div class="form-group"><label class="form-label">الكمية (كغم)</label><input type="number" class="form-control is-num" id="pQty" value="0"></div>
            <div class="form-group"><label class="form-label">سعر التكلفة للكيلو</label><input type="number" class="form-control is-num" id="pCostKg" value="0"></div>
          </div>
          <button class="btn btn-sm btn-secondary" style="margin-bottom:12px;" onclick="addPurchaseLine()">+ إضافة المادة للفاتورة</button>
          <div class="tbl-wrap">
            <table>
              <thead><tr><th>المادة</th><th>كغم</th><th>التكلفة/كغم</th><th>الإجمالي</th><th></th></tr></thead>
              <tbody id="purchLinesBody"></tbody>
            </table>
          </div>
          <div class="grid2" style="margin-top:14px;">
            <div class="form-group"><label class="form-label">أجور النقل والتوصيل</label><input type="number" class="form-control is-num" id="pTransport" value="0" oninput="renderPurchaseLines()"></div>
            <div class="form-group"><label class="form-label">أجور العمال والتحميل</label><input type="number" class="form-control is-num" id="pLoading" value="0" oninput="renderPurchaseLines()"></div>
          </div>
          <div class="form-group"><label class="form-label">المبلغ المدفوع كاش الآن</label><input type="number" class="form-control is-num" id="pPaid" value="0"></div>
          <div style="font-size:16px;font-weight:700;margin:12px 0;">المجموع النهائي للفاتورة: <span class="num" id="pGrandTotal">0</span> ${curr()}</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-primary" onclick="savePurchase()">حفظ الفاتورة وتحديث المخزون</button>
        </div>
      </div>
    </div>
  `;
}

function addPurchaseLine() {
  const itemId = parseInt(document.getElementById('pItem').value);
  const qty = parseFloat(document.getElementById('pQty').value) || 0;
  const cost = parseFloat(document.getElementById('pCostKg').value) || 0;
  if (qty <= 0) { toast('يرجى إدخال كمية صحيحة', 'err'); return; }
  purchaseLines.push({ itemId, qty, cost });
  renderPurchaseLines();
}

function renderPurchaseLines() {
  const body = document.getElementById('purchLinesBody');
  let sub = 0;
  body.innerHTML = purchaseLines.map((l, idx) => {
    const it = state.items.find(i => i.id === l.itemId);
    const total = l.qty * l.cost;
    sub += total;
    return `
      <tr>
        <td><strong>${esc(it ? it.name : '-')}</strong></td>
        <td class="num">${fmtNum(l.qty)}</td>
        <td class="num">${fmtNum(l.cost)}</td>
        <td class="num">${fmtNum(total)}</td>
        <td><button class="btn btn-sm btn-danger" onclick="purchaseLines.splice(${idx},1);renderPurchaseLines();">✕</button></td>
      </tr>
    `;
  }).join('');

  const transport = parseFloat(document.getElementById('pTransport')?.value) || 0;
  const loading = parseFloat(document.getElementById('pLoading')?.value) || 0;
  document.getElementById('pGrandTotal').textContent = fmtNum(sub + transport + loading);
}

async function savePurchase() {
  const supplierId = parseInt(document.getElementById('pSupplier').value);
  if (purchaseLines.length === 0) {
    toast('أضف مادة واحدة على الأقل لفاتورة الشراء', 'err');
    return;
  }
  try {
    await api('POST', '/purchases', {
      supplierId,
      lines: purchaseLines,
      transportCost: document.getElementById('pTransport').value,
      loadingCost: document.getElementById('pLoading').value,
      paid: document.getElementById('pPaid').value
    });
    closeModal();
    toast('تم حفظ فاتورة الشراء وتحديث المخزون بنجاح', 'ok');
    await loadAllData();
    renderSuppliersScreen();
    renderInventoryScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* =========================================================
   CASHBOX SCREEN
========================================================= */
function resetCashDates() {
  document.getElementById('cashFrom').value = todayStr();
  document.getElementById('cashTo').value = todayStr();
  renderCashboxTable();
}

async function renderCashboxScreen() {
  if (!document.getElementById('cashFrom').value) {
    document.getElementById('cashFrom').value = todayStr();
    document.getElementById('cashTo').value = todayStr();
  }
  await renderCashboxTable();
}

async function renderCashboxTable() {
  const from = document.getElementById('cashFrom').value, to = document.getElementById('cashTo').value;
  const list = await api('GET', `/cashbox?from=${from}&to=${to}`);

  const directSales = list.filter(c => c.type === 'in' && c.source === 'بيع').reduce((s, c) => s + c.amount, 0);
  const collections = list.filter(c => c.type === 'in' && c.source === 'قبض من زبون').reduce((s, c) => s + c.amount, 0);
  const internalExpenses = list.filter(c => c.type === 'out' && c.source === 'يدوي').reduce((s, c) => s + c.amount, 0);
  const purchasesOut = list.filter(c => c.type === 'out' && (c.source === 'شراء' || c.source === 'تسديد لمورد')).reduce((s, c) => s + c.amount, 0);
  const totalIn = list.filter(c => c.type === 'in').reduce((s, c) => s + c.amount, 0);
  const totalOut = list.filter(c => c.type === 'out').reduce((s, c) => s + c.amount, 0);

  document.getElementById('cashStatsRow').innerHTML = `
    <div class="stat-card"><div class="stat-label">المقبوضات النقدية اليوم</div><div class="stat-value">${fmtNum(totalIn)}</div></div>
    <div class="stat-card danger"><div class="stat-label">المدفوعات والمصروفات</div><div class="stat-value" style="color:var(--danger-text);">${fmtNum(totalOut)}</div></div>
    <div class="stat-card info"><div class="stat-label">صافي حركة الصندوق</div><div class="stat-value">${fmtNum(totalIn - totalOut)}</div></div>
  `;

  const body = document.getElementById('cashboxTableBody');
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="6"><div class="empty-state">لا توجد حركات نقدية خلال الفترة المحددة</div></td></tr>';
    return;
  }
  body.innerHTML = list.map(c => `
    <tr>
      <td>${fmtDate(c.date)}</td>
      <td><span class="badge ${c.type === 'in' ? 'badge-sage' : 'badge-danger'}">${c.type === 'in' ? 'داخل (+)' : 'خارج (-)'}</span></td>
      <td><strong>${esc(c.source)}</strong></td>
      <td>${esc(c.customer_name) || '-'}</td>
      <td>${esc(c.note) || '-'}</td>
      <td class="num"><strong>${fmtNum(c.amount)}</strong></td>
    </tr>
  `).join('');
}

function openCashModal() {
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>تسجيل حركة نقدية يدوية في الصندوق</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">نوع الحركة</label>
            <select class="form-control" id="cbType" onchange="toggleCbCustomer()">
              <option value="in">داخل (قبض نقدي وارد)</option>
              <option value="out">خارج (صرف / مصروفات)</option>
            </select>
          </div>
          <div class="form-group" id="cbCustField">
            <label class="form-label">الزبون (اختياري)</label>
            <select class="form-control" id="cbCustomer">
              <option value="">-- بدون ارتباط بزبون --</option>
              ${state.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label class="form-label">المبلغ *</label><input type="number" class="form-control is-num" id="cbAmount" placeholder="0"></div>
          <div class="form-group"><label class="form-label">البيان أو الوصف</label><input class="form-control" id="cbNote" placeholder="سبب الحركة"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-primary" onclick="saveCashManual()">حفظ الحركة</button>
        </div>
      </div>
    </div>
  `;
}

function toggleCbCustomer() {
  document.getElementById('cbCustField').style.display = document.getElementById('cbType').value === 'in' ? 'block' : 'none';
}

async function saveCashManual() {
  const customerId = document.getElementById('cbCustomer').value;
  try {
    await api('POST', '/cashbox', {
      type: document.getElementById('cbType').value,
      amount: document.getElementById('cbAmount').value,
      note: document.getElementById('cbNote').value,
      customerId: customerId || undefined
    });
    closeModal();
    toast('تم تسجيل الحركة النقدية', 'ok');
    await loadAllData();
    renderCashboxScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* =========================================================
   REPORTS SCREEN
========================================================= */
async function renderReportsScreen() {
  const daily = await api('GET', '/reports/daily');
  document.getElementById('dailySummaryBox').innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">إجمالي مبيعات اليوم</div><div class="stat-value">${fmtNum(daily.totalSales)}</div></div>
      <div class="stat-card terra"><div class="stat-label">المبيعات الآجلة اليوم</div><div class="stat-value">${fmtNum(daily.creditSales)}</div></div>
      <div class="stat-card info"><div class="stat-label">عدد القوائم المسجلة</div><div class="stat-value">${daily.count}</div></div>
      <div class="stat-card"><div class="stat-label">إجمالي الوزن المباع (كغم)</div><div class="stat-value">${fmtNum(daily.kg)}</div></div>
    </div>
  `;
  document.getElementById('profitFrom').value = todayStr();
  document.getElementById('profitTo').value = todayStr();
  if (!document.getElementById('weekFrom').value) setCurrentWeek();
  else renderWeeklyReport();
  fillLedgerSelect();
}

function setCurrentWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = (day - 6 + 7) % 7;
  const start = new Date(now); start.setDate(now.getDate() - diff);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  document.getElementById('weekFrom').value = fmt(start);
  document.getElementById('weekTo').value = fmt(end);
  renderWeeklyReport();
}

async function renderWeeklyReport() {
  const from = document.getElementById('weekFrom').value, to = document.getElementById('weekTo').value;
  const r = await api('GET', `/reports/weekly?from=${from}&to=${to}`);
  document.getElementById('weeklyStatsRow').innerHTML = `
    <div class="stat-card"><div class="stat-label">المبيعات الإجمالية</div><div class="stat-value">${fmtNum(r.totalSales)}</div></div>
    <div class="stat-card terra"><div class="stat-label">البيع بالآجل</div><div class="stat-value">${fmtNum(r.creditSales)}</div></div>
    <div class="stat-card info"><div class="stat-label">المقبوضات النقدية</div><div class="stat-value">${fmtNum(r.totalCashIn)}</div></div>
    <div class="stat-card danger"><div class="stat-label">المصاريف التشغيلية</div><div class="stat-value">${fmtNum(r.manualExpense)}</div></div>
  `;

  const body = document.getElementById('weeklyCustomersBody');
  body.innerHTML = r.customers && r.customers.length
    ? r.customers.map(c => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td class="num">${c.count}</td>
        <td class="num">${fmtNum(c.total)}</td>
        <td class="num"><span class="badge badge-sage">${fmtNum(c.paid)}</span></td>
        <td class="num"><span class="badge ${c.remaining > 0 ? 'badge-danger' : 'badge-sage'}">${fmtNum(c.remaining)}</span></td>
      </tr>
    `).join('')
    : '<tr><td colspan="5"><div class="empty-state">لا توجد مبيعات في هذه الفترة</div></td></tr>';
}

async function renderProfitReport() {
  const from = document.getElementById('profitFrom').value, to = document.getElementById('profitTo').value;
  const rows = await api('GET', `/reports/profit?from=${from}&to=${to}`);
  const body = document.getElementById('profitTableBody');
  body.innerHTML = rows && rows.length
    ? rows.map(r => `
      <tr>
        <td><strong>${esc(r.name)}</strong></td>
        <td class="num">${fmtNum(r.kg)}</td>
        <td class="num">${fmtNum(r.revenue)}</td>
        <td class="num">${fmtNum(r.cost)}</td>
        <td class="num"><strong style="color:${r.profit >= 0 ? 'var(--success-text)' : 'var(--danger-text)'};">${fmtNum(r.profit)}</strong></td>
      </tr>
    `).join('')
    : '<tr><td colspan="5"><div class="empty-state">لا توجد بيانات أرباح مسجلة في هذه الفترة</div></td></tr>';
}

function fillLedgerSelect() {
  const type = document.getElementById('ledgerType').value;
  const sel = document.getElementById('ledgerSelect');
  const list = type === 'customer' ? state.customers : state.suppliers;
  sel.innerHTML = list.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  renderLedgerReport();
}

function openLedgerFor(type, id) {
  showScreen('reports');
  document.getElementById('ledgerType').value = type;
  fillLedgerSelect();
  document.getElementById('ledgerSelect').value = id;
  renderLedgerReport();
}

async function renderLedgerReport() {
  const type = document.getElementById('ledgerType').value;
  const id = document.getElementById('ledgerSelect').value;
  const box = document.getElementById('ledgerBox');
  if (!id) { box.innerHTML = ''; return; }
  const path = type === 'customer' ? `/customers/${id}/ledger` : `/suppliers/${id}/ledger`;
  const { rows, balance } = await api('GET', path);

  if (!rows || rows.length === 0) {
    box.innerHTML = '<div class="empty-state">لا توجد حركات مسجلة في كشف الحساب</div>';
    return;
  }
  const lbl = (type === 'customer' && balance < 0) ? 'رصيد دائن للزبون' : 'الرصيد المالي الحالي';
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
      <span style="font-weight:700;color:var(--text-heading);">عدد العمليات المسجلة: <strong>${rows.length}</strong></span>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm btn-secondary" onclick="printLedgerDocument('${type}', ${id})">🖨️ طباعة كشف الحساب</button>
        ${type === 'customer' ? `<button class="btn btn-sm btn-whatsapp" onclick="shareLedgerWhatsApp('${type}', ${id})">💬 مشاركة الكشف عبر واتساب</button>` : ''}
      </div>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr><th>التاريخ</th><th>البيان</th><th>المادة</th><th>الكمية</th><th>مدين (+)</th><th>دائن (-)</th><th style="width:85px;text-align:center;">إجراء</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const invMatch = r.desc.match(/#(\d+)/);
            const invId = invMatch ? invMatch[1] : null;
            return `
              <tr>
                <td>${fmtDate(r.date)}</td>
                <td>${esc(r.desc)}</td>
                <td>${esc(r.material) || '-'}</td>
                <td>${esc(r.qty) || '-'}</td>
                <td class="num">${r.debit ? fmtNum(r.debit) : '-'}</td>
                <td class="num">${r.credit ? fmtNum(r.credit) : '-'}</td>
                <td style="white-space:nowrap;text-align:center;">
                  ${invId ? `
                    <button class="btn btn-sm btn-secondary" style="padding:2px 6px;" onclick="triggerPrintPrompt(${invId})" title="طباعة الفاتورة 80 مم">🖨️</button>
                    <button class="btn btn-sm btn-whatsapp" style="padding:2px 6px;" onclick="shareInvoiceWhatsApp(${invId})" title="مشاركة الفاتورة عبر واتساب">💬</button>
                  ` : '-'}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:14px;padding:12px 16px;background:var(--bg-raised);border-radius:var(--r-md);display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:700;">${lbl}:</span>
      <span class="num" style="font-size:20px;font-weight:700;color:var(--text-heading);">${fmtNum(Math.abs(balance))} ${curr()}</span>
    </div>
  `;
}

/* =========================================================
   RETURNS
========================================================= */
function openReturnModal() {
  if (state.customers.length === 0 || state.items.length === 0) {
    toast('يرجى إضافة زبون ومادة أولاً', 'err');
    return;
  }
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>↩️ تسجيل إرجاع مواد من زبون</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">الزبون *</label><select class="form-control" id="retCustomer">${state.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label class="form-label">المادة *</label><select class="form-control" id="retItem" onchange="retAutoPrice()">${state.items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></div>
          <div class="grid2">
            <div class="form-group"><label class="form-label">الكمية</label><input type="number" class="form-control is-num" id="retQty" value="1" oninput="retUpdatePreview()"></div>
            <div class="form-group"><label class="form-label">الوحدة</label><select class="form-control" id="retUnit" onchange="retAutoPrice()"><option value="كيس">كيس</option><option value="كغم">كغم</option><option value="طن">طن</option></select></div>
          </div>
          <div class="form-group"><label class="form-label">سعر الوحدة المرتجعة</label><input type="number" class="form-control is-num" id="retPrice" value="0" oninput="retUpdatePreview()"></div>
          <div class="form-group"><label class="form-label">طريقة الإرجاع</label><select class="form-control" id="retMethod"><option value="cash">نقداً (يصرف من الصندوق)</option><option value="credit">خصم من رصيد دين الزبون</option></select></div>
          <div style="background:var(--bg-raised);padding:10px 14px;border-radius:var(--r-sm);margin-bottom:12px;">المبلغ الإجمالي للمرتجع: <strong class="num" id="retPreview">0</strong> ${curr()}</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-danger" onclick="saveReturn()">تأكيد الإرجاع</button>
        </div>
      </div>
    </div>
  `;
  retAutoPrice();
}

function retAutoPrice() {
  const custId = parseInt(document.getElementById('retCustomer').value);
  const itemId = parseInt(document.getElementById('retItem').value);
  const unit = document.getElementById('retUnit').value;
  const c = state.customers.find(x => x.id === custId), it = state.items.find(x => x.id === itemId);
  if (!c || !it) return;
  document.getElementById('retPrice').value = posPriceFor(it, unit, c).toFixed(2);
  retUpdatePreview();
}

function retUpdatePreview() {
  const qty = parseFloat(document.getElementById('retQty').value) || 0;
  const price = parseFloat(document.getElementById('retPrice').value) || 0;
  document.getElementById('retPreview').textContent = fmtNum(qty * price);
}

async function saveReturn() {
  try {
    await api('POST', '/returns', {
      customerId: document.getElementById('retCustomer').value,
      itemId: document.getElementById('retItem').value,
      qty: document.getElementById('retQty').value,
      unit: document.getElementById('retUnit').value,
      price: document.getElementById('retPrice').value,
      method: document.getElementById('retMethod').value
    });
    closeModal();
    toast('تم تسجيل المرتجع وتحديث المخزون بنجاح', 'ok');
    await loadAllData();
    renderCustomersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function openSupplierReturnModal() {
  if (state.suppliers.length === 0 || state.items.length === 0) {
    toast('أضف مورداً ومادة أولاً', 'err');
    return;
  }
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>↩️ إرجاع بضاعة إلى مورد</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">المورد *</label><select class="form-control" id="sretSupplier">${state.suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label class="form-label">المادة *</label><select class="form-control" id="sretItem" onchange="sretAutoPrice()">${state.items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></div>
          <div class="grid2">
            <div class="form-group"><label class="form-label">الكمية</label><input type="number" class="form-control is-num" id="sretQty" value="1" oninput="sretUpdatePreview()"></div>
            <div class="form-group"><label class="form-label">الوحدة</label><select class="form-control" id="sretUnit" onchange="sretAutoPrice()"><option value="كيس">كيس</option><option value="كغم">كغم</option><option value="طن">طن</option></select></div>
          </div>
          <div class="form-group"><label class="form-label">تكلفة الوحدة</label><input type="number" class="form-control is-num" id="sretCost" value="0" oninput="sretUpdatePreview()"></div>
          <div class="form-group"><label class="form-label">طريقة التسوية</label><select class="form-control" id="sretMethod"><option value="credit">خصم من رصيد المورد الدائن</option><option value="cash">استرداد نقدي (يدخل الصندوق)</option></select></div>
          <div style="background:var(--bg-raised);padding:10px 14px;border-radius:var(--r-sm);margin-bottom:12px;">المبلغ الإجمالي: <strong class="num" id="sretPreview">0</strong> ${curr()}</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-danger" onclick="saveSupplierReturn()">تأكيد الإرجاع</button>
        </div>
      </div>
    </div>
  `;
  sretAutoPrice();
}

function sretAutoPrice() {
  const itemId = parseInt(document.getElementById('sretItem').value);
  const unit = document.getElementById('sretUnit').value;
  const it = state.items.find(x => x.id === itemId);
  if (!it) return;
  const perKg = it.avg_cost_per_kg || 0;
  const cost = unit === 'كيس' ? perKg * (it.bag_weight || 1) : (unit === 'طن' ? perKg * 1000 : perKg);
  document.getElementById('sretCost').value = cost.toFixed(2);
  sretUpdatePreview();
}

function sretUpdatePreview() {
  const qty = parseFloat(document.getElementById('sretQty').value) || 0;
  const cost = parseFloat(document.getElementById('sretCost').value) || 0;
  document.getElementById('sretPreview').textContent = fmtNum(qty * cost);
}

async function saveSupplierReturn() {
  try {
    await api('POST', '/supplier-returns', {
      supplierId: document.getElementById('sretSupplier').value,
      itemId: document.getElementById('sretItem').value,
      qty: document.getElementById('sretQty').value,
      unit: document.getElementById('sretUnit').value,
      cost: document.getElementById('sretCost').value,
      method: document.getElementById('sretMethod').value
    });
    closeModal();
    toast('تم تسجيل الإرجاع وتحديث المخزون بنجاح', 'ok');
    await loadAllData();
    renderSuppliersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* =========================================================
   BACKUP & AUTO-BACKUP
========================================================= */
function renderBackupScreen() {
  document.getElementById('gdriveClientId').value = state.settings.gdriveClientId || '';
  if (gdriveAccessToken) {
    document.getElementById('gdriveStatus').textContent = '✅ متصل بحساب Google Drive لهذه الجلسة';
    document.getElementById('gdriveActions').style.display = 'block';
  }
  renderAutoBackupsTable();
}

async function renderAutoBackupsTable() {
  const body = document.getElementById('autoBackupsTableBody');
  if (!body) return;
  try {
    const list = await api('GET', '/backup/list');
    if (!list || list.length === 0) {
      body.innerHTML = '<tr><td colspan="3"><div class="empty-state">لا توجد نسخ احتياطية محلية حتى الآن</div></td></tr>';
      return;
    }
    body.innerHTML = list.map(b => `
      <tr>
        <td><strong>${esc(b.filename)}</strong></td>
        <td class="num">${(b.sizeBytes / 1024).toFixed(1)} KB</td>
        <td>${new Date(b.mtime).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'medium' })}</td>
      </tr>
    `).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3" class="empty-state" style="color:var(--danger-text);">تعذر قراءة النسخ الاحتياطية: ${esc(err.message)}</td></tr>`;
  }
}

async function createAutoBackupNow() {
  try {
    const res = await api('POST', '/backup/create');
    toast(`تم إنشاء نسخة احتياطية فورية: ${res.filename}`, 'ok');
    renderAutoBackupsTable();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function downloadSQLBackup() {
  try {
    const { sql, filename } = await api('GET', '/backup/export');
    const blob = new Blob([sql], { type: 'application/sql' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    toast('تم تنزيل النسخة الاحتياطية SQL بنجاح', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function handleSqlImport(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const ok = await confirmDialog(
    'تحذير استيراد قاعدة البيانات',
    'سيتم استبدال وحذف جميع البيانات الحالية بالكامل بمحتوى الملف المختار. لا يمكن التراجع عن هذه الخطوة!',
    'نعم، استيراد واستبدال البيانات'
  );
  if (!ok) {
    ev.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      await api('POST', '/backup/import', { sql: e.target.result });
      toast('تم استيراد قاعدة البيانات بنجاح — جارٍ إعادة تشغيل الواجهة', 'ok');
      await loadAllData();
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  reader.readAsText(file);
  ev.target.value = '';
}

/* GOOGLE DRIVE SYNC */
let gdriveTokenClient = null, gdriveAccessToken = null;
function loadGISScript() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('فشل تحميل مكتبة Google — تحقق من الاتصال بالإنترنت'));
    document.head.appendChild(s);
  });
}

async function saveGDriveClientId() {
  const id = document.getElementById('gdriveClientId').value.trim();
  if (!id) { toast('أدخل معرّف Client ID', 'err'); return; }
  try {
    await api('PUT', '/settings', { gdriveClientId: id });
    state.settings.gdriveClientId = id;
    toast('تم حفظ المعرّف بنجاح', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function connectGoogleDrive() {
  const clientId = state.settings.gdriveClientId || document.getElementById('gdriveClientId').value.trim();
  if (!clientId) { toast('يرجى حفظ معرّف Client ID أولاً', 'err'); return; }
  try {
    await loadGISScript();
    gdriveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (resp) => {
        if (resp.error) { toast('فشل تسجيل الدخول: ' + resp.error, 'err'); return; }
        gdriveAccessToken = resp.access_token;
        document.getElementById('gdriveStatus').textContent = '✅ تم الربط بنجاح بحساب Google Drive';
        document.getElementById('gdriveActions').style.display = 'block';
        toast('تم الاتصال بـ Google Drive بنجاح', 'ok');
      }
    });
    gdriveTokenClient.requestAccessToken();
  } catch (e) { toast(e.message, 'err'); }
}

async function uploadBackupToDrive() {
  if (!gdriveAccessToken) { toast('اربط حساب Google Drive أولاً', 'err'); return; }
  try {
    const { sql, filename } = await api('GET', '/backup/export');
    const metadata = { name: filename, mimeType: 'application/sql' };
    const boundary = '314159265358979323846';
    const delimiter = '\r\n--' + boundary + '\r\n';
    const closeDelim = '\r\n--' + boundary + '--';
    const body = delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(metadata) +
      delimiter + 'Content-Type: application/sql\r\n\r\n' + sql + closeDelim;

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + gdriveAccessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body
    });
    if (!res.ok) throw new Error(await res.text());
    toast('تم رفع النسخة الاحتياطية إلى Google Drive بنجاح', 'ok');
  } catch (e) {
    toast('فشل الرفع إلى Google Drive: ' + e.message, 'err');
  }
}

/* =========================================================
   USERS SCREEN
========================================================= */
async function renderUsersScreen() {
  const users = await api('GET', '/users');
  const body = document.getElementById('usersTableBody');
  body.innerHTML = users.length ? users.map(u => `
    <tr>
      <td><strong>${esc(u.name)}</strong></td>
      <td><span class="badge badge-slate">${esc(u.role)}</span></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick='openUserModal(${u.id},"${esc(u.name)}","${u.role}")'>تعديل</button>
        <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})">حذف</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="3"><div class="empty-state">لا يوجد مستخدمون مسجلون</div></td></tr>';
}

function openUserModal(id, name, role) {
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3>${id ? 'تعديل حساب المستخدم' : 'إضافة مستخدم جديد'}</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">الاسم الكامل *</label><input class="form-control" id="uName" value="${id ? esc(name) : ''}"></div>
          <div class="form-group">
            <label class="form-label">الدور والصلاحية</label>
            <select class="form-control" id="uRole">
              <option ${role === 'محاسب' ? 'selected' : ''}>محاسب</option>
              <option ${role === 'أمين مخزن' ? 'selected' : ''}>أمين مخزن</option>
              <option ${role === 'المالك' ? 'selected' : ''}>المالك</option>
            </select>
          </div>
          <div class="form-group"><label class="form-label">رمز الدخول PIN ${id ? '(اتركه فارغاً للاحتفاظ بالرمز الحالي)' : '*'}</label><input type="password" class="form-control is-num" id="uPassword" placeholder="${id ? '••••••••' : ''}"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button class="btn btn-primary" onclick="saveUser(${id || 'null'})">حفظ المستخدم</button>
        </div>
      </div>
    </div>
  `;
}

async function saveUser(id) {
  const body = { name: document.getElementById('uName').value.trim(), role: document.getElementById('uRole').value };
  const password = document.getElementById('uPassword').value;
  if (password) body.password = password;
  try {
    if (id) await api('PUT', `/users/${id}`, body);
    else await api('POST', '/users', body);
    closeModal();
    toast('تم حفظ المستخدم بنجاح', 'ok');
    renderUsersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deleteUser(id) {
  const ok = await confirmDialog('حذف المستخدم', 'هل تريد بالتأكيد حذف حساب هذا المستخدم؟', 'نعم، حذف');
  if (!ok) return;
  try {
    await api('DELETE', `/users/${id}`);
    toast('تم حذف المستخدم', 'ok');
    renderUsersScreen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* =========================================================
   ACTIVITY LOG SCREEN
========================================================= */
async function renderActivityLogScreen() {
  const log = await api('GET', '/activity-log');
  const body = document.getElementById('activityLogTableBody');
  body.innerHTML = log.length ? log.map(e => `
    <tr>
      <td>${new Date(e.date).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td><strong>${esc(e.user_name) || '-'}</strong></td>
      <td><span class="badge badge-slate">${esc(e.role) || '-'}</span></td>
      <td><span class="badge badge-terra">${esc(e.action)}</span></td>
      <td>${esc(e.details) || '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="5"><div class="empty-state">لا توجد عمليات مسجلة في السجل</div></td></tr>';
}

/* =========================================================
   SETTINGS SCREEN
========================================================= */
function renderSettingsScreen() {
  document.getElementById('setStoreName').value = state.settings.storeName || '';
  document.getElementById('setStorePhone').value = state.settings.storePhone || '';
  document.getElementById('setCurrency').value = state.settings.currency || '';
  const usdInput = document.getElementById('setUsdRate');
  if (usdInput) usdInput.value = state.settings.usdRate || '1530';
  document.getElementById('setDefCredit').value = state.settings.defCredit || '';
  document.getElementById('setLowStock').value = state.settings.lowStock || '';
}

async function saveSettings() {
  try {
    const usdVal = document.getElementById('setUsdRate') ? document.getElementById('setUsdRate').value : '1530';
    await api('PUT', '/settings', {
      storeName: document.getElementById('setStoreName').value.trim(),
      storePhone: document.getElementById('setStorePhone').value.trim(),
      currency: document.getElementById('setCurrency').value.trim(),
      usdRate: usdVal,
      defCredit: document.getElementById('setDefCredit').value,
      lowStock: document.getElementById('setLowStock').value
    });
    toast('تم حفظ الإعدادات بنجاح', 'ok');
    await loadAllData();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* =========================================================
   CURRENCY CONVERTER (IQD / USD)
========================================================= */
function openCurrencyConverterModal() {
  const rate = parseFloat(state.settings.usdRate) || 1530;
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box" style="max-width:440px;">
        <div class="modal-header">
          <h3>💵 محول العملة اليومي (دينار / دولار)</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div style="background:var(--bg-raised);padding:10px 14px;border-radius:var(--r-sm);border:1px solid var(--border-subtle);margin-bottom:14px;font-size:13px;display:flex;justify-content:space-between;align-items:center;">
            <span>سعر الصرف المعتمد (100$):</span>
            <strong class="num" style="color:var(--text-heading);font-size:15px;">${fmtNum(rate * 100)} د.ع</strong>
          </div>
          <div class="form-group">
            <label class="form-label">المبلغ بالدولار الأمريكي ($)</label>
            <input type="number" class="form-control is-num" id="calcUsdInput" placeholder="100" oninput="convertUsdToIqd(this.value)">
          </div>
          <div class="form-group">
            <label class="form-label">المعادل بالدينار العراقي (د.ع)</label>
            <input type="number" class="form-control is-num" id="calcIqdInput" placeholder="${fmtNum(rate * 100)}" oninput="convertIqdToUsd(this.value)">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إغلاق</button>
        </div>
      </div>
    </div>
  `;
}

function convertUsdToIqd(val) {
  const rate = parseFloat(state.settings.usdRate) || 1530;
  const num = parseFloat(val) || 0;
  const iqdEl = document.getElementById('calcIqdInput');
  if (iqdEl) iqdEl.value = Math.round(num * rate);
}

function convertIqdToUsd(val) {
  const rate = parseFloat(state.settings.usdRate) || 1530;
  const num = parseFloat(val) || 0;
  const usdEl = document.getElementById('calcUsdInput');
  if (usdEl) usdEl.value = (num / rate).toFixed(2);
}

/* =========================================================
   WHATSAPP DIRECT SHARING & LEDGER PRINT
========================================================= */
function cleanPhoneForWhatsApp(phone) {
  if (!phone) return '';
  let p = phone.replace(/[^\d+]/g, '');
  if (p.startsWith('07')) p = '964' + p.substring(1);
  else if (p.startsWith('7')) p = '964' + p;
  return p;
}

function printLedgerDocument(type, id) {
  const url = `/print/ledger.html?type=${type}&id=${id}`;
  const win = window.open(url, 'LedgerPrint', 'width=800,height=900,scrollbars=yes');
  if (win) win.focus();
}

async function shareLedgerWhatsApp(type, id) {
  if (type !== 'customer') {
    toast('المشاركة المباشرة مخصصة لحسابات الزبائن', 'info');
    return;
  }
  const c = state.customers.find(x => x.id === Number(id));
  if (!c) return;
  const { rows, balance } = await api('GET', `/customers/${id}/ledger`);
  const storeName = state.settings.storeName || 'نظام إدارة العلوة';

  const lastFew = (rows || []).slice(-5).map(r => `• ${fmtDate(r.date)}: ${r.desc} | مدين: ${r.debit ? fmtNum(r.debit) : 0} | دائن: ${r.credit ? fmtNum(r.credit) : 0}`).join('\n');

  const text = `📊 *كشف حساب مالي - ${storeName}*
*الزبون:* ${c.name} ${c.nickname ? `(${c.nickname})` : ''}
*الرصيد المالي الحالي:* ${fmtNum(Math.abs(balance))} د.ع ${balance > 0 ? '(مطلوب بذمته)' : '(له بذمتنا)'}
-------------------------
*آخر العمليات المسجلة:*
${lastFew || 'لا توجد حركات سابقة'}
-------------------------
يرجى المراجعة والتسديد مع فائق الشكر والتقدير 🙏
_ضمن منظومة زمام الذكية_`;

  const phone = cleanPhoneForWhatsApp(c.phone);
  const url = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank');
}

async function shareInvoiceWhatsApp(invoiceId) {
  try {
    const invoices = await api('GET', '/invoices');
    const inv = invoices.find(x => String(x.id) === String(invoiceId));
    if (!inv) {
      toast('تعذر العثور على الفاتورة في السجل', 'err');
      return;
    }
    const cust = state.customers.find(c => c.id === inv.customer_id) || { name: 'زبون عام', phone: '' };
    const storeName = state.settings.storeName || 'نظام إدارة العلوة';
    const lines = inv.lines || [];

    const linesText = lines.map(l => `• ${l.item_name}: ${l.qty} ${l.unit} × ${fmtNum(l.price)} = ${fmtNum(l.total)} د.ع`).join('\n');

    const text = `🌿 *${storeName}*
🧾 *فاتورة مبيعات رقم:* #${inv.id}
📅 *التاريخ:* ${fmtDate(inv.date)}
👤 *الزبون:* ${cust.name}
${inv.driver_name ? `🚚 *السائق:* ${inv.driver_name}\n` : ''}-------------------------
📦 *المواد والكميات:*
${linesText || 'لا توجد تفاصيل مواد'}
-------------------------
💰 *المجموع الكلي:* ${fmtNum(inv.total)} د.ع
💵 *الواصل (كاش):* ${fmtNum(inv.paid)} د.ع
⏳ *المتبقي بذمة الزبون:* ${fmtNum(inv.remaining)} د.ع
-------------------------
شكراً لتعاملكم معنا 🙏
_ضمن منظومة زمام الذكية_`;

    const targetPhone = cleanPhoneForWhatsApp(cust.phone || inv.driver_phone);
    const url = targetPhone ? `https://wa.me/${targetPhone}?text=${encodeURIComponent(text)}` : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  } catch (err) {
    toast(`فشل مشاركة الفاتورة: ${err.message}`, 'err');
  }
}

/* =========================================================
   SOFT MINIMALIST DARK THEME TOGGLE
========================================================= */
function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  root.setAttribute('data-theme', newTheme);
  localStorage.setItem('alawa_theme', newTheme);
  updateThemeUI(newTheme === 'dark');
}

function updateThemeUI(isDark) {
  const icon = document.getElementById('themeToggleIcon');
  const text = document.getElementById('themeToggleText');
  if (icon) icon.textContent = isDark ? '☀️' : '🌙';
  if (text) text.textContent = isDark ? 'نهاري' : 'ليلي';
}

/* =========================================================
   SHORTCUTS MODAL
========================================================= */
function openShortcutsModal() {
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box" style="max-width:500px;">
        <div class="modal-header">
          <h3>⌨️ دليل اختصارات لوحة المفاتيح</h3>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body" style="padding:16px;">
          <table style="width:100%;">
            <tbody>
              <tr><td style="width:70px;"><span class="kbd">F1</span></td><td><strong>فتح هذا الدليل للمساعدة السريعة</strong></td></tr>
              <tr><td><span class="kbd">F2</span></td><td><strong>حفظ وطباعة الفاتورة الفورية</strong> (أو الانتقال للبيع)</td></tr>
              <tr><td><span class="kbd">F3</span></td><td><strong>التركيز السريع على حقل البحث عن الزبون</strong></td></tr>
              <tr><td><span class="kbd">F4</span></td><td><strong>التركيز السريع على حقل إضافة المواد والباركود</strong></td></tr>
              <tr><td><span class="kbd">F8</span></td><td><strong>تعليق الفاتورة الحالية / استعراض المعلقات</strong></td></tr>
              <tr><td><span class="kbd">F9</span></td><td><strong>حاسبة الأكياس والصناديق وطرح الفارغ</strong></td></tr>
              <tr><td><span class="kbd">Esc</span></td><td><strong>إلغاء وتفريغ الفاتورة / إغلاق النوافذ المنبثقة</strong></td></tr>
            </tbody>
          </table>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">إغلاق</button>
        </div>
      </div>
    </div>
  `;
}

/* =========================================================
   SAFE IN-APP UPDATER (ZIMAM ECOSYSTEM)
========================================================= */
async function checkSystemUpdates() {
  const btn = document.getElementById('updaterCheckBtn');
  const box = document.getElementById('updaterResultBox');
  if (btn) btn.disabled = true;
  if (btn) btn.innerHTML = '<span>⏳</span> جاري الفحص...';

  try {
    const res = await api('GET', '/updater/check');
    box.style.display = 'block';
    if (res.hasUpdate) {
      box.innerHTML = `
        <div style="border-right:4px solid var(--terra-500);padding:10px 14px;background:var(--bg-raised);border-radius:var(--r-xs);margin-bottom:12px;">
          <div style="font-weight:700;font-size:14px;color:var(--text-heading);">✨ يتوفر إصدار جديد: <strong>${esc(res.latestVersion)}</strong></div>
          <div class="sub" style="margin-top:4px;">${esc(res.releaseName)} • تاريخ النشر: ${fmtDate(res.publishedAt)}</div>
          <div style="margin-top:8px;font-size:13px;line-height:1.6;color:var(--text-body);background:var(--bg-card);padding:10px;border-radius:var(--r-xs);border:1px solid var(--border-subtle);">${esc(res.releaseNotes)}</div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-primary" onclick="applySystemUpdate('${esc(res.latestVersion)}')">
            <span>🛡️</span> تطبيق التحديث الآمن (مع نسخة احتياطية فورية)
          </button>
        </div>
      `;
    } else {
      box.innerHTML = `
        <div style="padding:10px;color:var(--success-text);font-weight:600;display:flex;align-items:center;gap:8px;">
          <span>✅</span> <span>${esc(res.message || 'أنت تعمل حالياً بأحدث إصدار متوفر للنظام')}</span>
        </div>
      `;
    }
  } catch (err) {
    box.style.display = 'block';
    box.innerHTML = `<div style="color:var(--danger-text);font-weight:600;">تعذر إتمام الفحص: ${esc(err.message)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
    if (btn) btn.innerHTML = '<span>🔍</span> التحقق من وجود تحديثات';
  }
}

async function applySystemUpdate(ver) {
  const ok = await confirmDialog(
    'تطبيق التحديث الداخلي الآمن',
    `سيقوم النظام تلقائياً بإنشاء نسخة احتياطية وفحص سلامتها (WAL Checkpoint + Integrity Check) قبل تطبيق التحديث ${ver ? 'v' + ver : ''}.\nهل تريد المتابعة؟`,
    'نعم، ابدأ التحديث الآمن',
    false
  );
  if (!ok) return;

  try {
    const res = await api('POST', '/updater/apply');
    toast(res.message || 'تم حفظ النسخة الاحتياطية بنجاح قبل التحديث', 'ok');
    document.getElementById('modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-box" style="max-width:440px;">
          <div class="modal-header">
            <h3>🛡️ تم تأمين البيانات بنجاح</h3>
          </div>
          <div class="modal-body" style="text-align:center;padding:24px 16px;">
            <div style="font-size:36px;margin-bottom:12px;">✅</div>
            <p style="font-weight:700;font-size:14px;color:var(--text-heading);margin-bottom:8px;">${esc(res.message)}</p>
            <p class="sub">تم حفظ ملف الأمان في: <code>${esc(res.backupFile)}</code></p>
          </div>
          <div class="modal-footer" style="justify-content:center;">
            <button class="btn btn-primary" onclick="closeModal(); checkSystemUpdates();">موافق</button>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* =========================================================
   KEYBOARD SHORTCUTS & BARCODE SCANNER INTEGRATION
========================================================= */
document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault();
    openShortcutsModal();
  } else if (e.key === 'F2') {
    e.preventDefault();
    if (!document.getElementById('screen-pos').classList.contains('active')) {
      showScreen('pos');
    } else {
      saveInvoice();
    }
  } else if (e.key === 'F3') {
    e.preventDefault();
    showScreen('pos');
    const el = document.getElementById('posCustSearch');
    if (el) el.focus();
  } else if (e.key === 'F4') {
    e.preventDefault();
    showScreen('pos');
    const el = document.getElementById('posItemSearch');
    if (el) el.focus();
  } else if (e.key === 'F8') {
    e.preventDefault();
    if (document.getElementById('screen-pos').classList.contains('active') && (posInvoice.lines.length > 0 || posInvoice.customerId)) {
      holdCurrentInvoice();
    } else {
      openHeldInvoicesModal();
    }
  } else if (e.key === 'F9') {
    e.preventDefault();
    if (document.getElementById('screen-pos').classList.contains('active') && posInvoice.lines.length > 0) {
      openBagsCalcModal(posInvoice.lines.length - 1);
    }
  } else if (e.key === 'Escape') {
    const root = document.getElementById('modalRoot');
    if (root && root.innerHTML.trim().length > 0) {
      closeModal();
    } else if (document.getElementById('screen-pos').classList.contains('active')) {
      clearPOS();
    }
  }
});

// Barcode keyboard-wedge reader buffer
let barcodeBuffer = '';
let lastKeyTime = 0;

document.addEventListener('keydown', (e) => {
  const activeTag = document.activeElement ? document.activeElement.tagName : '';
  const activeId = document.activeElement ? document.activeElement.id : '';

  // Allow scanner in POS searches or when no input is focused
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
    if (activeId !== 'posItemSearch' && activeId !== 'iBarcode') {
      return;
    }
  }

  const now = Date.now();
  if (now - lastKeyTime > 160) {
    barcodeBuffer = '';
  }
  lastKeyTime = now;

  if (e.key === 'Enter') {
    if (barcodeBuffer.length >= 3) {
      e.preventDefault();
      handleBarcodeScanned(barcodeBuffer);
      barcodeBuffer = '';
    }
  } else if (e.key.length === 1) {
    barcodeBuffer += e.key;
  }
});

function handleBarcodeScanned(code) {
  const clean = code.trim();
  const item = state.items.find(i => (i.barcode && i.barcode.trim() === clean) || String(i.id) === clean);
  if (item) {
    showScreen('pos');
    posAddLine(item.id);
    toast(`تم التعرف على الباركود: ${item.name}`, 'ok');
  } else {
    toast(`لم يتم العثور على مادة بالباركود: ${clean}`, 'err');
  }
}

// Clock updates
function updateClock() {
  const now = new Date();
  const str = now.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
  const el = document.getElementById('topbarClock');
  if (el) el.textContent = str;
}
setInterval(updateClock, 30000);
updateClock();

/* =========================================================
   BOOTSTRAP
========================================================= */
(async function boot() {
  // Initialize stored theme
  const savedTheme = localStorage.getItem('alawa_theme');
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    updateThemeUI(true);
  } else {
    updateThemeUI(false);
  }

  try {
    const me = await api('GET', '/me');
    currentUser = me;
    await afterLogin();
  } catch (e) {
    // Not logged in — default state is login screen
  }
})();
