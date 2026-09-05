#!/usr/bin/env node
/**
 * test_print_documents.js — the two documents somebody asks for (audit E-12).
 *
 *   node scripts/test_print_documents.js
 *
 * THE FINDING. An order could be printed and a purchase order had a proper
 * sheet, but there was no stock count sheet and no customer statement — the two
 * documents a merchant is actually asked for by somebody standing in front of
 * them: a clipboard for a stocktake, and "can I have that on paper" from a
 * business customer.
 *
 * The document builder is driven in a sandbox against a fake window, so the
 * HTML it produces can be read. What is checked is what would be wrong on
 * PAPER, where nothing can be corrected afterwards:
 *
 *   - the merchant's own name at the top, never a name written into the file
 *   - no external font, because a print window that stalls is a person
 *     standing at a printer waiting for nothing
 *   - a count sheet with an EMPTY column, which is the entire point of it
 *   - a statement that lists a cancelled order rather than dropping it, and
 *     that does not pretend to be an invoice
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const no  = (c, m, extra) => (!c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

// ── the sandbox ───────────────────────────────────────────────────────────
// A window that records what was written into it, plus the handful of admin
// globals the module leans on. Nothing more: a fake that answered more than the
// module asks could pass while the real page did not.
function run(setup) {
  const written = [];
  const toasts = [];
  const sandbox = {
    console,
    toast: (msg, kind) => toasts.push({ msg, kind }),
    cuT: (en) => en,
    acMoney: (n) => '¥' + Number(n || 0).toFixed(2),
    api: async () => ({ data: sandbox.ORDERS || [] }),
    Date,
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.window.open = () => ({
    document: { write: (h) => written.push(h), close: () => {} },
  });
  Object.assign(sandbox, setup || {});
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/retail-admin/26-print.js'), 'utf8'),
    sandbox, { filename: '26-print.js' });
  return { sandbox, written, toasts, html: () => written.join('\n') };
}

// ── §1 · the sheet itself ─────────────────────────────────────────────────
section('1 · what goes on every document');
{
  const r = run({ TD_SHOP_NAME: 'Harbour Greens' });
  r.sandbox.tdPrintTable({
    docEn: 'Stock count', docCn: '盘点表',
    meta: [['Date', '2026-09-05']],
    columns: [{ h: '#' }, { h: 'Product' }],
    rows: [['Oat milk']],
  });
  const h = r.html();
  yes(h.includes('Harbour Greens'), 'the merchant’s own name is at the top');
  no(/Roots|GO VEGAN|Full Circle/.test(h), 'and no other shop’s name is anywhere in it');
  no(/fonts\.googleapis|fonts\.gstatic|https?:\/\//.test(h),
    'nothing is fetched from anywhere — the sheet prints on a bad connection');
  yes(h.includes('window.print()'), 'there is a way to print it');
  yes(/@media print/.test(h) && /\.toolbar { display:none/.test(h),
    'and the toolbar does not print itself');
}
{
  // The shop name is not known until /api/backend/me answers. An empty masthead
  // is better than the wrong name; a blank is a missing detail, a wrong name is
  // a false claim.
  const r = run({});
  r.sandbox.tdPrintTable({ docEn: 'Statement', columns: [{ h: '#' }], rows: [] });
  no(/Roots/.test(r.html()), 'before the account answers, the masthead is simply empty');
  yes(/Nothing to show/.test(r.html()), 'and a document with no rows says so rather than printing a bare grid');
}
{
  const r = run({ TD_SHOP_NAME: 'A & B <Foods>' });
  r.sandbox.tdPrintTable({
    docEn: 'Statement', columns: [{ h: '#' }, { h: 'Order' }],
    rows: [['<script>alert(1)</script>']],
  });
  const h = r.html();
  no(/<script>alert/.test(h), 'a value from the database cannot become markup');
  yes(h.includes('A &amp; B &lt;Foods&gt;'), 'and neither can the shop’s own name');
}
{
  const r = run({ TD_SHOP_NAME: 'X' });
  r.sandbox.window.open = () => null;                 // pop-ups blocked
  const out = r.sandbox.tdPrintTable({ docEn: 'Statement', columns: [], rows: [] });
  yes(out === null && r.toasts.length === 1,
    'a blocked pop-up is said out loud, not a button that does nothing');
}

// ── §2 · the count sheet ──────────────────────────────────────────────────
section('2 · the sheet that goes to the shelves');
{
  const r = run({
    TD_SHOP_NAME: 'Harbour Greens',
    PA_PRODUCTS: [
      { id: 1, name_en: 'Oat milk 1L', name_cn: '燕麦奶', sku: 'SKU-1', effective_stock: 42, is_active: 1 },
      { id: 2, name_en: 'Cacao nibs', sku: 'SKU-2', effective_stock: 8, is_active: 1 },
      { id: 3, name_en: 'Retired line', sku: 'SKU-3', effective_stock: 0, is_active: 0 },
    ],
    PA_STOCK: { 1: { 7: 40 }, 2: { 7: 8 } },
    PA_STORES: [{ id: 7, name_en: 'Tianhe' }],
    PA_STORE: 7,
  });
  r.sandbox.paPrintCountSheet();
  const h = r.html();
  yes(h.includes('Oat milk 1L') && h.includes('SKU-1'), 'every product is on it, with its code');
  no(h.includes('Retired line'), 'a product that is no longer sold is not on the clipboard');
  yes(h.includes('Tianhe'), 'and it says which location is being counted');
  yes(h.includes('>40<'), 'the system’s figure for THAT location, not the total across all of them');
  const writeCells = (h.match(/class="write/g) || []).length;
  yes(writeCells >= 4, 'with two empty boxes per line to write in — the point of the whole sheet');
  yes(/Nothing here changes the system/.test(h),
    'and it says plainly that writing on it changes nothing');
}
{
  // No location chosen: the sheet has to say so, and show the combined figure,
  // rather than silently printing one shop's counts under a heading that
  // implies all of them.
  const r = run({
    PA_PRODUCTS: [{ id: 1, name_en: 'Oat milk', sku: 'S1', effective_stock: 48, is_active: 1 }],
    PA_STOCK: { 1: { 7: 40, 8: 8 } }, PA_STORES: [{ id: 7 }, { id: 8 }], PA_STORE: 'all',
  });
  r.sandbox.paPrintCountSheet();
  yes(r.html().includes('All locations'), 'counting everywhere says "all locations"');
  yes(r.html().includes('>48<'), 'and shows the combined figure');
}

// ── §3 · the statement ────────────────────────────────────────────────────
section('3 · the paper a business customer asks for');
{
  const r = run({
    TD_SHOP_NAME: 'Harbour Greens',
    CU_CURRENT: { customer: { id: 5, nickname: 'Chen Meiling' } },
    ORDERS: [
      { id: 1, order_no: 'RT-001', placed_at: '2026-08-01 10:00:00', status: 'completed', total: 100 },
      { id: 2, order_no: 'RT-002', placed_at: '2026-08-09 10:00:00', status: 'cancelled', total: 40 },
      { id: 3, order_no: 'RT-003', placed_at: '2026-08-20 10:00:00', status: 'paid', total: 25.5 },
    ],
  });
  return r.sandbox.cuPrintStatement(5).then(() => {
    const h = r.html();
    yes(h.includes('Chen Meiling'), 'it names the customer');
    yes(h.includes('RT-001') && h.includes('RT-003'), 'and lists their orders');
    yes(h.includes('RT-002') && h.includes('Cancelled'),
      'including the cancelled one, marked — a statement that quietly drops an order cannot be reconciled');
    yes(h.includes('¥125.50'),
      'the total counts what was actually charged, and not the cancelled one');
    yes(/not an invoice/.test(h),
      'and it says it is not an invoice: there is no tax anywhere yet, and a document that LOOKS like one while getting tax wrong is worse than none');

    // ── §4 · the older sheet, corrected on the way past ──────────────────
    section('4 · the purchase order stops carrying one merchant’s name');
    const po = fs.readFileSync(path.join(ROOT, 'public/retail-admin/16-purchasing.js'), 'utf8');
    const sheet = po.slice(po.indexOf('const w = window.open'), po.indexOf('const w = window.open') + 4000);
    no(/— Roots/.test(sheet), 'the supplier’s copy no longer has a shop name written into the file');
    yes(/TD_SHOP_NAME/.test(sheet), 'it reads the account’s own');
    no(/fonts\.googleapis/.test(sheet), 'and it no longer waits on a font host that may be unreachable');

    section('5 · both documents have a door');
    const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
    yes(html.includes('paPrintCountSheet()'), 'the count sheet is on the Products toolbar');
    yes(html.includes('26-print.js'), 'and the module is loaded');
    const cust = fs.readFileSync(path.join(ROOT, 'public/retail-admin/08-customers.js'), 'utf8');
    yes(cust.includes('cuPrintStatement()'), 'the statement is in the customer’s own menu');
    const ops = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
    yes(/window\.TD_SHOP_NAME = tenant\.brand/.test(ops),
      'and the shop’s name is set from the account, whatever the admin chrome shows');

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  });
}
