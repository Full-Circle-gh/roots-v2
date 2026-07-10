/* eslint-disable no-undef, no-func-assign, no-self-assign */
// Inventory activity ledger viewer — Tacet "read first" layout: digest cards
// (hit zero / big moves / by channel) over a quiet ledger table, with date
// range + channel filters and one-click CSV export.
// Since 2026-07-10 this renders INSIDE the Orders tab (#ord-view-activity, the
// "Stock activity" sub-view — ordShowView in 04-orders.js calls actAdminInit);
// the old standalone rail tab is gone. Ids and behaviour are unchanged.
// Reads /api/retail-admin/activity (over retail_stock_ledger). All times shown
// are Guangzhou local (UTC+8), matching the server's day boundaries.
// Spec: reference/inventory-activity-tacet-mockup.html (option C). Brand rules
// worth keeping honest here: a sale is normal so its delta stays ink, stock-in
// is sage, and a zero balance is the only amber on the table. Channels have no
// colours — a channel is a filter, not a traffic light.

const ACT = { from: null, to: null, source: '', q: '', offset: 0, limit: 200, rows: [], total: 0, loading: false };

// Source tokens come from the server (reason-derived). Meituan is split per
// storefront — Tianhe (外卖) and Yuexiu (闪购). The front-end owns every label;
// they follow the live language via actT.
const ACT_SOURCE_NAME = {
  miniapp:        () => actT('Mini-app', '小程序'),
  gzgrocery:      () => 'Gzgrocery',
  meituan_tianhe: () => actT('Meituan Tianhe', '美团天河'),
  meituan_yuexiu: () => actT('Meituan Yuexiu', '美团越秀'),
  meituan:        () => actT('Meituan', '美团'),
  guanyi:         () => actT('Guanyi', '管易'),
  manual:         () => actT('Manual', '手动'),
};
function actSourceName(src) { const f = ACT_SOURCE_NAME[src]; return f ? f() : (src || '—'); }

function actT(en, cn) { return window.cuT ? cuT(en, cn) : en; }
function actGzToday() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function actShiftDate(d, days) {
  const t = Date.parse(d + 'T00:00:00Z') + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
// Same-day view shows just the clock; multi-day ranges keep month-day.
function actFmtClock(ts) {
  const s = String(ts || '');
  return ACT.from === ACT.to ? s.slice(11, 16) : s.slice(5, 16);
}

// Quick range: 'today' | 'week' | 'month' → sets from/to ending on today.
function actSetRange(kind) {
  const today = actGzToday();
  ACT.to = today;
  ACT.from = kind === 'week' ? actShiftDate(today, -6)
           : kind === 'month' ? actShiftDate(today, -29)
           : today;
  const f = document.getElementById('act-from'), t = document.getElementById('act-to');
  if (f) f.value = ACT.from;
  if (t) t.value = ACT.to;
  actLoad(true);
}

async function actAdminInit() {
  if (!ACT.from) { ACT.from = actGzToday(); ACT.to = actGzToday(); }
  const f = document.getElementById('act-from'), t = document.getElementById('act-to');
  if (f && !f.value) f.value = ACT.from;
  if (t && !t.value) t.value = ACT.to;
  actLoad(true);
  actStartPolling();
}

function actReadFilters() {
  ACT.from   = document.getElementById('act-from')?.value || actGzToday();
  ACT.to     = document.getElementById('act-to')?.value || ACT.from;
  // Channel comes from the tab switcher (ACT.source), not a form field.
  ACT.q      = document.getElementById('act-search')?.value.trim() || '';
}

function actQueryString(extra) {
  const p = new URLSearchParams({ from: ACT.from, to: ACT.to });
  if (ACT.source) p.set('source', ACT.source);
  if (ACT.q) p.set('q', ACT.q);
  Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
  return p.toString();
}

// `silent` = a background auto-refresh: skip the "Loading…" placeholder so the
// table doesn't flash, and swallow transient errors (the next tick retries).
async function actLoad(reset, silent) {
  actReadFilters();
  if (reset) { ACT.offset = 0; ACT.rows = []; }
  ACT.loading = true;
  const body = document.getElementById('act-tbody');
  if (reset && body && !silent) body.innerHTML = `<tr><td colspan="7" class="act-empty">${actT('Loading…', '加载中…')}</td></tr>`;
  try {
    const j = await api('/api/retail-admin/activity?' + actQueryString({ limit: ACT.limit, offset: ACT.offset }));
    ACT.rows = reset ? j.rows : ACT.rows.concat(j.rows);
    ACT.total = j.total;
    actRenderTabs(j.summary);
    actRenderDigest(j.digest, j.summary);
    actRenderCaption(j.summary);
    actRenderRows();
  } catch (e) {
    if (!silent && body) body.innerHTML = `<tr><td colspan="7" class="act-empty" style="color:var(--td-brick-ink,#B4533E)">${escapeHtml(e.message)}</td></tr>`;
  } finally { ACT.loading = false; }
}

// ── Live auto-refresh ────────────────────────────────────────────────────────
// Stock moves constantly (orders, daemons, quick-stock). Poll the current view
// while the Stock activity sub-view is up on the active Orders tab, so the
// timeline stays live without a manual reload. Paused when the tab is
// backgrounded/hidden, while a load is in flight, or once the operator has
// paged past the first page (so an auto-refresh never yanks them back to the
// top mid-scroll).
let _actPollTimer = null;
function actTabVisible() {
  const va = document.getElementById('ord-view-activity');
  return !document.hidden && !!va && va.style.display !== 'none'
    && !!document.getElementById('tab-orders')?.classList.contains('active');
}
function actStartPolling() {
  if (_actPollTimer) return;
  _actPollTimer = setInterval(() => {
    if (ACT.loading || ACT.offset > 0 || !actTabVisible()) return;
    actLoad(true, true);  // silent first-page refresh
  }, 15000);
}

// Fixed channel order for the switcher tabs. 'All channels' first, then one
// tab per sales channel. The tabs are always shown so the row reads as a
// channel SELECTOR, not data-driven cards.
const ACT_TABS = [
  ['',               () => actT('All channels', '全部渠道')],
  ['miniapp',        () => actSourceName('miniapp')],
  ['gzgrocery',      () => 'Gzgrocery'],
  ['meituan_tianhe', () => actSourceName('meituan_tianhe')],
  ['meituan_yuexiu', () => actSourceName('meituan_yuexiu')],
  ['manual',         () => actSourceName('manual')],
];

// Quiet text tabs — active = ink underline; every tab shows its event count
// for the current date range (counts come from the server's unfiltered
// summary, so they stay put as you switch tabs).
function actRenderTabs(summary) {
  const el = document.getElementById('act-tabs');
  if (!el) return;
  const counts = {};
  (summary || []).forEach(s => { counts[s.source] = s.events; });
  // Grand total = sum across every channel (summary is channel-independent), so
  // the "All channels" count never moves when you switch tabs.
  const grand = (summary || []).reduce((a, s) => a + (s.events || 0), 0);
  const active = ACT.source || '';
  el.innerHTML = ACT_TABS.map(([src, label]) => {
    const n = src === '' ? grand : (counts[src] || 0);
    const cls = 'act-tab' + (active === src ? ' on' : '') + (!n && src !== '' ? ' quiet' : '');
    return `<button type="button" class="${cls}" onclick="actPickSource('${src}')">`
      + `<span>${escapeHtml(label())}</span><span class="act-tab-n">${n}</span></button>`;
  }).join('');
}

// Read-first digest cards: what hit zero, the biggest moves, the per-channel
// tally. Zero/big honour the active channel + search filter (server-side);
// the by-channel card is always the whole window, matching the tab counts.
function actRenderDigest(digest, summary) {
  const el = document.getElementById('act-digest');
  if (!el) return;
  const zeroed = (digest && digest.zeroed) || [];
  const big    = (digest && digest.big) || [];

  const zeroRows = zeroed.length
    ? zeroed.map(z =>
        `<div class="act-drow"><span class="act-dmain" title="${escapeHtml(z.product || z.sku || '')}">${escapeHtml(z.product || z.sku || '—')}</span>`
        + `<span class="act-dmeta num">${escapeHtml(actFmtClock(z.ts_local))}</span></div>`).join('')
    : `<div class="act-dempty">${actT('Nothing hit zero.', '没有商品售罄。')}</div>`;

  const bigRows = big.length
    ? big.map(b => {
        const who = b.source === 'manual' ? (b.actor_label || actSourceName('manual')) : actSourceName(b.source);
        const d = b.delta > 0 ? `<span class="act-in num">+${b.delta}</span>`
                              : `<span class="act-out num">−${Math.abs(b.delta)}</span>`;
        return `<div class="act-drow"><span class="act-dmain" title="${escapeHtml(b.product || b.sku || '')}">`
          + `${escapeHtml(b.product || b.sku || '—')} <span class="act-dmeta">· ${escapeHtml(who)}</span></span>${d}</div>`;
      }).join('')
    : `<div class="act-dempty">${actT('No unusual moves.', '没有异常变动。')}</div>`;

  // Channels in fixed tab order, plus any extra sources the summary reports
  // (e.g. guanyi) appended after — nothing the ledger saw goes unlisted.
  const known = ACT_TABS.map(([s]) => s).filter(Boolean);
  const extras = (summary || []).map(s => s.source).filter(s => s && !known.includes(s));
  const chRows = known.concat(extras).map(src => {
    const s = (summary || []).find(x => x.source === src);
    const meta = s && s.events
      ? `<span class="num">${s.events}</span>`
        + (s.units_out ? ` · <span class="num">−${s.units_out}</span>` : '')
        + (s.units_in  ? ` · <span class="act-in num">+${s.units_in}</span>` : '')
      : `<span class="act-quiet-txt">${actT('quiet', '无动静')}</span>`;
    return `<div class="act-drow"><span class="act-dmain">${escapeHtml(actSourceName(src))}</span>`
      + `<span class="act-dmeta">${meta}</span></div>`;
  }).join('');

  el.innerHTML =
      `<div class="act-dcard"><h3>${actT('Hit zero', '已售罄')}</h3>${zeroRows}</div>`
    + `<div class="act-dcard"><h3>${actT('Big moves', '大变动')}</h3>${bigRows}</div>`
    + `<div class="act-dcard act-dcard-calm"><h3>${actT('By channel', '分渠道')}</h3>${chRows}</div>`;
}

// One-line caption over the table describing the active view, so it's clear
// the ledger is scoped to the chosen channel and the export matches it.
function actRenderCaption(summary) {
  const el = document.getElementById('act-summary');
  if (!el) return;
  const active = ACT.source || '';
  const s = (summary || []).find(x => x.source === active);
  const name = active ? actSourceName(active) : actT('All channels', '全部渠道');
  const grand = (summary || []).reduce((a, x) => a + (x.events || 0), 0);
  const events = active ? (s ? s.events : 0) : grand;
  let out = 0, inn = 0;
  if (active) { out = s ? (s.units_out || 0) : 0; inn = s ? (s.units_in || 0) : 0; }
  else (summary || []).forEach(x => { out += x.units_out || 0; inn += x.units_in || 0; });
  el.innerHTML = `<b>${escapeHtml(name)}</b> · `
    + `<span class="num">${events}</span> ${actT('events', '条')} · `
    + `<span class="num">${out}</span> ${actT('out', '出')} · `
    + `<span class="num">${inn}</span> ${actT('in', '入')}`
    + ` — ${actT('export downloads this view', '导出即当前视图')}`;
}

// Switch the active channel (tab) and reload the view + export scope.
function actPickSource(src) {
  ACT.source = src || '';
  actLoad(true);
}

function actRenderRows() {
  const body = document.getElementById('act-tbody');
  if (!body) return;
  if (!ACT.rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="act-empty">${actT('Nothing moved in this range.', '此时间段内没有变动。')}</td></tr>`;
  } else {
    body.innerHTML = ACT.rows.map(r => {
      const delta = r.delta > 0 ? `<span class="act-in num">+${r.delta}</span>`
                                : `<span class="act-out num">−${Math.abs(r.delta)}</span>`;
      const bal = r.balance_after === 0 ? `<span class="act-zero num">0</span>`
                                        : `<span class="num">${r.balance_after}</span>`;
      const ctx = r.source === 'manual'
        ? [r.actor_label, r.note].filter(Boolean).join(' · ')
        : (r.note || '');
      return `<tr>`
        + `<td class="act-time num">${escapeHtml(actFmtClock(r.ts_local))}</td>`
        + `<td class="act-ch${r.source === 'manual' ? ' act-ch-manual' : ''}">${escapeHtml(actSourceName(r.source))}</td>`
        + `<td class="act-store">${escapeHtml(r.store || '—')}</td>`
        + `<td class="act-prod">${escapeHtml(r.product || '—')}${r.sku ? `<span class="act-sku">${escapeHtml(r.sku)}</span>` : ''}</td>`
        + `<td class="act-delta">${delta}</td>`
        + `<td class="act-bal">${bal}</td>`
        + `<td class="act-ctx" title="${escapeHtml(ctx)}">${escapeHtml(ctx)}</td>`
        + `</tr>`;
    }).join('');
  }
  const more = document.getElementById('act-more');
  if (more) more.style.display = ACT.rows.length < ACT.total ? '' : 'none';
}

function actLoadMore() { ACT.offset += ACT.limit; actLoad(false); }

function actExportCsv() {
  actReadFilters();
  window.location.href = '/api/retail-admin/activity/export.csv?' + actQueryString();
}
