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
