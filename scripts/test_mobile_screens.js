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
    const p = require('playwright').chromium.executablePath();
    // …and only if it is actually THERE. executablePath() reports where this
    // playwright build expects its browser, not where one exists: a box whose
    // /opt/pw-browsers was provisioned for a different revision gets a
    // confident path to nothing, and every screen then failed with ENOENT
    // while the working binary sat two lines below in the fallback list.
    if (p && fs.existsSync(p)) return p;
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
    // The feedback half of the inbox, and the thread sheet in all three of its
    // states — the fetch in flight, the conversation on screen, and the fetch
    // that failed. A thread that renders only when the network is kind is a
    // thread that renders nowhere.
    'push:inbox-feedback': "state.inboxSeg='feedback';APP.cmd('push','inbox')",
    'sheet:thread-loading': "state.inboxSeg='feedback';APP.cmd('push','inbox');APP.cmd('openReply','fb:1')",
    'sheet:thread': "state.inboxSeg='feedback';APP.cmd('push','inbox');APP.cmd('openReply','fb:1');state.thread={id:1,loading:false,err:null,page:'checkout',appVersion:'2.4.1',photos:['/x.png'],msgs:[{id:0,author:'customer',body:'Pickup time is wrong.',created_at:'2026-08-19 10:02:00'},{id:1,author:'admin',author_name:'Mei',body:'Looking at it now.',created_at:'2026-08-19 10:40:00'},{id:2,author:'customer',body:'Still doing it.',created_at:'2026-08-22 09:10:00'}]};render()",
    'sheet:thread-error': "state.inboxSeg='feedback';APP.cmd('push','inbox');APP.cmd('openReply','fb:1');state.thread={id:1,loading:false,err:'Could not load the conversation.',msgs:null};render()",
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

  // ── Static pass: a helper that is called but never defined ──────────────
  // Rendering every screen does NOT catch this. A helper reached only from a
  // live fetch sits inside a try/catch, so a missing one is swallowed and the
  // screen paints its fallback — which is exactly how mapFeedback shipped
  // deleted (an edit sliced a region and took it with it, twice in one day).
  // These names follow the file's own conventions, so the check is a grep, not
  // a parser: every mapX / loadX / screenX / sheetX that is CALLED must exist.
  {
    const raw = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    // Strip comments first: a comment naming a helper is not a call, and this
    // file's comments name plenty of them.
    const js = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const defined = new Set();
    for (const m of js.matchAll(/(?:function|const|let|var)\s+([a-zA-Z_$][\w$]*)/g)) defined.add(m[1]);
    // Match the BARE identifier, not `name(`. The two call sites that shipped
    // this bug were `rows.map(mapFeedback)` — a reference passed to .map(),
    // with no parentheses of its own, which a call-shaped regex walks straight
    // past. That is precisely the shape this check exists to catch.
    const called = new Set();
    for (const m of js.matchAll(/\b((?:map|load|screen|sheet)[A-Z][\w$]*)\b/g)) called.add(m[1]);
    const missing = [...called].filter((n) => !defined.has(n)).sort();
    if (missing.length) {
      for (const n of missing) console.error(`FAIL static — ${n}() is called but never defined`);
      console.error(`\n${missing.length} helper${missing.length === 1 ? '' : 's'} called but not defined.`);
      process.exit(1);
    }
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
