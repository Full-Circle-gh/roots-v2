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
// A one-shot note for the NEXT drawer render — set by the create flow when
// something happened the operator didn't type (a legacy balance arrived, or
// their new customer turned out to already exist). Consumed on render and
// cleared, so it never reappears when they open that customer again later.
// Inline in the drawer rather than a toast: the note explains figures that are
// right there, and a toast would announce them somewhere else and then leave.
let CU_PENDING_NOTE = null;
let cuSearchTimer = null;
// Roster segment — '' | 'new_week' | 'sleeping' | 'blocked'. The cuts an
// operator actually reaches for, one tap each. 'blocked' replaces the old
// "Include blocked" checkbox: the chip only exists when someone IS blocked.
let CU_SEGMENT = '';
// Set from the server's `hidden_by_filters` on every load — see cuLoad.
let CU_HIDDEN = null;

// Sorting is no longer an operator control — the column headers carry no
// carets. These two are kept only because the endpoint takes them, and they
// pin the roster to its one sensible default order: most recently seen first.
let CU_SORT = 'last_seen';
let CU_SORT_DIR = 'desc';
let CU_TIER_FILTERS = new Set();
// Channel filter — single value, '' = all. Lives in the chip strip above the
// table (same pill/icon/label look Orders used before it moved to a
// dropdown — see .chd-btn there), not a column popover: it's the filter
// reached for on every visit, so it's one click, always visible.
// Filters on each customer's MOST RECENT order's channel (backend default
// 'wechat' for customers with zero orders yet, the only signup path today).
let CU_CHAN_FILTER = '';
// Tag facet (audit E-02). A Set, not a single value, because tags are the one
// facet where "vip OR wholesale" is an ordinary thing to ask for — a person is
// in one tier and signed up through one channel, but can carry several tags.
let CU_TAG_FILTERS = new Set();
// Every tag the account actually uses, with counts, from the roster response.
// Built server-side from the stored column, so the menu can only ever offer a
// group that exists.
let CU_TAG_VOCAB = [];
const CU_TIER_LABEL = { seed: 'Seed · 种子', sprout: 'Sprout · 嫩芽', root: 'Root · 根系', tree: 'Tree · 大树' };

function cuSearchDebounced() {
  clearTimeout(cuSearchTimer);
  cuSearchTimer = setTimeout(() => { CU_PAGE = 1; cuLoad(); }, 220);
}

// Any filter change re-cuts the roster, so the operator's page number is
// meaningless against the new result set — go back to the first page. (Search
// already does this via cuSearchDebounced; tier/sort/segment used to keep the
// old page and could land the operator on an empty one.)
function cuFilterChanged() {
  CU_PAGE = 1;
  cuLoad();
}

function cuSegment(btn, seg) {
  CU_SEGMENT = seg;
  const bar = document.getElementById('cu-segs');
  if (bar) bar.querySelectorAll('.cul-seg').forEach(b => b.classList.toggle('on', b === btn));
  cuFilterChanged();
}

// ── Filter row — Tier and Channel dropdowns ──────────────────────────────
// Sorting is gone from the column headers (no carets), and the tier funnel /
// channel chip strip are gone with it. Both filters are dropdowns now; when
// either is set to anything but All its button becomes the applied-filter
// pill itself — Ink fill, the chosen value, a hairline divider, then ×. There
// is no separate pill element: a second chip restating the button beside it
// was the redundancy the strip already had.
//
// CU_TIER_FILTERS stays a Set even though the dropdown picks one value at a
// time.
const CU_TIER_ORDER = ['tree', 'root', 'sprout', 'seed'];
// value → [EN, 中文]. Labels follow ordChannelLabel() in 04-orders.js, which is
// what the operator reads on every order row: WeChat / Web / Manual. The stored
// value really is `wechat` — the design mockup's key was `mini`, and filtering
// on that would have matched nothing at all.
// ⚠ Meituan and Gzgrocery are deliberately absent: every order on both carries
// a NULL customer_id, so neither filter can ever return a customer. Settled
// 2026-07-26 against live data — do not re-add them.
//
// ⚠ KNOWN, DELIBERATE INCONSISTENCY: Orders' own channel dropdown
// (retail-admin.html) and the mobile order cards (chanLabel, same file) still
// call this channel "Mini app". Orders is internally split — ordChannelLabel()
// in 04-orders.js, which labels every order ROW, already says "WeChat", and
// that is the spelling taken here. Orders is a separate pass; the two
// remaining "Mini app" spellings were left knowingly on 2026-07-26 and are
// recorded rather than fixed. Not an oversight.
const CU_CHAN_OPTS = [
  ['',       'All channels', '全部渠道'],
  ['wechat', 'WeChat',       '微信'],
  ['web',    'Web',          '网页'],
  ['manual', 'Manual',       '手动'],
];
let CU_MENU_OPEN = null;   // 'tier' | 'chan' | null

function cuMenuToggle(kind, e) {
  if (e) e.stopPropagation();
  CU_MENU_OPEN = (CU_MENU_OPEN === kind) ? null : kind;
  cuPaintFilterBar();
  if (CU_MENU_OPEN) setTimeout(() => document.addEventListener('mousedown', cuMenuOutside), 0);
  else document.removeEventListener('mousedown', cuMenuOutside);
}
function cuMenuClose() {
  CU_MENU_OPEN = null;
  document.removeEventListener('mousedown', cuMenuOutside);
  cuPaintFilterBar();
}
function cuMenuOutside(e) {
  if (e.target.closest && e.target.closest('.cul-selwrap')) return;
  cuMenuClose();
}
function cuPickTier(v) {
  CU_TIER_FILTERS.clear();
  if (v) CU_TIER_FILTERS.add(v);
  cuMenuClose();
  cuPaintTierFilterUI();
  cuFilterChanged();
}
function cuPickChan(v) {
  CU_CHAN_FILTER = v || '';
  cuMenuClose();
  cuPaintFilterBar();
  cuFilterChanged();
}
// The × on an applied pill. It must actually clear the filter — an × that only
// closes a menu is an inert control.
function cuToggleTag(v) {
  if (!v) CU_TAG_FILTERS.clear();
  else if (CU_TAG_FILTERS.has(v)) CU_TAG_FILTERS.delete(v);
  else CU_TAG_FILTERS.add(v);
  // The menu stays OPEN on a tag pick, unlike Tier and Channel: picking several
  // is the point, and closing after each one would make choosing three tags
  // three round trips through the trigger.
  cuPaintFilterBar();
  cuFilterChanged();
}
function cuClearTags(e) { if (e) e.stopPropagation(); CU_TAG_FILTERS.clear(); cuMenuClose(); cuFilterChanged(); }
function cuClearTier(e) { if (e) e.stopPropagation(); cuPickTier(''); }
function cuClearChan(e) { if (e) e.stopPropagation(); cuPickChan(''); }

function cuTierFilterClear() { cuPickTier(''); }
function cuTierFilterRemove() { cuPickTier(''); }

function cuPaintTierFilterUI() {
  cuPaintFilterBar();
}

function cuCaretSvg() {
  return '<svg class="cr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
}
function cuClearSvg(fn) {
  return `<span class="cul-clear" role="button" tabindex="0" onclick="${fn}(event)"
     title="${cuT('Clear filter', '清除筛选')}" aria-label="${cuT('Clear filter', '清除筛选')}"
     ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></span>`;
}
function cuPaintFilterBar() {
  const tierBtn = document.getElementById('cu-tier-btn');
  const chanBtn = document.getElementById('cu-chan-btn');
  if (tierBtn) {
    const t = [...CU_TIER_FILTERS][0] || '';
    const on = !!t;
    tierBtn.classList.toggle('on', on);
    tierBtn.innerHTML = `${cuT('Tier', '等级')}: ${on ? (CU_TIER_LABEL[t] || t) : cuT('All', '全部')} `
      + (on ? cuClearSvg('cuClearTier') : cuCaretSvg());
  }
  if (chanBtn) {
    const opt = CU_CHAN_OPTS.find(o => o[0] === CU_CHAN_FILTER) || CU_CHAN_OPTS[0];
    const on = !!CU_CHAN_FILTER;
    chanBtn.classList.toggle('on', on);
    chanBtn.innerHTML = `${cuT('Channel', '渠道')}: ${cuT(opt[1], opt[2])} `
      + (on ? cuClearSvg('cuClearChan') : cuCaretSvg());
  }
  const tagBtn = document.getElementById('cu-tag-btn');
  if (tagBtn) {
    const n = CU_TAG_FILTERS.size;
    // Hidden entirely until the account has tagged somebody. A facet with
    // nothing behind it is a control that can only disappoint.
    tagBtn.closest('.cul-selwrap').hidden = !(CU_TAG_VOCAB.length || n);
    tagBtn.classList.toggle('on', n > 0);
    const label = n === 0 ? cuT('All', '全部')
                : n === 1 ? [...CU_TAG_FILTERS][0]
                : cuT(n + ' tags', n + ' 个标签');
    tagBtn.innerHTML = `${cuT('Tags', '标签')}: ${escapeHtml(label)} `
      + (n ? cuClearSvg('cuClearTags') : cuCaretSvg());
  }
  const tagMenu = document.getElementById('cu-tag-menu');
  if (tagMenu) {
    tagMenu.hidden = CU_MENU_OPEN !== 'tag';
    tagMenu.innerHTML =
      `<button type="button" class="${CU_TAG_FILTERS.size ? '' : 'sel'}" onclick="cuToggleTag('')">${escapeHtml(cuT('All tags', '全部标签'))}</button>`
      + CU_TAG_VOCAB.map(({ tag, count }) =>
          `<button type="button" class="${CU_TAG_FILTERS.has(tag) ? 'sel' : ''}" onclick="cuToggleTag('${escapeAttr(tag)}')">`
          + `${escapeHtml(tag)} <span class="muted">${count}</span></button>`).join('');
  }

  const tierMenu = document.getElementById('cu-tier-menu');
  const chanMenu = document.getElementById('cu-chan-menu');
  if (tierMenu) {
    tierMenu.hidden = CU_MENU_OPEN !== 'tier';
    const cur = [...CU_TIER_FILTERS][0] || '';
    tierMenu.innerHTML = [['', cuT('All tiers', '全部等级')]]
      .concat(CU_TIER_ORDER.map(t => [t, CU_TIER_LABEL[t] || t]))
      .map(([v, l]) => `<button type="button" class="${v === cur ? 'sel' : ''}" onclick="cuPickTier('${v}')">${l}</button>`).join('');
  }
  if (chanMenu) {
    chanMenu.hidden = CU_MENU_OPEN !== 'chan';
    // Each option carries its channel's glyph, from the same shared CHAN_ICON
    // the rows use — so the icon an operator picks in the menu is the icon they
    // then see on the rows it returns. 'All channels' has its own glyph in that
    // map ('all'), so the whole menu is iconed rather than three-of-four.
    chanMenu.innerHTML = CU_CHAN_OPTS
      .map(([v, en, cn]) => `<button type="button" class="cul-menu-chan${v === CU_CHAN_FILTER ? ' sel' : ''}" onclick="cuPickChan('${v}')"><span class="cul-menu-ico">${chanIcon(v || 'all')}</span>${cuT(en, cn)}</button>`).join('');
  }
}

// Clears every filter — used by the "no results" state's own action.
function cuFilterClearAll() {
  CU_TIER_FILTERS.clear();
  CU_TAG_FILTERS.clear();
  CU_CHAN_FILTER = '';
  CU_SEGMENT = '';
  const q = document.getElementById('cu-q'); if (q) q.value = '';
  const segs = document.getElementById('cu-segs');
  if (segs) segs.querySelectorAll('.cul-seg').forEach(b => b.classList.toggle('on', (b.dataset.seg || '') === ''));
  cuPaintTierFilterUI();
  cuFilterChanged();
}
// True when anything is narrowing the roster — drives which empty state shows.
function cuAnyFilter() {
  const q = document.getElementById('cu-q');
  return !!(CU_SEGMENT || CU_TIER_FILTERS.size || CU_TAG_FILTERS.size || CU_CHAN_FILTER || (q && q.value.trim()));
}

// ── Customers stat strip — three figures, then the roster ────────────────
// Two cheap fetches: the today dashboard (new_customers + baseline delta +
// hourly sparkline, plus a tiers snapshot whose sum is the non-blocked base)
// and a single customers count (includeBlocked=1, pageSize=1) for the grand
// total. Blocked = total − active base, so no third call is needed. The old
// "Active base" card showed exactly that subtraction and is gone.
let _CU_KPI_AT = 0;
let _CU_KPI_DASH = null;
let _CU_KPI_TOTAL = null;
let _CU_KPI_RETURNING = null; // { buyers, returners } | null
// Real per-segment counts from the server: { all, new_week, sleeping, blocked }.
// Only Blocked is painted today (it always had a count); the other three are
// fetched now so the chips can show theirs without a second round of plumbing.
let _CU_SEG_COUNTS = null;
let _CU_KPI_LANG_HOOKED = false;
async function cuLoadKpis(force) {
  if (!document.getElementById('cu-stats')) return;
  if (!force && Date.now() - _CU_KPI_AT < 45000) return;
  _CU_KPI_AT = Date.now();
  if (!_CU_KPI_LANG_HOOKED && window.onLangChange) { _CU_KPI_LANG_HOOKED = true; onLangChange(cuRepaintKpis); }
  const todayGz = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const [dash, tot] = await Promise.all([
      api(`/api/retail-admin/dashboard?from=${todayGz}&to=${todayGz}`),
      api('/api/retail-admin/customers?includeBlocked=1&pageSize=1&withReturning=1&withSegments=1'),
    ]);
    _CU_KPI_DASH = dash.data || {};
    _CU_KPI_TOTAL = (tot && typeof tot.total === 'number') ? tot.total : null;
    _CU_KPI_RETURNING = (tot && tot.returning) ? tot.returning : null;
    _CU_SEG_COUNTS = (tot && tot.segments) ? tot.segments : null;
    cuRenderKpis();
  } catch (e) {}
}
// Blocked count, cached for the segment chip (cuLoad paints it too). Now a
// real COUNT(is_blocked = 1) from the server; the old total − Σ tier-counts
// subtraction stays only as the fallback for a response without `segments`.
let _CU_BLOCKED = 0;
function cuBlockedCount() {
  if (_CU_SEG_COUNTS && typeof _CU_SEG_COUNTS.blocked === 'number') return _CU_SEG_COUNTS.blocked;
  const d = _CU_KPI_DASH; if (!d) return 0;
  const activeBase = (d.tiers || []).reduce((s, t) => s + Number(t.n || 0), 0);
  const total = _CU_KPI_TOTAL != null ? _CU_KPI_TOTAL : activeBase;
  return Math.max(0, total - activeBase);
}
function cuRenderKpis() {
  const d = _CU_KPI_DASH; if (!d) return;
  const activeBase = (d.tiers || []).reduce((s, t) => s + Number(t.n || 0), 0);
  const total = _CU_KPI_TOTAL != null ? _CU_KPI_TOTAL : activeBase;
  _CU_BLOCKED = cuBlockedCount();
  // Buyers — accounts with at least one order. Same figure Returning rate
  // has always divided by; now it leads the strip instead of raw signups.
  const ret = _CU_KPI_RETURNING;
  const buyers = (ret && typeof ret.buyers === 'number') ? ret.buyers : null;
  dashCountUp($('#cu-kpi-buyers'), buyers != null ? buyers : 0);
  dashCountUp($('#cu-kpi-new'), Number(d.kpis && d.kpis.new_customers || 0));
  // Returning rate — share of buyers who came back for a 2nd order.
  // 🔴 ZERO IS A REAL ANSWER. With no buyers this used to print a dash, which
  // makes the reader guess between "none", "not loaded" and "broken". "0%" is
  // true and says which. The sub-line beneath already explains why it's zero.
  const retFig = $('#cu-kpi-returning');
  if (retFig) {
    retFig.textContent = (ret && ret.buyers > 0)
      ? Math.round(ret.returners / ret.buyers * 100) + '%'
      : '0%';
  }
  // Never ordered — total minus buyers. The signup-to-purchase gap the old
  // "Total customers" tile hid; same numbers, framed as the one worth acting on.
  const neverFig = $('#cu-kpi-neverordered');
  if (neverFig) {
    // Same rule: a real 0, never a dash. (An outright load FAILURE is a
    // different state and blanks the tiles — see cuKpisNotLoaded.)
    dashCountUp(neverFig, (buyers != null && total > 0) ? Math.max(0, total - buyers) : 0);
  }
  // Nobody blocked = nothing to show. An empty state shouldn't own a card, so
  // the tile (and its swipe dot, and the filter chip) simply aren't there.
  const bTile = $('#cu-kpi-blocked-tile');
  if (bTile) {
    bTile.classList.toggle('is-hidden', _CU_BLOCKED === 0);
    bTile.classList.toggle('alert', _CU_BLOCKED > 0);
    if (_CU_BLOCKED > 0) dashCountUp($('#cu-kpi-blocked'), _CU_BLOCKED);
  }
  // All four chips carry their real count. A chip with nothing to report shows
  // NO number — never a zero, which reads as a measurement rather than an
  // absence. The chips themselves always render: a chip is how an operator
  // learns the cut exists, so it must not appear and vanish with its contents.
  const seg = _CU_SEG_COUNTS || {};
  const paintCt = (id, v) => {
    const el = $(id); if (!el) return;
    const n = Number(v || 0);
    el.textContent = n ? cuNum(n) : '';
    el.classList.toggle('is-none', !n);   // hides pill, dot and number together
  };
  paintCt('#cu-seg-all-ct',     seg.all);
  paintCt('#cu-seg-new-ct',     seg.new_week);
  paintCt('#cu-seg-sleep-ct',   seg.sleeping);
  paintCt('#cu-seg-blocked-ct', _CU_BLOCKED);
  // The last blocked customer was just unblocked while that chip was active —
  // fall back to All rather than leaving the operator on an empty roster.
  if (_CU_BLOCKED === 0 && CU_SEGMENT === 'blocked') {
    const all = document.querySelector('#cu-segs .cul-seg[data-seg=""]');
    if (all) cuSegment(all, '');
  }
  cuRepaintKpis();
}
function cuRepaintKpis() {
  const d = _CU_KPI_DASH; if (!d) return;
  const k = d.kpis || {}, b = d.baseline || null;
  // No sparkline here — the tiles carry a label, a number and one line of
  // words, and nothing on this page draws a chart. The trend data still comes
  // down with the dashboard payload; it just isn't rendered.
  // Fewer signups than usual is not an alarm — no red arrow, no percentage.
  // Say it in words, in graphite, and keep the number in the tooltip.
  const word = $('#cu-kpi-new-word');
  if (word) {
    const cur  = Number(k.new_customers || 0);
    const base = b && b.new_customers;
    let text = '', tip = '';
    if (!cur) text = cuT('none yet today', '今日暂无');
    else if (!base || base.delta == null) text = cuT('no baseline yet', '暂无基准');
    else {
      const delta = Math.round(base.delta);
      text = delta > 15 ? cuT('busier than usual', '比平时更多')
           : delta < -15 ? cuT('quieter than usual', '比平时更少')
           : cuT('about usual', '与平时相当');
      tip = cuT(`${dashTrim(base.avg)}/day over the last ${b.days} days`,
                `近 ${b.days} 日均值 ${dashTrim(base.avg)}/日`);
    }
    word.textContent = text;
    word.title = tip;
  }
  const retSub = $('#cu-kpi-returning-sub');
  if (retSub) {
    const ret = _CU_KPI_RETURNING;
    retSub.textContent = (ret && ret.buyers > 0)
      ? cuT(`${ret.returners} of ${ret.buyers} buyers`, `${ret.buyers} 位买家中 ${ret.returners} 位`)
      : cuT('no orders yet', '暂无订单');
  }
  const buySub = $('#cu-kpi-buyers-sub');
  if (buySub) {
    const ret = _CU_KPI_RETURNING;
    buySub.textContent = (ret && ret.buyers > 0 && _CU_KPI_TOTAL != null)
      ? cuT(`of ${_CU_KPI_TOTAL} accounts`, `共 ${_CU_KPI_TOTAL} 个账户`)
      : cuT('no orders yet', '暂无订单');
  }
  const neverSub = $('#cu-kpi-neverordered-sub');
  if (neverSub) {
    const ret = _CU_KPI_RETURNING;
    if (ret && typeof ret.buyers === 'number' && _CU_KPI_TOTAL) {
      const pct = Math.round((_CU_KPI_TOTAL - ret.buyers) / _CU_KPI_TOTAL * 100);
      neverSub.textContent = cuT(`${pct}% of accounts`, `占账户 ${pct}%`);
    } else {
      neverSub.textContent = cuT('no orders yet', '暂无订单');
    }
  }
  const bsub = $('#cu-kpi-blocked-sub');
  if (bsub) bsub.textContent = cuT('tap the chip to review', '点标签查看');
}
// ── Row rendering helpers ────────────────────────────────────────────────
// Last unfiltered roster size, so the "no results" sentence can say how many
// customers the filter looked through.
let CU_TOTAL_ALL = 0;

function cuNum(v) { return Number(v || 0).toLocaleString('en-US'); }
// Plain-text money for places that can't take markup (modal copy, titles).
// Same rule as cuMoney/yuan: comma-grouped, a trailing .00 dropped, real
// decimals kept.
function cuMoneyPlain(v) {
  const n = Number(v || 0);
  const whole = Math.round(n * 100) % 100 === 0;
  return acWrap(n.toLocaleString('en-US', whole
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

// Order status, spelled the way the whole product spells it. humanStatus()
// (04-orders.js) is the single source: it turns the raw enum into a real label
// ('pending_payment' -> "Pending") and relabels dispatched/delivered for pickup
// orders ("Ready" / "Picked up"), which no amount of CSS could do.
// ⚠ Do NOT fall back to raw `o.status` or to text-transform:capitalize — the
// first prints an enum at the operator and the second turns "Awaiting restock"
// into "Awaiting Restock" and "Rider coming" into "Rider Coming".
function cuStatusLabel(o) {
  return (typeof humanStatus === 'function')
    ? humanStatus(o.status, o.fulfillment_type)
    : String(o.status || '');
}
// First letter up, for raw enums that have no label map of their own (top-up
// status: success / pending / failed). Only the first word, unlike CSS.
function cuCap(s) {
  const t = String(s || '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}
// Points-ledger sources. Every value live in retail_points_transactions today:
// order_earn, migration, order_redeem, poll_vote, refund_reverse,
// refund_redeem, order_addon_earn, admin_adjust, topup_bonus. An unmapped
// source falls back to its raw key rather than a guess — visibly odd is better
// than plausibly wrong, and it tells us a new source appeared.
const CU_PTS_SOURCE = {
  order_earn:       ['Earned on order', '订单获得'],
  order_addon_earn: ['Earned on add-on', '加购获得'],
  order_redeem:     ['Redeemed on order', '订单抵扣'],
  refund_reverse:   ['Reversed by refund', '退款收回'],
  refund_redeem:    ['Returned by refund', '退款返还'],
  migration:        ['Carried over', '账户迁移'],
  topup_bonus:      ['Top-up bonus', '充值赠送'],
  poll_vote:        ['Poll vote', '投票获得'],
  admin_adjust:     ['Staff adjustment', '后台调整'],
  expiry:           ['Expired', '已过期'],
};
// Rows in retail_topup_transactions whose payment_method is NOT a payment —
// they are ledger movements that happen to live in the top-up table. Left
// alone they printed their raw enum through paymentBrandHTML's fallback and
// read as money the customer had handed over. They are labelled from
// CU_PTS_SOURCE above, so the SAME event is named identically here and in the
// Points ledger: a redemption is "Redeemed on order" in both places.
// (The aggregate above this list already excludes admin_adjust; these three
// were only ever wrong in the ROW list.)
const CU_NON_PAYMENT_METHODS = new Set(['admin_adjust', 'order_redeem', 'refund_reverse']);
function cuPtsSource(src) {
  const m = CU_PTS_SOURCE[src];
  return m ? cuT(m[0], m[1]) : String(src || '');
}
// Money drops a trailing .00 — "¥1,430", not "¥1430.00" — but real decimals
// still show, because ¥12.50 rounded to ¥13 is a different number.
function cuMoney(v) {
  const n = Number(v || 0);
  const whole = Math.round(n * 100) % 100 === 0;
  const s = n.toLocaleString('en-US', whole
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '<span class="cur">' + acCurrencySymbol() + '</span>' + s;
}

// The Channel cell — glyph on the left, the channel's name on the right.
//
// This is the Orders channel column's pattern, deliberately: Orders builds
// `<div class="ord-chan">${chanIcon(o.channel)}${ordChannelLabel(o)}</div>`
// (04-orders.js), and an operator reading both pages should not have to learn
// two ways of being told the same thing. It used to be a bare glyph tucked
// between the avatar and the name, which asked the operator to decode an icon
// — and to hover it to find out they'd guessed wrong.
//
// r.channel is the SIGNUP channel, derived server-side from openid by
// CHANNEL_SQL (retail.js) — where they signed up, not where they last ordered.
// The same expression answers the Channel filter, so a row's channel and the
// filter that returns it cannot disagree. The LABEL likewise comes from
// CU_CHAN_OPTS, which is what the "Channel" dropdown reads, so the word on the
// row is the word in the filter that found it — one term per value, always.
//
// 🔴 NO FALLBACK. An unrecognised openid classifies as 'unknown' and gets NO
// icon rather than a guess — not a default, not a placeholder, not a dash, the
// same rule an absent SKU follows. Zero rows are unknown today; a future signup
// path that forgets to namespace its openid would land here and say so, which
// is the point. Do NOT add an `|| chanIcon('wechat')` fallback.
// The unknown row shows its RAW key as the text, iconless — the same choice
// ordChannelLabel() makes with its `return c`: visibly odd beats plausibly
// wrong. It is never dressed up as a channel we support.
// Channel glyphs come from the SHARED CHAN_ICON map via chanIcon() (01-core.js)
// — the same source the Orders dropdown and the Orders rows draw from — so a
// Customers row, its filter option, and an Orders row all show one glyph per
// channel. Do NOT re-add a local copy here: that is how the row and the filter
// drifted apart in the first place.
function cuChanCell(r) {
  const c = String(r.channel || '').toLowerCase();
  const opt = CU_CHAN_OPTS.find(o => o[0] === c && o[0]);
  // 🔴 THE CHECK MUST HAPPEN BEFORE THE CALL, and it must be against our OWN
  // option list — never against chanIcon()'s return value. chanIcon ends in
  // `|| CHAN_ICON.wechat`, so it ALWAYS returns a glyph: for an unrecognised
  // channel it hands back the WeChat one. Testing what it gave us would
  // therefore always pass, silently reinstating the invented-channel claim
  // this rule exists to prevent. Ask "is this a channel we know?" first;
  // only then ask for its glyph. Unknown ⇒ no icon, raw key as the word.
  if (!opt) return `<span class="cul-chan is-unknown">${escapeHtml(c)}</span>`;
  return `<span class="cul-chan">${chanIcon(c)}${escapeHtml(cuT(opt[1], opt[2]))}</span>`;
}

// One state, drawn inside the card where the rows would be.
function cuStateRow(title, body, actions) {
  const wave = '<svg class="st-wave" viewBox="0 0 120 22" fill="none" stroke="currentColor" stroke-width="2"><path d="M0 11h30c4 0 5-7 9-7s5 14 9 14 5-7 9-7 5 7 9 7 5-14 9-14 5 7 9 7h27"/></svg>';
  return `<tr><td colspan="9" class="muted"><div class="cul-state">${wave}`
    + `<div class="st-title">${title}</div><div class="st-body">${body}</div>`
    + (actions ? `<div class="st-actions">${actions}</div>` : '')
    + `</div></td></tr>`;
}
function cuErrorRow() {
  return cuStateRow(
    cuT("Couldn't load your customers", '无法加载顾客名单'),
    cuT("The request didn't come back. Nothing has changed — try again.", '请求没有返回。数据没有变化 — 请重试。'),
    `<button type="button" class="btn cul-statebtn" id="cu-retry" onclick="cuRetry(this)">${cuT('Retry', '重试')}</button>`);
}
// The roster's one control that talks to the server. It disables and says so
// while it works — the only in-flight state this page owns (every control that
// writes lives in the drawer and the modals).
async function cuRetry(btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = cuT('Retrying…', '正在重试…');
  }
  await cuLoad();
  cuLoadKpis(true);
}
// Names what is narrowing the roster, so the empty sentence can point at it.
function cuFilterSummary() {
  const q = document.getElementById('cu-q');
  const term = q ? q.value.trim() : '';
  if (term) return cuT(`“${escapeHtml(term)}”`, `“${escapeHtml(term)}”`);
  return cuT('these filters', '当前筛选');
}
// The search matched, and every match is behind a filter the operator set.
//
// This state exists because of one number that could not be found: the customer
// was blocked, every segment but Blocked carries `is_blocked = 0`, and the
// roster answered "nothing matches" about a record holding exactly that phone.
// So it says which filter is in the way, how many rows are behind it, and offers
// to go there — the search term is always kept, because that is what the
// operator is actually doing.
function cuHiddenMatchState() {
  const n = Number(CU_HIDDEN && CU_HIDDEN.total || 0);
  const blocked = Number(CU_HIDDEN && CU_HIDDEN.blocked || 0);
  const allBlocked = blocked >= n;
  const who = n === 1 ? cuT('1 customer', '1 位顾客') : cuT(`${cuNum(n)} customers`, `${cuNum(n)} 位顾客`);
  const body = allBlocked
    ? cuT(`${who} matching ${cuFilterSummary()} is blocked, and blocked accounts show up nowhere but the Blocked list.`,
          `有${who}匹配${cuFilterSummary()},但已被封禁 — 封禁的账号只出现在“已封禁”名单中。`)
    : cuT(`${who} matching ${cuFilterSummary()} ${n === 1 ? 'is' : 'are'} outside the filters you've set.`,
          `有${who}匹配${cuFilterSummary()},但不在当前筛选范围内。`);
  const label = allBlocked
    ? (n === 1 ? cuT('Show the blocked match', '查看该封禁顾客') : cuT('Show the blocked matches', '查看这些封禁顾客'))
    : cuT('Show them', '查看');
  return cuStateRow(
    cuT(`Found — but your filters are hiding ${n === 1 ? 'it' : 'them'}`, '找到了 — 但被当前筛选隐藏'),
    body,
    `<button type="button" class="btn cul-statebtn" onclick="cuRevealHiddenMatches()">${label}</button>`);
}

// Drop the filters standing between the operator and their match, and KEEP the
// search box exactly as typed — unlike cuFilterClearAll, which clears it too and
// would answer a lookup by showing all 1,202 rows.
function cuRevealHiddenMatches() {
  const allBlocked = CU_HIDDEN && Number(CU_HIDDEN.blocked || 0) >= Number(CU_HIDDEN.total || 0);
  CU_TIER_FILTERS.clear();
  CU_CHAN_FILTER = '';
  const seg = allBlocked ? 'blocked' : '';
  const btn = document.querySelector(`#cu-segs .cul-seg[data-seg="${seg}"]`);
  cuPaintTierFilterUI();
  // cuSegment repaints the chip strip and reloads; without the chip in the DOM
  // (the Blocked chip is conditional) set the state and reload directly.
  if (btn) return cuSegment(btn, seg);
  CU_SEGMENT = seg;
  cuFilterChanged();
}

function cuSkeletonRows() {
  const w = [62, 44, 58, 38, 52, 46];
  const bar = (width, extra) => `<span class="cul-sk" style="width:${width}${extra || ''}"></span>`;
  return w.map(pc => `<tr class="cul-row">
    <td><div class="cul-who"><span class="cul-sk circle"></span><span class="main">${bar(pc + '%')}${bar(Math.round(pc * .6) + '%', ';margin-top:8px;height:10px')}</span></div></td>
    <td>${bar('64px')}</td>
    <td>${bar('58px')}</td>
    <td class="numeric">${bar('24px', ';margin-left:auto')}</td>
    <td class="numeric">${bar('54px', ';margin-left:auto')}</td>
    <td class="numeric">${bar('34px', ';margin-left:auto')}</td>
    <td class="numeric">${bar('40px', ';margin-left:auto')}</td>
    <td>${bar('52px')}</td>
    <td></td></tr>`).join('');
}
// Tiles after a failed load: their labels, and honestly nothing else. No
// invented figures, and no dashes standing in for numbers.
function cuKpisNotLoaded() {
  ['cu-kpi-buyers', 'cu-kpi-new', 'cu-kpi-returning', 'cu-kpi-neverordered'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '';
  });
  ['cu-kpi-buyers-sub', 'cu-kpi-returning-sub', 'cu-kpi-neverordered-sub'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = cuT('not loaded', '未加载');
  });
  const w = document.getElementById('cu-kpi-new-word'); if (w) w.textContent = cuT('not loaded', '未加载');
}

// No scroll watcher for the header's corners. The card clips with clip-path,
// so the band never draws a corner and there is no pinned state to track —
// the whole thing is CSS. (There was a cuPinWatch() here that toggled an
// .is-pinned class on scroll; it worked, but it was a moving part standing in
// for a static rule.)

// ── Background refresh state ───────────────────────────────────────────
// A silent load is one nobody asked for: the live nudge, the backstop poll,
// or coming back to the tab. It must be invisible when nothing moved — no
// skeleton flash, no scroll jump, no rebuild of rows that are already right.
// The fingerprint is what makes that possible: same roster in, no DOM out.
let _CU_REQ_ID = 0;          // newest request wins; older responses are dropped
let _CU_IN_FLIGHT = false;   // a load owns the table — silent ticks stand down
let _CU_LAST_FP = null;      // fingerprint of the rows currently painted
let _CU_LAST_FP_KEY = '';    // filter signature that fingerprint belongs to
let _CU_SEEN_IDS = null;     // null = first paint; no flash for rows already there

// Every value the row markup shows. If two loads fingerprint the same, the
// rebuild would paint character-for-character what's already on screen.
function _cuFp(rows) {
  return CU_TOTAL + '~' + rows.map(r => [
    r.id, r.nickname || '', r.phone || '', r.channel || '', r.tier_key || '',
    r.orders_count || 0, r.lifetime_spend || 0, r.points_balance || 0,
    r.balance || 0, r.last_login_at || '', r.is_blocked ? 1 : 0, r.seen_at ? 1 : 0,
    // Tags are drawn on the row, so a tag edit has to break the fingerprint —
    // otherwise the silent tick decides nothing changed and never repaints.
    r.tags || '',
  ].join(',')).join(';');
}

// Which cut of the roster is on screen. A different filter (or page) is a
// different baseline: reset the fingerprint so the next load rebuilds, and
// the seen-ids so rows arriving from a filter switch don't fake-flash.
function _cuFilterKey() {
  return [$('#cu-q').value.trim(), [...CU_TIER_FILTERS].join(','), [...CU_TAG_FILTERS].join(','),
          CU_CHAN_FILTER, CU_SEGMENT, CU_PAGE, CU_PAGE_SIZE].join('|');
}

// Download the customers the roster is showing — every one of them, not just
// the page on screen. Filtered exactly as the roster is: an operator looking at
// the Sleeping segment who presses Export wants the sleepers. Blocked records
// follow the roster's own rule, so the file matches what was on screen.
//
// Sort and paging are deliberately not sent: an export has no pages, and a
// spreadsheet is sorted in the spreadsheet.
function cuExportCsv() {
  const params = new URLSearchParams({
    q: ($('#cu-q') || {}).value ? $('#cu-q').value.trim() : '',
    tier: [...CU_TIER_FILTERS].join(','),
    tags: [...CU_TAG_FILTERS].join(','),
    channel: CU_CHAN_FILTER,
    segment: CU_SEGMENT,
  });
  for (const k of [...params.keys()]) if (!params.get(k)) params.delete(k);
  const qs = params.toString();
  window.location.href = '/api/retail-admin/customers/export.csv' + (qs ? '?' + qs : '');
}

// opts.silent — see the note above. Split in two so the page-clamp below can
// recurse without tripping the in-flight guard it is already holding.
async function cuLoad(opts = {}) {
  if (opts.silent && _CU_IN_FLIGHT) return;   // a real load owns the table
  _CU_IN_FLIGHT = true;
  try { return await _cuLoad(opts); }
  finally { _CU_IN_FLIGHT = false; }
}

async function _cuLoad(opts) {
  const silent = !!opts.silent;
  const myReq = ++_CU_REQ_ID;
  const params = new URLSearchParams({
    q: $('#cu-q').value.trim(),
    tier: [...CU_TIER_FILTERS].join(','),
    tags: [...CU_TAG_FILTERS].join(','),
    channel: CU_CHAN_FILTER,
    sort: CU_SORT,
    dir: CU_SORT_DIR,
    segment: CU_SEGMENT,
    page: CU_PAGE,
    pageSize: CU_PAGE_SIZE
  });
  const tbody = $('#cu-table tbody');
  // Loading — skeleton rows that settle, under the real column labels. No
  // spinner: the shape of what's coming is more use than a rotating disc.
  // A silent tick shows nothing: the rows on screen stay until better ones land.
  if (!silent) tbody.innerHTML = cuSkeletonRows();
  let j;
  try {
    const res = await fetch('/api/retail-admin/customers?' + params);
    j = await res.json();
  } catch (e) {
    // A failed background tick keeps quiet — the roster on screen is the last
    // known-good one, and replacing it with an error is a worse answer than
    // leaving it. The next tick tries again.
    if (silent) return;
    tbody.innerHTML = cuErrorRow();
    cuKpisNotLoaded();
    return;
  }
  if (!j.success) {
    if (silent) return;
    tbody.innerHTML = cuErrorRow();
    cuKpisNotLoaded();
    return;
  }
  // A newer load started while this fetch was in the air — its result is the
  // authoritative one. Ours would paint the previous filter's rows on top.
  if (myReq !== _CU_REQ_ID) return;
  CU_TOTAL = j.total || 0;
  // { total, blocked } when the search matched customers the CURRENT filters are
  // hiding — most often a blocked record, which every segment but Blocked drops.
  // Null whenever the search genuinely found nothing, so the empty state can
  // only make this claim when the server actually counted the rows.
  CU_HIDDEN = j.hidden_by_filters || null;
  // The tag menu is built from what the account uses, so it has to be repainted
  // whenever that changes — a tag added in the drawer must appear in the filter
  // on the very next load, not on the next full page refresh.
  CU_TAG_VOCAB = j.tag_vocabulary || [];
  cuPaintFilterBar();
  const rows = j.data || [];

  // Clamp: blocking a customer (or a filter's cut draining) can shrink the
  // roster under the operator's feet and leave CU_PAGE past the last page.
  // Snap back and refetch once — checked BEFORE the render, so the page that
  // no longer exists is never painted at all.
  const pages = Math.max(1, Math.ceil(CU_TOTAL / CU_PAGE_SIZE));
  if (CU_PAGE > pages) { CU_PAGE = pages; return _cuLoad(opts); }

  // A different cut of the roster is a different baseline for both the
  // fingerprint and the flash.
  const fpKey = _cuFilterKey();
  if (fpKey !== _CU_LAST_FP_KEY) {
    _CU_LAST_FP_KEY = fpKey;
    _CU_LAST_FP = null;
    _CU_SEEN_IDS = null;
  }
  // Nothing moved since the last paint — leave the DOM alone, and with it the
  // operator's scroll position and whatever row they're pointing at. The
  // `.cul-mono` test asks for a REAL row: skeleton rows share .cul-row and
  // would otherwise read as "already painted".
  const fp = _cuFp(rows);
  if (silent && fp === _CU_LAST_FP && tbody.querySelector('tr.cul-row .cul-mono, .cul-state')) return;
  const prevSeen = _CU_SEEN_IDS;
  _CU_LAST_FP = fp;
  _CU_SEEN_IDS = new Set(rows.map(r => r.id));

  if (!rows.length) {
    // Three empty states. Nothing to find at all is a compliment that names what
    // will arrive; a filter that matched nothing names the filter and offers to
    // clear it — never a compliment, the operator asked for something specific
    // and didn't get it; and a search whose matches are all HIDDEN says so and
    // goes and gets them, because "no customers match" about a customer who is
    // on file and holds that number is simply false.
    const looked = CU_TOTAL_ALL
      ? cuT(`${cuNum(CU_TOTAL_ALL)} customers`, `${cuNum(CU_TOTAL_ALL)} 位顾客`)
      : cuT('your customers', '你的顾客');
    tbody.innerHTML = CU_HIDDEN
      ? cuHiddenMatchState()
      : cuAnyFilter()
      ? cuStateRow(
          cuT('No customers match this search', '没有符合条件的顾客'),
          cuT(`Nothing in ${looked} matches ${cuFilterSummary()}. Clear it and the whole list comes back.`,
              `${looked}中没有匹配${cuFilterSummary()}的记录。清除筛选即可看到全部名单。`),
          `<button type="button" class="btn cul-statebtn" onclick="cuFilterClearAll()">${cuT('Clear filters', '清除筛选')}</button>`)
      : cuStateRow(
          cuT('No customers yet', '还没有顾客'),
          cuT('They settle in here as soon as someone orders — every channel, remembered without you asking.',
              '有人下单后就会出现在这里 — 各个渠道,自动记住,无需你操作。'));
  } else {
    CU_TOTAL_ALL = cuAnyFilter() ? CU_TOTAL_ALL : CU_TOTAL;
    tbody.innerHTML = rows.map(r => {
      const tier = escapeHtml(r.tier_key || 'seed');
      // Free-text nickname: it can contain " · ", which the i18n walker treats
      // as an EN/CN pair and splits. Shield the name and the phone — never the
      // genuine bilingual labels around them.
      const nameHtml = r.nickname
        ? `<span class="nick">${escapeHtml(r.nickname)}</span>`
        : `<span class="nick cul-empty">${cuT('No name', '未填姓名')}</span>`;
      const orders = Number(r.orders_count || 0);
      const spend  = Number(r.lifetime_spend || 0);
      const points = Number(r.points_balance || 0);
      const wallet = Number(r.balance || 0);
      return `
      <tr class="cul-row${r.is_blocked ? ' is-blocked' : ''}${r.seen_at ? '' : ' is-unseen'}" data-cu-id="${r.id}" onclick="cuOpenDetail(${r.id})">
        <td>
          <div class="cul-who">
            <span class="cul-mono" data-no-i18n>${cuMonogram(r.nickname)}</span>
            <span class="main">
              <span class="nm" data-no-i18n>${nameHtml}${r.is_blocked ? `<span class="cul-pill blocked">${cuT('Blocked', '已封禁')}</span>` : ''}</span>
              ${r.phone ? `<span class="ph" data-no-i18n>${escapeHtml(r.phone)}</span>` : ''}
              ${cuTagList(r.tags).length
                ? `<span class="cul-tags" data-no-i18n>${cuTagList(r.tags).slice(0, 3)
                    .map(t => `<span class="cul-tag">${escapeHtml(t)}</span>`).join('')
                  }${cuTagList(r.tags).length > 3 ? `<span class="cul-tag more">+${cuTagList(r.tags).length - 3}</span>` : ''}</span>`
                : ''}
            </span>
          </div>
        </td>
        <td class="cul-chancell">${cuChanCell(r)}</td>
        <td><span class="cul-pill tier-${tier}">${tier}</span></td>
        <td class="numeric cul-num ${orders ? '' : 'is-zero'}" data-no-i18n>${cuNum(orders)}</td>
        <td class="numeric cul-num ${spend  ? '' : 'is-zero'}" data-no-i18n>${cuMoney(spend)}</td>
        <td class="numeric cul-num ${points ? '' : 'is-zero'}" data-no-i18n>${cuNum(points)}</td>
        <td class="numeric cul-num ${wallet ? '' : 'is-zero'}" data-no-i18n>${cuMoney(wallet)}</td>
        <td class="cul-last${r.last_login_at ? '' : ' is-never'}" data-no-i18n>${escapeHtml(cuFmtSeen(r.last_login_at))}</td>
        <td class="cul-chev" data-no-i18n><span class="cul-chevg">›</span></td>
      </tr>`;
    }).join('');
    // One soft wash over rows that weren't there a moment ago, so a customer
    // who arrived while the operator was looking at the screen announces
    // WHICH row is new — not just that the table moved. Never on the first
    // paint (prevSeen === null): every row would flash and mean nothing.
    if (prevSeen) {
      let arrived = 0;
      for (const r of rows) {
        if (prevSeen.has(r.id)) continue;
        arrived++;
        tbody.querySelector(`tr[data-cu-id="${r.id}"]`)?.classList.add('is-fresh');
      }
      // Somebody genuinely new landed, so the tiles above the table are now
      // wrong — "New today" most of all. Force past their 45s throttle: a
      // count and the row it counts must never disagree on the same screen.
      // Only on a real arrival, so a busy stretch of nudges can't turn this
      // into a second poller.
      if (arrived) cuLoadKpis(true);
    }
  }
  rmRenderPager('cu-pager', {
    page: CU_PAGE, pageSize: CU_PAGE_SIZE, total: CU_TOTAL,
    sizes: [20, 50, 100],
    noun: { en: 'customers', one: 'customer', cn: '位客户' },
    onPage: p => {
      CU_PAGE = p;
      cuLoad();
      // Land on the top of the new page, not the foot of it.
      const tbl = document.getElementById('cu-table');
      if (tbl) tbl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    onSize: s => { CU_PAGE_SIZE = s; CU_PAGE = 1; cuLoad(); },
  });
}


async function cuOpenDetail(id, restore = null) {
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
  // A different person, so the tag draft from the last one is not theirs.
  CU_TAG_DRAFT = null;
  // The GET above stamps seen_at server-side, so this row is no longer unopened.
  // Clear it HERE rather than waiting for the next cuLoad(): dropping the class
  // lets the row's own 600ms transition settle the surface and the Sage edge out
  // under the drawer, which is the whole point of the treatment. Without this
  // the row stays tinted until something else happens to reload the roster.
  const seenRow = document.querySelector(`#cu-table tbody tr.cul-row.is-unseen[onclick*="cuOpenDetail(${id})"]`);
  if (seenRow) seenRow.classList.remove('is-unseen');
  cuRenderDetail();
  if (switching) requestAnimationFrame(() => body.classList.remove('cu-swapping'));  // fade new in
  // Returning from an order opened via a Recent-orders row: expand that ledger
  // (it may be collapsed by default) and restore the prior scroll position so
  // the operator lands on the exact same row they left from.
  if (restore && body) {
    if (restore.openRecent) {
      const fold = body.querySelector('details.cux-fold');   // first fold = Recent orders
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
  CU_TAG_DRAFT = null;
});
// Backwards-compat shim — older modal save handlers still call
// cuShowList() to return to the list after saving. Now that the list
// is always visible, that just means close the drawer.
function cuShowList() { closeDrawer('#cu-drawer'); }

// ── Header overflow menu (More ▾) ────────────────────────────────────
// Rare/destructive actions (Sign out all devices, Block) live behind one
// calm "More" button so the everyday header stays two buttons. Closed on
// outside-click; each item closes the menu before it acts.
// Esc closes whichever customer modal is open.
//
// ⚠ There was NO Esc handler for .pu-editor-bg ANYWHERE — and the ✕ has been
// carrying a `title="Close · 关闭 (Esc)"` tooltip the whole time. The interface
// was promising a behaviour that did not exist, which is worse than not
// offering it: an operator who trusts the tooltip presses Esc, nothing
// happens, and they learn to distrust the next hint the page gives them.
//
// 🔴 IT REFUSES TO FIRE MID-WRITE. If any control in the modal is disabled a
// save is in flight, and Esc is ignored. A modal that vanishes mid-save leaves
// the operator with no idea whether the write went through — they can't see
// the request, so the panel disappearing is the only evidence they have, and
// it would be lying. Same guard the buttons use, for the same reason.
// (Topmost-first ordering is moot here: only one of these opens at a time.)
const CU_MODALS = [
  ['#cu-create-bg', 'cuCloseCreate'],
  ['#cu-edit-bg',   'cuCloseEdit'],
  ['#cu-adjust-bg', 'cuCloseAdjust'],
  ['#cu-msg-bg',    'cuCloseMsg'],
  ['#cu-addr-bg',   'cuCloseAddrModal'],
];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const [sel, closer] of CU_MODALS) {
    const el = document.querySelector(sel);
    if (!el || !el.classList.contains('show')) continue;
    if (el.querySelector('.btn[disabled], button[disabled]')) return;   // mid-write
    e.preventDefault();
    if (typeof window[closer] === 'function') window[closer]();
    return;
  }
});

// Dismissing the note removes it outright — it has already been read, and it
// describes a moment (the create) rather than a state of the record.
function cuDismissNote() {
  const el = document.getElementById('cu-drawer-note');
  if (el) el.remove();
}

function cuMoreToggle() {
  const m = document.getElementById('cux-more-menu'); if (!m) return;
  m.hidden = !m.hidden;
  if (!m.hidden) setTimeout(() => document.addEventListener('mousedown', cuMoreOutside), 0);
  else document.removeEventListener('mousedown', cuMoreOutside);
}
function cuMoreClose() {
  const m = document.getElementById('cux-more-menu'); if (m) m.hidden = true;
  document.removeEventListener('mousedown', cuMoreOutside);
}
function cuMoreOutside(e) {
  if (e.target.closest && e.target.closest('.cux-more-wrap')) return;
  cuMoreClose();
}

// Small copy-to-clipboard for the header phone + openid rows.
// Copy control that confirms IN PLACE — the button's own label flips to
// "Copied" for 1.2s and settles back. No toast: a toast is a house-rule
// violation here and, worse, it confirms somewhere other than where the
// operator is looking. The label reverts on a timer rather than on the next
// render, so switching customers mid-flip can't strand it.
function cuCopyChip(btn, text) {
  if (!btn) return;
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  const settle = (ok) => {
    btn.textContent = ok ? cuT('Copied', '已复制') : cuT('Failed', '失败');
    btn.classList.toggle('ok', ok);
    clearTimeout(btn._cuCopyT);
    btn._cuCopyT = setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('ok');
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => settle(true), () => settle(false));
  } else { settle(false); }
}

// Diagnostics block — "what's happening on this customer's phone". Built from
// the retail_client_logs the mini-app posts (device + app-version snapshot per
// launch, plus any JS crash). This is the fast-triage view for when a customer
// contacts support saying the app is broken: see their exact app build, phone,
// OS, and recent errors instead of guessing. Strings use cuT (one live
// language) per the admin i18n rule — never stacked EN+CN.
// ⚠ TIMESTAMPS IN HERE STAY ABSOLUTE (cuFmtTime), and that is a deliberate
// exception to the drawer's relative-time rule. Every ledger above — recent
// orders, points, top-ups — reads "2h ago", because there you want recency at
// a glance. A diagnostics log is forensic: it is read to line an error up
// against something else that happened, so "2h ago" throws away the precision
// that makes it worth keeping. Different job, deliberately different rule.
// Do not "make it consistent" with the ledgers.
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
    ? `<span class="cul-pill blocked">${diag.error_count_7d} ${cuT('errors in 7 days', '近7天报错')}</span>`
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
        // ⚠ THE DASHES BELOW STAY. This is the ONLY place in the product
        // where a dash survives as a value, and a consistency pass will
        // otherwise "fix" it, so: in a FORENSIC LOG a dash means the log row
        // genuinely carried no value for that field — the client reported
        // nothing there. That is a fact about the record, and the reader needs
        // to see the gap to reason about it.
        // The product-wide ban is about a dash STANDING IN for something known:
        // for zero on a KPI tile, or for a missing name in the roster, where it
        // makes the reader guess between "none", "not loaded" and "broken".
        // Here there is nothing to stand in for. Decided 2026-07-26.
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
  // Same rule as the log table above: a dash here means the device snapshot
  // carried no value for that field, which is what support needs to know.
  // Not a stand-in — do not "consistency-fix" these either.
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
  const fail = () => (typeof toast === 'function' ? toast(cuT('Copy failed', '复制失败'), 'err') : null);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fail);
  } else { fail(); }
}

/* ══════════════════════════════════════════════════════════════════════════
   A NOTE AND TAGS ON A CUSTOMER (audit E-02)

   A customer record held a name, a phone, addresses, orders, points and a
   wallet, and there was nowhere to write "allergic to nuts", "always calls
   before collecting" or "wholesale — invoice monthly", and no way to mark a
   group so it could be found again. Reviews had tags; the people did not.

   Both are edited in place in the drawer. Save appears only once something has
   changed and disappears again on Reset, so the card is quiet while it is only
   being read — which is most of the time.
   ══════════════════════════════════════════════════════════════════════════ */

// Split the stored comma-separated column into a list. One place, because the
// drawer, the roster row and the filter all have to agree about what a tag is.
function cuTagList(tags) {
  return String(tags == null ? '' : tags).split(',').map(t => t.trim()).filter(Boolean);
}

function cuNotesCardHtml(c) {
  const tags = cuTagList(c.tags);
  const chips = tags.length
    ? tags.map(t => `<span class="cu-tagchip" data-no-i18n>${escapeHtml(t)}`
        + `<button type="button" class="x" title="${escapeAttr(cuT('Remove this tag', '移除该标签'))}"`
        + ` aria-label="${escapeAttr(cuT('Remove tag ' + t, '移除标签 ' + t))}" onclick="cuTagRemove('${escapeAttr(t)}')">×</button></span>`).join('')
    : `<span class="muted">${escapeHtml(cuT('No tags yet', '暂无标签'))}</span>`;
  return `
    <div class="cux-card" id="cu-notes-card">
      <div class="cux-kicker">Notes &amp; tags · 备注与标签</div>
      <div class="cu-tagrow" id="cu-tagrow">${chips}</div>
      <div class="cu-tagadd">
        <input type="text" id="cu-tag-new" maxlength="40"
               placeholder="${escapeAttr(cuT('Add a tag — e.g. wholesale', '添加标签,如 批发'))}"
               aria-label="${escapeAttr(cuT('Add a tag', '添加标签'))}"
               onkeydown="if(event.key==='Enter'){event.preventDefault();cuTagAdd();}">
        <button type="button" class="btn btn-sm" onclick="cuTagAdd()">${escapeHtml(cuT('Add', '添加'))}</button>
      </div>
      <textarea id="cu-note" class="cu-note-in" rows="3" maxlength="2000"
                aria-label="${escapeAttr(cuT('Note about this customer', '关于该顾客的备注'))}"
                placeholder="${escapeAttr(cuT('Anything your team should know — allergies, delivery quirks, invoicing.', '团队需要知道的事 — 过敏、配送要求、开票方式等。'))}"
                oninput="cuNoteChanged()">${escapeHtml(c.note || '')}</textarea>
      <div class="cu-note-foot" id="cu-note-foot" hidden>
        <button type="button" class="btn btn-sm" onclick="cuNotesReset()">${escapeHtml(cuT('Reset', '还原'))}</button>
        <button type="button" class="btn btn-sm btn-primary" onclick="cuNotesSave(this)">${escapeHtml(cuT('Save', '保存'))}</button>
      </div>
    </div>`;
}

// The tags being edited right now. Held apart from CU_CURRENT so Reset has
// something true to go back to — CU_CURRENT is the last SAVED state and must
// stay that way until a save actually lands.
let CU_TAG_DRAFT = null;

function _cuSavedTags() { return cuTagList(CU_CURRENT && CU_CURRENT.customer && CU_CURRENT.customer.tags); }
function _cuSavedNote() { return (CU_CURRENT && CU_CURRENT.customer && CU_CURRENT.customer.note) || ''; }
function _cuDraftTags() { return CU_TAG_DRAFT || _cuSavedTags(); }

function cuTagAdd() {
  const input = document.getElementById('cu-tag-new');
  if (!input) return;
  // Same normalisation the server applies, so what the chip shows is what will
  // be stored — a chip reading "VIP" that saves as "vip" is a small lie the
  // operator finds out about on the next open.
  const raw = String(input.value || '').replace(/,/g, ' ').trim().toLowerCase().slice(0, 40);
  input.value = '';
  if (!raw) return;
  const list = _cuDraftTags();
  if (list.includes(raw)) { input.focus(); return; }
  if (list.length >= 20) {
    toast(cuT('Twenty tags is the limit — a longer list stops being a way to find anyone.',
              '标签最多 20 个,再多就失去筛选意义了。'), 'err');
    return;
  }
  CU_TAG_DRAFT = list.concat(raw);
  cuNotesRepaint();
  const again = document.getElementById('cu-tag-new'); if (again) again.focus();
}

function cuTagRemove(tag) {
  CU_TAG_DRAFT = _cuDraftTags().filter(t => t !== tag);
  cuNotesRepaint();
}

// Repaint only the chip row, not the card: rebuilding the card would blow away
// whatever the operator has typed into the note beneath it.
function cuNotesRepaint() {
  const row = document.getElementById('cu-tagrow');
  if (row) {
    const list = _cuDraftTags();
    row.innerHTML = list.length
      ? list.map(t => `<span class="cu-tagchip" data-no-i18n>${escapeHtml(t)}`
          + `<button type="button" class="x" title="${escapeAttr(cuT('Remove this tag', '移除该标签'))}"`
          + ` aria-label="${escapeAttr(cuT('Remove tag ' + t, '移除标签 ' + t))}" onclick="cuTagRemove('${escapeAttr(t)}')">×</button></span>`).join('')
      : `<span class="muted">${escapeHtml(cuT('No tags yet', '暂无标签'))}</span>`;
  }
  cuNoteChanged();
}

// Show the Save/Reset foot only when there is something to save.
function cuNoteChanged() {
  const foot = document.getElementById('cu-note-foot');
  const ta = document.getElementById('cu-note');
  if (!foot || !ta) return;
  const noteDirty = String(ta.value || '') !== String(_cuSavedNote() || '');
  const tagsDirty = _cuDraftTags().join(',') !== _cuSavedTags().join(',');
  foot.hidden = !(noteDirty || tagsDirty);
}

function cuNotesReset() {
  CU_TAG_DRAFT = null;
  const ta = document.getElementById('cu-note');
  if (ta) ta.value = _cuSavedNote();
  cuNotesRepaint();
}

async function cuNotesSave(btn) {
  const d = CU_CURRENT; if (!d || !d.customer) return;
  const ta = document.getElementById('cu-note');
  const note = ta ? String(ta.value || '') : '';
  const tags = _cuDraftTags();
  // adminWrite THROWS on a failed write (it has already toasted the reason), so
  // the catch is what stops an unhandled rejection — and, more to the point,
  // what stops the lines below recording an edit that never landed.
  let j;
  try {
    j = await adminWrite({
      btn,
      url: '/api/retail-admin/customers/' + d.customer.id,
      method: 'PATCH',
      body: { note, tags },
      errLabelEn: 'Could not save the note', errLabelCn: '备注保存失败',
      busyLabel: cuT('Saving…', '保存中…'),
    });
  } catch (e) { return; }
  // The saved state IS what came back, so a later Reset goes to the truth
  // rather than to what this page hoped it wrote.
  d.customer.note = (j.changed && 'note' in j.changed) ? j.changed.note : (note.trim() || null);
  d.customer.tags = (j.changed && 'tags' in j.changed) ? j.changed.tags : (tags.length ? tags.join(',') : null);
  CU_TAG_DRAFT = null;
  cuNotesRepaint();
  toast(cuT('Saved', '已保存'));
  // The roster row shows the tags, and the tag filter is built from what is in
  // use — both are now behind by one edit.
  cuLoad({ silent: true });
}

function cuRenderDetail() {
  const d = CU_CURRENT;
  const c = d.customer;
  const s = d.stats;

  // Defensive guards — the server could omit a key for newly-onboarded
  // customers with no orders/points/topup history. Coerce everything to
  // safe defaults so the template never throws on a missing nested field.
  const ord = (s.orders   || {});
  const pts = (s.points   || {});
  const top = (s.topup    || {});
  const vch = (s.vouchers || {});
  const rev = (s.reviews  || {});
  const sessions = Number(s.active_sessions) || 0;
  // Money, plain text: comma-grouped, and a trailing .00 dropped because a
  // whole amount doesn't need two zeros to prove it's money — real decimals
  // still show. "¥1,690.68", "¥1,430", never "¥1690.68" or "¥1430.00".
  const yuan = v => {
    const n = Number(v || 0);
    const whole = Math.round(n * 100) % 100 === 0;
    return acWrap(n.toLocaleString('en-US', whole
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  };
  // Money WITHOUT the symbol, for attribute values (the chart tooltip prints
  // its own). Same .00-dropping, comma-grouping rule as yuan().
  //
  // Formats the number directly rather than slicing the symbol back off what
  // yuan() just added: .slice(1) assumed a one-character symbol in front, so a
  // tenant on 'CHF' or on a symbol-after currency had a digit eaten instead.
  const yuanBare = v => {
    const n = Number(v || 0);
    const whole = Math.round(n * 100) % 100 === 0;
    return n.toLocaleString('en-US', whole
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Drawer action bar — two everyday buttons (Message, Edit profile). The
  // rare/deliberate actions (Sign out all devices, Block) fold into a More ▾
  // menu so the header stays calm; Block sits last, brick, behind a divider.
  // Unblock renders neutral since it isn't destructive.
  const blockItem = c.is_blocked
    ? `<button class="cux-mi" onclick="cuMoreClose(); cuToggleBlock(event)">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/></svg>
         Unblock · 解封</button>`
    : `<button class="cux-mi danger" onclick="cuMoreClose(); cuToggleBlock(event)">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>
         Block customer · 封禁顾客</button>`;
  // Plain-text buttons, no icons, and NO spacer before More — Message, Edit
  // profile and More sit together immediately after one another; the only thing
  // on the right is the floating ✕.
  $('#cu-drawer-actions').innerHTML = `
    <button class="btn" onclick="cuMessageCustomer()">Message · 发消息</button>
    <button class="btn" onclick="cuOpenEdit()">Edit profile · 编辑资料</button>
    <div class="cux-more-wrap">
      <button class="btn" onclick="cuMoreToggle()" aria-haspopup="true">More · 更多
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div id="cux-more-menu" class="cux-menu" hidden>
        <button class="cux-mi" onclick="cuMoreClose(); cuForceLogout(event)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>
          Sign out all devices · 退出所有设备
          <span class="hint" data-no-i18n>${sessions || ''}</span></button>
        <div class="cux-sep"></div>
        ${blockItem}
      </div>
    </div>
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
  const maxRevenue = Math.max(1, ...months.map(m => m.revenue));
  const barMax = 78;   // fixed quiet height — the summary line carries the headline
  const monthBars = months.map(m => `
    <div class="cu-bar-col" data-m="${m.key}" data-n="${m.n}" data-rev="${escapeAttr(yuanBare(m.revenue))}" onmousemove="cuBarTip(event)" onmouseleave="cuBarTipHide()">
      <div class="cu-bar ${m.revenue === 0 ? 'empty' : (m.revenue === maxRevenue ? 'peak' : '')}" style="height: ${m.revenue === 0 ? 3 : Math.max(8, (m.revenue / maxRevenue) * barMax)}px;"></div>
      <div class="cu-bar-label">${m.key.slice(5)}</div>
    </div>
  `).join('');

  // SKU rides on a SECOND LINE under the product name rather than taking its
  // own column — at the drawer's real width a fourth column forces the name to
  // wrap, and the name must never wrap. An absent SKU renders nothing at all
  // (Eleme lines genuinely have none) — never a dash.
  const topItemsRows = d.top_items.length
    ? d.top_items.map(t => `
        <tr>
          <td><span class="ti-name" data-no-i18n>${escapeHtml(t.name_en || t.name_cn || '')}</span>${
            t.sku ? `<span class="ti-sku" data-no-i18n>${escapeHtml(t.sku)}</span>` : ''}</td>
          <td class="numeric" data-no-i18n>×${cuNum(t.qty)}</td>
          <td class="numeric" data-no-i18n>${yuan(t.spend)}</td>
        </tr>`).join('')
    : '<tr><td colspan="3" class="muted">No completed orders yet. · 暂无已完成订单。</td></tr>';

  const recentOrdersRows = d.recent_orders.length
    ? d.recent_orders.map(o => `
        <tr class="cu-order-row" tabindex="0" onclick="cuGotoOrder(${o.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();cuGotoOrder(${o.id});}">
          <td data-no-i18n>${escapeHtml(o.order_no)}</td>
          <td><span class="cu-pill">${escapeHtml(cuStatusLabel(o))}</span></td>
          <td class="numeric" data-no-i18n>${yuan(o.total)}</td>
          <td class="muted" data-no-i18n>${escapeHtml(courierAgo(o.created_at))}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No orders yet · 暂无订单</td></tr>';
  // The fold shows only the last 10 (backend LIMIT). When the customer has more,
  // offer a jump to the Orders tab scoped to them — N is their full order count.
  const recentOrdersTotal = Number((d.stats && d.stats.orders && d.stats.orders.orders_count) || 0);
  const recentOrdersViewAll = (recentOrdersTotal > d.recent_orders.length)
    ? `<div class="cux-viewall"><button type="button" class="cux-viewall-btn" onclick="ordViewCustomerOrders(${d.customer.id})">${cuT(`View all ${recentOrdersTotal} orders`, `查看全部 ${recentOrdersTotal} 笔订单`)} →</button></div>`
    : '';

  const recentPtsRows = d.recent_points.length
    ? d.recent_points.map(p => `
        <tr>
          <td><span class="cu-pill">${escapeHtml(cuPtsSource(p.source))}</span></td>
          <td class="numeric" data-no-i18n style="color: ${p.delta >= 0 ? 'var(--accent)' : 'var(--danger)'}; font-weight: 600;">${p.delta >= 0 ? '+' : ''}${cuNum(p.delta)}</td>
          <td class="numeric" data-no-i18n>${cuNum(p.balance_after)}</td>
          <td class="muted">${escapeHtml(p.note || '')}</td>
          <td class="muted" data-no-i18n>${escapeHtml(courierAgo(p.created_at))}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No points activity · 暂无积分变动</td></tr>';

  const recentTopupsRows = d.recent_topups.length
    ? d.recent_topups.map(t => `
        <tr>
          <td>${CU_NON_PAYMENT_METHODS.has(String(t.payment_method || ''))
            ? `<span class="cu-pill">${escapeHtml(cuPtsSource(t.payment_method))}</span>`
            : paymentBrandHTML(t.payment_method)}</td>
          <td class="numeric" data-no-i18n>${yuan(t.amount)}</td>
          <td class="numeric" data-no-i18n>+${cuNum(t.bonus_points || 0)} pts</td>
          <td><span class="cu-pill">${escapeHtml(cuCap(t.status))}</span></td>
          <td class="muted" data-no-i18n>${escapeHtml(courierAgo(t.created_at))}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No top-up activity · 暂无充值记录</td></tr>';

  const addressesHtml = d.addresses.length
    ? d.addresses.map(a => {
        const full = [a.province, a.city, a.district, a.address, a.detail].filter(Boolean).join(' ');
        // A ROW inside the Addresses card, separated by a hairline — not a
        // nested card. Recipient name and phone are free text, so both carry
        // data-no-i18n against the walker's " · " split.
        //
        // ⚠ RECIPIENT-FIRST IS DELIBERATE. The mockup leads each row with an
        // address LABEL ("Home", "Office") — that is invented demo data.
        // retail_customer_addresses has no label column (recipient_name, phone,
        // province, city, district, address, detail, postal_code, is_default,
        // lat, lng…), and deriving one from `district` would be inventing a
        // name the customer never chose. A real address label is a feature with
        // a schema change and an input in the address modal, not a drawer fix.
        // Considered 2026-07-26 and deliberately not added — its absence is a
        // decision, not an oversight.
        return `
        <div class="cux-addr">
          <div class="top">
            <span class="nm" data-no-i18n>${escapeHtml(a.recipient_name || '')}</span>
            <span class="ph" data-no-i18n>${escapeHtml(a.phone || '')}</span>
            ${a.is_default ? '<span class="def">Default · 默认</span>' : ''}
            <span class="acts">
              <button onclick="cuOpenAddrModal(${a.id})">Edit · 编辑</button>
              <button class="del" onclick="cuDeleteAddr(${a.id}, event)">Delete · 删除</button>
            </span>
          </div>
          <div class="line2" data-no-i18n title="${escapeAttr(full)}">${escapeHtml(full)}</div>
        </div>`;
      }).join('')
    : '<div class="muted" style="font-size: 12.5px;">No saved addresses. · 暂无收货地址。</div>';

  // No photo → the monogram, which takes the first real LETTER (Latin or CJK)
  // and skips emoji, quotes and symbols; no letter anywhere → the person icon.
  // Same rule as the roster's avatar, via the shared cuMonogram().
  const avatar = c.avatar_url
    ? `<img src="${escapeHtml(c.avatar_url)}" class="cu-avatar" onerror="this.style.display='none'">`
    : `<div class="cu-avatar" data-no-i18n>${cuMonogram(c.nickname)}</div>`;

  // ── Snapshot sub-lines — one quiet line per figure. Zero rows simply
  // don't appear (the old tiles rendered four lines of ¥0.00 for a new
  // customer); non-zero extras (refunded, expired, admin adjust…) join the
  // line only when they exist. Composed via cuT (one live language) and
  // marked data-no-i18n in the template — the " · " here is a real data
  // separator, not an EN·CN divider for the walker.
  const ordersN = ord.orders_count || 0;
  let ordSub;
  if (!ordersN) ordSub = escapeHtml(cuT('no orders yet', '暂无订单'));
  else {
    // ONE money measure, and it is called "ordered" — the figure sums order
    // SUBTOTAL (build 1 aligned it with the list's Ordered ¥ column). Never
    // "lifetime", "paid", "cash", "collected" or "spent": each of those names
    // a different measure, and this page shows only one.
    const en = [`${yuan(ord.revenue)} ordered`];
    const cn = [`已下单 ${yuan(ord.revenue)}`];
    // AOV is the same number as the order on a one-order customer — printing
    // both invites the reader to compare two identical figures for meaning.
    if (ordersN > 1) { en.push(`AOV ${yuan(ord.aov)}`); cn.push(`客单价 ${yuan(ord.aov)}`); }
    if ((ord.refunded_count || 0) > 0)  { en.push(`${ord.refunded_count} refunded`);  cn.push(`退款 ${ord.refunded_count}`); }
    if ((ord.cancelled_count || 0) > 0) { en.push(`${ord.cancelled_count} cancelled`); cn.push(`取消 ${ord.cancelled_count}`); }
    ordSub = escapeHtml(cuT(en.join(' · '), cn.join(' · ')));
  }

  const ptsBal = c.points_balance || 0;
  let ptsSub;
  {
    const en = [`${pts.earned || 0} earned`];
    const cn = [`累计获得 ${pts.earned || 0}`];
    if ((pts.redeemed || 0) > 0) { en.push(`${pts.redeemed} redeemed`); cn.push(`已兑换 ${pts.redeemed}`); }
    if ((pts.expired || 0) > 0)  { en.push(`${pts.expired} expired`);   cn.push(`已过期 ${pts.expired}`); }
    if (Number(pts.admin_adjust || 0) !== 0) {
      const v = (pts.admin_adjust > 0 ? '+' : '') + pts.admin_adjust;
      en.push(`admin ${v}`); cn.push(`后台调整 ${v}`);
    }
    ptsSub = escapeHtml(cuT(en.join(' · '), cn.join(' · ')))
      + ((pts.expiring_30d || 0) > 0
        // "all 6" vs "6": the code already knows the difference — the clamp
        // computes both numbers side by side — it just used to print them the
        // same way, so a customer about to lose their WHOLE balance read
        // identically to one losing 2 of 60. Still a count, never a date.
        ? ` · <span class="warn">${escapeHtml(
            Number(pts.expiring_30d) >= ptsBal && ptsBal > 0
              ? cuT('all ' + cuNum(pts.expiring_30d) + ' expiring soon', '全部 ' + cuNum(pts.expiring_30d) + ' 分即将过期')
              : cuNum(pts.expiring_30d) + ' ' + cuT('expiring soon', '分即将过期'))}</span>`
        : ` · ${escapeHtml(cuT('none expiring soon', '暂无临期'))}`);
  }

  const walletBal = Number(c.balance || 0);
  const topTotal  = Number(top.topup_total || 0);
  const topAdj    = Number(top.admin_adjust_total || 0);
  const vUnused = vch.unused || 0, vUsed = vch.used || 0;
  let walSub;
  if (!topTotal && !topAdj && !vUnused && !vUsed) {
    walSub = escapeHtml(cuT('never topped up', '从未充值'));
  } else {
    const en = [], cn = [];
    if (topTotal) { en.push(`${yuan(topTotal)} topped up`); cn.push(`累计充值 ${yuan(topTotal)}`); }
    if ((top.bonus_pts_total || 0) > 0) { en.push(`+${top.bonus_pts_total} bonus pts`); cn.push(`赠送积分 ${top.bonus_pts_total}`); }
    if (topAdj) { en.push(`admin ${yuan(topAdj)}`); cn.push(`后台调整 ${yuan(topAdj)}`); }
    // Spelled out rather than "N/N vouchers" — the bare pair read as a ratio,
    // and it says nothing on a standing coupon, which is never marked used no
    // matter how many orders it has come off.
    if (vUnused) { en.push(`${vUnused} coupon${vUnused === 1 ? '' : 's'} to use`); cn.push(`${vUnused} 张优惠券可用`); }
    if (vUsed)   { en.push(`${vUsed} used`); cn.push(`${vUsed} 张已使用`); }
    walSub = escapeHtml(cuT(en.join(' · '), cn.join(' · ')));
  }

  // Facts-card values.
  // 🔴 NO DASHES AS VALUES, anywhere in these cards. A dash is not an answer —
  // it makes the reader guess whether the figure is zero, missing, or broken.
  // Each absence says what it actually is, in the shape of the thing missing.
  // Last order names the ORDER, not the elapsed time: "#R26071234 · delivered"
  // tells the operator what happened, where "today" only told them when. The
  // newest row of recent_orders IS that order (the query is ORDER BY id DESC).
  // No orders → say so; never a dash.
  const lastOrd = (d.recent_orders && d.recent_orders[0]) || null;
  const lastOrderV = lastOrd
    ? '#' + (lastOrd.order_no || lastOrd.id) + ' · ' + cuStatusLabel(lastOrd)
    : cuT('no orders yet', '暂无订单');
  const buildV = (d.diagnostics && d.diagnostics.device_last_seen) || null;
  // "not recorded", not "—": the app build is absent because this customer has
  // no client log, which is a fact about our records rather than about them.
  const buildText = (buildV && buildV.app_version)
    ? buildV.app_version + (buildV.device_model ? ' · ' + buildV.device_model : '')
    : cuT('not recorded', '未记录');
  const openid = c.openid || '';
  const openidShort = openid
    ? (openid.length > 18 ? openid.slice(0, 8) + '…' + openid.slice(-6) : openid)
    : cuT('none on file', '无');

  // Chart headline — for sparse customers the sentence reads faster than the bars.
  const yr    = months.reduce((a, m) => a + m.n, 0);
  const yrRev = months.reduce((a, m) => a + Number(m.revenue || 0), 0);
  const chartSummary = escapeHtml(cuT(
    `${yr} ${yr === 1 ? 'order' : 'orders'} · ${yuan(yrRev)} in 12 months`,
    `近 12 个月 ${yr} 单 · ${yuan(yrRev)}`));

  // Fold hints — say what's inside before it's opened.
  const diagErrs   = (d.diagnostics && d.diagnostics.error_count_7d) || 0;
  const diagUnavail = !!(d.diagnostics && d.diagnostics.unavailable);
  const affTotal = Number((d.affiliate && d.affiliate.summary && d.affiliate.summary.total) || 0);
  const noneHint = escapeHtml(cuT('none', '无'));
  const chevron = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  const noteHtml = CU_PENDING_NOTE
    ? `<div class="cux-note" id="cu-drawer-note"><span>${escapeHtml(CU_PENDING_NOTE)}</span>`
      + `<button type="button" class="nx" onclick="cuDismissNote()" title="${escapeHtml(cuT('Dismiss', '关闭'))}" aria-label="${escapeHtml(cuT('Dismiss', '关闭'))}">&#10005;</button></div>`
    : '';
  CU_PENDING_NOTE = null;   // one-shot: consumed by this render

  $('#cu-detail-body').innerHTML = `
    ${noteHtml}
    <div class="cux-head">
      ${avatar}
      <div style="flex: 1; min-width: 0;">
        <div class="cux-eyebrow" data-no-i18n>${escapeHtml(cuT(
          'Customer #' + c.id + (cuFmtDate(c.created_at) ? ' · joined ' + cuFmtDate(c.created_at) : ''),
          '顾客 #' + c.id + (cuFmtDate(c.created_at) ? ' · ' + cuFmtDate(c.created_at) + ' 加入' : '')))}</div>
        <!-- data-no-i18n: a nickname is free text and can contain " · ",
             which the walker reads as an EN/CN pair and splits. The pills
             beside it are wrapped in one span so they travel TOGETHER — if
             both don't fit next to the name they wrap as a pair, never one up
             and one down. -->
        <div class="cux-name" data-no-i18n>
          <span class="hn-name">${c.nickname ? escapeHtml(c.nickname) : `<span class="none">${escapeHtml(cuT('No name', '未填姓名'))}</span>`}</span>
          <span class="hn-pills">
            <span class="cu-pill tier-${escapeHtml(c.tier_key || 'seed')}">${escapeHtml(cuCap(c.tier_key || 'seed'))}</span>
            ${c.is_blocked ? `<span class="cu-pill blocked">${escapeHtml(cuT('Blocked', '已封禁'))}</span>` : ''}
          </span>
        </div>
        ${(c.phone || c.email) ? `<div class="cux-phone" data-no-i18n>
          ${c.phone ? `${escapeHtml(c.phone)}<button class="cux-copy" onclick="cuCopyChip(this, '${escapeAttr(c.phone)}')">${escapeHtml(cuT('Copy', '复制'))}</button>` : ''}
          ${c.email ? `<span${c.phone ? ' class="muted"' : ''}>${escapeHtml(c.email)}</span>` : ''}
        </div>` : ''}
      </div>
    </div>

    <!-- Snapshot band — Orders · Points · Wallet, one figure + one quiet line each. -->
    <div class="cux-snap">
      <div>
        <div class="lbl">Orders · 订单</div>
        <div class="fig${ordersN ? '' : ' zero'}" data-no-i18n>${ordersN}</div>
        <div class="sub" data-no-i18n>${ordSub}</div>
      </div>
      <div>
        <div class="lbl">Points · 积分
          <button class="cux-adj" onclick="cuOpenAdjust('points')">Adjust · 调整</button></div>
        <div class="fig${ptsBal ? '' : ' zero'}" data-no-i18n>${ptsBal}</div>
        <div class="sub" data-no-i18n>${ptsSub}</div>
      </div>
      <div>
        <div class="lbl">Wallet · 钱包
          <button class="cux-adj" onclick="cuOpenAdjust('wallet')">Adjust · 调整</button></div>
        <div class="fig${walletBal ? '' : ' zero'}" data-no-i18n>${yuan(walletBal)}</div>
        <div class="sub" data-no-i18n>${walSub}</div>
      </div>
    </div>

    <!-- Facts cards — what used to be the pill wall + tile zero-rows. -->
    <div class="cux-cards">
      <div class="cux-card">
        <div class="cux-kicker">Activity · 动态</div>
        <div class="cux-frow"><div class="k">Last order · 最近订单</div><div class="v${lastOrd ? '' : ' none'}" data-no-i18n>${escapeHtml(lastOrderV)}</div></div>
        <!-- Relative, via the same cuFmtSeen the roster's Last seen column uses,
             so "3d ago" means the same thing on both surfaces. -->
        <div class="cux-frow"><div class="k">Last login · 最近登录</div><div class="v quiet" data-no-i18n>${escapeHtml(c.last_login_at ? courierAgo(c.last_login_at) : cuT('never', '从未'))}</div></div>
        <!-- Bare "46 / 48": the two numbers ARE the sentence. -->
        <div class="cux-frow"><div class="k">Completed · 已完成</div><div class="v" data-no-i18n>${cuNum(ord.completed_count || 0)} / ${cuNum(ordersN)}</div></div>
        ${(rev.count || 0) > 0 ? `<div class="cux-frow"><div class="k">Reviews · 评价</div><div class="v" data-no-i18n>${rev.count}${rev.avg_rating ? ' <span class="muted">· ' + Number(rev.avg_rating).toFixed(1) + '★</span>' : ''}</div></div>` : ''}
      </div>
      <div class="cux-card">
        <div class="cux-kicker">Device &amp; account · 设备与账号</div>
        <div class="cux-frow"><div class="k">App build · 版本</div><div class="v${(buildV && buildV.app_version) ? ' quiet' : ' none'}" data-no-i18n>${escapeHtml(buildText)}</div></div>
        <!-- Number in Ink, "active" in Graphite — the same treatment every
             other value in this card gets. It used to turn AMBER at 5+
             sessions, but Amber is the attention colour and a session count
             is a FACT, not a warning: someone with eight devices signed in
             has not done anything wrong, and colouring it asks the operator
             to act on nothing. Points-expiring is the only legitimate Amber
             in this drawer. -->
        <div class="cux-frow"><div class="k">Sessions · 会话</div><div class="v" data-no-i18n>${cuNum(sessions)} <span class="muted">${escapeHtml(cuT('active', '个活跃'))}</span></div></div>
        <div class="cux-frow"><div class="k">openid</div><div class="v mono${openid ? '' : ' none'}" data-no-i18n>${escapeHtml(openidShort)}${openid ? `<button class="cux-copy" onclick="cuCopyChip(this, '${escapeAttr(openid)}')">${escapeHtml(cuT('Copy', '复制'))}</button>` : ''}</div></div>
      </div>
    </div>

    <!-- Notes & tags — the first thing an operator wants when they open a
         person, so it sits above the numbers (audit E-02). Read-write in place;
         Save appears only once something has actually changed. -->
    ${cuNotesCardHtml(c)}

    <!-- Orders by month — a card like the others: title left, summary right,
         on the SAME line. Below three orders the bars are HIDDEN and the card
         keeps its title and summary: eleven empty stubs and one bar is not a
         chart, it's a chart-shaped apology. The card itself stays so the
         drawer's shape doesn't change between customers.
         Month labels are NUMERIC (08 09 10 …) — single letters give two "A"s
         and two "M"s in one row. -->
    <div class="cux-card cux-chart">
      <div class="cux-kicker">Orders by month · 月度订单
        <span class="side" data-no-i18n>${chartSummary}</span>
      </div>
      ${ordersN >= 3 ? `<div class="cu-bar-host" style="position: relative;">
        <div class="cu-bar-row">${monthBars}</div>
        <!-- tooltip is a body-level singleton (cuBarTip) so the drawer can't crop it -->
      </div>` : ''}
    </div>

    <!-- Two white cards side by side. Each takes its NATURAL height and
         top-aligns — neither stretches to match the other, so an uneven bottom
         edge is correct, not a bug. They stack full-width when they can't sit
         side by side; the panel never scrolls sideways. -->
    <div class="cu-detail-pairs">
      <div class="cux-card">
        <div class="cux-kicker">Top items · 热销商品</div>
        <table class="cux-titbl">
          <thead><tr><th>Item · 商品</th><th class="numeric">Qty · 数量</th><th class="numeric">Spend · 消费</th></tr></thead>
          <tbody>${topItemsRows}</tbody>
        </table>
      </div>
      <div class="cux-card">
        <div class="cux-kicker">Addresses · 地址
          <span class="side"><button class="btn btn-sm cux-ghost" onclick="cuOpenAddrModal(null)">+ Add · 添加</button></span>
        </div>
        ${addressesHtml}
      </div>
    </div>

    <!-- Ledger folds — flat rows with a hint of what's inside. Recent orders
         first (most used); Diagnostics further down but still auto-opens when
         the customer's app reported errors. -->
    <div class="cux-folds">
      <details class="cux-fold">
        <!-- The summary states the customer's TRUE order count, not how many
             rows this fold happens to hold. recent_orders is LIMIT 10, so a
             48-order customer used to read "10" here — a number that looked
             like an answer and wasn't. stats.orders.orders_count is already
             on the payload; the list below is still the last 10, and the
             "View all N" link at its foot says so. -->
        <summary>${chevron}<span class="t">Recent orders · 近期订单</span>
          <span class="hint" data-no-i18n>${ordersN
            ? escapeHtml(cuT(cuNum(ordersN) + (ordersN === 1 ? ' order' : ' orders'), cuNum(ordersN) + ' 单'))
            : noneHint}</span></summary>
        <div class="cux-fold-body">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Order # · 订单号</th><th>Status · 状态</th><th class="numeric">Total · 总额</th><th>When · 时间</th></tr></thead>
              <tbody>${recentOrdersRows}</tbody>
            </table>
          </div>
          ${recentOrdersViewAll}
        </div>
      </details>

      <details class="cux-fold">
        <!-- Was recent_points.length — capped at 20 by the query and labelled
             "earned", so it was neither the row count nor the earned total.
             stats.points.earned is the real lifetime figure and is already on
             the payload. -->
        <summary>${chevron}<span class="t">Points ledger · 积分明细</span>
          <span class="hint" data-no-i18n>${(pts.earned || 0)
            ? escapeHtml(cuT(cuNum(pts.earned) + ' earned', '累计获得 ' + cuNum(pts.earned)))
            : escapeHtml(cuT('no activity', '暂无变动'))}</span></summary>
        <div class="cux-fold-body">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Source · 来源</th><th class="numeric">Δ · 变动</th><th class="numeric">After · 之后</th><th>Note · 备注</th><th>When · 时间</th></tr></thead>
              <tbody>${recentPtsRows}</tbody>
            </table>
          </div>
        </div>
      </details>

      <details class="cux-fold">
        <summary>${chevron}<span class="t">Top-ups · 充值明细</span>
          <span class="hint" data-no-i18n>${d.recent_topups.length || noneHint}</span></summary>
        <div class="cux-fold-body">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Method · 方式</th><th class="numeric">Amount · 金额</th><th class="numeric">Bonus · 赠送</th><th>Status · 状态</th><th>When · 时间</th></tr></thead>
              <tbody>${recentTopupsRows}</tbody>
            </table>
          </div>
        </div>
      </details>

      <!-- Three states, not two. "no errors in 7 days" is an ALL-CLEAR and is
           only earned when the query actually ran and returned zero. When the
           read failed (diagnostics.unavailable) the summary says so plainly —
           a failure that reads as good news is worse than no news. -->
      <details class="cux-fold"${diagErrs > 0 ? ' open' : ''}>
        <summary>${chevron}<span class="t">Diagnostics · 诊断</span>
          <span class="hint${diagUnavail ? ' warn' : (diagErrs > 0 ? ' warn' : ' ok')}" data-no-i18n>${
            diagUnavail ? escapeHtml(cuT("couldn't be read", '无法读取'))
            : diagErrs > 0 ? escapeHtml(cuT(diagErrs + ' errors in 7 days', '近 7 天报错 ' + diagErrs))
            : escapeHtml(cuT('no errors in 7 days', '近 7 天无报错'))}</span></summary>
        <div class="cux-fold-body">${diagUnavail
          ? `<div class="muted">${escapeHtml(cuT("Diagnostics couldn't be read for this customer. This is not an all-clear — the check itself failed.", '无法读取该顾客的诊断数据。这不代表一切正常 — 是检查本身失败了。'))}</div>`
          : renderDiagnosticsBlock(d.diagnostics)}</div>
      </details>

      <details class="cux-fold">
        <summary>${chevron}<span class="t">Affiliate · 推广</span>
          <span class="hint" data-no-i18n>${affTotal ? escapeHtml(cuT(affTotal + ' invites', '邀请 ' + affTotal)) : escapeHtml(cuT('no invites', '暂无邀请'))}</span></summary>
        <div class="cux-fold-body">${renderAffiliateBlock(d.affiliate)}</div>
      </details>
    </div>
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
  // Referrer and invitee nicknames are free text — shield them from the
  // walker's " · " split. The bilingual labels around them are NOT shielded.
  const referredBy = aff.referred_by
    ? `<a href="#" data-no-i18n onclick="event.preventDefault(); cuOpenDetail(${aff.referred_by.id})">${escapeHtml(aff.referred_by.nickname || cuT('No name', '未填姓名'))}</a>
       ${aff.referred_by.referral_code ? `<span class="muted" style="margin-left: 8px; font-size: 11px;">via <code>${escapeHtml(aff.referred_by.referral_code)}</code></span>` : ''}`
    : '<span class="muted">— none — · 无</span>';

  const sum = aff.summary || {};
  const invRows = (aff.invites || []).length
    ? aff.invites.map(i => `
        <tr>
          <td><a href="#" data-no-i18n onclick="event.preventDefault(); cuOpenDetail(${i.invitee_id})">${escapeHtml(i.invitee_nickname || cuT('No name', '未填姓名'))}</a><div class="muted" data-no-i18n style="font-size: 11px;">${escapeHtml(i.invitee_phone || '')}</div></td>
          <td>${afStatusPill(i.status)}</td>
          <td class="numeric">${acMoney(i.reward_amount || 0)}</td>
          <td>${escapeHtml(cuFmtDate(i.joined_at) || '')}</td>
          <td>${i.first_paid_order_id ? '#' + i.first_paid_order_id : ''}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No invites yet. · 暂无邀请记录。</td></tr>';

  return `
    <h3>Affiliate · 推广 <span class="muted" style="font-weight: 400; font-size: 12px;">· edit in the Affiliate tab · 在推广标签页编辑</span></h3>
    <div class="row" style="gap: 24px; flex-wrap: wrap; margin-bottom: 12px;">
      <div class="field" style="margin: 0;">
        <label class="stacked">Their code · 本人邀请码</label>
        <div style="font-size: 16px;">${codeHtml}${aff.affiliate_blocked ? ` <span class="cu-pill blocked" data-no-i18n>${escapeHtml(cuT('Disabled', '已停用'))}</span>` : ''}
          <button class="btn btn-sm" style="margin-left: 8px;" onclick="afReissueCode(${CU_CURRENT.customer.id}, event)">Reissue · 重发</button>
        </div>
      </div>
      <div class="field" style="margin: 0;">
        <label class="stacked">Referred by · 推荐人</label>
        <div style="font-size: 13px; padding: 6px 0;">${referredBy}</div>
      </div>
      <div class="field" style="margin: 0;">
        <label class="stacked">Conversions · 转化数</label>
        <div style="font-size: 13px; padding: 6px 0;">${Number(sum.converted || 0)} / ${Number(sum.total || 0)} <span class="muted">· ${acMoney(sum.earned || 0)} earned · 已赚</span></div>
      </div>
      ${renderAffiliateBlockToggle(aff)}
      ${renderLifetimeEligibility(aff)}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Invitee · 受邀人</th><th>Status · 状态</th><th class="numeric">Reward ${acCurrencySymbol()} · 奖励</th><th>Joined · 加入时间</th><th>First order · 首单</th></tr></thead>
        <tbody>${invRows}</tbody>
      </table>
    </div>
  `;
}

// Per-customer affiliate opt-out — stop THIS customer acting as a referrer
// without touching their account (that's the header's Block/Unblock, above)
// or the shop-wide program toggle (Affiliate tab → Settings). Always shown,
// unlike renderLifetimeEligibility below: it applies in every lifetimeMode,
// and it's the one-time bounty too, not just the ongoing share.
function renderAffiliateBlockToggle(aff) {
  const on = !!aff.affiliate_blocked;   // "on" = referring is disabled
  return `
      <div class="field" style="margin: 0;">
        <label class="stacked">${cuT('Referring', '推荐资格')}</label>
        <div style="font-size: 13px; padding: 6px 0;">
          <button class="btn btn-sm" onclick="cuSetAffiliateBlocked(${CU_CURRENT.customer.id}, ${on ? 'false' : 'true'}, event)">${
            on ? cuT('Let them refer again', '恢复推荐资格')
               : cuT('Stop them referring', '停止推荐资格')}</button>
          <div class="muted" style="font-size: 11px; margin-top: 4px; max-width: 44ch;">${
            on ? cuT('Their code is disabled — new friends cannot apply it, and no further referral or share reward reaches them.',
                     '其邀请码已停用 — 好友无法使用，本人也不再获得新的推荐奖励或复购分成。')
               : cuT('Their code works normally.', '其邀请码正常可用。')}</div>
        </div>
      </div>`;
}

// Mirrors cuSetLifetimeEligible below: same endpoint pair shape as the
// header's Block/Unblock (POST .../affiliate-block, .../affiliate-unblock),
// same confirm-only-when-disabling posture as the ongoing-share toggle.
async function cuSetAffiliateBlocked(customerId, blocked, ev) {
  const btn = ev && ev.currentTarget;
  if (blocked && !(await askConfirm({
    title: cuT('Stop this customer referring friends?', '停止该客户的推荐资格？'),
    body: cuT('Their referral code stops working for new friends, and they stop earning new referral or share rewards. Anything already paid into their wallet stays; the account itself is untouched.',
              '其邀请码将无法被新好友使用，本人也不再获得新的推荐奖励或复购分成。已发放至钱包的奖励不受影响，账号本身不受影响。'),
    confirmLabel: cuT('Stop them referring', '停止推荐资格'),
  }))) return;
  if (btn) btn.disabled = true;
  try {
    await api(`/api/retail-admin/customers/${customerId}/affiliate-${blocked ? 'block' : 'unblock'}`, { method: 'POST' });
    toast(blocked ? cuT('Referring disabled', '已停止推荐资格') : cuT('Referring re-enabled', '已恢复推荐资格'));
    if (CU_CURRENT?.customer?.id === customerId) cuOpenDetail(customerId);
  } catch (e) {
    toast(cuT('Could not change this: ' + e.message, '修改失败：' + e.message), 'err');
    if (btn) btn.disabled = false;
  }
}

// Ongoing repeat-order share — is this customer one of the chosen few?
//
// Shown ONLY while the shop is in 'selected' mode. In 'everyone' mode this
// customer already earns the ongoing share and a per-person switch would be a
// control that changes nothing — the kind of setting that saves nowhere and
// teaches the operator a rule that is not real.
//
// Strings go through cuT(en, cn) rather than the block's older glued
// "EN · CN" literals: cuT resolves to ONE language at render time, where a
// glued literal relies on the i18n walker splitting it afterwards. cuT is
// already this block's own helper (see the No name fallback below).
function renderLifetimeEligibility(aff) {
  if (!aff || aff.lifetime_mode !== 'selected') return '';
  const on = !!aff.lifetime_eligible;
  const since = aff.lifetime_eligible_since ? escapeHtml(cuFmtDate(aff.lifetime_eligible_since)) : '';
  // The date is only the truth about what they earn while the flag is ON. Once
  // cleared it is history — when they were last chosen — and labelling it
  // "earning since" would claim they still are.
  const sub = on
    ? (since ? cuT(`Earning on friends’ orders paid since ${since}.`, `自 ${since} 起，可从好友已付款订单中获得分成。`)
             : cuT('Earning on friends’ later orders.', '可从好友之后的订单中获得分成。'))
    : (since ? cuT(`Not earning the ongoing share. Last chosen ${since}.`, `当前不获得复购分成。上次选定于 ${since}。`)
             : cuT('Not earning the ongoing share.', '当前不获得复购分成。'));
  return `
      <div class="field" style="margin: 0;">
        <label class="stacked">${cuT('Ongoing share', '复购分成')}</label>
        <div style="font-size: 13px; padding: 6px 0;">
          <button class="btn btn-sm" onclick="cuSetLifetimeEligible(${CU_CURRENT.customer.id}, ${on ? 'false' : 'true'}, event)">${
            on ? cuT('Stop the ongoing share', '停止复购分成')
               : cuT('Let them earn the ongoing share', '允许获得复购分成')}</button>
          <div class="muted" style="font-size: 11px; margin-top: 4px; max-width: 44ch;">${sub}</div>
        </div>
      </div>`;
}

// Pick / un-pick from the customer's own record. Same endpoint the Affiliate
// tab's manage dialog writes, so the two can never disagree about who is in.
async function cuSetLifetimeEligible(customerId, eligible, ev) {
  const btn = ev && ev.currentTarget;
  // cuT, not the titleEn/titleCn pair: askConfirm's pick() GLUES those into
  // "EN · CN" and leans on the walker to split them again. One language in,
  // one language out — same call shape afReissueCode's confirmLabel already uses.
  if (!eligible && !(await askConfirm({
    title: cuT('Stop this customer earning the ongoing share?', '停止该客户的复购分成？'),
    body: cuT('They keep the one-time referral reward and everything already paid into their wallet. Only future orders stop earning.',
              '已发放至钱包的分成和一次性推荐奖励均予保留，仅之后的订单不再产生分成。'),
    confirmLabel: cuT('Stop the ongoing share', '停止复购分成'),
  }))) return;
  if (btn) btn.disabled = true;
  try {
    await api('/api/retail-admin/affiliate/eligible', { method: 'POST', body: { customerId, eligible } });
    toast(eligible ? cuT('Now earning the ongoing share', '已开启复购分成')
                   : cuT('No longer earning the ongoing share', '已停止复购分成'));
    if (CU_CURRENT?.customer?.id === customerId) cuOpenDetail(customerId);
  } catch (e) {
    toast(cuT('Could not change this: ' + e.message, '修改失败：' + e.message), 'err');
    if (btn) btn.disabled = false;
  }
}

async function afReissueCode(customerId, ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm await nulls currentTarget
  if (!(await askConfirm({
    title: 'Reissue this customer\'s referral code? Existing referrals keep their history; future shares will use the new code. · 重新生成此顾客的邀请码?已有推荐记录保留;以后分享使用新邀请码。',
    confirmLabel: cuT('Reissue code', '重发邀请码'),
  }))) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/retail-admin/customers/' + customerId + '/referral-code', { method: 'POST' });
    toast('New code · 新邀请码: ' + (r.data?.code || '?'));
    if (CU_CURRENT?.customer?.id === customerId) cuOpenDetail(customerId);
  } catch (e) { toast('Reissue failed · 重发失败: ' + e.message, 'err'); } finally { if (btn) btn.disabled = false; }
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

// ── Create a customer by hand — walk-in / phone order that never used the app.
// The server mints a synthetic 'manual:' identity and reuses-by-phone, so this
// is safe to call even when the person later signs in themselves.
function cuOpenCreate() {
  $('#cu-new-nickname').value = '';
  $('#cu-new-phone').value    = '';
  $('#cu-new-email').value    = '';
  cuShowModal('#cu-create-bg');
  setTimeout(() => { const el = $('#cu-new-nickname'); if (el) el.focus(); }, 60);
}
function cuCloseCreate() { $('#cu-create-bg').classList.remove('show'); }

async function cuCreateCustomer() {
  const SLOTS = [['cu-new-phone-err', 'cu-new-phone-field'], ['cu-new-email-err', 'cu-new-email-field']];
  cuErrClear(...SLOTS);
  const body = {
    nickname: $('#cu-new-nickname').value.trim(),
    phone:    $('#cu-new-phone').value.trim(),
    email:    $('#cu-new-email').value.trim(),
  };
  // Neither identifier — the one error that belongs to the PAIR, so it sits
  // under Phone (the field an operator is likeliest to have meant to fill).
  if (!body.nickname && !body.phone) {
    cuErr('cu-new-phone-err', cuErrText('name_or_phone_required'), 'cu-new-phone-field');
    return;
  }
  try {
    const j = await adminWrite({
      btnId: 'cu-new-save', url: '/api/retail-admin/customers', method: 'POST', body,
      silent: true,
      busyLabel: cuT('Creating…', '创建中…'),
      also: '#cu-new-cancel',
    });
    cuCloseCreate();
    cuLoad();
    cuLoadKpis(true);
    const id = j?.data?.id;
    if (id == null) return;

    // ── The four outcomes ────────────────────────────────────────────────
    // The drawer opening IS the confirmation for a plain create, so (a) says
    // nothing. Only the two outcomes that carry a surprise get a note, and it
    // goes INLINE in the drawer — never a toast, which would announce the
    // surprise somewhere other than where its evidence is.
    //   (d) is handled for free: cuOpenDetail() GETs the record, which stamps
    //       seen_at, so a brand-new customer is never an unopened row.
    let note = null;
    if (j.reused) {
      // (c) Nothing was created. Say so plainly — an operator who typed a new
      // name and got someone else's record needs to know why.
      const who = j?.data?.nickname ? ` (${j.data.nickname})` : '';
      note = cuT(
        `${body.phone} already belongs to this customer${who} — opened their record instead of creating a new one.`,
        `${body.phone} 已属于该顾客${who} — 已打开其记录,未新建。`);
    } else {
      // (b) Created, and the endpoint moved something across. Name exactly
      // what arrived, and ONLY what actually did — a note listing zeros would
      // be noise dressed as news.
      const carried = [];
      const bal = Number(j?.carried?.balance || 0);
      const pts = Number(j?.carried?.points || 0);
      const vch = Number(j?.carried?.vouchers || 0);
      if (bal) carried.push(cuT(`${cuMoneyPlain(bal)} balance`, `余额 ${cuMoneyPlain(bal)}`));
      if (pts) carried.push(cuT(`${cuNum(pts)} points`, `${cuNum(pts)} 积分`));
      if (vch) carried.push(cuT(`${cuNum(vch)} welcome voucher${vch > 1 ? 's' : ''}`, `${cuNum(vch)} 张欢迎券`));
      if (carried.length) {
        note = cuT(`Created. ${carried.join(' and ')} carried over from their old account.`,
                   `已创建。从旧账户带入${carried.join('、')}。`);
      }
      // (a) nothing carried → note stays null → the drawer just opens.
    }
    CU_PENDING_NOTE = note;
    cuOpenDetail(id);
  } catch (e) {
    const code = e.code;
    if (code === 'bad_phone') cuErr('cu-new-phone-err', cuErrText('bad_phone'), 'cu-new-phone-field');
    else if (code === 'bad_email') cuErr('cu-new-email-err', cuErrText('bad_email'), 'cu-new-email-field');
    else if (code === 'name_or_phone_required') cuErr('cu-new-phone-err', cuErrText(code), 'cu-new-phone-field');
    else cuErr('cu-new-phone-err', cuT('Create failed', '创建失败') + ': ' + cuErrText(code), null);
  }
}

// ── Direct message — operator opens a conversation with this customer ───────
// Reuses the feedback thread tables (POST .../customers/:id/message creates an
// admin-initiated thread + notifies the customer). After sending we jump into
// the existing Feedback thread drawer so the operator can carry on the chat.
function cuMessageCustomer() {
  const c = CU_CURRENT?.customer;
  if (!c) return;
  $('#cu-msg-text').value = '';
  // A nameless customer reads "No name · #464", not "#464 · #464": the
  // nickname half used to fall back to the id, which the line then appended
  // again. "No name" is the exact wording the roster uses, so one customer
  // is described the same way wherever they appear.
  $('#cu-msg-who').textContent = (c.nickname || cuT('No name', '未填姓名')) + ' · #' + c.id;
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
      btnId: 'cu-msg-send', busyLabel: cuT('Sending…', '发送中…'), also: '#cu-msg-cancel', url: '/api/retail-admin/customers/' + c.id + '/message',
      method: 'POST', body: { message }, errLabelEn: 'Send failed', errLabelCn: '发送失败',
    });
    cuCloseMsg();
    // No toast: the thread drawer opening below IS the confirmation, and it
    // shows the message itself rather than asserting it was sent.
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
//
// Two OPT-IN options, added for the Customers modals (§1.12) and defaulted OFF
// so Orders, Refunds and Tracking keep the exact behaviour they have today.
// Changing a shared helper's defaults to suit one page is how a fix on one
// surface becomes a bug on three:
//   • silent     — skip the error toast and just throw, so the caller can put
//                  the failure INLINE next to the field that caused it.
//   • busyLabel  — what the pressed button says while it works ("Saving…").
//                  Without it the button shows the historic bare '…'.
//   • also       — extra elements to disable for the duration (the modal's
//                  Cancel button, which nothing used to disable).
async function adminWrite({ btn, btnId, url, method = 'POST', body, errLabelEn = 'Failed', errLabelCn = '失败',
                            silent = false, busyLabel = null, also = null }) {
  const btnEl = btn instanceof Element ? btn
              : btn ? document.querySelector(btn)
              : btnId ? document.getElementById(btnId)
              : null;
  // Everything that must go dead while the write is in flight. A write control
  // that stays live is an invitation to double-submit.
  const alsoEls = (Array.isArray(also) ? also : (also ? [also] : []))
    .map(x => x instanceof Element ? x : document.querySelector(x))
    .filter(Boolean);
  alsoEls.forEach(el => { el.disabled = true; });
  const restore = btnEl ? btnEl.textContent : null;
  if (btnEl) { btnEl.disabled = true; btnEl.dataset.busy = '1'; btnEl.textContent = busyLabel || '…'; }
  try {
    const opts = { method, headers: body ? { 'Content-Type': 'application/json' } : undefined };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const j = await res.json().catch(() => ({ success: false, error: 'bad_response' }));
    if (!j.success) {
      // Show the server's logical reason, never a bare code (audit A-09). The
      // server's own `message` wins when it sent one; otherwise tdErrorText
      // turns the code into a sentence, and at worst into words. The code
      // itself moves to the toast's title so it can still be quoted in support
      // without being what the merchant reads.
      const code = j.error || 'unknown';
      const reason = (typeof tdErrorText === 'function') ? tdErrorText(code, j.message) : (j.message || code);
      const extra = j.current !== undefined ? ` (current · 当前: ${j.current})` : '';
      if (!silent) toast(`${errLabelEn} · ${errLabelCn}: ${reason}${extra}`, 'err', { title: code });
      const err = new Error(reason);
      err.code = code;
      err.rawMessage = j.message || null;
      err.failed = true;          // what the catch below tests, not the message text
      err.payload = j;            // silent callers render the reason themselves
      throw err;
    }
    return j;
  } catch (e) {
    // `e.failed` marks the throw above, which has ALREADY toasted. Tested on a
    // flag rather than on the message text, because the message is now a human
    // sentence (audit A-09) and matching it against 'request_failed' would
    // double-toast every server refusal.
    if (!silent && !e.failed) {
      toast(`${errLabelEn} · ${errLabelCn}: ${e.message || cuT('no connection', '网络不可用')}`, 'err');
    }
    throw e;
  } finally {
    if (btnEl) { btnEl.disabled = false; delete btnEl.dataset.busy; if (restore != null) btnEl.textContent = restore; }
    alsoEls.forEach(el => { el.disabled = false; });
  }
}
// Back-compat alias: Customers drawer used `cuWriteRequest({ btnId, ... })`.
const cuWriteRequest = adminWrite;

// ── Inline validation for the customer modals ────────────────────────────
// §1.12: a failure belongs BESIDE the field that caused it, not in a toast
// that appears somewhere else and then leaves. cuErr() puts the sentence
// under the field and marks the field itself; cuErrClear() wipes every slot
// in a modal before each submit so a stale message can't outlive its cause.
function cuErr(slotId, msg, fieldId) {
  const slot = document.getElementById(slotId);
  if (slot) slot.textContent = msg || '';
  const field = fieldId ? document.getElementById(fieldId) : null;
  if (field) field.classList.toggle('is-bad', !!msg);
}
function cuErrClear(...pairs) {
  pairs.forEach(([slotId, fieldId]) => cuErr(slotId, '', fieldId));
}
// The endpoints' own rejection codes, said in words. Anything unmapped falls
// through to its raw code rather than a soothing generic — an unrecognised
// failure should look unhandled, not handled.
const CU_ERR_TEXT = {
  bad_phone:  ['That phone doesn’t look like a number we can reach. Use digits, optionally with +86.', '这个号码看起来无法接通。请填写数字,可加 +86。'],
  bad_email:  ['That email is missing its @ or its domain. Write it like name@example.com.', '邮箱缺少 @ 或域名。请按 name@example.com 格式填写。'],
  name_or_phone_required: ['Enter a name or a phone — one of the two is needed.', '请填写姓名或电话 — 两者至少填一项。'],
};
function cuErrText(code) {
  const m = CU_ERR_TEXT[code];
  return m ? cuT(m[0], m[1]) : String(code || '');
}

async function cuSaveEdit() {
  if (!CU_CURRENT?.customer) return;
  cuErrClear(['cu-edit-phone-err', 'cu-edit-phone-field'], ['cu-edit-email-err', 'cu-edit-email-field']);
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
      method: 'PATCH', body,
      // Inline, not toasted: the two checks this can fail (email shape,
      // duplicate phone) both point at a specific field.
      silent: true,
      busyLabel: cuT('Saving…', '保存中…'),
      also: '#cu-edit-cancel',
    });
    cuCloseEdit();
    cuOpenDetail(CU_CURRENT.customer.id);
  } catch (e) {
    const j = e.payload || {};
    if (e.code === 'phone_taken') {
      // Name WHO holds it — "taken" alone leaves the operator to go hunting.
      const who = j.nickname ? `${j.nickname} (#${j.customer_id})` : `#${j.customer_id}`;
      cuErr('cu-edit-phone-err',
        cuT(`That number already belongs to ${who}. One customer per number.`,
            `该号码已属于 ${who}。一个号码只能对应一位顾客。`),
        'cu-edit-phone-field');
    } else if (e.code === 'bad_phone') {
      cuErr('cu-edit-phone-err', cuErrText('bad_phone'), 'cu-edit-phone-field');
    } else if (e.code === 'bad_email') {
      cuErr('cu-edit-email-err', cuErrText('bad_email'), 'cu-edit-email-field');
    } else {
      cuErr('cu-edit-phone-err', cuT('Save failed', '保存失败') + ': ' + cuErrText(e.code), null);
    }
  }
}

async function cuToggleBlock(ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm/reason await nulls currentTarget
  if (!CU_CURRENT?.customer) return;
  const c = CU_CURRENT.customer;
  const blocking = !c.is_blocked;
  if (blocking) {
    const reason = await askReason({
      title: 'Block this customer? Optional reason for the audit log. · 封禁此顾客?可填写原因(写入审计日志)',
      submitLabel: cuT('Block customer', '封禁顾客'),
      danger: true,
    });
    if (reason === null) return;
    if (btn) btn.disabled = true;   // manual disable (not adminWrite's btn) so the icon isn't stripped
    try {
      await cuWriteRequest({
        url: '/api/retail-admin/customers/' + c.id + '/block', method: 'POST',
        body: { reason }, errLabelEn: 'Block failed', errLabelCn: '封禁失败',
      });
      toast('Blocked · 已封禁');
    } catch { return; } finally { if (btn) btn.disabled = false; }
  } else {
    if (!(await askConfirm({
      title: 'Unblock this customer? · 解除此顾客的封禁?',
      confirmLabel: cuT('Unblock', '解封'),
    }))) return;
    if (btn) btn.disabled = true;   // manual disable (not adminWrite's btn) so the icon isn't stripped
    try {
      await cuWriteRequest({
        url: '/api/retail-admin/customers/' + c.id + '/unblock', method: 'POST',
        errLabelEn: 'Unblock failed', errLabelCn: '解封失败',
      });
      toast('Unblocked · 已解封');
    } catch { return; } finally { if (btn) btn.disabled = false; }
  }
  cuLoadKpis(true);   // blocked count changed — refresh the strip + its chip
  cuLoad();           // …and the roster: a blocked customer leaves the default cut
  cuOpenDetail(c.id);
}

async function cuForceLogout(ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm await nulls currentTarget
  if (!CU_CURRENT?.customer) return;
  if (!(await askConfirm({
    title: 'Sign this customer out on all devices? Active sessions are revoked immediately — useful if a token may be compromised. She can sign back in normally; to lock her out, use Block instead. · 退出该顾客的所有设备?将立即撤销所有活跃会话——令牌可能泄露时适用。她可正常重新登录;如需锁定,请改用封禁。',
    confirmLabel: cuT('Sign out all devices', '退出所有设备'),
  }))) return;
  if (btn) btn.disabled = true;   // manual disable (not adminWrite's btn) so the icon isn't stripped
  try {
    const j = await cuWriteRequest({
      url: '/api/retail-admin/customers/' + CU_CURRENT.customer.id + '/force-logout', method: 'POST',
      errLabelEn: 'Sign-out failed', errLabelCn: '退出失败',
    });
    const n = j.revoked || 0;
    toast(`Signed out all devices · ${n} session${n === 1 ? '' : 's'} revoked · 已退出所有设备(${n} 个会话)`);
    cuOpenDetail(CU_CURRENT.customer.id);
  } catch {} finally { if (btn) btn.disabled = false; }
}

function cuOpenAdjust(kind) {
  if (!CU_CURRENT?.customer) return;
  CU_ADJUST_KIND = kind;
  const c = CU_CURRENT.customer;
  $('#cu-adjust-title').textContent  = kind === 'points'
    ? 'Adjust points balance · 调整积分余额'
    : 'Adjust wallet balance · 调整钱包余额';
  // 🔴 ONE LANGUAGE, CHOSEN BY cuT. Two separate failures were live here in
  // sequence, and fixing only the visible one would have made it worse.
  //
  //   1. What was on screen: the element carried data-no-i18n, so the walker
  //      skipped it and BOTH halves of "Current · 当前: ¥0" rendered at once.
  //      The shield was the cause.
  //   2. What un-shielding alone would have done: the walker splits on the
  //      FIRST ' · ', giving en="Current" and cn="当前: ¥0". English would have
  //      rendered "Current" with the VALUE SILENTLY GONE.
  //
  // A shield that shows too much is visible and gets reported. A split that
  // drops the number is not — it just looks like a label. So the fix is
  // neither shielding nor splitting: keep the pair away from the walker
  // ENTIRELY by composing one language with cuT().
  //
  // ⚠ THE SHAPE RULE THIS STRING BROKE: a bilingual pair must be clean English
  // on the LEFT and Chinese on the RIGHT, with NOTHING after the Chinese. A
  // trailing colon and value on the Chinese side makes the string unsplittable
  // no matter how it is wrapped — the walker has no way to know the "¥0"
  // belongs to both languages.
  $('#cu-adjust-current').textContent = kind === 'points'
    ? cuT(`Current: ${cuNum(c.points_balance || 0)} pts`, `当前:${cuNum(c.points_balance || 0)} 分`)
    : cuT(`Current: ${cuMoneyPlain(c.balance)}`, `当前:${cuMoneyPlain(c.balance)}`);
  $('#cu-adjust-delta').value  = '';
  $('#cu-adjust-reason').value = '';
  cuShowModal('#cu-adjust-bg');
}
function cuCloseAdjust() { $('#cu-adjust-bg').classList.remove('show'); }

async function cuSaveAdjust() {
  if (!CU_CURRENT?.customer) return;
  cuErrClear(['cu-adjust-reason-err', 'cu-adjust-reason-field']);
  const deltaRaw = Number($('#cu-adjust-delta').value);
  const reason   = $('#cu-adjust-reason').value.trim();
  if (!Number.isFinite(deltaRaw) || deltaRaw === 0) {
    return cuErr('cu-adjust-reason-err', cuT('Enter a non-zero amount.', '请填写非零变动量。'), null);
  }
  // Required, and refused INLINE next to the field rather than by a toast that
  // appears away from the empty box it is about.
  if (!reason) {
    return cuErr('cu-adjust-reason-err',
      cuT('A reason is required — it is written to the ledger with this adjustment.',
          '必须填写原因 — 它会连同本次调整一并记入流水。'),
      'cu-adjust-reason-field');
  }
  // Points must be integers — reject decimals up front rather than silently
  // truncating (which the server would do anyway but the customer-facing
  // ledger row would then disagree with what the operator typed).
  if (CU_ADJUST_KIND === 'points' && !Number.isInteger(deltaRaw)) {
    return cuErr('cu-adjust-reason-err', cuT('Points must be a whole number.', '积分必须是整数。'), null);
  }
  const delta = CU_ADJUST_KIND === 'points' ? Math.trunc(deltaRaw) : deltaRaw;
  const path  = CU_ADJUST_KIND === 'points' ? 'points-adjust' : 'wallet-adjust';
  try {
    await cuWriteRequest({
      btnId: 'cu-adjust-save', url: '/api/retail-admin/customers/' + CU_CURRENT.customer.id + '/' + path,
      method: 'POST', body: { delta, reason },
      silent: true, busyLabel: cuT('Applying…', '应用中…'), also: '#cu-adjust-cancel',
    });
    cuCloseAdjust();
    cuOpenDetail(CU_CURRENT.customer.id);
  } catch (e) {
    // silent:true means nothing else will report this — the endpoint's own
    // reason (the balance floor, a cap) goes inline. An empty catch here would
    // swallow the refusal and leave the operator thinking it worked.
    const j = e.payload || {};
    const extra = j.current !== undefined ? cuT(` (current: ${j.current})`, `(当前:${j.current})`) : '';
    cuErr('cu-adjust-reason-err',
      (j.message || cuErrText(e.code) || cuT('Adjustment failed', '调整失败')) + extra, null);
  }
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
  let html = '<option value="">Select province · 选择省份</option>';
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
  let html = '<option value="">Select city · 选择城市</option>';
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
  if (!cityCn) { sel.innerHTML = '<option value="">Select district · 选择区/县</option>'; return; }
  sel.innerHTML = '<option value="">Loading… · 加载中…</option>';
  let list = [];
  try {
    const r = await fetch('/api/retail/districts?city=' + encodeURIComponent(cityCn), { credentials: 'same-origin' });
    const j = await r.json();
    list = (j && j.data) || [];
  } catch (e) { /* fall through to empty */ }
  let html = '<option value="">Select district · 选择区/县</option>';
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
  $('#cu-addr-district').innerHTML = '<option value="">Select district · 选择区/县</option>';
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
  const inheritedPhone = !a && !!CU_CURRENT.customer.phone;
  $('#cu-addr-phone').value            = a ? (a.phone          || '') : (CU_CURRENT.customer.phone || '');
  // A silently pre-filled field is indistinguishable from one the operator
  // typed — so it says where the number came from, and that it can be changed.
  const phNote = $('#cu-addr-phone-note');
  if (phNote) {
    phNote.hidden = !inheritedPhone;
    phNote.textContent = inheritedPhone
      ? cuT("Using the customer's number — change it if this address has its own.",
            '已填入顾客本人号码 — 若该地址另有联系电话请修改。')
      : '';
  }
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
  cuErr('cu-addr-err', '', null);
  if (!body.recipient_name || !body.phone || !body.address) {
    return cuErr('cu-addr-err',
      cuT('Recipient, phone and street address are all needed.',
          '收件人、电话和详细地址都需要填写。'), null);
  }
  const cid = CU_CURRENT.customer.id;
  const url = CU_ADDR_EDIT_ID
    ? `/api/retail-admin/customers/${cid}/addresses/${CU_ADDR_EDIT_ID}`
    : `/api/retail-admin/customers/${cid}/addresses`;
  try {
    await cuWriteRequest({
      btnId: 'cu-addr-save', busyLabel: cuT('Saving…', '保存中…'), also: '#cu-addr-cancel', url, method: CU_ADDR_EDIT_ID ? 'PUT' : 'POST', body,
      silent: true,
    });
    // No toast: the drawer reopens with the address in the list — the result
    // is the confirmation, and it's the thing the operator was looking at.
    cuCloseAddrModal();
    cuOpenDetail(cid);
  } catch (e) {
    // silent:true means nothing else reports this — say it inline.
    const j = e.payload || {};
    cuErr('cu-addr-err', j.message || cuErrText(e.code) || cuT('Save failed', '保存失败'), null);
  }
}

async function cuDeleteAddr(addrId, ev) {
  const btn = ev && ev.currentTarget;   // capture before the confirm await nulls currentTarget
  if (!CU_CURRENT?.customer) return;
  if (!(await askConfirm({
    title: 'Delete this address? · 删除此地址?',
    confirmLabel: cuT('Delete address', '删除地址'),
    danger: true,
  }))) return;
  const cid = CU_CURRENT.customer.id;
  try {
    await cuWriteRequest({
      btn, url: `/api/retail-admin/customers/${cid}/addresses/${addrId}`, method: 'DELETE',
      errLabelEn: 'Delete failed', errLabelCn: '删除失败',
    });
    toast('Deleted · 已删除');
    cuOpenDetail(cid);
  } catch {}
}

function cuFmtTime(iso) {
  // Single source of truth — §1.18's `dateTime`, rendered in the store's
  // wall clock and correct on any machine regardless of the browser's zone.
  return formatDate(iso);
}

// The store's calendar day ('YYYY-MM-DD') for a UTC timestamp or epoch ms.
// A COMPARISON KEY, never shown — hence §1.18's `machine`, which is exempt
// from localisation for exactly this reason. It used to slice the first ten
// characters off formatDate()'s output, which only worked while that output
// happened to start with an ISO date; it does not any more.
function cuGzDay(v) {
  return tdWhen(v, 'machine');
}

// List "Last seen" — Today 2:35 PM / Yesterday 11:24 PM / Jul 3. The roster is
// mostly today and yesterday, so repeating the date on every row is noise.
function cuFmtSeen(iso) {
  if (!iso) return cuT('never', '从未');
  // Compare on `machine` days and render with `time` / `date` (§1.18). This
  // used to slice a clock out of formatDate()'s output by character offset,
  // which stopped being an ISO stamp the moment the rule landed.
  const day = cuGzDay(iso);
  // An unparseable timestamp is still not a dash. It also must not be a
  // TRUTHY dash: callers write `cuFmtSeen(x) || 'never'`, and '—' satisfies
  // that `||`, so a dash here would silently outrank the real fallback.
  if (!day) return cuT('never', '从未');
  const clock = tdWhen(iso, 'time');
  if (day === cuGzDay(Date.now()))                    return cuT('Today', '今天') + ' ' + clock;
  if (day === cuGzDay(Date.now() - 24 * 3600 * 1000)) return cuT('Yesterday', '昨天') + ' ' + clock;
  return tdWhen(iso, 'date');
}

// Monogram for the roster's identity cell — first letter of the nickname, or a
// quiet middot when there's no name yet. Array.from so an emoji or a Chinese
// character survives as one glyph instead of a broken surrogate half.
// Monogram = the first real LETTER, Latin or CJK. Nicknames open with emoji,
// quotes and symbols often enough that taking character [0] gave a wall of 🍌
// and 「 tiles. No letter anywhere in the name → the plain person icon, never
// a punctuation mark and never a dash.
function cuMonogram(nickname) {
  const m = String(nickname || '').match(/[A-Za-z一-龥]/);
  if (m) return escapeHtml(m[0].toUpperCase());
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>';
}

// A shown "joined" date — §1.18's `date`. It used to build YYYY-MM-DD out of
// getFullYear()/getMonth()/getDate(), which read the BROWSER's clock, so an
// operator abroad saw a different join date than the one in Guangzhou.
function cuFmtDate(iso) {
  return tdWhen(iso, 'date');
}

// ── Live updates ───────────────────────────────────────────────────────
// A new customer used to need a page refresh to show up: this tab loaded once
// behind CUSTOMERS_LOADED and then never looked again for the life of the
// session. It now follows the platform standard (reference/live-updates-spec.md)
// — the admin-wide SSE hub nudges, we refetch silently, nobody clicks anything.
//
// No server change was needed: the watermark tick already samples
// retail_customers (COUNT + MAX(created_at) in _dashActivitySignature,
// routes/retail.js), so a signup from the mini-app, the web storefront, or one
// of the separate daemon processes all land here. Worst-case latency is that
// 5s tick plus the debounce below.
const CUSTOMERS_POLL_MS = 60000;
let _CU_AUTO_TIMER = null;

// Refetch gate. Declines only where the work would be wasted or destructive:
// the tab isn't on screen, the document is hidden, or the operator is mid-input
// (a rebuild under a live search would fight what they're typing). Safe with
// the detail drawer or a modal open — those render from CU_CURRENT, not from
// the table, and an unchanged roster fingerprints identical and touches no DOM.
function _cuAutoTick() {
  if (document.hidden) return;
  if (!document.getElementById('tab-customers')?.classList.contains('active')) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.matches('input, select, textarea, [contenteditable="true"]')) return;
  cuLoad({ silent: true });
  cuLoadKpis();   // throttled (45s) — the strip follows the roster
}

// Coalesce a burst of nudges into one refetch: a batch of signups moves the
// watermark several times over, and one fetch a moment later sees all of them.
let _CU_LIVE_DEBOUNCE = null;
function _cuLiveNudge() {
  // _cuAutoTick already declines when hidden, off-tab, or mid-input.
  clearTimeout(_CU_LIVE_DEBOUNCE);
  _CU_LIVE_DEBOUNCE = setTimeout(_cuAutoTick, 400);
}

(function _startCustomersLive() {
  if (window._customersLiveWired) return;
  window._customersLiveWired = true;
  // Live push — the primary path. New customers arrive on their own.
  if (typeof retailLiveSubscribe === 'function') retailLiveSubscribe(_cuLiveNudge);
  // Backstop, deliberately slow. It covers the stretch while that socket is
  // down and reconnecting, and the one move the watermark can't see: "Last
  // seen" changing when an EXISTING customer opens the app. The signature
  // samples MAX(created_at), not last_login_at, and widening it would make
  // every app-open refetch the whole admin for every operator — too chatty a
  // price for a column that reorders the list.
  if (_CU_AUTO_TIMER) clearInterval(_CU_AUTO_TIMER);
  _CU_AUTO_TIMER = setInterval(_cuAutoTick, CUSTOMERS_POLL_MS);
  // The gate declines while hidden or off-tab, so catch up on the way back in.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) _cuAutoTick(); });
  window.addEventListener('focus', _cuAutoTick);
})();

document.querySelector('[data-tab="customers"]').addEventListener('click', () => {
  if (!CUSTOMERS_LOADED) { CUSTOMERS_LOADED = true; cuLoad(); }
  // Already loaded once — refresh rather than show the roster as it stood when
  // the operator last left the tab. The 50ms lets the tab become .active
  // first: the gate above reads that class and would otherwise decline.
  else setTimeout(_cuAutoTick, 50);
  cuLoadKpis();   // throttled (45s) — keeps the New-today pulse fresh on open
});

// The filter row exists in the DOM from page load (not just once the
// customers tab is first opened), so paint both dropdowns right away.
cuPaintFilterBar();

