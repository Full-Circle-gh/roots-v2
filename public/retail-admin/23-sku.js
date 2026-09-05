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

   NO FORMULAS ON THIS SCREEN (Ash, 2026-09-04: "those kind of formula make it
   look very complicated for a regular user"). The engine underneath still runs
   a token template — that is what lets any tenant's scheme fit — but an
   operator sees four ordinary controls: the letters a code starts with, how
   many digits, a separator, and whether to include the year. The screen sends
   those four fields; lib/sku-format.js's fromSimple() composes the pattern
   server-side, and toSimple() reads one back so an existing rule opens in the
   same controls that made it. A pattern too rich for them (a name fragment, a
   month, a token mid-word) reads back as null — that rule says "Custom format"
   and opens in the Advanced field, which is the ONE place braces appear.

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

  // The token palette — Advanced only, and the one place in this screen where a
  // brace is shown at all. Built from the server's catalogue (lib/sku-format.js
  // TOKENS), so a token added to the engine appears here without this file
  // being touched, and one that is removed cannot be advertised any more.
  function tokenPalette() {
    const toks = _data.tokens || [];
    return `
      <div class="sku-toks">
        ${toks.map(t => `
          <button type="button" class="sku-tok" onclick="skuInsert('${esc(t.insert)}')" title="${esc(T(t.hint_en, t.hint_cn))}">
            <code>${esc(t.insert)}</code>
            <span>${esc(T(t.label_en, t.label_cn))}</span>
          </button>`).join('')}
      </div>`;
  }

  // ── plain wording for a stored rule ───────────────────────────────────────
  // A rule row must never show its pattern. `simple` is the server's reading of
  // it (lib/sku-format.js toSimple); null means the pattern is richer than the
  // four controls, and that rule is honestly labelled rather than mis-described.
  const DIGIT_LABEL = n => (n > 0
    ? T(`${n}-digit number`, `${n} 位数字`)
    : T('a number', '数字'));

  function summaryOf(r) {
    if (!r.simple) return T('Custom format', '自定义格式');
    const bits = [];
    if (r.simple.text) bits.push('“' + r.simple.text + '”');
    if (r.simple.useCode && r.code) bits.push(r.code);
    if (r.simple.year) bits.push(T('the year', '年份'));
    bits.push(DIGIT_LABEL(r.simple.digits));
    return bits.join(' + ');
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
          <div class="sku-rule-eg">
            ${esc(T('next', '下一个'))}: <b>${esc(previewOf(r))}</b>
          </div>
          <div class="sku-rule-next">
            ${esc(summaryOf(r))}
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
  // A new rule starts on the plain controls with the shape almost everybody
  // wants — a letter and four digits — so the common case is two fields and a
  // Save. `simple` carries the four controls; `pattern` is only read in
  // Advanced mode.
  window.skuAdd = function () {
    const kinds = (_data.levels && _data.levels.kinds) || [];
    _draft = {
      id: null, category: kinds[0] || 'food', subcategory: '', code: '',
      simple: { digits: 4, sep: '', year: 0 },
      pattern: '{SUB}{SEQ:4}', advanced: false,
    };
    paintDraft(true);
  };

  // Editing opens in whichever mode the stored rule can be shown in. A pattern
  // the four controls cannot describe (r.simple === null) opens in Advanced
  // rather than being silently flattened into something they CAN describe —
  // that would rewrite a scheme its author chose deliberately.
  window.skuEdit = function (id) {
    const r = (_data.rules || []).find(x => x.id === id);
    if (!r) return;
    _draft = {
      id: r.id, category: r.category, subcategory: r.subcategory, code: r.code,
      simple: r.simple ? { digits: r.simple.digits, sep: r.simple.sep, year: r.simple.year } : { digits: 4, sep: '', year: 0 },
      pattern: r.pattern,
      advanced: !r.simple,
      locked: r.scope === 'default',
    };
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

    const sim = d.simple || {};
    const digitOpts = [3, 4, 5, 6].map(n =>
      `<option value="${n}"${Number(sim.digits) === n ? ' selected' : ''}>${esc(T(`${n} digits`, `${n} 位`))} · ${'0'.repeat(n - 1)}1</option>`).join('');
    // Shown by what they LOOK like, not by their names — "Dash" means nothing
    // next to a code, whereas B-0001 is the decision itself.
    const sepOpts = [
      ['',  T('None', '无'),     'B0001'],
      ['-', T('Dash', '连字符'),  'B-0001'],
      ['.', T('Dot', '点'),      'B.0001'],
      ['/', T('Slash', '斜杠'),   'B/0001'],
    ].map(([v, label, eg]) =>
      `<option value="${esc(v)}"${(sim.sep || '') === v ? ' selected' : ''}>${esc(label)} · ${esc(eg)}</option>`).join('');

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
        </div>`}

        ${d.advanced ? `
        <label class="sku-wide">
          <span>${esc(T('Format', '格式'))}</span>
          <input id="sku-d-pattern" maxlength="60" value="${esc(d.pattern || '')}"
                 spellcheck="false" oninput="skuDraftField('pattern', this.value)">
          <em>${esc(T('Drop in a piece wherever the value changes. Everything else appears exactly as typed.',
                      '在需要变化的位置插入组件,其余字符原样出现。'))}</em>
        </label>
        ${tokenPalette()}
        <label class="sku-wide" style="max-width:220px">
          <span>${esc(T('Codes start with', '编码开头'))}</span>
          <input id="sku-d-code" maxlength="8" value="${esc(d.code || '')}" placeholder="B"
                 oninput="skuDraftField('code', this.value)">
        </label>` : `
        <div class="sku-form-grid">
          <label>
            <span>${esc(T('Codes start with', '编码开头'))}</span>
            <input id="sku-d-code" maxlength="8" value="${esc(d.code || '')}"
                   placeholder="B" oninput="skuDraftField('code', this.value)">
            <em>${esc(T('A letter or two of your choosing. Leave it blank for numbers only.',
                        '由您自定的一到两个字母。留空则只用数字。'))}</em>
          </label>
          <label>
            <span>${esc(T('Followed by', '后接'))}</span>
            <select id="sku-d-digits" onchange="skuSimpleField('digits', this.value)">${digitOpts}</select>
            <em>${esc(T('The number counts up on its own, one series per rule.',
                        '序号自动递增,每条规则各自计数。'))}</em>
          </label>
          <label>
            <span>${esc(T('Separator', '分隔符'))}</span>
            <select id="sku-d-sep" onchange="skuSimpleField('sep', this.value)">${sepOpts}</select>
          </label>
        </div>
        <label class="sku-check">
          <input type="checkbox" id="sku-d-year" ${sim.year ? 'checked' : ''} onchange="skuSimpleField('year', this.checked ? 2 : 0)">
          <span>${esc(T('Include the year', '包含年份'))}</span>
        </label>`}

        <div class="sku-live" id="sku-live"></div>
        <div class="sku-form-act">
          <button class="btn btn-primary" onclick="skuSaveDraft()">${esc(T('Save rule', '保存规则'))}</button>
          <button class="btn" onclick="skuCancel()">${esc(T('Cancel', '取消'))}</button>
          ${/* The escape hatch, and the ONLY door to a formula. Deliberately a
                plain text button at the end of the row rather than a control
                with any visual weight — an operator who does not need it should
                not have to decide whether they do. */''}
          <button class="btn sku-adv" onclick="skuToggleAdvanced()">${esc(d.advanced
            ? T('← Back to the simple form', '← 返回简易设置')
            : T('Write the format myself', '自定义格式'))}</button>
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

  // One of the four plain controls. `digits` and `year` arrive from a <select>
  // and a checkbox, so both are coerced here rather than trusted as typed.
  window.skuSimpleField = function (k, v) {
    if (!_draft.simple) _draft.simple = { digits: 4, sep: '', year: 0 };
    _draft.simple[k] = (k === 'sep') ? String(v) : Number(v);
    paintLive();
  };

  // Between the four controls and the raw format field. Going INTO Advanced
  // carries the simple settings across as a starting pattern, so nothing is
  // lost; coming back out reads the pattern in the same way the server does,
  // and refuses when it cannot — silently flattening a custom format into the
  // nearest simple one would rewrite a scheme somebody chose.
  window.skuToggleAdvanced = function () {
    if (!_draft) return;
    if (!_draft.advanced) {
      _draft.pattern = composePattern(_draft);
      _draft.advanced = true;
      paintDraft();
      return;
    }
    const back = readPattern(_draft.pattern, scopeOf(_draft));
    if (!back) {
      toast(T('This format uses pieces the simple form cannot show. Clear it first to go back.',
              '此格式包含简易设置无法显示的组件,请先清除后再返回。'));
      return;
    }
    _draft.simple = { digits: back.digits, sep: back.sep, year: back.year };
    _draft.advanced = false;
    paintDraft();
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

  function scopeOf(d) { return d.locked ? 'default' : (d.subcategory ? 'subcategory' : 'category'); }
  function codeToken(scope) { return scope === 'subcategory' ? '{SUB}' : '{CAT}'; }

  // Browser-side twins of lib/sku-format.js's fromSimple / toSimple, used ONLY
  // to move between the two modes and to preview. The server composes the
  // pattern it actually stores from the same four fields, so a drift here can
  // show a wrong sample but never store a wrong rule.
  function composePattern(d) {
    const sim = d.simple || {};
    const head = d.code ? codeToken(scopeOf(d)) : '';
    const year = Number(sim.year) === 4 ? '{YYYY}' : Number(sim.year) === 2 ? '{YY}' : '';
    const digits = Number(sim.digits === undefined ? 4 : sim.digits);
    return [head, year, '{SEQ:' + digits + '}'].filter(x => x !== '').join(sim.sep || '');
  }

  // The strict subset the four controls can describe: an optional code token,
  // an optional year, then the number, joined by one repeated separator.
  function readPattern(pattern, scope) {
    const m = String(pattern || '').match(
      new RegExp('^(' + codeToken(scope).replace(/[{}]/g, '\\$&') + ')?([-._/]?)(\\{YYYY\\}|\\{YY\\})?([-._/]?)\\{SEQ:(\\d)\\}$'));
    if (!m) return null;
    const seps = [m[2], m[4]].filter(Boolean);
    if (seps.length && seps.some(x => x !== seps[0])) return null;
    return {
      digits: Number(m[5]),
      sep: seps[0] || '',
      year: m[3] === '{YYYY}' ? 4 : m[3] === '{YY}' ? 2 : 0,
    };
  }

  // Three consecutive codes this rule would produce. In the simple form there
  // is no format to be wrong, so this is the whole feedback surface — it is
  // what the operator reads instead of a pattern.
  function paintLive() {
    const box = document.getElementById('sku-live');
    if (!box || !_draft) return;
    const d = _draft;
    const pattern = d.advanced ? (d.pattern || '') : composePattern(d);

    const problems = [];
    if (d.advanced) {
      const known = (_data.tokens || []).map(t => t.name);
      const unknown = (pattern.match(/\{[^}]*\}/g) || [])
        .filter(b => !known.some(n => new RegExp('^\\{' + n + '(:\\d)?\\}$').test(b)));
      if (!pattern.trim()) problems.push(T('A format is required.', '必须填写格式。'));
      if (unknown.length) problems.push(T(`${unknown.join(', ')} is not one of the pieces above.`, `${unknown.join('、')} 不是上方可用的组件。`));
      if (/[^A-Za-z0-9._/{}:-]/.test(pattern)) {
        problems.push(T('A code may only contain letters, digits and . _ / - — remove any spaces.',
                        '编码只能包含字母、数字与 . _ / -,请删除空格。'));
      }
    } else if (/[^A-Za-z0-9._/-]/.test(d.code || '')) {
      problems.push(T('A code may only contain letters, digits and . _ / - — remove any spaces.',
                      '编码只能包含字母、数字与 . _ / -,请删除空格。'));
    }

    if (problems.length) {
      box.innerHTML = `<div class="sku-bad">${problems.map(p => esc(p)).join('<br>')}</div>`;
      return;
    }

    const samples = [1, 2, 3].map(seq => renderPattern(pattern, {
      seq,
      categoryCode: d.subcategory ? catCodeFor(d.category) : d.code,
      subcategoryCode: d.subcategory ? d.code : '',
      name: 'Dried Mango',
    }));
    const hasSeq = /\{SEQ(:\d)?\}/.test(pattern);

    box.innerHTML = `
      <div class="sku-samples">
        <span class="muted">${esc(T('Codes will look like', '编码效果'))}</span>
        ${samples.map(x => `<b>${esc(x)}</b>`).join('<span class="sku-arrow">·</span>')}
      </div>
      ${hasSeq ? '' : `<div class="sku-warn">${esc(T(
        'Without a number, every material here would get the same code — the system will add one to keep them apart.',
        '缺少序号时,此范围内的物料编码将完全相同,系统会自动追加数字加以区分。'))}</div>`}`;
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
        // The simple form sends its four FIELDS and lets lib/sku-format.js
        // compose the pattern; Advanced sends the pattern it was given. One
        // stored form either way — see lib/sku-rules.js saveRule.
        body: d.advanced
          ? {
            category: d.locked ? '' : (d.category || ''),
            subcategory: d.locked ? '' : (d.subcategory || ''),
            code: d.code || '',
            pattern: d.pattern || '',
          }
          : {
            category: d.locked ? '' : (d.category || ''),
            subcategory: d.locked ? '' : (d.subcategory || ''),
            code: d.code || '',
            simple: {
              text: '',
              useCode: !!d.code,
              year: Number((d.simple || {}).year) || 0,
              sep: (d.simple || {}).sep || '',
              digits: Number((d.simple || {}).digits === undefined ? 4 : d.simple.digits),
            },
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
    // The shared dialog, not the browser's. This was the last native confirm()
    // in the admin — audit C-01 replaced five of them and this one, in a file
    // added afterwards, was missed. `danger` because it removes a rule, and the
    // body carries the consequence rather than repeating the question.
    const ok = await askConfirm({
      titleEn: `Remove the rule for ${where}?`,
      titleCn: `删除 ${where} 的编码规则？`,
      bodyEn: 'Materials already coded keep their SKUs. New ones will be numbered by the rule above it instead.',
      bodyCn: '已有物料的编码保持不变，新物料将改用上一层规则编号。',
      confirmEn: 'Remove', confirmCn: '删除',
      danger: true,
    });
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
    #sku-root .sku-samples { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
    #sku-root .sku-samples b { font-size:15px; color:var(--text-1); font-variant-numeric:tabular-nums; }
    #sku-root .sku-bad { color:var(--danger); font-size:12px; line-height:1.6; }
    #sku-root .sku-warn { margin-top:6px; font-size:11px; color:var(--text-3); line-height:1.5; }
    #sku-root .sku-form-act { display:flex; gap:8px; align-items:center; }
    #sku-root .sku-check { display:flex; align-items:center; gap:9px; font-size:13px; color:var(--text-1); margin-top:14px; cursor:pointer; }
    #sku-root .sku-check input { width:16px; height:16px; cursor:pointer; }
    /* The escape hatch to a raw format. No border, no fill, pushed to the end:
       an operator who does not need it should not have to decide whether they do. */
    #sku-root .sku-adv { margin-left:auto; border-color:transparent; background:transparent; color:var(--text-3); font-size:12px; }
    #sku-root .sku-adv:hover { color:var(--text-1); }
    #sku-root .sku-rule-eg { font-size:12px; color:var(--text-3); }
    #sku-root .sku-rule-eg b { font-size:14px; color:var(--text-1); font-weight:600; }
  </style>`;
})();
