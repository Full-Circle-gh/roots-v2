/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 04/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: Orders: list/filters/KPIs, pollers + badges + chime, order drawer, shipments/tracking/split, refunds */
// ════════════════════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════════════════════
function setOrderStatus(chip) {
  const value = chip.dataset.status || '';
  $('#orders-status').value = value;
  $$('#orders-status-chips .status-chip').forEach(el => el.classList.toggle('active', el === chip));
  loadOrders();
}
let _ordersSearchTimer = null;
function debouncedLoadOrders() {
  clearTimeout(_ordersSearchTimer);
  _ordersSearchTimer = setTimeout(loadOrders, 350);
}

// ── Auto-refresh state ─────────────────────────────────────────────────
// The Orders tab polls /api/retail-admin/orders every ORDERS_POLL_MS so
// new orders appear on staff screens without anyone clicking refresh.
// Fingerprint check skips DOM rebuilds when nothing changed — no flicker.
// We also remember the set of order IDs we've already shown so we can
// flash + toast genuinely-new arrivals (vs. the first paint).
const ORDERS_POLL_MS = 12000;
let _ORDERS_AUTO_TIMER = null;
let _ORDERS_LAST_FP = null;
let _ORDERS_LAST_FP_KEY = '';        // filter signature for the FP
let _ORDERS_SEEN_IDS = null;         // null = first-paint baseline not set
// IDs we've already chimed/toasted for. Tracks "became actionable (paid)",
// NOT "row first appeared" — an order lands as pending_payment (silent, no
// chime/mark) and only counts as an arrival once it flips to paid+, which
// is when there's actually something to process.
let _ORDERS_NOTIFIED_IDS = null;     // null = first-paint baseline not set
let _ORDERS_IN_FLIGHT = false;
let _ORDERS_LAST_OK_AT = 0;
let _ORDERS_LIVE_PAUSED = false;
// Monotonic request token. Every loadOrders call grabs the next id; after
// its fetch resolves, it renders only if its id still equals the current
// counter. Otherwise a newer call has started (e.g. user clicked a chip
// while a 12s poller fetch was mid-flight) and its stale result would
// clobber the new filter — drop it on the floor instead.
let _ORDERS_REQ_ID = 0;

// Cheap fingerprint — id + status + tracking + refund + updated_at for
// each row. Catches new orders, status changes, and refund transitions.
function _ordersFp(rows) {
  let s = rows.length + '|';
  for (const r of rows) {
    s += r.id + ':' + (r.status||'') + ':'
       + (r.refund_status||'') + ':'
       + (r.tracking_number||'') + ':'
       + (r.local_eta||'') + ':'
       + (r.updated_at || r.placed_at || '') + ',';
  }
  return s;
}

function _ordersFilterKey() {
  return [
    $('#orders-status').value,
    $('#orders-q').value.trim(),
    (document.getElementById('orders-store') || {}).value || '',
  ].join('|');
}

// Refund-pipeline badge — surfaces open refund requests on every row,
// regardless of the active status filter. Without this, paid/delivered
// orders with pending refunds were only visible from the Refund queue
// chip. `paid` is the terminal refunded state on this column, distinct
// from order.status='paid'.
function refundBadge(o) {
  const rs = o.refund_status;
  if (!rs || rs === 'withdrawn' || rs === 'rejected') return '';
  if (rs === 'paid') {
    return `<span class="pill refund-pending" title="Refund paid · 已退款">↩ refunded · 已退款</span>`;
  }
  const labels = {
    pending:   'refund req · 申请退款',
    reviewing: 'reviewing · 处理中',
    approved:  'approved · 已批准',
  };
  const label = labels[rs] || rs;
  return `<span class="pill refund-pending" title="Open refund · 退款进行中 (${rs})">↩ ${label}</span>`;
}

// Big, hard-to-miss banner at the top of the order drawer. Surfaces the
// fact that this order has an open refund request even when the order's
// primary status (Delivered, Paid, …) looks unremarkable. Skipped when
// the request is closed (withdrawn / rejected) or the order is fully
// refunded — in those cases the order's primary status conveys it.
function drawerRefundBanner(o) {
  const rs = o.refund_status;
  if (!rs || rs === 'withdrawn' || rs === 'rejected' || rs === 'paid') return '';
  const labels = {
    pending:   { en: 'Refund requested',         cn: '客户已申请退款' },
    reviewing: { en: 'Refund under review',      cn: '退款审核中' },
    approved:  { en: 'Refund approved — pay out',cn: '退款已批准 · 待打款' },
  };
  const l = labels[rs] || { en: `Refund · ${rs}`, cn: '' };
  const amt = (o.refund_amount_requested != null && Number(o.refund_amount_requested) > 0)
    ? cuT(`¥${fmt(o.refund_amount_requested)} of ¥${fmt(o.total)}`, `¥${fmt(o.refund_amount_requested)} / 共 ¥${fmt(o.total)}`)
    : cuT(`full ¥${fmt(o.total)}`, `全额 ¥${fmt(o.total)}`);
  const when = o.refund_requested_at ? ` · ${cuT('requested', '申请于')} ${formatDate(o.refund_requested_at)}` : '';
  return `
    <div class="drawer-refund-banner" data-state="${rs}" role="status">
      <span class="arrow">↩</span>
      <div class="label">
        <span>${l.en} · ${l.cn}</span>
        <span class="sub">${amt}${when}</span>
      </div>
    </div>`;
}

// Split-package suggestion banner — appears above the Items section in the
// Orders drawer when buildShipmentSuggestion (server-side) returns
// eligible:true. Bilingual EN · 中文, with per-bucket cost detail. Apply
// re-buckets items between the order's shipments via POST .../apply.
function splitSuggestionBanner(o) {
  const sug = o.shipment_suggestion;
  if (!sug || !sug.eligible) return '';
  const grams = (g) => g >= 1000 ? `${(g/1000).toFixed(1)} kg` : `${g} g`;
  const bucket = (b) => {
    const cls = b.mode === 'air' ? 'air' : 'land';
    const icon = shipGlyph(b.mode === 'air' ? 'air' : 'land');
    const labelEn = b.mode === 'air' ? 'Air package' : 'Land package';
    const labelCn = b.mode === 'air' ? '空运包裹' : '陆运包裹';
    return `
      <div class="ss-bucket ${cls}">
        <div class="bk-head">
          <span>${icon} ${labelEn} · ${labelCn}</span>
          <span class="bk-cost">¥${fmt(b.cost)}</span>
        </div>
        <div class="bk-meta">${b.item_ids.length} items · ¥${fmt(b.value)} · ${grams(b.grams)}</div>
      </div>`;
  };
  const detail = sug.suggested.plan.map(bucket).join('');
  return `
    <div class="split-suggestion" data-order="${o.id}" role="status">
      <div class="ss-head">
        <div class="ss-title">
          <span>📦 Suggested: split into 2 packages · 拆分为 2 个包裹</span>
          <span class="save">save ¥${fmt(sug.savings)} · 节省 ¥${fmt(sug.savings)}</span>
        </div>
        <div class="ss-actions">
          <button class="btn btn-primary btn-sm" onclick="applySplitSuggestion(${o.id})">Apply · 拆分</button>
          <button class="btn btn-sm" onclick="dismissSplitSuggestion(${o.id})">Dismiss · 忽略</button>
        </div>
      </div>
      <div class="ss-subtitle">Current freight ¥${fmt(sug.current.cost)} → split freight ¥${fmt(sug.suggested.cost)} · 当前 ¥${fmt(sug.current.cost)} → 拆后 ¥${fmt(sug.suggested.cost)}</div>
      <div class="ss-detail">${detail}</div>
    </div>`;
}

// In-memory dismissal — banner reappears after a page reload, which is
// fine: it's a hint, not a persisted decision.
const _DISMISSED_SPLIT = new Set();
function dismissSplitSuggestion(orderId) {
  _DISMISSED_SPLIT.add(orderId);
  const el = document.querySelector(`.split-suggestion[data-order="${orderId}"]`);
  if (el) el.remove();
}
async function applySplitSuggestion(orderId) {
  const btn = document.querySelector(`.split-suggestion[data-order="${orderId}"] .btn-primary`);
  if (btn) { btn.disabled = true; btn.textContent = 'Applying …'; }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/shipment-suggestion/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) {
      const reason = data.reason || data.error || 'unknown';
      toast(`Couldn't apply split · 拆分失败 (${reason})`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Apply · 拆分'; }
      return;
    }
    toast('Split applied · 拆分完成', 'success');
    openOrder(orderId); // re-render drawer with new shipments
  } catch (e) {
    toast(`Network error · 网络错误`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Apply · 拆分'; }
  }
}

// ── Combine / split parcels ────────────────────────────────────────────
// The system splits out-of-Guangzhou orders into Air + Land parcels, but the
// operator sometimes packs everything in one box. These let them collapse the
// split to ONE parcel (so the customer tracks a single shipment) and undo it.
// Both are offered ONLY while no parcel has a waybill yet — afterwards the
// server refuses (combining would strand a created label). A combined parcel
// carries the '合并发货' label, which is how we detect it to offer "split again".
function shipmentMergeControls(o) {
  const ships = o.shipments || [];
  const hasTracking = ships.some(s => s.tracking_number || s.tracking_carrier);
  const combined = ships.length === 1 && (ships[0].label || '').includes('合并');
  if (hasTracking) {
    // Waybill attached → locked. A short hint only where a split still shows.
    return ships.length > 1
      ? `<div style="margin-top:6px; font-size:11px; color:var(--text-3);">${cuT('Clear the waybills to combine into one parcel', '清除运单后才能合并为一个包裹')}</div>`
      : '';
  }
  if (ships.length > 1) {
    return `<div style="margin-top:8px;"><button class="btn btn-sm" onclick="combineParcels(${o.id})">${cuT('Combine into one parcel', '合并为一个包裹')}</button></div>`;
  }
  if (combined) {
    return `<div style="margin-top:8px;"><button class="btn btn-sm" onclick="splitParcels(${o.id})">${cuT('Split into separate parcels', '拆分为多个包裹')}</button></div>`;
  }
  return '';
}
async function combineParcels(orderId) {
  if (!confirm(cuT('Combine all parcels into one shipment? The customer will track a single parcel.', '将所有包裹合并为一个发货?顾客将只追踪一个包裹。'))) return;
  try {
    await adminWrite({ url: `/api/retail-admin/orders/${orderId}/shipments/combine`, method: 'POST', errLabelEn: 'Combine failed', errLabelCn: '合并失败' });
    toast(cuT('Combined into one parcel', '已合并为一个包裹'));
    openOrder(orderId); loadOrders();
  } catch {}
}
async function splitParcels(orderId) {
  if (!confirm(cuT('Split back into separate Air / Land parcels?', '拆分回独立的空运 / 陆运包裹?'))) return;
  try {
    await adminWrite({ url: `/api/retail-admin/orders/${orderId}/shipments/split`, method: 'POST', errLabelEn: 'Split failed', errLabelCn: '拆分失败' });
    toast(cuT('Split into separate parcels', '已拆分为多个包裹'));
    openOrder(orderId); loadOrders();
  } catch {}
}

// ── Address → Chinese ──────────────────────────────────────────────────
// Turn an English / mixed shipping address into a clean Chinese one for the
// waybill. Fetches an AI-translated + geocode-verified proposal, shows it in an
// editable confirm dialog, then writes it back to the order (and, optionally,
// the customer's saved address for future orders).
async function openAddressToChinese(orderId) {
  toast(cuT('Translating address…', '正在翻译地址…'));
  let data;
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/address/to-chinese`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      const err = j.error || 'failed';
      toast(err === 'ai_not_configured' ? cuT('Translation service is off', '翻译服务未启用')
          : err === 'pickup_order' ? cuT('Pickup order — no shipping address', '自提订单 — 无收货地址')
          : cuT('Couldn’t translate the address', '地址翻译失败'), 'error');
      return;
    }
    data = j.data;
  } catch (e) { toast(cuT('Network error', '网络错误'), 'error'); return; }

  const c = data.chinese || {};
  const geoBadge = !data.geocode_configured ? ''
    : data.geocode_ok
      ? `<span style="margin-left:8px; font-size:11px; font-weight:600; color:#5fc28e;">✓ ${cuT('resolves on map', '地图可定位')}</span>`
      : `<span style="margin-left:8px; font-size:11px; font-weight:600; color:var(--warn);">⚠ ${cuT('couldn’t verify on map', '无法在地图核验')}</span>`;
  const field = (id, labelEn, labelCn, val) => `
    <div class="field" style="margin-bottom:10px;">
      <label class="stacked">${labelEn} · ${labelCn}</label>
      <input id="${id}" type="text" style="width:100%;" value="${escapeHtml(val || '')}">
    </div>`;

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 520px; max-width: 94vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin:0; font-size:14px;">${cuT('Make address Chinese', '转为中文地址')}</h3>
          <div class="muted" style="font-size:11px; margin-top:2px;">${cuT('Check the Chinese address, edit if needed, then save.', '请核对中文地址,如需可修改,然后保存。')}</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Close', '关闭')}</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding:18px; display:block;">
        <div style="background:var(--bg-elev-1); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:14px;">
          <div class="muted" style="font-size:10px; letter-spacing:.08em; text-transform:uppercase;">${cuT('As entered', '原始地址')}</div>
          <div style="font-size:12px; color:var(--text-2); line-height:1.5; margin-top:2px;" data-no-i18n>${escapeHtml(data.original_full || '')}</div>
        </div>
        <div style="font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--brass); margin-bottom:10px;">${cuT('Chinese address', '中文地址')}${geoBadge}</div>
        ${field('gz-prov', 'Province', '省 / 市', c.province)}
        ${field('gz-city', 'City', '市', c.city)}
        ${field('gz-dist', 'District', '区 / 县', c.district)}
        ${field('gz-addr', 'Street / building', '街道 / 楼栋', c.address)}
        ${field('gz-detail', 'Unit / floor (optional)', '单元 / 楼层(可选)', c.detail)}
        <label style="display:flex; align-items:center; gap:8px; font-size:12px; margin:6px 0; cursor:pointer;"><input type="checkbox" id="gz-save-order" checked> ${cuT('Update this order (prints on the waybill)', '更新此订单(用于运单打印)')}</label>
        <label style="display:flex; align-items:center; gap:8px; font-size:12px; margin:6px 0; cursor:pointer;"><input type="checkbox" id="gz-save-cust" checked> ${cuT('Also fix the customer’s saved address', '同时更新顾客保存的地址')}</label>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
          <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Cancel', '取消')}</button>
          <button class="btn btn-primary" id="gz-apply">${cuT('Save', '保存')}</button>
        </div>
      </div>
    </div>`;
  mountFloatingPuModal(bg);
  bg.querySelector('#gz-apply').addEventListener('click', async (ev) => {
    const body = {
      province: bg.querySelector('#gz-prov').value,
      city:     bg.querySelector('#gz-city').value,
      district: bg.querySelector('#gz-dist').value,
      address:  bg.querySelector('#gz-addr').value,
      detail:   bg.querySelector('#gz-detail').value,
      save_order:    bg.querySelector('#gz-save-order').checked,
      save_customer: bg.querySelector('#gz-save-cust').checked,
    };
    if (!body.save_order && !body.save_customer) { toast(cuT('Pick at least one place to save', '请至少选择一处保存'), 'error'); return; }
    if (!body.address.trim()) { toast(cuT('Street / building is required', '街道 / 楼栋不能为空'), 'error'); return; }
    try {
      const j = await adminWrite({
        btn: ev.currentTarget, url: `/api/retail-admin/orders/${orderId}/address/apply-chinese`,
        method: 'POST', body, errLabelEn: 'Save failed', errLabelCn: '保存失败',
      });
      const d = (j && j.data) || {};
      let msg = cuT('Address updated', '地址已更新');
      if (body.save_customer && !d.saved_customer) {
        const why = d.customer_reason === 'no_match' ? cuT('couldn’t match the saved address', '未找到对应的保存地址')
                  : d.customer_reason === 'no_customer' ? cuT('no customer on file', '无顾客记录')
                  : cuT('saved address not updated', '保存地址未更新');
        msg = cuT('Order updated · ', '订单已更新 · ') + why;
      }
      toast(msg);
      bg.remove();
      openOrder(orderId); loadOrders();
    } catch {}
  });
}

// `silent` = called by the poller. Skip the "Loading…" placeholder, skip
// the rebuild when the fingerprint matches, flash new rows on arrival.
// ── Orders view options (tweaks) ──────────────────────────────────────
// Per-operator display preferences for the orders table: status signaling,
// row rhythm and type character. Theme rides the global retail-admin theme.
// Applied as classes on #orders-table (which persists across tbody re-renders)
// + scoped CSS, so the row template never has to know about them.
const ORDER_TWEAK_DEFAULTS = { statusStyle: 'pill', rowTreat: 'hairlines', typeMode: 'mixed' };
function ordTweaksLoad() {
  try { return { ...ORDER_TWEAK_DEFAULTS, ...(JSON.parse(localStorage.getItem('retail-admin-order-tweaks') || '{}')) }; }
  catch (e) { return { ...ORDER_TWEAK_DEFAULTS }; }
}
let ORD_TWEAKS = ordTweaksLoad();
function ordTweaksApply() {
  const tbl = document.getElementById('orders-table'); if (!tbl) return;
  tbl.classList.remove('os-pill', 'os-bar', 'os-glyph', 'rt-hairlines', 'rt-striped', 'rt-cards', 'tm-mixed', 'tm-mono-heavy', 'tm-all-mono');
  tbl.classList.add('os-' + ORD_TWEAKS.statusStyle, 'rt-' + ORD_TWEAKS.rowTreat, 'tm-' + ORD_TWEAKS.typeMode);
}
function ordTweakSet(key, val) {
  if (key === 'theme') { cuSetTheme(val); ordTweakSyncPanel(); return; }
  ORD_TWEAKS[key] = val;
  try { localStorage.setItem('retail-admin-order-tweaks', JSON.stringify(ORD_TWEAKS)); } catch (e) {}
  ordTweaksApply();
  ordTweakSyncPanel();
}
function ordTweakSyncPanel() {
  const pop = document.getElementById('ord-view-pop'); if (!pop) return;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const vals = { theme, statusStyle: ORD_TWEAKS.statusStyle, rowTreat: ORD_TWEAKS.rowTreat, typeMode: ORD_TWEAKS.typeMode };
  pop.querySelectorAll('.ovp-seg').forEach(seg => {
    const key = seg.getAttribute('data-tw');
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.getAttribute('data-v') === vals[key]));
  });
}
function ordTweakToggle() {
  const pop = document.getElementById('ord-view-pop'); if (!pop) return;
  if (pop.hidden) {
    pop.hidden = false;
    ordTweakSyncPanel();
    setTimeout(() => document.addEventListener('mousedown', ordTweakOutside), 0);
  } else { ordTweakClose(); }
}
function ordTweakClose() {
  const pop = document.getElementById('ord-view-pop'); if (pop) pop.hidden = true;
  document.removeEventListener('mousedown', ordTweakOutside);
}
function ordTweakOutside(e) {
  const wrap = e.target.closest && e.target.closest('.ovp-wrap');
  if (!wrap) ordTweakClose();
}

// ── Orders KPI strip — today's pulse (shared fc-* layer) ────────────────────
// Reuses /dashboard?from=today&to=today (the same call the dashboard hero
// makes), so there's no new backend. Throttled so the orders poller can ping it
// cheaply; force=true bypasses the throttle (tab open / manual Refresh).
let _ORD_KPI_AT = 0;
let _ORD_KPI_DATA = null;
let _ORD_KPI_LANG_HOOKED = false;
let _ORD_TABLE_LANG_HOOKED = false;
// The row cells bake their language at render time (cuT() returns one string,
// localizeSlotLabel() reads the current lang once). Toggling EN/CN afterwards
// only swaps DOM-classifier "en · cn" text nodes, leaving cuT()/localized cells
// frozen in the old language. Re-render the rows on a toggle so the whole table
// follows. Cheap: a silent refetch (same call the poller makes) with the
// fingerprint cleared to force the rebuild.
function _ordRepaintOnLang() {
  if (!document.getElementById('orders-table')) return;
  _ORDERS_LAST_FP = null;
  loadOrders({ silent: true });
}
async function ordLoadKpis(force) {
  if (!document.getElementById('ord-kpis')) return;
  if (!force && Date.now() - _ORD_KPI_AT < 45000) return;
  _ORD_KPI_AT = Date.now();
  // Re-render the language-dependent bits (delta words, spark tip labels) on a
  // language toggle, without refetching. Registered lazily so window.onLangChange
  // (defined later in the i18n module) exists by the time we wire it.
  if (!_ORD_KPI_LANG_HOOKED && window.onLangChange) { _ORD_KPI_LANG_HOOKED = true; onLangChange(ordRepaintKpiLabels); }
  const todayGz = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const j = await api(`/api/retail-admin/dashboard?from=${todayGz}&to=${todayGz}`);
    _ORD_KPI_DATA = j.data || {};
    ordRenderKpis();
  } catch (e) { /* silent — the table is the source of truth; KPIs are a bonus */ }
}
function ordRenderKpis() {
  const data = _ORD_KPI_DATA; if (!data) return;
  const k = data.kpis || {};
  const orders = Number(k.orders || 0), revenue = Number(k.revenue || 0);
  dashCountUp($('#ord-kpi-orders'), orders);
  dashCountUp($('#ord-kpi-rev'), revenue, n => '¥' + Math.round(n).toLocaleString());
  $('#ord-kpi-aov').textContent = orders ? '¥' + Math.round(revenue / orders).toLocaleString() : '—';
  $('#ord-kpi-new').textContent = fcNum(k.new_customers || 0);
  ordRepaintKpiLabels();   // deltas + sparklines (language-aware)
}
// Language-dependent half — delta badges (the "new" word) and sparkline tip
// labels. Split out so a language toggle reflows wording without re-animating
// the headline numbers.
function ordRepaintKpiLabels() {
  const data = _ORD_KPI_DATA; if (!data || !document.getElementById('ord-kpis')) return;
  const k = data.kpis || {}, b = data.baseline || null;
  fcSetDelta('#ord-kpi-orders-d', b && b.orders,        Number(k.orders || 0),        b && b.days, v => dashTrim(v) + ' ' + cuT(v === 1 ? 'order' : 'orders', '单'));
  fcSetDelta('#ord-kpi-rev-d',    b && b.revenue,       Number(k.revenue || 0),       b && b.days, v => '¥' + Math.round(v).toLocaleString());
  fcSetDelta('#ord-kpi-new-d',    b && b.new_customers, Number(k.new_customers || 0), b && b.days, v => dashTrim(v) + ' ' + cuT(v === 1 ? 'new customer' : 'new customers', '新客'));
  const trend = data.trend || [];
  const labels = trend.map(p => String(p.bucket || ''));
  fcRenderSpark($('#ord-kpi-orders-spark'), trend.map(p => Number(p.orders || 0)),  labels, v => v + ' ' + cuT(v === 1 ? 'order' : 'orders', '单'), false);
  fcRenderSpark($('#ord-kpi-rev-spark'),    trend.map(p => Number(p.revenue || 0)), labels, v => '¥' + Math.round(v).toLocaleString(), true);
}

async function loadOrders(opts = {}) {
  const silent = !!opts.silent;

  // Repaint the rows on a language toggle (cuT()/localizeSlotLabel cells freeze
  // their language at render time). Registered lazily — onLangChange lives in
  // the i18n module loaded later.
  if (!_ORD_TABLE_LANG_HOOKED && window.onLangChange) { _ORD_TABLE_LANG_HOOKED = true; onLangChange(_ordRepaintOnLang); }

  // Bail mid-tick if a manual reload is already in flight — prevents the
  // poller from clobbering the user's freshly-clicked Refresh.
  if (silent && _ORDERS_IN_FLIGHT) return;
  _ORDERS_IN_FLIGHT = true;
  const myReq = ++_ORDERS_REQ_ID;

  try {
    const status   = $('#orders-status').value;
    const q        = $('#orders-q').value.trim();
    const storeSel = document.getElementById('orders-store');
    const storeId  = storeSel ? storeSel.value : '';

    // Refund queue chip is just a filter — keep the standard columns so
    // staff see the orders alongside their normal context (ship-by,
    // tracking, total). The backend treats `status=refunds_open` as the
    // pseudo-filter `refund_status IN ('pending','reviewing','approved')`.

    const qs = new URLSearchParams();
    if (status)  qs.set('status', status);
    if (q)       qs.set('q', q);
    if (storeId) qs.set('store_id', storeId);
    const tbody = $('#orders-table tbody');
    if (!silent) {
      tbody.innerHTML = '<tr><td colspan="10" class="muted">Loading…</td></tr>';
    }
    // Populate the store filter once stores are loaded.
    ensureOrdersStoreFilter();
    // Background-refresh the open-work count badges on the chip strip — staff
    // should always see what's queued without clicking through each chip.
    refreshOrderStatusCounts();

    let j;
    try {
      j = await api('/api/retail-admin/orders?' + qs);
    } catch (e) {
      if (!silent && myReq === _ORDERS_REQ_ID) {
        tbody.innerHTML = `<tr><td colspan="10" class="err">Failed: ${escapeHtml(e.message)}</td></tr>`;
        if (window.rmRenderOrderCards) rmRenderOrderCards(null, e.message);
      }
      return;
    }

    // A newer load has started since this fetch began — its result is
    // authoritative; ours would render the previous filter's rows on
    // top. Drop on the floor.
    if (myReq !== _ORDERS_REQ_ID) return;

    _ORDERS_LAST_OK_AT = Date.now();
    _paintOrdersLivePill();

    // Reset FP store when the filter changes — different filter, different
    // baseline. Also reset the seen-id set so we don't fake-flash rows that
    // just came into view from a filter switch.
    const filterKey = _ordersFilterKey();
    if (filterKey !== _ORDERS_LAST_FP_KEY) {
      _ORDERS_LAST_FP_KEY = filterKey;
      _ORDERS_LAST_FP = null;
      _ORDERS_SEEN_IDS = null;
      _ORDERS_NOTIFIED_IDS = null;
    }

    const fp = _ordersFp(j.data);
    if (silent && fp === _ORDERS_LAST_FP && tbody.querySelector('tr.order-row, .empty-state')) {
      // Nothing changed and the table is already painted — skip the rebuild.
      return;
    }
    const prevSeen = _ORDERS_SEEN_IDS;
    _ORDERS_LAST_FP = fp;

    if (!j.data.length) {
      const emptyMsg = (status === 'refunds_open')
        ? `<h3>Inbox zero · 无待处理退款</h3>
           <p class="muted">No open refund requests right now. · 当前无待处理退款。</p>`
        : `<h3>No orders yet · 暂无订单</h3>
           <p class="muted">Orders appear here as customers place them on the mini app. · 顾客在小程序下单后,订单将显示在这里。</p>`;
      tbody.innerHTML = `<tr><td colspan="9">
        <div class="empty-state">
          <div class="icon">${ICONS.empty}</div>
          ${emptyMsg}
        </div>
      </td></tr>`;
      _ORDERS_SEEN_IDS = new Set();
      _ORDERS_NOTIFIED_IDS = new Set();
      if (window.rmRenderOrderCards) rmRenderOrderCards([]);
      return;
    }

    const newIds = new Set(j.data.map(o => o.id));
    // An order is "actionable" only once it's paid — we don't process,
    // mark, or chime for unpaid orders (pending_payment) or dead ones
    // (cancelled); those just show their status pill and sit quiet. The mark
    // + chime kick in when there's actually something to fulfil.
    const isActionable = o => o.status !== 'pending_payment' && o.status !== 'cancelled';
    const actionableIds = new Set(j.data.filter(isActionable).map(o => o.id));
    const prevNotified = _ORDERS_NOTIFIED_IDS;
    // Arrival = an order that's actionable now and we haven't chimed for yet.
    // Catches both brand-new paid orders AND pending→paid flips (the id may
    // already be on screen, but it wasn't actionable before).
    const arrivals = prevNotified
      ? j.data.filter(o => isActionable(o) && !prevNotified.has(o.id))
      : [];

    tbody.innerHTML = j.data.map(o => {
      // No flash / no NEW mark for unpaid orders — nothing to act on yet.
      const fresh = (isActionable(o) && prevSeen && !prevSeen.has(o.id)) ? ' is-fresh' : '';
      // Unread until any operator opens the detail (server seen_at). Stays
      // bold + lit across reloads/devices, unlike the transient arrival flash.
      const isUnread = !o.seen_at && isActionable(o);
      const unread = isUnread ? ' is-unread' : '';
      return `
      <tr class="order-row${fresh}${unread}" data-order-id="${o.id}" tabindex="0">
        <td>${isUnread ? '<span class="new-chip">NEW · 新</span>' : ''}<span class="ord-no">${o.order_no}</span></td>
        <td>
          <div class="ord-cust">${escapeHtml(o.nickname || o.recipient_name || '—')}</div>
          <div class="muted" style="font-size: 11px; margin-top: 2px">${escapeHtml(o.recipient_phone || '')}</div>
        </td>
        <td class="oc-store">
          ${o.store_code ? `<div>${escapeHtml(o.store_name_en || o.store_code)}</div>
            ${routingNote(o.routing_reason) ? `<div class="muted" style="font-size: 11px; margin-top: 2px">${routingNote(o.routing_reason)}</div>` : ''}
            ${fulfillmentShortBadge(o)}` : '<span class="muted">—</span>'}
        </td>
        <td class="oc-shipto">${renderShipToCell(o)}</td>
        <td>${o.item_count}</td>
        <td class="numeric oc-total">¥${fmt(o.total)}</td>
        <td class="status-cell"><div class="stack"><span class="pill st-${o.status}"><span class="dot"></span>${humanStatus(o.status, o.fulfillment_type)}</span>${refundBadge(o)}</div></td>
        <td>${renderTrackingCell(o)}</td>
        <td>${renderShipByCell(o)}</td>
        <td class="muted" style="font-size: 11px">${formatDate(o.placed_at)}</td>
      </tr>`;
    }).join('');
    ordTweaksApply();
    if (window.rmRenderOrderCards) rmRenderOrderCards(j.data);

    _ORDERS_SEEN_IDS = newIds;
    _ORDERS_NOTIFIED_IDS = actionableIds;

    // Surface real arrivals — only after the first paint baseline exists.
    if (arrivals.length && prevNotified) {
      const word = arrivals.length === 1 ? 'order' : 'orders';
      toast(`${arrivals.length} new ${word} · ${arrivals.length} 个新订单`);
      notifyNewOrders(arrivals.length);
    }
  } finally {
    _ORDERS_IN_FLIGHT = false;
  }
}

// ── Poller: live updates without rebuilding the page ───────────────────
// Skips when: the Orders tab isn't active, the document is hidden, the
// user is mid-input/select, or the live pill has been paused. Safe to
// call while drawers/modals are open — fingerprint check means we only
// touch the DOM when something actually changed.
function _ordersAutoTick() {
  if (_ORDERS_LIVE_PAUSED) return;
  if (document.hidden) return;
  const tabActive = document.getElementById('tab-orders');
  if (!tabActive || !tabActive.classList.contains('active')) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.matches('input, select, textarea, [contenteditable="true"]')) return;
  loadOrders({ silent: true });
  ordLoadKpis();   // throttled (45s) — keeps the today pulse live on the tab
}

function _paintOrdersLivePill() {
  // Compact dot indicator next to the Settings gear. Green pulsing
  // when live, dim/static when paused — no label, the dot IS the
  // status. Tooltip shows the last-refresh timestamp for users who
  // want the detail without it cluttering the chrome.
  const dot = document.getElementById('orders-live-dot');
  if (!dot) return;
  dot.classList.toggle('paused', _ORDERS_LIVE_PAUSED);
  // Built in the active language only — this title is (re)set by JS on every
  // tick, and JS attribute writes don't fire the i18n MutationObserver, so a
  // bilingual "EN · CN" string here would never get split and would show both
  // languages at once. cuT() picks the live language instead.
  const T = window.cuT || ((en) => en);
  if (_ORDERS_LIVE_PAUSED) {
    dot.title = T('Paused — click to resume', '已暂停 — 点击恢复');
    return;
  }
  if (!_ORDERS_LAST_OK_AT) {
    dot.title = T('Live — click to pause', '实时 — 点击暂停');
    return;
  }
  const age = Math.max(0, Math.round((Date.now() - _ORDERS_LAST_OK_AT) / 1000));
  const ageStr = age < 5 ? T('just now', '刚刚')
              : age < 60 ? T(`${age}s ago`, `${age} 秒前`)
              : T(`${Math.floor(age/60)}m ago`, `${Math.floor(age/60)} 分钟前`);
  dot.title = T(`Live — last update ${ageStr} — click to pause`,
                `实时 — 最后更新 ${ageStr} — 点击暂停`);
}

function toggleOrdersLive() {
  _ORDERS_LIVE_PAUSED = !_ORDERS_LIVE_PAUSED;
  _paintOrdersLivePill();
  if (!_ORDERS_LIVE_PAUSED) _ordersAutoTick();
}

// Start the poller once. Wired listeners refresh immediately when the
// user comes back to the tab/window so they don't have to wait a tick.
(function _startOrdersPoller() {
  if (window._ordersPollerWired) return;
  window._ordersPollerWired = true;
  if (_ORDERS_AUTO_TIMER) clearInterval(_ORDERS_AUTO_TIMER);
  _ORDERS_AUTO_TIMER = setInterval(_ordersAutoTick, ORDERS_POLL_MS);
  // Tick the "Xs ago" label every 5s even between fetches.
  setInterval(_paintOrdersLivePill, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) _ordersAutoTick(); });
  window.addEventListener('focus', _ordersAutoTick);
  // When the user switches back to the Orders tab, refresh right away AND
  // clear the unseen-orders badge — they're about to see them.
  const ordersTabBtn = document.querySelector('.tabs [data-tab="orders"]');
  if (ordersTabBtn) ordersTabBtn.addEventListener('click', () => {
    setTimeout(_ordersAutoTick, 50);
    ordLoadKpis(true);   // fresh today pulse on tab open
    _markOrdersSeenNow();
  });
})();

// Load the Invoices tab each time it's opened. Also clears the unseen-invoice
// badge — the operator is about to see the pending requests.
(function () {
  const btn = document.querySelector('.tabs [data-tab="invoices"]');
  if (btn) btn.addEventListener('click', () => { setTimeout(loadInvoices, 50); invLoadKpis(true); _markInvoicesSeenNow(); });
})();

// ── Unseen-orders badge (red pulsing dot on the Orders tab) ─────────────
// Polls a lightweight count endpoint independent of the heavy orders list
// (which only refreshes when the tab is active). Tracks the "last seen at"
// timestamp in localStorage so the badge survives reloads but clears as
// soon as the user actually visits the Orders tab.
const ORDERS_UNSEEN_POLL_MS = 15000;
const ORDERS_LAST_SEEN_KEY  = 'roots-v2-orders-last-seen-at';
let _ORDERS_UNSEEN_TIMER = null;

function _ordersLastSeen() {
  try { return localStorage.getItem(ORDERS_LAST_SEEN_KEY) || ''; }
  catch { return ''; }
}
function _setOrdersLastSeen(ts) {
  try { localStorage.setItem(ORDERS_LAST_SEEN_KEY, ts); }
  catch {}
}
function _markOrdersSeenNow() {
  _setOrdersLastSeen(new Date().toISOString());
  _paintOrdersBadge(0);
}
// Browser-tab title badge — prefixes the page title with "(N) " so unseen
// orders are visible even when the whole backend tab is in the background.
const _BASE_TITLE = document.title;
function _setOrdersTitleBadge(count) {
  document.title = count > 0 ? '(' + (count > 99 ? '99+' : count) + ') ' + _BASE_TITLE : _BASE_TITLE;
}
function _paintOrdersBadge(count) {
  const btn   = document.querySelector('.tabs [data-tab="orders"]');
  const badge = document.getElementById('ordersTabBadge');
  _setOrdersTitleBadge(count);
  if (!btn || !badge) return;
  if (count > 0) {
    btn.classList.add('has-unseen');
    // Show the count when >1; bare dot for a single new order keeps the
    // chrome minimal until volume actually matters.
    badge.textContent = count > 1 ? (count > 99 ? '99+' : String(count)) : '';
  } else {
    btn.classList.remove('has-unseen');
    badge.textContent = '';
  }
}

// ── New-order chime ────────────────────────────────────────────────────
// A soft two-note ding synthesised with WebAudio (no asset to ship/cache).
// Muteable; preference persists in localStorage. The AudioContext is
// created lazily and resumed on the first operator gesture so browser
// autoplay policy doesn't swallow the first ding.
const ORDERS_SOUND_KEY = 'roots-v2-orders-sound-on';
let _ordersAudioCtx = null;

function _ordersSoundOn() {
  try { return localStorage.getItem(ORDERS_SOUND_KEY) !== '0'; }  // default ON
  catch { return true; }
}
function _paintSoundToggle() {
  const btn = document.getElementById('orders-sound-toggle');
  if (btn) btn.classList.toggle('muted', !_ordersSoundOn());
}
function toggleOrdersSound() {
  const next = !_ordersSoundOn();
  try { localStorage.setItem(ORDERS_SOUND_KEY, next ? '1' : '0'); } catch {}
  _paintSoundToggle();
  if (next) { _unlockOrdersAudio(); _playOrderChime(); }  // unmuting previews the ding
}
function _unlockOrdersAudio() {
  try {
    if (!_ordersAudioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _ordersAudioCtx = new AC();
    }
    if (_ordersAudioCtx.state === 'suspended') _ordersAudioCtx.resume();
  } catch {}
}
function _playOrderChime() {
  if (!_ordersSoundOn()) return;
  _unlockOrdersAudio();
  const ctx = _ordersAudioCtx;
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    // Two ascending notes (G5 → C6) — a gentle, recognisable "ding-dong".
    [[784, 0], [1047, 0.16]].forEach(([freq, at]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    });
  } catch {}
}
// Unlock audio on the first operator interaction (autoplay policy).
['click', 'keydown'].forEach(ev =>
  window.addEventListener(ev, _unlockOrdersAudio, { once: true, capture: true }));

// Notify on a new order — chime + a brief tab-badge pulse even while the
// operator is sitting on the Orders tab (the normal badge path suppresses
// itself there, so without this an order would land silently in front of
// them). The pulse auto-clears on the next seen-sweep.
function notifyNewOrders(count) {
  _playOrderChime();
  const onOrdersTab = document.getElementById('tab-orders')?.classList.contains('active');
  if (onOrdersTab) {
    _paintOrdersBadge(count);
    clearTimeout(notifyNewOrders._t);
    notifyNewOrders._t = setTimeout(_markOrdersSeenNow, 6000);
  }
}

let _ordersUnseenPrev = null;
async function _pollUnseenOrders() {
  // Skip when the tab is hidden — the user wouldn't see the dot animate
  // anyway, and we'd waste API calls.
  if (document.hidden) return;
  // If the user is already on the Orders tab, treat everything as seen.
  const orderTabActive = document.getElementById('tab-orders')?.classList.contains('active');
  if (orderTabActive) { _markOrdersSeenNow(); _ordersUnseenPrev = 0; return; }
  try {
    const since = _ordersLastSeen();
    const j = await api('/api/retail-admin/orders/unseen-count?since=' + encodeURIComponent(since));
    if (!j?.success) return;
    const count = j.data?.count || 0;
    _paintOrdersBadge(count);
    // Chime only on a genuine increase (a NEW order arriving), not on the
    // first poll after load and not on every steady-state tick.
    if (_ordersUnseenPrev !== null && count > _ordersUnseenPrev) _playOrderChime();
    _ordersUnseenPrev = count;
  } catch {
    // Network / unauthorized — silently leave the badge alone.
  }
}

(function _startUnseenOrdersPoller() {
  if (window._unseenOrdersPollerWired) return;
  window._unseenOrdersPollerWired = true;
  _paintSoundToggle();
  // First check on next tick so the DOM is ready, then on an interval.
  setTimeout(_pollUnseenOrders, 200);
  _ORDERS_UNSEEN_TIMER = setInterval(_pollUnseenOrders, ORDERS_UNSEEN_POLL_MS);
  // Re-check on window focus so a long-idle tab pops the badge immediately
  // when the user comes back.
  window.addEventListener('focus', _pollUnseenOrders);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) _pollUnseenOrders(); });
})();

// ── Unseen-invoice badge (red pulsing dot + chime on the Invoices tab) ──
// Mirrors the new-order notification: a pending fapiao request should land
// like a new order. Shares the same chime + sound toggle as orders.
const INVOICES_LAST_SEEN_KEY = 'roots-v2-invoices-last-seen-at';
let _INVOICES_UNSEEN_TIMER = null;

function _invoicesLastSeen() {
  try { return localStorage.getItem(INVOICES_LAST_SEEN_KEY) || ''; }
  catch { return ''; }
}
function _markInvoicesSeenNow() {
  try { localStorage.setItem(INVOICES_LAST_SEEN_KEY, new Date().toISOString()); }
  catch {}
  _paintInvoicesBadge(0);
}
function _paintInvoicesBadge(count) {
  const btn   = document.querySelector('.tabs [data-tab="invoices"]');
  const badge = document.getElementById('invoicesTabBadge');
  if (!btn || !badge) return;
  if (count > 0) {
    btn.classList.add('has-unseen');
    badge.textContent = count > 1 ? (count > 99 ? '99+' : String(count)) : '';
  } else {
    btn.classList.remove('has-unseen');
    badge.textContent = '';
  }
}

let _invoicesUnseenPrev = null;
async function _pollUnseenInvoices() {
  if (document.hidden) return;
  const invTabActive = document.getElementById('tab-invoices')?.classList.contains('active');
  if (invTabActive) { _markInvoicesSeenNow(); _invoicesUnseenPrev = 0; return; }
  try {
    const since = _invoicesLastSeen();
    const j = await api('/api/retail-admin/invoices/unseen-count?since=' + encodeURIComponent(since));
    if (!j?.success) return;
    const count = j.data?.count || 0;
    _paintInvoicesBadge(count);
    if (_invoicesUnseenPrev !== null && count > _invoicesUnseenPrev) _playOrderChime();
    _invoicesUnseenPrev = count;
  } catch {
    // Network / unauthorized — leave the badge alone.
  }
}

(function _startUnseenInvoicesPoller() {
  if (window._unseenInvoicesPollerWired) return;
  window._unseenInvoicesPollerWired = true;
  setTimeout(_pollUnseenInvoices, 400);
  _INVOICES_UNSEEN_TIMER = setInterval(_pollUnseenInvoices, ORDERS_UNSEEN_POLL_MS);
  window.addEventListener('focus', _pollUnseenInvoices);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) _pollUnseenInvoices(); });
})();

// ── Unseen-inbox badges (Reviews + Feedback) ───────────────────────────
// Each Inbox sub-tab gets its own red dot + chime; the Inbox group trigger
// shows the combined count so it stays visible while the dropdown is collapsed.
// Reuses the new-order chime + sound toggle. Feature-gated tabs are skipped.
const _INBOX_CATS = [
  { tab: 'reviews',  key: 'roots-v2-reviews-last-seen-at',  endpoint: '/api/retail-admin/reviews/unseen-count',  feat: 'feat-reviews',  prev: null, _count: 0 },
  { tab: 'feedback', key: 'roots-v2-feedback-last-seen-at', endpoint: '/api/retail-admin/feedback/unseen-count', feat: 'feat-feedback', prev: null, _count: 0 },
];

function _inboxLastSeen(cat) {
  try { return localStorage.getItem(cat.key) || ''; } catch { return ''; }
}
function _markInboxSeenNow(tab) {
  const cat = _INBOX_CATS.find(c => c.tab === tab);
  if (!cat) return;
  try { localStorage.setItem(cat.key, new Date().toISOString()); } catch {}
  cat._count = 0; cat.prev = 0;
  _paintInboxBadges();
}
function _paintInboxBadges() {
  let total = 0;
  for (const cat of _INBOX_CATS) {
    const count = cat._count || 0;
    total += count;
    const btn   = document.querySelector('.tabs [data-tab="' + cat.tab + '"]');
    const badge = document.getElementById('inbox-badge-' + cat.tab);
    if (btn && badge) {
      if (count > 0) {
        btn.classList.add('has-unseen');
        badge.textContent = count > 1 ? (count > 99 ? '99+' : String(count)) : '';
      } else {
        btn.classList.remove('has-unseen');
        badge.textContent = '';
      }
    }
  }
  // Roll the combined count up to the Inbox group trigger so it shows while
  // the dropdown is closed.
  const trigger = document.querySelector('.tabs-group[data-group="inbox"] .tabs-group-trigger');
  const tBadge  = document.getElementById('inboxTriggerBadge');
  if (trigger && tBadge) {
    if (total > 0) {
      trigger.classList.add('has-unseen');
      tBadge.textContent = total > 1 ? (total > 99 ? '99+' : String(total)) : '';
    } else {
      trigger.classList.remove('has-unseen');
      tBadge.textContent = '';
    }
  }
}

async function _pollUnseenInbox() {
  if (document.hidden) return;
  for (const cat of _INBOX_CATS) {
    // Disabled feature → tab is hidden anyway; keep its count at zero.
    if (cat.feat && !document.body.classList.contains(cat.feat)) { cat._count = 0; continue; }
    // On the sub-tab → everything is seen.
    if (document.getElementById('tab-' + cat.tab)?.classList.contains('active')) {
      try { localStorage.setItem(cat.key, new Date().toISOString()); } catch {}
      cat._count = 0; cat.prev = 0; continue;
    }
    try {
      const j = await api(cat.endpoint + '?since=' + encodeURIComponent(_inboxLastSeen(cat)));
      if (!j?.success) continue;
      const count = j.data?.count || 0;
      // Chime only on a genuine increase, not the first poll after load.
      if (cat.prev !== null && count > cat.prev) _playOrderChime();
      cat.prev = count;
      cat._count = count;
    } catch {
      // Network / unauthorized — leave this category's badge alone.
    }
  }
  _paintInboxBadges();
}

(function _startUnseenInboxPoller() {
  if (window._unseenInboxPollerWired) return;
  window._unseenInboxPollerWired = true;
  setTimeout(_pollUnseenInbox, 600);
  setInterval(_pollUnseenInbox, ORDERS_UNSEEN_POLL_MS);
  window.addEventListener('focus', _pollUnseenInbox);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) _pollUnseenInbox(); });
  // Clear a sub-tab's badge as soon as it's opened.
  _INBOX_CATS.forEach(cat => {
    const btn = document.querySelector('.tabs [data-tab="' + cat.tab + '"]');
    if (btn) btn.addEventListener('click', () => _markInboxSeenNow(cat.tab));
  });
})();

// "Ship by" — when the customer needs this order shipped/delivered. Pulled
// from `delivery_slot_label` (the human-readable picker label captured at
// checkout) and `scheduled_for` (ISO start of the slot, or NULL for ASAP).
// Urgency highlight only fires for actionable statuses; once dispatched or
// delivered it goes muted.
// Line-style storefront glyph for pickup orders — matches the app's stroke
// icon set (the 🏬 emoji clashed with the Full Circle chrome).
function pickupIcon(size = 12) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px;margin-right:1px"><path d="M4 10.5V20h16v-9.5"/><path d="M3.5 6.5 5 3.5h14l1.5 3a3 3 0 0 1-5.7 1.3A3 3 0 0 1 12 7.5a3 3 0 0 1-2.8.3A3 3 0 0 1 3.5 6.5z"/><path d="M9.5 20v-5h5v5"/></svg>`;
}
// `scheduled_for` reaches the client in two shapes: a bare SQLite UTC stamp
// ("YYYY-MM-DD HH:MM:SS", which needs a 'Z' to parse as UTC) or a full ISO
// string that already carries 'T'+'Z' (slot resolution stores
// dt.toISOString(), and localizeOrderTimes deliberately leaves it untouched).
// Appending 'Z' unconditionally turned the ISO form into "…ZZ" → Invalid Date,
// which silently blanked the ship-by value: with no valid date the cell/tile
// drops the urgency badge and collapses to the pure-Chinese slot label, which
// the EN/CN block classifier then mis-pairs with the English sub-line and hides
// in English view. Only append 'Z' when the string isn't already ISO/tz-aware.
function parseSchedFor(s) {
  const v = String(s == null ? '' : s);
  return new Date(/[TZ]/.test(v) ? v : v.replace(' ', 'T') + 'Z');
}
function renderShipByCell(o) {
  const actionable = (o.status === 'paid' || o.status === 'preparing');
  if (o.fulfillment_type === 'pickup') {
    const label = localizeSlotLabel(humanizeSlotLabel(o.delivery_slot_label)) || cuT('ASAP', '尽快');
    return `<div style="font-size: 12px; font-weight: 600; color: ${actionable ? 'var(--warn)' : 'var(--text-1)'}; line-height: 1.3;">${pickupIcon(12)} ${escapeHtml(label)}</div>
            <div class="muted" style="font-size: 10px; margin-top: 2px;">${cuT('pickup', '自提')}</div>`;
  }
  // Out-of-GZ "as soon as possible" order (Express / no specific date chosen):
  // the server stripped the misleading earliest-day date and gave us a real
  // send-by deadline (paid + 48h). Show "ASAP · send by <deadline>" instead.
  if (o.ship_by_mode === 'asap') {
    const dl    = o.dispatch_deadline ? parseSchedFor(o.dispatch_deadline) : null;
    const valid = dl && !isNaN(dl.getTime());
    const hrs   = valid ? (dl.getTime() - Date.now()) / 3600000 : null;
    let c = actionable ? 'var(--warn)' : 'var(--text-3)';
    let tail = '';
    if (actionable && hrs !== null) {
      if (hrs < 0)        { c = 'var(--danger)'; tail = ` · <b>${cuT('OVERDUE', '已逾期')}</b>`; }
      else if (hrs < 12)  { c = 'var(--danger)'; }
      else if (hrs < 24)  { c = 'var(--warn)'; }
      else                { c = 'var(--text-1)'; }
    }
    const sub = valid
      ? `${cuT('latest', '最迟')} ${fmtSlotShort(dl)}${tail}`
      : cuT('as soon as possible', '尽快发出');
    return `<div style="font-size: 12px; font-weight: 600; color: ${actionable ? 'var(--warn)' : 'var(--text-1)'};">${cuT('ASAP', '尽快')}</div>
            <div style="font-size: 10px; margin-top: 2px; color: ${valid ? c : 'var(--text-3)'};">${sub}</div>`;
  }
  const isAsap     = !o.scheduled_for;
  if (isAsap) {
    return `<div style="font-size: 12px; font-weight: 600; color: ${actionable ? 'var(--warn)' : 'var(--text-3)'};">${cuT('ASAP', '尽快')}</div>
            <div class="muted" style="font-size: 10px; margin-top: 2px;">${cuT('no slot picked', '未选时段')}</div>`;
  }
  // Parse "YYYY-MM-DD HH:MM:SS" (UTC from SQLite) or a full ISO string → local
  const dt = parseSchedFor(o.scheduled_for);
  const valid = !isNaN(dt.getTime());
  const now = Date.now();
  const hrsUntil = valid ? (dt.getTime() - now) / 3600000 : null;

  let color = 'var(--text-1)';
  let badge = '';
  if (actionable && hrsUntil !== null) {
    if (hrsUntil < 0)        { color = 'var(--danger)'; badge = ` · <b>${cuT('OVERDUE','已逾期')}</b>`; }
    else if (hrsUntil < 6)   { color = 'var(--danger)'; badge = ` · ${cuT('today','今天')}`; }
    else if (hrsUntil < 24)  { color = 'var(--warn)';   badge = ` · ${cuT('today','今天')}`; }
    else if (hrsUntil < 48)  { color = 'var(--warn)';   badge = ` · ${cuT('tomorrow','明天')}`; }
  }
  // Some orders saved an ISO timestamp into delivery_slot_label (rather
  // than a human "May 25 11am"). humanizeSlotLabel rewrites those before
  // they hit the cell so we never show raw ISO to the operator.
  const rawLabel = localizeSlotLabel(humanizeSlotLabel(o.delivery_slot_label))
    || (valid ? fmtSlotShort(dt) : escapeHtml(String(o.scheduled_for)));
  const dateLine = valid ? fmtSlotShort(dt) : '';
  const surcharge = (Number(o.same_day_surcharge_fee) || 0) > 0
    ? ` <span style="font-size: 10px; color: var(--warn);">+¥${fmt(o.same_day_surcharge_fee)} ${cuT('same-day','当日')}</span>` : '';
  return `<div style="font-size: 12px; font-weight: 600; color: ${color}; line-height: 1.3;">${escapeHtml(rawLabel)}${badge}</div>
          ${(rawLabel !== dateLine && dateLine) ? `<div class="muted" style="font-size: 10px; margin-top: 2px; font-family: var(--f-mono);">${dateLine}</div>` : ''}
          ${surcharge}`;
}
function fmtSlotShort(dt) {
  const pad = n => String(n).padStart(2, '0');
  // In Chinese mode show "6月25日 · 14:30" instead of "Jun 25 · 14:30".
  if (typeof window !== 'undefined' && window.cuLang && window.cuLang() === 'cn') {
    return `${dt.getMonth() + 1}月${dt.getDate()}日 · ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getMonth()];
  return `${M} ${pad(dt.getDate())} · ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}
// The customer's delivery_slot_label is stored as free text in WHATEVER language
// they checked out in (e.g. "Today 10AM–12PM", "Thu Jun 25 2026", "ASAP") — the
// server keeps only that one string, so the operator's EN/CN toggle can't swap
// it. Translate the known formats at render time when the admin is in Chinese.
// Leaves already-Chinese labels (and anything unrecognised) untouched.
function localizeSlotLabel(label) {
  if (label == null || label === '') return label;
  if (!(typeof window !== 'undefined' && window.cuLang && window.cuLang() === 'cn')) return label;
  let s = String(label).trim();
  const WK  = { Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六' };
  const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  // Full toDateString shape "Thu Jun 25 2026" → "2026年6月25日 周四".
  let m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})$/.exec(s);
  if (m) return `${m[4]}年${MON[m[2]]}月${Number(m[3])}日 ${WK[m[1]]}`;
  // "Mmm DD YYYY" / "Mmm DD" (with optional "· HH:MM" time tail) → "M月D日 …".
  s = s.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s+(\d{4}))?\b/g,
    (_, mo, d, y) => (y ? y + '年' : '') + MON[mo] + '月' + Number(d) + '日');
  // Standalone weekday names (drop any trailing comma).
  s = s.replace(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b,?/g, (_, w) => WK[w]);
  // Relative day words.
  s = s.replace(/\bToday\b/g, '今天').replace(/\bTomorrow\b/g, '明天')
       .replace(/\bYesterday\b/g, '昨天').replace(/\bASAP\b/g, '尽快');
  // Pickup labels carry the English verb in the customer's free-text slot
  // ("Pickup Today …"). Translate it so the Chinese view stays all-Chinese.
  s = s.replace(/\bPick ?up\b/gi, '自提').replace(/\bCollect(?:ion)?\b/gi, '自提');
  // Time markers "10AM"/"12:30PM" → "上午10点"/"下午12:30".
  s = s.replace(/(\d{1,2})(:\d{2})?\s*(AM|PM)/gi,
    (_, h, mm, ap) => (/p/i.test(ap) ? '下午' : '上午') + h + (mm ? mm : '点'));
  return s;
}
// Some orders have `delivery_slot_label` stored as a raw ISO timestamp
// (e.g. `2026-05-20T08:00:00.000Z`) instead of a human label like
// "May 25 · 11am". Detect that case and humanise it via fmtSlotShort.
// Returns the original label when it's not ISO-shaped.
function humanizeSlotLabel(label) {
  if (!label) return '';
  const s = String(label).trim();
  // ISO with T separator: 2026-05-20T08:00:00Z / +08:00 / no tz
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return fmtSlotShort(d);
  }
  // SQLite-style "YYYY-MM-DD HH:MM:SS" (no T) — also normalise.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    if (!isNaN(d.getTime())) return fmtSlotShort(d);
  }
  // Date-only "YYYY-MM-DD" — a schedule-for-later calendar pick or a day-only
  // zone chip stores just the date. Show "Jun 12" (no fake 00:00 time) rather
  // than leaking the raw ISO date to the operator.
  const mDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (mDay) {
    const d = new Date(Number(mDay[1]), Number(mDay[2]) - 1, Number(mDay[3]));
    if (!isNaN(d.getTime())) {
      const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
      return M + ' ' + String(d.getDate()).padStart(2, '0');
    }
  }
  return s;
}
// Operator tiles show only what staff act on. The default delivery mode
// ('standard') and the routing reasons that mean "no decision was made"
// (only_store / nearest) are noise — surface a note only when it's exceptional.
function deliveryModeNote(mode) {
  const m = String(mode || '').toLowerCase().trim();
  return (!m || m === 'standard') ? '' : `mode: ${escapeHtml(m)}`;
}
function routingNote(reason) {
  const r = String(reason || '').toLowerCase().trim();
  if (r === 'fallback_no_stock') return 'rerouted · 改派(缺货)';
  if (r === 'manual')            return 'manually routed · 手动改派';
  if (r === 'out_of_city')       return 'out-of-city warehouse · 外地仓发货';
  return ''; // only_store / nearest / unknown — nothing worth showing
}
// Warning line for orders whose shipping store can't currently cover every item
// (set at checkout on out-of-city / scheduled-later orders that skipped the
// stock gate — see fulfillment_short_pids). Names the short items so the office
// knows what to restock or transfer in before the parcel ships. The order was
// accepted normally; this is purely a heads-up, never a block.
// Compact list-row counterpart to fulfillmentShortNote — a small amber chip so
// the office can spot "shipping store is short" orders without opening each one.
function fulfillmentShortBadge(o) {
  let pids = [];
  try { pids = JSON.parse(o.fulfillment_short_pids || '[]') || []; } catch {}
  if (!pids.length) return '';
  return `<div style="font-size: 11px; margin-top: 2px; color: var(--st-awaiting_restock); font-weight:700;" `
    + `title="${cuT('Shipping store is short on ' + pids.length + ' item(s) — restock or transfer before shipping',
                    '出货门店缺 ' + pids.length + ' 件商品 — 发货前请补货或调货')}">`
    + `⚠ ${cuT('needs restock', '需补货')}</div>`;
}
function fulfillmentShortNote(o) {
  let pids = [];
  try { pids = JSON.parse(o.fulfillment_short_pids || '[]') || []; } catch {}
  if (!pids.length) return '';
  const byId = new Map((o.items || []).map(it => [it.product_id, it]));
  const names = pids.map(pid => {
    const it = byId.get(pid);
    return it ? orderItemNames(it) : ('#' + pid);
  });
  return `<div class="sub" style="margin-top:6px; color: var(--st-awaiting_restock); font-weight:700;">`
    + `⚠ ${cuT('Not in stock at this store — restock or transfer before shipping',
                '该门店暂无库存 — 发货前请补货或调货')}`
    + `<div style="font-weight:600; color: var(--text-2); margin-top:2px;">${escapeHtml(names.join('、'))}</div>`
    + `</div>`;
}
// Full-size "Ship by" tile shown in the order-detail card grid. Mirrors the
// urgency colour scheme of the list-row cell but with more context (date,
// mode, surcharge note).
// "Ship by" is a future deadline — once an order has shipped or closed it
// reads wrong, so relabel it as the timing the customer originally requested.
function shipByKicker(o) {
  const done = (o.status === 'dispatched' || o.status === 'delivered'
    || o.status === 'cancelled' || o.status === 'refunded');
  return done ? 'Requested timing · 要求时间' : 'Ship by · 截止发货';
}
function renderShipByTile(o) {
  const actionable = (o.status === 'paid' || o.status === 'preparing');
  // Fresh batch-made order (outside-GZ): the kitchen must make a new batch on
  // this exact day, then ship same-day. Surfaced so the packer doesn't ship
  // early off the shelf.
  const batchSub = o.promised_ship_date
    ? `<div class="sub" style="color: var(--warn); font-weight: 600;">${cuT(`🥗 Make fresh on ${escapeHtml(o.promised_ship_date)} → arrives ~${escapeHtml(o.promised_delivery_date || '')}`, `🥗 ${escapeHtml(o.promised_ship_date)} 当天现做 → 约 ${escapeHtml(o.promised_delivery_date || '')} 送达`)}</div>`
    : '';
  // Pickup orders have no "ship by" deadline — show the customer-chosen pickup
  // window instead so staff know when to have it ready at the counter.
  if (o.fulfillment_type === 'pickup') {
    const label = localizeSlotLabel(humanizeSlotLabel(o.delivery_slot_label))
      || (o.scheduled_for ? localizeSlotLabel(humanizeSlotLabel(o.scheduled_for)) : cuT('During pickup hours', '营业时间内自取'));
    return `<div>
      <div class="kicker">Pickup time · 取货时间</div>
      <div class="val" data-no-i18n><b style="color: ${actionable ? 'var(--warn)' : 'var(--text-1)'};">${escapeHtml(label)}</b></div>
      <div class="sub">Have ready at counter · 备好待取</div>
    </div>`;
  }
  // Out-of-GZ "as soon as possible" order — show the send-by deadline tile
  // (paid + 48h) rather than the misleading system earliest-day date.
  if (o.ship_by_mode === 'asap') {
    const dl    = o.dispatch_deadline ? parseSchedFor(o.dispatch_deadline) : null;
    const valid = dl && !isNaN(dl.getTime());
    const hrs   = valid ? (dl.getTime() - Date.now()) / 3600000 : null;
    let color = actionable ? 'var(--warn)' : 'var(--text-1)';
    let urg = '';
    if (actionable && hrs !== null) {
      if (hrs < 0)        { color = 'var(--danger)'; urg = cuT('⚠ OVERDUE', '⚠ 已逾期'); }
      else if (hrs < 12)  { color = 'var(--danger)'; urg = cuT(`⚠ in ${Math.round(hrs)}h`, `⚠ ${Math.round(hrs)}小时内`); }
      else if (hrs < 24)  { color = 'var(--warn)';   urg = cuT(`${Math.round(hrs)}h left`, `剩 ${Math.round(hrs)}小时`); }
    }
    const deadlineLine = valid
      ? `<div class="sub" style="color: ${color}; font-weight: 600;">${cuT('Latest', '最迟')} ${fmtSlotShort(dl)}${urg ? ' · ' + urg : ''}</div>`
      : `<div class="sub">${cuT('No fixed date — ship as soon as possible', '无固定日期 — 尽快发货')}</div>`;
    return `<div>
      <div class="kicker">${shipByKicker(o)}</div>
      <div class="val"><b style="color: ${color};">${cuT('As soon as possible', '越快越好')}</b></div>
      ${deadlineLine}
      ${batchSub}
    </div>`;
  }
  const isAsap = !o.scheduled_for;
  const mode = deliveryModeNote(o.delivery_mode);
  if (isAsap) {
    return `<div>
      <div class="kicker">${shipByKicker(o)}</div>
      <div class="val"><b style="color: ${actionable ? 'var(--warn)' : 'var(--text-1)'};">${cuT('ASAP / Right away', '尽快 / 立即')}</b></div>
      <div class="sub">${cuT('No slot picked', '未选时段')}${mode ? ' · ' + mode : ''}</div>
      ${batchSub}
    </div>`;
  }
  const dt = parseSchedFor(o.scheduled_for);
  const valid = !isNaN(dt.getTime());
  const hrsUntil = valid ? (dt.getTime() - Date.now()) / 3600000 : null;
  let color = 'var(--text-1)';
  let urgencyLabel = '';
  if (actionable && hrsUntil !== null) {
    if (hrsUntil < 0)        { color = 'var(--danger)'; urgencyLabel = cuT('⚠ OVERDUE', '⚠ 已逾期'); }
    else if (hrsUntil < 6)   { color = 'var(--danger)'; urgencyLabel = cuT(`⚠ in ${Math.round(hrsUntil)}h`, `⚠ ${Math.round(hrsUntil)}小时内`); }
    else if (hrsUntil < 24)  { color = 'var(--warn)';   urgencyLabel = cuT(`today (${Math.round(hrsUntil)}h)`, `今天 (${Math.round(hrsUntil)}小时)`); }
    else if (hrsUntil < 48)  { color = 'var(--warn)';   urgencyLabel = cuT('tomorrow', '明天'); }
    else                     { urgencyLabel = cuT(`in ${Math.round(hrsUntil / 24)}d`, `${Math.round(hrsUntil / 24)}天后`); }
  } else if (hrsUntil !== null) {
    urgencyLabel = hrsUntil < 0 ? cuT('past', '已过期') : (hrsUntil < 24 ? cuT('within 24h', '24小时内') : cuT(`in ${Math.round(hrsUntil / 24)}d`, `${Math.round(hrsUntil / 24)}天后`));
  }
  const fullIso = valid ? fmtSlotShort(dt) : escapeHtml(String(o.scheduled_for));
  // Humanize any ISO-shaped label so the tile never reads as
  // "2026-05-20T08:00:00.000Z · mode: standard".
  const label = localizeSlotLabel(humanizeSlotLabel(o.delivery_slot_label)) || fullIso;
  const surcharge = (Number(o.same_day_surcharge_fee) || 0) > 0
    ? ` · <span style="color: var(--warn);">+¥${fmt(o.same_day_surcharge_fee)} ${cuT('same-day surcharge','当日加收')}</span>` : '';
  return `<div>
    <div class="kicker">${shipByKicker(o)}</div>
    <div class="val" data-no-i18n><b style="color: ${color};">${escapeHtml(label)}</b>${urgencyLabel ? ` <span style="font-size: 11px; color: ${color}; font-weight: 600;">· ${urgencyLabel}</span>` : ''}</div>
    <div class="sub">${mode}${surcharge}</div>
    ${batchSub}
  </div>`;
}

// Map a dispatched order's live carrier state to a one-line "where is it /
// what's wrong" chip. Reads the normalized `tracking_status` + the richer
// `tracking_scenario` (both written by the kd100 push pipeline / JD poll — see
// lib/tracking.js) which the orders + dashboard/ops endpoints now return.
// Scenario is MORE specific than status, so it wins where it carries meaning
// (e.g. no_contact / pickup_point). Returns null when there's nothing useful
// to surface yet. tone: 'urgent' (red, chase it) | 'attn' (amber, waiting on
// customer) | 'ok' (green) | 'transit' (grey, in flight). Shared with the
// dashboard delivery-alerts banner (03-dashboard.js) — one global scope.
function deliveryStateInfo(o) {
  // Order-level status wins — admin clicking "Mark delivered" sets status but
  // not tracking_status, so without this guard delivered orders show "In transit".
  if (o.status === 'delivered') return { icon: 'check', en: 'Delivered', cn: '已签收', color: '#5a8c2a', tone: 'ok' };
  const st = o.tracking_status || '';
  const sc = o.tracking_scenario || '';
  // Problems first — these are what the operator must act on.
  if (sc === 'no_contact')  return { icon: 'phone_off', en: "Can't reach customer",   cn: '联系不上客户', color: '#c0392b', tone: 'urgent' };
  if (st === 'exception')   return { icon: 'alert',     en: 'Delivery issue',          cn: '配送异常',     color: '#c0392b', tone: 'urgent' };
  if (st === 'returning')   return { icon: 'uturn',     en: 'Returning to sender',     cn: '退回中',       color: '#c0392b', tone: 'urgent' };
  if (st === 'returned')    return { icon: 'uturn',     en: 'Returned',                cn: '已退回',       color: '#c0392b', tone: 'urgent' };
  // Waiting on the customer to collect — not a failure, but worth seeing.
  if (sc === 'pickup_point') return { icon: 'store',    en: 'At pickup point',        cn: '已到驿站',     color: '#b9770e', tone: 'attn' };
  if (sc === 'locker')       return { icon: 'locker',   en: 'In a locker',            cn: '已入快递柜',   color: '#b9770e', tone: 'attn' };
  // Good / in-flight states.
  if (st === 'delivered')        return { icon: 'check', en: 'Delivered',             cn: '已签收',       color: '#5a8c2a', tone: 'ok' };
  if (st === 'out_for_delivery' || sc === 'out_for_delivery')
                                 return { icon: 'courier', en: 'Out for delivery',     cn: '派送中',       color: '#1d72b8', tone: 'transit' };
  if (st === 'in_transit')       return { icon: 'transit', en: 'In transit',          cn: '运输中',       color: '#9aa0a6', tone: 'transit' };
  if (st === 'picked_up')        return { icon: 'inbox',  en: 'Picked up',            cn: '已揽收',       color: '#9aa0a6', tone: 'transit' };
  return null;
}

// Monochrome line icons for the delivery states, matching the platform set
// (24×24 viewBox, currentColor stroke, round joins — same recipe as
// pickupIcon / BENTO_ICONS). Kept stroke-light so they read cleanly at the
// ~11px the orders-list cell renders them. Inherit color from the parent, so
// the urgent states pick up their red and the transit states their grey.
const DELIVERY_ICON_PATHS = {
  van:       '<path d="M3 7h9v8H3z"/><path d="M12 10h3.5L19 13v2h-7"/><circle cx="7" cy="16.5" r="1.4"/><circle cx="15.5" cy="16.5" r="1.4"/>',
  // Out for delivery — a courier walking with a parcel in hand, so the office
  // reads "it's with the delivery person right now" at a glance (not a truck).
  courier:   '<circle cx="7" cy="3.8" r="2"/><path d="M7 5.8v6.4"/><path d="M7 12.2l-2.2 5"/><path d="M7 12.2l2.4 4.6"/><path d="M7 8.2l3.4 1.3"/><rect x="10.4" y="8.3" width="6.4" height="6.2" rx="0.7"/><path d="M10.4 11.4h6.4"/><path d="M13.6 8.3v6.2"/>',
  transit:   '<rect x="6" y="7" width="11" height="10" rx="1"/><path d="M6 11h11"/><path d="M2 9.5h2.5"/><path d="M1.5 13h3"/>',
  inbox:     '<path d="M5 12v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/><path d="M5 12h4l1 2h4l1-2h4"/><path d="M12 3v6"/><path d="M9 6l3 3 3-3"/>',
  check:     '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/>',
  phone_off: '<path d="M5 4h3l1 4-2 1a11 11 0 0 0 6 6l1-2 4 1v3a1 1 0 0 1-1 1A15 15 0 0 1 4 5a1 1 0 0 1 1-1z"/><path d="M3 3l18 18"/>',
  alert:     '<path d="M12 4 3 19h18L12 4z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  uturn:     '<path d="M9 7H6a4 4 0 1 0 0 8h9"/><path d="M12 4 9 7l3 3"/>',
  store:     '<path d="M4 9v10h16V9"/><path d="M3 5h18l-1.2 4H4.2L3 5z"/><path d="M9 19v-5h6v5"/>',
  locker:    '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M12 3v18"/><path d="M8.5 7.5h.6"/><path d="M14.9 7.5h.6"/>',
  // Same-city local delivery — a moped/scooter (replaces the 🛵 emoji).
  scooter:   '<circle cx="6" cy="17" r="2.3"/><circle cx="18" cy="17" r="2.3"/><path d="M8.2 17h7.6l-2.3-7H11"/><path d="M13.5 10l1.3-3H17"/><path d="M4.5 13h3.2l1.6 4"/>',
};
function deliveryIcon(key, size = 12) {
  const p = DELIVERY_ICON_PATHS[key];
  if (!p) return '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// Map-pin icon, same recipe as the delivery set (24×24, currentColor stroke,
// round joins). Replaces the 📍 emoji on the "Make address Chinese" button so
// it reads as part of the platform line-icon language rather than a system glyph.
function pinIcon(size = 13) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>`;
}

function renderTrackingCell(o) {
  if (o.fulfillment_type === 'pickup') {
    return `<span class="muted" style="font-size:11px;">${pickupIcon(11)} ${cuT('pickup','自提')}</span>`;
  }
  // Local (same-city) delivery has no waybill — it carries an operator-set ETA
  // instead. Show that here, and never the red "missing waybill" warning, which
  // doesn't apply to local delivery.
  if (o.is_local) {
    if (o.local_eta) {
      return `<div style="display:flex; align-items:center; gap:3px; font-size:11px; font-weight:600; color:#5a8c2a;">${deliveryIcon('scooter', 12)}<span>${escapeHtml(formatEtaPretty(o.local_eta))}</span></div>
              <div class="muted" style="font-size:10px; margin-top:2px;">${cuT('arrival','预计送达')}</div>`;
    }
    if (o.status === 'dispatched') {
      return `<span class="muted" style="font-size:11px;">${cuT('no ETA set','未设送达时间')}</span>`;
    }
    return '<span class="muted">—</span>';
  }
  if (!o.tracking_number) {
    // Shipped without tracking = office still needs to enter the waybill.
    if (o.status === 'dispatched') return `<span class="err" style="font-size:11px;">${cuT('⚠ missing','⚠ 缺运单号')}</span>`;
    return '<span class="muted">—</span>';
  }
  const carrier = (o.tracking_carrier || '').toUpperCase();
  const sync = (o.tracking_kd100_subscribed || o.jd_live)
    ? `<span style="color:#5a8c2a; font-size:10px;">● ${cuT('live','实时')}</span>`
    : `<span class="muted" style="font-size:10px;">${cuT('manual','手动')}</span>`;
  // Live delivery state — only meaningful once the parcel has left (dispatched),
  // and only when the carrier has actually reported something. Urgent states get
  // a heavier weight so a stuck/contact-failed parcel stands out in the list.
  const dl = (o.status === 'dispatched' || o.status === 'delivered') ? deliveryStateInfo(o) : null;
  const dlLine = dl
    ? `<div style="margin-top:3px; display:flex; align-items:center; gap:3px; font-size:10px; font-weight:${dl.tone === 'urgent' ? 700 : 600}; color:${dl.color};">${deliveryIcon(dl.icon, 11)}<span>${cuT(dl.en, dl.cn)}</span></div>`
    : '';
  return `<div style="font-family: var(--f-mono); font-size: 11px; font-weight: 600;">${escapeHtml(carrier)} ${escapeHtml(o.tracking_number)}</div>
          <div style="margin-top: 2px;">${sync}</div>${dlLine}`;
}

// "Ship to" — the parcel's destination city (+ district below) so operators can
// triage where orders are headed without opening each one. Server fills
// ship_city/ship_district (canonical Chinese) + *_en companions, or ship_pickup.
// Addresses are stored Chinese-only, so the English side is resolved server-side
// (lib/region-i18n) and falls back to the Chinese name when the place is unknown.
// We emit explicit data-lang-block="en"/"cn" spans rather than relying on the
// auto-classifier (which would mis-pair the city/district divs) — the global CSS
// then toggles them instantly when the operator flips the EN/中文 switch.
function shipToLangBlock(en, cn) {
  // Fall back to the Chinese name in English view when no romanization exists,
  // so the column never blanks. (cn always present here.)
  return `<span data-lang-block="en">${escapeHtml(en || cn)}</span>`
       + `<span data-lang-block="cn">${escapeHtml(cn)}</span>`;
}
function renderShipToCell(o) {
  if (o.ship_pickup || o.fulfillment_type === 'pickup') {
    return `<span class="muted" style="font-size:11px;">${pickupIcon(11)} ${shipToLangBlock('Pickup','自提')}</span>`;
  }
  if (!o.ship_city) return '<span class="muted">—</span>';
  const district = (o.ship_district && o.ship_district !== o.ship_city)
    ? `<div class="muted" style="font-size: 11px; margin-top: 2px">${shipToLangBlock(o.ship_district_en, o.ship_district)}</div>`
    : '';
  return `<div><div>${shipToLangBlock(o.ship_city_en, o.ship_city)}</div>${district}</div>`;
}

let ORDERS_STORE_FILTER_LOADED = false;
async function ensureOrdersStoreFilter() {
  if (ORDERS_STORE_FILTER_LOADED) return;
  const sel = document.getElementById('orders-store');
  if (!sel) return;
  try {
    const r = await api('/api/retail-admin/stores');
    const stores = r.data || [];
    if (stores.length <= 1) return;     // No filter UI value with one store.
    const prev = sel.value;
    sel.innerHTML = '<option value="">All stores · 全部门店</option>' +
      stores.map(s => `<option value="${s.id}">${escapeHtml(s.name_en || s.code)}</option>`).join('');
    if (prev) sel.value = prev;
    // Change handler is now an inline onchange="loadOrders()" on the element.
    ORDERS_STORE_FILTER_LOADED = true;
  } catch (e) { /* silent — filter just stays minimal */ }
}

function humanStatus(s, fulfillmentType) {
  // Pickup reuses the dispatched/delivered statuses but they mean "ready at the
  // counter" and "collected by customer" (see retail.js progress tracker), so
  // relabel them for the operator instead of showing "Dispatched/Delivered".
  if (fulfillmentType === 'pickup') {
    if (s === 'dispatched') return 'Ready · 可取货';
    if (s === 'delivered')  return 'Picked up · 已取货';
  }
  return { pending_payment: 'Pending', paid: 'Paid', preparing: 'Preparing', dispatched: 'Dispatched', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded', awaiting_restock: 'Awaiting restock' }[s] || s;
}
function formatDate(iso) {
  if (!iso) return '';
  // SQLite stores timestamps in UTC as 'YYYY-MM-DD HH:MM:SS' (no zone marker).
  // Parse as UTC, then render in Guangzhou time (UTC+8) — the store's local
  // clock — so "Placed" matches the wall clock instead of showing raw UTC.
  let s = String(iso).trim().replace(' ', 'T');
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Date-only normalizer for fields like coupon expiry, where values may be
// stored in mixed formats ("2026-06-09", "2026/10/6"). Always renders a
// padded YYYY-MM-DD; falls back to the raw first-10 chars if unparseable.
function formatDateOnly(v) {
  if (!v) return '—';
  const m = String(v).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (!m) return String(v).slice(0, 10);
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

// Status transition button labels — bilingual per the EN · 中文 admin rule
// (project_roots_v2_bilingual_admin). Shown inside each order row's action
// column AND inside the open-order drawer's footer transition buttons.
const NEXT_STATUS = {
  pending_payment: [['paid', 'Mark paid · 标记已付款'], ['cancelled', 'Cancel · 取消']],
  paid:            [['preparing', 'Start preparing · 开始备货'], ['refunded', 'Refund · 退款'], ['cancelled', 'Cancel + refund · 取消并退款']],
  preparing:       [['dispatched', 'Mark dispatched · 标记已发货'], ['refunded', 'Refund · 退款'], ['cancelled', 'Cancel + refund · 取消并退款']],
  dispatched:      [['delivered', 'Mark delivered · 标记已送达'], ['refunded', 'Refund · 退款']],
  delivered:       [['refunded', 'Refund · 退款']],
  cancelled:       [],
  refunded:        [],
  // Awaiting-restock: customer paid + chose to wait. Kitchen can either
  // (a) jump to preparing once the missing items arrive, OR (b) cancel
  // + refund if the restock is taking too long. The automatic transition
  // also happens server-side via checkAwaitingRestockForRestock.
  awaiting_restock: [['preparing', 'Restocked → Start preparing · 已补货 → 开始备货'], ['cancelled', 'Cancel + refund · 取消并退款']],
};

// Pickup orders walk the same status machine but dispatched = "ready at counter"
// and delivered = "collected by the customer". Relabel the transition buttons so
// the operator gets a clear collection journey (Ready → Picked up) and a final
// "complete" step that records the customer actually came to collect.
const NEXT_STATUS_PICKUP_LABELS = {
  dispatched: 'Mark ready for pickup · 标记可取货',
  delivered:  'Mark picked up · 标记已取货',
};
function nextStatusFor(o) {
  const transitions = NEXT_STATUS[o.status] || [];
  if (o.fulfillment_type !== 'pickup') return transitions;
  return transitions.map(([next, label]) =>
    [next, NEXT_STATUS_PICKUP_LABELS[next] || label]);
}

// Sort modes for the items table inside an open order. Persisted per-order
// in memory; default = 'sku'.
let _ITEMS_SORT_MODE = 'sku';
let _OPEN_ORDER = null;
// When an order is opened from a customer's Recent-orders row, remember that
// customer's id so the order drawer can offer a "back to customer" button.
// Null when the order was opened any other way (orders list, etc).
let _ORDER_BACK_CUSTOMER = null;
// Scroll position of the customer drawer body at the moment we jumped to the
// order, so "← Back to customer" lands on the exact same Recent-orders row.
let _ORDER_BACK_CUSTOMER_SCROLL = 0;

function sortOrderItems(items, mode) {
  const arr = [...items];
  if (mode === 'sku') {
    return arr.sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));
  }
  if (mode === 'shipping') {
    // Air-only → mixed → land-only.
    const score = it => {
      const m = it.ship_modes_arr || ['air', 'land'];
      if (m.length === 1 && m[0] === 'air')  return 0;
      if (m.length === 1 && m[0] === 'land') return 2;
      return 1;
    };
    return arr.sort((a, b) => score(a) - score(b) || (a.sku || '').localeCompare(b.sku || ''));
  }
  return arr; // 'default' — preserves order as the customer placed it
}

function renderPackBadges(it) {
  const arr = it.ship_modes_arr || ['air', 'land'];
  // Local only = Guangzhou same-city item (never air/land). Surface it plainly
  // rather than falling through to the air/land restriction logic below.
  if (arr.length === 1 && arr[0] === 'local') {
    return '<span class="pack-badge land" title="Guangzhou local delivery only · 仅广州同城配送">Local · 仅广州</span>';
  }
  const hasAir  = arr.includes('air');
  const hasLand = arr.includes('land');
  const parts = [];
  // Use the variation-selector `︎` on the airplane/snow glyphs so they
  // render in text presentation (monochrome) instead of colour-emoji on
  // macOS / Windows. The truck glyph has no text-presentation form, so
  // for that case we use just text "Land" — the .pack-badge.land colour
  // already carries the semantic.
  // Both modes allowed = no constraint. Once the shipment is routed this is
  // pure noise — the shipment header already shows the chosen mode. Only
  // surface a badge when the item is RESTRICTED to one mode, which is a real
  // packing warning (e.g. "Land only — airline rejected").
  if (hasAir && hasLand) return '';
  if (hasAir)
    parts.push('<span class="pack-badge air" title="Air shipping only · 仅空运">✈︎ Air only · 仅空运</span>');
  else
    parts.push('<span class="pack-badge land" title="Land shipping only — airline rejected · 仅陆运">Land only · 仅陆运</span>');
  return parts.join('');
}

// Small product thumbnail for an order line item. Falls back to a neutral
// placeholder tile (so rows stay aligned) when the product has no photo or
// the image fails to load.
function itemThumb(it) {
  if (it.image_url) {
    return `<img class="oi-thumb" src="${escapeHtml(it.image_url)}" alt="" loading="lazy" onerror="this.classList.add('is-empty');this.removeAttribute('src');">`;
  }
  return `<span class="oi-thumb is-empty" aria-hidden="true"></span>`;
}

// ×N quantity chip — bolded (.qty-multi) whenever more than one unit was
// ordered so the operator can't miss a multi-unit line.
function itemQtyHtml(it) {
  return `<span class="item-qty${Number(it.qty) > 1 ? ' qty-multi' : ''}">×${it.qty}</span>`;
}

// SKU chip — shared across all item layouts (manifest / table / cards) so the
// packer's scan code reads identically in every view.
function itemSkuHtml(it) {
  return `<span class="item-sku">${it.sku ? escapeHtml(it.sku) : cuT('no SKU','无货号')}</span>`;
}

// Chosen customer options (dressing, paid extras) for an order line, parsed
// from options_json server-side into it.options = [{label, ...}]. Shown so the
// operator/packer sees "which dressing" — two same-SKU salads differ only here.
function itemOptionsHtml(it) {
  const isCn = typeof window !== 'undefined' && window.cuLang && window.cuLang() === 'cn';
  const txt = (Array.isArray(it.options) ? it.options : [])
    .map(o => {
      if (!o) return '';
      // Choice value (operator language wins; fall back to whichever exists).
      const val = (isCn && o.label_cn) ? o.label_cn : (o.label || o.label_cn || '');
      if (!val) return '';
      // Prefix the QUESTION so "Yes" reads as "Heat up?: Yes". Older orders or
      // deleted options may lack it — then just show the bare value.
      const q = (isCn && o.question_cn) ? o.question_cn : (o.question_en || '');
      return q ? `${escapeHtml(q)}: ${escapeHtml(val)}` : escapeHtml(val);
    })
    .filter(Boolean).join(' · ');
  return txt ? `<div class="oi-opts">▸ ${txt}</div>` : '';
}

// Which name is the bold headline vs. the muted second line. The operator's
// language wins: in Chinese mode the 中文 name leads and English drops below;
// in English mode it's the reverse (the long-standing default). Falls back to
// whichever name exists when one is missing. Accepts {name_en, name_cn}.
function orderItemNames(it) {
  const en = it.name_en || '';
  const cn = it.name_cn || '';
  const isCn = typeof window !== 'undefined' && window.cuLang && window.cuLang() === 'cn';
  if (isCn && cn) return { primary: cn, secondary: en };
  return { primary: en || cn, secondary: (en && cn) ? cn : '' };
}

// One line of the packing manifest. `opts.index` (1-based) renders the
// 01 / 02 … brass line number; `opts.showPack` toggles the pack badges.
function renderItemRow(it, opts = {}) {
  const showPack = opts.showPack !== false;
  const num = opts.index != null ? String(opts.index).padStart(2, '0') : '';
  const nm = orderItemNames(it);
  const name = `<span class="mf-name">${escapeHtml(nm.primary)}</span>`;
  const nameCell = it.product_id
    ? `<a href="/product-editor?id=${it.product_id}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${name}</a>`
    : name;
  const zh = (nm.secondary || it.size)
    ? `<span class="mf-zh">${escapeHtml(nm.secondary)}${it.size ? (nm.secondary ? ' · ' : '') + escapeHtml(it.size) : ''}</span>`
    : '';
  return `
    <div class="mf-row" data-fk="${it.id}">
      <span class="mf-num">${num}</span>
      ${itemThumb(it)}
      <div class="mf-body">
        <div class="mf-top">
          ${nameCell}
          <span class="mf-total">¥${fmt(it.line_total)}</span>
        </div>
        <div class="mf-meta" data-no-i18n>
          ${zh}
          ${itemSkuHtml(it)}
          ${itemQtyHtml(it)}
          <span class="item-unit">@ ¥${fmt(it.unit_price)}</span>
          ${showPack ? `<span class="mf-packs">${renderPackBadges(it)}</span>` : ''}
        </div>
        ${itemOptionsHtml(it)}
        ${renderBundleInside(it)}
      </div>
    </div>`;
}

function renderSortChips() {
  const mk = (val, label) =>
    `<div class="sort-chip ${_ITEMS_SORT_MODE === val ? 'active' : ''}" onclick="setItemsSort('${val}')">${label}</div>`;
  // Emoji-prefixed labels ("❄ Packaging", "✈🚚 Shipping") rendered as the
  // colour-emoji presentation on macOS/Win and clashed with the monochrome
  // admin chrome. Dropped — the chip already conveys the sort via the
  // active state; text labels read cleaner and bilingual now.
  return `<div class="sort-chips">
    <span class="sort-label">Sort items · 排序:</span>
    ${mk('sku',       'SKU')}
    ${mk('shipping',  'Shipping · 配送')}
    ${mk('default',   'As ordered · 原顺序')}
  </div>`;
}

// Chips + shipment cards, re-rendered together. Kept in one container so a
// sort change only swaps this fragment — re-rendering the whole order would
// tear down any open floating window (tracking popover, etc.).
function renderSortableItems(o) {
  const ships = o.shipments || [];
  // Items grouped into parcels render in their shipment card. Anything NOT in a
  // parcel — a pending order before its parcels are assigned, a pickup order
  // (no shipments at all), or an orphaned row — would otherwise vanish from the
  // drawer (taking its dressing/extras with it). Render those in a fallback
  // block so EVERY ordered line + its options always shows, in every status.
  const inParcel = new Set();
  ships.forEach(s => (s.items || []).forEach(it => inParcel.add(it.id)));
  const loose = (o.items || []).filter(it => !inParcel.has(it.id));
  let looseHtml = '';
  if (loose.length) {
    looseHtml = ships.length
      ? `<div class="shipment-card"><div class="shipment-head">
           <span class="mode-pill">📦 Not yet in a parcel · 待分配</span>
           <span class="count">${cuT(`${loose.length} item${loose.length === 1 ? '' : 's'}`, `${loose.length} 件商品`)}</span>
         </div>${renderItemsTable(loose, true)}</div>`
      : renderItemsTable(loose, true);   // pickup / no-parcel order: plain list
  }
  return renderSortChips()
    + ships.map(s => renderShipmentCard(o, s)).join('')
    + looseHtml;
}

function setItemsSort(mode) {
  if (mode === _ITEMS_SORT_MODE) return;
  _ITEMS_SORT_MODE = mode;
  // Defer the swap: replacing innerHTML synchronously detaches the clicked
  // chip mid-click, so the drawer's click-outside handler sees a detached
  // target and dismisses the drawer. rAF lets the click finish bubbling first.
  requestAnimationFrame(() => {
    const host = document.getElementById('odv-items-sortable');
    if (!host || !_OPEN_ORDER) {
      if (_OPEN_ORDER) renderOpenOrder(_OPEN_ORDER);
      return;
    }
    flipReorder(host, () => { host.innerHTML = renderSortableItems(_OPEN_ORDER); });
  });
}

// FLIP: rows carry a stable data-fk. Snapshot each row's box, swap the HTML,
// then play every row from its old box to its new one so the re-sort glides
// instead of snapping. Honours prefers-reduced-motion.
function flipReorder(host, swap) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { swap(); return; }
  const first = new Map();
  host.querySelectorAll('[data-fk]').forEach(el => first.set(el.dataset.fk, el.getBoundingClientRect()));
  swap();
  host.querySelectorAll('[data-fk]').forEach(el => {
    const a = first.get(el.dataset.fk);
    if (!a) return;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (!dx && !dy) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 360ms cubic-bezier(.22,.61,.36,1)';
      el.style.transform = '';
      el.addEventListener('transitionend', () => {
        el.style.transition = '';
        el.style.transform = '';
      }, { once: true });
    });
  });
}

// Items render as a numbered packing manifest (per shipment) by default.
// The operator's View tweak (ODV.itemsLayout) can swap to a column table or
// stacked cards. Sort order is preserved from sortOrderItems so the
// Packaging / SKU / Shipping chips still re-order the list.
function renderItemsTable(items, showPack = true) {
  const sorted = sortOrderItems(items, _ITEMS_SORT_MODE);
  if (ODV.itemsLayout === 'table') return renderItemsAsGrid(sorted, showPack);
  if (ODV.itemsLayout === 'cards') return renderItemsAsCards(sorted, showPack);
  return `<div class="manifest">
    ${sorted.map((it, i) => renderItemRow(it, { showPack, index: i + 1 })).join('')}
  </div>`;
}

// Items layout · TABLE — aligned columns (Item / Qty / Unit / Total / Pack).
// Bundle line → a small "Inside" pack list so whoever fulfils the order knows
// exactly what to box. pack_qty = per-bundle qty × this line's qty (server-set).
function renderBundleInside(it) {
  if (!it || !it.is_bundle || !Array.isArray(it.bundle_components) || !it.bundle_components.length) return '';
  const rows = it.bundle_components.map(c => {
    const bn = orderItemNames(c);
    const nm = escapeHtml(bn.primary || ('#' + c.id));
    const cn = bn.secondary ? ` <span class="oi-bndl-zh">${escapeHtml(bn.secondary)}</span>` : '';
    // Each component's OWN sku — this is what gets packed/printed; the bundle's
    // own sku is irrelevant to fulfilment.
    const sku = `<span class="item-sku oi-bndl-sku">${c.sku ? escapeHtml(c.sku) : cuT('no SKU','无货号')}</span>`;
    return `<div class="oi-bndl-row"><span class="oi-bndl-qty">${c.pack_qty}×</span>${sku}<span>${nm}${cn}</span></div>`;
  }).join('');
  return `<div class="oi-bndl"><div class="oi-bndl-h">${cuT('Inside this bundle', '套装内含')}</div>${rows}</div>`;
}

function renderItemsAsGrid(items, showPack = true) {
  const head = `<div class="oi-th">
    <span>Item · 商品</span>
    <span style="text-align:center">Qty · 数量</span>
    <span style="text-align:right">Unit · 单价</span>
    <span style="text-align:right">Total · 小计</span>
    <span style="text-align:right">Pack · 包装</span>
  </div>`;
  const rows = items.map(it => {
    const nn = orderItemNames(it);
    const nm = `<span class="oi-name">${escapeHtml(nn.primary)}</span>`;
    const nameCell = it.product_id
      ? `<a href="/product-editor?id=${it.product_id}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${nm}</a>`
      : nm;
    const zh = (nn.secondary || it.size)
      ? `<div class="oi-zh">${escapeHtml(nn.secondary)}${it.size ? (nn.secondary ? ' · ' : '') + escapeHtml(it.size) : ''}</div>` : '';
    return `<div class="oi-row" data-fk="${it.id}">
      <div style="min-width:0; display:flex; align-items:center; gap:var(--s3);">
        ${itemThumb(it)}
        <div style="min-width:0">${nameCell}${zh}<div style="margin-top:4px">${itemSkuHtml(it)}</div>${itemOptionsHtml(it)}${renderBundleInside(it)}</div>
      </div>
      <span class="oi-c">${itemQtyHtml(it)}</span>
      <span class="oi-r">¥${fmt(it.unit_price)}</span>
      <span class="oi-total">¥${fmt(it.line_total)}</span>
      <span class="oi-packs">${showPack ? renderPackBadges(it) : ''}</span>
    </div>`;
  }).join('');
  return `<div class="oi-grid">${head}${rows}</div>`;
}

// Items layout · CARDS — each line a bordered card, total emphasised.
function renderItemsAsCards(items, showPack = true) {
  const cards = items.map(it => {
    const nn = orderItemNames(it);
    const nm = `<span class="oic-name">${escapeHtml(nn.primary)}</span>`;
    const nameCell = it.product_id
      ? `<a href="/product-editor?id=${it.product_id}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${nm}</a>`
      : nm;
    const zh = (nn.secondary || it.size)
      ? `<div class="oic-zh">${escapeHtml(nn.secondary)}${it.size ? (nn.secondary ? ' · ' : '') + escapeHtml(it.size) : ''}</div>` : '';
    return `<div class="oic" data-fk="${it.id}">
      <div class="oic-top">
        <div style="min-width:0; display:flex; align-items:center; gap:var(--s3);">
          ${itemThumb(it)}
          <div style="min-width:0">${nameCell}${zh}</div>
        </div>
        <span class="oic-total">¥${fmt(it.line_total)}</span>
      </div>
      <div class="oic-bot">
        ${itemSkuHtml(it)}
        ${itemQtyHtml(it)}
        <span class="item-unit">@ ¥${fmt(it.unit_price)}</span>
        ${showPack ? `<span class="oic-packs">${renderPackBadges(it)}</span>` : ''}
      </div>
      ${itemOptionsHtml(it)}
      ${renderBundleInside(it)}
    </div>`;
  }).join('');
  return `<div class="oi-cards">${cards}</div>`;
}

// Monochrome line icons for shipment modes — inherit currentColor so they sit
// flat in the muted admin chrome (colour emoji clashed; see sort-chip note).
function shipGlyph(mode) {
  const open = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex:none">';
  if (mode === 'air')
    return open + '<path d="M21 15.5 13 13V6a1 1 0 0 0-2 0v7l-8 2.5V17l8-1.5V20l-2.5 1.5V23L12 22l3.5 1.5V21.5L13 20v-4.5l8 1.5z"/></svg>';
  if (mode === 'local')
    return open + '<path d="M4 11l8-6 8 6"/><path d="M6 10v9h12v-9"/></svg>';
  return open + '<path d="M2.5 6.5h11v8h-11z"/><path d="M13.5 9h4l4 3.5v2h-8z"/><circle cx="6.5" cy="16.5" r="1.6"/><circle cx="17.5" cy="16.5" r="1.6"/></svg>';
}

// Per-shipment fulfillment pill. 'pending' uses the neutral base pill; the
// other two reuse the order-status pill colours.
function shipmentStatePill(s) {
  const st = s.state || 'pending';
  const map = {
    pending:    ['',              'Not shipped · 未发货'],
    dispatched: ['st-dispatched', 'Dispatched · 已发货'],
    delivered:  ['st-delivered',  'Delivered · 已送达'],
  };
  const [cls, label] = map[st] || map.pending;
  return `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
}

// Render one shipment block: header pill + items table + tracking row.
function renderShipmentCard(o, s) {
  const mode = s.mode || 'local';
  const labelMap = {
    air:   shipGlyph('air')   + ' Air shipment · 空运',
    land:  shipGlyph('land')  + ' Land shipment · 陆运',
    local: shipGlyph('local') + ' Local delivery · 同城配送',
  };
  // Line count vs. unit count: warehouse cross-checks the physical pick
  // against total units, so surface units whenever a multi-qty line makes
  // them diverge from the line count (e.g. "4 lines · 6 units").
  const lines = s.items.length;
  const units = (s.items || []).reduce((n, it) => n + (Number(it.qty) || 0), 0);
  const countLabel = units !== lines
    ? `<span data-lang-block="en">${lines} line${lines === 1 ? '' : 's'} · ${units} units</span><span data-lang-block="cn">${lines} 项 · ${units} 件</span>`
    : `<span data-lang-block="en">${lines} item${lines === 1 ? '' : 's'}</span><span data-lang-block="cn">${lines} 件商品</span>`;
  const state = s.state || 'pending';
  // Per-shipment dispatch is offered once the order is paid (or later) and this
  // parcel hasn't shipped. The order being 'dispatched' doesn't block it — a
  // partially-shipped order keeps un-shipped parcels actionable.
  const canDispatch = state === 'pending' &&
    ['paid', 'preparing', 'dispatched'].includes(o.status) &&
    o.fulfillment_type !== 'pickup';
  // "Ship part later" splits this parcel in two. Only meaningful when the
  // parcel is still pending and holds 2+ lines (must leave one behind).
  const canSplit = state === 'pending' && lines >= 2;
  const actions = (canDispatch || canSplit) ? `
      <div class="row" style="gap:8px; flex-wrap:wrap; margin-top: var(--s3);">
        ${canDispatch ? `<button class="btn btn-primary btn-sm" onclick="dispatchShipment(${o.id}, ${s.id})">Mark this parcel dispatched · 标记此包裹已发货</button>` : ''}
        ${canSplit ? `<button class="btn btn-sm" onclick="toggleSplitPanel(${s.id})">Ship part later · 分批发货</button>` : ''}
      </div>
      ${canSplit ? renderSplitPanel(o, s) : ''}` : '';
  return `
    <div class="shipment-card mode-${mode}">
      <div class="shipment-head">
        <span class="mode-pill mode-${mode}">${labelMap[mode] || s.label}</span>
        <span class="count">${countLabel}</span>
        ${shipmentStatePill(s)}
      </div>
      ${renderItemsTable(s.items, false)}
      ${actions}
      ${mode === 'local'
        ? (['paid', 'preparing', 'dispatched', 'delivered'].includes(o.status) ? renderLocalEtaCard(o, s) : '')
        : ''}
    </div>`;
  // Carrier tracking for a dispatched/delivered parcel is NOT rendered here —
  // it's hoisted to the top of the drawer (hoistedTracking) so the operator can
  // add a waybill + watch status the moment the order ships, no scrolling.
  // Local same-city parcels keep their ETA card in place (above), no waybill.
}

// Once a parcel is on its way, its tracking is the one thing the operator
// watches — so for any dispatched/delivered non-local parcel we lift the
// tracking card out of the buried items section up to the top of the drawer,
// directly under the status actions. Multi-parcel orders stack one card per
// shipped parcel, each labelled. Returns '' when nothing is shipped yet.
function hoistedTracking(o) {
  const all = o.shipments || [];
  const multi = all.length > 1;
  const cards = all.map((s, i) => {
    if ((s.mode || 'local') === 'local') return '';
    if (!['dispatched', 'delivered'].includes(s.state || 'pending')) return '';
    const label = multi
      ? `<div class="od-trk-parcel">${cuT(`Parcel ${i + 1}`, `包裹 ${i + 1}`)}</div>`
      : '';
    return label + renderShipmentTrackingCard(o, s, true);
  }).filter(Boolean);
  if (!cards.length) return '';
  return `<div class="od-tracking-top">${cards.join('')}</div>`;
}

// Local (Guangzhou same-city) delivery has no waybill, so it gets an ETA card
// instead of the carrier tracking card: the operator picks a same-day arrival
// time the customer sees on their order page. Stored on the shipment row as a
// 24h "HH:MM" string. Editable from 'paid' onward (the rider's arrival window
// is usually known before the parcel is marked out for delivery).
function renderLocalEtaCard(o, s) {
  const sid = s.id;
  const eta = s.local_eta || '';            // 'HH:MM' 24h, or '' when unset
  const pretty = eta ? formatEtaPretty(eta) : '';
  return `
    <div style="margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line-soft);" id="eta-card-${sid}">
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-3); margin-bottom: var(--s2);">Delivery time · 送达时间</div>
      ${eta ? `
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:10px 12px; background: var(--bg-elev-1); border-radius:6px; margin-bottom:10px;">
          <div>
            <div style="font-size:12px; color:var(--text-3);">Estimated arrival · 预计送达</div>
            <div style="font-family: var(--f-mono); font-weight:600; font-size:15px;">${escapeHtml(pretty)}</div>
          </div>
          <div style="flex:1; min-width:120px; text-align:right;">
            <span class="muted" style="font-size:11px;">Shown to the customer · 已展示给顾客</span>
          </div>
        </div>` : ''}
      <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
        <input type="time" id="eta-time-${sid}" value="${escapeHtml(eta)}" style="min-width:140px; font-family: var(--f-mono);">
        <button class="btn ${eta ? 'btn-primary' : ''} btn-sm" onclick="saveLocalEta(${o.id}, ${sid}, event)">${eta ? 'Update time · 更新时间' : 'Set arrival time · 设置送达时间'}</button>
        ${eta ? `<button class="btn btn-sm" onclick="clearLocalEta(${o.id}, ${sid}, event)">Clear · 清除</button>` : ''}
      </div>
      <div class="muted" style="font-size:11px; margin-top:6px;">Same-city delivery — set when the rider should arrive; the customer sees this on their order. · 同城配送 — 设置骑手预计送达时间,顾客可在订单中查看。</div>
    </div>`;
}

// Stored ETA is a 24h "HH:MM"; render it on a 12h clock for the office card.
function formatEtaPretty(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return hhmm || '';
  const h = parseInt(m[1], 10);
  const h12 = (h % 12) || 12;
  return `${h12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

// Inline "ship part later" panel — checkbox list of this parcel's items.
// Hidden until toggled. Submitting moves the checked items into a new
// "to follow" shipment so the rest can ship now.
function renderSplitPanel(o, s) {
  const rows = (s.items || []).map(it => `
    <label class="row" style="gap:8px; align-items:center; padding:4px 0; cursor:pointer;">
      <input type="checkbox" class="split-pick-${s.id}" value="${it.id}">
      <span style="flex:1; min-width:0;">${escapeHtml(it.name_en || it.name_cn || ('#' + it.id))}${it.size ? ` · ${escapeHtml(it.size)}` : ''}${it.sku ? ` <span class="item-sku">${escapeHtml(it.sku)}</span>` : ''}</span>
      <span class="muted" style="font-size:12px;">×${it.qty}</span>
    </label>`).join('');
  return `
    <div id="split-panel-${s.id}" class="split-panel" style="display:none; margin-top: var(--s3); padding: var(--s3); border:1px dashed var(--line); border-radius:8px;">
      <div class="muted" style="font-size:11px; margin-bottom:6px;">Tick the items that ship <b>later</b> — they move to a new follow-up parcel and the rest stays here to ship now. · 勾选稍后发货的商品,移入新的后补包裹。</div>
      ${rows}
      <div class="row" style="gap:8px; margin-top: var(--s3);">
        <button class="btn btn-primary btn-sm" onclick="submitShipmentSplit(${o.id}, ${s.id})">Move to follow-up parcel · 移入后补包裹</button>
        <button class="btn btn-sm" onclick="toggleSplitPanel(${s.id})">Cancel · 取消</button>
      </div>
    </div>`;
}

async function openOrder(id, opts = {}) {
  _OPEN_ORDER = null;
  _ORDER_BACK_CUSTOMER = null;
  _ODV_OPEN = false;               // View popover starts closed on a fresh open
  _ODM_OPEN = false;               // Refund/Cancel menu likewise closed on open
  const mount = $('#order-detail-mount');
  const drawer = document.getElementById('order-drawer');
  // Switching orders in an already-open drawer → cross-fade: hold the old
  // content visible, fade the whole mount out, then render the new order into
  // the hidden mount and fade it back in. A fresh open keeps the old behavior
  // (drawer slide + per-child settle do the entrance) and shows "Loading…".
  // `instant` is for re-opening the SAME order after a mutation (e.g. mark-paid):
  // there's nothing to cross-fade between, so render in place and never touch
  // od-swapping — that opacity dance is what could otherwise strand the mount
  // invisible if anything raced the fade.
  mount.classList.remove('od-swapping');
  const switching = !opts.instant && drawer && drawer.classList.contains('open') && mount.children.length > 0;
  const fetchP = Promise.all([
    api('/api/retail-admin/orders/' + id),
    ensureTrackingCarriers(),
  ]);
  const drawerOpen = drawer && drawer.classList.contains('open');
  if (!switching) {
    if (opts.instant && drawerOpen) {
      // Re-rendering the same order in place: keep the old content on screen
      // until the fresh data lands — no "Loading…" flash, no slide.
    } else {
      mount.innerHTML = '<div class="order-card muted">Loading order… · 正在加载订单…</div>';
      openDrawer('#order-drawer');
    }
  }
  // When switching, we deliberately do NOT fade out up-front. The old code
  // added .od-swapping immediately, then awaited max(fetch, 396ms) with the
  // mount already invisible — so a slow fetch stranded the drawer on a blank,
  // faded panel for the entire network round-trip (the "stuck, takes longer
  // than usual" stutter). Instead: keep the current order fully visible while
  // we fetch, then run a bounded 396ms cross-fade once the data is in hand.
  try {
    const o = (await fetchP)[0].data;
    _OPEN_ORDER = o;
    if (switching) {
      mount.classList.add('od-swapping');                       // fade old out (317ms)
      await new Promise(r => setTimeout(r, 317));
      renderOpenOrder(o);                                       // swap into hidden mount
      requestAnimationFrame(() => mount.classList.remove('od-swapping'));  // fade new in
    } else {
      renderOpenOrder(o);
    }
    // The GET above stamped seen_at server-side (shared across staff). Clear
    // this row's unread treatment immediately so it doesn't wait for the next
    // poll; a later list rebuild reflects the server seen_at and stays cleared.
    const _row = document.querySelector('tr.order-row[data-order-id="' + id + '"]');
    if (_row) {
      _row.classList.remove('is-unread');
      const _chip = _row.querySelector('.new-chip');
      if (_chip) _chip.remove();
    }
  } catch (e) {
    mount.innerHTML = `<div class="order-card err">Failed · 失败: ${escapeHtml(e.message)}</div>`;
    mount.classList.remove('od-swapping');
  }
}

// Generic side-drawer open/close. Shared across Orders, Customers,
// Logistics, Media, Pop-ups. No backdrop, no click-outside-close —
// the list under it stays interactive so users can jump between
// records rapidly. ESC anywhere closes the topmost open drawer.
//
// onClose hooks let consumers clear their mount nodes after the
// slide-out animation finishes (so the next open starts blank).
const _drawerCloseHooks = new Map();
function onDrawerClose(sel, fn) { _drawerCloseHooks.set(sel, fn); }
function openDrawer(sel) {
  const d = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!d) return;
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
}
function closeDrawer(sel) {
  const d = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!d) return;
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  const key = typeof sel === 'string' ? sel : '#' + d.id;
  const hook = _drawerCloseHooks.get(key);
  if (hook) setTimeout(hook, 240);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll('.side-drawer.open');
  if (!open.length) return;
  closeDrawer(open[open.length - 1]);
});
// Click-outside-to-close for the read drawers (Orders, Customers) —
// clicking the empty page area beside an open drawer dismisses it (mouse
// parity with ESC). Clicks inside any drawer, on a record row (which
// switches records), or that end a text selection (drag-to-copy) are left
// alone. Only the read drawers opt in via `dw-dismiss`; editor drawers
// stay no-dismiss so an accidental outside-click can't drop unsaved edits.
document.addEventListener('click', (e) => {
  const open = document.querySelectorAll('.side-drawer.dw-dismiss.open');
  if (!open.length) return;
  // A self-removing overlay (e.g. the "Paid how?" pay-method picker) deletes
  // itself on click, then that same click keeps bubbling here with a target
  // that's already detached from the DOM. closest() on a detached node can't
  // see the modal it lived in, so it would read as an outside-click and wrongly
  // close the drawer — wiping the order body during the mark-paid re-render.
  // A detached target is never a real outside-click, so bail.
  if (!e.target.isConnected) return;
  if (e.target.closest('.side-drawer')) return;
  // A `.pu-editor-bg` modal (Edit / Adjust / Address) layers on top of the
  // drawer but lives outside it in the DOM — clicks inside the modal, incl.
  // its Close button, must not dismiss the drawer behind it.
  if (e.target.closest('.pu-editor-bg')) return;
  // Dashboard activity rows open the order drawer on click — that same click
  // bubbles here, so exempt them or the drawer closes the instant it opens.
  // .rm-ocard / .rm-cucard = the mobile order/customer cards (Variant A), which
  // also open their detail drawer on tap. .rm-sheet = the shared mobile
  // Sort/Manage bottom sheet, whose "Open full details" row opens the order
  // drawer — without this the opening tap bubbles here and closes it instantly.
  if (e.target.closest('tr.order-row, tr.cu-row, .db-feed-row, .rm-ocard, .rm-cucard, .rm-sheet')) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.toString().length > 0) return;
  closeDrawer(open[open.length - 1]);
});
// Order-drawer cleanup hook — clear the mount after slide-out.
onDrawerClose('#order-drawer', () => {
  const m = document.getElementById('order-detail-mount');
  if (m) m.innerHTML = '';
  _OPEN_ORDER = null;
});

// Row-click → open. Delegated so it survives table re-renders. Bails when
// the click landed on an interactive child (button, link, input) so those
// keep working, and when the user is selecting text (drag-to-copy).
document.addEventListener('click', (e) => {
  const row = e.target.closest('tr.order-row');
  if (!row) return;
  if (e.target.closest('button, a, input, select, textarea, label')) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.toString().length > 0) return;
  const id = row.dataset.orderId;
  if (id) openOrder(Number(id));
});
// Enter / Space on a focused row opens it — keyboard parity.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = document.activeElement && document.activeElement.closest && document.activeElement.closest('tr.order-row');
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.orderId;
  if (id) openOrder(Number(id));
});

// ── Order detail · per-operator View tweaks ───────────────────────────
// The Full Circle Order Detail "Tweaks" panel, made operator-selectable:
// total placement (banner / inline / footer), items layout (manifest /
// table / cards), and density. Persisted to localStorage; defaults match
// the standard banner+manifest look so nothing changes until a pick.
const ORDER_DETAIL_TWEAK_DEFAULTS = { totalPlacement: 'banner', itemsLayout: 'manifest', density: 'comfortable' };
function odvLoad() {
  try { return { ...ORDER_DETAIL_TWEAK_DEFAULTS, ...(JSON.parse(localStorage.getItem('retail-admin-order-detail-tweaks') || '{}')) }; }
  catch (e) { return { ...ORDER_DETAIL_TWEAK_DEFAULTS }; }
}
let ODV = odvLoad();
let _ODV_OPEN = false;
function odvSet(key, val) {
  ODV[key] = val;
  try { localStorage.setItem('retail-admin-order-detail-tweaks', JSON.stringify(ODV)); } catch (e) {}
  _ODV_OPEN = false;                      // close the popover once a view is chosen
  document.removeEventListener('mousedown', odvOutside);
  // Defer the re-render to the next tick. Re-rendering synchronously inside
  // the click handler detaches the clicked button before the drawer's
  // click-outside-to-dismiss handler runs; that handler's `closest('.side-drawer')`
  // guard then fails on the orphaned target and closes the whole drawer.
  // Deferring lets the click fully resolve (button still attached → no dismiss)
  // before we rebuild. Preserve scroll so the drawer doesn't jump to the top.
  if (_OPEN_ORDER) setTimeout(() => {
    if (!_OPEN_ORDER) return;
    const body = document.querySelector('#order-drawer .drawer-body');
    const y = body ? body.scrollTop : 0;
    renderOpenOrder(_OPEN_ORDER);
    if (body) body.scrollTop = y;
  }, 0);
}
function odvToggle() {
  _ODV_OPEN = !_ODV_OPEN;
  const pop = document.getElementById('odv-pop'); if (pop) pop.hidden = !_ODV_OPEN;
  if (_ODV_OPEN) setTimeout(() => document.addEventListener('mousedown', odvOutside), 0);
  else document.removeEventListener('mousedown', odvOutside);
}
function odvOutside(e) {
  if (e.target.closest && e.target.closest('.ovp-wrap')) return;
  _ODV_OPEN = false;
  const pop = document.getElementById('odv-pop'); if (pop) pop.hidden = true;
  document.removeEventListener('mousedown', odvOutside);
}
function odvBtn(key, val, label) {
  return `<button data-v="${val}" class="${ODV[key] === val ? 'active' : ''}" onclick="odvSet('${key}','${val}')">${label}</button>`;
}
// Refund / Cancel actions collapse into ONE button that opens a small menu.
// Before, "Refund" and "Cancel + refund" sat side by side as two red buttons
// in the drawer header — the operator asked for a single button with the
// choices one tap deeper. With only one danger action (e.g. a dispatched
// order can only be refunded, not cancelled) it stays a plain button — a
// one-item menu would just be friction.
let _ODM_OPEN = false;
function renderRefundMenu(o, dangerTx) {
  if (!dangerTx.length) return '';
  if (dangerTx.length === 1) {
    const [next, label] = dangerTx[0];
    return `<button class="btn btn-danger btn-sm" onclick="transition(${o.id}, '${next}')">${label}</button>`;
  }
  const items = dangerTx.map(([next, label]) =>
    `<button class="odm-item" onclick="orderDangerPick(${o.id}, '${next}')">${label}</button>`
  ).join('');
  return `
    <div class="ovp-wrap odm-wrap">
      <button class="btn btn-danger btn-sm" id="odm-btn" onclick="orderDangerToggle()" aria-haspopup="true">
        ${cuT('Refund / Cancel', '退款 / 取消')}
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:3px;"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div id="odm-pop" class="ovp odm-pop" hidden>
        <div class="ovp-head">${cuT('Refund options', '退款选项')}</div>
        ${items}
      </div>
    </div>`;
}
function orderDangerToggle() {
  _ODM_OPEN = !_ODM_OPEN;
  const pop = document.getElementById('odm-pop'); if (pop) pop.hidden = !_ODM_OPEN;
  if (_ODM_OPEN) setTimeout(() => document.addEventListener('mousedown', orderDangerOutside), 0);
  else document.removeEventListener('mousedown', orderDangerOutside);
}
function orderDangerOutside(e) {
  if (e.target.closest && e.target.closest('.odm-wrap')) return;
  orderDangerClose();
}
function orderDangerClose() {
  _ODM_OPEN = false;
  const pop = document.getElementById('odm-pop'); if (pop) pop.hidden = true;
  document.removeEventListener('mousedown', orderDangerOutside);
}
function orderDangerPick(id, next) {
  orderDangerClose();
  transition(id, next);
}
function renderOrderViewPopover() {
  return `
    <div class="ovp-wrap" style="margin-right: 40px; flex-shrink: 0;">
      <button class="btn btn-sm" id="odv-btn" onclick="odvToggle()" aria-haspopup="true" title="Display options · 显示选项">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M4 12h7M4 18h10"/><circle cx="18" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>
        View · 视图
      </button>
      <div id="odv-pop" class="ovp" ${_ODV_OPEN ? '' : 'hidden'}>
        <div class="ovp-head">Display options · 显示选项</div>
        <div class="ovp-group">
          <div class="ovp-label">Total placement · 总额位置</div>
          <div class="ovp-seg">
            ${odvBtn('totalPlacement', 'banner', 'Banner · 横幅')}
            ${odvBtn('totalPlacement', 'inline', 'Inline · 行内')}
            ${odvBtn('totalPlacement', 'footer', 'Footer · 底栏')}
          </div>
        </div>
        <div class="ovp-group">
          <div class="ovp-label">Items layout · 商品布局</div>
          <div class="ovp-seg">
            ${odvBtn('itemsLayout', 'manifest', 'Manifest · 清单')}
            ${odvBtn('itemsLayout', 'table', 'Table · 表格')}
            ${odvBtn('itemsLayout', 'cards', 'Cards · 卡片')}
          </div>
        </div>
        <div class="ovp-group">
          <div class="ovp-label">Density · 密度</div>
          <div class="ovp-seg">
            ${odvBtn('density', 'comfortable', 'Comfortable · 舒适')}
            ${odvBtn('density', 'compact', 'Compact · 紧凑')}
            ${odvBtn('density', 'editorial', 'Editorial · 宽松')}
          </div>
        </div>
      </div>
    </div>`;
}
function renderOrderTotalBanner(o) {
  return `
    <div class="order-total-banner">
      <div>
        <div class="otb-label">Order total · 订单总额</div>
        <div class="otb-sub">${cuT('subtotal','小计')} ¥${fmt(o.subtotal)} · ${cuT('shipping','运费')} ¥${fmt(o.shipping_fee)}${o.voucher_amount ? ' · ' + cuT('voucher','优惠券') + ' −¥' + fmt(o.voucher_amount) : ''}</div>
      </div>
      <div class="otb-amount">¥${fmt(o.total)}</div>
    </div>`;
}
function renderOrderTotalInline(o) {
  return `
    <div class="od-total-inline">
      <div class="kicker">Order total · 订单总额</div>
      <div class="od-total-big">¥${fmt(o.total)}</div>
      <div class="od-total-sub">${cuT('subtotal','小计')} ¥${fmt(o.subtotal)} · ${cuT('shipping','运费')} ¥${fmt(o.shipping_fee)}${o.voucher_amount ? ' · ' + cuT('voucher','优惠券') + ' −¥' + fmt(o.voucher_amount) : ''}</div>
    </div>`;
}
function renderOrderTotalFooter(o, transitionsHtml) {
  return `
    <div class="order-total-banner otb-footer">
      <div>
        <div class="otb-label">Order total · 订单总额</div>
        <div class="otb-sub">${cuT('subtotal','小计')} ¥${fmt(o.subtotal)} · ${cuT('shipping','运费')} ¥${fmt(o.shipping_fee)}${o.voucher_amount ? ' · ' + cuT('voucher','优惠券') + ' −¥' + fmt(o.voucher_amount) : ''}</div>
      </div>
      <div class="otb-amount">¥${fmt(o.total)}</div>
      ${transitionsHtml ? `<div class="otb-actions">${transitionsHtml}</div>` : ''}
    </div>`;
}

function renderOpenOrder(o) {
  const mount = $('#order-detail-mount');
  const multiParcel = (o.shipments?.length || 0) > 1;
  // Split the status actions: the green "go forward" ones stay as plain
  // buttons; the red refund-type ones (Refund / Cancel + refund) collapse
  // into a single menu button so the header isn't a wall of red.
  const allTx = nextStatusFor(o);
  const dangerTx = allTx.filter(([next]) => next === 'cancelled' || next === 'refunded');
  const transitions = allTx.filter(([next]) => next !== 'cancelled' && next !== 'refunded')
    .map(([next, label]) => {
      // With multiple parcels the whole-order dispatch acts as "ship all at
      // once" — relabel so it's distinct from each parcel's own button.
      if (next === 'dispatched' && multiParcel && o.fulfillment_type !== 'pickup') {
        label = 'Mark all dispatched · 全部标记已发货';
      }
      return `<button class="btn btn-primary btn-sm" onclick="transition(${o.id}, '${next}')">${label}</button>`;
    }).join('')
    // A quiet "Undo" sits beside the forward actions when the order was
    // dispatched/delivered but nothing has truly gone out — the reverse for a
    // misclick. Label tracks which step is being undone.
    + (undoDispatchable(o)
        ? `<button class="btn btn-sm" onclick="undoDispatch(${o.id})">${o.status === 'delivered' ? 'Undo delivery · 撤销送达' : 'Undo dispatch · 撤销发货'}</button>`
        : '')
    + renderRefundMenu(o, dangerTx);
    mount.innerHTML = `
      <div class="order-card odd-${ODV.density}">
        ${_ORDER_BACK_CUSTOMER ? `<button class="btn btn-sm order-back-cust" style="margin-bottom: var(--s3);" onclick="cuBackToCustomer()">← Back to customer · 返回顾客</button>` : ''}
        <div class="order-head">
          <div class="od-head-main">
            <div class="title-row">
              <b>${escapeHtml(o.order_no)}</b>
              <span class="pill st-${o.status}"><span class="dot"></span>${humanStatus(o.status, o.fulfillment_type)}</span>
              ${o.fulfillment?.rollup === 'partial' ? `<span class="pill st-preparing"><span class="dot"></span>Partially shipped · 部分发货 (${o.fulfillment.dispatched}/${o.fulfillment.total})</span>` : ''}
              ${refundBadge(o)}
            </div>
            <div class="od-eyebrow">Order placed ${formatDate(o.placed_at)} · 下单于 ${formatDate(o.placed_at)}</div>
          </div>
          <!-- Primary status actions (Mark delivered / Refund …) live up here by
               the status pill — they used to be buried at the bottom of the
               drawer past the items + reservations. -->
          ${transitions ? `<div class="transitions od-head-tx">${transitions}</div>` : ''}
          ${renderOrderViewPopover()}
        </div>

        ${hoistedTracking(o)}

        ${drawerRefundBanner(o)}
        ${renderRefundPanel(o)}

        <!-- Order total — placement is an operator View tweak: a full-width
             hero banner here (default), an inline tile in the info grid, or a
             sticky footer receipt at the bottom. -->
        ${ODV.totalPlacement === 'banner' ? renderOrderTotalBanner(o) : ''}

        <div class="order-detail">
          ${o.fulfillment_type === 'pickup' ? `
          <div>
            <div class="kicker">${pickupIcon(11)} Pickup · 到店自提 ${copyChip([o.recipient_name, o.recipient_phone, (o.address?.store_name_cn || o.store_name_cn || ''), (o.address?.address || '')].filter(Boolean).join('\n'), 'Pickup')}</div>
            <div class="val"><b>${escapeHtml(o.recipient_name || '')}</b> · ${escapeHtml(o.recipient_phone || '')}</div>
            <div class="sub">${cuT('Collects at','自提门店')} <b>${escapeHtml(o.address?.store_name_en || o.store_name_en || o.store_code || cuT('store','门店'))}</b>${o.address?.address ? ' · ' + escapeHtml(o.address.address) : ''}</div>
          </div>` : `
          <div>
            <div class="kicker">Ship to · 收货人 ${copyChip([o.recipient_name, o.recipient_phone, o.address_full].filter(Boolean).join('\n'), 'Ship-to')}</div>
            <div class="val" data-no-i18n><b>${escapeHtml(o.recipient_name || '')}</b> · ${escapeHtml(o.recipient_phone || '')}</div>
            <div class="sub" data-no-i18n>${escapeHtml(o.address_full || '')}</div>
            ${/[A-Za-z]/.test(o.address_full || '') ? `<button class="btn btn-sm" style="margin-top:8px;" onclick="openAddressToChinese(${o.id})">${pinIcon(13)} ${cuT('Make address Chinese', '转为中文地址')}</button>` : ''}
          </div>`}
          <div${o.customer_id ? ` onclick="orderGotoCustomer(${o.customer_id})" style="cursor: pointer;" title="View customer · 查看顾客"` : ''}>
            <div class="kicker">Customer · 顾客</div>
            <div class="val"><b>${escapeHtml(o.nickname || '—')}</b>${o.customer_id ? ` <span style="color: var(--text-3); font-weight: 600;">›</span>` : ''}</div>
            ${o.customer_id ? `<div class="sub">ID #${o.customer_id}</div>` : ''}
          </div>
          ${(() => { const _pmt = primaryPayment(o); return `
          <div>
            <div class="kicker">Payment · 付款 ${_pmt?.transaction_id ? copyChip(_pmt.transaction_id, 'Txn ID') : ''}</div>
            <div class="val">${paymentBrandHTML(o.payment_method, 'lg')} · ${escapeHtml(paymentStatusLabel(_pmt?.status))}</div>
          </div>`; })()}
          ${ODV.totalPlacement === 'inline' ? renderOrderTotalInline(o) : ''}
          ${renderShipByTile(o)}
          ${o.store_code ? `<div>
            <div class="kicker">Fulfilled by · 出货门店</div>
            <div class="val"><b>${escapeHtml(o.store_name_en || o.store_code)}</b></div>
            <div class="sub">${escapeHtml(o.store_name_cn || '')}${routingNote(o.routing_reason) ? ' · ' + routingNote(o.routing_reason) : ''}${(o.channel && o.channel.toLowerCase() !== 'wechat') ? ' · ' + escapeHtml(o.channel) : ''}</div>
            ${fulfillmentShortNote(o)}
          </div>` : ''}
          ${printReceiptTile(o)}
          ${o.customer_note ? `<div class="full"><div class="kicker">Customer note · 顾客备注</div><div style="font-weight: 700; color: var(--text-1); font-size: 14px; line-height: 1.5;">${escapeHtml(o.customer_note)}</div></div>` : ''}
          ${o.needs_cutlery ? `<div class="full"><span style="display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--text-1); background: var(--bg-elev-2); border: 1px solid var(--line); border-radius: 99px; padding: 4px 12px; font-size: 12px;">🍴 Cutlery requested · 需要餐具</span></div>` : ''}
          ${o.needs_invoice ? renderInvoiceBlock(o) : ''}
        </div>

        <div class="order-items">
          <div class="kicker" style="font-size: 10px; font-weight: 600; letter-spacing: .22em; text-transform: uppercase; color: var(--brass); margin-bottom: var(--s2);">Items &amp; shipments · 商品与发货</div>
          ${_DISMISSED_SPLIT.has(o.id) ? '' : splitSuggestionBanner(o)}
          ${o.outside_guangzhou && (o.shipments?.length > 1) ? `
            <div class="outside-gz-note">
              <span data-lang-block="en">⚠ Destination outside Guangzhou (${escapeHtml(o.shipping_city || 'unknown city')}) — order split into ${o.shipments.length} shipments</span><span data-lang-block="cn">⚠ 目的地在广州以外 (${escapeHtml(o.shipping_city || '未知城市')}) — 订单已拆分为 ${o.shipments.length} 个包裹</span>
              ${shipmentMergeControls(o)}
            </div>` : ''}
          ${o.outside_guangzhou && (o.shipments?.length === 1) && (o.shipments[0].label || '').includes('合并') ? `
            <div class="outside-gz-note">
              <span data-lang-block="en">Combined into one parcel — customer tracks a single shipment</span><span data-lang-block="cn">已合并为一个包裹 — 顾客只追踪一个包裹</span>
              ${shipmentMergeControls(o)}
            </div>` : ''}
          <div id="odv-items-sortable">${renderSortableItems(o)}</div>
        </div>

        ${(o.reservations && o.reservations.length) ? `
        <details class="order-items resv-details" style="margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--line-soft);">
          <summary class="kicker resv-summary" style="font-size: 10px; font-weight: 600; letter-spacing: .22em; text-transform: uppercase; color: var(--brass);">
            <span class="resv-caret" aria-hidden="true">▸</span>
            <span>Stock reservations · 库存预留</span>
            <span class="resv-count">${o.reservations.length}</span>
          </summary>
          <div class="table-wrap">
            <!-- nowrap on every header so the bilingual EN · 中文 labels
                 don't wrap mid-word ("STATUS · 状 / 态", "EXPIRES · / 到期")
                 when the drawer is narrow. table-wrap is overflow-x:auto. -->
            <table class="resv-table" style="--th-nowrap:1;">
              <thead><tr>
                <th style="white-space:nowrap;">Product · 产品</th>
                <th class="numeric" style="white-space:nowrap;">Qty · 数量</th>
                <th style="white-space:nowrap;">Channel · 渠道</th>
                <th style="white-space:nowrap;">Status · 状态</th>
                <th style="white-space:nowrap;">Expires · 到期</th>
                <th style="white-space:nowrap;">Committed · 提交</th>
                <th style="white-space:nowrap;">Released · 释放</th>
              </tr></thead>
              <tbody>${o.reservations.map(r => {
                const rn = orderItemNames({ name_en: r.product_name_en, name_cn: r.product_name_cn });
                const label = rn.primary
                  ? `<div>${escapeHtml(rn.primary)}</div>${rn.secondary ? `<div class="muted" style="font-size: 11px; margin-top: 2px">${escapeHtml(rn.secondary)}</div>` : ''}`
                  : `<span class="muted" style="font-family: var(--f-mono); font-size: 11px;">product_id ${r.product_id}</span>`;
                const cell = r.product_id
                  ? `<a href="/?openProduct=${r.product_id}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${label}</a>`
                  : label;
                return `
                <tr>
                  <td>${cell}</td>
                  <td class="numeric">×${r.qty}</td>
                  <td>${escapeHtml(r.channel || '')}</td>
                  <td><span class="pill st-${r.status === 'committed' ? 'paid' : r.status === 'expired' ? 'cancelled' : r.status === 'released' ? 'cancelled' : 'preparing'}">${escapeHtml(r.status)}</span></td>
                  <td class="muted" style="font-size: 11px">${formatDate(r.expires_at)}</td>
                  <td class="muted" style="font-size: 11px">${r.committed_at ? formatDate(r.committed_at) : '—'}</td>
                  <td class="muted" style="font-size: 11px">${r.released_at ? formatDate(r.released_at) : '—'}</td>
                </tr>`; }).join('')}</tbody>
            </table>
          </div>
        </details>` : ''}

        ${ODV.totalPlacement === 'footer' ? renderOrderTotalFooter(o) : ''}
      </div>`;
  // Drawer body manages its own scroll position; reset to top on each
  // render so re-renders after a transition don't leave it mid-scroll.
  const body = $('#order-drawer .drawer-body');
  if (body) body.scrollTop = 0;
}

// Off-app tender options for the manual "Mark paid" button. value = what the
// backend stores on the order + in retail_payments; the dashboard payment
// split shows the matching label. Keep in sync with OFFLINE_PAY_METHODS in
// routes/retail.js and payLabel() below.
const PAY_METHOD_CHOICES = [
  ['cash',           'Cash · 现金'],
  ['bank_transfer',  'Bank transfer · 银行转账'],
  ['wechat_offline', 'WeChat (off-app) · 微信(线下)'],
  ['alipay_offline', 'Alipay (off-app) · 支付宝(线下)'],
  ['other',          'Other · 其他'],
];
// Styled in-app picker (not the native prompt) so confirming an off-app
// payment looks like part of the backend. Resolves the chosen method value,
// or null if the operator cancels (backdrop / Cancel / Esc).
function askPayMethod() {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'pm-pick-bg';
    bg.innerHTML = `
      <div class="pm-pick" role="dialog" aria-modal="true" aria-label="Paid how">
        <div class="pm-pick-head">
          <div class="pm-pick-title">Paid how? · 如何收款?</div>
          <div class="pm-pick-sub">Records the real tender so revenue splits correctly. · 记录实际收款方式以便正确统计收入。</div>
        </div>
        <div class="pm-pick-list">
          ${PAY_METHOD_CHOICES.map(([val, label], i) => `
            <button class="pm-pick-opt" data-val="${val}" data-key="${i + 1}">
              <span class="pm-pick-num">${i + 1}</span>
              <span class="pm-pick-lbl">${label}</span>
            </button>`).join('')}
        </div>
        <div class="pm-pick-foot">
          <button class="btn" data-cancel>Cancel · 取消</button>
        </div>
      </div>`;
    document.body.appendChild(bg);

    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey);
      bg.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') return finish(null);
      const hit = PAY_METHOD_CHOICES[parseInt(e.key, 10) - 1];
      if (hit) finish(hit[0]);
    };
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) finish(null); });
    bg.querySelectorAll('.pm-pick-opt').forEach((b) =>
      b.addEventListener('click', () => finish(b.dataset.val)));
    bg.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    document.addEventListener('keydown', onKey);
    bg.querySelector('.pm-pick-opt')?.focus();
  });
}

// Branded replacement for window.prompt() when collecting one optional reason
// (cancellation / refund). Resolves to the typed string, or null if the staff
// member dismisses (ESC / backdrop / Cancel) so callers can abort. Submitting
// an empty textarea resolves to '' (reason is optional).
function askReason(opts) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'pu-editor-bg';
    bg.style.display = 'flex';
    bg.innerHTML = `
      <div class="pu-editor" style="width: 460px; max-width: 92vw;" role="dialog" aria-modal="true">
        <div class="pu-editor-head">
          <div>
            <h3 style="margin: 0; font-size: 14px;">${opts.titleEn} · ${opts.titleCn}</h3>
            <div class="muted" style="font-size: 11px; margin-top: 2px;">${opts.subEn} · ${opts.subCn}</div>
          </div>
          <button class="btn" data-cancel>Close · 关闭</button>
        </div>
        <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display: block;">
          <div class="field" style="margin-bottom: 14px;">
            <label class="stacked">${opts.labelEn} · ${opts.labelCn}</label>
            <textarea id="ar-reason" rows="3" style="width: 100%;" placeholder="${opts.phEn} · ${opts.phCn}"></textarea>
          </div>
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button class="btn" data-cancel>Cancel · 取消</button>
            <button class="btn btn-primary" data-submit>${opts.submitEn} · ${opts.submitCn}</button>
          </div>
        </div>
      </div>`;
    mountFloatingPuModal(bg);

    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey);
      bg.remove();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) finish(null); });
    bg.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => finish(null)));
    bg.querySelector('[data-submit]').addEventListener('click', () => finish(bg.querySelector('#ar-reason').value || ''));
    document.addEventListener('keydown', onKey);
    const ta = bg.querySelector('#ar-reason');
    if (ta) setTimeout(() => ta.focus(), 30);
  });
}

// Generic yes/no confirmation modal — resolves true on confirm, false on
// cancel/dismiss. Mirrors askReason's floating-modal plumbing so it inherits
// the same backdrop, Escape-to-close, and calm motion.
function askConfirm(opts) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'pu-editor-bg';
    bg.style.display = 'flex';
    bg.innerHTML = `
      <div class="pu-editor" style="width: 460px; max-width: 92vw;" role="dialog" aria-modal="true">
        <div class="pu-editor-head">
          <div>
            <h3 style="margin: 0; font-size: 14px;">${opts.titleEn} · ${opts.titleCn}</h3>
          </div>
          <button class="btn" data-cancel>Close · 关闭</button>
        </div>
        <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display: block;">
          <div style="font-size: 13px; line-height: 1.5; margin-bottom: 16px;">
            <div>${opts.bodyEn}</div>
            <div class="muted" style="margin-top: 6px;">${opts.bodyCn}</div>
          </div>
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button class="btn" data-cancel>${opts.cancelEn || 'Cancel'} · ${opts.cancelCn || '取消'}</button>
            <button class="btn btn-primary" data-submit>${opts.confirmEn} · ${opts.confirmCn}</button>
          </div>
        </div>
      </div>`;
    mountFloatingPuModal(bg);

    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey);
      bg.remove();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) finish(false); });
    bg.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => finish(false)));
    bg.querySelector('[data-submit]').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKey);
    const submit = bg.querySelector('[data-submit]');
    if (submit) setTimeout(() => submit.focus(), 30);
  });
}

// Receipt-print status tile in the order drawer. Hidden for orders that
// can't have a receipt (unpaid / cancelled / refunded). Shows the last
// auto-print outcome (printed / failed / not yet) plus a one-click reprint.
function printReceiptTile(o) {
  if (['pending_payment', 'cancelled', 'refunded'].includes(o.status)) return '';
  let badge;
  if (o.print_status === 'printed') {
    badge = `<span class="sub" style="color:var(--text-3); font-weight:700;">✓ Printed · 已打印${o.printed_at ? ' ' + formatDate(o.printed_at) : ''}</span>`;
  } else if (o.print_status === 'failed') {
    badge = `<span class="pill danger" title="${escapeAttr(o.print_error || '')}"><span class="dot"></span>Print failed · 打印失败</span>`;
  } else {
    badge = `<span class="sub" style="color:var(--text-3); font-weight:700;">Not printed yet · 尚未打印</span>`;
  }
  return `<div class="full">
    <div class="kicker">Receipt · 小票</div>
    <div class="val" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      ${badge}
      <button class="btn btn-sm" id="reprint-${o.id}" onclick="reprintOrder(${o.id})"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>Reprint · 补打小票</button>
    </div>
  </div>`;
}

async function reprintOrder(id) {
  const btn = document.getElementById('reprint-' + id);
  if (btn) { btn.disabled = true; btn.style.opacity = '.5'; }
  try {
    const r = await api(`/api/retail-admin/orders/${id}/print`, { method: 'POST' });
    if (r.ok) toast('Receipt sent to printer · 小票已发送');
    else toast('Print failed · 打印失败: ' + (r.error || 'unknown'), 'err');
  } catch (e) {
    toast('Print failed · 打印失败: ' + e.message, 'err');
  } finally {
    openOrder(id, { instant: true });
    loadOrders();
  }
}

// Guangzhou (UTC+8) wall-clock date as YYYY-MM-DD — the store's local "today".
function gzTodayISODate() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
// Normalise any stored timestamp (date-only or UTC datetime) to the Guangzhou
// calendar date it falls on. SQLite stores UTC with no zone marker, so we tag
// it Z, shift +8h, and take the date — matching the store's local clock.
function gzDateOf(iso) {
  if (!iso) return null;
  let s = String(iso).trim().replace(' ', 'T');
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const t = Date.parse(s);
  if (isNaN(t)) return null;
  return new Date(t + 8 * 3600000).toISOString().slice(0, 10);
}
function daysBetweenISO(fromISO, toISO) {
  return Math.round((Date.parse(toISO + 'T00:00:00Z') - Date.parse(fromISO + 'T00:00:00Z')) / 86400000);
}

// Decide whether dispatching this order *now* ships it too early, and if so
// return the warning copy. Two cases, in priority order:
//   1. Batch make-fresh order whose make-fresh day hasn't arrived — the batch
//      isn't even made yet, so dispatching is always wrong.
//   2. Customer-scheduled delivery more than 2 days out — normal 1–2 day land
//      transit is fine, but shipping well ahead of that arrives early.
// Pickup orders are out of scope (no shipping). Returns null when fine.
function earlyDispatchWarning(o) {
  if (!o || o.fulfillment_type === 'pickup') return null;
  const today = gzTodayISODate();

  const freshDay = gzDateOf(o.promised_ship_date);
  if (freshDay && freshDay > today) {
    const arrives = gzDateOf(o.promised_delivery_date);
    return {
      titleEn: 'Made fresh later', titleCn: '稍后制作',
      bodyEn: `This order is scheduled to be made fresh on <b>${escapeHtml(freshDay)}</b>` +
        (arrives ? ` (arrives ~${escapeHtml(arrives)})` : '') +
        `. It hasn't been made yet — dispatching now ships it early. Mark dispatched anyway?`,
      bodyCn: `此订单计划于 <b>${escapeHtml(freshDay)}</b> 当天新鲜制作,目前尚未制作。现在发货将提前出库。仍要标记已发货吗?`,
    };
  }

  const target = gzDateOf(o.promised_delivery_date) || gzDateOf(o.scheduled_for);
  if (target) {
    const daysOut = daysBetweenISO(today, target);
    if (daysOut > 2) {
      const label = humanizeSlotLabel(o.delivery_slot_label) || target;
      return {
        titleEn: 'Delivery requested later', titleCn: '要求稍后送达',
        bodyEn: `The customer requested delivery around <b>${escapeHtml(label)}</b> — about ${daysOut} days from now. Shipping today will likely arrive early. Mark dispatched anyway?`,
        bodyCn: `客户要求约在 <b>${escapeHtml(label)}</b> 送达,距今约 ${daysOut} 天。今天发货可能提前送达。仍要标记已发货吗?`,
      };
    }
  }
  return null;
}

async function transition(id, status) {
  let reason = null;
  let pay_method = null;
  // Dispatching an order whose requested timing is still in the future ships it
  // early — for fresh food that means it sits or arrives before the customer
  // wants it. Confirm before advancing. (See earlyDispatchWarning for the rules.)
  if (status === 'dispatched' && _OPEN_ORDER && _OPEN_ORDER.id === id) {
    const warn = earlyDispatchWarning(_OPEN_ORDER);
    if (warn) {
      const ok = await askConfirm({
        ...warn,
        confirmEn: 'Mark dispatched anyway', confirmCn: '仍要标记已发货',
        cancelEn: 'Not yet', cancelCn: '暂不',
      });
      if (!ok) return;
    }
  }
  // The plain "Refund" button now opens a full/partial chooser instead of a
  // bare reason prompt. The dialog drives its own submission (full → this same
  // /status path; partial → /refund/direct), so we hand off and stop here.
  if (status === 'refunded') {
    openDirectRefundDialog(id);
    return;
  }
  if (status === 'cancelled') {
    reason = await askReason({
      titleEn: 'Cancel order', titleCn: '取消订单',
      subEn: 'Recorded on the order for your records.',
      subCn: '将记录在订单中以备查询。',
      labelEn: 'Reason for cancellation (optional)', labelCn: '取消原因(可选)',
      phEn: 'Optional', phCn: '可选',
      submitEn: 'Cancel order', submitCn: '确认取消',
    });
    if (reason === null) return;  // dismissed → abort
  }
  if (status === 'paid') {
    pay_method = await askPayMethod();
    if (pay_method === null) return;          // cancelled the prompt → abort
  }
  try {
    await api(`/api/retail-admin/orders/${id}/status`, { method: 'PATCH', body: { status, reason, pay_method } });
    toast(`Order → ${humanStatus(status, _OPEN_ORDER?.fulfillment_type)} · 订单 → ${humanStatus(status, _OPEN_ORDER?.fulfillment_type)}`);
    openOrder(id, { instant: true });
    loadOrders();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

// Reverse an accidental "Mark dispatched" / "Mark delivered". The status machine
// is forward-only, so without this a misclick was stuck on the queue with only
// Refund as an exit. The server only allows it when no parcel carries a waybill
// (see undoDispatchable); on that rare race it returns 'already_shipped' and we
// surface a plain reason. Silent: the customer is not notified, matching a quick
// correction. Both 'dispatched' and 'delivered' roll back to Preparing.
async function undoDispatch(id) {
  const wasDelivered = _OPEN_ORDER && _OPEN_ORDER.id === id && _OPEN_ORDER.status === 'delivered';
  const ok = await askConfirm({
    titleEn: wasDelivered ? 'Undo delivery?' : 'Undo dispatch?',
    titleCn: wasDelivered ? '撤销送达?' : '撤销发货?',
    bodyEn: `This moves the order back to <b>Preparing</b>. Use it if you marked it ${wasDelivered ? 'delivered' : 'dispatched'} by mistake — it hasn't actually shipped. The customer is not notified.`,
    bodyCn: `这会把订单退回<b>备货中</b>。如果你是误点了${wasDelivered ? '送达' : '发货'}(实际上还没发出),可以用它撤销。不会通知顾客。`,
    confirmEn: wasDelivered ? 'Undo delivery' : 'Undo dispatch',
    confirmCn: wasDelivered ? '撤销送达' : '撤销发货',
    cancelEn: 'Keep as is', cancelCn: '保持不变',
  });
  if (!ok) return;
  try {
    await api(`/api/retail-admin/orders/${id}/undo-dispatch`, { method: 'POST', body: {} });
    toast('Undone · 已撤销 — back to Preparing · 退回备货中');
    openOrder(id, { instant: true });
    loadOrders();
  } catch (e) {
    const msg = e.message === 'already_shipped'
      ? cuT('A parcel already has a waybill — cancel it first.', '已有包裹生成运单 — 请先取消运单。')
      : 'Failed · 失败: ' + e.message;
    toast(msg, 'err');
  }
}

// Whether the open order can be rolled back to Preparing from the UI: it's
// dispatched or delivered, and no parcel carries a real waybill. Mirrors the
// server guard so the button only shows when the action will actually succeed.
// (delivered_at is NOT checked — the deliver flip stamps it on every parcel, so
// it can't tell a real delivery from this misclick; only a waybill can.)
function undoDispatchable(o) {
  return o && (o.status === 'dispatched' || o.status === 'delivered')
    && o.fulfillment_type !== 'pickup'
    && !(o.shipments || []).some(s =>
      (s.tracking_number && String(s.tracking_number).trim()) ||
      (s.tracking && s.tracking.number));
}

let TRACKING_CARRIERS = null;
async function ensureTrackingCarriers() {
  if (TRACKING_CARRIERS) return TRACKING_CARRIERS;
  try {
    const r = await api('/api/retail-admin/tracking/carriers');
    TRACKING_CARRIERS = r.data || [];
  } catch (e) { TRACKING_CARRIERS = []; }
  return TRACKING_CARRIERS;
}

// Tracking card for one shipment row inside a shipment-card. Each shipment
// gets its own carrier + waybill input. The save/clear/retry handlers all
// pass the shipment_id so the right row in retail_shipments is touched.
function renderShipmentTrackingCard(o, s, hoisted) {
  const t = s.tracking;
  const has = !!(t && t.number);
  const sid = s.id;
  const carrierOpts = (TRACKING_CARRIERS || []).map(c =>
    `<option value="${c.code}" ${ (has ? t.carrier_code : 'jd') === c.code ? 'selected' : '' }>${escapeHtml(c.name_en)} · ${escapeHtml(c.name_cn)}</option>`
  ).join('');
  const synced = t?.synced_at ? cuT(`last updated ${formatDate(t.synced_at)}`, `最后更新 ${formatDate(t.synced_at)}`) : cuT('no live sync yet', '尚未实时同步');
  const trackLink = (has && t.track_url)
    ? `<a href="${t.track_url}" target="_blank" rel="noopener" class="muted" style="font-size:11px; text-decoration:underline;">View on carrier site → · 在承运商官网查看 →</a>`
    : '';

  // A waybill reused from an ALREADY-DELIVERED order can't live-sync: kd100/JD
  // keys by company+number and won't replay events for a parcel they already
  // closed out. The green "live sync on" badge would lie next to the red reuse
  // banner, so override it to a muted amber "sync inactive" the moment we know.
  const deadReuse = !!(t && t.reuse_warning && t.reuse_warning.delivered);
  let kdBadge = '';
  if (has) {
    if (deadReuse) {
      kdBadge = `<span style="font-size:11px; color:#b8860b;">● sync inactive · 同步未生效 (reused number · 重复运单号)</span>`;
    } else if (s.jd_live) {
      kdBadge = `<span class="muted" style="font-size:11px; color: #5a8c2a;">● JD live sync on · 京东实时同步中</span>`;
    } else if (s.tracking_kd100_subscribed) {
      kdBadge = `<span class="muted" style="font-size:11px; color: #5a8c2a;">● kd100 live sync on · 快递100实时同步中</span>`;
    } else if (s.tracking_last_error) {
      kdBadge = `<span style="font-size:11px; color: var(--danger);">⚠ ${escapeHtml(s.tracking_last_error)}</span>
        <button class="btn btn-sm" onclick="resubscribeTracking(${o.id}, ${sid})" style="margin-left:6px;">Retry sync · 重试同步</button>`;
    } else {
      kdBadge = `<span class="muted" style="font-size:11px;">manual entry only · 仅手动录入</span>`;
    }
  }

  // Recycled-waybill warning: the same number is already attached to another
  // order. If that order already delivered, kd100 won't replay events for it,
  // so this card would sit at "Waiting for the first update" forever despite
  // the green sync badge. Surface it loudly so the operator re-checks the number
  // instead of waiting on a sync that will never come.
  let reuseBanner = '';
  if (has && t.reuse_warning) {
    const w = t.reuse_warning;
    const msg = w.delivered
      ? cuT(
          `This waybill is already on a delivered order (${escapeHtml(w.order_no)}). A reused number won't sync live — double-check it's correct.`,
          `此运单号已用于一笔已签收订单(${escapeHtml(w.order_no)})。重复运单号不会实时同步,请核对。`)
      : cuT(
          `This waybill is also attached to order ${escapeHtml(w.order_no)} (${escapeHtml(w.status)}). Reused numbers may not sync live.`,
          `此运单号也绑定在订单 ${escapeHtml(w.order_no)}(${escapeHtml(w.status)})上。重复运单号可能无法实时同步。`);
    reuseBanner = `
      <div style="display:flex; gap:8px; align-items:flex-start; padding:8px 10px; margin-bottom:10px;
                  background: var(--danger-bg, #fbeaea); border:1px solid var(--danger, #c0392b);
                  border-radius:6px; font-size:12px; line-height:1.4; color: var(--danger, #c0392b);">
        <span>⚠️</span>
        <div>${msg}</div>
      </div>`;
  }

  // data-no-i18n: each event is a single free-text scan (Chinese from the
  // carrier, with an English translation we precompute). The backend's EN/CN
  // auto-classifier would otherwise treat the raw Chinese as a stray half of a
  // translation pair and blank it in the other language — so we opt the whole
  // block out and pick the live language ourselves via cuT().
  const eventsBlock = (has && t.events && t.events.length) ? `
    <div data-no-i18n style="margin-top:14px; border-top: 1px dashed var(--line-soft); padding-top:10px;">
      <div class="muted" style="font-size:10px; letter-spacing:.1em; text-transform:uppercase; margin-bottom:6px;">${cuT('Recent events', '最近事件')}</div>
      <div style="display:flex; flex-direction:column; gap:6px; max-height: 220px; overflow-y: auto;">
        ${t.events.slice(0, 8).map(ev => {
          const desc = cuT(ev.description_en || ev.description_cn || '', ev.description_cn || ev.description_en || '');
          return `
          <div style="display:flex; gap:10px; font-size:12px; line-height:1.4;">
            <div class="muted" style="font-family: var(--f-mono); white-space:nowrap; min-width: 130px;">${escapeHtml(ev.time || '')}</div>
            <div style="flex:1;">
              <div>${escapeHtml(desc)}</div>
              ${ev.location ? `<div class="muted" style="font-size:11px;">${escapeHtml(ev.location)}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  return `
    <div style="${hoisted ? '' : 'margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line-soft);'}" id="trk-card-${sid}">
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-3); margin-bottom: var(--s2);">Tracking · 物流</div>
      ${reuseBanner}
      ${has ? `
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:10px 12px; background: var(--bg-elev-1); border-radius:6px; margin-bottom:10px;">
          <div>
            <div style="font-size:12px; color:var(--text-3);">${escapeHtml(t.carrier_name_en)} · ${escapeHtml(t.carrier_name_cn)}</div>
            <div style="font-family: var(--f-mono); font-weight:600;">${escapeHtml(t.number)}</div>
          </div>
          ${(() => {
            // Live delivery state with its own icon + colour (courier, returning,
            // exception …) so the operator sees WHERE the parcel is at a glance —
            // not just a flat brown "In transit" chip. Falls back to the plain
            // carrier label for states with no dedicated treatment.
            const dl = deliveryStateInfo({ tracking_status: t.status_code, tracking_scenario: t.scenario && t.scenario.scenario });
            if (dl) {
              return `<div><span class="pill" style="display:inline-flex; align-items:center; gap:5px; color:${dl.color}; border-color:${dl.color}55; background:${dl.color}14; font-weight:${dl.tone === 'urgent' ? 700 : 600};">${deliveryIcon(dl.icon, 13)}<span>${cuT(dl.en, dl.cn)}</span></span></div>`;
            }
            return t.status_label_en ? `<div><span class="pill st-dispatched"><span class="dot"></span>${escapeHtml(t.status_label_en)} · ${escapeHtml(t.status_label_cn)}</span></div>` : '';
          })()}
          <div style="flex:1; min-width:160px; text-align:right;">
            <div class="muted" style="font-size:11px;">${synced}</div>
            <div style="margin-top:2px;">${kdBadge}</div>
            <div style="margin-top:2px;">${trackLink}</div>
          </div>
        </div>` : ''}
      ${eventsBlock}
      ${!has ? `
        <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" onclick="createJdLabel(${o.id}, ${sid}, '${s.mode || ''}', ${(s.items || []).some(it => it.needs_ice_pack) ? 1 : 0}, event)">📦 Create JD label · 生成京东运单</button>
          <span class="muted" style="font-size:11px;">Free live tracking — JD bills the parcel. · 免费物流追踪。</span>
        </div>
        <div class="muted" style="font-size:11px; margin:8px 0 4px;">— or attach an existing waybill manually · 或手动填写已有运单 —</div>` : ''}
      <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap; margin-top: ${has ? '10px' : '0'};">
        <select id="trk-carrier-${sid}" style="min-width:180px;">${carrierOpts}</select>
        <input type="text" id="trk-number-${sid}" value="${has ? escapeHtml(t.number) : ''}" placeholder="Tracking / waybill number" data-ph-en="Tracking / waybill number" data-ph-cn="快递单号 / 运单号" style="flex:1; min-width:200px; font-family: var(--f-mono);">
        <button class="btn ${has ? 'btn-primary' : ''} btn-sm" onclick="saveTracking(${o.id}, ${sid})">${has ? 'Update · 更新' : 'Save tracking · 保存运单号'}</button>
        ${has && t.carrier_code === 'jd' ? `<button class="btn btn-sm" style="color:var(--danger);" onclick="cancelJdPickup(${o.id}, ${sid}, event)">Cancel JD pickup · 取消揽收</button>` : ''}
        ${has ? `<button class="btn btn-sm" onclick="clearTracking(${o.id}, ${sid})">Clear · 清除</button>` : ''}
      </div>
      ${has && t.carrier_code === 'jd' ? `<div class="muted" style="font-size:11px; margin-top:6px;">“Cancel JD pickup” calls off the courier with JD. “Clear” only removes the number locally (courier still comes). · “取消揽收”会向京东取消上门;“清除”仅在本地移除运单号(快递仍会上门)。</div>` : ''}
      ${!has ? `<div class="muted" style="font-size:11px; margin-top:6px;">A manually-entered number tracks via 快递100 (paid) — incl. a personal JD JDV0… number. For free JD tracking, use “Create JD label” above instead. · 手动录入的运单号通过快递100(付费)追踪,含个人的京东 JDV0… 单号;如需免费京东追踪,请改用上方“生成京东运单”。</div>` : ''}
    </div>`;
}

// ─── Bulk attach tracking ─────────────────────────────────────────
async function openBulkTracking() {
  await ensureTrackingCarriers();
  const sel = document.getElementById('bulk-trk-carrier');
  sel.innerHTML = (TRACKING_CARRIERS || []).map(c =>
    `<option value="${c.code}" ${c.code === 'jd' ? 'selected' : ''}>${escapeHtml(c.name_en)} · ${escapeHtml(c.name_cn)}</option>`
  ).join('');
  document.getElementById('bulk-trk-text').value = '';
  document.getElementById('bulk-trk-results').innerHTML = '';
  document.getElementById('bulk-trk-counter').textContent = cuT('0 entries', '0 条');
  document.getElementById('bulk-trk-bg').classList.add('show');
  document.getElementById('bulk-trk-text').addEventListener('input', updateBulkTrkCounter);
  setTimeout(() => document.getElementById('bulk-trk-text').focus(), 100);
}
function closeBulkTracking() {
  document.getElementById('bulk-trk-bg').classList.remove('show');
}
function updateBulkTrkCounter() {
  const lines = document.getElementById('bulk-trk-text').value.split(/\r?\n/).filter(l => l.trim().length);
  document.getElementById('bulk-trk-counter').textContent = cuT(lines.length + (lines.length === 1 ? ' entry' : ' entries'), lines.length + ' 条');
}
function parseBulkTrackingText(text, defaultCarrier) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[\s,;]+/).filter(Boolean);
    if (parts.length < 2) continue;
    out.push({
      order_no: parts[0],
      tracking_number: parts[1],
      carrier: (parts[2] || defaultCarrier || 'jd').toLowerCase(),
    });
  }
  return out;
}
async function submitBulkTracking() {
  const text = document.getElementById('bulk-trk-text').value;
  const carrier = document.getElementById('bulk-trk-carrier').value;
  const entries = parseBulkTrackingText(text, carrier);
  if (!entries.length) { toast('Nothing to process — check the format · 无可处理的内容,请检查格式', 'err'); return; }
  const btn = document.getElementById('bulk-trk-go');
  const restore = 'Process entries · 处理条目';
  btn.disabled = true; btn.textContent = `Processing · 处理中 ${entries.length}…`;
  try {
    const r = await api('/api/retail-admin/orders/bulk-tracking', { method: 'POST', body: { entries } });
    const ok = r.results.filter(x => x.ok).length;
    const bad = r.results.length - ok;
    const dispatched = r.results.filter(x => x.auto_dispatched).length;
    document.getElementById('bulk-trk-results').innerHTML = `
      <div style="padding:10px 14px; background: var(--bg-elev-1); border-radius:6px; margin-bottom:10px;">
        <b>${ok}</b> saved · 已保存 ${bad ? `· <span class="err"><b>${bad}</b> failed · 失败</span>` : ''} · <b>${dispatched}</b> auto-marked dispatched · 自动已发货
      </div>
      <table class="table-mini" style="width:100%; font-size:12px;">
        <thead><tr><th style="text-align:left;">Order # · 订单号</th><th>Status · 状态</th><th>Detail · 详情</th></tr></thead>
        <tbody>${r.results.map(x => `
          <tr>
            <td style="font-family: var(--f-mono); font-variant-numeric: tabular-nums;">${escapeHtml(x.order_no)}</td>
            <td>${x.ok ? '<span style="color: var(--st-dispatched, #5a8c2a);">✓ saved · 已保存</span>' : '<span class="err">✗ ' + escapeHtml(x.error || 'failed · 失败') + '</span>'}</td>
            <td class="muted" style="font-size:11px;">${x.auto_dispatched ? 'auto-dispatched · 自动发货' : ''}</td>
          </tr>`).join('')}</tbody>
      </table>`;
    toast(`Bulk: ${ok}/${r.results.length} saved · 批量: ${ok}/${r.results.length} 已保存`, ok ? 'ok' : 'err');
    loadOrders();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
    document.getElementById('bulk-trk-results').innerHTML =
      `<div class="err" style="padding:10px 14px; background: rgba(232,85,106,.08); border-radius:6px;">
         Request failed · 请求失败: ${escapeHtml(e.message || 'network')}
       </div>`;
  } finally {
    btn.disabled = false; btn.textContent = restore;
  }
}

async function resubscribeTracking(orderId, shipmentId, ev) {
  const qs = shipmentId ? '?shipment_id=' + shipmentId : '';
  try {
    await adminWrite({
      btn: ev?.currentTarget, url: `/api/retail-admin/orders/${orderId}/tracking/resubscribe${qs}`,
      method: 'POST', errLabelEn: 'Re-subscribe failed', errLabelCn: '重新订阅失败',
    });
    toast('Re-subscribed · 已重新订阅');
    openOrder(orderId);
  } catch {}
}

// The three real JD services Roots ships with. The operator picks one when
// creating a label — a parcel's mode (air/land) and whether it holds a
// fresh (ice-pack) item only PRE-SELECT the likely choice; staff can override.
//   LL-HD-M  冷链航空  fresh · air      (生鲜 · 空运)
//   LL-SD-M  冷链陆运  fresh · ground   (生鲜 · 陆运)
//   ed-m-0001 京东标快 ambient · ground (普通 · 陆运)
const JD_SERVICES = [
  { code: 'LL-HD-M',   en: 'Fresh · Air',     cn: '生鲜 · 空运', sub: '冷链航空 · LL-HD-M' },
  { code: 'LL-SD-M',   en: 'Fresh · Ground',  cn: '生鲜 · 陆运', sub: '冷链陆运 · LL-SD-M' },
  { code: 'ed-m-0001', en: 'Ambient · Ground',cn: '普通 · 陆运', sub: '京东标快 · ed-m-0001' },
];
function jdSuggestedService(mode, isFresh) {
  if (mode === 'air') return 'LL-HD-M';          // air is always cold-chain here
  return isFresh ? 'LL-SD-M' : 'ed-m-0001';      // ground splits by fresh flag
}

// Pop the service chooser, then create the JD waybill with the picked product.
// The label is created under our JD account, so JD streams tracking events for
// free (no 快递100). Server resolves the sender from the fulfilling store's
// 发货地址 — surface the "store has no sender phone" gap as a clear instruction.
function createJdLabel(orderId, shipmentId, mode, isFresh, ev) {
  const preset = jdSuggestedService(mode, !!Number(isFresh));
  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 460px; max-width: 92vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin:0; font-size:14px;">${cuT('Create JD label', '生成京东运单')}</h3>
          <div class="muted" style="font-size:11px; margin-top:2px;">${cuT('Choose the JD service for this parcel', '选择此包裹的京东时效产品')}</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Close', '关闭')}</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display:block;">
        <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:14px;">
          ${JD_SERVICES.map(s => `
            <label class="jd-svc" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--line-soft); border-radius:8px; cursor:pointer;">
              <input type="radio" name="jd-svc" value="${s.code}" ${s.code === preset ? 'checked' : ''} style="margin:0;">
              <span style="flex:1;">
                <span style="font-weight:600;">${cuT(s.en, s.cn)}</span>
                <span class="muted" style="display:block; font-size:11px; margin-top:1px;">${s.sub}</span>
              </span>
            </label>`).join('')}
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Cancel', '取消')}</button>
          <button class="btn btn-primary" id="jd-svc-submit">${cuT('Create & ship', '生成并发货')}</button>
        </div>
      </div>
    </div>`;
  mountFloatingPuModal(bg);
  bg.querySelector('#jd-svc-submit').addEventListener('click', async (e) => {
    const product = (bg.querySelector('input[name="jd-svc"]:checked') || {}).value;
    if (!product) return;
    const qs = shipmentId ? '?shipment_id=' + shipmentId : '';
    try {
      const r = await adminWrite({
        btn: e.currentTarget,
        url: `/api/retail-admin/orders/${orderId}/jd-waybill${qs}`,
        method: 'POST', body: { shipment_id: shipmentId, product },
        errLabelEn: 'JD label failed', errLabelCn: '生成运单失败',
      });
      bg.remove();
      toast(cuT('JD waybill created', '京东运单已生成') + ': ' + (r?.data?.waybill || ''));
      openOrder(orderId, { instant: true });
      loadOrders();
    } catch (err) {
      // adminWrite already toasts the raw error; add guidance for the usual cause.
      if (String(err?.message || err).includes('store_sender_phone_missing')) {
        toast(cuT('Set the store’s sender phone first (Settings → Stores)', '请先在门店设置寄件电话'), 'err');
      }
    }
  });
}

// Cancel the JD courier for this parcel via JD's own API (pre-pickup cancel,
// falling back to in-transit intercept). Unlike "Clear", this actually calls
// off the courier. On success the waybill is removed + the order may roll back
// to preparing.
async function cancelJdPickup(orderId, shipmentId, ev) {
  if (!confirm('Cancel the JD pickup / recall this parcel with JD?\n向京东取消揽收 / 拦截此包裹？')) return;
  const qs = shipmentId ? '?shipment_id=' + shipmentId : '';
  try {
    const r = await adminWrite({
      btn: ev?.currentTarget,
      url: `/api/retail-admin/orders/${orderId}/jd-waybill/cancel${qs}`,
      method: 'POST', body: { shipment_id: shipmentId },
      errLabelEn: 'JD cancel failed', errLabelCn: '取消揽收失败',
    });
    toast(r?.data?.method === 'intercept'
      ? 'JD parcel intercepted (was already collected) · 已拦截在途包裹'
      : 'JD pickup cancelled · 已取消揽收');
    openOrder(orderId, { instant: true });
    loadOrders();
  } catch {}
}

// ─── Partial / late fulfillment (per-shipment) ──────────────────────────
// Mark a single parcel dispatched. The first parcel flips the whole order to
// dispatched server-side; later parcels just stamp their own state.
async function dispatchShipment(orderId, shipmentId, ev) {
  try {
    await adminWrite({
      btn: ev?.currentTarget,
      url: `/api/retail-admin/orders/${orderId}/shipments/${shipmentId}/dispatch`,
      method: 'POST',
      errLabelEn: 'Dispatch failed', errLabelCn: '发货失败',
    });
    toast('Parcel dispatched · 包裹已发货');
    openOrder(orderId, { instant: true });
    loadOrders();
  } catch {}
}

function toggleSplitPanel(shipmentId) {
  const el = document.getElementById('split-panel-' + shipmentId);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

// Move the ticked items into a new follow-up parcel.
async function submitShipmentSplit(orderId, shipmentId, ev) {
  const picked = Array.from(document.querySelectorAll('.split-pick-' + shipmentId))
    .filter(cb => cb.checked)
    .map(cb => parseInt(cb.value, 10));
  if (!picked.length) { toast('Tick at least one item to ship later · 请至少勾选一项', 'err'); return; }
  try {
    await adminWrite({
      btn: ev?.currentTarget,
      url: `/api/retail-admin/orders/${orderId}/shipments/split`,
      method: 'POST', body: { item_ids: picked },
      errLabelEn: 'Split failed', errLabelCn: '拆分失败',
    });
    toast('Moved to follow-up parcel · 已移入后补包裹');
    openOrder(orderId, { instant: true });
  } catch {}
}

async function saveTracking(orderId, shipmentId, ev) {
  // The carrier + number inputs are keyed on the shipment id (each shipment
  // card has its own pair).
  const key = shipmentId || orderId;
  const carrier = document.getElementById('trk-carrier-' + key)?.value;
  const number  = document.getElementById('trk-number-' + key)?.value.trim();
  if (!number) { toast('Enter a tracking number first · 请先输入运单号', 'err'); return; }
  const body = { carrier, tracking_number: number };
  if (shipmentId) body.shipment_id = shipmentId;
  // Re-opening the order rebuilds every shipment card from scratch, which wipes
  // any waybill the operator typed into a *sibling* parcel's field but hasn't
  // saved yet. Snapshot those unsaved drafts (everything except the row we just
  // saved) and restore them after the re-render. Keyed off the input id suffix
  // so it matches whatever sid the rebuilt card uses.
  const drafts = [];
  document.querySelectorAll('[id^="trk-number-"]').forEach(inp => {
    const sid = inp.id.slice('trk-number-'.length);
    if (sid === String(key)) return;            // the row being saved
    const draft = inp.value.trim();
    if (!draft) return;
    drafts.push({ sid, number: draft, carrier: document.getElementById('trk-carrier-' + sid)?.value });
  });
  try {
    const res = await adminWrite({
      btn: ev?.currentTarget, url: `/api/retail-admin/orders/${orderId}/tracking`,
      method: 'PUT', body, errLabelEn: 'Save failed', errLabelCn: '保存失败',
    });
    const w = res?.data?.tracking?.reuse_warning;
    if (w) {
      toast(`⚠️ Waybill already on order ${w.order_no}${w.delivered ? ' (delivered)' : ''} — reused numbers may not sync live · 运单号重复,可能无法实时同步`, 'err', 8000);
    } else {
      toast('Tracking saved · 运单号已保存');
    }
    // openOrder() rebuilds the whole drawer body, which yanks scroll back to the
    // top — jarring when the operator is mid-list updating a parcel. Snapshot the
    // scroll offset and restore it once the re-render lands.
    const _mount = document.getElementById('order-detail-mount');
    const _scrollTop = _mount ? _mount.scrollTop : 0;
    await openOrder(orderId);
    if (_mount) _mount.scrollTop = _scrollTop;
    for (const d of drafts) {
      const inp = document.getElementById('trk-number-' + d.sid);
      if (inp && !inp.value.trim()) inp.value = d.number;
      const sel = document.getElementById('trk-carrier-' + d.sid);
      if (sel && d.carrier) sel.value = d.carrier;
    }
  } catch {}
}

async function clearTracking(orderId, shipmentId, ev) {
  if (!confirm('Remove the tracking number from this shipment? · 移除此运单号?')) return;
  const qs = shipmentId ? '?shipment_id=' + shipmentId : '';
  try {
    await adminWrite({
      btn: ev?.currentTarget, url: `/api/retail-admin/orders/${orderId}/tracking${qs}`,
      method: 'DELETE', errLabelEn: 'Clear failed', errLabelCn: '清除失败',
    });
    toast('Tracking cleared · 运单号已清除');
    const _mount = document.getElementById('order-detail-mount');
    const _scrollTop = _mount ? _mount.scrollTop : 0;
    await openOrder(orderId);
    if (_mount) _mount.scrollTop = _scrollTop;
  } catch {}
}

// Local-delivery ETA (Guangzhou same-city). Saves the picked same-day arrival
// time onto the 'local' shipment; the customer's order page shows it as
// "Estimated arrival". Mirrors saveTracking's scroll-preserving re-render.
async function saveLocalEta(orderId, shipmentId, ev) {
  const eta = document.getElementById('eta-time-' + shipmentId)?.value;
  if (!eta) { toast('Pick an arrival time first · 请先选择送达时间', 'err'); return; }
  try {
    await adminWrite({
      btn: ev?.currentTarget, url: `/api/retail-admin/orders/${orderId}/eta`,
      method: 'PUT', body: { shipment_id: shipmentId, eta },
      errLabelEn: 'Save failed', errLabelCn: '保存失败',
    });
    toast('Arrival time saved · 送达时间已保存');
    const _mount = document.getElementById('order-detail-mount');
    const _scrollTop = _mount ? _mount.scrollTop : 0;
    await openOrder(orderId);
    if (_mount) _mount.scrollTop = _scrollTop;
    loadOrders();   // refresh the list so the tracking cell shows the new ETA
  } catch {}
}

async function clearLocalEta(orderId, shipmentId, ev) {
  if (!confirm('Remove the arrival time? · 移除送达时间?')) return;
  try {
    await adminWrite({
      btn: ev?.currentTarget, url: `/api/retail-admin/orders/${orderId}/eta?shipment_id=${shipmentId}`,
      method: 'DELETE', errLabelEn: 'Clear failed', errLabelCn: '清除失败',
    });
    toast('Arrival time cleared · 送达时间已清除');
    const _mount = document.getElementById('order-detail-mount');
    const _scrollTop = _mount ? _mount.scrollTop : 0;
    await openOrder(orderId);
    if (_mount) _mount.scrollTop = _scrollTop;
    loadOrders();   // refresh the list so the tracking cell drops the ETA
  } catch {}
}

// Shared note-only refund modal — used by Reject and Start-review, which both
// just collect one optional customer-visible note and POST it. Replaces the old
// window.prompt() so these match the Approve/Payout modals (ESC + backdrop
// dismiss, bilingual, inline busy state via adminWrite's btn). Submitting with
// an empty textarea is intentional and allowed (an empty note still records the
// transition on the audit log); Cancel/Close simply aborts.
function openRefundNoteDialog(opts) {
  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 480px; max-width: 92vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin: 0; font-size: 14px;">${opts.titleEn} · ${opts.titleCn}</h3>
          <div class="muted" style="font-size: 11px; margin-top: 2px;">${opts.subEn} · ${opts.subCn}</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">Close · 关闭</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display: block;">
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">${opts.labelEn} · ${opts.labelCn}</label>
          <textarea id="rfn-note" rows="3" style="width: 100%;" data-ph-en="${opts.phEn}" data-ph-cn="${opts.phCn}" placeholder="${opts.phEn}"></textarea>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">Cancel · 取消</button>
          <button class="btn btn-primary" id="rfn-submit">${opts.submitEn} · ${opts.submitCn}</button>
        </div>
      </div>
    </div>`;
  mountFloatingPuModal(bg);
  // Focus the note so staff can type immediately, like prompt() did.
  const ta = bg.querySelector('#rfn-note');
  if (ta) setTimeout(() => ta.focus(), 30);
  bg.querySelector('#rfn-submit').addEventListener('click', async (ev) => {
    const note = bg.querySelector('#rfn-note').value || '';
    try {
      await adminWrite({
        btn: ev.currentTarget, url: opts.url, method: 'POST',
        body: { note }, errLabelEn: opts.errLabelEn, errLabelCn: opts.errLabelCn,
      });
      toast(`${opts.okEn} · ${opts.okCn}`);
      bg.remove();
      openOrder(opts.orderId);
      loadOrders();
    } catch {}
  });
}

function rejectRefund(id) {
  openRefundNoteDialog({
    orderId: id,
    titleEn: 'Reject refund', titleCn: '拒绝退款',
    subEn: 'The customer sees this reason. Leave blank to reject without a note.',
    subCn: '顾客会看到此原因,留空则不附原因。',
    labelEn: 'Reason (shown to customer)', labelCn: '原因(顾客可见)',
    phEn: 'Optional', phCn: '可选',
    submitEn: 'Reject', submitCn: '拒绝',
    url: `/api/retail-admin/orders/${id}/refund/reject`,
    okEn: 'Refund rejected', okCn: '退款已拒绝',
    errLabelEn: 'Reject failed', errLabelCn: '拒绝失败',
  });
}

// ─── Refund processing — multi-step workflow inside the order drawer ──
// States (refund_status): pending → reviewing → approved → paid
//                              ↘ rejected   ↘ withdrawn
function refundStepBadge(state) {
  const map = {
    pending:    { label: '1. Requested · 已申请',     color: '#f2ca6c', bg: 'rgba(242,202,108,.14)' },
    reviewing:  { label: '2. Reviewing · 处理中',     color: '#7494ff', bg: 'rgba(116,148,255,.14)' },
    approved:   { label: '3. Approved · 已批准',     color: '#5fc28e', bg: 'rgba(95,194,142,.14)' },
    paid:       { label: '4. Paid · 已退款',          color: '#5fc28e', bg: 'rgba(95,194,142,.18)' },
    rejected:   { label: '✗ Rejected · 已拒绝',       color: 'var(--danger)', bg: 'rgba(232,85,106,.1)' },
    withdrawn:  { label: '↺ Withdrawn · 已撤回',      color: 'var(--text-3)', bg: 'var(--bg-elev-1)' },
  };
  const m = map[state];
  if (!m) return '';
  return `<span style="display: inline-block; padding: 3px 10px; border-radius: 999px; background: ${m.bg}; color: ${m.color}; font-size: 11px; font-weight: 600; letter-spacing: .05em;">${m.label}</span>`;
}
function renderRefundPanel(o) {
  const state = o.refund_status;
  if (!state) return '';
  const isOpen = ['pending', 'reviewing'].includes(state);
  const isApproved = state === 'approved';
  const isTerminal = ['paid', 'rejected', 'withdrawn'].includes(state);
  const total = Number(o.total) || 0;
  const reqAmt = o.refund_amount_requested != null ? Number(o.refund_amount_requested) : null;
  const apvAmt = o.refund_amount_approved != null ? Number(o.refund_amount_approved) : null;
  const paidAmt = o.refund_amount_paid != null ? Number(o.refund_amount_paid) : null;
  let lines = [];
  try { lines = o.refund_lines_json ? JSON.parse(o.refund_lines_json) : []; } catch { lines = []; }
  const lineMap = new Map((o.items || []).map(it => [it.id, it]));

  // Header background must match the state badge so the panel doesn't say
  // one thing in the tag and a different thing in the body. Earlier this
  // was hardcoded amber for everything except terminal-non-paid (rejected /
  // withdrawn), which made an approved request still read as "needs work".
  const headerBg = state === 'pending'    ? 'rgba(242,202,108,.10)'  // amber
                 : state === 'reviewing'  ? 'rgba(116,148,255,.10)'  // blue
                 : state === 'approved'   ? 'rgba(95,194,142,.10)'   // green
                 : state === 'paid'       ? 'rgba(95,194,142,.14)'   // green, slightly stronger
                 : state === 'rejected'   ? 'rgba(232,85,106,.08)'   // red, subtle
                 : state === 'withdrawn'  ? 'var(--bg-elev-1)'       // theme-neutral
                 : 'var(--bg-elev-1)';
  const headerBorder = state === 'paid' ? '#5fc28e' :
                       state === 'approved' ? '#5fc28e' :
                       state === 'reviewing' ? '#7494ff' :
                       state === 'rejected' ? 'var(--danger)' :
                       state === 'withdrawn' ? 'var(--text-3)' : '#f2ca6c';

  // Action buttons appropriate to current state.
  let actions = '';
  if (state === 'pending') {
    actions = `
      <button class="btn btn-sm" onclick="refundReview(${o.id})">Start review · 开始处理</button>
      <button class="btn btn-primary btn-sm" onclick="openRefundApproveDialog(${o.id})">Approve · 批准</button>
      <button class="btn btn-sm" onclick="rejectRefund(${o.id})">Reject · 拒绝</button>`;
  } else if (state === 'reviewing') {
    actions = `
      <button class="btn btn-primary btn-sm" onclick="openRefundApproveDialog(${o.id})">Approve · 批准</button>
      <button class="btn btn-sm" onclick="rejectRefund(${o.id})">Reject · 拒绝</button>`;
  } else if (state === 'approved') {
    actions = `
      <button class="btn btn-primary btn-sm" onclick="openRefundPayoutDialog(${o.id})">Record payout · 记录退款</button>`;
  }

  const customerLinesBlock = (state === 'pending' || state === 'reviewing') && lines.length
    ? `<div style="margin-top: 8px; padding: 8px 10px; background: var(--bg-elev-1); border-radius: 6px; font-size: 12px;">
         <div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px;">Customer-selected lines · 顾客选择的商品</div>
         ${lines.map(l => {
           const it = lineMap.get(l.item_id);
           const label = it ? (it.name_en || it.name_cn || ('item #' + l.item_id)) : ('item #' + l.item_id);
           return `<div style="display:flex; justify-content: space-between;"><span>${escapeHtml(label)} × ${l.qty}</span><b>¥${fmt(l.amount)}</b></div>`;
         }).join('')}
       </div>` : '';

  const amountSummary = isApproved || state === 'paid'
    ? `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 10px; font-size: 12px;">
        <div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Order total · 订单总额</div><b>¥${fmt(total)}</b></div>
        ${reqAmt != null ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Requested · 申请金额</div><b>¥${fmt(reqAmt)}</b></div>` : ''}
        ${apvAmt != null ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Approved · 已批准</div><b>¥${fmt(apvAmt)}</b></div>` : ''}
        ${paidAmt != null ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Paid back · 已退款</div><b>¥${fmt(paidAmt)}</b></div>` : ''}
        ${o.refund_payout_method ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Method · 方式</div><b>${escapeHtml(o.refund_payout_method)}</b>${o.refund_payout_ref ? `<div class="muted" style="font-size: 10px; font-family: var(--f-mono); margin-top: 2px;">${escapeHtml(o.refund_payout_ref)}</div>` : ''}</div>` : ''}
      </div>` : reqAmt != null
        ? `<div style="margin-top: 8px; font-size: 12px;">${cuT(`Customer asked for <b>¥${fmt(reqAmt)}</b> of <b>¥${fmt(total)}</b>`, `顾客申请退 <b>¥${fmt(reqAmt)}</b> / 共 <b>¥${fmt(total)}</b>`)}</div>`
        : '';

  return `
    <div style="margin: 0 0 16px; padding: 14px 16px; background: ${headerBg}; border-left: 4px solid ${headerBorder}; border-radius: 4px;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 10px;">
          ${refundStepBadge(state)}
          <span class="muted" style="font-size: 11px;">${o.refund_requested_at ? cuT('requested', '申请于') + ' ' + formatDate(o.refund_requested_at) : ''}</span>
        </div>
        <button class="btn btn-sm" onclick="openRefundEvents(${o.id})" title="Audit log · 审计记录">📜 History · 历史</button>
      </div>
      ${o.refund_reason ? `<div style="margin-top: 10px; font-size: 13px;">${escapeHtml(o.refund_reason)}</div>` : ''}
      ${customerLinesBlock}
      ${amountSummary}
      ${o.refund_review_note ? `<div class="muted" style="margin-top: 8px; font-size: 12px;">${cuT('Staff note', '客服备注')}: ${escapeHtml(o.refund_review_note)}</div>` : ''}
      ${actions ? `<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">${actions}</div>` : ''}
    </div>`;
}

function refundReview(id) {
  openRefundNoteDialog({
    orderId: id,
    titleEn: 'Start review', titleCn: '开始处理',
    subEn: "Tell the customer you're looking into it. Optional — leave blank for a generic update.",
    subCn: '告知顾客正在处理,可留空(留空则发送通用更新)。',
    labelEn: 'Note for customer', labelCn: '给顾客的备注',
    phEn: "We're looking into it…", phCn: '我们正在处理…',
    submitEn: 'Mark reviewing', submitCn: '开始处理',
    url: `/api/retail-admin/orders/${id}/refund/review`,
    okEn: 'Marked as reviewing', okCn: '已开始处理',
    errLabelEn: 'Mark-review failed', errLabelCn: '开始处理失败',
  });
}

// Wire ESC + backdrop-click for any transient `.pu-editor-bg` that we
// inject via document.body.appendChild (the refund Approve / Payout / History
// modals). The styled inner card `.pu-editor` swallows the click via
// stopPropagation so only the backdrop tap dismisses. ESC closes the
// top-most floating modal. Idempotent — installed once on first open.
let _puFloatModalHandlersInstalled = false;
function ensurePuFloatModalHandlers() {
  if (_puFloatModalHandlersInstalled) return;
  _puFloatModalHandlersInstalled = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const all = document.querySelectorAll('body > .pu-editor-bg');
    const top = all[all.length - 1];
    if (top) { e.stopPropagation(); top.remove(); }
  });
}

// Helper: take a freshly-created floating .pu-editor-bg, wire backdrop +
// inner stopPropagation, append to body, install ESC handler.
function mountFloatingPuModal(bg) {
  ensurePuFloatModalHandlers();
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  const inner = bg.querySelector('.pu-editor');
  if (inner) inner.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(bg);
}

// Direct refund dialog — backs the order drawer's top "Refund" button. Lets staff
// refund the WHOLE order or a PARTIAL amount / specific lines in one step, without
// waiting for a customer to file a request. Full refunds go through the existing
// PATCH /status → 'refunded' path (unchanged, real WeChat full refund + points
// reversal). Partial refunds POST to /refund/direct (real partial WeChat refund,
// no status flip, no points reversal). Modeled on openRefundApproveDialog.
function openDirectRefundDialog(orderId) {
  const o = _OPEN_ORDER;
  if (!o || o.id !== orderId) { toast('Reopen the order and try again · 请重新打开订单', 'err'); return; }
  const items = (o.items || []).map(it => ({
    id: it.id, name: it.name_en || it.name_cn || ('item #' + it.id),
    qty: Number(it.qty) || 0, unit: it.qty > 0 ? (Number(it.line_total) / Number(it.qty)) : Number(it.unit_price || 0),
  }));
  const total = Number(o.total) || 0;

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 640px; max-width: 92vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin: 0; font-size: 14px;">${cuT('Refund order', '退款订单')}</h3>
          <div class="muted" style="font-size: 11px; margin-top: 2px;">${cuT(
            'Money goes back the way it was paid. Full also reverses points + flips the order to Refunded; partial does not.',
            '原路退回。全额退款会同时退还积分并将订单标记为已退款;部分退款不会。')}</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Close', '关闭')}</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display: block;">
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">${cuT('How much', '退款方式')}</label>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="drf-mode" value="full" checked> ${cuT('Full', '全额')} ¥${fmt(total)}</label>
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="drf-mode" value="amount"> ${cuT('Part — by amount', '部分 — 按金额')}</label>
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="drf-mode" value="lines"> ${cuT('Part — by items', '部分 — 按商品')}</label>
          </div>
        </div>
        <div class="field" id="drf-amt-wrap" style="margin-bottom: 14px; display: none;">
          <label class="stacked">${cuT('Amount', '金额')} (¥)</label>
          <input type="number" id="drf-amt" step="0.01" min="0" max="${total}" value="${total.toFixed(2)}" style="width: 100%;">
          <div class="muted" style="font-size: 11px; margin-top: 4px;">${cuT('Order total', '订单总额')} ¥${fmt(total)}</div>
        </div>
        <div class="field" id="drf-lines-wrap" style="margin-bottom: 14px; display: none;">
          <label class="stacked">${cuT('Items to refund', '退款商品')}</label>
          <div style="border: 1px solid var(--line-soft); border-radius: 6px; padding: 6px;">
            ${items.length ? items.map(it => `
              <div style="display: flex; align-items: center; gap: 10px; padding: 6px; border-bottom: 1px solid var(--line-soft);">
                <label style="flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="checkbox" class="drf-line-chk" data-item="${it.id}" data-unit="${it.unit}" data-maxqty="${it.qty}">
                  <span>${escapeHtml(it.name)}</span>
                </label>
                <input type="number" class="drf-line-qty" data-item="${it.id}" step="0.001" min="0" max="${it.qty}" value="${it.qty}" style="width: 80px;">
                <span class="muted" style="font-size: 11px;">× ¥${fmt(it.unit)} = <b id="drf-line-amt-${it.id}">¥${fmt(it.unit * it.qty)}</b></span>
              </div>`).join('') : `<div class="muted" style="padding: 8px;">${cuT('No items', '无商品')}</div>`}
          </div>
          <div style="margin-top: 6px; text-align: right; font-size: 13px;">${cuT('Items total', '商品合计')}: <b id="drf-lines-total">¥0.00</b></div>
        </div>
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">${cuT('Reason / note', '原因 / 备注')}</label>
          <textarea id="drf-note" rows="2" style="width: 100%;" data-ph-en="Optional" data-ph-cn="可选" placeholder="${cuT('Optional', '可选')}"></textarea>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Cancel', '取消')}</button>
          <button class="btn btn-primary" id="drf-submit">${cuT('Refund', '退款')}</button>
        </div>
      </div>
    </div>`;
  mountFloatingPuModal(bg);

  const recalcLineAmt = () => {
    let sum = 0;
    bg.querySelectorAll('.drf-line-chk').forEach(chk => {
      const it = chk.dataset.item;
      const unit = Number(chk.dataset.unit) || 0;
      const qty = Number(bg.querySelector(`.drf-line-qty[data-item="${it}"]`).value) || 0;
      const amt = chk.checked ? +(unit * qty).toFixed(2) : 0;
      bg.querySelector(`#drf-line-amt-${it}`).textContent = '¥' + fmt(amt);
      sum += amt;
    });
    bg.querySelector('#drf-lines-total').textContent = '¥' + fmt(sum);
  };
  bg.querySelectorAll('.drf-line-chk, .drf-line-qty').forEach(el => el.addEventListener('input', recalcLineAmt));
  recalcLineAmt();

  bg.querySelectorAll('input[name="drf-mode"]').forEach(r => r.addEventListener('change', () => {
    const mode = bg.querySelector('input[name="drf-mode"]:checked').value;
    bg.querySelector('#drf-amt-wrap').style.display   = (mode === 'amount') ? '' : 'none';
    bg.querySelector('#drf-lines-wrap').style.display = (mode === 'lines') ? '' : 'none';
  }));

  bg.querySelector('#drf-submit').addEventListener('click', async (ev) => {
    const mode = bg.querySelector('input[name="drf-mode"]:checked').value;
    const note = bg.querySelector('#drf-note').value || '';
    const btn = ev.currentTarget;

    // FULL → keep the battle-tested status shortcut (real WeChat full refund,
    // points reversal, status → refunded).
    if (mode === 'full') {
      btn.disabled = true;
      try {
        await api(`/api/retail-admin/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'refunded', reason: note } });
        toast(cuT('Refunded in full', '已全额退款'));
        bg.remove();
        openOrder(orderId, { instant: true });
        loadOrders();
      } catch (e) {
        btn.disabled = false;
        toast(cuT('Refund failed', '退款失败') + ': ' + e.message, 'err');
      }
      return;
    }

    // PARTIAL → /refund/direct.
    const body = { note };
    if (mode === 'lines') {
      const sel = [];
      bg.querySelectorAll('.drf-line-chk:checked').forEach(chk => {
        const it = chk.dataset.item;
        const qty = Number(bg.querySelector(`.drf-line-qty[data-item="${it}"]`).value) || 0;
        if (qty > 0) sel.push({ item_id: Number(it), qty });
      });
      if (!sel.length) { toast(cuT('Select at least one item', '至少选一项'), 'err'); return; }
      body.lines = sel;
    } else {
      const amt = Number(bg.querySelector('#drf-amt').value);
      if (!(amt > 0)) { toast(cuT('Enter an amount above 0', '请输入大于 0 的金额'), 'err'); return; }
      if (amt > total + 0.005) { toast(cuT('Amount is more than the order total', '金额超过订单总额'), 'err'); return; }
      body.amount = amt;
    }
    try {
      const j = await adminWrite({
        btn, url: `/api/retail-admin/orders/${orderId}/refund/direct`,
        method: 'POST', body, errLabelEn: 'Refund failed', errLabelCn: '退款失败',
      });
      toast(cuT('Refunded', '已退款') + ` ¥${fmt(j.amount || 0)}`);
      bg.remove();
      openOrder(orderId, { instant: true });
      loadOrders();
    } catch {}
  });
}

// Approve dialog — staff picks amount + (optional) line items, leaves a note.
function openRefundApproveDialog(orderId) {
  // Snapshot the order data already rendered into the drawer.
  const o = _OPEN_ORDER;
  if (!o || o.id !== orderId) { toast('Reopen the order and try again · 请重新打开订单', 'err'); return; }
  const items = (o.items || []).map(it => ({
    id: it.id, name: it.name_en || it.name_cn || ('item #' + it.id),
    qty: Number(it.qty) || 0, unit: it.qty > 0 ? (Number(it.line_total) / Number(it.qty)) : Number(it.unit_price || 0),
  }));
  const total = Number(o.total) || 0;
  let preLines = [];
  try { preLines = o.refund_lines_json ? JSON.parse(o.refund_lines_json) : []; } catch {}
  const preMap = new Map(preLines.map(l => [l.item_id, l.qty]));
  const defaultAmount = o.refund_amount_requested != null ? Number(o.refund_amount_requested) : total;

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 640px; max-width: 92vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin: 0; font-size: 14px;">Approve refund · 批准退款</h3>
          <div class="muted" style="font-size: 11px; margin-top: 2px;">Lock in the amount. Full = order.status flips to refunded + inventory + points reverse. Partial = stays in current status, inventory reverses for selected lines only.</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">Close · 关闭</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display: block;">
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">Mode · 模式</label>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="rf-mode" value="full" checked> Full · 全额</label>
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="rf-mode" value="amount"> Partial — amount · 部分金额</label>
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="rf-mode" value="lines"> Partial — by items · 按商品</label>
          </div>
        </div>
        <div class="field" id="rf-amt-wrap" style="margin-bottom: 14px;">
          <label class="stacked">Amount · 金额 (¥)</label>
          <input type="number" id="rf-amt" step="0.01" min="0" max="${total}" value="${total.toFixed(2)}" style="width: 100%;">
          <div class="muted" style="font-size: 11px; margin-top: 4px;">${cuT('Order total', '订单总额')} ¥${fmt(total)}${o.refund_amount_requested != null ? ' · ' + cuT('customer asked for', '顾客申请') + ' ¥' + fmt(o.refund_amount_requested) : ''}</div>
        </div>
        <div class="field" id="rf-lines-wrap" style="margin-bottom: 14px; display: none;">
          <label class="stacked">Lines · 商品</label>
          <div style="border: 1px solid var(--line-soft); border-radius: 6px; padding: 6px;">
            ${items.length ? items.map(it => `
              <div style="display: flex; align-items: center; gap: 10px; padding: 6px; border-bottom: 1px solid var(--line-soft);">
                <label style="flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="checkbox" class="rf-line-chk" data-item="${it.id}" data-unit="${it.unit}" data-maxqty="${it.qty}" ${preMap.has(it.id) ? 'checked' : ''}>
                  <span>${escapeHtml(it.name)}</span>
                </label>
                <input type="number" class="rf-line-qty" data-item="${it.id}" step="0.001" min="0" max="${it.qty}" value="${preMap.get(it.id) ?? it.qty}" style="width: 80px;">
                <span class="muted" style="font-size: 11px;">× ¥${fmt(it.unit)} = <b id="rf-line-amt-${it.id}">¥${fmt(it.unit * (preMap.get(it.id) ?? it.qty))}</b></span>
              </div>`).join('') : `<div class="muted" style="padding: 8px;">${cuT('No items', '无商品')}</div>`}
          </div>
          <div style="margin-top: 6px; text-align: right; font-size: 13px;">${cuT('Lines total', '商品合计')}: <b id="rf-lines-total">¥0.00</b></div>
        </div>
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">Staff note (shown to customer) · 客服备注(顾客可见)</label>
          <textarea id="rf-note" rows="2" style="width: 100%;" data-ph-en="Optional" data-ph-cn="可选" placeholder="Optional"></textarea>
        </div>
        <div class="field" id="rf-points-wrap" style="margin-bottom: 14px; display: none;">
          <label style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="rf-points"> Also reverse earned + redeemed points · 同时退还积分
          </label>
          <div class="muted" style="font-size: 11px; margin-top: 4px;">Auto-on for full refunds. Off by default for partials. · 全额退款默认开启;部分退款默认关闭。</div>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">Cancel · 取消</button>
          <button class="btn btn-primary" id="rf-submit">Approve · 批准</button>
        </div>
      </div>
    </div>`;
  mountFloatingPuModal(bg);

  const recalcLineAmt = () => {
    let sum = 0;
    bg.querySelectorAll('.rf-line-chk').forEach(chk => {
      const it = chk.dataset.item;
      const unit = Number(chk.dataset.unit) || 0;
      const qty = Number(bg.querySelector(`.rf-line-qty[data-item="${it}"]`).value) || 0;
      const amt = chk.checked ? +(unit * qty).toFixed(2) : 0;
      bg.querySelector(`#rf-line-amt-${it}`).textContent = '¥' + fmt(amt);
      sum += amt;
    });
    bg.querySelector('#rf-lines-total').textContent = '¥' + fmt(sum);
  };
  bg.querySelectorAll('.rf-line-chk, .rf-line-qty').forEach(el => el.addEventListener('input', recalcLineAmt));
  recalcLineAmt();

  bg.querySelectorAll('input[name="rf-mode"]').forEach(r => r.addEventListener('change', () => {
    const mode = bg.querySelector('input[name="rf-mode"]:checked').value;
    bg.querySelector('#rf-amt-wrap').style.display   = (mode === 'full' || mode === 'amount') ? '' : 'none';
    bg.querySelector('#rf-lines-wrap').style.display = (mode === 'lines') ? '' : 'none';
    bg.querySelector('#rf-points-wrap').style.display = (mode !== 'full') ? '' : 'none';
    if (mode === 'full') bg.querySelector('#rf-amt').value = total.toFixed(2);
    if (mode === 'amount') bg.querySelector('#rf-amt').value = defaultAmount.toFixed(2);
    bg.querySelector('#rf-points').checked = (mode === 'full');
  }));

  bg.querySelector('#rf-submit').addEventListener('click', async (ev) => {
    const mode = bg.querySelector('input[name="rf-mode"]:checked').value;
    const body = { note: bg.querySelector('#rf-note').value || '' };
    if (mode === 'lines') {
      const sel = [];
      bg.querySelectorAll('.rf-line-chk:checked').forEach(chk => {
        const it = chk.dataset.item;
        const qty = Number(bg.querySelector(`.rf-line-qty[data-item="${it}"]`).value) || 0;
        if (qty > 0) sel.push({ item_id: Number(it), qty });
      });
      if (!sel.length) { toast('Select at least one line · 至少选一项', 'err'); return; }
      body.lines = sel;
      body.reverse_points = bg.querySelector('#rf-points').checked;
    } else {
      body.amount = Number(bg.querySelector('#rf-amt').value);
      body.reverse_points = (mode === 'full') ? true : bg.querySelector('#rf-points').checked;
    }
    try {
      const j = await adminWrite({
        btn: ev.currentTarget, url: `/api/retail-admin/orders/${orderId}/refund/approve`,
        method: 'POST', body, errLabelEn: 'Approve failed', errLabelCn: '批准失败',
      });
      toast(`Approved · 已批准 ¥${fmt(j.amount || 0)}`);
      bg.remove();
      openOrder(orderId);
      loadOrders();
    } catch {}
  });
}

function openRefundPayoutDialog(orderId) {
  const o = _OPEN_ORDER;
  if (!o || o.id !== orderId) { toast('Reopen the order and try again · 请重新打开订单', 'err'); return; }
  const apv = Number(o.refund_amount_approved) || 0;

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 520px; max-width: 92vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin: 0; font-size: 14px;">Record payout · 记录退款</h3>
          <div class="muted" style="font-size: 11px; margin-top: 2px;">WeChat sends the money back to the customer automatically. Other methods just record a payout you've already made manually. · 选择"微信"将自动原路退款给顾客;其他方式仅记录你已手动完成的退款。</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">Close · 关闭</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display: block;">
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">Method · 退款方式</label>
          <select id="rfp-method" style="width: 100%;">
            <option value="wechat">WeChat Pay · 微信</option>
            <option value="alipay">Alipay · 支付宝</option>
            <option value="bank">Bank transfer · 银行转账</option>
            <option value="wallet">Wallet credit · 钱包</option>
            <option value="store_credit">Store credit · 店铺余额</option>
            <option value="cash">Cash · 现金</option>
            <option value="other">Other · 其他</option>
          </select>
        </div>
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">Reference / txn id · 凭证号</label>
          <input type="text" id="rfp-ref" data-ph-en="Provider txn id, bank ref, etc." data-ph-cn="第三方交易号、银行参考号等" placeholder="Provider txn id, bank ref, etc." style="width: 100%;">
        </div>
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">Amount · 金额 (¥)</label>
          <input type="number" id="rfp-amt" step="0.01" min="0" max="${apv}" value="${apv.toFixed(2)}" style="width: 100%;">
          <div class="muted" style="font-size: 11px; margin-top: 4px;">Approved ¥${fmt(apv)} — usually paid in full · 已批准金额,通常一次性退还</div>
        </div>
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">Note (optional) · 备注(可选)</label>
          <textarea id="rfp-note" rows="2" style="width: 100%;"></textarea>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">Cancel · 取消</button>
          <button class="btn btn-primary" id="rfp-submit">Mark paid · 确认已退款</button>
        </div>
      </div>
    </div>`;
  mountFloatingPuModal(bg);
  bg.querySelector('#rfp-submit').addEventListener('click', async (ev) => {
    const body = {
      method:    bg.querySelector('#rfp-method').value,
      reference: bg.querySelector('#rfp-ref').value,
      amount:    Number(bg.querySelector('#rfp-amt').value),
      note:      bg.querySelector('#rfp-note').value,
    };
    try {
      const j = await adminWrite({
        btn: ev.currentTarget, url: `/api/retail-admin/orders/${orderId}/refund/payout`,
        method: 'POST', body, errLabelEn: 'Payout failed', errLabelCn: '记录失败',
      });
      toast(`Payout recorded · 退款已记录 ¥${fmt(j.amount || 0)}`);
      bg.remove();
      openOrder(orderId);
      loadOrders();
    } catch {}
  });
}

// Pretty-print the refund-event meta blob. The DB stores e.g.
// `{lines: [{item_id, product_id, qty, amount}], reason: '…'}` — we
// translate that to readable lines instead of dumping raw JSON.
function formatRefundMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const bits = [];
  if (Array.isArray(meta.lines) && meta.lines.length) {
    const lineHtml = meta.lines.map(l => {
      const item = _OPEN_ORDER?.items?.find(it => it.id === l.item_id);
      const name = item ? (item.name_en || item.name_cn || ('item#' + l.item_id))
                        : ('item#' + (l.item_id ?? l.product_id ?? '?'));
      const qty = l.qty != null ? ` × ${l.qty}` : '';
      const amt = l.amount != null ? ` — ¥${fmt(l.amount)}` : '';
      return `<div>· ${escapeHtml(name)}${qty}${amt}</div>`;
    }).join('');
    bits.push(`<div style="margin-top: 4px;"><div class="muted" style="font-size:10px; letter-spacing:.08em; text-transform:uppercase;">Lines · 退款明细</div>${lineHtml}</div>`);
  }
  if (meta.reason) {
    bits.push(`<div class="muted" style="font-size:11px; margin-top: 4px;">Reason · 原因: ${escapeHtml(meta.reason)}</div>`);
  }
  if (meta.payout_method) {
    const ref = meta.payout_ref ? ` · ${escapeHtml(meta.payout_ref)}` : '';
    bits.push(`<div class="muted" style="font-size:11px; margin-top: 4px;">Payout · 打款: ${escapeHtml(meta.payout_method)}${ref}</div>`);
  }
  // Surface any other fields we haven't pretty-printed, so nothing is
  // silently swallowed — but render them as `key: value` text, not JSON.
  const handled = new Set(['lines', 'reason', 'payout_method', 'payout_ref']);
  for (const [k, v] of Object.entries(meta)) {
    if (handled.has(k)) continue;
    if (v == null) continue;
    const val = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    bits.push(`<div class="muted" style="font-size:11px; margin-top: 4px;">${escapeHtml(k)}: ${escapeHtml(val)}</div>`);
  }
  return bits.join('');
}

async function openRefundEvents(orderId) {
  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 540px; max-width: 92vw;">
      <div class="pu-editor-head">
        <div><h3 style="margin: 0; font-size: 14px;">Refund history · 退款历史</h3></div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">Close · 关闭</button>
      </div>
      <div class="pu-editor-body" id="rfe-body" style="grid-template-columns: 1fr; padding: 18px; display: block; max-height: 60vh; overflow-y: auto;">Loading · 加载中…</div>
    </div>`;
  mountFloatingPuModal(bg);
  try {
    const j = await api(`/api/retail-admin/orders/${orderId}/refund/events`);
    const body = bg.querySelector('#rfe-body');
    if (!j.data.length) { body.innerHTML = '<div class="muted">No events yet · 暂无记录</div>'; return; }
    body.innerHTML = j.data.map(ev => `
      <div style="display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line-soft);">
        <div style="font-family: var(--f-mono); font-size: 11px; color: var(--text-3); min-width: 120px;">${formatDate(ev.created_at)}</div>
        <div style="flex: 1;">
          <div><b>${escapeHtml(ev.event)}</b>${ev.amount != null ? ` <span class="muted">¥${fmt(ev.amount)}</span>` : ''}</div>
          <div class="muted" style="font-size: 11px; margin-top: 2px;">${cuT('by', '操作人')} ${escapeHtml(ev.user_username || ev.customer_nickname || (ev.user_id ? 'staff#' + ev.user_id : cuT('customer', '顾客')))}</div>
          ${ev.note ? `<div style="font-size: 12px; margin-top: 4px;">${escapeHtml(ev.note)}</div>` : ''}
          ${formatRefundMeta(ev.meta)}
        </div>
      </div>`).join('');
  } catch (e) {
    bg.querySelector('#rfe-body').innerHTML = `<div class="err">Failed · 加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

// Refresh every open-work count badge on the orders status-chip strip in one
// cheap call. We badge ONLY the open states an operator is meant to clear
// (pending/paid/preparing/dispatched/awaiting-restock/refund-queue) — terminal
// states (delivered/cancelled/refunded/all) grow forever, so they stay bare.
// Each badge is hidden when its count is 0 (.chip-ct:empty), so cleared queues
// don't carry a "0". Honours the active store filter, matching the list.
async function refreshOrderStatusCounts() {
  if (!document.getElementById('orders-status-chips')) return;
  const storeId = (document.getElementById('orders-store') || {}).value || '';
  try {
    const j = await api('/api/retail-admin/order-status-counts' + (storeId ? '?store_id=' + storeId : ''));
    const d = j.data || {};
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n > 0 ? String(n) : ''; };
    set('oc-pending_payment', d.pending_payment);
    set('oc-paid',            d.paid);
    set('oc-preparing',       d.preparing);
    set('oc-dispatched',      d.dispatched);
    set('oc-awaiting_restock',d.awaiting_restock);
    set('refund-queue-count', d.refunds_open);
  } catch {}
}

// Products are managed entirely from the main /products page on the
// kitchen admin — name, price, description, image, and the new
// "Show in mini-app shop" toggle all live there. No duplicate retail
// price or description; one source of truth.

