#!/usr/bin/env node
/**
 * An order opened from the customer record's Recent orders.
 *
 *   node scripts/test_mobile_order_from_record.js
 *
 * The record's Recent orders block was five inert lines. An operator reading a
 * customer's history could see that an order came to ¥117.50 and had no way
 * from there to find out what was in it — the number had to be memorised, the
 * record closed, the Orders tab searched, and a customer's older orders are not
 * on the page the list has loaded, so often that search found nothing either.
 *
 * So the check is four things, in the order an operator meets them:
 *
 *   1. every row is a button, and says the date and the status the desktop's
 *      table says (the date was blank on every row: the query is
 *      `placed_at AS created_at` and the phone read `r.placed_at`);
 *   2. a tap on an order that is NOT in the loaded list paints something
 *      immediately — the number and a working Close — instead of a blank
 *      screen while the read is in flight;
 *   3. when the read lands, the order sheet is the sheet on TOP, because a
 *      sheet the operator just asked for painted underneath the one they asked
 *      from is a tap that did nothing;
 *   4. the record is still open underneath and closing the order gives it back.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fakeServer } = require('./lib/m-fakeserver');

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

// The record's third recent order (id 207) is deliberately absent from the
// orders list the app loaded — that is the case findOrder cannot answer and
// the read by id has to. Rows are read off the DOM rather than off state, so
// what the check sees is what a thumb would land on.
const STEPS = `
  APP.cmd('tab','customers');
  setTimeout(function(){
    APP.cmd('openCustomer', 1);
    setTimeout(function(){
      var head=[].slice.call(document.querySelectorAll('#custSheet span'))
        .filter(function(s){ return /^(Recent orders|最近订单)$/.test(s.textContent.trim()); })[0];
      if(!head){ window.__NOHEAD=1; return; }
      var list=head.parentNode.parentNode.querySelector('.list');
      var rows=[].slice.call(list.querySelectorAll('button.row'));
      window.__ROWS=rows.map(function(b){ return b.innerText.replace(/\\s+/g,' ').trim(); });
      var last=rows[rows.length-1];
      if(!last){ window.__NOROWS=1; return; }
      window.__CUST=state.custId;
      last.click();
      // The frame straight after the tap, before the read can possibly land:
      // this is the one that used to be blank.
      var sh=document.getElementById('detailSheet');
      window.__ONTAP={sheet:!!sh, text:sh?sh.innerText.replace(/\\s+/g,' ').trim():'',
        closes:!!(sh&&sh.querySelector('button[aria-label]'))};
      // Renders the record's own reads would cause, and then some — neither
      // sheet may re-rise through any of them.
      setTimeout(function(){ render(); },120);
      setTimeout(function(){ render(); },380);
    },600);
  },300);`;

const PROBE = `
 (function(){
  var out={};
  out.noHead=!!window.__NOHEAD; out.noRows=!!window.__NOROWS;
  out.rows=window.__ROWS||[]; out.onTap=window.__ONTAP||null;
  out.custStillOpen = state.custId!=null && state.custId===window.__CUST;
  out.detailId=state.detailId;
  out.items=(state.liveDetail&&state.liveDetail.items||[]).length;
  var ord=document.getElementById('detailSheet'), cust=document.getElementById('custSheet');
  if(ord){ var r=ord.getBoundingClientRect(), cs=getComputedStyle(ord);
    out.ord={top:Math.round(r.top), z:Number(cs.zIndex),
      running:(ord.getAnimations?ord.getAnimations():[]).length,
      text:ord.innerText.replace(/\\s+/g,' ').trim()}; }
  if(cust){ var c=cust.getBoundingClientRect();
    out.cust={top:Math.round(c.top), z:Number(getComputedStyle(cust).zIndex),
      running:(cust.getAnimations?cust.getAnimations():[]).length}; }
  out.win=innerHeight;
  // …and closing the order must give the record back, not leave the operator
  // on whatever screen was under both of them.
  APP.cmd('closeOrder');
  out.afterClose={detailId:state.detailId, custId:state.custId,
    custSheet:!!document.getElementById('custSheet'),
    custZ:document.getElementById('custSheet')?Number(getComputedStyle(document.getElementById('custSheet')).zIndex):null,
    orderSheet:!!document.getElementById('detailSheet')};
  document.title='G'+JSON.stringify(out);
 })();`;

function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found.'); process.exit(0); }
  const src = fs.readFileSync(APP, 'utf8')
    .replace(/<script src="https:\/\/unpkg\.com[^>]*><\/script>/, '')
    .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
    .replace('<script>', `<script>${fakeServer()}</script><script>`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm-ordrec-'));
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
  if (g.noHead) fails.push('the record drew no Recent orders block');
  else if (g.noRows) fails.push('Recent orders drew no rows the operator can tap — they are still inert lines');
  else {
    if (g.rows.length !== 3) fails.push(`Recent orders drew ${g.rows.length} tappable rows, expected the fixture's 3`);
    // Every row: a number, a date, a status, a total. The date was the one that
    // silently vanished, so name it rather than saying "a row is short".
    const undated = g.rows.filter((t) => !/(Jul|Aug|Yesterday|\d+月)/.test(t));
    if (undated.length) fails.push(`${undated.length} of ${g.rows.length} rows carry no date — "${undated[0]}"`);
    const unstatused = g.rows.filter((t) => !/(Paid|Preparing|Dispatched|Delivered|Pending|Unpaid|Cancelled|Refunded)/.test(t));
    if (unstatused.length) fails.push(`${unstatused.length} of ${g.rows.length} rows carry no status — "${unstatused[0]}"`);
  }

  if (!g.onTap) fails.push('nothing recorded the frame right after the tap');
  else {
    if (!g.onTap.sheet) fails.push('the tap painted nothing — an order the list has not loaded left a blank screen until the read landed');
    else {
      if (!/RT-|207/.test(g.onTap.text)) fails.push(`the waiting sheet does not say which order is opening — "${g.onTap.text}"`);
      if (!/Loading|加载中/.test(g.onTap.text)) fails.push(`the waiting sheet does not say it is reading — "${g.onTap.text}"`);
      if (!g.onTap.closes) fails.push('the waiting sheet has no Close — an operator who taps the wrong row is stuck in it');
    }
  }

  if (!g.ord) fails.push('no order sheet after the read landed');
  else {
    if (g.ord.top > 60) fails.push(`the order sits at ${g.ord.top}px, not its 46px top`
      + (g.ord.top >= g.win - 4 ? ' — it is parked below the bottom of the screen, re-rising on every render' : ''));
    if (g.ord.running) fails.push(`the order is still animating after the read landed (${g.ord.running} running)`);
    if (!g.items) fails.push('the order sheet never filled in — the read by id did not land on the sheet');
    if (g.cust && !(g.ord.z > g.cust.z))
      fails.push(`the order (z ${g.ord.z}) is not above the record it was opened from (z ${g.cust.z}) — the tap opened a sheet nobody can see`);
  }
  if (!g.cust) fails.push('the record closed — the order opens OVER it, so closing the order gives the record back');
  else if (g.cust.running) fails.push(`the record re-rose when the order opened over it (${g.cust.running} animations running)`);
  if (!g.custStillOpen) fails.push('state lost the record the order was opened from');

  if (g.afterClose.detailId != null) fails.push('closing the order left it open');
  if (!g.afterClose.custSheet) fails.push('closing the order did not put the record back');
  else if (!(g.afterClose.custZ > 46))
    fails.push(`the record stayed at z ${g.afterClose.custZ} after the order closed — it never climbed back over the order layer`);
  if (g.afterClose.orderSheet) fails.push('the order sheet is still in the DOM after closing');

  if (fails.length) { console.log('FAIL\n  • ' + fails.join('\n  • ')); process.exit(1); }
  console.log(`ok — ${g.rows.length} Recent orders rows carry date and status and open; an order off the loaded list `
    + `holds the screen while it reads, lands at ${g.ord.top}px above the record (z ${g.ord.z} over ${g.cust.z}), `
    + 'and closing it gives the record back.');
}

main();
