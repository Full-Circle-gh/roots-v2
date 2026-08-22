#!/usr/bin/env node
/**
 * The operator's own screens — Settings, the Setup guide, Social proof,
 * Delivery and the Editor — asserted against 02-settings-ops.js,
 * 17-setup-guide.js, 06-delivery.js, cms.html and lib/features.js.
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

// ── Editor ────────────────────────────────────────────────────────────────
// This screen was a drawing: a grey wireframe of a page, a hard-coded
// "Published" pill, and four section names typed into the source — Hero
// banner, Featured products, Categories, Flash sale strip — which a shop may
// or may not have, in that or any other order. It told an operator their home
// page was published without asking anything.
const LAYOUT = `state.cmsTried={home:true}; state.cms={home:{page:'home', dirty:false,
  live:[{id:'a',type:'hero_banner',title_en:'Autumn drop',title_cn:'秋季上新'},
        {id:'b',type:'product_grid'},
        {id:'c',type:'flash_sale_strip'}],
  draft:[{id:'a',type:'hero_banner'},{id:'b',type:'product_grid'},{id:'c',type:'flash_sale_strip'}]}};
  APP.cmd('push','editor');`;

CASES.push(['the real layout', LAYOUT, [
  ['blocks are the server\'s',      `txt('content').includes('Hero banner')`],
  ['by the composer\'s own names',  `txt('content').includes('Product grid') && txt('content').includes('Flash sale')`],
  ['in order, numbered',            `txt('content').indexOf('Hero banner') < txt('content').indexOf('Flash sale')`],
  ['counted',                       `txt('content').includes('3 blocks live')`],
  ['a title the operator wrote is shown', `txt('content').includes('Autumn drop')`],
  ['no invented section survives',  `!txt('content').includes('Featured products')`],
  ['and the other CMS pages are reachable', `txt('content').includes('Promotions') && txt('content').includes('Onboarding')`],
]]);

CASES.push(['published, and it means it', LAYOUT, [
  ['says published',            `txt('content').includes('Published')`],
  ['with no draft warning',     `!txt('content').includes('Unpublished')`],
]]);

CASES.push(['a draft nobody published', `state.cmsTried={home:true};
  state.cms={home:{page:'home',dirty:true,
    live:[{id:'a',type:'hero_banner'}],
    draft:[{id:'a',type:'hero_banner'},{id:'b',type:'coupon_block'}]}};
  APP.cmd('push','editor');`, [
  // The old screen said "Published" unconditionally, which is exactly wrong
  // here: someone's edits are sitting unpublished and nobody would know.
  ['it says so',                    `txt('content').includes('Unpublished changes')`],
  ['and what does not match',       `txt('content').includes('does not match what shoppers see')`],
  ['naming both counts',            `txt('content').includes('2 blocks in the draft, 1 live')`],
  ['it does not claim published',   `!/\bPublished\b/.test(txt('content'))`],
]]);

CASES.push(['a page with nothing on it', `state.cmsTried={home:true};
  state.cms={home:{page:'home',dirty:false,live:[],draft:[]}}; APP.cmd('push','editor');`, [
  ['says so',       `txt('content').includes('Nothing is published on this page yet')`],
  ['invents none',  `!txt('content').includes('Hero banner')`],
]]);

// ── Affiliate ─────────────────────────────────────────────────────────────
// The phone asked for the referral summary with pageSize=1 — the smallest page
// the endpoint allows — read the summary off the envelope and threw the rows
// away. Three numbers, and no way to see a single referral: not who referred
// whom, not which code, not what was paid, and not the row an operator would
// go looking for — the friend who joined and has not ordered.
const AFF = `state.affiliateTried=true;
  state.affiliate={total:24,converted:9,paid_out:180,lifetime_paid:42.5,still_earning:6,
    joined_this_month:5,joined_last_month:3};
  state.affRows=[
   {id:1,referrer_id:1,invitee_id:2,referrer_nickname:'Chen',invitee_nickname:'Ling',
    invitee_phone:'138****1',code_used:'CHEN24',status:'ordered',reward_amount:20,
    first_paid_order_id:412,joined_at:'2026-08-01 10:00:00',lifetime_active:1},
   {id:2,referrer_id:1,invitee_id:3,referrer_nickname:'Chen',invitee_nickname:'Wu',
    code_used:'CHEN24',status:'joined',reward_amount:0,joined_at:'2026-08-18 10:00:00'},
   {id:3,referrer_id:4,invitee_id:5,referrer_nickname:'Sarah',invitee_nickname:'Mo',
    code_used:'SAR7',status:'void',voided_reason:'duplicate account',reward_amount:0,
    joined_at:'2026-07-02 10:00:00'}];
  APP.cmd('push','affiliate');`;

CASES.push(['the referral ledger', AFF, [
  ['THE ROWS EXIST',            `txt('content').includes('Chen') && txt('content').includes('Ling')`],
  ['referrer → friend',         `txt('content').includes('→')`],
  ['the code used',             `txt('content').includes('CHEN24')`],
  ['the reward paid',           `txt('content').includes('¥20')`],
  ['a converted one says so',   `txt('content').includes('first order #412')`],
  ['a waiting one is named',    `txt('content').includes('Waiting for first order')`],
  ['still earning is its own state', `txt('content').includes('Still earning')`],
  ['a voided one gives the reason',  `txt('content').includes('duplicate account')`],
]]);

CASES.push(['the four figures', AFF, [
  ['friends joined',            `txt('content').includes('Friends joined')`],
  ['against last month',        `txt('content').includes('+2 vs last month')`],
  ['first orders and the rate', `txt('content').includes('38% converted')`],
  ['rewards including lifetime share', `txt('content').includes('incl. ¥43 lifetime')`],
  ['still earning is counted',  `txt('content').includes('within lifetime window')`],
]]);

CASES.push(['nothing referred yet', `state.affiliateTried=true;
  state.affiliate={total:0,converted:0,paid_out:0}; state.affRows=[]; APP.cmd('push','affiliate');`, [
  ['says so',                    `txt('content').includes('No referrals yet')`],
  ['and explains what fills it', `txt('content').includes('shares their code')`],
  ['no invented rows',           `!txt('content').includes('Chen')`],
]]);

run('operator screens', CASES);
