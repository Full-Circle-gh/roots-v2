#!/usr/bin/env node
/**
 * Where the rider is — on the phone.
 *
 *   node scripts/test_mobile_rider.js
 *
 * The desktop drawer has shown the live rider (stage, name, number, distance
 * and a map with the scooter on it) since same-city dispatch went in. The phone
 * showed the WORD and stopped: "On the way", with no rider, no number, no
 * distance and no map — on the device the person at the counter is actually
 * holding when a customer asks where their order has got to.
 *
 * These probes assert the facts that answer that question, and the two rules
 * that keep them honest: the ETA leg is named (a rider going to COLLECT is not
 * minutes from the door), and a frozen row is warned about rather than drawn as
 * a scooter parked where the rider was ten minutes ago.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// SQLite hands zoneless UTC ('YYYY-MM-DD HH:MM:SS'), which is exactly the shape
// the staleness rule has to read correctly — so the fixtures speak it too.
const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);

const courier = (o) => JSON.stringify(Object.assign({
  stage: 'in_transit', carrier: '青云聚信',
  rider: { name: 'Li Wei', phone: '13800000000' },
  eta_seconds: 420, rider_to_cust_m: 1240, updated_at: stamp(30000),
}, o));

// The sheet, seeded straight from a detail payload — no fetch, the way the
// other order probes seed a row.
const openDetail = (c, status) => `
  const d = mapDetail({ id:77, order_no:'TC000535', status:'${status || 'dispatched'}', channel:'wechat',
    recipient_name:'Anna', recipient_phone:'13900000000', total:338, placed_at:'${stamp(3600000)}',
    fulfillment_type:'delivery', address_full:'Shenzhen · Nanshan', items:[], shipments:[],
    courier:${c} });
  state.liveDetail = d; state.detailId = d.id; state.detailMounted = true; render();`;

const CASES = [
  ['a rider on the way says where they are', openDetail(courier()), [
    ['the stage',            `sheetText().includes('On the way')`],
    ['THE DISTANCE',         `sheetText().includes('1.2 km')`],
    ['the minutes, worded for the customer leg', `sheetText().includes('~7 min away')`],
    ['the rider',            `sheetText().includes('Li Wei')`],
    // A number on a phone is a tap, not something to copy out by hand.
    ['a number to call them on', `!!document.querySelector('.sheet a[href="tel:13800000000"]')`],
    ['and a map to put it on',   `!!document.getElementById('riderMapHost')`],
  ]],

  ['the collect leg is not the delivery leg',
   openDetail(courier({ stage: 'heading_to_pickup', eta_seconds: 300 })), [
    ['it says the rider is coming', `sheetText().includes('Rider coming')`],
    ['minutes TO THE STORE',        `sheetText().includes('~5 min to store')`],
    // "~5 min away" here would tell the counter the parcel is nearly at the
    // customer's door when the rider has not yet reached the shop.
    ['never "away"',                `!sheetText().includes('min away')`],
  ]],

  ['a frozen row is a warning, not a map',
   openDetail(courier({ updated_at: stamp(40 * 60000) })), [
    ['it says so',        `sheetText().includes('Not updating')`],
    ['NO MAP IS DRAWN',   `!document.getElementById('riderMapHost')`],
    // The frozen numbers are a snapshot of ten minutes ago; showing them as
    // live is the whole failure the warning exists to prevent.
    ['no stale distance', `!sheetText().includes('1.2 km')`],
    ['no stale ETA',      `!sheetText().includes('~7 min')`],
  ]],

  ['nothing is claimed before a rider is on it',
   openDetail(courier({ stage: 'scheduled', rider: null, eta_seconds: null, rider_to_cust_m: null })), [
    ['no stage line', `!document.getElementById('riderStage')`],
    ['no map',        `!document.getElementById('riderMapHost')`],
  ]],

  ['a dropped-off order stops moving',
   openDetail(courier({ stage: 'delivered', eta_seconds: null, rider_to_cust_m: null }), 'delivered'), [
    ['it reads delivered', `sheetText().includes('Delivered')`],
    ['and no live map',    `!document.getElementById('riderMapHost')`],
  ]],

  // The list is where an operator scans before opening anything. It carried the
  // stage word alone, so "On the way" could mean two minutes or two kilometres
  // and the only way to find out was to open the order.
  ['the list row carries the distance too', `
    state.ordersView=[mapOrderRow({id:77, order_no:'TC000535', status:'dispatched', channel:'wechat',
      recipient_name:'Anna', total:338, placed_at:'${stamp(3600000)}', fulfillment_type:'delivery',
      tracking_number:null, courier:${courier()}})];
    state.liveOrders=state.ordersView; state.ordersLoading=false; APP.cmd('tab','orders');`, [
    ['the stage',      `txt('content').includes('On the way')`],
    ['AND HOW FAR OFF', `txt('content').includes('1.2 km')`],
  ]],
];

/* ---- The map itself -----------------------------------------------------
   Stubbed AMap + stubbed feed, because the point of the map is not that a grey
   box appears: it is that the scooter is ON it, that it keeps up (the card's
   own words are refreshed from the same payload, in place), and that a repaint
   — this app rewrites the whole page on every toast — puts the map back rather
   than building a second one. */
const STUB_MAP = `
  window.__builds=0; window.__markers=[];
  window.fetch=function(u){ u=String(u);
    var d = u.indexOf('maps-config')>=0 ? {provider:'amap',key:'k',security:''}
          : u.indexOf('delivery-track')>=0 ? window.__track : {};
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:d})}}); };
  window.AMap={
    Map:function(el,o){ window.__builds++; window.__map={el:el,centers:[],fitted:0};
      this.setCenter=function(c){window.__map.centers.push(c)};
      this.setFitView=function(){window.__map.fitted++};
      this.setZoomAndCenter=function(z,c){window.__map.centers.push(c)};
      this.resize=function(){}; this.destroy=function(){window.__map.destroyed=true}; },
    Marker:function(o){ window.__markers.push(o); this.setMap=function(){}; this.setPosition=function(p){o.position=p}; },
    Polyline:function(o){ this.setMap=function(){}; this.setPath=function(){}; } };`;

const TRACK = (o) => `window.__track=${JSON.stringify(Object.assign({
  tracking: true, stage: 'in_transit', eta_seconds: 120, rider_to_cust_m: 300,
  updated_at: stamp(5000), rider: { name: 'Li Wei', phone: '13800000000' },
  rider_position: { lat: 23.11, lng: 113.31 },
  shop_position: { lat: 23.13, lng: 113.33 },
  recipient_position: { lat: 23.09, lng: 113.28 },
  route: [{ lat: 23.13, lng: 113.33 }, { lat: 23.11, lng: 113.31 }],
}, o))};`;

CASES.push(['the scooter is on the map', STUB_MAP + TRACK() + openDetail(courier()), [
  ['a map was built',   `window.__builds===1`],
  ['THE RIDER IS ON IT', `window.__markers.some(function(m){return String(m.content).indexOf('Rider')>=0})`],
  ['so are both ends',  `window.__markers.some(function(m){return String(m.content).indexOf('Store')>=0})
                         && window.__markers.some(function(m){return String(m.content).indexOf('Customer')>=0})`],
  ['and it is framed to show them', `window.__map.fitted===1`],
]]);

CASES.push(['the card keeps up with the feed', STUB_MAP + TRACK() + openDetail(courier()), [
  // Seeded at 420s / 1240m; the feed says 120s / 300m. A card that still reads
  // "1.2 km" twenty minutes later is the old silence with extra confidence.
  ['the live distance',  `txt('riderEta').includes('300 m')`],
  ['the live ETA',       `txt('riderEta').includes('~2 min away')`],
  ['not the seeded one', `!txt('riderEta').includes('1.2 km')`],
]]);

CASES.push(['a repaint puts the map back, it does not rebuild it',
 STUB_MAP + TRACK() + openDetail(courier()) + `render(); render();`, [
  ['still one map',       `window.__builds===1`],
  ['and it is on screen', `document.getElementById('riderMapHost').contains(window.__map.el)`],
]]);

/* The row can say "on the way" while the feed already knows the rider dropped
   off — the list read is up to 15s old and the card is seeded from it. The feed
   wins: no scooter is drawn, the card is corrected, and the 25s loop stops
   rather than asking about a finished job forever. */
CASES.push(['a drop-off ends the run',
 STUB_MAP + TRACK({ stage: 'delivered', eta_seconds: null, rider_to_cust_m: null }) + openDetail(courier()), [
  ['no scooter is drawn',   `window.__builds===0 && window.__markers.length===0`],
  ['the card is corrected', `txt('riderStage')==='Delivered'`],
  ['no frozen distance',    `txt('riderEta')===''`],
  ['and it says why',       `document.getElementById('riderMapHost').innerText.indexOf('Delivered')>=0`],
  ['the loop has stopped',  `_mMap.done===true && _mMap.timer===null`],
]]);

/* The map cases start asynchronous work (the SDK load, the first track read),
   so the checks wait a beat — see `settle` in lib/m-probe. The paint-only cases
   above are unaffected by waiting. */
run('rider location', CASES, { settle: 300 });
