/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 02/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: Operations panel (stores, shipping integrations, printers, geocode), command palette (Ctrl+K), visual preview painters, account menu (acct*) */
// ═══════════════════════════════════════════════════════════════════════
// OPERATIONS PANEL (Settings → Operations)
// Integrations moved here from the kitchen app 2026-06-09. The data layer was
// already on /api/retail-admin/*; these functions just drive the UI now. They
// were adapted to this app's theme tokens (--text-1/3, --line, --bg-elev-1).
// ═══════════════════════════════════════════════════════════════════════
function loadOpsPanel() {
  loadOpsStores();
  loadIntegrationsStatus();
  loadShippingIntegrations();
  loadPrinterPrefs();
  loadAlipayManual();
}

// ── Manual-Alipay (静态收款码) fallback card ──────────────────────────────
// Stopgap while 当面付 API access is blocked: operator uploads a static收款码 +
// payee label; customer scans/pays/uploads a screenshot; staff Mark paid.
let _alipayManualQr = null;   // pending data URL from the file picker (null = keep existing)

function _alipayManualChip(enabled) {
  const el = document.getElementById('alipay-manual-chip');
  if (!el) return;
  el.innerHTML = enabled
    ? '<span style="background:#d1fae5;color:#065f46;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✓ LIVE · 已启用</span>'
    : '<span style="background:#fee2e2;color:#991b1b;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✗ OFF · 未启用</span>';
}

async function loadAlipayManual() {
  try {
    const r = await fetch('/api/retail-admin/alipay-manual');
    if (!r.ok) return;
    const d = (await r.json()).data || {};
    const cb = document.getElementById('alipay-manual-enabled');
    const ac = document.getElementById('alipay-manual-account');
    const pv = document.getElementById('alipay-manual-preview');
    if (cb) cb.checked = !!d.enabled;
    if (ac) ac.value = d.account || '';
    if (pv) { if (d.qr) { pv.src = d.qr; pv.style.display = 'block'; } else { pv.removeAttribute('src'); pv.style.display = 'none'; } }
    // OCR sub-fields
    const ocr = document.getElementById('alipay-manual-ocr');
    const af  = document.getElementById('alipay-manual-autoflip');
    const pm  = document.getElementById('alipay-manual-payee');
    const win = document.getElementById('alipay-manual-window');
    const key = document.getElementById('alipay-manual-key');
    if (ocr) ocr.checked = !!d.ocrEnabled;
    if (af)  af.checked = !!d.autoFlip;
    if (pm)  pm.value = d.payeeMatch || '';
    if (win) win.value = d.timeWindowMin || '';
    if (key) {
      key.value = '';
      key.placeholder = d.hasKey ? (d.keyMasked + ' · leave blank to keep · 留空保持不变')
                       : d.serverKeyAvailable ? 'Using the existing server key — leave blank · 已使用服务器密钥,可留空'
                       : 'sk-ant-… · paste once · 粘贴一次';
    }
    _alipayOcrToggle();
    _alipayManualQr = null;   // existing image stays unless operator picks a new one
    _alipayManualChip(!!d.enabled);
  } catch (e) { console.warn('[alipay-manual] load failed', e); }
}

// Show/hide the OCR detail fields with the master OCR checkbox.
function _alipayOcrToggle() {
  const on = !!(document.getElementById('alipay-manual-ocr') || {}).checked;
  const box = document.getElementById('alipay-ocr-fields');
  if (box) box.style.display = on ? 'block' : 'none';
}

function _alipayManualPickFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('Image too large (max 10MB) · 图片过大(最大10MB)', 'error'); event.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    // Downscale the收款码 to a sane size before we ship it. The raw photo can be
    // several MB → its base64 blows past the reverse-proxy body limit and the
    // save dies with a non-JSON 413 ("Save failed"). A QR stays crisp well under
    // 1000px, so a compressed copy is both smaller AND scans fine.
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 1000;
        const scale = Math.min(1, MAX / Math.max(img.naturalWidth || MAX, img.naturalHeight || MAX));
        const w = Math.max(1, Math.round((img.naturalWidth || MAX) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || MAX) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);   // flatten any transparency to white
        ctx.drawImage(img, 0, 0, w, h);
        const out = canvas.toDataURL('image/jpeg', 0.85);
        _alipayManualQr = (out && out.length < reader.result.length) ? out : reader.result;
      } catch (_) {
        _alipayManualQr = reader.result;     // canvas failed → fall back to the raw data URL
      }
      const pv = document.getElementById('alipay-manual-preview');
      if (pv) { pv.src = _alipayManualQr; pv.style.display = 'block'; }
    };
    img.onerror = () => {                     // not decodable as an image → send raw, server validates
      _alipayManualQr = reader.result;
      const pv = document.getElementById('alipay-manual-preview');
      if (pv) { pv.src = _alipayManualQr; pv.style.display = 'block'; }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Persist the manual-Alipay card. Throws Error(friendlyMessage) on failure so
// the shared "Save settings" bar (saveConfig) can surface it — this card no
// longer has its own Save button. Updates the card's chip/status on success and
// emits no toast of its own (the caller toasts once for the whole settings save).
async function saveAlipayManualInline() {
  // Card absent from this build → nothing to save (keeps saveConfig generic).
  if (!document.getElementById('alipay-manual-enabled')) return;
  const val = (id) => ((document.getElementById(id) || {}).value || '').trim();
  const chk = (id) => !!(document.getElementById(id) || {}).checked;
  const status = document.getElementById('alipay-manual-status');
  const body = {
    enabled: chk('alipay-manual-enabled'),
    account: val('alipay-manual-account'),
    ocrEnabled: chk('alipay-manual-ocr'),
    autoFlip: chk('alipay-manual-autoflip'),
    payeeMatch: val('alipay-manual-payee'),
    timeWindowMin: parseInt(val('alipay-manual-window'), 10) || 0,
  };
  // API key only when freshly typed (blank = keep existing server-side).
  const typedKey = val('alipay-manual-key');
  if (typedKey) body.anthropicKey = typedKey;
  // Only send the image when the operator freshly picked one — the server keeps
  // the existing QR when `qr` is absent. Re-sending the previously-saved data URL
  // on every routine save (e.g. just toggling a checkbox) re-uploads the whole
  // image and trips the reverse-proxy body limit → a non-JSON 413 → "Save failed".
  if (_alipayManualQr) body.qr = _alipayManualQr;
  if (status) status.textContent = 'Saving… · 保存中…';
  let r, j;
  try {
    r = await fetch('/api/retail-admin/alipay-manual', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    j = await r.json();
  } catch (e) {
    if (status) status.textContent = '';
    throw new Error('Alipay 收款码: ' + (e.message || 'network error'));
  }
  if (!r.ok || !j.success) {
    const msg = j.error === 'qr_required' ? 'Upload a收款码 image first · 请先上传收款码图片'
              : j.error === 'image_too_big' ? 'Image too large · 图片过大'
              : j.error === 'ocr_key_required' ? 'Enter the Anthropic API key to enable auto-read · 请填写 API 密钥以启用自动识别'
              : j.error === 'bad_image' ? 'Not a valid image · 图片格式无效' : (j.error || 'save failed');
    if (status) status.textContent = '';
    throw new Error(msg);
  }
  if (status) status.textContent = 'Saved ✓ · 已保存';
  _alipayManualQr = null;
  _alipayManualChip(body.enabled);
}

// Backward-compat shim for any direct caller — saves just this card and toasts.
async function _saveAlipayManual() {
  try { await saveAlipayManualInline(); toast('Saved · 已保存', 'success'); }
  catch (e) { toast(e.message || 'Save failed · 保存失败', 'error'); }
}

// ── Stores · 门店 — list + add/edit, online-store self-managed ──
// Mirrors the kitchen app's store editor but lives here so the online store
// is fully independent. Uses the dual-realm /api/retail-admin/stores routes;
// saving an address auto-re-geocodes the store in the background.
let _opsStores = [];
async function loadOpsStores() {
  const box = document.getElementById('ops-stores-list');
  if (!box) return;
  box.innerHTML = 'Loading…';
  try {
    const j = await api('/api/retail-admin/stores');
    _opsStores = (j.data || []).filter(s => s.is_active);
    if (!_opsStores.length) {
      box.innerHTML = '<div style="padding:10px 0;color:var(--text-3)">No stores yet. Add one below. · 暂无门店,请在下方添加。</div>';
      return;
    }
    box.innerHTML = _opsStores.map(s => {
      const loc = [s.city, s.district].filter(Boolean).join(' · ');
      const gps = (s.lat != null && s.lng != null)
        ? '<span style="color:#16a34a">📍 GPS located · 已定位</span>'
        : '<span style="color:#dc2626">⚠ no GPS — set a street address · 未定位,请填写详细地址</span>';
      return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid var(--line)">
        <div style="min-width:0">
          <div><strong style="color:var(--text-1)">${escapeHtml(s.name_en || s.code)}</strong>${s.name_cn ? ` <span style="color:var(--text-3)">· ${escapeHtml(s.name_cn)}</span>` : ''}</div>
          ${loc ? `<div style="color:var(--text-3);font-size:12px;margin-top:2px">${escapeHtml(loc)}</div>` : ''}
          ${s.address ? `<div style="color:var(--text-3);font-size:12px;margin-top:2px">${escapeHtml(s.address)}</div>` : ''}
          <div style="font-size:12px;margin-top:3px">${gps}</div>
        </div>
        <div style="display:flex;gap:8px;flex:none">
          <button class="btn" onclick="_opsStoreStaff(${s.id})">Stock staff · 库存员</button>
          <button class="btn" onclick="_opsStoreEdit(${s.id})">Edit · 编辑</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<span style="color:var(--danger)">Failed to load stores · 加载失败: ${escapeHtml(e.message)}</span>`;
  }
}

function _opsStoreEdit(id) {
  const s = _opsStores.find(x => x.id === id);
  if (s) _opsStoreForm(s);
}

function _opsStoreForm(s) {
  const isEdit = !!s;
  const box = document.getElementById('ops-store-form');
  if (!box) return;
  const val = v => escapeAttr(v == null ? '' : v);
  box.innerHTML = `
    <div style="margin-top:14px;padding:16px;background:var(--bg-elev-1);border:1px solid var(--line);border-radius:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <strong style="color:var(--text-1)">${isEdit ? 'Edit store · 编辑门店' : 'New store · 新建门店'}</strong>
        <button class="btn" style="flex:none" onclick="document.getElementById('ops-store-form').innerHTML=''">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div${isEdit ? '' : ''}>
          <label class="field-label">Code · 短标识 ${isEdit ? '' : '<span style="color:var(--text-3);font-weight:400">— e.g. pudong</span>'}</label>
          <input type="text" id="osf_code" value="${val(s?.code)}" placeholder="pudong" ${isEdit ? 'disabled style="font-family:monospace;opacity:.6"' : 'style="font-family:monospace"'}>
        </div>
        <div><label class="field-label">Phone · 电话</label><input type="text" id="osf_phone" value="${val(s?.phone)}" placeholder="020-XXXXXXXX"></div>
        <div><label class="field-label">Name (EN)</label><input type="text" id="osf_name_en" value="${val(s?.name_en)}" placeholder="Roots — Tianhe"></div>
        <div><label class="field-label">名称 (CN)</label><input type="text" id="osf_name_cn" value="${val(s?.name_cn)}" placeholder="Roots · 天河店"></div>
        <div><label class="field-label">City · 城市</label><input type="text" id="osf_city" value="${val(s?.city)}" placeholder="广州"></div>
        <div><label class="field-label">District · 区</label><input type="text" id="osf_district" value="${val(s?.district)}" placeholder="天河区"></div>
        <div style="grid-column:1 / -1">
          <label class="field-label">Street address · 详细地址 <span style="color:var(--text-3);font-weight:400">— sets the store GPS, auto-geocoded on save · 决定门店 GPS,保存时自动定位</span></label>
          <input type="text" id="osf_address" value="${val(s?.address)}" placeholder="新塘大街3号新塘科创园2栋">
        </div>
        <div style="display:flex;gap:10px">
          <div style="flex:1"><label class="field-label">Opens · 开门</label><input type="time" id="osf_open" value="${val(s?.open_time)}"></div>
          <div style="flex:1"><label class="field-label">Closes · 关门</label><input type="time" id="osf_close" value="${val(s?.close_time)}"></div>
        </div>
        <div><label class="field-label">Sort priority · 排序 <span style="color:var(--text-3);font-weight:400">(lower = preferred)</span></label><input type="number" id="osf_sort" value="${s?.sort_order ?? 0}"></div>
        <div><label class="field-label">Low-stock alert at · 低库存提醒 <span style="color:var(--text-3);font-weight:400">— flag this store's items low at this many units. Blank = store-wide default. · 门店商品降到此数量时提醒;留空用全店默认。</span></label><input type="number" min="0" id="osf_low_stock" value="${s?.low_stock_threshold ?? ''}" placeholder="Store default · 全店默认"></div>
        <div style="display:flex;align-items:flex-end;padding-bottom:6px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text-1)">
            <input type="checkbox" id="osf_pickup" ${s?.pickup_enabled ? 'checked' : ''} style="width:16px;height:16px">${pickupIcon(13)} Offer store pickup · 到店自提
          </label>
        </div>
      </div>
      <div style="margin-top:12px;padding:12px;background:rgba(204,217,0,.06);border:1px dashed var(--line);border-radius:8px">
        <label class="field-label">📍 GPS coordinates · 经纬度 <span style="color:var(--text-3);font-weight:400">— optional manual override. <strong>Leave blank to auto-locate from the address on save.</strong> Only fill these to pin an exact spot; get coords at <a href="https://lbs.qq.com/getPoint/" target="_blank" style="color:var(--accent)">lbs.qq.com/getPoint</a>. · 留空则保存时按地址自动定位;仅在需要精确指定时填写。</span></label>
        ${(s && s.lat != null && s.lng != null) ? `<div style="font-size:12px;color:var(--text-3);margin:6px 0 8px">Current · 当前: <code>${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}</code></div>` : ''}
        <div style="display:flex;gap:10px;margin-top:6px">
          <input type="number" step="0.000001" id="osf_lat" value="" placeholder="Latitude 纬度 23.1519" style="flex:1">
          <input type="number" step="0.000001" id="osf_lng" value="" placeholder="Longitude 经度 113.4061" style="flex:1">
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn btn-primary" onclick="_opsStoreSave(${isEdit ? s.id : 'null'})">Save · 保存</button>
        <button class="btn" onclick="document.getElementById('ops-store-form').innerHTML=''">Cancel · 取消</button>
      </div>
    </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function _opsStoreSave(id) {
  const v = sel => (document.getElementById(sel).value || '').trim();
  const body = {
    name_en: v('osf_name_en'), name_cn: v('osf_name_cn'),
    city: v('osf_city'), district: v('osf_district'),
    address: v('osf_address'), phone: v('osf_phone'),
    sort_order: +document.getElementById('osf_sort').value || 0,
    pickup_enabled: document.getElementById('osf_pickup').checked,
    open_time: v('osf_open') || null, close_time: v('osf_close') || null,
    // Blank clears the override → store falls back to the tenant-wide default.
    low_stock_threshold: v('osf_low_stock') === '' ? null : (parseInt(v('osf_low_stock'), 10) || 0),
  };
  const latRaw = v('osf_lat'), lngRaw = v('osf_lng');
  if (latRaw && lngRaw) {
    // Manual override supplied → send explicit coords (backend skips geocoding).
    const lat = parseFloat(latRaw), lng = parseFloat(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return toast('Invalid coordinates · 坐标无效', 'error');
    }
    body.lat = lat; body.lng = lng;
  }
  // Else: omit lat/lng entirely so the backend re-geocodes from the address
  // (touchedAddr && !explicitLatLng). Never send lat:null here — that would
  // both wipe the coords AND suppress the re-geocode.
  if (!id) {
    body.code = v('osf_code');
    if (!body.code) return toast('Code required · 请填写编号', 'error');
  }
  try {
    await api(id ? `/api/retail-admin/stores/${id}` : '/api/retail-admin/stores', { method: id ? 'PATCH' : 'POST', body });
    toast('Saved · 已保存', 'success');
    document.getElementById('ops-store-form').innerHTML = '';
    loadOpsStores();
    loadIntegrationsStatus();
    // Address saves re-geocode in the background; refresh again shortly so the
    // 📍 GPS badge updates without a manual reload.
    setTimeout(loadOpsStores, 2500);
  } catch (e) { toast('Failed · 操作失败: ' + e.message, 'error'); }
}

// ── Per-store stock staff · 库存员 ──────────────────────────────────────────
// A stock clerk added here can ONLY use the Quick Stock app, locked to THIS
// store — they can never see or change another store's stock. Managed via the
// tenant-scoped /api/backend/stores/:id/staff endpoints.
async function _opsStoreStaff(storeId) {
  const store = _opsStores.find(x => x.id === storeId);
  const box = document.getElementById('ops-store-staff');
  if (!box || !store) return;
  // Toggle closed if this store's panel is already open.
  if (box.dataset.store === String(storeId) && box.innerHTML) { box.innerHTML = ''; box.dataset.store = ''; return; }
  box.dataset.store = String(storeId);
  box.innerHTML = '<div style="margin-top:14px;color:var(--text-3)">Loading…</div>';
  document.getElementById('ops-store-form').innerHTML = '';
  try {
    const j = await api(`/api/backend/stores/${storeId}/staff`);
    _opsStoreStaffRender(store, j.staff || []);
  } catch (e) {
    box.innerHTML = `<div style="margin-top:14px;color:var(--danger)">Failed to load staff · 加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function _opsStoreStaffRender(store, staff) {
  const box = document.getElementById('ops-store-staff');
  if (!box) return;
  const name = escapeHtml(store.name_en || store.code);
  const active = staff.filter(u => u.isActive);
  const rows = active.length ? active.map(u => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)">
      <div style="min-width:0">
        <div style="color:var(--text-1)"><strong>${escapeHtml(u.displayName || u.username)}</strong></div>
        <div style="color:var(--text-3);font-size:12px;font-family:monospace">${escapeHtml(u.username)}</div>
      </div>
      <div style="display:flex;gap:8px;flex:none">
        <button class="btn" onclick="_opsStoreStaffResetPw(${store.id},${u.id})">Reset password · 重置密码</button>
        <button class="btn" onclick="_opsStoreStaffRemove(${store.id},${u.id})">Remove · 移除</button>
      </div>
    </div>`).join('')
    : '<div style="padding:10px 0;color:var(--text-3)">No stock staff yet for this store. · 该门店暂无库存员。</div>';
  box.innerHTML = `
    <div style="margin-top:14px;padding:16px;background:var(--bg-elev-1);border:1px solid var(--line);border-radius:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="color:var(--text-1)">Stock staff · 库存员 — ${name}</strong>
        <button class="btn" style="flex:none" onclick="document.getElementById('ops-store-staff').innerHTML='';document.getElementById('ops-store-staff').dataset.store=''">✕</button>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">These people can only open the Quick Stock app, and only for <strong>${name}</strong> — never another store. · 这些成员仅可使用快捷库存,且只能操作<strong>${name}</strong>,无法操作其他门店。</div>
      ${rows}
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line);display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><label class="field-label">Name · 姓名</label><input type="text" id="oss_name" placeholder="张三"></div>
        <div><label class="field-label">Login · 登录名 <span style="color:var(--text-3);font-weight:400">— letters/numbers . _ -</span></label><input type="text" id="oss_user" placeholder="yuexiu.stock" style="font-family:monospace"></div>
        <div style="grid-column:1 / -1"><label class="field-label">Password · 密码 <span style="color:var(--text-3);font-weight:400">— at least 10 characters · 至少 10 位</span></label><input type="text" id="oss_pw" placeholder="••••••••••"></div>
      </div>
      <div style="margin-top:12px"><button class="btn btn-primary" onclick="_opsStoreStaffAdd(${store.id})">+ Add stock staff · 添加库存员</button></div>
    </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function _opsStoreStaffAdd(storeId) {
  const name = (document.getElementById('oss_name').value || '').trim();
  const username = (document.getElementById('oss_user').value || '').trim();
  const password = (document.getElementById('oss_pw').value || '').trim();
  if (!username) return toast('Login required · 请填写登录名', 'error');
  if (password.length < 10) return toast('Password must be at least 10 characters · 密码至少需要 10 位', 'error');
  try {
    await api(`/api/backend/stores/${storeId}/staff`, { method: 'POST', body: { display_name: name, username, password } });
    toast('Added · 已添加', 'success');
    const store = _opsStores.find(x => x.id === storeId);
    const j = await api(`/api/backend/stores/${storeId}/staff`);
    if (store) _opsStoreStaffRender(store, j.staff || []);
  } catch (e) { toast('Failed · 操作失败: ' + e.message, 'error'); }
}

async function _opsStoreStaffRemove(storeId, userId) {
  if (!confirm('Remove this stock staff member? They will lose access immediately. · 移除该库存员?其访问权限将立即失效。')) return;
  try {
    await api(`/api/backend/stores/${storeId}/staff/${userId}`, { method: 'DELETE' });
    toast('Removed · 已移除', 'success');
    const store = _opsStores.find(x => x.id === storeId);
    const j = await api(`/api/backend/stores/${storeId}/staff`);
    if (store) _opsStoreStaffRender(store, j.staff || []);
  } catch (e) { toast('Failed · 操作失败: ' + e.message, 'error'); }
}

async function _opsStoreStaffResetPw(storeId, userId) {
  const np = (prompt('New password (at least 10 characters) · 新密码(至少 10 位)') || '').trim();
  if (!np) return;
  if (np.length < 10) return toast('Password must be at least 10 characters · 密码至少需要 10 位', 'error');
  try {
    await api(`/api/backend/stores/${storeId}/staff/${userId}/password`, { method: 'POST', body: { new_password: np } });
    toast('Password reset · 密码已重置', 'success');
  } catch (e) { toast('Failed · 操作失败: ' + e.message, 'error'); }
}

// ── Shipping integrations: kd100 + JD LOP + Feie credentials & status chips ──
async function loadShippingIntegrations() {
  try {
    const r = await fetch('/api/retail-admin/integrations');
    if (!r.ok) return;
    const j = await r.json();
    const k = j.data?.kd100 || {};
    const d = j.data?.jd || {};
    const kCust = document.getElementById('kd100-customer');
    const kKey  = document.getElementById('kd100-key');
    const kCb   = document.getElementById('kd100-callback');
    const kSec  = document.getElementById('kd100-secret');
    if (kCust) kCust.value = k.customer || '';
    if (kKey)  kKey.placeholder      = k.key_masked    ? `${k.key_masked} · leave blank to keep · 留空则保持不变` : 'paste 授权 key · 粘贴授权 key';
    if (kCb && k.callback) kCb.value = k.callback;
    if (kSec) kSec.placeholder       = k.secret_masked ? `${k.secret_masked} · leave blank to keep · 留空则保持不变` : 'random string — do not rotate · 随机字符串,请勿更换';
    const kChip = document.getElementById('kd100-chip');
    if (kChip) kChip.innerHTML = k.enabled
      ? '<span style="background:#d1fae5;color:#065f46;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✓ LIVE · 已启用</span>'
      : '<span style="background:#fee2e2;color:#991b1b;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✗ NOT CONFIGURED · 未配置</span>';
    const kDot = document.getElementById('kd100-dot');
    if (kDot) kDot.style.background = k.enabled ? '#10b981' : 'var(--text-3)';

    const jAk = document.getElementById('jd-app_key');
    const jAs = document.getElementById('jd-app_secret');
    const jAt = document.getElementById('jd-access_token');
    const jCc = document.getElementById('jd-customer_code');
    const jEv = document.getElementById('jd-env');
    if (jAk) jAk.value = d.app_key || '';
    if (jAs) jAs.placeholder = d.app_secret_masked   ? `${d.app_secret_masked} · leave blank to keep · 留空保持不变`   : 'paste app_secret · 粘贴 app_secret';
    if (jAt) jAt.placeholder = d.access_token_masked ? `${d.access_token_masked} · leave blank to keep · 留空保持不变` : 'paste access_token · 粘贴 access_token';
    if (jCc) jCc.value = d.customer_code || '';
    if (jEv) jEv.value = d.env || 'production';
    const jChip = document.getElementById('jd-chip');
    if (jChip) jChip.innerHTML = d.enabled
      ? '<span style="background:#d1fae5;color:#065f46;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✓ LIVE · 已启用</span>'
      : '<span style="background:#fef3c7;color:#92400e;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">⏳ PENDING JD ACCOUNT · 待开通京东账号</span>';
    const jDot = document.getElementById('jd-dot');
    if (jDot) jDot.style.background = d.enabled ? '#10b981' : '#f59e0b';

    // Stash the carrier states for the Delivery hub cards (06-delivery.js).
    window._shipStatus = { kd100: !!k.enabled, jd: !!d.enabled, jdKeys: !!d.app_key };
    if (typeof dlvHubRender === 'function') dlvHubRender();

    const f = j.data?.feie || {};
    const fUser = document.getElementById('feie-user');
    const fUkey = document.getElementById('feie-ukey');
    if (fUser) fUser.value = f.user || '';
    if (fUkey) fUkey.placeholder = f.ukey_masked ? `${f.ukey_masked} · leave blank to keep · 留空保持不变` : 'paste USERKEY from dev console · 从开发者后台粘贴 USERKEY';
    const fChip = document.getElementById('feie-chip');
    if (fChip) fChip.innerHTML = f.enabled
      ? '<span style="background:#d1fae5;color:#065f46;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✓ LIVE · 已启用</span>'
      : '<span style="background:#fee2e2;color:#991b1b;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✗ NOT CONFIGURED · 未配置</span>';
    loadQingyunStores();  // same-city (Qingyun) per-store status + tab dot
  } catch (e) { console.warn('[integrations] load failed', e); }
}

// Logistics card: toggle between the 快递100 / 京东物流 / 同城配送 panels.
function _logTab(which) {
  ['kd100', 'jd', 'qy'].forEach(k => {
    const panel = document.getElementById('logpanel-' + k);
    const tab   = document.getElementById('logtab-' + k);
    if (panel) panel.style.display = (k === which) ? '' : 'none';
    if (tab)   tab.classList.toggle('active', k === which);
  });
  if (which === 'qy') loadQingyunStores();
}

// Same-city (青云聚信) tab: render one row per store with a live status pill.
// Qingyun is ops-provisioned per store (fingerprint-gated login, no API key), so
// un-connected stores get a "Request setup" button that pages ops.
async function loadQingyunStores() {
  const box = document.getElementById('qy-stores');
  if (!box) return;
  try {
    const r = await fetch('/api/retail-admin/integrations/qingyun');
    if (!r.ok) { box.innerHTML = ''; return; }
    const j = await r.json();
    const stores = j.data || [];
    const qDot = document.getElementById('qy-dot');
    if (qDot) qDot.style.background = stores.some(s => s.connected) ? '#10b981' : 'var(--text-3)';
    // Auto-push toggle — only meaningful (shown) once at least one store is connected.
    const apRow = document.getElementById('qy-autopush-row');
    const apBox = document.getElementById('qy-autopush');
    if (apRow) apRow.style.display = j.anyConnected ? 'flex' : 'none';
    if (apBox) apBox.checked = j.autoPush === true;
    // Stash for the Delivery hub's Qingyun card status line.
    window._qyConnected = stores.filter(s => s.connected).length;
    if (typeof dlvHubRender === 'function') dlvHubRender();
    if (!stores.length) { box.innerHTML = '<div class="muted">No active stores yet. · 暂无门店。</div>'; return; }
    box.innerHTML = stores.map(s => {
      const nm = [s.name_en || s.code, s.name_cn].filter(Boolean).join(' · ');
      const pill = s.connected
        ? '<span style="background:#d1fae5;color:#065f46;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✓ Connected · 已连接</span>'
        : '<span style="background:#fee2e2;color:#991b1b;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✗ Not set up · 未开通</span>';
      const btn = s.connected ? ''
        : `<button class="btn" onclick="_requestQingyun('${s.code}', this)">Request setup · 申请开通</button>`;
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)">
        <div style="font-weight:600">${nm}</div>
        <div style="display:flex;align-items:center;gap:10px">${pill}${btn}</div>
      </div>`;
    }).join('');
  } catch (e) { box.innerHTML = ''; }
}

// Ask ops to connect same-city tracking for one store.
async function _requestQingyun(storeCode, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Sending… · 提交中…'; }
  try {
    const r = await fetch('/api/retail-admin/integrations/qingyun/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_code: storeCode }),
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(j.error || 'HTTP ' + r.status);
    toast('Request sent — we will set it up · 已收到申请,我们会为你开通', 'success');
    if (btn) btn.textContent = 'Requested · 已申请';
  } catch (e) {
    toast('Failed · 操作失败: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Request setup · 申请开通'; }
  }
}

// Turn auto-send-to-Qingyun on/off. When on, paid delivery orders auto-create in
// the store's Qingyun 待配送 list (staff still pick the carrier).
async function _setQingyunAutoPush(on) {
  try {
    const r = await fetch('/api/retail-admin/integrations/qingyun/autopush', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!on }),
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(j.error || 'HTTP ' + r.status);
    toast(on ? 'Auto-send on · 已开启自动发单' : 'Auto-send off · 已关闭', 'success');
  } catch (e) {
    toast('Failed · 操作失败: ' + e.message, 'error');
    const apBox = document.getElementById('qy-autopush');
    if (apBox) apBox.checked = !on;  // revert on failure
  }
}

// Printer card: switch between per-store printer panels (all stay configurable & save together).
function _printerTab(storeId) {
  document.querySelectorAll('#feie-stores [id^="ppanel-"]').forEach(panel => {
    panel.style.display = (panel.id === 'ppanel-' + storeId) ? 'block' : 'none';
  });
  document.querySelectorAll('#feie-stores .dz-subtab').forEach(tab => {
    tab.classList.toggle('active', tab.id === 'ptab-' + storeId);
  });
}

// Printer behaviour prefs + one row per store (SN + template + copies).
const _FEIE_TEMPLATES = [
  { id: 'receipt', label: 'Customer receipt · 顾客小票' },
  { id: 'packing', label: 'Packing slip · 配货单' },
  { id: 'compact', label: 'Compact · 精简' },
];

async function loadPrinterPrefs() {
  try {
    const r = await fetch('/api/retail-admin/printer');
    if (!r.ok) return;
    const p = (await r.json()).data || {};
    const auto = document.getElementById('feie-auto');
    const autoAddon = document.getElementById('feie-auto-addon');
    const autoRefund = document.getElementById('feie-auto-refund');
    const shop = document.getElementById('feie-shop');
    if (auto) auto.checked = p.auto_print !== false;
    if (autoAddon) autoAddon.checked = p.auto_print_addon !== false;
    if (autoRefund) autoRefund.checked = p.auto_print_refund !== false;
    if (shop) shop.value = p.shop_name || '';

    const box = document.getElementById('feie-stores');
    if (box) {
      const stores = p.stores || [];
      if (!stores.length) {
        box.innerHTML = '<div style="font-size:13px;color:var(--text-3)">No active stores. Add stores under Stores first. · 暂无门店,请先添加门店。</div>';
      } else {
        const tabs = stores.map((s, i) => {
          const tabName = escapeHtml((window.cuLang && cuLang() === 'cn')
            ? (s.name_cn || s.name_en || s.code || ('Store ' + s.id))
            : (s.name_en || s.name_cn || s.code || ('Store ' + s.id)));
          const lit = !!(s.sn && String(s.sn).trim());
          return `<button type="button" class="dz-subtab${i === 0 ? ' active' : ''}" id="ptab-${s.id}" onclick="_printerTab(${s.id})"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${lit ? '#10b981' : 'var(--text-3)'};margin-right:7px;vertical-align:middle"></span>${tabName}</button>`;
        }).join('');
        const panels = stores.map((s, i) => {
          const nameCn = escapeHtml(s.name_cn || '');
          const nameEn = escapeHtml(s.name_en || '');
          const primary = nameCn || nameEn || escapeHtml(s.code || ('Store ' + s.id));
          const secondary = (nameCn && nameEn) ? nameEn : '';
          const codeTag = s.code ? ` <span style="font-weight:600;font-size:11px;color:var(--text-3)">#${escapeHtml(s.code)}</span>` : '';
          const opts = _FEIE_TEMPLATES.map(t => `<option value="${t.id}" ${s.template===t.id?'selected':''}>${t.label}</option>`).join('');
          return `
          <div data-store="${s.id}" id="ppanel-${s.id}" style="display:${i === 0 ? 'block' : 'none'};border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--bg-elev-1)">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;color:var(--text-1)">🏪 ${primary}${secondary ? ` <span style="font-weight:600;font-size:12px;color:var(--text-3)">${secondary}</span>` : ''}${codeTag}</div>
            <div style="display:grid;grid-template-columns:2fr 1.4fr 0.8fr;gap:10px;align-items:end">
              <div>
                <label style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);display:block;margin-bottom:3px">Printer SN · 编号</label>
                <input type="text" class="feie-store-sn" value="${escapeHtml(s.sn)}" style="width:100%;font-family:monospace;font-size:12px;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg-input);color:var(--text-1)" placeholder="e.g. 550540977">
              </div>
              <div>
                <label style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);display:block;margin-bottom:3px">Template · 模板</label>
                <select class="feie-store-tpl" onchange="_previewStore(${s.id})" style="width:100%;font-size:12px;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg-input);color:var(--text-1)">${opts}</select>
              </div>
              <div>
                <label style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);display:block;margin-bottom:3px">Copies · 份数</label>
                <input type="number" class="feie-store-copies" min="1" max="5" value="${Number(s.copies)||1}" style="width:100%;font-size:12px;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg-input);color:var(--text-1)">
              </div>
            </div>
            <div style="margin-top:10px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
              <div style="flex:0 0 auto">
                <div style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);margin-bottom:5px">Print preview · 打印预览</div>
                <div id="feie-prev-${s.id}" class="feie-prev"><div style="color:var(--text-3);font-size:12px">Loading preview…</div></div>
              </div>
              <div style="flex:1 1 160px;min-width:140px">
                <button class="btn" style="font-size:12px;padding:5px 12px" onclick="_testPrinter(${s.id})">🖨 Save &amp; test this store · 保存并测试本店</button>
                <div style="font-size:11px;color:var(--text-3);margin-top:8px;line-height:1.5">The preview shows your latest order in this template (or sample data if none yet). Change the template above to compare. · 预览即真实打印效果</div>
              </div>
            </div>
          </div>`;
        }).join('');
        box.innerHTML = (stores.length > 1
          ? `<div class="dz-subtabs" role="tablist" style="margin-bottom:16px">${tabs}</div>`
          : '') + panels;
        stores.forEach(s => _previewStore(s.id));
      }
      const ooc = document.getElementById('feie-ooc');
      if (ooc) {
        const sel = p.out_of_city_store_id;
        ooc.innerHTML =
          '<option value="">— Use each order’s own store · 按订单所属门店 —</option>' +
          stores.map(s => {
            const name = escapeHtml(s.name_cn || s.name_en || s.code || ('Store ' + s.id));
            return `<option value="${s.id}" ${String(sel)===String(s.id)?'selected':''}>${name}</option>`;
          }).join('');
      }
    }
  } catch (e) { console.warn('[printer] load failed', e); }
}

// Faux 58mm thermal-paper render of Feieyun markup so the operator sees roughly
// how the slip prints. Tags wrap a whole line: <CB> center+enlarge · <B> enlarge
// · <L> double-height · <BOLD> bold · <C> center
function _renderThermal(content) {
  const lines = String(content == null ? '' : content).replace(/\s+$/, '').split('\n');
  return lines.map(line => {
    let cls = '', inner = line;
    const m = line.match(/^<(CB|B|L|BOLD|C)>([\s\S]*)<\/\1>$/);
    if (m) {
      inner = m[2];
      cls = ({ CB:'tc tbig', B:'tbig', L:'ttall', BOLD:'tbold', C:'tc' })[m[1]] || '';
    }
    inner = inner.replace(/<\/?(CB|B|L|BOLD|C)>/g, '');
    if (inner === '') return '<div class="tln"> </div>';
    return `<div class="tln ${cls}">${escapeHtml(inner)}</div>`;
  }).join('');
}

async function _previewStore(storeId) {
  const box = document.getElementById('feie-prev-' + storeId);
  if (!box) return;
  const row = document.querySelector('#feie-stores [data-store="' + storeId + '"]');
  const tpl = row?.querySelector('.feie-store-tpl')?.value || 'receipt';
  try {
    const r = await fetch('/api/retail-admin/printer/preview?store_id=' + storeId + '&template=' + encodeURIComponent(tpl));
    const j = await r.json();
    if (!j.ok) { box.innerHTML = '<div style="color:var(--text-3);font-size:12px">No preview available · 暂无预览</div>'; return; }
    box.innerHTML =
      `<div class="thermal">${_renderThermal(j.content)}</div>` +
      `<div style="font-size:11px;color:var(--text-3);margin-top:6px;text-align:center;max-width:230px">${
        j.sample ? 'Sample data · 示例数据' : 'Your latest order · 最近订单'}</div>`;
  } catch { box.innerHTML = '<div style="color:var(--text-3);font-size:12px">Preview failed · 预览失败</div>'; }
}

function _collectPrinterByStore() {
  const by_store = {};
  document.querySelectorAll('#feie-stores [data-store]').forEach(row => {
    const id = row.getAttribute('data-store');
    by_store[id] = {
      sn:       row.querySelector('.feie-store-sn')?.value.trim() || '',
      template: row.querySelector('.feie-store-tpl')?.value || 'receipt',
      copies:   parseInt(row.querySelector('.feie-store-copies')?.value, 10) || 1,
    };
  });
  return by_store;
}

async function _savePrinter() {
  await _saveIntegration('feie');
  try {
    const body = {
      auto_print: document.getElementById('feie-auto')?.checked,
      auto_print_addon: document.getElementById('feie-auto-addon')?.checked,
      auto_print_refund: document.getElementById('feie-auto-refund')?.checked,
      shop_name:  document.getElementById('feie-shop')?.value || '',
      by_store:   _collectPrinterByStore(),
      out_of_city_store_id: document.getElementById('feie-ooc')?.value || null,
    };
    const r = await fetch('/api/retail-admin/printer', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('✅ Printer settings saved · 已保存', 'success');
    loadPrinterPrefs();
  } catch (e) { toast('Failed · 操作失败: ' + e.message, 'error'); }
}

async function _testPrinter(storeId) {
  await _savePrinter();
  try {
    const r = await fetch('/api/retail-admin/printer/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ store_id: storeId }),
    });
    const j = await r.json();
    if (j.ok) toast('🖨 Test sent — check that store\'s printer · 已发送', 'success');
    else      toast('Print failed · 打印失败: ' + (j.error || 'unknown'), 'error');
  } catch (e) { toast('Test failed · 测试失败: ' + e.message, 'error'); }
}

async function _saveIntegration(svc) {
  // Empty string for password fields = "keep current" (backend treats undefined
  // as keep, null/"" as clear).
  const v = (id) => document.getElementById(id)?.value;
  const payload = {};
  if (svc === 'kd100') {
    payload.kd100 = {
      customer: v('kd100-customer').trim() || null,
      key:      v('kd100-key') || undefined,
      callback: v('kd100-callback').trim() || null,
      secret:   v('kd100-secret') || undefined,
    };
  } else if (svc === 'jd') {
    payload.jd = {
      app_key:       v('jd-app_key').trim() || null,
      app_secret:    v('jd-app_secret') || undefined,
      access_token:  v('jd-access_token') || undefined,
      customer_code: v('jd-customer_code').trim() || null,
      env:           v('jd-env') || 'production',
    };
  } else if (svc === 'feie') {
    payload.feie = {
      user: v('feie-user').trim() || null,
      ukey: v('feie-ukey') || undefined,
    };
  }
  try {
    const r = await fetch('/api/retail-admin/integrations', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'save failed');
    toast(`✅ Saved ${svc} · 已保存`, 'success');
    if (svc === 'kd100') { document.getElementById('kd100-key').value = ''; document.getElementById('kd100-secret').value = ''; }
    if (svc === 'jd')    { document.getElementById('jd-app_secret').value = ''; document.getElementById('jd-access_token').value = ''; }
    if (svc === 'feie')  { document.getElementById('feie-ukey').value = ''; }
    loadShippingIntegrations();
  } catch (e) { toast('Failed · 操作失败: ' + e.message, 'error'); }
}

async function _testKd100() {
  await _saveIntegration('kd100');
  try {
    const r = await fetch('/api/retail-admin/integrations/kd100/test', { method: 'POST' });
    const j = await r.json();
    if (j.ok) toast('✅ 快递100 reachable · auth OK · 连接正常', 'success');
    else      toast('快递100 测试失败: ' + (j.error || 'unknown'), 'error');
  } catch (e) { toast('Test failed · 测试失败: ' + e.message, 'error'); }
}

async function _testJd() {
  await _saveIntegration('jd');
  try {
    const r = await fetch('/api/retail-admin/integrations/jd/test', { method: 'POST' });
    const j = await r.json();
    if (j.ok) {
      toast('✅ JD reachable · auth OK · 连接正常', 'success');
      if (j.note && /customercode|商家编码/i.test(j.note)) toast('Next: enter CUSTOMER_CODE (商家编码) to enable waybill push · 还需填写商家编码', 'info');
    } else toast('JD ping failed · 连接失败: ' + (j.error || 'unknown'), 'error');
  } catch (e) { toast('Test failed · 测试失败: ' + e.message, 'error'); }
}

async function _geocodeBackfill() {
  if (!confirm('Geocode all stores + customer addresses now? Uses your maps quota. · 现在为所有门店与客户地址重新定位?将消耗地图配额。')) return;
  try {
    toast('Geocoding… · 定位中…', 'info');
    const r = await fetch('/api/retail-admin/inventory/geocode-backfill', { method: 'POST' });
    const j = await r.json();
    if (!r.ok || j.success === false) {
      const err = j.error || ('HTTP ' + r.status);
      toast((err === 'tencent_maps_key_missing' || err === 'maps_key_missing')
        ? 'Set AMAP_MAPS_KEY or TENCENT_MAPS_KEY in /root/roots-v2/.env first · 请先在 /root/roots-v2/.env 配置地图 key'
        : 'Failed: ' + err, 'error');
      return;
    }
    const d = j.data || {};
    if (d.aborted_on_quota || (d.last_error && d.last_error.quota)) {
      toast('🚫 Daily map quota exhausted — geocoding stopped. Fix the key (see panel), quota resets next day. · 地图配额已用尽,已停止。请修复 key,次日重置。', 'error');
    } else if (d.addresses_total > 0 && d.addresses_geocoded === 0 && d.last_error) {
      toast('⚠ Could not geocode addresses · 地址定位失败: ' + (d.last_error.message || d.last_error.code), 'error');
    } else {
      toast(`✅ Geocoded ${d.stores_geocoded}/${d.stores_total} stores · ${d.addresses_geocoded}/${d.addresses_total} addresses · 已定位 门店与地址`, 'success');
    }
    loadIntegrationsStatus();
  } catch (e) { toast('Failed · 操作失败: ' + e.message, 'error'); }
}

// ── GZ-express excluded districts ──
// All 11 official Guangzhou districts as a multi-select. Clicking a chip toggles
// it between "included" (5-option modal eligible) and "excluded" (legacy yes/no
// modal). Saves on every click; caches the current list in _gzExclSet.
const GZ_DISTRICTS = [
  { code: '越秀区', en: 'Yuexiu' },
  { code: '海珠区', en: 'Haizhu' },
  { code: '荔湾区', en: 'Liwan' },
  { code: '天河区', en: 'Tianhe' },
  { code: '白云区', en: 'Baiyun' },
  { code: '黄埔区', en: 'Huangpu' },
  { code: '番禺区', en: 'Panyu' },
  { code: '花都区', en: 'Huadu' },
  { code: '南沙区', en: 'Nansha' },
  { code: '从化区', en: 'Conghua' },
  { code: '增城区', en: 'Zengcheng' },
];
let _gzExclSet = new Set();
async function _loadGzExcludedDistricts() {
  try {
    const r = await fetch('/api/retail-admin/config/gz-excluded-districts');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    _gzExclSet = new Set(j.data || []);
    _paintGzExclChips();
  } catch (e) {
    toast('Failed to load · 加载失败: ' + e.message, 'error');
  }
}
function _paintGzExclChips() {
  const wrap = document.getElementById('gz-excl-chips');
  if (!wrap) return;
  wrap.innerHTML = GZ_DISTRICTS.map(d => {
    const on = _gzExclSet.has(d.code);
    return `<button onclick="_toggleGzExclDistrict('${d.code}')" style="
      display:inline-flex;align-items:center;gap:6px;
      padding:7px 14px;border-radius:99px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;
      border:1.5px solid ${on ? '#dc2626' : 'var(--line)'};
      background:${on ? 'rgba(220,38,38,.08)' : 'var(--bg-elev-1)'};
      color:${on ? '#dc2626' : 'var(--text-1)'};
      transition:all .12s;
    ">${on ? '🚫' : '✓'} ${d.code} · ${d.en}</button>`;
  }).join('');
  const summary = document.getElementById('gz-excl-summary');
  if (summary) {
    const n = _gzExclSet.size;
    summary.textContent = n === 0
      ? 'All 11 districts get the 5-option modal. · 全部 11 区使用 5 选项弹窗。'
      : `${n} district${n === 1 ? '' : 's'} excluded · ${n} 个区已排除${ n === GZ_DISTRICTS.length ? ' (no district gets the 5-option modal)' : ''}`;
  }
}
async function _toggleGzExclDistrict(code) {
  if (_gzExclSet.has(code)) _gzExclSet.delete(code);
  else                       _gzExclSet.add(code);
  _paintGzExclChips();
  const districts = Array.from(_gzExclSet);
  try {
    const r = await fetch('/api/retail-admin/config/gz-excluded-districts', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ districts }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('Saved · 已保存', 'success');
  } catch (e) {
    if (districts.includes(code)) _gzExclSet.delete(code); else _gzExclSet.add(code);
    _paintGzExclChips();
    toast('Failed · 操作失败: ' + e.message, 'error');
  }
}

// ── Order routing status — Tencent Maps key + geocode counts ──
async function loadIntegrationsStatus() {
  const box = document.getElementById('integrations-status');
  if (!box) return;
  box.innerHTML = 'Loading…';
  try {
    const r = await fetch('/api/retail-admin/inventory/geocode-status');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const d = j.data || {};
    const cfg = d.tencent_maps_configured;
    const s = d.stores || { total: 0, missing: 0, geocoded: 0 };
    const a = d.addresses || { total: 0, missing: 0, geocoded: 0 };
    const provLabel = d.provider === 'amap' ? '高德 / Amap' : d.provider === 'tencent' ? '腾讯 / Tencent' : 'Maps';
    const keyChip = cfg
      ? '<span style="background:#d1fae5;color:#065f46;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✓ KEY CONFIGURED · 已配置密钥</span>'
      : '<span style="background:#fee2e2;color:#991b1b;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✗ KEY MISSING · 缺少密钥</span>';
    const pct = (got, tot) => tot === 0 ? '—' : `${got}/${tot}`;
    // Surface the real provider error (esp. quota) so 0/41 isn't a mystery.
    const le = d.last_error;
    let errBox = '';
    if (le && le.quota) {
      errBox = `<div style="margin-top:10px;padding:8px 12px;background:#fee2e2;color:#991b1b;border-radius:6px;font-size:12px">🚫 <strong>Daily quota exhausted</strong> on ${escapeHtml(provLabel)} (${escapeHtml(String(le.code))}: ${escapeHtml(le.message || '')}). Coordinates can't be fetched until quota resets or you switch to a real-name-verified / higher-quota key. · 当日配额已用尽,需等待重置或更换已实名/更高配额的 key。</div>`;
    } else if (le) {
      errBox = `<div style="margin-top:10px;padding:8px 12px;background:#fef3c7;color:#92400e;border-radius:6px;font-size:12px">⚠ Last geocode error · 最近定位错误 (${escapeHtml(provLabel)}): ${escapeHtml(String(le.code))} ${escapeHtml(le.message || '')}</div>`;
    }
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <strong style="color:var(--text-1)">${escapeHtml(provLabel)}</strong>
        ${keyChip}
      </div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:12px">
        <span style="color:var(--text-3)">Stores geocoded · 门店已定位</span>
        <span><strong>${pct(s.geocoded, s.total)}</strong>${s.missing ? ` · <span style="color:#b85c00">${s.missing} 个未定位 (missing GPS)</span>` : ''}</span>
        <span style="color:var(--text-3)">Addresses geocoded · 地址已定位</span>
        <span><strong>${pct(a.geocoded, a.total)}</strong>${a.missing ? ` · <span style="color:#b85c00">${a.missing} 个未定位 (missing GPS)</span>` : ''}</span>
      </div>
      ${!cfg ? '<div style="margin-top:10px;padding:8px 12px;background:#fef3c7;color:#92400e;border-radius:6px;font-size:12px">⚠ Add <code>AMAP_MAPS_KEY=...</code> (or <code>TENCENT_MAPS_KEY=...</code>) to <code>/root/roots-v2/.env</code> and restart pm2 to enable geocoding. · 在 .env 中添加密钥并重启 pm2 以启用定位。</div>' : ''}
      ${errBox}
    `;
  } catch (e) {
    box.innerHTML = `<span style="color:var(--danger)">Failed to load status · 加载状态失败: ${escapeHtml(e.message)}</span>`;
  }
}


// ═══════════════════════════════════════════════════════════════════════
// COMMAND SEARCH PALETTE
// A keyword search over every page, every Settings panel, and the individual
// setting cards inside them. The index is rebuilt from the live DOM each time
// the palette opens, so it never drifts from the chrome and automatically
// respects feature gates (hidden tabs / panels are skipped).
// ═══════════════════════════════════════════════════════════════════════
(function () {
  const overlay  = $('#gsearch-overlay');
  const input    = $('#gsearch-input');
  const resultsEl = $('#gsearch-results');
  if (!overlay || !input || !resultsEl) return;

  // Extra search keywords for things operators describe in their own words but
  // that aren't spelled out in the on-screen label. Keyed by a substring of the
  // entry label (lowercased); matched aliases get appended to that entry's
  // searchable text. Bilingual where it helps discovery.
  const ALIASES = {
    'dashboard':   'home overview stats revenue sales summary 概览 首页 数据',
    'orders':      'fulfil fulfill shipping refund cancel invoice receipt billing tax fapiao 订单 退款 发货 发票 收据',
    'customers':   'members users buyers tags 顾客 会员 用户',
    'products':    'items catalog inventory stock price sku 产品 商品 库存 价格',
    'purchasing':  'purchase orders po buying restock receive goods suppliers vendor contacts import csv 采购单 进货 供应商 供货商',
    'coupons':     'voucher discount promo code 优惠券 折扣 促销',
    'flash sales': 'sale countdown deal 秒杀 限时',
    'pop-ups':     'popup banner modal announcement 弹窗',
    'affiliate':   'referral commission distributor 分销 推广',
    'leaderboard': 'ranking top spenders 排行榜',
    'membership':  'tier vip points loyalty 会员 等级 积分',
    'voting':      'poll survey vote 投票',
    'top-up':      'wallet balance recharge points 充值 余额 积分',
    'broadcasts':  'message blast push announcement 群发 广播',
    'copy':        'text snippets wording strings 文案',
    'about':       'story brand page 关于',
    'reviews':     'ratings stars feedback 评价 评分',
    'feedback':    'bug report complaint 反馈 报告',
    'media':       'images photos upload library 媒体 图片',
    'delivery':    'shipping holiday batch fresh zones same-day district cutoff lead time 配送 节假日 现做 区域 当天',
    'brand':       'logo colour color theme accent font palette dark light wordmark 品牌 主题 颜色 字体 标志',
    'shop':        'category grid sort filter 商店 分类',
    'push':        'notification alert message subscribe 推送 通知',
    'social proof': 'bought count viewers recent buyers ticker 社交 人气 销量',
    'customer service': 'cs contact whatsapp wechat hours support chat 客服 联系',
    'legal':       'terms privacy policy refund 条款 隐私 政策',
    'faq':         'help questions support 常见问题 帮助',
  };

  // SVG icons keyed by destination so results echo the chrome.
  const ICON = {
    page:    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    setting: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82M4.6 9a1.65 1.65 0 0 0-.33-1.82"/><circle cx="12" cy="12" r="9"/>',
    section: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    product:  '<path d="M3 3h18l-2 14H5L3 3z"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M8 7h8"/>',
    order:    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/>',
    customer: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  };

  // Distinctive line glyphs per top-level destination, so pages don't all
  // read as the same globe. Matched by a keyword in the (English) title;
  // first hit wins, else we fall back to the type icon (ICON above).
  // Order matters — first substring hit wins, so a MORE SPECIFIC keyword must
  // come before any shorter one it would otherwise collide with. E.g. "Flash
  // sales" contains "sales", so 'flash' has to precede 'sales'; "Customer
  // reviews"/"Customer feedback" contain "customer", so 'review'/'feedback'
  // have to precede 'customer'.
  const NAMED_ICON = [
    ['open your store', '<path d="M3 9l1.6-5h14.8L21 9"/><path d="M4 9v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 9h18"/><path d="M9.5 19v-5h5v5"/>'],
    ['dashboard',       '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'],
    ['report',          '<path d="M4 20h16"/><path d="M7 20v-6"/><path d="M12 20V8"/><path d="M17 20v-9"/>'],
    ['flash',           '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'],
    ['sales',           '<polyline points="3 17 9 11 13 15 21 6"/><polyline points="15 6 21 6 21 12"/>'],
    ['order',           ICON.order],
    ['review',          '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'],
    ['feedback',        '<path d="M8 2h8a2 2 0 0 1 2 2v12l-4-3H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M12 6v3"/><circle cx="12" cy="11.5" r="0.4" fill="currentColor"/>'],
    ['customer',        ICON.customer],
    ['product',         ICON.product],
    ['categor',         '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'],
    ['purchas',         '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.4 12.5a1 1 0 0 0 1 .8h9.1a1 1 0 0 0 1-.78L21 7H6"/>'],
    ['meituan',         '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.6 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'],
    ['eleme',           '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.6 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'],
    ['guanyi',          '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.6 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'],
    ['gzgrocery',       '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.6 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'],
    // The rest of the top-level rail, added so nothing falls back to the
    // generic globe (ICON.page) — every one of these is the SAME svg its
    // own rail button uses, so a result echoes the chrome it points to.
    ['editor',          '<path d="M4 20l3-.7L18.5 7.8a2 2 0 0 0-2.8-2.8L4.2 16.5 4 20z"/><path d="M14.5 6.5l3 3"/>'],
    ['copy',            '<path d="M4 7V4h16v3"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'],
    ['coupon',          '<path d="M20 12V8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4a2 2 0 0 1 2 2 2 2 0 0 1-2 2v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4a2 2 0 0 1-2-2 2 2 0 0 1 2-2z"/><line x1="9" y1="9" x2="15" y2="15"/>'],
    ['pop-up',          '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/>'],
    ['affiliate',       '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11l-3 3-3-3"/><path d="M19 14V4"/>'],
    ['share card',      '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/>'],
    ['broadcast',       '<path d="M3 11l15-7v16L3 13v-2z"/><path d="M11 19a2 2 0 0 1-4 0v-4"/><path d="M18 8a4 4 0 0 1 0 8"/>'],
    ['social',          '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'],
    ['membership',      '<path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6z"/>'],
    ['top-up',          '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>'],
    ['leaderboard',     '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'],
    ['voting',          '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'],
    ['about page',      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'],
    ['legal',           '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>'],
    ['faq',             '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'],
    ['media',           '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'],
    ['delivery',        '<path d="M3 13l2-6h8l3 4h4v5h-2"/><circle cx="7.5" cy="17" r="2"/><circle cx="16.5" cy="17" r="2"/>'],
    ['setting',         ICON.setting],
  ];

  // Pick the glyph for a result: a named page/setting icon when the title
  // matches, else the type default.
  function glyphFor(it) {
    if (it.type === 'page' || it.type === 'setting') {
      const t = it.title.toLowerCase();
      for (const [key, svg] of NAMED_ICON) if (t.includes(key)) return svg;
    }
    return ICON[it.type] || ICON.page;
  }

  // Result groups, shown in this order. Static chrome ("nav") first, then live
  // records pulled from the backend. Empty groups collapse automatically.
  const GROUP_LABEL = {
    nav:      'Pages & settings · 页面与设置',
    product:  'Products · 产品',
    order:    'Orders · 订单',
    customer: 'Customers · 顾客',
  };

  // True when el (or an ancestor) is hidden by a feature gate. Mirrors the CSS
  // rule `body:not(.feat-X) [data-feat="X"]{display:none}`. We can't use
  // offset/visibility here because collapsed dropdown popovers are also
  // display:none yet their tabs are still valid destinations.
  function gatedOff(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const f = n.getAttribute && n.getAttribute('data-feat');
      if (f && !document.body.classList.contains('feat-' + f)) return true;
    }
    return false;
  }

  // Read a button's visible label, dropping nested icons / badges.
  function cleanLabel(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('svg, .tab-badge, .gsearch-kbd').forEach(n => n.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  }

  // Pull the descriptive blurb attached to a settings/section card so the
  // card's words become searchable (e.g. "announcement bar" finds Accent).
  function cardKeywords(card) {
    if (!card) return '';
    const bits = [];
    card.querySelectorAll('.muted, label').forEach(n => {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (t && t.length < 200) bits.push(t);
    });
    return bits.join(' ');
  }

  function applyAliases(label) {
    const low = label.toLowerCase();
    let extra = '';
    for (const key in ALIASES) if (low.includes(key)) extra += ' ' + ALIASES[key];
    return extra;
  }

  // Walk a section for its heading cards → deep "jump to this card" entries.
  function indexCards(rootSel, item, items) {
    const root = document.querySelector(rootSel);
    if (!root) return;
    root.querySelectorAll('.group-card-head h3, .group-card > h3, .card > h3').forEach(h3 => {
      const card = h3.closest('.group-card') || h3.closest('.card') || h3.parentElement;
      const title = cleanLabel(h3);
      if (!title) return;
      items.push({
        type: 'section',
        title,
        crumb: item.crumb ? item.crumb + ' › ' + item.title : item.title,
        tab: item.tab, sub: item.sub, anchor: card,
        kw: (title + ' ' + cardKeywords(card)).toLowerCase(),
      });
    });
  }

  function buildIndex() {
    const items = [];
    // 1) Top-level tabs (+ deep cards within each tab's section)
    document.querySelectorAll('.tabs [data-tab]').forEach(btn => {
      if (gatedOff(btn)) return;
      const tab = btn.dataset.tab;
      const title = cleanLabel(btn);
      const it = { type: 'page', title, crumb: '', tab, sub: null, anchor: null,
                   kw: (title + applyAliases(title)).toLowerCase() };
      items.push(it);
      if (tab !== 'config') indexCards('#tab-' + tab, it, items);
    });
    // 1b) Stock activity lives inside Products (no rail button of its own since
    // 2026-07-10) — index it by hand so typing "activity" still jumps straight
    // to the ledger. `view` makes go() open the sub-view after the tab click.
    if (document.getElementById('prod-view-activity')
        && (typeof can !== 'function' || (can('products:view') && can('activity:view')))) {
      items.push({ type: 'page', title: cuT('Stock activity', '库存流水'),
                   crumb: cuT('Products', '产品'), tab: 'products', sub: null, anchor: null,
                   view: 'activity',
                   kw: 'stock activity inventory ledger movements history 库存 流水 activity' });
    }
    // 1c) Categories left the rail on the same day and lives beside it — same
    // hand-indexing, so typing "categories" still lands on the shelf.
    if (document.getElementById('prod-view-categories')
        && (typeof can !== 'function' || (can('products:view') && can('categories:view')))) {
      items.push({ type: 'page', title: cuT('Categories', '分类'),
                   crumb: cuT('Products', '产品'), tab: 'products', sub: null, anchor: null,
                   view: 'categories',
                   kw: 'categories category shelves subcategory tree rail sections 分类 子分类 categories' });
    }
    // 1d) Purchasing had a hand-indexed entry while it was folded into Products
    // (2026-07-11 – 2026-07-13); it's back on the rail now, so the generic
    // top-level-tab walk above already indexes it (title + ALIASES.purchasing).
    // 2) External editor launchers in the Content group (open in a new tab)
    document.querySelectorAll('.tabs-popover button[onclick*="window.open"]').forEach(btn => {
      if (gatedOff(btn)) return;
      const title = cleanLabel(btn);
      const m = btn.getAttribute('onclick').match(/window\.open\(['"]([^'"]+)/);
      items.push({ type: 'page', title, crumb: 'Content', tab: null, sub: null,
                   anchor: null, openUrl: m ? m[1] : null,
                   kw: (title + ' editor open external').toLowerCase() });
    });
    // 3) Settings panels (+ deep cards within each panel)
    document.querySelectorAll('#settings-nav button[data-sub]').forEach(btn => {
      if (gatedOff(btn)) return;
      const sub = btn.dataset.sub;
      const title = cleanLabel(btn);
      const it = { type: 'setting', title, crumb: 'Settings', tab: 'config', sub,
                   anchor: null, kw: (title + ' settings ' + applyAliases(title)).toLowerCase() };
      items.push(it);
      indexCards('#sub-' + sub, it, items);
    });
    return items;
  }

  // Score a query against an item. Returns -1 for no match.
  function score(item, tokens, raw) {
    const title = item.title.toLowerCase();
    const hay = item.kw;
    let s = 0;
    if (title === raw) s += 1000;
    if (title.startsWith(raw)) s += 200;
    if (title.includes(raw)) s += 80;
    for (const tk of tokens) {
      if (title.includes(tk)) s += 30;
      else if (hay.includes(tk)) s += 10;
      else return -1; // every token must appear somewhere
    }
    // Prefer top-level destinations over deep cards on ties
    if (item.type === 'page') s += 6;
    else if (item.type === 'setting') s += 4;
    return s;
  }

  let INDEX = [];        // static chrome index, rebuilt on open
  let matches = [];      // flat list currently shown (nav + live records)
  let active = 0;
  let dataItems = [];    // live record matches for the current query
  let dataSeq = 0;       // guards against out-of-order async responses
  let debounceT = null;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Static chrome matches for a query (capped). Empty query → starter menu.
  function navMatches(raw) {
    if (!raw) return INDEX.filter(i => i.type === 'page' || i.type === 'setting').slice(0, 12);
    const tokens = raw.split(/\s+/);
    return INDEX
      .map(i => ({ i, s: score(i, tokens, raw) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map(x => x.i);
  }

  function itemTag(it) {
    if (it.openUrl) return 'opens ↗';
    if (it.type === 'product') return 'edit ↗';
    if (it.type === 'order' || it.type === 'customer') return 'open';
    if (it.type === 'section') return 'jump';
    return '';
  }

  function itemHtml(it, idx) {
    const tag = itemTag(it);
    const crumb = it.crumb ? '<div class="gs-crumb">' + esc(it.crumb) + '</div>' : '';
    return '<button class="gsearch-item" role="option" data-idx="' + idx + '">'
      + '<span class="gs-ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + glyphFor(it) + '</svg></span>'
      + '<span class="gs-body"><div class="gs-title">' + esc(it.title) + '</div>' + crumb + '</span>'
      + (tag ? '<span class="gs-tag">' + esc(tag) + '</span>' : '')
      + '</button>';
  }

  // Paint the combined result list, inserting a header whenever the group
  // changes. matches[] stays 1:1 and in-order with the rendered .gsearch-item
  // buttons (group headers are non-selectable), so data-idx == matches index.
  function paint() {
    matches = navMatches(input.value.trim().toLowerCase()).concat(dataItems);
    active = 0;
    if (!matches.length) {
      resultsEl.innerHTML = '<div class="gsearch-empty">No matches · 没有结果</div>';
      return;
    }
    let html = '', lastG = null;
    matches.forEach((it, idx) => {
      const g = it.group || 'nav';
      if (g !== lastG) { html += '<div class="gsearch-group-head">' + esc(GROUP_LABEL[g] || '') + '</div>'; lastG = g; }
      html += itemHtml(it, idx);
    });
    resultsEl.innerHTML = html;
    const first = resultsEl.querySelector('.gsearch-item');
    if (first) first.classList.add('active');
  }

  // Debounced live-record search against the existing list endpoints (same
  // cookie auth as the page). Records become Products / Orders / Customers
  // result groups that deep-link straight into their editor or drawer.
  function scheduleData() {
    clearTimeout(debounceT);
    const raw = input.value.trim();
    if (raw.length < 2) { dataItems = []; return; }
    debounceT = setTimeout(() => fetchData(raw), 190);
  }

  async function fetchData(raw) {
    const mySeq = ++dataSeq;
    const enc = encodeURIComponent(raw);
    const grab = url => fetch(url, { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    const [p, o, c] = await Promise.all([
      grab('/api/retail-admin/products?q=' + enc + '&limit=8&sales30=1'),
      grab('/api/retail-admin/orders?q=' + enc + '&limit=8'),
      grab('/api/retail-admin/customers?q=' + enc + '&pageSize=8'),
    ]);
    if (mySeq !== dataSeq) return; // a newer keystroke superseded this fetch
    const items = [];
    ((p && p.data) || []).slice(0, 6).forEach(r => {
      const name = r.name_en || r.name_cn || ('#' + r.id);
      const bits = [r.sku, r.category].filter(Boolean);
      // Rolling 30-day units, so a common query ("protein") often answers
      // "how's it selling?" right in the result list, no click needed.
      if (r.units_30d) bits.push(r.units_30d + ' sold · 30d');
      items.push({ type: 'product', group: 'product', title: name,
        crumb: bits.join(' · '), pid: r.id });
    });
    // Did this order surface because the query matched its phone (rather than
    // the order number or recipient name)? If so, show the phone in the
    // subtitle so the operator sees *why* it came up. Compare on digits only.
    const qDigits = raw.replace(/\D/g, '');
    ((o && o.data) || []).slice(0, 6).forEach(r => {
      const who = r.recipient_name || r.nickname || '';
      const bits = [r.status, who];
      const phoneDigits = String(r.recipient_phone || '').replace(/\D/g, '');
      if (qDigits.length >= 3 && phoneDigits && phoneDigits.includes(qDigits)) {
        bits.push(r.recipient_phone);
      }
      items.push({ type: 'order', group: 'order',
        title: r.order_no || ('Order #' + r.id),
        crumb: bits.filter(Boolean).join(' · '), oid: r.id });
    });
    ((c && c.data) || []).slice(0, 6).forEach(r => {
      const bits = [r.phone, (r.orders_count != null ? r.orders_count + ' orders' : null)].filter(Boolean);
      items.push({ type: 'customer', group: 'customer',
        title: r.nickname || r.phone || ('#' + r.id),
        crumb: bits.join(' · '), cid: r.id });
    });
    dataItems = items;
    paint();
  }

  function setActive(i) {
    const els = resultsEl.querySelectorAll('.gsearch-item');
    if (!els.length) return;
    active = (i + els.length) % els.length;
    els.forEach((e, idx) => e.classList.toggle('active', idx === active));
    els[active].scrollIntoView({ block: 'nearest' });
  }

  function go(it) {
    if (!it) return;
    close();
    if (it.openUrl) { window.open(it.openUrl, '_blank', 'noopener'); return; }
    // Live records → open the matching editor / detail drawer.
    if (it.type === 'product') {
      // Go through the same tab-click + paOpenEdit(id) a normal product-row
      // click uses (mirrors the order/customer branches below) — NOT
      // openProductEditor() directly, which skips straight to the page-design
      // iframe and would bypass the commercial editor's Sales card entirely
      // for the common (non-upstream) catalog mode. paOpenEdit() still
      // branches to openProductEditor() itself for upstream tenants.
      const t = document.querySelector('.tabs [data-tab="products"]');
      if (t) t.click();
      if (typeof paOpenEdit === 'function') setTimeout(() => paOpenEdit(it.pid), 60);
      else if (typeof openProductEditor === 'function') openProductEditor(it.pid);
      return;
    }
    if (it.type === 'order') {
      const t = document.querySelector('.tabs [data-tab="orders"]');
      if (t) t.click();
      if (typeof openOrder === 'function') setTimeout(() => openOrder(it.oid), 60);
      return;
    }
    if (it.type === 'customer') {
      const t = document.querySelector('.tabs [data-tab="customers"]');
      if (t) t.click();
      if (typeof cuOpenDetail === 'function') setTimeout(() => cuOpenDetail(it.cid), 60);
      return;
    }
    const tabBtn = it.tab && document.querySelector('.tabs [data-tab="' + it.tab + '"]');
    if (tabBtn) tabBtn.click();
    // Sub-view hop (Stock activity inside Products) — after the tab is active.
    if (it.view && typeof prodShowView === 'function') prodShowView(it.view);
    if (it.sub) {
      const subBtn = document.querySelector('#settings-nav button[data-sub="' + it.sub + '"]');
      if (subBtn) subBtn.click();
    }
    const anchor = it.anchor;
    if (anchor) {
      setTimeout(() => {
        anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        anchor.classList.remove('gsearch-flash');
        void anchor.offsetWidth; // restart animation
        anchor.classList.add('gsearch-flash');
        setTimeout(() => anchor.classList.remove('gsearch-flash'), 1600);
      }, 90);
    }
  }

  function open() {
    INDEX = buildIndex();
    dataItems = [];
    dataSeq++;
    clearTimeout(debounceT);
    overlay.hidden = false;
    input.value = '';
    paint();
    input.focus();
  }
  function close() {
    overlay.hidden = true;
    clearTimeout(debounceT);
    input.blur();
  }

  // Expose the opener for the topbar pill's inline onclick.
  window.openCmdSearch = open;

  input.addEventListener('input', () => { paint(); scheduleData(); });
  resultsEl.addEventListener('click', (e) => {
    const el = e.target.closest('.gsearch-item');
    if (el) go(matches[+el.dataset.idx]);
  });
  resultsEl.addEventListener('mousemove', (e) => {
    const el = e.target.closest('.gsearch-item');
    if (el) setActive(+el.dataset.idx);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); go(matches[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  // Global shortcut: Ctrl/⌘+K toggles the palette.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      overlay.hidden ? open() : close();
    }
  });
})();

// ── Live visual updates: paint accent + tab-bar colour into the mockups ──
const ACCENT_HEX = {
  'lime-leaf':    '#ccd900',
  'forest-kale':  '#3a5a30',
  'carrot-blaze': '#e87a3a',
  'berry-punch':  '#c43a6a',
  'papaya-glow':  '#f0a050',
  'pea-sprout':   '#a8c75a',
};
function applyVisualPreviews() {
  const accentSel = $('#cfg-theme-accent');
  const accent = ACCENT_HEX[accentSel?.value] || '#ccd900';
  // Top-panel context visuals (Home / Push / Legal still use the larger .phone)
  $$('.pv-bar, .pv-highlight').forEach(el => {
    if (el.classList.contains('pv-highlight')) el.style.outlineColor = accent;
    else el.style.background = accent;
  });
  // (Tab-bar live preview lives in /cms now — the TAB BAR topbar picker
  // owns the bottom-bar theme + icon design + colour overrides.)
}

// (Notification-strip custom-hex handler moved to the Mini App Editor /cms 2026-06-09.)

// ── Sub-panel visual picker (Shop layout; Brand & theme pickers moved to /cms) ──
const PICKER_TARGETS = ['cfg-shop-layout'];
document.addEventListener('click', e => {
  const opt = e.target.closest('.opt[data-target]');
  if (!opt) return;
  const sel = document.getElementById(opt.dataset.target);
  if (!sel) return;
  sel.value = opt.dataset.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
function syncAllPickers() {
  PICKER_TARGETS.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    document.querySelectorAll(`.opt[data-target="${id}"]`).forEach(t => {
      t.classList.toggle('active', t.dataset.value === sel.value);
    });
  });
}

// ── Live Shop-filters preview: show/hide rows in the mini phone based on toggles ──
function applyShopFiltersPreview() {
  const rows = {
    'pv-view-row':    !$('#cfg-shop-lockLayout')?.checked,
    'pv-sort-row':    $('#cfg-shop-showSort')?.checked,
    'pv-dietary-row': $('#cfg-shop-showDietary')?.checked,
    'pv-stock-row':   $('#cfg-shop-showStockFilter')?.checked,
    'pv-badge-row':   $('#cfg-shop-showBadgeFilter')?.checked,
    'pv-price-row':   $('#cfg-shop-showPriceFilter')?.checked,
  };
  Object.entries(rows).forEach(([id, on]) => {
    const el = document.getElementById(id);
    if (el) el.style.opacity = on ? '1' : '0.15';
  });
  // Also dim chip strips next to disabled toggles
  const dietaryStrip = $('#cfg-shop-showDietary')?.closest('label')?.nextElementSibling;
  const badgeStrip   = $('#cfg-shop-showBadgeFilter')?.closest('label')?.nextElementSibling;
  if (dietaryStrip?.classList.contains('chip-strip'))
    dietaryStrip.style.opacity = $('#cfg-shop-showDietary')?.checked ? '1' : '0.35';
  if (badgeStrip?.classList.contains('chip-strip'))
    badgeStrip.style.opacity = $('#cfg-shop-showBadgeFilter')?.checked ? '1' : '0.35';
}

// ── Live sort preview ──
function applySortPreview() {
  const labels = {
    '':           'Featured ↓',
    'newest':     'Newest',
    'price_asc':  'Price ↑',
    'price_desc': 'Price ↓',
    'popular':    'Popular',
  };
  const el = document.getElementById('pv-sort-label');
  if (el) el.textContent = labels[$('#cfg-shop-defaultSort')?.value] || 'Featured ↓';
}

// ── Live fee previews: write ¥ values into the mini-phone overlays ──
function applyFeePreviews() {
  const free = Number($('#cfg-fees-freeShippingThreshold')?.value) || 0;
  const std  = Number($('#cfg-fees-standardShipping')?.value) || 0;
  const sd   = Number($('#cfg-fees-sameDayDelivery')?.value) || 0;
  const min  = Number($('#cfg-fees-minOrder')?.value) || 0;
  const elFree = document.getElementById('pv-free-rem');
  if (elFree) elFree.textContent = String(Math.max(0, free - Math.round(free * 0.78))) || '0';
  const elStd = document.getElementById('pv-std-fee');
  if (elStd) elStd.textContent = String(std);
  const elSd = document.getElementById('pv-sameday-fee');
  if (elSd) elSd.textContent = String(sd);
  const elMin = document.getElementById('pv-min-order');
  if (elMin) elMin.textContent = String(min);
}

document.addEventListener('change', e => {
  const id = e.target.id;
  if (PICKER_TARGETS.includes(id)) syncAllPickers();
  if (id?.startsWith('cfg-shop-')) { applyShopFiltersPreview(); applySortPreview(); }
  if (id?.startsWith('cfg-fees-')) applyFeePreviews();
});
document.addEventListener('input', e => {
  if (e.target.id?.startsWith('cfg-fees-')) applyFeePreviews();
});

// ── Bootstrap ──
// Per-tenant catalog ownership, surfaced by /api/backend/me. 'upstream' (Roots)
// = catalog + stock live in the kitchen app, so this backend only merchandises
// the channel; 'self' = this backend manages its own products + stock.
let CATALOG_MODE = 'self';
// Toggleable backend features — keep keys in sync with lib/features.js. `def`
// is the operator-on default when the tenant has never touched the Features tab.
const FEATURE_CATALOG = [
  { key: 'membership',  en: 'Membership & points', cn: '会员与积分', def: true,
    desc: 'Roots Club tiers and the points shown to shoppers. · 会员等级与向顾客展示的积分。' },
  { key: 'affiliate',   en: 'Referral program',    cn: '推荐计划',   def: true,
    desc: 'On/off for the whole referral program — when off, shoppers can\'t apply codes or earn rewards, and the admin tab is hidden. · 推荐计划总开关:关闭后顾客无法使用邀请码或获得奖励,后台标签页也会隐藏。' },
  { key: 'reviews',     en: 'Product reviews',      cn: '商品评价',   def: true,
    desc: 'Customer reviews and the review-tag editor. · 顾客评价与评价标签编辑。' },
  { key: 'feedback',    en: 'Customer feedback',    cn: '用户反馈',   def: true,
    desc: 'The "Found a bug?" inbox from the mini-app Me page. · 来自小程序“我的”页面的反馈收件箱。' },
  { key: 'socialProof', en: 'Social proof',         cn: '社交证明',   def: true,
    desc: 'Bought-counts, recent-buyers ticker and the SOLD badge. · 购买人数、最近购买动态与“已售”标签。' },
  { key: 'faq',         en: 'Help / FAQ',           cn: '帮助 / 常见问题', def: true,
    desc: 'The Me → Help & FAQ screen — categories, search and the contact bar. When off, the FAQ row is hidden in the mini app. · “我的”→帮助与常见问题页面:分类、搜索与联系入口。关闭后小程序内不显示该入口。' },
  { key: 'quickStock',  en: 'Quick Stock (mobile)', cn: '手机库存',   def: true,
    desc: 'A phone-first stock app for shop staff — open /stock on a phone and adjust counts without a PC. Each staffer only edits their assigned store. When off, the app shows a closed screen. · 面向门店员工的手机库存应用:在手机上打开 /stock 即可调整库存,无需电脑。每位员工只能编辑其所分配的门店。关闭后应用显示停用页面。' },
  { key: 'kitchenAdd',  en: 'Add Stock (kitchen)', cn: '加库存',     def: true,
    desc: 'A phone app for kitchen/production staff — they search a product, enter how many they just made, and it is added to the shelf count. They never see or recount the current stock. Kitchen-role staff open /stock and get this add view automatically. When off, the app shows a closed screen. · 面向后厨/生产员工的手机应用:搜索商品,输入刚制作的数量,即可加入库存。他们看不到也无需清点现有库存。后厨角色员工打开 /stock 自动进入此“加库存”视图。关闭后应用显示停用页面。' },
];
let ENTITLEMENTS = {};
(async () => {
  try {
    // Mini App Backend is its own auth realm — authenticate against the
    // backend operator endpoint, not the kitchen one, so an unauthenticated
    // visitor lands on the backend's own login rather than in the kitchen app.
    const me = await fetch('/api/backend/me', { credentials: 'same-origin' }).then(r => r.json());
    if (!me?.user) { location.href = '/backend/login'; return; }
    const u = me.user;
    // Resolve catalog ownership before any product UI renders, so upstream
    // tenants never see the catalog-write controls / stock modal.
    CATALOG_MODE = (u.tenant && u.tenant.catalogMode) || 'self';
    document.body.classList.toggle('catalog-upstream', CATALOG_MODE === 'upstream');
    // Feature entitlements (platform ceiling). { key: false } = not entitled;
    // a missing key means entitled. loadConfig() combines this with the
    // operator's own on/off preferences before showing each feature.
    ENTITLEMENTS = (u.tenant && u.tenant.entitlements) || {};
    // Per-user capabilities (RBAC). setCaps() renders the backend from this
    // operator's effective set — hiding nav sections / buttons they can't use.
    // DARK in Phase 0/1: owner/admin/staff resolve to the full set and an older
    // session sends caps:null (treated as all-allowed), so nothing hides yet.
    setCaps(u.caps);
    // Dashboards by position — the role picks a fixed dashboard view (see
    // 03-dashboard.js dashPos*). body.pos-* drives the CSS that removes the
    // money blocks for warehouse / customer_service / dispatch; RA_STORE_LOCK
    // pins a store-scoped operator (store_manager) to their own store on every
    // dashboard pull. Full-access roles land on pos-default (unchanged view).
    const POSITIONS = ['store_manager', 'warehouse', 'customer_service', 'dispatch'];
    window.RA_POS = POSITIONS.includes(u.role) ? u.role : 'default';
    document.body.classList.add('pos-' + window.RA_POS.replace(/_/g, '-'));
    if (window.RA_POS !== 'default' && Array.isArray(u.scopeStores) && u.scopeStores.length) {
      window.RA_STORE_LOCK = u.scopeStores[0];
    }
    // Google-style profile circle + dropdown (avatar · account · team · sign out).
    initAcctMenu(u);
    // The dashboard greeting reads this same user — repaint it now in case the
    // dashboard rendered its fallback "Dashboard" title before /me resolved.
    if (typeof tdGreetRender === 'function') tdGreetRender();
    // Co-brand identity — swap the rail/topbar wordmark, page title and favicon
    // to the tenant's own logo + name (falls back to the tacet waveform when unset).
    applyBrand(u.tenant);
  } catch (e) { location.href = '/backend/login'; return; }
  // Phase 1 — feature controls. ent-<key> = platform entitlement; the per-feature
  // on/off switch lives on each feature's own page (Option B: off dims the nav
  // instead of hiding it), injected by mountFeatureControls(). We seed feat-<key>
  // to its catalog default up front so the nav doesn't flash an "Off" state before
  // loadConfig()'s applyFeatureGates() applies the operator's real preference.
  for (const f of FEATURE_CATALOG) {
    const ent = ENTITLEMENTS[f.key] !== false;
    document.body.classList.toggle('ent-' + f.key, ent);
    document.body.classList.toggle('feat-' + f.key, ent && f.def);
  }
  // Boot each surface in ISOLATION. Previously these ran as a flat sequence, so
  // a single throw — e.g. a script part that transiently didn't load/parse after
  // a bad deploy or a stale SW-cached partial, leaving an early call like
  // mountFeatureControls undefined — aborted every call BELOW it, including
  // dashInit(). That stranded the whole dashboard on "Loading…" until a hard
  // refresh. Thunks so an undefined identifier throws INSIDE the try (and is
  // logged + skipped) rather than while the list is built; order is unchanged.
  [
    ['mountFeatureControls', () => mountFeatureControls()],
    ['dashInit',      () => dashInit()],          // landing tab — date range + first load
    ['loadOrders',    () => loadOrders()],
    ['loadConfig',    () => loadConfig()],         // also hydrates the Mini-app footer fields
    ['loadSnippets',  () => loadSnippets()],
    ['loadVouchers',  () => loadVouchers()],
    ['loadPopups',    () => loadPopups()],
    ['loadDeliveryZones', () => loadDeliveryZones()],
    ['_loadGzExcludedDistricts', () => _loadGzExcludedDistricts()], // GZ same-day excluded-districts chips (Delivery tab)
    ['loadShippingIntegrations', () => loadShippingIntegrations()], // Logistics integration card (kd100 / JD) — Delivery tab
    ['loadTopup',     () => loadTopup()],
    ['loadPointsSettings', () => loadPointsSettings()], // Loyalty & Wallet → Membership & points (earn rate, point value, expiry)
    ['loadRctiers',   () => loadRctiers()],        // Loyalty & Wallet → Membership tier ladder (Roots Club)
    ['loadFaq',       () => loadFaq()],
    ['lbInitNavState', () => lbInitNavState()],    // seed the Leaderboard nav OFF pill (lazy form loads later)
    ['votInitNavState', () => votInitNavState()],  // seed the Voting nav OPEN pill (lazy list loads later)
    ['fsInitNavState', () => fsInitNavState()],    // seed the Flash sales nav LIVE pill (lazy list loads later)
  ].forEach(([label, fn]) => { try { fn(); } catch (e) { console.error('[retail-admin boot] ' + label + ' failed — continuing', e); } });
  // Deep-link: /?product=ID opens the Products tab focused on that product —
  // used by the order drawer's "open product in a new tab" item links so the
  // operator lands on the product page (this backend), not a blank dashboard.
  try {
    const _dlPid = parseInt(new URLSearchParams(location.search).get('product'), 10);
    if (_dlPid > 0 && typeof dashOpenProductFromFeed === 'function') dashOpenProductFromFeed(_dlPid);
  } catch {}
  // New-tenant "Open your store" guide (part 17). Safe to call here — the awaits
  // above yield past every script part's synchronous load, so suInit is defined.
  // On genuine first login it lands the operator on the guide; otherwise it just
  // paints the sidebar badge + dashboard card (both gone once setup hits 100%).
  try { if (typeof suInit === 'function') suInit(); } catch (e) {}
})();

// ── Co-brand identity — make the chrome read as the tenant's own ─────────
// Given the tenant object from /api/backend/me, swap the rail + topbar wordmark
// to the tenant's logo + name, retitle the tab, and repoint the favicon at the
// tenant's square mark. A tenant with no logo set (including Tacet/Roots itself)
// keeps the built-in waveform + "tacet" — never a broken image. Identity only:
// we touch the logo/name/title/favicon and nothing else about the Tacet look.
function applyBrand(tenant) {
  if (!tenant) return;
  const name = (tenant.brand || '').trim();
  const logoUrl = tenant.brandLogoUrl || null;
  const markUrl = tenant.brandMarkUrl || logoUrl;
  // The admin's default identity is ALWAYS "tacet". A tenant only takes over the
  // chrome once they've uploaded a LOGO — a brand_name alone (used for customer
  // payment/print, e.g. Roots) must NOT rename the admin.
  if (!logoUrl) return;   // leave the built-in tacet waveform + wordmark

  // Option A — LOGO ONLY. The uploaded logo replaces our waveform + wordmark
  // entirely (no name text, no waveform); body.cobrand drives the swap in CSS.
  // Open rail + topbar show the full logo; the folded rail shows the square mark.
  if (name) document.title = name;
  const fav = document.getElementById('favlink');
  const favA = document.getElementById('favlink-apple');
  if (markUrl && fav) fav.href = markUrl;
  if (markUrl && favA) favA.href = markUrl;

  const set = (id, url) => { const el = document.getElementById(id); if (el && url) el.src = url; };
  set('brandLogoTop', logoUrl);
  set('brandLogoRail', logoUrl);
  set('brandMarkRail', markUrl);

  // Only commit the swap once the logo actually loads — a 404 leaves the clean
  // tacet waveform in place rather than an empty brand corner.
  const probe = new Image();
  probe.onload = () => document.body.classList.add('cobrand');
  probe.onerror = () => document.body.classList.remove('cobrand');
  probe.src = logoUrl;

  // "runs on tacet" credit — shown for a co-branded tenant whose credit is on.
  const credit = document.getElementById('brandCredit');
  if (credit) credit.hidden = !tenant.brandCredit;
}

// ── Account menu — Google-style profile circle + dropdown ────────────────
// Avatar (uploaded photo, or initials monogram fallback) in the topbar; click
// opens a menu with the operator's identity, Account, Manage team, Sign out.
let ACCT_USER = null;
function acctInitials(u) {
  const src = String(u.displayName || u.username || '').trim();
  if (!src) return '?';
  if (/^[\x00-\x7F]+$/.test(src)) {            // Latin → up to two word-initials
    const parts = src.split(/\s+/).filter(Boolean);
    const ini = (parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
    return ini.toUpperCase() || '?';
  }
  return Array.from(src)[0];                    // CJK / other → first glyph
}
function acctRenderCircle(el, u) {
  if (!el) return;
  if (u.avatarUrl) {
    el.innerHTML = '';
    const img = document.createElement('img');
    img.src = u.avatarUrl; img.alt = '';
    img.onerror = () => { el.textContent = acctInitials(u); };
    el.appendChild(img);
  } else {
    el.textContent = acctInitials(u);
  }
}
function acctRenderMeta() {
  const u = ACCT_USER; if (!u) return;
  acctRenderCircle($('#acctCircle'), u);
  acctRenderCircle($('#acctCircleLg'), u);
  const nameEl = $('#acctName');
  if (nameEl) nameEl.textContent = u.displayName || u.username || '—';
}
// Refresh the right-hand value chip on the in-menu Appearance row so it
// reflects the live theme. Guarded — the row may not exist on every surface
// that reuses this script.
function acctSyncPrefs() {
  const themeVal = $('#acctThemeVal');
  if (themeVal) {
    const dark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
    themeVal.textContent = dark ? cuT('Dark', '深色') : cuT('Light', '浅色');
  }
  // New-order sound moved to Profile → Notifications; no chip here anymore.
}
function initAcctMenu(u) {
  ACCT_USER = u;
  const wrap = $('#acct'), btn = $('#acctBtn'), menu = $('#acctMenu');
  if (!wrap || !btn || !menu) return;
  wrap.style.display = '';
  acctRenderMeta();
  acctSyncPrefs();
  if (window.onLangChange) window.onLangChange(() => { acctRenderMeta(); acctSyncPrefs(); });

  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onKey);
  };
  const open = () => {
    if (!menu.hidden) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      document.addEventListener('mousedown', onOutside);
      document.addEventListener('keydown', onKey);
    }, 0);
  };
  function onOutside(e) { if (!wrap.contains(e.target)) close(); }
  function onKey(e) { if (e.key === 'Escape') { close(); btn.focus(); } }

  btn.addEventListener('click', () => { menu.hidden ? open() : close(); });

  // In-menu preference rows. These deliberately do NOT close the menu so the
  // operator can nudge text size or flip theme several times in a row; the
  // value chip updates in place via acctSyncPrefs().
  const themeRow = $('#acctTheme');
  if (themeRow) themeRow.addEventListener('click', () => { if (window.cuToggleTheme) cuToggleTheme(); acctSyncPrefs(); });
  // New-order sound now lives in Profile → Notifications (not the avatar menu).

  const signout = $('#acctSignout');
  if (signout) signout.addEventListener('click', () => {
    fetch('/api/backend/logout', { method: 'POST', credentials: 'same-origin' })
      .finally(() => { location.href = '/backend/login'; });
  });

  const profileBtn = $('#acctProfileBtn');
  if (profileBtn) profileBtn.addEventListener('click', () => { close(); openProfileModal(); });
}

// ── Profile pop-up — hosts /backend/account in an iframe so it opens as a
// centred modal (Google-style) instead of navigating the whole app away to
// a separate page. Same scrim/panel pattern as the flash-sale composer.
function openProfileModal() {
  const scrim = $('#profScrim'), modal = $('#profModal'), frame = $('#profFrame');
  if (!scrim || !modal || !frame) return;
  if (!frame.src) frame.src = '/backend/account';
  scrim.classList.add('on');
  modal.classList.add('on');
  modal.setAttribute('aria-hidden', 'false');
  document.addEventListener('keydown', onProfileKey);
}
function closeProfileModal() {
  const scrim = $('#profScrim'), modal = $('#profModal');
  if (!scrim || !modal) return;
  scrim.classList.remove('on');
  modal.classList.remove('on');
  modal.setAttribute('aria-hidden', 'true');
  document.removeEventListener('keydown', onProfileKey);
}
function onProfileKey(e) { if (e.key === 'Escape') closeProfileModal(); }
(function initProfileModal() {
  const scrim = $('#profScrim'), closeBtn = $('#profClose');
  if (scrim) scrim.addEventListener('click', closeProfileModal);
  if (closeBtn) closeBtn.addEventListener('click', closeProfileModal);
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (e.data === 'profile-modal-close') closeProfileModal();
    if (e.data && e.data.type === 'fc-profile-updated') {
      Object.assign(ACCT_USER || (ACCT_USER = {}), e.data.user);
      acctRenderMeta();
      if (typeof tdGreetRender === 'function') tdGreetRender();
    }
  });
})();

