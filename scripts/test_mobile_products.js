#!/usr/bin/env node
/**
 * Products — the kinds of product that have no stock of their own.
 *
 *   node scripts/test_mobile_products.js
 *
 * The desktop's catalogue treats three shapes differently, and for the same
 * reason each time: a number typed into their stock cell would mean nothing.
 *
 *   • **Supplier-direct** (`ship_from_supplier`) — ships from the supplier, so
 *     it holds none of your stock and never runs out. The desktop shows an
 *     availability badge instead of a count.
 *   • **Paused supplier item** (`supplier_paused`) — the operator has stopped
 *     selling it. Not orderable. The phone showed it as Live, which is the one
 *     thing it is not.
 *   • **Assembled bundle** (`is_bundle`) — stock is computed from its parts,
 *     never typed.
 *
 * The phone drew a per-store stepper for all three and would have written the
 * number through the canonical inventory path.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const STORES = `state.prodStores=[{id:1,name_en:'Tianhe',name_cn:'天河',qty:2},
                                  {id:2,name_en:'Yuexiu',name_cn:'越秀',qty:5}];
  state.prodStockReady=true;`;

const open = (row) => STORES + `DB.products=[${row}]; APP.cmd('tab','products');
  state.productSku=DB.products[0].sku; render();`;

const SUPPLIER = `{sku:'SD-1',_id:9,name:['Supplier item','直发商品'],price:'¥20',priceNum:20,
  status:['Live','在售'],kind:'on',stock:0,stockLabel:['0 in stock','库存 0'],supplier:true,paused:false}`;
const PAUSED = `{sku:'SD-2',_id:10,name:['Paused item','暂停商品'],price:'¥20',priceNum:20,
  status:['Paused','已暂停'],kind:'off',stock:0,stockLabel:['0 in stock','库存 0'],supplier:true,paused:true}`;
const BUNDLE = `{sku:'BD-1',_id:11,name:['Gift box','礼盒'],price:'¥99',priceNum:99,
  status:['Live','在售'],kind:'on',stock:4,stockLabel:['4 in stock','库存 4'],bundle:true}`;
const PLAIN = `{sku:'OM-1L',_id:12,name:['Oat milk 1L','燕麦奶 1L'],price:'¥18',priceNum:18,
  status:['Live','在售'],kind:'on',stock:12,stockLabel:['12 in stock','库存 12']}`;

const steppers = "document.querySelectorAll('.sheet .stepbtn').length";

const CASES = [
  ['a supplier-direct item', open(SUPPLIER), [
    ['reads Available, not a count', `sheetText().includes('Available')`],
    ['and says why',                 `sheetText().includes('never runs out')`],
    ['NO STOCK STEPPER',             `${steppers} === 0`],
    ['the price is still editable',  `!!document.getElementById('mPrice')`],
  ]],
  ['a paused supplier item', open(PAUSED), [
    ['reads Paused',                     `sheetText().includes('Paused')`],
    ['and says customers cannot order it', `sheetText().includes('cannot order it')`],
    ['not Available',                    `!sheetText().includes('Available')`],
    ['no stepper',                       `${steppers} === 0`],
  ]],
  ['an assembled bundle', open(BUNDLE), [
    ['shows the derived count', `sheetText().includes('4')`],
    ['and says it follows the parts', `sheetText().includes('follows the parts')`],
    ['no stepper',              `${steppers} === 0`],
  ]],
  ['an ordinary product still counts per store', open(PLAIN), [
    ['both stores are there', `sheetText().includes('Tianhe') && sheetText().includes('Yuexiu')`],
    ['with steppers',         `${steppers} === 4`],
  ]],
  ['a paused supplier item is not "Live" in the list', STORES
    + `DB.products=[${PAUSED}]; state.liveProductsLoaded=true; APP.cmd('tab','products');`, [
    // mapProduct decides this; the CARD is what the operator scans. Scoped to
    // the card, because "Live" and "Out" are also the names of two filter
    // chips at the top of this screen.
    ['it says Paused',
     "[].slice.call(document.querySelectorAll('#content .card')).some(function(c){return c.innerText.indexOf('Paused item')>=0 && c.innerText.indexOf('Paused')>=0})"],
    ['not Live',
     "[].slice.call(document.querySelectorAll('#content .card')).every(function(c){return c.innerText.indexOf('Paused item')<0 || c.innerText.indexOf('Live')<0})"],
    ['and not Out either — it has no stock of ours to be out of',
     "[].slice.call(document.querySelectorAll('#content .card')).every(function(c){return c.innerText.indexOf('Paused item')<0 || c.innerText.indexOf('Out')<0})"],
  ]],
];

/* Saving one product's stock used to shrink the whole catalogue.
 *
 * The sheet's save ended with a refetch of `/products?limit=50` — boot's
 * snapshot, taken so Home can count low stock without paying for the shelf —
 * not the `?limit=500` the catalogue itself is read with. So a shop with two
 * hundred products changed a count on one of them and watched its chips fall to
 * "All 50", its categories thin out, and the product it had just edited vanish
 * if it sorted past the fiftieth. Nothing asked for the full catalogue again,
 * because loadCatalogue had already run once — only closing and reopening the
 * app put the shelf back.
 *
 * The stub honours ?limit=, exactly as the endpoint does: a fifty-row refetch
 * really does come back with fifty rows here.
 */
const SHELF = `DB.products=[]; for(var i=1;i<=120;i++){ DB.products.push({sku:'P-'+i,_id:i,
    name:['Product '+i,'产品 '+i],price:'¥10',priceNum:10,status:['Live','在售'],kind:'on',pub:true,
    stock:200,stockLabel:['200 in stock','库存 200'],cat:'Pantry',hay:'product '+i}); }
  state.liveProductsLoaded=true;
  // The catalogue has already been read once — which is what made this stick.
  state.catalogueTried=true;
  state.prodStores=[{id:1,name_en:'Tianhe',name_cn:'天河',qty:2}]; state.prodStockReady=true;
  APP.cmd('tab','products'); state.productSku='P-7'; render();`;

const SERVER = `window.__sent=[];
  window.fetch=function(u,o){ var url=String(u); window.__sent.push({u:url, m:(o&&o.method)||'GET'});
    var body={success:true,data:{}};
    if(url.indexOf('/products?')>=0){
      var lim=Number((url.match(/limit=(\\d+)/)||[])[1]||500), rows=[];
      for(var i=1;i<=Math.min(120,lim);i++) rows.push({id:i,name_en:'Product '+i,sku:'P-'+i,
        sell_price:10,effective_stock:200,is_published:1});
      body={success:true,data:rows};
    }
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(body)}}); };`;

// saveProductEdits does not await the catalogue re-read (nothing on screen waits
// on it), so settle its own promise and then let the re-read land.
const SAVE = `window.__settle=saveProductEdits().then(function(){
    return new Promise(function(r){ setTimeout(r,50); }); });`;

CASES.push(["saving one product's stock leaves the rest of the catalogue alone",
  SHELF + `sheetStep['st_1']=9;` + SERVER + SAVE, [
  ['the count goes to the store', "window.__sent.some(function(r){return r.u.indexOf('/stores/1/stock/7')>=0 && r.m==='PATCH'})"],
  ['THE SHELF IS STILL THE WHOLE SHELF', 'DB.products.length === 120'],
  ['it re-reads the catalogue, all of it', "window.__sent.some(function(r){return r.u.indexOf('/products?limit=500')>=0})"],
  ['never boot\'s fifty-row snapshot',    "!window.__sent.some(function(r){return /limit=50(\\D|$)/.test(r.u)})"],
  // The chip the operator was looking at when they hit save.
  ['so the All chip still counts them all', "document.getElementById('content').innerText.indexOf('120') >= 0"],
]]);

run('products', CASES);
