/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 03/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: Tacet Dashboard (The Recap + attention + today pulse, td*) and
   the Reports tab (KPIs/trend/charts, dash*). */
// ════════════════════════════════════════════════════════════════
// DASHBOARD (Tacet) + REPORTS — the Dashboard answers one question
// ("is everything okay?"): The Recap, then anything needing attention,
// then today's pulse. All historical analytics live in #tab-reports
// (reads /api/retail-admin/dashboard). Charts are hand-rolled SVG/CSS.
// ════════════════════════════════════════════════════════════════
let DASH_DATA = null;
let DASH_METRIC = 'revenue';
// Set by the manual ↻ refresh so the KPI numbers roll up from zero (the
// dramatic entrance) rather than drifting in place — cleared after one render.
let DASH_FORCE_ROLLUP = false;

function dashMoney(n, dp) { return '¥' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 }); }
function dashNum(n) { return Number(n || 0).toLocaleString(); }
function dashDelta(pct) {
  if (pct == null) return '<span class="db-delta flat">—</span>';
  const up = pct >= 0;
  const cls = pct === 0 ? 'flat' : (up ? 'up' : 'down');
  const arrow = pct === 0 ? '' : (up ? '▲' : '▼');
  return `<span class="db-delta ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

// ── Bento data-viz helpers ────────────────────────────────────────────────
// Build list-tile rows with a left-anchored magnitude bar. `opt.value(item)`
// drives the bar (scaled to the row set's own max); `opt.display(item)` is the
// right-hand string; `opt.name(item)` is the raw (un-escaped) left label.
function dashBarRows(items, opt) {
  // Bars top out at BAR_CAP (not full width) so even the leader keeps a visible
  // right edge instead of washing the whole row into a flat tint. opt.curve =
  // 'sqrt' gives whale-skewed sets (e.g. revenue with one big customer) a
  // gentler ramp so the non-leaders stay distinguishable rather than all
  // collapsing into near-identical slivers.
  const BAR_CAP = 0.85;
  const curve = opt.curve === 'sqrt' ? (x => Math.sqrt(x)) : (x => x);
  const vals = items.map(it => Math.max(0, Number(opt.value(it)) || 0));
  const max = Math.max(1, ...vals);
  return items.map((it, i) => {
    const v = vals[i];
    const mag = v <= 0 ? 0 : curve(Math.min(1, v / max)) * BAR_CAP;
    const zero = v <= 0;
    return `<div class="db-tile-list-row has-bar${zero ? ' is-zero' : ''}" style="--mag:${mag.toFixed(3)}">
      <span class="name">${escapeHtml(opt.name(it))}</span>
      <span class="val">${opt.display(it)}</span>
    </div>`;
  }).join('');
}

// Catmull-Rom → cubic-bézier path through the points: turns the old straight
// segments into one flowing curve. Tension is gentle and the Y of each control
// point is clamped to the box so the curve can't overshoot under the horizontal
// stretch. Anchor points stay exactly on the data vertices, so the dot/scrub
// (which key off dashSparkPct) still land on the line.
let _dashSparkSeq = 0;
function dashSmoothPath(p, H, pad) {
  if (p.length < 2) return '';
  const cy = v => Math.max(pad, Math.min(H - pad, v));
  let d = `M ${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2, t = 0.85;
    const c1x = p1.x + (p2.x - p0.x) / 6 * t, c1y = cy(p1.y + (p2.y - p0.y) / 6 * t);
    const c2x = p2.x - (p3.x - p1.x) / 6 * t, c2y = cy(p2.y - (p3.y - p1.y) / 6 * t);
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

// A soft sparkline stretched full-width via preserveAspectRatio="none" +
// non-scaling-stroke: a smooth Catmull-Rom curve over an ink→transparent
// vertical wash (vs the old straight line + flat fill). opts.dot adds an HTML
// last-point marker (opts.pulse = the softly breathing variant).
function dashSparkline(values, opts) {
  opts = opts || {};
  const vals = (values || []).map(v => Number(v) || 0);
  const W = 100, H = 24, pad = 2;
  // Degenerate state (no data yet today, or a single bucket): instead of
  // vanishing — which reads as "missing chart" — draw a faint dashed baseline
  // so the sparkline is always visibly present and clearly says "no activity".
  if (vals.length < 2 || vals.every(v => v <= 0)) {
    const midY = (H / 2).toFixed(1);
    return `<svg class="db-spark is-flat" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
      + `<line x1="${pad}" y1="${midY}" x2="${W - pad}" y2="${midY}" stroke="currentColor" stroke-width="1" `
      + `vector-effect="non-scaling-stroke" stroke-dasharray="2 3" opacity="0.35"/></svg>`;
  }
  const n = vals.length;
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const span = (max - min) || 1;
  const x = i => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = v => (H - pad) - ((v - min) / span) * (H - 2 * pad);
  const p = vals.map((v, i) => ({ x: x(i), y: y(v) }));
  const d = dashSmoothPath(p, H, pad);
  // Unique gradient id per render so multiple sparklines on one screen never
  // share/clobber a <defs> id. The wash fades the brand ink down to nothing.
  const gid = 'dbSparkG' + (++_dashSparkSeq);
  const defs = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="currentColor" stop-opacity="0.26"/>`
    + `<stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>`;
  const area = `<path class="db-spark-area" d="${d} L ${x(n - 1).toFixed(1)} ${(H - pad).toFixed(1)} L ${x(0).toFixed(1)} ${(H - pad).toFixed(1)} Z" fill="url(#${gid})" stroke="none"/>`;
  const line = `<path class="db-spark-line" pathLength="1" d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
  // Last-point marker as an HTML overlay (not an SVG circle): the chart uses
  // preserveAspectRatio="none", which would squash a <circle> into an ellipse.
  // The wrap is position:relative, so percentage offsets land it on the point.
  let dot = '';
  if (opts.dot) {
    const p = dashSparkPct(vals, n - 1);
    dot = `<i class="db-spark-dot${opts.pulse ? ' is-breathing' : ''}" style="left:${p.x.toFixed(1)}%;top:${p.y.toFixed(1)}%"></i>`;
  }
  return `<svg class="db-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${defs}${area}${line}</svg>${dot}`;
}

// Period caption ("Last 30 days · 近30天") from the active date-range window —
// only for dash-source tiles, so each tile says which window it's summarising.
function dashRangeFoot() {
  const w = (typeof DASH_DATA !== 'undefined' && DASH_DATA && DASH_DATA.window) || null;
  if (!w) return '';
  const d = Number(w.span_days) || 1;
  const en = d <= 1 ? 'Today' : `Last ${d} days`;
  const cn = d <= 1 ? '今日' : `近${d}天`;
  return `<div class="db-tile-foot">${en} · ${cn}</div>`;
}

// Tween a number into `el` on change. First paint (no cached value) sets it
// instantly; reduced-motion users skip the tween.
function dashCountUp(el, to, fmt, dur) {
  if (!el) return;
  const f = fmt || (n => String(Math.round(n)));
  to = Number(to) || 0;
  const from = (el._cuVal != null) ? el._cuVal : to;
  el._cuVal = to;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || from === to) { el.textContent = f(to); return; }
  if (el._cuRaf) cancelAnimationFrame(el._cuRaf);
  dur = dur || 600;
  // Long roll-ups (the Deep dive reveal) get a softer easeOutQuint so the
  // last stretch drifts to rest — the "zen" settle, not a 600ms snap-stop.
  const quint = dur >= 1000;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = quint ? 1 - Math.pow(1 - p, 5) : 1 - Math.pow(1 - p, 3);
    el.textContent = f(from + (to - from) * e);
    if (p < 1) el._cuRaf = requestAnimationFrame(step);
  };
  el._cuRaf = requestAnimationFrame(step);
}

// Zen scroll — glide the page so `el` rests near the top of the viewport with
// a long easeInOutCubic curve. Unlike scrollIntoView({behavior:'smooth'}) this
// runs slow on purpose (~1.3s) and eases in *and* out, so the deep-dive reveal
// settles rather than snapping. Walks up to find the real scroll container
// (window or an overflow:auto pane) so it works wherever the dashboard lives.
function dashZenScrollTo(el, opts) {
  opts = opts || {};
  const dur = opts.dur || 1300;
  const margin = opts.margin != null ? opts.margin : 24;
  // Find the nearest scrollable ancestor; fall back to the page scroller.
  let sc = el.parentElement;
  while (sc && sc !== document.body) {
    const oy = getComputedStyle(sc).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && sc.scrollHeight > sc.clientHeight + 1) break;
    sc = sc.parentElement;
  }
  const usesWindow = !sc || sc === document.body || sc === document.documentElement;
  const scroller = usesWindow ? (document.scrollingElement || document.documentElement) : sc;
  const start = scroller.scrollTop;
  let target;
  if (usesWindow) {
    target = start + el.getBoundingClientRect().top - margin;
  } else {
    target = start + (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - margin;
  }
  // opts.top: glide fully to the scroller's top instead of resting `el` at
  // `margin` — used when the target is the topmost content (the date bar),
  // which would otherwise land tucked behind the sticky topbar + tabs.
  if (opts.top) target = 0;
  const max = scroller.scrollHeight - scroller.clientHeight;
  target = Math.max(0, Math.min(max, target));
  const dist = target - start;
  if (Math.abs(dist) < 2) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { scroller.scrollTop = target; return; }
  const t0 = performance.now();
  const ease = p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    scroller.scrollTop = start + dist * ease(p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Set the date inputs from a range key and reload. opts.defer sets the window
// without pulling the deep Reports build — used at desktop boot, where the
// pull waits for the first real Reports visit (reportsInit).
function dashSetRange(key, opts) {
  $$('#db-range-seg button').forEach(b => b.classList.toggle('active', b.dataset.range === key));
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  let from = today;
  if (key === '7')  from = new Date(Date.now() + 8 * 3600 * 1000 - 6  * 86400000).toISOString().slice(0, 10);
  if (key === '30') from = new Date(Date.now() + 8 * 3600 * 1000 - 29 * 86400000).toISOString().slice(0, 10);
  if (key === '90') from = new Date(Date.now() + 8 * 3600 * 1000 - 89 * 86400000).toISOString().slice(0, 10);
  $('#db-from').value = from;
  $('#db-to').value = today;
  if (opts && opts.defer) { dashRangeLabel(); return; }
  dashLoad();
}

// ── Dashboards by position ─────────────────────────────────────────────────
// The operator's role picks a fixed dashboard view (set as window.RA_POS +
// body.pos-* at boot). 'default' = the full owner view. The position decides
// which attention cards render (dashPosWants) and, via CSS, whether the money
// blocks (Recap / Today pulse / Channels) exist at all.
const DASH_POS_CARDS = {
  warehouse:        { stock: 1 },
  dispatch:         { delivery: 1 },
  customer_service: { delivery: 1, refunds: 1, invoices: 1 },
};
function dashPos() { return window.RA_POS || 'default'; }
function dashPosWants(kind) {
  const m = DASH_POS_CARDS[dashPos()];
  return !m || !!m[kind];
}

// ── Per-store filter ───────────────────────────────────────────────────────
// Returns the active store_id (string) or '' for "all stores". Read straight
// off the select so every loader (deep-dive, Today hero, ops tiles) scopes to
// the same store without threading state around. A store-scoped operator
// (store_manager — window.RA_STORE_LOCK) is pinned: every pull carries their
// store and the picker never appears.
function dashStoreId() {
  if (window.RA_STORE_LOCK) return String(window.RA_STORE_LOCK);
  const sel = document.getElementById('db-store');
  return sel ? (sel.value || '') : '';
}
// Append the store filter to a dashboard query string (no-op when "all").
function dashStoreQS() {
  const sid = dashStoreId();
  return sid ? `&store_id=${encodeURIComponent(sid)}` : '';
}
// A store pick re-pulls every store-scoped surface at once.
function dashStoreChange() {
  // Reports KPIs + charts — but never trigger the deferred deep build early;
  // it stays parked until the first Reports visit (reportsInit).
  if (DASH_DATA || DASH_REPORTS_SEEN) dashLoad();
  dashHeroLoadToday({ slow: false }); // Today pulse KPIs/sparklines
  if (typeof tdOpsLoad === 'function') tdOpsLoad(); // attention cards
}
// Populate the store dropdown once. Hidden for single-store tenants (no filter
// value). Mirrors the Orders tab's ensureOrdersStoreFilter.
let DASH_STORE_FILTER_LOADED = false;
async function dashEnsureStoreFilter() {
  if (DASH_STORE_FILTER_LOADED) return;
  if (window.RA_STORE_LOCK) return;   // store-scoped operator — no picker, always their store
  const sel = document.getElementById('db-store');
  if (!sel) return;
  try {
    const r = await api('/api/retail-admin/stores');
    const stores = r.data || [];
    if (stores.length <= 1) return;   // No filter UI value with one store.
    const prev = sel.value;
    sel.innerHTML = '<option value="">All stores · 全部门店</option>' +
      stores.map(s => `<option value="${s.id}">${escapeHtml(s.name_en || s.code)}</option>`).join('');
    if (prev) sel.value = prev;
    sel.hidden = false;
    DASH_STORE_FILTER_LOADED = true;
  } catch (e) { /* silent — filter just stays hidden */ }
}

function dashInit() {
  dashEnsureStoreFilter();
  // Wire the Reports range segment + trend metric buttons (once). These live
  // in #tab-reports but exist at boot, so wiring here is safe.
  $$('#db-range-seg button').forEach(b => b.addEventListener('click', () => dashSetRange(b.dataset.range)));
  $$('#db-trend-metrics button').forEach(b => b.addEventListener('click', () => {
    DASH_METRIC = b.dataset.metric;
    $$('#db-trend-metrics button').forEach(x => x.classList.toggle('active', x === b));
    if (DASH_DATA) {
      dashRenderTrend();
      // Ambient cross-fade on tab switch — replay the soft fade-in so the new
      // series drifts in rather than hard-cutting (reflow restarts the anim).
      const tr = document.getElementById('db-trend');
      if (tr) { tr.classList.remove('is-swap'); void tr.offsetWidth; tr.classList.add('is-swap'); }
    }
  }));
  // Chapter rail (Overview / Sales / Customers / Products & traffic).
  dashChaptersInit();
  // Language toggle repaints the cuT-built Reports chrome (head range echo +
  // per-panel window captions + chapter facts/headlines + the AI surfaces);
  // the charts themselves re-render on dashLoad.
  if (window.onLangChange) onLangChange(() => {
    dashRangeLabel(); dashWinMeta();
    if (DASH_DATA) { dashRenderHeadlines(); dashRenderFacts(); }
    dashReadRender(); dashNotesRender(); dashAskChipsRender(); dashAskRender();
  });
  // Initial 30d window. On a phone (≤720px) the pull happens at boot because
  // the phone dashboard (rmRenderDash) renders straight from DASH_DATA. On
  // desktop the deep Reports build (~28 aggregate queries) is DEFERRED to the
  // first Reports visit — at boot it used to queue ahead of the visible cards
  // and was the main reason the dashboard sat on "Loading…".
  const phoneMq = window.matchMedia && window.matchMedia('(max-width: 720px)');
  dashSetRange('30', { defer: !(phoneMq && phoneMq.matches) });
  // …and if a desktop window is later narrowed past the phone breakpoint, the
  // phone dashboard needs the data it was never sent. Pull it once, on cross.
  if (phoneMq && phoneMq.addEventListener) {
    phoneMq.addEventListener('change', e => { if (e.matches && !DASH_DATA) dashLoad(); });
  }
  dashHeroInit();      // today pulse: presence + today KPIs + activity polling
  tdInit();            // Tacet dashboard: The Recap + attention cards + date
}

// Reports rail-button init — everything is already loaded/rendered at boot by
// dashInit (the charts render fine while the section is hidden); this covers
// the edge where the first load failed, and marks the tab as VISITED — the AI
// read is only fetched once someone actually opens Reports, so merchants who
// never look never cost a billed call.
function reportsInit() {
  DASH_REPORTS_SEEN = true;
  if (!DASH_DATA) dashLoad();
  else dashReadMaybeLoad();
}

// ════════════════════════════════════════════════════════════════
// RIGHT-NOW HERO (phase 2/3) — live presence, today's mini-KPIs,
// the Channels-today split. Pulls /api/retail-admin/dashboard/presence
// (15s), /api/retail-admin/sales/summary (60s for the channel split),
// and a single /api/retail-admin/dashboard?from=today&to=today (60s
// for the "Today" mini-row). Polling pauses while the document is
// hidden so we don't hammer the server with a backgrounded tab.
// ════════════════════════════════════════════════════════════════
const DASH_HERO = { presence:null, channels:null, today:null, lastSync:0 };
const DASH_HERO_INTERVALS = { presence: 15000, channels: 60000, today: 60000 };

// One quick (3s) retry per surface when its FIRST load fails — without this a
// tripped boot request left the card on "Loading…"/"¥—" until the next 60s
// poll, and a manual page refresh was genuinely the fastest fix. Later poll
// failures stay silent as before (last good numbers are already on screen).
const DASH_BOOT_RETRIED = {};
function dashBootRetry(key, fn) {
  if (DASH_BOOT_RETRIED[key]) return false;
  DASH_BOOT_RETRIED[key] = true;
  setTimeout(fn, 3000);
  return true;
}

function dashHeroInit() {
  // Single bootstrap — once wired, the timers + visibility listener carry it.
  if (DASH_HERO._wired) { dashHeroRefreshAll(); return; }
  DASH_HERO._wired = true;
  // Language toggle repaints the Today delta badges from the stashed data.
  if (window.onLangChange) onLangChange(dashHeroTodayRepaint);
  // ...and re-renders the Channels-today split (channel names are JS-built).
  if (window.onLangChange) onLangChange(() => {
    if (DASH_HERO.chan) dashChanRender();
  });
  // Hover-scrub the Today sparklines to read each hour of the day.
  ['#db-today-spark', '#db-today-ord-spark', '#db-today-new-spark'].forEach(sel => {
    const w = $(sel); if (!w) return;
    w.addEventListener('pointermove', dashSparkMove);
    w.addEventListener('pointerleave', dashSparkLeave);
  });
  // Hover the delta badges for a chip explaining the comparison baseline.
  ['#db-today-rev-d', '#db-today-ord-d', '#db-today-new-d'].forEach(sel => {
    const b = $(sel); if (!b) return;
    b.addEventListener('pointerenter', dashDeltaHover);
    b.addEventListener('pointerleave', dashDeltaLeave);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) dashHeroStop();
    // Returning to the tab: restart the backstop polls, and if a live nudge
    // arrived while we were hidden, do the one deferred refresh now.
    else { dashHeroStart(); if (DASH_HERO._liveDirty) dashLiveRefresh(); }
  });
  dashHeroStart();
  dashLiveConnect();   // live push — instant updates without a visible refresh
}
function dashHeroStart() {
  dashHeroStop();  // idempotent — clear any stale timers first
  dashHeroRefreshAll();
  DASH_HERO.presence = setInterval(dashHeroLoadPresence, DASH_HERO_INTERVALS.presence);
  DASH_HERO.channels = setInterval(dashChanLoad,         DASH_HERO_INTERVALS.channels);
  DASH_HERO.today    = setInterval(dashHeroLoadToday,    DASH_HERO_INTERVALS.today);
  // Keep the relative "synced Xs ago" stamp ticking between polls.
  DASH_HERO._syncTimer = setInterval(dashRenderSync, 10000);
}
function dashHeroStop() {
  for (const k of ['presence', 'channels', 'today']) {
    if (DASH_HERO[k]) { clearInterval(DASH_HERO[k]); DASH_HERO[k] = null; }
  }
  if (DASH_HERO._syncTimer) { clearInterval(DASH_HERO._syncTimer); DASH_HERO._syncTimer = null; }
}
function dashHeroRefreshAll() {
  dashHeroLoadPresence();
  dashChanLoad();
  dashHeroLoadToday();
}

// ── Live push (SSE) ────────────────────────────────────────────────────────
// Subscribe to the admin-wide live hub (retailLiveSubscribe, 01-core.js). It
// nudges us whenever the tenant's order / customer / wholesale streams move,
// so the recap, the open feed, and Channels-today update the moment something
// happens, with no visible refresh and no per-client polling. The hub also
// nudges once after a reconnect, covering events missed while the socket was
// down; the 60s backstop polls above cover the gap if the hub never connects.
function dashLiveConnect() {
  if (DASH_HERO._sse) return;
  DASH_HERO._sse = retailLiveSubscribe(() => dashLiveNudge());   // holds the unsubscribe fn
}
// Coalesce a burst of nudges into one refresh, and defer while the tab is
// hidden so a returning operator gets a single refresh, not a backlog.
function dashLiveNudge() {
  if (document.hidden) { DASH_HERO._liveDirty = true; return; }
  clearTimeout(DASH_HERO._liveDebounce);
  DASH_HERO._liveDebounce = setTimeout(dashLiveRefresh, 500);
}
function dashLiveRefresh() {
  DASH_HERO._liveDirty = false;
  tdRecapLoad();        // recap summary rows (re-pulls the away window)
  dashChanLoad();       // Channels today
  dashHeroLoadToday();  // today KPIs + sparkline
  if (typeof tdOpsLoad === 'function') tdOpsLoad();  // running-low / needs-you
  tdRecapWorkFetch();   // the open fold, if any (no-op when collapsed)
}
function dashHeroSyncStamp() {
  DASH_HERO.lastSync = Date.now();
  dashRenderSync();
}
// Relative "synced Xs/Xm ago" stamp — re-rendered on each poll and by the 10s
// ticker so it stays honest between polls. Keeps EN free of " · " for the i18n
// splitter.
function dashRenderSync() {
  const el = $('#db-hero-sync'); if (!el || !DASH_HERO.lastSync) return;
  const secs = Math.max(0, Math.round((Date.now() - DASH_HERO.lastSync) / 1000));
  let en, cn;
  if (secs < 8)        { en = 'synced just now';   cn = '刚刚同步'; }
  else if (secs < 60)  { en = `synced ${secs}s ago`; cn = `${secs}秒前同步`; }
  else                 { const m = Math.floor(secs / 60); en = `synced ${m}m ago`; cn = `${m}分钟前同步`; }
  el.textContent = `${en} · ${cn}`;
}

async function dashHeroLoadPresence() {
  try {
    const j = await api('/api/retail-admin/dashboard/presence');
    const d = j.data || {};
    const v = Number(d.viewing || 0);
    // Live presence is a quiet corner line now, not a hero ring: a sage dot,
    // the count, and a label. At zero the count hides (CSS via .is-zero) and
    // the label carries the whole sentence.
    const num = $('#db-live-num');
    if (num) dashCountUp(num, v);   // keep a plain number — rmRenderDash reads it
    const wrap = $('#td-live');
    if (wrap) { wrap.classList.toggle('is-on', v > 0); wrap.classList.toggle('is-zero', v === 0); }
    const lbl = $('#td-live-lbl');
    if (lbl) {
      lbl.textContent = !v
        ? cuT('no one browsing right now', '暂无人浏览')
        : cuT('browsing now', '人正在浏览');
    }
    if (window.rmDashSetLive) rmDashSetLive(v);   // mirror into the mobile hero
    dashHeroSyncStamp();
  } catch (e) { /* silent — next tick retries */ }
}

// Hour marks under the Today day line. The chart has no axes — the big revenue
// number above it is the y-axis — so this is the whole x. Four evenly-spaced
// hour buckets ('HH:00' from the payload) and then "now" at the live end. A
// day-range payload (bucket = 'YYYY-MM-DD') is not a day line, so it paints
// nothing rather than a row of dates.
function tdTodayHours(labels) {
  const el = document.getElementById('td-today-hours'); if (!el) return;
  const hourly = (labels || []).length > 2 && /^\d{2}:\d{2}$/.test(String(labels[0]));
  if (!hourly) { el.textContent = ''; return; }
  const n = labels.length, marks = [];
  for (let i = 0; i < 4; i++) marks.push(labels[Math.round(i * (n - 1) / 4)]);
  marks.push(cuT('now', '此刻'));
  el.innerHTML = marks.map(m => `<span>${m}</span>`).join('');
}

async function dashHeroLoadToday(opts) {
  // Trailing-zero local-day in GZ (+8). Server tolerates same-day from/to and
  // returns 24 hourly trend buckets (revenue + orders) plus deltas-vs-yesterday.
  const todayGz = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  // Manual refresh asks for a slow, zen roll-up; the auto-poller stays snappy.
  const dur = opts && opts.slow ? 2600 : undefined;
  try {
    const j = await api(`/api/retail-admin/dashboard?from=${todayGz}&to=${todayGz}${dashStoreQS()}`);
    const data = j.data || {};
    DASH_HERO.todayData = data;   // stashed so a language toggle can repaint without refetching
    const k = data.kpis || {};
    dashCountUp($('#db-today-rev'), Number(k.revenue || 0), n => '¥' + Math.round(n).toLocaleString(), dur);
    dashCountUp($('#db-today-ord'), Number(k.orders || 0), undefined, dur);
    dashCountUp($('#db-today-new'), Number(k.new_customers || 0), undefined, dur);
    // Intraday sparklines — revenue (focal, breathing dot) and orders (static
    // dot) each plot their per-hour curve so the day's shape reads at a glance.
    // The revenue curve is the Today block's day line; the other two only paint
    // if their (mobile) hosts exist — dashRenderSpark no-ops on a missing node.
    const trend = data.trend || [];
    const labels = trend.map(p => String(p.bucket || ''));
    // pulse=false: a breathing dot means "an automation is live" and its colour
    // is Dusk. The day line is takings, not automation — its tip sits still.
    dashRenderSpark($('#db-today-spark'), trend.map(p => Number(p.revenue || 0)), labels,
                    v => '¥' + Math.round(v).toLocaleString(), false);
    tdTodayHours(labels);   // hour marks under the day line
    dashRenderSpark($('#db-today-ord-spark'), trend.map(p => Number(p.orders || 0)), labels,
                    v => v + ' ' + cuT(v === 1 ? 'order' : 'orders', '单'), false);
    dashRenderSpark($('#db-today-new-spark'), trend.map(p => Number(p.new_customers || 0)), labels,
                    v => v + ' ' + cuT(v === 1 ? 'new customer' : 'new customers', '新客'), false);
    dashHeroTodayRepaint();   // delta badges (language-aware)
  } catch (e) {
    if (!DASH_HERO.todayData) dashBootRetry('today', dashHeroLoadToday);
  }
}

// Repaint the language-dependent bit of the Today mini-row — the delta badges
// (vs a trailing 7-day average). Split from the loader so a language toggle
// reflows the wording + hover chips without refetching (numbers + sparklines
// are language-neutral).
function dashHeroTodayRepaint() {
  const data = DASH_HERO.todayData; if (!data) return;
  const k = data.kpis || {}, b = data.baseline || null;
  dashSetDelta('#db-today-rev-d', b && b.revenue,       Number(k.revenue || 0),       b && b.days, v => '¥' + Math.round(v).toLocaleString());
  // The Today card only carries the revenue delta now (the order / new-customer
  // cells are plain, per the mockup) — but the badge elements may be absent, and
  // dashSetDelta no-ops on a missing selector, so these stay safe if present.
  dashSetDelta('#db-today-ord-d', b && b.orders,        Number(k.orders || 0),        b && b.days, v => dashTrim(v) + ' ' + cuT(v === 1 ? 'order' : 'orders', '单'));
  dashSetDelta('#db-today-new-d', b && b.new_customers, Number(k.new_customers || 0), b && b.days, v => dashTrim(v) + ' ' + cuT(v === 1 ? 'new customer' : 'new customers', '新客'));
  // "vs a typical {weekday}" caption beside the revenue delta — shown only when
  // there's revenue to compare (empty otherwise, so it never reads oddly at ¥0).
  const note = document.getElementById('td-rev-note');
  if (note) {
    if (Number(k.revenue || 0) > 0) {
      const wd = new Date();
      const EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd.getDay()];
      const CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][wd.getDay()];
      note.textContent = cuT(`vs a typical ${EN}`, `对比平常的${CN}`);
    } else { note.textContent = ''; }
  }
  // The day line's hour marks end in "now", which is a word — repaint it.
  tdTodayHours((data.trend || []).map(p => String(p.bucket || '')));
  // The Orders / Customers section vitals this payload also feeds (avg order
  // value, visitors, visits, conversion) — language-aware, so they repaint here.
  if (typeof tdSecPaint === 'function') tdSecPaint();
}
// Integer when whole, else one decimal — keeps "/day" averages readable.
function dashTrim(n) {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);
}
// Delta badge vs the trailing N-day average. Nothing yet today → a calm dash,
// never an alarming ▼100%. No baseline yet (young shop) or activity today but a
// flat-zero recent average → genuinely "new". Otherwise ▲/▼ % vs the average.
// Stashes a language-aware hover chip on the element (el._tip) for the badge
// scrub wired in dashHeroInit.
function dashSetDelta(sel, base, cur, days, fmtAvg) {
  const el = $(sel); if (!el) return;
  el.classList.remove('is-up', 'is-down', 'is-flat');
  el._tip = '';
  if (!cur) {
    el.classList.add('is-flat'); el.textContent = '—';
    el._tip = cuT('none yet today', '今日暂无');
    return;
  }
  if (!base || !days || base.delta == null) {
    el.classList.add('is-up'); el.textContent = '▲ ' + cuT('new', '新');
    el._tip = cuT('no recent baseline', '暂无近期基准');
    return;
  }
  el._tip = cuT(`vs typical day · ${days}-day avg · ${fmtAvg(base.avg)}/day`, `较日常 · 近 ${days} 日均值 · ${fmtAvg(base.avg)}/日`);
  const r = Math.round(base.delta);
  if (r > 0)      { el.classList.add('is-up');   el.textContent = '▲ ' + r + '%'; }
  else if (r < 0) { el.classList.add('is-down'); el.textContent = '▼ ' + Math.abs(r) + '%'; }
  else            { el.classList.add('is-flat'); el.textContent = '±0%'; }
}
// Badge hover → reuse the spark chip to explain the comparison baseline.
function dashDeltaHover(e) {
  const el = e.currentTarget; if (!el._tip) return;
  const tip = dashSparkTipEl(el);
  tip.textContent = el._tip;
  tip.style.left = '50%';
  tip.style.top  = '0';
  tip.classList.add('show');
}
function dashDeltaLeave(e) { dashSparkTipEl(e.currentTarget).classList.remove('show'); }

// ── Interactive sparkline scrub ──────────────────────────────────────────
// Render a sparkline into a wrap and stash its series so a hover can scrub it.
function dashRenderSpark(wrap, vals, labels, fmt, pulse) {
  if (!wrap) return;
  wrap.innerHTML = dashSparkline(vals, { dot: true, pulse: !!pulse });
  wrap._spark = { vals, labels, fmt };
}
// Percent position of point `idx` — shared by the rendered dot and the scrub so
// the dot always lands exactly on the line vertex. Mirrors dashSparkline's math.
function dashSparkPct(vals, idx) {
  const W = 100, H = 24, pad = 2, n = vals.length;
  if (n < 2) return { x: 50, y: 50 };
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals), span = (max - min) || 1;
  return {
    x: (pad + (idx / (n - 1)) * (W - 2 * pad)) / W * 100,
    y: ((H - pad) - ((vals[idx] - min) / span) * (H - 2 * pad)) / H * 100,
  };
}
// One shared tip element, re-parented into whichever host (sparkline wrap or
// delta badge) is currently hovered. A single element means two tips can never
// show at once — moving to another spark relocates the same chip.
let _dashSparkTip = null;
function dashSparkTipEl(host) {
  if (!_dashSparkTip) { _dashSparkTip = document.createElement('div'); _dashSparkTip.className = 'db-spark-tip'; }
  if (_dashSparkTip.parentNode !== host) { _dashSparkTip.classList.remove('show'); host.appendChild(_dashSparkTip); }
  return _dashSparkTip;
}
function dashSparkMove(e) {
  const wrap = e.currentTarget, s = wrap._spark;
  if (!s || !s.vals || s.vals.length < 2) return;
  const rect = wrap.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const idx = Math.round(f * (s.vals.length - 1));
  const p = dashSparkPct(s.vals, idx);
  const dot = wrap.querySelector('.db-spark-dot');
  if (dot) {
    dot.style.left = p.x.toFixed(1) + '%';
    dot.style.top  = p.y.toFixed(1) + '%';
    dot.classList.add('is-active');
  }
  // Anchor the tip inside the wrap with the same % as the dot, so it tracks the
  // data point exactly and is immune to page zoom / fixed-coord drift.
  const tip = dashSparkTipEl(wrap);
  tip.textContent = (s.labels[idx] || '') + ' · ' + s.fmt(s.vals[idx]);
  tip.style.left = p.x.toFixed(1) + '%';
  tip.style.top  = p.y.toFixed(1) + '%';
  // Flip the tip so it stays inside the chart instead of being cropped by the
  // card edge: drop it below a high peak, and anchor it inward near the L/R
  // ends rather than centering it half off-screen.
  let tx = '-50%', ml = 0;
  if (p.x < 16) { tx = '0'; ml = -6; }
  else if (p.x > 84) { tx = '-100%'; ml = 6; }
  let ty = '-100%', mt = -4;
  if (p.y < 38) { ty = '0'; mt = 4; }
  tip.style.transform = 'translate(' + tx + ', ' + ty + ')';
  tip.style.marginTop = mt + 'px';
  tip.style.marginLeft = ml + 'px';
  tip.classList.add('show');
}
function dashSparkLeave(e) {
  const wrap = e.currentTarget, s = wrap._spark;
  const dot = wrap.querySelector('.db-spark-dot');
  if (dot && s && s.vals && s.vals.length >= 2) {
    const p = dashSparkPct(s.vals, s.vals.length - 1);
    dot.style.left = p.x.toFixed(1) + '%';
    dot.style.top  = p.y.toFixed(1) + '%';
    dot.classList.remove('is-active');
  }
  dashSparkTipEl(wrap).classList.remove('show');
}

// ── Shared KPI / chart helpers (fc*) ───────────────────────────────────────
// The dashboard's number / sparkline / delta helpers, re-exported under a
// design-system-neutral name so every tab's KPI strip (Orders, Invoices,
// Customers, …) calls one shared API instead of reaching into dashboard
// internals. Same proven code, neutral name — the .fc-* CSS styles their output
// identically to the dashboard's db-* markup.
const fcMoney       = dashMoney;
const fcNum         = dashNum;
const fcRenderSpark = dashRenderSpark;
const fcSetDelta    = dashSetDelta;
// These four are referenced from inline on*="" handlers in markup, so they must
// be real function declarations (hoisted onto window). A top-level const is not
// resolvable from an inline handler's scope chain.
function fcSparkMove(e)  { return dashSparkMove(e); }
function fcSparkLeave(e) { return dashSparkLeave(e); }
function fcDeltaHover(e) { return dashDeltaHover(e); }
function fcDeltaLeave(e) { return dashDeltaLeave(e); }
// Magnitude-bar rows in the shared .fc-barrow markup (mirror of dashBarRows,
// which emits the dashboard's db-tile-list-row markup).
function fcBarRows(items, opt) {
  const BAR_CAP = 0.85;
  const curve = opt.curve === 'sqrt' ? (x => Math.sqrt(x)) : (x => x);
  const vals = items.map(it => Math.max(0, Number(opt.value(it)) || 0));
  const max = Math.max(1, ...vals);
  return items.map((it, i) => {
    const v = vals[i];
    const mag = v <= 0 ? 0 : curve(Math.min(1, v / max)) * BAR_CAP;
    const zero = v <= 0;
    return `<div class="fc-barrow has-bar${zero ? ' is-zero' : ''}" style="--mag:${mag.toFixed(3)}">`
      + `<span class="name">${escapeHtml(opt.name(it))}</span>`
      + `<span class="val">${opt.display(it)}</span></div>`;
  }).join('');
}

// Channels today — the Activity square's replacement. Today's revenue split
// by channel from /api/retail-admin/sales/summary (same source as the Sales
// overview page; all stores, GZ-local day, no .data wrapper). The activity
// feed itself now lives inside The Recap's "Show the work" fold.
const DASH_CHAN_NAMES = {
  wechat:    ['Mini app', '小程序'],
  web:       ['Web shop', '网上商店'],
  meituan:   ['Meituan', '美团'],
  eleme:     ['Eleme', '饿了么'],
  gzgrocery: ['gzgrocery pickup', 'gzgrocery 提货'],
};
async function dashChanLoad() {
  try {
    const j = await api('/api/retail-admin/sales/summary');
    DASH_HERO.chan = { channels: j.channels || {} };
    dashChanRender();
    dashHeroSyncStamp();
  } catch (e) {
    // Keep the last good split on a poll error; only the first load reports —
    // and even then, one quick retry goes out before "Failed to load" shows.
    if (!DASH_HERO.chan && dashBootRetry('chan', dashChanLoad)) return;
    const host = $('#td-chan-list');
    if (host && !DASH_HERO.chan) host.innerHTML = `<div class="td-muted">${cuT('Failed to load', '加载失败')}</div>`;
  }
}
// Bar rows sorted by revenue, widths as share of today's total. Channels that
// took nothing today stay hidden — a quiet day shows a single line, not a
// column of zeros.
function dashChanRender() {
  const host = $('#td-chan-list'); if (!host || !DASH_HERO.chan) return;
  const ch = DASH_HERO.chan.channels;
  const rows = Object.keys(ch)
    .map(k => ({ key: k, revenue: Number(ch[k].revenue || 0), orders: Number(ch[k].orders || 0) }))
    .filter(r => r.revenue > 0 || r.orders > 0)
    .sort((a, b) => b.revenue - a.revenue);
  if (!rows.length) {
    host.innerHTML = `<div class="td-muted">${cuT('No sales yet today', '今日暂无销售')}</div>`;
    return;
  }
  const total = rows.reduce((s, r) => s + r.revenue, 0) || 1;
  const money = n => '¥' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  host.innerHTML = rows.map(r => {
    const nm = DASH_CHAN_NAMES[r.key] ? cuT(DASH_CHAN_NAMES[r.key][0], DASH_CHAN_NAMES[r.key][1]) : r.key;
    const cnt = cuT(`${r.orders} ${r.orders === 1 ? 'order' : 'orders'}`, `${r.orders} 单`);
    const pct = Math.max(2, Math.round((r.revenue / total) * 100));
    return `<div class="td-chan-row">
      <span class="td-chan-lbl">${escapeHtml(nm)} <span class="td-chan-cnt">${cnt}</span></span>
      <span class="td-chan-val">${money(r.revenue)}</span>
      <span class="td-chan-track"><span class="td-chan-fill" style="width:${pct}%"></span></span>
    </div>`;
  }).join('');
}

// Tacet activity row — clean prose per the dashboard mockup. Returns
// { text, amount, badge }: `text` is the sentence, `amount` is the
// right-aligned money (muted), `badge` a small first-order pill. No icon,
// no bold type-label prefix. Drives the "Show the work" fold rows.
function tdFeedMeta(e) {
  const p = e.payload || {};
  const yuan = n => '¥' + Number(n || 0).toLocaleString();
  const buyer = (p.buyer || '').trim();
  const chan = String(p.channel || '').toLowerCase();
  const chanName = { meituan: 'Meituan', eleme: 'Eleme', gzgrocery: 'Gzgrocery' }[chan];
  const ono = escapeHtml(p.order_no || '');
  const firstBadge = p.first_order
    ? ` <span class="td-feed-badge">${cuT('first order', '首单')}</span>` : '';
  switch (e.type) {
    case 'paid_order': {
      // Named buyer → "{buyer} paid"; an unattributed channel order (e.g.
      // Meituan) → "{Channel} order"; otherwise a plain "Order paid".
      const text = buyer ? cuT(`${escapeHtml(buyer)} paid`, `${escapeHtml(buyer)} 已支付`)
        : (chanName ? cuT(`${chanName} order`, `${cuT(chanName, chanName)}订单`) : cuT('Order paid', '订单已支付'));
      return { text, amount: yuan(p.total), badge: firstBadge };
    }
    case 'order_dispatched':
      return { text: cuT(`${escapeHtml(buyer || ono)} — dispatched`, `${escapeHtml(buyer || ono)} — 已发货`) };
    case 'order_delivered':
      return { text: cuT(`${escapeHtml(buyer || ono)} — delivered`, `${escapeHtml(buyer || ono)} — 已送达`) };
    case 'order_cancelled': {
      const unpaid = p.reason === 'auto_cancelled_unpaid'
        ? ` <span class="td-feed-badge td-feed-badge-mute">${cuT('unpaid', '未付款')}</span>` : '';
      return { text: cuT(`Cancelled — ${ono}`, `已取消 — ${ono}`), amount: p.total ? yuan(p.total) : '', badge: unpaid };
    }
    case 'refund_request':
      return { text: cuT(`Refund requested — ${ono}`, `退款申请 — ${ono}`), amount: p.amount ? yuan(p.amount) : '' };
    case 'refund_paid':
      return { text: cuT(`Refund settled — ${ono}`, `退款完成 — ${ono}`), amount: p.amount ? yuan(p.amount) : '' };
    case 'refund_rejected':
      return { text: cuT(`Refund declined — ${ono}`, `退款驳回 — ${ono}`) };
    case 'topup':
      return { text: buyer ? cuT(`${escapeHtml(buyer)} topped up`, `${escapeHtml(buyer)} 已充值`) : cuT('Wallet top-up', '钱包充值'), amount: yuan(p.amount) };
    case 'new_customer':
      return { text: p.name ? cuT(`${escapeHtml(p.name)} joined`, `${escapeHtml(p.name)} 加入`) : cuT('New customer joined', '新客户加入') };
    case 'feedback':
      return { text: cuT(`Feedback · “${escapeHtml(p.excerpt || '')}”`, `反馈 · “${escapeHtml(p.excerpt || '')}”`) };
    case 'gzgrocery_pickup': {
      const nm = escapeHtml((window.cuLang && cuLang() === 'cn') ? (p.name_cn || p.name_en) : (p.name_en || p.name_cn));
      const u = Math.abs(Number(p.units || 0));
      return p.is_return
        ? { text: cuT(`Gzgrocery return · ${nm}`, `Gzgrocery 退货 · ${nm}`), amount: '−' + yuan(Math.abs(p.owed)) }
        : { text: cuT(`Gzgrocery pickup · ${nm} ×${u}`, `Gzgrocery 提货 · ${nm} ×${u}`), amount: yuan(Math.abs(p.owed)) };
    }
    default:
      return { text: escapeHtml(e.type) };
  }
}

// Clicking an activity row jumps straight to its destination — no
// intermediate detail card. Order-related events open the floating order
// drawer over the dashboard (same target the old "Open in Orders" button
// used); everything else jumps to its owning tab.
function dashFeedClick(row, ev) {
  // This click opens a drawer — keep it from bubbling to the document-level
  // click-outside-to-close handler, which would otherwise shut the drawer the
  // instant it opens.
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const type = row.getAttribute('data-type');
  const refId = row.getAttribute('data-ref-id');

  switch (type) {
    case 'paid_order':
    case 'order_dispatched':
    case 'order_delivered':
    case 'order_cancelled':
    case 'refund_request':
    case 'refund_paid':
    case 'refund_rejected':
      dashOpenOrderFromFeed(refId);
      break;
    case 'topup':
    case 'new_customer':
      dashOpenCustomerFromFeed(refId);
      break;
    case 'low_stock':
    case 'out_of_stock':
      dashOpenProductFromFeed(refId);
      break;
    case 'feedback':
      dashOpenFeedbackFromFeed(refId);
      break;
    case 'gzgrocery_pickup':
      // No per-order page exists (inferred channel) — jump to the Guanyi tab
      // where the billing/analytics for these pickups lives.
      closeDrawer('#db-activity-drawer');
      dashJumpTab('guanyi');
      break;
  }
}

// Jump from a new-customer / top-up activity event straight to that customer's
// detail drawer (same drawer the Customers tab opens), over the dashboard. If
// the id is missing (e.g. a top-up with no linked customer) fall back to the
// Customers tab so the click still lands somewhere sensible.
function dashOpenCustomerFromFeed(customerId) {
  closeDrawer('#db-activity-drawer');
  const id = Number(customerId);
  if (!customerId || Number.isNaN(id) || id <= 0) { dashJumpTab('customers'); return; }
  cuOpenDetail(id);
}

// Jump from a feedback activity event straight to that report: switch to the
// Feedback tab, then scroll to and briefly highlight its row once the table
// has loaded.
function dashOpenFeedbackFromFeed(feedbackId) {
  closeDrawer('#db-activity-drawer');
  dashJumpTab('feedback');
  const id = Number(feedbackId);
  if (!feedbackId || Number.isNaN(id) || id <= 0) return;
  // The tab's first open kicks off an async loadFeedback(); poll briefly for
  // the row to appear, then reveal it.
  let tries = 0;
  const tick = () => {
    const row = document.querySelector(`#feedback-table tbody tr[data-id="${id}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('row-flash');
      setTimeout(() => row.classList.remove('row-flash'), 1600);
      return;
    }
    if (tries++ < 20) setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
}

// Jump from an activity-feed event straight to its order, opened in the
// global order drawer. The main screen STAYS on the Dashboard tab — we do
// NOT switch to Orders. openOrder() fetches the order by id independently of
// the Orders list, so it surfaces in the floating drawer over the dashboard
// with no tab change.
function dashOpenOrderFromFeed(orderId) {
  closeDrawer('#db-activity-drawer');
  if (orderId !== null && orderId !== undefined && orderId !== '') openOrder(orderId);
}

// Jump from a low-stock / out-of-stock activity event straight to that
// product's editor — staying INSIDE this Mini App Backend (no new kitchen-app
// tab). Switch to the Products tab (loading it on first open), then open the
// product the same way a grid card does via paOpenEdit() — which respects the
// catalog mode (self → in-page commercial/stock form; upstream → page designer).
function dashOpenProductFromFeed(productId) {
  if (productId === null || productId === undefined || productId === '') return;
  const id = Number(productId);
  if (Number.isNaN(id) || id <= 0) return;
  closeDrawer('#db-activity-drawer');
  const btn = document.querySelector('.tabs [data-tab="products"]');
  if (btn) btn.click();   // activates Products + triggers paLoad() on first open
  // paLoad() is async; the self-mode editor (pdOpen) needs PA_PRODUCTS populated
  // to find the row. Poll briefly, then open. Upstream mode loads by id and
  // doesn't need the cache, so don't block on it there.
  let tries = 0;
  const tick = () => {
    if (CATALOG_MODE === 'upstream' || (Array.isArray(PA_PRODUCTS) && PA_PRODUCTS.length)) {
      paOpenEdit(id);
      return;
    }
    if (tries++ < 30) { setTimeout(tick, 150); return; }
    paOpenEdit(id);   // give up waiting — open anyway
  };
  tick();
}

// "Open restock" on the Running-low card → jump to the Products tab and land
// pre-filtered on everything that needs buying back (out of stock + low),
// lowest stock first. Reuses the Products page's own quick-filter (PA_STATUS
// 'restock') instead of dumping the operator on the full catalogue. paLoad()
// is async on first open, so poll briefly for the catalogue before applying.
function dashOpenRestock() {
  const btn = document.querySelector('.tabs [data-tab="products"]');
  if (btn) btn.click();   // activates Products + triggers paLoad() on first open
  let tries = 0;
  const tick = () => {
    if (typeof paSetStatus === 'function' && Array.isArray(PA_PRODUCTS) && PA_PRODUCTS.length) {
      if (PA_STATUS !== 'restock') paSetStatus('restock');   // paSetStatus toggles; only set when off
      return;
    }
    if (tries++ < 30) { setTimeout(tick, 150); return; }
  };
  tick();
}

// "Open in Orders" on the Invoices-to-issue card → jump to the Orders tab
// pre-filtered on the "Invoice" chip. The chips are static DOM, so no
// polling is needed — click the tab (fires its own load), then apply the chip
// filter (setOrderStatus reloads with it).
function dashOpenInvoices() {
  const btn = document.querySelector('.tabs [data-tab="orders"]');
  if (btn) btn.click();
  const chip = document.querySelector('#orders-status-chips .status-chip[data-status="needs_invoice"]');
  if (chip && typeof setOrderStatus === 'function' && !chip.classList.contains('active')) setOrderStatus(chip);
}

// Programmatic tab-switch — clicks the tab button so the global switcher
// runs (closes drawers, updates active classes, etc.). Returns true if the
// tab exists, false otherwise — lets callers fall back to a sibling tab.
function dashJumpTab(name) {
  const btn = document.querySelector(`.tabs [data-tab="${name}"]`);
  if (!btn) return false;
  btn.click();
  return true;
}

// ════════════════════════════════════════════════════════════════
// TACET DASHBOARD (td*) — the calm front door. In order:
//   1. The Recap — "While you were away": what the system handled
//      since the operator's last visit (client-side aggregate of
//      /dashboard/activity?since=<last-seen>).
//   2. Needs you — attention cards from /dashboard/ops (delivery
//      problems / refund queue / low stock), rendered ONLY when
//      non-empty; all-clear shows a quiet compliment instead.
//   3. Today — the pulse (revenue/orders/new customers + presence)
//      and the Channels-today split, both handled by dashHero*/dashChan*.
//      The activity feed lives inside The Recap's "Show the work" fold.
// ════════════════════════════════════════════════════════════════

let DASH_OPS = null;


// Pick a product's name in the active UI language, falling back to the
// other language when the preferred one is missing.
function dbProdName(o) {
  const cn = (window.cuLang && cuLang() === 'cn');
  return (cn ? (o.name_cn || o.name_en) : (o.name_en || o.name_cn)) || '—';
}

const TD = { recapSince: 0, recapEvents: null, stores: null, stockStore: '', stockOps: null,
             lowRotAt: 0, _lowRotTimer: null, _lowRotPaused: false, _lowCnt: 0 };
let TD_LOW_POOL = [];   // ordered out-then-low pool the Running-low card rolls through
const TD_SEEN_KEY = 'retail-admin-last-seen';

function tdInit() {
  tdGreetRender();
  tdDateRender();
  tdEnsureStores();   // populate the Running-low store dropdown (multi-store only)
  // Language toggle repaints the JS-built strings (greeting, date, recap, attention).
  if (window.onLangChange) onLangChange(() => { tdGreetRender(); tdDateRender(); tdRecapRender(); tdRecapWorkRender(); tdRecapWorkBtnSync(); tdAttnRender(); tdSecPaint(); dashStockDrawerRender(); });
  tdRecapLoad();     // reads the last-seen stamp BEFORE tdSeenInit overwrites it
  tdSeenInit();
  tdOpsLoad();
  tdSecCountsLoad();
  if (!TD._opsTimer) {
    TD._opsTimer = setInterval(() => { if (!document.hidden) { tdOpsLoad(); tdSecCountsLoad(); } }, 60000);
  }
  // Restore the operator's saved card arrangement, wire drag, and paint the
  // language-aware Arrange chrome. Repaint the chrome + tray on a language flip.
  dashArrangeApply();
  dashArrangeWire();
  dashArrangeChromePaint();
  if (window.onLangChange) onLangChange(dashArrangeChromePaint);
}

// ════════════════════════════════════════════════════════════════
// ARRANGE MODE — the dashboard as the operator's own space.
// Each top-level surface is a .td-block[data-block]; the operator can drag
// them into any order and hide the ones they don't want. The order + hidden
// set persist per user in localStorage (same convention as the Orders /
// Products view tweaks). The dynamic #td-attn card grid keeps rebuilding
// inside its block untouched, so live updates survive any arrangement.
// ════════════════════════════════════════════════════════════════
// Key bumped to -v2 when the dashboard became section blocks: a saved order
// from before names a "revenue" block that no longer exists, and would strand
// the four new blocks at the tail. A fresh key hands everyone the new default
// once; their own arrangement then re-saves over it.
const DASH_LAYOUT_KEY = 'retail-admin-dash-layout-v2';
const DASH_BLOCK_DEFAULT = ['recap', 'needs', 'orders', 'customers', 'inventory', 'delivery', 'channels'];
// Tray-chip / restore labels for each block (bilingual via cuT at paint time).
const DASH_BLOCK_TITLES = {
  recap:     ['While you were away', '您不在的这段时间'],
  needs:     ['Needs you', '需要您处理'],
  orders:    ['Orders', '订单'],
  customers: ['Customers', '客户'],
  inventory: ['Inventory', '库存'],
  delivery:  ['Delivery', '配送'],
  channels:  ['Channels today', '今日渠道'],
};
let DASH_ARRANGING = false;
let _dashDragBlock = null;

function dashLayoutLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(DASH_LAYOUT_KEY) || '{}');
    return { order: Array.isArray(v.order) ? v.order : [], hidden: Array.isArray(v.hidden) ? v.hidden : [] };
  } catch (e) { return { order: [], hidden: [] }; }
}
function dashLayoutSave(order, hidden) {
  try { localStorage.setItem(DASH_LAYOUT_KEY, JSON.stringify({ order, hidden })); } catch (e) {}
}
// Persist whatever the DOM currently shows (order of blocks + which are hidden).
function dashArrangePersist() {
  const host = document.getElementById('td-blocks'); if (!host) return;
  const blocks = [...host.querySelectorAll('.td-block')];
  const order  = blocks.map(b => b.dataset.block);
  const hidden = blocks.filter(b => b.classList.contains('is-hidden')).map(b => b.dataset.block);
  dashLayoutSave(order, hidden);
}

// Reorder the blocks in the DOM to the saved order and apply the hidden set.
// Any block missing from the saved order keeps its markup order at the tail
// (new blocks added in a future release surface rather than vanish).
function dashArrangeApply() {
  const host = document.getElementById('td-blocks'); if (!host) return;
  const { order, hidden } = dashLayoutLoad();
  const seq = (order && order.length) ? order : DASH_BLOCK_DEFAULT;
  seq.forEach(key => {
    const el = host.querySelector(`.td-block[data-block="${key}"]`);
    if (el) host.appendChild(el);   // re-append in saved order
  });
  const hide = new Set(hidden || []);
  host.querySelectorAll('.td-block').forEach(el => {
    el.classList.toggle('is-hidden', hide.has(el.dataset.block));
  });
  dashArrangeTray();
}

// Enter / leave Arrange mode. Blocks become draggable only while arranging;
// leaving saves the layout.
function dashArrangeToggle() {
  DASH_ARRANGING = !DASH_ARRANGING;
  document.body.classList.toggle('td-arranging', DASH_ARRANGING);
  const host = document.getElementById('td-blocks');
  if (host) host.querySelectorAll('.td-block').forEach(b => { b.draggable = DASH_ARRANGING; });
  dashArrangeChromePaint();
  if (!DASH_ARRANGING) dashArrangePersist();
}

// Paint the language-aware Arrange chrome: the button label (Arrange ⇄ Done),
// the hint line, the reset link, and any hidden-card tray chips.
function dashArrangeChromePaint() {
  const lbl = document.getElementById('td-arrange-lbl');
  if (lbl) lbl.textContent = DASH_ARRANGING ? cuT('Done', '完成') : cuT('Arrange', '整理');
  const hint = document.getElementById('td-arrange-hint-txt');
  if (hint) hint.textContent = cuT(
    "Drag cards to reorder. Hide the ones you don't need — they wait in the tray below.",
    '拖动卡片重新排序，隐藏不需要的卡片 — 它们会保存在下方的托盘里。');
  const reset = document.getElementById('td-arrange-reset');
  if (reset) reset.textContent = cuT('Reset to default', '恢复默认');
  dashArrangeTray();
}

function dashArrangeHide(key) {
  const el = document.querySelector(`.td-block[data-block="${key}"]`);
  if (!el) return;
  el.classList.add('is-hidden');
  dashArrangePersist();
  dashArrangeTray();
}
function dashArrangeShow(key) {
  const host = document.getElementById('td-blocks');
  const el = host && host.querySelector(`.td-block[data-block="${key}"]`);
  if (!el) return;
  el.classList.remove('is-hidden');
  host.appendChild(el);   // restored cards land at the end
  dashArrangePersist();
  dashArrangeTray();
}

// Render the hidden-cards tray (a row of "+ add back" chips). The tray only
// shows in Arrange mode (CSS), and only when it has items.
function dashArrangeTray() {
  const tray = document.getElementById('td-tray');
  const row  = document.getElementById('td-tray-row');
  if (!tray || !row) return;
  const hidden = [...document.querySelectorAll('.td-block.is-hidden')].map(b => b.dataset.block);
  tray.classList.toggle('has-items', hidden.length > 0);
  row.innerHTML = hidden.map(key => {
    const t = DASH_BLOCK_TITLES[key];
    const nm = t ? cuT(t[0], t[1]) : key;
    return `<span class="td-chip">${escapeHtml(nm)}`
      + `<button type="button" class="td-chip-add" title="${escapeAttr(cuT('Add back', '恢复'))}" onclick="dashArrangeShow('${key}')">`
      + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></span>`;
  }).join('');
}

// Reset to the shipped default: forget the saved layout, un-hide everything,
// restore the markup order.
function dashArrangeReset() {
  try { localStorage.removeItem(DASH_LAYOUT_KEY); } catch (e) {}
  const host = document.getElementById('td-blocks'); if (!host) return;
  DASH_BLOCK_DEFAULT.forEach(key => {
    const el = host.querySelector(`.td-block[data-block="${key}"]`);
    if (el) { el.classList.remove('is-hidden'); host.appendChild(el); }
  });
  host.querySelectorAll('.td-block').forEach(b => { b.draggable = DASH_ARRANGING; });
  dashArrangeTray();
}

// Does this block share its row with another? Measured, not read off data-span,
// because the responsive rules collapse the narrow spans to full width on small
// screens — a block that spans 3 columns at 1280px spans all 6 at 900px, and the
// drop seam has to follow what the operator actually sees.
function dashBlockShares(block) {
  const host = block.parentElement;
  if (!host) return false;
  return block.offsetWidth < host.clientWidth * 0.9;
}

// ── Drag to reorder (native HTML5 DnD, wired once) ──────────────────────────
function dashArrangeWire() {
  const host = document.getElementById('td-blocks');
  if (!host || host._dndWired) return;
  host._dndWired = true;

  host.addEventListener('dragstart', e => {
    if (!DASH_ARRANGING) return;
    const b = e.target.closest('.td-block');
    if (!b) return;
    _dashDragBlock = b;
    b.classList.add('td-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', b.dataset.block); } catch (err) {}
  });
  host.addEventListener('dragend', () => {
    if (_dashDragBlock) _dashDragBlock.classList.remove('td-dragging');
    dashArrangeClearMarkers();
    _dashDragBlock = null;
    dashArrangePersist();
  });
  host.addEventListener('dragover', e => {
    if (!_dashDragBlock) return;
    e.preventDefault();
    const over = e.target.closest('.td-block');
    dashArrangeClearMarkers();
    if (!over || over === _dashDragBlock || over.classList.contains('is-hidden')) return;
    const r = over.getBoundingClientRect();
    // Full-width blocks read as vertical (before/after = above/below); anything
    // narrower shares its row, so it reads horizontally. The grid is six columns
    // wide, so "full width" is span 6.
    const horizontal = dashBlockShares(over);
    const after = horizontal ? (e.clientX - r.left) > r.width / 2 : (e.clientY - r.top) > r.height / 2;
    over.classList.add(after ? 'td-drop-after' : 'td-drop-before');
  });
  host.addEventListener('drop', e => {
    if (!_dashDragBlock) return;
    e.preventDefault();
    const over = e.target.closest('.td-block');
    if (!over || over === _dashDragBlock) { dashArrangeClearMarkers(); return; }
    const r = over.getBoundingClientRect();
    const horizontal = dashBlockShares(over);
    const after = horizontal ? (e.clientX - r.left) > r.width / 2 : (e.clientY - r.top) > r.height / 2;
    if (after) over.after(_dashDragBlock); else over.before(_dashDragBlock);
    dashArrangeClearMarkers();
    dashArrangePersist();
  });
}
function dashArrangeClearMarkers() {
  document.querySelectorAll('.td-block.td-drop-before, .td-block.td-drop-after')
    .forEach(b => b.classList.remove('td-drop-before', 'td-drop-after'));
}

// Load the store list once so the Running-low card can offer a per-store filter.
// Single-store tenants get no dropdown (nothing to choose).
async function tdEnsureStores() {
  if (TD.stores) return;
  try {
    const r = await api('/api/retail-admin/stores');
    TD.stores = r.data || [];
  } catch (e) { TD.stores = []; }
  if (TD.stores.length >= 2 && DASH_OPS) tdAttnRender();  // reveal the dropdown once stores arrive
}

// The store <select> shown in the Running-low card header (Option A). Rebuilt
// on each render so the label follows the active language and current pick.
function tdStoreSelectHtml() {
  const cn = window.cuLang && cuLang() === 'cn';
  const opts = ['<option value="">' + cuT('All stores', '全部门店') + '</option>']
    .concat((TD.stores || []).map(s => {
      const nm = cn ? (s.name_cn || s.name_en || s.code) : (s.name_en || s.code);
      const sel = String(s.id) === String(TD.stockStore) ? ' selected' : '';
      return `<option value="${escapeAttr(String(s.id))}"${sel}>${escapeHtml(nm || ('#' + s.id))}</option>`;
    })).join('');
  return `<select class="td-store-sel" onchange="tdStockStoreChange(this.value)" aria-label="${escapeAttr(cuT('Filter stock by store', '按门店筛选库存'))}">${opts}</select>`;
}
// Name of the currently-selected store (for the "and N more at <store>" tail).
function tdStockStoreName() {
  if (!TD.stockStore) return '';
  const cn = window.cuLang && cuLang() === 'cn';
  const s = (TD.stores || []).find(x => String(x.id) === String(TD.stockStore));
  return s ? (cn ? (s.name_cn || s.name_en || s.code) : (s.name_en || s.code)) : '';
}
// A store pick re-pulls ops so the Running-low card reflects that shelf.
// The stock drawer shares the same pick (its dropdown calls this too), so an
// open drawer re-pulls its full list as well — both surfaces stay in step.
function tdStockStoreChange(v) {
  TD.stockStore = v || '';
  tdOpsLoad();
  const d = document.getElementById('db-stock-drawer');
  if (d && d.classList.contains('open')) dashStockDrawerLoad();
}

// ── Greeting title (Option B) ────────────────────────────────────────────────
// The page heading greets the signed-in operator by name — "Good morning,
// Asher" — instead of a flat "Dashboard". The name comes from the account
// menu's resolved user (ACCT_USER, set by initAcctMenu in 02-settings-ops.js);
// same file scope, read at paint time so it's populated by then. Language-aware
// (cuT) and repainted on a language flip and again when the account resolves.

// First name for the greeting: Latin names → first word; CJK → the whole
// (given) name. Empty when no user has resolved yet, which drops the name from
// the line rather than showing a placeholder.
function tdGreetName() {
  const u = (typeof ACCT_USER !== 'undefined') ? ACCT_USER : null;
  const src = String((u && (u.displayName || u.username)) || '').trim();
  if (!src) return '';
  return /^[\x00-\x7F]+$/.test(src) ? src.split(/\s+/)[0] : src;
}

// The greeting line: weekend overrides the time-of-day band. Bands mirror the
// mockup (05–11 morning · 11–17 afternoon · 17–22 evening · 22–05 late).
function tdGreetLine() {
  const name = tdGreetName();
  const nm = name ? ', ' + name : '', nmCn = name ? '，' + name : '';
  const d = new Date(), day = d.getDay(), h = d.getHours();
  if (day === 0 || day === 6) return cuT(`Happy weekend${nm}`, `周末愉快${nmCn}`);
  if (h >= 5  && h < 11) return cuT(`Good morning${nm}`,   `早上好${nmCn}`);
  if (h >= 11 && h < 17) return cuT(`Good afternoon${nm}`, `下午好${nmCn}`);
  if (h >= 17 && h < 22) return cuT(`Good evening${nm}`,   `晚上好${nmCn}`);
  return name ? cuT(`Still up, ${name}?`, `还没休息${nmCn}？`) : cuT('Still up?', '还没休息?');
}

// Paint the greeting heading + the quiet "Here's your {weekday}." sub-line.
function tdGreetRender() {
  const el = document.getElementById('td-greeting'); if (!el) return;
  el.textContent = tdGreetLine();
  const sub = document.getElementById('td-greet-sub');
  if (sub) {
    const d = new Date();
    const EN = DASH_DOW_EN[d.getDay()];
    const CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    sub.textContent = cuT(`Here's your ${EN}.`, `这是你的${CN}。`);
  }
}

// Today's date under the page title — the calm anchor for "Today" numbers.
function tdDateRender() {
  const el = document.getElementById('td-date'); if (!el) return;
  const d = new Date();
  if (window.cuLang && cuLang() === 'cn') {
    const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    el.textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${DOW[d.getDay()]}`;
  } else {
    el.textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
}

// ── Last-seen stamp — feeds The Recap's "while you were away" window. ──────
// Stamped when the tab hides / unloads, plus a 60s heartbeat while visible so
// a crash still leaves a recent mark. tdRecapLoad reads the PREVIOUS stamp at
// boot before this starts writing, so the window is [last departure → now].
function tdSeenInit() {
  if (TD._seenWired) return;
  TD._seenWired = true;
  const stamp = () => { try { localStorage.setItem(TD_SEEN_KEY, String(Date.now())); } catch (e) {} };
  document.addEventListener('visibilitychange', () => { if (document.hidden) stamp(); });
  window.addEventListener('pagehide', stamp);
  setInterval(() => { if (!document.hidden) stamp(); }, 60000);
  stamp();
}

// ── The Recap ──────────────────────────────────────────────────────────────
async function tdRecapLoad() {
  const host = document.getElementById('td-recap-rows'); if (!host) return;
  let since = 0;
  try { since = parseInt(localStorage.getItem(TD_SEEN_KEY) || '0', 10) || 0; } catch (e) {}
  const now = Date.now();
  const MAX_BACK = 7 * 86400000;   // server-friendly cap for a long absence
  const MIN_BACK = 30 * 60000;     // a quick reload still gets a real window
  const REAL_ABSENCE = 25 * 60000; // under this you never really left — a reload
                                   // or a tab-switch, not a departure
  // Did the operator GENUINELY step away? Needs a real prior stamp and a true
  // gap long enough to count as leaving — measured BEFORE the MIN_BACK floor,
  // which otherwise fakes a 30-min window on every load. Drives the framing:
  // no real absence ⇒ no "while you were away" / "you left here" story, just
  // a calm recent-activity digest of the same window.
  TD.reallyAway = !!since && (now - since >= REAL_ABSENCE) && (now - since <= MAX_BACK);
  if (!since || now - since > MAX_BACK) since = now - MAX_BACK;
  if (now - since < MIN_BACK) since = now - MIN_BACK;
  TD.recapSince = since;
  try {
    const j = await api(`/api/retail-admin/dashboard/activity?since=${since}&limit=500`);
    TD.recapEvents = (j.data && j.data.events) || [];
    tdRecapRender();
  } catch (e) {
    if (!TD.recapEvents && dashBootRetry('recap', tdRecapLoad)) return;
    host.innerHTML = `<div class="td-muted">${cuT('Failed to load', '加载失败')}</div>`;
  }
}

// "since yesterday 22:41" — the recap window's opening edge, in local time.
function tdSinceLabel(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const dayMs = 86400000;
  const dayDiff = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate())
    - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / dayMs);
  if (dayDiff <= 0) return cuT(`since ${hm}`, `自今天 ${hm}`);
  if (dayDiff === 1) return cuT(`since yesterday ${hm}`, `自昨天 ${hm}`);
  return cuT(`since ${d.getMonth() + 1}/${d.getDate()} ${hm}`, `自${d.getMonth() + 1}月${d.getDate()}日 ${hm}`);
}

// "last 30 minutes" — the meta edge when there was NO real absence, so the card
// never claims a departure that didn't happen. Reads the actual window rather
// than hardcoding the floor.
function tdRecentLabel(ms) {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000));
  return cuT(`last ${mins} minutes`, `最近 ${mins} 分钟`);
}

// Aggregate the recap window's events into calm one-line rows, each with a
// breathing Dusk dot — Dusk means "the system did this", and this card is the
// only place on the dashboard that uses it.
function tdRecapRender() {
  const host = document.getElementById('td-recap-rows'); if (!host || !TD.recapEvents) return;
  const title = document.getElementById('td-recap-title');
  if (title) title.textContent = TD.reallyAway
    ? cuT('While you were away', '您不在的这段时间')
    : cuT('Latest activity', '最新动态');
  const meta = document.getElementById('td-recap-meta');
  if (meta) meta.textContent = TD.reallyAway ? tdSinceLabel(TD.recapSince) : tdRecentLabel(TD.recapSince);
  const ev = TD.recapEvents;
  const of = type => ev.filter(e => e.type === type);
  const sumAmt = (rows, k) => rows.reduce((s, e) => s + (Number(e.payload && e.payload[k]) || 0), 0);
  const money = n => '¥' + Math.round(n).toLocaleString();

  const paid       = of('paid_order');
  const dispatched = of('order_dispatched');
  const delivered  = of('order_delivered');
  const autoCanc   = of('order_cancelled').filter(e => e.payload && e.payload.reason === 'auto_cancelled_unpaid');
  const refunded   = of('refund_paid');
  const newCust    = of('new_customer');
  const topups     = of('topup');
  const pickups    = of('gzgrocery_pickup').filter(e => !(e.payload && e.payload.is_return));

  const rows = [];
  const push = (en, cn) => rows.push(`<div class="td-recap-row"><span class="td-dusk-dot" aria-hidden="true"></span><span>${cuT(en, cn)}</span></div>`);
  if (paid.length)       push(`<b>${paid.length}</b> ${paid.length === 1 ? 'order' : 'orders'} paid — ${money(sumAmt(paid, 'total'))}`,
                              `<b>${paid.length}</b> 笔订单已支付，共 ${money(sumAmt(paid, 'total'))}`);
  if (dispatched.length) push(`<b>${dispatched.length}</b> ${dispatched.length === 1 ? 'order' : 'orders'} dispatched`,
                              `<b>${dispatched.length}</b> 个订单已发货`);
  if (delivered.length)  push(`<b>${delivered.length}</b> ${delivered.length === 1 ? 'order' : 'orders'} delivered`,
                              `<b>${delivered.length}</b> 个订单已送达`);
  if (autoCanc.length)   push(`<b>${autoCanc.length}</b> unpaid ${autoCanc.length === 1 ? 'order' : 'orders'} cancelled automatically`,
                              `<b>${autoCanc.length}</b> 个未付款订单已自动取消`);
  if (refunded.length)   push(`<b>${refunded.length}</b> ${refunded.length === 1 ? 'refund' : 'refunds'} settled — ${money(sumAmt(refunded, 'amount'))}`,
                              `<b>${refunded.length}</b> 笔退款已完成，共 ${money(sumAmt(refunded, 'amount'))}`);
  if (topups.length)     push(`<b>${topups.length}</b> wallet ${topups.length === 1 ? 'top-up' : 'top-ups'} — ${money(sumAmt(topups, 'amount'))}`,
                              `<b>${topups.length}</b> 笔钱包充值，共 ${money(sumAmt(topups, 'amount'))}`);
  if (newCust.length)    push(`<b>${newCust.length}</b> new ${newCust.length === 1 ? 'customer' : 'customers'} joined`,
                              `新增 <b>${newCust.length}</b> 位客户`);
  if (pickups.length)    push(`<b>${pickups.length}</b> gzgrocery ${pickups.length === 1 ? 'pickup' : 'pickups'} recorded`,
                              `记录 <b>${pickups.length}</b> 笔 gzgrocery 提货`);

  const close = document.getElementById('td-recap-close');
  if (!rows.length) {
    host.innerHTML = `<div class="td-recap-quiet">${TD.reallyAway
      ? cuT('All quiet while you were away.', '您不在时，一切平静。')
      : cuT('All quiet just now.', '目前一切平静。')}</div>`;
    if (close) close.hidden = true;
    return;
  }
  host.innerHTML = rows.join('');
  if (close) {
    close.textContent = cuT("Handled quietly. You're welcome.", '一切已悄然处理，不用谢。');
    close.hidden = false;
  }
}

// "Show the work" — the silent system is never secretive: the banner unfolds
// in place into the real feed. The away window's events sit tinted dusk above
// a "you left here" line, the rest of today below; every row drills through
// to its order / customer / product via dashFeedClick.
async function tdRecapToggleWork() {
  const fold = document.getElementById('td-recap-work'); if (!fold) return;
  if (!fold.hidden) { fold.hidden = true; tdRecapWorkBtnSync(); return; }
  fold.hidden = false;
  tdRecapWorkBtnSync();
  fold.innerHTML = `<div class="td-muted">${cuT('Loading…', '加载中…')}</div>`;
  await tdRecapWorkFetch();
}

// Pull today's events (server window = since GZ-midnight) merged with the
// recap window's (which can reach back days) — deduped, newest first — and
// render the fold. Shared by the toggle (first open) and the live refresh (a
// push nudge while the fold is open), so the two can never drift. A live
// refresh keeps the operator's scroll position instead of jumping to the top.
async function tdRecapWorkFetch() {
  const fold = document.getElementById('td-recap-work');
  if (!fold || fold.hidden) return;
  try {
    const j = await api('/api/retail-admin/dashboard/activity?limit=500');
    const today = (j.data && j.data.events) || [];
    const idOf = e => `${e.type}-${e.ref_type}-${e.ref_id}-${e.ts}`;
    const seen = new Set(); const all = [];
    for (const e of (TD.recapEvents || []).concat(today)) {
      const id = idOf(e); if (seen.has(id)) continue;
      seen.add(id); all.push(e);
    }
    all.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    TD.workEvents = all;
    const keepTop = fold.scrollTop;
    tdRecapWorkRender();
    fold.scrollTop = keepTop;
  } catch (e) {
    if (!TD.workEvents) fold.innerHTML = `<div class="td-muted">${cuT('Failed to load', '加载失败')}</div>`;
  }
}

// "you left here — 06:49" — the fold's boundary label, with the day spelled
// out when the operator has been away past midnight. Em dash, not " · ", so
// the i18n walker never mistakes the finished string for an EN·CN pair.
function tdLeftLineLabel() {
  const d = new Date(TD.recapSince || 0);
  const pad = n => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const dayDiff = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate())
    - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (dayDiff <= 0) return cuT(`you left here — ${hm}`, `您离开时 — ${hm}`);
  if (dayDiff === 1) return cuT(`you left yesterday — ${hm}`, `您昨天 ${hm} 离开`);
  return cuT(`you left ${d.getMonth() + 1}/${d.getDate()} — ${hm}`, `您于${d.getMonth() + 1}月${d.getDate()}日 ${hm} 离开`);
}

// Fold body — day headers when the window spans days, dusk tint on rows in
// the away window, the "you left here" line at the boundary.
function tdRecapWorkRender() {
  const fold = document.getElementById('td-recap-work');
  if (!fold || fold.hidden || !TD.workEvents) return;
  const evs = TD.workEvents;
  if (!evs.length) {
    fold.innerHTML = `<div class="td-muted">${cuT('Nothing yet today', '今日暂无动态')}</div>`;
    return;
  }
  const pad = n => String(n).padStart(2, '0');
  const cn = window.cuLang && cuLang() === 'cn';
  const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const multiDay = new Set(evs.map(e => new Date(e.ts).toDateString())).size > 1;
  const since = TD.recapSince || 0;
  // Only split the feed into an "away" band when the operator genuinely left.
  // A quick reload / tab-switch shows a plain reverse-chron feed, no boundary.
  const hasAway = TD.reallyAway && evs.some(e => new Date(e.ts).getTime() >= since);
  let html = '', lastDay = '', lineDone = false;
  for (const e of evs) {
    const ts = new Date(e.ts);
    const away = TD.reallyAway && ts.getTime() >= since;
    if (multiDay) {
      const dayKey = ts.toDateString();
      if (dayKey !== lastDay) {
        lastDay = dayKey;
        const dayLbl = cn
          ? `${ts.getMonth() + 1}月${ts.getDate()}日 ${DOW[ts.getDay()]}`
          : ts.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        html += `<div class="td-drawer-day">${escapeHtml(dayLbl)}</div>`;
      }
    }
    if (!away && !lineDone && hasAway) {
      html += `<div class="td-left-line">${escapeHtml(tdLeftLineLabel())}</div>`;
      lineDone = true;
    }
    const m = tdFeedMeta(e);
    html += `<div class="td-feed-row${away ? ' td-work-away' : ''}" data-type="${escapeHtml(e.type)}" data-ref-id="${escapeHtml(e.ref_id == null ? '' : e.ref_id)}" onclick="dashFeedClick(this, event)">
      <span class="db-feed-ts">${pad(ts.getHours())}:${pad(ts.getMinutes())}</span>
      <span class="td-feed-text">${m.text}</span>
      ${m.badge || ''}
      ${m.amount ? `<span class="td-feed-amt">${m.amount}</span>` : ''}
    </div>`;
  }
  fold.innerHTML = html;
}

// Keep the header button's label in step with the fold's state.
function tdRecapWorkBtnSync() {
  const btn = document.getElementById('td-recap-work-btn'); if (!btn) return;
  const fold = document.getElementById('td-recap-work');
  const open = !!(fold && !fold.hidden);
  btn.textContent = open ? cuT('Hide the work ▴', '收起明细 ▴') : cuT('Show the work ▾', '查看明细 ▾');
}

// ── Needs you — attention cards from /dashboard/ops ────────────────────────
async function tdOpsLoad() {
  try {
    // preview=TD_LOW_PREVIEW gives the Running-low card a deep-enough pool for
    // its rolling window to cycle through the whole low/out list, not just 8.
    const opsQS = [dashStoreQS().replace(/^&/, ''), `preview=${TD_LOW_PREVIEW}`].filter(Boolean).join('&');
    const j = await api(`/api/retail-admin/dashboard/ops?${opsQS}`);
    DASH_OPS = j.data || null;
    // A store picked on the Running-low card → also pull that shelf's stock so
    // the card shows the store's own low/out items (delivery + refunds stay
    // all-stores). Cleared back to all-stores when the pick is reset.
    if (TD.stockStore) {
      try {
        const j2 = await api(`/api/retail-admin/dashboard/ops?store_id=${encodeURIComponent(TD.stockStore)}&preview=${TD_LOW_PREVIEW}`);
        TD.stockOps = j2.data || null;
      } catch (e) { TD.stockOps = null; }
    } else {
      TD.stockOps = null;
    }
    tdAttnRender();
    tdSecPaint();
  } catch (e) {
    if (!DASH_OPS) dashBootRetry('ops', tdOpsLoad);   // else next 60s tick retries
  }
}

// ── Section summary blocks (td-sec-*) ──────────────────────────────────────
// Each block answers one question about one section of the admin: how is it
// doing (the vitals) and does it need me (the footer's single attention line).
// Nothing here fetches the numbers twice — the vitals come from the Today
// payload dashHeroLoadToday already holds, the stock counts from the same
// /dashboard/ops snapshot the "Needs you" cards use, and the order queues from
// one cheap /order-status-counts call (the strip on the Orders page uses it too).
let TD_SEC_COUNTS = null;

async function tdSecCountsLoad() {
  try {
    const j = await api('/api/retail-admin/order-status-counts' + dashStoreQS().replace(/^&/, '?'));
    TD_SEC_COUNTS = j.data || null;
    tdSecPaint();
  } catch (e) { /* silent — the 60s tick retries; the footer just stays quiet */ }
}

// One text node per attention item, in the order an operator would work them.
// `href` is a thunk so the deep link runs on click, not at build time.
function tdSecFootHtml(items) {
  const live = items.filter(it => it.n > 0);
  if (!live.length) {
    return `<span class="td-sec-dot is-clear"></span>${escapeHtml(cuT('Nothing waiting.', '暂无待办。'))}`;
  }
  const sep = '<span class="td-sec-sep">·</span>';
  return `<span class="td-sec-dot"></span>` + live.map(it =>
    `<button type="button" class="td-sec-link" onclick="${it.go}">${escapeHtml(it.label(it.n))}</button>`
  ).join(sep);
}

// Jump to the Orders tab and apply one of its status chips. The chips are
// static DOM, so no polling — click the tab, then the chip (which reloads the
// list with the filter). Mirrors dashOpenInvoices, generalised to any status.
function tdSecOpenOrders(status) {
  dashJumpTab('orders');
  const chip = document.querySelector(`#orders-status-chips .status-chip[data-status="${status}"]`);
  if (chip && typeof setOrderStatus === 'function' && !chip.classList.contains('active')) setOrderStatus(chip);
}

function tdSecPaint() {
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

  // ── Orders + Customers vitals from the Today payload ──
  // The headline numbers (#db-today-ord / -rev / -new) are owned by
  // dashHeroLoadToday's count-up; we only fill the ones it doesn't touch.
  const today = (DASH_HERO && DASH_HERO.todayData) || null;
  if (today) {
    const k = today.kpis || {};
    const aov = Number(k.aov || 0);
    set('td-sec-aov', aov ? '¥' + (Math.round(aov * 100) / 100).toLocaleString() : '¥—');
    const visitors = Number(k.visitors || 0);
    set('td-sec-visitors', visitors
      ? cuT(`of ${visitors.toLocaleString()} visitors`, `共 ${visitors.toLocaleString()} 访客`)
      : cuT('no visitors yet', '暂无访客'));
    set('td-sec-visits', Number(k.visits || 0).toLocaleString());
    const sessions = Number(k.sessions || 0);
    set('td-sec-sessions', sessions
      ? sessions.toLocaleString() + ' ' + cuT('sessions', '会话')
      : cuT('no data yet', '暂无数据'));
    set('td-sec-conv', k.conversion_rate == null ? '—' : Number(k.conversion_rate).toFixed(1) + '%');
    // Refunds — the only number in the Today strip that is money leaving. On a
    // good day it reads 0 and says so plainly rather than showing a rate of 0%.
    const refunded = Number(k.refunded_orders || 0);
    set('td-today-refunded', String(refunded));
    set('td-today-refund-rate', refunded
      ? cuT(`${Number(k.refund_rate || 0).toFixed(1)}% of orders`, `占订单 ${Number(k.refund_rate || 0).toFixed(1)}%`)
      : cuT('nothing sent back', '无退款'));
  }

  // ── Inventory vitals from the ops snapshot ──
  const oos = ((DASH_OPS || {}).out_of_stock || {}).count || 0;
  const low = ((DASH_OPS || {}).low_stock || {}).count || 0;
  if (DASH_OPS) { set('td-sec-oos', String(oos)); set('td-sec-low', String(low)); }

  // ── Delivery vitals from the order status counts ──
  const c = TD_SEC_COUNTS || {};
  if (TD_SEC_COUNTS) {
    set('td-sec-dispatched', String(Number(c.dispatched || 0)));
    set('td-sec-riderpickup', String(Number(c.rider_pickup || 0)));
  }

  // ── The three attention lines ──
  // Orders: only what an operator clears by hand, in the order they'd do it.
  const ordersFoot = document.getElementById('td-sec-orders-foot');
  if (ordersFoot && TD_SEC_COUNTS) {
    ordersFoot.innerHTML = tdSecFootHtml([
      // Paid and untouched — nobody has started it yet. This is the most urgent
      // thing on the page and it had no home until now: the operator saw
      // "preparing" but never the orders waiting to BE prepared.
      { n: Number(c.paid || 0),             go: "tdSecOpenOrders('paid')",             label: n => cuT(`${n} to start`, `${n} 单待处理`) },
      { n: Number(c.preparing || 0),        go: "tdSecOpenOrders('preparing')",        label: n => cuT(`${n} preparing`, `${n} 单备货中`) },
      { n: Number(c.awaiting_restock || 0), go: "tdSecOpenOrders('awaiting_restock')", label: n => cuT(`${n} awaiting restock`, `${n} 单待补货`) },
      { n: Number(c.refunds_open || 0),     go: "tdSecOpenOrders('refunds_open')",     label: n => cuT(`${n} in the refund queue`, `${n} 单待退款`) },
      { n: Number(c.needs_invoice || 0),    go: "dashOpenInvoices()",                  label: n => cuT(`${n} ${n === 1 ? 'invoice' : 'invoices'} to issue`, `${n} 张待开票`) },
    ]);
  }

  // Inventory: out-of-stock is the emergency; low stock is the nudge. Either
  // way the line ends on the restock deep link.
  const invFoot = document.getElementById('td-sec-inventory-foot');
  if (invFoot && DASH_OPS) {
    invFoot.innerHTML = (oos + low) === 0
      ? `<span class="td-sec-dot is-clear"></span>${escapeHtml(cuT('Everything is stocked.', '库存充足。'))}`
      : `<span class="td-sec-dot"></span>`
        + (oos ? `<button type="button" class="td-sec-link" onclick="dashStockDrawerOpen(event)">${escapeHtml(cuT(`${oos} out of stock`, `${oos} 项已售罄`))}</button><span class="td-sec-sep">·</span>` : '')
        + `<button type="button" class="td-sec-link" onclick="dashOpenRestock()">${escapeHtml(cuT('Open restock', '前往补货'))}</button>`;
  }

  // Delivery: the carrier's own "needs a call" flags — the same signal the
  // brick attention card raises, said in one line.
  const delFoot = document.getElementById('td-sec-delivery-foot');
  if (delFoot && DASH_OPS) {
    const alerts = ((DASH_OPS.delivery_alerts || {}).count) || 0;
    delFoot.innerHTML = alerts === 0
      ? `<span class="td-sec-dot is-clear"></span>${escapeHtml(cuT('Every delivery is on track.', '配送一切正常。'))}`
      : `<span class="td-sec-dot"></span><button type="button" class="td-sec-link" onclick="tdSecOpenOrders('dispatched')">${escapeHtml(cuT(`${alerts} ${alerts === 1 ? 'delivery needs' : 'deliveries need'} a call`, `${alerts} 单配送需要联系`))}</button>`;
  }
}

// Tone-coloured line icons for the attention-card headers (24-box, currentColor
// so the .td-ic-<tone> class tints them to the card's ink), matching the mockup.
const TD_ATTN_ICON = {
  box:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  truck: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35a1 1 0 0 0-.78-.38H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>',
  refund:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>',
  invoice:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
};
function tdAttnCard(tone, icon, title, count, rowsHtml, moreText, action, headerCtrl) {
  return `<section class="card td-card td-attn-card is-${tone}">
    <div class="td-attn-head">
      <span class="td-attn-ic td-ic-${tone}" aria-hidden="true">${TD_ATTN_ICON[icon] || ''}</span>
      <h3>${title}</h3>
      ${headerCtrl || ''}
      ${count === '' ? '' : `<span class="td-pill td-pill-${tone}">${count}</span>`}
    </div>
    <div class="td-attn-rows">${rowsHtml}</div>
    ${moreText ? `<div class="td-attn-more">${moreText}</div>` : ''}
    ${action || ''}
  </section>`;
}

// ── Running-low rolling window ─────────────────────────────────────────────
// The card is a glanceable slice of a long list (often many out + many low).
// Rather than freeze on the alphabetical first 4, it pages through the WHOLE
// fetched pool a window at a time, cross-fading, so the full picture rolls by
// without a click. Out-of-stock rows come first in the pool, then low ones.
// Pauses while the pointer/focus is on the card (so a row never moves out from
// under a tap), and stays still entirely for prefers-reduced-motion.
const TD_LOW_PREVIEW = 40;   // how many items to pull for the pool (counts stay exact)
const TD_LOW_WIN     = 4;    // rows visible per window
const TD_LOW_ROT_MS  = 7000; // dwell per window before the next cross-fade

// One pool row → button HTML, label computed live so a language toggle repaints.
function tdLowRowHtml(it) {
  const val = it._oos ? cuT('out', '售罄')
                      : cuT(`${it.stock_qty} left`, `剩 ${it.stock_qty}`);
  return `
    <button type="button" class="td-attn-row"${it.id ? ` onclick="dashOpenProductFromFeed(${Number(it.id)})"` : ''}>
      <span class="name"><span class="nm" data-no-i18n>${escapeHtml(dbProdName(it))}</span>${it.sku ? `<span class="sku" data-no-i18n>${escapeHtml(it.sku)}</span>` : ''}</span>
      <span class="val">${val}</span>
    </button>`;
}
// The window starting at TD.lowRotAt (paged, non-wrapping — loops back to 0).
function tdLowWindowHtml() {
  const pool = TD_LOW_POOL || [];
  return pool.slice(TD.lowRotAt, TD.lowRotAt + TD_LOW_WIN).map(tdLowRowHtml).join('');
}
// Live "5–8 of 32" position label for the more-link (also the see-all handle).
function tdLowPosText() {
  const pool = TD_LOW_POOL || [];
  const cnt = TD._lowCnt || pool.length;
  const s = TD.lowRotAt, e = Math.min(s + TD_LOW_WIN, pool.length);
  return cuT(`${s + 1}–${e} of ${cnt} · see all`, `第 ${s + 1}–${e} · 共 ${cnt} · 查看全部`);
}
function tdLowPause()  { TD._lowRotPaused = true; }
function tdLowResume() { TD._lowRotPaused = false; }
function tdLowRotStop() {
  if (TD._lowRotTimer) { clearInterval(TD._lowRotTimer); TD._lowRotTimer = null; }
}
// Advance one window with an opacity cross-fade. Re-grabs the rows node inside
// the fade so a mid-cycle re-render (SSE / poll) can't write to a stale node.
function tdLowRotTick() {
  const pool = TD_LOW_POOL || [];
  if (pool.length <= TD_LOW_WIN || TD._lowRotPaused || document.hidden) return;
  const box = document.getElementById('td-low-rows'); if (!box) return;
  let next = TD.lowRotAt + TD_LOW_WIN;
  if (next >= pool.length) next = 0;
  box.style.opacity = '0';
  setTimeout(() => {
    TD.lowRotAt = next;
    const b = document.getElementById('td-low-rows'); if (!b) return;
    b.innerHTML = tdLowWindowHtml();
    b.style.opacity = '1';
    const pos = document.getElementById('td-low-pos');
    if (pos) pos.textContent = tdLowPosText();
  }, 220);
}
// Restarted at the tail of every tdAttnRender (the rows node is recreated then).
function tdLowRotStart() {
  tdLowRotStop();
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pool = TD_LOW_POOL || [];
  if (reduce || pool.length <= TD_LOW_WIN) return;
  TD._lowRotTimer = setInterval(tdLowRotTick, TD_LOW_ROT_MS);
}

// ── The Running-low list, inside the Inventory block ───────────────────────
// It was an attention card in "Needs you"; its count only ever repeated the
// Inventory block's own number. The list is worth keeping — it is the one
// place on the dashboard that names products — so it lives under the numbers
// it describes. Everything stocked → the node renders nothing and is hidden,
// and the block is just its two vitals and a sage footer.
// Reuses the same rolling window (#td-low-rows) and store filter as before.
function tdInvLowRender() {
  const host = document.getElementById('td-inv-low'); if (!host) return;
  TD_LOW_POOL = [];
  const hide = () => { host.hidden = true; host.innerHTML = ''; tdLowRotStop(); };
  if (!DASH_OPS || !dashPosWants('stock')) return hide();

  const allLow = ((DASH_OPS.low_stock || {}).count || 0) + ((DASH_OPS.out_of_stock || {}).count || 0);
  if (!allLow) return hide();

  // The counts above are all-stores (so the list appears whenever ANY store is
  // short); the rows honour the store picked in the header dropdown.
  const src = (TD.stockStore && TD.stockOps) ? TD.stockOps : DASH_OPS;
  const low = src.low_stock || { count: 0, items: [] };
  const oos = src.out_of_stock || { count: 0, items: [] };
  const cnt = low.count + oos.count;
  const storeSel = (TD.stores && TD.stores.length >= 2 && !window.RA_STORE_LOCK) ? tdStoreSelectHtml() : '';

  let rowsHtml, moreText;
  if (cnt === 0) {
    // A store the operator picked that happens to be fully stocked.
    rowsHtml = `<div class="td-attn-clear">${cuT('All stocked at this store', '此门店库存充足')}</div>`;
    moreText = '';
  } else {
    // Ordered pool the window rolls through: out-of-stock first, then low.
    TD_LOW_POOL = [
      ...(oos.items || []).map(it => ({ ...it, _oos: true })),
      ...(low.items || []),
    ];
    TD._lowCnt = cnt;
    if (TD.lowRotAt >= TD_LOW_POOL.length) TD.lowRotAt = 0;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const willRotate = TD_LOW_POOL.length > TD_LOW_WIN && !reduce;
    if (!willRotate) TD.lowRotAt = 0;
    const chev = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
    rowsHtml = `<div id="td-low-rows" class="td-low-rows"${willRotate ? ' onmouseenter="tdLowPause()" onmouseleave="tdLowResume()" onfocusin="tdLowPause()" onfocusout="tdLowResume()"' : ''}>${tdLowWindowHtml()}</div>`;
    if (willRotate) {
      moreText = `<button type="button" class="td-attn-more-link" data-no-i18n onclick="dashStockDrawerOpen(event)"><span id="td-low-pos">${tdLowPosText()}</span>${chev}</button>`;
    } else {
      const restN = cnt - Math.min(TD_LOW_WIN, TD_LOW_POOL.length);
      const at = TD.stockStore ? ' ' + cuT('at ' + tdStockStoreName(), '· ' + tdStockStoreName()) : '';
      moreText = restN > 0
        ? `<button type="button" class="td-attn-more-link" data-no-i18n onclick="dashStockDrawerOpen(event)">${cuT(`and ${restN} more${at}`, `另有 ${restN} 项${TD.stockStore ? ' · ' + tdStockStoreName() : ''}`)}${chev}</button>`
        : '';
    }
  }

  host.hidden = false;
  // No title: the block is already called Inventory and the vital above says
  // "Running low". A store filter only when there's more than one store.
  host.innerHTML =
    `<div class="td-inv-low-head"><span>${cuT('Lowest first', '库存最少优先')}</span>${storeSel}</div>`
    + rowsHtml
    + (moreText ? `<div class="td-attn-more">${moreText}</div>` : '');
  // The rows node was just recreated — (re)start the rolling window against it.
  // The timer belongs to this list now, not to the attention strip: a day with
  // no attention cards must still roll the low-stock window.
  tdLowRotStart();
}

function tdAttnRender() {
  const host = document.getElementById('td-attn'); if (!host) return;
  // The stock list is the Inventory block's business now — paint it from the
  // same ops snapshot, on every path that repaints this (poll, SSE, store
  // change, language toggle).
  tdInvLowRender();
  if (!DASH_OPS) {
    host.innerHTML = `<div class="td-muted">${cuT('Loading…', '加载中…')}</div>`;
    return;
  }
  // Feed the Today pulse's "refund requests" cell from the same live ops
  // snapshot (the open-refund queue) — 0 when clear, matching the mockup.
  const refCell = document.getElementById('td-today-ref');
  if (refCell) refCell.textContent = String((DASH_OPS.refunds && DASH_OPS.refunds.count) || 0);
  const cards = [];

  // Stock is no longer a card here — the list moved into the Inventory block
  // (tdInvLowRender), whose own "N out of stock · Open restock" footer already
  // carries the amber dot. Nothing about stock is repeated in this strip.

  // Delivery — the brick "needs a call" card only when the carrier has flagged a
  // problem. When it's clear there's no card here; the calm channels are folded
  // into the single "All clear" roll-up at the end instead of one card each.
  const da = DASH_OPS.delivery_alerts || { count: 0, items: [] };
  if (da.count && dashPosWants('delivery')) {
    const reasonOf = it => {
      // A late air parcel is a delivered order flagged for a food-safety call —
      // it has no live tracking_status to read, so name it directly (mirrors the
      // "AIR DELAYED · contact customer" badge in the orders list).
      if (it.air_delayed) return cuT('air delayed · contact customer', '空运延误 · 联系客户');
      // Meituan is a view-only channel with no live tracking_status; a flagged
      // Meituan order is one the auto-deliver sweep left stuck past its promised
      // time (see the dashboard/ops endpoint), so name it as an overdue delivery.
      if (it.overdue || it.channel === 'meituan')
        return cuT('overdue · check delivery', '配送超时 · 请跟进');
      // Same-city (Qingyun) local delivery stuck before a rider grabbed it — the
      // promised arrival time passed with no rider on the way. Name it directly;
      // these orders carry no tracking_status for deliveryStateInfo to read.
      if (it.local_stuck)
        return cuT('no rider yet · check delivery', '暂无骑手接单 · 请跟进');
      const info = (typeof deliveryStateInfo === 'function' && deliveryStateInfo(it))
        || { en: 'delivery issue', cn: '配送异常' };
      return cuT(info.en, info.cn);
    };
    // Long order numbers (R260616000003) crowd the row, so show a short head+tail
    // ref — still recognisable, and the whole row is a deep link anyway.
    const shortRef = no => { no = String(no || ''); return no.length > 10 ? `${no.slice(0, 5)}…${no.slice(-3)}` : no; };
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    const daChev = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
    const daPhone = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

    const shown = (da.items || []).slice(0, 4).map(it => ({
      id: Number(it.id), buyer: String(it.buyer || '').trim(),
      order_no: it.order_no || '', reason: reasonOf(it),
    }));
    // When every flagged order carries the same reason (the common "air delayed"
    // case), say it once under the title and let each row just show who to call.
    // When reasons differ, drop the shared line and label each row instead.
    const daReasons = [...new Set(shown.map(r => r.reason))];
    const daShared = daReasons.length === 1 ? daReasons[0] : '';
    const rows = (daShared ? `<div class="td-attn-sub">${daPhone}${escapeHtml(cap(daShared))}</div>` : '')
      + shown.map(r => {
        // Lead with who to call; fall back to the order number when no name's on
        // file. The short ref only rides along when the buyer name is the label.
        const nm  = escapeHtml(r.buyer || r.order_no);
        const ref = r.buyer ? `<span class="td-da-ref">${escapeHtml(shortRef(r.order_no))}</span>` : '';
        const rsn = daShared ? '' : `<span class="rsn">${escapeHtml(cap(r.reason))}</span>`;
        return `
      <button type="button" class="td-attn-row td-da-row" onclick="openOrder(${r.id})">
        <span class="td-da-main"><span class="nm">${nm}</span>${rsn}</span>
        ${ref}<span class="td-da-chev" aria-hidden="true">${daChev}</span>
      </button>`;
      }).join('');
    const first = shown[0] || {};
    const more = da.count > 4 ? cuT(`and ${da.count - 4} more`, `另有 ${da.count - 4} 个`) : '';
    const action = da.count === 1 && first.id
      ? `<button type="button" class="td-attn-go" onclick="openOrder(${Number(first.id)})">${cuT('Open the order', '打开订单')}</button>`
      : '';
    cards.push(tdAttnCard('brick', 'truck', cuT('Delivery needs a call', '配送需要跟进'), da.count, rows, more, action));
  }

  // Refund queue — pending / reviewing requests.
  const rf = DASH_OPS.refunds || { count: 0, items: [] };
  if (rf.count && dashPosWants('refunds')) {
    const rows = (rf.items || []).slice(0, 4).map(it => `
      <button type="button" class="td-attn-row"${it.id ? ` onclick="openOrder(${Number(it.id)})"` : ''}>
        <span class="name">${escapeHtml(it.order_no || '')} · ${escapeHtml(it.buyer || '')}</span>
        <span class="val">${it.amount ? '¥' + Number(it.amount).toLocaleString() : '—'}</span>
      </button>`).join('');
    cards.push(tdAttnCard('amber', 'refund', cuT('Refunds waiting', '退款待处理'), rf.count, rows,
      rf.count > 4 ? cuT(`and ${rf.count - 4} more`, `另有 ${rf.count - 4} 笔`) : ''));
  }

  // Invoices to issue — un-issued fapiao requests, oldest first (the retired
  // Invoices tab's queue). Rows open the order drawer (where issuing happens);
  // the card action deep-links to the Orders list pre-filtered on the
  // "Needs invoice" chip — same pattern as Running-low → Open restock.
  const inv = DASH_OPS.invoices || { count: 0, items: [] };
  if (inv.count && dashPosWants('invoices')) {
    const rows = (inv.items || []).slice(0, 4).map(it => `
      <button type="button" class="td-attn-row"${it.id ? ` onclick="openOrder(${Number(it.id)})"` : ''}>
        <span class="name">${escapeHtml(it.order_no || '')} · ${escapeHtml(it.title || '')}</span>
        <span class="val">${it.amount ? '¥' + Number(it.amount).toLocaleString() : '—'}</span>
      </button>`).join('');
    cards.push(tdAttnCard('amber', 'invoice', cuT('Invoices to issue', '待开发票'), inv.count, rows,
      inv.count > 4 ? cuT(`and ${inv.count - 4} more`, `另有 ${inv.count - 4} 张`) : '',
      `<button type="button" class="td-attn-go" onclick="dashOpenInvoices()">${cuT('Open in Orders', '前往订单')}</button>`));
  }

  // There is no "All clear" card. It was written when the blocks had no
  // footers; now every block ends in its own sage line ("Every delivery is on
  // track", "Nothing waiting"), so a card that gathers those lines up and
  // repeats them announces only that nothing is happening. Silence says that.

  // Nothing waiting → the whole block leaves the page: heading, card and all.
  // A shorter dashboard IS the good news. The block stays in the DOM (hidden
  // by CSS) so Arrange mode can still show and reorder it.
  const block = host.closest('.td-block');
  if (!cards.length) {
    host.innerHTML = '';
    if (block) block.classList.add('is-quiet');
    return;
  }
  if (block) block.classList.remove('is-quiet');
  host.innerHTML = `<div class="td-attn-grid">${cards.join('')}</div>`;
}

// ── Running-low stock drawer ────────────────────────────────────────────────
// The card previews 4 items; "and N more" opens this drawer with the FULL
// out-of-stock + low-stock list (one preview=500 pull — far above any real
// catalogue, and anything past it gets a named tail rather than vanishing).
// All-stores view asks for breakdown=1 so each row can carry per-shelf counts
// on multi-store tenants. Shares TD.stockStore with the card's dropdown.
let TD_STOCK_FULL = null;   // last payload — repainted on a language toggle

function dashStockDrawerOpen(ev) {
  // The opening click must not bubble to the dw-dismiss outside-click
  // handler, which would shut the drawer the moment it opens.
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const d = document.getElementById('db-stock-drawer'); if (!d) return;
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  dashStockDrawerLoad();
}

async function dashStockDrawerLoad() {
  const body = document.getElementById('db-stock-body'); if (!body) return;
  body.innerHTML = `<div class="td-muted">${cuT('Loading…', '加载中…')}</div>`;
  TD_STOCK_FULL = null;
  try {
    const scope = TD.stockStore
      ? `store_id=${encodeURIComponent(TD.stockStore)}`
      : 'breakdown=1';
    const j = await api(`/api/retail-admin/dashboard/ops?${scope}&preview=500`);
    TD_STOCK_FULL = j.data || null;
  } catch (e) { /* render paints the retry line */ }
  dashStockDrawerRender();
}

function dashStockDrawerRender() {
  const d = document.getElementById('db-stock-drawer');
  if (!d || !d.classList.contains('open')) return;
  const body = document.getElementById('db-stock-body');
  const pill = document.getElementById('db-stock-pill');
  if (!body) return;
  if (!TD_STOCK_FULL) {
    body.innerHTML = `<div class="td-muted">${cuT('Could not load. Close and try again.', '加载失败，请关闭后重试。')}</div>`;
    if (pill) pill.style.display = 'none';
    return;
  }
  const low = TD_STOCK_FULL.low_stock || { count: 0, items: [] };
  const oos = TD_STOCK_FULL.out_of_stock || { count: 0, items: [] };
  const cnt = low.count + oos.count;
  if (pill) { pill.textContent = String(cnt); pill.style.display = ''; }
  const cn = window.cuLang && cuLang() === 'cn';
  // Per-shelf line under a name — only present in the all-stores view of a
  // multi-store tenant (the server sends `stores` when breakdown=1). Emptiest
  // shelf first, so the store to restock reads first.
  const subLine = (it) => {
    const st = Array.isArray(it.stores) ? it.stores : null;
    if (!st || st.length < 2) return '';
    const parts = st.slice().sort((a, b) => (a.qty || 0) - (b.qty || 0)).map(s => {
      const nm = (cn ? (s.name_cn || s.name_en) : (s.name_en || s.name_cn)) || '';
      return `${escapeHtml(nm)} ${Number(s.qty || 0)}`;
    });
    return `<span class="sub" data-no-i18n>${parts.join(' · ')}</span>`;
  };
  // SKU (货号) under the name — the only way to tell two same-named rows apart
  // (duplicate listings, or a plain vs. "Medium Size" variant) when picking what
  // to restock. Absent for products that never got a code.
  const skuLine = (it) => it.sku
    ? `<span class="sku" data-no-i18n>${escapeHtml(it.sku)}</span>` : '';
  const row = (it, val, valCls) => `
    <button type="button" class="td-stock-row"${it.id ? ` onclick="dashOpenStockProduct(${Number(it.id)})"` : ''}>
      <span class="name"><span class="nm" data-no-i18n>${escapeHtml(dbProdName(it))}</span>${skuLine(it)}${subLine(it)}</span>
      <span class="val${valCls || ''}">${val}</span>
    </button>`;
  let html = '';
  if (TD.stores && TD.stores.length >= 2) {
    html += `<div class="td-stock-scope">${tdStoreSelectHtml()}</div>`;
  }
  if (!cnt) {
    html += `<div class="td-attn-clear">${TD.stockStore ? cuT('All stocked at this store', '此门店库存充足') : cuT('All stocked', '库存充足')}</div>`;
  }
  if (oos.count) {
    html += `<div class="td-stock-grp is-out">${cuT('Out of stock', '已售罄')}<span class="n" data-no-i18n>${oos.count}</span></div>`;
    html += (oos.items || []).map(it => row(it, cuT('out', '售罄'), ' out')).join('');
  }
  if (low.count) {
    html += `<div class="td-stock-grp is-low">${cuT('Running low', '库存不足')}<span class="n" data-no-i18n>${low.count}</span></div>`;
    html += (low.items || []).map(it => row(it, cuT(`${it.stock_qty} left`, `剩 ${it.stock_qty}`), '')).join('');
  }
  // Never truncate silently — a catalogue past the 500-item pull gets a tail.
  const shown = (oos.items || []).length + (low.items || []).length;
  if (cnt > shown) {
    html += `<div class="td-attn-more">${cuT(`and ${cnt - shown} more — Open restock shows everything`, `另有 ${cnt - shown} 项 — 请前往补货查看全部`)}</div>`;
  }
  body.innerHTML = html;
}

// Row → that product's editor. Close this drawer first (the editor lives on
// the Products tab, and the tab switch would close it mid-slide anyway).
function dashOpenStockProduct(id) {
  closeDrawer('#db-stock-drawer');
  dashOpenProductFromFeed(id);
}

// Foot button → the Products tab pre-filtered on Needs restock.
function dashStockDrawerRestock() {
  closeDrawer('#db-stock-drawer');
  dashOpenRestock();
}

// Echo the active range into the Reports page head — "Jun 7 – Jul 6 · 30 days
// · all stores" (the mockup). Built with cuT (the span carries data-no-i18n:
// the string holds several " · " so the walker's first-dot split would mangle
// it). Kept in sync on every dashLoad() and on a language toggle.
function dashRangeLabel() {
  const el = document.getElementById('db-rep-range');
  if (!el) return;
  const from = $('#db-from').value, to = $('#db-to').value;
  if (!from || !to) { el.textContent = ''; return; }
  const cn = window.cuLang && cuLang() === 'cn';
  const fmt = s => {
    const d = new Date(s + 'T00:00:00');
    return cn ? `${d.getMonth() + 1}月${d.getDate()}日`
              : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const win = days <= 1 ? cuT('today', '今日') : cuT(`${days} days`, `${days}天`);
  const sel = document.getElementById('db-store');
  const store = (sel && sel.value && sel.selectedIndex >= 0)
    ? sel.options[sel.selectedIndex].textContent
    : cuT('all stores', '全部门店');
  const dates = from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
  el.textContent = `${dates} · ${win} · ${store}`;
}

// Per-panel window caption ("30 days · 近30天") — one class, filled after each
// load so every card head says which window it summarises (the mockup's meta).
// data-pre-en/-cn add a panel-specific prefix (Top products: "units, 30 days").
function dashWinMeta() {
  const w = (DASH_DATA && DASH_DATA.window) || null;
  const d = w ? (Number(w.span_days) || 1) : null;
  document.querySelectorAll('#tab-reports .db-win-meta').forEach(el => {
    if (d == null) { el.textContent = ''; return; }
    const en = d <= 1 ? 'today' : `${d} days`;
    const cn = d <= 1 ? '今日' : `近${d}天`;
    const pe = el.dataset.preEn, pc = el.dataset.preCn;
    el.textContent = cuT(pe ? `${pe}, ${en}` : en, pc ? `${pc}，${cn}` : cn);
  });
}

async function dashLoad() {
  const from = $('#db-from').value, to = $('#db-to').value;
  dashRangeLabel();
  // Only the cold first load shows "Loading…" — on a refresh we keep the
  // current numbers on screen until the fresh ones fade in, so there's no
  // blank-out flick.
  if (!DASH_DATA) $('#db-kpis').innerHTML = '<div class="db-muted">Loading… · 加载中…</div>';
  try {
    const j = await api(`/api/retail-admin/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${dashStoreQS()}`);
    const first = !DASH_DATA;
    DASH_DATA = j.data;
    if (first) dashRenderAll();
    else dashSwapWithFade(dashRenderAll);
  } catch (e) {
    if (!DASH_DATA && dashBootRetry('dash', dashLoad)) return;
    $('#db-kpis').innerHTML = `<div class="db-muted">Failed to load · 加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

// Manual ↻ refresh — same fetch as dashLoad, but the headline numbers roll up
// from zero (slow, ambient) and the page fades in, so a click reads as a
// deliberate "re-reveal" rather than a silent reload. Seeding _cuVal=0 on the
// live "Right now / Today" tiles makes them roll too; DASH_FORCE_ROLLUP does the
// same for the deep-dive KPIs.
function dashRefresh() {
  DASH_FORCE_ROLLUP = true;
  ['#db-today-rev', '#db-today-ord', '#db-today-new', '#db-live-num'].forEach(sel => {
    const el = $(sel); if (el) el._cuVal = 0;
  });
  dashHeroLoadPresence();
  dashHeroLoadToday({ slow: true });
  tdSecCountsLoad();   // the section footers' queues (preparing, invoices, …)
  dashLoad();
}

// Gentle slow fade-in for a dashboard refresh. The old flicker came from
// rendering the new content at full opacity and THEN snapping it to 0 to fade
// up. Here we hide the area first, swap the fresh content in while it's
// invisible, then ease it back on the same fade as the tab switch — one clean fade-in, no
// appear-snap-fade. Honours prefers-reduced-motion.
function dashSwapWithFade(render) {
  const els = ['reports-body'].map(id => document.getElementById(id)).filter(Boolean);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !els.length) { render(); return; }
  els.forEach(el => { el.style.transition = 'none'; el.style.opacity = '0'; });
  render();
  els.forEach(el => void el.offsetWidth);   // commit opacity:0 + fresh content together
  els.forEach(el => {
    el.style.transition = 'opacity 1.004s cubic-bezier(.16, 1, .3, 1)';
    el.style.opacity = '1';
    el.addEventListener('transitionend', function done(ev) {
      if (ev.target !== el || ev.propertyName !== 'opacity') return;
      el.style.transition = ''; el.style.opacity = '';
      el.removeEventListener('transitionend', done);
    });
  });
}

function dashRenderAll() {
  dashWinMeta();
  dashRenderKpis();
  dashRenderTrend();
  dashRenderHeatmap();
  dashRenderAcqFunnel();
  dashRenderArticleViews();
  dashRenderFunnel();
  dashRenderSplits();
  dashRenderProducts();
  dashRenderCustomers();
  dashRenderTiers();
  dashRenderGeo();
  dashRenderMarketing();
  dashRenderTraffic();
  dashRenderComposition();
  dashRenderCohorts();          // also stashes DASH_RET_CURVE for facts/digest
  dashRenderHeadlines();
  dashRenderFacts();
  dashReadMaybeLoad();
  if (window.rmRenderDash) rmRenderDash();   // mobile Variant A hero + tiles (≤720px)
}

function dashRenderKpis() {
  const k = DASH_DATA.kpis, d = DASH_DATA.deltas;
  const conv = k.conversion_rate == null ? '—' : k.conversion_rate.toFixed(1) + '%';
  // "vs prior 30 days · 对比前30天" — only the Revenue card carries the
  // comparison caption (the mockup); the other deltas stay bare.
  const w = DASH_DATA.window || {};
  const span = Number(w.span_days) || 0;
  const priorNote = span > 1 ? cuT(`vs prior ${span} days`, `对比前${span}天`)
    : span === 1 ? cuT('vs yesterday', '对比昨天') : '';
  const cards = [
    { lbl: 'Revenue · 营收',        val: dashMoney(k.revenue),       num: k.revenue,         fmt: 'money',  delta: d.revenue,       sub: d.revenue == null ? '' : priorNote },
    { lbl: 'Orders · 订单',         val: dashNum(k.orders),          num: k.orders,          fmt: 'num',    delta: d.orders,        sub: '' },
    { lbl: 'Average order · 客单价', val: dashMoney(k.aov, 2),        num: k.aov,             fmt: 'money2', delta: d.aov,           sub: '' },
    { lbl: 'New customers · 新客户', val: dashNum(k.new_customers),   num: k.new_customers,   fmt: 'num',    delta: null,            sub: cuT(`of ${dashNum(k.visitors)} visitors`, `共 ${dashNum(k.visitors)} 访客`) },
    { lbl: 'Visits · 访问',         val: dashNum(k.visits),          num: k.visits,          fmt: 'num',    delta: null,            sub: k.visits === 0 ? 'No data yet · 暂无' : dashNum(k.sessions) + ' ' + cuT('sessions', '会话') },
    { lbl: 'Unique visitors · 独立访客', val: dashNum(k.visitors),    num: k.visitors,        fmt: 'num',    delta: null,            sub: '' },
    { lbl: 'Conversion · 转化率',    val: conv,                       num: k.conversion_rate, fmt: 'pct',    delta: null,            sub: 'orders ÷ sessions · 订单 ÷ 会话' },
    { lbl: 'Refund rate · 退款率',   val: (k.refund_rate || 0).toFixed(1) + '%', num: k.refund_rate || 0, fmt: 'pct', delta: null, sub: dashNum(k.refunded_orders) + ' ' + cuT('refunded', '已退款') },
  ];
  // Snapshot the currently-shown headline values before we blow away the DOM,
  // so a range change can tween from old → new (a zen drift) instead of the
  // fold-open reveal's count-from-zero. Cards are a fixed order, so index keys.
  const prevVals = {};
  document.querySelectorAll('#db-kpis .val[data-cu]').forEach((el, i) => {
    prevVals[i] = (el._cuVal != null) ? el._cuVal : Number(el.dataset.cu);
  });
  $('#db-kpis').innerHTML = cards.map(c => {
    const hasDelta = c.delta !== null && c.delta !== undefined;
    // One foot row per card: delta and/or sub on a single baseline (or a
    // non-breaking space placeholder) so all cards are the same height.
    const deltaHtml = hasDelta ? dashDelta(c.delta) : '';
    const subHtml = c.sub ? `<span class="sub">${escapeHtml(c.sub)}</span>` : '';
    const foot = `<div class="db-kpi-foot">${deltaHtml + subHtml || '&nbsp;'}</div>`;
    // data-cu/data-fmt let the reveal animation count the number up from 0;
    // the printed value stays correct if the script never runs.
    const cu = (c.num != null && isFinite(c.num)) ? ` data-cu="${c.num}" data-fmt="${c.fmt}"` : '';
    return `<div class="db-kpi${c.accent ? ' accent' : ''}"><div class="lbl">${c.lbl}</div><div class="val"${cu}>${c.val}</div>${foot}</div>`;
  }).join('');
  // Fresh data lands → drift each number from its old rest to the new one.
  // A manual ↻ refresh forces a roll-up from zero (no prev) for the re-reveal.
  dashKpiAnimate(DASH_FORCE_ROLLUP ? null : prevVals);
  DASH_FORCE_ROLLUP = false;
}

// Count the KPI headline numbers up from 0 — called on fold-reveal and on a
// data refresh while open. Seeds _cuVal=0 so dashCountUp tweens from zero
// rather than snapping (its first-paint shortcut). Respects reduced-motion.
// `prev` (optional) = a map of index → previously-shown value. When supplied
// (a range change while the fold is open) each number drifts from its old rest
// to the new one — the zen settle. Without it (fold-open reveal) they roll up
// from zero for the dramatic entrance.
function dashKpiAnimate(prev) {
  const fmts = { money: n => dashMoney(n), money2: n => dashMoney(n, 2), pct: n => n.toFixed(1) + '%', num: n => dashNum(Math.round(n)) };
  document.querySelectorAll('#db-kpis .val[data-cu]').forEach((el, i) => {
    const to = Number(el.dataset.cu) || 0;
    const f = fmts[el.dataset.fmt] || fmts.num;
    el._cuVal = (prev && prev[i] != null && isFinite(prev[i])) ? prev[i] : 0;
    dashCountUp(el, to, f, 2600);   // slow, ambient roll-up (easeOutQuint settle)
  });
}

function dashRenderTrend() {
  const t = DASH_DATA.trend || [];
  const metric = DASH_METRIC;
  const isMoney = metric === 'revenue';
  const vals = t.map(p => Number(p[metric] || 0));
  const max = Math.max(1, ...vals);
  const W = 1000, H = 270, padL = 8, padR = 8, padT = 20, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = t.length || 1;
  const x = i => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = v => padT + innerH - (v / max) * innerH;

  // Three gridlines only (the mockup): a solid baseline at ¥0 and dashed lines
  // at the half and full marks, each labelled just above its line at the left.
  let grid = '';
  for (const g of [0, 2, 4]) {
    const gy = padT + (g / 4) * innerH;
    const gv = max * (1 - g / 4);
    grid += `<line class="grid-line${g === 4 ? '' : ' dash'}" x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}"/>`;
    grid += `<text class="ax" x="${padL + 2}" y="${(gy - 4).toFixed(1)}">${isMoney ? dashMoney(gv) : dashNum(Math.round(gv))}</text>`;
  }
  const linePts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = n > 1 ? `<path class="area" d="M ${linePts.join(' L ')} L ${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L ${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z"/>` : '';
  const line = n > 1 ? `<polyline class="line" points="${linePts.join(' ')}" pathLength="1"/>` : '';
  // Last-point marker — the "you are here" dot the mockup ends the line with.
  const enddot = n > 1 ? `<circle class="enddot" cx="${x(n - 1).toFixed(1)}" cy="${y(vals[n - 1]).toFixed(1)}" r="4"/>` : '';

  // A handful of x-axis date labels (the mockup shows ~4), never per-point dots
  // — the line + end dot carry the shape; hover still reads every bucket.
  const labelEvery = Math.max(1, Math.ceil(n / 4));
  let xl = '', hover = '';
  t.forEach((p, i) => {
    const px = x(i);
    if (i % labelEvery === 0 || i === n - 1) {
      const lbl = String(p.bucket).length > 5 ? String(p.bucket).slice(5) : String(p.bucket);
      const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      xl += `<text class="ax" x="${px.toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${escapeHtml(lbl)}</text>`;
    }
    const colW = innerW / Math.max(1, n - 1);  // tile contiguously, point-to-point
    hover += `<rect class="hovercol" data-i="${i}" onmousemove="dashTrendTip(event)" x="${(px - colW / 2).toFixed(1)}" y="${padT}" width="${colW.toFixed(1)}" height="${innerH}"></rect>`;
  });

  $('#db-trend').innerHTML = `<svg class="db-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" onmouseleave="dashTrendHide()">${grid}${area}${line}${enddot}${hover}${xl}</svg>`;  /* per-column hover binding is on each .hovercol; tooltip is a body-level singleton */
}

// Cursor-following tooltip for the trend chart. Computes the nearest data
// bucket from the pointer's x position (the chart uses preserveAspectRatio
// "none", so x scales by width/viewBox-width), shows all three metrics, and
// highlights the matching column. Reads the live DASH_DATA.trend series so
// it stays correct across metric/range switches without re-binding.
function dashTrendTip(e) {
  const t = (DASH_DATA && DASH_DATA.trend) || [];
  if (!t.length) return;
  // The hovered column carries its own index (data-i). Reading it directly —
  // rather than computing it from e.clientX vs getBoundingClientRect — makes
  // the tooltip immune to the html `zoom` the text-size control applies
  // (which otherwise skews those two coordinate spaces against each other).
  const col = e.currentTarget;
  const idx = Math.max(0, Math.min(t.length - 1, parseInt(col.dataset.i, 10) || 0));
  const p = t[idx];
  if (!p) return dashTrendHide();
  // Singleton tooltip lives on <body> so no overflow:hidden ancestor (the
  // chart card) can crop it.
  let tip = document.getElementById('db-trend-tip');
  if (!tip || tip.parentNode !== document.body) {
    if (!tip) { tip = document.createElement('div'); tip.id = 'db-trend-tip'; tip.className = 'db-trend-tip'; }
    document.body.appendChild(tip);
  }
  tip.innerHTML =
    `<div class="b">${escapeHtml(String(p.bucket))}</div>` +
    `<div class="r"><span>${cuT('Revenue','营收')}</span><b>${dashMoney(p.revenue)}</b></div>` +
    `<div class="r"><span>${cuT('Orders','订单')}</span><b>${dashNum(p.orders)}</b></div>` +
    `<div class="r"><span>${cuT('Visits','访问')}</span><b>${dashNum(p.visits)}</b></div>`;
  tip.style.display = 'block';
  fcPlaceTip(tip, col.getBoundingClientRect());
  const svg = col.ownerSVGElement;
  if (svg) svg.querySelectorAll('.hovercol').forEach(c => c.classList.toggle('on', c === col));
}
// The text-size control applies CSS `zoom` to <html>, which makes
// getBoundingClientRect() coordinates and CSS left/top values diverge by an
// amount that depends on the browser's zoom convention. Rather than guess that
// factor, measure it: a hidden fixed probe tells us (a) the viewport bounds in
// getBoundingClientRect space and (b) how a CSS left/top maps into that space.
// Cached per zoom level. Everything below is computed in rect space, then
// converted to CSS px exactly — so tooltips are positioned correctly at any zoom.
let _fcMap = null, _fcMapKey = null;
function fcMeasureMap() {
  const key = ((typeof cuGetUiScale === 'function' && cuGetUiScale()) || 1) + 'x' + window.innerWidth + 'x' + window.innerHeight;
  if (_fcMap && _fcMapKey === key) return _fcMap;
  // Viewport bounds in rect space (a fixed inset:0 box == the viewport).
  const vp = document.createElement('div');
  vp.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;visibility:hidden;pointer-events:none;margin:0;border:0;padding:0;';
  document.body.appendChild(vp);
  const v = vp.getBoundingClientRect();
  // CSS-px → rect-space scale + origin (rect coord when left/top = 0).
  const q = document.createElement('div');
  q.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:1000px;visibility:hidden;pointer-events:none;margin:0;border:0;padding:0;';
  document.body.appendChild(q);
  const qr = q.getBoundingClientRect();
  document.body.removeChild(vp); document.body.removeChild(q);
  _fcMap = {
    vx0: v.left, vy0: v.top, vx1: v.right, vy1: v.bottom,
    ox: qr.left, oy: qr.top,
    sx: (qr.width / 1000) || 1, sy: (qr.height / 1000) || 1,
  };
  _fcMapKey = key;
  return _fcMap;
}
// Position a body-level position:fixed tooltip next to an anchor rect (both in
// getBoundingClientRect space): right of the anchor, flipped left near the
// viewport's right edge, clamped on all sides — then converted to CSS px.
function fcPlaceTip(tip, ar) {
  const map = fcMeasureMap();
  const tr = tip.getBoundingClientRect();
  const m = 6;
  let X = ar.right + 12;
  if (X + tr.width + m > map.vx1) X = ar.left - tr.width - 12;
  X = Math.max(map.vx0 + m, Math.min(X, map.vx1 - tr.width - m));
  let Y = Math.max(map.vy0 + m, Math.min(ar.top + 8, map.vy1 - tr.height - m));
  tip.style.left = ((X - map.ox) / map.sx) + 'px';
  tip.style.top  = ((Y - map.oy) / map.sy) + 'px';
}
function dashTrendHide() {
  const tip = document.getElementById('db-trend-tip');
  if (tip) tip.style.display = 'none';
  document.querySelectorAll('#db-trend .hovercol.on').forEach(c => c.classList.remove('on'));
}

// Cursor-following tooltip for the customer drawer's "Orders by month" bars.
// Bound to the whole column (.cu-bar-col) — not the bar — so zero-order
// months (a 3px sliver) still surface their details on hover.
function cuBarTip(e) {
  const col = e.currentTarget;
  // Singleton tooltip lives on <body> so the drawer's overflow can't crop it.
  let tip = document.getElementById('cu-bar-tip');
  if (!tip || tip.parentNode !== document.body) {
    if (!tip) { tip = document.createElement('div'); tip.id = 'cu-bar-tip'; tip.className = 'cu-bar-tip'; }
    document.body.appendChild(tip);
  }
  const m = col.dataset.m || '', n = col.dataset.n || '0', rev = col.dataset.rev || '0.00';
  tip.innerHTML =
    `<div class="b">${escapeHtml(m)}</div>` +
    `<div class="r"><span>${cuT('Orders', '订单')}</span><b>${escapeHtml(n)}</b></div>` +
    `<div class="r"><span>${cuT('Revenue', '营收')}</span><b>¥${escapeHtml(rev)}</b></div>`;
  tip.style.display = 'block';
  fcPlaceTip(tip, col.getBoundingClientRect());
  // On touch devices onmouseleave never fires, so the tooltip would stick to
  // the screen while you scroll the drawer past the chart. Dismiss it on any
  // scroll (capture:true catches the drawer body's inner scroll) or touchmove.
  if (!cuBarTip._dismissWired) {
    document.addEventListener('scroll', cuBarTipHide, true);
    document.addEventListener('touchmove', cuBarTipHide, { passive: true });
    cuBarTip._dismissWired = true;
  }
}
function cuBarTipHide() {
  const tip = document.getElementById('cu-bar-tip');
  if (tip) tip.style.display = 'none';
}

function dashBarList(rows) {
  // rows: [{ k, kSub, value, valueSub, frac (numeric weight), muted }]
  // Mockup bar rows: label left / value right on one baseline, then a thin
  // 5px track spanning the full row beneath them. The fill keeps the
  // `.db-track > span` shape so the phone clones' sweep animation still bites.
  const max = Math.max(1, ...rows.map(r => r.frac || 0));
  return `<div class="db-bars">${rows.map(r => `
    <div class="db-bar-row">
      <div class="k" title="${escapeAttr(r.kTitle || r.k)}">${escapeHtml(r.k)}${r.kSub ? ` <span class="sub">${escapeHtml(r.kSub)}</span>` : ''}</div>
      <div class="v">${escapeHtml(r.value)}${r.valueSub ? ` <span class="sub">${escapeHtml(r.valueSub)}</span>` : ''}</div>
      <div class="db-track"><span class="${r.muted ? 'muted' : ''}" style="width:${(((r.frac || 0) / max) * 100).toFixed(1)}%"></span></div>
    </div>`).join('')}</div>`;
}

const DASH_STATUS_LABELS = {
  pending_payment: 'Pending · 待付款', paid: 'Paid · 已付款', preparing: 'Preparing · 备货中',
  rider_pickup: 'Rider coming · 骑手来取货',
  dispatched: 'Dispatched · 已发货', delivered: 'Delivered · 已送达',
  awaiting_restock: 'Awaiting stock · 待补货', cancelled: 'Cancelled · 已取消', refunded: 'Refunded · 已退款',
};
const DASH_STATUS_ORDER = ['pending_payment', 'paid', 'awaiting_restock', 'preparing', 'rider_pickup', 'dispatched', 'delivered', 'cancelled', 'refunded'];

// Acquisition funnel — the visitor→buyer drop-off, built from numbers the
// dashboard already loads (no extra fetch): kpis.visitors / new_customers /
// orders + checkout.started. Each bar is a share of visitors; the kSub shows
// the step conversion vs the stage above so the cliff is obvious. The final
// "paid" step uses the server's checkout completion rate (converted ÷ started)
// rather than orders ÷ started, which can exceed 100% when a buyer paid
// without leaving a tracked checkout quote.
function dashRenderAcqFunnel() {
  const host = document.getElementById('db-acqfunnel');
  if (!host) return;
  const k = DASH_DATA.kpis || {};
  const c = DASH_DATA.checkout || {};
  const opened  = Number(k.visitors || 0);
  const signed  = Number(k.new_customers || 0);
  const reached = Number(c.started || 0);
  const paid    = Number(k.orders || 0);
  if (!opened) { host.innerHTML = '<div class="db-muted">No visitors in range · 区间内无访客</div>'; return; }
  const pctOf  = (n, d) => (d > 0 ? (n / d) * 100 : null);
  // checkout→paid completion: prefer the server's rate; fall back to a guarded ratio.
  const paidStep = c.conversion_rate != null ? c.conversion_rate : pctOf(paid, reached);
  const stages = [
    { k: 'Opened the store · 打开店铺', n: opened },
    { k: 'Signed up · 注册',           n: signed },
    { k: 'Reached checkout · 进入结算', n: reached },
    { k: 'Paid · 支付',                n: paid },
  ];
  // Bar width = share of visitors, so each stage's drop reads at a glance
  // (the mockup); the foot names the one number worth acting on.
  const rows = stages.map(s => ({ k: s.k, value: dashNum(s.n), frac: s.n }));
  const footPct = paidStep == null ? null : Math.round(paidStep);
  host.innerHTML = dashBarList(rows)
    + (footPct != null && reached
      ? `<div class="db-funnel-foot">${cuT(`${footPct}% of checkouts become paid orders.`, `${footPct}% 的结算最终完成支付。`)}</div>`
      : '');
}

// Article views — Kitchen Notes editorial (recipe_story) cards. Each row is
// one article: bar = how many customers saw it (impressions), value = how many
// tapped READ MORE (reads), with the read-through % alongside. Deduped per
// viewer per day server-side, so these are "people reached", not raw reloads.
function dashRenderArticleViews() {
  const host = document.getElementById('db-articleviews');
  if (!host) return;
  const list = (DASH_DATA.articleViews || []).filter(a => (a.impressions || 0) > 0 || (a.reads || 0) > 0);
  if (!list.length) {
    host.innerHTML = '<div class="db-muted">' + cuT('No article views in range', '区间内无文章阅读') + '</div>';
    return;
  }
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) + '%' : '—');
  const rows = list.map(a => {
    const seen = a.impressions || 0, reads = a.reads || 0;
    const title = cuT(a.title_en || a.title_cn || '', a.title_cn || a.title_en || '')
      || cuT('(removed article)', '(已删除文章)');
    return {
      k: title,
      kSub: cuT(dashNum(seen) + ' seen', dashNum(seen) + ' 次看到'),
      value: dashNum(reads) + ' ' + cuT('read', '阅读'),
      valueSub: pct(reads, seen),
      frac: seen,
    };
  });
  host.innerHTML = dashBarList(rows);
}

function dashRenderFunnel() {
  const f = DASH_DATA.funnel || {};
  // Status pill rows (the mockup): a tinted pill naming the status, the order
  // count beside it, the status revenue right-aligned. Colour is status —
  // amber = still needs work, sage = moving/done, brick = money went back,
  // muted = closed without money.
  const TONE = {
    pending_payment: 'amber', paid: 'sage', awaiting_restock: 'amber', preparing: 'amber',
    rider_pickup: 'amber', dispatched: 'sage', delivered: 'sage', cancelled: 'mute', refunded: 'brick',
  };
  const rows = DASH_STATUS_ORDER.filter(s => f[s]).map(s => `
    <div class="db-status-row">
      <span class="sp sp-${TONE[s] || 'mute'}">${DASH_STATUS_LABELS[s] || s}</span>
      <span class="n">${dashNum(f[s].n)}</span>
      <span class="rv">${f[s].revenue ? dashMoney(f[s].revenue) : ''}</span>
    </div>`).join('');
  $('#db-funnel').innerHTML = rows ? `<div class="db-status-rows">${rows}</div>` : '<div class="db-muted">No orders in range · 区间内无订单</div>';
}

function dashRenderSplits() {
  const pay = DASH_DATA.payments || [], del = DASH_DATA.delivery || [];
  const payLabel = m => ({ wechat: 'WeChat Pay · 微信支付', alipay: 'Alipay · 支付宝', points: 'Points · 积分', cash: 'Cash · 现金', bank_transfer: 'Bank transfer · 银行转账', wechat_offline: 'WeChat off-app · 微信(线下)', alipay_offline: 'Alipay off-app · 支付宝(线下)', other: 'Other · 其他', unknown: 'Unknown · 未知' }[m] || m);
  const delLabel = m => ({ standard: 'Standard · 标准', max: 'Max speed · 极速', fixed: 'Same-city · 同城', sameday: 'Same-day · 当日', pickup: 'Pickup · 自提', unknown: 'Unknown · 未知' }[m] || m);
  // Two quiet bar groups (the mockup has no group headers): payment methods by
  // revenue, then delivery modes by order count with dimmed fills.
  let html = pay.length ? dashBarList(pay.map(p => ({ k: payLabel(p.method), value: dashMoney(p.revenue), frac: p.revenue }))) : '<div class="db-muted">—</div>';
  html += '<div class="db-bars-gap"></div>';
  html += del.length ? dashBarList(del.map(p => ({ k: delLabel(p.mode), value: `${dashNum(p.orders)} ${cuT(Number(p.orders) === 1 ? 'order' : 'orders', '单')}`, frac: p.orders, muted: true }))) : '<div class="db-muted">—</div>';
  $('#db-splits').innerHTML = html;
}

function dashRenderProducts() {
  const p = DASH_DATA.topProducts || [];
  if (!p.length) { $('#db-products').innerHTML = '<div class="db-muted">No sales in range · 区间内无销售</div>'; return; }
  // Ranked rows (the mockup): index · name · units. Revenue and order count
  // ride each row as a hover title so the detail isn't lost, just quiet.
  $('#db-products').innerHTML = '<div class="db-rank">' + p.map((r, i) => `
    <div class="db-rank-row" title="${escapeAttr(`${dashMoney(r.revenue)} · ${dashNum(r.orders)} ${cuT('orders', '单')}`)}">
      <span class="idx">${i + 1}</span>
      <span class="name">${escapeHtml(dbProdName(r))}</span>
      <span class="rv">${dashNum(r.units)}</span>
    </div>`).join('') + '</div>';
}

function dashRenderCustomers() {
  const c = DASH_DATA.topCustomers || [];
  if (!c.length) { $('#db-customers').innerHTML = '<div class="db-muted">No buyers in range · 区间内无买家</div>'; return; }
  $('#db-customers').innerHTML = '<div class="db-rank">' + c.map((r, i) => `
    <div class="db-rank-row" title="${escapeAttr(`${dashNum(r.orders)} ${cuT('orders', '单')} · ${r.tier_key || 'seed'}`)}">
      <span class="idx">${i + 1}</span>
      <span class="name">${escapeHtml(r.nickname || ('Customer #' + r.customer_id))}</span>
      <span class="rv">${dashMoney(r.revenue, 2)}</span>
    </div>`).join('') + '</div>';
}

function dashRenderTiers() {
  const nvr = DASH_DATA.new_vs_returning || {};
  const tiers = DASH_DATA.tiers || [];
  const tierLabel = t => ({ seed: 'Seed · 种子', sprout: 'Sprout · 嫩芽', root: 'Root · 扎根', tree: 'Tree · 大树' }[t] || t);
  // The mockup's tiles: buyer count, then new / returning as SHARES of buyers.
  const buyers = Number(nvr.buyers || 0);
  const shr = n => buyers > 0 ? Math.round(Number(n || 0) / buyers * 100) + '%' : '—';
  let html = '<div class="db-tiles">'
    + `<div class="db-tile"><div class="t-val">${dashNum(buyers)}</div><div class="t-lbl">buyers · 购买客户</div></div>`
    + `<div class="db-tile"><div class="t-val">${shr(nvr.new_buyers)}</div><div class="t-lbl">new · 新客</div></div>`
    + `<div class="db-tile"><div class="t-val">${shr(nvr.returning_buyers)}</div><div class="t-lbl">returning · 回头客</div></div>`
    + '</div>';
  html += tiers.length ? dashBarList(tiers.map(t => ({ k: tierLabel(t.tier), value: dashNum(t.n), frac: t.n }))) : '<div class="db-muted">—</div>';
  $('#db-tiers').innerHTML = html;
}

function dashRenderGeo() {
  const cities = DASH_DATA.geoCities || [];
  if (!cities.length) { $('#db-geo').innerHTML = '<div class="db-muted">No location data · 暂无地域数据</div>'; return; }
  // City bars by order count (the mockup); revenue + customers ride the hover.
  $('#db-geo').innerHTML = dashBarList(cities.map(c => ({
    k: c.city || '—',
    kTitle: `${dashMoney(c.revenue)} · ${dashNum(c.customers)} ${cuT('customers', '顾客')}`,
    value: `${dashNum(c.orders)} ${cuT(Number(c.orders) === 1 ? 'order' : 'orders', '单')}`,
    frac: c.orders,
  })));
}

function dashRenderMarketing() {
  const v = (DASH_DATA.marketing && DASH_DATA.marketing.vouchers) || [];
  const p = (DASH_DATA.marketing && DASH_DATA.marketing.points) || {};
  let html = '<div class="db-tiles">'
    + `<div class="db-tile"><div class="t-val">${dashNum(p.orders)}</div><div class="t-lbl">Point orders · 积分订单</div></div>`
    + `<div class="db-tile"><div class="t-val">${dashNum(p.points_used)}</div><div class="t-lbl">Points used · 已用积分</div></div>`
    + `<div class="db-tile"><div class="t-val">${dashMoney(p.points_value)}</div><div class="t-lbl">Points value · 积分抵扣</div></div>`
    + '</div>';
  html += '<div class="db-group-h">Vouchers · 优惠券</div>';
  html += v.length ? dashBarList(v.map(x => ({ k: x.code || '—', kSub: `${dashNum(x.uses)} ${cuT('uses','次')}`, value: '−' + dashMoney(x.discount), valueSub: `${dashMoney(x.revenue)} ${cuT('rev','营收')}`, frac: x.uses }))) : '<div class="db-muted">No vouchers redeemed · 无优惠券核销</div>';
  $('#db-marketing').innerHTML = html;
}

// WeChat launch-scene code → [labelEn, labelCn, explainEn, explainCn].
// The explain text feeds each row's hover tooltip so the operator can see what
// the source actually is. Meanings follow WeChat's official scene-value list.
// KEEP the English label + English explanation free of " · " — the admin's
// auto-i18n splitter cuts on the first " · " to pick the active language.
const DASH_SCENES = {
  1001: ['Mini-program list', '小程序列表', 'Opened from WeChat Discover → Mini Programs (and the recents shown there).', '来自微信「发现 → 小程序」列表(含其中的最近使用)。'],
  1005: ['Search', '搜索', "Tapped your shop in WeChat's top search box.", '在微信顶部搜索框点击进入。'],
  1006: ['Search result', '搜索结果', 'Tapped your shop in the Mini Programs search results.', '在小程序搜索结果中点击进入。'],
  1007: ['Single chat card', '单聊卡片', 'A share card someone sent in a one-to-one chat. Usually high intent.', '单人聊天里的分享卡片,意向通常较高。'],
  1008: ['Group chat card', '群聊卡片', 'A share card forwarded into a group chat.', '群聊里转发的分享卡片。'],
  1011: ['Scan QR', '扫码', "Scanned a QR code with WeChat's scanner.", '用微信扫一扫扫码进入。'],
  1012: ['Long-press QR', '长按识别', 'Long-pressed an image and recognised its QR code.', '长按图片识别二维码进入。'],
  1013: ['Album QR', '相册二维码', 'Picked a QR-code image from the phone photo album.', '从相册选取二维码图片进入。'],
  1014: ['Template msg', '模板消息', 'Tapped a WeChat template / service notification.', '点击模板/服务通知进入。'],
  1017: ['Trial version', '体验版', 'Opened the trial (体验版) build — internal testers, not real customers.', '体验版入口,通常是内部测试人员,非真实顾客。'],
  1019: ['Wallet', '钱包', 'Opened from WeChat Wallet.', '从微信钱包进入。'],
  1020: ['Card package', '卡包', "Opened from WeChat's card / coupon holder.", '从微信卡包进入。'],
  1023: ['Home screen', '桌面', 'Tapped the mini-program icon saved to the phone home screen.', '点击保存到手机桌面的图标进入。'],
  1027: ['Search recents', '搜索·用过的', "WeChat home search box, then the 'mini programs you've used' list.", '微信首页搜索框里「使用过的小程序」列表。'],
  1035: ['Official-account menu', '公众号菜单', "Tapped a link in an Official Account's bottom menu.", '点击公众号底部自定义菜单进入。'],
  1036: ['App share', '应用分享', 'Opened from an app share message card.', '通过应用分享卡片进入。'],
  1037: ['From mini-program', '小程序跳转', 'Jumped in from another mini program.', '由另一个小程序跳转进入。'],
  1038: ['Back from mini-program', '小程序返回', 'Returned here after leaving for another mini program.', '从另一个小程序返回本店。'],
  1047: ['Scan code (Discover)', '扫码(发现)', 'Scanned a mini-program code from Discover → Scan.', '在发现→扫一扫扫描小程序码进入。'],
  1048: ['Long-press code', '长按识别码', 'Long-pressed an image and recognised its mini-program code.', '长按图片识别小程序码进入。'],
  1058: ['Official article', '公众号文章', 'Tapped a mini-program link inside an Official Account article.', '点击公众号文章里的小程序链接进入。'],
  1065: ['URL link', '链接跳转', 'Opened from a URL link (URL scheme).', '通过链接(URL scheme)进入。'],
  1074: ['Official-account card', '公众号卡片', 'A mini-program card sent in an Official Account chat.', '公众号会话里下发的小程序卡片。'],
  1089: ['Chat tools', '聊天工具', "Pulled down the chat home screen and tapped the 'recently used' bar.", '在聊天主界面下拉,点击「最近使用」栏进入。'],
  1101: ['Dev preview', '开发预览', 'Developer-tools preview / remote debug — this is you or a developer testing, not a real customer.', '开发者工具预览/远程调试,是你或开发者在测试,非真实顾客。'],
  1106: ['Chat pull-down search', '下拉搜索', 'Pulled down the chat home screen, then opened from the top search results.', '在聊天主界面下拉,从顶部搜索结果进入。'],
  1107: ['Subscription msg', '订阅消息', 'Tapped a subscription message you sent.', '点击你发送的订阅消息进入。'],
  1131: ['Floating window', '浮窗', 'Reopened from the floating window (浮窗).', '从浮窗重新打开。'],
  1271: ['Chat pull-down favourites', '下拉常用', "Pulled down the chat home screen and tapped the 'my frequent mini programs' bar.", '在聊天主界面下拉,点击「我的常用小程序」栏进入。'],
};
function dashRenderTraffic() {
  const k = DASH_DATA.kpis, scenes = (DASH_DATA.traffic && DASH_DATA.traffic.scenes) || [];
  if (!k.visits) {
    $('#db-traffic').innerHTML = '<div class="db-muted">No traffic recorded yet. Visit tracking begins logging once the updated mini app is published. · 暂无流量数据，发布更新版小程序后开始记录。</div>';
    return;
  }
  const conv = k.conversion_rate == null ? '—' : k.conversion_rate.toFixed(1) + '%';
  let html = '<div class="db-tiles">'
    + `<div class="db-tile"><div class="t-val">${dashNum(k.visits)}</div><div class="t-lbl">Opens · 打开</div></div>`
    + `<div class="db-tile"><div class="t-val">${dashNum(k.sessions)}</div><div class="t-lbl">Sessions · 会话</div></div>`
    + `<div class="db-tile"><div class="t-val">${dashNum(k.visitors)}</div><div class="t-lbl">Visitors · 访客</div></div>`
    + `<div class="db-tile"><div class="t-val">${conv}</div><div class="t-lbl">Conversion · 转化</div></div>`
    + '</div>';
  html += '<div class="db-group-h">Entry scenes · 进入场景</div>';
  html += '<div class="db-muted" style="font-size:11px;margin:-2px 0 8px">Hover a source to see what it means · 将鼠标移到来源上查看其含义</div>';
  html += scenes.length ? dashBarList(scenes.map(s => {
    const sc = DASH_SCENES[s.scene];
    const label = sc ? `${sc[0]} · ${sc[1]}` : (`Scene ${s.scene} · 场景 ${s.scene}`);
    const tip = sc && sc[2] ? `${sc[2]} · ${sc[3]}` : `Unlabelled WeChat scene code ${s.scene}. · 未识别的微信场景值 ${s.scene}。`;
    return { k: label, kTitle: tip, value: dashNum(s.visits), valueSub: `${dashNum(s.sessions)} sess.`, frac: s.visits };
  })) : '<div class="db-muted">No scene data · 无场景数据</div>';
  $('#db-traffic').innerHTML = html;
}

// ── Demand heatmap (hour-of-day × day-of-week) ──
const DASH_DOW = ['日 Sun', '一 Mon', '二 Tue', '三 Wed', '四 Thu', '五 Fri', '六 Sat'];
// Single-letter day rail for the compact mockup grid (EN letter · CN 字).
const DASH_DOW_1 = ['S · 日', 'M · 一', 'T · 二', 'W · 三', 'T · 四', 'F · 五', 'S · 六'];
const DASH_DOW_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DASH_DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dashRenderHeatmap() {
  const host = $('#db-heatmap');
  if (!host) return;
  const heat = DASH_DATA.heat || [];
  if (!heat.length) { host.innerHTML = '<div class="db-muted">No orders in range · 区间内无订单</div>'; return; }
  const grid = {};
  let max = 1, busiest = null;
  heat.forEach(h => {
    grid[h.dow + '-' + h.hour] = h;
    if (h.orders > max) max = h.orders;
    if (!busiest || h.orders > busiest.orders) busiest = h;
  });
  // Compact mockup grid: a single-letter day rail, 7×24 ink-tinted cells (the
  // tint colour is the theme's text ink via --td-heat-rgb), hour detail on
  // hover, and a foot naming the busiest hour beside a fewer→more legend.
  let rows = '';
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const cell = grid[d + '-' + h];
      const intensity = cell ? cell.orders / max : 0;
      const bg = intensity === 0 ? 'var(--td-raised)' : `rgba(var(--td-heat-rgb),${(0.1 + intensity * 0.75).toFixed(2)})`;
      const hh = String(h).padStart(2, '0');
      const tip = cell
        ? `${DASH_DOW[d]} ${hh}:00 — ${dashNum(cell.orders)} ${cuT('orders','单')} · ${dashMoney(cell.revenue)}`
        : `${DASH_DOW[d]} ${hh}:00 — 0`;
      rows += `<i style="background:${bg}" title="${escapeAttr(tip)}"></i>`;
    }
  }
  const days = DASH_DOW_1.map(l => `<span>${l}</span>`).join('');
  const busyTxt = busiest
    ? `Busiest: ${DASH_DOW_EN[busiest.dow]} ${String(busiest.hour).padStart(2, '0')}:00 · 最忙：${DASH_DOW_CN[busiest.dow]} ${String(busiest.hour).padStart(2, '0')}:00`
    : '';
  host.innerHTML = `
    <div class="db-heat">
      <div class="days">${days}</div>
      <div class="cells">${rows}</div>
    </div>
    <div class="db-heat-foot">
      <span>${busyTxt}</span>
      <span class="legend"><span>fewer · 少</span>
        <i style="background:var(--td-raised)"></i>
        <i style="background:rgba(var(--td-heat-rgb),.18)"></i>
        <i style="background:rgba(var(--td-heat-rgb),.45)"></i>
        <i style="background:rgba(var(--td-heat-rgb),.8)"></i>
        <span>more · 多</span></span>
    </div>`;
}

// ── Revenue composition (product subtotal vs delivery, with discounts) ──
function dashRenderComposition() {
  const host = $('#db-composition');
  if (!host) return;
  const c = DASH_DATA.composition || {};
  const product  = Number(c.product_total || 0);
  const delivery = Number(c.delivery_fee || 0);
  const discount = Number(c.voucher_total || 0) + Number(c.points_total || 0);
  const net      = Number(c.net_total || 0);
  if (!product && !delivery && !net) { host.innerHTML = '<div class="db-muted">No revenue in range · 区间内无收入</div>'; return; }
  const base = (product + delivery) || 1;
  // The mockup: one two-segment composition bar (ink at two weights), then a
  // legend line — products / delivery fees / net after discounts. The discount
  // detail rides the net figure as a hover title.
  const netTitle = discount > 0
    ? escapeAttr(cuT(`after ${dashMoney(discount)} in voucher and point discounts`, `已扣除优惠券与积分让利 ${dashMoney(discount)}`))
    : '';
  host.innerHTML = `
    <div class="db-comp-bar">
      <span class="c1" title="${escapeAttr('Products · 商品')}" style="width:${(product / base * 100).toFixed(1)}%"></span>
      <span class="c2" title="${escapeAttr('Delivery fees · 运费')}" style="width:${(delivery / base * 100).toFixed(1)}%"></span>
    </div>
    <div class="db-comp-legend">
      <span><b>${dashMoney(product)}</b> <em>products · 商品</em></span>
      <span><b>${dashMoney(delivery)}</b> <em>delivery fees · 运费</em></span>
      <span class="net"${netTitle ? ` title="${netTitle}"` : ''}><em>net after discounts · 折后净额</em> <b>${dashMoney(net)}</b></span>
    </div>`;
}

// ── Cohort retention (summary tiles + weighted curve + matrix) ──
function dashRenderCohorts() {
  const host = $('#db-cohorts');
  if (!host) return;
  DASH_RET_CURVE = [];   // reset the stash a stale range can't leak through
  const sizes = DASH_DATA.cohortSizes || [];
  const rows  = DASH_DATA.cohorts || [];
  if (!sizes.length) { host.innerHTML = '<div class="db-muted">Not enough history yet · 暂无足够留存数据</div>'; return; }

  const byMonth = {};
  rows.forEach(c => { if (!byMonth[c.cohort_month]) byMonth[c.cohort_month] = {}; byMonth[c.cohort_month][c.active_month] = c.active_customers; });
  const sizeMap = {};
  sizes.forEach(c => { sizeMap[c.cohort_month] = c.size; });
  const months = sizes.map(c => c.cohort_month);

  const monthAdd = (m, n) => {
    const [y, mo] = m.split('-').map(Number);
    const t = (mo - 1) + n;
    return `${y + Math.floor(t / 12)}-${String(((t % 12) + 12) % 12 + 1).padStart(2, '0')}`;
  };
  const monthsBetween = (a, b) => {
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
  };
  const todayYM = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
  const age = {};
  months.forEach(m => { age[m] = monthsBetween(m, todayYM); });
  const maxOffset = Math.max(0, ...Object.values(age));

  // Weighted-average retention curve (only cohorts with ≥M months of history).
  const curve = [];
  for (let m = 0; m <= maxOffset; m++) {
    let active = 0, size = 0;
    for (const cm of months) {
      if (age[cm] < m) continue;
      const s = sizeMap[cm] || 0;
      if (!s) continue;
      active += byMonth[cm] && byMonth[cm][monthAdd(cm, m)] || 0;
      size += s;
    }
    if (size > 0) curve.push({ offset: m, pct: Math.round(active / size * 1000) / 10 });
  }
  DASH_RET_CURVE = curve;   // reused by the chapter facts bar + the AI digest
  const kpi = m => { const c = curve.find(x => x.offset === m); return c ? c.pct : null; };
  const tile = (m, en, cn) => {
    const v = kpi(m);
    return `<div class="db-tile"><div class="t-val">${v == null ? '—' : Math.round(v) + '%'}</div><div class="t-lbl">${en} · ${cn}</div></div>`;
  };

  // The mockup: month 1/3/6/12 tiles + a quiet weighted decay curve above a
  // single baseline. The old per-cohort matrix went with the redesign — the
  // curve IS the story; per-cohort detail wasn't worth its screenful.
  let curveSvg = '';
  if (curve.length > 1) {
    const W = 400, H = 80, padT = 6, padB = 8;
    const ih = H - padT - padB;
    const xs = i => (i / (curve.length - 1)) * W;
    const ys = v => padT + ih - (v / 100) * ih;
    const pts = curve.map((c, i) => `${xs(i).toFixed(1)},${ys(c.pct).toFixed(1)}`).join(' ');
    curveSvg = `<svg class="db-ret-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line class="base" x1="0" y1="${H - padB}" x2="${W}" y2="${H - padB}"/>
      <polyline class="line" points="${pts}"/>
    </svg>`;
  }

  host.innerHTML =
    `<div class="db-tiles">${tile(1, 'month 1', '第1个月')}${tile(3, 'month 3', '第3个月')}${tile(6, 'month 6', '第6个月')}${tile(12, 'month 12', '第12个月')}</div>`
    + curveSvg;
}

// ════════════════════════════════════════════════════════════════
// REPORTS CHAPTERS + THE READ — the A+B redesign (spec:
// reference/reports-ai-mockup.html, user picked AI depth 3).
//   · Chapters: Overview / Sales / Customers / Products & traffic —
//     show/hide wrappers only; every chart container id is unchanged.
//   · Facts bars + headline rows: COMPUTED plain words (no AI, no dot).
//   · The read / chapter notes / Ask: the AI voice — every sentence it
//     wrote sits next to a breathing Dusk dot. The client sends a compact
//     digest of the exact DASH_DATA on screen; the server caches the read
//     per window (~2 calls/day) and caps asks per day.
// ════════════════════════════════════════════════════════════════
let DASH_CH = 'overview';
let DASH_RET_CURVE = [];        // weighted retention curve, stashed by dashRenderCohorts
let DASH_REPORTS_SEEN = false;  // AI read only loads once Reports has been opened

function dashShowChapter(ch) {
  DASH_CH = ch;
  document.querySelectorAll('#db-chtabs button').forEach(b => b.classList.toggle('active', b.dataset.ch === ch));
  document.querySelectorAll('#tab-reports .db-chapter').forEach(p => p.classList.toggle('active', p.dataset.ch === ch));
}
function dashChaptersInit() {
  document.querySelectorAll('#db-chtabs button').forEach(b =>
    b.addEventListener('click', () => dashShowChapter(b.dataset.ch)));
}

// Currency symbol exactly as dashMoney prints it — tenant-neutral, no
// hardcoded ¥ ([[feedback_default_tenant_neutral_plumbing]]).
function dashCurrencySym() {
  return (dashMoney(0) || '¥0').replace(/[0-9.,\s-]/g, '') || '¥';
}

const DASH_PAY_NAMES = {
  wechat: ['WeChat Pay', '微信支付'], alipay: ['Alipay', '支付宝'], meituan: ['Meituan', '美团'],
  points: ['Points', '积分'], cash: ['Cash', '现金'], bank_transfer: ['Bank transfer', '银行转账'],
  wechat_offline: ['WeChat off-app', '微信(线下)'], alipay_offline: ['Alipay off-app', '支付宝(线下)'],
  other: ['Other', '其他'], unknown: ['Unknown', '未知'],
};
function dashPayName(m, cn) { const p = DASH_PAY_NAMES[m]; return p ? (cn ? p[1] : p[0]) : String(m || ''); }

// Shared computed nuggets — feed the headline rows, the facts bars and the
// AI digest from ONE place so they can never disagree.
function dashFactBits() {
  const D = DASH_DATA || {};
  const k = D.kpis || {};
  const pays = D.payments || [];
  const payTotal = pays.reduce((s, p) => s + Number(p.revenue || 0), 0);
  const topPay = pays[0] || null;
  let busiest = null;
  (D.heat || []).forEach(h => { if (!busiest || h.orders > busiest.orders) busiest = h; });
  const nvr = D.new_vs_returning || {};
  const vouchers = (D.marketing && D.marketing.vouchers) || [];
  const ret1 = (DASH_RET_CURVE || []).find(c => c.offset === 1);
  return {
    k,
    topPay,
    payShare: topPay && payTotal > 0 ? Math.round(topPay.revenue / payTotal * 100) : null,
    busiest,
    buyers: Number(nvr.buyers || 0),
    newPct: nvr.buyers > 0 ? Math.round(Number(nvr.new_buyers || 0) / nvr.buyers * 100) : null,
    topCust: (D.topCustomers || [])[0] || null,
    topCity: (D.geoCities || [])[0] || null,
    topProd: (D.topProducts || [])[0] || null,
    vGiven: vouchers.reduce((s, v) => s + Number(v.discount || 0), 0),
    vOrders: vouchers.reduce((s, v) => s + Number(v.uses || 0), 0),
    delivered: (D.funnel || {}).delivered || null,
    cancelled: (D.funnel || {}).cancelled || null,
    checkout: D.checkout || {},
    ret1: ret1 ? ret1.pct : null,
    reads: (D.articleViews || []).reduce((s, a) => s + Number(a.reads || 0), 0),
  };
}

// "The short version" — one computed sentence per chapter on the Overview;
// each row jumps into its chapter. Deterministic: no dot, never a guess.
function dashRenderHeadlines() {
  const host = document.getElementById('db-headlines');
  if (!host) return;
  if (!DASH_DATA) { host.hidden = true; return; }
  const cn = window.cuLang && cuLang() === 'cn';
  const b = dashFactBits();
  const hh = h => String(h).padStart(2, '0') + ':00';
  const rows = [];
  if (b.topPay && b.payShare != null) {
    let t = cn ? `${dashPayName(b.topPay.method, true)}占营收 ${b.payShare}%。`
               : `${dashPayName(b.topPay.method, false)} carried ${b.payShare}% of revenue.`;
    if (b.busiest) t += cn ? ` 最忙时段：${DASH_DOW_CN[b.busiest.dow]} ${hh(b.busiest.hour)}。`
                           : ` Busiest hour: ${DASH_DOW_EN[b.busiest.dow]} ${hh(b.busiest.hour)}.`;
    rows.push(['sales', cuT('Sales', '销售'), t]);
  }
  if (b.buyers) {
    let t = cn ? `${dashNum(b.buyers)} 位买家` : `${dashNum(b.buyers)} buyers`;
    t += b.newPct != null ? (cn ? `，${b.newPct}% 为新客。` : `, ${b.newPct}% first-timers.`) : (cn ? '。' : '.');
    if (b.topCity) t += cn ? ` ${b.topCity.city}订单最多（${dashNum(b.topCity.orders)} 单）。`
                           : ` ${b.topCity.city_en || b.topCity.city} leads with ${dashNum(b.topCity.orders)} orders.`;
    rows.push(['customers', cuT('Customers', '客户'), t]);
  }
  if (b.topProd) {
    const nm = cn ? (b.topProd.name_cn || b.topProd.name_en) : (b.topProd.name_en || b.topProd.name_cn);
    let t = cn ? `${nm} 最热销（${dashNum(b.topProd.units)} 件）。` : `${nm} leads with ${dashNum(b.topProd.units)} units.`;
    if (b.k.conversion_rate != null) t += cn ? ` ${b.k.conversion_rate.toFixed(1)}% 的会话转化为订单。`
                                             : ` ${b.k.conversion_rate.toFixed(1)}% of sessions became orders.`;
    rows.push(['products', cuT('Products & traffic', '商品与流量'), t]);
  }
  if (!rows.length) { host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = rows.map(r =>
    `<div class="db-hl-row" role="button" onclick="dashShowChapter('${r[0]}')">
       <span class="k">${escapeHtml(r[1])}</span><span class="t">${escapeHtml(r[2])}</span><span class="go">→</span>
     </div>`).join('');
}

// Facts bars — the plain-words rows atop each chapter. Computed, not AI.
function dashFactRow(t, v) {
  return `<div class="db-fact"><span class="t">${escapeHtml(t)}</span><span class="v">${escapeHtml(v)}</span></div>`;
}
function dashFactsFill(id, rows) {
  const host = document.getElementById(id);
  if (!host) return;
  if (!rows.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = rows.join('');
}
function dashRenderFacts() {
  if (!DASH_DATA) return;
  const cn = window.cuLang && cuLang() === 'cn';
  const b = dashFactBits();
  const hh = h => String(h).padStart(2, '0') + ':00';

  const s = [];
  if (b.delivered) s.push(dashFactRow(cuT('Delivered', '已送达'), `${dashNum(b.delivered.n)} · ${dashMoney(b.delivered.revenue)}`));
  if (b.cancelled && b.cancelled.n) s.push(dashFactRow(cuT('Cancelled', '已取消'), `${dashNum(b.cancelled.n)} · ${dashMoney(b.cancelled.revenue)}`));
  if (b.topPay && b.payShare != null) s.push(dashFactRow(
    cn ? `${dashPayName(b.topPay.method, true)}占营收` : `${dashPayName(b.topPay.method, false)} share of revenue`,
    b.payShare + '%'));
  if (b.busiest) s.push(dashFactRow(cuT('Busiest hour', '最忙时段'),
    cn ? `${DASH_DOW_CN[b.busiest.dow]} ${hh(b.busiest.hour)}` : `${DASH_DOW_EN[b.busiest.dow]} ${hh(b.busiest.hour)}`));
  if (b.vGiven > 0) s.push(dashFactRow(cuT('Given away in vouchers', '优惠券让利'),
    `−${dashMoney(b.vGiven)} · ${dashNum(b.vOrders)} ${cuT('orders', '单')}`));
  dashFactsFill('db-facts-sales', s);

  const c = [];
  if (b.buyers) c.push(dashFactRow(cuT('People bought', '购买人数'), dashNum(b.buyers)));
  if (b.newPct != null) c.push(dashFactRow(cuT('First-time buyers', '新客占比'), b.newPct + '%'));
  if (b.topCust) c.push(dashFactRow(
    cuT('Top spender', '消费最高') + (cn ? '：' : ': ') + (b.topCust.nickname || ('#' + b.topCust.customer_id)),
    dashMoney(b.topCust.revenue)));
  if (b.topCity) c.push(dashFactRow(
    cuT('Top city', '订单最多城市') + (cn ? '：' : ': ') + (cn ? b.topCity.city : (b.topCity.city_en || b.topCity.city)),
    `${dashNum(b.topCity.orders)} ${cuT('orders', '单')}`));
  if (b.ret1 != null) c.push(dashFactRow(cuT('Still buying a month later', '一个月后仍回购'), Math.round(b.ret1) + '%'));
  dashFactsFill('db-facts-customers', c);

  const p = [];
  if (b.topProd) {
    const nm = cn ? (b.topProd.name_cn || b.topProd.name_en) : (b.topProd.name_en || b.topProd.name_cn);
    p.push(dashFactRow(cuT('Top seller', '最热销') + (cn ? '：' : ': ') + nm,
      `${dashNum(b.topProd.units)} ${cuT('units', '件')}`));
  }
  if (b.k.conversion_rate != null) p.push(dashFactRow(cuT('Sessions that became orders', '会话转化下单'), b.k.conversion_rate.toFixed(1) + '%'));
  if (b.checkout && b.checkout.conversion_rate != null) p.push(dashFactRow(cuT('Checkouts that got paid', '结算完成支付'), Math.round(b.checkout.conversion_rate) + '%'));
  if (b.reads > 0) p.push(dashFactRow(cuT('Article reads', '文章阅读'), dashNum(b.reads)));
  dashFactsFill('db-facts-products', p);
}

// ── The read — the AI's analysis of the window ─────────────────────────────
const DASH_READ = { key: null, data: null, loading: false, unavailable: false, error: false };

function dashReadKey() {
  return `${$('#db-from').value}|${$('#db-to').value}|${dashStoreId() || 'all'}`;
}

// Compact digest of the EXACT data on screen. Top-N lists only, rounded —
// the model may cite these numbers and nothing else.
function dashAiDigest() {
  const D = DASH_DATA;
  if (!D) return null;
  const r2 = n => Math.round(Number(n || 0) * 100) / 100;
  const k = D.kpis || {};
  const status = {};
  Object.entries(D.funnel || {}).forEach(([st, v]) => { status[st] = { orders: v.n, revenue: r2(v.revenue) }; });
  const mk = D.marketing || {};
  const vouchers = mk.vouchers || [];
  return {
    currency: dashCurrencySym(),
    window: D.window,
    kpis: {
      revenue: r2(k.revenue), orders: k.orders, average_order: r2(k.aov), buyers: k.buyers,
      new_customers: k.new_customers, visits: k.visits, sessions: k.sessions, unique_visitors: k.visitors,
      conversion_rate_pct: r2(k.conversion_rate), refund_rate_pct: r2(k.refund_rate),
      cancelled_orders: k.cancelled_orders, refunded_orders: k.refunded_orders,
    },
    change_vs_prior_window_pct: D.deltas,
    order_status: status,
    payments: (D.payments || []).slice(0, 6).map(p => ({ method: p.method, orders: p.orders, revenue: r2(p.revenue) })),
    delivery_modes: (D.delivery || []).slice(0, 5).map(d => ({ mode: d.mode, orders: d.orders })),
    revenue_composition: D.composition ? {
      products: r2(D.composition.product_total), delivery_fees: r2(D.composition.delivery_fee),
      voucher_discounts: r2(D.composition.voucher_total), point_discounts: r2(D.composition.points_total),
      net: r2(D.composition.net_total),
    } : null,
    busiest_hours: (D.heat || []).slice().sort((a, b) => b.orders - a.orders).slice(0, 3)
      .map(h => ({ weekday: DASH_DOW_EN[h.dow], hour: h.hour, orders: h.orders })),
    top_products: (D.topProducts || []).slice(0, 8).map(p => ({ name: p.name_en || p.name_cn, units: p.units, revenue: r2(p.revenue) })),
    top_customers: (D.topCustomers || []).slice(0, 5).map(c => ({ name: c.nickname || ('#' + c.customer_id), orders: c.orders, revenue: r2(c.revenue) })),
    buyers_new_vs_returning: D.new_vs_returning,
    top_cities: (D.geoCities || []).slice(0, 6).map(g => ({ city: g.city_en || g.city, city_cn: g.city, orders: g.orders, revenue: r2(g.revenue) })),
    vouchers: {
      orders_with_voucher: vouchers.reduce((s, v) => s + Number(v.uses || 0), 0),
      discount_given: r2(vouchers.reduce((s, v) => s + Number(v.discount || 0), 0)),
    },
    points: mk.points ? { orders: mk.points.orders, value: r2(mk.points.points_value) } : null,
    checkout: D.checkout ? {
      started: D.checkout.started, converted: D.checkout.converted,
      abandoned: D.checkout.abandoned, checkout_to_paid_pct: D.checkout.conversion_rate,
    } : null,
    retention_pct_by_months_since_first_order: (DASH_RET_CURVE || []).slice(0, 7).map(c => ({ month: c.offset, pct: c.pct })),
    traffic_scenes: ((D.traffic && D.traffic.scenes) || []).slice(0, 6).map(sc => {
      const m = DASH_SCENES[sc.scene];
      return { source: m ? m[0] : ('scene ' + sc.scene), visits: sc.visits };
    }),
    article_views: (D.articleViews || []).slice(0, 3).map(a => ({ title: a.title_en || a.title_cn || '(removed)', seen: a.impressions, reads: a.reads })),
  };
}

// Fetch the read for the current window — once per window, only after the
// Reports tab has actually been opened, never again once the server says the
// AI isn't configured.
async function dashReadMaybeLoad() {
  if (!DASH_REPORTS_SEEN || !DASH_DATA || DASH_READ.unavailable) return;
  const key = dashReadKey();
  if (DASH_READ.key === key && (DASH_READ.data || DASH_READ.loading)) { dashReadRender(); return; }
  DASH_READ.key = key;
  DASH_READ.loading = true;
  DASH_READ.data = null;
  DASH_READ.error = false;
  dashReadRender();
  try {
    const j = await api('/api/retail-admin/reports/read', { method: 'POST', body: {
      from: $('#db-from').value, to: $('#db-to').value, store_id: dashStoreId(), digest: dashAiDigest(),
    } });
    if (DASH_READ.key !== key) return;   // range changed mid-flight — stale
    DASH_READ.loading = false;
    if (!j.data || j.data.available === false) {
      DASH_READ.unavailable = true;      // quietly a reports page without AI
    } else {
      DASH_READ.data = j.data;
    }
  } catch (e) {
    if (DASH_READ.key !== key) return;
    DASH_READ.loading = false;
    DASH_READ.error = true;              // hide rather than apologise
  }
  dashReadRender();
  dashNotesRender();
  dashAskEnsure();
}

// The read, drawn — the AI's findings rendered as picture cards instead of
// paragraphs (spec: reference/reports-read-combo-mockup.html, combo 2: pulse
// verdict + insight cards). Every number in the pictures is computed HERE from
// DASH_DATA; the AI only chose the captions, urgency levels and the action.
// Old cached payloads (no verdict) and thin data fall back to the prose read.

// One bilingual field pick — prefers the live language, falls back across.
function dashReadPick(r, base) {
  const cn = window.cuLang && cuLang() === 'cn';
  const en = r[base + '_en'] || '', zh = r[base + '_cn'] || '';
  return (cn ? (zh || en) : (en || zh)) || '';
}

function dashReadPill(level) {
  if (level === 'watch') return `<span class="rv-pill warn">${escapeHtml(cuT('Watch this', '要留意'))}</span>`;
  if (level === 'ok')    return `<span class="rv-pill ok">${escapeHtml(cuT('Working', '运转良好'))}</span>`;
  return '';
}
function dashRvCap(text, level, showOk) {
  const pill = level === 'watch' ? dashReadPill('watch') : (showOk && level === 'ok' ? dashReadPill('ok') : '');
  return `<div class="rv-cap"><span class="td-ai-dot"></span><span class="t">${escapeHtml(text)}</span>${pill}</div>`;
}
function dashRvRow(label, barHtml, val, sub) {
  return `<div class="rv-frow"><span class="l">${escapeHtml(label)}</span><span class="rv-bar">${barHtml}</span>` +
    `<span class="v">${escapeHtml(val)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span></div>`;
}
function dashRvBarW(pct, floor) {
  return Math.max(floor, Math.min(100, pct)).toFixed(2);
}

// Builds the card grid; returns { html, levels: [name, level][] } or null when
// the data is too thin to draw (new store) — caller falls back to prose.
function dashReadVisual(r) {
  const D = DASH_DATA;
  if (!D) return null;
  const k = D.kpis || {};
  const cn = window.cuLang && cuLang() === 'cn';
  const cards = [];
  const levels = [];

  // 1 · The money path — visits → orders → money kept.
  const flowCap = dashReadPick(r, 'flow_cap');
  const orders = Number(k.orders || 0), revenue = Number(k.revenue || 0);
  const sessions = Number(k.sessions || k.visits || 0);
  if (flowCap && orders > 0 && revenue > 0) {
    const cancel = (D.funnel || {}).cancelled || null;
    const cancelRev = cancel ? Number(cancel.revenue || 0) : 0;
    const keptPct = revenue + cancelRev > 0 ? revenue / (revenue + cancelRev) * 100 : 100;
    const convPct = k.conversion_rate != null ? Number(k.conversion_rate) : (sessions > 0 ? orders / sessions * 100 : null);
    const rows = [];
    if (sessions > 0) {
      rows.push(dashRvRow(cuT('Visited the store', '到店浏览'), '<i style="flex-basis:100%"></i>', dashNum(sessions), ''));
      const w = dashRvBarW(convPct == null ? 5 : convPct, 1.2);
      rows.push(dashRvRow(cuT('Placed an order', '下了单'),
        `<i style="flex-basis:${w}%"></i><i class="ghost" style="flex-basis:${(100 - w).toFixed(2)}%"></i>`,
        dashNum(orders), convPct == null ? '' : convPct.toFixed(1) + '%'));
    } else {
      rows.push(dashRvRow(cuT('Orders placed', '下单数'), '<i style="flex-basis:100%"></i>', dashNum(orders), ''));
    }
    const kw = dashRvBarW(keptPct, 2);
    rows.push(dashRvRow(cuT('Money kept', '实收'),
      `<i style="flex-basis:${kw}%"></i>` + (cancelRev > 0 ? `<i class="lost" style="flex-basis:${(100 - kw).toFixed(2)}%"></i>` : ''),
      dashMoney(revenue), cancelRev > 0 ? cuT('cancelled ', '取消 ') + dashMoney(cancelRev) : ''));
    cards.push(`<div class="rv-card rv-span2">${dashRvCap(flowCap, r.flow_level, false)}
      <div class="rv-sub">${escapeHtml(cuT('The path from a visit to money kept', '从到访到实收的路径'))}</div>${rows.join('')}</div>`);
    levels.push([cuT('Money', '钱'), r.flow_level]);
  }

  // 2 · Buyers — one dot per buyer, green = came back.
  const retCap = dashReadPick(r, 'retention_cap');
  const nvr = D.new_vs_returning || {};
  const buyers = Number(nvr.buyers || k.buyers || 0);
  if (retCap && buyers > 0) {
    const newB = Math.min(buyers, Number(nvr.new_buyers || 0));
    const backB = Math.max(0, buyers - newB);
    const dots = buyers <= 160 ? buyers : 100;
    const per = buyers / dots;
    const on = Math.min(dots, Math.round(backB / buyers * dots));
    let grid = '';
    for (let i = 0; i < dots; i++) grid += (i < on ? '<i class="on"></i>' : '<i></i>');
    const each = per > 1 ? cuT(`each dot is about ${dashNum(Math.round(per))} buyers`, `每个点约代表 ${dashNum(Math.round(per))} 位买家`)
                         : cuT('each dot is one buyer this period', '每个点代表本期一位买家');
    const bits = dashFactBits();
    const retNote = bits.ret1 != null
      ? `<div class="rv-note">${escapeHtml(cn ? `一个月后仍回购：${Math.round(bits.ret1)}%` : `${Math.round(bits.ret1)}% still buying a month later`)}</div>` : '';
    cards.push(`<div class="rv-card">${dashRvCap(retCap, r.retention_level, true)}
      <div class="rv-sub">${escapeHtml(each)}</div>
      <div class="rv-dots">${grid}</div>
      <div class="rv-legend">
        <span><i class="k on"></i><b>${dashNum(backB)}</b> ${escapeHtml(cuT('returning', '回头客'))}</span>
        <span><i class="k"></i><b>${dashNum(newB)}</b> ${escapeHtml(cuT('first-timers', '新客'))}</span>
      </div>${retNote}</div>`);
    levels.push([cuT('Buyers', '买家'), r.retention_level]);
  }

  // 3 · Channels — top payment channel vs the rest, orders and revenue.
  const chCap = dashReadPick(r, 'channel_cap');
  const pays = (D.payments || []).slice().sort((a, b) => Number(b.revenue || 0) - Number(a.revenue || 0));
  const top = pays[0];
  if (chCap && top && orders > 0 && revenue > 0 && Number(top.orders || 0) <= orders) {
    const name = dashPayName(top.method, cn);
    const oPct = dashRvBarW(Number(top.orders || 0) / orders * 100, 0);
    const vPct = dashRvBarW(Number(top.revenue || 0) / revenue * 100, 0);
    const seg = (label, pct, a, bLbl) =>
      `<div class="rv-segname">${escapeHtml(label)}</div>
       <div class="rv-segbar"><i style="flex-basis:${pct}%"></i><i class="rest" style="flex-basis:${(100 - pct).toFixed(2)}%"></i></div>
       <div class="rv-seglbl"><span>${escapeHtml(a)}</span><span>${escapeHtml(bLbl)}</span></div>`;
    cards.push(`<div class="rv-card">${dashRvCap(chCap, r.channel_level, true)}
      <div class="rv-sub">${escapeHtml(cuT('Share by channel', '各渠道占比'))}</div>
      ${seg(cuT('Orders', '订单'), oPct, `${name} ${dashNum(top.orders)}`, `${cuT('Other', '其他')} ${dashNum(orders - Number(top.orders || 0))}`)}
      ${seg(cuT('Revenue', '收入'), vPct, `${name} ${dashMoney(top.revenue)}`, `${cuT('Other', '其他')} ${dashMoney(Math.max(0, revenue - Number(top.revenue || 0)))}`)}
    </div>`);
    levels.push([cuT('Channels', '渠道'), r.channel_level]);
  }

  // A verdict over zero data pictures is noise — need at least one before the
  // action card counts (brand-new store falls back to the prose read).
  if (!cards.length) return null;

  // 4 · What to do next — the one Dusk surface; timeline only when the action
  // is tied to a days-after-first-purchase window.
  const act = dashReadPick(r, 'action');
  if (act) {
    let tl = '';
    if (r.action_day_from != null && r.action_day_to != null) {
      const scale = Math.max(30, Number(r.action_day_to));
      const left = Number(r.action_day_from) / scale * 100, width = (Number(r.action_day_to) - Number(r.action_day_from)) / scale * 100;
      tl = `<div class="rv-tl">
        <span class="rail"></span><span class="mark"></span>
        <span class="mlbl">${escapeHtml(cuT('First purchase', '首次下单'))}</span>
        <span class="win" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span>
        <span class="wlbl" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%">${escapeHtml(cn ? `第 ${r.action_day_from}–${r.action_day_to} 天` : `Day ${r.action_day_from}–${r.action_day_to}`)}</span>
        <span class="tick" style="left:0%">0</span>
        <span class="tick" style="left:${left.toFixed(1)}%">${r.action_day_from}</span>
        <span class="tick" style="left:${(left + width).toFixed(1)}%">${r.action_day_to}</span>
      </div>`;
    }
    cards.push(`<div class="rv-card rv-act rv-span2">
      <div class="rv-cap"><span class="td-ai-dot"></span><span class="t">${escapeHtml(act)}</span></div>${tl}</div>`);
  }

  if (!cards.length) return null;

  // Pulse chips — steady vs needs-you, named so the amber one says what.
  const okN = levels.filter(l => l[1] === 'ok').length;
  const watch = levels.filter(l => l[1] === 'watch').map(l => l[0]);
  let chips = '';
  if (okN) chips += `<span class="rv-chip ok"><i></i>${escapeHtml(cn ? `${okN} 项平稳` : `${okN} steady`)}</span>`;
  if (watch.length) chips += `<span class="rv-chip warn"><i></i>${escapeHtml(cn
    ? `${watch.length} 项要留意 — ${watch.join('、')}` : `${watch.length} need${watch.length > 1 ? '' : 's'} you — ${watch.join(', ')}`)}</span>`;

  return { cards: `<div class="rv-cards">${cards.join('')}</div>`, chips };
}

function dashReadWordsToggle() {
  const btn = document.getElementById('db-read-words');
  const box = document.getElementById('db-read-prose');
  if (!btn || !box) return;
  box.hidden = !box.hidden;
  btn.textContent = box.hidden ? cuT('Read it as words', '看文字版') : cuT('Hide the words', '收起文字');
}

function dashReadRender() {
  const host = document.getElementById('db-read');
  if (!host) return;
  if (DASH_READ.unavailable || DASH_READ.error) { host.hidden = true; return; }
  if (DASH_READ.loading && !DASH_READ.data) {
    host.hidden = false;
    host.innerHTML = `<div class="rload"><span class="td-ai-dot"></span>${escapeHtml(cuT('Reading the numbers…', '正在读取数据…'))}</div>`;
    return;
  }
  const d = DASH_READ.data;
  if (!d || !d.read) { host.hidden = true; return; }
  const cn = window.cuLang && cuLang() === 'cn';
  const paras = String(cn ? d.read.read_cn : d.read.read_en).split(/\n+/)
    .map(s => s.trim()).filter(Boolean)
    .map(pText => `<p>${escapeHtml(pText)}</p>`).join('');
  let when = '';
  if (d.generated_at) {
    const t = new Date(String(d.generated_at).replace(' ', 'T') + 'Z');
    if (!isNaN(t)) when = t.toLocaleTimeString(cn ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  }
  const head = `<div class="rh"><span class="td-ai-dot"></span><h3>${escapeHtml(cuT('The read', '解读'))}</h3>
      <span class="meta">${escapeHtml(when ? cuT('written at ' + when, '写于 ' + when) : cuT("written from this period's numbers", '由本期数据生成'))}</span></div>`;
  const foot = `<div class="rfoot">${escapeHtml(cuT('Drawn from the numbers in this report — nothing else. Refreshes with the range, at most twice a day.', '内容仅依据本报表数据。随区间刷新，每天最多两次。'))}</div>`;

  const verdict = dashReadPick(d.read, 'verdict');
  const vis = verdict ? dashReadVisual(d.read) : null;
  host.hidden = false;
  if (vis) {
    host.innerHTML = `${head}
      <div class="rv-verdict">
        <svg width="96" height="18" viewBox="0 0 96 18" fill="none" aria-hidden="true"><path d="M2 9 C6 9 6 3 10 3 S14 15 18 15 22 4 26 4 30 13 34 13 38 8 42 9 L60 9 L84 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="90" cy="9" r="2.5" fill="var(--td-dusk)"/></svg>
        <span class="v">${escapeHtml(verdict)}</span>
        <span class="chips">${vis.chips}</span>
      </div>
      ${vis.cards}
      <button type="button" class="rv-words" id="db-read-words" onclick="dashReadWordsToggle()">${escapeHtml(cuT('Read it as words', '看文字版'))}</button>
      <div class="rv-prose" id="db-read-prose" hidden>${paras}</div>
      ${foot}`;
  } else {
    host.innerHTML = `${head}${paras}${foot}`;
  }
}

// One dry sentence opening each chapter — same generation, same dot.
function dashNotesRender() {
  const d = DASH_READ.data;
  const cn = window.cuLang && cuLang() === 'cn';
  [['db-note-sales', 'note_sales'], ['db-note-customers', 'note_customers'], ['db-note-products', 'note_products']].forEach(([id, field]) => {
    const host = document.getElementById(id);
    if (!host) return;
    const text = d && d.read ? (cn ? d.read[field + '_cn'] : d.read[field + '_en']) : '';
    if (!text) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = `<span class="td-ai-dot"></span><p>${escapeHtml(text)}</p>`;
  });
}

// ── Ask about your numbers ─────────────────────────────────────────────────
const DASH_ASK = { log: [], busy: false, wired: false };
const DASH_ASK_CHIPS = [
  ['Why did the average order change?', '平均客单为什么变化？'],
  ['What should I restock first?', '我该先补什么货？'],
  ['How does this period compare with the one before?', '这个区间和上一个相比怎么样？'],
];

function dashAskEnsure() {
  const host = document.getElementById('db-ask');
  if (!host) return;
  if (DASH_READ.unavailable) { host.hidden = true; return; }
  host.hidden = false;
  if (!DASH_ASK.wired) {
    DASH_ASK.wired = true;
    const inp = document.getElementById('db-ask-input');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') dashAskSubmit(); });
  }
  dashAskChipsRender();
  dashAskRender();
}
function dashAskChipsRender() {
  const host = document.getElementById('db-ask-chips');
  if (!host) return;
  host.innerHTML = DASH_ASK_CHIPS.map((c, i) =>
    `<button class="db-ask-chip" onclick="dashAskChip(${i})">${escapeHtml(cuT(c[0], c[1]))}</button>`).join('');
  const inp = document.getElementById('db-ask-input');
  if (inp) inp.placeholder = cuT('e.g. Why did the average order drop?', '例如：平均客单为什么下降？');
}
function dashAskChip(i) {
  const c = DASH_ASK_CHIPS[i];
  if (c) dashAskSubmit(cuT(c[0], c[1]));
}
function dashAskRender() {
  const host = document.getElementById('db-ask-log');
  if (!host) return;
  const cn = window.cuLang && cuLang() === 'cn';
  host.innerHTML = DASH_ASK.log.map(r => {
    let body;
    if (r.pending) {
      body = `<div class="a muted"><span class="td-ai-dot"></span><p>${escapeHtml(cuT('Reading the numbers…', '正在读取数据…'))}</p></div>`;
    } else if (r.error) {
      body = `<div class="a muted"><p>${escapeHtml(r.error === 'ask_limit'
        ? cuT("That's the day's questions used up — ask again tomorrow.", '今天的提问次数已用完，明天再来。')
        : cuT('That one didn’t go through. Try again.', '这次没有成功，请再试一次。'))}</p></div>`;
    } else {
      body = `<div class="a"><span class="td-ai-dot"></span><p>${escapeHtml(cn ? r.a_cn : r.a_en)}</p></div>`;
    }
    return `<div class="db-ask-qa"><div class="q">${escapeHtml(r.q)}</div>${body}</div>`;
  }).join('');
}
async function dashAskSubmit(qArg) {
  const inp = document.getElementById('db-ask-input');
  const q = String(qArg || (inp && inp.value) || '').trim();
  if (!q || DASH_ASK.busy || !DASH_DATA) return;
  DASH_ASK.busy = true;
  const btn = document.getElementById('db-ask-send');
  if (btn) btn.disabled = true;
  if (inp && !qArg) inp.value = '';
  const row = { q, pending: true };
  DASH_ASK.log.push(row);
  dashAskRender();
  try {
    const j = await api('/api/retail-admin/reports/ask', { method: 'POST', body: {
      q, from: $('#db-from').value, to: $('#db-to').value, store_id: dashStoreId(), digest: dashAiDigest(),
    } });
    row.pending = false;
    row.a_en = j.data.answer.answer_en;
    row.a_cn = j.data.answer.answer_cn;
  } catch (e) {
    row.pending = false;
    row.error = (e && e.code === 'ask_limit') ? 'ask_limit' : 'failed';
  }
  DASH_ASK.busy = false;
  if (btn) btn.disabled = false;
  dashAskRender();
}

