#!/usr/bin/env node
/**
 * Is this store's Meituan session working? — the Channel Hub's one answer.
 *
 *   node scripts/test_channel_hub_binding.js
 *
 * WHY THIS EXISTS. A Meituan session can stay AUTHENTICATED and still lose the
 * acctId/region context that every stock write and order read needs. The daemon
 * has detected that since the 2026-07-09 outage: noteBindingResult() writes a
 * `binding_lost` / `binding_cleared` latch to meituan_sync_log and pages ops.
 *
 * GET /api/retail-admin/channel-hub/meituan/stores read neither event. The one
 * screen an operator opens to ask *is this store working* answered yes.
 *
 * THE NAIVE FIX IS THE ONE THAT MATTERS HERE. Adding 'binding_lost' to the
 * error filter would leave it racing `lastOkAny` — ANY ok event — and the
 * daemon writes twelve kinds, of which poll_paused, poll_resumed,
 * proxy_elected, proxy_up, queue_resumed and browser_recovered all keep firing
 * while the binding is still gone. Case A below is the live 天河 shape and is
 * the one that proves the difference: it is exactly what the naive filter would
 * have shipped the bug back through.
 *
 * It runs the REAL decideMeituanSignedIn() out of routes/integrations-admin.js
 * — not a copy — so an edit to the route that breaks the rule turns this red
 * rather than leaving a test that agrees with itself. It needs no database: the
 * handler does the reading, the function does the deciding, and only the
 * deciding is in question.
 */
'use strict';

const assert = require('assert');
const { decideMeituanSignedIn } = require('../routes/integrations-admin.js');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// SQLite writes these without a zone, exactly as the log rows carry them.
const at = (s) => ({ created_at: s });
const err = (type, s) => ({ event_type: type, created_at: s });

console.log('\n1 · the binding latch');

it('A · the live 天河 shape: binding lost, then an ok event that is not a recovery', () => {
  // poll_paused fires at closing time and carries status='ok'. Under the old
  // logic — and under the naive filter addition — it is newer than the error
  // and puts the store back to "Signed in" with nothing restored.
  const r = decideMeituanSignedIn({
    bindingLost: true,
    sess: null,
    lastLoginErr: null,
    lastOkAny: at('2026-09-01 22:00:00'),   // poll_paused, hours after the loss
  });
  assert.strictEqual(r.signedIn, false, 'a store with a live binding_lost latch is not signed in');
  assert.strictEqual(r.issue, 'binding_lost');
});

it('B · binding lost and then genuinely cleared', () => {
  // binding_cleared is the newer of the pair, so the latch is down. bindingLost
  // is what the handler computes from that ordering; false is the whole point.
  const r = decideMeituanSignedIn({
    bindingLost: false, sess: null, lastLoginErr: null, lastOkAny: at('2026-09-01 09:00:00'),
  });
  assert.strictEqual(r.signedIn, true);
  assert.strictEqual(r.issue, null);
});

it('C · a second episode after a clear', () => {
  const r = decideMeituanSignedIn({
    bindingLost: true, sess: null, lastLoginErr: null, lastOkAny: at('2026-09-02 11:00:00'),
  });
  assert.strictEqual(r.signedIn, false);
  assert.strictEqual(r.issue, 'binding_lost');
});

it('the latch outranks a relay session that says ok', () => {
  // A relay `ok` says a session EXISTS. It says nothing about which 门店 it
  // points at, so it is not a rival answer to the latch's question.
  const r = decideMeituanSignedIn({
    bindingLost: true, sess: { status: 'ok' }, lastLoginErr: null, lastOkAny: null,
  });
  assert.strictEqual(r.signedIn, false, 'a relay ok must not overturn a lost binding');
  assert.strictEqual(r.issue, 'binding_lost');
});

it('a relay-only tenant reads exactly as before', () => {
  // No daemon means no latch rows at all, so bindingLost is false and the relay
  // branch decides — the behaviour this change must not disturb.
  assert.strictEqual(decideMeituanSignedIn({
    bindingLost: false, sess: { status: 'ok' }, lastLoginErr: null, lastOkAny: null,
  }).signedIn, true);
  assert.strictEqual(decideMeituanSignedIn({
    bindingLost: false, sess: { status: 'expired' }, lastLoginErr: null, lastOkAny: null,
  }).signedIn, false);
  assert.strictEqual(decideMeituanSignedIn({
    bindingLost: false, sess: { status: 'failed' }, lastLoginErr: null, lastOkAny: null,
  }).signedIn, false);
});

console.log('\n2 · the freshness clock, without store_business_status in it');

it('D · signed out, and a business-status read is the newest thing there is', () => {
  // This is the case read_at used to win. getBusinessStatus posts only the
  // wmPoiId cookie (lib/meituan-browser.js) — no acctId, no region — so it keeps
  // answering 200/code:0 through a sign-out. It no longer votes, so the error
  // stands as the newest thing that actually proves something.
  const r = decideMeituanSignedIn({
    bindingLost: false,
    sess: null,
    lastLoginErr: err('needs_login', '2026-09-01 14:00:00'),
    lastOkAny: at('2026-09-01 09:00:00'),
  });
  assert.strictEqual(r.signedIn, false);
  assert.strictEqual(r.issue, 'needs_login');
});

it('E · a recovered store: a real ok newer than an old error', () => {
  const r = decideMeituanSignedIn({
    bindingLost: false,
    sess: null,
    lastLoginErr: err('needs_login', '2026-09-01 09:00:00'),
    lastOkAny: at('2026-09-01 14:00:00'),
  });
  assert.strictEqual(r.signedIn, true, 'a genuine recovery must not read as signed out');
  assert.strictEqual(r.issue, null);
});

it('F · never connected is null, which is not false', () => {
  const r = decideMeituanSignedIn({
    bindingLost: false, sess: null, lastLoginErr: null, lastOkAny: null,
  });
  assert.strictEqual(r.signedIn, null, 'no activity either way is not a negative answer');
  assert.strictEqual(r.issue, null);
});

it('an error exactly as old as the last ok does not flip the store', () => {
  // errAt > okAt, strictly. Equal timestamps mean the ok stands, which is the
  // shipped behaviour and is left alone.
  const r = decideMeituanSignedIn({
    bindingLost: false,
    sess: null,
    lastLoginErr: err('verify_required', '2026-09-01 09:00:00'),
    lastOkAny: at('2026-09-01 09:00:00'),
  });
  assert.strictEqual(r.signedIn, true);
});

it('a signed-in store never carries an issue', () => {
  // issue is gated on signedIn === false, so a stale error under a newer ok
  // cannot leak a word onto a healthy row.
  const r = decideMeituanSignedIn({
    bindingLost: false,
    sess: null,
    lastLoginErr: err('needs_login', '2026-08-30 09:00:00'),
    lastOkAny: at('2026-09-01 09:00:00'),
  });
  assert.strictEqual(r.signedIn, true);
  assert.strictEqual(r.issue, null);
});

if (fails.length) {
  console.log('\n' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('\nok — ' + pass + ' channel-hub binding cases, the route\'s own decision function.');
