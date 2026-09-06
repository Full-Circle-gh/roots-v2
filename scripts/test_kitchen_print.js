#!/usr/bin/env node
/**
 * THE KITCHEN'S PAPER COPY — the slip that prints when a job reaches the queue.
 *
 *   node scripts/test_kitchen_print.js
 *
 * WHAT THIS IS FOR. A warehouse→kitchen request already announces itself to
 * every operator holding `restock:fulfil`, opening on /stock?go=queue. That
 * reaches a phone. A kitchen is a room with wet hands and noise and no phone on
 * the bench, so the request now also comes out of a thermal printer that beeps.
 * It rides the store printers' existing Feieyun rail (lib/feie.js) on a printer
 * SN of its own, because a kitchen request carries no store id at either end —
 * routes/restock.js nulls both for anything with a kitchen on it, so there is
 * nothing for `printer.by_store` to key on.
 *
 * FIVE THINGS HAVE TO BE TRUE, and each part below is one of them:
 *
 *   PART A  the SLIP says what a cook needs — every line, its quantity and its
 *           unit — and says nothing a cook does not need. Nothing here is
 *           priced, and a cost column on a production ticket would only invite
 *           the kitchen to think a transfer owes it money.
 *   PART B  WHEN it prints is the tenant's setting and not a constant. Roots
 *           prints when a job ARRIVES and nothing when it is finished: the
 *           people who would read a completion slip are the people who just
 *           cooked it. Another tenant may want both. The default is Roots'.
 *   PART C  a transfer between shelves NEVER reaches the kitchen's roll. It has
 *           its own paper trail, and a kitchen printing every store's restock
 *           is a kitchen that stops reading the printer.
 *   PART D  the outcome is RECORDED and the slip is reprintable. The one
 *           certainty about a thermal printer in a kitchen is that some morning
 *           it is out of paper — a print that fails silently is the whole
 *           reason the retail side records its own, and this copies it.
 *   PART E  the GUARD this endpoint deliberately does not lean on still has the
 *           subject it is written for. Added after an audit, and it locks a
 *           shape rather than a rule — see the block above it.
 *
 * The Feieyun POST is intercepted at `fetch` rather than stubbed at the module,
 * so the real renderer and the real printContent (its signature, its 5000-byte
 * ceiling) are what run here.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
const notes = F.captureNotifications(h);
F.stubAuth(h, { id: 7, username: 'wh', role: 'staff', display_name: 'WH' },
  { restock: 1, warehouse_inbox: 1, kitchen_inbox: 1 }, 'tacet');

// Feieyun credentials, so feieEnabled() is true. Roots/unscoped resolves its
// bundle off the environment (lib/tenant-creds rootsEnvBundle), which is what a
// single-tenant install actually does.
process.env.FEIE_USER = 'test-account';
process.env.FEIE_UKEY = 'test-userkey';

// ── The printer, intercepted at the wire ───────────────────────────────────
// Everything POSTed to Feieyun lands in `prints`; everything else (the suite's
// own HTTP to its handlers) goes through untouched. `failNext` makes the cloud
// reject one print, which is how PART D gets a real failure to record.
const prints = [];
let failNext = false;
const realFetch = global.fetch;
global.fetch = function (url, opts) {
  if (String(url).includes('feieyun')) {
    const form = new URLSearchParams(String((opts && opts.body) || ''));
    prints.push({ sn: form.get('sn'), content: form.get('content'), times: form.get('times') });
    const bad = failNext; failNext = false;
    return Promise.resolve({
      json: () => Promise.resolve(bad ? { ret: 1, msg: 'printer offline' } : { ret: 0, msg: 'ok', data: 'jobid' }),
    });
  }
  return realFetch(url, opts);
};

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { backendUserId: 7 }; next(); });
app.use(require(path.join(h.REPO, 'routes/restock.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

const feie = require(path.join(h.REPO, 'lib/feie.js'));

const WH = 1, SHOP = 2;
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'wh','x','warehouse',?,1)`).run(WH);
F.seedProduct(h.db, { id: 900, name: 'Hummus', sku: 'P-900' });
F.seedProduct(h.db, { id: 901, name: 'Tortilla', sku: 'P-901' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', ?)").run(String(WH));
F.setShelf(h.db, WH, 900, 100);
F.setShelf(h.db, SHOP, 900, 0);

const cfg = (key, value) => h.db.prepare(
  'INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES (?, ?)'
).run(key, JSON.stringify(value));

const unset = (key) => h.db.prepare('DELETE FROM storefront_config WHERE key = ?').run(key);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// The print is fire-and-forget: the route answers before the POST settles, so a
// suite that asserts immediately asserts on nothing. One turn of the loop is
// enough — the interception resolves synchronously.
const settle = () => new Promise(r => setTimeout(r, 20));

const KITCHEN_ITEMS = [
  { product_id: 900, product_name: 'Hummus', product_cn: '鹰嘴豆泥', sku: 'P-900', qty_requested: 20, unit: 'kg' },
  { product_id: 901, product_name: 'Tortilla', product_cn: '墨西哥薄饼', sku: 'P-901', qty_requested: 100, unit: 'pc', notes: 'thin' },
];

// A kitchen request, created straight to 'sent' so it lands in the queue.
async function askKitchen(extra = {}) {
  prints.length = 0;
  const r = await call('POST', '/api/restock', {
    status: 'sent', to_role: 'kitchen', purpose: 'order',
    notes: 'For the 2pm run', items: KITCHEN_ITEMS, ...extra,
  });
  await settle();
  return r;
}

const printStatus = (id) =>
  h.db.prepare('SELECT print_status, print_error, printed_at FROM restock_orders WHERE id = ?').get(id);

(async () => {
  section('Part A · the slip says what a cook needs');

  // Rendered directly, so the assertions are about the LAYOUT and not about
  // whichever request happened to trigger it.
  const slip = feie.renderKitchenRequest(
    { id: 5, rs_number: 'PR-2609-0007', purpose: 'order', store_name: 'Warehouse',
      sent_at: '2026-09-06 01:20:00', notes: 'For the 2pm run' },
    KITCHEN_ITEMS, 'Roots');

  ok(slip.includes('PR-2609-0007'), 'the slip names the request, so it can be matched to the queue');
  ok(slip.includes('厨房新请求'), 'headed with the live Chinese the push already uses');
  ok(slip.includes('用于发货'), 'says WHY it was asked for — an order is waited on, a shelf refill is not');
  ok(slip.includes('鹰嘴豆泥') && slip.includes('墨西哥薄饼'), 'every line is on it');
  ok(/20 kg/.test(slip), 'quantity and unit ride with the line — the whole point of the slip');
  ok(/100 pc/.test(slip), 'and so does the second line');
  ok(!/\.00/.test(slip), 'a whole number prints as 20, not 20.00 — the queue screen shows it that way');
  ok(slip.includes('For the 2pm run'), 'the requester note survives to paper');
  ok(!slip.includes('￥'), 'NOTHING on a production ticket is priced');

  // A cook reads the quantity off the right-hand column. A bilingual name long
  // enough to fill the width must not push it onto its own line.
  const longName = feie.renderKitchenRequest({ rs_number: 'PR-1' }, [
    { product_cn: '素食牛肉丸', product_name: 'Plant-based beef balls', qty_requested: 6, unit: 'box' },
  ], 'Roots');
  ok(/素食牛肉丸\s+6 box/.test(longName), 'a long bilingual name splits between languages, keeping the qty on line one');

  // Feieyun rejects a whole print over ~5000 bytes, every retry included. A
  // runaway free-text note is the realistic way a slip gets there.
  const huge = feie.renderKitchenRequest(
    { rs_number: 'PR-2', notes: 'x'.repeat(9000) }, KITCHEN_ITEMS, 'Roots');
  ok(Buffer.byteLength(huge, 'utf8') < 5000, 'a runaway note is truncated rather than making the slip unprintable');
  ok(huge.includes('鹰嘴豆泥'), 'and the ITEMS survive the truncation — the note is what gets cut');

  section('Part B · when it prints is the tenant\'s setting');

  cfg('printer.kitchen_sn', '550540977');
  unset('printer.kitchen_print_on');          // no setting at all → the default

  let r = await askKitchen();
  eq(r.status, 200, 'the request is created');
  eq(prints.length, 1, 'DEFAULT: a job arriving in the queue prints, with no setting saved');
  eq(prints[0].sn, '550540977', 'on the kitchen printer, not a store one');
  ok(prints[0].content.includes('厨房新请求'), 'and it is the arrival slip');
  const arrived = r.body.id;

  // Roots' answer: nothing prints when the kitchen marks it made.
  prints.length = 0;
  await call('PUT', `/api/restock/${arrived}/status`, { status: 'prepared' });
  await settle();
  eq(prints.length, 0, "DEFAULT: marking it made prints NOTHING — the readers would be the cooks who just made it");

  cfg('printer.kitchen_print_on', 'both');
  r = await askKitchen();
  eq(prints.length, 1, "'both': the arrival still prints");
  prints.length = 0;
  await call('PUT', `/api/restock/${r.body.id}/status`, { status: 'prepared' });
  await settle();
  eq(prints.length, 1, "'both': and the completion prints too");
  ok(prints[0].content.includes('制作完成'), 'the completion slip is headed as one');

  cfg('printer.kitchen_print_on', 'prepared');
  r = await askKitchen();
  eq(prints.length, 0, "'prepared': the arrival does NOT print");
  prints.length = 0;
  await call('PUT', `/api/restock/${r.body.id}/status`, { status: 'prepared' });
  await settle();
  eq(prints.length, 1, "'prepared': only the completion does");

  cfg('printer.kitchen_print_on', 'off');
  r = await askKitchen();
  eq(prints.length, 0, "'off': nothing prints — the notification is the whole delivery");
  const offId = r.body.id;

  // No printer configured is not a setting, it is the absence of a device.
  cfg('printer.kitchen_print_on', 'sent');
  unset('printer.kitchen_sn');
  r = await askKitchen();
  eq(prints.length, 0, 'no SN saved: nothing is POSTed anywhere');
  eq(printStatus(r.body.id).print_status, null, 'and no failure is stamped — a kitchen with no printer is not a broken print');
  cfg('printer.kitchen_sn', '550540977');

  section('Part C · a store transfer never reaches the kitchen roll');

  prints.length = 0;
  r = await call('POST', '/api/restock', {
    status: 'sent', store_name: 'Shop', items: [{ product_id: 900, product_name: 'Hummus', qty_requested: 5 }],
  });
  await settle();
  eq(r.status, 200, 'a store→warehouse restock is created');
  eq(prints.length, 0, 'and prints nothing in the kitchen');
  const transferId = r.body.id;

  prints.length = 0;
  await call('PUT', `/api/restock/${transferId}/status`, { status: 'prepared' });
  await settle();
  eq(prints.length, 0, 'nor at any later step of its life');

  section('Part D · the outcome is recorded, and the slip is reprintable');

  r = await askKitchen();
  const okId = r.body.id;
  eq(printStatus(okId).print_status, 'printed', 'a slip that printed is recorded as printed');
  ok(!!printStatus(okId).printed_at, 'with the time it printed');

  failNext = true;
  r = await askKitchen();
  const badId = r.body.id;
  eq(r.status, 200, 'a printer that refuses does NOT fail the request — the job still reaches the queue');
  eq(printStatus(badId).print_status, 'failed', 'the failure is recorded rather than swallowed');
  ok(/offline/.test(printStatus(badId).print_error || ''), 'with what the printer said');

  // The reprint someone presses while standing at the machine.
  prints.length = 0;
  const rp = await call('POST', `/api/restock/${badId}/reprint`);
  eq(rp.status, 200, 'the reprint goes through');
  eq(prints.length, 1, 'and one slip is POSTed');
  eq(printStatus(badId).print_status, 'printed', 'clearing the failure it was pressed for');

  // A tenant that prints nothing automatically has not said the kitchen may
  // never reprint one.
  cfg('printer.kitchen_print_on', 'off');
  prints.length = 0;
  const forced = await call('POST', `/api/restock/${offId}/reprint`);
  eq(forced.status, 200, "reprint works even when kitchen_print_on is 'off' — it is a person asking, now");
  eq(prints.length, 1, 'and it really prints');
  cfg('printer.kitchen_print_on', 'sent');

  // But it cannot conjure a printer that is not there.
  unset('printer.kitchen_sn');
  prints.length = 0;
  const noSn = await call('POST', `/api/restock/${okId}/reprint`);
  eq(noSn.status, 502, 'with no printer configured the reprint reports a failure rather than a silent tick');
  eq(prints.length, 0, 'and posts nothing');
  cfg('printer.kitchen_sn', '550540977');

  // The same guard every other kitchen action carries.
  const refused = await call('POST', `/api/restock/${transferId}/reprint`);
  eq(refused.status, 403, 'a store transfer cannot be printed onto the kitchen roll by hand either');

  // The queue screen decides whether to OFFER a reprint from print_status, so a
  // request that was never printing must not carry one.
  eq(printStatus(transferId).print_status, null, 'a transfer carries no print state at all');

  ok(notes.operator.length > 0, 'and the push fan-out still happens — paper is an addition, not a replacement');

  section('Part E · the guard the reprint deliberately does NOT rely on');

  /* WHY THIS PART EXISTS. The reprint refuses a store transfer itself rather
     than leaving it to kitchenScopedOrder, and a reader is entitled to ask why
     a second check was added when a middleware on the same route already says
     something that sounds identical. It is not identical, and the difference is
     the reason the first version of this endpoint had a hole in it.

     kitchenScopedOrder is a SCOPE limiter keyed on a role SHAPE: it confines an
     account that can fulfil but cannot pick. That is a kitchen account, and it
     is meant to pass everyone else through, because every other role reaching
     these endpoints works transfers legitimately. The reprint needed the OTHER
     kind of check — an object-type refusal, "this endpoint only ever prints a
     kitchen request, for anybody."

     So this locks the shape rather than restating the rule: the set of shipped
     roles the guard scopes. If a later edit gives the kitchen preset
     `restock:pick`, the guard silently stops scoping the only role it scopes,
     and this says so instead of the change being found by its consequences. */
  const caps = require(path.join(h.REPO, 'lib/capabilities.js'));
  const scoped = (role) => {
    const c = caps.presetCapsFor(role);
    return c.includes('restock:fulfil') && !c.includes('restock:pick');
  };

  ok(scoped('kitchen'), 'the kitchen role IS scoped to kitchen requests — the guard has a subject');
  ok(!scoped('warehouse') && !scoped('store_manager'),
     'the roles that pick are NOT scoped — they work transfers, and that is correct, not a hole');
  ok(!scoped('owner') && !scoped('admin') && !scoped('manager'),
     'nor are the roles that run everything');
  ok(!scoped('staff'), 'nor a role with no restock capability at all');

  // The claim the audit withdrew, held as a test so it cannot be re-filed from
  // memory: the guard is NOT a blanket no-op outside the kitchen realm. It has
  // exactly one subject among the shipped presets, and that subject is real.
  const allScoped = ['owner', 'admin', 'staff', 'manager', 'store_manager', 'warehouse',
                     'bookkeeper', 'customer_service', 'dispatch', 'marketing',
                     'fulfillment', 'channel', 'kitchen', 'store_stock'].filter(scoped);
  eq(allScoped.join(','), 'kitchen', 'and it is the ONLY preset the guard scopes');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
