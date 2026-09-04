#!/usr/bin/env node
/**
 * The channel money breakdown panel on the order drawer — the two functions
 * that decide what it shows: channelMoneyBreakdown(o) (the arithmetic) and
 * renderChannelMoneyPanel(o) (what gets drawn from it).
 *
 *   node scripts/test_channel_money_panel.js
 *
 * EVALUATED, not paraphrased: both functions are sliced out of the shipped
 * public/retail-admin/04-orders.js and run under vm with stubs for cuT/acMoney,
 * so a rewrite of the panel moves these tests rather than leaving them testing
 * a memory of the old one.
 *
 * THE THING THIS GUARDS: "test the arithmetic gap, not column presence."
 * packing_fee and shipping_fee both DEFAULT to 0 (database.js), so an order
 * that never had its fees captured looks, by column presence alone, identical
 * to one that genuinely charged nothing — true of every Eleme row mirrored
 * before PR #200 taught ingest to write foodInfo.packageFee/deliveryFee into
 * those columns. A completeness test that only checks "is the column non-null"
 * would call such a row complete. Section 2 below builds exactly that row and
 * asserts the panel calls it incomplete anyway, because subtotal + packing +
 * shipping - discount does not add up to the order's own total.
 *
 * Eleme HAS written channel_discount since PR #209, but every row mirrored
 * before it still holds NULL, and either channel leaves the column NULL when the
 * platform named no promotion. So an order carrying a real merchant discount we
 * never captured reconciles to nothing: the panel is supposed to show what it
 * has (subtotal/packing/delivery) plus a note, never a fabricated discount
 * figure standing in for the missing column. Section 3 is that order, verified
 * honest rather than silently wrong.
 *
 * WHAT THE NOTE HAS TO SAY, and why it is asserted this hard. One flag and one
 * message — "Breakdown incomplete" — used to cover two unrelated states: an
 * order whose components disagree with its own total, and one that adds up
 * perfectly and is merely waiting for the platform to publish its commission.
 * The first is worth a phone call and the second is worth nothing, and an
 * operator could not tell which they were looking at. EL20260903163199 is the
 * order that proved it: its components overshoot its total by exactly the
 * delivery fee (§4b), and the drawer's only comment on that was the same three
 * words it showed over every unsettled Meituan order in the table (§4). The two
 * are separated now, the gap is named on screen, and §4c pins the panel's
 * arithmetic to lib/channel-settlement.js — the copy routes/eleme-internal.js
 * logs from at ingest — so the drawer and the log cannot come to different
 * conclusions about the same order.
 */
'use strict';

/* global document, getComputedStyle */
/* The identifiers above are BROWSER globals, used only inside page.evaluate()
   callbacks — code that is serialised and run in Chromium, never in Node. The
   same situation, and the same header, as scripts/test_finance_presentation.js. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');

/** A braced block (function): from `anchor` to its matching `}`. */
function sliceBlock(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

const BREAKDOWN_SRC = sliceBlock(ORDERS_JS, 'function channelMoneyBreakdown(o)');
const PANEL_SRC = sliceBlock(ORDERS_JS, 'function renderChannelMoneyPanel(o)');

// Stubs. acMoney prints in a symbol no test order text could produce by
// accident (£), so a stray hardcoded ¥ in the shipped function is caught by a
// plain string search rather than by chance. cuT mirrors the real
// window.cuT (01-core.js): one language back, chosen by the module-level
// _lang the tests flip between calls.
function makeSandbox(lang) {
  const sandbox = {
    _lang: lang,
    cuT: (en, cn) => (sandbox._lang === 'cn' ? cn : en),
    acMoney: (n) => '£' + Number(n || 0).toFixed(2),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${BREAKDOWN_SRC}\n${PANEL_SRC}`, sandbox);
  return sandbox;
}

// ── 1. Full data — the two worked examples from the spec ──────────────────
// Meituan  228.50 + 1.50 + 15.00 − 12.00 = 233.00 → −22.36 → 210.64
it('Meituan, full data: reconciles and shows both steps', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'meituan', subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00,
    channel_discount: 12.00, total: 233.00,
    channel_commission: 22.36, channel_settle_amount: 210.64,
  };
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.complete, true, 'a fully-populated Meituan order must reconcile');
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('Settlement'), 'panel carries its section header');
  assert.ok(html.includes('Customer delivery fee'), 'shipping_fee renders under the locked delivery-fee label');
  assert.ok(html.includes('Merchant discount'), 'a real channel_discount renders');
  assert.ok(html.includes('Commission'), 'commission is shown');
  assert.ok(html.includes('Estimated income'), 'settle_amount is shown as estimated income');
  assert.ok(!html.includes('Breakdown incomplete'), 'a reconciled panel carries no incomplete note');
  assert.ok(html.includes('£210.64'), 'estimated income is the stored settle_amount, not a re-derived figure');
  assert.ok(!html.includes('¥'), 'money is drawn through acMoney, never a hardcoded ¥');
});

it('Chinese view: the same panel, one language, no glued bilingual text', () => {
  const sb = makeSandbox('cn');
  const o = {
    channel: 'meituan', subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00,
    channel_discount: 12.00, total: 233.00,
    channel_commission: 22.36, channel_settle_amount: 210.64,
  };
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('结算明细'), 'Chinese header renders');
  assert.ok(html.includes('顾客配送费'), 'Chinese delivery-fee label renders');
  assert.ok(html.includes('商家对顾客的活动补贴'), 'Chinese discount label renders');
  assert.ok(html.includes('佣金'), 'Chinese commission label renders');
  assert.ok(html.includes('预计收入'), 'Chinese estimated-income label renders');
  assert.ok(!html.includes('Settlement') && !html.includes('Commission'),
    'no English leaks into the Chinese view (no " · " glue, no fallback text)');
});

// ── 2. THE ARITHMETIC GAP — an Eleme row exactly as it looked before PR #200 ─
// packing_fee/shipping_fee sit at their column DEFAULT of 0 because nothing
// ever wrote them, not because the order was free to pack and ship. A
// column-presence check ("packing_fee is not null") is true here — 0 is not
// null — and would wrongly call this row complete.
it('Eleme, pre-#200 phantom-zero fees: flagged incomplete by the arithmetic, not by column presence', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'eleme', subtotal: 135.00, packing_fee: 0, shipping_fee: 0,
    channel_discount: null, total: 141.00,   // real total; 135 - 141 alone won't reconcile either
    channel_commission: 14.95, channel_settle_amount: 126.05,
  };
  // The naive, wrong test this guards against: presence alone says "complete".
  const naivelyComplete = o.packing_fee != null && o.shipping_fee != null;
  assert.strictEqual(naivelyComplete, true, 'sanity: the phantom zero really is column-present, not null');
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.complete, false, 'the real check must catch what column presence misses');
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('unaccounted for'), 'the note must show, and must name the gap');
  assert.ok(html.includes('£135.00') && html.includes('£141.00'),
    'both sides of the failed sum are printed — the components and the order total');
  assert.ok(html.includes('£6.00'), 'and the size of the gap itself');
  assert.ok(html.includes('subtotal'), 'the one row we do have still renders');
  assert.ok(!html.includes('Commission') && !html.includes('Estimated income'),
    'step two never renders over an unreconciled step one');
});

// ── 3. Eleme with a real merchant discount — channel_discount is never
// written for Eleme (routes/eleme-internal.js), so this is honestly
// incomplete, not silently wrong. EL20260901417897: 267 + 1.5 + 18 - 17.5
// (uncaptured) = 269 — the components we hold don't reach the total we hold.
it('Eleme, real discount not captured in any column: honest incomplete, no fabricated discount row', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'eleme', subtotal: 267.00, packing_fee: 1.50, shipping_fee: 18.00,
    channel_discount: null, total: 269.00,
    channel_commission: 28.51, channel_settle_amount: 240.49,
  };
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.complete, false, 'discount is missing, so the arithmetic cannot reconcile');
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('subtotal') && html.includes('Customer delivery fee') && html.includes('packing'),
    'the rows we do have (items, packaging, delivery) still render');
  assert.ok(!html.includes('Merchant discount'), 'no discount figure is invented to force a reconcile');
  assert.ok(!html.includes('240.49') && !html.includes('Estimated income'),
    'estimated income never prints over an unreconciled total — no silent low number');
  assert.ok(html.includes('unaccounted for') && html.includes('£17.50'),
    'the note names the gap, which here is exactly the discount nobody captured');
});

// ── 4. The majority Meituan case — pre-24 Aug orders with NULL commission/
// discount/settle_amount. Must be a clean state, not a crash or a broken row.
//
// AND it must not be called a broken one. 98 + 3 + 17 - 0 = 118 reconciles to
// the cent: every component this order holds agrees with its total, and the only
// thing absent is what the platform kept, which Meituan had not published for
// these rows. The panel used to print "Breakdown incomplete" here — the same
// words it printed over an order whose columns genuinely disagreed — so the
// state worth a phone call and the state worth nothing at all were indistinguishable.
it('Meituan, pre-24-Aug order (commission/settle NULL) reads as awaiting settlement, not as broken', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'meituan', subtotal: 98.00, packing_fee: 3.00, shipping_fee: 17.00,
    channel_discount: null, total: 118.00,
    channel_commission: null, channel_settle_amount: null,
  };
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.complete, false, 'step two still cannot be shown');
  assert.strictEqual(g.reconciled, true, 'but the arithmetic itself is sound');
  assert.strictEqual(g.awaitingSettlement, true);
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('not published by the channel yet'),
    'the note says what is actually missing');
  assert.ok(!html.includes('unaccounted for'),
    'and never accuses a reconciling order of not adding up');
  assert.ok(html.includes('subtotal') && html.includes('packing') && html.includes('Customer delivery fee'),
    'the components this order DOES carry still render');
  // On the ROW markup, not on the word: the note this order now carries says
  // "Commission and income not published by the channel yet", and naming the
  // missing figure is the point of it. What must not appear is a cmp-deduct /
  // cmp-net row, which is what "step two rendered" actually means.
  assert.ok(!html.includes('cmp-deduct') && !html.includes('cmp-net'),
    'no commission row, no invented income — nothing to show for step two');
  assert.ok(!html.includes('Estimated income'), 'and no income label either');
});

// ── 4b. EL20260903163199, the order that prompted all of this. Its components
// overshoot its total by EXACTLY the delivery fee: 45 + 1.50 + 5 - 5.50 = 46
// against a recorded 41, and 45 + 1.50 - 5.50 = 41 to the cent. The drawer used
// to say "Breakdown incomplete" and nothing else, so answering "why?" needed the
// archived payload weeks after the fact.
it('EL20260903163199: the gap is named on screen, not left for an archive dig', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'eleme', subtotal: 45.00, packing_fee: 1.50, shipping_fee: 5.00,
    channel_discount: 5.50, total: 41.00,
    channel_commission: null, channel_settle_amount: null,
  };
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.reconciled, false);
  assert.strictEqual(g.expected, 46.00, 'the components add up to 46.00');
  assert.strictEqual(g.gap, 5.00, 'which overshoots the recorded total by the delivery fee');
  assert.strictEqual(g.awaitingSettlement, false,
    'a row that does not add up is never merely "awaiting" anything');
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('£46.00') && html.includes('£41.00') && html.includes('£5.00'),
    'both sides of the sum and the gap are all on screen');
  assert.ok(html.includes('Check the channel before refunding'),
    'and the consequence is stated: total is the refund ceiling');
});

// ── 4c. The panel and the server-side identity must not drift. The browser
// keeps its own copy of the arithmetic because retail-admin loads plain <script>
// tags with no module system, so the guard against the two diverging is this
// test, run over the same table of orders. lib/channel-settlement.js is what
// routes/eleme-internal.js logs from at ingest; if it and the drawer ever
// disagreed about whether an order reconciles, one of the two would be lying to
// somebody.
it('the ingest-side identity and the panel agree on every case, order for order', () => {
  const { settlementGap } = require(path.join(ROOT, 'lib', 'channel-settlement.js'));
  const sb = makeSandbox('en');
  const CASES = [
    { subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00, channel_discount: 12.00, total: 233.00 },
    { subtotal: 135.00, packing_fee: 0,    shipping_fee: 0,     channel_discount: null,  total: 141.00 },
    { subtotal: 267.00, packing_fee: 1.50, shipping_fee: 18.00, channel_discount: null,  total: 269.00 },
    { subtotal: 98.00,  packing_fee: 3.00, shipping_fee: 17.00, channel_discount: null,  total: 118.00 },
    { subtotal: 45.00,  packing_fee: 1.50, shipping_fee: 5.00,  channel_discount: 5.50,  total: 41.00 },
    { subtotal: 100.00, packing_fee: 0,    shipping_fee: 15.00, channel_discount: 0,     total: 115.00 },
    { subtotal: 50.00,  packing_fee: 1.00, shipping_fee: 4.00,  channel_discount: 0,     total: 60.00 },
  ];
  for (const c of CASES) {
    const panel  = sb.channelMoneyBreakdown({ channel: 'eleme', ...c });
    const server = settlementGap(c);
    assert.strictEqual(panel.reconciled, server === null,
      `panel and lib disagree on whether this reconciles: ${JSON.stringify(c)}`);
    if (server) {
      assert.strictEqual(panel.gap, server.gap,
        `panel and lib disagree on the size of the gap: ${JSON.stringify(c)}`);
      assert.strictEqual(panel.expected, server.expected,
        `panel and lib disagree on the component sum: ${JSON.stringify(c)}`);
    }
  }
});

// ── 5. Zero rows hide; no ¥0.00 anywhere ───────────────────────────────────
it('a zero component is hidden, not printed as a zero row', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'meituan', subtotal: 100.00, packing_fee: 0, shipping_fee: 15.00,
    channel_discount: 0, total: 115.00,
    channel_commission: 10.00, channel_settle_amount: 105.00,
  };
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(!html.includes('packing'), 'a zero packing fee renders no row at all');
  assert.ok(!html.includes('Merchant discount'), 'a zero discount renders no row at all');
  assert.ok(!html.includes('£0.00') && !/−£0\.00/.test(html), 'no zero amount rendered anywhere in the output');
});

// ── 6. Non-channel and non-commission channels degrade to nothing ─────────
for (const channel of ['wechat', 'manual', null, undefined, '']) {
  it(`non-channel order (channel=${JSON.stringify(channel)}) renders no panel at all`, () => {
    const sb = makeSandbox('en');
    const o = { channel, subtotal: 50, total: 50, fulfillment_type: 'pickup' };
    assert.strictEqual(sb.renderChannelMoneyPanel(o), '');
  });
}
it('gzgrocery (wholesale, no per-order commission) renders no panel', () => {
  const sb = makeSandbox('en');
  const o = { channel: 'gzgrocery', subtotal: 50, total: 50 };
  assert.strictEqual(sb.renderChannelMoneyPanel(o), '');
});

// ── 7. No commission rate, no "estimated" marker bolted on ────────────────
it('never prints a commission rate or a second "estimated" marker', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'meituan', subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00,
    channel_discount: 12.00, total: 233.00,
    channel_commission: 22.36, channel_settle_amount: 210.64,
  };
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(!/%/.test(html), 'no percentage anywhere — the rate is never shown');
  assert.ok(!/estimated/i.test(html.replace('Estimated income', '')),
    'no second "estimated" caveat beyond the one word already in the locked label');
});

// ── 8. MOUNTED GEOMETRY — every check above passed for the entire time this
// panel was invisible in production. §1.22 (docs/tacet-desktop-patterns.md):
// PR #206 shipped `<section class="cmp">`, retail-admin.css:940's unscoped
// `section { display: none; }` ate it, and every one of the 13 checks above
// still passed — they all assert on the HTML *string* renderChannelMoneyPanel
// returns, and that string was always correct. None of them mount it. Run
// 1596 recorded the identical failure shape in the Finance presentation
// suite: geometric assertions measuring a display:none element, comparing
// zero to zero, two checks passing on nothing.
//
// So this drops the real renderChannelMoneyPanel() output into the real
// `.drawer-body > .order-card` chain (retail-admin.html:12354-12373) under
// the real stylesheet in headless Chromium, and requires the panel to
// occupy actual pixels. And it proves the assertion is not vacuous the same
// way the bug was found: by re-tagging the identical fragment `<section>`
// (what PR #206 shipped) and requiring THAT to compute a zero box — if this
// check would not have caught the original bug, it is not this check.
(async () => {
  let browser;
  try {
    const { chromium } = require('playwright');
    const PW_CHROME = '/opt/pw-browsers/chromium';
    const launchOpts = () => {
      try { if (fs.existsSync(PW_CHROME)) return { executablePath: fs.realpathSync(PW_CHROME) }; }
      catch (e) { /* fall through to Playwright's own resolution */ }
      return {};
    };
    browser = await chromium.launch(launchOpts());
  } catch (e) {
    console.log('\n  — skipped mounted-geometry check: no Chromium available in this environment.');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
    return;
  }

  try {
    const CSS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');
    const sb = makeSandbox('en');
    const o = {
      channel: 'meituan', subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00,
      channel_discount: 12.00, total: 233.00,
      channel_commission: 22.36, channel_settle_amount: 210.64,
    };
    // Read straight from the shipped renderer — same PANEL_SRC every test
    // above runs against. If the shipped tag ever regresses back to
    // `<section>`, THIS is the assertion that says so, by name, before the
    // geometry check below even runs.
    const shippedHtml = sb.renderChannelMoneyPanel(o);
    it('sanity: the shipped panel root is a <div>, not a <section>', () => {
      assert.ok(shippedHtml.trim().startsWith('<div class="cmp">'),
        `expected the fragment to open with <div class="cmp">, got: ${shippedHtml.trim().slice(0, 40)}…`);
    });

    // The exact fragment PR #206 shipped, reconstructed from the current one —
    // same rows, same classes, only the root tag reverted. Built regardless of
    // whether the sanity check above passed, so the proof below still runs.
    const preFixHtml = shippedHtml
      .replace('<div class="cmp">', '<section class="cmp">')
      .replace(/<\/div>\s*$/, '</section>');

    // The real mount chain the drawer builds (04-orders.js: `mount.innerHTML =
    // '<div class="order-card">…'`, where `mount` is `#order-detail-mount`,
    // `.drawer-body` inside `<aside id="order-drawer" class="side-drawer">`).
    const shell = (fragment) => `<!doctype html><html><head><style>${CSS}</style></head>
      <body>
        <aside id="order-drawer" class="side-drawer open">
          <div class="drawer-body" id="order-detail-mount">
            <div class="order-card">${fragment}</div>
          </div>
        </aside>
      </body></html>`;

    async function cmpBox(fragment) {
      const page = await browser.newPage();
      await page.setContent(shell(fragment));
      const box = await page.evaluate(() => {
        const el = document.querySelector('.cmp');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, display: getComputedStyle(el).display };
      });
      await page.close();
      return box;
    }

    const shippedBox = await cmpBox(shippedHtml);
    const preFixBox = await cmpBox(preFixHtml);

    // The note is the whole of what an operator gets on an order that doesn't
    // add up, so it gets mounted too rather than trusted as a string. Same
    // reasoning as the panel itself: .cmp-note is styled at
    // retail-admin.css:7349 inside the same nested block, and a note that
    // computes to nothing is a warning nobody receives.
    const noteEl = async (fragment) => {
      const page = await browser.newPage();
      await page.setContent(shell(fragment));
      const out = await page.evaluate(() => {
        const el = document.querySelector('.cmp-note');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, display: getComputedStyle(el).display, text: el.textContent };
      });
      await page.close();
      return out;
    };
    const gapNote = await noteEl(sb.renderChannelMoneyPanel({
      channel: 'eleme', subtotal: 45.00, packing_fee: 1.50, shipping_fee: 5.00,
      channel_discount: 5.50, total: 41.00,
      channel_commission: null, channel_settle_amount: null,
    }));
    await browser.close();

    it('mounted in the real .drawer-body > .order-card chain, the shipped panel (<div class="cmp">) occupies a real box', () => {
      assert.ok(shippedBox, '.cmp did not render into the DOM at all');
      assert.notStrictEqual(shippedBox.display, 'none', '.cmp must not compute display:none under the real stylesheet');
      assert.ok(shippedBox.w > 0 && shippedBox.h > 0,
        `.cmp must occupy real pixels — got ${shippedBox.w}x${shippedBox.h}`);
    });

    it('the unreconciled note mounts, occupies real pixels, and carries the numbers', () => {
      assert.ok(gapNote, '.cmp-note did not render into the DOM at all');
      assert.notStrictEqual(gapNote.display, 'none', 'the note must not compute display:none');
      assert.ok(gapNote.w > 0 && gapNote.h > 0,
        `the note must occupy real pixels — got ${gapNote.w}x${gapNote.h}`);
      assert.ok(gapNote.text.includes('46.00') && gapNote.text.includes('41.00') && gapNote.text.includes('5.00'),
        `the mounted note must show both sides of the sum and the gap — got: ${gapNote.text}`);
    });

    it('PROOF the check bites: the identical fragment tagged <section class="cmp"> (what PR #206 shipped) computes a zero box', () => {
      assert.ok(preFixBox, '.cmp (section) did not render into the DOM at all');
      assert.strictEqual(preFixBox.display, 'none',
        'retail-admin.css:940 `section { display: none; }` must hide an unscoped <section> at any depth');
      assert.strictEqual(preFixBox.w, 0, 'a display:none element must have zero width');
      assert.strictEqual(preFixBox.h, 0, 'a display:none element must have zero height');
    });
  } catch (e) {
    console.log(`  ✗ mounted-geometry check crashed: ${e.message}`);
    fail++;
    try { await browser.close(); } catch (e2) { /* already gone */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
