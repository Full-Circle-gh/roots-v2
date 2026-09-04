/* eslint-disable no-undef */
/* retail-admin app JS — part 23.  SKU codes (编码规则), 2026-09-04.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   escapeHtml, cuT, can, CAPS) live in 01-core.js.

   Settings → SKU codes. The tenant says how its codes are SHAPED, per category
   and subcategory, and routes/retail-materials.js fills the SKU field in on
   every new material. The engine is lib/sku-format.js (the token template) and
   lib/sku-rules.js (which rule applies, and what number it gets); this file is
   only the screen.

   THREE LEVELS, MOST SPECIFIC WINS — a subcategory's own rule, else its
   category's, else the one default. The screen is built around that order
   rather than around a flat list, because "which rule numbered this?" is the
   question an operator actually has, and a flat list of nine rules does not
   answer it. Each rule row therefore states what it governs and what its next
   code will be, in full, rather than leaving either to be inferred.

   NUMBERING RESTARTS WHERE A RULE IS DEFINED. Give Dried fruits its own rule
   and dried fruits get their own series; leave it to the Food rule and
   everything under Food shares one. That is why there is no "restart numbering
   per…" setting to get wrong — the shape of the rule list IS the answer, and
   the screen says so on every row.

   Prefix is sku-*. Painted into #sku-root inside <div class="sub-panel"
   id="sub-sku">, which is data-no-i18n: every string here is baked by cuT(),
   so the i18n walker must not touch it. */

(function () {
  'use strict';

  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const T = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);

  // Materials are the only entity wired today (Ash, 2026-09-04: "we start with
  // material first and see how it goes"). Recipes and products reach the same
  // two libraries through the same routes when their turn comes, which is why
  // this is a variable rather than a string typed into eight URLs.
  const ENTITY = 'material';

  let _data = null;      // the last GET /sku/material payload
  let _draft = null;     // the rule being added or edited, or null
  let _loading = false;

  const root = () => document.getElementById('sku-root');

  // The kind values stored on ingredients.item_kind are lower-case slugs; the
  // Materials screen shows them in words, and so must this one — an operator
  // who files things under "Food" should not have to recognise `food`.
  const KIND_LABEL = {
    food: () => T('Food', '食品'),
    packaging: () => T('Packaging', '包装'),
    equipment: () => T('Equipment', '设备'),
    retail: () => T('Retail', '零售'),
    other: () => T('Other', '其他'),
  };
  const kindLabel = k => (KIND_LABEL[k] ? KIND_LABEL[k]() : k);

  const canEdit = () => (typeof can !== 'function' ? true : can('materials:edit'));

  // ── load ──────────────────────────────────────────────────────────────────
  window.skuLoad = async function () {
    if (_loading) return;
    _loading = true;
    const host = root();
    if (host && !_data) host.innerHTML = `<div class="muted" style="padding:24px">${esc(T('Loading…', '加载中…'))}</div>`;
    try {
      _data = await api('/api/retail-admin/sku/' + ENTITY);
      paint();
    } catch (e) {
      if (host) {
        host.innerHTML = `<div class="group-card"><div class="muted">`
          + esc(T('Could not load the SKU rules', '无法加载编码规则')) + ': ' + esc(e.message || '') + `</div></div>`;
      }
    } finally {
      _loading = false;
    }
  };

  // ── paint ─────────────────────────────────────────────────────────────────
  function paint() {
    const host = root();
    if (!host || !_data) return;
    const on = !!(_data.settings && _data.settings.enabled);
    const rules = _data.rules || [];
    const def = rules.find(r => r.scope === 'default');
    const scoped = rules.filter(r => r.scope !== 'default');

    host.innerHTML = STYLE + `
      <h2>${esc(T('SKU codes', '编码规则'))}</h2>

      <div class="group-card">
        <div class="group-card-head">
          <h3>${esc(T('Automatic SKUs for materials', '物料自动编码'))}</h3>
          <div class="muted">${esc(T(
            'Give a category the shape of its code once, and every new material filed under it is numbered for you. Codes already on your catalogue are never changed, and you can always type your own instead.',
            '为分类设定一次编码格式,之后归入该分类的每个新物料都会自动编号。已有编码不会被修改,您也可以随时手动输入。'))}</div>
        </div>
        <label class="sku-switch">
          <input type="checkbox" id="sku-enabled" ${on ? 'checked' : ''} ${canEdit() ? '' : 'disabled'} onchange="skuToggle(this.checked)">
          <span>${esc(T('Generate a SKU when a material is saved without one', '保存未填写编码的物料时自动生成'))}</span>
        </label>
        ${on ? '' : `<div class="sku-note">${esc(T(
          'Numbering is off. New materials are saved with whatever SKU is typed, and blank if none is — exactly as before.',
          '自动编号已关闭。新物料按手动填写的编码保存,未填写则留空 —— 与以前一致。'))}</div>`}
      </div>

      ${tokenCard()}

      <div class="group-card">
        <div class="group-card-head">
          <h3>${esc(T('Your rules', '您的规则'))}</h3>
          <div class="muted">${esc(T(
            'A material takes the most specific rule that fits it: its own subcategory first, then its category, then the fallback at the bottom. Each rule counts on its own — that is where a number series starts over.',
            '物料按最具体的规则编码:先看所属子分类,再看主分类,最后使用底部的兜底规则。每条规则各自计数 —— 序号也从这里重新开始。'))}</div>
        </div>

        ${scoped.length ? scoped.map(ruleRow).join('') : `<div class="sku-empty">${esc(T(
          'No category rules yet. Everything is numbered by the fallback below.',
          '尚未设置分类规则,当前全部使用下方兜底规则编号。'))}</div>`}

        ${canEdit() ? `<button class="btn" style="margin-top:12px" onclick="skuAdd()">+ ${esc(T('Add a rule', '新增规则'))}</button>` : ''}
        <div id="sku-draft"></div>
      </div>

      <div class="group-card">
        <div class="group-card-head">
          <h3>${esc(T('Fallback', '兜底规则'))}</h3>
          <div class="muted">${esc(T(
            'Used for anything with no rule of its own, so nothing is ever left without a code. It cannot be deleted — only changed.',
            '用于没有专属规则的物料,确保任何物料都有编码。此规则不可删除,只能修改。'))}</div>
        </div>
        ${def ? ruleRow(def) : ''}
      </div>
    `;
    if (_draft) paintDraft();
  }

  // The token palette. Built from the server's catalogue (lib/sku-format.js's
  // TOKENS), so a token added to the engine appears here without this file
  // being touched — and one that is removed cannot be advertised any more.
  function tokenCard() {
    const toks = _data.tokens || [];
    return `
      <div class="group-card">
        <div class="group-card-head">
          <h3>${esc(T('How a code is built', '编码由什么组成'))}</h3>
          <div class="muted">${esc(T(
            'Type the code you want and drop in a piece wherever the value changes. Everything else — letters, dashes, slashes — appears exactly as you type it.',
            '直接输入想要的编码,在需要变化的位置插入下列组件。其余字符(字母、连字符、斜杠)将原样出现。'))}</div>
        </div>
        <div class="sku-toks">
          ${toks.map(t => `
            <button type="button" class="sku-tok" onclick="skuInsert('${esc(t.insert)}')" title="${esc(T(t.hint_en, t.hint_cn))}">
              <code>${esc(t.insert)}</code>
              <span>${esc(T(t.label_en, t.label_cn))}</span>
            </button>`).join('')}
        </div>
        <div class="sku-eg">
          <span class="muted">${esc(T('For example', '示例'))}:</span>
          <code>B-{SEQ:4}</code> <span class="sku-arrow">→</span> <b>B-0001</b>, <b>B-0002</b>
          <span class="sku-sep">·</span>
          <code>{CAT}{SUB}{SEQ:3}</code> <span class="sku-arrow">→</span> <b>FDF001</b>
        </div>
      </div>`;
  }

  // One rule. It states what it governs, what it produces next, and how many
  // materials sit under it — the last of those is what makes a rule written
  // against a category that no longer exists visible instead of quietly dead.
  function ruleRow(r) {
    const isDefault = r.scope === 'default';
    const what = isDefault
      ? T('Everything else', '其余全部')
      : (r.scope === 'subcategory'
        ? kindLabel(r.category) + ' ▸ ' + r.subcategory
        : T('All of ', '全部 ') + kindLabel(r.category));
    const scopeNote = isDefault
      ? T('when no rule above fits', '当上方规则都不适用时')
      : (r.scope === 'subcategory'
        ? T('this subcategory only', '仅此子分类')
        : T('every category here without its own rule', '此类下所有没有专属规则的分类'));
    return `
      <div class="sku-rule${isDefault ? ' is-default' : ''}">
        <div class="sku-rule-main">
          <div class="sku-rule-what">
            ${esc(what)}
            ${r.code ? `<span class="sku-code">${esc(r.code)}</span>` : ''}
          </div>
          <div class="sku-rule-scope">${esc(scopeNote)}</div>
        </div>
        <div class="sku-rule-fmt">
          <code>${esc(r.pattern)}</code>
          <div class="sku-rule-next">
            ${esc(T('next', '下一个'))}: <b>${esc(previewOf(r))}</b>
            ${r.in_use != null ? `<span class="sku-sep">·</span>${esc(String(r.in_use))} ${esc(T('materials', '个物料'))}` : ''}
          </div>
        </div>
        <div class="sku-rule-act">
          ${canEdit() ? `<button class="btn btn-sm" onclick="skuEdit(${r.id})">${esc(T('Edit', '编辑'))}</button>` : ''}
          ${canEdit() && !isDefault ? `<button class="btn btn-sm sku-danger" onclick="skuDelete(${r.id})">${esc(T('Remove', '删除'))}</button>` : ''}
        </div>
      </div>`;
  }

  // The rule's next code, rendered client-side from the pattern the server
  // sent. Kept to the tokens the row can actually resolve — {NAME} needs a
  // material and there isn't one here, so it renders empty rather than
  // inventing a name the operator would then look for.
  function previewOf(r) {
    return renderPattern(r.pattern, {
      seq: r.next_seq || 1,
      categoryCode: r.scope === 'category' ? r.code : catCodeFor(r.category),
      subcategoryCode: r.scope === 'subcategory' ? r.code : '',
      name: '',
    });
  }

  function catCodeFor(category) {
    const c = String(category || '').toLowerCase();
    const hit = (_data.rules || []).find(r => r.scope === 'category' && String(r.category).toLowerCase() === c);
    return hit ? hit.code : '';
  }

  // A browser-side twin of lib/sku-format.js's render(), for previews only. It
  // is NOT what issues a code — the server does that, from the same pattern —
  // so a drift here shows a wrong preview, never a wrong SKU. Kept to the same
  // token list the server sent so an added token degrades to blank instead of
  // printing its own braces back at the operator.
  function renderPattern(pattern, ctx) {
    const now = new Date();
    const pad = (n, w) => String(n).padStart(w, '0');
    return String(pattern || '').replace(/\{([A-Z]+)(?::(\d))?\}/g, (raw, name, arg) => {
      switch (name) {
        case 'SEQ': { const w = arg === undefined ? 4 : Number(arg); return w > 0 ? pad(ctx.seq, w) : String(ctx.seq); }
        case 'CAT': return String(ctx.categoryCode || '');
        case 'SUB': return String(ctx.subcategoryCode || '');
        case 'YYYY': return String(now.getFullYear());
        case 'YY': return String(now.getFullYear()).slice(-2);
        case 'MM': return pad(now.getMonth() + 1, 2);
        case 'DD': return pad(now.getDate(), 2);
        case 'NAME': { const n = arg === undefined ? 3 : Number(arg);
          const letters = String(ctx.name || '').toUpperCase().replace(/[^A-Z]/g, '');
          return n > 0 ? letters.slice(0, n) : letters; }
        default: return '';
      }
    }).toUpperCase();
  }

  // ── the add / edit form ───────────────────────────────────────────────────
  window.skuAdd = function () {
    const kinds = (_data.levels && _data.levels.kinds) || [];
    _draft = { id: null, category: kinds[0] || 'food', subcategory: '', code: '', pattern: '{SUB}{SEQ:4}' };
    paintDraft(true);
  };

  window.skuEdit = function (id) {
    const r = (_data.rules || []).find(x => x.id === id);
    if (!r) return;
    _draft = { id: r.id, category: r.category, subcategory: r.subcategory, code: r.code, pattern: r.pattern, locked: r.scope === 'default' };
    paintDraft(true);
  };

  window.skuCancel = function () { _draft = null; paintDraft(); };

  function paintDraft(scroll) {
    const host = document.getElementById('sku-draft');
    if (!host) return;
    if (!_draft) { host.innerHTML = ''; return; }
    const d = _draft;
    const levels = _data.levels || { kinds: [], byKind: {} };
    const kinds = levels.kinds.length ? levels.kinds : ['food'];
    const subs = (levels.byKind && levels.byKind[d.category]) || [];

    host.innerHTML = `
      <div class="sku-form">
        <div class="sku-form-h">${esc(d.id ? T('Edit rule', '编辑规则') : T('New rule', '新增规则'))}</div>
        ${d.locked ? `<div class="sku-note">${esc(T(
          'This is the fallback — it applies to everything with no rule of its own, so it has no category to choose.',
          '这是兜底规则,适用于所有没有专属规则的物料,因此无需选择分类。'))}</div>` : `
        <div class="sku-form-grid">
          <label>
            <span>${esc(T('Kind', '类别'))}</span>
            <select id="sku-d-cat" onchange="skuDraftKind(this.value)">
              ${kinds.map(k => `<option value="${esc(k)}"${k === d.category ? ' selected' : ''}>${esc(kindLabel(k))}</option>`).join('')}
            </select>
          </label>
          <label>
            <span>${esc(T('Category', '分类'))}</span>
            <select id="sku-d-sub" onchange="skuDraftField('subcategory', this.value)">
              <option value="">${esc(T('— all of this kind —', '— 此类别全部 —'))}</option>
              ${subs.map(sc => `<option value="${esc(sc)}"${sc === d.subcategory ? ' selected' : ''}>${esc(sc)}</option>`).join('')}
              ${d.subcategory && !subs.includes(d.subcategory)
                ? `<option value="${esc(d.subcategory)}" selected>${esc(d.subcategory)}</option>` : ''}
            </select>
            <em>${esc(T('The categories your materials are actually filed under.', '此处列出物料实际使用的分类。'))}</em>
          </label>
          <label>
            <span>${esc(T('Code', '代码'))}</span>
            <input id="sku-d-code" maxlength="8" value="${esc(d.code || '')}"
                   placeholder="B" oninput="skuDraftField('code', this.value)">
            <em>${esc(T('What {CAT} or {SUB} stands for here — e.g. B for dried fruits.', '此处 {CAT} 或 {SUB} 代表的字符 —— 例如干果为 B。'))}</em>
          </label>
        </div>`}
        <label class="sku-wide">
          <span>${esc(T('Format', '格式'))}</span>
          <input id="sku-d-pattern" maxlength="60" value="${esc(d.pattern || '')}"
                 spellcheck="false" oninput="skuDraftField('pattern', this.value)">
        </label>
        <div class="sku-live" id="sku-live"></div>
        <div class="sku-form-act">
          <button class="btn btn-primary" onclick="skuSaveDraft()">${esc(T('Save rule', '保存规则'))}</button>
          <button class="btn" onclick="skuCancel()">${esc(T('Cancel', '取消'))}</button>
        </div>
      </div>`;
    paintLive();
    if (scroll) host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  window.skuDraftKind = function (v) {
    // Changing the kind invalidates the category beneath it — the old value
    // belongs to a different branch of the tree, and carrying it over would
    // save a rule for "Packaging ▸ Dried fruits".
    _draft.category = v;
    _draft.subcategory = '';
    paintDraft();
  };

  window.skuDraftField = function (k, v) {
    _draft[k] = v;
    paintLive();
  };

  window.skuInsert = function (token) {
    const el = document.getElementById('sku-d-pattern');
    if (!el || !_draft) {
      toast(T('Open a rule first, then add a piece to its format.', '请先打开一条规则,再插入组件。'));
      return;
    }
    // Insert at the caret rather than appending — a token belongs where the
    // operator is looking, and a pattern is built middle-out as often as not.
    const start = el.selectionStart == null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
    el.value = el.value.slice(0, start) + token + el.value.slice(end);
    _draft.pattern = el.value;
    el.focus();
    el.setSelectionRange(start + token.length, start + token.length);
    paintLive();
  };

  // The line under the Format field: three consecutive codes this pattern would
  // produce, and any complaint about it. Rendered locally on every keystroke —
  // the server validates again on save, and that answer is the one that counts.
  function paintLive() {
    const box = document.getElementById('sku-live');
    if (!box || !_draft) return;
    const d = _draft;
    const bad = (d.pattern || '').match(/\{[^}]*\}/g) || [];
    const known = (_data.tokens || []).map(t => t.name);
    const unknown = bad.filter(b => !known.some(n => new RegExp('^\\{' + n + '(:\\d)?\\}$').test(b)));
    const hasSeq = /\{SEQ(:\d)?\}/.test(d.pattern || '');
    const unsafe = /[^A-Za-z0-9._/{}:-]/.test(d.pattern || '');

    const samples = [1, 2, 3].map(seq => renderPattern(d.pattern, {
      seq,
      categoryCode: d.subcategory ? catCodeFor(d.category) : d.code,
      subcategoryCode: d.subcategory ? d.code : '',
      name: 'Dried Mango',
    }));

    const problems = [];
    if (!String(d.pattern || '').trim()) problems.push(T('A format is required.', '必须填写格式。'));
    if (unknown.length) problems.push(T(`${unknown.join(', ')} is not one of the pieces above.`, `${unknown.join('、')} 不是上方可用的组件。`));
    if (unsafe) problems.push(T('A code may only contain letters, digits and . _ / - — remove any spaces.', '编码只能包含字母、数字与 . _ / -,请删除空格。'));

    box.innerHTML = problems.length
      ? `<div class="sku-bad">${problems.map(p => esc(p)).join('<br>')}</div>`
      : `<div class="sku-samples">
           <span class="muted">${esc(T('Produces', '生成'))}</span>
           ${samples.map(s => `<b>${esc(s)}</b>`).join('<span class="sku-arrow">→</span>')}
         </div>
         ${hasSeq ? '' : `<div class="sku-warn">${esc(T(
           'Without a Number, every material here would get the same code — the system will add one to keep them apart.',
           '缺少“流水号”时,此范围内的物料编码将完全相同,系统会自动追加数字加以区分。'))}</div>`}`;
  }

  // ── writes ────────────────────────────────────────────────────────────────
  window.skuToggle = async function (on) {
    try {
      await api('/api/retail-admin/sku/' + ENTITY + '/settings', { method: 'PUT', body: { enabled: !!on } });
      toast(on ? T('Automatic SKUs are on', '已开启自动编码') : T('Automatic SKUs are off', '已关闭自动编码'));
      await skuLoad();
    } catch (e) {
      toast(T('Could not change the setting', '设置未能保存') + ': ' + (e.message || ''), 'err');
      await skuLoad();
    }
  };

  window.skuSaveDraft = async function () {
    if (!_draft) return;
    const d = _draft;
    try {
      const j = await api('/api/retail-admin/sku/' + ENTITY + '/rules', {
        method: 'POST',
        body: {
          category: d.locked ? '' : (d.category || ''),
          subcategory: d.locked ? '' : (d.subcategory || ''),
          code: d.locked ? '' : (d.code || ''),
          pattern: d.pattern || '',
        },
      });
      _draft = null;
      // A warning is not a refusal — the rule saved. Say what is odd about it
      // and leave the operator holding the decision.
      if (j.warnings && j.warnings.length) {
        toast(T(j.warnings[0].message_en, j.warnings[0].message_cn));
      } else {
        toast(T('Rule saved', '规则已保存'));
      }
      await skuLoad();
    } catch (e) {
      const detail = e.data && e.data.detail && e.data.detail[0];
      const code = e.data && e.data.error;
      const msg = detail ? T(detail.message_en, detail.message_cn)
        : code === 'subcategory_needs_category' ? T('Pick a kind before a category.', '请先选择类别,再选择分类。')
          : code === 'code_unsafe' ? T('A code may only contain letters, digits and . _ / -', '代码只能包含字母、数字与 . _ / -')
            : code === 'code_too_long' ? T('A code may be at most 8 characters.', '代码最多 8 个字符。')
              : (e.message || '');
      toast(T('Could not save the rule', '规则保存失败') + ': ' + msg, 'err');
    }
  };

  window.skuDelete = async function (id) {
    const r = (_data.rules || []).find(x => x.id === id);
    if (!r) return;
    // What removing it MEANS, not just "are you sure": the materials under it
    // keep the codes they have and future ones fall to the level above.
    const where = r.scope === 'subcategory' ? kindLabel(r.category) + ' ▸ ' + r.subcategory : T('All of ', '全部 ') + kindLabel(r.category);
    const ok = confirm(T(
      `Remove the rule for ${where}?\n\nMaterials already coded keep their SKUs. New ones will be numbered by the rule above it instead.`,
      `删除 ${where} 的编码规则?\n\n已有物料的编码保持不变,新物料将改用上一层规则编号。`));
    if (!ok) return;
    try {
      await api('/api/retail-admin/sku/' + ENTITY + '/rules/' + id, { method: 'DELETE' });
      toast(T('Rule removed', '规则已删除'));
      await skuLoad();
    } catch (e) {
      toast(T('Could not remove the rule', '删除失败') + ': ' + (e.message || ''), 'err');
    }
  };

  // ── styles ────────────────────────────────────────────────────────────────
  // Scoped to #sku-root and written against the app's own tokens (--line,
  // --bg-elev-1, --text-*, --accent) so the panel follows the tenant's theme
  // instead of pinning colours of its own.
  const STYLE = `<style>
    #sku-root h2 { margin: 0 0 16px; }
    #sku-root .sku-switch { display:flex; align-items:center; gap:10px; font-size:13px; color:var(--text-1); cursor:pointer; padding:4px 2px 2px; }
    #sku-root .sku-switch input { width:18px; height:18px; cursor:pointer; }
    #sku-root .sku-note { margin-top:10px; padding:8px 10px; border-left:2px solid var(--line); background:var(--bg-elev-1); border-radius:0 4px 4px 0; font-size:12px; color:var(--text-2); line-height:1.6; }

    #sku-root .sku-toks { display:flex; flex-wrap:wrap; gap:8px; padding:2px 2px 12px; }
    #sku-root .sku-tok { display:flex; flex-direction:column; align-items:flex-start; gap:2px; padding:7px 10px; background:var(--bg-elev-1); border:1px solid var(--line); border-radius:6px; cursor:pointer; text-align:left; }
    #sku-root .sku-tok:hover { border-color:var(--accent); }
    #sku-root .sku-tok code { font-size:12px; color:var(--text-1); font-weight:700; }
    #sku-root .sku-tok span { font-size:11px; color:var(--text-3); }
    #sku-root .sku-eg { font-size:12px; color:var(--text-2); padding-top:10px; border-top:1px solid var(--line); }
    #sku-root .sku-eg code { background:var(--bg-elev-1); padding:2px 6px; border-radius:4px; }
    #sku-root .sku-arrow { color:var(--text-3); margin:0 6px; }
    #sku-root .sku-sep { color:var(--text-3); margin:0 8px; }

    #sku-root .sku-rule { display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:11px 12px; background:var(--bg-elev-1); border:1px solid var(--line); border-radius:6px; margin-bottom:6px; }
    #sku-root .sku-rule.is-default { border-style:dashed; }
    #sku-root .sku-rule-main { flex:1 1 200px; min-width:0; }
    #sku-root .sku-rule-what { font-size:14px; color:var(--text-1); font-weight:600; display:flex; align-items:center; gap:8px; }
    #sku-root .sku-code { font-size:11px; font-weight:700; letter-spacing:.04em; padding:1px 7px; border-radius:99px; background:var(--accent); color:var(--accent-ink); }
    #sku-root .sku-rule-scope { font-size:11px; color:var(--text-3); margin-top:2px; }
    #sku-root .sku-rule-fmt { flex:0 1 220px; }
    #sku-root .sku-rule-fmt code { font-size:12px; color:var(--text-2); }
    #sku-root .sku-rule-next { font-size:11px; color:var(--text-3); margin-top:3px; }
    #sku-root .sku-rule-next b { color:var(--text-1); font-size:12px; }
    #sku-root .sku-rule-act { display:flex; gap:6px; margin-left:auto; }
    #sku-root .btn-sm { padding:4px 10px; font-size:12px; }
    #sku-root .sku-danger:hover { color:var(--danger); border-color:var(--danger); }
    #sku-root .sku-empty { font-size:13px; color:var(--text-3); padding:14px 2px; }

    #sku-root .sku-form { margin-top:14px; padding:14px; border:1px solid var(--accent); border-radius:8px; background:var(--bg-elev-1); }
    #sku-root .sku-form-h { font-size:13px; font-weight:700; color:var(--text-1); margin-bottom:12px; }
    #sku-root .sku-form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:12px; }
    #sku-root .sku-form label, #sku-root .sku-wide { display:block; }
    #sku-root .sku-form label > span { display:block; font-size:12px; color:var(--text-2); margin-bottom:4px; }
    #sku-root .sku-form label > em { display:block; font-size:11px; color:var(--text-3); font-style:normal; margin-top:4px; line-height:1.5; }
    #sku-root .sku-form input, #sku-root .sku-form select { width:100%; }
    #sku-root .sku-wide input { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.02em; }
    #sku-root .sku-live { min-height:22px; margin:10px 0 14px; font-size:13px; }
    #sku-root .sku-samples b { font-size:14px; color:var(--text-1); margin:0 2px; }
    #sku-root .sku-bad { color:var(--danger); font-size:12px; line-height:1.6; }
    #sku-root .sku-warn { margin-top:6px; font-size:11px; color:var(--text-3); line-height:1.5; }
    #sku-root .sku-form-act { display:flex; gap:8px; }
  </style>`;
})();
