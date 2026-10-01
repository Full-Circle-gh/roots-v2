/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 01/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: bootstrap ($/$$, ICONS, toast/api/escape helpers, payment labels), live-push hub (retailLiveSubscribe), tab switcher, editor-iframe lazy-load, kitchen-categories editor (cat*) */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const ICONS = {
  open:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  close:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  check:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  image:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  empty:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
};

// Channel glyphs for the combined orders view — monochrome line SVGs (never
// emoji), inherit currentColor, sized by the .chan-ico / inline CSS rules. Keys
// match retail_orders.channel ('' / 'wechat' default = mini app).
const CHAN_ICON = {
  all:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  wechat:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10.2c0-3.6-3.2-6.2-7.1-6.2S2.3 6.6 2.3 10.2c0 1.8.8 3.4 2.1 4.6-.1.9-.4 1.8-.9 2.6a8 8 0 0 0 3.3-1.2c.9.2 1.8.3 2.7.2"/><path d="M21.7 15.4c0-2.9-2.6-5.1-5.7-5.1-.4 0-.8 0-1.2.1.4.9.6 1.8.6 2.8 0 1.6-.6 3-1.7 4.1a6.9 6.9 0 0 0 2.3.4c.6 0 1.2-.1 1.8-.2a6.4 6.4 0 0 0 2.6 1c-.3-.6-.5-1.3-.6-2 .6-.9.9-1.9.9-3.1Z"/><circle cx="6.3" cy="9.6" r="0.85" fill="currentColor" stroke="none"/><circle cx="10.3" cy="9.6" r="0.85" fill="currentColor" stroke="none"/></svg>',
  web:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>',
  meituan:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 17h7"/><path d="M18 17l-3-8h-3"/><path d="M3 9h4l3.5 8"/><path d="M14 6h3v3"/></svg>',
  gzgrocery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 3 0"/><line x1="9" y1="20" x2="9" y2="14"/><line x1="15" y1="20" x2="15" y2="14"/></svg>',

  // Staff-created. Was MISSING from this map, so chanIcon('manual') fell
  // through to `|| CHAN_ICON.wechat` and painted a WeChat glyph beside the
  // word "Manual" on every manual order row in Orders — a fabricated claim
  // about where an order came from, already live, found by accident while
  // wiring the Customers channel filter. It is the SAME failure as the
  // Customers list's old COALESCE(...,'wechat') default: a fallback that
  // looks like data. A missing glyph must render nothing, never a guess.
  // Glyph copied byte-for-byte from the Orders channel dropdown, which had
  // it inline only and so never hit this fallback.
  manual:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',

  // A sale that originated at a physical shop — till or QR menu (§14, §44).
  // A storefront with a DOOR, deliberately not the scalloped awning gzgrocery
  // carries: the two would be told apart only by counting the scallops at
  // 16 pixels, and a glyph an operator has to squint at is the same fabricated
  // claim as a wrong one. Registered here rather than left to chanIcon's ''
  // fallback so `shop` is a first-class value from the day it can be written.
  shop:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10l2-5.5a1 1 0 0 1 .94-.5h14.12a1 1 0 0 1 .94.5L22 10"/><path d="M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9"/><path d="M10 20v-6h4v6"/></svg>',
};
// Resolve a channel string to its glyph. An UNKNOWN channel gets NO glyph —
// never WeChat's (§1.17 rule 2). This used to end `|| CHAN_ICON.wechat`, which
// painted a WeChat mark beside every channel the map had never heard of; that
// is the same fabricated claim the `manual` key was added to stop, one layer
// down. Returns '' rather than undefined so callers can interpolate it
// straight into HTML.
// The `|| 'wechat'` on the input stays and is not a guess: retail_orders.channel
// is DEFAULT 'wechat', so an absent value genuinely is the mini app.
function chanIcon(channel) {
  const c = String(channel || 'wechat').toLowerCase();
  return CHAN_ICON[c] || '';
}

/* ANOTHER PAGE OF THIS APP — a new tab in a browser, this window when the back
   office is INSTALLED.
   ------------------------------------------------------------------------
   Reported from the shop tablet: the rail's Counter till opened the till under
   a grey bar reading "Counter · store.rootskitchenchina.com" with an ✕ and a
   ⋮, and nothing on the tablet turned it off. That bar is Edge's in-app
   browser, and it is not a setting anybody can switch: an installed app has no
   tab strip, so `window.open(url, '_blank')` has nowhere to put a tab and the
   browser falls back to that view. Its ✕ does not dismiss the bar — it closes
   the page underneath and drops the operator back where they started.

   Navigating this window instead costs nothing and removes the bar entirely:
   every URL passed here is inside the installed app's scope ('/' — see
   public/admin-manifest.webmanifest), so it opens as part of the app. A real
   browser tab keeps the behaviour it had, because a desk with a mouse wants
   the till beside the back office rather than on top of it.

   TESTED POSITIVELY, one mode at a time, rather than `not (display-mode:
   browser)`: a browser that has never heard of the query answers `false` to
   every media query it cannot parse, and the negated form would read that
   false as "installed" and swallow every new tab in the product. This form
   fails the other way — unknown means browser, which is what it was. All four
   modes are asked because admin-manifest's display_override lists minimal-ui
   alongside standalone and both are equally tabless; navigator.standalone is
   the only answer iOS gives at all. */
const APP_DISPLAY_MODES = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'];
function isInstalledApp() {
  try {
    if (window.navigator.standalone === true) return true;
    if (!window.matchMedia) return false;
    return APP_DISPLAY_MODES.some(m => window.matchMedia('(display-mode: ' + m + ')').matches);
  } catch (e) { return false; }
}
function openAppPage(url) {
  if (isInstalledApp()) { location.href = url; return; }
  window.open(url, '_blank', 'noopener');
}

// `opts` is a NUMBER for every existing caller (a duration in ms) and may also
// be an object: { ms, title }. `title` puts the machine-readable reason on the
// element's title attribute — an operator can hover it to quote the exact code
// to support, without the code being what they read (audit A-09).
function toast(msg, kind = 'ok', opts) {
  const isObj = opts && typeof opts === 'object';
  const ms = isObj ? opts.ms : opts;
  const t = $('#toast');
  t.textContent = msg;
  if (isObj && opts.title) t.title = String(opts.title); else t.removeAttribute('title');
  // Normalize aliases so every caller lands on a styled variant (.ok / .err).
  const cls = (kind === 'error' || kind === 'err') ? 'err'
            : (kind === 'success' || kind === 'ok') ? 'ok'
            : kind;
  t.className = 'toast ' + cls;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._h);
  // Errors linger longer so the operator can read what went wrong before it
  // fades; callers can override with an explicit duration.
  const dur = ms != null ? ms : (cls === 'err' ? 6000 : 2600);
  toast._h = setTimeout(() => t.classList.remove('show'), dur);
}
/* ══════════════════════════════════════════════════════════════════════════
   ERROR CODES, IN WORDS (audit A-09 / G-01)

   The server answers a failed write with a stable code — `sku_taken`,
   `insufficient_stock`, `forbidden_capability` — and often, but not always, a
   human `message`. When it sent only the code, the code is what the merchant
   read: 195 toast sites showed "not_found", "db_insert_failed",
   "kitchen_add_only" to a shopkeeper.

   Three layers, in order:

     1. The server's own `message`, when it sent one. It knows more than a
        dictionary can — which SKU, whose product, how many are left.
     2. This dictionary, for the codes a merchant realistically meets.
     3. The code with its underscores opened out and a capital on the front.
        Not a sentence, but words — "Insufficient stock" beats
        "insufficient_stock", and a code added tomorrow reads as words on the
        day it ships rather than after somebody remembers this file.

   THE CODE ITSELF IS NEVER LOST. It goes on the error object as `.code` and
   into the toast's `title`, so an operator can still quote it to support. What
   changes is what they READ.

   Bilingual, because every other sentence in this product is.
   ══════════════════════════════════════════════════════════════════════════ */
const TD_ERR = {
  // ── Not there, or not yours ──
  not_found:              ['That record no longer exists — it may have been deleted while this page was open.', '该记录已不存在,可能在本页打开期间被删除。'],
  order_not_found:        ['That order no longer exists.', '该订单已不存在。'],
  product_not_found:      ['That product no longer exists.', '该商品已不存在。'],
  customer_not_found:     ['That customer no longer exists.', '该顾客已不存在。'],
  store_not_found:        ['That location no longer exists.', '该门店已不存在。'],
  shipment_not_found:     ['That parcel no longer exists.', '该包裹已不存在。'],
  version_not_found:      ['That version is no longer saved.', '该版本已不存在。'],
  forbidden:              ['You do not have permission to do that.', '你没有执行该操作的权限。'],
  forbidden_capability:   ['Your role does not include this action. An owner can grant it on the Team page.', '你的角色不包含此操作。可由负责人在团队页授权。'],
  forbidden_store:        ['You can only do that in a location you are assigned to.', '只能在你被分配的门店执行该操作。'],
  store_not_assigned:     ['You are not assigned to that location.', '你未被分配到该门店。'],
  account_blocked:        ['That account is blocked.', '该账号已被封禁。'],
  store_locked:           ['That location is locked and cannot be changed.', '该门店已锁定,无法修改。'],

  // ── The form ──
  bad_id:                 ['Something is wrong with that link — reload the page and try again.', '链接有误,请刷新页面后重试。'],
  bad_input:              ['One of the values is not something the system can read.', '有一项内容无法识别。'],
  bad_request:            ['The system could not read that request. Reload the page and try again.', '无法读取该请求,请刷新页面后重试。'],
  bad_payload:            ['The system could not read that request. Reload the page and try again.', '无法读取该请求,请刷新页面后重试。'],
  no_fields:              ['Nothing was changed, so nothing was saved.', '没有任何改动,未保存。'],
  missing_fields:         ['Some required fields are still empty.', '还有必填项未填写。'],
  missing_required:       ['Some required fields are still empty.', '还有必填项未填写。'],
  name_required:          ['Give it a name first.', '请先填写名称。'],
  title_required:         ['Give it a title first.', '请先填写标题。'],
  code_required:          ['Enter a code first.', '请先填写编码。'],
  amount_required:        ['Enter an amount first.', '请先填写金额。'],
  date_required:          ['Choose a date first.', '请先选择日期。'],
  reason_required:        ['Give a reason first.', '请先填写原因。'],
  message_required:       ['Write a message first.', '请先填写内容。'],
  store_required:         ['Choose a location first.', '请先选择门店。'],
  supplier_required:      ['Choose a supplier first.', '请先选择供应商。'],
  address_required:       ['An address is needed first.', '请先填写地址。'],
  location_required:      ['Choose a location first.', '请先选择地点。'],
  label_required:         ['Give it a label first.', '请先填写标签。'],
  lines_required:         ['Add at least one line first.', '请至少添加一行。'],
  ids_required:           ['Nothing was selected.', '未选择任何项目。'],
  no_items:               ['There is nothing in it yet.', '目前没有任何项目。'],
  no_ids:                 ['Nothing was selected.', '未选择任何项目。'],
  bad_email:              ['That email address does not look right.', '邮箱地址格式不正确。'],
  bad_phone:              ['That phone number does not look right.', '电话号码格式不正确。'],
  bad_status:             ['That status is not one this record can be in.', '该状态对此记录无效。'],
  invalid_status:         ['That status is not one this record can be in.', '该状态对此记录无效。'],
  invalid_amount:         ['That amount is not a number the system can use.', '该金额无效。'],
  invalid_qty:            ['That quantity is not a number the system can use.', '该数量无效。'],
  qty_positive_required:  ['The quantity has to be more than zero.', '数量必须大于 0。'],
  bad_delta:              ['That adjustment is not a number the system can use.', '该调整数量无效。'],
  invalid_page:           ['That page does not exist.', '该页面不存在。'],
  too_large:              ['That file is too big.', '文件过大。'],
  no_file:                ['No file was chosen.', '未选择文件。'],
  not_an_image:           ['That file is not an image.', '该文件不是图片。'],
  bad_image:              ['That image could not be read.', '无法读取该图片。'],
  bad_data_uri:           ['That image could not be read.', '无法读取该图片。'],
  unsupported_type:       ['That kind of file is not accepted here.', '此处不接受该类型的文件。'],

  // ── Already taken, already done ──
  sku_taken:              ['Another product already uses that SKU.', '该货号已被其他商品占用。'],
  name_taken:             ['Something already uses that name.', '该名称已被占用。'],
  duplicate_name:         ['Something already uses that name.', '该名称已被占用。'],
  phone_taken:            ['Another customer already has that phone number.', '该电话号码已属于另一位顾客。'],
  already_linked:         ['That is already linked.', '已关联。'],
  already_copied:         ['That has already been copied.', '已复制过。'],
  already_paid:           ['That has already been paid.', '已付款。'],
  already_shipped:        ['That has already shipped, so it cannot be undone here.', '已发货,无法在此撤销。'],
  already_delivered:      ['That has already been delivered.', '已送达。'],
  already_used_or_missing:['That has already been used, or is no longer there.', '已使用或已不存在。'],
  already_reset:          ['That customer has already been reset — they are waiting to arrive as a new customer.', '该顾客已重置，正等待以新顾客身份进入。'],
  already_receiving:      ['Somebody is already receiving that order.', '已有人正在收货。'],
  // §177, the shop menu move. A destination is refused on its LISTING COUNT,
  // so this is the sentence for a location that has a menu of its own — not
  // for one that merely has a shop record.
  destination_has_menu:   ['That location already has a menu of its own.', '该门店已有商品,请选择其他门店。'],
  nothing_to_move:        ['There is nothing on this menu to move.', '没有可移动的商品。'],
  same_location:          ['The menu is already at that location.', '商品已在该门店。'],
  courier_already_called: ['A courier has already been called for this order.', '该订单已呼叫运力。'],
  refund_already_processing: ['A refund is being processed for this order right now — try again in a moment.', '该订单正在处理退款,请稍后重试。'],
  code_exists:            ['That code is already in use.', '该编码已存在。'],
  code_active:            ['A live coupon already uses that code.', '已有生效中的优惠券使用该编码。'],
  id_reserved:            ['That id is reserved.', '该 ID 为保留值。'],

  // ── Stock ──
  insufficient_stock:     ['There is not enough stock on the shelf for that.', '货架库存不足。'],
  no_stock:               ['There is no stock on the shelf for that.', '该商品无库存。'],
  would_go_negative:      ['That would take the count below zero.', '该操作会使库存变为负数。'],
  flash_stock_exceeded:   ['That is more than the flash sale has left.', '超出限时特惠剩余数量。'],
  product_unavailable:    ['That product is not on sale at the moment.', '该商品当前不可售。'],
  no_active_store:        ['No location is open. Add or reopen one in Settings → Operations.', '没有营业中的门店,请在设置 → 运营中添加或重新开启。'],
  catalog_locked:         ['The catalogue is managed upstream and cannot be edited here.', '商品库由上游统一管理,此处不可编辑。'],

  // ── Orders, refunds, delivery ──
  order_closed:           ['That order is closed and can no longer be changed.', '该订单已关闭,无法再修改。'],
  not_cancellable:        ['That order is past the point where it can be cancelled.', '该订单已无法取消。'],
  not_reversible:         ['That cannot be undone.', '该操作无法撤销。'],
  not_shippable:          ['That order is not ready to ship.', '该订单尚不可发货。'],
  // §193 — reachable from three routes now (parcel dispatch, parcel prepare and
  // the JD label), and until now it had no entry at all: a Chinese admin read
  // the bare code in English. Both halves are live verbatim — '该包裹' from
  // invalid_shipment_id below, '正在等待补货。' from lib/push-events.js.
  parcel_awaiting_restock: ['That parcel is waiting on a restock.', '该包裹正在等待补货。'],
  not_payable:            ['That order cannot be paid for in its current state.', '该订单当前状态无法付款。'],
  not_delivered:          ['That has not been delivered yet.', '尚未送达。'],
  has_tracking:           ['A waybill is already attached.', '已关联运单号。'],
  no_shipments:           ['That order has no parcels yet.', '该订单还没有包裹。'],
  invalid_shipment_id:    ['That parcel is not part of this order.', '该包裹不属于此订单。'],
  invalid_carrier:        ['That carrier is not one the system knows.', '系统不支持该快递公司。'],
  invalid_method:         ['That method is not one the system knows.', '系统不支持该方式。'],
  invalid_payment_method: ['That payment method is not one the system knows.', '系统不支持该付款方式。'],
  unsupported_payment_method: ['That payment method is not accepted here.', '此处不接受该付款方式。'],
  use_refund_payout:      ['This order already has an approved or paid refund — use the refund payout action instead.', '该订单已有已批准或已支付的退款,请使用退款支付操作。'],
  return_exceeds_received:['That is more than was received.', '超出已收货数量。'],
  return_blocked:         ['That return cannot be made.', '无法退货。'],
  undo_blocked:           ['That cannot be undone from here.', '无法在此撤销。'],
  slot_unavailable:       ['That delivery window is no longer available.', '该配送时段已不可选。'],
  address_not_found:      ['That address could not be found on the map.', '地图上找不到该地址。'],
  no_zone_match:          ['That address is not inside any of your delivery areas.', '该地址不在任何配送区域内。'],
  pickup_order:           ['That is a collection order, so it is not delivered.', '该订单为自提,不涉及配送。'],
  no_printer_for_store:   ['No printer is set up for that location.', '该门店未配置打印机。'],

  // ── Points, coupons, wallet ──
  insufficient_points:    ['There are not enough points for that.', '积分不足。'],
  points_cannot_cover_shipping: ['Points cannot be used to pay the delivery fee.', '积分不可抵扣运费。'],
  not_eligible:           ['This does not qualify.', '不符合条件。'],
  program_disabled:       ['That programme is switched off.', '该功能已关闭。'],
  code_expired:           ['That code has expired.', '该编码已过期。'],
  bad_code:               ['That code is not right.', '编码不正确。'],
  too_many_attempts:      ['Too many tries. Wait a moment and try again.', '尝试次数过多,请稍后重试。'],
  daily_cap:              ['That is today’s limit.', '已达今日上限。'],
  too_soon:               ['Too soon — try again in a moment.', '操作过于频繁,请稍后重试。'],
  /* §151. What a locked database answers now, in place of the 401 that used to
     send an operator to the login page mid-task. It says the system, not the
     operator: `too_soon` and `too_many_attempts` sit one line up and both blame
     the person clicking, which is the wrong sentence for a queue they cannot
     see. 系统繁忙 is WeChat's own word for exactly this transient state; 请稍后重试
     is live in five pairs in this table. Declared in the vocabulary, v1.97. */
  service_busy:           ['The system is busy right now — try again in a moment.', '系统繁忙,请稍后重试。'],

  // ── A late parcel that spoiled the food (§98) ──
  // The refusal an operator actually meets: the close button on a delay case,
  // pressed while the carrier still owes an answer. It is the feature, not a
  // fault, so it says what is unfinished rather than that something failed.
  // `reason_required` and `amount_required` are NOT repeated here: this
  // catalogue already carries both, worded for exactly this situation, and a
  // second copy would be two sentences for one code drifting apart.
  case_not_closeable:     ['The carrier claim is not finished yet.', '承运商赔偿尚未完成。'],
  replacement_exists:     ['A replacement has already been sent for this parcel.', '该包裹已补发。'],
  // §98 addendum 8 — the sheet checks all four of these before it posts, so
  // reaching one means a stale page or a hand-made request. They are worded
  // anyway: a silent refusal on a screen that sends real stock is worse.
  bad_item:               ['That line is not in this parcel.', '该商品不在此包裹内。'],
  bad_items:              ['That line is not in this parcel.', '该商品不在此包裹内。'],
  duplicate_item:         ['That line is not in this parcel.', '该商品不在此包裹内。'],
  bad_qty:                ['Every line needs a quantity of 1 or more.', '每行数量需为 1 或以上。'],
  qty_too_high:           ['A replacement cannot send more than went out.', '补发不能超过已发出的数量。'],
  bad_shipping_cost:      ['Enter a shipping cost of 0 or more.', '运费成本需为 0 或以上。'],
  unknown_carrier:        ['That carrier is not one the system knows.', '承运商不正确。'],

  // ── Not set up ──
  not_configured:         ['That is not set up yet — finish it in Settings → Integrations.', '尚未配置,请在设置 → 集成中完成。'],
  unknown_integration:    ['That integration is not one the system knows.', '系统不支持该集成。'],
  store_not_connected:    ['That location is not linked to the channel yet.', '该门店尚未关联到渠道。'],
  wechat_creds_not_configured: ['WeChat is not set up yet — finish it in Settings → Integrations.', '微信尚未配置,请在设置 → 集成中完成。'],
  alipay_not_configured:  ['Alipay is not set up yet — finish it in Settings → Integrations.', '支付宝尚未配置,请在设置 → 集成中完成。'],
  aliyun_sms_not_configured: ['Text messaging is not set up yet.', '短信服务尚未配置。'],
  nuonuo_not_configured:  ['Invoicing is not set up yet.', '开票服务尚未配置。'],
  jd_not_configured:      ['JD Logistics is not set up yet — finish it in Settings → Delivery.', '京东物流尚未配置,请在设置 → 配送中完成。'],
  kd100_not_configured:   ['Tracking is not set up yet.', '物流查询尚未配置。'],
  ai_not_configured:      ['The writing assistant is not set up yet.', 'AI 助手尚未配置。'],
  maps_key_missing:       ['Maps are not set up yet, so addresses cannot be located.', '地图服务尚未配置,无法定位地址。'],
  email_unconfigured:     ['Email sending is not set up yet.', '邮件发送尚未配置。'],
  no_access_token:        ['The connection to that service has expired — reconnect it in Settings → Integrations.', '与该服务的连接已过期,请在设置 → 集成中重新连接。'],

  // ── The system itself ──
  db_insert_failed:       ['That could not be saved. Try again; if it keeps happening, tell support.', '保存失败,请重试;如反复出现请联系客服。'],
  save_failed:            ['That could not be saved. Try again; if it keeps happening, tell support.', '保存失败,请重试;如反复出现请联系客服。'],
  update_failed:          ['That could not be saved. Try again; if it keeps happening, tell support.', '保存失败,请重试;如反复出现请联系客服。'],
  read_failed:            ['That could not be loaded. Try again.', '加载失败,请重试。'],
  lookup_failed:          ['That could not be looked up. Try again.', '查询失败,请重试。'],
  bad_response:           ['The server sent something this page could not read. Reload and try again.', '服务器返回了无法识别的内容,请刷新后重试。'],
  non_json_response:      ['The server sent something this page could not read. Reload and try again.', '服务器返回了无法识别的内容,请刷新后重试。'],
  request_failed:         ['That did not go through. Try again.', '请求未成功,请重试。'],
  timeout:                ['That took too long and was stopped. Try again.', '请求超时已中止,请重试。'],
  row_moved:              ['Somebody else changed this while you had it open — reload and try again.', '该记录已被他人修改,请刷新后重试。'],
  /* §117 part two — the two refusals the Channel sync page's own writes can
     give. BOTH ARE THE SAME FACT FROM THE OPERATOR'S SIDE: the mapping was
     removed, or its switch was turned off, since this page was painted. That
     is row_moved, so they carry row_moved's sentence verbatim rather than two
     new ones saying it again in different words. */
  not_mapped:             ['Somebody else changed this while you had it open — reload and try again.', '该记录已被他人修改,请刷新后重试。'],
  not_syncing:            ['Somebody else changed this while you had it open — reload and try again.', '该记录已被他人修改,请刷新后重试。'],
  /* §325 S2j — the server refusing to switch on an Eleme mapping that names no
     listing (lib/channel-sync-write.js). The Eleme panel's own sentence for the
     same refusal (14-eleme.js, the switch's title), copied whole. */
  no_listing_name:        ['Sync cannot be switched on until this mapping names an Eleme listing.', '未选择饿了么商品名前无法开启同步。'],
  cycle:                  ['That would make something contain itself.', '该操作会造成循环引用。'],
  /* §174 — the two line-level refusals the kitchen's ask can give a buyer. BOTH
     ARE STALE-SCREEN FACTS: the row was acted on by somebody else, or in
     another tab, since this box was painted. They are not row_moved's sentence,
     because reloading is not the remedy — the line is settled either way, and
     the operator needs to know WHICH way before they go looking for it. */
  already_sourced:        ['That line is already on a purchase order.', '该行已在采购单上。'],
  line_declined:          ['That line was removed and is no longer being bought.', '该行已移除，不再采购。'],
};

/* The sentence to SHOW for a failure. `code` is the server's stable error code;
   `serverMessage` is its own human text when it sent one, which always wins —
   it knows which SKU, whose product, how many are left. */
function tdErrorText(code, serverMessage) {
  if (serverMessage && String(serverMessage).trim()) return String(serverMessage).trim();
  const entry = TD_ERR[code];
  if (entry) return (typeof cuT === 'function') ? cuT(entry[0], entry[1]) : entry[0];
  // Last resort: the code, in words. Not a sentence, but readable — and a code
  // added tomorrow reads as words on the day it ships.
  const words = String(code || '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  // GET requests carry a hard time limit (opts.timeoutMs, default 20s) so a
  // stalled fetch can't pin a card on "Loading…" forever — it fails, and the
  // caller's retry / next poll takes over. Writes are exempt: aborting a POST
  // mid-flight would report "failed" for a mutation that may have landed.
  const method = (opts.method || 'GET').toUpperCase();
  let abortTimer = null;
  if (!opts.signal && method === 'GET' && typeof AbortController !== 'undefined') {
    const ac = new AbortController();
    opts.signal = ac.signal;
    abortTimer = setTimeout(() => ac.abort(), opts.timeoutMs || 20000);
  }
  let r;
  try {
    r = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const t = new Error(tdErrorText('timeout'));
      t.code = 'timeout';
      throw t;
    }
    throw e;
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
  if (r.status === 401) { location.href = '/backend/login'; throw new Error('401'); }
  const j = await r.json().catch(() => ({ success: false, error: 'bad_response', status: r.status }));
  if (!j.success) {
    // Surface a LOGICAL reason, never a bare "failed". Servers send a stable
    // `error` code (e.g. `use_refund_payout`) and often a human `message`. We
    // build "<human message> [<code>]" so an operator reads why it failed AND
    // gets the exact code to quote in support. When the server gave only a code
    // (no message), `err.message` stays equal to that code — so existing
    // `e.code === '…'` / legacy `e.message === '…'` branches keep matching.
    const code = j.error || ('request_failed (' + r.status + ')');
    // WHAT THE MERCHANT READS (audit A-09). This used to be the bare code when
    // the server sent no message, and 195 toast sites showed it: "not_found",
    // "db_insert_failed", "kitchen_add_only", to a shopkeeper. tdErrorText
    // turns it into a sentence, or at worst into words.
    //
    // 🔴 THE OLD NOTE HERE SAID `err.message` STAYS EQUAL TO THE CODE so legacy
    // `e.message === '…'` branches keep matching. That is no longer true, and
    // the five branches in the admin that relied on it were converted to
    // `e.code` in the same commit — which is what they should always have
    // compared. `err.code` is unchanged and is the thing to test against.
    const err = new Error(tdErrorText(code, j.message));
    err.code = j.error || ('http_' + r.status);  // raw code for programmatic checks
    err.rawMessage = j.message || null;          // the server's own words, unwrapped
    err.data = j;            // carry server detail (e.g. sku_taken `conflict`) to callers
    err.status = r.status;
    throw err;
  }
  return j;
}
// Turn a sku_taken error into a human sentence that NAMES the product holding
// the SKU — including when that product is archived/hidden, which is why the
// operator couldn't find it by searching the grid. Falls back gracefully when
// the server didn't attach a `conflict`.
function skuTakenMsg(skuVal, conflict, sizeLabel) {
  const sku = (skuVal || '').toString().trim();
  const skuTxt = sku ? cuT('SKU “', '货号“') + sku + '”' : cuT('That SKU', '该货号');
  const where = sizeLabel ? cuT(' (size “', '(规格“') + sizeLabel + '”)' : '';
  if (conflict) {
    const nm = cuT(conflict.name_en || conflict.name_cn || ('#' + conflict.id),
                   conflict.name_cn || conflict.name_en || ('#' + conflict.id));
    const vlabel = conflict.variant_label ? ' · ' + conflict.variant_label : '';
    const hidden = Number(conflict.is_active) === 0
      ? cuT(' — that product is archived/deleted, so it won’t show in the list. Restore it or change its SKU to free this code.',
            ' — 该商品已归档/删除,因此不会显示在列表中。请恢复它或修改其货号以释放该编号。')
      : (Number(conflict.is_published) === 0
          ? cuT(' (hidden product — use the “Hidden” filter to find it)', '(已隐藏的商品 — 用“隐藏”筛选查看)')
          : '');
    return skuTxt + where + cuT(' is already used by ', ' 已被 ') + '“' + nm + vlabel + '”' + hidden;
  }
  return skuTxt + where + cuT(' is already in use', ' 已被占用');
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

/* ── §103 step 5 · ONE VOCABULARY FOR CHANNEL SYNC STATE ─────────────────────
   Four words and a handful of named causes, shared by every surface that says
   whether a product is in step with a channel: the Meituan tab, the Eleme tab,
   the GZ Grocery tab, the Channel sync page, the Products list's dots and the
   product editor's Channels card.

   IT LIVES HERE, IN THE CORE, BECAUSE SIX FILES ASK IT. The three channel tabs
   were written months apart and each minted its own phrases — eighteen between
   them for what is really four situations, with two of them wording the SAME
   state differently ("Name not in catalogue" on Meituan, "Listing not found" on
   Eleme) and GZ Grocery carrying no vocabulary at all. A table in any one of
   those files would just have made that file the odd one out.

   THE CAUSE WINS OVER THE STATE WHERE THERE IS ONE. "Listing not found" tells an
   operator what to do; "Needs attention" only tells them to look. The state's own
   word is the fallback, and the dot's colour carries the state either way.

   `unk` HAD NO CHINESE HALF, and said so on purpose: it was the placeholder the
   Meituan and Eleme tabs already carry (MT_PENDING_CN / EL_PENDING_CN), held
   English on both sides while Ash sourced the Chinese. CLAUDE.md's 2026-09-06
   amendment repealed that default — the Chinese is delegated now — and the word
   was reaching every Chinese reader in English on three surfaces meanwhile: this
   table, the phone's csWord, and the Products page's channel dots.
   `尚未读取商品` is NOT minted for it. It is this page's own live sentence for
   exactly this condition — 29-channel-sync.js's store line, where a store whose
   catalogue has never been read already reads `尚未读取商品` — which is the one
   fact `unk` states. Recorded in docs/tacet-delivery-vocabulary.md with the
   candidates rejected. The two PENDING_CN sets are untouched and still English;
   they are a larger block, and this is the verdict word only. */
const CH_STATE_WORD = {
  ok:   ['Synced', '已同步'],
  att:  ['Needs attention', '待处理'],
  off:  ['Sync off', '已关闭'],
  none: ['Not listed', '未上架'],
  unk:  ['Name not checked', '尚未读取商品'],
};
const CH_REASON_WORD = {
  name_not_found:      ['Listing not found', '找不到该商品'],
  no_option:           ['No option picked', '未选规格'],
  store_not_connected: ['Store not connected', '门店未关联'],
  linked_by_sku:       ['Linked by SKU', '按货号关联'],
  sending:             ['Sending…', '发送中…'],
};
function chStateWord(k) { const p = CH_STATE_WORD[k] || CH_STATE_WORD.none; return cuT(p[0], p[1]); }
/* `no_name` is the one cause that genuinely differs by channel, so it is asked
   of the channel rather than flattened: on Meituan 外卖 a missing name is WORK
   the operator does here and stock stays frozen until they do it; on Eleme the
   mapping exists and pushes anyway, against the product's own name, which is a
   live wrong-target risk rather than an unfinished form. Same state, two jobs. */
function chWord(ch, k, reason) {
  if (reason === 'no_name') {
    return ch === 'meituan' ? cuT('Add name', '待填名称') : cuT('No listing name', '缺商品名');
  }
  const p = CH_REASON_WORD[reason];
  return p ? cuT(p[0], p[1]) : chStateWord(k);
}
/* ── §105 · WHY A PUSH FAILED, in words an operator can act on ────────────────
   lib/channel-push-reason.js turns a queue row's raw `last_error` into a stable
   code; this is the sentence for each code. The split is deliberate: the raw
   text is written in English by the browser layer and some of it is the
   PLATFORM's own Chinese, so wording it server-side would mean either shipping
   English to a Chinese operator or inventing Chinese for Meituan's own words.

   NOTHING HERE IS COMPOSED. `无法连接同步服务` is live whole on the Meituan tab,
   `已退出登录` and `重新登录` on both channel tabs, `找不到该商品` on the Eleme
   tab, `尚未读取商品` on the Eleme store line, `多次重试仍失败` in both daemons'
   own logs, and `{platform}返回：` is the shape WeChat's own error already uses
   (`微信支付未通过校验。微信返回：`) for exactly this job — showing a platform's
   sentence about its own refusal. Two arrangements of those fragments, declared
   in docs/tacet-delivery-vocabulary.md.

   A code of null returns '' and the caller shows the raw text instead. An
   uncategorised failure is the one most worth reading. */
function chCauseSentence(channel, code, detail) {
  const ch = (typeof csChannelName === 'function' && csChannelName(channel)) || channel;
  switch (code) {
    case 'rejected':
      // The platform's own words, verbatim, labelled with whose they are.
      return cuT(`${ch} returned: ${detail || ''}`.trim(), `${ch}返回：${detail || ''}`.trim());
    case 'http':
      return cuT(`Cannot reach the sync service (HTTP ${detail}).`, `无法连接同步服务（HTTP ${detail}）。`);
    case 'unreachable':
      return cuT('Cannot reach the sync service.', '无法连接同步服务。');
    case 'signed_out':
      return cuT(`The sync service is signed out of ${ch}. Sign in again.`, `同步服务已退出登录${ch}。请重新登录。`);
    case 'option_gone':
      return cuT('The option this product is mapped to is no longer on the listing. Pick it again.',
                 '找不到该规格，请重新选择。');
    case 'name_not_found':
      return cuT('Listing not found.', '找不到该商品。');
    case 'unreadable':
      return cuT('The listing could not be read.', '尚未读取商品。');
    case 'gave_up':
      // What every failure used to say. It survives for rows written before §105
      // and for a path that genuinely has nothing to add.
      return cuT('Tried several times and gave up.', '多次重试仍失败。');
    default:
      return '';
  }
}
/* The line a surface shows under "the last push failed": the worded cause where
   we have one, the channel's raw sentence where we do not, and the raw text as
   well when it carries something the sentence does not (the platform's own
   message is already IN the sentence, so it is not repeated). */
function chCauseLine(channel, cell) {
  if (!cell) return '';
  const said = chCauseSentence(channel, cell.error_code, cell.error_detail);
  if (said) return said + (cell.retrying ? ' ' + cuT('Retrying.', '重试中。') : '');
  return cell.error ? cuT('Push failed', '推送失败') + ': ' + cell.error : '';
}
/* ── §106 · WHAT IS STOPPING THE WHOLE CHANNEL ───────────────────────────────
   lib/channel-block.js resolves the live blocking cause per store from the
   daemons' own log; this is the sentence for each event type. Every Chinese
   fragment is live: `验证中心风控，同步已暂停，需要人工验证` is the Meituan
   daemon's OWN merchant alert, verbatim; `已退出登录` and `重新登录` are on both
   channel tabs; `无法连接同步服务` on the Meituan tab; `同步已停` is the Eleme
   tab's own fallback for a store that is not syncing.

   This is a CHANNEL fact, so it belongs on the channel's card once — never
   repeated down forty item rows (§103's founding rule). An item whose own
   failure is one of the generic ones defers to it instead of guessing. */
function chBlockSentence(channel, by) {
  const ch = (typeof csChannelName === 'function' && csChannelName(channel)) || channel;
  switch (by) {
    case 'verify_required':
      return cuT(`${ch} is asking for a captcha — a human has to pass it on the sync machine. Sync is paused.`,
                 '验证中心风控，同步已暂停，需要人工验证。');
    case 'needs_login':
    case 'auth_required':          // Eleme's name for the same thing
    case 'binding_lost':           // Meituan: signed in, shop forgotten — same re-login fixes it
      return cuT(`The sync service is signed out of ${ch}. Sign in again.`, `同步服务已退出登录${ch}。请重新登录。`);
    case 'proxy_down':
    case 'proxy_stale':
      return cuT(`Cannot reach the sync service. Sync is paused.`, '无法连接同步服务。同步已暂停。');
    case 'queue_stalled':
    case 'sync_stalled':
      return cuT('Stock updates stopped going out.', '同步已停。');
    default: return '';
  }
}
/* An item's own cause, unless the CHANNEL is blocked and the item's failure is
   one of the generic ones that the block explains better. A captcha on 天河 is
   why this push could not reach Meituan; saying "cannot reach the sync service"
   beside it is the same fact, worse told. */
const CH_GENERIC_CAUSES = ['unreachable', 'http', 'signed_out', 'gave_up', null];
function chCauseFor(channel, cell, channelBlock) {
  if (channelBlock && channelBlock.by && CH_GENERIC_CAUSES.indexOf((cell && cell.error_code) || null) !== -1) {
    const said = chBlockSentence(channel, channelBlock.by);
    if (said) return said;
  }
  return chCauseLine(channel, cell);
}
/* §252 — the causes a person at a login window can clear: a signed-out session
   (each channel's own name for it), a forgotten shop binding, a captcha. A
   proxy or a stalled queue is not fixed by signing in, so it gets no button. */
const CH_SIGNIN_CAUSES = ['needs_login', 'auth_required', 'binding_lost', 'verify_required'];
function chSignInable(by) { return CH_SIGNIN_CAUSES.indexOf(by) !== -1; }
/* The short state a stopped channel's HEADLINE says, when its cause is one a
   person can name: signed out (every channel's word for it, and a forgotten
   Meituan shop, whose fix is the same), or a captcha. [en, cn] or null — null
   leaves the headline on "not syncing". Ash, 2026-09-24: both cards read "Not
   syncing since…" and only the small print said Eleme was signed out. */
function chHeadState(by) {
  if (by === 'needs_login' || by === 'auth_required' || by === 'binding_lost') return ['signed out', '已退出登录'];
  if (by === 'verify_required') return ['waiting for a captcha', '需要人工验证'];
  return null;
}
window.chHeadState = chHeadState;
function chSignIn(channel, store, name) {
  const lang = document.documentElement.dataset.uiLang === 'cn' ? 'cn' : 'en';
  const url = '/channel-signin?channel=' + encodeURIComponent(channel) + '&store=' + encodeURIComponent(store) +
    '&name=' + encodeURIComponent(name || store) + '&lang=' + lang;
  window.open(url, 'tacet-signin');
}
/* The button, or nothing: only for a cause signing in can clear, and only for
   someone holding the permission (the server checks again either way). */
function chSignInBtn(channel, store, name, by) {
  if (!store || !chSignInable(by) || (typeof can === 'function' && !can('integrations:signin'))) return '';
  // Secondary, not primary: a filled button is the design system's one Dusk
  // CTA per screen, and this is a person's action on a warning card.
  return '<button type="button" class="btn btn-sm td-secondary" onclick="event.stopPropagation();chSignIn(' +
    [channel, store, name || store].map(v => "'" + String(v).replace(/[^A-Za-z0-9_\-\u3400-\u9fff ]/g, '') + "'").join(',') +
    ')">' + escapeHtml(cuT('Sign in again', '重新登录')) + '</button>';
}
window.chSignInable = chSignInable;
window.chSignIn = chSignIn;
window.chSignInBtn = chSignInBtn;
window.chBlockSentence = chBlockSentence;
window.chCauseFor = chCauseFor;
window.chCauseSentence = chCauseSentence;
window.chCauseLine = chCauseLine;
window.chStateWord = chStateWord;
window.chWord = chWord;

/* ── §103 addendum · THE TABS LEARN WHETHER THE PUSH LANDED ──────────────────
   The three channel tabs classify locally — is there a mapping, does the name
   match a listing, is an option claimed, is the switch on — and every one of
   those questions is about the SHAPE of the mapping. None of them asks the only
   question a customer can feel: did the last push actually land.

   So a tab could show a green dot and the word Synced for a product the Channel
   sync page correctly called "Needs attention · the last push failed". That is
   §103's founding example, unchanged by §103 itself: Harissa Chilli Paste read
   Synced on the Meituan tab for 75 days while Meituan held 18 against a shelf
   of 3.

   THE OVERLAY IS DELIBERATELY THE NARROWEST THING THAT CLOSES IT. The server
   runs every check the tabs run AND the push result, and it tests the mapping's
   shape FIRST — no map, sync off, catalogue unread and a bad name all return
   before it ever looks at the queue. So the only state where the two can
   disagree is: the tab says ok, the server says att. That is the whole gap, and
   this only ever applies in that one direction:

     • it can turn a green dot amber, never the reverse;
     • it never touches a row the tab already calls att — the operator is on
       that screen fixing the cause the tab named, and replacing their cause
       with another would be a worse screen, not a better one;
     • a failed fetch leaves every tab exactly as it was.

   Per STORE, not per product: Meituan has two and a folded verdict would mark
   the wrong one's dot, which is why the tabs ask for ?channel= (full per-store
   detail) rather than the compact projection the Products dots use. */
const CH_VERDICT_TTL_MS = 60_000;
const _chVerdicts = {};        // channel -> { at, byProduct: { id: { k, reason, stores } } }
const _chVerdictWait = {};     // channel -> in-flight promise, so three renders share one fetch

function chLoadVerdicts(channel, force) {
  const held = _chVerdicts[channel];
  if (!force && held && (Date.now() - held.at) < CH_VERDICT_TTL_MS) return Promise.resolve(held);
  if (_chVerdictWait[channel]) return _chVerdictWait[channel];
  const p = (async () => {
    try {
      const r = await fetch('/api/retail-admin/channel-sync?channel=' + encodeURIComponent(channel),
        { credentials: 'same-origin' });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'load_failed');
      const byProduct = {};
      for (const it of ((j.data && j.data.items) || [])) {
        const cell = (it.channels || {})[channel];
        if (cell) byProduct[it.id] = cell;
      }
      _chVerdicts[channel] = { at: Date.now(), byProduct };
    } catch (e) {
      // Never a reason to break the tab. Keep whatever we last had; if that is
      // nothing, the tab simply classifies the way it did before this existed.
      console.warn('[channel-sync verdicts]', channel, e.message);
    } finally { _chVerdictWait[channel] = null; }
    return _chVerdicts[channel] || null;
  })();
  _chVerdictWait[channel] = p;
  return p;
}

/* The server's verdict for one (product, store), or the folded one when no
   store is named. Returns null when nothing has been read yet. */
function chVerdict(channel, productId, storeCode) {
  const held = _chVerdicts[channel];
  if (!held) return null;
  const cell = held.byProduct[productId];
  if (!cell) return null;
  if (!storeCode) return { k: cell.k, reason: cell.reason };
  const st = (cell.stores || []).find(x => x.code === storeCode);
  return st ? { k: st.k, reason: st.reason } : null;
}

/* Apply it. `local` is the tab's own {k, reason, t, …}; anything but a plain
   `ok` comes back untouched. */
function chApplyVerdict(channel, productId, storeCode, local) {
  if (!local || local.k !== 'ok') return local;
  const v = chVerdict(channel, productId, storeCode);
  if (!v || v.k !== 'att') return local;
  return { ...local, k: 'att', reason: v.reason, t: chWord(channel, 'att', v.reason), fromPush: true };
}
window.chLoadVerdicts = chLoadVerdicts;
window.chVerdict = chVerdict;
window.chApplyVerdict = chApplyVerdict;
function thumbUrl(p) { return p?.image_url || p?.image_data || ''; }
function fmt(n) { return Number(n || 0).toFixed(2); }

// ── Version history (decisions §279) ─────────────────────────────────────────
// ONE dialog for every screen that saves itself (public/tacet-autosave.js), so
// the role screen, the customer record and each screen converted after them
// show their history the same way. What is on screen is sent first, so the
// list ends on it rather than a step behind. `sub(v)` says what that version
// changed, in the screen's own words. Resolves the version the operator chose
// to restore — after asking — or null.
function autosaveVersionTop(v) {
  const head = v.isBaseline ? cuT('Original', '原始版本')
    : v.note === 'undo' ? cuT('Undo', '撤销')
    : v.note === 'restore' ? cuT('Restore', '还原') : '';
  return [head, tdWhen(v.at, 'dateTime'), v.by || ''].filter(Boolean).join(' · ');
}
async function autosavePickVersion(auto, url, sub) {
  if (auto) await auto.flush();
  let list;
  try {
    const j = await api(url);
    list = Array.isArray(j && j.versions) ? j.versions : [];
  } catch (e) { toast(cuT('Could not load the history', '无法加载历史版本'), 'err'); return null; }
  if (!list.length) { toast(cuT('No versions yet — they’re saved automatically as you edit.', '暂无历史版本 — 编辑时会自动保存。')); return null; }
  const rows = list.map((v, i) => {
    const what = sub ? sub(v) : '';
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border-subtle,rgba(0,0,0,.08))">`
      + `<div style="flex:1;min-width:0"><div>${escapeHtml(autosaveVersionTop(v))}`
      + (i === 0 ? ` <span class="muted">· ${escapeHtml(cuT('Current', '当前'))}</span>` : '') + `</div>`
      + (what ? `<div class="muted" style="font-size:12.5px;margin-top:2px">${escapeHtml(what)}</div>` : '') + `</div>`
      + (i === 0 ? '' : `<button type="button" class="btn btn-sm" data-restore="${v.id}">${escapeHtml(cuT('Restore', '还原'))}</button>`)
      + `</div>`;
  }).join('');
  const bodyHtml = `<h3 class="tdlg-title">${escapeHtml(cuT('Version history', '历史版本'))}</h3>`
    + `<div style="max-height:60vh;overflow:auto">${rows}</div>`;
  const footHtml = `<button type="button" class="tdlg-btn tdlg-btn--ghost" data-cancel>${escapeHtml(cuT('Close', '关闭'))}</button>`;
  const { scrim, closer, ready } = askCustom('tdlg-neutral', bodyHtml, footHtml, '[data-restore], [data-cancel]');
  scrim.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => closer(null)));
  scrim.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => closer(b.getAttribute('data-restore'))));
  const picked = await ready;
  const v = picked ? list.find(x => String(x.id) === String(picked)) : null;
  if (!v) return null;
  if (!(await askConfirm({ titleEn: 'Restore this version?', titleCn: '还原此版本?', confirmEn: 'Restore', confirmCn: '还原' }))) return null;
  return v;
}
// Every autosaving screen closing the tab mid-pause is the one way to lose an
// edit; the browser's own question stands in for the Save buttons that are
// gone, and switching away sends the pending edit — the recipe record's rule.
// A screen registers its engine getter here once.
const AUTOSAVE_ENGINES = [];
function autosaveRegister(getEngine) { AUTOSAVE_ENGINES.push(getEngine); }
window.addEventListener('beforeunload', (e) => {
  if (AUTOSAVE_ENGINES.some(g => { const a = g(); return a && a.busy(); })) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  AUTOSAVE_ENGINES.forEach(g => { const a = g(); if (a && a.busy()) a.flush(); });
});

// ── A settings card that saves itself (decisions §279) ───────────────────────
// For the cards that write a handful of shop-settings keys through
// PUT /api/retail-admin/config. The card's Save button is replaced by a foot
// (<div data-as-foot="CARD">) showing the status, Undo and Version history; the
// history is kept per card on the server (`?history=CARD`).
//
//   const c = autosaveCard({
//     card:  'delivery.holiday',             // the history key; one per card
//     root:  element holding the fields      // input/change inside it = an edit
//     read:  () => ({ 'key.a': …, 'key.b': … }),   // fixed key order
//     apply: (body) => { …put body back into the fields… },  // Undo / restore
//     hold:  (body) => '' | 'why not yet',   // optional
//     after: (body) => { … },                // optional, once a save lands
//     url, method:                           // optional — a card whose route is
//                                            // its own (default PUT /config);
//                                            // the route must pass ?history on
//     historyUrl:                            // optional — where the card's versions
//                                            // are read (default /config/history)
//     sub: (version) => 'what changed',      // optional — the history row's 2nd line
//     foot:                                  // optional — the data-as-foot name, when
//                                            // `card` is a function
//     beforeSend: (body) => body,            // optional — stamp what is SENT without
//                                            // it counting as a change (a timestamp)
//     fromSnapshot: (stored) => body,        // optional — when the route stores
//                                            // a different shape than it is sent,
//                                            // how a restored version becomes a body
//   });
//   …then, ONCE THE FIELDS HAVE BEEN FILLED FROM THE SERVER, c.start().
//
// NOTHING IS SENT BEFORE start(). A card whose load failed shows empty boxes,
// and a card that saved on the first keystroke over empty boxes would write
// those blanks over the real settings — the shape of the §144 race that cost
// 43 paid lines. A text box saves on the pause; a number, a date, a select, a
// switch, or any field marked data-as-commit saves when it is left or flipped,
// so a half-typed number is never sent.
function autosaveCard(o) {
  const card = { engine: null };
  // card, url and historyUrl may be functions, for ONE drawer reused for many
  // records (the photo drawer, the pop-up editor): each is asked at the moment
  // it is needed, so a flush on the way to the next record still names this one.
  const val = (x) => (typeof x === 'function' ? x() : x);
  const foot = () => document.querySelector('[data-as-foot="' + (o.foot || val(o.card)) + '"]');
  const paint = () => {
    const el = foot(); if (!el) return;
    const a = card.engine, st = a ? a.state : 'saved';
    if (!el._built) {
      el._built = true;
      el.classList.add('as-foot');
      el.innerHTML = `<span class="muted as-stat"></span>`
        + `<button type="button" class="btn btn-sm as-undo" hidden>${escapeHtml(cuT('Undo', '撤销'))}</button>`
        + `<button type="button" class="btn btn-sm as-hist">${escapeHtml(cuT('Version history', '历史版本'))}</button>`;
      el.querySelector('.as-undo').addEventListener('click', () => card.undo());
      el.querySelector('.as-hist').addEventListener('click', () => card.history());
    }
    const stat = el.querySelector('.as-stat');
    stat.textContent = !a ? ''
      : st === 'saving' || st === 'pending' ? cuT('Saving…', '保存中…')
      : st === 'hold' ? a.message
      : st === 'error' ? cuT('Save failed: ', '保存失败:') + (a.message || '')
      : cuT('All changes saved', '已自动保存');
    stat.classList.toggle('is-bad', st === 'error');
    stat.classList.toggle('is-held', st === 'hold');
    el.querySelector('.as-undo').hidden = !(a && a.canUndo());
  };
  const commits = (t) => t.matches('input[type="number"], input[type="date"], input[type="time"], input[type="checkbox"], input[type="radio"], select, [data-as-commit]');
  const root = typeof o.root === 'string' ? document.querySelector(o.root) : o.root;
  if (root && !root._asWired) {
    root._asWired = true;
    // Deferred to a microtask: a page's own handler may write the edit into its
    // state further up the bubble (the social-proof rows listen on document),
    // and the engine must read the page after that, not before.
    const later = () => queueMicrotask(() => { if (card.engine) card.engine.touch(); });
    root.addEventListener('input', (e) => { if (!commits(e.target)) later(); });
    root.addEventListener('change', (e) => { if (commits(e.target)) later(); });
  }
  card.start = () => {
    if (typeof TacetAutosave === 'undefined') return;
    if (card.engine) card.engine.stop();
    card.engine = TacetAutosave.create({
      read: o.read,
      hold: o.hold,
      send: (body, note) => api((val(o.url) || '/api/retail-admin/config') + '?history=' + encodeURIComponent(val(o.card)) + (note ? '&note=' + note : ''),
        { method: o.method || 'PUT', body: o.beforeSend ? o.beforeSend(body) : body }).then((j) => { if (o.after) o.after(body, j); }),
      onChange: paint,
    });
    card.engine.start();
    paint();
  };
  // For a page that redraws the foot's element itself (the share-card stage).
  card.paint = paint;
  card.touch = () => { if (card.engine) card.engine.touch(); };
  // The record went (deleted): nothing more may be sent for it.
  card.stop = () => { if (card.engine) card.engine.stop(); card.engine = null; paint(); };
  card.flush = (note) => (card.engine ? card.engine.flush(note) : Promise.resolve());
  card.undo = () => { if (card.engine) card.engine.undo((b) => o.apply(b)); };
  card.history = async () => {
    if (!card.engine) return;
    const v = await autosavePickVersion(card.engine, val(o.historyUrl) || ('/api/retail-admin/config/history?card=' + encodeURIComponent(val(o.card))), o.sub || null);
    if (!v || !card.engine) return;
    o.apply(o.fromSnapshot ? o.fromSnapshot(v.snapshot || {}) : (v.snapshot || {}));
    await card.engine.flush('restore');
    if (card.engine.state === 'saved') toast(cuT('Restored to the chosen version.', '已还原到所选版本。'), 'ok');
  };
  autosaveRegister(() => card.engine);
  return card;
}

// ── Tenant display currency ────────────────────────────────────────────────
// The tenant's currency is a stored setting, not a constant: storefront_config
// key `currency`, normalised server-side by routes/retail.js normalizeCurrency()
// to { code, symbol, decimals, position } and edited under Settings by
// renderCurrencyControl() (05-marketing.js). It already reached the mini app and
// the storefront; the cost and margin screens did not read it and printed a
// hardcoded '¥' with a hardcoded 2dp, so a tenant who selected $ or ฿ was told
// their costs and margins in yuan.
//
// DEFAULTS ARE THE SERVER'S, FIELD FOR FIELD. A tenant that never touched the
// setting formats exactly as before — ¥, 2dp, symbol first.
const CURRENCY_FALLBACK = Object.freeze({ code: 'CNY', symbol: '¥', decimals: 2, position: 'before' });
function acCurrency() {
  let raw = null;
  // _cfgCache is declared with `let` in a LATER part file, so a call made
  // before that file has run would hit the temporal dead zone — `typeof` does
  // not save you from a TDZ ReferenceError. Guarded rather than assumed, so a
  // screen that paints early falls back to the default instead of throwing.
  try { raw = (_cfgCache && typeof _cfgCache === 'object') ? _cfgCache.currency : null; } catch (e) { raw = null; }
  const c = (raw && typeof raw === 'object') ? raw : {};
  return {
    code:     typeof c.code === 'string' && c.code.trim() ? c.code.trim().toUpperCase().slice(0, 3) : CURRENCY_FALLBACK.code,
    symbol:   typeof c.symbol === 'string' && c.symbol.trim() ? c.symbol.trim().slice(0, 4) : CURRENCY_FALLBACK.symbol,
    decimals: Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 3 ? c.decimals : CURRENCY_FALLBACK.decimals,
    position: c.position === 'after' ? 'after' : 'before',
  };
}
// Just the symbol — for the input adornments that sit beside a number field
// rather than formatting one.
function acCurrencySymbol() { return acCurrency().symbol; }
// Put the tenant's symbol on an ALREADY-FORMATTED number, on the correct side.
//
// acMoney() formats the number too, with toFixed and no thousands separator.
// That is right for a price field and wrong for the Dashboard's "¥1,240", for
// a rounded chart axis, or for a range like "20–50" — screens that do their own
// number formatting and only ever needed the symbol placed. Before this they
// each wrote '¥' + theirOwnFormat(n), which is why a tenant selling in dollars
// was shown dollars on eight screens and yuan on the rest (audit D-03).
//
// Takes a STRING because that is the point: the caller has already decided how
// the digits look, and this must not second-guess it.
function acWrap(formatted) {
  const c = acCurrency();
  return c.position === 'after' ? String(formatted) + c.symbol : c.symbol + String(formatted);
}
// Format an amount in the tenant's display currency. `dp` overrides the
// currency's own decimal places, for the sub-cent per-unit figures on the
// Recipes screen; everything else takes the tenant's setting.
//
// THOUSANDS ARE GROUPED (audit A-08). This was toFixed() alone, so an exact
// amount came out "¥12345.60" while every screen that had written its own
// formatter grouped it — the same number in two shapes on one page. Grouping
// here is what lets those local formatters go away.
//
// Grouped as en-US ("1,234.56") DELIBERATELY, not by the viewer's locale: a
// browser set to de-DE renders toLocaleString() as "1.234,56", which on a page
// whose other amounts use a dot for the decimal is not a different style, it is
// a different number. The admin is bilingual EN/CN and both read this shape.
function acMoney(n, dp) {
  const c = acCurrency();
  const places = Number.isInteger(dp) ? dp : c.decimals;
  const s = Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: places, maximumFractionDigits: places,
  });
  return c.position === 'after' ? s + c.symbol : c.symbol + s;
}
// The same money, rounded to whole units — for KPI tiles and chart axes ONLY,
// where the figure is a headline at 28px and the decimals are noise.
//
// It exists so that "rounded" is a stated, shared decision rather than three
// screens each having quietly picked zero (audit A-08: a day's takings read
// ¥1,235 on one card and ¥1,234.60 on another, and both were "right"). Anywhere
// an operator might reconcile the number against something — a list, a total, a
// dialog, an export — uses acMoney and shows the real amount.
function acMoneyCompact(n) { return acMoney(n, 0); }

/* ── "This list is not all of it" (audit J-01) ──────────────────────────────
   Six list endpoints grew without bound — every material, every supplier, every
   recipe, every supplier invoice, every ledger row, every product × location.
   They now carry a row ceiling and report { total, limit, truncated }.

   The ceilings are set far above any real tenant, so for every merchant today
   this draws nothing at all. It exists for the one who eventually crosses it:
   the difference between a screen that quietly shows a fraction and one that
   says which fraction, and how to see the rest, is the difference between a
   wrong decision and an inconvenience.

   Mounts itself immediately before the list's own container, so no screen needs
   markup added for it. Call it on every load — including the loads that are NOT
   truncated, which is what takes the banner away again. */
function tdShowTruncation(containerSel, resp, whatEn, whatCn) {
  const host = typeof containerSel === 'string' ? document.querySelector(containerSel) : containerSel;
  if (!host || !host.parentNode) return;
  const id = 'td-trunc-' + (host.id || Math.abs(String(containerSel).split('').reduce((a, c) => a + c.charCodeAt(0), 0)));
  let bar = document.getElementById(id);
  if (!resp || !resp.truncated) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = id;
    bar.className = 'td-trunc';
    host.parentNode.insertBefore(bar, host);
  }
  const shown = Number(resp.limit) || 0;
  const total = Number(resp.total) || 0;
  const fmtN = n => Number(n).toLocaleString();
  bar.textContent = cuT(
    `Showing the first ${fmtN(shown)} of ${fmtN(total)} ${whatEn}. Search or filter to reach the rest.`,
    `仅显示前 ${fmtN(shown)} 条,共 ${fmtN(total)} ${whatCn}。请用搜索或筛选查看其余。`);
}

// ── Per-user capabilities (RBAC) — client mirror of the server's req.caps ──
// One operator's effective capability set decides what this app draws: hide the
// nav sections and action buttons they can't use. This is the "same app,
// different view" mechanism (e.g. Quick Stock add-vs-recount), driven by what
// the admin granted rather than hardcoded per role.
//
// What's live vs. what's dark — do NOT read this as "caps do nothing yet":
//   • LIVE: /api/backend/me ships a REAL, per-operator, differentiated cap array
//     (lib/operator-caps → lib/capabilities.resolveCaps). Only `owner` resolves
//     to ALL keys; every other role — warehouse, dispatch, customer_service,
//     store_manager, staff … — resolves to its narrowed preset. setCaps() stores
//     it and applyCapGates() USES it now to hide nav sections + [data-cap] controls.
//   • DARK: only server-side ENFORCEMENT (routes 403-ing on req.caps) is gated,
//     behind tenant.rbac_enforce. The view gates; the server doesn't reject yet.
// (An older note here claimed "everyone resolves to the FULL set, nothing hides."
//  That was wrong and nearly cost a design — the differentiation is real.)
// Fail-OPEN: caps is null only on a resolution hiccup or a stale session, and
// null ⇒ all allowed. Fine for hiding actionable controls; do NOT gate anything
// that leaks money/PII on caps alone without a reliable fallback (see the
// dashboard's money-card presence, which stays on the role-string body.pos-* CSS).
let CAPS = null;                                    // null = unknown ⇒ all allowed (fail-open)
function can(key)     { return CAPS === null ? true : CAPS.has(key); }
function canAny(keys) { return CAPS === null ? true : keys.some(k => CAPS.has(k)); }
function _capAllows(v){ return Array.isArray(v) ? canAny(v) : can(v); }
function setCaps(list){ CAPS = Array.isArray(list) ? new Set(list) : null;
  try { applyCapGates(); } catch (e) {}
  // Second, and only ever once: the gate above can have just taken away the
  // row that leads back to the section the shell booted showing.
  try { landOnSomethingReachable(); } catch (e) {
    /* Landing is a courtesy, and it must never be what stops an operator's caps
       from being applied: applyCapGates has already run above, so a throw here
       (an unbuilt rail, a section this shell doesn't carry) leaves the gates in
       place and the operator on the dashboard — the state that shipped for a
       year — rather than on a page with nothing painted. */
  } }

// Nav section (data-tab / mobile data-go) → the capability that reveals it. An
// array means "any of these". Untracked tabs stay visible. Settings (config) is
// shown if the operator holds any one of its sub-area caps.
//
// These are keyed by data-tab, so a cap follows its BUTTON wherever the button
// sits. That is how `editor:view` moved when the Editor group became the Content
// folder (2026-07-29): the group row lost its data-tab and the new child row
// gained it, so the /cms embed is still gated and no key here had to change. A
// folder row holds no capability of its own — it only inherits the hide-if-empty
// rule in railSyncGroups(). If you ever move a page between rows, move its
// data-tab with it or the page ships ungated.
const TAB_CAP = {
  dashboard: 'dashboard:view', reports: 'reports:view', orders: 'orders:view',
  customers: 'customers:view', products: 'products:view', categories: 'categories:view',
  'mini-app-editor': 'editor:view', vouchers: 'coupons:view', flash: 'flash:view',
  popups: 'popups:view', affiliate: 'affiliate:view', sharing: 'sharing:edit',
  broadcasts: 'broadcasts:view', social: 'social:edit', membership: 'loyalty:view',
  topup: 'topup:edit', leaderboard: 'leaderboard:edit', voting: 'voting:edit',
  snippets: 'content:view', about: 'content:view', legal: 'content:view', faq: 'content:view',
  media: 'media:view', reviews: 'reviews:view', feedback: 'feedback:view',
  meituan: 'meituan:view', guanyi: 'guanyi:view',
  integrations: 'integrations:view', eleme: 'eleme:view',
  // §103 Channel sync is the cross-channel view of the three screens above, so
  // it opens for anyone who may open any one of them — the same any-of rule
  // that admits the Sales page, which is the door to all four.
  'channel-sync': ['meituan:view', 'eleme:view', 'guanyi:view'],
  activity: 'activity:view', purchasing: 'purchasing:view', materials: 'materials:view',
  recipes: 'recipes:view', waste: 'waste:view', finance: 'finance:view',
  // `delivery:view` joins this list because §79 moved the Delivery page into
  // Settings. This table is keyed by data-tab and Delivery no longer has one —
  // its gate is now data-cap="delivery:view" on the #settings-nav button, which
  // applyCapGates enforces. But a gate on the panel is worth nothing if the DOOR
  // refuses: a role holding delivery:view and none of the five settings caps
  // below would have watched its one screen move behind a Settings tab it could
  // not open. The rule §67 states for the rail — a row you can reach is a row you
  // can use — applies to a panel the same way.
  config: ['settings:shop', 'settings:push', 'settings:payments', 'stores:view',
           'shipping:config', 'delivery:view'],
  // ── The two rows the rail left ungated while the phone gated both ──
  // Found from a Stockroom account whose rail showed Sales and Manage team and
  // hid Dashboard and Reports: the mirror image of what its own role is for.
  //
  // TEAM is `team:view` — the key m.html's ROUTE_CAP.team has always named. The
  // row moved here from the avatar menu (2026-07-14) and arrived without a gate,
  // so every operator on every tenant could open the roster: names, roles, and
  // each person's permissions, from a role built to count stock.
  //
  // SALES is any-of, and its list is longer than the phone's for a reason the
  // phone does not have. ROUTE_CAP.sales is `dashboard:view` alone because the
  // phone offers no channel admin at all; on the desktop this page is the ONLY
  // door to the Meituan / Eleme / Guanyi screens, which lost their own rail rows
  // in the Sales redesign (see salesGo). Gated on `dashboard:view` alone it would
  // shut the channel screens away from the very role that holds `meituan:sync` —
  // the role whose own dashboard tells it to go and restart a stalled channel.
  // So the DOOR opens for anyone with a reason to walk through it, and the MONEY
  // on the far side carries its own gate: #sales-summary and every
  // .sales-ch-metrics are tagged data-cap="dashboard:view" in the markup, so a
  // stock role gets the channel cards and their Configure buttons with the
  // revenue, order counts and AOV gone.
  sales: ['dashboard:view', 'meituan:view', 'guanyi:view', 'eleme:view', 'integrations:view'],
  team: 'team:view',
  // `setup` (#setup-nav) is deliberately NOT in this table, though the phone
  // gates it. Its display is OWNED by suRefreshChrome, which writes the same
  // style.display this table's pass does — so the two would fight, and
  // applyCapGates (called from a dozen render paths, every time a screen paints
  // its [data-cap] buttons) would put "Open your store" back in the rail after
  // setup had finished. The row is already absent for everyone once the store is
  // open, which is the case that matters. A narrowed operator on an unfinished
  // tenant still sees it; recorded here rather than closed with a gate that
  // flickers.
};

// Can this operator open this section AT ALL — asked of the table, not of the
// rail. A tab with no rail row of its own (a channel admin, the Product Page
// Editor) is still gated, and a row hidden by the pass below can never disagree
// with the answer given here, because both read TAB_CAP.
function canTab(tab) {
  const cap = TAB_CAP[tab];
  return cap === undefined ? true : _capAllows(cap);
}
window.canTab = canTab;
// Rail folders, recounted after the gates (§2.5 of the drill-down amendment).
// The count is taken AFTER all three gates — capability, feature flag, data
// precondition — so a feat-off child drops out of it: Affiliate and Social proof
// leave Marketing's count when their flags are off. That is why this runs at the
// END of applyCapGates and on every language change, not once at boot.
//
//   0 visible children → the group row is absent entirely. No chevron, no
//                        disabled row, nothing. Silence is a feature.
//   1                  → the folder FLATTENS into a direct button to that child:
//                        the child's label wearing the parent's icon. One click
//                        instead of two, and nothing on screen is untrue — the
//                        operator never learns a folder existed. A folder holding
//                        one item advertises six things they may not have.
//   2+                 → a folder, as designed.
function railSyncGroups() {
  $$('.tabs .tabs-group').forEach(g => {
    const kids = _railChildren(g);
    const trig = _railTrigger(g);
    g.style.display = kids.length ? '' : 'none';
    if (trig) trig.style.display = kids.length ? '' : 'none';
    const flat = kids.length === 1;
    g.classList.toggle('rail-flat', flat);
    const lbl = trig && trig.querySelector('.tabs-flat-label');
    if (lbl) lbl.textContent = flat ? _railRowLabel(kids[0]) : '';
    // A group that just stopped being a folder can't stay the open level.
    if (g.classList.contains('rail-open') && kids.length < 2) railGoRoot();
  });
}
window.railSyncGroups = railSyncGroups;

// Hide nav sections + any [data-cap]-tagged control the operator can't use, then
// recount each rail folder (hide at 0, flatten at 1).
function applyCapGates() {
  document.querySelectorAll('.tabs [data-tab]').forEach(btn => {
    const cap = TAB_CAP[btn.dataset.tab];
    if (cap === undefined) return;
    btn.style.display = _capAllows(cap) ? '' : 'none';
  });
  // Generic hook: tag any button/section with data-cap="x" (or "x y" for any-of)
  // and it disappears for operators without it. Used by section files in later phases.
  document.querySelectorAll('[data-cap]').forEach(el => {
    const v = el.dataset.cap.trim();
    el.style.display = _capAllows(v.includes(' ') ? v.split(/\s+/) : v) ? '' : 'none';
  });
  // The counter till — the one rail row that needs ALL of a pair rather than
  // any of it, so it cannot be written as a data-cap above (that form is
  // canAny). `till:use` opens the screen; `orders:edit` is what cap-routes.js
  // requires of the POST its Confirm makes, and a till offered without it rings
  // up a basket and then refuses to take the money — with a customer standing
  // there. Named here rather than by inventing an all-of attribute syntax that
  // one row in the shell would ever use; Tacet Mobile states the same pair the
  // same way, as the named branch in canRoute().
  const railTill = document.getElementById('rail-till');
  if (railTill) railTill.style.display = (can('till:use') && can('orders:edit')) ? '' : 'none';
  // Last, because it counts what the passes above just hid.
  railSyncGroups();
}
window.can = can; window.canAny = canAny; window.applyCapGates = applyCapGates; window.setCaps = setCaps;

// ── The backend opens on the dashboard, and the dashboard is a board of revenue ──
//
// `dashboard:view` is an ordinary capability an owner unticks in the roles
// matrix, and applyCapGates duly takes the Dashboard row out of the rail when
// they do. Nothing ever moved the operator OFF the section — #tab-dashboard is
// class="active" in the markup, so it is what the shell boots showing. A
// narrowed role therefore landed on the one screen its role exists to exclude
// and then, the moment it picked any other row, had no row left to come back by:
// the dashboard became reachable only by reloading the page. Reported from a
// Stockroom account as "it has the dashboard but the moment i click anything on
// the left menu i cant go back to dashboard", which is exactly what it looks
// like from the desk.
//
// Tacet Mobile has answered this since its tab bar was capability-filtered — the
// same rule, in m.html, under the same name, so the two read against each other.
// The phone's note is the argument in full.
//
// RUNS ONCE, on the first gate after caps arrive. applyCapGates itself is called
// from a dozen render paths — every screen that paints a [data-cap] button
// re-runs it — and re-homing on any of those would yank an operator off the page
// they are working on mid-task.
let _landed = false;
function landOnSomethingReachable() {
  if (_landed) return;
  if (CAPS === null) return;            // fail-open: caps unknown, nothing is hidden
  _landed = true;
  const active = document.querySelector('main section.active');
  const id = active ? active.id : '';
  if (id.indexOf('tab-') !== 0) return;
  const row = document.querySelector('.tabs [data-tab="' + id.slice(4) + '"]');
  if (row && !_railRowHidden(row)) return;   // there is a way back; leave them where they are
  const next = _railLandingRow();
  // Nothing visible at all — leave the operator on the section they were given
  // rather than on an empty shell. A rail with no rows is its own bug and this
  // is not the place to report it.
  if (next) next.click();
}
// The row a stranded operator is put on: the top of their OWN menu, read in the
// order the rail actually draws it — CSS `order` first, DOM order as the
// tie-break, which is the pair flexbox itself resolves by. Root rows only; a
// folder's children are the fallback, because landing inside a folder opens a
// level the operator never asked for and hides their other tools behind a back
// arrow. (The phone makes the same choice: it lands on a primary tab, or on the
// tool list, never inside a tool.)
function _railLandingRow() {
  const rank = (b) => Number(getComputedStyle(b).order || 0);
  const pick = (list) => list.filter(b => !_railRowHidden(b)).sort((a, b) => rank(a) - rank(b))[0] || null;
  const root = pick(Array.prototype.slice.call(document.querySelectorAll('.tabs > [data-tab]')));
  if (root) return root;
  const inFolders = Array.prototype.slice.call(document.querySelectorAll('.tabs .tabs-group [data-tab]'))
    .filter(b => { const g = b.closest('.tabs-group'); return g && !_railRowHidden(g); });
  return pick(inFolders);
}
window.landOnSomethingReachable = landOnSomethingReachable;

// ── Payment-brand badge — small MONOCHROME chip with a WeChat / Alipay
// mark + a single-language label. Used in the order drawer Payment tile and
// in the top-up history rows so admins can scan "what paid with what" at a
// glance instead of reading the raw "wechat" / "alipay" string.
// The mark is drawn in currentColor (no brand green/blue) so it stays neutral
// — "colour is status, not decoration" — and adapts to light/dark. The label
// shows one language (cuT), never a glued "WeChat · 微信".
// `size`: 'sm' (default, inline) | 'lg' (drawer hero treatment).
function paymentBrandHTML(method, size) {
  const m = String(method || '').toLowerCase().trim();
  const isWeChat = (m === 'wechat' || m === 'weixin' || m === 'wechatpay' || m === 'wechat_pay' || m === '微信' || m === '微信支付');
  const isAlipay = (m === 'alipay' || m === 'zhifubao' || m === '支付宝');
  const big = size === 'lg';
  const iconSize = big ? 20 : 17;
  const T = (typeof cuT === 'function') ? cuT : ((en) => en);
  if (isWeChat) {
    // Two overlapping speech bubbles, stroked in currentColor — recognisable
    // as WeChat without the brand-green filled square.
    const svg = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 4.2C5.2 4.2 2 6.8 2 10.1c0 1.9 1.1 3.6 2.8 4.7L4.2 17l2.9-1.3c.5.1 1 .2 1.5.2"/>
      <path d="M22 15.3c0-2.6-2.4-4.8-5.5-4.8s-5.5 2.1-5.5 4.8 2.4 4.8 5.5 4.8c.6 0 1.3-.1 1.8-.3L21 21l-.5-2c.9-.9 1.5-2.1 1.5-3.7z"/>
      <circle cx="6.6" cy="9.4" r=".8" fill="currentColor" stroke="none"/><circle cx="10.6" cy="9.4" r=".8" fill="currentColor" stroke="none"/>
      <circle cx="14.3" cy="14.4" r=".7" fill="currentColor" stroke="none"/><circle cx="18.3" cy="14.4" r=".7" fill="currentColor" stroke="none"/>
    </svg>`;
    return `<span class="pay-brand pay-brand-wechat${big?' lg':''}">${svg}<span class="lbl">${T('WeChat','微信')}</span></span>`;
  }
  if (isAlipay) {
    // The "支" character in currentColor — recognisable, monochrome.
    const svg = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" aria-hidden="true">
      <text x="12" y="18" text-anchor="middle" font-size="17" font-weight="700" fill="currentColor" font-family="Arial, 'PingFang SC', sans-serif">支</text>
    </svg>`;
    return `<span class="pay-brand pay-brand-alipay${big?' lg':''}">${svg}<span class="lbl">${T('Alipay','支付宝')}</span></span>`;
  }
  // Off-app tender confirmed via "Mark paid" — friendly bilingual label, no
  // gateway badge (the operator didn't use the in-app gateway).
  const offline = { cash: 'Cash · 现金', bank_transfer: 'Bank transfer · 银行转账', wechat_offline: 'WeChat off-app · 微信(线下)', alipay_offline: 'Alipay off-app · 支付宝(线下)', other: 'Other · 其他' }[m];
  if (offline) return `<b>${offline}</b>`;
  // Unknown method. Render the RAW KEY, unstyled — no <b>, no badge.
  //
  // 🔴 This fallback used to bold it, and bold is how a brand reads here:
  // "Cash", "Bank transfer" and every gateway label above are bold, so an
  // unhandled key inherited their authority and passed for a payment type.
  // That is exactly how `admin_adjust`, `order_redeem` and `refund_reverse`
  // shipped into the customer's top-up history looking like money the customer
  // had handed over. Unstyled raw text reads as UNHANDLED — visibly odd, which
  // is the point: it says "nobody has taught this screen that word yet"
  // instead of quietly asserting something false. Same principle as
  // cuPtsSource()'s fallback. Do not re-add the bold.
  return `<span class="pay-unknown">${escapeHtml(method || '')}</span>`;
}

// The payment row to surface on an order. An order can carry more than one
// payment row — e.g. a checkout placeholder that stayed 'pending' (the gateway
// callback never landed) plus the settled row written when staff marked it
// paid off-app. Prefer the settled one so a paid order never reads "pending".
function primaryPayment(o) {
  const list = o?.payments || [];
  return list.find(p => p.status === 'success')
      || list.find(p => p.status === 'refunded')
      || list[list.length - 1]
      || null;
}
// Friendly, single-language label for a raw payment status (cuT picks the live
// language — never a glued "paid · 已付").
function paymentStatusLabel(s) {
  const T = (typeof cuT === 'function') ? cuT : ((en) => en);
  return { success: T('paid', '已付'), pending: T('pending', '待付'), created: T('pending', '待付'),
           refunded: T('refunded', '已退'), failed: T('failed', '失败') }[s] || (s || '—');
}

// ── Tab switcher — supports flat tabs AND drill-down groups ──
// Buttons with data-tab activate a section. Buttons without (the group triggers)
// open their level in the rail instead — see the drill-down block below. The
// parent .tabs-group gets .has-active when one of its child tabs is the current
// active tab, so a folder sitting at root shows which one you're inside.
$$('.tabs [data-tab]').forEach(btn => btn.addEventListener('click', () => {
  // Switching tabs dismisses any open side-drawer (order/customer detail,
  // editors) so it doesn't hang over the newly-shown section.
  $$('.side-drawer.open').forEach(d => closeDrawer(d));
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b === btn));
  $$('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + btn.dataset.tab));
  $$('.tabs-group').forEach(g => g.classList.toggle('has-active', g.contains(btn)));
  // Put the rail at the level that owns this tab. Picking a child KEEPS the rail
  // drilled (§2.1) — Coupons → Flash sales is the common motion; picking a root
  // row returns it to root.
  railResolveFor(btn.dataset.tab);
}));
// Sales overview → jump into a single channel's full admin. The "Configure"
// buttons on #tab-sales call this. Now a thin alias for goTab: channel admins
// (meituan/guanyi/eleme) have had no rail button of their own since the Sales-
// page redesign, so the "click a real button" path below never fires for them —
// goTab's manual-activation fallback (with its TAB_INIT dispatch) is what
// actually opens them. Kept as a separate name since call sites read clearer as
// "go to this channel's admin" than "go to this tab".
function salesGo(channel) { goTab(channel); }
// Activate a tab/section by name from OUTSIDE the rail (e.g. the dashboard's
// Needs-you rows, or in-page buttons like the Sales channel cards). When the tab has
// a rail button, CLICK it — that fires whatever the button's own listener does.
// Otherwise (a channel admin with no rail row any more, or any other rail-less
// tab) light the section manually and fire its init from TAB_INIT, so opening
// it this way is never left stuck on a stale/empty placeholder — the failure
// mode this fallback silently had until TAB_INIT existed.
function goTab(tab) {
  // HIDING A ROW IS NOT THE SAME AS REFUSING IT, and this is the door every
  // other route into a section comes through: the dashboard's own "The full
  // numbers live in Reports" foot link, the Sales cards, the command palette,
  // the /?product= deep link. A rail row hidden by applyCapGates is still in the
  // DOM and still answers .click(), so before this guard every one of those
  // could open a section the operator's role exists to exclude — the foot link
  // did exactly that on a role holding neither dashboard:view nor reports:view.
  // The phone has refused the same way since its tab bar was gated (m.html
  // push() / reg('tab')); this is that refusal, on the same table.
  if (!canTab(tab)) return;
  const btn = document.querySelector('.tabs [data-tab="' + tab + '"]');
  if (btn) { btn.click(); return; }
  $$('.side-drawer.open').forEach(d => closeDrawer(d));
  // A rail-less tab (a channel admin, the Product Page Editor) lights the row it
  // sits under rather than nothing at all — RAIL_STANDIN names it. Everything
  // else lights itself; a tab in neither camp lights nothing, which is the
  // honest answer.
  const lit = RAIL_STANDIN[tab] || tab;
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === lit));
  $$('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  $$('.tabs-group').forEach(g => {
    const has = !!g.querySelector('[data-tab="' + lit + '"]');
    g.classList.toggle('has-active', has);
  });
  railResolveFor(tab);
  const initFn = TAB_INIT[tab];
  if (initFn && typeof window[initFn] === 'function') window[initFn]();
}

// (Topbar page-identity crumb removed 2026-07-25 — the bar is closed, §1.1d.
// tbSetPage()/_tbRailLabel() and their tab-switch + language-change hooks are
// gone with it; the page names itself with its own in-content heading.)

// Search-field keyboard hint — platform-aware: ⌘K on Mac, Ctrl K everywhere
// else, never both. The trigger is a button that opens the same palette either
// way; this only sets the label glyph.
(function _tbSearchHint() {
  const set = () => {
    const kbd = document.getElementById('gsearch-kbd');
    if (!kbd) return;
    const plat = (navigator.userAgentData && navigator.userAgentData.platform)
              || navigator.platform || navigator.userAgent || '';
    kbd.textContent = /Mac|iPhone|iPad|iPod/i.test(plat) ? '⌘K' : 'Ctrl K';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', set, { once: true });
  else set();
})();
let _salesLangHooked = false;
// Sales overview → fill today's per-channel figures + the folded summary from
// /sales/summary. Called when the Sales tab is opened. Leaves the "—"
// placeholders in place on any error rather than blanking the page. dashMoney
// (part 03) is loaded by the time a tab can be clicked.
async function salesInit() {
  // Nothing read yet (or the last read failed): blank the switches now, before
  // the summary round-trip, so the HTML's placeholder on/off is never shown.
  if (!_csData) csMarkUnknown(_csFailed);
  // Everything this page paints from JS is built with cuT at paint time, so a
  // language switch after it painted left it in the old language — "已连接"
  // under an English page. Repaint on the switch. Hooked here, not at file
  // scope: onLangChange is defined by an inline script that runs after this
  // file loads.
  if (!_salesLangHooked && typeof window.onLangChange === 'function') {
    _salesLangHooked = true;
    onLangChange(() => {
      const sales = document.getElementById('tab-sales');
      if (sales && sales.classList.contains('active')) salesInit();
    });
  }
  const set   = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const money = (n) => (typeof dashMoney === 'function' ? dashMoney(n) : acWrap(Number(n || 0)));
  const num   = (n) => Number(n || 0).toLocaleString();
  try {
    const j = await api('/api/retail-admin/sales/summary');
    const s = j.summary || {}, c = j.channels || {};
    set('sales-sum-rev', money(s.revenue));
    set('sales-sum-orders', num(s.orders));
    set('sales-sum-aov', money(s.aov));
    // Revenue is cash-basis: it includes wallet top-up cash taken today. Spell
    // that out under the figure so top-ups (and store credit spent) are visible
    // rather than silently folded in. Falls back to the plain "today" label.
    const tuIn = Number(s.topups_received || 0);
    const scUsed = Number(s.store_credit_redeemed || 0);
    const noteBits = [];
    if (tuIn > 0)   noteBits.push(cuT(`incl. ${money(tuIn)} top-ups`, `含充值 ${money(tuIn)}`));
    if (scUsed > 0) noteBits.push(cuT(`${money(scUsed)} store credit used`, `储值消费 ${money(scUsed)}`));
    set('sales-sum-rev-note', noteBits.length ? noteBits.join(' · ') : cuT('today', '今日'));
    const active = document.getElementById('sales-sum-active');
    if (active) active.innerHTML = num(s.active) + ' <span class="sales-of">/ ' + (s.total || 3) + '</span>';
    const fill = (k, ch) => {
      if (!ch) return;
      set('sales-' + k + '-rev', money(ch.revenue));
      set('sales-' + k + '-orders', num(ch.orders));
      set('sales-' + k + '-aov', money(ch.aov));
      set('sales-' + k + '-extra', num(ch.extra));
    };
    fill('wc', c.wechat);
    fill('wb', c.web);
    fill('mt', c.meituan);
    fill('gy', c.gzgrocery);
    fill('el', c.eleme);
    fill('ps', c.pos);
    fill('dr', c.direct);
  } catch (e) { /* keep placeholders on error */ }
  csLoad();  // unlock + wire the channel-close toggles (channel × location)
  salesWireSetup();  // merge: Set up / Configure per card from the integrations hub
}

// Gear/settings glyph — Configure now rides beside each channel's master toggle
// (salesWireSetup injects it), replacing the old footer "Configure" button.
const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

// Merge of the old "Channels & Delivery" hub into this Sales page: a connected
// card gets a gear beside its toggle (Configure); an unconnected one keeps a
// "Set up" call-to-action in its footer. Driven by the integrations registry
// status (window.igStatusFor). Degrades to the static footer Configure buttons
// if the hub JS/endpoint isn't available.
async function salesWireSetup() {
  if (typeof window.igEnsureLoaded !== 'function') return;
  try { await window.igEnsureLoaded(); } catch (_) { return; }
  // key → { hub kind, what Configure opens }. gzgrocery is Roots-only (not a hub
  // plugin) so it stays always-Configure.
  const MAP = {
    wc: { kind: 'wechat_miniapp', overlay: true, open: () => (window.igMiniappConfig ? igMiniappConfig() : salesGo('config')) },  // Configure = the all-in-one Mini App config page
    wb: { kind: 'web',            overlay: true, open: () => (window.igWebConfig ? igWebConfig() : salesGo('config')) },  // Configure = the Web store config page
    mt: { kind: 'meituan',        overlay: true, open: () => (window.igMeituanConfig ? igMeituanConfig() : salesGo('meituan')) },  // Configure = clean Meituan page (summary when connected, box-first setup when new)
    gy: { kind: 'gzgrocery',      open: () => salesGo('guanyi'), alwaysConfigure: true },
    el: { kind: 'eleme',          open: () => salesGo('eleme') },
    // POS is ours and has no hub plugin to be "connected" to, so it is always
    // Configure — the same treatment gzgrocery gets. Configure opens the till
    // itself, because that IS the channel: there is nothing else to point an
    // operator at.
    ps: { kind: 'pos',            open: () => openAppPage('/till?from=dashboard'), alwaysConfigure: true },
    // jd / qy cards moved to the Delivery tab's card hub (2026-07-03).
  };
  const cardByKey = (key) => {
    const direct = document.getElementById('sales-ch-' + key);
    if (direct) return direct;
    const m = document.getElementById('sales-' + key + '-rev');
    return m ? m.closest('.sales-ch') : null;
  };
  for (const [key, cfg] of Object.entries(MAP)) {
    const card = cardByKey(key);
    if (!card) continue;
    const status = cfg.alwaysConfigure ? 'connected' : (window.igStatusFor ? igStatusFor(cfg.kind) : 'connected');
    const connected = cfg.alwaysConfigure || status === 'connected' || status === 'paused';
    const isError = status === 'error';
    // The washed-out card treatment (transparent bg, dashed icon tile, dimmed
    // figures) follows the LIVE status now — it used to be frozen in the HTML,
    // so Eleme stayed grey long after it connected.
    card.dataset.on = connected ? '1' : '0';
    // Status line.
    const statEl = card.querySelector('.sales-ch-stat');
    if (statEl) {
      let dot = 'ok', txt = cuT('Connected', '已连接');
      if (!connected) {
        if (isError) { dot = 'err'; txt = cuT('Needs attention', '需处理'); }
        else if (status === 'in_setup' || status === 'connecting' || status === 'configured') { dot = 'warn'; txt = cuT('In setup', '设置中'); }
        else { dot = 'off'; txt = cuT('Not set up', '未配置'); }
      }
      statEl.innerHTML = '<span class="sales-dot ' + dot + '"></span>' + txt;
    }
    // Configure moves to a gear beside the master toggle (added once); the
    // footer only carries a Set up / Fix CTA while a channel is not connected.
    // A connected card's footer is emptied (CSS hides it when empty).
    const foot = card.querySelector('.sales-ch-foot');
    const top = card.querySelector('.sales-ch-top');
    const toggle = top && top.querySelector('.sales-toggle');
    // The gear rides beside the toggle on EVERY card (added once). Connected
    // cards open their config; a not-set-up card's gear launches setup, same as
    // its footer CTA — so the control is never dead.
    if (top && toggle && !top.querySelector('.sales-ch-gear')) {
      const g = document.createElement('button');
      g.type = 'button';
      g.className = 'sales-ch-gear';
      g.title = cuT('Configure', '配置');
      g.setAttribute('aria-label', cuT('Configure', '配置'));
      g.innerHTML = GEAR_SVG;
      // Host-rendered configs (mini/web/meituan) open in the full-screen
      // overlay — reuse the card's own channel icon for the bar; tab-
      // navigating ones (gzgrocery/eleme) go straight there.
      const cardIco = card.querySelector('.sales-ch-ico');
      const barIcon = cardIco ? cardIco.innerHTML : '';
      g.onclick = connected
        ? (cfg.overlay
            ? () => salesOpenConfig(cfg.open, { icon: barIcon, title: cuT('Configuration', '配置') })
            : cfg.open)
        : () => igLaunchSetup(cfg.kind);
      top.insertBefore(g, toggle);
    }
    if (connected) {
      if (foot) foot.innerHTML = '';
    } else {
      if (!foot) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm btn-primary';
      b.textContent = isError ? cuT('Fix', '修复') : cuT('Set up', '设置');
      b.onclick = () => igLaunchSetup(cfg.kind);
      foot.innerHTML = '';
      foot.appendChild(b);
    }
  }
}

// ── Full-screen Configure overlay ────────────────────────────────────────────
// A channel's gear renders its config surface into #cfg-host — a 16px-inset
// full-screen sheet with its own top bar (icon + title + ✕). igHostEl() (part
// 15) targets #cfg-host while body.cfg-open is set, so the existing renderers
// need no change; each panel's own header is hidden (CSS) and the bar owns it.
// Closing (bar ✕ / backdrop / Esc → igLocClose) tears the overlay down and
// refreshes Sales. Also used by the Locations "Add location" button.
const SALES_STORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>';
window.salesOpenConfig = function (renderFn, opts) {
  const ov = document.getElementById('cfg-overlay');
  if (!ov) { if (typeof renderFn === 'function') renderFn(); return; }  // graceful fallback
  opts = opts || {};
  const ico = document.getElementById('cfg-ico');
  const ttl = document.getElementById('cfg-title');
  if (ico) ico.innerHTML = opts.icon || '';
  if (ttl) ttl.textContent = opts.title || cuT('Configuration', '配置');
  document.body.classList.add('cfg-open');
  document.body.style.overflow = 'hidden';
  ov.hidden = false;
  requestAnimationFrame(() => ov.classList.add('in'));
  try { if (typeof renderFn === 'function') renderFn(); } catch (e) { /* renderer surfaces its own errors */ }
};
// Locations "Add location" — same overlay, store icon + its own title.
window.salesAddLocation = function () {
  salesOpenConfig(function () { if (window.igAddLocation) igAddLocation(); },
    { icon: SALES_STORE_ICON, title: cuT('Add location', '新增门店') });
};
// Called by igLocClose after it clears the host: fade the overlay out + reload
// the Sales figures so a just-saved change shows.
window.salesAfterConfigClose = function () {
  const ov = document.getElementById('cfg-overlay');
  document.body.classList.remove('cfg-open');
  document.body.style.overflow = '';
  if (ov) { ov.classList.remove('in'); setTimeout(() => { ov.hidden = true; }, 250); }
  const sales = document.getElementById('tab-sales');
  if (sales && sales.classList.contains('active') && typeof salesInit === 'function') salesInit();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('cfg-open') && typeof window.igLocClose === 'function') window.igLocClose();
});

// ── Sales channel × location close controls ──────────────────────────────────
// The Sales-page channel cards ship with a LOCKED toggle. We unlock + wire the
// close behaviour here WITHOUT editing the HTML (that file is co-edited):
//   • a channel toggle opens a popup with a per-location toggle + "close all"
//   • gzgrocery (tianhe-only) toggles directly, no popup
//   • two injected location-master buttons close every channel of a location
// Backend: /api/retail-admin/channel-status (+ /cell, /channel, /location).
const CS_KEY2CH = { wc: 'mini_app', wb: 'web', mt: 'meituan', gy: 'gzgrocery', el: 'eleme', ps: 'pos' };
function csName(ch) {
  return ({ mini_app: cuT('WeChat', '微信'), web: cuT('Web shop', '网页商店'),
            meituan: cuT('Meituan', '美团'), eleme: cuT('Eleme', '饿了么'), gzgrocery: 'Gzgrocery',
            pos: cuT('Counter sale', '前台销售') })[ch] || ch;
}
let _csData = null;
/* NOT `csChannel`. That was this function's name until 2026-09-25, and
   29-channel-sync.js has set `window.csChannel` — its own channel-filter
   setter — since 2026-09-11. It loads later, so it replaced this one: every
   Sales card looked its channel up, got undefined back, and was left as the
   HTML shipped it — WeChat "on", Eleme "off", none clickable — while the phone
   showed the real state. Every script on this page shares one global scope;
   scripts/test_sales_channel_switches.js now fails on any name two of them
   both claim. */
function csChannelInfo(key) { return ((_csData && _csData.channels) || []).find(c => c.channel === key); }
// Store name that follows the EN/中文 toggle. Falls back to data-no-i18n when
// only one name exists (or both are identical) so the walker leaves it alone.
function csStoreName(o) {
  const en = o.nameEn || o.name || '';
  const cn = o.nameCn || o.name || '';
  if (!en || !cn || en === cn) return '<span data-no-i18n>' + escapeHtml(en || cn) + '</span>';
  return '<span data-lang-block="en">' + escapeHtml(en) + '</span><span data-lang-block="cn">' + escapeHtml(cn) + '</span>';
}

/* A SWITCH WITH NO DATA BEHIND IT SHOWS NO STATE. retail-admin.html ships each
   channel card's switch pre-set on or off, and csLoad used to swallow a failed
   read and leave those placeholders standing — where they read exactly like
   live state. That is how the desktop showed Eleme off at every store while
   the phone, reading the same table, said it was open at Tianhe: the read had
   failed, and every other switch on the page was a placeholder too. So until
   the matrix lands, and whenever it cannot, the switches are blank and inert,
   the "where it is live" lines and the Locations section come off, and one
   line under the Channels kicker says the state could not be read, with a
   Retry. A failed read also retries on its own a few times while the Sales tab
   is open. */
let _csSeq = 0, _csFailed = false, _csRetryTimer = null, _csRetries = 0;
const CS_RETRY_MS = [3000, 10000, 30000];
function csChannelCards() {
  const out = [];
  document.querySelectorAll('#tab-sales .sales-ch').forEach((card) => {
    const m = card.querySelector('[id^="sales-"][id$="-rev"]');
    const mm = m && m.id.match(/^sales-(\w+)-rev$/);
    const ch = mm && CS_KEY2CH[mm[1]];
    const btn = card.querySelector('.sales-toggle');
    if (ch && btn) out.push({ card, ch, btn });
  });
  return out;
}
function csMarkUnknown(failed) {
  for (const { card, btn } of csChannelCards()) {
    btn.disabled = true; btn.onclick = null;
    btn.classList.remove('on', 'partial', 'is-locked');
    btn.classList.add('unknown');
    btn.title = failed ? cuT('Could not read the shop status', '无法读取营业状态') : cuT('Loading…', '加载中…');
    const where = card.querySelector('.sales-ch-locs');
    if (where) where.remove();
  }
  const locs = document.getElementById('cs-locations');
  if (locs) locs.remove();
  csShowError(failed);
}
function csShowError(on) {
  let el = document.getElementById('cs-err');
  if (!on) { if (el) el.remove(); return; }
  const anchor = document.getElementById('sales-ch-kicker');
  if (!anchor) return;
  if (!el) {
    el = document.createElement('div');
    el.id = 'cs-err';
    el.className = 'sales-cs-err';
    el.setAttribute('role', 'alert');
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
  }
  el.innerHTML = '<span>' + cuT('Could not read the shop status', '无法读取营业状态') + '</span>'
    + '<button class="btn btn-sm" type="button" onclick="csRetryNow()">' + cuT('Retry', '重试') + '</button>';
}
function csClearRetry() { if (_csRetryTimer) { clearTimeout(_csRetryTimer); _csRetryTimer = null; } }
window.csRetryNow = function () { _csRetries = 0; csLoad(); };

async function csLoad() {
  const seq = ++_csSeq;
  csClearRetry();
  let data;
  try {
    data = await api('/api/retail-admin/channel-status');
    if (!data || !Array.isArray(data.channels)) throw new Error('no channels in reply');
  } catch (e) {
    if (seq !== _csSeq) return;  // a newer read owns the page now
    console.warn('channel-status read failed:', e && e.message);
    _csData = null; _csFailed = true;
    csClearPoll();
    csMarkUnknown(true);
    const sales = document.getElementById('tab-sales');
    if (_csRetries < CS_RETRY_MS.length && sales && sales.classList.contains('active')) {
      _csRetryTimer = setTimeout(() => { _csRetryTimer = null; csLoad(); }, CS_RETRY_MS[_csRetries++]);
    }
    return;
  }
  if (seq !== _csSeq) return;
  _csData = data; _csFailed = false; _csRetries = 0;
  csShowError(false);
  csRender();
}

function csRender() {
  if (!_csData) return;
  let anyPending = false;
  for (const { card, ch, btn } of csChannelCards()) {
    const info = csChannelInfo(ch);
    btn.classList.remove('unknown');
    // No row for this channel, or not set up yet: a locked, empty switch — no
    // channel×location matrix to open or close. The "Set up" footer is
    // salesWireSetup's.
    if (!info || info.integrated === false) {
      btn.disabled = true; btn.onclick = null;
      btn.classList.remove('on', 'partial'); btn.classList.add('is-locked');
      const stale = card.querySelector('.sales-ch-locs');
      if (stale) stale.remove();
      continue;
    }

    const cells = info.cells || [];
    const openCount = cells.filter((c) => c.open).length;
    const partial = cells.length > 1 && openCount > 0 && openCount < cells.length;
    const cardOpen = !!info.cardOpen;

    // Master toggle: unlock + reflect state. One tap opens/closes this channel
    // at EVERY store in one shot (no popup); half-lit = open at only some.
    btn.disabled = false; btn.removeAttribute('disabled'); btn.classList.remove('is-locked');
    btn.title = cuT('Turn this channel on or off at every store', '一键开关所有门店的该渠道');
    btn.classList.toggle('partial', partial);
    btn.classList.toggle('on', !partial && cardOpen);
    btn.onclick = () => csChannelToggle(ch, cardOpen);

    // Where this channel is live: one dot + name per location, read-only. The
    // per-location switches live on the location cards (§253) — one control per
    // cell, not two — so this line only says where the channel is on.
    const prev = card.querySelector('.sales-ch-locs');
    if (prev) prev.remove();
    const box = document.createElement('div');
    box.className = 'sales-ch-locs sales-ch-where';
    let html = '';
    for (const c of cells) {
      if (c.pending) anyPending = true;
      const note = (ch === 'meituan' && c.pending) ? ' <span class="sales-ch-loc-note">' + cuT('applying…', '处理中…') + '</span>' : '';
      html += '<span class="sales-ch-where-it' + (c.open ? '' : ' closed') + '">'
        + '<span class="sales-dot ' + (c.open ? 'ok' : 'off') + '"></span>' + csStoreName(c) + note + '</span>';
    }
    box.innerHTML = html;
    const foot = card.querySelector('.sales-ch-foot');
    if (foot) card.insertBefore(box, foot); else card.appendChild(box);
  }
  csRenderLocations();
  // Meituan applies open/close on the box asynchronously (置休 via the daemon);
  // poll until the pending cells settle, then the rows flip on their own.
  csClearPoll();
  if (anyPending) _csPollTimer = setTimeout(() => { _csPollTimer = null; csLoad(); }, 4000);
}
let _csPollTimer = null;
function csClearPoll() { if (_csPollTimer) { clearTimeout(_csPollTimer); _csPollTimer = null; } }

// Locations section: one card per store (same shell as the channel cards) with
// a chip row of the channels that serve it + a master toggle that opens/closes
// the WHOLE store. The "Add location" button rides this section's kicker.
function csRenderLocations() {
  const anchor = document.getElementById('sales-ch-kicker');
  if (!anchor) return;
  let box = document.getElementById('cs-locations');
  if (!box) {
    box = document.createElement('div');
    box.id = 'cs-locations';
    // Land above the "Channels" kicker so the page reads Summary → Locations
    // → Channels (the kicker anchor is in retail-admin.html).
    anchor.parentNode.insertBefore(box, anchor);
  }
  const locs = (_csData && _csData.locations) || [];
  const channels = (_csData && _csData.channels) || [];
  const storeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>';
  const plusIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" style="width:13px;height:13px"><path d="M12 5v14M5 12h14"/></svg>';
  const cellFor = (c, code) => (c.cells || []).find((x) => x.storeCode === code);
  const cards = locs.map((l) => {
    // Only set-up channels count toward a store's live/total + chips.
    const serving = channels.filter((c) => c.integrated !== false && cellFor(c, l.storeCode));
    const live = serving.filter((c) => { const x = cellFor(c, l.storeCode); return x && x.open; }).length;
    const total = serving.length;
    const none = live === 0, allOn = live === total && total > 0, partial = !allOn && !none;
    let dot = 'ok', txt = cuT('Open — all channels live', '营业中 — 所有渠道');
    if (none) { dot = 'warn'; txt = cuT('Closed — every channel off', '已关闭 — 所有渠道'); }
    else if (partial) { dot = 'warn'; txt = cuT(live + ' of ' + total + ' channels live', total + ' 个渠道中 ' + live + ' 个在线'); }
    // One row per channel with its own small switch (§253): this is where a
    // single channel is opened or closed at this location. At a closed shop,
    // switching one on opens the shop with only that channel.
    const rows = serving.map((c) => {
      const x = cellFor(c, l.storeCode); const on = !!(x && x.open);
      const note = (c.channel === 'meituan' && x && x.pending) ? ' <span class="sales-ch-loc-note">' + cuT('applying…', '处理中…') + '</span>' : '';
      return '<div class="sales-ch-loc-row' + (on ? '' : ' closed') + '">'
        + '<span class="sales-dot ' + (on ? 'ok' : 'off') + '"></span>'
        + '<span class="sales-ch-loc-nm">' + csName(c.channel) + note + '</span>'
        + '<span class="sales-ch-loc-st">' + (on ? cuT('Open', '营业中') : cuT('Closed', '已关闭')) + '</span>'
        + '<button class="sales-toggle sm' + (on ? ' on' : '') + '" type="button" aria-pressed="' + on + '" aria-label="'
        + escapeHtml(csName(c.channel)) + '" onclick="csCell(\'' + c.channel + '\',\'' + escapeHtml(l.storeCode) + '\',' + (on ? 'false' : 'true') + ')"><span class="knob"></span></button>'
        + '</div>';
    }).join('');
    const tgl = partial ? ' partial' : (allOn ? ' on' : '');
    // The one link out, bottom of the card (A5 Board): the location's shop menu
    // — its §41 shop record and §42 listings, a sub-page painted by
    // 28-shops.js. Guarded so the card still paints if that part is not loaded.
    const menuLink = (typeof window.shopMenuOpen === 'function')
      ? '<div class="sales-ch-foot"><button class="btn btn-sm" type="button" onclick="shopMenuOpen(\'' + escapeHtml(l.storeCode) + '\')">'
        + cuT('Shop menu', '门店商品') + ' →</button></div>'
      : '';
    return '<div class="sales-ch" data-on="1">'
      + '<div class="sales-ch-top"><div class="sales-ch-id">'
      + '<span class="sales-ch-ico">' + storeIcon + '</span>'
      + '<div><div class="sales-ch-name">' + csStoreName(l) + '</div>'
      + '<div class="sales-ch-stat"><span class="sales-dot ' + dot + '"></span>' + txt + '</div></div></div>'
      + '<button class="sales-toggle' + tgl + '" type="button" title="' + cuT('Open or close the whole store', '开关整个门店')
      + '" onclick="csLocation(\'' + l.storeCode + '\',' + (none ? 'true' : 'false') + ')"><span class="knob"></span></button>'
      + '</div>'
      + '<div class="sales-ch-locs sales-loc-rows">' + rows + '</div>'
      + menuLink
      + '</div>';
  }).join('');
  box.innerHTML = '<div class="td-kicker sales-loc-kicker"><span>' + cuT('Locations', '门店') + '</span>'
    + '<button class="btn btn-sm" type="button" onclick="salesAddLocation()">' + plusIcon + cuT('Add location', '新增门店') + '</button></div>'
    + '<div class="sales-grid sales-loc-grid">' + cards + '</div>';
}

// One tap on a channel's master toggle opens/closes it at every store.
window.csChannelToggle = async function (ch, isOpenNow) {
  const open = !isOpenNow;
  if (!open && !(await askConfirm({ title: cuT('Close this channel at every store?', '关闭所有门店的该渠道？'), confirmLabel: cuT('Close channel', '关闭渠道'), danger: true }))) return;
  try {
    const r = await api('/api/retail-admin/channel-status/channel', { method: 'POST', body: { channel: ch, open } });
    // Opening everywhere leaves a closed shop closed (§253) — say which, so the
    // half-lit switch that follows is not a mystery.
    const skipped = ((r && r.skipped) || []).map((code) => csLocationOf(code)).filter(Boolean);
    if (window.toast) {
      toast(skipped.length
        ? cuT('Saved', '已保存') + ' · ' + skipped.map(csStoreText).join(cuT(', ', '、')) + cuT(': ', '：') + cuT('Shop closed', '门店已关闭')
        : cuT('Saved', '已保存'));
    }
    await csLoad();
  } catch (e) { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
};
// "3d ago" / "3mo ago" / "never" — local to this confirm dialog, not tied to
// the dashboard's server-clock age helpers (dashAgeMins reads DASH_OPS, which
// this page may never have loaded). A one-off confirmation reading the
// browser's own clock is fine; nothing here is a live, ticking figure.
function csAgeText(iso) {
  if (!iso) return cuT('never touched', '从未更新');
  const t = new Date(String(iso).replace(' ', 'T') + 'Z').getTime();
  if (!t || isNaN(t)) return cuT('never touched', '从未更新');
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return cuT('today', '今天');
  if (days === 1) return cuT('1 day ago', '1 天前');
  if (days < 30) return cuT(days + ' days ago', days + ' 天前');
  const months = Math.round(days / 30);
  return cuT(months + (months === 1 ? ' month ago' : ' months ago'), months + ' 个月前');
}
// One store's cell for a channel (the inline row toggle). Reopening a channel
// that pushes a full stock snapshot the moment it comes back on (Meituan
// today) means the operator is about to publish numbers nobody has necessarily
// just counted — so before that fires, show what's about to go out and how
// stale the oldest of it is. Always confirmed, with no freshness check of any
// kind: the dialog is skipped only when the preview comes back with nothing
// mapped for that store on that channel, because there is nothing to publish.
// Plain-text store name for a dialog title (csStoreName returns markup).
function csStoreText(o) { return cuT(o.nameEn || o.name || '', o.nameCn || o.name || ''); }
function csLocationOf(storeCode) { return ((_csData && _csData.locations) || []).find((l) => l.storeCode === storeCode); }
window.csCell = async function (ch, storeCode, open) {
  // Opening one channel at a closed shop opens the shop with only that channel
  // (§253) — a bigger step than a cell, so it is confirmed. The title and body
  // are the phone's own live pairs for opening a channel at a store.
  const loc = csLocationOf(storeCode);
  if (open && loc && loc.shopOpen === false) {
    const store = cuT(loc.nameEn || loc.name || '', loc.nameCn || loc.name || '');
    const chan = csName(ch);
    if (!(await askConfirm({
      title: cuT('Open ' + chan + ' at ' + store + '?', '在 ' + store + ' 开启 ' + chan + '？'),
      // §325 S2m — Eleme is never told a store is shut, so its orders never
      // stopped; what this brings back for Eleme is the stock pushes. The
      // phone's live pair for the same act (m.html ELEME_CLOSE_WORDS.openOne).
      body: ch === 'eleme' ? cuT('Stock is sent to Eleme for this store again.', '恢复向饿了么推送该门店的库存。')
                           : cuT('New orders can arrive at this store again.', '这家门店可以重新接单。'),
      confirmLabel: cuT('Open', '开启'),
    }))) return;
  }
  if (open) {
    let prev = null;
    // Short leash on purpose: this dialog is a courtesy, not a gate, and a
    // courtesy must never make someone stand and wait. 3s (not the app-wide
    // 20s api() default) so a bad day falls through quietly to the plain
    // reopen below instead of reading as a broken toggle.
    try { prev = await api('/api/retail-admin/channel-status/reopen-preview?channel=' + encodeURIComponent(ch) + '&storeCode=' + encodeURIComponent(storeCode), { timeoutMs: 3000 }); }
    catch (e) { /* preview failing must never block the toggle itself */ }
    if (prev && prev.count > 0) {
      const rows = (prev.items || []).map((it) =>
        `<div>${escapeHtml(it.name)} — ${escapeHtml(csAgeText(it.updatedAt))}</div>`).join('');
      const more = prev.count > (prev.items || []).length
        ? `<div>${escapeHtml(cuT(`and ${prev.count - prev.items.length} more`, `另有 ${prev.count - prev.items.length} 项`))}</div>` : '';
      const body = escapeHtml(cuT(
        `Reopening will publish current quantities for ${prev.count} product(s). Oldest first:`,
        `重新开启将发布 ${prev.count} 项商品的当前库存。最久未更新优先：`))
        + `<div style="margin-top:8px;text-align:left;font-size:13px">${rows}${more}</div>`;
      if (!(await askConfirm({
        title: cuT('Publish current stock to this channel?', '将当前库存发布到该渠道？'),
        body, confirmLabel: cuT('Publish', '发布'), cancelLabel: cuT('Not yet', '暂不'),
      }))) return;
    }
  }
  try { await api('/api/retail-admin/channel-status/cell', { method: 'POST', body: { channel: ch, storeCode, open } }); await csLoad(); }
  catch (e) { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
};
// Location master: open/close EVERY channel for one store.
// Reopening a closed shop brings back the channels that were live when it was
// closed (§253), so the confirm names them; with nothing remembered it opens all.
window.csLocation = async function (storeCode, open) {
  const loc = csLocationOf(storeCode);
  const back = open && loc && Array.isArray(loc.reopenChannels) && loc.reopenChannels.length ? loc.reopenChannels : null;
  let openTitle = cuT('Open ALL sales channels for this location?', '开启该门店的所有销售渠道？');
  if (back) {
    const store = csStoreText(loc);
    const list = cuT(back.map(csName).join(', '), back.map(csName).join('、'));
    openTitle = cuT('Open ' + list + ' at ' + store + '?', '在 ' + store + ' 开启 ' + list + '？');
  }
  if (!(await askConfirm({
    title: open ? openTitle
                : cuT('Close ALL sales channels for this location?', '关闭该门店的所有销售渠道？'),
    confirmLabel: open ? (back ? cuT('Open', '开启') : cuT('Open all', '全部开启')) : cuT('Close all', '全部关闭'),
    danger: !open,
  }))) return;
  try { await api('/api/retail-admin/channel-status/location', { method: 'POST', body: { storeCode, open } }); if (window.toast) toast(cuT('Done', '完成')); await csLoad(); }
  catch (e) { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
};
// Embedded editor — lazy-load the Mini App Editor iframe the first time the
// Editor tab is opened, so the big editor app doesn't download until needed.
(function () {
  const btn = document.querySelector('.tabs [data-tab="mini-app-editor"]');
  const frame = document.getElementById('frame-mini-app-editor');
  if (btn && frame) btn.addEventListener('click', () => { if (!frame.getAttribute('src')) frame.src = frame.dataset.src; });
})();
// Switch to the Editor tab in-page (shows the Mini App Editor). Re-clicking the
// already-active tab also returns here from the Product Page Editor.
function openMiniAppEditor() {
  const btn = document.querySelector('.tabs [data-tab="mini-app-editor"]');
  if (btn) btn.click();
}
// Reveal the Product Page Editor under the single Editor tab: keep the Editor
// tab active, hide the Mini App Editor section, show the product section
// (lazy-loading its iframe on first reveal).
function showProductSection() {
  const frame = document.getElementById('frame-product-editor');
  if (frame && !frame.getAttribute('src')) frame.src = frame.dataset.src;
  document.getElementById('tab-mini-app-editor')?.classList.remove('active');
  document.getElementById('tab-product-editor')?.classList.add('active');
}
// Open the Product Page Editor on a specific product, in-page: point its iframe
// at that product, activate the Editor tab, then reveal the product section.
//
// ASKS FIRST, AND IN OUR OWN WORDS. The editor is an IFRAME, so re-pointing its
// src is a navigation, and the editor's own beforeunload guard fires on it.
// That handed the operator the browser's generic "changes you made may not be
// saved" — a question naming neither the editor nor the product — and Cancel
// there ABORTS the navigation, leaving the PREVIOUS product on screen with
// nothing said. Opening the editor after editing a product then looked exactly
// like the editor ignoring the edits.
//
// So ask here, in the same two strings the editor's own exits already use, then
// tell the editor the exit is intentional so the browser stays out of it.
async function openProductEditor(id) {
  const frame = document.getElementById('frame-product-editor');
  if (frame) {
    // Same origin, so the editor's own dirty check is callable directly. It is
    // absent until the iframe has actually booted a product — guard for that
    // rather than assuming, because the first open has no document at all.
    let w = null;
    try { w = frame.contentWindow; } catch (e) {
      // Swallowed on purpose: an unreachable contentWindow just means there is
      // no editor document to ask, which is the same answer as "not dirty" — w
      // stays null and the open proceeds without a question.
    }
    let dirty = false;
    try { dirty = !!(w && typeof w.peIsDirty === 'function' && w.peIsDirty()); } catch (e) {
      // Swallowed on purpose: peIsDirty() serializes the whole editor state, so
      // a half-built document can throw mid-boot. A dirty check that cannot
      // answer must not block the open — the editor's own beforeunload is still
      // there as the backstop, exactly as it was before this guard existed.
    }
    if (dirty && !(await askConfirm({
      title: cuT('You have unsaved changes that will be lost. Leave anyway?', '有未保存的更改将会丢失,仍要离开吗?'),
      confirmLabel: cuT('Leave', '离开'),
    }))) return;
    try { if (w && typeof w.peLeaveIntentionally === 'function') w.peLeaveIntentionally(); } catch (e) {
      // Swallowed on purpose: this call only suppresses the browser's duplicate
      // question. If it cannot be made, the worst case is the old behaviour —
      // the operator is asked a second time, having already answered ours.
    }
    frame.src = '/product-editor?id=' + encodeURIComponent(id);
  }
  const btn = document.querySelector('.tabs [data-tab="mini-app-editor"]');
  if (btn) btn.click();   // activate Editor tab (hides every other section)
  showProductSection();
}
// The embedded Mini App Editor posts here when its PAGE dropdown's "Products"
// entry is chosen — reveal the Product Page Editor under the same Editor tab
// (lazy-loads its iframe, then lands on its product picker). "mini-app" posts
// back here to return to the storefront-pages view.
window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin) return;
  const d = ev.data;
  if (!d || d.type !== 'fc-open-editor') return;
  if (d.editor === 'product') {
    showProductSection();
  } else if (d.editor === 'mini-app') {
    openMiniAppEditor();
    // Returning from the product editor — pop the Mini App Editor's PAGE menu
    // open so the operator lands right on the page chooser.
    if (d.openPages) {
      const f = document.getElementById('frame-mini-app-editor');
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'fc-open-pages' }, location.origin);
    }
  }
});
// ── Rail drill-down ───────────────────────────────────────────────────────
// Replaced the sub-menu flyout 2026-07-29 (`tacet-rail-drilldown-amendment.md`).
// A group (Marketing, Loyalty & wallet, Content) no longer opens a panel BESIDE
// the rail — it REPLACES the rail's own contents with its children. One column,
// one level at a time. Depth is permanently one: no group contains a group, so
// there is no recursive stack here and none should be built for a two-level tree.
//
// Opening a folder LOADS NOTHING. All three groups are containers with no page
// of their own: clicking Marketing changes the rail and leaves the content area
// on whatever was already there. For a moment the rail reads "Marketing" and the
// screen reads "Orders" — correct and intended. Do not auto-load the first child;
// that discards the page the operator was reading to answer a question they did
// not ask.
//
// TRIGGER IS CLICK ONLY (plus Enter/Space, which a <button> gives us free). The
// flyout also opened on `mouseenter` and `focusin`. Both are destructive here and
// must not come back: hover would wipe the rail's contents over and over as the
// pointer travelled down the column, and focusin would drill into every folder in
// turn on Tab — a keyboard user could never reach Settings.
//
// Esc is deliberately NOT bound. Esc closes drawers and modals; the rail is
// persistent navigation, not an overlay, and overloading it would make one
// keypress unpredictable with a drawer open over a drilled rail.
//
// (`closeFlyouts` is gone. It was on `window`, but a repo-wide grep found no
// caller outside this file; its two internal callers now resolve the level
// instead of dismissing a panel — see the tab handler and goTab above.)

// Child tab → the rail group it lives under. This map is the real point of the
// change: sections are reached from the ⌘K palette, dashboard tiles, cross-links,
// salesGo() and plain reloads, and in every one of those the rail must ALREADY be
// sitting at the right level when the operator arrives. A rail that reports the
// wrong place is worse than the flyout it replaced.
const RAIL_PARENT = {
  vouchers: 'marketing', flash: 'marketing', popups: 'marketing',
  affiliate: 'marketing', sharing: 'marketing', broadcasts: 'marketing',
  social: 'marketing',
  membership: 'loyalty', topup: 'loyalty', leaderboard: 'loyalty', voting: 'loyalty',
  reviews: 'inbox', feedback: 'inbox',   // §271 — the rail's Inbox folder
  // "editor" is the Content group's INTERNAL id — the label changed, the id did
  // not, because the bottom-nav mirror, the CSS and TAB_CAP all key off it.
  // mini-app-editor is now an ordinary child row, not the group row.
  'mini-app-editor': 'editor', snippets: 'editor', about: 'editor',
  media: 'editor', legal: 'editor', faq: 'editor',
  // The Product Page Editor is not a second destination and there is no route to
  // it from Products: a link INSIDE the Mini App Editor swaps the same iframe.
  // Same tab, same page — so the rail stays on Content › Editor and must not
  // jump to Products.
  'product-editor': 'editor',
};
// Tabs with no rail row of their own → the row that stays lit while you are in
// there (§2.3: "the nearest ancestor that does have one"). A tab in neither map
// resolves to root highlighting itself; a tab with no rail row and no entry here
// resolves to root with nothing highlighted, which is the honest answer.
// Init function for a rail-less tab, keyed the same way as RAIL_STANDIN. A real
// rail button's own click handler used to fire these (mtAdminInit / gyAdminInit
// / elAdminInit); once those buttons were pulled during the Sales-page redesign,
// nothing called them any more — the tabs' markup and load logic were still
// there, just permanently dark. goTab's manual-activation fallback (below) now
// fires this directly so opening a channel admin from the Sales page actually
// populates it instead of showing a stale/empty section.
const TAB_INIT = {
  meituan: 'mtAdminInit', guanyi: 'gyAdminInit', eleme: 'elAdminInit',
  'channel-sync': 'csAdminInit',   // §103
  // The two Inbox tabs. They have rail rows since §271 (the rail button's own
  // listener loads them), so this only matters if a row is ever absent from the
  // DOM; both inits are idempotent, so the two paths never load twice.
  reviews: 'reviewsTabInit', feedback: 'feedbackTabInit',
};
const RAIL_STANDIN = {
  meituan: 'sales', guanyi: 'sales', gzgrocery: 'sales', eleme: 'sales',
  'channel-sync': 'sales',   // §103 — reached from the dashboard row and the Sales page
  'product-editor': 'mini-app-editor',
  // New order is a sub-page of Orders (§1.7a takeover) — the parent stays lit.
  'orders-new': 'orders',
  // One material is a sub-page of Materials, the same takeover.
  'materials-record': 'materials',
  // One recipe is a sub-page of Recipes, the same takeover (§29).
  'recipes-record': 'recipes',
  // A shop's menu is a sub-page of Sales → Locations (§41/§42), the same takeover.
  'shop-menu': 'sales',
};

var _railAnimTimer = null;  // var: the helpers below are hoisted and may be
                            // reached by an early tab activation.
function _railEl()           { return document.querySelector('.tabs'); }
function railGroupEl(id)     { return document.querySelector('.tabs .tabs-group[data-group="' + id + '"]'); }
function railOpenGroup()     { return document.querySelector('.tabs .tabs-group.rail-open'); }
function _railTrigger(g)     { return g ? g.querySelector('.tabs-group-trigger') : null; }
// Is this rail row gated away? Two gates hide, and they hide DIFFERENTLY:
//   • capability — applyCapGates writes an inline style.display, so read that.
//   • entitlement — a `body:not(.ent-X) [data-feat="X"]` CSS rule removes the
//     row; there is no inline style to read, hence the class check.
// Note what does NOT count as hidden: feature gating here is Option B — "off
// never hides a feature, it dims it". An entitled-but-OFF row stays in the rail,
// dimmed with an "Off" pill, so it is still a row the operator can reach and it
// still counts towards its folder. Only NOT ENTITLED takes a row out of the
// count. (The amendment's §2.5 example assumed feat-off hides; live does not.)
function _railRowHidden(b) {
  if (b.style.display === 'none') return true;
  const f = b.getAttribute('data-feat');
  return !!(f && !document.body.classList.contains('ent-' + f));
}
// A level's rows are its visible children — that is what makes the flatten/hide
// counts below honest.
function _railChildren(g) {
  if (!g) return [];
  return Array.prototype.filter.call(g.querySelectorAll('.tabs-popover [data-tab]'),
                                     b => !_railRowHidden(b));
}
// A rail row's visible label, icons and badges dropped. The i18n engine has
// already collapsed "English · 中文" to the live language in these text nodes,
// so this never glues the two halves.
function _railRowLabel(el) {
  if (!el) return '';
  const c = el.cloneNode(true);
  c.querySelectorAll('svg, .tab-badge, .tabs-flat-label').forEach(n => n.remove());
  return (c.textContent || '').replace(/\s+/g, ' ').trim();
}
function _railGroupLabel(g) {
  const trig = _railTrigger(g);
  return _railRowLabel(trig && trig.querySelector('.tabs-glabel') ? trig.querySelector('.tabs-glabel') : trig);
}
// Horizontal slide, 200ms ease-out — root out left / children in from the right,
// reversed on the way back. Deliberately NOT the drawer's 350ms settle: that is a
// heavier gesture over a longer distance, once per record; a level change is
// short, light and frequent. Recorded so a later pass does not "correct" the two
// into agreement. The attribute is cleared once the run is over so a row
// re-shown by applyCapGates doesn't inherit a stale animation.
function _railAnim(dir) {
  const rail = _railEl();
  if (!rail) return;
  rail.setAttribute('data-rail-anim', dir);
  clearTimeout(_railAnimTimer);
  _railAnimTimer = setTimeout(() => rail.removeAttribute('data-rail-anim'), 240);
}
function _railSyncAria() {
  $$('.tabs .tabs-group').forEach(g => {
    const trig = _railTrigger(g);
    if (trig) trig.setAttribute('aria-expanded', g.classList.contains('rail-open') ? 'true' : 'false');
  });
}
// The rail replacing its own contents is a silent change for anyone not looking
// at the column, so every level change is spoken.
function railAnnounceLevel() {
  const live = document.getElementById('railLevelLive');
  if (!live) return;
  const T = (typeof cuT === 'function') ? cuT : ((en) => en);
  const g = railOpenGroup();
  if (!g) { live.textContent = T('Main menu', '主菜单'); return; }
  const n = _railChildren(g).length;
  live.textContent = _railGroupLabel(g) + T(', ' + n + ' items', '，' + n + ' 项');
}
// Drill into a folder. `moveFocus` is for the drill GESTURE only — level
// resolution (arriving from the palette, a dashboard tile, a reload) must not
// steal focus from wherever the operator actually landed.
function railDrill(group, opts) {
  if (!group || !group.querySelector('.tabs-popover')) return;
  if (group.classList.contains('rail-flat')) return;   // flattened — not a folder
  const rail = _railEl();
  if (!rail) return;
  const already = group.classList.contains('rail-open');
  $$('.tabs .tabs-group.rail-open').forEach(g => g.classList.remove('rail-open'));
  group.classList.add('rail-open');
  rail.classList.add('rail-drilled');
  _railSyncAria();
  // `silent` skips the slide — used when the level is being RESTORED (unfolding
  // back into the folder you were already in), where the rail is already moving
  // and a second animation on top of the widening reads as a glitch.
  if (!already) { if (!(opts && opts.silent)) _railAnim('drill'); railAnnounceLevel(); }
  // Going forward → the top of the new list.
  if (opts && opts.moveFocus) { const first = _railChildren(group)[0]; if (first) first.focus(); }
}
// Return the rail to root. Also the single answer for "the level must reset":
// the back row, folding the rail, and a jump to a tab outside the open folder.
function railGoRoot(opts) {
  const rail = _railEl();
  if (!rail) return;
  const was = railOpenGroup();
  if (!was) return;                                     // already at root
  was.classList.remove('rail-open');
  rail.classList.remove('rail-drilled');
  _railSyncAria();
  if (!(opts && opts.silent)) _railAnim('back');
  railAnnounceLevel();
  // Coming back → the group row you came from, not the top of the rail.
  if (opts && opts.moveFocus) { const trig = _railTrigger(was); if (trig) trig.focus(); }
}
window.railGoRoot = railGoRoot;
window.railDrill = railDrill;
// Put the rail at the level that owns `tab`. Called on EVERY switch — rail
// clicks, palette jumps, salesGo(), dashboard drill-through, first paint.
// §2.1: picking a child leaves the rail drilled (Coupons → Flash sales is the
// common motion, and snapping back would charge a re-drill on every hop).
function railResolveFor(tab, opts) {
  const g = RAIL_PARENT[tab] ? railGroupEl(RAIL_PARENT[tab]) : null;
  if (g && g.style.display !== 'none' && !g.classList.contains('rail-flat')) railDrill(g, opts);
  else railGoRoot(opts);
}
window.railResolveFor = railResolveFor;

$$('.tabs .tabs-group').forEach(group => {
  const trig = _railTrigger(group);
  if (!trig || !group.querySelector('.tabs-popover')) return;
  trig.setAttribute('aria-expanded', 'false');
  trig.addEventListener('click', () => {
    // Flattened to one visible child: the row IS that child, so click it.
    if (group.classList.contains('rail-flat')) {
      const only = _railChildren(group)[0];
      if (only) only.click();
      return;
    }
    if (group.classList.contains('rail-open')) { railGoRoot({ moveFocus: true }); return; }
    // Folded + click a folder → unfold AND drill in one gesture. It stays
    // unfolded: the operator is now working inside a folder, and there is no
    // folded drilled state to fall back to (the children have no icons).
    if (document.body.classList.contains('nav-collapsed')) setNavCollapsed(false, { keepLevel: true });
    railDrill(group, { moveFocus: true });
  });
});
// A flattened row shows the CHILD's label, which is a plain string the i18n
// engine's node registry does not own — so re-derive it after every toggle,
// once the engine has rewritten the child it was copied from.
if (window.onLangChange) window.onLangChange(() => { railSyncGroups(); railAnnounceLevel(); });
railSyncGroups();
// First paint. The page opens on whatever row the markup marks active — read it
// rather than assuming root, so this keeps holding if the landing tab changes or
// a deep link is ever added.
(function _railInitLevel() {
  const active = document.querySelector('.tabs [data-tab].active');
  if (active) railResolveFor(active.dataset.tab);
})();

// ── Collapsible rail ──────────────────────────────────────────────────────
// #railSeamFold — which lives at the TOP OF THE RAIL, not the topbar (it was
// re-parented 2026-07-24; an older comment here still said topbar) — folds the
// rail to an icon-only strip; the pre-paint snippet in the page restores the
// last state, and this keeps it in sync.
// While collapsed the CSS zeroes each label, so we mirror the label into a
// native `title` — hovering an icon still names it — and clear those titles
// again on expand so we don't double up with the visible text.
const NAV_COLLAPSE_KEY = 'ra:navCollapsed';
function _navRailLabel(b) {
  // Group rows carry their label in a span (.tabs-glabel), and a FLATTENED group
  // carries the child's label in a second one (.tabs-flat-label) — so read the
  // span that is actually showing, and fall back to the direct text nodes that
  // every plain rail button uses.
  const flat = b.querySelector && b.querySelector('.tabs-flat-label');
  if (flat && (flat.textContent || '').trim()) return flat.textContent.replace(/\s+/g, ' ').trim();
  const span = b.querySelector && b.querySelector('.tabs-glabel');
  if (span) return (span.textContent || '').replace(/\s+/g, ' ').trim();
  return Array.prototype.filter.call(b.childNodes, n => n.nodeType === 3)
    .map(n => n.textContent).join('').replace(/\s+/g, ' ').trim();
}
function _navRailButtons() {
  return $$('.tabs > button, .tabs .tabs-group-trigger');
}
function setNavCollapsed(on, opts) {
  on = !!on;
  // Drilled + fold → return to root FIRST, then fold. There is no folded drilled
  // state: the children are words with no icons, so a folded drilled rail would
  // have nothing to draw. (This is also why the old outside-click handler's
  // #railSeamFold exemption is gone — it existed to PRESERVE an open flyout
  // across a fold, which is the opposite of what the level needs to do.)
  if (on) railGoRoot();
  document.body.classList.toggle('nav-collapsed', on);
  // …and unfolding puts the level BACK, read off the page you're actually on:
  // fold while sitting in Coupons and unfold, and the rail returns to Marketing,
  // not to root. Folding is a way to make room, not a way to leave the folder.
  // `keepLevel` is for the one caller that is about to set the level itself
  // (clicking a folder row while folded), so it doesn't drill twice.
  if (!on && !(opts && opts.keepLevel)) {
    const active = document.querySelector('.tabs [data-tab].active');
    if (active) railResolveFor(active.dataset.tab, { silent: true });
  }
  try { localStorage.setItem(NAV_COLLAPSE_KEY, on ? '1' : '0'); } catch (e) {}
  // Keep the fold control's state in sync — its tooltip/aria flip with the fold,
  // and the filled↔hollow side-panel glyph is handled in CSS off
  // body.nav-collapsed. aria-pressed=true means "rail is folded".
  const btn = document.getElementById('railSeamFold');
  if (btn) {
    const T = (typeof cuT === 'function') ? cuT : ((en) => en);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? T('Show sidebar', '显示侧栏') : T('Hide sidebar', '隐藏侧栏');
    btn.setAttribute('aria-label', btn.title);
  }
  _navRailButtons().forEach(b => {
    const label = _navRailLabel(b);
    if (on) { if (label) b.title = label; }
    else if (b.title === label) b.removeAttribute('title');
  });
}
function toggleNavCollapse() {
  setNavCollapsed(!document.body.classList.contains('nav-collapsed'));
}
window.setNavCollapsed = setNavCollapsed;
window.toggleNavCollapse = toggleNavCollapse;
// Sync button state + tooltips to whatever the pre-paint snippet restored.
setNavCollapsed(document.body.classList.contains('nav-collapsed'));
// The rail is persistent navigation, not an overlay: a level stays put while you
// work in the content area. Nothing dismisses it by clicking away, and Esc is not
// bound to it — only the back row, folding, or moving to a tab outside the open
// folder returns it to root.
// ── Categories — "the shelf" (Products → Categories sub-view) ─────────────
// Rebuilt from scratch 2026-07-10 (was a standalone tab of paired input boxes).
//
// The left rail IS the shop's left rail: same categories, same order, so
// dragging a row rearranges the store. The pane holds one category whole — its
// name, its section headings, and the products standing on it — which is why
// the old slide-in detail drawer is gone. Names are plain text until clicked;
// clicking opens a rename card with the English and Chinese names side by side.
// The tree saves itself ~1.2s after the last edit; the server re-tags every
// product under a renamed node (matched by stable id), so a rename never
// orphans a product. That re-tag is the only automation on the page, and the
// only thing wearing Dusk.
let catModel = [];        // working copy: [{ id, name, name_cn, subs:[{id,name,name_cn}] }]
let catClean = '[]';      // JSON of the last-saved tree, for dirty tracking
let catLoaded = false;
let catCounts = {};       // nodeId -> { n, published }, from /category-counts
let catSel = 0;           // index of the top category the pane is showing
let catEdit = null;       // open rename card: { kind:'top'|'sub', ti, si, name, name_cn }
// §297 — the open shelf's products, for the banner's link list. Held apart
// from _catProdRows, which an empty shelf leaves holding the last shelf's.
let _catBannerRows = [];
let _catLangHooked = false;
// §288 — the QR menu's own order. The tree (catModel) is still the one tree:
// names, subcategories and products are shared. In 'qr' mode the rail, the
// subcategory list and the shelf's products are drawn in the QR menu's order,
// dragging rearranges that order and not the tree, and the eye hides a
// category on the QR menu only.
// Same shape the server stores (lib/qr-menu-category-order.js).
let catMode = 'miniapp';  // 'miniapp' | 'qr'
let catQr = { tops: null, subs: {}, hidden: [], products: {} };
let catQrClean = JSON.stringify(catQr);

const CAT_ICON = {
  grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.7"/><circle cx="15" cy="5" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="19" r="1.7"/><circle cx="15" cy="19" r="1.7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  pen:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M10 11v6M14 11v6"/></svg>',
  box:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
};

// Counts arrive keyed by the node's stable id, so an unsaved rename in the
// editor doesn't have to match by name. A node that has never been saved has
// no id, and therefore no products — null, not zero, so the pane can say "new".
function catCount(node) { return (node && node.id && catCounts[node.id]) || null; }

async function catLoad() {
  try {
    const [tree, counts, qr] = await Promise.all([
      api('/api/retail-admin/category-tree'),
      api('/api/retail-admin/category-counts').catch(() => ({ counts: {} })),
      api('/api/retail-admin/category-tree/qr-order').catch(() => ({ data: null })),
    ]);
    catModel = Array.isArray(tree.data) ? JSON.parse(JSON.stringify(tree.data)) : [];
    catClean = JSON.stringify(catModel);
    catCounts = counts.counts || {};
    catQr = catQrNormalise(qr && qr.data);
    catQrClean = JSON.stringify(catQr);
    catLoaded = true;
    catEdit = null;
    if (catSel >= catModel.length) catSel = 0;
    if (!_catLangHooked && window.onLangChange) { _catLangHooked = true; onLangChange(catRenderAll); }
    catRenderAll();
  } catch (e) { toast(cuT('Could not load the categories', '加载分类失败'), 'err'); }
}

// Re-read the counts after a save (new nodes just got ids; a removed node's
// products keep their stale tag until re-assigned). Never blocks the render.
async function catRefreshCounts() {
  try { const j = await api('/api/retail-admin/category-counts'); catCounts = j.counts || {}; } catch (e) {}
}

// ── Dirty tracking + autosave ──────────────────────────────────────────────
// Every top and sub needs an English name before the tree can be saved (mirrors
// the server guard). Autosave waits silently until that holds — a half-typed
// name never throws an error toast.
function catIsDirty() { return JSON.stringify(catModel) !== catClean; }
function catIsValid() {
  for (const t of catModel) {
    if (!String(t.name || '').trim()) return false;
    for (const s of (t.subs || [])) if (!String(s.name || '').trim()) return false;
  }
  return true;
}
let _catSaveTimer = null;
let _catSaving = false;
function catScheduleAutosave() {
  if (_catSaveTimer) clearTimeout(_catSaveTimer);
  _catSaveTimer = setTimeout(() => {
    _catSaveTimer = null;
    if (_catSaving || !catIsDirty() || !catIsValid()) return;
    catSave({ auto: true });
  }, 1200);
}
function catUpdateDirty() {
  catRenderStatus();
  if (catIsDirty()) catScheduleAutosave();
}

async function catSave(opts) {
  const auto = !!(opts && opts.auto);
  if (!catLoaded) return;
  // Publish now also sends a waiting QR-menu order change (§288) straight away.
  if (!auto && _catQrTimer) { clearTimeout(_catQrTimer); _catQrTimer = null; catQrSave(); }
  for (const t of catModel) {
    if (!String(t.name || '').trim()) { if (!auto) toast(cuT('Every top category needs an English name', '主分类需填英文名'), 'err'); return; }
    for (const s of (t.subs || [])) {
      if (!String(s.name || '').trim()) { if (!auto) toast(cuT('Every subcategory needs an English name', '子分类需填英文名'), 'err'); return; }
    }
  }
  if (_catSaving) return;
  _catSaving = true;
  if (_catSaveTimer) { clearTimeout(_catSaveTimer); _catSaveTimer = null; }
  catRenderStatus();
  try {
    const j = await api('/api/retail-admin/category-tree', { method: 'PUT', body: { tree: catModel } });
    catModel = Array.isArray(j.data) ? JSON.parse(JSON.stringify(j.data)) : catModel;
    catClean = JSON.stringify(catModel);
    await catRefreshCounts();
    // Invalidate the product editor's cached tree so its Shop-section /
    // Subcategory dropdowns pick up the renamed, added or removed nodes.
    if (typeof PA_CAT_TREE !== 'undefined') PA_CAT_TREE = [];
    // A repaint would tear down an open rename card mid-typing, so an autosave
    // that lands while one is open only refreshes the quiet status line.
    if (catEdit) catRenderStatus(); else catRenderAll();
    const moved = j.migrated || 0;
    // Manual save always confirms. Autosave stays quiet unless it re-tagged
    // products — a real side effect, worth a word.
    if (!auto) toast(moved ? cuT(`Saved · ${moved} product${moved === 1 ? '' : 's'} re-tagged`, `已保存 · 迁移 ${moved} 个产品`) : cuT('Saved', '已保存'), 'ok');
    else if (moved) toast(cuT(`${moved} product${moved === 1 ? '' : 's'} re-tagged`, `已迁移 ${moved} 个产品`), 'ok');
  } catch (e) {
    toast((e && e.message) ? cuT('Save failed: ' + e.message, '保存失败: ' + e.message) : cuT('Save failed', '保存失败'), 'err');
  } finally {
    _catSaving = false;
    catUpdateDirty();   // refresh the line; reschedules if edits arrived mid-save
  }
}

// ── §288 · The QR menu's own order ─────────────────────────────────────────
// Mirrors lib/qr-menu-category-order.js: ids the order names come first, in
// its order; anything it does not name (a category added later, or one never
// saved) follows in the tree's order. `tops: null` = follow the mini app.
function catQrNormalise(v) {
  const o = v && typeof v === 'object' ? v : {};
  const subs = {};
  if (o.subs && typeof o.subs === 'object') for (const k of Object.keys(o.subs)) if (Array.isArray(o.subs[k])) subs[k] = o.subs[k].slice();
  const products = {};
  if (o.products && typeof o.products === 'object') for (const k of Object.keys(o.products)) if (Array.isArray(o.products[k])) products[k] = o.products[k].slice();
  return {
    tops: Array.isArray(o.tops) && o.tops.length ? o.tops.slice() : null,
    subs,
    hidden: Array.isArray(o.hidden) ? o.hidden.slice() : [],
    products,
  };
}
function catQrOrdered(items, ids, nodeOf) {
  if (!ids || !ids.length) return items;
  const pos = new Map(ids.map((id, i) => [id, i]));
  const has = (x) => { const n = nodeOf(x); return !!(n.id && pos.has(n.id)); };
  return items.filter(has).sort((a, b) => pos.get(nodeOf(a).id) - pos.get(nodeOf(b).id))
    .concat(items.filter(x => !has(x)));
}
// The rail as it is drawn: [{ t, ti }], ti being the index in catModel, so
// selecting, renaming and removing keep working on the one tree.
function catRailList() {
  const all = catModel.map((t, ti) => ({ t, ti }));
  return catMode === 'qr' ? catQrOrdered(all, catQr.tops, x => x.t) : all;
}
function catSubList(ti) {
  const t = catModel[ti];
  const all = ((t && t.subs) || []).map((s, si) => ({ s, si }));
  return catMode === 'qr' && t && t.id ? catQrOrdered(all, catQr.subs[t.id], x => x.s) : all;
}
function catQrHidden(t) { return !!(t && t.id && catQr.hidden.indexOf(t.id) >= 0); }
function catQrIsCustom() {
  return !!catQr.tops || Object.keys(catQr.subs).some(k => (catQr.subs[k] || []).length)
    || Object.keys(catQr.products).some(k => (catQr.products[k] || []).length);
}

function catSetMode(mode) {
  if (mode !== 'miniapp' && mode !== 'qr') return;
  catMode = mode;
  catEdit = null;
  document.querySelectorAll('#cat2-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  const hm = document.getElementById('cat2-hint-miniapp');
  const hq = document.getElementById('cat2-hint-qr');
  if (hm) hm.hidden = mode !== 'miniapp';
  if (hq) hq.hidden = mode !== 'qr';
  catRenderAll();
}

function catQrToggleHide(ti) {
  const t = catModel[ti];
  if (!t || !t.id) return;          // a category never saved has no id yet
  const i = catQr.hidden.indexOf(t.id);
  if (i >= 0) catQr.hidden.splice(i, 1); else catQr.hidden.push(t.id);
  catRenderStatus(); catRenderRail();
  if (ti === catSel) catRenderPane();
  catQrScheduleSave();
}
function catQrReset() {
  catQr.tops = null;
  catQr.subs = {};
  catQr.products = {};
  catRenderAll();
  catQrScheduleSave();
}

let _catQrTimer = null;
let _catQrSaving = false;
function catQrScheduleSave() {
  if (_catQrTimer) clearTimeout(_catQrTimer);
  _catQrTimer = setTimeout(() => { _catQrTimer = null; catQrSave(); }, 800);
}
async function catQrSave() {
  if (JSON.stringify(catQr) === catQrClean) return;
  if (_catQrSaving) { catQrScheduleSave(); return; }
  _catQrSaving = true;
  const sent = JSON.stringify(catQr);
  try {
    await api('/api/retail-admin/category-tree/qr-order', { method: 'PUT', body: JSON.parse(sent) });
    catQrClean = sent;
  } catch (e) {
    toast((e && e.message) ? cuT('Save failed: ' + e.message, '保存失败: ' + e.message) : cuT('Save failed', '保存失败'), 'err');
  } finally {
    _catQrSaving = false;
  }
}

// ── The status line — one sentence where three KPI tiles used to be ────────
// Tops, subs, and the one fact that costs money: which shelves the shop is
// hiding because nothing published stands on them.
function catRenderStatus() {
  const facts = document.getElementById('cat2-facts');
  const save = document.getElementById('cat2-save');
  if (!facts) return;
  if (catMode === 'qr') {
    const sep = '<span class="cat2-fact-sep"></span>';
    const nHidden = catModel.filter(catQrHidden).length;
    facts.innerHTML = catQrIsCustom()
      ? `<span class="cat2-fact"><span class="cat2-fact-dot"></span><span class="k">${escapeHtml(cuT('Own order for the QR menu', '二维码菜单独立顺序'))}</span></span>` +
        `<button class="cat2-btn cat2-btn-ghost" type="button" onclick="catQrReset()">${escapeHtml(cuT('Reset to mini app order', '重置为小程序顺序'))}</button>`
      : `<span class="cat2-fact"><span class="cat2-fact-dot"></span><span class="k">${escapeHtml(cuT('Same order as the mini app', '与小程序顺序相同'))}</span></span>`;
    if (nHidden) facts.innerHTML += sep + `<span class="cat2-fact warn"><span class="cat2-fact-dot"></span><b>${fcNum(nHidden)}</b>&nbsp;<span class="k">${escapeHtml(cuT('hidden on the QR menu', '二维码菜单已隐藏'))}</span></span>`;
    return;
  }
  let subs = 0;
  const hidden = [];   // saved nodes with nothing published under them
  for (const t of catModel) {
    subs += (t.subs || []).length;
    const tc = catCount(t);
    if (tc && !tc.published) hidden.push(t.name);
    for (const s of (t.subs || [])) {
      const sc = catCount(s);
      if (sc && !sc.published) hidden.push(s.name);
    }
  }
  const sep = '<span class="cat2-fact-sep"></span>';
  let shelfFact;
  if (!hidden.length) {
    shelfFact = `<span class="cat2-fact"><span class="cat2-fact-dot"></span><span class="k">${escapeHtml(cuT('every shelf is visible in the shop', '所有分类都显示在店面'))}</span></span>`;
  } else if (hidden.length === 1) {
    shelfFact = `<span class="cat2-fact warn"><span class="cat2-fact-dot"></span><span class="k">${escapeHtml(cuT(`“${hidden[0]}” is hidden — nothing published on it`, `“${hidden[0]}” 已隐藏 — 无上架产品`))}</span></span>`;
  } else {
    shelfFact = `<span class="cat2-fact warn"><span class="cat2-fact-dot"></span><span class="k">${escapeHtml(cuT(`${hidden.length} shelves hidden — nothing published on them`, `${hidden.length} 个分类已隐藏 — 无上架产品`))}</span></span>`;
  }
  facts.innerHTML =
    `<span class="cat2-fact"><b>${fcNum(catModel.length)}</b>&nbsp;<span class="k">${escapeHtml(cuT('top categories', '主分类'))}</span></span>${sep}` +
    `<span class="cat2-fact"><b>${fcNum(subs)}</b>&nbsp;<span class="k">${escapeHtml(cuT('subcategories', '子分类'))}</span></span>${sep}` +
    shelfFact;
  if (save) {
    const dirty = catIsDirty();
    let txt = '', wait = false;
    if (_catSaving) txt = cuT('Saving…', '保存中…');
    else if (!dirty) txt = cuT('Saved · changes save themselves', '已保存 · 更改自动保存');
    else if (!catIsValid()) { txt = cuT('Add a name to save', '填写名称后保存'); wait = true; }
    else txt = cuT('Saving…', '保存中…');
    save.textContent = txt;
    save.classList.toggle('wait', wait);
  }
}

// ── The rail — the shop's own left column ──────────────────────────────────
function catRenderRail() {
  const host = document.getElementById('cat2-rail');
  if (!host) return;
  if (!catModel.length) {
    host.innerHTML = `<div class="cat2-empty" style="padding:10px 18px">${escapeHtml(cuT('No categories yet', '暂无分类'))}</div>`;
    return;
  }
  // `p` is the row's place in the rail as drawn — what a drag moves. `ti` is
  // its index in catModel — what selecting and renaming act on. In the mini
  // app's rail the two are the same number; in the QR menu's they are not.
  const qr = catMode === 'qr';
  host.innerHTML = catRailList().map(({ t, ti }, p) => {
    const c = catCount(t);
    const dark = c && !c.published;
    const off = qr && catQrHidden(t);
    const eye = qr && t.id
      ? `<span class="cat2-icon cat2-eye" role="button" tabindex="0" aria-pressed="${off ? 'true' : 'false'}"
            title="${escapeAttr(off ? cuT('Hidden on the QR menu — click to show', '二维码菜单已隐藏,点击显示') : cuT('Shows on the QR menu — click to hide', '在二维码菜单显示,点击隐藏'))}"
            onclick="event.stopPropagation();catQrToggleHide(${ti})"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();catQrToggleHide(${ti})}">${off ? CAT_ICON.eyeOff : CAT_ICON.eye}</span>`
      : '';
    return `<button type="button" class="cat2-railrow cat2-row${ti === catSel ? ' on' : ''}${off ? ' qr-off' : ''}" data-fk="t${catFk(t)}"
        onclick="catSelect(${ti})">
      <span class="cat2-grip" draggable="true" title="${escapeAttr(cuT('Drag to reorder', '拖动排序'))}"
            onclick="event.stopPropagation()"
            ondragstart="catDragStart(event,'top',${p})" ondragend="catDragEnd()">${CAT_ICON.grip}</span>
      <span class="nm">${escapeHtml(t.name || cuT('Untitled', '未命名'))}</span>
      ${dark ? '<span class="cat2-fact-dot" title="' + escapeAttr(cuT('Hidden — nothing published', '已隐藏 — 无上架产品')) + '"></span>' : ''}
      ${eye}
      <span class="n">${c ? fcNum(c.n) : '—'}</span>
    </button>`;
  }).join('');
}

// ── The pane — one category, whole ─────────────────────────────────────────
function catRenderPane() {
  const host = document.getElementById('cat2-pane');
  if (!host) return;
  const t = catModel[catSel];
  if (!t) {
    host.innerHTML = `<div class="cat2-empty">${escapeHtml(cuT('Add a top category to start arranging the shop.', '新增一个主分类，开始整理店面。'))}</div>`;
    return;
  }
  const c = catCount(t);
  const subs = t.subs || [];
  _catBannerRows = [];      // this shelf's products are loaded below (catLoadProducts)
  const pill = !c ? `<span class="cat2-pill cat2-pill-new">${escapeHtml(cuT('new — not saved yet', '新建 — 尚未保存'))}</span>`
    : c.published ? `<span class="cat2-pill cat2-pill-live">${escapeHtml(cuT('visible in the shop', '显示在店面'))}</span>`
    : `<span class="cat2-pill cat2-pill-hidden">${escapeHtml(cuT('hidden — nothing published', '已隐藏 — 无上架产品'))}</span>`;
  const qrPill = catMode === 'qr' && catQrHidden(t)
    ? `<span class="cat2-pill cat2-pill-hidden">${escapeHtml(cuT('Hidden on the QR menu', '二维码菜单已隐藏'))}</span>` : '';

  host.innerHTML = `
    <div class="cat2-panehead cat2-row" id="cat2-tophead">
      <div style="min-width:0">
        <h3 tabindex="0" title="${escapeAttr(cuT('Click to rename', '点击重命名'))}" onclick="catOpenRename('top',${catSel},-1)">${escapeHtml(t.name || cuT('Untitled', '未命名'))}<button class="cat2-icon cat2-pen-inline" type="button" title="${escapeAttr(cuT('Rename', '重命名'))}" onclick="event.stopPropagation();catOpenRename('top',${catSel},-1)">${CAT_ICON.pen}</button></h3>
        <div class="cat2-panemeta">
          <span>${escapeHtml(cuT(`${fcNum(subs.length)} subcategories`, `${fcNum(subs.length)} 个子分类`))}</span>
          <span>·</span>
          <span>${escapeHtml(c ? cuT(`${fcNum(c.n)} products`, `${fcNum(c.n)} 件产品`) : cuT('no products yet', '暂无产品'))}</span>
          ${pill}${qrPill}
        </div>
      </div>
      <div class="end">
        <button class="cat2-icon danger" type="button" title="${escapeAttr(cuT('Remove category', '删除主分类'))}" onclick="catRemoveTop(${catSel})">${CAT_ICON.trash}</button>
      </div>
    </div>
    <div id="cat2-tophead-rename"></div>

    <div id="cat2-banner">${catBannerHtml(t)}</div>

    <div ondragover="catDragOver(event,'sub')" ondrop="catDrop(event,'sub')" ondragleave="catDragLeave(event)">
    <div class="cat2-sec">${escapeHtml(cuT('Subcategories — the section headings', '子分类 — 区块标题'))}</div>
    <div id="cat2-subs">${catSubList(catSel).map(({ s, si }, p) => catSubRowHtml(s, si, p)).join('')
      || `<div class="cat2-empty">${escapeHtml(cuT('No section headings yet. Products land straight under the category.', '暂无区块标题。产品将直接归入该主分类。'))}</div>`}</div>
    <button class="cat2-btn cat2-btn-ghost" type="button" style="margin-top:10px" onclick="catAddSub(${catSel})">${CAT_ICON.plus}<span>${escapeHtml(cuT('Add subcategory', '新增子分类'))}</span></button>
    </div>

    <div class="cat2-sec" style="margin-top:34px">${escapeHtml(cuT('Products on this shelf', '货架上的产品'))}</div>
    <div id="cat2-prods"><div class="cat2-empty">${escapeHtml(cuT('Loading…', '加载中…'))}</div></div>
  `;
  catRenderOpenRename();
  catLoadProducts();
}

// ── §297 · A category's banner ──────────────────────────────────────────────
// One wide 5:2 picture per TOP category, drawn at the top of its section on
// the mini app's Shop tab. It lives on the tree node (`banner`), so it moves
// with the category when the category is dragged or renamed, and saves with
// the tree like every other edit here (autosave). The server keeps only a
// usable one (lib/category-tree.js sanitizeBanner).
//
// "Today" is China's day, and the status words are the pop-ups' own
// (05-marketing.js puStatus), because the fields are the same start/end days.
function catBannerToday() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function catBannerStatus(b) {
  const today = catBannerToday();
  if (b.start_at && today < b.start_at) return { cls: 'cat2-pill-hidden', label: cuT('Starts ', '待开始 ') + b.start_at };
  if (b.end_at && today > b.end_at)     return { cls: 'cat2-pill-new',    label: cuT('Ended ', '已结束 ') + b.end_at };
  return { cls: 'cat2-pill-live', label: cuT('Live', '进行中') };
}
// The link picker's pages a banner most often wants, in its own words
// (cms.html TARGET_PAGES), plus the products standing on this shelf.
const CAT_BANNER_PAGES = [
  { v: 'promotions', en: 'Promotions page', cn: '促销页面' },
  { v: 'coupons',    en: 'Coupons',         cn: '优惠券' },
  { v: 'membership', en: 'Membership',      cn: '会员' },
  { v: 'shop',       en: 'Shop',            cn: '商店' },
];
function catBannerHtml(t) {
  const b = t && t.banner;
  const head = `<div class="cat2-sec" style="margin-top:26px">${escapeHtml(cuT('Banner (optional)', '横幅(可选)'))}</div>`;
  const hint = `<div class="cat2-empty">${escapeHtml(cuT('A wide picture, 5 : 2, shown at the top of this category on the mini app\'s Shop tab. Hidden while a customer is searching.', '宽幅图片,比例 5 : 2,显示在小程序「商品」页该分类的顶部。顾客搜索时隐藏。'))}</div>`;
  const file = '<input type="file" id="cat2-banner-file" accept="image/*" hidden onchange="catBannerPicked(this)">';
  if (!b || !b.image_url) {
    return head + hint + file +
      `<button class="cat2-btn cat2-btn-ghost" type="button" onclick="catBannerPick()">${CAT_ICON.plus}<span>${escapeHtml(cuT('Add banner', '添加横幅'))}</span></button>`;
  }
  const st = catBannerStatus(b);
  return head + file + `
    <div class="cat2-banner">
      <div class="cat2-banner-pic"><img src="${escapeAttr(b.image_url)}" alt=""></div>
      <div class="cat2-banner-side">
        <div><span class="cat2-pill ${st.cls}">${escapeHtml(st.label)}</span></div>
        <label class="cat2-banner-lbl" for="cat2-banner-target">${escapeHtml(cuT('Tap link', '点击跳转'))}</label>
        <select id="cat2-banner-target" onchange="catBannerSet('target', this.value)">${catBannerTargetOptions(b.target)}</select>
        <div class="cat2-banner-dates">
          <label class="cat2-banner-lbl">${escapeHtml(cuT('Start', '开始'))}<input type="date" value="${escapeAttr(b.start_at || '')}" onchange="catBannerSet('start_at', this.value)"></label>
          <label class="cat2-banner-lbl">${escapeHtml(cuT('End', '结束'))}<input type="date" value="${escapeAttr(b.end_at || '')}" onchange="catBannerSet('end_at', this.value)"></label>
        </div>
        <div class="cat2-banner-hint">${escapeHtml(cuT('Leave both empty to show it always. Outside its dates it hides by itself.', '两者留空则一直显示。不在日期内时会自动隐藏。'))}</div>
        <div class="cat2-banner-acts">
          <button class="cat2-btn" type="button" onclick="catBannerPick()">${escapeHtml(cuT('Replace picture', '更换图片'))}</button>
          <button class="cat2-btn cat2-btn-danger" type="button" onclick="catBannerRemove()">${CAT_ICON.trash}<span>${escapeHtml(cuT('Remove banner', '删除横幅'))}</span></button>
        </div>
      </div>
    </div>` + hint;
}
function catBannerTargetOptions(current) {
  const cur = current || '';
  const opt = (v, label) => `<option value="${escapeAttr(v)}"${v === cur ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const rows = _catBannerRows;
  const prods = rows.map(p => opt('product:' + p.id, cuT(p.name_en || p.name_cn, p.name_cn || p.name_en) || ('#' + p.id)));
  // A saved link that is not in either list (a product since moved, a page
  // set elsewhere) is kept as it is, never silently swapped for another.
  const known = [''].concat(CAT_BANNER_PAGES.map(x => x.v), rows.map(p => 'product:' + p.id));
  const keep = cur && !known.includes(cur) ? opt(cur, cur) : '';
  return opt('', cuT('Picture only', '仅图片')) + keep +
    `<optgroup label="${escapeAttr(cuT('Pages', '页面'))}">${CAT_BANNER_PAGES.map(x => opt(x.v, cuT(x.en, x.cn))).join('')}</optgroup>` +
    (prods.length ? `<optgroup label="${escapeAttr(cuT('Products on this shelf', '货架上的产品'))}">${prods.join('')}</optgroup>` : '');
}
// The shelf's products arrive after the pane is drawn; refill the link list
// then, keeping whatever is chosen (_catBannerRows, declared with the
// shelf's other state above).
function catBannerFillTargets() {
  const sel = document.getElementById('cat2-banner-target');
  const t = catModel[catSel];
  if (sel && t && t.banner) sel.innerHTML = catBannerTargetOptions(t.banner.target);
}
function catBannerRepaint() {
  const host = document.getElementById('cat2-banner');
  if (host) host.innerHTML = catBannerHtml(catModel[catSel]);
}
function catBannerSet(key, value) {
  const t = catModel[catSel];
  if (!t || !t.banner) return;
  t.banner = { ...t.banner, [key]: value || '' };
  if (key !== 'target') catBannerRepaint();   // the status pill follows the dates
  catUpdateDirty();
}
function catBannerPick() { const f = document.getElementById('cat2-banner-file'); if (f) { f.value = ''; f.click(); } }
async function catBannerPicked(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const ti = catSel;   // the category the picture was chosen for, even if the operator moves on
  toast(cuT('Uploading…', '上传中…'));
  try {
    // Shrink in the browser first (1600px long side) when the product
    // editor's resizer is on the page — it is, on this admin.
    let blob = file;
    if (typeof pdResizeImage === 'function') {
      const r = await pdResizeImage(file, { maxLong: 1600, quality: 0.88 });
      if (r && r.dataURL) blob = await (await fetch(r.dataURL)).blob();
    }
    const fd = new FormData();
    fd.append('file', blob, file.name || 'banner.jpg');
    const res = await fetch('/api/retail-admin/cms/media', { method: 'POST', credentials: 'same-origin', body: fd });
    if (res.status === 401) { location.href = '/backend/login'; return; }
    const j = await res.json();
    if (!j.success || !j.data || !j.data.url) throw new Error(j.error || 'upload_failed');
    const t = catModel[ti];
    if (!t) return;
    t.banner = { target: '', start_at: '', end_at: '', ...(t.banner || {}), image_url: j.data.url };
    if (ti === catSel) catBannerRepaint();
    catUpdateDirty();
  } catch (e) {
    toast(cuT('Upload failed', '上传失败') + ': ' + e.message, 'err');
  }
}
function catBannerRemove() {
  const t = catModel[catSel];
  if (!t || !t.banner) return;
  delete t.banner;
  catBannerRepaint();
  catUpdateDirty();
}

// `p` is the row's place as drawn (what a drag moves); `si` its index in the
// tree (what rename and remove act on). Equal except in the QR menu's order.
function catSubRowHtml(s, si, p) {
  if (p == null) p = si;
  const c = catCount(s);
  const hidden = c && !c.published;
  return `<div class="cat2-sub cat2-row" id="cat2-sub-${si}" data-fk="s${catFk(s)}">
    <span class="cat2-grip" draggable="true" title="${escapeAttr(cuT('Drag to reorder', '拖动排序'))}"
          ondragstart="catDragStart(event,'sub',${p})" ondragend="catDragEnd()">${CAT_ICON.grip}</span>
    <span class="cat2-subname" tabindex="0" title="${escapeAttr(cuT('Click to rename', '点击重命名'))}" onclick="catOpenRename('sub',${catSel},${si})">${escapeHtml(s.name || cuT('Untitled', '未命名'))}<button class="cat2-icon cat2-pen-inline" type="button" title="${escapeAttr(cuT('Rename', '重命名'))}" onclick="event.stopPropagation();catOpenRename('sub',${catSel},${si})">${CAT_ICON.pen}</button></span>
    ${hidden ? `<span class="cat2-pill cat2-pill-hidden">${escapeHtml(cuT('hidden', '已隐藏'))}</span>` : ''}
    <span class="n">${escapeHtml(c ? cuT(`${fcNum(c.n)} products`, `${fcNum(c.n)} 件产品`) : cuT('new', '新建'))}</span>
    <span class="cat2-acts">
      <button class="cat2-icon danger" type="button" title="${escapeAttr(cuT('Remove subcategory', '删除子分类'))}" onclick="catRemoveSub(${catSel},${si})">${CAT_ICON.trash}</button>
    </span>
  </div>`;
}

function catRenderAll() { catRenderStatus(); catRenderRail(); catRenderPane(); }

function catSelect(ti) {
  if (ti === catSel) return;
  catEdit = null;
  catSel = ti;
  catRenderRail(); catRenderPane();
}

// ── The rename card — English and Chinese together, in place ───────────────
// Typing edits the live model (so the tree autosaves like every other change);
// Cancel puts back the names the card opened with. The breathing Dusk dot is
// the page's only Dusk: on save, the server re-tags every product underneath.
function catOpenRename(kind, ti, si) {
  const node = kind === 'sub' ? (catModel[ti] && catModel[ti].subs[si]) : catModel[ti];
  if (!node) return;
  catEdit = { kind, ti, si, name: node.name || '', name_cn: node.name_cn || '' };
  catRenderOpenRename();
}
function catCloseRename(revert) {
  if (!catEdit) return;
  const { kind, ti, si, name, name_cn } = catEdit;
  const node = kind === 'sub' ? (catModel[ti] && catModel[ti].subs[si]) : catModel[ti];
  catEdit = null;
  if (revert && node) {
    // A brand-new node cancelled before it was ever named leaves nothing behind.
    if (!node.id && !String(name).trim()) {
      if (kind === 'sub') catModel[ti].subs.splice(si, 1); else catModel.splice(ti, 1);
      if (catSel >= catModel.length) catSel = Math.max(0, catModel.length - 1);
      catRenderAll(); catUpdateDirty();
      return;
    }
    node.name = name; node.name_cn = name_cn;
  }
  catRenderAll();
  catUpdateDirty();
}
async function catSaveRename() {
  if (!catEdit) return;
  const { kind, ti, si } = catEdit;
  const node = kind === 'sub' ? catModel[ti].subs[si] : catModel[ti];
  if (!node || !String(node.name || '').trim()) {
    toast(cuT('Give it an English name first', '请先填写英文名'), 'err');
    return;                            // the card stays open, waiting
  }
  catEdit = null;
  catRenderAll();
  await catSave();
}
// Live-edit the model as the operator types. No re-render — the caret stays put.
function catRenameInput(field, val) {
  if (!catEdit) return;
  const { kind, ti, si } = catEdit;
  const node = kind === 'sub' ? (catModel[ti] && catModel[ti].subs[si]) : catModel[ti];
  if (!node) return;
  node[field] = val;
  // Keep the heading being renamed in step with the typing — and, for a top
  // category, the rail row that names the same shelf.
  if (field === 'name') {
    const shown = val || cuT('Untitled', '未命名');
    if (kind === 'sub') {
      const live = document.querySelector(`#cat2-sub-${si} .cat2-subname`);
      if (live) live.textContent = shown;
    } else {
      const head = document.querySelector('#cat2-tophead h3');
      if (head) head.textContent = shown;
      const rail = document.querySelector('.cat2-railrow.on .nm');
      if (rail) rail.textContent = shown;
    }
  }
  catUpdateDirty();
}
// Paint the card into the slot under whichever row is being renamed.
function catRenderOpenRename() {
  document.querySelectorAll('.cat2-rename').forEach(el => el.remove());
  if (!catEdit || catEdit.ti !== catSel) return;
  const { kind, si } = catEdit;
  const node = kind === 'sub' ? catModel[catSel].subs[si] : catModel[catSel];
  if (!node) { catEdit = null; return; }
  const c = catCount(node);
  const isSub = kind === 'sub';
  const retag = c && c.n
    ? `<span class="cat2-retag"><span class="cat2-retag-dot"></span>${escapeHtml(cuT(`${fcNum(c.n)} products re-tag themselves when you save`, `保存后 ${fcNum(c.n)} 件产品自动跟随`))}</span>`
    : '';
  const card = document.createElement('div');
  card.className = 'cat2-rename';
  card.innerHTML = `
    <div class="cat2-rename-fields">
      <div>
        <label>${escapeHtml(isSub ? cuT('Subcategory name — English', '子分类名称 — 英文') : cuT('Category name — English', '主分类名称 — 英文'))}</label>
        <input type="text" id="cat2-rename-en" value="${escapeAttr(node.name || '')}" oninput="catRenameInput('name', this.value)">
      </div>
      <div>
        <label>${escapeHtml(isSub ? cuT('Subcategory name — Chinese', '子分类名称 — 中文') : cuT('Category name — Chinese', '主分类名称 — 中文'))}</label>
        <input type="text" value="${escapeAttr(node.name_cn || '')}" oninput="catRenameInput('name_cn', this.value)">
      </div>
    </div>
    <div class="cat2-rename-foot">
      <button class="cat2-btn" type="button" onclick="catSaveRename()">${escapeHtml(cuT('Save name', '保存名称'))}</button>
      <button class="cat2-btn cat2-btn-ghost" type="button" onclick="catCloseRename(true)">${escapeHtml(cuT('Cancel', '取消'))}</button>
      ${retag}
    </div>`;
  const anchor = isSub ? document.getElementById('cat2-sub-' + si) : document.getElementById('cat2-tophead');
  if (!anchor) return;
  if (isSub) anchor.after(card); else document.getElementById('cat2-tophead-rename').append(card);
  const en = document.getElementById('cat2-rename-en');
  if (en) { en.focus(); en.select(); }
}
// Escape closes the card the way Cancel does.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !catEdit) return;
  if (!document.querySelector('.cat2-rename')) return;
  catCloseRename(true);
});

// ── Add / remove ───────────────────────────────────────────────────────────
function catAddTop() {
  catModel.push({ id: '', name: '', name_cn: '', subs: [] });
  catSel = catModel.length - 1;
  catRenderStatus(); catRenderRail(); catRenderPane();
  catOpenRename('top', catSel, -1);
}
async function catRemoveTop(ti) {
  const t = catModel[ti]; if (!t) return;
  // The shop needs at least one shelf; the server rejects an empty tree, so
  // say so here instead of letting an autosave fail behind the operator's back.
  if (catModel.length === 1) { toast(cuT('The shop needs at least one category', '店面至少需要一个主分类'), 'err'); return; }
  const n = (t.subs || []).length;
  const name = t.name || cuT('this category', '该主分类');
  const msg = n
    ? cuT(`Remove “${name}” and its ${n} subcategor${n === 1 ? 'y' : 'ies'}?\n\nProducts keep their tag until you re-assign them.`,
          `删除“${name}”及其 ${n} 个子分类？\n\n产品标签保留，直到重新分配。`)
    : cuT(`Remove “${name}”?`, `删除“${name}”？`);
  const [msgTitle, msgBody] = msg.split('\n\n');
  if (!(await askConfirm({ title: msgTitle, body: msgBody, confirmLabel: cuT('Remove category', '删除主分类'), danger: true }))) return;
  catEdit = null;
  catModel.splice(ti, 1);
  if (catSel >= catModel.length) catSel = Math.max(0, catModel.length - 1);
  catRenderAll(); catUpdateDirty();
}
function catAddSub(ti) {
  catModel[ti].subs = catModel[ti].subs || [];
  catModel[ti].subs.push({ id: '', name: '', name_cn: '' });
  catRenderStatus(); catRenderPane();
  catOpenRename('sub', ti, catModel[ti].subs.length - 1);
}
async function catRemoveSub(ti, si) {
  const s = catModel[ti].subs[si]; if (!s) return;
  const c = catCount(s);
  if (c && c.n && !(await askConfirm({
    title: cuT(
      `Remove “${s.name}”? Its ${c.n} product${c.n === 1 ? '' : 's'} stay in ${catModel[ti].name}, without a heading.`,
      `删除“${s.name}”？其 ${c.n} 件产品仍留在“${catModel[ti].name}”，但不再归入任何区块。`),
    confirmLabel: cuT('Remove subcategory', '删除子分类'),
    danger: true,
  }))) return;
  catEdit = null;
  catModel[ti].subs.splice(si, 1);
  catRenderStatus(); catRenderRail(); catRenderPane(); catUpdateDirty();
}

// ── Drag to reorder ────────────────────────────────────────────────────────
// Tops reorder in the rail; subs reorder within their own category. Nothing
// moves between parents — a reorder changes neither name nor parent, so it
// never touches a product row. The list never reflows mid-drag: one insertion
// line marks the edge the row will land against, and the rows glide (FLIP) to
// their new places on drop. That glide is the whole interaction's only motion.
const _catFk = new WeakMap(); let _catFkSeq = 0;
function catFk(o) { let k = _catFk.get(o); if (!k) { k = ++_catFkSeq; _catFk.set(o, k); } return k; }
function catFlip(hostId, swap) {
  const host = document.getElementById(hostId);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!host || reduce) { swap(); return; }
  const first = new Map();
  host.querySelectorAll('[data-fk]').forEach(el => first.set(el.dataset.fk, el.getBoundingClientRect()));
  swap();
  const now = document.getElementById(hostId);
  if (!now) return;
  now.querySelectorAll('[data-fk]').forEach(el => {
    const a = first.get(el.dataset.fk); if (!a) return;
    const b = el.getBoundingClientRect();
    const dy = a.top - b.top;
    if (!dy) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 320ms cubic-bezier(.16,1,.3,1)';
      el.style.transform = '';
      el.addEventListener('transitionend', () => { el.style.transition = ''; el.style.transform = ''; }, { once: true });
    });
  });
}
let catDrag = null;   // { kind:'top'|'sub', i, gap }
function catDragStart(ev, kind, i) {
  catDrag = { kind, i, gap: null };
  ev.dataTransfer.effectAllowed = 'move';
  try { ev.dataTransfer.setData('text/plain', kind); } catch (e) {}
  const row = ev.target.closest('.cat2-row');
  if (row && ev.dataTransfer.setDragImage) {
    try {
      const r = row.getBoundingClientRect();
      ev.dataTransfer.setDragImage(row, ev.clientX - r.left, ev.clientY - r.top);
    } catch (e) {}
  }
  // Next tick: changing the row mid-dragstart would cancel the drag.
  setTimeout(() => { if (catDrag && row) row.classList.add('cat2-dragging'); }, 0);
}
function catClearDropCues() {
  document.querySelectorAll('.cat2-drop-before, .cat2-drop-after')
    .forEach(el => el.classList.remove('cat2-drop-before', 'cat2-drop-after'));
}
function catDragEnd() {
  catDrag = null;
  document.querySelectorAll('.cat2-dragging').forEach(el => el.classList.remove('cat2-dragging'));
  catClearDropCues();
}
// The list, not the row under the cursor, decides where the row lands: the
// cursor picks the nearest gap between rows (above a row's middle is the gap
// before it), and the line is drawn in that gap. It used to be the hovered
// row's far edge, so dragging down onto a row's top half drew the line below
// it and the row landed one place further than the cursor pointed; crossing a
// row's name or buttons also blinked the line off.
//
// The drop area is the whole box around the list (the rail, the subcategory
// section), not just the rows: letting go below the last row puts the row last,
// above the first puts it first. When the area stopped at the rows, moving a
// row to the end meant hitting the bottom half of the last row, and a little
// lower did nothing at all.
function catDragRows(kind) {
  const host = document.getElementById(kind === 'top' ? 'cat2-rail' : 'cat2-subs');
  return host ? Array.from(host.querySelectorAll(':scope > .cat2-row')) : [];
}
function catGapAt(rows, y) {
  for (let g = 0; g < rows.length; g++) {
    const r = rows[g].getBoundingClientRect();
    if (y < r.top + r.height / 2) return g;
  }
  return rows.length;
}
// Gap g (0..n) as a place to splice into once the row is lifted out: the gaps
// either side of the dragged row both mean "stay put".
function catGapToPlace(from, g) { return g > from ? g - 1 : g; }
function catDragOver(ev, kind) {
  if (!catDrag || catDrag.kind !== kind) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const rows = catDragRows(kind);
  const g = catGapAt(rows, ev.clientY);
  if (g === catDrag.gap) return;
  catDrag.gap = g;
  catClearDropCues();
  if (catGapToPlace(catDrag.i, g) === catDrag.i) return;
  if (g < rows.length) rows[g].classList.add('cat2-drop-before');
  else if (rows.length) rows[rows.length - 1].classList.add('cat2-drop-after');
}
// dragleave also fires when the cursor crosses into a child of the list; only
// leaving the list itself clears the line.
function catDragLeave(ev) {
  if (ev.relatedTarget && ev.currentTarget.contains(ev.relatedTarget)) return;
  if (catDrag) catDrag.gap = null;
  catClearDropCues();
}
function catDrop(ev, kind) {
  if (!catDrag || catDrag.kind !== kind) return;
  ev.preventDefault();
  const from = catDrag.i;
  const i = catGapToPlace(from, catGapAt(catDragRows(kind), ev.clientY));
  catDrag = null;
  catClearDropCues();
  if (from === i) { catDragEnd(); return; }
  if (catMode === 'qr') { catQrDrop(kind, from, i); return; }
  if (kind === 'top') {
    catEdit = null;
    catFlip('cat2-rail', () => {
      const moved = catModel.splice(from, 1)[0];
      catModel.splice(i, 0, moved);
      // The pane keeps showing the category the operator was looking at.
      if (catSel === from) catSel = i;
      else if (from < catSel && i >= catSel) catSel--;
      else if (from > catSel && i <= catSel) catSel++;
      catRenderRail();
    });
    catRenderPane();
  } else {
    catEdit = null;
    catFlip('cat2-subs', () => {
      const subs = catModel[catSel].subs;
      const moved = subs.splice(from, 1)[0];
      subs.splice(i, 0, moved);
      const host = document.getElementById('cat2-subs');
      if (host) host.innerHTML = subs.map((s, si) => catSubRowHtml(s, si)).join('');
    });
    catProdRegroup();
  }
  catUpdateDirty();
}

// §288 — a drop in the QR menu's rail rearranges the QR menu's order and
// leaves the tree alone. `from` and `to` are places as drawn. The whole list
// is stored, so from then on the QR menu keeps its own order; a category added
// later is not in it and shows at the bottom until dragged in.
function catQrDrop(kind, from, to) {
  catEdit = null;
  if (kind === 'top') {
    catFlip('cat2-rail', () => {
      const list = catRailList();
      const moved = list.splice(from, 1)[0];
      list.splice(to, 0, moved);
      catQr.tops = list.map(x => x.t.id).filter(Boolean);
      catRenderRail();
    });
    catRenderPane();
  } else {
    const t = catModel[catSel];
    if (!t || !t.id) return;
    catFlip('cat2-subs', () => {
      const list = catSubList(catSel);
      const moved = list.splice(from, 1)[0];
      list.splice(to, 0, moved);
      catQr.subs[t.id] = list.map(x => x.s.id).filter(Boolean);
      const host = document.getElementById('cat2-subs');
      if (host) host.innerHTML = catSubList(catSel).map(({ s, si }, p) => catSubRowHtml(s, si, p)).join('');
    });
    catProdRegroup();
  }
  catRenderStatus();
  catQrScheduleSave();
}

// ── The products standing on this shelf ────────────────────────────────────
// Read against the LAST-SAVED name (products carry saved names, so an unsaved
// rename wouldn't match until the tree lands). Drawn the way the mini app
// draws the shelf (miniapp/pages/shop/shop.js _buildSections): one group per
// section heading in the tree's order, then any heading the tree no longer
// names, then the products with no heading last. Inside a group the rows are
// in the shop's own order, and every row is drawn so any of them can be
// dragged to any place in its group.
let _catMoveTargets = [];    // flattened [{ top, sub }]; the <select> value is the index
let _catProdReq = 0;
let _catProdRows = [];       // all rows for the current shelf, in the shop's order
let _catProdGroups = [];     // [{ sub, label, label_cn, nodeId, units }] as drawn; a unit is [row, …]
let _catProdListed = null;   // Set of product ids on any QR menu; the QR view shows only these

function catCleanTree() { try { return JSON.parse(catClean); } catch (e) { return []; } }
// The saved name of the selected top, matched by stable id. Null for a node
// that has never been saved (it can have no products yet).
function catSavedTopName() {
  const t = catModel[catSel];
  if (!t || !t.id) return null;
  const saved = catCleanTree().find(x => x.id === t.id);
  return saved ? saved.name : null;
}
function catBuildMoveTargets() {
  _catMoveTargets = [];
  for (const t of catCleanTree()) {
    _catMoveTargets.push({ top: t.name, sub: '' });
    for (const s of (t.subs || [])) _catMoveTargets.push({ top: t.name, sub: s.name });
  }
}
function catMoveOptions(curTop, curSub) {
  return _catMoveTargets.map((tg, i) => {
    const sel = (tg.top === (curTop || '') && (tg.sub || '') === (curSub || '')) ? ' selected' : '';
    // Never " · " — the bilingual walker would read that as an EN/CN pair and
    // eat half the label. An em dash says the same thing and stays whole.
    const lbl = tg.sub ? `${tg.top} › ${tg.sub}` : `${tg.top} — ${cuT('no heading', '无区块')}`;
    return `<option value="${i}"${sel}>${escapeHtml(lbl)}</option>`;
  }).join('');
}

// A variant group is ONE card in the mini app, so it is one unit here: its
// sizes are drawn together, at the place of the first one, and move together.
function catProdUnits(rows) {
  const units = [], byGid = new Map();
  for (const p of rows) {
    const g = p.variant_group_id;
    if (g && byGid.has(g)) { byGid.get(g).push(p); continue; }
    const u = [p];
    if (g) byGid.set(g, u);
    units.push(u);
  }
  return units;
}
// Two shelves from one list, each drawn the way its own menu draws it.
//   Mini app (miniapp/pages/shop/shop.js _buildSections): the tree's headings
//   in order, a heading the tree no longer names after them, the products
//   with no heading LAST; rows in the mini app's order.
//   QR menu (routes/shop-menu.js buildMenu): only products on a QR menu; the
//   headings in the QR menu's order, the products with no heading FIRST, and a
//   heading the tree no longer names folded into them, as the menu does; rows
//   in the QR menu's own product order, then the mini app's for the rest.
// `nodeId` is the node the QR product order is kept under — the subcategory,
// or the top category for the no-heading group.
// The headings come from the subcategory list AS IT IS DRAWN above
// (catSubList: the live tree, in the view's order, unsaved drags included), so
// the two lists always read in the same order. Each heading is matched to its
// products by the node's stable id → its SAVED name, which is what products
// carry until a rename is saved.
function catProdBuildGroups() {
  const t = catModel[catSel];
  const saved = t && t.id ? catCleanTree().find(x => x.id === t.id) : null;
  const savedSubs = (saved && saved.subs) || [];
  const qr = catMode === 'qr';
  const live = catSubList(catSel).map(({ s }) => {
    const sv = s.id ? savedSubs.find(x => x.id === s.id) : null;
    return { key: sv ? sv.name : null, node: s };
  }).filter(x => x.key);
  const known = new Set(live.map(x => x.key));
  const rows = qr && _catProdListed ? _catProdRows.filter(p => _catProdListed.has(p.id)) : _catProdRows;
  const bySub = new Map();
  for (const p of rows) {
    let k = p.subcategory || '';
    if (qr && !known.has(k)) k = '';
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push(p);
  }
  const heads = live.filter(x => bySub.has(x.key));
  const order = heads.map(x => ({ sub: x.key, node: x.node }));
  if (!qr) for (const k of bySub.keys()) if (k && !known.has(k)) order.push({ sub: k, node: null });
  if (bySub.has('')) {
    // The no-heading group: last in the mini app, first on the QR menu.
    const none = { sub: '', node: saved };
    if (qr) order.unshift(none); else order.push(none);
  }
  _catProdGroups = order.map(({ sub, node }) => {
    const nodeId = (node && node.id) || '';
    let units = catProdUnits(bySub.get(sub));
    if (qr) units = catQrOrderUnits(units, nodeId ? catQr.products[nodeId] : null);
    return {
      sub,
      label: sub && node ? node.name : sub,
      label_cn: sub && node ? (node.name_cn || '') : '',
      nodeId,
      units,
    };
  });
}
// Redraw the products under the headings without fetching again — after a
// subcategory is dragged, so the two lists never disagree.
function catProdRegroup() {
  if (!_catProdRows.length || !document.getElementById('cat2-prods')) return;
  catProdBuildGroups();
  catRenderProdList();
}
// The QR menu's stored order laid over the mini app's: units the list names
// first, in its order (a variant group ranks by whichever size it names
// first), the rest after them as they came. Mirrors orderProducts in
// lib/qr-menu-category-order.js.
function catQrOrderUnits(units, ids) {
  if (!ids || !ids.length) return units;
  const pos = new Map(ids.map((id, i) => [Number(id), i]));
  const rank = u => u.reduce((r, p) => (pos.has(p.id) ? Math.min(r, pos.get(p.id)) : r), Infinity);
  const named = units.filter(u => rank(u) < Infinity).sort((a, b) => rank(a) - rank(b));
  return named.concat(units.filter(u => rank(u) === Infinity));
}

function catProdRowHtml(p, grip) {
  const name = escapeHtml(p.name_en || p.name_cn || ('#' + p.id));
  const thumb = p.image_data
    ? `<img class="cat2-thumb" src="${escapeAttr(p.image_data)}" alt="" loading="lazy">`
    : `<span class="cat2-thumb">${CAT_ICON.box}</span>`;
  return `<div class="cat2-prod">
    ${grip}
    ${thumb}
    <span class="pn">${name}${p.variant_label ? ` <span class="psub">· ${escapeHtml(cuT(p.variant_label, p.variant_label_cn || p.variant_label))}</span>` : ''}${p.is_published ? '' : ` <span class="psub">· ${escapeHtml(cuT('draft', '未上架'))}</span>`}</span>
    <select title="${escapeAttr(cuT('Move to another shelf', '移动到其他分类'))}" onchange="catMoveProduct(${p.id}, this)">
      ${catMoveOptions(p.top_category, p.subcategory)}
    </select>
  </div>`;
}
// Dragging sets the order of the view it is done in: the mini app's
// (store_products.sort_order) or the QR menu's (catQr.products). A QR group
// with no saved node to keep its order under draws no grip.
function catProdUnitHtml(u, gi, ui) {
  const drag = catMode === 'miniapp' || !!_catProdGroups[gi].nodeId;
  const grip = drag
    ? `<span class="cat2-grip" draggable="true" title="${escapeAttr(cuT('Drag to reorder', '拖动排序'))}"
            ondragstart="catProdDragStart(event,${gi},${ui})" ondragend="catProdDragEnd()">${CAT_ICON.grip}</span>`
    : '';
  return `<div class="cat2-prod-unit" data-fk="p${u[0].id}">${u.map((p, k) => catProdRowHtml(p, k ? (drag ? '<span class="cat2-grip-sp"></span>' : '') : grip)).join('')}</div>`;
}
function catProdGroupListHtml(gi) {
  return _catProdGroups[gi].units.map((u, ui) => catProdUnitHtml(u, gi, ui)).join('');
}
function catRenderProdList() {
  const host = document.getElementById('cat2-prods');
  if (!host) return;
  // A heading over each group only when there is more than one, or the one
  // group is a named section; a shelf with no sections reads as one list.
  const heads = _catProdGroups.length > 1 || (_catProdGroups[0] && _catProdGroups[0].sub);
  host.innerHTML = _catProdGroups.map((g, gi) => {
    const label = g.sub ? cuT(g.label, g.label_cn || g.label) : cuT('no heading', '无区块');
    return (heads ? `<div class="cat2-prod-head">${escapeHtml(label)}</div>` : '') +
      `<div class="cat2-prod-list" id="cat2-pg-${gi}"
            ondragover="catProdDragOver(event,${gi})" ondrop="catProdDrop(event,${gi})" ondragleave="catProdDragLeave(event)">${catProdGroupListHtml(gi)}</div>`;
  }).join('');
}

// ── Drag a product within its heading ──
// Same gap-and-line mechanics as the rail (catGapAt / catGapToPlace), on its
// own state so a product can never land in the rail or a subcategory list. A
// drop only lands inside the group it started in; moving a product to another
// heading stays with the row's dropdown.
let catProdDrag = null;   // { gi, ui, gap }
function catProdDragStart(ev, gi, ui) {
  catProdDrag = { gi, ui, gap: null };
  ev.dataTransfer.effectAllowed = 'move';
  // Firefox will not start a drag without data; nothing reads it back.
  try { ev.dataTransfer.setData('text/plain', 'product'); } catch (e) { /* a browser that refuses still drags */ }
  const unit = ev.target.closest('.cat2-prod-unit');
  if (unit && ev.dataTransfer.setDragImage) {
    try {
      const r = unit.getBoundingClientRect();
      ev.dataTransfer.setDragImage(unit, ev.clientX - r.left, ev.clientY - r.top);
    } catch (e) { /* the browser's own ghost image is a fine fallback */ }
  }
  setTimeout(() => { if (catProdDrag && unit) unit.classList.add('cat2-dragging'); }, 0);
}
function catProdDragEnd() {
  catProdDrag = null;
  document.querySelectorAll('.cat2-dragging').forEach(el => el.classList.remove('cat2-dragging'));
  catClearDropCues();
}
function catProdDragLeave(ev) {
  if (ev.relatedTarget && ev.currentTarget.contains(ev.relatedTarget)) return;
  if (catProdDrag) catProdDrag.gap = null;
  catClearDropCues();
}
function catProdUnitsIn(host) { return host ? Array.from(host.querySelectorAll(':scope > .cat2-prod-unit')) : []; }
function catProdDragOver(ev, gi) {
  if (!catProdDrag || catProdDrag.gi !== gi) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const rows = catProdUnitsIn(ev.currentTarget);
  const g = catGapAt(rows, ev.clientY);
  if (g === catProdDrag.gap) return;
  catProdDrag.gap = g;
  catClearDropCues();
  if (catGapToPlace(catProdDrag.ui, g) === catProdDrag.ui) return;
  if (g < rows.length) rows[g].classList.add('cat2-drop-before');
  else if (rows.length) rows[rows.length - 1].classList.add('cat2-drop-after');
}
function catProdDrop(ev, gi) {
  if (!catProdDrag || catProdDrag.gi !== gi) return;
  ev.preventDefault();
  const from = catProdDrag.ui;
  const to = catGapToPlace(from, catGapAt(catProdUnitsIn(ev.currentTarget), ev.clientY));
  catProdDragEnd();
  if (from === to) return;
  const units = _catProdGroups[gi].units;
  catFlip('cat2-pg-' + gi, () => {
    units.splice(to, 0, units.splice(from, 1)[0]);
    const host = document.getElementById('cat2-pg-' + gi);
    if (host) host.innerHTML = catProdGroupListHtml(gi);
  });
  const ids = units.flat().map(p => p.id);
  if (catMode === 'qr') {
    // The QR menu's order, saved with the rest of it (category order, hidden
    // categories) in one value; the mini app is not touched.
    const nodeId = _catProdGroups[gi].nodeId;
    if (!nodeId) return;
    catQr.products[nodeId] = ids;
    catRenderStatus();
    catQrScheduleSave();
    return;
  }
  catProdSaveOrder(ids);
}
// The same write the Products page's drag makes: the ids in their new order,
// and the server hands the group's own sort_order slots back out.
async function catProdSaveOrder(ids) {
  if (ids.length < 2) return;
  try {
    await api('/api/retail-admin/products/reorder', { method: 'POST', body: { ids } });
  } catch (e) {
    toast((e && e.message) ? (cuT('Reorder failed: ', '排序失败:') + e.message) : 'Reorder failed · 排序未保存', 'err');
    catLoadProducts();   // resync, so the list can't drift from what is saved
  }
}

async function catLoadProducts() {
  const host = document.getElementById('cat2-prods');
  if (!host) return;
  catProdDrag = null;
  const top = catSavedTopName();
  if (!top) {
    host.innerHTML = `<div class="cat2-empty">${escapeHtml(cuT('Save this category, then its products can stand here.', '保存该分类后，产品即可归入此处。'))}</div>`;
    return;
  }
  const req = ++_catProdReq;
  catBuildMoveTargets();
  try {
    const [{ data }, listed] = await Promise.all([
      api('/api/retail-admin/category-products?' + new URLSearchParams({ top }).toString()),
      catMode === 'qr' ? api('/api/retail-admin/shop-listings/product-ids') : null,
    ]);
    if (req !== _catProdReq) return;    // the operator moved on to another shelf
    _catProdListed = listed ? new Set(listed.data || []) : null;
    const rows = data || [];
    _catBannerRows = rows;
    catBannerFillTargets();   // §297 — the banner's link list names this shelf's products
    if (!rows.length) {
      host.innerHTML = `<div class="cat2-empty">${escapeHtml(cuT('Nothing stands on this shelf yet.', '该分类下暂无产品。'))}</div>`;
      return;
    }
    _catProdRows = rows;
    catProdBuildGroups();
    if (!_catProdGroups.length) {
      host.innerHTML = `<div class="cat2-empty">${escapeHtml(cuT('Nothing stands on this shelf yet.', '该分类下暂无产品。'))}</div>`;
      return;
    }
    catRenderProdList();
  } catch (e) {
    if (req !== _catProdReq) return;
    host.innerHTML = `<div class="cat2-empty">${escapeHtml(cuT('Could not load the products on this shelf.', '加载该分类的产品失败。'))}</div>`;
  }
}

async function catMoveProduct(id, sel) {
  const tg = _catMoveTargets[Number(sel.value)];
  if (!tg) return;
  sel.disabled = true;
  try {
    await api('/api/retail-admin/products/' + id, { method: 'PATCH', body: { top_category: tg.top, subcategory: tg.sub || null } });
    toast(cuT('Moved', '已移动'), 'ok');
    await catRefreshCounts();
    catRenderStatus(); catRenderRail();
    catLoadProducts();   // the product may have left this shelf
  } catch (e) {
    toast(cuT('Could not move it', '移动失败'), 'err');
    sel.disabled = false;
  }
}

// Open the shelf from anywhere (search results, deep links).
function catGo() {
  const btn = document.querySelector('.tabs [data-tab="products"]');
  if (btn) btn.click();
  prodShowView('categories');
}
window.catGo = catGo;

// Warn before leaving with category edits that never landed.
window.addEventListener('beforeunload', (e) => {
  if (catLoaded && catIsDirty()) { e.preventDefault(); e.returnValue = ''; }
});


// ── Settings sub-nav switcher ──
$$('#settings-nav button').forEach(btn => btn.addEventListener('click', () => {
  $$('#settings-nav button').forEach(b => b.classList.toggle('active', b === btn));
  const sub = btn.dataset.sub;
  $$('.sub-panel').forEach(p => p.classList.toggle('active', p.id === 'sub-' + sub));
  // The shared "Save settings" bar drives saveConfig() (Shop/Push/CS only). The
  // Operations panel has its own per-card saves, so hide the shared bar there.
  // SKU codes is on that list for the same reason Operations is: every rule
  // saves itself, so a shared "Save settings" button there would either do
  // nothing or claim to have saved something it never touched.
  const _saveBar = document.querySelector('.settings-body > .save-bar');
  // Change history is on that list too, and more absolutely: it is read-only.
  // A "Save settings" button over a record of what people did would be an
  // offer to edit the audit trail.
  // Delivery is on that list for the first reason: every sub-view on it saves
  // itself (saveDeliveryZones, saveHolidayMode, the carrier forms), so a shared
  // "Save settings" over them would either do nothing or claim to have saved
  // something it never touched.
  // §279: the Shop and Customer-service panels save themselves now, so the
  // shared bar belongs to Notifications alone (template id, webhooks, the
  // manual-Alipay card) — keys and money, which keep their button.
  if (_saveBar) _saveBar.style.display = sub === 'push' ? '' : 'none';
  // Lazy-load the Operations panel's live data each time it is opened.
  if (sub === 'ops') loadOpsPanel();
  // Delivery opens on its hub with fresh status lines, never on whichever
  // sub-view the last visit left behind (§79). This is what the rail button's
  // own click handler did before the page moved into Settings.
  if (sub === 'delivery' && typeof dlvGo === 'function') dlvGo('hub');
  // Same, for the SKU rules — the category lists it offers are read from the
  // live catalogue, so a stale copy would hide a category added since boot.
  if (sub === 'sku' && typeof skuLoad === 'function') skuLoad();
  // Same, for the change history — it is a live record, so it is read fresh on
  // every open rather than cached from whenever the tab was last visited.
  if (sub === 'history' && typeof chLoad === 'function') chLoad();
  // Same, for the send record — a live log, read fresh on every open.
  if (sub === 'sent' && typeof nlLoad === 'function') nlLoad();
  // Scroll the settings body to top within the page
  window.scrollTo({ top: document.querySelector('.tabs').offsetTop - 8, behavior: 'smooth' });
}));


// ── Live push (SSE): one shared connection for the whole admin ──────────
// The server holds /api/retail-admin/stream open and emits an `activity`
// event whenever this tenant's orders / customers / wholesale rows move.
// It detects that by re-reading a cheap watermark off the DB, NOT by
// hooking the code that writes — so it also catches rows written by the
// separate Meituan and gzgrocery daemon processes, which an in-process
// write hook could never see.
//
// Every page subscribes through here instead of opening its own
// EventSource, so one admin session holds exactly one socket no matter how
// many tabs are wired up. Subscribers get called on `activity` and once
// after a reconnect (events may have been missed while the socket was
// down). They should treat the call as "something changed, go refetch",
// never as the change itself — no payload is delivered.
const _LIVE = { es: null, opened: false, subs: new Set(), ent: new Map() };

function retailLiveSubscribe(fn) {
  _LIVE.subs.add(fn);
  retailLiveConnect();
  return () => _LIVE.subs.delete(fn);   // unsubscribe
}

// Typed entity nudges (reference/live-updates-spec.md). The server emits
// `event: live` with { entity, action, scope, ids, ts } — no payload. Callers
// register per entity ('identity', …) and refetch just that entity on the
// nudge. Kept separate from retailLiveSubscribe so an identity change doesn't
// make every page's `activity` subscriber refetch its whole dataset.
function retailLiveOn(entity, fn) {
  if (!_LIVE.ent.has(entity)) _LIVE.ent.set(entity, new Set());
  _LIVE.ent.get(entity).add(fn);
  retailLiveConnect();
  return () => { const s = _LIVE.ent.get(entity); if (s) s.delete(fn); };
}

function retailLiveConnect() {
  if (_LIVE.es || typeof EventSource === 'undefined') return;
  let es;
  try { es = new EventSource('/api/retail-admin/stream'); }
  catch (e) { return; }                 // no live push; callers keep their backstop poll
  _LIVE.es = es;
  const fan = (reason) => {
    for (const fn of _LIVE.subs) { try { fn(reason); } catch (e) { /* one bad subscriber must not starve the rest */ } }
  };
  es.addEventListener('activity', () => fan('activity'));
  // Typed entity nudges — route to the per-entity subscribers registered via
  // retailLiveOn. Bad JSON or an unknown entity is ignored, never thrown.
  es.addEventListener('live', (e) => {
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    const set = d && d.entity && _LIVE.ent.get(d.entity);
    if (!set) return;
    for (const fn of set) { try { fn(d); } catch (_) { /* isolate subscribers */ } }
  });
  // Skip the very first open — the page that just subscribed has loaded its
  // own data already. Later opens are reconnects, so catch up.
  es.addEventListener('open', () => {
    if (_LIVE.opened) fan('reconnect');
    _LIVE.opened = true;
  });
  // On error EventSource reconnects by itself. Keep the handle so we never
  // stack sockets; dropping it here would let the next subscribe open a second.
}

// ── Shared pager (Orders · Customers) ──────────────────────────────────
// One renderer so the paged lists cannot drift apart. Built to the Tacet
// system: every control is a Secondary button (transparent, 1px border, ink
// text). Deliberately NO Dusk anywhere in this bar — Dusk means "Tacet did
// this for you", and turning a page is the operator's own hand, not
// automation. Styling lives in retail-admin.css under `.t-pager`.
//
// EN/CN ride as separate data-lang-block spans (never glued into one string),
// so the language toggle swaps them without a re-render.
const PAGER_ICON_PREV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const PAGER_ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

function _pagerNum(n) { return Number(n || 0).toLocaleString('en-US'); }
function _pagerLang(en, cn) {
  return `<span data-lang-block="en">${en}</span><span data-lang-block="cn">${cn}</span>`;
}

// mount   — the container element (or its id)
// o.page / o.pageSize / o.total — current window
// o.sizes — page-size choices, e.g. [50,100,200]; omit to hide the selector
// o.onPage(nextPage) / o.onSize(nextSize) — callbacks; the caller reloads
// o.noun  — nouns for the single-page line: {en, one, cn}. `one` is the English
//           singular ("order"); Chinese doesn't inflect, so there's no cn twin.
function rmRenderPager(mount, o) {
  const el = (typeof mount === 'string') ? document.getElementById(mount) : mount;
  if (!el) return;
  const total = Math.max(0, Number(o.total || 0));
  const size  = Math.max(1, Number(o.pageSize || 50));

  // Nothing matched — the empty state speaks for the screen; a pager reading
  // "0 of 0" beside it would just be noise.
  if (!total) { el.innerHTML = ''; return; }

  const pages = Math.max(1, Math.ceil(total / size));
  const page  = Math.min(pages, Math.max(1, Number(o.page || 1)));
  const from  = (page - 1) * size + 1;
  const to    = Math.min(total, page * size);

  // The size selector earns its place only when it can change what's on screen.
  // With 1 order and sizes of 50/100/200 every choice shows the same one row,
  // so the control is pure furniture — when in doubt, remove something.
  const sizes = (o.sizes || []).filter(v => Number.isFinite(Number(v)));
  const sizeUseful = sizes.length > 1 && total > Math.min(...sizes.map(Number));
  const sizeSel = sizeUseful ? `
    <label class="t-pager-size">
      ${_pagerLang('Per page', '每页')}
      <select data-pager-size>
        ${sizes.map(v => `<option value="${v}"${Number(v) === size ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
    </label>` : '';

  // One page of results → the count stands alone. A pager showing "1 / 1"
  // between two dead buttons tells the operator nothing they can act on.
  const nav = (pages <= 1) ? '' : `
    <div class="t-pager-nav">
      <button type="button" class="t-pager-btn" data-pager-prev ${page <= 1 ? 'disabled' : ''}>
        ${PAGER_ICON_PREV}${_pagerLang('Prev', '上一页')}
      </button>
      <span class="t-pager-pos">${page} / ${pages}</span>
      <button type="button" class="t-pager-btn" data-pager-next ${page >= pages ? 'disabled' : ''}>
        ${_pagerLang('Next', '下一页')}${PAGER_ICON_NEXT}
      </button>
    </div>`;

  // "Showing all 1 orders" reads like a bug. One row gets the singular, and
  // drops the "all" with it — there is no "all" of one.
  const nMany = (o.noun && o.noun.en)  || 'results';
  const nOne  = (o.noun && o.noun.one) || nMany;
  const nCn   = (o.noun && o.noun.cn)  || '条';
  const count = (pages <= 1)
    ? _pagerLang(total === 1 ? `Showing <b>1</b> ${nOne}`
                             : `Showing all <b>${_pagerNum(total)}</b> ${nMany}`,
                 `共 <b>${_pagerNum(total)}</b> ${nCn}`)
    : _pagerLang(`Showing <b>${_pagerNum(from)}–${_pagerNum(to)}</b> of <b>${_pagerNum(total)}</b>`,
                 `显示 <b>${_pagerNum(from)}–${_pagerNum(to)}</b> / 共 <b>${_pagerNum(total)}</b>`);

  el.innerHTML = `
    <div class="t-pager">
      <span class="t-pager-count">${count}</span>
      <div class="t-pager-right">${sizeSel}${nav}</div>
    </div>`;

  const prev = el.querySelector('[data-pager-prev]');
  const next = el.querySelector('[data-pager-next]');
  const sel  = el.querySelector('[data-pager-size]');
  if (prev) prev.onclick = () => { if (page > 1) o.onPage(page - 1); };
  if (next) next.onclick = () => { if (page < pages) o.onPage(page + 1); };
  // Changing page size re-anchors to page 1 — the operator's old offset means
  // nothing once the window resizes under it.
  if (sel)  sel.onchange = () => o.onSize(parseInt(sel.value, 10));
}


// ── Tooltip — the shared one ───────────────────────────────────────────────
// Set (or clear) a tooltip whose text is built in JS rather than authored in
// the markup. Two rules it exists to keep:
//
//   • Empty means NO attribute, not an empty one. `[data-tt]` still matches an
//     empty attribute, which would make the element focusable and hoverable for
//     a bubble that never has anything in it.
//   • The text must already be in ONE language (built with cuT). The i18n layer
//     splits authored data-tt on the first " · ", so a single-language string
//     carrying a decorative " · " would be cut in half at it. Callers use an
//     em dash inside a half for that reason — see dashSetDelta / ordSetDelta.
function ttSet(el, text) {
  if (!el) return;
  if (text) el.setAttribute('data-tt', text);
  else el.removeAttribute('data-tt');
}

// One bubble for the whole product. Put data-tt="..." on any element and it
// gets a tooltip; there is no per-instance JS and nothing to wire up. All the
// listeners below are delegated off document, so an element rendered an hour
// from now works the same as one in the static markup.
//
// Opens on hover (after a beat), on tap, and on keyboard focus. Closes on
// pointer-leave, tap-elsewhere, focus-out, Escape, scroll and resize. There is
// deliberately NO dismiss control — no ✕, no click-to-pin. A tooltip that has
// to be closed is a panel wearing a tooltip's clothes.
//
// Placement is above the element, flipping below only when there isn't room
// above. Those are the only two placements: no left/right variant, ever. The
// bubble is position:fixed and clamped to the viewport by hand, so it never
// clips inside a scrollable drawer or hangs off a screen edge — it shifts
// sideways to stay in and the arrow keeps pointing at the element.
//
// Text is authored "EN · 中文" like every other label; the i18n layer in
// 10-extras.js splits data-tt on load and rewrites it on language toggle, so
// by the time we read the attribute it already holds the active language.
(function () {
  const SEL      = '[data-tt]';
  const GAP      = 8;    // bubble-to-element breathing room
  const EDGE     = 8;    // closest the bubble may come to a viewport edge
  const DELAY    = 350;  // hover dwell before it opens — long enough not to
                         // flicker as the pointer crosses on its way elsewhere
  const canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;

  let pop = null, current = null, timer = null;

  function ensure() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'tt-pop';
    pop.id = 'tt-pop';
    pop.setAttribute('role', 'tooltip');
    document.body.appendChild(pop);
    return pop;
  }

  // A trigger has to be reachable by keyboard or the focus path is decorative.
  // Real buttons/links/inputs already are; anything else is given a tabindex.
  // Author triggers as real buttons where you can — this only covers the rest.
  const NATIVE = 'a[href], button, input, select, textarea, [tabindex]';
  function focusable(el) {
    if (el.matches(NATIVE)) return;
    el.setAttribute('tabindex', '0');
  }

  function show(el) {
    const text = el.getAttribute('data-tt');
    if (!text) return;
    if (current === el) return;
    hide();
    current = el;

    const b = ensure();
    b.textContent = text;
    b.classList.remove('on');           // measure in the settled state
    b.style.left = '0px';
    b.style.top  = '0px';

    const r  = el.getBoundingClientRect();
    const bb = b.getBoundingClientRect();

    // Above by default; below only when above would clip. Never on top of the
    // element it explains — that is what the GAP either side buys us.
    let place = 'above';
    let top   = r.top - bb.height - GAP;
    if (top < EDGE) {
      const below = r.bottom + GAP;
      if (below + bb.height <= window.innerHeight - EDGE || below - EDGE > (window.innerHeight - r.bottom)) {
        place = 'below';
        top   = below;
      }
    }

    // Centre on the element, then shift horizontally to stay on screen. The
    // arrow is placed off the ELEMENT's centre, not the bubble's, so shifting
    // the bubble leaves the arrow still pointing at the thing it explains.
    const wantLeft = r.left + r.width / 2 - bb.width / 2;
    const left = Math.max(EDGE, Math.min(wantLeft, window.innerWidth - bb.width - EDGE));

    // Keep the arrow inside the bubble's rounded corners.
    const ax = Math.max(12, Math.min(r.left + r.width / 2 - left, bb.width - 12));

    b.dataset.place = place;
    b.style.setProperty('--tt-ax', Math.round(ax) + 'px');
    b.style.left = Math.round(left) + 'px';
    b.style.top  = Math.round(top) + 'px';

    el.setAttribute('aria-describedby', 'tt-pop');
    // Straight on — the getBoundingClientRect() above already forced a style
    // flush, so the closed state is committed and the fade has a start value
    // to run from. Deliberately NOT requestAnimationFrame: rAF never fires in
    // a hidden tab, which left the callback queued and popped the bubble open
    // whenever the operator came back to the tab.
    b.classList.add('on');
  }

  function hide() {
    clearTimeout(timer);
    if (current) current.removeAttribute('aria-describedby');
    current = null;
    if (pop) pop.classList.remove('on');
  }

  function trigger(e) {
    const t = e.target;
    return (t && t.closest) ? t.closest(SEL) : null;
  }

  if (canHover) {
    document.addEventListener('mouseover', function (e) {
      const t = trigger(e);
      if (!t) return;
      if (t === current) return;
      focusable(t);
      clearTimeout(timer);
      timer = setTimeout(() => show(t), DELAY);
    });
    document.addEventListener('mouseout', function (e) {
      const t = trigger(e);
      if (!t) return;
      // Ignore moves between the trigger's own children.
      if (e.relatedTarget && t.contains(e.relatedTarget)) return;
      hide();
    });
  }

  // Tap. On a touch screen the trigger's own click still runs — a tooltip
  // never swallows the action of the thing it sits on.
  document.addEventListener('click', function (e) {
    const t = trigger(e);
    if (!t) { hide(); return; }
    focusable(t);
    if (t === current) return;   // second tap on an open one leaves it be
    clearTimeout(timer);
    show(t);
  });

  // Keyboard. Focus opens immediately — a dwell delay on focus would just read
  // as lag to someone tabbing through.
  document.addEventListener('focusin', function (e) {
    const t = trigger(e);
    if (t) { clearTimeout(timer); show(t); }
    else if (current) hide();
  });
  document.addEventListener('focusout', function (e) {
    if (trigger(e)) hide();
  });

  // Escape closes. This is standard keyboard behaviour, not a dismiss control:
  // nothing visible is added to the bubble for it.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && current) hide();
  });

  // A tooltip is anchored to a rect we measured once; the moment that rect can
  // have moved, the honest thing is to close rather than to chase it.
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
})();
