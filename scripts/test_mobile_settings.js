#!/usr/bin/env node
/**
 * Settings, the Setup guide and Social proof — asserted against
 * 02-settings-ops.js, 17-setup-guide.js and lib/features.js.
 *
 *   node scripts/test_mobile_settings.js
 *
 * Settings offered five feature switches. The desktop has eight. The three
 * missing ones were socialProof, quickStock and kitchenAdd — switches that
 * decide whether shoppers see bought-counts, whether shop staff can open the
 * phone stock app, and whether kitchen staff can log what they just made. None
 * of them could be reached from a phone at all. The phone also had no notion
 * of the platform ENTITLEMENT ceiling, so it would have drawn a switch for a
 * feature the tenant is not entitled to and written a preference nobody would
 * ever honour.
 *
 * The Setup guide had three controls that did nothing — every step row was a
 * button with a chevron wired to noop, and so was "Continue setup" — and it
 * flattened /setup's two lists into one, so the two OPTIONAL steps counted
 * against progress the server computes from the five required ones. It threw
 * away every per-step detail the endpoint returns: how many stores, how many
 * products, which payment method, delivery or pickup.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const SETUP = `state.setup={percent:60,requiredDone:3,requiredTotal:5,allDone:false,
  steps:[{key:'store',done:true,count:2},{key:'products',done:true,count:128},
         {key:'payment',done:true,method:'both'},{key:'fulfillment',done:false,delivery:false,pickup:false},
         {key:'open',done:false}],
  optional:[{key:'wechat',done:false},{key:'brand',done:true}]};
  APP.cmd('push','setup');`;

const btnTexts = "[].slice.call(document.querySelectorAll('#content button')).map(function(b){return b.innerText.trim()})";

const CASES = [
  ['every feature switch the desktop has', `APP.cmd('push','settings');`, [
    ['membership',   `txt('content').includes('Membership & points')`],
    ['referrals, by the desktop\'s name', `txt('content').includes('Referral program')`],
    ['reviews',      `txt('content').includes('Product reviews')`],
    ['feedback',     `txt('content').includes('Customer feedback')`],
    ['SOCIAL PROOF — was missing', `txt('content').includes('Social proof')`],
    ['help / FAQ',   `txt('content').includes('Help / FAQ')`],
    ['QUICK STOCK — was missing',  `txt('content').includes('Quick Stock')`],
    ['ADD STOCK — was missing',    `txt('content').includes('Add Stock')`],
  ]],
  ['the entitlement ceiling is honoured', `state.ent={socialProof:false,kitchenAdd:false}; APP.cmd('push','settings');`, [
    ['a feature the tenant cannot have carries no switch', `!txt('content').includes('Social proof')`],
    ['nor does the other one',                             `!txt('content').includes('Add Stock')`],
    ['the entitled ones are still there',                  `txt('content').includes('Quick Stock') && txt('content').includes('Product reviews')`],
  ]],
  ['a switched-off feature says what it costs',
   `state.cfg=Object.assign({},state.cfg,{features:{quickStock:false}}); APP.cmd('push','settings');`, [
    ['the consequence is spelled out', `txt('content').includes('staff open /stock and get a closed screen')`],
    ['and only for the off one',       `!txt('content').includes('no tiers and no points')`],
  ]],
  ['no dead chevrons in Settings', `APP.cmd('push','settings');`, [
    // Every row that shows a chevron must go somewhere. "Store profile" used to
    // draw one and do nothing at all.
    ['store profile says where it is edited', `txt('content').includes('on desktop')`],
    ['sign out is offered',                   `${btnTexts}.some(function(t){return t==='Sign out'})`],
  ]],
  ['the setup guide reports', SETUP, [
    ['progress is the server\'s',      `txt('content').includes('60%')`],
    ['and counts required steps only', `txt('content').includes('2 left')`],
    ['the next step is called out',    `txt('content').includes('Next: Set up delivery or pickup')`],
    ['how many stores',                `txt('content').includes('2 stores')`],
    ['how many products',              `txt('content').includes('128 products')`],
    ['which payment methods',          `txt('content').includes('WeChat Pay and Alipay')`],
    ['optional steps are separated',   `txt('content').includes('Optional')`],
    ['and said not to gate opening',   `txt('content').includes('do not gate opening')`],
    ['where the work happens',         `txt('content').includes('wizard on desktop')`],
  ]],
  ['and offers nothing it cannot do', SETUP, [
    // Three controls used to sit here wired to noop: every step row, and a
    // "Continue setup" call to action.
    ['no Continue setup button', `!${btnTexts}.some(function(t){return t.indexOf('Continue setup')>=0})`],
    ['no buttons at all in the step list',
     "document.querySelectorAll('#content .list button').length === 0"],
  ]],
  ['a finished setup', `state.setup={percent:100,requiredDone:5,requiredTotal:5,allDone:true,
     steps:[{key:'store',done:true,count:2},{key:'products',done:true,count:9},{key:'payment',done:true,method:'alipay'},
            {key:'fulfillment',done:true,pickup:true},{key:'open',done:true}],optional:[]};
     APP.cmd('push','setup');`, [
    ['says the store is open',   `txt('content').includes('Your store is open')`],
    ['no "left" count',          `!txt('content').includes('left')`],
    ['no next step',             `!txt('content').includes('Next:')`],
    ['pickup-only is named',     `txt('content').includes('Pickup only')`],
  ]],
  ['social proof states what it is doing', `APP.cmd('push','social');`, [
    ['on, and what shoppers see', `txt('content').includes('Showing recent buyers') && txt('content').includes('SOLD badge')`],
  ]],
  ['social proof switched off', `state.cfg=Object.assign({},state.cfg,{features:{socialProof:false}}); APP.cmd('push','social');`, [
    ['says it is off',            `txt('content').includes('Switched off')`],
    ['and what is not shown',     `txt('content').includes('are shown')`],
  ]],
];

// ── Delivery ──────────────────────────────────────────────────────────────
// The phone said "Delivery zones · 7" and stopped. A bare count is the one
// number on that screen that cannot go wrong, and it hides the one that can: a
// zone switched OFF does not match addresses, so a customer inside it is told
// you do not deliver there. Holiday mode — the switch that stops delivery
// altogether and puts a message in front of every shopper — was not on the
// phone at all.
const ZONES = `state.zones=[
  {id:1,is_active:1,zone_type:'gz_district',province_cn:'广东省',same_day_allowed:1},
  {id:2,is_active:1,zone_type:'gz_district',province_cn:'广东省',same_day_surcharge:5},
  {id:3,is_active:1,zone_type:'city',province_cn:'江苏省'},
  {id:4,is_active:0,zone_type:'city',province_cn:'浙江省'},
  {id:5,is_active:0,zone_type:'city',province_cn:'福建省'}];
  state.geoTried=true; state.geo={stores:{total:3,geocoded:2,missing:1},tencent_maps_configured:true};
  state.printerTried=true; state.printer={auto_print:true};`;

CASES.push(['delivery facts', ZONES + `APP.cmd('push','delivery');`, [
  ['live zones, not a bare total',   `txt('content').includes('3 live')`],
  ['provinces covered',              `txt('content').includes('Provinces covered')`],
  ['same-day districts are counted', `txt('content').includes('Same-day districts')`],
  ['stores located',                 `txt('content').includes('2 of 3')`],
  ['a store with no coordinates is called out', `txt('content').includes('never be the nearest one')`],
  ['SWITCHED-OFF ZONES are called out',
   `txt('content').includes('2 zones are switched off')`],
  ['with what it costs the customer',
   `txt('content').includes('told you do not deliver there')`],
]]);

CASES.push(['no zones switched off', `state.zones=[{id:1,is_active:1,zone_type:'city',province_cn:'广东省'}];
  state.geoTried=true; state.geo={stores:{total:1,geocoded:1,missing:0}};
  state.printerTried=true; state.printer={auto_print:true}; APP.cmd('push','delivery');`, [
  ['no warning',       `!txt('content').includes('switched off')`],
  ['and no geocoding warning either', `!txt('content').includes('never be the nearest one')`],
]]);

CASES.push(['holiday mode', `state.cfg=Object.assign({},state.cfg,{delivery:{holidayMode:true,
    holidayMessage:{en:'Closed for Mid-Autumn, back Thursday.'},sameDayCutoffMinutes:20}});
  state.zones=[]; state.geoTried=true; state.geo={stores:{total:1,geocoded:1,missing:0}};
  state.printerTried=true; state.printer={auto_print:false}; APP.cmd('push','delivery');`, [
  ['it is impossible to miss',   `txt('content').includes('Holiday mode is on')`],
  ['and says delivery is paused', `txt('content').includes('delivery is paused')`],
  ['and quotes what shoppers are told', `txt('content').includes('Closed for Mid-Autumn')`],
  ['the cut-off is stated',      `txt('content').includes('20 min before close')`],
]]);

CASES.push(['holiday mode off', ZONES + `APP.cmd('push','delivery');`, [
  ['says so quietly, as a fact',  `txt('content').includes('Holiday mode')`],
  ['with no alarm',               `!txt('content').includes('delivery is paused')`],
]]);

run('settings', CASES);
