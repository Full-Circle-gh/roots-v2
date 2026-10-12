#!/usr/bin/env node
/**
 * §464 — a list screen's search stays on screen while the list scrolls under it.
 *
 *   node scripts/test_mobile_sticky_search.js
 *
 * Ash, 2026-10-12: "search bar should stay stick on top when scrolling" (Add
 * stock, §463), then "do for all". The block holding each list screen's search
 * carries .stick-top (position: sticky), and two things make that work or not,
 * both silently:
 *
 *   • AN INLINE `position` BEATS THE CLASS. Most of these blocks were written
 *     `position:relative` to anchor the search icon; left in, the pin is dead
 *     and nothing looks wrong until somebody scrolls. Checked for every pin in
 *     the file, statically, below.
 *   • STICKY ONLY STICKS INSIDE ITS PARENT. If the list is not inside the pinned
 *     block's parent, the block scrolls away the moment its parent does. Checked
 *     in a real browser on the screens staff work through every day: the pinned
 *     block's parent is the scroller itself or holds the screen's own list, and
 *     with the list made long and scrolled to the end, the field is still at the
 *     top.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

/* The static half (no inline position overrides a pin, and every pin is
   still there) is scripts/test_mobile_sticky_search_static.js, in the fast
   shard. This file is the browser half. */

/* ── In the browser ────────────────────────────────────────────────────── */
// The pinned block on screen is sticky, and its parent is either the scroller
// or holds the screen's list (`list` is a selector for that list's box).
const pinned = (list, scroller) => `(function(){
  var c=document.querySelector(${JSON.stringify(scroller || '#content')});
  var st=c&&c.querySelector('.stick-top');
  if(!st||getComputedStyle(st).position!=='sticky') return false;
  var L=${list ? `document.querySelector(${JSON.stringify(list)})` : 'null'};
  return st.parentElement===c || (!!L && st.parentElement.contains(L));
})()`;
// The list made long and scrolled to the end: the field is still at the top.
const stays = (list, scroller) => `(function(){
  var c=document.querySelector(${JSON.stringify(scroller || '#content')});
  var st=c.querySelector('.stick-top');
  var L=${list ? `document.querySelector(${JSON.stringify(list)})` : 'null'} || c;
  L.insertAdjacentHTML('beforeend','<div style="height:4000px"></div>');
  c.scrollTop=1e6;
  var a=c.getBoundingClientRect(), b=st.getBoundingClientRect();
  // A scroller with its own top padding (the Waste sheet has 16px) holds a
  // pinned block that far below its edge; that is still "at the top".
  var pad=parseFloat(getComputedStyle(c).paddingTop)||0;
  return c.scrollTop>500 && b.top>=a.top-1 && b.top<=a.top+pad+4;
})()`;
const both = (list, scroller) => [
  ['the pinned block is sticky and its parent holds the list', pinned(list, scroller)],
  ['scrolled to the end of a long list, the search is still at the top', stays(list, scroller)],
];

const STORES = `state.stores=[{id:1,name_en:'Tianhe',name_cn:'天河'},{id:2,name_en:'Yuexiu',name_cn:'越秀'}];`;
const go = (route) => `state.stack=[{route:'${route}',title:SUBS['${route}'].title}]; render();`;

run('sticky search', [
  ['Add stock',
    `state.caps=['quickstock:add'];
     state.qs.ctx={enabled:true,mode:'add',stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]};
     state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true;
     state.qs.items=[{product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10'}];` + go('stockadd'),
    both('#mQsBody')],
  ['Log a batch',
    `state.caps=['quickstock:add'];
     state.qs.ctx={enabled:true,mode:'add',stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]};
     state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true;
     state.qs.items=[{product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10'}];` + go('logbatch'),
    both('#mBatBody')],
  ['Ask the kitchen',
    STORES + `state.rq.products=[{product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10'}];` + go('askkitchen'),
    both('#mRqBody')],
  ['Ask for stock',
    STORES + `state.rq.to=1; state.rq.products=[{product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10'}];` + go('askstock'),
    both('#mRqBody')],
  ['Ask to buy',
    `state.mb.materials=[{id:3,name_en:'Chickpeas',name_cn:'鹰嘴豆',sku:'M-1'}];` + go('askbuy'),
    both('#mMbBody')],
  ['Materials',
    `state.feat=Object.assign({},state.feat||{},{production:true}); state.mat.rows=[];` + go('materials'),
    both('#mMatBody')],
  ['Recipes',
    `state.feat=Object.assign({},state.feat||{},{production:true});` + go('recipes'),
    both('#mRcpBody')],
  ['Receive from a supplier', go('receiving'), both('#mRcvBody')],
  ['Products',
    `DB.products=[{sku:'OM-1L',_id:12,name:['Oat milk 1L','燕麦奶 1L'],price:'¥18',priceNum:18,
       status:['Live','在售'],kind:'on',stock:12,stockLabel:['12 in stock','库存 12']}];
     APP.cmd('tab','products'); render();`,
    both('#mProdBody')],
  ['Customers', `state.caps=['customers:view']; APP.cmd('tab','customers'); render();`, both(null)],
  /* A SEARCH INSIDE A FORM pins only while its own matches scroll by, then
     leaves with the form: its parent is the field, which holds the matches. */
  ['Waste — the product field, in its own sheet',
    `state.wst.open=true; state.wst.pick=null; render();`,
    both('#mWstPicksBox', '#mWstBody')],
  ['New purchase order — adding products',
    `state.caps=['purchasing:edit','purchasing:view']; APP.cmd('pwNew'); state.pw.step=2; render();`,
    both('#mPwPicks')],
]);
