/* eslint-disable no-undef, no-func-assign, no-self-assign */
// Inventory activity ledger viewer — full stock-movement history with date
// range + source filters + one-click CSV export (day / week / month).
// Reads /api/retail-admin/activity (over retail_stock_ledger). All times shown
// are Guangzhou local (UTC+8), matching the server's day boundaries.

const ACT = { from: null, to: null, source: '', q: '', offset: 0, limit: 200, rows: [], total: 0, loading: false };
const ACT_SOURCE_LABELS = {
  gzgrocery: 'gzgrocery', Meituan: 'Meituan · 美团', Guanyi: 'Guanyi · 管易',
  'Mini-app': 'Mini-app · 小程序', Manual: 'Manual · 手动',
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
}

function actReadFilters() {
  ACT.from   = document.getElementById('act-from')?.value || actGzToday();
  ACT.to     = document.getElementById('act-to')?.value || ACT.from;
  ACT.source = document.getElementById('act-source')?.value || '';
  ACT.q      = document.getElementById('act-search')?.value.trim() || '';
}

function actQueryString(extra) {
  const p = new URLSearchParams({ from: ACT.from, to: ACT.to });
  if (ACT.source) p.set('source', ACT.source);
  if (ACT.q) p.set('q', ACT.q);
  Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
  return p.toString();
}

async function actLoad(reset) {
  actReadFilters();
  if (reset) { ACT.offset = 0; ACT.rows = []; }
  ACT.loading = true;
  const body = document.getElementById('act-tbody');
  if (reset && body) body.innerHTML = `<tr><td colspan="7" class="muted" style="padding:18px;text-align:center">${actT('Loading…', '加载中…')}</td></tr>`;
  try {
    const j = await api('/api/retail-admin/activity?' + actQueryString({ limit: ACT.limit, offset: ACT.offset }));
    ACT.rows = reset ? j.rows : ACT.rows.concat(j.rows);
    ACT.total = j.total;
    actRenderSummary(j.summary, j.total);
    actRenderRows();
  } catch (e) {
    if (body) body.innerHTML = `<tr><td colspan="7" class="muted" style="padding:18px;text-align:center;color:var(--danger,#c0392b)">${escapeHtml(e.message)}</td></tr>`;
  } finally { ACT.loading = false; }
}

function actRenderSummary(summary, total) {
  const el = document.getElementById('act-summary');
  if (!el) return;
  if (!summary || !summary.length) { el.innerHTML = ''; return; }
  const chips = summary.map(s => {
    const label = ACT_SOURCE_LABELS[s.source] || s.source;
    return `<div class="fc-kpi"><div class="lbl">${escapeHtml(label)}</div>`
      + `<div class="val">${s.events}</div>`
      + `<div class="sub">▼${s.units_out || 0} · ▲${s.units_in || 0} ${actT('units', '件')}</div></div>`;
  }).join('');
  el.innerHTML = `<div class="fc-kpis">`
    + `<div class="fc-kpi accent"><div class="lbl">${actT('Total events', '总记录')}</div><div class="val">${total}</div><div class="sub">${escapeHtml(ACT.from)} → ${escapeHtml(ACT.to)}</div></div>`
    + chips + `</div>`;
}

function actSourceBadge(src) {
  const colors = { gzgrocery: '#2d8a4e', Meituan: '#f5a623', Guanyi: '#7b61ff', 'Mini-app': '#1f6feb', Manual: '#888' };
  const c = colors[src] || '#888';
  return `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;color:#fff;background:${c}">${escapeHtml(src)}</span>`;
}

function actRenderRows() {
  const body = document.getElementById('act-tbody');
  if (!body) return;
  if (!ACT.rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted" style="padding:18px;text-align:center">${actT('No activity in this range.', '此时间段内无记录。')}</td></tr>`;
  } else {
    body.innerHTML = ACT.rows.map(r => {
      const time = (r.ts_local || '').slice(0, 19).replace('T', ' ');
      const delta = r.delta > 0 ? `<span style="color:#2d8a4e">▲+${r.delta}</span>`
                  : `<span style="color:#c0392b">▼${r.delta}</span>`;
      return `<tr>`
        + `<td style="white-space:nowrap;font-variant-numeric:tabular-nums">${escapeHtml(time)}</td>`
        + `<td>${actSourceBadge(r.source)}</td>`
        + `<td style="font-family:monospace">${escapeHtml(r.sku || '—')}</td>`
        + `<td>${escapeHtml(r.product || '—')}</td>`
        + `<td style="text-align:right;font-variant-numeric:tabular-nums">${delta}</td>`
        + `<td style="text-align:right;font-variant-numeric:tabular-nums">${r.balance_after}</td>`
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
