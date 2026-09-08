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
const { inlineTdDatetime } = require('./lib/m-probe');

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

// One row of each shape, for the cases that need a record to open. The app used
// to ship these as sample data inside DB; it no longer does — an empty DB is
// the point — so the rows a test needs are the test's own.
const ROWS = `
  DB.orders=[{id:'RT-…047', ch:'miniapp', cust:['Chen Meiling','陈美玲'], total:'¥312',
    placed:'2:22 PM', status:['Paid','已付款'], kind:'paid', isNew:true,
    ship:['Guangzhou · Tianhe','广州 · 天河区'], deliv:{text:'Ship by 6:00 PM',tone:'amber'},
    phone:'138****2841', addr:['Tianhe, Guangzhou','广州市天河区'], pay:['WeChat Pay','微信支付'],
    txn:'42000••••8831', fulfil:['Tianhe store','天河店'], route:['Nearest store','最近门店'],
    trk:null, items:[[1,'Organic carrots 500g','¥18'],[2,'Oat milk 1L','¥64']],
    breakdown:[['Subtotal','¥300'],['Delivery','¥12']]}];
  DB.products=[
    {name:['Organic carrots','有机胡萝卜'], sku:'SKU 10231 · 500g', price:'¥18', stock:42,
     stockLabel:['42 in stock','库存 42'], status:['Live','在售'], kind:'on'},
    {name:['Oat milk 1L','燕麦奶 1L'], sku:'SKU 10188', price:'¥32', stock:8,
     stockLabel:['8 left','剩 8'], status:['Low','库存低'], kind:'restock'}];
  DB.reviews=[{cust:['Chen Meiling','陈美玲'], rating:'5.0', status:['New','新'], kind:'success',
    text:['Fast delivery.','配送很快。'], time:['2h ago','2 小时前']}];
  DB.customers=[{id:'s1', name:'Chen Meiling', phone:'138****2841', tier:'tree', orders:24,
    spend:6240, seen:'2026-07-29 09:40:00'}];
`;

// Enough server-shaped state that screens which read live data render their real
// branch rather than their loading one. Deliberately minimal: a screen that
// needs more than this to paint is a screen that will break on a slow network.
// Real sentences, not single letters. This block used to seed 'K', 'M', 'A',
// 'F', 'Q' — enough for a sweep that only asks whether a screen paints, and it
// is shared with scripts/shoot_mobile.js, where it overwrote the fake server's
// config and left every screenshot of About, FAQ, Legal and Pop-ups showing a
// column of single characters. A fixture that renders as nonsense makes the
// screen look broken to the only check that can see it.
const SEED = `
  state.cfg={faq:{questions:[{q_en:'Where is my order?',q_cn:'我的订单到哪了？',
      a_en:'Every order gets a tracking link the moment it leaves the store.',a_cn:'订单出库时会收到物流链接。',group_en:'Orders',group_cn:'订单'}]},
    legal:{terms:{body_en:'These terms cover everything you buy from Roots, in store and in the mini app.',updated_at:'2026-05-01'},
           privacy:{body_en:'We keep your phone number and your addresses, and nothing else you have not given us.',updated_at:'2026-05-01'}},
    popups:{list:[{name:'Autumn promo',title_en:'20% off',body_en:'This week only.',enabled:true,pages:['home'],frequency:'once',start_at:'2026-08-18'}]},
    about:{content:{kicker_en:'Our story',kicker_cn:'我们的故事',
      manifesto_en:'We started with one shelf of ferments and a very small van.',manifesto_cn:'我们从一架发酵食品和一辆小货车开始。',
      founder_kicker_en:'Who runs it',founder_kicker_cn:'主理人',
      founder_name_en:'Mei Chen',founder_name_cn:'陈玫',
      founder_title_en:'Founder',founder_title_cn:'创始人',
      founder_quote_en:'Good food should not be a special occasion.',founder_quote_cn:'好食物不该只在特别的日子。'}}};
  state.setup={percent:71,requiredDone:5,requiredTotal:7,steps:[{key:'store',done:true},{key:'wechat',done:false}]};
  state.zones=[1,2,3]; state.printer={auto_print:true};
  state.stores=[{id:1,name_en:'Tianhe store',name_cn:'天河店'},{id:2,name_en:'Panyu store',name_cn:'番禺店'}];
`;

function buildCases(src) {
  // Two patterns, because SUBS is written two ways: most screens are keys of
  // the object literal, and two — inbox and sales — are assigned to it
  // afterwards, when they left the bottom nav. Matching only the literal meant
  // SALES had never been rendered by this sweep, measured by the geometry
  // check, or photographed. A screen nothing visits is a screen nobody knows
  // is broken.
  const subs = [
    ...[...src.matchAll(/\n {2}([a-z_0-9]+):\{title:/g)].map((m) => m[1]),
    ...[...src.matchAll(/\nSUBS\.([a-z_0-9]+)\s*=\s*\{title:/g)].map((m) => m[1]),
  ];
  const cases = {};
  for (const t of ['home', 'orders', 'customers', 'products', 'more']) cases['tab:' + t] = `APP.cmd('tab','${t}')`;
  for (const k of subs) cases['push:' + k] = `APP.cmd('push','${k}')`;
  Object.assign(cases, {
    'sheet:order': "" + ROWS + "DB.orders[0]._id=1;DB.orders[0].raw='paid';state.liveOrders=DB.orders;APP.cmd('tab','orders');APP.cmd('openOrder',DB.orders[0].id)",
    'sheet:order-actions': "" + ROWS + "DB.orders[0]._id=1;DB.orders[0].raw='dispatched';state.liveOrders=DB.orders;APP.cmd('openOrder',DB.orders[0].id);APP.cmd('detailActions')",
    'sheet:customer': "" + ROWS + "state.customers=DB.customers.slice();state.custLoaded=true;APP.cmd('tab','customers');state.custId='s1';state.custDetail={customer:{nickname:'A',tier_key:'tree'},stats:{orders:{}}};render()",
    'sheet:product-supplier': "state.prodStock[9]=[];state.prodStockReady=true;DB.products=[{sku:'SD-1',_id:9,name:['Supplier item','直发商品'],price:'¥20',priceNum:20,status:['Live','在售'],kind:'on',stock:0,stockLabel:['0 in stock','库存 0'],supplier:true,paused:false}];APP.cmd('tab','products');state.productSku='SD-1';render()",
    'sheet:product-paused': "state.prodStock[10]=[];state.prodStockReady=true;DB.products=[{sku:'SD-2',_id:10,name:['Paused item','暂停商品'],price:'¥20',priceNum:20,status:['Paused','已暂停'],kind:'off',stock:0,stockLabel:['0 in stock','库存 0'],supplier:true,paused:true}];APP.cmd('tab','products');state.productSku='SD-2';render()",
    'sheet:product-bundle': "state.prodStock[11]=[];state.prodStockReady=true;DB.products=[{sku:'BD-1',_id:11,name:['Gift box','礼盒'],price:'¥99',priceNum:99,status:['Live','在售'],kind:'on',stock:4,stockLabel:['4 in stock','库存 4'],bundle:true}];APP.cmd('tab','products');state.productSku='BD-1';render()",
    // A VARIANT FAMILY, which is the only screen in this gallery whose sheet
    // carries a chip row. §67: the sheet edits the whole family, so the row has
    // to fit at 390px with a size label long enough to be realistic.
    'sheet:product-sizes': "DB.products=[{sku:'RM-X1',_id:21,gid:101,vLabel:'X1',vSort:0,name:['Raspberry Mango Sorbet','树莓芒果雪葩'],price:'¥40',priceNum:40,status:['Live','在售'],kind:'on',stock:9,stockLabel:['9 in stock','库存 9']},{sku:'RM-X5',_id:22,gid:101,vLabel:'X5',vSort:1,name:['Raspberry Mango Sorbet','树莓芒果雪葩'],price:'¥132',priceNum:132,status:['Live','在售'],kind:'on',stock:9,stockLabel:['9 in stock','库存 9']},{sku:'RM-X10 家庭装',_id:23,gid:101,vLabel:'X10 家庭装',vSort:2,name:['Raspberry Mango Sorbet','树莓芒果雪葩'],price:'¥240',priceNum:240,status:['Live','在售'],kind:'on',stock:9,stockLabel:['9 in stock','库存 9']}];state.prodStock[21]=[{id:1,name_en:'Tianhe store',name_cn:'天河店',qty:8},{id:2,name_en:'Yuexiu store',name_cn:'越秀店',qty:0}];state.prodStockReady=true;APP.cmd('tab','products');state.productSku='RM-X1';render()",
    'sheet:product': "" + ROWS + "DB.products[1]._id=42;state.prodStock[42]=[{id:1,name_en:'Tianhe store',name_cn:'天河店',qty:8}];state.prodStockReady=true;APP.cmd('tab','products');state.productSku=DB.products[1].sku;render()",
    'sheet:reply': "" + ROWS + "DB.reviews[0].id=7;DB.reviews[0].stream='review';APP.cmd('push','inbox');APP.cmd('openReply',DB.reviews[0].cust[0])",
    // The feedback half of the inbox, and the thread sheet in all three of its
    // states — the fetch in flight, the conversation on screen, and the fetch
    // that failed. A thread that renders only when the network is kind is a
    // thread that renders nowhere.
    'push:inbox-feedback': "state.inboxSeg='feedback';APP.cmd('push','inbox')",
    'sheet:thread-loading': "state.inboxSeg='feedback';APP.cmd('push','inbox');APP.cmd('openReply','fb:1')",
    'sheet:thread': "state.inboxSeg='feedback';APP.cmd('push','inbox');APP.cmd('openReply','fb:1');state.thread={id:1,loading:false,err:null,page:'checkout',appVersion:'2.4.1',photos:['/x.png'],msgs:[{id:0,author:'customer',body:'Pickup time is wrong.',created_at:'2026-08-19 10:02:00'},{id:1,author:'admin',author_name:'Mei',body:'Looking at it now.',created_at:'2026-08-19 10:40:00'},{id:2,author:'customer',body:'Still doing it.',created_at:'2026-08-22 09:10:00'}]};render()",
    'sheet:thread-error': "state.inboxSeg='feedback';APP.cmd('push','inbox');APP.cmd('openReply','fb:1');state.thread={id:1,loading:false,err:E('Could not load the conversation.','\u65e0\u6cd5\u52a0\u8f7d\u5bf9\u8bdd\u3002'),msgs:null};render()",
    'sheet:search': "APP.cmd('openSearch')",
    // The Quick actions picker, in both states that lay out differently: room
    // for more, and the six-row ceiling with every add row dimmed.
    'sheet:quick': "APP.cmd('tab','home');APP.cmd('quickEdit')",
    'sheet:quick-full': "state.quick=['inbox','purchasing','tab:products','waste','delivery','invoices'];APP.cmd('tab','home');APP.cmd('quickEdit')",
    // The two writes the phone gained: one store on one channel, and coming
    // back from holiday mode. Both render their confirm as well as their sheet.
    'sheet:channel': "APP.cmd('push','sales');state.chanTried=true;state.chan={channels:[{channel:'meituan',integrated:true,cardOpen:true,cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true},{storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',open:false}]}]};render();APP.cmd('openChannel','meituan')",
    'sheet:channel-ask': "APP.cmd('push','sales');state.chanTried=true;state.chan={channels:[{channel:'meituan',integrated:true,cardOpen:true,cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true}]}]};render();APP.cmd('openChannel','meituan');APP.cmd('chanCell','meituan','tianhe',0)",
    'push:delivery-resume': "state.cfg=Object.assign({},state.cfg,{delivery:{holidayMode:true,holidayMessage:{en:'Closed for Mid-Autumn, back Thursday.',cn:'中秋歇业，周四回来。'}}});state.zones=[];state.geoTried=true;state.geo={stores:{total:1,geocoded:1,missing:0}};state.printerTried=true;state.printer={auto_print:false};APP.cmd('push','delivery')",
    // Purchasing reads a live ledger, so the sweep seeds one — otherwise every
    // pass renders the loading state and proves nothing about the rows.
    'push:purchasing-rows': "state.posTried=true;state.poList=[{id:4,po_number:'RPO-0004',supplier:'Fresh Co.',store_name_en:'Tianhe',date:'2026-08-14',delivery_date:'2026-08-16',status:'Ordered',line_count:6,received_lines:0,total_cost:3240},{id:5,po_number:'RPO-0005',supplier:'Oat Works',date:'2026-08-20',delivery_date:'2026-08-30',status:'Delivered',line_count:3,received_lines:3,total_cost:1880}];APP.cmd('push','purchasing')",
    'tab:orders-failed': "state.ordersLoadErr='Could not load orders.';state.ordersView=null;state.ordersLoading=false;APP.cmd('tab','orders')",
    'tab:customers-failed': "state.custLoadErr='Could not load customers.';state.customers=[];state.custLoaded=true;state.custLoading=false;APP.cmd('tab','customers')",
    'push:sharecards': "state.scTried=true;state.scAff={shareImage:'/api/retail-admin/media/4',shareTitle:{en:'Join me on Roots'}};state.cfg=Object.assign({},state.cfg,{sharing:{home:'/api/retail-admin/media/1',homeTitle:{en:'Roots — plant-based grocery'}}});APP.cmd('push','sharecards')",
    'push:sharecards-bare': "state.scTried=true;state.scAff={};state.cfg=Object.assign({},state.cfg,{sharing:{}});APP.cmd('push','sharecards')",
    'push:mt-stuck': "state.mirror={meituan:[{id:'MT-1',cust:'Li',total:'¥88',when:'Today',store:'Tianhe'}]};state.mtStatusTried=true;state.mtStatus={queuePending:107,queueFailed:0,queueOldestMin:1140,mappedCount:212,lastOrder:[{imported_at:'2026-08-22 09:00:00',store_code:'tianhe'}]};APP.cmd('push','mirror_meituan')",
    'push:mt-ok': "state.mirror={meituan:[]};state.mtStatusTried=true;state.mtStatus={queuePending:0,queueFailed:0,queueOldestMin:0,mappedCount:212,lastOrder:[]};APP.cmd('push','mirror_meituan')",
    'push:mt-offline': "state.mirror={meituan:null};state.mtStatusTried=true;state.mtOffline=true;APP.cmd('push','mirror_meituan')",
    'push:gz-flagged': "state.mirror={gzgrocery:[{id:'Oat milk',cust:'SKU OM-1L',total:'×3',when:'Today'}]};state.mirrorMode='live';state.gzSummary={appliedEvents24h:4,appliedUnits24h:11};state.gzFlagged=[{id:9,product_id:5,name_en:'Carrots',product_sku:'CR-01',baseline_qty:40,observed_qty:10,drift:-30,inferred_pickup:30,current_qty:38,created_at:'2026-08-22 08:00:00'}];APP.cmd('push','mirror_gzgrocery')",
    'push:gz-shadow': "state.mirror={gzgrocery:[]};state.mirrorMode='shadow';state.gzSummary={};state.gzFlagged=[];APP.cmd('push','mirror_gzgrocery')",
    'sheet:gz-apply': "state.mirror={gzgrocery:[]};state.mirrorMode='live';state.gzFlagged=[{id:9,product_id:5,name_en:'Carrots',baseline_qty:40,observed_qty:10,drift:-30,inferred_pickup:30,current_qty:38}];APP.cmd('push','mirror_gzgrocery');APP.cmd('gzPickup',9,'apply')",
    'sheet:gz-ignore': "state.mirror={gzgrocery:[]};state.mirrorMode='live';state.gzFlagged=[{id:9,product_id:5,name_en:'Carrots',baseline_qty:40,observed_qty:10,drift:-30,inferred_pickup:30,current_qty:38}];APP.cmd('push','mirror_gzgrocery');APP.cmd('gzPickup',9,'ignore')",
    'push:faq-grouped': "state.cfg=Object.assign({},state.cfg,{faq:{categories:[{id:'orders',en:'Orders',cn:'订单'},{id:'delivery',en:'Delivery',cn:'配送'}],questions:[{id:'q1',cat:'orders',q_en:'Where is my order?',a_en:'Track it in the app.'},{id:'q2',cat:'delivery',q_en:'Do you deliver here?',a_en:'Check your postcode.'},{id:'q3',cat:'gone',q_en:'Orphan question',a_en:'Still visible to customers.'}]}});APP.cmd('push','faq')",
    'push:faq-open': "state.cfg=Object.assign({},state.cfg,{faq:{categories:[{id:'orders',en:'Orders',cn:'订单'}],questions:[{id:'q1',cat:'orders',q_en:'Where is my order?',a_en:'Track it in the app.'}]}});state.faqOpen=0;APP.cmd('push','faq')",
    'push:legal-clipped': "state.cfg=Object.assign({},state.cfg,{legal:{terms:{body_en:'x'.repeat(2000),updated_at:'2026-05-01'},privacy:{body_en:'short',updated_at:'2026-05-01'}}});state.faqOpen=0;APP.cmd('push','legal')",
    'push:popups-live': "state.cfg=Object.assign({},state.cfg,{popups:{list:[{id:'p1',name:'Autumn promo',enabled:true,title_en:'20% off',body_en:'This week only.',pages:['home','shop'],frequency:'once',cta_label_en:'Shop now',cta_target:'/pages/shop/index',start_at:'2026-08-01',end_at:'2026-12-01'},{id:'p2',name:'Old notice',enabled:true,title_en:'Closed',pages:['all'],frequency:'daily',end_at:'2026-07-01'},{id:'p3',name:'Next month',enabled:true,pages:[],frequency:'session',start_at:'2026-12-01'},{id:'p4',name:'Paused',enabled:false,pages:['me'],frequency:'every_visit'}]}});APP.cmd('push','popups')",
    'push:popups-none': "state.cfg=Object.assign({},state.cfg,{popups:{list:[]}});APP.cmd('push','popups')",
    'push:operations-live': "state.printerTried=true;state.printer={auto_print:true};state.fapiaoTried=true;state.fapiao={autoIssue:false};state.geoTried=true;state.geo={provider:'amap',tencent_maps_configured:true,stores:{total:3,geocoded:2,missing:1},addresses:{total:180,geocoded:174,missing:6},last_error:null};state.alipayTried=true;state.alipay={enabled:true,account:'Roots Ltd'};state.stores=[{id:1,code:'th',name_en:'Tianhe',name_cn:'天河',city:'Guangzhou',district:'Tianhe',lat:23.1,lng:113.3},{id:2,code:'yx',name_en:'Yuexiu',name_cn:'越秀',city:'Guangzhou'}];APP.cmd('push','operations')",
    'push:operations-quota': "state.printerTried=true;state.printer={auto_print:false};state.fapiaoTried=true;state.fapiao={autoIssue:true};state.geoTried=true;state.geo={provider:'amap',tencent_maps_configured:true,stores:{total:1,geocoded:1,missing:0},addresses:{total:10,geocoded:4,missing:6},last_error:{code:'CUQPS_HAS_EXCEEDED_THE_LIMIT',message:'quota',quota:true}};state.alipayTried=true;state.alipay={enabled:false};state.stores=[];APP.cmd('push','operations')",
    'push:affiliate-live': "state.sw=Object.assign({},state.sw);state.affiliateTried=true;state.affiliate={total:24,converted:9,paid_out:180,lifetime_paid:42.5,still_earning:6,joined_this_month:5,joined_last_month:3};state.affRows=[{id:1,referrer_id:1,invitee_id:2,referrer_nickname:'Chen',invitee_nickname:'Ling',invitee_phone:'138****1',code_used:'CHEN24',status:'ordered',reward_amount:20,first_paid_order_id:412,joined_at:'2026-08-01 10:00:00',lifetime_active:1},{id:2,referrer_id:1,invitee_id:3,referrer_nickname:'Chen',invitee_nickname:'Wu',code_used:'CHEN24',status:'joined',reward_amount:0,joined_at:'2026-08-18 10:00:00'},{id:3,referrer_id:4,invitee_id:5,referrer_nickname:'Sarah',invitee_nickname:'Mo',code_used:'SAR7',status:'void',voided_reason:'duplicate account',reward_amount:0,joined_at:'2026-07-02 10:00:00'}];APP.cmd('push','affiliate')",
    'push:affiliate-empty': "state.affiliateTried=true;state.affiliate={total:0,converted:0,paid_out:0};state.affRows=[];APP.cmd('push','affiliate')",
    'push:editor-live': "state.cmsTried={home:true};state.cms={home:{page:'home',dirty:false,live:[{id:'a',type:'hero_banner',title_en:'Autumn drop'},{id:'b',type:'product_grid'},{id:'c',type:'flash_sale_strip'}],draft:[{id:'a',type:'hero_banner'},{id:'b',type:'product_grid'},{id:'c',type:'flash_sale_strip'}]}};APP.cmd('push','editor')",
    'push:editor-dirty': "state.cmsTried={home:true};state.cms={home:{page:'home',dirty:true,live:[{id:'a',type:'hero_banner'}],draft:[{id:'a',type:'hero_banner'},{id:'b',type:'coupon_block'}]}};APP.cmd('push','editor')",
    'push:editor-empty': "state.cmsTried={home:true};state.cms={home:{page:'home',dirty:false,live:[],draft:[]}};APP.cmd('push','editor')",
    'push:delivery-live': "state.zones=[{id:1,is_active:1,zone_type:'gz_district',province_cn:'广东省',same_day_allowed:1},{id:2,is_active:1,zone_type:'city',province_cn:'江苏省'},{id:3,is_active:0,zone_type:'city',province_cn:'浙江省'}];state.geoTried=true;state.geo={stores:{total:3,geocoded:2,missing:1},tencent_maps_configured:true};state.printerTried=true;state.printer={auto_print:true};APP.cmd('push','delivery')",
    'push:delivery-holiday': "state.cfg=Object.assign({},state.cfg,{delivery:{holidayMode:true,holidayMessage:{en:'Closed for Mid-Autumn, back Thursday.'},sameDayCutoffMinutes:20}});state.zones=[];state.geoTried=true;state.geo={stores:{total:1,geocoded:1,missing:0}};state.printerTried=true;state.printer={auto_print:false};APP.cmd('push','delivery')",
    // Setup reads /setup's two lists; Settings reads the entitlement ceiling.
    'push:setup-live': "state.setup={percent:60,requiredDone:3,requiredTotal:5,allDone:false,steps:[{key:'store',done:true,count:2},{key:'products',done:true,count:128},{key:'payment',done:true,method:'both'},{key:'fulfillment',done:false,delivery:false,pickup:false},{key:'open',done:false}],optional:[{key:'wechat',done:false},{key:'brand',done:true}]};APP.cmd('push','setup')",
    'push:setup-done': "state.setup={percent:100,requiredDone:5,requiredTotal:5,allDone:true,steps:[{key:'store',done:true,count:2},{key:'products',done:true,count:128},{key:'payment',done:true,method:'wechat'},{key:'fulfillment',done:true,pickup:true},{key:'open',done:true}],optional:[]};APP.cmd('push','setup')",
    'push:settings-gated': "state.ent={socialProof:false,faq:false};APP.cmd('push','settings')",
    'push:social-off': "state.cfg=Object.assign({},state.cfg,{features:{socialProof:false}});APP.cmd('push','social')",
    // The four lists that now have a loaded flag: before it, a screen must say
    // it is loading rather than confidently saying there is nothing.
    'push:coupons-loading': "APP.cmd('push','coupons')",
    'push:flash-loading': "APP.cmd('push','flash')",
    'push:broadcasts-loading': "APP.cmd('push','broadcasts')",
    'push:inbox-loading': "APP.cmd('push','inbox')",
    // The mock's own rows must not outlive an empty server answer.
    'push:inbox-no-reviews': "state.revLoaded=true;" + ROWS + "DB.reviews=[];APP.cmd('push','inbox')",
    'push:coupons-empty': "state.vchLoaded=true;" + ROWS + "DB.coupons=[];APP.cmd('push','coupons')",
    'push:flash-empty': "state.flashLoaded=true;" + ROWS + "DB.flash=[];APP.cmd('push','flash')",
    'push:broadcasts-empty': "state.bcLoaded=true;" + ROWS + "DB.broadcasts=[];APP.cmd('push','broadcasts')",
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
    'push:purchasing-empty': "state.posTried=true;state.poList=[];APP.cmd('push','purchasing')",
    'push:purchasing-error': "state.posTried=true;state.posErr='Could not load purchase orders.';APP.cmd('push','purchasing')",
    'sheet:po': "state.posTried=true;state.poList=[];APP.cmd('push','purchasing');state.poId=4;state.poDetail={id:4,po_number:'RPO-0004',supplier:'Fresh Co.',store_name_en:'Tianhe',date:'2026-08-14',delivery_date:'2026-08-16',status:'Ordered',total_cost:3240,notes:'Back door before 9.',items:[{id:1,name_en:'Oat milk 1L',sku:'OM-1L',qty:48,unit:'btl',total_cost:1440,current_stock:12},{id:2,name_en:'Carrots',sku:'CR-01',qty:20,unit:'kg',total_cost:1800,qty_received:18,damaged_qty:2}]};render()",
    'sheet:po-loading': "state.posTried=true;state.poList=[];APP.cmd('push','purchasing');state.poId=4;render()",
    'sheet:po-receive-ask': "state.posTried=true;state.poList=[];APP.cmd('push','purchasing');state.poId=4;state.poDetail={id:4,po_number:'RPO-0004',supplier:'F',status:'Ordered',total_cost:1,items:[]};render();APP.cmd('poStatus','Delivered')",
    'sheet:account': "APP.cmd('overflow')",
    'sheet:cust-points': "" + ROWS + "state.customers=DB.customers.slice();state.custLoaded=true;APP.cmd('tab','customers');state.custId=1;state.custDetail={customer:{nickname:'A',tier_key:'tree',points_balance:120,balance:8},stats:{orders:{}}};render();APP.cmd('adjustPoints')",
    'sheet:cust-block': "" + ROWS + "state.customers=DB.customers.slice();state.custLoaded=true;APP.cmd('tab','customers');state.custId=1;state.custDetail={customer:{nickname:'A',tier_key:'tree',is_blocked:1},stats:{orders:{}}};render();APP.cmd('toggleBlock')",
    'sheet:mark-paid': "" + ROWS + "DB.orders[0]._id=1;DB.orders[0].raw='pending_payment';state.liveOrders=DB.orders;APP.cmd('tab','orders');APP.cmd('openOrder',DB.orders[0].id);APP.cmd('markPaid')",
    'sheet:refund-review': "" + ROWS + "DB.orders[0]._id=1;DB.orders[0].raw='paid';DB.orders[0].refundStatus='pending';state.liveOrders=DB.orders;APP.cmd('openOrder',DB.orders[0].id);APP.cmd('detailActions')",
    'sheet:refund-approve': "" + ROWS + "DB.orders[0]._id=1;DB.orders[0].raw='paid';DB.orders[0].refundStatus='pending';state.liveOrders=DB.orders;APP.cmd('openOrder',DB.orders[0].id);APP.cmd('approveRefund')",
    'sheet:refund-payout': "" + ROWS + "DB.orders[0]._id=1;DB.orders[0].raw='paid';DB.orders[0].refundStatus='approved';state.liveOrders=DB.orders;APP.cmd('openOrder',DB.orders[0].id);APP.cmd('payRefund')",
    'theme:dark': "APP.cmd('toggleTheme');APP.cmd('tab','orders')",
    // No 'lang:zh' case any more: the third pass renders EVERY screen in
    // Chinese, so one hand-written Chinese case adds nothing — and in that pass
    // it toggled twice and landed back in English, which read as a failure.
  });
  return cases;
}

// The title carries three verdicts: a thrown error, a raw column date that
// reached the glass, or the node count.
//
// The date one: §1.18 of the design system says English reads Aug 16 and
// Chinese reads 8月16日, and the app has fmtDay/fmtDateOnly for exactly that.
// But every date arrives from the server as YYYY-MM-DD, so a screen that
// forgets to format one looks fine to every other check in this directory —
// it is a plausible-looking string in the right place. Purchasing shipped four
// of them and Pop-ups printed one twice, in the pill and again three lines
// down. A regex on the painted text finds all of them at once.
const PROBE = `<script>window.__e=[];addEventListener('error',function(e){window.__e.push(e.message)},true);
addEventListener('load',function(){setTimeout(function(){
  var n=document.querySelectorAll('#app *').length;
  var t=(document.getElementById('app')||{}).innerText||'';
  var iso=t.match(/\\d{4}-\\d{2}-\\d{2}/);
  var frozen=null;
  if(window.__EN){ for(var i=0;i<window.__EN.length;i++){ if(t.indexOf(window.__EN[i])>=0){ frozen=window.__EN[i]; break; } } }
  document.title = window.__e.length ? ('ERR '+window.__e.join(' | '))
    : frozen ? ('EN '+frozen.slice(0,60))
    : iso ? ('ISO '+iso[0]) : ('OK '+n);
},400)});</script>`;

// Every long English half of a bilingual pair, for the Chinese pass below.
// Long and spaced, because a short one ('new', 'Open', 'Live') turns up inside
// a product name or a channel's own Latin name and would cry wolf.
function englishHalves(src) {
  const raw = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  const js = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const out = new Set();
  for (const m of js.matchAll(/(^|[^\w$.])T\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) {
    const en = m[2], zh = m[3];
    if (en !== zh && en.length >= 14 && en.includes(' ') && /[\u4e00-\u9fff]/.test(zh)) out.add(en);
  }
  return [...out];
}

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
  // The app's one LOCAL dependency, inlined — see inlineTdDatetime(). Every
  // screen below formats at least one date, so without it tdWhen is undefined
  // and the whole run paints empty: 372 identical failures saying nothing.
  // The static passes further down keep reading this same string, which is why
  // the inlined block carries an attribute — their /<script>…<\/script>/ lifts
  // want the app's own source and must not match a dependency.
  src = inlineTdDatetime(src);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm-screens-'));
  const cases = buildCases(src);
  const failures = [];

  // Two passes. WARM seeds server-shaped state so each screen renders its real
  // branch. COLD seeds nothing — the first paint, and the offline one, where a
  // screen must show a loading or empty state rather than reaching into data
  // that has not arrived. Half the crashes in this app's history live there.
  // A third pass, in Chinese, checking that nothing English survives the
  // switch. The Today card on HOME did: state.liveKpis is built once at boot
  // with T() already applied, so both the labels and the comparisons under them
  // were frozen in whatever language the app started in, and a Chinese operator
  // read "Revenue (all channels)". Every other bilingual value in the file is
  // stored as a pair and resolved at render; those two were built in a loader
  // rather than a renderer and slipped the rule. Nothing that asserts on
  // English text can see this, and neither can a screenshot nobody takes in
  // Chinese.
  const passes = [['warm', SEED], ['cold', ''], ['zh', SEED + "APP.cmd('toggleLang');"]];
  const work = [];
  for (const [name, js] of Object.entries(cases)) {
    for (const [pass, seed] of passes) work.push([`${name} [${pass}]`, seed, js]);
  }
  const EN = englishHalves(src);

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

  // ── Static pass: both halves of every bilingual pair ───────────────────
  // Half the people who open this app read Chinese. T(en, zh) is the only way
  // a string reaches them, and a pair whose second half is English reaches
  // them as English — silently, on one row, in one state, which is exactly
  // where it will not be noticed. Cheap to check, so checked.
  {
    const raw = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    const js4 = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const cjk = (t) => /[一-鿿]/.test(t);
    const bad = [];
    for (const m of js4.matchAll(/(^|[^\w$.])T\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) {
      const [, , en, zh] = m;
      // A pair with no Chinese is fine when it has no words either — '×3',
      // a SKU, a currency symbol, a proper noun the shop uses in both.
      if (!cjk(zh) && /[A-Za-z]{3}/.test(zh) && zh === en) bad.push(en);
      else if (!cjk(zh) && /[A-Za-z]{4,}\s+[A-Za-z]{3,}/.test(zh)) bad.push(en);
    }
    if (bad.length) {
      for (const t of [...new Set(bad)].slice(0, 20)) console.error(`FAIL i18n — "${t}" has no Chinese`);
      console.error(`\n${new Set(bad).size} bilingual pair${new Set(bad).size === 1 ? '' : 's'} whose Chinese half is English.`);
      process.exit(1);
    }
  }

  // ── Static pass: the dispatcher can feed every handler ─────────────────
  // APP.cmd is the only way a control reaches a handler. It used to forward ONE
  // argument while two handlers took two, so APP.cmd('pollStatus', 7, 'closed')
  // arrived as (7, undefined): the PUT body became {status: undefined}, which
  // JSON.stringify drops, so the server saw an empty patch, changed nothing,
  // answered 200 — and the phone said "Poll closed". A write that reports
  // success and does nothing is the worst shape a bug can take, and no render
  // test can see it. This one is a grep on the dispatcher itself.
  {
    const raw = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    const js3 = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const disp = (js3.match(/window\.APP\s*=\s*\{\s*cmd\s*:\s*\(([^)]*)\)/) || [])[1] || '';
    const variadic = /\.\.\./.test(disp);
    // Call sites that pass more than one argument, e.g. APP.cmd('x', 1, 'y').
    const multi = new Set();
    for (const m of js3.matchAll(/APP\.cmd\(\s*'([a-zA-Z_$][\w$]*)'\s*,[^)]*,[^)]*\)/g)) multi.add(m[1]);
    if (multi.size && !variadic) {
      for (const n of [...multi].sort()) {
        console.error(`FAIL static — APP.cmd('${n}', …) passes extra arguments the dispatcher drops`);
      }
      console.error(`\nMake APP.cmd variadic, or stop passing arguments it cannot forward.`);
      process.exit(1);
    }
  }

  // ── Static pass: no control wired to nothing ───────────────────────────
  // Half of §1 of docs/tacet-mobile-parity.md is controls that pretended: a row
  // with a chevron, a tap target, and APP.cmd('noop') behind it. An operator
  // taps, nothing happens, and they assume the screen is still loading. Every
  // one of them is gone; this keeps them gone.
  {
    // Comments stripped first — the comment explaining why noop is gone names it.
    const noopSrc = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const hits = [...noopSrc.matchAll(/APP\.cmd\(\s*'noop'/g)].length
               + [...noopSrc.matchAll(/\breg\(\s*'noop'/g)].length;
    if (hits) {
      console.error(`FAIL static — ${hits} reference${hits === 1 ? '' : 's'} to the 'noop' command.`);
      console.error("A control wired to noop is a control that lies. Give it a destination or stop drawing it as a control.");
      process.exit(1);
    }
  }

  // ── Static pass: no command nothing can reach ──────────────────────────
  // The mirror of the noop check above, and it caught something worse. The
  // CREATE SHEET — new coupon, new flash sale, new broadcast — had a submit
  // handler that read, in full:
  //
  //     reg('submitCreate', ()=>{ state.createKind=null; showToast('Created'); })
  //
  // It closed itself, said Created, and sent nothing anywhere. The only reason
  // it never lied to an operator is that nothing in the file called
  // APP.cmd('create'), so the sheet could not be opened at all — which is not a
  // safe place to leave a form, because the next person adds a "+" button and
  // ships it. `saveStock` was the same: a Receive stock button whose handler
  // was one toast, reachable only through a flag no mapper sets.
  //
  // A command's name reaches a handler as a STRING, so the check is on strings:
  // a name that appears only at its own reg() has no way in. That covers the
  // template-built call sites too — APP.cmd('${cmd}') where cmd came from a
  // list of quoted names, which is how the customer sheet's four actions and
  // every chipRow filter are wired.
  {
    const raw = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    const js5 = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const names = [...new Set([...js5.matchAll(/\breg\(\s*'([a-zA-Z_$][\w$]*)'/g)].map((m) => m[1]))];
    const orphans = names.filter((n) => {
      const asString = (js5.match(new RegExp("'" + n + "'", 'g')) || []).length;
      const asMember = (js5.match(new RegExp('\\bCMD\\.' + n + '\\b', 'g')) || []).length;
      return asString + asMember <= 1;
    }).sort();
    if (orphans.length) {
      for (const n of orphans) console.error(`FAIL static — reg('${n}') is registered but nothing can reach it`);
      console.error(`\n${orphans.length} unreachable command${orphans.length === 1 ? '' : 's'}. Wire it or delete it — an unreachable handler is a lie waiting for a button.`);
      process.exit(1);
    }
  }

  // ── Static pass: every state key is declared, exactly once ─────────────
  // The app has ONE state object and ~120 keys on it. Two screens can pick the
  // same short name without either author noticing: `state.pos` was the
  // operator's ROLE (loadMe writes it; the money gate reads it) and a later
  // edit reused it for the purchase-order list. Nothing failed — the two just
  // took turns clobbering each other, and the symptom would have been revenue
  // appearing for a warehouse operator, which no render test looks for.
  // So: every state.x the file touches must appear in the literal, once.
  {
    const raw = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    const js2 = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const lit = (js2.match(/\bconst state\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
    if (!lit) { console.error('FAIL static — cannot find the state literal'); process.exit(1); }
    // TOP-LEVEL keys only, and several per line. A regex cannot do this: the
    // literal packs many keys on one line AND contains nested objects
    // (`sw:{fapiao:…, affiliate:…}` is a map of feature flags, not of state
    // keys). So walk it, tracking brace depth and skipping quoted strings.
    const seen = new Map();
    {
      let depth = 0, q = null, ident = '';
      for (let i = 0; i < lit.length; i++) {
        const c = lit[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === "'" || c === '"' || c === '`') { q = c; ident = ''; continue; }
        if (c === '{' || c === '[' || c === '(') { depth++; ident = ''; continue; }
        if (c === '}' || c === ']' || c === ')') { depth--; ident = ''; continue; }
        if (/[A-Za-z0-9_$]/.test(c)) { ident += c; continue; }
        if (c === ':' && depth === 0 && ident) seen.set(ident, (seen.get(ident) || 0) + 1);
        ident = '';
      }
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k).sort();
    for (const k of dupes) console.error(`FAIL static — state.${k} is declared twice`);
    const used = new Set([...js2.matchAll(/\bstate\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
    const undecl = [...used].filter((k) => !seen.has(k)).sort();
    for (const k of undecl) console.error(`FAIL static — state.${k} is used but never declared in the state literal`);
    if (dupes.length || undecl.length) {
      console.error(`\n${dupes.length + undecl.length} state key problem${dupes.length + undecl.length === 1 ? '' : 's'}.`);
      process.exit(1);
    }
  }

  // ── Static pass: every tint and ink is defined in BOTH themes ──────────
  // The four --*-tint tokens were declared once, in :root, and never in the
  // dark block — so a Sage icon tile, an Amber count badge and a Brick warning
  // banner all kept their paper-coloured fill on a near-black page, and Home
  // drew seven cream slabs down the side of the "Needs you" list. Nothing
  // throws, nothing renders wrong, and no assertion on text can see it.
  //
  // The second half is the pairing: a hue on its own tint. Amber #C9954A on
  // Amber-tint #F7EEDE is 2.2:1, which is under the floor for a 13px number,
  // and the fires' count badges were drawn exactly that way. Text on a tint
  // uses the matching --*-ink, which exists for this.
  {
    const css = (src.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    const block = (re) => (css.match(re) || [])[1] || '';
    const light = block(/:root\s*\{([\s\S]*?)\}/);
    const dark = block(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);
    if (!light || !dark) { console.error('FAIL static — cannot find the theme blocks'); process.exit(1); }
    // name -> value, so an ALIAS can be skipped: --accent-tint is
    // `var(--dusk-tint)`, which follows whatever the theme sets. And the
    // hyphen before the suffix keeps --ink itself out of it: that is a raw
    // palette hue, fixed on purpose.
    const decls = (b) => new Map([...b.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    const inDark = decls(dark);
    const missing = [...decls(light)]
      .filter(([n, v]) => /-[a-z]+-(tint|ink)$/.test(n) && !/^var\(/.test(v) && !inDark.has(n))
      .map(([n]) => n).sort();
    for (const n of missing) console.error(`FAIL theme — ${n} is defined for light only; dark inherits the light value`);

    const paired = [...src.matchAll(/background:var\(--([a-z]+)-tint[^)]*\);\s*color:var\(--\1[,)]/g)].map((m) => m[1]);
    for (const h of [...new Set(paired)]) console.error(`FAIL theme — --${h} is used as text on --${h}-tint; use --${h}-ink`);

    if (missing.length || paired.length) {
      console.error(`\n${missing.length + new Set(paired).size} theme token problem${missing.length + new Set(paired).size === 1 ? '' : 's'}.`);
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
      (name.endsWith('[zh]') ? `<script>window.__EN=${JSON.stringify(EN)};</script>` : '') +
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
    if (title.startsWith('EN')) failures.push([name, `English survived the language switch: "${title.slice(3)}" — store the pair, resolve it at render`]);
    else if (title.startsWith('ISO')) failures.push([name, `a raw column date reached the screen: ${title.slice(4)} — format it with fmtDay/fmtDateOnly`]);
    else if (!title.startsWith('OK')) failures.push([name, title]);
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
  console.log(`ok — ${total} renders (${Object.keys(cases).length} screens, warm, cold and Chinese), no uncaught errors.`);
}

main();
