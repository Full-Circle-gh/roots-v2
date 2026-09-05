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

// THE FIXTURE IS ANCHORED TO TODAY, NOT TYPED IN.
//
// Two of this screen's figures are read against the clock: `poLate` compares an
// arrival date with today, and the head band sums only the orders dated THIS
// MONTH. The dates here were written as literals in August 2026, so on
// 1 September the spend assertion began failing on a screen nobody had touched
// — every seeded order had aged out of "this month" and the band stopped
// printing the figure at all. A date typed into a fixture that the code reads
// relative to now is a test with an expiry date on it.
//
// So they are computed from shopToday(), the app's OWN idea of the store's
// today, which is the same clock the screen compares against — a fixture built
// from the runner's UTC date would disagree with the page for eight hours a
// day. (It was GZ_ISO() until C-02; the store's zone is the account's now
// rather than Guangzhou's, and this reads whatever that turns out to be.)
const CLOCK = `
  var TODAY=shopToday(), MONTH=TODAY.slice(0,7), FIRST=MONTH+'-01';
  var shift=function(iso,days){ return shopDayAdd(iso,days); };
  // Day 0 of this month is the last day of the previous one, whatever its length.
  var LAST_MONTH=shift(FIRST,-1), SOON=shift(TODAY,26);
`;

// Two open orders (one of them late — Ordered, with an arrival date in the
// past), one received, one cancelled, and one draft. Between them they cover
// every segment, every status word and both tones.
//
// THE LATE ORDER IS LAST MONTH'S, and it has to be. Late means an arrival date
// strictly before today, and this month cannot supply one on the 1st — an
// order placed on the 1st and due on the 1st is not late until the 2nd, so a
// fixture that kept it in-month would pass for 30 days and fail on the 31st,
// which is the bug this comment exists to stop happening twice. An order placed
// last month and still not delivered is what late looks like anyway. Its ¥3,240
// is therefore outside the month's spend, which leaves ¥1,880 + ¥960 = ¥2,840:
// the draft's ¥120 and the cancelled ¥5,000 are excluded by STATUS, not by date,
// so the two filters are still both proven.
const POS = `[
  {id:4, po_number:'RPO-0004', supplier:'Fresh Co.', store_name_en:'Tianhe', store_name_cn:'天河店',
   date:LAST_MONTH, delivery_date:LAST_MONTH, status:'Ordered', line_count:6, received_lines:0, total_cost:3240},
  {id:5, po_number:'RPO-0005', supplier:'Oat Works',
   date:FIRST, delivery_date:SOON, status:'Ordered', line_count:2, received_lines:0, total_cost:1880},
  {id:6, po_number:'RPO-0006', supplier:'Nut House',
   date:FIRST, delivery_date:FIRST, status:'Delivered', line_count:3, received_lines:3, total_cost:960},
  {id:7, po_number:'RPO-0007', supplier:'Bean Bros', date:FIRST, status:'Requested', line_count:1, total_cost:120},
  {id:8, po_number:'RPO-0008', supplier:'Gone Ltd', date:LAST_MONTH, status:'Cancelled', line_count:1, total_cost:5000}
]`;

const SEEDED = `${CLOCK} state.posTried=true; state.poList=${POS}; APP.cmd('push','purchasing');`;

// THE SHEET'S DATES STAY LITERAL, deliberately — the opposite call to the list
// above, for the opposite reason. Nothing here is read against the clock: the
// assertion is that a stored date is FORMATTED ("Aug 16", not "2026-08-16"), and
// a literal in the past is the only kind of date that formats the same way
// forever. Made relative, it would drift into fmtDateOnly's Today / Tomorrow /
// Yesterday branch and the format assertion would have nothing left to read.
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
  // move the Orders status line made. The figure is the two orders dated this
  // month (see POS): last month's late one and the draft and cancelled ones are
  // all out, by date and by status respectively.
  ['this month\'s spend is stated',          `txt('content').includes('¥2,840 this month')`],
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
