#!/usr/bin/env node
/**
 * The Sales board, asserted against meituan-admin.js `GET /channel-status` and
 * retail.js `GET /sales/summary`.
 *
 *   node scripts/test_mobile_sales.js
 *
 * This screen had no test and no screenshot, and for a reason worth recording:
 * SUBS.sales is assigned to the SUBS object AFTER its literal — it moved there
 * when Customers and Products took the bottom nav — and both the sweep and the
 * camera discovered screens by matching keys INSIDE the literal. So Sales was
 * never rendered by the sweep, never measured by the geometry check, and never
 * photographed. The fake server's fixture for it was wrong in the way that only
 * shows up when you look: it sent `stores` where the route sends `cells`, so
 * every card would have read "No stores", and it listed three of the six
 * channels in GRID_CHANNELS.
 *
 * So the assertions here are mostly about the grid being the server's: every
 * channel it names, the open/closed state per store, and today's money said as
 * today's.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// Six channels: two fully open, one open at one store of two, one with no
// integration at all, one single-store, one shut everywhere. Between them they
// cover every pill this screen can draw.
const GRID = `state.chanTried=true; state.chan={channels:[
  {channel:'mini_app', integrated:true, cardOpen:true,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true},
          {storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',open:true}]},
  {channel:'web', integrated:true, cardOpen:true,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true},
          {storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',open:false}]},
  {channel:'meituan', integrated:true, cardOpen:true,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true}]},
  {channel:'eleme', integrated:false, cardOpen:false, cells:[]},
  {channel:'gzgrocery', integrated:true, single:'tianhe', cardOpen:true,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true}]},
  {channel:'pos', integrated:true, cardOpen:false,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:false},
          {storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',open:false}]}
]};
state.sales={wechat:{connected:true,revenue:2140.5,orders:12},
             web:{connected:true,revenue:612,orders:3},
             meituan:{connected:true,revenue:288,orders:4},
             gzgrocery:{connected:true,revenue:1180,orders:2},
             eleme:{connected:false,revenue:0,orders:0},
             pos:{connected:true,revenue:143,orders:6}};
state.salesSummary={revenue:4363.5,orders:27,aov:161.6,active:5,total:6};
APP.cmd('push','sales');`;

const CASES = [
  ['the board is the server\'s grid', GRID, [
    ['every channel it names is drawn', `['Mini app','Web store','Meituan','Eleme','gzgrocery','In store']
        .every(function(n){return txt('content').includes(n)})`],
    ['open everywhere reads Open',      `txt('content').includes('Open')`],
    ['partly open counts the stores',   `txt('content').includes('Open at 1 of 2')`],
    ['and names the shut one',          `txt('content').includes('closed at Panyu')`],
    ['shut everywhere reads Closed',    `txt('content').includes('Closed')`],
    // A channel with no integration has no open/closed state at all, and used
    // to be given one.
    ['no integration says so, not Closed', `txt('content').includes('Not connected')`],
    ['a mirror says it is read-only',   `txt('content').includes('View only')`],
    ['the head line names what is shut', `txt('content').includes('In store is closed everywhere')`],
    ['closing stays on the desktop',    `txt('content').includes('on desktop')`],
  ]],
  ['today\'s money is said as today\'s', GRID, [
    // The day's total is what this screen is opened for, and loadChannels used
    // to fetch it inside `summary` and throw it away.
    ['the total is in the header band', `txt('content').includes('¥4,364 today · 27 orders')`],
    ['and each channel carries its own', `txt('content').includes('12 today · ¥2,141')`],
    // The old line was a bare number with no window on it, which reads as
    // all-time takings — so every channel that sold anything says "today", and
    // there are five of them.
    ['every selling channel dates its figure',
     `(txt('content').match(/\\btoday\\b/g)||[]).length >= 6`],
  ]],
  ['a shop with no channels', `state.chanTried=true; state.chan={channels:[]}; APP.cmd('push','sales');`, [
    ['says so',        `txt('content').includes('No channels yet')`],
    ['and invents none', `!txt('content').includes('Mini app')`],
  ]],
  ['before the grid lands', `APP.cmd('push','sales');`, [
    ['it says loading, not empty', `txt('content').includes('Loading') && !txt('content').includes('No channels yet')`],
  ]],
];

run('sales', CASES);
