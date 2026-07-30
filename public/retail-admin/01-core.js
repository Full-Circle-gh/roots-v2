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

function toast(msg, kind = 'ok', ms) {
  const t = $('#toast');
  t.textContent = msg;
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
      const t = new Error('request timed out');
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
    const err = new Error(j.message ? `${j.message} [${code}]` : code);
    err.code = j.error || ('http_' + r.status);  // raw code for programmatic checks
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
function thumbUrl(p) { return p?.image_url || p?.image_data || ''; }
function fmt(n) { return Number(n || 0).toFixed(2); }

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
function setCaps(list){ CAPS = Array.isArray(list) ? new Set(list) : null; try { applyCapGates(); } catch (e) {} }

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
  delivery: 'delivery:view', meituan: 'meituan:view', guanyi: 'guanyi:view',
  integrations: 'integrations:view', eleme: 'eleme:view',
  activity: 'activity:view', purchasing: 'purchasing:view',
  config: ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config'],
};
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
  document.querySelectorAll('#rm-bottomnav [data-go]').forEach(btn => {
    const cap = TAB_CAP[btn.dataset.go];
    if (cap === undefined) return;
    btn.style.display = _capAllows(cap) ? '' : 'none';
  });
  // Generic hook: tag any button/section with data-cap="x" (or "x y" for any-of)
  // and it disappears for operators without it. Used by section files in later phases.
  document.querySelectorAll('[data-cap]').forEach(el => {
    const v = el.dataset.cap.trim();
    el.style.display = _capAllows(v.includes(' ') ? v.split(/\s+/) : v) ? '' : 'none';
  });
  // Last, because it counts what the passes above just hid.
  railSyncGroups();
}
window.can = can; window.canAny = canAny; window.applyCapGates = applyCapGates; window.setCaps = setCaps;

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
// buttons on #tab-sales call this; it clicks the channel's rail button, which
// activates that tab AND fires its existing init (mtAdminInit / gyAdminInit /
// elAdminInit) via that button's own onclick. Keeps one source of truth for
// tab activation instead of re-implementing it here.
function salesGo(channel) {
  const btn = document.querySelector('.tabs [data-tab="' + channel + '"]');
  if (btn) btn.click();
}
// Activate a tab/section by name from OUTSIDE the rail (e.g. the topbar Inbox
// dropdown, or in-page buttons like the Sales channel cards). When the tab has
// a rail button, CLICK it — that's the one source of truth that both activates
// the section and fires the tab's init (mtAdminInit / gyAdminInit / …) via the
// button's own onclick. Toggling classes by hand here skipped the init, which
// left data tabs opened this way stuck on their static "Loading…" placeholders.
// The manual path stays as the fallback for sections with no rail button
// (Inbox: Reviews / Feedback).
function goTab(tab) {
  const btn = document.querySelector('.tabs [data-tab="' + tab + '"]');
  if (btn) { btn.click(); return; }
  $$('.side-drawer.open').forEach(d => closeDrawer(d));
  // A rail-less tab (a channel admin, the Product Page Editor) lights the row it
  // sits under rather than nothing at all — RAIL_STANDIN names it. Everything
  // else lights itself; a tab in neither camp (Inbox's reviews / feedback, which
  // live in the topbar) lights nothing, which is the honest answer.
  const lit = RAIL_STANDIN[tab] || tab;
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === lit));
  $$('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  $$('.tabs-group').forEach(g => {
    const has = !!g.querySelector('[data-tab="' + lit + '"]');
    g.classList.toggle('has-active', has);
  });
  railResolveFor(tab);
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
// Topbar Inbox dropdown (Reviews / Feedback).
function toggleInboxMenu(ev) {
  if (ev) ev.stopPropagation();
  const m = document.getElementById('tbInboxMenu');
  const b = document.getElementById('tbInboxBtn');
  if (!m) return;
  const willOpen = m.hasAttribute('hidden');
  m.toggleAttribute('hidden', !willOpen);
  if (b) b.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}
function closeInboxMenu() {
  const m = document.getElementById('tbInboxMenu');
  const b = document.getElementById('tbInboxBtn');
  if (m) m.setAttribute('hidden', '');
  if (b) b.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', (ev) => {
  if (!ev.target.closest || !ev.target.closest('#tbInbox')) closeInboxMenu();
});
// Sales overview → fill today's per-channel figures + the folded summary from
// /sales/summary. Called when the Sales tab is opened. Leaves the "—"
// placeholders in place on any error rather than blanking the page. dashMoney
// (part 03) is loaded by the time a tab can be clicked.
async function salesInit() {
  const set   = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const money = (n) => (typeof dashMoney === 'function' ? dashMoney(n) : '¥' + Number(n || 0));
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
const CS_KEY2CH = { wc: 'mini_app', wb: 'web', mt: 'meituan', gy: 'gzgrocery', el: 'eleme' };
function csName(ch) {
  return ({ mini_app: cuT('WeChat', '微信'), web: cuT('Web shop', '网页商店'),
            meituan: cuT('Meituan', '美团'), eleme: cuT('Eleme', '饿了么'), gzgrocery: 'Gzgrocery' })[ch] || ch;
}
let _csData = null;
function csChannel(key) { return ((_csData && _csData.channels) || []).find(c => c.channel === key); }
// Store name that follows the EN/中文 toggle. Falls back to data-no-i18n when
// only one name exists (or both are identical) so the walker leaves it alone.
function csStoreName(o) {
  const en = o.nameEn || o.name || '';
  const cn = o.nameCn || o.name || '';
  if (!en || !cn || en === cn) return '<span data-no-i18n>' + escapeHtml(en || cn) + '</span>';
  return '<span data-lang-block="en">' + escapeHtml(en) + '</span><span data-lang-block="cn">' + escapeHtml(cn) + '</span>';
}

async function csLoad() {
  try { _csData = await api('/api/retail-admin/channel-status'); csRender(); }
  catch (e) { /* leave the cards untouched on error */ }
}

function csRender() {
  if (!_csData) return;
  let anyPending = false;
  document.querySelectorAll('#tab-sales .sales-ch').forEach((card) => {
    const m = card.querySelector('[id^="sales-"][id$="-rev"]');
    const mm = m && m.id.match(/^sales-(\w+)-rev$/);
    const ch = mm && CS_KEY2CH[mm[1]];
    const info = ch && csChannel(ch);
    const btn = card.querySelector('.sales-toggle');
    if (!info || !btn) return;
    // Not-set-up channels (e.g. Eleme): leave the locked toggle + "Set up"
    // footer as salesWireSetup left them — no channel×location matrix yet.
    if (info.integrated === false) return;

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

    // Inline per-location rows (rebuilt each render), between metrics + footer.
    const prev = card.querySelector('.sales-ch-locs');
    if (prev) prev.remove();
    const box = document.createElement('div');
    box.className = 'sales-ch-locs';
    const single = cells.length <= 1;
    let html = '<div class="sales-ch-locs-hd"><span>' + cuT('Per location', '按门店') + '</span>'
      + (single ? '<span class="sales-ch-locs-note">' + cuT('serves 1 store', '仅 1 家门店') + '</span>' : '') + '</div>';
    for (const c of cells) {
      if (c.pending) anyPending = true;
      const note = (ch === 'meituan' && c.pending) ? ' <span class="sales-ch-loc-note">' + cuT('applying…', '处理中…') + '</span>' : '';
      html += '<div class="sales-ch-loc-row' + (c.open ? '' : ' closed') + '">'
        + '<span class="sales-dot ' + (c.open ? 'ok' : 'warn') + '"></span>'
        + '<span class="sales-ch-loc-nm">' + csStoreName(c) + note + '</span>'
        + '<span class="sales-ch-loc-st">' + (c.open ? cuT('Open', '营业中') : cuT('Closed', '已关闭')) + '</span>'
        + '<button class="sales-toggle sm' + (c.open ? ' on' : '') + '" type="button" aria-label="'
        + escapeHtml(c.nameEn || c.name || '') + '" onclick="csCell(\'' + ch + '\',\'' + c.storeCode + '\',' + (c.open ? 'false' : 'true') + ')"><span class="knob"></span></button>'
        + '</div>';
    }
    box.innerHTML = html;
    const foot = card.querySelector('.sales-ch-foot');
    if (foot) card.insertBefore(box, foot); else card.appendChild(box);
  });
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
    const chips = serving.map((c) => {
      const x = cellFor(c, l.storeCode); const on = x && x.open;
      return '<span class="sales-chip' + (on ? '' : ' off') + '"><span class="sales-chip-dot"></span>' + csName(c.channel) + '</span>';
    }).join('');
    const tgl = partial ? ' partial' : (allOn ? ' on' : '');
    return '<div class="sales-ch" data-on="1">'
      + '<div class="sales-ch-top"><div class="sales-ch-id">'
      + '<span class="sales-ch-ico">' + storeIcon + '</span>'
      + '<div><div class="sales-ch-name">' + csStoreName(l) + '</div>'
      + '<div class="sales-ch-stat"><span class="sales-dot ' + dot + '"></span>' + txt + '</div></div></div>'
      + '<button class="sales-toggle' + tgl + '" type="button" title="' + cuT('Open or close the whole store', '开关整个门店')
      + '" onclick="csLocation(\'' + l.storeCode + '\',' + (none ? 'true' : 'false') + ')"><span class="knob"></span></button>'
      + '</div>'
      + '<div class="sales-loc-chips">' + chips + '</div>'
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
    await api('/api/retail-admin/channel-status/channel', { method: 'POST', body: { channel: ch, open } });
    if (window.toast) toast(cuT('Saved', '已保存'));
    await csLoad();
  } catch (e) { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
};
// One store's cell for a channel (the inline row toggle).
window.csCell = async function (ch, storeCode, open) {
  try { await api('/api/retail-admin/channel-status/cell', { method: 'POST', body: { channel: ch, storeCode, open } }); await csLoad(); }
  catch (e) { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
};
// Location master: open/close EVERY channel for one store.
window.csLocation = async function (storeCode, open) {
  if (!(await askConfirm({
    title: open ? cuT('Open ALL sales channels for this location?', '开启该门店的所有销售渠道？')
                : cuT('Close ALL sales channels for this location?', '关闭该门店的所有销售渠道？'),
    confirmLabel: open ? cuT('Open all', '全部开启') : cuT('Close all', '全部关闭'),
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
function openProductEditor(id) {
  const frame = document.getElementById('frame-product-editor');
  if (frame) frame.src = '/product-editor?id=' + encodeURIComponent(id);
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
// — Inbox's reviews / feedback, which live in the topbar — resolves to root with
// nothing highlighted, which is the honest answer.
const RAIL_STANDIN = {
  meituan: 'sales', guanyi: 'sales', gzgrocery: 'sales', eleme: 'sales',
  'product-editor': 'mini-app-editor',
  // New order is a sub-page of Orders (§1.7a takeover) — the parent stays lit.
  'orders-new': 'orders',
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
let _catLangHooked = false;

const CAT_ICON = {
  grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.7"/><circle cx="15" cy="5" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="19" r="1.7"/><circle cx="15" cy="19" r="1.7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  pen:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M10 11v6M14 11v6"/></svg>',
  box:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

// Counts arrive keyed by the node's stable id, so an unsaved rename in the
// editor doesn't have to match by name. A node that has never been saved has
// no id, and therefore no products — null, not zero, so the pane can say "new".
function catCount(node) { return (node && node.id && catCounts[node.id]) || null; }

async function catLoad() {
  try {
    const [tree, counts] = await Promise.all([
      api('/api/retail-admin/category-tree'),
      api('/api/retail-admin/category-counts').catch(() => ({ counts: {} })),
    ]);
    catModel = Array.isArray(tree.data) ? JSON.parse(JSON.stringify(tree.data)) : [];
    catClean = JSON.stringify(catModel);
    catCounts = counts.counts || {};
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

// ── The status line — one sentence where three KPI tiles used to be ────────
// Tops, subs, and the one fact that costs money: which shelves the shop is
// hiding because nothing published stands on them.
function catRenderStatus() {
  const facts = document.getElementById('cat2-facts');
  const save = document.getElementById('cat2-save');
  if (!facts) return;
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
  host.innerHTML = catModel.map((t, ti) => {
    const c = catCount(t);
    const dark = c && !c.published;
    return `<button type="button" class="cat2-railrow cat2-row${ti === catSel ? ' on' : ''}" data-fk="t${catFk(t)}"
        onclick="catSelect(${ti})"
        ondragover="catDragOver(event,'top',${ti})" ondrop="catDrop(event,'top',${ti})" ondragleave="catDragLeave(event)">
      <span class="cat2-grip" draggable="true" title="${escapeAttr(cuT('Drag to reorder', '拖动排序'))}"
            onclick="event.stopPropagation()"
            ondragstart="catDragStart(event,'top',${ti})" ondragend="catDragEnd()">${CAT_ICON.grip}</span>
      <span class="nm">${escapeHtml(t.name || cuT('Untitled', '未命名'))}</span>
      ${dark ? '<span class="cat2-fact-dot" title="' + escapeAttr(cuT('Hidden — nothing published', '已隐藏 — 无上架产品')) + '"></span>' : ''}
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
  const pill = !c ? `<span class="cat2-pill cat2-pill-new">${escapeHtml(cuT('new — not saved yet', '新建 — 尚未保存'))}</span>`
    : c.published ? `<span class="cat2-pill cat2-pill-live">${escapeHtml(cuT('visible in the shop', '显示在店面'))}</span>`
    : `<span class="cat2-pill cat2-pill-hidden">${escapeHtml(cuT('hidden — nothing published', '已隐藏 — 无上架产品'))}</span>`;

  host.innerHTML = `
    <div class="cat2-panehead cat2-row" id="cat2-tophead">
      <div style="min-width:0">
        <h3 tabindex="0" title="${escapeAttr(cuT('Click to rename', '点击重命名'))}" onclick="catOpenRename('top',${catSel},-1)">${escapeHtml(t.name || cuT('Untitled', '未命名'))}<button class="cat2-icon cat2-pen-inline" type="button" title="${escapeAttr(cuT('Rename', '重命名'))}" onclick="event.stopPropagation();catOpenRename('top',${catSel},-1)">${CAT_ICON.pen}</button></h3>
        <div class="cat2-panemeta">
          <span>${escapeHtml(cuT(`${fcNum(subs.length)} subcategories`, `${fcNum(subs.length)} 个子分类`))}</span>
          <span>·</span>
          <span>${escapeHtml(c ? cuT(`${fcNum(c.n)} products`, `${fcNum(c.n)} 件产品`) : cuT('no products yet', '暂无产品'))}</span>
          ${pill}
        </div>
      </div>
      <div class="end">
        <button class="cat2-icon danger" type="button" title="${escapeAttr(cuT('Remove category', '删除主分类'))}" onclick="catRemoveTop(${catSel})">${CAT_ICON.trash}</button>
      </div>
    </div>
    <div id="cat2-tophead-rename"></div>

    <div class="cat2-sec">${escapeHtml(cuT('Subcategories — the section headings', '子分类 — 区块标题'))}</div>
    <div id="cat2-subs">${subs.map((s, si) => catSubRowHtml(s, si)).join('')
      || `<div class="cat2-empty">${escapeHtml(cuT('No section headings yet. Products land straight under the category.', '暂无区块标题。产品将直接归入该主分类。'))}</div>`}</div>
    <button class="cat2-btn cat2-btn-ghost" type="button" style="margin-top:10px" onclick="catAddSub(${catSel})">${CAT_ICON.plus}<span>${escapeHtml(cuT('Add subcategory', '新增子分类'))}</span></button>

    <div class="cat2-sec" style="margin-top:34px">${escapeHtml(cuT('Products on this shelf', '货架上的产品'))}</div>
    <div id="cat2-prods"><div class="cat2-empty">${escapeHtml(cuT('Loading…', '加载中…'))}</div></div>
  `;
  catRenderOpenRename();
  catLoadProducts();
}

function catSubRowHtml(s, si) {
  const c = catCount(s);
  const hidden = c && !c.published;
  return `<div class="cat2-sub cat2-row" id="cat2-sub-${si}" data-fk="s${catFk(s)}"
       ondragover="catDragOver(event,'sub',${si})" ondrop="catDrop(event,'sub',${si})" ondragleave="catDragLeave(event)">
    <span class="cat2-grip" draggable="true" title="${escapeAttr(cuT('Drag to reorder', '拖动排序'))}"
          ondragstart="catDragStart(event,'sub',${si})" ondragend="catDragEnd()">${CAT_ICON.grip}</span>
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
let catDrag = null;   // { kind:'top'|'sub', i }
function catDragStart(ev, kind, i) {
  catDrag = { kind, i };
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
function catDragOver(ev, kind, i) {
  if (!catDrag || catDrag.kind !== kind) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  catClearDropCues();
  if (i === catDrag.i) return;
  ev.currentTarget.classList.add(i < catDrag.i ? 'cat2-drop-before' : 'cat2-drop-after');
}
function catDragLeave(ev) { ev.currentTarget.classList.remove('cat2-drop-before', 'cat2-drop-after'); }
function catDrop(ev, kind, i) {
  if (!catDrag || catDrag.kind !== kind) return;
  ev.preventDefault();
  const from = catDrag.i;
  catDrag = null;
  catClearDropCues();
  if (from === i) { catDragEnd(); return; }
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
  }
  catUpdateDirty();
}

// ── The products standing on this shelf ────────────────────────────────────
// Read against the LAST-SAVED name (products carry saved names, so an unsaved
// rename wouldn't match until the tree lands). Twelve rows at a time, more
// revealed as the operator scrolls — the pane answers "is this shelf right?",
// not "manage stock", so it never has to send them away to see the rest.
const CAT_PROD_PAGE = 12;
let _catMoveTargets = [];    // flattened [{ top, sub }]; the <select> value is the index
let _catProdReq = 0;
let _catProdRows = [];       // all rows for the current shelf, fetched once
let _catProdShown = 0;       // how many of _catProdRows are currently rendered
let _catProdObserver = null;

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

function catProdRowHtml(p) {
  const name = escapeHtml(p.name_en || p.name_cn || ('#' + p.id));
  const thumb = p.image_data
    ? `<img class="cat2-thumb" src="${escapeAttr(p.image_data)}" alt="" loading="lazy">`
    : `<span class="cat2-thumb">${CAT_ICON.box}</span>`;
  const sub = (p.subcategory || '').trim();
  return `<div class="cat2-prod">
    ${thumb}
    <span class="pn">${name}${p.is_published ? '' : ` <span class="psub">· ${escapeHtml(cuT('draft', '未上架'))}</span>`}</span>
    <span class="psub">${escapeHtml(sub || cuT('no heading', '无区块'))}</span>
    <select title="${escapeAttr(cuT('Move to another shelf', '移动到其他分类'))}" onchange="catMoveProduct(${p.id}, this)">
      ${catMoveOptions(p.top_category, p.subcategory)}
    </select>
  </div>`;
}
function catProdStopWatching() {
  if (_catProdObserver) { _catProdObserver.disconnect(); _catProdObserver = null; }
}
// Render however many rows are currently revealed, plus a sentinel that
// reveals the next page once it scrolls into view. No click, no leaving
// the shelf — the list just keeps growing as the operator scrolls down.
function catRenderProdList() {
  const host = document.getElementById('cat2-prods');
  if (!host) return;
  catProdStopWatching();
  const shown = _catProdRows.slice(0, _catProdShown);
  let html = shown.map(catProdRowHtml).join('');
  if (_catProdShown < _catProdRows.length) html += `<div class="cat2-more" id="cat2-more"></div>`;
  host.innerHTML = html;
  const sentinel = document.getElementById('cat2-more');
  if (sentinel) {
    _catProdObserver = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return;
      _catProdShown = Math.min(_catProdShown + CAT_PROD_PAGE, _catProdRows.length);
      catRenderProdList();
    }, { rootMargin: '300px' });
    _catProdObserver.observe(sentinel);
  }
}

async function catLoadProducts() {
  const host = document.getElementById('cat2-prods');
  if (!host) return;
  catProdStopWatching();
  const top = catSavedTopName();
  if (!top) {
    host.innerHTML = `<div class="cat2-empty">${escapeHtml(cuT('Save this category, then its products can stand here.', '保存该分类后，产品即可归入此处。'))}</div>`;
    return;
  }
  const req = ++_catProdReq;
  catBuildMoveTargets();
  try {
    const { data } = await api('/api/retail-admin/category-products?' + new URLSearchParams({ top }).toString());
    if (req !== _catProdReq) return;    // the operator moved on to another shelf
    const rows = data || [];
    if (!rows.length) {
      host.innerHTML = `<div class="cat2-empty">${escapeHtml(cuT('Nothing stands on this shelf yet.', '该分类下暂无产品。'))}</div>`;
      return;
    }
    _catProdRows = rows;
    _catProdShown = Math.min(CAT_PROD_PAGE, rows.length);
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
  const _saveBar = document.querySelector('.settings-body > .save-bar');
  if (_saveBar) _saveBar.style.display = (sub === 'ops') ? 'none' : '';
  // Lazy-load the Operations panel's live data each time it is opened.
  if (sub === 'ops') loadOpsPanel();
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
