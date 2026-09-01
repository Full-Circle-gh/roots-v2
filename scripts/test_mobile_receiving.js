#!/usr/bin/env node
/**
 * The phone's Receiving screens — the list of deliveries, and the screen that
 * books one in.
 *
 *   node scripts/test_mobile_receiving.js
 *
 * Why these assertions and not others. Receiving is the first screen here that
 * WRITES stock from a phone, and the ways it can be wrong are all quiet:
 *
 *   • A delivery is not a save. The server writes one receipt per save; the
 *     list must show van-loads, with a later revision hanging under the line it
 *     corrects rather than earning a row of its own. A list that counted saves
 *     would climb every time someone fixed a typo.
 *   • The reason codes on the wire must be the SERVER's spelling. A prettier
 *     local set is silent: the save simply refuses, or worse, stores nothing.
 *   • Damage is not a reason, and a recorded damage must stay visible on the
 *     collapsed line. The whole point of the mark is scanning without opening.
 *   • The destination lock has to be SHOWN. The server refuses a store change
 *     once stock is booked (store_locked); a screen that offers the choice
 *     anyway has told the operator something untrue.
 *   • A failed save must keep every number the operator typed. Losing a
 *     delivery's counts at the door is the one failure nobody forgives.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// One purchase order, three suppliers, five lines — the shape the mockup was
// judged on, so the screen can be read against it.
const PO = JSON.stringify({
  id: 3, po_number: 'RPO-0003', supplier: 'Green Farm', status: 'Ordered',
  store_id: 1, receiving_store_id: 1, receiving_store_name_en: 'Tianhe', receiving_store_name_cn: '天河',
  store_name_en: 'Tianhe', store_name_cn: '天河', store_locked: false,
  stores: [{ id: 1, name_en: 'Tianhe', name_cn: '天河' }, { id: 2, name_en: 'Pearl River', name_cn: '珠江新城' }],
  items: [
    { id: 11, name_en: 'Mint', name_cn: '薄荷', sku: 'HRB-MNT', qty: 5, unit: 'kg', supplier_name: 'Green Farm' },
    { id: 12, name_en: 'Coriander', name_cn: '香菜', sku: 'HRB-COR', qty: 3, unit: 'kg', supplier_name: 'Green Farm' },
    { id: 13, name_en: 'Red lentils', name_cn: '红扁豆', sku: 'DRY-RLN', qty: 25, unit: 'kg', supplier_name: 'Wong Dry Goods' },
    { id: 14, name_en: 'Chickpeas', name_cn: '鹰嘴豆', sku: 'DRY-CKP', qty: 20, unit: 'kg', supplier_name: 'Wong Dry Goods' },
    { id: 15, name_en: 'Coconut oil', name_cn: '椰子油', sku: 'OIL-CCO', qty: 12, unit: 'L', supplier_name: 'Sun Oils' },
  ],
});
// The screen as it OPENS: every product unanswered, every counter preloaded at
// the ordered quantity but claiming nothing. Built the way loadReceive builds
// it (`on` false, `was.recv` null — nothing received on the server yet) so the
// probe is testing the shape the app actually holds.
const OPEN = `state.recvId=3; state.recvPo=${PO}; state.recvStore=1;
  state.recvVals=(function(){ var v={};
    state.recvPo.items.forEach(function(it){ v[it.id]={on:false,recv:Math.round(+it.qty),
      dmg:0,reason:null,was:{recv:null,dmg:0,reason:null}}; }); return v; })();
  state.stack=[{route:'receive',title:SUBS.receive.title}]; render();`;
// The whole order answered "it all came", which is what the old screen assumed
// before anyone had touched it. Reached the way an operator reaches it: one tap
// per supplier.
const ALLIN = `APP.cmd('recvGroupAll','Green Farm'); APP.cmd('recvGroupAll','Wong Dry Goods');
  APP.cmd('recvGroupAll','Sun Oils');`;
const OPEN_ALL = OPEN + ALLIN;

// Two deliveries against one order, and a correction on the second.
const DELIVS = JSON.stringify([
  { id: 91, po_id: 3, po_number: 'RPO-0003', received_at: '2026-08-30 08:40:00', line_count: 2,
    actor_label: 'Shun Lai', store_name_en: 'Tianhe', store_name_cn: '天河',
    suppliers: ['Green Farm'], flags: ['short'] },
  { id: 90, po_id: 2, po_number: 'RPO-0002', received_at: '2026-08-29 09:14:00', line_count: 3,
    actor_label: 'Jing Wei', store_name_en: 'Tianhe', store_name_cn: '天河',
    suppliers: ['Wong Dry Goods'], flags: [] },
]);
const DETAIL = JSON.stringify({
  id: 91, po_id: 3, po_number: 'RPO-0003', received_at: '2026-08-30 08:40:00',
  actor_label: 'Shun Lai', store_name_en: 'Tianhe', store_name_cn: '天河',
  suppliers: ['Green Farm'], flags: ['short'], line_count: 2,
  lines: [
    { line_id: 11, name_en: 'Mint', name_cn: '薄荷', unit: 'kg', ordered: 5, qty_received: 4,
      damaged_qty: 0, receipt_reason: 'short_delivery', corrections: [] },
    { line_id: 12, name_en: 'Split peas', name_cn: '豌豆瓣', unit: 'kg', ordered: 10, qty_received: 7,
      damaged_qty: 0, receipt_reason: 'short_delivery',
      corrections: [{ line_id: 12, qty_received: 9, damaged_qty: 0, receipt_reason: 'short_delivery',
        note: 'Miscounted — two sacks were behind the pallet', receipt_id: 95,
        received_at: '2026-08-29 11:40:00', actor_label: 'Jing' }] },
  ],
});
const DELIVS_ONE = JSON.stringify({
  id: 91, po_id: 3, po_number: 'RPO-0003', received_at: '2026-08-30 08:40:00', line_count: 2,
  actor_label: 'Shun Lai', store_name_en: 'Tianhe', store_name_cn: '天河',
  suppliers: ['Green Farm'], flags: ['short'],
});
const SEEN = `state.rcvTried=true; state.rcvDeliv=${DELIVS}; state.rcvSeg='received';
  APP.cmd('push','receiving');`;

// Herbs are bought by the tenth of a kilo. This order is the one from the bug
// report, quantities and all: the screen used to round every figure to a whole
// number, so 0.1 kg of cilantro read "ordered 0 kg" over a stepper stuck at 0 —
// a line that could not be received at all — and 0.5 kg of dill silently became
// 1, booking half a kilo of stock that never arrived. The whole-number lines
// ride along to prove the fix did not put "2.000" on every other row.
const PO_FRAC = JSON.stringify({
  id: 4, po_number: 'RPO-0004', supplier: 'Grain & Oil Shop', status: 'Ordered',
  store_id: 1, receiving_store_id: 1, store_name_en: 'Tianhe', store_name_cn: '天河',
  store_locked: false, stores: [{ id: 1, name_en: 'Tianhe', name_cn: '天河' }],
  items: [
    { id: 21, name_en: 'Cilantro (coriander)', name_cn: '香菜', sku: 'A-18', qty: 0.1, unit: 'kg', supplier_name: 'Grain & Oil Shop' },
    { id: 22, name_en: 'Dill', name_cn: '莳萝', sku: 'A-38', qty: 0.5, unit: 'kg', supplier_name: 'Haoyouxian' },
    { id: 23, name_en: 'Old tofu', name_cn: '老豆腐', sku: 'A-79', qty: 2, unit: 'box', supplier_name: 'Pupu supermarket' },
    { id: 24, name_en: 'Pure Buckwheat Flour', name_cn: '纯荞麦粉', sku: 'B-33', qty: 20, unit: 'kg', supplier_name: 'Handan Chuanglan' },
  ],
});
const OPEN_FRAC = `state.recvId=4; state.recvPo=${PO_FRAC}; state.recvStore=1;
  state.recvVals=(function(){ var v={};
    state.recvPo.items.forEach(function(it){ v[it.id]={on:false,recv:rcvRound(+it.qty),
      dmg:0,reason:null,was:{recv:null,dmg:0,reason:null}}; }); return v; })();
  state.stack=[{route:'receive',title:SUBS.receive.title}]; render();`;
// The fractional order with every product answered "it came". The counters are
// only on the glass once a line is confirmed, so a case that reads a stepper
// has to say so first — one tap per supplier, exactly as the door does it.
const OPEN_FRAC_ALL = OPEN_FRAC + `APP.cmd('recvGroupAll','Grain & Oil Shop');
  APP.cmd('recvGroupAll','Haoyouxian'); APP.cmd('recvGroupAll','Pupu supermarket');
  APP.cmd('recvGroupAll','Handan Chuanglan');`;

const CASES = [
  ['the receive screen', OPEN, [
    ['the order is the title',            `txt('content').includes('RPO-0003')`],
    ['suppliers are the groups',          `txt('content').includes('Green Farm') && txt('content').includes('Wong Dry Goods') && txt('content').includes('Sun Oils')`],
    // The complaint this screen was rebuilt for: it used to open with five
    // filled counters and one button that booked all five, so the only thing
    // it could say was "the whole order came".
    ['nothing is claimed until somebody says it arrived',
      `document.querySelectorAll('.qty:not(.sm)').length === 0`],
    ['every product carries its own answer',
      `[...document.querySelectorAll('.chip')].filter(c=>c.innerText.trim()==='Arrived').length === 5
       && [...document.querySelectorAll('.chip')].filter(c=>c.innerText.trim()==='Not arrived').length === 5`],
    ['and nothing can be recorded until one is given',
      `document.querySelector('.cta').disabled === true && txt('content').includes('Mark at least one product')`],
    // Two answers per product and two per supplier is four more controls on a
    // screen used one-handed at a door. Measured against the app's own column,
    // not the window: nothing may sit outside it, and nothing may be smaller
    // than a thumb that is carrying a box.
    ['every answer is inside the column and thumb-sized',
      `(function(){ var r=document.getElementById('content').getBoundingClientRect();
         var b=[...document.querySelectorAll('.chip'),...document.querySelectorAll('.minibtn')];
         return b.length === 16 && b.every(function(x){ var q=x.getBoundingClientRect();
           return q.left >= r.left-0.5 && q.right <= r.right+0.5 && q.height >= 44; }); })()`],
    ['nothing is short yet, so no reason picker', `!txt('content').includes('Short delivery')`],
    ['no cost figure anywhere',           `!/¥|CNY/.test(txt('content'))`],
    ['the destination is named',          `txt('content').includes('Tianhe')`],
    ['and it can still be changed',       `!txt('content').includes('cannot be received somewhere else')`],
  ]],

  // THE CASE THE REWRITE EXISTS FOR. One product of five turns up; the other
  // four are not a shortfall, a no-show, or a refusal — they are unanswered,
  // and they must stay on the order for the van that brings them.
  ['one product arrives and the rest have not', OPEN + `APP.cmd('recvArrived','11');`, [
    ['only that product opens a counter',
      `[...document.querySelectorAll('.qty:not(.sm)')].map(i=>i.value).join(',') === '5'`],
    ['it can be recorded on its own',   `document.querySelector('.cta').disabled === false`],
    ['and it is the only thing on the wire',
      `rcvToSend().map(it=>it.id).join(',') === '11'`],
    ['the screen says the rest stay on the order',
      `txt('content').includes('4 products not answered yet')`],
    ['its supplier reads as part done, not complete',
      `rcvGroupState(rcvGroups().find(g=>g.name==='Green Farm').items) === 'part'`],
    ['a supplier nobody has answered is waiting, not arrived',
      `rcvGroupState(rcvGroups().find(g=>g.name==='Sun Oils').items) === 'wait'`],
    ['pressing Arrived again takes the answer back',
      `(APP.cmd('recvArrived','11'), state.recvVals[11].on === false
        && document.querySelector('.cta').disabled === true)`],
  ]],

  ['a product that did not come', OPEN + `APP.cmd('recvNotArrived','12');`, [
    ['it is answered, at nothing',   `state.recvVals[12].on === true && state.recvVals[12].recv === 0`],
    ['with the reason a no-show has by definition', `state.recvVals[12].reason === 'not_sent'`],
    ['so the save is not blocked on one', `document.querySelector('.cta').disabled === false`],
    ['and it is recorded, not skipped', `rcvToSend().map(it=>it.id).join(',') === '12'`],
    ['the summary says nothing arrived', `txt('content').includes('Coriander — nothing arrived')`],
  ]],

  // Re-opening a part-received order. The four lines already booked are shown
  // as they stand and are NOT sent again: a receipt row restating a count the
  // server already holds reads as "recorded 5, changed to 5" in the journal.
  ['the second van', `state.recvId=3; state.recvPo=${PO}; state.recvStore=1;
     state.recvPo.items[0].qty_received=5; state.recvPo.items[1].qty_received=3;
     state.recvVals=(function(){ var v={};
       state.recvPo.items.forEach(function(it){ var had=it.qty_received==null?null:Math.round(+it.qty_received);
         v[it.id]={on:had!=null,recv:had==null?Math.round(+it.qty):had,dmg:0,reason:null,
                   was:{recv:had,dmg:0,reason:null}}; }); return v; })();
     state.stack=[{route:'receive',title:SUBS.receive.title}]; render();`, [
    ['what already came is shown, already answered',
      `state.recvVals[11].on === true && state.recvVals[12].on === true`],
    ['what has not is still unanswered', `state.recvVals[13].on === false`],
    ['nothing is re-sent on its own',    `rcvToSend().length === 0 && document.querySelector('.cta').disabled === true`],
    ['ticking in the new arrival sends only that',
      `(APP.cmd('recvArrived','13'), rcvToSend().map(it=>it.id).join(',') === '13')`],
    ['and correcting an old count sends that too',
      `(APP.cmd('recvQtySet','11|4'), rcvToSend().map(it=>it.id).sort().join(',') === '11,13')`],
  ]],

  ['a line ordered by the tenth of a kilo', OPEN_FRAC_ALL, [
    ['0.1 kg is not rounded away to nothing', `txt('content').includes('ordered 0.1 kg')`],
    ['0.5 kg is not rounded up to 1',         `txt('content').includes('ordered 0.5 kg')`],
    ['whole lines keep their plain figures',  `txt('content').includes('ordered 2 box') && txt('content').includes('ordered 20 kg')`],
    ['and carry no invented decimals',        `!/ordered (2\\.0|20\\.0)/.test(txt('content'))`],
    ['every stepper is prefilled at what was ordered',
      `[...document.querySelectorAll('.qty:not(.sm)')].map(i=>i.value).join(',') === '0.1,0.5,2,20'`],
    // "Not arrived" is on every product as a button now, so the no-show test
    // is asked of the STATE rather than of the text: no line may be sitting at
    // zero, and nothing may be reported as a no-show in the summary.
    ['so no fractional line reads as a no-show',
      `state.recvPo.items.every(it=>!rcvNo(it)) && !txt('content').includes('nothing arrived')`],
  ]],

  ['stepping a fractional line', OPEN_FRAC_ALL, [
    ['+ moves it by a tenth, not a whole kilo',
      `(APP.cmd('recvQty','21|0.1'), state.recvVals[21].recv === 0.2)`],
    ['and repeated taps do not drift into binary floating point',
      `(APP.cmd('recvQty','21|0.1'), state.recvVals[21].recv === 0.3)`],
    ['− brings it back down',
      `(APP.cmd('recvQty','21|-0.1'), state.recvVals[21].recv === 0.2)`],
    ['a whole-number line still steps by one',
      `(APP.cmd('recvQty','23|1'), state.recvVals[23].recv === 3)`],
    ['a fraction can be typed straight in',
      `(APP.cmd('recvQtySet','22|0.25'), state.recvVals[22].recv === 0.25)`],
    ['the keypad offered is the one with a decimal point on it',
      `[...document.querySelectorAll('.qty')].every(i=>i.getAttribute('inputmode')==='decimal')`],
  ]],

  ['half of a half-kilo line arrives', OPEN_FRAC + `APP.cmd('recvQtySet','22|0.2');`, [
    ['the shortfall is stated in the same fractions',
      `txt('content').includes('0.3 kg short of 0.5')`],
    ['and not as a whole-number difference',
      `!txt('content').includes('1 kg short')`],
    ['the summary agrees with the line',
      `txt('content').includes('Dill — 0.3 kg short')`],
  ]],

  // Typed entry is the path that used to mangle fractions worst: the old reader
  // stripped every non-digit, so "0.1" arrived as 1 — a tenth of a kilo of
  // damage booked as a whole one, then quietly capped at whatever turned up.
  ['damage on a fractional line', OPEN_FRAC_ALL + `APP.cmd('recvDmgOpen','22');`, [
    ['a typed tenth stays a tenth',
      `(APP.cmd('recvDmgSet','22|0.1'), state.recvVals[22].dmg === 0.1)`],
    ['the mark shows the fraction, not a rounded whole',
      `[...document.querySelectorAll('.dmgbtn')].some(b=>b.innerText.trim()==='0.1')`],
    ['the stepper moves it by a tenth too',
      `(APP.cmd('recvDmg','22|0.1'), state.recvVals[22].dmg === 0.2)`],
    ['and damage still cannot exceed what arrived',
      `(APP.cmd('recvDmgSet','22|5'), state.recvVals[22].dmg === 0.5)`],
  ]],

  // The other half of the round trip. A fractional delivery that saved
  // correctly still read back through Math.round, so 0.2 of 0.5 kg reappeared
  // in the record as "0 / 1 kg" — the receipt disagreeing with itself.
  ['a fractional delivery read back', SEEN + `state.rcvOpen=91;
     state.rcvDetail=Object.assign(${DETAIL},{lines:[{line_id:22,name_en:'Dill',name_cn:'莳萝',
       unit:'kg',ordered:0.5,qty_received:0.2,damaged_qty:0.05,returned_qty:0,
       receipt_reason:'short_delivery',corrections:[]}]}); render();`, [
    ['arrived-of-ordered keeps both fractions', `txt('content').includes('0.2 / 0.5 kg')`],
    ['and is not rounded to a whole delivery',  `!txt('content').includes('0 / 1 kg')`],
    ['the shortfall matches the figures above it', `txt('content').includes('0.3 kg short')`],
    ['damage below a whole unit is still shown',   `txt('content').includes('0.05 kg damaged')`],
  ]],

  ['a line comes up short', OPEN_ALL + `APP.cmd('recvQtySet','11|4');`, [
    ['the shortfall is stated, not asked for', `txt('content').includes('1 kg short of 5')`],
    ['all three reasons are offered',    `txt('content').includes('Short delivery') && txt('content').includes('Wrong item') && txt('content').includes('Not sent')`],
    ['damage is not one of them',        `!/\\bDamaged\\b/.test(txt('content'))`],
    // All three on screen at once — measured against the viewport this probe
    // actually lays out in, not a phone width guessed at in the assertion.
    ['and none is visible only by scrolling sideways',
      `(function(){ var c=[...document.querySelectorAll('.chip')]
         .filter(x=>/Short delivery|Wrong item|Not sent/.test(x.innerText));
         return c.length === 3 && c.every(x=>x.getBoundingClientRect().right <= document.documentElement.clientWidth); })()`],
    ['the save is blocked until a reason is picked',
      `document.querySelector('.cta').disabled === true && /needs? a reason/.test(txt('content'))`],
    ['picking one unblocks it',
      `(APP.cmd('recvReason','11|short_delivery'), document.querySelector('.cta').disabled === false)`],
    ['and the summary names the line, not a unit count',
      `txt('content').includes('Mint — 1 kg short')`],
  ]],

  ['raising the count back clears the reason', OPEN_ALL
    + `APP.cmd('recvQtySet','11|4'); APP.cmd('recvReason','11|short_delivery'); APP.cmd('recvQtySet','11|5');`, [
    ['no shortfall left to explain', `state.recvVals[11].reason === null`],
    ['and the picker is gone',       `!txt('content').includes('Short delivery')`],
  ]],

  // Typing a number IS an answer. Making someone press Arrived after they had
  // already told the screen how many arrived would be the app arguing with them.
  ['a count typed straight in', OPEN + `APP.cmd('recvQtySet','13|20');`, [
    ['the line is confirmed by the typing', `state.recvVals[13].on === true`],
    ['at what was typed',                   `state.recvVals[13].recv === 20`],
    ['and it is on the wire',               `rcvToSend().map(it=>it.id).join(',') === '13'`],
  ]],

  ['damage', OPEN_ALL + `APP.cmd('recvDmgOpen','14'); APP.cmd('recvDmg','14|1'); APP.cmd('recvDmg','14|1');`, [
    ['the counter opened on one tap',  `txt('content').includes('How many damaged?')`],
    ['two are recorded',               `state.recvVals[14].dmg === 2`],
    ['and it is NOT treated as short', `!txt('content').includes('short of 20')`],
    ['the mark keeps the count when the counter closes',
      `(APP.cmd('recvDmgOpen','14'), !txt('content').includes('How many damaged?')
        && [...document.querySelectorAll('.dmgbtn')].some(b=>b.innerText.trim()==='2'))`],
    ['the summary names it as damage', `txt('content').includes('Chickpeas — 2 kg damaged')`],
  ]],

  ['damage cannot exceed what arrived', OPEN_ALL
    + `APP.cmd('recvDmgSet','14|20'); APP.cmd('recvQtySet','14|3');`, [
    ['lowering the arrival lowers the damage with it', `state.recvVals[14].dmg === 3`],
  ]],

  ['a supplier that did not turn up', OPEN + `APP.cmd('recvGroupNone','Sun Oils');`, [
    ['its line goes to zero',        `state.recvVals[15].recv === 0`],
    ['answered, not merely empty',   `state.recvVals[15].on === true`],
    ['stamped not_sent',             `state.recvVals[15].reason === 'not_sent'`],
    ['the header says so',           `rcvGroupState(rcvGroups().find(g=>g.name==='Sun Oils').items) === 'none'`],
    ['the summary reads as a no-show', `txt('content').includes('Coconut oil — nothing arrived')`],
    ['and it can be undone',         `(APP.cmd('recvGroupAll','Sun Oils'), state.recvVals[15].recv === 12 && state.recvVals[15].reason === null)`],
  ]],

  ['a supplier whose whole van came', OPEN + `APP.cmd('recvGroupAll','Wong Dry Goods');`, [
    ['both its lines are answered at what was ordered',
      `state.recvVals[13].recv === 25 && state.recvVals[14].recv === 20
       && state.recvVals[13].on === true && state.recvVals[14].on === true`],
    ['nobody else was answered for',  `state.recvVals[11].on === false && state.recvVals[15].on === false`],
    ['pressing it again takes it back',
      `(APP.cmd('recvGroupAll','Wong Dry Goods'), state.recvVals[13].on === false && state.recvVals[14].on === false)`],
  ]],

  ['the destination, once stock is booked', `state.recvId=3;
     state.recvPo=Object.assign(${PO},{store_locked:true,stores:[]}); state.recvStore=1;
     state.recvVals={11:{recv:5,dmg:0,reason:null}};
     state.stack=[{route:'receive',title:SUBS.receive.title}]; render();`, [
    ['it is shown locked, not silently disabled', `txt('content').includes('cannot be received somewhere else')`],
    ['the reason is given',                       `txt('content').includes('transfer')`],
    ['and no other store is offered',             `!txt('content').includes('Pearl River')`],
  ]],

  ['a save that fails keeps the work', OPEN_ALL
    + `APP.cmd('recvQtySet','11|4'); APP.cmd('recvReason','11|short_delivery');
       state.recvSaveErr='That did not save.'; render();`, [
    ['the counts are still on screen', `[...document.querySelectorAll('.qty:not(.sm)')].map(i=>i.value).join(',') === '4,3,25,20,12'`],
    ['the reason is still picked',     `state.recvVals[11].reason === 'short_delivery'`],
    ['the failure is stated',          `txt('content').includes('That did not save')`],
    ['and the button is still there',  `!!document.querySelector('.cta')`],
  ]],

  ['the delivery list', SEEN, [
    ['newest first',              `txt('content').indexOf('Shun Lai') < txt('content').indexOf('Jing Wei')`],
    ['who took it in',            `txt('content').includes('Shun Lai')`],
    ['where it went',             `txt('content').includes('Tianhe')`],
    ['the supplier, not the PO',  `txt('content').includes('Green Farm')`],
    ['a clean one says so',       `txt('content').includes('Clean')`],
    ['a short one is marked',     `txt('content').includes('Short')`],
    ['no cost figures here either', `!/¥|CNY/.test(txt('content'))`],
  ]],

  ['a delivery opened', SEEN + `state.rcvOpen=91; state.rcvDetail=${DETAIL}; render();`, [
    ['lines read arrived-of-ordered', `txt('content').includes('4 / 5 kg')`],
    ['the reason code is spelled out', `txt('content').includes('Short delivery')`],
    ['a correction hangs under its line, as a sentence',
      `txt('content').includes('Shun Lai recorded 7, Jing changed to 9')`],
    ['with why it changed',       `txt('content').includes('two sacks were behind the pallet')`],
    ['and the PO is a way through', `txt('content').includes('RPO-0003')`],
  ]],

  ['a correction with no history behind it', SEEN + `state.rcvOpen=91;
     state.rcvDetail=Object.assign(${DETAIL},{lines:[{line_id:12,name_en:'Split peas',name_cn:'豌豆瓣',
       unit:'kg',ordered:10,qty_received:null,damaged_qty:0,receipt_reason:null,
       corrections:[{line_id:12,qty_received:9,damaged_qty:0,receipt_reason:null,note:null,
         receipt_id:95,received_at:'2026-08-29 11:40:00',actor_label:'Jing'}]}]}); render();`, [
    ['it reads as a whole thought, not half a trail',
      `txt('content').includes('Jing changed this to 9')`],
    ['and says why there is nothing before it',
      `txt('content').includes('before deliveries were kept')`],
  ]],

  // The complaint this search exists to answer: "which delivery brought the
  // mint?" Before this, the haystack was supplier / store / person only, so the
  // answer was to open purchase orders one at a time.
  ['searching Received by product', `state.rcvTried=true; state.rcvSeg='received'; state.rcvQ='mint';
     state.rcvDeliv=[Object.assign(${DELIVS_ONE}, {matched_lines:[{name_en:'Mint',name_cn:'薄荷',sku:'HRB-MNT'}]})];
     APP.cmd('push','receiving');`, [
    ['the delivery that carried it is listed', `txt('content').includes('Green Farm')`],
    ['and the row NAMES the product, so nothing has to be opened',
      `txt('content').includes('Mint')`],
    ['the box says products are searchable',
      `!!document.querySelector('#mRcvQ') && /Product/.test(document.querySelector('#mRcvQ').placeholder)`],
  ]],

  ['To receive has its own search', `state.rcvToTried=true; state.rcvSeg='toreceive';
     state.rcvTo=[{id:3,po_number:'RPO-0003',supplier:'Green Farm',status:'Ordered',line_count:5,
       store_name_en:'Tianhe',store_name_cn:'天河',delivery_date:'2026-09-02',
       matched_lines:[{name_en:'Mint',name_cn:'薄荷',sku:'HRB-MNT'}]}];
     state.rcvToQ='mint'; APP.cmd('push','receiving');`, [
    ['there is a search box at all', `!!document.querySelector('#mRcvToQ')`],
    ['it says a product or SKU will do', `/Product|SKU/.test(document.querySelector('#mRcvToQ').placeholder)`],
    ['the order bringing it is listed', `txt('content').includes('RPO-0003')`],
    ['and the matching product is named on the row', `txt('content').includes('Mint')`],
  ]],

  // The receive route moves a PO to Delivered on the first arrived count it is
  // given. Without this, confirming the one product that turned up would drop
  // the other four out of the only list that leads back to them.
  ['an order with goods still to come', `state.rcvToTried=true; state.rcvSeg='toreceive';
     state.rcvTo=[{id:3,po_number:'RPO-0003',supplier:'Green Farm',status:'Delivered',
       line_count:5,received_lines:1,store_name_en:'Tianhe',store_name_cn:'天河'}];
     state.rcvToQ=''; APP.cmd('push','receiving');`, [
    ['is still waiting to be received',  `rcvToReceive().length === 1`],
    ['and says how much of it is left',  `txt('content').includes('4 of 5 still to come')`],
    ['read as part arrived, not received', `txt('content').includes('Part arrived')`],
  ]],

  ['an order with nothing left to come', `state.rcvToTried=true; state.rcvSeg='toreceive';
     state.rcvTo=[{id:3,po_number:'RPO-0003',supplier:'Green Farm',status:'Delivered',
       line_count:5,received_lines:5,store_name_en:'Tianhe',store_name_cn:'天河'}];
     state.rcvToQ=''; APP.cmd('push','receiving');`, [
    ['has left the list',        `rcvToReceive().length === 0`],
    ['and does not linger on it', `!txt('content').includes('RPO-0003')`],
  ]],

  ['a product nothing is bringing', `state.rcvToTried=true; state.rcvSeg='toreceive';
     state.rcvTo=[]; state.rcvToQ='saffron'; APP.cmd('push','receiving');`, [
    ['says so plainly', `txt('content').includes('No order on its way has that')`],
    ['and does not read as an empty warehouse', `!txt('content').includes('Nothing on its way')`],
  ]],

  ['nothing received yet', `state.rcvTried=true; state.rcvDeliv=[]; state.rcvSeg='received';
     APP.cmd('push','receiving');`, [
    ['says so',        `txt('content').includes('No deliveries yet')`],
    ['and invents none', `!txt('content').includes('RPO-')`],
  ]],

  ['the list would not load', `state.rcvTried=true; state.rcvErr='Could not load deliveries.';
     state.rcvSeg='received'; APP.cmd('push','receiving');`, [
    ['says so',           `txt('content').includes('Could not load deliveries')`],
    ['rather than empty', `!txt('content').includes('No deliveries yet')`],
    ['and offers a retry', `txt('content').includes('Try again')`],
  ]],
];

run('receiving', CASES);
