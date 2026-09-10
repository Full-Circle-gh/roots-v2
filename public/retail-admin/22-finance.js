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
  // The disclosure shows the OPERATING half only, because it is the disclosure
  // ON the operating-expenses row: a line inside it that the figure above did
  // not include would be a breakdown that does not add up to its own total.
  const breakdown = finBreakdown(finOperating(d.expense_breakdown));
  const excluded = finNonOperating(d.expense_breakdown);

  host.innerHTML = '<div class="fin-card"><div class="fin-body">'
    // Line 1 — Revenue. Every channel the order record carries, gzgrocery
    // included, wallet top-ups excluded (§36).
    + finRow(cuT('Revenue', '营收'), finMoney(d.revenue))
    // Tax collected (audit I-03), and ONLY where a shop has charged some: the
    // block is null otherwise, so nothing about this screen changes for a shop
    // that charges none. It renders directly under revenue because that is
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
    + (d.tax
      ? finRow(cuT('of which tax', '其中税费'), finMoney(d.tax.net))
      : '')
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
            + `</summary>${finBreakdown(excluded)}</details>`
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
  if (isCats && !FIN_CATS_SEEN) { FIN_CATS_SEEN = true; finCatsLoad(); }
  // A payload the dot poller already pulled paints immediately; the fetch is
  // only for the first visit that beat it.
  if (isApr) {
    FIN_APR_SEEN = true;
    if (FIN_APR) finAprRender(); else finAprLoad();
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
  /* §87 step three. THE SECOND KIND OF PROJECTION, and it gets the SAME
     treatment as the first for the same reason: a claim re-posts its ledger row
     on every decision, so an edit made here would be silently undone the next
     time somebody changed their mind about the claim. Tinted, marked, and no
     Edit — §36's "the row explains its own constraint instead of merely
     enforcing it", applied to the other document that owns rows in this table.

     §88 AMENDS THE "NO LINK OUT" NOTE THIS BLOCK USED TO CARRY, RATHER THAN
     LEAVING IT STANDING WRONG: the row now offers Void, requested by Ash off
     this exact screen — a claim posted by mistake had no way back except
     editing a row that would only be regenerated. Void is not Edit: it does not
     let a value be typed onto this row, it reverses the CLAIM's own decision
     (`finTxVoidClaim`, calling the claim's `/void` endpoint) and lets the same
     mechanism that deletes this row on rejection delete it here too. */
  const claim = r.source === 'claim';
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
    : '';
  // The date is the PO's own, never `created_at` — the route never selects
  // created_at, so there is nothing here that could drift onto a row.
  return `<tr class="${po || claim ? 'fin-tx-posted' : ''}">`
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
    //
    // A CLAIM ROW OFFERS VOID (§88), NOT EDIT, AND ONLY TO `expenses:cancel` —
    // a distinct capability from `finance:record`, because reversing somebody
    // else's approval is not the same power as typing a ledger row by hand.
    // HIDDEN ONCE SETTLED, for the same reason the server refuses the write:
    // the employee has already been paid back for this claim, and a control
    // that failed every time it was pressed is the fault §36 names.
    + '<td>' + (po
      ? (r.po_open === false ? ''
        : `<a class="fin-tx-act" href="#" onclick="finTxOpenPO(${Number(r.po_id)});return false">${escapeHtml(cuT('Open purchase order', '查看采购单'))}</a>`)
      : claim
      ? ((typeof can === 'function' && can('expenses:cancel') && !r.settled)
        ? `<a class="fin-tx-act" href="#" onclick="finTxVoidClaim(${Number(r.claim_id)});return false">${escapeHtml(cuT('Void', '作废'))}</a>`
        : '')
      : (typeof can === 'function' && !can('finance:record')) ? ''
      : `<a class="fin-tx-act" href="#" onclick="finTxEdit('${escapeHtml(String(r.kind))}',${Number(r.id)});return false">${escapeHtml(cuT('Edit', '编辑'))}</a>`)
    + '</td>'
    + '</tr>';
}

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
  if (FIN_TX_KIND === 'in') return finIncomeCats();
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
  // A new row defaults to the STORE's today: the operator is dating a
  // transaction in the shop's books, not on their laptop's calendar.
  set('fin-tx-date', row ? row.date : tdToday());
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

/* Void a posted claim (§88). NOT finTxDelete: that endpoint refuses a
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
   `/staff-expenses/:id/receipt` scopes to `submitted_by` and therefore serves an
   approver NOTHING for anybody else's claim. Until that route is widened, this
   control tells the operator the photo could not be read rather than looking
   broken — and it needs no change when it is.

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
  FIN_APR_BUSY = claim;
  finAprRender();
  try {
    await api('/api/retail-admin/staff-expenses/' + claim + '/decide',
      { method: 'POST', body: { decision } });
    FIN_APR_BUSY = 0;
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
  if (typeof askConfirm === 'function') {
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
    const owed = r.paid_by === 'employee' && !Number(r.settled);
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
  // §88. NOT `is-no` — a voided claim was legitimately approved and later
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
  if (r.category) bits.push(finCatLabel(r.category));
  bits.push(r.paid_by === 'employee' ? cuT('own money', '个人支付') : cuT('company', '公司'));

  /* WHOSE CLAIM IT IS, FROM THE SERVER. §87 part five allows an approver to
     approve their own claim and makes the RECORD the guard rather than a
     refusal — so the row has to say so. `mine` is computed server-side because
     it is the only side that knows both the claim's submitter and the caller;
     the phone's first attempt read it off a client-held identity that carries a
     name and a role and no id, and the marker silently never appeared. */
  const mine = r.mine
    ? `<span class="fin-apr-mine">${escapeHtml(cuT('Your own claim', '本人提交'))}</span>`
    : '';

  const shotOpen = FIN_APR_SHOT && FIN_APR_SHOT.id === r.id;
  const shotBtn = r.has_receipt
    ? `<button type="button" class="fin-btn-sec fin-apr-shotbtn" onclick="finAprShot(${r.id})">`
      + escapeHtml(shotOpen ? cuT('Hide photo', '收起照片') : cuT('View photo', '查看照片'))
      + '</button>'
    : '';

  /* APPROVE IS THE CTA AND REJECT IS NOT, because the queue exists to be cleared
     and most claims in it are real. Reject is a plain control beside it rather
     than a danger-red one: refusing a ¥38 taxi is an ordinary decision, and
     colouring it as an alarm would make an approver hesitate over the one they
     are meant to make. (The phone's argument, and its layout.)

     EVERY BUTTON IN THE LIST DISABLES WHILE ANY WRITE IS IN FLIGHT, but only the
     row being decided says "Working…". A settle is a run of writes over claims
     that are also in this list, and leaving the rest live invites a second
     decision landing on a queue the first one is still reshaping. */
  const actions = waiting
    ? `<div class="fin-apr-acts">`
      + `<button type="button" class="fin-cta fin-apr-yes"${anyBusy ? ' disabled' : ''} `
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

  /* WHAT THE SHOP STILL OWES ITS OWN PEOPLE, above the queue.

     IT IS A DIFFERENT KIND OF THING FROM EVERYTHING BELOW IT — those are
     decisions waiting to be made; this is money already spent and not yet handed
     back — so it is a block of its own with its own verb, and it is ABSENT when
     nothing is owed rather than rendering a zero (§1.12).

     THE ROW IS A PERSON, NOT A CLAIM, because that is how it gets paid. */
  const owed = (FIN_APR.owed || []).filter(o => Number(o.total) > 0);
  const owedBlock = owed.length
    ? '<section class="fin-apr-owed"><h3>' + escapeHtml(cuT('Owed to your team', '应付团队')) + '</h3>'
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
        const money = finAprMoney(o.total);
        const n = Number(o.claims) || 0;
        return '<tr><td><span class="fin-apr-who">' + escapeHtml(o.who || cuT('Someone', '未知')) + '</span>'
          /* THE NUMERAL SITS OUTSIDE THE PAIR, which is the phone's shape and
             the house rule both: `${n} ${T('claim','笔')}`. Folding the count in
             — cuT('3 claims', '3 笔') — mints a brand-new pair for every value n
             can take, none of them declarable and all of them indistinguishable
             from a locked string once shipped. The Chinese half is 笔 at any
             count; only English inflects. */
          + `<span class="fin-tx-meta">${n} ${escapeHtml(cuT(n === 1 ? 'claim' : 'claims', '笔'))}</span></td>`
          + `<td class="fin-tx-num">${escapeHtml(money)}</td>`
          + '<td class="fin-apr-act"><button type="button" class="fin-btn-sec"'
          + (FIN_APR_BUSY ? ' disabled' : '')
          + ` onclick="finAprSettle(${i})">`
          + escapeHtml(cuT('Mark paid', '标记已付')) + '</button></td></tr>';
      }).join('')
      + '</tbody></table></div>'
      /* THE SENTENCE THAT KEEPS THE BUTTON HONEST, and it is the third of a set
         written to be read together (vocabulary v1.48): nothing is in the books
         until approval; approving records it; and paying it back changes
         nothing, because it was already recorded. */
      + `<p class="fin-apr-foot">${escapeHtml(cuT(
          'Marking paid does not change the accounts — the expense was recorded when it was approved.',
          '标记已付不会改动账目 — 该费用在审批通过时已记入。'))}</p>`
      + '</section>'
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
    ? '<section class="fin-apr-queue"><h3>' + escapeHtml(cuT('Waiting', '待审批'))
      + ' · ' + waiting.length + '</h3>'
      + table(waiting)
      /* THE SENTENCE THAT MAKES THE BUTTON HONEST. Mirror of the one under
         Submit on the phone: there, nothing is in the accounts yet; here,
         approving is what puts it there. */
      + `<p class="fin-apr-foot">${escapeHtml(cuT(
          'Approving records the expense in this month’s accounts.',
          '审批通过后即记入本月账目。'))}</p>`
      + '</section>'
    : `<div class="fin-tx-state"><h3>${escapeHtml(cuT('Nothing waiting', '暂无待审批'))}</h3>`
      + `<p>${escapeHtml(done.length
          ? cuT('Everything your team has sent has been decided.', '团队提交的记录都已处理。')
          : cuT('Expenses your team records will arrive here for you to approve.',
                '团队登记的费用会出现在这里等待审批。'))}</p></div>`;

  const history = done.length
    ? '<section class="fin-apr-done"><h3>' + escapeHtml(cuT('Already decided', '已处理')) + '</h3>'
      + table(done) + '</section>'
    : '';

  host.innerHTML = owedBlock + queue + history;
}
