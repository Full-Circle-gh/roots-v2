#!/usr/bin/env node
/**
 * The Stock home — the door into counting, picking and receiving.
 *
 *   node scripts/test_stock_home.js
 *
 * Why this exists. Picking and receiving were reachable only by a card that
 * appeared at the top of the counting list WHEN WORK WAS DUE. On a quiet day
 * they did not exist: no menu, no tab, nothing saying the feature was there. So
 * nobody learned they existed, and nobody thought to look on the morning it
 * mattered. Ash found this by opening /stock and seeing only Quick Stock.
 *
 * The two assertions that matter, and they pull in opposite directions:
 *
 *   • THE TILES DO NOT HIDE WHEN EMPTY. "Nothing to pick" is information, and
 *     it is what teaches someone the screen exists before they need it. If a
 *     tile ever disappears on a quiet day the original defect is back.
 *   • THE LAUNCHER DOES NOT APPEAR FOR SOMEONE WITH ONE JOB. /stock is served
 *     to two realms and /api/restock answers only one. A Mini App Backend
 *     operator, and anyone else the API refuses, must land exactly where they
 *     always did — on the counting list, with no extra tap and no tile that
 *     403s. A launcher for a single tool is a tax on the people who use this
 *     app most.
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

// One run waiting to be picked, one delivery in transit — so both tiles can
// carry a live count, and the pair can be switched off independently.
const RUN = {
  id: 71, rs_number: 'RS-260902-004', status: 'sent', from_role: 'store', to_role: 'warehouse',
  goods_state: 'none', store_name: 'Tianhe', item_count: 1,
  items: [{ id: 711, product_id: 7, product_name: 'Frozen dumplings 500g', sku: 'FD-500', qty_requested: 40, qty_sent: null, is_checked: 0 }],
};
const INBOUND = {
  id: 81, rs_number: 'RS-260902-009', status: 'delivered', from_role: 'warehouse', to_role: 'store',
  goods_state: 'in_transit', store_name: 'Tianhe', dispatched_at: '2026-09-02 05:04:00',
  delivered_at: '2026-09-02 06:40:00', item_count: 1,
  items: [{ id: 811, product_id: 7, product_name: 'Frozen dumplings 500g', sku: 'FD-500', qty_requested: 12, qty_sent: 12, qty_received: null }],
};

function stub(o) {
  const orders = [];
  if (!o.noRun) orders.push(RUN);
  if (!o.noInbound) orders.push(INBOUND);
  return '<script>\n' +
    'window.__e=[];window.__calls=[];\n' +
    'addEventListener("error",function(e){window.__e.push(e.message)},true);\n' +
    'addEventListener("unhandledrejection",function(e){window.__e.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});\n' +
    'var CTX=' + JSON.stringify(CTX) + ',STOCK=' + JSON.stringify(ROWS) + ';\n' +
    'var ORDERS=' + JSON.stringify(orders) + ',DENY=' + JSON.stringify(!!o.deny) + ';\n' +
    'window.fetch=function(url,opts){url=String(url);window.__calls.push(url.split("?")[0]);var body;\n' +
    '  if(url.indexOf("/quick-stock/context")>-1) body={success:true,data:CTX};\n' +
    '  else if(/\\/stock$/.test(url)) body={success:true,data:STOCK};\n' +
    '  else if(url.indexOf("/api/restock")===0){\n' +
    '    if(DENY) return Promise.resolve({status:403,json:function(){return Promise.resolve({error:"forbidden"})}});\n' +
    '    var m=url.match(/restock\\/(\\d+)$/);\n' +
    '    if(m) body={success:true,data:ORDERS.filter(function(o){return o.id===Number(m[1])})[0]};\n' +
    '    else body={success:true,data:ORDERS};\n' +
    '  }\n' +
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

const seq = (items) => 'window.__seq([' + items + '],window.__done);';

const CASES = {
  // Three jobs, named, with the two that carry work counting it.
  'home-is-the-landing': { js: 'window.__done();',
    expect: ['Hi Asher', 'Count', 'Set what is on your shelf',
             'Pick', 'Pull a run for the stores', '1 of 1 lines still to pull',
             'Receive', 'Count a delivery in', '1 delivery waiting'],
    check: (out) => /data-view="home"/.test(out) ? null : 'the app did not open on the launcher' },

  // THE ORIGINAL DEFECT, ASSERTED. A quiet day must still show both doors.
  'tiles-stay-when-there-is-no-work': { noRun: true, noInbound: true, js: 'window.__done();',
    expect: ['Pick', 'Nothing to pick', 'Receive', 'Nothing on its way'],
    absent: ['still to pull', 'delivery waiting'] },

  // THE OTHER HALF. One job needs no launcher, and the people who only count
  // are the ones who use this app every day.
  'no-launcher-for-one-job': { deny: true, js: 'window.__done();',
    expect: ['Quick stock', 'Hummus Asli'],
    absent: ['Pull a run for the stores', 'Count a delivery in', 'Hi Asher'],
    check: (out) => {
      if (/data-view="home"/.test(out)) return 'a refused realm was shown the launcher';
      return /data-href="[^"]*stock-login/.test(out) ? 'a 403 bounced the operator to the login page' : null;
    } },

  // Each tile reaches its screen, and comes back.
  'count-tile-opens-the-shelf': { js: seq(["'[data-hcount]'"]),
    expect: ['Quick stock', 'Hummus Asli', 'All', 'Low', 'Out'] },
  'pick-tile-opens-the-run': { js: seq(["'[data-pkopen]'", '250']),
    expect: ['Pick list', 'Frozen dumplings 500g', 'Short', '0 of 1'] },
  'receive-tile-opens-the-count': { js: seq(["'[data-rcenter]'", '250']),
    expect: ['Receiving', 'From the warehouse · 1 lines', 'Count'] },
  'back-returns-to-the-launcher': { js: seq(["'[data-pkopen]'", '250', "'[data-pkback]'", '250']),
    expect: ['Hi Asher', 'Pick', 'Receive'],
    check: (out) => /data-view="home"/.test(out) ? null : 'back did not return to the launcher' },

  'home-cn': { pre: "localStorage.setItem('roots-admin-lang','cn');", js: 'window.__done();',
    expect: ['你好', '盘点', '拣货', '收货', '待拣', '批待收货'] },
};

function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found. Set CHROME_BIN to run the render pass.'); process.exit(0); }
  const base = src.replace(/<link rel="stylesheet" media="print"[\s\S]*?>\n/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-home-'));
  const failures = [];

  for (const [name, c] of Object.entries(CASES)) {
    const probe = '<script>addEventListener("load",function(){' +
      'var _h="";try{Object.defineProperty(window.location,"href",{set:function(v){_h=v},get:function(){return "file://x"}})}catch(e){}' +
      HELPERS +
      'setTimeout(function(){try{' + (c.js || '') + '}catch(e){window.__e.push("case: "+e.message)}' +
      'var t0=Date.now();var iv=setInterval(function(){' +
      '  if(!window.__ready && Date.now()-t0 < 4000) return;' +
      '  clearInterval(iv);stamp();},40);},120);' +
      'function stamp(){var n=document.querySelectorAll("#app *").length;' +
      'var seen=(document.getElementById("app").innerText||"").replace(/\\s+/g," ");' +
      'document.body.setAttribute("data-seen",seen);' +
      'document.body.setAttribute("data-href",_h);' +
      // Which screen is actually on, read from the DOM rather than inferred
      // from words: the launcher and the counting list share a header.
      'document.body.setAttribute("data-view",document.querySelector(".sh-wrap")?"home":"other");' +
      'document.title=(window.__e.length?"ERR "+window.__e.join(" | "):"OK "+n);}' +
      '});</scr' + 'ipt>';
    const pre = c.pre ? '<script>' + c.pre + '</scr' + 'ipt>' : '';
    const html = base.replace('</head>', pre + stub(c) + probe + '</head>');
    const file = path.join(dir, name + '.html');
    fs.writeFileSync(file, html);
    let out;
    try {
      out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=402,874', '--virtual-time-budget=20000', '--dump-dom', 'file://' + file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
    } catch (e) { failures.push([name, 'chrome failed: ' + e.message]); continue; }

    const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    if (!title.startsWith('OK')) { failures.push([name, title]); continue; }
    const dec = (x) => String(x).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const seen = dec((out.match(/data-seen="([^"]*)"/) || [])[1] || '');
    for (const want of (c.expect || [])) if (!seen.includes(want)) failures.push([name, `missing “${want}”`]);
    for (const no of (c.absent || [])) if (seen.includes(no)) failures.push([name, `should not say “${no}”`]);
    if (c.check) { const p = c.check(out); if (p) failures.push([name, p]); }

    const OK = [/^\/api\/retail-admin\/quick-stock\/context$/, /^\/api\/retail-admin\/stores\/\d+\/stock$/,
      /^\/api\/restock$/, /^\/api\/restock\/\d+$/];
    const calls = JSON.parse(dec((out.match(/data-calls="([^"]*)"/) || [])[1] || '[]'));
    for (const u of calls) if (!OK.some((re) => re.test(u))) failures.push([name, `called ${u}`]);
  }

  if (failures.length) {
    for (const [n, m] of failures) console.log(`FAIL ${n} — ${m}`);
    console.log(`\n${failures.length} failure(s).`);
    process.exit(1);
  }
  console.log(`ok — ${Object.keys(CASES).length} launcher states rendered, no uncaught errors.`);
}

main();
