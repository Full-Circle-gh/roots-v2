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
  const name = await askPrompt({ title: 'Rename folder · 重命名文件夹', value: f.name, submitLabel: 'Rename' });
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
  if (!(await askConfirm({ title: msg, confirmLabel: 'Delete folder', danger: true }))) return;
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
  if (!(await askConfirm({ title: warn, confirmLabel: 'Delete', danger: true }))) return;
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
// UI labels below go through invT() so the English admin view never shows
// Chinese — see cuT() in 10-extras.js. invoiceAccountingText() is the
// exception: it's a clipboard payload meant for a Chinese-speaking
// accountant, not an on-screen label, so it stays bilingual regardless of
// the admin's display language.
const invT = (en, cn) => (window.cuT ? cuT(en, cn) : en);
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
  const badge = `<span style="font-weight: 700; font-size: 11px; padding: 2px 9px; border-radius: 99px; ${issued ? 'background: var(--success); color: #fff;' : 'background: var(--bg-elev-2); color: var(--text-2); border: 1px solid var(--line);'}">${issued ? invT('Issued', '已开') : invT('Requested', '待开')}</span>`;
  const inS = 'background: var(--bg-input); border: 1px solid var(--line); color: var(--text-1); border-radius: var(--r-md); padding: 6px 9px; font-size: 12px; font-family: inherit;';
  const footer = issued
    ? `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12px;">
        ${o.invoice_number ? `<div style="margin-bottom: 4px;"><span style="color: var(--text-3);">${invT('Invoice no.', '发票号码')}</span> <b>${escapeHtml(o.invoice_number)}</b></div>` : ''}
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          ${o.invoice_file_url ? `<a href="${escapeAttr(o.invoice_file_url)}" target="_blank" rel="noopener" class="db-btn primary" style="text-decoration: none;">${icoFile}${invT('View fapiao', '查看发票')}</a>` : `<span style="color: var(--text-3);">${invT('No file attached', '未附文件')}</span>`}
          <span style="color: var(--text-3);">${o.invoice_issued_at ? invT('Issued ', '开票于 ') + escapeHtml(String(o.invoice_issued_at).slice(0, 10)) : ''}</span>
          <a href="#" onclick="event.preventDefault(); unissueInvoice(${o.id})" style="color: var(--text-3); font-size: 11px;">${invT('edit', '修改')}</a>
        </div>
      </div>`
    : `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
        <input id="inv-url-${o.id}" placeholder="${invT('Fapiao link (or attach PDF)', '发票链接(或上传 PDF)')}" style="${inS} flex: 1; min-width: 180px;">
        <input id="inv-no-${o.id}" placeholder="${invT('Invoice no. (optional)', '发票号码(可选)')}" style="${inS} width: 140px;">
        <input id="inv-pdf-${o.id}" type="file" accept="application/pdf,image/*" style="display: none;" onchange="uploadInvoicePdf(${o.id}, this)">
        <button type="button" class="db-btn" onclick="document.getElementById('inv-pdf-${o.id}').click()">${icoClip}${invT('PDF / image', 'PDF / 图片')}</button>
        <button type="button" class="db-btn primary" onclick="markInvoiceIssued(${o.id})">${invT('Mark issued', '标记已开')}</button>
      </div>`;
  return `<div class="full" style="background: var(--bg-elev-1); border: 1px solid var(--line); border-radius: var(--r-md); padding: 10px 12px;">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px;">
      <span style="font-weight: 700; color: var(--text-1); font-size: 13px;">${icoReceipt}${invT('Invoice', '发票')} ${badge}<span style="font-weight: 600; color: var(--text-3); font-size: 11px; margin-left: 6px;">${isCompany ? invT('Company', '企业') : invT('Personal', '个人')}</span></span>
      <button type="button" class="db-btn" data-copy="${escapeAttr(invoiceAccountingText(o))}" onclick="event.stopPropagation(); copyKicker(this, '${invT('Invoice info', '开票信息')}')">${icoClipboard}${invT('Copy for accounting', '复制开票信息')}</button>
    </div>
    <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px;">
      ${row(invT('Title', '抬头'), o.invoice_title)}
      ${isCompany ? row(invT('Tax ID', '税号'), o.invoice_tax_id, true) : ''}
      ${row(invT('Email', '邮箱'), o.invoice_email)}
    </div>
    ${footer}
  </div>`;
}

// Mark an order's fapiao issued (attach a pasted link and/or 发票号码), revert
// a mistake, or upload the fapiao PDF (→ retail_media, fills the link field).
async function markInvoiceIssued(id) {
  const url = (document.getElementById('inv-url-' + id)?.value || '').trim();
  const number = (document.getElementById('inv-no-' + id)?.value || '').trim();
  if (!url && !number) { toast(invT('Add a fapiao link/PDF or invoice number', '请填写发票链接或号码'), 'err'); return; }
  try {
    await api('/api/retail-admin/orders/' + id + '/invoice', { method: 'PUT', body: { action: 'issue', file_url: url, number } });
    toast(invT('Invoice marked issued', '已标记开票'));
    _invoiceRefreshAfter(id);
  } catch (e) { toast(invT('Failed: ', '失败:') + e.message, 'err'); }
}
async function unissueInvoice(id) {
  try {
    await api('/api/retail-admin/orders/' + id + '/invoice', { method: 'PUT', body: { action: 'unissue' } });
    toast(invT('Back to requested', '已恢复待开'));
    _invoiceRefreshAfter(id);
  } catch (e) { toast(invT('Failed: ', '失败:') + e.message, 'err'); }
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
  if (!isPdf && !isImage) { toast(invT('PDF or image only', '仅限 PDF 或图片'), 'err'); input.value = ''; return; }
  if (file.size > 10 * 1024 * 1024) { toast(invT('File too large (max 10MB)', '文件过大'), 'err'); input.value = ''; return; }
  toast(invT('Uploading…', '上传中…'));
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await api('/api/retail-admin/invoice-file', { method: 'POST', body: { data: reader.result } });
      const url = res && res.data && res.data.url;
      const el = document.getElementById('inv-url-' + id);
      if (el && url) el.value = url;
      toast(invT('Attached — tap Mark issued', '已附加,点击标记已开'));
    } catch (e) { toast(invT('Upload failed: ', '上传失败:') + e.message, 'err'); }
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
  if (!(await askConfirm({ title: msg, confirmLabel: 'Delete', danger: true }))) return;
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
    try { mpOutcome(); } catch {}
  } catch {}
}

// ── The grey "what it adds up to" line + the short-expiry amber hint ──────────
// Reads the four points inputs live (oninput) and the top tier's multiplier
// from RCTIER_STATE, and writes a plain-¥ worked example so the operator can
// sanity-check the rules without doing the math. Everything degrades to a base
// (1.0×) sentence before the tier ladder has loaded.
function mpFmt(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r).replace(/0+$/, '').replace(/\.$/, '');
}
function mpTopTier() {
  if (!Array.isArray(RCTIER_STATE) || !RCTIER_STATE.length) return null;
  return RCTIER_STATE.reduce((top, t) =>
    (Number(t.points_mult) || 1) > (Number(top.points_mult) || 1) ? t : top, RCTIER_STATE[0]);
}
function mpOutcome() {
  const out = $('#pts-outcome');
  const earnPoints = Math.max(0, parseFloat($('#pts-earn-points')?.value) || 0);
  const earnSpend  = Math.max(1, parseFloat($('#pts-earn-spend')?.value) || 100);
  const pointValue = Math.max(0, parseFloat($('#pts-point-value')?.value) || 0);
  const SAMPLE = 200;
  const basePts = (SAMPLE / earnSpend) * earnPoints;
  const baseVal = basePts * pointValue;
  const pct     = SAMPLE > 0 ? (baseVal / SAMPLE) * 100 : 0;
  if (out) {
    if (!earnPoints || !pointValue) {
      out.innerHTML = escapeHtml(cuT(
        'Set an earn rate and point value above to see what an order gives back.',
        '在上方填写积分速率与积分价值,即可预览一笔订单的回馈。'));
    } else {
      const top = mpTopTier();
      const topMult = top ? (Number(top.points_mult) || 1) : 1;
      const topName = top ? (cuLang() === 'cn' ? (top.name_cn || top.name_en) : (top.name_en || top.name_cn)) : '';
      let s = cuT(
        `So a ¥${SAMPLE} order earns <b>${mpFmt(basePts)} points = ¥${mpFmt(baseVal)}</b> off a future order (${mpFmt(pct)}% back).`,
        `一笔 ¥${SAMPLE} 订单可得 <b>${mpFmt(basePts)} 积分 = ¥${mpFmt(baseVal)}</b>,可抵扣后续订单(回馈 ${mpFmt(pct)}%)。`);
      if (top && topMult > 1) {
        s += ' ' + cuT(
          `A ${escapeHtml(topName)} member at ${mpFmt(topMult)}× earns <b>${mpFmt(basePts * topMult)} points</b> on the same order.`,
          `${escapeHtml(topName)} 会员按 ${mpFmt(topMult)} 倍,同一订单可得 <b>${mpFmt(basePts * topMult)} 积分</b>。`);
      }
      out.innerHTML = s;
    }
  }
  // Short-expiry nudge — attention, never alarmist.
  const hint = $('#pts-expiry-hint');
  if (hint) {
    const months = parseInt($('#pts-expiry-months')?.value, 10);
    if (Number.isFinite(months) && months > 0 && months < 6) {
      hint.textContent = cuT(
        'Short — most stores give 12–24, or 0 so points never expire.',
        '偏短 — 多数商家设 12–24 个月,或设 0 让积分永不过期。');
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }
  try { mpPreview(); } catch {}   // rules feed the phone card beside them
}

// ── Live shopper preview (the phone card beside the rules) ────────────────────
// Renders the same membership card a shopper sees, driven live by the four rule
// inputs + the selected tier from RCTIER_STATE. Pure preview — never saves. The
// numbers describe a representative member sitting ~60% of the way to the next
// tier, so every figure (points earned, ¥ to spend, distance to climb) is
// derived from the rules the operator is editing rather than invented.
let MP_PV_TIER = null;   // index into threshold-sorted tiers; null = auto (top)
function mpTiersByThreshold() {
  return RCTIER_STATE.slice().sort((a, b) => (Number(a.threshold) || 0) - (Number(b.threshold) || 0));
}
function mpSelectPvTier(i) { MP_PV_TIER = i; mpPreview(); }
function mpPreview() {
  const host = $('#mp-preview');
  if (!host) return;
  const sorted = mpTiersByThreshold();
  if (!sorted.length) { host.innerHTML = ''; return; }
  const cn = (typeof cuLang === 'function') && cuLang() === 'cn';
  let sel = MP_PV_TIER;
  if (sel == null || sel < 0 || sel >= sorted.length) sel = sorted.length - 1;   // top tier by default
  const cur  = sorted[sel];
  const next = sorted[sel + 1] || null;
  const earnPoints = Math.max(0, parseFloat($('#pts-earn-points')?.value) || 0);
  const earnSpend  = Math.max(1, parseFloat($('#pts-earn-spend')?.value) || 100);
  const pointValue = Math.max(0, parseFloat($('#pts-point-value')?.value) || 0);
  const mult = Number(cur.points_mult) || 1;
  // A representative member: ~60% of the way to the next tier, or a step past
  // the summit if this is already the top tier.
  const sampleSpend = next
    ? (Number(cur.threshold) || 0) + 0.6 * ((Number(next.threshold) || 0) - (Number(cur.threshold) || 0))
    : (Number(cur.threshold) || 0) + 2000;
  const earnedPts = (sampleSpend / earnSpend) * earnPoints * mult;
  const spendVal  = earnedPts * pointValue;
  const nameMain = cn ? (cur.name_cn || cur.name_en) : (cur.name_en || cur.name_cn);
  const nameSub  = cn
    ? (cur.name_en && cur.name_en !== cur.name_cn ? cur.name_en : '')
    : (cur.name_cn && cur.name_cn !== cur.name_en ? cur.name_cn : '');
  const perks = cn ? (cur.perks_cn.length ? cur.perks_cn : cur.perks_en) : (cur.perks_en.length ? cur.perks_en : cur.perks_cn);
  const perksHtml = (perks || []).slice(0, 4).map(p => `<li>${escapeHtml(p)}</li>`).join('');
  let barPct = 100, nextLine;
  if (next) {
    barPct = 60;
    const remain = Math.max(0, (Number(next.threshold) || 0) - sampleSpend);
    const nextName = cn ? (next.name_cn || next.name_en) : (next.name_en || next.name_cn);
    nextLine = cuT(
      `¥${Math.round(remain).toLocaleString('en-US')} more to reach ${escapeHtml(nextName)}`,
      `再消费 ¥${Math.round(remain).toLocaleString('en-US')} 即达 ${escapeHtml(nextName)}`);
  } else {
    nextLine = escapeHtml(cuT('Top tier — nothing higher to climb.', '最高等级 — 已达顶端。'));
  }
  const tabs = sorted.map((t, i) => {
    const nm = cn ? (t.name_cn || t.name_en) : (t.name_en || t.name_cn);
    return `<button type="button" class="mp-pv-tab${i === sel ? ' on' : ''}" onclick="mpSelectPvTier(${i})">${escapeHtml(nm || '—')}</button>`;
  }).join('');
  host.innerHTML = `
    <div class="mp-pv-tabs">${tabs}</div>
    <div class="mp-phone">
      <div class="mp-pv-scr">
        <div class="mp-pv-eyebrow">${escapeHtml(cuT('Roots Club', '会员俱乐部'))}</div>
        <div class="mp-pv-tier">${escapeHtml(nameMain || '—')}${nameSub ? `<small>${escapeHtml(nameSub)}</small>` : ''}</div>
        <span class="mp-pv-mult">${escapeHtml(cuT(mpFmt(mult) + '× points', mpFmt(mult) + '× 积分'))}</span>
        <div class="mp-pv-bar"><i style="width:${barPct}%"></i></div>
        <div class="mp-pv-next">${nextLine}</div>
        <div class="mp-pv-pts">
          <span class="n">${escapeHtml(Math.round(earnedPts).toLocaleString('en-US'))}</span>
          <span class="l">${escapeHtml(cuT(`points · ¥${mpFmt(spendVal)} to spend`, `积分 · 可抵 ¥${mpFmt(spendVal)}`))}</span>
        </div>
        <ul class="mp-pv-perks">${perksHtml}</ul>
      </div>
    </div>
    <div class="mp-pv-cap">${escapeHtml(cuT('Live preview — what a shopper sees', '实时预览 — 顾客所见'))}</div>`;
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
  if (!(await askConfirm({ title: `Delete ¥${amt} top-up package? · 删除 ¥${amt} 充值套餐？`, confirmLabel: 'Delete package', danger: true }))) return;
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
    try { mpOutcome(); } catch {}
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
let RCTIER_EDITING = -1;   // index of the tier open in the inline editor, -1 = none
let RCTIER_COUNTS = null;  // { seed: 186, ... } live member counts, or null if unavailable
let _MP_LANG_HOOKED = false;   // registered once — repaints the section on language toggle
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
  RCTIER_EDITING = -1;
  renderRctiersTable();
  try { mpOutcome(); } catch {}   // top-tier multiplier feeds the worked example
  loadTierCounts();               // fire-and-forget; re-renders cards when it lands
  // Repaint tier cards + outcome + shopper preview in the new language on toggle.
  // The inline editor is left alone so a mid-edit toggle never steals the caret.
  if (!_MP_LANG_HOOKED && window.onLangChange) {
    _MP_LANG_HOOKED = true;
    onLangChange(() => { try { renderRctierCards(); mpOutcome(); } catch {} });
  }
}

// Live per-tier member counts — pure context for choosing thresholds. Degrades
// silently (RCTIER_COUNTS stays null → no member line) if the endpoint is absent.
async function loadTierCounts() {
  try {
    const r = await api('/api/retail-admin/tier-counts');
    RCTIER_COUNTS = (r && r.data && typeof r.data === 'object') ? r.data : null;
  } catch { RCTIER_COUNTS = null; }
  renderRctierCards();
}

// Key is derived from the English name and shown read-only — stable once set so
// renaming a tier never orphans the customers already stamped with its key.
function rctierKey(t) {
  if (t && t.key) return t.key;
  return String((t && t.name_en) || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function renderRctiersTable() { renderRctierCards(); renderRctierEditor(); }

function renderRctierCards() {
  const host = document.querySelector('#rctier-cards');
  if (!host) return;
  if (!RCTIER_STATE.length) {
    host.innerHTML = `<div class="mp-tier-empty">${escapeHtml(cuT('No tiers yet — add one to start the ladder.', '暂无等级 — 添加一个以开始等级体系。'))}</div>`;
    return;
  }
  const cn = (typeof cuLang === 'function') && cuLang() === 'cn';
  const lowIdx = RCTIER_STATE.reduce((lo, t, i) => (Number(t.threshold) || 0) < (Number(RCTIER_STATE[lo].threshold) || 0) ? i : lo, 0);
  host.innerHTML = RCTIER_STATE.map((t, i) => {
    const nameEn = t.name_en || cuT('Untitled tier', '未命名等级');
    const nameCn = t.name_cn && t.name_cn !== t.name_en ? `<span class="cn">${escapeHtml(t.name_cn)}</span>` : '';
    const mult = mpFmt(Number(t.points_mult) || 1);
    const from = (i === lowIdx || (Number(t.threshold) || 0) === 0)
      ? cuT('from <b>¥0</b> — everyone starts here', '从 <b>¥0</b> 起 — 人人有份')
      : cuT(`from <b>¥${Number(t.threshold || 0).toLocaleString('en-US')}</b> lifetime spend`, `累计消费 <b>¥${Number(t.threshold || 0).toLocaleString('en-US')}</b> 起`);
    let members = '';
    if (RCTIER_COUNTS) {
      const n = Number(RCTIER_COUNTS[rctierKey(t)] || 0);
      members = `<span class="mp-tier-members"><span class="dot"></span>${escapeHtml(cuT(n === 1 ? '1 member' : `${n.toLocaleString('en-US')} members`, `${n.toLocaleString('en-US')} 名会员`))}</span>`;
    }
    const perks = cn ? (t.perks_cn.length ? t.perks_cn : t.perks_en) : (t.perks_en.length ? t.perks_en : t.perks_cn);
    const perksHtml = perks && perks.length
      ? perks.map(p => `<li>${escapeHtml(p)}</li>`).join('')
      : `<li class="mp-perks-empty">${escapeHtml(cuT('No perks yet', '暂无权益'))}</li>`;
    const editing = (i === RCTIER_EDITING);
    const editBtn = editing
      ? `<span class="mp-btn-quiet">${escapeHtml(cuT('Editing below ↓', '正在下方编辑 ↓'))}</span>`
      : `<button class="mp-btn-quiet mp-tier-edit" onclick="mpEditTier(${i})">${escapeHtml(cuT('Edit tier', '编辑等级'))}</button>`;
    return `
      <div class="mp-tier${editing ? ' editing' : ''}">
        <div class="mp-tier-head">
          <span class="mp-tier-name">${escapeHtml(nameEn)}${nameCn}</span>
          <span class="mp-tier-mult">${escapeHtml(cuT(mult + '× points', mult + '× 积分'))}</span>
        </div>
        <div class="mp-tier-from">${from}</div>
        ${members}
        <ul class="mp-tier-perks">${perksHtml}</ul>
        ${editBtn}
      </div>`;
  }).join('');
  try { mpPreview(); } catch {}   // tier data feeds the shopper preview
}

function renderRctierEditor() {
  const host = document.querySelector('#rctier-editor');
  if (!host) return;
  const i = RCTIER_EDITING;
  const t = RCTIER_STATE[i];
  if (!t) { host.innerHTML = ''; return; }
  const capName = t.name_en || t.name_cn || cuT('New tier', '新等级');
  host.innerHTML = `
    <div class="mp-editor">
      <div class="mp-editor-cap">${escapeHtml(cuT('Editing', '编辑中'))} — ${escapeHtml(capName)}</div>
      <div class="mp-field-grid">
        <div class="mp-field">
          <label>${escapeHtml(cuT('Name (English)', '名称(英文)'))}</label>
          <input type="text" value="${escapeAttr(t.name_en)}" oninput="updateRctier(${i},'name_en',this.value)">
        </div>
        <div class="mp-field">
          <label>${escapeHtml(cuT('Name (中文)', '名称(中文)'))}</label>
          <input type="text" value="${escapeAttr(t.name_cn)}" oninput="updateRctier(${i},'name_cn',this.value)">
        </div>
        <div class="mp-field">
          <label>${escapeHtml(cuT('Reached at lifetime spend', '达到门槛(累计消费)'))}</label>
          <span class="mp-aff"><span class="u">¥</span><input type="number" min="0" step="100" value="${escapeAttr(t.threshold)}" oninput="updateRctier(${i},'threshold',this.value)"></span>
        </div>
        <div class="mp-field">
          <label>${escapeHtml(cuT('Points multiplier', '积分倍率'))}</label>
          <span class="mp-aff"><input type="number" min="0.1" max="10" step="0.1" value="${escapeAttr(t.points_mult ?? 1)}" oninput="updateRctier(${i},'points_mult',this.value)"><span class="u">×</span></span>
          <span class="fh">${escapeHtml(cuT('1.0 = base rate', '1.0 = 基础速率'))}</span>
        </div>
        <div class="mp-field half">
          <label>${escapeHtml(cuT('Perks — one per line (English)', '权益 — 每行一条(英文)'))}</label>
          <textarea oninput="updateRctier(${i},'perks_en',this.value)">${escapeHtml((t.perks_en || []).join('\n'))}</textarea>
        </div>
        <div class="mp-field half">
          <label>${escapeHtml(cuT('Perks — one per line (中文)', '权益 — 每行一条(中文)'))}</label>
          <textarea oninput="updateRctier(${i},'perks_cn',this.value)">${escapeHtml((t.perks_cn || []).join('\n'))}</textarea>
        </div>
      </div>
      <div class="mp-editor-foot">
        <span class="mp-key">${escapeHtml(cuT('Key', '标识'))} <code>${escapeHtml(rctierKey(t) || '—')}</code> — ${escapeHtml(cuT('set automatically from the English name.', '由英文名称自动生成。'))}</span>
        <span class="mp-foot-sp"></span>
        <button class="mp-btn-danger" onclick="removeRctier(${i})">${escapeHtml(cuT('Remove tier', '删除等级'))}</button>
        <button class="mp-btn mp-btn-secondary" onclick="mpCloseEditor()">${escapeHtml(cuT('Done', '完成'))}</button>
      </div>
    </div>`;
}

function mpEditTier(i) {
  RCTIER_EDITING = (RCTIER_EDITING === i) ? -1 : i;
  renderRctiersTable();
  if (RCTIER_EDITING >= 0) document.querySelector('#rctier-editor .mp-editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function mpCloseEditor() { RCTIER_EDITING = -1; renderRctiersTable(); }

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
  } else {
    RCTIER_STATE[i][field] = String(value || '');
  }
  // Refresh the card summaries + the worked example live. The editor DOM is a
  // separate container, so re-rendering the cards never steals the caret.
  renderRctierCards();
  try { mpOutcome(); } catch {}
}
function addRctierRow() {
  // New tier defaults to the next ¥1000 jump above the current top tier so the
  // ladder stays monotonic without the operator doing the math, and opens for
  // editing straight away.
  const top = RCTIER_STATE.reduce((m, t) => Math.max(m, Number(t.threshold) || 0), 0);
  RCTIER_STATE.push({
    key: '', name_en: '', name_cn: '', threshold: top + 1000,
    points_mult: 1.0, perks_en: [], perks_cn: [],
  });
  RCTIER_EDITING = RCTIER_STATE.length - 1;
  renderRctiersTable();
  document.querySelector('#rctier-editor .mp-editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function removeRctier(i) {
  const t = RCTIER_STATE[i];
  if (!t) return;
  if (!(await askConfirm({ title: cuT(`Remove tier "${t.name_en || t.name_cn || '(unnamed)'}"?`, `删除等级"${t.name_cn || t.name_en || '(未命名)'}"?`), confirmLabel: cuT('Remove tier', '删除等级'), danger: true }))) return;
  RCTIER_STATE.splice(i, 1);
  if (RCTIER_EDITING === i) RCTIER_EDITING = -1;
  else if (RCTIER_EDITING > i) RCTIER_EDITING -= 1;
  renderRctiersTable();
  try { mpOutcome(); } catch {}
}
async function saveRctiers() {
  // Derive a key for any tier that hasn't got one yet (new tiers), from its
  // English name. Existing tiers keep their stored key so customer tier_key
  // references stay valid across renames.
  for (const t of RCTIER_STATE) { if (!t.key) t.key = rctierKey(t); }
  // Validate: every tier needs a unique key, at least one tier, and the lowest
  // threshold must be 0 (otherwise low-spend customers have no tier).
  const keys = new Set();
  for (const t of RCTIER_STATE) {
    if (!t.key) return toast('Every tier needs an English name · 每个等级需要英文名称', 'err');
    if (keys.has(t.key)) return toast(cuT(`Two tiers resolve to the same key "${t.key}" — rename one.`, `两个等级标识重复"${t.key}" — 请重命名其一。`), 'err');
    keys.add(t.key);
  }
  if (!RCTIER_STATE.length) return toast('At least one tier is required · 至少需要一个等级', 'err');
  const lowest = RCTIER_STATE.reduce((m, t) => Math.min(m, Number(t.threshold) || 0), Infinity);
  if (lowest !== 0) return toast('The lowest tier must start at ¥0 · 最低等级门槛必须为 0', 'err');
  // Sort by threshold ascending so storage matches what customers see.
  const sorted = RCTIER_STATE.slice().sort((a, b) => (Number(a.threshold) || 0) - (Number(b.threshold) || 0));
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'roots_club.tiers': sorted } });
    toast('Tiers saved · 已保存');
    await loadRctiers();   // re-read so the cards reflect the canonical sorted form
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
  if (!(await askConfirm({ title: 'Mark this top-up as successful and credit the wallet? · 标记此充值为成功并入账钱包?', confirmLabel: 'Mark successful' }))) return;
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

async function removeReviewTag(i) {
  const t = REVIEW_TAGS_STATE[i];
  if (!t) return;
  if (t.id && !(await askConfirm({ title: `Remove "${t.id}"? Reviews already tagged with this id will lose that chip. · 移除 "${t.id}"？已使用此标签的评价将失去该标记。`, confirmLabel: 'Remove tag', danger: true }))) return;
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

async function removeFaqCat(i) {
  const c = FAQ_CATS[i];
  if (!c) return;
  const used = FAQ_QS.filter(q => q.cat === c.id).length;
  if (used && !(await askConfirm({ title: `Remove "${c.id || '(empty)'}"? ${used} question(s) still reference it and will be left uncategorised. · 移除 "${c.id || '(empty)'}"？仍有 ${used} 个问题引用它，将变为未分类。`, confirmLabel: 'Remove category', danger: true }))) return;
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

async function removeFaqQ(i) {
  const q = FAQ_QS[i];
  if (!q) return;
  if ((q.q_en || q.q_cn) && !(await askConfirm({ title: `Remove "${q.q_en || q.q_cn}"? · 移除 "${q.q_en || q.q_cn}"？`, confirmLabel: 'Remove question', danger: true }))) return;
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
  if (!(await askConfirm({ title: cuT('Remove this seeded review for good?', '永久删除这条种子评价?'), confirmLabel: cuT('Remove review', '删除评价'), danger: true }))) return;
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
  const next = await askReason({
    title: cuT('Public reply', '公开回复'),
    sub: cuT('Customers see it under their review. Leave blank to remove.', '顾客会在自己的评价下看到。留空则删除回复。'),
    value: existing,
    submitLabel: cuT('Save reply', '保存回复'),
  });
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
  // The row leads with the newest turn, not the thread root. On a thread staff
  // started, the root is the operator's own opener — showing it means the
  // customer's answer never appears anywhere in this table.
  const fromCustomer = f.last_author !== 'admin';
  const lastWho = fromCustomer
    ? cuT('Customer', '顾客')
    : (f.last_author_name ? escapeHtml(f.last_author_name) : cuT('Store', '商家'));
  const lastWhen = f.last_at ? escapeHtml(f.last_at.slice(0, 16)) : '';
  // Once there are replies the root is no longer on screen, so keep one clipped
  // line of it for context on what the thread is about.
  const openerHtml = f.reply_count > 0
    ? `<div class="fb-row-opener">${escapeHtml(f.message || '')}</div>`
    : '';
  return `
    <tr data-id="${f.id}" onclick="openFeedbackThread(${f.id})" class="fb-row" title="${escapeAttr(cuT('Open conversation', '打开对话'))}">
      <td>
        <div>${escapeHtml(customer)}</div>
        <div class="muted" style="font-size: 10px;">#${f.customer_id}</div>
      </td>
      <td>
        ${openerHtml}
        <div class="fb-row-last ${fromCustomer ? 'fb-row-last-cust' : 'fb-row-last-admin'}">
          <div class="fb-row-who">${lastWho}${lastWhen ? ' · ' + lastWhen : ''}</div>
          <div class="fb-row-body">${escapeHtml(f.last_body || '')}</div>
        </div>
        ${photosHtml ? `<div style="margin-top: 8px;">${photosHtml}</div>` : ''}
        <div style="margin-top: 6px; display: flex; gap: 8px; align-items: center;">${kindTag}${feedbackStatusPill(f)}${replyTag}</div>
      </td>
      <td>${ctx}${ver}</td>
      <td class="muted" style="font-size: 11px; white-space: nowrap;">
        ${f.last_at ? escapeHtml(f.last_at.slice(0, 16)) : ''}
        ${f.reply_count > 0 && f.created_at ? `<div style="font-size: 10px; opacity: .7; margin-top: 3px;">${cuT('opened', '发起于')} ${escapeHtml(f.created_at.slice(0, 10))}</div>` : ''}
      </td>
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
// FLASH SALES TAB — Tacet rebuild (Option C: timeline + inline composer).
// The page is a timeline of sales (Live now → Scheduled → Ended) down the
// left, with an always-open stepped composer on the right — no drawer.
// Step 1 Product · Step 2 Price & cap · Step 3 Window, then Start. Editing a
// row (Edit / Run again) fills the same composer. Every value has a good
// default; only a product and an end time are ever required. All creation/
// edit goes through the same PUT /products/:id/flash-sale endpoint; DELETE
// reverts a product to its regular price. Bilingual copy (En · 中)
// deliberately plain for non-native operators.
// ═══════════════════════════════════════════════════════════════════
let FLASH_LOADED = false;
let _fsProducts = null;          // cache of published products (for the wizard)
let _fsRows = [];                // last-loaded flash-sale rows
let _fsClockSkew = 0;            // server_time_ms − Date.now() at load
let _fsTick = null;              // countdown refresh interval

function fsNow() { return Date.now() + _fsClockSkew; }
function fsPad(n) { return String(n).padStart(2, '0'); }

// SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO → epoch ms.
function fsToMs(s) {
  if (!s) return null;
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}
// epoch ms → local 'YYYY-MM-DD HH:mm' for display.
function fsWhen(ms) {
  if (ms == null) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${fsPad(d.getMonth() + 1)}-${fsPad(d.getDate())} ${fsPad(d.getHours())}:${fsPad(d.getMinutes())}`;
}
// epoch ms → local 'YYYY-MM-DDTHH:mm' for datetime-local inputs.
function fsLocalInput(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${fsPad(d.getMonth() + 1)}-${fsPad(d.getDate())}T${fsPad(d.getHours())}:${fsPad(d.getMinutes())}`;
}
// Human "in 4h 12m" / "in 3d 4h" from a delta.
function fsRel(deltaMs) {
  let s = Math.floor(deltaMs / 1000);
  if (s <= 0) return null;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return cuT(`${d}d ${h}h`, `${d}天${h}小时`);
  if (h > 0) return cuT(`${h}h ${m}m`, `${h}小时${m}分`);
  return cuT(`${m}m`, `${m}分钟`);
}

function fsThumbHtml(p) {
  const src = p && (p.image_url || p.image_data) || '';
  if (src) return `<img src="${escapeAttr(src)}" alt="">`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
}
function fsName(p) {
  // One language per the admin toggle — never glue EN · CN into one label.
  const cn = (typeof cuLang === 'function') && cuLang() === 'cn';
  const primary = cn ? (p.name_cn || p.name_en) : (p.name_en || p.name_cn);
  return primary || ('#' + p.id);
}

async function fsEnsureProducts() {
  if (_fsProducts) return _fsProducts;
  try {
    const j = await api('/api/retail-admin/products?published=1');
    _fsProducts = (j.data || []).filter(p => p.is_published);
  } catch { _fsProducts = []; }
  return _fsProducts;
}

// ─── Nav LIVE pill — mirror "a flash sale is active" onto the nav row ─────
function fsUpdateNavState(rows) {
  const live = (rows || []).some(p => p.flash_state === 'active' && p.is_published);
  document.body.classList.toggle('fs-live', live);
}
async function fsInitNavState() {
  try {
    const r = await fetch('/api/retail-admin/flash-sales', { credentials: 'same-origin' });
    const b = await r.json();
    fsUpdateNavState((b && (b.data || b)) || []);
  } catch (e) { /* leave nav as-is if the probe fails */ }
}

// ════════════════════════════════════════════════════════════════
// THE MARQUEE — live sales as hero tiles, scheduled + recent as a table
// ════════════════════════════════════════════════════════════════
// hh:mm:ss for the live hero clock.
function fsHms(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h + ':' + fsPad(m) + ':' + fsPad(sec);
}

// ── A live sale = one hero tile: big running clock + sold meter. The clock
// (and its breathing dot) is the ONE Dusk motif — "the price reverts on its
// own when this hits zero." Every other control stays a plain ink button.
function fsHeroTile(p, now) {
  const name = fsName(p);
  const sku = p.sku ? `<span class="fsm-sk">${escapeHtml(p.sku)}</span>` : '';
  const draft = !p.is_published ? ` <span class="fsm-badge ended">${cuT('DRAFT', '草稿')}</span>` : '';
  const reg = Number(p.sell_price) || 0, flash = Number(p.flash_price) || 0;
  const off = (reg > 0 && flash > 0 && flash < reg) ? Math.round((1 - flash / reg) * 100) : 0;
  const ends = fsToMs(p.flash_ends_at);
  const sold = Number(p.flash_sold) || 0, cap = p.flash_stock_limit;
  let soldLine, pct = 0, hot = '';
  if (cap != null) {
    pct = cap > 0 ? Math.min(100, Math.round(sold / cap * 100)) : 0;
    soldLine = `<span><b>${sold}</b> / ${cap} ${cuT('sold', '已售')}</span><span>${pct}%</span>`;
    if (pct >= 40) hot = ' hot';
  } else {
    soldLine = `<span><b>${sold}</b> ${cuT('sold · no cap', '已售 · 不限量')}</span><span></span>`;
  }
  const startW = fsWhen(fsToMs(p.flash_starts_at));
  return `<div class="fsm-hero" data-id="${p.id}">
    <div class="fsm-hero-top">
      <div class="fsm-thumb">${fsThumbHtml(p)}</div>
      <div class="fsm-who"><div class="fsm-name">${escapeHtml(name)} ${sku}${draft}</div>
        <div class="fsm-prc"><span class="fsm-now">¥${fmt(flash)}</span>${reg > 0 ? `<span class="fsm-was">¥${fmt(reg)}</span>` : ''}${off ? `<span class="fsm-off">−${off}%</span>` : ''}</div></div>
    </div>
    <div class="fsm-cd-row">
      <span class="fsm-cd" data-end="${ends}">${fsHms(ends - now)}</span>
      <span class="fsm-cd-lab">${cuT('left', '剩余')}${startW ? ` · ${cuT('ends', '结束')} ${escapeHtml(fsWhen(ends) || '')}` : ''}</span>
      <span class="fsm-auto"><span class="fsm-dot"></span>${cuT('auto-revert', '自动恢复')}</span>
    </div>
    <div class="fsm-sold">${soldLine}</div>
    <div class="fsm-meter${hot}"><i style="width:${pct}%"></i></div>
    <div class="fsm-hero-foot">
      <button class="btn btn-sm btn-danger" onclick='fsEndNow(${p.id}, ${JSON.stringify(name)})'>${cuT('End early', '提前结束')}</button>
      <button class="btn btn-sm" onclick="fsEdit(${p.id})">${cuT('Edit', '编辑')}</button>
      ${startW ? `<span class="fsm-win">${cuT('started ', '开始 ')}${escapeHtml(startW)}</span>` : ''}
    </div>
  </div>`;
}

// ── Scheduled + recent collapse into one quiet table row.
function fsTableRow(p, now) {
  const st = p.flash_state;
  const dim = st === 'ended' ? ' dim' : '';
  const name = fsName(p);
  const sku = p.sku ? `<span class="fsm-sk">${escapeHtml(p.sku)}</span>` : '';
  const reg = Number(p.sell_price) || 0, flash = Number(p.flash_price) || 0;
  const startMs = fsToMs(p.flash_starts_at), endMs = fsToMs(p.flash_ends_at);
  const sold = Number(p.flash_sold) || 0, cap = p.flash_stock_limit;
  let when, soldTxt, act, badge;
  if (st === 'upcoming') {
    const r = fsRel((startMs || now) - now);
    when = `<span class="fsm-cd2" data-start="${startMs}">${r ? cuT('starts in ', '') + r + cuT('', '后开始') : escapeHtml(fsWhen(startMs) || '')}</span>`;
    soldTxt = cap != null ? cuT('cap ', '限 ') + cap : cuT('no cap', '不限量');
    act = `<button class="btn btn-sm" onclick="fsEdit(${p.id})">${cuT('Edit', '编辑')}</button>`;
    badge = `<span class="fsm-badge sched">${cuT('Scheduled', '已排期')}</span>`;
  } else {
    const soldOut = cap != null && sold >= cap;
    when = escapeHtml(fsWhen(endMs) || '') + ` · ${cuT('ended', '已结束')}`;
    soldTxt = cap != null ? `<b>${sold}</b>/${cap}${soldOut ? ` · ${cuT('sold out', '售罄')}` : ''}` : `<b>${sold}</b> ${cuT('sold', '已售')}`;
    act = `<button class="btn btn-sm" onclick="fsAgain(${p.id})">${cuT('Run again', '再来一次')}</button>`;
    badge = `<span class="fsm-badge ended">${cuT('Ended', '已结束')}</span>`;
  }
  return `<div class="fsm-trow${dim}" data-id="${p.id}">
    <div class="fsm-tw"><div class="fsm-tthumb">${fsThumbHtml(p)}</div>
      <div class="fsm-tmeta"><div class="fsm-tname">${escapeHtml(name)}</div><div class="fsm-tsub">${sku}</div></div></div>
    <div class="fsm-tcell fsm-cw">${when}</div>
    <div class="fsm-tcell"><span class="fsm-now">¥${fmt(flash)}</span> ${reg > 0 ? `<span class="fsm-was">¥${fmt(reg)}</span>` : ''}</div>
    <div class="fsm-tcell fsm-cs">${soldTxt}</div>
    <div class="fsm-tact">${st === 'upcoming' ? badge + ' ' : ''}${act}</div>
  </div>`;
}

function fsRenderTimeline() {
  const mount = document.getElementById('fs2-timeline');
  if (!mount) return;
  const now = fsNow();
  const active = _fsRows.filter(p => p.flash_state === 'active');
  const upcoming = _fsRows.filter(p => p.flash_state === 'upcoming');
  const ended = _fsRows.filter(p => p.flash_state === 'ended');

  if (!_fsRows.length) {
    mount.innerHTML = `<div class="fsm-empty">
      <svg class="fsm-emark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5"/><path d="M9 2h6"/></svg>
      <div class="lead">${cuT("Nothing's on the clock", '暂无秒杀')}</div>
      <div class="sub">${cuT('Put a product on a timer and it sells at the sale price until the window closes.', '给产品加上倒计时,它会以秒杀价出售,直到时间结束。')}</div>
      <button class="btn fsm-new" onclick="fsNewSale()">${cuT('New flash sale', '新建秒杀')}</button>
    </div>`;
    return;
  }

  let html = '';
  // live hero band
  if (active.length) {
    html += `<div class="fsm-sec"><span class="fsm-badge live"><span class="fsm-dot"></span>${cuT('Live now', '进行中')}</span><span class="fsm-secn">· ${active.length} ${cuT('running', '进行中')}</span></div>`
      + `<div class="fsm-grid">${active.map(p => fsHeroTile(p, now)).join('')}</div>`;
  } else {
    html += `<div class="fsm-sec"><span class="fsm-kick">${cuT('Live now', '进行中')}</span></div>`
      + `<div class="fsm-none">${cuT('No sale is live this moment. Scheduled ones start on their own.', '当前没有进行中的秒杀,已排期的会自动开始。')}</div>`;
  }
  // scheduled + recent table
  const rows = upcoming.concat(ended);
  if (rows.length) {
    html += `<div class="fsm-sec fsm-sec2"><span class="fsm-kick">${cuT('Scheduled &amp; recent', '已排期与最近')}</span><span class="fsm-secn">· ${upcoming.length} ${cuT('scheduled', '已排期')}</span></div>`
      + `<div class="fsm-table"><div class="fsm-thead"><span>${cuT('Product', '产品')}</span><span class="fsm-cw">${cuT('Window', '时间')}</span><span>${cuT('Price', '价格')}</span><span class="fsm-cs">${cuT('Sold', '已售')}</span><span></span></div>`
      + rows.map(p => fsTableRow(p, now)).join('') + `</div>`;
  }
  mount.innerHTML = html;
}

// Tick the hero clocks (hh:mm:ss) and scheduled "starts in" labels every second
// without re-rendering the list. When a window actually closes — a live clock
// hits zero, or a scheduled start passes — reload from the server so the state
// (and the reverted price) is authoritative, not guessed on the client.
function fsRefreshCountdowns() {
  const now = fsNow();
  let crossed = false;
  document.querySelectorAll('#fs2-timeline .fsm-cd').forEach(el => {
    const end = Number(el.getAttribute('data-end'));
    if (Number.isFinite(end)) {
      if (end - now <= 0) crossed = true;
      el.textContent = fsHms(end - now);
    }
  });
  document.querySelectorAll('#fs2-timeline .fsm-cd2').forEach(el => {
    const start = Number(el.getAttribute('data-start'));
    if (!Number.isFinite(start)) return;
    if (start - now <= 0) { crossed = true; return; }
    const r = fsRel(start - now);
    if (r) el.textContent = cuT('starts in ', '') + r + cuT('', '后开始');
  });
  if (crossed) fsLoadList();
}

async function fsLoadList() {
  const mount = document.getElementById('fs2-timeline');
  if (mount) mount.innerHTML = `<div class="fs2-card"><div class="fs2-empty"><div class="sub">${cuT('Loading…', '加载中…')}</div></div></div>`;
  try {
    const res = await api('/api/retail-admin/flash-sales');
    _fsRows = res.data || [];
    if (res.meta && res.meta.server_time_ms) _fsClockSkew = res.meta.server_time_ms - Date.now();
    fsUpdateNavState(_fsRows);
    fsRenderTimeline();
    if (_fsTick) clearInterval(_fsTick);
    _fsTick = setInterval(fsRefreshCountdowns, 1000);
  } catch (e) {
    if (mount) mount.innerHTML = `<div class="fs2-card"><div class="fs2-empty"><div class="sub err">${cuT('Failed to load', '加载失败')}: ${escapeHtml(e.message)}</div></div></div>`;
  }
}

// ─── row actions ─────────────────────────────────────────────────────────
async function fsEndNow(productId, name) {
  const title = cuT(`End the flash sale on "${name}" now?`, `立即结束 "${name}" 的秒杀？`);
  const body = cuT('The regular price comes back immediately.', '将马上恢复原价。');
  if (!(await askConfirm({ title, body, confirmLabel: cuT('End sale', '结束秒杀'), danger: true }))) return;
  try {
    await api(`/api/retail-admin/products/${productId}/flash-sale`, { method: 'DELETE' });
    toast(cuT('Flash sale ended', '秒杀已结束'));
    await fsLoadList();
  } catch (e) { toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
}
function fsEdit(id) { const row = _fsRows.find(r => r.id === id); if (row) fscFillFromRow(row, 'edit'); }
function fsAgain(id) { const row = _fsRows.find(r => r.id === id); if (row) fscFillFromRow(row, 'again'); }

// ── The composer lives in a right-side drawer. New / Edit / Run-again all open
// the same panel; it closes on save, cancel, the ✕, the scrim, or Escape.
function fsOpenComposer() {
  const sc = document.getElementById('fsd-scrim'), dw = document.getElementById('fsd-drawer');
  if (sc) sc.classList.add('on');
  if (dw) { dw.classList.add('on'); dw.setAttribute('aria-hidden', 'false'); }
}
function fsCloseComposer() {
  const sc = document.getElementById('fsd-scrim'), dw = document.getElementById('fsd-drawer');
  if (sc) sc.classList.remove('on');
  if (dw) { dw.classList.remove('on'); dw.setAttribute('aria-hidden', 'true'); }
}
function fsNewSale() { fscReset(); fsOpenComposer(); }

// ════════════════════════════════════════════════════════════════
// THE COMPOSER  (right column) — always-open, stepped: Product → Price → Window.
// No drawer: the card lives in the sticky aside and rebuilds in place. Editing
// a row (Edit / Run again) fills the same composer. Only a product and an end
// time are ever required; every other value has a good default.
// ════════════════════════════════════════════════════════════════
let _fsc = null;            // composer state (set once the flash tab opens)
let _fscVouchers = null;    // snapshot of live coupons, for the coupon heads-up

const FSC_ICONS = {
  box: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  chev: '<polyline points="6 9 12 15 18 9"/>',
  alert: '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>',
};
function fscIcon(name, size) {
  size = size || 16;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${FSC_ICONS[name] || ''}</svg>`;
}

function fscBlank() {
  return {
    mode: 'new', editId: null,
    product: null, pickerOpen: false, psearch: '',
    price: '', pct: null, cap: '',
    endChip: 'tonight', endsCustom: '', endEdit: false, winTouched: false,
    startLater: false, startChip: 'now', startsCustom: '',
    noCoupon: true,   // mockup C defaults the "keep coupons off" switch ON (protects margin)
  };
}

// ─── derived values (shared math with the timeline clock) ─────────────────
function fscRegular() { return Number(_fsc.product && _fsc.product.sell_price) || 0; }
function fscPriceNum() { return Number(_fsc.price) || 0; }
function fscCapNum() { const n = parseInt(_fsc.cap, 10); return Number.isFinite(n) && n > 0 ? n : null; }
function fscOffPct() { const r = fscRegular(), f = fscPriceNum(); return (r > 0 && f > 0 && f < r) ? Math.round(((r - f) / r) * 100) : 0; }
function fscPriceValid() { const f = fscPriceNum(), r = fscRegular(); return f > 0 && (r <= 0 || f < r); }
function fscProductStock(p) {
  const v = (p && (p.stock ?? p.stock_qty ?? p.inventory ?? p.qty));
  return (v == null || v === '') ? null : Number(v);
}
function fscTonight() {
  const d = new Date(fsNow()); d.setHours(22, 0, 0, 0);
  if (d.getTime() <= fsNow()) d.setDate(d.getDate() + 1);
  return d;
}
function fscStartsDate() {
  if (!_fsc.startLater || _fsc.startChip === 'now') return null;
  if (_fsc.startChip === 'tomorrow9') { const d = new Date(fsNow()); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; }
  return _fsc.startsCustom ? new Date(_fsc.startsCustom) : null;
}
function fscEndsDate() {
  if (_fsc.endChip === 'custom') return _fsc.endsCustom ? new Date(_fsc.endsCustom) : null;
  if (_fsc.endChip === 'tonight') return fscTonight();
  const m = _fsc.endChip.match(/^\+(\d+)([hd])$/);
  if (!m) return null;
  const base = fscStartsDate() || new Date(fsNow());
  const ms = (m[2] === 'h' ? +m[1] * 3600 : +m[1] * 86400) * 1000;
  return new Date(base.getTime() + ms);
}
// Friendly day word: today / tomorrow / YYYY-MM-DD.
function fscDayWord(ms) {
  const d = new Date(ms), n = new Date(fsNow());
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tm = new Date(fsNow()); tm.setDate(tm.getDate() + 1);
  if (same(d, n)) return cuT('today', '今天');
  if (same(d, tm)) return cuT('tomorrow', '明天');
  return `${d.getFullYear()}-${fsPad(d.getMonth() + 1)}-${fsPad(d.getDate())}`;
}
function fscEndLabel() {
  const ed = fscEndsDate();
  if (!ed || isNaN(ed.getTime())) return cuT('Pick an end time', '选择结束时间');
  return cuT('Ends ', '结束 ') + fscDayWord(ed.getTime()) + ' ' + fsPad(ed.getHours()) + ':' + fsPad(ed.getMinutes());
}

// ─── the card ─────────────────────────────────────────────────────────────
function fscInit() {
  if (!_fsc) _fsc = fscBlank();
  fscRender();
  fsEnsureProducts();
  if (_fscVouchers == null) {
    api('/api/retail-admin/vouchers').then(r => { _fscVouchers = r.data || []; if (_fsc) fscRenderCouponNote(); }).catch(() => { _fscVouchers = []; });
  }
}
function fscReset() { _fsc = fscBlank(); fscRender(); }

function fscRender() {
  const mount = document.getElementById('fsc-form');
  if (!mount) return;
  const p = _fsc.product;
  const s1done = !!p, s2done = fscPriceValid(), s3done = _fsc.winTouched && !!fscEndsDate();
  const modeTag = _fsc.mode === 'edit'
    ? `<span class="mode">${cuT('Editing', '编辑中')}</span>`
    : (_fsc.mode === 'again' ? `<span class="mode">${cuT('Run again', '再来一次')}</span>` : '');

  mount.innerHTML =
      `<div class="fsc-h">${cuT('New flash sale', '新建秒杀')}${modeTag}</div>`
    // step 1 — product
    + `<div class="fsc-step${s1done ? ' done' : ''}" id="fsc-step1"><span class="fsc-num">1</span><div class="fsc-body">`
    +   `<div class="fsc-title">${cuT('Product', '产品')}</div>`
    +   fscPickerHtml()
    + `</div></div>`
    // step 2 — price & cap
    + `<div class="fsc-step${s2done ? ' done' : ''}" id="fsc-step2"><span class="fsc-num">2</span><div class="fsc-body">`
    +   `<div class="fsc-title">${cuT('Price &amp; cap', '价格与限量')}</div>`
    +   `<div class="fsc-row2">`
    +     `<div><input class="fsc-input mono" id="fsc-price" inputmode="decimal" autocomplete="off" value="${escapeAttr(String(_fsc.price || ''))}" placeholder="${escapeAttr(cuT('¥ price', '¥ 价格'))}" oninput="fscLivePrice(this.value)">`
    +       `<div class="fsc-help" id="fsc-price-help">${fscPriceHelpHtml()}</div></div>`
    +     `<div><input class="fsc-input mono" id="fsc-cap" inputmode="numeric" autocomplete="off" value="${escapeAttr(String(_fsc.cap || ''))}" placeholder="${escapeAttr(cuT('No cap', '不限量'))}" oninput="fscLiveCap(this.value)">`
    +       `<div class="fsc-help">${cuT('stock cap', '库存上限')}</div></div>`
    +   `</div>`
    + `</div></div>`
    // step 3 — window
    + `<div class="fsc-step${s3done ? ' done' : ''}" id="fsc-step3"><span class="fsc-num">3</span><div class="fsc-body">`
    +   `<div class="fsc-title">${cuT('Window', '时间')} <span class="fsc-opt">· ${fscStartNoteHtml()}</span></div>`
    +   `<input class="fsc-input mono" readonly onclick="fscOpenEndPicker()" value="${escapeAttr(fscEndLabel())}">`
    +   (_fsc.endEdit ? `<input type="datetime-local" class="fsc-date" value="${escapeAttr(_fsc.endsCustom)}" onchange="fscSetEnd(this.value)">` : '')
    +   `<div class="fsc-chips">${fscEndChipsHtml()}</div>`
    +   fscStartRowHtml()
    + `</div></div>`
    // coupon switch
    + `<div class="fsc-sw-row">`
    +   `<button class="fsc-sw${_fsc.noCoupon ? ' on' : ''}" role="switch" aria-checked="${_fsc.noCoupon}" onclick="fscToggleCoupon()"></button>`
    +   `<div><div class="fsc-sw-t">${cuT('Keep coupons off this price', '秒杀价不叠加优惠券')}</div>`
    +     `<div class="fsc-sw-d">${cuT('Sitewide coupons skip this product while the sale runs.', '活动期间,全场优惠券会跳过此商品。')}</div></div>`
    + `</div>`
    + `<div id="fsc-coupon-note"></div>`
    // foot
    + fscFootHtml();

  fscRenderCouponNote();
  fscRenderPvCard();
}

// ─── step 1: product picker ───────────────────────────────────────────────
function fscPickerHtml() {
  if (_fsc.pickerOpen) {
    return `<div class="fsc-search">${fscIcon('search', 15)}`
      + `<input type="text" id="fsc-psearch" autocomplete="off" placeholder="${escapeAttr(cuT('Search by name or SKU…', '按名称或货号搜索…'))}" oninput="fscFilter(this.value)"></div>`
      + `<div class="fsc-plist" id="fsc-plist">${fscProductListHtml(_fsc.psearch)}</div>`;
  }
  const p = _fsc.product;
  if (!p) {
    return `<button class="fsc-picker" onclick="fscOpenPicker()">`
      + `<span class="fsc-pthumb">${fscIcon('box', 16)}</span>`
      + `<span class="fsc-pplace">${cuT('Choose a product', '选择产品')}</span>`
      + `<span class="fsc-pchev">${fscIcon('chev', 14)}</span></button>`;
  }
  const reg = fscRegular();
  const stock = fscProductStock(p);
  const bits = [];
  if (reg > 0) bits.push(cuT('Regular', '原价') + ' ¥' + fmt(reg));
  if (stock != null) bits.push(stock + ' ' + cuT('in stock', '库存'));
  return `<button class="fsc-picker" onclick="fscOpenPicker()">`
    + `<span class="fsc-pthumb">${fsThumbHtml(p)}</span>`
    + `<span class="fsc-pmeta"><span class="fsc-pname">${escapeHtml(fsName(p))}</span>`
    +   `${bits.length ? `<span class="fsc-psub">${escapeHtml(bits.join(' · '))}</span>` : ''}</span>`
    + `<span class="fsc-pchev">${fscIcon('chev', 14)}</span></button>`;
}
function fscProductListHtml(q) {
  const list = _fsProducts || [];
  q = (q || '').trim().toLowerCase();
  const filtered = q
    ? list.filter(p => `${p.name_en || ''} ${p.name_cn || ''} ${p.sku || ''}`.toLowerCase().includes(q))
    : list;
  if (!list.length) return `<div class="fsc-pempty">${cuT('Loading products…', '正在加载产品…')}</div>`;
  if (!filtered.length) return `<div class="fsc-pempty">${cuT('No products match — try another search.', '无匹配产品 — 换个关键词。')}</div>`;
  return filtered.slice(0, 200).map(p => {
    const subBits = []; if (p.sku) subBits.push(p.sku); if (p.size) subBits.push(p.size);
    const price = p.sell_price ? `<b>¥${fmt(p.sell_price)}</b>${cuT('regular', '原价')}` : '';
    return `<button class="fsc-prow" onclick="fscPick(${p.id})">`
      + `<span class="th">${fsThumbHtml(p)}</span>`
      + `<span><span class="pn">${escapeHtml(fsName(p))}</span>${subBits.length ? `<span class="ps">${escapeHtml(subBits.join(' · '))}</span>` : ''}</span>`
      + `${price ? `<span class="pr">${price}</span>` : ''}</button>`;
  }).join('');
}
async function fscOpenPicker() {
  _fsc.pickerOpen = true; _fsc.psearch = '';
  fscRender();
  const inp = document.getElementById('fsc-psearch');
  if (inp) inp.focus();
  await fsEnsureProducts();
  if (!_fsc || !_fsc.pickerOpen) return;
  const el = document.getElementById('fsc-plist');
  if (el) el.innerHTML = fscProductListHtml(_fsc.psearch);
}
function fscFilter(q) {
  _fsc.psearch = q;
  const el = document.getElementById('fsc-plist');
  if (el) el.innerHTML = fscProductListHtml(q);
}
function fscPick(id) {
  const p = (_fsProducts || []).find(x => x.id === id);
  if (!p) return;
  _fsc.product = p;
  _fsc.pickerOpen = false;
  if (!fscPriceValid()) { _fsc.price = ''; _fsc.pct = null; }
  fscRender();
}

// ─── step 2: price & cap (live, focus-preserving) ─────────────────────────
function fscPriceHelpHtml() {
  const reg = fscRegular(), f = fscPriceNum();
  if (reg > 0 && f > 0) {
    if (f >= reg) return cuT('Must be lower than regular', '必须低于原价');
    return cuT('', '省 ') + `<b>${fscOffPct()}% ${cuT('off', '')}</b> ` + cuT('¥', '· 原价 ¥') + fmt(reg);
  }
  if (reg > 0) return cuT('Regular', '原价') + ' ¥' + fmt(reg);
  return cuT('flash price', '秒杀价');
}
function fscLivePrice(v) {
  _fsc.price = v; _fsc.pct = null;
  const help = document.getElementById('fsc-price-help');
  if (help) { help.innerHTML = fscPriceHelpHtml(); help.classList.toggle('err', fscPriceNum() > 0 && fscRegular() > 0 && fscPriceNum() >= fscRegular()); }
  const s2 = document.getElementById('fsc-step2'); if (s2) s2.classList.toggle('done', fscPriceValid());
  fscUpdatePreview();
}
function fscLiveCap(v) { _fsc.cap = v; fscRenderPvCard(); }

// ─── step 3: window ───────────────────────────────────────────────────────
function fscEndChipsHtml() {
  const ends = [
    ['+1h', cuT('+1h', '+1小时')],
    ['+6h', cuT('+6h', '+6小时')],
    ['tonight', cuT('Tonight', '今晚')],
    ['+3d', cuT('+3d', '+3天')],
    ['+7d', cuT('+7d', '+7天')],
  ];
  return ends.map(e => `<button class="fsc-chip${_fsc.endChip === e[0] ? ' on' : ''}" onclick="fscEndChip('${e[0]}')">${e[1]}</button>`).join('');
}
function fscEndChip(k) {
  _fsc.endChip = k; _fsc.endEdit = false; _fsc.winTouched = true;
  fscRender();
}
function fscOpenEndPicker() {
  _fsc.endChip = 'custom'; _fsc.endEdit = true; _fsc.winTouched = true;
  if (!_fsc.endsCustom) { const ed = fscEndsDate() || fscTonight(); _fsc.endsCustom = fsLocalInput(ed.getTime()); }
  fscRender();
}
function fscSetEnd(v) { _fsc.endsCustom = v; _fsc.endChip = 'custom'; _fsc.winTouched = true; fscRender(); }

function fscStartNoteHtml() {
  if (_fsc.startLater) {
    return cuT('scheduled — ', '排期 — ') + `<span class="fsc-optlink" onclick="fscToggleStartLater()">${cuT('start now instead', '改为现在开始')}</span>`;
  }
  return cuT('starts now', '现在开始') + ' — ' + `<span class="fsc-optlink" onclick="fscToggleStartLater()">${cuT('schedule it', '排期')}</span>`;
}
function fscToggleStartLater() {
  _fsc.startLater = !_fsc.startLater;
  if (_fsc.startLater && _fsc.startChip === 'now') _fsc.startChip = 'tomorrow9';
  if (!_fsc.startLater) _fsc.startChip = 'now';
  fscRender();
}
function fscStartRowHtml() {
  if (!_fsc.startLater) return '';
  const starts = [
    ['tomorrow9', cuT('Tomorrow 09:00', '明天 09:00')],
    ['custom', cuT('Pick a time', '自定义')],
  ];
  const chips = starts.map(s => `<button class="fsc-chip${_fsc.startChip === s[0] ? ' on' : ''}" onclick="fscStartChip('${s[0]}')">${s[1]}</button>`).join('');
  const custom = _fsc.startChip === 'custom'
    ? `<input type="datetime-local" class="fsc-date" value="${escapeAttr(_fsc.startsCustom)}" onchange="fscSetStart(this.value)">`
    : '';
  return `<div class="fsc-chips">${chips}</div>${custom}`;
}
function fscStartChip(k) {
  _fsc.startChip = k;
  if (k === 'custom' && !_fsc.startsCustom) { const d = new Date(fsNow()); d.setHours(d.getHours() + 1, 0, 0, 0); _fsc.startsCustom = fsLocalInput(d.getTime()); }
  fscRender();
}
function fscSetStart(v) { _fsc.startsCustom = v; fscRender(); }

// ─── coupon switch + heads-up ─────────────────────────────────────────────
function fscToggleCoupon() { _fsc.noCoupon = !_fsc.noCoupon; fscRender(); }
function fscRenderCouponNote() {
  const el = document.getElementById('fsc-coupon-note');
  if (!el) return;
  const liveCoupon = (_fscVouchers || []).some(v => v && v.is_active && (v.auto_apply || v.is_public));
  if (liveCoupon && !_fsc.noCoupon) {
    el.innerHTML = `<div class="fsc-help" style="display:flex;gap:7px;color:var(--tacet-amber-ink);margin-top:0;">`
      + `<span style="flex:none;color:var(--tacet-amber);">${fscIcon('alert', 14)}</span>`
      + `<span>${cuT('A sitewide coupon is live — it will stack on this price. Keep coupons off to protect your margin.', '有全场优惠券进行中 — 会叠加在此价格上。禁止叠加可保住利润。')}</span></div>`;
  } else {
    el.innerHTML = '';
  }
}

// ─── foot: preview + actions ──────────────────────────────────────────────
function fscPreviewHtml() {
  const f = fscPriceNum(), reg = fscRegular();
  if (!(f > 0)) return cuT('Fill in a price to preview.', '填写价格后预览。');
  const off = fscOffPct();
  return cuT('Customers see ', '顾客看到 ')
    + `<span class="f">¥${fmt(f)}</span>`
    + (reg > 0 ? `, <span class="r">¥${fmt(reg)}</span>` : '')
    + (off ? ` · ${cuT('save', '省')} ${off}%` : '');
}
function fscUpdatePreview() { const el = document.getElementById('fsc-prev'); if (el) el.innerHTML = fscPreviewHtml(); fscRenderPvCard(); }

// The pop-up's right-hand pane — a live mock of what a shopper sees, redrawn
// on every product / price / cap / window change.
function fscRenderPvCard() {
  const el = document.getElementById('fsc-pv');
  if (!el) return;
  const p = _fsc && _fsc.product;
  const f = fscPriceNum(), reg = fscRegular();
  let html = `<div class="fspv-kick">${cuT('What customers see', '顾客看到')}</div>`;
  if (!p || !(f > 0)) {
    el.innerHTML = html + `<div class="fspv-empty">${cuT('Pick a product and set a price to preview the shopper’s view.', '选择产品并填写价格,预览顾客看到的样子。')}</div>`;
    return;
  }
  const off = fscOffPct(), cap = fscCapNum(), ends = fscEndsDate();
  const endTxt = (ends && !isNaN(ends.getTime())) ? fscDayWord(ends.getTime()) + ' ' + fsPad(ends.getHours()) + ':' + fsPad(ends.getMinutes()) : '';
  html += `<div class="fspv-card">`
    + `<div class="fspv-img"><span class="fspv-bolt">${cuT('Flash', '秒杀')}</span>${fsThumbHtml(p)}</div>`
    + `<div class="fspv-b"><div class="fspv-n">${escapeHtml(fsName(p))}</div>`
    +   `<div class="fspv-prc"><span class="fspv-now">¥${fmt(f)}</span>${reg > 0 ? `<span class="fspv-was">¥${fmt(reg)}</span>` : ''}${off ? `<span class="fspv-save">${cuT('save', '省')} ${off}%</span>` : ''}</div>`
    +   (endTxt ? `<div class="fspv-meta">${cuT('Ends ', '结束 ')}${escapeHtml(endTxt)}</div>` : '')
    +   (cap != null ? `<div class="fspv-meta">${cuT('Limited to ', '限 ')}${cap}${cuT('', ' 份')}</div>` : '')
    + `</div></div>`
    + `<div class="fspv-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>`
    +   (reg > 0 ? cuT(`Reverts to ¥${fmt(reg)} on its own when the clock runs out.`, `倒计时结束后自动恢复 ¥${fmt(reg)}。`) : cuT('Reverts to the regular price when the clock runs out.', '倒计时结束后自动恢复原价。'))
    + `</div>`;
  el.innerHTML = html;
}
function fscFootHtml() {
  const future = !!fscStartsDate();
  const cta = future ? cuT('Schedule', '排期') : cuT('Start', '开启');
  const cancel = (_fsc.mode === 'edit' && _fsc.editId)
    ? `<button class="btn btn-sm fsc-cancel" onclick="fscCancelSale()">${cuT('Cancel this sale', '取消此活动')}</button>`
    : '';
  return `<div class="fsc-foot">`
    + `<span class="fsc-prev" id="fsc-prev">${fscPreviewHtml()}</span>`
    + cancel
    + `<button class="btn fsc-start" onclick="fscStart()">${cta}</button>`
    + `</div>`;
}

// ─── prefill from a timeline row (Edit / Run again) ───────────────────────
function fscFillFromRow(row, mode) {
  _fsc = fscBlank();
  _fsc.mode = mode; _fsc.editId = row.id;
  _fsc.product = {
    id: row.id, name_en: row.name_en, name_cn: row.name_cn, sku: row.sku, size: row.size,
    sell_price: row.sell_price, image_url: row.image_url, image_data: row.image_data,
    stock: row.stock, stock_qty: row.stock_qty, inventory: row.inventory,
  };
  _fsc.price = row.flash_price || '';
  _fsc.cap = row.flash_stock_limit != null ? String(row.flash_stock_limit) : '';
  _fsc.noCoupon = !!row.no_coupon_on_flash;
  _fsc.winTouched = true;
  if (mode === 'edit') {
    // Keep the existing window as-is.
    _fsc.endChip = 'custom'; _fsc.endsCustom = fsLocalInput(fsToMs(row.flash_ends_at)); _fsc.endEdit = false;
    if (row.flash_starts_at && row.flash_state === 'upcoming') {
      _fsc.startLater = true; _fsc.startChip = 'custom'; _fsc.startsCustom = fsLocalInput(fsToMs(row.flash_starts_at));
    }
  } else {
    // Run again → fresh clock, start now.
    _fsc.editId = null; _fsc.mode = 'again';
    _fsc.endChip = 'tonight';
  }
  fscRender();
  fsOpenComposer();
}

// ─── save / cancel ────────────────────────────────────────────────────────
function fscValidate() {
  if (!_fsc.product) { toast(cuT('Pick a product first', '请先选择产品'), 'err'); return false; }
  if (!(fscPriceNum() > 0)) { toast(cuT('Enter a flash price', '请输入秒杀价'), 'err'); return false; }
  if (fscRegular() > 0 && fscPriceNum() >= fscRegular()) { toast(cuT('Flash price must be lower than regular', '秒杀价必须低于原价'), 'err'); return false; }
  const ed = fscEndsDate();
  if (!ed || isNaN(ed.getTime())) { toast(cuT('Set an end time', '请设置结束时间'), 'err'); return false; }
  const sd = fscStartsDate();
  if (sd && sd.getTime() >= ed.getTime()) { toast(cuT('Start must be before end', '开始须早于结束'), 'err'); return false; }
  if (ed.getTime() <= fsNow() && !sd) { toast(cuT('End time is in the past', '结束时间已过'), 'err'); return false; }
  return true;
}
async function fscStart() {
  if (!fscValidate()) return;
  const ends = fscEndsDate();
  const starts = fscStartsDate();
  const body = {
    flash_price: fscPriceNum(),
    flash_ends_at: ends.toISOString(),
    flash_starts_at: starts ? starts.toISOString() : null,
    flash_stock_limit: fscCapNum(),
    no_coupon_on_flash: _fsc.noCoupon ? 1 : 0,
  };
  try {
    await api(`/api/retail-admin/products/${_fsc.product.id}/flash-sale`, { method: 'PUT', body });
    toast(starts ? cuT('Flash sale scheduled', '秒杀已排期') : cuT('Flash sale started', '秒杀已开启'));
    fsCloseComposer();
    fscReset();
    await fsLoadList();
  } catch (e) {
    const map = {
      flash_price_invalid: cuT('Flash price must be greater than 0', '秒杀价必须大于 0'),
      flash_ends_at_required: cuT('End time required', '请填写结束时间'),
      flash_ends_at_invalid: cuT('End time invalid', '结束时间无效'),
      flash_starts_at_invalid: cuT('Start time invalid', '开始时间无效'),
      flash_starts_after_ends: cuT('Start must be before end', '开始须早于结束'),
      flash_stock_limit_invalid: cuT('Stock cap must be a positive number', '库存上限必须为正数'),
    };
    toast(cuT('Failed', '失败') + ': ' + (map[e.message] || e.message), 'err');
  }
}
async function fscCancelSale() {
  if (!_fsc.editId) return;
  const name = fsName(_fsc.product);
  const title = cuT(`Cancel the flash sale on "${name}"?`, `取消 "${name}" 的秒杀？`);
  const body = cuT("The product returns to its regular price and the sale leaves the list. This can't be undone.", '商品将恢复原价,此活动会从列表中移除,且无法撤销。');
  if (!(await askConfirm({ title, body, confirmLabel: cuT('Cancel sale', '取消秒杀'), danger: true }))) return;
  try {
    await api(`/api/retail-admin/products/${_fsc.editId}/flash-sale`, { method: 'DELETE' });
    toast(cuT('Flash sale cancelled', '秒杀已取消'));
    fsCloseComposer();
    fscReset();
    await fsLoadList();
  } catch (e) { toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
}

// ─── boot: lazy-load the timeline + composer on first tab open ────────────
document.querySelector('[data-tab="flash"]').addEventListener('click', () => {
  if (!FLASH_LOADED) { FLASH_LOADED = true; fsLoadList(); fscInit(); }
});
document.addEventListener('keydown', (e) => {
  const dw = document.getElementById('fsd-drawer');
  if (e.key === 'Escape' && dw && dw.classList.contains('on')) fsCloseComposer();
});
