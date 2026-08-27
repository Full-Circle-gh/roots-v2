/* eslint-disable no-undef */
/* retail-admin app JS — part 21.  Product build list (Cost & price tab),
   Step 3 of docs/tacet-product-build-lines-design.md, 2026-08-27.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   escapeHtml, cuT, money) live in 01-core.js; the product editor's own
   helpers (pdRenderMargin, _paMargin, PD_ICON_WARN) live in 09-products.js,
   which MUST load before this file.

   WHAT THIS SCREEN IS (Option 2 of the three Claude Design put up, chosen
   by Ash 2026-08-27): ONE tab carrying the build list, the price field and
   the margin. Not a build-list tab beside a cost tab — §31's addendum makes
   a build line the product's only cost source, and a second screen showing
   a number this one produced is a second screen that can DISAGREE with it.
   That is the exact failure docs/packaging-findings.md found four times over
   in the recipe cost formula. One screen removes the possibility rather
   than the duplication.

   ── LANGUAGE (Ash's decision, 2026-08-27) ──────────────────────────────
   Seven labels here are COPIED from live markup, never retyped from memory:
     物料 (glossary-locked, and what the recipe picker already says)
     包装 (18-materials.js:35, KIND_LABEL.packaging)
     成本 (18-materials.js:250)   价格 (retail-admin.html:4458)
     毛利 (09-products.js:1134)   数量 (19-recipes.js:555)
     单位 (19-recipes.js:1157)
   FOUR strings have NO sourced Chinese and therefore SHIP ENGLISH-ONLY:
   the tab/feature name, the card title, the empty-state sentence, and the
   picker's match-count line. They are marked `CN PENDING` at each site and
   pass the English string to BOTH halves of cuT() deliberately. Do not
   "finish" them — 物料清单 and every other candidate is unsourced, and this
   screen is admin-facing so English costs a tenant nothing in the interim.
   A Chinese-reading Roots user confirms the terms before they land.

   ── WHAT THIS FILE MAY NOT DO ─────────────────────────────────────────
   It never writes store_products.unit_cost. The save posts build lines and
   the server's own recompute (lib/recipe-rollup.js, via
   routes/retail-product-build.js) writes the cost — the same discipline the
   recipe-link route holds. A screen that wrote the figure itself would be a
   third writer on a column §31 says has one.
*/

(function () {
  'use strict';

  // Currency, defined here the same way 18-materials.js:27 and
  // 19-recipes.js:59 each define it — a file-local const over the shared
  // fmt(), not a global. Kept identical so a figure cannot read differently
  // depending on which screen printed it.
  const money = n => '¥' + (typeof fmt === 'function' ? fmt(Number(n) || 0) : (Number(n) || 0).toFixed(2));

  // The build list as the operator is editing it. Null until a product is
  // opened — NOT [], which would read as "opened, and genuinely empty" and
  // paint the empty state over a product whose lines have not loaded yet.
  let _blLines = null;
  let _blProductId = null;
  let _blCost = null;         // last server-computed cost block
  let _blDirty = false;
  let _blPickTimer = null;
  let _blPickResults = [];
  let _blSaving = false;
  // Margin BEFORE the most recently added line, so the rail can say what
  // that line cost in points. Null when nothing has been added this visit.
  let _blMarginBefore = null;

  // ── Language ────────────────────────────────────────────────────────
  // CN PENDING — no sourced Chinese exists for these four. English on both
  // halves is deliberate (see the header). Do not translate.
  // The card title and the pane heading live in retail-admin.html, not here.
  // They are English-only (CN PENDING), so they never change with the language
  // toggle and need no cuT() call — a string that is identical in both halves
  // is static markup, and routing it through the translator would only invite
  // someone to "fill in" the Chinese later without reading why it is absent.
  const T_EMPTY_LINE1 = () => cuT('Nothing in the list yet', 'Nothing in the list yet');
  const T_EMPTY_LINE2 = () => cuT(
    'Add what one sellable unit is made of — the contents, the bag it goes in, the label on it. The cost adds itself up as you go.',
    'Add what one sellable unit is made of — the contents, the bag it goes in, the label on it. The cost adds itself up as you go.');
  const T_PICK_COUNT  = (n, total) => cuT(
    n + ' of ' + total + ' match',
    n + ' of ' + total + ' match');

  // Sourced — copied from the files named in the header.
  const T_MATERIALS = () => cuT('Materials', '物料');
  const T_PACKAGING = () => cuT('Packaging', '包装');
  const T_COST      = () => cuT('Cost', '成本');
  const T_PRICE     = () => cuT('Price', '价格');
  const T_MARGIN    = () => cuT('Margin', '毛利');
  const T_QTY       = () => cuT('qty', '数量');
  const T_UNIT      = () => cuT('Unit', '单位');

  // ── Grouping ────────────────────────────────────────────────────────
  // DISPLAY ONLY. Every line is the same line; the group it paints under is
  // read from the MATERIAL's own item_kind, never stored on the build line.
  // Two row kinds would be two mechanisms, and the second one would drift —
  // which is the whole reason product_build_lines has no kind column
  // (design doc §1). A line whose material was deleted has no kind to read
  // and falls to Materials, where its "material deleted" flag is legible.
  function blGroupOf(line) {
    return (line.material_item_kind === 'packaging') ? 'packaging' : 'materials';
  }

  // What one line costs, or null when it cannot be known. Mirrors
  // lib/product-build-cost.js's own rule EXACTLY: free_by_design is a real
  // zero, an absent cost is null and never 0, and a null line blocks the
  // whole list rather than being quietly dropped from the sum.
  function blLineCost(line) {
    if (line.material_free_by_design) return 0;
    const cpu = Number(line.material_cost_per_unit) || 0;
    if (!(cpu > 0)) return null;
    const qty = Number(line.qty) || 0;
    return qty * cpu;
  }

  // The whole list's cost, computed client-side for LIVE feedback while
  // typing. The server recomputes on save and its figure is the one stored —
  // this never writes anything, it only paints. Returns null when any line
  // is unpriced, which is the blocked state the rail must show honestly.
  function blTotals() {
    const out = { materials: 0, packaging: 0, total: 0, blocked: false, blockedNames: [], blockedWithBuyPrice: 0 };
    for (const l of (_blLines || [])) {
      const c = blLineCost(l);
      if (c === null) {
        out.blocked = true;
        out.blockedNames.push(l.name_en || l.name_cn || '');
        // A blocked line that HAS a purchase price is a different errand from
        // one nobody has priced at all: the first needs its unit cost derived,
        // the second needs somebody to find out what it costs. The note says
        // which, so the operator knows where to go.
        if (Number(l.material_buy_price) > 0) out.blockedWithBuyPrice++;
        continue;
      }
      out[blGroupOf(l) === 'packaging' ? 'packaging' : 'materials'] += c;
      out.total += c;
    }
    return out;
  }

  // ── Load ────────────────────────────────────────────────────────────
  window.blLoad = async function (productId) {
    _blProductId = productId;
    _blLines = null;
    _blCost = null;
    _blDirty = false;
    _blMarginBefore = null;
    _blPickResults = [];
    blRender();
    if (!productId) { _blLines = []; blRender(); return; }
    try {
      const j = await api('/api/retail-admin/products/' + productId + '/build-lines');
      const d = (j && j.data) || {};
      _blLines = Array.isArray(d.lines) ? d.lines : [];
      _blCost = d.cost || null;
    } catch (e) {
      _blLines = [];
      _blCost = null;
    }
    blRender();
  };

  // ── Render ──────────────────────────────────────────────────────────
  function blRender() {
    const host = document.getElementById('pd-bl-list');
    if (!host) return;

    // Loading — a skeleton, never a spinner (§1.12). Only on a real load.
    if (_blLines === null) {
      host.innerHTML = '<div class="bl-skel"></div><div class="bl-skel"></div>';
      blRenderRail();
      return;
    }

    if (!_blLines.length) {
      // EMPTY, not no-results. 171 of 208 products open exactly here, so
      // this state does the teaching: it says what a build list is, and it
      // puts the picker directly under the sentence explaining it rather
      // than behind another click. A compliment in shape, never an apology.
      host.innerHTML =
        '<div class="bl-empty">'
        + '<svg class="bl-empty-wave" width="120" height="20" viewBox="0 0 120 20" fill="none" '
        + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">'
        + '<path d="M2 10h116"/></svg>'
        + '<div class="bl-empty-h">' + escapeHtml(T_EMPTY_LINE1()) + '</div>'
        + '<p class="bl-empty-p">' + escapeHtml(T_EMPTY_LINE2()) + '</p>'
        + '</div>';
      blRenderRail();
      return;
    }

    const groups = [
      { key: 'materials', label: T_MATERIALS() },
      { key: 'packaging', label: T_PACKAGING() },
    ];
    let html = '';
    for (const g of groups) {
      const rows = _blLines
        .map((l, i) => ({ l: l, i: i }))
        .filter(x => blGroupOf(x.l) === g.key);
      if (!rows.length) continue;

      let sub = 0;
      let subBlocked = false;
      for (const x of rows) {
        const c = blLineCost(x.l);
        if (c === null) subBlocked = true; else sub += c;
      }

      html += '<div class="bl-group">'
        + '<div class="bl-group-h">'
        + '<span>' + escapeHtml(g.label) + '</span>'
        + '<span class="bl-group-n">'
        + (subBlocked ? '—' : money(sub))
        + '</span></div>'
        + rows.map(x => blRowHtml(x.l, x.i)).join('')
        + '</div>';
    }
    host.innerHTML = html;
    blRenderRail();
  }

  function blRowHtml(l, idx) {
    const cost = blLineCost(l);
    const deleted = l.ingredient_id == null || !l.material_is_active;
    const free = !!l.material_free_by_design;
    // The per-unit note under the name. "no cost" is the recipe screen's own
    // wording for the same fact (19-recipes.js:547) — one vocabulary.
    let per;
    if (free) per = cuT('free', '免费');
    else if (Number(l.material_cost_per_unit) > 0)
      per = money(l.material_cost_per_unit) + '/' + escapeHtml(l.material_unit || l.unit || '');
    else if (Number(l.material_buy_price) > 0) {
      // A REAL PURCHASE PRICE WITH NO DERIVED UNIT COST. Costing still blocks
      // — cost_per_unit is the only figure this list may use — but "no cost"
      // is the wrong thing to say about a material somebody has bought and
      // priced, and it sent Ash to the Materials screen to check whether the
      // build list was broken. Naming the price says which of the two states
      // this is, and where the fix is. CN PENDING: no sourced Chinese for
      // this sentence, so English on both halves.
      const m = 'no unit cost — ' + money(l.material_buy_price) + ' recorded on the material';
      per = cuT(m, m);
    }
    else per = cuT('no cost', '无成本');

    const sub = escapeHtml(l.name_cn || '') + (l.name_cn ? ' · ' : '') + per
      + (deleted ? ' · ' + escapeHtml(cuT('material deleted', '物料已删除')) : '');

    return '<div class="bl-row' + (cost === null ? ' is-nocost' : '') + '">'
      + '<div class="bl-name">'
      + '<div class="n">' + escapeHtml(l.name_en || l.name_cn || '') + '</div>'
      + '<div class="s' + (cost === null ? ' warn' : '') + '">' + sub + '</div>'
      + '</div>'
      + '<input class="bl-in" type="number" min="0" step="any" value="' + escapeAttr(String(l.qty))
      + '" aria-label="' + escapeAttr(T_QTY()) + '" placeholder="' + escapeAttr(T_QTY()) + '"'
      + ' oninput="blField(' + idx + ',\'qty\',this.value)">'
      + '<select class="bl-unit" aria-label="' + escapeAttr(T_UNIT()) + '"'
      + ' onchange="blField(' + idx + ',\'unit\',this.value)">'
      + BL_UNITS.map(u => '<option value="' + escapeAttr(u) + '"'
        + (l.unit === u ? ' selected' : '') + '>' + escapeHtml(u) + '</option>').join('')
      + '</select>'
      + '<span class="bl-cost">' + (cost === null ? '—' : money(cost)) + '</span>'
      + '<button type="button" class="bl-x" title="' + escapeAttr(cuT('Remove', '移除')) + '"'
      + ' aria-label="' + escapeAttr(cuT('Remove', '移除')) + '"'
      + ' onclick="blRemove(' + idx + ')">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      + '</button>'
      + '</div>';
  }

  // Same six the recipe unit dropdown offers, for the same reason: these are
  // the units lib/ingredient-cost.js can actually derive a cost for. A unit
  // outside this list has no defensible divisor (its own §7-addendum rule).
  const BL_UNITS = ['g', 'ml', 'pcs', 'bag', 'bottle', 'box'];

  // ── The rail — price, cost, margin ──────────────────────────────────
  function blRenderRail() {
    const host = document.getElementById('pd-bl-nums');
    if (!host) return;
    const t = blTotals();
    const priceEl = document.getElementById('pd-price');
    const price = priceEl ? parseFloat(priceEl.value) : NaN;

    let rows = '';
    if (_blLines && _blLines.length) {
      rows += blRailRow(T_MATERIALS(), money(t.materials));
      if (_blLines.some(l => blGroupOf(l) === 'packaging')) {
        rows += blRailRow(T_PACKAGING(), money(t.packaging));
      }
      rows += '<div class="bl-rule"></div>';
    }

    // Cost. BLOCKED SHOWS AN EM DASH AND NAMES THE LINE — never a partial
    // sum. lib/product-build-cost.js refuses to publish one and so does
    // this: a total missing a line is not a smaller total, it is a figure
    // nobody can act on, and it reads as plausible, which is worse.
    rows += blRailRow(T_COST(), (!_blLines || !_blLines.length) ? '—'
      : (t.blocked ? '<span class="bl-warnv">—</span>' : money(t.total)), true);
    rows += blRailRow(T_PRICE(), price > 0 ? money(price) : '—', true);
    rows += '<div class="bl-rule"></div>';

    // Margin — the number this screen exists to move.
    let mv = '—';
    let mCls = '';
    let canMargin = _blLines && _blLines.length && !t.blocked && price > 0;
    if (canMargin) {
      const pct = ((price - t.total) / price) * 100;
      mv = pct.toFixed(1) + '%';
      mCls = pct < 0 ? ' is-neg' : '';
    }
    rows += '<div class="bl-big"><span class="k">' + escapeHtml(T_MARGIN()) + '</span>'
      + '<span class="v' + mCls + '">' + mv + '</span></div>';

    // What the last added line cost, in points. Only when both margins are
    // real — a delta against a blocked or absent figure is not a fact.
    if (canMargin && _blMarginBefore != null) {
      const now = ((price - t.total) / price) * 100;
      const d = _blMarginBefore - now;
      if (Math.abs(d) >= 0.05) {
        // CN PENDING — 个百分点 appears nowhere in live markup, so it would be
        // composed. English on both halves until it is confirmed.
        rows += '<div class="bl-delta' + (d > 0 ? ' down' : '') + '">'
          + (d > 0 ? '↓ ' : '↑ ') + Math.abs(d).toFixed(1) + ' '
          + escapeHtml(cuT('points', 'points')) + '</div>';
      }
    }

    // Why the margin is missing, said where the operator is looking. An
    // unpriced line names ITSELF — "one line has no cost" sends someone
    // hunting through the list for which.
    // CN PENDING throughout this block. Each sentence names the build list or
    // describes its blocked state, and neither has sourced Chinese — see the
    // file header. Composing them from sourced fragments (来自 + 物料, or a
    // reworded 缺少成本) would invent phrases no Chinese reader has approved,
    // which is the failure mode this rule exists for. English both halves.
    let note = '';
    if (!_blLines || !_blLines.length) {
      note = cuT('The build list is this product’s cost. Add a line to see a margin.',
                 'The build list is this product’s cost. Add a line to see a margin.');
    } else if (t.blocked) {
      const names = t.blockedNames.filter(Boolean);
      const first = names[0] || '';
      // "no unit cost", not "no cost" — see the same correction on the line
      // itself. Every one of these had a purchase price on the Materials
      // screen, so calling it costless was what made the screen look broken.
      let msg = names.length > 1
        ? names.length + ' lines have no unit cost, starting with “' + first + '”.'
        : '“' + first + '” has no unit cost.';
      msg += t.blockedWithBuyPrice > 0
        ? ' It was bought and priced, but the per-unit cost was never worked out — open the material and set it.'
        : ' One unpriced line and the total is a guess, so it is not shown.';
      note = cuT(msg, msg);
    } else if (!(price > 0)) {
      note = cuT('Set a price to see the margin.', 'Set a price to see the margin.');
    }
    const noteHtml = note ? '<div class="bl-note">' + escapeHtml(note) + '</div>' : '';

    // ── PACKAGING BUT NO CONTENTS ────────────────────────────────────────
    // A list that prices cleanly can still be obviously unfinished, and this
    // is the shape that hides it: box + label + sticker and nothing inside.
    // The arithmetic is right, so nothing else on this screen objects — the
    // cost simply comes out tiny and the margin enormous. Live example the
    // day this shipped: Hazelnut-Chocolate Spread costed ¥1.23 against an
    // ¥89 price and reported 98.6%, because its recipe was never
    // materialised and so had no material to add as contents.
    //
    // This WARNS and does not block. The figure is honest about what has
    // been recorded, and refusing to show it would be inventing a rule
    // nobody has approved — a product genuinely made only of packaging is
    // absurd, but "absurd" is a judgement about Roots, not a fact about
    // every tenant. Whether it should harden into a block is Ash's call.
    let warnHtml = '';
    if (_blLines && _blLines.length && !_blLines.some(l => blGroupOf(l) !== 'packaging')) {
      // CN PENDING — no sourced Chinese; English on both halves.
      const w = 'Every line here is packaging. Nothing is recorded as the contents, '
        + 'so this cost covers the container and not what goes in it.';
      warnHtml = '<div class="bl-note is-warn">' + escapeHtml(cuT(w, w)) + '</div>';
    }

    host.innerHTML = rows + noteHtml + warnHtml;
  }

  function blRailRow(k, v, raw) {
    return '<div class="bl-rrow"><span class="k">' + escapeHtml(k) + '</span>'
      + '<span class="v">' + (raw ? v : escapeHtml(v)) + '</span></div>';
  }

  // ── Editing ─────────────────────────────────────────────────────────
  window.blField = function (idx, key, val) {
    if (!_blLines || !_blLines[idx]) return;
    _blLines[idx][key] = key === 'qty' ? (val === '' ? 0 : Number(val)) : val;
    _blDirty = true;
    // Only the money moves. Repainting the whole list on every keystroke
    // would destroy the caret in the input being typed into — the same
    // failure the recipe line editor guards against (19-recipes.js).
    blRepaintCosts();
    blRenderRail();
    blMarkDirty();
  };

  // Repaint only the per-line cost cells and the group subtotals, leaving
  // every input node untouched.
  function blRepaintCosts() {
    const host = document.getElementById('pd-bl-list');
    if (!host || !_blLines) return;
    const cells = host.querySelectorAll('.bl-row');
    let n = 0;
    for (const g of ['materials', 'packaging']) {
      const rows = _blLines.map((l, i) => ({ l: l, i: i })).filter(x => blGroupOf(x.l) === g);
      for (const x of rows) {
        const cell = cells[n++];
        if (!cell) continue;
        const c = blLineCost(x.l);
        const out = cell.querySelector('.bl-cost');
        if (out) out.textContent = c === null ? '—' : money(c);
        cell.classList.toggle('is-nocost', c === null);
      }
    }
    // Group subtotals.
    const heads = host.querySelectorAll('.bl-group');
    let hi = 0;
    for (const g of ['materials', 'packaging']) {
      const rows = _blLines.filter(l => blGroupOf(l) === g);
      if (!rows.length) continue;
      const box = heads[hi++];
      if (!box) continue;
      let sub = 0, blocked = false;
      for (const l of rows) { const c = blLineCost(l); if (c === null) blocked = true; else sub += c; }
      const out = box.querySelector('.bl-group-n');
      if (out) out.textContent = blocked ? '—' : money(sub);
    }
  }

  window.blRemove = function (idx) {
    if (!_blLines || !_blLines[idx]) return;
    _blLines.splice(idx, 1);
    _blDirty = true;
    _blMarginBefore = null;
    blRender();
    blMarkDirty();
    blRefreshCostSource();
  };

  // ── The picker ──────────────────────────────────────────────────────
  // NOT for_recipe=1. That filter exists to keep packaging OUT of a recipe
  // (routes/retail-materials.js) because recipe_cost_data.packaging already
  // prices a jar from packaging_types. A BUILD list is the opposite case:
  // the jar belongs here, it is the only place it is ever counted, and §31
  // rule 4 puts it in `ingredients` with everything else. Passing
  // for_recipe=1 would hide every box and label this screen exists to add.
  window.blPickSearch = function (v) {
    clearTimeout(_blPickTimer);
    const q = (v || '').trim();
    if (!q) { _blPickResults = []; blRenderPick(0); return; }
    _blPickTimer = setTimeout(async () => {
      try {
        const j = await api('/api/retail-admin/materials?search=' + encodeURIComponent(q));
        const all = (j && j.data) || [];
        // Already-added materials drop out — adding the same jar twice is
        // never what was meant, and the line would silently double its cost.
        const chosen = new Set((_blLines || []).map(l => l.ingredient_id).filter(x => x != null));
        _blPickResults = all.filter(m => !chosen.has(m.id));
        blRenderPick(all.length);
      } catch (e) {
        _blPickResults = [];
        blRenderPick(0);
      }
    }, 220);
  };

  function blRenderPick(matchedTotal) {
    const host = document.getElementById('pd-bl-pick');
    if (!host) return;
    if (!_blPickResults.length) {
      // No results is NOT the empty state (§1.12) — there is plenty here,
      // this search matched none of it. Different sentence, and it names
      // what is filtering.
      const q = (document.getElementById('pd-bl-q') || {}).value || '';
      // CN PENDING — no sourced Chinese for a "nothing matched your search"
      // sentence naming the term. English both halves.
      const m = 'No materials match “' + q.trim() + '”';
      host.innerHTML = q.trim()
        ? '<div class="bl-pick"><div class="bl-pick-none">' + escapeHtml(cuT(m, m)) + '</div></div>'
        : '';
      return;
    }
    const shown = _blPickResults.slice(0, 8);
    host.innerHTML = '<div class="bl-pick">'
      // CN PENDING — the match-count line has no sourced Chinese, so it
      // ships English on both halves. See the file header.
      + '<div class="bl-pick-hint">' + escapeHtml(T_PICK_COUNT(shown.length, matchedTotal)) + '</div>'
      + shown.map(m => {
        const kind = (m.item_kind === 'packaging') ? 'k-pack' : 'k-food';
        const cost = m.free_by_design ? cuT('free', '免费')
          : (m.cost_per_unit > 0 ? money(m.cost_per_unit) + '/' + escapeHtml(m.unit || '')
            : cuT('no cost', '无成本'));
        return '<button type="button" class="bl-pick-item" onclick="blPickAdd(' + m.id + ')">'
          + '<span class="bl-pick-n"><span class="bl-kind ' + kind + '" aria-hidden="true"></span>'
          + escapeHtml(m.name_en || '')
          + (m.name_cn ? ' · ' + escapeHtml(m.name_cn) : '') + '</span>'
          + '<span class="s">' + cost + '</span></button>';
      }).join('')
      + '</div>';
  }

  window.blPickAdd = function (id) {
    const m = _blPickResults.find(x => x.id === id);
    if (!m || !_blLines) return;
    // Capture the margin BEFORE the line lands, so the rail can say what
    // this one cost. Only meaningful when the list was costable already.
    const t = blTotals();
    const priceEl = document.getElementById('pd-price');
    const price = priceEl ? parseFloat(priceEl.value) : NaN;
    _blMarginBefore = (!t.blocked && price > 0 && _blLines.length)
      ? ((price - t.total) / price) * 100 : null;

    _blLines.push({
      id: null,
      ingredient_id: m.id,
      name_en: m.name_en,
      name_cn: m.name_cn,
      sku: m.sku,
      // Zero, not one. A quantity is a fact about THIS product that only the
      // operator knows; defaulting to 1 would put a confident number on a
      // line nobody has measured, and the save refuses qty <= 0 anyway
      // (routes/retail-product-build.js), so the refusal is visible here
      // rather than at save time.
      qty: 0,
      unit: m.unit || 'g',
      notes: null,
      material_item_kind: m.item_kind || 'food',
      material_cost_per_unit: m.cost_per_unit,
      material_buy_price: m.buy_price,
      material_unit: m.unit,
      material_free_by_design: m.free_by_design,
      material_is_active: 1,
    });
    _blDirty = true;
    _blPickResults = [];
    const q = document.getElementById('pd-bl-q');
    if (q) q.value = '';
    blRenderPick(0);
    blRender();
    blMarkDirty();
    blRefreshCostSource();
    // Put the caret in the quantity of the line just added — it is the one
    // thing still missing, and hunting for it is the whole friction.
    setTimeout(() => {
      const host = document.getElementById('pd-bl-list');
      if (!host) return;
      const rows = host.querySelectorAll('.bl-row .bl-in');
      const last = rows[rows.length - 1];
      if (last) { last.focus(); last.select(); }
    }, 0);
  };

  // ── Save ────────────────────────────────────────────────────────────
  // Its own control, not folded into the product save. The build list has
  // its own route, its own validation and its own recompute; sharing the
  // product form's button would make one failure look like the other's.
  window.blSave = async function () {
    if (!_blProductId || !_blLines || _blSaving) return;
    const bad = _blLines.find(l => !(Number(l.qty) > 0));
    if (bad) {
      // CN PENDING — no sourced Chinese for this sentence; English both halves.
      const m = '“' + (bad.name_en || 'A line') + '” needs a quantity greater than zero.';
      toast(cuT(m, m), 'err');
      return;
    }
    // §1.12 in flight — the control that writes disables while it writes,
    // and says so. Captured synchronously; nothing is awaited before this.
    const btn = document.getElementById('pd-bl-save');
    _blSaving = true;
    const was = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = cuT('Saving…', '保存中…'); }
    try {
      const j = await api('/api/retail-admin/products/' + _blProductId + '/build-lines', {
        method: 'PUT',
        // The object, NOT a pre-stringified string — api() sets
        // Content-Type only when it does the stringifying itself
        // (01-core.js:70), and the route is behind express.json().
        body: {
          lines: _blLines.map(l => ({
            ingredient_id: l.ingredient_id,
            name_en: l.name_en, name_cn: l.name_cn, sku: l.sku,
            qty: Number(l.qty), unit: l.unit, notes: l.notes || null,
          })),
        },
      });
      _blDirty = false;
      _blMarginBefore = null;
      blMarkDirty();
      // 已保存 is sourced (94 live uses) and means "saved" on its own — it does
      // NOT name the build list, so pairing it with the English is honest
      // rather than composed. The English half carries the noun; the Chinese
      // half says only what it is licensed to say.
      toast(cuT('Build list saved', '已保存'));
      // Reload so the figures on screen are the SERVER's, not this file's
      // preview of them. They should agree; if they ever do not, the
      // operator sees the stored truth rather than a hopeful local sum.
      await blLoad(_blProductId);
      blRefreshCostSource();
      // The product row's cost/margin moved — repaint the list behind the
      // editor so it does not show a stale figure.
      if (typeof paLoad === 'function') { try { paLoad(); } catch (e) { /* list not open */ } }
      return j;
    } catch (e) {
      // A failed write renders where the operator is looking and STAYS —
      // never a toast that flies away leaving the screen looking saved.
      const host = document.getElementById('pd-bl-err');
      if (host) {
        // CN PENDING — names the build list; English both halves.
        const m = 'Could not save the build list. ' + ((e && e.message) || '');
        host.innerHTML = '<div class="bl-err">' + escapeHtml(cuT(m, m)) + '</div>';
        host.style.display = '';
      }
    } finally {
      _blSaving = false;
      if (btn) { btn.disabled = false; btn.textContent = was; }
    }
  };

  function blMarkDirty() {
    const b = document.getElementById('pd-bl-save');
    if (b) b.classList.toggle('is-dirty', !!_blDirty);
    const err = document.getElementById('pd-bl-err');
    if (err && _blDirty) { err.style.display = 'none'; err.innerHTML = ''; }
  }

  // WHETHER A BUILD LIST EXISTS IS ITSELF A COST-SOURCE FACT, so the manual
  // cost field has to be re-judged every time that changes — not only when a
  // product is opened.
  //
  // Without this the field kept whatever it decided at open. Add the first
  // line to a recipe-linked product and the rail said "Cost —" while the
  // field below it still said "46.05 · From recipe", on the same screen, at
  // the same moment — the two-surfaces-disagreeing failure this whole design
  // exists to remove, reproduced inside the one pane meant to end it.
  // Reported live on Hazelnut-Chocolate Spread, 2026-08-27.
  //
  // pdApplyCostSource() reads blHasLines() (09-products.js), so calling it is
  // enough — it re-derives readOnly and rewrites the note itself.
  function blRefreshCostSource() {
    if (typeof pdApplyCostSource !== 'function') return;
    // The row the editor is showing, resolved the way 09-products.js resolves
    // it everywhere else (:2810, :3093, :3148) — from PA_PRODUCTS by the
    // selected id. There is no PD_CURRENT; passing undefined instead would
    // make the recipe half of pdApplyCostSource read a product that is not
    // there and quietly drop the "From recipe" line for products that still
    // need it.
    let p = null;
    try {
      p = (typeof PA_PRODUCTS !== 'undefined' && PA_PRODUCTS ? PA_PRODUCTS : [])
        .find(x => x && x.id === _blProductId) || null;
    } catch (e) { p = null; }
    try { pdApplyCostSource(p); } catch (e) { /* editor not open */ }
  }

  // The price input lives in this pane now, so its keystrokes move the
  // margin here. 09-products.js's own listener still calls pdRenderMargin()
  // for the figure it paints elsewhere; both read the same two fields.
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.id === 'pd-price') blRenderRail();
  });

  // Does this product have a build list? The product editor asks before
  // deciding whether its own cost field is still editable — §31's addendum
  // says a build list owns the cost outright, so the manual field must not
  // offer to overwrite what this screen produced.
  window.blHasLines = function () { return !!(_blLines && _blLines.length); };
  window.blIsDirty = function () { return !!_blDirty; };
})();
