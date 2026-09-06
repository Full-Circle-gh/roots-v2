#!/usr/bin/env node
/**
 * A mirrored order on the phone — no parcel, no waybill, no mode (§52).
 *
 *   node scripts/test_mobile_mirrored_order.js
 *
 * Meituan, Eleme and gzgrocery orders are mirrored in from someone else's
 * system. We do not accept, prepare, pack, dispatch or enter a waybill for one.
 * The desktop has always known this — it routes them to a stripped read-only
 * panel with no parcels and no waybill field in it. The phone did not, and drew
 * the full drawer:
 *
 *     Land
 *     No waybill on this parcel yet — add it on the desktop.
 *
 * on a gzgrocery order, sending the operator to a screen that does not offer
 * the field. Ash, from a phone, looking at exactly that: "no way I'll for
 * gzgrocery. this is mobile. no land it air option."
 *
 * The server no longer plans those parcels. THIS IS THE OTHER HALF, and it is
 * not belt-and-braces: every mirrored order opened before that guard shipped
 * still carries the row it created, and nothing sweeps them. So the fixtures
 * here deliberately CARRY a phantom parcel — a fixture without one would pass
 * against a drawer that had never been fixed.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

/* The parcel the planner used to materialize: land, and stamped delivered by
   the detail read's legacy back-fill because the mirrored order's own status is
   'delivered'. Both are what promote it into the hoisted tracking block. */
const PHANTOM_PARCEL = `[{ id:9, mode:'land', state:'delivered',
  items:[{ id:1, name_en:'Sourdough loaf', name_cn:'酸面包', qty:2, unit_price:18 }] }]`;

/* An order shaped the way a mirror writes one: no address, no phone, a total
   and two lines. `channel` is the only field that differs between the cases
   below, which is what makes them a comparison rather than four fixtures. */
const openDetail = (channel, shipments) => `
  const d = mapDetail({ id:77, order_no:'GZ-140695', status:'delivered', channel:'${channel}',
    fulfillment_type:'delivery', total:62.4, subtotal:62.4, placed_at:'2026-09-06 18:47:00',
    items:[{ id:1, name_en:'Sourdough loaf', name_cn:'酸面包', qty:2, unit_price:18 },
           { id:2, name_en:'Oat milk 1L', name_cn:'燕麦奶 1L', qty:2, unit_price:13.2 }],
    shipments:${shipments} });
  state.liveDetail = d; state.detailId = d.id; state.detailMounted = true; render();`;

const CASES = [
  ['a gzgrocery order shows no parcel and no waybill',
   openDetail('gzgrocery', PHANTOM_PARCEL), [
    // The card Ash photographed. Every one of these is the same defect seen
    // from a different angle, and they are listed separately because a partial
    // fix that removes the sentence but keeps the "Land" heading is still a
    // drawer offering a shipping mode on an order we do not ship.
    ['NO WAYBILL PROMPT', `!sheetText().includes('No waybill on this parcel yet')`],
    ['it does not send anyone to the desktop', `!sheetText().includes('add it on the desktop')`],
    ['NO LAND MODE',      `!sheetText().includes('Land')`],
    ['no parcel heading', `!sheetText().includes('parcel')`],
    ['and no tracking block at all', `!sheetText().includes('Tracking')`],
    // The lines still have to be there — this is a manifest, and dropping it
    // would be a worse screen than the one being fixed.
    ['the items are still listed', `sheetText().includes('Sourdough loaf')`],
    ['all of them',                `sheetText().includes('Oat milk 1L')`],
    ['under a flat count, not a parcel count', `sheetText().includes('2 products · 4 units')`],
    // The order is still readable as an order.
    ['the total survives', `sheetText().includes('62.40')`],
  ]],

  // The phone read viewOnly off its display-channel key, which has no 'eleme'
  // entry — so an Eleme order fell through to the mini-app default and was not
  // read-only here in any respect, while the desktop had treated it as
  // read-only since the day it landed.
  // Asserted on the mapped flag rather than on a pill, because the phone's
  // DRAWER carries no read-only marking at all — the "View only" pill is a list
  // row's, and the desktop's read-only panel does tag its own header. That gap
  // is recorded in §52 and is a separate change; this suite is about parcels.
  ['an ELEME order is read-only too',
   openDetail('eleme', PHANTOM_PARCEL), [
    ['it is mapped read-only', `state.liveDetail.viewOnly === true`],
    ['NO WAYBILL PROMPT',      `!sheetText().includes('No waybill on this parcel yet')`],
    ['no land mode',           `!sheetText().includes('Land')`],
  ]],

  ['a MEITUAN order is read-only too',
   openDetail('meituan', PHANTOM_PARCEL), [
    ['it is mapped read-only', `state.liveDetail.viewOnly === true`],
    ['NO WAYBILL PROMPT',      `!sheetText().includes('No waybill on this parcel yet')`],
    ['no land mode',           `!sheetText().includes('Land')`],
  ]],

  /* THE CONTROL. Same fixture, storefront channel — every assertion above
     inverts. Without this the suite passes just as well against a drawer that
     has stopped rendering parcels for everybody, which is a different bug and
     a worse one: a real order whose waybill is missing is exactly the case the
     red prompt exists to shout about. */
  ['a storefront order still shows its parcel and shouts about the missing waybill',
   openDetail('wechat', PHANTOM_PARCEL), [
    ['the waybill prompt is there', `sheetText().includes('No waybill on this parcel yet')`],
    ['the mode is named',           `sheetText().includes('Land')`],
    ['and the lines are in a parcel', `sheetText().includes('1 parcel')`],
    ['it is not mapped read-only',  `state.liveDetail.viewOnly === false`],
  ]],

  /* A mirrored order that never had a phantom parcel — the shape every one of
     them has now that the server refuses to plan them. Nothing to suppress, so
     this is asserting the drawer does not INVENT one from the order-level
     tracking fields either. */
  ['a mirrored order with no parcels at all is still parcel-free',
   openDetail('gzgrocery', '[]'), [
    ['no waybill prompt', `!sheetText().includes('No waybill')`],
    ['no tracking block', `!sheetText().includes('Tracking')`],
    ['the items are there', `sheetText().includes('Sourdough loaf')`],
  ]],
];

run('mirrored order drawer', CASES);
