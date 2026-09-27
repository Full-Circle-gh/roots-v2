#!/usr/bin/env node
/**
 * The button never leaves the screen — §281, on the phone.
 *
 *   node scripts/test_mobile_footbar.js
 *
 * Ash: "the save button if there is any and it's not auto save, the button
 * should be in reach at any giving moment on the screen. I don't want the user
 * to scroll finding the save button."
 *
 * Every long form's commit button is drawn in the pinned bar (.footbar, written
 * by footBar()). What this proves, per screen, is the part a string check
 * cannot: that the bar is where sticky WORKS — a direct child of the scroller
 * and the last thing in it — and that with the page made far taller than the
 * screen and scrolled to the top, the bar still sits on the bottom edge of the
 * glass with the button in it. A bar nested in a padded wrapper, or followed
 * by a list, passes a text check and fails this one.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const STUB = `window.__sent=[];
  var CAPS=[{key:'dashboard:view',group:'run',section:'dashboard',labelEn:'View dashboard',labelCn:'查看概览'},
    {key:'orders:view',group:'run',section:'orders',labelEn:'See orders',labelCn:'查看订单'}];
  window.__reply=function(u){
    if(u.indexOf('/api/backend/capabilities')>=0) return {success:true,capabilities:CAPS,groups:['run'],
      groupNames:{run:['Run the shop','日常运营']},sections:{dashboard:['Dashboard','概览'],orders:['Orders','订单']},moneyNotes:{}};
    if(u.indexOf('/permissions')>=0) return {success:true,role:'store_manager',roleName:{en:'Store manager',cn:'店长'},
      isOwner:false,isSelf:false,presetCaps:['dashboard:view'],effective:['dashboard:view'],grants:[],revokes:[],scopeAll:true,storeIds:[]};
    if(u.indexOf('/api/backend/roles')>=0) return {success:true,canEdit:true,layouts:['default'],dashCards:[],rbacEnforce:true,
      roles:[{key:'warehouse',nameEn:'Warehouse',nameCn:'仓库',isFixed:false,people:0,exceptions:0,capCount:1,capTotal:2,
        caps:['orders:view'],layout:'default',stockAppOnly:false,dashboardCards:null,moneyMoves:0,moneyShows:0}]};
    return {success:true,data:{}};
  };
  window.fetch=function(u,o){ window.__sent.push({u:String(u),m:(o&&o.method)||'GET'});
    var j=window.__reply(String(u));
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(j)}}); };
  state.me={name:'Mei Chen',role:'owner'};
  state.caps=['team:view','team:manage','team:permissions','expenses:submit','orders:edit','restock:receive','broadcasts:send'];
  state.stores=[{id:1,name_en:'Tianhe store',name_cn:'天河店'}];
  state.roles=[{key:'warehouse',nameEn:'Warehouse',nameCn:'仓库',storePinned:false}];
  state.teamTried=true; state.team=[
    {id:1,username:'mei',displayName:'Mei Chen',role:'owner',isActive:true,isSelf:true},
    {id:2,username:'lin',displayName:'Lin Hao',role:'warehouse',isActive:true,isSelf:false}];`;

/* The bar is pinned: a direct child of #content, the last thing in it, sticky —
   and, with 3000px of page pushed in above it and the page at the top, still on
   the bottom edge of the scroller with `label` inside it. */
const pinned = (label) => `(function(){
  var c=document.getElementById('content'), bar=c&&c.querySelector(':scope > .footbar');
  if(!bar) throw new Error('no .footbar directly in #content');
  if(bar.nextElementSibling) throw new Error('something follows the bar: '+bar.nextElementSibling.outerHTML.slice(0,60));
  if(getComputedStyle(bar).position!=='sticky') throw new Error('not sticky');
  if(bar.innerText.indexOf(${JSON.stringify(label)})<0) throw new Error('bar says: '+bar.innerText.slice(0,80));
  var pad=document.createElement('div'); pad.style.height='3000px'; c.insertBefore(pad,bar); c.scrollTop=0;
  var gap=Math.abs(bar.getBoundingClientRect().bottom-c.getBoundingClientRect().bottom);
  pad.remove();
  if(gap>2) throw new Error('bar sits '+gap+'px off the bottom edge');
  return true; })()`;

const CASES = [
  ['New order', STUB + `APP.cmd('push','neworder');`, [
    ['Create order is pinned', pinned('Create order')],
  ]],
  ['New broadcast', STUB + `APP.cmd('push','bcnew');`, [
    ['Next is pinned', pinned('Next')],
  ]],
  ['Expense', STUB + `APP.cmd('push','expense');`, [
    ['Submit is pinned, below the list of what was sent', pinned('Submit')],
    ['the approval sentence rides with it', pinned('until it is approved')],
  ]],
  ['Add someone', STUB + `APP.cmd('push','team'); APP.cmd('teamInvite');`, [
    ['Add them is pinned', pinned('Add them')],
  ]],
  ['Permissions', STUB + `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamPerms',2);`, [
    ['Save permissions is pinned', pinned('Save permissions')],
  ]],
  ['Role (saves itself)', STUB + `APP.cmd('push','team'); APP.cmd('teamTab','roles');`, [
    ['Undo and Version history are pinned', `(function(){ APP.cmd('roleOpen','warehouse'); return ${pinned('Version history')}; })()`],
    ['Delete stays on the page, out of the bar', `!document.querySelector('#content > .footbar').innerText.includes('Delete role')
      && document.getElementById('content').innerText.includes('Delete role')`],
  ]],
  ['Receive from another shop — confirm', STUB + `APP.cmd('push','receivexfer');
     state.xfr.tried=true; state.xfr.list=[]; state.xfr.orderId=5; state.xfr.busy=false;
     state.xfr.order={id:5,goods_state:'in_transit',items:[{id:1,qty_sent:3,qty_received:3,product_name:'Carrots'}]};
     state.xfr.step='confirm'; render();`, [
    ['Confirm receipt is pinned', pinned('Confirm receipt')],
  ]],
];

// Settled: Permissions and Role read their records before they draw a bar.
run('pinned-button', CASES, { settle: 120 });
