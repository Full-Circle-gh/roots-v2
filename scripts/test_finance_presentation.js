#!/usr/bin/env node
/**
 * Finance — the shipped presentation, diffed against the mockups.
 *
 *   node scripts/test_finance_presentation.js
 *
 * WHY THIS EXISTS. The first Finance build reused the Reports range bar's
 * markup and inherited the LEGACY ADMIN's appearance with it — a green active
 * segment at weight 600 instead of the mockup's ink-on-paper at 500 — because
 * the Tacet look for those shared components lives in `#tab-reports`-scoped
 * overrides that a second tab never receives. Three rounds of review caught it
 * by eye; none of the 60 string-level assertions could, because they all read
 * emitted HTML and the fault was in COMPUTED STYLE.
 *
 * So this renders the real page fragment against the real stylesheet in
 * headless Chromium, renders the mockup beside it, and compares what the
 * browser actually computes. A rule that silently loses to another tab's
 * override fails here.
 *
 * It is a DIFF, not a pixel snapshot: it compares the properties the mockup is
 * authoritative about, on the elements it draws, and says which side differs.
 */
'use strict';

/* global document, getComputedStyle */
/* The identifiers above are BROWSER globals, used only inside page.evaluate()
   callbacks — code that is serialised and run in Chromium, never in Node. The
   same situation, and the same header, as lib/meituan-browser.js. */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

/* The container's pre-installed Chromium, when the pinned Playwright build is
   not the one on disk. Falls back to whatever Playwright resolves itself.
   A machine with NO browser SKIPS rather than fails: this suite is a diff
   against a design reference, and a missing browser is an absent tool, not a
   regression — reporting one would be the broken signal this file exists to
   prevent. */
const PW_CHROME = '/opt/pw-browsers/chromium';
function launchOpts() {
  try { if (fs.existsSync(PW_CHROME)) return { executablePath: fs.realpathSync(PW_CHROME) }; }
  catch (e) { /* fall through to Playwright's own resolution */ }
  return {};
}

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const MOCK = path.join(ROOT, 'reference', 'finance-summary-mockup.html');
/* The Transactions sub-view has a mockup of its own. The summary mockup draws
   no table, so the money column's alignment can only be read from this one. */
const MOCK_TX = path.join(ROOT, 'reference', 'finance-transactions-mockup.html');

let pass = 0, fail = 0;
function check(name, got, want) {
  if (String(got) === String(want)) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}\n      mockup: ${want}\n      shipped: ${got}`); fail++; }
}

/** The live #tab-finance markup, lifted out of the shipped page. */
function financeSection() {
  const a = HTML.indexOf('<section id="tab-finance">');
  const b = HTML.indexOf('<section id="tab-sales">');
  return HTML.slice(a, b);
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch(launchOpts());
  } catch (e) {
    console.log('\n  — skipped: no Chromium available in this environment.');
    console.log('    ' + String(e.message).split('\n')[0]);
    process.exit(0);
  }

  // ── the mockup ──
  const mp = await browser.newPage();
  await mp.goto('file://' + MOCK);
  const want = await mp.evaluate(() => {
    const g = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = getComputedStyle(el);
      return Object.fromEntries(props.map(p => [p, c[p]]));
    };
    const F = ['fontSize', 'fontWeight', 'color', 'backgroundColor'];
    return {
      title: g('.pg-title', ['fontSize', 'fontWeight', 'letterSpacing']),
      echo: g('.pg-echo', ['fontSize', 'color']),
      subOn: g('.subviews button.on', ['fontSize', 'fontWeight', 'color', 'borderBottomColor']),
      subOff: g('.subviews button:not(.on)', ['fontSize', 'fontWeight', 'color']),
      segOn: g('.seg button.on', F),
      segOff: g('.seg button:not(.on)', F.concat(['padding'])),
      card: g('.stair-card', ['backgroundColor', 'borderRadius']),
      body: g('.stair-body', ['padding']),
      concl: g('.row.concl .lbl', ['fontSize', 'fontWeight']),
      input: g('.row.input .lbl', ['fontSize', 'fontWeight']),
      terminus: g('.terminus', ['backgroundColor', 'padding']),
      tread: g('.tread', ['height']),
      // `margin-left: auto` COMPUTES to a resolved pixel value that depends on
      // the container's width, so it cannot be compared across two documents.
      // What the mockup actually asserts is that the echo is pushed to the
      // right edge of the header — so measure that, on both sides.
      echoFlushRight: (() => {
        const h = document.querySelector('.pg-head').getBoundingClientRect();
        const e = document.querySelector('.pg-echo').getBoundingClientRect();
        return Math.round(h.right - e.right) <= 1;
      })(),
    };
  });

  // ── the Transactions mockup ──
  // Its own file, and the only reference that draws the table. Read for one
  // thing: what the money column's alignment is supposed to be, on the HEADER
  // as well as the cells. The mockup names both — `table.tx th.num,
  // table.tx td.num` — so this is something it asserts, not something it leaves
  // to the cascade.
  const mtp = await browser.newPage();
  await mtp.goto('file://' + MOCK_TX);
  const wantTx = await mtp.evaluate(() => {
    const th = document.querySelector('table.tx th.num');
    const td = document.querySelector('table.tx tbody td.num');
    // Column WIDTHS cannot be compared across the two documents — the mockup
    // draws six columns and the shipped table five, the approved Location
    // departure — so what is compared is the property that actually broke: the
    // header's text and the figures beneath it landing on ONE right edge.
    const edge = (el) => { const r = document.createRange(); r.selectNodeContents(el);
                           return Math.round(r.getBoundingClientRect().right); };
    return {
      thAlign: getComputedStyle(th).textAlign,
      tdAlign: getComputedStyle(td).textAlign,
      flush: edge(th) === edge(td),
    };
  });

  // ── the shipped page, same stylesheet, same markup ──
  //
  // `reducedMotion: 'reduce'` is not a preference here, it is what makes the
  // GEOMETRY measurable. `section.active` runs `tab-fade-in`, which animates
  // `transform: translateY(8px)`, so a rect read while it is in flight is
  // wherever the section happens to be that frame. The stylesheet already
  // carries the escape hatch — `@media (prefers-reduced-motion: reduce)
  // { section.active { animation: none } }` — so this uses the shipped rule
  // rather than inventing an override the real page does not have.
  const sp = await browser.newPage({ reducedMotion: 'reduce' });
  await sp.setContent(`<!doctype html><html data-theme="light"><head><style>${CSS}</style></head>
    <body><main>${financeSection()}</main>
    <script>
      // THE SECTION MUST BE ACTIVATED, AND NOTHING GEOMETRIC WORKS UNTIL IT IS.
      // Tab panels are "section { display: none }" until .active (retail-
      // admin.css:940, :966), and a display:none element measures 0 on every
      // edge — so every rect read here came back 0, every comparison of two
      // zeroes was true, and the alignment assertions passed on nothing. The
      // computed-STYLE checks were unaffected, because getComputedStyle resolves
      // colours and fonts for a hidden element; only the measurements were
      // vacuous, which is why this went unnoticed.
      document.getElementById('tab-finance').classList.add('active');
      // The staircase is client-rendered; inject one card in the shape
      // finRender emits so the row rules have something to compute against.
      document.getElementById('fin-stair').innerHTML =
        '<div class="fin-card"><div class="fin-body">'
        + '<div class="fin-row fin-input"><span class="fin-lbl">Revenue</span><span class="fin-sign"></span><span class="fin-fig">¥118,257</span></div>'
        + '<div class="fin-row fin-input fin-less fin-absent"><span class="fin-lbl">Cost of goods</span><span class="fin-sign"></span><span class="fin-fig">Not recorded</span></div>'
        + '<div class="fin-row fin-concl fin-absent"><span class="fin-lbl">Gross profit</span><span class="fin-sign"></span><span class="fin-fig">Not recorded</span></div>'
        + '<p class="td-notrec">This period has no recorded cost data.</p>'
        + '<div class="fin-tread"></div>'
        + '<div class="fin-row fin-input fin-less"><span class="fin-lbl">Operating expenses</span><span class="fin-sign">−</span><span class="fin-fig">¥34,328</span></div>'
        + '</div><div class="fin-terminus"><div class="fin-row"><span class="fin-lbl">Net</span><span class="fin-sign"></span><span class="fin-fig">¥83,930</span></div></div></div>';
      // The Transactions table is client-rendered too, and #fin-tx ships
      // hidden. Both are undone here in the shape finTxRender and finTxRow
      // emit — five columns, the PO row tinted — so the table rules have
      // something to compute against. A hidden element measures as zero and
      // would make the alignment check below pass on nothing.
      document.getElementById('fin-tx').hidden = false;
      document.getElementById('fin-tx-list').innerHTML =
        '<div class="fin-tx-card"><table class="fin-tx-table">'
        + '<colgroup><col class="fin-c-date"><col class="fin-c-desc"><col class="fin-c-dir">'
        + '<col class="fin-c-amt"><col class="fin-c-act"></colgroup>'
        + '<thead><tr><th>Date</th><th>Description</th><th>Direction</th>'
        + '<th class="fin-tx-num">Amount</th><th>&nbsp;</th></tr></thead><tbody>'
        + '<tr class="fin-tx-posted"><td class="fin-tx-date">Aug 31</td>'
        + '<td><span class="fin-tx-subj">RPO-0025</span>'
        + '<span class="fin-tx-meta"><span class="fin-tx-mark">Posted by Purchasing</span> · '
        + '<span class="fin-tx-hint">Sum of 2 category subtotals</span></span></td>'
        + '<td>Out</td><td class="fin-tx-num">−¥1,180</td>'
        + '<td><a class="fin-tx-act" href="#">Open purchase order</a></td></tr>'
        + '<tr><td class="fin-tx-date">Aug 28</td>'
        + '<td><span class="fin-tx-subj">Rent</span></td>'
        + '<td>Out</td><td class="fin-tx-num">−¥8,000</td>'
        + '<td><a class="fin-tx-act" href="#">Edit</a></td></tr>'
        + '</tbody></table></div>';
    </script></body></html>`);
  const got = await sp.evaluate(() => {
    const g = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = getComputedStyle(el);
      return Object.fromEntries(props.map(p => [p, c[p]]));
    };
    const F = ['fontSize', 'fontWeight', 'color', 'backgroundColor'];
    return {
      title: g('.fin-title', ['fontSize', 'fontWeight', 'letterSpacing']),
      echo: g('.fin-echo', ['fontSize', 'color']),
      subOn: g('.fin-subviews button.on', ['fontSize', 'fontWeight', 'color', 'borderBottomColor']),
      subOff: g('.fin-subviews button:not(.on)', ['fontSize', 'fontWeight', 'color']),
      segOn: g('.fin-seg button.on', F),
      segOff: g('.fin-seg button:not(.on)', F.concat(['padding'])),
      card: g('.fin-card', ['backgroundColor', 'borderRadius']),
      body: g('.fin-body', ['padding']),
      concl: g('.fin-row.fin-concl .fin-lbl', ['fontSize', 'fontWeight']),
      input: g('.fin-row.fin-input .fin-lbl', ['fontSize', 'fontWeight']),
      terminus: g('.fin-terminus', ['backgroundColor', 'padding']),
      tread: g('.fin-tread', ['height']),
      echoFlushRight: (() => {
        const h = document.querySelector('.fin-head').getBoundingClientRect();
        const e = document.querySelector('.fin-echo').getBoundingClientRect();
        return Math.round(h.right - e.right) <= 1;
      })(),
      // Behaviour the mockup cannot express, checked here because this is the
      // only place the browser is actually running.
      ctaHidden: getComputedStyle(document.getElementById('fin-tx-new')).display,
      figColsAligned: (() => {
        const xs = [...document.querySelectorAll('.fin-body .fin-row .fin-fig')]
          .map(e => Math.round(e.getBoundingClientRect().right));
        return new Set(xs).size === 1;
      })(),
      // The Transactions money column, measured the same way as the mockup's.
      txNumThAlign: getComputedStyle(document.querySelector('.fin-tx-table th.fin-tx-num')).textAlign,
      txNumTdAlign: getComputedStyle(document.querySelector('.fin-tx-table td.fin-tx-num')).textAlign,
      txNumFlush: (() => {
        const edge = (el) => { const r = document.createRange(); r.selectNodeContents(el);
                               return Math.round(r.getBoundingClientRect().right); };
        const th = edge(document.querySelector('.fin-tx-table th.fin-tx-num'));
        const tds = [...document.querySelectorAll('.fin-tx-table tbody td.fin-tx-num')];
        // An empty list makes .every() true, and a zero edge makes any two of
        // them equal — both are a pass on nothing, the exact failure the
        // activation above fixes. Assert the measurement happened first.
        if (!tds.length || !th) return 'not measured';
        return tds.every(td => edge(td) === th);
      })(),
    };
  });

  console.log('\n1 · header');
  check('title size', got.title.fontSize, want.title.fontSize);
  check('title weight', got.title.fontWeight, want.title.fontWeight);
  check('echo size', got.echo.fontSize, want.echo.fontSize);
  check('echo colour', got.echo.color, want.echo.color);
  check('echo is pushed to the right edge', got.echoFlushRight, want.echoFlushRight);

  console.log('\n2 · sub-view strip');
  check('active size', got.subOn.fontSize, want.subOn.fontSize);
  check('active weight', got.subOn.fontWeight, want.subOn.fontWeight);
  check('active colour', got.subOn.color, want.subOn.color);
  check('active underline', got.subOn.borderBottomColor, want.subOn.borderBottomColor);
  check('inactive colour', got.subOff.color, want.subOff.color);

  console.log('\n3 · range bar — where the legacy admin leaked in');
  check('active segment background', got.segOn.backgroundColor, want.segOn.backgroundColor);
  check('active segment text', got.segOn.color, want.segOn.color);
  check('active segment weight', got.segOn.fontWeight, want.segOn.fontWeight);
  check('segment size', got.segOff.fontSize, want.segOff.fontSize);
  check('segment padding', got.segOff.padding, want.segOff.padding);
  check('segment colour', got.segOff.color, want.segOff.color);

  console.log('\n4 · the staircase');
  check('card background', got.card.backgroundColor, want.card.backgroundColor);
  check('card radius', got.card.borderRadius, want.card.borderRadius);
  check('body padding', got.body.padding, want.body.padding);
  check('input row size', got.input.fontSize, want.input.fontSize);
  check('input row weight', got.input.fontWeight, want.input.fontWeight);
  check('conclusion size', got.concl.fontSize, want.concl.fontSize);
  check('conclusion weight', got.concl.fontWeight, want.concl.fontWeight);
  check('tread height', got.tread.height, want.tread.height);
  check('terminus ground', got.terminus.backgroundColor, want.terminus.backgroundColor);
  check('terminus padding', got.terminus.padding, want.terminus.padding);

  console.log('\n5 · what the mockup cannot say, but the browser can');
  check('the CTA is actually hidden on Summary', got.ctaHidden, 'none');
  check('every figure lands on one right edge', got.figColsAligned, true);
  // The Transactions money column. `.fin-tx-num` was written as a bare class,
  // specificity (1,1,0), against a `thead th { text-align: left }` rule at
  // (1,1,2) — so the HEADER lost and sat 134px left of its own figures while
  // every cell was correctly right-aligned. Nothing that reads emitted HTML can
  // see it: the class is on both. Both halves are checked, and the mockup is
  // the authority on both, because it names `th.num` and `td.num` explicitly.
  check('Amount header is right-aligned', got.txNumThAlign, wantTx.thAlign);
  check('Amount cells are right-aligned', got.txNumTdAlign, wantTx.tdAlign);
  check('the Amount header sits over its figures', got.txNumFlush, wantTx.flush);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
