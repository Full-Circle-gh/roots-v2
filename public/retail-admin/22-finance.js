/* ══════════════════════════════════════════════════════════════════════════
   FINANCE — the money staircase.

   Governed by docs/tacet-consolidation-decisions.md §36 (v4.115). Layout,
   spacing and copy from reference/finance-summary-mockup.html. Every string is
   an EN/CN pair copied from the Finance table of
   docs/tacet-delivery-vocabulary.md (LOCKED 2026-09-02) — none is composed
   here, per that document's Rule 4.

   THE ONE PLACE THIS DEPARTS FROM THE MOCKUP. The mockup predates §36 v4.113
   and renders cost of goods and gross profit as hard numbers. It cannot: no
   cost reader exists, `unit_cost_at_sale` is written by all six sale paths and
   read by nothing, and §36 v4.113 records that cost of goods does not exist
   before capture started and cannot be backfilled. Both lines render the §1.12
   seventh state instead, in every period, unconditionally — never hidden,
   never zero, never a dash. "Zero claims the goods were free."

   WHAT IS NOT HERE, AND WHY IT IS NOT A GAP
     • No Transactions sub-view — out of scope; §36 specifies it, nothing
       builds it yet. With one sub-view there is no sub-view strip either.
     • No store filter, no Contribution, no excluded-costs line, no
       Not-location-specific row. `expense_entries` has no location column
       (schema.sql:229) and §36 leaves its shape undecided, so a filtered view
       could only scope revenue and not expenses. §36: "A filter that silently
       returns a wrong answer is worse than no filter." The pairs for all three
       are locked in the vocabulary and stay unused until the column exists;
       none of them is composed or approximated here.
     • No cost reader. §36 binds six ways one will silently miscount, on its
       build. This file does not start it by accident.
   ══════════════════════════════════════════════════════════════════════════ */

/* eslint-disable no-undef */
/* The house header for this directory. All parts share ONE global scope and are
   loaded sequentially by retail-admin.html — LOAD ORDER MATTERS. The
   cross-file globals used below (api, cuT, cuLang, escapeHtml, onLangChange)
   live in 01-core.js and in the inline <script> near the end of the document,
   so they are undefined to a per-file lint. */

'use strict';

// Cold-load flag: §1.12's loading state is "only on a real load". A refresh
// keeps the current numbers on screen until the fresh ones land, so the card
// never blanks out under an operator who is reading it.
let FIN_DATA = null;
let FIN_SEEN = false;

// ── Money ──────────────────────────────────────────────────────────────────
// Whole units on the staircase: these are period totals, read rather than
// reconciled, and the fen on a five-figure number is noise. Matches dashMoney's
// default on Reports so the two screens render the same magnitude the same way.
//
// The ¥ is hardcoded, as it is on every other screen in this surface. Currency
// is per business under §0 and none of this admin carries currency logic yet;
// that is a surface-wide sweep, and inventing a mechanism here that nothing
// else honours would leave two conventions instead of one.
function finMoney(n) {
  return acWrap(Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }));
}

/* ── Money INSIDE a disclosure — the real amount, to the fen ────────────────
   **THE WHOLE-YUAN RULE ABOVE STOPS AT THE STAIRCASE, AND THIS IS WHERE.**
   `finMoney` is right for a period total: the fen on `¥37,942` is noise, and
   §36 decided it. It is WRONG for a list somebody opened in order to check it,
   and the way it is wrong was measured rather than supposed —

     true line amounts : 52.80  47.60  145.60  13.40   →  259.40
     shown whole       : 53     48     146     13      →  260
     row shown whole   :                                   259

   Same rows, two whole numbers a yuan apart, and nothing on screen to explain
   it. Each line rounds by up to half a yuan and the errors accumulate: over a
   random sweep of realistic orders the worst drift on a nine-line order was
   ¥3. **Rendering whole yuan does not hide that drift, it CREATES it** — which
   is the opposite of what §88's own note first recorded, corrected there.

   01-core.js already states the rule this follows: "anywhere an operator might
   reconcile the number against something — a list, a total, a dialog, an
   export — uses acMoney and shows the real amount". A drill-down row is that
   list, by construction: it exists so the figure above it can be checked.

   THE STAIRCASE AND THE CATEGORY LINES ARE UNCHANGED. Revenue, the two cost
   rows, operating expenses, net and every line of the breakdown stay whole —
   those are §36's figures and its decision. Only what opens BELOW a breakdown
   line renders exact. */
function finExact(n) {
  return acMoney(Number(n || 0));
}

// ── The range bar ──────────────────────────────────────────────────────────
// The Reports bar's own behaviour, on Finance's own element ids. The GZ-local
// computation is copied deliberately rather than shared: dashSetRange writes
// #db-from/#db-to by hard-coded id and reloads Reports, so calling it here
// would move the other screen's window. Same arithmetic, same +8h shift, so a
// "30 days" on one screen is the same 30 days on the other.
//
// THE BAR ACCEPTS ANY DATE THE DATA COVERS. §36, *Finance is not floored at the
// cutover date* (DECIDED 2026-09-02): there is no 1 August 2026 floor on this
// bar, on the Transactions bar it shares, or on the endpoints behind either. The
// #fin-from / #fin-to fields carry no `min` and the presets are not clamped — a
// 90-day window reaches back past the cutover and is meant to. Both cost rows go
// on reading Not recorded UNCONDITIONALLY, in every period; that is the seventh
// state doing its job, and it must NOT be turned into a date condition here.
function finSetRange(key) {
  document.querySelectorAll('#fin-range-seg button')
    .forEach(b => b.classList.toggle('on', b.dataset.range === key));
  // The store's own days. These four spelled Guangzhou out, so on any other
  // account Finance's presets asked the ledger for the wrong window — and
  // Finance is the one screen where a day out is money in the wrong month.
  const today = tdToday();
  let from = today;
  if (key === '7')  from = tdToday(-6);
  if (key === '30') from = tdToday(-29);
  if (key === '90') from = tdToday(-89);
  const f = document.getElementById('fin-from'), t = document.getElementById('fin-to');
  if (f) f.value = from;
  if (t) t.value = today;
  finLoad();
}

// Keeps the segmented buttons truthful when the window moves some way other
// than a click on one of them — typing into #fin-from/#fin-to and hitting
// Apply (or Refresh) left whichever preset was clicked last still bold, over
// a range that no longer matched it. Called wherever finSetRange is not the
// one setting the fields, so the bar never asserts a preset the dates deny.
function finSyncRangeButtons(from, to) {
  const today = tdToday();
  let key = null;
  if (from === today && to === today) key = 'today';
  else if (from === tdToday(-6) && to === today) key = '7';
  else if (from === tdToday(-29) && to === today) key = '30';
  else if (from === tdToday(-89) && to === today) key = '90';
  document.querySelectorAll('#fin-range-seg button')
    .forEach(b => b.classList.toggle('on', b.dataset.range === key));
}

// The echo on the title line. dashRangeLabel's shape minus its store half —
// there is no store dimension on this screen, so naming one would be a claim.
function finRangeLabel() {
  const el = document.getElementById('fin-range');
  if (!el) return;
  const from = (document.getElementById('fin-from') || {}).value;
  const to = (document.getElementById('fin-to') || {}).value;
  if (!from || !to) { el.textContent = ''; return; }
  const fmt = s => tdWhen(s, 'date');
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const win = days <= 1 ? cuT('today', '今日') : cuT(`${days} days`, `${days}天`);
  el.textContent = `${from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`} · ${win}`;
}

// ── Rendering ──────────────────────────────────────────────────────────────

// ── Category labels — one language, from a value that carries both ─────────
//
// THE CATEGORY IS DATA, NOT A LOCKED PAIR. Every other bilingual thing on this
// surface goes through cuT with a pair from the vocabulary; a category is a
// value the tenant typed, held as ONE free-text column. And what is in that
// column is both languages glued into one string — `Salaries&Wages 员工工资`,
// `Packaging Materials 包装材料`, `Ingredients(Kitchen+Retail Use) 原材料（厨房
// 及零售通用）` — so the English screen was showing Chinese and the Chinese
// screen English, in the one place on Finance that cuT cannot reach.
//
// The house pattern for bilingual DATA is two columns picked with a fallback
// across — `tmStoreLabel` on stores, `name_en`/`name_cn` on roles. `categories`
// has one `name` column and the ledger's `category` is free text with no
// foreign key (§36), so there is nothing to pick between. **This splits at
// RENDER and stores nothing new.** A second column is the eventual fix and is a
// schema change plus a migration of four columns of live values; it is not this.
//
// IT REFUSES TO GUESS. A value splits only when its Latin letters and its CJK
// sit in two contiguous runs, in either order — which is every real value
// measured, in both orders. Anything interleaved, or carrying only one language
// (`销货成本`, `Rent`), renders whole in both languages: showing half of a name
// that has no other half is worse than showing a word the reader does not need.
const FIN_CJK = /[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\uff00-\uffef]/;
const FIN_LAT = /[A-Za-z]/;

/** `{ en, cn }` when the value carries both halves cleanly, else null. */
function finCatSplit(value) {
  const s = String(value == null ? '' : value);
  const chars = Array.from(s);
  let firstCjk = -1, lastCjk = -1, firstLat = -1, lastLat = -1;
  chars.forEach((ch, i) => {
    if (FIN_CJK.test(ch)) { if (firstCjk < 0) firstCjk = i; lastCjk = i; }
    else if (FIN_LAT.test(ch)) { if (firstLat < 0) firstLat = i; lastLat = i; }
  });
  if (firstCjk < 0 || firstLat < 0) return null;          // only one language
  let en, cn;
  if (lastLat < firstCjk) { en = chars.slice(0, firstCjk).join(''); cn = chars.slice(firstCjk).join(''); }
  else if (lastCjk < firstLat) { cn = chars.slice(0, firstLat).join(''); en = chars.slice(firstLat).join(''); }
  else return null;                                        // interleaved — do not guess
  en = en.trim(); cn = cn.trim();
  return (en && cn) ? { en, cn } : null;
}

/** The half for the live language. Falls back to the whole value, never to ''. */
function finCatLabel(value) {
  const p = finCatSplit(value);
  if (!p) return String(value == null ? '' : value);
  return (window.cuLang && cuLang() === 'cn') ? p.cn : p.en;
}

/* The labels for a SET of categories, with the collision rule applied.
   Two stored values whose halves read the same in this language — `Rent 房租`
   and `Rent 租金` — would draw two lines the operator cannot tell apart, which
   is §36's three-rent-payments defect arriving through the display instead of
   through the data. **Both then render whole**, so the screen stays honest about
   a distinction it cannot express in one language. */
function finCatLabels(list) {
  const map = new Map();
  const claims = new Map();
  for (const v of list) {
    if (v == null || map.has(v)) continue;
    const label = finCatLabel(v);
    map.set(v, label);
    claims.set(label, (claims.get(label) || 0) + 1);
  }
  for (const [v, label] of map) if (claims.get(label) > 1) map.set(v, String(v));
  return map;
}


/** One money row of the staircase. `sign` is '−' or ''; it owns its own column. */
function finRow(label, figure, opts) {
  const o = opts || {};
  const cls = ['fin-row', o.concl ? 'fin-concl' : 'fin-input', o.less ? 'fin-less' : '',
    o.notrec ? 'fin-absent' : ''].filter(Boolean).join(' ');
  // THE SIGN ONLY RENDERS BESIDE A FIGURE IT APPLIES TO. A minus alone in the
  // money column, with nothing after it, is read as a dash standing in for the
  // number — and §36 rejects that in terms: "a dash is already banned as a
  // value", and §1.12 refuses "a column of blanks [that] sends the eye hunting
  // for something that was never there". The sign is a deduction cue, not a
  // placeholder, so a row with no figure shows neither — and neither does one
  // whose figure is the not-recorded VALUE, because "− Not recorded" asks the
  // reader to subtract something that is not a quantity.
  const sign = (o.less && figure != null && !o.notrec) ? '−' : '';
  return `<div class="${cls}">`
    + `<span class="fin-lbl">${escapeHtml(label)}</span>`
    + `<span class="fin-sign">${sign}</span>`
    + `<span class="fin-fig">${figure == null ? '' : escapeHtml(figure)}</span>`
    + '</div>';
}

/* The §1.12 seventh state as a VALUE, which is a different string from the
   sentence below it and does a different job. The vocabulary says so outright:
   "`noCostRecorded` IS A SENTENCE, NOT A VALUE. It does not replace a figure in
   a cell. The existing `not recorded` / `未记录` pair … is a VALUE for one
   absent field … neither replaces the other."

   §36 v4.113 requires the ROWS to carry it: "Summary renders both the cost of
   goods line and the gross profit line READING NOT RECORDED." A blank figure
   cell does not read as anything — it reads as a gap, which is the failure the
   state exists to avoid. Reused from 08-customers.js:1366, not minted. */
function finNotRecordedValue() {
  return cuT('Not recorded', '未记录');
}

/* The §1.12 seventh state, covering the two cost lines.
   ONE SENTENCE, NOT TWO, and the reason is §1.12's own wording: "show what IS
   known, and ONE past-tense sentence saying why the rest is not." Cost of goods
   and gross profit are absent for a single reason — nothing captured the cost —
   so a second copy would assert a second cause. Both rows render in the
   treatment (label kept, figure absent, no dash); the note that treatment
   requires sits under the pair, bound to both.

   It names NO DATE. §1.12 usually has the seventh state name where its boundary
   falls; §36 v4.113 overrides that here, recording that the cutoff must come
   from a production query that has not been run and that the commit date must
   not be quoted as one. The locked pair has no dated form, and a dated one
   would be a NEW string and a NEW pair, never an edit to this one. */
function finNotRecorded() {
  return `<p class="td-notrec">${escapeHtml(cuT(
    'This period has no recorded cost data.',
    '此期间未记录成本数据。'
  ))}</p>`;
}

/* ── The shortfall behind a cost figure that IS shown ───────────────────────
   §56 as amended 2026-09-14 by Ash. The two rows below may now carry a figure,
   **on the condition that the figure never appears without the share of the
   period it rests on.** This sentence is that condition, so it is not
   decoration: removing it does not tidy the card, it undoes the decision the
   figure ships under.

   It says THE REAL MARGIN IS LOWER rather than merely naming the fraction,
   because the direction is the whole point and it is not obvious from a
   percentage. Cost missing from a period can only push the margin UP, never
   down — the shortfall always flatters, which is the direction that gets acted
   on. `public/retail-admin/09-products.js`'s `_paMarginWarn` says exactly this
   about exactly this failure one level down, on a single product's margin drawn
   from an incomplete cost; this is that sentence at period scale and its
   Chinese half is lifted from it character for character.

   FLOOR, NOT ROUND, on the percentage. A window at 99.6% would round to "100%"
   and print a sentence that contradicts its own number in the same breath. The
   figure must never claim more coverage than there is, and floor is the only
   direction that cannot.

   DISTINCT FROM `finNotRecorded()` ABOVE, which is the §1.12 seventh state for
   a period with NO cost at all. That one explains an absence; this one
   qualifies a presence. They are never both drawn — see `finCostRows`. */
function finCoverageNote(cov) {
  const p = Math.floor(cov * 100);
  return `<p class="td-notrec">${escapeHtml(cuT(
    `Cost recorded for ${p}% of this period's revenue — the real margin is lower.`,
    `此期间 ${p}% 的营收已记录成本 —— 实际毛利更低。`
  ))}</p>`;
}

/* ── Lines 2 and 3, in whichever of their three states the period is in ─────
   THE SERVER DECIDES WHICH, AND THIS FUNCTION ONLY DRAWS IT. `cost_of_goods`
   is null for a period no line of which carried a cost, and that is a decision
   taken against the data (routes/finance-summary.js) rather than a rendering
   choice. Re-deriving the state here from `cost_coverage === 0` would put the
   rule in two places, which is how the screen and the payload come to disagree
   about what a period is.

   NO COST AT ALL → exactly what these rows have shown since §56: label kept,
   the seventh state as a VALUE, no dash, one sentence under the pair. **The
   amendment does not reach this case and must not be extended to it.** July
   2026 carries ¥56,792 of line revenue and not one costed line; a ¥0.00 here
   would publish a 100% margin for a month whose cost was never captured and
   never can be, which is the "zero claims the goods were free" §36 refused and
   §56 kept.

   SOME COST → the figures, with the shortfall stated beneath them.

   ALL COST → the figures, and nothing beneath them. **This is the amendment's
   own "and then the note goes away", and it happens because the shortfall it
   describes is gone, not because anybody remembered to delete it.** A caveat
   that has to be removed by hand is the kind this repo's CLAUDE.md opens by
   warning about; this one cannot outlive its subject. */
function finCostRows(d) {
  const cogs = d ? d.cost_of_goods : null;
  const cov = (d && typeof d.cost_coverage === 'number') ? d.cost_coverage : null;
  if (cogs == null) {
    return finRow(cuT('Cost of goods', '销货成本'), finNotRecordedValue(), { less: true, notrec: true })
      + finRow(cuT('Gross profit', '毛利润'), finNotRecordedValue(), { concl: true, notrec: true })
      + finNotRecorded();
  }
  return finRow(cuT('Cost of goods', '销货成本'), finMoney(cogs), { less: true })
    + finRow(cuT('Gross profit', '毛利润'), finMoney(d.gross_profit), { concl: true })
    + (cov != null && cov < 1 ? finCoverageNote(cov) : '');
}

/* The two halves of the breakdown (§87 part two).

   `is_operating` arrives on every row. A row from a server that predates the
   flag has none, and `!== 0` reads that as operating — the same direction the
   server defaults in, so a stale payload cannot silently move money OUT of the
   operating total on the way to the screen. */
function finOperating(rows) {
  return (rows || []).filter(r => r.is_operating !== 0);
}
function finNonOperating(rows) {
  return (rows || []).filter(r => r.is_operating === 0);
}

/* ── The rows behind one category ──────────────────────────────────────────
   The category currently opened, as an INDEX INTO `FIN_DATA.expense_breakdown`
   — the whole array, both halves, not the filtered list a disclosure renders.
   The index is the identity because a category is not one: it is free text and
   may be null, and the null row has no name to key on.

   Dropped on every load (`finLoad`), so a new window never leaves a list of
   August rows hanging under a September figure. */
let FIN_CAT = null;   // { i, rows, err } — rows null while the read is in flight

/* THE THIRD LEVEL: the items behind one purchase-order row.
   Keyed by the LEDGER ROW'S OWN id, which is what the endpoint takes — one
   `expense_entries` row is one (purchase order, category) pair, so the id names
   the slice with nothing for this screen to reconstruct.
   One at a time, like the category above it. Dropped whenever the category
   closes or the window moves, both of which take its row off the screen. */
let FIN_POL = null;   // { id, rows, err } — rows null while the read is in flight

/* One expense row inside an opened category.

   EVERY STRING HERE IS ALREADY LIVE ON THE TRANSACTIONS TAB, and that is on
   purpose rather than by luck: these are the same three kinds of row an
   operator meets there — typed, claim-posted, PO-posted — and a second
   vocabulary for them would suggest a second set of things. Nothing is composed
   (`docs/tacet-delivery-vocabulary.md` Rule 4, as amended 2026-09-06: the
   delegation is standing, and the cheapest exercise of it is not to use it).

   A PO ROW IS NAMED BY ITS PURCHASE ORDER and shows the mark beside it, exactly
   as `finTxRow` does. It appears once per row rather than once per order — the
   same PO twice in one category is one purchase that bought that category on
   two lines, and collapsing them here would be the very thing this list exists
   to undo. NO LINK OUT: the row is inside a figure, not a ledger the operator
   is working, and the Transactions tab is one click away with the link on it.

   A row with no note and no mark renders its date and its figure and nothing
   between them. That is the truth about a typed row somebody left blank, and
   §1.12 prefers an empty cell to an invented one. */
function finCatRow(r) {
  const po = r.source === 'po';
  const claim = r.source === 'claim';
  // §98 stage four — the THIRD kind of projection, and the first one on the
  // money-IN side. Marked for the same reason as the other two: the row belongs
  // to a delay case and is re-posted whenever that case changes.
  const fromCase = r.source === 'delay_case';
  const mark = po
    ? cuT('Posted by Purchasing', '采购单自动记入')
    : claim
    ? (r.paid_by === 'employee'
        ? cuT('Staff claim · own money', '费用申请 · 个人支付')
        : cuT('Staff claim', '费用申请'))
    : fromCase
    ? cuT('Carrier claim', '承运商赔偿')
    // §269. A return is a negative row here, and the figure already prints its
    // sign; the mark says why this category's total is lower.
    : r.source === 'return'
    ? cuT('Return', '退货')
    : '';
  /* THE DESCRIPTION ALREADY CARRIES THE PO NUMBER — do not prepend it again.
     Both posters build the same string and both lead with it:
     `${po_number}${supplier ? ' · ' + supplier : ''} · N line(s)`, in
     `postRetailPOExpenses` (routes/retail-purchasing.js) and `postPOExpenses`
     (routes/purchases.js). Joining the number onto the front of that printed
     `RPO-0028 · RPO-0028 · 1 line` on the live screen — reported by Ash from the
     card the day this shipped.

     So the posted description is the name, whole, and the bare PO number is only
     the FALLBACK for a row that somehow has none. Reconstructing a label from
     parts when the writer already wrote one is how the two come to disagree; the
     poster owns that sentence and this renders it. */
  const name = r.note || (po ? (r.po_number || '') : '') || '';
  /* OPENABLE ONLY WHERE THERE IS SOMETHING BEHIND IT. `lines` is counted
     server-side; it is 0 on the landed-cost row, which posts freight, tax and
     handling against the order with no `po_line_items` at all. This screen
     already refuses a chevron that opens onto nothing on the expenses
     disclosure, and the same rule decides here. A row that cannot open renders
     exactly as it did before — no control, no chevron, no explanation owed. */
  const openable = po && Number(r.lines) > 0;
  const open = openable && !!FIN_POL && FIN_POL.id === r.id;
  const body = '<span class="fin-catdate">' + escapeHtml(finTxDay(r.date)) + '</span>'
    + '<span class="fin-catwhat">'
    + (name ? `<span class="fin-catname">${escapeHtml(name)}</span>` : '')
    + (mark ? `<span class="fin-catmark">${escapeHtml(mark)}</span>` : '')
    + '</span>'
    + `<span class="fin-catfig">${escapeHtml(finExact(r.amount))}</span>`;
  if (!openable) return `<div class="fin-catrow">${body}</div>`;
  return `<button type="button" class="fin-catrow fin-pol${open ? ' on' : ''}" `
    + `aria-expanded="${open ? 'true' : 'false'}" onclick="finPoLines(${Number(r.id)})">`
    + body + '</button>'
    + (open ? `<div class="fin-polrows" data-no-i18n>${finPolBody()}</div>` : '');
}

/* One item on a purchase order, inside the category it was posted under.

   THE NAME IS TWO COLUMNS PICKED BY LANGUAGE, with a fallback across when a
   line carries only one — the house pattern for bilingual DATA (`tmStoreLabel`
   on stores, `name_en`/`name_cn` on roles). It is NOT `finCatLabel`: that
   splits ONE glued free-text value, which is what a category is and what an
   item name is not.

   QUANTITY AND UNIT COST ARE THE LINE'S OWN, and the quantity is what the shop
   is BILLED for — what turned up less what went back. A line partly returned
   shows the smaller number, because the smaller number is what is in the figure
   above it. */
function finPolRow(r) {
  const cn = (typeof cuLang === 'function') && cuLang() === 'cn';
  const name = (cn ? (r.name_cn || r.name_en) : (r.name_en || r.name_cn)) || '';
  /* `200 pc × ¥3.50`, with the unit where the line carries one. A count and a
     price need no label — §1.12's preference for the figure over a word about it.

     **THE UNIT COST IS `acMoney`, NOT `finMoney`, AND THAT IS LOAD-BEARING.**
     `finMoney` renders whole units, which is right for a period total and
     WRONG FOR A PRICE: it drew a ¥3.50 jar as ¥4, a lie about what the supplier
     charged, and three of them as ¥12 against a line of ¥10.50. 01-core.js
     states the rule this follows — "anywhere an operator might reconcile the
     number against something… uses acMoney and shows the real amount".

     The figure in the aligned column stays `finMoney`, at all three levels. It
     is the staircase's own column and its magnitude is §36's decision; a list
     that switched to fen halfway down would stop lining up under the total it
     is there to be checked against. */
  const qty = Number(r.qty || 0);
  const each = `${qty.toLocaleString('en-US', { maximumFractionDigits: 3 })}`
    + `${r.unit ? ' ' + r.unit : ''} × ${acMoney(r.unit_cost)}`;
  return '<div class="fin-polrow">'
    + `<span class="fin-polname">${escapeHtml(name)}</span>`
    + `<span class="fin-polqty">${escapeHtml(each)}</span>`
    + `<span class="fin-polfig">${escapeHtml(finExact(r.amount))}</span>`
    + '</div>';
}

/* What sits under an opened purchase-order row. Same three states as the level
   above, said the same way, with the same live pairs. No total line: the figure
   it opened from is directly above it and is that total. */
function finPolBody() {
  if (FIN_POL.err) {
    return `<div class="fin-catnote-line">${escapeHtml(FIN_POL.err)}</div>`;
  }
  if (FIN_POL.rows === null) {
    return `<div class="fin-catnote-line">${escapeHtml(cuT('Loading…', '加载中…'))}</div>`;
  }
  if (!FIN_POL.rows.length) {
    return `<div class="fin-catnote-line">${escapeHtml(cuT('Nothing recorded yet', '暂无记录'))}</div>`;
  }
  return FIN_POL.rows.map(finPolRow).join('');
}

/* ── Opening a purchase-order row ──────────────────────────────────────────
   THE LEDGER ROW'S ID IS THE WHOLE REQUEST. The server resolves the order and
   the category from it, so this screen never assembles a (purchase order,
   category) pair the ledger has no row for.

   The in-flight guard and the click-to-shut are the level above's, unchanged:
   one open at a time, a stale response dropped on arrival. */
window.finPoLines = function finPoLines(id) {
  const entry = Number(id);
  if (!entry) return;
  if (FIN_POL && FIN_POL.id === entry) { FIN_POL = null; finRender(); return; }

  FIN_POL = { id: entry, rows: null, err: '' };
  finRender();
  api('/api/retail-admin/finance/summary/po-lines?entry_id=' + encodeURIComponent(entry))
    .then((j) => {
      if (!FIN_POL || FIN_POL.id !== entry) return;   // a later click already won
      FIN_POL.rows = (j.data && j.data.rows) || [];
      finRender();
    })
    .catch(() => {
      if (!FIN_POL || FIN_POL.id !== entry) return;
      FIN_POL.err = cuT('Could not load Finance.', '财务数据加载失败。');
      finRender();
    });
};

/* ── WHY BOTH DRILL-DOWN CONTAINERS CARRY `data-no-i18n` ───────────────────
   The revenue disclosure's guard, applied to the two levels below it, and for
   the second of two reasons rather than one. Both were found by reproducing
   them against the shipped walker; neither is theoretical.

   ONE · A ROW WITH AN ENGLISH NOTE DISAPPEARS IN CHINESE. `tagBlockPair`
   (`10-extras.js`) reads an all-English <div> beside an all-Chinese one as
   stacked help text, stamps `data-lang-block`, and a rule in
   `retail-admin.html` hides the inactive side with `display:none!important`.
   These rows are free text somebody typed, so a `天河店租金` row beside an
   `Office chairs` row is exactly that shape — and the ¥800 leaves the screen
   while the category total above it still counts it. The same defect the
   revenue lines had, one level down, and it predates them.

   TWO · A PURCHASE-ORDER DESCRIPTION LOSES ITS TAIL IN ENGLISH, which is the
   half the revenue guard did not have. Both posters write
   `RPO-0028 · 天河供应商 · 3 lines`, and `processNode` splits a text node on
   its FIRST ` · ` whenever the right half carries Chinese and the left does
   not. That is true here by accident of the supplier's name, so an English
   reader was shown `RPO-0028` alone — the supplier and the line count silently
   gone, with no way to tell a one-line order from a twelve-line one.

   NOTHING IS LOST BY CLOSING THESE SUBTREES. Every word in them is already
   language-aware in JS: the marks come from `cuT`, the item names pick their
   column by `cuLang`, and `finRender` redraws the lot on `onLangChange`. What
   the walker was doing here was not translation — it was mistaking data for
   markup, in both directions. */

/* What sits under an opened category row: the rows, or why they are not there.

   NO TOTAL LINE. The figure this opened from is directly above it and is that
   total — a second copy would be one more place for the two to disagree, and
   the point of the endpoint behind this is that they cannot. */
function finCatBody() {
  if (FIN_CAT.err) {
    return `<div class="fin-catnote-line">${escapeHtml(FIN_CAT.err)}</div>`;
  }
  if (FIN_CAT.rows === null) {
    // Live on the Approvals sub-view of this same screen.
    return `<div class="fin-catnote-line">${escapeHtml(cuT('Loading…', '加载中…'))}</div>`;
  }
  if (!FIN_CAT.rows.length) {
    // Should not happen — a line with a figure has rows behind it. It says so
    // rather than drawing an empty box, using the §1.12 EMPTY heading the
    // Transactions tab already ships.
    return `<div class="fin-catnote-line">${escapeHtml(cuT('Nothing recorded yet', '暂无记录'))}</div>`;
  }
  return FIN_CAT.rows.map(finCatRow).join('');
}

/* ── The name of a revenue channel ─────────────────────────────────────────
   EVERY PAIR IS COPIED FROM A LIVE ONE, none composed — the standing rule's
   first preference, and the cheapest exercise of the 2026-09-06 delegation is
   not to use it. There are two sources, and which one owns a key is not
   arbitrary:

   THE PLATFORMS come from `csName` (01-core.js), the Sales-page channel
   control — the closest sibling there is, naming these same channels for the
   same operator two screens over, and the only one of the two that carries a
   Chinese half for them. `ordChannelLabel` returns a bare `Meituan` / `Web` /
   `WeChat`, which is right on a dense order row and wrong on a card an
   operator reads in Chinese: 美团 is the platform's actual name here.

   THE STAFF-KEYED ORIGINS come from `ordChannelLabel` (04-orders.js), which
   OWNS them (`manual` excepted — see below) — `MANUAL_ORDER_ORIGINS` in routes/retail.js is the answer to the
   New order form's "how did the customer reach us?", and the orders list is
   where an operator meets those words first. Four of them never had a line
   here at all and rendered as raw keys on the live card: `wechat_chat`
   (¥3,824 in the reported window) and `pickup` (¥220) were visible, and
   `wholesale` and `other` were one quiet month away from being.

   `manual` IS `Manual · 手动`, AND IT DELIBERATELY DIFFERS FROM THE ORDERS
   LIST. **DECIDED BY ASH, 2026-09-13**, from the Chinese card with the row
   circled: *"翻译有点小问题，manual，中文：手动、人工"*. Of the two words he
   named, `手动` is the one already live — and live for THIS COLUMN rather than
   near it: `CU_CHAN_OPTS` (08-customers.js) is a channel filter over
   `retail_orders.channel` and offers `['manual', 'Manual', '手动']`, and
   `DASH_CHAN_SHORT` (03-dashboard.js) names the channel on an order the same
   way. `人工` is live too, but only inside verification sentences
   (`请人工核对`), never as the name of a channel, so using it here would be
   minting a label out of a fragment.

   **THIS FILE BRIEFLY SAID `Unattributed · 未归属` AND THAT WAS MY ERROR, not a
   ruling being overturned.** `ordChannelLabel` (04-orders.js) calls it that,
   and its reasoning is sound on its own terms — `manual` IS the legacy value,
   no longer selectable — but it is ONE screen against three, and the card an
   owner reads his month's takings on is not the place to try a new word. The
   orders list is left exactly as it is: aligning it is a change to a screen
   nobody reported, and it is Ash's to ask for.

   SO THE TWO SCREENS NOW DISAGREE ABOUT ONE VALUE, KNOWINGLY. That is recorded
   here rather than left to be discovered, and a case pins both sides so a
   later session reads this note instead of "fixing" one into the other.

   `Gzgrocery` HAS NO SECOND HALF, and that is how it is live in BOTH sources:
   the partner's name is the same word in either language, so `csName` carries
   it as a bare string rather than a pair. Pairing it with a transliteration
   here would be composing one.

   AN UNKNOWN KEY RENDERS AS ITSELF. A channel that starts writing before it is
   named here gets a line carrying its own key rather than being folded into
   somebody else's or dropped — the same fallback `payLabel` uses on Reports.
   The row is inside a total that counted it, so it has to appear; an internal
   word on screen is a smaller wrong than money with no line under it. That
   fallback is what put `wechat_chat` and `pickup` on screen to be asked about,
   which is the behaviour working rather than failing. */
function finChannelLabel(key) {
  return ({
    // Platforms and storefronts — csName (01-core.js).
    wechat:      cuT('WeChat', '微信'),
    web:         cuT('Web shop', '网页商店'),
    meituan:     cuT('Meituan', '美团'),
    eleme:       cuT('Eleme', '饿了么'),
    gzgrocery:   'Gzgrocery',
    // A sale that originated at a physical shop — the till or that shop's QR
    // menu (§14, §44). Both sources agree on this pair.
    shop:        cuT('Shop', '门店'),
    // The New order form's origins — ordChannelLabel (04-orders.js).
    pickup:      cuT('Pick up', '到店自取'),
    wechat_chat: cuT('WeChat message', '微信消息'),
    wholesale:   cuT('Wholesale', '批发'),
    other:       cuT('Other', '其他'),
    manual:      cuT('Manual', '手动'),
  })[key] || key;
}

/* ── The revenue disclosure ────────────────────────────────────────────────
   The channels behind the top line, heaviest first, as the server ordered them.

   PLAIN ROWS, NOT CONTROLS, AND THAT IS A DECISION RATHER THAN AN UNFINISHED
   ONE. The expense lines below open because there is an endpoint behind each of
   them that lists the ledger rows making it up; there is no such read for a
   channel, and this file's own rule — stated on the expenses row and again on
   the purchase-order row — is that a chevron which opens onto nothing is a
   control that lies. So these carry no chevron, take no focus and offer no
   hover cue: they render exactly as a breakdown line rendered before any of
   them could be opened. If the orders behind a channel are ever wanted, they
   get an endpoint first and a chevron second.

   THE FIGURES ARE `finMoney`, whole yuan, like every other line of the
   staircase and of the expense breakdown beside it. A breakdown line is one of
   §36's figures; only what opens BELOW one renders to the fen.

   THE MARKUP IS BUILT HERE RATHER THAN THROUGH `finRow`, and that is about
   colour rather than taste. `finRow` stamps `.fin-input` on every row it makes,
   and `#tab-finance .fin-row.fin-input .fin-lbl` outweighs
   `#tab-finance .fin-breakdown .fin-lbl` on specificity — so a channel line
   drawn that way came out in `--td-text` while the expense lines eight pixels
   below it sat in `--td-text2`. Two breakdowns on one card in two different
   greys, with nothing meant by the difference. `finBreakdown` builds its own
   rows for the same reason; this follows it, down to the empty `.fin-sign`
   span, which is the middle of the three grid columns the figures line up on
   and holds the column open with nothing in it.

   ── `data-no-i18n` IS LOAD-BEARING, AND IT IS NOT DECORATION ──────────────
   **Without it, three of these rows VANISH in Chinese and the card silently
   stops adding up.** Reported from the live screen: 营收 ¥123,384 over four
   channels totalling ¥101,498, against the same window in English showing
   seven channels that summed to the figure exactly. The ¥21,886 difference was
   Gzgrocery, wechat_chat and pickup — precisely the three labels with no
   Chinese in them.

   THE CAUSE IS THE i18n WALKER'S BLOCK-PAIR HEURISTIC (`tagBlockPair`,
   `10-extras.js`), and it was doing what it was written to do. Help text in
   this product is often authored as two stacked siblings, an all-English
   <div> next to an all-Chinese one; the walker finds that shape, stamps
   `data-lang-block="en"` / `"cn"` on the pair, and a rule injected in
   `retail-admin.html` hides the inactive side with `display:none!important`.
   In Chinese a `微信` row IS an all-Chinese div and the `Gzgrocery` row beside
   it IS an all-English one, so the walker read a list of channels as a column
   of translation pairs and hid every second one.

   THE EXPENSE BREAKDOWN NEVER HIT THIS, and the reason is worth knowing before
   anyone "tidies" it: `processBlocks` only ever offers `div, p` to the pairing
   rule, and every line of that breakdown is a <button>. Its immunity is a side
   effect of being a control, not a property of breakdowns — so the day one of
   those becomes a plain row, as these are, it needs this attribute too.

   IT COSTS NOTHING HERE because there is nothing in this subtree for the walker
   to do: `finChannelLabel` has already chosen the language through `cuT`, and
   `finRender` re-runs on `onLangChange`, so the labels follow the toggle by
   being redrawn rather than by being rewritten in place. That is the same
   reason `data-no-i18n` sits on the dashboard greeting — text assembled
   language-aware in JS is text the walker must keep its hands off. */
/* ── The sentence under Revenue (§182) ──────────────────────────────────────
   WHY THE ROW NEEDS ONE AT ALL. Reports shows a revenue figure for the same
   window that does not match this one, and a reader with both open has no way
   to tell which is wrong — the honest answer being neither. The two screens ask
   different questions: this row is what customers paid ON ORDERS, recognised at
   the sale; the Reports card is CASH RECEIVED, which books a wallet top-up on
   the day the money lands and values gzgrocery off the stock ledger. Before
   §182 that difference was undocumented on either screen, and the first person
   to notice it reasonably assumed a bug.

   IT NAMES THE HALF A READER CANNOT SEE. The channel lines above already say
   where the money came from; what they cannot show is WHEN a wallet yuan was
   counted, because the timing is the whole of the disagreement with Reports.
   So the sentence spends its words on that and not on restating the breakdown.

   UNCONDITIONAL, like the Transactions tile's pointer and unlike
   `finCoverageNote` above. It is not one of §1.12's states and does not qualify
   a shortfall: it is true at ¥0 and true at ¥144,854, because what it describes
   is which question the row answers, and that does not move with the figure.

   `.td-notrec` IS THE HOUSE REMARK TREATMENT, not a state marker, whatever its
   name suggests — its own CSS note calls it "the same weight as any other true
   remark about the number above it", which is exactly this. `finCoverageNote`
   already uses it for a remark that qualifies a presence rather than explaining
   an absence, so this is the second such use and not a new liberty.

   THE CHINESE IS COMPOSED (Rule 4, standing delegation) and declared in
   docs/tacet-delivery-vocabulary.md v1.138 with the live candidates weighed
   against it. `仅计` is lifted from `仅计成本`, `计入` / `不计入` from the six
   live cost and stock lines that use the pair, and `储值` from `储值消费`, the
   Sales summary's own word for store credit spent — so the row says "spent"
   with the character the screen next door already spends it with. */
function finRevNote() {
  return `<p class="td-notrec">${escapeHtml(cuT(
    'Orders only — wallet money counts when spent, not when topped up.',
    '仅计订单 —— 储值在消费时计入，充值时不计入。'
  ))}</p>`;
}

function finRevBreakdown(rows) {
  if (!rows || !rows.length) return '';
  return '<div class="fin-breakdown" data-no-i18n>'
    + rows.map(r => '<div class="fin-row">'
        + `<span class="fin-lbl">${escapeHtml(finChannelLabel(r.channel))}</span>`
        + '<span class="fin-sign"></span>'
        + `<span class="fin-fig">${escapeHtml(finMoney(r.amount))}</span>`
        + '</div>').join('')
    + '</div>';
}

/** The operating-expense disclosure. Open by default.

    EACH LINE IS NOW A CONTROL. `all` is the unfiltered breakdown array, so a row
    can name itself by its index in the payload rather than by its category text
    — which is free text, may be null, and is not an identity. */
function finBreakdown(rows, all) {
  if (!rows || !rows.length) return '';
  // The set is passed whole so the collision rule can see it: two categories
  // that read alike in this language both render in full rather than drawing
  // two lines nobody can tell apart.
  const labels = finCatLabels(rows.map(r => r.category));
  const list = all || rows;
  return '<div class="fin-breakdown">' + rows.map(r => {
    // A row whose category was never typed keeps its own line and gets the
    // §1.12 seventh-state word rather than an invented bucket name: §36 records
    // that Finance stores category text raw and un-normalised, so a label
    // minted here would be a second wrong name on a known-dirty column.
    const label = r.category
      ? (labels.get(r.category) || finCatLabel(r.category))
      : cuT('Not recorded', '未记录');
    const i = list.indexOf(r);
    const open = !!FIN_CAT && FIN_CAT.i === i;
    return `<button type="button" class="fin-row fin-cat${open ? ' on' : ''}" `
      + `aria-expanded="${open ? 'true' : 'false'}" onclick="finCatOpen(${i})">`
      + `<span class="fin-lbl"><span class="fin-chev">&#9656;</span>${escapeHtml(label)}</span>`
      + '<span class="fin-sign"></span>'
      + `<span class="fin-fig">${escapeHtml(finMoney(r.amount))}</span>`
      + '</button>'
      + (open ? `<div class="fin-catrows" data-no-i18n>${finCatBody()}</div>` : '');
  }).join('') + '</div>';
}

/* ── Opening one ────────────────────────────────────────────────────────────
   A SECOND READ, not a slice of the payload already here. The summary carries
   one line per category and must keep doing so — putting every expense row of
   the window inside it would grow the first screen an operator sees in order to
   serve a click most of them never make.

   THE WINDOW COMES FROM `FIN_DATA.window`, NEVER FROM THE DATE INPUTS. The
   inputs can hold a range that has been typed and not applied; the figures on
   screen belong to the window that was. Reading the inputs here would open a
   ¥27,081 line onto rows from a different month, which is precisely the class of
   quiet wrongness this feature exists to remove.

   A CLICK ON THE OPEN ROW SHUTS IT. One control, two directions, the same
   gesture the receipt viewer on Approvals uses.

   The in-flight guard is that viewer's too: a second click on a second category
   while the first is still loading must not have the first one's response paint
   under it. The index is checked on arrival and a stale answer is dropped. */
window.finCatOpen = function finCatOpen(i) {
  const all = (FIN_DATA && FIN_DATA.expense_breakdown) || [];
  const row = all[Number(i)];
  if (!row) return;
  // AN OPEN PURCHASE-ORDER ROW BELONGS TO THE CATEGORY IT IS INSIDE. Closing
  // that category, or opening another, takes the row off the screen — so the
  // level below it is dropped with it rather than left pointing at a ledger row
  // nothing is drawing.
  if (FIN_CAT && FIN_CAT.i === Number(i)) { FIN_CAT = null; FIN_POL = null; finRender(); return; }

  FIN_POL = null;
  FIN_CAT = { i: Number(i), rows: null, err: '' };
  finRender();

  const w = (FIN_DATA && FIN_DATA.window) || {};
  // An EMPTY `category` addresses the uncategorised bucket, which is the row
  // rendering as "Not recorded". The server reads an empty parameter as that
  // bucket and does not trim it — see the endpoint's own note on why.
  const q = `from=${encodeURIComponent(w.from || '')}&to=${encodeURIComponent(w.to || '')}`
    + `&category=${encodeURIComponent(row.category || '')}`;
  api('/api/retail-admin/finance/summary/category?' + q).then((j) => {
    if (!FIN_CAT || FIN_CAT.i !== Number(i)) return;   // a later click already won
    FIN_CAT.rows = (j.data && j.data.rows) || [];
    finRender();
  }).catch((e) => {
    if (!FIN_CAT || FIN_CAT.i !== Number(i)) return;
    // The screen's own failure sentence, reused rather than a second one minted
    // for a smaller read. It says the true thing — a Finance read did not come
    // back — and a category-specific variant would be a new pair saying it again.
    FIN_CAT.err = cuT('Could not load Finance.', '财务数据加载失败。');
    finRender();
  });
};

function finRender() {
  const host = document.getElementById('fin-stair');
  if (!host || !FIN_DATA) return;
  const d = FIN_DATA;

  const revLabel = cuT('Revenue', '营收');
  const expLabel = cuT('Operating expenses', '营业费用');
  // The disclosure shows the OPERATING half only, because it is the disclosure
  // ON the operating-expenses row: a line inside it that the figure above did
  // not include would be a breakdown that does not add up to its own total.
  const breakdown = finBreakdown(finOperating(d.expense_breakdown), d.expense_breakdown);
  const excluded = finNonOperating(d.expense_breakdown);
  // The channels behind the top line. Empty on a period with no paid orders,
  // and on a payload from a server that predates the field — in both cases the
  // row falls back to the plain one it has always been, which is the same rule
  // the expenses row below follows and for the same reason.
  const revBreakdown = finRevBreakdown(d.revenue_breakdown);

  host.innerHTML = '<div class="fin-card"><div class="fin-body">'
    // Line 1 — Revenue. Every channel the order record carries, gzgrocery
    // included, wallet top-ups excluded (§36).
    //
    // A DISCLOSURE, LIKE THE EXPENSES ROW, AND OPEN LIKE IT. The two are the
    // card's only figures with something behind them, they are the same kind of
    // thing — a total and the lines that make it up — and a reader who found
    // one of them openable and the other not would have to learn which is
    // which. Open by default for the reason that one is: the breakdown is the
    // answer to the question the total raises, and a card that hides it behind
    // a click asks the operator to guess that there is anything there.
    //
    // NO MINUS IN THE SIGN COLUMN. Revenue is the step the staircase starts
    // from, not a deduction from anything above it, so the `<span class=
    // "fin-sign">` stays empty exactly as `finRow` would have left it.
    //
    // A PLAIN ROW WHEN THERE IS NOTHING TO OPEN — a period with no paid orders
    // has no channels, and a chevron over an empty list is the control that
    // lies about having content behind it.
    + (revBreakdown
      ? '<details class="fin-exp" open><summary>'
        + `<span class="fin-lbl"><span class="fin-chev">&#9656;</span>${escapeHtml(revLabel)}</span>`
        + '<span class="fin-sign"></span>'
        + `<span class="fin-fig">${escapeHtml(finMoney(d.revenue))}</span>`
        + `</summary>${revBreakdown}</details>`
      : finRow(revLabel, finMoney(d.revenue)))
    + finRevNote()
    // Tax collected (audit I-03), and ONLY where a shop has charged some: the
    // block is null otherwise, so nothing about this screen changes for a shop
    // that charges none. It sits with revenue because that is
    // where it lives — on a shop that adds tax at checkout the customer paid it
    // to the shop and the shop owes it on, so it is inside the figure above and
    // is not the merchant's money. Net of what has been handed back with
    // refunds, which is the number that eventually gets remitted.
    //
    // NO MINUS SIGN, deliberately. The staircase's signs are arithmetic — each
    // one is a step from the line above to the line below — and this is not a
    // step: net is still revenue minus operating expenses, and nothing here
    // subtracts the tax. A "−" would make the column stop adding up, which §36
    // treats as the worst thing a figure on this card can do. It is a note
    // about the line above it, and reads as one.
    //
    // IT STAYS OUTSIDE REVENUE'S DISCLOSURE, which now sits between the two.
    // Inside, it would be a line in a list whose whole contract is that the
    // lines add up to the figure above them — and this one does not, because it
    // is already inside it. It would also close with the disclosure, and §36 is
    // plain that a report showing revenue without showing this is one somebody
    // pays their own tax out of. So it stays a sibling of the revenue row: under
    // the channels when they are open, directly under revenue when they are
    // not, and never hidden by either.
    + (d.tax
      ? finRow(cuT('of which tax', '其中税费'), finMoney(d.tax.net))
      : '')
    // Lines 2 and 3 — the two the mockup could not have, and the two §56 as
    // amended 2026-09-14 lets carry a figure. Three states, decided by the
    // server and never re-derived here: no costed line at all keeps the
    // treatment these rows have always had, some coverage shows the figures
    // with the shortfall stated under them, and full coverage shows the figures
    // with nothing under them at all.
    + finCostRows(d)
    // The landing — what makes the card read as steps rather than five rows.
    + '<div class="fin-tread"></div>'
    // Line 4 — the hand-entered half. A disclosure when there is something to
    // disclose, a plain row when there is not: a chevron that opens onto
    // nothing is a control that lies about having content behind it.
    + (breakdown
      ? '<details class="fin-exp" open><summary>'
        + `<span class="fin-lbl"><span class="fin-chev">&#9656;</span>${escapeHtml(expLabel)}</span>`
        + '<span class="fin-sign">−</span>'
        + `<span class="fin-fig">${escapeHtml(finMoney(d.operating_expenses))}</span>`
        + `</summary>${breakdown}</details>`
      : finRow(expLabel, finMoney(d.operating_expenses), { less: true }))
    + '</div>'
    // Line 5 — the terminus, on the card's own bottom edge. NET, never
    // Contribution: nothing on this screen is filtered to a location, so
    // business-wide costs have been taken off in full. When the expense
    // location column lands, a filtered view says Contribution here and
    // carries the excludedCosts line beneath it; both pairs are already locked.
    + '<div class="fin-terminus"><div class="fin-row">'
    + `<span class="fin-lbl">${escapeHtml(cuT('Net', '净额'))}</span>`
    + '<span class="fin-sign"></span>'
    + `<span class="fin-fig">${escapeHtml(finMoney(d.net))}</span>`
    + '</div></div></div>'
    // ── What left the account and is not a cost of running the shop (§87) ──
    // BELOW the card, never inside the staircase, and with NO minus sign. The
    // staircase's signs are arithmetic and this subtracts from nothing: an
    // owner's drawing is not a business expense, so it is not taken off net —
    // showing it as a step would put it back into the profit line by another
    // road, which is the thing the flag exists to stop.
    //
    // **AND IT IS SHOWN RATHER THAN DROPPED**, which is the other half of the
    // same rule. Money that vanishes out of a total with nothing on screen to
    // say so is the defect this whole feature is about, wearing the opposite
    // clothes.
    //
    // ABSENT AT ZERO, which is every tenant until one marks a category. There is
    // nothing excluded, so a row reading ¥0.00 would assert a fact about money
    // that does not exist — and §1.12 keeps a screen free of rows that only ever
    // say nothing happened.
    + (d.non_operating_expenses > 0
      ? '<div class="fin-excl">'
        + (excluded.length
          ? '<details class="fin-exp"><summary>'
            + `<span class="fin-lbl"><span class="fin-chev">&#9656;</span>${escapeHtml(cuT('Not an operating expense', '不计入营业费用'))}</span>`
            + '<span class="fin-sign"></span>'
            + `<span class="fin-fig">${escapeHtml(finMoney(d.non_operating_expenses))}</span>`
            + `</summary>${finBreakdown(excluded, d.expense_breakdown)}</details>`
          : finRow(cuT('Not an operating expense', '不计入营业费用'), finMoney(d.non_operating_expenses)))
        + `<p class="fin-excl-note">${escapeHtml(cuT(
            'Recorded, and not counted in the figures above.',
            '已记录，未计入上方数字。'))}</p>`
        + '</div>'
      : '');
}

// ── Load ───────────────────────────────────────────────────────────────────
async function finLoad(opts) {
  const host = document.getElementById('fin-stair');
  if (!host) return;
  const from = (document.getElementById('fin-from') || {}).value;
  const to = (document.getElementById('fin-to') || {}).value;
  finSyncRangeButtons(from, to);
  finRangeLabel();

  // §1.12: the skeleton is for a REAL load only. On a refresh the current card
  // stays up — a poller or a re-read never puts a placeholder over data that is
  // already on screen.
  if (!FIN_DATA) host.innerHTML = '<div class="fin-skel"></div>';

  // THE OPEN CATEGORY IS DROPPED BEFORE THE READ, not after it. It is an index
  // into a breakdown that is about to be replaced: a window with fewer
  // categories would leave the index pointing at a different one, and the rows
  // already fetched belong to the window being left. Nothing here is worth
  // preserving across a window change — the operator asked a new question.
  FIN_CAT = null;
  FIN_POL = null;

  try {
    const j = await api(`/api/retail-admin/finance/summary?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}`);
    FIN_DATA = j.data;
    finRender();
    // ONE WINDOW GOVERNS BOTH SUB-VIEWS. The range bar is shared, so a new
    // window has to reach the ledger too — otherwise switching to Transactions
    // after an Apply would show rows from the previous window with the new one
    // echoed on the title line, which is the quietest kind of wrong. Only when
    // Transactions has actually been opened: an operator who never leaves
    // Summary never pays for a second query.
    if (FIN_TX_SEEN) finTxLoad();
  } catch (e) {
    // §1.12: a failed read renders where the operator is looking and stays
    // until it is resolved. It never becomes a toast, and a card that failed
    // never renders as an empty one — absence must mean empty, never broken.
    // On a refresh failure the existing figures stay put and the banner sits
    // above them, so the operator is not left reading stale numbers unwarned.
    const banner = `<div class="fin-error">${escapeHtml(cuT('Could not load Finance.', '财务数据加载失败。'))} <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
    if (FIN_DATA) { host.insertAdjacentHTML('afterbegin', banner); }
    else { host.innerHTML = banner; }
  }
}

// First visit builds the window and pulls; later visits repaint what is loaded.
// Nothing is fetched at boot — Finance is a screen an operator opens, not a
// pulse the front door needs.
// Published on `window` rather than declared bare, which is this directory's
// convention for a tab entry point (window.puInit, window.rcpInit,
// window.wasteInit) — the rail's onclick is the only caller, so a bare
// declaration reads as dead code to anything that lints one file at a time.
window.finInit = function finInit() {
  if (FIN_SEEN) { finRangeLabel(); return; }
  FIN_SEEN = true;
  const seg = document.getElementById('fin-range-seg');
  if (seg && !seg._wired) {
    seg._wired = true;
    seg.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-range]');
      if (b) finSetRange(b.dataset.range);
    });
  }
  // Language flips repaint the card in place: every string in this file
  // resolves through cuT at render, so a re-render IS the translation. The
  // static markup in the section is handled by the app's own i18n walker.
  //
  // Registered HERE and not at file scope, the same as 02-settings-ops.js does
  // and for the same reason: onLangChange and cuT are defined by an inline
  // <script> at retail-admin.html:12561, which is BELOW this file's own script
  // tag. At file scope `window.onLangChange` is still undefined, so a guarded
  // top-level call silently never registers and the card would freeze in
  // whichever language it first rendered.
  if (window.onLangChange) {
    window.onLangChange(() => { finRangeLabel(); if (FIN_DATA) finRender(); });
  }
  finSetRange('30');
};

/* ══════════════════════════════════════════════════════════════════════════
   TRANSACTIONS — the ledger of typed rows.

   §36 v4.118: this lists `income_entries` and `expense_entries` and does NOT
   list orders. Summary is the totals; Transactions is what was entered by
   hand. Layout from reference/finance-transactions-mockup.html, with the two
   approved departures noted at the markup and repeated where they bite.

   Every string below is an EN/CN pair from the Finance table of
   docs/tacet-delivery-vocabulary.md (v1.10). None is composed here.
   ══════════════════════════════════════════════════════════════════════════ */

let FIN_TX = null;          // the last payload
let FIN_TX_SEEN = false;    // has this sub-view ever been pulled
let FIN_TX_DIR = 'all';     // 'all' | 'in' | 'out' — the chip filter
// The category labels for the rows on screen, built ONCE per render rather than
// per row — the collision rule needs the whole set, and asking for it inside the
// row would rebuild it for every line.
let FIN_TX_CATLABEL = null;

/* Sub-view switching. Both panes live in the page; one is `hidden` at a time.
   The range bar is SHARED — one window governs both sub-views, so switching
   never silently re-scopes what the operator was reading. */
window.finShow = function finShow(which) {
  const isTx = which === 'transactions';
  // THREE PANES SINCE §87, and the flags are written positively rather than as
  // `!isTx`: with two panes a negation was the same thing as naming the other
  // one, and with three it is the bug where opening Categories leaves Summary
  // on screen underneath it.
  const isCats = which === 'categories';
  // FOUR PANES SINCE §87 step three. Each flag is written positively for the
  // reason the third one was: `!isTx` was the same thing as naming the other
  // pane while there were two, and every pane added after that turns a negation
  // into the bug where opening one leaves another on screen underneath it.
  const isApr = which === 'approvals';
  document.querySelectorAll('#fin-subviews button')
    .forEach(b => b.classList.toggle('on', b.dataset.sub === which));
  const stair = document.getElementById('fin-stair');
  const tx = document.getElementById('fin-tx');
  const cats = document.getElementById('fin-cats');
  const apr = document.getElementById('fin-apr');
  if (stair) stair.hidden = isTx || isCats || isApr;
  if (tx) tx.hidden = !isTx;
  if (cats) cats.hidden = !isCats;
  if (apr) apr.hidden = !isApr;
  // The range bar belongs to the two views that read a window. The category
  // list is the tenant's own vocabulary and has no date about it — leaving the
  // bar up would offer a control that changes nothing on the screen under it.
  //
  // A QUEUE HAS NO WINDOW EITHER, and for a sharper reason than the category
  // list has: what is waiting to be approved is waiting NOW, and a bar reading
  // "30 days" over it would suggest there are older claims it is hiding. The
  // server sends the queue whole, oldest first, and the screen shows the queue.
  const bar = document.querySelector('.fin-rangebar');
  if (bar) bar.hidden = isCats || isApr;
  /* THE ECHO GOES WITH THE BAR, and leaving it behind made the bar's own
     argument false. Hiding the controls while `Aug 12 – Sep 10 · 30 days`
     stayed in the page head is the worse half of the thing the paragraph above
     refuses: the queue was captioned with a window it does not have, and the
     operator could not even reach the control to check. §1.17 — a page may not
     claim something that is not true of what is under it. */
  const echo = document.getElementById('fin-range');
  if (echo) echo.hidden = isCats || isApr;
  if (isCats && !FIN_CATS_SEEN) { FIN_CATS_SEEN = true; finCatsLoad(); }
  // A payload the dot poller already pulled paints immediately; the fetch is
  // only for the first visit that beat it.
  if (isApr) {
    FIN_APR_SEEN = true;
    if (FIN_APR) {
      // finAprLoad's own render call is inside ITS try/catch; this one is not,
      // because it runs straight from the click handler with no fetch around
      // it to catch inside. Unguarded, a throw here left the tab open, active,
      // and completely blank — no skeleton (this path never shows one) and no
      // banner (nothing catches it) — the one failure mode worse than an error
      // message: an operator with no idea anything went wrong at all.
      try { finAprRender(); }
      catch (e) {
        const host = document.getElementById('fin-apr-list');
        if (host) host.innerHTML = `<div class="fin-error">${escapeHtml(cuT('Could not load the queue.', '无法加载列表。'))} <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
      }
    } else finAprLoad();
  }
  // The CTA belongs to Transactions, not to the surface: Summary types nothing.
  // Its capability gate is `data-cap`, applied by applyCapGates as a display
  // rule, so the two compose — hidden here by sub-view, display:none there by
  // permission, and an operator without finance:record never sees it either way.
  const cta = document.getElementById('fin-tx-new');
  if (cta) cta.hidden = !isTx;
  if (isTx && !FIN_TX_SEEN) { FIN_TX_SEEN = true; finTxLoad(); }
};

/* The money column. Out is rendered with a minus, in with a plus — the sign is
   the direction restated, and neither is coloured: §1.10, colour encodes state
   and money out is not an error. "A down delta renders in Graphite, never
   Brick." */
function finTxAmount(r) {
  // §269. A return is money out stored negative — money that came back — so it
  // reads `+¥19` on the money-out side rather than `−¥-19`.
  if (r.source === 'return') return '+' + finMoney(Math.abs(Number(r.amount) || 0));
  return (r.kind === 'out' ? '−' : '+') + finMoney(r.amount);
}

/* §269 — THE RETURN REASONS, the five Purchasing's receive screen already
   ships (16-purchasing.js returnCell), in the same order and the same words,
   so "what do we keep sending back" is one list across both kinds of purchase. */
const FIN_RETURN_REASONS = [
  ['wrong_item', 'Wrong item', '错货'],
  ['quality', 'Quality', '质量问题'],
  ['expired', 'Expired', '过期'],
  ['over_delivery', 'Over-delivered', '多送'],
  ['not_needed', 'Not needed', '无需要'],
];
function finReturnReason(v) {
  const r = FIN_RETURN_REASONS.find(x => x[0] === v);
  return r ? cuT(r[1], r[2]) : '';
}
/* What is still left to return on a row, in yuan. */
function finTxReturnLeft(r) {
  return Math.round((Number(r.amount) - Number(r.returned || 0)) * 100) / 100;
}

/* One row. A PO-derived row differs in four visible ways, and each is one of
   §36's requirements rather than decoration: it is tinted, it carries the
   Posted-by-Purchasing mark, its action opens the purchase order instead of an
   edit form, and it has no edit affordance at all.

   THE REFUSAL IS VISIBLE, NOT MERELY ENFORCED. §36: "They would be uneditable
   for no visible reason… The row explains its own constraint instead of merely
   enforcing it." `routes/finance.js` already refuses edit and delete on any row
   carrying a `po_id`; a screen that offered Edit and then failed would be the
   fault that rule names. */
/* The subject, in one language WHEN IT IS A CATEGORY and verbatim otherwise.
   A manual row's subject is its category when it has one and its typed note
   when it has not — and a note is the operator's own sentence, never a glued
   pair, so splitting one would cut a sentence in half at its first Chinese
   character. The test is identity with the row's own category, not a guess
   about the text. */
function finTxSubject(r) {
  const subj = r.subject || '';
  if (!r.category || subj !== r.category) return subj;
  return (FIN_TX_CATLABEL && FIN_TX_CATLABEL.get(r.category)) || finCatLabel(r.category);
}

function finTxRow(r) {
  const po = r.source === 'po';
  /* §87 step three. THE SECOND KIND OF PROJECTION, and it gets the SAME
     treatment as the first for the same reason: a claim re-posts its ledger row
     on every decision, so an edit made here would be silently undone the next
     time somebody changed their mind about the claim. Tinted, marked, and no
     Edit — §36's "the row explains its own constraint instead of merely
     enforcing it", applied to the other document that owns rows in this table.

     §90 AMENDS THE "NO LINK OUT" NOTE THIS BLOCK USED TO CARRY, RATHER THAN
     LEAVING IT STANDING WRONG: the row now offers Void, requested by Ash off
     this exact screen — a claim posted by mistake had no way back except
     editing a row that would only be regenerated. Void is not Edit: it does not
     let a value be typed onto this row, it reverses the CLAIM's own decision
     (`finTxVoidClaim`, calling the claim's `/void` endpoint) and lets the same
     mechanism that deletes this row on rejection delete it here too. */
  const claim = r.source === 'claim';
  const fromCase = r.source === 'delay_case';
  const ret = r.source === 'return';
  // §36: the note vanishes ENTIRELY at one category. "It does not read '1
  // category'" — at one nothing was collapsed, so a note would assert a
  // breakdown that does not exist and send the operator looking for it.
  const hint = po && Number(r.categories) > 1
    ? `<span class="fin-tx-hint" data-lang-block>${escapeHtml(cuT(
        `Sum of ${r.categories} category subtotals`,
        `${r.categories} 个类别小计合计`))}</span>`
    : '';
  const mark = po
    ? `<span class="fin-tx-mark">${escapeHtml(cuT('Posted by Purchasing', '采购单自动记入'))}</span>`
    : claim
    /* WHOSE MONEY IT WAS is on the mark, not in a column of its own. It is the
       difference between a cost that is finished and one the shop still owes
       somebody, and the bookkeeper reading this row is exactly who needs it —
       but it applies to one row in a hundred, and a column that is empty on the
       other ninety-nine is what §1.12 refuses. */
    ? `<span class="fin-tx-mark">${escapeHtml(r.paid_by === 'employee'
        ? cuT('Staff claim · own money', '费用申请 · 个人支付')
        : cuT('Staff claim', '费用申请'))}</span>`
    /* §98 stage four. Marked like the other two projections, and with no Edit
       for the same reason — `finTxEdit` already gates on `=== 'manual'`, and
       the note there says it was written that way rather than as `!== 'po'`
       precisely so a THIRD kind of projection could not slip through the
       negation. It did not: this row was uneditable before this line existed,
       and the line only makes the row SAY so. */
    : fromCase
    ? `<span class="fin-tx-mark">${escapeHtml(cuT('Carrier claim', '承运商赔偿'))}</span>`
    /* §269. A return says it is one, why it went back, and — when an employee
       was refunded on a claim they had already been paid back for — that the
       money is with them until somebody marks it recovered. */
    : ret
    ? `<span class="fin-tx-mark">${escapeHtml([cuT('Return', '退货'), finReturnReason(r.reason)].filter(Boolean).join(' · '))}</span>`
      + (r.held_by_staff ? ` · <span class="fin-tx-mark">${escapeHtml(cuT('Owes the shop', '应退还店里'))}</span>` : '')
    : '';
  /* §269. On the row that was returned: how much went back. The numeral sits
     outside the pair, the house rule for a figure beside a word. */
  const returned = (r.source === 'manual' || claim) && Number(r.returned) > 0
    ? `<span class="fin-tx-mark">${escapeHtml(cuT('Returned', '退货'))} ${escapeHtml(finMoney(r.returned))}</span>`
    : '';
  /* WHO PUT THIS ROW IN THE BOOKS (§92). Reported by Ash off this screen: a
     ¥200 claim row and no way to see who had let it into the accounts.

     IT IS NOT THE NAME IN THE SUBJECT, and the two labels exist so nobody reads
     it as one. §87 put the SPENDER in the description — `Asher · personal` is
     who spent the money — while `created_by` has always meant who put the row
     in the books. On a claim those are two different people doing two different
     things, and one of them is exercising an authority: `Approved by` says so,
     `Entered by` says the other. A single label over both would flatten an
     approval into a piece of typing.

     A PO ROW IS NOT NAMED. It is a collapse of several ledger rows and there is
     no one person behind it — the read declines to pick one, and the row keeps
     Posted by Purchasing, which is the true answer.

     NOTHING RENDERS WHERE THE NAME DID NOT RESOLVE. A deleted account, or a row
     typed before anyone was recorded against it, gets no meta at all rather
     than a placeholder — §1.12 prefers an empty cell to an invented one, and
     the live pair `Someone · 未知` belongs to the approvals queue, where the
     name is the whole point of the column it sits in.

     ESCAPED, LIKE EVERY OTHER NAME ON THIS SCREEN. It is free text somebody
     typed into `tenant_users`. */
  const who = !po && r.recorded_by
    ? `<span class="fin-tx-who">${escapeHtml(claim
        ? cuT('Approved by ' + r.recorded_by, '审批人 ' + r.recorded_by)
        : cuT('Entered by ' + r.recorded_by, '录入人 ' + r.recorded_by))}</span>`
    : '';
  /* THE TYPED NOTE, WHEN THE SUBJECT SLOT IS ALREADY SHOWING THE CATEGORY
     INSTEAD OF IT. `finTxSubject` shows a manual row's category over its note
     when both exist — the note is not lost (`note` rides the row from
     `routes/finance-transactions.js` regardless), it simply has nowhere left
     to appear, which is exactly the gap Ash reported off this screen: a typed
     备注 that never showed anywhere. `!r.category` is skipped because in that
     case `finTxSubject` is already showing the note verbatim — printing it a
     second time here would duplicate the one line the row has. */
  const noteBadge = (r.note && r.category)
    ? `<span class="fin-tx-note">${escapeHtml(cuT('Note · ' + r.note, '备注 · ' + r.note))}</span>`
    : '';
  // The meta line is a `·`-joined list rather than a hand-built pair, so a
  // third part cannot reintroduce the separator bug a hand-built one invites.
  const meta = [mark, returned, hint, who, noteBadge].filter(Boolean);
  // The date is the PO's own, never `created_at` — the route never selects
  // created_at, so there is nothing here that could drift onto a row.
  return `<tr class="${po || claim || ret ? 'fin-tx-posted' : ''}">`
    + `<td class="fin-tx-date">${escapeHtml(finTxDay(r.date))}</td>`
    + `<td><span class="fin-tx-subj">${escapeHtml(finTxSubject(r))}</span>`
    + (meta.length ? `<span class="fin-tx-meta">${meta.join(' · ')}</span>` : '')
    // §146. Under the line that describes the claim, which is where the
    // approvals queue draws the same control.
    + finTxClaimFiling(r)
    + '</td>'
    + `<td>${escapeHtml(r.kind === 'out' ? cuT('Out', '出') : cuT('In', '进'))}</td>`
    + `<td class="fin-tx-num">${escapeHtml(finTxAmount(r))}</td>`
    // A PO row links OUT to Purchasing and offers no Edit — §36's visible
    // refusal, unchanged by the write half. A typed row gets Edit, and only when
    // the operator holds the pen: `can` is the client half of the same gate
    // cap-routes.js applies to the request.
    // A PO the opener cannot serve gets NO LINK rather than one that fails.
    // Both realms post to this ledger and share `purchase_orders`; Purchasing's
    // opener serves retail scope only. The row keeps its figure and its
    // Posted-by-Purchasing mark either way — §36 hides no money — and no new
    // string is minted to explain the absence, there being no locked pair for
    // one and Rule 4 forbidding composing it.
    //
    // A CLAIM ROW OFFERS VOID (§90), NOT EDIT, AND ONLY TO `expenses:cancel` —
    // a distinct capability from `finance:record`, because reversing somebody
    // else's approval is not the same power as typing a ledger row by hand.
    // HIDDEN ONCE SETTLED, for the same reason the server refuses the write:
    // the employee has already been paid back for this claim, and a control
    // that failed every time it was pressed is the fault §36 names.
    + '<td>' + (po
      ? (r.po_open === false ? ''
        : `<a class="fin-tx-act" href="#" onclick="finTxOpenPO(${Number(r.po_id)});return false">${escapeHtml(cuT('Open purchase order', '查看采购单'))}</a>`)
      /* §269. A RETURN IS DELETED, NEVER EDITED — its amount is capped by the
         row it returns, and deleting and recording it again keeps that cap in
         one place. Same pen as every typed row: `finance:record`. */
      : ret
      ? ((typeof can === 'function' && !can('finance:record')) ? ''
        : `<a class="fin-tx-act" href="#" onclick="finTxDeleteReturn(${Number(r.id)});return false">${escapeHtml(cuT('Delete', '删除'))}</a>`)
      : claim
      ? [((typeof can === 'function' && can('expenses:cancel') && !r.settled && !(Number(r.returned) > 0))
          ? `<a class="fin-tx-act" href="#" onclick="finTxVoidClaim(${Number(r.claim_id)});return false">${escapeHtml(cuT('Void', '作废'))}</a>`
          : ''),
         finTxReturnLink(r)].filter(Boolean).join(' ')
      : (typeof can === 'function' && !can('finance:record')) ? ''
      : [`<a class="fin-tx-act" href="#" onclick="finTxEdit('${escapeHtml(String(r.kind))}',${Number(r.id)});return false">${escapeHtml(cuT('Edit', '编辑'))}</a>`,
         finTxReturnLink(r)].filter(Boolean).join(' '))
    + '</td>'
    + '</tr>';
}

/* §269 — RETURN, on a money-out row bought outside a purchase order: a typed
   row or a claim. Not on a PO row (Purchasing's receive screen returns those,
   and takes the units off stock too), not on money in, not on a return, and
   gone once everything has gone back. `finance:record`, like Edit. */
function finTxReturnLink(r) {
  if (!r || r.kind !== 'out' || (r.source !== 'manual' && r.source !== 'claim')) return '';
  if (typeof can === 'function' && !can('finance:record')) return '';
  if (!(finTxReturnLeft(r) > 0)) return '';
  return `<a class="fin-tx-act" href="#" onclick="finTxReturn(${Number(r.id)});return false">${escapeHtml(cuT('Return', '退货'))}</a>`;
}

/* §269 — RECORD A RETURN. A second row on the date the money came back; the
   row it returns is never touched. The amount starts at everything still left,
   which is the common case (the whole thing went back), and the server refuses
   more than that. The reason is required, the same five Purchasing uses. */
window.finTxReturn = async function finTxReturn(id) {
  if (!FIN_TX || typeof askCustom !== 'function') return;
  const row = FIN_TX.rows.find(r => r.kind === 'out' && String(r.id) === String(id));
  if (!row) return;
  const left = finTxReturnLeft(row);
  const body = '<h3 class="tdlg-title">' + escapeHtml(cuT('Return', '退货')) + ' · ' + escapeHtml(finTxSubject(row)) + '</h3>'
    + '<div class="tdlg-field"><label for="fin-rt-date">' + escapeHtml(cuT('Date', '日期')) + '</label>'
    + `<input type="date" id="fin-rt-date" value="${escapeHtml(tdToday())}"></div>`
    + '<div class="tdlg-field"><label for="fin-rt-amount">' + escapeHtml(cuT('Amount', '金额')) + '</label>'
    + `<input type="number" id="fin-rt-amount" min="0" max="${left}" step="0.01" inputmode="decimal" value="${left}"></div>`
    + '<div class="tdlg-field"><label for="fin-rt-reason">' + escapeHtml(cuT('Why?', '原因？')) + '</label>'
    + '<select id="fin-rt-reason"><option value="">' + escapeHtml(cuT('Why?', '原因？')) + '</option>'
    + FIN_RETURN_REASONS.map(x => `<option value="${x[0]}">${escapeHtml(cuT(x[1], x[2]))}</option>`).join('')
    + '</select></div>'
    + '<div class="tdlg-field"><label for="fin-rt-note">' + escapeHtml(cuT('Note', '备注')) + '</label>'
    + '<input type="text" id="fin-rt-note"></div>'
    + '<p class="fin-modal-err" id="fin-rt-err" data-no-i18n hidden></p>';
  const foot = '<button type="button" class="tdlg-btn tdlg-btn--ghost" data-cancel>' + escapeHtml(cuT('Cancel', '取消')) + '</button>'
    + '<button type="button" class="tdlg-btn tdlg-btn--primary" data-submit>' + escapeHtml(cuT('Save', '保存')) + '</button>';
  const { scrim, closer, ready } = askCustom('tdlg-neutral', body, foot, '#fin-rt-amount');
  scrim.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => closer(false)));
  const save = scrim.querySelector('[data-submit]');
  const err = (m) => { const el = scrim.querySelector('#fin-rt-err'); if (el) { el.textContent = m || ''; el.hidden = !m; } };
  save.addEventListener('click', async () => {
    const val = (sel) => (scrim.querySelector(sel) || {}).value;
    // Required HERE as well as on the server, so the one mistake everybody
    // makes (no reason picked) is caught before a round trip. The words are
    // Purchasing's own for the same miss.
    if (!val('#fin-rt-reason')) { err(cuT('Pick a reason for the return', '请选择退货原因')); return; }
    save.disabled = true;
    try {
      await api(`/api/retail-admin/finance/transactions/out/${Number(row.id)}/return`, {
        method: 'POST',
        body: { date: val('#fin-rt-date'), amount: val('#fin-rt-amount'),
                reason: val('#fin-rt-reason'), note: val('#fin-rt-note') },
      });
      closer(true);
    } catch (e) {
      save.disabled = false;
      err(e.message);
    }
  });
  if (!(await ready)) return;
  FIN_TX = null; FIN_DATA = null;            // the ledger and the staircase
  FIN_APR = null; FIN_APR_SEEN = false;      // the owed block, on the other sub-view
  await finTxLoad();
  if (window.toast) toast(cuT('Saved', '已保存'));
};

/* §269 — UNDO A RETURN. Its own Delete, with the house confirm; the server
   takes the row out without a recycle copy (see the route for why). */
window.finTxDeleteReturn = async function finTxDeleteReturn(id) {
  if (!id || typeof askConfirm !== 'function') return;
  if (!(await askConfirm({
    title: cuT('Delete this transaction?', '删除这条交易记录？'),
    body: cuT('This removes the row from the ledger. This cannot be undone.',
              '此操作将从账本中移除该记录。此操作无法撤销。'),
    confirmLabel: cuT('Delete', '删除'),
    danger: true,
  }))) return;
  try {
    await api(`/api/retail-admin/finance/transactions/out/${Number(id)}`, { method: 'DELETE' });
    FIN_TX = null; FIN_DATA = null;
    FIN_APR = null; FIN_APR_SEEN = false;
    await finTxLoad();
    if (window.toast) toast(cuT('Deleted', '已删除'));
  } catch (e) {
    if (window.toast) toast(e.message, 'err');
  }
};

/* §146 — WHERE A CLAIM ROW IS FILED, AS A PICKER ON THE ROW.

   **THE SAME CONTROL THE APPROVALS QUEUE DRAWS, IN THE SAME PLACE — under the
   line that describes the claim.** It shipped here as a `Change` link instead,
   on the reasoning that a ledger window can hold dozens of rows and a dropdown
   on each would turn a list somebody opened to READ into a wall of controls.
   Ash's answer, off the live screen: *"why is it not similar?"* — and the
   reasoning was wrong twice over. Claim rows are a small minority of a ledger
   (the rest are purchase orders and typed rows, neither of which draws one), so
   the wall never arrives; and one screen that hides a control behind a link
   while the other shows it is two products, not one, for the same act.

   **THE APPROVALS QUEUE IS NOT REACHABLE BY EVERYONE THIS IS FOR**, which is
   why the control is here at all: `/pending` is gated on `expenses:approve`,
   which the `bookkeeper` preset does not hold. Transactions is the finance
   screen the accountant DOES reach, and where Void already lives for the same
   reason (§90: requested by Ash off this screen).

   NOT OFFERED without either key, and not on a tenant with no categories —
   §36's empty-list rule. Void's own gate is unchanged and stays in the actions
   column: it is an action, and this is a field.

   THE CLASSES ARE THE APPROVAL ROW'S OWN, so the two screens cannot drift into
   two shapes for one control. */
function finTxClaimFiling(r) {
  if (!r || r.source !== 'claim' || !r.claim_id) return '';
  const canFile = typeof can === 'function'
    && (can('expenses:approve') || can('expenses:cancel'));
  if (!canFile) return '';
  const list = finTxExpenseCats();
  if (!list.length) return '';
  const labels = finCatLabels(list);
  const opts = list.map(c => `<option value="${escapeAttr(c)}"${c === r.category ? ' selected' : ''}>`
    + escapeHtml(labels.get(c) || finCatLabel(c)) + '</option>').join('');
  // The blank row only where there is nothing to show. On a filed claim it
  // would mean UNfiling a cost, which the server refuses (ERR.needCategory).
  const blank = r.category ? ''
    : `<option value="" selected>${escapeHtml(cuT('— pick a category —', '— 选择分类 —'))}</option>`;
  return '<span class="fin-apr-catwrap">'
    + `<select class="fin-apr-cat" onchange="finTxFileClaim(${Number(r.claim_id)}, this.value)">`
    + blank + opts + '</select></span>';
}

/* §146 — RE-FILING FROM THE LEDGER. **NO MONEY MOVES**: same claim, same sum,
   same date, same person, same approval record. What changes is which line of
   the category breakdown it sits on, and whether the tenant's non-operating flag
   reaches it — a cost filed under nothing counts as operating, so a private one
   quietly inflates that total.

   IT CALLS THE CLAIM'S ENDPOINT, NOT THIS SCREEN'S. `finTxSave` refuses a
   claim-linked row outright and is right to: the row is a projection, and a
   value typed onto it is lost the next time the claim re-posts. This changes the
   claim, and the ledger row is re-posted from it. Same reasoning as
   `finTxVoidClaim` one function up, and the same manage-its-own-toast shape. */
window.finTxFileClaim = async function finTxFileClaim(claimId, value) {
  const category = String(value == null ? '' : value);
  // The blank row is not a request to unfile a cost — the server refuses an
  // empty value for that reason — so choosing it does nothing at all.
  if (!category) { finTxRender(); return; }
  try {
    await api(`/api/retail-admin/staff-expenses/${Number(claimId)}/category`,
      { method: 'POST', body: { category } });
    FIN_TX = null;                           // force a real reload, not a repaint
    FIN_DATA = null;                         // the staircase drawn from the same ledger
    FIN_APR = null; FIN_APR_SEEN = false;    // and the claim's own row on the queue
    await finTxLoad();
    if (window.toast) toast(cuT('Saved', '已保存'));
  } catch (e) {
    if (window.toast) toast(e.message, 'err');
  }
};

/* §1.18 — the English surface renders US dates, and the year is omitted because
   every row is inside the selected window. */
function finTxDay(d) {
  if (!d) return '';
  // A ledger row's date is a CALENDAR day, which tdWhen reads literally — no
  // zone is applied to it, so a row dated the 1st cannot print as the 31st in
  // a negative-offset account and move money into the previous month.
  return tdWhen(d, 'date') || String(d);
}

/* The row action. Purchasing owns the record; Finance links to it. §36: "It is
   not editable here because it is not edited here, and the place it IS edited
   is one click away on the row itself."

   THE TAB SWITCH COMES FIRST, AND IS NOT CONDITIONAL ON THE OPENER. This read
   `if (window.puOpenPO) return puOpenPO(poId);` before the switch — and
   `window.puOpenPO` is ALWAYS defined, 16-purchasing.js being loaded on every
   page of this admin, so the `goTab` line beneath it was unreachable. The order
   was fetched and painted into a section that was not on screen, and the
   operator, still looking at Finance, saw the click do nothing at all.

   Both calls, in this order: the section the paint lands in has to be the
   section being looked at. `goTab` is the house shape for a cross-tab open
   (`paOpenRecipe` on Products does the same two lines). */
window.finTxOpenPO = function finTxOpenPO(poId) {
  const id = Number(poId);
  if (!id) return;
  try {
    if (typeof goTab === 'function') goTab('purchasing');
    if (typeof window.puOpenPO === 'function') puOpenPO(id);
  } catch (e) {
    console.error('[finance] could not open purchase order', id, e);
  }
};

function finTxRender() {
  const host = document.getElementById('fin-tx-list');
  if (!host || !FIN_TX) return;
  const d = FIN_TX;

  const t = document.getElementById('fin-tx-tiles');
  if (t) {
    t.innerHTML =
        `<div class="fin-tx-tile"><div class="fin-tx-k">${escapeHtml(cuT('Money out', '支出'))}</div>`
      + `<div class="fin-tx-v">${escapeHtml(finMoney(d.totals.out))}</div></div>`
      + `<div class="fin-tx-tile"><div class="fin-tx-k">${escapeHtml(cuT('Money in', '进账'))}</div>`
      + `<div class="fin-tx-v">${escapeHtml(finMoney(d.totals.in))}</div>`
      // ── WHERE THE SALES ARE ────────────────────────────────────────────
      // Reported by Ash off the live screen, 2026-09-10: money in reads ¥0
      // and the obvious reading is that the screen is broken. It is not —
      // §36's *Transactions reads typed rows, not the order record* keeps
      // orders off this list on purpose, and `income_entries` has had no row
      // since 31 July. **The number was right and the screen said nothing**,
      // which is the whole defect: a tile showing zero where a person expects
      // a month of sales has to say where the sales went, or every operator
      // who meets it re-derives the same wrong conclusion.
      //
      // IT IS A POINTER, NOT AN EMPTY STATE. §1.12's states are about data
      // that is absent; this line is true at ¥0 and true at ¥3,000, because
      // what it names — revenue living one tab away — does not change with
      // the figure. So it renders unconditionally and is not one of the
      // seven states.
      //
      // THE LABEL ABOVE IT IS UNTOUCHED. `Money in · 进账` is locked in the
      // Finance table, and Ruling 1 reserves 收入 for Income, so renaming
      // this tile was not available — the vocabulary amendment behind this
      // line records the alternatives and why this one was taken.
      + `<div class="fin-tx-tile-note">${escapeHtml(cuT('Sales revenue is on Summary', '营收见汇总'))}</div>`
      + `</div>`;
  }

  const c = document.getElementById('fin-tx-chips');
  if (c) {
    const chip = (key, label, n) =>
      `<button type="button" class="fin-tx-chip${FIN_TX_DIR === key ? ' on' : ''}" `
      + `onclick="FIN_TX_DIR='${key}';finTxRender()">${escapeHtml(label)} `
      + `<span class="fin-tx-n">${n}</span></button>`;
    c.innerHTML = chip('all', cuT('All', '全部'), d.counts.all)
      + chip('in',  cuT('Money in', '进账'),  d.counts.in)
      + chip('out', cuT('Money out', '支出'), d.counts.out);
  }

  FIN_TX_CATLABEL = finCatLabels(d.rows.map(r => r.category));

  const s = document.getElementById('fin-tx-search');
  if (s) s.placeholder = cuT('Filter these transactions', '筛选交易记录');
  const q = (s && s.value || '').trim().toLowerCase();

  const shown = d.rows
    .filter(r => FIN_TX_DIR === 'all' || r.kind === FIN_TX_DIR)
    .filter(r => !q || String(r.subject || '').toLowerCase().includes(q));

  // ── §1.12, both states, and they are different facts ──
  // EMPTY: there is nothing here yet. A compliment that names what will arrive.
  // Money in reaches this in the default window on every tenant today —
  // income_entries' last row is 31 July 2026 and nothing has been typed since —
  // and that is correct, not a missing-data state: something arrives the moment
  // anyone records non-sale income. It is a fact about the DATA, not about a
  // boundary: §36's *Finance is not floored at the cutover date* removes the
  // 1 August floor, so a range widened back over June or July fills this list
  // with the 26 rows that are there.
  //
  // NO RESULTS: there is plenty here; the filter matched none of it. Never a
  // compliment — the operator is looking for something and has not found it —
  // and it offers to clear what is filtering.
  if (!shown.length) {
    const filtering = !!q || FIN_TX_DIR !== 'all';
    host.innerHTML = filtering
      ? `<div class="fin-tx-state"><p>${escapeHtml(cuT('No matching records.', '没有符合条件的记录。'))}</p>`
        + `<button type="button" class="fin-btn-sec" onclick="finTxClear()">${escapeHtml(cuT('Clear', '清除'))}</button></div>`
      : `<div class="fin-tx-state"><h3>${escapeHtml(cuT('Nothing recorded yet', '暂无记录'))}</h3>`
        + `<p>${escapeHtml(cuT(
            'Rent, wages and one-off costs you record will appear here — alongside anything Purchasing posts from a purchase order.',
            '您记录的租金、工资和一次性费用将显示在此处，以及采购单自动记入的支出。'))}</p>`
        // The mockup draws a button here, SECONDARY not Dusk: "The header CTA
        // has first claim on the page's one Dusk element (§1.8 rule 1)."
        + (typeof can !== 'function' || can('finance:record')
          ? `<button type="button" class="fin-btn-sec" onclick="finTxForm('out')">${escapeHtml(cuT('New transaction', '新建交易'))}</button>`
          : '')
        + '</div>';
    return;
  }

  host.innerHTML = '<div class="fin-tx-card"><table class="fin-tx-table">'
    + '<colgroup><col class="fin-c-date"><col class="fin-c-desc"><col class="fin-c-dir">'
    + '<col class="fin-c-amt"><col class="fin-c-act"></colgroup>'
    + '<thead><tr>'
    + `<th>${escapeHtml(cuT('Date', '日期'))}</th>`
    + `<th>${escapeHtml(cuT('Description', '说明'))}</th>`
    + `<th>${escapeHtml(cuT('Direction', '方向'))}</th>`
    + `<th class="fin-tx-num">${escapeHtml(cuT('Amount', '金额'))}</th>`
    + '<th>&nbsp;</th></tr></thead><tbody>'
    + shown.map(finTxRow).join('')
    + '</tbody></table></div>';
}

window.finTxClear = function finTxClear() {
  FIN_TX_DIR = 'all';
  const s = document.getElementById('fin-tx-search');
  if (s) s.value = '';
  finTxRender();
};

// Download the ledger for the window the range bar is showing. Deliberately
// the WINDOW, not the client-side search box above the list: that box narrows
// rows already in the browser, and a file that silently obeyed it would be a
// different answer from the one the range bar names on screen.
window.finTxExportCsv = function finTxExportCsv() {
  const from = (document.getElementById('fin-from') || {}).value || '';
  const to = (document.getElementById('fin-to') || {}).value || '';
  window.location.href = '/api/retail-admin/finance/transactions/export.csv'
    + `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
};

async function finTxLoad() {
  const host = document.getElementById('fin-tx-list');
  if (!host) return;
  const from = (document.getElementById('fin-from') || {}).value;
  const to = (document.getElementById('fin-to') || {}).value;
  // §1.12: the skeleton is for a real load only; a refresh keeps the rows up.
  if (!FIN_TX) host.innerHTML = '<div class="fin-skel"></div>';
  try {
    const j = await api(`/api/retail-admin/finance/transactions?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}`);
    FIN_TX = j.data;
    // Row ceiling (audit J-01). The totals above the list are taken BEFORE the
    // cut and still describe the whole window — this notice is about the rows
    // only, which is what it says.
    if (typeof tdShowTruncation === 'function') tdShowTruncation(host, j.data, 'ledger rows', '条流水');
    finTxRender();
  } catch (e) {
    // A failed read renders where the operator is looking and stays. On a
    // refresh failure the banner sits above the rows already on screen, so
    // nobody reads stale figures unwarned.
    const banner = `<div class="fin-error">${escapeHtml(cuT('Could not load Finance.', '财务数据加载失败。'))} <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
    if (FIN_TX) host.insertAdjacentHTML('afterbegin', banner);
    else host.innerHTML = banner;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   THE WRITE HALF — §36 calls Transactions "the only surface where a person
   types". This is that.

   Every string is either a locked pair from the Finance table (v1.11) or one
   REUSED verbatim from a live source. Nothing here is composed: the validation
   messages and the PO refusals come back from the server, which reuses
   routes/finance.js's own bilingual strings rather than restating them.
   ══════════════════════════════════════════════════════════════════════════ */

let FIN_TX_EDIT = null;   // the row being edited, or null for a new one
let FIN_TX_KIND = 'out';  // the chosen direction — never inferred from the sign

/* Direction is CHOSEN. A negative amount does not silently become money out:
   a mistyped minus would then move a row between halves of the ledger without
   saying so. §36 keeps exactly two directions and there is no third. */
window.finTxKind = function finTxKind(kind) {
  FIN_TX_KIND = kind === 'in' ? 'in' : 'out';
  document.querySelectorAll('#fin-tx-kind button')
    .forEach(b => b.classList.toggle('on', b.dataset.kind === FIN_TX_KIND));
  // §36: "the category field appears once the tenant has created at least one
  // income category… Nobody is asked to categorise before they have anything to
  // categorise with." Hidden, not disabled, not an empty dropdown (§1.9).
  //
  // THE LIST IS THE SERVER'S, NOT AN ASSUMPTION ABOUT IT. Until 2026-09-02 this
  // line read `row.hidden = FIN_TX_KIND === 'in'` — the field was hidden because
  // no list could exist. Now one can, so the field asks it: absent while the list
  // is empty, present the moment the tenant has an income category. §36 ships the
  // list empty, so today the rendering is the same and the REASON is different.
  //
  // The ADD CONTROL STAYS VISIBLE REGARDLESS. §36: gating it "would leave a
  // tenant with non-sale money in hand, no route to record it, and no sign on
  // the screen explaining why."
  const row = document.getElementById('fin-tx-cat-row');
  if (row) row.hidden = FIN_TX_KIND === 'in' && !finIncomeCats().length && !finTxKeepsCat();
  // THE BOX EMPTIES WHEN THE DIRECTION CHANGES. The two lists are different
  // vocabularies, so a value typed for one direction means nothing in the other
  // — and left in place it would be SENT: type Rent, switch to money in on a
  // tenant that has income categories, save, and an income row is filed under an
  // expense category. Hiding the field covers only the empty-list case; this
  // covers the other one. finTxForm re-fills the box straight after calling
  // this, so opening the form on an existing row is unaffected.
  const box = document.getElementById('fin-tx-cat');
  if (box) box.value = '';
  // The menu, if one is open, is showing the OTHER direction's list — close it
  // rather than leave it open against options that no longer apply.
  finTxCatSuggestClose();
};

/* The tenant's income categories, as the server sent them with the ledger.

   EMPTY IS THE ANSWER, NOT A FAILURE. §36 ships this list empty on every tenant
   and records why: the four the kitchen app defaults to are channel facts the
   order record already carries, "a dropdown with a wrong option available is
   what produced the ¥152,309 Mini App mis-filing", and "an empty list cannot
   offer a wrong option". A payload that never arrived reads empty here too,
   which hides the field — the safe way round, since the alternative offers a
   category box with nothing behind it. */
function finIncomeCats() {
  return (FIN_TX && FIN_TX.income_categories) || [];
}

/* One exception to the rule above, and it is about not LOSING a value rather
   than about offering one. A money-in row that already carries a category keeps
   its field even when the list is empty — a category deleted in Settings must
   not make the next edit of that row silently blank what it says. §36's rule is
   that nobody is asked to categorise before they have something to categorise
   with; a row that already has one has something. */
function finTxKeepsCat() {
  return !!(FIN_TX_EDIT && FIN_TX_EDIT.kind === 'in' && FIN_TX_EDIT.category);
}

/* The suggestions behind the Category box, PER DIRECTION.

   Money out: the expense categories already on the server — the ones §36 says
   are shared properly under kind='accounting' — read off the rows on screen.
   Suggestions only: the field is free text, and storeCategory snaps whatever is
   typed onto an existing entry at write.

   Money in: the tenant's own income list, which is a DIFFERENT LIST doing a
   different job. The two are never pooled. The `kind === 'out'` filter on the
   money-out half is what keeps them apart now that an income row can carry a
   category — without it the expense box would suggest income categories, and
   `storeCategory` would then snap the typed value onto the wrong master list. */
function finTxCatOptions() {
  if (FIN_TX_KIND === 'in') return finIncomeCats();
  return finTxExpenseCats();
}

/* THE EXPENSE HALF, ON ITS OWN. §146 split it out: a claim row's picker needs
   the money-OUT list whatever the FORM is currently set to, and calling
   `finTxCatOptions()` there would have offered INCOME categories to a claim
   whenever the operator had last opened the income form. Same list, asked
   without the form's question. */
function finTxExpenseCats() {
  // §87 part two: the tenant's own list, when they have one. It is the list the
  // Categories sub-view maintains, ACTIVE ENTRIES ONLY — a category the tenant
  // hid must stop being offered, which is the whole of what hiding does.
  const own = (FIN_TX && FIN_TX.expense_categories) || [];
  if (own.length) return own.slice();
  // AND THE OLD DERIVATION WHILE THAT LIST IS EMPTY, which is every tenant on
  // the day this ships. §36's empty-list rule is about not offering a WRONG
  // option; a category read off this tenant's own ledger rows is not one, and
  // taking it away would leave a business with three years of expenses typing
  // every category from memory.
  return [...new Set(((FIN_TX && FIN_TX.rows) || [])
    .filter(r => r.kind === 'out' && r.category).map(r => r.category))].sort();
}

/* THE BOX'S OWN MENU, drawn by us — not an <input list> + <datalist> left to
   the browser. That was the field's original shape, and it carried the same
   defect 16-purchasing.js already found and fixed for its payment-terms and
   payment-method fields (retail-admin.css:10947): the OS combobox popup is
   unstyleable, and inside an embedding webview it can land pinned to a far
   edge of the window instead of under the field that opened it — which is
   what this field was doing. It reuses that fix's .pu2-suggest-menu /
   .pu2-suggest-opt classes rather than inventing a second popup style. */
let FIN_CAT_SUG_OPEN = false;
let FIN_CAT_SUG_IDX = -1;   // keyboard-highlighted row, -1 = none

/** The rows the menu would show for a given typed value. Pure — no DOM — so
    a test can check what the box would offer without opening anything. Case-
    insensitive substring, and a value that already matches an option exactly
    keeps the whole list open rather than narrowing to itself, which is what
    lets an already-filled box be reopened and changed. */
function finTxCatSugRows(query) {
  const labels = [...finCatLabels(finTxCatOptions()).values()];
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q || labels.some(l => l.toLowerCase() === q)) return labels;
  return labels.filter(l => l.toLowerCase().includes(q));
}

function finTxCatSugMenuEl() {
  let menu = document.getElementById('fin-tx-cat-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'fin-tx-cat-menu';
    menu.className = 'pu2-suggest-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    // mousedown, not click: it fires before the input's blur, and
    // preventDefault() stops the field losing focus at all.
    menu.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.pu2-suggest-opt');
      if (!opt) return;
      e.preventDefault();
      finTxCatSugPick(opt.dataset.v);
    });
    document.body.appendChild(menu);
  }
  return menu;
}

/* Off the FIELD's own coordinates, not a guess the browser makes about where
   its own widget lives — the whole of the fix. Under the field by default;
   over it when the field sits low enough that the list would run off the
   bottom of the window. */
function finTxCatSugPlace(input) {
  const menu = finTxCatSugMenuEl();
  const r = input.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.width = r.width + 'px';
  const below = window.innerHeight - r.bottom;
  if (below < menu.offsetHeight + 12 && r.top > below) menu.style.top = Math.max(8, r.top - menu.offsetHeight - 4) + 'px';
  else menu.style.top = (r.bottom + 4) + 'px';
}

function finTxCatSugPaint(rows) {
  finTxCatSugMenuEl().innerHTML = rows.map((label, i) =>
    `<div class="pu2-suggest-opt${i === FIN_CAT_SUG_IDX ? ' on' : ''}" role="option"
        aria-selected="${i === FIN_CAT_SUG_IDX}" data-v="${escapeHtml(label)}">
        <span class="lead">${escapeHtml(label)}</span>
      </div>`).join('');
}

window.finTxCatSuggestOpen = function () {
  const input = document.getElementById('fin-tx-cat');
  if (!input) return;
  const rows = finTxCatSugRows(input.value);
  if (!rows.length) { finTxCatSuggestClose(); return; }
  if (!FIN_CAT_SUG_OPEN) FIN_CAT_SUG_IDX = -1;
  FIN_CAT_SUG_OPEN = true;
  if (FIN_CAT_SUG_IDX >= rows.length) FIN_CAT_SUG_IDX = -1;
  finTxCatSugPaint(rows);
  const menu = finTxCatSugMenuEl();
  menu.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  finTxCatSugPlace(input);
};

function finTxCatSugPick(label) {
  const input = document.getElementById('fin-tx-cat');
  if (input) { input.value = label; input.focus(); }
  finTxCatSuggestClose();
}

window.finTxCatSuggestClose = function () {
  const menu = document.getElementById('fin-tx-cat-menu');
  if (menu) { menu.hidden = true; menu.innerHTML = ''; }
  const input = document.getElementById('fin-tx-cat');
  if (input) input.setAttribute('aria-expanded', 'false');
  FIN_CAT_SUG_OPEN = false; FIN_CAT_SUG_IDX = -1;
};

window.finTxCatSuggestBlur = function () {
  // Deferred: an option's mousedown preventDefault()s the focus loss, but a
  // click landing anywhere else still needs its turn before we tear down.
  setTimeout(() => { if (FIN_CAT_SUG_OPEN) finTxCatSuggestClose(); }, 150);
};

// The caret is inside the label's row, so a plain click would re-focus the
// input and toggle nothing. Handle it on mousedown, before focus moves.
window.finTxCatSuggestToggle = function (e) {
  e.preventDefault(); e.stopPropagation();
  if (FIN_CAT_SUG_OPEN) { finTxCatSuggestClose(); return; }
  const input = document.getElementById('fin-tx-cat');
  if (input) input.focus();
  finTxCatSuggestOpen();
};

// Arrow keys / Enter / Escape — the keyboard the native popup gave us free.
window.finTxCatSuggestKey = function (e) {
  const menu = document.getElementById('fin-tx-cat-menu');
  const open = FIN_CAT_SUG_OPEN && menu && !menu.hidden;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) { FIN_CAT_SUG_IDX = -1; finTxCatSuggestOpen(); }
    const el = finTxCatSugMenuEl(), n = el.children.length;
    if (!n) return;
    FIN_CAT_SUG_IDX = e.key === 'ArrowDown' ? (FIN_CAT_SUG_IDX + 1) % n : (FIN_CAT_SUG_IDX <= 0 ? n - 1 : FIN_CAT_SUG_IDX - 1);
    finTxCatSugPaint(finTxCatSugRows(document.getElementById('fin-tx-cat').value));
    const on = el.children[FIN_CAT_SUG_IDX];
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!open) return;
  if (e.key === 'Enter') {
    const on = menu.children[FIN_CAT_SUG_IDX];
    // Enter with nothing highlighted means "I typed what I meant" — leave the
    // free text alone and just get the menu out of the way.
    if (FIN_CAT_SUG_IDX >= 0 && on) { e.preventDefault(); finTxCatSugPick(on.dataset.v); }
    else finTxCatSuggestClose();
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); finTxCatSuggestClose(); }
};

// A fixed menu doesn't follow the page under it — close on anything that
// would leave it stranded beside a field that has moved. Scroll events don't
// bubble, so a capturing listener is the only way to see the modal's own
// scroller.
document.addEventListener('scroll', (e) => {
  const menu = document.getElementById('fin-tx-cat-menu');
  if (menu && !menu.hidden && !menu.contains(e.target)) finTxCatSuggestClose();
}, true);
window.addEventListener('resize', () => { if (FIN_CAT_SUG_OPEN) finTxCatSuggestClose(); });

/* THE HALF THAT IS SHOWN MUST STORE AS THE WHOLE THAT IS HELD, and this is the
   trap in translating a free-text field rather than a label. The box offers
   `Salaries&Wages`; the column holds `Salaries&Wages 员工工资`. Saving what the
   box says would write a SECOND category one character-class away from the
   first — two lines on the Summary breakdown that read alike, the total right
   and every line beneath it wrong, which is the exact defect `storeCategory`
   was written to fix. `storeCategory` cannot catch it either: it snaps on
   spacing and case, and these differ by a whole language.

   So a typed value that matches a known category's label resolves back to the
   stored spelling before it is sent. EITHER half matches, not just the live
   language's — an operator who pastes the Chinese half into the English screen
   lands on the same row rather than minting a twin. Anything matching nothing
   is a genuinely new category and stores exactly as typed, which is what the
   free-text field is for. */
function finTxCatStored(typed) {
  const t = String(typed == null ? '' : typed).trim();
  if (!t) return t;
  for (const stored of finTxCatOptions()) {
    if (stored === t) return stored;
    const p = finCatSplit(stored);
    if (p && (p.en === t || p.cn === t)) return stored;
  }
  return t;
}

/* Open the form. `row` present = edit; absent = add.
   A PO-derived row never reaches here — its row offers no Edit at all, which is
   §36's "the row explains its own constraint instead of merely enforcing it".
   The guard below is the second line of that defence, not the first. */
window.finTxForm = function finTxForm(kindOrRow, row) {
  if (row && row.source === 'po') return;
  FIN_TX_EDIT = row || null;
  const m = document.getElementById('fin-tx-modal');
  if (!m) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  finTxKind(row ? row.kind : (typeof kindOrRow === 'string' ? kindOrRow : 'out'));
  // A new row defaults to the STORE's today: the operator is dating a
  // transaction in the shop's books, not on their laptop's calendar.
  set('fin-tx-date', row ? row.date : tdToday());
  set('fin-tx-amount', row ? row.amount : '');
  // The label, not the stored value — and finTxSave maps it back, so the
  // round trip does not rewrite the category of a row merely opened and saved.
  set('fin-tx-cat', row && row.category ? finCatLabel(row.category) : '');
  /* READ FROM `row.note` DIRECTLY, NOT DERIVED FROM `subject !== category`.
     That comparison is false — and this box was left silently blank —
     whenever a manual row has BOTH a category and a note, because
     `finTxSubject` shows the category in that case and `subject` then equals
     `category` exactly. Saving from a blank box wrote an empty note over the
     real one (`finTxSave` → `note: val('fin-tx-note')` → PUT), so opening
     Edit on such a row and pressing Save silently erased what had been typed.
     `row.note` is the column's own value, unaffected by what `subject` is
     currently standing in for. */
  set('fin-tx-note', row && row.source === 'manual' && row.note ? row.note : '');
  const t = document.getElementById('fin-tx-modal-t');
  if (t) t.textContent = row ? cuT('Edit', '编辑') : cuT('New transaction', '新建交易');
  const del = document.getElementById('fin-tx-del');
  if (del) del.hidden = !row;
  // The suggestions and the field's own presence are both finTxKind's, which
  // this has already called — they depend on the direction, and the direction
  // can change while the form is open.
  finTxErr('');
  m.hidden = false;
  // §1.8, one Dusk element per page. The modal's Save is the primary action of
  // the bounded decision it opens, so the header CTA — which the scrim has
  // already put out of reach — stands down while it is open. The empty state's
  // own button is Secondary for the same reason, per the mockup's note: "a
  // second Dusk button on the same page is a bug even when the page is empty."
  const cta = document.getElementById('fin-tx-new');
  if (cta) cta.hidden = true;
};

window.finTxFormClose = function finTxFormClose() {
  const m = document.getElementById('fin-tx-modal');
  if (m) m.hidden = true;
  FIN_TX_EDIT = null;
  // The header CTA comes back only if Transactions is still the open sub-view.
  const tx = document.getElementById('fin-tx');
  const cta = document.getElementById('fin-tx-new');
  if (cta) cta.hidden = !tx || tx.hidden;
};

/* §1.12's error state: it renders where the operator is looking, next to the
   control they pressed, and stays until acknowledged. Never a toast — a failed
   write that flies away leaves them with no way to know the money did not move.
   The text is the server's, which reuses routes/finance.js's bilingual strings. */
function finTxErr(msg) {
  const el = document.getElementById('fin-tx-err');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

/* §1.12's in-flight state: "every control that writes disables while it writes.
   No exceptions for the important ones." Captured synchronously — shape C in
   that section is a button read after an await, by which time it is null. */
async function finTxWrite(run) {
  const save = document.getElementById('fin-tx-save');
  const del = document.getElementById('fin-tx-del');
  const before = save && save.textContent;
  if (save) { save.disabled = true; save.textContent = cuT('Saving…', '保存中…'); }
  if (del) del.disabled = true;
  try {
    await run();
    finTxFormClose();
    FIN_TX = null;               // force a real reload rather than a repaint
    await finTxLoad();
    if (window.toast) toast(cuT('Saved', '已保存'));
  } catch (e) {
    finTxErr(e.message);
  } finally {
    if (save) { save.disabled = false; if (before) save.textContent = before; }
    if (del) del.disabled = false;
  }
}

window.finTxSave = async function finTxSave() {
  const val = (id) => (document.getElementById(id) || {}).value;
  const body = {
    kind: FIN_TX_KIND,
    date: val('fin-tx-date'),
    amount: val('fin-tx-amount'),
    // THE FIELD'S PRESENCE IS THE RULE, read from the field rather than restated
    // here. It is absent for money in while the tenant has no income category,
    // and an absent field has nothing to send — sending the box's last value
    // anyway would file an income row under whichever EXPENSE category was typed
    // before the direction was switched.
    category: (document.getElementById('fin-tx-cat-row') || {}).hidden
      ? null : finTxCatStored(val('fin-tx-cat')),
    note: val('fin-tx-note'),
  };
  const row = FIN_TX_EDIT;

  return finTxWrite(() => row
    ? api(`/api/retail-admin/finance/transactions/${row.kind}/${row.id}`, { method: 'PUT', body })
    : api('/api/retail-admin/finance/transactions', { method: 'POST', body }));
};

/* DECIDED 2026-09-02: a hand-typed row is freely deletable. Roots enters rows by
   hand and mistakes are typos; forcing an offsetting entry to correct one turns
   a two-row ledger into four rows nobody can read. The confirm is the house
   askConfirm, danger-styled, because this removes money from a ledger. */
window.finTxDelete = async function finTxDelete() {
  const row = FIN_TX_EDIT;
  if (!row) return;
  // REFUSE rather than proceed if the shared dialog is unavailable. Skipping the
  // confirm on a money-deleting action because a script failed to load is the
  // wrong way round: the guard is the point, not the decoration.
  if (typeof askConfirm !== 'function') return;
  if (!(await askConfirm({
    title: cuT('Delete this transaction?', '删除这条交易记录？'),
    body: cuT('This removes the row from the ledger. This cannot be undone.',
              '此操作将从账本中移除该记录。此操作无法撤销。'),
    confirmLabel: cuT('Delete', '删除'),
    danger: true,
  }))) return;
  return finTxWrite(() =>
    api(`/api/retail-admin/finance/transactions/${row.kind}/${row.id}`, { method: 'DELETE' }));
};

/* Void a posted claim (§90). NOT finTxDelete: that endpoint refuses a
   claim-linked row outright (see the note above finTxRow) because the row is a
   projection of the claim — this calls the CLAIM's own endpoint instead, which
   marks the claim 'voided' and lets `postClaim` take the row back out, the same
   mechanism a rejection already uses. There is no modal open here — the row's
   own link calls this directly — so it manages its own confirm and toast rather
   than going through finTxWrite. */
window.finTxVoidClaim = async function finTxVoidClaim(claimId) {
  if (!claimId || typeof askConfirm !== 'function') return;
  if (!(await askConfirm({
    title: cuT('Void this claim?', '作废这条费用申请？'),
    body: cuT('This removes the row from the ledger. This cannot be undone.',
              '此操作将从账本中移除该记录。此操作无法撤销。'),
    confirmLabel: cuT('Void', '作废'),
    danger: true,
  }))) return;
  try {
    await api(`/api/retail-admin/staff-expenses/${Number(claimId)}/void`, { method: 'POST' });
    FIN_TX = null;                          // force a real reload, not a repaint
    FIN_DATA = null;                        // the staircase drawn from the same ledger
    FIN_APR = null; FIN_APR_SEEN = false;    // the claim's own pill, on the other sub-view
    await finTxLoad();
    if (window.toast) toast(cuT('Voided', '已作废'));
  } catch (e) {
    if (window.toast) toast(e.message, 'err');
  }
};

/* Edit a typed row, looked up in the payload already on screen rather than
   re-fetched: the row the operator clicked is the row they are looking at. */
window.finTxEdit = function finTxEdit(kind, id) {
  if (!FIN_TX) return;
  const row = FIN_TX.rows.find(r => r.kind === kind && String(r.id) === String(id));
  // `=== 'manual'`, not `!== 'po'`. With one kind of projection those two read
  // the same; with two, the negation is the bug that lets a claim-posted row
  // into the edit form (§87 step three).
  if (row && row.source === 'manual') finTxForm(null, row);
};

/* ══════════════════════════════════════════════════════════════════════════
   CATEGORIES — the tenant's own expense-category list (§87 part two).

   This is the list a person picks from when they record money out. Until this
   screen existed the list was `finTxCatOptions()` — the distinct categories
   already on rows in the window, which is the accumulated history of what
   people had typed, so the first typo was a permanent option and there was no
   way to remove one.

   THE LIST SHIPS EMPTY AND NOTHING SEEDS IT. §36: "an empty list cannot offer a
   wrong option." The empty state here says what to do, not that something is
   missing (§1.12) — a tenant with no categories has not lost anything.

   Server: routes/finance-categories.js.
   ══════════════════════════════════════════════════════════════════════════ */

let FIN_CATS = null;         // the last payload
let FIN_CATS_SEEN = false;   // has this sub-view ever been pulled

async function finCatsLoad() {
  const host = document.getElementById('fin-cats-list');
  if (!host) return;
  if (!FIN_CATS) host.innerHTML = '<div class="fin-skel"></div>';
  try {
    const j = await api('/api/retail-admin/finance/categories');
    FIN_CATS = j.data || [];
    finCatsRender();
  } catch (e) {
    // Same rule as the staircase: a failed read renders where the operator is
    // looking and never becomes a toast.
    host.innerHTML = `<div class="fin-error">${escapeHtml(cuT('Could not load the categories.', '分类加载失败。'))} <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
  }
}

/* One row. The name is editable in place, the operating flag is a checkbox, and
   the last control is either Delete or Restore depending on the row's state.

   THE USAGE COUNT IS SHOWN ON EVERY ROW, not only on the ones that cannot be
   deleted, because it is also the answer to "is this category actually used" —
   which is the question somebody tidying a list is really asking. */
function finCatsRender() {
  const host = document.getElementById('fin-cats-list');
  if (!host) return;
  const rows = FIN_CATS || [];
  if (!rows.length) {
    host.innerHTML = `<p class="fin-cats-empty">${escapeHtml(cuT(
      'No categories yet. Add the ones this business spends money on — rent, wages.',
      '还没有分类。请新增本店的支出分类 — 租金、工资。'))}</p>`;
    return;
  }
  host.innerHTML = rows.map((c) => {
    const off = c.is_active === 0;
    return `<div class="fin-cat-row${off ? ' is-off' : ''}" data-id="${c.id}">`
      + `<input class="fin-cat-name" type="text" value="${escapeAttr(c.name)}"`
      + ` data-original="${escapeAttr(c.name)}" onblur="finCatRename(${c.id}, this)"`
      + ` onkeydown="finCatNameKey(event, this)" aria-label="${escapeAttr(cuT('Category', '分类'))}">`
      + '<label class="fin-cat-flag">'
      + `<input type="checkbox" ${c.is_operating ? 'checked' : ''} onchange="finCatFlag(${c.id}, this.checked)">`
      + `<span>${escapeHtml(cuT('Operating expense', '营业费用'))}</span>`
      + '</label>'
      + `<span class="fin-cat-use">${escapeHtml(finCatsUsage(c.usage_count))}</span>`
      + (off
        ? `<button type="button" class="fin-btn-sec" onclick="finCatActive(${c.id}, true)">${escapeHtml(cuT('Restore', '启用'))}</button>`
        : `<button type="button" class="fin-btn-sec" onclick="finCatHide(${c.id})">${escapeHtml(cuT('Hide', '停用'))}</button>`)
      + `<button type="button" class="fin-cat-del" onclick="finCatDelete(${c.id})"`
      + ` title="${escapeAttr(cuT('Delete', '删除'))}" aria-label="${escapeAttr(cuT('Delete', '删除'))}">×</button>`
      + (off ? `<span class="fin-cat-off">${escapeHtml(cuT('Hidden', '已停用'))}</span>` : '')
      + '</div>';
  }).join('');
}

/* "Used by N expenses". The count is a NUMBER and needs no translation of its
   own; the sentence around it is the pair. Zero says so in words rather than
   rendering "0 expenses", because "not used" is the fact the operator wants. */
function finCatsUsage(n) {
  const count = Number(n) || 0;
  return count === 0
    ? cuT('Not used', '未使用')
    : cuT(`Used by ${count}`, `${count} 条使用`);
}

window.finCatNameKey = function finCatNameKey(ev, input) {
  if (ev.key === 'Enter') input.blur();
  if (ev.key === 'Escape') { input.value = input.dataset.original; input.blur(); }
};

/* Every write goes through here: it reloads rather than patching the row in
   place, because a rename moves the expense rows with it and the usage counts
   on OTHER rows can change with it. Repainting one row would leave the rest of
   the list describing the state before the write. */
async function finCatsWrite(run) {
  try {
    await run();
    FIN_CATS = null;
    await finCatsLoad();
    return true;
  } catch (e) {
    if (window.toast) toast(e.message, 'err');
    await finCatsLoad();
    return false;
  }
}

window.finCatRename = function finCatRename(id, input) {
  const name = (input.value || '').trim();
  const was = input.dataset.original;
  if (!name || name === was) { input.value = was; return; }
  return finCatsWrite(() => api('/api/retail-admin/finance/categories/' + id,
    { method: 'PATCH', body: { name } }));
};

window.finCatFlag = function finCatFlag(id, checked) {
  return finCatsWrite(() => api('/api/retail-admin/finance/categories/' + id,
    { method: 'PATCH', body: { is_operating: !!checked } }));
};

window.finCatActive = function finCatActive(id, active) {
  return finCatsWrite(() => api('/api/retail-admin/finance/categories/' + id,
    { method: 'PATCH', body: { is_active: !!active } }));
};

/* HIDING IS THE ORDINARY WAY TO RETIRE A CATEGORY, and the confirm says what it
   does rather than asking whether the operator is sure. The rows keep the name
   and keep their flag; only the form stops offering it. */
window.finCatHide = async function finCatHide(id) {
  if (typeof askConfirm !== 'function') return;
  if (!(await askConfirm({
    title: cuT('Hide this category?', '停用该分类？'),
    body: cuT('It stops being offered when recording an expense. Expenses already filed under it keep it, and keep its setting.',
              '记录支出时不再显示该分类。已使用该分类的支出保持不变，其设置也保留。'),
    confirmLabel: cuT('Hide', '停用'),
  }))) return;
  return finCatActive(id, false);
};

/* DELETE IS FOR A CATEGORY NOTHING HAS USED. The server refuses the rest with a
   409, and the refusal is not a technicality: an expense row stores its category
   as text and the operating flag lives on this record, so deleting a used one
   would turn every row that named it back into an operating expense with nothing
   on any screen to say it had. The client says so BEFORE the request, from the
   count it already has, so the operator reads the reason rather than an error. */
window.finCatDelete = async function finCatDelete(id) {
  const row = (FIN_CATS || []).find(c => String(c.id) === String(id));
  if (!row) return;
  if (row.usage_count > 0) {
    if (window.toast) {
      toast(cuT(
        `"${row.name}" is used by ${row.usage_count} expenses. Hide it instead — hiding keeps those records exactly as they are.`,
        `“${row.name}”已被 ${row.usage_count} 条支出使用。请改为停用 — 停用不会改动这些记录。`), 'err');
    }
    return;
  }
  if (typeof askConfirm !== 'function') return;
  if (!(await askConfirm({
    title: cuT('Delete this category?', '删除该分类？'),
    body: cuT('Nothing has been filed under it. This cannot be undone.',
              '尚无支出使用该分类。此操作无法撤销。'),
    confirmLabel: cuT('Delete', '删除'),
    danger: true,
  }))) return;
  return finCatsWrite(() => api('/api/retail-admin/finance/categories/' + id, { method: 'DELETE' }));
};

window.finCatAdd = async function finCatAdd() {
  const input = document.getElementById('fin-cats-new');
  if (!input) return;
  const name = (input.value || '').trim();
  if (!name) { input.focus(); return; }
  const ok = await finCatsWrite(() => api('/api/retail-admin/finance/categories',
    { method: 'POST', body: { name } }));
  // CLEARED ONLY ON SUCCESS. A duplicate or a rejected name leaves what was
  // typed in the box to be corrected — clearing it would make the operator
  // retype the thing the message is about.
  if (ok) { input.value = ''; input.focus(); }
};

window.finCatAddKey = function finCatAddKey(ev) {
  if (ev.key === 'Enter') { ev.preventDefault(); finCatAdd(); }
};

/* ══════════════════════════════════════════════════════════════════════════
   APPROVALS (§87 step three), ON THE DESKTOP — the tap that puts money in the
   books, on the surface where the books are read.

   **WHY IT IS A FINANCE SUB-VIEW AND NOT A RAIL ROW OF ITS OWN.** Approving a
   claim posts a row into `expense_entries` — it is not a screen NEAR the ledger,
   it is the act that writes to it. Transactions lists what was entered; this
   lists what is waiting to be entered, and one click separates them. The phone
   gives it a row of its own (m.html, Operations) because a phone has no Finance
   screen to put it inside; this surface does.

   **THIS REPLACES A DOCUMENTED ABSENCE.** finTxRow above says of a claim row:
   "A claim is worked on the phone by whoever approves it, and this admin has no
   claim screen to open." That was true and is no longer. The claim row still
   offers no link out — wiring one is a separate decision about where a ledger
   row should send somebody, and §36's refusal there was about a link to a tab
   that does not exist, not about this queue.

   **NOTHING HERE IS COMPOSED.** Every pair below is lifted verbatim from the
   phone's own approvals screen (public/m.html, screenApprovals / aprRow), which
   is the first preference in the Rule 4 amendment: copy a live pair. The two
   surfaces now say the same words for the same act, which is the point.

   Server: routes/staff-expenses.js — /pending, /:id/decide, /:id/settle. All
   three are gated on `expenses:approve`, which no floor preset holds.
   ══════════════════════════════════════════════════════════════════════════ */

let FIN_APR = null;          // the last /pending payload
let FIN_APR_SEEN = false;    // has this sub-view ever been pulled
let FIN_APR_BUSY = 0;        // id being decided, or -1 while a settle runs
let FIN_APR_SHOT = null;     // the receipt currently open: { id, data, err }
/* §146 — A CATEGORY CHOSEN ON A WAITING CLAIM, BEFORE ANYTHING IS COMMITTED.
   It rides with the Approve click rather than saving on its own, so it has to
   survive until then — and this list re-renders under the operator for reasons
   that have nothing to do with the pick: opening a receipt, a decision landing
   on another row. Held in the DOM alone it would be silently thrown away by the
   very act of checking the photo before approving. Keyed by claim id, cleared
   when that claim is decided. */
let FIN_APR_CAT = {};
/* §207 — WHO PAID, CHOSEN ON A WAITING CLAIM, same mechanism and same reason as
   the category above it: it rides with the Approve click, so it has to survive
   every re-render that happens between the two. Keyed by claim id, cleared when
   that claim is decided. */
let FIN_APR_PAID = {};

/* THE ROW IS BUSY, NOT THE SCREEN. Ported verbatim from the phone's reasoning:
   a manager working down a queue of six clicks the next one while the last is
   still in flight, and a spinner over the whole list would make that impossible
   for no benefit. */

// The claim amount, EXACT. Not finMoney() — that is the staircase's formatter
// and rounds to whole units, which is right for a ¥180,332 headline and wrong
// here: the figure on this row is the one being approved, and a ¥38.50 taxi
// that renders as ¥39 is the screen misreporting the decision it is asking for.
function finAprMoney(n) {
  return typeof acMoney === 'function' ? acMoney(n) : '¥' + Number(n || 0).toFixed(2);
}

async function finAprLoad() {
  const host = document.getElementById('fin-apr-list');
  if (!host) return;
  if (!FIN_APR) host.innerHTML = '<div class="fin-skel"></div>';
  try {
    const j = await api('/api/retail-admin/staff-expenses/pending');
    FIN_APR = j.data || { rows: [], owed: [], waiting: 0 };
    finAprPaintDot(FIN_APR.waiting || 0);
    finAprRender();
  } catch (e) {
    // Same rule as the staircase and the category list: a failed read renders
    // where the operator is looking and never becomes a toast.
    host.innerHTML = `<div class="fin-error">${escapeHtml(cuT('Could not load the queue.', '无法加载列表。'))} <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
  }
}

/* ── THE DOT ────────────────────────────────────────────────────────────────
   Two places, and they answer two different questions. The rail row's dot says
   "there is money waiting on you somewhere in Finance"; the sub-view's says
   "it is behind this one of the three". A dot in only the second place would be
   invisible to everybody not already on the screen it is trying to summon them
   to, which is nobody.

   **AMBER, NOT RED, AND IT DOES NOT PULSE.** The house rule is already written
   in retail-admin.css: `.tabs .tab-badge { background: var(--td-amber);
   animation: none; }` — "calm Amber (matches the topbar inbox), never the red".
   §1.10: colour encodes state, and a claim waiting to be approved is attention,
   not an error. The generic `.tab-badge` component is reused rather than a new
   dot invented, so it inherits that rule and any later change to it.

   THE COUNT IS SHOWN FROM TWO UP, a bare dot at one — the same threshold the
   orders badge uses, and for the same reason: volume is the thing worth a
   number, and "1" next to a single waiting claim is chrome for its own sake. */
function finAprPaintDot(waiting) {
  const n = Number(waiting) || 0;
  const label = n > 1 ? (n > 99 ? '99+' : String(n)) : '';
  const set = (btn, badge) => {
    if (!btn || !badge) return;
    btn.classList.toggle('has-unseen', n > 0);
    badge.textContent = n > 0 ? label : '';
  };
  set(document.querySelector('.tabs [data-tab="finance"]'), document.getElementById('financeTabBadge'));
  set(document.querySelector('#fin-subviews button[data-sub="approvals"]'), document.getElementById('fin-apr-dot'));
}

/* ── THE POLLER ─────────────────────────────────────────────────────────────
   The rail dot has to appear for somebody who never opens Finance — that is the
   entire job of a rail dot — so the count is pulled at boot and on a timer,
   the same shape as the unseen-orders and unseen-inbox pollers in 04-orders.js.

   **IT STOPS ITSELF ON THE FIRST 403 AND NEVER ASKS AGAIN.** `can()` FAILS OPEN
   (CAPS === null ⇒ true, 01-core.js), so gating the poll on the capability
   alone would still fire it for every operator during the window before
   /api/backend/me lands — and for a warehouse packer that is a 403 every
   fifteen seconds, forever, for a dot they can never be shown. The capability
   check is the cheap filter; the 403 is the authoritative one, and one of them
   is enough to settle it. */
let FIN_APR_POLL_OFF = false;

async function finAprPollDot() {
  if (FIN_APR_POLL_OFF || document.hidden) return;
  if (typeof can === 'function' && !can('expenses:approve')) return;
  try {
    const j = await api('/api/retail-admin/staff-expenses/pending');
    // The payload is kept, not just the count: an operator who opens Approvals
    // straight after a poll gets a painted screen rather than a skeleton for a
    // list the browser is already holding.
    FIN_APR = j.data || FIN_APR;
    finAprPaintDot((j.data && j.data.waiting) || 0);
    if (FIN_APR_SEEN) finAprRender();
  } catch (e) {
    if (e && (e.status === 403 || e.code === 'forbidden')) {
      FIN_APR_POLL_OFF = true;
      finAprPaintDot(0);
    }
    // Any other failure — offline, a 500 — leaves the badge exactly as it was.
    // A dot that vanished on a dropped wifi packet would report the queue empty.
  }
}

/* THE ONLY THING IN THIS FILE THAT ACTS AT LOAD, and it therefore has to check
   that it is in a browser before it does. Every other top-level statement here
   is a declaration; three of this repo's suites (test_finance_summary,
   test_finance_transactions, test_finance_categories) load this file into a bare
   `vm` context to exercise its renderers against the locked pairs, and that
   context is a deliberate minimum — `window` is `{}` and there are no timers on
   it at all. An unguarded setTimeout here took all three suites down at REQUIRE
   time, before a single assertion ran.

   Guarded on the APIs actually used rather than on a "am I a browser" sniff, so
   the check cannot drift from what the body needs. */
(function _startApprovalsDotPoller() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof setTimeout !== 'function' || typeof setInterval !== 'function') return;
  if (typeof window.addEventListener !== 'function'
      || typeof document.addEventListener !== 'function') return;
  if (window._aprDotPollerWired) return;
  window._aprDotPollerWired = true;
  // 600ms, behind the orders badge at 400 and level with the inbox one: three
  // pollers racing the first paint is what makes a cold boot feel slow.
  setTimeout(finAprPollDot, 600);
  setInterval(finAprPollDot, 15000);
  window.addEventListener('focus', finAprPollDot);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) finAprPollDot(); });
})();

/* ── THE RECEIPT ────────────────────────────────────────────────────────────
   Fetched only when somebody asks to see one. The list carries `has_receipt`
   and not the bytes — twenty claims would otherwise drag twenty photographs
   across a shop's wifi to render none of them.

   **A FAILURE HERE SAYS SO.** The phone's version swallows the error and
   silently paints nothing, which is why nobody noticed that
   `/staff-expenses/:id/receipt` scoped to `submitted_by` and therefore served
   an approver NOTHING for anybody else's claim — every claim on THIS screen,
   since only an approver ever reaches it. **§109 (2026-09-13) widened the
   route**: an approver's request now matches on id alone, the same ownership
   test `/pending` already uses to hand them the rest of the row. This control
   is left exactly as it was rather than removed — a genuinely missing receipt,
   a dropped connection, or a stale claim id still has to say so instead of
   looking broken.

   The sentence is the phone's own, verbatim: `Could not read that photo. ·
   无法读取该照片。` already ships three times in m.html on the picker that TAKES
   these photographs. The same failure said the same way on both ends of one
   feature, and nothing composed. */
window.finAprShot = function finAprShot(id) {
  const claim = Number(id);
  if (!claim) return;
  if (FIN_APR_SHOT && FIN_APR_SHOT.id === claim) { FIN_APR_SHOT = null; finAprRender(); return; }
  FIN_APR_SHOT = { id: claim, data: null, err: '' };
  finAprRender();
  api('/api/retail-admin/staff-expenses/' + claim + '/receipt').then((j) => {
    if (!FIN_APR_SHOT || FIN_APR_SHOT.id !== claim) return;   // a later click already won
    FIN_APR_SHOT.data = (j.data && j.data.receipt_data) || null;
    if (!FIN_APR_SHOT.data) FIN_APR_SHOT.err = cuT('Could not read that photo.', '无法读取该照片。');
    finAprRender();
  }).catch(() => {
    if (!FIN_APR_SHOT || FIN_APR_SHOT.id !== claim) return;
    FIN_APR_SHOT.err = cuT('Could not read that photo.', '无法读取该照片。');
    finAprRender();
  });
};

/* ── WHERE THE CLAIM IS FILED (§146) ────────────────────────────────────────
   **THE SUBMITTER MAY LEAVE THE CATEGORY BLANK AND OFTEN DOES.** Somebody
   standing beside a taxi does not know the shop's chart of accounts; the person
   working this queue is the person who keeps the books. So the category is
   editable HERE, on the row being decided, and it is one control rather than a
   prompt that fires only on a blank one — a WRONG category is at least as common
   as a missing one, and a prompt that only catches the empty case would wave the
   wrong one straight through into the ledger.

   IT IS OFFERED AFTER THE DECISION TOO, on an approved claim, and that half is
   the one nothing in this product could do before: `finance-transactions.js`
   refuses to edit a claim-posted ledger row — rightly, it is a projection — and
   nothing could edit the claim either, so a ¥299 taxi approved without a
   category could only be fixed by voiding it and asking the employee to send it
   again. Re-filing posts the same money under a different heading.

   NOT OFFERED ON A CLAIM THAT RAISED AN ORDER, and not on a rejected or voided
   one. Neither has a ledger row of its own to file — the order owns the first,
   and the other two were deliberately taken back out. The server refuses all
   three (`ERR.onOrderCat`, `ERR.notApprovedCat`); this is the same rule said
   before the click rather than after it.

   NO LIST, NO PICKER. §36's empty-list rule: a tenant that has not built its
   accounting categories is offered nothing here rather than something wrong. */
function finAprFileable(r) {
  if (Number(r.awaiting_delivery) || r.po_id) return false;
  return r.status === 'submitted' || r.status === 'approved';
}

function finAprCatCell(r) {
  const list = (FIN_APR && FIN_APR.categories) || [];
  if (!list.length || !finAprFileable(r)) return '';
  const waiting = r.status === 'submitted';
  // The pending pick on a waiting row wins over the stored one; `undefined`
  // rather than a falsy test, because '' is a real choice (back to no category)
  // that a plain `||` would quietly replace with the stored value.
  const chosen = waiting && FIN_APR_CAT[r.id] !== undefined
    ? FIN_APR_CAT[r.id] : (r.category || '');
  const labels = finCatLabels(list);
  // The blank row is the product's own live pair (09-products.js), and it is
  // present on a waiting claim only: choosing it there means "not yet", which is
  // today's behaviour. On an approved claim it would mean UNFILING one, and this
  // route does not offer that — the server refuses an empty value for the same
  // reason (ERR.needCategory).
  const blank = (waiting || !r.category)
    ? `<option value=""${chosen ? '' : ' selected'}>`
      + escapeHtml(cuT('— pick a category —', '— 选择分类 —')) + '</option>'
    : '';
  const opts = list.map(c => `<option value="${escapeAttr(c)}"${c === chosen ? ' selected' : ''}>`
    + escapeHtml(labels.get(c) || finCatLabel(c)) + '</option>').join('');
  const busy = !!FIN_APR_BUSY;
  const handler = waiting
    ? `onchange="finAprCatPick(${r.id}, this.value)"`
    : `onchange="finAprFile(${r.id}, this.value)"`;
  return '<span class="fin-apr-catwrap">'
    + `<select class="fin-apr-cat" id="fin-apr-cat-${r.id}"${busy ? ' disabled' : ''} ${handler}>`
    + blank + opts + '</select></span>';
}

/* The pick, remembered rather than sent. See FIN_APR_CAT. No re-render: the
   <select> is already showing what was chosen, and redrawing the list under a
   dropdown the operator has just used is the jump this screen does not need. */
window.finAprCatPick = function finAprCatPick(id, value) {
  FIN_APR_CAT[Number(id)] = String(value == null ? '' : value);
};

/* ── §207 — WHO PAID, AND THE APPROVER CAN CHANGE IT ────────────────────────
   Ash, off this very screen: *"whoever in charge of approval should be able to
   change own money to company money if needed"*. The person at the till taps
   *My own money* out of habit having actually paid on the shop's account, and
   the claim then sits in **Owed to your team** as a debt the business does not
   owe — until somebody transfers real money against it. Before this the only
   way out was to void the claim and ask them to send it again.

   **IT IS AN EDIT OF WHAT THE SUBMITTER SAID, AND THAT IS DELIBERATE.** The
   amount, the note and the date stay theirs — only the person who spent the
   money knows those. Which account it left is a fact about the shop's
   statements, and the approver is the one holding them. The record is the guard,
   not a refusal: the server logs the value it replaced, §87 part five's own
   argument.

   **NO MONEY MOVES IN THE BOOKS.** `lib/expense-posting.js` never reads
   `paid_by` — the ledger row is identical either way. What changes is whether
   the business still owes a person.

   A TWO-OPTION <select>, NOT A PAIR OF CHIPS, because it sits beside the
   category picker on the same row and a second control shaped differently would
   read as a different kind of act. The phone's expense FORM uses chips, and that
   is right where a claim is typed one-handed; this is a correction, made once,
   on a desktop.

   OFFERED ON A WAITING CLAIM AND ON AN APPROVED, UNSETTLED ONE. Not on a
   settled one — the server refuses it, because saying the business never owed
   money it has already handed back leaves a real transfer with nothing behind
   it. Not on a rejected or voided one: there is no debt either way. Said before
   the click rather than after it, the rule §146's picker already follows.

   UNLIKE THE CATEGORY, A PURCHASE ORDER DOES NOT WITHDRAW IT. That refusal is
   about the ledger, and this touches none: somebody who paid for a food
   processor out of their own pocket is owed the money whether it has arrived or
   not. */
function finAprPaidable(r) {
  if (r.status === 'submitted') return true;
  return r.status === 'approved' && !Number(r.settled);
}

function finAprPaidCell(r) {
  if (!finAprPaidable(r)) return '';
  const waiting = r.status === 'submitted';
  // `undefined` rather than a falsy test, for the reason the category cell gives
  // one line of its own: both values here are truthy, but the habit is what
  // keeps the two cells reading alike.
  const chosen = waiting && FIN_APR_PAID[r.id] !== undefined
    ? FIN_APR_PAID[r.id] : (r.paid_by === 'employee' ? 'employee' : 'company');
  // NO BLANK OPTION, and that is the difference from the category. A category
  // may honestly be "not yet"; who paid may not — it is the field that decides
  // whether a debt exists, and the validator refuses a third answer for exactly
  // that reason (lib/expense-claim.js, PAID_BY).
  const opts = [['employee', cuT('own money', '个人支付')], ['company', cuT('company', '公司')]]
    .map(([v, label]) => `<option value="${escapeAttr(v)}"${v === chosen ? ' selected' : ''}>`
      + escapeHtml(label) + '</option>').join('');
  const busy = !!FIN_APR_BUSY;
  const handler = waiting
    ? `onchange="finAprPaidPick(${r.id}, this.value)"`
    : `onchange="finAprPaidSet(${r.id}, this.value)"`;
  return '<span class="fin-apr-catwrap">'
    + `<span class="fin-apr-paidlab">${escapeHtml(cuT('Who paid', '由谁付款'))}</span>`
    + `<select class="fin-apr-cat fin-apr-paid" id="fin-apr-paid-${r.id}"${busy ? ' disabled' : ''} ${handler}>`
    + opts + '</select></span>';
}

/* Remembered rather than sent — see FIN_APR_PAID. No re-render, the same
   reasoning finAprCatPick gives: the <select> already shows the choice. */
window.finAprPaidPick = function finAprPaidPick(id, value) {
  FIN_APR_PAID[Number(id)] = String(value == null ? '' : value);
};

/* §207 — SAVED ON CHANGE, on a claim already approved. No confirm: it is undone
   by making the same change again, and the server logs the value it replaced.

   THE STAIRCASE IS NOT DROPPED, AND THE OMISSION IS THE POINT. A decision drops
   both caches because it writes `expense_entries`; this writes one column on
   `staff_expenses` and no total in Finance moves by a fen. What DOES go stale is
   the Transactions list, which prints `Staff claim · own money` off this very
   field — so that one cache is dropped and the summary's is left alone. */
window.finAprPaidSet = async function finAprPaidSet(id, value) {
  const claim = Number(id);
  const paid = String(value == null ? '' : value);
  if (!claim || !paid || FIN_APR_BUSY) { finAprRender(); return; }
  FIN_APR_BUSY = claim;
  finAprRender();
  try {
    await api('/api/retail-admin/staff-expenses/' + claim + '/paid-by',
      { method: 'POST', body: { paid_by: paid } });
    FIN_APR_BUSY = 0;
    FIN_TX = null; FIN_TX_SEEN = false;     // the row whose mark reads off paid_by
    await finAprLoad();
    if (window.toast) toast(cuT('Saved', '已保存'));
  } catch (e) {
    FIN_APR_BUSY = 0;
    if (window.toast) toast(e.message, 'err');
    finAprRender();
  }
};

/* ── RE-FILING AN APPROVED CLAIM (§146) ─────────────────────────────────────
   **NO MONEY MOVES.** Same claim, same sum, same date, same person — what
   changes is which line of the category breakdown it sits on, and whether the
   tenant's non-operating flag reaches it. An uncategorised row is counted as
   operating by the summary, so a private cost filed under nothing quietly
   inflates the operating total; that is what this fixes.

   SAVED ON CHANGE, WITH NO CONFIRM. The act is reversible by making the same
   change again, it is logged server-side with the value it replaced, and a
   dialog guarding a reclassification would be a dialog nobody reads. The ledger
   caches are dropped exactly as a decision drops them — this wrote to the same
   table they are drawn from. */
window.finAprFile = async function finAprFile(id, value) {
  const claim = Number(id);
  const category = String(value == null ? '' : value);
  // An empty pick on an approved claim is not a request to unfile it — the
  // server refuses one — so it is a no-op that puts the row back as it was.
  if (!claim || !category || FIN_APR_BUSY) { finAprRender(); return; }
  FIN_APR_BUSY = claim;
  finAprRender();
  try {
    await api('/api/retail-admin/staff-expenses/' + claim + '/category',
      { method: 'POST', body: { category } });
    FIN_APR_BUSY = 0;
    FIN_TX = null; FIN_TX_SEEN = false;     // the ledger row this just re-posted
    FIN_DATA = null;                        // and the staircase drawn from it
    await finAprLoad();
    if (window.toast) toast(cuT('Saved', '已保存'));
  } catch (e) {
    FIN_APR_BUSY = 0;
    if (window.toast) toast(e.message, 'err');
    finAprRender();
  }
};

/* ── DECIDING ───────────────────────────────────────────────────────────────
   **THE TAP THAT PUTS MONEY IN THE BOOKS.** Approving posts one row into
   `expense_entries` carrying this claim's id; rejecting takes it back out. Both
   happen server-side inside one transaction with the claim's own status, so a
   claim that says approved with no row behind it cannot exist.

   THE LEDGER BEHIND THIS SCREEN IS NOW STALE, and the code says so rather than
   leaving it to be discovered: a decision writes `expense_entries`, which is
   exactly what Transactions and the Summary staircase are reading. Both are
   dropped so the next visit re-pulls, instead of showing an operator a total
   that does not include the ¥38 they just approved. */
window.finAprDecide = async function finAprDecide(id, decision) {
  const claim = Number(id);
  if (!claim || FIN_APR_BUSY) return;
  /* §146 — THE CATEGORY GOES WITH THE APPROVAL, in the same request that posts
     the row. A second call afterwards could fail on its own and leave the ledger
     holding a classification nobody chose. Sent only on approve and only when
     something was picked: the field is absent otherwise, and the server leaves
     the claim's own value alone (`COALESCE`) rather than blanking it. */
  const picked = FIN_APR_CAT[claim];
  const body = (decision === 'approve' && picked) ? { decision, category: picked } : { decision };
  /* §207 — AND SO DOES WHO PAID, in the same request and for the same reason.
     Sent only on approve and only where it DIFFERS from what the claim already
     says: the field is absent otherwise, and the server leaves the claim's own
     answer alone (`COALESCE`) rather than blanking it — which matters here more
     than for the category, because a blank `paid_by` has no meaning at all. */
  const paid = FIN_APR_PAID[claim];
  const row = (FIN_APR && FIN_APR.rows || []).find(r => r.id === claim);
  if (decision === 'approve' && paid && row && paid !== row.paid_by) body.paid_by = paid;
  FIN_APR_BUSY = claim;
  finAprRender();
  try {
    await api('/api/retail-admin/staff-expenses/' + claim + '/decide',
      { method: 'POST', body });
    FIN_APR_BUSY = 0;
    // The pick is spent — the claim carries it now. Left here it would be
    // offered back on the decided row, over whatever the server actually stored.
    delete FIN_APR_CAT[claim];
    delete FIN_APR_PAID[claim];
    FIN_APR_SHOT = null;
    FIN_TX = null; FIN_TX_SEEN = false;     // the ledger this just wrote to
    FIN_DATA = null;                        // and the staircase drawn from it
    await finAprLoad();
    if (window.toast) toast(decision === 'approve' ? cuT('Approved', '已通过') : cuT('Not approved', '已拒绝'));
  } catch (e) {
    FIN_APR_BUSY = 0;
    if (window.toast) toast(e.message, 'err');
    finAprRender();
  }
};

/* ── MARKING A DEBT PAID (§87 step four) ────────────────────────────────────
   **IT POSTS NOTHING TO THE BOOKS** — the ¥38 was recorded once, when the claim
   was approved, and a second row for the repayment would report ¥76 of taxis.
   What it changes is the answer to "who are we still out of pocket to", which
   the ledger cannot give.

   ONE PERSON AT A TIME, EVERY CLAIM AT ONCE, because that is how it is actually
   paid: one transfer to Wei, not four clicks. The confirm names the person and
   the figure, since this is an assertion that money has already changed hands
   somewhere this app cannot see. */
window.finAprSettle = async function finAprSettle(idx) {
  if (FIN_APR_BUSY) return;
  /* THE ROW IS LOOKED UP AT CLICK TIME, and only its INDEX travels through the
     markup. A name is free text somebody typed into `tenant_users`, and pushing
     one through an onclick attribute means it survives two decoders — HTML
     entities, then the JS string literal — so an apostrophe in O'Brien ends the
     argument early and a quiet syntax error eats the click. Nothing but a number
     goes in the attribute, and the payload the screen is already holding
     supplies the rest. The confirm below then names whoever is in the row NOW,
     so a background poll that reshaped the list cannot leave the operator
     agreeing to a sentence about somebody else. */
  const o = (FIN_APR && FIN_APR.owed || [])[Number(idx)];
  if (!o) return;
  const total = finAprMoney(o.total);
  const list = String(o.ids || '').split(',').map(Number).filter(Boolean);
  if (!list.length) return;
  const person = o.who || cuT('Someone', '未知');
  // §269. BELOW ZERO THE MONEY RUNS THE OTHER WAY: this person holds a refund
  // for something returned after they were paid back, and the tap records
  // that they have handed it over. Same route, same claims — settling a claim
  // absorbs its returns (lib/expense-returns.js).
  const owes = Number(o.total) < 0;
  if (owes && typeof askConfirm === 'function') {
    if (!(await askConfirm({
      title: cuT('Recovered ' + finAprMoney(Math.abs(Number(o.total))) + '?', '已收回 ' + finAprMoney(Math.abs(Number(o.total))) + '？'),
      body: person,
      confirmLabel: cuT('Mark recovered', '标记已收回'),
    }))) return;
  } else if (typeof askConfirm === 'function') {
    if (!(await askConfirm({
      title: cuT('Paid ' + total + ' back?', '已付款 ' + total + '？'),
      body: cuT('This records that ' + person + ' has been paid back. It does not change the accounts — the expense was recorded when it was approved.',
                '记录已向' + person + '付款。不会改动账目 — 该费用在审批通过时已记入。'),
      confirmLabel: cuT('Mark paid', '标记已付'),
    }))) return;
  }
  FIN_APR_BUSY = -1;
  finAprRender();
  try {
    // Sequential rather than parallel, the phone's reasoning unchanged: four
    // writes racing on one connection is how a settle ends with two applied.
    for (const claim of list) {
      await api('/api/retail-admin/staff-expenses/' + claim + '/settle',
        { method: 'POST', body: { settled: true } });
    }
    FIN_APR_BUSY = 0;
    await finAprLoad();
    if (window.toast) toast(cuT('Marked paid', '已标记付款'));
  } catch (e) {
    FIN_APR_BUSY = 0;
    if (window.toast) toast(e.message, 'err');
    // Reloaded rather than repainted: a run that failed on the third of four
    // left two settled, and the screen has to show which.
    await finAprLoad();
  }
};

// The status pill for a claim that has already been decided. APPROVED SPLITS IN
// TWO, and that is the point of it: a claim paid out of somebody's pocket is
// still open to them until it is settled, so "approved" alone would report a
// debt as finished. Sage for done, Amber for still owed — §1.10, and the same
// division the phone makes.
function finAprPill(r) {
  if (r.status === 'approved') {
    // §269: a claim returned in full before it was paid back owes nobody.
    const owed = r.paid_by === 'employee' && !Number(r.settled)
      && (Number(r.amount) - Number(r.returned || 0)) > 0;
    /* `Owed to your team · 应付团队` AND NOT THE PHONE'S `Owed · 应付您`, though
       both are live and the phone uses the second one on this very screen.
       应付您 is "owed to YOU", written for expStatusPill's first home — the
       employee reading their own claims, where it is exactly right. An approver
       working a queue is reading other people's, and a pill telling them the
       shop owes THEM for Wei's taxi is wrong on every row but their own. The
       pair taken instead is the heading of the block above that lists these same
       claims, so the pill and the block name one thing. Nothing composed. */
    return owed
      ? `<span class="fin-apr-pill is-owed">${escapeHtml(cuT('Owed to your team', '应付团队'))}</span>`
      : `<span class="fin-apr-pill is-ok">${escapeHtml(cuT('Approved', '已通过'))}</span>`;
  }
  if (r.status === 'rejected') {
    return `<span class="fin-apr-pill is-no">${escapeHtml(cuT('Not approved', '已拒绝'))}</span>`;
  }
  // §90. NOT `is-no` — a voided claim was legitimately approved and later
  // reversed, which is a different fact from having been refused from the
  // start, so it gets the neutral pill rather than Brick's refusal colour.
  if (r.status === 'voided') {
    return `<span class="fin-apr-pill">${escapeHtml(cuT('Voided', '已作废'))}</span>`;
  }
  return `<span class="fin-apr-pill">${escapeHtml(cuT('Waiting', '待审批'))}</span>`;
}

// One claim. The meta line is the phone's, in the phone's order: date, category,
// and whose money it was — the three facts an approver reads before deciding.
function finAprRow(r) {
  const waiting = r.status === 'submitted';
  const busy = FIN_APR_BUSY === r.id;
  const anyBusy = !!FIN_APR_BUSY;
  const bits = [finTxDay(r.date)];
  /* §146 — A BLANK CATEGORY SAYS SO. It used to render as nothing at all, so a
     claim with no category and one filed under Transport looked the same on this
     line — which is how a ¥299 taxi reached the books unfiled with nobody
     noticing. `Not recorded` is the word Finance already uses for exactly this
     value, two screens over. Said only where no picker follows: on a row that
     carries one, the picker's own blank option says it better. */
  const filing = finAprCatCell(r);
  if (r.category) bits.push(finCatLabel(r.category));
  else if (!filing) bits.push(cuT('Not recorded', '未记录'));
  /* §207 — SAID ON THE META LINE ONLY WHERE NO PICKER FOLLOWS, the rule the
     blank category one line above already follows. A row carrying the control
     would otherwise state the same fact twice, two lines apart, and the one
     that can be changed is the one worth reading. */
  const whoPaid = finAprPaidCell(r);
  if (!whoPaid) bits.push(r.paid_by === 'employee' ? cuT('own money', '个人支付') : cuT('company', '公司'));
  // §114. On the meta line beside whose money it was, because it is the same
  // kind of fact about the purchase — and because an approver reads this line
  // before pressing anything.
  if (Number(r.awaiting_delivery) && !r.po_id) bits.push(cuT('goes on a purchase order', '将记入采购单'));

  /* WHOSE CLAIM IT IS, FROM THE SERVER. §87 part five allows an approver to
     approve their own claim and makes the RECORD the guard rather than a
     refusal — so the row has to say so. `mine` is computed server-side because
     it is the only side that knows both the claim's submitter and the caller;
     the phone's first attempt read it off a client-held identity that carries a
     name and a role and no id, and the marker silently never appeared. */
  const mine = r.mine
    ? `<span class="fin-apr-mine">${escapeHtml(cuT('Your own claim', '本人提交'))}</span>`
    : '';

  /* §114 — THE GOODS HAVE NOT ARRIVED, SO APPROVING THIS RAISES AN ORDER.
     Said BEFORE the decision, not only after it: approving a claim here normally
     writes a ledger row and nothing else, and an approver who was not told would
     find a purchase order in the buying list with no idea where it came from.

     AFTERWARDS IT IS A WAY IN. The claim has no ledger row of its own — the
     order owns the cost — so the order is the only place the money can be read,
     and `Open purchase order · 查看采购单` is the pair this screen already uses
     for exactly that jump, one function up (finTxOpenPO). Nothing composed for
     the link. */
  const coming = Number(r.awaiting_delivery)
    ? (r.po_id
        ? `<a class="fin-apr-po" href="#" onclick="finTxOpenPO(${Number(r.po_id)});return false">`
          + escapeHtml(cuT('Open purchase order', '查看采购单')) + '</a>'
        : `<span class="fin-apr-coming">${escapeHtml(cuT('Not arrived yet', '尚未到货'))}</span>`)
    : '';

  const shotOpen = FIN_APR_SHOT && FIN_APR_SHOT.id === r.id;
  const shotBtn = r.has_receipt
    ? `<button type="button" class="fin-btn-sec fin-apr-shotbtn" onclick="finAprShot(${r.id})">`
      + escapeHtml(shotOpen ? cuT('Hide photo', '收起照片') : cuT('View photo', '查看照片'))
      + '</button>'
    : '';

  /* APPROVE LEADS AND REJECT DOES NOT, because the queue exists to be cleared
     and most claims in it are real. Reject is a plain control beside it rather
     than a danger-red one: refusing a ¥38 taxi is an ordinary decision, and
     colouring it as an alarm would make an approver hesitate over the one they
     are meant to make. (The phone's argument, and its layout.)

     APPROVE IS INK, NOT DUSK. It shipped as a `.fin-cta` and therefore in the
     AI's colour, which §1.8 refuses on two counts: one Dusk CTA per page and
     this one repeats per row, and — the half that decides it — Dusk means
     *tacet did this for you*, while an approver deciding a claim is the
     operator acting. Same axis as the modal-primary correction. The styling
     lives on `.fin-apr-yes` in the stylesheet.

     EVERY BUTTON IN THE LIST DISABLES WHILE ANY WRITE IS IN FLIGHT, but only the
     row being decided says "Working…". A settle is a run of writes over claims
     that are also in this list, and leaving the rest live invites a second
     decision landing on a queue the first one is still reshaping. */
  const actions = waiting
    ? `<div class="fin-apr-acts">`
      + `<button type="button" class="fin-apr-yes"${anyBusy ? ' disabled' : ''} `
      + `onclick="finAprDecide(${r.id}, 'approve')">`
      + escapeHtml(busy ? cuT('Working…', '处理中…') : cuT('Approve', '通过')) + '</button>'
      + `<button type="button" class="fin-btn-sec"${anyBusy ? ' disabled' : ''} `
      + `onclick="finAprDecide(${r.id}, 'reject')">${escapeHtml(cuT('Reject', '拒绝'))}</button>`
      + '</div>'
    : finAprPill(r);

  const shotCell = shotOpen
    ? '<tr class="fin-apr-shot"><td colspan="4">'
      + (FIN_APR_SHOT.data
        ? `<img src="${escapeAttr(FIN_APR_SHOT.data)}" alt="${escapeAttr(cuT('Receipt', '照片'))}">`
        : FIN_APR_SHOT.err
          ? `<span class="fin-apr-shoterr">${escapeHtml(FIN_APR_SHOT.err)}</span>`
          : `<span class="fin-apr-shoterr">${escapeHtml(cuT('Loading…', '加载中…'))}</span>`)
      + '</td></tr>'
    : '';

  return '<tr>'
    + `<td class="fin-tx-date">${escapeHtml(finTxDay(r.date))}</td>`
    + '<td><span class="fin-apr-who">' + escapeHtml(r.who || cuT('Someone', '未知')) + mine + '</span>'
    + `<span class="fin-tx-meta">${escapeHtml(bits.join(' · '))}</span>`
    + (r.note ? `<span class="fin-apr-note">${escapeHtml(r.note)}</span>` : '')
    // Under the note and above everything optional: it is a fact about the
    // claim, and the receipt and the order link are ways OUT of the row.
    + filing
    // §207 — beside the category and for the same reason it sits there: both are
    // facts about the claim that the approver may correct, and everything below
    // them is a way OUT of the row.
    + whoPaid
    + (coming ? `<span class="fin-apr-comingwrap">${coming}</span>` : '')
    + (shotBtn ? `<span class="fin-apr-shotwrap">${shotBtn}</span>` : '')
    + '</td>'
    + `<td class="fin-tx-num">${escapeHtml(finAprMoney(r.amount))}</td>`
    + `<td class="fin-apr-act">${actions}</td>`
    + '</tr>'
    + shotCell;
}

function finAprRender() {
  const host = document.getElementById('fin-apr-list');
  if (!host || !FIN_APR) return;
  const rows = FIN_APR.rows || [];
  const waiting = rows.filter(r => r.status === 'submitted');
  const done = rows.filter(r => r.status !== 'submitted');

  /* THE THREE BLOCKS BELOW ARE DIVs AND MUST STAY DIVs — §1.22. Inside
     retail-admin.html a <section> means "a tab page": the unscoped
     `section { display: none }` that runs the tab system matches every one at
     any depth, so a block emitted as <section> renders into the DOM with real
     content and no box. All three shipped as <section> and were invisible from
     §87 step three until 2026-09-10 — the fourth time this rule has bitten. */

  /* WHAT THE SHOP STILL OWES ITS OWN PEOPLE, above the queue.

     IT IS A DIFFERENT KIND OF THING FROM EVERYTHING BELOW IT — those are
     decisions waiting to be made; this is money already spent and not yet handed
     back — so it is a block of its own with its own verb, and it is ABSENT when
     nothing is owed rather than rendering a zero (§1.12).

     THE ROW IS A PERSON, NOT A CLAIM, because that is how it gets paid. */
  // §269: below zero is a person holding the shop's refund. Listed in the same
  // block — it is the same question, which way money is still to move — and
  // marked so it cannot be read as owed to them.
  const owed = (FIN_APR.owed || []).filter(o => Number(o.total) !== 0);
  const owedBlock = owed.length
    ? '<div class="fin-apr-owed"><h3>' + escapeHtml(cuT('Owed to your team', '应付团队')) + '</h3>'
      /* ITS OWN COLGROUP, and it is not decoration. .fin-tx-table is
         `table-layout: fixed`, so a table shipped without one splits its columns
         EVENLY — three at 33% here, against the queue table's 58/16/26 directly
         below. The amount and the button would sit in different places in two
         stacked tables on one screen, which reads as a mis-drawn page. The
         widths below are the queue's own: 12 + 46 collapsed into one Who column,
         then the same amount and action columns, so the three line up. */
      + '<div class="fin-tx-card"><table class="fin-tx-table">'
      + '<colgroup><col class="fin-apr-c-who"><col class="fin-c-amt"><col class="fin-apr-c-act"></colgroup>'
      + '<tbody>'
      + owed.map((o, i) => {
        const owes = Number(o.total) < 0;
        const money = owes ? '−' + finAprMoney(Math.abs(Number(o.total))) : finAprMoney(o.total);
        const n = Number(o.claims) || 0;
        return '<tr><td><span class="fin-apr-who">' + escapeHtml(o.who || cuT('Someone', '未知')) + '</span>'
          /* THE NUMERAL SITS OUTSIDE THE PAIR, which is the phone's shape and
             the house rule both: `${n} ${T('claim','笔')}`. Folding the count in
             — cuT('3 claims', '3 笔') — mints a brand-new pair for every value n
             can take, none of them declarable and all of them indistinguishable
             from a locked string once shipped. The Chinese half is 笔 at any
             count; only English inflects. */
          + `<span class="fin-tx-meta">${n} ${escapeHtml(cuT(n === 1 ? 'claim' : 'claims', '笔'))}`
          + (owes ? ` · ${escapeHtml(cuT('Owes the shop', '应退还店里'))}` : '') + '</span></td>'
          + `<td class="fin-tx-num">${escapeHtml(money)}</td>`
          + '<td class="fin-apr-act"><button type="button" class="fin-btn-sec"'
          + (FIN_APR_BUSY ? ' disabled' : '')
          + ` onclick="finAprSettle(${i})">`
          + escapeHtml(owes ? cuT('Mark recovered', '标记已收回') : cuT('Mark paid', '标记已付')) + '</button></td></tr>';
      }).join('')
      + '</tbody></table></div>'
      /* THE SENTENCE THAT KEEPS THE BUTTON HONEST, and it is the third of a set
         written to be read together (vocabulary v1.48): nothing is in the books
         until approval; approving records it; and paying it back changes
         nothing, because it was already recorded. */
      + `<p class="fin-apr-foot">${escapeHtml(cuT(
          'Marking paid does not change the accounts — the expense was recorded when it was approved.',
          '标记已付不会改动账目 — 该费用在审批通过时已记入。'))}</p>`
      + '</div>'
    : '';

  const table = (list) => '<div class="fin-tx-card"><table class="fin-tx-table">'
    + '<colgroup><col class="fin-c-date"><col class="fin-c-desc">'
    + '<col class="fin-c-amt"><col class="fin-apr-c-act"></colgroup>'
    + '<thead><tr>'
    + `<th>${escapeHtml(cuT('Date', '日期'))}</th>`
    /* `Asked by · 申请人` is LIVE at 16-purchasing.js:806, heading the column
       that names who raised a request — in a table, in this admin, for the same
       kind of thing. Reused rather than minting a `Who`. */
    + `<th>${escapeHtml(cuT('Asked by', '申请人'))}</th>`
    + `<th class="fin-tx-num">${escapeHtml(cuT('Amount', '金额'))}</th>`
    + '<th>&nbsp;</th></tr></thead><tbody>'
    + list.map(finAprRow).join('')
    + '</tbody></table></div>';

  /* §1.12 — AN EMPTY QUEUE IS A COMPLIMENT, NOT A GAP. There is nothing to retry
     and nothing to configure; everything that was sent has been decided. The two
     empty states are different facts and say different things: nothing has ever
     arrived, versus nothing is left. */
  const queue = waiting.length
    ? '<div class="fin-apr-queue"><h3>' + escapeHtml(cuT('Waiting', '待审批'))
      + ' · ' + waiting.length + '</h3>'
      + table(waiting)
      /* THE SENTENCE THAT MAKES THE BUTTON HONEST. Mirror of the one under
         Submit on the phone: there, nothing is in the accounts yet; here,
         approving is what puts it there. */
      + `<p class="fin-apr-foot">${escapeHtml(cuT(
          'Approving records the expense in this month’s accounts.',
          '审批通过后即记入本月账目。'))}</p>`
      + '</div>'
    : `<div class="fin-tx-state"><h3>${escapeHtml(cuT('Nothing waiting', '暂无待审批'))}</h3>`
      + `<p>${escapeHtml(done.length
          ? cuT('Everything your team has sent has been decided.', '团队提交的记录都已处理。')
          : cuT('Expenses your team records will arrive here for you to approve.',
                '团队登记的费用会出现在这里等待审批。'))}</p></div>`;

  const history = done.length
    ? '<div class="fin-apr-done"><h3>' + escapeHtml(cuT('Already decided', '已处理')) + '</h3>'
      + table(done) + '</div>'
    : '';

  host.innerHTML = owedBlock + queue + history;
}
