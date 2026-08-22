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

run('products', CASES);
