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
// A request already sent to the kitchen — the other end of "Ask the kitchen".
const KITCHEN_REQ = {
  id: 91, rs_number: 'RS-260904-002', status: 'sent', from_role: 'warehouse', to_role: 'kitchen',
  purpose: 'shelf', goods_state: 'none', item_count: 1,
  items: [{ id: 911, product_id: null, product_name: 'Hummus Asli', product_cn: '鹰嘴豆泥', sku: '1-10', qty_requested: 6 }],
};
const ROWS = [{ product_id: 7, name_en: 'Hummus Asli', name_cn: '鹰嘴豆泥', sku: '1-10', physical_qty: 11, restock_target: 5 }];

// TWO LOCATIONS, which is the whole subject of the "Ask for stock" cases below.
// Roots really has these two, and the second one is what makes the screen mean
// anything: with one store there is nobody to ask.
const TWO = [
  { id: 1, name_en: 'Tianhe', name_cn: '天河店', code: 'TH' },
  { id: 2, name_en: 'Yuexiu', name_cn: '越秀店', code: 'YX' },
];

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
    'var CTX=' + JSON.stringify(o.stores ? Object.assign({}, CTX, { stores: o.stores }) : CTX) +
      ',STOCK=' + JSON.stringify(ROWS) + ';\n' +
    'var ORDERS=' + JSON.stringify(orders) + ',DENY=' + JSON.stringify(!!o.deny) + ';\n' +
    'var KITCHEN=' + JSON.stringify(o.noQueue ? [] : [KITCHEN_REQ]) + ';\n' +
    'var KONLY=' + JSON.stringify(!!o.kitchenOnly) + ';\n' +
    'window.fetch=function(url,opts){url=String(url);opts=opts||{};window.__calls.push(url.split("?")[0]);var body;\n' +
    '  if(url.indexOf("/quick-stock/context")>-1) body={success:true,data:CTX};\n' +
    '  else if(/\\/stock$/.test(url)) body={success:true,data:STOCK};\n' +
    '  else if(url.indexOf("/api/retail-admin/products")===0){\n' +
    '    if(DENY) return Promise.resolve({status:403,json:function(){return Promise.resolve({error:"forbidden"})}});\n' +
    '    body={success:true,data:[{id:7,name_en:"Hummus Asli",name_cn:"鹰嘴豆泥",sku:"1-10",status:"Active"}]};\n' +
    '  }\n' +
    '  else if(url.indexOf("/api/restock")===0){\n' +
    // A KITCHEN-ONLY OPERATOR, AS THE SERVER ACTUALLY ANSWERS THEM. A Tacet
    // session holding restock:fulfil and not restock:pick is _kitchenScopedSession,
    // and the list route 403s it on anything but to_role=kitchen. The 403 is a
    // rejection with no query behind it, so it comes back FASTER than the two
    // 200s beside it — this stub answers the kitchen list on a delay to make
    // that ordering deterministic rather than lucky.
    '    if(KONLY && url.indexOf("to_role=kitchen")<0)\n' +
    '      return Promise.resolve({status:403,json:function(){return Promise.resolve({error:"forbidden"})}});\n' +
    '    if(opts&&opts.method==="POST"){ window.__post=JSON.parse(opts.body||"{}");\n' +
    '      body={success:true,id:99,rs_number:"RS-260904-001"}; }\n' +
    '    else\n' +
    '    if(DENY) return Promise.resolve({status:403,json:function(){return Promise.resolve({error:"forbidden"})}});\n' +
    '    var m=url.match(/restock\\/(\\d+)$/);\n' +
    '    if(/\\/status$/.test(url)){ window.__status=JSON.parse(opts.body||"{}"); body={success:true}; }\n' +
    '    else if(m) body={success:true,data:ORDERS.concat(KITCHEN).filter(function(o){return o.id===Number(m[1])})[0]};\n' +
    '    else if(url.indexOf("to_role=kitchen")>-1) body={success:true,data:KITCHEN};\n' +
    '    else body={success:true,data:ORDERS};\n' +
    '  }\n' +
    '  else body={success:true,data:{}};\n' +
    '  if(KONLY&&url.indexOf("to_role=kitchen")>-1)\n' +
    '    return new Promise(function(z){setTimeout(function(){z({status:200,json:function(){return Promise.resolve(body)}})},60)});\n' +
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
             'Receive', 'Count a delivery in', '1 delivery waiting',
             'Ask the kitchen', 'Have something made', 'Kitchen queue'],
    check: (out) => /data-view="home"/.test(out) ? null : 'the app did not open on the launcher' },

  // THE ORIGINAL DEFECT, ASSERTED. A quiet day must still show both doors.
  'tiles-stay-when-there-is-no-work': { noRun: true, noInbound: true, js: 'window.__done();',
    expect: ['Pick', 'Nothing to pick', 'Receive', 'Nothing on its way', 'Ask the kitchen', 'Kitchen queue'],
    absent: ['still to pull', 'delivery waiting'] },

  // THE OTHER HALF. One job needs no launcher, and the people who only count
  // are the ones who use this app every day.
  'no-launcher-for-one-job': { deny: true, js: 'window.__done();',
    expect: ['Quick stock', 'Hummus Asli'],
    absent: ['Pull a run for the stores', 'Count a delivery in', 'Have something made',
             'Make what was asked for', 'Hi Asher'],
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

  // ── The kitchen queue, in Tacet ──────────────────────────────────────────
  // It used to live in public/kitchen.html on the kitchen host: separate app,
  // separate login, separate permissions. That app is dead.
  'queue-tile-carries-its-own-count': { js: 'window.__done();',
    expect: ['Kitchen queue', 'Make what was asked for', '1 waiting'] },

  'queue-tile-stays-when-idle': { noQueue: true, js: 'window.__done();',
    expect: ['Kitchen queue', 'Nothing to make'], absent: ['Make what was asked for'] },

  'queue-opens-and-shows-the-ask': { js: seq(["'[data-kqopen-home]'", '250']),
    expect: ['Kitchen queue', 'To make', 'Done', 'RS-260904-002', 'For the shelf'] },

  'queue-detail-says-stock-does-not-move': {
    js: seq(["'[data-kqopen-home]'", '250', "'[data-kqopen=\"91\"]'", '250']),
    expect: ['RS-260904-002', 'Hummus Asli', 'Start making',
             'Stock changes when the batch is logged, not here'] },

  'queue-advances-sent-to-received': {
    js: seq(["'[data-kqopen-home]'", '250', "'[data-kqopen=\"91\"]'", '250', "'[data-kqnext]'", '300']),
    checkStatus: (st) => {
      if (!st) return 'nothing was written';
      if (st.status !== 'received') return `wrote status ${st.status}, expected received`;
      return null;
    } },

  'home-cn': { pre: "localStorage.setItem('roots-admin-lang','cn');", js: 'window.__done();',
    expect: ['你好', '盘点', '拣货', '收货', '向厨房下单', '厨房制作队列', '待拣', '批待收货'] },

  // ── Ask the kitchen ──────────────────────────────────────────────────────
  // Nothing has raised a kitchen request since 16 May, because the only screen
  // that could was deleted in August. This is that door.
  'kitchen-asks-why-first': { js: seq(["'[data-akopen]'", '250']),
    expect: ['Ask the kitchen', 'What is it for?', 'For an order', 'For the shelf',
             'They make it — nothing moves until it is made'],
    // The purpose has no default: the server refuses a kitchen request without
    // one, and a reason picked for him is a reason he did not give.
    check: (out) => /data-send="disabled"/.test(out) ? null : 'Send was live before a purpose was chosen' },

  'kitchen-needs-a-purpose-AND-a-product': {
    js: seq(["'[data-akopen]'", '250', "'[data-akinc=\"7\"]'"]),
    expect: ['1 items'],
    check: (out) => /data-send="disabled"/.test(out) ? null : 'Send was live with a product but no purpose' },

  'kitchen-sends': {
    js: seq(["'[data-akopen]'", '250', "'[data-akpurpose=\"shelf\"]'", "'[data-akinc=\"7\"]'",
             "'[data-akinc=\"7\"]'", "'[data-aksend]'", '350']),
    expect: ['Sent to the kitchen', '1 item · 2 units', 'The kitchen sees it now'],
    checkPost: (p) => {
      if (!p) return 'nothing was posted';
      if (p.to_role !== 'kitchen') return `posted to_role ${p.to_role}, expected kitchen`;
      if (p.purpose !== 'shelf') return `posted purpose ${p.purpose}, expected shelf`;
      if (!p.items || p.items.length !== 1 || p.items[0].qty_requested !== 2) {
        return 'the line did not carry the quantity that was set';
      }
      // A store id in a field the kitchen reads as a kitchen id points at a
      // different product, and nothing would ever say so.
      if (p.items[0].product_id != null) return 'a product_id was sent from the wrong catalogue';
      if (!p.items[0].product_name) return 'the line carried no name, which is all a kitchen request has';
      return null;
    } },

  /* ── Ask for stock ────────────────────────────────────────────────────────
     One location asking another to send it something. The direction is not a
     mode: it is which two ids go in which field, so the SAME screen has to
     produce Yuexiu→Tianhe and Tianhe→Yuexiu, and both are asserted below.

     This also stands in for a door that was shut without anyone noticing.
     app.html's "Send to Warehouse" was the only thing that could raise a store
     request; it is kitchen-realm, and #261 made POST /api/restock tacetOnly, so
     it has 403'd since. Between then and here, nothing could raise a
     store-to-store request at all. */

  // No second location, no tile. A door onto "there is nowhere else to ask" is
  // worse than no door — this is the one place the empty-tiles rule above bends,
  // and it bends because the emptiness is permanent, not a quiet day.
  'ask-tile-hidden-when-there-is-nowhere-to-ask': { js: 'window.__done();',
    expect: ['Ask the kitchen'], absent: ['Ask for stock', 'Have another location send it'] },

  'ask-tile-appears-with-a-second-location': { stores: TWO, js: 'window.__done();',
    expect: ['Ask for stock', 'Have another location send it'] },

  // Who supplies has NO DEFAULT. Choosing it for him is choosing whose shelf
  // empties, and the two locations here are different people.
  'ask-has-no-default-supplier': { stores: TWO, js: seq(["'[data-asopen]'", '250']),
    expect: ['Ask for stock', 'Who should send it?', 'Yuexiu'],
    check: (out) => {
      if (!/data-send="disabled"/.test(out)) return 'Send was live before a supplier was chosen';
      return /class="ak-opt on"/.test(out) ? 'a supplier was pre-selected' : null;
    } },

  // You cannot ask yourself. The store on screen is the receiver, so offering it
  // as the sender would offer a transfer the server refuses as same-location.
  'ask-never-offers-the-store-you-are-standing-in': { stores: TWO,
    js: seq(["'[data-asopen]'", '250']),
    expect: ['Yuexiu'],
    check: (out) => /data-asfrom="1"/.test(out) ? 'the receiving store was offered as its own supplier' : null },

  'ask-needs-a-supplier-AND-a-product': { stores: TWO,
    js: seq(["'[data-asopen]'", '250', "'[data-asinc=\"7\"]'"]),
    expect: ['1 items'],
    check: (out) => /data-send="disabled"/.test(out) ? null : 'Send was live with a product but no supplier' },

  // THE REQUEST THE OLD MODEL COULD NOT EXPRESS. Standing at Tianhe, asking
  // Yuexiu: from_store_id is the supplier, to_store_id the shelf on screen.
  'ask-sends-tianhe-to-yuexiu': { stores: TWO,
    js: seq(["'[data-asopen]'", '250', "'[data-asfrom=\"2\"]'", "'[data-asinc=\"7\"]'",
             "'[data-asinc=\"7\"]'", "'[data-assend]'", '350']),
    expect: ['Sent to Yuexiu', '1 item · 2 units', 'It is on their pick list now'],
    checkPost: (p) => {
      if (!p) return 'nothing was posted';
      if (p.from_store_id !== 2) return `from_store_id ${p.from_store_id}, expected Yuexiu (2)`;
      if (p.to_store_id !== 1) return `to_store_id ${p.to_store_id}, expected Tianhe (1)`;
      if (p.to_role === 'kitchen') return 'a store request was addressed to the kitchen';
      if (p.status !== 'sent') return `posted status ${p.status}, expected sent`;
      if (!p.items || p.items.length !== 1 || p.items[0].qty_requested !== 2) {
        return 'the line did not carry the quantity that was set';
      }
      // Same trap as the kitchen screen: store and kitchen catalogues are
      // separate counters over one integer space, and this field is read as a
      // kitchen id. The name is what a picker reads off the row.
      if (p.items[0].product_id != null) return 'a product_id was sent from the wrong catalogue';
      return null;
    } },

  // THE SAME SCREEN, THE OTHER WAY ROUND, with nothing switched but where the
  // person is standing. If these two ever need different code the model is wrong.
  'ask-sends-yuexiu-to-tianhe': { stores: TWO, pre: "localStorage.setItem('qs_store','2');",
    js: seq(["'[data-asopen]'", '250', "'[data-asfrom=\"1\"]'", "'[data-asinc=\"7\"]'", "'[data-assend]'", '350']),
    expect: ['Sent to Tianhe'],
    checkPost: (p) => {
      if (!p) return 'nothing was posted';
      if (p.from_store_id !== 1) return `from_store_id ${p.from_store_id}, expected Tianhe (1)`;
      if (p.to_store_id !== 2) return `to_store_id ${p.to_store_id}, expected Yuexiu (2)`;
      return null;
    } },

  /* ── The kitchen operator, who could not see their own queue ──────────────
     Ash, on a phone, on a kitchen account: "i don't see the order tianhe push,
     i don't even see the screen where i can see it."

     Three loaders fire together at boot and the FIRST to answer decides whether
     the launcher exists (`_landed` latches). A kitchen-only operator is 403'd
     on the two transfer lists and answered on the kitchen one — and a 403 is a
     rejection with no query behind it, so it wins that race almost every time.
     It set `rc.on = false`, `homeAvailable()` went false, and the app stayed on
     the counting list. The queue shipped in #262 was unreachable by exactly the
     people it was built for.

     The rule this asserts: BEING REFUSED ONE JOB IS NOT BEING REFUSED ALL OF
     THEM. Whether a launcher exists is the OR of what answered, never whatever
     answered first. */
  'kitchen-only-operator-still-gets-their-queue': { kitchenOnly: true, js: 'window.__done();',
    expect: ['Kitchen queue', 'Make what was asked for', '1 waiting'],
    check: (out) => /data-view="home"/.test(out) ? null
      : 'a kitchen operator was refused the launcher by the transfer 403' },

  // And they are not shown doors that would 403 on the first tap. Pick, Receive
  // and Ask for stock are all transfer work, which is the thing they were just
  // refused; Count is theirs because counting is not restock at all.
  'kitchen-only-operator-is-shown-no-transfer-tiles': { kitchenOnly: true, stores: TWO,
    js: 'window.__done();',
    expect: ['Kitchen queue', 'Count'],
    absent: ['Pull a run for the stores', 'Nothing to pick', 'Count a delivery in',
             'Nothing on its way', 'Ask for stock'] },

  /* ── The deep link from /m ────────────────────────────────────────────────
     A kitchen operator whose role puts them in the mobile backend never sees
     this launcher: they see /m's More list, where "Add stock" is not a name
     anybody reads as "the orders waiting for you". That list now carries a
     Kitchen queue row pointing here with ?go=queue. */
  'go-queue-opens-the-queue-not-the-launcher': { kitchenOnly: true, search: '?go=queue',
    js: 'window.__done();',
    expect: ['Kitchen queue', 'To make', 'RS-260904-002'],
    check: (out) => /data-view="home"/.test(out) ? 'the deep link stopped at the launcher' : null },

  // A LINK CANNOT GRANT ACCESS. Someone who was refused the queue and follows
  // the same URL lands where they would have anyway — not on a refusal.
  'go-queue-is-ignored-when-the-queue-was-refused': { deny: true, search: '?go=queue',
    js: 'window.__done();',
    expect: ['Quick stock', 'Hummus Asli'], absent: ['To make'] },

  'ask-cn': { stores: TWO, pre: "localStorage.setItem('roots-admin-lang','cn');",
    js: seq(["'[data-asopen]'", '250']),
    expect: ['申请补货', '由哪个地点发货?', '越秀店'] },

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
      'document.body.setAttribute("data-post",JSON.stringify(window.__post||null));' +
      'document.body.setAttribute("data-status",JSON.stringify(window.__status||null));' +
      'var sb=document.querySelector(".rc-foot .rc-cta");' +
      'document.body.setAttribute("data-send",sb?(sb.hasAttribute("disabled")?"disabled":"live"):"none");' +
      'document.title=(window.__e.length?"ERR "+window.__e.join(" | "):"OK "+n);}' +
      '});</scr' + 'ipt>';
    // location.search on a file:// URL cannot be set by loading the page, so the
    // query the app reads is stamped in before boot — same thing homeWanted()
    // looks at, without needing a server.
    const q = c.search ? '<script>try{history.replaceState(null,"","' + c.search + '")}catch(e){}</scr' + 'ipt>' : '';
    const pre = q + (c.pre ? '<script>' + c.pre + '</scr' + 'ipt>' : '');
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
    if (c.checkStatus) {
      const st = JSON.parse(dec((out.match(/data-status="([^"]*)"/) || [])[1] || 'null'));
      const p = c.checkStatus(st); if (p) failures.push([name, p]);
    }
    if (c.checkPost) {
      const posted = JSON.parse(dec((out.match(/data-post="([^"]*)"/) || [])[1] || 'null'));
      const p = c.checkPost(posted); if (p) failures.push([name, p]);
    }

    const OK = [/^\/api\/retail-admin\/quick-stock\/context$/, /^\/api\/retail-admin\/stores\/\d+\/stock$/,
      /^\/api\/restock$/, /^\/api\/restock\/\d+$/, /^\/api\/restock\/\d+\/status$/,
      /^\/api\/retail-admin\/products$/];
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
