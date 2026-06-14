/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 03/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: Dashboard: KPIs/trend/cohorts (dash*), right-now hero, bento tiles, view popover (dv*) */
// ════════════════════════════════════════════════════════════════
// DASHBOARD — channel analytics overview (reads /api/retail-admin/dashboard,
// which aggregates the live retail_orders / retail_customers / retail_visits
// tables). All charts are hand-rolled SVG/CSS — no external libraries.
// ════════════════════════════════════════════════════════════════
let DASH_DATA = null;
let DASH_METRIC = 'revenue';
// Set by the manual ↻ refresh so the KPI numbers roll up from zero (the
// dramatic entrance) rather than drifting in place — cleared after one render.
let DASH_FORCE_ROLLUP = false;

// ── Dashboard View tweaks (per-operator) — Trend chart shape, demand-heatmap
// shape, headline-number style. Persisted; defaults reproduce the base look.
const DASH_VIEW_DEFAULTS = { chart: 'curve', heat: 'cells', numbers: 'light' };
function dvLoad() {
  try { return { ...DASH_VIEW_DEFAULTS, ...(JSON.parse(localStorage.getItem('retail-admin-dash-view') || '{}')) }; }
  catch (e) { return { ...DASH_VIEW_DEFAULTS }; }
}
window.DASH_VIEW = dvLoad();
function dvApply() {
  const sec = document.getElementById('tab-dashboard'); if (!sec) return;
  sec.classList.remove('dv-num-display', 'dv-num-mono', 'dv-heat-dots', 'dv-heat-dashes');
  if (DASH_VIEW.numbers === 'display') sec.classList.add('dv-num-display');
  if (DASH_VIEW.numbers === 'mono')    sec.classList.add('dv-num-mono');
  if (DASH_VIEW.heat === 'dots')       sec.classList.add('dv-heat-dots');
  if (DASH_VIEW.heat === 'dashes')     sec.classList.add('dv-heat-dashes');
  dvSyncPanel();
}
function dvSet(key, val) {
  DASH_VIEW[key] = val;
  try { localStorage.setItem('retail-admin-dash-view', JSON.stringify(DASH_VIEW)); } catch (e) {}
  dvApply();
  if (key === 'chart' && typeof DASH_DATA !== 'undefined' && DASH_DATA && DASH_DATA.trend) dashRenderTrend();
  dvClose();   // a pick is a one-shot choice — close the popover after it
}
function dvSyncPanel() {
  const pop = document.getElementById('dv-pop'); if (!pop) return;
  pop.querySelectorAll('.ovp-seg').forEach(seg => {
    const key = seg.getAttribute('data-dv');
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.getAttribute('data-v') === DASH_VIEW[key]));
  });
}
function dvToggle() {
  const pop = document.getElementById('dv-pop'); if (!pop) return;
  if (pop.hidden) { pop.hidden = false; dvSyncPanel(); setTimeout(() => document.addEventListener('mousedown', dvOutside), 0); }
  else dvClose();
}
function dvClose() { const pop = document.getElementById('dv-pop'); if (pop) pop.hidden = true; document.removeEventListener('mousedown', dvOutside); }
function dvOutside(e) { if (!(e.target.closest && e.target.closest('.ovp-wrap'))) dvClose(); }

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

function dashInit() {
  // Wire range segment + metric buttons (once).
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
  dvApply();           // apply saved View tweaks (heatmap/number classes)
  // Deep-dive reveal motion — replay the fade-up / bar-grow / line-draw /
  // count-up each time the fold opens (gated behind .dd-open-anim so it plays
  // on reveal, not invisibly while collapsed). Removing + re-adding the class
  // with a reflow restarts the CSS animations on the already-rendered cards.
  // Range chip in the deep-dive summary = a shortcut back up to the date bar.
  // It lives inside <summary>, so swallow the click (otherwise it'd toggle the
  // fold) and zen-glide up to the range controls to pick a different date.
  const ddRange = document.getElementById('db-dd-range');
  if (ddRange) {
    const jumpToRange = (e) => {
      e.preventDefault(); e.stopPropagation();
      const bar = document.querySelector('#tab-dashboard .db-head');
      if (bar) dashZenScrollTo(bar, { top: true });
    };
    ddRange.addEventListener('click', jumpToRange);
    ddRange.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') jumpToRange(e); });
  }

  const dd = document.getElementById('db-deepdive');
  if (dd) {
    const ddBody = dd.querySelector('.db-deepdive-body');
    const ddSummary = dd.querySelector('summary');
    const ddReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let ddAnimating = false;

    // Zen reveal — drift the page down so the summary sits near the top and the
    // freshly-revealed charts come into view. Next frame so it measures against
    // the (by now) expanded layout, not a collapsed one.
    const ddZenToHead = () => {
      const head = ddSummary || dd;
      if (head) requestAnimationFrame(() => dashZenScrollTo(head, { margin: 72 }));
    };

    // Content reveal — fires whichever way the open attribute flips (native
    // toggle, or our height-driven open/close below). On open: replay the
    // fade-up / count-up. The scroll waits for the height tween to finish (see
    // finish()) so it targets the full-height page; on the native / reduced-
    // motion path there's no tween, so it's safe to scroll right away.
    dd.addEventListener('toggle', () => {
      if (dd.open) {
        dd.classList.remove('dd-open-anim');
        void dd.offsetWidth;
        dd.classList.add('dd-open-anim');
        dashKpiAnimate();
        if (!ddAnimating) ddZenToHead();
      } else {
        dd.classList.remove('dd-open-anim');
      }
    });

    // Symmetric height envelope — a native <details> snaps open/shut, so we
    // intercept the summary click and ease the body height both ways. The
    // open attribute is flipped at the right edge of each tween (open up
    // front so the body renders to measure; close only once it's collapsed),
    // which lets the toggle handler above run the reveal in step. Reduced
    // motion (or a missing body) falls back to the native instant toggle.
    if (ddSummary && ddBody) ddSummary.addEventListener('click', (e) => {
      if (ddReduce) return;          // let the browser toggle instantly
      e.preventDefault();            // we own the toggle from here
      if (ddAnimating) return;       // ignore clicks mid-tween
      ddAnimating = true;
      dd.classList.add('dd-anim');
      const finish = (close) => {
        let settled = false;
        const cleanup = () => {
          if (settled) return; settled = true;
          if (close) dd.open = false;
          ddBody.style.height = '';
          dd.classList.remove('dd-anim', 'dd-closing');
          ddAnimating = false;
          if (!close) ddZenToHead();   // page is now full height → glide into view
        };
        ddBody.addEventListener('transitionend', function done(ev) {
          if (ev.propertyName !== 'height') return;
          ddBody.removeEventListener('transitionend', done);
          cleanup();
        });
        setTimeout(cleanup, 800);   // safety net (> the .62s close tween)
      };
      if (!dd.open) {
        dd.open = true;                          // render body so we can measure
        const full = ddBody.offsetHeight;
        ddBody.style.height = '0px';
        void ddBody.offsetWidth;                 // commit the start height
        ddBody.style.height = full + 'px';       // → ease open
        finish(false);
      } else {
        dd.classList.add('dd-closing');          // slower, gentler collapse
        const full = ddBody.offsetHeight;
        ddBody.style.height = full + 'px';
        void ddBody.offsetWidth;                 // commit the start height
        ddBody.style.height = '0px';             // → ease closed
        finish(true);
      }
    });
  }
  dashSetRange('30');  // default window + initial load
  dashHeroInit();      // right-now hero (phase 2): polling + drawer wiring
  bentoInit();         // bento tiles (phase 3): layout + /ops polling
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
    const num = $('#db-live-num'); const ring = $('#db-live-ring'); const sub = $('#db-live-sub');
    if (num) { dashCountUp(num, Number(d.viewing || 0)); num.classList.toggle('live-on', !!d.viewing); }
    if (window.rmDashSetLive) rmDashSetLive(Number(d.viewing || 0));   // mirror into the mobile hero

    if (ring) ring.classList.toggle('live', !!d.viewing);
    if (sub) {
      const v = d.viewing || 0;
      const p = d.products_with_viewers || 0;
      // With a single viewer the product count is trivially 1 — redundant with
      // the big number. Only surface "across N products" once it adds signal
      // (multiple viewers: are they clustered on one product or spread out?).
      sub.textContent = !v
        ? 'No one browsing right now · 暂无浏览'
        : (v > 1 ? `across ${p} ${p === 1 ? 'product' : 'products'} · ${p} 件商品` : '');
    }
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
    const j = await api(`/api/retail-admin/dashboard?from=${todayGz}&to=${todayGz}`);
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
  dashSetDelta('#db-today-ord-d', b && b.orders,        Number(k.orders || 0),        b && b.days, v => dashTrim(v) + ' ' + cuT(v === 1 ? 'order' : 'orders', '单'));
  dashSetDelta('#db-today-new-d', b && b.new_customers, Number(k.new_customers || 0), b && b.days, v => dashTrim(v) + ' ' + cuT(v === 1 ? 'new customer' : 'new customers', '新客'));
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
    const meta = dashFeedMeta(e);
    return `<div class="db-feed-row${isNew ? ' is-new' : ''}" data-type="${escapeHtml(e.type)}" data-ref-id="${escapeHtml(e.ref_id == null ? '' : e.ref_id)}" onclick="dashFeedClick(this, event)">
      <span class="db-feed-ts">${tstr}</span>
      <span class="db-feed-icon db-fi-${meta.tone || 'muted'}">${meta.icon}</span>
      <span class="db-feed-text">${meta.text}</span>
    </div>`;
  };
  // Preview rows render directly; the overflow lives in a collapsible wrapper
  // that the toggle eases open/closed — all rows stay in the DOM so the
  // grid-rows transition has something to animate against.
  const preview = events.slice(0, DASH_FEED_PREVIEW).map(rowHtml).join('');
  const rest = events.slice(DASH_FEED_PREVIEW);
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
  toggle.innerHTML = expanded ? 'Collapse · 收起' : `Show all (${total}) · 展开`;
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
  switch (e.type) {
    case 'paid_order': {
      const badge = p.first_order ? ` <span class="db-feed-badge db-fb-first">${FEED_SVG.star}First · 首单</span>`
                  : p.big_order   ? ` <span class="db-feed-badge db-fb-big">${FEED_SVG.star}Big · 大单</span>` : '';
      return { icon: FEED_SVG.ok, tone: 'ok', text: `<b>Paid · 已付</b> ${escapeHtml(p.order_no || '')} · ¥${Number(p.total || 0).toLocaleString()} · ${escapeHtml(p.buyer || '')}${badge}` };
    }
    case 'order_dispatched':
      return { icon: FEED_SVG.truck, tone: 'muted', text: `<b>Dispatched · 已发货</b> ${escapeHtml(p.order_no || '')} · ${escapeHtml(p.buyer || '')}` };
    case 'order_delivered':
      return { icon: FEED_SVG.box, tone: 'ok', text: `<b>Delivered · 已送达</b> ${escapeHtml(p.order_no || '')} · ${escapeHtml(p.buyer || '')}` };
    case 'refund_request':
      return { icon: FEED_SVG.refund, tone: 'warn', text: `<b>Refund · 退款</b> ${escapeHtml(p.order_no || '')}${p.amount ? ' · ¥' + Number(p.amount).toLocaleString() : ''} · ${escapeHtml(p.buyer || '')}` };
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
// BENTO (phase 3/3) — 6 swappable tiles above the Deep-dive fold.
// Per-operator layout persisted to localStorage under the existing
// `retail-admin-dash-view` key (extends, doesn't replace, the View
// popover's saved settings). Data sources:
//   - DASH_DATA  : the historical date-range pull (already loaded)
//   - DASH_OPS   : a tiny snapshot of low-stock + refunds queue,
//                  refreshed every 60s by bentoLoadOps()
// Tiles re-render automatically when either source updates — we
// monkey-patch the existing dashRenderAll to trigger a bento refresh.
// ════════════════════════════════════════════════════════════════
const BENTO_SLOTS = ['a','b','c','d','e','f'];
const BENTO_DEFAULT = ['low_stock','refunds','top_products','top_customers','geography','heatmap_mini'];

// Thin-stroke header glyphs per tile (16-box viewBox, currentColor → tinted by
// .db-tile-ic). A quiet visual anchor so the eye learns each tile by shape.
const BENTO_ICONS = {
  low_stock:        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5L8 2.2 13.5 5v6L8 13.8 2.5 11z"/><path d="M2.5 5L8 7.8 13.5 5"/><path d="M8 7.8v6"/></svg>',
  refunds:          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h6.5a3.5 3.5 0 0 1 0 7H5"/><path d="M5.2 3l-2.3 2.5L5.2 8"/></svg>',
  top_products:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.6 2.2H13v4.4l-6.4 6.4a1 1 0 0 1-1.4 0L2.4 9.8a1 1 0 0 1 0-1.4z"/><circle cx="10.4" cy="4.6" r="0.9"/></svg>',
  top_customers:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5a5 5 0 0 1 10 0"/></svg>',
  geography:        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14z"/><circle cx="8" cy="6.4" r="1.6"/></svg>',
  heatmap_mini:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.4"/><path d="M6 2.4v11.2M10 2.4v11.2M2.4 6h11.2M2.4 10h11.2"/></svg>',
  customer_tiers:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2l5.5 3-5.5 3-5.5-3z"/><path d="M2.5 8L8 11l5.5-3"/><path d="M2.5 11L8 14l5.5-3"/></svg>',
  payment_split:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.2" y="4" width="11.6" height="8" rx="1.4"/><path d="M2.2 6.6h11.6"/><path d="M5 9.6h2"/></svg>',
  delivery_split:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4.5h7.4v6H1.8z"/><path d="M9.2 6.5h2.6L14 8.6v1.9H9.2z"/><circle cx="4.4" cy="11.4" r="1.3"/><circle cx="11" cy="11.4" r="1.3"/></svg>',
  checkout_abandon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2.5h1.7l1.4 7.2a1 1 0 0 0 1 .8h5a1 1 0 0 0 1-.8l.9-4.5H4.3"/><circle cx="6.2" cy="13" r="0.9"/><circle cx="11.4" cy="13" r="0.9"/></svg>',
};

// Tile catalogue — { key → { title_en, title_cn, render(slot), source } }.
// `source` ∈ {'ops','dash'} — bentoRefresh() filters by source so an
// /ops refresh doesn't re-render dash-data tiles and vice versa.
const BENTO_CATALOGUE = {
  low_stock: {
    title_en: 'Low stock', title_cn: '缺货预警', source: 'ops',
    render: (body, tile) => {
      const d = (DASH_OPS && DASH_OPS.low_stock) || { count: 0, items: [] };
      if (!d.count) return body.innerHTML = `<div class="db-tile-num good">0</div><div class="db-tile-sub">All stocked · 库存充足</div>`;
      if (tile) tile.classList.add('alert');
      const rows = d.items.slice(0, 6).map(it => `<div class="db-tile-list-row">
        <span class="name">${escapeHtml(dbProdName(it))}</span>
        <span class="val">${it.stock_qty}</span>
      </div>`).join('');
      body.innerHTML = `<div class="db-tile-num warn">${d.count}</div>
        <div class="db-tile-sub">need restock · 件需补货</div>
        <div class="db-tile-list" style="margin-top:10px">${rows}</div>`;
    },
  },
  refunds: {
    title_en: 'Refunds queue', title_cn: '退款队列', source: 'ops',
    render: (body, tile) => {
      const d = (DASH_OPS && DASH_OPS.refunds) || { count: 0, items: [] };
      if (!d.count) return body.innerHTML = `<div class="db-tile-num good">0</div><div class="db-tile-sub">No open requests · 暂无</div>`;
      if (tile) tile.classList.add('alert');
      const rows = d.items.slice(0, 6).map(it => `<div class="db-tile-list-row">
        <span class="name">${escapeHtml(it.order_no || '')} · ${escapeHtml(it.buyer || '')}</span>
        <span class="val">${it.amount ? '¥' + Number(it.amount).toLocaleString() : '—'}</span>
      </div>`).join('');
      body.innerHTML = `<div class="db-tile-num warn">${d.count}</div>
        <div class="db-tile-sub">pending / reviewing · 待处理</div>
        <div class="db-tile-list" style="margin-top:10px">${rows}</div>`;
    },
  },
  top_products: {
    title_en: 'Top products', title_cn: '热销产品', source: 'dash',
    render: (body) => {
      const list = (DASH_DATA && DASH_DATA.topProducts) || [];
      if (!list.length) return body.innerHTML = `<div class="db-tile-empty">No sales in range · 区间内无销售</div>`;
      // Rank by units so the magnitude bars descend cleanly (the backend list
      // is revenue-ranked, which fought the units-based bars).
      const ranked = list.slice().sort((a, b) => (Number(b.units) || 0) - (Number(a.units) || 0));
      const rows = dashBarRows(ranked.slice(0, 6), {
        name: p => dbProdName(p),
        value: p => Number(p.units || 0),
        display: p => String(p.units || 0),
      });
      body.innerHTML = `<div class="db-tile-list">${rows}</div>${dashRangeFoot()}`;
    },
  },
  top_customers: {
    title_en: 'Top customers', title_cn: '顶级顾客', source: 'dash',
    render: (body) => {
      const list = (DASH_DATA && DASH_DATA.topCustomers) || [];
      if (!list.length) return body.innerHTML = `<div class="db-tile-empty">No customers in range · 区间内无顾客</div>`;
      const rows = dashBarRows(list.slice(0, 6), {
        name: c => c.nickname || ('#' + c.customer_id),
        value: c => Number(c.revenue || 0),
        display: c => '¥' + Number(c.revenue || 0).toLocaleString(),
        curve: 'sqrt',   // revenue is whale-skewed — spread the non-leaders out
      });
      body.innerHTML = `<div class="db-tile-list">${rows}</div>${dashRangeFoot()}`;
    },
  },
  geography: {
    title_en: 'Top areas', title_cn: '热门地区', source: 'dash',
    render: (body) => {
      const list = (DASH_DATA && DASH_DATA.geoCities) || [];
      if (!list.length) return body.innerHTML = `<div class="db-tile-empty">No delivery data · 暂无数据</div>`;
      const en = !(window.cuLang && cuLang() === 'cn');
      const rows = dashBarRows(list.slice(0, 6), {
        name: g => (en ? (g.city_en || g.city) : (g.city || g.city_en)) || '—',
        value: g => Number(g.orders || 0),
        display: g => String(g.orders || 0),
      });
      body.innerHTML = `<div class="db-tile-list">${rows}</div>${dashRangeFoot()}`;
    },
  },
  heatmap_mini: {
    title_en: 'Demand heatmap', title_cn: '需求热力图', source: 'dash',
    render: (body) => {
      const heat = (DASH_DATA && DASH_DATA.heat) || [];
      if (!heat.length) return body.innerHTML = `<div class="db-tile-empty">No data · 暂无数据</div>`;
      // 7 rows (day of week, dow 0=Sun..6=Sat) × 24 cols (hour). Server
      // returns a flat [{dow, hour, orders}] list. Build a 7×24 grid; cell
      // intensity = orders / max. Track the single busiest cell for the caption.
      const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
      let max = 0, peak = null;
      for (const r of heat) {
        const d = Number(r.dow); const h = Number(r.hour); const n = Number(r.orders || 0);
        if (d >= 0 && d < 7 && h >= 0 && h < 24) {
          grid[d][h] = n;
          if (n > max) max = n;
          if (n > 0 && (!peak || n > peak.n)) peak = { n, dow: d, hour: h };
        }
      }
      const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      const rowsHtml = grid.map((row, d) => {
        const cells = row.map(n => {
          const t = max ? n / max : 0;
          const op = t > 0 ? (0.18 + 0.72 * t).toFixed(2) : 0;
          return `<i style="background: rgba(176,141,74,${op})"></i>`;
        }).join('');
        return `<span class="db-heat-day">${DAYS[d]}</span><div class="db-heat-cells">${cells}</div>`;
      }).join('');
      const axis = `<span></span><div class="db-heat-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>`;
      // Caption keeps the English half free of " · " so the i18n splitter
      // (first " · " = EN|CN divider) parses it correctly.
      const EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const hh = peak ? String(peak.hour).padStart(2, '0') : '';
      const cap = peak
        ? `Busiest ${EN[peak.dow]} ${hh}:00 · 最忙 ${CN[peak.dow]} ${hh}:00`
        : `7 days × 24 hours · 7天 × 24小时`;
      body.innerHTML = `<div class="db-heat-mini">${rowsHtml}${axis}</div>
        <div class="db-tile-sub" style="margin-top:8px">${cap}</div>`;
    },
  },
  customer_tiers: {
    title_en: 'Customer mix', title_cn: '顾客构成', source: 'dash',
    render: (body) => {
      const list = (DASH_DATA && DASH_DATA.tiers) || [];
      if (!list.length) return body.innerHTML = `<div class="db-tile-empty">No data · 暂无数据</div>`;
      const rows = dashBarRows(list.slice(0, 4), {
        name: t => t.label || t.tier_key || '—',
        value: t => Number(t.n || t.count || 0),
        display: t => String(t.n || t.count || 0),
      });
      body.innerHTML = `<div class="db-tile-list">${rows}</div>${dashRangeFoot()}`;
    },
  },
  payment_split: {
    title_en: 'Payment split', title_cn: '支付构成', source: 'dash',
    render: (body) => {
      const list = (DASH_DATA && DASH_DATA.payments) || [];
      if (!list.length) return body.innerHTML = `<div class="db-tile-empty">No data · 暂无数据</div>`;
      const total = list.reduce((s, r) => s + (r.revenue || 0), 0) || 1;
      const rows = dashBarRows(list.slice(0, 4), {
        name: p => p.method || '—',
        value: p => Number(p.revenue || 0),
        display: p => ((p.revenue || 0) / total * 100).toFixed(0) + '%',
      });
      body.innerHTML = `<div class="db-tile-list">${rows}</div>${dashRangeFoot()}`;
    },
  },
  delivery_split: {
    title_en: 'Delivery split', title_cn: '配送构成', source: 'dash',
    render: (body) => {
      const list = (DASH_DATA && DASH_DATA.delivery) || [];
      if (!list.length) return body.innerHTML = `<div class="db-tile-empty">No data · 暂无数据</div>`;
      const total = list.reduce((s, r) => s + (r.orders || 0), 0) || 1;
      const rows = dashBarRows(list.slice(0, 4), {
        name: d => d.mode || '—',
        value: d => Number(d.orders || 0),
        display: d => ((d.orders || 0) / total * 100).toFixed(0) + '%',
      });
      body.innerHTML = `<div class="db-tile-list">${rows}</div>${dashRangeFoot()}`;
    },
  },
  checkout_abandon: {
    title_en: 'Abandoned checkouts', title_cn: '弃单分析', source: 'dash',
    render: (body, tile) => {
      const d = (DASH_DATA && DASH_DATA.checkout) || { started: 0, converted: 0, abandoned: 0, conversion_rate: null, products: [] };
      if (!d.started) return body.innerHTML = `<div class="db-tile-num good">0</div><div class="db-tile-sub">No checkouts in range · 区间内无结算</div>`;
      if (d.abandoned > 0 && tile) tile.classList.add('alert');
      const conv = d.conversion_rate != null ? d.conversion_rate : 0;
      const numClass = d.abandoned > 0 ? 'warn' : 'good';
      // Top products left behind — value column is how many distinct customers
      // walked away from that product (more telling than raw qty).
      const rows = (d.products || []).slice(0, 6).map(p => `<div class="db-tile-list-row">
        <span class="name">${escapeHtml(p.name_en || p.name_cn || ('#' + p.product_id))}</span>
        <span class="val">${p.customers || 0}</span>
      </div>`).join('');
      body.innerHTML = `<div class="db-tile-num ${numClass}">${d.abandoned}</div>
        <div class="db-tile-sub">${conv}% completed · 完成率 ${conv}%</div>
        ${rows ? `<div class="db-tile-list" style="margin-top:10px">${rows}</div>` : ''}`;
    },
  },
};

let DASH_OPS = null;

function bentoLoadLayout() {
  // Merge with View popup saved state — same key, different sub-object.
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('retail-admin-dash-view') || '{}'); } catch (e) {}
  const layout = Array.isArray(saved.bento) && saved.bento.length === 6 ? saved.bento : BENTO_DEFAULT.slice();
  // Sanitise: unknown keys → fall back to default for that slot.
  const sane = layout.map((k, i) => BENTO_CATALOGUE[k] ? k : BENTO_DEFAULT[i]);
  // De-dupe: no two slots should show the same tile (the eye shouldn't meet
  // "Low stock" twice). A repeat is replaced by the first unused catalogue
  // tile — fixes legacy saved layouts that doubled up.
  const seen = new Set();
  const allKeys = Object.keys(BENTO_CATALOGUE);
  return sane.map(k => {
    if (!seen.has(k)) { seen.add(k); return k; }
    const repl = allKeys.find(c => !seen.has(c)) || k;
    seen.add(repl); return repl;
  });
}
function bentoSaveLayout(layout) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('retail-admin-dash-view') || '{}'); } catch (e) {}
  saved.bento = layout;
  try { localStorage.setItem('retail-admin-dash-view', JSON.stringify(saved)); } catch (e) {}
}

function bentoInit() {
  bentoRenderAll();
  bentoLoadOps();
  // /ops snapshot refreshes every 60s, but only while the tab is visible —
  // the same visibility listener the hero uses gates this loop too.
  if (!DASH_HERO._opsTimer) {
    DASH_HERO._opsTimer = setInterval(() => { if (!document.hidden) bentoLoadOps(); }, 60000);
  }
}

async function bentoLoadOps() {
  try {
    const j = await api('/api/retail-admin/dashboard/ops');
    DASH_OPS = j.data || null;
    bentoRefresh('ops');
  } catch (e) { /* silent — next tick retries */ }
}

function bentoRenderAll() {
  const layout = bentoLoadLayout();
  layout.forEach((key, idx) => bentoRenderSlot(BENTO_SLOTS[idx], key));
}

// Pick a product's name in the active UI language, falling back to the
// other language when the preferred one is missing.
function dbProdName(o) {
  const cn = (window.cuLang && cuLang() === 'cn');
  return (cn ? (o.name_cn || o.name_en) : (o.name_en || o.name_cn)) || '—';
}

function bentoRefresh(sourceFilter) {
  const layout = bentoLoadLayout();
  layout.forEach((key, idx) => {
    const entry = BENTO_CATALOGUE[key];
    if (!entry) return;
    if (sourceFilter && entry.source !== sourceFilter) return;
    bentoRenderSlot(BENTO_SLOTS[idx], key);
  });
}

function bentoRenderSlot(slot, key) {
  const tile = document.getElementById('db-tile-' + slot); if (!tile) return;
  const entry = BENTO_CATALOGUE[key]; if (!entry) return;
  const title = tile.querySelector('.db-tile-title');
  const ic    = tile.querySelector('.db-tile-ic');
  const body  = tile.querySelector('.db-tile-body');
  if (title) title.textContent = `${entry.title_en} · ${entry.title_cn}`;
  if (ic) ic.innerHTML = (BENTO_ICONS && BENTO_ICONS[key]) || '';
  // Each render starts clean — only attention tiles re-flag .alert below.
  tile.classList.remove('alert');
  if (body) {
    try { entry.render(body, tile); }
    catch (e) { body.innerHTML = `<div class="db-tile-empty">Render failed · 渲染失败</div>`; }
  }
}

// ── Tile swap popover ─────────────────────────────────────────────────────
function bentoMenuOpen(buttonEl, slot) {
  // Toggle: a second click on the same tile's ⋯ closes the open popover.
  const existingPop = document.getElementById('db-tile-pop');
  const wasOpenForThisSlot = existingPop && existingPop.dataset.slot === slot;
  bentoMenuClose();
  if (wasOpenForThisSlot) return;
  const layout = bentoLoadLayout();
  const currentKey = layout[BENTO_SLOTS.indexOf(slot)];
  const pop = document.createElement('div');
  pop.className = 'db-tile-pop';
  pop.id = 'db-tile-pop';
  pop.dataset.slot = slot;
  const items = Object.entries(BENTO_CATALOGUE).map(([k, entry]) => {
    const active = k === currentKey ? ' active' : '';
    return `<button type="button" class="${active.trim()}" onclick="bentoSetTile('${slot}','${k}')">
      ${escapeHtml(entry.title_en)} · ${escapeHtml(entry.title_cn)}
    </button>`;
  }).join('');
  pop.innerHTML = `<div class="db-tile-pop-head">Show in this tile · 显示内容</div>${items}`;
  document.body.appendChild(pop);
  // Anchor to the button — fixed-position so scroll doesn't dislodge it.
  const r = buttonEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const margin = 8, gap = 6;
  // Horizontal: align right edge with button, then clamp into the viewport.
  let left = r.right - popRect.width;
  if (left < margin) left = margin;
  if (left + popRect.width > window.innerWidth - margin) left = window.innerWidth - popRect.width - margin;
  // Vertical: open below when it fits, else flip to whichever side has more
  // room. Cap height to the available space so a long list scrolls inside the
  // popover instead of running off the bottom of the screen.
  const spaceBelow = window.innerHeight - r.bottom - gap - margin;
  const spaceAbove = r.top - gap - margin;
  let top, maxH;
  if (popRect.height <= spaceBelow || spaceBelow >= spaceAbove) {
    maxH = spaceBelow;
    top  = r.bottom + gap;
  } else {
    maxH = spaceAbove;
    top  = r.top - gap - Math.min(popRect.height, maxH);
  }
  pop.style.maxHeight = Math.max(120, maxH) + 'px';
  pop.style.left = left + 'px';
  pop.style.top  = Math.max(margin, top) + 'px';
  // Outside-click closes; defer the listener so the opening click doesn't fire it.
  setTimeout(() => document.addEventListener('mousedown', bentoMenuOutside), 0);
}
function bentoMenuClose() {
  const pop = document.getElementById('db-tile-pop'); if (pop) pop.remove();
  document.removeEventListener('mousedown', bentoMenuOutside);
}
function bentoMenuOutside(e) {
  // Ignore clicks on a ⋯ button — its own onclick handles open/close (toggle).
  if (e.target.closest && e.target.closest('.db-tile-menu')) return;
  if (!e.target.closest || !e.target.closest('.db-tile-pop')) bentoMenuClose();
}
function bentoSetTile(slot, key) {
  if (!BENTO_CATALOGUE[key]) return;
  const layout = bentoLoadLayout();
  const idx = BENTO_SLOTS.indexOf(slot);
  // If this tile is already shown elsewhere, swap the two slots so all six
  // stay unique rather than letting the same tile appear twice.
  const existing = layout.indexOf(key);
  if (existing !== -1 && existing !== idx) {
    layout[existing] = layout[idx];
    bentoRenderSlot(BENTO_SLOTS[existing], layout[existing]);
  }
  layout[idx] = key;
  bentoSaveLayout(layout);
  bentoRenderSlot(slot, key);
  bentoMenuClose();
}

// Hook into the existing dashRenderAll so bento tiles that read from
// DASH_DATA refresh whenever the date range loads. Wrap once.
(function wireBentoToDashRender(){
  if (typeof dashRenderAll !== 'function' || dashRenderAll._bentoWrapped) return;
  const orig = dashRenderAll;
  dashRenderAll = function() {
    orig.apply(this, arguments);
    try { bentoRefresh('dash'); } catch (e) {}
  };
  dashRenderAll._bentoWrapped = true;
})();

// Echo the active range into the deep-dive summary so the timeline stays
// legible once you've scrolled past the top range bar (read-only — change it
// up top). Kept in sync on every dashLoad().
function dashRangeLabel() {
  const el = document.getElementById('db-dd-range');
  if (!el) return;
  const from = $('#db-from').value, to = $('#db-to').value;
  if (!from || !to) { el.textContent = ''; return; }
  const active = document.querySelector('#db-range-seg button.active');
  const key = active ? active.dataset.range : '';
  const tag = key === 'today' ? 'Today · 今日'
            : key === '7'  ? '7d'
            : key === '30' ? '30d'
            : key === '90' ? '90d'
            : 'Custom · 自定';
  const fmt = s => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  el.textContent = from === to ? `${fmt(from)} · ${tag}` : `${fmt(from)} – ${fmt(to)} · ${tag}`;
}

async function dashLoad() {
  const from = $('#db-from').value, to = $('#db-to').value;
  dashRangeLabel();
  // Only the cold first load shows "Loading…" — on a refresh we keep the
  // current numbers on screen until the fresh ones fade in, so there's no
  // blank-out flick.
  if (!DASH_DATA) $('#db-kpis').innerHTML = '<div class="db-muted">Loading… · 加载中…</div>';
  try {
    const j = await api(`/api/retail-admin/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
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
  const els = ['db-bento', 'db-deepdive'].map(id => document.getElementById(id)).filter(Boolean);
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
  dashRenderKpis();
  dashRenderTrend();
  dashRenderHeatmap();
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
  const cards = [
    { lbl: 'Revenue · 营收',        val: dashMoney(k.revenue),       num: k.revenue,         fmt: 'money',  delta: d.revenue,       sub: '', accent: true },
    { lbl: 'Orders · 订单',         val: dashNum(k.orders),          num: k.orders,          fmt: 'num',    delta: d.orders,        sub: '' },
    { lbl: 'Avg order · 客单价',     val: dashMoney(k.aov, 2),        num: k.aov,             fmt: 'money2', delta: d.aov,           sub: '' },
    { lbl: 'New customers · 新客',   val: dashNum(k.new_customers),   num: k.new_customers,   fmt: 'num',    delta: d.new_customers, sub: '' },
    { lbl: 'Visits · 访问',         val: dashNum(k.visits),          num: k.visits,          fmt: 'num',    delta: d.visits,        sub: k.visits === 0 ? 'No data yet · 暂无' : dashNum(k.sessions) + ' ' + cuT('sessions', '会话') },
    { lbl: 'Unique visitors · 访客', val: dashNum(k.visitors),        num: k.visitors,        fmt: 'num',    delta: null,            sub: '' },
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
  // If the fold is already open when fresh data lands, count up now (the open
  // event won't fire again). Otherwise the open handler runs it on reveal.
  // A manual ↻ refresh forces a roll-up from zero (no prev) for the re-reveal.
  if (document.getElementById('db-deepdive')?.open) dashKpiAnimate(DASH_FORCE_ROLLUP ? null : prevVals);
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
  const win = DASH_DATA.window;
  $('#db-trend-window').textContent = win ? `· ${win.from}${win.from !== win.to ? ' → ' + win.to : ''}` : '';
  const metric = DASH_METRIC;
  const cs = (window.DASH_VIEW ? DASH_VIEW.chart : 'curve');   // View tweak: curve|bars|dots
  const isMoney = metric === 'revenue';
  const vals = t.map(p => Number(p[metric] || 0));
  const max = Math.max(1, ...vals);
  const W = 820, H = 240, padL = 8, padR = 8, padT = 14, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = t.length || 1;
  const x = i => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = v => padT + innerH - (v / max) * innerH;

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (g / 4) * innerH;
    const gv = max * (1 - g / 4);
    grid += `<line class="grid-line" x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}"/>`;
    grid += `<text class="ax" x="${padL + 2}" y="${(gy - 3).toFixed(1)}">${isMoney ? dashMoney(gv) : dashNum(Math.round(gv))}</text>`;
  }
  const linePts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = n > 1 ? `<path class="area" d="M ${linePts.join(' L ')} L ${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L ${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z"/>` : '';
  const line = n > 1 ? `<polyline class="line" points="${linePts.join(' ')}" pathLength="1"/>` : '';

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  let xl = '', dots = '', hover = '';
  t.forEach((p, i) => {
    const px = x(i), py = y(vals[i]);
    if (i % labelEvery === 0 || i === n - 1) {
      const lbl = String(p.bucket).length > 5 ? String(p.bucket).slice(5) : String(p.bucket);
      xl += `<text class="ax" x="${px.toFixed(1)}" y="${H - 6}" text-anchor="middle">${escapeHtml(lbl)}</text>`;
    }
    if (cs === 'dots' || n <= 32) dots += `<circle class="dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${cs === 'dots' ? 3.6 : 2.5}"/>`;
    const colW = innerW / Math.max(1, n - 1);  // tile contiguously, point-to-point
    hover += `<rect class="hovercol" data-i="${i}" onmousemove="dashTrendTip(event)" x="${(px - colW / 2).toFixed(1)}" y="${padT}" width="${colW.toFixed(1)}" height="${innerH}"></rect>`;
  });

  // Bars mode — one rounded column per bucket from the baseline up.
  let bars = '';
  if (cs === 'bars') {
    const bw = Math.max(2, (innerW / n) * 0.55);
    bars = vals.map((v, i) => `<rect class="bar" x="${(x(i) - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, padT + innerH - y(v)).toFixed(1)}" rx="1.5"/>`).join('');
  }
  const svgArea = cs === 'curve' ? area : '';
  const svgLine = cs === 'curve' ? line : '';
  const svgDots = cs !== 'bars' ? dots : '';

  $('#db-trend').innerHTML = `<svg class="db-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" onmouseleave="dashTrendHide()">${grid}${svgArea}${svgLine}${bars}${svgDots}${hover}${xl}</svg>`;  /* per-column hover binding is on each .hovercol; tooltip is a body-level singleton */
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
  const max = Math.max(1, ...rows.map(r => r.frac || 0));
  return `<div class="db-bars">${rows.map(r => `
    <div class="db-bar-row">
      <div class="k" title="${escapeAttr(r.k)}">${escapeHtml(r.k)}${r.kSub ? ` <span class="sub">${escapeHtml(r.kSub)}</span>` : ''}</div>
      <div class="db-track"><span class="${r.muted ? 'muted' : ''}" style="width:${(((r.frac || 0) / max) * 100).toFixed(1)}%${r.barColor ? `;background:${r.barColor}` : ''}"></span></div>
      <div class="v">${escapeHtml(r.value)}${r.valueSub ? ` <span class="sub">${escapeHtml(r.valueSub)}</span>` : ''}</div>
    </div>`).join('')}</div>`;
}

const DASH_STATUS_LABELS = {
  pending_payment: 'Pending · 待付款', paid: 'Paid · 已付款', preparing: 'Preparing · 备货中',
  dispatched: 'Dispatched · 已发货', delivered: 'Delivered · 已送达',
  awaiting_restock: 'Awaiting stock · 待补货', cancelled: 'Cancelled · 已取消', refunded: 'Refunded · 已退款',
};
const DASH_STATUS_ORDER = ['pending_payment', 'paid', 'awaiting_restock', 'preparing', 'dispatched', 'delivered', 'cancelled', 'refunded'];

function dashRenderFunnel() {
  const f = DASH_DATA.funnel || {};
  // Tea = money-in / done (paid, delivered); Brass = needs-action / in-flight
  // (pending, awaiting stock, preparing, dispatched); neutral = closed.
  const ATTENTION = ['pending_payment', 'awaiting_restock', 'preparing', 'dispatched'];
  const rows = DASH_STATUS_ORDER.filter(s => f[s]).map(s => ({
    k: DASH_STATUS_LABELS[s] || s,
    value: dashNum(f[s].n),
    valueSub: f[s].revenue ? dashMoney(f[s].revenue) : '',
    frac: f[s].n,
    muted: s === 'cancelled' || s === 'refunded',
    barColor: ATTENTION.includes(s) ? 'var(--brass)' : undefined,
  }));
  $('#db-funnel').innerHTML = rows.length ? dashBarList(rows) : '<div class="db-muted">No orders in range · 区间内无订单</div>';
}

function dashRenderSplits() {
  const pay = DASH_DATA.payments || [], del = DASH_DATA.delivery || [];
  const payLabel = m => ({ wechat: 'WeChat · 微信', alipay: 'Alipay · 支付宝', points: 'Points · 积分', cash: 'Cash · 现金', bank_transfer: 'Bank transfer · 银行转账', wechat_offline: 'WeChat off-app · 微信(线下)', alipay_offline: 'Alipay off-app · 支付宝(线下)', other: 'Other · 其他', unknown: 'Unknown · 未知' }[m] || m);
  const delLabel = m => ({ standard: 'Standard · 标准', max: 'Max speed · 极速', fixed: 'City · 同城', sameday: 'Same-day · 当日', unknown: 'Unknown · 未知' }[m] || m);
  let html = '<div style="font-family:var(--f-mono);font-size:10px;color:var(--brass);letter-spacing:.18em;text-transform:uppercase;margin-bottom:8px;font-weight:500">PAYMENT · 支付方式</div>';
  html += pay.length ? dashBarList(pay.map(p => ({ k: payLabel(p.method), value: dashNum(p.orders), valueSub: dashMoney(p.revenue), frac: p.revenue }))) : '<div class="db-muted">—</div>';
  html += '<div style="font-family:var(--f-mono);font-size:10px;color:var(--brass);letter-spacing:.18em;text-transform:uppercase;margin:16px 0 8px;font-weight:500">DELIVERY · 配送方式</div>';
  html += del.length ? dashBarList(del.map(p => ({ k: delLabel(p.mode), value: dashNum(p.orders), frac: p.orders }))) : '<div class="db-muted">—</div>';
  $('#db-splits').innerHTML = html;
}

function dashRenderProducts() {
  const p = DASH_DATA.topProducts || [];
  if (!p.length) { $('#db-products').innerHTML = '<div class="db-muted">No sales in range · 区间内无销售</div>'; return; }
  const nm = (en, cn) => en || cn || '—';
  $('#db-products').innerHTML = '<div class="db-list">' + p.map((r, i) => `
    <div class="db-row">
      <div class="rank">${i + 1}</div>
      ${r.image_url ? `<img class="thumb" src="${escapeAttr(r.image_url)}" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="thumb"></div>'}
      <div class="nm"><b title="${escapeAttr(nm(r.name_en, r.name_cn))}">${escapeHtml(nm(r.name_en, r.name_cn))}</b><span>${dashNum(r.units)} ${cuT('sold','已售')} · ${dashNum(r.orders)} ${cuT('orders','单')}</span></div>
      <div class="mny"><b>${dashMoney(r.revenue)}</b></div>
    </div>`).join('') + '</div>';
}

function dashRenderCustomers() {
  const c = DASH_DATA.topCustomers || [];
  if (!c.length) { $('#db-customers').innerHTML = '<div class="db-muted">No buyers in range · 区间内无买家</div>'; return; }
  $('#db-customers').innerHTML = '<div class="db-list">' + c.map((r, i) => `
    <div class="db-row">
      <div class="rank">${i + 1}</div>
      <div class="nm"><b>${escapeHtml(r.nickname || ('Customer #' + r.customer_id))}</b><span>${escapeHtml(r.phone || '')} · ${dashNum(r.orders)} ${cuT('orders','单')}</span></div>
      <div class="mny"><b>${dashMoney(r.revenue)}</b><span>${escapeHtml(r.tier_key || 'seed')}</span></div>
    </div>`).join('') + '</div>';
}

function dashRenderTiers() {
  const nvr = DASH_DATA.new_vs_returning || {};
  const tiers = DASH_DATA.tiers || [];
  const tierLabel = t => ({ seed: 'Seed · 种子', sprout: 'Sprout · 嫩芽', root: 'Root · 扎根', tree: 'Tree · 大树' }[t] || t);
  let html = '<div class="db-tiles">'
    + `<div class="db-tile"><div class="t-val">${dashNum(nvr.buyers)}</div><div class="t-lbl">Buyers · 买家</div></div>`
    + `<div class="db-tile"><div class="t-val">${dashNum(nvr.new_buyers)}</div><div class="t-lbl">New · 新客</div></div>`
    + `<div class="db-tile"><div class="t-val">${dashNum(nvr.returning_buyers)}</div><div class="t-lbl">Returning · 回头</div></div>`
    + '</div>';
  html += '<div style="font-family:var(--f-mono);font-size:10px;color:var(--brass);letter-spacing:.18em;text-transform:uppercase;margin:16px 0 8px;font-weight:500">TIER DISTRIBUTION · 等级分布 <span style="font-weight:400;color:var(--text-3);letter-spacing:.02em;text-transform:none">(all customers · 全部顾客)</span></div>';
  html += tiers.length ? dashBarList(tiers.map(t => ({ k: tierLabel(t.tier), value: dashNum(t.n), frac: t.n }))) : '<div class="db-muted">—</div>';
  $('#db-tiers').innerHTML = html;
}

function dashRenderGeo() {
  const cities = DASH_DATA.geoCities || [];
  if (!cities.length) { $('#db-geo').innerHTML = '<div class="db-muted">No location data · 暂无地域数据</div>'; return; }
  $('#db-geo').innerHTML = dashBarList(cities.map(c => ({
    k: c.city || '—', kSub: `${dashNum(c.customers)} ${cuT('cust.','顾客')}`,
    value: dashMoney(c.revenue), valueSub: `${dashNum(c.orders)} ${cuT('ord.','单')}`, frac: c.revenue,
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
  html += '<div style="font-family:var(--f-mono);font-size:10px;color:var(--brass);letter-spacing:.18em;text-transform:uppercase;margin:16px 0 8px;font-weight:500">VOUCHERS · 优惠券</div>';
  html += v.length ? dashBarList(v.map(x => ({ k: x.code || '—', kSub: `${dashNum(x.uses)} ${cuT('uses','次')}`, value: '−' + dashMoney(x.discount), valueSub: `${dashMoney(x.revenue)} ${cuT('rev','营收')}`, frac: x.uses }))) : '<div class="db-muted">No vouchers redeemed · 无优惠券核销</div>';
  $('#db-marketing').innerHTML = html;
}

// WeChat launch-scene code → human label (common ones; fallback shows code).
const DASH_SCENES = {
  1001: 'Mini-program list · 小程序列表', 1005: 'Search · 搜索', 1006: 'Search result · 搜索结果',
  1007: 'Single chat card · 单聊', 1008: 'Group chat card · 群聊', 1011: 'Scan QR · 扫码',
  1012: 'Long-press QR · 长按识别', 1013: 'History · 历史', 1014: 'Template msg · 模板消息',
  1017: 'From mini-program · 小程序跳转', 1019: 'Wallet · 钱包', 1020: 'Card pkg · 卡包',
  1023: 'Home screen · 桌面', 1035: 'Ad · 广告', 1036: 'App share · 分享',
  1047: 'Scan QR (Discover) · 扫码(发现)', 1048: 'History · 历史', 1058: 'Official article · 公众号文章',
  1065: 'URL scheme · 链接跳转', 1074: 'Nearby · 附近', 1089: 'Chat tools · 聊天工具',
  1107: 'Subscription msg · 订阅消息', 1131: 'Floating window · 浮窗',
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
  html += '<div style="font-family:var(--f-mono);font-size:10px;color:var(--brass);letter-spacing:.18em;text-transform:uppercase;margin:16px 0 8px;font-weight:500">ENTRY SCENES · 进入场景</div>';
  html += scenes.length ? dashBarList(scenes.map(s => ({ k: DASH_SCENES[s.scene] || ('Scene ' + s.scene), value: dashNum(s.visits), valueSub: `${dashNum(s.sessions)} sess.`, frac: s.visits }))) : '<div class="db-muted">No scene data · 无场景数据</div>';
  $('#db-traffic').innerHTML = html;
}

// ── Demand heatmap (hour-of-day × day-of-week) ──
const DASH_DOW = ['日 Sun', '一 Mon', '二 Tue', '三 Wed', '四 Thu', '五 Fri', '六 Sat'];
function dashRenderHeatmap() {
  const host = $('#db-heatmap');
  if (!host) return;
  const heat = DASH_DATA.heat || [];
  if (!heat.length) { host.innerHTML = '<div class="db-muted">No orders in range · 区间内无订单</div>'; return; }
  const grid = {};
  let max = 1;
  heat.forEach(h => { grid[h.dow + '-' + h.hour] = h; if (h.orders > max) max = h.orders; });
  const hdr = Array.from({ length: 24 }, (_, h) => `<div class="hh">${h}</div>`).join('');
  let rows = `<div class="db-heat-row hdr"><div class="dl"></div>${hdr}</div>`;
  for (let d = 0; d < 7; d++) {
    let cells = '';
    for (let h = 0; h < 24; h++) {
      const cell = grid[d + '-' + h];
      const intensity = cell ? cell.orders / max : 0;
      const bg = intensity === 0 ? 'var(--bg-elev-1)' : `rgba(107,142,111,${(0.16 + intensity * 0.84).toFixed(2)})`;
      const hh = String(h).padStart(2, '0');
      const tip = cell
        ? `${DASH_DOW[d]} ${hh}:00 — ${dashNum(cell.orders)} ${cuT('orders','单')} · ${dashMoney(cell.revenue)}`
        : `${DASH_DOW[d]} ${hh}:00 — 0`;
      cells += `<div class="db-heat-cell" style="background:${bg}" title="${escapeAttr(tip)}"></div>`;
    }
    rows += `<div class="db-heat-row"><div class="dl">${DASH_DOW[d]}</div>${cells}</div>`;
  }
  host.innerHTML = `<div class="db-heat">${rows}</div>
    <div class="db-heat-legend"><span>Fewer · 少</span>
      <span class="sw" style="background:var(--bg-elev-1)"></span>
      <span class="sw" style="background:rgba(107,142,111,.32)"></span>
      <span class="sw" style="background:rgba(107,142,111,.58)"></span>
      <span class="sw" style="background:rgba(107,142,111,.84)"></span>
      <span class="sw" style="background:rgba(107,142,111,1)"></span>
      <span>More · 多</span></div>`;
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
  const pctOf = a => Math.round(a / base * 1000) / 10;
  const row = (lbl, val, color) => `
    <div class="db-bar-row" style="grid-template-columns:130px 1fr auto">
      <div class="k"><span style="width:10px;height:10px;border-radius:3px;background:${color};flex:none"></span>${lbl}</div>
      <div class="db-track"><span style="width:${(val / base * 100).toFixed(1)}%;background:${color}"></span></div>
      <div class="v">${dashMoney(val)} <span class="sub">${pctOf(val)}%</span></div>
    </div>`;
  let html = `<div style="display:flex;height:14px;border-radius:99px;overflow:hidden;background:var(--bg-elev-1);margin-bottom:14px">
      <div title="${escapeAttr('Product · 商品')}" style="width:${(product / base * 100).toFixed(1)}%;background:var(--accent)"></div>
      <div title="${escapeAttr('Delivery · 配送')}" style="width:${(delivery / base * 100).toFixed(1)}%;background:var(--brass)"></div>
    </div>`;
  html += '<div class="db-bars">' + row('Product · 商品', product, 'var(--accent)') + row('Delivery · 配送', delivery, 'var(--brass)') + '</div>';
  html += `<div class="db-row" style="border-bottom:0;padding:10px 0 0">
      <div class="nm"><b>Net revenue · 实收</b></div>
      <div class="mny"><b style="color:var(--accent);font-size:15px">${dashMoney(net)}</b></div></div>`;
  if (discount > 0) html += `<div class="db-muted" style="color:var(--text-3)">− ${dashMoney(discount)} in voucher &amp; point discounts · 优惠券与积分让利</div>`;
  host.innerHTML = html;
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
  const tile = (m, lbl) => { const v = kpi(m); return `<div class="db-tile"><div class="t-val">${v == null ? '—' : v + '%'}</div><div class="t-lbl">${lbl}</div></div>`; };

  let curveSvg = '';
  if (curve.length > 1) {
    const W = 760, H = 150, padL = 30, padR = 10, padT = 10, padB = 22;
    const iw = W - padL - padR, ih = H - padT - padB;
    const xs = i => padL + (i / (curve.length - 1)) * iw;
    const ys = v => padT + ih - (v / 100) * ih;
    let grid = '', xl = '', dots = '';
    [0, 25, 50, 75, 100].forEach(v => {
      const gy = ys(v);
      grid += `<line class="grid-line" x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}"/>`;
      grid += `<text class="ax" x="${padL - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${v}%</text>`;
    });
    const pts = curve.map((c, i) => `${xs(i).toFixed(1)},${ys(c.pct).toFixed(1)}`);
    const area = `<path class="area" d="M ${pts.join(' L ')} L ${xs(curve.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} L ${padL},${(padT + ih).toFixed(1)} Z"/>`;
    const line = `<polyline class="line" points="${pts.join(' ')}" pathLength="1"/>`;
    curve.forEach((c, i) => {
      dots += `<circle class="dot" cx="${xs(i).toFixed(1)}" cy="${ys(c.pct).toFixed(1)}" r="2.5"><title>M${c.offset}: ${c.pct}%</title></circle>`;
      xl += `<text class="ax" x="${xs(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">M${c.offset}</text>`;
    });
    curveSvg = `<svg class="db-cohort-curve" viewBox="0 0 ${W} ${H}">${grid}${area}${line}${dots}${xl}</svg>`;
  }

  // Matrix — most recent 12 cohorts, newest first.
  const shown = months.slice(-12).reverse();
  const cols = Math.min(maxOffset + 1, 12);
  const cellColor = p => p >= 75 ? '#4E6B52' : p >= 50 ? '#5E7E62' : p >= 25 ? '#6B8E6F' : p > 0 ? '#7FA083' : null;
  let head = `<th class="l">Cohort · 队列</th><th>Size</th>`;
  for (let i = 0; i < cols; i++) head += `<th>M${i}</th>`;
  let body = '';
  shown.forEach(cm => {
    const size = sizeMap[cm] || 0;
    let cells = `<td class="lbl">${cm}</td><td class="lbl" style="text-align:right">${dashNum(size)}</td>`;
    for (let i = 0; i < cols; i++) {
      if (age[cm] < i) { cells += `<td class="empty" style="opacity:.4">·</td>`; continue; }
      const active = byMonth[cm] && byMonth[cm][monthAdd(cm, i)] || 0;
      const p = size > 0 ? Math.round(active / size * 1000) / 10 : 0;
      const col = cellColor(p);
      cells += col
        ? `<td style="background:${col};color:#E8E5DC" title="${escapeAttr(cuLang() === 'cn' ? `${monthAdd(cm, i)} 回购 ${active}/${size}` : `${active} of ${size} returned in ${monthAdd(cm, i)}`)}">${p.toFixed(0)}%</td>`
        : `<td class="empty">—</td>`;
    }
    body += `<tr>${cells}</tr>`;
  });

  host.innerHTML =
    `<div class="db-tiles" style="margin-bottom:14px">${tile(1, 'M1 · 1月')}${tile(3, 'M3 · 3月')}${tile(6, 'M6 · 6月')}${tile(12, 'M12 · 12月')}</div>`
    + curveSvg
    + `<div class="db-cohort-wrap"><table class="db-cohort-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
    + `<div class="db-cohort-note"><b>How to read · 阅读说明:</b> Each row is the customers whose first order was that month. M0 = their first month (always 100%); M1, M2… show the share who ordered again that many months later. · 每行为该月首单的客户群，M0 为入群当月(恒为 100%)，M1、M2… 为之后第 N 个月再次下单的占比。</div>`;
}

