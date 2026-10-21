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
 *   • two products that match equally are offered, never guessed between;
 *   • the recogniser's language is a chip, remembered on the device;
 *   • a phrase this person confirmed before is read without the model, and a
 *     confirmed card teaches the next one (§493 rule 7);
 *   • a sentence the phone cannot read goes to the model when the shop has one
 *     (rule 8), and the model's answer becomes the card — or the phone's own
 *     reading stands when the model fails.
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
  state.qs.ctx={enabled:true,mode:'add',${ONE}}; state.qs.heard={mine:{},others:{}};
  state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true; ${ITEMS}
  state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`;
const GRANTED = SHELF.replace('render();', 'state.qs.canRecount=true; render();');
const COUNTING = CLERK + NO_SR + `
  state.qs.ctx={enabled:true,mode:'recount',${ONE}}; state.qs.heard={mine:{},others:{}};
  state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true; ${ITEMS}
  state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`;
const TWO_STORES = COUNTING.replace(ONE, TWO);

const CATCH = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body,m:o&&o.method});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;

/* A recogniser that only records what it was asked: the language it was
   started in, and whether it was aborted. */
const FAKE_SR = `window.__sr=[]; window.SpeechRecognition=function(){ var me=this; me.start=function(){ window.__sr.push({lang:me.lang,ev:'start'}); };
  me.stop=function(){ window.__sr.push({ev:'stop'}); if(me.onend) me.onend(); }; me.abort=function(){ window.__sr.push({ev:'abort'}); }; };
  window.webkitSpeechRecognition=undefined;`;
const WITH_SR = (fx) => fx.replace(NO_SR, FAKE_SR);
// The shop has a model: the context says so, and fetch answers the understand call.
const AI = (fx, answer) => fx.replace("mode:'recount',", "ai:true,mode:'recount',").replace("mode:'add',", "ai:true,mode:'add',") + `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body,m:o&&o.method});
    var isAi=String(u).indexOf('/quick-stock/understand')>-1;
    return Promise.resolve({ok:${answer === 'FAIL' ? 'false' : 'true'},status:${answer === 'FAIL' ? 502 : 200},json:function(){return Promise.resolve(isAi?${answer === 'FAIL' ? '{success:false,error:"model_failed"}' : `{success:true,data:${answer}}`}:{success:true})}}); };`;
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
    ['one stock write', "window.__sent.filter(function(s){return s.m==='PATCH'}).length===1"],
    ['a delta', "JSON.parse(window.__sent.find(function(s){return s.m==='PATCH'}).b).delta===3"],
    ['as a kitchen add', "JSON.parse(window.__sent.find(function(s){return s.m==='PATCH'}).b).reason==='kitchen_add'"],
    ['to the product', "window.__sent.find(function(s){return s.m==='PATCH'}).u.indexOf('/stores/1/stock/7')>-1"],
    ['and the name said for it is learned', "state.qs.heard.mine['hummusasli']===7"],
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
  ['with a recogniser, opening listens at once in the chosen language, and the chips are there',
    WITH_SR(COUNTING) + "try{localStorage.removeItem('roots_qs_voice_lang')}catch(e){} APP.cmd('qsCmdOpen');", [
      ['it started', "window.__sr.length===1 && window.__sr[0].ev==='start'"],
      ['in English, the app\'s language', "window.__sr[0].lang==='en-US'"],
      ['the English chip is lit', "!!document.querySelector('.sheet .chip.on') && document.querySelector('.sheet .chip.on').innerText.trim()==='English'"],
      ['the Chinese chip is there', "sheetText().indexOf('中文')>-1"],
      ['the mic button is lit while listening', "document.getElementById('mQsCmdMic').classList.contains('on')"],
      ['and says so', "sheetText().indexOf('Listening…')>-1"],
    ]],
  ['switching the chip while listening starts again in Chinese, and the choice is kept',
    WITH_SR(COUNTING) + "try{localStorage.removeItem('roots_qs_voice_lang')}catch(e){} APP.cmd('qsCmdOpen'); APP.cmd('qsCmdLang','zh');", [
      ['the first run was stopped', "window.__sr.some(function(e){return e.ev==='abort'})"],
      ['a second began in Chinese', "window.__sr.filter(function(e){return e.ev==='start'}).length===2 && window.__sr[window.__sr.length-1].lang==='zh-CN'"],
      ['the Chinese chip is lit', "document.querySelector('.sheet .chip.on').innerText.trim()==='中文'"],
      ['and the device remembers it', "localStorage.getItem('roots_qs_voice_lang')==='zh'"],
    ]],
  ['a phrase this person confirmed before is read without the model',
    AI(COUNTING, 'null').replace("state.qs.heard={mine:{},others:{}}", "state.qs.heard={mine:{homeless:7},others:{}}") + SAY('homeless 5 left'), [
      ['the card is up at once', "sheetText().indexOf('Hummus Asli')>-1 && sheetText().indexOf('Set count to 5')>-1"],
      ['and the model was not asked', "!window.__sent.some(function(s){return s.u.indexOf('/quick-stock/understand')>-1})"],
    ]],
  ['a phrase nobody has confirmed, with no model, is no match',
    COUNTING + SAY('homeless 5 left'), [
      ['no products match', "sheetText().indexOf('No products match')>-1"],
    ]],
  ['confirming a card teaches the phrase',
    COUNTING + CATCH + SAY('hummus asli 5 left') + "APP.cmd('qsCmdGo');", [
      ['the phrase is learned on the phone', "state.qs.heard.mine['hummusasli']===7"],
      ['and sent to the server', "window.__sent.some(function(s){return s.u.indexOf('/quick-stock/heard')>-1 && JSON.parse(s.b).heard==='hummusasli' && JSON.parse(s.b).product_id===7})"],
      ['the stock write still went', "window.__sent.some(function(s){return s.m==='PATCH'})"],
    ]],
  ['a sku said plainly teaches nothing',
    COUNTING + CATCH + SAY('1-10 sold out') + "APP.cmd('qsCmdGo');", [
      ['nothing learned', "Object.keys(state.qs.heard.mine).length===0"],
      ['nothing sent to the memory', "!window.__sent.some(function(s){return s.u.indexOf('/quick-stock/heard')>-1})"],
    ]],
]);

/* The model path resolves in a microtask after the fetch, so these settle. */
run('saying a stock change, with a model', [
  ['a garbled name goes to the model, whose answer is the card',
    AI(COUNTING, '{product_id:7,candidates:[],store_id:null,action:"set",qty:4,confidence:0.8}') + SAY('homeless four left'), [
      ['the model was asked', "window.__sent.some(function(s){return s.u.indexOf('/quick-stock/understand')>-1 && JSON.parse(s.b).text==='homeless four left' && JSON.parse(s.b).store_id===1})"],
      ['the card shows its product', "sheetText().indexOf('Hummus Asli')>-1"],
      ['and its amount', "sheetText().indexOf('Set count to 4')>-1"],
      ['Confirm offered', "!!document.querySelector('.sheet button[onclick=\"APP.cmd(\\'qsCmdGo\\')\"]')"],
    ]],
  ['its candidates are offered when it is unsure',
    AI(COUNTING, '{product_id:null,candidates:[7,8],store_id:null,action:null,qty:null,confidence:0.4}') + SAY('something 4'), [
      ['the question', "sheetText().indexOf('Which product?')>-1"],
      ['both on offer', "sheetText().indexOf('Hummus Asli')>-1 && sheetText().indexOf('Turkish Tomato Salad')>-1"],
    ]],
  ['a store it heard is the store on the card',
    AI(TWO_STORES, '{product_id:8,candidates:[],store_id:2,action:"set",qty:0,confidence:0.9}') + SAY('tomato gone at yx'), [
      ['Yuexiu', "sheetText().indexOf('Yuexiu')>-1"],
      ['sold out', "sheetText().indexOf('Sold out — set to 0')>-1"],
    ]],
  ['when the model fails, the phone\'s own reading stands',
    AI(COUNTING, 'FAIL') + SAY('hummus asli 5 left'), [
      ['the card from the phone\'s reading', "sheetText().indexOf('Hummus Asli')>-1 && sheetText().indexOf('Set count to 5')>-1"],
    ]],
  ['while the model is thinking the sheet says so and offers only Cancel',
    AI(COUNTING, '{product_id:7,candidates:[],store_id:null,action:"set",qty:4,confidence:0.8}').replace('window.fetch=function(u,o){', 'window.fetch=function(u,o){ if(String(u).indexOf("understand")>-1) return new Promise(function(){});') + SAY('homeless four left'), [
      ['Working…', "sheetText().indexOf('Working…')>-1"],
      ['Cancel only', "sheetText().indexOf('Cancel')>-1 && !document.querySelector('.sheet button[onclick=\"APP.cmd(\\'qsCmdGo\\')\"]') && !document.getElementById('mQsCmd')"],
    ]],
  ['confirming the model\'s card teaches the phrase, so next time the model is not needed',
    AI(COUNTING, '{product_id:7,candidates:[],store_id:null,action:"set",qty:4,confidence:0.8}') + SAY('homeless four left') + "setTimeout(function(){ APP.cmd('qsCmdGo'); },50);", [
      ['learned as homeless', "state.qs.heard.mine['homeless']===7"],
      ['sent to the server', "window.__sent.some(function(s){return s.u.indexOf('/quick-stock/heard')>-1})"],
      ['and the count was written', "window.__sent.some(function(s){return s.m==='PATCH' && JSON.parse(s.b).physical_qty===4})"],
    ]],
], { settle: 300 });
