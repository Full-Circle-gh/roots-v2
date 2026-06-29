/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 08/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: customers (cu*): list/KPIs, detail drawer, edit/block/adjust, addresses, per-customer affiliate block */
// ═══════════════════════════════════════════════════════════════════
// CUSTOMERS TAB — list, detail, edit, block/unblock, force-logout,
//                 points + wallet adjustments
// ═══════════════════════════════════════════════════════════════════
let CUSTOMERS_LOADED = false;
let CU_PAGE = 1;
let CU_PAGE_SIZE = 20;
let CU_TOTAL = 0;
let CU_CURRENT = null;      // detail data for currently-open customer
let CU_ADJUST_KIND = null;  // 'points' | 'wallet'
let cuSearchTimer = null;

function cuSearchDebounced() {
  clearTimeout(cuSearchTimer);
  cuSearchTimer = setTimeout(() => { CU_PAGE = 1; cuLoad(); }, 220);
}

// ── Customers KPI strip — roster pulse on the shared fc-* layer ──────────
// Two cheap fetches: the today dashboard (new_customers + baseline delta +
// hourly sparkline, plus a tiers snapshot whose sum is the non-blocked base)
// and a single customers count (includeBlocked=1, pageSize=1) for the grand
// total. Blocked = total − active base, so no third call is needed.
let _CU_KPI_AT = 0;
let _CU_KPI_DASH = null;
let _CU_KPI_TOTAL = null;
let _CU_KPI_LANG_HOOKED = false;
async function cuLoadKpis(force) {
  if (!document.getElementById('cu-kpis')) return;
  if (!force && Date.now() - _CU_KPI_AT < 45000) return;
  _CU_KPI_AT = Date.now();
  if (!_CU_KPI_LANG_HOOKED && window.onLangChange) { _CU_KPI_LANG_HOOKED = true; onLangChange(cuRepaintKpis); }
  const todayGz = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const [dash, tot] = await Promise.all([
      api(`/api/retail-admin/dashboard?from=${todayGz}&to=${todayGz}`),
      api('/api/retail-admin/customers?includeBlocked=1&pageSize=1'),
    ]);
    _CU_KPI_DASH = dash.data || {};
    _CU_KPI_TOTAL = (tot && typeof tot.total === 'number') ? tot.total : null;
    cuRenderKpis();
  } catch (e) {}
}
function cuRenderKpis() {
  const d = _CU_KPI_DASH; if (!d) return;
  const activeBase = (d.tiers || []).reduce((s, t) => s + Number(t.n || 0), 0);
  const total = _CU_KPI_TOTAL != null ? _CU_KPI_TOTAL : activeBase;
  const blocked = Math.max(0, total - activeBase);
  dashCountUp($('#cu-kpi-total'), total);
  dashCountUp($('#cu-kpi-new'), Number(d.kpis && d.kpis.new_customers || 0));
  dashCountUp($('#cu-kpi-active'), activeBase);
  dashCountUp($('#cu-kpi-blocked'), blocked);
  const bTile = $('#cu-kpi-blocked-tile'); if (bTile) bTile.classList.toggle('alert', blocked > 0);
  cuRepaintKpis();
}
function cuRepaintKpis() {
  const d = _CU_KPI_DASH; if (!d) return;
  const k = d.kpis || {}, b = d.baseline || null, trend = d.trend || [];
  fcSetDelta('#cu-kpi-new-d', b && b.new_customers, Number(k.new_customers || 0), b && b.days,
             v => dashTrim(v) + ' ' + cuT(v === 1 ? 'new customer' : 'new customers', '新客'));
  fcRenderSpark($('#cu-kpi-new-spark'), trend.map(p => Number(p.new_customers || 0)), trend.map(p => p.bucket),
                v => v + ' ' + cuT(v === 1 ? 'signup' : 'signups', '注册'), true);
  const activeBase = (d.tiers || []).reduce((s, t) => s + Number(t.n || 0), 0);
  const total = _CU_KPI_TOTAL != null ? _CU_KPI_TOTAL : activeBase;
  const blocked = Math.max(0, total - activeBase);
  const bsub = $('#cu-kpi-blocked-sub');
  if (bsub) bsub.textContent = blocked > 0 ? cuT('restricted · 受限', '受限账户') : cuT('none blocked · 无封禁', '无封禁');
}
async function cuLoad() {
  const params = new URLSearchParams({
    q: $('#cu-q').value.trim(),
    tier: $('#cu-tier').value,
    sort: $('#cu-sort').value,
    includeBlocked: $('#cu-blocked').checked ? '1' : '0',
    page: CU_PAGE,
    pageSize: CU_PAGE_SIZE
  });
  const tbody = $('#cu-table tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="muted">Loading…</td></tr>';
  let j;
  try {
    const res = await fetch('/api/retail-admin/customers?' + params);
    j = await res.json();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Network error. · 网络错误。</td></tr>';
    if (window.rmRenderCustomerCards) rmRenderCustomerCards(null, 'Network error · 网络错误');
    return;
  }
  if (!j.success) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Failed to load. · 加载失败。</td></tr>';
    if (window.rmRenderCustomerCards) rmRenderCustomerCards(null, 'Failed to load · 加载失败');
    return;
  }
  CU_TOTAL = j.total || 0;
  const rows = j.data || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">No customers found. · 未找到客户。</td></tr>';
  } else {
    tbody.innerHTML = rows.map(r => `
      <tr class="cu-row" data-recency="${cuRecency(r.last_login_at)}" style="cursor: pointer;" onclick="cuOpenDetail(${r.id})">
        <td class="muted">${r.id}</td>
        <td>
          <div style="font-weight: 500;">${r.nickname ? escapeHtml(r.nickname) : '<span class="cu-empty"></span>'}</div>
        </td>
        <td>${escapeHtml(r.phone || '—')}</td>
        <td>
          <span class="cu-pill tier-${escapeHtml(r.tier_key || 'seed')}">${escapeHtml(r.tier_key || 'seed')}</span>
          ${r.is_blocked ? ' <span class="cu-pill blocked">Blocked · 已封禁</span>' : ''}
        </td>
        <td class="numeric cu-num ${(r.orders_count || 0) === 0 ? 'is-zero' : ''}">${r.orders_count || 0}</td>
        <td class="numeric cu-num ${(r.points_balance || 0) === 0 ? 'is-zero' : ''}">${r.points_balance || 0}</td>
        <td class="numeric cu-num ${Number(r.balance || 0) === 0 ? 'is-zero' : ''}">¥${Number(r.balance || 0).toFixed(2)}</td>
        <td class="muted cu-last">${cuFmtTime(r.last_login_at) || '—'}</td>
      </tr>
    `).join('');
  }
  const pages = Math.max(1, Math.ceil(CU_TOTAL / CU_PAGE_SIZE));
  $('#cu-total').textContent = CU_TOTAL ? `${CU_TOTAL} total · 共 ${CU_TOTAL} 位 · page ${CU_PAGE} of ${pages} · 第 ${CU_PAGE}/${pages} 页` : '';
  $('#cu-prev').disabled = CU_PAGE <= 1;
  $('#cu-next').disabled = CU_PAGE >= pages;
  cuViewApply();  // keep the View-tweak classes on #cu-table after each render
  if (window.rmRenderCustomerCards) rmRenderCustomerCards(rows);  // phone card list (same data)
}

// Phone tier-chip filter — drives the existing #cu-tier <select> + cuLoad so
// there's a single filter source of truth (the chip row is CSS-shown only on
// phones; the <select> is shown on desktop).
function cuMobTier(btn, v) {
  const sel = document.getElementById('cu-tier');
  if (sel) sel.value = v;
  const bar = document.getElementById('cu-mob-tiers');
  if (bar) bar.querySelectorAll('.cu-tchip').forEach(b => b.classList.toggle('on', b === btn));
  CU_PAGE = 1;
  cuLoad();
}

function cuPage(d) {
  const pages = Math.max(1, Math.ceil(CU_TOTAL / CU_PAGE_SIZE));
  CU_PAGE = Math.min(pages, Math.max(1, CU_PAGE + d));
  cuLoad();
}

async function cuOpenDetail(id, restore = null) {
  _CDV_OPEN = false;               // View popover starts closed on a fresh open
  const drawer = document.getElementById('cu-drawer');
  const body = document.querySelector('#cu-drawer .drawer-body');
  // Switching customers in an already-open drawer → cross-fade, mirroring the
  // Orders drawer: hold the old content, fade the body out, render the new
  // customer into the hidden body, then fade it back in. A fresh open keeps the
  // drawer slide + per-child settle and shows "Loading…".
  const switching = drawer && drawer.classList.contains('open') && $('#cu-detail-body').children.length > 0;
  const fetchP = fetch('/api/retail-admin/customers/' + id).then(r => r.json());
  if (switching) {
    body.classList.add('cu-swapping');           // fade current customer out
  } else {
    $('#cu-drawer-actions').innerHTML = '';
    $('#cu-detail-body').innerHTML = '<div class="muted" style="padding: var(--s5);">Loading… · 加载中…</div>';
    openDrawer('#cu-drawer');
  }
  let j;
  try {
    // When switching, wait for the fade-out (317ms) and the data together so
    // the new customer lands into a fully-faded, hidden body — a clean
    // cross-fade with no "Loading…" flash between the two records.
    j = switching
      ? (await Promise.all([fetchP, new Promise(r => setTimeout(r, 317))]))[0]
      : await fetchP;
  } catch (e) {
    $('#cu-detail-body').innerHTML = '<div class="muted">Network error. · 网络错误。</div>';
    body.classList.remove('cu-swapping');
    return;
  }
  if (!j.success) {
    $('#cu-detail-body').innerHTML = '<div class="muted">Failed to load customer. · 加载顾客失败。</div>';
    body.classList.remove('cu-swapping');
    return;
  }
  CU_CURRENT = j.data;
  cuRenderDetail();
  if (switching) requestAnimationFrame(() => body.classList.remove('cu-swapping'));  // fade new in
  // Returning from an order opened via a Recent-orders row: expand that ledger
  // (it may be collapsed by default) and restore the prior scroll position so
  // the operator lands on the exact same row they left from.
  if (restore && body) {
    if (restore.openRecent) {
      const fold = body.querySelector('details.cu-fold');   // first fold = Recent orders
      if (fold) fold.open = true;
    }
    requestAnimationFrame(() => { body.scrollTop = restore.scrollTop || 0; });
  }
}

// Jump from a customer's Recent-orders row straight to that order. The
// customer and order drawers share the same z-index and screen position,
// so we close the customer drawer first, then open the order on top of
// the list underneath.
function cuGotoOrder(id) {
  const backId = CU_CURRENT?.customer?.id || null;
  const body = document.querySelector('#cu-drawer .drawer-body');
  _ORDER_BACK_CUSTOMER_SCROLL = body ? body.scrollTop : 0;
  closeDrawer('#cu-drawer');
  openOrder(Number(id));
  // openOrder() clears _ORDER_BACK_CUSTOMER synchronously at its start; set it
  // back afterwards so the order drawer shows a "back to customer" button.
  _ORDER_BACK_CUSTOMER = backId;
}

// Return from an order opened via a Recent-orders row back to that customer,
// landing on the exact same scroll position (and with Recent orders expanded).
function cuBackToCustomer() {
  const backId = _ORDER_BACK_CUSTOMER;
  if (!backId) return;
  const scrollTop = _ORDER_BACK_CUSTOMER_SCROLL;
  closeDrawer('#order-drawer');
  cuOpenDetail(backId, { scrollTop, openRecent: true });
}

// Mobile order-drawer back chevron. When we arrived here from a customer
// (so the redundant in-card "← Back to customer" button is hidden on phones),
// the chevron should return to that customer's detail rather than just closing
// to the order list; otherwise it's a plain close.
function orderDrawerBack() {
  if (_ORDER_BACK_CUSTOMER) { cuBackToCustomer(); return; }
  closeDrawer('#order-drawer');
}

// Jump from an order's Customer tile straight to that customer's detail.
function orderGotoCustomer(id) {
  if (!id) return;
  closeDrawer('#order-drawer');
  cuOpenDetail(Number(id));
}

// Close the drawer and clear state once the slide-out finishes.
onDrawerClose('#cu-drawer', () => {
  $('#cu-detail-body').innerHTML = '';
  $('#cu-drawer-actions').innerHTML = '';
  CU_CURRENT = null;
});
// Backwards-compat shim — older modal save handlers still call
// cuShowList() to return to the list after saving. Now that the list
// is always visible, that just means close the drawer.
function cuShowList() { closeDrawer('#cu-drawer'); }

// ── Customer detail · per-operator View tweaks ────────────────────────
// The Full Circle Customer Detail "Tweaks" panel, made operator-selectable:
// open the Recent-orders ledger by default, and stretch the orders chart
// taller. Persisted to localStorage; defaults match the standard look
// (collapsed ledger, normal chart) so nothing changes until a pick.
const CUSTOMER_DETAIL_TWEAK_DEFAULTS = { recentOpen: false, chartTall: false };
function cdvLoad() {
  try { return { ...CUSTOMER_DETAIL_TWEAK_DEFAULTS, ...(JSON.parse(localStorage.getItem('retail-admin-customer-detail-tweaks') || '{}')) }; }
  catch (e) { return { ...CUSTOMER_DETAIL_TWEAK_DEFAULTS }; }
}
let CDV = cdvLoad();
let _CDV_OPEN = false;
function cdvSet(key, val) {
  CDV[key] = val;
  try { localStorage.setItem('retail-admin-customer-detail-tweaks', JSON.stringify(CDV)); } catch (e) {}
  _CDV_OPEN = true;                        // keep the popover open across the re-render
  // Defer + preserve scroll, same rationale as the order drawer: re-rendering
  // synchronously inside the click detaches the target before the dw-dismiss
  // handler runs, which would then close the whole drawer.
  if (CU_CURRENT) setTimeout(() => {
    if (!CU_CURRENT) return;
    const body = document.querySelector('#cu-drawer .drawer-body');
    const y = body ? body.scrollTop : 0;
    cuRenderDetail();
    if (body) body.scrollTop = y;
  }, 0);
}
function cdvToggle() {
  _CDV_OPEN = !_CDV_OPEN;
  const pop = document.getElementById('cdv-pop'); if (pop) pop.hidden = !_CDV_OPEN;
  if (_CDV_OPEN) setTimeout(() => document.addEventListener('mousedown', cdvOutside), 0);
  else document.removeEventListener('mousedown', cdvOutside);
}
function cdvOutside(e) {
  if (e.target.closest && e.target.closest('.ovp-wrap')) return;
  _CDV_OPEN = false;
  const pop = document.getElementById('cdv-pop'); if (pop) pop.hidden = true;
  document.removeEventListener('mousedown', cdvOutside);
}
function cdvBtn(key, val, label) {
  return `<button class="${CDV[key] === val ? 'active' : ''}" onclick="cdvSet('${key}',${val})">${label}</button>`;
}
function renderCustomerViewPopover() {
  return `
    <div class="ovp-wrap cdv-view-wrap" style="margin-left: auto;">
      <button class="btn btn-sm" id="cdv-btn" onclick="cdvToggle()" aria-haspopup="true" title="Display options · 显示选项">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M4 12h7M4 18h10"/><circle cx="18" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>
        View · 视图
      </button>
      <div id="cdv-pop" class="ovp" ${_CDV_OPEN ? '' : 'hidden'}>
        <div class="ovp-head">Display options · 显示选项</div>
        <div class="ovp-group">
          <div class="ovp-label">Recent orders · 近期订单</div>
          <div class="ovp-seg">
            ${cdvBtn('recentOpen', false, 'Collapsed · 收起')}
            ${cdvBtn('recentOpen', true, 'Open · 展开')}
          </div>
        </div>
        <div class="ovp-group">
          <div class="ovp-label">Chart height · 图表高度</div>
          <div class="ovp-seg">
            ${cdvBtn('chartTall', false, 'Normal · 标准')}
            ${cdvBtn('chartTall', true, 'Tall · 加高')}
          </div>
        </div>
      </div>
    </div>`;
}

// Diagnostics block — "what's happening on this customer's phone". Built from
// the retail_client_logs the mini-app posts (device + app-version snapshot per
// launch, plus any JS crash). This is the fast-triage view for when a customer
// contacts support saying the app is broken: see their exact app build, phone,
// OS, and recent errors instead of guessing. Strings use cuT (one live
// language) per the admin i18n rule — never stacked EN+CN.
function renderDiagnosticsBlock(diag) {
  const dev = diag && diag.device_last_seen;
  const logs = (diag && diag.recent_logs) || [];

  // Device / app-version summary. Empty until the customer opens the build
  // that carries the reporter (mini-app change needs a WeChat publish).
  let deviceHtml;
  if (dev) {
    const row = (label, val) => val
      ? `<div class="cu-kv"><span>${label}</span><b class="is-human">${escapeHtml(String(val))}</b></div>` : '';
    deviceHtml = `
      ${row(cuT('App version', '小程序版本'), dev.app_version)}
      ${row(cuT('Phone', '手机'), dev.device_model)}
      ${row(cuT('System', '系统'), dev.system)}
      ${row(cuT('WeChat', '微信版本'), dev.wx_version)}
      ${row(cuT('Base library', '基础库'), dev.lib_version)}
      ${row(cuT('Last seen', '最近一次'), cuFmtTime(dev.created_at))}`;
  } else {
    deviceHtml = `<div class="muted" style="font-size: 12px;">${cuT(
      'No device data yet. It appears once this customer opens the app build that reports diagnostics (needs a WeChat publish).',
      '暂无设备数据。顾客打开包含诊断上报的版本后才会出现（需先发布微信版本）。')}</div>`;
  }

  const errBadge = (diag && diag.error_count_7d > 0)
    ? `<span class="cu-pill blocked">${diag.error_count_7d} ${cuT('errors in 7 days', '近7天报错')}</span>`
    : `<span class="cu-pill">${cuT('No errors in 7 days', '近7天无报错')}</span>`;

  const logRows = logs.length
    ? logs.map(l => {
        const isErr = l.kind === 'error';
        const detail = [l.stack, l.extra].filter(Boolean).join('\n');
        // The message alone (e.g. a bare "MiniProgramError") is often useless —
        // the real cause is in the stack. Surface it inline, collapsed, instead
        // of hiding it in a hover tooltip support won't find.
        const detailHtml = detail
          ? `<details style="margin-top: var(--s2);"><summary class="muted" style="cursor: pointer; font-size: 12px;">${cuT('stack / details', '堆栈 / 详情')}</summary><pre style="white-space: pre-wrap; word-break: break-word; font-size: 11px; margin: var(--s2) 0 0; max-height: 240px; overflow: auto;">${escapeHtml(detail)}</pre></details>`
          : '';
        return `
        <tr${isErr ? ' style="background: color-mix(in srgb, var(--danger) 7%, transparent);"' : ''}>
          <td class="muted" style="white-space: nowrap;">${cuFmtTime(l.created_at)}</td>
          <td><span class="cu-pill${isErr ? ' blocked' : ''}">${isErr ? cuT('error', '报错') : cuT('open', '启动')}</span></td>
          <td class="muted" style="word-break: break-all;">${escapeHtml(l.page || '—')}</td>
          <td style="word-break: break-word;">${escapeHtml(l.message || (isErr ? '—' : (l.app_version || '—')))}${detailHtml}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="4" class="muted">${cuT('No diagnostics logged yet.', '暂无诊断记录。')}</td></tr>`;

  // Copy-summary button: assembles a plain-text snapshot the operator can
  // paste into a support chat / hand to engineering. Built from the same data.
  return `
    <div style="display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; margin-bottom: var(--s4);">
      ${errBadge}
      <button class="btn btn-sm" onclick="cuCopyDiagnostics()">${cuT('Copy summary', '复制摘要')}</button>
    </div>
    <div class="cu-tile" style="margin-bottom: var(--s5);">
      <div class="cu-tile-head"><span class="cu-tile-title">${cuT('Device & app', '设备与版本')}</span></div>
      ${deviceHtml}
    </div>
    <div class="cu-sec-title" style="margin-bottom: var(--s3);">${cuT('Recent activity & errors (last 25)', '近期活动与报错（最近25条）')}</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>${cuT('When', '时间')}</th>
          <th>${cuT('Kind', '类型')}</th>
          <th>${cuT('Page', '页面')}</th>
          <th>${cuT('Message / version', '信息 / 版本')}</th>
        </tr></thead>
        <tbody>${logRows}</tbody>
      </table>
    </div>`;
}

// Copy a plain-text diagnostic snapshot for the current customer to the
// clipboard — handy to paste into a support thread or send to engineering.
function cuCopyDiagnostics() {
  const d = CU_CURRENT; if (!d) return;
  const c = d.customer || {};
  const diag = d.diagnostics || {};
  const dev = diag.device_last_seen || {};
  const lines = [
    `Customer #${c.id}${c.phone ? ' · ' + c.phone : ''}${c.nickname ? ' · ' + c.nickname : ''}`,
    `App: ${dev.app_version || '—'} · Phone: ${dev.device_model || '—'} · System: ${dev.system || '—'} · WeChat: ${dev.wx_version || '—'}`,
    `Errors (7d): ${diag.error_count_7d || 0} · Active sessions: ${(d.stats && d.stats.active_sessions) || 0}`,
    '',
    'Recent log:',
    ...((diag.recent_logs || []).slice(0, 10).flatMap(l => {
      const head = `  [${cuFmtTime(l.created_at)}] ${l.kind} ${l.page || ''} — ${l.message || l.app_version || ''}`;
      const detail = [l.stack, l.extra].filter(Boolean).join('\n');
      // Indent the stack under its log line so engineering gets the real cause.
      return detail ? [head, ...detail.split('\n').map(s => '      ' + s)] : [head];
    })),
  ];
  const text = lines.join('\n');
  const done = () => (typeof toast === 'function' ? toast(cuT('Diagnostics copied', '诊断已复制')) : null);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => prompt('Copy:', text));
  } else { prompt('Copy:', text); }
}

function cuRenderDetail() {
  const d = CU_CURRENT;
  const c = d.customer;
  const s = d.stats;

  // Drawer action bar — Edit / Block / Force-logout. Block and Force logout
  // are destructive-but-deliberate: Aged Brass ghost (not red), confirmed on
  // click. Unblock reverts to neutral since it isn't destructive.
  const blockLabel = c.is_blocked ? 'Unblock · 解封' : 'Block · 封禁';
  const blockCls   = c.is_blocked ? 'btn' : 'btn btn-brass';
  $('#cu-drawer-actions').innerHTML = `
    <button class="btn" onclick="cuOpenEdit()">Edit profile · 编辑资料</button>
    <button class="btn btn-primary" onclick="cuMessageCustomer()">✉ Message · 发消息</button>
    <button class="${blockCls}" id="cu-block-btn" onclick="cuToggleBlock()">${blockLabel}</button>
    <button class="btn btn-brass" onclick="cuForceLogout()">Sign out all devices · 退出所有设备</button>
    <button class="btn" onclick="cuResetTest()" title="Testing: become a brand-new customer on next app open">Reset to new user (test) · 重置为新用户(测试)</button>
    ${renderCustomerViewPopover()}
  `;

  // 12-month bars — pad missing months with zero
  const today = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const dx = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = dx.getFullYear() + '-' + String(dx.getMonth() + 1).padStart(2, '0');
    const row = d.orders_by_month.find(m => m.month === key);
    months.push({ key, n: row ? row.n : 0, revenue: row ? row.revenue : 0 });
  }
  const maxN = Math.max(1, ...months.map(m => m.n));
  const barMax = CDV.chartTall ? 162 : 110;   // View tweak: taller bars when stretched
  const monthBars = months.map(m => `
    <div class="cu-bar-col" data-m="${m.key}" data-n="${m.n}" data-rev="${Number(m.revenue || 0).toFixed(2)}" onmousemove="cuBarTip(event)" onmouseleave="cuBarTipHide()">
      <div class="cu-bar ${m.n === 0 ? 'empty' : (m.n === maxN ? 'peak' : '')}" style="height: ${m.n === 0 ? 3 : Math.max(8, (m.n / maxN) * barMax)}px;"></div>
      <div class="cu-bar-label">${m.key.slice(5)}</div>
    </div>
  `).join('');

  const topItemsRows = d.top_items.length
    ? d.top_items.map(t => `
        <tr>
          <td>${escapeHtml(t.name_en || t.name_cn || '—')}</td>
          <td class="numeric">${t.qty}</td>
          <td class="numeric">¥${Number(t.spend || 0).toFixed(2)}</td>
        </tr>`).join('')
    : '<tr><td colspan="3" class="muted">No completed orders yet. · 暂无已完成订单。</td></tr>';

  const recentOrdersRows = d.recent_orders.length
    ? d.recent_orders.map(o => `
        <tr class="cu-order-row" tabindex="0" onclick="cuGotoOrder(${o.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();cuGotoOrder(${o.id});}">
          <td>${escapeHtml(o.order_no)}</td>
          <td><span class="cu-pill">${escapeHtml(o.status)}</span></td>
          <td class="numeric">¥${Number(o.total || 0).toFixed(2)}</td>
          <td class="muted">${cuFmtTime(o.created_at)}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No orders yet · 暂无订单</td></tr>';

  const recentPtsRows = d.recent_points.length
    ? d.recent_points.map(p => `
        <tr>
          <td><span class="cu-pill">${escapeHtml(p.source)}</span></td>
          <td class="numeric" style="color: ${p.delta >= 0 ? 'var(--accent)' : 'var(--danger)'}; font-weight: 600;">${p.delta >= 0 ? '+' : ''}${p.delta}</td>
          <td class="numeric">${p.balance_after}</td>
          <td class="muted">${escapeHtml(p.note || '')}</td>
          <td class="muted">${cuFmtTime(p.created_at)}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No points activity · 暂无积分变动</td></tr>';

  const recentTopupsRows = d.recent_topups.length
    ? d.recent_topups.map(t => `
        <tr>
          <td>${paymentBrandHTML(t.payment_method)}</td>
          <td class="numeric">¥${Number(t.amount || 0).toFixed(2)}</td>
          <td class="numeric">+${t.bonus_points || 0} pts · 分</td>
          <td><span class="cu-pill">${escapeHtml(t.status)}</span></td>
          <td class="muted">${cuFmtTime(t.created_at)}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No top-up activity · 暂无充值记录</td></tr>';

  const addressesHtml = d.addresses.length
    ? d.addresses.map(a => `
        <div class="cu-addr">
          <div class="cu-addr-main">
            <div class="cu-addr-id">
              <span class="cu-addr-name">${escapeHtml(a.recipient_name)}</span>
              <span style="color: var(--text-4);">·</span>
              <span class="cu-addr-phone">${escapeHtml(a.phone)}</span>
              ${a.is_default ? '<span class="cu-addr-default">Default · 默认</span>' : ''}
            </div>
            <div class="cu-addr-text">${escapeHtml([a.province, a.city, a.district, a.address, a.detail].filter(Boolean).join(' ')) || '—'}</div>
          </div>
          <div class="cu-addr-acts">
            <button class="btn btn-sm" onclick="cuOpenAddrModal(${a.id})">Edit · 编辑</button>
            <button class="btn btn-sm btn-brass" onclick="cuDeleteAddr(${a.id})">Delete · 删除</button>
          </div>
        </div>`).join('')
    : '<div class="muted" style="font-size: 12px;">No saved addresses. · 暂无收货地址。</div>';

  const avatar = c.avatar_url
    ? `<img src="${escapeHtml(c.avatar_url)}" class="cu-avatar" onerror="this.style.display='none'">`
    : `<div class="cu-avatar"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="4"/><path d="M4 21c1.4-4 4.4-6 8-6s6.6 2 8 6"/></svg></div>`;

  // Defensive guards — the server could omit a key for newly-onboarded
  // customers with no orders/points/topup history. Coerce everything to
  // safe defaults so the template never throws on a missing nested field.
  const ord = (s.orders   || {});
  const pts = (s.points   || {});
  const top = (s.topup    || {});
  const vch = (s.vouchers || {});
  const rev = (s.reviews  || {});
  const sessions = Number(s.active_sessions) || 0;
  $('#cu-detail-body').innerHTML = `
    <div class="cu-identity">
      ${avatar}
      <div style="flex: 1; min-width: 0;">
        <div class="cu-name">${escapeHtml(c.nickname || '—')}</div>
        <div class="cu-id">ID #${c.id}${c.phone ? ' · ' + escapeHtml(c.phone) : ''}${c.email ? ' · ' + escapeHtml(c.email) : ''}</div>
        <div class="cu-tags">
          <span class="cu-pill tier-${escapeHtml(c.tier_key || 'seed')}">${escapeHtml(c.tier_key || 'seed')}</span>
          ${c.is_blocked ? '<span class="cu-pill blocked">Blocked · 已封禁</span>' : ''}
          <span class="cu-pill">Joined · 加入 <span>${cuFmtDate(c.created_at) || '—'}</span></span>
          <span class="cu-pill">Last login · 最近登录 <span>${cuFmtTime(c.last_login_at) || 'never · 从未'}</span></span>
          <span class="cu-pill${sessions >= 5 ? ' brass' : ''}">${sessions} active sessions · 活跃会话</span>
          ${(d.diagnostics && d.diagnostics.device_last_seen && d.diagnostics.device_last_seen.app_version)
            ? `<span class="cu-pill" title="${cuT('Last-seen app build / phone', '最近一次的版本 / 机型')}">${escapeHtml(d.diagnostics.device_last_seen.app_version)}${d.diagnostics.device_last_seen.device_model ? ' · ' + escapeHtml(d.diagnostics.device_last_seen.device_model) : ''}</span>`
            : ''}
        </div>
        <div class="cu-openid" style="margin-top: 14px; word-break: break-all;">openid: ${escapeHtml(c.openid || '')}</div>
      </div>
    </div>

    <div class="cu-grid-stats">
      <div class="cu-tile">
        <div class="cu-tile-head"><span class="cu-tile-title">Orders · 订单</span></div>
        <div class="cu-tile-big">${ord.orders_count || 0}</div>
        <div class="cu-kv"><span>Revenue · 收入</span><b>¥${Number(ord.revenue || 0).toFixed(2)}</b></div>
        <div class="cu-kv"><span>AOV · 客单价</span><b>¥${Number(ord.aov || 0).toFixed(2)}</b></div>
        <div class="cu-kv"><span>Completed · 已完成</span><b class="${(ord.completed_count || 0) > 0 ? 'is-tea' : 'is-zero'}">${ord.completed_count || 0}</b></div>
        <div class="cu-kv"><span>Refunded · 退款</span><b class="${(ord.refunded_count || 0) === 0 ? 'is-zero' : ''}">${ord.refunded_count || 0}</b></div>
        <div class="cu-kv"><span>Cancelled · 已取消</span><b class="${(ord.cancelled_count || 0) === 0 ? 'is-zero' : ''}">${ord.cancelled_count || 0}</b></div>
        <div class="cu-kv"><span>Last order · 最近订单</span><b class="is-human">${ord.days_since_last_order === null || ord.days_since_last_order === undefined ? '—' : ord.days_since_last_order + ' days ago · 天前'}</b></div>
      </div>
      <div class="cu-tile">
        <div class="cu-tile-head">
          <span class="cu-tile-title">Points · 积分</span>
          <button class="btn btn-sm" onclick="cuOpenAdjust('points')">Adjust · 调整</button>
        </div>
        <div class="cu-tile-big">${c.points_balance || 0}</div>
        <div class="cu-kv"><span>Earned (lifetime) · 累计获得</span><b class="${(pts.earned || 0) === 0 ? 'is-zero' : ''}">${pts.earned || 0}</b></div>
        <div class="cu-kv"><span>Redeemed · 已兑换</span><b class="${(pts.redeemed || 0) === 0 ? 'is-zero' : ''}">${pts.redeemed || 0}</b></div>
        <div class="cu-kv"><span>Expired · 已过期</span><b class="${(pts.expired || 0) === 0 ? 'is-zero' : ''}">${pts.expired || 0}</b></div>
        <div class="cu-kv"><span>Admin adjust · 后台调整</span><b class="${(pts.admin_adjust || 0) === 0 ? 'is-zero' : ''}">${pts.admin_adjust >= 0 ? '+' : ''}${pts.admin_adjust || 0}</b></div>
        <div class="cu-kv"><span>Expiring next 30d · 30 天内过期</span><b class="${(pts.expiring_30d || 0) > 0 ? 'is-brass' : 'is-zero'}">${pts.expiring_30d || 0}</b></div>
      </div>
      <div class="cu-tile">
        <div class="cu-tile-head">
          <span class="cu-tile-title">Wallet · 钱包</span>
          <button class="btn btn-sm" onclick="cuOpenAdjust('wallet')">Adjust · 调整</button>
        </div>
        <div class="cu-tile-big">¥${Number(c.balance || 0).toFixed(2)}</div>
        <div class="cu-kv"><span>Topped up (lifetime) · 累计充值</span><b class="${Number(top.topup_total || 0) === 0 ? 'is-zero' : ''}">¥${Number(top.topup_total || 0).toFixed(2)}</b></div>
        <div class="cu-kv"><span>Bonus pts from top-up · 充值赠送积分</span><b class="${(top.bonus_pts_total || 0) === 0 ? 'is-zero' : ''}">${top.bonus_pts_total || 0}</b></div>
        <div class="cu-kv"><span>Admin adjust · 后台调整</span><b class="${Number(top.admin_adjust_total || 0) === 0 ? 'is-zero' : ''}">¥${Number(top.admin_adjust_total || 0).toFixed(2)}</b></div>
        <div class="cu-kv"><span>Vouchers (unused/used) · 优惠券(未用/已用)</span><b class="${(vch.unused || 0) === 0 && (vch.used || 0) === 0 ? 'is-zero' : ''}">${vch.unused || 0} / ${vch.used || 0}</b></div>
        <div class="cu-kv"><span>Reviews · 评价</span><b class="${(rev.count || 0) === 0 ? 'is-zero' : ''}">${rev.count || 0}${rev.avg_rating ? ' · ' + Number(rev.avg_rating).toFixed(1) + '<span class="rv-star">★</span>' : ''}</b></div>
      </div>
    </div>

    <!-- Above the fold: Orders by month chart, Top items, Addresses — these
         stay open because the operator scans them at-a-glance. -->
    <div style="margin-bottom: var(--s7);">
      <div class="cu-sec-title" style="margin-bottom: var(--s3);">Orders by month (last 12) · 月度订单数(近 12 个月)</div>
      <div class="cu-bar-host" style="position: relative;">
        <div class="cu-bar-row${CDV.chartTall ? ' cu-bars-tall' : ''}">${monthBars}</div>
        <!-- tooltip is a body-level singleton (cuBarTip) so the drawer can't crop it -->
      </div>
    </div>

    <div class="cu-detail-pairs">
      <div>
        <div class="cu-sec-title" style="margin-bottom: var(--s3);">Top items · 热销商品</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Item · 商品</th><th class="numeric">Qty · 数量</th><th class="numeric">Spend · 消费</th></tr></thead>
            <tbody>${topItemsRows}</tbody>
          </table>
        </div>
      </div>
      <div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--s3);">
          <div class="cu-sec-title">Addresses · 地址</div>
          <button class="btn btn-sm" onclick="cuOpenAddrModal(null)">+ Add address · 添加地址</button>
        </div>
        ${addressesHtml}
      </div>
    </div>

    <!-- Below the fold: longer ledger-style lists fold into <details>
         accordions, closed by default. Per operator request: recent orders,
         points ledger, top-up ledger, and Affiliate. The chart / top items /
         addresses above DO NOT collapse. -->
    <details class="cu-fold"${(d.diagnostics && d.diagnostics.error_count_7d > 0) ? ' open' : ''}>
      <summary>${cuT('Diagnostics (device & app health)', '诊断（设备与运行状况）')}${(d.diagnostics && d.diagnostics.error_count_7d > 0) ? ' ⚠' : ''}</summary>
      <div class="cu-fold-body">${renderDiagnosticsBlock(d.diagnostics)}</div>
    </details>

    <details class="cu-fold"${CDV.recentOpen ? ' open' : ''}>
      <summary>Recent orders · 近期订单</summary>
      <div class="cu-fold-body">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Order # · 订单号</th><th>Status · 状态</th><th class="numeric">Total · 总额</th><th>When · 时间</th></tr></thead>
            <tbody>${recentOrdersRows}</tbody>
          </table>
        </div>
      </div>
    </details>

    <details class="cu-fold">
      <summary>Points ledger (last 20) · 积分明细(近 20 条)</summary>
      <div class="cu-fold-body">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source · 来源</th><th class="numeric">Δ · 变动</th><th class="numeric">After · 之后</th><th>Note · 备注</th><th>When · 时间</th></tr></thead>
            <tbody>${recentPtsRows}</tbody>
          </table>
        </div>
      </div>
    </details>

    <details class="cu-fold">
      <summary>Top-up ledger (last 10) · 充值明细(近 10 条)</summary>
      <div class="cu-fold-body">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Method · 方式</th><th class="numeric">Amount · 金额</th><th class="numeric">Bonus · 赠送</th><th>Status · 状态</th><th>When · 时间</th></tr></thead>
            <tbody>${recentTopupsRows}</tbody>
          </table>
        </div>
      </div>
    </details>

    <details class="cu-fold">
      <summary>Affiliate · 推广</summary>
      <div class="cu-fold-body">${renderAffiliateBlock(d.affiliate)}</div>
    </details>
  `;
}

// Affiliate block in the customer drawer — code, who referred them,
// and the people they've referred. Edits funnel back to the main
// Affiliate tab; this block is read-only context.
function renderAffiliateBlock(aff) {
  if (!aff) return '';
  const codeHtml = aff.referral_code
    ? `<code>${escapeHtml(aff.referral_code)}</code>`
    : '<span class="muted">(none yet) · 暂无</span>';
  const referredBy = aff.referred_by
    ? `<a href="#" onclick="event.preventDefault(); cuOpenDetail(${aff.referred_by.id})">${escapeHtml(aff.referred_by.nickname || ('#' + aff.referred_by.id))}</a>
       ${aff.referred_by.referral_code ? `<span class="muted" style="margin-left: 8px; font-size: 11px;">via <code>${escapeHtml(aff.referred_by.referral_code)}</code></span>` : ''}`
    : '<span class="muted">— none — · 无</span>';

  const sum = aff.summary || {};
  const invRows = (aff.invites || []).length
    ? aff.invites.map(i => `
        <tr>
          <td><a href="#" onclick="event.preventDefault(); cuOpenDetail(${i.invitee_id})">${escapeHtml(i.invitee_nickname || ('#' + i.invitee_id))}</a><div class="muted" style="font-size: 11px;">${escapeHtml(i.invitee_phone || '')}</div></td>
          <td>${afStatusPill(i.status)}</td>
          <td class="numeric">¥${fmt(i.reward_amount || 0)}</td>
          <td>${escapeHtml(cuFmtDate(i.joined_at) || '')}</td>
          <td>${i.first_paid_order_id ? '#' + i.first_paid_order_id : ''}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No invites yet. · 暂无邀请记录。</td></tr>';

  return `
    <h3>Affiliate · 推广 <span class="muted" style="font-weight: 400; font-size: 12px;">· edit in the Affiliate tab · 在推广标签页编辑</span></h3>
    <div class="row" style="gap: 24px; flex-wrap: wrap; margin-bottom: 12px;">
      <div class="field" style="margin: 0;">
        <label class="stacked">Their code · 本人邀请码</label>
        <div style="font-size: 16px;">${codeHtml}
          <button class="btn btn-sm" style="margin-left: 8px;" onclick="afReissueCode(${CU_CURRENT.customer.id})">Reissue · 重发</button>
        </div>
      </div>
      <div class="field" style="margin: 0;">
        <label class="stacked">Referred by · 推荐人</label>
        <div style="font-size: 13px; padding: 6px 0;">${referredBy}</div>
      </div>
      <div class="field" style="margin: 0;">
        <label class="stacked">Conversions · 转化数</label>
        <div style="font-size: 13px; padding: 6px 0;">${Number(sum.converted || 0)} / ${Number(sum.total || 0)} <span class="muted">· ¥${fmt(sum.earned || 0)} earned · 已赚</span></div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Invitee · 受邀人</th><th>Status · 状态</th><th class="numeric">Reward ¥ · 奖励</th><th>Joined · 加入时间</th><th>First order · 首单</th></tr></thead>
        <tbody>${invRows}</tbody>
      </table>
    </div>
  `;
}

async function afReissueCode(customerId) {
  if (!confirm('Reissue this customer\'s referral code? Existing referrals keep their history; future shares will use the new code. · 重新生成此顾客的邀请码?已有推荐记录保留;以后分享使用新邀请码。')) return;
  try {
    const r = await api('/api/retail-admin/customers/' + customerId + '/referral-code', { method: 'POST' });
    toast('New code · 新邀请码: ' + (r.data?.code || '?'));
    if (CU_CURRENT?.customer?.id === customerId) cuOpenDetail(customerId);
  } catch (e) { toast('Reissue failed · 重发失败: ' + e.message, 'err'); }
}

// These customer pop-ups (.pu-editor-bg, z 300) are authored INSIDE
// <section id="tab-customers">. While that section forms a stacking context
// (its entrance animation/transform), a z-300 modal can't escape it — so it
// paints BEHIND the z-200 customer drawer it was launched from. The modal
// opens, but it's hidden behind the drawer, which reads as "the Edit/Adjust
// button does nothing." Re-parent the modal to <body> on open so it always
// lands in the root stacking context, above the drawer. Same escape hatch the
// body-level chart tooltip (cuBarTip) already uses.
function cuShowModal(sel) {
  const el = $(sel);
  if (!el) return;
  if (el.parentNode !== document.body) document.body.appendChild(el);
  el.classList.add('show');
}

function cuOpenEdit() {
  const c = CU_CURRENT.customer;
  $('#cu-edit-nickname').value = c.nickname || '';
  $('#cu-edit-phone').value    = c.phone || '';
  $('#cu-edit-email').value    = c.email || '';
  $('#cu-edit-gender').value   = c.gender == null ? '' : String(c.gender);
  $('#cu-edit-birthday').value = c.birthday || '';
  // Tier is auto-derived from lifetime_spend — no input here.
  cuShowModal('#cu-edit-bg');
}
function cuCloseEdit() { $('#cu-edit-bg').classList.remove('show'); }

// ── Direct message — operator opens a conversation with this customer ───────
// Reuses the feedback thread tables (POST .../customers/:id/message creates an
// admin-initiated thread + notifies the customer). After sending we jump into
// the existing Feedback thread drawer so the operator can carry on the chat.
function cuMessageCustomer() {
  const c = CU_CURRENT?.customer;
  if (!c) return;
  $('#cu-msg-text').value = '';
  $('#cu-msg-who').textContent = (c.nickname || ('#' + c.id)) + ' · #' + c.id;
  cuShowModal('#cu-msg-bg');
  setTimeout(() => { const t = $('#cu-msg-text'); if (t) t.focus(); }, 60);
}
function cuCloseMsg() { $('#cu-msg-bg').classList.remove('show'); }

async function cuSendMsg() {
  const c = CU_CURRENT?.customer;
  if (!c) return;
  const message = ($('#cu-msg-text').value || '').trim();
  if (!message) { $('#cu-msg-text').focus(); return; }
  try {
    const j = await adminWrite({
      btnId: 'cu-msg-send', url: '/api/retail-admin/customers/' + c.id + '/message',
      method: 'POST', body: { message }, errLabelEn: 'Send failed', errLabelCn: '发送失败',
    });
    cuCloseMsg();
    toast(cuT('Message sent · customer notified', '已发送 · 已通知顾客'), 'ok');
    // Hand off to the Feedback thread drawer so the conversation is visible and
    // the operator can keep replying. Close the customer drawer first so the
    // thread drawer isn't painted behind it (same z-layer).
    const id = j?.data?.id;
    if (id != null && typeof openFeedbackThread === 'function') {
      closeDrawer('#cu-drawer');
      openFeedbackThread(id);
    }
  } catch (e) { /* already toasted by adminWrite */ }
}

// Shared wrapper for ALL retail-admin write paths (Customers, Orders,
// Refunds, Tracking, etc.). Provides:
//   • try/catch so a network failure surfaces as a toast instead of an
//     unhandled rejection that leaves the modal stuck open
//   • busy-state on the trigger button OR an arbitrary element (prevents
//     double-submits + visual "I'm working" cue)
//   • bilingual error messaging
// Usage: adminWrite({ btn, url, method, body, errLabelEn, errLabelCn })
//   - `btn` can be an element, an id string, or undefined (no busy state).
//   - Resolves with the JSON envelope on success; throws on failure
//     (already toasted, caller can `try { ... } catch {}` to swallow).
async function adminWrite({ btn, btnId, url, method = 'POST', body, errLabelEn = 'Failed', errLabelCn = '失败' }) {
  const btnEl = btn instanceof Element ? btn
              : btn ? document.querySelector(btn)
              : btnId ? document.getElementById(btnId)
              : null;
  const restore = btnEl ? btnEl.textContent : null;
  if (btnEl) { btnEl.disabled = true; btnEl.dataset.busy = '1'; btnEl.textContent = '…'; }
  try {
    const opts = { method, headers: body ? { 'Content-Type': 'application/json' } : undefined };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const j = await res.json().catch(() => ({ success: false, error: 'bad_response' }));
    if (!j.success) {
      // Show the server's logical reason, never a bare code. Prefer the human
      // `message`; append the stable `error` code in brackets so it can be
      // quoted in support ("… [use_refund_payout]").
      const code = j.error || 'unknown';
      const reason = j.message ? `${j.message} [${code}]` : code;
      const extra = j.current !== undefined ? ` (current · 当前: ${j.current})` : '';
      toast(`${errLabelEn} · ${errLabelCn}: ${reason}${extra}`, 'err');
      const err = new Error(j.error || 'request_failed');
      err.code = code;
      throw err;
    }
    return j;
  } catch (e) {
    if (!e.message || (e.message !== 'request_failed' && !e.message.startsWith('Error'))) {
      toast(`${errLabelEn} · ${errLabelCn}: ${e.message || 'network'}`, 'err');
    }
    throw e;
  } finally {
    if (btnEl) { btnEl.disabled = false; delete btnEl.dataset.busy; if (restore != null) btnEl.textContent = restore; }
  }
}
// Back-compat alias: Customers drawer used `cuWriteRequest({ btnId, ... })`.
const cuWriteRequest = adminWrite;

async function cuSaveEdit() {
  if (!CU_CURRENT?.customer) return;
  const body = {
    nickname: $('#cu-edit-nickname').value.trim(),
    phone:    $('#cu-edit-phone').value.trim(),
    email:    $('#cu-edit-email').value.trim(),
    gender:   $('#cu-edit-gender').value,
    birthday: $('#cu-edit-birthday').value,
  };
  try {
    await cuWriteRequest({
      btnId: 'cu-edit-save', url: '/api/retail-admin/customers/' + CU_CURRENT.customer.id,
      method: 'PATCH', body, errLabelEn: 'Save failed', errLabelCn: '保存失败',
    });
    toast('Saved · 已保存');
    cuCloseEdit();
    cuOpenDetail(CU_CURRENT.customer.id);
  } catch {}
}

async function cuToggleBlock() {
  if (!CU_CURRENT?.customer) return;
  const c = CU_CURRENT.customer;
  const blocking = !c.is_blocked;
  if (blocking) {
    const reason = prompt('Block this customer? Optional reason for the audit log. · 封禁此顾客?可填写原因(写入审计日志)');
    if (reason === null) return;
    try {
      await cuWriteRequest({
        url: '/api/retail-admin/customers/' + c.id + '/block', method: 'POST',
        body: { reason }, errLabelEn: 'Block failed', errLabelCn: '封禁失败',
      });
      toast('Blocked · 已封禁');
    } catch { return; }
  } else {
    if (!confirm('Unblock this customer? · 解除此顾客的封禁?')) return;
    try {
      await cuWriteRequest({
        url: '/api/retail-admin/customers/' + c.id + '/unblock', method: 'POST',
        errLabelEn: 'Unblock failed', errLabelCn: '解封失败',
      });
      toast('Unblocked · 已解封');
    } catch { return; }
  }
  cuLoadKpis(true);   // blocked/active counts changed — refresh the strip
  cuOpenDetail(c.id);
}

async function cuForceLogout() {
  if (!CU_CURRENT?.customer) return;
  if (!confirm('Sign this customer out on all devices? Active sessions are revoked immediately — useful if a token may be compromised. She can sign back in normally; to lock her out, use Block instead. · 退出该顾客的所有设备?将立即撤销所有活跃会话——令牌可能泄露时适用。她可正常重新登录;如需锁定,请改用封禁。')) return;
  try {
    const j = await cuWriteRequest({
      url: '/api/retail-admin/customers/' + CU_CURRENT.customer.id + '/force-logout', method: 'POST',
      errLabelEn: 'Sign-out failed', errLabelCn: '退出失败',
    });
    const n = j.revoked || 0;
    toast(`Signed out all devices · ${n} session${n === 1 ? '' : 's'} revoked · 已退出所有设备(${n} 个会话)`);
    cuOpenDetail(CU_CURRENT.customer.id);
  } catch {}
}

// TESTING — archives this customer's openid + revokes sessions so the next
// app open on the same phone creates a brand-new customer (fresh onboarding).
// The old row/data is kept (just unreachable by login), not deleted.
async function cuResetTest() {
  if (!CU_CURRENT?.customer) return;
  if (!confirm('TESTING: turn this customer into a brand-new user on next app open? Their openid is archived and sessions revoked — reopening the mini app on that phone creates a fresh account (no orders, points or addresses). The old data is kept but no longer reachable by login. · 测试:下次打开小程序时将此顾客变为全新用户?将归档其 openid 并撤销会话——在该手机上重新打开小程序会创建全新账户(无订单、积分或地址)。原数据保留但登录无法再访问。')) return;
  try {
    await cuWriteRequest({
      url: '/api/retail-admin/customers/' + CU_CURRENT.customer.id + '/reset-test', method: 'POST',
      errLabelEn: 'Reset failed', errLabelCn: '重置失败',
    });
    toast('Reset · reopen the mini app for a fresh user · 已重置,重新打开小程序即为新用户');
    cuOpenDetail(CU_CURRENT.customer.id);
  } catch {}
}

function cuOpenAdjust(kind) {
  if (!CU_CURRENT?.customer) return;
  CU_ADJUST_KIND = kind;
  const c = CU_CURRENT.customer;
  $('#cu-adjust-title').textContent  = kind === 'points'
    ? 'Adjust points balance · 调整积分余额'
    : 'Adjust wallet balance · 调整钱包余额';
  $('#cu-adjust-current').textContent = kind === 'points'
    ? `Current · 当前: ${c.points_balance || 0} pts`
    : `Current · 当前: ¥${Number(c.balance || 0).toFixed(2)}`;
  $('#cu-adjust-delta').value  = '';
  $('#cu-adjust-reason').value = '';
  cuShowModal('#cu-adjust-bg');
}
function cuCloseAdjust() { $('#cu-adjust-bg').classList.remove('show'); }

async function cuSaveAdjust() {
  if (!CU_CURRENT?.customer) return;
  const deltaRaw = Number($('#cu-adjust-delta').value);
  const reason   = $('#cu-adjust-reason').value.trim();
  if (!Number.isFinite(deltaRaw) || deltaRaw === 0) return toast('Enter a non-zero delta · 请填写非零变动量', 'err');
  if (!reason) return toast('Reason is required · 请填写原因', 'err');
  // Points must be integers — reject decimals up front rather than silently
  // truncating (which the server would do anyway but the customer-facing
  // ledger row would then disagree with what the operator typed).
  if (CU_ADJUST_KIND === 'points' && !Number.isInteger(deltaRaw)) {
    return toast('Points must be a whole number · 积分必须是整数', 'err');
  }
  const delta = CU_ADJUST_KIND === 'points' ? Math.trunc(deltaRaw) : deltaRaw;
  const path  = CU_ADJUST_KIND === 'points' ? 'points-adjust' : 'wallet-adjust';
  try {
    await cuWriteRequest({
      btnId: 'cu-adjust-save', url: '/api/retail-admin/customers/' + CU_CURRENT.customer.id + '/' + path,
      method: 'POST', body: { delta, reason }, errLabelEn: 'Adjustment failed', errLabelCn: '调整失败',
    });
    toast('Saved · 已保存');
    cuCloseAdjust();
    cuOpenDetail(CU_CURRENT.customer.id);
  } catch {}
}

let CU_ADDR_EDIT_ID = null;  // null when adding a new address

// 省→市→区 cascade (like the storefront's address picker). Three short
// dependent <select>s — Province filters City filters District — instead of one
// 337-city list. Native selects render as scroll wheels on mobile.

// Fill the Province <select> with the unique provinces from the catalogue.
function cuAddrPopulateProvinces(selectedProvinceCn) {
  const sel = $('#cu-addr-province'); if (!sel) return;
  const seen = new Map();   // province_cn → province_en (first seen)
  for (const c of (_regions.cities || [])) {
    const p = c.province_cn || '';
    if (p && !seen.has(p)) seen.set(p, c.province_en || '');
  }
  let html = '<option value="">— Select province · 选择省份 —</option>';
  for (const [p, en] of seen) {
    html += `<option value="${escapeAttr(p)}">${escapeHtml(p + (en ? ' · ' + en : ''))}</option>`;
  }
  sel.innerHTML = html;
  if (selectedProvinceCn && ![...sel.options].some(o => o.value === selectedProvinceCn)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(selectedProvinceCn)}">${escapeHtml(selectedProvinceCn)}</option>`);
  }
  sel.value = selectedProvinceCn || '';
}

// Fill the City <select> with the cities in the chosen province only.
function cuAddrPopulateCities(provinceCn, selectedCityCn) {
  const sel = $('#cu-addr-city'); if (!sel) return;
  const list = (_regions.cities || []).filter(c => (c.province_cn || '') === provinceCn);
  let html = '<option value="">— Select city · 选择城市 —</option>';
  for (const c of list) {
    html += `<option value="${escapeAttr(c.name_cn)}">${escapeHtml(c.name_cn + (c.name_en ? ' · ' + c.name_en : ''))}</option>`;
  }
  sel.innerHTML = html;
  // Keep a legacy/hand-entered city selectable even if it's not in the catalogue.
  if (selectedCityCn && ![...sel.options].some(o => o.value === selectedCityCn)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(selectedCityCn)}">${escapeHtml(selectedCityCn)}</option>`);
  }
  sel.value = selectedCityCn || '';
}

// Load the district list for the chosen city into the District <select>.
async function cuAddrLoadDistricts(cityCn, selectedDistrictCn) {
  const sel = $('#cu-addr-district'); if (!sel) return;
  if (!cityCn) { sel.innerHTML = '<option value="">— Select district · 选择区/县 —</option>'; return; }
  sel.innerHTML = '<option value="">Loading… · 加载中…</option>';
  let list = [];
  try {
    const r = await fetch('/api/retail/districts?city=' + encodeURIComponent(cityCn), { credentials: 'same-origin' });
    const j = await r.json();
    list = (j && j.data) || [];
  } catch (e) { /* fall through to empty */ }
  let html = '<option value="">— Select district · 选择区/县 —</option>';
  for (const d of list) html += `<option value="${escapeAttr(d.name_cn)}">${escapeHtml(d.name_cn + (d.name_en ? ' · ' + d.name_en : ''))}</option>`;
  sel.innerHTML = html;
  if (selectedDistrictCn) {
    if (![...sel.options].some(o => o.value === selectedDistrictCn)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(selectedDistrictCn)}">${escapeHtml(selectedDistrictCn)}</option>`);
    }
    sel.value = selectedDistrictCn;
  }
}

// Province picked → narrow the city list + reset district.
function cuAddrProvinceChanged() {
  cuAddrPopulateCities($('#cu-addr-province').value, '');
  $('#cu-addr-district').innerHTML = '<option value="">— Select district · 选择区/县 —</option>';
}

// City picked → reload the district list for that city.
function cuAddrCityChanged() {
  cuAddrLoadDistricts($('#cu-addr-city').value, null);
}

async function cuOpenAddrModal(addrId) {
  if (!CU_CURRENT?.customer) return;
  CU_ADDR_EDIT_ID = addrId;
  const a = addrId ? (CU_CURRENT.addresses || []).find(x => x.id === addrId) : null;
  $('#cu-addr-title').textContent      = a ? 'Edit address · 编辑地址' : 'Add address · 新建地址';
  $('#cu-addr-recipient').value        = a ? (a.recipient_name || '') : '';
  $('#cu-addr-phone').value            = a ? (a.phone          || '') : (CU_CURRENT.customer.phone || '');
  $('#cu-addr-address').value          = a ? (a.address        || '') : '';
  $('#cu-addr-detail').value           = a ? (a.detail         || '') : '';
  $('#cu-addr-postal').value           = a ? (a.postal_code    || '') : '';
  $('#cu-addr-default').checked        = a ? !!a.is_default            : false;
  cuShowModal('#cu-addr-bg');
  // Province→city→district cascade. Derive the province from the saved city
  // when an older address only stored city/district.
  const cityCn = a ? (a.city || '') : '';
  await loadChinaRegions();
  const c = _regions.byCn.get(cityCn);
  const provinceCn = a ? (a.province || (c ? c.province_cn : '') || '') : '';
  cuAddrPopulateProvinces(provinceCn);
  cuAddrPopulateCities(provinceCn, cityCn);
  await cuAddrLoadDistricts(cityCn, a ? (a.district || '') : '');
}
function cuCloseAddrModal() { $('#cu-addr-bg').classList.remove('show'); }

async function cuSaveAddr() {
  if (!CU_CURRENT?.customer) return;
  const body = {
    recipient_name: $('#cu-addr-recipient').value.trim(),
    phone:          $('#cu-addr-phone').value.trim(),
    province:       $('#cu-addr-province').value.trim(),
    city:           $('#cu-addr-city').value.trim(),
    district:       $('#cu-addr-district').value.trim(),
    address:        $('#cu-addr-address').value.trim(),
    detail:         $('#cu-addr-detail').value.trim(),
    postal_code:    $('#cu-addr-postal').value.trim(),
    is_default:     $('#cu-addr-default').checked,
  };
  if (!body.recipient_name || !body.phone || !body.address) {
    return toast('Recipient, phone, and street address are required · 收件人、电话、地址必填', 'err');
  }
  const cid = CU_CURRENT.customer.id;
  const url = CU_ADDR_EDIT_ID
    ? `/api/retail-admin/customers/${cid}/addresses/${CU_ADDR_EDIT_ID}`
    : `/api/retail-admin/customers/${cid}/addresses`;
  try {
    await cuWriteRequest({
      btnId: 'cu-addr-save', url, method: CU_ADDR_EDIT_ID ? 'PUT' : 'POST', body,
      errLabelEn: 'Save failed', errLabelCn: '保存失败',
    });
    toast('Saved · 已保存');
    cuCloseAddrModal();
    cuOpenDetail(cid);
  } catch {}
}

async function cuDeleteAddr(addrId) {
  if (!CU_CURRENT?.customer) return;
  if (!confirm('Delete this address? · 删除此地址?')) return;
  const cid = CU_CURRENT.customer.id;
  try {
    await cuWriteRequest({
      url: `/api/retail-admin/customers/${cid}/addresses/${addrId}`, method: 'DELETE',
      errLabelEn: 'Delete failed', errLabelCn: '删除失败',
    });
    toast('Deleted · 已删除');
    cuOpenDetail(cid);
  } catch {}
}

function cuFmtTime(iso) {
  // Single source of truth — Guangzhou (UTC+8) formatting, correct on any
  // machine regardless of the browser's own timezone.
  return formatDate(iso);
}

// Recency bucket for the Last-login highlight tweak: 'today' / 'week' / 'old'.
function cuRecency(iso) {
  if (!iso) return 'old';
  const d = new Date((typeof iso === 'string' && iso.indexOf('T') < 0 ? iso.replace(' ', 'T') + 'Z' : iso));
  if (isNaN(d)) return 'old';
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (d.getTime() >= start.getTime()) return 'today';
  if (Date.now() - d.getTime() <= 7 * 24 * 3600 * 1000) return 'week';
  return 'old';
}

// ── Customers list · per-operator View tweaks (mirrors the Orders pattern) ──
// Imported from the Claude Design Customers List tweaks. Classes ride on
// #cu-table (persists across re-renders) so changes apply live.
const CU_VIEW_DEFAULTS = { badgeStyle: 'pill', recentHighlight: 'today', emptyLabel: 'dash' };
function cuViewLoad() {
  try { return { ...CU_VIEW_DEFAULTS, ...(JSON.parse(localStorage.getItem('retail-admin-customer-tweaks') || '{}')) }; }
  catch (e) { return { ...CU_VIEW_DEFAULTS }; }
}
let CU_VIEW = cuViewLoad();
function cuViewApply() {
  const tbl = document.getElementById('cu-table'); if (!tbl) return;
  tbl.classList.remove('cb-pill', 'cb-square', 'cb-underline', 'cu-rh-off', 'cu-rh-today', 'cu-rh-week', 'ce-dash', 'ce-noname', 'ce-guest');
  tbl.classList.add('cb-' + CU_VIEW.badgeStyle, 'cu-rh-' + CU_VIEW.recentHighlight, 'ce-' + CU_VIEW.emptyLabel);
}
function cuTweakSet(key, val) {
  CU_VIEW[key] = val;
  try { localStorage.setItem('retail-admin-customer-tweaks', JSON.stringify(CU_VIEW)); } catch (e) {}
  cuViewApply();
  cuTweakSyncPanel();
}
function cuTweakSyncPanel() {
  const pop = document.getElementById('cu-view-pop'); if (!pop) return;
  const vals = { badgeStyle: CU_VIEW.badgeStyle, recentHighlight: CU_VIEW.recentHighlight, emptyLabel: CU_VIEW.emptyLabel };
  pop.querySelectorAll('.ovp-seg').forEach(seg => {
    const k = seg.getAttribute('data-tw');
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.getAttribute('data-v') === vals[k]));
  });
}
function cuTweakToggle() {
  const pop = document.getElementById('cu-view-pop'); if (!pop) return;
  if (pop.hidden) { pop.hidden = false; cuTweakSyncPanel(); setTimeout(() => document.addEventListener('mousedown', cuTweakOutside), 0); }
  else { cuTweakClose(); }
}
function cuTweakClose() {
  const pop = document.getElementById('cu-view-pop'); if (pop) pop.hidden = true;
  document.removeEventListener('mousedown', cuTweakOutside);
}
function cuTweakOutside(e) {
  const w = e.target.closest && e.target.closest('.ovp-wrap');
  if (!w) cuTweakClose();
}

function cuFmtDate(iso) {
  if (!iso) return '';
  const d = new Date((typeof iso === 'string' && iso.indexOf('T') < 0 ? iso.replace(' ', 'T') + 'Z' : iso));
  if (isNaN(d)) return String(iso);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

document.querySelector('[data-tab="customers"]').addEventListener('click', () => {
  if (!CUSTOMERS_LOADED) { CUSTOMERS_LOADED = true; cuLoad(); }
  cuLoadKpis();   // throttled (45s) — keeps the New-today pulse fresh on open
});

