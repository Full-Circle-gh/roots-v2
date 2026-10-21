#!/usr/bin/env node
/**
 * Saying a stock change (§493) — the sheet, in a browser.
 *
 *   CHROME_BIN=/path/to/chrome node scripts/test_mobile_stock_command.js
 *
 * scripts/test_quick_stock_command.js proves the parser reads a sentence
 * right. This file proves the SCREEN does the right thing with the reading:
 *   • the microphone sits beside Quick Stock's search, off until the shelf is
 *     here, and opens one sheet with one field;
 *   • a browser with no recogniser gets the field and the note, not a dead
 *     button;
 *   • the card names the product, the sku, the store and the one sentence
 *     that will be written, and Confirm is withheld while there is a reason;
 *   • a kitchen without the recount grant is told it can add, not set;
 *   • Confirm writes through the screen's own doors: a clerk's "sold out" is
 *     an absolute 0 on the wire, a kitchen's "made 3" is a delta of 3, a
 *     kitchen WITH the grant lowering a count meets §46's fork, and a store
 *     named in the sentence switches the screen before anything is written;
 *   • two products that match equally are offered, never guessed between.
 *
 * Drives Chromium through scripts/lib/m-probe, so it belongs in the slow
 * shard and is listed there by name in scripts/run-suites.js.
 */
'use strict';

const { run } = require('./lib/m-probe');

const KITCHEN = "state.caps=['quickstock:add','purchasing:receive'];";
const CLERK = "state.caps=['quickstock:recount'];";
// No recogniser in this browser: the typed path is the one under test.
const NO_SR = 'window.SpeechRecognition=undefined; window.webkitSpeechRecognition=undefined;';
const ITEMS = `state.qs.items=[
    {product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10',physical_qty:11},
    {product_id:8,name_en:'Turkish Tomato Salad',name_cn:'土耳其番茄沙拉',sku:'1-15',physical_qty:0}
  ];`;
const ONE = "stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]";
const TWO = "stores:[{id:1,name_en:'Tianhe',name_cn:'天河'},{id:2,name_en:'Yuexiu',name_cn:'越秀'}]";
const SHELF = KITCHEN + NO_SR + `
  state.qs.ctx={enabled:true,mode:'add',${ONE}};
  state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true; ${ITEMS}
  state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`;
const GRANTED = SHELF.replace('render();', 'state.qs.canRecount=true; render();');
const COUNTING = CLERK + NO_SR + `
  state.qs.ctx={enabled:true,mode:'recount',${ONE}};
  state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true; ${ITEMS}
  state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`;
const TWO_STORES = COUNTING.replace(ONE, TWO);

const CATCH = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body,m:o&&o.method});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;

const MIC = "document.querySelector('#content button[onclick=\"APP.cmd(\\'qsCmdOpen\\')\"]')";
const SAY = (text) => `APP.cmd('qsCmdOpen'); APP.cmd('qsCmdText',${JSON.stringify(text)}); APP.cmd('qsCmdCheck');`;
const body = "txt('content').replace(/\\s+/g,' ')";

run('saying a stock change', [
  ['the microphone sits beside the search, live once the shelf is here', SHELF, [
    ['the button is on the screen', `!!${MIC}`],
    ['beside the search field', `${MIC}.parentElement===document.getElementById('mQsQ').closest('.stick-top')`],
    ['and it is live', `!${MIC}.disabled`],
    ['no sheet yet', "!document.querySelector('.sheet')"],
  ]],
  ['before the shelf has loaded it is off', SHELF.replace(ITEMS, 'state.qs.items=null;'), [
    ['the button is drawn', `!!${MIC}`],
    ['disabled', `${MIC}.disabled===true`],
  ]],
  ['opening it draws one sheet with one field and, with no recogniser, the note',
    SHELF + "APP.cmd('qsCmdOpen');", [
      ['the sheet is up', "sheetText().indexOf('Say or type a change')>-1"],
      ['with the field', "!!document.getElementById('mQsCmd')"],
      ['the field has the keyboard', "document.activeElement&&document.activeElement.id==='mQsCmd'"],
      ['no microphone button inside it', "!document.getElementById('mQsCmdMic')"],
      ['and the note says why', "sheetText().indexOf('Voice isn’t available in this browser')>-1"],
      ['the example names a product the screen holds', "sheetText().indexOf('1-10')>-1"],
      ['and the store in use', "sheetText().indexOf('Tianhe')>-1"],
    ]],
  ['a clerk saying sold out gets the card and a Confirm', COUNTING + SAY('1-10 sold out'), [
    ['the product', "sheetText().indexOf('Hummus Asli')>-1"],
    ['its sku', "sheetText().indexOf('1-10')>-1"],
    ['the store', "sheetText().indexOf('Tianhe')>-1"],
    ['the sentence', "sheetText().indexOf('Sold out — set to 0')>-1"],
    ['the sentence said back', "sheetText().indexOf('“1-10 sold out”')>-1"],
    ['Confirm offered', "!!document.querySelector('.sheet button[onclick=\"APP.cmd(\\'qsCmdGo\\')\"]')"],
    ['nothing written yet', "state.qs.fixing[7]==null"],
  ]],
  ['a kitchen without the grant is told it can add, not set', SHELF + SAY('1-10 sold out'), [
    ['the product is still named', "sheetText().indexOf('Hummus Asli')>-1"],
    ['the reason', "sheetText().indexOf('Here you can add stock, not set the count.')>-1"],
    ['no Confirm', "!document.querySelector('.sheet button[onclick=\"APP.cmd(\\'qsCmdGo\\')\"]')"],
    ['Back is there', "sheetText().indexOf('Back')>-1"],
  ]],
  ['a product and no amount is asked for one', COUNTING + SAY('hummus asli'), [
    ['the reason', "sheetText().indexOf('Say how many, or “sold out”.')>-1"],
    ['no Confirm', "!document.querySelector('.sheet button[onclick=\"APP.cmd(\\'qsCmdGo\\')\"]')"],
  ]],
  ['nothing matching says so', COUNTING + SAY('zebra 4'), [
    ['the live empty-search line', "sheetText().indexOf('No products match')>-1"],
  ]],
  ['two products that match equally are offered, not guessed',
    COUNTING.replace("sku:'1-15'", "sku:'1-15',name_en:'Hummus Spicy'") + SAY('hummus 4'), [
      ['the question', "sheetText().indexOf('Which product?')>-1"],
      ['both on offer', "sheetText().indexOf('Hummus Asli')>-1 && sheetText().indexOf('Hummus Spicy')>-1"],
      ['no Confirm yet', "!document.querySelector('.sheet button[onclick=\"APP.cmd(\\'qsCmdGo\\')\"]')"],
    ]],
  ['picking one carries the amount across', COUNTING.replace("sku:'1-15'", "sku:'1-15',name_en:'Hummus Spicy'") + SAY('hummus 4') + "APP.cmd('qsCmdPick',1);", [
    ['the pick is the card', "sheetText().indexOf('Hummus Spicy')>-1 && sheetText().indexOf('Which product?')===-1"],
    ['with the amount', "sheetText().indexOf('Set count to 4')>-1"],
    ['Confirm offered', "!!document.querySelector('.sheet button[onclick=\"APP.cmd(\\'qsCmdGo\\')\"]')"],
  ]],
  ['Back returns to the field with the sentence kept', COUNTING + SAY('1-10 sold out') + "APP.cmd('qsCmdBack');", [
    ['the field is back', "!!document.getElementById('mQsCmd')"],
    ['holding the sentence', "document.getElementById('mQsCmd').value==='1-10 sold out'"],
  ]],
  ['a clerk confirming sold out writes an absolute 0 through the card', COUNTING + CATCH + SAY('1-10 sold out') + "APP.cmd('qsCmdGo');", [
    ['the sheet is gone', "!document.querySelector('.sheet')"],
    ['one write', 'window.__sent.length===1'],
    ['to this store and product', "window.__sent[0].u.indexOf('/stores/1/stock/7')>-1"],
    ['a PATCH', "window.__sent[0].m==='PATCH'"],
    ['of physical_qty 0', 'JSON.parse(window.__sent[0].b).physical_qty===0'],
    ['the search shows that card', "state.qs.q==='1-10' && document.getElementById('mQsQ').value==='1-10'"],
    ['and the card says so', `${body}.indexOf('Hummus Asli')>-1 && ${body}.indexOf('Turkish Tomato')===-1`],
  ]],
  ['a kitchen confirming made 3 writes a delta of 3', SHELF + CATCH + SAY('made 3 hummus asli') + "APP.cmd('qsCmdGo');", [
    ['one write', 'window.__sent.length===1'],
    ['a delta', 'JSON.parse(window.__sent[0].b).delta===3'],
    ['as a kitchen add', "JSON.parse(window.__sent[0].b).reason==='kitchen_add'"],
    ['to the product', "window.__sent[0].u.indexOf('/stores/1/stock/7')>-1"],
  ]],
  ['the card for an add says Add 3', SHELF + SAY('made 3 hummus asli'), [
    ['the sentence', "sheetText().indexOf('Add 3')>-1"],
  ]],
  ['a kitchen with the grant lowering a count meets §46’s fork, and nothing is written yet', GRANTED + CATCH + SAY('1-10 sold out') + "APP.cmd('qsCmdGo');", [
    ['the fork is asked', "state.ask && sheetText().indexOf('The count has gone down')>-1"],
    ['shelf 11, said 0', "sheetText().indexOf('Shelf says 11, you counted 0')>-1"],
    ['nothing on the wire', 'window.__sent.length===0'],
  ]],
  ['a store named in the sentence is switched to before anything is written', TWO_STORES + CATCH + SAY('1-10 sold out at yuexiu'), [
    ['the card names Yuexiu', "sheetText().indexOf('Yuexiu')>-1"],
    ['Confirm offered', "!!document.querySelector('.sheet button[onclick=\"APP.cmd(\\'qsCmdGo\\')\"]')"],
  ]],
  ['confirming it moves the screen to that store and waits for its shelf', TWO_STORES + CATCH + SAY('1-10 sold out at yuexiu') + "APP.cmd('qsCmdGo');", [
    ['the screen is on Yuexiu', 'state.qs.storeId===2'],
    ['the change is held for that shelf', "state.qs.cmdPending && state.qs.cmdPending.id===7 && state.qs.cmdPending.qty===0 && state.qs.cmdPending.action==='set'"],
    ['no stock write yet', "!window.__sent.some(function(s){return s.m==='PATCH'})"],
    ['the shelf was asked for', "window.__sent.some(function(s){return s.u.indexOf('/stores/2/stock')>-1})"],
    ['the search is set to the product', "state.qs.q==='1-10'"],
  ]],
  ['while something is unsaved, another store is refused', TWO_STORES + "state.qs.typing[8]='3';" + SAY('1-10 sold out at yuexiu') + "APP.cmd('qsCmdGo');", [
    ['the sheet stays', "!!document.querySelector('.sheet')"],
    ['with the reason', "sheetText().indexOf('Finish what is unsaved first.')>-1"],
    ['still on Tianhe', 'state.qs.storeId===1'],
  ]],
  ['closing the sheet leaves the shelf as it was', COUNTING + "APP.cmd('qsCmdOpen'); APP.cmd('qsCmdClose');", [
    ['no sheet', "!document.querySelector('.sheet')"],
    ['the shelf is drawn', `${body}.indexOf('Hummus Asli')>-1`],
  ]],
]);
