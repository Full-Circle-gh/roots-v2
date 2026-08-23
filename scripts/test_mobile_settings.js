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
  // In the band, lower case, beside the block count — a published page has no
  // card of its own any more.
  ['says published',            `txt('content').includes('3 blocks live · published')`],
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
  // 'Waiting', the same word as the chip that filters to it — the long form ran
  // nearly the card's width and outsized the two names the row is about.
  ['a waiting one is named',    `txt('content').includes('Waiting')`],
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

// ── Operations ────────────────────────────────────────────────────────────
// Two toggles and "deeper config on desktop". Everything the desktop's
// Operations panel exists to answer — is every store located, is the maps key
// working, can customers pay by Alipay — was absent, and those are the
// questions you ask when you are away from your desk.
const OPS = `state.printerTried=true; state.printer={auto_print:true};
  state.fapiaoTried=true; state.fapiao={autoIssue:false};
  state.geoTried=true; state.geo={provider:'amap',tencent_maps_configured:true,
    stores:{total:3,geocoded:2,missing:1}, addresses:{total:180,geocoded:174,missing:6}, last_error:null};
  state.alipayTried=true; state.alipay={enabled:true,account:'Roots Ltd'};
  state.stores=[{id:1,code:'th',name_en:'Tianhe',name_cn:'天河',city:'Guangzhou',district:'Tianhe',lat:23.1,lng:113.3},
                {id:2,code:'yx',name_en:'Yuexiu',name_cn:'越秀',city:'Guangzhou'}];
  APP.cmd('push','operations');`;

CASES.push(['operations answers the away-from-desk questions', OPS, [
  ['can customers pay by Alipay QR', `txt('content').includes('Alipay by QR code')`],
  ['and under whose name',           `txt('content').includes('Roots Ltd')`],
  ['which maps provider',            `txt('content').includes('Amap')`],
  ['stores located',                 `txt('content').includes('2/3')`],
  ['CUSTOMER ADDRESSES located',     `txt('content').includes('174/180')`],
  ['each store is named',            `txt('content').includes('Tianhe') && txt('content').includes('Yuexiu')`],
  ['and the unlocated one is marked', `txt('content').includes('no coordinates')`],
  ['the located one is not alarming', `txt('content').includes('located')`],
]]);

CASES.push(['a maps quota that has run out', `state.printerTried=true; state.printer={auto_print:false};
  state.fapiaoTried=true; state.fapiao={autoIssue:true};
  state.geoTried=true; state.geo={provider:'amap',tencent_maps_configured:true,
    stores:{total:1,geocoded:1,missing:0}, addresses:{total:10,geocoded:4,missing:6},
    last_error:{code:'CUQPS_HAS_EXCEEDED_THE_LIMIT',message:'quota exhausted',quota:true}};
  state.alipayTried=true; state.alipay={enabled:false}; state.stores=[];
  APP.cmd('push','operations');`, [
  // The key is still configured and nothing errors in front of a customer.
  // Every new address just quietly stops being locatable.
  ['it is named',              `txt('content').includes('Maps quota is used up for today')`],
  ['and what it costs',        `txt('content').includes('stop routing to the nearest store')`],
  ['Alipay off reads off',     `txt('content').includes('off')`],
]]);

// ── Pop-ups ───────────────────────────────────────────────────────────────
// The phone printed Live or Off from `enabled` alone — the same mistake the
// coupon list used to make, with the same result: a pop-up scheduled to start
// in December read Live, and one whose end date passed in July read Live too.
// It also dropped everything that says what a pop-up DOES: which pages it
// appears on, how often, and what its button opens. A pop-up is the one thing
// in this app that interrupts a customer.
const POPUPS = `state.cfg=Object.assign({},state.cfg,{popups:{list:[
  {id:'p1',name:'Autumn promo',enabled:true,title_en:'20% off',body_en:'This week only.',
   pages:['home','shop'],frequency:'once',cta_label_en:'Shop now',cta_target:'/pages/shop/index',
   start_at:'2026-08-01',end_at:'2026-12-01'},
  {id:'p2',name:'Old notice',enabled:true,title_en:'Closed for the holiday',
   pages:['all'],frequency:'daily',end_at:'2026-07-01'},
  {id:'p3',name:'Next month',enabled:true,pages:[],frequency:'session',start_at:'2026-12-01'},
  {id:'p4',name:'Paused',enabled:false,pages:['me'],frequency:'every_visit'}
]}}); APP.cmd('push','popups');`;

CASES.push(['pop-up state comes from the dates, not the flag', POPUPS, [
  ['a running one is live',            `txt('content').includes('Live')`],
  // Formatted, and said ONCE. The pill used to carry the raw column and the
  // window line under it repeated the same date, so both halves are asserted.
  ['ONE THAT ENDED IN JULY says ended', `txt('content').includes('Ended Jul 1')`],
  ['ONE THAT STARTS IN DECEMBER says so', `txt('content').includes('Starts Dec 1')`],
  ['and no raw column dates anywhere',   `!/\\d{4}-\\d{2}-\\d{2}/.test(txt('content'))`],
  ['a switched-off one reads off',     `txt('content').includes('Off')`],
  // The count lives in the header band now, phrased for the width it has there.
  ['and only one of the four is counted as interrupting',
   `txt('content').includes('1 showing now · 4 in total')`],
]]);

CASES.push(['what a pop-up actually does', POPUPS, [
  ['the pages it appears on',   `txt('content').includes('Home · Shop')`],
  ['"all pages" is spelled out', `txt('content').includes('All pages')`],
  ['no page picked is called out', `txt('content').includes('No page picked')`],
  ['how often',                 `txt('content').includes('shows once') && txt('content').includes('every visit')`],
  ['what its button opens',     `txt('content').includes('Shop now')`],
  ['the internal name leads',   `txt('content').includes('Autumn promo')`],
]]);

CASES.push(['nothing is interrupting anyone', `state.cfg=Object.assign({},state.cfg,{popups:{list:[]}});
  APP.cmd('push','popups');`, [
  ['says the app is quiet', `txt('content').includes('The app is quiet')`],
  ['invents no pop-up',     `!txt('content').includes('Autumn promo')`],
]]);

// ── Help & Legal ──────────────────────────────────────────────────────────
// Help is stored as TWO arrays — faq.categories and faq.questions, each
// question carrying a `cat` — and the mini app's Help screen groups by them.
// The phone rendered a flat list. Thirty questions flat is a scroll; the same
// thirty under six headings is a page.
const FAQ = `state.cfg=Object.assign({},state.cfg,{faq:{
  categories:[{id:'orders',en:'Orders',cn:'订单'},{id:'delivery',en:'Delivery',cn:'配送'}],
  questions:[
    {id:'q1',cat:'orders',q_en:'Where is my order?',a_en:'Track it in the app.'},
    {id:'q2',cat:'delivery',q_en:'Do you deliver here?',a_en:'Check your postcode.'},
    {id:'q3',cat:'gone',q_en:'Orphan question',a_en:'Still visible to customers.'}]}});
  APP.cmd('push','faq');`;

CASES.push(['help is grouped the way customers see it', FAQ, [
  ['the categories are headings',  `txt('content').includes('Orders') && txt('content').includes('Delivery')`],
  ['questions sit under them',     `txt('content').includes('Where is my order?')`],
  ['in the order the store set',   `txt('content').indexOf('Orders') < txt('content').indexOf('Delivery')`],
  ['a question whose category is gone is NOT hidden',
   `txt('content').includes('Orphan question')`],
  ['it gets a heading that says so', `txt('content').includes('Everything else')`],
]]);

CASES.push(['an answer opens', FAQ + `APP.cmd('faqToggle',0);`, [
  ['the answer is on screen', `txt('content').includes('Track it in the app')`],
  ['and only that one',       `!txt('content').includes('Check your postcode')`],
]]);

CASES.push(['a long legal document says it is clipped',
  `state.cfg=Object.assign({},state.cfg,{legal:{terms:{body_en:'x'.repeat(2000),updated_at:'2026-05-01'},
    privacy:{body_en:'short one',updated_at:'2026-05-01'}}}); state.faqOpen=0; APP.cmd('push','legal');`, [
  // It has always cut at 1200 characters and said nothing, so an operator
  // could read a partial terms document believing it was the whole thing.
  ['it says so',  `txt('content').includes('Clipped here')`],
  ['and where the rest is', `txt('content').includes('on desktop')`],
]]);

CASES.push(['a short one is not marked clipped',
  `state.cfg=Object.assign({},state.cfg,{legal:{terms:{body_en:'short one',updated_at:'2026-05-01'}}});
   state.faqOpen=0; APP.cmd('push','legal');`, [
  ['no clip note', `!txt('content').includes('Clipped here')`],
]]);

// ── The gzgrocery mirror ──────────────────────────────────────────────────
// The daemon infers a pickup from a drop in gzgrocery's stock. A big or
// suspicious drop is CAPPED rather than applied, and waits for a person to say
// whether it was a real sale. The phone read only `recent` — the drops already
// applied automatically — so the answer to "is anything waiting on me" was
// always no. It also never rendered the mode, and "shadow" means the daemon is
// detecting and logging and changing nothing, which makes a list of pickups a
// list of things that did not happen to your shelf.
const GZ = `state.mirror={gzgrocery:[{id:'Oat milk',cust:'SKU OM-1L',total:'×3',when:'Today'}]};
  state.mirrorMode='live'; state.gzSummary={appliedEvents24h:4,appliedUnits24h:11};
  state.gzFlagged=[{id:9,product_id:5,name_en:'Carrots',name_cn:'胡萝卜',product_sku:'CR-01',
    baseline_qty:40,observed_qty:10,drift:-30,inferred_pickup:30,current_qty:38,
    created_at:'2026-08-22 08:00:00'}];
  APP.cmd('push','mirror_gzgrocery');`;

CASES.push(['the queue that was invisible', GZ, [
  ['it says something is waiting',  `txt('content').includes('One drop needs your decision')`],
  ['naming the product',            `txt('content').includes('Carrots')`],
  ['and the numbers behind it',     `txt('content').includes('40 → 10') && txt('content').includes('a drop of 30')`],
  ['and what your own shelf says',  `txt('content').includes('Your shelf says 38')`],
  ['both decisions are offered',
   "[].slice.call(document.querySelectorAll('#content button')).some(function(b){return b.innerText.indexOf('It sold')>=0}) && [].slice.call(document.querySelectorAll('#content button')).some(function(b){return b.innerText.indexOf('Glitch')>=0})"],
  ['the mode is stated',            `txt('content').includes('Live')`],
  ['and the 24h tally',             `txt('content').includes('4 applied · 11 units in 24h')`],
  ['the auto-applied list is still there', `txt('content').includes('Oat milk')`],
]]);

CASES.push(['shadow mode says nothing has changed', `state.mirror={gzgrocery:[]}; state.mirrorMode='shadow';
  state.gzSummary={}; state.gzFlagged=[]; APP.cmd('push','mirror_gzgrocery');`, [
  ['it is named',   `txt('content').includes('Shadow')`],
  ['and explained', `txt('content').includes('nothing here has changed your stock')`],
]]);

CASES.push(['applying says what it does', GZ + `APP.cmd('gzPickup',9,'apply');`, [
  ['it asks',                      `sheetText().includes('Take 30 off the shelf?')`],
  ['naming the fan-out',           `sheetText().includes('every other channel')`],
  ['and when it is the right call', `sheetText().includes('a real sale')`],
  ['nothing sent yet',             `state.gzBusy === null`],
]]);

CASES.push(['ignoring says what it does', GZ + `APP.cmd('gzPickup',9,'ignore');`, [
  ['it asks',                    `sheetText().includes('Leave the stock alone?')`],
  ['and says gzgrocery gets corrected', `sheetText().includes('pushed back to gzgrocery')`],
]]);

// ── What actually goes over the wire ──────────────────────────────────────
// After APP.cmd was found forwarding one argument to a two-argument handler —
// a write that reported success and sent nothing — the claims a screen makes
// about its own writes are worth pinning to the request, not the toast.
const STUB = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u), m:(o&&o.method)||'GET', body:(o&&o.body)||null});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;

CASES.push(['switching a pop-up on stamps updated_at', POPUPS + STUB + `APP.cmd('togglePopup','p4');`, [
  // The mini app keys a dismissal on `popup_seen:<id>:<updated_at>`. Without
  // the bump, switching one back on shows it to nobody who already dismissed
  // it — the switch looks like it worked and reaches almost no one.
  ['a PUT went to /config',   `window.__sent.some(function(r){return r.u.indexOf('/config')>=0 && r.m==='PUT'})`],
  ['carrying the whole list', `window.__sent.some(function(r){return (r.body||'').indexOf('popups.list')>=0})`],
  ['with that pop-up now on', `window.__sent.some(function(r){ var b=r.body||''; var i=b.indexOf('"id":"p4"'); return i>=0 && b.slice(i,i+300).indexOf('"enabled":true')>=0; })`],
  ['and its updated_at stamped', `window.__sent.some(function(r){ var b=r.body||''; var i=b.indexOf('"id":"p4"'); return i>=0 && b.slice(i,i+300).indexOf('"updated_at"')>=0; })`],
  ['leaving the others alone',   `window.__sent.some(function(r){ var b=r.body||''; var i=b.indexOf('"id":"p1"'); return i>=0 && b.slice(i,i+300).indexOf('"updated_at"')<0; })`],
]]);

CASES.push(['applying a flagged pickup posts to apply, not ignore', GZ + STUB + `APP.cmd('gzPickup',9,'apply'); APP.cmd('askRun','');`, [
  ['it posts',            `window.__sent.some(function(r){return r.u.indexOf('/guanyi/pickups/9/apply')>=0})`],
  ['and never to ignore', `!window.__sent.some(function(r){return r.u.indexOf('/ignore')>=0})`],
]]);

CASES.push(['ignoring posts to ignore', GZ + STUB + `APP.cmd('gzPickup',9,'ignore'); APP.cmd('askRun','');`, [
  ['it posts',           `window.__sent.some(function(r){return r.u.indexOf('/guanyi/pickups/9/ignore')>=0})`],
  ['and never to apply', `!window.__sent.some(function(r){return r.u.indexOf('/apply')>=0})`],
]]);

// ── The Meituan mirror's health ───────────────────────────────────────────
// The state worth naming is a STUCK stock queue. A queue mid-drain clears in
// seconds, so "107 sending…" and "107 stuck for 19 hours" are the same number
// on screen unless something looks at how long the oldest push has waited. The
// desktop's own comment records a 19-hour stock freeze presenting as a normal
// tile. The phone showed no queue state at all.
CASES.push(['a stuck stock queue', `state.mirror={meituan:[{id:'MT-1',cust:'Li',total:'¥88',when:'Today',store:'Tianhe'}]};
  state.mtStatusTried=true; state.mtStatus={queuePending:107,queueFailed:0,queueOldestMin:1140,
    mappedCount:212,lastOrder:[{imported_at:'2026-08-22 09:00:00',store_code:'tianhe'}]};
  APP.cmd('push','mirror_meituan');`, [
  ['it says stuck, not sending', `txt('content').includes('stuck for 19 h')`],
  ['and what that means',        `txt('content').includes('out of date')`],
  ['never "sending…"',           `!txt('content').includes('sending…')`],
  ['the order list is still there', `txt('content').includes('MT-1')`],
]]);

CASES.push(['a queue that is merely busy', `state.mirror={meituan:[]}; state.mtStatusTried=true;
  state.mtStatus={queuePending:12,queueFailed:0,queueOldestMin:2,mappedCount:212,lastOrder:[]};
  APP.cmd('push','mirror_meituan');`, [
  ['reads as sending', `txt('content').includes('12 sending…')`],
  ['not as stuck',     `!txt('content').includes('stuck')`],
]]);

CASES.push(['failed pushes', `state.mirror={meituan:[]}; state.mtStatusTried=true;
  state.mtStatus={queuePending:0,queueFailed:5,queueOldestMin:0,mappedCount:212,lastOrder:[]};
  APP.cmd('push','mirror_meituan');`, [
  ['are counted, and scoped to the last day', `txt('content').includes('5 stock pushes failed in the last day')`],
]]);

CASES.push(['a healthy channel', `state.mirror={meituan:[]}; state.mtStatusTried=true;
  state.mtStatus={queuePending:0,queueFailed:0,queueOldestMin:0,mappedCount:212,
    lastOrder:[{imported_at:'2026-08-22 09:00:00'}]};
  APP.cmd('push','mirror_meituan');`, [
  ['says everything is sent', `txt('content').includes('All stock pushes sent')`],
  ['when the last order came', `txt('content').includes('Last order')`],
  ['and how many products sync', `txt('content').includes('212 products synced')`],
]]);

CASES.push(['the sync service is offline', `state.mirror={meituan:null}; state.mtStatusTried=true;
  state.mtOffline=true; APP.cmd('push','mirror_meituan');`, [
  // The answer to "why has nothing come in".
  ['it says so',       `txt('content').includes('sync service is offline')`],
  ['and what stopped', `txt('content').includes('not being imported')`],
]]);

// ── Share cards ───────────────────────────────────────────────────────────
// The phone said these are made on desktop and stopped — true, and the fake
// share counts it used to show deserved deleting. But designing a card and
// CHECKING one are different jobs, and "did the invite card ever get set" is a
// question with a picture for an answer.
CASES.push(['which pages carry a card', `state.scTried=true;
  state.scAff={shareImage:'/api/retail-admin/media/4',shareTitle:{en:'Join me on Roots'}};
  state.cfg=Object.assign({},state.cfg,{sharing:{home:'/api/retail-admin/media/1',
    homeTitle:{en:'Roots — plant-based grocery'}}});
  APP.cmd('push','sharecards');`, [
  ['all four pages are listed',   `txt('content').includes('Home page') && txt('content').includes('Product page') && txt('content').includes('Voting page') && txt('content').includes('Invite card')`],
  ['the ones with a picture say Set', `txt('content').includes('Set')`],
  ['the ones without say Default',    `txt('content').includes('Default')`],
  ['counted at the top',              `txt('content').includes('2 of 4 pages')`],
  ['the titles are shown',            `txt('content').includes('Roots — plant-based grocery') && txt('content').includes('Join me on Roots')`],
  ['a titled page with no title says who titles it', `txt('content').includes('the page titles itself')`],
  ['the pictures are there to look at',
   "document.querySelectorAll(\"#content a[href^='/api/retail-admin/media/']\").length === 2"],
]]);

CASES.push(['nothing set at all', `state.scTried=true; state.scAff={};
  state.cfg=Object.assign({},state.cfg,{sharing:{}}); APP.cmd('push','sharecards');`, [
  ['says none of them',  `txt('content').includes('0 of 4 pages')`],
  ['and invents no counts', `!/\\d+ shares/.test(txt('content'))`],
]]);

run('operator screens', CASES);
