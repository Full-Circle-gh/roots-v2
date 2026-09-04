#!/usr/bin/env node
/**
 * Receiving — the store's half of a two-step transfer, rendered headless.
 *
 *   node scripts/test_stock_receiving.js
 *
 * The screens are drawn in design-handoff/store-receiving/ and ruled in §39 of
 * docs/tacet-consolidation-decisions.md. What is checked here is the handful of
 * things that decide whether the record and the shelf stay together, each of
 * which fails silently if it goes wrong:
 *
 *   • THE KEYPAD OPENS EMPTY. A figure already in the box is a figure nobody
 *     counted, and it would be the warehouse's figure — the exact thing §39
 *     says the record must never prefer to the counter's. This is the assertion
 *     the whole flow rests on, so it is checked on the value AND on the save
 *     button, which cannot commit a count that was never typed.
 *   • SHORT AND OVER READ THE SAME. Identical treatment, both directions,
 *     because finding two extra is no more an error than finding four fewer.
 *     In Chinese, short is 短少 and nothing else (§39, delivery vocabulary).
 *   • SETTLEMENT IS THE CONFIRM, NOT THE LAST COUNT. The server settles inside
 *     PUT /:id/receive the moment every line carries a figure, so the count
 *     that completes the set is held back and sent by Confirm. If that ever
 *     stops holding, stock moves before the operator sees the screen that says
 *     it is about to.
 *   • THE ENDPOINTS ARE #242's, AND ONLY #242's. Every call the screen makes is
 *     recorded and compared against the three that already exist. A fourth URL
 *     means a second settlement path was invented.
 *   • A BACKEND-REALM SESSION IS TURNED AWAY QUIETLY. /stock serves two realms
 *     and /api/restock only answers one of them; a 403 must disable receiving,
 *     not bounce a Quick Stock operator to a login page.
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
  const guesses = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'];
  for (const g of guesses) { if (fs.existsSync(g)) return g; }
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

// One transfer, four lines, and every gap the flow has to render:
//   • dumplings — arrives exactly as sent, and exactly as asked
//   • chilli oil — the warehouse cut it before loading (asked 18, sent 14) AND
//     the road lost four more. The line that proves the two yardsticks are
//     different questions.
//   • sesame paste — over. Same treatment as short.
//   • bao — arrives exactly as sent and is still short of the order. The line
//     that is invisible to "what differed from the van" and is the reason the
//     last screen compares against what was asked for instead.
const ITEMS = [
  { id: 11, product_id: 7, product_name: 'Frozen dumplings 500g', product_cn: '冷冻水饺 500g', sku: 'FD-500', qty_requested: 40, qty_sent: 40, qty_received: null },
  { id: 12, product_id: 8, product_name: 'Chilli oil 250ml',      product_cn: '辣椒油 250ml',   sku: 'CO-250', qty_requested: 18, qty_sent: 14, qty_received: null },
  { id: 13, product_id: 9, product_name: 'Sesame paste 400g',     product_cn: '芝麻酱 400g',    sku: 'SP-400', qty_requested: 30, qty_sent: 30, qty_received: null },
  { id: 14, product_id: 10, product_name: 'Frozen bao 12pk',      product_cn: '冷冻包子 12个装', sku: 'FB-012', qty_requested: 20, qty_sent: 16, qty_received: null },
];
const ORDER = {
  id: 91, rs_number: 'RS-260902-004', status: 'delivered', store_name: 'Tianhe',
  goods_state: 'in_transit', dispatched_at: '2026-09-02 05:04:00',
  delivered_at: '2026-09-02 06:40:00', received_confirmed_at: null, item_count: 4,
};
const ROWS = [{ product_id: 7, name_en: 'Hummus Asli', name_cn: '鹰嘴豆泥', sku: '1-10', physical_qty: 11, restock_target: 5 }];

/* The stub answers Quick Stock's two endpoints and the three restock endpoints,
   RECORDS every call, and can refuse the restock ones with a 403 — the shape a
   Mini App Backend operator's session actually gets. Counts written by the page
   are kept, so a reload inside one case resumes exactly as the server would. */
function stub(o) {
  const order = Object.assign({}, ORDER, o.orderPatch || {});
  return '<script>\n' +
    'window.__e=[];window.__calls=[];window.__puts=[];\n' +
    'addEventListener("error",function(e){window.__e.push(e.message)},true);\n' +
    'addEventListener("unhandledrejection",function(e){window.__e.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});\n' +
    'var CTX=' + JSON.stringify(CTX) + ',STOCK=' + JSON.stringify(ROWS) + ';\n' +
    'var ORDER=' + JSON.stringify(order) + ',ITEMS=' + JSON.stringify(ITEMS) + ';\n' +
    'var DENY=' + JSON.stringify(!!o.deny) + ';\n' +
    'window.fetch=function(url,opts){url=String(url);opts=opts||{};window.__calls.push(url.split("?")[0]);\n' +
    '  var body,status=200;\n' +
    '  if(url.indexOf("/quick-stock/context")>-1) body={success:true,data:CTX};\n' +
    '  else if(/\\/stock$/.test(url)) body={success:true,data:STOCK};\n' +
    '  else if(url.indexOf("/api/restock")===0){\n' +
    '    if(DENY) return Promise.resolve({status:403,json:function(){return Promise.resolve({error:"forbidden"})}});\n' +
    '    if(/\\/receive$/.test(url)){\n' +
    '      var sent=JSON.parse(opts.body||"{}");window.__puts.push(sent);\n' +
    '      (sent.counts||[]).forEach(function(c){ITEMS.forEach(function(it){if(it.id===c.item_id)it.qty_received=c.qty_received})});\n' +
    '      var left=ITEMS.filter(function(it){return it.qty_received==null}).length;\n' +
    '      if(left){body={success:true,settled:false,counts_written:(sent.counts||[]).length,counted:ITEMS.length-left,total:ITEMS.length};}\n' +
    '      else {ORDER.goods_state="settled";ORDER.received_confirmed_at="2026-09-02 06:52:00";\n' +
    '            body={success:true,settled:true,counts_written:(sent.counts||[]).length,moved:ITEMS.length};}\n' +
    '    }\n' +
    '    else if(/\\/api\\/restock\\/\\d+$/.test(url)) body={success:true,data:Object.assign({},ORDER,{items:ITEMS})};\n' +
    '    else body={success:true,data:ORDER.goods_state==="in_transit"?[ORDER]:[]};\n' +
    '  }\n' +
    '  else body={success:true,data:{}};\n' +
    '  return Promise.resolve({status:status,json:function(){return Promise.resolve(body)}});};\n' +
    '</scr' + 'ipt>';
}

// Click helpers. The page paints from network callbacks, so nothing is on
// screen at a fixed moment and every step polls for its own target. __seq walks
// a list of selectors (a number is a pause) and calls back when it is done.
const HELPERS =
  'window.__click=function(sel,cb){var t=setInterval(function(){var b=document.querySelector(sel);' +
  'if(!b)return;clearInterval(t);b.click();setTimeout(cb||function(){},80)},40)};' +
  'window.__seq=function(list,done){(function n(i){if(i>=list.length)return done&&done();' +
  'var s=list[i];if(typeof s==="number")return setTimeout(function(){n(i+1)},s);' +
  'window.__click(s,function(){n(i+1)})})(0)};' +
  'window.__done=function(){setTimeout(function(){window.__ready=1},320)};';

// The app now opens on the Stock home for anyone the restock API answers, so
// every case enters through the launcher's Receive tile — which is the real
// route a shop takes, and was the point of adding it.
const OPEN = "'[data-rcenter]'";
const key = (d) => "'#rcGrid [data-k=\"" + d + "\"]'";
const line = (id) => "'[data-count=\"" + id + "\"]'";
const digits = (s) => s.split('').map(key).join(',');
// Count one line and save it.
const countLine = (id, ds) => [line(id), digits(ds), "'#rcSave'", '300'].join(',');
const seq = (items) => 'window.__seq([' + items + '],window.__done);';

const CASES = {
  // THE WAY IN, AND IT IS VISIBLE BEFORE THE WORK IS. The launcher names the job
  // whether or not anything is due; the count beside it is what is due now.
  'entry': { js: 'window.__done();',
    expect: ['Receive', 'Count a delivery in', '1 delivery waiting'] },

  // And with nothing inbound the tile stays — greyed by its own words, not
  // removed. A door you can only see when you are already through it is not a
  // door, which is the whole reason this screen exists.
  'entry-when-idle': { orderPatch: { goods_state: 'settled' }, js: 'window.__done();',
    expect: ['Receive', 'Nothing on its way'], absent: ['delivery waiting'] },

  // Not arrived yet. One Dusk card and a read-only manifest — nothing countable
  // on the screen itself, and no confirm, because nothing has been counted.
  'transit': { orderPatch: { delivered_at: null }, js: seq([OPEN]),
    expect: ['On the way', 'In transit', 'What is coming', 'The van is still on the road'],
    absent: ['Confirm receipt'],
    check: (out) => /data-countable="0"/.test(out) ? null : 'the transit screen listed countable rows' },

  // AND IT IS NOT A LOCK. delivered_at is stamped by nothing in either canvas
  // and by no step in this flow, and the server never asked for it —
  // _applyReceipt gates on goods_state alone. A shop standing over a box it can
  // see must be able to count it, so the way through works with the stamp
  // absent. If this ever goes red, receiving has a dead end again.
  'transit-is-not-a-lock': { orderPatch: { delivered_at: null },
    js: seq([OPEN, "'[data-rccount]'", '250']),
    expect: ['From the warehouse · 4 lines', 'Count', '0 of 4', 'lines counted'],
    check: (out) => /data-countable="4"/.test(out) ? null : 'no way through from the transit screen' },

  // Arrived. The number on an uncounted row is what the warehouse SENT.
  'list': { js: seq([OPEN]),
    expect: ['Receiving', 'From the warehouse · 4 lines', 'Count', '0 of 4', 'lines counted', 'Confirm receipt'] },

  // THE ONE THAT MATTERS. The keypad shows no figure until she types one, and
  // the save cannot commit what was never typed.
  'keypad-opens-empty': { js: seq([OPEN, line(13)]),
    expect: ['Sesame paste 400g', 'How many arrived?', 'Count what is in the box'],
    absent: ['Save 30 and continue'],
    check: (out) => /data-rcval="—"/.test(out) ? null : 'the keypad opened carrying a figure',
    checkSave: 'disabled' },

  'keypad-short': { js: seq([OPEN, line(13), digits('26')]),
    expect: ['4 short', 'Recorded as it is', 'Save 26 and continue'] },
  'keypad-over': { js: seq([OPEN, line(13), digits('32')]),
    expect: ['2 over', 'Save 32 and continue'] },
  'keypad-short-cn': { pre: "localStorage.setItem('roots-admin-lang','cn');",
    js: seq([OPEN, line(13), digits('26')]),
    expect: ['短少 4', '如实记录'], absent: ['缺少', '不足 4'] },

  // One tap that says "exactly what was sent" — a choice she makes, which is
  // the only thing separating it from a pre-fill.
  'all-arrived': { js: seq([OPEN, line(13), "'#rcAll'"]),
    expect: ['All 30 arrived', 'Save 30 and continue'], absent: [' short', ' over'] },

  // The tick on the row says the same thing without opening the keypad.
  'tick-is-as-sent': { js: seq([OPEN, "'[data-assent=\"11\"]'", '300']),
    expect: ['as sent', '1 of 4'],
    puts: [[{ item_id: 11, qty_received: 40 }]] },

  // A non-final count goes to the server on its own, and the row settles.
  'saves-one-line': { js: seq([OPEN, countLine(13, '26')]),
    expect: ['4 short', '30 sent', '1 of 4'],
    puts: [[{ item_id: 13, qty_received: 26 }]] },

  // The count that completes the set is HELD. Three saves, never the fourth.
  'last-count-is-held': {
    js: seq([OPEN, countLine(11, '40'), countLine(12, '10'), countLine(14, '16'), countLine(13, '32')]),
    expect: ['Confirm receipt', 'units counted', 'Against what the van carried',
             'join this store’s stock when you confirm'],
    putCount: 3, wait: 9000 },

  // Confirm sends every count and settles, and the last screen compares against
  // the ORDER — the only place the bao line's shortfall is visible.
  'confirm-settles': {
    js: seq([OPEN, countLine(11, '40'), countLine(12, '10'), countLine(14, '16'), countLine(13, '32'),
             "'[data-rcconfirm]'", '400']),
    expect: ['Received', 'units added to this store', 'Against what you asked for',
             'asked 18 · sent 14 · counted 10', 'asked 20 · sent 16 · counted 16'],
    putCount: 4, wait: 12000 },

  // A realm that cannot reach these endpoints gets no entry and no redirect.
  'other-realm-is-silent': { deny: true, js: 'window.__done();',
    expect: ['Quick stock', 'Hummus Asli'],
    absent: ['A delivery is waiting to be counted', 'A delivery is on the way'],
    check: (out) => /data-href="[^"]*stock-login/.test(out) ? 'a 403 bounced the operator to the login page' : null },
};

function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found. Set CHROME_BIN to run the render pass.'); process.exit(0); }
  const base = src.replace(/<link rel="stylesheet" media="print"[\s\S]*?>\n/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-receiving-'));
  const failures = [];

  for (const [name, c] of Object.entries(CASES)) {
    const probe = '<script>addEventListener("load",function(){' +
      // A navigation would take the page away mid-run and lose every assertion.
      'var _h="";try{Object.defineProperty(window.location,"href",{set:function(v){_h=v},get:function(){return "file://x"}})}catch(e){}' +
      HELPERS + 'setTimeout(function(){try{' + (c.js || '') + '}catch(e){window.__e.push("case: "+e.message)}' +
      'var t0=Date.now();var iv=setInterval(function(){' +
      '  if(!window.__ready && Date.now()-t0 < ' + (c.wait || 3000) + ') return;' +
      '  clearInterval(iv);stamp();},40);},120);' +
      'function stamp(){var n=document.querySelectorAll("#app *").length;' +
      'var seen=(document.getElementById("app").innerText||"").replace(/\\s+/g," ");' +
      'var sheets=[].slice.call(document.querySelectorAll(".sheet.show"));' +
      'seen+=" "+sheets.map(function(s){return s.innerText.replace(/\\s+/g," ")}).join(" ");' +
      'document.body.setAttribute("data-seen",seen);' +
      'document.body.setAttribute("data-href",_h);' +
      'var v=document.getElementById("rcVal");' +
      'document.body.setAttribute("data-rcval",v?v.textContent:"");' +
      'document.body.setAttribute("data-countable",String(document.querySelectorAll("[data-count]").length));' +
      'var sv=document.getElementById("rcSave");' +
      'document.body.setAttribute("data-rcsave",sv&&sv.disabled?"disabled":"live");' +
      'document.body.setAttribute("data-puts",JSON.stringify(window.__puts||[]));' +
      'document.body.setAttribute("data-calls",JSON.stringify(window.__calls||[]));' +
      'document.title=(window.__e.length?"ERR "+window.__e.join(" | "):"OK "+n);}' +
      '});</scr' + 'ipt>';
    const pre = c.pre ? '<script>' + c.pre + '</scr' + 'ipt>' : '';
    const html = base.replace('</head>', pre + stub(c) + probe + '</head>');
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
    const dec = (s) => String(s).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const seen = dec((out.match(/data-seen="([^"]*)"/) || [])[1] || '');
    const puts = JSON.parse(dec((out.match(/data-puts="([^"]*)"/) || [])[1] || '[]'));
    const calls = JSON.parse(dec((out.match(/data-calls="([^"]*)"/) || [])[1] || '[]'));

    for (const want of (c.expect || [])) {
      if (!seen.includes(want)) failures.push([name, `missing “${want}”`]);
    }
    for (const no of (c.absent || [])) {
      if (seen.includes(no)) failures.push([name, `should not say “${no}”`]);
    }
    if (c.check) { const p = c.check(out); if (p) failures.push([name, p]); }
    if (c.checkSave) {
      const sv = (out.match(/data-rcsave="([a-z]+)"/) || [])[1];
      if (sv !== c.checkSave) failures.push([name, `save is “${sv}”, expected “${c.checkSave}”`]);
    }
    if (c.putCount != null && puts.length !== c.putCount) {
      failures.push([name, `${puts.length} save(s) to the server, expected ${c.putCount}`]);
    }
    if (c.puts) {
      const got = puts.map((p) => p.counts);
      if (JSON.stringify(got) !== JSON.stringify(c.puts)) {
        failures.push([name, `saved ${JSON.stringify(got)}, expected ${JSON.stringify(c.puts)}`]);
      }
    }
    // No fourth endpoint. A URL outside this set is a second settlement path.
    const OK_CALLS = ['/api/retail-admin/quick-stock/context', '/api/retail-admin/stores/1/stock',
      '/api/restock', '/api/restock/91', '/api/restock/91/receive'];
    for (const u of calls) {
      if (!OK_CALLS.includes(u)) failures.push([name, `called ${u} — not one of #242's endpoints`]);
    }
  }

  if (failures.length) {
    for (const [n, m] of failures) console.log(`FAIL ${n} — ${m}`);
    console.log(`\n${failures.length} failure(s).`);
    process.exit(1);
  }
  console.log(`ok — ${Object.keys(CASES).length} receiving states rendered, no uncaught errors; every call is #242's.`);
}

main();
