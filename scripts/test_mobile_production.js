#!/usr/bin/env node
/**
 * The kitchen queue, and the two production screens it hands off to.
 *
 *   node scripts/test_mobile_production.js
 *
 * These three moved out of /stock under decisions §48. They are asserted here
 * rather than left to test_mobile_screens.js (which proves a screen paints)
 * because what matters about them is not the paint — it is four rules that are
 * all silent when broken:
 *
 *   • CLOSING A REQUEST IS NOT PUTTING IT ON THE SHELF. The server moves no
 *     stock for a kitchen request by design, so marking one `prepared` leaves
 *     the shelf exactly as short as it was. The lines must be carried to the
 *     screen that adds them, in the same gesture — a queue that just closes the
 *     request is a shop whose stock silently never arrives.
 *   • A SHORT LINE MUST SAY WHY BEFORE ANYTHING IS WRITTEN. Made 20, shelved
 *     18: the two missing ones are a fact that gets recorded or a fact that
 *     disappears. The server refuses a bare gap too (gap_reason_required); the
 *     screen refusing first is what makes it a question rather than a failure.
 *   • ONE NUMBER PER ROW. The operator sets what reached the SHELF; what was
 *     MADE is max(asked, shelved). An extra tray is not a loss and must not ask
 *     a question.
 *   • A LINE THAT LANDED IS NEVER PENDING AGAIN. Record after a partial failure
 *     retries only what failed. Without that guard a shaky connection adds a
 *     batch twice, and a double-add is invisible until somebody counts.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// The operator these screens exist for: works the queue, logs production, adds.
const KITCHEN = "state.caps=['quickstock:add','restock:fulfil','production:log'];";

/* The shelf this kitchen adds to, and `mode:'recount'` is deliberate — it is
   the mode EVERY operator who can reach these screens is actually in.

   IT SAID `mode:'add'` AND THAT IS WHY THIS SUITE PASSED OVER A DEAD FLOW for
   as long as it existed. The fixture was written against hdStart's old gate,
   `qsMode()==='add'`, and the note beside it called that gate load-bearing. It
   was unreachable: lib/quick-stock-grant.js answers 'add' only for a backend
   operator whose role is literally `kitchen`, that role ships `stock_app_only`,
   and server.js uses that flag to refuse it Tacet Mobile entirely — so no
   session that can open this queue has ever been in add mode, the handover
   never fired once, and the suite proved a state the app cannot be in. §59
   moved the gate onto `production:log`, the capability the Record button's own
   write is gated on; this fixture now reproduces the live session instead of
   the one that made the old assertion pass. */
const SHELF = KITCHEN + `
  state.qs.ctx={enabled:true,mode:'recount',stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]};
  state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true;
  state.qs.items=[
    {product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10',physical_qty:11},
    {product_id:8,name_en:'Turkish Tomato Salad',name_cn:'土耳其番茄沙拉',sku:'1-15',physical_qty:0}
  ];
  state.hd.reasons=[{code:'made_fewer',en:'Made fewer',cn:'实际制作较少'},
                    {code:'damaged',en:'Damaged',cn:'损坏'}];`;

/* A request whose third line this store has no product for. It is here in every
   fixture because a line that cannot be matched is the one the old screen was
   most likely to drop, and a dropped line is a product that quietly never
   reaches the shelf. It matches on SKU — a kitchen request carries no
   product_id, so the SKU is the only honest join. */
const ORDER = `{id:44,rs_number:'RS-44',status:'received',purpose:'shelf',items:[
  {id:1,sku:'1-10',product_name:'Hummus Asli',product_cn:'鹰嘴豆泥',qty_requested:20},
  {id:2,sku:'1-15',product_name:'Turkish Tomato Salad',product_cn:'土耳其番茄沙拉',qty_requested:6},
  {id:3,sku:'9-99',product_name:'Something Else',product_cn:'其他',qty_requested:4}]}`;

// The queue open on that request, one tap away from closing it.
const QUEUE = SHELF + `
  state.kq.tried=true; state.kq.list=[{id:44,rs_number:'RS-44',item_count:3,purpose:'shelf'}];
  state.kq.orderId=44; state.kq.order=${ORDER};
  state.stack=[{route:'kitchenqueue',title:SUBS.kitchenqueue.title}]; render();`;

// The record screen, entered the way the queue enters it.
const MADE = SHELF + `
  state.kq.order=${ORDER};
  hdOpen(hdResolve(state.kq.order),'RS-44',44); render();`;

const body = "txt('content').replace(/\\s+/g,' ')";

// A write recorder. Every call succeeds; the cases that want a failure install
// their own.
const CATCH = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;

/* THE SHELF, AND WHEN IT ANSWERS. `state.qs.items` is filled by loadQsItems on
   the answer to /stores/:id/stock, two chained round trips after the queue
   first renders — so on a phone the operator can easily tap through before it
   lands. HANGSHELF holds that one call open forever and lets everything else
   answer; LATESHELF answers it with this store's list. Between them they pin
   the race the third §59 report arrived through. */
const SHELF_ROWS = `[{product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10',physical_qty:11},
  {product_id:8,name_en:'Turkish Tomato Salad',name_cn:'土耳其番茄沙拉',sku:'1-15',physical_qty:0}]`;
const shelfStub = (rows) => `window.__sent=[];
  window.fetch=function(u,o){ var url=String(u); window.__sent.push({u:url,b:o&&o.body});
    if(/\\/stores\\/\\d+\\/stock$/.test(url)) ${rows
      ? `return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:${rows}})}});`
      : 'return new Promise(function(){});'}
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;
const HANGSHELF = shelfStub(null);
const LATESHELF = shelfStub(SHELF_ROWS);

run('production', [
  ['the queue is a screen in this app, not a door out of it',
    KITCHEN + "state.tab='more';state.stack=[];render();", [
      ['the home offers it', `${body}.indexOf('Kitchen queue')>-1`],
      ['as a push', "moreRowsFlat().some(function(r){return r.key==='kitchenqueue'&&!r.href})"],
      ['and Log a batch beside it', `${body}.indexOf('Log a batch')>-1`],
    ]],

  ['an open request shows what was asked for, and what closing it does next',
    QUEUE, [
      ['the request is named', `${body}.indexOf('RS-44')>-1`],
      ['what it asked for', `${body}.indexOf('Hummus Asli')>-1`],
      ['how many', `${body}.indexOf('20')>-1`],
      ['and it says the shelf question is still coming',
       `${body}.indexOf('how many reached the shelf')>-1`],
    ]],

  /* THE HANDOFF, which is the whole reason these three are one piece. */
  ['closing a request hands its lines to the screen that adds them',
    QUEUE + CATCH + "APP.cmd('kqAdvance','prepared');", [
      ['the status went to the server',
       "window.__sent.some(function(s){return /\\/api\\/restock\\/44\\/status/.test(s.u)&&/prepared/.test(s.b||'')})"],
      ['and the record screen is what is open now',
       "state.stack[state.stack.length-1].route==='whatmade'"],
      ['carrying the request with it', "state.hd.rs==='RS-44'&&state.hd.rsId===44"],
      ['all three lines, including the one with no product here', "state.hd.lines.length===3"],
      ['the two that matched carry this store’s ids',
       "state.hd.lines[0].id===7&&state.hd.lines[1].id===8"],
      ['and the one that did not is kept, not dropped', "state.hd.lines[2].id===null"],
      /* THE REGRESSION THIS SUITE COULD NOT SEE. The operator holding this
         queue is in recount mode — every operator who can reach it is — and
         the handover must not read the mode to decide. */
      ['for an operator the quick-stock mode calls a recounter',
       "qsMode()==='recount'"],
    ]],

  /* THE SHELF ARRIVES AFTER THE TAP, WHICH IS THE ORDINARY CASE ON A PHONE.
     `state.qs.items` starts null and is filled two chained round trips after
     the queue first renders. An operator who taps through faster than that
     used to resolve every line against an empty list, get every line back
     unmatched, and be refused the screen entirely — the request closed, nothing
     opened, and the queue came back empty with nothing saying why. That is the
     shape §59 was reported in a third time, and it is what these three cases
     hold shut. */
  ['a shelf that has not arrived yet still opens the screen',
    QUEUE + "state.qs.items=null;state.qs.itemsTried=false;" + HANGSHELF +
      "APP.cmd('kqAdvance','prepared');", [
      ['the request still closed',
       "window.__sent.some(function(s){return /\\/api\\/restock\\/44\\/status/.test(s.u)})"],
      ['and the record screen is open, not skipped',
       "state.stack[state.stack.length-1].route==='whatmade'"],
      ['carrying the request', "state.hd.rs==='RS-44'&&state.hd.rsId===44"],
      ['its lines held rather than resolved against nothing', "state.hd.lines===null"],
      ['the request remembered so they can be', "state.hd.awaiting!==null"],
      ['it did go and ask for the shelf',
       "window.__sent.some(function(s){return /\\/stores\\/\\d+\\/stock$/.test(s.u)})"],
      ['and the screen says it is still coming', `${body}.indexOf('Loading')>-1`],
    ]],

  ['and the lines land the moment the shelf does',
    QUEUE + "state.qs.items=null;state.qs.itemsTried=false;" + LATESHELF +
      "APP.cmd('kqAdvance','prepared');", [
      ['the screen is the record screen', "state.stack[state.stack.length-1].route==='whatmade'"],
      ['all three lines arrived', "state.hd.lines&&state.hd.lines.length===3"],
      ['matched to this store’s ids', "state.hd.lines[0].id===7&&state.hd.lines[1].id===8"],
      ['nothing is left waiting', "state.hd.awaiting===null"],
      ['and the operator is looking at them', `${body}.indexOf('Hummus Asli')>-1`],
    ]],

  /* A SHELF THAT NEVER ARRIVES IS NOT A DEAD END EITHER. The request is closed
     by the time anybody reaches this screen and there is no way back to it, so
     the failure has to carry the way forward. */
  ['a shelf that failed says so and offers the way on',
    QUEUE + "state.qs.items=null;state.qs.itemsTried=false;" + HANGSHELF +
      "APP.cmd('kqAdvance','prepared');state.qs.itemsErr='nope';render();", [
      ['it names what failed', `${body}.indexOf('shelf')>-1`],
      ['says the stock is not in yet', `${body}.indexOf('nothing has been added to stock yet')>-1`],
      ['points at the door that needs no request', `${body}.indexOf('Log a batch')>-1`],
      ['and offers a retry', `${body}.indexOf('Try again')>-1`],
    ]],

  /* NOT ONE LINE MATCHED IS A SENTENCE, NOT A SILENCE. The screen has always
     been able to say which lines this store cannot take; refusing to open threw
     that away and left nothing in its place. */
  ['a request whose lines are none of this store’s still opens and says so',
    SHELF + `state.kq.tried=true; state.kq.list=[{id:45,rs_number:'RS-45',item_count:1}];
      state.kq.orderId=45;
      state.kq.order={id:45,rs_number:'RS-45',status:'received',purpose:'shelf',items:[
        {id:9,sku:'9-99',product_name:'Something Else',product_cn:'其他',qty_requested:4}]};
      state.stack=[{route:'kitchenqueue',title:SUBS.kitchenqueue.title}]; render();` +
      CATCH + "APP.cmd('kqAdvance','prepared');", [
      ['the screen opened', "state.stack[state.stack.length-1].route==='whatmade'"],
      ['the line is on it', `${body}.indexOf('Something Else')>-1`],
      ['named as not stockable here', `${body}.indexOf('not on this store')>-1`],
      ['and there is nothing to record', "hdPending().length===0"],
    ]],

  /* THE DEAD TAP, from the other side. push() declines a route this operator
     cannot reach and says nothing, so hdOpen answering "opened" sent kqAdvance
     home on a handover that never happened: the request closed, the screen did
     not move, and the early return skipped even the re-render. */
  ['an operator who cannot record a batch closes the request and lands back on the queue',
    QUEUE + "state.caps=['quickstock:add','restock:fulfil'];" + CATCH +
      "APP.cmd('kqAdvance','prepared');", [
      ['the record screen is refused them', "canRoute('whatmade')===false"],
      ['the status still went to the server',
       "window.__sent.some(function(s){return /\\/api\\/restock\\/44\\/status/.test(s.u)})"],
      ['they are not sent into a screen they cannot reach',
       "state.stack[state.stack.length-1].route==='kitchenqueue'"],
      ['and the queue is not left holding a closed request', "state.kq.order===null"],
    ]],

  ['the unmatched line is shown and said out loud, never silently dropped', MADE, [
    ['it is on the screen', `${body}.indexOf('Something Else')>-1`],
    ['named as not stockable here', `${body}.indexOf('not on this store')>-1`],
    ['and it cannot be counted', "hdBump(2,1),state.hd.lines[2].want===4"],
  ]],

  ['a full batch asks nothing at all', MADE, [
    ['nothing is short', "hdUnexplained().length===0"],
    ['no question on the screen', `${body}.indexOf('short — why?')===-1`],
    ['Record is live', "!hdUnexplained().length&&hdPending().length>0"],
  ]],

  /* ONE NUMBER PER ROW: the operator moves the SHELF figure, `made` follows. */
  ['an extra tray is not a loss, and is not asked about',
    MADE + "APP.cmd('hdBump',0,1);", [
      ['22 on the shelf', "state.hd.lines[0].want===21"],
      ['made follows it up', "hdMade(state.hd.lines[0])===21"],
      ['nothing is short', "hdShort(state.hd.lines[0])===0&&hdUnexplained().length===0"],
    ]],

  ['coming up short asks why, and holds the write until it is answered',
    MADE + "APP.cmd('hdBump',0,-1);APP.cmd('hdBump',0,-1);", [
      ['made stays at what was asked', "hdMade(state.hd.lines[0])===20"],
      ['two short', "hdShort(state.hd.lines[0])===2"],
      ['the question is on the row', `${body}.indexOf('2 short')>-1`],
      ['with the server’s own reasons', `${body}.indexOf('Made fewer')>-1`],
      ['and it counts as unanswered', "hdUnexplained().length===1"],
    ]],
  ['answering it clears the hold',
    MADE + "APP.cmd('hdBump',0,-1);APP.cmd('hdBump',0,-1);APP.cmd('hdReason',0,'damaged');", [
      ['the reason is on the line', "state.hd.lines[0].reason==='damaged'"],
      ['the picker closed', "state.hd.openReason===-1"],
      ['nothing unanswered', "hdUnexplained().length===0"],
    ]],
  /* A STALE REASON FILES A LOSS THAT DID NOT HAPPEN, so the answer goes with
     the question when the line is put back to full. */
  ['putting the line back to full takes the reason with it',
    MADE + "APP.cmd('hdBump',0,-1);APP.cmd('hdReason',0,'damaged');APP.cmd('hdBump',0,1);", [
      ['no gap', "hdShort(state.hd.lines[0])===0"],
      ['and no reason left on it', "state.hd.lines[0].reason===''"],
    ]],

  /* A tray made and entirely lost moves no stock and is the morning most worth
     recording — so want 0 must still be a line that writes. */
  ['a batch that reached the shelf at zero is still a batch',
    MADE + "for(var i=0;i<20;i++)APP.cmd('hdBump',0,-1);APP.cmd('hdReason',0,'damaged');", [
      ['nothing shelved', "state.hd.lines[0].want===0"],
      ['20 made', "hdMade(state.hd.lines[0])===20"],
      ['and it is still pending a write',
       "hdPending().some(function(l){return l.id===7})"],
    ]],

  ['the write is one production call per line, naming the request',
    MADE + CATCH + "APP.cmd('hdCommit');", [
      ['two calls, one per matched line',
       "window.__sent.filter(function(s){return /\\/production$/.test(s.u)}).length===2"],
      ['it is the production endpoint, not the stock one',
       "window.__sent.every(function(s){return s.u.indexOf('/stock')===-1})"],
      ['carrying made and shelved',
       "/\"qty_made\":20/.test(window.__sent[0].b)&&/\"qty_shelved\":20/.test(window.__sent[0].b)"],
      ['and the request it came from', "/\"request_id\":44/.test(window.__sent[0].b)"],
    ]],
  ['a short line puts its reason on the wire',
    MADE + "APP.cmd('hdBump',0,-1);APP.cmd('hdReason',0,'damaged');" + CATCH + "APP.cmd('hdCommit');", [
      ['made 20, shelved 19', "/\"qty_made\":20/.test(window.__sent[0].b)&&/\"qty_shelved\":19/.test(window.__sent[0].b)"],
      ['with the reason', "/\"gap_reason\":\"damaged\"/.test(window.__sent[0].b)"],
    ]],

  /* THE DOUBLE-ADD GUARD. */
  ['a line that landed is never written again',
    MADE + `window.__sent=[];
      window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body});
        return /"product_id":8/.test(String(o&&o.body))
          ? Promise.reject(new Error('nope'))
          : Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };
      APP.cmd('hdCommit');`, [
      ['both were tried', "window.__sent.length===2"],
      ['the one that landed is marked', "state.hd.lines[0].st==='ok'"],
      ['the one that failed is marked too', "state.hd.lines[1].st==='err'"],
      ['and only the failure is still pending',
       "hdPending().length===1&&hdPending()[0].id===8"],
      ['the screen says nothing was counted twice', `${body}.indexOf('counted twice')>-1`],
      ['pressing Record again retries only that one',
       "window.__sent=[],APP.cmd('hdCommit'),window.__sent.length===1&&/\"product_id\":8/.test(window.__sent[0].b)"],
    ]],

  /* LOG A BATCH: the same screen, with nobody asking. */
  ['Log a batch opens empty and hands over the same shape',
    SHELF + "state.stack=[{route:'logbatch',title:SUBS.logbatch.title}];render();", [
      ['the list is the shelf list', `${body}.indexOf('Hummus Asli')>-1`],
      ['nothing counted yet', "batUnits()===0"],
      ['and it says which number it wants', `${body}.indexOf('how many you MADE')>-1`],
    ]],
  ['what it hands over reads as a full batch until the shelf number drops',
    SHELF + "state.stack=[{route:'logbatch',title:SUBS.logbatch.title}];render();" +
      "APP.cmd('batBump',7,1);APP.cmd('batBump',7,1);APP.cmd('batNext');", [
      ['it opened the record screen', "state.stack[state.stack.length-1].route==='whatmade'"],
      ['with no request behind it', "state.hd.rs===null&&state.hd.rsId===null"],
      ['asked equals made', "state.hd.lines[0].asked===2&&state.hd.lines[0].want===2"],
      ['so nothing is short', "hdUnexplained().length===0"],
      ['and dropping one asks why, exactly as a request would',
       "APP.cmd('hdBump',0,-1),hdUnexplained().length===1"],
    ]],
  ['a batch nobody asked for names no request on the wire',
    SHELF + "state.stack=[{route:'logbatch',title:SUBS.logbatch.title}];render();" +
      "APP.cmd('batBump',7,3);APP.cmd('batNext');" + CATCH + "APP.cmd('hdCommit');", [
      ['one call', "window.__sent.filter(function(s){return /\\/production$/.test(s.u)}).length===1"],
      ['request_id is null', "/\"request_id\":null/.test(window.__sent[0].b)"],
      ['made and shelved agree', "/\"qty_made\":3/.test(window.__sent[0].b)&&/\"qty_shelved\":3/.test(window.__sent[0].b)"],
    ]],
  /* A basket left over from a batch already recorded would add it twice, so
     entering the screen clears it. */
  ['entering Log a batch clears what the last one left',
    SHELF + "state.bat.qty={7:5}; state.bat.q='hum'; push('logbatch');", [
      ['nothing counted', "batUnits()===0"],
      ['and the search is clear', "state.bat.q===''"],
    ]],

  ['none of it is offered to somebody who cannot log production',
    "state.caps=['quickstock:add','restock:fulfil'];state.tab='more';state.stack=[];render();", [
      ['no Log a batch row', `${body}.indexOf('Log a batch')===-1`],
      ['the route refuses it', "canRoute('logbatch')===false"],
      ['and so does the record screen', "canRoute('whatmade')===false"],
      ['but the queue is still theirs', "canRoute('kitchenqueue')===true"],
    ]],

  ['in Chinese', "LANG='cn';" + SHELF + "state.kq.tried=true;state.kq.list=[];" +
      "state.stack=[{route:'kitchenqueue',title:SUBS.kitchenqueue.title}];render();", [
      ['the empty queue says so', `${body}.indexOf('暂无待制作')>-1`],
    ]],
/* EVERY CASE SETTLES. Half of these assert on what a write did, and a write
   here resolves in a microtask — checked in the same task that started it, the
   screen has not moved yet and the case reads the state it was about to leave. */
], { settle: 40 });
