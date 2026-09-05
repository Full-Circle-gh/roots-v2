/* eslint-disable no-undef */
/* retail-admin app JS — part 24.  Spreadsheet import, 2026-09-05.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   escapeHtml, cuT, acMoney, applyCapGates) live in 01-core.js and 10-extras.js;
   askConfirm comes from tacet-dialogs.js, which the page loads before this. */
/* ═══════════════════════════════════════════════════════════════════════════
   SPREADSHEET IMPORT — the same flow suppliers already had, for the two things
   a merchant actually has to carry in with them (audit E-05).

   THE FINDING. "Bringing suppliers in from a spreadsheet is a genuinely good
   flow: a template to download, plain instructions, forgiving column names, and
   same-name-updates-rather-than-duplicates. Nothing else can be imported — not
   products, not customers — so a merchant moving from another system types
   their catalogue in by hand." It is the single largest cost of switching.

   WHY A SHARED MODULE AND NOT A SECOND COPY. The supplier importer lives inside
   16-purchasing.js, woven into that screen's own paint()/_screen state machine
   and its pu2- stylesheet. Lifting it out would mean rewriting a flow that
   works, on a screen nobody asked me to touch. So the SHAPE is reused and the
   code is not: this is one spec-driven importer that opens over whatever page
   called it, and adding a third entity later is a spec, not a screen.

   The supplier flow is deliberately left exactly as it is.

   ── TWO THINGS THIS DOES THAT THE ORIGINAL DOES NOT ──────────────────────
   1. It says when the file was longer than the cap. The supplier importer takes
      the first 1000 rows and silently drops the rest, which is the same shape as
      audit J-01 — a screen showing a fraction without saying so. Here row 1001
      onward is reported before anything is imported.
   2. It refuses a row it cannot make sense of instead of importing a broken
      one. A price that is not a number is a REFUSED row with a reason, not a
      zero written into the catalogue.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const T = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);
  const esc = (s) => (typeof escapeHtml === 'function'
    ? escapeHtml(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  // The most rows one import may carry. Not a limit anybody should reach in a
  // migration — it is the point past which a browser building one table of DOM
  // stops being pleasant — and crossing it is REPORTED rather than silent.
  const MAX_ROWS = 1000;

  // ── The parser ───────────────────────────────────────────────────────────
  // Minimal RFC-ish CSV: quoted fields, commas and newlines inside quotes,
  // doubled "" escapes, and a leading BOM stripped (Excel writes one). Same
  // rules as the supplier importer's, restated here rather than imported
  // because that one is closed over a module scope this file cannot reach.
  function parseCsvGrid(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    text = String(text == null ? '' : text).replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* CRLF — the \n does the work */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // A row of nothing but empty cells is a spreadsheet artefact, not a record.
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  // A price/number cell. Returns { ok, value } — `ok:false` REFUSES the row
  // rather than writing 0, because a catalogue full of free products is a worse
  // outcome than an import that says which line it could not read.
  function num(raw, { allowBlank = true } = {}) {
    let s = String(raw == null ? '' : raw).trim().replace(/[¥$€£\s]/g, '');
    if (!s) return allowBlank ? { ok: true, value: null } : { ok: false };
    // A COMMA IS AMBIGUOUS AND IS NOT GUESSED AT. "1,299.00" is a thousands
    // separator; "18,00" is a decimal comma, which is how most of Europe and a
    // fair number of spreadsheet locales write eighteen yuan. Stripping commas
    // unconditionally turns that into 1800 — a hundredfold mis-price, written
    // into a catalogue, silently. So only the unmistakable thousands shape is
    // accepted and everything else is refused with a reason on the row.
    if (s.indexOf(',') >= 0) {
      if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
      else return { ok: false };
    }
    const v = Number(s);
    if (!Number.isFinite(v) || v < 0) return { ok: false };
    return { ok: true, value: v };
  }

  // ── The specs ────────────────────────────────────────────────────────────
  // Column aliases are generous on purpose: a merchant exporting from another
  // system gets whatever that system called it, and the cost of an alias is one
  // line while the cost of a missed column is a hand-typed catalogue.
  const SPECS = {
    products: {
      titleEn: 'Import products', titleCn: '导入商品',
      unitEn: 'products', unitCn: '个商品',
      cap: 'products:edit',
      file: 'products-template.csv',
      header: 'name,name_cn,sku,category,subcategory,price,was_price,stock,weight,barcode,notes',
      examples: [
        'Oat milk 1L,燕麦奶 1L,OAT-1000,Drinks,Milks,18.00,22.00,24,1L,6901234567890,case of 12',
        'Sesame paste,芝麻酱,,Pantry,,32.50,,6,300g,,',
      ],
      map: {
        name: 'name_en', 'name_en': 'name_en', 'english name': 'name_en', product: 'name_en', title: 'name_en',
        'name_cn': 'name_cn', 'chinese name': 'name_cn', '中文名': 'name_cn', '名称': 'name_cn',
        sku: 'sku', code: 'sku', 'item code': 'sku', barcode: 'barcode', ean: 'barcode', upc: 'barcode',
        category: 'top_category', 'top category': 'top_category', type: 'top_category',
        subcategory: 'subcategory', 'sub category': 'subcategory',
        price: 'sell_price', 'sell price': 'sell_price', 'retail price': 'sell_price', '售价': 'sell_price',
        'was_price': 'compare_at_price', 'was price': 'compare_at_price', 'compare at': 'compare_at_price', rrp: 'compare_at_price',
        stock: 'stock_qty', qty: 'stock_qty', quantity: 'stock_qty', 'on hand': 'stock_qty', '库存': 'stock_qty',
        weight: 'weight', size: 'weight', notes: 'notes', note: 'notes',
      },
      // A product needs a name in at least one language. Everything else is optional.
      validate(rec) {
        if (!rec.name_en && !rec.name_cn) return { skip: T('no name', '无名称') };
        const price = num(rec.sell_price);
        if (!price.ok) return { refuse: T('price is not a number', '售价不是数字') };
        const was = num(rec.compare_at_price);
        if (!was.ok) return { refuse: T('was-price is not a number', '原价不是数字') };
        const stock = num(rec.stock_qty);
        if (!stock.ok) return { refuse: T('stock is not a number', '库存不是数字') };
        rec.sell_price = price.value == null ? 0 : price.value;
        rec.compare_at_price = was.value;
        rec.stock_qty = stock.value == null ? 0 : Math.round(stock.value);
        return null;
      },
      // SKU is the catalogue's match key — it is the UNIQUE column the sync
      // paths key on. Falling back to the name means a sheet with no SKU column
      // still updates rather than duplicating.
      keyOf: (rec) => (rec.sku || '').trim().toLowerCase()
                   || (rec.name_en || rec.name_cn || '').trim().toLowerCase(),
      keyOfRow: (row) => (row.sku || '').trim().toLowerCase()
                      || (row.name_en || row.name_cn || '').trim().toLowerCase(),
      async load() {
        const j = await api('/api/retail-admin/products?limit=10000');
        return (j.data || j.products || []).map(p => ({ id: p.id, sku: p.sku, name_en: p.name_en, name_cn: p.name_cn }));
      },
      columns: [
        { hEn: 'Product', hCn: '商品', cell: (r) => esc(r.rec.name_en || r.rec.name_cn || '—') + (r.rec.name_cn && r.rec.name_en ? ' · ' + esc(r.rec.name_cn) : '') },
        { hEn: 'SKU', hCn: '编码', cell: (r) => `<span class="tdi-num">${esc(r.rec.sku || '—')}</span>` },
        { hEn: 'Category', hCn: '分类', cell: (r) => esc([r.rec.top_category, r.rec.subcategory].filter(Boolean).join(' ▸ ') || '—') },
        { hEn: 'Price', hCn: '售价', cell: (r) => `<span class="tdi-num">${r.rec.sell_price != null && typeof acMoney === 'function' ? acMoney(r.rec.sell_price) : (r.rec.sell_price ?? '—')}</span>` },
        { hEn: 'Stock', hCn: '库存', cell: (r) => `<span class="tdi-num">${r.rec.stock_qty ?? '—'}</span>` },
      ],
      create: (rec) => api('/api/retail-admin/products', { method: 'POST', body: rec }),
      update: (id, rec) => api('/api/retail-admin/products/' + id, { method: 'PATCH', body: rec }),
    },

    customers: {
      titleEn: 'Import customers', titleCn: '导入顾客',
      unitEn: 'customers', unitCn: '位顾客',
      cap: 'customers:edit',
      file: 'customers-template.csv',
      header: 'name,phone,email,note,tags',
      examples: [
        'Mrs Huang,13800000000,,orders every Friday,regular;delivery',
        'Walk-in — corner table,,,paid cash,',
      ],
      map: {
        name: 'nickname', nickname: 'nickname', customer: 'nickname', '姓名': 'nickname', '昵称': 'nickname',
        phone: 'phone', mobile: 'phone', tel: 'phone', '电话': 'phone', '手机': 'phone',
        email: 'email', 'e-mail': 'email',
        note: 'note', notes: 'note', remark: 'note', '备注': 'note',
        tags: 'tags', tag: 'tags', labels: 'tags', '标签': 'tags',
      },
      validate(rec) {
        if (!rec.nickname && !rec.phone) return { skip: T('no name and no phone', '无姓名且无电话') };
        if (rec.phone) {
          const digits = String(rec.phone).replace(/\D/g, '');
          if (digits.length < 6) return { refuse: T('phone is too short to be a phone', '电话号码位数不足') };
          rec.phone = digits;
        }
        return null;
      },
      // Phone is the identity here, exactly as it is in the manual-create path
      // the server already runs (createOrReuseManualCustomer reuses on phone).
      // A customer with no phone can only ever be new.
      keyOf: (rec) => String(rec.phone || '').replace(/\D/g, ''),
      keyOfRow: (row) => String(row.phone || '').replace(/\D/g, ''),
      async load() {
        const j = await api('/api/retail-admin/customers?limit=10000');
        return (j.data || j.customers || []).map(c => ({ id: c.id, phone: c.phone }));
      },
      columns: [
        { hEn: 'Customer', hCn: '顾客', cell: (r) => esc(r.rec.nickname || '—') },
        { hEn: 'Phone', hCn: '电话', cell: (r) => `<span class="tdi-num">${esc(r.rec.phone || '—')}</span>` },
        { hEn: 'Note', hCn: '备注', cell: (r) => esc(r.rec.note || '—') },
        { hEn: 'Tags', hCn: '标签', cell: (r) => esc(r.rec.tags || '—') },
      ],
      create: (rec) => api('/api/retail-admin/customers', { method: 'POST', body: rec }),
      // No PUT /customers/:id exists, and the create path already reuses on
      // phone rather than duplicating — so an existing customer is POSTed too
      // and the server links instead of creating. The preview says "links to
      // the existing customer" rather than "updates", because that is what
      // happens: the sheet does not overwrite what is already known.
      update: null,
      updateLabelEn: 'Links to the existing customer', updateLabelCn: '关联到已有顾客',
    },
  };

  // ── State ────────────────────────────────────────────────────────────────
  let _spec = null, _key = null, _rows = null, _file = '', _over = 0, _busy = false;

  // ── The overlay ──────────────────────────────────────────────────────────
  function host() {
    let el = document.getElementById('tdi-root');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tdi-root';
      el.className = 'tdi-scrim';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.hidden = true;
      // Click the scrim (not the panel) to close, same as the shared dialogs.
      el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
      document.body.appendChild(el);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !el.hidden && !_busy) close();
      });
    }
    return el;
  }

  function close() {
    const el = document.getElementById('tdi-root');
    if (el) { el.hidden = true; el.innerHTML = ''; }
    _spec = null; _rows = null; _file = ''; _over = 0;
  }
  window.tdImportClose = close;

  window.tdImportOpen = async function (name) {
    const spec = SPECS[name];
    if (!spec) return;
    _spec = spec; _key = name; _rows = null; _file = ''; _over = 0;
    const el = host();
    el.hidden = false;
    paint();
    // The existing rows decide new-vs-update. Loaded once, on open, so the
    // preview does not have to go back to the server per row.
    try { spec._existing = await spec.load(); }
    catch (e) { spec._existing = []; if (typeof toast === 'function') toast(T('Could not read what you already have — every row will be treated as new.', '无法读取已有数据 —— 所有行都将按新增处理。'), 'err'); }
  };

  function paint() {
    const s = _spec; if (!s) return;
    host().innerHTML = `
      <div class="tdi-panel">
        <div class="tdi-head">
          <h2>${esc(T(s.titleEn, s.titleCn))}</h2>
          <button type="button" class="tdi-x" onclick="tdImportClose()" aria-label="${esc(T('Close', '关闭'))}" title="${esc(T('Close', '关闭'))} (Esc)">&#10005;</button>
        </div>
        <div class="tdi-body">
          <ol class="tdi-steps">
            <li>
              <span class="tdi-n">1</span>
              <div>
                <h3>${esc(T('Download the template', '下载模板'))}</h3>
                <p>${esc(T('A small spreadsheet with the right column names already in the first row. Open it in Excel, WPS or Numbers — it has two example rows you can overwrite.', '一个已经在第一行写好列名的小表格。用 Excel、WPS 或 Numbers 打开 —— 里面有两行示例，直接覆盖即可。'))}</p>
                <button type="button" class="btn btn-sm" onclick="tdImportTemplate()">${esc(T('Download template (.csv)', '下载模板 (.csv)'))}</button>
                <div class="tdi-peek">${esc(s.header)}</div>
              </div>
            </li>
            <li>
              <span class="tdi-n">2</span>
              <div>
                <h3>${esc(T('Fill it in — one row each', '填写 —— 每行一条'))}</h3>
                <ul class="tdi-list">
                  ${s.rulesHtml ? s.rulesHtml() : `<li>${esc(rule1(s))}</li>`}
                  <li>${esc(T('Keep the first row (the column names) exactly as it is.', '保持第一行（列名）不变。'))}</li>
                  <li>${esc(T('Column names are matched loosely — "Price", "price" and "Sell price" all work.', '列名匹配比较宽松 —— “Price”“price”“Sell price”都可以。'))}</li>
                  <li>${esc(T('When done: File → Save As → CSV. Excel may warn about the format — choose Keep.', '完成后：文件 → 另存为 → CSV。Excel 可能提示格式 —— 选择“保留”。'))}</li>
                </ul>
              </div>
            </li>
            <li>
              <span class="tdi-n">3</span>
              <div style="flex:1;min-width:0">
                <h3>${esc(T('Upload and check', '上传并核对'))}</h3>
                <p>${esc(T('We show what will happen to every row. Nothing is saved until you press Import.', '我们会显示每一行将发生什么。在你点击导入前不会保存任何内容。'))}</p>
                <label class="tdi-drop">
                  <input type="file" accept=".csv,text/csv" onchange="tdImportFile(this)" hidden>
                  <b>${esc(T('Choose your .csv file', '选择 .csv 文件'))}</b>
                </label>
                <div id="tdi-preview"></div>
              </div>
            </li>
          </ol>
        </div>
      </div>`;
    if (_rows) renderPreview();
  }

  function rule1(s) {
    return _key === 'customers'
      ? T('A name or a phone number — one of the two is enough.', '姓名或电话，二者有其一即可。')
      : T('Only the name column must be filled. Leave anything else empty.', '只有 name 列必填，其余可留空。');
  }

  window.tdImportTemplate = function () {
    const s = _spec; if (!s) return;
    // BOM first: without it Excel on a Chinese locale reads UTF-8 as GBK and the
    // 中文 column names arrive as mojibake, which makes the template look broken
    // to exactly the merchants it was translated for.
    const csv = '﻿' + [s.header, ...s.examples].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = s.file;
    document.body.appendChild(a); a.click(); a.remove();
  };

  window.tdImportFile = function (input) {
    const s = _spec; if (!s) return;
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => { if (typeof toast === 'function') toast(T('That file could not be read.', '无法读取该文件。'), 'err'); };
    reader.onload = () => {
      try {
        const grid = parseCsvGrid(String(reader.result));
        if (grid.length < 2) {
          if (typeof toast === 'function') toast(T('That file has no data rows.', '文件中没有数据行。'), 'err');
          return;
        }
        const headers = grid[0].map(h => String(h).trim().toLowerCase());
        const known = headers.filter(h => s.map[h]).length;
        if (!known) {
          if (typeof toast === 'function') toast(T('None of those column names are ones we recognise — download the template and use its first row.', '无法识别这些列名 —— 请下载模板并使用它的第一行。'), 'err', 6000);
          return;
        }
        const body = grid.slice(1);
        _over = Math.max(0, body.length - MAX_ROWS);      // reported, never silent
        const byKey = new Map();
        for (const row of (s._existing || [])) {
          const k = s.keyOfRow(row);
          if (k && !byKey.has(k)) byKey.set(k, row);
        }
        _rows = body.slice(0, MAX_ROWS).map((cells, idx) => {
          const rec = {};
          headers.forEach((h, ci) => {
            const f = s.map[h];
            if (!f) return;
            const v = String(cells[ci] == null ? '' : cells[ci]).trim();
            if (v) rec[f] = v;
          });
          const verdict = s.validate(rec) || null;
          if (verdict && verdict.skip)   return { line: idx + 2, rec, action: 'skip',   why: verdict.skip };
          if (verdict && verdict.refuse) return { line: idx + 2, rec, action: 'refuse', why: verdict.refuse };
          const k = s.keyOf(rec);
          const hit = k ? byKey.get(k) : null;
          return { line: idx + 2, rec, action: hit ? 'update' : 'new', existingId: hit ? hit.id : null };
        });
        _file = file.name;
        renderPreview();
      } catch (e) {
        if (typeof toast === 'function') toast(e.message, 'err');
      }
    };
    reader.readAsText(file);
  };

  function renderPreview() {
    const s = _spec, box = document.getElementById('tdi-preview');
    if (!box || !s || !_rows) return;
    const n = (a) => _rows.filter(r => r.action === a).length;
    const news = n('new'), upds = n('update'), skips = n('skip'), refused = n('refuse');
    const willDo = news + upds;
    const pill = (cls, count, label) => count ? `<span class="tdi-pill ${cls}">${count} ${esc(label)}</span>` : '';
    const updLabel = T(s.updateLabelEn || 'will update existing', s.updateLabelCn || '更新已有');
    box.innerHTML = `
      <div class="tdi-sum">
        <div><b>${esc(_file)}</b> — ${_rows.length} ${esc(T('rows read.', '行已读取。'))}</div>
        ${_over ? `<div class="tdi-over">${esc(T(
            `Only the first ${MAX_ROWS} rows were read — ${_over} more are in the file and will NOT be imported. Split the sheet and import it in two goes.`,
            `只读取了前 ${MAX_ROWS} 行 —— 文件中还有 ${_over} 行不会被导入。请把表格拆开分两次导入。`))}</div>` : ''}
        <div class="tdi-pills">
          ${pill('ok', news, T('new', '新增'))}
          ${pill('upd', upds, updLabel)}
          ${pill('skip', skips, T('skipped', '跳过'))}
          ${pill('bad', refused, T('cannot be read', '无法读取'))}
        </div>
      </div>
      <div class="tdi-tblwrap">
        <table class="tdi-tbl">
          <thead><tr>
            <th>${esc(T('Row', '行'))}</th>
            ${s.columns.map(c => `<th>${esc(T(c.hEn, c.hCn))}</th>`).join('')}
            <th>${esc(T('What happens', '结果'))}</th>
          </tr></thead>
          <tbody>
            ${_rows.map(r => `<tr class="tdi-r-${r.action}">
              <td class="tdi-num">${r.line}</td>
              ${s.columns.map(c => `<td>${c.cell(r)}</td>`).join('')}
              <td>${
                r.action === 'new' ? `<span class="tdi-pill ok">${esc(T('New', '新增'))}</span>`
                : r.action === 'update' ? `<span class="tdi-pill upd">${esc(updLabel)}</span>`
                : r.action === 'skip' ? `<span class="tdi-pill skip">${esc(T('Skipped', '跳过'))} — ${esc(r.why)}</span>`
                : `<span class="tdi-pill bad">${esc(T('Not imported', '未导入'))} — ${esc(r.why)}</span>`
              }</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="tdi-foot">
        <button type="button" class="btn btn-sm" onclick="tdImportReset()">${esc(T('Choose a different file', '换一个文件'))}</button>
        <span style="flex:1"></span>
        <button type="button" class="btn btn-primary" id="tdi-go" data-cap="${esc(s.cap)}"
                onclick="tdImportRun()" ${willDo ? '' : 'disabled'}>
          ${esc(T('Import', '导入'))} ${willDo} ${esc(T(s.unitEn, s.unitCn))}
        </button>
      </div>`;
    try { if (typeof applyCapGates === 'function') applyCapGates(); } catch (e) { /* the gate is a nicety; the server still refuses */ }
  }

  window.tdImportReset = function () { _rows = null; _file = ''; _over = 0; paint(); };

  window.tdImportRun = async function () {
    const s = _spec; if (!s || !_rows || _busy) return;
    const jobs = _rows.filter(r => r.action === 'new' || r.action === 'update');
    if (!jobs.length) return;
    _busy = true;
    const go = document.getElementById('tdi-go');
    if (go) { go.disabled = true; go.textContent = T('Importing…', '导入中…'); }
    let ok = 0;
    const failures = [];
    for (const r of jobs) {
      try {
        if (r.action === 'update' && r.existingId && s.update) await s.update(r.existingId, r.rec);
        else await s.create(r.rec);
        ok++;
      } catch (e) {
        // Which LINE failed and why. "3 failed" with no line numbers is a
        // spreadsheet the merchant has to diff by eye against their catalogue.
        failures.push({ line: r.line, why: (e && e.message) || T('refused', '被拒绝') });
      }
    }
    _busy = false;
    if (typeof toast === 'function') {
      const msg = T(`Imported ${ok} of ${jobs.length}`, `已导入 ${ok} / ${jobs.length}`)
        + (failures.length ? T(` · ${failures.length} failed`, ` · ${failures.length} 失败`) : ' ✓');
      toast(msg, failures.length ? 'err' : 'ok', 5000);
    }
    if (failures.length && typeof askConfirm === 'function') {
      await askConfirm({
        titleEn: `${failures.length} row(s) were not imported`,
        titleCn: `${failures.length} 行未能导入`,
        bodyEn: failures.slice(0, 12).map(f => `Row ${f.line}: ${f.why}`).join('\n')
              + (failures.length > 12 ? `\n… and ${failures.length - 12} more` : ''),
        bodyCn: failures.slice(0, 12).map(f => `第 ${f.line} 行：${f.why}`).join('\n')
              + (failures.length > 12 ? `\n… 另有 ${failures.length - 12} 行` : ''),
        confirmEn: 'Close', confirmCn: '关闭', hideCancel: true,
      });
    }
    close();
    // Let the page that opened this refresh itself. Both callers already have a
    // loader; naming them here would tie this module to two screens.
    try { document.dispatchEvent(new CustomEvent('td-import-done', { detail: { entity: _key, imported: ok } })); } catch (e) { /* older engines: the toast still reported it */ }
  };

  // Exported for scripts/test_csv_import.js, which runs the parser and the
  // row classifier for real rather than reimplementing them.
  window.__tdImportInternals = { parseCsvGrid, num, SPECS, MAX_ROWS };

  // ── Styles ───────────────────────────────────────────────────────────────
  // Scoped to #tdi-root and written against the app's own tokens, so this
  // follows the tenant's theme instead of pinning colours of its own.
  const CSS = `
  #tdi-root.tdi-scrim { position:fixed; inset:0; z-index:9000; background:rgba(0,0,0,.45);
    display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; overflow:auto; }
  #tdi-root[hidden] { display:none !important; }
  #tdi-root .tdi-panel { background:var(--bg-elev-1,#fff); color:var(--text-1,#1a1a17);
    border-radius:14px; width:min(1040px,100%); box-shadow:0 24px 64px rgba(0,0,0,.28); overflow:hidden; }
  #tdi-root .tdi-head { display:flex; align-items:center; gap:12px; padding:18px 24px;
    border-bottom:1px solid var(--line,#e7e5e0); }
  #tdi-root .tdi-head h2 { margin:0; font-size:19px; font-weight:600; flex:1; }
  #tdi-root .tdi-x { background:none; border:0; font-size:17px; cursor:pointer; color:var(--text-2,#6b6b63);
    width:34px; height:34px; border-radius:8px; }
  #tdi-root .tdi-x:hover { background:var(--raised,#f2f0ec); }
  #tdi-root .tdi-body { padding:8px 24px 24px; }
  #tdi-root .tdi-steps { list-style:none; margin:0; padding:0; }
  #tdi-root .tdi-steps > li { display:flex; gap:14px; padding:18px 0; border-bottom:1px solid var(--line,#e7e5e0); }
  #tdi-root .tdi-steps > li:last-child { border-bottom:0; }
  #tdi-root .tdi-n { flex:none; width:26px; height:26px; border-radius:50%; display:grid; place-items:center;
    background:var(--raised,#f2f0ec); color:var(--text-2,#6b6b63); font-size:12px; font-weight:600; }
  #tdi-root h3 { margin:2px 0 6px; font-size:14px; font-weight:600; }
  #tdi-root p { margin:0 0 10px; font-size:13px; color:var(--text-2,#6b6b63); line-height:1.55; }
  #tdi-root .tdi-list { margin:0; padding-left:18px; font-size:13px; color:var(--text-2,#6b6b63); line-height:1.7; }
  #tdi-root .tdi-peek { margin-top:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px;
    background:var(--raised,#f2f0ec); border-radius:8px; padding:9px 11px; color:var(--text-2,#6b6b63);
    overflow-x:auto; white-space:nowrap; }
  #tdi-root .tdi-drop { display:inline-block; border:1.5px dashed var(--line,#d8d5cf); border-radius:10px;
    padding:16px 22px; cursor:pointer; font-size:13px; }
  #tdi-root .tdi-drop:hover { border-color:var(--accent,#8a8f70); }
  #tdi-root .tdi-sum { margin-top:16px; font-size:13px; }
  #tdi-root .tdi-over { margin-top:8px; padding:9px 12px; border-radius:8px; font-size:12.5px;
    background:rgba(196,143,42,.12); color:var(--amber-ink,#7a5a12); }
  #tdi-root .tdi-pills { display:flex; flex-wrap:wrap; gap:7px; margin:10px 0 4px; }
  #tdi-root .tdi-pill { display:inline-block; font-size:11.5px; padding:2px 9px; border-radius:999px; white-space:nowrap; }
  #tdi-root .tdi-pill.ok   { background:rgba(122,140,90,.16); color:var(--sage-ink,#4d5a33); }
  #tdi-root .tdi-pill.upd  { background:rgba(196,143,42,.16); color:var(--amber-ink,#7a5a12); }
  #tdi-root .tdi-pill.skip { background:var(--raised,#f2f0ec); color:var(--text-2,#6b6b63); }
  #tdi-root .tdi-pill.bad  { background:rgba(168,74,58,.14); color:var(--brick-ink,#8a3a2c); }
  #tdi-root .tdi-tblwrap { margin-top:12px; max-height:46vh; overflow:auto; border:1px solid var(--line,#e7e5e0); border-radius:10px; }
  #tdi-root .tdi-tbl { width:100%; border-collapse:collapse; font-size:12.5px; }
  #tdi-root .tdi-tbl th { position:sticky; top:0; background:var(--bg-elev-1,#fff); text-align:left;
    padding:9px 12px; border-bottom:1px solid var(--line,#e7e5e0); font-weight:600; white-space:nowrap; }
  #tdi-root .tdi-tbl td { padding:8px 12px; border-bottom:1px solid var(--line-soft,#f0eee9); vertical-align:top; }
  #tdi-root .tdi-tbl tr:last-child td { border-bottom:0; }
  #tdi-root .tdi-r-skip td, #tdi-root .tdi-r-refuse td { color:var(--text-2,#6b6b63); }
  #tdi-root .tdi-num { font-variant-numeric:tabular-nums; }
  #tdi-root .tdi-foot { display:flex; align-items:center; gap:10px; margin-top:16px; }
  @media (max-width:720px) {
    #tdi-root.tdi-scrim { padding:0; }
    #tdi-root .tdi-panel { border-radius:0; min-height:100vh; }
  }`;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
})();
