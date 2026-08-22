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
    // Purchasing reads a live ledger, so the sweep seeds one — otherwise every
    // pass renders the loading state and proves nothing about the rows.
    'push:purchasing-rows': "state.posTried=true;state.pos=[{id:4,po_number:'RPO-0004',supplier:'Fresh Co.',store_name_en:'Tianhe',date:'2026-08-14',delivery_date:'2026-08-16',status:'Ordered',line_count:6,received_lines:0,total_cost:3240},{id:5,po_number:'RPO-0005',supplier:'Oat Works',date:'2026-08-20',delivery_date:'2026-08-30',status:'Delivered',line_count:3,received_lines:3,total_cost:1880}];APP.cmd('push','purchasing')",
    // The mock's own rows must not outlive an empty server answer.
    'push:inbox-no-reviews': "DB.reviews=[];APP.cmd('push','inbox')",
    'push:coupons-empty': "DB.coupons=[];APP.cmd('push','coupons')",
    'push:flash-empty': "DB.flash=[];APP.cmd('push','flash')",
    'push:broadcasts-empty': "DB.broadcasts=[];APP.cmd('push','broadcasts')",
    'push:voting': "state.pollsTried=true;state.polls=[{id:1,question_en:'Next flavour',status:'open',reward_points:5,is_featured:1,closes_at:'2026-08-30 12:00:00',total_votes:312,options:[{id:11,label_en:'Matcha oat',votes:193},{id:12,label_en:'Black sesame',votes:119}]},{id:2,question_en:'Store hours',status:'draft',display_min_total:50,options:[]}];APP.cmd('push','voting')",
    'push:voting-results': "state.pollsTried=true;state.polls=[{id:1,question_en:'Next flavour',status:'closed',winner_option_id:11,total_votes:312,options:[{id:11,label_en:'Matcha oat',votes:193},{id:12,label_en:'Black sesame',votes:119}]}];state.pollOpen=1;APP.cmd('push','voting')",
    'push:voting-empty': "state.pollsTried=true;state.polls=[];APP.cmd('push','voting')",
    // Membership, Top-up and Leaderboard all read live config/ledgers.
    'push:membership-tiers': "state.sw=Object.assign({},state.sw,{membership:true});state.tiersTried=true;state.tiers=[{key:'seed',name_en:'Seed',name_cn:'种子',threshold:0,points_mult:1,perks_en:['5% off your first order']},{key:'tree',name_en:'Tree',name_cn:'大树',threshold:5000,points_mult:2,perks_en:['20% off','Birthday gift']}];state.tierCounts={seed:186,tree:12};APP.cmd('push','membership')",
    'push:membership-empty': "state.sw=Object.assign({},state.sw,{membership:true});state.tiersTried=true;state.tiers=[];APP.cmd('push','membership')",
    'push:topups': "state.tupTried=true;state.tupPkgs=[{id:1,amount:200,bonus_points:20,title_en:'Starter',is_active:1}];state.tup=[{id:9,nickname:'Chen Meiling',phone:'138****2841',amount:200,bonus_points:20,payment_method:'wechat',status:'success',created_at:'2026-08-22 09:00:00',paid_at:'2026-08-22 09:01:00'},{id:8,nickname:'Zhang Wei',amount:100,bonus_points:0,payment_method:'wechat',status:'pending',created_at:'2026-08-22 08:00:00'}];APP.cmd('push','wallet')",
    'push:topups-empty': "state.tupTried=true;state.tup=[];state.tupPkgs=[];APP.cmd('push','wallet')",
    'sheet:topup-finalize': "state.tupTried=true;state.tupPkgs=[];state.tup=[{id:8,nickname:'Zhang Wei',amount:100,bonus_points:5,status:'pending',created_at:'2026-08-22 08:00:00'}];APP.cmd('push','wallet');APP.cmd('finalizeTopup',8)",
    'push:leaderboard': "state.lbTried=true;state.lb={config:{enabled:true,title_en:'Top growers',metric:'lifetime_spend',period:'all',top_n:20,reveal_mode:'first_char'},revealed_entries:[{rank:1,name:'C***',value:6240},{rank:2,name:'S***',value:4180}]};APP.cmd('push','leaderboard')",
    'push:leaderboard-off': "state.lbTried=true;state.lb={config:{enabled:false,title_en:'Top growers',metric:'points_balance',period:'month',top_n:10,reveal_mode:'full',seed_enabled:true},revealed_entries:[]};APP.cmd('push','leaderboard')",
    // Categories reads the storefront's two-level tree plus its counts.
    'push:categories-tree': "state.catsTried=true;state.cats=[{id:'dry',name:'Dry & Pantry',name_cn:'干货',subs:[{id:'nuts',name:'Nuts & Seeds',name_cn:'坚果'},{id:'jams',name:'Jams',name_cn:'果酱'}]},{id:'drinks',name:'Drinks',name_cn:'饮品',subs:[]}];state.catCounts={dry:{n:14,published:14},nuts:{n:9,published:9},jams:{n:5,published:0},drinks:{n:0,published:0}};APP.cmd('push','categories')",
    'push:categories-sub': "state.catsTried=true;state.cats=[{id:'dry',name:'Dry & Pantry',name_cn:'干货',subs:[{id:'nuts',name:'Nuts & Seeds',name_cn:'坚果'}]}];state.catCounts={dry:{n:14,published:14},nuts:{n:9,published:9}};state.catTop='dry';APP.cmd('push','categories')",
    'push:categories-empty': "state.catsTried=true;state.cats=[];state.catCounts={};APP.cmd('push','categories')",
    'push:categories-error': "state.catsTried=true;state.catsErr='Could not load the categories.';APP.cmd('push','categories')",
    // Stock activity reads a live envelope (rows + summary + digest), so the
    // sweep seeds one — otherwise every pass renders "Loading…".
    'push:activity-rows': "state.actTried=true;state.act={total:2,rows:[{id:1,ts_local:'2026-08-22 09:12:00',source:'miniapp',store:'Tianhe',sku:'OM-1L',product:'Oat milk 1L',delta:-2,balance_after:10},{id:2,ts_local:'2026-08-22 08:02:00',source:'manual',store:'Tianhe',sku:'CR-01',product:'Carrots',delta:12,balance_after:0,actor_label:'Mei',note:'recount'}],summary:[{source:'miniapp',events:1,units_out:2,units_in:0},{source:'manual',events:1,units_out:0,units_in:12}],digest:{zeroed:[{ts_local:'2026-08-22 08:02:00',product:'Carrots',sku:'CR-01'}],big:[{ts_local:'2026-08-22 08:02:00',source:'manual',product:'Carrots',delta:12,actor_label:'Mei'}],zeroed_total:1}};APP.cmd('push','activity')",
    'push:activity-quiet': "state.actTried=true;state.act={total:0,rows:[],summary:[],digest:{zeroed:[],big:[],zeroed_total:0}};APP.cmd('push','activity')",
    'push:activity-error': "state.actTried=true;state.actErr='Could not load stock activity.';APP.cmd('push','activity')",
    'push:purchasing-empty': "state.posTried=true;state.pos=[];APP.cmd('push','purchasing')",
    'push:purchasing-error': "state.posTried=true;state.posErr='Could not load purchase orders.';APP.cmd('push','purchasing')",
    'sheet:po': "state.posTried=true;state.pos=[];APP.cmd('push','purchasing');state.poId=4;state.poDetail={id:4,po_number:'RPO-0004',supplier:'Fresh Co.',store_name_en:'Tianhe',date:'2026-08-14',delivery_date:'2026-08-16',status:'Ordered',total_cost:3240,notes:'Back door before 9.',items:[{id:1,name_en:'Oat milk 1L',sku:'OM-1L',qty:48,unit:'btl',total_cost:1440,current_stock:12},{id:2,name_en:'Carrots',sku:'CR-01',qty:20,unit:'kg',total_cost:1800,qty_received:18,damaged_qty:2}]};render()",
    'sheet:po-loading': "state.posTried=true;state.pos=[];APP.cmd('push','purchasing');state.poId=4;render()",
    'sheet:po-receive-ask': "state.posTried=true;state.pos=[];APP.cmd('push','purchasing');state.poId=4;state.poDetail={id:4,po_number:'RPO-0004',supplier:'F',status:'Ordered',total_cost:1,items:[]};render();APP.cmd('poStatus','Delivered')",
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

  // ── Static pass: the sample-data block still has all its keys ───────────
  // Three separate edits have now replaced a SLICE of this file — from one
  // landmark to the next — and silently taken everything in between with it.
  // Twice that was a screen, caught by the sweep; once it was a helper, caught
  // by the check above; once it was 5,600 characters of DB (invoices through
  // customers), and the only reason it was caught is that a screen happened to
  // call .filter on one of them. Every key the app reads as DB.x must be in the
  // literal that defines DB.
  {
    const raw = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    const js2 = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const lit = (js2.match(/\bconst DB\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
    if (!lit) { console.error('FAIL static — cannot find the DB literal'); process.exit(1); }
    const have = new Set([...lit.matchAll(/\n {2}([a-zA-Z_$][\w$]*)\s*:/g)].map((m) => m[1]));
    const read = new Set([...js2.matchAll(/\bDB\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
    const gone = [...read].filter((k) => !have.has(k)).sort();
    if (gone.length) {
      for (const k of gone) console.error(`FAIL static — DB.${k} is read but the DB literal has no such key`);
      console.error(`\n${gone.length} DB key${gone.length === 1 ? '' : 's'} read but not defined.`);
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
