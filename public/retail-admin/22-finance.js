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
  return '¥' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
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
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  let from = today;
  if (key === '7')  from = new Date(Date.now() + 8 * 3600 * 1000 - 6  * 86400000).toISOString().slice(0, 10);
  if (key === '30') from = new Date(Date.now() + 8 * 3600 * 1000 - 29 * 86400000).toISOString().slice(0, 10);
  if (key === '90') from = new Date(Date.now() + 8 * 3600 * 1000 - 89 * 86400000).toISOString().slice(0, 10);
  const f = document.getElementById('fin-from'), t = document.getElementById('fin-to');
  if (f) f.value = from;
  if (t) t.value = today;
  finLoad();
}

// The echo on the title line. dashRangeLabel's shape minus its store half —
// there is no store dimension on this screen, so naming one would be a claim.
function finRangeLabel() {
  const el = document.getElementById('fin-range');
  if (!el) return;
  const from = (document.getElementById('fin-from') || {}).value;
  const to = (document.getElementById('fin-to') || {}).value;
  if (!from || !to) { el.textContent = ''; return; }
  const cn = window.cuLang && cuLang() === 'cn';
  const fmt = s => {
    const d = new Date(s + 'T00:00:00');
    return cn ? `${d.getMonth() + 1}月${d.getDate()}日`
              : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
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

/** The operating-expense disclosure. Open by default. */
function finBreakdown(rows) {
  if (!rows || !rows.length) return '';
  // The set is passed whole so the collision rule can see it: two categories
  // that read alike in this language both render in full rather than drawing
  // two lines nobody can tell apart.
  const labels = finCatLabels(rows.map(r => r.category));
  return '<div class="fin-breakdown">' + rows.map(r => {
    // A row whose category was never typed keeps its own line and gets the
    // §1.12 seventh-state word rather than an invented bucket name: §36 records
    // that Finance stores category text raw and un-normalised, so a label
    // minted here would be a second wrong name on a known-dirty column.
    const label = r.category
      ? (labels.get(r.category) || finCatLabel(r.category))
      : cuT('Not recorded', '未记录');
    return '<div class="fin-row">'
      + `<span class="fin-lbl">${escapeHtml(label)}</span>`
      + '<span class="fin-sign"></span>'
      + `<span class="fin-fig">${escapeHtml(finMoney(r.amount))}</span>`
      + '</div>';
  }).join('') + '</div>';
}

function finRender() {
  const host = document.getElementById('fin-stair');
  if (!host || !FIN_DATA) return;
  const d = FIN_DATA;

  const expLabel = cuT('Operating expenses', '营业费用');
  const breakdown = finBreakdown(d.expense_breakdown);

  host.innerHTML = '<div class="fin-card"><div class="fin-body">'
    // Line 1 — Revenue. Every channel the order record carries, gzgrocery
    // included, wallet top-ups excluded (§36).
    + finRow(cuT('Revenue', '营收'), finMoney(d.revenue))
    // Lines 2 and 3 — the two the mockup could not have. Labels kept, figures
    // absent, no dash, and one sentence under the pair.
    + finRow(cuT('Cost of goods', '销货成本'), finNotRecordedValue(), { less: true, notrec: true })
    + finRow(cuT('Gross profit', '毛利润'), finNotRecordedValue(), { concl: true, notrec: true })
    + finNotRecorded()
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
    + '</div></div></div>';
}

// ── Load ───────────────────────────────────────────────────────────────────
async function finLoad(opts) {
  const host = document.getElementById('fin-stair');
  if (!host) return;
  const from = (document.getElementById('fin-from') || {}).value;
  const to = (document.getElementById('fin-to') || {}).value;
  finRangeLabel();

  // §1.12: the skeleton is for a REAL load only. On a refresh the current card
  // stays up — a poller or a re-read never puts a placeholder over data that is
  // already on screen.
  if (!FIN_DATA) host.innerHTML = '<div class="fin-skel"></div>';

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
  document.querySelectorAll('#fin-subviews button')
    .forEach(b => b.classList.toggle('on', b.dataset.sub === which));
  const stair = document.getElementById('fin-stair');
  const tx = document.getElementById('fin-tx');
  if (stair) stair.hidden = isTx;
  if (tx) tx.hidden = !isTx;
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
  return (r.kind === 'out' ? '−' : '+') + finMoney(r.amount);
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
    : '';
  // The date is the PO's own, never `created_at` — the route never selects
  // created_at, so there is nothing here that could drift onto a row.
  return `<tr class="${po ? 'fin-tx-posted' : ''}">`
    + `<td class="fin-tx-date">${escapeHtml(finTxDay(r.date))}</td>`
    + `<td><span class="fin-tx-subj">${escapeHtml(finTxSubject(r))}</span>`
    + (mark || hint ? `<span class="fin-tx-meta">${mark}${mark && hint ? ' · ' : ''}${hint}</span>` : '')
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
    + '<td>' + (po
      ? (r.po_open === false ? ''
        : `<a class="fin-tx-act" href="#" onclick="finTxOpenPO(${Number(r.po_id)});return false">${escapeHtml(cuT('Open purchase order', '查看采购单'))}</a>`)
      : (typeof can === 'function' && !can('finance:record')) ? ''
      : `<a class="fin-tx-act" href="#" onclick="finTxEdit('${escapeHtml(String(r.kind))}',${Number(r.id)});return false">${escapeHtml(cuT('Edit', '编辑'))}</a>`)
    + '</td>'
    + '</tr>';
}

/* §1.18 — the English surface renders US dates, and the year is omitted because
   every row is inside the selected window. */
function finTxDay(d) {
  if (!d) return '';
  const dt = new Date(String(d) + 'T00:00:00');
  if (isNaN(dt)) return String(d);
  return (window.cuLang && cuLang() === 'cn')
    ? `${dt.getMonth() + 1}月${dt.getDate()}日`
    : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
      + `<div class="fin-tx-v">${escapeHtml(finMoney(d.totals.in))}</div></div>`;
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
  finTxCatList();
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
  return FIN_TX_KIND === 'in'
    ? finIncomeCats()
    : [...new Set(((FIN_TX && FIN_TX.rows) || [])
        .filter(r => r.kind === 'out' && r.category).map(r => r.category))].sort();
}

function finTxCatList() {
  const dl = document.getElementById('fin-tx-cats');
  if (!dl) return;
  const labels = finCatLabels(finTxCatOptions());
  dl.innerHTML = [...labels.values()]
    .map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
}

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
  set('fin-tx-date', row ? row.date : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10));
  set('fin-tx-amount', row ? row.amount : '');
  // The label, not the stored value — and finTxSave maps it back, so the
  // round trip does not rewrite the category of a row merely opened and saved.
  set('fin-tx-cat', row && row.category ? finCatLabel(row.category) : '');
  set('fin-tx-note', row && row.source === 'manual' && row.subject && row.subject !== row.category ? row.subject : '');
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

window.finTxSave = function finTxSave() {
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

/* Edit a typed row, looked up in the payload already on screen rather than
   re-fetched: the row the operator clicked is the row they are looking at. */
window.finTxEdit = function finTxEdit(kind, id) {
  if (!FIN_TX) return;
  const row = FIN_TX.rows.find(r => r.kind === kind && String(r.id) === String(id));
  if (row && row.source !== 'po') finTxForm(null, row);
};
