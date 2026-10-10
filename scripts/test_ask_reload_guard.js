#!/usr/bin/env node
/**
 * A new build must not reload the phone out from under a request being filled in.
 *
 *   node scripts/test_ask_reload_guard.js
 *
 * Ash, 2026-10-10: a restock filled in on Ask for stock, the phone put down
 * before Send, and every quantity gone on return. The app reloads itself onto a
 * new build the first time it is backgrounded after a deploy, and the only thing
 * standing between that reload and somebody's work is mUnsavedWork(). It named
 * the receive screen, Add stock and the editors — not the three request screens,
 * whose baskets live in memory alone.
 *
 * mUnsavedWork and mReloadNow are SLICED FROM public/m.html and run against
 * stubs, so this tests the shipped code rather than a copy of it.
 *
 * Cases:
 *   1. Ask for stock with a quantity picked holds the reload
 *   2. Ask the kitchen (same basket) likewise
 *   3. a basket mid-send holds it
 *   4. a basket already sent does not — it is a receipt
 *   5. an empty basket does not
 *   6. a basket left behind on a screen that is no longer open does not
 *   7. Ask the buyer with a quantity picked holds it
 *   8. Ask the buyer with a figure still in an open field holds it
 *   9. Ask the buyer with an empty open field does not
 *  10. nothing open: the reload may go, once hidden
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

/* Every global mUnsavedWork reads is stubbed to "nothing owed". It runs inside
   a try/catch that answers false, so a stub left out would not fail loudly —
   it would make every case below read "no work" and the held-reload cases fail
   for the wrong reason. Case 0 pins that the stubs are complete. */
function sandbox(route, rq, mb, hidden) {
  const sb = {
    state: {
      stack: route ? [{ route }] : [],
      rq: Object.assign({ qty: {}, busy: false, sent: null }, rq),
      mb: Object.assign({ qty: {}, typing: {}, busy: false, sent: null }, mb),
      qs: { add: {}, inflight: {} },
      recvPo: null, pc: null,
    },
    rcvToSend: () => [],
    tmAuto: null, rcpAuto: null, matAuto: null,
    cfgBusy: () => false, ML: {},
    PE: null, PUE: null, VD: null, CW: null, FSC: null,
    affDirty: () => false, prDirty: () => false, teDirty: () => false,
    document: { visibilityState: hidden === false ? 'visible' : 'hidden' },
    Object, String, Number,
  };
  vm.createContext(sb);
  vm.runInContext(sliceFn('mUnsavedWork'), sb, { filename: 'slice#mUnsavedWork' });
  vm.runInContext('let swPending=true, swReloaded=false;\n' + sliceFn('mReloadNow'), sb,
    { filename: 'slice#mReloadNow' });
  return sb;
}
const work = (...a) => vm.runInContext('mUnsavedWork()', sandbox(...a));
const reloads = (...a) => vm.runInContext('mReloadNow()', sandbox(...a));

console.log('the stubs are complete');
{
  const sb = sandbox(null);
  // Throws (rather than being swallowed) only if a stub is missing.
  const body = sliceFn('mUnsavedWork').replace(/^[^{]*\{\s*try\{/, '').replace(/\}catch\(e\)\{\}\s*return false;\s*\}$/, '');
  let threw = null;
  try { vm.runInContext('(function(){' + body + '})()', sb); } catch (e) { threw = e; }
  ok(!threw, 'mUnsavedWork runs end to end without a missing global' + (threw ? ' — ' + threw.message : ''));
}

console.log('Ask for stock / Ask the kitchen');
ok(work('askstock', { qty: { 3: 2 } }) === true, 'a quantity picked on Ask for stock is work');
ok(reloads('askstock', { qty: { 3: 2 } }) === false, '…so the build waits, even hidden');
ok(work('askkitchen', { qty: { 3: 1 } }) === true, 'the same basket on Ask the kitchen is work');
ok(work('askstock', { busy: true }) === true, 'a request mid-send is work');
ok(work('askstock', { qty: { 3: 2 }, sent: { rs: 'RS-1' } }) === false, 'a request already sent is not');
ok(work('askstock', { qty: { 3: 0, 4: 0 } }) === false, 'an empty basket is not');
ok(work('home', { qty: { 3: 2 } }) === false, 'a basket left on a screen no longer open is not');

console.log('Ask the buyer');
ok(work('askbuy', {}, { qty: { 9: 12 } }) === true, 'a quantity picked is work');
ok(work('askbuy', {}, { typing: { 9: '100' } }) === true, 'a figure still in an open field is work');
ok(work('askbuy', {}, { typing: { 9: ' ' } }) === false, 'an empty open field is not');
ok(work('askbuy', {}, { busy: true }) === true, 'a request mid-send is work');
ok(work('askbuy', {}, { qty: { 9: 12 }, sent: { mr: 'MR-1' } }) === false, 'a request already sent is not');

console.log('nothing open');
ok(work(null) === false, 'no work anywhere');
ok(reloads(null) === true, 'so the build may reload once hidden');
ok(reloads(null, {}, {}, false) === false, 'but never while the screen is in use');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
