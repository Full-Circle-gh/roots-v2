#!/usr/bin/env node
/**
 * What the phone's order drawer SAYS about a mirrored order (§54).
 *
 *   node scripts/test_mobile_mirrored_order_info.js
 *
 * §52 settled what the drawer must not show on a gzgrocery order — no parcel,
 * no waybill, no shipping mode — and test_mobile_mirrored_order.js guards that.
 * This is the other half: what it must SHOW. Ash, from a phone, on GZ-140695:
 * "on PC you can find address and name. can gather all info that PC version
 * have for gzgrocery order and add them to mobile".
 *
 * The two surfaces read the SAME payload — GET /api/retail-admin/orders/:id is
 * `SELECT o.*` — so every gap here was the phone declining to render a field it
 * already held, not a field it was never sent. Each case below is one of those,
 * and the desktop's own renderer is the fixture's authority: where a check
 * quotes a string, that string is live in public/retail-admin/04-orders.js.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

/* The blob. gzgrocery mirrors OpenCart's whole customer cell into
 * recipient_name and leaves recipient_phone and the ship columns null, which is
 * what ordCustomerLines was written to undo. A real one carries the address
 * after the phone, which is exactly why printing it raw is not merely untidy:
 * the name line becomes the address line. */
const BLOB = '陈美玲 (13800138000) 广东省广州市天河区天河路 385 号 1204 室';

const LINES = `[{ id:1, name_en:'Raw Sliced Almonds', name_cn:'原味杏仁片', sku:'4-150',
                  qty:1, unit_price:27.2, line_total:27.2 },
                { id:2, name_en:'Oat milk 1L', name_cn:'燕麦奶 1L', sku:'7-100',
                  qty:1, unit_price:35.2, line_total:35.2 }]`;

/* One mirrored order, `over` merged in last so a case can change exactly the
 * field it is about. Total agrees with the lines (27.20 + 35.20 = 62.40) so the
 * money-gap band stays out of every case that is not about it. */
const openDetail = (over) => `
  const d = mapDetail(Object.assign({ id:77, order_no:'GZ-140695', status:'delivered',
    channel:'gzgrocery', fulfillment_type:'delivery', total:62.4, subtotal:62.4,
    placed_at:'2026-09-06 18:47:00', store_code:'TIANHE', store_name_en:'Tianhe',
    items:${LINES}, shipments:[] }, ${over}));
  state.liveDetail = d; state.detailId = d.id; state.detailMounted = true; render();`;

const CASES = [
  /* THE ONE ASH PHOTOGRAPHED, in the shape the desktop has always handled. */
  ['a gzgrocery blob is split back into a name and a phone',
   openDetail(`{ recipient_name:${JSON.stringify(BLOB)}, recipient_phone:null }`), [
    ['the name is just the name',   `state.liveDetail.cust[0] === '陈美玲'`],
    ['the phone is recovered',      `state.liveDetail.phone === '13800138000'`],
    ['both reach the card',         `sheetText().includes('陈美玲 · 13800138000')`],
    // The whole point of splitting it: an address in the NAME line is the
    // defect, not a bonus. It belongs in Ship to, under address_full.
    ['the address is not in the name line', `!state.liveDetail.cust[0].includes('天河路')`],
    // …and the parenthesised phone must not survive inside the name either.
    ['no bracket left behind',      `!state.liveDetail.cust[0].includes('(')`],
   ]],

  /* A mirror whose dispatch note was never read holds the ORDER ID in
     recipient_name (gzgrocery-order-daemon.js). There is no blob to split and
     nothing may be invented — the phone shows what the row holds, which is what
     the desktop does with the same row. This is the case in Ash's screenshot. */
  ['a placeholder row is left exactly as it is',
   openDetail(`{ recipient_name:'140695', recipient_phone:null }`), [
    ['the placeholder survives', `state.liveDetail.cust[0] === '140695'`],
    ['no phone is invented',     `state.liveDetail.phone === '—'`],
    ['and no address either',    `state.liveDetail.addr === null`],
    ['the card says so plainly', `sheetText().includes('No address on file')`],
   ]],

  /* THE CONTROL. Same blob, storefront channel. Every other channel writes real
     columns, so a name that merely LOOKS like a blob must pass through untouched
     — splitting one there would eat a legitimately parenthesised name. */
  ['a storefront order is never split',
   openDetail(`{ channel:'wechat', recipient_name:${JSON.stringify(BLOB)}, recipient_phone:null }`), [
    ['the name is left whole', `state.liveDetail.cust[0] === ${JSON.stringify(BLOB)}`],
   ]],
  /* …and neither is a gzgrocery order that HAS a real phone column: the split is
     a repair for a missing one, not a parser we run on every row. */
  ['a gzgrocery order with a real phone column is not split either',
   openDetail(`{ recipient_name:${JSON.stringify(BLOB)}, recipient_phone:'13900139000' }`), [
    ['the stored phone wins', `state.liveDetail.phone === '13900139000'`],
    ['the name is untouched', `state.liveDetail.cust[0] === ${JSON.stringify(BLOB)}`],
   ]],

  /* orderHeadMarks has guarded on `placedFull` since it was written and nothing
     ever set it, so the drawer carried no date at all. On a mirrored order —
     nothing to pack, nothing to dispatch — when it was placed is most of what
     there is to read. */
  ['the drawer says when the order was placed',
   openDetail('{}'), [
    ['the label is there',   `sheetText().includes('Order placed')`],
    /* Asserted as the SHOP's clock, not the stored string. A bare
       "2026-09-06 18:47:00" is read as UTC and rendered in shop time (+8), so
       the drawer says Sep 7, 2:47 AM — which is what every other timestamp on
       this surface does, the list row's own fmtDay included. The year is
       correctly absent: tdWhen's English dateTime drops it inside the current
       year. Pinned deliberately rather than loosened to "contains a digit" — if
       the timezone convention ever moves, this is a place that should say so. */
    ['the day is the shop\'s',  `sheetText().includes('Sep 7')`],
    ['and so is the clock',     `sheetText().includes('2:47 AM')`],
    ['carried raw, not pre-formatted so the language toggle can reach it',
     `state.liveDetail.placedFull === '2026-09-06 18:47:00'`],
   ]],

  /* The desktop tags its read-only panel; the phone's drawer carried no marking
     at all — the "View only" pill was the LIST row's, so opening the order lost
     the one fact explaining why nothing in it can be acted on. */
  ['a mirrored order is tagged read-only in the drawer, by platform',
   openDetail('{}'), [
    ['it names the platform', `sheetText().includes('Gzgrocery')`],
    ['and says view only',    `sheetText().includes('View only')`],
   ]],
  ['a Meituan order is tagged with ITS platform, not gzgrocery\'s',
   openDetail(`{ channel:'meituan' }`), [
    ['named correctly',   `sheetText().includes('Meituan')`],
    ['not mislabelled',   `!sheetText().includes('Gzgrocery')`],
   ]],
  /* Eleme is the reason this reads the RAW channel: CH_BACK still has no Eleme
     entry (§52), so the display key falls through to the mini-app default and
     an Eleme order would have been tagged as one. */
  ['an Eleme order is not tagged as a mini-app order',
   openDetail(`{ channel:'eleme' }`), [
    ['named correctly', `sheetText().includes('Eleme')`],
    ['still read-only', `sheetText().includes('View only')`],
   ]],
  ['THE CONTROL: a storefront order carries no read-only tag',
   openDetail(`{ channel:'wechat' }`), [
    ['no tag', `!sheetText().includes('View only')`],
   ]],

  /* A mirrored line has no `options` — it puts its variant in `size`, which is
     what the desktop's read-only manifest prints as the line's type. Reading
     only `options` left two sizes of one product reading as the same thing. */
  ['a mirrored line shows the variant it was ordered in',
   openDetail(`{ items:[{ id:1, name_en:'Raw Sliced Almonds', name_cn:'原味杏仁片',
                          sku:'4-150', size:'500g', qty:1, unit_price:62.4, line_total:62.4 }] }`), [
    ['the size is on the line', `sheetText().includes('500g')`],
    ['the name is still there', `sheetText().includes('Raw Sliced Almonds')`],
   ]],
  /* …and a storefront line's own options still win, so this added a fallback
     rather than replacing what was there. */
  ['a storefront line still shows its options, not a size',
   openDetail(`{ channel:'wechat',
                 items:[{ id:1, name_en:'Sourdough loaf', name_cn:'酸面包', size:'800g',
                          options:[{ question_en:'Sliced?', label:'Yes' }],
                          qty:1, unit_price:62.4, line_total:62.4 }] }`), [
    ['the customer\'s own choice is what shows', `sheetText().includes('Sliced?: Yes')`],
    ['the size does not displace it',            `!sheetText().includes('800g')`],
   ]],

  /* The drawer showed a total, showed the lines, and said nothing when the two
     contradicted each other. 27.20 + 35.20 = 62.40 against a recorded 90.00 is
     ¥27.60 adrift — past the ¥5-or-30% tolerance the desktop uses. */
  ['a total that disagrees with the lines is said out loud',
   openDetail(`{ total:90 }`), [
    ['the band is there',    `sheetText().includes('Total disagrees with the items')`],
    // money() prints 0 decimals on a whole number, so the recorded total is ¥90,
    // not ¥90.00 — asserted through the full sentence so a formatting change
    // that silently drops one of the two figures still fails here.
    ['it shows the sum',      `sheetText().includes('Items add up to ¥62.40')`],
    ['and what was recorded', `sheetText().includes('but this order records ¥90.')`],
    ['and where to check it', `sheetText().includes('Check Gzgrocery before refunding')`],
   ]],
  ['THE CONTROL: an order that adds up says nothing',
   openDetail('{}'), [
    ['no band', `!sheetText().includes('Total disagrees')`],
   ]],
  /* A mirror that captured no per-line money cannot disagree with anything, and
     guessing at a line total would invent the discrepancy it claims to report. */
  ['an order with no per-line money is never accused of disagreeing',
   openDetail(`{ total:90, items:[{ id:1, name_en:'Raw Sliced Almonds', name_cn:'原味杏仁片',
                                    qty:1, unit_price:0, line_total:0 }] }`), [
    ['no band', `!sheetText().includes('Total disagrees')`],
   ]],

  /* The Copy button on the Ship-to card spread a null address — so on every
     order with none on file (a counter sale, a pickup, and every gzgrocery
     mirror) the one button on that card threw and copied nothing. */
  ['Copy on a card with no address does not throw',
   openDetail(`{ recipient_name:'140695', recipient_phone:null }`), [
    ['it survives the call',
     `(function(){ try{ APP.cmd('copyAddr'); return true; }catch(e){ return false; } })()`],
   ]],

  /* The SKU chip opens the phone's own product sheet — but only when the lookup
     behind it can succeed, so a line whose product was deleted or re-SKU'd
     prints a chip that is plainly just a label. */
  ['a known SKU is tappable and an unknown one is not',
   `DB.products = [{ sku:'4-150', name_en:'Raw Sliced Almonds' }];` + openDetail('{}'), [
    ['the known SKU became a button',
     `!!document.querySelector('.sheet button[onclick*="openProduct"][onclick*="4-150"]')`],
    ['the unknown one did not',
     `!document.querySelector('.sheet button[onclick*="openProduct"][onclick*="7-100"]')`],
    ['but it is still printed', `sheetText().includes('7-100')`],
   ]],
];

run('mirrored order info', CASES);
