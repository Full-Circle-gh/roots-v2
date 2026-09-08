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

// The dashboard's money, which is acMoney with the dashboard's own default:
// whole units, because these are headline tiles and chart axes (audit A-08).
// `dp` still overrides for the few places that want cents.
function dashMoney(n, dp) { return acMoney(n, Number.isInteger(dp) ? dp : 0); }
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
// Shared y-scale for a sparkline. When a ghost (typical-day) series of the SAME
// length is present, both curves scale to their combined max/min so their
// heights compare directly. Stashed on the wrap so the dot + hover-scrub use the
// same scale as the drawn line.
function dashSparkScale(vals, ghost) {
  const v = (vals || []).map(x => Number(x) || 0);
  const g = (ghost || []).map(x => Number(x) || 0);
  const use = (g.length === v.length && g.length) ? v.concat(g) : v;
  return { max: Math.max(1, ...use), min: Math.min(0, ...use) };
}
function dashSparkline(values, opts) {
  opts = opts || {};
  const vals = (values || []).map(v => Number(v) || 0);
  const ghost = (opts.ghost || []).map(v => Number(v) || 0);
  const W = 100, H = 24, pad = 2;
  const hasGhost = ghost.length >= 2 && ghost.length === vals.length && ghost.some(v => v > 0);
  const todayFlat = vals.length < 2 || vals.every(v => v <= 0);
  // Nothing today AND no ghost: draw a faint dashed baseline instead of
  // vanishing — the sparkline is always visibly present, saying "no activity".
  if (todayFlat && !hasGhost) {
    const midY = (H / 2).toFixed(1);
    return `<svg class="db-spark is-flat" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
      + `<line x1="${pad}" y1="${midY}" x2="${W - pad}" y2="${midY}" stroke="currentColor" stroke-width="1" `
      + `vector-effect="non-scaling-stroke" stroke-dasharray="2 3" opacity="0.35"/></svg>`;
  }
  const n = vals.length;
  const sc = dashSparkScale(vals, hasGhost ? ghost : null);
  const max = sc.max, min = sc.min, span = (max - min) || 1;
  const x = i => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = v => (H - pad) - ((v - min) / span) * (H - 2 * pad);
  // The typical-day ghost — a dotted curve behind today's line, same y-scale so
  // heights compare directly. No fill, no dot: a reference, not data.
  let ghostSvg = '';
  if (hasGhost) {
    const gp = ghost.map((v, i) => ({ x: x(i), y: y(v) }));
    ghostSvg = `<path class="db-spark-ghost" d="${dashSmoothPath(gp, H, pad)}" fill="none" stroke="currentColor" `
      + `stroke-width="1.2" vector-effect="non-scaling-stroke" stroke-dasharray="1.5 2.5" stroke-linecap="round" opacity="0.4"/>`;
  }
  // Today may not have started yet (all zero) while the ghost carries shape —
  // show the ghost alone, no line/area/dot.
  if (todayFlat) {
    return `<svg class="db-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${ghostSvg}</svg>`;
  }
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
  // Computed with the shared scale (not dashSparkPct's own) so it sits on the
  // line when a ghost has changed the y-scale. W=100 → viewBox unit == percent.
  let dot = '';
  if (opts.dot) {
    const idx = n - 1;
    dot = `<i class="db-spark-dot${opts.pulse ? ' is-breathing' : ''}" style="left:${x(idx).toFixed(1)}%;top:${((y(vals[idx]) / H) * 100).toFixed(1)}%"></i>`;
  }
  return `<svg class="db-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${defs}${ghostSvg}${area}${line}</svg>${dot}`;
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
  // The STORE's today and the store's days back from it. These four lines used
  // to spell Guangzhou out (+8 hours, then slice the ISO string), so on any
  // account outside UTC+8 every preset on this page asked the server for the
  // wrong window — and the server, since A-05, counts its business day on the
  // account's OWN clock, so the two disagreed about which day "today" is.
  const today = tdToday();
  let from = today;
  if (key === '7')  from = tdToday(-6);
  if (key === '30') from = tdToday(-29);
  if (key === '90') from = tdToday(-89);
  $('#db-from').value = from;
  $('#db-to').value = today;
  if (opts && opts.defer) { dashRangeLabel(); return; }
  dashLoad();
}

// ── Dashboards by position ─────────────────────────────────────────────────
// The operator's role picks a fixed dashboard view (set as window.RA_POS +
// body.pos-* at boot). 'default' = the full owner view. dashPos() (the role
// string) still drives the below-the-fold list pulls (which surface is even
// worth fetching per role) and, via CSS, whole-card presence incl. the money
// blocks. What a NON-money "Needs you" sub-card shows is now decided by the
// operator's actual capability (can()/canAny(), 01-core.js) — a card appears
// only if the operator holds a permission that could resolve its fire. This
// makes the set self-composing: a per-user grant/revoke (impossible to express
// as a role name) turns a row on/off with no code change, and the old
// customer_service-vs-dispatch special-case falls out of the presets for free.
//   Fail-OPEN by the same rule as the rest of the RBAC view layer: an unknown
// cap set (older session / resolution hiccup) shows the row — for these
// actionable, non-money rows that's benign (worst case a row the server 403s
// once enforcement lands). Money-card PRESENCE is deliberately NOT on this path
// — it stays on the body.pos-* CSS gate, which resolves from the reliable role
// string and so can't leak revenue on a null-caps session.
function dashPos() { return window.RA_POS || 'default'; }
// Needs-you sub-card → the capability (or any-of) that makes it actionable.
const DASH_CARD_CAP = {
  stock:    ['quickstock:recount', 'purchasing:receive'],
  delivery: ['orders:edit', 'orders:dispatch_courier'],
  refunds:  'orders:refund',
  invoices: 'invoices:manage',
  // Orders awaiting restock — an order worklist, so it is gated on being able to
  // see orders at all. Named explicitly rather than left out of this map:
  // dashCardWants treats an unknown key as "always show", which would put a fire
  // on the dashboard of an operator with no way to act on it.
  orders:   'orders:view',
  // The two Inbox queues. Gated on MODERATE, not view: the test for a Needs-you
  // row is "can the operator click it and resolve it", and resolving one of
  // these means writing the reply. A read-only operator would get a fire they
  // can only look at.
  reviews:  'reviews:moderate',
  feedback: 'feedback:moderate',
  // The kitchen finished a warehouse request. Gated on the pair that RAISES
  // these — the same audience routes/restock.js addresses the 'prepared' push
  // to. Named explicitly rather than left out of this map, because an unknown
  // key here means "always show": without the line, an operator who cannot open
  // the ready list would be told about work waiting behind it. The server
  // applies the identical gate (lib/kitchen-ready.js canSeeKitchenReady) — this
  // one keeps the row off the screen, that one keeps the data off the wire.
  kitchen_ready: ['restock:request', 'restock:pick'],
};
function dashCardWants(kind) {
  const cap = DASH_CARD_CAP[kind];
  return cap === undefined ? true : _capAllows(cap);   // _capAllows: can()/canAny() (01-core.js)
}
// Is a switchable feature actually running for this tenant? body.feat-<key> is
// seeded at boot (02-settings-ops.js) from entitlement + the operator's own
// on/off preference, well before the first ops poll lands.
//
// Unlike the capability gate above this one fails CLOSED, and deliberately: a
// tenant who turned Reviews off is not filling that queue any more, so nagging
// them about its backlog from the front door would be a fire nobody lit. The
// page itself stays reachable (feature-off dims a rail row, it doesn't hide it)
// — this only decides whether the dashboard raises its hand.
function dashFeatOn(key) {
  return document.body.classList.contains('feat-' + key);
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
  // Initial 30d window. The deep Reports build (~28 aggregate queries) is
  // DEFERRED to the first Reports visit — at boot it used to queue ahead of the
  // visible cards and was the main reason the dashboard sat on "Loading…".
  dashSetRange('30', { defer: true });
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
// RIGHT-NOW HERO (phase 2/3) — live presence + today's mini-KPIs.
// Pulls /api/retail-admin/dashboard/presence (15s) and a single
// /api/retail-admin/dashboard?from=today&to=today (60s for the "Today"
// mini-row). Polling pauses while the document is hidden so we don't
// hammer the server with a backgrounded tab.
// ════════════════════════════════════════════════════════════════
const DASH_HERO = { presence:null, today:null, lastSync:0 };
const DASH_HERO_INTERVALS = { presence: 15000, today: 60000 };

// A few backoff retries per surface when its FIRST load fails — without this a
// tripped boot request left the card on "Loading…"/"¥—" until the next 60s
// poll, and a manual page refresh was genuinely the fastest fix. One 3s retry
// wasn't enough: the bad first-load window (cold server / SW still activating)
// often outlasts a single attempt, so the card stayed stuck. We now retry on a
// widening schedule, then — because the un-polled list blocks (week, incoming,
// drafts, moves, onroad, ready, recap) have no 60s backstop of their own and
// would otherwise sit on "Loading…" forever when the whole boot window is bad
// (cold server + a thundering herd of ~20 parallel boot fetches all racing the
// 6-connection cap) — keep retrying on a steady 30s cadence until the surface
// fills. The steady phase is capped so a genuinely dead endpoint eventually
// stops; the surface's own poll / live nudge still covers it after that. Later
// poll failures stay silent as before (last good numbers are already on screen).
const DASH_BOOT_BACKOFF = [3000, 5000, 9000, 15000];
const DASH_BOOT_STEADY_MS = 30000;
const DASH_BOOT_STEADY_MAX = 20;   // ~10 more min of steady retries after the ramp
const DASH_BOOT_RETRIED = {};
function dashBootRetry(key, fn) {
  const n = DASH_BOOT_RETRIED[key] || 0;
  const steady = n >= DASH_BOOT_BACKOFF.length;
  if (steady && n >= DASH_BOOT_BACKOFF.length + DASH_BOOT_STEADY_MAX) return false;
  DASH_BOOT_RETRIED[key] = n + 1;
  setTimeout(fn, steady ? DASH_BOOT_STEADY_MS : DASH_BOOT_BACKOFF[n]);
  return true;
}

function dashHeroInit() {
  // Single bootstrap — once wired, the timers + visibility listener carry it.
  if (DASH_HERO._wired) { dashHeroRefreshAll(); return; }
  DASH_HERO._wired = true;
  // Language toggle repaints the Today delta badges from the stashed data.
  if (window.onLangChange) onLangChange(dashHeroTodayRepaint);
  // ...and the incoming-PO list (dates + "lines" are JS-built).
  if (window.onLangChange) onLangChange(() => {
    if (DASH_HERO.incoming) dashIncomingRender();
  });
  // ...and the drafts-to-send list.
  if (window.onLangChange) onLangChange(() => {
    if (DASH_HERO.drafts) dashDraftsRender();
  });
  // ...and the on-the-road list (channel + stage words are JS-built).
  if (window.onLangChange) onLangChange(() => {
    if (DASH_HERO.onroad) dashOnroadRender();
  });
  // ...and the ready-to-hand-off list.
  if (window.onLangChange) onLangChange(() => {
    if (DASH_HERO.ready) dashReadyRender();
  });
  // The delta badges explain their comparison through the product's own
  // tooltip (data-tt, 01-core.js) — dashSetDelta writes the text and the shared
  // component does the rest, so there is nothing to wire up here any more.
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
  // When this is a resume from a hidden tab, lastSync is however old the tab is
  // and the refresh below has not landed yet. dashRenderSync reads this stamp
  // so it holds its warning until the refresh has had a fair chance.
  DASH_HERO._resumedAt = Date.now();
  dashHeroRefreshAll();
  DASH_HERO.presence = setInterval(dashHeroLoadPresence, DASH_HERO_INTERVALS.presence);
  DASH_HERO.today    = setInterval(dashHeroLoadToday,    DASH_HERO_INTERVALS.today);
  // Keep the relative "synced Xs ago" stamp ticking between polls.
  DASH_HERO._syncTimer = setInterval(dashRenderSync, 10000);
}
function dashHeroStop() {
  for (const k of ['presence', 'today']) {
    if (DASH_HERO[k]) { clearInterval(DASH_HERO[k]); DASH_HERO[k] = null; }
  }
  if (DASH_HERO._syncTimer) { clearInterval(DASH_HERO._syncTimer); DASH_HERO._syncTimer = null; }
}
function dashHeroRefreshAll() {
  // Above-the-fold first: the hero pulse + today KPIs + presence. On a cold
  // first boot several GETs fire at once — near the browser's 6-connection-per-
  // host cap — and each GET's 20s abort timer starts when it's ENQUEUED, not
  // when it's sent. A card whose fetch sat behind the cap could burn its whole
  // budget waiting and abort before hitting the wire, leaving it stuck on
  // "Loading…" until a retry ramp caught up. So we let the visible cards go
  // first and defer the below-the-fold list blocks a beat, keeping the initial
  // in-flight count at/under the cap. Only the FIRST (boot) call staggers; later
  // refreshes (tab-return, live nudge) run flat.
  dashHeroLoadPresence();
  dashHeroLoadToday();
  const rest = () => {
    dashIncomingLoad();
    dashDraftsLoad();
    dashOnroadLoad();
    dashReadyLoad();
  };
  if (DASH_HERO._booted) { rest(); return; }
  DASH_HERO._booted = true;
  setTimeout(rest, 700);
}

// ── Live push (SSE) ────────────────────────────────────────────────────────
// Subscribe to the admin-wide live hub (retailLiveSubscribe, 01-core.js). It
// nudges us whenever the tenant's order / customer / wholesale streams move,
// so the recap, the open feed, and the Today pulse update the moment something
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
  dashHeroLoadToday();  // today KPIs + sparkline
  dashOnroadLoad();     // out-for-delivery list (dispatch/CS; role-guarded)
  dashReadyLoad();      // ready-to-hand-off list (dispatch/CS; role-guarded)
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
// Silent while the data is fresh; speaks only when it is not.
//
// This shipped for one day as a running "synced 12s ago" caption, and that was
// the wrong shape. Presence re-stamps every 15s and this repaints every 10, so
// the caption could only ever read "just now" or a single-digit age — a field
// whose value never varies is furniture, not information. Worse, the one moment
// it had something to say (polling silently dead, numbers frozen but still
// looking authoritative) it said it in 11px grey in a corner, which is the
// wrong loudness for what is really a correctness problem.
//
// So it is inverted: nothing at all under the threshold, a plain amber warning
// over it. The everyday "are we live?" question is already answered by the
// pulsing live-poll dot in the topbar; this exists only to catch the case that
// dot does NOT cover — polling that is failing rather than paused.
const DASH_SYNC_STALE_S = 180;   // 12 missed presence polls
// Returning to a hidden tab restarts the timers AND fires a refresh, but that
// refresh is in flight — lastSync is still the old one until it lands. Without
// this grace a slow response would flash a warning that is about to be untrue,
// and a warning that cries wolf is worth less than no warning.
const DASH_SYNC_RESUME_GRACE_MS = 20000;
function dashRenderSync() {
  const el = $('#db-hero-sync'); if (!el) return;
  const quiet = () => { el.hidden = true; el.textContent = ''; el.classList.remove('is-stale'); };
  if (!DASH_HERO.lastSync) return quiet();
  const secs = Math.max(0, Math.round((Date.now() - DASH_HERO.lastSync) / 1000));
  if (secs < DASH_SYNC_STALE_S) return quiet();
  if (Date.now() - (DASH_HERO._resumedAt || 0) < DASH_SYNC_RESUME_GRACE_MS) return quiet();
  const m = Math.floor(secs / 60);
  el.textContent = cuT(`Not updating — last synced ${m}m ago`, `未在更新 — ${m}分钟前同步`);
  el.classList.add('is-stale');
  el.hidden = false;
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
    if (num) dashCountUp(num, v);
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

// ── Boot readiness ──────────────────────────────────────────────────────────
// The boot splash (retail-admin.html) holds the Tacet mark until the home has
// real numbers on screen, not just an empty shell. We stamp data-app-ready on
// <html> once BOTH first loads that fill the visible home have painted — the
// Today pulse (revenue) and The Recap. The splash leaves on that stamp; its own
// 8s failsafe still covers a load that never arrives.
const DASH_READY = { today: false, recap: false, done: false };
function dashMarkReady(part) {
  if (DASH_READY.done) return;
  DASH_READY[part] = true;
  if (DASH_READY.today && DASH_READY.recap) {
    DASH_READY.done = true;
    try { document.documentElement.setAttribute('data-app-ready', '1'); } catch (e) {}
  }
}

async function dashHeroLoadToday(opts) {
  // The store's own day. Server tolerates same-day from/to and returns 24
  // hourly trend buckets (revenue + orders) plus deltas-vs-yesterday.
  const todayShop = tdToday();
  // Manual refresh asks for a slow, zen roll-up; the auto-poller stays snappy.
  const dur = opts && opts.slow ? 2600 : undefined;
  try {
    const j = await api(`/api/retail-admin/dashboard?from=${todayShop}&to=${todayShop}${dashStoreQS()}`);
    const data = j.data || {};
    DASH_HERO.todayData = data;   // stashed so a language toggle can repaint without refetching
    const k = data.kpis || {};
    dashCountUp($('#db-today-rev'), Number(k.revenue || 0), n => acMoneyCompact(n), dur);
    dashCountUp($('#db-today-ord'), Number(k.orders || 0), undefined, dur);
    dashCountUp($('#db-today-new'), Number(k.new_customers || 0), undefined, dur);
    // The Today card is status, not a report: revenue + delta arrow, orders,
    // AOV, refunded. The intraday hourly chart + typical-day ghost were cut in
    // the simplification pass (an hour-by-hour comparison is a Reports job).
    dashHeroTodayRepaint();   // delta badges (language-aware)
    tdObservationRender();    // the day's one line — reads data.baseline
    dashMarkReady('today');   // one half of the boot-splash release signal
  } catch (e) {
    if (!DASH_HERO.todayData) dashBootRetry('today', dashHeroLoadToday);
  }
}

// Repaint the language-dependent bit of the Today card — the delta badges and
// their hover chips. Split from the loader so a language toggle reflows the
// wording without refetching (the numbers themselves are language-neutral).
function dashHeroTodayRepaint() {
  const data = DASH_HERO.todayData; if (!data) return;
  const k = data.kpis || {}, b = data.baseline || null;
  dashSetDelta('#db-today-rev-d', b && b.revenue, Number(k.revenue || 0), b, v => acMoneyCompact(v));
  dashSetDelta('#db-today-ord-d', b && b.orders,  Number(k.orders || 0),  b, v => dashTrim(v) + ' ' + cuT(v === 1 ? 'order' : 'orders', '单'));
  dashSetDelta('#db-today-new-d', b && b.new_customers, Number(k.new_customers || 0), b, v => dashTrim(v) + ' ' + cuT(v === 1 ? 'new customer' : 'new customers', '新客'));
  // The Customers card's vitals come from this same payload and are
  // language-aware, so they repaint here too.
  if (typeof tdSecPaint === 'function') tdSecPaint();
}
// Integer when whole, else one decimal — keeps "/day" averages readable.
function dashTrim(n) {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);
}
// Delta badge vs the SAME WEEKDAY, averaged over the last few weeks.
//
// The chip names how many of those weekdays actually existed — "vs the last 3
// Wednesdays", not a flat "4-week average" — because a shop three weeks old and
// a shop three years old otherwise show the identical sentence over wildly
// different confidence. A thin baseline has to read as thin.
//
// Nothing yet today → a calm dash, never an alarming ▼100%. No same-weekday
// history at all, or activity today against a flat-zero average → "new".
function dashSetDelta(sel, base, cur, baseline, fmtAvg) {
  const el = $(sel); if (!el) return;
  el.classList.remove('is-up', 'is-down', 'is-flat');
  ttSet(el, '');
  const days = baseline && baseline.days;
  if (!cur) {
    el.classList.add('is-flat'); el.textContent = '—';
    ttSet(el, cuT('none yet today', '今日暂无'));
    return;
  }
  if (!base || !days || base.delta == null) {
    el.classList.add('is-up'); el.textContent = '▲ ' + cuT('new', '新');
    ttSet(el, cuT('no same-weekday history yet', '暂无同一星期几的历史数据'));
    return;
  }
  const dow = dashWeekdayName(baseline.weekday, days);
  // When the server clipped the baseline days to the current time of day, the
  // average behind this arrow means "by now", not "all day", and the tooltip has
  // to say so — otherwise it reads as a full day's takings and the arrow looks
  // far worse than it is every morning.
  // An em dash inside each half, never " · ": that sequence is the i18n
  // splitter's divider, and a decorative one here would have the tooltip cut in
  // half at it (see ttSet).
  ttSet(el, baseline.clipped
    ? cuT(`vs the last ${days} ${dow.en} at this time — ${fmtAvg(base.avg)} each by now`,
          `较前 ${days} 个${dow.cn}同一时段 — 平均 ${fmtAvg(base.avg)}`)
    : cuT(`vs the last ${days} ${dow.en} — ${fmtAvg(base.avg)} each`,
          `较前 ${days} 个${dow.cn} — 平均 ${fmtAvg(base.avg)}`));
  const r = Math.round(base.delta);
  if (r > 0)      { el.classList.add('is-up');   el.textContent = '▲ ' + r + '%'; }
  else if (r < 0) { el.classList.add('is-down'); el.textContent = '▼ ' + Math.abs(r) + '%'; }
  else            { el.classList.add('is-flat'); el.textContent = '±0%'; }
}
// The weekday the baseline is built from, in both languages. The server sends
// an index (0–6, Sunday first) rather than a word, so the name follows the UI
// language instead of freezing in whichever one was live at first paint.
// English pluralises ("3 Wednesdays"); Chinese counts with 个 and does not.
function dashWeekdayName(idx, n) {
  const i = Number(idx);
  const en = DASH_DOW_EN[i] || '';
  return {
    en: en ? (n === 1 ? en : en + 's') : cuT('days', '天'),
    cn: DASH_DOW_CN[i] || '天',
  };
}
// Badge hover → reuse the spark chip to explain the comparison baseline.
// The delta badges used to carry their own tooltip: a spark-tip bubble parked
// at left:50%, top:0 with no viewport clamping and no flip. Both failures were
// visible at once on the Today card — the bubble hung off the left edge of the
// screen with its first words cut off, and what remained sat on top of the very
// figure it was explaining.
//
// None of that needed solving. The product has one tooltip (data-tt, 01-core.js)
// that clamps to the viewport, flips above/below, waits a beat before opening
// and is reachable by keyboard. This was a second, worse one. It is gone;
// dashSetDelta and ordSetDelta write data-tt through ttSet instead.
//
// dashSparkTipEl stays — the sparkline scrub is a different thing: a readout
// that tracks the cursor along a chart, not a hover explanation.

// ── Interactive sparkline scrub ──────────────────────────────────────────
// Render a sparkline into a wrap and stash its series so a hover can scrub it.
function dashRenderSpark(wrap, vals, labels, fmt, pulse, ghost) {
  if (!wrap) return;
  wrap.innerHTML = dashSparkline(vals, { dot: true, pulse: !!pulse, ghost: ghost });
  // Stash the shared scale so the hover-scrub places the dot on the same line
  // the ghost may have re-scaled.
  wrap._spark = { vals, labels, fmt, scale: dashSparkScale(vals, ghost) };
}
// Percent position of point `idx` — shared by the rendered dot and the scrub so
// the dot always lands exactly on the line vertex. Mirrors dashSparkline's math.
// `scale` (optional) forces a y-scale — used when a ghost series widened it.
function dashSparkPct(vals, idx, scale) {
  const W = 100, H = 24, pad = 2, n = vals.length;
  if (n < 2) return { x: 50, y: 50 };
  const max = scale ? scale.max : Math.max(1, ...vals);
  const min = scale ? scale.min : Math.min(0, ...vals);
  const span = (max - min) || 1;
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
  if (!_dashSparkTip) {
    _dashSparkTip = document.createElement('div');
    _dashSparkTip.className = 'db-spark-tip';
    // Its text is built here in one language and separated by " · " — exactly
    // the shape the i18n walker treats as an EN·CN pair and tears in half.
    _dashSparkTip.setAttribute('data-no-i18n', '');
  }
  if (_dashSparkTip.parentNode !== host) { _dashSparkTip.classList.remove('show'); host.appendChild(_dashSparkTip); }
  return _dashSparkTip;
}
function dashSparkMove(e) {
  const wrap = e.currentTarget, s = wrap._spark;
  if (!s || !s.vals || s.vals.length < 2) return;
  const rect = wrap.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const idx = Math.round(f * (s.vals.length - 1));
  const p = dashSparkPct(s.vals, idx, s.scale);
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
    const p = dashSparkPct(s.vals, s.vals.length - 1, s.scale);
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
// fcDeltaHover / fcDeltaLeave retired with the bespoke delta tooltip — the
// Orders KPI badges they served now carry data-tt like everything else, and
// their inline handlers came off the markup in the same change.
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

// On the way — purchase orders the buying department has placed and are in
// transit (status 'Ordered'), newest ETA first. Warehouse-only block. Its own
// pull; stays present with a calm empty line when nothing's inbound so the
// warehouse page never goes blank. Language-dependent (dates + "lines"), so it
// repaints on a language toggle from its stashed rows.
async function dashIncomingLoad() {
  if (!['warehouse', 'default'].includes(dashPos())) return;   // warehouse + owner; skip the pull elsewhere
  try {
    const j = await api('/api/retail-admin/purchases?status=Ordered');
    DASH_HERO.incoming = Array.isArray(j.data) ? j.data : [];
    dashIncomingRender();
  } catch (e) {
    if (!DASH_HERO.incoming) dashBootRetry('incoming', dashIncomingLoad);
  }
}
function dashIncomingRender() {
  const host = $('#td-incoming-list'); if (!host) return;
  const rows = DASH_HERO.incoming; if (!rows) return;
  if (!rows.length) {
    host.innerHTML = `<div class="td-muted">${cuT('Nothing on the way', '暂无在途采购')}</div>`;
    return;
  }
  // Soonest expected first; POs with no date sink to the bottom.
  const byEta = [...rows].sort((a, b) => (a.delivery_date || '9999').localeCompare(b.delivery_date || '9999'));
  const todayShop = tdToday();
  const etaLabel = d => {
    if (!d) return cuT('no date yet', '未定日期');
    if (d <= todayShop) return cuT('arrives today', '今日到货');
    // Was toLocaleDateString('en-GB') — "29 Jul", a British date on a product
    // whose English convention is American (§1.18). One of the four formats
    // C-02 counted, and the shared one renders both languages.
    const when = tdWhen(d, 'date');
    return cuT('by ' + when, '预计 ' + when);
  };
  host.innerHTML = byEta.slice(0, 5).map((po, i) => {
    const sup = (po.supplier || '').trim();
    const lines = Number(po.line_count || 0);
    const linesTxt = cuT(lines + (lines === 1 ? ' line' : ' lines'), lines + ' 项');
    const sub = [sup, linesTxt].filter(Boolean).join(cuT(' · ', ' · '));
    const soon = po.delivery_date && po.delivery_date <= todayShop;
    const cls = i >= 4 ? ' detail2' : (i >= 2 ? ' detail' : '');
    return `<div class="bx-in-row${cls}">
      <span class="bx-in-nm">${escapeHtml(po.po_number || '')}<span class="bx-in-sub">${escapeHtml(sub)}</span></span>
      <span class="bx-in-eta${soon ? ' is-soon' : ''}">${escapeHtml(etaLabel(po.delivery_date))}</span>
    </div>`;
  }).join('');
}

// Drafts to send — purchase orders the buying department has drafted but not yet
// placed (status 'Requested'), oldest first (a draft sitting longest most wants
// sending). Warehouse-only. Its own pull; calm empty line when none, so the
// warehouse page never blanks. Language-dependent (dates + "lines").
async function dashDraftsLoad() {
  if (!['warehouse', 'default'].includes(dashPos())) return;   // warehouse + owner; skip the pull elsewhere
  try {
    const j = await api('/api/retail-admin/purchases?status=Requested');
    DASH_HERO.drafts = Array.isArray(j.data) ? j.data : [];
    dashDraftsRender();
  } catch (e) {
    if (!DASH_HERO.drafts) dashBootRetry('drafts', dashDraftsLoad);
  }
}
function dashDraftsRender() {
  const host = $('#td-drafts-list'); if (!host) return;
  const rows = DASH_HERO.drafts; if (!rows) return;
  if (!rows.length) {
    host.innerHTML = `<div class="td-muted">${cuT('Nothing to send', '暂无待发送')}</div>`;
    return;
  }
  // Oldest draft first — the one sitting longest is the one to chase.
  const byAge = [...rows].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const dateLabel = d => {
    if (!d) return '';
    const when = tdWhen(String(d).slice(0, 10), 'date');
    return when ? cuT('drafted ' + when, when + '草拟') : '';
  };
  host.innerHTML = byAge.slice(0, 5).map((po, i) => {
    const sup = (po.supplier || '').trim();
    const lines = Number(po.line_count || 0);
    const linesTxt = cuT(lines + (lines === 1 ? ' line' : ' lines'), lines + ' 项');
    const sub = [sup, linesTxt].filter(Boolean).join(' · ');
    const cls = i >= 4 ? ' detail2' : (i >= 2 ? ' detail' : '');
    return `<div class="bx-in-row${cls}">
      <span class="bx-in-nm">${escapeHtml(po.po_number || '')}<span class="bx-in-sub">${escapeHtml(sub)}</span></span>
      <span class="bx-in-eta">${escapeHtml(dateLabel(po.date))}</span>
    </div>`;
  }).join('');
}

// Unhandled orders — orders in status='paid' that nobody has started preparing
// (the moment anyone acts, the order moves to 'preparing'). Reads the
// /dashboard/ops `unhandled` key — shared with the Needs-you pull, so no new
// poll cycle. Age is measured from `waiting_since` (the server's COALESCE of
// paid_at -> placed_at, so it is never null -> never "NaN min"), against
// DASH_OPS.server_now so a client clock skew never matters. NO money: this is a
// non-owner screen, so the order total the payload carries is never rendered.
function dashUnhandledRender() {
  const host = $('#td-unhandled-list'); if (!host) return;
  const u = (DASH_OPS && DASH_OPS.unhandled) || null;
  const foot = document.getElementById('td-unhandled-foot');
  if (!u) return;   // ops not loaded yet — leave the "Loading…" placeholder
  if (!u.count) {
    host.innerHTML = `<div class="td-muted">${cuT('Nothing waiting to start', '暂无待处理订单')}</div>`;
    if (foot) foot.textContent = '';
    return;
  }
  const ageTxt = (since) => {
    const mins = dashAgeMins(since);
    if (mins == null) return '';   // defensive — never render "NaN min"
    if (mins < 60) return cuT(`waiting ${mins}m`, `等待 ${mins} 分钟`);
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return cuT(`waiting ${hrs}h`, `等待 ${hrs} 小时`);
    return cuT(`waiting ${Math.floor(hrs / 24)}d`, `等待 ${Math.floor(hrs / 24)} 天`);
  };
  host.innerHTML = (u.items || []).slice(0, 5).map(it => `
    <div class="bx-in-row">
      <span class="bx-in-nm" data-no-i18n>${escapeHtml(it.order_no || '')}<span class="bx-in-sub">${escapeHtml(String(it.buyer || ''))}</span></span>
      <span class="bx-in-eta">${escapeHtml(ageTxt(it.waiting_since))}</span>
    </div>`).join('');
  if (foot) foot.textContent = cuT(`${u.count} waiting · oldest first`, `${u.count} 单待处理 · 最早优先`);
}

// On the road — orders out for delivery, with the live rider stage + ETA the
// orders list already attaches (o.courier = {stage, eta_seconds}). Dispatch /
// customer-service only; its own pull of the (heavy) orders list, role-guarded
// so no other role fetches it. Language-dependent (channel + stage words).
const DASH_CHAN_SHORT = {
  wechat: ['WeChat', '微信'], web: ['Web', '网店'],
  meituan: ['Meituan', '美团'], gzgrocery: ['gzgrocery', 'gzgrocery'], manual: ['Manual', '手动'],
  shop: ['Shop', '门店'],
};
async function dashOnroadLoad() {
  if (!['dispatch', 'customer_service', 'default'].includes(dashPos())) return;   // delivery-role + owner
  try {
    const j = await api('/api/retail-admin/orders?status=dispatched&limit=8');
    DASH_HERO.onroad = Array.isArray(j.data) ? j.data : [];
    dashOnroadRender();
  } catch (e) {
    if (!DASH_HERO.onroad) dashBootRetry('onroad', dashOnroadLoad);
  }
}
function dashOnroadRender() {
  const host = $('#td-onroad-list'); if (!host) return;
  const rows = DASH_HERO.onroad; if (!rows) return;
  if (!rows.length) {
    host.innerHTML = `<div class="td-muted">${cuT('Nothing out for delivery', '暂无配送中订单')}</div>`;
    return;
  }
  const stageOf = (o) => {
    const c = o.courier;
    if (c && c.stage === 'in_transit') {
      const m = c.eta_seconds != null ? Math.max(1, Math.round(c.eta_seconds / 60)) : null;
      return { txt: m != null ? cuT('On the way · ' + m + ' min', '配送中 · ' + m + ' 分钟') : cuT('On the way', '配送中'), soon: m != null && m <= 10 };
    }
    // Rider assigned but hasn't collected the parcel yet — not "en route" to the
    // customer, so must not share that copy (see routes/retail.js deliveryJobStage).
    if (c && c.stage === 'heading_to_pickup') return { txt: cuT('Rider coming', '骑手前往取货'), soon: false };
    if (c && c.stage === 'awaiting_dispatch') return { txt: cuT('Finding a rider', '正在找骑手'), soon: false };
    return { txt: cuT('Out for delivery', '配送中'), soon: false };
  };
  host.innerHTML = rows.slice(0, 5).map((o, i) => {
    const who = (o.recipient_name || o.nickname || '').trim();
    const cn = DASH_CHAN_SHORT[String(o.channel || '').toLowerCase()];
    const chan = cn ? cuT(cn[0], cn[1]) : '';
    const sub = [who, chan].filter(Boolean).join(' · ');
    const st = stageOf(o);
    const cls = i >= 4 ? ' detail2' : (i >= 2 ? ' detail' : '');
    return `<div class="bx-in-row${cls}">
      <span class="bx-in-nm">${escapeHtml('#' + (o.order_no || o.id || ''))}<span class="bx-in-sub">${escapeHtml(sub)}</span></span>
      <span class="bx-in-eta${st.soon ? ' is-soon' : ''}">${escapeHtml(st.txt)}</span>
    </div>`;
  }).join('');
}

// Ready to hand off — orders packed / being prepared (status 'preparing'),
// waiting for a rider to collect. Dispatch / customer-service only; role-guarded
// pull of the orders list. If a rider is already inbound (courier awaiting a
// pickup) the row says so; otherwise it reads "Packing".
async function dashReadyLoad() {
  if (!['dispatch', 'customer_service', 'default'].includes(dashPos())) return;   // delivery-role + owner
  try {
    const j = await api('/api/retail-admin/orders?status=preparing&limit=8');
    DASH_HERO.ready = Array.isArray(j.data) ? j.data : [];
    dashReadyRender();
  } catch (e) {
    if (!DASH_HERO.ready) dashBootRetry('ready', dashReadyLoad);
  }
}
function dashReadyRender() {
  const host = $('#td-ready-list'); if (!host) return;
  const rows = DASH_HERO.ready; if (!rows) return;
  if (!rows.length) {
    host.innerHTML = `<div class="td-muted">${cuT('Nothing waiting to hand off', '暂无待交接')}</div>`;
    return;
  }
  host.innerHTML = rows.slice(0, 5).map((o, i) => {
    const who = (o.recipient_name || o.nickname || '').trim();
    const cn = DASH_CHAN_SHORT[String(o.channel || '').toLowerCase()];
    const chan = cn ? cuT(cn[0], cn[1]) : '';
    const sub = [who, chan].filter(Boolean).join(' · ');
    // Two different things, and this card used to call both "Rider coming":
    // awaiting_dispatch means the courier is called and NOBODY has accepted yet, so
    // there is no rider to get the order ready for. Only heading_to_pickup has a
    // real rider travelling to the store, and only that one earns the urgency
    // highlight. Words from docs/tacet-delivery-vocabulary.md, "Courier stages".
    const cstage = o.courier && o.courier.stage;
    const st = cstage === 'heading_to_pickup' ? { txt: cuT('Rider coming', '骑手前往取货'), soon: true }
             : cstage === 'awaiting_dispatch' ? { txt: cuT('Finding a rider', '正在找骑手'), soon: false }
             : { txt: cuT('Packing', '打包中'), soon: false };
    const cls = i >= 4 ? ' detail2' : (i >= 2 ? ' detail' : '');
    return `<div class="bx-in-row${cls}">
      <span class="bx-in-nm">${escapeHtml('#' + (o.order_no || o.id || ''))}<span class="bx-in-sub">${escapeHtml(sub)}</span></span>
      <span class="bx-in-eta${st.soon ? ' is-soon' : ''}">${escapeHtml(st.txt)}</span>
    </div>`;
  }).join('');
}

// Tacet activity row — clean prose per the dashboard mockup. Returns
// { text, amount, badge }: `text` is the sentence, `amount` is the
// right-aligned money (muted), `badge` a small first-order pill. No icon,
// no bold type-label prefix. Drives the "Show the work" fold rows.
function tdFeedMeta(e) {
  const p = e.payload || {};
  const yuan = n => acMoney(n, 0);
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
  // dashJumpTab looks for a RAIL button, and Feedback has not had one since
  // Inbox moved to the topbar — so this jump was landing nowhere, and an
  // activity-feed click on a bug report did nothing at all. Goes through the
  // Inbox door now, which also marks the queue seen.
  dashOpenFeedback();
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

// ── Orders waiting for a delivery point ─────────────────────────────────────
// docs/tacet-delivery-point-confirmation-spec.md §7. A same-city push that
// could only place the address to a coarse area parks and waits for a person to
// point at the door. Nothing retries it and nothing times out, so unless
// something gathers these they sit unseen until a customer calls.
//
// ABSENT AT ZERO, not empty. Every sibling block on this page renders a
// "nothing waiting" line; this one removes itself. That is the spec, and the
// reason is that a standing "0 orders need a delivery point" trains people to
// stop reading the one line that only ever appears when it matters.
//
// Stage 4 (the Orders filter chip) was DECLINED, not deferred — see §6. So this
// block is the only surface that gathers parked orders, and its tomorrow marker
// is the only place the §5.2 day-before warning appears outside the drawer. If
// it is ever removed, that warning goes with it.
const DP_WORK_SHOWN = 5;
function dashNeedsPointRender() {
  const host = document.getElementById('td-needspoint-list');
  const sec  = document.getElementById('td-needspoint');
  const foot = document.getElementById('td-needspoint-foot');
  if (!host || !sec) return;
  const np = (DASH_OPS && DASH_OPS.needs_point) || null;
  // No payload yet is not the same as nothing parked, but both render as
  // absent — there is no "Loading…" state for a block whose resting state is
  // to not exist.
  if (!np || !np.count) { sec.hidden = true; host.innerHTML = ''; if (foot) foot.hidden = true; return; }

  // Never a dash. A field we do not have is said in words, because "—" on a
  // worklist reads as "nothing to do here" when it means "we don't know".
  const who = (it) => it.buyer || cuT('No name on the order', '订单未留姓名');
  // Fall back across the languages before falling back to the code: a store
  // named in only one language should print that name, not its slug.
  const where = (it) => cuT(it.store_en || it.store_cn, it.store_cn || it.store_en)
    || it.store_code || cuT('Store not recorded', '未记录门店');

  // The right-hand cell always answers "when does this run out of road?".
  // A date-scheduled order has a day it dies on (§5.2); a same-day one does
  // not, so it shows how long it has been parked instead — which is also what
  // the server sorted those rows by. Different words, so the two readings of
  // the column can never be confused for one another.
  const dayTxt = (iso) => {
    const d = new Date(iso + 'T00:00:00+08:00');
    if (isNaN(d.getTime())) return iso;
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    return cuT(`${mon} ${d.getDate()}`, `${d.getMonth() + 1}月${d.getDate()}日`);
  };
  const parkedTxt = (since) => {
    const mins = dashAgeMins(since);
    if (mins == null) return cuT('Parked', '已挂起');   // never "NaN", never a dash
    if (mins < 60) return cuT(`parked ${mins}m`, `已挂起 ${mins} 分钟`);
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return cuT(`parked ${hrs}h`, `已挂起 ${hrs} 小时`);
    return cuT(`parked ${Math.floor(hrs / 24)}d`, `已挂起 ${Math.floor(hrs / 24)} 天`);
  };

  host.innerHTML = (np.items || []).slice(0, DP_WORK_SHOWN).map((it) => {
    const tomorrow = it.date_posture === 'tomorrow';
    const when = it.promised_day
      ? (tomorrow
        ? cuT(`Tomorrow · ${dayTxt(it.promised_day)}`, `明天 · ${dayTxt(it.promised_day)}`)
        : dayTxt(it.promised_day))
      : parkedTxt(it.parked_since);
    return `
    <button type="button" class="dp-work-row" onclick="dashOpenNeedsPoint(${Number(it.id)})">
      <span class="dp-work-no" data-no-i18n>${escapeHtml(it.order_no || '')}</span>
      <span class="dp-work-who">${escapeHtml(who(it))} · ${escapeHtml(where(it))}</span>
      <span class="dp-work-when${tomorrow ? ' is-tomorrow' : ''}">${escapeHtml(when)}</span>
    </button>`;
  }).join('');

  // Capped, not paginated. The overflow line states the number and stops —
  // there is nowhere to send them now that the Orders chip is declined, and a
  // link that filtered nothing would be worse than a plain count.
  const rest = np.count - Math.min(np.count, DP_WORK_SHOWN);
  if (foot) {
    foot.hidden = rest <= 0;
    foot.textContent = rest > 0
      ? cuT(`and ${rest} more waiting for a delivery point`, `另有 ${rest} 单待确认配送点`)
      : '';
  }
  sec.hidden = false;
}

// Open the parked order's drawer over the dashboard. No tab change, same as
// dashOpenOrderFromFeed: openOrder() fetches by id on its own. The confirm
// surface is what the drawer renders for a row in needs_point, so this lands on
// it without asking for it by name.
//
// `focus: 'point'` scrolls that surface into view. Without it the drawer opens
// at the order header and the map sits below the items — the first build read
// as a dead link for a different reason (the outside-click dismisser ate the
// opening click; .dp-work-row is now exempt in 04-orders.js), and landing the
// operator at the top of a long drawer would have been the second.
//
// The argument is retail_orders.id — the internal numeric id, which is what
// /dashboard/ops sends as `id` and what openOrder fetches by. The row shows
// order_no (TC000218) and never passes it; the two must not be swapped.
function dashOpenNeedsPoint(orderId) {
  if (orderId !== null && orderId !== undefined && orderId !== '') openOrder(orderId, { focus: 'point' });
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
// "Ready from the kitchen" → the list that already exists, at /stock?go=ready.
//
// A SEPARATE DOCUMENT, DELIBERATELY, and the alternative was building a second
// copy of this list inside the admin. The Quick Stock app already renders it,
// the phone already opens exactly this URL from its own More row, and two
// surfaces rendering one list is the drift this codebase works to keep out —
// so the desktop opens the same screen rather than growing a twin of it.
//
// AND THE NAVIGATION IS THE POINT, not a side effect: /stock stamps `seen_at`
// for the rows it draws, which is the only acknowledgement this direction has.
// A row that merely stated the count with nowhere to go would never clear from
// this dashboard at all — the fire would burn until somebody picked up a phone.
//
// Same tab, no window.open: a popup blocker eats the second kind, silently, and
// the operator is left tapping a row that does nothing. /stock reads ?go= itself
// and refuses one the operator was not answered for, so this link can never open
// a screen a capability does not.
//
// &from=dashboard IS WHAT MAKES THE WAY BACK TRUE. /stock is a separate
// document with its own Back, and that Back is answered by lib/app-home.js —
// which knows one way out, '/m?to=more', because until this row existed every
// door into that app was a row in Tacet Mobile. Opening it from here in the
// same tab therefore sent a person at a PC to the phone app when they hit
// Back: a screen they were never on, and no way back to this board. The link
// names the door it is, /stock reads it (homeFromDoor in public/stock.html)
// and returns them to this dashboard by name.
function dashOpenKitchenReady() {
  window.location.href = '/stock?go=ready&from=dashboard';
}

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

// The two Inbox queues — Reviews and Feedback — are NOT rail tabs. They live in
// the topbar Inbox dropdown, so `dashJumpTab` (which queries `.tabs [data-tab]`)
// cannot reach either one, and this is the door instead.
//
// It CLICKS the menu button rather than calling goTab, for what the button does
// either side of the navigation: `_markInboxSeenNow` and `closeInboxMenu`. An
// operator who reaches the queue from a fire has read it, so the unseen badge
// must clear exactly as it does when they use the menu — a red dot still sitting
// on the Inbox icon after they have just worked the list is the badge lying.
// goTab alone leaves it lit.
//
// It does NOT click for the loading, any more: `TAB_INIT` registers
// reviewsTabInit/feedbackTabInit, so goTab populates both tabs on its own now.
// Both are idempotent (`if (LOADED) return`), so the click reaching the button's
// own listener AND goTab's TAB_INIT dispatch loads once, not twice.
//
// Hidden inside a collapsed dropdown is no obstacle — a programmatic click on a
// hidden button fires its handlers all the same.
function dashOpenInbox(which) {
  const btn = document.querySelector(`#tbInboxMenu [data-tab="${which}"]`)
           || document.querySelector(`[data-tab="${which}"]`);
  if (!btn) return false;
  btn.click();
  return true;
}
// The Reviews queue opens on its own "Needs reply" chip — which is already the
// page's default filter, so this only has to put it back when the operator left
// the page on a different one.
function dashOpenReviews() {
  if (!dashOpenInbox('reviews')) return;
  if (typeof rvwSetFilter === 'function' && RVW_FILTER !== 'needs') {
    // First open kicks off its own load; setting the filter before that lands
    // would be overtaken by it. A short poll waits for the list to exist, then
    // re-filters — and does nothing at all when 'needs' is already showing.
    let tries = 0;
    const tick = () => {
      if (document.querySelector('#rvw-chips .rvw-chip')) {
        if (RVW_FILTER !== 'needs') rvwSetFilter('needs');
        return;
      }
      if (tries++ < 30) setTimeout(tick, 150);
    };
    tick();
  }
}
function dashOpenFeedback() { dashOpenInbox('feedback'); }

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
//   3. Today — the pulse (revenue/orders/new customers + presence),
//      handled by dashHero*. The activity feed lives inside The Recap's
//      "Show the work" fold.
// ════════════════════════════════════════════════════════════════

let DASH_OPS = null;

// ── ageing a queue row ──────────────────────────────────────────────────────
// Every row that states how long something has waited measures from the ops
// snapshot's own clock, not the browser's: a laptop whose clock is an hour out
// would otherwise report "waiting 1h" on an order that landed a moment ago, or
// worse, a negative age clamped to 0. `server_now` rides along on every
// /dashboard/ops payload for exactly this.
function dashNow() {
  return Number(DASH_OPS && DASH_OPS.server_now) || Date.now();
}
// Minutes since `since`, or null when there is nothing real to measure. Accepts
// both shapes the payload carries: a bare SQLite UTC stamp ("YYYY-MM-DD
// HH:MM:SS", no zone marker — the common case) and a full ISO string with its
// own Z (the resolved local-delivery ETA). Appending a Z to the second would
// produce "…000ZZ" and parse to NaN, which is how a row silently renders blank.
// null — never 0 — for a missing value, so a caller can tell "no clock" apart
// from "arrived this second" and print a state instead of "0m".
function dashAgeMins(since) {
  const s = String(since || '').trim();
  if (!s) return null;
  const iso = /[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  if (!t || isNaN(t)) return null;
  return Math.max(0, Math.round((dashNow() - t) / 60000));
}
// "47m" → "4h" → "2d". Tabular by the stylesheet; the unit letters stay in both
// languages because they are read as a glyph, not a word — the surrounding copy
// carries the language.
function dashAgeShort(mins) {
  if (mins == null) return '';
  if (mins < 60) return mins + 'm';
  if (mins < 1440) return Math.round(mins / 60) + 'h';
  return Math.round(mins / 1440) + 'd';
}

// Pick a product's name in the active UI language, falling back to the
// other language when the preferred one is missing.
function dbProdName(o) {
  const cn = (window.cuLang && cuLang() === 'cn');
  return (cn ? (o.name_cn || o.name_en) : (o.name_en || o.name_cn)) || '—';
}

// workFromQuiet: the operator opened the day's log from the quiet line, so the
// Recap card is up on purpose with an empty window (see tdRecapLineShowWork).
const TD = { recapSince: 0, recapEvents: null, stores: null, stockStore: '', stockOps: null, workFromQuiet: false,
             lowRotAt: 0, _lowRotTimer: null, _lowRotPaused: false, _lowCnt: 0 };
let TD_LOW_POOL = [];   // ordered out-then-low pool the Running-low card rolls through
const TD_SEEN_KEY = 'retail-admin-last-seen';

function tdInit() {
  tdGreetRender();
  tdDateRender();
  TD_CLOCK_KEY = tdClockKey();
  tdObservationRender();   // no-op until the Today payload lands; hides itself
  tdEnsureStores();   // populate the Running-low store dropdown (multi-store only)
  // Language toggle repaints the JS-built strings (greeting, date, recap, attention).
  if (window.onLangChange) onLangChange(() => { tdGreetRender(); tdDateRender(); tdObservationRender(); tdRecapHeadPaint(); tdRecapRender(); tdRecapWorkRender(); tdRecapWorkBtnSync(); tdAttnRender(); tdSecPaint(); dashUnhandledRender(); dashNeedsPointRender(); dashStockDrawerRender(); });
  tdRecapLoad();     // reads the last-seen stamp BEFORE tdSeenInit overwrites it
  tdSeenInit();
  tdOpsLoad();
  tdSecCountsLoad();
  if (!TD._opsTimer) {
    TD._opsTimer = setInterval(() => { if (!document.hidden) { tdClockTick(); tdOpsLoad(); tdSecCountsLoad(); } }, 60000);
    // A hidden tab doesn't tick — a laptop shut on Sunday and opened on Tuesday
    // would show the stale header for up to a minute before the interval caught
    // it, which is exactly the moment someone is reading it. Inside the same
    // guard as the timer so a second tdInit can't stack a second listener.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tdClockTick(); });
  }
  // Restore the operator's saved card order, then watch the grid's width so the
  // lone-card span follows the column count.
  dashArrangeApply();
  dashArrangeWire();
}

// ════════════════════════════════════════════════════════════════
// THE CARD GRID — the dashboard as the operator's own space.
// Each .td-block[data-block] is one tile in a CSS grid whose column
// count comes from a container query, so a card's height is set by
// its own content and a row ends flat against the tallest card in it.
// The operator's saved order is applied as CSS `order`; live data
// keeps landing in the blocks' inner ids untouched.
// ════════════════════════════════════════════════════════════════
// The key stays at -v10 through this release. dashArrangeApply filters a saved
// order against DASH_BLOCK_DEFAULT and appends anything missing, so dropping
// `needs` out of the set self-heals every stored layout without a bump — and a
// bump would throw away an order the operator chose, for no gain.
const DASH_LAYOUT_KEY = 'retail-admin-dash-layout-v10';
// Needs-you is deliberately NOT here. It is not a tile: it is full width, first,
// and lives outside #td-blocks, so it has no place in the grid and no place in
// the order. Nothing can move it and nothing can hide it.
const DASH_BLOCK_DEFAULT = ['recap', 'orders', 'customers', 'unhandled', 'inventory', 'incoming', 'onroad', 'ready', 'delivery'];

// ── the card grid ───────────────────────────────────────────────────────────
// Cards are placed by CSS grid inside a container query. What used to live here
// was a packing solver: every card declared a menu of [w,h] shapes, the solver
// picked one per visible card so each row filled six columns exactly, wrote the
// result as absolute pixel rects, and the card's CONTENT was then folded away
// with [data-tier] + .detail/.detail2 until it fit the box it had been handed.
//
// That is backwards. A card's height should come from what the card has to say,
// not the other way round. So the shape menus, the packer and the tier tables
// are gone, and two rules stand in their place:
//
//   A — cards in a row stretch to the tallest card's own content, and every
//       card's footer pins to its bottom edge, so the slack collects above the
//       footer and the row ends flat. Pure CSS: the grid stretches its items,
//       and each card's footer carries margin-top:auto.
//   B — a card that would otherwise sit alone in the last row spans the row.
//
// Only B needs script, because CSS cannot count tiles against the resolved
// column count. dashRender does exactly that and nothing else — no geometry, no
// pixel heights, no absolute positioning, no shapes.
//
// Needs-you is NOT in this grid. It is full width, structurally first, and
// lives outside #td-blocks, which is also why it cannot be dragged out of
// position — there is no position for it to be dragged out of.

// Column thresholds, in px of the grid's own width. These MIRROR the @container
// rules in retail-admin.css; change them in both places together or Rule B will
// span the wrong card at a band edge.
const DASH_COL_2 = 760, DASH_COL_3 = 1140;

let DASH_ORDER = [...DASH_BLOCK_DEFAULT];

function dashLayoutLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(DASH_LAYOUT_KEY) || '{}');
    return { order: Array.isArray(v.order) ? v.order : [] };
  } catch (e) { return { order: [] }; }
}

// Resolve the column count the CSS has landed on, from the grid's own width.
function dashCols(w) { return w >= DASH_COL_3 ? 3 : w >= DASH_COL_2 ? 2 : 1; }

// Place the cards: order them, then apply Rule B. Everything else is CSS.
function dashRender() {
  const host = document.getElementById('td-blocks');
  if (!host) return;

  // If the grid has no measurable width yet (the dashboard laid out before its
  // tab is shown, or the rail's margin transition hasn't settled) the column
  // count would resolve to 1 and Rule B would span the wrong card. Defer a
  // frame; the ResizeObserver re-runs this once the width lands.
  if (host.clientWidth === 0) { requestAnimationFrame(dashRender); return; }

  const tiles = [];
  host.querySelectorAll('.td-block').forEach(el => {
    const id = el.dataset.block;
    // Orphans: markup for a card that has left the set — or moved out of the
    // grid entirely, as Needs-you did — can linger until a later commit deletes
    // it. Drop it out of the flow rather than let it hold an empty cell.
    if (!DASH_BLOCK_DEFAULT.includes(id)) { el.style.display = 'none'; return; }
    // Reordering is CSS `order`, never a DOM move: the loaders paint into these
    // nodes by id, and re-parenting them mid-poll would strand a render.
    el.style.order = DASH_ORDER.indexOf(id);
    el.classList.remove('td-span');
    // A card with nothing to say today marks itself .is-quiet and leaves the
    // page (CSS hides it); a card the operator's ROLE hides is display:none from
    // the DASHBOARDS BY POSITION rules. Neither occupies a cell, so neither can
    // be the card left alone in the last row.
    if (el.classList.contains('is-quiet')) return;
    if (getComputedStyle(el).display === 'none') return;
    tiles.push(el);
  });

  // Rule B — the last row holds one card, so give it the whole row. Worked out
  // from tile count against the resolved column count, never placed by hand, so
  // the five-card warehouse and dispatch sets land the same way as the owner's
  // four without anyone writing a rule for either.
  // Cap the grid at the number of cards actually showing. With three columns
  // and two cards the pair sat against the left edge with an empty column
  // beside them — the layout describing a card that is not there, which is
  // exactly what happens on a quiet day when The Recap steps off the page. CSS
  // cannot do this itself: it cannot count the cards that survived the quiet
  // and role-hidden filters above. Only ever narrower than the width allows,
  // never wider.
  const rawCols = dashCols(host.clientWidth);
  const cols = Math.max(1, Math.min(rawCols, tiles.length));
  host.classList.remove('is-cols-1', 'is-cols-2');
  if (tiles.length && tiles.length < rawCols) host.classList.add('is-cols-' + tiles.length);
  // Rule B is measured against the capped count, or it would span a card that
  // is already full width and, worse, read 2 % 3 as a partial row needing one.
  if (cols > 1 && tiles.length % cols === 1) {
    tiles.sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0));
    tiles[tiles.length - 1].classList.add('td-span');
  }
  host.classList.add('td-solved');
}

// Restore the operator's saved card order, then paint. A block missing from the
// saved order surfaces at the tail (a card added in a later release appears
// rather than vanishes); unknown ids are dropped.
//
// The saved `widths` (the half/full pins the old drop-beside gesture wrote) and
// the saved `hidden` set are both IGNORED now, deliberately and for different
// reasons. Widths described shapes in a six-column packer that no longer
// exists. Hidden is worse than obsolete: with Arrange stood down there is no
// way to bring a card back, so honouring an old hide would silently strip a
// card off the dashboard for good. Both keys stay in localStorage untouched —
// ship 2 rewrites the layout record once Arrange returns.

// DASHBOARD CARDS, PICKED PER ROLE — window.RA_DASH_CARDS (02-settings-ops
// bootstrap) is either null (no owner override — the body.pos-* rules in
// DASHBOARDS BY POSITION, retail-admin.css, keep deciding by `layout` exactly
// as before this existed) or an explicit array an owner chose in the Roles
// editor. An array is authoritative regardless of `layout`: applied here as an
// inline style, which beats those CSS rules on specificity alone.
//
// Only the fixed catalog below is touched — DASH_CARD_KEYS mirrors lib/roles
// DASH_CARDS exactly, deliberately excluding `needspoint` (Orders waiting for
// a delivery point): that block is absent-when-empty by its own design (§7,
// the markup comment above #td-needspoint) and "not a matter of taste" — no
// role override may hide it.
//
// An allowed card's inline display is CLEARED, not forced on: the override
// only ever REMOVES cards, so a quiet card (.is-quiet) or one with nothing to
// poll today still leaves the page the normal way.
const DASH_CARD_KEYS = ['needs', ...DASH_BLOCK_DEFAULT];
function dashCardGate() {
  if (!Array.isArray(window.RA_DASH_CARDS)) return;
  const allow = new Set(window.RA_DASH_CARDS);
  DASH_CARD_KEYS.forEach(key => {
    document.querySelectorAll('[data-block="' + key + '"]').forEach(el => {
      el.style.display = allow.has(key) ? '' : 'none';
    });
  });
}

function dashArrangeApply() {
  dashCardGate();
  const { order } = dashLayoutLoad();
  const known = DASH_BLOCK_DEFAULT;
  const seq = (order && order.length ? order : DASH_BLOCK_DEFAULT).filter(id => known.includes(id));
  known.forEach(id => { if (!seq.includes(id)) seq.push(id); });
  DASH_ORDER = seq;
  dashRender();
}

// Re-run Rule B when the grid's width changes — the column count moves with it,
// and so does which card is left alone.
function dashArrangeWire() {
  const host = document.getElementById('td-blocks');
  if (!host || host._bentoWired) return;
  host._bentoWired = true;
  window.addEventListener('resize', () => dashRender());
  if (window.ResizeObserver) {
    let w = host.clientWidth;
    new ResizeObserver(() => { if (host.clientWidth !== w) { w = host.clientWidth; dashRender(); } }).observe(host);
  }
  // Webfonts and the rail's margin transition can both land after the first
  // paint; re-run once everything has settled.
  if (document.readyState !== 'complete') window.addEventListener('load', () => dashRender(), { once: true });
}

// ── Arrange — stood down for this release ───────────────────────────────────
// The drag gesture read the solver's pixel rects to decide where a dropped card
// belonged, and those rects no longer exist. Rather than ship a half-working
// drag, the control is hidden (CSS) and rebuilt in the next release against
// live element boxes, with the old half/full width pins becoming grid spans.
// The markup — the Arrange button, each card's hide ✕, the tray — is left in
// place so that rebuild is a behaviour change and not a markup change. These
// stubs exist because that markup still carries inline onclick handlers: a
// hidden button can still be reached by a script or a stale accessibility tree,
// and a missing function there would throw rather than do nothing.
const DASH_ARRANGING = false;
function dashArrangeToggle() {}
function dashArrangeHide() {}
function dashArrangeShow() {}
function dashArrangeReset() {}
function dashArrangeChromePaint() {}

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

// The greeting line. Bands: 05–12 morning · 12–17 afternoon · 17–23 evening ·
// 23–05 late. Read off the BROWSER's clock, not the store's timezone — this
// greets the person at the keyboard, and a manager checking Guangzhou trade
// from another country is still having their own morning.
//
// There was a weekend override here ("Happy weekend") that beat every band, so
// Saturday never said good morning. Wrong product: a shop's weekend is its
// busiest trading, and wishing a happy weekend to someone working the Saturday
// rush lands badly. Time of day is true seven days a week.
function tdGreetLine() {
  const name = tdGreetName();
  const nm = name ? ', ' + name : '', nmCn = name ? '，' + name : '';
  const h = new Date().getHours();
  if (h >= 5  && h < 12) return cuT(`Good morning${nm}`,   `早上好${nmCn}`);
  if (h >= 12 && h < 17) return cuT(`Good afternoon${nm}`, `下午好${nmCn}`);
  if (h >= 17 && h < 23) return cuT(`Good evening${nm}`,   `晚上好${nmCn}`);
  return name ? cuT(`Still up, ${name}?`, `还没休息${nmCn}？`) : cuT('Still up?', '还没休息?');
}

// Paint the greeting heading. There was a "Here's your Thursday." sub-line too;
// it is gone. The header no longer carries a date element beside it for the
// weekday to pair with, and a second line of text that tells the operator
// nothing they can act on is the kind of thing that reads once and becomes
// wallpaper.
function tdGreetRender() {
  const el = document.getElementById('td-greeting'); if (!el) return;
  el.textContent = tdGreetLine();
}

// Today's date under the page title — the calm anchor for "Today" numbers.
// Today's date under the greeting, weekday first — the weekday is the part
// that does work here, because every delta on this page compares against the
// same weekday over the last four weeks.
//
// Goes through tdWhen (§1.18) rather than building the string by hand. What was
// here before called toLocaleDateString('en-GB'), which renders "Tuesday, 29
// July" — British order, in an app whose own rule says English is US-style. The
// shared formatter owns that decision for both languages, so this no longer has
// an opinion about it.
function tdDateRender() {
  const el = document.getElementById('td-date'); if (!el) return;
  el.textContent = (typeof tdWhen === 'function') ? tdWhen(new Date(), 'weekday') : '';
}

// ── Keeping those two honest over a long-lived tab ──────────────────────────
// Both lines above are painted once at boot and then never again, and an admin
// tab is routinely left open for days — so a tab opened on Sunday evening was
// still greeting "Good evening" over "Sunday, August 9" on Tuesday. Every
// number on the page had refreshed underneath it; only the header was lying.
//
// The two lines roll at different moments, on different clocks: the greeting
// band turns on the BROWSER's hour (it greets the person at the keyboard,
// tdGreetLine), and the date turns on the STORE's day (tdWhen renders in the
// store timezone). One key covers both, and repainting only when that key
// changes keeps the common tick free of DOM writes.
let TD_CLOCK_KEY = '';
function tdClockKey() {
  const now = new Date();
  const day = (typeof tdWhen === 'function') ? tdWhen(now, 'machine') : '';
  return day + '|' + now.getHours();
}
function tdClockTick() {
  const k = tdClockKey();
  if (k === TD_CLOCK_KEY) return;
  TD_CLOCK_KEY = k;
  tdGreetRender();
  tdDateRender();
}

// ── The day's one observation ───────────────────────────────────────────────
// A single sentence under the date, and only when there is genuinely one to
// say. Three rules decide what may appear here:
//
//   1. It must be TRUE from the payload — never an encouraging guess.
//   2. It must be neutral or good. "Your worst Tuesday in a month" is also a
//      daily observation and nobody wants to be greeted by it; bad news has a
//      home on this page already (Needs you) and does not belong in a hello.
//   3. It must not repeat a card. Every card on this dashboard states its own
//      number, so "14 new customers today" is not an observation, it is the
//      Customers card read aloud. What no card can show is how today compares
//      with the same weekday behind it — which is exactly what these two say.
//
// Silence is a valid, and normal, outcome: most days beat nothing and trail
// nothing worth mentioning, and a line that speaks every day stops being read
// by the end of the week. Nothing to say ⇒ the span stays hidden.
function tdObservationRender() {
  const el = document.getElementById('td-observation'); if (!el) return;
  const b = ((DASH_HERO && DASH_HERO.todayData) || {}).baseline || null;
  const say = (en, cn) => { el.textContent = cuT(en, cn); el.hidden = false; };
  el.hidden = true; el.textContent = '';
  if (!b || !(b.days >= 2)) return;   // too little history to compare against
  const dowEn = DASH_DOW_EN[b.weekday] || '';
  const dowCn = DASH_DOW_CN[b.weekday] || '';
  // Outright ahead of every same weekday behind it — the rarer, better fact,
  // so it wins when both are true.
  // "So far" / "at this point" are load-bearing, not padding: the days behind
  // today are cut at the current time of day, so this compares a morning with
  // four mornings. Without those words the line would promise a whole day's
  // record at 07:00 and quietly break it by lunch.
  if (b.best_in_weeks) return say(`Best ${dowEn} in ${b.days} weeks so far.`,
                                  `目前是最近 ${b.days} 周里最好的${dowCn}。`);
  // Clearly ahead of the average of them. The floor is 15% rather than 0 so
  // this stays a remark worth making instead of noise about a rounding win.
  const d = b.revenue && b.revenue.delta;
  if (d != null && d >= 15) return say(`Ahead of a typical ${dowEn} at this point.`,
                                       `目前比往常的${dowCn}要好。`);
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
  tdRecapHeadPaint();   // paint the title/meta NOW, from the framing just decided —
                        // so the glued static placeholder never survives a slow/failed load
  try {
    const j = await api(`/api/retail-admin/dashboard/activity?since=${since}&limit=500`);
    TD.recapEvents = (j.data && j.data.events) || [];
    tdRecapRender();
    dashMarkReady('recap');   // other half of the boot-splash release signal
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

// Paint just the Recap's title + meta from the framing decided in tdRecapLoad.
// Split out of tdRecapRender so it runs the instant the framing is known —
// before, and independent of, the activity fetch. That way the static bilingual
// placeholder ("While you were away · 您不在的这段时间", which is data-no-i18n so
// the toggle can't split it) is replaced with the single active-language title
// even when the load is slow or fails, instead of leaking both languages.
function tdRecapHeadPaint() {
  if (!TD.recapSince) return;   // framing not computed yet (tdRecapLoad hasn't run)
  const title = document.getElementById('td-recap-title');
  const meta = document.getElementById('td-recap-meta');
  // Promoted from the quiet line: nothing happened in the recap window, so
  // framing the card as "the last 30 minutes" would label a whole day's feed
  // with a window it isn't. Say what the fold actually holds.
  if (TD.workFromQuiet) {
    if (title) title.textContent = cuT("Today's activity", '今日动态');
    if (meta) meta.textContent = cuT('since midnight', '自午夜起');
    return;
  }
  if (title) title.textContent = TD.reallyAway
    ? cuT('While you were away', '您不在的这段时间')
    : cuT('Latest activity', '最新动态');
  if (meta) meta.textContent = TD.reallyAway ? tdSinceLabel(TD.recapSince) : tdRecentLabel(TD.recapSince);
}

// True when this operator's dashboard shows NO business money — warehouse and
// the delivery roles (dispatch / customer-service). Money-gating rides the
// RELIABLE role string, never the fail-open cap check: a ¥ must never leak on a
// null-caps session, so this mirrors the money-card CSS gate, not caps. (This
// gates REVENUE framing — "N paid — ¥1,240" — and the fold's amounts. It does
// NOT touch the refund/invoice Needs-you cards, whose ¥ is the operational value
// CS acts on, not the business's takings.)
function tdRecapNoMoney() { return ['warehouse', 'dispatch', 'customer_service'].includes(dashPos()); }

// Aggregate the recap window's events into calm one-line rows, each with a
// breathing Dusk dot — Dusk means "the system did this", and this card is the
// only place on the dashboard that uses it.
function tdRecapRender() {
  const host = document.getElementById('td-recap-rows'); if (!host || !TD.recapEvents) return;
  tdRecapHeadPaint();
  const ev = TD.recapEvents;
  const of = type => ev.filter(e => e.type === type);
  const sumAmt = (rows, k) => rows.reduce((s, e) => s + (Number(e.payload && e.payload[k]) || 0), 0);
  const money = n => acMoneyCompact(n);

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
  // The Recap is framed to the operator's work. Three shapes:
  //   • owner        — everything, with the money (paid — ¥, refunds, top-ups).
  //   • warehouse    — their queue: paid framed as "entered your queue" (no ¥),
  //                    dispatched, wholesale pickups. No deliveries.
  //   • dispatch/CS  — orders in motion: dispatched + delivered. No queue, no
  //                    pickups, no money.
  // The money/customer rows (refunds, top-ups, new customers, auto-cancels) are
  // owner-only. NOTE — two rows the mockups showed have no event source and so
  // are not rendered: "N POs arrived" (warehouse) and "N riders assigned"
  // (dispatch); both are separate backend events (po_received / rider_assigned),
  // backlogged. The mockup showed the aspiration; the code ships what's real.
  const noMoney = tdRecapNoMoney();
  const wh = dashPos() === 'warehouse';
  const delivery = ['dispatch', 'customer_service'].includes(dashPos());
  // paid — owner's money / warehouse's queue; the delivery roles don't handle it.
  if (paid.length && !delivery) {
    if (wh) push(`<b>${paid.length}</b> ${paid.length === 1 ? 'order' : 'orders'} entered your queue`,
                 `<b>${paid.length}</b> 笔订单进入待处理队列`);
    else    push(`<b>${paid.length}</b> ${paid.length === 1 ? 'order' : 'orders'} paid — ${money(sumAmt(paid, 'total'))}`,
                 `<b>${paid.length}</b> 笔订单已支付，共 ${money(sumAmt(paid, 'total'))}`);
  }
  // dispatched — went out for delivery; relevant to everyone.
  if (dispatched.length) push(`<b>${dispatched.length}</b> ${dispatched.length === 1 ? 'order' : 'orders'} dispatched`,
                              `<b>${dispatched.length}</b> 个订单已发货`);
  // delivered — completed deliveries; owner + the delivery roles, not warehouse.
  if (delivered.length && !wh)  push(`<b>${delivered.length}</b> ${delivered.length === 1 ? 'order' : 'orders'} delivered`,
                              `<b>${delivered.length}</b> 个订单已送达`);
  if (!noMoney && autoCanc.length)   push(`<b>${autoCanc.length}</b> unpaid ${autoCanc.length === 1 ? 'order' : 'orders'} cancelled automatically`,
                              `<b>${autoCanc.length}</b> 个未付款订单已自动取消`);
  if (!noMoney && refunded.length)   push(`<b>${refunded.length}</b> ${refunded.length === 1 ? 'refund' : 'refunds'} settled — ${money(sumAmt(refunded, 'amount'))}`,
                              `<b>${refunded.length}</b> 笔退款已完成，共 ${money(sumAmt(refunded, 'amount'))}`);
  if (!noMoney && topups.length)     push(`<b>${topups.length}</b> wallet ${topups.length === 1 ? 'top-up' : 'top-ups'} — ${money(sumAmt(topups, 'amount'))}`,
                              `<b>${topups.length}</b> 笔钱包充值，共 ${money(sumAmt(topups, 'amount'))}`);
  if (!noMoney && newCust.length)    push(`<b>${newCust.length}</b> new ${newCust.length === 1 ? 'customer' : 'customers'} joined`,
                              `新增 <b>${newCust.length}</b> 位客户`);
  // wholesale pickups — a stock movement; owner + warehouse, not the delivery roles.
  if (pickups.length && !delivery)    push(`<b>${pickups.length}</b> gzgrocery ${pickups.length === 1 ? 'pickup' : 'pickups'} recorded`,
                              `记录 <b>${pickups.length}</b> 笔 gzgrocery 提货`);

  const close = document.getElementById('td-recap-close');
  const block = host.closest('.td-block');
  const line  = document.getElementById('td-recap-line');
  // `workFromQuiet` means the operator opened the day's log FROM the quiet line,
  // so the card is deliberately on the page with an empty recap window. Skipping
  // the quiet branch keeps the 60s poll from yanking it back out from under them.
  if (!rows.length && !TD.workFromQuiet) {
    // Nothing happened while they were away, so the Recap does not need a card
    // to say so. It leaves the grid entirely and becomes one line of quiet text
    // above the remaining cards — which also means a calm dashboard carries no
    // cream at all and reads as quiet rather than as empty furniture. The card
    // keeps its markup and its place in the order, so a busy morning brings it
    // back without rebuilding anything.
    // It used to add "Nothing needed doing." — a claim this line is not
    // entitled to make. The Recap watches the ACTIVITY FEED and nothing else;
    // it cannot see stock, and the Needs-you card directly above it is what
    // owns the question of whether anything needs doing. On a morning with 15
    // products out of stock the two sat one line apart contradicting each
    // other, and the reassuring one was the bigger sentence. So the line now
    // says only what it can actually know: the feed was quiet.
    const lineTxt = document.getElementById('td-recap-line-txt');
    const lineBtn = document.getElementById('td-recap-line-btn');
    if (lineTxt) {
      lineTxt.textContent = TD.reallyAway
        ? cuT('All quiet while you were away.', '您不在时一切平静。')
        : cuT('Nothing new just now.', '暂时没有新动静。');
    }
    // The card is gone, so this link is the only remaining way to the day's log.
    if (lineBtn) lineBtn.textContent = cuT('Show the work', '查看明细');
    if (line) {
      line.hidden = false;
    }
    if (block && !block.classList.contains('is-quiet')) {
      block.classList.add('is-quiet');
      if (typeof dashRender === 'function') dashRender();
    }
    if (close) close.hidden = true;
    return;
  }
  // Hide the line, never empty it — it owns the span + the "Show the work"
  // button now, and textContent='' would delete both.
  if (line) line.hidden = true;
  if (block && block.classList.contains('is-quiet')) {
    block.classList.remove('is-quiet');
    if (typeof dashRender === 'function') dashRender();
  }
  host.innerHTML = rows.join('');
  if (close) {
    // Reached with no rows only when the operator promoted the card from the
    // quiet line. Nothing was handled in that window, so the closing line would
    // be claiming credit for an empty digest — stay quiet and let the feed talk.
    close.hidden = !rows.length;
    if (rows.length) close.textContent = cuT("Handled quietly. You're welcome.", '一切已悄然处理，不用谢。');
  }
}

// "Show the work" — the silent system is never secretive: the banner unfolds
// in place into the real feed. The away window's events sit tinted dusk above
// a "you left here" line, the rest of today below; every row drills through
// to its order / customer / product via dashFeedClick.
// Readable floor for the open fold, used ONLY where the card has no neighbour
// to disturb (see tdRecapToggleWork). Roughly eight feed rows.
const TD_WORK_MIN_H = 360;

// "Show the work" from the QUIET line. The recap window is empty so the card has
// left the grid — but the fold behind it is the whole day since midnight, not
// that window, and this link is the only remaining route to it. Promote the
// block back to card form, then hand over to the normal open path so the height
// pin, the fetch and the button label all behave exactly as they do on a busy
// morning. TD.workFromQuiet holds the card up against the 60s poll until the
// operator closes the fold again.
async function tdRecapLineShowWork() {
  const block = document.querySelector('.td-block[data-block="recap"]');
  const line  = document.getElementById('td-recap-line');
  const close = document.getElementById('td-recap-close');
  TD.workFromQuiet = true;
  if (line)  line.hidden = true;
  if (close) close.hidden = true;                      // nothing was handled in an empty window
  if (block) block.classList.remove('is-quiet');
  tdRecapHeadPaint();                                  // reframe as the day, not the window
  if (typeof dashRender === 'function') dashRender();  // card rejoins the grid and takes a column
  await tdRecapToggleWork();
}

async function tdRecapToggleWork() {
  const fold = document.getElementById('td-recap-work'); if (!fold) return;
  const block = fold.closest('.td-block');
  if (!fold.hidden) {
    fold.hidden = true;
    if (block) block.style.height = '';   // back to content height
    tdRecapWorkBtnSync();
    // Opened from the quiet line — closing puts the block back to one line of
    // text rather than leaving an empty card sitting where the line was.
    // tdRecapRender re-runs the quiet branch once the flag is down.
    if (TD.workFromQuiet) {
      TD.workFromQuiet = false;
      tdRecapHeadPaint();
      tdRecapRender();
    }
    return;
  }
  // Opening the fold must not resize the card. Measure the card FIRST and pin it
  // there, so the feed scrolls inside the space the digest was using instead of
  // growing the card — which, with the flat-row rule, would stretch every other
  // card in the row to the full length of the day's feed and push the page down.
  //
  // The grid has already stretched this block to its row's height, so this reads
  // the ROW height, not the Recap's own content height: pinning it means the row
  // is bit-for-bit unchanged, which is the point. The old solver did the same
  // thing permanently by handing every card a computed pixel height; this does it
  // only for as long as the fold is open.
  if (block) {
    const rowH = Math.round(block.getBoundingClientRect().height);
    // One exception. In the single-column band nothing sits beside this card, so
    // there is no row to keep still — and the pin there is the Recap's own short
    // content height, which leaves about two rows of feed visible. That is a
    // keyhole, not a list. Let the card reach a readable minimum in that band,
    // and only in that band, where growing it disturbs nothing.
    const host = document.getElementById('td-blocks');
    const alone = host && dashCols(host.clientWidth) === 1;
    block.style.height = (alone ? Math.max(rowH, TD_WORK_MIN_H) : rowH) + 'px';
  }
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
  // The day separator is tdWhen(ts, 'weekday') now, so the hand-built Chinese
  // weekday table and the language flag it was picked with are both gone.
  const multiDay = new Set(evs.map(e => tdWhen(e.ts, 'machine'))).size > 1;
  const since = TD.recapSince || 0;
  // Only split the feed into an "away" band when the operator genuinely left.
  // A quick reload / tab-switch shows a plain reverse-chron feed, no boundary.
  const hasAway = TD.reallyAway && evs.some(e => new Date(e.ts).getTime() >= since);
  let html = '', lastDay = '', lineDone = false;
  for (const e of evs) {
    const ts = new Date(e.ts);
    const away = TD.reallyAway && ts.getTime() >= since;
    if (multiDay) {
      // The store's day, so the key the feed GROUPS by and the label the
      // separator PRINTS cannot disagree about where a day ends.
      const dayKey = tdWhen(ts, 'machine');
      if (dayKey !== lastDay) {
        lastDay = dayKey;
        const dayLbl = tdWhen(ts, 'weekday');
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
      ${m.amount && !tdRecapNoMoney() ? `<span class="td-feed-amt">${m.amount}</span>` : ''}
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
    dashUnhandledRender();   // the Unhandled-orders card reads the same ops payload
    dashNeedsPointRender();  // and so does the delivery-point worklist
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

// One text node per attention item, in the order an operator would work them,
// then the card's own way in — right-pinned, so every card's footer reads the
// same: a dot, what is happening, and the door.
function tdSecFootHtml(items, go) {
  const live = items.filter(it => it.n > 0);
  const sep = '<span class="td-sec-sep">·</span>';
  const body = live.length
    ? `<span class="td-sec-dot"></span>` + live.map(it =>
        `<button type="button" class="td-sec-link" onclick="${it.go}">${escapeHtml(it.label(it.n))}</button>`
      ).join(sep)
    : `<span class="td-sec-dot is-clear"></span>${escapeHtml(cuT('Nothing waiting.', '暂无待办。'))}`;
  return body + (go ? tdSecGoHtml(go.label, go.run, go.icon) : '');
}
// The card's trailing link. It used to sit in the card header; it belongs at the
// bottom, where the eye already is after reading the numbers, and where it can
// share the footer's baseline with the working-state line.
//
// iconOnly renders a chevron instead of the label. Use it when the door leads
// where the card's own title already says — Today → orders, Customers →
// customers — because there the words are the third time you read the same
// noun. Where the door leads SOMEWHERE ELSE (Inventory → restock, Delivery →
// orders) keep the words: there the label is the only thing on the card that
// says where you're going, and a bare chevron would throw that away. The label
// still names the button for screen readers and as its tooltip either way, so
// nothing is lost but the ink.
function tdSecGoHtml(label, run, iconOnly) {
  const body = iconOnly
    ? `<span class="sr-only">${escapeHtml(label)}</span>`
      + `<svg class="td-sec-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`
    : escapeHtml(label);
  return `<button type="button" class="td-sec-go${iconOnly ? ' is-icon' : ''}" onclick="${run}" title="${escapeHtml(label)}">${body}</button>`;
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
    set('td-sec-aov', aov ? acMoney(aov) : acWrap('—'));
    // Sessions is the ONLY denominator this card shows. It used to carry three
    // side by side — "of 58 visitors", "93 visits", "46 sessions" — which asked
    // the operator to hold three definitions of the same idea in their head to
    // read one card. Worse, they disagreed: `visitors` double-counts anyone who
    // signs in mid-session (see the note on visitsSql in routes/retail.js), so
    // it could show MORE visitors than sessions, which cannot be true of people.
    // `visits` counts page views, so a customer who browses more looks like more
    // traffic. Sessions is the one that is both well-defined and correct, and it
    // is already what conversion divides by — so keeping it is also the only
    // choice that leaves this card internally consistent.
    const sessions = Number(k.sessions || 0);
    set('td-sec-sessions', sessions ? sessions.toLocaleString() : '—');
    // Conversion, honest at small denominators (spec §1.1b — small merchants
    // ARE the core case). Below a meaningful session count a percentage is noise
    // rendered as a crisis (0.0% over 2 sessions), so under the threshold we show
    // the raw counts instead and only above it a %. At zero sessions there's
    // nothing to divide, so a calm dash. Threshold tuned here.
    const CONV_MIN_SESSIONS = 20;
    const convSub = document.getElementById('td-sec-conv-sub');
    if (!sessions) {
      set('td-sec-conv', '—');
      if (convSub) convSub.textContent = cuT('no sessions yet', '暂无会话');
    } else if (sessions < CONV_MIN_SESSIONS) {
      // Under the threshold there is no honest rate to quote, so the figure
      // stays a dash and the raw counts move into the sub-line.
      //
      // It used to put the ORDER COUNT in the figure instead, which read
      // "Conversion / 1" — a number that is not a conversion, standing under a
      // label that says it is. At five sessions that is the worst of both: it
      // looks like 1%, and the one reader who takes it at face value is misled
      // by the cell that exists to stop exactly that.
      const ord = Number(k.orders || 0);
      set('td-sec-conv', '—');
      if (convSub) {
        convSub.textContent = cuT(
          `${ord} ${ord === 1 ? 'order' : 'orders'} from ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`,
          `${sessions} 次会话中 ${ord} 单`);
      }
    } else {
      set('td-sec-conv', k.conversion_rate == null ? '—' : Number(k.conversion_rate).toFixed(1) + '%');
      if (convSub) {
        convSub.textContent = cuT(`${Number(k.orders || 0).toLocaleString()} orders ÷ ${sessions.toLocaleString()} sessions`,
                                  `${Number(k.orders || 0).toLocaleString()} 单 ÷ ${sessions.toLocaleString()} 次会话`);
      }
    }
    // Returning buyers — the Customers card's fourth cell, and the only number
    // on this dashboard about whether the shop KEEPS anyone.
    //
    // The population trap this sub-line exists to defuse: `buyers` and
    // `new_buyers` both count people who PAID today (new_vs_returning in
    // routes/retail.js — "new" there means first-ever paid order), while "New
    // today" two cells away counts ACCOUNTS CREATED today. Different
    // populations, and read as a pair they would look like they should add up.
    // So this cell names its own denominator out loud, the same way Conversion
    // above it does. With no buyers yet there is nothing to be a fraction of,
    // so it shows a dash rather than a 0 that looks like churn.
    const nvr = today.new_vs_returning || {};
    const buyers = Number(nvr.buyers || 0);
    set('td-sec-returning', buyers ? String(Number(nvr.returning_buyers || 0)) : '—');
    const retSub = document.getElementById('td-sec-returning-sub');
    if (retSub) {
      retSub.textContent = buyers
        ? cuT(`of ${buyers} who bought today`, `今日 ${buyers} 位买家中`)
        : cuT('nobody has bought yet', '今日暂无买家');
    }

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
      //
      // It read "4 to start", which never said start WHAT and scanned like a
      // countdown — "4 minutes to start". The line under it is "N preparing",
      // so the pair only reads if this one names the same verb: 4 waiting to be
      // prepared → 3 preparing. The CN was vaguer still (单待处理, "pending"),
      // and now matches (单待备货).
      { n: Number(c.paid || 0),             go: "tdSecOpenOrders('paid')",             label: n => cuT(`${n} waiting to be prepared`, `${n} 单待备货`) },
      { n: Number(c.preparing || 0),        go: "tdSecOpenOrders('preparing')",        label: n => cuT(`${n} preparing`, `${n} 单备货中`) },
      { n: Number(c.awaiting_restock || 0), go: "tdSecOpenOrders('awaiting_restock')", label: n => cuT(`${n} awaiting restock`, `${n} 单待补货`) },
      { n: Number(c.refunds_open || 0),     go: "tdSecOpenOrders('refunds_open')",     label: n => cuT(`${n} in the refund queue`, `${n} 单待退款`) },
      { n: Number(c.needs_invoice || 0),    go: "dashOpenInvoices()",                  label: n => cuT(`${n} ${n === 1 ? 'invoice' : 'invoices'} to issue`, `${n} 张待开票`) },
    ], { label: cuT('Open orders', '前往订单'), run: "dashJumpTab('orders')", icon: true });
  }

  // Inventory: out-of-stock is the emergency; low stock is the nudge. The footer
  // states the count only — the restock CTA lives on the "Restock needed" card in
  // Needs-you now (dedup: one fire, one place), so this line no longer carries it.
  const invFoot = document.getElementById('td-sec-inventory-foot');
  if (invFoot && DASH_OPS) {
    invFoot.innerHTML = (oos + low) === 0
      ? `<span class="td-sec-dot is-clear"></span>${escapeHtml(cuT('Everything is stocked.', '库存充足。'))}`
      : `<span class="td-sec-dot"></span>`
        + `<button type="button" class="td-sec-link" onclick="dashStockDrawerOpen(event)">${escapeHtml(oos
            ? cuT(`${oos} out of stock`, `${oos} 项已售罄`)
            : cuT(`${low} running low`, `${low} 项库存不足`))}</button>`;
    invFoot.innerHTML += tdSecGoHtml(cuT('Open restock', '前往补货'), 'dashOpenRestock()');
  }

  // Delivery: the carrier's own "needs a call" flags — the same signal the
  // brick attention card raises, said in one line.
  const delFoot = document.getElementById('td-sec-delivery-foot');
  if (delFoot && DASH_OPS) {
    const alerts = ((DASH_OPS.delivery_alerts || {}).count) || 0;
    delFoot.innerHTML = alerts === 0
      ? `<span class="td-sec-dot is-clear"></span>${escapeHtml(cuT('Every delivery is on track.', '配送一切正常。'))}`
      : `<span class="td-sec-dot"></span><button type="button" class="td-sec-link" onclick="tdSecOpenOrders('dispatched')">${escapeHtml(cuT(`${alerts} ${alerts === 1 ? 'delivery needs' : 'deliveries need'} a call`, `${alerts} 单配送需要联系`))}</button>`;
    delFoot.innerHTML += tdSecGoHtml(cuT('Open delivery', '前往配送'), "tdSecOpenOrders('dispatched')");
  }
}

// Line icons for the Needs-you rows (24-box, currentColor so .td-nico.is-<sev>
// tints each one to its row's severity — the icon repeating the colour is what
// lets severity survive a glance without a second chip on the row).
const TD_ATTN_ICON = {
  box:   '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 8 4.5v9L12 20l-8-4.5v-9Z"/><path d="M4 6.5 12 11l8-4.5M12 11v9"/></svg>',
  truck: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>',
  order: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>',
  refund:'<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12a4 4 0 0 1 0 8h-6"/><path d="m8 5-4 4 4 4"/></svg>',
  invoice:'<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
  // Payment that doesn't add up: a ¥ note inside a circle. Line-only like its
  // siblings (brand rule: stroke SVG, never emoji, never a glyph in a text node
  // — a bare ¥ would inherit the row's font and refuse the severity tint).
  yuan:  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 7.5 3.5 5 3.5-5"/><path d="M9 13h6M9 16h6M12 12.5V18"/></svg>',

  // The two Inbox queues wear the same marks their menu rows do — a star for
  // Reviews, a report bubble for Feedback — so the fire and the door it opens
  // are recognisably the same thing.
  star:  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.6 5.27 5.82.85-4.21 4.1.99 5.78L12 16.27 6.8 19l.99-5.78-4.21-4.1 5.82-.85Z"/></svg>',
  chat:  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8a2 2 0 0 1 2 2v10l-4-3H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M12 6.5v3"/><path d="M12 12h.01"/></svg>',
  // A channel that has stopped taking stock updates — an unplugged connector.
  plug:  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v5M15 2v5"/><path d="M6.5 7h11v4.5a5.5 5.5 0 0 1-11 0Z"/><path d="M12 17v4"/></svg>',
  // Something the kitchen has finished. Lucide's `circle-check`, hand-inlined
  // to the same geometry the phone's own "Ready from the kitchen" row draws
  // (public/m.html MORE_GROUPS) — the fire and the door it opens wear the same
  // mark, which is the rule the star/chat pair above already keeps.
  check: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
};

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
  if (!DASH_OPS || !dashCardWants('stock')) return hide();

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
  // The stock list is the Inventory block's business, not this card's — paint it
  // from the same ops snapshot, on every path that repaints this (poll, SSE,
  // store change, language toggle). It lives here because this is the one
  // function every one of those paths already calls.
  tdInvLowRender();
  if (!DASH_OPS) {
    host.innerHTML = `<div class="td-muted">${cuT('Loading…', '加载中…')}</div>`;
    return;
  }
  // Feed the Today card's "refund requests" cell from the same live ops
  // snapshot (the open-refund queue) — 0 when clear.
  const refCell = document.getElementById('td-today-ref');
  if (refCell) refCell.textContent = String((DASH_OPS.refunds && DASH_OPS.refunds.count) || 0);

  // One entry per fire. `mins` is how long the OLDEST thing in the queue has
  // waited; null means this fire has no clock and states its condition instead.
  const fires = [];

  // Payment read but rejected — the customer sent a screenshot, the system
  // refused to confirm it, and the order never left pending_payment. Brick:
  // money is in dispute and the customer is sitting on an order they believe
  // they paid for. Nothing else on the dashboard shows this today, which is
  // exactly why it could sit for hours: the order looks like any other unpaid
  // one in the list.
  const pm = DASH_OPS.payment_mismatch || { count: 0, items: [] };
  if (pm.count && dashCardWants('orders')) {
    // With ONE order behind the fire, the row can state the actual gap instead
    // of only that there is one — that is the fact the operator is about to go
    // and look up. With several, no single pair of numbers is true of them all,
    // so the row stays a count and the age carries the urgency.
    // Only when we read an amount AND it differs: a mismatch can also be a
    // wrong payee, a stale receipt or a screenshot already used on another
    // order, and quoting two identical numbers would read as a bug.
    let state = null;
    const one = pm.count === 1 ? (pm.items || [])[0] : null;
    if (one && one.paid_amount != null && one.total != null
        && Math.abs(Number(one.paid_amount) - Number(one.total)) >= 0.005) {
      const paid = dashMoney(one.paid_amount, 2), due = dashMoney(one.total, 2);
      // Comma, never " · " — same i18n-walker rule as the Restock line below.
      state = cuT(`paid ${paid}, order ${due}`, `已付 ${paid},订单 ${due}`);
    }
    fires.push({
      sev: 'brick', icon: 'yuan',
      label: cuT("Payment doesn't match", '付款金额不符'),
      n: pm.count,
      // Ages from when the CUSTOMER uploaded the proof (server-side COALESCE
      // to placed_at, so it is never null) — how long they have been waiting on
      // money they believe they already sent.
      mins: tdOldestMins(pm.items),
      state,
      // Straight to Pending. A rejected proof is not a stage of its own — the
      // order never moved, so it is sitting in that list already, and the row
      // there carries the brick "Payment doesn't match" mark (paymentCheckLine
      // in 04-orders.js) that says which one it is. A chip of its own would
      // have invented a status the order does not have.
      cta: cuT('Open pending', '前往待付款'), go: "tdSecOpenOrders('pending_payment')",
    });
  }

  // Payment proof on file that nobody has accepted yet — verified-but-unflipped,
  // unreadable, or never read at all. Amber, not brick: nothing here says the
  // money is wrong, only that we have not said it is right. Its brick sibling
  // above is the one where the numbers disagree.
  const pu = DASH_OPS.payment_unconfirmed || { count: 0, unread: 0, items: [] };
  if (pu.count && dashCardWants('orders')) {
    // Name the unreadable ones when there are any: "3 · 2 couldn't be read"
    // tells the operator that most of this queue is a click and some of it is
    // a judgement call. Exact count from the server, never derived from the
    // capped preview. All-readable → no state, because "0 couldn't be read" is
    // a sentence nobody needs.
    const k = Number(pu.unread || 0);
    const state = k > 0 ? cuT(`${k} couldn't be read`, `${k} 张无法识别`) : null;
    fires.push({
      sev: 'amber', icon: 'yuan',
      label: cuT('Payments to confirm', '待确认付款'),
      n: pu.count,
      mins: tdOldestMins(pu.items),
      state,
      // Same door as its brick sibling: these orders are in Pending too, and
      // the row there says which is which.
      cta: cuT('Open pending', '前往待付款'), go: "tdSecOpenOrders('pending_payment')",
    });
  }

  // Delivery — the carrier, the platform or our own rider has left someone
  // waiting. Brick: this is the only one of the five where a customer is
  // already having a bad day.
  const da = DASH_OPS.delivery_alerts || { count: 0, items: [] };
  if (da.count && dashCardWants('delivery')) {
    fires.push({
      sev: 'brick', icon: 'truck',
      label: cuT('Delivery needs a call', '配送需要跟进'),
      n: da.count,
      // The oldest across every kind of delivery trouble. Each sub-list arrives
      // oldest-first, so the true oldest is always inside the preview even when
      // the count runs past it. A carrier exception carries no waiting_since at
      // all (see the ops route) and simply doesn't vote.
      mins: tdOldestMins(da.items),
      cta: cuT('Open delivery', '前往配送'), go: "tdSecOpenOrders('dispatched')",
    });
  }

  // Refunds — money the customer has asked for back and nobody has decided on.
  const rf = DASH_OPS.refunds || { count: 0, items: [] };
  if (rf.count && dashCardWants('refunds')) {
    fires.push({
      sev: 'amber', icon: 'refund',
      label: cuT('Refunds waiting', '退款待处理'),
      n: rf.count, mins: tdOldestMins(rf.items),
      cta: cuT('Open refunds', '前往退款'), go: "tdSecOpenOrders('refunds_open')",
    });
  }

  // Orders awaiting restock — paid, and parked until stock lands. The customer
  // has been waiting since they paid, so that is what the age counts from.
  const aw = DASH_OPS.awaiting_restock || { count: 0, items: [] };
  if (aw.count && dashCardWants('orders')) {
    fires.push({
      sev: 'amber', icon: 'order',
      label: cuT('Orders awaiting restock', '订单待补货'),
      n: aw.count, mins: tdOldestMins(aw.items),
      cta: cuT('Open orders', '前往订单'), go: "tdSecOpenOrders('awaiting_restock')",
    });
  }

  // Invoices to issue — un-issued fapiao, oldest debt first.
  const inv = DASH_OPS.invoices || { count: 0, items: [] };
  if (inv.count && dashCardWants('invoices')) {
    fires.push({
      sev: 'amber', icon: 'invoice',
      label: cuT('Invoices to issue', '待开发票'),
      n: inv.count, mins: tdOldestMins(inv.items),
      cta: cuT('Open invoices', '前往开票'), go: 'dashOpenInvoices()',
    });
  }

  // Reviews nobody has answered — a customer wrote to the shop in public and
  // the shop has not written back. Amber, not brick: nothing here is money or a
  // delivery going wrong, it is work waiting. The low-rated count is what makes
  // the row worth reading before you click it — nine polite five-stars and nine
  // one-stars are the same number and not remotely the same afternoon.
  const rv = DASH_OPS.reviews_unanswered || { count: 0, low: 0, items: [] };
  if (rv.count && dashCardWants('reviews') && dashFeatOn('reviews')) {
    const k = Number(rv.low || 0);
    fires.push({
      sev: 'amber', icon: 'star',
      label: cuT('Reviews to answer', '评价待回复'),
      n: rv.count,
      // From when the customer posted it. Reviews go stale in days rather than
      // minutes, which dashAgeShort already says in the right unit.
      mins: tdOldestMins(rv.items),
      // Same words as the Reviews page's own chip, so the row and the page it
      // opens name the same thing. Comma, never " · " — the i18n walker splits
      // a constructed line on the middot.
      state: k > 0 ? cuT(`${k} low-rated`, `${k} 条低评分`) : null,
      cta: cuT('Open reviews', '前往评价'), go: 'dashOpenReviews()',
    });
  }

  // Feedback threads with the customer's turn newest — a bug report nobody has
  // opened, or an answer to our own reply that is still sitting there. The one
  // queue on this card where the customer is waiting on WORDS rather than on
  // stock, money or a driver.
  const fb = DASH_OPS.feedback_waiting || { count: 0, items: [] };
  if (fb.count && dashCardWants('feedback') && dashFeatOn('feedback')) {
    fires.push({
      sev: 'amber', icon: 'chat',
      label: cuT('Feedback to answer', '反馈待回复'),
      n: fb.count,
      // From the customer's latest turn — how long THEY have been waiting, not
      // how old the thread is.
      mins: tdOldestMins(fb.items),
      cta: cuT('Open feedback', '前往反馈'), go: 'dashOpenFeedback()',
    });
  }

  // The kitchen finished what the warehouse asked for. warehouse→kitchen closes
  // at 'prepared' — nothing travels, nothing is collected, the kitchen shelves
  // what it makes and records the stock itself — so this row is NEWS, not a job.
  //
  // IT IS STILL AMBER AND IT STILL CARRIES A CLOCK, which is the whole reason it
  // is worth putting here. Needs-you sorts severity first, then oldest first,
  // and a fire with no age sorts LAST. On the Stockroom role the only other fire
  // that ever appears is Restock needed, which has no clock by design — so a
  // calm, clockless version of this row would sit permanently underneath the
  // one thing the warehouse already knew. With an age it leads, every time,
  // without anyone writing a rule to make it so. And "oldest 4h" is the fact
  // that decides whether you walk over now or after lunch.
  //
  // Ages from `prepared_at` — how long the news has gone unread, not how old the
  // request is. Reading it is what clears it: opening the list stamps `seen_at`
  // server-side, so one person looking puts this row out for the whole warehouse
  // and takes the dot off every other phone with it.
  const kr = DASH_OPS.kitchen_ready || { count: 0, items: [] };
  if (kr.count && dashCardWants('kitchen_ready')) {
    fires.push({
      sev: 'amber', icon: 'check',
      // The list's own name, verbatim (public/m.html MORE_GROUPS, and the tile
      // in public/stock.html) — the row and the screen it opens say the same
      // words, which is the rule the Reviews row states above.
      label: cuT('Ready from the kitchen', '厨房已完成'),
      n: kr.count, mins: tdOldestMins(kr.items),
      cta: cuT('View', '查看'), go: 'dashOpenKitchenReady()',
    });
  }

  // Restock — the one fire with no clock and never any. "15 out of stock" is a
  // state, not a queue: nothing records when a product went short, and inventing
  // a duration for it would be inventing precision. It states its condition
  // where the others state an age, and the row is a complete sentence either way
  // because nothing reserves a column for the age.
  const oosc = (DASH_OPS.out_of_stock && DASH_OPS.out_of_stock.count) || 0;
  const lowc = (DASH_OPS.low_stock && DASH_OPS.low_stock.count) || 0;
  if ((oosc + lowc) > 0 && dashCardWants('stock')) {
    // Comma, not " · " — the i18n walker splits on the middot and would tear a
    // constructed line in half. data-no-i18n on the node as well, below.
    const state = (oosc && lowc)
      ? cuT(`out of stock, ${lowc} running low`, `已售罄，另有 ${lowc} 项库存不足`)
      : oosc ? cuT('out of stock', '已售罄')
             : cuT('running low', '库存不足');
    fires.push({
      sev: 'amber', icon: 'box',
      label: cuT('Restock needed', '需要补货'),
      // The pill counts what is actually OUT; the state line names the rest. A
      // single number summing both would say "23" and mean neither.
      n: oosc || lowc, mins: null, state,
      cta: cuT('Open restock', '前往补货'), go: 'dashOpenRestock()',
    });
  }

  // Channel stock-sync stall — a sales channel (Meituan / Eleme / GZ Grocery)
  // has stopped taking our stock pushes: the oldest push in its queue has sat
  // unresolved past the threshold in lib/channel-sync-stale.js. Up to one row
  // per channel, usually zero. The declared channel list lives server-side —
  // this just loops over whatever the endpoint sends, so a fourth channel
  // needs no change here. `mins` is still the open-hours-adjusted age from the
  // server (Meituan/Eleme) or plain wall-clock (GZ Grocery) — it drives sort
  // order exactly like every other fire's age, even though the row's own text
  // doesn't show it (see noAutoAge below and tdAttnRowHtml's use of it).
  //
  // Mock calls for the clock the customer's stock might be wrong at, not a
  // duration — "waiting since 2:15 PM", never "oldest 4h", and nothing about
  // sessions/queues/tokens/attempts: the reader needs to know the numbers on
  // that channel may be wrong, not why. Since `mins` stays a real number, this
  // still always outranks the Restock row below (whose `mins` is deliberately
  // null — it has no clock at all — and a fire with no age always sorts last),
  // which is the ordering the mock settled: a stale channel may be SELLING
  // stock we don't have; an empty shelf is only an empty shelf.
  //
  // No dashCardWants() gate, deliberately: every role that can see the
  // dashboard should see when a channel stops syncing, not only operators with
  // a specific capability.
  for (const c of (DASH_OPS.channel_sync_stale || [])) {
    const t = new Date(String(c.oldest_at || '').replace(' ', 'T') + 'Z');
    // A bare clock time is a trap on this row: two channels stuck on different
    // DAYS read as "02:06 PM" and "11:39 AM", and the older one looks newer —
    // the rows sort correctly by real age while the text argues they don't.
    // Carry the date whenever it isn't today, so what the row says and how it
    // sorts can't disagree.
    // "Today" on the STORE's calendar, and both stamps on the store's clock.
    // Read on the browser's, an operator abroad saw a row stuck since this
    // morning carry yesterday's date, which is the very confusion the comment
    // above says this branch exists to prevent.
    const sameDay = !isNaN(t) && tdWhen(t, 'machine') === tdWhen(new Date(dashNow()), 'machine');
    const when = isNaN(t) ? '' : tdWhen(t, sameDay ? 'time' : 'dateTime');
    fires.push({
      sev: 'amber', icon: 'plug',
      label: cuT(`${c.label} not syncing`, `${c.label} 未同步`),
      n: c.waiting_count,
      mins: dashAgeMins(c.oldest_at),
      state: when ? cuT(`stock updates waiting since ${when}`, `库存更新自 ${when} 起等待中`) : null,
      noAutoAge: true,
      cta: cuT('Open channel', '前往渠道'), go: `goTab('${c.channel}')`,
    });
  }

  // Severity first, then oldest first, and a fire with no age sorts last —
  // a state cannot be ranked by how long it has waited.
  const sevRank = { brick: 0, amber: 1 };
  fires.sort((a, b) => {
    const s = (sevRank[a.sev] ?? 9) - (sevRank[b.sev] ?? 9);
    if (s) return s;
    if (a.mins == null && b.mins == null) return 0;
    if (a.mins == null) return 1;
    if (b.mins == null) return -1;
    return b.mins - a.mins;
  });

  // Nothing waiting → the whole block leaves the page: heading, rows and all.
  // A shorter dashboard IS the good news, and The Recap moves up to lead on its
  // own. The block stays in the DOM (hidden by CSS) so nothing has to be rebuilt
  // when the next fire lights.
  const block = host.closest('.td-block');
  const wasQuiet = block && block.classList.contains('is-quiet');
  if (!fires.length) {
    host.innerHTML = '';
    if (block) block.classList.add('is-quiet');
    if (!wasQuiet && typeof dashRender === 'function') dashRender();
    return;
  }
  if (block) block.classList.remove('is-quiet');
  host.innerHTML = fires.map(tdAttnRowHtml).join('');
  if (wasQuiet && typeof dashRender === 'function') dashRender();
}

// The oldest thing in a queue, in minutes — or null when not one row in it
// carries a clock we trust. Rows without a waiting_since are skipped rather
// than counted as zero, so one age-less row can never drag a real age down.
function tdOldestMins(items) {
  let oldest = null;
  for (const it of (items || [])) {
    const m = dashAgeMins(it && it.waiting_since);
    if (m == null) continue;
    if (oldest == null || m > oldest) oldest = m;
  }
  return oldest;
}

// One line per fire: icon · what it is · how many · how long the oldest has
// waited · where it gets fixed.
//
// Nothing reserves a column for the age. The count pill and the meta run are
// welded to the label and only the link pins right, so "Restock needed · 15 ·
// out of stock, 8 running low" is a complete sentence that simply ends sooner
// than "Delivery needs a call · 2 · oldest 4h". A right-aligned age column was
// the obvious first shape and it is exactly what leaves a visible hole on the
// row that has no age — there is no empty cell here because there was never a
// cell.
function tdAttnRowHtml(f) {
  // A fire states its condition, its age, or (payment mismatch on a single
  // order) both — the numbers first, because that is what is being checked,
  // then how long it has waited. Comma-joined for the same reason the Restock
  // state uses one: " · " is what the i18n walker splits an EN/CN pair on.
  // noAutoAge: this fire's `mins` is real (it sorts on it) but its own state
  // text already says everything the row needs to — the channel-sync-stall
  // row uses this to show a clock instead of a duration without losing its
  // place in the oldest-first ordering every other fire's `mins` provides.
  const age = (f.mins == null || f.noAutoAge) ? '' : cuT(`oldest ${dashAgeShort(f.mins)}`, `最久 ${dashAgeShort(f.mins)}`);
  const meta = [f.state || '', age].filter(Boolean).join(', ');
  const chev = '<svg class="td-nchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  return `<button type="button" class="td-nrow" onclick="${f.go}">
    <span class="td-nico is-${f.sev}" aria-hidden="true">${TD_ATTN_ICON[f.icon] || ''}</span>
    <span class="td-nlbl">${escapeHtml(f.label)}</span>
    <span class="td-npill is-${f.sev}" data-no-i18n>${Number(f.n).toLocaleString()}</span>
    <span class="td-nmeta" data-no-i18n title="${escapeAttr(meta)}">${escapeHtml(meta)}</span>
    <span class="td-nspring"></span>
    <span class="td-ncta">${escapeHtml(f.cta)}</span>${chev}
  </button>`;
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
  const fmt = s => tdWhen(s, 'date');
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
    $('#db-kpis').innerHTML = `<div class="db-muted">${cuT('Failed to load', '加载失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
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
// Everything below is computed in rect space, then converted to CSS px exactly.
let _fcMap = null, _fcMapKey = null;
function fcMeasureMap() {
  const key = window.innerWidth + 'x' + window.innerHeight;
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
  const m = col.dataset.m || '', rev = col.dataset.rev || '0.00';
  // Order count is redundant with the bar height (and a lone "Orders: 1" next
  // to the amount reads as filler) — the tooltip carries only the figure.
  tip.innerHTML =
    `<div class="b">${escapeHtml(m)}</div>` +
    `<div class="r"><span>${cuT('Revenue', '营收')}</span><b>${escapeHtml(acWrap(rev))}</b></div>`;
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
  rider_pickup: 'Rider coming · 骑手前往取货',
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
  const tp = DASH_DATA.topups || {};
  const product  = Number(c.product_total || 0);
  const delivery = Number(c.delivery_fee || 0);
  const balance  = Number(c.balance_total || 0);   // store credit spent on orders
  const discount = Number(c.voucher_total || 0) + Number(c.points_total || 0);
  const net      = Number(c.net_total || 0);       // order.total = cash residual only
  const tuRecv   = Number(tp.received || 0);        // real top-up cash in (already in revenue)
  const tuUsed   = Number(tp.redeemed != null ? tp.redeemed : balance);  // store credit redeemed
  if (!product && !delivery && !net && !tuRecv) { host.innerHTML = '<div class="db-muted">No revenue in range · 区间内无收入</div>'; return; }
  const base = (product + delivery) || 1;
  // The mockup: one two-segment composition bar (ink at two weights), then a
  // legend line — products / delivery fees / net after discounts. The discount
  // detail rides the net figure as a hover title. Store credit spent is folded
  // into that detail so subtotal → net reconciles (net = products + delivery −
  // discounts − store credit); a top-up line makes prepaid cash visible.
  const deductParts = [];
  if (discount > 0) deductParts.push(cuT(`${dashMoney(discount)} in voucher and point discounts`, `优惠券与积分让利 ${dashMoney(discount)}`));
  if (balance > 0)  deductParts.push(cuT(`${dashMoney(balance)} paid from store credit`, `门店储值抵扣 ${dashMoney(balance)}`));
  const netTitle = deductParts.length
    ? escapeAttr(cuT(`after ${deductParts.join(' and ')}`, `已扣除 ${deductParts.join('、')}`))
    : '';
  // Wallet line: top-ups received (cash in, counted in revenue on the day loaded)
  // and store credit used on orders (a memo — already recognised at top-up time,
  // not re-counted here). Shown only when there's wallet activity in the range.
  const walletLine = (tuRecv > 0 || tuUsed > 0)
    ? `<div class="db-comp-wallet">
         <span><b>${dashMoney(tuRecv)}</b> <em>${cuT('top-ups received', '钱包充值')}</em></span>
         <span><b>${dashMoney(tuUsed)}</b> <em>${cuT('store credit used', '储值消费')}</em></span>
       </div>`
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
    </div>${walletLine}`;
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
  const todayYM = tdToday().slice(0, 7);
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
      store_credit_used: r2(D.composition.balance_total), net: r2(D.composition.net_total),
    } : null,
    wallet: D.topups ? { topups_received: r2(D.topups.received), store_credit_redeemed: r2(D.topups.redeemed) } : null,
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
    when = tdWhen(d.generated_at, 'time');
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

