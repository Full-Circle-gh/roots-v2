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
// Channel facet — orthogonal to status. Filters the combined list by origin
// (mini app / web / Meituan); '' = all channels.
function setOrderChannel(chip) {
  const value = chip.dataset.channel || '';
  const hid = document.getElementById('orders-channel');
  if (hid) hid.value = value;
  $$('#orders-channel-chips .status-chip').forEach(el => el.classList.toggle('active', el === chip));
  loadOrders();
}
// Which non-storefront channels are shown read-only in the combined list — the
// storefront doesn't fulfil/print them, so no drawer, NEW mark, or chime. For
// now just Meituan (mirrored in to deduct stock); gzgrocery joins in phase 2.
function ordIsReadonlyChannel(o) {
  const c = String(o.channel || '').toLowerCase();
  return c === 'meituan' || c === 'gzgrocery';
}
// Short display for the list glance. Channel/legacy numbers look like
// PREFIX + [sep] + yyyymmdd + sequence (e.g. MT20260706256422, GZ-138616).
// The date is dead weight — the row already carries a time column — so
// collapse anything over 6 digits to prefix + last 6 (MT·256422). A hyphen
// separator (GZ-138616) is normalised to a middot so the column doesn't
// line-break at the dash. Full number still shows in the drawer and on hover.
function ordShortNo(no) {
  const s = String(no || '');
  const m = s.match(/^([A-Za-z]+)[-·\s]?(\d+)$/);
  if (!m) return s;
  const prefix = m[1], digits = m[2];
  if (digits.length > 6) return prefix + '·' + digits.slice(-6);
  // Short enough already — but swap a wrapping hyphen for the middot.
  return s.includes('-') ? prefix + '·' + digits : s;
}
function ordChannelLabel(o) {
  const c = String(o.channel || 'wechat').toLowerCase();
  if (c === 'meituan')   return 'Meituan';
  if (c === 'gzgrocery') return 'Gzgrocery';
  if (c === 'web')       return 'Web';
  if (c === 'manual')    return cuT('Manual', '手动');
  return 'Mini app';
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
  '配送中':     { en: 'Delivering',       tone: 'dispatched' },
  '派送中':     { en: 'Delivering',       tone: 'dispatched' },
  '已送达':     { en: 'Delivered',        tone: 'delivered' },
  '用户已收货': { en: 'Delivered',        tone: 'delivered' },
  '已收货':     { en: 'Delivered',        tone: 'delivered' },
  '已签收':     { en: 'Delivered',        tone: 'delivered' },
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
function channelStatusMeta(desc) {
  const d = String(desc || '').trim();
  if (!d) return null;
  if (MT_STATUS[d]) return { en: MT_STATUS[d].en, cn: d, tone: MT_STATUS[d].tone };
  // Keyword fallback for labels not in the table — colour sensibly AND give a
  // generic English word by tone, so the English view never leaks raw Chinese.
  // The Chinese view still shows the exact platform label.
  let tone = 'paid', en = 'In progress';
  if (/退款|退货/.test(d))                { tone = 'refunded';        en = 'Refund'; }
  else if (/取消/.test(d))                { tone = 'cancelled';       en = 'Cancelled'; }
  else if (/完成|送达|签收|收货/.test(d)) { tone = 'delivered';       en = 'Delivered'; }
  else if (/配送|派送|骑手|取货/.test(d))   { tone = 'dispatched';      en = 'Delivering'; }
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
    const amt = paid ? ` ¥${fmt(paid)}` : '';
    return `<span class="pill refund-partial" title="Partial refund · 部分退款${amt}">↩ part refund${amt} · 部分退款</span>`;
  }
  const labels = {
    pending:   'refund req · 申请退款',
    reviewing: 'reviewing · 处理中',
    approved:  'approved · 已批准',
  };
  const label = labels[rs] || rs;
  return `<span class="pill refund-pending" title="Open refund · 退款进行中 (${rs})">↩ ${label}</span>`;
}

// Fapiao badge — rides the status cell on every row that carries an invoice
// request (the retired Invoices tab's queue is now the "Needs invoice" chip),
// so an owed fapiao is visible from any filter without opening the drawer.
// Issued requests go quiet: done work isn't a badge.
function invoiceBadge(o) {
  if (!Number(o.needs_invoice)) return '';
  if (o.invoice_status === 'issued') return '';
  return `<span class="pill st-awaiting_restock" title="${cuT('Invoice requested — issue it from the order drawer', '顾客申请开票 — 请在订单详情中开票')}">`
    + `<span class="dot"></span>${cuT('needs invoice · 待开票', '待开票 · invoice')}</span>`;
}

// Full-width summary line under a row in the "Needs invoice" view — the 抬头 /
// 税号 / status the accountant batches into the tax system, plus the same
// "Copy for accounting" the drawer block has, so the whole queue clears
// without opening a single drawer. Shares .order-row so click/Enter still
// opens the drawer (the copy button stops its own propagation via the
// delegated handler's interactive-child bail).
function invoiceSubRow(o) {
  if (!Number(o.needs_invoice)) return '';
  const issued = o.invoice_status === 'issued';
  const company = String(o.invoice_type || '').toLowerCase() === 'company';
  const typeTag = company
    ? `<span class="pill st-paid" style="font-size:11px;"><span class="dot"></span>${cuT('Company · 企业', '企业 · Company')}</span>`
    : `<span class="pill st-refunded" style="font-size:11px;"><span class="dot"></span>${cuT('Personal · 个人', '个人 · Personal')}</span>`;
  const stateTag = issued
    ? `<span class="pill st-delivered" style="font-size:11px;"><span class="dot"></span>${cuT('Issued · 已开', '已开 · Issued')}</span>`
    : `<span class="pill st-awaiting_restock" style="font-size:11px;"><span class="dot"></span>${cuT('To issue · 待开', '待开 · To issue')}</span>`;
  return `
      <tr class="order-row ord-inv-subrow${issued ? ' is-issued' : ''}" data-order-id="${o.id}">
        <td colspan="10" style="padding: 4px 12px 10px; border-top: none;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:12px; color:var(--text-2);">
            ${typeTag}
            <b style="color:var(--text-1);">${escapeHtml(o.invoice_title || '—')}</b>
            ${company && o.invoice_tax_id ? `<span style="font-variant-numeric:tabular-nums;">${escapeHtml(o.invoice_tax_id)}</span>` : ''}
            ${o.invoice_email ? `<span>${escapeHtml(o.invoice_email)}</span>` : ''}
            ${stateTag}
            ${issued && o.invoice_number ? `<span style="font-variant-numeric:tabular-nums;">${escapeHtml(o.invoice_number)}</span>` : ''}
            <button type="button" class="db-btn" style="margin-left:auto; font-size:11px; padding:3px 10px;"
              data-copy="${escapeAttr(invoiceAccountingText(o))}"
              onclick="event.stopPropagation(); copyKicker(this, 'Invoice info · 开票信息')">${cuT('Copy for accounting · 复制开票信息', '复制开票信息')}</button>
          </div>
        </td>
      </tr>`;
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
  if (d.amount != null) facts.push(`<li><span class="k">${cuT('Amount', '金额')}</span><span class="v amt${v === 'mismatch' ? ' bad' : ''}">¥${Number(d.amount).toFixed(2)}</span></li>`);
  if (d.payee) facts.push(`<li><span class="k">${cuT('Paid to', '收款方')}</span><span class="v" data-no-i18n>${escapeHtml(d.payee)}</span></li>`);
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
          <span><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7l8.7 5 8.7-5"/><path d="M12 22V12"/></svg>Suggested: split into 2 packages · 拆分为 2 个包裹</span>
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
    const channel  = (document.getElementById('orders-channel') || {}).value || '';
    const q        = $('#orders-q').value.trim();
    const storeSel = document.getElementById('orders-store');
    const storeId  = storeSel ? storeSel.value : '';

    // Refund queue chip is just a filter — keep the standard columns so
    // staff see the orders alongside their normal context (ship-by,
    // tracking, total). The backend treats `status=refunds_open` as the
    // pseudo-filter `refund_status IN ('pending','reviewing','approved')`.

    const qs = new URLSearchParams();
    if (status)  qs.set('status', status);
    if (channel) qs.set('channel', channel);
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
    refreshOrderChannelCounts();

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
        ? `<h3>Nothing waiting. Enjoy it. · 无待处理退款</h3>`
        : (status === 'needs_invoice')
        ? `<h3>No invoices owed · 无待开发票</h3>
           <p class="muted">Orders show up here when a customer asks for an invoice. · 顾客申请开票的订单会显示在这里。</p>`
        : `<h3>No orders yet · 暂无订单</h3>
           <p class="muted">New orders settle in here from every channel. · 新订单会从各渠道汇聚到这里。</p>`;
      tbody.innerHTML = `<tr><td colspan="10">
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

    tbody.innerHTML = j.data.map(o => {
      // No flash / no NEW mark for unpaid orders — nothing to act on yet.
      const fresh = (isActionable(o) && prevSeen && !prevSeen.has(o.id)) ? ' is-fresh' : '';
      // Unread until any operator opens the detail (server seen_at). Stays
      // bold + lit across reloads/devices, unlike the transient arrival flash.
      const isUnread = !o.seen_at && isActionable(o);
      const unread = isUnread ? ' is-unread' : '';
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
        <td>${isUnread ? '<span class="new-chip">NEW · 新</span>' : ''}<span class="ord-no" title="${escapeHtml(o.order_no || '')}">${escapeHtml(ordShortNo(o.order_no))}</span></td>
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
        <td class="numeric oc-total">¥${fmt(o.total)}</td>
        <td class="status-cell"><div class="stack"><span class="pill st-${o.status}"><span class="dot"></span>${humanStatus(o.status, o.fulfillment_type)}</span>${refundBadge(o)}${invoiceBadge(o)}${addonBadge(o)}</div></td>
        <td class="oc-delivery">${renderDeliveryCell(o)}</td>
        <td class="muted" style="font-size: 11px">${formatDate(o.placed_at)}</td>
      </tr>${status === 'needs_invoice' ? invoiceSubRow(o) : ''}`;
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
function slotEndAnchor(scheduledForIso, label) {
  const start = parseSchedFor(scheduledForIso);
  if (isNaN(start.getTime())) return scheduledForIso;
  const g = gzParts(start);
  const lbl = String(label == null ? '' : label);
  const m = /(\d{1,2}):(\d{2})\s*(?:[-–—~]|to|至)\s*(\d{1,2}):(\d{2})/.exec(lbl);
  if (m) {
    const endH = Number(m[3]), endM = Number(m[4]);
    if (endH <= 23 && endM <= 59) {
      const end = gzWall(g.y, g.mo, g.da, endH, endM);
      if (end.getTime() >= start.getTime()) return end.toISOString(); // window END is the real deadline
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
      if (end.getTime() >= start.getTime()) return end.toISOString(); // window END is the real deadline
    }
  }
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
// lib/feie.js shipByPrintLine() — keep the two in sync). Rule: the MOST
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
  // 1 — Pickup: show the counter window, never a ship deadline.
  if (o.fulfillment_type === 'pickup') {
    const label = localizeSlotLabel(humanizeSlotLabel(absolutizeSlotLabel(o.delivery_slot_label, o.scheduled_for)))
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
        kickerEn: done ? reqEn : 'Deliver', kickerCn: done ? reqCn : '送达时间',
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
      // Kicker is "Requested", not "Ship by" — Right-away is what the CUSTOMER
      // asked for (as-soon-as-possible), not an operator dispatch deadline.
      // "Ship by → Right away" read as a contradiction; "Requested → Right away"
      // is what the customer actually chose.
      return {
        kind: 'asap',
        kickerEn: done ? reqEn : 'Requested', kickerCn: done ? reqCn : '客户要求',
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
  const label = localizeSlotLabel(humanizeSlotLabel(absolutizeSlotLabel(o.delivery_slot_label, o.scheduled_for)))
    || (valid ? fmtSlotShort(dt) : String(o.scheduled_for));
  // If the human label isn't itself the date, surface the date as a sub-line.
  const dateLine = valid ? fmtSlotShort(dt) : '';
  return {
    kind: 'scheduled',
    kickerEn: done ? reqEn : 'Deliver', kickerCn: done ? reqCn : '送达时间',
    headlineRaw: label,
    cellSubRaw: (label !== dateLine && dateLine) ? dateLine : null,
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
  if (!p.urgencyDate || !p.urgencyBasis) {
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
    ? ` <span style="font-size: 10px; color: var(--warn);">+¥${fmt(o.same_day_surcharge_fee)} ${cuT('same-day','当日')}</span>` : '';
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
function fmtSlotShort(dt) {
  const pad = n => String(n).padStart(2, '0');
  // Read the instant in Guangzhou wall-clock (UTC+8), not the browser's — an
  // operator abroad must still see the day the customer actually chose.
  const g = gzParts(dt);
  // Midnight (00:00) is never a real delivery time — it's how a DATE-ONLY pick
  // (schedule-for-later day / day-only zone) lands when parsed. Drop the fake
  // time tail so it reads "Jun 18" / "6月18日", not "Jun 18 · 00:00".
  const dateOnly = (g.h === 0 && g.mi === 0);
  // In Chinese mode show "6月25日 · 14:30" instead of "Jun 25 · 14:30".
  if (typeof window !== 'undefined' && window.cuLang && window.cuLang() === 'cn') {
    return `${g.mo + 1}月${g.da}日${dateOnly ? '' : ` · ${pad(g.h)}:${pad(g.mi)}`}`;
  }
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][g.mo];
  return `${M} ${pad(g.da)}${dateOnly ? '' : ` · ${pad(g.h)}:${pad(g.mi)}`}`;
}
// Date only — "Jun 17" / "6月17日". A ship-by DEADLINE is a day, not a minute,
// so we drop the time tail that fmtSlotShort carries. GZ wall-clock (UTC+8).
function fmtDateShort(dt) {
  const g = gzParts(dt);
  if (typeof window !== 'undefined' && window.cuLang && window.cuLang() === 'cn') {
    return `${g.mo + 1}月${g.da}日`;
  }
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][g.mo];
  return `${M} ${String(g.da).padStart(2, '0')}`;
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
      <div style="font-weight:800; white-space:nowrap; color:var(--text-1);">+¥${Number(a.amount || 0).toFixed(2)}</div>
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
// Full-size "Ship by" tile shown in the order-detail card grid. Same decision
// (shipByPlan) and urgency scheme as the list cell, with more context: the
// kicker, a verbose urgency badge, the made-fresh / no-slot sub-line, and the
// delivery mode + same-day surcharge note.
function renderShipByTile(o) {
  const actionable = (o.status === 'paid' || o.status === 'preparing');
  const p = shipByPlan(o);
  const u = shipByUrgency(p, actionable);
  const usingRaw = (p.headlineRaw != null && p.headlineRaw !== '');
  const headline = usingRaw ? escapeHtml(p.headlineRaw) : cuT(p.headlineEn, p.headlineCn);
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
    ? `${mode ? ' · ' : ''}<span style="color: var(--warn);">+¥${fmt(o.same_day_surcharge_fee)} ${cuT('same-day surcharge','当日加收')}</span>` : '';
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
    <div class="kicker">${cuT(p.kickerEn, p.kickerCn)}</div>
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
  // the platform's delivery ETA while the order is still in flight; once it's
  // done (or never carried an ETA) there's nothing we own to show — a bare dash,
  // not a second "view only" (the Channel column already carries that tag).
  if (typeof ordIsReadonlyChannel === 'function' && ordIsReadonlyChannel(o)) {
    if (o.channel_eta && !['delivered', 'cancelled', 'refunded'].includes(o.status)) {
      return renderTrackingCell(o);
    }
    return '<span class="muted">—</span>';
  }
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
  const label = c.stage === 'in_transit'       ? cuT('En route', '配送中')
              : c.stage === 'awaiting_dispatch' ? cuT('Finding rider', '正在找骑手')
              : '';
  if (!label) return '';
  const mins = (c.stage === 'in_transit' && c.eta_seconds != null)
    ? `~${Math.max(1, Math.round(c.eta_seconds / 60))}${cuT('m', '分')}` : '';
  const dist = (c.stage === 'in_transit' && c.rider_to_cust_m != null)
    ? (c.rider_to_cust_m >= 1000 ? (c.rider_to_cust_m / 1000).toFixed(1) + 'km' : Math.round(c.rider_to_cust_m) + 'm') : '';
  const sub = [mins, dist].filter(Boolean).join(' · ');
  return `<div style="display:flex; align-items:center; gap:3px; font-size:11px; font-weight:600; color:#B4533E;">${deliveryIcon('scooter', 12)}<span>${label}</span></div>`
       + (sub ? `<div class="muted" style="font-size:10px; margin-top:2px;">${sub}</div>` : '');
}

function renderTrackingCell(o) {
  if (o.fulfillment_type === 'pickup') {
    return `<span class="muted" style="font-size:11px;">${pickupIcon(11)} ${cuT('pickup','自提')}</span>`;
  }
  // Read-only channels (Meituan): Meituan owns the rider, so we have no waybill —
  // show the platform's delivery ETA instead, and never the "missing waybill"
  // warning below (which doesn't apply). Hide once the order is done/void.
  if (typeof ordIsReadonlyChannel === 'function' && ordIsReadonlyChannel(o)) {
    // Live Qingyun rider stage (Wave A): Meituan's delivery IS a Qingyun rider we
    // now track, so prefer the real stage + ETA over the platform's static ETA.
    const live = renderCourierListLine(o);
    if (live) return live;
    if (o.channel_eta && !['delivered', 'cancelled', 'refunded'].includes(o.status)) {
      return `<div style="display:flex; align-items:center; gap:3px; font-size:11px; font-weight:600; color:#5C7A4E;">${deliveryIcon('scooter', 12)}<span>${escapeHtml(formatEtaClock(o.channel_eta))}</span></div>
              <div class="muted" style="font-size:10px; margin-top:2px;">${cuT('arrival','预计送达')}</div>`;
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

// Clock-only (HH:MM, store-local) for a UTC datetime — used for the Meituan
// delivery ETA. Reuses formatDate's UTC→Asia/Shanghai handling.
function formatEtaClock(iso) {
  const s = formatDate(iso);
  return s ? s.slice(11) : '';
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
  const rowCls = `mf-row${itemFullyRefunded(it) ? ' refunded-row' : ''}`;
  return `
    <div class="${rowCls}" data-fk="${it.id}">
      <span class="mf-num">${num}</span>
      ${itemThumb(it)}
      <div class="mf-body">
        <div class="mf-top">
          ${nameCell}
          <span class="mf-total">¥${fmt(it.line_total)}</span>
        </div>
        <div class="mf-meta" data-no-i18n>
          ${itemSkuHtml(it)}
          ${itemQtyHtml(it)}
          <span class="item-unit">@ ¥${fmt(it.unit_price)}</span>
          ${refundPill ? `<span class="mf-packs">${refundPill}</span>` : ''}
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
           <span class="mode-pill"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7l8.7 5 8.7-5"/><path d="M12 22V12"/></svg>Not yet in a parcel · 待分配</span>
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
    const _href = productHref(it.product_id);
    const nameCell = _href
      ? `<a href="${_href}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${nm}</a>`
      : nm;
    const zh = it.size ? `<div class="oi-zh">${escapeHtml(it.size)}</div>` : '';
    const refundPill = itemRefundHtml(it);
    return `<div class="oi-row${itemFullyRefunded(it) ? ' refunded-row' : ''}" data-fk="${it.id}">
      <div style="min-width:0; display:flex; align-items:center; gap:var(--s3);">
        ${itemThumb(it)}
        <div style="min-width:0">${nameCell}${zh}<div style="margin-top:4px">${itemSkuHtml(it)}</div>${itemOptionsHtml(it)}${renderBundleInside(it)}</div>
      </div>
      <span class="oi-c">${itemQtyHtml(it)}</span>
      <span class="oi-r">¥${fmt(it.unit_price)}</span>
      <span class="oi-total">¥${fmt(it.line_total)}</span>
      <span class="oi-packs">${refundPill}${showPack ? renderPackBadges(it) : ''}</span>
    </div>`;
  }).join('');
  return `<div class="oi-grid">${head}${rows}</div>`;
}

// Items layout · CARDS — each line a bordered card, total emphasised.
function renderItemsAsCards(items, showPack = true) {
  const cards = items.map(it => {
    const nn = orderItemNames(it);
    const nm = `<span class="oic-name">${escapeHtml(nn.primary)}</span>`;
    const _href = productHref(it.product_id);
    const nameCell = _href
      ? `<a href="${_href}" target="_blank" rel="noopener" class="prod-link" title="Open product in new tab · 在新标签页打开商品">${nm}</a>`
      : nm;
    const zh = it.size ? `<div class="oic-zh">${escapeHtml(it.size)}</div>` : '';
    const refundPill = itemRefundHtml(it);
    return `<div class="oic${itemFullyRefunded(it) ? ' refunded-row' : ''}" data-fk="${it.id}">
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
        ${refundPill ? `<span class="oic-packs">${refundPill}</span>` : ''}
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
  // Per-shipment dispatch is offered once the order is paid (or later) and this
  // parcel hasn't shipped. The order being 'dispatched' doesn't block it — a
  // partially-shipped order keeps un-shipped parcels actionable.
  // A supplier parcel is never "dispatched" from our warehouse — it ships from
  // the supplier and is marked shipped by entering its tracking number instead.
  const canDispatch = state === 'pending' &&
    mode !== 'supplier' &&
    ['paid', 'preparing', 'dispatched'].includes(o.status) &&
    o.fulfillment_type !== 'pickup';
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
        ${shipmentStatePill(s)}
      </div>
      ${renderItemsTable(s.items, false)}
      ${actions}
      ${mode === 'local'
        ? (!['dispatched', 'delivered'].includes(s.state || 'pending') && ['paid', 'preparing'].includes(o.status) ? renderLocalEtaCard(o, s) : '')
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
function hoistedTracking(o) {
  const all = o.shipments || [];
  const multi = all.length > 1;
  const cards = all.map((s, i) => {
    const mode = s.mode || 'local';
    // Supplier parcels render their own tracking card inline (always visible,
    // even before "dispatch"), so they're never hoisted here.
    if (mode === 'supplier') return '';
    if (!['dispatched', 'delivered'].includes(s.state || 'pending')) return '';
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
      <div class="muted" style="font-size:11px; margin-top:6px;">${cuT(
        'Rider (set an arrival time) or JD logistics (attach a waybill).',
        '骑手(设置送达时间)或京东物流(填写运单号)。')}</div>
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
  return `
    <div style="${wrapStyle}" id="eta-card-${sid}">
      ${renderGzMethodToggle(o, s)}
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-3); margin-bottom: var(--s2);">Delivery time · 送达时间</div>
      ${isAuto ? `
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:10px 12px; background: var(--bg-elev-1); border-radius:6px; margin-bottom:10px;">
          <div>
            <div style="font-size:12px; color:var(--text-3);">Estimated arrival · 预计送达</div>
            <div style="font-family: var(--f-mono); font-weight:600; font-size:15px;">${escapeHtml(pretty)}</div>
          </div>
          <div style="flex:1; min-width:120px; text-align:right;">
            <span class="muted" style="font-size:11px;">From the courier · 来自骑手,自动</span>
          </div>
        </div>
        <details style="margin-bottom:4px;">
          <summary style="font-size:12px; cursor:pointer; color:var(--text-3);">Set a time manually · 手动设置时间</summary>
          <div style="margin-top:8px;">${picker}</div>
        </details>`
      : `${picker}${eta ? `<div class="muted" style="font-size:11px; margin-top:8px;">Shown to the customer · 已展示给顾客</div>` : ''}`}
      ${renderQyDispatch(o)}
    </div>`;
}

// ── Same-city courier (Qingyun) live status ────────────────────────────────
// The Qingyun daemon writes the real rider stage into delivery_jobs every ~25s;
// the server hands it to the drawer as o.courier. Three reliable stages — the
// finer "assigned vs physically picked up" step isn't in the data, so we don't
// pretend to it. These mirror what the customer already sees in the mini-app.
const COURIER_STAGE = {
  awaiting_dispatch: { en: 'Finding a rider', cn: '正在找骑手', dot: '#9A6E2A' },
  in_transit:        { en: 'On the way',      cn: '配送中',     dot: '#5C7A4E' },
  delivered:         { en: 'Delivered',       cn: '已送达',     dot: '#5C7A4E' },
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
  if (o.status === 'dispatched' && c) {
    if (c.stage === 'awaiting_dispatch') return { cls: 'st-preparing',  label: cuT('Finding a rider', '正在找骑手') };
    if (c.stage === 'in_transit')        return { cls: 'st-dispatched', label: cuT('On the way', '配送中') };
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
  if (c.stage === 'in_transit' && !stale && !delivered && c.eta_seconds != null)
    bits.push(cuT(`~${Math.max(1, Math.round(c.eta_seconds / 60))} min away`, `约 ${Math.max(1, Math.round(c.eta_seconds / 60))} 分钟`));
  if (c.stage === 'in_transit' && !stale && !delivered && c.rider_to_cust_m != null)
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
  const showMap = c.stage === 'in_transit' && !stale && !delivered;
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
  el.innerHTML = '';                                      // clear the "Loading…" placeholder

  const state = { orderId: o.id, map: null, timer: null, rider: null, shop: null, cust: null, line: null, fitted: false };
  _courierMap = state;
  const map = new AMap.Map(el, { zoom: 15, resizeEnable: true, jogEnable: false });
  state.map = map;

  const setMarker = (cur, pos, opts, label, z) => {
    if (!pos) return cur;
    const lnglat = [pos.lng, pos.lat];
    if (cur) { cur.setPosition(lnglat); return cur; }
    const mk = new AMap.Marker({ position: lnglat, content: _courierMarkerHtml(label, opts), anchor: 'center', zIndex: z });
    mk.setMap(map);
    return mk;
  };
  const apply = (d) => {
    if (!d || !d.tracking) return;
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
        const only = d.rider_position || d.recipient_position || d.shop_position;
        if (only) { map.setZoomAndCenter(15, [only.lng, only.lat]); state.fitted = true; }
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
  // A live "on the way" order whose row has frozen (>10 min) is a likely cancel/
  // drop — warn on the card and reopen the dispatch button so staff can re-book.
  const stale = !delivered && !!(c && c.stage === 'in_transit' && courierAgeMs(c.updated_at) > COURIER_STALE_MS);
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
      ${compareBtn}
      <div id="qy-carriers-${o.id}" style="margin-top:8px;"></div>
    </div>`;
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
        <span class="qy-fee">¥${c.feeYuan}</span>
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
  if (!confirm(confirmMsg)) return;
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
        : `${escapeHtml(done[0]?.name || '')} ¥${done[0]?.fee_yuan ?? ''}`;
      if (box) box.innerHTML = `<div style="font-size:12px;color:var(--brand)">✓ ${cuT('Dispatched', '已发单')}: ${names}</div>`;
      loadOrders();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = cuT('Dispatch courier', '发起配送'); }
      if (j.insufficient_balance) toast(cuT('Qingyun balance too low — top up first', '青云余额不足,请先充值'), 'err');
      else toast(cuT('Dispatch failed', '发起配送失败'), 'err');
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
    ? `<div class="row" style="gap:8px; margin-top:10px;"><button class="btn btn-sm" onclick="markParcelDelivered(${o.id}, ${s.id})">${cuT('Mark this parcel delivered', '标记此包裹已送达')}</button></div>`
    : '';
  return `<div style="margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line-soft);">${instr}${renderShipmentTrackingCard(o, s, true)}${deliverBtn}</div>`;
}

// Operator confirms a supplier parcel arrived (used when the carrier can't
// live-track it). When it makes every parcel delivered, the server flips the
// whole order to delivered.
async function markParcelDelivered(id, sid) {
  const ok = await askConfirm({
    titleEn: 'Mark parcel delivered?', titleCn: '标记包裹已送达?',
    bodyEn: 'Confirm the supplier parcel reached the customer. If it was the last parcel, the order is marked delivered.',
    bodyCn: '确认此供应商包裹已送达顾客。若为最后一个包裹,订单将标记为已送达。',
    confirmEn: 'Mark delivered', confirmCn: '标记已送达',
    cancelEn: 'Cancel', cancelCn: '取消',
  });
  if (!ok) return;
  try {
    await api(`/api/retail-admin/orders/${id}/shipments/${sid}/deliver`, { method: 'POST', body: {} });
    toast('Parcel delivered · 包裹已送达');
    openOrder(id, { instant: true });
    loadOrders();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
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
      const foot = $('#order-drawer-foot');
      if (foot) foot.innerHTML = '';  // drop the previous order's print footer while loading
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
    // Live rider map — mounts only when the drawer rendered a courier-map
    // container (an on-the-way same-city order). Self-tears-down any prior map.
    try { mountCourierMap(o); } catch (e) { /* map is best-effort */ }
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
  // .td-attn-row / .td-attn-go = the "Needs you" attention-card rows + their
  // action button (Delivery needs a call, Refunds waiting, Invoices to issue),
  // which likewise open the order drawer on click.
  if (e.target.closest('tr.order-row, tr.cu-row, .db-feed-row, .td-attn-row, .td-attn-go, .rm-ocard, .rm-cucard, .rm-sheet')) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.toString().length > 0) return;
  closeDrawer(open[open.length - 1]);
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
  e.preventDefault();
  const id = row.dataset.orderId;
  if (id) openOrder(Number(id));
});

// ── Order detail · per-operator View tweaks ───────────────────────────
// Order-detail layout defaults (the per-operator "Tweaks" popover was removed
// in the Tacet port; these fixed defaults now drive the one clean layout):
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
// Money breakdown under the order total: subtotal · shipping · (packing) · (voucher).
// Packing fee only renders when one was actually charged (zero on most delivery
// orders), mirroring how the voucher segment is conditional.
function orderTotalSubline(o) {
  let s = `${cuT('subtotal','小计')} ¥${fmt(o.subtotal)} · ${cuT('shipping','运费')} ¥${fmt(o.shipping_fee)}`;
  if (Number(o.packing_fee) > 0) s += ` · ${cuT('packing','打包费')} ¥${fmt(o.packing_fee)}`;
  if (o.voucher_amount)          s += ` · ${cuT('voucher','优惠券')} −¥${fmt(o.voucher_amount)}`;
  return s;
}
function renderOrderTotalBanner(o) {
  return `
    <div class="order-total-banner">
      <div>
        <div class="otb-label">Order total · 订单总额</div>
        <div class="otb-sub">${orderTotalSubline(o)}</div>
      </div>
      <div class="otb-amount">¥${fmt(o.total)}</div>
    </div>`;
}
function renderOrderTotalInline(o) {
  return `
    <div class="od-total-inline">
      <div class="kicker">Order total · 订单总额</div>
      <div class="od-total-big">¥${fmt(o.total)}</div>
      <div class="od-total-sub">${orderTotalSubline(o)}</div>
    </div>`;
}
function renderOrderTotalFooter(o, transitionsHtml) {
  return `
    <div class="order-total-banner otb-footer">
      <div>
        <div class="otb-label">Order total · 订单总额</div>
        <div class="otb-sub">${orderTotalSubline(o)}</div>
      </div>
      <div class="otb-amount">¥${fmt(o.total)}</div>
      ${transitionsHtml ? `<div class="otb-actions">${transitionsHtml}</div>` : ''}
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
  // Same-city courier (Qingyun) live tracking. Meituan's own delivery is fulfilled
  // by a Qingyun rider, so once the daemon links this mirrored order to its waybill
  // (via the platform order number) we show the SAME live rider card + AMap map our
  // own orders use — the point of running a Meituan order from here. Read-only: no
  // dispatch/compare button (that's the write-back wave), just watch the rider. The
  // map element mounts via mountCourierMap(o) in the shared open-order flow.
  const c = o.courier;
  const cDelivered = !!(c && c.stage === 'delivered');
  const cMeta = c && (cDelivered ? COURIER_STAGE.delivered : COURIER_STAGE[c.stage]);
  const cStale = !cDelivered && !!(c && c.stage === 'in_transit' && courierAgeMs(c.updated_at) > COURIER_STALE_MS);
  const courierCard = cMeta ? renderCourierStatusCard(o, c, cMeta, cStale, cDelivered) : '';
  mount.innerHTML = `
    <div class="order-card odd-${ODV.density}">
      <div class="order-head">
        <div class="od-head-main">
          <div class="title-row">
            <b>${escapeHtml(o.order_no)}</b>
            <span class="pill st-${o.status}"><span class="dot"></span>${humanStatus(o.status, o.fulfillment_type)}</span>
            <span class="pill" style="background: var(--bg-elev-1); color: var(--text-2);" title="${escapeHtml(chan)} orders are mirrored in for visibility — fulfil them in ${escapeHtml(chan)}">${escapeHtml(chan)} · ${cuT('view only', '只读')}</span>
          </div>
          <div class="od-eyebrow">Order placed ${formatDate(o.placed_at)} · 下单于 ${formatDate(o.placed_at)}</div>
        </div>
      </div>

      ${courierCard}

      <div class="order-detail">
        ${o.store_code ? `<div>
          <div class="kicker">Store · 门店</div>
          <div class="val"><b>${escapeHtml(o.store_name_en || o.store_code)}</b></div>
        </div>` : ''}
        ${(() => { const meta = channelStatusMeta(o.channel_status); return meta ? `<div>
          <div class="kicker">${escapeHtml(chan)} status · 平台状态</div>
          <div class="val" data-no-i18n><b>${escapeHtml((typeof cuT === 'function') ? cuT(meta.en, meta.cn) : meta.en)}</b></div>
        </div>` : ''; })()}
        ${o.channel_eta ? `<div>
          <div class="kicker">ETA · 预计送达</div>
          <div class="val"><b>${escapeHtml(formatEtaClock(o.channel_eta))}</b></div>
          <div class="sub">${formatDate(o.channel_eta)}</div>
        </div>` : ''}
        ${hasCust ? `<div>
          <div class="kicker">Customer · 顾客</div>
          <div class="val" data-no-i18n><b>${escapeHtml(cust.name)}</b></div>
          ${cust.phone ? `<div class="sub" data-no-i18n>${escapeHtml(cust.phone)}</div>` : ''}
        </div>` : ''}
        <div>
          <div class="kicker">Total · 合计</div>
          <div class="val"><b>¥${fmt(o.total)}</b></div>
          <div class="sub">${cuT(`${items.length} line${items.length === 1 ? '' : 's'}`, `${items.length} 项`)}</div>
        </div>
      </div>

      <div>
        <div class="kicker" style="margin: 14px 0 6px;">Items · 商品</div>
        <div class="manifest">
          ${items.length
            ? items.map((it, i) => renderReadonlyItemRow(it, i)).join('')
            : `<div class="muted" style="padding: 8px 0;">${cuT('No line items captured', '未记录商品明细')}</div>`}
        </div>
      </div>
    </div>`;
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
  const transitions = allTx.filter(([next]) => next !== 'cancelled' && next !== 'refunded')
    .map(([next, label]) => {
      // With multiple parcels the whole-order dispatch acts as "ship all at
      // once" — relabel so it's distinct from each parcel's own button.
      if (next === 'dispatched' && multiParcel && o.fulfillment_type !== 'pickup') {
        label = 'Mark all dispatched · 全部标记已发货';
      }
      // Tacet: forward actions read as calm bordered buttons (not a second Dusk
      // CTA) — the mockup keeps the drawer quiet; the one Dusk button is "New order".
      return `<button class="btn btn-sm" onclick="transition(${o.id}, '${next}')">${label}</button>`;
    }).join('')
    // A quiet "Undo" sits beside the forward actions when the order was
    // dispatched/delivered but nothing has truly gone out — the reverse for a
    // misclick. Label tracks which step is being undone.
    + (undoDispatchable(o)
        ? `<button class="btn btn-sm" onclick="undoDispatch(${o.id})">${o.status === 'delivered' ? 'Undo delivery · 撤销送达' : 'Undo dispatch · 撤销发货'}</button>`
        : '')
    + (undoPreparable(o)
        ? `<button class="btn btn-sm" onclick="undoPreparing(${o.id})">Undo preparing · 撤销备货</button>`
        : '')
    + renderRefundMenu(o, dangerTx);
    mount.innerHTML = `
      <div class="order-card odd-${ODV.density}">
        ${_ORDER_BACK_CUSTOMER ? `<button class="btn btn-sm order-back-cust" style="margin-bottom: var(--s3);" onclick="cuBackToCustomer()">← Back to customer · 返回顾客</button>` : ''}
        <div class="order-head">
          <div class="od-eyebrow">Order placed ${formatDate(o.placed_at)} · 下单于 ${formatDate(o.placed_at)}</div>
          <div class="title-row">
            <b>${escapeHtml(o.order_no)}</b>
            ${(() => { const p = orderStatusPill(o); return `<span class="pill ${p.cls}"><span class="dot"></span>${p.label}</span>`; })()}
            ${o.fulfillment?.rollup === 'partial' ? `<span class="pill st-preparing"><span class="dot"></span>Partially shipped · 部分发货 (${o.fulfillment.dispatched}/${o.fulfillment.total})</span>` : ''}
            ${(o.addons && o.addons.length) ? `<span class="pill st-paid" title="${escapeHtml((o.addons || []).flatMap(a => (a.items || []).map(it => `${it.name_en || it.name_cn} ×${it.qty}`)).join(', '))}"><span class="dot"></span>+ Items added · 加单 (+¥${Number(o.addon_total || 0).toFixed(2)})</span>` : ''}
            ${refundBadge(o)}
          </div>
          <!-- Eyebrow → order no + status → actions on their OWN row below (calm,
               per Tacet). Forward actions are bordered; Refund/Cancel is a menu. -->
          ${transitions ? `<div class="transitions od-head-tx">${transitions}</div>` : ''}
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
            ${renderShipByTile(o)}
            ${o.store_code ? `<div>
              <div class="kicker">Fulfilled by · 出货门店</div>
              <div class="val"><b>${escapeHtml(o.store_name_en || o.store_code)}</b></div>
              <div class="sub">${escapeHtml(o.store_name_cn || '')}${routingNote(o.routing_reason) ? ' · ' + routingNote(o.routing_reason) : ''}${(o.channel && o.channel.toLowerCase() !== 'wechat') ? ' · ' + escapeHtml(o.channel) : ''}</div>
              ${o.routed_by_distance === 0 ? `<div class="sub" style="color: var(--warn); font-weight: 600;">⚠ ${cuT('routed by area — address not locatable, verify store','按区域派单 · 地址无法定位,请核对门店')}</div>` : ''}
            </div>` : ''}
          </div>
          ${fulfillmentShortStrip(o)}
          ${renderAlipayProof(o)}
          ${ODV.totalPlacement === 'inline' ? renderOrderTotalInline(o) : ''}
          ${o.customer_note ? `<div class="full"><div class="kicker">Customer note · 顾客备注</div><div style="font-weight: 700; color: var(--text-1); font-size: 14px; line-height: 1.5;">${escapeHtml(o.customer_note)}</div></div>` : ''}
          ${o.needs_cutlery ? `<div class="full"><span style="display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--text-1); background: var(--bg-elev-2); border: 1px solid var(--line); border-radius: 99px; padding: 4px 12px; font-size: 12px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 3v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3"/><path d="M6 11v10"/><path d="M17 3c-1.7 0-3 2-3 5s1.3 4 3 4"/><path d="M17 3v18"/></svg> Cutlery requested · 需要餐具</span></div>` : ''}
          ${o.needs_invoice ? renderInvoiceBlock(o) : ''}
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

        ${ODV.totalPlacement === 'footer' ? renderOrderTotalFooter(o) : ''}
      </div>`;
  // Print controls live in a footer pinned to the bottom of the drawer (outside
  // the scroll area) so a reprint is always one click, never buried mid-scroll.
  const foot = $('#order-drawer-foot');
  if (foot) foot.innerHTML = orderDrawerFoot(o);
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

// Branded replacement for window.prompt() when collecting one optional reason
// (cancellation / refund). Resolves to the typed string, or null if the staff
// member dismisses (ESC / backdrop / Cancel) so callers can abort. Submitting
// an empty textarea resolves to '' (reason is optional).
function askReason(opts) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'pu-editor-bg tacet';
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
    bg.className = 'pu-editor-bg tacet';
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

// Print controls for the order drawer, rendered into the footer pinned at the
// bottom of the drawer (#order-drawer-foot) rather than mid-scroll — so a
// reprint is always one click, never hunted for in the items list. Returns ''
// for orders that can't have a receipt (unpaid / cancelled / refunded); the
// empty footer then collapses via `#order-drawer .drawer-foot:empty`.
// Print receipt is the workhorse. Box label rides along only when Settings ·
// Delivery turns it on (delivery.boxLabel → body.ord-box-label gates
// .ord-boxlabel-ui). A FAILED auto-print is the one status still surfaced, and
// a quiet "Prints at <store>" hint tells the operator which counter it goes to.
// The per-MACHINE toggles (auto-print JD waybill, box-label-auto) live in
// Settings · Delivery — they were never order-specific.
function orderDrawerFoot(o) {
  if (['pending_payment', 'cancelled', 'refunded'].includes(o.status)) return '';
  const failed = o.print_status === 'failed'
    ? `<span class="pill danger" title="${escapeAttr(o.print_error || '')}"><span class="dot"></span>Print failed · 打印失败</span>` : '';
  const hint = o.store_code
    ? `<span class="od-foot-hint">${cuT('Prints at ' + escapeHtml(o.store_name_en || o.store_code), '打印于 ' + escapeHtml(o.store_name_cn || o.store_code))}</span>`
    : '';
  return `
    <button class="btn btn-sm" id="reprint-${o.id}" onclick="reprintOrder(${o.id})"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>${cuT('Print receipt','打印小票')}</button>
    <button class="btn btn-sm ord-boxlabel-ui" id="boxlabel-${o.id}" onclick="printBoxLabel(${o.id})" title="${escapeAttr(cuT('Sticker for the parcel: order no, name, phone', '箱贴:订单号、姓名、电话'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>${cuT('Box label', '打印箱贴')}</button>
    <span class="od-foot-spacer"></span>
    ${failed}
    ${hint}`;
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
    const msg = e.code === 'already_shipped'
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

// Reverse an accidental "Mark preparing" — one step earlier than undoDispatch.
// The status machine is forward-only, so a too-early paid → preparing left the
// operator with no way back. Rolls preparing → paid. Server only allows it while
// still preparing with no waybill attached (returns 'already_shipped' otherwise).
// Silent: the customer is not notified, matching a quick correction.
async function undoPreparing(id) {
  const ok = await askConfirm({
    titleEn: 'Undo preparing?', titleCn: '撤销备货?',
    bodyEn: 'This moves the order back to <b>Paid</b>. Use it if you marked it preparing by mistake. The customer is not notified.',
    bodyCn: '这会把订单退回<b>已支付</b>。如果你是误点了备货,可以用它撤销。不会通知顾客。',
    confirmEn: 'Undo preparing', confirmCn: '撤销备货',
    cancelEn: 'Keep as is', cancelCn: '保持不变',
  });
  if (!ok) return;
  try {
    await api(`/api/retail-admin/orders/${id}/undo-preparing`, { method: 'POST', body: {} });
    toast('Undone · 已撤销 — back to Paid · 退回已支付');
    openOrder(id, { instant: true });
    loadOrders();
  } catch (e) {
    const msg = e.code === 'already_shipped'
      ? cuT('A parcel already has a waybill — cancel it first.', '已有包裹生成运单 — 请先取消运单。')
      : 'Failed · 失败: ' + e.message;
    toast(msg, 'err');
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
  // Short stamp (drop the leading year — "2026-07-06 13:59" → "07-06 13:59")
  // so the footer reads "Updated 07-06 13:59" like the mockup, not the long form.
  const syncShort = t?.synced_at ? formatDate(t.synced_at).replace(/^\d{4}-/, '') : '';
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
      kdBadge = `<span style="font-size:11px; color:#9A6E2A;">● sync inactive · 同步未生效 (reused number · 重复运单号)</span>`;
    } else if (s.jd_live) {
      kdBadge = `<span class="muted" style="font-size:11px; color: #5C7A4E;">● JD live sync on · 京东实时同步中</span>`;
    } else if (s.tracking_kd100_subscribed) {
      kdBadge = `<span class="muted" style="font-size:11px; color: #5C7A4E;">● kd100 live sync on · 快递100实时同步中</span>`;
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
      <div class="kicker" style="font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--text-3); margin-bottom: var(--s2);">Tracking · 物流</div>
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
              return t.status_label_en ? `<span class="pill st-dispatched"><span class="dot"></span>${escapeHtml(t.status_label_en)} · ${escapeHtml(t.status_label_cn)}</span>` : '';
            })()}
          </div>
          ${multiParcel ? renderParcelContents(s) : ''}
          <div class="od-trk-foot">
            ${kdBadge}
            <span class="od-trk-updated">${synced}</span>
            <span class="od-trk-foot-actions">
              ${t.carrier_code === 'jd' ? `<button class="btn btn-sm" onclick="printJdLabel(${o.id}, ${sid})" title="${escapeAttr(cuT('Print this JD waybill label on the local label printer', '在本机标签打印机打印此京东面单'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>${cuT('Print label · 打印面单', '打印面单 · Print label')}</button>` : ''}
              ${trackLink}
            </span>
          </div>
        </div>` : ''}
      ${eventsBlock}
      ${has ? `
        <details class="od-trk-edit">
          <summary><span class="od-trk-chev" aria-hidden="true">▸</span>Change waybill · 修改运单</summary>
          <div class="od-trk-edit-body">
            <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
              <select id="trk-carrier-${sid}" style="min-width:180px;">${carrierOpts}</select>
              <input type="text" id="trk-number-${sid}" value="${escapeHtml(t.number)}" placeholder="Tracking / waybill number" data-ph-en="Tracking / waybill number" data-ph-cn="快递单号 / 运单号" style="flex:1; min-width:200px; font-family: var(--f-mono);">
              <button class="btn btn-primary btn-sm" onclick="saveTracking(${o.id}, ${sid})">Update · 更新</button>
              ${t.carrier_code === 'jd' ? `<button class="btn btn-sm" style="color:var(--danger);" onclick="cancelJdPickup(${o.id}, ${sid}, event)">Cancel JD pickup · 取消揽收</button>` : ''}
              <button class="btn btn-sm" onclick="clearTracking(${o.id}, ${sid})">Clear · 清除</button>
            </div>
            ${t.carrier_code === 'jd' ? `<div class="muted" style="font-size:11px; margin-top:6px;">“Cancel JD pickup” calls off the courier with JD. “Clear” only removes the number locally (courier still comes). · “取消揽收”会向京东取消上门;“清除”仅在本地移除运单号(快递仍会上门)。</div>` : ''}
          </div>
        </details>`
      : `
        ${s.mode !== 'supplier' ? `
          <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="createJdLabel(${o.id}, ${sid}, '${s.mode || ''}', ${(s.items || []).some(it => it.needs_ice_pack) ? 1 : 0}, event)"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7l8.7 5 8.7-5"/><path d="M12 22V12"/></svg>Create JD label · 生成京东运单</button>
            <span class="muted" style="font-size:11px;">Free live tracking — JD bills the parcel. · 免费物流追踪。</span>
          </div>
          <div class="muted" style="font-size:11px; margin:8px 0 4px;">— or attach an existing waybill manually · 或手动填写已有运单 —</div>` : ''}
        <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
          <select id="trk-carrier-${sid}" style="min-width:180px;">${carrierOpts}</select>
          <input type="text" id="trk-number-${sid}" value="" placeholder="Tracking / waybill number" data-ph-en="Tracking / waybill number" data-ph-cn="快递单号 / 运单号" style="flex:1; min-width:200px; font-family: var(--f-mono);">
          <button class="btn btn-sm" onclick="saveTracking(${o.id}, ${sid})">Save tracking · 保存运单号</button>
        </div>
        ${s.mode !== 'supplier' ? `<div class="muted" style="font-size:11px; margin-top:6px;">A manually-entered number tracks via 快递100 (paid) — incl. a personal JD JDV0… number. For free JD tracking, use “Create JD label” above instead. · 手动录入的运单号通过快递100(付费)追踪,含个人的京东 JDV0… 单号;如需免费京东追踪,请改用上方“生成京东运单”。</div>` : ''}
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

// Open the local print component (trying each port in turn), send ONE print job,
// and resolve { ok, msg }. Times out per port so a missing component never hangs
// the UI. Protocol = JD cloud-print 报文2 (report format 2): an
// "orderType":"PRINT","version":"2" frame whose `parameters` carry the target
// `printName` and a `contents:[{ tempUrl, printData }]` list — the component
// renders the template `tempUrl` with the encrypted `printData` (the perPrintData
// string from pullData) and prints. It echoes a status frame: status 500 = ok,
// success "true"/"false", errors[] on failure.
function jdSendToComponent(printData, tempUrl, printName, ports) {
  ports = ports || JD_PRINT_PORTS;
  return new Promise((resolve) => {
    let i = 0;
    const tryPort = () => {
      if (i >= ports.length) { resolve({ ok: false, msg: 'component_unreachable' }); return; }
      const port = ports[i++];
      let ws, settled = false, timer;
      const finish = (r) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        try { ws && ws.close(); } catch (e) {}
        resolve(r);
      };
      // A failed connection should fall through to the next port, not resolve.
      const nextOrFail = () => { if (settled) return; settled = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} tryPort(); };
      try { ws = new WebSocket('ws://127.0.0.1:' + port); }
      catch (e) { nextOrFail(); return; }
      timer = setTimeout(nextOrFail, 4000);
      ws.onopen = () => {
        const msg = {
          orderType: 'PRINT',
          version: '2',
          key: (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.round(Math.random() * 1e6)),
          parameters: {
            printName: printName || '',
            contents: [{ tempUrl, printData }],
          },
        };
        try { ws.send(JSON.stringify(msg)); } catch (e) { finish({ ok: false, msg: 'send_failed' }); }
      };
      ws.onmessage = (ev) => {
        // Connected + got a reply → this IS the component; from here a bad reply
        // is a real print failure, not a "wrong port", so we finish (not retry).
        let d = ev.data;
        try { d = JSON.parse(ev.data); } catch (e) { finish({ ok: true }); return; }  // non-JSON ack
        const status  = d && d.status;
        const success = d && d.success;
        const errs    = d && (d.errors || (d.detailinfo && d.detailinfo.errors));
        const errMsg  = (Array.isArray(errs) && errs.length)
          ? (errs[0].message || errs[0].msg || JSON.stringify(errs[0]))
          : (d && (d.message || d.msg));
        // JD component: status 500 (or success "true") = printed/queued ok.
        const ok     = status === 500 || status === '500' || success === 'true' || success === true;
        const failed = success === 'false' || success === false || (Array.isArray(errs) && errs.length > 0);
        finish(ok || !failed ? { ok: true } : { ok: false, msg: errMsg || 'print_failed' });
      };
      ws.onerror = nextOrFail;
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
  if (!r || !r.data || !r.data.printData) {
    if (!opts.silent) toast(cuT('JD label data unavailable', '京东面单数据不可用'), 'err');
    return false;
  }
  // The component needs the exact printer name; ask once if it isn't set yet
  // (even on the auto path — without it the component can't pick a printer).
  let printer = jdPrinterName();
  if (!printer) printer = jdPromptPrinterName();
  if (!printer) { if (!opts.silent) toast(cuT('Set the JD printer name first', '请先设置京东打印机名称'), 'err'); return false; }
  const sent = await jdSendToComponent(r.data.printData, r.data.tempUrl, printer);
  if (sent.ok) { toast(cuT('JD label sent to printer', '京东面单已发送打印')); return true; }
  toast(sent.msg === 'component_unreachable'
    ? cuT('JD print component not detected on this PC — open 京东物流云打印组件', '未检测到本机京东打印组件 — 请打开京东物流云打印组件')
    : (cuT('JD label print failed', '京东面单打印失败') + ': ' + sent.msg), 'err', 6000);
  return false;
}

// POST the JD waybill with a chosen product code. The label is created under
// our JD account, so JD streams tracking events for free (no 快递100). Server
// resolves the sender from the fulfilling store's 发货地址 — surface the "store
// has no sender phone" gap as a clear instruction.
async function submitJdLabel(orderId, shipmentId, product, btn) {
  const qs = shipmentId ? '?shipment_id=' + shipmentId : '';
  try {
    const r = await adminWrite({
      btn,
      url: `/api/retail-admin/orders/${orderId}/jd-waybill${qs}`,
      method: 'POST', body: { shipment_id: shipmentId, product },
      errLabelEn: 'JD label failed', errLabelCn: '生成运单失败',
    });
    toast(cuT('JD waybill created', '京东运单已生成') + ': ' + (r?.data?.waybill || ''));
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

// Create a JD waybill for a parcel. Air parcels always ship fresh-express
// (生鲜特快 / LL-SD-M) — the order already tells us it's air, so create the
// waybill directly with no prompt at all. Ground/local parcels still ask the
// one thing the order can't tell us: fresh-ground (生鲜标快) vs ambient-ground
// (京东标快), since that depends on what's in the box. We never re-ask air vs
// ground — only the two GROUND options are offered.
function createJdLabel(orderId, shipmentId, mode, isFresh, ev) {
  if (mode === 'air') {
    submitJdLabel(orderId, shipmentId, 'LL-SD-M', ev?.currentTarget);
    return;
  }
  const preset = jdSuggestedService(mode, !!Number(isFresh));
  const services = JD_SERVICES.filter(s => s.code !== 'LL-SD-M');   // ground-only: fresh vs ambient
  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg tacet';
  bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width: 460px; max-width: 92vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin:0; font-size:14px;">${cuT('Create JD label', '生成京东运单')}</h3>
          <div class="muted" style="font-size:11px; margin-top:2px;">${cuT('Ground parcel — is it fresh (ice pack) or ambient?', '陆运包裹 — 生鲜(冰袋)还是普通?')}</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Close', '关闭')}</button>
      </div>
      <div class="pu-editor-body" style="grid-template-columns: 1fr; padding: 18px; display:block;">
        <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:14px;">
          ${services.map(s => `
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
    const ok = await submitJdLabel(orderId, shipmentId, product, e.currentTarget);
    if (ok) bg.remove();
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
        ${creditAmt != null && creditAmt > 0.005 ? `<div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">Cash refunded · 现金退款</div><b>¥${fmt(cashAmt)}</b></div><div><div class="muted" style="font-size: 10px; text-transform: uppercase; letter-spacing: .08em;">To wallet/points · 退回余额/积分</div><b>¥${fmt(creditAmt)}</b></div>` : ''}
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
        <button class="btn btn-sm" onclick="openRefundEvents(${o.id})" title="Audit log · 审计记录"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/></svg>History · 历史</button>
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
                <span class="muted" style="font-size: 11px;">× ¥${fmt(it.unit)} = <b id="drf-line-amt-${it.id}">¥${fmt(it.unit * remain)}</b></span>
              </div>`;
              }).join('');
            })()}
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
          <label class="stacked">Amount · 金额 (¥)</label>
          <input type="number" id="rf-amt" step="0.01" min="0" max="${total}" value="${(initialMode === 'amount' ? defaultAmount : total).toFixed(2)}" style="width: 100%;">
          <div class="muted" style="font-size: 11px; margin-top: 4px;">${cuT('Order total', '订单总额')} ¥${fmt(total)}${o.refund_amount_requested != null ? ' · ' + cuT('customer asked for', '顾客申请') + ' ¥' + fmt(o.refund_amount_requested) : ''}</div>
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
      toast(`Approved · 已批准 ¥${fmt(j.amount || 0)}`);
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
    set('oc-needs_invoice',   d.needs_invoice);
  } catch {}
}

// Channel chips are a plain filter axis — no per-channel counts. The actionable
// numbers live on the status counters (pending, paid, preparing, …) instead.
function refreshOrderChannelCounts() {}

// ═══════════════════════════════════════════════════════════════════
// NEW ORDER (manual) — staff create an order on a customer's behalf.
// Prices from the live catalog with per-line + grand-total overrides;
// attach to an existing customer or leave as a guest. POSTs to
// /api/retail-admin/orders (channel/source = 'manual').
// ═══════════════════════════════════════════════════════════════════
let OM_LINES = [];            // [{ product_id, name_en, name_cn, sku, size, qty, unit_price }]
let OM_CUSTOMER = null;       // { id, nickname, phone } when linked to an account
let OM_TOTAL_EDITED = false;  // true once staff hand-edit the grand total
let omCustTimer = null, omProdTimer = null;
let OM_CUST_RESULTS = [];     // last customer search hits (index-addressed by the dropdown)
let OM_PROD_RESULTS = [];     // last product search hits

function omOpen() {
  OM_LINES = [];
  OM_CUSTOMER = null;
  OM_TOTAL_EDITED = false;
  ['om-cust-q', 'om-recipient-name', 'om-recipient-phone', 'om-prod-q', 'om-staff-note',
   'om-addr-province', 'om-addr-city', 'om-addr-district', 'om-addr-address', 'om-addr-detail', 'om-addr-postal']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const sh = $('#om-shipping'); if (sh) sh.value = '0';
  const tot = $('#om-total'); if (tot) tot.value = '';
  const sc = $('#om-save-customer'); if (sc) sc.checked = false;
  const st = $('#om-status'); if (st) st.value = 'pending_payment';
  const pay = $('#om-pay'); if (pay) pay.value = 'offline';
  omRenderCustSelected();
  omRenderLines();
  omHide('#om-cust-results'); omHide('#om-prod-results');
  cuShowModal('#om-bg');
  setTimeout(() => { const el = $('#om-cust-q'); if (el) el.focus(); }, 60);
}
function omClose() { $('#om-bg').classList.remove('show'); }
function omHide(sel) { const el = $(sel); if (el) { el.hidden = true; el.innerHTML = ''; } }

// ── Customer link ──────────────────────────────────────────────────
function omCustSearch() {
  clearTimeout(omCustTimer);
  const q = $('#om-cust-q').value.trim();
  if (!q) { omHide('#om-cust-results'); return; }
  omCustTimer = setTimeout(async () => {
    try {
      const j = await api('/api/retail-admin/customers?pageSize=8&q=' + encodeURIComponent(q));
      OM_CUST_RESULTS = (j.data || []).slice(0, 8);
      const box = $('#om-cust-results');
      if (!OM_CUST_RESULTS.length) { box.innerHTML = '<div class="om-opt muted">No matches · 无匹配</div>'; box.hidden = false; return; }
      // Index-addressed onclick (omPickCustomer(i)) — never interpolate names
      // into the attribute, so apostrophes/quotes in a nickname can't break it.
      box.innerHTML = OM_CUST_RESULTS.map((c, i) => {
        const nm = omEsc(c.nickname || cuT('(no name)', '(无名)'));
        const sub = omEsc([c.phone, '#' + c.id].filter(Boolean).join(' · '));
        return `<div class="om-opt" onclick="omPickCustomer(${i})"><span>${nm}</span><span class="om-sub">${sub}</span></div>`;
      }).join('');
      box.hidden = false;
    } catch { omHide('#om-cust-results'); }
  }, 220);
}
function omEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function omPickCustomer(i) {
  const c = OM_CUST_RESULTS[i];
  if (!c) return;
  OM_CUSTOMER = { id: c.id, nickname: c.nickname || '', phone: c.phone || '' };
  if (!$('#om-recipient-name').value.trim())  $('#om-recipient-name').value  = c.nickname || '';
  if (!$('#om-recipient-phone').value.trim()) $('#om-recipient-phone').value = c.phone || '';
  $('#om-cust-q').value = '';
  omHide('#om-cust-results');
  omRenderCustSelected();
}
function omClearCustomer() { OM_CUSTOMER = null; omRenderCustSelected(); }
function omRenderCustSelected() {
  const el = $('#om-cust-selected');
  const row = $('#om-save-cust-row');
  if (OM_CUSTOMER) {
    const sub = omEsc([OM_CUSTOMER.phone, '#' + OM_CUSTOMER.id].filter(Boolean).join(' · '));
    el.innerHTML = cuT('Linked: ', '已关联:') + '<b>' + omEsc(OM_CUSTOMER.nickname || ('#' + OM_CUSTOMER.id)) + '</b> '
      + '<span class="muted">' + sub + '</span> '
      + '<button type="button" class="lnk-btn" onclick="omClearCustomer()">' + cuT('clear · 取消关联', '取消关联') + '</button>';
    el.style.display = '';
    if (row) row.style.display = 'none';   // already a saved customer
  } else {
    el.style.display = 'none';
    if (row) row.style.display = '';
  }
}

// ── Product lines ──────────────────────────────────────────────────
function omProdSearch() {
  clearTimeout(omProdTimer);
  const q = $('#om-prod-q').value.trim();
  if (!q) { omHide('#om-prod-results'); return; }
  omProdTimer = setTimeout(async () => {
    try {
      const j = await api('/api/retail-admin/products?limit=10&q=' + encodeURIComponent(q));
      OM_PROD_RESULTS = (j.data || []).slice(0, 10);
      const box = $('#om-prod-results');
      if (!OM_PROD_RESULTS.length) { box.innerHTML = '<div class="om-opt muted">No matches · 无匹配</div>'; box.hidden = false; return; }
      box.innerHTML = OM_PROD_RESULTS.map((p, i) => {
        const nm = omEsc(p.name_en || p.name_cn || ('#' + p.id));
        const price = '¥' + (Number(p.sell_price) || 0).toFixed(2);
        const sub = omEsc([p.sku, price].filter(Boolean).join(' · '));
        return `<div class="om-opt" onclick="omAddLine(${i})"><span>${nm}</span><span class="om-sub">${sub}</span></div>`;
      }).join('');
      box.hidden = false;
    } catch { omHide('#om-prod-results'); }
  }, 220);
}
function omAddLine(i) {
  const p = OM_PROD_RESULTS[i];
  if (!p) return;
  const existing = OM_LINES.find(l => l.product_id === p.id);
  if (existing) { existing.qty += 1; }
  else {
    OM_LINES.push({ product_id: p.id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku, size: p.size, qty: 1, unit_price: Number(p.sell_price) || 0 });
  }
  $('#om-prod-q').value = '';
  omHide('#om-prod-results');
  omRenderLines();
}
function omRemoveLine(i) { OM_LINES.splice(i, 1); omRenderLines(); }
function omLineQty(i, v)   { const n = Number(v); OM_LINES[i].qty = n > 0 ? n : 0; omRecalc(); }
function omLinePrice(i, v) { const n = Number(v); OM_LINES[i].unit_price = (Number.isFinite(n) && n >= 0) ? n : 0; omRecalc(); }
function omRenderLines() {
  const tb = $('#om-lines');
  if (!OM_LINES.length) {
    tb.innerHTML = '<tr><td colspan="5" class="muted" style="padding:8px 6px;">' + cuT('No items yet — search above to add.', '暂无商品——在上方搜索添加。') + '</td></tr>';
    omRecalc(); return;
  }
  tb.innerHTML = OM_LINES.map((l, i) => {
    const isCn = (typeof cuLang === 'function') && cuLang() === 'cn';
    const nm = (isCn ? (l.name_cn || l.name_en) : (l.name_en || l.name_cn)) || ('#' + l.product_id);
    const lineTotal = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
    return `<tr>
      <td style="padding:4px 6px;">${omEsc(nm)}${l.sku ? '<div class="muted" style="font-size:10px;">' + omEsc(l.sku) + '</div>' : ''}</td>
      <td style="padding:4px 6px;"><input type="number" min="0" step="1" value="${l.qty}" style="width:56px;" oninput="omLineQty(${i}, this.value)"></td>
      <td style="padding:4px 6px;"><input type="number" min="0" step="0.01" value="${l.unit_price}" style="width:84px;" oninput="omLinePrice(${i}, this.value)"></td>
      <td style="padding:4px 6px; text-align:right;">¥${lineTotal.toFixed(2)}</td>
      <td style="text-align:center;"><button type="button" class="lnk-btn" style="padding:0;" onclick="omRemoveLine(${i})" title="Remove · 移除">✕</button></td>
    </tr>`;
  }).join('');
  omRecalc();
}
function omSubtotal() {
  return Math.round(OM_LINES.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0) * 100) / 100;
}
function omRecalc() {
  const sub = omSubtotal();
  const ship = Number($('#om-shipping').value) || 0;
  $('#om-subtotal').textContent = '¥' + sub.toFixed(2);
  if (!OM_TOTAL_EDITED) {
    $('#om-total').value = (Math.round((sub + ship) * 100) / 100).toFixed(2);
  }
}
function omTotalEdited() { OM_TOTAL_EDITED = true; }

// ── Submit ─────────────────────────────────────────────────────────
async function omSubmit() {
  const name  = $('#om-recipient-name').value.trim();
  const phone = $('#om-recipient-phone').value.trim();
  if (!OM_LINES.length) { toast(cuT('Add at least one item · 请至少添加一个商品', '请至少添加一个商品'), 'err'); return; }
  if (OM_LINES.some(l => !(Number(l.qty) > 0))) { toast(cuT('Every line needs a qty > 0 · 每行数量需大于0', '每行数量需大于0'), 'err'); return; }
  if (!name) { toast(cuT('Enter a customer / recipient name · 请填写顾客/收件人姓名', '请填写姓名'), 'err'); return; }

  const btn = $('#om-create-btn');
  const oldTxt = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    // Optionally save a guest as a real customer first, then attach it.
    let customerId = OM_CUSTOMER ? OM_CUSTOMER.id : null;
    if (!customerId && $('#om-save-customer') && $('#om-save-customer').checked && (name || phone)) {
      const cj = await adminWrite({
        url: '/api/retail-admin/customers', method: 'POST',
        body: { nickname: name, phone }, errLabelEn: 'Customer save failed', errLabelCn: '顾客保存失败',
      });
      customerId = cj?.data?.id || null;
    }

    const addr = {
      province: $('#om-addr-province').value.trim(),
      city:     $('#om-addr-city').value.trim(),
      district: $('#om-addr-district').value.trim(),
      address:  $('#om-addr-address').value.trim(),
      detail:   $('#om-addr-detail').value.trim(),
      postal_code: $('#om-addr-postal').value.trim(),
    };
    const hasAddr = Object.values(addr).some(Boolean);

    const body = {
      customer_id: customerId,
      recipient_name: name,
      recipient_phone: phone,
      items: OM_LINES.map(l => ({ product_id: l.product_id, qty: Number(l.qty), unit_price: Number(l.unit_price) })),
      shipping_fee: Number($('#om-shipping').value) || 0,
      status: $('#om-status').value,
      payment_method: $('#om-pay').value,
      staff_note: $('#om-staff-note').value.trim() || null,
    };
    // Only send total_override when staff actually edited it (else let the
    // server compute subtotal + shipping authoritatively).
    if (OM_TOTAL_EDITED) body.total_override = Number($('#om-total').value) || 0;
    if (hasAddr) body.address = addr;

    const j = await adminWrite({
      url: '/api/retail-admin/orders', method: 'POST', body,
      errLabelEn: 'Order create failed', errLabelCn: '订单创建失败',
    });
    const d = j?.data || {};
    if (typeof loadOrders === 'function') loadOrders();
    if (typeof refreshOrderChannelCounts === 'function') refreshOrderChannelCounts();
    // Pending order with a pay link → show it so staff can share the QR/link.
    // Paid (offline) order → nothing to collect, jump straight to the drawer.
    if (d.pay_url) {
      omClose();
      omShowPayResult(d);
    } else {
      omClose();
      toast(cuT('Order created · 已创建订单', '已创建订单') + ' ' + (d.order_no || ''));
      if (d.id != null && typeof openOrder === 'function') openOrder(d.id);
    }
  } catch { /* already toasted */ }
  finally { if (btn) { btn.disabled = false; if (oldTxt != null) btn.textContent = oldTxt; } }
}

// ── Post-create pay-link result (guest pay) ────────────────────────
let OM_DONE = null;   // { id, order_no, pay_url }
function omShowPayResult(d) {
  OM_DONE = d;
  $('#om-done-sub').textContent = cuT('Order ', '订单 ') + (d.order_no || '') + cuT(' · awaiting payment', ' · 待付款');
  $('#om-pay-url').value = d.pay_url || '';
  cuShowModal('#om-done-bg');
}
function omCopyPayLink() {
  const el = $('#om-pay-url'); if (!el) return;
  el.select();
  const ok = () => toast(cuT('Copied · 已复制', '已复制'));
  try { if (document.execCommand('copy')) return ok(); } catch (e) { /* fall through */ }
  try { navigator.clipboard.writeText(el.value).then(ok); } catch (e) { /* ignore */ }
}
function omOpenQr() { if (OM_DONE && OM_DONE.pay_url) window.open(OM_DONE.pay_url, '_blank'); }
function omDone() {
  $('#om-done-bg').classList.remove('show');
  const id = OM_DONE && OM_DONE.id;
  OM_DONE = null;
  if (id != null && typeof openOrder === 'function') openOrder(id);
}

// Products are managed entirely from the main /products page on the
// kitchen admin — name, price, description, image, and the new
// "Show in mini-app shop" toggle all live there. No duplicate retail
// price or description; one source of truth.

