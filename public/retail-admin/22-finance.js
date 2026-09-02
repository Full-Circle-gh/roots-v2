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
function finSetRange(key) {
  document.querySelectorAll('#fin-range-seg button')
    .forEach(b => b.classList.toggle('active', b.dataset.range === key));
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

/** One money row of the staircase. `sign` is '−' or ''; it owns its own column. */
function finRow(label, figure, opts) {
  const o = opts || {};
  const cls = ['fin-row', o.concl ? 'fin-concl' : 'fin-input', o.less ? 'fin-less' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}">`
    + `<span class="fin-lbl">${escapeHtml(label)}</span>`
    + `<span class="fin-sign">${o.less ? '−' : ''}</span>`
    + `<span class="fin-fig">${figure == null ? '' : escapeHtml(figure)}</span>`
    + '</div>';
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

/** The operating-expense disclosure. Closed by default. */
function finBreakdown(rows) {
  if (!rows || !rows.length) return '';
  return '<div class="fin-breakdown">' + rows.map(r => {
    // A row whose category was never typed keeps its own line and gets the
    // §1.12 seventh-state word rather than an invented bucket name: §36 records
    // that Finance stores category text raw and un-normalised, so a label
    // minted here would be a second wrong name on a known-dirty column.
    const label = r.category
      ? String(r.category)
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
    + finRow(cuT('Cost of goods', '销货成本'), null, { less: true })
    + finRow(cuT('Gross profit', '毛利润'), null, { concl: true })
    + finNotRecorded()
    // The landing — what makes the card read as steps rather than five rows.
    + '<div class="fin-tread"></div>'
    // Line 4 — the hand-entered half. A disclosure when there is something to
    // disclose, a plain row when there is not: a chevron that opens onto
    // nothing is a control that lies about having content behind it.
    + (breakdown
      ? '<details class="fin-exp"><summary>'
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

/* Sub-view switching. Both panes live in the page; one is `hidden` at a time.
   The range bar is SHARED — one window governs both sub-views, so switching
   never silently re-scopes what the operator was reading. */
window.finShow = function finShow(which) {
  const isTx = which === 'transactions';
  document.querySelectorAll('#fin-subviews button')
    .forEach(b => b.classList.toggle('active', b.dataset.sub === which));
  const stair = document.getElementById('fin-stair');
  const tx = document.getElementById('fin-tx');
  if (stair) stair.hidden = isTx;
  if (tx) tx.hidden = !isTx;
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
    + `<td><span class="fin-tx-subj">${escapeHtml(r.subject || '')}</span>`
    + (mark || hint ? `<span class="fin-tx-meta">${mark}${mark && hint ? ' · ' : ''}${hint}</span>` : '')
    + '</td>'
    + `<td>${escapeHtml(r.kind === 'out' ? cuT('Out', '出') : cuT('In', '进'))}</td>`
    + `<td class="fin-tx-num">${escapeHtml(finTxAmount(r))}</td>`
    + '<td>' + (po
      ? `<a class="fin-tx-act" href="#" onclick="finTxOpenPO(${Number(r.po_id)});return false">${escapeHtml(cuT('Open purchase order', '查看采购单'))}</a>`
      : '') + '</td>'
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
   is one click away on the row itself." */
window.finTxOpenPO = function finTxOpenPO(poId) {
  if (window.puOpenPO) return puOpenPO(poId);
  if (window.goTab) goTab('purchasing');
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

  const s = document.getElementById('fin-tx-search');
  if (s) s.placeholder = cuT('Filter these transactions', '筛选交易记录');
  const q = (s && s.value || '').trim().toLowerCase();

  const shown = d.rows
    .filter(r => FIN_TX_DIR === 'all' || r.kind === FIN_TX_DIR)
    .filter(r => !q || String(r.subject || '').toLowerCase().includes(q));

  // ── §1.12, both states, and they are different facts ──
  // EMPTY: there is nothing here yet. A compliment that names what will arrive.
  // Money in reaches this on every tenant today — income_entries has no rows
  // after the 1 August cutover — and that is correct, not a missing-data state:
  // something arrives the moment anyone records non-sale income.
  //
  // NO RESULTS: there is plenty here; the filter matched none of it. Never a
  // compliment — the operator is looking for something and has not found it —
  // and it offers to clear what is filtering.
  if (!shown.length) {
    const filtering = !!q || FIN_TX_DIR !== 'all';
    host.innerHTML = filtering
      ? `<div class="fin-tx-state"><p>${escapeHtml(cuT('No matching records.', '没有符合条件的记录。'))}</p>`
        + `<button type="button" class="db-btn" onclick="finTxClear()">${escapeHtml(cuT('Clear', '清除'))}</button></div>`
      : `<div class="fin-tx-state"><h3>${escapeHtml(cuT('Nothing recorded yet', '暂无记录'))}</h3>`
        + `<p>${escapeHtml(cuT(
            'Rent, wages and one-off costs you record will appear here — alongside anything Purchasing posts from a purchase order.',
            '您记录的租金、工资和一次性费用将显示在此处，以及采购单自动记入的支出。'))}</p></div>`;
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
