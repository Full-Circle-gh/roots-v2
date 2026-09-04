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
// ── Paging ─────────────────────────────────────────────────────────────
// The list is server-paged (LIMIT/OFFSET). Before this existed it asked for
// no limit, silently got the server's default 100 newest rows, and every
// older order was unreachable from this screen.
//
// ORD_PAGE survives an ordinary loadOrders() on purpose: most of the ~30
// callers are "I just changed an order, repaint the list", and yanking the
// operator back to page 1 mid-scan would be worse than the bug we fixed.
// Only a genuine filter change resets it — see ordFilterChanged().
let ORD_PAGE = 1;
let ORD_PAGE_SIZE = 50;
let ORD_TOTAL = 0;
let _ordClampRetry = false;   // guards the one refetch when a page falls off the end
// When set to { id, name }, the list is scoped to one customer's orders (the
// "View all N orders" path from a customer's drawer). null = every customer.
// Read by loadOrders() alongside the DOM filters; surfaced as a removable chip.
let ORD_CUSTOMER_FILTER = null;
// The rows currently painted. Held so the bulk bar can reason about what is
// ticked — which step each selected order could actually move to — without
// re-reading it out of the DOM.
let ORD_ROWS = [];

// A filter re-cuts the result set, so the current page number no longer
// points at the same orders. Start over at page 1.
function ordFilterChanged() {
  ORD_PAGE = 1;
  loadOrders();
}

// ── Scope the orders list to one customer ─────────────────────────────
// Entry point from a customer drawer's "View all N orders →" link. The drawer
// is still open when this fires (goTab closes it, and CU_CURRENT is nulled
// ~240ms later by the drawer-close hook), so the name is read synchronously
// here rather than threaded through an escape-prone inline onclick argument.
function ordViewCustomerOrders(id) {
  const cid = Number(id);
  if (!Number.isFinite(cid)) return;
  const c = (typeof CU_CURRENT !== 'undefined' && CU_CURRENT) ? CU_CURRENT.customer : null;
  // Same nickname-or-#id name the rest of the product shows; raw, kept out of
  // any EN·CN string (rendered with data-no-i18n in the chip).
  const name = (c && c.id === cid && c.nickname) ? c.nickname : ('#' + cid);
  ORD_CUSTOMER_FILTER = { id: cid, name };
  // "View all N" promises the customer's whole history, so clear the other
  // facets — a lingering status/channel/store filter would show fewer than N
  // and the chip would contradict the promised count.
  ordResetFacetsUI();
  goTab('orders');       // activates the Orders section (also closes the drawer)
  ordFilterChanged();    // page → 1 + reload, now carrying customer_id
}
function ordClearCustomerFilter() {
  ORD_CUSTOMER_FILTER = null;
  ordFilterChanged();    // back to the full list (facets were reset on entry)
}
// Reset the status chips / channel dropdown / store / search to their defaults
// WITHOUT reloading — the single reload is fired by the caller afterwards.
function ordResetFacetsUI() {
  const st = document.getElementById('orders-status');
  if (st) st.value = '';
  $$('#orders-status-chips .status-chip').forEach(el =>
    el.classList.toggle('active', (el.dataset.status || '') === ''));
  const chan = document.getElementById('orders-channel');
  if (chan) chan.value = '';
  $$('#chd-pop .chd-item').forEach(el =>
    el.classList.toggle('active', (el.dataset.channel || '') === ''));
  const allItem = document.querySelector('#chd-pop .chd-item[data-channel=""]');
  const chTxt = document.getElementById('chd-btn-txt');
  const chIco = document.getElementById('chd-btn-ico');
  const chBtn = document.getElementById('chd-btn');
  if (allItem && chTxt) chTxt.textContent = allItem.textContent.trim();
  if (allItem && chIco) { const ico = allItem.querySelector('.chan-ico'); if (ico) chIco.innerHTML = ico.innerHTML; }
  if (chBtn) chBtn.classList.remove('is-set');
  const store = document.getElementById('orders-store');
  if (store) store.value = '';
  const q = document.getElementById('orders-q');
  if (q) q.value = '';
}
// The removable "showing one customer" chip above the list. Rendered on every
// loadOrders() so it tracks the filter state; hidden when the scope is off.
function ordRenderCustChip() {
  const host = document.getElementById('orders-cust-chip');
  if (!host) return;
  if (!ORD_CUSTOMER_FILTER) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML =
    `<span class="ocf-lbl">${cuT('Showing orders for', '仅显示以下顾客的订单')}</span>` +
    `<span class="ocf-name" data-no-i18n>${escapeHtml(ORD_CUSTOMER_FILTER.name)}</span>` +
    `<button type="button" class="ocf-x" onclick="ordClearCustomerFilter()"` +
      ` title="${cuT('Show all orders', '显示全部订单')}" aria-label="${cuT('Clear customer filter', '清除顾客筛选')}">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` +
    `</button>`;
}

// The pager under the orders table (and under the phone card list — same
// mount, it sits after both). Shared renderer, see rmRenderPager in 01-core.js.
function ordRenderPager() {
  rmRenderPager('ord-pager', {
    page: ORD_PAGE, pageSize: ORD_PAGE_SIZE, total: ORD_TOTAL,
    sizes: [50, 100, 200],
    noun: { en: 'orders', one: 'order', cn: '个订单' },
    onPage: p => {
      ORD_PAGE = p;
      // A new page is a new set of rows: clear the arrival baseline so the
      // incoming orders don't all flash "NEW" and fire the chime at once.
      _ORDERS_SEEN_IDS = null;
      _ORDERS_NOTIFIED_IDS = null;
      _ORDERS_LAST_FP = null;
      loadOrders();
      // The operator clicked a pager at the bottom of a long list — put the top
      // of the new page under their eyes instead of leaving them at the foot.
      // Scroll to whichever list is actually on screen: the table is
      // display:none on phones, and scrollIntoView on a hidden node does nothing.
      const tbl   = document.getElementById('orders-table');
      const cards = document.getElementById('rm-orders-cards');
      const target = (cards && cards.offsetParent) ? cards : tbl;
      if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    onSize: s => { ORD_PAGE_SIZE = s; ORD_PAGE = 1; _ORDERS_LAST_FP = null; loadOrders(); },
  });
}

function setOrderStatus(chip) {
  const value = chip.dataset.status || '';
  $('#orders-status').value = value;
  $$('#orders-status-chips .status-chip').forEach(el => el.classList.toggle('active', el === chip));
  // Any status chip leaves the drafts view — one way back, the one the operator
  // already knows. Drafts carries no data-status, so it can never arrive here.
  if (typeof ordHideDrafts === 'function') ordHideDrafts();
  ordFilterChanged();
}
// Channel facet — orthogonal to status. Filters the combined list by origin
// (mini app / web / Meituan); '' = all channels. UI is a dropdown (.chd-*),
// not a chip row — see setOrderChannel/chdToggle below.
function setOrderChannel(item) {
  const value = item.dataset.channel || '';
  const hid = document.getElementById('orders-channel');
  if (hid) hid.value = value;
  $$('#chd-pop .chd-item').forEach(el => el.classList.toggle('active', el === item));
  const btn = document.getElementById('chd-btn');
  const ico = document.getElementById('chd-btn-ico');
  const txt = document.getElementById('chd-btn-txt');
  if (ico) ico.innerHTML = item.querySelector('.chan-ico').innerHTML;
  if (txt) txt.textContent = item.textContent.trim();
  if (btn) btn.classList.toggle('is-set', !!value);
  chdClose();
  ordFilterChanged();
}
let _CHD_OPEN = false;
function chdToggle() {
  _CHD_OPEN = !_CHD_OPEN;
  const pop = document.getElementById('chd-pop'); if (pop) pop.hidden = !_CHD_OPEN;
  const wrap = document.getElementById('chd-wrap'); if (wrap) wrap.classList.toggle('open', _CHD_OPEN);
  if (_CHD_OPEN) setTimeout(() => document.addEventListener('mousedown', chdOutside), 0);
  else document.removeEventListener('mousedown', chdOutside);
}
function chdOutside(e) {
  if (e.target.closest && e.target.closest('.chd-wrap')) return;
  chdClose();
}
function chdClose() {
  _CHD_OPEN = false;
  const pop = document.getElementById('chd-pop'); if (pop) pop.hidden = true;
  const wrap = document.getElementById('chd-wrap'); if (wrap) wrap.classList.remove('open');
  document.removeEventListener('mousedown', chdOutside);
}
// The × on the trigger, shown only once a channel is applied. Modelled on
// Customers' cuClearChan (08-customers.js:134), which is this same control on
// this same facet.
//
// It hands the real "All channels" menu item to setOrderChannel — the SAME
// call picking that item makes — rather than zeroing the filter itself. One
// way to clear the channel, so the trigger's label, its icon, the is-set fill,
// the menu's tick and the hidden #orders-channel input can never disagree
// about what "cleared" means.
//
// stopPropagation is what keeps the click off #chd-btn; without it the button
// beneath would toggle the menu open on the way past, which is the opposite of
// what the operator asked for. An × that only opens a menu is an inert control.
function chdClear(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  const all = document.querySelector('#chd-pop .chd-item[data-channel=""]');
  if (!all) return;
  setOrderChannel(all);
  // Clearing hides the × that was just activated, so a keyboard operator would
  // be dropped back to <body> mid-page. Hand focus to the trigger it lived in.
  // Harmless on a mouse click — :focus-visible suppresses the ring there.
  const btn = document.getElementById('chd-btn');
  if (btn) btn.focus();
}
// ── Fulfilment types, client side ───────────────────────────────────────────
// A counter sale is handed over at the till in the same moment it is paid: it
// ships nothing, promises nothing, and has no forward state to advance to. It
// lands on status 'delivered' the instant it is paid (see markOrderPaid), which
// is why several guards below have to name it explicitly — without them a
// walk-in is offered dispatch and undo-dispatch actions.
//
// Deliberate duplication of lib/fulfilment.js: this file is a browser script,
// not a module, so it cannot require the server's definition. The two copies are
// held together by scripts/verify-fulfilment-types.js, which EXTRACTS these
// functions from this file by name and asserts them against the same table — so
// a divergence fails the deploy gate instead of drifting quietly.
function ordIsCounter(o) {
  return String((o && o.fulfillment_type) || '').toLowerCase() === 'counter';
}
function ordShipsNothing(o) {
  const t = String((o && o.fulfillment_type) || '').toLowerCase();
  return t === 'pickup' || t === 'counter';
}
// Which non-storefront channels are shown read-only in the combined list — the
// storefront doesn't fulfil/print them, so no drawer, NEW mark, or chime.
// Meituan and Eleme are both marketplace orders mirrored in only to deduct
// stock and show progress — the platform itself owns accept/prepare/dispatch,
// so our own fulfilment/refund/print controls never apply to them (see
// lib/inventory.js's QINGYUN_PUSH_CHANNELS, which excludes both for the same
// reason: no recipient name/phone/address of our own to ship against).
// gzgrocery joins in phase 2.
function ordIsReadonlyChannel(o) {
  const c = String(o.channel || '').toLowerCase();
  return c === 'meituan' || c === 'eleme' || c === 'gzgrocery';
}
// Short display for the list glance. Channel/legacy numbers look like
// PREFIX + [sep] + yyyymmdd + sequence (e.g. MT20260706256422, GZ-138616).
// The date is dead weight — the row already carries a time column — so
// collapse anything over 6 digits to prefix + last 6 (MT256422). A hyphen
// separator (GZ-138616) is dropped so the column doesn't line-break at the
// dash. Full number still shows in the drawer and on hover.
function ordShortNo(no) {
  const s = String(no || '');
  const m = s.match(/^([A-Za-z]+)[-·\s]?(\d+)$/);
  if (!m) return s;
  const prefix = m[1], digits = m[2];
  if (digits.length > 6) return prefix + digits.slice(-6);
  // Short enough already — but drop a wrapping hyphen.
  return s.includes('-') ? prefix + digits : s;
}
// Classify by inclusion, never by fall-through (§1.17 rule 2). This used to
// end in a bare `return 'WeChat'`, so any channel it had never heard of —
// eleme is the live candidate, eleme-internal.js writes retail_orders rows —
// was labelled WeChat on every row, with a default's full authority. An
// unrecognised channel now renders its own raw key: visibly odd beats
// plausibly wrong. Same shape as csName in 01-core.js (`|| ch`).
// A null/empty channel still resolves to WeChat, which is not a guess — the
// retail_orders.channel column is DEFAULT 'wechat'.
function ordChannelLabel(o) {
  const c = String(o.channel || 'wechat').toLowerCase();
  if (c === 'meituan')   return 'Meituan';
  if (c === 'eleme')     return 'Eleme';
  if (c === 'gzgrocery') return 'Gzgrocery';
  if (c === 'web')       return 'Web';
  if (c === 'wechat')    return 'WeChat';
  // Staff-keyed origins — where the customer reached us, asked on the New order
  // form. 'manual' is the LEGACY value: rows written before the form asked the
  // question, plus every till sale (whose origin is the counter, recorded in
  // fulfillment_type). It is no longer selectable, and "Unattributed" says so
  // rather than implying someone chose it.
  if (c === 'pickup')      return cuT('Pick up', '到店自取');
  if (c === 'wechat_chat') return cuT('WeChat message', '微信消息');
  if (c === 'wholesale')   return cuT('Wholesale', '批发');
  if (c === 'other')       return cuT('Other', '其他');
  if (c === 'manual')      return cuT('Unattributed', '未归属');
  return c;
}
// Read-only channels (Meituan) carry their OWN order lifecycle we don't fulfil.
// The daemon mirrors the platform's current status label into channel_status
// (拣货中 / 配送中 / 已完成 / 已取消 …); we show it verbatim instead of a fixed
// "Paid". Map the common labels to English + a pill tone that reuses the existing
// st-* status colours; unknown labels fall back to the raw Chinese, coloured by
// keyword so the tone still reads right.
const MT_STATUS = {
  '待支付':     { en: 'Unpaid',           tone: 'pending_payment' },
  '待付款':     { en: 'Unpaid',           tone: 'pending_payment' },
  '待接单':     { en: 'To accept',        tone: 'paid' },
  '已接单':     { en: 'Accepted',         tone: 'paid' },
  '商家已接单': { en: 'Accepted',         tone: 'paid' },
  '待拣货':     { en: 'To pick',          tone: 'preparing' },
  '拣货中':     { en: 'Picking',          tone: 'preparing' },
  '待发货':     { en: 'To dispatch',      tone: 'preparing' },
  '待发起配送': { en: 'Awaiting dispatch', tone: 'preparing' },
  '待配送':     { en: 'Awaiting delivery', tone: 'preparing' },
  '备货中':     { en: 'Preparing',        tone: 'preparing' },
  '正在分配骑手': { en: 'Assigning rider',  tone: 'dispatched' },
  '等待骑手接单': { en: 'Awaiting rider',   tone: 'dispatched' },
  '骑手已接单': { en: 'Rider assigned',   tone: 'dispatched' },
  '待骑手到店': { en: 'Rider heading over', tone: 'dispatched' },
  '骑手到店中': { en: 'Rider heading over', tone: 'dispatched' },
  '骑手已到店': { en: 'Rider at store',   tone: 'dispatched' },
  '待骑手取货': { en: 'Awaiting pickup',  tone: 'dispatched' },
  '待取货':     { en: 'Awaiting pickup',  tone: 'dispatched' },
  '骑手已取货': { en: 'Rider en route',   tone: 'dispatched' },
  '骑手已取餐': { en: 'Rider en route',   tone: 'dispatched' },
  '配送中':     { en: 'Delivering',       tone: 'dispatched' },
  '派送中':     { en: 'Delivering',       tone: 'dispatched' },
  '已送达':     { en: 'Delivered',        tone: 'delivered' },
  '用户已收货': { en: 'Delivered',        tone: 'delivered' },
  '用户已收餐': { en: 'Delivered',        tone: 'delivered' },
  '已收货':     { en: 'Delivered',        tone: 'delivered' },
  '已收餐':     { en: 'Delivered',        tone: 'delivered' },
  '已签收':     { en: 'Delivered',        tone: 'delivered' },
  '妥投':       { en: 'Delivered',        tone: 'delivered' },
  '已妥投':     { en: 'Delivered',        tone: 'delivered' },
  '签收成功':   { en: 'Delivered',        tone: 'delivered' },
  '已下单':     { en: 'Order placed',     tone: 'paid' },
  '已揽收':     { en: 'Picked up',        tone: 'dispatched' },
  '运输中':     { en: 'In transit',       tone: 'dispatched' },
  '派件中':     { en: 'Out for delivery', tone: 'dispatched' },
  '拒收':       { en: 'Rejected',         tone: 'cancelled' },
  '拒签':       { en: 'Rejected',         tone: 'cancelled' },
  '派送失败':   { en: 'Delivery failed',  tone: 'cancelled' },
  '投递失败':   { en: 'Delivery failed',  tone: 'cancelled' },
  '已完成':     { en: 'Completed',        tone: 'delivered' },
  '交易完成':   { en: 'Completed',        tone: 'delivered' },
  '订单完成':   { en: 'Completed',        tone: 'delivered' },
  '已取消':     { en: 'Cancelled',        tone: 'cancelled' },
  '订单取消':   { en: 'Cancelled',        tone: 'cancelled' },
  '已退款':     { en: 'Refunded',         tone: 'refunded' },
  '退款中':     { en: 'Refunding',        tone: 'refunded' },
  '部分退款':   { en: 'Partial refund',   tone: 'refunded' },
  '退货退款':   { en: 'Refund / return',  tone: 'refunded' },
};
// A platform value that is not a lifecycle label at all: an order-VALIDITY flag
// (Eleme sends `status: "VALID"` beside the real stage), a placeholder, or a bare
// numeric code. Null rather than a tone, so a caller renders NOTHING instead of
// the confident "In progress" the keyword fallback would otherwise invent — which
// is exactly what this cell showed on delivered Eleme orders before 6b8cda0
// removed it. Belt to the parser's braces (lib/eleme-browser.js pickStage now
// looks past these), because the rows already stored still carry them.
const NOT_A_STATUS_LABEL = /^(valid|invalid|normal|none|null|unknown|default|true|false|-?\d+(\.\d+)?)$/i;
function channelStatusMeta(desc) {
  const d = String(desc || '').trim();
  if (!d) return null;
  if (NOT_A_STATUS_LABEL.test(d)) return null;
  if (MT_STATUS[d]) return { en: MT_STATUS[d].en, cn: d, tone: MT_STATUS[d].tone };
  // Keyword fallback for labels not in the table — colour sensibly AND give a
  // generic English word by tone, so the English view never leaks raw Chinese.
  // The Chinese view still shows the exact platform label.
  let tone = 'paid', en = 'In progress';
  if (/退款|退货/.test(d))                { tone = 'refunded';        en = 'Refund'; }
  else if (/拒收|拒签|派送失败|投递失败|配送异常/.test(d)) { tone = 'cancelled'; en = 'Delivery failed'; }
  else if (/取消/.test(d))                { tone = 'cancelled';       en = 'Cancelled'; }
  else if (/完成|送达|签收|收货|收餐|妥投/.test(d)) { tone = 'delivered';   en = 'Delivered'; }
  else if (/配送|派送|派件|骑手|取货|取餐|揽收|运输/.test(d)) { tone = 'dispatched';  en = 'Delivering'; }
  else if (/拣货|备货|发货|制作/.test(d))   { tone = 'preparing';       en = 'Preparing'; }
  else if (/待支付|未支付|待付款/.test(d))  { tone = 'pending_payment'; en = 'Unpaid'; }
  return { en, cn: d, tone };
}
// channelStatusMeta is used by the read-only order drawer to show the EXACT
// Meituan label (e.g. "Rider heading over") as a detail field. The list/card
// status pill now uses OUR internal status (mapped server-side in
// routes/meituan-internal.js internalStatusForChannel), so the pill + tab agree.
// Clean {name, phone} for the customer column. gzgrocery mirrors the whole
// OpenCart customer cell — "Name (phone) address…" — into recipient_name (its
// phone/ship fields stay null), so the raw blob would spill the address into
// this column. Split it back into name + phone; the address belongs in SHIP TO.
// Every other channel already has structured fields, so it passes straight
// through. Shared with the mobile card renderer in retail-admin.html.
function ordCustomerLines(o) {
  if (o && String(o.channel || '').toLowerCase() === 'gzgrocery' && !o.recipient_phone) {
    const blob = String(o.recipient_name || o.nickname || '');
    const m = /\((\d{6,})\)/.exec(blob);
    if (m) return { name: blob.slice(0, m.index).trim() || '—', phone: m[1] };
  }
  return { name: (o && (o.nickname || o.recipient_name)) || '—', phone: (o && o.recipient_phone) || '' };
}
window.ordCustomerLines = ordCustomerLines;
let _ordersSearchTimer = null;
function debouncedLoadOrders() {
  clearTimeout(_ordersSearchTimer);
  _ordersSearchTimer = setTimeout(ordFilterChanged, 350);   // a new search starts at page 1
}

// ── Auto-refresh state ─────────────────────────────────────────────────
// New orders reach the screen by live push: the admin-wide SSE hub
// (retailLiveSubscribe, 01-core.js) nudges us when anything moves and we
// refetch. Nobody clicks refresh; there is no button. Worst-case latency is
// the server's 5s watermark tick plus the 400ms debounce below, so ~5s —
// bounded by that tick, not by anything on this page.
// ORDERS_POLL_MS is only a backstop for the stretch when that socket is
// down and reconnecting, so it is deliberately slow — speeding it back up
// would add load without making anything more current.
// Fingerprint check skips DOM rebuilds when nothing changed — no flicker.
// We also remember the set of order IDs we've already shown so we can
// flash + toast genuinely-new arrivals (vs. the first paint).
const ORDERS_POLL_MS = 60000;
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
       + (r.invoice_status||'') + ':'
       + (r.tracking_number||'') + ':'
       + (r.local_eta||'') + ':'
       + (r.updated_at || r.placed_at || '') + ',';
  }
  return s;
}

function _ordersFilterKey() {
  return [
    $('#orders-status').value,
    (document.getElementById('orders-channel') || {}).value || '',
    $('#orders-q').value.trim(),
    (document.getElementById('orders-store') || {}).value || '',
    ORD_CUSTOMER_FILTER ? 'c' + ORD_CUSTOMER_FILTER.id : '',
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
    // A FULL refund flips the order's primary status to 'refunded'; a partial
    // refund leaves it (still Paid/Delivered/…). Distinguish the two so a
    // part-refund doesn't masquerade as a full "refunded".
    if (o.status === 'refunded') {
      return `<span class="pill refund-pending" title="Refund paid · 已退款">↩ refunded · 已退款</span>`;
    }
    // Show the CUMULATIVE amount actually refunded (refund_amount_paid accumulates
    // across repeated partial refunds); fall back to approved/requested for older
    // rows that predate the accumulation fix.
    const paid = [o.refund_amount_paid, o.refund_amount_approved, o.refund_amount_requested]
      .map(Number).find(n => Number.isFinite(n) && n > 0);
    const amt = paid ? ` ${acMoney(paid)}` : '';
    return `<span class="pill refund-partial" title="Partial refund · 部分退款${amt}">↩ part refund${amt} · 部分退款</span>`;
  }
  const labels = {
    pending:   'refund req · 申请退款',
    reviewing: 'reviewing · 处理中',
    approved:  'approved · 已批准',
    paying:    'paying · 退款中',
  };
  const label = labels[rs] || rs;
  return `<span class="pill refund-pending" title="Open refund · 退款进行中 (${rs})">↩ ${label}</span>`;
}

const ICON_INV_OWED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3v18l2.5-1.5L9 21l3-1.5L15 21l2.5-1.5L20 21V3H4z"/><line x1="8" y1="9" x2="16" y2="9"/></svg>';
const ICON_INV_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3v18l2.5-1.5L9 21l3-1.5L15 21l2.5-1.5L20 21V3H4z"/><polyline points="8 12 11 15 16 9"/></svg>';
const ICON_STOCK_PENDING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>';
// A receipt the printer never produced — on the drawer's marks line, brick.
const ICON_PRINT_FAILED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 6 3 18 3 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><line x1="9" y1="15" x2="15" y2="21"/><line x1="15" y1="15" x2="9" y2="21"/></svg>';

// Fapiao sub-line under the status pill. Brass while the invoice is still
// owed, muted once it has been issued — so the list tells "never asked" apart
// from "asked and done" without opening a drawer. A row with no invoice
// request renders nothing. This is the ONLY invoice mark the table carries:
// no summary strip under the row, and the full detail (title, tax ID, email,
// fapiao file, Copy for accounting) stays in the order drawer. Shares
// .ord-note-line with stockPendingBadge() so both read as one quiet family
// instead of competing pills.
function invoiceLine(o) {
  if (!Number(o.needs_invoice)) return '';
  const issued = o.invoice_status === 'issued';
  const label = issued ? cuT('Invoice issued', '已开票') : cuT('Invoice to issue', '待开票');
  const title = issued
    ? cuT('Invoice issued for this order', '此订单已开票')
    : cuT('Invoice requested — issue it from the order drawer', '顾客申请开票 — 请在订单详情中开票');
  return `<div class="ord-note-line${issued ? '' : ' is-owed'}" title="${escapeAttr(title)}">`
    + `${issued ? ICON_INV_DONE : ICON_INV_OWED}${label}</div>`;
}

// Why a pending order is STILL pending: the customer sent an Alipay screenshot,
// the read succeeded, and it didn't match (short amount, wrong payee, stale
// receipt, or a proof already used on another order). Without this the row is
// indistinguishable from an order nobody ever paid for — which is exactly how
// one sits unnoticed while the customer waits. Brick, because it is money in
// dispute; a note line rather than a pill so it never competes with the order's
// own status. Only on pending_payment: once a human has judged it and marked it
// paid (or cancelled it), the verdict is history and the row says nothing.
const ICON_PAY_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16v.2"/></svg>';
const ICON_PAY_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.4 12.2 2.4 2.4 4.8-5.2"/></svg>';
function paymentCheckLine(o) {
  // Only while unpaid. Once a human has judged it — marked paid, cancelled —
  // the verdict is history and the row says nothing.
  if (o.status !== 'pending_payment') return '';
  const v = o.alipay_ocr_verdict;
  if (v === 'mismatch') {
    const title = cuT(
      "The payment screenshot was read and doesn't match this order — open it and check before marking paid",
      '已识别付款截图,与本订单不一致 — 请打开核对后再标记付款');
    return `<div class="ord-note-line is-alert" title="${escapeAttr(title)}">`
      + `${ICON_PAY_CHECK}${cuT("Payment doesn't match", '付款不一致')}</div>`;
  }
  // Everything below needs a proof to exist. Without one this is an ordinary
  // unpaid order and the Pending pill already says so — the whole point of
  // has_alipay_proof is telling those two apart.
  if (!o.has_alipay_proof) return '';
  if (v === 'match') {
    // Read, verified, and STILL unpaid: auto-flip is off, so the money is only
    // ours once a person says so. Brass, not brick — nothing is wrong, it is
    // one click of work.
    const title = cuT(
      'The payment screenshot was read and matches — confirm it to mark this order paid',
      '已识别付款截图并核对一致 — 确认后即可标记为已付款');
    return `<div class="ord-note-line is-owed" title="${escapeAttr(title)}">`
      + `${ICON_PAY_OK}${cuT('Payment verified — confirm', '付款已核对 · 待确认')}</div>`;
  }
  // 'error' (the read threw) or null (it never ran — OCR not configured). Both
  // mean the same thing to whoever is standing here: a customer says they paid
  // and nobody has looked.
  const title = v === 'error'
    ? cuT('The payment screenshot could not be read — open it and check by hand',
          '付款截图无法识别 — 请打开人工核对')
    : cuT('A payment screenshot is on file and has not been checked — open it and verify',
          '已上传付款截图但尚未核对 — 请打开核对');
  return `<div class="ord-note-line is-owed" title="${escapeAttr(title)}">`
    + `${ICON_PAY_CHECK}${cuT('Payment not checked yet', '付款待核对')}</div>`;
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
    // Joined at render as `en · cn`. The i18n walker (retail-admin.html
    // processNode) splits a text node on the FIRST " · " and treats it as an
    // EN/CN pair ONLY when the left is Chinese-free AND the right has Chinese
    // (the hasChinese guard) — so keep the en half Latin-only and " · "-free.
    // No data-no-i18n: we WANT the toggle, like its siblings. (The approved cn
    // above carries a second " · " yet renders fine: first-middot split + the
    // left-is-Chinese-free guard leave its Chinese-only right side intact.)
    paying:    { en: 'Refund paying out',        cn: '退款打款中' },
  };
  const l = labels[rs] || { en: `Refund · ${rs}`, cn: '' };
  const amt = (o.refund_amount_requested != null && Number(o.refund_amount_requested) > 0)
    ? cuT(`${acMoney(o.refund_amount_requested)} of ${acMoney(o.total)}`, `${acMoney(o.refund_amount_requested)} / 共 ${acMoney(o.total)}`)
    : cuT(`full ${acMoney(o.total)}`, `全额 ${acMoney(o.total)}`);
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

// Alipay payment proof — Tacet card (reference/payment-proof-mockup.html, option A).
// The customer's raw screenshot is noise: the vision-AI already read amount /
// payee / time / txn from it. So lead with that read as a facts list, demote
// the screenshot to a tap-to-enlarge thumbnail, and carry the verdict in one
// calm pill — sage when it matched, brick on mismatch (never pure red), amber
// when the read couldn't complete. The "auto" footnote uses the breathing dusk
// dot: the AI's colour, the one place it's meant to appear.
const AP_ICON = {
  // Monochrome stroke icons (brand rule: line SVG, never emoji).
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  warn:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2l6 11H2z"/><path d="M8 6.4v3.1M8 11.5v.2"/></svg>',
  info:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5.3v.2M8 7.6v3"/></svg>',
  expand:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H2v4M10 14h4v-4"/></svg>',
};

function renderAlipayProof(o) {
  if (!o.alipay_proof_image) return '';
  let d = {}; try { d = o.alipay_ocr_json ? JSON.parse(o.alipay_ocr_json) : {}; } catch {}
  const v = o.alipay_ocr_verdict;
  const reasons = Array.isArray(d.reasons) ? d.reasons : [];
  const paidAt = d.paid_at || d.raw_time_text || o.alipay_proof_at || '';

  // What the AI read, one row each — only the fields it actually found.
  const facts = [];
  if (d.amount != null) facts.push(`<li><span class="k">${cuT('Amount', '金额')}</span><span class="v amt${v === 'mismatch' ? ' bad' : ''}">${acMoney(d.amount)}</span></li>`);
  // Two names can come off one 收钱码: the shop's display name on the success
  // screen and the registered 收款方全称 on the 账单详情 page. Show both when the
  // screenshot carried both, so staff can see at a glance it's the same code.
  const payeeShown = d.payee || d.payee_full || '';
  const payeeAlt = d.payee && d.payee_full && d.payee_full !== d.payee ? d.payee_full : '';
  if (payeeShown) facts.push(`<li><span class="k">${cuT('Paid to', '收款方')}</span><span class="v" data-no-i18n>${escapeHtml(payeeShown)}</span></li>`);
  if (payeeAlt) facts.push(`<li><span class="k">${cuT('Account name', '收款方全称')}</span><span class="v" data-no-i18n>${escapeHtml(payeeAlt)}</span></li>`);
  if (paidAt) facts.push(`<li><span class="k">${cuT('Paid at', '付款时间')}</span><span class="v" data-no-i18n>${escapeHtml(paidAt)}</span></li>`);
  if (d.txn_id) facts.push(`<li><span class="k">${cuT('Txn', '流水号')}</span><span class="v">${copyChip(d.txn_id, 'Txn ID')}</span></li>`);

  // One pill for the verdict.
  let pill, footer = '';
  if (v === 'match') {
    const paid = o.status !== 'pending_payment';
    pill = `<span class="ap-pill match">${AP_ICON.check}${cuT('Verified', '已核对')}${paid ? ' · ' + cuT('auto-marked paid', '已自动标记付款') : ''}</span>`;
    footer = `<div class="ap-note"><span class="ap-dot"></span>${cuT('Read & matched automatically', '已自动识别并核对')}</div>`;
  } else if (v === 'mismatch') {
    pill = `<span class="ap-pill mismatch">${AP_ICON.warn}${cuT("Doesn't match — check first", '不一致 · 请先核实')}</span>`;
    if (reasons.length) footer = `<div class="ap-reasons">${reasons.map(escapeHtml).join('；')}</div>`;
  } else if (v === 'error') {
    pill = `<span class="ap-pill unread">${AP_ICON.info}${cuT("Couldn't read it", '无法识别')}</span>`;
    footer = `<div style="margin-top:12px;"><button class="btn btn-sm" onclick="rerunAlipayOcr(${o.id}, this)">${cuT('Try reading again', '重新识别')}</button></div>`;
  } else {
    // Proof uploaded but the AI read never ran (OCR off / not configured).
    pill = `<span class="ap-pill unread">${AP_ICON.info}${cuT('Screenshot on file — verify by hand', '已上传截图 · 请人工核对')}</span>`;
  }

  const hint = o.status === 'pending_payment'
    ? `<div class="ap-hint">${cuT('Verify the amount matches, then Mark paid below.', '核对金额一致后,点击下方“标记已付款”。')}</div>`
    : '';

  return `<div class="full ap-proof">
    <div class="kicker">Alipay payment · 支付宝付款</div>
    <div class="ap-card">
      <div class="ap-head">
        <div>${pill}</div>
        <div class="ap-thumb" title="${cuT('View screenshot', '查看截图')}" onclick="zoomAlipayProof(this)">
          <img src="${o.alipay_proof_image}" alt="Alipay payment screenshot">
          <span class="ap-exp">${AP_ICON.expand}</span>
        </div>
      </div>
      ${facts.length ? `<ul class="ap-facts">${facts.join('')}</ul>` : ''}
      ${footer}
      ${hint}
    </div>
  </div>`;
}

// Grow the stored proof in place (the thumbnail is deliberately small). Rather
// than punting the operator to a new tab — which loses the order beside it — we
// float the full screenshot over the drawer so they can eyeball it against the
// facts list, then dismiss with the ✕, a backdrop tap, or Esc.
function zoomAlipayProof(el) {
  const im = el && el.querySelector('img'); if (!im) return;
  const old = document.getElementById('ap-lightbox'); if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'ap-lightbox';
  box.innerHTML = `<button type="button" class="ap-lb-x" title="${cuT('Close', '关闭')}" aria-label="${cuT('Close', '关闭')}">×</button>
    <img class="ap-lb-img" src="${im.src}" alt="Alipay payment screenshot">`;
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  // ✕ or backdrop closes; a tap on the image itself does not.
  box.addEventListener('click', e => { if (e.target === box || e.target.closest('.ap-lb-x')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
}

// Retry the Vision-AI read on the stored Alipay proof (after a transient read
// failure). Re-renders the drawer with the fresh verdict; a clean match on a
// still-pending order auto-marks it paid when auto-flip is on.
async function rerunAlipayOcr(orderId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = cuT('Reading …', '识别中 …'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/alipay-ocr/rerun`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) {
      const reason = (data.data && data.data) || data.error || 'unknown';
      toast(cuT(`Re-run failed (${reason})`, `重新识别失败 (${reason})`), 'error');
      if (btn) { btn.disabled = false; btn.textContent = cuT('Re-run OCR', '重新识别'); }
      return;
    }
    const v = data.data.verdict;
    toast(
      v === 'match' ? cuT('Verified ✓', '核对通过 ✓')
        : v === 'mismatch' ? cuT('Read it — does not match', '已识别 · 不一致')
        : cuT('Still could not read — try again or verify manually', '仍无法识别 · 请重试或人工核对'),
      v === 'match' ? 'success' : v === 'mismatch' ? 'error' : 'info'
    );
    openOrder(orderId); if (typeof loadOrders === 'function') loadOrders();
  } catch (e) {
    toast(cuT('Network error', '网络错误'), 'error');
    if (btn) { btn.disabled = false; btn.textContent = cuT('Re-run OCR', '重新识别'); }
  }
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
          <span class="bk-cost">${acMoney(b.cost)}</span>
        </div>
        <div class="bk-meta">${b.item_ids.length} items · ${acMoney(b.value)} · ${grams(b.grams)}</div>
      </div>`;
  };
  const detail = sug.suggested.plan.map(bucket).join('');
  return `
    <div class="split-suggestion" data-order="${o.id}" role="status">
      <div class="ss-head">
        <div class="ss-title">
          <span><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7l8.7 5 8.7-5"/><path d="M12 22V12"/></svg>Suggested: split into 2 packages · 拆分为 2 个包裹</span>
          <span class="save">save ${acMoney(sug.savings)} · 节省 ${acMoney(sug.savings)}</span>
        </div>
        <div class="ss-actions">
          <button class="btn btn-primary btn-sm" onclick="applySplitSuggestion(${o.id})">Apply · 拆分</button>
          <button class="btn btn-sm" onclick="dismissSplitSuggestion(${o.id})">Dismiss · 忽略</button>
        </div>
      </div>
      <div class="ss-subtitle">Current freight ${acMoney(sug.current.cost)} → split freight ${acMoney(sug.suggested.cost)} · 当前 ${acMoney(sug.current.cost)} → 拆后 ${acMoney(sug.suggested.cost)}</div>
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
    return `<div style="margin-top:8px;"><button class="btn btn-sm" onclick="combineParcels(${o.id}, event)">${cuT('Combine into one parcel', '合并为一个包裹')}</button></div>`;
  }
  if (combined) {
    return `<div style="margin-top:8px;"><button class="btn btn-sm" onclick="splitParcels(${o.id}, event)">${cuT('Split into separate parcels', '拆分为多个包裹')}</button></div>`;
  }
  return '';
}
async function combineParcels(orderId, ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm await nulls currentTarget
  if (!(await askConfirm({ title: cuT('Combine all parcels into one shipment? The customer will track a single parcel.', '将所有包裹合并为一个发货?顾客将只追踪一个包裹。'), confirmLabel: cuT('Combine', '合并') }))) return;
  try {
    await adminWrite({ btn, url: `/api/retail-admin/orders/${orderId}/shipments/combine`, method: 'POST', errLabelEn: 'Combine failed', errLabelCn: '合并失败' });
    toast(cuT('Combined into one parcel', '已合并为一个包裹'));
    openOrder(orderId); loadOrders();
  } catch {}
}
async function splitParcels(orderId, ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm await nulls currentTarget
  if (!(await askConfirm({ title: cuT('Split back into separate Air / Land parcels?', '拆分回独立的空运 / 陆运包裹?'), confirmLabel: cuT('Split', '拆分') }))) return;
  try {
    await adminWrite({ btn, url: `/api/retail-admin/orders/${orderId}/shipments/split`, method: 'POST', errLabelEn: 'Split failed', errLabelCn: '拆分失败' });
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
  // "The map returned coordinates" is not verification — a geocoder answers
  // every query and falls back to a district or city centre when it can't find
  // the street, which is how an order ends up pinned kilometres away. So the
  // badge reports what was actually matched: green only for a building/road
  // match in the right city, amber otherwise, with the matched place name
  // underneath so the operator can judge it instead of trusting a tick.
  const geoLevel = {
    rooftop: cuT('matched the building', '匹配到楼栋门牌'),
    street:  cuT('matched the street', '匹配到道路'),
    coarse:  cuT('only matched the district centre', '仅匹配到区域中心'),
  }[data.geocode_precision] || cuT('no map match', '地图无匹配');
  const geoBadge = !data.geocode_configured ? ''
    : data.geocode_ok
      ? `<span style="margin-left:8px; font-size:11px; font-weight:600; color:#5fc28e;">✓ ${geoLevel}</span>`
      : `<span style="margin-left:8px; font-size:11px; font-weight:600; color:var(--warn);">⚠ ${geoLevel}${
          data.geocode_reason === 'city_mismatch' ? ` — ${cuT('different city!', '城市不符!')}` : ''}</span>`;
  const geoMatched = data.geocode_matched
    ? `<div class="muted" style="font-size:11px; margin:-4px 0 10px;" data-no-i18n>${cuT('Map reads this as', '地图识别为')}: ${escapeHtml(data.geocode_matched)}</div>`
    : '';
  const field = (id, labelEn, labelCn, val) => `
    <div class="field" style="margin-bottom:10px;">
      <label class="stacked">${labelEn} · ${labelCn}</label>
      <input id="${id}" type="text" style="width:100%;" value="${escapeHtml(val || '')}">
    </div>`;

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg tacet';
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
        ${geoMatched}
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

// Edit the ship-to ON THE ORDER. The order keeps its own frozen copy of the
// address (snapshotted at checkout), so editing the customer's saved address
// book never reaches back to a placed order — this is the control that does.
// Reuses the language-agnostic /address/apply-chinese endpoint (it just
// normalizes + writes whatever fields it's given); no translation involved.
function openEditShipTo(orderId) {
  const o = _OPEN_ORDER;
  if (!o || o.id !== orderId) { toast(cuT('Re-open the order first', '请先重新打开订单'), 'error'); return; }
  // The order GET already parses address_json into o.address (and deletes the
  // raw string), so prefill from there. Fall back to splitting address_full for
  // any legacy row that has no structured address object.
  let cur = (o.address && typeof o.address === 'object') ? o.address : {};
  if (cur.pickup) { toast(cuT('Pickup order — no shipping address', '自提订单 — 无收货地址'), 'error'); return; }
  if (!cur.address && !cur.province && !cur.city && o.address_full) {
    const parts = String(o.address_full).trim().split(/\s+/);
    cur = { province: parts[0] || '', city: parts[1] || '', district: parts[2] || '', address: parts.slice(3).join(' ') };
  }

  const field = (id, labelEn, labelCn, val) => `
    <div class="field" style="margin-bottom:10px;">
      <label class="stacked">${labelEn} · ${labelCn}</label>
      <input id="${id}" type="text" style="width:100%;" value="${escapeHtml(val || '')}">
    </div>`;

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg tacet';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 520px; max-width: 94vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin:0; font-size:14px;">${cuT('Edit ship-to', '修改收货地址')}</h3>
          <div class="muted" style="font-size:11px; margin-top:2px;">${cuT('This changes the address on this order only.', '仅修改此订单的收货地址。')}</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Close', '关闭')}</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding:18px; display:block;">
        ${field('es-name', 'Recipient name', '收货人', o.recipient_name)}
        ${field('es-phone', 'Phone', '电话', o.recipient_phone)}
        <div style="height:1px; background:var(--line); margin:4px 0 12px;"></div>
        ${field('es-prov', 'Province', '省 / 市', cur.province)}
        ${field('es-city', 'City', '市', cur.city)}
        ${field('es-dist', 'District', '区 / 县', cur.district)}
        ${field('es-addr', 'Street / building', '街道 / 楼栋', cur.address)}
        ${field('es-detail', 'Unit / floor (optional)', '单元 / 楼层(可选)', cur.detail)}
        <label style="display:flex; align-items:center; gap:8px; font-size:12px; margin:6px 0; cursor:pointer;"><input type="checkbox" id="es-save-cust"> ${cuT('Also update the customer’s saved address', '同时更新顾客保存的地址')}</label>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
          <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Cancel', '取消')}</button>
          <button class="btn btn-primary" id="es-apply">${cuT('Save', '保存')}</button>
        </div>
      </div>
    </div>`;
  mountFloatingPuModal(bg);
  bg.querySelector('#es-apply').addEventListener('click', async (ev) => {
    const body = {
      recipient_name:  bg.querySelector('#es-name').value,
      recipient_phone: bg.querySelector('#es-phone').value,
      province: bg.querySelector('#es-prov').value,
      city:     bg.querySelector('#es-city').value,
      district: bg.querySelector('#es-dist').value,
      address:  bg.querySelector('#es-addr').value,
      detail:   bg.querySelector('#es-detail').value,
      save_order:    true,
      save_customer: bg.querySelector('#es-save-cust').checked,
    };
    if (!body.address.trim()) { toast(cuT('Street / building is required', '街道 / 楼栋不能为空'), 'error'); return; }
    if (!body.recipient_name.trim()) { toast(cuT('Recipient name is required', '收货人不能为空'), 'error'); return; }
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
// The orders "View" popover was retired with the Tacet port. Its per-operator
// row-style preferences (retail-admin-order-tweaks: statusStyle / rowTreat /
// typeMode) went with it — the reader is gone, so the table renders one style
// for everyone. The stored key is left alone rather than cleared, per §1.16.

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
  // Re-render the language-dependent bits (the delta badges' wording) on a
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
  dashCountUp($('#ord-kpi-rev'), revenue, n => acMoneyCompact(n));
  // No orders means no average — which is ¥0, not an unreadable dash. A money
  // tile carries a number.
  $('#ord-kpi-aov').textContent = acMoneyCompact(orders ? revenue / orders : 0);
  ordRepaintKpiLabels();   // deltas (language-aware)
}
// The Orders strip's own delta badge. Same states, same arithmetic and the same
// calm rule as the dashboard's fcSetDelta — with one difference: it writes the
// comparison onto the badge ("▲ 18 vs 7-day avg") instead of parking it in a
// hover tip, so a number nobody hovers is still a number you can act on.
// Deliberately local: fcSetDelta / dashSetDelta is the dashboard's, and the
// dashboard's badges must keep rendering exactly as they do.
//   cur    — today's figure. 0 means nothing has happened yet.
//   avg    — the trailing-day average of the same figure (null / 0 → no baseline)
//   days   — how many days that average covers
//   change — (cur, avg) → the signed amount to print, already rounded to the
//            precision it shows at: a count for orders, a percentage for money
//   unit   — '' after a count, '%' after a percentage
//   fmtAvg — formats `avg` for the hover tip
//   per    — what that average is per: a day for the daily figures, an order
//            for order value. One word, one measure.
function ordSetDelta(sel, cur, avg, days, change, unit, fmtAvg, per) {
  const el = $(sel); if (!el) return;
  el.classList.remove('is-up', 'is-down', 'is-flat');
  ttSet(el, '');
  if (!cur) {
    el.classList.add('is-flat'); el.textContent = '—';
    ttSet(el, cuT('none yet today', '今日暂无'));
    return;
  }
  if (!days || !(avg > 0)) {
    el.classList.add('is-up'); el.textContent = '▲ ' + cuT('new', '新');
    ttSet(el, cuT('no recent baseline', '暂无近期基准'));
    return;
  }
  // The badge names the comparison; the tip carries the figure behind it. Em
  // dash, not " · " — that sequence is the i18n splitter's divider and would cut
  // this tooltip in half (see ttSet in 01-core.js).
  const vs = ' ' + cuT(`vs ${days}-day avg`, `较近 ${days} 日均值`);
  ttSet(el, cuT(`${days}-day avg — ${fmtAvg(avg)}/${per}`, `近 ${days} 日均值 — ${fmtAvg(avg)}/${per}`));
  const d = change(cur, avg);
  if (d > 0)      { el.classList.add('is-up');   el.textContent = '▲ ' + d + unit + vs; }
  else if (d < 0) { el.classList.add('is-down'); el.textContent = '▼ ' + Math.abs(d) + unit + vs; }
  else            { el.classList.add('is-flat'); el.textContent = '±0' + unit + vs; }
}
// Language-dependent half — the delta badges (the comparison wording and the
// "new" word). Split out so a language toggle reflows wording without
// re-animating the headline numbers.
//
// Orders reads as a count and the other two as percentages, on purpose. At the
// small numbers a single store sees in a day, "18 more orders" is a fact an
// operator can act on where "up 43%" is 6 orders against 24. Money is the other
// way round — a percentage is how revenue is read.
function ordRepaintKpiLabels() {
  const data = _ORD_KPI_DATA; if (!data || !document.getElementById('ord-kpis')) return;
  const k = data.kpis || {}, b = data.baseline || null;
  const days    = b ? b.days : 0;
  const orders  = Number(k.orders || 0), revenue = Number(k.revenue || 0);
  const ordAvg  = b && b.orders  ? Number(b.orders.avg  || 0) : 0;
  const revAvg  = b && b.revenue ? Number(b.revenue.avg || 0) : 0;
  const count   = (cur, avg) => Math.round(cur - avg);
  // One decimal, matching what the server already computes for baseline.delta.
  const pct     = (cur, avg) => Math.round(((cur - avg) / avg) * 1000) / 10;
  const money   = v => acMoneyCompact(v);
  const perDay  = cuT('day', '日');
  ordSetDelta('#ord-kpi-orders-d', orders,  ordAvg, days, count, '',
    v => dashTrim(v) + ' ' + cuT(v === 1 ? 'order' : 'orders', '单'), perDay);
  // The server already expresses revenue's change as a percentage — use its
  // number rather than a second expression for the same thing (§1.17 rule 1).
  ordSetDelta('#ord-kpi-rev-d',    revenue, revAvg, days,
    () => (b && b.revenue && b.revenue.delta != null ? b.revenue.delta : pct(revenue, revAvg)), '%',
    money, perDay);
  // A typical day's order value. Not on the wire, but exact from what is: both
  // averages divide by the same `days`, so revenue.avg / orders.avg is the real
  // 7-day AOV, not an approximation of it.
  const aov    = orders  ? revenue / orders  : 0;
  const aovAvg = ordAvg  ? revAvg  / ordAvg  : 0;
  ordSetDelta('#ord-kpi-aov-d',    aov,     aovAvg, days, pct, '%',
    money, cuT('order', '单'));
}

/* ══════════════════════════════════════════════════════════════════════════
   BULK ACTIONS ON ORDERS (audit E-03 / F-01)

   Orders is the screen a merchant lives in, and until now every row was acted
   on one at a time: marking twenty orders dispatched was twenty trips into the
   drawer, sixty clicks where three would do. Products has had a proper
   selection bar for a long time; this is that bar, on the list that needed it
   most, reusing the same .pa-bulkbar-sel / .pa-bm classes so the two screens
   look and behave alike.

   🔴 WHAT IS DELIBERATELY NOT HERE: refund and cancel. Both move real money,
   both are irreversible, and neither has a shape where doing twenty at once is
   safer than doing them one at a time. A bulk refund is the single most
   expensive mis-click this admin could offer and it is not offered. Everything
   here is a FORWARD step on the fulfilment track — the same PATCH /status call
   the drawer's own buttons make, one order at a time, with the server's
   transition guard applying to each.

   Read-only channel rows (the Meituan / gzgrocery mirrors) cannot be selected
   at all: their state belongs to the platform that owns them, so a tick would
   promise something the row cannot do.
   ══════════════════════════════════════════════════════════════════════════ */

let ORD_SELECTED = new Set();
let ORD_VISIBLE_SELECTABLE = [];

// Which of the ticked orders this action could actually move, judged from the
// rows on screen. Purely to word the confirmation honestly — the server's
// STATUS_TRANSITIONS is the real authority and each order is still checked
// there. Mirrors routes/retail.js STATUS_TRANSITIONS; if that gains a step,
// this list is the other half to update.
const ORD_BULK_FROM = {
  preparing:  ['paid', 'awaiting_restock'],
  dispatched: ['preparing', 'paid'],
  delivered:  ['dispatched'],
};

function ordSelectableRows() {
  return (ORD_ROWS || []).filter(o => !ordIsReadonlyChannel(o));
}

function ordToggleSelect(id, ev) {
  if (ev) ev.stopPropagation();
  const n = Number(id);
  if (ORD_SELECTED.has(n)) ORD_SELECTED.delete(n); else ORD_SELECTED.add(n);
  ordRenderBulkBar();
  ordSyncSelectAll();
}

function ordSelectAllVisible(on) {
  ORD_VISIBLE_SELECTABLE.forEach(id => on ? ORD_SELECTED.add(id) : ORD_SELECTED.delete(id));
  document.querySelectorAll('#orders-table tbody input.ord-sel').forEach(cb => {
    cb.checked = ORD_SELECTED.has(Number(cb.dataset.id));
  });
  ordRenderBulkBar();
  ordSyncSelectAll();
}

function ordClearSelection() {
  ORD_SELECTED = new Set();
  document.querySelectorAll('#orders-table tbody input.ord-sel').forEach(cb => { cb.checked = false; });
  ordRenderBulkBar();
  ordSyncSelectAll();
}

// The header tick has three honest states, not two: all of this page, none of
// it, or some — which is what indeterminate is for. Without it, "some selected"
// renders as "none selected" and clicking once appears to do nothing.
function ordSyncSelectAll() {
  const all = document.getElementById('ord-sel-all');
  if (!all) return;
  const n = ORD_VISIBLE_SELECTABLE.filter(id => ORD_SELECTED.has(id)).length;
  all.checked = n > 0 && n === ORD_VISIBLE_SELECTABLE.length;
  all.indeterminate = n > 0 && n < ORD_VISIBLE_SELECTABLE.length;
  all.disabled = ORD_VISIBLE_SELECTABLE.length === 0;
}

function ordRenderBulkBar() {
  const bar = document.getElementById('ord-bulkbar');
  if (!bar) return;
  const n = ORD_SELECTED.size;
  if (!n) { bar.className = ''; bar.innerHTML = ''; return; }

  // How many of the ticked orders each step can actually move. A step that can
  // move none of them is greyed and says why on hover, rather than being
  // offered and then failing on every order.
  const picked = (ORD_ROWS || []).filter(o => ORD_SELECTED.has(o.id));
  const movable = to => picked.filter(o => (ORD_BULK_FROM[to] || []).includes(o.status)).length;

  const step = (to, en, cn) => {
    const k = movable(to);
    const dis = k ? '' : 'disabled';
    const title = k === n ? '' : (k
      ? ` title="${escapeHtml(cuT(k + ' of the ' + n + ' selected can move to this step', n + ' 单中有 ' + k + ' 单可进入此步骤'))}"`
      : ` title="${escapeHtml(cuT('None of the selected orders can move to this step', '所选订单均无法进入此步骤'))}"`);
    return `<button type="button" class="pa-bm-trig" ${dis}${title} onclick="ordBulkStatus('${to}')">`
      + escapeHtml(cuT(en, cn)) + (k && k !== n ? ` <span class="muted">${k}</span>` : '') + `</button>`;
  };

  const visN = ORD_VISIBLE_SELECTABLE.length;
  const allVis = visN > 0 && ORD_VISIBLE_SELECTABLE.every(id => ORD_SELECTED.has(id));
  bar.className = 'pa-bulkbar-sel';
  bar.innerHTML =
    `<span class="pa-bulk-count"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4L6 11 3 8"/></svg>`
      + escapeHtml(cuT(n + ' selected', '已选 ' + n + ' 单')) + `</span>`
    + `<button type="button" class="btn btn-sm" onclick="ordSelectAllVisible(${allVis ? 'false' : 'true'})">`
      + escapeHtml(allVis ? cuT('Clear page', '清空本页') : cuT('Select all ' + visN, '全选 ' + visN)) + `</button>`
    + `<button type="button" class="btn btn-sm" onclick="ordClearSelection()">${escapeHtml(cuT('Clear', '清除'))}</button>`
    + `<span class="pa-bulk-actions">`
      + step('preparing',  'Start preparing', '开始备货')
      + step('dispatched', 'Mark dispatched', '标记发货')
      + step('delivered',  'Mark delivered',  '标记送达')
    + `</span>`;
}

// Move every ticked order one step forward. One PATCH per order — the same
// call the drawer makes — so the server's transition guard applies to each and
// an order that cannot move is reported rather than silently skipped.
async function ordBulkStatus(to) {
  const picked = (ORD_ROWS || []).filter(o => ORD_SELECTED.has(o.id));
  const can = picked.filter(o => (ORD_BULK_FROM[to] || []).includes(o.status));
  if (!can.length) return;
  const label = { preparing: cuT('Start preparing', '开始备货'),
                  dispatched: cuT('Mark dispatched', '标记发货'),
                  delivered: cuT('Mark delivered', '标记送达') }[to] || to;

  // The confirmation names BOTH numbers when they differ. "Move 20 orders" when
  // only 14 can move is the kind of quiet arithmetic that makes an operator
  // stop trusting the screen.
  const skipped = picked.length - can.length;
  if (!(await askConfirm({
    titleEn: `${label} — ${can.length} order${can.length === 1 ? '' : 's'}?`,
    titleCn: `${label} — ${can.length} 单?`,
    bodyEn: skipped
      ? `${skipped} of the ${picked.length} you selected ${skipped === 1 ? 'is' : 'are'} not at a step this can move from, and will be left alone.`
      : '',
    bodyCn: skipped ? `所选 ${picked.length} 单中有 ${skipped} 单当前状态无法进入此步骤,将保持不变。` : '',
    confirmEn: label, confirmCn: label,
  }))) return;

  toast(cuT('Working…', '处理中…'));
  let done = 0; const failed = [];
  for (const o of can) {
    try {
      await api(`/api/retail-admin/orders/${o.id}/status`, { method: 'PATCH', body: { status: to } });
      done++;
    } catch (e) {
      failed.push(ordShortNo(o.order_no) + ' — ' + e.message);
    }
  }
  // A failure names the orders, not just a count: "3 failed" leaves the
  // operator to find which three by hand across a paged list.
  if (failed.length) {
    await askConfirm({
      titleEn: `${done} moved, ${failed.length} could not`,
      titleCn: `${done} 单已处理,${failed.length} 单失败`,
      bodyEn: failed.slice(0, 10).map(escapeHtml).join('<br>')
        + (failed.length > 10 ? `<br>…and ${failed.length - 10} more` : ''),
      bodyCn: failed.slice(0, 10).map(escapeHtml).join('<br>')
        + (failed.length > 10 ? `<br>…还有 ${failed.length - 10} 单` : ''),
      confirmEn: 'OK', confirmCn: '好',
      hideCancel: true,
    });
  } else {
    toast(cuT('Moved ' + done + ' ✓', '已处理 ' + done + ' 单 ✓'), 'ok');
  }
  ORD_SELECTED = new Set();
  loadOrders();
}

// ── The Orders filter, read from the controls in ONE place ─────────────────
// Three callers need the same answer: the list, the CSV export and the
// clear-filters control. Returns the filter half of the query string only —
// paging belongs to whoever is paging, and an export has no pages.
function ordFilterQuery() {
  const qs = new URLSearchParams();
  const status  = ($('#orders-status') || {}).value || '';
  const channel = (document.getElementById('orders-channel') || {}).value || '';
  const q       = (($('#orders-q') || {}).value || '').trim();
  const storeSel = document.getElementById('orders-store');
  const storeId  = storeSel ? storeSel.value : '';
  if (status)  qs.set('status', status);
  if (channel) qs.set('channel', channel);
  if (q)       qs.set('q', q);
  if (storeId) qs.set('store_id', storeId);
  if (ORD_CUSTOMER_FILTER) qs.set('customer_id', ORD_CUSTOMER_FILTER.id);
  return qs;
}

// Is anything narrowing the list right now? Drives the Clear button's presence:
// a control that is always there but does nothing four times out of five is
// noise, and one that appears when there is something to clear is a status
// line as well as a button.
function ordFiltersActive() {
  return [...ordFilterQuery().keys()].length > 0;
}

// Show or hide the Clear button to match. Called on every load, so it tracks
// the controls however they were changed — chip, menu, typing, or a customer
// drawer's "View all N orders".
function ordSyncClearBtn() {
  const b = document.getElementById('ord-clear-btn');
  if (b) b.hidden = !ordFiltersActive();
}

// Put every Orders control back to "everything", in one click. Before this the
// operator had to find and undo each one — the status chip, the channel menu,
// the store select, the search box, the customer chip — and the commonest way
// out was reloading the page.
function ordClearFilters() {
  // ordResetFacetsUI already puts the chips, the channel menu (tick, label,
  // icon and fill), the store select and the search box back to their defaults
  // without reloading — it was written for the "View all N orders" path and is
  // the one place that knows every control on this row.
  ordResetFacetsUI();
  ORD_CUSTOMER_FILTER = null;
  ordFilterChanged();          // page → 1 + one reload
}

// Download the orders the list is showing — every one of them, not just the
// page on screen. Deliberately filtered, unlike the catalogue export: an
// operator on the Refunds chip who presses Export wants the refunds, and a
// file that silently held the whole year would be worse than none.
function ordExportCsv() {
  const qs = ordFilterQuery().toString();
  window.location.href = '/api/retail-admin/orders/export.csv' + (qs ? '?' + qs : '');
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
    const channel  = (document.getElementById('orders-channel') || {}).value || '';
    const q        = $('#orders-q').value.trim();
    const storeSel = document.getElementById('orders-store');
    const storeId  = storeSel ? storeSel.value : '';

    // Refund queue chip is just a filter — keep the standard columns so
    // staff see the orders alongside their normal context (ship-by,
    // tracking, total). The backend treats `status=refunds_open` as the
    // pseudo-filter `refund_status IN ('pending','reviewing','approved')`.

    // Built by ordFilterQuery so this list, the CSV export and the
    // clear-filters control all read the same set of controls. The four consts
    // above stay for the log lines and the render below that still name them.
    const qs = ordFilterQuery();
    // Reflect the customer scope as a removable chip above the list.
    ordRenderCustChip();
    ordSyncClearBtn();
    // The page window. Sending these is what makes orders past the first 100
    // reachable at all — the server was already honouring limit/offset, the
    // list just never asked for a second page.
    qs.set('limit',  ORD_PAGE_SIZE);
    qs.set('offset', (ORD_PAGE - 1) * ORD_PAGE_SIZE);
    const tbody = $('#orders-table tbody');
    if (!silent) {
      tbody.innerHTML = '<tr><td colspan="11" class="muted">Loading…</td></tr>';
    }
    // Populate the store filter once stores are loaded.
    ensureOrdersStoreFilter();
    // Background-refresh the open-work count badges on the chip strip — staff
    // should always see what's queued without clicking through each chip.
    refreshOrderStatusCounts();
    refreshOrderChannelCounts();

    let j;
    try {
      j = await api('/api/retail-admin/orders?' + qs);
    } catch (e) {
      if (!silent && myReq === _ORDERS_REQ_ID) {
        tbody.innerHTML = `<tr><td colspan="11" class="err">Failed: ${escapeHtml(e.message)}</td></tr>`;
      }
      return;
    }

    // A newer load has started since this fetch began — its result is
    // authoritative; ours would render the previous filter's rows on
    // top. Drop on the floor.
    if (myReq !== _ORDERS_REQ_ID) return;

    ORD_TOTAL = Number(j.meta && j.meta.total) || 0;

    // The page can fall off the end of the list under the operator: cancel the
    // last order on page 26, or let a status filter's queue drain while it's
    // open, and offset now points past the final row. Snap to the last real
    // page and refetch once, rather than painting a blank table.
    const ordPages = Math.max(1, Math.ceil(ORD_TOTAL / ORD_PAGE_SIZE));
    if (ORD_PAGE > ordPages && !_ordClampRetry) {
      ORD_PAGE = ordPages;
      _ordClampRetry = true;
      _ORDERS_IN_FLIGHT = false;   // release before recursing, or the silent guard bails
      try { return await loadOrders(opts); }
      finally { _ordClampRetry = false; }
    }

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

    // Paint the pager before the fingerprint gate below. The fingerprint only
    // covers the rows on THIS page, so an order leaving the filter from some
    // other page would change the total while the rows stay identical — the
    // count would silently rot behind an early return.
    ordRenderPager();

    const fp = _ordersFp(j.data);
    if (silent && fp === _ORDERS_LAST_FP && tbody.querySelector('tr.order-row, .empty-state')) {
      // Nothing changed and the table is already painted — skip the rebuild.
      return;
    }
    const prevSeen = _ORDERS_SEEN_IDS;
    _ORDERS_LAST_FP = fp;

    if (!j.data.length) {
      const emptyMsg = (status === 'refunds_open')
        ? `<h3>Nothing waiting. Enjoy it. · 无待处理退款</h3>`
        : (status === 'needs_invoice')
        ? `<h3>No invoice requests · 无开票申请</h3>
           <p class="muted">Orders show up here when a customer asks for an invoice. · 顾客申请开票的订单会显示在这里。</p>`
        : `<h3>No orders yet · 暂无订单</h3>
           <p class="muted">New orders settle in here from every channel. · 新订单会从各渠道汇聚到这里。</p>`;
      tbody.innerHTML = `<tr><td colspan="11">
        <div class="empty-state">
          <div class="icon">${ICONS.empty}</div>
          ${emptyMsg}
        </div>
      </td></tr>`;
      _ORDERS_SEEN_IDS = new Set();
      _ORDERS_NOTIFIED_IDS = new Set();
      return;
    }

    const newIds = new Set(j.data.map(o => o.id));
    // An order is "actionable" only once it's paid — we don't process,
    // mark, or chime for unpaid orders (pending_payment) or dead ones
    // (cancelled); those just show their status pill and sit quiet. The mark
    // + chime kick in when there's actually something to fulfil.
    // Read-only channel rows (Meituan) never count as actionable: no NEW mark,
    // no unread bold, no arrival chime — they're a mirrored ledger, not work.
    const isActionable = o => o.status !== 'pending_payment' && o.status !== 'cancelled' && !ordIsReadonlyChannel(o);
    const actionableIds = new Set(j.data.filter(isActionable).map(o => o.id));
    const prevNotified = _ORDERS_NOTIFIED_IDS;
    // Arrival = an order that's actionable now and we haven't chimed for yet.
    // Catches both brand-new paid orders AND pending→paid flips (the id may
    // already be on screen, but it wasn't actionable before).
    const arrivals = prevNotified
      ? j.data.filter(o => isActionable(o) && !prevNotified.has(o.id))
      : [];

    ORD_ROWS = j.data;
    ORD_VISIBLE_SELECTABLE = ordSelectableRows().map(o => o.id);
    // A selection does not survive the rows it pointed at. Orders leave the
    // filter on their own (a status change, an auto-refresh, the next page), and
    // acting on an id that is no longer on screen is a bulk action on an unknown
    // set. Drop anything that is no longer selectable here.
    {
      const live = new Set(ORD_VISIBLE_SELECTABLE);
      ORD_SELECTED.forEach(id => { if (!live.has(id)) ORD_SELECTED.delete(id); });
    }

    tbody.innerHTML = j.data.map(o => {
      // No flash / no NEW mark for unpaid orders — nothing to act on yet.
      const fresh = (isActionable(o) && prevSeen && !prevSeen.has(o.id)) ? ' is-fresh' : '';
      // Unread until any operator opens the detail (server seen_at). Stays
      // bold + lit across reloads/devices, unlike the transient arrival flash.
      const isUnread = !o.seen_at && isActionable(o);
      // .is-unseen, not .is-unread — same name Customers uses, and it leaves
      // retail-admin.css's `tr.order-row.is-unread` wash/bold matching nothing.
      const unread = isUnread ? ' is-unseen' : '';
      // Read-only channels (Meituan / gzgrocery) show a channel tag + "view
      // only". They still open a view-only detail drawer (product / SKU / qty) —
      // renderOpenOrder branches to renderReadonlyOrder for these, with no
      // fulfilment actions. data-readonly is kept as the branch signal.
      const ro = ordIsReadonlyChannel(o);
      // Sales channel now has its own column (was a sub-line under the order #).
      // The "view only" tag lives inside the detail drawer, not the table row.
      const chanCell = `<div class="ord-chan">${chanIcon(o.channel)}${ordChannelLabel(o)}</div>`;
      return `
      <tr class="order-row${fresh}${unread}${ro ? ' order-row--ro' : ''}" data-order-id="${o.id}" tabindex="0"${ro ? ' data-readonly="1"' : ''}>
        <td class="oc-sel">${ro ? '' : `<input type="checkbox" class="ord-sel" data-id="${o.id}"${ORD_SELECTED.has(o.id) ? ' checked' : ''}
             onclick="ordToggleSelect(${o.id}, event)"
             aria-label="Select order ${escapeHtml(ordShortNo(o.order_no))}">`}</td>
        <td class="oc-ord"><span class="ord-no" title="${escapeHtml(o.order_no || '')}">${escapeHtml(ordShortNo(o.order_no))}</span></td>
        <td class="oc-chan">${chanCell}</td>
        <td>
          <div class="ord-cust">${escapeHtml(ordCustomerLines(o).name)}</div>
        </td>
        <td class="oc-store">
          ${o.store_code ? `<div>${escapeHtml(o.store_name_en || o.store_code)}</div>
            ${routingNote(o.routing_reason) ? `<div class="muted" style="font-size: 11px; margin-top: 2px">${routingNote(o.routing_reason)}</div>` : ''}
            ${fulfillmentShortBadge(o)}` : '<span class="muted">—</span>'}
        </td>
        <td class="oc-shipto">${renderShipToCell(o)}</td>
        <td>${o.item_count}</td>
        <td class="numeric oc-total">${acMoney(o.total)}</td>
        <td class="status-cell"><div class="stack">${(() => { const p = orderStatusPill(o); return `<span class="pill ${p.cls}"><span class="dot"></span>${p.label}</span>`; })()}${refundBadge(o)}${addonBadge(o)}</div>${paymentCheckLine(o)}${stockPendingBadge(o)}${invoiceLine(o)}</td>
        <td class="oc-delivery">${renderDeliveryCell(o)}</td>
        <td class="muted oc-placed" style="font-size: 11px">${formatDate(o.placed_at)}</td>
      </tr>`;
    }).join('');

    ordRenderBulkBar();
    ordSyncSelectAll();

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

// ── Refetch gate ───────────────────────────────────────────────────────
// Live updates are always on — there is no pause and no indicator. Skips
// only when the work would be wasted or destructive: the Orders tab isn't
// active, the document is hidden, or the user is mid-input/select. Safe to
// call while drawers/modals are open — fingerprint check means we only
// touch the DOM when something actually changed.
function _ordersAutoTick() {
  if (document.hidden) return;
  const tabActive = document.getElementById('tab-orders');
  if (!tabActive || !tabActive.classList.contains('active')) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.matches('input, select, textarea, [contenteditable="true"]')) return;
  loadOrders({ silent: true });
  ordLoadKpis();   // throttled (45s) — keeps the today pulse live on the tab
}

// Coalesce a burst of live nudges into one refetch. Several rows can land in
// the same instant (a daemon importing a batch), and the server's watermark
// tick can fire mid-batch — one fetch a moment later sees all of them.
let _ORDERS_LIVE_DEBOUNCE = null;
function _ordersLiveNudge() {
  clearTimeout(_ORDERS_LIVE_DEBOUNCE);
  // _ordersAutoTick already declines when hidden, off-tab, or the operator is
  // typing — nothing to guard here.
  _ORDERS_LIVE_DEBOUNCE = setTimeout(_ordersAutoTick, 400);
}

// Start the live subscription + backstop poller once. Wired listeners refresh
// immediately when the user comes back to the tab/window, since _ordersAutoTick
// declines to fetch while hidden and the list may have gone stale meanwhile.
(function _startOrdersPoller() {
  if (window._ordersPollerWired) return;
  window._ordersPollerWired = true;
  // Live push — the primary path. New orders appear on their own.
  if (typeof retailLiveSubscribe === 'function') retailLiveSubscribe(_ordersLiveNudge);
  if (_ORDERS_AUTO_TIMER) clearInterval(_ORDERS_AUTO_TIMER);
  _ORDERS_AUTO_TIMER = setInterval(_ordersAutoTick, ORDERS_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) _ordersAutoTick(); });
  window.addEventListener('focus', _ordersAutoTick);
  // When the user switches back to the Orders tab, refresh right away AND
  // clear the unseen-orders badge — they're about to see them.
  const ordersTabBtn = document.querySelector('.tabs [data-tab="orders"]');
  if (ordersTabBtn) ordersTabBtn.addEventListener('click', () => {
    setTimeout(_ordersAutoTick, 50);
    ordLoadKpis(true);   // fresh today pulse on tab open
    _markOrdersSeenNow();
    _markInvoicesSeenNow();   // fapiao requests live on this tab now too
  });
})();

// ── Unseen-orders badge (red pulsing dot on the Orders tab) ─────────────
// Polls a lightweight count endpoint independent of the heavy orders list
// (which only refreshes when the tab is active). Tracks the "last seen at"
// timestamp in localStorage so the badge survives reloads but clears as
// soon as the user actually visits the Orders tab.
const ORDERS_UNSEEN_POLL_MS = 15000;
const ORDERS_LAST_SEEN_KEY  = 'tacet-orders-last-seen-at';
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
  _ordersUnseenN = 0;
  _paintCombinedOrdersBadge();
}
// The Orders nav badge covers TWO unseen streams since the Invoices sub-tab
// was retired: new orders and new fapiao requests. Each poller stores its own
// count; the dot shows their sum so neither can hide the other.
let _ordersUnseenN = 0;
let _invoicesUnseenN = 0;
function _paintCombinedOrdersBadge() {
  _paintOrdersBadge(_ordersUnseenN + _invoicesUnseenN);
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
const ORDERS_SOUND_KEY = 'tacet-orders-sound-on';
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
  _synthOrderChime();
}
// Unguarded synth — used by _playOrderChime above, and by the Notifications
// "play test sound" button (Profile pop-up / backend-account.html), which
// should preview the ding even while the toggle is off.
function _synthOrderChime() {
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
    _ordersUnseenN = count;
    _paintCombinedOrdersBadge();
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

// ── Unseen-invoice requests (fold into the Orders nav badge) ────────────
// Mirrors the new-order notification: a pending fapiao request should land
// like a new order. Shares the chime + sound toggle with orders, and since
// the Invoices sub-tab was retired the count rides the SAME red dot on the
// Orders row — the Orders tab is where the request is now seen and handled.
const INVOICES_LAST_SEEN_KEY = 'tacet-invoices-last-seen-at';
let _INVOICES_UNSEEN_TIMER = null;

function _invoicesLastSeen() {
  try { return localStorage.getItem(INVOICES_LAST_SEEN_KEY) || ''; }
  catch { return ''; }
}
function _markInvoicesSeenNow() {
  try { localStorage.setItem(INVOICES_LAST_SEEN_KEY, new Date().toISOString()); }
  catch {}
  _invoicesUnseenN = 0;
  _paintCombinedOrdersBadge();
}

let _invoicesUnseenPrev = null;
async function _pollUnseenInvoices() {
  if (document.hidden) return;
  // On the Orders tab the request is in front of the operator (chip count +
  // row badge), so everything counts as seen — same rule as new orders.
  const ordersTabActive = document.getElementById('tab-orders')?.classList.contains('active');
  if (ordersTabActive) { _markInvoicesSeenNow(); _invoicesUnseenPrev = 0; return; }
  try {
    const since = _invoicesLastSeen();
    const j = await api('/api/retail-admin/invoices/unseen-count?since=' + encodeURIComponent(since));
    if (!j?.success) return;
    const count = j.data?.count || 0;
    _invoicesUnseenN = count;
    _paintCombinedOrdersBadge();
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
  { tab: 'reviews',  key: 'tacet-reviews-last-seen-at',  endpoint: '/api/retail-admin/reviews/unseen-count',  feat: 'feat-reviews',  prev: null, _count: 0 },
  { tab: 'feedback', key: 'tacet-feedback-last-seen-at', endpoint: '/api/retail-admin/feedback/unseen-count', feat: 'feat-feedback', prev: null, _count: 0 },
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
    const btn   = document.querySelector('[data-tab="' + cat.tab + '"]');
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
  // Roll the combined count up to the topbar Inbox button so it shows on the
  // icon while the dropdown is closed. (Inbox moved from the rail to the topbar.)
  const trigger = document.getElementById('tbInboxBtn');
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
// icon set (the 🏬 emoji clashed with the admin chrome).
function pickupIcon(size = 12) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px;margin-right:1px"><path d="M4 10.5V20h16v-9.5"/><path d="M3.5 6.5 5 3.5h14l1.5 3a3 3 0 0 1-5.7 1.3A3 3 0 0 1 12 7.5a3 3 0 0 1-2.8.3A3 3 0 0 1 3.5 6.5z"/><path d="M9.5 20v-5h5v5"/></svg>`;
}
// A date string reaches the client in three shapes: a bare SQLite UTC stamp
// ("YYYY-MM-DD HH:MM:SS", which needs a 'Z' to parse as UTC); a full ISO string
// that already carries 'T'+'Z' (slot resolution stores dt.toISOString(), and
// localizeOrderTimes deliberately leaves it untouched); or a DATE-ONLY string
// ("YYYY-MM-DD", how promised_ship_date / promised_delivery_date are stored via
// toYmdLocal). Appending 'Z' unconditionally broke two of these: the ISO form
// became "…ZZ" and the date-only form became "YYYY-MM-DDZ" — both Invalid Date,
// which silently blanked the ship-by value (the cell collapsed to "NaN月NaN日"
// for fresh-batch orders, and elsewhere dropped the urgency badge). Only append
// 'Z' for the bare date+time stamp (the one shape that actually has a space).
function parseSchedFor(s) {
  const v = String(s == null ? '' : s);
  if (/[TZ]/.test(v)) return new Date(v);              // already ISO / tz-aware
  if (v.includes(' ')) return new Date(v.replace(' ', 'T') + 'Z'); // "YYYY-MM-DD HH:MM:SS" UTC
  return new Date(v);                                  // bare "YYYY-MM-DD" → UTC midnight
}
// A scheduled time WINDOW (e.g. "16:00–18:00") persists scheduled_for at the
// window START, but the order isn't late until the window CLOSES — anchoring
// urgency on the start makes a 16:00–18:00 order read "OVERDUE" at 16:30. The
// window's END only lives in the free-text label, so parse it out and rebuild
// the anchor on the scheduled date. Falls back to scheduled_for when the label
// carries no end time (a bare date, a single-time slot, or an AM/PM label).
// The store runs on Guangzhou wall-clock (UTC+8). Slot times are stored as
// absolute instants — a day-only pick is GZ-midnight, which is 16:00 the PREVIOUS
// day in UTC. Reading those back with the browser's own getDate()/getHours()
// makes an operator logged in from another timezone see the day before (and a
// false OVERDUE). These two helpers pin everything to GZ wall-clock regardless of
// where staff sit: gzParts() → the y/mo/da/h/mi/s an operator in Guangzhou sees;
// gzWall() → the absolute instant for a given GZ wall-clock time.
function gzParts(d) {
  const g = new Date(d.getTime() + 8 * 3600000);
  return { y: g.getUTCFullYear(), mo: g.getUTCMonth(), da: g.getUTCDate(),
           h: g.getUTCHours(), mi: g.getUTCMinutes(), s: g.getUTCSeconds() };
}
function gzWall(y, mo, da, h, mi) {
  return new Date(Date.UTC(y, mo, da, h - 8, mi));
}
// The window's END lives ONLY in the customer's free-text label — scheduled_for
// holds the start. Parsed in one place so urgency (slotEndAnchor) and what the
// operator reads (slotWindowText) can never disagree about when a slot closes.
// Returns a Date in GZ wall-clock, or null when the label carries no window.
function parseSlotEnd(start, label) {
  if (isNaN(start.getTime())) return null;
  const g = gzParts(start);
  const lbl = String(label == null ? '' : label);
  const m = /(\d{1,2}):(\d{2})\s*(?:[-–—~]|to|至)\s*(\d{1,2}):(\d{2})/.exec(lbl);
  if (m) {
    const endH = Number(m[3]), endM = Number(m[4]);
    if (endH <= 23 && endM <= 59) {
      const end = gzWall(g.y, g.mo, g.da, endH, endM);
      if (end.getTime() >= start.getTime()) return end; // window END is the real deadline
    }
  }
  // AM/PM window without colons, e.g. "10AM–12PM" or "10:30 AM - 12 PM". The
  // HH:MM regex above misses these, so the order would wrongly anchor on its
  // start time and read OVERDUE minutes into the window.
  const ap = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:[-–—~]|to|至)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(lbl);
  if (ap) {
    let endH = Number(ap[4]); const endM = Number(ap[5] || 0); const mer = ap[6].toLowerCase();
    if (mer === 'pm' && endH < 12) endH += 12;
    else if (mer === 'am' && endH === 12) endH = 0;
    if (endH <= 23 && endM <= 59) {
      const end = gzWall(g.y, g.mo, g.da, endH, endM);
      if (end.getTime() >= start.getTime()) return end; // window END is the real deadline
    }
  }
  return null;
}
// §1.18 — the operator's Delivery column, rendered from the ORDER's own data
// instead of the customer's stored words.
//
// delivery_slot_label is free text frozen in whatever language the customer
// checked out in: the server writes label_en "Today 4PM–6PM" OR label_cn
// "今天 16:00–18:00", never both, and only the one is saved. Rendering it raw put
// a Chinese 24-hour window on an English screen (`Aug 3 16:00–18:00` — the date
// localised, the clock not), which is §1.18's glued-languages defect.
//
// scheduled_for already holds the window START as an absolute instant, and the
// label's only unique fact is its END — so both languages can be built from the
// order itself, each following its own convention. Returns null when there is
// nothing to derive, and the caller falls back to the stored label as before.
function slotWindowText(scheduledForIso, label) {
  if (typeof tdWhen !== 'function') return null;
  const start = parseSchedFor(scheduledForIso);
  if (isNaN(start.getTime())) return null;
  const g = gzParts(start);
  if (g.h === 0 && g.mi === 0 && g.s === 0) {
    // GZ midnight is the server's "a day, no hour" sentinel. If the label has no
    // clock either, the DATE is the whole fact — render it so an English
    // operator never reads a stored "8月4日". If the label DOES carry a time (a
    // pickup slot keeps its hour there and nowhere else), leave it alone:
    // deriving would silently drop the one fact scheduled_for doesn't hold.
    const hasClock = /\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*(?:am|pm)/i.test(String(label == null ? '' : label));
    return hasClock ? null : tdWhen(start, 'date');
  }
  // 'dateTime' carries the date+time separator each language actually uses
  // ("Aug 3, 4:00 PM" vs "8月3日 16:00"), so no format is assembled out here.
  const end = parseSlotEnd(start, label);
  return tdWhen(start, 'dateTime') + (end ? '–' + tdWhen(end, 'time') : '');
}
function slotEndAnchor(scheduledForIso, label) {
  const start = parseSchedFor(scheduledForIso);
  if (isNaN(start.getTime())) return scheduledForIso;
  const g = gzParts(start);
  const end = parseSlotEnd(start, label);
  if (end) return end.toISOString();
  // No usable time window. A DAY-ONLY pick — the same-day "Today" chip or a
  // schedule-for-later calendar date — is stored at GZ MIDNIGHT (the server's
  // sentinel for "a day, no hour"; see resolveDeliverySlot). Anchoring urgency on
  // that midnight makes the order read OVERDUE from 00:00 on its OWN delivery day.
  // Collapse it to a bare GZ date so urgency compares whole calendar days
  // (today/tomorrow/overdue) instead of treating 00:00 as a missed deadline. A
  // genuinely timed slot/pickup (e.g. 14:30) isn't midnight, so it stays
  // hour-precise and still goes red as its time approaches.
  if (g.h === 0 && g.mi === 0 && g.s === 0) {
    const mo = String(g.mo + 1).padStart(2, '0');
    const d = String(g.da).padStart(2, '0');
    return `${g.y}-${mo}-${d}`;
  }
  return scheduledForIso;
}
// ── Ship-by: ONE decision shared by the orders-list cell, the drawer tile,
// AND the printed receipt / packing slip (the print side mirrors this in
// lib/feie.js shipByPrintParts() — keep the two in sync). Rule: the MOST
// CONCRETE fact wins, and whenever a real date exists we show that DATE,
// never a vague "ASAP".
//   1 pickup     → counter window
//   2 batch      → arrival date is the headline; made-fresh ship date below
//   3 scheduled  → customer-chosen delivery slot / date
//   4 deadline   → out-of-city express: paid + expressDispatchHours, no date
//   5 ship now   → nothing chosen
// "Ship by" is a future deadline — once an order ships/closes it reads wrong,
// so closed orders relabel the kicker as "Requested timing".
function shipByPlan(o) {
  const done = (o.status === 'dispatched' || o.status === 'delivered'
    || o.status === 'cancelled' || o.status === 'refunded');
  const reqEn = 'Requested timing', reqCn = '原定时间';
  // 0 — Counter: no plan at all. Paid and handed over in one moment, so there is
  // no deadline, no window and no "requested timing" to show.
  if (ordIsCounter(o)) return null;
  // 1 — Pickup: show the counter window, never a ship deadline.
  if (o.fulfillment_type === 'pickup') {
    const label = slotWindowText(o.scheduled_for, o.delivery_slot_label)
      || localizeSlotLabel(humanizeSlotLabel(absolutizeSlotLabel(o.delivery_slot_label, o.scheduled_for)))
      || (o.scheduled_for ? localizeSlotLabel(humanizeSlotLabel(o.scheduled_for)) : null);
    return {
      kind: 'pickup', icon: 'pickup',
      kickerEn: 'Pickup time', kickerCn: '取货时间',
      headlineRaw: label, headlineEn: 'During pickup hours', headlineCn: '营业时间内自取',
      subEn: 'Have ready at counter', subCn: '备好待取',
      cellSubEn: 'pickup', cellSubCn: '自提',
      urgencyDate: o.scheduled_for ? slotEndAnchor(o.scheduled_for, o.delivery_slot_label) : null, urgencyBasis: 'arrival',
    };
  }
  // 2 — Fresh batch: the kitchen makes a new batch on promised_ship_date and it
  // arrives ~promised_delivery_date. The SHIP (make-fresh) date is the headline
  // — that's the date the operator acts on, and surfacing it stops a packer
  // shipping early off the shelf; the arrival estimate sits below.
  if (o.promised_ship_date) {
    const ship = fmtDateShort(parseSchedFor(o.promised_ship_date));
    const arr = o.promised_delivery_date ? fmtDateShort(parseSchedFor(o.promised_delivery_date)) : '';
    if (arr) {
      // Lead with the DELIVERY date (what the customer expects), like a
      // scheduled order, and carry the make-fresh SHIP date in the sub-line so a
      // packer still knows the make/ship day and won't ship early off the shelf.
      // Urgency stays pinned to the ship date (the date the operator acts on),
      // but we suppress the stale "today/tomorrow" word downstream because it now
      // sits beside the ARRIVAL date and would misread (Jun 21 isn't "tomorrow";
      // the Jun 20 ship is). A genuinely missed ship date still flags overdue.
      return {
        kind: 'batch', kickerShow: true,
        kickerEn: done ? reqEn : 'Deliver by', kickerCn: done ? reqCn : '送达时间',
        headlineRaw: arr,
        subEn: `🥗 made fresh · ship ${ship}`,
        subCn: `🥗 现做 · ${ship}发货`,
        cellSubEn: `made fresh · ship ${ship}`,
        cellSubCn: `现做 · ${ship}发货`,
        urgencyDate: o.promised_ship_date, urgencyBasis: 'arrival',
      };
    }
    // No arrival estimate — fall back to the make-fresh SHIP date as the headline.
    return {
      kind: 'batch',
      kickerEn: done ? reqEn : 'Ship by', kickerCn: done ? reqCn : '最迟发货',
      headlineRaw: ship,
      subEn: '🥗 made fresh', subCn: '🥗 现做',
      cellSubEn: 'made fresh', cellSubCn: '现做',
      urgencyDate: o.promised_ship_date, urgencyBasis: 'arrival',
    };
  }
  // 4 + 5 — No customer-chosen date. We deliberately DON'T invent a synthetic
  // "ship by paid + Nh" deadline any more: the customer never asked for it and it
  // cried false "OVERDUE" on perfectly fresh orders. Instead show "As soon as
  // possible" and let the order's AGE drive urgency — an order sitting unshipped
  // for days is the real signal an operator should act on. Covers both the old
  // out-of-city express tag (ship_by_mode==='asap') and plain "nothing picked".
  if (o.ship_by_mode === 'asap' || !o.scheduled_for) {
    // "Right away" (立即配送) is a REAL customer pick — the ASAP/as-soon-as-possible
    // default in the When step — not an absent date. It shares ship_by_mode==='asap'
    // with the out-of-city express case, but reusing the "Earliest courier day"
    // wording read wrong on an in-city Right-away order. Say what the customer
    // actually chose so the floor isn't misled.
    if (o.delivery_slot_kind === 'right_away') {
      // Kicker is "Right away", not "Ship by" — Right-away is what the CUSTOMER
      // asked for (as-soon-as-possible), not an operator dispatch deadline.
      // "Ship by → Right away" read as a contradiction. The CN is the live
      // checkout string (立即配送), not a composed one — vocabulary v1.1.
      return {
        kind: 'asap',
        kickerEn: done ? reqEn : 'Right away', kickerCn: done ? reqCn : '立即配送',
        headlineEn: 'Right away', headlineCn: '立即配送',
        urgencyDate: o.placed_at || null, urgencyBasis: 'age',
      };
    }
    // "As soon as possible" read on the floor as "rush a rider out today" — but
    // this customer picked no delivery date and did NOT pay the same-day
    // surcharge; they just want the earliest normal courier day. Say that
    // plainly ("Earliest courier day / 最早快递发出") so nobody dispatches a
    // same-city rider on a standard parcel. The clarifier sub-line in the tile
    // spells out "no same-day paid" for the same reason.
    return {
      kind: 'asap',
      kickerEn: done ? reqEn : 'Ship by', kickerCn: done ? reqCn : '最迟发货',
      headlineEn: 'Courier — ship when ready', headlineCn: '快递 · 备好即发',
      urgencyDate: o.placed_at || null, urgencyBasis: 'age',
    };
  }
  // 3 — Customer-scheduled delivery date / slot. Some orders saved an ISO
  // timestamp into delivery_slot_label; humanizeSlotLabel rewrites those so the
  // operator never sees raw ISO.
  const dt = parseSchedFor(o.scheduled_for);
  const valid = !isNaN(dt.getTime());
  // Our own render of the customer's window first (§1.18); the stored label is
  // the fallback for orders it can't be derived from.
  const win = slotWindowText(o.scheduled_for, o.delivery_slot_label);
  const label = win
    || localizeSlotLabel(humanizeSlotLabel(absolutizeSlotLabel(o.delivery_slot_label, o.scheduled_for)))
    || (valid ? fmtSlotShort(dt) : String(o.scheduled_for));
  // If the human label isn't itself the date, surface the date as a sub-line.
  // A derived window already leads with the date, so it never needs one.
  const dateLine = valid ? fmtSlotShort(dt) : '';
  return {
    kind: 'scheduled',
    kickerEn: done ? reqEn : 'Booked', kickerCn: done ? reqCn : '顾客预约',
    headlineRaw: label,
    cellSubRaw: (!win && label !== dateLine && dateLine) ? dateLine : null,
    urgencyDate: slotEndAnchor(o.scheduled_for, o.delivery_slot_label), urgencyBasis: 'arrival',
  };
}

// Time-relative colour + urgency level for a plan, computed at render time
// from the operator's clock. level ∈ overdue|urgent|soon|today|tomorrow|later.
// dateOnly=true when urgencyDate is a bare calendar date (a fresh-batch ship
// date) — then "today/tomorrow" is a CALENDAR-day comparison in local time, not
// an hours-from-now bucket (a Jun 16 date is "tomorrow" all day on Jun 15, never
// "today (15h)").
function shipByUrgency(p, actionable) {
  const r = { color: actionable ? 'var(--warn)' : 'var(--text-1)', level: 'none', hrs: null, days: null, dateOnly: false };
  // `p` itself may be null — shipByPlan returns null for a counter sale, which
  // has no plan to be urgent about. Its two callers guard before they get here,
  // so this is the second line rather than the first; it is present because
  // this helper takes the plan directly and a future caller will not know that
  // null is a legal value unless the function says so.
  if (!p || !p.urgencyDate || !p.urgencyBasis) {
    r.color = actionable ? 'var(--warn)' : 'var(--text-3)';
    return r;
  }
  const danger = 'var(--danger)', warn = 'var(--warn)', plain = 'var(--text-1)';
  // Age basis (ASAP orders, no promised date): urgency = how long the order has
  // waited unshipped. amber once it's been a couple of days, red once it's stale.
  // Thresholds are in whole days — tune the two constants here (no Settings field
  // yet; ask if you want them operator-configurable).
  if (p.urgencyBasis === 'age') {
    const ASAP_AMBER_DAYS = 2, ASAP_RED_DAYS = 4;
    const d = parseSchedFor(p.urgencyDate);
    if (isNaN(d.getTime())) { r.color = actionable ? warn : plain; return r; }
    const ageDays = Math.floor((Date.now() - d.getTime()) / 86400000);
    r.days = ageDays;
    if (ageDays >= ASAP_RED_DAYS)        { r.level = 'overdue'; if (actionable) r.color = danger; }
    else if (ageDays >= ASAP_AMBER_DAYS) { r.level = 'soon';    if (actionable) r.color = warn; }
    else                                 { r.level = 'fresh';   r.color = plain; }
    if (!actionable) r.color = plain;
    return r;
  }
  // Date-only value → compare whole local calendar days, not raw hours.
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p.urgencyDate));
  if (dm) {
    r.dateOnly = true;
    const target = new Date(+dm[1], +dm[2] - 1, +dm[3]);          // GZ calendar date
    // "Today" is the STORE's today (Guangzhou, UTC+8), not the browser's — else an
    // operator abroad, still on the previous GZ day, misreads the bucket.
    const ng = gzParts(new Date());
    const today = new Date(ng.y, ng.mo, ng.da);
    const days = Math.round((target.getTime() - today.getTime()) / 86400000);
    r.days = days;
    if (days < 0)       { r.level = 'overdue';  if (actionable) r.color = danger; }
    else if (days === 0){ r.level = 'today';    if (actionable) r.color = warn; }
    else if (days === 1){ r.level = 'tomorrow'; if (actionable) r.color = warn; }
    else                { r.level = 'later';    r.color = plain; }
    if (!actionable) r.color = plain;
    return r;
  }
  const d = parseSchedFor(p.urgencyDate);
  if (isNaN(d.getTime())) { r.color = actionable ? 'var(--warn)' : 'var(--text-1)'; return r; }
  const hrs = (d.getTime() - Date.now()) / 3600000;
  r.hrs = hrs;
  if (p.urgencyBasis === 'deadline') {
    if (hrs < 0)        { r.level = 'overdue'; if (actionable) r.color = danger; }
    else if (hrs < 12)  { r.level = 'urgent';  if (actionable) r.color = danger; }
    else if (hrs < 24)  { r.level = 'soon';    if (actionable) r.color = warn; }
    else                { r.level = 'later';   r.color = plain; }
  } else { // arrival
    if (hrs < 0)        { r.level = 'overdue';  if (actionable) r.color = danger; }
    else if (hrs < 6)   { r.level = 'today';    if (actionable) r.color = danger; }
    else if (hrs < 24)  { r.level = 'today';    if (actionable) r.color = warn; }
    else if (hrs < 48)  { r.level = 'tomorrow'; if (actionable) r.color = warn; }
    else                { r.level = 'later';    r.color = plain; }
  }
  if (!actionable) r.color = plain;
  return r;
}

function renderShipByCell(o) {
  // Read-only channels (Meituan, gzgrocery) are mirrored ledgers — we don't
  // fulfil them, so there's no ship-by deadline we own. "As soon as possible"
  // reads as a to-do we'll never action; blank it out.
  if (ordIsReadonlyChannel(o)) return '<span class="muted">—</span>';
  const actionable = (o.status === 'paid' || o.status === 'preparing');
  const p = shipByPlan(o);
  // No plan — a counter sale, which was paid and handed over in one moment and
  // owes nothing. Same em-dash the caller above already renders for it
  // (renderDeliveryCell), so the two agree if that upstream guard ever moves.
  if (!p) return '<span class="muted">—</span>';
  const u = shipByUrgency(p, actionable);
  const headline = (p.headlineRaw != null && p.headlineRaw !== '')
    ? escapeHtml(p.headlineRaw)
    : cuT(p.headlineEn, p.headlineCn);
  // Short urgency tag on the sub-line — only meaningful while the operator can
  // still act (paid/preparing). Once shipped/closed the deadline is in the past
  // by definition, so suppress it instead of crying "OVERDUE" on a sent parcel.
  let tag = '';
  if (actionable) {
    if (u.level === 'overdue')       tag = ` · <b>${cuT('OVERDUE', '已逾期')}</b>`;
    // Batch rows lead with the ARRIVAL date but colour by the SHIP date, so a
    // "today/tomorrow" word here would misread against the headline — suppress it
    // (the concrete ship date is already in the sub-line). Keep it for others.
    else if (p.kind === 'batch') {}
    else if (u.level === 'today')    tag = ` · ${cuT('today', '今天')}`;
    else if (u.level === 'tomorrow') tag = ` · ${cuT('tomorrow', '明天')}`;
  }
  const subText = (p.cellSubRaw != null && p.cellSubRaw !== '') ? escapeHtml(p.cellSubRaw)
    : (p.cellSubEn != null) ? cuT(p.cellSubEn, p.cellSubCn)
    : (p.subEn != null) ? cuT(p.subEn, p.subCn) : '';
  const icon = p.icon === 'pickup' ? `${pickupIcon(12)} ` : '';
  const surcharge = (Number(o.same_day_surcharge_fee) || 0) > 0
    ? ` <span style="font-size: 10px; color: var(--warn);">+${acMoney(o.same_day_surcharge_fee)} ${cuT('same-day','当日')}</span>` : '';
  // The column header reads "Ship by", which is correct for true ship deadlines
  // (out-of-city express, fresh-batch make-by, ship-now). But scheduled-delivery
  // and pickup orders carry a DIFFERENT meaning — the date is when the customer
  // wants it delivered / to collect it, not a shipping deadline. Without a label
  // those dates masquerade as ship deadlines under the "SHIP BY" header. Show the
  // per-row kicker ("Deliver" / "Pickup time") only for those, so the genuine
  // ship-by rows stay clean (the header already names them).
  const showKicker = !!p.kickerShow || p.kind === 'scheduled' || p.kind === 'pickup';
  const kicker = showKicker
    ? `<div style="font-size: 9px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); margin-bottom: 1px;">${cuT(p.kickerEn, p.kickerCn)}</div>`
    : '';
  // ASAP orders carry no date — surface HOW LONG the order has waited as the
  // urgency cue, coloured by age (grey when fresh, amber/red as it ages). This
  // replaces the generic sub-line for date-less orders.
  let ageLine = '';
  if (p.kind === 'asap' && u.days != null) {
    // Never print the relative word "today" — by the time staff read a closed
    // order it's stale. Swap in the concrete placed date (operator-language).
    const pd = parseSchedFor(p.urgencyDate || o.placed_at);
    const placedDate = isNaN(pd.getTime()) ? '' : fmtDateShort(pd);
    const en = u.days <= 0 ? (placedDate ? `placed ${placedDate}` : 'placed today') : `placed ${u.days}d ago`;
    const cn = u.days <= 0 ? (placedDate ? `下单于${placedDate}` : '今天下单') : `${u.days}天前下单`;
    const bold = (u.level === 'overdue' || u.level === 'soon') ? 600 : 400;
    ageLine = `<div style="font-size: 10px; margin-top: 2px; font-weight: ${bold}; color: ${actionable ? u.color : 'var(--text-3)'};">${cuT(en, cn)}</div>`;
  }
  return `${kicker}<div style="font-size: 12px; font-weight: 600; color: ${u.color}; line-height: 1.3;">${icon}${headline}</div>
          ${ageLine || ((subText || tag) ? `<div style="font-size: 10px; margin-top: 2px; color: var(--text-3);">${subText}${tag}</div>` : '')}
          ${surcharge}`;
}
// A delivery slot — "Jul 29, 2:26 PM" / "7月29日 14:26" (§1.18).
function fmtSlotShort(dt) {
  // Midnight (00:00) is never a real delivery time — it's how a DATE-ONLY pick
  // (schedule-for-later day / day-only zone) lands when parsed. Drop the fake
  // time tail so it reads "Jul 18", not "Jul 18, 12:00 AM". Read in Guangzhou
  // wall-clock, not the browser's: an operator abroad must see the day the
  // customer actually chose, and a midnight slot is exactly the value that
  // lands on the previous day if you read it with the browser's own getHours().
  const g = gzParts(dt);
  const dateOnly = (g.h === 0 && g.mi === 0);
  return tdWhen(dt, dateOnly ? 'date' : 'dateTime');
}
// Date only — "Jul 17" / "7月17日". A ship-by DEADLINE is a day, not a minute,
// so we drop the time tail that fmtSlotShort carries.
function fmtDateShort(dt) {
  return tdWhen(dt, 'date');
}
// A slot label captured at checkout can LEAD with a relative day word —
// "Tomorrow 10:00–12:00" / "明天 10:00–12:00" — frozen at the moment the customer
// ordered. By the time staff read it on the actual delivery day, "tomorrow" has
// silently become today: a stale, misleading word. Replace any leading relative
// day with the CONCRETE date resolved from scheduled_for (the absolute slot
// timestamp), so the tile always shows an unambiguous day in the operator's own
// language. Anything without a leading relative word (or with no usable
// scheduled_for) passes through untouched.
function absolutizeSlotLabel(label, scheduledForIso) {
  if (label == null || label === '') return label;
  const s = String(label);
  const m = /(today|tomorrow|yesterday|今天|明天|昨天)/i.exec(s);
  if (!m) return label;
  const dt = parseSchedFor(scheduledForIso);
  if (isNaN(dt.getTime())) return label;       // can't resolve the date → leave as-is
  const datePart = fmtDateShort(dt);           // "Jun 19" / "6月19日" — operator-language
  return s.replace(m[1], datePart);            // swap the word in place, keep "Pickup …"/time tail
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
// Companion to routingNote: on a 缺货 reroute, name the SKUs the NEARER store
// was short on, so ops sees WHY it moved (which item to restock/rebalance)
// instead of an opaque "改派(缺货)". Empty for non-rerouted orders. The pids are
// this order's own cart items, so o.items resolves their names.
function rerouteShortNote(o) {
  let pids = [];
  try { pids = JSON.parse(o.reroute_short_pids || '[]') || []; } catch {}
  if (!pids.length) return '';
  const byId = new Map((o.items || []).map(it => [it.product_id, it]));
  const rows = pids.map(pid => {
    const it = byId.get(pid);
    if (!it) {
      return `<div style="display:flex; align-items:center; gap:8px; min-width:0;">`
        + `<span class="oi-thumb is-empty" aria-hidden="true"></span>`
        + `<span style="font-weight:600; color: var(--text-1);">#${escapeHtml(String(pid))}</span></div>`;
    }
    const nm = orderItemNames(it);
    return `<div style="display:flex; align-items:center; gap:8px; min-width:0;">`
      + itemThumb(it)
      + `<span style="min-width:0;">`
      +   `<span style="display:block; font-weight:600; font-size:13px; color: var(--text-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(nm.primary)}</span>`
      +   itemSkuHtml(it)
      + `</span></div>`;
  }).join('');
  return `<div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--line-soft);">`
    + `<div style="display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; color: color-mix(in srgb, var(--brass) 72%, #000); margin-bottom:8px;">`
    +   `<span style="width:6px; height:6px; border-radius:50%; background: var(--brass); flex:none;"></span>`
    +   `${cuT('Nearer store was short on', '就近门店缺货')}</div>`
    + `<div style="display:flex; flex-direction:column; gap:7px;">${rows}</div>`
    + `</div>`;
}
// Warning line for orders whose shipping store can't currently cover every item
// (set at checkout on out-of-city / scheduled-later orders that skipped the
// stock gate — see fulfillment_short_pids). Names the short items so the office
// knows what to restock or transfer in before the parcel ships. The order was
// accepted normally; this is purely a heads-up, never a block.
// Compact list-row counterpart to fulfillmentShortStrip — a small amber chip so
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
// List-row badge for an order the customer added to AFTER paying ("Add to your
// order"). Staff may already be packing it, so flag it on the list so the
// add-on isn't missed without opening the drawer. addon_count comes from the
// orders-list endpoint (success add-ons only).
function addonBadge(o) {
  if (!Number(o.addon_count)) return '';
  return `<span class="pill st-paid" title="${cuT('Items were added after this order was placed','下单后又加购了商品')}">`
    + `<span class="dot"></span>${cuT('Updated · 加单','加单 · Updated')}</span>`;
}
// List-row / drawer badge: order is 'paid' but its real stock hasn't been
// decremented yet — an out-of-GZ order that skipped the checkout reserve gate
// (see inventory.isStockPending). Without this the Products stock count looks
// "wrong" to staff for a sold order that just hasn't hit Preparing yet. Quiet
// .ord-note-line (shared with invoiceLine) instead of a pill — this used to be
// a second status pill fighting the order's own status for attention.
function stockPendingBadge(o) {
  if (!o.stock_pending) return '';
  const title = cuT('Real stock deducts once this order moves to Preparing', '库存要等这单推进到备货中才会真正扣减');
  return `<div class="ord-note-line is-owed" title="${escapeAttr(title)}">`
    + `${ICON_STOCK_PENDING}${cuT('Stock pending', '库存待扣')}</div>`;
}
// Drawer audit block: each "Add to your order" event, time-stamped, so the
// operator sees WHEN items were added (after the slip likely already printed)
// and WHAT — not just that an add-on exists. Data is o.addons (server attaches
// it on the order-detail endpoint), each with paid_at, amount, and items.
function renderAddonTimeline(o) {
  const addons = (o.addons || []).filter(a => (a.items || []).length || Number(a.amount));
  if (!addons.length) return '';
  const rows = addons.map(a => {
    const names = (a.items || []).map(it => `${escapeHtml(it.name_en || it.name_cn || '')} ×${it.qty}`).join('、');
    return `<div style="display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--line-soft);">
      <div style="min-width:0;">
        <div style="font-weight:700; color:var(--text-1);">${names || cuT('Items added','已加单')}</div>
        <div class="sub" style="color:var(--text-3); margin-top:2px;">${cuT('Added','加单于')} · ${formatDate(a.paid_at)}</div>
      </div>
      <div style="font-weight:800; white-space:nowrap; color:var(--text-1);">+${acMoney(a.amount)}</div>
    </div>`;
  }).join('');
  return `<div class="order-items" style="margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--line-soft);">
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.22em; text-transform:uppercase; color:var(--brass); margin-bottom: var(--s2);">${cuT('Added later · 加单','加单 · Added later')}</div>
      ${rows}
    </div>`;
}
// Restock heads-up shown BELOW the facts grid (never crammed inside the
// half-width Fulfilled-by tile, where the heading wrapped to 5 lines and the
// thumbnail collided with the qty). Deliberately quiet — Tacet amber is
// "attention, never alarmist": a plain card with a single brass left rule and
// a calm dot, not a filled alarm band. Each short item (thumb · name · size ·
// sku) sits inline; stacks when several are short.
function fulfillmentShortStrip(o) {
  let pids = [];
  try { pids = JSON.parse(o.fulfillment_short_pids || '[]') || []; } catch {}
  if (!pids.length) return '';
  const byId = new Map((o.items || []).map(it => [it.product_id, it]));
  const items = pids.map(pid => {
    const it = byId.get(pid);
    if (!it) {
      return `<div style="display:flex; align-items:center; gap:8px; min-width:0;">`
        + `<span class="oi-thumb is-empty" aria-hidden="true"></span>`
        + `<span style="font-weight:600; color: var(--text-1);">#${escapeHtml(String(pid))}</span></div>`;
    }
    const nm = orderItemNames(it);
    const size = it.size ? ` <span style="color: var(--text-3); font-weight:400;">· ${escapeHtml(it.size)}</span>` : '';
    return `<div style="display:flex; align-items:center; gap:8px; min-width:0;">`
      + itemThumb(it)
      + `<span style="font-weight:600; color: var(--text-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">`
      +   `${escapeHtml(nm.primary || ('#' + pid))}${size}</span>`
      + itemSkuHtml(it)
      + `</div>`;
  }).join('');
  const multi = pids.length > 1;
  return `<div class="full" style="display:flex; align-items:${multi ? 'flex-start' : 'center'}; gap:12px;`
    + ` padding:10px 14px 10px 16px; border-radius:12px; background: var(--bg-pane);`
    + ` border:1px solid var(--line); box-shadow: inset 3px 0 0 var(--brass);">`
    + `<span style="display:flex; align-items:center; gap:7px; flex:none;${multi ? ' padding-top:5px;' : ''}">`
    +   `<span style="width:7px; height:7px; border-radius:50%; background: var(--brass); flex:none;"></span>`
    +   `<span style="font-size:13px; font-weight:700; color: color-mix(in srgb, var(--brass) 72%, #000);">`
    +     `${cuT('Restock before shipping', '发货前补货')}</span>`
    + `</span>`
    + `<span style="color: var(--line); flex:none;${multi ? ' padding-top:5px;' : ''}">·</span>`
    + `<div style="display:flex; flex-direction:column; gap:7px; min-width:0; flex:1;">${items}</div>`
    + `</div>`;
}

// ─── Awaiting restock — naming what the order is parked on ─────────────────
// An order parks in 'awaiting_restock' two ways: the customer answers the
// checkout shortage modal with "wait for restock" (fallback_choice =
// 'wait_for_restock'), or a pre-order line is bought (no fallback_choice at
// all — an empty value means pre-order, never an error). Either way
// awaiting_restock_pids records WHICH products it is waiting on.
//
// Until this shipped the drawer showed the status pill and nothing else, so
// staff read every line of a seven-product order and then went to Products to
// check stock SKU by SKU to find the short one.
//
// 🔴 The column is deliberately KEPT after the order releases — it is the audit
// trail, and checkAwaitingRestockForRestock() says so where it flips the status.
// So every reader here gates on the LIVE STATUS too. Read the pids alone and a
// long-shipped order still claims to be waiting on stock.
function awaitingRestockPids(o) {
  if (!o || o.status !== 'awaiting_restock') return [];
  let pids = [];
  try { pids = JSON.parse(o.awaiting_restock_pids || '[]') || []; } catch {}
  return Array.isArray(pids) ? pids : [];
}

// The fulfilling store's name in the operator's language, for the card's title.
// Falls back to the code, then to the plain word — the sentence has to stay
// true for an order whose store row was deleted.
function awaitingRestockStore(o) {
  const en = o.store_name_en || o.store_code || '';
  const cn = o.store_name_cn || o.store_code || '';
  return cuT(en, cn);
}

// The card that answers "what is this order parked on?", rendered above the
// items so it is read before any scrolling. Companion to fulfillmentShortStrip
// (the shipping-store shortage) and built the same way — same slot, same pid →
// item lookup — because they are the same question asked of two different
// columns, and an operator should not have to learn two treatments for it.
//
// Amber names the shortage: a person is needed. The line below it carries the
// Dusk dot instead, because the release is NOT the operator's job — stock
// landing at the store flips the order back to Paid on its own. Without that
// sentence the card reads as a task, and staff chase an order that is already
// being watched.
// ── The shop's own note on an order ─────────────────────────────────────────
//
// Orders have carried a `staff_note` since manual orders were built, and until
// now the ONLY place it could be typed was the New order form: an order that
// arrived from the shop, the website or a marketplace could never be annotated,
// because the only endpoint that accepted a note was the status route and that
// refuses a request carrying no status transition. "Customer rang, leave it
// next door" had nowhere to go.
//
// Collapsed to a single line when empty so it costs nothing on a drawer nobody
// needs it on; the Save button appears only once the text differs from what is
// stored, so an operator reading an order never sees an action they have no
// reason to take.
function staffNoteBlock(o) {
  const note = o.staff_note || '';
  return `<div class="full ord-note" data-order-id="${o.id}">
    <div class="kicker">Shop note · 店铺备注</div>
    <textarea class="ord-note-in" rows="${note ? 3 : 1}" maxlength="2000"
      data-ph-en="Add a note for whoever handles this order" data-ph-cn="给处理这张订单的同事留个备注"
      placeholder="Add a note for whoever handles this order"
      oninput="ordNoteChanged(${o.id})">${escapeHtml(note)}</textarea>
    <div class="ord-note-foot" id="ord-note-foot-${o.id}" hidden>
      <button class="btn btn-sm" type="button" onclick="ordNoteReset(${o.id})">${cuT('Cancel', '取消')}</button>
      <button class="btn btn-sm btn-primary" type="button" onclick="ordNoteSave(${o.id}, event)">${cuT('Save note', '保存备注')}</button>
    </div>
  </div>`;
}
// Show the footer only when the text has actually changed. `_ordNoteOriginal`
// is read from the open order rather than stashed at render time, so reopening
// the drawer can never leave a stale baseline behind.
function _ordNoteOriginal() { return (_OPEN_ORDER && _OPEN_ORDER.staff_note) || ''; }
function ordNoteChanged(id) {
  const wrap = document.querySelector(`.ord-note[data-order-id="${id}"]`);
  const foot = document.getElementById('ord-note-foot-' + id);
  if (!wrap || !foot) return;
  const el = wrap.querySelector('.ord-note-in');
  foot.hidden = (el.value === _ordNoteOriginal());
}
function ordNoteReset(id) {
  const wrap = document.querySelector(`.ord-note[data-order-id="${id}"]`);
  if (!wrap) return;
  wrap.querySelector('.ord-note-in').value = _ordNoteOriginal();
  ordNoteChanged(id);
}
async function ordNoteSave(id, ev) {
  const wrap = document.querySelector(`.ord-note[data-order-id="${id}"]`);
  if (!wrap) return;
  const el = wrap.querySelector('.ord-note-in');
  try {
    const j = await adminWrite({
      btn: ev && ev.currentTarget, url: `/api/retail-admin/orders/${id}/note`,
      method: 'PATCH', body: { staff_note: el.value },
      busyLabel: cuT('Saving…', '保存中…'),
      errLabelEn: 'Note not saved', errLabelCn: '备注未保存',
    });
    // Keep the open order in step so the baseline and a later reopen agree.
    if (_OPEN_ORDER && _OPEN_ORDER.id === id) _OPEN_ORDER.staff_note = j.staff_note || '';
    el.value = j.staff_note || '';
    ordNoteChanged(id);
    toast(cuT('Note saved', '备注已保存'));
  } catch (e) { /* adminWrite has already said what went wrong */ }
}

function awaitingRestockCard(o) {
  const pids = awaitingRestockPids(o);
  if (!pids.length) return '';
  const byId = new Map((o.items || []).map(it => [it.product_id, it]));
  const rows = pids.map(pid => {
    const it = byId.get(pid);
    // A pid with no matching line means the item was removed from the order
    // after it parked. Show the id rather than dropping the row — a silent
    // omission would make the card disagree with the status pill.
    if (!it) {
      return `<div class="ar-row"><span class="oi-thumb is-empty" aria-hidden="true"></span>`
        + `<span class="ar-name">#${escapeHtml(String(pid))}</span></div>`;
    }
    const nm = orderItemNames(it);
    return `<div class="ar-row">`
      + itemThumb(it)
      + `<span class="ar-name">${escapeHtml(nm.primary)}</span>`
      + itemSkuHtml(it)
      + itemQtyHtml(it)
      + `</div>`;
  }).join('');
  const store = awaitingRestockStore(o);
  const title = store
    ? cuT(`Waiting on stock at ${store}`, `${store}等待补货`)
    : cuT('Waiting on stock', '等待补货');
  // The pre-order case has no fallback_choice, so it gets no "the customer
  // chose to wait" clause — that sentence would be untrue there.
  const chose = o.fallback_choice === 'wait_for_restock'
    ? cuT('The customer chose to wait. ', '顾客选择了等待补货。')
    : '';
  const releases = store
    ? cuT(`Releases to Paid on its own once ${store} can cover the order.`,
          `${store}备齐订单全部商品后,订单会自动转为已支付。`)
    : cuT('Releases to Paid on its own once the store can cover the order.',
          '门店备齐订单全部商品后,订单会自动转为已支付。');
  return `<div class="full ar-card">`
    + `<div class="ar-head">${escapeHtml(title)}</div>`
    + `<div class="ar-list">${rows}</div>`
    + `<div class="ar-auto"><span class="ar-dot" aria-hidden="true"></span>`
    +   `<span>${escapeHtml(chose + releases)}</span></div>`
    + `</div>`;
}

// Full-size "Ship by" tile shown in the order-detail card grid. Same decision
// (shipByPlan) and urgency scheme as the list cell, with more context: the
// kicker, a verbose urgency badge, the made-fresh / no-slot sub-line, and the
// delivery mode + same-day surcharge note.
function renderShipByTile(o) {
  const actionable = (o.status === 'paid' || o.status === 'preparing');
  const p = shipByPlan(o);
  // NO PLAN, NO TILE. shipByPlan returns null for a counter sale on purpose:
  // it was paid and handed over in one moment, so there is no deadline, no
  // window and no requested timing. The tile is omitted rather than defaulted,
  // because any date this could fall back to — placed_at, paid_at — would
  // render as a promise the shop never made.
  //
  // This is the bug that made order 1248 unopenable: the ORDERS LIST guards
  // counter upstream (renderDeliveryCell returns an em-dash and never calls its
  // renderer), but the drawer called this unconditionally, so shipByUrgency
  // dereferenced a null plan and the whole drawer failed to render. The list
  // and the drawer now agree about the same documented null.
  if (!p) return '';
  const u = shipByUrgency(p, actionable);
  const usingRaw = (p.headlineRaw != null && p.headlineRaw !== '');
  const headlineText = usingRaw ? String(p.headlineRaw) : cuT(p.headlineEn, p.headlineCn);
  const headline = usingRaw ? escapeHtml(headlineText) : headlineText;
  // A right-away order's kicker IS its headline — "Right away" over "Right away",
  // 立即配送 over 立即配送 — the same word twice in a two-line tile. The list cell
  // never had this (showKicker is false for kind 'asap'); the drawer renders its
  // kicker unconditionally, so suppress the echo here. Compared on the RESOLVED
  // strings, not the kind, so it holds in whichever language is on screen and
  // catches any future kicker that lands on its own headline. A closed order
  // relabels to "Requested timing", which no longer matches — and still shows.
  const kickerText = cuT(p.kickerEn, p.kickerCn);
  const kickerHtml = (kickerText && kickerText !== headlineText)
    ? `<div class="kicker">${kickerText}</div>` : '';
  // Verbose urgency badge after the headline — gated on actionable for the same
  // reason as the list cell: a dispatched/closed order's deadline is always in
  // the past, so don't badge it OVERDUE.
  const h = u.hrs;
  let badge = '';
  if (!actionable) {
    // no urgency badge once the order has shipped / closed
  } else if (p.urgencyBasis === 'age') {
    // Age basis has no hours/date — badge the days waited, only once it matters.
    if (u.level === 'overdue')   badge = cuT(`⚠ ${u.days}d unshipped`, `⚠ 已 ${u.days} 天未发`);
    else if (u.level === 'soon') badge = cuT(`waiting ${u.days}d`, `已等 ${u.days} 天`);
  } else if (u.dateOnly) {
    // Calendar-day badge — no hours (a bare date has no meaningful time-of-day).
    if (u.level === 'overdue')       badge = cuT('⚠ overdue', '⚠ 已逾期');
    // Batch leads with the arrival date but colours by the ship date — a relative
    // word would misread beside the headline, so show only the overdue alert.
    else if (p.kind === 'batch') {}
    else if (u.level === 'today')    badge = cuT('today', '今天');
    else if (u.level === 'tomorrow') badge = cuT('tomorrow', '明天');
    else if (u.level === 'later')    badge = cuT(`in ${u.days}d`, `${u.days}天后`);
  } else if (u.level === 'overdue') badge = cuT('⚠ OVERDUE', '⚠ 已逾期');
  else if (u.level === 'urgent')   badge = cuT(`⚠ in ${Math.round(h)}h`, `⚠ ${Math.round(h)}小时内`);
  else if (u.level === 'soon')     badge = cuT(`${Math.round(h)}h left`, `剩 ${Math.round(h)}小时`);
  else if (u.level === 'today')    badge = h < 6 ? cuT(`⚠ in ${Math.round(h)}h`, `⚠ ${Math.round(h)}小时内`) : cuT(`today (${Math.round(h)}h)`, `今天 (${Math.round(h)}小时)`);
  else if (u.level === 'tomorrow') badge = cuT('tomorrow', '明天');
  else if (u.level === 'later' && h != null && p.urgencyBasis === 'arrival') badge = cuT(`in ${Math.round(h / 24)}d`, `${Math.round(h / 24)}天后`);
  const badgeHtml = badge ? ` <span style="font-size: 11px; color: ${u.color}; font-weight: 600;">· ${badge}</span>` : '';
  // Primary sub-line (made-fresh note / no-slot reason). Batch is highlighted.
  // ASAP orders have no note — show the order's age instead ("placed 2 days ago").
  const pdTile = parseSchedFor(p.urgencyDate || o.placed_at);
  const placedDateTile = isNaN(pdTile.getTime()) ? '' : fmtDateShort(pdTile);
  const subMain = p.subEn != null ? cuT(p.subEn, p.subCn)
    : (p.kind === 'asap' && u.days != null)
      ? (u.days <= 0
          ? (placedDateTile ? cuT(`placed ${placedDateTile}`, `下单于${placedDateTile}`) : cuT('placed today', '今天下单'))
          : cuT(`placed ${u.days} day${u.days === 1 ? '' : 's'} ago`, `${u.days}天前下单`))
      : '';
  const subLine = subMain
    ? `<div class="sub"${p.kind === 'batch' ? ' style="color: var(--warn); font-weight: 600;"' : ''}>${subMain}</div>` : '';
  // Order-level facts: delivery mode + same-day surcharge.
  const mode = deliveryModeNote(o.delivery_mode);
  const paidSameDay = (Number(o.same_day_surcharge_fee) || 0) > 0;
  const surcharge = paidSameDay
    ? `${mode ? ' · ' : ''}<span style="color: var(--warn);">+${acMoney(o.same_day_surcharge_fee)} ${cuT('same-day surcharge','当日加收')}</span>` : '';
  // Right-away ASAP orders: the customer DID ask for as-soon-as-possible, so
  // surface that plainly. For the plain no-date case the headline already reads
  // "Courier — ship when ready", so the old "no same-day paid · ship by courier"
  // caveat was redundant (and stated the obvious for out-of-city parcels).
  const isRightAway = o.delivery_slot_kind === 'right_away';
  const asapStd = (p.kind === 'asap' && !paidSameDay && isRightAway)
    ? `${mode ? ' · ' : ''}<span class="muted">${cuT('as soon as possible','尽快发货')}</span>`
    : '';
  const modeLine = (mode || surcharge || asapStd) ? `<div class="sub">${mode}${surcharge}${asapStd}</div>` : '';
  return `<div>
    ${kickerHtml}
    <div class="val"${usingRaw ? ' data-no-i18n' : ''}><b style="color: ${u.color};">${headline}</b>${badgeHtml}</div>
    ${subLine}
    ${modeLine}
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
  if (o.status === 'delivered') return { icon: 'check', en: 'Delivered', cn: '已签收', color: '#5C7A4E', tone: 'ok' };
  const st = o.tracking_status || '';
  const sc = o.tracking_scenario || '';
  // Problems first — these are what the operator must act on.
  if (sc === 'no_contact')  return { icon: 'phone_off', en: "Can't reach customer",   cn: '联系不上客户', color: '#B4533E', tone: 'urgent' };
  if (st === 'exception')   return { icon: 'alert',     en: 'Delivery issue',          cn: '配送异常',     color: '#B4533E', tone: 'urgent' };
  if (st === 'returning')   return { icon: 'uturn',     en: 'Returning to sender',     cn: '退回中',       color: '#B4533E', tone: 'urgent' };
  if (st === 'returned')    return { icon: 'uturn',     en: 'Returned',                cn: '已退回',       color: '#B4533E', tone: 'urgent' };
  // Waiting on the customer to collect — not a failure, but worth seeing.
  if (sc === 'pickup_point') return { icon: 'store',    en: 'At pickup point',        cn: '已到驿站',     color: '#9A6E2A', tone: 'attn' };
  if (sc === 'locker')       return { icon: 'locker',   en: 'In a locker',            cn: '已入快递柜',   color: '#9A6E2A', tone: 'attn' };
  // Good / in-flight states.
  if (st === 'delivered')        return { icon: 'check', en: 'Delivered',             cn: '已签收',       color: '#5C7A4E', tone: 'ok' };
  if (st === 'out_for_delivery' || sc === 'out_for_delivery')
                                 return { icon: 'courier', en: 'Out for delivery',     cn: '派送中',       color: '#6B7280', tone: 'transit' };
  if (st === 'in_transit')       return { icon: 'transit', en: 'In transit',          cn: '运输中',       color: '#6B7280', tone: 'transit' };
  if (st === 'picked_up')        return { icon: 'inbox',  en: 'Picked up',            cn: '已揽收',       color: '#6B7280', tone: 'transit' };
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
  // Two stacked boxes — split delivery (multiple parcels in one order).
  parcels:   '<path d="M3 8l5-3 5 3-5 3-5-3z"/><path d="M3 8v6l5 3v-6"/><path d="M13 8v6l-5 3"/><path d="M13.5 13l4-2.3 4 2.3-4 2.3-4-2.3z"/><path d="M13.5 13v4l4 2.3v-4"/><path d="M21.5 13v4l-4 2.3"/>',
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

// ── "Delivery" — ONE column that merges the old Tracking + Ship-by pair.
// Those were two separate columns that each sat empty on most rows: a shipped
// order has a tracking line but its ship-by deadline is already in the past; an
// unshipped one has a ship-by deadline but no tracking yet. Side by side, two
// half-empty columns left a wide empty gap in the list. Collapsing them into a
// single column removes that gap AND reads better — each row shows the ONE
// fulfilment fact that's live right now:
//   readonly channel  → the platform's own ETA while in flight, else "view only"
//   pickup            → the counter window (owned by the ship-by plan)
//   shipped / moving  → the waybill + live delivery state (owned by tracking)
//   not yet shipped   → the ship-by deadline (owned by the ship-by plan)
// Delegating to the existing renderers keeps every downstream behaviour intact
// (split-parcel rollup, air-delay badge, missing-waybill warning, urgency tags).
function renderDeliveryCell(o) {
  // Mirrored ledger rows (Meituan / gzgrocery): we don't fulfil them. Surface
  // the platform's delivery time — the ETA while in flight, and the rider's real
  // drop-off time once it lands, which is what the drawer shows.
  // Voided orders never arrived, so they keep the bare dash.
  if (typeof ordIsReadonlyChannel === 'function' && ordIsReadonlyChannel(o)) {
    // delivered_at joins channel_eta as a reason to render: a delivered order
    // whose ETA never came through still has a real arrival time to show.
    if ((o.channel_eta || o.delivered_at) && !['cancelled', 'refunded'].includes(o.status)) {
      return renderTrackingCell(o);
    }
    return '<span class="muted">—</span>';
  }
  // A counter sale has no timing at all — nothing was promised and nothing is
  // owed, so the cell stays empty rather than borrowing a deadline.
  if (ordIsCounter(o)) return '<span class="muted">—</span>';
  // Pickup carries no parcel — the counter window IS the delivery fact.
  if (o.fulfillment_type === 'pickup') return renderShipByCell(o);
  // Once an order has left (or has a waybill / operator-set ETA), the tracking
  // line is the live fact and the ship-by deadline is by definition in the past.
  const moving = o.status === 'dispatched' || o.status === 'delivered'
    || o.tracking_number || o.local_eta;
  if (moving) return renderTrackingCell(o);
  // Still to ship: the ship-by deadline is what the operator acts on.
  return renderShipByCell(o);
}

// Live courier stage line for the orders LIST (a compact twin of the drawer's
// rider card). Returns '' when there's no live rider to show — pre-dispatch
// ('scheduled'), delivered (the status pill already says so), or no courier job —
// so the caller falls back to the platform ETA. Brick-red matches the drawer's
// "live rider" colour. Fed by o.courier, attached to each list row server-side.
function renderCourierListLine(o) {
  const c = o.courier;
  if (!c || !c.stage || c.stage === 'scheduled' || c.stage === 'delivered') return '';
  // The order can reach a terminal state while the courier's live row froze mid-transit:
  // a finished job drops off the courier's in-flight list, so its snapshot never flips
  // to 'delivered' and stays at 'in_transit'. Trust the order status — once it's
  // delivered/cancelled/refunded, the frozen "On the way · ~1m · 91m" line is a lie, so
  // bail and let renderTrackingCell fall through to the settled arrival line.
  if (o.status === 'delivered' || o.status === 'cancelled' || o.status === 'refunded') return '';
  const label = c.stage === 'in_transit'        ? cuT('On the way', '配送中')
              : c.stage === 'heading_to_pickup' ? cuT('Rider coming', '骑手前往取货')
              : c.stage === 'awaiting_dispatch' ? cuT('Finding a rider', '正在找骑手')
              : '';
  if (!label) return '';
  // eta_seconds is time-to-STORE while heading_to_pickup (Qingyun's own routeInfo
  // targets the shop until the parcel is actually collected) — showing it here
  // would read as "arriving in 1m" when the rider hasn't even picked up yet, so
  // only surface the countdown once genuinely in_transit to the customer.
  const mins = (c.stage === 'in_transit' && c.eta_seconds != null)
    ? `~${Math.max(1, Math.round(c.eta_seconds / 60))}${cuT('m', '分')}` : '';
  // rider_to_cust_m is the real straight-line distance to the customer regardless
  // of stage, so it's safe to show while heading_to_pickup too.
  const dist = ((c.stage === 'in_transit' || c.stage === 'heading_to_pickup') && c.rider_to_cust_m != null)
    ? (c.rider_to_cust_m >= 1000 ? (c.rider_to_cust_m / 1000).toFixed(1) + 'km' : Math.round(c.rider_to_cust_m) + 'm') : '';
  const sub = [mins, dist].filter(Boolean).join(' · ');
  return `<div style="display:flex; align-items:center; gap:3px; font-size:11px; font-weight:600; color:#B4533E;">${deliveryIcon('scooter', 12)}<span>${label}</span></div>`
       + (sub ? `<div class="muted" style="font-size:10px; margin-top:2px;">${sub}</div>` : '');
}

function renderTrackingCell(o) {
  // No parcel and no waybill on either, but they are not the same thing: a
  // pickup is waiting to be collected, a counter sale is already gone.
  if (ordIsCounter(o)) {
    return `<span class="muted" style="font-size:11px;">${cuT('counter','前台')}</span>`;
  }
  if (o.fulfillment_type === 'pickup') {
    return `<span class="muted" style="font-size:11px;">${pickupIcon(11)} ${cuT('pickup','自提')}</span>`;
  }
  // Read-only channels (Meituan): Meituan owns the rider, so we have no waybill —
  // show the platform's delivery time instead, and never the "missing waybill"
  // warning below (which doesn't apply). Once the order lands, the ETA gives way
  // to the real arrival — quiet grey, since nothing is pending any more.
  if (typeof ordIsReadonlyChannel === 'function' && ordIsReadonlyChannel(o)) {
    // Live Qingyun rider stage (Wave A): Meituan's delivery IS a Qingyun rider we
    // now track, so prefer the real stage + ETA over the platform's static ETA.
    const live = renderCourierListLine(o);
    if (live) return live;
    const done = o.status === 'delivered';
    // Once it lands, the fact worth showing is when it ACTUALLY arrived, not what
    // was promised. This cell used to read the ETA back as the arrival, which on a
    // Meituan order the rider drops off EARLY says "arrived 12:31 PM" at 11:54 —
    // a future time labelled as a past event. delivered_at is the honest one: on a
    // mirrored order it is stamped only by the Qingyun rider's real drop-off
    // (autoDeliverQingyunForTenant). Meituan's own status poll and the past-ETA
    // timer flip advance the status WITHOUT stamping it, so an order delivered on
    // either of those has no arrival time we can truthfully print — it keeps the
    // ETA, labelled as the ETA it always was rather than dressed up as an arrival.
    const arrivedAt = done ? (o.delivered_at || null) : null;
    if ((o.channel_eta || arrivedAt) && !['cancelled', 'refunded'].includes(o.status)) {
      // 预订单: a booked window, not a delivery in progress. Same time, different
      // meaning — green "arrival" on a 3-hour-out pre-order reads as an order
      // already on its way, so booked ones get their own amber "booked" line.
      const booked = !done && !!o.channel_preorder_at;
      const colour = done ? 'var(--text-3)' : booked ? '#8A6516' : '#5C7A4E';
      const label = arrivedAt ? cuT('arrived', '已送达')
                  : done ? cuT('ETA', '预计送达')
                  : booked ? cuT('booked', '顾客预约')
                  : cuT('arrival', '预计送达');
      const when = arrivedAt ? arrivedAt : booked ? o.channel_preorder_at : o.channel_eta;
      return `<div style="display:flex; align-items:center; gap:3px; font-size:11px; font-weight:600; color:${colour};">${deliveryIcon('scooter', 12)}<span>${escapeHtml(formatEtaClock(when))}</span></div>
              <div class="muted" style="font-size:10px; margin-top:2px;">${label}</div>`;
    }
    return '<span class="muted">—</span>';
  }
  // Local (same-city) delivery has no waybill — it carries an operator-set ETA
  // instead. Show that here, and never the red "missing waybill" warning, which
  // doesn't apply to local delivery.
  if (o.is_local) {
    if (o.local_eta) {
      return `<div style="display:flex; align-items:center; gap:3px; font-size:11px; font-weight:600; color:#5C7A4E;">${deliveryIcon('scooter', 12)}<span>${escapeHtml(formatEtaPretty(o.local_eta))}</span></div>
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
    ? `<span style="color:#5C7A4E; font-size:10px;">● ${cuT('live','实时')}</span>`
    : `<span class="muted" style="font-size:10px;">${cuT('manual','手动')}</span>`;
  // Split delivery: the order-level tracking_status is just ONE parcel's state,
  // so a single line reads "Delivered" even when another parcel is still moving
  // (and the pill correctly stays "Dispatched" until ALL parcels arrive). Show a
  // per-parcel rollup instead so the office sees why the order isn't done yet.
  const splitLine = renderSplitRollupLine(o);
  // Live delivery state — only meaningful once the parcel has left (dispatched),
  // and only when the carrier has actually reported something. Urgent states get
  // a heavier weight so a stuck/contact-failed parcel stands out in the list.
  // For split orders the rollup above replaces this single (misleading) line.
  const dl = (!splitLine && (o.status === 'dispatched' || o.status === 'delivered')) ? deliveryStateInfo(o) : null;
  const dlLine = dl
    ? `<div style="margin-top:3px; display:flex; align-items:center; gap:3px; font-size:10px; font-weight:${dl.tone === 'urgent' ? 700 : 600}; color:${dl.color};">${deliveryIcon(dl.icon, 11)}<span>${cuT(dl.en, dl.cn)}</span></div>`
    : '';
  const airDelayBadge = o.air_delivery_delayed
    ? `<div style="display:flex; align-items:center; gap:3px; font-size:10px; font-weight:700; color: var(--danger); margin-top:3px;">⚠ ${cuT('AIR DELAYED · contact customer', '空运延误 · 联系客户')}</div>`
    : '';
  return `<div style="font-family: var(--f-mono); font-size: 11px; font-weight: 600;">${escapeHtml(carrier)} ${escapeHtml(o.tracking_number)}</div>
          <div style="margin-top: 2px;">${sync}</div>${splitLine}${dlLine}${airDelayBadge}`;
}

// For multi-parcel (split) orders, a two-line summary: "N parcels" + a breakdown
// like "1 delivered · 1 in transit". Returns '' for single-parcel orders so they
// render exactly as before. Counts come from the list query's shipment rollup
// (shipment_count / shipment_delivered / shipment_moving). A fully-delivered
// order is shown by the status pill, so we still surface the rollup until then.
function renderSplitRollupLine(o) {
  const total = Number(o.shipment_count) || 0;
  if (total < 2) return '';
  const delivered = Math.min(Number(o.shipment_delivered) || 0, total);
  const moving    = Math.min(Number(o.shipment_moving)    || 0, total - delivered);
  const toShip    = Math.max(0, total - delivered - moving);
  const parts = [];
  if (delivered) parts.push(`<span style="color:#5C7A4E; font-weight:700;">${delivered} ${cuT('delivered','已签收')}</span>`);
  if (moving)    parts.push(`<span style="color:#6B7280;">${moving} ${cuT('in transit','运输中')}</span>`);
  // Amber + bold (not muted grey): an unshipped parcel on an otherwise-dispatched
  // order is an open to-do — it's also why the order still sits in the Paid tab.
  if (toShip)    parts.push(`<span style="color:#9A6E2A; font-weight:700;">${toShip} ${cuT('to ship','待发货')}</span>`);
  const breakdown = parts.join(' · ');
  return `<div style="margin-top:3px; display:flex; align-items:center; gap:3px; font-size:10px; font-weight:600; color:var(--text-2);">`
       + `${deliveryIcon('parcels', 12)}<span>${total} ${cuT('parcels','个包裹')}</span></div>`
       + (breakdown ? `<div style="margin-top:1px; font-size:10px;">${breakdown}</div>` : '');
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
  // ship_counter is set by annotateShipTo server-side. Kept apart from
  // ship_pickup on purpose: a list that calls a walk-in a pickup is a small lie
  // that ends up in a report.
  if (o.ship_counter || ordIsCounter(o)) {
    return `<span class="muted" style="font-size:11px;">${shipToLangBlock('Counter','前台')}</span>`;
  }
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
    // Change handler is an inline onchange="ordFilterChanged()" on the element.
    ORDERS_STORE_FILTER_LOADED = true;
  } catch (e) { /* silent — filter just stays minimal */ }
}

function humanStatus(s, fulfillmentType) {
  // A counter sale reaches 'delivered' the moment it is paid, but nothing was
  // delivered — it was handed over. "Completed" is the operator's word for it.
  // Two separate strings, never joined (§1.11); the glued pickup labels below
  // are pre-existing and belong to the page rebuild, not here.
  if (fulfillmentType === 'counter') {
    if (s === 'delivered') return cuT('Completed', '已完成');
  }
  // Pickup reuses the dispatched/delivered statuses but they mean "ready at the
  // counter" and "collected by customer" (see retail.js progress tracker), so
  // relabel them for the operator instead of showing "Dispatched/Delivered".
  if (fulfillmentType === 'pickup') {
    if (s === 'dispatched') return 'Ready · 可取货';
    if (s === 'delivered')  return 'Picked up · 已取货';
  }
  return { pending_payment: 'Pending', paid: 'Paid', preparing: 'Preparing', rider_pickup: 'Rider coming', dispatched: 'Dispatched', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded', awaiting_restock: 'Awaiting restock' }[s] || s;
}
// "Jul 29, 2:49 PM" / "7月29日 14:49" — §1.18.
//
// This function used to do the whole job by hand: parse SQLite's zone-less
// UTC, hop to the store's wall clock, and then decide on a format. The first
// two were right and now live in tdWhen(); only the third was ever ours to
// make, and §1.18 made it once for the whole product.
//
// Kept as a named wrapper rather than deleted because ~30 call sites across
// Orders, Customers and Marketing read it. The name is now the only thing it
// contributes — the behaviour is the platform rule.
function formatDate(iso) {
  return tdWhen(iso, 'dateTime');
}

// Clock only — "2:49 PM" / "14:49". Used for the Meituan rider ETA.
function formatEtaClock(iso) {
  return tdWhen(iso, 'time');
}
// Date only, for fields like coupon expiry where stored values are mixed
// ("2026-06-09", "2026/10/6"). tdWhen() normalises both. The dash stays a
// decision of this helper: callers render it straight into a cell.
function formatDateOnly(v) {
  return tdWhen(v, 'date') || '—';
}

// Status transition button labels — bilingual per the EN · 中文 admin rule
// (project_roots_v2_bilingual_admin). Shown inside each order row's action
// column AND inside the open-order drawer's footer transition buttons.
const NEXT_STATUS = {
  pending_payment: [['paid', 'Mark paid · 标记已付款'], ['cancelled', 'Cancel · 取消']],
  paid:            [['preparing', 'Start preparing · 开始备货'], ['dispatched', 'Mark dispatched · 标记已发货'], ['refunded', 'Refund · 退款'], ['cancelled', 'Cancel + refund · 取消并退款']],
  preparing:       [['dispatched', 'Mark dispatched · 标记已发货'], ['refunded', 'Refund · 退款'], ['cancelled', 'Cancel + refund · 取消并退款']],
  // Meituan-only, read-only mirror: the platform (not our staff) advances a
  // "Rider coming" order to Dispatched once the rider picks up, so there are no
  // manual transition buttons — it flips itself on the next status poll.
  rider_pickup:    [],
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
  // Counter needs NO special case here, and adding one was a mistake worth
  // recording. The transition list is keyed on STATUS, and the only statuses a
  // counter sale can hold already offer the right things: 'pending_payment' →
  // Mark paid / Cancel (an unpaid till sale awaiting a QR settle), 'delivered' →
  // Refund, 'cancelled'/'refunded' → nothing. It never sits at paid, preparing or
  // dispatched, because markOrderPaid flips it straight past them, so no
  // forward-fulfilment button is reachable in the first place.
  //
  // Returning [] here — the original plan — would have stripped Refund from a
  // completed walk-in and Mark paid from an unpaid one, which contradicts born
  // fulfilled, NOT born closed: money still moves after the goods leave.
  if (o.fulfillment_type !== 'pickup') return transitions;
  return transitions.map(([next, label]) =>
    [next, NEXT_STATUS_PICKUP_LABELS[next] || label]);
}

// Sort modes for the items table inside an open order. Persisted per-order
// in memory; default = 'sku'.
let _ITEMS_SORT_MODE = 'sku';
let _OPEN_ORDER = null;
// Build the "open product in a new tab" href for an order line — a deep-link
// into THIS backend that lands on the Products tab focused on the product (see
// the /?product=ID handler in the boot IIFE). Same host, so it self-auths with
// the operator's session. Returns '' when the line has no product (e.g. a free
// gift / ad-hoc line) so callers render plain text instead of a dead link.
function productHref(pid) {
  if (!pid) return '';
  return `/?product=${encodeURIComponent(pid)}`;
}
// When an order is opened from a customer's Recent-orders row, remember that
// customer's id so the order drawer can offer a "back to customer" button.
// Null when the order was opened any other way (orders list, etc).
let _ORDER_BACK_CUSTOMER = null;
// Scroll position of the customer drawer body at the moment we jumped to the
// order, so "← Back to customer" lands on the exact same Recent-orders row.
let _ORDER_BACK_CUSTOMER_SCROLL = 0;

// Compare SKUs numerically segment-by-segment so "1-2" < "1-10" < "2-1"
// (a plain string compare puts "1-10" before "1-2"). Splits on any non-digit
// run; numeric chunks compare as numbers, any trailing text breaks ties.
function skuCompare(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  const na = sa.split(/(\d+)/).filter(s => s !== '');
  const nb = sb.split(/(\d+)/).filter(s => s !== '');
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const pa = na[i], pb = nb[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const da = /^\d+$/.test(pa), db = /^\d+$/.test(pb);
    if (da && db) {
      const diff = parseInt(pa, 10) - parseInt(pb, 10);
      if (diff) return diff;
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return 0;
}

function sortOrderItems(items, mode) {
  const arr = [...items];
  if (mode === 'sku') {
    return arr.sort((a, b) => skuCompare(a.sku, b.sku));
  }
  if (mode === 'shipping') {
    // Air-only → mixed → land-only.
    const score = it => {
      const m = it.ship_modes_arr || ['air', 'land'];
      if (m.length === 1 && m[0] === 'air')  return 0;
      if (m.length === 1 && m[0] === 'land') return 2;
      return 1;
    };
    return arr.sort((a, b) => score(a) - score(b) || skuCompare(a.sku, b.sku));
  }
  return arr; // 'default' — preserves order as the customer placed it
}

function renderPackBadges(it) {
  // Drop-ship line: the supplier ships it straight to the customer, so it's
  // never pulled from our own stock. Prepended to whatever shipping badge
  // follows (and shown even when ship modes are unrestricted, where the
  // air/land logic below returns nothing).
  const supplier = it.ship_from_supplier
    ? `<span class="pack-badge supplier" title="Ships directly from the supplier — do not pack · 供应商直发，无需打包">${cuT('Supplier-direct', '供应商直发')}</span>`
    : '';
  const arr = it.ship_modes_arr || ['air', 'land'];
  // Local only = Guangzhou same-city item (never air/land). Surface it plainly
  // rather than falling through to the air/land restriction logic below.
  if (arr.length === 1 && arr[0] === 'local') {
    // Inside a data-no-i18n block, so pick ONE language here (the runtime
    // walker won't split a glued pair for us).
    return supplier + `<span class="pack-badge land" title="${escapeAttr(cuT('Guangzhou local delivery only', '仅广州同城配送'))}">${cuT('Local only', '仅广州')}</span>`;
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
  if (hasAir && hasLand) return supplier;
  if (hasAir)
    parts.push(`<span class="pack-badge air" title="${escapeAttr(cuT('Air shipping only', '仅空运'))}">${cuT('Air only', '仅空运')}</span>`);
  else
    parts.push(`<span class="pack-badge land" title="${escapeAttr(cuT('Land shipping only — airline rejected', '仅陆运 — 航空拒运'))}">${cuT('Land only', '仅陆运')}</span>`);
  return supplier + parts.join('');
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

// Refunded units on a line (clamped). Mirrors the server's refunded_qty so the
// drawer can strike fully-refunded lines and flag partials as "don't ship".
function itemRefundedQty(it) {
  const q = Math.max(0, Number(it.qty) || 0);
  return Math.min(q, Math.max(0, Number(it.refunded_qty) || 0));
}
function itemFullyRefunded(it) {
  const q = Math.max(0, Number(it.qty) || 0);
  return q > 0 && itemRefundedQty(it) >= q;
}
// Refund pill for the manifest row: "退款 · do not ship" when fully refunded,
// "n of q refunded" on a partial. Monochrome inline SVG (no emoji, per house style).
function itemRefundHtml(it) {
  const rq = itemRefundedQty(it);
  if (!(rq > 0)) return '';
  const q = Number(it.qty) || 0;
  const full = itemFullyRefunded(it);
  const ic = `<svg class="rf-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 4v4h4"/></svg>`;
  const label = full
    ? cuT('Refunded · do not ship', '已退款 · 勿发货')
    : cuT(`${rq} of ${q} refunded`, `已退 ${rq}/${q}`);
  return `<span class="pack-badge refunded" title="${escapeHtml(full ? 'Refunded — do not ship this item · 已退款，请勿发货' : 'Partly refunded · 部分退款')}">${ic}${label}</span>`;
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
  const _href = productHref(it.product_id);
  const nameCell = _href
    ? `<a href="${_href}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${name}</a>`
    : name;
  // Meta line is SKU · qty · unit cost only. Size/weight dropped — the SKU
  // already pins the exact variant, so the weight was redundant.
  const refundPill = itemRefundHtml(it);
  // A line the order is parked on. The card above names it too; this is the
  // mark under the operator's finger while they read the pick list.
  //
  // NOT wrapped in .mf-packs, which carries `margin-left: auto` — that is the
  // right thing for a pack badge (a packing instruction, parked on the right
  // rail away from the SKU) and the wrong thing here. This badge is a fact
  // ABOUT this line, so it reads inline after the unit price, where the eye
  // already is. Wrapped, it shipped hard against the card's right edge with
  // the line total, crowding both.
  const waitPill = opts.waiting
    ? `<span class="pack-badge awaiting">${cuT('Waiting on stock', '待补货')}</span>`
    : '';
  const rowCls = `mf-row${itemFullyRefunded(it) ? ' refunded-row' : ''}`
    + `${opts.waiting ? ' awaiting-row' : ''}`;
  return `
    <div class="${rowCls}" data-fk="${it.id}">
      <span class="mf-num">${num}</span>
      ${itemThumb(it)}
      <div class="mf-body">
        <div class="mf-top">
          ${nameCell}
          <span class="mf-total">${acMoney(it.line_total)}</span>
        </div>
        <div class="mf-meta" data-no-i18n>
          ${itemSkuHtml(it)}
          ${itemQtyHtml(it)}
          <span class="item-unit">@ ${acMoney(it.unit_price)}</span>
          ${refundPill ? `<span class="mf-packs">${refundPill}</span>` : ''}
          ${waitPill}
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
    ${mk('default',   'As ordered · 原顺序')}
  </div>`;
}

// Chips + shipment cards, re-rendered together. Kept in one container so a
// sort change only swaps this fragment — re-rendering the whole order would
// tear down any open floating window (tracking popover, etc.).
function renderSortableItems(o) {
  const ships = o.shipments || [];
  // PACK BADGES ARE FOR PACKING, so an order that packs nothing shows none.
  // renderPackBadges says so itself — an Air-only / Land-only mark is "a real
  // packing warning (e.g. Land only — airline rejected)". A counter sale was
  // handed over at the till and a pickup is collected at the counter; neither
  // ever goes in a box or on a plane, so the item's shipping restriction has
  // no addressee and reads as a promise about a parcel that will not exist.
  //
  // Wider than counter, deliberately: the fallback branch below is reached by
  // pickup orders too (its own comment says so), which have been showing the
  // same meaningless badge. ordShipsNothing covers both, which is what it is
  // for.
  //
  // Items already grouped into a shipment card pass `false` here for a related
  // reason — the parcel header states the mode, so repeating it per line is
  // noise. Same flag, same intent.
  const packable = !ordShipsNothing(o);
  // Items grouped into parcels render in their shipment card. Anything NOT in a
  // parcel — a pending order before its parcels are assigned, a pickup order
  // (no shipments at all), or an orphaned row — would otherwise vanish from the
  // drawer (taking its dressing/extras with it). Render those in a fallback
  // block so EVERY ordered line + its options always shows, in every status.
  const inParcel = new Set();
  ships.forEach(s => (s.items || []).forEach(it => inParcel.add(it.id)));
  const loose = (o.items || []).filter(it => !inParcel.has(it.id));
  // Loose lines carry the same mark as parcelled ones — a pickup order parks on
  // a restock exactly like a courier order, and it has no shipment card at all.
  const looseWaiting = new Set(awaitingRestockPids(o));
  let looseHtml = '';
  if (loose.length) {
    looseHtml = ships.length
      ? `<div class="shipment-card"><div class="shipment-head">
           <span class="mode-pill"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7l8.7 5 8.7-5"/><path d="M12 22V12"/></svg>Not yet in a parcel · 待分配</span>
           <span class="count">${cuT(`${loose.length} item${loose.length === 1 ? '' : 's'}`, `${loose.length} 件商品`)}</span>
         </div>${renderItemsTable(loose, packable, looseWaiting)}</div>`
      : renderItemsTable(loose, packable, looseWaiting);   // pickup / no-parcel order: plain list
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

// Items render as a numbered packing manifest, per shipment. Sort order is
// preserved from sortOrderItems so the Packaging / SKU / Shipping chips still
// re-order the list.
// `waiting` is a Set of product_ids the order is parked on (empty for every
// order not in 'awaiting_restock' — see awaitingRestockPids).
function renderItemsTable(items, showPack = true, waiting = null) {
  const sorted = sortOrderItems(items, _ITEMS_SORT_MODE);
  return `<div class="manifest">
    ${sorted.map((it, i) => renderItemRow(it, {
      showPack, index: i + 1,
      waiting: !!(waiting && waiting.has(it.product_id)),
    })).join('')}
  </div>`;
}

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

// Monochrome line icons for shipment modes — inherit currentColor so they sit
// flat in the muted admin chrome (colour emoji clashed; see sort-chip note).
function shipGlyph(mode) {
  const open = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex:none">';
  if (mode === 'air')
    return open + '<path d="M21 15.5 13 13V6a1 1 0 0 0-2 0v7l-8 2.5V17l8-1.5V20l-2.5 1.5V23L12 22l3.5 1.5V21.5L13 20v-4.5l8 1.5z"/></svg>';
  if (mode === 'local')
    return open + '<path d="M4 11l8-6 8 6"/><path d="M6 10v9h12v-9"/></svg>';
  if (mode === 'supplier')
    // A parcel cube with an arrow leaving it — "ships from elsewhere, straight out".
    return open + '<path d="M4 9l8-4 8 4v6l-8 4-8-4z"/><path d="M9 12l6-6"/><path d="M11 5.5h4.5V10"/></svg>';
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

// While an order is parked on a restock, "Not shipped" is TRUE but useless: it
// reads as "nobody has got to it yet" when the real reason is that stock has not
// landed. Name the hold instead — but only on the parcels that actually carry a
// short line, and only while the parcel is still pending. A parcel already on
// its way keeps its own state; that is what the operator is tracking.
function shipHoldPill(o, s, waiting) {
  const state = s.state || 'pending';
  const held = (waiting && waiting.size && state === 'pending')
    ? (s.items || []).filter(it => waiting.has(it.product_id)).length
    : 0;
  if (!held) return shipmentStatePill(s);
  return `<span class="pill st-awaiting_restock"><span class="dot"></span>`
    + `${cuT(`Held — ${held} line${held === 1 ? '' : 's'} waiting`, `待补货 — ${held} 项`)}</span>`;
}

// Render one shipment block: header pill + items table + tracking row.
function renderShipmentCard(o, s) {
  const mode = s.mode || 'local';
  // Mode label is plain text — the card IS a shipment, so the ✈/🚚 glyphs were
  // noise (dropped). Local/supplier keep their descriptive words.
  const labelMap = {
    air:      'Air · 空运',
    land:     'Land · 陆运',
    local:    'Local delivery · 同城配送',
    supplier: 'Supplier-direct · 供应商直发',
  };
  // Product count vs. unit count: warehouse cross-checks the physical pick
  // against total units, so surface units whenever a multi-qty line makes
  // them diverge from the product count (e.g. "4 products · 6 units").
  const lines = s.items.length;
  const units = (s.items || []).reduce((n, it) => n + (Number(it.qty) || 0), 0);
  const countLabel = units !== lines
    ? `<span data-lang-block="en">${lines} product${lines === 1 ? '' : 's'} · ${units} units</span><span data-lang-block="cn">${lines} 款 · ${units} 件</span>`
    : `<span data-lang-block="en">${lines} product${lines === 1 ? '' : 's'}</span><span data-lang-block="cn">${lines} 款</span>`;
  const state = s.state || 'pending';
  const waiting = new Set(awaitingRestockPids(o));
  // Per-shipment dispatch is offered once the order is paid (or later) and this
  // parcel hasn't shipped. The order being 'dispatched' doesn't block it — a
  // partially-shipped order keeps un-shipped parcels actionable.
  // A supplier parcel is never "dispatched" from our warehouse — it ships from
  // the supplier and is marked shipped by entering its tracking number instead.
  const canDispatch = state === 'pending' &&
    mode !== 'supplier' &&
    ['paid', 'preparing', 'dispatched'].includes(o.status) &&
    !ordShipsNothing(o);
  // With a single parcel the per-parcel dispatch button just duplicates the
  // header "Mark dispatched" (which dispatches the whole order = this one
  // parcel). Only show the per-parcel button once the order actually has 2+
  // parcels, where it's needed to ship them independently.
  const showParcelDispatch = canDispatch && (o.shipments?.length || 0) > 1;
  // "Ship part later" splits this parcel in two. Only meaningful when the
  // parcel is still pending and holds 2+ lines (must leave one behind).
  const canSplit = state === 'pending' && lines >= 2;
  const actions = (showParcelDispatch || canSplit) ? `
      <div class="row" style="gap:8px; flex-wrap:wrap; margin-top: var(--s3);">
        ${showParcelDispatch ? `<button class="btn btn-primary btn-sm" onclick="dispatchShipment(${o.id}, ${s.id})">Mark this parcel dispatched · 标记此包裹已发货</button>` : ''}
        ${canSplit ? `<button class="btn btn-sm" onclick="toggleSplitPanel(${s.id})">Ship part later · 分批发货</button>` : ''}
      </div>
      ${canSplit ? renderSplitPanel(o, s) : ''}` : '';
  return `
    <div class="shipment-card mode-${mode}">
      <div class="shipment-head">
        <span class="mode-pill mode-${mode}">${labelMap[mode] || s.label}</span>
        <span class="count">${countLabel}</span>
        ${shipHoldPill(o, s, waiting)}
      </div>
      ${renderItemsTable(s.items, false, waiting)}
      ${actions}
      ${mode === 'local'
        ? (!['dispatched', 'delivered'].includes(s.state || 'pending') && ['paid', 'preparing'].includes(o.status) && !courierCardHoisted(o, s) ? renderLocalEtaCard(o, s) : '')
        : ''}
      ${(mode === 'land' && o.gz_method_toggle)
        ? (!['dispatched', 'delivered'].includes(s.state || 'pending') && ['paid', 'preparing'].includes(o.status) ? renderShipmentTrackingCard(o, s) : '')
        : ''}
      ${mode === 'supplier' ? renderSupplierTrackingBlock(o, s) : ''}
    </div>`;
  // Carrier tracking for a dispatched/delivered parcel is NOT rendered here —
  // it's hoisted to the top of the drawer (hoistedTracking) so the operator can
  // add a waybill + watch status the moment the order ships, no scrolling.
  // Local same-city parcels do the same once dispatched: their ETA card hoists
  // to the top (it's the rider's arrival time the operator watches). Before
  // dispatch (paid/preparing) it stays inline here so the time can be set early.
}

// Once a parcel is on its way, the thing the operator watches — its waybill, or
// for a same-city parcel the rider's arrival time — is lifted out of the buried
// items section up to the top of the drawer, directly under the status actions.
// Carrier parcels hoist their tracking card; local (Guangzhou same-city) parcels
// hoist their ETA card. Multi-parcel orders stack one card per shipped parcel,
// each labelled. Returns '' when nothing is shipped yet.
// A rider booked on a same-city parcel — still being found, on the way to collect,
// or already carrying it — is the live thing the operator watches, even while
// staff haven't marked the parcel dispatched yet. In that state the courier card
// (rider, map, ETA) hoists to the top of the drawer instead of sitting buried
// under the items table, and the inline copy inside the shipment card is dropped
// so it isn't rendered twice.
// All three in-flight stages hoist, heading_to_pickup ("Rider coming") included:
// a rider riding to the store is the moment staff most need the card — that's
// when the parcel has to be ready and the rider's phone number reachable. Leaving
// it out made the card fall back down the drawer the instant a rider accepted,
// then jump back up after pickup.
// Only the FIRST local parcel takes it: o.courier is one job for the whole order
// and its card carries order-scoped DOM ids (the map mount, the carrier list).
function courierCardHoisted(o, s) {
  if ((s.mode || 'local') !== 'local') return false;
  if (['dispatched', 'delivered'].includes(s.state || 'pending')) return false;
  if (!['awaiting_dispatch', 'heading_to_pickup', 'in_transit'].includes(o.courier?.stage)) return false;
  const all = o.shipments || [];
  return all.findIndex(x => (x.mode || 'local') === 'local') === all.indexOf(s);
}

function hoistedTracking(o) {
  const all = o.shipments || [];
  const multi = all.length > 1;
  const cards = all.map((s, i) => {
    const mode = s.mode || 'local';
    // Supplier parcels render their own tracking card inline (always visible,
    // even before "dispatch"), so they're never hoisted here.
    if (mode === 'supplier') return '';
    if (!['dispatched', 'delivered'].includes(s.state || 'pending') && !courierCardHoisted(o, s)) return '';
    // Fold the shipping mode into the parcel label so it's self-identifying —
    // "Parcel 2 · Land" tells the two parcels apart (air is faster + drives the
    // perishable-delay warning) far better than a bare number. cuT single-lang
    // to match the label. (Supplier is filtered out above; local hoists an ETA
    // card, but still gets the word so its rider parcel reads distinct.)
    const modeWord = mode === 'air'   ? cuT('Air', '空运')
                   : mode === 'land'  ? cuT('Land', '陆运')
                   : mode === 'local' ? cuT('Same-city', '同城')
                   : '';
    const label = multi
      ? `<div class="od-trk-parcel">${cuT(`Parcel ${i + 1}`, `包裹 ${i + 1}`)}${modeWord ? ` <span class="od-trk-parcel-mode">· ${modeWord}</span>` : ''}</div>`
      : '';
    // Local same-city: no waybill — hoist the arrival-time (ETA) card instead.
    return label + (mode === 'local'
      ? renderLocalEtaCard(o, s, true)
      : renderShipmentTrackingCard(o, s, true));
  }).filter(Boolean);
  if (!cards.length) return '';
  return `<div class="od-tracking-top">${cards.join('')}</div>`;
}

// GZ outer-district orders (花都/番禺/南沙/从化/增城/白云) can go out by either a
// same-city rider (local ETA) or JD logistics (waybill). Server flags this on
// o.gz_method_toggle. The toggle sits at the top of whichever card is showing
// and flips the parcel's mode, swapping the card underneath it. Hidden for
// central districts (rider-only), other modes (air/supplier), and delivered
// parcels (too late to re-route).
function renderGzMethodToggle(o, s) {
  if (!o.gz_method_toggle) return '';
  const mode = s.mode || 'local';
  if (!['local', 'land'].includes(mode)) return '';
  if ((s.state || 'pending') === 'delivered') return '';
  const isLocal = mode === 'local';
  // Segmented control (not two buttons): one cream track, active side = ink pill.
  // The active option is disabled so it can't be re-picked — CSS forces opacity:1
  // so it never reads as a greyed-out/disabled slab.
  const seg = (active, target, icon, en, cn) =>
    `<button type="button" class="od-seg-opt ${active ? 'on' : ''}"
       ${active ? 'aria-pressed="true" disabled' : `onclick="setShipmentMethod(${o.id}, ${s.id}, '${target}', event)"`}>
       ${deliveryIcon(icon, 14)}<span>${cuT(en, cn)}</span></button>`;
  return `
    <div style="margin-bottom: var(--s3);">
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-3); margin-bottom: var(--s2);">${cuT('Dispatch method', '配送方式')}</div>
      <div class="od-seg">
        ${seg(isLocal, 'local', 'scooter', 'Rider', '骑手配送')}
        ${seg(!isLocal, 'land', 'van', 'JD logistics', '京东物流')}
      </div>
    </div>`;
}

// Local (Guangzhou same-city) delivery has no waybill, so it gets an ETA card
// instead of the carrier tracking card: the operator picks a same-day arrival
// time the customer sees on their order page. Stored on the shipment row as a
// 24h "HH:MM" string. Editable from 'paid' onward (the rider's arrival window
// is usually known before the parcel is marked out for delivery).
function renderLocalEtaCard(o, s, hoisted) {
  const sid = s.id;
  const eta = s.local_eta || '';            // 'HH:MM' 24h, or '' when unset
  const pretty = eta ? formatEtaPretty(eta) : '';
  // When the Qingyun daemon has stamped the courier's promised arrival, the ETA
  // is filled and kept fresh automatically — the operator no longer types it.
  // eta_source='auto' marks that; the manual picker is tucked behind a toggle so
  // staff can still override (an override flips the row to 'manual' server-side).
  const isAuto = eta && s.eta_source === 'auto';
  // The auto ETA is the COURIER's promised arrival, stamped once from Qingyun's
  // expectedDeliveredTime and never revised when the courier runs late. It is a bare
  // 'HH:MM' carrying no date, so an hour-old promise rendered exactly like a live
  // one: "10:00 AM" still sitting here at 11:00 with the rider not yet at the store.
  // Tag it rather than hide it — staff still need the number, they just must not
  // read it as a commitment that still stands. GZ wall-clock via gzParts/gzWall so an
  // operator in another timezone reads the same clock as the store, for the same
  // reason slot urgency does. Closed orders are exempt (vocabulary rule 3: a settled
  // order must not carry a live promise, and it must not cry OVERDUE either).
  const etaLapsed = (() => {
    if (!isAuto) return false;
    // ONLY the settled statuses. Not 'dispatched' — that is exactly when an arrival
    // promise is live, and suppressing it there would silence the tag in the one
    // window it matters. (The ship-by kicker does exempt 'dispatched', but its
    // deadline was to SHIP, which by then has happened; this one is to ARRIVE.)
    if (['delivered', 'cancelled', 'refunded'].includes(o.status)) return false;
    const now = new Date();
    // The deadline is the END of the customer's window, never its start — the same
    // anchor the orders list has always used. This matters because `eta` is NOT an
    // independent courier estimate: scheduled_for holds only the window START, we push
    // that single instant to Qingyun as expectFrom AND expectTo, and the daemon stamps
    // what Qingyun echoes back. So on a "10:00–12:00" order `eta` is 10:00, and
    // comparing against it called the order late at 10:01 — two hours early, while the
    // customer was still inside the window they chose.
    const start = parseSchedFor(o.scheduled_for);
    const winEnd = isNaN(start.getTime()) ? null : parseSlotEnd(start, o.delivery_slot_label);
    if (winEnd) return winEnd.getTime() < now.getTime();
    // No window in the label — fall back to the stamped clock, read by slice exactly
    // as the picker above does. (This was a regex; an escaping slip ate its character
    // classes, so it matched the literal text "dd:dd" and never fired at all.)
    if (eta.length !== 5 || eta.charAt(2) !== ':') return false;
    const hh = Number(eta.slice(0, 2)), mm = Number(eta.slice(3, 5));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
    const g = gzParts(now);
    return gzWall(g.y, g.mo, g.da, hh, mm).getTime() < now.getTime();
  })();
  // Inline (under the items) it sits below a dashed divider; hoisted to the top
  // of the drawer it stands on its own, so drop the divider/top margin there.
  const wrapStyle = hoisted ? '' : 'margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line-soft);';
  // The manual picker markup — a brand-native segmented time field (HH : MM +
  // AM/PM toggle) instead of the raw OS <input type=time>. A hidden input keeps
  // the stored "HH:MM" 24h value in sync (qyEtaSync), so saveLocalEta is untouched.
  // Shown outright when there's no auto ETA, or collapsed inside a <details>
  // under the auto display as the override path.
  const h24n = eta ? parseInt(eta.slice(0, 2), 10) : null;
  const etaMin = eta ? eta.slice(3, 5) : '';
  const etaH12 = h24n == null ? '' : String((h24n % 12) || 12).padStart(2, '0');
  const etaAp = h24n != null && h24n >= 12 ? 'PM' : 'AM';
  const picker = `
      <div class="row" style="gap:10px; align-items:center; flex-wrap:wrap;">
        <span class="eta-timefield">
          <svg class="eta-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          <input class="eta-seg" id="eta-h-${sid}" type="text" inputmode="numeric" maxlength="2" value="${etaH12}" placeholder="12" oninput="qyEtaSync(${sid})" aria-label="Hour · 时">
          <span class="eta-colon">:</span>
          <input class="eta-seg" id="eta-m-${sid}" type="text" inputmode="numeric" maxlength="2" value="${etaMin}" placeholder="00" oninput="qyEtaSync(${sid})" aria-label="Minute · 分">
          <span class="eta-ampm" id="eta-ampm-${sid}" data-v="${etaAp}">
            <button type="button" class="${etaAp === 'AM' ? 'on' : ''}" onclick="qyEtaAmpm(${sid}, 'AM')">AM</button>
            <button type="button" class="${etaAp === 'PM' ? 'on' : ''}" onclick="qyEtaAmpm(${sid}, 'PM')">PM</button>
          </span>
        </span>
        <input type="hidden" id="eta-time-${sid}" value="${escapeHtml(eta)}">
        <button class="btn ${eta ? 'btn-primary' : ''} btn-sm" onclick="saveLocalEta(${o.id}, ${sid}, event)">${eta ? 'Update time · 更新时间' : 'Set arrival time · 设置送达时间'}</button>
        ${eta ? `<button class="btn btn-sm" onclick="clearLocalEta(${o.id}, ${sid}, event)">Clear · 清除</button>` : ''}
      </div>`;
  // ── Delivery time block ─────────────────────────────────────────────
  // The arrival time is filled in automatically by the courier once a rider
  // is booked, so it reads as a quiet confirmation, not an input. Three cases:
  //   auto  → read-only "estimated arrival" chip + manual override tucked away
  //   set   → the picker, pre-filled, with a "shown to customer" note
  //   unset → the picker, empty (staff can set a time up-front if they want)
  const timeBlock = `
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-3); margin-bottom: var(--s2);">Delivery time · 送达时间</div>
      ${isAuto ? `
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:10px 12px; background: var(--bg-elev-1); border-radius:6px; margin-bottom:10px;">
          <div>
            <div style="font-size:12px; color:var(--text-3);">ETA · 预计送达</div>
            <div style="font-family: var(--f-mono); font-weight:600; font-size:15px;">${escapeHtml(pretty)}${etaLapsed
              ? ` <b style="color:var(--danger); font-family:var(--f-sans); font-size:11px; letter-spacing:.04em;">${cuT('OVERDUE', '已逾期')}</b>`
              : ''}</div>
          </div>
          <div style="flex:1; min-width:120px; text-align:right;">
            <span class="muted" style="font-size:11px;">Set by the courier · 来自骑手,自动</span>
          </div>
        </div>
        <details style="margin-bottom:4px;">
          <summary style="font-size:12px; cursor:pointer; color:var(--text-3);">Set a time manually · 手动设置时间</summary>
          <div style="margin-top:8px;">${picker}</div>
        </details>`
      : `${picker}${eta ? `<div class="muted" style="font-size:11px; margin-top:8px;">Shown to the customer · 已展示给顾客</div>` : ''}`}`;

  // Order top-to-bottom: method toggle → same-city courier (compare/dispatch) →
  // delivery time. The courier picker leads because the arrival time follows from
  // whichever rider is booked; the time block sits below its own dashed divider.
  return `
    <div style="${wrapStyle}" id="eta-card-${sid}">
      ${renderGzMethodToggle(o, s)}
      ${renderQyDispatch(o)}
      <div style="margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line-soft);">
        ${timeBlock}
      </div>
    </div>`;
}

// ── Same-city courier (Qingyun) live status ────────────────────────────────
// The Qingyun daemon writes the real rider stage into delivery_jobs every ~25s;
// the server hands it to the drawer as o.courier. heading_to_pickup vs in_transit
// is read off deliveryStatus server-side (see routes/retail.js deliveryJobStage) —
// a rider can be assigned and moving well before they've actually collected the
// parcel, so "On the way" must wait for the pickup, not just the assignment.
// These mirror what the customer already sees in the mini-app.
const COURIER_STAGE = {
  awaiting_dispatch: { en: 'Finding a rider', cn: '正在找骑手',   dot: '#9A6E2A' },
  heading_to_pickup: { en: 'Rider coming',    cn: '骑手前往取货', dot: '#4A72B0' },
  in_transit:        { en: 'On the way',      cn: '配送中',       dot: '#5C7A4E' },
  delivered:         { en: 'Delivered',       cn: '已送达',       dot: '#5C7A4E' },
};

// SQLite hands naive UTC ("YYYY-MM-DD HH:MM:SS", no zone); a bare new Date()
// reads it as LOCAL, so in China (UTC+8) a fresh row would show "8h ago".
// Normalise naive strings to UTC before diffing.
function courierAgeMs(iso) {
  if (!iso) return Infinity;
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(iso);
  const t = new Date(hasZone ? iso : String(iso).replace(' ', 'T') + 'Z').getTime();
  return isNaN(t) ? Infinity : Date.now() - t;
}
function courierAgo(iso) {
  const diff = courierAgeMs(iso);
  if (!isFinite(diff))  return '';
  if (diff < 60000)     return cuT('just now', '刚刚');
  if (diff < 3600000)   return cuT(Math.floor(diff / 60000) + 'm ago', Math.floor(diff / 60000) + ' 分钟前');
  if (diff < 86400000)  return cuT(Math.floor(diff / 3600000) + 'h ago', Math.floor(diff / 3600000) + ' 小时前');
  return cuT(Math.floor(diff / 86400000) + 'd ago', Math.floor(diff / 86400000) + ' 天前');
}
// A live delivery whose row hasn't refreshed in this long is suspect — the
// daemon polls every ~25s, so a frozen "on the way" order (10 min+) has likely
// dropped off Qingyun's active list (a rider cancel / drop). We can't yet PROVE
// a cancel (Qingyun's cancel signal isn't captured), so we warn + reopen dispatch
// rather than assert it. See routes/retail.js deliveryJobStage.
const COURIER_STALE_MS = 10 * 60 * 1000;

// Header status pill — for a same-city courier order, show the REAL rider stage
// instead of a premature "Dispatched" (that flag flips when staff mark the order
// shipped, BEFORE a rider is even on it). Falls back to the plain order status
// when there's no live courier job (JD parcel, off-system courier, non-local).
function orderStatusPill(o) {
  const c = o.courier;
  // A live same-city courier job (o.courier) is the ground truth of where the
  // parcel physically is, and the order's own status can lag it in BOTH directions:
  //   • our 'dispatched' flag flips when staff mark the order shipped — before a
  //     rider is even on it — so it can read AHEAD of "finding a rider".
  //   • a Meituan mirror's 'rider_pickup' ("Rider coming") is driven by Meituan's
  //     status poll, which trails the Qingyun/JD rider by many minutes — and the
  //     auto-deliver sweep only advances our own paid/preparing/dispatched orders,
  //     never Meituan's rider_pickup — so it can read BEHIND, still saying "Rider
  //     coming" over a parcel the rider dropped off long ago.
  // Reconcile against the courier stage so the header pill can't contradict the
  // live rider card rendered right below it. Terminal order states we own
  // (cancelled/refunded) win outright and are never overridden.
  if (c && o.status !== 'cancelled' && o.status !== 'refunded') {
    // Rider has dropped off — never keep showing "Rider coming"/"Dispatched".
    if (c.stage === 'delivered' && o.status !== 'delivered')
      return { cls: 'st-delivered', label: humanStatus('delivered', o.fulfillment_type) };
    // In-flight: surface the real rider stage for our own orders (including ones
    // still marked 'preparing' — staff can dispatch a rider before clicking
    // "Mark dispatched", so the courier job can outrun our own status) and
    // Meituan's "Rider coming" mirrors.
    if (o.status === 'dispatched' || o.status === 'rider_pickup' || o.status === 'preparing') {
      if (c.stage === 'awaiting_dispatch') return { cls: 'st-preparing',    label: cuT('Finding a rider', '正在找骑手') };
      if (c.stage === 'heading_to_pickup') return { cls: 'st-rider_pickup', label: cuT('Rider coming', '骑手前往取货') };
      if (c.stage === 'in_transit')        return { cls: 'st-dispatched',  label: cuT('On the way', '配送中') };
    }
  }
  return { cls: 'st-' + o.status, label: humanStatus(o.status, o.fulfillment_type) };
}

// Live rider card for the drawer. Only rendered once a courier is on the job (or
// being sought) — a 'scheduled' order (pre-pushed, not dispatched) shows nothing.
// `stale` = an "on the way" order whose row has frozen (likely a rider cancel /
// drop); we warn instead of trusting the last-seen rider position.
function renderCourierStatusCard(o, c, meta, stale, delivered) {
  const rider = c.rider
    ? `<div style="font-size:12px; margin-top:5px;" data-no-i18n>
         <b>${escapeHtml(c.rider.name)}</b>${c.rider.phone ? ` · <a href="tel:${escapeAttr(c.rider.phone)}" style="color:var(--brand);">${escapeHtml(c.rider.phone)}</a>` : ''}
       </div>`
    : '';
  // ETA + distance — only meaningful while a rider is actually moving, and never
  // once the row has gone stale (the numbers would be a frozen snapshot) or the
  // order is already delivered (a delivered row's frozen "~5 min away" is a lie).
  const bits = [];
  // eta_seconds means "time to the STORE" while heading_to_pickup and "time to the
  // CUSTOMER" while in_transit — different legs, so word it accordingly rather than
  // always saying "away" (which implies away from the customer).
  if (c.stage === 'in_transit' && !stale && !delivered && c.eta_seconds != null)
    bits.push(cuT(`~${Math.max(1, Math.round(c.eta_seconds / 60))} min away`, `约 ${Math.max(1, Math.round(c.eta_seconds / 60))} 分钟`));
  if (c.stage === 'heading_to_pickup' && !stale && !delivered && c.eta_seconds != null)
    bits.push(cuT(`~${Math.max(1, Math.round(c.eta_seconds / 60))} min to store`, `约 ${Math.max(1, Math.round(c.eta_seconds / 60))} 分钟到店`));
  if ((c.stage === 'in_transit' || c.stage === 'heading_to_pickup') && !stale && !delivered && c.rider_to_cust_m != null)
    bits.push(c.rider_to_cust_m >= 1000 ? (c.rider_to_cust_m / 1000).toFixed(1) + ' km' : Math.round(c.rider_to_cust_m) + ' m');
  const etaLine = bits.length ? `<div class="muted" style="font-size:11px; margin-top:5px;">${bits.join(' · ')}</div>` : '';
  const carrier = c.carrier ? `<span class="muted" style="font-size:11px; margin-left:auto;" data-no-i18n>${escapeHtml(c.carrier)}</span>` : '';
  // Stale → amber warning + amber dot; otherwise the stage's own colour.
  const dot = stale ? '#9A6E2A' : meta.dot;
  const staleLine = stale
    ? `<div style="display:flex; align-items:flex-start; gap:5px; font-size:11px; font-weight:600; margin-top:7px; color:#9A6E2A;">${deliveryIcon('alert', 12)}<span>${cuT(
        "Not updating — the rider may have cancelled. Check the courier or call another.",
        '状态未更新 — 骑手可能已取消,请核实或另叫一位。')}</span></div>`
    : '';
  const ago = courierAgo(c.updated_at);
  // Live rider map — only while a rider is genuinely moving (in_transit, not
  // stale, not delivered), which is exactly when a rider position exists to plot.
  // The container is filled by mountCourierMap() after the drawer renders; it
  // loads AMap on demand and polls the admin track endpoint every ~25s.
  const showMap = (c.stage === 'in_transit' || c.stage === 'heading_to_pickup') && !stale && !delivered;
  const mapEl = showMap
    ? `<div id="courier-map-${o.id}" class="courier-map" aria-label="${cuT('Live rider location', '骑手实时位置')}"
           style="height:180px; margin-bottom:10px; border-radius:8px; overflow:hidden; position:relative; background:var(--bg-elev-2, #ECEAE3);">
         <div class="muted" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:11px;">${cuT('Loading map…', '正在加载地图…')}</div>
       </div>`
    : '';
  return `
    <div style="padding:10px 12px; background: var(--bg-elev-1); border-radius:6px; margin-bottom:8px;">
      ${mapEl}
      <div style="display:flex; align-items:center; gap:7px;">
        <span style="background:${dot}; width:8px; height:8px; border-radius:50%; flex:none;"></span>
        <b style="font-size:13px;">${cuT(meta.en, meta.cn)}</b>
        ${carrier}
      </div>
      ${rider}
      ${etaLine}
      ${staleLine}
      ${ago ? `<div class="muted" style="font-size:10px; margin-top:6px;">${cuT('Updated', '更新于')} ${ago}</div>` : ''}
    </div>`;
}

// ── Live rider map (高德 AMap) in the courier card ──────────────────────────
// Staff see the rider dot move from store to door without calling to ask. The
// coordinates come from the admin delivery-track endpoint (same courier feed the
// mini-app map uses). AMap is loaded on demand — the admin bundle never carries
// the SDK until a live delivery drawer needs it — and re-polled every ~25s (the
// daemon's cadence) while the drawer stays open, torn down on close / switch.
let _courierMap = null;   // active map controller, or null
let _amapSdkP  = null;    // memoised SDK-load promise (reset on failure so a
                          // network blip doesn't permanently poison it)

function _adminLoadAmapOnce() {
  return (async () => {
    let cfg = null;
    try { cfg = (await api('/api/retail/maps-config')).data; } catch (e) { cfg = null; }
    if (!cfg || cfg.provider !== 'amap' || !cfg.key) throw new Error('no_amap');
    if (window.AMap) return;
    if (cfg.security) window._AMapSecurityConfig = { securityJsCode: cfg.security };
    await new Promise((resolve, reject) => {
      const cb = '__adminMapReady';
      window[cb] = () => resolve();
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(cfg.key) + '&callback=' + cb;
      s.onerror = () => reject(new Error('sdk_load_failed'));
      document.head.appendChild(s);
    });
  })();
}
function _adminLoadAmap() {
  if (_amapSdkP) return _amapSdkP;
  _amapSdkP = _adminLoadAmapOnce().catch((e) => { _amapSdkP = null; throw e; });
  return _amapSdkP;
}

function teardownCourierMap() {
  if (!_courierMap) return;
  try { clearInterval(_courierMap.timer); } catch (e) {}
  try { _courierMap.map && _courierMap.map.destroy(); } catch (e) {}
  _courierMap = null;
}

// A labelled point marker as AMap HTML content. The RIDER is the point that
// matters (it's the one moving), so it's drawn large, brick-red with a soft halo
// and a solid label pill; the fixed store/customer points stay small and muted so
// the rider is unmistakable at a glance. opts: { color, size, halo, pill, ring }.
function _courierMarkerHtml(label, opts) {
  opts = opts || {};
  const color = opts.color || '#58606E';
  const size  = opts.size || 11;
  const halo  = opts.halo
    ? '<div style="position:absolute; left:50%; top:50%; width:' + (size * 2.6) + 'px; height:' + (size * 2.6) + 'px; transform:translate(-50%,-50%); border-radius:50%; background:' + color + '; opacity:.2;"></div>'
    : '';
  // Customer is a hollow ring (paper fill, coloured border) so its shape differs
  // from the solid store dot even before you read the label.
  const dotBg     = opts.ring ? '#FBF9F4' : color;
  const dotBorder = opts.ring ? ('3px solid ' + color) : '2.5px solid #FBF9F4';
  const labelStyle = opts.pill
    ? 'font:600 10.5px/1 Inter,sans-serif; color:#fff; background:' + color + '; padding:3px 8px; border-radius:999px; white-space:nowrap; box-shadow:0 2px 5px rgba(17,26,43,.35);'
    : 'font:600 10px/1 Inter,sans-serif; color:' + color + '; white-space:nowrap; text-shadow:0 1px 2px rgba(251,249,244,.95);';
  // A glyph (e.g. a scooter for the rider) sits inside the dot, in paper white.
  const glyph = opts.glyph
    ? '<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#FBF9F4;">' + opts.glyph + '</div>'
    : '';
  return '<div style="display:flex; flex-direction:column; align-items:center; gap:3px;">'
    + '<div style="' + labelStyle + '">' + label + '</div>'
    + '<div style="position:relative; width:' + size + 'px; height:' + size + 'px; display:flex; align-items:center; justify-content:center;">'
    +   halo
    +   '<div style="position:relative; width:' + size + 'px; height:' + size + 'px; border-radius:50%; background:' + dotBg + '; border:' + dotBorder + '; box-shadow:0 1px 3px rgba(17,26,43,.4);">' + glyph + '</div>'
    + '</div>'
    + '</div>';
}

async function mountCourierMap(o) {
  teardownCourierMap();                                   // drop any prior map first
  const el = document.getElementById('courier-map-' + o.id);
  if (!el) return;                                        // no live rider → no container
  let sdkOk = true;
  try { await _adminLoadAmap(); } catch (e) { sdkOk = false; }
  if (!document.body.contains(el)) return;                // drawer closed/switched while loading
  if (!sdkOk || !window.AMap) {
    el.innerHTML = '<div class="muted" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:0 12px; font-size:11px;">'
      + cuT('Map unavailable — rider details are below.', '地图暂不可用 — 骑手信息见下方') + '</div>';
    return;
  }
  const state = { orderId: o.id, map: null, timer: null, rider: null, shop: null, cust: null, line: null, fitted: false };
  _courierMap = state;
  // Built on the first payload that carries a coordinate, NOT up front. An AMap.Map
  // constructed with no `center` falls back to a view of its own choosing, and a
  // payload whose position fields were all momentarily null left it sitting on that
  // view: a Guangzhou order's drawer showed a map ~700km away in Hunan, under a
  // "Locating rider…" chip. A map with nothing to anchor on must stay a placeholder —
  // the "Loading map…" text is a truthful thing to show, an unrelated province is not.
  const ensureMap = (anchor) => {
    if (state.map || !anchor) return state.map;
    el.innerHTML = '';                                    // clear the "Loading…" placeholder
    state.map = new AMap.Map(el, { zoom: 15, resizeEnable: true, jogEnable: false,
                                   center: [anchor.lng, anchor.lat] });
    return state.map;
  };

  const setMarker = (cur, pos, opts, label, z) => {
    if (!pos || !state.map) return cur;
    const lnglat = [pos.lng, pos.lat];
    if (cur) { cur.setPosition(lnglat); return cur; }
    const mk = new AMap.Marker({ position: lnglat, content: _courierMarkerHtml(label, opts), anchor: 'center', zIndex: z });
    mk.setMap(state.map);
    return mk;
  };
  const apply = (d) => {
    if (!d || !d.tracking) return;
    // Any coordinate at all, in preference order. route[0] is the store end of
    // Qingyun's own route line and is present whenever tracking is, so it is the
    // backstop that keeps the map anchored when every marker field reads null.
    const anchor = d.rider_position || d.recipient_position || d.shop_position
      || ((Array.isArray(d.route) && d.route.length) ? d.route[0] : null);
    const map = ensureMap(anchor);
    if (!map) return;                                     // nothing to anchor on yet
    state.shop  = setMarker(state.shop,  d.shop_position,      { color: '#58606E', size: 11 },                          cuT('Store', '门店'),    100);
    state.cust  = setMarker(state.cust,  d.recipient_position, { color: '#111A2B', size: 11, ring: true },              cuT('Customer', '收货'), 100);
    state.rider = setMarker(state.rider, d.rider_position,     { color: '#B4533E', size: 22, halo: true, pill: true, glyph: deliveryIcon('scooter', 13) }, cuT('Rider', '骑手'), 120);
    if (Array.isArray(d.route) && d.route.length > 1) {
      const path = d.route.map((p) => [p.lng, p.lat]);
      if (state.line) state.line.setPath(path);
      else {
        state.line = new AMap.Polyline({ path, strokeColor: '#6E67AF', strokeWeight: 4, strokeOpacity: 0.85, lineJoin: 'round', showDir: true });
        state.line.setMap(map);
      }
    }
    // Rider GPS is intermittent on some couriers (Meituan-dispatched Qingyun riders
    // in particular drop it between pings). When it's absent, say "locating rider"
    // instead of leaving a destination pin with no scooter.
    if (!d.rider_position && d.stage !== 'delivered') {
      if (!state.hint) {
        state.hint = document.createElement('div');
        state.hint.style.cssText = 'position:absolute; left:11px; top:11px; z-index:5; background:rgba(251,249,244,.94); border:1px solid #E4E0D5; border-radius:999px; padding:4px 10px; font:600 11px Inter,sans-serif; color:#8A6425; display:flex; align-items:center; gap:6px;';
        state.hint.innerHTML = '<span style="width:6px; height:6px; border-radius:50%; background:#C9954A;"></span>' + cuT('Locating rider…', '正在定位骑手…');
        el.appendChild(state.hint);
      }
    } else if (state.hint) { state.hint.remove(); state.hint = null; }

    if (!state.fitted) {
      // First paint: frame every point we have. With 2+ points fit them all; with a
      // single point (e.g. only the customer, before the rider GPS arrives) centre on
      // it so the map lands in the right city instead of AMap's default (Beijing).
      // With zero points, stay unfitted so a later poll that carries coords frames it.
      const pts = [state.shop, state.cust, state.rider].filter(Boolean);
      if (pts.length > 1) { try { map.setFitView(pts, false, [24, 24, 24, 24]); } catch (e) {} state.fitted = true; }
      else {
        if (anchor) { map.setZoomAndCenter(15, [anchor.lng, anchor.lat]); state.fitted = true; }
      }
    } else if (d.rider_position) {
      map.setCenter([d.rider_position.lng, d.rider_position.lat]);   // keep the rider centred as it moves
    }
  };
  const poll = async () => {
    if (_courierMap !== state) return;                    // superseded by a newer drawer
    try {
      const r = await api('/api/retail-admin/orders/' + o.id + '/delivery-track');
      if (_courierMap !== state) return;
      const d = r.data;
      // Keep polling while the order is genuinely in flight. A momentarily-absent
      // rider_position is NOT a stop signal (rider GPS blinks in and out) — only a
      // delivered / no-longer-tracking order ends the loop. apply() still runs so the
      // store + customer render and the "locating rider" hint shows meanwhile.
      if (!d || !d.tracking || d.stage === 'delivered') { clearInterval(state.timer); return; }
      apply(d);
    } catch (e) { /* transient — retry next tick */ }
  };
  await poll();                                           // first paint
  if (_courierMap === state) state.timer = setInterval(poll, 25000);
}

// Same-city courier dispatch (青云聚信) — compare live carrier prices and send a rider
// straight from here, instead of the Qingyun app. Only meaningful once the order is in
// Qingyun (auto-pushed as 待配送). Loads on demand (a click) so the drawer stays fast.
// Once a rider is actually on it, the live status card replaces the price picker.
function renderQyDispatch(o) {
  const c = o.courier;
  // Once the ORDER is delivered, the courier row froze at "on the way" only because
  // the finished job dropped off the courier's live in-flight list — that's normal,
  // not a cancel. Show it as Delivered (green, done) and never flag it stale.
  const delivered = !!(c && (o.status === 'delivered' || c.stage === 'delivered'));
  const meta = c && (delivered ? COURIER_STAGE.delivered : COURIER_STAGE[c.stage]);
  // A live "on the way" (or "coming to pick up") order whose row has frozen
  // (>10 min) is a likely cancel/drop — warn on the card and reopen the dispatch
  // button so staff can re-book.
  const stale = !delivered && !!(c && (c.stage === 'in_transit' || c.stage === 'heading_to_pickup')
    && courierAgeMs(c.updated_at) > COURIER_STALE_MS);
  const card = meta ? renderCourierStatusCard(o, c, meta, stale, delivered) : '';
  // Keep the compare/dispatch button while there's no rider yet (still looking,
  // or not dispatched), or when a live run has gone stale; hide it while a rider
  // is genuinely on the way — re-comparing mid-run is pointless. When finding a
  // rider or recovering from a stall, the button offers to call another courier.
  const finding = c && c.stage === 'awaiting_dispatch';
  const showCompare = !c || c.stage === 'scheduled' || finding || stale;
  const relabel = finding || stale;
  const compareBtn = showCompare
    ? `<button class="btn btn-sm" id="qy-get-${o.id}" onclick="qyLoadCarriers(${o.id}, this)">${cuT(relabel ? 'Call another courier' : 'Compare couriers', relabel ? '再叫一家运力' : '查看运力比价')}</button>`
    : '';
  return `
    <div style="margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line-soft);">
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-3); margin-bottom: var(--s2);">Same-city courier · 同城运力</div>
      ${card}
      ${renderQyShipFrom(o)}
      ${compareBtn}
      <div id="qy-carriers-${o.id}" style="margin-top:8px;"></div>
    </div>`;
}

// Where the rider collects this order. The routing rule picked the store at
// checkout and the order was created in that store's Qingyun account, whose shop
// address IS the pickup point — so this line is the only place staff can see it,
// and the only place they can move it. Shown for orders we created in Qingyun
// ourselves (server sends o.qingyun_ship_from only for those).
//
// Once a courier has been called the line goes read-only: a rider already heading
// for the old door can't be redirected from here, and we have no cancel API — that
// has to happen in the Qingyun app first.
// ── Confirm delivery point ──────────────────────────────────────────────────
// docs/tacet-delivery-point-confirmation-spec.md §5. The push could not place
// this address, so it parked instead of refusing, and an operator has to say
// where the door is.
//
// THE RULE THIS SURFACE ENFORCES: there is no point yet, so there is nothing to
// confirm. The map opens showing the AREA the address resolved to — a dashed
// circle, no pin — and the primary button is disabled reading "Place the
// point". Only once a point exists does it become "Confirm and dispatch".
//
// This is not a nudge gate. A gate that merely required interaction would be
// satisfied by a 1px twitch on a marker sitting at the district centre, and
// confirming that stamps staff_pin onto a centroid — which then passes both
// the accept rule and the distance predicate in lib/qingyun-payload. That is
// the laundering those checks exist to prevent, performed by a person instead
// of by code. Nothing to twitch, nothing to launder.
//
// D1 is untouched: a trusted point never parks, so no order that was already
// precise ever reaches this surface or pays for the extra tap.
function renderQyPointSurface(o, sf) {
  const expired  = sf.date_posture === 'passed';
  const tomorrow = sf.date_posture === 'tomorrow';
  const grade = sf.guess_grade || {};
  const addrLines = escapeHtml(o.address_full || '').split(' ').filter(Boolean).join('<br>');

  // An expired order cannot ship whatever point is placed, so it does not ask
  // for one. Different problem, different badge, different action (§5.2).
  if (expired) {
    return `
      <div class="qp" id="qp-${o.id}">
        <h3 class="qp-h">${cuT('Delivery date passed', '配送日期已过')}</h3>
        <p class="qp-sub">${cuT(
          `Nobody was sent for this order and ${sf.promised_date || 'the day it was promised for'} has gone. `
          + 'A same-day rider can no longer take it — pick a new day to put it back in the queue.',
          `此订单无人接单，${sf.promised_date || '承诺配送日'} 已过。同城骑手已无法配送，请选择新的配送日期重新排队。`)}</p>
        <div id="qp-resched-${o.id}"></div>
        <div class="qp-actions" id="qp-actions-${o.id}">
          <button class="btn btn-primary" type="button" onclick="qpOpenReschedule(${o.id}, this)">${cuT('Reschedule delivery', '改期配送')}</button>
          <button class="btn" type="button" onclick="openEditShipTo(${o.id})">${cuT('Edit ship-to', '修改收货信息')}</button>
        </div>
      </div>`;
  }

  return `
    <div class="qp" id="qp-${o.id}">
      <h3 class="qp-h">${cuT('Confirm delivery point', '确认配送点')}</h3>
      <p class="qp-sub">${cuT(
        'We could not place this address precisely. Check the point and confirm.',
        '无法精确定位该地址，请核对后确认配送点。')}</p>

      <div class="qp-grid">
        <div class="qp-map-col">
          <!-- Search MOVES THE MAP. It never places a point: picking a result
               recenters and zooms, and the operator still taps the door. The
               handle it reaches (qpMap) exposes setCenter/setZoom and nothing
               else, so this box is structurally unable to satisfy the confirm
               gate — §5's rule expressed as an API rather than as a discipline. -->
          <div class="qp-find" id="qp-find-wrap-${o.id}">
            <input class="qp-find-in" id="qp-find-${o.id}" type="text" inputmode="search"
                   autocomplete="off" spellcheck="false"
                   placeholder="${escapeHtml(cuT('Search a place or road', '搜索地点或道路'))}"
                   oninput="qpFindType(${o.id})"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();qpFindNow(${o.id});}">
            <div class="qp-find-out" id="qp-find-out-${o.id}" hidden></div>
          </div>
          <div class="qp-map" id="qp-map-${o.id}"></div>
          <!-- Describes the STATE, not the marker: before a placement there is
               no point to have moved. -->
          <div class="qp-state" id="qp-state-${o.id}">${cuT('No point placed yet', '尚未标记配送点')}</div>
        </div>
        <div class="qp-addr-col">
          <div class="kicker" style="font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px;">${cuT('Ship to', '收货地址')}</div>
          <div class="qp-addr" data-no-i18n>${addrLines}</div>
          <div class="qp-grade">${escapeHtml(cuT(grade.en || '', grade.cn || ''))}</div>
        </div>
      </div>

      ${tomorrow ? `
      <div class="qp-urgent">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        <div>${cuT(
          `<b style="font-weight:600;">Promised tomorrow, ${sf.promised_date || ''}.</b> Confirm the point today — after tonight this order can no longer go to a same-day rider.`,
          `<b style="font-weight:600;">明天(${sf.promised_date || ''})送达。</b> 请今天确认配送点 — 过了今晚将无法安排同城骑手。`)}</div>
      </div>` : ''}

      <div class="qp-actions">
        <button class="btn btn-primary" type="button" id="qp-go-${o.id}" disabled
                onclick="qpConfirmPoint(${o.id}, this)">${cuT('Place the point', '请标记配送点')}</button>
        <button class="btn" type="button" onclick="openEditShipTo(${o.id})">${cuT('Edit ship-to', '修改收货信息')}</button>
        <span class="qp-hint" id="qp-hint-${o.id}">${cuT('Tap the map where the door is.', '在地图上点选收货位置。')}</span>
      </div>
    </div>`;
}

// ── Pick a place ────────────────────────────────────────────────────────────
// The sibling of renderQyPointSurface above, for the other parked state. The
// name search found real places and could not choose between them, so the
// answer is already on the screen.
//
// THE RULE THIS SURFACE ENFORCES is the same one, arrived at from the other
// side: nothing is pre-selected. There is no default radio, no cheapest-style
// pre-tick, and no "confirm" button sitting under a highlighted row — because a
// pre-selection is a guess wearing a decision's clothes, and confirming one is
// exactly the laundering the pinless map exists to prevent, performed with a
// list instead of a marker. Each candidate carries its own action; choosing IS
// the confirm.
//
// No separate confirmation dialog, for the same reason the map surface has
// none: reading three places and picking one IS the deliberation, and a second
// modal asks the same question twice.
//
// What each row shows, and why all three earn their place:
//   name     — what the operator recognises. The whole point of a name search.
//   address  — how they tell two similarly-named estates apart; the names alone
//              often differ by one character.
//   distance — from the COLLECTING store, which is what catches the
//              right-name-wrong-district hit before a rider is paid for it. The
//              server's distance check will refuse it past 25km anyway, but by
//              then the operator has been told nothing; here they can see it.
function renderQyCandidateSurface(o, sf) {
  const expired = sf.date_posture === 'passed';
  // An expired order cannot ship whatever is picked, so it asks nothing and
  // reuses the reschedule surface verbatim (spec §5.2). Same reasoning as the
  // map surface: different problem, different badge, different action.
  if (expired) return renderQyPointSurface(o, sf);

  const tomorrow = sf.date_posture === 'tomorrow';
  const addrLines = escapeHtml(o.address_full || '').split(' ').filter(Boolean).join('<br>');
  const rows = (sf.candidates || []).map((c) => `
    <button class="qpc-opt" type="button" onclick="qpPickPlace(${o.id}, ${c.idx}, this)">
      <span class="qpc-opt-main">
        <span class="qpc-name" data-no-i18n>${escapeHtml(c.name || '')}</span>
        <span class="qpc-addr" data-no-i18n>${escapeHtml(c.address || '')}</span>
      </span>
      ${c.drop_km != null
        ? `<span class="qpc-km">${escapeHtml(String(c.drop_km))}km</span>`
        : ''}
    </button>`).join('');

  return `
    <div class="qp qpc" id="qp-${o.id}">
      <h3 class="qp-h">${cuT('Pick the delivery point', '选择配送点')}</h3>
      <p class="qp-sub">${cuT(
        'This address matches more than one place. Pick the right one.',
        '该地址匹配到多个地点，请选择正确的一个。')}</p>

      <div class="qp-grid">
        <div class="qp-map-col">
          <div class="qpc-list">${rows}</div>
          <div class="qpc-none">${cuT(
            'None of these is right?', '都不是?')}
            <button class="qpc-link" type="button" onclick="qpFallBackToMap(${o.id}, this)">${cuT(
              'Place the point on a map', '在地图上标记')}</button>
          </div>
        </div>
        <div class="qp-addr-col">
          <div class="kicker" style="font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px;">${cuT('Ship to', '收货地址')}</div>
          <div class="qp-addr" data-no-i18n>${addrLines}</div>
          <div class="qp-grade">${cuT(
            'Distances are from the store the rider collects from.',
            '距离为骑手取货门店到该地点的距离。')}</div>
        </div>
      </div>

      ${tomorrow ? `
      <div class="qp-urgent">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        <div>${cuT(
          `<b style="font-weight:600;">Promised tomorrow, ${sf.promised_date || ''}.</b> Pick the place today — after tonight this order can no longer go to a same-day rider.`,
          `<b style="font-weight:600;">明天(${sf.promised_date || ''})送达。</b> 请今天选择配送点 — 过了今晚将无法安排同城骑手。`)}</div>
      </div>` : ''}

      <div class="qp-actions">
        <button class="btn" type="button" onclick="openEditShipTo(${o.id})">${cuT('Edit ship-to', '修改收货信息')}</button>
      </div>
    </div>`;
}

// Send the chosen candidate. The server reads the place out of the row it stored
// and writes it as poi_picked; only the INDEX travels, so nothing here can
// introduce a position that was never in the list.
async function qpPickPlace(orderId, idx, btn) {
  const label = btn && btn.querySelector('.qpc-name') ? btn.querySelector('.qpc-name').textContent : '';
  if (btn) { btn.disabled = true; btn.classList.add('is-sending'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/confirm-place`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idx }),
    });
    const j = await r.json();
    if (j.success) {
      toast(j.already_created
        ? cuT('Already on the courier platform', '已在配送平台')
        : cuT(`Picked ${j.name || label} — sending it to the channel, about a minute`,
              `已选择 ${j.name || label} — 约一分钟内发单`), 'success');
      openOrder(orderId, { instant: true });
      return;
    }
    if (btn) { btn.disabled = false; btn.classList.remove('is-sending'); }
    toast(j.error === 'order_closed'   ? cuT('This order is closed', '该订单已关闭')
        : j.error === 'choice_gone'    ? cuT('That option is gone — reopen the order', '该选项已失效，请重新打开订单')
        : j.error === 'row_moved'      ? cuT('It moved on while you were looking — reopen the order', '状态已变更，请重新打开订单')
        : cuT('Could not pick it', '选择失败'), 'err');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.classList.remove('is-sending'); }
    toast(cuT('Network error', '网络错误'), 'err');
  }
}

// "None of these is right" — hand the operator the map instead.
//
// Goes through a ROUTE rather than swapping the surface locally, because the
// two surfaces are bound to two server states: confirm-point's SQL is pinned to
// 'needs_point', so a map drawn over an 'awaiting_choice' row would take a tap,
// take a confirm, and answer row_moved — the work thrown away with an error
// that describes none of it. The route moves the row, then this reopens the
// drawer onto the surface that state renders.
//
// It is NOT a Retry. Retry re-runs the push, which re-runs the same name search
// against the same unchanged address and parks it right back here about a
// minute later — the operator would ask for a map and be handed the same list.
//
// No confirm dialog: nothing is dispatched, nothing is charged, and the only
// effect is which surface the drawer draws. Coming back is one press of the
// list again — the candidates are gone, but Retry re-runs the search that
// produced them.
async function qpFallBackToMap(orderId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = cuT('Opening…', '打开中…'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/reject-places`, { method: 'POST' });
    const j = await r.json();
    if (j.success) { openOrder(orderId, { instant: true }); return; }
    if (btn) { btn.disabled = false; btn.textContent = cuT('Place the point on a map', '在地图上标记'); }
    toast(j.error === 'row_moved'
      ? cuT('It moved on while you were looking — reopen the order', '状态已变更，请重新打开订单')
      : cuT('Could not do that', '操作失败'), 'err');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = cuT('Place the point on a map', '在地图上标记'); }
    toast(cuT('Network error', '网络错误'), 'err');
  }
}

// The point the operator has placed, per order. Empty until they place one —
// which is the whole state model, so it is deliberately not seeded from the
// guess. Cleared when the drawer re-renders.
const qpPlaced = {};

// ── What the search box is allowed to touch ────────────────────────────────
// A handle on the map, per order, exposing recentre and zoom AND NOTHING ELSE.
// There is deliberately no pin setter here: the search path cannot place a
// point because it has no way to, rather than because it declines to.
//
// That is the same reasoning as the empty map itself (§5). A gate that merely
// asks people not to confirm a geocoder's centroid is a gate satisfied by
// forgetting; a handle with no pin on it cannot be misused by a future edit to
// this file either. Everything else about the map — the marker, its drag
// handler, the circle — stays closure-local in qpDrawMap where it was.
const qpMap = {};
// The search bias, per order: the coarse guess the push parked with, and the
// city off the order's own address. Both are hints to the provider, never
// filters — an order whose guess was never recorded still searches, just wider.
const qpBias = {};
// The last result set, per order. A click hands back an INDEX into this rather
// than coordinates smuggled through a DOM attribute, so nothing a page inspector
// types can inject a position.
const qpFound = {};
const qpFindTimer = {};
// The query each pending request was fired for, so a slow answer to an old
// keystroke can't paint over a newer one (same guard as the customer search).
const qpFindQuery = {};

// Boot the map for a parked order. Called after the drawer paints (the element
// has to exist and have a width before any SDK will lay a map into it).
// Degrades loudly: with no maps JS key there is no map to place a point on, and
// saying so beats an empty grey box the operator waits on.
async function qpInitMap(orderId, guess, city) {
  const el = document.getElementById('qp-map-' + orderId);
  if (!el || el.dataset.ready) return;
  el.dataset.ready = '1';
  qpBias[orderId] = {
    city: city || '',
    lat: (guess && guess.lat != null) ? guess.lat : null,
    lng: (guess && guess.lng != null) ? guess.lng : null,
  };
  let cfg = null;
  try { const r = await fetch('/api/retail/maps-config'); const j = await r.json(); cfg = j && j.data; } catch (e) { cfg = null; }
  if (!cfg || !cfg.provider) {
    el.className = 'qp-map qp-map-fallback';
    el.innerHTML = cuT(
      'No map is configured, so a point cannot be placed here. Correct the address instead, or create the delivery by hand in the Qingyun app.',
      '未配置地图服务，无法在此标记配送点。请改用修改地址，或在青云 App 中手动建单。');
    const hint = document.getElementById('qp-hint-' + orderId);
    if (hint) hint.textContent = '';
    qpHideFind(orderId);
    return;
  }
  try {
    await qpLoadSdk(cfg);
    qpDrawMap(cfg.provider, el, orderId, guess);
  } catch (e) {
    el.className = 'qp-map qp-map-fallback';
    el.innerHTML = cuT('The map could not load. Try again, or correct the address.', '地图加载失败，请重试或修改地址。');
    qpHideFind(orderId);
  }
}

// No map, no search. Searching exists to move the map, so without one the box
// is a control that does nothing when pressed — worse than absent, because it
// reads as a second way out of a surface that currently has none.
function qpHideFind(orderId) {
  const wrap = document.getElementById('qp-find-wrap-' + orderId);
  if (wrap) wrap.hidden = true;
}

// One SDK load per page, shared with nothing else in the admin. Same two
// providers and the same callback handshake the storefront picker uses.
let _qpSdkP = null;
function qpLoadSdk(cfg) {
  if (_qpSdkP) return _qpSdkP;
  // …but "shared with nothing else" is about this memo, not about the page. The
  // live rider map has its own loader (_adminLoadAmapOnce) and its own memo, and
  // the two never see each other: open an on-the-way order and then a parked one
  // in the same session and this injected a SECOND webapi.amap.com script over
  // an SDK that was already there. _adminLoadAmapOnce has guarded against the
  // mirror-image case since it was written (`if (window.AMap) return`); this is
  // the same guard, from the other side.
  //
  // Checked per provider, because the global differs and the two loaders can
  // only ever agree on one — /api/retail/maps-config answers both.
  const already = cfg.provider === 'amap' ? window.AMap : window.TMap;
  if (already) {
    _qpSdkP = Promise.resolve(cfg.provider);
    return _qpSdkP;
  }
  _qpSdkP = new Promise((resolve, reject) => {
    const cb = '__qpMapReady';
    window[cb] = () => resolve(cfg.provider);
    let src;
    if (cfg.provider === 'amap') {
      if (cfg.security) window._AMapSecurityConfig = { securityJsCode: cfg.security };
      src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(cfg.key) + '&callback=' + cb;
    } else {
      src = 'https://map.qq.com/api/gljs?v=1.exp&key=' + encodeURIComponent(cfg.key) + '&callback=' + cb;
    }
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onerror = () => { _qpSdkP = null; reject(new Error('sdk_load_failed')); };
    document.head.appendChild(s);
  });
  return _qpSdkP;
}

// The area, then (only once placed) the point. The circle is the honest
// picture of what the geocoder returned: somewhere in here. Radius is a
// drawing, not a claim — wide enough to read as "a district", not a number
// anyone should measure against.
const QP_AREA_M = 700;
function qpDrawMap(provider, el, orderId, guess) {
  const c = guess && guess.lat != null ? guess : { lat: 23.1291, lng: 113.2644 };   // GZ, if we have nothing
  const onPlace = (lat, lng) => {
    qpPlaced[orderId] = { lat, lng };
    const btn = document.getElementById('qp-go-' + orderId);
    if (btn) { btn.disabled = false; btn.textContent = cuT('Confirm and dispatch', '确认并发单'); }
    const st = document.getElementById('qp-state-' + orderId);
    if (st) st.textContent = cuT('Point placed', '配送点已标记');
    const hint = document.getElementById('qp-hint-' + orderId);
    if (hint) hint.textContent = cuT('Tap again to move it.', '再次点选可调整位置。');
  };

  if (provider === 'amap') {
    const map = new AMap.Map(el, { zoom: 15, center: [c.lng, c.lat], resizeEnable: true });
    new AMap.Circle({
      center: [c.lng, c.lat], radius: QP_AREA_M, map,
      strokeColor: '#58606E', strokeWeight: 1.5, strokeStyle: 'dashed',
      fillColor: '#58606E', fillOpacity: 0.07,
    });
    // Recentre/zoom only — see qpMap. `pin` below stays out of it.
    qpMap[orderId] = {
      setCenter: (la, ln) => map.setCenter([ln, la]),
      setZoom: (z) => map.setZoom(z),
    };
    let pin = null;
    map.on('click', (e) => {
      const lat = e.lnglat.getLat(), lng = e.lnglat.getLng();
      if (!pin) {
        pin = new AMap.Marker({ position: [lng, lat], draggable: true, map, zIndex: 120 });
        pin.on('dragend', () => { const p = pin.getPosition(); onPlace(p.getLat(), p.getLng()); });
      } else { pin.setPosition([lng, lat]); }
      onPlace(lat, lng);
    });
  } else {
    const map = new TMap.Map(el, { zoom: 15, center: new TMap.LatLng(c.lat, c.lng) });
    new TMap.MultiCircle({
      map, styles: { a: new TMap.CircleStyle({ color: 'rgba(88,96,110,0.07)', showBorder: true, borderColor: '#58606E', borderWidth: 1 }) },
      geometries: [{ id: 'a', styleId: 'a', center: new TMap.LatLng(c.lat, c.lng), radius: QP_AREA_M }],
    });
    // Recentre/zoom only — see qpMap. `pin` below stays out of it.
    qpMap[orderId] = {
      setCenter: (la, ln) => map.setCenter(new TMap.LatLng(la, ln)),
      setZoom: (z) => map.setZoom(z),
    };
    // Tencent's gljs markers are not draggable, so placing IS the adjustment:
    // every tap moves the point. Same model as Amap, one fewer gesture.
    let pin = null;
    map.on('click', (e) => {
      const ll = e.latLng, pos = new TMap.LatLng(ll.getLat(), ll.getLng());
      if (!pin) {
        pin = new TMap.MultiMarker({ map, geometries: [{ id: 'p', position: pos }] });
      } else { pin.updateGeometries([{ id: 'p', position: pos }]); }
      onPlace(ll.getLat(), ll.getLng());
    });
  }
}

// ── Find the street ────────────────────────────────────────────────────────
// A coarse match parks the order in a district, and the operator's first job is
// to get the map to the right street — which, on an unfamiliar Chinese address,
// is most of the work. Searching does that and stops there.
//
// It is not a shortcut past the tap. A result recentres the map and leaves the
// surface exactly as it found it: no pin, "No point placed yet", the primary
// button still disabled reading "Place the point". Searching gets you to the
// building; a human still says which door, and that is the whole reason the
// confirmed point is worth calling staff_pin (spec §5, §5.1).
//
// Debounced like the customer search above it — 350ms, and a superseded
// keystroke discards its own answer rather than racing it onto the screen.
function qpFindType(orderId) {
  clearTimeout(qpFindTimer[orderId]);
  qpFindTimer[orderId] = setTimeout(() => qpFindNow(orderId), 350);
}

async function qpFindNow(orderId) {
  clearTimeout(qpFindTimer[orderId]);
  const inp = document.getElementById('qp-find-' + orderId);
  const box = document.getElementById('qp-find-out-' + orderId);
  if (!inp || !box) return;
  const q = (inp.value || '').trim();
  qpFindQuery[orderId] = q;
  if (!q) { box.hidden = true; box.innerHTML = ''; return; }

  const note = (s) => `<div class="qp-find-note">${escapeHtml(s)}</div>`;
  box.hidden = false;
  box.innerHTML = note(cuT('Searching…', '搜索中…'));

  const bias = qpBias[orderId] || {};
  // Only send coordinates we actually have. A null crosses JSON intact and
  // arrives at the server as 0 — a real, finite point in the Gulf of Guinea —
  // so an order parked without a guess would be biased to the wrong hemisphere
  // rather than simply searched wider. The server refuses 0 as well; this side
  // just never asks it to.
  const body = { keyword: q, city: bias.city || '' };
  if (bias.lat != null && bias.lng != null) { body.lat = bias.lat; body.lng = bias.lng; }
  let list = null;
  try {
    const j = await api('/api/retail-admin/poi-search', { method: 'POST', body });
    if (qpFindQuery[orderId] !== q) return;          // a newer keystroke superseded this
    list = Array.isArray(j.data) ? j.data : [];
  } catch (e) {
    if (qpFindQuery[orderId] !== q) return;
    // Say which of the two it is. "No map service" is a configuration fact the
    // operator can act on (correct the address instead); a failed lookup is
    // worth pressing again. One message for both would strand them on the wrong
    // one — and neither is a reason the order cannot still be placed by hand.
    box.innerHTML = note((e && e.code === 'maps_key_missing')
      ? cuT('Search needs a map service, and none is configured. Place the point on the map instead.',
            '搜索需要地图服务，当前未配置。请直接在地图上标记配送点。')
      : cuT('Could not search just now. Try again, or place the point on the map.',
            '暂时无法搜索，请重试，或直接在地图上标记配送点。'));
    return;
  }

  qpFound[orderId] = list.filter(p => p && p.lat != null && p.lng != null).slice(0, 8);
  if (!qpFound[orderId].length) {
    box.innerHTML = note(cuT(`No place matches "${q}".`, `没有地点匹配“${q}”。`));
    return;
  }
  box.innerHTML = qpFound[orderId].map((p, i) =>
    `<button type="button" onclick="qpFindPick(${orderId}, ${i})">`
    + `<span class="n">${escapeHtml(p.name || '')}</span>`
    + `<span class="a">${escapeHtml(p.address || '')}</span></button>`).join('');
}

// The one thing a search result does. Note what is NOT here: qpPlaced is not
// written, the confirm button is not enabled, and no pin is drawn — qpMap has
// no method that could draw one. A searched-then-tapped point is recorded by
// exactly the path a hunted-and-tapped point is, because it IS that path.
function qpFindPick(orderId, i) {
  const p = (qpFound[orderId] || [])[i];
  const m = qpMap[orderId];
  if (!p || !m) return;
  m.setCenter(p.lat, p.lng);
  m.setZoom(17);                       // close enough to pick a building out
  const box = document.getElementById('qp-find-out-' + orderId);
  if (box) { box.hidden = true; box.innerHTML = ''; }
  const inp = document.getElementById('qp-find-' + orderId);
  if (inp) inp.value = p.name || '';
  // The hint moves the operator on to the step that remains. Left alone once a
  // point exists, where it already says how to adjust one.
  const hint = document.getElementById('qp-hint-' + orderId);
  if (hint && !qpPlaced[orderId]) {
    hint.textContent = cuT('Map moved. Tap where the door is.', '地图已移动。请在地图上点选收货位置。');
  }
}

// Send the placed point. The server writes it onto the ORDER's snapshot as
// staff_pin and requeues the push in one transaction; nothing here writes to
// the customer's saved address, and nothing here invents a precision grade.
async function qpConfirmPoint(orderId, btn) {
  const p = qpPlaced[orderId];
  if (!p) return;                                  // button is disabled without one
  if (btn) { btn.disabled = true; btn.textContent = cuT('Sending…', '发送中…'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/confirm-point`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: p.lat, lng: p.lng }),
    });
    const j = await r.json();
    if (j.success) {
      toast(j.already_created
        ? cuT('Already on the courier platform', '已在配送平台')
        : cuT('Point confirmed — sending it to the channel, about a minute', '配送点已确认 — 约一分钟内发单'), 'success');
      delete qpPlaced[orderId];
      // The map and its search go with the point that has just been sent — the
      // drawer re-renders below onto a fresh element, and a stale handle would
      // outlive the map it points at.
      delete qpMap[orderId]; delete qpBias[orderId]; delete qpFound[orderId];
      delete qpFindQuery[orderId]; clearTimeout(qpFindTimer[orderId]);
      openOrder(orderId, { instant: true });
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = cuT('Confirm and dispatch', '确认并发单'); }
    toast(j.error === 'order_closed' ? cuT('This order is closed', '该订单已关闭')
        : j.error === 'row_moved'    ? cuT('It moved on while you were looking — reopen the order', '状态已变更，请重新打开订单')
        : cuT('Could not confirm it', '确认失败'), 'err');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = cuT('Confirm and dispatch', '确认并发单'); }
    toast(cuT('Network error', '网络错误'), 'err');
  }
}

// ── Reschedule an expired delivery ─────────────────────────────────────────
// TODAY ONLY, until stage 6. A future date writes and requeues cleanly and
// then dies the next morning, and every morning after: nothing re-queues a
// 'skipped' row on its own day, so the drain retires it again on each pass.
// The operator would pick Friday, watch it be accepted, and find it gone with
// no error and no trace — the same silent no-op this whole build exists to
// remove, with a caption on it.
//
// Not offered-and-disabled either: an option you can see but not choose still
// says it is coming. It is not coming until a skipped row can wait for its
// day. For any other date the honest instruction is to build the delivery by
// hand, which is what the copy says.
function qpOpenReschedule(orderId, btn) {
  const box = document.getElementById('qp-resched-' + orderId);
  if (!box) return;
  const acts = document.getElementById('qp-actions-' + orderId);
  if (acts) acts.hidden = true;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);   // Beijing day
  box.innerHTML = `
    <div class="qp-dates">
      <label class="qp-date">
        <input type="radio" name="qp-date-${orderId}" value="${today}" onchange="qpPickDate(${orderId}, '${today}')">
        <span class="d">${today}</span>
        <span class="muted" style="font-size:12.5px;">${cuT('today', '今天')}</span>
      </label>
    </div>
    <div class="qp-hint" style="margin-top:8px;line-height:1.6;">${cuT(
      'Only today can go back in the queue. For a later day, create the delivery by hand in the Qingyun app.',
      '仅可改期至今天并重新排队。如需改到其他日期,请在青云 App 中手动建单。')}</div>
    <div id="qp-confirm-${orderId}"></div>`;
}

// Naming both days is the point: this changes what the customer was told, so
// it takes a confirm — unlike placing a point, where the map IS the confirm.
function qpPickDate(orderId, iso) {
  const box = document.getElementById('qp-confirm-' + orderId);
  const o = _OPEN_ORDER || {};
  const from = (o.qingyun_ship_from && o.qingyun_ship_from.promised_date) || '';
  if (!box) return;
  box.innerHTML = `
    <div class="qp-confirm">
      <div>${cuT(
        `Move this delivery from <span class="swap">${escapeHtml(from)}</span> to <span class="swap">${escapeHtml(iso)}</span>? The customer is told the new day.`,
        `将配送日期由 <span class="swap">${escapeHtml(from)}</span> 改为 <span class="swap">${escapeHtml(iso)}</span>？系统会告知顾客新的日期。`)}
      </div>
      <div style="display:flex;gap:10px;margin-top:11px;">
        <button class="btn btn-primary btn-sm" type="button" onclick="qpDoReschedule(${orderId}, '${iso}', this)">${cuT('Move the delivery', '确认改期')}</button>
        <button class="btn btn-sm" type="button" onclick="openOrder(${orderId}, { instant: true })">${cuT('Keep the current date', '保持原日期')}</button>
      </div>
    </div>`;
}

async function qpDoReschedule(orderId, iso, btn) {
  if (btn) { btn.disabled = true; btn.textContent = cuT('Moving…', '处理中…'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/reschedule`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: iso }),
    });
    const j = await r.json();
    if (j.success) {
      toast(cuT('Moved to today — it goes back in the queue now', '已改期至今天 — 已重新排队'), 'success');
      openOrder(orderId, { instant: true });
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = cuT('Move the delivery', '确认改期'); }
    toast(cuT('Could not move it', '改期失败'), 'err');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = cuT('Move the delivery', '确认改期'); }
    toast(cuT('Network error', '网络错误'), 'err');
  }
}

function renderQyShipFrom(o) {
  const sf = o.qingyun_ship_from;
  if (!sf) return '';
  const name = escapeHtml(cuT(sf.name_en || sf.store_code, sf.name_cn || sf.store_code));
  // No copy on the courier platform. Either it hasn't been pushed yet, or the
  // push was REFUSED — an address whose drop-off pin couldn't be trusted. That
  // used to render as nothing at all, so an order nobody was coming for looked
  // exactly like an order that was never meant to go to Qingyun. Say what
  // happened, and offer the retry that used to require hand-editing the DB.
  if (!sf.qingyun_order_id) {
    // Parked for want of a delivery point — its own surface, not a variant of
    // "refused". Nothing failed and nothing is retrying: the order is waiting
    // on a person, and the thing that person needs is a map.
    if (sf.awaiting_point) return renderQyPointSurface(o, sf);
    // Parked because the name search found SEVERAL places. A different question
    // from the one above and so a different surface: the answer is already on
    // the screen and the operator picks it, rather than supplying one by hand.
    // Guarded on there actually being candidates — a row whose stored list is
    // unreadable falls through to the ordinary parked treatment rather than
    // rendering an empty question.
    if (sf.awaiting_choice && (sf.candidates || []).length) return renderQyCandidateSurface(o, sf);
    const refused = sf.needs_attention;
    // A hold is nobody's fault and needs no action — but it must not read as a
    // normal queue wait, or an outage looks like latency until 待配送 runs dry.
    const held = !refused && sf.push_held;
    // "since 14:20" — the hold's age is the outage's age, and an operator
    // deciding whether to chase it needs that more than the fact of the hold.
    // Absent or unparseable timestamp just omits the clause.
    const heldSince = (() => {
      if (!held || !sf.push_held_since) return '';
      // SQLite CURRENT_TIMESTAMP is UTC 'YYYY-MM-DD HH:MM:SS'.
      const t = new Date(String(sf.push_held_since).replace(' ', 'T') + 'Z');
      if (isNaN(t.getTime())) return '';
      return ` · ${cuT('since', '自')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    })();
    return `
      <div class="ord-drawer-row">
        <div class="ord-drawer-label">${cuT('Same-city courier', '同城配送')}</div>
        <div style="flex:1;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span style="font-size:12px; font-weight:600; color:${refused || held ? 'var(--warn)' : 'var(--text-2)'};">
              ${refused
                ? `⚠ ${cuT('Push refused — nobody is collecting this', '发单被拒 — 无人接单')}`
                : held
                  ? `⏸ ${cuT('Held — map service unavailable, retrying', '已挂起 — 地图服务不可用,正在重试')}${escapeHtml(heldSince)}`
                  : cuT('Queued for push…', '排队发单中…')}
            </span>
            ${refused
              ? `<button class="btn btn-sm" onclick="qyRetryPush(${o.id}, this)">${cuT('Retry push', '重新发单')}</button>`
              : ''}
          </div>
          ${sf.push_error ? `<div class="muted" style="font-size:11px; margin-top:4px; line-height:1.5;" data-no-i18n>${escapeHtml(sf.push_error)}</div>` : ''}
          ${held
            ? `<div class="muted" style="font-size:11px; margin-top:4px; line-height:1.5;">${cuT(
                'Nothing is wrong with this address — the geocoder is down. It pushes itself once the service is back.',
                '地址没有问题 — 地图服务暂时不可用,恢复后会自动发出。')}</div>`
            : ''}
          ${refused
            ? `<div class="muted" style="font-size:11px; margin-top:4px; line-height:1.5;">${cuT(
                'Fix the delivery address (Edit ship-to, or Make address Chinese) and it retries on its own — or press Retry.',
                '修正收货地址(修改收货信息或转为中文地址)后会自动重试,也可点击重新发单。')}</div>`
            : ''}
        </div>
      </div>`;
  }
  // The order still belongs to its original store for stock, printing and reports —
  // only the collection point moved. Say so, or the numbers look wrong later.
  const moved = !!(o.store_code && sf.store_code !== o.store_code);
  const movedNote = moved
    ? `<div class="muted" style="font-size:11px; margin-top:4px; line-height:1.5;">${cuT(
        `Collected here, but the order still counts against ${escapeHtml(o.store_name_en || o.store_code)} for stock and reports.`,
        `在此取货,但库存与报表仍算在 ${escapeHtml(o.store_name_cn || o.store_code)}。`)}</div>`
    : '';
  const blockedNote = sf.blocked_by && sf.blocked_by !== 'delivered'
    ? `<div class="muted" style="font-size:11px; margin-top:4px; line-height:1.5;">${cuT(
        'A courier is already on this one. To collect it somewhere else, cancel it in the Qingyun app first.',
        '已呼叫运力。如需改到其他门店取货,请先在青云 App 取消该单。')}</div>`
    : '';
  const changeBtn = !sf.blocked_by
    ? `<button class="btn btn-sm" id="qy-sf-btn-${o.id}" onclick="qyLoadShipFrom(${o.id}, this)">${cuT('Change', '更改')}</button>`
    : '';
  // Moving an order deletes the copy at the old location automatically. This only
  // appears when that delete failed — and it matters: the old copy is a live 待配送
  // order anyone at that store could dispatch, so you'd pay for a second rider.
  const stale = sf.stale
    ? `<div style="display:flex; align-items:flex-start; gap:5px; font-size:11px; font-weight:600; margin-top:7px; color:#9A6E2A;">
         ${deliveryIcon('alert', 12)}
         <span>${cuT(
           `The old job at ${escapeHtml(sf.stale.name_en || sf.stale.store_code)} is still in Qingyun — someone there could send a rider for it.`,
           `${escapeHtml(sf.stale.name_cn || sf.stale.store_code)} 的原配送单仍在青云中 — 那边有人可能会再叫一位骑手。`)}</span>
       </div>
       <button class="btn btn-sm" style="margin-top:6px;" onclick="qyRemoveStale(${o.id}, this)">${cuT('Remove it', '删除原单')}</button>`
    : '';
  return `
    <div style="margin:8px 0;">
      <div class="row" style="gap:10px; align-items:center; flex-wrap:wrap;">
        <span style="font-size:12px; color:var(--text-3);">${cuT('Ships from', '取货门店')}</span>
        <b style="font-size:13px;">${name}</b>
        ${changeBtn}
      </div>
      ${movedNote}${blockedNote}${stale}
      <div id="qy-shipfrom-${o.id}" style="margin-top:8px;"></div>
    </div>`;
}

// Retry the delete that failed during a move. No confirm: it removes a duplicate
// nobody has been sent for, which is the tidy-up the move already intended.
// Put a refused push back in the queue. The daemon drains 'pending' rows every
// ~25s, so this hands the order back to the SAME path — and the same address
// checks — as the automatic push, rather than bypassing them.
async function qyRetryPush(orderId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = cuT('Queuing…', '排队中…'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/retry-push`, { method: 'POST' });
    const j = await r.json();
    if (j.success) {
      toast(j.already_created
        ? cuT('Already on the courier platform', '已在配送平台')
        : cuT('Queued — sending it to the channel, about a minute', '已排队 — 约一分钟内发单'), 'success');
      openOrder(orderId, { instant: true });
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = cuT('Retry push', '重新发单'); }
    toast(cuT('Could not queue it', '排队失败'), 'err');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = cuT('Retry push', '重新发单'); }
    toast(cuT('Network error', '网络错误'), 'err');
  }
}

async function qyRemoveStale(orderId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = cuT('Removing…', '删除中…'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/remove-stale`, { method: 'POST' });
    const j = await r.json();
    if (j.success) {
      toast(cuT('Old job removed', '原配送单已删除'), 'success');
      openOrder(orderId, { instant: true });
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = cuT('Remove it', '删除原单'); }
    toast(cuT('Could not remove it — do it in the Qingyun app', '删除失败 — 请在青云 App 中删除'), 'err');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = cuT('Remove it', '删除原单'); }
    toast(cuT('Could not remove it — do it in the Qingyun app', '删除失败 — 请在青云 App 中删除'), 'err');
  }
}

// Pick a different pickup location. Only stores whose Qingyun session is live can
// take the order — a disconnected one would fail at create time, so it's listed but
// not selectable, with the reason said plainly.
async function qyLoadShipFrom(orderId, btn) {
  const box = document.getElementById('qy-shipfrom-' + orderId);
  if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }   // second click closes it
  if (btn) { btn.disabled = true; btn.textContent = cuT('Loading…', '加载中…'); }
  const reset = () => { if (btn) { btn.disabled = false; btn.textContent = cuT('Change', '更改'); } };
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/ship-from`);
    const j = await r.json();
    reset();
    if (!j.success || !j.data || !j.data.available) {
      box.innerHTML = `<div class="muted" style="font-size:12px">${cuT('This order has no Qingyun job to move.', '该订单在青云没有可转移的配送单。')}</div>`;
      return;
    }
    const stores = (j.data.stores || []).filter(s => s.code !== j.data.current);
    if (!stores.length) {
      box.innerHTML = `<div class="muted" style="font-size:12px">${cuT('No other location is set up for same-city delivery.', '暂无其他门店开通同城配送。')}</div>`;
      return;
    }
    const rows = stores.map(s => `
      <label class="qy-row" style="${s.connected ? '' : 'opacity:.55;'}">
        <input type="radio" name="qy-sf-${orderId}" value="${escapeAttr(s.code)}" ${s.connected ? '' : 'disabled'}>
        <span style="flex:1; min-width:0;">
          <span class="qy-name"><b>${escapeHtml(cuT(s.name_en || s.code, s.name_cn || s.code))}</b></span>
          ${s.connected ? '' : `<span class="qy-meta">${cuT('not connected to Qingyun', '未连接青云')}</span>`}
        </span>
      </label>`).join('');
    box.innerHTML = rows +
      `<button class="btn btn-primary btn-sm" onclick="qySetShipFrom(${orderId}, this)" style="margin-top:6px;">${cuT('Ship from here', '改为此门店取货')}</button>`;
  } catch (e) {
    reset();
    box.innerHTML = `<div class="muted" style="font-size:12px;color:var(--danger)">${cuT('Load failed', '加载失败')}</div>`;
  }
}

// Move it. The old job stays in the previous store's Qingyun app until someone
// cancels it there — we have no cancel API — so that instruction leads the confirm
// and repeats in the toast. Leave it and a second rider can be dispatched for the
// same order, at your cost.
async function qySetShipFrom(orderId, btn) {
  const sel = document.querySelector(`input[name="qy-sf-${orderId}"]:checked`);
  if (!sel) { toast(cuT('Pick a location', '请选择门店'), 'err'); return; }
  const storeCode = sel.value;
  const label = sel.closest('label')?.querySelector('b')?.textContent || storeCode;
  const from = (_OPEN_ORDER && _OPEN_ORDER.qingyun_ship_from) || null;
  const fromName = from ? cuT(from.name_en || from.store_code, from.name_cn || from.store_code) : '';
  // askConfirm renders title/body as HTML — escape the store names going into it.
  const labelHtml = escapeHtml(label), fromHtml = escapeHtml(fromName);
  if (!(await askConfirm({
    title: cuT(`Collect this order at ${labelHtml} instead?`, `改由 ${labelHtml} 取货?`),
    body: cuT(
      `A new delivery job is created at ${labelHtml}, and the one at ${fromHtml} is deleted. Nobody has been sent for it yet, so nothing is charged.`,
      `将在 ${labelHtml} 新建配送单,并删除 ${fromHtml} 的原配送单。尚未呼叫运力,不产生费用。`),
    confirmLabel: cuT('Move it', '确认更改'),
  }))) return;
  if (btn) { btn.disabled = true; btn.textContent = cuT('Moving…', '更改中…'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/ship-from`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_code: storeCode }),
    });
    const j = await r.json();
    if (j.success) {
      // old_removed:false → the old copy is still live at the previous store; the
      // drawer re-renders with the Remove button, so say why it's there.
      toast(j.old_removed === false
        ? cuT(`Now collected at ${label} — but the old job couldn't be deleted, remove it below`,
              `已改为 ${label} 取货 — 但原配送单未能删除,请在下方删除`)
        : cuT(`Now collected at ${label}`, `已改为 ${label} 取货`),
      j.old_removed === false ? 'err' : 'success');
      openOrder(orderId, { instant: true });
      loadOrders();
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = cuT('Ship from here', '改为此门店取货'); }
    if (j.error === 'courier_already_called') toast(cuT('A courier is already on it — cancel it in the Qingyun app first', '已呼叫运力 — 请先在青云 App 取消'), 'err');
    else if (j.error === 'store_not_connected') toast(cuT("That location isn't connected to Qingyun", '该门店未连接青云'), 'err');
    else if (j.error === 'store_not_reachable') toast(cuT("That location's Qingyun account isn't wired up yet — ask ops to set it up", '该门店的青云账号尚未接通 — 请联系运维配置'), 'err');
    else toast(cuT('Could not move it', '更改失败'), 'err');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = cuT('Ship from here', '改为此门店取货'); }
    toast(cuT('Could not move it', '更改失败'), 'err');
  }
}

// Fetch live carrier prices for one order and render a pick list (cheapest pre-selected).
async function qyLoadCarriers(orderId, btn) {
  const box = document.getElementById('qy-carriers-' + orderId);
  if (btn) { btn.disabled = true; btn.textContent = cuT('Loading…', '加载中…'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/carriers`);
    const j = await r.json();
    if (btn) { btn.disabled = false; btn.textContent = cuT('Refresh prices', '刷新比价'); }
    if (!j.success) { box.innerHTML = `<div class="muted" style="font-size:12px;color:var(--danger)">${cuT('Could not load couriers — is the store connected to Qingyun?', '无法获取运力 — 门店是否已连接青云?')}</div>`; return; }
    if (!j.data.available) { box.innerHTML = `<div class="muted" style="font-size:12px">${cuT("Not in Qingyun yet. Turn on auto-send, or this isn't a same-city order.", '订单尚未进入青云。请开启自动发送,或此单非同城配送。')}</div>`; return; }
    const carriers = (j.data.carriers || []).filter(c => c.enabled);
    if (!carriers.length) { box.innerHTML = `<div class="muted" style="font-size:12px">${cuT('No couriers available right now.', '当前暂无可用运力。')}</div>`; return; }
    const rows = carriers.map(c => `
      <label class="qy-row">
        <input type="checkbox" name="qy-car-${orderId}" value="${c.carrierId}|${escapeAttr(c.serviceCode)}" ${c.cheapest ? 'checked' : ''}>
        <span style="flex:1; min-width:0;">
          <span class="qy-name"><b>${escapeHtml(c.serviceName || c.carrierName)}</b>${c.cheapest ? `<span class="qy-cheap">${cuT('cheapest', '最便宜')}</span>` : ''}</span>
          <span class="qy-meta">${escapeHtml(c.carrierName)}${c.distanceM ? ' · ' + (c.distanceM / 1000).toFixed(1) + 'km' : ''}</span>
        </span>
        <span class="qy-fee">${acWrap(c.feeYuan)}</span>
      </label>`).join('');
    box.innerHTML =
      rows +
      `<button class="btn btn-primary btn-sm" onclick="qyDispatch(${orderId}, this)" style="margin-top:6px;">${cuT('Dispatch courier', '发起配送')}</button>`;
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = cuT('Compare couriers', '查看运力比价'); }
    if (box) box.innerHTML = `<div class="muted" style="font-size:12px;color:var(--danger)">${cuT('Load failed', '加载失败')}</div>`;
  }
}

// Dispatch the selected courier — real money (deducts the Qingyun wallet), so confirm.
async function qyDispatch(orderId, btn) {
  const sels = Array.from(document.querySelectorAll(`input[name="qy-car-${orderId}"]:checked`));
  if (!sels.length) { toast(cuT('Pick at least one courier', '请至少选择一个运力'), 'err'); return; }
  const carriers = sels.map(s => { const [carrierId, serviceCode] = s.value.split('|'); return { carrierId: Number(carrierId), serviceCode }; });
  const labels = sels.map(s => s.closest('label')?.querySelector('b')?.textContent || '').filter(Boolean);
  const many = carriers.length > 1;
  const confirmMsg = many
    ? cuT(`Call ${carriers.length} couriers at once? The first rider to accept takes the order — only that courier is charged to your Qingyun balance.`,
          `同时呼叫 ${carriers.length} 家运力?谁先接单谁配送,仅对接单的那家从青云余额扣费。`)
    : cuT(`Dispatch ${labels[0]}? A rider is called and your Qingyun balance is charged.`,
          `确认发起配送 ${labels[0]}?将呼叫骑手并从青云余额扣费。`);
  if (!(await askConfirm({ title: confirmMsg, confirmLabel: cuT('Dispatch', '发起配送') }))) return;
  if (btn) { btn.disabled = true; btn.textContent = cuT('Dispatching…', '发单中…'); }
  try {
    const r = await fetch(`/api/retail-admin/orders/${orderId}/qingyun/dispatch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carriers }),
    });
    const j = await r.json();
    if (j.success) {
      toast(cuT('Courier dispatched', '已发起配送'), 'success');
      const box = document.getElementById('qy-carriers-' + orderId);
      const done = (j.carriers && j.carriers.length) ? j.carriers : (j.carrier ? [j.carrier] : []);
      const names = done.length > 1
        ? `${done.map(c => escapeHtml(c.name || '')).join(', ')} — ${cuT('first to accept wins', '谁先接单谁配送')}`
        : `${escapeHtml(done[0]?.name || '')} ${acWrap(done[0]?.fee_yuan ?? '')}`;
      if (box) box.innerHTML = `<div style="font-size:12px;color:var(--brand)">✓ ${cuT('Dispatched', '已发单')}: ${names}</div>`;
      loadOrders();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = cuT('Dispatch courier', '发起配送'); }
      if (j.insufficient_balance) toast(cuT('Qingyun balance too low — top up first', '青云余额不足,请先充值'), 'err');
      else if (j.error === 'courier_already_called') {
        // The dispatch that "failed" had in fact already succeeded moments earlier.
        // Re-render the drawer so the pick list is replaced by the live tracking
        // card, instead of sitting there inviting another click.
        toast(cuT('A courier is already on this order', '该订单已呼叫运力'), 'err');
        openOrder(orderId, { instant: true });
        loadOrders();
      } else {
        // Qingyun's own words, appended the way adminWrite does it. A bare "Dispatch
        // failed" is unactionable and hides the single fact that explains it.
        const why = (j.error && j.error !== 'dispatch_failed') ? ': ' + j.error : '';
        toast(cuT('Dispatch failed', '发起配送失败') + why, 'err');
      }
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = cuT('Dispatch courier', '发起配送'); }
    toast(cuT('Dispatch failed', '发起配送失败'), 'err');
  }
}

// Supplier (drop-ship) parcel: no warehouse label, no courier booking — the
// supplier ships it and sends a tracking number the operator pastes in. We
// reuse the standard tracking card (carrier picker + number + Save + live
// events), with the "Create JD label" path suppressed (see renderShipmentTrackingCard),
// and lead with a plain instruction so staff know this parcel isn't ours to ship.
function renderSupplierTrackingBlock(o, s) {
  const instr = `<div class="muted" style="font-size:11px; margin-bottom:8px; line-height:1.5;">${cuT(
    'Ships directly from the supplier — no warehouse label is printed for it. Paste the tracking number the supplier sends you so the customer can follow it.',
    '由供应商直接发货 — 此包裹不打印仓库面单。请将供应商提供的快递单号填入下方,顾客即可查询物流。')}</div>`;
  // When the carrier doesn't live-sync (foreign courier), the operator confirms
  // arrival by hand — this is what completes the order's supplier leg. Shown
  // once the parcel is on its way (tracking entered / dispatched) and not yet
  // delivered; a live-synced carrier flips delivered_at on its own.
  const canDeliver = (s.state || 'pending') === 'dispatched';
  const deliverBtn = canDeliver
    ? `<div class="row" style="gap:8px; margin-top:10px;"><button class="btn btn-sm" onclick="markParcelDelivered(${o.id}, ${s.id}, event)">${cuT('Mark this parcel delivered', '标记此包裹已送达')}</button></div>`
    : '';
  return `<div style="margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line-soft);">${instr}${renderShipmentTrackingCard(o, s, true)}${deliverBtn}</div>`;
}

// Operator confirms a supplier parcel arrived (used when the carrier can't
// live-track it). When it makes every parcel delivered, the server flips the
// whole order to delivered.
async function markParcelDelivered(id, sid, ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm await nulls currentTarget
  const ok = await askConfirm({
    titleEn: 'Mark parcel delivered?', titleCn: '标记包裹已送达?',
    bodyEn: 'Confirm the supplier parcel reached the customer. If it was the last parcel, the order is marked delivered.',
    bodyCn: '确认此供应商包裹已送达顾客。若为最后一个包裹,订单将标记为已送达。',
    confirmEn: 'Mark delivered', confirmCn: '标记已送达',
    cancelEn: 'Cancel', cancelCn: '取消',
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    await api(`/api/retail-admin/orders/${id}/shipments/${sid}/deliver`, { method: 'POST', body: {} });
    toast('Parcel delivered · 包裹已送达');
    openOrder(id, { instant: true });
    loadOrders();
  } catch (e) {
    toast(cuT('Failed', '失败') + ': ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Stored ETA is a bare 24h "HH:MM" with no date attached, so it can't go
// through tdWhen() — but it still owes §1.18 its language rule: a 12h clock
// in English, a 24h clock in Chinese. It used to render 12h in BOTH, which
// put an English-shaped clock on a Chinese screen.
function formatEtaPretty(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return hhmm || '';
  if (typeof cuLang === 'function' && cuLang() === 'cn') return `${m[1]}:${m[2]}`;
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

// Put the delivery-point confirm surface under the operator's eyes inside an
// already-rendered order drawer. Only ever reached through openOrder's
// `focus: 'point'` opt, so no other caller's scroll position moves.
//
// It has to scroll at all because a PARKED order's confirm box is not hoisted:
// hoistedTracking() only lifts a local parcel once there's a courier copy or a
// live rider stage, and an order waiting for a point has neither by definition
// — so renderQyPointSurface lands inline under the items, below the fold.
//
// A miss is ordinary, not an error. The point can be confirmed by someone else
// between the dashboard's poll and this click, and the drawer then renders no
// .qp box at all; the same is true of an order that was never parked. Degrade
// to "the drawer just opened" rather than throwing out of a click handler.
// (scrollIntoView on a display:none node is a no-op anyway — same caveat the
// pager scroll above carries.)
function odFocusPointSection(orderId) {
  const el = document.getElementById('qp-' + orderId);
  if (!el) return false;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

async function openOrder(id, opts = {}) {
  _OPEN_ORDER = null;
  _ORDER_BACK_CUSTOMER = null;
  _ODM_OPEN = false;               // Refund/Cancel menu closed on a fresh open
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
      const foot = $('#order-drawer-foot');
      if (foot) foot.innerHTML = '';  // drop the previous order's print footer while loading
      openDrawer('#order-drawer');
      // Back to the floating slide-in drawer (was briefly an in-flow desktop
      // page via body.ord-viewing — reverted per operator feedback). The
      // ord-viewing CSS/markup stays in place, just unreached, in case this
      // gets revisited.
      window.scrollTo(0, 0);
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
    // Live rider map — mounts only when the drawer rendered a courier-map
    // container (an on-the-way same-city order). Self-tears-down any prior map.
    try { mountCourierMap(o); } catch (e) { /* map is best-effort */ }
    // Same contract for the delivery-point map: the element has to exist and
    // have a width before any SDK will lay a map into it, so it mounts here
    // rather than inside the template. Only a parked order renders the box.
    try {
      const _sf = o.qingyun_ship_from;
      // The order's own city biases the address search — the same hint the
      // storefront picker passes. Absent, the search is national, which is
      // slower but never wrong.
      if (_sf && _sf.awaiting_point && _sf.date_posture !== 'passed') {
        qpInitMap(o.id, _sf.guess, (o.address && o.address.city) || '');
      }
    } catch (e) { /* map is best-effort */ }
    // The GET above stamped seen_at server-side (shared across staff). Clear
    // this row's unread treatment immediately so it doesn't wait for the next
    // poll; a later list rebuild reflects the server seen_at and stays cleared.
    // Dropping .is-unseen lets the row settle back — the td's transparent
    // inset shadow and its .6s transition carry the surface and edge out
    // together, rather than snapping.
    const _row = document.querySelector('tr.order-row[data-order-id="' + id + '"]');
    if (_row) _row.classList.remove('is-unseen');
    // In-page breadcrumb (desktop page mode).
    const _crumb = document.getElementById('ord-page-crumb');
    if (_crumb) _crumb.textContent = o.order_no || '';
  } catch (e) {
    mount.innerHTML = `<div class="order-card err">${cuT('Failed', '失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
    mount.classList.remove('od-swapping');
  }
  // Opened from a surface whose entire subject is the point — today only the
  // dashboard's "Orders waiting for a delivery point" card. Land on the map
  // rather than at the top of a drawer the operator would have to scroll.
  // Opt-gated: with no `focus` every existing caller behaves exactly as before.
  // Runs after both render paths above (fresh and cross-fade), because the node
  // it looks for is written by renderOpenOrder. An expired parked order renders
  // the reschedule variant under the SAME #qp-<id> wrapper, which is still that
  // order's one action, so it is scrolled to as well.
  //
  // OUTSIDE the try, deliberately. Inside it, a throw on this line would be
  // caught above and painted as a "Failed ·" card OVER a drawer that had just
  // rendered correctly — a scroll that fails is not a reason to destroy the
  // order the operator asked for. Out here a real bug surfaces as a real error
  // rather than wearing the costume of a load failure. Do not move it back in.
  //
  // Reads _OPEN_ORDER instead of introducing a local, so the path every other
  // caller takes keeps exactly the statements it had. It is null when the fetch
  // failed (nulled at the top of this function, assigned only on success), so
  // the error path never scrolls; nothing async runs between the catch and here
  // for a concurrent open to race with; and a missing #qp-<id> is still a clean
  // no-op inside odFocusPointSection.
  if (opts.focus === 'point' && _OPEN_ORDER) odFocusPointSection(_OPEN_ORDER.id);
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
// Monotonic open counter — stamped on each drawer as it opens so Esc /
// outside-click can pick the most-recently-opened drawer (the one on top)
// rather than the last one in DOM source order. The order and customer
// drawers share z-index:200, so z-index alone can't say which is on top.
let _drawerOpenSeq = 0;
function openDrawer(sel) {
  const d = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!d) return;
  d.dataset.openSeq = String(++_drawerOpenSeq);
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  // Order drawer opens in focus mode: raise the blur+dim scrim behind it.
  // Drawers that open in focus mode raise a blur+dim scrim behind them. Keyed
  // by id so no other drawer changes behaviour.
  const scrimId = { 'order-drawer': 'order-scrim', 'cu-drawer': 'cu-scrim' }[d.id];
  if (scrimId) {
    const sc = document.getElementById(scrimId);
    if (sc) sc.classList.add('show');
  }
}
function closeDrawer(sel) {
  const d = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!d) return;
  d.classList.remove('open');
  // Order drawer: drop the focus scrim (and the legacy in-flow page mode)
  // synchronously so the list returns at once.
  if (d.id === 'order-drawer') document.body.classList.remove('ord-viewing');
  const closeScrimId = { 'order-drawer': 'order-scrim', 'cu-drawer': 'cu-scrim' }[d.id];
  if (closeScrimId) {
    const sc = document.getElementById(closeScrimId);
    if (sc) sc.classList.remove('show');
  }
  d.setAttribute('aria-hidden', 'true');
  const key = typeof sel === 'string' ? sel : '#' + d.id;
  const hook = _drawerCloseHooks.get(key);
  if (hook) setTimeout(hook, 240);
}
// Topmost open drawer = the one opened most recently (highest data-open-seq),
// not the last in DOM source order. `>=` means a tie (drawers with no stamp,
// seq 0) falls through to the last-in-DOM element — the old behaviour, kept
// as a safe fallback for any drawer opened without openDrawer(). Callers pass
// the candidate set: Esc weighs every open drawer, outside-click only the
// dw-dismiss ones.
function topmostOpenDrawer(open) {
  const list = open || document.querySelectorAll('.side-drawer.open');
  let top = null, best = -Infinity;
  list.forEach((d) => {
    const seq = Number(d.dataset.openSeq || 0);
    if (seq >= best) { best = seq; top = d; }
  });
  return top;
}
// Close the topmost drawer, but if it's an order opened from a customer's
// Recent-orders row, step back to that customer's detail instead of closing
// out to the bare order list — mirroring the ← button. Shared by Esc and the
// outside-click handler so keyboard and mouse agree.
function dismissTopDrawer(top) {
  if (!top) return;
  if (top.id === 'order-drawer' && _ORDER_BACK_CUSTOMER) { orderDrawerBack(); return; }
  closeDrawer(top);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  dismissTopDrawer(topmostOpenDrawer());
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
  // The shared Tacet dialogs (`.tdlg-scrim` — askConfirm / askPrompt /
  // askReason) layer on top the same way, but unlike the pickers above they do
  // NOT delete themselves on click: close() fades the scrim and removes it
  // 260ms later. So the confirming click is still attached when it reaches
  // here and reads as a genuine outside-click — which closed the drawer under
  // every confirm, and the close hook then wiped the drawer's mount 240ms
  // later, blanking the body of the drawer the action had just re-rendered
  // (the "blank order drawer after Combine into one parcel" report). Covers
  // the dialog's own dimmed backdrop too, which cancels the same way.
  if (e.target.closest('.tdlg-scrim')) return;
  // Dashboard activity rows open the order drawer on click — that same click
  // bubbles here, so exempt them or the drawer closes the instant it opens.
  // .td-nrow = the "Needs you" rows (delivery, refunds, awaiting restock,
  // invoices, restock), each of which jumps to a filtered list or opens a
  // drawer. .td-attn-row = the Inventory card's running-low rows, which open the
  // product. Both would otherwise close the very drawer their click opened.
  // tr.vch-row = the Coupons table rows, which open the coupon drawer on click.
  // .dp-work-row = the "Orders waiting for a delivery point" rows, which open
  // the parked order (dashOpenNeedsPoint). The row was wired from its first
  // build and still did nothing: openOrder() adds .open synchronously, this
  // listener then ran on the SAME click and closed it again before paint — so
  // it read as a dead link rather than as a drawer that flashed.
  if (e.target.closest('tr.order-row, tr.cul-row, tr.vch-row, .db-feed-row, .dp-work-row, .td-nrow, .td-attn-row')) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.toString().length > 0) return;
  // Same topmost + back-to-customer semantics as Esc, over the dw-dismiss set,
  // so an outside-click on an order opened from a customer steps back to that
  // customer rather than dropping to the order list.
  dismissTopDrawer(topmostOpenDrawer(open));
});
// Order-drawer cleanup hook — clear the mount after slide-out.
onDrawerClose('#order-drawer', () => {
  teardownCourierMap();            // stop polling + destroy the AMap instance
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
  // The row's own selection checkbox is inside the row, so without this Space
  // would tick it AND open the drawer, and the preventDefault below would stop
  // the tick from registering at all. Same bail the click handler makes.
  if (document.activeElement.matches('input, button, a, select, textarea')) return;
  e.preventDefault();
  const id = row.dataset.orderId;
  if (id) openOrder(Number(id));
});

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
    return `<button class="btn btn-danger btn-sm" onclick="transition(${o.id}, '${next}', event)">${label}</button>`;
  }
  const items = dangerTx.map(([next, label]) =>
    `<button class="odm-item" onclick="orderDangerPick(${o.id}, '${next}', event)">${label}</button>`
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
function orderDangerPick(id, next, ev) {
  orderDangerClose();
  transition(id, next, ev);
}
// What this order's LINES add up to, or null when they can't be trusted to add
// up to anything — no items, or any line without a price. Same rule as the
// server's itemsTotalOf (routes/eleme-internal.js), and the null case is what
// keeps every Meituan order (whose lines carry ¥0 by design) out of the
// disagreement check below.
function ordItemsTotal(o) {
  const items = (o && o.items) || [];
  if (!items.length) return null;
  if (!items.every(it => Number(it.line_total) > 0)) return null;
  return Math.round(items.reduce((a, it) => a + Number(it.line_total), 0) * 100) / 100;
}
// Does the order total agree with the items listed under it? Mirrors
// totalDisagreement() on the server, tolerance included: ¥5 or 30% of the basket,
// which absorbs packing, delivery and an ordinary promotion — plus, unlike the
// server version (which only ever sees a channel's own total vs its own lines),
// points/voucher/wallet redemption, since this drawer also renders the store's
// own orders where a customer can legitimately pay most of the basket with
// points. Order 1557 (¥546 of items, ¥522 redeemed in points, ¥10 packing) has
// no disagreement at all — 546 + 10 − 522 = 34, exactly o.total — but comparing
// raw items to o.total ignored the redemption and flagged it as one anyway.
//
// This exists because the drawer had no way to be wrong OUT LOUD. On
// EL20260901417897 it printed "¥17.50 · subtotal ¥17.50 · shipping ¥0.00" as a hero
// banner directly above ¥38 + ¥29 + ¥200 of items — an arithmetic claim its own
// item list contradicted, rendered with a total's full authority. Neither figure
// is knowably the wrong one from here (a channel order's total is the platform's
// claim; the lines are the platform's other claim), so the drawer now says that,
// instead of picking one and looking confident.
function ordMoneyGap(o) {
  const items = ordItemsTotal(o);
  const total = Number(o && o.total);
  if (items == null || !Number.isFinite(total)) return null;
  const surcharges = Number(o.shipping_fee || 0) + Number(o.packing_fee || 0);
  const deductions = Number(o.voucher_amount || 0) + Number(o.points_amount || 0) + Number(o.balance_used || 0);
  const expected = Math.round((items + surcharges - deductions) * 100) / 100;
  const gap = Math.round((expected - total) * 100) / 100;
  if (Math.abs(gap) <= Math.max(5, items * 0.3)) return null;
  return { items, total, gap };
}
// The band under the total banner when the two disagree. Amber, matching the
// other "read this before you act" bands in the drawer — it is not an error, and
// on a channel order it may well be a real platform discount. It names the
// refund ceiling because that is the practical consequence: refunds are capped
// at `total` (routes/retail.js orderTenders), so an operator refunding "all the
// lines" on this order gets the smaller number and no explanation.
function orderMoneyGapBand(o) {
  const g = ordMoneyGap(o);
  if (!g) return '';
  const chan = ordChannelLabel(o);
  return `
    <div style="margin: 0 0 var(--s5); padding: 10px 14px; border-radius: var(--r-lg); background: #FBF0DC; color: #8A6516; font-size: 12px; line-height: 1.5; font-weight: 600;">
      ${cuT(`Items add up to ${acMoney(g.items)}, but this order records ${acMoney(g.total)}.`,
            `商品合计 ${acMoney(g.items)}，但订单金额为 ${acMoney(g.total)}。`)}
      ${cuT(`Refunds on this order are capped at ${acMoney(g.total)} — check ${escapeHtml(chan)} before refunding.`,
            `本单退款上限为 ${acMoney(g.total)}，退款前请先核对 ${escapeHtml(chan)}。`)}
    </div>`;
}
// Money breakdown under the order total: subtotal · shipping · (packing) · (voucher).
// Packing fee only renders when one was actually charged (zero on most delivery
// orders), mirroring how the voucher segment is conditional.
function orderTotalSubline(o) {
  let s = `${cuT('subtotal','小计')} ${acMoney(o.subtotal)} · ${cuT('shipping','运费')} ${acMoney(o.shipping_fee)}`;
  if (Number(o.packing_fee) > 0)    s += ` · ${cuT('packing','打包费')} ${acMoney(o.packing_fee)}`;
  // Deductions last, grouped. Points and wallet were missing entirely, so an
  // order paid partly from either showed charges that read like a total and
  // weren't one — 44 of 616 live orders, two off by more than ¥1000. Wallet is
  // what the Customers page calls balance_used, so the two surfaces agree.
  if (Number(o.voucher_amount) > 0) s += ` · ${cuT('voucher','优惠券')} −${acMoney(o.voucher_amount)}`;
  if (Number(o.points_amount) > 0)  s += ` · ${cuT('points','积分')} −${acMoney(o.points_amount)}`;
  if (Number(o.balance_used) > 0)   s += ` · ${cuT('wallet','钱包')} −${acMoney(o.balance_used)}`;
  return s;
}
function renderOrderTotalBanner(o) {
  return `
    <div class="order-total-banner">
      <div>
        <div class="otb-label">Order total · 订单总额</div>
        <div class="otb-sub">${orderTotalSubline(o)}</div>
      </div>
      <div class="otb-amount">${acMoney(o.total)}</div>
    </div>
    ${orderMoneyGapBand(o)}
    ${renderChannelMoneyPanel(o)}`;
}

// Channel money breakdown — Meituan and Eleme both take a commission on what
// the customer paid, and both reduce to the same two steps:
//   items + packaging + delivery − merchant discount = customer paid (o.total)
//   customer paid − commission                       = estimated income
// gzgrocery is a wholesale ledger channel with no per-order commission, and a
// non-channel order (wechat/manual/pickup) has none either — both fall through
// to the empty string, so the panel adds nothing where there is nothing to add.
//
// RECONCILE, DON'T TRUST COLUMN PRESENCE. packing_fee/shipping_fee both default
// to 0, so "the column has a value" is true whether a fee was genuinely zero or
// was never captured (true of every Eleme row mirrored before PR #200 taught
// ingest to write them). The arithmetic itself is the test: if the components
// on the order don't add up to the order's own total, the breakdown is
// incomplete and says so — it never prints a derived commission/income figure
// that would silently disagree with the channel.
//
// channel_discount is written by BOTH ingests now — Meituan's always has, and
// Eleme's does since PR #209, out of settlementInfo.merchantActivityInfo.total.
// (This paragraph said the opposite while that was still true; #209 is the
// change that stopped it being true, so it is corrected here rather than left
// to mislead the next reader of a panel it describes.)
//
// The incomplete state it described has NOT gone away, and the arithmetic above
// is still what decides it. An Eleme order mirrored before #209 has no discount
// recorded and cannot reconcile until the backfill runs
// (scripts/repair_eleme_ingest_backfill.js), and either channel leaves the
// column NULL when the platform never named a promotion. Neither is a number
// this read-only panel may invent — it shows the rows it has and says so.
//
// WHAT IT SAYS, though, is now two different things. "Breakdown incomplete"
// covered both an order that adds up and is only waiting on the platform to
// publish its commission, and one whose own columns disagree — and the operator
// had no way to tell which. EL20260903163199 came in at ¥45.00 + ¥1.50 + ¥5.00
// − ¥5.50 = ¥46.00 against a recorded total of ¥41.00, a gap of exactly its
// delivery fee, and all the drawer would say about it was the same three words
// it said over every unsettled Meituan order in the table. So the unreconciled
// case now prints the sum, the total and the difference: the panel is the place
// that disagreement is visible, and hiding the figure behind a label made it
// somebody's archaeology project weeks later.
//
// The same identity runs server-side at ingest (lib/channel-settlement.js, via
// routes/eleme-internal.js), so an order that arrives like this writes an
// order_settlement_mismatch row in eleme_sync_log with the payload field each
// figure was read out of — nobody has to open a drawer to find out. The two
// copies of the arithmetic exist because retail-admin loads plain <script> tags
// with no module system; scripts/test_channel_money_panel.js §4c runs both over
// one table of orders so they cannot drift apart unnoticed.
function channelMoneyBreakdown(o) {
  const items      = Number(o.subtotal) || 0;
  const packaging  = Number(o.packing_fee) || 0;
  const delivery   = Number(o.shipping_fee) || 0;
  const discount   = Number(o.channel_discount) || 0;
  const total      = Number(o.total) || 0;
  const hasCommission = o.channel_commission != null;
  const hasSettle     = o.channel_settle_amount != null;
  const expected   = Math.round((items + packaging + delivery - discount) * 100) / 100;
  const reconciled = Math.abs(expected - total) < 0.01;
  return {
    items, packaging, delivery, discount,
    commission: hasCommission ? Number(o.channel_commission) : null,
    settle:     hasSettle ? Number(o.channel_settle_amount) : null,
    // What the components add up to, and by how much that misses the total. Kept
    // as numbers rather than folded into `complete` because the note below has
    // to print them: an operator asked to distrust a panel is owed the figure
    // that made it distrustable.
    expected, gap: Math.round((expected - total) * 100) / 100, total,
    // The two reasons a panel can't show step two, separated. They were one flag
    // and one message, which is why EL20260903163199's drawer could say only
    // "Breakdown incomplete" over an order whose components missed its total by
    // exactly the delivery fee.
    reconciled,
    // Every component adds up, and the platform simply hasn't published what it
    // kept yet. Normal on an order still in flight; NOT a data fault.
    awaitingSettlement: reconciled && !(hasCommission && hasSettle),
    complete:   reconciled && hasCommission && hasSettle,
  };
}
function renderChannelMoneyPanel(o) {
  const c = String(o.channel || '').toLowerCase();
  if (c !== 'meituan' && c !== 'eleme') return '';
  const g = channelMoneyBreakdown(o);
  const rows = [];
  if (g.items > 0)     rows.push([cuT('subtotal', '小计'), g.items]);
  if (g.packaging > 0) rows.push([cuT('packing', '打包费'), g.packaging]);
  if (g.delivery > 0)  rows.push([cuT('Customer delivery fee', '顾客配送费'), g.delivery]);
  if (g.discount > 0)  rows.push([cuT('Merchant discount', '商家对顾客的活动补贴'), -g.discount]);
  if (!rows.length && g.commission == null && g.settle == null) return '';

  const rowHtml = ([label, v]) => `
      <div class="cmp-row"><span>${label}</span><span class="cmp-v">${v < 0 ? '−' : ''}${acMoney(Math.abs(v))}</span></div>`;
  const commissionRow = (g.complete && g.commission)
    ? `<div class="cmp-row cmp-deduct"><span>${cuT('Commission', '佣金')}</span><span class="cmp-v">−${acMoney(Math.abs(g.commission))}</span></div>`
    : '';
  const netRow = (g.complete && g.settle)
    ? `<div class="cmp-row cmp-net"><span>${cuT('Estimated income', '预计收入')}</span><span class="cmp-v">${acMoney(g.settle)}</span></div>`
    : '';
  // Say WHICH of the two it is, and in the unreconciled case say by how much.
  // "Breakdown incomplete" was true of both states and actionable in neither —
  // an operator reading it could not tell a settlement Eleme hasn't published
  // yet from an order whose own columns disagree, and the second is the one
  // worth a phone call. The gap is named because the sum shown above it is the
  // evidence: ¥45.00 + ¥1.50 + ¥5.00 − ¥5.50 reads as ¥46.00 on screen while
  // the banner says ¥41.00, and the panel should be the thing that points that
  // out rather than the thing that hides it.
  let note = '';
  if (!g.reconciled) {
    note = `<div class="cmp-note">${cuT(
      `These rows add up to ${acMoney(g.expected)}, but the order records ${acMoney(g.total)} — ${acMoney(Math.abs(g.gap))} unaccounted for. Check the channel before refunding.`,
      `以上各项合计 ${acMoney(g.expected)}，但订单金额为 ${acMoney(g.total)} — 相差 ${acMoney(Math.abs(g.gap))}。退款前请先核对平台。`)}</div>`;
  } else if (g.awaitingSettlement) {
    note = `<div class="cmp-note">${cuT(
      'Commission and income not published by the channel yet.',
      '平台尚未公布佣金与预计收入。')}</div>`;
  }

  // A DIV, never a <section>: retail-admin.css:940's `section {display:none}`
  // tab rule is unscoped and hides a nested one at any depth, which is exactly
  // what happened to this panel between PR #206 and 2026-09-02. See
  // docs/tacet-desktop-patterns.md §1.22.
  return `
    <div class="cmp">
      <h3 class="cmp-h">${cuT('Settlement', '结算明细')}</h3>
      ${rows.map(rowHtml).join('')}
      ${commissionRow}
      ${netRow}
      ${note}
    </div>`;
}

// One line of the VIEW-ONLY manifest (Meituan / gzgrocery). Product name + its
// type (the second-language name / size), SKU chip, and quantity — no prices
// (Meituan lines carry ¥0 per-line; the real figure is the order total up top)
// and no pack/fulfilment badges, since we don't ship these from here.
function renderReadonlyItemRow(it, i) {
  const nm = orderItemNames(it);
  const name = `<span class="mf-name">${escapeHtml(nm.primary)}</span>`;
  const href = productHref(it.product_id);
  const nameCell = href
    ? `<a href="${href}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${name}</a>`
    : name;
  const type = it.size ? `<span class="mf-zh">${escapeHtml(it.size)}</span>` : '';
  return `
    <div class="mf-row" data-fk="${it.id}">
      <span class="mf-num">${String(i + 1).padStart(2, '0')}</span>
      ${itemThumb(it)}
      <div class="mf-body">
        <div class="mf-top">${nameCell}</div>
        <div class="mf-meta" data-no-i18n>${type}${itemSkuHtml(it)}${itemQtyHtml(it)}</div>
      </div>
    </div>`;
}

// View-only order detail for read-only channels (Meituan / gzgrocery). These are
// mirrored in for visibility — we don't fulfil, print, refund or edit them — so
// the drawer shows just the essentials plus a per-line product / SKU / qty
// manifest, and none of the mutating controls the full renderOpenOrder carries.
function renderReadonlyOrder(o) {
  const mount = $('#order-detail-mount');
  // View-only channels can't (re)print a receipt — collapse the print footer.
  const foot = $('#order-drawer-foot');
  if (foot) foot.innerHTML = '';
  const items = o.items || [];
  const cust = (typeof ordCustomerLines === 'function') ? ordCustomerLines(o) : { name: o.nickname || o.recipient_name || '—', phone: o.recipient_phone || '' };
  const chan = ordChannelLabel(o);
  const hasCust = (cust.name && cust.name !== '—') || cust.phone;
  // Same-city courier (Qingyun). Meituan's own delivery is fulfilled by a Qingyun
  // rider, so once the daemon links this mirrored order to its waybill (via the
  // platform order number) we show the SAME live rider card + AMap map our own
  // orders use — AND the same courier picker. A Meituan order now lands in Qingyun
  // as a 待配送 delivery (自动分单), and the dispatch routes already resolve an order's
  // Qingyun id via delivery_jobs, so staff can compare carriers and call a rider
  // straight from here — no fragile Meituan button-press needed. renderQyDispatch
  // renders card + map + the compare/dispatch button, and hides the button once a
  // rider is genuinely on the way. Gated on o.courier: an order with no Qingyun
  // delivery has nothing to dispatch. The map mounts via mountCourierMap(o).
  const courierBlock = o.courier ? renderQyDispatch(o) : '';
  // Once the order carries a dispatchable Qingyun delivery, "view only" is no longer
  // true — staff can call the rider from right here. Keep the tag only for orders we
  // genuinely can't act on (accept/prepare still live on the platform either way).
  const roTag = o.courier ? '' : ` · ${cuT('view only', '只读')}`;
  // 预订单: the customer booked a delivery window instead of ordering for now, so
  // this is NOT due immediately. Without saying so the drawer reads exactly like a
  // normal order and the bag gets packed hours early (or, worse, at the last
  // minute because the ETA looked far off). Amber, matching the other "read this
  // before you act" bands in the drawer.
  const preOrder = !!o.channel_preorder_at;
  mount.innerHTML = `
    <div class="order-card">
      <div class="order-head">
        <div class="od-head-main">
          <div class="title-row">
            <b>${escapeHtml(o.order_no)}</b>
            ${(() => { const p = orderStatusPill(o); return `<span class="pill ${p.cls}"><span class="dot"></span>${p.label}</span>`; })()}
            <span class="pill" style="background: var(--bg-elev-1); color: var(--text-2);" title="${escapeHtml(chan)} orders are mirrored in for visibility — accept &amp; prepare them in ${escapeHtml(chan)}">${escapeHtml(chan)}${roTag}</span>
            ${preOrder ? `<span class="pill" style="background:#FBF0DC; color:#8A6516;"><span class="dot" style="background:#B98B21;"></span>${cuT('Pre-order', '预订单')}</span>` : ''}
          </div>
          <div class="od-eyebrow"><span>Order placed · 下单于</span> ${formatDate(o.placed_at)}</div>
        </div>
      </div>

      ${courierBlock}

      <div class="order-detail">
        ${o.store_code ? `<div>
          <div class="kicker">Store · 门店</div>
          <div class="val"><b>${escapeHtml(o.store_name_en || o.store_code)}</b></div>
        </div>` : ''}
        ${(() => {
          // Eleme's own card is gone (Ash, 2026-09-02): channel_status had read
          // "VALID" on 100% of live Eleme orders — an order-validity flag, never
          // a lifecycle stage — so this cell showed "In progress" on every
          // delivered Eleme order since it shipped.
          //
          // The read behind it is fixed since: lib/eleme-browser.js pickStage
          // now takes the stage from the fields that carry one and steps over
          // the validity flag, so channel_status on a NEW Eleme order holds a
          // real label. The card stays out anyway — that is still Ash's call to
          // reverse, and rows mirrored before the fix keep their "VALID" — but
          // it is now one line, and channelStatusMeta above refuses a flag on
          // every channel so nothing can render one as a stage again. The drawer's own status pill
          // above already carries Tacet's real status, and the lifecycle
          // timestamps below are complete on every row, so nothing here was
          // telling staff something they couldn't already see. Meituan and
          // gzgrocery are untouched: Meituan reads one named field
          // (statusDesc) exactly right, and is what staff actually watch.
          if (String(o.channel || '').toLowerCase() === 'eleme') return '';
          const meta = channelStatusMeta(o.channel_status);
          if (!meta) return '';
          // The platform label can read "Delivered" (已送达/用户已收餐/妥投…) while the
          // live rider is still on the map — Meituan stamps its own completion when the
          // rider taps done or the customer auto-confirms, which can fire before the real
          // handoff. In that case don't present a bare, confident "Delivered" next to a
          // rider card that says "on the way": flag it as the platform's own report so
          // staff trust the live rider (the ground truth) over Meituan's bookkeeping.
          const riderDone = !!(o.courier && (o.status === 'delivered' || o.courier.stage === 'delivered'));
          const platformAheadOfRider = meta.tone === 'delivered' && !!o.courier && !riderDone;
          // The mirror lags in the OTHER direction too, and far more often: the
          // rider drops the parcel (courier stage → delivered, which flips our own
          // status), and Meituan's ~5-min status poll only catches up minutes later.
          // In between, this field says "Rider en route" beside a Delivered pill, a
          // Delivered rider card and a stamped arrival time — three rows of the same
          // drawer contradicting each other, and the one that sounds live is the
          // stale one. Only the rider's OWN drop-off earns this caveat (not the
          // past-ETA timer flip, which is a guess), and only over a still-moving
          // platform label — a 已取消/已退款 label is a real conflict, not a lag,
          // and must never be waved away as one.
          const platformBehindRider = !!(o.courier && o.courier.stage === 'delivered')
            && ['pending_payment', 'paid', 'preparing', 'dispatched'].includes(meta.tone);
          const caveat = platformAheadOfRider
            ? `<div class="sub" style="color:#9A6E2A;">${cuT('Platform-reported · rider still on the way', '平台标记 · 骑手仍在配送')}</div>`
            : platformBehindRider
            ? `<div class="sub" style="color:#9A6E2A;">${cuT('Platform label lagging · rider has delivered', '平台状态滞后 · 骑手已送达')}</div>`
            : '';
          return `<div>
          <div class="kicker">${escapeHtml(chan)} status · 平台状态</div>
          <div class="val" data-no-i18n><b>${escapeHtml((typeof cuT === 'function') ? cuT(meta.en, meta.cn) : meta.en)}</b></div>
          ${caveat}
        </div>`;
        })()}
        ${(() => {
          // On a pre-order the headline time is the window the CUSTOMER booked,
          // not an ETA we're racing — say which it is, so nobody reads a 15:30 on
          // a 12:03 order as a late delivery. Falls back to the plain ETA cell for
          // every normal order.
          // Landed orders show the real drop-off time instead of the promise —
          // same rule as the list's delivery cell: delivered_at is stamped by the
          // rider's actual drop-off, so it answers "when did it arrive"; the ETA
          // can still be in the future while the pill already reads Delivered.
          // No delivered_at (platform label / past-ETA timer flip) → keep the ETA.
          const arrivedAt = o.status === 'delivered' ? (o.delivered_at || null) : null;
          const when = arrivedAt || (preOrder ? (o.channel_preorder_at || o.channel_eta) : o.channel_eta);
          if (!when) return '';
          return `<div>
          <div class="kicker">${arrivedAt ? 'Arrived · 送达' : preOrder ? 'Booked for · 顾客预约' : 'ETA · 预计送达'}</div>
          <div class="val"><b>${escapeHtml(formatEtaClock(when))}</b></div>
          <div class="sub">${formatDate(when)}</div>
        </div>`;
        })()}
        ${o.address_full ? `<div class="full">
          <div class="kicker">Ship to · 收货人 ${copyChip([cust.name !== '—' ? cust.name : '', cust.phone, o.address_full].filter(Boolean).join('\n'), 'Ship-to')}</div>
          <div class="val" data-no-i18n><b>${escapeHtml(cust.name)}</b>${cust.phone ? ` · ${escapeHtml(cust.phone)}` : ''}</div>
          <div class="sub" data-no-i18n>${escapeHtml(o.address_full)}</div>
        </div>` : hasCust ? `<div>
          <div class="kicker">Customer · 顾客</div>
          <div class="val" data-no-i18n><b>${escapeHtml(cust.name)}</b></div>
          ${cust.phone ? `<div class="sub" data-no-i18n>${escapeHtml(cust.phone)}</div>` : ''}
        </div>` : ''}
        <div>
          <div class="kicker">Total · 合计</div>
          <div class="val"><b>${acMoney(o.total)}</b></div>
          <div class="sub">${cuT(`${items.length} line${items.length === 1 ? '' : 's'}`, `${items.length} 项`)}</div>
        </div>
        ${(() => {
          // The mirrored drawer prints no per-line prices, so a total that
          // disagrees with the lines is not merely unexplained here — it is
          // unfalsifiable, with the contradicting evidence off-screen. Say it.
          const g = ordMoneyGap(o);
          if (!g) return '';
          return `<div class="full" style="color:#8A6516;">
            <div class="kicker">${cuT('Total disagrees with the items', '金额与商品不符')}</div>
            <div class="sub">${cuT(`Items add up to ${acMoney(g.items)} — check ${escapeHtml(chan)}.`,
                                   `商品合计 ${acMoney(g.items)}，请核对 ${escapeHtml(chan)}。`)}</div>
          </div>`;
        })()}
      </div>

      ${renderChannelMoneyPanel(o)}

      <div>
        <div class="kicker" style="margin: 14px 0 6px;">Items · 商品</div>
        <div class="manifest">
          ${items.length
            ? items.map((it, i) => renderReadonlyItemRow(it, i)).join('')
            : `<div class="muted" style="padding: 8px 0;">${cuT('No line items captured', '未记录商品明细')}</div>`}
        </div>
      </div>

      ${o.customer_note ? `<div>
        <div class="kicker" style="margin: 14px 0 6px;">Customer note · 顾客备注</div>
        <div data-no-i18n style="font-weight: 700; color: var(--text-1); font-size: 14px; line-height: 1.5;">${escapeHtml(o.customer_note)}</div>
      </div>` : ''}
      ${o.needs_cutlery ? `<div style="margin-top: 10px;"><span style="display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--text-1); background: var(--bg-elev-2); border: 1px solid var(--line); border-radius: 99px; padding: 4px 12px; font-size: 12px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 3v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3"/><path d="M6 11v10"/><path d="M17 3c-1.7 0-3 2-3 5s1.3 4 3 4"/><path d="M17 3v18"/></svg> Cutlery requested · 需要餐具</span></div>` : ''}
    </div>`;
  // The mirrored view pins its header too — the two drawers must read as
  // siblings (§1.13). It has no action row, so its pinned block is the order
  // no + pills line and nothing else.
  ordBindHeadPin();
}

// Romanise a Chinese city name for the English view of the split note (the
// stored shipping_city is Chinese, e.g. "上海市"). Strips the 省/市/区 suffix,
// looks it up, and falls back to the original Chinese when the city isn't
// mapped — never guesses a romanisation.
const CITY_EN = {
  '北京':'Beijing','上海':'Shanghai','广州':'Guangzhou','深圳':'Shenzhen','天津':'Tianjin','重庆':'Chongqing',
  '成都':'Chengdu','杭州':'Hangzhou','武汉':'Wuhan','西安':'Xi’an','南京':'Nanjing','苏州':'Suzhou','郑州':'Zhengzhou',
  '长沙':'Changsha','东莞':'Dongguan','佛山':'Foshan','宁波':'Ningbo','青岛':'Qingdao','沈阳':'Shenyang','济南':'Jinan',
  '合肥':'Hefei','昆明':'Kunming','福州':'Fuzhou','厦门':'Xiamen','哈尔滨':'Harbin','大连':'Dalian','南宁':'Nanning',
  '珠海':'Zhuhai','惠州':'Huizhou','中山':'Zhongshan','汕头':'Shantou','贵阳':'Guiyang','太原':'Taiyuan','石家庄':'Shijiazhuang',
  '南昌':'Nanchang','长春':'Changchun','温州':'Wenzhou','无锡':'Wuxi','常州':'Changzhou','嘉兴':'Jiaxing','金华':'Jinhua',
  '兰州':'Lanzhou','海口':'Haikou','三亚':'Sanya','乌鲁木齐':'Urumqi','呼和浩特':'Hohhot','银川':'Yinchuan','西宁':'Xining','拉萨':'Lhasa',
};
function cityEn(city) {
  if (!city) return '';
  const bare = String(city).replace(/(省|市|自治区|特别行政区|地区)$/, '').trim();
  return CITY_EN[bare] || String(city);
}

// The customer moved this order's ship-to after placing it. Anything already
// read, printed, or written on a label is stale, so before it goes out this is
// an amber attention band with the instruction on it — the same treatment the
// split/combine notes use. Once it HAS gone out the instruction is moot, so it
// drops to a quiet trace: the fact stays on the record, the nagging doesn't.
function addressChangedNote(o) {
  if (!o.address_changed_at) return '';
  const when = escapeHtml(formatDate(o.address_changed_at));
  if (o.dispatched_at) {
    return `<div class="od-addr-moved-past">${cuT('Address changed by the customer', '顾客修改了收货地址')} · ${when}</div>`;
  }
  return `<div class="outside-gz-note od-addr-moved">
    <span class="ogz-ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
    <span class="ogz-text">
      <span class="ogz-h"><span data-lang-block="en">Address changed by the customer</span><span data-lang-block="cn">顾客修改了收货地址</span></span>
      <span class="ogz-sub"><span data-lang-block="en">Check the shipping label against the address above before this goes out · ${when}</span><span data-lang-block="cn">发货前请核对面单与上方地址 · ${when}</span></span>
    </span>
  </div>`;
}

// Guest pay link — the QR/link a customer without an app account uses to pay
// this one order at /pay/:token.
//
// It used to live ONLY in the post-create modal (#om-done-bg), which meant it
// existed for the few seconds after an order was made and was unreachable ever
// again: an operator who closed that dialog, or who took the payment call an
// hour later, had no way back to it. Moving it here is why that modal could be
// deleted rather than replaced — the link belongs to the order, so it lives
// where the order does.
//
// Only while unpaid and only when there is something to pay: a paid order has
// nothing to collect, and a zero-total order has no payment page. The server
// applies the same two conditions when it mints the link on create.
function orderPayLinkTile(o) {
  if (!o || o.status !== 'pending_payment' || !o.pay_token) return '';
  if (!(Number(o.total) > 0)) return '';
  const url = location.origin + '/pay/' + o.pay_token;
  return `<div>
    <div class="kicker">${cuT('Payment link', '付款链接')} ${copyChip(url, cuT('Payment link', '付款链接'))}</div>
    <div class="val"><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${cuT('Open pay page', '打开付款页')}</a></div>
    <div class="sub">${cuT('Send this to the customer, or show the page for them to scan.', '发给顾客,或打开页面让其扫码支付。')}</div>
  </div>`;
}
function renderOpenOrder(o) {
  // Read-only channels (Meituan / gzgrocery) get a stripped view-only panel —
  // no fulfilment, refund or edit controls, which don't apply to a mirrored order.
  if (typeof ordIsReadonlyChannel === 'function' && ordIsReadonlyChannel(o)) {
    return renderReadonlyOrder(o);
  }
  const mount = $('#order-detail-mount');
  const multiParcel = (o.shipments?.length || 0) > 1;
  // Split the status actions: the green "go forward" ones stay as plain
  // buttons; the red refund-type ones (Refund / Cancel + refund) collapse
  // into a single menu button so the header isn't a wall of red.
  const allTx = nextStatusFor(o);
  const dangerTx = allTx.filter(([next]) => next === 'cancelled' || next === 'refunded');
  const forwardTx = allTx.filter(([next]) => next !== 'cancelled' && next !== 'refunded')
    .map(([next, label]) => {
      // With multiple parcels the whole-order dispatch acts as "ship all at
      // once" — relabel so it's distinct from each parcel's own button.
      if (next === 'dispatched' && multiParcel && o.fulfillment_type !== 'pickup') {
        label = 'Mark all dispatched · 全部标记已发货';
      }
      // Tacet: forward actions read as calm bordered buttons (not a second Dusk
      // CTA) — the mockup keeps the drawer quiet; the one Dusk button is "New order".
      return `<button class="btn btn-sm" onclick="transition(${o.id}, '${next}', event)">${label}</button>`;
    }).join('');
  // The header PINS (§1.13a), so its height is fixed and its contents are
  // rationed. Row 1 = order no + the ONE primary status pill; row 2 = the
  // actions. Print receipt joins that row — pushed to the right edge so it sits
  // in the same place on every order regardless of how many state buttons the
  // order has (it used to live in a footer bar at the drawer's bottom). The
  // secondary controls — Undo, Box label — fold into the ⋯ menu, which is what
  // caps the row at four visible controls so it can never wrap to a second line
  // and grow the pinned block. Everything else the title row used to carry
  // (placed time, partial-shipped, add-ons, refund, stock-pending, a failed
  // print) moves to the marks line below, in the scrolling body.
  const refundMenu = renderRefundMenu(o, dangerTx);
  const printBtn = orderHeadPrint(o);
  const moreMenu = orderHeadMore(o);
  const headActions = (forwardTx || refundMenu || printBtn || moreMenu)
    ? forwardTx + refundMenu + '<span class="od-head-push"></span>' + printBtn + moreMenu
    : '';
    mount.innerHTML = `
      <div class="order-card">
        ${_ORDER_BACK_CUSTOMER ? `<button class="btn btn-sm order-back-cust" style="margin-bottom: var(--s3);" onclick="cuBackToCustomer()">← Back to customer · 返回顾客</button>` : ''}
        <div class="order-head">
          <div class="title-row">
            <b>${escapeHtml(o.order_no)}</b>
            ${(() => { const p = orderStatusPill(o); return `<span class="pill ${p.cls}"><span class="dot"></span>${p.label}</span>`; })()}
          </div>
          ${headActions ? `<div class="transitions od-head-tx">${headActions}</div>` : ''}
        </div>
        ${orderHeadMarks(o)}

        ${hoistedTracking(o)}

        ${drawerRefundBanner(o)}
        ${renderRefundPanel(o)}

        <!-- Fapiao still owed = work the operator has to do, so it rides at the
             top where the eye lands. Once issued it is just a record: it drops
             back into the details grid below and logistics keeps the top. -->
        ${(o.needs_invoice && o.invoice_status !== 'issued')
          ? `<div style="margin-bottom: var(--s4);">${renderInvoiceBlock(o)}</div>` : ''}

        <!-- Order total — full-width hero banner above the info grid. -->
        ${renderOrderTotalBanner(o)}

        <div class="order-detail">
          ${ordIsCounter(o) ? `
          <div>
            <div class="kicker">${cuT('Counter sale','前台销售')} ${copyChip([o.recipient_name, o.recipient_phone].filter(Boolean).join('\n'), 'Counter')}</div>
            <div class="val" data-no-i18n><b>${escapeHtml(o.recipient_name || '')}</b>${o.recipient_phone ? ' · ' + escapeHtml(o.recipient_phone) : ''}</div>
            <div class="sub">${cuT('Handed over at the till','已在前台交付')}</div>
          </div>` : o.fulfillment_type === 'pickup' ? `
          <div>
            <div class="kicker">${pickupIcon(11)} Pickup · 到店自提 ${copyChip([o.recipient_name, o.recipient_phone, (o.address?.store_name_cn || o.store_name_cn || ''), (o.address?.address || '')].filter(Boolean).join('\n'), 'Pickup')}</div>
            <div class="val"><b>${escapeHtml(o.recipient_name || '')}</b> · ${escapeHtml(o.recipient_phone || '')}</div>
            <div class="sub">${cuT('Collects at','自提门店')} <b>${escapeHtml(o.address?.store_name_en || o.store_name_en || o.store_code || cuT('store','门店'))}</b>${o.address?.address ? ' · ' + escapeHtml(o.address.address) : ''}</div>
          </div>` : `
          <div>
            <div class="kicker">Ship to · 收货人 ${copyChip([o.recipient_name, o.recipient_phone, o.address_full].filter(Boolean).join('\n'), 'Ship-to')}</div>
            <div class="val" data-no-i18n><b>${escapeHtml(o.recipient_name || '')}</b> · ${escapeHtml(o.recipient_phone || '')}</div>
            <div class="sub" data-no-i18n>${escapeHtml(o.address_full || '')}</div>
            ${addressChangedNote(o)}
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
              <button class="btn btn-sm" onclick="openEditShipTo(${o.id})">${pinIcon(13)} ${cuT('Edit ship-to', '修改收货地址')}</button>
              ${/[A-Za-z]/.test(o.address_full || '') ? `<button class="btn btn-sm" onclick="openAddressToChinese(${o.id})">${pinIcon(13)} ${cuT('Make address Chinese', '转为中文地址')}</button>` : ''}
            </div>
          </div>`}
          <!-- The one-line facts (Customer / Payment / Fulfilled by / Ship by)
               were each a near-empty box — collapsed into one facts card of
               label→value rows. Ship-to stays its own card (it earns the space). -->
          <div class="od-facts">
            <div${o.customer_id ? ` onclick="orderGotoCustomer(${o.customer_id})" style="cursor: pointer;" title="View customer · 查看顾客"` : ''}>
              <div class="kicker">Customer · 顾客</div>
              <div class="val" data-no-i18n><b>${escapeHtml(o.nickname || o.recipient_name || '—')}</b>${o.customer_id ? ` <span style="color: var(--text-3); font-weight: 600;">› #${o.customer_id}</span>` : ''}</div>
            </div>
            ${(() => { const _pmt = primaryPayment(o); return `
            <div>
              <div class="kicker">Payment · 付款 ${_pmt?.transaction_id ? copyChip(_pmt.transaction_id, 'Txn ID') : ''}</div>
              <div class="val">${paymentBrandHTML(o.payment_method, 'lg')} · ${escapeHtml(paymentStatusLabel(_pmt?.status))}</div>
            </div>`; })()}
            ${orderPayLinkTile(o)}
            <!-- Voucher: same gate as the total line's voucher term, so the two can
                 never disagree. Code comes straight off the order, never looked up —
                 it stays true after the coupon is deleted. Printed EXACTLY as stored:
                 the uppercase is the merchant's code, not our typography. Don't
                 "fix" the case. Missing code reads as unknown, never a dash. -->
            ${Number(o.voucher_amount) > 0 ? `<div>
              <div class="kicker">${cuT('voucher','优惠券')}</div>
              <div class="val" data-no-i18n>${o.voucher_code ? `<b>${escapeHtml(o.voucher_code)}</b>` : cuT('not recorded','未记录')}</div>
            </div>` : ''}
            ${renderShipByTile(o)}
            ${o.store_code ? `<div>
              <div class="kicker">Fulfilled by · 出货门店</div>
              <div class="val"><b>${escapeHtml(o.store_name_en || o.store_code)}</b></div>
              <div class="sub">${escapeHtml(o.store_name_cn || '')}${routingNote(o.routing_reason) ? ' · ' + routingNote(o.routing_reason) : ''}${(o.channel && o.channel.toLowerCase() !== 'wechat') ? ' · ' + escapeHtml(o.channel) : ''}</div>
              ${rerouteShortNote(o)}
              ${o.routed_by_distance === 0 ? `<div class="sub" style="color: var(--warn); font-weight: 600;">⚠ ${cuT('routed by area — address not locatable, verify store','按区域派单 · 地址无法定位,请核对门店')}</div>` : ''}
            </div>` : ''}
          </div>
          ${fulfillmentShortStrip(o)}
          ${awaitingRestockCard(o)}
          ${renderAlipayProof(o)}
          ${o.customer_note ? `<div class="full"><div class="kicker">Customer note · 顾客备注</div><div style="font-weight: 700; color: var(--text-1); font-size: 14px; line-height: 1.5;">${escapeHtml(o.customer_note)}</div></div>` : ''}
          ${staffNoteBlock(o)}
          ${o.needs_cutlery ? `<div class="full"><span style="display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--text-1); background: var(--bg-elev-2); border: 1px solid var(--line); border-radius: 99px; padding: 4px 12px; font-size: 12px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 3v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3"/><path d="M6 11v10"/><path d="M17 3c-1.7 0-3 2-3 5s1.3 4 3 4"/><path d="M17 3v18"/></svg> Cutlery requested · 需要餐具</span></div>` : ''}
          ${(o.needs_invoice && o.invoice_status === 'issued') ? renderInvoiceBlock(o) : ''}
        </div>

        <div class="order-items">
          <div class="kicker oi-head" style="font-size: 10px; font-weight: 600; letter-spacing: .22em; text-transform: uppercase; color: var(--brass);">Items &amp; shipments · 商品与发货</div>
          ${_DISMISSED_SPLIT.has(o.id) ? '' : splitSuggestionBanner(o)}
          ${o.outside_guangzhou && (o.shipments?.length > 1) ? `
            <div class="outside-gz-note">
              <span class="ogz-ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
              <span class="ogz-text">
                <span class="ogz-h"><span data-lang-block="en">Split into ${o.shipments.length} parcels</span><span data-lang-block="cn">已拆分为 ${o.shipments.length} 个包裹</span></span>
                <span class="ogz-sub"><span data-lang-block="en">Destination outside Guangzhou (${escapeHtml(cityEn(o.shipping_city) || 'unknown city')})</span><span data-lang-block="cn">目的地在广州以外 (${escapeHtml(o.shipping_city || '未知城市')})</span></span>
              </span>
              ${shipmentMergeControls(o)}
            </div>` : ''}
          ${o.outside_guangzhou && (o.shipments?.length === 1) && (o.shipments[0].label || '').includes('合并') ? `
            <div class="outside-gz-note">
              <span class="ogz-ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></span>
              <span class="ogz-text">
                <span class="ogz-h"><span data-lang-block="en">Combined into one parcel</span><span data-lang-block="cn">已合并为一个包裹</span></span>
                <span class="ogz-sub"><span data-lang-block="en">Customer tracks a single shipment</span><span data-lang-block="cn">顾客只追踪一个包裹</span></span>
              </span>
              ${shipmentMergeControls(o)}
            </div>` : ''}
          <div id="odv-items-sortable">${renderSortableItems(o)}</div>
        </div>

        ${renderAddonTimeline(o)}

        ${(() => {
          // The reservation lifecycle (pending → committed) is inventory-side
          // plumbing an operator never acts on — for a healthy order it's pure
          // noise. So this audit table only surfaces when a hold is in an
          // ABNORMAL state worth diagnosing: expired, released back, or a
          // pending hold that has already sailed past its expiry (stuck).
          // A normal committed/pending order renders nothing.
          const resv = o.reservations || [];
          const nowMs = Date.now();
          const isStuck = (r) => r.status === 'pending' && r.expires_at
            && new Date(r.expires_at).getTime() < nowMs;
          const abnormal = resv.some(r =>
            r.status === 'expired' || r.status === 'released' || isStuck(r));
          if (!abnormal) return '';
          return `
        <details class="order-items resv-details" open style="margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--line-soft);">
          <summary class="kicker resv-summary" style="font-size: 10px; font-weight: 600; letter-spacing: .22em; text-transform: uppercase; color: var(--warn);">
            <span class="resv-caret" aria-hidden="true">▸</span>
            <span>Stock reservations — needs attention · 库存预留 — 需留意</span>
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
                  ? `<div>${escapeHtml(rn.primary)}</div>`
                  : `<span class="muted" style="font-family: var(--f-mono); font-size: 11px;">product_id ${r.product_id}</span>`;
                const _href = productHref(r.product_id);
                const cell = _href
                  ? `<a href="${_href}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${label}</a>`
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
        </details>`;
        })()}

      </div>`;
  // The bottom print bar is gone — Print receipt rides the pinned header now,
  // and the bar held nothing else worth its own 61px. Clear the slot so no
  // previous order's footer lingers; `.drawer-foot:empty` collapses it.
  const foot = $('#order-drawer-foot');
  if (foot) foot.innerHTML = '';
  // Drawer body manages its own scroll position; reset to top on each
  // render so re-renders after a transition don't leave it mid-scroll.
  const body = $('#order-drawer .drawer-body');
  if (body) body.scrollTop = 0;
  ordBindHeadPin();
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
    bg.className = 'pm-pick-bg tacet';
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

// askReason()/askConfirm() now live in /tacet-dialogs.js (shared across every
// admin page, loaded before this file in retail-admin.html) — same field
// contract (titleEn/titleCn, bodyEn/bodyCn, confirmEn/confirmCn, etc.) so
// every call site below is unchanged.

// Print receipt is the workhorse, so it sits in the PINNED header's action row
// (right edge — one fixed position on every order) rather than in a footer bar
// at the bottom of the drawer, where it was a hunt on a long panel. Returns ''
// for orders that can't have a receipt (unpaid / cancelled / refunded).
// The quiet "Prints at <store>" line that used to sit beside it is now this
// button's tooltip: it answers a question the operator asks once — which counter
// does this come out of — so it belongs on hover, not parked on screen.
// The per-MACHINE toggles (auto-print JD waybill, box-label-auto) live in
// Settings · Delivery — they were never order-specific.
function orderHeadPrint(o) {
  if (['pending_payment', 'cancelled', 'refunded'].includes(o.status)) return '';
  const where = o.store_code
    ? cuT('Prints at ' + (o.store_name_en || o.store_code), '打印于 ' + (o.store_name_cn || o.store_code))
    : cuT('Print the receipt slip', '打印小票');
  return `<button class="btn btn-sm" id="reprint-${o.id}" onclick="reprintOrder(${o.id})" title="${escapeAttr(where)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>${cuT('Print receipt','打印小票')}</button>`;
}

// ⋯ overflow for the pinned action row. Everything here is real work, just not
// THIS order's next step: the Undo reversals for a misclick, and the box-label
// sticker (opt-in via Settings · Delivery → body.ord-box-label). Folding them
// away is what keeps the row at four visible controls and the pinned header a
// fixed height. Renders nothing when it would be empty — an empty kebab is a
// dead end, not a menu. Read the body class in JS rather than leaving a
// CSS-hidden item inside, or the ⋯ would appear with nothing under it.
function orderHeadMore(o) {
  const items = [];
  if (undoDispatchable(o)) {
    items.push(`<button class="odh-item" onclick="orderMoreClose(); undoDispatch(${o.id}, event)">${o.status === 'delivered' ? 'Undo delivery · 撤销送达' : 'Undo dispatch · 撤销发货'}</button>`);
  }
  if (undoPreparable(o)) {
    items.push(`<button class="odh-item" onclick="orderMoreClose(); undoPreparing(${o.id}, event)">Undo preparing · 撤销备货</button>`);
  }
  if (document.body.classList.contains('ord-box-label')
      && !['pending_payment', 'cancelled', 'refunded'].includes(o.status)) {
    items.push(`<button class="odh-item" onclick="orderMoreClose(); printBoxLabel(${o.id})" title="${escapeAttr(cuT('Sticker for the parcel: order no, name, phone', '箱贴:订单号、姓名、电话'))}">${cuT('Box label', '打印箱贴')}</button>`);
  }
  if (!items.length) return '';
  return `
    <div class="ovp-wrap odh-wrap">
      <button class="btn btn-sm odh-btn" id="odh-btn" onclick="orderMoreToggle()" aria-haspopup="true" title="${escapeAttr(cuT('More actions', '更多操作'))}" aria-label="${escapeAttr(cuT('More actions', '更多操作'))}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
      </button>
      <div id="odh-pop" class="ovp odh-pop" hidden>
        <div class="ovp-head">${cuT('More actions', '更多操作')}</div>
        ${items.join('')}
      </div>
    </div>`;
}
let _ODH_OPEN = false;
function orderMoreToggle() {
  _ODH_OPEN = !_ODH_OPEN;
  const pop = document.getElementById('odh-pop'); if (pop) pop.hidden = !_ODH_OPEN;
  if (_ODH_OPEN) setTimeout(() => document.addEventListener('mousedown', orderMoreOutside), 0);
  else document.removeEventListener('mousedown', orderMoreOutside);
}
function orderMoreOutside(e) {
  if (e.target.closest && e.target.closest('.odh-wrap')) return;
  orderMoreClose();
}
function orderMoreClose() {
  _ODH_OPEN = false;
  const pop = document.getElementById('odh-pop'); if (pop) pop.hidden = true;
  document.removeEventListener('mousedown', orderMoreOutside);
}

// The marks line — the first line of the SCROLLING body, directly under the
// pinned header. It carries everything the header can no longer hold without
// growing: when the order was placed, plus every secondary mark (partially
// shipped, items added after the slip printed, a refund in flight, stock not
// yet deducted, a failed auto-print). §1.13a: the pinned block shows one pill,
// additional marks live here.
// The placed time keeps its ORIGINAL markup — an inner span holding the
// `English · 中文` pair with the date outside it — because the live translator
// glues that pair at runtime and cannot glue a string with a value in the
// middle. Parts are separated by an empty <span class="od-mark-sep">, never a
// " · " text node: the walker reads space-middot-space as a language pair.
function orderHeadMarks(o) {
  const marks = [];
  if (o.fulfillment?.rollup === 'partial') {
    marks.push(`<span class="pill st-preparing"><span class="dot"></span>Partially shipped · 部分发货 (${o.fulfillment.dispatched}/${o.fulfillment.total})</span>`);
  }
  if (o.addons && o.addons.length) {
    marks.push(`<span class="pill st-paid" title="${escapeHtml((o.addons || []).flatMap(a => (a.items || []).map(it => `${it.name_en || it.name_cn} ×${it.qty}`)).join(', '))}"><span class="dot"></span>+ Items added · 加单 (+${acMoney(o.addon_total)})</span>`);
  }
  const refund = refundBadge(o);
  if (refund) marks.push(refund);
  const stock = stockPendingBadge(o);
  if (stock) marks.push(stock);
  // A failed auto-print used to show only in the footer bar that this change
  // removes. It stays surfaced, in brick with the printer's own error on hover,
  // above the fold where the operator is already looking — a failure the
  // operator can miss is not an error state (§7).
  if (o.print_status === 'failed' && !['pending_payment', 'cancelled', 'refunded'].includes(o.status)) {
    marks.push(`<span class="ord-note-line is-failed" title="${escapeAttr(o.print_error || '')}">${ICON_PRINT_FAILED}${cuT('Print failed', '打印失败')}</span>`);
  }
  return `
    <div class="od-marks">
      <span class="od-placed"><span>Order placed · 下单于</span> ${formatDate(o.placed_at)}</span>
      ${marks.length ? '<span class="od-mark-sep"></span>' : ''}
      ${marks.join('')}
    </div>`;
}

// Hairline + soft shadow under the pinned header, but only once content has
// actually scrolled beneath it — an unscrolled order looks exactly as it did
// before. Bound once to the mount (the scrollport, which persists across
// renders); re-synced on every render because innerHTML resets scrollTop.
let _OD_PIN_BOUND = false;
function ordBindHeadPin() {
  const sc = $('#order-detail-mount');
  if (!sc) return;
  if (!_OD_PIN_BOUND) {
    _OD_PIN_BOUND = true;
    sc.addEventListener('scroll', () => {
      const h = sc.querySelector('.order-head');
      if (h) h.classList.toggle('is-stuck', sc.scrollTop > 2);
    }, { passive: true });
  }
  const h = sc.querySelector('.order-head');
  if (h) h.classList.toggle('is-stuck', sc.scrollTop > 2);
}

async function reprintOrder(id) {
  // Let the operator pick WHICH store's printer to reprint at. Fetch the
  // configured printers; if two or more stores have one, show a picker so the
  // slip can be printed at any counter. With 0–1 printers there's no choice —
  // print straight to the order's resolved store as before.
  let storeId; // undefined → server resolves the order's own store
  try {
    const pr = await api('/api/retail-admin/printer');
    const stores = (pr && pr.data && pr.data.stores || []).filter(s => s.sn);
    if (stores.length >= 2) {
      const picked = await pickReprintStore(stores);
      if (picked === null) return;          // operator cancelled
      storeId = picked;
    }
  } catch (e) { /* fall back to default routing */ }

  const btn = document.getElementById('reprint-' + id);
  if (btn) { btn.disabled = true; btn.style.opacity = '.5'; }
  try {
    const opts = { method: 'POST' };
    if (storeId != null) opts.body = { store_id: storeId };   // api() stringifies + sets Content-Type
    const r = await api(`/api/retail-admin/orders/${id}/print`, opts);
    if (r.ok) toast('Receipt sent to printer · 小票已发送');
    else toast('Print failed · 打印失败: ' + (r.error || 'unknown'), 'err');
  } catch (e) {
    toast('Print failed · 打印失败: ' + e.message, 'err');
  } finally {
    openOrder(id, { instant: true });
    loadOrders();
  }
}

// Print the box-label sticker(s) for an order on the LOCAL label printer (a
// USB/Bluetooth 70×45mm device attached to the staff PC — NOT the Feie cloud
// receipt printer, which the server drives). So this is a pure browser print:
// we render a 70×45mm page per parcel and open the print dialog; staff send it
// to the label printer (set it as the default to make this one-click). Each
// sticker carries the order's last 4 digits (big, to match the waybill the
// logistics person holds), recipient name + phone, and — for split orders —
// which box of how many. Reads the open order from _OPEN_ORDER (no server call).
// Per-MACHINE (not per-account) toggle: auto-print a parcel's box label the
// moment its waybill is created. Stored in localStorage because only the PC
// physically wired to the label printer should fire it — a global setting would
// make every operator's browser try to print.
function boxLabelAutoOn() {
  // Tenant gate first: box-label printing is an opt-in Delivery setting
  // (delivery.boxLabel → body.ord-box-label). When it's off, the per-machine
  // localStorage flag is ignored so no auto-print can fire.
  if (!document.body.classList.contains('ord-box-label')) return false;
  try { return localStorage.getItem('boxlabelAutoWaybill') === '1'; } catch (e) { return false; }
}
function setBoxLabelAuto(on) {
  try { localStorage.setItem('boxlabelAutoWaybill', on ? '1' : '0'); } catch (e) {}
  toast(on ? cuT('Box label will auto-print on waybill', '生成运单后将自动打印箱贴')
           : cuT('Box-label auto-print off', '已关闭箱贴自动打印'));
}

// Print box-label sticker(s) for an order on the LOCAL label printer. Pass
// `onlyShipmentId` to print just that one parcel's label (used by the auto-print
// on waybill creation) — its BOX i/N still reflects its position among all
// parcels. Omit it to print every parcel (the manual button).
function printBoxLabel(id, onlyShipmentId) {
  const o = _OPEN_ORDER;
  if (!o || o.id !== id) { toast(cuT('Open the order first', '请先打开订单'), 'err'); return; }
  // Last 4 DIGITS of the order no (strip the leading letters of "R260618156719").
  const digits = String(o.order_no || '').replace(/\D/g, '');
  const last4 = digits.slice(-4) || String(o.order_no || '');
  const ships = (o.shipments && o.shipments.length) ? o.shipments : [];
  const n = ships.length || 1;                          // total parcels = box count
  const name = escapeHtml(o.recipient_name || '');
  const phone = escapeHtml(o.recipient_phone || '');
  const orderNo = escapeHtml(o.order_no || '');
  const big = escapeHtml(last4);

  // Which box numbers to print (1-based). A single onlyShipmentId → just that
  // parcel; otherwise every parcel (or the lone box for an unsplit order).
  let boxNos;
  if (onlyShipmentId != null && ships.length) {
    const idx = ships.findIndex(s => s.id === onlyShipmentId);
    boxNos = idx >= 0 ? [idx + 1] : ships.map((_, k) => k + 1);
  } else {
    boxNos = ships.length ? ships.map((_, k) => k + 1) : [1];
  }

  let pages = '';
  for (const boxNo of boxNos) {
    pages += `<div class="lbl">
        <div class="no">#${big}</div>
        ${n > 1 ? `<div class="box">BOX ${boxNo} / ${n}</div>` : ''}
        ${name ? `<div class="who">${name}</div>` : ''}
        ${phone ? `<div class="tel">${phone}</div>` : ''}
        <div class="ref">${orderNo}</div>
      </div>`;
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Label ${big}</title>
<style>
  @page { size: 70mm 45mm landscape; margin: 0; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:70mm; }
  body { font-family:-apple-system,"PingFang SC","Microsoft YaHei",Arial,sans-serif; color:#000; }
  /* Each label is exactly one 70x45mm landscape page. Everything is kept on a
     single line (nowrap) and clipped rather than wrapped, so a long name or the
     full order-no can never push content off the sticker. */
  .lbl { width:70mm; height:45mm; padding:2mm 3mm; page-break-after:always;
         display:flex; flex-direction:column; align-items:center; justify-content:center;
         text-align:center; overflow:hidden; }
  .lbl:last-child { page-break-after:auto; }
  .lbl > div { max-width:64mm; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .no  { font-size:15mm; font-weight:800; line-height:1; letter-spacing:0; }
  .box { font-size:6mm;  font-weight:800; margin-top:1mm; }
  .who { font-size:5mm;  font-weight:700; margin-top:1.5mm; }
  .tel { font-size:6.5mm; font-weight:800; margin-top:.5mm; letter-spacing:0; }
  .ref { font-size:2.6mm; color:#444; margin-top:1mm; }
</style></head>
<body onload="window.focus();window.print();">
${pages}
<script>window.onafterprint=function(){window.close();};<\/script>
</body></html>`;

  const w = window.open('', '_blank', 'width=420,height=320');
  if (!w) { toast(cuT('Allow pop-ups to print labels', '请允许弹出窗口以打印箱贴'), 'err'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// Modal: choose which store's printer to reprint a receipt at. Resolves to the
// chosen store id, or null if the operator closes/cancels.
function pickReprintStore(stores) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'pu-editor-bg tacet';
    bg.style.display = 'flex';
    const rows = stores.map(s => {
      const name = `${s.name_cn || s.name_en || s.code || ('Store ' + s.id)}`;
      const sub = s.name_cn && s.name_en ? s.name_en : '';
      return `<button class="btn" data-store="${s.id}" style="display:flex; flex-direction:column; align-items:flex-start; gap:2px; width:100%; text-align:left; padding:12px 14px;">
          <span style="font-weight:700; font-size:14px;">${escapeHtml(name)}</span>
          ${sub ? `<span class="muted" style="font-size:12px;">${escapeHtml(sub)}</span>` : ''}
        </button>`;
    }).join('');
    bg.innerHTML = `
      <div class="pu-editor" style="width: 420px; max-width: 92vw;" role="dialog" aria-modal="true">
        <div class="pu-editor-head">
          <div><h3 style="margin: 0; font-size: 14px;">Print at which store? · 在哪个门店打印？</h3></div>
          <button class="btn" data-cancel>Close · 关闭</button>
        </div>
        <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display: block;">
          <div style="display:flex; flex-direction:column; gap:8px;">${rows}</div>
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
    bg.querySelectorAll('[data-store]').forEach((b) =>
      b.addEventListener('click', () => finish(parseInt(b.getAttribute('data-store'), 10))));
    document.addEventListener('keydown', onKey);
  });
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
  if (!o || ordShipsNothing(o)) return null;   // nothing to dispatch early
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

async function transition(id, status, ev) {
  const btn = ev && ev.currentTarget;   // capture before any dialog await nulls currentTarget
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
  if (btn) btn.disabled = true;
  try {
    await api(`/api/retail-admin/orders/${id}/status`, { method: 'PATCH', body: { status, reason, pay_method } });
    toast(`Order → ${humanStatus(status, _OPEN_ORDER?.fulfillment_type)} · 订单 → ${humanStatus(status, _OPEN_ORDER?.fulfillment_type)}`);
    openOrder(id, { instant: true });
    loadOrders();
  } catch (e) {
    toast(cuT('Failed', '失败') + ': ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Reverse an accidental "Mark dispatched" / "Mark delivered". The status machine
// is forward-only, so without this a misclick was stuck on the queue with only
// Refund as an exit. The server only allows it when no parcel carries a waybill
// (see undoDispatchable); on that rare race it returns 'already_shipped' and we
// surface a plain reason. Silent: the customer is not notified, matching a quick
// correction. Both 'dispatched' and 'delivered' roll back to Preparing.
async function undoDispatch(id, ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm await nulls currentTarget
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
  if (btn) btn.disabled = true;
  try {
    await api(`/api/retail-admin/orders/${id}/undo-dispatch`, { method: 'POST', body: {} });
    toast('Undone · 已撤销 — back to Preparing · 退回备货中');
    openOrder(id, { instant: true });
    loadOrders();
  } catch (e) {
    const msg = e.code === 'already_shipped'
      ? cuT('A parcel already has a waybill — cancel it first.', '已有包裹生成运单 — 请先取消运单。')
      : cuT('Failed', '失败') + ': ' + e.message;
    toast(msg, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Whether the open order can be rolled back to Preparing from the UI: it's
// dispatched or delivered, and no parcel carries a real waybill. Mirrors the
// server guard so the button only shows when the action will actually succeed.
// (delivered_at is NOT checked — the deliver flip stamps it on every parcel, so
// it can't tell a real delivery from this misclick; only a waybill can.)
// A counter sale sits at 'delivered' with no parcel and no waybill, which is
// exactly the shape this function was built to detect as a misclick — so without
// naming it, every walk-in is offered "Undo dispatch" for a dispatch that never
// happened. This is a defect the counter work INTRODUCED, not an inherited one:
// before counter existed, nothing reached 'delivered' without being dispatched.
function undoDispatchable(o) {
  return o && (o.status === 'dispatched' || o.status === 'delivered')
    && !ordShipsNothing(o)
    && !(o.shipments || []).some(s =>
      (s.tracking_number && String(s.tracking_number).trim()) ||
      (s.tracking && s.tracking.number));
}

// Reverse an accidental "Mark preparing" — one step earlier than undoDispatch.
// The status machine is forward-only, so a too-early paid → preparing left the
// operator with no way back. Rolls preparing → paid. Server only allows it while
// still preparing with no waybill attached (returns 'already_shipped' otherwise).
// Silent: the customer is not notified, matching a quick correction.
async function undoPreparing(id, ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm await nulls currentTarget
  const ok = await askConfirm({
    titleEn: 'Undo preparing?', titleCn: '撤销备货?',
    bodyEn: 'This moves the order back to <b>Paid</b>. Use it if you marked it preparing by mistake. The customer is not notified.',
    bodyCn: '这会把订单退回<b>已支付</b>。如果你是误点了备货,可以用它撤销。不会通知顾客。',
    confirmEn: 'Undo preparing', confirmCn: '撤销备货',
    cancelEn: 'Keep as is', cancelCn: '保持不变',
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    await api(`/api/retail-admin/orders/${id}/undo-preparing`, { method: 'POST', body: {} });
    toast('Undone · 已撤销 — back to Paid · 退回已支付');
    openOrder(id, { instant: true });
    loadOrders();
  } catch (e) {
    const msg = e.code === 'already_shipped'
      ? cuT('A parcel already has a waybill — cancel it first.', '已有包裹生成运单 — 请先取消运单。')
      : cuT('Failed', '失败') + ': ' + e.message;
    toast(msg, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Whether the open order can be rolled back to Paid: it's preparing and no parcel
// carries a real waybill. Mirrors the server guard so the button only shows when
// the action will actually succeed.
function undoPreparable(o) {
  return o && o.status === 'preparing'
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

// Delivered date (YYYY-MM-DD) for a parcel. Prefer the stamped delivered_at
// (operator hit "Mark delivered"), but fall back to the carrier's own delivery
// event: JD live-sync flips tracking_status to 'delivered' and logs a 已送达
// event WITHOUT ever stamping delivered_at, so an air parcel can read
// "Dispatched" on its pill yet already be delivered per JD. Honour that or the
// delay alert never fires for JD-synced parcels.
function shipmentDeliveredDate(s) {
  const stamped = (s.delivered_at || '').slice(0, 10);
  if (stamped && stamped !== '0000-00-00') return stamped;
  const t = s.tracking;
  const delivered = s.tracking_status === 'delivered' || (t && t.status_code === 'delivered');
  if (!delivered) return '';
  const evs = (t && t.events) || [];
  const hit = evs.find(ev => /送达|签收|delivered/i.test(`${ev.description_cn || ''} ${ev.description_en || ''}`)) || evs[0];
  return ((hit && hit.time) || (t && t.synced_at) || '').slice(0, 10);
}

// Returns how many days late an air shipment arrived, or 0 if on time / not air.
// An "Air shipment · 空运" parcel promises next-day arrival, so the deadline is
// the dispatch date + 1 day: sent out today → must arrive tomorrow.
function airShipmentDelayDays(o, s) {
  if ((s.mode || '') !== 'air') return 0;
  const deliveredDate  = shipmentDeliveredDate(s);
  const dispatchedDate = (s.dispatched_at || '').slice(0, 10);
  if (!deliveredDate  || deliveredDate  === '0000-00-00') return 0;
  if (!dispatchedDate || dispatchedDate === '0000-00-00') return 0;
  const d = new Date(dispatchedDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const deadline = d.toISOString().slice(0, 10);
  if (deliveredDate <= deadline) return 0;
  return Math.round((new Date(deliveredDate) - new Date(deadline)) / 86400000);
}

// Tracking card for one shipment row. Each shipment gets its own carrier +
// waybill input. The save/clear/retry handlers all pass the shipment_id so
// the right row in retail_shipments is touched.
// "In this parcel" strip for the tracking card. Answers "which parcel is
// this?" right where the operator reads the waybill — number, status, and
// contents in one place, no scrolling to the items section. Only rendered on
// multi-parcel orders (a single-parcel card already refers to the whole
// order, so listing its contents would be redundant noise).
// The first two lines always show — enough to recognise the parcel; the rest
// tuck behind a disclosure so a big parcel never makes the card tall. Wrapped
// in data-no-i18n like the events block: the product names are single-language
// strings the auto-translator would otherwise mis-pair (we pick the live
// language ourselves via orderItemNames/cuT, re-run on every drawer render).
function renderParcelContents(s) {
  const items = s.items || [];
  if (!items.length) return '';
  const lines = items.length;
  const units = items.reduce((n, it) => n + (Number(it.qty) || 0), 0);
  const countLabel = units !== lines
    ? cuT(`${lines} products · ${units} units`, `${lines} 款 · ${units} 件`)
    : cuT(`${lines} product${lines === 1 ? '' : 's'}`, `${lines} 款`);
  const row = (it) => {
    const nm = orderItemNames(it).primary || ('#' + it.id);
    const q = Number(it.qty) || 1;
    return `<div class="tc-item"><span class="tc-q">×${q}</span><span class="tc-nm">${escapeHtml(nm)}</span></div>`;
  };
  // ≤3 lines: show them all — hiding just one behind a toggle isn't worth it.
  const shown = lines <= 3 ? items : items.slice(0, 2);
  const rest  = lines <= 3 ? []    : items.slice(2);
  return `
    <div class="od-trk-contents" data-no-i18n>
      <div class="tc-head">${cuT('In this parcel', '此包裹内含')} <span class="cnt">· ${countLabel}</span></div>
      ${shown.map(row).join('')}
      ${rest.length ? `
        <details class="od-trk-items-more">
          <summary><span class="od-trk-chev" aria-hidden="true">▸</span>${cuT(`${rest.length} more`, `还有 ${rest.length} 款`)}</summary>
          <div class="od-trk-items-rest">${rest.map(row).join('')}</div>
        </details>` : ''}
    </div>`;
}

function renderShipmentTrackingCard(o, s, hoisted) {
  const t = s.tracking;
  const multiParcel = (o.shipments?.length || 0) > 1;
  const has = !!(t && t.number);
  const sid = s.id;
  const carrierOpts = (TRACKING_CARRIERS || []).map(c =>
    `<option value="${c.code}" ${ (has ? t.carrier_code : 'jd') === c.code ? 'selected' : '' }>${escapeHtml(c.name_en)} · ${escapeHtml(c.name_cn)}</option>`
  ).join('');
  // This used to strip the leading year off the ISO stamp by regex so the
  // footer read "Updated 07-06 13:59". §1.18's year rule does exactly that
  // job — and does it correctly across a year boundary, which the regex did
  // not — so the hack goes and the stamp is just the stamp.
  const syncShort = t?.synced_at ? formatDate(t.synced_at) : '';
  const synced = t?.synced_at ? cuT(`Updated ${syncShort}`, `更新于 ${syncShort}`) : cuT('no live sync yet', '尚未实时同步');
  const trackLink = (has && t.track_url)
    ? `<a href="${t.track_url}" target="_blank" rel="noopener" class="btn btn-sm">${cuT('Carrier site →', '承运商官网 →')}</a>`
    : '';

  // A waybill reused from an ALREADY-DELIVERED order can't live-sync: kd100/JD
  // keys by company+number and won't replay events for a parcel they already
  // closed out. The green "live sync on" badge would lie next to the red reuse
  // banner, so override it to a muted amber "sync inactive" the moment we know.
  const deadReuse = !!(t && t.reuse_warning && t.reuse_warning.delivered);
  let kdBadge = '';
  if (has) {
    if (deadReuse) {
      kdBadge = `<span style="font-size:11px; color:#9A6E2A;">● ${cuT('sync inactive (reused number)', '同步未生效(重复运单号)')}</span>`;
    } else if (s.jd_live) {
      kdBadge = `<span class="muted" style="font-size:11px; color: #5C7A4E;">● ${cuT('JD live sync on', '京东实时同步中')}</span>`;
    } else if (s.tracking_kd100_subscribed) {
      kdBadge = `<span class="muted" style="font-size:11px; color: #5C7A4E;">● ${cuT('kd100 live sync on', '快递100实时同步中')}</span>`;
    } else if (s.tracking_last_error) {
      kdBadge = `<span style="font-size:11px; color: var(--danger);">⚠ ${escapeHtml(s.tracking_last_error)}</span>
        <button class="btn btn-sm" onclick="resubscribeTracking(${o.id}, ${sid})" style="margin-left:6px;">${cuT('Retry sync', '重试同步')}</button>`;
    } else {
      kdBadge = `<span class="muted" style="font-size:11px;">${cuT('manual entry only', '仅手动录入')}</span>`;
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
  const renderEventRow = (ev) => {
    const desc = cuT(ev.description_en || ev.description_cn || '', ev.description_cn || ev.description_en || '');
    // Short time — drop the year and the trailing seconds (mockup: "07-06 12:41").
    const evTime = (ev.time || '').replace(/^\d{4}-/, '').replace(/:\d{2}$/, '');
    return `
          <div style="display:flex; gap:12px; font-size:12.5px; line-height:1.45;">
            <div class="muted" style="font-family: var(--f-mono); white-space:nowrap; min-width: 98px;">${escapeHtml(evTime)}</div>
            <div style="flex:1;">${escapeHtml(desc)}${ev.location ? ` <span class="muted" style="font-size:11.5px;">· ${escapeHtml(ev.location)}</span>` : ''}</div>
          </div>`;
  };
  // Show only the newest event by default; tuck the rest behind a disclosure so
  // the drawer stays calm. Events arrive newest-first, so [0] is the latest.
  const restEvents = (has && t.events && t.events.length > 1) ? t.events.slice(1) : [];
  const eventsBlock = (has && t.events && t.events.length) ? `
    <div data-no-i18n style="margin-top:14px; border-top: 1px dashed var(--line-soft); padding-top:10px;">
      <div class="muted" style="font-size:10px; letter-spacing:.1em; text-transform:uppercase; margin-bottom:6px;">${cuT('Recent events', '最近事件')}</div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${renderEventRow(t.events[0])}
        ${restEvents.length ? `
        <details class="od-trk-events-more" style="margin-top:2px;">
          <summary style="cursor:pointer; list-style:none; font-size:11.5px; color:var(--text-3); user-select:none;">
            <span class="od-trk-chev" aria-hidden="true" style="display:inline-block; transition:transform .15s;">▸</span>
            ${cuT(`${restEvents.length} earlier events`, `更早的 ${restEvents.length} 条`)}
          </summary>
          <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px; max-height: 300px; overflow-y: auto;">
            ${restEvents.map(renderEventRow).join('')}
          </div>
        </details>` : ''}
      </div>
    </div>` : '';

  const delayDays = airShipmentDelayDays(o, s);
  // Once an operator has contacted the customer they mark the alert handled; the
  // red banner collapses to a calm "handled" note (with an undo), and the same
  // clear drops the order from the dashboard "needs a call" card and the list
  // "AIR DELAYED" badge. Keyed off the shipment's air_delay_cleared_at stamp.
  const airCleared = !!s.air_delay_cleared_at;
  let delayBanner = '';
  if (delayDays > 0 && !airCleared) {
    delayBanner = `
    <div style="display:flex; gap:10px; align-items:flex-start; padding:12px 14px; margin-bottom:12px;
                background: var(--danger-soft, rgba(232,85,106,.14)); border:1px solid var(--danger, #e8556a);
                border-radius: var(--r-md, 6px); font-size:12.5px; line-height:1.5;">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <div style="flex:1;">
        <div style="font-weight:700; font-size:13px; color: var(--danger, #e8556a); margin-bottom:5px; text-transform:uppercase; letter-spacing:.04em;">
          ${cuT(`Air shipment delayed — arrived ${delayDays} day${delayDays > 1 ? 's' : ''} late`, `空运延误 — 晚到 ${delayDays} 天`)}
        </div>
        <div style="color: var(--text-1); margin-bottom:6px;">
          <strong>${cuT('1. Contact customer immediately:', '1. 立即联系客户：')}</strong>
          ${cuT('Perishable / fresh items may no longer be safe — advise them <u>not to consume</u>.', '生鲜/易腐产品可能已不安全，请告知客户<u>勿食用</u>。')}
        </div>
        <div style="color: var(--text-1); margin-bottom:10px;">
          <strong>${cuT('2. Contact JD Logistics for delay compensation.', '2. 联系京东物流，申请延误赔偿。')}</strong>
        </div>
        <button type="button" onclick="clearAirDelay(${Number(o.id)}, event)"
          style="font: inherit; font-size:12px; font-weight:600; cursor:pointer; padding:6px 12px;
                 border:1px solid var(--danger, #e8556a); border-radius: var(--r-sm, 5px);
                 background: transparent; color: var(--danger, #e8556a);">
          ${cuT('Mark handled — customer contacted', '标记已处理 — 已联系客户')}
        </button>
      </div>
    </div>`;
  } else if (delayDays > 0 && airCleared) {
    delayBanner = `
    <div style="display:flex; gap:8px; align-items:center; padding:8px 12px; margin-bottom:12px;
                background: var(--surface-2, #f4f2ec); border:1px solid var(--line-soft);
                border-radius: var(--r-md, 6px); font-size:12px; line-height:1.4; color: var(--text-2);">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; color: var(--sage, #5a7d5a);"><path d="M20 6 9 17l-5-5"/></svg>
      <span style="flex:1;">${cuT(`Air delay handled${s.air_delay_cleared_by ? ' · ' + s.air_delay_cleared_by : ''}`, `空运延误已处理${s.air_delay_cleared_by ? ' · ' + s.air_delay_cleared_by : ''}`)}</span>
      <button type="button" onclick="reopenAirDelay(${Number(o.id)}, event)"
        style="font: inherit; font-size:11.5px; cursor:pointer; padding:2px 4px; border:none;
               background: transparent; color: var(--text-3); text-decoration: underline;">
        ${cuT('Undo', '撤销')}
      </button>
    </div>`;
  }

  return `
    <div style="${hoisted ? '' : 'margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line-soft);'}" id="trk-card-${sid}">
      ${renderGzMethodToggle(o, s)}
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-3); margin-bottom: var(--s2);">${cuT('Tracking', '物流')}</div>
      ${delayBanner}${reuseBanner}
      ${has ? `
        <div class="od-trk-panel">
          <div class="od-trk-top">
            <div>
              <div class="od-trk-num">${escapeHtml(t.number)}</div>
              <div class="od-trk-carrier">${escapeHtml(t.carrier_name_en)} · ${escapeHtml(t.carrier_name_cn)}</div>
            </div>
            ${(() => {
              // Live delivery state with its own icon + colour (courier, returning,
              // exception …) so the operator sees WHERE the parcel is at a glance —
              // not just a flat brown "In transit" chip. Falls back to the plain
              // carrier label for states with no dedicated treatment.
              const dl = deliveryStateInfo({ tracking_status: t.status_code, tracking_scenario: t.scenario && t.scenario.scenario });
              if (dl) {
                return `<span class="pill" style="display:inline-flex; align-items:center; gap:5px; color:${dl.color}; border-color:${dl.color}55; background:${dl.color}14; font-weight:${dl.tone === 'urgent' ? 700 : 600};">${deliveryIcon(dl.icon, 13)}<span>${cuT(dl.en, dl.cn)}</span></span>`;
              }
              return t.status_label_en ? `<span class="pill st-dispatched"><span class="dot"></span>${cuT(escapeHtml(t.status_label_en), escapeHtml(t.status_label_cn))}</span>` : '';
            })()}
          </div>
          ${multiParcel ? renderParcelContents(s) : ''}
          <div class="od-trk-foot">
            ${kdBadge}
            <span class="od-trk-updated">${synced}</span>
            <span class="od-trk-foot-actions">
              ${t.carrier_code === 'jd' ? `<button class="btn btn-sm" onclick="printJdLabel(${o.id}, ${sid})" title="${escapeAttr(cuT('Print this JD waybill label on the local label printer', '在本机标签打印机打印此京东面单'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>${cuT('Print label', '打印面单')}</button>` : ''}
              ${trackLink}
            </span>
          </div>
        </div>` : ''}
      ${eventsBlock}
      ${has ? `
        <details class="od-trk-edit">
          <summary><span class="od-trk-chev" aria-hidden="true">▸</span>${cuT('Change waybill', '修改运单')}</summary>
          <div class="od-trk-edit-body">
            <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
              <select id="trk-carrier-${sid}" style="min-width:180px;">${carrierOpts}</select>
              <input type="text" id="trk-number-${sid}" value="${escapeHtml(t.number)}" placeholder="Tracking / waybill number" data-ph-en="Tracking / waybill number" data-ph-cn="快递单号 / 运单号" style="flex:1; min-width:200px; font-family: var(--f-mono);">
              <button class="btn btn-primary btn-sm" onclick="saveTracking(${o.id}, ${sid})">${cuT('Update', '更新')}</button>
              ${t.carrier_code === 'jd' ? `<button class="btn btn-sm" style="color:var(--danger);" onclick="cancelJdPickup(${o.id}, ${sid}, event)">${cuT('Cancel JD pickup', '取消揽收')}</button>` : ''}
              <button class="btn btn-sm" onclick="clearTracking(${o.id}, ${sid})">${cuT('Clear', '清除')}</button>
            </div>
            ${t.carrier_code === 'jd' ? `<div class="muted" style="font-size:11px; margin-top:6px;">${cuT('"Cancel JD pickup" calls off the courier with JD. "Clear" only removes the number locally (courier still comes).', '"取消揽收"会向京东取消上门;"清除"仅在本地移除运单号(快递仍会上门)。')}</div>` : ''}
          </div>
        </details>`
      : `
        ${s.mode !== 'supplier' ? `
          <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="createJdLabel(${o.id}, ${sid}, '${s.mode || ''}', ${(s.items || []).some(it => it.needs_ice_pack) ? 1 : 0}, event)"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7l8.7 5 8.7-5"/><path d="M12 22V12"/></svg>${cuT('Create JD label', '生成京东运单')}</button>
            <span class="muted" style="font-size:11px;">${cuT('Free live tracking — JD bills the parcel.', '免费物流追踪，京东承担费用。')}</span>
          </div>
          <div class="muted" style="font-size:11px; margin:8px 0 4px;">${cuT('— or attach an existing waybill manually —', '— 或手动填写已有运单 —')}</div>` : ''}
        <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
          <select id="trk-carrier-${sid}" style="min-width:180px;">${carrierOpts}</select>
          <input type="text" id="trk-number-${sid}" value="" placeholder="Tracking / waybill number" data-ph-en="Tracking / waybill number" data-ph-cn="快递单号 / 运单号" style="flex:1; min-width:200px; font-family: var(--f-mono);">
          <button class="btn btn-sm" onclick="saveTracking(${o.id}, ${sid})">${cuT('Save tracking', '保存运单号')}</button>
        </div>
      `}
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
            <td>${x.ok ? '<span style="color: var(--st-dispatched, #5C7A4E);">✓ saved · 已保存</span>' : '<span class="err">✗ ' + escapeHtml(x.error || 'failed · 失败') + '</span>'}</td>
            <td class="muted" style="font-size:11px;">${x.auto_dispatched ? 'auto-dispatched · 自动发货' : ''}</td>
          </tr>`).join('')}</tbody>
      </table>`;
    toast(`Bulk: ${ok}/${r.results.length} saved · 批量: ${ok}/${r.results.length} 已保存`, ok ? 'ok' : 'err');
    loadOrders();
  } catch (e) {
    toast(cuT('Failed', '失败') + ': ' + e.message, 'err');
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

// The three real JD services the store ships with. The operator picks one when
// creating a label — a parcel's mode (air/land) and whether it holds a
// fresh (ice-pack) item only PRE-SELECT the likely choice; staff can override.
// Codes verified against JD's printed 时效产品 (2026-06-15):
//   LL-SD-M   生鲜特快  fresh · air      (生鲜 · 空运)
//   LL-HD-M   生鲜标快  fresh · ground   (生鲜 · 陆运)  ← confirmed on JDVC36827541911
//   ed-m-0001 京东标快  ambient · ground (普通 · 陆运)
const JD_SERVICES = [
  { code: 'LL-SD-M',   en: 'Fresh · Air',     cn: '生鲜 · 空运', sub: '生鲜特快 · LL-SD-M' },
  { code: 'LL-HD-M',   en: 'Fresh · Ground',  cn: '生鲜 · 陆运', sub: '生鲜标快 · LL-HD-M' },
  { code: 'ed-m-0001', en: 'Ambient · Ground',cn: '普通 · 陆运', sub: '京东标快 · ed-m-0001' },
];
function jdSuggestedService(mode, isFresh) {
  if (mode === 'air') return 'LL-SD-M';          // air = fresh express (生鲜特快)
  return isFresh ? 'LL-HD-M' : 'ed-m-0001';      // ground splits by fresh flag
}

// ─── JD waybill cloud-print (面单云打印) — local print component ────────────
// After a JD waybill is created, fire its label STRAIGHT to the JD print
// component (京东物流云打印组件) running on THIS PC, which renders the encrypted
// label data onto the operator's thermal label printer. No browser print
// dialog, no manual step. The server hands us the encrypted printData + the
// chosen template URL (GET …/jd-waybill/print-data); we hand that to the
// component over its local WebSocket and it prints.
//
// The component listens on a loopback WebSocket. ws://127.0.0.1 is a trusted
// origin, so an https admin page is allowed to open it (Chrome/Edge/Firefox all
// permit loopback ws from a secure context — it is NOT blocked as mixed content
// the way ws:// to a remote host would be). It tries a small range of ports.
//
// Per-MACHINE toggle (localStorage, like the box-label one): only the PC wired
// to the JD label printer runs the component, so the auto-fire flag is stored
// per browser, not per account. Default ON — the common setup.
const JD_PRINT_PORTS = [9113, 9114, 9115];
// How long to wait for the component's reply to ONE label. Generous: it renders
// the template and drives the printer before answering, and a 一单多件 job asks
// it to do that once per box. This is NOT the connect timeout (4s, below) — the
// two were the same number once, which made every 2-box job look like a missing
// component. See jdSendToComponent.
const JD_PRINT_REPLY_MS = 20000;

function jdAutoPrintOn() {
  try {
    const v = localStorage.getItem('jdLabelAutoWaybill');
    return v == null ? true : v === '1';      // default ON
  } catch (e) { return true; }
}
function setJdAutoPrint(on) {
  try { localStorage.setItem('jdLabelAutoWaybill', on ? '1' : '0'); } catch (e) {}
  // The component can't enumerate printers (its GET_Printers casts every frame
  // to a print task and throws), so the target printer NAME has to be typed in
  // once. Ask for it the first time auto-print is switched on.
  if (on && !jdPrinterName()) jdPromptPrinterName();
  toast(on ? cuT('JD label will auto-print on waybill', '生成运单后将自动打印京东面单')
           : cuT('JD label auto-print off', '已关闭京东面单自动打印'));
}
// The EXACT OS printer name the JD label prints to (e.g. "HPRT N31"), stored
// per-machine. The component needs it verbatim — there is no auto-discovery.
function jdPrinterName() {
  try { return localStorage.getItem('jdLabelPrinter') || ''; } catch (e) { return ''; }
}
function jdPromptPrinterName() {
  const cur = jdPrinterName();
  const name = window.prompt(cuT(
    'Exact name of the JD label printer (as it appears in the OS / 京东打印组件), e.g. HPRT N31:',
    '京东面单打印机的精确名称(与系统/京东打印组件中显示一致),例如 HPRT N31:'), cur);
  if (name == null) return cur;                 // cancelled — keep current
  const v = String(name).trim();
  try { localStorage.setItem('jdLabelPrinter', v); } catch (e) {}
  return v;
}

// Open the local print component (trying each port in turn), print every entry
// in `labels`, and resolve { ok, msg }. Protocol = JD cloud-print 报文2 (report
// format 2): an "orderType":"PRINT","version":"2" frame whose `parameters` carry
// the target `printName` and a `contents:[{ tempUrl, printData }]` list — the
// component renders the template `tempUrl` with the encrypted `printData` (the
// perPrintData string from pullData) and prints it. It echoes a status frame:
// status 500 = ok, success "true"/"false", errors[] on failure.
//
// A 一单多件 waybill (one waybill, several boxes) yields one label per box, and
// each goes as its OWN print task, sent after the previous one is acked. Two
// reasons not to pack them into a single frame's `contents` list: the component
// answers per task, so one reply can't tell us box 2 actually printed, and a
// long multi-label render used to blow the connect timeout (below).
//
// The port hunt covers the CONNECTION only. Once the socket opens, this is the
// component — a later error or silence is a real print failure, not a wrong
// port. Conflating the two is what made a 2-box job report "component not
// detected": rendering the second label pushed the reply past the 4s connect
// timeout, the handler fell through to 9114/9115 where nothing listens, and the
// exhausted list surfaced as component_unreachable while the component was
// sitting right there on 9113.
function jdSendToComponent(labels, printName, ports) {
  ports = ports || JD_PRINT_PORTS;
  return new Promise((resolve) => {
    let i = 0;
    const tryPort = () => {
      if (i >= ports.length) { resolve({ ok: false, msg: 'component_unreachable' }); return; }
      const port = ports[i++];
      let ws, settled = false, opened = false, timer, queue = [], sent = 0;
      const finish = (r) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        try { ws && ws.close(); } catch (e) {}
        resolve(r);
      };
      // Before the socket opens: a failure means wrong port, so fall through to
      // the next one. After it opens: the component is here, so report what
      // actually went wrong instead of hunting ports that aren't listening.
      const nextOrFail = () => {
        if (settled) return;
        if (opened) { finish({ ok: false, msg: sent > 1 ? 'no_reply_partial' : 'no_reply' }); return; }
        settled = true; clearTimeout(timer);
        try { ws && ws.close(); } catch (e) {}
        tryPort();
      };
      try { ws = new WebSocket('ws://127.0.0.1:' + port); }
      catch (e) { nextOrFail(); return; }
      timer = setTimeout(nextOrFail, 4000);          // connect timeout only
      // Send the next queued label and re-arm the clock for ITS reply; an empty
      // queue means every box was acked.
      const sendNext = () => {
        const l = queue.shift();
        clearTimeout(timer);
        if (!l) { finish({ ok: true }); return; }
        sent++;
        timer = setTimeout(nextOrFail, JD_PRINT_REPLY_MS);
        const msg = {
          orderType: 'PRINT',
          version: '2',
          key: (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.round(Math.random() * 1e6)),
          parameters: {
            printName: printName || '',
            contents: [{ tempUrl: l.tempUrl, printData: l.printData }],
          },
        };
        try { ws.send(JSON.stringify(msg)); } catch (e) { finish({ ok: false, msg: 'send_failed' }); }
      };
      ws.onopen = () => { opened = true; queue = labels.slice(); sendNext(); };
      ws.onmessage = (ev) => {
        let d = ev.data;
        try { d = JSON.parse(ev.data); } catch (e) { sendNext(); return; }   // non-JSON ack
        const status  = d && d.status;
        const success = d && d.success;
        const errs    = d && (d.errors || (d.detailinfo && d.detailinfo.errors));
        const errMsg  = (Array.isArray(errs) && errs.length)
          ? (errs[0].message || errs[0].msg || JSON.stringify(errs[0]))
          : (d && (d.message || d.msg));
        // JD component: status 500 (or success "true") = printed/queued ok.
        const ok     = status === 500 || status === '500' || success === 'true' || success === true;
        const failed = success === 'false' || success === false || (Array.isArray(errs) && errs.length > 0);
        if (ok || !failed) { sendNext(); return; }        // this box is done — next
        finish({ ok: false, msg: errMsg || 'print_failed' });
      };
      ws.onerror  = nextOrFail;
      ws.onclose  = nextOrFail;    // component dropped the socket mid-job
    };
    tryPort();
  });
}

// Fetch the encrypted label data for an order's JD waybill and fire it to the
// local component. Shared by the auto-print-on-waybill path and the manual
// "Print JD label" button. `silent` suppresses the "unavailable" toast for the
// auto path when there's simply no JD waybill on the parcel yet.
async function printJdLabel(orderId, shipmentId, opts) {
  opts = opts || {};
  const qs = shipmentId ? '?shipment_id=' + shipmentId : '';
  let r;
  try {
    r = await api('/api/retail-admin/orders/' + orderId + '/jd-waybill/print-data' + qs);
  } catch (e) {
    if (!opts.silent) toast(cuT('Could not load JD label data', '获取京东面单数据失败') + ': ' + (e.message || ''), 'err');
    return false;
  }
  const labels = (r && r.data && r.data.labels && r.data.labels.length)
    ? r.data.labels
    : (r && r.data && r.data.printData ? [{ printData: r.data.printData, tempUrl: r.data.tempUrl }] : null);
  if (!labels) {
    if (!opts.silent) toast(cuT('JD label data unavailable', '京东面单数据不可用'), 'err');
    return false;
  }
  // The component needs the exact printer name; ask once if it isn't set yet
  // (even on the auto path — without it the component can't pick a printer).
  let printer = jdPrinterName();
  if (!printer) printer = jdPromptPrinterName();
  if (!printer) { if (!opts.silent) toast(cuT('Set the JD printer name first', '请先设置京东打印机名称'), 'err'); return false; }
  const sent = await jdSendToComponent(labels, printer);
  if (sent.ok) {
    toast(labels.length > 1
      ? cuT(labels.length + ' JD box labels sent to printer', '已发送打印 ' + labels.length + ' 张京东面单')
      : cuT('JD label sent to printer', '京东面单已发送打印'));
    return true;
  }
  // Name the actual failure. "Component not detected" is only ever true when we
  // could not connect at all — saying it for a mid-job stall sends staff off to
  // restart a component that was working fine.
  const failMsg = {
    component_unreachable: cuT('JD print component not detected on this PC — open 京东物流云打印组件',
                               '未检测到本机京东打印组件 — 请打开京东物流云打印组件'),
    no_reply: cuT('The print component did not answer — check it and the printer, then print again',
                  '打印组件没有回应 — 请检查组件和打印机后重新打印'),
    no_reply_partial: cuT('The print component stopped answering partway — check the printer and how many labels came out before printing again',
                          '打印组件中途停止回应 — 请先看看已打出几张,检查打印机后再重新打印'),
  }[sent.msg];
  toast(failMsg || (cuT('JD label print failed', '京东面单打印失败') + ': ' + sent.msg), 'err', 6000);
  return false;
}

// POST the JD waybill with a chosen product code. The label is created under
// our JD account, so JD streams tracking events for free (no 快递100). Server
// resolves the sender from the fulfilling store's 发货地址 — surface the "store
// has no sender phone" gap as a clear instruction.
async function submitJdLabel(orderId, shipmentId, product, btn, pieces) {
  const qs = shipmentId ? '?shipment_id=' + shipmentId : '';
  try {
    const r = await adminWrite({
      btn,
      url: `/api/retail-admin/orders/${orderId}/jd-waybill${qs}`,
      method: 'POST', body: { shipment_id: shipmentId, product, package_count: pieces || 1 },
      errLabelEn: 'JD label failed', errLabelCn: '生成运单失败',
    });
    const piecesNote = pieces > 1 ? (cuT(' · ', ' · ') + pieces + cuT(' boxes', ' 箱')) : '';
    toast(cuT('JD waybill created', '京东运单已生成') + ': ' + (r?.data?.waybill || '') + piecesNote);
    // Auto-fire the JD waybill LABEL to the local print component (this machine
    // only) — the label sticker prints with no further action. Default ON.
    if (jdAutoPrintOn()) printJdLabel(orderId, shipmentId, { silent: true });
    // Optional box-label sticker (order no / name / phone) on the local label
    // printer — opt-in, for stores that print their own parcel stickers rather
    // than the JD waybill. Off by default; the JD label above is the primary.
    if (boxLabelAutoOn()) printBoxLabel(orderId, shipmentId);
    openOrder(orderId, { instant: true });
    loadOrders();
    return true;
  } catch (err) {
    // adminWrite already toasts the raw error; add guidance for the usual cause.
    if (String(err?.message || err).includes('store_sender_phone_missing')) {
      toast(cuT('Set the store’s sender phone first (Settings → Stores)', '请先在门店设置寄件电话'), 'err');
    }
    return false;
  }
}

// Create a JD waybill for a parcel. Ground/local parcels ask the one thing the
// order can't tell us: fresh-ground (生鲜标快) vs ambient-ground (京东标快), since
// that depends on what's in the box; air always ships fresh-express (生鲜特快 /
// LL-SD-M), so that section of the modal is skipped. Every mode also gets a
// pieces (箱数) stepper — staff bump it above 1 when the parcel doesn't fit in
// one box, so JD splits it across boxes under the SAME waybill number
// (一单多件); left at 1 it's the ordinary single-box case. We never re-ask air
// vs ground — only the two GROUND service options are offered.
function createJdLabel(orderId, shipmentId, mode, isFresh, ev) {
  const isAir = mode === 'air';
  const preset = isAir ? 'LL-SD-M' : jdSuggestedService(mode, !!Number(isFresh));
  const services = isAir ? [] : JD_SERVICES.filter(s => s.code !== 'LL-SD-M');   // ground-only: fresh vs ambient
  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg tacet';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 460px; max-width: 92vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin:0; font-size:14px;">${cuT('Create JD label', '生成京东运单')}</h3>
          <div class="muted" style="font-size:11px; margin-top:2px;">${isAir
            ? cuT('Air parcel — fresh express (生鲜特快)', '空运包裹 — 生鲜特快')
            : cuT('Ground parcel — is it fresh (ice pack) or ambient?', '陆运包裹 — 生鲜(冰袋)还是普通?')}</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Close', '关闭')}</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display:block;">
        ${services.length ? `
        <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:14px;">
          ${services.map(s => `
            <label class="jd-svc" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--line-soft); border-radius:8px; cursor:pointer;">
              <input type="radio" name="jd-svc" value="${s.code}" ${s.code === preset ? 'checked' : ''} style="margin:0;">
              <span style="flex:1;">
                <span style="font-weight:600;">${cuT(s.en, s.cn)}</span>
                <span class="muted" style="display:block; font-size:11px; margin-top:1px;">${s.sub}</span>
              </span>
            </label>`).join('')}
        </div>` : ''}
        <div style="margin-bottom:14px;">
          <label style="font-size:12px; font-weight:600; display:block; margin-bottom:6px;">${cuT('Pieces (boxes)', '箱数')}</label>
          <input type="number" id="jd-pieces" min="1" max="30" step="1" value="1" class="form-control" style="width:90px;">
          <div class="muted" style="font-size:11px; margin-top:4px;">${cuT('More than 1 only if this parcel is too big for one box — JD keeps ONE tracking number split across that many boxes.', '仅当包裹过大需要分箱时填大于1 — 京东运单号不变,拆分为该数量的箱子。')}</div>
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Cancel', '取消')}</button>
          <button class="btn btn-primary" id="jd-svc-submit">${cuT('Create & ship', '生成并发货')}</button>
        </div>
      </div>
    </div>`;
  mountFloatingPuModal(bg);
  bg.querySelector('#jd-svc-submit').addEventListener('click', async (e) => {
    const product = services.length ? (bg.querySelector('input[name="jd-svc"]:checked') || {}).value : preset;
    if (!product) return;
    const piecesEl = bg.querySelector('#jd-pieces');
    const pieces = Math.max(1, Math.min(30, parseInt(piecesEl && piecesEl.value, 10) || 1));
    const ok = await submitJdLabel(orderId, shipmentId, product, e.currentTarget, pieces);
    if (ok) bg.remove();
  });
}

// Cancel the JD courier for this parcel via JD's own API (pre-pickup cancel,
// falling back to in-transit intercept). Unlike "Clear", this actually calls
// off the courier. On success the waybill is removed + the order may roll back
// to preparing.
async function cancelJdPickup(orderId, shipmentId, ev) {
  if (!(await askConfirm({ title: 'Cancel the JD pickup / recall this parcel with JD? · 向京东取消揽收 / 拦截此包裹?', danger: true, confirmLabel: 'Cancel pickup' }))) return;
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

// Mark a late-air food-safety alert handled (operator has contacted the
// customer). Clears the drawer banner, the dashboard "needs a call" card, and
// the orders-list "AIR DELAYED" badge in one shot. reopenAirDelay undoes it.
async function clearAirDelay(orderId, ev) {
  try {
    await adminWrite({
      btn: ev?.currentTarget,
      url: `/api/retail-admin/orders/${orderId}/air-delay/ack`,
      method: 'POST', body: { cleared: true },
      errLabelEn: 'Could not mark handled', errLabelCn: '标记失败',
    });
    toast('Air delay marked handled · 空运延误已处理');
    openOrder(orderId, { instant: true });
    loadOrders();
    // Refresh the dashboard "Delivery needs a call" card so the handled order
    // drops off it right away — the ops query excludes cleared air-delays.
    if (typeof tdOpsLoad === 'function') tdOpsLoad();
  } catch {}
}

async function reopenAirDelay(orderId, ev) {
  try {
    await adminWrite({
      btn: ev?.currentTarget,
      url: `/api/retail-admin/orders/${orderId}/air-delay/ack`,
      method: 'POST', body: { cleared: false },
      errLabelEn: 'Could not re-open', errLabelCn: '撤销失败',
    });
    toast('Air delay re-opened · 空运延误已恢复');
    openOrder(orderId, { instant: true });
    loadOrders();
    // Undo re-flags the order, so refresh the dashboard card to bring it back.
    if (typeof tdOpsLoad === 'function') tdOpsLoad();
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
    // Auto-print this parcel's box label (this machine only) — fire before the
    // drawer rebuild while _OPEN_ORDER still holds the order.
    if (boxLabelAutoOn()) printBoxLabel(orderId, shipmentId);
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
  if (!(await askConfirm({ title: 'Remove the tracking number from this shipment? · 移除此运单号?', danger: true, confirmLabel: 'Remove' }))) return;
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

// Brand ETA field helpers — the segmented HH:MM + AM/PM field (renderLocalEtaCard)
// writes the stored 24h "HH:MM" into a hidden #eta-time-<sid> so saveLocalEta reads
// it unchanged. qyEtaSync recomputes it from the parts; blank/invalid parts clear it.
function qyEtaSync(sid) {
  const hEl = document.getElementById('eta-h-' + sid);
  const mEl = document.getElementById('eta-m-' + sid);
  const apEl = document.getElementById('eta-ampm-' + sid);
  const hidden = document.getElementById('eta-time-' + sid);
  if (!hEl || !mEl || !hidden) return;
  const h = parseInt(hEl.value, 10);
  const m = parseInt(mEl.value, 10);
  const ap = (apEl && apEl.dataset.v) || 'AM';
  if (Number.isNaN(h) || Number.isNaN(m) || h < 1 || h > 12 || m < 0 || m > 59) { hidden.value = ''; return; }
  const h24 = (h % 12) + (ap === 'PM' ? 12 : 0);   // 12AM→0, 12PM→12, 1PM→13…
  hidden.value = String(h24).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function qyEtaAmpm(sid, v) {
  const apEl = document.getElementById('eta-ampm-' + sid);
  if (apEl) {
    apEl.dataset.v = v;
    apEl.querySelectorAll('button').forEach(bn => bn.classList.toggle('on', bn.textContent.trim() === v));
  }
  qyEtaSync(sid);
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
  if (!(await askConfirm({ title: 'Remove the arrival time? · 移除送达时间?', danger: true, confirmLabel: 'Remove' }))) return;
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

// Switch a GZ outer-district parcel between rider (local ETA) and JD logistics
// (waybill). Flips the shipment mode server-side, then reloads the drawer so the
// matching card renders in place. Carriers are pre-loaded so the JD waybill
// card's carrier dropdown is populated the instant it appears.
async function setShipmentMethod(orderId, shipmentId, method, ev) {
  if (method === 'land') { try { await ensureTrackingCarriers(); } catch {} }
  try {
    await adminWrite({
      btn: ev?.currentTarget,
      url: `/api/retail-admin/orders/${orderId}/shipments/${shipmentId}/method`,
      method: 'POST', body: { method },
      errLabelEn: 'Switch failed', errLabelCn: '切换失败',
    });
    toast(method === 'local'
      ? 'Switched to rider · 已改为骑手配送'
      : 'Switched to JD logistics · 已改为京东物流');
    const _mount = document.getElementById('order-detail-mount');
    const _scrollTop = _mount ? _mount.scrollTop : 0;
    await openOrder(orderId);
    if (_mount) _mount.scrollTop = _scrollTop;
    loadOrders();   // refresh the list so the tracking/ETA cell reflects the new method
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
  bg.className = 'pu-editor-bg tacet';
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
    // Shares step 4 with Paid — the payout is claimed and money is moving through
    // the gateway. Dusk tint + a breathing dot = the system is acting; it settles
    // into the sage-tint '4. Paid' on its own once the gateway confirms.
    paying:     { label: '4. Paying · 退款中',        color: 'var(--td-dusk)', bg: 'var(--td-dusk-tint)', dot: true },
    paid:       { label: '4. Paid · 已退款',          color: '#5fc28e', bg: 'rgba(95,194,142,.18)' },
    rejected:   { label: '✗ Rejected · 已拒绝',       color: 'var(--danger)', bg: 'rgba(232,85,106,.1)' },
    withdrawn:  { label: '↺ Withdrawn · 已撤回',      color: 'var(--text-3)', bg: 'var(--bg-elev-1)' },
  };
  const m = map[state];
  if (!m) return '';
  // A breathing Dusk dot marks the one in-flight step (paying); the resting
  // steps carry no dot. td-dusk-dot brings its own colour + reduced-motion guard.
  const dot  = m.dot ? '<span class="td-dusk-dot" aria-hidden="true"></span>' : '';
  const disp = m.dot ? 'inline-flex; align-items: center; gap: 6px' : 'inline-block';
  return `<span style="display: ${disp}; padding: 3px 10px; border-radius: 999px; background: ${m.bg}; color: ${m.color}; font-size: 11px; font-weight: 600; letter-spacing: .05em;">${dot}${m.label}</span>`;
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
  // Cash vs store-credit split. refund_cash_amount is the cash slice settled via
  // the gateway/manual payout; the rest of the approved VALUE went back to the
  // customer's wallet + points. Only surfaced when an order paid with store
  // credit was refunded (creditAmt > 0) — credit-free refunds show one figure.
  const cashAmt   = o.refund_cash_amount != null ? Number(o.refund_cash_amount) : null;
  const creditAmt = (cashAmt != null && apvAmt != null) ? Math.max(0, +(apvAmt - cashAmt).toFixed(2)) : null;
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
                 : state === 'paying'     ? 'var(--td-dusk-tint)'    // dusk — system acting
                 : state === 'paid'       ? 'rgba(95,194,142,.14)'   // green, slightly stronger
                 : state === 'rejected'   ? 'rgba(232,85,106,.08)'   // red, subtle
                 : state === 'withdrawn'  ? 'var(--bg-elev-1)'       // theme-neutral
                 : 'var(--bg-elev-1)';
  const headerBorder = state === 'paid' ? '#5fc28e' :
                       state === 'paying' ? 'var(--td-dusk)' :
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
           return `<div style="display:flex; justify-content: space-between;"><span>${escapeHtml(label)} × ${l.qty}</span><b>${acMoney(l.amount)}</b></div>`;
         }).join('')}
       </div>` : '';

  const amountSummary = isApproved || state === 'paying' || state === 'paid'
    ? `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 10px; font-size: 12px;">
        <div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Order total · 订单总额</div><b>${acMoney(total)}</b></div>
        ${reqAmt != null ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Requested · 申请金额</div><b>${acMoney(reqAmt)}</b></div>` : ''}
        ${apvAmt != null ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Approved · 已批准</div><b>${acMoney(apvAmt)}</b></div>` : ''}
        ${paidAmt != null ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Paid back · 已退款</div><b>${acMoney(paidAmt)}</b></div>` : ''}
        ${creditAmt != null && creditAmt > 0.005 ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Cash refunded · 现金退款</div><b>${acMoney(cashAmt)}</b></div><div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">To wallet/points · 退回余额/积分</div><b>${acMoney(creditAmt)}</b></div>` : ''}
        ${o.refund_payout_method ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Method · 方式</div><b>${escapeHtml(o.refund_payout_method)}</b>${o.refund_payout_ref ? `<div class="muted" style="font-size: 10px; font-family: var(--f-mono); margin-top: 2px;">${escapeHtml(o.refund_payout_ref)}</div>` : ''}</div>` : ''}
      </div>` : reqAmt != null
        ? `<div style="margin-top: 8px; font-size: 12px;">${cuT(`Customer asked for <b>${acMoney(reqAmt)}</b> of <b>${acMoney(total)}</b>`, `顾客申请退 <b>${acMoney(reqAmt)}</b> / 共 <b>${acMoney(total)}</b>`)}</div>`
        : '';

  return `
    <div style="margin: 0 0 16px; padding: 14px 16px; background: ${headerBg}; border-left: 4px solid ${headerBorder}; border-radius: 4px;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 10px;">
          ${refundStepBadge(state)}
          <span class="muted" style="font-size: 11px;">${o.refund_requested_at ? cuT('requested', '申请于') + ' ' + formatDate(o.refund_requested_at) : ''}</span>
        </div>
        <button class="btn btn-sm" onclick="openRefundEvents(${o.id})" title="Audit log · 审计记录"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/></svg>History · 历史</button>
      </div>
      ${o.refund_reason ? `<div style="margin-top: 10px; font-size: 13px;">${escapeHtml(o.refund_reason)}</div>` : ''}
      ${customerLinesBlock}
      ${amountSummary}
      ${o.refund_review_note ? `<div class="muted" style="margin-top: 8px; font-size: 12px;">${cuT('Staff note', '客服备注')}: ${escapeHtml(o.refund_review_note)}</div>` : ''}
      ${state === 'paying' ? `<div class="muted" style="margin-top: 12px; display: flex; align-items: center; gap: 8px; font-size: 12px;"><span class="td-dusk-dot" aria-hidden="true"></span>Refund in progress — the money is moving through the payment gateway. This finishes on its own; no action needed. · 退款处理中 — 正在通过支付网关打款,稍后自动完成,无需操作。</div>` : ''}
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
    image_url: it.image_url || '', sku: it.sku || '', size: it.size || '',
    qty: Number(it.qty) || 0, refunded_qty: Number(it.refunded_qty) || 0,
    unit: it.qty > 0 ? (Number(it.line_total) / Number(it.qty)) : Number(it.unit_price || 0),
  }));
  const total = Number(o.total) || 0;

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg tacet';
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
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="drf-mode" value="full" checked> ${cuT('Full', '全额')} ${acMoney(total)}</label>
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="drf-mode" value="amount"> ${cuT('Part — by amount', '部分 — 按金额')}</label>
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="drf-mode" value="lines"> ${cuT('Part — by items', '部分 — 按商品')}</label>
          </div>
        </div>
        <div class="field" id="drf-amt-wrap" style="margin-bottom: 14px; display: none;">
          <label class="stacked">${cuT('Amount', '金额')} (${acCurrencySymbol()})</label>
          <input type="number" id="drf-amt" step="0.01" min="0" max="${total}" value="${total.toFixed(2)}" style="width: 100%;">
          <div class="muted" style="font-size: 11px; margin-top: 4px;">${cuT('Order total', '订单总额')} ${acMoney(total)}</div>
        </div>
        <div class="field" id="drf-lines-wrap" style="margin-bottom: 14px; display: none;">
          <label class="stacked">${cuT('Items to refund', '退款商品')}</label>
          <div style="border: 1px solid var(--line-soft); border-radius: 6px; padding: 6px;">
            ${(() => {
              // Only offer units NOT already refunded, so a second refund can't
              // re-pick the same units (mirrors the server's remaining-qty cap).
              const refundable = items.filter(it => !itemFullyRefunded(it));
              if (!refundable.length) return `<div class="muted" style="padding: 8px;">${cuT('Everything has already been refunded', '已全部退款')}</div>`;
              return refundable.map(it => {
                const remain = Math.max(0, (Number(it.qty) || 0) - itemRefundedQty(it));
                const already = itemRefundedQty(it);
                return `
              <div style="display: flex; align-items: center; gap: 10px; padding: 6px; border-bottom: 1px solid var(--line-soft);">
                <label style="flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer; min-width: 0;">
                  <input type="checkbox" class="drf-line-chk" data-item="${it.id}" data-unit="${it.unit}" data-maxqty="${remain}">
                  ${itemThumb(it)}
                  <span style="min-width: 0;">${escapeHtml(it.name)}${it.size ? ` · ${escapeHtml(it.size)}` : ''}${already > 0 ? ` <span class="muted" style="font-size:10px;">(${already} ${cuT('already refunded', '已退')})</span>` : ''}<br>${itemSkuHtml(it)}</span>
                </label>
                <input type="number" class="drf-line-qty" data-item="${it.id}" step="0.001" min="0" max="${remain}" value="${remain}" style="width: 80px;">
                <span class="muted" style="font-size: 11px;">× ${acMoney(it.unit)} = <b id="drf-line-amt-${it.id}">${acMoney(it.unit * remain)}</b></span>
              </div>`;
              }).join('');
            })()}
          </div>
          <div style="margin-top: 6px; text-align: right; font-size: 13px;">${cuT('Items total', '商品合计')}: <b id="drf-lines-total">${acMoney(0)}</b></div>
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
      bg.querySelector(`#drf-line-amt-${it}`).textContent = acMoney(amt);
      sum += amt;
    });
    bg.querySelector('#drf-lines-total').textContent = acMoney(sum);
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
      // A 'manual' payout means no gateway money moved — the order was paid
      // off-app (cash, or a WeChat transfer in a chat), so the refund is
      // recorded on the books but the operator still has to send the money.
      // Saying only "Refunded" there reads as "done", and the customer waits.
      if (j.method === 'manual') {
        toast(cuT(
          `Recorded ${acMoney(j.amount || 0)} — pay the customer back by hand (paid off-app)`,
          `已记录 ${acMoney(j.amount || 0)} — 该订单为线下支付,请手动退款给顾客`), 'warn', 7000);
      } else {
        toast(cuT('Refunded', '已退款') + ` ${acMoney(j.amount || 0)}`);
      }
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
    image_url: it.image_url || '', sku: it.sku || '', size: it.size || '',
    qty: Number(it.qty) || 0, unit: it.qty > 0 ? (Number(it.line_total) / Number(it.qty)) : Number(it.unit_price || 0),
  }));
  const total = Number(o.total) || 0;
  let preLines = [];
  try { preLines = o.refund_lines_json ? JSON.parse(o.refund_lines_json) : []; } catch {}
  const preMap = new Map(preLines.map(l => [l.item_id, l.qty]));
  const defaultAmount = o.refund_amount_requested != null ? Number(o.refund_amount_requested) : total;
  // Open on whatever the customer actually asked for, not a blanket full refund:
  // selected lines → "by items"; a partial amount → "amount"; otherwise "full".
  const initialMode = preLines.length ? 'lines'
    : (o.refund_amount_requested != null && defaultAmount < total - 0.005) ? 'amount'
    : 'full';

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg tacet';
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
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="rf-mode" value="full" ${initialMode === 'full' ? 'checked' : ''}> Full · 全额</label>
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="rf-mode" value="amount" ${initialMode === 'amount' ? 'checked' : ''}> Partial — amount · 部分金额</label>
            <label style="display: flex; align-items: center; gap: 6px;"><input type="radio" name="rf-mode" value="lines" ${initialMode === 'lines' ? 'checked' : ''}> Partial — by items · 按商品</label>
          </div>
        </div>
        <div class="field" id="rf-amt-wrap" style="margin-bottom: 14px;">
          <label class="stacked">Amount · 金额 (${acCurrencySymbol()})</label>
          <input type="number" id="rf-amt" step="0.01" min="0" max="${total}" value="${(initialMode === 'amount' ? defaultAmount : total).toFixed(2)}" style="width: 100%;">
          <div class="muted" style="font-size: 11px; margin-top: 4px;">${cuT('Order total', '订单总额')} ${acMoney(total)}${o.refund_amount_requested != null ? ' · ' + cuT('customer asked for', '顾客申请') + ' ' + acMoney(o.refund_amount_requested) : ''}</div>
        </div>
        <div class="field" id="rf-lines-wrap" style="margin-bottom: 14px; display: none;">
          <label class="stacked">Lines · 商品</label>
          <div style="border: 1px solid var(--line-soft); border-radius: 6px; padding: 6px;">
            ${items.length ? items.map(it => `
              <div style="display: flex; align-items: center; gap: 10px; padding: 6px; border-bottom: 1px solid var(--line-soft);">
                <label style="flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer; min-width: 0;">
                  <input type="checkbox" class="rf-line-chk" data-item="${it.id}" data-unit="${it.unit}" data-maxqty="${it.qty}" ${preMap.has(it.id) ? 'checked' : ''}>
                  ${itemThumb(it)}
                  <span style="min-width: 0;">${escapeHtml(it.name)}${it.size ? ` · ${escapeHtml(it.size)}` : ''}<br>${itemSkuHtml(it)}</span>
                </label>
                <input type="number" class="rf-line-qty" data-item="${it.id}" step="0.001" min="0" max="${it.qty}" value="${preMap.get(it.id) ?? it.qty}" style="width: 80px;">
                <span class="muted" style="font-size: 11px;">× ${acMoney(it.unit)} = <b id="rf-line-amt-${it.id}">${acMoney(it.unit * (preMap.get(it.id) ?? it.qty))}</b></span>
              </div>`).join('') : `<div class="muted" style="padding: 8px;">${cuT('No items', '无商品')}</div>`}
          </div>
          <div style="margin-top: 6px; text-align: right; font-size: 13px;">${cuT('Lines total', '商品合计')}: <b id="rf-lines-total">${acMoney(0)}</b></div>
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
      bg.querySelector(`#rf-line-amt-${it}`).textContent = acMoney(amt);
      sum += amt;
    });
    bg.querySelector('#rf-lines-total').textContent = acMoney(sum);
  };
  bg.querySelectorAll('.rf-line-chk, .rf-line-qty').forEach(el => el.addEventListener('input', recalcLineAmt));
  recalcLineAmt();

  // Reflect the customer-driven initial mode in the panel visibility.
  bg.querySelector('#rf-amt-wrap').style.display    = (initialMode === 'full' || initialMode === 'amount') ? '' : 'none';
  bg.querySelector('#rf-lines-wrap').style.display  = (initialMode === 'lines') ? '' : 'none';
  bg.querySelector('#rf-points-wrap').style.display = (initialMode !== 'full') ? '' : 'none';
  bg.querySelector('#rf-points').checked = (initialMode === 'full');

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
      toast(`Approved · 已批准 ${acMoney(j.amount || 0)}`);
      bg.remove();
      openOrder(orderId);
      loadOrders();
    } catch {}
  });
}

// Map an order's original payment tender onto the payout-method picker. Only a
// real online WeChat order can be refunded automatically (the payout endpoint
// only auto-pushes for method 'wechat'); every other tender — including cash and
// WeChat/Alipay paid OFF-app — is a manual record, so we must NOT default those
// to WeChat or the operator hits "Payout failed: no WeChat transaction".
function _payoutDefaultMethod(pm) {
  switch ((pm || '').toLowerCase()) {
    case 'wechat':        return 'wechat';
    case 'alipay':
    case 'alipay_offline':return 'alipay';
    case 'bank_transfer': return 'bank';
    case 'wallet':        return 'wallet';
    case 'cash':          return 'cash';
    default:              return 'other'; // wechat_offline / points / other / unknown
  }
}

function openRefundPayoutDialog(orderId) {
  const o = _OPEN_ORDER;
  if (!o || o.id !== orderId) { toast('Reopen the order and try again · 请重新打开订单', 'err'); return; }
  const apv = Number(o.refund_amount_approved) || 0;
  const defMethod = _payoutDefaultMethod(o.payment_method);
  const isWechatOrder = (o.payment_method || '').toLowerCase() === 'wechat';

  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg tacet';
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
          <div id="rfp-method-warn" class="muted" style="display: none; font-size: 11px; margin-top: 6px; color: var(--danger, #c0392b);">
            ${cuT(
              'This order wasn\'t paid via online WeChat — there\'s no WeChat transaction to auto-refund. Pick the method you actually returned the money with.',
              '此订单非微信在线支付,没有可原路退款的微信交易。请选择你实际退款使用的方式。'
            )}
          </div>
        </div>
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">Reference / txn id · 凭证号</label>
          <input type="text" id="rfp-ref" data-ph-en="Provider txn id, bank ref, etc." data-ph-cn="第三方交易号、银行参考号等" placeholder="Provider txn id, bank ref, etc." style="width: 100%;">
        </div>
        <div class="field" style="margin-bottom: 14px;">
          <label class="stacked">Amount · 金额 (${acCurrencySymbol()})</label>
          <input type="number" id="rfp-amt" step="0.01" min="0" max="${apv}" value="${apv.toFixed(2)}" style="width: 100%;">
          <div class="muted" style="font-size: 11px; margin-top: 4px;">Approved ${acMoney(apv)} — usually paid in full · 已批准金额,通常一次性退还</div>
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

  // Default the picker to the tender the customer actually paid with, instead of
  // always WeChat — a cash order defaulting to WeChat Pay only ever produces
  // "Payout failed". Warn if the operator picks WeChat on a non-WeChat order.
  const methodSel = bg.querySelector('#rfp-method');
  const methodWarn = bg.querySelector('#rfp-method-warn');
  methodSel.value = defMethod;
  const syncMethodWarn = () => {
    methodWarn.style.display = (methodSel.value === 'wechat' && !isWechatOrder) ? 'block' : 'none';
  };
  methodSel.addEventListener('change', syncMethodWarn);
  syncMethodWarn();

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
      toast(`Payout recorded · 退款已记录 ${acMoney(j.amount || 0)}`);
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
      const amt = l.amount != null ? ` — ${acMoney(l.amount)}` : '';
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
  bg.className = 'pu-editor-bg tacet';
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
          <div><b>${escapeHtml(ev.event)}</b>${ev.amount != null ? ` <span class="muted">${acMoney(ev.amount)}</span>` : ''}</div>
          <div class="muted" style="font-size: 11px; margin-top: 2px;">${cuT('by', '操作人')} ${escapeHtml(ev.user_username || ev.customer_nickname || (ev.user_id ? 'staff#' + ev.user_id : cuT('customer', '顾客')))}</div>
          ${ev.note ? `<div style="font-size: 12px; margin-top: 4px;">${escapeHtml(ev.note)}</div>` : ''}
          ${formatRefundMeta(ev.meta)}
        </div>
      </div>`).join('');
  } catch (e) {
    bg.querySelector('#rfe-body').innerHTML = `<div class="err">${cuT('Failed', '加载失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
  }
}

// Refresh every open-work count badge on the orders status-chip strip in one
// cheap call. We badge ONLY the open states an operator is meant to clear
// (pending/paid/preparing/dispatched/awaiting-restock/refund-queue) — terminal
// states (delivered/cancelled/refunded/all) grow forever, so they stay bare.
// Each badge is hidden when its count is 0 (.chip-ct:empty), so cleared queues
// don't carry a "0". Honours the active store filter, matching the list.
// ── §1.7 status line — "Oldest unfulfilled order · 3 days" ──────────────────
// Deliberately NOT a count. "5 awaiting fulfilment" would restate Paid (2) +
// Preparing (3), two chips sitting directly under the line, and §1.7's
// non-duplication test rules that out. The age is the one fact nothing else on
// this page reports.
// The raw timestamp is cached so a language toggle can re-word the line without
// another round trip; the server sends null when nothing is waiting.
let _ORD_OLDEST_UNFULFILLED = null;
// How long the oldest job has been waiting, in one language.
// Under an hour is its own case: flooring to hours would print "0 hours".
// Chinese has no plural form, so one string covers both counts there.
function ordWaitingAge(iso) {
  // 🔴 Parse via courierAgeMs, never `new Date(iso)`. SQLite writes
  // 'YYYY-MM-DD HH:MM:SS' with NO zone marker, and bare `new Date()` reads that
  // as LOCAL time. In Guangzhou (UTC+8) the value then lands 8 hours EARLY, so
  // every age reads 8 hours OLDER than it is — measured: 81h against a true
  // 73h — silently, with a correct-looking number. courierAgeMs normalises
  // both shapes (zoned ISO like seen_at, and the bare SQLite form) and is the
  // same helper formatDate's comment describes.
  const ms = courierAgeMs(iso);
  if (!isFinite(ms) || ms < 0) return null;          // unparseable / clock skew
  const hours = Math.floor(ms / 3600000);
  if (hours < 1)  return cuT('under an hour', '不到 1 小时');
  if (hours < 24) return cuT(hours === 1 ? '1 hour' : hours + ' hours', hours + ' 小时');
  const days = Math.floor(hours / 24);
  return cuT(days === 1 ? '1 day' : days + ' days', days + ' 天');
}
// Nothing waiting → the element stays hidden and EMPTY. §1.7: a page with
// nothing waiting gets no line at all, and that space is the finished answer —
// not a "0", not an empty box holding its height.
function ordRenderStatusLine() {
  const el = document.getElementById('ord-status-line'); if (!el) return;
  const age = _ORD_OLDEST_UNFULFILLED ? ordWaitingAge(_ORD_OLDEST_UNFULFILLED) : null;
  if (!age) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = cuT('Oldest unfulfilled order', '最久未处理的订单') + ' · ' + age;
  el.hidden = false;
}

async function refreshOrderStatusCounts() {
  if (!document.getElementById('orders-status-chips')) return;
  // The Drafts count rides along on the same refresh, from its OWN endpoint —
  // /order-status-counts counts retail_orders and cannot see a draft, which is
  // the point. Fired and not awaited: a slow draft list must not hold up the
  // status counts.
  if (typeof ordRefreshDraftCount === 'function') ordRefreshDraftCount();
  const storeId = (document.getElementById('orders-store') || {}).value || '';
  try {
    const j = await api('/api/retail-admin/order-status-counts' + (storeId ? '?store_id=' + storeId : ''));
    const d = j.data || {};
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n > 0 ? String(n) : ''; };
    set('oc-pending_payment', d.pending_payment);
    set('oc-paid',            d.paid);
    set('oc-preparing',       d.preparing);
    set('oc-rider_pickup',    d.rider_pickup);
    set('oc-dispatched',      d.dispatched);
    set('oc-awaiting_restock',d.awaiting_restock);
    set('refund-queue-count', d.refunds_open);
    set('oc-needs_invoice',   d.needs_invoice);
    // Same call, same store filter, same read-only-channel exclusion as the
    // badges above — so the header line can never disagree with the chips.
    _ORD_OLDEST_UNFULFILLED = d.oldest_unfulfilled || null;
    ordRenderStatusLine();
  } catch {}
}

// Channel chips are a plain filter axis — no per-channel counts. The actionable
// numbers live on the status counters (pending, paid, preparing, …) instead.
function refreshOrderChannelCounts() {}

// The manual New-order MODAL lived here and was deleted 2026-07-31, with its
// markup (#om-bg, #om-done-bg) and its styles. Orders are authored on the full
// sub-page below (§1.13 — the operator adds lines, so the height is unknown on
// open, and it was never a bounded decision). Two ways to create an order, one
// of them carrying 15 uppercase labels and 37 glued EN·中文 nodes, is not a
// state to leave behind.
//
// The one thing that did NOT simply go: the post-create dialog was the only
// place a guest pay link could be read, and only for the seconds it was on
// screen. It is now a tile in the order drawer (orderPayLinkTile), so the link
// outlives the moment the order was created.

// ═══ Orders · New order — full sub-page (§1.7a takeover) ═══════════════
// The container only lives here; the form renders into #onw-body (ordNewRender).
// Mechanism: goTab('orders-new') makes #tab-orders-new the ONE active section —
// #tab-orders loses .active and is display:none, so its Dusk CTA leaves the tab
// order and the accessibility tree (§1.7a condition 2). body.ord-viewing (the
// detail-view takeover, revived) pins main below the topbar and hands the
// section the full content height; the page scrolls inside .onw-scroll.
//
// Back-trap: same shape as the product lightbox (09-products.js) — opening
// pushes a throwaway history entry so the operator's instinct to press browser
// Back mid-order lands them on Orders, never outside the section. Closing any
// other way consumes that entry via history.back().
// `draft` (optional) is a row from GET /order-drafts/:id — opening one restores
// the form and keeps editing the same draft, so Save draft PATCHes rather than
// piling up a second copy.
let _ORD_NEW_OPEN = false;
function ordNewOpen(draft) {
  if (_ORD_NEW_OPEN) return;
  _ORD_NEW_OPEN = true;
  // goTab first: it closes any open side-drawers, and closeDrawer('#order-drawer')
  // strips ord-viewing — so the class must be added AFTER, never before.
  goTab('orders-new');
  document.body.classList.add('ord-viewing');
  history.pushState({ ordNew: true }, '');
  window.addEventListener('popstate', _ordNewOnPop);
  const sc = document.getElementById('onw-scroll');
  if (sc) sc.scrollTop = 0;
  if (typeof ordNewRender === 'function') ordNewRender();
  // Restore AFTER the reset render, so a draft overwrites a clean form rather
  // than being half-overwritten by one.
  if (draft && typeof ordNewRestore === 'function') ordNewRestore(draft);
}
// Browser Back → the trap entry pops → land on the Orders list (§1.7a cond 3).
function _ordNewOnPop() {
  _ordNewTeardown(true);
  goTab('orders');
}
// Shared exit: drop the takeover + the popstate listener, and consume the trap
// entry unless the pop itself is what got us here. Does NOT navigate — the
// caller decides where to land (Back goes to Orders; a rail click is already
// navigating somewhere else and must not be overridden).
function _ordNewTeardown(viaPop) {
  if (!_ORD_NEW_OPEN) return;
  _ORD_NEW_OPEN = false;
  document.body.classList.remove('ord-viewing');
  window.removeEventListener('popstate', _ordNewOnPop);
  if (!viaPop) history.back();
}
function ordNewBack() {
  _ordNewTeardown(false);
  goTab('orders');
}
// A rail click while the page is open navigates away without going through
// ordNewBack — tear the takeover down first (capture phase, so ord-viewing is
// gone before the tab switcher shows the next section, which ord-viewing's
// `main > section { display:none }` would otherwise hide).
document.addEventListener('click', (e) => {
  if (!_ORD_NEW_OPEN) return;
  if (e.target.closest && e.target.closest('.tabs [data-tab]')) _ordNewTeardown(false);
}, true);
// ── The form. State lives here; the static markup in retail-admin.html is
// the switchable surface (glued EN·中文 pairs for the walker). Dynamic
// regions hold outside-system text — names, phones, SKUs — so they carry
// data-no-i18n in the markup and bake ONE language with cuT(); the
// onLangChange hook at the bottom re-paints them on toggle.
let ONW = null;
let onwCustTimer = null, onwProdTimer = null;

function onwIc(d, w) {
  return `<svg class="onw-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w || 1.7}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}
const ONW_ICONS = {
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  warn: '<path d="M12 3.5 22 20H2L12 3.5Z"/><path d="M12 10v4M12 17h.01"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.3a3.2 3.2 0 0 1 0 5.4M17.5 20a6.5 6.5 0 0 0-2-4.7"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
};
function onwMoney(n) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-' : '') + acWrap(s[0].replace(/\B(?=(\d{3})+$)/g, ',') + '.' + s[1]);
}

// Reset to frame A — nothing entered — and paint every dynamic region.
function ordNewRender() {
  ONW = {
    cust: 'rest',            // rest | linked | guest
    customer: null,          // { id, nickname, phone } when linked
    saveCust: true,          // "Also save as a customer" — on by default (frame C)
    ful: 'delivery',
    lines: [],               // [{ product_id, name_en, name_cn, sku, qty, unit_price }]
    custResults: [], prodResults: [],
    draftId: null,           // set once Save draft has written one (commit 4 opens them)
    customersOnFile: null,   // from the roster response — tells (c) from (d)
    custQuery: '',
    phoneNote: null,         // { kind: match|blocked|shared, name, phone, count }
    // Which of the two fee fields the operator has typed in. A touched field is
    // never refilled from the zone quote again — see ordNewFeeTyped.
    feeTouched: { ship: false, pack: false },
  };
  // The busy latch and the two action buttons only ever get set BUSY/disabled
  // (ordNewSetBusy) — a successful create leaves them that way on purpose
  // (§1.12's in-flight rule: "Created"/"Saved" stays put while the page is
  // mid-redirect). Nothing ever put them back for the NEXT order, so opening
  // this form a second time in the same session found Create order still
  // disabled and _ORD_NEW_BUSY still true — clicking it, or Save draft, was a
  // silent no-op forever after the first order this page created.
  _ORD_NEW_BUSY = false;
  const createBtn = document.getElementById('onw-create');
  if (createBtn) { createBtn.disabled = false; createBtn.textContent = cuT('Create order', '创建订单'); }
  const draftBtn = document.getElementById('onw-draft');
  if (draftBtn) { draftBtn.disabled = false; draftBtn.textContent = cuT('Save draft', '存为草稿'); }
  ['onw-cust-q', 'onw-guest-name', 'onw-guest-phone', 'onw-prod-q',
   'onw-addr-name', 'onw-addr-phone',
   'onw-addr-street', 'onw-addr-postal', 'onw-note-cust', 'onw-note-staff']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  // The two region selects are rebuilt, not blanked — a <select> with no options
  // cannot hold the empty value the rest of the reset assumes. Fire-and-forget:
  // the catalogue fetch is cached after the first open and the operator reaches
  // the address block long after it lands.
  ordNewFillCities('');
  ordNewFillDistricts('', '');
  const provCap = document.getElementById('onw-addr-prov'); if (provCap) provCap.hidden = true;
  const ship = document.getElementById('onw-ship'); if (ship) ship.value = '0';
  const pack = document.getElementById('onw-pack'); if (pack) pack.value = '0';
  const ovr = document.getElementById('onw-override'); if (ovr) ovr.value = '';
  // No pre-selection: the operator has to say where the order came from. A
  // default here is what produced a pile of orders whose origin nobody ever
  // answered, and which the Sales page then had no card to file under.
  const ch = document.getElementById('onw-channel'); if (ch) ch.value = '';
  const chn = document.getElementById('onw-channel-note'); if (chn) chn.value = '';
  ordNewChannelChange();
  const ful = document.getElementById('onw-ful'); if (ful) ful.value = 'delivery';
  const st = document.getElementById('onw-status'); if (st) st.value = 'pending_payment';
  const pay = document.getElementById('onw-pay'); if (pay) pay.value = 'wechat';
  ordNewLoadStores();
  ordNewPaintCustState();
  ordNewHideResults('onw-cust-results'); ordNewHideResults('onw-prod-results');
  ordNewPaintPhoneNote();
  ordNewFulChange();
  ordNewRenderLines();
  setTimeout(() => { const el = document.getElementById('onw-cust-q'); if (el) el.focus(); }, 60);
}
function ordNewHideResults(id) { const el = document.getElementById(id); if (el) { el.hidden = true; el.innerHTML = ''; } }

// Stores fill once per open. The first store is preselected — the common case
// is the operator's own store; a different routing is one change away.
async function ordNewLoadStores() {
  const sel = document.getElementById('onw-store');
  if (!sel) return;
  try {
    const j = await api('/api/retail-admin/stores');
    const stores = (j.data || []).filter(s => s.is_active !== 0);
    sel.innerHTML = stores.map(s =>
      `<option value="${s.id}">${escapeHtml(cuT(s.name_en || s.code || ('#' + s.id), s.name_cn || s.name_en || s.code || ('#' + s.id)))}</option>`).join('');
    if (stores.length) sel.value = String(stores[0].id);
  } catch { sel.innerHTML = ''; }
}

// ── Customer — five states (frames A/B) ────────────────────────────────
function ordNewCustSearch() {
  clearTimeout(onwCustTimer);
  const q = (document.getElementById('onw-cust-q').value || '').trim();
  ONW.custQuery = q;
  if (!q) { ordNewHideResults('onw-cust-results'); return; }
  onwCustTimer = setTimeout(async () => {
    try {
      const j = await api('/api/retail-admin/customers?pageSize=8&q=' + encodeURIComponent(q));
      if (ONW.custQuery !== q) return;   // a newer keystroke superseded this
      ONW.custResults = (j.data || []).slice(0, 8);
      // The server now tells no-match from empty catalogue (§1.12's two most
      // conflated states) — carry the count so the copy can differ.
      ONW.customersOnFile = (j.customers_on_file != null) ? Number(j.customers_on_file) : null;
      ordNewPaintCustResults();
    } catch { ordNewHideResults('onw-cust-results'); }
  }, 220);
}
function ordNewPaintCustResults() {
  const box = document.getElementById('onw-cust-results');
  if (!box) return;
  const q = ONW.custQuery;
  if (!q || ONW.cust !== 'rest') { box.hidden = true; box.innerHTML = ''; return; }
  if (ONW.custResults.length) {
    box.innerHTML = '<div class="onw-res">' + ONW.custResults.map((c, i) => {
      const nm = escapeHtml(c.nickname || cuT('(no name)', '(未命名)'));
      const ph = escapeHtml(c.phone || '');
      const ct = (c.orders_count != null) ? escapeHtml(cuT(c.orders_count + ' orders', c.orders_count + ' 单')) : '';
      return `<button type="button" onclick="ordNewPickCustomer(${i})"><span class="nm">${nm}</span><span class="ph">${ph}</span><span class="ct">${ct}</span></button>`;
    }).join('') + '</div>';
  } else if (ONW.customersOnFile === 0) {
    // (d) no customers at all — a different sentence from (c). Not an error:
    // the operator has not failed at anything.
    box.innerHTML = `<div class="onw-offer"><p>${escapeHtml(cuT('No customers on this account yet — this order can be the first.', '此账户还没有顾客——这一单可以是第一位。'))}</p>
      <div><button type="button" class="onw-btn onw-sec onw-sm" onclick="ordNewUseGuest()">${escapeHtml(cuT('Use "' + q + '" as a guest name', '将"' + q + '"用作访客姓名'))}</button></div></div>`;
  } else {
    // (c) customers exist; this text matched none of them.
    box.innerHTML = `<div class="onw-offer"><p>${escapeHtml(cuT('No customer matches "' + q + '".', '没有顾客匹配"' + q + '"。'))}</p>
      <div><button type="button" class="onw-btn onw-sec onw-sm" onclick="ordNewUseGuest()">${escapeHtml(cuT('Use "' + q + '" as a guest name', '将"' + q + '"用作访客姓名'))}</button></div></div>`;
  }
  box.hidden = false;
}
function ordNewPickCustomer(i) {
  const c = ONW.custResults[i];
  if (!c) return;
  ONW.cust = 'linked';
  ONW.customer = { id: c.id, nickname: c.nickname || '', phone: c.phone || '' };
  ONW.phoneNote = null;
  ordNewPaintCustState();
  ordNewPaintPhoneNote();
  // Deliberately NOT awaited: the chip has to appear on this tick. The prefill
  // is one GET that settles a moment later, never gates the two paints above,
  // and swallows its own failures.
  ordNewPrefillAddress(c.id);
}

// ── The address this customer already has on file ──────────────────────
// Picking a customer fills the delivery block from their DEFAULT saved address.
// This is a COPY, not a parse: retail_customer_addresses stores province / city
// / district as the same canonical catalogue strings (广东省 / 广州市 / 天河区)
// that retail_delivery_zones matches on by exact equality, so the values go
// straight into the two selects the operator would otherwise pick by hand.
//
// IT OVERWRITES whatever is in the fields. Picking a customer is a deliberate
// act, and a merge that kept half of some previous address would be harder to
// reason about than a clean replacement — every field stays editable after.
//
// IT RUNS FOR EVERY FULFILMENT. The block is hidden on pickup and counter, but
// an operator who switches to Delivery afterwards must find the address already
// sitting there rather than an empty form.
//
// NOTHING HERE FAILS LOUDLY. No address book, an empty list, a dead network —
// each leaves the block exactly as it was and the operator types the address by
// hand, which is what they did before this existed.

// '+8613800138000' / '8613800138000' → '13800138000'. The input sits behind a
// fixed '+86' prefix, so a stored country code would read back as +86 +86.
// Narrow on purpose: the code comes off ONLY when what follows is a plain run
// of digits, so a field holding a note ('门卫电话 1380…') or a foreign number is
// handed back exactly as stored — see lib/phone-cn.js on why a phone number is
// never rewritten on a guess.
function onwLocalPhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^\+?86(\d{7,15})$/.exec(s);
  return m ? m[1] : s;
}

let _ONW_PREFILL = 0;
async function ordNewPrefillAddress(customerId) {
  const mine = ++_ONW_PREFILL;
  const ownONW = ONW;                  // the form instance this prefill belongs to
  let a;
  try {
    const j = await api('/api/retail-admin/customers/' + encodeURIComponent(customerId) + '/addresses');
    const list = j && j.data && j.data.addresses;
    // No saved address — a guest-shaped account, or someone who has only ever
    // collected. Not an error and not something to announce: leave the block.
    if (!Array.isArray(list) || !list.length) return;
    // Entry zero IS the default: the endpoint orders by is_default DESC, id DESC
    // (routes/retail.js). Re-sorting here could only ever disagree with it.
    a = list[0];
  } catch (e) {
    // Covers the 401 case too, where api() has already navigated to the login.
    console.error('[ordNewPrefillAddress]', e);
    return;
  }
  // A second pick, or a reset/close, owns the fields now. ONW is REPLACED by
  // ordNewRender, so identity is what tells a re-opened form from this one.
  if (mine !== _ONW_PREFILL || ONW !== ownONW || !_ORD_NEW_OPEN) return;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('onw-addr-name', a.recipient_name || '');
  set('onw-addr-phone', onwLocalPhone(a.phone));
  set('onw-addr-street', a.address || '');
  // Almost always empty — no customer app collects one and the zone matcher
  // never reads one. Copied anyway, so a hand-entered code isn't thrown away.
  set('onw-addr-postal', a.postal_code || '');

  // Same order, and the same reason, as ordNewRestore: a <select> can only hold
  // a value once its options exist, and the district list depends on the city.
  // ordNewFillCities repaints the province caption itself, so the derived 省
  // lands with the city rather than needing a field of its own.
  try {
    await ordNewFillCities(a.city || '');
    if (mine !== _ONW_PREFILL || ONW !== ownONW) return;
    await ordNewFillDistricts(a.city || '', a.district || '');
  } catch (e) {
    console.error('[ordNewPrefillAddress regions]', e);   // pickers stay empty
  }
  if (mine !== _ONW_PREFILL || ONW !== ownONW || !_ORD_NEW_OPEN) return;
  // Re-quote both fees against the destination that just arrived.
  ordNewAddrChanged();
}
function ordNewUseGuest() {
  ONW.cust = 'guest';
  ONW.customer = null;
  ordNewPaintCustState();
  const nm = document.getElementById('onw-guest-name');
  if (nm && !nm.value) nm.value = ONW.custQuery || '';
  const ph = document.getElementById('onw-guest-phone');
  if (ph) ph.focus();
}
// The chip's ✕ — returns to the resting field (state a).
function ordNewRemoveCust() {
  ONW.cust = 'rest';
  ONW.customer = null;
  ONW.phoneNote = null;
  ONW.custResults = []; ONW.custQuery = '';
  const q = document.getElementById('onw-cust-q'); if (q) q.value = '';
  const nm = document.getElementById('onw-guest-name'); if (nm) nm.value = '';
  const ph = document.getElementById('onw-guest-phone'); if (ph) ph.value = '';
  ordNewPaintCustState();
  ordNewPaintPhoneNote();
  if (q) q.focus();
}
// Show/hide the three customer sub-regions to match ONW.cust.
function ordNewPaintCustState() {
  const srch = document.getElementById('onw-cust-srchrow');
  const chiprow = document.getElementById('onw-cust-chiprow');
  const guest = document.getElementById('onw-guest-fields');
  if (!srch || !chiprow || !guest) return;
  const state = ONW.cust;
  srch.hidden = state !== 'rest';
  guest.hidden = state !== 'guest';
  if (state === 'rest') { chiprow.hidden = true; chiprow.innerHTML = ''; ordNewPaintCustResults(); return; }
  ordNewHideResults('onw-cust-results');
  const label = state === 'linked'
    ? escapeHtml(ONW.customer && (ONW.customer.nickname || ('#' + ONW.customer.id)) || '')
    : escapeHtml(cuT('Guest', '访客'));
  const sub = state === 'linked' && ONW.customer && ONW.customer.phone
    ? ` <span class="ph">${escapeHtml(ONW.customer.phone)}</span>` : '';
  chiprow.innerHTML = `<span class="onw-chip">${label}${sub}<button type="button" class="x" onclick="ordNewRemoveCust()" title="${escapeHtml(cuT('Remove', '移除'))}">${onwIc(ONW_ICONS.x, 2)}</button></span>`;
  chiprow.hidden = false;
  if (state === 'guest') ordNewSyncSaveCust();
}
function ordNewToggleSaveCust() {
  ONW.saveCust = !ONW.saveCust;
  ordNewSyncSaveCust();
}
function ordNewSyncSaveCust() {
  const b = document.getElementById('onw-save-cust');
  if (b) b.classList.toggle('on', !!ONW.saveCust);
}

// ── The phone-match warning (frame C) — three outcomes plus silence ────
// Runs the by-phone lookup, the IDENTICAL equality the create path's
// reuse-by-phone uses — never the roster search (substring, and it would
// have to be filtered). The lookup answers the same for blocked and
// unblocked; blocked is NEVER hidden, because the save attaches to that
// record regardless and "no match" would be a lie.
function ordNewPhoneBlur() {
  const raw = (document.getElementById('onw-guest-phone').value || '').replace(/\s+/g, '');
  if (!raw || !/^\+?[0-9]{7,15}$/.test(raw)) { ONW.phoneNote = null; ordNewPaintPhoneNote(); return; }
  api('/api/retail-admin/customers/by-phone?phone=' + encodeURIComponent(raw))
    .then(j => {
      if (!j || !j.match) { ONW.phoneNote = null; }
      else {
        const kind = (Number(j.share_count) > 1) ? 'shared' : (j.match.is_blocked ? 'blocked' : 'match');
        ONW.phoneNote = { kind, name: j.match.nickname || ('#' + j.match.id), phone: raw, count: Number(j.share_count) || 1 };
      }
      ordNewPaintPhoneNote();
    })
    .catch(() => { /* silence — the warning is best-effort; create re-checks */ });
}
function ordNewPaintPhoneNote() {
  const box = document.getElementById('onw-phone-note');
  if (!box) return;
  const n = ONW && ONW.phoneNote;
  if (!n) { box.innerHTML = ''; return; }
  const nm = escapeHtml(n.name), ph = escapeHtml(n.phone);
  let cls, ico, html;
  if (n.kind === 'blocked') {
    cls = 'brick'; ico = ONW_ICONS.block;
    html = cuT(`<b>${ph} belongs to ${nm}, whose account is blocked.</b> The order will still be filed under that record.`,
               `<b>${ph} 属于 ${nm},该账户已被拉黑。</b>订单仍会记入该档案。`);
  } else if (n.kind === 'shared') {
    cls = 'amber'; ico = ONW_ICONS.people;
    html = cuT(`<b>${ph} is shared by ${n.count} customers.</b> The order will be filed under ${nm}, the oldest record.`,
               `<b>${ph} 有 ${n.count} 位顾客共用。</b>订单将记入最早的档案:${nm}。`);
  } else {
    cls = 'amber'; ico = ONW_ICONS.warn;
    html = cuT(`<b>${ph} belongs to ${nm}.</b> The order will be filed under that customer record, not a new one.`,
               `<b>${ph} 属于 ${nm}。</b>订单将记入这位顾客的档案,不会新建。`);
  }
  box.innerHTML = `<div class="onw-note ${cls}">${onwIc(ico)}<span>${html}</span></div>`;
}

// ── Products — search, then a line table with a pinned band ────────────
function ordNewProdSearch() {
  clearTimeout(onwProdTimer);
  const q = (document.getElementById('onw-prod-q').value || '').trim();
  if (!q) { ordNewHideResults('onw-prod-results'); return; }
  onwProdTimer = setTimeout(async () => {
    try {
      const j = await api('/api/retail-admin/products?limit=10&q=' + encodeURIComponent(q));
      ONW.prodResults = (j.data || []).slice(0, 10);
      const box = document.getElementById('onw-prod-results');
      if (!box) return;
      if (!ONW.prodResults.length) {
        box.innerHTML = `<div class="onw-offer"><p>${escapeHtml(cuT('No product matches "' + q + '".', '没有商品匹配"' + q + '"。'))}</p></div>`;
      } else {
        box.innerHTML = '<div class="onw-res">' + ONW.prodResults.map((p, i) => {
          const nm = escapeHtml(cuT(p.name_en || p.name_cn, p.name_cn || p.name_en) || ('#' + p.id));
          const sku = escapeHtml(p.sku || '');
          return `<button type="button" onclick="ordNewAddLine(${i})"><span class="nm">${nm}</span><span class="ph">${sku}</span><span class="ct">${onwMoney(p.sell_price)}</span></button>`;
        }).join('') + '</div>';
      }
      box.hidden = false;
    } catch { ordNewHideResults('onw-prod-results'); }
  }, 220);
}
function ordNewAddLine(i) {
  const p = ONW.prodResults[i];
  if (!p) return;
  const existing = ONW.lines.find(l => l.product_id === p.id);
  if (existing) existing.qty += 1;
  else ONW.lines.push({ product_id: p.id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku, qty: 1, unit_price: Number(p.sell_price) || 0 });
  const q = document.getElementById('onw-prod-q'); if (q) q.value = '';
  ordNewHideResults('onw-prod-results');
  ordNewRenderLines();
}
function ordNewLineQty(i, d) {
  const l = ONW.lines[i];
  if (!l) return;
  l.qty = Math.max(0, (Number(l.qty) || 0) + d);
  ordNewRenderLines();
}
function ordNewRemoveLine(i) {
  ONW.lines.splice(i, 1);
  ordNewRenderLines();
}
function ordNewRenderLines() {
  const wrap = document.getElementById('onw-lines-wrap');
  if (!wrap) return;
  if (!ONW.lines.length) {
    // Empty names the first action rather than apologising (§1.12).
    wrap.innerHTML = `<div class="onw-empty">${escapeHtml(cuT('No lines yet. Search above to add the first product.', '还没有商品行。在上方搜索,添加第一个商品。'))}</div>`;
    ordNewRecalc(); ordNewFeesDebounced(); return;
  }
  const rows = ONW.lines.map((l, i) => {
    const bad = !(Number(l.qty) > 0);
    const nm = escapeHtml(cuT(l.name_en || l.name_cn, l.name_cn || l.name_en) || ('#' + l.product_id));
    const sku = l.sku ? `<span class="ps">SKU ${escapeHtml(l.sku)}</span>` : '';
    // A failing line shows an em dash, never a false ¥0.00 (frame G).
    const lineTotal = bad ? '—' : onwMoney((Number(l.qty) || 0) * (Number(l.unit_price) || 0));
    const err = bad ? `<div class="onw-inerr">${onwIc(ONW_ICONS.warn, 2)}${escapeHtml(cuT('Enter 1 or more', '请输入 1 或以上'))}</div>` : '';
    return `<tr>
      <td class="pd"><span class="pn">${nm}</span>${sku}</td>
      <td class="qt"><div class="onw-step${bad ? ' bad' : ''}"><button type="button" onclick="ordNewLineQty(${i},-1)">–</button><span>${Number(l.qty) || 0}</span><button type="button" onclick="ordNewLineQty(${i},1)">+</button></div>${err}</td>
      <td class="mo">${onwMoney(l.unit_price)}</td>
      <td class="mo">${lineTotal}</td>
      <td class="rm"><button type="button" onclick="ordNewRemoveLine(${i})" title="${escapeHtml(cuT('Remove line', '移除此行'))}">${onwIc(ONW_ICONS.trash, 1.6)}</button></td></tr>`;
  }).join('');
  wrap.innerHTML = `<div class="onw-tw"><div class="onw-tscroll"><table class="onw-tbl"><thead><tr>
    <th>${escapeHtml(cuT('Product', '商品'))}</th>
    <th class="qt">${escapeHtml(cuT('Qty', '数量'))}</th>
    <th class="mo p">${escapeHtml(cuT('Price', '单价'))}</th>
    <th class="mo t">${escapeHtml(cuT('Line total', '小计'))}</th>
    <th class="rm"></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  ordNewRecalc();
  // Both fees move with the cart: packing is per item, and the subtotal decides
  // whether the zone's free-shipping threshold is met.
  ordNewFeesDebounced();
}

// ── Fulfilment drives the address block and the counter defaults ───────
// Delivery: six required fields. Pickup or counter: the block is ABSENT —
// hidden, out of layout and the accessibility tree (frame E). A counter
// sale opens on Paid · Cash: born fulfilled, not born closed.
// "Other" is the only origin that needs a follow-up question, so the note field
// exists only while it is selected — and is cleared on the way out so a switch
// away from Other can't leave a stale note attached to a real origin.
function ordNewChannelChange() {
  const sel  = document.getElementById('onw-channel');
  const wrap = document.getElementById('onw-channel-note-wrap');
  const note = document.getElementById('onw-channel-note');
  if (!sel || !wrap) return;
  const isOther = sel.value === 'other';
  wrap.hidden = !isOther;
  if (!isOther && note) note.value = '';
}

function ordNewFulChange() {
  const sel = document.getElementById('onw-ful');
  if (!sel || !ONW) return;
  const ft = sel.value;
  const addr = document.getElementById('onw-addr-blk');
  if (addr) addr.hidden = ft !== 'delivery';
  const st = document.getElementById('onw-status');
  const pay = document.getElementById('onw-pay');
  if (ft === 'counter') {
    if (st) st.value = 'paid';
    if (pay) pay.value = 'offline';
  } else if (ONW.ful === 'counter') {
    if (st) st.value = 'pending_payment';
    if (pay) pay.value = 'wechat';
  }
  ONW.ful = ft;
  // Delivery, collection and counter are three different fee answers — re-quote
  // rather than carrying the previous choice's numbers into this one. Shipping
  // specifically cannot survive the switch: nothing ships on a pickup or a
  // counter sale, and ordNewFees() only refills a field the operator has NOT
  // typed into — a shipping number keyed in while this was 'delivery' would
  // otherwise sit in the box, unrelated to the new fulfilment, until the
  // server refuses it. Un-typing it here lets the re-quote below give the
  // honest answer (0, same as the fee engine) instead of the leftover.
  if (ft !== 'delivery') {
    const ship = document.getElementById('onw-ship');
    if (ship) ship.value = '0';
    if (ONW.feeTouched) ONW.feeTouched.ship = false;
  }
  ordNewFees();
}

// ── Money — the summary is a running total, nothing else ───────────────
// Failing lines are excluded, so the page never pretends the order is
// priced. The grand-total override wins over subtotal plus shipping.
function ordNewSubtotal() {
  return Math.round(ONW.lines.reduce((s, l) => {
    const q = Number(l.qty) || 0;
    return q > 0 ? s + q * (Number(l.unit_price) || 0) : s;
  }, 0) * 100) / 100;
}
function ordNewRecalc() {
  if (!ONW) return;
  const sub = ordNewSubtotal();
  const ship = Number(document.getElementById('onw-ship')?.value) || 0;
  const pack = Number(document.getElementById('onw-pack')?.value) || 0;
  const ovrRaw = document.getElementById('onw-override')?.value;
  const total = (ovrRaw != null && ovrRaw !== '') ? (Number(ovrRaw) || 0) : Math.round((sub + ship + pack) * 100) / 100;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('onw-sum-items', onwMoney(sub));
  set('onw-sum-ship', onwMoney(ship));
  set('onw-sum-pack', onwMoney(pack));
  // A zero packing line is not news — a collection or a counter sale has nothing
  // to box. The row appears the moment there is a fee to explain.
  const packRow = document.getElementById('onw-sum-pack-row');
  if (packRow) packRow.hidden = !(pack > 0);
  set('onw-sum-total', onwMoney(total));
}

// ── The two fees, prefilled from the same engine the customer pays ─────────
// A manual order used to charge whatever the operator typed into Shipping
// (default 0) and never charged packing at all — it wasn't computed, wasn't
// posted, and wasn't a column in the INSERT. So a phone order for the same cart
// to the same address cost less than the app would have charged for it.
//
// TYPING IN A FIELD ENDS THE PREFILL FOR THAT FIELD, and only that field. The
// quote is an opening bid, not a rule: hand-keyed orders are where a waived fee
// or a negotiated rate legitimately happens, and a refill that overwrote the
// number an operator just typed — because they then corrected a postcode — would
// be the page arguing with them.
function ordNewFeeTyped(which) {
  if (ONW && ONW.feeTouched) ONW.feeTouched[which] = true;
  ordNewRecalc();
}

// Address edits re-quote: the zone, and therefore both fees, is a property of
// where this order is going.
function ordNewAddrChanged() { ordNewFeesDebounced(); }

// ── City → district cascade ────────────────────────────────────────────
// WHY THIS IS A CASCADE AND NOT TWO TEXT BOXES. The two fields it replaces were
// free text, and the create payload hardcoded `city: ''` on top of that — so no
// manual order has ever carried a city. Three things downstream read
// address_json.city and ONLY that: planShipments (routes/retail.js), which
// therefore could never see a Guangzhou order and dropped every manual parcel
// into the 'land' fall-through; printerForOrder, which routes an out-of-city
// order to the out-of-city printer; and the zone matcher, which compares
// match_city / match_district by EXACT EQUALITY against the catalogue values
// (retail_delivery_zones — see database.js). "广州" and "Guangzhou" are both
// wrong for all three. A select is what makes the stored value canonical by
// construction rather than by hoping.
//
// PROVINCE IS DERIVED, NEVER TYPED. Each catalogue city row carries its own
// province_cn, so picking 广州市 IS picking 广东省. A separate province field
// could only ever be a way for the two to disagree — and isGuangdong() reads
// the province, so a disagreement re-opens the bug from the other side.
//
// Options are labelled "广州市 · Guangzhou" — CN first, matching the admin's
// existing city catalogue datalist (06-delivery.js) rather than the wizard's
// fixed-enum selects. Native select type-ahead then answers to the Chinese a
// Guangzhou operator actually types. Both halves are always present, so the
// language toggle has nothing to swap and the selects carry data-no-i18n.

// Districts per city, fetched once each. GET /api/retail/districts is public
// and Cache-Control: public, max-age=3600 (routes/retail.js) — it reads the
// static china_districts reference file, touches no tenant DB and carries no
// customer scope, so the admin page may call it directly. Fetching per city
// rather than shipping the whole map: the file is ~140KB, which is not a thing
// to put on every admin page load for a field most orders never open.
const ONW_DISTRICT_CACHE = {};
async function ordNewLoadDistricts(cityCn) {
  if (!cityCn) return [];
  if (ONW_DISTRICT_CACHE[cityCn]) return ONW_DISTRICT_CACHE[cityCn];
  let list = [];
  try { list = (await api('/api/retail/districts?city=' + encodeURIComponent(cityCn)))?.data || []; }
  catch (e) { list = []; }   // offline / 500 → city-wide, same as a city with no districts
  ONW_DISTRICT_CACHE[cityCn] = list;
  return list;
}

// loadChinaRegions + _regions live in 06-delivery.js. All 17 parts share one
// global scope and this runs on operator interaction, long after every part has
// executed — but guard anyway, so a future split of the bundle degrades to an
// empty picker rather than a thrown handler.
async function ordNewLoadRegions() {
  if (typeof loadChinaRegions !== 'function') return { cities: [] };
  try { return await loadChinaRegions(); } catch (e) { return { cities: [] }; }
}

// The province the catalogue says this city belongs to. '' when the city isn't
// in the catalogue, which for a <select> means only "nothing picked yet".
function ordNewProvinceForCity(cityCn) {
  if (!cityCn || typeof _regions === 'undefined') return '';
  const row = _regions.byCn && _regions.byCn.get(cityCn);
  return (row && row.province_cn) || '';
}

// Say which province the picked city commits the order to. The operator never
// types it, so it has to be visible somewhere — a stored 广东省 they never saw
// is what routing decisions get made on.
function ordNewPaintProvince() {
  const el = document.getElementById('onw-addr-prov');
  if (!el) return;
  const city = (document.getElementById('onw-addr-city')?.value || '').trim();
  const prov = ordNewProvinceForCity(city);
  const row  = (typeof _regions !== 'undefined' && _regions.byCn) ? _regions.byCn.get(city) : null;
  if (!prov) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  // Glued EN·中文 label with a bilingual value after it, so this line reads the
  // same in either language and does not go stale when the toggle is flipped
  // after a city was picked (it is repainted only on a city change).
  el.textContent = 'Province · 省: ' + prov + (row && row.province_en ? ' · ' + row.province_en : '');
}

// ordNewRender fires a blank fill and ordNewRestore immediately fires another
// with the draft's city; both await the same catalogue fetch, so without a token
// the blank one can land last and wipe the restored pick.
let _ONW_CITY_FILL = 0;
async function ordNewFillCities(selectedCn) {
  const sel = document.getElementById('onw-addr-city');
  if (!sel) return;
  const mine = ++_ONW_CITY_FILL;
  const regions = await ordNewLoadRegions();
  if (mine !== _ONW_CITY_FILL) return;
  const cities = (regions.cities || []).slice()
    .sort((a, b) => String(a.name_cn || '').localeCompare(String(b.name_cn || ''), 'zh-Hans-CN'));
  sel.innerHTML = `<option value="">${escapeHtml(cuT('Select a city…', '请选择城市…'))}</option>`
    + cities.map(c => `<option value="${escapeAttr(c.name_cn)}">${escapeHtml(c.name_cn)}${c.name_en ? ' · ' + escapeHtml(c.name_en) : ''}</option>`).join('');
  if (selectedCn) sel.value = selectedCn;
  ordNewPaintProvince();
}

// Repopulate the district select for whichever city is picked. `selectedCn`
// re-selects a district when restoring a draft; a fresh pick passes nothing and
// lands on "City-wide".
//
// CITY-WIDE IS REFUSED FOR GUANGZHOU, deliberately. Everywhere else a blank
// district is honest — plenty of cities are one delivery area. In Guangzhou it
// is not: planShipments reads the district to tell an inner district (a
// same-city rider drop) from an outer ship-district (花都/番禺/南沙/从化/增城,
// which go out by courier on the batch cadence), and a blank district makes
// every Guangzhou order look inner. That would replace today's "everything is
// Land" with "every Panyu order is a rider job" — the same bug pointing the
// other way. So for 广州市 the empty option is dropped and validation demands a
// real district.
async function ordNewFillDistricts(cityCn, selectedCn) {
  const sel = document.getElementById('onw-addr-district');
  if (!sel) return;
  if (!cityCn) {
    sel.innerHTML = `<option value="">${escapeHtml(cuT('Pick a city first', '请先选择城市'))}</option>`;
    return;
  }
  sel.innerHTML = `<option value="">${escapeHtml(cuT('Loading…', '加载中…'))}</option>`;
  const dists = await ordNewLoadDistricts(cityCn);
  // The city may have changed again while this was in flight.
  const live = (document.getElementById('onw-addr-city')?.value || '').trim();
  if (live !== cityCn) return;
  const head = ordNewDistrictRequired(cityCn)
    ? `<option value="">${escapeHtml(cuT('Select a district…', '请选择区/县…'))}</option>`
    : `<option value="">${escapeHtml(cuT('City-wide · no district', '全城 · 不分区'))}</option>`;
  sel.innerHTML = head
    + dists.map(d => `<option value="${escapeAttr(d.name_cn)}">${escapeHtml(d.name_cn)}${d.name_en ? ' · ' + escapeHtml(d.name_en) : ''}</option>`).join('');
  if (selectedCn) sel.value = selectedCn;
}

// Guangzhou is the one city whose district changes how the parcel ships, not
// just what it costs. Keyed off the catalogue city name, which is the only form
// the select can produce.
function ordNewDistrictRequired(cityCn) {
  return String(cityCn || '').trim() === '广州市';
}

async function ordNewCityChanged() {
  const city = (document.getElementById('onw-addr-city')?.value || '').trim();
  ordNewPaintProvince();
  await ordNewFillDistricts(city, '');
  ordNewAddrChanged();
}

let onwFeeTimer = null;
function ordNewFeesDebounced() {
  clearTimeout(onwFeeTimer);
  onwFeeTimer = setTimeout(ordNewFees, 300);
}

// Ask the server what this order's zone charges, and fill in whichever of the
// two fields the operator hasn't taken over. Read-only endpoint — safe to call
// on every debounced change.
let _ONW_FEE_REQ = 0;
async function ordNewFees() {
  if (!ONW || !_ORD_NEW_OPEN) return;
  const val = id => (document.getElementById(id)?.value || '').trim();
  const ft = val('onw-ful') || 'delivery';
  const body = {
    fulfillment_type: ft,
    items: ONW.lines.filter(l => Number(l.qty) > 0)
      .map(l => ({ product_id: l.product_id, qty: Number(l.qty), unit_price: Number(l.unit_price) })),
  };
  if (ft === 'delivery') {
    // Identical shape to ordNewCollect's — the cart a fee is quoted for must be
    // quoted against the SAME destination the order is then created with, or the
    // summary the operator approved is not the order they made.
    body.address = ordNewAddress();
    // Nothing to match a zone against yet — leave the fields alone rather than
    // zeroing them, which would look like an answer.
    if (!body.address.city && !body.address.district && !body.address.address) return;
  }
  const mine = ++_ONW_FEE_REQ;
  let j;
  // Object body, not a string — api() sets Content-Type only when it does the
  // stringifying itself, and express.json() ignores a body without it.
  try { j = await api('/api/retail-admin/order-fees', { method: 'POST', body }); }
  catch { return; }                      // a failed quote leaves the typed numbers standing
  if (mine !== _ONW_FEE_REQ || !ONW || !_ORD_NEW_OPEN) return;   // a newer quote owns the fields
  const d = j.data || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
  // 🔴 An unmatched zone is NOT a quote of zero. The customer checkout refuses
  // such an address outright; staff must still be able to take the order, so the
  // fields keep whatever is in them and the caption says why.
  if (!d.error) {
    if (!ONW.feeTouched.ship) set('onw-ship', Number(d.shipping_fee || 0));
    if (!ONW.feeTouched.pack) set('onw-pack', Number(d.packing_fee || 0));
  }
  ordNewPaintFeeNote(ft, d);
  ordNewRecalc();
}

// One line under the two fields saying where the numbers came from — a fee that
// appears with no explanation is a fee the operator can't defend to a customer.
function ordNewPaintFeeNote(ft, d) {
  const el = document.getElementById('onw-fee-note');
  if (!el) return;
  let txt;
  if (d && d.error === 'no_zone_match') {
    txt = cuT('No delivery zone matches this address — type both fees yourself, then set the zone up under Delivery.',
              '没有匹配这个地址的配送区 — 请手动填写两项费用,并在“配送”中配置该区域。');
  } else if (d && d.error) {
    txt = cuT('Fees could not be worked out for this order — type them yourself.',
              '无法自动计算本单费用 — 请手动填写。');
  } else if (ft === 'pickup') {
    txt = cuT('Packing fills in from the store-pickup fee; there is no delivery to charge. Edit either to override.',
              '包装费按自提包装费填入,自提无运费。可直接修改。');
  } else if (ft === 'counter') {
    txt = cuT('A counter sale has nothing to ship or box. Edit either fee if this one does.',
              '前台销售无需配送或打包。如有需要可自行填写。');
  } else {
    const zone = d && d.zone ? cuT(d.zone.name_en || d.zone.name_cn || '', d.zone.name_cn || d.zone.name_en || '') : '';
    txt = zone
      ? cuT(`Shipping and packing fill in from ${zone}; edit either to override.`,
            `运费与包装费按「${zone}」配送区填入,可直接修改。`)
      : cuT("Shipping and packing fill in from this order's delivery zone; edit either to override.",
            '运费与包装费按本单配送区自动填入,可直接修改。');
  }
  el.textContent = txt;
}

// Dynamic regions bake one language — re-paint them when it changes.
if (window.onLangChange) onLangChange(() => {
  if (!_ORD_NEW_OPEN || !ONW) return;
  ordNewPaintCustState();
  ordNewPaintPhoneNote();
  ordNewRenderLines();
});

// ═══ Drafts — their own chip, their own row shape ══════════════════════
// A draft is not an order. It lives in its own table, so it is absent from the
// order list, from every KPI tile and from the status line by construction —
// none of them can reach retail_order_drafts. This chip SWAPS what is on
// screen; it carries no data-status, so setOrderStatus can never select it and
// no order query is ever asked for status='drafts'.
let ORD_DRAFTS = [];
function ordDraftsOpen() {
  const v = document.getElementById('ord-drafts-view');
  return !!(v && !v.hidden);
}
function ordShowDrafts() {
  const view = document.getElementById('ord-drafts-view');
  const card = document.querySelector('#tab-orders .list-card');
  const cust = document.getElementById('orders-cust-chip');
  if (!view) return;
  if (card) card.style.display = 'none';
  if (cust) cust.style.display = 'none';
  view.hidden = false;
  $$('#orders-status-chips .status-chip')
    .forEach(el => el.classList.toggle('active', el.id === 'ord-chip-drafts'));
  ordLoadDrafts();
}
// Any status chip returns to the list. Called from setOrderStatus, so there is
// one way back and it is the one the operator already knows.
function ordHideDrafts() {
  const view = document.getElementById('ord-drafts-view');
  const card = document.querySelector('#tab-orders .list-card');
  const cust = document.getElementById('orders-cust-chip');
  if (view) view.hidden = true;
  if (card) card.style.display = '';
  if (cust) cust.style.display = '';
}
async function ordLoadDrafts() {
  const view = document.getElementById('ord-drafts-view');
  if (!view) return;
  try {
    const j = await api('/api/retail-admin/order-drafts');
    ORD_DRAFTS = j.data || [];
    ordSetDraftCount(j.total != null ? j.total : ORD_DRAFTS.length);
  } catch (e) {
    // A section with bad data SAYS it failed — absence must mean empty, never
    // broken (§1.12).
    view.innerHTML = `<div class="odr-empty"><h3>${escapeHtml(cuT('Drafts did not load', '草稿未能加载'))}</h3>
      <p>${escapeHtml(cuT('The list could not be read just now. Try again in a moment.', '暂时无法读取列表,请稍后再试。'))}</p></div>`;
    return;
  }
  ordRenderDrafts();
}
// The chip's count. Refreshed with the order counts, so the number is right
// before the operator clicks rather than after.
function ordSetDraftCount(n) {
  const el = document.getElementById('oc-drafts');
  if (el) el.textContent = n > 0 ? String(n) : '';
}
async function ordRefreshDraftCount() {
  try {
    const j = await api('/api/retail-admin/order-drafts');
    ordSetDraftCount(j.total != null ? j.total : (j.data || []).length);
  } catch (e) { /* the chip simply stays as it was */ }
}
// The best label available, in order: customer name, else guest name, else the
// first product and how many more, else "Empty draft". The server sends a KIND
// and the raw names; the sentences are built here, in one language.
function ordDraftLabel(p) {
  if (!p) return { text: cuT('Empty draft', '空草稿'), none: true };
  if (p.kind === 'customer' || p.kind === 'guest') return { text: p.label || '', none: false };
  if (p.kind === 'products') {
    const nm = cuT(p.label || p.label_cn || '', p.label_cn || p.label || '');
    const more = p.extra > 0 ? cuT(` +${p.extra} more`, ` +${p.extra} 项`) : '';
    return { text: nm + more, none: false };
  }
  return { text: cuT('Empty draft', '空草稿'), none: true };
}
function ordRenderDrafts() {
  const view = document.getElementById('ord-drafts-view');
  if (!view) return;
  if (!ORD_DRAFTS.length) {
    // Normal, not a failure: no drafts is what a tidy Monday looks like.
    view.innerHTML = `<div class="odr-empty">
      <h3>${escapeHtml(cuT('No drafts', '没有草稿'))}</h3>
      <p>${escapeHtml(cuT('Drafts are yours alone. A half-typed order waits here until you come back for it.', '草稿仅你可见。未填完的订单会留在这里,等你回来继续。'))}</p>
    </div>`;
    return;
  }
  view.innerHTML = '<div class="odr-card">' + ORD_DRAFTS.map(d => {
    const lab = ordDraftLabel(d.preview);
    const when = courierAgo(d.updated_at || d.created_at);
    const total = (d.preview && d.preview.total) || 0;
    return `<div class="odr-row">
      <button type="button" class="odr-open" onclick="ordOpenDraft(${d.id})">
        <span class="odr-t${lab.none ? ' odr-none' : ''}">${escapeHtml(lab.text)}</span>
        <span class="odr-m">${escapeHtml(cuT('Saved', '保存于') + ' ' + when)}</span>
      </button>
      <span class="odr-v">${escapeHtml(ordMoney(total))}</span>
      <button type="button" class="odr-x" onclick="ordDeleteDraft(event, ${d.id})" title="${escapeHtml(cuT('Delete draft', '删除草稿'))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
      </button>
    </div>`;
  }).join('') + '</div>';
}
function ordMoney(n) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-' : '') + acWrap(s[0].replace(/\B(?=(\d{3})+$)/g, ',') + '.' + s[1]);
}
// Open restores everything — the header is identical and the commit is still
// "Create order", because a draft becomes an order the same way any other
// typing does.
async function ordOpenDraft(id) {
  try {
    const j = await api('/api/retail-admin/order-drafts/' + id);
    ordNewOpen(j.data || null);
  } catch (e) {
    const view = document.getElementById('ord-drafts-view');
    if (view) ordLoadDrafts();
  }
}
async function ordDeleteDraft(ev, id) {
  if (ev) ev.stopPropagation();
  const btn = ev && ev.currentTarget;   // captured before the await
  if (btn) btn.disabled = true;
  try {
    await fetch('/api/retail-admin/order-drafts/' + id, { method: 'DELETE', credentials: 'same-origin' });
  } catch (e) { /* the reload below tells the truth either way */ }
  await ordLoadDrafts();
}

// ── Inline errors (§1.12, frame G) ─────────────────────────────────────
// The message renders next to the control that failed and PERSISTS until the
// next attempt clears it. Never a toast — a toast confirms, and a failure the
// operator can miss is not an error state. Every slot is cleared before a
// write, so a fixed field's message never outlives the fix.
const ONW_ERR_SLOTS = ['cust', 'route', 'prod', 'money', 'addr'];
// Server error code → the block whose control produced it. An unmapped code
// lands on 'prod' only if it names a product; otherwise it goes to the top of
// the form rather than nowhere — an error with no home is an error the
// operator never sees.
const ONW_ERR_WHERE = {
  recipient_name_required: 'cust', bad_phone: 'cust', bad_customer_id: 'cust',
  customer_not_found: 'cust', name_or_phone_required: 'cust', bad_email: 'cust',
  forbidden_capability: 'cust',
  no_items: 'prod', invalid_item: 'prod', product_unavailable: 'prod', bad_unit_price: 'prod',
  bad_shipping_fee: 'money', bad_packing_fee: 'money', bad_total: 'money',
  bad_channel: 'route', channel_required: 'route', channel_note_required: 'route',
  bad_store_id: 'route', store_not_found: 'route',
  store_required_for_counter: 'route',
  bad_fulfillment_type: 'route', fulfillment_type_required: 'route',
  payment_method_required_for_counter: 'route',
  pos_closed_for_store: 'route',
  address_required_for_delivery: 'addr',
  address_not_allowed_for_pickup: 'addr', address_not_allowed_for_counter: 'addr',
  shipping_fee_not_allowed_for_pickup: 'money', shipping_fee_not_allowed_for_counter: 'money',
};
function ordNewClearErrors() {
  ONW_ERR_SLOTS.forEach(k => {
    const el = document.getElementById('onw-err-' + k);
    if (!el) return;
    el.hidden = true; el.innerHTML = '';
    const blk = el.closest('.onw-blk');
    if (blk) blk.classList.remove('onw-bad');
  });
}
function ordNewShowError(where, message) {
  const el = document.getElementById('onw-err-' + (ONW_ERR_SLOTS.includes(where) ? where : 'cust'));
  if (!el) return;
  el.innerHTML = onwIc(ONW_ICONS.warn, 2) + '<span>' + escapeHtml(message) + '</span>';
  el.hidden = false;
  const blk = el.closest('.onw-blk');
  if (blk) blk.classList.add('onw-bad');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
// One sentence per code: what happened, and what to do about it.
function ordNewErrText(code, detail) {
  const M = {
    recipient_name_required: cuT('Enter a name for the order.', '请填写订单姓名。'),
    bad_phone: cuT('That phone number is not a valid number.', '电话号码格式不正确。'),
    customer_not_found: cuT('That customer no longer exists. Search again.', '该顾客已不存在,请重新搜索。'),
    bad_customer_id: cuT('That customer record could not be read. Search again.', '无法读取该顾客档案,请重新搜索。'),
    name_or_phone_required: cuT('Saving a customer needs a name or a phone number.', '存为顾客需要姓名或电话。'),
    bad_email: cuT('That email address is not valid.', '邮箱地址不正确。'),
    forbidden_capability: cuT('Your account cannot create customers. Clear "Also save as a customer" to place the order.', '您的账户无权新建顾客。取消"同时存为顾客"即可下单。'),
    no_items: cuT('Add at least one product.', '请至少添加一个商品。'),
    invalid_item: cuT('Every line needs a quantity of 1 or more.', '每行数量需为 1 或以上。'),
    product_unavailable: cuT('One product is no longer on sale. Remove that line.', '有商品已下架,请移除该行。'),
    bad_unit_price: cuT('A line price is not a valid amount.', '某行单价金额不正确。'),
    bad_shipping_fee: cuT('Shipping is not a valid amount.', '运费金额不正确。'),
    bad_packing_fee: cuT('Packing is not a valid amount.', '包装费金额不正确。'),
    bad_total: cuT('The total override is not a valid amount.', '自定义总额金额不正确。'),
    bad_channel: cuT('Pick a channel this order can be created on.', '请选择可下单的渠道。'),
    channel_required: cuT('Say where this order came from.', '请选择订单来源。'),
    channel_note_required: cuT('Write where this order came from.', '请填写具体来源。'),
    bad_store_id: cuT('Pick a store.', '请选择门店。'),
    store_not_found: cuT('That store no longer exists. Pick another.', '该门店已不存在,请另选。'),
    // The server refuses a walk-in with no location: the goods left a shelf, and
    // which shelf is not optional (retail.js, beside the address rule). Only
    // reachable when the store list came back empty — the picker preselects the
    // first store otherwise — so the sentence names that, rather than telling the
    // operator to pick from a list with nothing in it.
    store_required_for_counter: cuT('A counter sale needs a store — it is the till it was rung up at. No store is set up yet.',
                                    '前台销售必须选择门店(即收银所在门店)。目前还没有设置门店。'),
    fulfillment_type_required: cuT('Pick how this order is fulfilled.', '请选择履约方式。'),
    bad_fulfillment_type: cuT('Pick how this order is fulfilled.', '请选择履约方式。'),
    // A counter sale must name the wallet that took the money, or the sale
    // reconciles against nothing (retail.js, beside the counter store rule).
    // THE MESSAGE IS THE FIELD'S OWN LABEL, verbatim, and that is deliberate:
    // the locked-vocabulary rule forbids composing Chinese, and no locked
    // SENTENCE exists for this. '付款方式' is the exact pair the field
    // carries (retail-admin.html), so naming the field is the most this may
    // say without inventing. It renders in the same 'route' slot the field
    // sits in, so the pairing reads. Replace with a full sentence the moment
    // one is locked.
    payment_method_required_for_counter: cuT('Pay method', '付款方式'),
    // POS was closed at this store on the Sales page, so the counter is shut
    // and the server refuses the sale (retail.js posClosedForStore).
    //
    // THE MESSAGE IS THE GRID'S OWN STATE LABEL, verbatim, for the same reason
    // the line above uses a field label: the locked-vocabulary rule forbids
    // composing Chinese, and no locked SENTENCE exists for "the counter is
    // closed here". 'Closed · 已关闭' is the exact pair the Sales grid prints
    // on a closed channel × location cell (01-core.js:647), so an operator who
    // just closed it there reads the same two words back. Replace with a full
    // sentence the moment one is locked.
    pos_closed_for_store: cuT('Closed', '已关闭'),
    address_required_for_delivery: cuT('A delivery order needs a full address.', '配送订单需要完整地址。'),
    address_not_allowed_for_pickup: cuT('A pickup order cannot carry a delivery address.', '自提订单不能填写收货地址。'),
    address_not_allowed_for_counter: cuT('A counter sale cannot carry a delivery address.', '前台销售不能填写收货地址。'),
    // Nothing ships on a pickup or a counter sale, so a leftover shipping number
    // (typed while this was a delivery, then carried across the fulfilment
    // switch) is refused rather than stored (retail.js, beside the address rule).
    shipping_fee_not_allowed_for_pickup: cuT('A pickup order cannot carry a shipping fee. Clear it or set it to 0.', '自提订单不能收取运费,请清空或设为 0。'),
    shipping_fee_not_allowed_for_counter: cuT('A counter sale cannot carry a shipping fee. Clear it or set it to 0.', '前台销售不能收取运费,请清空或设为 0。'),
    // Client-only — the server has no such rule. A Guangzhou order's district is
    // what decides rider vs courier, so "city-wide" is not an answer here.
    district_required_for_gz: cuT('Pick the Guangzhou district — it decides whether this goes by rider or by courier.',
                                  '请选择广州的区 — 该选择决定走同城骑手还是快递。'),
  };
  return M[code] || (detail || cuT('That did not save. Nothing was created.', '未能保存,未创建任何内容。'));
}

// ── Gather the form ────────────────────────────────────────────────────
// fulfillment_type is ALWAYS sent — the server requires it as of 2026-07-31,
// and this page is the reason the guess could be deleted. Address travels only
// on a delivery; on pickup or counter the block is not on screen and the
// server rejects an address outright.
function ordNewCollect() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const ft = val('onw-ful') || 'delivery';
  const body = {
    customer_id: ONW.customer ? ONW.customer.id : null,
    recipient_name: ONW.cust === 'linked' ? (ONW.customer.nickname || val('onw-guest-name')) : val('onw-guest-name'),
    recipient_phone: ONW.cust === 'linked' ? (ONW.customer.phone || '') : val('onw-guest-phone'),
    items: ONW.lines.map(l => ({ product_id: l.product_id, qty: Number(l.qty), unit_price: Number(l.unit_price) })),
    shipping_fee: Number(val('onw-ship')) || 0,
    packing_fee: Number(val('onw-pack')) || 0,
    status: val('onw-status') || 'pending_payment',
    payment_method: val('onw-pay') || 'offline',
    // No `|| 'manual'` fallback. An empty select means the operator hasn't
    // answered yet, and ordNewValidate blocks the submit before we get here —
    // sending a silent default would put the question back where it started.
    channel: val('onw-channel'),
    channel_note: val('onw-channel') === 'other' ? (val('onw-channel-note') || null) : null,
    fulfillment_type: ft,
    customer_note: val('onw-note-cust') || null,
    staff_note: val('onw-note-staff') || null,
  };
  const store = val('onw-store');
  if (store) body.store_id = Number(store);
  const ovr = val('onw-override');
  if (ovr !== '') body.total_override = Number(ovr);
  // The customer is created by the ORDER endpoint, inside the order's own
  // transaction — never as a separate POST first. A failure between the two
  // used to leave a customer nobody asked for, already carrying migration
  // credit and signup vouchers.
  if (ONW.cust === 'guest' && ONW.saveCust) body.save_customer = true;
  if (ft === 'delivery') {
    body.address = ordNewAddress();
    body.recipient_name = val('onw-addr-name') || body.recipient_name;
    body.recipient_phone = val('onw-addr-phone') || body.recipient_phone;
  }
  return body;
}

// The address snapshot, built in ONE place because two callers send it — the
// create POST and the fee quote — and they used to carry two copies of the same
// literal. When that literal was wrong (`city: ''`) it was wrong in both, and a
// fix applied to one would have quoted a fee for a destination the order did not
// have. Province is read off the picked city rather than a field of its own, so
// the pair cannot drift; detail is not collected by this form.
function ordNewAddress() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const city = val('onw-addr-city');
  return {
    province: ordNewProvinceForCity(city),
    city,
    district: val('onw-addr-district'),
    address: val('onw-addr-street'),
    detail: '',
    postal_code: val('onw-addr-postal'),
  };
}
// Client-side checks, inline in the same slots the server's answers use, so a
// local failure and a remote one read identically.
function ordNewValidate(body) {
  if (!body.recipient_name) return ['cust', ordNewErrText('recipient_name_required')];
  // Origin, before anything else about the order's shape. The server enforces
  // the same rule (channel_required / channel_note_required); this is the copy
  // that puts the message next to the box the operator has to fix.
  if (!body.channel) return ['route', ordNewErrText('channel_required')];
  if (body.channel === 'other' && !body.channel_note) {
    return ['route', ordNewErrText('channel_note_required')];
  }
  if (!body.items.length) return ['prod', ordNewErrText('no_items')];
  if (body.items.some(i => !(i.qty > 0))) return ['prod', ordNewErrText('invalid_item')];
  if (body.fulfillment_type === 'delivery') {
    const a = body.address || {};
    // CITY IS THE ONE THAT MATTERS MOST and was the one not checked — the server
    // only insists on a non-empty address_full (any single line satisfies it), so
    // until now nothing anywhere refused an order with no city. Province is
    // derived from the city, so requiring it is really a second assertion that
    // the picked city was a catalogue city.
    //
    // 🔴 POSTAL CODE IS NOT REQUIRED, AND MUST NOT BE PUT BACK. It was a dead
    // rule: no customer app collects one (there is no postal_code in the
    // mini-app's EMPTY_FORM, miniapp/pages/addresses/addresses.js), every one of
    // the saved addresses on file has it empty, the server stores it as
    // optional, and matchDeliveryZone never reads it. Requiring it would reject
    // every order prefilled from a customer's own saved address — an address
    // good enough for the customer to check out with, refused when staff key it.
    if (!(a.city && a.province && a.address)) {
      return ['addr', ordNewErrText('address_required_for_delivery')];
    }
    // District is optional for a city that delivers city-wide, and REQUIRED for
    // Guangzhou, where it decides whether the parcel goes out on a same-city
    // rider or a courier waybill — see ordNewFillDistricts.
    if (ordNewDistrictRequired(a.city) && !a.district) {
      return ['addr', ordNewErrText('district_required_for_gz')];
    }
  }
  return null;
}

// ── Restoring a draft ──────────────────────────────────────────────────
// Puts back everything the operator had typed: the customer state, the lines,
// every select and every field, including the ones the fulfilment choice hides.
// Runs after ordNewRender()'s reset, and remembers which draft this is so Save
// draft updates it instead of leaving a second copy behind.
function ordNewRestore(draft) {
  const p = draft && draft.payload;
  if (!p || typeof p !== 'object') return;
  const f = (p.form && typeof p.form === 'object') ? p.form : {};
  ONW.draftId = draft.id != null ? draft.id : null;
  ONW.lines = Array.isArray(p.lines) ? p.lines : [];
  ONW.cust = p.cust || 'rest';
  ONW.customer = p.customer || null;
  ONW.saveCust = p.saveCust !== false;

  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  set('onw-channel', f.channel);
  set('onw-channel-note', f.channel_note);
  ordNewChannelChange();   // re-reveal the note field if the draft was an "Other"
  set('onw-store', f.store_id != null ? String(f.store_id) : null);
  set('onw-ful', f.fulfillment_type);
  set('onw-status', f.status);
  set('onw-pay', f.payment_method);
  set('onw-ship', f.shipping_fee != null ? String(f.shipping_fee) : '0');
  set('onw-pack', f.packing_fee != null ? String(f.packing_fee) : '0');
  // A draft's fees are what the operator decided last time, quote or override.
  // Re-quoting over them would silently undo a waiver they saved on purpose.
  ONW.feeTouched = { ship: true, pack: true };
  set('onw-override', f.total_override != null ? String(f.total_override) : '');
  set('onw-note-cust', f.customer_note || '');
  set('onw-note-staff', f.staff_note || '');
  if (ONW.cust === 'guest') {
    set('onw-guest-name', f.recipient_name || '');
    set('onw-guest-phone', f.recipient_phone || '');
  }
  const a = (f.address && typeof f.address === 'object') ? f.address : {};
  set('onw-addr-name', f.recipient_name || '');
  set('onw-addr-phone', f.recipient_phone || '');
  set('onw-addr-street', a.address || '');
  set('onw-addr-postal', a.postal_code || '');
  // The two selects can only hold a value once their options exist, and the
  // district list depends on the city — so restore them in order, asynchronously,
  // rather than through `set` alongside the plain inputs. Province is NOT
  // restored: it is re-derived from the city, so a draft saved before this change
  // (province typed by hand, no city) comes back with an empty city and an empty
  // province rather than a province the picker can no longer justify. That is the
  // honest outcome — the draft genuinely never held a usable destination.
  ordNewFillCities(a.city || '')
    .then(() => ordNewFillDistricts(a.city || '', a.district || ''))
    .catch(() => { /* leaves the picker empty; the operator re-picks */ });

  // ordNewFulChange reads the select and would treat a restored counter sale as
  // a fresh switch INTO counter, overwriting the status and pay method the
  // operator saved. Tell it the state it is already in first.
  ONW.ful = f.fulfillment_type || 'delivery';
  ordNewFulChange();
  set('onw-status', f.status);
  set('onw-pay', f.payment_method);

  ordNewPaintCustState();
  ordNewRenderLines();
}

// ── The two exits ──────────────────────────────────────────────────────
// Both disable while the write is in flight and then KEEP their name: Saved,
// Created (§1.12's in-flight rule — the control that writes says so).
let _ORD_NEW_BUSY = false;
function ordNewSetBusy(btn, on, label) {
  _ORD_NEW_BUSY = on;
  document.querySelectorAll('#tab-orders-new .onw-acts .onw-btn')
    .forEach(b => { b.disabled = on; });
  if (btn && label != null) btn.textContent = label;
}
async function ordNewCreate(ev) {
  // Captured synchronously, before any await: event.currentTarget is null once
  // dispatch ends, and this handler awaits (§1.12, failure shape C).
  const btn = (ev && ev.currentTarget) || document.getElementById('onw-create');
  if (_ORD_NEW_BUSY) return;
  ordNewClearErrors();
  const body = ordNewCollect();
  const bad = ordNewValidate(body);
  if (bad) { ordNewShowError(bad[0], bad[1]); return; }
  ordNewSetBusy(btn, true, cuT('Creating…', '创建中…'));
  try {
    const r = await fetch('/api/retail-admin/orders', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      const code = j.error || 'unknown';
      ordNewSetBusy(btn, false, cuT('Create order', '创建订单'));
      ordNewShowError(ONW_ERR_WHERE[code] || 'cust', ordNewErrText(code, j.message));
      return;
    }
    btn.textContent = cuT('Created', '已创建');
    const d = j.data || {};
    // The draft became an order, so it stops being a draft. Best-effort: the
    // order is already real, and a draft that outlives it is a duplicate the
    // operator can delete, not a reason to report the create as failed.
    if (ONW.draftId != null) {
      const draftId = ONW.draftId;
      ONW.draftId = null;
      fetch('/api/retail-admin/order-drafts/' + draftId, { method: 'DELETE', credentials: 'same-origin' })
        .catch(() => { /* leaves one stale draft, never a lost order */ });
    }
    // Land the operator back on the list with the new order open — that is where
    // the pay link, the receipt and every next action live.
    setTimeout(() => {
      _ordNewTeardown(false);
      goTab('orders');
      if (typeof loadOrders === 'function') loadOrders();
      if (typeof refreshOrderChannelCounts === 'function') refreshOrderChannelCounts();
      if (d.id != null && typeof openOrder === 'function') setTimeout(() => openOrder(d.id), 80);
    }, 650);
  } catch (e) {
    ordNewSetBusy(btn, false, cuT('Create order', '创建订单'));
    ordNewShowError('cust', cuT('That did not reach the server. Nothing was created.', '请求未送达服务器,未创建任何内容。'));
  }
}
// Save draft — the payload is the form as it stands, valid or not. A draft is
// an unfinished order by definition, so nothing is validated here.
async function ordNewSaveDraft(ev) {
  const btn = (ev && ev.currentTarget) || document.getElementById('onw-draft');
  if (_ORD_NEW_BUSY) return;
  ordNewClearErrors();
  ordNewSetBusy(btn, true, cuT('Saving…', '保存中…'));
  // `lines` carries the product NAMES as well as the ids. The form body sends
  // only product_id/qty/unit_price, which is all the order endpoint needs — but
  // a draft row has to be able to say "Osmanthus oolong +2 more" without
  // re-resolving every product, so the names travel with the draft.
  const payload = {
    form: ordNewCollect(), lines: ONW.lines,
    cust: ONW.cust, customer: ONW.customer, saveCust: ONW.saveCust,
  };
  try {
    const url = '/api/retail-admin/order-drafts' + (ONW.draftId ? '/' + ONW.draftId : '');
    const r = await fetch(url, {
      method: ONW.draftId ? 'PATCH' : 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      ordNewSetBusy(btn, false, cuT('Save draft', '存为草稿'));
      ordNewShowError('cust', cuT('The draft did not save.', '草稿未能保存。'));
      return;
    }
    if (j.data && j.data.id != null) ONW.draftId = j.data.id;
    ordNewSetBusy(btn, false, cuT('Saved', '已保存'));
  } catch (e) {
    ordNewSetBusy(btn, false, cuT('Save draft', '存为草稿'));
    ordNewShowError('cust', cuT('The draft did not reach the server.', '草稿未送达服务器。'));
  }
}

// Products are managed entirely from the main /products page on the
// kitchen admin — name, price, description, image, and the new
// "Show in mini-app shop" toggle all live there. No duplicate retail
// price or description; one source of truth.

