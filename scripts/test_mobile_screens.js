#!/usr/bin/env node
/**
 * Every screen in public/m.html, rendered headless, asserted to paint without an
 * uncaught error.
 *
 * Why this exists: the phone app is one file that renders by rebuilding its own
 * innerHTML. When a render throws, the previous screen simply stays on the
 * glass — the tap looks ignored, and a screenshot of the "new" screen shows the
 * old one. That is exactly how a missing helper shipped: every page looked fine
 * because every page WAS fine, and the broken one was never the one being
 * looked at. So the check is not "does it look right", it is "did anything
 * throw", across every tab, every pushed screen, every sheet, both languages
 * and both themes.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..', 'public', 'm.html');

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    // eslint-disable-next-line global-require
    return require('playwright').chromium.executablePath();
  } catch (e) { /* playwright not installed here */ }
  const guesses = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
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

// Enough server-shaped state that screens which read live data render their real
// branch rather than their loading one. Deliberately minimal: a screen that
// needs more than this to paint is a screen that will break on a slow network.
const SEED = `
  state.cfg={faq:{questions:[{q_en:'Q',q_cn:'问',a_en:'A',a_cn:'答'}]},
    legal:{terms:{body_en:'T',updated_at:'2026-05-01'},privacy:{body_en:'P',updated_at:'2026-05-01'}},
    popups:{list:[{title_en:'Hi',body_en:'B',enabled:true,start_at:'2026-08-18'}]},
    about:{content:{kicker_en:'K',manifesto_en:'M',founder_name_en:'A',founder_title_en:'F',founder_quote_en:'Q'}}};
  state.setup={percent:71,requiredDone:5,requiredTotal:7,steps:[{key:'store',done:true},{key:'wechat',done:false}]};
  state.zones=[1,2,3]; state.printer={auto_print:true};
  state.stores=[{id:1,name_en:'Tianhe store',name_cn:'天河店'},{id:2,name_en:'Panyu store',name_cn:'番禺店'}];
`;

function buildCases(src) {
  const subs = [...src.matchAll(/\n {2}([a-z_0-9]+):\{title:/g)].map((m) => m[1]);
  const cases = {};
  for (const t of ['home', 'orders', 'customers', 'products', 'more']) cases['tab:' + t] = `APP.cmd('tab','${t}')`;
  for (const k of subs) cases['push:' + k] = `APP.cmd('push','${k}')`;
  Object.assign(cases, {
    'sheet:order': "DB.orders[0]._id=1;DB.orders[0].raw='paid';state.liveOrders=DB.orders;APP.cmd('tab','orders');APP.cmd('openOrder',DB.orders[0].id)",
    'sheet:order-actions': "DB.orders[0]._id=1;DB.orders[0].raw='dispatched';state.liveOrders=DB.orders;APP.cmd('openOrder',DB.orders[0].id);APP.cmd('detailActions')",
    'sheet:customer': "state.customers=DB.customers.slice();state.custLoaded=true;APP.cmd('tab','customers');state.custId='s1';state.custDetail={customer:{nickname:'A',tier_key:'tree'},stats:{orders:{}}};render()",
    'sheet:product': "state.prodStores=[{id:1,name_en:'T',name_cn:'T',qty:2}];state.prodStockReady=true;DB.products[1]._id=42;APP.cmd('tab','products');state.productSku=DB.products[1].sku;render()",
    'sheet:reply': "DB.reviews[0].id=7;DB.reviews[0].stream='review';APP.cmd('push','inbox');APP.cmd('openReply',DB.reviews[0].cust[0])",
    'sheet:search': "APP.cmd('openSearch')",
    'sheet:account': "APP.cmd('overflow')",
    'sheet:create': "APP.cmd('create','coupon')",
    'sheet:cust-points': "state.customers=DB.customers.slice();state.custLoaded=true;APP.cmd('tab','customers');state.custId=1;state.custDetail={customer:{nickname:'A',tier_key:'tree',points_balance:120,balance:8},stats:{orders:{}}};render();APP.cmd('adjustPoints')",
    'sheet:cust-block': "state.customers=DB.customers.slice();state.custLoaded=true;APP.cmd('tab','customers');state.custId=1;state.custDetail={customer:{nickname:'A',tier_key:'tree',is_blocked:1},stats:{orders:{}}};render();APP.cmd('toggleBlock')",
    'sheet:mark-paid': "DB.orders[0]._id=1;DB.orders[0].raw='pending_payment';state.liveOrders=DB.orders;APP.cmd('tab','orders');APP.cmd('openOrder',DB.orders[0].id);APP.cmd('markPaid')",
    'sheet:refund-review': "DB.orders[0]._id=1;DB.orders[0].raw='paid';DB.orders[0].refundStatus='pending';state.liveOrders=DB.orders;APP.cmd('openOrder',DB.orders[0].id);APP.cmd('detailActions')",
    'sheet:refund-approve': "DB.orders[0]._id=1;DB.orders[0].raw='paid';DB.orders[0].refundStatus='pending';state.liveOrders=DB.orders;APP.cmd('openOrder',DB.orders[0].id);APP.cmd('approveRefund')",
    'sheet:refund-payout': "DB.orders[0]._id=1;DB.orders[0].raw='paid';DB.orders[0].refundStatus='approved';state.liveOrders=DB.orders;APP.cmd('openOrder',DB.orders[0].id);APP.cmd('payRefund')",
    'theme:dark': "APP.cmd('toggleTheme');APP.cmd('tab','orders')",
    'lang:zh': "APP.cmd('toggleLang');APP.cmd('tab','more')",
  });
  return cases;
}

const PROBE = `<script>window.__e=[];addEventListener('error',function(e){window.__e.push(e.message)},true);
addEventListener('load',function(){setTimeout(function(){
  var n=document.querySelectorAll('#app *').length;
  document.title = window.__e.length ? ('ERR '+window.__e.join(' | ')) : ('OK '+n);
},400)});</script>`;

function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('SKIP — no Chromium found. Set CHROME_BIN to run this check.');
    process.exit(0);
  }
  let src = fs.readFileSync(APP, 'utf8');
  // No network in a test runner: the CDN icon set and the font stylesheet would
  // each hold the page open until they time out.
  src = src.replace(/<script src="https:\/\/unpkg\.com[^>]*><\/script>/, '')
           .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm-screens-'));
  const cases = buildCases(src);
  const failures = [];

  // Two passes. WARM seeds server-shaped state so each screen renders its real
  // branch. COLD seeds nothing — the first paint, and the offline one, where a
  // screen must show a loading or empty state rather than reaching into data
  // that has not arrived. Half the crashes in this app's history live there.
  const passes = [['warm', SEED], ['cold', '']];
  const work = [];
  for (const [name, js] of Object.entries(cases)) {
    for (const [pass, seed] of passes) work.push([`${name} [${pass}]`, seed, js]);
  }

  for (const [name, seed, js] of work) {
    const html = src.replace('</body>',
      `<script>addEventListener("load",function(){try{${seed}${js}}catch(e){window.__e.push("cmd: "+e.message)}});</script>${PROBE}</body>`);
    const file = path.join(dir, name.replace(/[^a-z0-9]/gi, '_') + '.html');
    fs.writeFileSync(file, html);
    let out = '';
    try {
      out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=500,940', '--virtual-time-budget=2500', '--dump-dom', 'file://' + file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    } catch (e) { failures.push([name, 'chrome failed: ' + e.message]); continue; }
    const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    const nodes = Number((title.match(/^OK (\d+)/) || [])[1] || 0);
    if (!title.startsWith('OK')) failures.push([name, title]);
    // A screen that paints almost nothing is a screen that failed quietly.
    else if (nodes < 12) failures.push([name, `painted only ${nodes} nodes`]);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  const total = work.length;
  if (failures.length) {
    for (const [name, why] of failures) console.error(`FAIL ${name} — ${why}`);
    console.error(`\n${failures.length} of ${total} screens failed.`);
    process.exit(1);
  }
  console.log(`ok — ${total} renders (${Object.keys(cases).length} screens, warm and cold), no uncaught errors.`);
}

main();
