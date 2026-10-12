#!/usr/bin/env node
/**
 * Add stock — the kitchen's other tool, now a screen in this app rather than a
 * separate PWA beside it.
 *
 *   node scripts/test_mobile_addstock.js
 *
 * The rules asserted here are the ones /stock learned the hard way, and each is
 * a decision rather than a detail. They are also all quiet when broken:
 *
 *   • THE SHELF TOTAL IS NEVER SHOWN. A kitchen logs what it MADE. Leak the
 *     running count onto this screen and the operator starts reconciling
 *     against a number that is somebody else's job.
 *   • THE STEPPER COMMITS ONCE. Taps build a "+N" and one delta is written
 *     after a pause. A write per tap puts six rows in the stock ledger where
 *     one belongs — and the ledger is what the shop reads back.
 *   • A FAILED WRITE HANDS THE AMOUNT BACK, in the row. Losing a count at the
 *     door is the one failure nobody forgives, and a toast that fades has told
 *     the operator nothing they can act on.
 *   • THE WIRE CARRIES A DELTA, never an absolute. The server refuses anything
 *     else from a kitchen operator (routes/retail-inventory.js kitchen_add_only)
 *     — a screen that sent physical_qty would simply not save.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// The operator this screen exists for: adds, does not recount, and receives.
const KITCHEN = "state.caps=['quickstock:add','purchasing:receive'];";

// The context and shelf the screen reads, seeded straight into state so the
// probe never needs a server. physical_qty is present ON PURPOSE — the screen
// is handed the shelf total and must still not draw it.
const SHELF = KITCHEN + `
  state.qs.ctx={enabled:true,mode:'add',stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]};
  state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true;
  state.qs.items=[
    {product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10',physical_qty:11},
    {product_id:8,name_en:'Turkish Tomato Salad',name_cn:'土耳其番茄沙拉',sku:'1-15',physical_qty:0}
  ];
  state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`;

const body = "txt('content').replace(/\\s+/g,' ')";

/* THE SAME SHELF, WITH THE GRANT (decisions §46). Derived from SHELF rather
   than written out again, so the two fixtures cannot drift on anything but the
   one fact that separates them: whether this tenant has ticked
   `quickstock:recount` onto the kitchen role. The server sends the answer as
   `can_recount`; the screen never infers it from whether a quantity happened to
   arrive, because a stripped list and a genuinely empty shelf look the same. */
const GRANTED = SHELF.replace('render();', 'state.qs.canRecount=true; render();');

// A write recorder, for the cases that are about what goes on the wire.
/* THE OTHER JOB THIS SCREEN NOW DOES (§48): the store clerk's absolute recount,
   which used to live in /stock. Same list, same store, same endpoint — the
   number on the card IS the shelf and the write is an absolute count. */
const CLERK = "state.caps=['quickstock:recount'];";
const COUNTING = CLERK + `
  state.qs.ctx={enabled:true,mode:'recount',stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]};
  state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true;
  state.qs.items=[
    {product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10',physical_qty:11},
    {product_id:8,name_en:'Turkish Tomato Salad',name_cn:'土耳其番茄沙拉',sku:'1-15',physical_qty:0}
  ];
  state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`;

/* AN OPERATOR WHO HOLDS TWO STORES — the owner, counting (the mode the report
   came from), and the same shelf in add mode. Derived from the one-store
   fixtures so they differ in the store list and nothing else. */
const TWO = "stores:[{id:1,name_en:'Tianhe',name_cn:'天河'},{id:2,name_en:'Yuexiu',name_cn:'越秀'}]";
const ONE = "stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]";
const TWO_STORES = COUNTING.replace(ONE, TWO);
const TWO_STORES_ADD = SHELF.replace(ONE, TWO);

const CATCH = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;

run('add stock', [
  ['it is a screen in this app, reached from the home',
    KITCHEN + "state.tab='more';state.stack=[];render();", [
      ['the home offers it', `${body}.indexOf('Add stock')>-1`],
      ['as a push, not a departure', "moreRowsFlat().some(function(r){return r.key==='stockapp'&&!r.href})"],
      ['and it lands on the in-app route', "moreRowsFlat().find(function(r){return r.key==='stockapp'}).cmd.indexOf('stockadd')>-1"],
    ]],
  /* AN OPERATOR WHO RECOUNTS NO LONGER LEAVES, and this case is where that
     reversal is recorded. It used to assert the opposite — a departure carrying
     `/stock?go=add` — which was right while the recount lived in the other app.
     §48 retires that app, so the recount is a mode of THIS screen and there is
     nothing to leave for. The row is still named for the job they hold. */
  ['an operator who recounts stays in this app, named for the counting',
    "state.caps=['quickstock:recount'];state.tab='more';state.stack=[];render();", [
      ['named for the recount', `${body}.indexOf('Quick stock')>-1`],
      ['and it is a push, not a departure',
       "!moreRowsFlat().find(function(r){return r.key==='stockapp'}).href"],
      ['landing on the screen this app carries',
       "moreRowsFlat().find(function(r){return r.key==='stockapp'}).cmd.indexOf('stockadd')>-1"],
      ['and the route admits them', "canRoute('stockadd')===true"],
    ]],

  ['the shelf total never reaches the screen', SHELF, [
    ['the product is there', `${body}.indexOf('Hummus Asli')>-1`],
    ['its SKU is there', `${body}.indexOf('1-10')>-1`],
    ['the count starts at +0', `${body}.indexOf('+0')>-1`],
    ['11 is nowhere on it', `${body}.indexOf('11')===-1`],
  ]],
  ['the head names where it came from and which shelf',
    SHELF + "state.me={name:'R',role:'kitchen',roleName:{en:'Kitchen',cn:'后厨'}};render();", [
      ['back to the home by name', `${body}.indexOf('Kitchen')>-1`],
      ['the store is the status line', `${body}.indexOf('Tianhe')>-1`],
    ]],

  ['taps build one amount, and nothing is written yet',
    SHELF + "APP.cmd('qsBump',7,1);APP.cmd('qsBump',7,1);APP.cmd('qsBump',7,1);", [
      ['three taps read +3', "state.qs.add[7]===3"],
      ['on screen too', `${body}.indexOf('+3')>-1`],
      ['nothing is in flight', "!state.qs.inflight[7]"],
    ]],
  ['and it never goes below zero', SHELF + "APP.cmd('qsBump',7,-1);", [
    ['still +0', "state.qs.add[7]===0"],
  ]],

  /* ── TYPING A BATCH ON THE CARD (§60) ──────────────────────────────────
     ONE TAP PUTS THE CARET IN THE COUNT. The sheet that used to stand between
     cost a second tap to reach its own field and covered the list. These cases
     pin what that tap must produce, the one-write rule at 130, and the §46 line
     the change must not cross. */
  ['one tap on the count turns it into a field, with no sheet in the way',
    SHELF + "APP.cmd('qsType',7);", [
      ['the cell is now an input', "!!document.querySelector('input.qsnum')"],
      ['it asks for the number pad', "document.querySelector('input.qsnum').getAttribute('inputmode')==='numeric'"],
      ['it asks how many were made',
        "document.querySelector('input.qsnum').getAttribute('aria-label')==='How many did you make?'"],
      ['nothing is covering the list', "!state.ask"],
      ['and the commit button stands where the correction door was',
        `${body}.indexOf('Add to stock')>-1 && ${body}.indexOf('Correct the count')===-1`],
    ]],
  /* THE FIELD OPENS EMPTY at the usual +0 — a "0" would have to be cleared
     before anything could be typed over it — and the SHELF never seeds it, which
     is §46: this control has never shown the shelf total and still must not. */
  ['the field opens empty, and never on the shelf figure',
    GRANTED + "APP.cmd('qsType',7);", [
      ['empty rather than a zero to clear', "state.qs.typing[7]===''"],
      ['and not the shelf total, which is 11 on this fixture',
        "document.querySelector('input.qsnum').getAttribute('value')!=='11'"],
    ]],
  ['a batch typed in goes on in ONE write, whatever its size',
    SHELF + CATCH + "APP.cmd('qsType',7); qsTyped(7,'130'); APP.cmd('qsTypeCommit',7);", [
      ['one request, not a hundred and thirty', "window.__sent.length===1"],
      ['carrying the whole batch', "JSON.parse(window.__sent[0].b).delta===130"],
      ['still a delta — §46 is untouched by the door it came through',
        "!('physical_qty' in JSON.parse(window.__sent[0].b))"],
      ['and recorded as production', "JSON.parse(window.__sent[0].b).reason==='kitchen_add'"],
      ['the field is closed and nothing is left pending',
        "state.qs.typing[7]==null && state.qs.add[7]===0"],
    ]],
  /* TYPING NEVER RE-RENDERS. Rebuilding a field under a thumb drops the soft
     keyboard on a real phone — the waste picker learned it, and the rule at the
     head of the Onwards commands states it. So qsTyped stores and does nothing
     else: the node the operator is typing into must be the SAME node after. */
  ['typing does not rebuild the field under the thumb',
    SHELF + "APP.cmd('qsType',7); window.__el=document.querySelector('input.qsnum');"
          + "APP.cmd('qsTyped',7,'13');", [
      ['the digits are held', "state.qs.typing[7]==='13'"],
      ['the very same node is still in the document',
        "document.querySelector('input.qsnum')===window.__el"],
      ['and no focus was armed for the next render to spend', "!state.focus"],
    ]],
  /* A TYPED FIGURE REPLACES THE PENDING TAPS rather than adding to them, and
     stands their 700ms pause down — or the taps behind it land a SECOND write,
     two ledger rows for one batch. */
  ['a typed figure replaces the taps and cancels their pending write',
    SHELF + CATCH + "APP.cmd('qsBump',7,1); APP.cmd('qsBump',7,1);"
          + "APP.cmd('qsType',7); qsTyped(7,'130'); APP.cmd('qsTypeCommit',7);", [
      ['the two taps did not add themselves on', "JSON.parse(window.__sent[0].b).delta===130"],
      ['and their pause was stood down', "!state.qs.timers[7]"],
      ['so still exactly one write', "window.__sent.length===1"],
    ]],
  /* AN EMPTY FIELD IS ZERO, and must CLEAR the pending amount rather than leave
     it. Leaving it stranded the taps: qsTypeOpen has already stood the 700ms
     pause down, so a +5 left on the card would never flush — it would sit there
     until another tap restarted a timer nobody knew had been cancelled. This
     case is written with taps already made for exactly that reason. */
  ['a field cleared to empty adds nothing and leaves nothing stranded',
    SHELF + CATCH + "APP.cmd('qsBump',7,5); APP.cmd('qsType',7); qsTyped(7,''); APP.cmd('qsTypeCommit',7);", [
      ['nothing went on the shelf', "window.__sent.length===0"],
      ['the field is closed', "state.qs.typing[7]==null"],
      ['the five it opened on are gone', "state.qs.add[7]===0"],
      ['and no pause is left armed over them', "!state.qs.timers[7]"],
    ]],
  /* A NON-NUMBER IS NOT STRIPPED TO THE DIGITS INSIDE IT: "13o" silently
     becoming 13 writes a quantity nobody entered. The field stays open. */
  ['a non-number keeps the field open and writes nothing',
    SHELF + CATCH + "APP.cmd('qsType',7); qsTyped(7,'13o'); APP.cmd('qsTypeCommit',7);", [
      ['nothing was written', "window.__sent.length===0"],
      ['the field is still open on what was typed', "state.qs.typing[7]==='13o'"],
      ['it says why', "!!state.qs.typeErr[7]"],
      ['and offers no Retry, which belongs to a failed write',
        `${body}.indexOf('Retry')===-1`],
    ]],
  /* ── THE TWO DEFECTS REPORTED FROM THE FLOOR ON THE FIRST BUILD ──────────
     "* and - doesnt work now if i edit a number manually, also if i dont add a
     number and i just click on the row it stay blank even if i leave the row.
     it should go back to the same dfult it is." Both came from the same cause:
     the field was a mode with no way out, and the keys were disabled inside it,
     so a card tapped by accident was blank AND dead until the app re-rendered
     for some other reason. Three of them were blank at once in the report. */
  ['the keys stay live while a count is being typed',
    SHELF + "APP.cmd('qsType',7);", [
      ['plus is not disabled', "!document.querySelectorAll('.stepbtn')[1].hasAttribute('disabled')"],
    ]],
  ['a key tapped after typing folds the typed number rather than refusing it',
    SHELF + "APP.cmd('qsType',7); qsTyped(7,'130'); APP.cmd('qsBump',7,1);", [
      ['130 became 131', "state.qs.add[7]===131"],
      ['and the field closed behind it', "state.qs.typing[7]==null"],
      ['the card shows it', `${body}.indexOf('+131')>-1`],
    ]],
  ['minus works on a typed number too',
    SHELF + "APP.cmd('qsType',7); qsTyped(7,'130'); APP.cmd('qsBump',7,-1);", [
      ['130 became 129', "state.qs.add[7]===129"],
    ]],
  /* JUNK IS NOT FOLDED INTO A QUANTITY by way of the + key any more than by the
     commit button: "13o" must not become 13 and then 14. */
  ['a key tapped on a non-number says so instead of folding it',
    SHELF + CATCH + "APP.cmd('qsType',7); qsTyped(7,'13o'); APP.cmd('qsBump',7,1);", [
      ['nothing was written', "window.__sent.length===0"],
      ['the amount was not invented', "!state.qs.add[7]"],
      ['and the field is still open, saying why', "state.qs.typing[7]==='13o' && !!state.qs.typeErr[7]"],
    ]],
  /* LEAVING AN EMPTY FIELD PUTS THE CARD BACK. This is the "it should go back
     to the same default" half of the report. */
  ['leaving a field nobody typed in puts the card back to its count',
    SHELF + "APP.cmd('qsBump',7,3); APP.cmd('qsType',7); qsTyped(7,''); APP.cmd('qsTypeBlur',7);", [
      ['the field is closed', "state.qs.typing[7]==null"],
      ['the count it opened on is still there', "state.qs.add[7]===3"],
      ['the cell is a button again, not an input',
        "!document.getElementById('qsnum-7') && !!document.querySelector('button.qsnum')"],
      ['and the commit button went with it', `${body}.indexOf('Add to stock')===-1`],
    ]],
  /* The same revert WITH the grant, where the card has a correction door to put
     back — it is `qsFix` that the commit button stands in for, and this fixture
     is the only one where that door exists to be checked. */
  ['and with the grant, the correction door comes back with it',
    GRANTED + "APP.cmd('qsType',7); qsTyped(7,''); APP.cmd('qsTypeBlur',7);", [
      ['the correction door is on the card again', `${body}.indexOf('Correct the count')>-1`],
      ['and the commit button is gone', `${body}.indexOf('Add to stock')===-1`],
    ]],
  /* A FIELD WITH DIGITS IN IT IS LEFT ALONE — closing it on the way past would
     throw away work nobody asked to discard. */
  ['leaving a field that HAS digits keeps them',
    SHELF + "APP.cmd('qsType',7); qsTyped(7,'130'); APP.cmd('qsTypeBlur',7);", [
      ['still open on what was typed', "state.qs.typing[7]==='130'"],
      ['and still an input', "!!document.getElementById('qsnum-7')"],
    ]],
  /* THE BLUR PATCH MUST NOT REBUILD THE APP. Blur fires on the way to whatever
     was tapped next, so a render() here would replace the very node the tap is
     travelling towards. The stepper buttons either side must survive it. */
  ['leaving an empty field patches the card without rebuilding the row',
    SHELF + "APP.cmd('qsType',7); window.__less=document.querySelectorAll('.stepbtn')[0];"
          + "APP.cmd('qsTypeBlur',7);", [
      ['the minus key is the very same node', "document.querySelectorAll('.stepbtn')[0]===window.__less"],
    ]],
  /* THE DOOR IS THE KITCHEN'S OWN AND NEEDS NO GRANT (§46) — it writes a delta,
     the job this screen exists for. The correction door writes an absolute count
     and needs `quickstock:recount`; one shared function would have handed the
     ungranted operator that write. */
  ['typing a batch needs no recount grant', SHELF, [
    ['the shelf is not shown, so there is no grant', "!state.qs.canRecount"],
    ['and the field still opens', "(APP.cmd('qsType',7), state.qs.typing[7]==='')"],
    ['without opening the correction sheet', "!state.ask"],
  ]],
  /* A RECOUNT KEEPS ITS SHEET (§60). Its count is a bounded decision about a
     figure that is not the operator's own, and the drop fork hangs off it. */
  ['a recount still opens the sheet, not a field on the card',
    COUNTING + "APP.cmd('qsFix',7);", [
      ['the sheet is open', "!!state.ask"],
      ['on the shelf question', "state.ask.title==='Set count'"],
      ['and no field was opened on the card', "!document.querySelector('input.qsnum')"],
    ]],
  ['the typing door refuses a recount outright',
    COUNTING + "qsTypeOpen(7);", [
      ['nothing is being typed', "state.qs.typing[7]==null"],
    ]],

  ['the write is a DELTA — the server refuses anything else from a kitchen',
    SHELF + `window.__sent=[];
      window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body});
        return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };
      APP.cmd('qsBump',7,2); qsFlush(7);`, [
      ['one request', "window.__sent.length===1"],
      ['to this store and product', "window.__sent[0].u.indexOf('/stores/1/stock/7')>-1"],
      ['carrying the delta', "JSON.parse(window.__sent[0].b).delta===2"],
      ['and never an absolute count', "!('physical_qty' in JSON.parse(window.__sent[0].b))"],
      ['the pending amount is cleared', "state.qs.add[7]===0"],
    ]],

  // The two ends of a write are asserted on their own. The probe runs its
  // checks in the same tick as its setup, so a settled promise is not
  // observable here — which is exactly why qsFlush hands its outcomes to two
  // named functions instead of two anonymous promise tails.
  ['a failed write hands the amount back, in the row',
    SHELF + "state.qs.inflight[8]=4; qsWriteFailed(8,4,'Server said no');", [
      ['the four are handed back', "state.qs.add[8]===4"],
      ['the row carries the failure', "state.qs.rowErr[8]==='Server said no'"],
      ['nothing is left in flight', "!state.qs.inflight[8]"],
      ['the message is on the screen', `${body}.indexOf('Server said no')>-1`],
      ['with a way to try again', `${body}.indexOf('Retry')>-1`],
      ['and the amount is still countable', `${body}.indexOf('+4')>-1`],
    ]],
  ['a write that lands leaves the row empty and says what went in',
    SHELF + "state.qs.inflight[7]=2; qsWriteLanded(7,2,state.qs.items[0]);", [
      ['nothing in flight', "!state.qs.inflight[7]"],
      ['nothing owed', "!state.qs.add[7]"],
      ['no error left over', "!state.qs.rowErr[7]"],
      ['and it names the amount and the product', "String(state.toast).indexOf('Added 2')>-1 && String(state.toast).indexOf('Hummus Asli')>-1"],
    ]],
  ['and the flush itself marks the row in flight and clears what is owed',
    SHELF + `window.fetch=function(){ return new Promise(function(){}); };
      APP.cmd('qsBump',7,3); qsFlush(7);`, [
      ['in flight for three', "state.qs.inflight[7]===3"],
      ['the pending amount is handed to the write, not kept', "state.qs.add[7]===0"],
    ]],

  ['a shop with the tool switched off says so, and does not draw a shelf',
    KITCHEN + `state.qs.ctx={enabled:false,stores:[]}; state.qs.ctxTried=true;
      state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`, [
      ['it says so', `${body}.indexOf('Add stock is off')>-1`],
      ['no search field', "!document.getElementById('mQsQ')"],
    ]],
  ['an operator with no store is told what is missing',
    KITCHEN + `state.qs.ctx={enabled:true,stores:[]}; state.qs.ctxTried=true;
      state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`, [
      ['it says so', `${body}.indexOf('No store assigned')>-1`],
    ]],
  // The caret has to BE in the field before it can be kept there: the setup
  // focuses it, as a finger would, and the search must not take it away.
  ['search narrows the shelf without losing the caret',
    SHELF + "document.getElementById('mQsQ').focus(); APP.cmd('qsSearch','tomato');", [
      ['only the match', `${body}.indexOf('Turkish Tomato Salad')>-1 && ${body}.indexOf('Hummus')===-1`],
      ['the field keeps focus', "document.activeElement && document.activeElement.id==='mQsQ'"],
    ]],
  /* THE SEARCH STAYS ON SCREEN while a long shelf scrolls under it (Ash,
     2026-10-12: "search bar should stay stick on top when scrolling"). Forty
     rows, scrolled to the bottom: the field must still be inside the visible
     top of the scroller, not scrolled away with the cards. */
  ['the search stays pinned at the top of a long shelf scrolled to the bottom',
    SHELF + `state.qs.items=Array.from({length:40},function(_,i){
        return {product_id:100+i,name_en:'Shelf item '+i,name_cn:'货架'+i,sku:'9-'+i,physical_qty:5}; });
      render(); document.getElementById('content').scrollTop=1e6;`, [
      ['the list really scrolled', "document.getElementById('content').scrollTop>200"],
      ['the field is still in view, at the top',
        `(function(){ var c=document.getElementById('content').getBoundingClientRect(),
            f=document.getElementById('mQsQ').getBoundingClientRect();
            return f.top>=c.top-1 && f.bottom<=c.top+80; })()`],
    ]],
  /* ── §46: the count, and the one correction it allows ────────────────────
     WITHOUT THE GRANT NOTHING CHANGED — asserted by the case above this block,
     which is every kitchen until an owner ticks the capability on. */
  ['without the grant there is no correction door', SHELF, [
    ['no shelf line', `${body}.indexOf('On the shelf')===-1`],
    ['and nothing to open', `${body}.indexOf('Correct the count')===-1`],
  ]],
  ['the grant shows the count and opens the door', GRANTED, [
    ['the shelf figure is named', `${body}.indexOf('On the shelf')>-1`],
    ['and it is the shelf figure', `${body}.indexOf('11')>-1`],
    ['with a way to correct it', `${body}.indexOf('Correct the count')>-1`],
  ]],
  /* WHAT HAS ALREADY GONE ON TODAY. The half that needs NO grant — it is the
     operator's own work read back, and it is what stops the same batch going
     on twice. Zero is not drawn: "Added today +0" on two hundred cards trains
     the eye to skip the line on the one card where it says something. */
  ['todays adds are read back on the card',
    SHELF + "state.qs.addedToday={7:{qty:6,who:['Ah Ming']}}; render();", [
      ['the line is there', `${body}.indexOf('Added today')>-1`],
      ['carrying what went on', `${body}.indexOf('+6')>-1`],
      /* AND WHO PUT IT THERE. "somebody already added 30" is a weaker answer
         than the name: the name is what tells the reader whether the 30 was
         their own work or the colleague they can go and ask. */
      ['and who put it there', `${body}.indexOf('Ah Ming')>-1`],
    ]],
  ['two people on the same product are both named',
    SHELF + "state.qs.addedToday={7:{qty:14,who:['Ah Ming','Lily']}}; render();", [
      ['the total is the two of them', `${body}.indexOf('+14')>-1`],
      ['the first is named', `${body}.indexOf('Ah Ming')>-1`],
      ['and so is the second', `${body}.indexOf('Lily')>-1`],
    ]],
  /* AN ADD NOBODY CAN BE NAMED FOR IS STILL AN ADD. The units are what keep the
     figure agreeing with the shelf, so a row with no label contributes them and
     no name rather than being dropped. */
  ['an add with no name still counts',
    SHELF + "state.qs.addedToday={7:{qty:9,who:[]}}; render();", [
      ['the units are there', `${body}.indexOf('+9')>-1`],
      ['and no stray separator', `${body}.indexOf('+9 ·')===-1`],
    ]],
  ['a landed write names this operator on the line',
    SHELF + "state.me={name:'Ah Ming'}; state.qs.inflight[7]=2; qsWriteLanded(7,2,state.qs.items[0]);", [
      ['today\u2019s figure moved', "qsAdded(7)===2"],
      ['and it says who', "qsAddedWho(7).indexOf('Ah Ming')>-1"],
    ]],
  ['and it is absent when nothing went on', SHELF, [
    ['no line', `${body}.indexOf('Added today')===-1`],
  ]],

  /* A DROP IS NEVER SAVED UNASKED. 11 on the shelf, 8 counted: the fork opens
     and the wire stays silent until it is answered. */
  ['a drop asks before it writes', GRANTED + CATCH + "qsCountEntered(7,8);", [
    ['the fork is open', "!!state.ask"],
    ['offering the miscount', "state.ask.options.some(function(o){return o.key==='miscount'})"],
    ['and the loss', "state.ask.options.some(function(o){return o.key==='gone'})"],
    ['carrying no waste vocabulary at all',
      "state.ask.options.every(function(o){return ['miscount','gone'].indexOf(o.key)>-1})"],
    ['and nothing has been written', "window.__sent.length===0"],
  ]],
  /* THE ANSWER THAT WRITES NOTHING. The kitchen records no waste, so a loss
     stops here and goes to whoever can record one — and the screen says so
     rather than merely refusing. */
  ['something gone writes nothing and says where it goes',
    GRANTED + CATCH + "qsCountEntered(7,8); APP.cmd('askRun','gone');", [
      ['nothing on the wire', "window.__sent.length===0"],
      ['the shelf is untouched', "state.qs.items[0].physical_qty===11"],
      ['and it says what happens instead', "String(state.toast).indexOf('records waste')>-1"],
    ]],
  ['counted wrong writes an absolute count carrying the answer',
    GRANTED + CATCH + "qsCountEntered(7,8); APP.cmd('askRun','miscount');", [
      ['one request', "window.__sent.length===1"],
      ['an absolute count, never a delta', "JSON.parse(window.__sent[0].b).physical_qty===8"],
      ['the two writes stay two', "!('delta' in JSON.parse(window.__sent[0].b))"],
      ['and it carries the fork answer', "JSON.parse(window.__sent[0].b).recount_reason==='miscount'"],
    ]],
  /* A RISE ASKS NOTHING (§46), ruled that way against the symmetry argument on
     the friction case — so a fork appearing here is a decision reversed in
     silence. And no answer rides along: an upward correction was never asked. */
  ['raising the count asks nothing and claims nothing',
    GRANTED + CATCH + "qsCountEntered(7,19);", [
      ['no fork', "!state.ask"],
      ['one request', "window.__sent.length===1"],
      ['carrying the new count', "JSON.parse(window.__sent[0].b).physical_qty===19"],
      ['and no answer nobody was asked for', "!('recount_reason' in JSON.parse(window.__sent[0].b))"],
    ]],
  ['a count that agrees with the shelf writes nothing at all',
    GRANTED + CATCH + "qsCountEntered(7,11);", [
      ['no fork', "!state.ask"],
      ['and no write', "window.__sent.length===0"],
    ]],

  /* ── §48: the recount, in this app ───────────────────────────────────────
     THE NUMBER IS THE SHELF, not an amount to add. The two modes write
     different things — an absolute count and a delta — so the number is drawn
     differently on purpose: `11` against `+0`. */
  ['counting shows the shelf itself, not an amount to add', COUNTING, [
    ['the product is there', `${body}.indexOf('Hummus Asli')>-1`],
    ['and the shelf figure is the number', `${body}.indexOf('11')>-1`],
    ['nothing is offered to add', `${body}.indexOf('+0')===-1`],
    ['no correction door — counting IS the correction', `${body}.indexOf('Correct the count')===-1`],
    ['and no add-mode second line', `${body}.indexOf('On the shelf')===-1`],
  ]],
  ['the screen is named for the counting', COUNTING, [
    ['its head says so', "T.apply(null, stockAppLabel())==='Quick stock'"],
  ]],
  /* ONE WRITE PER PAUSE, the same rule the add path keeps: a write per tap puts
     six rows in the ledger where one belongs. */
  ['taps move the shelf and one absolute count is written',
    COUNTING + CATCH + "APP.cmd('qsBump',7,1); APP.cmd('qsBump',7,1); qsSetCommit(7);", [
      ['the card followed the taps', "state.qs.items[0].physical_qty===13"],
      ['one request', "window.__sent.length===1"],
      ['carrying the count', "JSON.parse(window.__sent[0].b).physical_qty===13"],
      ['as a recount, never a delta', "!('delta' in JSON.parse(window.__sent[0].b))"],
      ['recorded as an adjustment', "JSON.parse(window.__sent[0].b).reason==='adjust'"],
    ]],
  ['a count typed straight in is saved as it stands',
    COUNTING + CATCH + "qsCountEntered(7,40);", [
      ['one request', "window.__sent.length===1"],
      ['carrying what was typed', "JSON.parse(window.__sent[0].b).physical_qty===40"],
    ]],
  /* A CLERK COUNTING DOWN IS NOT ASKED WHY. §46's fork is a kitchen rule — a
     recount going down is exactly what a recount is for, and the server
     enforces the fork only in add mode. */
  ['counting down asks nothing, because counting down is the job',
    COUNTING + CATCH + "qsCountEntered(7,3);", [
      ['no fork', "!state.ask"],
      ['it just saves', "window.__sent.length===1 && JSON.parse(window.__sent[0].b).physical_qty===3"],
      ['and claims no reason', "!('recount_reason' in JSON.parse(window.__sent[0].b))"],
    ]],
  ['a shelf already at zero cannot be taken lower',
    COUNTING + CATCH + "APP.cmd('qsBump',8,-1); qsSetCommit(8);", [
      ['it stays at zero', "state.qs.items[1].physical_qty===0"],
      ['and a count that did not move writes nothing', "window.__sent.length===0"],
    ]],
  /* THE TWO ENDS OF A RECOUNT, asserted on their own. The probe runs its checks
     in the same tick as its setup, so a settled promise is not observable here
     — which is why qsSetCommit hands its outcomes to two named functions. */
  ['a failed recount hands the shelf back to what it showed',
    COUNTING + "state.qs.setBase[7]=11; state.qs.items[0].physical_qty=40; state.qs.fixing[7]=40;"
             + "qsSetFailed(7,11,'Server said no');", [
      ['the shelf is what it was', "state.qs.items[0].physical_qty===11"],
      ['the row carries the failure', "state.qs.rowErr[7]==='Server said no'"],
      ['nothing left in flight', "state.qs.fixing[7]===undefined"],
      ['no baseline left over', "state.qs.setBase[7]===undefined"],
      ['and it is on the screen', `${body}.indexOf('Server said no')>-1`],
    ]],
  ['a recount that lands leaves nothing behind',
    COUNTING + "state.qs.setBase[7]=11; state.qs.fixing[7]=13; qsSetLanded(7);", [
      ['nothing in flight', "state.qs.fixing[7]===undefined"],
      ['no baseline', "state.qs.setBase[7]===undefined"],
      ['and no error', "!state.qs.rowErr[7]"],
    ]],
  ['the counting screen says which tool is off, not the other one',
    CLERK + `state.qs.ctx={enabled:false,mode:'recount',stores:[]}; state.qs.ctxTried=true;
      state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`, [
      ['named for the counting', `${body}.indexOf('Quick stock is off')>-1`],
      ['and not for the other job', `${body}.indexOf('Add stock is off')===-1`],
    ]],

  /* ── SWITCHING STORE ──────────────────────────────────────────────────
     An operator who holds several stores used to be put on the first and left
     there: the server sent them all and the screen offered no way to change.
     The row is names only, it is absent for one store, and it is locked while
     anything is unsaved — because every write reads the store when it is SENT,
     so a +1 still in its pause would land on the store switched to. */
  ['one store draws no store row', SHELF, [
    ['no store chips', "!document.querySelector('[onclick*=qsStore]')"],
  ]],
  ['two stores draw both, the one in use lit', TWO_STORES, [
    ['both names', `${body}.indexOf('Tianhe')>-1 && ${body}.indexOf('Yuexiu')>-1`],
    ['two chips', "document.querySelectorAll('[onclick*=qsStore]').length===2"],
    ['Tianhe is lit', "document.querySelector('.chip.on').textContent.indexOf('Tianhe')>-1"],
    ['nothing locked', "!document.querySelector('[onclick*=qsStore][disabled]')"],
  ]],
  ['picking Yuexiu reads Yuexiu’s shelf and drops Tianhe’s',
    TWO_STORES + CATCH + "APP.cmd('qsStore','2');", [
      ['the store moved', "state.qs.storeId===2"],
      ['the status line says so', `${body}.indexOf('Yuexiu')>-1 && document.querySelector('.chip.on').textContent.indexOf('Yuexiu')>-1`],
      ['Tianhe’s list is gone, not shown under Yuexiu’s name', "state.qs.items===null"],
      ['Yuexiu’s shelf is asked for', "window.__sent.some(function(x){return x.u.indexOf('/stores/2/stock')>-1})"],
    ]],
  ['a count saved after the switch goes to the new store',
    TWO_STORES + CATCH + `APP.cmd('qsStore','2');
      state.qs.items=[{product_id:7,name_en:'Hummus Asli',sku:'1-10',physical_qty:4}];
      window.__sent=[]; APP.cmd('qsBump',7,1); qsSetCommit(7);`, [
      ['one write', "window.__sent.length===1"],
      ['to Yuexiu', "window.__sent[0].u.indexOf('/stores/2/stock/7')>-1"],
    ]],
  ['a tap still waiting to save locks the other store',
    TWO_STORES + CATCH + "APP.cmd('qsBump',7,1); APP.cmd('qsStore','2');", [
      ['the store did not move', "state.qs.storeId===1"],
      ['Yuexiu is greyed', "!!document.querySelector('[onclick*=qsStore][disabled]')"],
      ['and nothing was written to it', "!window.__sent.some(function(x){return x.u.indexOf('/stores/2/')>-1})"],
    ]],
  ['a write in flight locks it too', TWO_STORES + "state.qs.fixing[7]=12; render(); APP.cmd('qsStore','2');", [
    ['still Tianhe', "state.qs.storeId===1"],
  ]],
  ['an add handed back by a failed write locks it until settled',
    TWO_STORES_ADD + "qsWriteFailed(7,3,'Server said no'); APP.cmd('qsStore','2');", [
      ['still Tianhe', "state.qs.storeId===1"],
      ['the +3 is still on the card', "state.qs.add[7]===3"],
    ]],
  ['a figure being typed locks it', TWO_STORES_ADD + "APP.cmd('qsType',7); APP.cmd('qsStore','2');", [
    ['still Tianhe', "state.qs.storeId===1"],
  ]],
  ['taps that come back to where they started unlock it when the pause ends',
    TWO_STORES + "APP.cmd('qsBump',7,1); APP.cmd('qsBump',7,-1); qsSetCommit(7);", [
      ['nothing pending', "!qsStoreBusy()"],
      ['and it is drawn open', "!document.querySelector('[onclick*=qsStore][disabled]')"],
    ]],
  ['add mode: +1 then −1 unlocks it when the pause ends',
    TWO_STORES_ADD + "APP.cmd('qsBump',7,1); APP.cmd('qsBump',7,-1); qsFlush(7);", [
      ['nothing pending', "!qsStoreBusy()"],
      ['and it is drawn open', "!document.querySelector('[onclick*=qsStore][disabled]')"],
    ]],

  /* SKU ORDER, the order the shelf is walked. The fixture is the one Ash
     photographed — the server's name order put 2-410 above 2-400 — plus a
     2-50 that only a numeric compare puts first and a line with no SKU, which
     sinks rather than sorting as the smallest. */
  ['the list runs in SKU order, not name order',
    KITCHEN + `
      state.qs.ctx={enabled:true,mode:'add',stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]};
      state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true;
      state.qs.items=[
        {product_id:1,name_en:'Almond Butter',sku:'2-410'},
        {product_id:2,name_en:'Almond Butter',sku:'2-400'},
        {product_id:3,name_en:'Almonds (Raw)',sku:'2-350'},
        {product_id:4,name_en:'Apricots',sku:''},
        {product_id:5,name_en:'Basil',sku:'2-50'},
        {product_id:6,name_en:'Cashews',sku:'1-200'}
      ];
      state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`, [
      ['by SKU, numerically, no-SKU last', "qsRows().map(function(p){return p.product_id}).join()==='6,5,3,2,1,4'"],
      ['and the cards are drawn in that order', "(function(){var t=" + body + ";return t.indexOf('2-50')<t.indexOf('2-350')&&t.indexOf('2-350')<t.indexOf('2-400')&&t.indexOf('2-400')<t.indexOf('2-410')})()"],
      ['a search keeps the order', "(state.qs.q='almond', qsRows().map(function(p){return p.product_id}).join()==='3,2,1')"],
      ['and the shelf as loaded is left as it was', "state.qs.items[0].product_id===1"],
    ]],

  ['a role without the permission cannot reach it at all',
    "state.caps=['purchasing:receive'];push('stockadd');render();", [
      ['push refuses it', "state.stack.length===0"],
      ['and the home does not offer it', `${body}.indexOf('Add stock')===-1`],
    ]],
]);
