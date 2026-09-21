#!/usr/bin/env node
/**
 * THE RECEIVE SCREEN OPENS ON GOODS THAT LEFT, NOT ON A MARK NOBODY MAKES (§208).
 *
 *   node scripts/test_transfer_receive_gate.js
 *
 * Reported from the live app: a transfer sat on "Receive from another shop"
 * reading *"Still on its way. Count it in when it arrives."* — and stayed there,
 * with the boxes on the counter, because no count could ever be opened.
 *
 * THE CAUSE WAS ONE WORD. The screen asked `delivered_at`, and nothing in any
 * client has ever written that column: its only writer is the 'delivered' status
 * transition, and no screen in public/m.html, retail-admin, store-admin or cms
 * calls it. A gate whose key is never cut is a locked door.
 *
 * THE SERVER NEVER WANTED THAT GATE. `PUT /api/restock/:id/receive` tests
 * `goods_state === 'in_transit'` and its own note says why: at Roots the driver
 * marking delivered and the store counting are genuinely concurrent, so one must
 * never gate the other. test_stock_two_step.js already proves the endpoint
 * settles a transfer that was never marked delivered. What was untested — and so
 * what this suite tests — is that the SCREEN now asks the same question the
 * server does.
 *
 * WHY THIS READS SOURCE RATHER THAN DRIVING A BROWSER. Every m.html render suite
 * lives in the slow shard, which is not run (CLAUDE.md, and .github/workflows/
 * tests.yml). A browser suite here would be a test that protects nothing. The
 * gate is one expression, and one expression can be read.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const M = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');
const R = fs.readFileSync(path.join(__dirname, '..', 'routes', 'restock.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const section = t => console.log('\n' + t);

section('1. the gate asks whether the goods left');
ok(/function xfrCountable\(o\)\{ return !!\(o&&o\.goods_state==='in_transit'\); \}/.test(M),
   'xfrCountable is goods_state === in_transit');
ok(/x\.step=xfrCountable\(x\.order\)\?'count':'transit';/.test(M),
   'xfrOpen opens the count through xfrCountable');

section('2. the dead key is gone');
ok(!/xfrArrived/.test(M),
   'xfrArrived no longer exists — neither defined nor called');
// delivered_at may still be read elsewhere in the app (retail orders have their
// own, genuinely written one); what must not come back is a TRANSFER screen
// gating on it. Scoped to the xfr* family, which is this screen's whole surface.
ok(!/function xfr[A-Za-z]*\([^)]*\)\{[^}]*delivered_at/.test(M),
   'no xfr* helper reads delivered_at');

section('3. the screen and the server now ask the same question');
ok(/order\.goods_state !== 'in_transit'/.test(R),
   "the receive endpoint still tests goods_state !== 'in_transit'");
ok(!/delivered_at/.test(R.slice(R.indexOf("router.put('/api/restock/:id/receive'"))),
   'and the receive endpoint reads no delivered_at at all');

section('4. a settled transfer is not told it is still on the road');
ok(/function xfrSettled\(o\)\{ return !!\(o&&\(o\.goods_state==='settled'\|\|o\.received_confirmed_at\)\); \}/.test(M),
   'xfrSettled reads the settled state and the receipt stamp');
ok(/const done=xfrSettled\(o\);/.test(M),
   'the transit screen branches on it');
ok(/\$\{done\?`<div[^`]*>\$\{T\('Counted in','已入库'\)\}<\/div>`:''\}/.test(M),
   "a settled delivery says 'Counted in · 已入库' — a live pair, nothing composed");
ok(/<div style="font-size:18px;font-weight:500">\$\{escAttr\(o\.rs_number/.test(M),
   'and the order number stays on the screen either way');
ok(/T\('Still on its way\. Count it in when it arrives\.','仍在途中，到货后再清点入库。'\)/.test(M),
   'and the on-the-road wording survives for an order whose goods have not left');

console.log('\n' + (fail ? `FAIL — ${fail} failed, ${pass} passed`
                         : `PASS — ${pass} checks`));
process.exit(fail ? 1 : 0);
