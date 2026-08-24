#!/usr/bin/env node
/**
 * Does the order sheet name a PRODUCT in the operator's language?
 *
 *   node scripts/test_mobile_i18n_names.js
 *
 * Reported from the shop floor: the whole sheet was Chinese — 订单, 已送达,
 * 合计, 收货地址, 履约门店 — and then the product line said "Organic Garlic
 * Powder". The data was never the problem: retail_order_items carries both
 * name_en and name_cn, and 4,062 of 4,075 lines have the Chinese one.
 *
 * ITEM_TUPLE simply read `name_en || name || name_cn` whatever the language,
 * alone among every other name in this file. It now carries a [en, zh] PAIR
 * that T() resolves at render time — not a name picked when the payload
 * lands. That distinction is load-bearing and is case 3 below: mapDetail's
 * result is cached in state.liveDetail, and toggleLang only re-renders (it
 * never refetches), so a name resolved at map time keeps speaking the old
 * language until something else happens to refetch the order.
 *
 * Case 4 guards the other direction. The probe fixtures hand-seed `items` as
 * already-built tuples whose name is a plain string, so itemRow has to accept
 * both shapes — indexing a string would print its first LETTER as the product
 * name, and no existing check looks at the name closely enough to catch it.
 */
const path = require('path');
const { run } = require(path.join(__dirname, 'lib', 'm-probe'));

// Row shape mirrors test_mobile_orders.js — known to open cleanly.
const ONE = `DB.orders=[{id:'GZ-140092', ch:'gzgrocery', cust:['TyRee Gains','TyRee Gains'], total:'¥24.80',
    placed:'2:22 PM', status:['Delivered','已送达'], kind:'delivered', ship:['Guangzhou · Tianhe','广州 · 天河区'],
    phone:'130****8112', addr:['Tianhe, Guangzhou','广州市天河区'], pay:['gzgrocery','gzgrocery'],
    txn:'', fulfil:['Tianhe store','天河店'], route:['Nearest store','最近门店'],
    trk:null, items:[[1,'Organic Garlic Powder','¥24.80']], breakdown:[['Subtotal','¥24.80']]}];
  DB.orders[0]._id=77; state.liveOrders=DB.orders;
  APP.cmd('tab','orders'); APP.cmd('openOrder','GZ-140092');`;

// A raw API-shaped payload, so mapDetail/ITEM_TUPLE actually runs on it — the
// seeded row above only gets the sheet open.
const RAW = `state.liveDetail=mapDetail({id:77, order_no:'GZ-140092', status:'delivered', total:24.8,
    nickname:'TyRee Gains', channel:'gzgrocery', shipments:[], addons:[],
    items:[{id:9, product_id:5, qty:1, unit_price:24.8, sku:'4-590',
            name_en:'Organic Garlic Powder', name_cn:'大蒜粉'}]});`;

const zh = `state.lang='zh'; LANG='zh'; `;
const en = `state.lang='en'; LANG='en'; `;

run('product names follow the language', [
  ['Chinese: the sheet names the product in Chinese',
   ONE + zh + RAW + `render();`, [
     ['the Chinese name is on screen', `sheetText().indexOf('大蒜粉')>=0`],
     ['and the English one is NOT',    `sheetText().indexOf('Organic Garlic Powder')<0`],
   ]],

  ['English: the same sheet still reads English',
   ONE + en + RAW + `render();`, [
     ['the English name is on screen', `sheetText().indexOf('Organic Garlic Powder')>=0`],
     ['and the Chinese one is NOT',    `sheetText().indexOf('大蒜粉')<0`],
   ]],

  // The reason the name travels as a pair rather than being picked in mapDetail.
  ['the language toggle alone re-languages it — no refetch',
   ONE + en + RAW + `render(); APP.cmd('toggleLang');`, [
     ['it flips to Chinese', `sheetText().indexOf('大蒜粉')>=0`],
     ['English is gone',     `sheetText().indexOf('Organic Garlic Powder')<0`],
   ]],

  // A tuple whose name is a plain string must still render whole.
  ['a hand-seeded string name renders whole, not its first letter',
   ONE + zh + `render();`, [
     ['the whole name is there', `sheetText().indexOf('Organic Garlic Powder')>=0`],
   ]],
]);
