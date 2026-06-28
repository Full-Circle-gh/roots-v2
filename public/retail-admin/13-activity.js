/* eslint-disable no-undef, no-func-assign, no-self-assign */
// Inventory activity ledger viewer — full stock-movement history with date
// range + source filters + one-click CSV export (day / week / month).
// Reads /api/retail-admin/activity (over retail_stock_ledger). All times shown
// are Guangzhou local (UTC+8), matching the server's day boundaries.

const ACT = { from: null, to: null, source: '', q: '', offset: 0, limit: 200, rows: [], total: 0, loading: false };
// Source tokens come from the server (reason-derived). Meituan is split per
// storefront — Tianhe (外卖) and Yuexiu (闪购). The front-end owns every label
// and colour so the page reads as one overall traffic view, not a per-channel
// page. ACT_SOURCE_LABELS = full chip label; ACT_SOURCE_SHORT = compact badge.
const ACT_SOURCE_LABELS = {
  miniapp: 'Mini-app · 小程序', gzgrocery: 'gzgrocery',
  meituan_tianhe: 'Meituan Tianhe · 美团天河', meituan_yuexiu: 'Meituan Yuexiu · 美团越秀',
  meituan: 'Meituan · 美团', guanyi: 'Guanyi · 管易', manual: 'Manual · 手动',
};
const ACT_SOURCE_SHORT = {
  miniapp: 'Mini-app', gzgrocery: 'gzgrocery', meituan_tianhe: 'Meituan · Tianhe',
  meituan_yuexiu: 'Meituan · Yuexiu', meituan: 'Meituan', guanyi: 'Guanyi', manual: 'Manual',
};
const ACT_SOURCE_COLORS = {
  miniapp: '#1f6feb', gzgrocery: '#2d8a4e', meituan_tianhe: '#f5a623',
  meituan_yuexiu: '#d97706', meituan: '#f5a623', guanyi: '#7b61ff', manual: '#888',
};

function actT(en, cn) { return window.cuT ? cuT(en, cn) : en; }
function actGzToday() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function actShiftDate(d, days) {
  const t = Date.parse(d + 'T00:00:00Z') + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
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
  if (reset && body && !silent) body.innerHTML = `<tr><td colspan="8" class="muted" style="padding:18px;text-align:center">${actT('Loading…', '加载中…')}</td></tr>`;
  try {
    const j = await api('/api/retail-admin/activity?' + actQueryString({ limit: ACT.limit, offset: ACT.offset }));
    ACT.rows = reset ? j.rows : ACT.rows.concat(j.rows);
    ACT.total = j.total;
    actRenderTabs(j.summary, j.total);
    actRenderCaption(j.summary, j.total);
    actRenderRows();
  } catch (e) {
    if (!silent && body) body.innerHTML = `<tr><td colspan="8" class="muted" style="padding:18px;text-align:center;color:var(--danger,#c0392b)">${escapeHtml(e.message)}</td></tr>`;
  } finally { ACT.loading = false; }
}

// ── Live auto-refresh ────────────────────────────────────────────────────────
// Stock moves constantly (orders, daemons, quick-stock). Poll the current view
// while the Activity tab is the active, visible tab so the timeline stays live
// without a manual reload. Paused when the tab is backgrounded/hidden, while a
// load is in flight, or once the operator has paged past the first page (so an
// auto-refresh never yanks them back to the top mid-scroll).
let _actPollTimer = null;
function actTabVisible() {
  return !document.hidden
    && !!document.getElementById('tab-activity')?.classList.contains('active');
}
function actStartPolling() {
  if (_actPollTimer) return;
  _actPollTimer = setInterval(() => {
    if (ACT.loading || ACT.offset > 0 || !actTabVisible()) return;
    actLoad(true, true);  // silent first-page refresh
  }, 15000);
}

// Fixed channel order for the switcher tabs. 'All channels' first, then one
// tab per sales channel. Labels follow the live language (actT). The tabs are
// always shown so the bar reads as a channel SELECTOR, not data-driven cards.
const ACT_TABS = [
  ['',               () => actT('All channels', '全部渠道')],
  ['miniapp',        () => actT('Mini-app', '小程序')],
  ['gzgrocery',      () => 'gzgrocery'],
  ['meituan_tianhe', () => actT('Meituan Tianhe', '美团天河')],
  ['meituan_yuexiu', () => actT('Meituan Yuexiu', '美团越秀')],
  ['manual',         () => actT('Manual', '手动')],
];

// Segmented channel switcher. The active tab is filled brass; every tab shows
// its event count for the current date range (counts come from the server's
// unfiltered summary, so they stay put as you switch tabs).
function actRenderTabs(summary, total) {
  const el = document.getElementById('act-tabs');
  if (!el) return;
  const counts = {};
  (summary || []).forEach(s => { counts[s.source] = s.events; });
  // Grand total = sum across every channel (summary is channel-independent), so
  // the "All channels" count never moves when you switch tabs.
  const grand = (summary || []).reduce((a, s) => a + (s.events || 0), 0);
  const active = ACT.source || '';
  el.innerHTML = ACT_TABS.map(([src, label]) => {
    const on  = active === src;
    const n   = src === '' ? grand : (counts[src] || 0);
    const dot = ACT_SOURCE_COLORS[src]
      ? `<span style="width:8px;height:8px;border-radius:50%;background:${ACT_SOURCE_COLORS[src]};display:inline-block"></span>` : '';
    const base = 'padding:7px 12px;border-radius:8px;font-size:13px;cursor:pointer;display:inline-flex;'
      + 'align-items:center;gap:7px;white-space:nowrap;line-height:1';
    const style = on
      ? `${base};background:var(--brass,#b08d57);color:#fff;border:1px solid var(--brass,#b08d57)`
      : `${base};background:var(--bg-elev-1,#fff);color:var(--ink,#333);border:1px solid var(--border,#e0ddd5)`;
    return `<button type="button" onclick="actPickSource('${src}')" style="${style}">`
      + `${dot}<span>${escapeHtml(label())}</span>`
      + `<span style="opacity:.65;font-variant-numeric:tabular-nums">${n}</span></button>`;
  }).join('');
}

// One-line caption under the toolbar describing the active view, so it's clear
// the page is scoped to the chosen channel and the export matches it.
function actRenderCaption(summary, total) {
  const el = document.getElementById('act-summary');
  if (!el) return;
  const active = ACT.source || '';
  const s = (summary || []).find(x => x.source === active);
  const name = active ? (ACT_SOURCE_LABELS[active] || active) : actT('All channels', '全部渠道');
  const grand = (summary || []).reduce((a, x) => a + (x.events || 0), 0);
  const events = active ? (s ? s.events : 0) : grand;
  let out = 0, inn = 0;
  if (active) { out = s ? (s.units_out || 0) : 0; inn = s ? (s.units_in || 0) : 0; }
  else (summary || []).forEach(x => { out += x.units_out || 0; inn += x.units_in || 0; });
  el.innerHTML = `<div class="muted" style="font-size:13px">`
    + `<strong style="color:var(--ink,#333)">${escapeHtml(name)}</strong> · `
    + `${events} ${actT('events', '条记录')} · ▼${out} · ▲${inn} ${actT('units', '件')} · `
    + `${escapeHtml(ACT.from)} → ${escapeHtml(ACT.to)}`
    + ` <span style="opacity:.7">— ${actT('Export CSV downloads this channel', '导出 CSV 仅含该渠道')}</span></div>`;
}

// Switch the active channel (tab) and reload the view + export scope.
function actPickSource(src) {
  ACT.source = src || '';
  actLoad(true);
}

function actSourceBadge(src) {
  const c = ACT_SOURCE_COLORS[src] || '#888';
  const label = ACT_SOURCE_SHORT[src] || src;
  return `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;color:#fff;background:${c};white-space:nowrap">${escapeHtml(label)}</span>`;
}

function actRenderRows() {
  const body = document.getElementById('act-tbody');
  if (!body) return;
  if (!ACT.rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted" style="padding:18px;text-align:center">${actT('No activity in this range.', '此时间段内无记录。')}</td></tr>`;
  } else {
    body.innerHTML = ACT.rows.map(r => {
      const time = (r.ts_local || '').slice(0, 19).replace('T', ' ');
      const delta = r.delta > 0 ? `<span style="color:#2d8a4e">▲+${r.delta}</span>`
                  : `<span style="color:#c0392b">▼${r.delta}</span>`;
      return `<tr>`
        + `<td style="white-space:nowrap;font-variant-numeric:tabular-nums">${escapeHtml(time)}</td>`
        + `<td>${actSourceBadge(r.source)}</td>`
        + `<td style="white-space:nowrap">${escapeHtml(r.store || '—')}</td>`
        + `<td style="font-family:monospace">${escapeHtml(r.sku || '—')}</td>`
        + `<td>${escapeHtml(r.product || '—')}</td>`
        + `<td style="text-align:right;font-variant-numeric:tabular-nums">${delta}</td>`
        + `<td style="text-align:right;font-variant-numeric:tabular-nums">${r.balance_after}</td>`
        + `<td class="muted" style="font-size:12px">${escapeHtml(r.source === 'manual' ? (r.actor_label || '—') : '')}</td>`
        + `<td class="muted" style="font-size:12px">${escapeHtml(r.note || '')}</td>`
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
