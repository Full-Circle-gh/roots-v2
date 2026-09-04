#!/usr/bin/env node
/**
 * Picking — the warehouse's half of a two-step transfer, rendered headless.
 *
 *   node scripts/test_stock_picking.js
 *
 * Drawn in design-handoff/warehouse-picking/, ruled in §39. What is checked is
 * the handful of things that decide whether the record and the freezer stay
 * together, each of which fails quietly:
 *
 *   • NOTHING IS PRE-FILLED. When a line comes up short, every store's field
 *     opens BLANK — not zero, which is an amount he chose, and not a share of
 *     the shortfall, which §39 rejected twice over: filling in list order makes
 *     the same store lose every time, and a proportional split assumes every
 *     product matters equally to every shop. Only the man in the freezer knows.
 *     This is the assertion the screen exists for.
 *   • THE REMAINDER IS THE ONLY GATE, AND IT NEVER SCOLDS. Save stays inactive
 *     until the remainder is zero, over-assignment says take some back, and
 *     there is no error text anywhere in the flow.
 *   • A DISPATCH IS NEVER BLOCKED BY THE RECORD (§39 Ruling 1). Nothing here
 *     reads stock before dispatching and nothing refuses on it. A screen that
 *     checked would be reintroducing the gate the ruling deleted.
 *   • A FAILED DISPATCH IS SHOWN AND NOT RETRIED. The retry door is #244's
 *     work; a control here would be that feature arriving through the back
 *     door, so the failure case asserts the message appears AND that nothing
 *     offers to run it again.
 *   • THE ENDPOINTS ARE #242's, AND ONLY #242's. Every call is recorded and
 *     compared against what already ships. A fourth URL fails the run.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..', 'public', 'stock.html');
const src = fs.readFileSync(APP, 'utf8');

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const p = require('playwright').chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* playwright not installed here */ }
  for (const g of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome']) if (fs.existsSync(g)) return g;
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      const p = path.join(pw, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const CTX = {
  enabled: true, mode: 'recount',
  user: { name: 'Asher', full_access: true },
  stores: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店', code: 'TH' }],
};
const ROWS = [{ product_id: 7, name_en: 'Hummus Asli', name_cn: '鹰嘴豆泥', sku: '1-10', physical_qty: 11, restock_target: 5 }];

// Two store requests for the same two products — the combined walk the pick
// list is built to produce. Chilli oil is the short line: 18 asked across two
// shops, and the picker will find 14.
const ORDERS = [
  { id: 71, rs_number: 'RS-260902-004', status: 'sent', from_role: 'store', to_role: 'warehouse',
    goods_state: 'none', store_name: 'Tianhe', store_cn: '天河店', item_count: 2,
    items: [
      { id: 711, product_id: 7, product_name: 'Frozen dumplings 500g', product_cn: '冷冻水饺 500g', sku: 'FD-500', qty_requested: 40, qty_sent: null, is_checked: 0 },
      { id: 712, product_id: 8, product_name: 'Chilli oil 250ml', product_cn: '辣椒油 250ml', sku: 'CO-250', qty_requested: 10, qty_sent: null, is_checked: 0 },
    ] },
  { id: 72, rs_number: 'RS-260902-005', status: 'sent', from_role: 'store', to_role: 'warehouse',
    goods_state: 'none', store_name: 'Yuexiu', store_cn: '越秀店', item_count: 2,
    items: [
      { id: 721, product_id: 7, product_name: 'Frozen dumplings 500g', product_cn: '冷冻水饺 500g', sku: 'FD-500', qty_requested: 25, qty_sent: null, is_checked: 0 },
      { id: 722, product_id: 8, product_name: 'Chilli oil 250ml', product_cn: '辣椒油 250ml', sku: 'CO-250', qty_requested: 8, qty_sent: null, is_checked: 0 },
    ] },
];

function stub(o) {
  return '<script>\n' +
    'window.__e=[];window.__calls=[];window.__puts=[];\n' +
    'addEventListener("error",function(e){window.__e.push(e.message)},true);\n' +
    'addEventListener("unhandledrejection",function(e){window.__e.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});\n' +
    'var CTX=' + JSON.stringify(CTX) + ',STOCK=' + JSON.stringify(ROWS) + ';\n' +
    'var ORDERS=' + JSON.stringify(ORDERS) + ',FAILDISPATCH=' + JSON.stringify(!!o.failDispatch) + ';\n' +
    'function findItem(id){var r=null;ORDERS.forEach(function(o){(o.items||[]).forEach(function(it){if(it.id===id)r=it})});return r}\n' +
    'window.fetch=function(url,opts){url=String(url);opts=opts||{};window.__calls.push(url.split("?")[0]);\n' +
    '  var body;\n' +
    '  if(url.indexOf("/quick-stock/context")>-1) body={success:true,data:CTX};\n' +
    '  else if(/\\/stock$/.test(url)) body={success:true,data:STOCK};\n' +
    '  else if(/\\/api\\/restock\\/\\d+\\/item\\/\\d+$/.test(url)){\n' +
    '    var m=url.match(/item\\/(\\d+)$/),b=JSON.parse(opts.body||"{}");\n' +
    '    window.__puts.push({item:Number(m[1]),qty_sent:b.qty_sent,is_checked:b.is_checked});\n' +
    '    var it=findItem(Number(m[1]));if(it){it.qty_sent=b.qty_sent;it.is_checked=b.is_checked?1:0}\n' +
    '    body={success:true};\n' +
    '  }\n' +
    '  else if(/\\/api\\/restock\\/\\d+\\/status$/.test(url)){\n' +
    '    var mo=url.match(/restock\\/(\\d+)\\/status$/),sb=JSON.parse(opts.body||"{}");\n' +
    '    window.__puts.push({order:Number(mo[1]),status:sb.status});\n' +
    '    ORDERS.forEach(function(o){if(o.id===Number(mo[1])){o.status=sb.status;o.goods_state="in_transit"}});\n' +
    '    body=FAILDISPATCH?{success:true,stock_transfer:{ok:false,error:"Could not work out which location the goods leave from."}}:{success:true};\n' +
    '  }\n' +
    '  else if(/\\/api\\/restock\\/\\d+$/.test(url)){\n' +
    '    var mi=url.match(/restock\\/(\\d+)$/);\n' +
    '    body={success:true,data:ORDERS.filter(function(o){return o.id===Number(mi[1])})[0]};\n' +
    '  }\n' +
    '  else if(url.indexOf("/api/restock")===0) body={success:true,data:ORDERS};\n' +
    '  else body={success:true,data:{}};\n' +
    '  return Promise.resolve({status:200,json:function(){return Promise.resolve(body)}});};\n' +
    '</scr' + 'ipt>';
}

const HELPERS =
  'window.__click=function(sel,cb){var t=setInterval(function(){var b=document.querySelector(sel);' +
  'if(!b)return;clearInterval(t);b.click();setTimeout(cb||function(){},80)},40)};' +
  'window.__seq=function(list,done){(function n(i){if(i>=list.length)return done&&done();' +
  'var s=list[i];if(typeof s==="number")return setTimeout(function(){n(i+1)},s);' +
  'window.__click(s,function(){n(i+1)})})(0)};' +
  'window.__done=function(){setTimeout(function(){window.__ready=1},320)};';

const OPEN = "'[data-pkopen]'";
const key = (d) => "'#pkGrid [data-k=\"" + d + "\"]'";
const digits = (s) => s.split('').map(key).join(',');
const seq = (items) => 'window.__seq([' + items + '],window.__done);';
// Open the short sheet on chilli oil, enter what was found, move to allocation.
const SHORT = "'[data-pkshort=\"p8\"]'";
const NEXT = "'#pkAssignLbl'";
const field = (id) => "'[data-pkf=\"" + id + "\"]'";

const CASES = {
  'entry': { js: 'window.__done();',
    expect: ['A run is waiting to be picked', '2 of 2 lines still to pull', '2 stores'] },

  // Combined, one row per product, with the per-store split under the name.
  'list': { js: seq([OPEN]),
    expect: ['Pick list', 'Combined from 2 store requests', 'Frozen dumplings 500g',
             'Tianhe 40 · Yuexiu 25', 'Chilli oil 250ml', 'Tianhe 10 · Yuexiu 8',
             'Short', '0 of 2', 'lines picked', 'Dispatch'] },

  // The store chips filter the walk without reordering it.
  'filter': { js: seq([OPEN, "'[data-pkstore=\"Yuexiu\"]'"]),
    expect: ['Frozen dumplings 500g', 'Tianhe 40 · Yuexiu 25'] },

  // Picked in full: one PUT per contributing request, qty_sent = what was asked.
  'tick-picks-in-full': { js: seq([OPEN, "'[data-pkfull=\"p7\"]'", '300']),
    expect: ['1 of 2', 'lines picked'],
    puts: [{ item: 711, qty_sent: 40, is_checked: 1 }, { item: 721, qty_sent: 25, is_checked: 1 }] },

  // THE ONE THAT MATTERS. The sheet opens with no figure, and once he says what
  // he found, every store field is still blank — never zero, never a share.
  'nothing-is-pre-filled': { js: seq([OPEN, SHORT]),
    expect: ['Chilli oil 250ml', 'asked for 18', 'How many did you find?'],
    check: (out) => /data-found="blank"/.test(out) ? null : 'the found figure opened carrying a number',
    checkSave: 'disabled' },

  'allocation-opens-blank': { js: seq([OPEN, SHORT, digits('14'), NEXT]),
    expect: ['Assign the 14 across the stores', 'asked 10', 'asked 8', '14', 'still to assign'],
    check: (out) => /data-fields="\|"/.test(out) ? null : 'a store field opened carrying a number',
    checkSave: 'disabled' },

  // The remainder counts down and is the whole explanation for the dead button.
  'remainder-counts-down': { js: seq([OPEN, SHORT, digits('14'), NEXT, digits('8')]),
    expect: ['6', 'still to assign'], checkSave: 'disabled',
    absent: ['error', 'Error', 'must', 'cannot'] },

  'over-assigned-says-take-back': {
    js: seq([OPEN, SHORT, digits('14'), NEXT, digits('9'), field(722), digits('9')]),
    expect: ['−4', 'over — take 4 back'], checkSave: 'disabled' },

  'all-assigned-frees-the-save': {
    js: seq([OPEN, SHORT, digits('14'), NEXT, digits('8'), field(722), digits('6')]),
    expect: ['All 14 assigned'], checkSave: 'live' },

  // Saved: his split, and the row goes quiet except for the shortfall.
  'short-saves-his-split': {
    js: seq([OPEN, SHORT, digits('14'), NEXT, digits('8'), field(722), digits('6'), "'#pkSave'", '320']),
    expect: ['4 short', 'Tianhe 8 · Yuexiu 6', '1 of 2'],
    puts: [{ item: 712, qty_sent: 8, is_checked: 1 }, { item: 722, qty_sent: 6, is_checked: 1 }] },

  'short-cn': { pre: "localStorage.setItem('roots-admin-lang','cn');",
    js: seq([OPEN, SHORT, digits('14'), NEXT]),
    expect: ['短少 4', '将这 14 件分配到门店'], absent: ['缺少', '不足 4'] },

  // Ready to dispatch: per store, because that is how the van is stacked.
  'dispatch-screen': {
    js: seq([OPEN, "'[data-pkfull=\"p7\"]'", '250', SHORT, digits('14'), NEXT, digits('8'),
             field(722), digits('6'), "'#pkSave'", '320', "'[data-pkreview]'", '250']),
    expect: ['Ready to dispatch', 'Tianhe', 'Yuexiu', '48', '31', 'units',
             'Stock leaves the warehouse the moment you dispatch',
             '1 line is going out short', 'Chilli oil 250ml −4',
             'Each store sees the shortfall when it receives',
             'Press and hold to confirm', 'Hold to dispatch · 79 units'],
    wait: 6000 },

  // The hold moves both requests to prepared, which is what fires _applyDispatch.
  'hold-dispatches-every-request': {
    js: seq([OPEN, "'[data-pkfull=\"p7\"]'", '250', "'[data-pkfull=\"p8\"]'", '250',
             "'[data-pkreview]'", '250', "'[data-pkhold]'", '400']),
    expect: ['On the way', 'The van has what it needs'],
    checkPuts: (puts) => {
      const st = puts.filter((p) => p.status);
      if (st.length !== 2) return `${st.length} status writes, expected one per request`;
      if (!st.every((p) => p.status === 'prepared')) return 'a status write was not "prepared"';
      return null;
    },
    wait: 8000 },

  // A failure is stated. Nothing offers to run it again — that door is #244's.
  'failed-dispatch-is-shown-not-retried': { failDispatch: true,
    js: seq([OPEN, "'[data-pkfull=\"p7\"]'", '250', "'[data-pkfull=\"p8\"]'", '250',
             "'[data-pkreview]'", '250', "'[data-pkhold]'", '400']),
    expect: ['Dispatch did not complete', 'These did not go out', 'No stock moved for them'],
    absent: ['Try again', 'Retry', 'Dispatch again'],
    wait: 8000 },

  'empty': { js: 'window.__done();', emptyRun: true, absent: ['A run is waiting to be picked'] },
};

function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found. Set CHROME_BIN to run the render pass.'); process.exit(0); }
  const base = src.replace(/<link rel="stylesheet" media="print"[\s\S]*?>\n/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-picking-'));
  const failures = [];

  for (const [name, c] of Object.entries(CASES)) {
    const probe = '<script>addEventListener("load",function(){' +
      'var _h="";try{Object.defineProperty(window.location,"href",{set:function(v){_h=v},get:function(){return "file://x"}})}catch(e){}' +
      HELPERS +
      'setTimeout(function(){try{' + (c.js || '') + '}catch(e){window.__e.push("case: "+e.message)}' +
      'var t0=Date.now();var iv=setInterval(function(){' +
      '  if(!window.__ready && Date.now()-t0 < ' + (c.wait || 3000) + ') return;' +
      '  clearInterval(iv);stamp();},40);},120);' +
      'function stamp(){var n=document.querySelectorAll("#app *").length;' +
      'var seen=(document.getElementById("app").innerText||"").replace(/\\s+/g," ");' +
      'var sheets=[].slice.call(document.querySelectorAll(".sheet.show"));' +
      'seen+=" "+sheets.map(function(s){return s.innerText.replace(/\\s+/g," ")}).join(" ");' +
      'document.body.setAttribute("data-seen",seen);' +
      'document.body.setAttribute("data-href",_h);' +
      // The found figure and every allocation field, read straight off the DOM:
      // innerText cannot tell an empty field from one showing nothing useful.
      'var f=document.getElementById("pkFound");' +
      'document.body.setAttribute("data-found",f?(/\\d/.test(f.textContent)?"number":"blank"):"none");' +
      'var fs=[].slice.call(document.querySelectorAll("[data-pkf]"));' +
      'document.body.setAttribute("data-fields",fs.map(function(x){return x.textContent.trim()}).join("|"));' +
      'var sv=document.getElementById("pkSave");' +
      'document.body.setAttribute("data-pksave",sv&&sv.disabled?"disabled":"live");' +
      'document.body.setAttribute("data-puts",JSON.stringify(window.__puts||[]));' +
      'document.body.setAttribute("data-calls",JSON.stringify(window.__calls||[]));' +
      'document.title=(window.__e.length?"ERR "+window.__e.join(" | "):"OK "+n);}' +
      '});</scr' + 'ipt>';
    const pre = c.pre ? '<script>' + c.pre + '</scr' + 'ipt>' : '';
    let s = stub(c);
    if (c.emptyRun) s = s.replace(/var ORDERS=\[[\s\S]*?\],FAILDISPATCH/, 'var ORDERS=[],FAILDISPATCH');
    const html = base.replace('</head>', pre + s + probe + '</head>');
    const file = path.join(dir, name + '.html');
    fs.writeFileSync(file, html);
    let out;
    try {
      out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=402,874', '--virtual-time-budget=25000', '--dump-dom', 'file://' + file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90000 });
    } catch (e) { failures.push([name, 'chrome failed: ' + e.message]); continue; }

    const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    if (!title.startsWith('OK')) { failures.push([name, title]); continue; }
    const dec = (s2) => String(s2).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const seen = dec((out.match(/data-seen="([^"]*)"/) || [])[1] || '');
    const puts = JSON.parse(dec((out.match(/data-puts="([^"]*)"/) || [])[1] || '[]'));
    const calls = JSON.parse(dec((out.match(/data-calls="([^"]*)"/) || [])[1] || '[]'));

    for (const want of (c.expect || [])) if (!seen.includes(want)) failures.push([name, `missing “${want}”`]);
    for (const no of (c.absent || [])) if (seen.includes(no)) failures.push([name, `should not say “${no}”`]);
    if (c.check) { const p = c.check(out); if (p) failures.push([name, p]); }
    if (c.checkSave) {
      const sv = (out.match(/data-pksave="([a-z]+)"/) || [])[1];
      if (sv !== c.checkSave) failures.push([name, `save is “${sv}”, expected “${c.checkSave}”`]);
    }
    if (c.puts) {
      const got = puts.filter((p) => p.item);
      if (JSON.stringify(got) !== JSON.stringify(c.puts)) {
        failures.push([name, `wrote ${JSON.stringify(got)}, expected ${JSON.stringify(c.puts)}`]);
      }
    }
    if (c.checkPuts) { const p = c.checkPuts(puts); if (p) failures.push([name, p]); }

    // Only what #242 already ships. A fourth shape is a new backend path.
    const OK = [/^\/api\/retail-admin\/quick-stock\/context$/, /^\/api\/retail-admin\/stores\/\d+\/stock$/,
      /^\/api\/restock$/, /^\/api\/restock\/\d+$/, /^\/api\/restock\/\d+\/item\/\d+$/,
      /^\/api\/restock\/\d+\/status$/, /^\/api\/restock\/\d+\/receive$/];
    for (const u of calls) {
      if (!OK.some((re) => re.test(u))) failures.push([name, `called ${u} — not one of #242's endpoints`]);
    }
  }

  if (failures.length) {
    for (const [n, m] of failures) console.log(`FAIL ${n} — ${m}`);
    console.log(`\n${failures.length} failure(s).`);
    process.exit(1);
  }
  console.log(`ok — ${Object.keys(CASES).length} picking states rendered, no uncaught errors; every call is #242's.`);
}

main();
