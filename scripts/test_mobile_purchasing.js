#!/usr/bin/env node
/**
 * The phone's Purchasing ledger, asserted against 16-purchasing.js.
 *
 *   node scripts/test_mobile_purchasing.js
 *
 * What this screen used to be: three hard-coded purchase orders in DB.purchasing
 * — "Fresh Co. ¥3,240 · Received", "Oat Works · In transit", "Nut House · Draft"
 * — two of which carried statuses the server has never stored. A live prefetch
 * did overwrite them, but only `if (rows.length)`, so a shop with an empty
 * ledger saw three orders it had never placed and a spend it had never made.
 * And every row's tap called openOrder() — the CUSTOMER order sheet — with a PO
 * number that could not be found there.
 *
 * So the assertions are mostly about honesty: the ledger shows what the server
 * has, an empty ledger looks empty, the words match the four stored statuses,
 * and the money is the server's total_cost rather than a string in the source.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

/* THE DATES ARE RELATIVE, AND THEY HAVE TO BE.
 *
 * They used to be literal August 2026, and one case asserted the ledger reads
 * "¥6,080 this month" — the Ordered+Delivered total of those August rows
 * (3240 + 1880 + 960). statusPurchasing() sums orders whose date falls in the
 * CURRENT month, so on 1 September the fixture aged out of its own assertion and
 * the case went red with nobody touching the code it tests. A test that encodes
 * a moment rather than a property has a shelf life, and this one reached it.
 *
 * IT ALSO WENT RED IN ONLY ONE PLACE, which is the part worth writing down: it
 * failed locally and passed on the CI runner, on the same commit, the same
 * files and the same day. Ruled out, by measurement rather than by argument:
 * the two checkouts are byte-identical here; TZ (CI sets Asia/Shanghai, the
 * local run had none — both still compute September); Chromium's
 * --virtual-time-budget, which does not move the wall clock; and any second
 * code path rendering the string (there is one site). The unexplained remainder
 * is the browser itself — CI runs the image's /usr/bin/google-chrome, this
 * machine runs Playwright's Chromium — and rather than keep guessing at it, the
 * fixture no longer depends on the answer. Both environments now assert the
 * same figure for the same reason on every day of the year, so the disagreement
 * has nowhere left to hide.
 *
 * GZ_ISO in m.html is UTC+8, and these dates are built the same way, so the
 * fixture and the screen always agree about which month "this month" is — even
 * for a run that starts at 23:50 UTC and finishes after midnight in Guangzhou.
 */
const D = (offsetDays) => new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000)
  .toISOString().slice(0, 10);
// The Guangzhou day, and the same month the screen will be summing.
const GZ_TODAY = D(0);
const [Y, M] = GZ_TODAY.split('-').map(Number);
// A day safely inside THIS month whichever day it is run — never the 29th-31st,
// which do not exist in every month, and never a day that could roll backwards.
const thisMonth = (day) => `${Y}-${String(M).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
// Last month, for the row that must be EXCLUDED from the total. Month 1 wraps to
// December of the previous year — an off-by-one here would silently pull a
// cancelled ¥5,000 into the figure every January.
const lastMonth = M === 1 ? `${Y - 1}-12-15` : `${Y}-${String(M - 1).padStart(2, '0')}-15`;

// Two open orders (one of them late — Ordered, with an arrival date in the
// past), one received, one cancelled, and one draft. Between them they cover
// every segment, every status word and both tones.
const POS = `[
  {id:4, po_number:'RPO-0004', supplier:'Fresh Co.', store_name_en:'Tianhe', store_name_cn:'天河店',
   date:'${thisMonth(1)}', delivery_date:'${D(-1)}', status:'Ordered', line_count:6, received_lines:0, total_cost:3240},
  {id:5, po_number:'RPO-0005', supplier:'Oat Works',
   date:'${thisMonth(2)}', delivery_date:'${D(30)}', status:'Ordered', line_count:2, received_lines:0, total_cost:1880},
  {id:6, po_number:'RPO-0006', supplier:'Nut House',
   date:'${thisMonth(3)}', delivery_date:'${thisMonth(4)}', status:'Delivered', line_count:3, received_lines:3, total_cost:960},
  {id:7, po_number:'RPO-0007', supplier:'Bean Bros', date:'${thisMonth(4)}', status:'Requested', line_count:1, total_cost:120},
  {id:8, po_number:'RPO-0008', supplier:'Gone Ltd', date:'${lastMonth}', status:'Cancelled', line_count:1, total_cost:5000}
]`;

/* The figure the ledger must state, DERIVED rather than typed. statusPurchasing
   sums this month's Ordered and Delivered — so the Requested ¥120 and the
   cancelled ¥5,000 are out by status, and the cancelled one is dated last month
   as well, which is what proves the month filter is doing something. Computing
   it here means the fixture and the expectation cannot drift apart: change a
   total above and this follows. */
const SPEND = 3240 + 1880 + 960;
const SPEND_TEXT = '¥' + SPEND.toLocaleString('en-US') + ' this month';

const SEEDED = `state.posTried=true; state.poList=${POS}; APP.cmd('push','purchasing');`;

const DETAIL = `{id:4, po_number:'RPO-0004', supplier:'Fresh Co.', store_name_en:'Tianhe', store_name_cn:'天河店',
  date:'2026-08-14', delivery_date:'2026-08-16', status:'Ordered', total_cost:3240, notes:'Back door before 9am.',
  items:[
    {id:1, name_en:'Oat milk 1L', sku:'OM-1L', qty:48, unit:'btl', total_cost:1440, current_stock:12},
    {id:2, name_en:'Carrots',     sku:'CR-01', qty:20, unit:'kg',  total_cost:1800, qty_received:18, damaged_qty:2}
  ]}`;

const CASES = [
  ['ledger', SEEDED, [
    ['the server\'s orders are the rows',      `txt('content').includes('RPO-0004')`],
    ['the supplier is named',                  `txt('content').includes('Fresh Co.')`],
    ['and the store it is for',                `txt('content').includes('Tianhe')`],
    ['money is the server\'s total_cost',      `txt('content').includes('¥3,240')`],
    ['open is counted',                        `/3\\s+open/.test(txt('content'))`],
    ['late is counted separately',             `/1\\s+late/.test(txt('content'))`],
    // In the head band now, not the first row of the body — §1.7, and the same
  // move the Orders status line made.
  ['this month\'s spend is stated',          `txt('content').includes(${JSON.stringify(SPEND_TEXT)})`],
    ['a late order says so, on the row',       `txt('content').includes('late')`],
    ['lines are counted',                      `txt('content').includes('6 lines')`],
    ['segments carry their counts',            `/Open\\s*3/.test(txt('content')) && /Received\\s*1/.test(txt('content')) && /All\\s*5/.test(txt('content'))`],
    ['a cancelled order is not in Open',       `!txt('content').includes('RPO-0008')`],
    ['no invented status ever appears',        `!/In transit|已入库/.test(txt('content'))`],
  ]],
  ['segments', SEEDED + `APP.cmd('poSeg','received');`, [
    ['Received holds only Delivered',  `txt('content').includes('RPO-0006') && !txt('content').includes('RPO-0004')`],
    ['and it says Received, not Delivered', `txt('content').includes('Received')`],
    ['received lines are counted on the row', `txt('content').includes('3 lines · 3 in')`],
  ]],
  ['all', SEEDED + `APP.cmd('poSeg','all');`, [
    ['All holds the cancelled one too', `txt('content').includes('RPO-0008')`],
    ['a draft reads Draft, the desktop\'s word for Requested', `txt('content').includes('Draft')`],
  ]],
  ['empty ledger', `state.posTried=true; state.poList=[]; APP.cmd('push','purchasing');`, [
    ['says there are none',        `txt('content').includes('No purchase orders yet')`],
    ['and invents none',           `!txt('content').includes('RPO-') && !txt('content').includes('Fresh Co.')`],
    ['no spend figure either',     `!txt('content').includes('spent this month')`],
  ]],
  ['the ledger would not load', `state.posTried=true; state.posErr='Could not load purchase orders.'; APP.cmd('push','purchasing');`, [
    ['says so',            `txt('content').includes('Could not load purchase orders')`],
    ['rather than empty',  `!txt('content').includes('No purchase orders yet')`],
  ]],
  ['order sheet', SEEDED + `APP.cmd('openPO',4); state.poDetail=${DETAIL}; render();`, [
    ['the number is the title',      `sheetText().includes('RPO-0004')`],
    ['supplier and store are facts', `sheetText().includes('Fresh Co.') && sheetText().includes('Tianhe')`],
    // Formatted, not the raw column: the phone writes dates the way §1.18 says
    // and 2026-08-16 appearing here would mean the ISO string leaked through.
    ['the arrival date is there',    `sheetText().includes('Aug 16') && !sheetText().includes('2026-08-16')`],
    ['every line is listed',         `sheetText().includes('Oat milk 1L') && sheetText().includes('Carrots')`],
    ['with the quantity ordered',    `sheetText().includes('48 btl')`],
    ['and what is on the shelf now', `sheetText().includes('on shelf 12')`],
    ['a short receive says short',   `sheetText().includes('received 18')`],
    ['and names the damage',         `sheetText().includes('2 damaged')`],
    ['notes are shown',              `sheetText().includes('Back door before 9am')`],
    ['the one phone action is offered', `sheetText().includes('Everything arrived')`],
    // Was: "and it says where partials go" — asserting the sheet pointed at the
    // desktop for short counts and damage. It no longer does, because it no
    // longer has to: Receive is a screen on the phone now, and the sheet offers
    // the way into it instead of an apology.
    ['and offers the per-line screen',  `sheetText().includes('Receive line by line')`],
  ]],
  ['a draft offers the other step', SEEDED
    + `APP.cmd('openPO',7); state.poDetail={id:7,po_number:'RPO-0007',supplier:'Bean Bros',status:'Requested',total_cost:120,items:[]}; render();`, [
    ['mark ordered, not receive', `sheetText().includes('Mark ordered') && !sheetText().includes('Everything arrived')`],
  ]],
  ['a received order offers nothing', SEEDED
    + `APP.cmd('openPO',6); state.poDetail={id:6,po_number:'RPO-0006',supplier:'Nut House',status:'Delivered',total_cost:960,items:[]}; render();`, [
    ['no action button',        `!sheetText().includes('Everything arrived') && !sheetText().includes('Mark ordered')`],
    ['and no desktop footnote', `!sheetText().includes('Short counts')`],
  ]],
  ['ticking it in asks first', SEEDED
    + `APP.cmd('openPO',4); state.poDetail=${DETAIL}; render(); APP.cmd('poStatus','Delivered');`, [
    ['it asks',                       `sheetText().includes('Everything arrived?')`],
    ['says stock moves',              `sheetText().includes('stock goes up')`],
    ['says the money is posted',      `sheetText().includes('posts to the books')`],
    ['and nothing was sent yet',      `state.poDetail.status === 'Ordered'`],
  ]],
];

run('purchasing', CASES);
