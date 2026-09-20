#!/usr/bin/env node
/**
 * §138 — what the customer was told is part of the order.
 *
 *   node scripts/test_order_notice_record.js
 *
 * THE QUESTION. The checkout shows one of four notices when something in the
 * cart is sold out or the order has moved shop. Three weeks later — "you told
 * me it would arrive on the 20th" — that has to be answerable from the order.
 *
 * WHAT WAS ALREADY THERE, which is the point this suite exists to hold. The two
 * DATED notices already land on the order: computeBatchNotice and
 * computeLocalFreshNotice both stamp promised_ship_date / promised_delivery_date
 * in the best-effort block after the write. §138 adds only the two that carry no
 * date. A later change that moves either half without the other leaves an order
 * that half-remembers, so both halves are asserted here together.
 *
 * NO DB AND NO NETWORK. routes/retail.js pulls in better-sqlite3 and cannot be
 * required; it is read as source, the split scripts/test_store_move_notice.js
 * uses for the same reason. What is checkable this way is the SHAPE — that the
 * write exists, that it is recomputed rather than taken from the client, that it
 * cannot fail the order, and that something reads it back.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
const dbSrc    = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'public/retail-admin/04-orders.js'), 'utf8');

let failed = 0;
function check(name, fn) {
  let ok = false;
  try { ok = !!fn(); } catch (e) { ok = false; }
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) failed++;
}

console.log('\n§138 · the order remembers what the checkout said');

check('both columns exist, and are nullable so old orders stay honest', () =>
  /addColumn\('retail_orders', 'preorder_pids',\s+'TEXT'\);/.test(dbSrc)
  && /addColumn\('retail_orders', 'moved_from_store',\s+'TEXT'\);/.test(dbSrc));

check('the dated pair is untouched — it was already the audit trail', () =>
  /addColumn\('retail_orders', 'promised_ship_date',\s+'TEXT'\);/.test(dbSrc)
  && /UPDATE retail_orders SET promised_ship_date = \?, promised_delivery_date = \? WHERE id = \?/.test(routeSrc));

check('…and both of its writers are still there', () => {
  const stamps = (routeSrc.match(/SET promised_ship_date = \?, promised_delivery_date = \?/g) || []).length;
  return stamps === 2;   // computeBatchNotice (courier) and computeLocalFreshNotice (local run)
});

check('the pre-order ids are written from the server’s own recompute', () =>
  /const preorderNotice = computePreorderNotice\(/.test(routeSrc)
  && /UPDATE retail_orders SET preorder_pids = \? WHERE id = \?/.test(routeSrc));

// A record meant to settle a dispute is worth nothing if the other party
// supplied it. `body.items` is the CART (what to price), never the notice.
check('…and never from a notice the client handed back', () =>
  !/body\.(preorder_notice|batch_notice|local_fresh_notice|store_move_notice)/.test(routeSrc));

// computeStoreMoveNotice returns null when the operator has not written its copy
// — right for a banner, wrong for a record, because the order moved anyway.
check('the move is recorded as a FACT, not as the notice', () => {
  const at = routeSrc.indexOf('UPDATE retail_orders SET moved_from_store = ?');
  if (at < 0) return false;
  // The write is fed by the routing question, not by the banner.
  if (!/inventory\.routeIgnoringClosures\(address\)/.test(routeSrc.slice(Math.max(0, at - 700), at))) return false;
  // …and the banner is still CALLED exactly once in this file: from the quote,
  // for the shopper. A second call site would mean the record had started
  // depending on whether the operator had written the copy.
  // (Matched as a call, so the function's own declaration is not counted.)
  return (routeSrc.match(/computeStoreMoveNotice\(/g) || []).length === 2;  // 1 declaration + 1 call
});

check('…and only when it actually differs from the shop that took the order', () => {
  const at = routeSrc.indexOf('UPDATE retail_orders SET moved_from_store = ?');
  const win = routeSrc.slice(Math.max(0, at - 600), at);
  return /wouldBe\.code !== fulfillingStore\.code/.test(win);
});

// routeOrder drops closed stores BEFORE ranking, so its own reason can never
// say what the closure changed. This is why a new column was needed at all.
check('routing_reason could not have answered it, and the helper says why', () => {
  const inv = fs.readFileSync(path.join(ROOT, 'lib/inventory.js'), 'utf8');
  return /routeOrder drops closed stores BEFORE it ranks/.test(inv)
    && /async function routeIgnoringClosures/.test(inv);
});

// A record ABOUT an order must never be able to cost us the order.
check('neither write can fail the order it describes', () => {
  for (const marker of ['UPDATE retail_orders SET preorder_pids = ?',
                        'UPDATE retail_orders SET moved_from_store = ?']) {
    const at = routeSrc.indexOf(marker);
    if (at < 0) return false;
    const win = routeSrc.slice(Math.max(0, at - 900), at + 400);
    if (!/try \{/.test(win) || !/catch \(e\) \{ console\.warn\(/.test(win)) return false;
  }
  return true;
});

check('…and both run after the order transaction, never inside it', () => {
  const tx = routeSrc.indexOf('try { orderId = tx.immediate(); }');
  const pre = routeSrc.indexOf('UPDATE retail_orders SET preorder_pids = ?');
  const mov = routeSrc.indexOf('UPDATE retail_orders SET moved_from_store = ?');
  return tx > -1 && pre > tx && mov > tx;
});

// A column nobody can read is not an audit trail.
check('the admin is sent both columns', () =>
  /o\.preorder_pids, o\.moved_from_store,/.test(routeSrc));

check('…and draws both, beside the note that answers the same question', () =>
  /function preorderSoldNote\(o\)/.test(adminSrc)
  && /function movedFromNote\(o\)/.test(adminSrc)
  && /\$\{rerouteShortNote\(o\)\}\s*\n\s*\$\{preorderSoldNote\(o\)\}\s*\n\s*\$\{movedFromNote\(o\)\}/.test(adminSrc));

// Asserted as behaviour rather than as the exact source lines: an earlier draft
// pinned the try/catch text and went red when a comment was added inside it,
// which taught nothing. Both notes must bail to '' before drawing anything.
check('an order with neither draws nothing at all', () => {
  const bodyOf = (decl) => {
    const at = adminSrc.indexOf(decl);
    if (at < 0) return '';
    const rest = adminSrc.slice(at);
    const end = rest.indexOf('\n}');
    return end < 0 ? '' : rest.slice(0, end);
  };
  const pre = bodyOf('function preorderSoldNote(o)');
  const mov = bodyOf('function movedFromNote(o)');
  return !!pre && !!mov
    && /if \(!pids\.length\) return '';/.test(pre)
    && /o\.preorder_pids \|\| '\[\]'/.test(pre)
    && /if \(!code\) return '';/.test(mov)
    && /o\.moved_from_store \|\| ''/.test(mov);
});

// An unparseable column must not cost the whole drawer for a decorative line.
check('…and an unreadable column is treated as "nothing was said"', () => {
  const at = adminSrc.indexOf('function preorderSoldNote(o)');
  const win = adminSrc.slice(at, at + 700);
  return /catch \(e\) \{ pids = \[\]; \}/.test(win);
});

/* The drawer and the screen the customer read must name it the same way.

   §194 PUT AN OPERATOR OVERRIDE IN FRONT OF THAT KICKER, and the assertion is
   now on the DEFAULT rather than on a bare literal. The pair below is still the
   word a tenant who has configured nothing sees, which is the case this check
   was written for.

   A TENANT WHO RENAMES THE KICKER DOES NOT RENAME THE DRAWER, and that is Rule
   1 of the vocabulary document working rather than a gap: the popup is the
   CUSTOMER register and the drawer chip is the OPERATOR register, and a
   cross-register difference is deliberate. An operator reading the orders list
   needs one stable word for the state whatever marketing sentence the
   storefront is currently using for it. */
check('the pre-order label is the checkout notice’s own default kicker', () =>
  /kicker_en: cfg\.kicker_en \|\| 'Pre-order',\s+kicker_cn: cfg\.kicker_cn \|\| '预订'/.test(routeSrc)
  && /cuT\('Pre-order', '预订'\)/.test(adminSrc));

check('the move label is built on the live 改派 · <reason> shape', () =>
  /cuT\('Rerouted, shop was closed', '改派 · 门店已关闭'\)/.test(adminSrc));

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll assertions passed');
process.exit(failed ? 1 : 0);
