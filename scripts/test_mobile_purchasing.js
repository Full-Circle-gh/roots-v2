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

// Two open orders (one of them late — Ordered, with an arrival date in the
// past), one received, one cancelled, and one draft. Between them they cover
// every segment, every status word and both tones.
const POS = `[
  {id:4, po_number:'RPO-0004', supplier:'Fresh Co.', store_name_en:'Tianhe', store_name_cn:'天河店',
   date:'2026-08-14', delivery_date:'2026-08-16', status:'Ordered', line_count:6, received_lines:0, total_cost:3240},
  {id:5, po_number:'RPO-0005', supplier:'Oat Works',
   date:'2026-08-20', delivery_date:'2026-09-30', status:'Ordered', line_count:2, received_lines:0, total_cost:1880},
  {id:6, po_number:'RPO-0006', supplier:'Nut House',
   date:'2026-08-10', delivery_date:'2026-08-12', status:'Delivered', line_count:3, received_lines:3, total_cost:960},
  {id:7, po_number:'RPO-0007', supplier:'Bean Bros', date:'2026-08-21', status:'Requested', line_count:1, total_cost:120},
  {id:8, po_number:'RPO-0008', supplier:'Gone Ltd', date:'2026-07-02', status:'Cancelled', line_count:1, total_cost:5000}
]`;

const SEEDED = `state.posTried=true; state.pos=${POS}; APP.cmd('push','purchasing');`;

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
    ['this month\'s spend is stated',          `txt('content').includes('spent this month')`],
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
  ['empty ledger', `state.posTried=true; state.pos=[]; APP.cmd('push','purchasing');`, [
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
    ['the arrival date is there',    `sheetText().includes('2026-08-16')`],
    ['every line is listed',         `sheetText().includes('Oat milk 1L') && sheetText().includes('Carrots')`],
    ['with the quantity ordered',    `sheetText().includes('48 btl')`],
    ['and what is on the shelf now', `sheetText().includes('on shelf 12')`],
    ['a short receive says short',   `sheetText().includes('received 18')`],
    ['and names the damage',         `sheetText().includes('2 damaged')`],
    ['notes are shown',              `sheetText().includes('Back door before 9am')`],
    ['the one phone action is offered', `sheetText().includes('Everything arrived')`],
    ['and it says where partials go',   `sheetText().includes('desktop')`],
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
