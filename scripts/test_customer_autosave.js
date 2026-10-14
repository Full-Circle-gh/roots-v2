#!/usr/bin/env node
/**
 * The customer record saves itself — decisions §279, batch 1.
 *
 *   node scripts/test_customer_autosave.js
 *
 * No network, no DB, no browser. The desktop's customer engine is SLICED OUT of
 * the shipped public/retail-admin/08-customers.js and run against stubs with
 * the REAL engine (public/tacet-autosave.js), so these assertions move when the
 * real code does. The phone's half is scripts/test_mobile_customers.js.
 *
 * What it locks down:
 *   1. THE PHONE NUMBER IS NEVER AUTOSAVED. PATCH /customers/:id uses a changed
 *      number to claim migration credit and reconcile sign-up vouchers, so it
 *      is not in the draft, not in any autosaved payload, not in the history
 *      snapshot, and so no Undo or restore can ever write it. It has its own
 *      Save, which sends the number and nothing else.
 *   2. AN EDIT GOES OUT ONCE, AFTER THE PAUSE, and an email that would be
 *      refused is held rather than sent.
 *   3. UNDO puts back the record as it was opened, filed as an undo.
 *   4. THE SERVER keeps the history (before and after the write), reads it
 *      back per customer, and files only the notes it knows.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const is = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const section = (t) => console.log('\n' + t);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const SRC = read('public/retail-admin/08-customers.js');
function slice(from, to) {
  const a = SRC.indexOf(from), b = SRC.indexOf(to, a + 1);
  if (a === -1 || b === -1) { console.error('Could not slice 08-customers.js between ' + JSON.stringify(from) + ' and ' + JSON.stringify(to)); process.exit(1); }
  return SRC.slice(a, b);
}
const engine = slice('// ── The customer record saves itself (decisions §279)', 'function _cuSavedTags()');
const phone = slice('async function cuSavePhone() {', '\nasync function cuToggleBlock');

// ── Stubs ────────────────────────────────────────────────────────────────
const SENT = [];
let refuse = null;                 // set to a code to make the next write fail
const FIELDS = {};
const sandbox = {
  console, setTimeout, clearTimeout,
  TacetAutosave: require('../public/tacet-autosave.js'),
  cuT: (en) => en,
  cuTagList: (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean),
  api: async (url, opts) => {
    SENT.push({ url, method: opts && opts.method, body: opts && opts.body });
    if (refuse) { const e = new Error(refuse); e.code = refuse; refuse = null; throw e; }
    return { success: true, changed: opts && opts.body ? Object.assign({}, opts.body) : {} };
  },
  cuWriteRequest: async (o) => { SENT.push({ url: o.url, method: o.method, body: o.body }); return { success: true, changed: o.body }; },
  $: (sel) => (FIELDS[sel] = FIELDS[sel] || { value: '', hidden: true, style: {} }),
  document: { querySelectorAll: () => [], getElementById: () => null },
  cuNotesRepaint: () => {}, cuLoad: () => {}, toast: () => {},
  cuErrClear: () => {}, cuErr: () => {}, cuErrText: (c) => c,
  autosaveRegister: () => {}, autosavePickVersion: async () => null,
  CU_CURRENT: null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext('var CU_CURRENT = null;\n' + engine + '\n' + phone, sandbox);
const run = (src) => vm.runInContext(src, sandbox);

(async () => {
  console.log('customer autosave — §279 batch 1');

  const CUSTOMER = { id: 7, nickname: 'Chen Meiling', phone: '13800000000', email: 'chen@example.com',
    gender: 2, birthday: '1990-04-01', note: 'Allergic to nuts', tags: 'vip,wholesale' };
  run('CU_CURRENT = ' + JSON.stringify({ customer: CUSTOMER }) + '; cuAutoOpen();');

  section('1 · the phone number is never autosaved');
  const payload = run('cuPayload(CU_DRAFT)');
  yes(!('phone' in payload), 'the autosaved payload has no phone field', JSON.stringify(payload));
  yes(!('phone' in run('CU_DRAFT')), 'nor does the draft the editors write into');
  run('CU_DRAFT.nickname = "Chen M."; cuTouch();');
  await wait(900);
  is(SENT.length, 1, 'a name edit is one write after the pause');
  is(SENT[0] && SENT[0].method, 'PATCH', 'a PATCH');
  is(SENT[0] && SENT[0].url, '/api/retail-admin/customers/7', 'to that customer');
  is(SENT[0] && SENT[0].body.nickname, 'Chen M.', 'carrying the name');
  yes(SENT[0] && !('phone' in SENT[0].body), 'and not the phone number');
  SENT.length = 0;
  FIELDS['#cu-edit-phone'] = { value: '13900000000' };
  await run('cuSavePhone()');
  is(SENT.length, 1, 'the number’s own Save is one write');
  is(SENT[0] && SENT[0].body, { phone: '13900000000' }, 'carrying the number and nothing else');

  section('2 · an email that would be refused is held, not sent');
  SENT.length = 0;
  run('CU_DRAFT.email = "chen@"; cuTouch();');
  await wait(900);
  is(SENT.length, 0, 'nothing is sent');
  is(run('CU_AUTO.state'), 'hold', 'the edit is held');
  yes(/email address will not work/.test(run('CU_AUTO.message')), 'and says why');
  run('CU_DRAFT.email = "chen@example.com"; cuTouch();');
  await wait(900);
  is(SENT.length, 0, 'putting it back as it was sends nothing — it is the saved value again');

  section('3 · a note and a tag, then Undo');
  SENT.length = 0;
  run('CU_DRAFT.note = "Buzzer is broken"; CU_DRAFT.tags = CU_DRAFT.tags.concat("late"); cuTouch();');
  await wait(900);
  is(SENT.length, 1, 'both go in one write');
  is(SENT[0] && SENT[0].body.tags, ['vip', 'wholesale', 'late'], 'the tags as a list');
  is(SENT[0] && SENT[0].body.note, 'Buzzer is broken', 'and the note');
  SENT.length = 0;
  run('cuUndo()');
  await wait(50);
  is(SENT.length, 1, 'Undo is one write');
  is(SENT[0] && SENT[0].body.history_note, 'undo', 'filed as an undo');
  is(SENT[0] && SENT[0].body.nickname, 'Chen Meiling', 'the name as the record was opened');
  is(SENT[0] && SENT[0].body.note, 'Allergic to nuts', 'the note too');
  is(SENT[0] && SENT[0].body.tags, ['vip', 'wholesale'], 'and the tags');
  yes(SENT[0] && !('phone' in SENT[0].body), 'and still never the phone number');

  section('4 · a refusal is shown, not retried in a loop');
  SENT.length = 0;
  refuse = 'bad_email';
  run('CU_DRAFT.note = "x"; cuTouch();');
  await wait(900);
  is(SENT.length, 1, 'one attempt');
  is(run('CU_AUTO.state'), 'error', 'the footer says it failed');
  await wait(900);
  is(SENT.length, 1, 'and it does not try again on its own');

  section('5 · the server keeps the history');
  // routes/retail.js and its parts: the customers area now lives in
  // routes/retail/customers.js (decisions §470).
  const RETAIL = require('./test-support/retail-source').retailSource();
  const snap = (RETAIL.match(/function customerSnapshot\(c\) \{[\s\S]*?\n\}/) || [''])[0];
  yes(snap && !/phone/.test(snap.replace(/\/\/.*$/gm, '')), 'the history snapshot leaves the phone number out');
  const patch = RETAIL.slice(RETAIL.indexOf("router.patch('/api/retail-admin/customers/:id'"));
  const patchFn = patch.slice(0, patch.indexOf('\n});'));
  const iBefore = patchFn.indexOf("editHistory.before(tdb(), histTid, 'customer'");
  const iUpdate = patchFn.indexOf('UPDATE retail_customers SET');
  const iAfter = patchFn.indexOf("editHistory.after(tdb(), histTid, 'customer'");
  yes(iBefore !== -1 && iBefore < iUpdate, 'the state before the write is recorded before the write');
  yes(iAfter !== -1 && iAfter > iUpdate, 'and the state after, after it');
  yes(/CUSTOMER_HISTORY_NOTES\.has\(b\.history_note\)/.test(patchFn), 'only known notes are filed');
  yes(/new Set\(\['undo', 'restore'\]\)/.test(RETAIL), 'which are undo and restore');
  yes(/router\.get\('\/api\/retail-admin\/customers\/:id\/history', requireRetailAdmin/.test(RETAIL),
    'the history is read back per customer, behind the admin gate');
  yes(/editHistory\.list\(tdb\(\)/.test(RETAIL), 'from the tenant’s own database');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
