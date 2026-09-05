#!/usr/bin/env node
/**
 * The customer record, opened from an order.
 *
 *   node scripts/test_mobile_customer_record.js
 *
 * Every sheet in m.html is rebuilt from scratch on each render, and `.sheet`
 * rises with `animation:tSheetUp .4s both`. A sheet that keeps reading after it
 * opens therefore re-mounts mid-rise and starts the rise AGAIN — at
 * translateY(100%), which is below the bottom of the screen, with its scrim
 * back at opacity 0. That is not a flicker. What an operator sees is the screen
 * behind at full brightness with a strip of something at the very bottom edge,
 * two things that scroll, no tab bar and no way to close either.
 *
 * This one had it worst, because tapping it also switched tabs and kicked off a
 * fresh read of the customer LIST — three more renders for the sheet to survive.
 *
 * So the check is: the record opens ON TOP of the order it was opened from, it
 * is still where it belongs after the reads land, and closing it puts the order
 * back. Plus the page itself cannot be dragged, which is what took the tab bar
 * off the bottom of the screen.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fakeServer } = require('./lib/m-fakeserver');
const { inlineTdDatetime } = require('./lib/m-probe');

const APP = path.join(__dirname, '..', 'public', 'm.html');

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try { const p = require('playwright').chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  for (const g of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(g)) return g;
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw)) {
    const p = path.join(pw, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p;
  }
  return null;
}

// The order fixture carries no customer_id, so the button it draws would never
// render. Stamping one on the mapped detail is the smallest way to get the
// button on screen without teaching the shared fake server about this test.
const STEPS = `
  APP.cmd('tab','orders');
  setTimeout(function(){
    var o=(state.liveOrders||DB.orders)[0];
    APP.cmd('openOrder', o.id);
    setTimeout(function(){
      if(state.liveDetail) state.liveDetail.custId=1;
      render();
      var btn=[].slice.call(document.querySelectorAll('button'))
        .filter(function(b){ return /View customer|查看顾客/.test(b.innerText); })[0];
      if(!btn){ window.__NOBTN=1; return; }
      window.__ORDER=state.detailId;
      btn.click();
      // Every render the sheet's own reads will cause, and then some. If the
      // guard is missing, any one of these puts it back below the screen.
      setTimeout(function(){ render(); },120);
      setTimeout(function(){ render(); },380);
    },500);
  },250);`;

const PROBE = `
 (function(){
  var out={};
  out.noBtn=!!window.__NOBTN;
  out.orderStillOpen = state.detailId!=null && state.detailId===window.__ORDER;
  out.custId = state.custId;
  out.tab = state.tab;
  var cust=document.getElementById('custSheet');
  if(cust){
    var r=cust.getBoundingClientRect(), cs=getComputedStyle(cust);
    out.cust={top:Math.round(r.top), bottom:Math.round(r.bottom), z:cs.zIndex,
      running:(cust.getAnimations?cust.getAnimations():[]).length};
  }
  var order=document.getElementById('detailSheet');
  out.orderZ = order?getComputedStyle(order).zIndex:null;
  out.win=innerHeight;
  var de=document.scrollingElement;
  out.pageScroll = de.scrollHeight - de.clientHeight;
  // …and it must actually close back onto the order.
  APP.cmd('closeCustomer');
  out.afterClose={custId:state.custId, detailId:state.detailId,
    orderSheet:!!document.getElementById('detailSheet')};
  document.title='G'+JSON.stringify(out);
 })();`;

function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found.'); process.exit(0); }
  const src = inlineTdDatetime(fs.readFileSync(APP, 'utf8')
    .replace(/<script src="https:\/\/unpkg\.com[^>]*><\/script>/, '')
    .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
    .replace('<script>', `<script>${fakeServer()}</script><script>`));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm-custrec-'));
  fs.writeFileSync(path.join(dir, 'host.html'),
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}
     iframe{position:fixed;left:0;top:0;width:390px;height:100vh;border:0}</style>
     <script>addEventListener('message',function(e){ document.title=String(e.data||''); });</script>
     <iframe src="p.html"></iframe>`);
  const boot = `<script>addEventListener("load",function(){
    setTimeout(function(){ try{${STEPS}}catch(e){ document.title='ERR '+e.message; }
      setTimeout(function(){ try{${PROBE}
        try{ parent.postMessage(document.title,'*'); }catch(e){}
      }catch(e){ document.title='PERR '+e.message; } },2200); },600); });</script>`;
  fs.writeFileSync(path.join(dir, 'p.html'), src.replace('</body>', boot + '</body>'));

  let out = '';
  try {
    out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--window-size=390,844', '--virtual-time-budget=9000', '--dump-dom',
      'file://' + path.join(dir, 'host.html')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { console.log('FAIL — chromium: ' + e.message); process.exit(1); }

  const m = out.match(/<title>([^<]*)<\/title>/);
  const title = m ? m[1] : '';
  if (!title || title[0] !== 'G') { console.log('FAIL — probe did not run: ' + (title || '(no title)')); process.exit(1); }
  const g = JSON.parse(title.slice(1));

  const fails = [];
  if (g.noBtn) fails.push('the order sheet drew no button to the customer record');
  if (!g.orderStillOpen) fails.push('the order closed — the record is meant to open OVER it, so closing the record gives the order back');
  if (g.tab !== 'orders') fails.push(`the app left the Orders tab (now "${g.tab}") — one tap should not move the whole app`);
  if (g.custId == null) fails.push('no customer record opened');
  if (!g.cust) fails.push('no customer sheet in the DOM');
  else {
    // 46px is the top the sheet is written with. Parked below the screen is the
    // failure this test exists for, so the message says which one happened.
    if (g.cust.top > 60) fails.push(`the record sits at ${g.cust.top}px, not its 46px top`
      + (g.cust.top >= g.win - 4 ? ' — it is parked below the bottom of the screen, re-rising on every render' : ''));
    if (g.cust.running) fails.push(`the record is still animating after its reads landed (${g.cust.running} running)`);
    if (g.orderZ != null && Number(g.cust.z) <= Number(g.orderZ))
      fails.push(`the record (z ${g.cust.z}) is not above the order it opened from (z ${g.orderZ})`);
  }
  if (g.pageScroll > 0) fails.push(`the page itself can be dragged ${g.pageScroll}px — that is how the tab bar leaves the screen`);
  if (g.afterClose.custId != null) fails.push('closing the record left it open');
  if (!g.afterClose.orderSheet) fails.push('closing the record did not put the order back');

  if (fails.length) { console.log('FAIL\n  • ' + fails.join('\n  • ')); process.exit(1); }
  console.log(`ok — the record opens over the order at ${g.cust.top}px (z ${g.cust.z} over ${g.orderZ}), `
    + 'holds still through its reads, and closes back onto the order. The page does not scroll.');
}

main();
