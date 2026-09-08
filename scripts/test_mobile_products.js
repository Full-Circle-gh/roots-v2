#!/usr/bin/env node
/**
 * The product sheet: the kinds of product that have no stock of their own, and
 * the sizes of the ones that come in several.
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
 * And a fourth shape, which is not about stock at all: a **variant family**. A
 * product sold in three sizes is three rows in the catalogue and one card, and
 * the card opened whichever size owned the group. The other sizes were printed
 * on it, in a row, and could not be edited from the phone at all. The sheet
 * carries the family now — the chips switch which size is being edited, the
 * switch writes nothing, and what is half-typed into one size is still there
 * after a trip to its sibling.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const STORE_ROWS = `[{id:1,name_en:'Tianhe',name_cn:'天河',qty:2},
                    {id:2,name_en:'Yuexiu',name_cn:'越秀',qty:5}]`;

/* Per-store rows are held per PRODUCT ID — the sheet moves between the sizes of
   one family and each size has its own counts — so the seed follows the rows
   that were just put in DB.products. */
const stocked = `DB.products.forEach(function(p){ state.prodStock[p._id]=${STORE_ROWS}; });
  state.prodStockReady=true;`;

const open = (row) => `DB.products=[${row}]; ${stocked} APP.cmd('tab','products');
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
const chips = "document.querySelectorAll('.sheet .chip')";
const onChip = "(document.querySelector('.sheet .chip.on')||{innerText:''}).innerText";
const priceBox = "(document.getElementById('mPrice')||{}).value";

/* A VARIANT FAMILY. Three sizes of one sorbet are three rows here and one card
   in the catalogue, and tapping that card opened the family's representative —
   which left every other size listed on the card, visible, and uneditable from
   the phone. The sheet carries the whole family now.
   gid is the group id and matches no _id here on purpose: a family whose owner
   row is not among the sizes on this page is the ordinary case. */
const size = (id, label, sort, price) => `{sku:'RM-${label}',_id:${id},gid:101,vLabel:'${label}',vSort:${sort},
  name:['Raspberry Mango Sorbet','树莓芒果雪葩'],price:'¥${price}',priceNum:${price},
  status:['Live','在售'],kind:'on',stock:9,stockLabel:['9 in stock','库存 9']}`;
const FAMILY = `DB.products=[${size(21, 'X1', 0, 40)},${size(22, 'X5', 1, 132)},${size(23, 'X10', 2, 240)}];
  ${stocked} APP.cmd('tab','products'); state.productSku='RM-X1'; render();`;

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
    ['the steppers start at what the shop holds', `sheetText().includes('2') && sheetText().includes('5')`],
    ['and nothing to switch between', `${chips}.length === 0`],
  ]],
  ['a variant family offers every size', FAMILY, [
    ['all three are on the sheet', `${chips}.length === 3`],
    ['in size order',              `[].map.call(${chips},function(c){return c.innerText}).join('|') === 'X1|X5|X10'`],
    ['the open one is marked',     `${onChip}.trim() === 'X1'`],
    ['and it is the one being edited', `${priceBox} === '40'`],
  ]],
  ['tapping a size moves the sheet to it', FAMILY + `APP.cmd('pickVariant','23');`, [
    ['the mark moves',   `${onChip}.trim() === 'X10'`],
    ['the SKU follows',  `sheetText().includes('RM-X10')`],
    ['and so does the price — THIS is what could not be reached before',
     `${priceBox} === '240'`],
  ]],
  // Switching sizes writes nothing, so what is half-typed into one size has to
  // still be there on the way back — otherwise the trip to a sibling silently
  // eats it.
  ['pending edits survive the trip to a sibling',
    FAMILY + `APP.cmd('priceTyped','44'); APP.cmd('stepInc','st_21_1');
              APP.cmd('pickVariant','22'); APP.cmd('pickVariant','21');`, [
    ['the typed price is still in the box', `${priceBox} === '44'`],
    ['and the count is still stepped up',   `sheetStep['st_21_1'] === 3`],
    ['the sibling kept its own price',      `sheetPrice[22] === undefined`],
    ['and its own count',                   `sheetStep['st_22_1'] === 2`],
  ]],
  // The price box is repainted from scratch on every render, and a stock
  // stepper renders. Typed, then stepped, the price used to be painted back to
  // what the product cost before.
  ['a stepper does not eat the price being typed',
    open(PLAIN) + `APP.cmd('priceTyped','21.5'); APP.cmd('stepInc','st_12_1');`, [
    ['the typed price is still there', `${priceBox} === '21.5'`],
    ['and the count went up',          `sheetStep['st_12_1'] === 3`],
  ]],
  ['a paused supplier item is not "Live" in the list',
    `DB.products=[${PAUSED}]; ${stocked} state.liveProductsLoaded=true; APP.cmd('tab','products');`, [
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
