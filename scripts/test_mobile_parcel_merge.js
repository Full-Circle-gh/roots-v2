#!/usr/bin/env node
/**
 * Combine / split parcels on the phone — the control the desktop has had since
 * 2026-06 and this surface never got.
 *
 *   node scripts/test_mobile_parcel_merge.js
 *
 * Ash, holding a phone on an order to Changzhou split into two parcels: "why
 * there is no option to combine shipment same as the pc version?" There was no
 * option because there was no code: `combine` appears nowhere in m.html, while
 * `04-orders.js` has drawn the button for a year. The route was always shared.
 *
 * WHAT THIS LOCKS IS THE GATE, not the wording. The button is cheap to draw and
 * every way of drawing it in the wrong place is expensive:
 *
 *   • A WAYBILL ANYWHERE LOCKS IT. Combining after a label is printed strands
 *     that label, and the route refuses it (409 has_tracking). The desktop
 *     checks tracking_number OR tracking_carrier; the phone's own
 *     orderHasWaybill checks only the number, so a carrier-only parcel is the
 *     case most likely to slip through a copy of the wrong helper.
 *   • ONLY THE SYSTEM'S OWN SPLIT. An inside-Guangzhou order split by "ship
 *     part later" is an arrangement somebody built on purpose; offering to
 *     collapse it is offering to undo their work.
 *   • A MIRRORED ORDER HAS NO PARCELS OF OURS (§53) and therefore nothing to
 *     combine.
 *
 * And the undo sends NO BODY. The split route branches on whether `item_ids` is
 * PRESENT: an empty array is a to-follow request that lost its items and is
 * answered 400, and a populated one moves lines nobody asked to move. That
 * branch point is the repair for the eight-week destructive shadowing recorded
 * on the route itself, so the request shape is asserted, not assumed.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const LINES = `[{ id:1, name_en:'Sourdough loaf', name_cn:'酸面包', qty:2, unit_price:18, shipment_id:11 },
                { id:2, name_en:'Oat milk 1L', name_cn:'燕麦奶 1L', qty:1, unit_price:13.2, shipment_id:12 }]`;

/* The split the PLANNER makes on an out-of-Guangzhou order: an air parcel and a
   land parcel, each with its own clock. `trk` is whatever the caller gives —
   null for a parcel with no waybill yet. */
const SPLIT = (air = 'null', land = 'null') => `[
  { id:11, mode:'air',  state:'pending', label:'Air shipment · 空运',  tracking:${air},
    items:[{ id:1, name_en:'Sourdough loaf', name_cn:'酸面包', qty:2, unit_price:18 }] },
  { id:12, mode:'land', state:'pending', label:'Land shipment · 陆运', tracking:${land},
    items:[{ id:2, name_en:'Oat milk 1L', name_cn:'燕麦奶 1L', qty:1, unit_price:13.2 }] }]`;

/* What the combine route leaves behind: ONE parcel carrying the stamp it writes.
   The `合并` in that label is the only thing that says a combine happened. */
const COMBINED = `[{ id:11, mode:'air', state:'pending', label:'Combined shipment · 合并发货',
  items:[{ id:1, name_en:'Sourdough loaf', name_cn:'酸面包', qty:2, unit_price:18 },
         { id:2, name_en:'Oat milk 1L', name_cn:'燕麦奶 1L', qty:1, unit_price:13.2 }] }]`;

/* One parcel the planner never split — a Guangdong address, nothing combined. */
const SINGLE = `[{ id:11, mode:'land', state:'pending', label:'Land shipment · 陆运',
  items:[{ id:1, name_en:'Sourdough loaf', name_cn:'酸面包', qty:2, unit_price:18 },
         { id:2, name_en:'Oat milk 1L', name_cn:'燕麦奶 1L', qty:1, unit_price:13.2 }] }]`;

const openDetail = (shipments, extra = '') => `
  const d = mapDetail({ id:77, order_no:'TC000785', status:'preparing', channel:'wechat',
    fulfillment_type:'delivery', total:401, subtotal:393, placed_at:'2026-09-19 09:12:00',
    outside_guangzhou:true, shipping_city:'常州市',
    items:${LINES}, shipments:${shipments} });
  ${extra}
  state.liveDetail = d; state.detailId = d.id; state.detailMounted = true; render();`;

const CASES = [
  ['a system split with no waybill offers the combine',
   openDetail(SPLIT()), [
    ['the button Ash went looking for is there', `sheetText().includes('Combine into one parcel')`],
    ['and it says why the order is in two boxes', `sheetText().includes('Destination outside Guangzhou')`],
    // The undo is the OTHER state. Offering both at once would be a screen that
    // does not know which one this order is in.
    ['it does not also offer the undo', `!sheetText().includes('Split into separate parcels')`],
    ['no waybill hint, because there is no waybill',
     `!sheetText().includes('Clear the waybills')`],
    // The parcels themselves must survive the addition.
    ['the parcels are still listed', `sheetText().includes('2 parcels')`],
   ]],

  ['and in Chinese',
   `LANG='zh'; state.lang='zh'; ${openDetail(SPLIT())}`, [
    ['the button is the desktop’s own pair', `sheetText().includes('合并为一个包裹')`],
    ['and the reason with it', `sheetText().includes('目的地在广州以外')`],
   ]],

  ['a waybill on ONE parcel locks it, and says so',
   openDetail(SPLIT(`{ number:'JDVC37829030835', carrier_code:'jd', events:[] }`)), [
    ['no combine button', `!sheetText().includes('Combine into one parcel')`],
    ['the desktop’s sentence for why', `sheetText().includes('Clear the waybills to combine into one parcel')`],
   ]],

  /* THE CASE A COPY OF orderHasWaybill WOULD MISS. That helper tests trk.number
     only; the route and the desktop both refuse on tracking_carrier as well, so
     a parcel with a carrier chosen and the number not yet typed must lock too —
     otherwise the button is live right up to the moment it is refused. */
  ['a carrier with no number yet locks it as well',
   openDetail(SPLIT().replace("mode:'air',  state:'pending'",
     "mode:'air',  state:'pending', tracking_carrier:'jd'")), [
    ['still no combine button', `!sheetText().includes('Combine into one parcel')`],
    ['still the waybill sentence', `sheetText().includes('Clear the waybills')`],
   ]],

  ['a combined parcel offers the way back',
   openDetail(COMBINED), [
    ['it says what happened', `sheetText().includes('Combined into one parcel')`],
    ['and what that means for the customer', `sheetText().includes('Customer tracks a single shipment')`],
    ['the undo is there', `sheetText().includes('Split into separate parcels')`],
    ['and not the combine again', `!sheetText().includes('Combine into one parcel')`],
   ]],

  ['an ordinary single parcel offers neither',
   openDetail(SINGLE), [
    ['nothing to combine', `!sheetText().includes('Combine into one parcel')`],
    ['nothing to split',   `!sheetText().includes('Split into separate parcels')`],
    ['and no orphan reason line', `!sheetText().includes('Destination outside Guangzhou')`],
   ]],

  /* Inside Guangzhou the planner does not split, so two parcels here are a
     "ship part later" arrangement an operator built. The desktop gates on
     outside_guangzhou for exactly this; the phone has to as well or it offers
     to undo somebody's work. */
  ['a ship-part-later split inside Guangzhou is left alone',
   openDetail(SPLIT()).replace('outside_guangzhou:true', 'outside_guangzhou:false')
     .replace(`shipping_city:'常州市'`, `shipping_city:'广州市'`), [
    ['no combine button', `!sheetText().includes('Combine into one parcel')`],
    ['no reason line',    `!sheetText().includes('Destination outside Guangzhou')`],
   ]],

  ['a mirrored order has no parcels of ours, so nothing to combine',
   openDetail(SPLIT()).replace(`channel:'wechat'`, `channel:'meituan'`), [
    ['no combine button', `!sheetText().includes('Combine into one parcel')`],
    ['no undo either',    `!sheetText().includes('Split into separate parcels')`],
   ]],
];

/* THE REQUEST SHAPE, not just the button. Both halves post to routes that read
   the body to decide what they are: `combine` takes none, and `split` treats the
   PRESENCE of item_ids as "ship part later" — the branch whose absence once let
   a to-follow request delete every parcel on the order. */
const WIRE = `
  window.__sent = [];
  window.fetch = function(url, opts){
    window.__sent.push({ url:String(url), body:(opts&&opts.body)||null });
    return Promise.resolve({ ok:true, status:200, json:function(){ return Promise.resolve({ success:true }); } });
  };`;

const CASES_WIRE = [
  ['the combine posts to the shared route, with no body of its own',
   `${WIRE} ${openDetail(SPLIT())} APP.cmd('combineParcels'); APP.cmd('askRun');`, [
    ['it asked before sending', `window.__sent.length >= 1`],
    ['the route is the desktop’s',
     `window.__sent.some(function(s){ return s.url.indexOf('/api/retail-admin/orders/77/shipments/combine') >= 0 })`],
    ['and it carries nothing that could steer it',
     `window.__sent.filter(function(s){ return s.url.indexOf('/shipments/combine') >= 0 })
        .every(function(s){ return s.body === '{}' })`],
   ]],

  ['the undo sends NO item_ids — the key the route branches on',
   `${WIRE} ${openDetail(COMBINED)} APP.cmd('splitParcels'); APP.cmd('askRun');`, [
    ['it reached the split route',
     `window.__sent.some(function(s){ return s.url.indexOf('/api/retail-admin/orders/77/shipments/split') >= 0 })`],
    // Presence, not length: `{item_ids:[]}` is a to-follow request that lost its
    // items and is answered 400, never the undo.
    ['and no item_ids key at all, empty or otherwise',
     `window.__sent.filter(function(s){ return s.url.indexOf('/shipments/split') >= 0 })
        .every(function(s){ return s.body.indexOf('item_ids') < 0 })`],
   ]],

  /* A confirm that can be dismissed is the difference between a control and a
     trap: both of these rewrite what the customer will track. */
  ['neither fires until the question is answered',
   `${WIRE} ${openDetail(SPLIT())} APP.cmd('combineParcels');`, [
    ['the question is on screen', `sheetText().includes('The customer will track a single parcel')`],
    ['and nothing has been sent yet',
     `!window.__sent.some(function(s){ return s.url.indexOf('/shipments/') >= 0 })`],
   ]],
];

run('parcel merge', CASES);
run('parcel merge wire', CASES_WIRE, { settle: 60 });
