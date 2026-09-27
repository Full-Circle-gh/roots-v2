#!/usr/bin/env node
/**
 * A flat-list role's home is Tacet Mobile, and the stock-only lockdown is gone.
 *
 *   node scripts/test_confined_role_home.js
 *
 * Decisions §278 (Ash, 2026-09-27) removed the stock-only lockdown: the gate in
 * server.js that kept `kitchen` and `store_stock` inside a short list of
 * endpoints, and lib/stock-app-only.js that held the list. Ash accepted what
 * that means while `tenants.rbac_enforce` is off — those roles reach the
 * backend like any other, and their capabilities shape what they SEE.
 *
 * TWO THINGS ARE ASSERTED:
 *
 *   1. THE GATE IS GONE, and stays gone. No second confinement grows back in
 *      server.js; when enforcement is switched on, the capability layer is what
 *      confines these roles (§278).
 *   2. THE BOOT DOES NOT ASK FOR A BOARD IT HAS NO SCREEN FOR. An operator on
 *      the flat tool list (kitchen, store_stock: none of the tab capabilities)
 *      has no Home board, so `loadLive` stops before the revenue read, and the
 *      60s backstop poll and the live stream stay behind the same answer. Under
 *      the lockdown that early return also stopped a boot loop; without it, it
 *      still stops a phone fetching a board nobody on it can see.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── 1. The lockdown is gone ────────────────────────────────────────────────
section('The stock-only lockdown is gone (§278)');

const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

check('lib/stock-app-only.js is deleted', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'stock-app-only.js')),
    'the allowlist module is back');
});

check('server.js no longer confines a role to a list of endpoints', () => {
  assert.ok(!/stockAppOnlyAllows/.test(SERVER), 'server.js still consults the allowlist');
  assert.ok(!/error: 'kitchen_add_only'/.test(SERVER), 'server.js still refuses with kitchen_add_only');
  assert.ok(!/p === '\/retail-admin' \|\| p\.startsWith\('\/backend\/'\)\) return res\.redirect\('\/m'\)/.test(SERVER),
    'a backend page still bounces a role to /m');
});

check('/stock still forwards to /m — installed shortcuts land somewhere', () => {
  assert.ok(/app\.get\('\/stock'/.test(SERVER), 'the /stock redirect is gone');
});

// ── 2. The app does not ask for the board ──────────────────────────────────
section('The boot does not ask for a board a flat-list role has no screen for');

const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

/* SCOPED TO loadLive's BODY, not to the file. `api('/dashboard?from=` also
   appears in the Home tab's own reload some three thousand lines earlier, and a
   bare indexOf finds THAT one — which reads as the early return sitting after
   the fetch when it sits before it. The first version of this check failed for
   exactly that reason and the offsets are taken from the function now. */
const BOOT = (() => {
  const from = MHTML.indexOf('async function loadLive()');
  assert.ok(from > 0, 'loadLive is gone — this file is asserting against a boot that moved');
  return MHTML.slice(from);
})();

/* The revenue read now sits one level down, in loadToday(), so the boot reaches
   it through a CALL rather than inline — the backstop poll refreshes those tiles
   without re-running the rest of the boot, and both callers have to be gated.
   Following the call instead of the fetch is what keeps this check about the
   guarantee (a flat-list role never reaches /dashboard) rather than about the
   shape loadLive happened to have on the day it was written. The fetch is
   asserted to live in loadToday and nowhere else in the boot, so there is one
   door to watch rather than two. */
const TODAY = (() => {
  const from = MHTML.indexOf('async function loadToday()');
  assert.ok(from > 0, 'loadToday is gone — the revenue read moved again');
  return MHTML.slice(from, MHTML.indexOf('async function loadLive()'));
})();

check('the revenue read has exactly one door, and it is loadToday', () => {
  assert.ok(TODAY.indexOf("api('/dashboard?from=") > 0,
    'the dashboard fetch is not in loadToday — re-check what the gates below are guarding');
  assert.ok(BOOT.indexOf("api('/dashboard?from=") < 0,
    'loadLive fetches the revenue board inline as well — the gate below covers one path of two');
});

check('the boot stops before the revenue board for an operator with no tabs', () => {
  const stop = BOOT.indexOf('if(flatNav()) return;');
  assert.ok(stop > 0, 'loadLive has no flat-role early return — a kitchen phone fetches a board it cannot see');
  const dash = BOOT.indexOf('loadToday()');
  assert.ok(dash > 0, 'the dashboard call moved — re-check which side of it the return sits on');
  assert.ok(stop < dash, 'the early return sits AFTER the dashboard call, so it prevents nothing');
});

/* THE BOARD KEEPS ITSELF CURRENT, which is a SECOND way to reach the same
   revenue endpoint — a 60s backstop poll and a live SSE subscription, neither
   of them started by an operator's tap. Both are shut by the same answer
   flatNav gives the boot: mLiveInit is only REACHED past the early return, and
   every automatic refresh asks mAutoOK first. */
check('and the refresh that needs no tap is behind the same gate', () => {
  const stop = BOOT.indexOf('if(flatNav()) return;');
  const wire = BOOT.indexOf('mLiveInit()');
  assert.ok(wire > 0, 'the live refresh is no longer wired from the boot — re-check what starts it');
  assert.ok(stop < wire, 'the stream is opened before the flat-role return, so a kitchen phone subscribes');

  const from = MHTML.indexOf('function mAutoOK()');
  assert.ok(from > 0, 'mAutoOK is gone — re-check what refuses an automatic refresh');
  const gate = MHTML.slice(from, MHTML.indexOf('\n}', from));
  assert.ok(/flatNav\(\)/.test(gate),
    'an automatic refresh does not ask flatNav — the poll fetches a board with no screen');
});

check('and it stops AFTER /config, which names their home screen', () => {
  const cfg = BOOT.indexOf("api('/config')");
  const stop = BOOT.indexOf('if(flatNav()) return;');
  assert.ok(cfg > 0 && cfg < stop, 'the early return would skip the store name and timezone');
});

check('and before the rest of the board — orders, products, reviews', () => {
  const stop = BOOT.indexOf('if(flatNav()) return;');
  for (const call of ["api('/orders?limit=", "api('/products?limit=", "api('/reviews?limit="]) {
    const at = BOOT.indexOf(call);
    assert.ok(at > 0, `${call} moved out of the boot — re-check this list`);
    assert.ok(stop < at, `${call} is still fetched before the flat-role return`);
  }
});

console.log(`\n${failures ? `${failures} failed, ` : ''}${passed} checks passed.`);
process.exit(failures ? 1 : 0);
