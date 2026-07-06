/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 07/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: media library, copy helpers, invoices, wallet top-up + points + tiers, review tags, FAQ/legal, reviews, feedback inbox, flash sales (fs*) */
// ════════════════════════════════════════════════════════════════
// MEDIA LIBRARY
// ════════════════════════════════════════════════════════════════
const ML_PAGE = 60;
let _mlRows = [];
let _mlTotal = 0;
let _mlOffset = 0;
let _mlActiveTag = '';
let _mlActiveFolder = '';   // '' = all, 'unsorted', or '<id>'
let _mlFolders = [];
let _mlUnsortedCount = 0;
let _mlTotalCount = 0;
let _mlUsage = {};
let _mlSel = new Set();
let _mlEditId = null;
let _mlEditTags = [];
let _mlBulkAdd = [];
let _mlBulkRemove = [];
let _mlSearchTimer = null;
let _mlDragId = null;

function debouncedMediaLoad() {
  clearTimeout(_mlSearchTimer);
  _mlSearchTimer = setTimeout(loadMedia, 220);
}

async function loadMedia() {
  _mlOffset = 0; _mlRows = [];
  await Promise.all([fetchMediaPage(), loadMediaTags(), loadMediaUsage(), loadMediaFolders()]);
  renderMediaGrid();
  renderFolderSidebar();
}

async function loadMoreMedia() {
  _mlOffset += ML_PAGE;
  await fetchMediaPage();
  renderMediaGrid();
}

async function fetchMediaPage() {
  const params = new URLSearchParams();
  const q = $('#ml-search').value.trim();
  const mime = $('#ml-mime').value;
  if (q) params.set('q', q);
  if (mime) params.set('mime', mime);
  if (_mlActiveTag) params.set('tag', _mlActiveTag);
  if (_mlActiveFolder) params.set('folder', _mlActiveFolder);
  params.set('limit', ML_PAGE);
  params.set('offset', _mlOffset);
  try {
    const r = await api('/api/retail-admin/media/list?' + params.toString());
    const { rows, total } = r.data || {};
    _mlRows = _mlOffset === 0 ? (rows || []) : _mlRows.concat(rows || []);
    _mlTotal = total || 0;
  } catch (e) { toast('Load failed · 加载失败: '+e.message, 'err'); }
}

async function loadMediaFolders() {
  try {
    const r = await api('/api/retail-admin/media/folders');
    _mlFolders = r.data?.folders || [];
    _mlUnsortedCount = r.data?.unsorted_count || 0;
    _mlTotalCount    = r.data?.total_count    || 0;
  } catch { _mlFolders = []; }
}

function renderFolderSidebar() {
  const host = $('#ml-folders');
  const row = (key, label, n, opts = {}) => {
    const active = _mlActiveFolder === key ? ' active' : '';
    const ico = opts.icon || `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    const idAttr = opts.fid != null ? `data-fid="${opts.fid}"` : '';
    const actHtml = opts.fid != null
      ? `<span class="act">
           <button title="Rename · 重命名" onclick="event.stopPropagation(); renameFolder(${opts.fid})">✎</button>
           <button title="Delete · 删除" onclick="event.stopPropagation(); deleteFolder(${opts.fid})">×</button>
         </span>` : '';
    return `<div class="ml-fld${active}" data-fkey="${key}" ${idAttr}
                onclick="setMediaFolder('${key}')"
                ondragover="onFolderDragOver(event, '${key}')"
                ondragleave="onFolderDragLeave(event)"
                ondrop="onFolderDrop(event, '${key}')">
      <span class="ico">${ico}</span>
      <span class="lbl">${escapeHtml(label)}</span>
      <span class="n">${n}</span>
      ${actHtml}
    </div>`;
  };
  const allIco = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`;
  const unsIco = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  host.innerHTML = [
    row('', 'All media · 全部', _mlTotalCount, { icon: allIco }),
    row('unsorted', 'Unsorted · 未分组', _mlUnsortedCount, { icon: unsIco }),
    ..._mlFolders.map(f => row(String(f.id), f.name, f.count, { fid: f.id })),
  ].join('');
}

function setMediaFolder(key) {
  _mlActiveFolder = key;
  loadMedia();
}

function onNewFolderKey(ev) {
  if (ev.key !== 'Enter') return;
  const name = ev.target.value.trim();
  if (!name) return;
  api('/api/retail-admin/media/folders', { method: 'POST', body: { name } })
    .then(() => { ev.target.value = ''; toast('Folder created · 文件夹已创建'); loadMedia(); })
    .catch(e => toast('Create failed · 创建失败: '+e.message, 'err'));
}

async function renameFolder(id) {
  const f = _mlFolders.find(x => x.id === id);
  if (!f) return;
  const name = prompt('Rename folder · 重命名文件夹', f.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === f.name) return;
  try {
    await api(`/api/retail-admin/media/folders/${id}`, { method: 'PATCH', body: { name: trimmed } });
    toast('Renamed · 已重命名'); loadMedia();
  } catch (e) { toast('Rename failed · 重命名失败: '+e.message, 'err'); }
}

async function deleteFolder(id) {
  const f = _mlFolders.find(x => x.id === id);
  if (!f) return;
  const msg = f.count
    ? `Delete folder "${f.name}"? Its ${f.count} item${f.count===1?'':'s'} will move to Unsorted (images are kept). · 删除文件夹 "${f.name}"？其中 ${f.count} 个项目将移至未分类（图片保留）。`
    : `Delete empty folder "${f.name}"? · 删除空文件夹 "${f.name}"？`;
  if (!confirm(msg)) return;
  try {
    await api(`/api/retail-admin/media/folders/${id}`, { method: 'DELETE' });
    if (_mlActiveFolder === String(id)) _mlActiveFolder = '';
    toast('Folder deleted · 文件夹已删除'); loadMedia();
  } catch (e) { toast('Delete failed · 删除失败: '+e.message, 'err'); }
}

// ── Drag a card onto a sidebar folder to move it ───────────────────
function onFolderDragOver(ev, key) {
  if (_mlDragId == null) return;
  ev.preventDefault();
  ev.currentTarget.classList.add('over');
}
function onFolderDragLeave(ev) {
  ev.currentTarget.classList.remove('over');
}
async function onFolderDrop(ev, key) {
  ev.preventDefault();
  ev.currentTarget.classList.remove('over');
  if (_mlDragId == null) return;
  const ids = _mlSel.has(_mlDragId) && _mlSel.size > 1 ? [..._mlSel] : [_mlDragId];
  _mlDragId = null;
  await moveMediaTo(ids, key);
}

async function moveMediaTo(ids, key) {
  const folder_id = key === '' || key === 'unsorted' ? null : parseInt(key, 10);
  try {
    await api('/api/retail-admin/media/bulk-move', { method: 'POST', body: { ids, folder_id } });
    toast(`Moved ${ids.length} · 已移动 ${ids.length}`); _mlSel.clear(); loadMedia();
  } catch (e) { toast('Move failed · 移动失败: '+e.message, 'err'); }
}

async function loadMediaTags() {
  try {
    const r = await api('/api/retail-admin/media/tags');
    const tags = r.data || [];
    const chips = $('#ml-tag-chips');
    chips.innerHTML = [
      `<div class="ml-tag-chip${_mlActiveTag ? '' : ' active'}" onclick="setMediaTag('')">All · 全部</div>`,
      ...tags.map(t =>
        `<div class="ml-tag-chip${_mlActiveTag === t.tag ? ' active' : ''}" onclick="setMediaTag('${escapeAttr(t.tag)}')">
           ${escapeHtml(t.tag)} <span class="n">${t.n}</span>
         </div>`)
    ].join('');
  } catch {}
}

async function loadMediaUsage() {
  try {
    const r = await api('/api/retail-admin/media/usage');
    _mlUsage = r.data || {};
  } catch { _mlUsage = {}; }
}

function setMediaTag(tag) {
  _mlActiveTag = tag;
  loadMedia();
}

function renderMediaGrid() {
  const grid = $('#ml-grid');
  if (!_mlRows.length) {
    grid.innerHTML = `<div class="ml-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      <div>Drop files here or click <b>Upload</b> · 拖入文件或点击上传</div>
    </div>`;
  } else {
    grid.innerHTML = _mlRows.map(m => {
      const used = _mlUsage[m.id] || 0;
      return `<div class="ml-card${_mlSel.has(m.id) ? ' sel' : ''}" data-id="${m.id}" draggable="true"
                  onclick="onMediaCardClick(event, ${m.id})"
                  ondragstart="onCardDragStart(event, ${m.id})"
                  ondragend="onCardDragEnd(event)">
        <div class="ml-card-check" onclick="event.stopPropagation(); toggleMediaSel(${m.id})">✓</div>
        <div class="used-badge ${used ? '' : 'zero'}" title="${used ? `Used in ${used} place${used===1?'':'s'} · 被引用 ${used} 处` : '未被引用 · Not used anywhere yet'}">${used ? '× '+used : 'unused'}</div>
        <div class="ml-thumb"><img loading="lazy" src="/api/retail/media/${m.id}" alt="${escapeAttr(m.alt_text || m.filename || '')}"></div>
        <div class="ml-card-info">
          <div class="name" title="${escapeAttr(m.filename || '')}">${escapeHtml(m.filename || '(untitled)')}</div>
          <div class="meta">${m.width && m.height ? `${m.width}×${m.height} · ` : ''}${fmtBytes(m.size_bytes)}</div>
        </div>
      </div>`;
    }).join('');
  }
  $('#ml-count').textContent = `${_mlRows.length} of ${_mlTotal} · 共 ${_mlTotal} 项`;
  $('#ml-more-btn').style.display = (_mlRows.length < _mlTotal) ? '' : 'none';
  updateBulkBar();
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(0) + ' KB';
  return (n/1024/1024).toFixed(1) + ' MB';
}

function onMediaCardClick(ev, id) {
  // Cmd/Ctrl/Shift click → toggle selection; plain click → open drawer.
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || _mlSel.size > 0) {
    toggleMediaSel(id);
  } else {
    openMediaDrawer(id);
  }
}

function onCardDragStart(ev, id) {
  _mlDragId = id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(id));   // required by some browsers
}
function onCardDragEnd(ev) {
  _mlDragId = null;
  document.querySelectorAll('.ml-fld.over').forEach(el => el.classList.remove('over'));
}

function toggleMediaSel(id) {
  if (_mlSel.has(id)) _mlSel.delete(id); else _mlSel.add(id);
  const card = document.querySelector(`.ml-card[data-id="${id}"]`);
  if (card) card.classList.toggle('sel', _mlSel.has(id));
  updateBulkBar();
}

function clearMediaSelection() {
  _mlSel.clear();
  document.querySelectorAll('.ml-card.sel').forEach(c => c.classList.remove('sel'));
  updateBulkBar();
}

function updateBulkBar() {
  const bar = $('#ml-bulkbar');
  bar.classList.toggle('on', _mlSel.size > 0);
  $('#ml-sel-count').textContent = _mlSel.size;
}

// ── Upload (click, drop, paste) ─────────────────────────────────────
async function onMediaPick(ev) {
  const files = [...(ev.target.files || [])];
  ev.target.value = '';
  await uploadMediaFiles(files);
}

async function onMediaDrop(ev) {
  ev.preventDefault();
  $('#ml-dropzone').classList.remove('drag');
  const files = [...(ev.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  await uploadMediaFiles(files);
}

window.addEventListener('paste', async (ev) => {
  if (!$('#tab-media')?.classList.contains('active')) return;
  const items = [...(ev.clipboardData?.items || [])];
  const files = items.filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  ev.preventDefault();
  await uploadMediaFiles(files);
});

async function uploadMediaFiles(files) {
  if (!files.length) return;
  let ok = 0, fail = 0;
  toast(`Uploading ${files.length} file${files.length===1?'':'s'}… · 上传中`);
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('/api/retail-admin/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = await r.json();
      if (j.success) ok++; else fail++;
    } catch { fail++; }
  }
  toast(fail ? `Uploaded ${ok}, ${fail} failed · 上传 ${ok},${fail} 失败` : `Uploaded ${ok} · 已上传 ${ok}`, fail ? 'err' : 'ok');
  loadMedia();
}

// ── Drawer ──────────────────────────────────────────────────────────
function openMediaDrawer(id) {
  const m = _mlRows.find(r => r.id === id);
  if (!m) return;
  _mlEditId = id;
  _mlEditTags = (m.tags || []).slice();
  $('#ml-edit-title').textContent = m.filename || `Media #${id}`;
  $('#ml-edit-sub').textContent   = `${m.mime_type} · ${fmtBytes(m.size_bytes)}${m.width && m.height ? ` · ${m.width}×${m.height}`:''}`;
  $('#ml-edit-img').src = `/api/retail/media/${id}`;
  $('#ml-edit-filename').value = m.filename || '';
  $('#ml-edit-alt').value      = m.alt_text || '';
  $('#ml-edit-url').value      = `/api/retail/media/${id}`;
  // Populate folder select
  const sel = $('#ml-edit-folder');
  sel.innerHTML = '<option value="">(unsorted) · 未分组</option>' +
    _mlFolders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
  sel.value = m.folder_id == null ? '' : String(m.folder_id);
  const used = _mlUsage[id] || 0;
  $('#ml-edit-usage').innerHTML = used
    ? `<span style="color: var(--st-preparing); font-weight: 600;">× ${used}</span> · 被引用 ${used} 处`
    : '<span class="muted">Not used yet · 未使用</span>';
  $('#ml-edit-info').innerHTML = `<span class="muted">Uploaded · 上传于</span> ${new Date((m.uploaded_at || '').replace(' ', 'T') + 'Z').toLocaleString()}`;
  renderEditTags();
  $('#ml-edit-tag-input').value = '';
  openDrawer('#ml-edit-bg');
}

function closeMediaDrawer() { closeDrawer('#ml-edit-bg'); }
onDrawerClose('#ml-edit-bg', () => { _mlEditId = null; });

function renderEditTags() {
  const row = $('#ml-edit-tags-row');
  const input = $('#ml-edit-tag-input');
  // Clear all existing .ml-tag chips, keep the input.
  row.querySelectorAll('.ml-tag').forEach(el => el.remove());
  for (const t of _mlEditTags) {
    const chip = document.createElement('span');
    chip.className = 'ml-tag';
    chip.innerHTML = `${escapeHtml(t)} <button type="button" class="x" title="Remove · 移除">×</button>`;
    chip.querySelector('.x').onclick = () => { _mlEditTags = _mlEditTags.filter(x => x !== t); renderEditTags(); };
    row.insertBefore(chip, input);
  }
}

function onTagInputKey(ev) {
  if (ev.key === 'Enter' || ev.key === ',' || ev.key === 'Tab') {
    ev.preventDefault();
    const raw = ev.target.value.trim().replace(/,$/, '').toLowerCase();
    if (!raw) return;
    const t = raw.replace(/\s+/g, '-').slice(0, 40);
    if (t && !_mlEditTags.includes(t)) _mlEditTags.push(t);
    ev.target.value = '';
    renderEditTags();
  } else if (ev.key === 'Backspace' && !ev.target.value && _mlEditTags.length) {
    _mlEditTags.pop();
    renderEditTags();
  }
}

async function saveMediaDrawer() {
  if (!_mlEditId) return;
  // Flush any tag still typed-in-progress.
  const stub = $('#ml-edit-tag-input').value.trim().toLowerCase().replace(/\s+/g,'-');
  if (stub && !_mlEditTags.includes(stub)) _mlEditTags.push(stub);
  const folderVal = $('#ml-edit-folder').value;
  const body = {
    filename: $('#ml-edit-filename').value.trim() || null,
    alt_text: $('#ml-edit-alt').value.trim() || null,
    tags: _mlEditTags.slice(),
    folder_id: folderVal === '' ? null : parseInt(folderVal, 10),
  };
  try {
    await api(`/api/retail-admin/media/${_mlEditId}`, { method: 'PATCH', body });
    toast('Saved · 已保存');
    closeMediaDrawer();
    loadMedia();
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
}

async function deleteMediaFromDrawer() {
  if (!_mlEditId) return;
  const m = _mlRows.find(r => r.id === _mlEditId);
  const used = _mlUsage[_mlEditId] || 0;
  const warn = used ? `This media is referenced in ${used} place${used===1?'':'s'}. Delete anyway? · 此媒体被 ${used} 处引用。仍要删除吗？` : `Delete "${m?.filename || '#'+_mlEditId}"? · 删除 "${m?.filename || '#'+_mlEditId}"？`;
  if (!confirm(warn)) return;
  try {
    await api(`/api/retail-admin/media/bulk-delete`, { method: 'POST', body: { ids: [_mlEditId] } });
    toast('Deleted · 已删除');
    closeMediaDrawer();
    loadMedia();
  } catch (e) { toast('Delete failed · 删除失败: '+e.message, 'err'); }
}

async function copyMediaUrl() {
  const url = $('#ml-edit-url').value;
  try { await navigator.clipboard.writeText(url); toast('Copied · 已复制'); }
  catch { $('#ml-edit-url').select(); document.execCommand('copy'); toast('Copied · 已复制'); }
}

// Generic "copy this blob of text" — used by the kicker copy icons in the
// order drawer (Ship to, Customer, Payment, etc.). Falls back to the
// legacy execCommand path on older browsers where the clipboard API is
// blocked outside HTTPS.
async function copyToClipboard(text, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label || 'Copied'} · 已复制`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(`${label || 'Copied'} · 已复制`); }
    catch { toast('Copy failed · 复制失败', 'err'); }
    document.body.removeChild(ta);
  }
}
// Pulls the payload out of the clicked .copy-mini's data-copy attribute.
// Lets us inline `onclick="copyKicker(this, 'Ship to')"` on the icon
// without splatting potentially long addresses through escapeHtml twice.
function copyKicker(btn, label) {
  const text = btn?.dataset?.copy || '';
  copyToClipboard(text, label);
  flashCopied(btn);
}
// Briefly swap a copy button's label to a gently fading-in "Copied · 已复制",
// then restore the original. Stores the original markup on the element so
// repeated clicks always revert to the true label.
function flashCopied(btn) {
  if (!btn || btn.classList.contains('copy-mini')) return;
  if (btn._copiedOrig == null) btn._copiedOrig = btn.innerHTML;
  if (btn._copiedTimer) clearTimeout(btn._copiedTimer);
  btn.innerHTML = '<span style="display:inline-block; opacity:0; transition:opacity 1.4s ease">✓ Copied · 已复制</span>';
  requestAnimationFrame(() => {
    const span = btn.firstChild;
    if (span) span.style.opacity = '1';
  });
  btn._copiedTimer = setTimeout(() => {
    btn.innerHTML = btn._copiedOrig;
    btn._copiedTimer = null;
  }, 2200);
}
const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
// Build the small copy chip — placed next to a kicker label. `payload` is
// stored verbatim on data-copy; `label` shows in the toast.
function copyChip(payload, label) {
  if (!payload) return '';
  return `<button type="button" class="copy-mini" title="Copy · 复制" data-copy="${escapeAttr(payload)}" onclick="event.stopPropagation(); copyKicker(this, '${escapeAttr(label || 'Copied')}')">${COPY_ICON_SVG}</button>`;
}

// ── Fapiao (发票) — order-drawer block + one-click accounting export ──
// Builds a plain-text bundle (invoice header + products-only total) for the
// "Copy for accounting" button. Stored verbatim on the button's data-copy and
// pushed to the clipboard by copyKicker — newlines survive the attribute.
// Type may be unset on legacy orders (column added later) — infer company from
// a present tax ID so the export stays accurate for pre-existing invoices.
function invoiceIsCompany(o) { return o.invoice_type ? o.invoice_type === 'company' : !!o.invoice_tax_id; }
function invoiceAccountingText(o) {
  const money = n => '¥' + Number(n || 0).toFixed(2);
  const company = invoiceIsCompany(o);
  const L = [];
  L.push('开票申请 Invoice request');
  L.push('订单号 Order: ' + (o.order_no || o.id));
  L.push('类型 Type: ' + (company ? '企业 Company' : '个人 Personal'));
  L.push('抬头 Title: ' + (o.invoice_title || ''));
  if (company) L.push('税号 Tax ID: ' + (o.invoice_tax_id || ''));
  if (o.invoice_email) L.push('邮箱 Email: ' + o.invoice_email);
  L.push('————————————');
  // Accounting wants the goods amount only — no per-item detail, no delivery fee.
  // Prefer the stored products subtotal; fall back to summing line totals, then to
  // total minus shipping for legacy orders missing a subtotal column.
  const goods = (o.subtotal != null)
    ? Number(o.subtotal)
    : (Array.isArray(o.items) && o.items.length
        ? o.items.reduce((s, it) => s + Number(it.line_total || 0), 0)
        : Number(o.total || 0) - Number(o.shipping_fee || 0));
  L.push('商品总额 Products total: ' + money(goods));
  return L.join('\n');
}

function renderInvoiceBlock(o) {
  const isCompany = invoiceIsCompany(o);
  const issued = o.invoice_status === 'issued';
  // Line icons matching the backend's Feather/Lucide set (stroke=currentColor) —
  // replaces the old color emoji so the fapiao block fits the Full Circle chrome.
  const ico = (p) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -2px; margin-right: 5px;">${p}</svg>`;
  const icoReceipt = ico('<path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="13" y2="13"/>');
  const icoClipboard = ico('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>');
  const icoFile = ico('<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>');
  const icoClip = ico('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>');
  const row = (label, val, mono) => `<span style="color: var(--text-3);">${label}</span><span style="color: var(--text-1); font-weight: 600;${mono ? ' font-variant-numeric: tabular-nums;' : ''}">${escapeHtml(val || '—')}</span>`;
  const badge = `<span style="font-weight: 700; font-size: 11px; padding: 2px 9px; border-radius: 99px; ${issued ? 'background: var(--success); color: #fff;' : 'background: var(--bg-elev-2); color: var(--text-2); border: 1px solid var(--line);'}">${issued ? 'Issued · 已开' : 'Requested · 待开'}</span>`;
  const inS = 'background: var(--bg-input); border: 1px solid var(--line); color: var(--text-1); border-radius: var(--r-md); padding: 6px 9px; font-size: 12px; font-family: inherit;';
  const footer = issued
    ? `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12px;">
        ${o.invoice_number ? `<div style="margin-bottom: 4px;"><span style="color: var(--text-3);">发票号码 No.</span> <b>${escapeHtml(o.invoice_number)}</b></div>` : ''}
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          ${o.invoice_file_url ? `<a href="${escapeAttr(o.invoice_file_url)}" target="_blank" rel="noopener" class="db-btn primary" style="text-decoration: none;">${icoFile}View fapiao · 查看发票</a>` : '<span style="color: var(--text-3);">No file attached · 未附文件</span>'}
          <span style="color: var(--text-3);">${o.invoice_issued_at ? 'Issued ' + escapeHtml(String(o.invoice_issued_at).slice(0, 10)) : ''}</span>
          <a href="#" onclick="event.preventDefault(); unissueInvoice(${o.id})" style="color: var(--text-3); font-size: 11px;">edit · 修改</a>
        </div>
      </div>`
    : `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
        <input id="inv-url-${o.id}" placeholder="Fapiao link 发票链接 (or attach PDF)" style="${inS} flex: 1; min-width: 180px;">
        <input id="inv-no-${o.id}" placeholder="发票号码 (optional)" style="${inS} width: 140px;">
        <input id="inv-pdf-${o.id}" type="file" accept="application/pdf,image/*" style="display: none;" onchange="uploadInvoicePdf(${o.id}, this)">
        <button type="button" class="db-btn" onclick="document.getElementById('inv-pdf-${o.id}').click()">${icoClip}PDF / 图片</button>
        <button type="button" class="db-btn primary" onclick="markInvoiceIssued(${o.id})">Mark issued · 标记已开</button>
      </div>`;
  return `<div class="full" style="background: var(--bg-elev-1); border: 1px solid var(--line); border-radius: var(--r-md); padding: 10px 12px;">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px;">
      <span style="font-weight: 700; color: var(--text-1); font-size: 13px;">${icoReceipt}Invoice · 发票 ${badge}<span style="font-weight: 600; color: var(--text-3); font-size: 11px; margin-left: 6px;">${isCompany ? '企业 Company' : '个人 Personal'}</span></span>
      <button type="button" class="db-btn" data-copy="${escapeAttr(invoiceAccountingText(o))}" onclick="event.stopPropagation(); copyKicker(this, 'Invoice info · 开票信息')">${icoClipboard}Copy for accounting · 复制开票信息</button>
    </div>
    <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px;">
      ${row('抬头 Title', o.invoice_title)}
      ${isCompany ? row('税号 Tax ID', o.invoice_tax_id, true) : ''}
      ${row('邮箱 Email', o.invoice_email)}
    </div>
    ${footer}
  </div>`;
}

// Mark an order's fapiao issued (attach a pasted link and/or 发票号码), revert
// a mistake, or upload the fapiao PDF (→ retail_media, fills the link field).
async function markInvoiceIssued(id) {
  const url = (document.getElementById('inv-url-' + id)?.value || '').trim();
  const number = (document.getElementById('inv-no-' + id)?.value || '').trim();
  if (!url && !number) { toast('Add a fapiao link/PDF or invoice number · 请填写发票链接或号码', 'err'); return; }
  try {
    await api('/api/retail-admin/orders/' + id + '/invoice', { method: 'PUT', body: { action: 'issue', file_url: url, number } });
    toast('Invoice marked issued · 已标记开票');
    _invoiceRefreshAfter(id);
  } catch (e) { toast('Failed · 失败: ' + e.message, 'err'); }
}
async function unissueInvoice(id) {
  try {
    await api('/api/retail-admin/orders/' + id + '/invoice', { method: 'PUT', body: { action: 'unissue' } });
    toast('Back to requested · 已恢复待开');
    _invoiceRefreshAfter(id);
  } catch (e) { toast('Failed · 失败: ' + e.message, 'err'); }
}
// After issuing/reverting, refresh the views that show the fapiao state: the
// open order drawer (where invoices are issued since the Invoices tab was
// retired) and, when the Orders list is on screen, its rows/badges/chip count.
function _invoiceRefreshAfter(id) {
  if (typeof _OPEN_ORDER !== 'undefined' && _OPEN_ORDER && Number(_OPEN_ORDER.id) === Number(id)) openOrder(id);
  const sec = document.getElementById('tab-orders');
  if (sec && sec.classList.contains('active') && typeof loadOrders === 'function') loadOrders({ silent: true });
}
async function uploadInvoicePdf(id, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const isPdf = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');
  if (!isPdf && !isImage) { toast('PDF or image only · 仅限 PDF 或图片', 'err'); input.value = ''; return; }
  if (file.size > 10 * 1024 * 1024) { toast('File too large (max 10MB) · 文件过大', 'err'); input.value = ''; return; }
  toast('Uploading… · 上传中…');
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await api('/api/retail-admin/invoice-file', { method: 'POST', body: { data: reader.result } });
      const url = res && res.data && res.data.url;
      const el = document.getElementById('inv-url-' + id);
      if (el && url) el.value = url;
      toast('Attached — tap Mark issued · 已附加,点击标记已开');
    } catch (e) { toast('Upload failed · 上传失败: ' + e.message, 'err'); }
  };
  reader.readAsDataURL(file);
}

// ── Bulk ─────────────────────────────────────────────────────────────
async function bulkDeleteSelected() {
  if (!_mlSel.size) return;
  const ids = [...(_mlSel)];
  const usedCount = ids.reduce((s, id) => s + (_mlUsage[id] || 0), 0);
  const msg = usedCount
    ? `Delete ${ids.length} item${ids.length===1?'':'s'} — ${usedCount} reference${usedCount===1?'':'s'} will be broken. Continue? · 删除 ${ids.length} 项，将破坏 ${usedCount} 处引用，是否继续？`
    : `Delete ${ids.length} item${ids.length===1?'':'s'}? · 删除 ${ids.length} 项？`;
  if (!confirm(msg)) return;
  try {
    await api('/api/retail-admin/media/bulk-delete', { method: 'POST', body: { ids } });
    _mlSel.clear();
    toast('Deleted · 已删除');
    loadMedia();
  } catch (e) { toast('Delete failed · 删除失败: '+e.message, 'err'); }
}

function openBulkTagModal() {
  if (!_mlSel.size) return;
  _mlBulkAdd = []; _mlBulkRemove = [];
  $('#ml-bulk-add-input').value = ''; $('#ml-bulk-remove-input').value = '';
  renderBulkTagChips('add'); renderBulkTagChips('remove');
  $('#ml-bulktag-bg').classList.add('show');
}

function openBulkMoveMenu() {
  if (!_mlSel.size) return;
  const host = $('#ml-move-list');
  const ids = [..._mlSel];
  const row = (key, label, n) =>
    `<div class="ml-fld" onclick="doBulkMove('${key}', ${JSON.stringify(ids)})">
       <span class="ico">📁</span>
       <span class="lbl">${escapeHtml(label)}</span>
       <span class="n">${n != null ? n : ''}</span>
     </div>`;
  host.innerHTML = [
    row('unsorted', '(unsorted) · 未分组', _mlUnsortedCount),
    ..._mlFolders.map(f => row(String(f.id), f.name, f.count)),
  ].join('');
  $('#ml-move-bg').classList.add('show');
}
function closeBulkMoveMenu() { $('#ml-move-bg').classList.remove('show'); }
async function doBulkMove(key, ids) {
  closeBulkMoveMenu();
  await moveMediaTo(ids, key);
}

function closeBulkTagModal() { $('#ml-bulktag-bg').classList.remove('show'); }

function renderBulkTagChips(kind) {
  const row = $(kind === 'add' ? '#ml-bulk-add-row' : '#ml-bulk-remove-row');
  const input = row.querySelector('input');
  row.querySelectorAll('.ml-tag').forEach(el => el.remove());
  const list = kind === 'add' ? _mlBulkAdd : _mlBulkRemove;
  for (const t of list) {
    const chip = document.createElement('span');
    chip.className = 'ml-tag';
    chip.innerHTML = `${escapeHtml(t)} <button type="button" class="x" title="Remove · 移除">×</button>`;
    chip.querySelector('.x').onclick = () => {
      if (kind === 'add') _mlBulkAdd = _mlBulkAdd.filter(x => x !== t);
      else _mlBulkRemove = _mlBulkRemove.filter(x => x !== t);
      renderBulkTagChips(kind);
    };
    row.insertBefore(chip, input);
  }
}

function onBulkTagInputKey(ev, kind) {
  if (ev.key === 'Enter' || ev.key === ',' || ev.key === 'Tab') {
    ev.preventDefault();
    const raw = ev.target.value.trim().replace(/,$/, '').toLowerCase();
    if (!raw) return;
    const t = raw.replace(/\s+/g, '-').slice(0, 40);
    const list = kind === 'add' ? _mlBulkAdd : _mlBulkRemove;
    if (t && !list.includes(t)) list.push(t);
    ev.target.value = '';
    renderBulkTagChips(kind);
  }
}

async function submitBulkTag() {
  // Flush typed stubs.
  for (const k of ['add', 'remove']) {
    const inp = $(`#ml-bulk-${k}-input`);
    const stub = inp.value.trim().toLowerCase().replace(/\s+/g, '-');
    const list = k === 'add' ? _mlBulkAdd : _mlBulkRemove;
    if (stub && !list.includes(stub)) list.push(stub);
  }
  if (!_mlBulkAdd.length && !_mlBulkRemove.length) return toast('Nothing to apply · 无变更', 'err');
  try {
    await api('/api/retail-admin/media/bulk-tag', {
      method: 'POST',
      body: { ids: [..._mlSel], add: _mlBulkAdd, remove: _mlBulkRemove },
    });
    toast('Tags updated · 标签已更新');
    closeBulkTagModal();
    _mlSel.clear();
    loadMedia();
  } catch (e) { toast('Failed · 失败: '+e.message, 'err'); }
}

// ════════════════════════════════════════════════════════════════
// TOP-UP — wallet packages + transactions. (Points/loyalty rules moved to
// the Membership & points tab — see loadPointsSettings() below.)
// ════════════════════════════════════════════════════════════════
async function loadTopup() {
  await Promise.all([loadTopupPackages(), loadTopupTransactions()]);
}

// Points / loyalty rules — earn rate, point value, expiry, cover-shipping.
// The inputs now render under the Membership & points tab; we still hydrate
// them eagerly at boot since fields are looked up by id (location-independent).
async function loadPointsSettings() {
  try {
    const cfg = await api('/api/retail-admin/config');
    const pts = cfg?.data?.points || {};
    // Earn rule is two-sided: "Earn N pt per ¥M". Fall back to the legacy
    // single-key earnRate (= yuan per point) if the pair isn't seeded yet.
    const earnPoints = pts.earnPoints ?? 1;
    const earnSpend  = pts.earnSpend  ?? pts.earnRate ?? 100;
    if ($('#pts-earn-points'))    $('#pts-earn-points').value   = earnPoints;
    if ($('#pts-earn-spend'))     $('#pts-earn-spend').value    = earnSpend;
    // Earn base: 'paid' (net total after discounts) or 'subtotal' (pre-discount
    // goods value). Default 'paid' so points track what the customer paid.
    if ($('#pts-earn-base'))      $('#pts-earn-base').value     = (pts.earnBase === 'subtotal') ? 'subtotal' : 'paid';
    // Point value is the inverse of redeem rate: storage is "points per ¥1",
    // UI shows "¥ per point" (the way humans think about it). 1/N rounded to
    // 2 decimals — clean for typical values (1 → 1.00, 10 → 0.10, 100 → 0.01).
    const redeemRate = Number(pts.redeemRate) || 100;
    if ($('#pts-point-value'))    $('#pts-point-value').value   = (1 / redeemRate).toFixed(2);
    if ($('#pts-expiry-months'))  $('#pts-expiry-months').value = pts.expiryMonths ?? 12;
    if ($('#pts-cover-shipping')) $('#pts-cover-shipping').checked = !!pts.coverShipping;
    if ($('#pts-ratemsg'))        $('#pts-ratemsg').textContent = '¥' + earnSpend;
  } catch {}
}

async function loadTopupPackages() {
  const r = await api('/api/retail-admin/topup-packages');
  const rows = r?.data || [];
  const tbody = $('#tp-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">No top-up packages yet — add one above. · 暂无充值套餐 — 请在上方添加。</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(p => `
    <tr>
      <td class="numeric"><input type="number" value="${p.amount}" style="width: 100px;" onchange="updateTopup(${p.id}, 'amount', this.value)"></td>
      <td class="numeric"><input type="number" value="${p.bonus_points}" style="width: 100px;" onchange="updateTopup(${p.id}, 'bonus_points', this.value)"></td>
      <td><input type="text" value="${(p.title_en||'').replace(/"/g,'&quot;')}" style="width: 100%;" onchange="updateTopup(${p.id}, 'title_en', this.value)"></td>
      <td><input type="text" value="${(p.title_cn||'').replace(/"/g,'&quot;')}" style="width: 100%;" onchange="updateTopup(${p.id}, 'title_cn', this.value)"></td>
      <td><label style="display:inline-flex; align-items:center; gap:6px;"><input type="checkbox" ${p.is_active ? 'checked' : ''} onchange="updateTopup(${p.id}, 'is_active', this.checked ? 1 : 0)"></label></td>
      <td><button class="btn" onclick="deleteTopupPackage(${p.id}, ${p.amount})">Delete · 删除</button></td>
    </tr>
  `).join('');
}

async function addTopupPackage() {
  const amt = Number($('#tp-amount').value);
  if (!(amt > 0)) return toast('Amount required · 请填写金额', 'err');
  const body = {
    amount: amt,
    bonus_points: Math.max(0, parseInt($('#tp-bonus').value, 10) || 0),
    title_en: $('#tp-title-en').value.trim() || null,
    title_cn: $('#tp-title-cn').value.trim() || null,
  };
  try {
    await api('/api/retail-admin/topup-packages', { method: 'POST', body });
    ['tp-amount','tp-bonus','tp-title-en','tp-title-cn'].forEach(id => { const e = $('#'+id); if (e) e.value = ''; });
    toast('Package added · 套餐已添加');
    loadTopupPackages();
  } catch (e) { toast('Add failed · 添加失败: '+e.message, 'err'); }
}

async function updateTopup(id, field, val) {
  try {
    await api(`/api/retail-admin/topup-packages/${id}`, { method: 'PATCH', body: { [field]: val } });
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); loadTopupPackages(); }
}

async function deleteTopupPackage(id, amt) {
  if (!confirm(`Delete ¥${amt} top-up package? · 删除 ¥${amt} 充值套餐？`)) return;
  try {
    await api(`/api/retail-admin/topup-packages/${id}`, { method: 'DELETE' });
    toast('Package deleted · 套餐已删除');
    loadTopupPackages();
  } catch (e) { toast('Delete failed · 删除失败: '+e.message, 'err'); }
}

async function savePointsSettings() {
  const earnPoints = Math.max(1, parseInt($('#pts-earn-points').value, 10) || 1);
  const earnSpend  = Math.max(1, parseInt($('#pts-earn-spend').value, 10) || 100);
  // Point value (UI) → redeem rate (storage). Clamp ¥0.01–¥1.00 so the
  // resulting redeemRate stays a sane integer 1..100.
  const pointValue = Math.min(1, Math.max(0.01, parseFloat($('#pts-point-value').value) || 1));
  const redeemRate = Math.max(1, Math.round(1 / pointValue));
  const body = {
    'points.earnPoints':    earnPoints,
    'points.earnSpend':     earnSpend,
    // Keep the legacy single-sided key in sync so any old reader still works.
    // earnRate = "¥ per point" = earnSpend / earnPoints (rounded up so we
    // never under-charge ourselves on legacy fallback paths).
    'points.earnRate':      Math.max(1, Math.ceil(earnSpend / earnPoints)),
    'points.earnBase':      ($('#pts-earn-base')?.value === 'subtotal') ? 'subtotal' : 'paid',
    'points.redeemRate':    redeemRate,
    'points.expiryMonths':  Math.max(0, parseInt($('#pts-expiry-months').value, 10) || 0),
    'points.coverShipping': !!$('#pts-cover-shipping')?.checked,
  };
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    if ($('#pts-ratemsg')) $('#pts-ratemsg').textContent = '¥' + body['points.earnSpend'];
    toast('Saved · 已保存');
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
}

// ── Membership tiers editor (Roots Club ladder) ─────────────────────────────
// Same edit-buffer pattern as the Review tags editor. RCTIER_STATE is the
// staged copy operators mutate; saveRctiers() writes the lot in one PUT to
// /api/retail-admin/config under `roots_club.tiers`. Backend + mini-app both
// read this same blob; defaults seed the editor on first load.
const RCTIER_DEFAULTS = [
  { key: 'seed',   name_en: 'Seed',   name_cn: '种子', threshold: 0,    points_mult: 1.0, perks_en: ['5% off your first order', 'Member newsletter'],                                              perks_cn: ['首单 5% 折扣', '会员通讯'] },
  { key: 'sprout', name_en: 'Sprout', name_cn: '幼苗', threshold: 500,  points_mult: 1.2, perks_en: ['10% off all orders', 'Early access to drops', 'Free shipping ¥299+'],                         perks_cn: ['全场 10% 折扣', '新品优先购', '满 ¥299 包邮'] },
  { key: 'root',   name_en: 'Root',   name_cn: '根',   threshold: 2000, points_mult: 1.5, perks_en: ['15% off all orders', 'Early access to drops', 'Free shipping ¥199+', 'Birthday gift'],         perks_cn: ['全场 15% 折扣', '新品优先购', '满 ¥199 包邮', '生日礼物'] },
  { key: 'tree',   name_en: 'Tree',   name_cn: '大树', threshold: 5000, points_mult: 2.0, perks_en: ['20% off all orders', 'Early access to drops', 'Free shipping (no minimum)', 'Birthday gift', 'Exclusive tasting events'], perks_cn: ['全场 20% 折扣', '新品优先购', '免邮 (无门槛)', '生日礼物', '专属品鉴活动'] },
];
let RCTIER_STATE = [];
async function loadRctiers() {
  try {
    const r = await api('/api/retail-admin/config');
    const list = r?.data?.roots_club?.tiers;
    RCTIER_STATE = (Array.isArray(list) && list.length)
      ? list.map(t => ({
          key: String(t.key || '').trim(),
          name_en: String(t.name_en || '').trim(),
          name_cn: String(t.name_cn || '').trim(),
          threshold: Math.max(0, Number(t.threshold) || 0),
          points_mult: (() => { const m = Number(t.points_mult); return Number.isFinite(m) && m > 0 ? Math.max(0.1, Math.min(10, m)) : 1.0; })(),
          perks_en: Array.isArray(t.perks_en) ? t.perks_en.slice() : [],
          perks_cn: Array.isArray(t.perks_cn) ? t.perks_cn.slice() : [],
        }))
      : RCTIER_DEFAULTS.map(t => ({ ...t, perks_en: t.perks_en.slice(), perks_cn: t.perks_cn.slice() }));
  } catch {
    RCTIER_STATE = RCTIER_DEFAULTS.map(t => ({ ...t, perks_en: t.perks_en.slice(), perks_cn: t.perks_cn.slice() }));
  }
  renderRctiersTable();
}
function renderRctiersTable() {
  const tbody = document.querySelector('#rctier-table tbody');
  if (!tbody) return;
  if (!RCTIER_STATE.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted" style="padding: 8px;">No tiers — click "+ Add tier" to create one. · 暂无会员等级 — 点击"+ Add tier"创建。</td></tr>';
    return;
  }
  tbody.innerHTML = RCTIER_STATE.map((t, i) => `
    <tr>
      <td style="padding: 4px 8px;"><input type="text" value="${escapeAttr(t.key)}" oninput="updateRctier(${i},'key',this.value)" style="width: 100%;" placeholder="seed"></td>
      <td style="padding: 4px 8px;"><input type="text" value="${escapeAttr(t.name_en)}" oninput="updateRctier(${i},'name_en',this.value)" style="width: 100%;"></td>
      <td style="padding: 4px 8px;"><input type="text" value="${escapeAttr(t.name_cn)}" oninput="updateRctier(${i},'name_cn',this.value)" style="width: 100%;"></td>
      <td style="padding: 4px 8px;"><input type="number" value="${t.threshold}" min="0" step="1" oninput="updateRctier(${i},'threshold',this.value)" style="width: 100%;"></td>
      <td style="padding: 4px 8px;"><input type="number" value="${t.points_mult ?? 1}" min="0.1" max="10" step="0.1" oninput="updateRctier(${i},'points_mult',this.value)" style="width: 100%;" title="Points-earn multiplier: 1.0 = no boost, 2.0 = double points per ¥ spent"></td>
      <td style="padding: 4px 8px;"><textarea rows="3" oninput="updateRctier(${i},'perks_en',this.value)" style="width: 100%; resize: vertical; font: inherit;">${escapeHtml((t.perks_en || []).join('\n'))}</textarea></td>
      <td style="padding: 4px 8px;"><textarea rows="3" oninput="updateRctier(${i},'perks_cn',this.value)" style="width: 100%; resize: vertical; font: inherit;">${escapeHtml((t.perks_cn || []).join('\n'))}</textarea></td>
      <td style="padding: 4px 8px;"><button class="btn" onclick="removeRctier(${i})">×</button></td>
    </tr>
  `).join('');
}
function updateRctier(i, field, value) {
  if (!RCTIER_STATE[i]) return;
  if (field === 'threshold') {
    RCTIER_STATE[i].threshold = Math.max(0, parseInt(value, 10) || 0);
  } else if (field === 'points_mult') {
    // Clamp to backend-safe range so the editor and the server agree even when
    // an operator types something silly. 0 → 1.0 (no boost) so an empty cell
    // never accidentally zeroes out earns.
    const m = parseFloat(value);
    RCTIER_STATE[i].points_mult = (Number.isFinite(m) && m > 0)
      ? Math.max(0.1, Math.min(10, m))
      : 1.0;
  } else if (field === 'perks_en' || field === 'perks_cn') {
    RCTIER_STATE[i][field] = String(value || '').split('\n').map(s => s.trim()).filter(Boolean);
  } else if (field === 'key') {
    RCTIER_STATE[i].key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  } else {
    RCTIER_STATE[i][field] = String(value || '');
  }
}
function addRctierRow() {
  // New row defaults to the next ¥1000 jump above the current top tier so the
  // ladder stays monotonic without the operator doing the math.
  const top = RCTIER_STATE.reduce((m, t) => Math.max(m, Number(t.threshold) || 0), 0);
  RCTIER_STATE.push({
    key: '', name_en: '', name_cn: '', threshold: top + 1000,
    points_mult: 1.0, perks_en: [], perks_cn: [],
  });
  renderRctiersTable();
}
function removeRctier(i) {
  const t = RCTIER_STATE[i];
  if (!t) return;
  if (!confirm(`Remove tier "${t.name_en || t.key || '(unnamed)'}"? · 删除等级?`)) return;
  RCTIER_STATE.splice(i, 1);
  renderRctiersTable();
}
async function saveRctiers() {
  // Validate: every row needs a unique key, at least one row, and the lowest
  // threshold must be 0 (otherwise low-spend customers have no tier).
  const keys = new Set();
  for (const t of RCTIER_STATE) {
    if (!t.key) return toast('Every tier needs a key (e.g. seed) · 每个等级需要一个标识', 'err');
    if (keys.has(t.key)) return toast(`Duplicate tier key "${t.key}" · 等级标识重复`, 'err');
    keys.add(t.key);
  }
  if (!RCTIER_STATE.length) return toast('At least one tier is required · 至少需要一个等级', 'err');
  const lowest = RCTIER_STATE.reduce((m, t) => Math.min(m, Number(t.threshold) || 0), Infinity);
  if (lowest !== 0) return toast('The lowest tier threshold must be 0 · 最低等级门槛必须为 0', 'err');
  // Sort by threshold ascending so storage matches what customers see.
  const sorted = RCTIER_STATE.slice().sort((a, b) => (Number(a.threshold) || 0) - (Number(b.threshold) || 0));
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'roots_club.tiers': sorted } });
    toast('Tiers saved · 已保存');
    await loadRctiers();   // re-read so the table reflects the canonical sorted form
  } catch (e) { toast('Save failed · 保存失败: '+e.message, 'err'); }
}

async function loadTopupTransactions() {
  const r = await api('/api/retail-admin/topup-transactions?limit=50');
  const rows = r?.data || [];
  const tbody = $('#tp-tx-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">No top-up transactions yet. · 暂无充值记录。</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(t => `
    <tr>
      <td class="muted">${(t.created_at || '').replace('T',' ').slice(0,16)}</td>
      <td>${escapeHtml(t.nickname || '(no name) · 无名')} <span class="muted">${escapeHtml(t.phone || '')}</span></td>
      <td class="numeric">${fmt(t.amount)}</td>
      <td class="numeric">${t.bonus_points || 0}</td>
      <td>${paymentBrandHTML(t.payment_method)}</td>
      <td>${t.status}</td>
      <td class="muted" style="font-family: monospace; font-size: 11px;">${t.out_trade_no || '—'}</td>
      <td>${t.status === 'pending' ? `<button class="btn" onclick="finalizeTopupTx(${t.id})">Mark success · 标记成功</button>` : ''}</td>
    </tr>
  `).join('');
}

async function finalizeTopupTx(id) {
  if (!confirm('Mark this top-up as successful and credit the wallet? · 标记此充值为成功并入账钱包?')) return;
  try {
    await api(`/api/retail-admin/topup-transactions/${id}/finalize`, { method: 'POST' });
    toast('Top-up finalized · 充值已确认');
    loadTopupTransactions();
  } catch (e) { toast('Failed · 失败: '+e.message, 'err'); }
}

// ════════════════════════════════════════════════════════════════
// REVIEWS — staff moderation + tag editor
// ════════════════════════════════════════════════════════════════
// Live tag-label lookup. Populated by loadReviewTags() from server
// config so renaming a chip in the editor immediately re-labels every
// row in the reviews table.
let REVIEW_TAG_LABELS = {};      // { id: [en, cn] }
let REVIEW_TAGS_STATE = [];      // [{ id, en, cn, color }] — edit buffer

// Brand colours staff can pick from. Mirror miniapp app.wxss var names.
const REVIEW_TAG_COLOURS = [
  'lime', 'papaya', 'sky', 'corn', 'pea', 'cucumber', 'pink',
  'berry', 'carrot', 'lotus', 'almond', 'lemon', 'avocado', 'forest',
];

async function loadReviewTags() {
  const tbody = $('#rtags-table tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="muted">Loading… · 加载中…</td></tr>';
  try {
    const { data } = await api('/api/retail/config');
    const list = data?.reviews?.tags;
    REVIEW_TAGS_STATE = Array.isArray(list) ? list.map(t => ({
      id: String(t.id || ''),
      en: String(t.en || ''),
      cn: String(t.cn || ''),
      color: String(t.color || 'lime'),
    })) : [];
    syncReviewTagLabels();
    renderReviewTagsTable();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="err">Failed · 失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function syncReviewTagLabels() {
  REVIEW_TAG_LABELS = {};
  for (const t of REVIEW_TAGS_STATE) REVIEW_TAG_LABELS[t.id] = [t.en, t.cn];
}

function renderReviewTagsTable() {
  const tbody = $('#rtags-table tbody');
  if (!REVIEW_TAGS_STATE.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No tags yet — click "+ Add tag" to create one. · 暂无标签 — 点击"+ Add tag"创建。</td></tr>';
    return;
  }
  tbody.innerHTML = REVIEW_TAGS_STATE.map((t, i) => {
    const colourOpts = REVIEW_TAG_COLOURS.map(c =>
      `<option value="${c}" ${c === t.color ? 'selected' : ''}>${c}</option>`
    ).join('');
    return `
    <tr data-i="${i}">
      <td><input type="text" value="${escapeAttr(t.id)}" oninput="updateReviewTag(${i}, 'id', this.value)" style="width: 100%; font-family: var(--f-mono);"></td>
      <td><input type="text" value="${escapeAttr(t.en)}" oninput="updateReviewTag(${i}, 'en', this.value)" style="width: 100%;"></td>
      <td><input type="text" value="${escapeAttr(t.cn)}" oninput="updateReviewTag(${i}, 'cn', this.value)" style="width: 100%;"></td>
      <td>
        <select onchange="updateReviewTag(${i}, 'color', this.value)" style="width: 100%;">${colourOpts}</select>
      </td>
      <td><button class="btn btn-sm" onclick="removeReviewTag(${i})">×</button></td>
    </tr>`;
  }).join('');
}

function updateReviewTag(i, field, value) {
  if (!REVIEW_TAGS_STATE[i]) return;
  if (field === 'id') {
    // Slug-normalise so the DB only ever sees lowercase + hyphen ids.
    value = String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  REVIEW_TAGS_STATE[i][field] = value;
}

function addReviewTag() {
  REVIEW_TAGS_STATE.push({ id: '', en: '', cn: '', color: 'lime' });
  renderReviewTagsTable();
}

function removeReviewTag(i) {
  const t = REVIEW_TAGS_STATE[i];
  if (!t) return;
  if (t.id && !confirm(`Remove "${t.id}"? Reviews already tagged with this id will lose that chip. · 移除 "${t.id}"？已使用此标签的评价将失去该标记。`)) return;
  REVIEW_TAGS_STATE.splice(i, 1);
  renderReviewTagsTable();
}

async function saveReviewTags() {
  // Validate: no empty ids, no dupes, each has at least one label.
  const ids = new Set();
  for (const t of REVIEW_TAGS_STATE) {
    if (!t.id) { toast('Every tag needs an id · 每个标签都需要 id', 'err'); return; }
    if (ids.has(t.id)) { toast(`Duplicate id · 重复 id "${t.id}"`, 'err'); return; }
    if (!t.en && !t.cn) { toast(`Tag "${t.id}" needs a label · 标签需至少一个名称`, 'err'); return; }
    ids.add(t.id);
  }
  try {
    await api('/api/retail-admin/config', {
      method: 'PUT',
      body: { 'reviews.tags': REVIEW_TAGS_STATE },
    });
    toast('Saved · 已保存');
    await loadReviewTags();
    // Re-render the reviews table so existing rows pick up new labels.
    if (REVIEWS_LOADED) await loadReviews();
  } catch (e) {
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
}

// ════════════════════════════════════════════════════════════════
// FAQ / HELP CENTRE — edit-buffer pattern mirrors review tags above.
// Two arrays stored in storefront_config: faq.categories + faq.questions.
// Loaded together, edited locally, saved as one PUT.
// ════════════════════════════════════════════════════════════════
let FAQ_CATS = [];   // [{ id, en, cn, color }]
let FAQ_QS   = [];   // [{ id, cat, q_en, q_cn, a_en, a_cn }]

// Same colour palette as review tags — keeps both editors visually
// consistent and means category chips on Help and review-tag chips
// share the same brand-token vocabulary.
const FAQ_CAT_COLOURS = REVIEW_TAG_COLOURS;

const FAQ_DEFAULT_CATS = [
  { id: 'orders',     en: 'Orders',     cn: '订单',     color: 'lime'    },
  { id: 'delivery',   en: 'Delivery',   cn: '配送',     color: 'papaya'  },
  { id: 'products',   en: 'Products',   cn: '产品',     color: 'pink'    },
  { id: 'wallet',     en: 'Wallet',     cn: '钱包',     color: 'sky'     },
  { id: 'membership', en: 'Membership', cn: '会员',     color: 'corn'    },
  { id: 'account',    en: 'Account',    cn: '账户',     color: 'avocado' },
];

async function loadFaq() {
  const catBody = $('#faq-cats-table tbody');
  const qsList  = $('#faq-qs-list');
  if (catBody) catBody.innerHTML = '<tr><td colspan="5" class="muted">Loading… · 加载中…</td></tr>';
  if (qsList)  qsList.innerHTML  = '<div class="muted" style="padding: 16px 0;">Loading… · 加载中…</div>';
  try {
    const { data } = await api('/api/retail/config');
    const cats = data?.faq?.categories;
    const qs   = data?.faq?.questions;
    FAQ_CATS = Array.isArray(cats) && cats.length ? cats.map(c => ({
      id: String(c.id || ''),
      en: String(c.en || ''),
      cn: String(c.cn || ''),
      color: String(c.color || 'lime'),
    })) : FAQ_DEFAULT_CATS.slice();
    FAQ_QS = Array.isArray(qs) && qs.length ? qs.map(q => ({
      id: String(q.id || ''),
      cat: String(q.cat || ''),
      q_en: String(q.q_en || ''),
      q_cn: String(q.q_cn || ''),
      a_en: String(q.a_en || ''),
      a_cn: String(q.a_cn || ''),
    })) : [];
    renderFaqCatsTable();
    renderFaqQs();
  } catch (e) {
    if (catBody) catBody.innerHTML = `<tr><td colspan="5" class="err">Failed · 失败: ${escapeHtml(e.message)}</td></tr>`;
    if (qsList)  qsList.innerHTML  = `<div class="err">Failed · 失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderFaqCatsTable() {
  const tbody = $('#faq-cats-table tbody');
  if (!tbody) return;
  if (!FAQ_CATS.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No categories yet — click "+ Add category" to create one. · 暂无分类 — 点击"+ Add category"创建。</td></tr>';
    return;
  }
  tbody.innerHTML = FAQ_CATS.map((c, i) => {
    const opts = FAQ_CAT_COLOURS.map(col =>
      `<option value="${col}" ${col === c.color ? 'selected' : ''}>${col}</option>`
    ).join('');
    return `
    <tr data-i="${i}">
      <td><input type="text" value="${escapeAttr(c.id)}" oninput="updateFaqCat(${i}, 'id', this.value)" style="width: 100%; font-family: var(--f-mono);"></td>
      <td><input type="text" value="${escapeAttr(c.en)}" oninput="updateFaqCat(${i}, 'en', this.value)" style="width: 100%;"></td>
      <td><input type="text" value="${escapeAttr(c.cn)}" oninput="updateFaqCat(${i}, 'cn', this.value)" style="width: 100%;"></td>
      <td><select onchange="updateFaqCat(${i}, 'color', this.value)" style="width: 100%;">${opts}</select></td>
      <td><button class="btn btn-sm" onclick="removeFaqCat(${i})">×</button></td>
    </tr>`;
  }).join('');
}

function updateFaqCat(i, field, value) {
  if (!FAQ_CATS[i]) return;
  if (field === 'id') {
    value = String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  FAQ_CATS[i][field] = value;
  // If id changed, re-render question dropdowns so they reflect new ids.
  if (field === 'id') renderFaqQs();
}

function addFaqCategory() {
  FAQ_CATS.push({ id: '', en: '', cn: '', color: 'lime' });
  renderFaqCatsTable();
  renderFaqQs();
}

function removeFaqCat(i) {
  const c = FAQ_CATS[i];
  if (!c) return;
  const used = FAQ_QS.filter(q => q.cat === c.id).length;
  if (used && !confirm(`Remove "${c.id || '(empty)'}"? ${used} question(s) still reference it and will be left uncategorised. · 移除 "${c.id || '(empty)'}"？仍有 ${used} 个问题引用它，将变为未分类。`)) return;
  FAQ_CATS.splice(i, 1);
  renderFaqCatsTable();
  renderFaqQs();
}

function renderFaqQs() {
  const list = $('#faq-qs-list');
  if (!list) return;
  if (!FAQ_QS.length) {
    list.innerHTML = '<div class="muted" style="padding: 16px 0;">No questions yet — click "+ Add question" to write the first one. · 暂无问题 — 点击"+ 添加问题"录入第一个。</div>';
    return;
  }
  const catOpts = ['<option value="">— pick category · 选择分类 —</option>']
    .concat(FAQ_CATS.filter(c => c.id).map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.id)} · ${escapeHtml(c.en || c.cn)}</option>`))
    .join('');
  list.innerHTML = FAQ_QS.map((q, i) => `
    <div class="card" style="padding: 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-elev-1);">
      <div class="row" style="gap: 10px; align-items: center; margin-bottom: 10px;">
        <div style="font-family: var(--f-mono); font-size: 11px; color: var(--text-3); min-width: 28px;">${String(i + 1).padStart(2, '0')}</div>
        <div class="field" style="flex: 1; margin: 0;">
          <label class="stacked">Category · 分类</label>
          <select onchange="updateFaqQ(${i}, 'cat', this.value)" style="width: 100%;">
            ${catOpts.replace(`value="${escapeAttr(q.cat)}"`, `value="${escapeAttr(q.cat)}" selected`)}
          </select>
        </div>
        <div class="field" style="flex: 1; margin: 0;">
          <label class="stacked">id (optional) · 选填</label>
          <input type="text" value="${escapeAttr(q.id)}" oninput="updateFaqQ(${i}, 'id', this.value)" placeholder="auto" style="width: 100%; font-family: var(--f-mono);">
        </div>
        <div class="row" style="gap: 4px; align-self: flex-end; padding-bottom: 2px;">
          <button class="btn btn-sm" onclick="moveFaqQ(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-sm" onclick="moveFaqQ(${i}, 1)"  ${i === FAQ_QS.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-sm" onclick="removeFaqQ(${i})">×</button>
        </div>
      </div>
      <div class="row" style="gap: 12px;">
        <div class="field" style="flex: 1; margin: 0;">
          <label class="stacked">EN question</label>
          <input type="text" value="${escapeAttr(q.q_en)}" oninput="updateFaqQ(${i}, 'q_en', this.value)" placeholder="When will my order arrive?" style="width: 100%;">
        </div>
        <div class="field" style="flex: 1; margin: 0;">
          <label class="stacked">中文问题</label>
          <input type="text" value="${escapeAttr(q.q_cn)}" oninput="updateFaqQ(${i}, 'q_cn', this.value)" placeholder="订单什么时候到？" style="width: 100%;">
        </div>
      </div>
      <div class="row" style="gap: 12px; margin-top: 10px;">
        <div class="field" style="flex: 1; margin: 0;">
          <label class="stacked">EN answer</label>
          <textarea oninput="updateFaqQ(${i}, 'a_en', this.value)" placeholder="Standard orders ship within 24 hours…" style="width: 100%; min-height: 80px; font-size: 12px;">${escapeHtml(q.a_en)}</textarea>
        </div>
        <div class="field" style="flex: 1; margin: 0;">
          <label class="stacked">中文回答</label>
          <textarea oninput="updateFaqQ(${i}, 'a_cn', this.value)" placeholder="标准订单 24 小时内发货…" style="width: 100%; min-height: 80px; font-size: 12px;">${escapeHtml(q.a_cn)}</textarea>
        </div>
      </div>
    </div>
  `).join('');
}

function updateFaqQ(i, field, value) {
  if (!FAQ_QS[i]) return;
  if (field === 'id') {
    value = String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  FAQ_QS[i][field] = value;
}

function addFaqQuestion() {
  FAQ_QS.push({ id: '', cat: FAQ_CATS[0]?.id || '', q_en: '', q_cn: '', a_en: '', a_cn: '' });
  renderFaqQs();
}

function removeFaqQ(i) {
  const q = FAQ_QS[i];
  if (!q) return;
  if ((q.q_en || q.q_cn) && !confirm(`Remove "${q.q_en || q.q_cn}"? · 移除 "${q.q_en || q.q_cn}"？`)) return;
  FAQ_QS.splice(i, 1);
  renderFaqQs();
}

function moveFaqQ(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= FAQ_QS.length) return;
  const tmp = FAQ_QS[i]; FAQ_QS[i] = FAQ_QS[j]; FAQ_QS[j] = tmp;
  renderFaqQs();
}

// Legal pages live in the Content group (moved out of Settings 2026-06-08). They
// save on their own button via a partial config PUT, mirroring the keys that used
// to ride along in saveConfig().
async function saveLegal() {
  const status = $('#legal-status');
  if (status) { status.textContent = 'Saving… · 保存中…'; status.style.color = ''; }
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    'legal.privacy.body_en': $('#cfg-legal-privacy-en').value,
    'legal.privacy.body_cn': $('#cfg-legal-privacy-cn').value,
    'legal.terms.body_en':   $('#cfg-legal-terms-en').value,
    'legal.terms.body_cn':   $('#cfg-legal-terms-cn').value,
    'legal.privacy.updated_at': today,
    'legal.terms.updated_at':   today,
  };
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    if (status) { status.innerHTML = '<span class="ok">Saved ✓ · 已保存</span>'; }
    toast('Saved · 已保存');
  } catch (e) {
    if (status) { status.textContent = 'Save failed · 保存失败'; status.style.color = 'var(--danger)'; }
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
}

async function saveFaq() {
  const status = $('#faq-status');
  status.textContent = 'Saving… · 保存中…';

  // Validate categories: unique non-empty ids + at least one label.
  const catIds = new Set();
  for (const c of FAQ_CATS) {
    if (!c.id) { status.innerHTML = '<span class="err">Every category needs an id · 每个分类都需要 id</span>'; return; }
    if (catIds.has(c.id)) { status.innerHTML = `<span class="err">Duplicate category id · 分类 id 重复 "${escapeHtml(c.id)}"</span>`; return; }
    if (!c.en && !c.cn) { status.innerHTML = `<span class="err">Category "${escapeHtml(c.id)}" needs a label · 分类需要名称</span>`; return; }
    catIds.add(c.id);
  }

  // Auto-assign question ids if missing — keeps the schema stable for
  // analytics/feedback hits without forcing staff to type slugs.
  const qIds = new Set();
  const payloadQs = FAQ_QS.map((q, i) => {
    let id = q.id;
    if (!id) {
      const base = (q.q_en || q.q_cn || `q-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      id = `q-${base || (i + 1)}`;
    }
    let unique = id, n = 2;
    while (qIds.has(unique)) unique = `${id}-${n++}`;
    qIds.add(unique);
    return { ...q, id: unique };
  });

  // Sanity-check that each question has a category and at least one Q/A pair.
  for (const q of payloadQs) {
    if (!q.cat) { status.innerHTML = `<span class="err">Question "${escapeHtml(q.q_en || q.q_cn || q.id)}" needs a category · 该问题需要选择分类</span>`; return; }
    if (!q.q_en && !q.q_cn) { status.innerHTML = `<span class="err">Question "${escapeHtml(q.id)}" needs a Q in at least one language · 问题至少需一种语言</span>`; return; }
    if (!q.a_en && !q.a_cn) { status.innerHTML = `<span class="err">Question "${escapeHtml(q.id)}" needs an A in at least one language · 回答至少需一种语言</span>`; return; }
  }

  try {
    await api('/api/retail-admin/config', {
      method: 'PUT',
      body: {
        'faq.categories': FAQ_CATS,
        'faq.questions':  payloadQs,
      },
    });
    FAQ_QS = payloadQs;  // keep buffer in sync with auto-assigned ids
    renderFaqQs();
    status.innerHTML = '<span class="ok">Saved ✓ · 已保存</span>';
    toast('FAQ saved · 常见问题已保存');
  } catch (e) {
    status.innerHTML = '<span class="err">Failed · 失败: ' + escapeHtml(e.message) + '</span>';
  }
}

let REVIEWS_LOADED = false;
// Cache of the last-loaded rows keyed by `${source}:${id}` so the Reply
// composer can pre-fill the existing reply without a refetch.
let REVIEWS_BY_KEY = {};

async function loadReviews() {
  const tbody = $('#reviews-table tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted">Loading… · 加载中…</td></tr>';
  const qs = new URLSearchParams();
  const vis    = $('#rv-visible').value;
  const rating = $('#rv-rating').value;
  const pid    = $('#rv-product').value.trim();
  if (vis !== '')  qs.set('visible', vis);
  if (rating)      qs.set('rating', rating);
  if (pid)         qs.set('product_id', pid);
  qs.set('limit', '100');
  try {
    const { data, meta } = await api('/api/retail-admin/reviews?' + qs.toString());
    const s = meta?.summary;
    $('#rv-summary').textContent = s
      ? cuT(`${s.total} total · ${s.visible || 0} visible · ${s.hidden || 0} hidden`, `共 ${s.total} · 显示 ${s.visible || 0} · 隐藏 ${s.hidden || 0}`)
      : '';
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">' + ICONS.empty + '</div><h3>No reviews match · 无匹配评价</h3><p class="muted">Adjust the filters above, or wait for delivered orders. · 请调整上方筛选,或等待订单送达。</p></div></td></tr>';
      return;
    }
    REVIEWS_BY_KEY = {};
    for (const r of data) REVIEWS_BY_KEY[`${r.source || 'real'}:${r.id}`] = r;
    tbody.innerHTML = data.map(renderReviewRow).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="err">Failed · 失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderReviewRow(r) {
  const stars = '★'.repeat(r.rating) + '<span style="color:var(--text-4)">' + '★'.repeat(5 - r.rating) + '</span>';
  const productName = r.product_name_en || r.product_name_cn || ('#' + r.product_id);
  const productSub  = r.product_name_cn && r.product_name_en ? r.product_name_cn : '';
  const synthetic = r.source === 'synthetic';
  const customer = r.customer_name || (synthetic ? '—' : ('#' + r.customer_id));
  const orderNo = r.order_no ? `<span class="muted" style="font-size: 11px;">${escapeHtml(r.order_no)}</span>` : '';
  // Admin-only badge so staff can tell seeded reviews apart (customers never
  // see this — the storefront shows them as ordinary reviews).
  const seededBadge = synthetic
    ? `<span class="pill neutral" style="font-size: 9px; margin-left: 4px;" title="${escapeAttr(cuT('Seeded review (not a real purchase)','种子评价(非真实购买)'))}">${escapeHtml(cuT('Seeded','种子'))}</span>`
    : '';

  const tagsHtml = (r.tags || []).map(id => {
    const label = (REVIEW_TAG_LABELS[id] || [id])[0];
    return `<span class="pill neutral" style="font-size: 10px; margin-right: 4px;">${escapeHtml(label)}</span>`;
  }).join('');

  const photosHtml = (r.photos || []).map(url => (
    `<img src="${escapeAttr(url)}" onclick="openReviewLightbox(${JSON.stringify(url).replace(/"/g, '&quot;')})" style="width: 48px; height: 48px; object-fit: cover; border-radius: 4px; margin-right: 4px; cursor: zoom-in; vertical-align: middle;">`
  )).join('');

  const commentHtml = r.comment
    ? `<div style="font-size: 12px; line-height: 1.4; max-width: 480px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(r.comment)}</div>`
    : '<div class="muted" style="font-size: 11px;">(no comment) · 无评论</div>';

  // Merchant reply — a public seller response shown under the review on the
  // storefront. When present, render it inline so staff see what's live.
  const replyHtml = r.reply
    ? `<div style="margin-top: 8px; padding: 6px 8px; border-left: 2px solid var(--accent); background: var(--bg-2, rgba(0,0,0,.03)); border-radius: 0 4px 4px 0; max-width: 480px;">
         <div class="muted" style="font-size: 10px; font-weight: 600; letter-spacing: .04em;">${escapeHtml(cuT('YOUR REPLY', '商家回复'))}</div>
         <div style="font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;">${escapeHtml(r.reply)}</div>
       </div>`
    : '';

  return `
    <tr data-id="${r.id}" ${r.is_visible ? '' : 'style="opacity:.55"'}>
      <td><span style="color: var(--accent); font-size: 14px; letter-spacing: 1px;">${stars}</span></td>
      <td>
        <div style="font-weight: 600;">${escapeHtml(productName)}</div>
        ${productSub ? `<div class="muted" style="font-size: 11px;">${escapeHtml(productSub)}</div>` : ''}
        <div class="muted" style="font-size: 10px;">#${r.product_id}</div>
      </td>
      <td>
        <div>${escapeHtml(customer)}${seededBadge}</div>
        ${orderNo}
      </td>
      <td>
        ${commentHtml}
        ${tagsHtml ? `<div style="margin-top: 6px;">${tagsHtml}</div>` : ''}
        ${photosHtml ? `<div style="margin-top: 8px;">${photosHtml}</div>` : ''}
        ${replyHtml}
      </td>
      <td class="muted" style="font-size: 11px; white-space: nowrap;">${r.created_at ? r.created_at.slice(0, 16) : ''}</td>
      <td><span class="pill ${r.is_visible ? 'pub' : 'draft'}"><span class="dot"></span>${r.is_visible ? 'Visible · 显示' : 'Hidden · 隐藏'}</span></td>
      <td style="white-space: nowrap;">
        <button class="btn btn-sm" onclick="replyReview(${r.id}, '${synthetic ? 'synthetic' : 'real'}')">
          ${r.reply ? 'Edit reply · 编辑回复' : 'Reply · 回复'}
        </button>
        <button class="btn btn-sm" onclick="toggleReview(${r.id}, ${r.is_visible ? 0 : 1}, '${synthetic ? 'synthetic' : 'real'}')">
          ${r.is_visible ? 'Hide · 隐藏' : 'Restore · 恢复'}
        </button>
        ${synthetic ? `<button class="btn btn-sm" style="color: var(--danger, #c0392b);" onclick="deleteReview(${r.id})">Remove · 删除</button>` : ''}
      </td>
    </tr>`;
}

async function toggleReview(id, visible, source) {
  try {
    await api('/api/retail-admin/reviews/' + id, {
      method: 'PATCH',
      body: { is_visible: !!visible, source: source || 'real' },
    });
    toast(visible ? 'Restored · 已恢复' : 'Hidden · 已隐藏');
    await loadReviews();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

// Hard-remove a seeded (synthetic) review. Real customer reviews aren't
// deletable from here — they can only be hidden — so this is only wired to
// synthetic rows.
async function deleteReview(id) {
  if (!confirm(cuT('Remove this seeded review for good?', '永久删除这条种子评价?'))) return;
  try {
    await api('/api/retail-admin/reviews/' + id + '?source=synthetic', { method: 'DELETE' });
    toast(cuT('Removed', '已删除'));
    await loadReviews();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

// Write or edit the public merchant reply shown under a review on the
// storefront. Blank submission clears an existing reply.
async function replyReview(id, source) {
  const cur = REVIEWS_BY_KEY[`${source || 'real'}:${id}`];
  const existing = (cur && cur.reply) || '';
  const next = prompt(
    cuT('Your public reply to this review (customers see it under their review). Leave blank to remove.',
        '对这条评价的公开回复(顾客会在自己的评价下看到)。留空则删除回复。'),
    existing);
  if (next === null) return;            // cancelled
  const reply = next.trim();
  if (reply === existing.trim()) return; // no change
  try {
    await api('/api/retail-admin/reviews/' + id, {
      method: 'PATCH',
      body: { reply, source: source || 'real' },
    });
    toast(reply ? cuT('Reply saved', '回复已保存') : cuT('Reply removed', '回复已删除'));
    await loadReviews();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

function openReviewLightbox(url) {
  $('#rv-lightbox-img').src = url;
  $('#rv-lightbox').style.display = 'flex';
}
function closeReviewLightbox() {
  $('#rv-lightbox').style.display = 'none';
  $('#rv-lightbox-img').src = '';
}

document.querySelector('[data-tab="reviews"]').addEventListener('click', () => {
  if (!REVIEWS_LOADED) {
    REVIEWS_LOADED = true;
    // Tags first so the reviews table can render with the right labels.
    loadReviewTags().then(loadReviews);
  }
});

// ═══════════════════════════════════════════════════════════════════
// FEEDBACK TAB — read-only inbox of customer bug reports from the mini app
// ═══════════════════════════════════════════════════════════════════
let FEEDBACK_LOADED = false;

async function loadFeedback() {
  const tbody = $('#feedback-table tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="muted">Loading…</td></tr>';
  try {
    const { data, meta } = await api('/api/retail-admin/feedback?limit=200');
    const n = meta?.total ?? data.length;
    $('#fb-summary').textContent = `${n} report${n === 1 ? '' : 's'} · 共 ${n} 条`;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><div class="icon">' + ICONS.empty + '</div><h3>No feedback yet · 暂无反馈</h3><p class="muted">Customer bug reports from the mini app show up here. · 顾客在小程序提交的反馈会显示在这里。</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = data.map(renderFeedbackRow).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="err">Failed · 失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function feedbackStatusPill(f) {
  // needs_reply covers a brand-new report and an unanswered follow-up alike.
  if (f.needs_reply) {
    return `<span class="pill warn" style="font-size: 10px;">${cuT('Needs reply', '待回复')}</span>`;
  }
  if (f.replied) {
    return `<span class="pill ok" style="font-size: 10px;">${cuT('Replied', '已回复')}</span>`;
  }
  return '';
}

function renderFeedbackRow(f) {
  const customer = f.customer_name || f.nickname || ('#' + f.customer_id);
  const photosHtml = (f.photos || []).map(url => (
    `<img src="${escapeAttr(url)}" onclick="event.stopPropagation();openReviewLightbox(${JSON.stringify(url).replace(/"/g, '&quot;')})" style="width: 48px; height: 48px; object-fit: cover; border-radius: 4px; margin-right: 4px; cursor: zoom-in; vertical-align: middle;">`
  )).join('');
  const ctx = f.page_context
    ? `<span class="pill neutral" style="font-size: 10px;">${escapeHtml(f.page_context)}</span>`
    : '<span class="muted" style="font-size: 11px;">—</span>';
  const ver = f.app_version ? `<div class="muted" style="font-size: 10px; margin-top: 4px;">v${escapeHtml(f.app_version)}</div>` : '';
  const replyTag = f.reply_count > 0
    ? `<span class="muted" style="font-size: 10px;">${cuT(f.reply_count + ' repl' + (f.reply_count === 1 ? 'y' : 'ies'), f.reply_count + ' 条往来')}</span>`
    : '';
  // Direct messages staff started (vs customer-filed bug reports) get a tag so
  // the shared inbox stays legible.
  const kindTag = f.kind === 'message'
    ? `<span class="pill neutral" style="font-size: 10px;">${cuT('✉ Message', '✉ 消息')}</span>`
    : '';
  return `
    <tr data-id="${f.id}" onclick="openFeedbackThread(${f.id})" style="cursor: pointer;">
      <td>
        <div>${escapeHtml(customer)}</div>
        <div class="muted" style="font-size: 10px;">#${f.customer_id}</div>
      </td>
      <td>
        <div style="font-size: 12px; line-height: 1.4; max-width: 520px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(f.message || '')}</div>
        ${photosHtml ? `<div style="margin-top: 8px;">${photosHtml}</div>` : ''}
        <div style="margin-top: 6px; display: flex; gap: 8px; align-items: center;">${kindTag}${feedbackStatusPill(f)}${replyTag}</div>
      </td>
      <td>${ctx}${ver}</td>
      <td class="muted" style="font-size: 11px; white-space: nowrap;">${f.created_at ? f.created_at.slice(0, 16) : ''}</td>
    </tr>`;
}

document.querySelector('[data-tab="feedback"]').addEventListener('click', () => {
  if (!FEEDBACK_LOADED) {
    FEEDBACK_LOADED = true;
    loadFeedback();
  }
});

// ── Feedback thread drawer — read the conversation and reply ───────────────
let _fbThreadId = null;

function fbBubble(m) {
  const mine = m.author === 'admin';
  const who = mine
    ? (m.author_name ? escapeHtml(m.author_name) : cuT('Store', '商家'))
    : cuT('Customer', '顾客');
  const when = m.created_at ? escapeHtml(m.created_at.slice(0, 16)) : '';
  return `
    <div class="fb-msg ${mine ? 'fb-msg-admin' : 'fb-msg-cust'}">
      <div class="fb-msg-meta">${who}${when ? ' · ' + when : ''}</div>
      <div class="fb-msg-body">${escapeHtml(m.body || '')}</div>
    </div>`;
}

async function openFeedbackThread(id) {
  _fbThreadId = id;
  openDrawer('#fb-drawer');
  const body = $('#fb-thread-body');
  body.innerHTML = `<div class="muted">${cuT('Loading…', '加载中…')}</div>`;
  $('#fb-reply-input').value = '';
  try {
    const { data } = await api('/api/retail-admin/feedback/' + id);
    const customer = data.customer_name || ('#' + data.customer_id);
    const ctx = data.page_context
      ? `<span class="pill neutral" style="font-size: 10px;">${escapeHtml(data.page_context)}</span>` : '';
    const photos = (data.photos || []).map(url => (
      `<img src="${escapeAttr(url)}" onclick="openReviewLightbox(${JSON.stringify(url).replace(/"/g, '&quot;')})" style="width: 56px; height: 56px; object-fit: cover; border-radius: 4px; margin: 0 4px 4px 0; cursor: zoom-in;">`
    )).join('');
    $('#fb-thread-customer').innerHTML =
      `${escapeHtml(customer)} <span class="muted" style="font-size:11px;">#${data.customer_id}</span> ${ctx}`;
    body.innerHTML =
      data.messages.map(fbBubble).join('') +
      (photos ? `<div class="fb-photos">${photos}</div>` : '');
    body.scrollTop = body.scrollHeight;
  } catch (e) {
    body.innerHTML = `<div class="err">${cuT('Failed to load', '加载失败')}: ${escapeHtml(e.message)}</div>`;
  }
}

async function sendFeedbackReply() {
  if (_fbThreadId == null) return;
  const input = $('#fb-reply-input');
  const message = (input.value || '').trim();
  if (!message) { input.focus(); return; }
  const btn = $('#fb-reply-send');
  btn.disabled = true;
  try {
    await api('/api/retail-admin/feedback/' + _fbThreadId + '/reply', { method: 'POST', body: { message } });
    toast(cuT('Reply sent · customer notified', '已回复 · 已通知顾客'), 'ok');
    await openFeedbackThread(_fbThreadId);   // re-render thread (input cleared inside)
    loadFeedback();                          // refresh list pills
  } catch (e) {
    toast(cuT('Failed to send', '发送失败') + ': ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FLASH SALES TAB — schedule per-product flash-sale windows
// ═══════════════════════════════════════════════════════════════════
let FLASH_LOADED = false;
let _fsProducts = null;       // cache of published products (for the picker)

function fsLocalDatetime(iso) {
  // Convert ISO (UTC) → 'YYYY-MM-DDTHH:mm' in local time for the picker.
  if (!iso) return '';
  let d;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) {
    d = new Date(iso.replace(' ', 'T') + 'Z');
  } else {
    d = new Date(iso);
  }
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fsFormatWindow(starts, ends) {
  function fmt(s) {
    if (!s) return null;
    const d = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
      ? new Date(s.replace(' ', 'T') + 'Z') : new Date(s);
    if (isNaN(d.getTime())) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const s = fmt(starts), e = fmt(ends);
  if (!e) return '<span class="muted">—</span>';
  return `<span style="font-family: var(--f-mono); font-size: 11px;">${s ? escapeHtml(s) : '<span class="muted">now</span>'} → ${escapeHtml(e)}</span>`;
}

async function fsEnsureProducts() {
  if (_fsProducts) return _fsProducts;
  try {
    const j = await api('/api/retail-admin/products?published=1');
    _fsProducts = (j.data || []).filter(p => p.is_published);
  } catch {
    _fsProducts = [];
  }
  return _fsProducts;
}

// Currently-selected product object (or null). Picker shows it in the trigger
// and `fsUpdatePriceHint()` reads `.sell_price` for the discount math.
let _fsSelected = null;
let _fsPickerFocusIdx = -1;
let _fsPickerOpen = false;

function fsThumbHtml(p) {
  const src = p && (p.image_url || p.image_data) || '';
  if (src) return `<img src="${escapeAttr(src)}" alt="">`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
}

function fsRenderPickerTrigger() {
  const thumb = $('#fs-picker-thumb');
  const label = $('#fs-picker-label');
  const hidden = $('#fs-product');
  if (_fsSelected) {
    thumb.innerHTML = fsThumbHtml(_fsSelected);
    const name = [_fsSelected.name_en, _fsSelected.name_cn].filter(Boolean).join(' · ') || ('#' + _fsSelected.id);
    const sku = _fsSelected.sku ? `<span class="sku">[${escapeHtml(_fsSelected.sku)}]</span>` : '';
    const price = _fsSelected.sell_price ? `<span class="pr">¥${fmt(_fsSelected.sell_price)}</span>` : '';
    label.classList.remove('empty');
    label.innerHTML = `${escapeHtml(name)}${sku}${price}`;
    hidden.value = String(_fsSelected.id);
  } else {
    thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    label.classList.add('empty');
    label.textContent = '— pick a product · 选择产品 —';
    hidden.value = '';
  }
}

async function fsPickerRenderList(filter) {
  const list = await fsEnsureProducts();
  const q = (filter || '').trim().toLowerCase();
  const filtered = q
    ? list.filter(p => `${p.name_en || ''} ${p.name_cn || ''} ${p.sku || ''}`.toLowerCase().includes(q))
    : list;
  const mount = $('#fs-picker-list');
  if (!filtered.length) {
    mount.innerHTML = `<div class="fs-picker-empty">${q ? 'No products match · 无匹配产品 — try a different search.' : 'No products in the system yet · 系统中暂无产品。'}</div>`;
    _fsPickerFocusIdx = -1;
    return;
  }
  mount.innerHTML = filtered.slice(0, 200).map((p, i) => {
    const name = [p.name_en, p.name_cn].filter(Boolean).join(' · ') || ('#' + p.id);
    const subBits = [];
    if (p.sku) subBits.push(p.sku);
    if (p.size) subBits.push(p.size);
    const sub = subBits.join(' · ');
    const price = p.sell_price ? `¥${fmt(p.sell_price)}` : '';
    const isSel = _fsSelected && _fsSelected.id === p.id ? ' selected' : '';
    const draft = !p.is_published ? ' draft' : '';
    return `<div class="fs-picker-item${isSel}${draft}" data-id="${p.id}" data-idx="${i}">
      <div class="thumb">${fsThumbHtml(p)}</div>
      <div class="info">
        <div class="name">${escapeHtml(name)}</div>
        ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
      </div>
      ${price ? `<div class="price">${price}</div>` : ''}
    </div>`;
  }).join('');
  _fsPickerFocusIdx = -1;
  mount.querySelectorAll('.fs-picker-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.id, 10);
      const product = filtered.find(p => p.id === id);
      if (product) fsPickProduct(product);
    });
  });
}

function fsPickProduct(product) {
  _fsSelected = product || null;
  fsRenderPickerTrigger();
  fsPickerClose();
  fsUpdatePriceHint();
}

function fsPickerOpen() {
  if (_fsPickerOpen) return;
  const picker = $('#fs-picker');
  if (picker.classList.contains('disabled')) return;
  picker.classList.add('open');
  $('#fs-picker-pop').hidden = false;
  $('#fs-picker-search').value = '';
  _fsPickerOpen = true;
  fsPickerRenderList('');
  setTimeout(() => $('#fs-picker-search').focus(), 0);
}

function fsPickerClose() {
  if (!_fsPickerOpen) return;
  $('#fs-picker').classList.remove('open');
  $('#fs-picker-pop').hidden = true;
  _fsPickerOpen = false;
}

function fsPickerToggle() {
  _fsPickerOpen ? fsPickerClose() : fsPickerOpen();
}

document.addEventListener('click', (e) => {
  // Close picker when click lands outside it.
  if (!_fsPickerOpen) return;
  if (e.target.closest('#fs-picker')) return;
  fsPickerClose();
});

async function fsPopulateProductSelect(selectedId) {
  const list = await fsEnsureProducts();
  if (selectedId != null && selectedId !== '') {
    _fsSelected = list.find(p => String(p.id) === String(selectedId)) || null;
  } else {
    _fsSelected = null;
  }
  fsRenderPickerTrigger();
  fsUpdatePriceHint();
}

function fsUpdatePriceHint() {
  const regular = Number(_fsSelected?.sell_price) || 0;
  const flash = Number($('#fs-price').value) || 0;
  const hint = $('#fs-price-hint');
  if (!_fsSelected) { hint.textContent = ''; return; }
  if (!regular) { hint.textContent = `${escapeHtml(_fsSelected.name_en || '')} has no regular price set — set one in the kitchen admin first. · 该产品未设置原价，请先在后厨后台设置。`; return; }
  if (!flash) {
    hint.innerHTML = `Regular price: <b>¥${fmt(regular)}</b>. Enter a lower price above to activate the discount. · 原价 ¥${fmt(regular)}，在上方输入更低的价格以启用折扣。`;
    return;
  }
  if (flash >= regular) {
    hint.innerHTML = `<span class="err">Flash price (¥${fmt(flash)}) must be lower than regular ¥${fmt(regular)} or the discount won't apply. · 秒杀价必须低于原价，否则折扣不生效。</span>`;
    return;
  }
  const off = regular - flash;
  const pct = Math.round((off / regular) * 100);
  hint.innerHTML = `Saves <b>¥${fmt(off)}</b> (${pct}% off) vs regular ¥${fmt(regular)}. · 比原价省 ¥${fmt(off)}（${pct}% off）。`;
}

// ─── Datetime quick-pick chips ─────────────────────────────────────────
function fsPad(n) { return String(n).padStart(2, '0'); }
function fsDateToLocalInput(d) {
  return `${d.getFullYear()}-${fsPad(d.getMonth() + 1)}-${fsPad(d.getDate())}T${fsPad(d.getHours())}:${fsPad(d.getMinutes())}`;
}
function fsParseLocalInput(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function fsApplyQuick(spec) {
  const [field, action] = spec.split(':');
  const el = field === 'starts' ? $('#fs-starts') : $('#fs-ends');
  if (action === 'clear') { el.value = ''; return; }
  if (action === 'now') { el.value = fsDateToLocalInput(new Date()); return; }
  if (action === 'tomorrow-9') {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    el.value = fsDateToLocalInput(d); return;
  }
  // +1h | +6h | +24h | +3d | +7d
  const m = action.match(/^\+(\d+)([hd])$/);
  if (!m) return;
  const n = parseInt(m[1], 10);
  // Ends-at deltas anchor to the current Starts value when set, else now.
  // Starts-at +1h anchors to now (so the chip means "an hour from now").
  let base;
  if (field === 'ends') {
    base = fsParseLocalInput($('#fs-starts').value) || new Date();
  } else {
    base = new Date();
  }
  const ms = m[2] === 'h' ? n * 3600 * 1000 : n * 86400 * 1000;
  el.value = fsDateToLocalInput(new Date(base.getTime() + ms));
}
document.addEventListener('click', e => {
  const chip = e.target.closest('[data-fs-quick]');
  if (!chip) return;
  e.preventDefault();
  fsApplyQuick(chip.dataset.fsQuick);
});

function fsCancelEdit() {
  fsPickerClose();
  $('#fs-edit-product-id').value = '';
  $('#fs-form-title').textContent = cuT('New flash sale', '新建秒杀');
  $('#fs-save-label').textContent = cuT('Save flash sale', '保存秒杀');
  $('#fs-cancel-btn').style.display = 'none';
  $('#fs-picker').classList.remove('disabled');
  _fsSelected = null;
  fsRenderPickerTrigger();
  $('#fs-price').value = '';
  $('#fs-stock').value = '';
  $('#fs-starts').value = '';
  $('#fs-ends').value = '';
  $('#fs-no-coupon').checked = false;
  fsUpdatePriceHint();
}

function fsStartEdit(row) {
  fsPickerClose();
  $('#fs-edit-product-id').value = row.id;
  $('#fs-form-title').textContent = cuT('Edit flash sale — ', '编辑秒杀 — ') + (row.name_en || ('#' + row.id));
  $('#fs-save-label').textContent = cuT('Update flash sale', '更新秒杀');
  $('#fs-cancel-btn').style.display = '';
  $('#fs-picker').classList.add('disabled');
  fsPopulateProductSelect(row.id);
  $('#fs-price').value = row.flash_price || '';
  $('#fs-stock').value = row.flash_stock_limit ?? '';
  $('#fs-starts').value = fsLocalDatetime(row.flash_starts_at);
  $('#fs-ends').value = fsLocalDatetime(row.flash_ends_at);
  $('#fs-no-coupon').checked = !!row.no_coupon_on_flash;
  fsUpdatePriceHint();
  document.querySelector('#tab-flash .card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function fsSave() {
  const productId = $('#fs-edit-product-id').value || $('#fs-product').value;
  if (!productId) { toast('Pick a product first · 请先选择产品', 'err'); return; }
  const price = Number($('#fs-price').value);
  if (!(price > 0)) { toast('Flash price required · 请填写秒杀价', 'err'); return; }
  const endsLocal = $('#fs-ends').value;
  if (!endsLocal) { toast('End time required · 请填写结束时间', 'err'); return; }
  const startsLocal = $('#fs-starts').value;
  const body = {
    flash_price: price,
    flash_ends_at: new Date(endsLocal).toISOString(),
    flash_starts_at: startsLocal ? new Date(startsLocal).toISOString() : null,
    flash_stock_limit: $('#fs-stock').value ? Number($('#fs-stock').value) : null,
    no_coupon_on_flash: $('#fs-no-coupon').checked ? 1 : 0,
  };
  try {
    await api(`/api/retail-admin/products/${productId}/flash-sale`, { method: 'PUT', body });
    toast('Flash sale saved · 秒杀已保存');
    fsCancelEdit();
    await fsLoadList();
  } catch (e) {
    const map = {
      flash_price_invalid: 'Flash price must be greater than 0 · 秒杀价必须大于 0',
      flash_ends_at_required: 'End time required · 请填写结束时间',
      flash_ends_at_invalid: 'End time invalid · 结束时间无效',
      flash_starts_at_invalid: 'Start time invalid · 开始时间无效',
      flash_starts_after_ends: 'Start time must be before end time · 开始时间必须早于结束时间',
      flash_stock_limit_invalid: 'Stock cap must be a positive number · 库存上限必须为正数',
    };
    toast('Failed · 失败: ' + (map[e.message] || e.message), 'err');
  }
}

async function fsClearSale(productId, name) {
  if (!confirm(`Clear the flash sale on "${name}"?\n\nThe product will revert to its regular price immediately. This can't be undone. · 清除 "${name}" 的秒杀？\n\n商品将立即恢复原价，此操作无法撤销。`)) return;
  try {
    await api(`/api/retail-admin/products/${productId}/flash-sale`, { method: 'DELETE' });
    toast('Flash sale cleared · 秒杀已清除');
    if ($('#fs-edit-product-id').value === String(productId)) fsCancelEdit();
    await fsLoadList();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

const FS_STATE_PILL = {
  // Flash window status — uses the shared semantic pill variants so the
  // strip matches Vouchers, Orders, Reviews, etc. Don't reintroduce
  // inline styles here; add a new .pill.* variant if you need a new tone.
  get active()   { return `<span class="pill success"><span class="dot"></span>${cuT('ACTIVE','进行中')}</span>`; },
  get upcoming() { return `<span class="pill info"><span class="dot"></span>${cuT('UPCOMING','即将开始')}</span>`; },
  get ended()    { return `<span class="pill neutral"><span class="dot"></span>${cuT('ENDED','已结束')}</span>`; },
  none:     '<span class="muted">—</span>',
};

// Mirror "any flash sale currently active" onto the Flash sales nav row as a
// LIVE pill, the same way body.vot-open drives the Voting OPEN pill.
function fsUpdateNavState(rows) {
  const live = (rows || []).some(p => p.flash_state === 'active' && p.is_published);
  document.body.classList.toggle('fs-live', live);
}
// Seed the nav LIVE pill at startup so it reflects reality before the operator
// ever opens the Flash sales tab (the full list lazy-loads on first tab open).
async function fsInitNavState() {
  try {
    const r = await fetch('/api/retail-admin/flash-sales', { credentials: 'same-origin' });
    const b = await r.json();
    fsUpdateNavState((b && (b.data || b)) || []);
  } catch (e) { /* leave nav as-is if the probe fails */ }
}

async function fsLoadList() {
  const table = $('#fs-table');
  const tbody = $('#fs-table tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
  try {
    const { data } = await api('/api/retail-admin/flash-sales');
    fsUpdateNavState(data);
    if (!data.length) {
      if (table) table.classList.add('is-empty');
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">${ICONS.empty}</div><h3>No flash sales yet · 暂无秒杀</h3><p class="muted">Set one up above to start a flash-sale event. · 请在上方设置以开启秒杀活动。</p></div></td></tr>`;
      return;
    }
    if (table) table.classList.remove('is-empty');
    tbody.innerHTML = data.map(p => {
      const name = [p.name_en, p.name_cn].filter(Boolean).join(' · ') || ('#' + p.id);
      const sku = p.sku ? ` <span class="muted" style="font-size: 11px;">[${escapeHtml(p.sku)}]</span>` : '';
      const draft = !p.is_published ? ' <span class="pill draft" style="font-size:9px;">DRAFT · 草稿</span>' : '';
      const sold = p.flash_sold || 0;
      const cap = p.flash_stock_limit;
      return `<tr data-id="${p.id}">
        <td>${escapeHtml(name)}${sku}${draft}</td>
        <td class="numeric"><b>¥${fmt(p.flash_price)}</b></td>
        <td class="numeric muted" style="text-decoration: line-through;">¥${fmt(p.sell_price)}</td>
        <td>${fsFormatWindow(p.flash_starts_at, p.flash_ends_at)}</td>
        <td class="numeric">${sold}${cap != null ? ' / ' + cap : ' / ∞'}</td>
        <td>${FS_STATE_PILL[p.flash_state] || FS_STATE_PILL.none}</td>
        <td style="white-space: nowrap;">
          <button class="btn btn-sm" onclick='fsStartEdit(${JSON.stringify(p)})'>Edit · 编辑</button>
          <button class="btn btn-sm" onclick='fsClearSale(${p.id}, ${JSON.stringify(name)})'>Clear · 清除</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    if (table) table.classList.add('is-empty');
    tbody.innerHTML = `<tr><td colspan="7" class="err">Failed: ${escapeHtml(e.message)}</td></tr>`;
  }
}

document.addEventListener('input', e => {
  if (e.target.id === 'fs-price') fsUpdatePriceHint();
});
document.addEventListener('change', e => {
  if (e.target.id === 'fs-product') fsUpdatePriceHint();
});

document.querySelector('[data-tab="flash"]').addEventListener('click', () => {
  if (!FLASH_LOADED) {
    FLASH_LOADED = true;
    fsPopulateProductSelect();
    fsLoadList();
  }
});

// Wire picker trigger + search + keyboard.
document.addEventListener('DOMContentLoaded', () => {
  const trigger = document.getElementById('fs-picker-trigger');
  if (trigger) {
    trigger.addEventListener('click', () => fsPickerToggle());
    trigger.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        fsPickerOpen();
      }
    });
  }
  const search = document.getElementById('fs-picker-search');
  if (search) {
    let _t;
    search.addEventListener('input', () => {
      clearTimeout(_t);
      _t = setTimeout(() => fsPickerRenderList(search.value), 60);
    });
    search.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); fsPickerClose(); trigger?.focus(); }
    });
  }
});

