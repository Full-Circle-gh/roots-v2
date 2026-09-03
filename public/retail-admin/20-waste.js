/* eslint-disable no-undef */
/* retail-admin app JS — part 20.  Waste (损耗), 2026-08-27.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   fmt, escapeHtml, cuT, can, applyCapGates, goTab, askCustom, askConfirm,
   tdWhen) live in 01-core.js / tacet-dialogs.js / td-datetime.js.

   Waste is a STOCK MOVEMENT WITH A REASON (docs/tacet-consolidation-decisions.md
   §32 + its 2026-08-27 addendum). Recording one moves stock and the channels
   hear about it; voiding one writes a reversal that puts the stock back. This
   screen is the front of routes/retail-waste.js and nothing else — it holds no
   costing rules of its own, because §32 rule 9 makes the cost a snapshot the
   server takes once and never recomputes.

   ARCHETYPE: A1 Worklist (§2), with its thin-pulse render — one summary line
   rather than tiles, which is the same slot and the same component. Named here
   because Waste is not in the §4 table of 34 and §6 requires the archetype to
   be chosen deliberately rather than inherited. It is not a Report: a Report is
   range-scoped ANALYSIS that is read and not acted on, and this page's whole
   point is the two write actions on it.

   NO STATUS LINE, DELIBERATELY. §1.7's work rule: a status line reports work
   WAITING, never population. Nothing in a waste ledger is waiting on an
   operator — every row is already finished business. Customers is the reference
   case for a header that is correct with the title alone; this is another. The
   money figure that would otherwise be tempting to put there is the pulse
   line's job, one region down.

   PREFIX is wst-*. `wa-`/`was-` were free too; wst- was picked for the same
   reason mat- was picked over mt- — a short prefix that reads as an
   abbreviation of the section and collides with nothing.

   LANGUAGE. The root carries data-no-i18n and every string is baked by cuT()
   at paint time, repainted on language change. That is the house pattern
   (18-materials.js) and here it also sidesteps a live hazard: the DOM walker
   splits a text node on " · " when the left half is Chinese-free and the right
   half is Chinese (§1.11), and this page's pulse line is a run of label+number
   pairs joined by exactly that separator. Some of those labels have a Chinese
   source and some do not yet, so a half-translated line is precisely the shape
   the walker would tear in half. Baking + repainting means the walker never
   sees it.

   CHINESE IS COPIED WHERE A PRECEDENT EXISTS. Every 中文 string below was
   checked against the rest of the repo first, and most are verbatim reuses of a
   pair that already ships — the range endpoints, the no-results line, the
   pick-a-thing prompt, the in-flight and voided labels. Where no precedent
   existed the string was composed against the surrounding admin's register
   (Ash approved this on 2026-08-27, having first required the search); those
   are assembled from copied fragments — 损耗记录, 作废这条, 无法加载, 还没有登记 —
   rather than translated fresh. 冲销, on the reversal pill, is the one string
   with no fragment precedent at all.

   THE INTERPOLATION ORDER DIFFERS BY LANGUAGE and that is deliberate: the void
   dialog's body leads with the count in English and names the product first in
   Chinese, because forcing one order on both is how a translated string reads
   like a translation.

   The T(en, '') marker described below now has no live users. It stays
   documented because the NEXT string added here will need it. */

(function () {
  'use strict';

  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  // T(en, cn) — and T(en, '') is the AWAITING-TRANSLATION marker.
  //
  // cuT() returns its `cn` argument verbatim, with no fallback, so cuT(en, '')
  // renders an EMPTY LABEL on a Chinese screen. That is why this wrapper
  // exists: an unsourced string falls back to English in both languages, which
  // is a missing translation an operator can read and Ash can fix, rather than
  // a blank one nobody can see. Every T(en, '') below is a string with no
  // Chinese source in this repo; they are listed in the PR. Grep for `, '')` to
  // find them all.
  const T = (en, cn) => (cn && typeof cuT === 'function' ? cuT(en, cn) : en);
  const when = (v, name) => (typeof tdWhen === 'function' ? tdWhen(v, name) : String(v || ''));

  // Cents in, yuan out. The API stores a RESOLVED TOTAL in whole cents (§32
  // addendum point 3) and this is the only place that divides — a second
  // /100 somewhere else is how a figure ends up a hundred times wrong on one
  // screen and right on another.
  // …and the tenant's display currency prints it (01-core.js acMoney), not a
  // hardcoded ¥. The DIVISION stays here and stays /100 — the stored figure is
  // whole cents of the tenant's currency, which is a storage decision, not a
  // display one.
  const money = cents => (typeof acMoney === 'function'
    ? acMoney(Number(cents || 0) / 100)
    : '¥' + (Number(cents || 0) / 100).toFixed(2));

  // ── Who may read what a loss COST (Ash, 2026-09-02) ──────────────────────
  //
  // `waste:view` opens this screen; `waste:costs` reads the money on it. They
  // were one capability, so the warehouse and store_manager presets — whose
  // job is recording what spoiled — read the cost of every loss in the
  // business. This screen never had a money gate of any kind.
  //
  // FAILS CLOSED, unlike can(), which answers true on a null cap set so a
  // resolution hiccup never locks an operator out of their own app. Money
  // inverts that trade: a figure missing for one paint is recoverable and a
  // figure shown to somebody who may not read one is not.
  //
  // The server does not SEND a cost to a caller without the capability
  // (routes/retail-waste.js), so this decides layout — whether the column
  // exists — and the payload decides what is knowable. When they disagree the
  // payload wins, which is why every reader below also handles an absent
  // figure rather than trusting this to have hidden it.
  const showMoney = () => (typeof CAPS !== 'undefined' && CAPS !== null)
    ? CAPS.has('waste:costs')
    : false;

  // ── module state ──────────────────────────────────────────────────────────
  let _init = false;
  let _rows = [];
  let _totals = null;
  let _stores = [];
  let _reasons = [];
  let _loading = false;
  let _err = '';

  // Filters. Exactly the three the scope allows: date range, location, reason.
  let _from = '';
  let _to = '';
  let _loc = '';
  let _reason = '';

  const root = () => document.getElementById('wst-root');
  const reasonLabel = code => {
    const r = _reasons.find(x => x.code === code);
    return r ? T(r.en, r.cn) : (code || '');
  };
  const storeLabel = row => {
    const en = row.location_name_en || row.location_code || '';
    const cn = row.location_name_cn || row.location_code || '';
    return en || cn ? T(en || cn, cn || en) : T('Unknown', '未知');
  };
  const productLabel = row => {
    const en = row.product_name_en || '';
    const cn = row.product_name_cn || '';
    // A product deleted outright leaves a null name on the join. Say so rather
    // than rendering an empty cell — an empty cell reads as "nothing here",
    // and something was definitely here.
    if (!en && !cn) return T('Unknown', '未知');
    return T(en || cn, cn || en);
  };

  const I = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.wasteInit = async function () {
    if (_init) { load(); return; }
    _init = true;
    if (typeof onLangChange === 'function') onLangChange(() => paint());
    // Two pickers, read once. A failed picker fetch must not stop the ledger
    // from painting — the list is the page, the pickers are its furniture.
    try {
      const [s, r] = await Promise.all([
        api('/api/retail-admin/stores').catch(() => ({ data: [] })),
        api('/api/retail-admin/waste/reasons').catch(() => ({ data: [] })),
      ]);
      _stores = (s.data || []).filter(x => x.is_active !== 0);
      _reasons = r.data || [];
    } catch (e) { /* furniture is optional */ }
    load();
  };

  async function load() {
    _loading = true; _err = '';
    paint();
    const qs = new URLSearchParams();
    if (_from) qs.set('from', _from);
    if (_to) qs.set('to', _to);
    if (_loc) qs.set('location_id', _loc);
    if (_reason) qs.set('reason', _reason);
    // Voided rows STAY VISIBLE. A ledger that hides its own corrections is how
    // one goes unnoticed. The totals the server returns are the LIVE subset of
    // the same filter regardless — see the route's own comment.
    qs.set('include_voided', '1');
    try {
      const j = await api('/api/retail-admin/waste?' + qs.toString());
      _rows = j.data || [];
      _totals = j.totals || null;
    } catch (e) {
      _err = e && e.message ? e.message : String(e);
      _rows = []; _totals = null;
    }
    _loading = false;
    paint();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PAINT
  // ═══════════════════════════════════════════════════════════════════════════
  function paint() {
    const el = root();
    if (!el) return;
    el.innerHTML = header() + pulse() + filters() + body();
    wire();
    // The record CTA carries data-cap="waste:record", so re-running the gates
    // after every repaint is what keeps it hidden for a view-only operator.
    // Without this the button reappears on the first filter change.
    if (typeof applyCapGates === 'function') { try { applyCapGates(); } catch (e) {} }
  }

  // §1.7 — three elements and there is no fourth. Title, no status line (see
  // the file header), one Dusk CTA.
  function header() {
    return `
      <div class="wst-head">
        <h2 class="wst-title">${esc(T('Waste', '损耗'))}</h2>
        <button type="button" class="wst-btn primary" id="wst-new" data-cap="waste:record">
          <span class="wst-ic">${I.plus}</span>${esc(T('Record waste', '记录损耗'))}
        </button>
      </div>`;
  }

  // A1's thin pulse: one line, same slot tiles would occupy.
  //
  // Rendered as LABEL + FIGURE pairs rather than as a sentence, and that is a
  // language decision rather than a layout one: a sentence like "3 uncosted"
  // needs Chinese grammar nobody has supplied, while a label beside a number
  // needs only the noun — and the nouns have sources. Each pair is its own
  // element so no single text node ever holds " · " (§1.11's walker).
  function pulse() {
    if (!_totals) return '';
    const t = _totals;
    // The money pair is present or absent together. Without `waste:costs` the
    // server sends neither figure (cost_total_cents is not in the payload at
    // all), so the second condition is not belt-and-braces — it is what keeps
    // an absent total from printing as ¥0.00, which reads as "nothing was
    // lost" rather than "you are not being shown this".
    const figs = [];
    if (showMoney() && t.cost_total_cents != null) {
      figs.push({ label: T('Total', '合计'), value: money(t.cost_total_cents), tone: '' });
      // §32 rule 10 — the uncosted count travels with the total, always. A
      // total shown alone reads as complete, and the entire point of the flag
      // is that sometimes it is not.
      figs.push({ label: T('No cost', '暂无成本'), value: String(t.uncosted_entries || 0), tone: t.uncosted_entries ? 'warn' : '' });
    } else {
      // Not an empty line: the count of losses in range is the one figure this
      // operator put there, and a pulse with nothing in it reads as a summary
      // that failed to load.
      figs.push({ label: T('Entries', '记录'), value: String(t.entries || 0), tone: '' });
    }
    figs.push({ label: T('Voided', '已作废'), value: String(t.voided_entries || 0), tone: '' });
    return `<div class="wst-pulse">${figs.map(f => `
      <span class="wst-fig ${f.tone}">
        <span class="wst-fig-l">${esc(f.label)}</span>
        <span class="wst-fig-v">${esc(f.value)}</span>
      </span>`).join('')}</div>`;
  }

  // §1.1a region 5 — two dropdowns then one wide control. The wide control is
  // the date range rather than a search box because the scope allows exactly
  // three filters and search is not one of them; the shape is Orders', with the
  // slot filled by what this page actually filters on.
  function filters() {
    const stores = _stores.map(s =>
      `<option value="${s.id}"${String(_loc) === String(s.id) ? ' selected' : ''}>${esc(T(s.name_en || s.code, s.name_cn || s.code))}</option>`).join('');
    const reasons = _reasons.map(r =>
      `<option value="${esc(r.code)}"${_reason === r.code ? ' selected' : ''}>${esc(T(r.en, r.cn))}</option>`).join('');
    // §1.9 data precondition — a picker that can only pick one thing is not a
    // choice. One store, no store filter, no placeholder explaining its absence.
    const locSel = _stores.length > 1 ? `
      <select class="wst-sel" id="wst-f-loc">
        <option value="">${esc(T('All stores', '全部门店'))}</option>${stores}
      </select>` : '';
    return `
      <div class="wst-filters">
        ${locSel}
        <select class="wst-sel" id="wst-f-reason">
          <option value="">${esc(T('All', '全部'))}</option>${reasons}
        </select>
        <div class="wst-range">
          <input type="date" class="wst-date" id="wst-f-from" value="${esc(_from)}" aria-label="${esc(T('From', '从'))}">
          <span class="wst-range-sep">–</span>
          <input type="date" class="wst-date" id="wst-f-to" value="${esc(_to)}" aria-label="${esc(T('To', '至'))}">
          ${(_from || _to || _loc || _reason) ? `<button type="button" class="wst-btn ghost sm" id="wst-f-clear">${esc(T('Clear filters', '清除筛选'))}</button>` : ''}
        </div>
      </div>`;
  }

  function body() {
    if (_loading && !_rows.length) return `<div class="wst-note">${esc(T('Loading…', '加载中…'))}</div>`;
    // §1.12 — a section with bad data SHOWS that it failed. It does not vanish
    // into the empty state, which would read as "nothing was wasted".
    if (_err) {
      return `<div class="wst-banner err">
        <div class="wst-banner-t">${esc(T('Could not load waste records', '无法加载损耗记录'))}</div>
        <div class="wst-banner-b" data-no-i18n>${esc(_err)}</div>
        <button type="button" class="wst-btn sm" id="wst-retry">${esc(T('Try again', '重试'))}</button>
      </div>`;
    }
    const filtering = !!(_from || _to || _loc || _reason);
    if (!_rows.length) {
      // §1.12 — empty and no-results are two states and two sentences. The
      // first is a compliment; the second names the filter and offers to clear
      // it. Conflating them is the most common failure in this product.
      return filtering
        ? `<div class="wst-empty">
             <div class="wst-empty-t">${esc(T('Nothing matches those filters.', '没有匹配的内容。'))}</div>
             <button type="button" class="wst-btn sm" id="wst-e-clear">${esc(T('Clear filters', '清除筛选'))}</button>
           </div>`
        : `<div class="wst-empty">
             <div class="wst-empty-t">${esc(T('Nothing wasted yet. Long may it last.', '还没有登记损耗。'))}</div>
           </div>`;
    }
    return table();
  }

  // §1.19 — table-layout: fixed, a classed <col> per column, percentages that
  // sum to EXACTLY 100. The measurement table lives in the CSS beside the cols.
  // Without `waste:costs` the Cost column is REMOVED — col, header and cells —
  // rather than left blank. An empty column under the word "Cost" is worse
  // than no column: it reads as data that failed to load, and it invites
  // somebody to go looking for the bug. The `nocost` class carries a second
  // set of widths that sum to 100 without it (§1.19), so the six that remain
  // fill the table properly instead of leaving 14% of dead air.
  function table() {
    const withCost = showMoney();
    return `
      <div class="wst-tablewrap">
        <table class="wst-table${withCost ? '' : ' nocost'}">
          <colgroup>
            <col class="wst-c-date"><col class="wst-c-store"><col class="wst-c-prod">
            <col class="wst-c-qty"><col class="wst-c-reason">${withCost ? '<col class="wst-c-cost">' : ''}
            <col class="wst-c-act">
          </colgroup>
          <thead><tr>
            <th>${esc(T('Date', '日期'))}</th>
            <th>${esc(T('Store', '门店'))}</th>
            <th>${esc(T('Product', '产品'))}</th>
            <th class="num">${esc(T('Qty', '数量'))}</th>
            <th>${esc(T('Reason', '原因'))}</th>
            ${withCost ? `<th class="num">${esc(T('Cost', '成本'))}</th>` : ''}
            <th></th>
          </tr></thead>
          <tbody>${_rows.map(row).join('')}</tbody>
        </table>
      </div>`;
  }

  function row(r) {
    const voided = r.voided_by_waste_id != null;
    const reversal = r.reverses_waste_id != null;
    // Three row kinds and each says what it is. A reversal is not a loss and
    // must never be read as one — it is the undo, and it is in the list only
    // because hiding a correction is how a correction goes unnoticed.
    const mark = voided
      ? `<span class="wst-pill voided">${esc(T('Voided', '已作废'))}</span>`
      : reversal
        ? `<span class="wst-pill reversal">${esc(T('Reversal', '冲销'))}</span>`
        : '';
    // §32 rule 10 — zero and unknown must never look alike, so an uncosted row
    // says so in words. Not a dash (which reads as "not applicable") and not
    // ¥0.00 (which reads as "this cost nothing").
    // The cell is only built when the column exists. The null check beside it
    // guards the disagreement case: if this operator's caps say yes and the
    // server stripped the field anyway, money(undefined) is ¥0.00 — which does
    // not read as "withheld", it reads as "the jar was free".
    const showCost = showMoney();
    const cost = (r.cost_total_cents == null && !r.is_uncosted) ? ''
      : r.is_uncosted
        ? `<span class="wst-nocost">${esc(T('No cost', '暂无成本'))}</span>`
        : money(r.cost_total_cents);
    // Void is offered on a live loss only: never on a reversal, never twice.
    // The capability gate is data-cap, so applyCapGates hides it for an
    // operator without waste:void.
    const act = (!voided && !reversal)
      ? `<button type="button" class="wst-btn ghost sm" data-cap="waste:void" data-void="${r.id}">${esc(T('Void', '作废'))}</button>`
      : '';
    return `
      <tr class="${voided ? 'is-voided' : ''}${reversal ? ' is-reversal' : ''}">
        <td>${esc(when(r.business_date, 'date'))}</td>
        <td class="wst-ell">${esc(storeLabel(r))}</td>
        <td class="wst-ell">
          <span class="wst-prod">${esc(productLabel(r))}</span>${mark}
          ${r.note ? `<span class="wst-note-inline" data-no-i18n title="${esc(r.note)}">${esc(r.note)}</span>` : ''}
        </td>
        <td class="num">${esc(String(r.qty))}</td>
        <td class="wst-ell">${esc(reasonLabel(r.reason_code))}</td>
        ${showCost ? `<td class="num">${cost}</td>` : ''}
        <td class="act">${act}</td>
      </tr>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ═══════════════════════════════════════════════════════════════════════════
  function wire() {
    const el = root(); if (!el) return;
    const on = (id, ev, fn) => { const n = document.getElementById(id); if (n) n.addEventListener(ev, fn); };
    on('wst-new', 'click', openRecord);
    on('wst-retry', 'click', load);
    on('wst-e-clear', 'click', clearFilters);
    on('wst-f-clear', 'click', clearFilters);
    on('wst-f-loc', 'change', e => { _loc = e.target.value; load(); });
    on('wst-f-reason', 'change', e => { _reason = e.target.value; load(); });
    on('wst-f-from', 'change', e => { _from = e.target.value; load(); });
    on('wst-f-to', 'change', e => { _to = e.target.value; load(); });
    el.querySelectorAll('[data-void]').forEach(b =>
      b.addEventListener('click', ev => doVoid(Number(b.dataset.void), ev)));
  }

  function clearFilters() { _from = _to = _loc = _reason = ''; load(); }

  // The operator's own store, when they have one. RA_STORE_LOCK is set at boot
  // from the operator's scopeStores (02-settings-ops.js) for a store-scoped
  // position; a full-access operator has none and gets the first store.
  function defaultLocation() {
    if (window.RA_STORE_LOCK) return String(window.RA_STORE_LOCK);
    return _stores.length ? String(_stores[0].id) : '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECORD  — §1.13: every field visible on open, fixed height, one commit.
  //            That is a modal, and the three questions resolve to it: nothing
  //            here is abandonable-and-resumable, and nothing grows the height
  //            by the operator's own actions.
  // ═══════════════════════════════════════════════════════════════════════════
  function openRecord() {
    let picked = null;         // the chosen product row from the picker
    let preview = null;        // { cost_total_cents, is_uncosted } for the typed qty
    let previewSeq = 0;

    const stores = _stores.map(s =>
      `<option value="${s.id}">${esc(T(s.name_en || s.code, s.name_cn || s.code))}</option>`).join('');
    const reasons = _reasons.map(r =>
      `<option value="${esc(r.code)}">${esc(T(r.en, r.cn))}</option>`).join('');

    const bodyHtml = `
      <h3 class="tdlg-title">${esc(T('Record waste', '记录损耗'))}</h3>
      <div class="wst-form">
        <label class="wst-f">
          <span class="wst-f-l">${esc(T('Store', '门店'))}</span>
          <select id="wst-r-loc" class="wst-sel">${stores}</select>
        </label>
        <label class="wst-f wst-f-wide">
          <span class="wst-f-l">${esc(T('Product', '产品'))}</span>
          <input type="text" id="wst-r-prod" class="wst-in" autocomplete="off"
                 placeholder="${esc(T('Search products', '搜索商品'))}">
          <div class="wst-drop" id="wst-r-drop" hidden></div>
        </label>
        <div class="wst-onhand" id="wst-r-onhand" hidden></div>
        <label class="wst-f">
          <span class="wst-f-l">${esc(T('Quantity', '数量'))}</span>
          <input type="number" id="wst-r-qty" class="wst-in" min="1" step="1" value="1">
        </label>
        <label class="wst-f">
          <span class="wst-f-l">${esc(T('Reason', '原因'))}</span>
          <select id="wst-r-reason" class="wst-sel">${reasons}</select>
        </label>
        <label class="wst-f wst-f-wide">
          <span class="wst-f-l">${esc(T('Note', '备注'))}</span>
          <input type="text" id="wst-r-note" class="wst-in" autocomplete="off">
        </label>
        <div class="wst-hint" id="wst-r-hint"></div>
      </div>`;
    const footHtml = `
      <button type="button" class="tdlg-btn tdlg-btn--ghost" data-cancel>${esc(T('Cancel', '取消'))}</button>
      <button type="button" class="tdlg-btn tdlg-btn--primary" data-submit disabled>${esc(T('Record waste', '记录损耗'))}</button>`;

    // Shared shell (public/tacet-dialogs.js) — the same mechanism askConfirm
    // uses, not a parallel build. It owns the scrim, Escape, outside-click,
    // focus restore and the entrance animation.
    const { scrim, closer } = askCustom('tdlg-neutral wst-modal', bodyHtml, footHtml, '#wst-r-prod');
    const $ = sel => scrim.querySelector(sel);
    const close = () => closer(null);
    scrim.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', close));

    const locSel = $('#wst-r-loc');
    const prodIn = $('#wst-r-prod');
    const drop = $('#wst-r-drop');
    const qtyIn = $('#wst-r-qty');
    const reasonSel = $('#wst-r-reason');
    const noteIn = $('#wst-r-note');
    const hint = $('#wst-r-hint');
    const onhand = $('#wst-r-onhand');
    const submit = $('[data-submit]');
    locSel.value = defaultLocation();

    // ── the picker ──
    // Gated on the WASTE capability alone. This endpoint exists because the
    // kitchen screen's picker sits behind the `products` permission while its
    // own screen sits behind `waste`, so the default grant (waste on, products
    // off) hands a waste-only operator an empty list and no explanation —
    // hazard H13 in docs/tacet-waste-survey.md. Never call /api/products here.
    let searchTimer = null;
    async function search() {
      const q = prodIn.value.trim();
      const loc = locSel.value;
      if (!loc) return;
      try {
        const j = await api('/api/retail-admin/waste/products?location_id=' + encodeURIComponent(loc)
          + (q ? '&search=' + encodeURIComponent(q) : ''));
        const list = (j.data || []).slice(0, 12);
        if (!list.length) { drop.hidden = true; return; }
        drop.innerHTML = list.map(p => `
          <button type="button" class="wst-drop-i" data-pid="${p.id}" data-onhand="${p.on_hand}">
            <span class="wst-drop-n">${esc(T(p.name_en || p.name_cn || '', p.name_cn || p.name_en || ''))}</span>
            <span class="wst-drop-m" data-no-i18n>${esc(p.sku || '')}</span>
            <span class="wst-drop-s">${esc(T('In stock', '库存'))} ${esc(String(p.on_hand))}</span>
          </button>`).join('');
        drop.hidden = false;
        drop.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('mousedown', ev => {
          ev.preventDefault();
          const p = list.find(x => String(x.id) === b.dataset.pid);
          pick(p);
        }));
      } catch (e) { drop.hidden = true; }
    }
    function pick(p) {
      picked = p;
      prodIn.value = T(p.name_en || p.name_cn || '', p.name_cn || p.name_en || '');
      drop.hidden = true;
      // On-hand is shown BEFORE submit, not discovered at the refusal. The API
      // rejects a quantity above it (§32's refuse-don't-clamp rule) and finding
      // that out after pressing the button is the worse half of the same
      // information.
      onhand.hidden = false;
      onhand.textContent = T('In stock', '库存') + ' ' + p.on_hand;
      refresh();
    }
    prodIn.addEventListener('input', () => {
      picked = null; onhand.hidden = true; refresh();
      clearTimeout(searchTimer); searchTimer = setTimeout(search, 180);
    });
    prodIn.addEventListener('focus', search);
    prodIn.addEventListener('blur', () => setTimeout(() => { drop.hidden = true; }, 160));
    locSel.addEventListener('change', () => { picked = null; prodIn.value = ''; onhand.hidden = true; refresh(); });

    // ── cost preview ──
    // The same accessor and the same arithmetic the write uses, so the figure
    // shown and the figure stored cannot disagree.
    async function loadPreview() {
      const qty = Number(qtyIn.value);
      if (!picked || !(qty > 0)) { preview = null; return; }
      // Nothing to preview for an operator who may not read a cost, and no
      // reason to ask the server for one it would refuse to send.
      if (!showMoney()) { preview = null; return; }
      const seq = ++previewSeq;
      try {
        const j = await api('/api/retail-admin/waste/preview?store_product_id=' + picked.id + '&qty=' + qty);
        if (seq !== previewSeq) return;      // a later keystroke already won
        preview = j.data || null;
      } catch (e) { if (seq === previewSeq) preview = null; }
      refresh();
    }

    // One place decides whether the button is live, and it always says WHY it
    // is not. A dead button with no explanation is the failure 19-recipes.js
    // records against itself; this is the same guard.
    function refresh() {
      const qty = Number(qtyIn.value);
      let reason = null;
      if (!picked) reason = T('Pick a product.', '请选择产品。');
      else if (!Number.isInteger(qty) || qty <= 0) reason = T('Quantity must be a whole number above zero.', '数量必须是大于零的整数。');
      else if (reasonSel.value === 'other' && !noteIn.value.trim()) {
        // 'Other' requires a note — enforced here so the operator is told
        // before they press, and again by the API so it cannot be bypassed.
        reason = T('Tell us what happened when the reason is Other.', '原因选择“其他”时请填写备注。');
      }
      submit.disabled = !!reason;
      let text = reason || '';
      // `preview` is null for a cost-blind operator (loadPreview returns early),
      // so the hint stays on the blocking reason or empty — never a figure.
      if (!reason && preview && showMoney()) {
        text = preview.is_uncosted
          ? T('No cost on file for this product — it will be recorded without one.', '该产品暂无成本,此条将不计成本。')
          : T('Cost', '成本') + ' ' + money(preview.cost_total_cents);
      }
      hint.textContent = text;
      hint.className = 'wst-hint' + (reason ? ' warn' : '');
    }
    qtyIn.addEventListener('input', () => { refresh(); loadPreview(); });
    reasonSel.addEventListener('change', refresh);
    noteIn.addEventListener('input', refresh);
    refresh();

    // ── commit ──
    submit.addEventListener('click', async () => {
      // §1.12 in-flight — the control that writes disables while it writes,
      // and the reference is captured synchronously here rather than read
      // after an await (failure shape C).
      const btn = submit;
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = T('Recording…', '登记中…');
      try {
        const j = await api('/api/retail-admin/waste', {
          method: 'POST',
          body: {
            location_id: Number(locSel.value),
            subject_type: 'product',
            store_product_id: picked.id,
            qty: Number(qtyIn.value),
            reason_code: reasonSel.value,
            note: noteIn.value.trim() || null,
          },
        });
        const saved = j.data || {};
        closer(true);
        // Say what was recorded INCLUDING the cost that was snapshotted, and
        // say it at the moment it happened. §32 rule 10 again: if it saved
        // without a cost the operator hears so now, not when a total looks
        // wrong next week.
        const what = productLabel({ product_name_en: picked.name_en, product_name_cn: picked.name_cn });
        // The toast is a money surface too, and it is the one that gets
        // forgotten: the page behind it can be gated perfectly while this
        // announces the figure on its way past.
        toast(!showMoney()
          ? T('Recorded', '已登记') + ' ' + qtyIn.value + ' × ' + what
          : saved.is_uncosted
            ? T('Recorded ' + qtyIn.value + ' × ' + what + ' — no cost on file', T('Recorded', '已登记') + ' ' + qtyIn.value + ' × ' + what + ' — ' + T('No cost', '暂无成本'))
            : T('Recorded', '已登记') + ' ' + qtyIn.value + ' × ' + what + ' · ' + money(saved.cost_total_cents));
        load();
      } catch (e) {
        // §1.12 error — a failed write renders where the operator is looking,
        // next to the control they pressed, and stays. Never a toast that flies
        // away: a loss the operator believes was recorded and was not is worse
        // than one they know failed.
        btn.disabled = false;
        btn.textContent = prev;
        hint.className = 'wst-hint warn';
        hint.textContent = (e && e.message) ? e.message : T('Failed', '操作失败');
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  VOID — a reversal, never an edit or a delete (§32 rule 11, §20).
  // ═══════════════════════════════════════════════════════════════════════════
  async function doVoid(id, ev) {
    // Captured synchronously: askConfirm awaits, and event.currentTarget is
    // null by the time an awaited handler reads it (§1.12 failure shape C).
    const btn = ev && ev.currentTarget;
    const r = _rows.find(x => x.id === id);
    if (!r) return;
    const qty = r.qty;
    const what = productLabel(r);
    // This moves live stock, so it gets a confirm step, and the confirm says
    // what will move rather than asking "are you sure".
    // NO MEASURE WORD, in either language. A row carries its own `unit` and a
    // waste entry is not always pieces — 3 kg of something rendered as “3 件”
    // reads as three pieces, which is a different fact. The English stays
    // unit-agnostic through “qty × product” and the Chinese uses the same ×
    // rather than reaching for a classifier. Chinese names the product first
    // because that is its natural order, not English's.
    const ok = await askConfirm({
      title: T('Void this waste entry?', '作废这条损耗记录?'),
      body: T(qty + ' × ' + what + ' goes back into stock. The entry stays in the list, marked voided.',
               what + ' × ' + qty + ' 将退回库存。该记录仍保留在列表中,标记为已作废。'),
      confirmLabel: T('Void', '作废'),
      cancelLabel: T('Cancel', '取消'),
      danger: true,
    });
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.textContent = T('Voiding…', '作废中…'); }
    try {
      await api('/api/retail-admin/waste/' + id + '/void', { method: 'POST', body: {} });
      toast(T('Voided', '已作废'));
      load();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = T('Void', '作废'); }
      toast(((e && e.message) ? e.message : T('Failed', '操作失败')), 'err');
    }
  }
})();
