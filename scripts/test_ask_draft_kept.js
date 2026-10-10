#!/usr/bin/env node
/**
 * An unsent request is kept on the phone (§453).
 *
 *   node scripts/test_ask_draft_kept.js
 *
 * Ash, 2026-10-10: a restock filled in on Ask for stock, the phone put down
 * before Send, every quantity gone on return. #1104 stopped the app's own
 * update reload doing that; this covers Android closing a backgrounded browser,
 * which no guard in the page can stop. Each request screen now writes its
 * basket to localStorage as it changes and reads it back on the way in.
 *
 * The functions are SLICED FROM public/m.html and run against a fake
 * localStorage and clock, so this tests the shipped code, not a copy of it.
 *
 * Cases:
 *   1. Ask for stock: a basket survives a "page death" (fresh state, same storage)
 *      with its quantities, both stores and the Restored line
 *   2. Ask the kitchen keeps its purpose; the two screens never share a draft
 *   3. Ask the buyer keeps quantities, urgency, needed-by, and a figure still
 *      in an open field
 *   4. a sent request leaves nothing behind
 *   5. an emptied basket leaves nothing behind
 *   6. Clear empties the basket and the stored copy
 *   7. twelve hours ends a draft
 *   8. another operator, or another tenant, on the same phone gets nothing
 *   9. a store this operator can no longer see is dropped, the list kept
 *  10. no identity yet: nothing is read or written, nothing breaks
 *  11. storage that throws costs the draft, never the paint
 *  12. the wiring: push restores after the clear, render and mbPatch save,
 *      the identity carries the ids, the labels are live pairs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}
function sliceLine(prefix) {
  const at = SRC.indexOf(prefix);
  if (at < 0) throw new Error(`line ${prefix} not found`);
  return SRC.slice(at, SRC.indexOf('\n', at));
}

const STORES = [{ id: 1, name_en: 'Tianhe' }, { id: 2, name_en: 'Yuexiu' }];
const FNS = ['rqReset', 'askDraftKey', 'askDraftSnapshot', 'askDraftSync', 'askDraftWrite',
             'askDraftLoad', 'askDraftClear', 'askRestoredHtml'];
const DECLS = ['const ASK_DRAFT_ROUTES=', 'const ASK_DRAFT_MAX_MS=', 'let _askDraftLast='];

function fakeStorage(throws) {
  const m = new Map();
  return {
    m,
    getItem: k => { if (throws) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (throws) throw new Error('quota'); m.set(k, String(v)); },
    removeItem: k => { if (throws) throw new Error('blocked'); m.delete(k); },
  };
}
/* A fresh page over a given storage and clock — what a phone gets back after
   Android has closed the browser. */
function page(storage, clock, me) {
  const sb = {
    state: {
      me: me === undefined ? { id: 7, tid: 3 } : me,
      stores: STORES.slice(),
      stack: [],
      rq: { products: null, q: '', qty: {}, busy: false, err: '', sent: null, purpose: null, from: null, to: null },
      mb: { qty: {}, typing: {}, typeErr: {}, urg: {}, by: {}, dating: {}, busy: false, err: '', sent: null },
    },
    localStorage: storage,
    Date: { now: () => clock.t },
    T: (en) => en,
    render: () => { vm.runInContext('askDraftSync()', sb); },
    JSON, Object, Number, String, Array, parseFloat,
  };
  vm.createContext(sb);
  for (const d of DECLS) vm.runInContext(sliceLine(d), sb);
  for (const n of FNS) vm.runInContext(sliceFn(n), sb, { filename: `slice#${n}` });
  // push(route) as the shipped one does it for these three screens.
  sb.open = route => {
    if (route === 'askstock' || route === 'askkitchen') { vm.runInContext('rqReset()', sb); vm.runInContext(`askDraftLoad('${route}')`, sb); }
    if (route === 'askbuy') { const m = sb.state.mb; m.qty = {}; m.typing = {}; m.urg = {}; m.by = {}; m.sent = null; m.restored = false;
      vm.runInContext(`askDraftLoad('askbuy')`, sb); }
    sb.state.stack = [{ route }];
    sb.render();
  };
  sb.run = code => vm.runInContext(code, sb);
  return sb;
}
const H = 3600 * 1000;

console.log('1. Ask for stock survives the browser being closed');
{
  const st = fakeStorage(), clock = { t: 1e12 };
  let p = page(st, clock);
  p.open('askstock');
  p.state.rq.to = 2; p.state.rq.from = 1; p.state.rq.qty = { 11: 3, 12: 1, 13: 0 }; p.render();
  ok(st.m.size === 1, 'one draft written');
  clock.t += 2 * H;
  p = page(st, clock);            // the old page is gone
  p.open('askstock');
  ok(p.state.rq.qty[11] === 3 && p.state.rq.qty[12] === 1, 'the quantities are back');
  ok(!('13' in p.state.rq.qty), 'a zero is not carried');
  ok(p.state.rq.to === 2 && p.state.rq.from === 1, 'both stores are back');
  ok(p.state.rq.restored === true, 'and it says so');
  ok(/Restored/.test(p.run('askRestoredHtml(true)')) && /askDraftClear/.test(p.run('askRestoredHtml(true)')), 'the line carries Restored and Clear');
  ok(p.run('askRestoredHtml(false)') === '', 'nothing drawn when nothing was restored');
}

console.log('2. Ask the kitchen keeps its purpose, and never inherits the restock');
{
  const st = fakeStorage(), clock = { t: 1e12 };
  let p = page(st, clock);
  p.open('askstock'); p.state.rq.qty = { 11: 5 }; p.state.rq.to = 2; p.render();
  p.open('askkitchen');
  ok(Object.keys(p.state.rq.qty).length === 0, 'the restock list does not open on the kitchen screen');
  p.state.rq.purpose = 'urgent'; p.state.rq.qty = { 40: 2 }; p.render();
  p = page(st, clock);
  p.open('askkitchen');
  ok(p.state.rq.qty[40] === 2 && !p.state.rq.qty[11], 'the kitchen gets its own list back');
  ok(p.state.rq.purpose === 'urgent', 'with its purpose');
  p.open('askstock');
  ok(p.state.rq.qty[11] === 5 && !p.state.rq.qty[40], 'and the restock gets its own');
  p.state.rq.purpose = null;
  st.m.set('tacet-m-ask:3:7:askkitchen', JSON.stringify({ at: clock.t, d: { qty: { 40: 1 }, purpose: 'nonsense' } }));
  p.open('askkitchen');
  ok(p.state.rq.purpose === null, 'a purpose the server would refuse is not restored');
}

console.log('3. Ask the buyer keeps its marks and an open field');
{
  const st = fakeStorage(), clock = { t: 1e12 };
  let p = page(st, clock);
  p.open('askbuy');
  const m = p.state.mb;
  m.qty = { 5: 2 }; m.urg = { 5: true, 6: true }; m.by = { 5: '2026-10-12' }; m.typing = { 8: '100', 9: '' }; p.render();
  p = page(st, clock);
  p.open('askbuy');
  const n = p.state.mb;
  ok(n.qty[5] === 2 && n.qty[8] === 100, 'quantities, including the figure still being typed');
  ok(!('9' in n.qty), 'an empty field is not a quantity');
  ok(n.urg[5] === 1 && !n.urg[6], 'urgency kept only on a line that is on the list');
  ok(n.by[5] === '2026-10-12', 'needed-by kept');
  ok(n.restored === true, 'and it says so');
}

console.log('4–6. what ends a draft');
{
  const st = fakeStorage(), clock = { t: 1e12 };
  const p = page(st, clock);
  p.open('askstock'); p.state.rq.qty = { 11: 3 }; p.render();
  p.state.rq.sent = { rs: 'RS-1' }; p.render();
  ok(st.m.size === 0, 'a sent request leaves nothing behind');
  p.open('askstock');
  ok(Object.keys(p.state.rq.qty).length === 0, 'and the screen opens empty after it');
  p.state.rq.qty = { 11: 1 }; p.render();
  p.state.rq.qty = { 11: 0 }; p.render();
  ok(st.m.size === 0, 'an emptied basket leaves nothing behind');
  p.state.rq.qty = { 11: 4 }; p.render();
  p.run('askDraftClear()');
  ok(st.m.size === 0 && Object.keys(p.state.rq.qty).length === 0, 'Clear empties the list and the stored copy');
  p.open('askbuy'); p.state.mb.qty = { 5: 1 }; p.render();
  p.state.mb.sent = { mr: 'MR-1' }; p.render();
  ok(st.m.size === 0, 'a sent purchase request leaves nothing behind');
}

console.log('7. twelve hours ends a draft');
{
  const st = fakeStorage(), clock = { t: 1e12 };
  let p = page(st, clock);
  p.open('askstock'); p.state.rq.qty = { 11: 3 }; p.render();
  clock.t += 11.9 * H;
  p = page(st, clock); p.open('askstock');
  ok(p.state.rq.qty[11] === 3, 'just under twelve hours: kept');
  clock.t += 12.1 * H;
  p = page(st, clock); p.open('askstock');
  ok(Object.keys(p.state.rq.qty).length === 0 && !p.state.rq.restored, 'over twelve hours: gone');
  ok(st.m.size === 0, 'and removed from the phone');
}

console.log('8. a shared phone');
{
  const st = fakeStorage(), clock = { t: 1e12 };
  let p = page(st, clock, { id: 7, tid: 3 });
  p.open('askstock'); p.state.rq.qty = { 11: 3 }; p.render();
  p = page(st, clock, { id: 8, tid: 3 }); p.open('askstock');
  ok(Object.keys(p.state.rq.qty).length === 0, 'another operator gets nothing');
  p = page(st, clock, { id: 7, tid: 4 }); p.open('askstock');
  ok(Object.keys(p.state.rq.qty).length === 0, 'the same id at another tenant gets nothing');
  ok(st.m.has('tacet-m-ask:3:7:askstock'), 'and the owner’s draft is still there');
}

console.log('9. a store no longer visible is dropped');
{
  const st = fakeStorage(), clock = { t: 1e12 };
  st.m.set('tacet-m-ask:3:7:askstock', JSON.stringify({ at: clock.t, d: { qty: { 11: 2 }, to: 2, from: 99 } }));
  const p = page(st, clock); p.open('askstock');
  ok(p.state.rq.to === 2 && p.state.rq.from === null, 'the unknown supplier is dropped, the known destination kept');
  ok(p.state.rq.qty[11] === 2, 'the list is kept');
}

console.log('10–11. no identity, broken storage');
{
  const st = fakeStorage(), clock = { t: 1e12 };
  const p = page(st, clock, { id: null, tid: null });
  p.open('askstock'); p.state.rq.qty = { 11: 3 }; p.render();
  ok(st.m.size === 0, 'no identity: nothing written');
  const b = page(fakeStorage(true), clock);
  let threw = null;
  try { b.open('askstock'); b.state.rq.qty = { 11: 3 }; b.render(); } catch (e) { threw = e; }
  ok(!threw, 'storage that throws does not break the paint' + (threw ? ' — ' + threw.message : ''));
  // A paint before the draft block has run (boot) must not throw either.
  const early = vm.createContext({ state: { stack: [{ route: 'askstock' }] } });
  vm.runInContext(sliceFn('askDraftSync'), early);
  vm.runInContext(sliceFn('askDraftWrite'), early);
  threw = null;
  try { vm.runInContext('askDraftSync()', early); } catch (e) { threw = e; }
  ok(!threw, 'a paint before the draft block is defined does not throw');
}

console.log('12. the wiring');
{
  const push = sliceFn('push');
  ok(/rqReset\(\);[\s\S]{0,200}askDraftLoad\(route\)/.test(push), 'push restores Ask for stock / the kitchen after the clear');
  ok(/m\.restored=false;[\s\S]{0,40}askDraftLoad\('askbuy'\)/.test(push), 'push restores Ask the buyer after the clear');
  ok(/askDraftSync\(\)/.test(sliceFn('render')), 'render() saves');
  ok(/askDraftSync\(\)/.test(sliceFn('mbPatch')), 'mbPatch() saves — that screen repaints without render()');
  ok(/window\.addEventListener\('pagehide',askDraftSync\)/.test(SRC), 'saved on pagehide');
  ok(/reg\('askDraftClear', \(\)=>askDraftClear\(\)\)/.test(SRC), 'Clear is a command');
  ok(/id:u\.id!=null\?u\.id:null, tid:\(u\.tenant&&u\.tenant\.id!=null\)\?u\.tenant\.id:null/.test(SRC), 'the identity carries user and tenant ids');
  for (const scr of ['screenAskStock', 'screenAskKitchen', 'screenAskBuy'])
    ok(/askRestoredHtml\(/.test(sliceFn(scr)), scr + ' draws the Restored line');
  // Both labels are live pairs elsewhere in the file, so nothing was composed.
  const live = (en, zh) => SRC.split(`T('${en}','${zh}')`).length - 1;
  ok(live('Restored', '已恢复') >= 3, "'Restored · 已恢复' is a live pair used elsewhere");
  ok(live('Clear', '清除') >= 2, "'Clear · 清除' is a live pair used elsewhere");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
