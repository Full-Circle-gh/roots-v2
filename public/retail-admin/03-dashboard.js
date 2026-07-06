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

// Set the date inputs from a range key and reload.
function dashSetRange(key) {
  $$('#db-range-seg button').forEach(b => b.classList.toggle('active', b.dataset.range === key));
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  let from = today;
  if (key === '7')  from = new Date(Date.now() + 8 * 3600 * 1000 - 6  * 86400000).toISOString().slice(0, 10);
  if (key === '30') from = new Date(Date.now() + 8 * 3600 * 1000 - 29 * 86400000).toISOString().slice(0, 10);
  if (key === '90') from = new Date(Date.now() + 8 * 3600 * 1000 - 89 * 86400000).toISOString().slice(0, 10);
  $('#db-from').value = from;
  $('#db-to').value = today;
  dashLoad();
}

// ── Per-store filter ───────────────────────────────────────────────────────
// Returns the active store_id (string) or '' for "all stores". Read straight
// off the select so every loader (deep-dive, Today hero, ops tiles) scopes to
// the same store without threading state around.
function dashStoreId() {
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
  dashLoad();                         // Reports KPIs + charts
  dashHeroLoadToday({ slow: false }); // Today pulse KPIs/sparklines
  if (typeof tdOpsLoad === 'function') tdOpsLoad(); // attention cards
}
// Populate the store dropdown once. Hidden for single-store tenants (no filter
// value). Mirrors the Orders tab's ensureOrdersStoreFilter.
let DASH_STORE_FILTER_LOADED = false;
async function dashEnsureStoreFilter() {
  if (DASH_STORE_FILTER_LOADED) return;
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
  // Language toggle repaints the cuT-built Reports chrome (head range echo +
  // per-panel window captions); the charts themselves re-render on dashLoad.
  if (window.onLangChange) onLangChange(() => { dashRangeLabel(); dashWinMeta(); });
  // Initial 30d load — fills the Reports charts (hidden until visited) AND
  // DASH_DATA, which the phone dashboard (rmRenderDash) renders from.
  dashSetRange('30');
  dashHeroInit();      // today pulse: presence + today KPIs + activity polling
  tdInit();            // Tacet dashboard: The Recap + attention cards + date
}

// Reports rail-button init — everything is already loaded/rendered at boot by
// dashInit (the charts render fine while the section is hidden); this only
// covers the edge where the first load failed and a tab visit should retry.
function reportsInit() {
  if (!DASH_DATA) dashLoad();
}

// ════════════════════════════════════════════════════════════════
// RIGHT-NOW HERO (phase 2/3) — live presence, today's mini-KPIs,
// activity feed. Pulls /api/retail-admin/dashboard/presence (15s),
// /api/retail-admin/dashboard/activity (20s), and a single
// /api/retail-admin/dashboard?from=today&to=today (60s for the
// "Today" mini-row). Polling pauses while the document is hidden
// so we don't hammer the server with a backgrounded tab.
// ════════════════════════════════════════════════════════════════
const DASH_HERO = { presence:null, activity:null, today:null, lastSync:0, seenIds:null };
const DASH_HERO_INTERVALS = { presence: 15000, activity: 20000, today: 60000 };

function dashHeroInit() {
  // Single bootstrap — once wired, the timers + visibility listener carry it.
  if (DASH_HERO._wired) { dashHeroRefreshAll(); return; }
  DASH_HERO._wired = true;
  // Language toggle repaints the Today delta badges from the stashed data.
  if (window.onLangChange) onLangChange(dashHeroTodayRepaint);
  // ...and re-renders the activity feed so baked-in product names follow the
  // active language (the " · " labels auto-translate, the names don't).
  if (window.onLangChange) onLangChange(() => {
    if (DASH_HERO._lastEvents) dashFeedRender(DASH_HERO._lastEvents);
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
    else dashHeroStart();
  });
  dashHeroStart();
}
function dashHeroStart() {
  dashHeroStop();  // idempotent — clear any stale timers first
  dashHeroRefreshAll();
  DASH_HERO.presence = setInterval(dashHeroLoadPresence, DASH_HERO_INTERVALS.presence);
  DASH_HERO.activity = setInterval(dashHeroLoadActivity, DASH_HERO_INTERVALS.activity);
  DASH_HERO.today    = setInterval(dashHeroLoadToday,    DASH_HERO_INTERVALS.today);
  // Keep the relative "synced Xs ago" stamp ticking between polls.
  DASH_HERO._syncTimer = setInterval(dashRenderSync, 10000);
}
function dashHeroStop() {
  for (const k of ['presence', 'activity', 'today']) {
    if (DASH_HERO[k]) { clearInterval(DASH_HERO[k]); DASH_HERO[k] = null; }
  }
  if (DASH_HERO._syncTimer) { clearInterval(DASH_HERO._syncTimer); DASH_HERO._syncTimer = null; }
}
function dashHeroRefreshAll() {
  dashHeroLoadPresence();
  dashHeroLoadActivity();
  dashHeroLoadToday();
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
    const trend = data.trend || [];
    const labels = trend.map(p => String(p.bucket || ''));
    dashRenderSpark($('#db-today-spark'), trend.map(p => Number(p.revenue || 0)), labels,
                    v => '¥' + Math.round(v).toLocaleString(), true);
    dashRenderSpark($('#db-today-ord-spark'), trend.map(p => Number(p.orders || 0)), labels,
                    v => v + ' ' + cuT(v === 1 ? 'order' : 'orders', '单'), false);
    dashRenderSpark($('#db-today-new-spark'), trend.map(p => Number(p.new_customers || 0)), labels,
                    v => v + ' ' + cuT(v === 1 ? 'new customer' : 'new customers', '新客'), false);
    dashHeroTodayRepaint();   // delta badges (language-aware)
  } catch (e) { /* silent */ }
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

// Activity feed shows only the first DASH_FEED_PREVIEW events by default; the
// operator can expand to the full list and collapse again. Preference persists.
const DASH_FEED_PREVIEW = 5;
function dashFeedExpanded() {
  try { return localStorage.getItem('retail-admin-feed-expanded') === '1'; } catch (e) { return false; }
}
function dashFeedToggleExpand() {
  const next = !dashFeedExpanded();
  try { localStorage.setItem('retail-admin-feed-expanded', next ? '1' : '0'); } catch (e) {}
  // Flip classes only — re-rendering would swap the DOM and kill the
  // grid-rows transition mid-flight.
  dashFeedSyncExpand();
}

async function dashHeroLoadActivity() {
  try {
    // Pull the whole day (server window = since GZ-midnight today), capped
    // high so a busy day's events aren't truncated to the last few minutes.
    const j = await api('/api/retail-admin/dashboard/activity?limit=500');
    const events = (j.data && j.data.events) || [];
    dashFeedRender(events);
  } catch (e) {
    const list = $('#db-feed-list');
    if (list) list.innerHTML = `<div class="db-feed-empty">Failed to load · 加载失败</div>`;
  }
}

// Render feed rows. Cache the raw event objects keyed by a stable id so the
// drawer-open click can grab the full payload without another fetch.
function dashFeedRender(events) {
  const list = $('#db-feed-list'); if (!list) return;
  const toggle = $('#db-feed-toggle');
  DASH_HERO._lastEvents = events;
  if (!events.length) {
    list.innerHTML = `<div class="db-feed-empty">Nothing recent · 暂无动态</div>`;
    if (toggle) toggle.hidden = true;
    return;
  }
  // Stable identity (no row index) so "new since last poll" survives re-renders.
  const idOf = e => `${e.type}-${e.ref_type}-${e.ref_id}-${e.ts}`;
  // First paint has no baseline — don't animate the whole list in. After that,
  // any id we haven't seen before is a genuinely fresh event.
  const firstPaint = DASH_HERO.seenIds === null;
  const prevSeen = DASH_HERO.seenIds || new Set();
  const nextSeen = new Set(events.map(idOf));
  // The click handler only needs the event's type + ref_id, so carry them on
  // the row itself. Reading straight off the clicked element can't go stale —
  // a separate id→event Map would silently miss whenever a poll rebuilt it.
  const rowHtml = (e, i) => {
    const isNew = !firstPaint && !prevSeen.has(idOf(e));
    const ts = new Date(e.ts);
    const pad = n => String(n).padStart(2, '0');
    const tstr = `${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
    // Tacet activity rows are prose, not iconed log lines: "Patricia paid
    // ¥532.20" / "Meituan order · ¥48" / "Refund settled — R261204", with the
    // amount right-aligned and only a first-order badge, per the mockup.
    const m = tdFeedMeta(e);
    return `<div class="db-feed-row td-feed-row${isNew ? ' is-new' : ''}" data-type="${escapeHtml(e.type)}" data-ref-id="${escapeHtml(e.ref_id == null ? '' : e.ref_id)}" onclick="dashFeedClick(this, event)">
      <span class="db-feed-ts">${tstr}</span>
      <span class="td-feed-text">${m.text}</span>
      ${m.badge || ''}
      ${m.amount ? `<span class="td-feed-amt">${m.amount}</span>` : ''}
    </div>`;
  };
  // The collapsed strip shows only the day's MEANINGFUL events (money moving,
  // refunds, cancellations, feedback) — routine dispatch/delivery/new-customer
  // rows are noise here; The Recap and the counters already carry them. The
  // expand toggle still reveals the complete day, so nothing is lost.
  const KEY_TYPES = new Set(['paid_order', 'order_cancelled', 'refund_request',
    'refund_paid', 'refund_rejected', 'topup', 'feedback', 'gzgrocery_pickup']);
  const keyEvents = events.filter(e => KEY_TYPES.has(e.type));
  const previewEvents = (keyEvents.length ? keyEvents : events).slice(0, DASH_FEED_PREVIEW);
  const shown = new Set(previewEvents);
  // Preview rows render directly; the overflow lives in a collapsible wrapper
  // that the toggle eases open/closed — all rows stay in the DOM so the
  // grid-rows transition has something to animate against.
  const preview = previewEvents.map(rowHtml).join('');
  const rest = events.filter(e => !shown.has(e));
  const moreHtml = rest.length
    ? `<div class="db-feed-more"><div class="db-feed-more-inner">${rest.map((e, i) => rowHtml(e, i + DASH_FEED_PREVIEW)).join('')}</div></div>`
    : '';
  const html = preview + moreHtml;
  list.innerHTML = html;
  dashFeedSyncExpand(rest.length);
  DASH_HERO.seenIds = nextSeen;
}

// Reflect the expanded/collapsed state onto the pane + toggle. `overflow`
// is the count of rows hidden behind the fold; when zero the toggle hides.
function dashFeedSyncExpand(overflow) {
  const pane = $('#db-feed-pane'), toggle = $('#db-feed-toggle');
  if (overflow == null) overflow = ($$('.db-feed-more-inner .db-feed-row') || []).length;
  const expanded = dashFeedExpanded();
  if (pane) pane.classList.toggle('is-expanded', expanded);
  if (!toggle) return;
  if (!overflow) { toggle.hidden = true; return; }
  const total = (DASH_HERO._lastEvents || []).length;
  toggle.hidden = false;
  toggle.classList.toggle('is-open', expanded);
  toggle.innerHTML = expanded ? 'Show less · 收起' : 'View all · 查看全部';
}

// Tacet activity row — clean prose per the dashboard mockup. Returns
// { text, amount, badge }: `text` is the sentence, `amount` is the
// right-aligned money (muted), `badge` a small first-order pill. No icon,
// no bold type-label prefix. (dashFeedMeta below still drives the drawer.)
function tdFeedMeta(e) {
  const p = e.payload || {};
  const yuan = n => '¥' + Number(n || 0).toLocaleString();
  const buyer = (p.buyer || '').trim();
  const chan = String(p.channel || '').toLowerCase();
  const chanName = { meituan: 'Meituan', eleme: 'Eleme', gzgrocery: 'gzgrocery' }[chan];
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
        ? { text: cuT(`gzgrocery return · ${nm}`, `gzgrocery 退货 · ${nm}`), amount: '−' + yuan(Math.abs(p.owed)) }
        : { text: cuT(`gzgrocery pickup · ${nm} ×${u}`, `gzgrocery 提货 · ${nm} ×${u}`), amount: yuan(Math.abs(p.owed)) };
    }
    default:
      return { text: escapeHtml(e.type) };
  }
}

// Thin-stroke line icons for the activity feed — 16-box viewBox, currentColor
// so the .db-fi-* tone class drives the tint. Flat + editorial, no emoji.
const FEED_SVG = {
  ok:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.2l1.9 1.9 3.7-4"/></svg>',
  refund:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h6.5a3.5 3.5 0 0 1 0 7H5"/><path d="M5.2 3l-2.3 2.5L5.2 8"/></svg>',
  alert: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2l6 11H2z"/><path d="M8 6.6v3.2"/><path d="M8 11.8h.01"/></svg>',
  person:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5a5 5 0 0 1 10 0"/></svg>',
  chat:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5 5 0 0 1-7.2 4.5L3 13.5l1-3.3A5 5 0 1 1 13.5 8z"/></svg>',
  truck: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.5h7v6h-7z"/><path d="M8.5 6.5h3l2 2.2v1.8h-5z"/><circle cx="4.2" cy="11.6" r="1.2"/><circle cx="11" cy="11.6" r="1.2"/></svg>',
  box:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z"/><path d="M2.6 4.9L8 7.8l5.4-2.9"/><path d="M8 7.8v6.4"/></svg>',
  wallet:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5h10.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 4.5V4a1 1 0 0 1 1-1h7.5"/><circle cx="10.8" cy="8.5" r=".9"/></svg>',
  star:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.9 4.4 13.1l.7-4L2.2 6.3l4-.6z"/></svg>',
  cancel:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>',
  dot:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="3"/></svg>',
};

// Compact one-line summary shown in the feed row, per event type.
// Real text only — no fake demo strings (per project memory).
function dashFeedMeta(e) {
  const p = e.payload || {};
  // Product names carry both languages; show the one matching the active UI
  // language (the " · " labels auto-translate, but baked-in names don't).
  const pickName = (en, cn) => (window.cuLang && cuLang() === 'cn')
    ? (cn || en || '') : (en || cn || '');
  // Order-line SKU(s) (货号) dimmed at the end of an order row. The server sends
  // a comma-joined distinct list; show the first 3 then "+N" so a big basket
  // doesn't overflow the row. Empty when no item carried a SKU.
  const skuTag = (raw, channel) => {
    // Mini-app (wechat) orders already carry name + amount and open a full
    // drawer on click — the SKU code is noise there. Only surface SKUs for
    // other channels where the row is the only handle on the order.
    if (String(channel || '').toLowerCase() === 'wechat') return '';
    const all = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!all.length) return '';
    const shown = all.slice(0, 3).map(escapeHtml).join(' ');
    const more = all.length > 3 ? ` +${all.length - 3}` : '';
    return ` <span class="db-feed-sku">${shown}${more}</span>`;
  };
  switch (e.type) {
    case 'paid_order': {
      const badge = p.first_order ? ` <span class="db-feed-badge db-fb-first">${FEED_SVG.star}First · 首单</span>`
                  : p.big_order   ? ` <span class="db-feed-badge db-fb-big">${FEED_SVG.star}Big · 大单</span>` : '';
      return { icon: FEED_SVG.ok, tone: 'ok', text: `<b>Paid · 已付</b> ${escapeHtml(p.order_no || '')} · ¥${Number(p.total || 0).toLocaleString()} · ${escapeHtml(p.buyer || '')}${skuTag(p.skus, p.channel)}${badge}` };
    }
    case 'order_dispatched':
      return { icon: FEED_SVG.truck, tone: 'muted', text: `<b>Dispatched · 已发货</b> ${escapeHtml(p.order_no || '')} · ${escapeHtml(p.buyer || '')}${skuTag(p.skus, p.channel)}` };
    case 'order_delivered':
      return { icon: FEED_SVG.box, tone: 'ok', text: `<b>Delivered · 已送达</b> ${escapeHtml(p.order_no || '')} · ${escapeHtml(p.buyer || '')}${skuTag(p.skus, p.channel)}` };
    case 'order_cancelled': {
      // The auto-cancel sweep stamps a machine reason ('auto_cancelled_unpaid');
      // surface that as a human "unpaid" tag so an abandoned cart reads
      // differently from a staff cancellation.
      const auto = p.reason === 'auto_cancelled_unpaid'
        ? ` <span class="db-feed-badge db-fb-muted">${cuT('unpaid','未付款')}</span>` : '';
      return { icon: FEED_SVG.cancel, tone: 'bad', text: `<b>Cancelled · 已取消</b> ${escapeHtml(p.order_no || '')}${p.total ? ' · ¥' + Number(p.total).toLocaleString() : ''} · ${escapeHtml(p.buyer || '')}${skuTag(p.skus, p.channel)}${auto}` };
    }
    case 'refund_request':
      return { icon: FEED_SVG.refund, tone: 'warn', text: `<b>Refund request · 退款申请</b> ${escapeHtml(p.order_no || '')}${p.amount ? ' · ¥' + Number(p.amount).toLocaleString() : ''} · ${escapeHtml(p.buyer || '')}` };
    case 'refund_paid':
      return { icon: FEED_SVG.refund, tone: 'ok', text: `<b>Refunded · 已退款</b> ${escapeHtml(p.order_no || '')}${p.amount ? ' · ¥' + Number(p.amount).toLocaleString() : ''} · ${escapeHtml(p.buyer || '')}` };
    case 'refund_rejected':
      return { icon: FEED_SVG.refund, tone: 'bad', text: `<b>Refund rejected · 退款驳回</b> ${escapeHtml(p.order_no || '')} · ${escapeHtml(p.buyer || '')}` };
    case 'topup':
      return { icon: FEED_SVG.wallet, tone: 'ok', text: `<b>Top-up · 充值</b> ¥${Number(p.amount || 0).toLocaleString()} · ${escapeHtml(p.buyer || '')}` };
    case 'low_stock':
      return { icon: FEED_SVG.alert, tone: 'bad', text: `<b>Low · 缺货</b> ${escapeHtml(pickName(p.name_en, p.name_cn))} (${p.stock} left · 剩 ${p.stock})` };
    case 'out_of_stock':
      return { icon: FEED_SVG.alert, tone: 'bad', text: `<b>Out · 售罄</b> ${escapeHtml(pickName(p.name_en, p.name_cn))}` };
    case 'new_customer':
      return { icon: FEED_SVG.person, tone: 'muted', text: p.name ? `<b>New · 新客</b> ${escapeHtml(p.name)}` : `<b>New customer · 新客户</b>` };
    case 'feedback':
      return { icon: FEED_SVG.chat, tone: 'muted', text: `<b>Feedback · 反馈</b> "${escapeHtml(p.excerpt || '')}"` };
    case 'gzgrocery_pickup': {
      // Inferred wholesale pickup — gzgrocery took stock through Guanyi. A return
      // (is_return) shows the units coming back; a normal pickup nets out.
      const nm = escapeHtml(pickName(p.name_en, p.name_cn));
      // SKU (货号) printed dimmed after the name so operators can match the feed
      // row to the Guanyi/wholesale listing at a glance.
      const sk = p.sku ? ` <span class="db-feed-sku">${escapeHtml(p.sku)}</span>` : '';
      const u  = Math.abs(Number(p.units || 0));
      const amt = Math.abs(Number(p.owed || 0)).toLocaleString();
      return p.is_return
        ? { icon: FEED_SVG.refund, tone: 'warn', text: `<b>gzgrocery return · 退货</b> ${nm}${sk} ×${u} · −¥${amt}` }
        : { icon: FEED_SVG.box,    tone: 'ok',   text: `<b>gzgrocery · 批发提货</b> ${nm}${sk} ×${u} · ¥${amt}` };
    }
    default:
      return { icon: FEED_SVG.dot, tone: 'muted', text: escapeHtml(e.type) };
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
// pre-filtered on the "Needs invoice" chip. The chips are static DOM, so no
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
//      and the trimmed activity strip, both handled by dashHero*.
// ════════════════════════════════════════════════════════════════

let DASH_OPS = null;


// Pick a product's name in the active UI language, falling back to the
// other language when the preferred one is missing.
function dbProdName(o) {
  const cn = (window.cuLang && cuLang() === 'cn');
  return (cn ? (o.name_cn || o.name_en) : (o.name_en || o.name_cn)) || '—';
}

const TD = { recapSince: 0, recapEvents: null, stores: null, stockStore: '', stockOps: null };
const TD_SEEN_KEY = 'retail-admin-last-seen';

function tdInit() {
  tdDateRender();
  tdEnsureStores();   // populate the Running-low store dropdown (multi-store only)
  // Language toggle repaints the JS-built strings (date, recap, attention).
  if (window.onLangChange) onLangChange(() => { tdDateRender(); tdRecapRender(); tdAttnRender(); dashStockDrawerRender(); });
  tdRecapLoad();     // reads the last-seen stamp BEFORE tdSeenInit overwrites it
  tdSeenInit();
  tdOpsLoad();
  if (!TD._opsTimer) {
    TD._opsTimer = setInterval(() => { if (!document.hidden) tdOpsLoad(); }, 60000);
  }
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
  if (!since || now - since > MAX_BACK) since = now - MAX_BACK;
  if (now - since < MIN_BACK) since = now - MIN_BACK;
  TD.recapSince = since;
  try {
    const j = await api(`/api/retail-admin/dashboard/activity?since=${since}&limit=500`);
    TD.recapEvents = (j.data && j.data.events) || [];
    tdRecapRender();
  } catch (e) {
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

// Aggregate the recap window's events into calm one-line rows, each with a
// breathing Dusk dot — Dusk means "the system did this", and this card is the
// only place on the dashboard that uses it.
function tdRecapRender() {
  const host = document.getElementById('td-recap-rows'); if (!host || !TD.recapEvents) return;
  const meta = document.getElementById('td-recap-meta');
  if (meta) meta.textContent = tdSinceLabel(TD.recapSince);
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
    host.innerHTML = `<div class="td-recap-quiet">${cuT('All quiet while you were away.', '您不在时，一切平静。')}</div>`;
    if (close) close.hidden = true;
    return;
  }
  host.innerHTML = rows.join('');
  if (close) {
    close.textContent = cuT("Handled quietly. You're welcome.", '一切已悄然处理，不用谢。');
    close.hidden = false;
  }
}

// "Show the work" — the silent system is never secretive: list every event in
// the recap window inside the activity drawer, each row drilling through to
// its order / customer / product like the main feed does.
function tdRecapShowWork() {
  const drawer = document.getElementById('db-activity-drawer'); if (!drawer) return;
  const title = document.getElementById('db-drawer-title');
  const body  = document.getElementById('db-drawer-body');
  if (title) title.textContent = cuT('While you were away', '您不在的这段时间');
  const evs = TD.recapEvents || [];
  if (body) {
    if (!evs.length) {
      body.innerHTML = `<div class="td-drawer-empty">${cuT('Nothing in this window', '此时段无事件')}</div>`;
    } else {
      // Same clean prose rows as the Activity card (time · sentence · amount),
      // grouped under a day header since the recap window can span days.
      const pad = n => String(n).padStart(2, '0');
      const cn = window.cuLang && cuLang() === 'cn';
      const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      let html = '', lastDay = '';
      for (const e of evs) {
        const ts = new Date(e.ts);
        const dayKey = ts.toDateString();
        if (dayKey !== lastDay) {
          lastDay = dayKey;
          const dayLbl = cn
            ? `${ts.getMonth() + 1}月${ts.getDate()}日 ${DOW[ts.getDay()]}`
            : ts.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
          html += `<div class="td-drawer-day">${escapeHtml(dayLbl)}</div>`;
        }
        const m = tdFeedMeta(e);
        html += `<div class="td-feed-row" data-type="${escapeHtml(e.type)}" data-ref-id="${escapeHtml(e.ref_id == null ? '' : e.ref_id)}" onclick="dashFeedClick(this, event)">
          <span class="db-feed-ts">${pad(ts.getHours())}:${pad(ts.getMinutes())}</span>
          <span class="td-feed-text">${m.text}</span>
          ${m.badge || ''}
          ${m.amount ? `<span class="td-feed-amt">${m.amount}</span>` : ''}
        </div>`;
      }
      body.innerHTML = html;
    }
  }
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
}

// ── Needs you — attention cards from /dashboard/ops ────────────────────────
async function tdOpsLoad() {
  try {
    const j = await api(`/api/retail-admin/dashboard/ops?${dashStoreQS().replace(/^&/, '')}`);
    DASH_OPS = j.data || null;
    // A store picked on the Running-low card → also pull that shelf's stock so
    // the card shows the store's own low/out items (delivery + refunds stay
    // all-stores). Cleared back to all-stores when the pick is reset.
    if (TD.stockStore) {
      try {
        const j2 = await api(`/api/retail-admin/dashboard/ops?store_id=${encodeURIComponent(TD.stockStore)}&preview=8`);
        TD.stockOps = j2.data || null;
      } catch (e) { TD.stockOps = null; }
    } else {
      TD.stockOps = null;
    }
    tdAttnRender();
  } catch (e) { /* silent — next tick retries */ }
}

// Tone-coloured line icons for the attention-card headers (24-box, currentColor
// so the .td-ic-<tone> class tints them to the card's ink), matching the mockup.
const TD_ATTN_ICON = {
  box:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  truck: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35a1 1 0 0 0-.78-.38H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>',
  refund:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>',
  invoice:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
};
function tdAttnCard(tone, icon, title, count, rowsHtml, moreText, action, headerCtrl) {
  return `<section class="card td-card td-attn-card is-${tone}">
    <div class="td-attn-head">
      <span class="td-attn-ic td-ic-${tone}" aria-hidden="true">${TD_ATTN_ICON[icon] || ''}</span>
      <h3>${title}</h3>
      ${headerCtrl || ''}
      <span class="td-pill td-pill-${tone}">${count}</span>
    </div>
    <div class="td-attn-rows">${rowsHtml}</div>
    ${moreText ? `<div class="td-attn-more">${moreText}</div>` : ''}
    ${action || ''}
  </section>`;
}

function tdAttnRender() {
  const host = document.getElementById('td-attn'); if (!host) return;
  if (!DASH_OPS) {
    host.innerHTML = `<div class="td-muted">${cuT('Loading…', '加载中…')}</div>`;
    return;
  }
  // Feed the Today pulse's "refund requests" cell from the same live ops
  // snapshot (the open-refund queue) — 0 when clear, matching the mockup.
  const refCell = document.getElementById('td-today-ref');
  if (refCell) refCell.textContent = String((DASH_OPS.refunds && DASH_OPS.refunds.count) || 0);
  const cards = [];

  // Stock first (left, like the mockup) — out-of-stock rows before the lowest
  // counts. The card shows whenever ANY store has low stock; its list + count
  // reflect the store picked in the header dropdown (all stores by default).
  const allLow = ((DASH_OPS.low_stock || {}).count || 0) + ((DASH_OPS.out_of_stock || {}).count || 0);
  if (allLow) {
    const src = (TD.stockStore && TD.stockOps) ? TD.stockOps : DASH_OPS;
    const low = src.low_stock || { count: 0, items: [] };
    const oos = src.out_of_stock || { count: 0, items: [] };
    const cnt = low.count + oos.count;
    const storeSel = (TD.stores && TD.stores.length >= 2) ? tdStoreSelectHtml() : '';
    let rowsHtml, moreText;
    if (cnt === 0) {
      // Picked a store that's fully stocked — say so rather than showing nothing.
      rowsHtml = `<div class="td-attn-clear">${cuT('All stocked at this store', '此门店库存充足')}</div>`;
      moreText = '';
    } else {
      const prodRow = (it, val) => `
        <button type="button" class="td-attn-row"${it.id ? ` onclick="dashOpenProductFromFeed(${Number(it.id)})"` : ''}>
          <span class="name">${escapeHtml(dbProdName(it))}</span>
          <span class="val">${val}</span>
        </button>`;
      const oosRows = (oos.items || []).slice(0, 2).map(it => prodRow(it, cuT('out', '售罄')));
      const lowRows = (low.items || []).slice(0, 4 - Math.min(2, (oos.items || []).length))
        .map(it => prodRow(it, cuT(`${it.stock_qty} left`, `剩 ${it.stock_qty}`)));
      const shown = Math.min(2, (oos.items || []).length) + lowRows.length;
      const restN = cnt - shown;
      const at = TD.stockStore ? ' ' + cuT('at ' + tdStockStoreName(), '· ' + tdStockStoreName()) : '';
      rowsHtml = oosRows.join('') + lowRows.join('');
      // The hidden tail is a link now — it opens the stock drawer with the
      // full list (data-no-i18n: the CN string can hold a " · " store tail,
      // and the whole label is repainted by tdAttnRender on a toggle anyway).
      moreText = restN > 0
        ? `<button type="button" class="td-attn-more-link" data-no-i18n onclick="dashStockDrawerOpen(event)">${cuT(`and ${restN} more${at}`, `另有 ${restN} 项${TD.stockStore ? ' · ' + tdStockStoreName() : ''}`)}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button>`
        : '';
    }
    cards.push(tdAttnCard('amber', 'box', cuT('Running low', '库存告急'), cnt, rowsHtml, moreText,
      `<button type="button" class="td-attn-go" onclick="dashOpenRestock()">${cuT('Open restock', '前往补货')}</button>`,
      storeSel));
  }

  // Delivery — always shown (per request) so it's a permanent fixture. When the
  // carrier has flagged a problem it's the brick "needs a call" card; when clear
  // it's a calm sage all-clear so the operator can see deliveries are fine.
  const da = DASH_OPS.delivery_alerts || { count: 0, items: [] };
  if (da.count) {
    const reasonOf = it => {
      const info = (typeof deliveryStateInfo === 'function' && deliveryStateInfo(it))
        || { en: 'delivery issue', cn: '配送异常' };
      return cuT(info.en, info.cn);
    };
    const rows = (da.items || []).slice(0, 4).map(it => `
      <button type="button" class="td-attn-row" onclick="openOrder(${Number(it.id)})">
        <span class="name">${escapeHtml(it.order_no || '')} · ${escapeHtml(reasonOf(it))}</span>
      </button>`).join('');
    const first = (da.items || [])[0] || {};
    const more = da.count === 1
      ? escapeHtml(first.buyer || '')
      : (da.count > 4 ? cuT(`and ${da.count - 4} more`, `另有 ${da.count - 4} 个`) : '');
    const action = da.count === 1 && first.id
      ? `<button type="button" class="td-attn-go" onclick="openOrder(${Number(first.id)})">${cuT('Open the order', '打开订单')}</button>`
      : '';
    cards.push(tdAttnCard('brick', 'truck', cuT('Delivery needs a call', '配送需要跟进'), da.count, rows, more, action));
  } else {
    cards.push(tdAttnCard('ok', 'truck', cuT('Delivery', '配送'), 0,
      `<div class="td-attn-clear">${cuT('All deliveries on track', '配送一切正常')}</div>`, ''));
  }

  // Refund queue — pending / reviewing requests.
  const rf = DASH_OPS.refunds || { count: 0, items: [] };
  if (rf.count) {
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
  if (inv.count) {
    const rows = (inv.items || []).slice(0, 4).map(it => `
      <button type="button" class="td-attn-row"${it.id ? ` onclick="openOrder(${Number(it.id)})"` : ''}>
        <span class="name">${escapeHtml(it.order_no || '')} · ${escapeHtml(it.title || '')}</span>
        <span class="val">${it.amount ? '¥' + Number(it.amount).toLocaleString() : '—'}</span>
      </button>`).join('');
    cards.push(tdAttnCard('amber', 'invoice', cuT('Invoices to issue', '待开发票'), inv.count, rows,
      inv.count > 4 ? cuT(`and ${inv.count - 4} more`, `另有 ${inv.count - 4} 张`) : '',
      `<button type="button" class="td-attn-go" onclick="dashOpenInvoices()">${cuT('Open in Orders', '前往订单')}</button>`));
  }

  if (!cards.length) {
    // The empty state is a compliment, not an apology — the settled waveform.
    host.innerHTML = `<section class="card td-card td-clear">
      <svg viewBox="0 0 340 24" aria-hidden="true"><path d="M10 12 C80 12, 180 12, 330 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.45"/></svg>
      <p>${cuT('Nothing needs you. Enjoy it.', '没有需要您处理的事，请安心。')}</p>
      <p class="sub">${cuT('Cards appear here the moment something does.', '一旦有事项需要处理，会立即在这里显示。')}</p>
    </section>`;
    return;
  }
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
  const row = (it, val, valCls) => `
    <button type="button" class="td-stock-row"${it.id ? ` onclick="dashOpenStockProduct(${Number(it.id)})"` : ''}>
      <span class="name"><span class="nm" data-no-i18n>${escapeHtml(dbProdName(it))}</span>${subLine(it)}</span>
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
  dashRenderCohorts();
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
  dispatched: 'Dispatched · 已发货', delivered: 'Delivered · 已送达',
  awaiting_restock: 'Awaiting stock · 待补货', cancelled: 'Cancelled · 已取消', refunded: 'Refunded · 已退款',
};
const DASH_STATUS_ORDER = ['pending_payment', 'paid', 'awaiting_restock', 'preparing', 'dispatched', 'delivered', 'cancelled', 'refunded'];

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
    dispatched: 'sage', delivered: 'sage', cancelled: 'mute', refunded: 'brick',
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

