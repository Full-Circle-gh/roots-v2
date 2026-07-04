/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 06/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: China regions/districts, delivery zones (dz*), apply-to-zones panel, mobile delivery hub (rmDlv*) */
// ════════════════════════════════════════════════════════════════
// DELIVERY ZONES
// ════════════════════════════════════════════════════════════════
// Bilingual region catalogue — fetched once and reused for the GZ-district
// <select> and the city <datalist>. Keyed by name_cn so onpick lookups are
// trivial; the datalist labels are "深圳市 · Shenzhen" and the parser is
// tolerant of users typing just the CN or EN half.
let _regions = { gz: [], cities: [], byCn: new Map(), byEn: new Map() };
async function loadChinaRegions() {
  if (_regions.cities.length) return _regions;
  try {
    const r = await api('/api/retail-admin/china-regions');
    const d = r?.data || {};
    _regions.gz = d.guangzhou_districts || [];
    _regions.cities = d.cities || [];
    for (const c of _regions.cities) {
      _regions.byCn.set(c.name_cn, c);
      _regions.byEn.set((c.name_en || '').toLowerCase(), c);
    }
    // City <datalist> stays as autocomplete for the chip-input field
    // (Other-city mode). GZ chips render later from _regions.gz.
    const dl = $('#china-cities-datalist');
    if (dl) {
      dl.innerHTML = _regions.cities.map(c => {
        const label = `${c.name_cn} · ${c.name_en}`;
        const hint  = c.province_cn ? `${c.province_cn} / ${c.province_en}` : '';
        return `<option value="${escapeAttr(label)}">${escapeHtml(hint)}</option>`;
      }).join('');
    }
  } catch (e) { console.error('[loadChinaRegions]', e); }
  return _regions;
}

// ── Multi-select chip pickers ───────────────────────────────────────
// State for the Add-zone form: a Set of selected GZ-district name_cn
// keys (since names are unique) and an array of city picks (each with
// name_cn + name_en + an unmatched-raw flag for hand-typed entries).
let _pickedDistricts = new Set();
let _pickedCities    = [];   // [{name_cn, name_en}]

function renderDistrictChips() {
  const wrap = $('#dz-gz-chips');
  if (!wrap) return;
  if (!_regions.gz.length) { wrap.innerHTML = '<div class="muted" style="font-size: 11px;">Loading districts… · 加载区/县…</div>'; return; }
  // Districts already saved as zones — disable them so the user can't
  // create duplicates. Edit existing rows from the list instead.
  const taken = new Set(_zones.filter(z => z.zone_type === 'gz_district').map(z => z.match_district));
  wrap.innerHTML = _regions.gz.map(g => {
    const isTaken = taken.has(g.name_cn);
    const isOn    = _pickedDistricts.has(g.name_cn);
    const cls = ['dz-chip', isTaken ? 'taken' : '', isOn ? 'on' : ''].filter(Boolean).join(' ');
    const click = isTaken ? '' : `onclick="toggleDistrictChip('${escapeAttr(g.name_cn)}')"`;
    return `<button type="button" class="${cls}" ${click} title="${escapeAttr(g.name_en)}">${escapeHtml(g.name_cn)} · ${escapeHtml(g.name_en)}</button>`;
  }).join('');
}

function toggleDistrictChip(nameCn) {
  if (_pickedDistricts.has(nameCn)) _pickedDistricts.delete(nameCn);
  else _pickedDistricts.add(nameCn);
  renderDistrictChips();
  updateMultiCount();
}

function renderCityChips() {
  const wrap = $('#dz-city-chips');
  if (!wrap) return;
  if (!_pickedCities.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = _pickedCities.map((c, i) => `
    <span class="dz-chip on" title="${escapeAttr(c.name_en || '')}">
      ${escapeHtml(c.name_cn)}${c.name_en ? ' · ' + escapeHtml(c.name_en) : ''}
      <span class="dz-chip-x" onclick="removeCityChip(${i})" title="Remove · 移除">×</span>
    </span>
  `).join('');
}

// Parse one entry from the city input — accept "上海", "Shanghai",
// or the datalist label "上海市 · Shanghai". Match against known
// cities by CN or EN; fall back to using the raw text as-is so the
// admin can still hand-type unusual entries.
function parseCityEntry(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  if (raw.includes(' · ')) raw = raw.split(' · ')[0].trim();
  const city = _regions.byCn.get(raw) || _regions.byEn.get(raw.toLowerCase());
  if (city) return { name_cn: city.name_cn, name_en: city.name_en || '' };
  return { name_cn: raw, name_en: '' };  // hand-typed
}

function addCityChip(raw) {
  const entry = parseCityEntry(raw);
  if (!entry) return false;
  // Drop duplicates (same chip already in list, or a saved zone exists)
  const existing = new Set(_zones.filter(z => z.zone_type === 'city').map(z => z.match_city));
  if (_pickedCities.some(c => c.name_cn === entry.name_cn)) return false;
  if (existing.has(entry.name_cn)) { toast(`${entry.name_cn} already has a zone · 已存在`, 'err'); return false; }
  _pickedCities.push(entry);
  renderCityChips();
  updateMultiCount();
  return true;
}

function removeCityChip(idx) {
  _pickedCities.splice(idx, 1);
  renderCityChips();
  updateMultiCount();
}

function onCityChipKey(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const inp = e.target;
    if (addCityChip(inp.value)) inp.value = '';
  } else if (e.key === 'Backspace' && !e.target.value && _pickedCities.length) {
    // Empty-input Backspace pops the last chip — standard tag-input UX
    removeCityChip(_pickedCities.length - 1);
  }
}

// Datalist click fires `change` — commit + clear the input.
function onCityChipCommit() {
  const inp = $('#dz-city-input');
  if (!inp) return;
  if (addCityChip(inp.value)) inp.value = '';
}

function updateMultiCount() {
  const el = $('#dz-multi-count');
  if (!el) return;
  // Edit mode (single zone) — no multi count, no count text either.
  if (_zoneEditId) { el.style.display = 'none'; return; }
  const n = _zoneEditType === 'gz_district' ? _pickedDistricts.size : _pickedCities.length;
  if (!n) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `<b>${n}</b> selected · 已选 <b>${n}</b> · Save will create ${n === 1 ? 'one zone' : `${n} zones`} with the settings below. · 保存将以下方设置创建 ${n} 个配送区。`;
}

let _zones = [];
let _zoneView = 'pricing';
let _zoneEditId = null;
let _zoneEditType = 'gz_district';

async function loadDeliveryZones() {
  await loadChinaRegions();
  try {
    const cfg = await api('/api/retail-admin/config');
    const dlv = cfg?.data?.delivery || {};
    // Stash the delivery config so the new-tenant coverage render can read the
    // wizard's own keys (enabled/coverage/pricingMode/speed) — these live under
    // delivery.* alongside the legacy holiday/batch settings.
    window._deliveryCfg = dlv;
    if ($('#dlv-kitchen-address')) $('#dlv-kitchen-address').value = dlv.kitchenAddress ?? '';
    const hMode = !!dlv.holidayMode;
    const hMsg = dlv.holidayMessage || {};
    if ($('#dlv-holiday-mode')) {
      $('#dlv-holiday-mode').checked = hMode;
      const lbl = $('#dlv-holiday-status-label');
      if (lbl) lbl.textContent = hMode ? 'ON · 开启' : 'OFF · 关闭';
    }
    if ($('#dlv-holiday-msg-en')) $('#dlv-holiday-msg-en').value = hMsg.en || '';
    if ($('#dlv-holiday-msg-cn')) $('#dlv-holiday-msg-cn').value = hMsg.cn || '';
    const cb = $('#dlv-holiday-mode');
    if (cb && !cb._wired) {
      cb._wired = true;
      cb.addEventListener('change', () => {
        const lbl = $('#dlv-holiday-status-label');
        if (lbl) lbl.textContent = cb.checked ? 'ON · 开启' : 'OFF · 关闭';
      });
    }
    // Bulk attach tracking — opt-in Orders toolbar button (delivery.bulkTracking).
    if ($('#dlv-bulk-trk')) {
      const on = !!dlv.bulkTracking;
      $('#dlv-bulk-trk').checked = on;
      const blbl = $('#dlv-bulk-trk-status-label');
      if (blbl) blbl.textContent = on ? 'ON · 开启' : 'OFF · 关闭';
    }
    const btcb = $('#dlv-bulk-trk');
    if (btcb && !btcb._wired) {
      btcb._wired = true;
      btcb.addEventListener('change', () => {
        const blbl = $('#dlv-bulk-trk-status-label');
        if (blbl) blbl.textContent = btcb.checked ? 'ON · 开启' : 'OFF · 关闭';
      });
    }
    // Fresh batch schedule
    const batch = (cfg?.data && cfg.data.batch && cfg.data.batch.schedule) || {};
    if ($('#batch-enabled')) {
      const on = !!batch.enabled;
      $('#batch-enabled').checked = on;
      const blbl = $('#batch-status-label');
      if (blbl) blbl.textContent = on ? 'ON · 开启' : 'OFF · 关闭';
    }
    if ($('#batch-anchor'))   $('#batch-anchor').value   = batch.anchor_date || '';
    if ($('#batch-interval')) $('#batch-interval').value = batch.interval_days || 2;
    if ($('#batch-skip'))     $('#batch-skip').value     = (Array.isArray(batch.skip_dates) ? batch.skip_dates : []).join('\n');
    if ($('#batch-kicker-en')) $('#batch-kicker-en').value = batch.kicker_en || '';
    if ($('#batch-kicker-cn')) $('#batch-kicker-cn').value = batch.kicker_cn || '';
    if ($('#batch-title-en'))  $('#batch-title-en').value  = batch.title_en || '';
    if ($('#batch-title-cn'))  $('#batch-title-cn').value  = batch.title_cn || '';
    if ($('#batch-msg-en'))   $('#batch-msg-en').value   = batch.message_en || '';
    if ($('#batch-msg-cn'))   $('#batch-msg-cn').value   = batch.message_cn || '';
    if ($('#batch-tip-en'))   $('#batch-tip-en').value   = batch.tip_en || '';
    if ($('#batch-tip-cn'))   $('#batch-tip-cn').value   = batch.tip_cn || '';
    const bcb = $('#batch-enabled');
    if (bcb && !bcb._wired) {
      bcb._wired = true;
      bcb.addEventListener('change', () => {
        const blbl = $('#batch-status-label');
        if (blbl) blbl.textContent = bcb.checked ? 'ON · 开启' : 'OFF · 关闭';
      });
    }
    // Fresh-order reschedule cutoff hour (evening-before lock for batch-made orders)
    const fresh = (cfg?.data && cfg.data.fresh) || {};
    if ($('#fresh-resched-cutoff')) {
      $('#fresh-resched-cutoff').value = (fresh.rescheduleCutoffHour != null ? fresh.rescheduleCutoffHour : 20);
    }
    // Default zone — rest of China
    const dz = dlv.defaultZone || {};
    if ($('#dlv-default-enabled')) {
      const on = !!dz.enabled;
      $('#dlv-default-enabled').checked = on;
      const dlbl = $('#dlv-default-status-label');
      if (dlbl) dlbl.textContent = on ? 'ON · 开启' : 'OFF · 关闭';
    }
    if ($('#dlv-default-fee'))      $('#dlv-default-fee').value      = dz.base_fee != null ? dz.base_fee : 25;
    if ($('#dlv-default-free'))     $('#dlv-default-free').value     = dz.free_threshold != null ? dz.free_threshold : '';
    if ($('#dlv-default-pack'))     $('#dlv-default-pack').value     = dz.packing_fee_per_item != null ? dz.packing_fee_per_item : 0;
    if ($('#dlv-default-pack-cap')) $('#dlv-default-pack-cap').value = dz.packing_fee_cap != null ? dz.packing_fee_cap : '';
    if ($('#dlv-default-lead'))     $('#dlv-default-lead').value     = dz.min_lead_days != null ? dz.min_lead_days : 3;
    const dcb = $('#dlv-default-enabled');
    if (dcb && !dcb._wired) {
      dcb._wired = true;
      dcb.addEventListener('change', () => {
        const dlbl = $('#dlv-default-status-label');
        if (dlbl) dlbl.textContent = dcb.checked ? 'ON · 开启' : 'OFF · 关闭';
      });
    }
  } catch {}

  const r = await api('/api/retail-admin/delivery-zones');
  _zones = r?.data || [];
  renderZoneTable();
  dzRenderKpis(true);
  if (typeof rmDlvRenderHub === 'function') rmDlvRenderHub();
}

async function saveHolidayMode() {
  const body = {
    'delivery.holidayMode':    !!$('#dlv-holiday-mode').checked,
    'delivery.holidayMessage': {
      en: ($('#dlv-holiday-msg-en').value || '').trim(),
      cn: ($('#dlv-holiday-msg-cn').value || '').trim(),
    },
  };
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    toast('Saved · 已保存');
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
}

// Bulk attach tracking — persist the on/off flag and flip the Orders toolbar
// button live via the same body class loadConfig() sets on boot.
async function saveBulkTrackingSetting() {
  const on = !!$('#dlv-bulk-trk').checked;
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'delivery.bulkTracking': on } });
    document.body.classList.toggle('ord-bulk-tracking', on);
    toast('Saved · 已保存');
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
}

async function saveBatchSchedule() {
  const anchor = ($('#batch-anchor').value || '').trim();
  const enabled = !!$('#batch-enabled').checked;
  if (enabled && !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    toast('Pick a batch day first · 请先选择一个制作日', 'err'); return;
  }
  const interval = Math.max(1, parseInt($('#batch-interval').value, 10) || 2);
  const skip = ($('#batch-skip').value || '')
    .split(/[\s,]+/).map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
  const val = (sel) => (($(sel) && $(sel).value) || '').trim();
  const body = {
    'batch.schedule': {
      enabled, anchor_date: anchor, interval_days: interval, skip_dates: skip,
      kicker_en: val('#batch-kicker-en'),
      kicker_cn: val('#batch-kicker-cn'),
      title_en:  val('#batch-title-en'),
      title_cn:  val('#batch-title-cn'),
      message_en: val('#batch-msg-en'),
      message_cn: val('#batch-msg-cn'),
      tip_en: val('#batch-tip-en'),
      tip_cn: val('#batch-tip-cn'),
    },
  };
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    toast('Saved · 已保存');
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
}

async function saveRescheduleSettings() {
  const h = parseInt(($('#fresh-resched-cutoff') && $('#fresh-resched-cutoff').value) || '', 10);
  if (!Number.isFinite(h) || h < 0 || h > 23) {
    toast('Enter an hour 0–23 · 请输入 0–23 的小时', 'err'); return;
  }
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'fresh.rescheduleCutoffHour': h } });
    toast('Saved · 已保存');
  } catch (e) { toast('Save failed · 保存失败: ' + e.message, 'err'); }
}

async function saveDefaultZone() {
  const num = (sel, fb) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : fb; };
  const numOrNull = (sel) => { const raw = ($(sel).value || '').trim(); if (raw === '') return null; const v = parseFloat(raw); return Number.isFinite(v) ? v : null; };
  const body = {
    'delivery.defaultZone': {
      enabled: !!$('#dlv-default-enabled').checked,
      base_fee: num('#dlv-default-fee', 25),
      free_threshold: numOrNull('#dlv-default-free'),
      packing_fee_per_item: num('#dlv-default-pack', 0),
      packing_fee_cap: numOrNull('#dlv-default-pack-cap'),
      min_lead_days: Math.max(0, parseInt($('#dlv-default-lead').value, 10) || 0),
      day_only: 1,
    },
  };
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    toast('Saved · 已保存');
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
}

function setZoneView(view) {
  _zoneView = view;
  $$('.dz-subtab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderZoneTable();
}

// ── Delivery Zones · per-operator View tweaks — row density + zone-badge style.
const DZ_VIEW_DEFAULTS = { density: 'comfortable', badge: 'pill' };
function dzvLoad() {
  try { return { ...DZ_VIEW_DEFAULTS, ...(JSON.parse(localStorage.getItem('retail-admin-dz-view') || '{}')) }; }
  catch (e) { return { ...DZ_VIEW_DEFAULTS }; }
}
let DZ_VIEW = dzvLoad();
function dzvApply() {
  const tbl = document.getElementById('dz-table'); if (!tbl) return;
  tbl.classList.remove('dz-compact', 'dzb-pill', 'dzb-square', 'dzb-underline');
  if (DZ_VIEW.density === 'compact') tbl.classList.add('dz-compact');
  tbl.classList.add('dzb-' + DZ_VIEW.badge);
  dzvSyncPanel();
}
function dzvSet(key, val) {
  DZ_VIEW[key] = val;
  try { localStorage.setItem('retail-admin-dz-view', JSON.stringify(DZ_VIEW)); } catch (e) {}
  dzvApply();
}
function dzvSyncPanel() {
  const pop = document.getElementById('dzv-pop'); if (!pop) return;
  pop.querySelectorAll('.ovp-seg').forEach(seg => {
    const key = seg.getAttribute('data-dzv');
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.getAttribute('data-v') === DZ_VIEW[key]));
  });
}
function dzvToggle() { const p = document.getElementById('dzv-pop'); if (!p) return; if (p.hidden) { p.hidden = false; dzvSyncPanel(); setTimeout(() => document.addEventListener('mousedown', dzvOutside), 0); } else dzvClose(); }
function dzvClose() { const p = document.getElementById('dzv-pop'); if (p) p.hidden = true; document.removeEventListener('mousedown', dzvOutside); }
function dzvOutside(e) { if (!(e.target.closest && e.target.closest('.ovp-wrap'))) dzvClose(); }

// Group zones under their province so the table reads as a hierarchy instead
// of a flat mixed list (whole-province rows next to single cities). Guangdong
// (the live area) floats to the top, "Other" sinks to the bottom, the rest are
// alphabetical by English province name. Order within a group is preserved.
function groupZonesByProvince(rows) {
  const map = new Map();
  const order = [];
  for (const z of rows) {
    const key = z.province_cn || 'Other';
    if (!map.has(key)) { map.set(key, { cn: z.province_cn || '其他', en: z.province_en || 'Other', rows: [] }); order.push(key); }
    map.get(key).rows.push(z);
  }
  const groups = order.map(k => map.get(k));
  // Guangzhou (live same-day area) first, then Guangdong, then the rest A→Z by
  // English name, with "Other" pinned last.
  const rank = g => (g.cn === '广州市' ? 0 : g.cn === '广东省' ? 1 : g.cn === '其他' ? 3 : 2);
  groups.sort((a, b) => (rank(a) - rank(b)) || (a.en || '').localeCompare(b.en || ''));
  return groups;
}
function zoneGroupHeaderHtml(g, colspan) {
  const en = escapeHtml(g.en || g.cn);
  const cn = escapeHtml(g.cn);
  return `<tr class="dz-group-row"><td colspan="${colspan}">
    <span class="dz-group-name" data-lang-block="en">${en}</span><span class="dz-group-name" data-lang-block="cn">${cn}</span>
    <span class="dz-group-count">${g.rows.length}</span>
  </td></tr>`;
}
function groupedZoneBodyHtml(rows, colspan, rowFn) {
  return groupZonesByProvince(rows)
    .map(g => zoneGroupHeaderHtml(g, colspan) + g.rows.map(rowFn).join(''))
    .join('');
}

// Coverage KPIs — computed in-browser from the in-memory _zones list (no extra
// fetch), mirroring the Products strip. animate=true (fresh load) rolls the
// count-up; plain set on search / sub-tab / toggle re-renders so the numbers
// don't re-animate on every keystroke.
let _DZ_KPI_LANG_HOOKED = false;
function dzRenderKpis(animate) {
  if (!document.getElementById('dz-kpis')) return;
  if (!_DZ_KPI_LANG_HOOKED && window.onLangChange) { _DZ_KPI_LANG_HOOKED = true; onLangChange(function () { dzRenderKpis(false); }); }
  const rows = Array.isArray(_zones) ? _zones : [];
  const total = rows.length;
  const active = rows.filter(z => z.is_active);
  const off = total - active.length;
  const provs = new Set(active.map(z => z.province_cn || z.province_en || '').filter(Boolean));
  const sameday = active.filter(z => z.zone_type === 'gz_district' && (z.same_day_allowed || Number(z.same_day_surcharge) > 0)).length;
  const set = (id, n) => { const el = document.getElementById(id); if (!el) return; if (animate) dashCountUp(el, n); else el.textContent = fcNum(n); };
  set('dz-kpi-active', active.length);
  set('dz-kpi-prov', provs.size);
  set('dz-kpi-sameday', sameday);
  set('dz-kpi-off', off);
  const aSub = document.getElementById('dz-kpi-active-sub');
  if (aSub) aSub.textContent = cuT('of ' + total + ' total', '共 ' + total + ' 个');
  const oSub = document.getElementById('dz-kpi-off-sub');
  if (oSub) oSub.textContent = off > 0 ? cuT("won't match addresses", '地址将无法匹配') : cuT('all live', '全部启用');
  const oTile = document.getElementById('dz-kpi-off-tile');
  if (oTile) oTile.classList.toggle('alert', off > 0);
  // Keep the mobile hub's zone count + any open zone list in sync with the
  // same signal the desktop KPI strip uses (load, is_active toggle, add/del).
  if (typeof rmDlvRenderHub === 'function') rmDlvRenderHub();
  if (typeof rmDlvRenderZones === 'function' && document.getElementById('rm-dlv-zones')?.classList.contains('open')) rmDlvRenderZones();
  // …and the desktop hub cards (zones status + setup strip) off the same signal.
  if (typeof dlvHubRender === 'function') dlvHubRender();
}

function renderZoneTable() {
  const head = $('#dz-thead');
  const body = $('#dz-tbody');
  dzvApply();
  const q = ($('#dz-search')?.value || '').trim().toLowerCase();
  const rows = _zones.filter(z => {
    if (!q) return true;
    const hay = [z.name_cn, z.name_en, z.match_district, z.match_city].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  if (_zoneView === 'pricing') {
    head.innerHTML = `<tr>
      <th>Zone · 配送区 <span class="help-i" data-tip="The delivery area. GZ chip = a Guangzhou district (e.g. 天河区). CITY = anywhere else (e.g. 深圳). · 配送区域。GZ = 广州市辖区;CITY = 其他城市。">?</span></th>
      <th class="numeric">Base ¥ <span class="help-i" data-tip="Default delivery fee for this zone — charged on every order unless the cart hits the free-over threshold. · 此区默认运费;若达免运门槛则免收。">?</span></th>
      <th class="numeric">Free over ¥ <span class="help-i" data-tip="Cart subtotal that unlocks free delivery in this zone. Leave blank to use the global default. · 达此金额免运;留空使用全局默认值。">?</span></th>
      <th>Extras · 额外 <span class="help-i" data-tip="Zone add-ons: GZ districts may set MAX (any-distance flat). Cities may set packing fee per item + cap. · 配送区附加:广州区可设 MAX 封顶价;外地城市可设按件包装费及上限。">?</span></th>
      <th style="text-align: center;">On · 启用 <span class="help-i" data-tip="Off = this zone won't match any address; affected customers see 'we don't deliver here' at checkout. · 关闭后此区不参与匹配,相关顾客结账时会看到「暂不配送」提示。">?</span></th>
      <th></th>
    </tr>`;
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" class="muted">${q ? 'No matches. · 无匹配结果' : 'No zones yet — click + Add zone above. · 暂无配送区,请点上方「+ 添加配送区」'}</td></tr>`;
      return;
    }
    body.innerHTML = groupedZoneBodyHtml(rows, 6, z => `
      <tr class="dz-row" onclick="openZoneDrawer(${z.id})">
        <td>${zoneCellHtml(z)}</td>
        <td class="numeric">${zonePriceCellHtml(z)}</td>
        <td class="numeric">${z.free_threshold == null ? '<span class="muted">default · 默认</span>' : '¥'+z.free_threshold}</td>
        <td>${zoneExtrasHtml(z)}</td>
        <td style="text-align: center;" onclick="event.stopPropagation()">
          <input type="checkbox" ${z.is_active?'checked':''} onchange="updateZone(${z.id},'is_active', this.checked ? 1 : 0)">
        </td>
        <td class="dz-rowact" onclick="event.stopPropagation()">
          <button class="btn dz-rowact-btn" title="Duplicate · 复制配送区" onclick="duplicateZone(${z.id})" aria-label="Duplicate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="btn dz-rowact-btn dz-rowact-del" title="Delete · 删除" onclick="deleteZone(${z.id}, '${zoneLabel(z).replace(/'/g,'')}')">×</button>
        </td>
      </tr>`);
  } else {
    head.innerHTML = `<tr>
      <th>Zone · 配送区 <span class="help-i" data-tip="The delivery area. GZ chip = a Guangzhou district (e.g. 天河区). CITY = anywhere else (e.g. 深圳). · 配送区域。GZ = 广州市辖区;CITY = 其他城市。">?</span></th>
      <th>Mode · 模式 <span class="help-i" data-tip="Time-slot = customer picks a 2-hour window today (1pm–3pm, etc.). Day-only = customer just picks a date — Express / Today / Schedule (Panyu-style). · 按时段 = 顾客选 2 小时窗口;仅按日 = 顾客只选日期(番禺模式:加急/今日/稍后)。">?</span></th>
      <th>Lead → Max · 提前 → 最远 <span class="help-i" data-tip="Earliest day the customer can schedule for, and the furthest day the calendar offers. 0d → 14d = today through 2 weeks ahead. · 顾客可预约的最早 → 最远天数。0d→14d 表示今天起最多两周。">?</span></th>
      <th>Same-day · 同日 <span class="help-i" data-tip="Whether today's delivery is allowed in this zone, plus any surcharge. '+¥10' = ¥10 extra for picking today; 'free' = no surcharge; '✗' = same-day blocked. · 是否允许同日及加价。+¥10 = 选今日加 ¥10;free = 不加价;✗ = 禁止同日。">?</span></th>
      <th>Hours · 时间 <span class="help-i" data-tip="Kitchen open–close hours (24-hour clock) used to build today's time slots. 10–20 = first slot starts 10am, last slot ends 8pm. · 厨房开放时间(24 时制),用于生成今日时段。10–20 = 早 10 至晚 8。">?</span></th>
      <th class="numeric">Slot · 时段 <span class="help-i" data-tip="Length of each time-slot chip in minutes. 120 = 2-hour windows (1–3pm, 3–5pm…). Ignored in Day-only mode. · 每段长度(分钟)。120 = 2 小时窗口;仅按日模式下忽略。">?</span></th>
      <th></th>
    </tr>`;
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="muted">${q ? 'No matches. · 无匹配结果' : 'No zones yet. · 暂无配送区'}</td></tr>`;
      return;
    }
    body.innerHTML = groupedZoneBodyHtml(rows, 7, z => `
      <tr class="dz-row" onclick="openZoneDrawer(${z.id})">
        <td>${zoneCellHtml(z)}</td>
        <td>${z.day_only ? 'Day-only · 仅按日' : 'Time-slot · 按时段'}</td>
        <td>${(z.min_lead_days ?? 0)}d → ${(z.max_lead_days ?? 14)}d</td>
        <td>${sameDayCellHtml(z)}</td>
        <td>${(z.slot_start_hour ?? '—')}–${(z.slot_end_hour ?? '—')}</td>
        <td class="numeric">${z.slot_duration_minutes ? z.slot_duration_minutes+'m' : '—'}</td>
        <td class="dz-rowact" onclick="event.stopPropagation()">
          <button class="btn dz-rowact-btn" title="Duplicate · 复制配送区" onclick="duplicateZone(${z.id})" aria-label="Duplicate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="btn dz-rowact-btn dz-rowact-del" title="Delete · 删除" onclick="deleteZone(${z.id}, '${zoneLabel(z).replace(/'/g,'')}')">×</button>
        </td>
      </tr>`);
  }
}

function zoneLabel(z) {
  return z.name_cn || z.match_district || z.match_city || '';
}

// EN/CN-aware label span: the active-language one shows, the other is hidden
// by the global html[data-ui-lang] CSS — so chips read all-English in the EN
// view and all-Chinese in the CN view.
function dzLangSpan(en, cn) {
  return `<span data-lang-block="en">${en}</span><span data-lang-block="cn">${cn}</span>`;
}
function zoneCellHtml(z) {
  const isGz = z.zone_type === 'gz_district';
  let cls, label;
  if (isGz) { cls = 'gz'; label = 'GZ'; }
  else if (z.is_province_wide) {
    cls = 'prov';
    label = /(省|自治区)$/.test(z.match_city || '')
      ? dzLangSpan('Province', '全省')
      : dzLangSpan('City-wide', '全市');
  } else { cls = 'city'; label = dzLangSpan('City', '城市'); }
  const chip = `<span class="dz-type-chip ${cls}">${label}</span>`;
  const cn = escapeHtml(zoneLabel(z) || '—');
  const en = escapeHtml(z.name_en || '');
  return `<div class="dz-zone-cell">${chip}<div class="dz-zone-text"><span>${cn}</span>${en ? `<span class="sub">${en}</span>` : ''}</div></div>`;
}

// Does this zone price by weight? Needs the first-kg fee set (extra can be 0).
function zoneIsWeightPriced(z) {
  return z && z.weight_first_kg_fee != null && z.weight_first_kg_fee !== '';
}
// The Base-fee cell text: a flat ¥ normally, or the courier rate when the zone
// prices by weight (e.g. "¥10 +¥3/kg"). base_fee stays the no-weight fallback.
function zonePriceCellHtml(z) {
  if (zoneIsWeightPriced(z)) {
    const x = Number(z.weight_extra_kg_fee) || 0;
    return `<span class="dz-wprice">¥${z.weight_first_kg_fee}${x ? ' +¥'+x+'/kg' : ''}</span>`;
  }
  return `¥${z.base_fee ?? 0}`;
}

function zoneExtrasHtml(z) {
  const bits = [];
  if (zoneIsWeightPriced(z)) bits.push('by weight · 按重量');
  if (z.zone_type === 'gz_district' && z.max_fee != null && z.max_fee !== '') bits.push(`MAX ¥${z.max_fee}`);
  if (z.zone_type === 'city') {
    if (z.packing_fee_per_item) bits.push(`Pack ¥${z.packing_fee_per_item}/ea`);
    if (z.packing_fee_cap != null && z.packing_fee_cap !== '') bits.push(`cap ¥${z.packing_fee_cap}`);
  }
  return bits.length ? `<span class="dz-extras">${bits.join(' · ')}</span>` : '<span class="muted">—</span>';
}

function sameDayCellHtml(z) {
  if (z.zone_type !== 'gz_district') return '<span class="dz-sd-no">—</span>';
  const fee = Number(z.same_day_surcharge) || 0;
  // Treat fee > 0 as same-day-on even when the allowed flag is stale —
  // matches what onSdFeeInput / save now enforce going forward.
  if (!z.same_day_allowed && !fee) return '<span class="dz-sd-no">✗</span>';
  return `<span class="dz-sd-yes">✓ ${fee ? '+¥'+fee : 'free'}</span>`;
}

// ── Drawer ──

function setZoneEditType(type) {
  _zoneEditType = type;
  $$('#dz-edit-type-seg button').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  const isGz = type === 'gz_district';
  $('#dz-edit-loc-label').firstChild.textContent = isGz ? 'Districts · 区/县 ' : 'Cities · 城市 ';
  // Swap picker UI: chip grid for GZ, chip-input for City.
  $('#dz-gz-chips').style.display   = isGz ? '' : 'none';
  $('#dz-city-picker').style.display = isGz ? 'none' : '';
  $$('.dz-only-gz').forEach(el => el.style.display = isGz ? '' : 'none');
  $$('.dz-only-city').forEach(el => el.style.display = isGz ? 'none' : '');
  if (isGz) renderDistrictChips(); else renderCityChips();
  updateMultiCount();
}

// Keep the "Allow same-day" checkbox and the +SD ¥ fee in sync so they
// can't drift into the inconsistent state where a fee is set but
// same_day_allowed is 0 (which silently disables same-day at checkout).
function onSdToggle() {
  const on = $('#dz-edit-sd').checked;
  const feeRow = $('#dz-edit-sd-fee-row');
  const feeInp = $('#dz-edit-sd-fee');
  if (feeRow) feeRow.style.opacity = on ? '' : '.4';
  if (feeInp) {
    feeInp.disabled = !on;
    if (!on) feeInp.value = '';
  }
}
function onSdFeeInput() {
  // Typing a fee implies the admin wants same-day enabled. Auto-tick
  // the checkbox so the two stay coherent.
  const v = Number($('#dz-edit-sd-fee').value);
  if (v > 0 && !$('#dz-edit-sd').checked) {
    $('#dz-edit-sd').checked = true;
    onSdToggle();
  }
}

function openZoneDrawer(id) {
  _zoneEditId = id ?? null;
  const z = id ? _zones.find(x => x.id === id) : null;
  const isNew = !z;
  $('#dz-edit-title').textContent = isNew ? 'Add zone · 添加配送区' : 'Edit zone · 编辑配送区';
  $('#dz-edit-sub').textContent  = isNew ? 'Pick one or more areas — the same pricing & scheduling applies to all. · 选择一个或多个区域,以下定价与时间应用于全部。' : zoneLabel(z) + (z.name_en ? ' · '+z.name_en : '');
  $('#dz-edit-type-row').style.display = isNew ? '' : 'none';
  $('#dz-edit-delete').style.display = isNew ? 'none' : '';
  // Apply-to-others is only meaningful once the zone exists (target list
  // needs the rest of the zones to exist; new zones aren't saved yet).
  $('#dz-edit-apply').style.display = isNew ? 'none' : '';

  // Display name fields are only useful when editing a single zone; in
  // Add mode each zone auto-names from its own district/city CN+EN.
  $('#dz-display-row').style.display = isNew ? 'none' : '';

  // Edit mode is single-zone — hide the multi-picker entirely; the
  // zone identity already lives in the drawer title/subtitle.
  $('#dz-edit-loc-label').parentElement.style.display = isNew ? '' : 'none';

  // Reset picker state every open
  _pickedDistricts = new Set();
  _pickedCities = [];
  const cityInput = $('#dz-city-input'); if (cityInput) cityInput.value = '';

  // Clear all fields first
  ['dz-gz-name-en','dz-gz-name-cn','dz-gz-base','dz-gz-max','dz-gz-free',
   'dz-city-pack','dz-city-pack-cap','dz-gz-w1','dz-gz-wx',
   'dz-edit-lead','dz-edit-maxlead','dz-edit-hours-start','dz-edit-hours-end','dz-edit-slot','dz-edit-sd-fee']
    .forEach(k => { const e = $('#'+k); if (e) e.value = ''; });
  $('#dz-edit-sd').checked = false;
  $('#dz-edit-dayonly').checked = false;
  $('#dz-edit-active').checked = true;

  setZoneEditType(z?.zone_type || 'gz_district');

  if (z) {
    // Edit mode — pre-fill the one zone we're editing into the chip picker
    // (locked, just for display) and the form fields.
    if (z.zone_type === 'gz_district') {
      _pickedDistricts.add(z.match_district);
      renderDistrictChips();
    } else {
      _pickedCities = [{ name_cn: z.match_city, name_en: z.name_en || '' }];
      renderCityChips();
    }
    $('#dz-gz-name-cn').value = z.name_cn ?? '';
    $('#dz-gz-name-en').value = z.name_en ?? '';
    $('#dz-gz-base').value    = z.base_fee ?? '';
    $('#dz-gz-free').value    = z.free_threshold ?? '';
    $('#dz-gz-max').value     = z.max_fee ?? '';
    $('#dz-gz-w1').value      = z.weight_first_kg_fee ?? '';
    $('#dz-gz-wx').value      = z.weight_extra_kg_fee ?? '';
    $('#dz-city-pack').value     = z.packing_fee_per_item ?? '';
    $('#dz-city-pack-cap').value = z.packing_fee_cap ?? '';
    $('#dz-edit-lead').value    = z.min_lead_days ?? '';
    $('#dz-edit-maxlead').value = z.max_lead_days ?? '';
    $('#dz-edit-hours-start').value = z.slot_start_hour ?? '';
    $('#dz-edit-hours-end').value   = z.slot_end_hour ?? '';
    $('#dz-edit-slot').value    = z.slot_duration_minutes ?? '';
    // Heal a legacy inconsistent state: if a surcharge is set but
    // same-day was off, treat same-day as on. The user clearly meant
    // for SD to be enabled when they typed a fee.
    const hasFee = Number(z.same_day_surcharge) > 0;
    $('#dz-edit-sd').checked       = !!z.same_day_allowed || hasFee;
    $('#dz-edit-sd-fee').value     = z.same_day_surcharge ?? '';
    $('#dz-edit-dayonly').checked  = !!z.day_only;
    $('#dz-edit-active').checked   = !!z.is_active;
  }
  // Sync the disabled/opacity state of +SD ¥ to the checkbox.
  onSdToggle();

  openDrawer('#dz-edit-bg');
}

function closeZoneDrawer() { closeDrawer('#dz-edit-bg'); }
// Reset edit state once the slide-out finishes — so the X button, ESC,
// and explicit Cancel/Save all converge on the same cleanup.
onDrawerClose('#dz-edit-bg', () => {
  _zoneEditId = null;
  _zoneDuplicateFrom = null;
});

async function saveZoneDrawer() {
  const isGz = _zoneEditType === 'gz_district';
  const numOrNull = v => v === '' || v == null ? null : Number(v);

  // Settings the user filled in on the form — these apply identically
  // to every selected district/city when adding multiple at once.
  const shared = {
    zone_type: _zoneEditType,
    base_fee: Number($('#dz-gz-base').value) || 0,
    free_threshold: numOrNull($('#dz-gz-free').value),
    max_fee: isGz ? numOrNull($('#dz-gz-max').value) : null,
    // Per-area weight rule (首重/续重). Only prices by weight when BOTH are set;
    // either blank → the server stores NULL and the zone falls back to flat.
    weight_first_kg_fee: numOrNull($('#dz-gz-w1').value),
    weight_extra_kg_fee: numOrNull($('#dz-gz-wx').value),
    packing_fee_per_item: isGz ? 0 : (Number($('#dz-city-pack').value) || 0),
    packing_fee_cap:      isGz ? null : numOrNull($('#dz-city-pack-cap').value),
    min_lead_days:  numOrNull($('#dz-edit-lead').value) ?? (isGz ? 0 : 3),
    max_lead_days:  numOrNull($('#dz-edit-maxlead').value) ?? 14,
    slot_start_hour: numOrNull($('#dz-edit-hours-start').value) ?? 10,
    slot_end_hour:   numOrNull($('#dz-edit-hours-end').value)   ?? 20,
    slot_duration_minutes: numOrNull($('#dz-edit-slot').value) ?? 120,
    // Same-day allowed is true if checkbox is ticked OR a fee > 0 is
    // entered — the two used to drift apart silently, leaving zones
    // with a stored surcharge but ✗ in the table. Belt-and-braces.
    same_day_allowed: isGz ? (($('#dz-edit-sd').checked || Number($('#dz-edit-sd-fee').value) > 0) ? 1 : 0) : 0,
    same_day_surcharge: isGz ? (Number($('#dz-edit-sd-fee').value) || 0) : 0,
    day_only: $('#dz-edit-dayonly').checked ? 1 : 0,
    is_active: $('#dz-edit-active').checked ? 1 : 0,
  };

  // Edit mode — PATCH the one zone with the form values + the manually
  // edited display names.
  if (_zoneEditId) {
    const z = _zones.find(x => x.id === _zoneEditId);
    const body = {
      ...shared,
      match_district: z?.match_district || null,
      match_city:     z?.match_city || null,
      name_cn: $('#dz-gz-name-cn').value.trim() || z?.name_cn || z?.match_district || z?.match_city,
      name_en: $('#dz-gz-name-en').value.trim() || null,
    };
    try {
      await api(`/api/retail-admin/delivery-zones/${_zoneEditId}`, { method: 'PATCH', body });
      toast('Zone saved · 配送区已保存');
      closeZoneDrawer();
      loadDeliveryZones();
    } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
    return;
  }

  // Add mode — gather picks, POST one per pick. Auto-name each from
  // its own CN/EN so per-zone identity is preserved.
  const picks = isGz
    ? [..._pickedDistricts].map(d => {
        const meta = _regions.gz.find(g => g.name_cn === d);
        return {
          match_district: d,
          match_city: null,
          name_cn: (d || '').replace(/(市|区|县)$/u, '') || d,
          name_en: meta?.name_en || null,
        };
      })
    : _pickedCities.map(c => ({
        match_district: null,
        match_city: c.name_cn,
        name_cn: (c.name_cn || '').replace(/(市|区|县)$/u, '') || c.name_cn,
        name_en: c.name_en || null,
      }));

  if (!picks.length) {
    return toast(isGz ? 'Pick at least one district · 请至少选一个区' : 'Add at least one city · 请至少添加一个城市', 'err');
  }

  let ok = 0, fail = 0, firstErr = null;
  for (const p of picks) {
    try {
      await api('/api/retail-admin/delivery-zones', { method: 'POST', body: { ...shared, ...p } });
      ok++;
    } catch (e) {
      fail++;
      if (!firstErr) firstErr = e.message;
    }
  }
  if (ok && !fail)      toast(`${ok === 1 ? 'Zone' : `${ok} zones`} added · 已添加 ${ok} 个配送区`);
  else if (ok && fail)  toast(`Added ${ok}, ${fail} failed · 已添加 ${ok},失败 ${fail}: ${firstErr || ''}`, 'err');
  else                  toast(`Save failed · 保存失败: ${firstErr || ''}`, 'err');
  if (ok) {
    closeZoneDrawer();
    loadDeliveryZones();
  }
}

async function deleteZoneFromDrawer() {
  if (!_zoneEditId) return;
  const z = _zones.find(x => x.id === _zoneEditId);
  if (!z) return;
  if (!confirm(`Delete delivery zone "${zoneLabel(z)}"? · 删除配送区 "${zoneLabel(z)}"？`)) return;
  try {
    await api(`/api/retail-admin/delivery-zones/${_zoneEditId}`, { method: 'DELETE' });
    toast('Zone deleted · 配送区已删除');
    closeZoneDrawer();
    loadDeliveryZones();
  } catch (e) { toast('Delete failed · 删除失败: '+e.message, 'err'); }
}

// ── Duplicate ──
// Opens the drawer as "new" but with another zone's settings pre-filled —
// except for the location (district/city) and display names, which the user
// fills in for the new area. Save creates a fresh row.
let _zoneDuplicateFrom = null;
function duplicateZone(id) {
  const src = _zones.find(z => z.id === id);
  if (!src) return;
  _zoneDuplicateFrom = id;
  openZoneDrawer(null);  // sets _zoneEditId = null → POST on save
  // Re-do the form prefill from the source zone. openZoneDrawer cleared
  // everything; we now copy over every field except location + display names.
  setZoneEditType(src.zone_type);
  // Picker stays empty — admin picks one or many new areas, all
  // inheriting the source's pricing/scheduling.
  $('#dz-gz-base').value     = src.base_fee ?? '';
  $('#dz-gz-free').value     = src.free_threshold ?? '';
  $('#dz-gz-max').value      = src.max_fee ?? '';
  $('#dz-city-pack').value     = src.packing_fee_per_item ?? '';
  $('#dz-city-pack-cap').value = src.packing_fee_cap ?? '';
  $('#dz-edit-lead').value     = src.min_lead_days ?? '';
  $('#dz-edit-maxlead').value  = src.max_lead_days ?? '';
  $('#dz-edit-hours-start').value = src.slot_start_hour ?? '';
  $('#dz-edit-hours-end').value   = src.slot_end_hour ?? '';
  $('#dz-edit-slot').value     = src.slot_duration_minutes ?? '';
  $('#dz-edit-sd').checked      = !!src.same_day_allowed;
  $('#dz-edit-sd-fee').value    = src.same_day_surcharge ?? '';
  $('#dz-edit-dayonly').checked = !!src.day_only;
  $('#dz-edit-active').checked  = !!src.is_active;
  // Reframe the drawer header so it's obvious we're cloning.
  const lbl = zoneLabel(src);
  $('#dz-edit-title').textContent = `Duplicate of ${lbl} · 复制 ${lbl}`;
  $('#dz-edit-sub').textContent   = 'Pick a new district/city — the rest is pre-filled. You can edit anything before saving. · 请选择新区/城市,其余已预填,可调整后保存。';
  // Apply-to-others on a duplicate makes no sense (no id yet), keep hidden.
  $('#dz-edit-apply').style.display = 'none';
}


// ── Apply to others ──
// Pushes the CURRENT drawer-form values to a multi-select of other zones in
// one go. Uses Promise.all against the existing PATCH endpoint so we don't
// need a new backend route.
let _applyBundles = new Set(['pricing','scheduling']);
let _applyTargets = new Set();

function openApplyPanel() {
  // Default: re-include pricing + scheduling, exclude active.
  _applyBundles = new Set(['pricing','scheduling']);
  $$('.dz-apply-bundle-cb').forEach(cb => {
    cb.checked = _applyBundles.has(cb.dataset.bundle);
    cb.onchange = () => {
      if (cb.checked) _applyBundles.add(cb.dataset.bundle);
      else            _applyBundles.delete(cb.dataset.bundle);
      updateApplyCount();   // toggles Apply-button disabled state
    };
  });
  _applyTargets = new Set();
  // Subtitle reminds them whose settings they're about to copy.
  const src = _zoneEditId ? _zones.find(z => z.id === _zoneEditId) : null;
  $('#dz-apply-sub').textContent = src
    ? `Pushing ${zoneLabel(src)}'s current form values. · 当前以 ${zoneLabel(src)} 表单内的值为准。`
    : 'Pushing the drawer\'s current form values. · 以当前抽屉表单内的值为准。';
  renderApplyTargets();
  updateApplyCount();
  $('#dz-apply-bg').classList.add('show');
}

function closeApplyPanel() {
  $('#dz-apply-bg').classList.remove('show');
}

function renderApplyTargets() {
  const list = $('#dz-apply-list');
  // Targets = every zone except the one being edited.
  const targets = _zones.filter(z => z.id !== _zoneEditId);
  if (!targets.length) {
    list.innerHTML = '<div class="dz-apply-empty">No other zones to copy to. Add some first. · 没有其他配送区可复制。请先添加。</div>';
    return;
  }
  // GZ districts on top, cities below — alphabetical inside each group.
  const gz   = targets.filter(z => z.zone_type === 'gz_district').sort((a,b) => (a.name_cn||'').localeCompare(b.name_cn||''));
  const city = targets.filter(z => z.zone_type === 'city').sort((a,b) => (a.name_cn||'').localeCompare(b.name_cn||''));
  const rowHtml = z => {
    const isGz = z.zone_type === 'gz_district';
    const chip = `<span class="dz-type-chip ${isGz?'gz':'city'}">${isGz?'GZ':'CITY'}</span>`;
    const cn = escapeHtml(zoneLabel(z) || '—');
    const en = z.name_en ? `<span class="sub">${escapeHtml(z.name_en)}</span>` : '';
    return `<label class="dz-apply-row">
      <input type="checkbox" data-zid="${z.id}" ${_applyTargets.has(z.id) ? 'checked' : ''}>
      ${chip}
      <span class="dz-apply-name">${cn}${en}</span>
    </label>`;
  };
  list.innerHTML = [...gz, ...city].map(rowHtml).join('');
  // Wire change handlers — keep _applyTargets in sync as checkboxes flip.
  list.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      const id = Number(cb.dataset.zid);
      if (cb.checked) _applyTargets.add(id);
      else            _applyTargets.delete(id);
      updateApplyCount();
    };
  });
}

function updateApplyCount() {
  const n = _applyTargets.size;
  $('#dz-apply-count').textContent = `${n} zone(s) selected · 已选 ${n} 个配送区`;
  const go = $('#dz-apply-go');
  if (go) go.disabled = n === 0 || _applyBundles.size === 0;
}

function setApplyBundles(allOn) {
  $$('.dz-apply-bundle-cb').forEach(cb => {
    cb.checked = allOn;
    if (allOn) _applyBundles.add(cb.dataset.bundle);
    else       _applyBundles.delete(cb.dataset.bundle);
  });
  updateApplyCount();
}

function setApplyTargets(mode) {
  const targets = _zones.filter(z => z.id !== _zoneEditId);
  if (mode === 'none') _applyTargets = new Set();
  else if (mode === 'all')  _applyTargets = new Set(targets.map(z => z.id));
  else if (mode === 'gz')   _applyTargets = new Set(targets.filter(z => z.zone_type === 'gz_district').map(z => z.id));
  else if (mode === 'city') _applyTargets = new Set(targets.filter(z => z.zone_type === 'city').map(z => z.id));
  renderApplyTargets();
  updateApplyCount();
}

// Build the patch body for a single target. We DON'T blanket-copy every
// field — type-incompatible ones get skipped (a GZ-only field like
// same_day_surcharge is silently dropped when targeting a city zone, and
// vice-versa for packing_fee_*).
function buildApplyBody(target) {
  const isGzTarget = target.zone_type === 'gz_district';
  const numOrNull = v => v === '' || v == null ? null : Number(v);
  const body = {};

  if (_applyBundles.has('pricing')) {
    body.base_fee       = Number($('#dz-gz-base').value) || 0;
    body.free_threshold = numOrNull($('#dz-gz-free').value);
    if (isGzTarget) {
      body.max_fee = numOrNull($('#dz-gz-max').value);
    } else {
      body.packing_fee_per_item = Number($('#dz-city-pack').value) || 0;
      body.packing_fee_cap      = numOrNull($('#dz-city-pack-cap').value);
    }
  }

  if (_applyBundles.has('scheduling')) {
    body.min_lead_days         = numOrNull($('#dz-edit-lead').value) ?? (isGzTarget ? 0 : 3);
    body.max_lead_days         = numOrNull($('#dz-edit-maxlead').value) ?? 14;
    body.slot_start_hour       = numOrNull($('#dz-edit-hours-start').value) ?? 10;
    body.slot_end_hour         = numOrNull($('#dz-edit-hours-end').value) ?? 20;
    body.slot_duration_minutes = numOrNull($('#dz-edit-slot').value) ?? 120;
    body.day_only              = $('#dz-edit-dayonly').checked ? 1 : 0;
    if (isGzTarget) {
      body.same_day_allowed   = $('#dz-edit-sd').checked ? 1 : 0;
      body.same_day_surcharge = Number($('#dz-edit-sd-fee').value) || 0;
    }
  }

  if (_applyBundles.has('active')) {
    body.is_active = $('#dz-edit-active').checked ? 1 : 0;
  }

  return body;
}

async function applyToSelected() {
  if (_applyTargets.size === 0)  return toast('Pick at least one zone · 请选择配送区', 'err');
  if (_applyBundles.size === 0)  return toast('Pick at least one field bundle · 请选择字段', 'err');
  const targets = _zones.filter(z => _applyTargets.has(z.id));
  if (!confirm(`Apply current settings to ${targets.length} zone(s)?\n${targets.map(z => '  • '+zoneLabel(z)).join('\n')}`)) return;

  const go = $('#dz-apply-go');
  if (go) go.disabled = true;
  try {
    const results = await Promise.allSettled(targets.map(t =>
      api(`/api/retail-admin/delivery-zones/${t.id}`, { method: 'PATCH', body: buildApplyBody(t) })
    ));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      toast(`${results.length - failed.length} ok, ${failed.length} failed · ${results.length - failed.length} 成功, ${failed.length} 失败`, 'err');
    } else {
      toast(`Applied to ${results.length} zone(s) · 已应用到 ${results.length} 个配送区`);
    }
    closeApplyPanel();
    loadDeliveryZones();
  } catch (e) {
    toast('Apply failed · 应用失败: '+e.message, 'err');
  } finally {
    if (go) go.disabled = false;
  }
}

async function updateZone(id, field, val) {
  if (val === '' && ['max_fee','free_threshold','packing_fee_cap'].includes(field)) val = null;
  if (val === '' && ['same_day_surcharge','min_lead_days','slot_start_hour','slot_end_hour','slot_duration_minutes'].includes(field)) val = 0;
  try {
    await api(`/api/retail-admin/delivery-zones/${id}`, { method: 'PATCH', body: { [field]: val } });
    // Keep local state + coverage tiles in sync after an optimistic inline edit
    // (the on/off checkbox) without a full reload.
    const z = _zones.find(z => z.id === id); if (z) z[field] = val;
    if (field === 'is_active') dzRenderKpis(false);
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); loadDeliveryZones(); }
}

async function deleteZone(id, label) {
  if (!confirm(`Delete delivery zone "${label}"? · 删除配送区 "${label}"？`)) return;
  try {
    await api(`/api/retail-admin/delivery-zones/${id}`, { method: 'DELETE' });
    toast('Zone deleted · 配送区已删除');
    loadDeliveryZones();
  } catch (e) { toast('Delete failed · 删除失败: '+e.message, 'err'); }
}

async function saveDeliveryDefaults() {
  const body = {
    'delivery.kitchenAddress':       $('#dlv-kitchen-address').value.trim(),
  };
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    toast('Saved · 已保存');
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
}

// Delivery & pickup fees — moved here from Settings → Checkout & fees (2026-06-02).
// Writes the same fees.* / pickup.window keys the server already reads for pricing,
// so this is purely where the operator edits them, not a change to how prices compute.
async function saveDeliveryFees() {
  const body = {
    'fees.freeShippingThreshold':  Number($('#cfg-fees-freeShippingThreshold').value) || 0,
    'fees.standardShipping':       Number($('#cfg-fees-standardShipping').value) || 0,
    'fees.sameDayDelivery':        Number($('#cfg-fees-sameDayDelivery').value) || 0,
    'fees.pickupPackingFee':       Number($('#cfg-fees-pickupPackingFee').value) || 0,
    // Minimum-order checkout gate — moved here from Settings → Checkout & fees so
    // it saves alongside the other cart money rules (2026-06-08).
    'fees.minOrder':               Number($('#cfg-fees-minOrder').value) || 0,
    'pickup.window':               {
      open:  $('#cfg-pickup-open').value  || '10:00',
      close: $('#cfg-pickup-close').value || '20:00',
    },
  };
  const status = $('#dlv-fees-status');
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    if (status) { status.textContent = 'Saved · 已保存'; setTimeout(() => { if (status) status.textContent = ''; }, 2500); }
    toast('Saved · 已保存');
  } catch (e) {
    if (status) status.textContent = '';
    toast('Save failed · 保存失败: '+e.message, 'err');
  }
}

// ════════════════════════════════════════════════════════════════
// MOBILE DELIVERY — Variant A "settings hub" (phone ≤720px)
// ════════════════════════════════════════════════════════════════
// Renders the desktop delivery surface as an iOS-Settings-style hub of
// grouped value rows, each read straight from the live desktop inputs /
// _zones. Tapping a row pushes a focused full-screen editor prefilled from
// those same inputs; Save writes the values back and calls the EXISTING save
// fn (saveDeliveryFees / saveHolidayMode / …). Zones reuse openZoneDrawer +
// updateZone. No new fetch, no backend change. Desktop is untouched.

function rmDlvIcon(name) {
  const I = {
    pin:  '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/>',
    tag:  '<path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><circle cx="7" cy="7" r="1.4"/>',
    truck:'<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/>',
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    box:  '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.27 6.96 8.73 5.05 8.73-5.05"/><path d="M12 22.08V12"/>',
    clock:'<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    sun:  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    repeat:'<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    chev: '<polyline points="9 18 15 12 9 6"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${I[name] || ''}</svg>`;
}

// Editor specs — id = desktop input id; kind drives the control. Save copies
// each control back to its desktop input, then calls the existing save fn.
const RM_DLV_EDITORS = {
  fees: {
    title: 'Fees · 费用', save: 'saveDeliveryFees',
    fields: [
      { id: 'cfg-fees-freeShippingThreshold', kind: 'yen', label: 'Free-shipping threshold · 包邮门槛', hint: 'Subtotal that unlocks free standard delivery. 0 = always free. A zone’s own Free-over overrides this. · 达此金额标准配送免运;0 = 始终免运。配送区自设值优先。' },
      { id: 'cfg-fees-standardShipping', kind: 'yen', label: 'Standard shipping fee · 标准运费' },
      { id: 'cfg-fees-sameDayDelivery', kind: 'yen', label: 'Same-day delivery fee · 当日达运费' },
      { id: 'cfg-fees-pickupPackingFee', kind: 'yen', label: 'Store pickup packing fee · 自提包装费' },
      { kind: 'time2', ids: ['cfg-pickup-open', 'cfg-pickup-close'], label: 'Store pickup hours · 到店自提时间' },
    ],
  },
  holiday: {
    title: 'Holiday mode · 假期模式', save: 'saveHolidayMode',
    fields: [
      { id: 'dlv-holiday-mode', kind: 'toggle', label: 'Holiday mode · 假期模式', hint: 'When on, same-day delivery is hidden and the message below shows at checkout. Orders are still accepted. · 开启后隐藏当日达并在结账页显示下方提示,订单仍可接收。' },
      { id: 'dlv-holiday-msg-en', kind: 'textarea', label: 'Message (English) · 英文消息' },
      { id: 'dlv-holiday-msg-cn', kind: 'textarea', label: '消息(中文)· Message (Chinese)' },
    ],
  },
  batch: {
    title: 'Batch schedule · 现做排期', save: 'saveBatchSchedule',
    fields: [
      { id: 'batch-enabled', kind: 'toggle', label: 'Fresh batch schedule · 分批现做', hint: 'Affects orders with a batch-made item shipping outside Guangzhou OR to a far GZ district (Panyu, Huadu, Nansha, Conghua, Zengcheng). · 影响含「分批现做」商品且配送至广州以外或较远城区(番禺、花都、南沙、从化、增城)的订单。' },
      { id: 'batch-anchor', kind: 'date', label: 'A batch day · 某个制作日' },
      { id: 'batch-interval', kind: 'numsm', unit: 'days · 天', label: 'Make every · 每隔' },
      { id: 'batch-skip', kind: 'textarea', mono: true, label: 'Skip these dates · 跳过这些日期', ph: '2026-07-14\n2026-07-16' },
      { id: 'batch-kicker-en', kind: 'text', label: 'Popup eyebrow — English · 弹窗小标题(英文)' },
      { id: 'batch-kicker-cn', kind: 'text', label: '弹窗小标题(中文)· Popup eyebrow — Chinese' },
      { id: 'batch-title-en', kind: 'text', label: 'Popup title — English · 弹窗标题(英文)' },
      { id: 'batch-title-cn', kind: 'text', label: '弹窗标题(中文)· Popup title — Chinese' },
      { id: 'batch-msg-en', kind: 'textarea', label: 'Checkout notice — English · 结账提示(英文)' },
      { id: 'batch-msg-cn', kind: 'textarea', label: '结账提示(中文)· Checkout notice — Chinese' },
    ],
  },
  default: {
    title: 'Rest of China · 其他地区', save: 'saveDefaultZone',
    fields: [
      { id: 'dlv-default-enabled', kind: 'toggle', label: 'Default delivery on · 启用默认配送', hint: 'A flat fee for any mainland address not covered by a zone. Off = unmatched addresses can’t check out. · 未被任何配送区覆盖的大陆地址的统一运费;关闭则无匹配地址无法结账。' },
      { id: 'dlv-default-fee', kind: 'yen', label: 'Flat fee · 统一运费' },
      { id: 'dlv-default-free', kind: 'yen', label: 'Free over · 满额免运', ph: '329' },
      { kind: 'frow2', children: [
        { id: 'dlv-default-pack', kind: 'yensm', label: 'Packing / item · 每件包装费' },
        { id: 'dlv-default-pack-cap', kind: 'yensm', label: 'Packing cap · 包装费上限', ph: '—' },
      ] },
      { id: 'dlv-default-lead', kind: 'numsm', unit: 'days · 天', label: 'Lead time · 备货天数' },
    ],
  },
  kitchen: {
    title: 'Kitchen address · 厨房地址', save: 'saveDeliveryDefaults',
    fields: [
      { id: 'dlv-kitchen-address', kind: 'text', label: 'Kitchen address (customer-facing) · 厨房地址(顾客可见)', ph: '广州市天河区 (Roots Kitchen)', hint: 'Shown on checkout when a customer’s address matches no zone, so they know where you ship from. Not used for distance. · 当顾客地址不匹配任何配送区时在结账页显示。不用于距离计算。' },
    ],
  },
};

const _rmGv = (id) => { const el = document.getElementById(id); return el ? (el.value ?? '') : ''; };
const _rmGc = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };

function rmDlvFieldHtml(f) {
  const lab = `<label class="rm-flab">${f.label}</label>`;
  const hint = f.hint ? `<p class="rm-fhint">${f.hint}</p>` : '';
  const eid = 'rmed_' + f.id;
  if (f.kind === 'frow2') {
    return `<div class="rm-frow2">${f.children.map(c => `<div>${rmDlvFieldHtml(c)}</div>`).join('')}</div>`;
  }
  if (f.kind === 'toggle') {
    const on = _rmGc(f.id);
    return `<div class="rm-rowtoggle"><span>${f.label}</span>` +
      `<button type="button" id="${eid}" class="rm-switch${on ? ' on' : ''}" aria-pressed="${on}" onclick="this.classList.toggle('on'); this.setAttribute('aria-pressed', this.classList.contains('on'));"></button></div>${hint}`;
  }
  if (f.kind === 'textarea') {
    const st = f.mono ? ' style="font-family:var(--f-mono); font-size:13px;"' : '';
    return `${lab}<textarea id="${eid}" class="rm-dlv-ta"${st} placeholder="${escapeHtml(f.ph || '')}">${escapeHtml(_rmGv(f.id))}</textarea>${hint}`;
  }
  if (f.kind === 'time2') {
    return `${lab}<div class="rm-timefield">` +
      `<input type="time" id="rmed_${f.ids[0]}" value="${escapeHtml(_rmGv(f.ids[0]))}">` +
      `<input type="time" id="rmed_${f.ids[1]}" value="${escapeHtml(_rmGv(f.ids[1]))}"></div>${hint}`;
  }
  if (f.kind === 'yen') {
    return `${lab}<div class="rm-numfield"><span class="u">¥</span>` +
      `<input type="number" inputmode="decimal" id="${eid}" value="${escapeHtml(_rmGv(f.id))}" placeholder="${escapeHtml(f.ph || '')}"></div>${hint}`;
  }
  if (f.kind === 'yensm') {
    return `${lab}<div class="rm-smallnum"><span class="u">¥</span>` +
      `<input type="number" inputmode="decimal" id="${eid}" value="${escapeHtml(_rmGv(f.id))}" placeholder="${escapeHtml(f.ph || '')}"></div>${hint}`;
  }
  if (f.kind === 'numsm') {
    return `${lab}<div class="rm-smallnum">` +
      `<input type="number" inputmode="numeric" id="${eid}" value="${escapeHtml(_rmGv(f.id))}">` +
      `<span class="u">${f.unit || ''}</span></div>${hint}`;
  }
  if (f.kind === 'date') {
    return `${lab}<div class="rm-smallnum"><input type="date" id="${eid}" value="${escapeHtml(_rmGv(f.id))}" style="font-size:16px;"></div>${hint}`;
  }
  // text
  return `${lab}<div class="rm-smallnum"><input type="text" id="${eid}" value="${escapeHtml(_rmGv(f.id))}" placeholder="${escapeHtml(f.ph || '')}" style="font-size:16px;"></div>${hint}`;
}

let _rmDlvEdKey = null;
function rmDlvOpenEditor(key) {
  const spec = RM_DLV_EDITORS[key];
  if (!spec) return;
  _rmDlvEdKey = key;
  const t = document.getElementById('rm-dlv-ed-title');
  if (t) t.textContent = spec.title;
  const body = document.getElementById('rm-dlv-ed-body');
  if (body) body.innerHTML = '<div class="rm-edcard">' + spec.fields.map(rmDlvFieldHtml).join('') + '</div>';
  const p = document.getElementById('rm-dlv-editor');
  if (p) { p.classList.add('open'); p.setAttribute('aria-hidden', 'false'); }
}
function rmDlvCloseEditor() {
  const p = document.getElementById('rm-dlv-editor');
  if (p) { p.classList.remove('open'); p.setAttribute('aria-hidden', 'true'); }
}
function rmDlvSaveEditor() {
  const spec = RM_DLV_EDITORS[_rmDlvEdKey];
  if (!spec) return;
  const writeBack = (f) => {
    if (f.kind === 'frow2') { f.children.forEach(writeBack); return; }
    if (f.kind === 'toggle') {
      const btn = document.getElementById('rmed_' + f.id);
      const cb = document.getElementById(f.id);
      if (btn && cb) { cb.checked = btn.classList.contains('on'); cb.dispatchEvent(new Event('change')); }
      return;
    }
    if (f.kind === 'time2') {
      f.ids.forEach(id => { const s = document.getElementById('rmed_' + id), d = document.getElementById(id); if (s && d) d.value = s.value; });
      return;
    }
    const s = document.getElementById('rmed_' + f.id), d = document.getElementById(f.id);
    if (s && d) d.value = s.value;
  };
  spec.fields.forEach(writeBack);
  const fn = window[spec.save];
  if (typeof fn === 'function') fn();
  rmDlvRenderHub();
  rmDlvCloseEditor();
}

function rmDlvRenderHub() {
  const host = document.getElementById('rm-dlv-hub');
  if (!host) return;
  const yen = (id) => { const v = _rmGv(id); return v === '' ? '—' : '¥' + v; };
  const zones = Array.isArray(window._zones) ? window._zones : (typeof _zones !== 'undefined' ? _zones : []);
  const active = zones.filter(z => z.is_active).length;
  const pill = (on) => `<span class="rm-pill-status ${on ? 'on' : 'off'}">${on ? 'ON · 开' : 'OFF · 关'}</span>`;
  // Combined: an instant on/off switch right on the row (flip mid-rush without
  // opening the editor); tapping the rest of the row still opens it for config.
  const toggle = (on, key) => `<span class="rm-switch rm-dlv-tgl ${on ? 'on' : ''}" data-dlv-toggle="${key}" role="switch" aria-checked="${on}" tabindex="0"></span>`;
  const grouplab = (t) => `<div class="rm-dlv-grouplab">${t}<span class="ln"></span></div>`;
  const row = (icon, t, s, right, onclick) =>
    `<button type="button" class="rm-setrow" onclick="${onclick}">` +
      `<span class="rm-dlv-ic">${rmDlvIcon(icon)}</span>` +
      `<span class="tx"><span class="t">${t}</span>${s ? `<span class="s">${s}</span>` : ''}</span>` +
      `${right || ''}<span class="chev">${rmDlvIcon('chev')}</span></button>`;
  const val = (v, brass) => `<span class="val${brass ? ' brass' : ''}">${v}</span>`;
  const holidayOn = _rmGc('dlv-holiday-mode');
  const batchOn = _rmGc('batch-enabled');
  const defOn = _rmGc('dlv-default-enabled');
  const addr = _rmGv('dlv-kitchen-address');
  host.innerHTML =
    grouplab('Coverage · 配送区') +
    '<div class="rm-dlv-group">' +
      row('pin', 'Delivery zones · 配送区', 'Areas, pricing &amp; scheduling · 区域、定价与时间', val(active + ' active · 启用'), 'rmDlvOpenZones()') +
    '</div>' +
    grouplab('Fees · 费用') +
    '<div class="rm-dlv-group">' +
      row('tag', 'Free-shipping threshold · 包邮门槛', '', val(yen('cfg-fees-freeShippingThreshold'), true), "rmDlvOpenEditor('fees')") +
      row('truck', 'Standard shipping · 标准运费', '', val(yen('cfg-fees-standardShipping')), "rmDlvOpenEditor('fees')") +
      row('bolt', 'Same-day delivery · 当日达', '', val(yen('cfg-fees-sameDayDelivery')), "rmDlvOpenEditor('fees')") +
      row('box', 'Pickup packing · 自提包装', '', val(yen('cfg-fees-pickupPackingFee')), "rmDlvOpenEditor('fees')") +
      row('clock', 'Pickup hours · 自提时间', '', val((_rmGv('cfg-pickup-open') || '—') + '–' + (_rmGv('cfg-pickup-close') || '—')), "rmDlvOpenEditor('fees')") +
    '</div>' +
    grouplab('Schedule &amp; closures · 排期与休假') +
    '<div class="rm-dlv-group">' +
      row('sun', 'Holiday mode · 假期模式', 'Pause same-day, show a banner · 暂停当日达并显示横幅', toggle(holidayOn, 'holiday'), "rmDlvOpenEditor('holiday')") +
      row('repeat', 'Fresh batch schedule · 现做排期', 'Outside-GZ + far districts · 广州以外及较远城区', pill(batchOn), "rmDlvOpenEditor('batch')") +
    '</div>' +
    grouplab('Defaults · 默认') +
    '<div class="rm-dlv-group">' +
      row('globe', 'Rest of China · 其他地区', defOn ? ('Flat ' + yen('dlv-default-fee') + ' · 统一运费') : 'Off — unmatched addresses blocked · 关闭', toggle(defOn, 'default'), "rmDlvOpenEditor('default')") +
      row('home', 'Kitchen address · 厨房地址', addr ? escapeHtml(addr) : 'Not set · 未设置', '', "rmDlvOpenEditor('kitchen')") +
    '</div>';

  // Bind the instant switches once (capture phase, so a tap on the switch flips
  // + saves and never reaches the row button's open-editor onclick).
  if (!host._rmTglBound) {
    host._rmTglBound = true;
    host.addEventListener('click', function (e) {
      var sw = e.target.closest('[data-dlv-toggle]');
      if (sw) { e.stopPropagation(); e.preventDefault(); rmDlvInstantToggle(sw.getAttribute('data-dlv-toggle')); }
    }, true);
  }
}

// Flip Holiday / Rest-of-China instantly: toggle the (hidden) desktop control
// the existing save reads, persist via its save fn, then re-render the hub.
async function rmDlvInstantToggle(key) {
  var cb, save;
  if (key === 'holiday') { cb = document.getElementById('dlv-holiday-mode'); save = saveHolidayMode; }
  else if (key === 'default') { cb = document.getElementById('dlv-default-enabled'); save = saveDefaultZone; }
  else return;
  if (!cb || typeof save !== 'function') return;
  cb.checked = !cb.checked;
  var sw = document.querySelector('#rm-dlv-hub [data-dlv-toggle="' + key + '"]');
  if (sw) { sw.classList.toggle('on', cb.checked); sw.setAttribute('aria-checked', String(cb.checked)); }
  try { await save(); } finally { if (typeof rmDlvRenderHub === 'function') rmDlvRenderHub(); }
}

function rmDlvOpenZones() {
  rmDlvRenderZones();
  const p = document.getElementById('rm-dlv-zones');
  if (p) { p.classList.add('open'); p.setAttribute('aria-hidden', 'false'); }
}
function rmDlvCloseZones() {
  const p = document.getElementById('rm-dlv-zones');
  if (p) { p.classList.remove('open'); p.setAttribute('aria-hidden', 'true'); }
}
function rmDlvZoneView(v) {
  if (typeof setZoneView === 'function') setZoneView(v);
  rmDlvRenderZones();
}
function rmDlvRenderZones() {
  const host = document.getElementById('rm-dlv-zones-body');
  if (!host) return;
  const zones = Array.isArray(window._zones) ? window._zones : (typeof _zones !== 'undefined' ? _zones : []);
  const view = (typeof _zoneView !== 'undefined' && _zoneView) ? _zoneView : 'pricing';
  const seg = '<div class="rm-zoneseg">' +
    `<button type="button" class="${view === 'pricing' ? 'on' : ''}" onclick="rmDlvZoneView('pricing')">Pricing · 定价</button>` +
    `<button type="button" class="${view === 'scheduling' ? 'on' : ''}" onclick="rmDlvZoneView('scheduling')">Scheduling · 时间</button></div>`;
  if (!zones.length) { host.innerHTML = seg + '<div class="rm-zempty">No zones yet — tap Add. · 暂无配送区,点「添加」。</div>'; return; }
  const groups = (typeof groupZonesByProvince === 'function') ? groupZonesByProvince(zones) : [{ en: '', cn: '', rows: zones }];
  const code = (z) => z.zone_type === 'gz_district' ? 'GZ' : (z.is_province_wide ? 'PROV' : 'CITY');
  const feeHtml = (z) => {
    if (view === 'pricing') {
      const free = z.free_threshold == null ? 'default · 默认' : '免 ¥' + z.free_threshold;
      const price = zoneIsWeightPriced(z)
        ? '¥' + z.weight_first_kg_fee + (Number(z.weight_extra_kg_fee) ? ' +¥' + z.weight_extra_kg_fee + '/kg' : '')
        : '¥' + (z.base_fee ?? 0);
      return `<div class="b">${price}</div><div class="f">${free}</div>`;
    }
    const mode = z.day_only ? 'Day · 按日' : 'Slots · 时段';
    return `<div class="b">${mode}</div><div class="f">${(z.min_lead_days ?? 0)}–${(z.max_lead_days ?? 14)}d</div>`;
  };
  const zlabel = (z) => (typeof zoneLabel === 'function') ? zoneLabel(z) : (z.name_cn || z.match_city || '');
  const rowHtml = (z) =>
    `<button type="button" class="rm-zrow" style="${z.is_active ? '' : 'opacity:.5'}" onclick="rmDlvCloseZones(); openZoneDrawer(${z.id});">` +
      `<span class="code">${code(z)}</span>` +
      `<span class="nm"><span class="n">${escapeHtml(zlabel(z) || '—')}</span>${z.name_en ? `<span class="m">${escapeHtml(z.name_en)}</span>` : ''}</span>` +
      `<span class="fee">${feeHtml(z)}</span></button>`;
  host.innerHTML = seg + groups.map(g =>
    `<div class="rm-zglab"><span class="g">${escapeHtml(g.en || g.cn || '')}</span><span class="c">${g.rows.length}</span></div>` +
    `<div class="rm-zlist">${g.rows.map(rowHtml).join('')}</div>`).join('');
}

// ════════════════════════════════════════════════════════════════
// DELIVERY HUB (desktop) — card hub + sub-views (dlv*)
// ════════════════════════════════════════════════════════════════
// Redesign 2026-07-03 (mockup: design-handoff/18-delivery-hub-mockup.html).
// The Delivery tab opens on a grid of status cards; each card's button opens
// one sub-view holding the existing form (same input IDs, same save fns).
// dlvGo() flips [hidden] on the .dlv-view wrappers + the section's data-dlv
// attribute (CSS shows #dz-kpis only on the zones view, desktop-only).
// dlvHubRender() paints every card's status line from data that's already in
// the DOM / globals: _zones, the live inputs, window._shipStatus (stashed by
// loadShippingIntegrations), window._qyConnected (stashed by loadQingyunStores).

function dlvGo(view) {
  const sec = document.getElementById('tab-delivery');
  if (!sec) return;
  sec.setAttribute('data-dlv', view);
  sec.querySelectorAll(':scope > .dlv-view').forEach(v => { v.hidden = v.getAttribute('data-dlv') !== view; });
  if (view === 'hub') dlvHubRender();
  if (view === 'qy' && typeof loadQingyunStores === 'function') loadQingyunStores();
  window.scrollTo({ top: 0 });
}

// One card's status line: dot + text (mirrors the Sales-page pattern).
function _dlvStat(id, dot, text) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '<span class="sales-dot ' + dot + '"></span>' + text;
}
// A card's button: primary "Set up" while unconfigured, quiet label after.
function _dlvBtn(id, configured, doneEn, doneCn) {
  const b = document.getElementById(id);
  if (!b) return;
  b.textContent = configured ? cuT(doneEn, doneCn) : cuT('Set up', '设置');
  b.classList.toggle('btn-primary', !configured);
}

let _DLV_HUB_LANG_HOOKED = false;
function dlvHubRender() {
  if (!document.getElementById('dlv-st-zones')) return;
  // Lazy lang hook — window.onLangChange is defined after the part files load.
  if (!_DLV_HUB_LANG_HOOKED && window.onLangChange) {
    _DLV_HUB_LANG_HOOKED = true;
    onLangChange(function () { dlvHubRender(); });
  }
  const val = (sel) => { const el = document.querySelector(sel); return el ? el.value : ''; };

  // Zones — the one true blocker for a new store.
  const rows = Array.isArray(_zones) ? _zones : [];
  const act = rows.filter(z => z.is_active);
  const off = rows.length - act.length;
  const sameday = act.filter(z => z.zone_type === 'gz_district' && (z.same_day_allowed || Number(z.same_day_surcharge) > 0)).length;
  const defOn = !!document.getElementById('dlv-default-enabled')?.checked;
  const zonesReady = act.length > 0 || defOn;
  if (!zonesReady) {
    _dlvStat('dlv-st-zones', 'off', cuT("Not set up — delivery addresses can't check out", '未设置 — 配送地址无法结账'));
  } else {
    _dlvStat('dlv-st-zones', 'ok',
      cuT(act.length + ' zone' + (act.length === 1 ? '' : 's') + ' live' + (sameday ? ' · same-day in ' + sameday : ''),
          act.length + ' 个配送区' + (sameday ? ' · ' + sameday + ' 区当日达' : '')));
  }
  _dlvBtn('dlv-btn-zones', zonesReady, 'Manage', '管理');
  const zm = document.getElementById('dlv-meta-zones');
  if (zm) zm.textContent = off > 0 ? cuT(off + ' disabled', off + ' 区停用') : '';
  const strip = document.getElementById('dlv-setup-strip');
  if (strip) strip.hidden = zonesReady;

  // Fees & minimum — read the live inputs (loadConfig fills them).
  const std = val('#cfg-fees-standardShipping'), free = val('#cfg-fees-freeShippingThreshold'), min = Number(val('#cfg-fees-minOrder')) || 0;
  if (std === '' && free === '') {
    _dlvStat('dlv-st-fees', 'off', cuT('Using defaults', '使用默认值'));
  } else {
    const freeEn = Number(free) > 0 ? ' · free over ¥' + free : ' · always free over ¥0';
    const freeCn = Number(free) > 0 ? ' · 满 ¥' + free + ' 免运' : ' · 始终包邮';
    _dlvStat('dlv-st-fees', 'ok',
      cuT('Standard ¥' + (std || 0) + freeEn + (min > 0 ? ' · min ¥' + min : ''),
          '标准 ¥' + (std || 0) + freeCn + (min > 0 ? ' · 起送 ¥' + min : '')));
  }

  // Store pickup — global window + packing fee.
  const po = val('#cfg-pickup-open') || '10:00', pc = val('#cfg-pickup-close') || '20:00';
  const pack = Number(val('#cfg-fees-pickupPackingFee')) || 0;
  _dlvStat('dlv-st-pickup', 'ok',
    cuT(po + '–' + pc + (pack > 0 ? ' · packing ¥' + pack : ''),
        '每日 ' + po + '–' + pc + (pack > 0 ? ' · 包装费 ¥' + pack : '')));

  // Holiday mode — mirror the real checkbox onto the hub switch.
  const hol = !!document.getElementById('dlv-holiday-mode')?.checked;
  const hubSw = document.getElementById('dlv-hub-holiday');
  if (hubSw) hubSw.checked = hol;
  if (hol) _dlvStat('dlv-st-holiday', 'warn', cuT('On — same-day delivery paused', '已开启 — 当日达暂停'));
  else _dlvStat('dlv-st-holiday', 'off', cuT('Off — everything running normally', '关闭 — 一切正常'));

  // Fresh batches.
  const bOn = !!document.getElementById('batch-enabled')?.checked;
  const iv = Number(val('#batch-interval')) || 2;
  if (bOn) _dlvStat('dlv-st-fresh', 'ok', cuT('Every ' + iv + ' day' + (iv === 1 ? '' : 's'), '每 ' + iv + ' 天制作一批'));
  else _dlvStat('dlv-st-fresh', 'off', cuT('Off', '关闭'));

  // Carriers — status stashed by loadShippingIntegrations / loadQingyunStores.
  const ship = window._shipStatus || {};
  if (ship.kd100) _dlvStat('dlv-st-kd100', 'ok', cuT('Connected', '已连接'));
  else _dlvStat('dlv-st-kd100', 'off', cuT('Not set up', '未设置'));
  _dlvBtn('dlv-btn-kd100', !!ship.kd100, 'Configure', '配置');

  if (ship.jd) _dlvStat('dlv-st-jd', 'ok', cuT('Connected', '已连接'));
  else if (ship.jdKeys) _dlvStat('dlv-st-jd', 'warn', cuT('In setup — keys saved, test pending', '配置中 — 密钥已存,待测试'));
  else _dlvStat('dlv-st-jd', 'off', cuT('Not set up', '未配置'));
  const jb = document.getElementById('dlv-btn-jd');
  if (jb) {
    jb.textContent = ship.jd ? cuT('Configure', '配置') : (ship.jdKeys ? cuT('Continue setup', '继续设置') : cuT('Set up', '设置'));
    jb.classList.toggle('btn-primary', !ship.jd);
  }

  const qn = Number(window._qyConnected) || 0;
  if (qn > 0) _dlvStat('dlv-st-qy', 'ok', cuT('Connected · ' + qn + ' store' + (qn === 1 ? '' : 's'), '已连接 · ' + qn + ' 家门店'));
  else _dlvStat('dlv-st-qy', 'off', cuT('Not set up', '未开通'));
  _dlvBtn('dlv-btn-qy', qn > 0, 'Configure', '配置');

  // New-tenant vs configured coverage — pickup-first landing until delivery is
  // actually set up (see dlvCoverageRender).
  dlvCoverageRender();
}

// ════════════════════════════════════════════════════════════════
// NEW-TENANT COVERAGE + DELIVERY SET-UP WIZARD
// ════════════════════════════════════════════════════════════════
// A brand-new store shouldn't be dropped into Roots' per-location zone table.
// Until delivery is genuinely configured, the Delivery tab opens on a
// pickup-first landing (pickup on, delivery off) with a 3-question wizard that
// writes real config. Once set up — or for any store that already has zones
// (Roots) — the existing configured hub shows instead. Nothing here is
// store-specific: no hardcoded city, ¥ amount, region or strategy.

// Is delivery genuinely set up? True when the store has any active zone
// (Roots), an enabled national default, or has completed the wizard
// (delivery.enabled). A fresh tenant has none of these → pickup-first landing.
function dlvIsConfigured() {
  const zones = Array.isArray(window._zones) ? window._zones : (typeof _zones !== 'undefined' ? _zones : []);
  if (zones.some(z => z.is_active)) return true;
  if (document.getElementById('dlv-default-enabled')?.checked) return true;
  const cfg = window._deliveryCfg || {};
  return cfg.enabled === true;
}

// Swap the coverage section between the pickup-first landing and the configured
// hub grid. Also fills the pickup card's hours line from the live inputs.
function dlvCoverageRender() {
  const neu = document.getElementById('dlv-coverage-new');
  const std = document.getElementById('dlv-coverage-std');
  if (!neu || !std) return;                       // markup not on this build
  const configured = dlvIsConfigured();
  neu.hidden = configured;
  std.hidden = !configured;

  // Pickup hours line — same source the configured pickup card reads.
  const po = (document.getElementById('cfg-pickup-open')?.value) || '10:00';
  const pc = (document.getElementById('cfg-pickup-close')?.value) || '20:00';
  const pack = Number(document.getElementById('cfg-fees-pickupPackingFee')?.value) || 0;
  const hoursTxt = cuT(po + '–' + pc + (pack > 0 ? ' · packing ¥' + pack : ''),
                       '每日 ' + po + '–' + pc + (pack > 0 ? ' · 包装费 ¥' + pack : ''));
  const nm = document.getElementById('dlv-new-pickup-meta');
  if (nm) nm.textContent = hoursTxt;
  const pm = document.getElementById('dlv-pickup-meta');
  if (pm) pm.textContent = hoursTxt;
}

// ── Wizard state ────────────────────────────────────────────────────────────
let _dlvWizStep = 1;
const _dlvWizPick = { where: null, price: 'flat', when: 'nextday' };

function dlvWizOpen(step) {
  _dlvWizStep = step || 1;
  _dlvWizPick.where = null; _dlvWizPick.price = 'flat'; _dlvWizPick.when = 'nextday';
  const ov = document.getElementById('dlvwiz');
  if (!ov) return;
  ov.classList.add('open');
  ov.setAttribute('aria-hidden', 'false');
  // Reflect the defaults (flat / nextday pre-selected; where forces a choice).
  dlvWizSyncSelected();
  dlvWizPaint();
}
function dlvWizClose() {
  const ov = document.getElementById('dlvwiz');
  if (ov) { ov.classList.remove('open'); ov.setAttribute('aria-hidden', 'true'); }
}

// Mark the .dlvwiz-choice matching each remembered pick as selected.
function dlvWizSyncSelected() {
  document.querySelectorAll('#dlvwiz .dlvwiz-choice').forEach(c => {
    const k = c.getAttribute('data-k'), v = c.getAttribute('data-v');
    c.classList.toggle('sel', _dlvWizPick[k] === v);
  });
}

function dlvWizPick(el) {
  const k = el.getAttribute('data-k'), v = el.getAttribute('data-v');
  _dlvWizPick[k] = v;
  // Clear the other choices for THIS step only (same data-k), then select.
  document.querySelectorAll('#dlvwiz .dlvwiz-choice[data-k="' + k + '"]').forEach(c => c.classList.remove('sel'));
  el.classList.add('sel');
  dlvWizPaint();
}

function dlvWizPaint() {
  for (let i = 1; i <= 3; i++) {
    const body = document.querySelector('#dlvwiz .dlvwiz-body[data-step="' + i + '"]');
    if (body) body.hidden = i !== _dlvWizStep;
    const dot = document.querySelector('#dlvwiz .dlvwiz-steps i[data-s="' + i + '"]');
    if (dot) dot.classList.toggle('done', i <= _dlvWizStep);
  }
  const back = document.getElementById('dlvwiz-back');
  if (back) back.style.visibility = _dlvWizStep > 1 ? 'visible' : 'hidden';
  const next = document.getElementById('dlvwiz-next');
  if (next) {
    const key = ['where', 'price', 'when'][_dlvWizStep - 1];
    next.disabled = !_dlvWizPick[key];             // step 1 forces a pick
    next.textContent = _dlvWizStep === 3 ? cuT('Turn delivery on', '开启配送') : cuT('Continue', '继续');
  }
}

function dlvWizBack() { if (_dlvWizStep > 1) { _dlvWizStep--; dlvWizPaint(); } }
function dlvWizNext() {
  if (_dlvWizStep < 3) { _dlvWizStep++; dlvWizPaint(); return; }
  dlvWizFinish();
}

// Write the wizard's answers as real config. flat / free / city / country all
// resolve through delivery.defaultZone (which the server materializes into a
// live zone), so checkout prices them immediately with no server change.
// 'areas' and 'zones' hand off to the existing zone editor. 'weight' stores a
// weight rule on the default zone for the server to price (see routes/retail).
async function dlvWizFinish() {
  const num = (id, fb) => { const v = parseFloat(document.getElementById(id)?.value); return Number.isFinite(v) ? v : fb; };
  const where = _dlvWizPick.where, price = _dlvWizPick.price, when = _dlvWizPick.when;

  // Build the national default-zone rule from the price answer.
  const dz = { enabled: true, day_only: 1 };
  if (price === 'flat') {
    dz.base_fee = num('dlvwiz-flat', 8);
    dz.free_threshold = num('dlvwiz-free', 0) || null;
  } else if (price === 'free') {
    dz.base_fee = 0; dz.free_threshold = null;
  } else if (price === 'weight') {
    dz.base_fee = num('dlvwiz-w1', 10);          // first-kg fee doubles as the floor
    dz.free_threshold = null;
    dz.weight = { first_kg_fee: num('dlvwiz-w1', 10), extra_kg_fee: num('dlvwiz-wx', 3) };
  } else {
    // 'zones' — per-area pricing; the default zone is a safety net, keep a small flat.
    dz.base_fee = num('dlvwiz-flat', 8);
    dz.free_threshold = null;
  }
  // Lead time + same-day follow the speed answer.
  dz.min_lead_days = (when === 'sameday') ? 0 : (when === 'nextday') ? 1 : (when === 'courier') ? 1 : 0;
  dz.same_day_allowed = (when === 'sameday') ? 1 : 0;
  // "Customer picks a time" wants real time-slots, not the day-only calendar.
  dz.day_only = (when === 'slots') ? 0 : 1;

  const body = {
    'delivery.enabled': true,
    'delivery.coverage': where,                    // city | areas | country
    'delivery.pricingMode': price,                 // flat | weight | free | zones
    'delivery.speed': when,                         // sameday | nextday | courier | slots
  };
  // Only seed the national default zone when the store wants blanket coverage
  // (city / country) with a simple price. Per-area ('areas'/'zones') leaves the
  // default off so unmatched addresses fall to the zone table the user fills in.
  if (where !== 'areas' && price !== 'zones') {
    body['delivery.defaultZone'] = dz;
  }
  // Same-day cutoff + speed labels the customer apps can show.
  if (when === 'sameday') body['delivery.sameDayCutoff'] = (document.getElementById('dlvwiz-cutoff')?.value) || '16:00';

  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    dlvWizClose();
    toast(cuT('Delivery is on', '配送已开启'));
    await loadDeliveryZones();                     // re-read config → flips to configured view
    dlvGo('hub');
    // Route the user straight to the follow-up screen their answer implies.
    if (where === 'areas' || price === 'zones') dlvGo('zones');
  } catch (e) {
    toast(cuT('Save failed', '保存失败') + ': ' + e.message, 'err');
  }
}

// The hub card's switch — writes through to the real checkbox and saves.
async function dlvHubHolidayToggle(el) {
  const cb = document.getElementById('dlv-holiday-mode');
  if (!cb) return;
  cb.checked = el.checked;
  cb.dispatchEvent(new Event('change'));   // keeps the sub-view's ON/OFF label in sync
  try { await saveHolidayMode(); } finally { dlvHubRender(); }
}

// Clicking the Delivery nav item always lands on the hub with fresh statuses.
// (The EN/CN repaint hook registers lazily inside dlvHubRender — onLangChange
// isn't defined yet when this part loads.)
(function () {
  const btn = document.querySelector('.tabs [data-tab="delivery"]');
  if (btn) btn.addEventListener('click', () => dlvGo('hub'));
})();

