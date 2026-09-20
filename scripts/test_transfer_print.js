#!/usr/bin/env node
/**
 * THE SUPPLIER'S PAPER COPY — the slip that prints when one shop asks another
 * for stock (§197).
 *
 *   node scripts/test_transfer_print.js
 *
 * THE REPORT THIS PINS, from Ash on the Yuexiu account: "i use the feature ask
 * for stock, i am yuexiu store, asked from tianhe … there is no printing in
 * tianhe for it". The request was written correctly and reached exactly one
 * screen. `routes/restock.js` said why it was owed nothing further — "a store
 * transfer has its own paper trail and never reaches this roll" — and THAT
 * PAPER TRAIL DID NOT EXIST. This suite is the trail.
 *
 * SIX THINGS HAVE TO BE TRUE, and each part below is one of them:
 *
 *   PART A  the SLIP says what a picker needs — who it is FOR, every line, its
 *           quantity and the SKU they match against at a shelf — and nothing
 *           they do not. Nothing is priced: §51 ruled that for the kitchen and
 *           the reason carries, since a transfer moves value and is not a sale.
 *   PART B  it prints at the SUPPLIER and nowhere else. This is the whole of
 *           the routing and the one thing that can be wrong silently: a slip
 *           that lands at the shop that ASKED sends nobody to a freezer.
 *   PART C  the two rolls never cross. A kitchen request must not print on a
 *           shop's printer and a transfer must not print on the kitchen's —
 *           each module refuses what the other takes, and that is what makes
 *           the two auto-print calls beside each other in the route safe.
 *   PART D  WHEN it prints is the tenant's, and the default is ON. A tenant who
 *           has never opened the printer page is the tenant this report came
 *           from; shipping the fix switched off would have fixed nothing.
 *   PART E  the outcome is RECORDED and the slip is reprintable, exactly as the
 *           kitchen's is. A supplier with no printer is NOT a failed print, and
 *           stamping one would put a red mark and a reprint button on a request
 *           that was never owed a slip.
 *   PART F  a draft sent LATER prints too. The two creation paths are the same
 *           request arriving, and a slip that depended on which button raised
 *           it is a difference nobody can see from a shop floor.
 *
 * The Feieyun POST is intercepted at `fetch` rather than stubbed at the module,
 * so the real renderer and the real printContent are what run here.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h);
F.stubAuth(h, { id: 7, username: 'mgr', role: 'staff', display_name: 'Mgr' },
  { restock: 1, warehouse_inbox: 1 }, 'tacet');

process.env.FEIE_USER = 'test-account';
process.env.FEIE_UKEY = 'test-userkey';

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

const tprint = require(path.join(h.REPO, 'lib/transfer-print.js'));
const feie = require(path.join(h.REPO, 'lib/feie.js'));

// Two real shops, because the whole point is which of them the paper lands at.
const TIANHE = 1, YUEXIU = 2;
const store = (id, code, en, cn) => h.db.prepare(
  `INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
   VALUES (?,?,?,?,1,?)`).run(id, code, en, cn, id);
store(TIANHE, 'tianhe', 'Tianhe', '天河');
store(YUEXIU, 'yuexiu', 'Yuexiu', '越秀');

h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'mgr','x','warehouse',?,1)`).run(YUEXIU);
F.seedProduct(h.db, { id: 900, name: 'Hummus', sku: 'P-900' });
F.seedProduct(h.db, { id: 901, name: 'Tortilla', sku: 'P-901' });

const cfg = (key, value) => h.db.prepare(
  'INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES (?, ?)'
).run(key, JSON.stringify(value));
const unset = (key) => h.db.prepare('DELETE FROM storefront_config WHERE key = ?').run(key);

const TIANHE_SN = '550540977', YUEXIU_SN = '660110222';
const bothPrinters = () => cfg('printer.by_store', {
  [String(TIANHE)]: { sn: TIANHE_SN, template: 'receipt', copies: 1, vendor: 'feie' },
  [String(YUEXIU)]: { sn: YUEXIU_SN, template: 'receipt', copies: 1, vendor: 'feie' },
});
bothPrinters();
cfg('printer.shop_name', 'Roots');

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Fire-and-forget: the route answers before the POST settles.
const settle = () => new Promise(r => setTimeout(r, 20));

const ITEMS = [
  { product_id: 900, product_name: 'Hummus', product_cn: '鹰嘴豆泥', sku: 'P-900', qty_requested: 20, unit: 'kg' },
  { product_id: 901, product_name: 'Tortilla', product_cn: '墨西哥薄饼', sku: 'P-901', qty_requested: 100, unit: 'pc', notes: 'thin' },
];

// Yuexiu asks Tianhe — the exact shape the phone's Ask-for-stock screen sends:
// both ends named outright, no store_name, no to_role.
async function askTianhe(extra = {}) {
  prints.length = 0;
  const r = await call('POST', '/api/restock', {
    status: 'sent', from_store_id: TIANHE, to_store_id: YUEXIU,
    notes: 'Before the 2pm run', items: ITEMS, ...extra,
  });
  await settle();
  return r;
}

const printState = (id) =>
  h.db.prepare('SELECT print_status, print_error, printed_at FROM restock_orders WHERE id = ?').get(id);

(async () => {
  section('Part A · the slip says what a picker needs');

  // Rendered directly, so the assertions are about the LAYOUT and not about
  // whichever request happened to trigger it.
  const slip = feie.renderTransferRequest(
    { id: 5, rs_number: 'RS-260920-001', sent_at: '2026-09-20T03:00:00Z', notes: 'Before the 2pm run' },
    ITEMS, 'Roots', { toName: '越秀' });

  ok(slip.includes('补货申请'), 'it names itself in Chinese — the locked pair, not a new one');
  ok(slip.includes('Stock request'), 'and in English, on its own line');
  ok(slip.includes('RS-260920-001'), 'the request number a picker quotes back');
  ok(slip.includes('送到 越秀') && slip.includes('For 越秀'),
     'WHO IT IS FOR, in both languages — the fact that decides where the goods go');
  ok(!slip.includes('天河'),
     'and NOT the supplier: printing a shop its own name tells somebody where they are standing');
  ok(slip.includes('鹰嘴豆泥') && slip.includes('墨西哥薄饼'), 'every line, by name');
  ok(slip.includes('x20 kg') && slip.includes('x100 pc'), 'with its quantity and unit');
  ok(slip.includes('P-900') && slip.includes('P-901'), 'and the SKU that gets matched at a shelf');
  ok(slip.includes('Before the 2pm run'), 'the note the asker typed');
  ok(!/[¥$]/.test(slip), 'NO MONEY ANYWHERE — a transfer moves value, it does not sell anything');

  // The item block is the kitchen slip's, in one place rather than two.
  const kslip = feie.renderKitchenRequest(
    { id: 6, rs_number: 'PR-1', purpose: 'order' }, ITEMS, 'Roots', { kind: 'sent' });
  ok(kslip.includes('x20 kg') && kslip.includes('P-900'),
     'and it is the SAME block the kitchen prints — one answer to "how is a line drawn"');

  section('Part B · it prints at the supplier and nowhere else');

  let r = await askTianhe();
  eq(r.status, 200, 'the request is created');
  eq(prints.length, 1, 'and one slip is POSTed');
  eq(prints[0].sn, TIANHE_SN, "to TIANHE's printer — the shop that has to walk to the freezer");
  ok(prints[0].content.includes('越秀'), 'and it names Yuexiu, the shop that asked');

  // The one that can be wrong silently, stated as its own assertion.
  ok(prints[0].sn !== YUEXIU_SN, 'NOT to the shop that raised it — they are already looking');

  section('Part C · the two rolls never cross');

  // A kitchen request onto a shop's roll.
  cfg('printer.kitchen_sn', '999999999');
  prints.length = 0;
  r = await call('POST', '/api/restock', {
    status: 'sent', to_role: 'kitchen', purpose: 'order', items: ITEMS,
  });
  await settle();
  eq(r.status, 200, 'a kitchen request is created');
  eq(prints.filter(p => p.sn === TIANHE_SN || p.sn === YUEXIU_SN).length, 0,
     'and reaches no shop printer — it carries no locations to key one on');
  eq(prints.filter(p => p.sn === '999999999').length, 1, 'only the kitchen roll');
  unset('printer.kitchen_sn');

  // And a transfer onto the kitchen's.
  cfg('printer.kitchen_sn', '999999999');
  await askTianhe();
  eq(prints.filter(p => p.sn === '999999999').length, 0,
     'a transfer never reaches the kitchen roll — a kitchen printing every shop’s restock stops being read');
  eq(prints.filter(p => p.sn === TIANHE_SN).length, 1, 'it goes to the supplier and only there');
  unset('printer.kitchen_sn');

  section('Part D · when it prints is the tenant’s, and the default is on');

  unset('printer.transfer_print_on');
  r = await askTianhe();
  eq(prints.length, 1, 'with the setting never touched, it prints — the default is ON, deliberately');

  cfg('printer.transfer_print_on', 'off');
  r = await askTianhe();
  eq(prints.length, 0, "'off': nothing prints, and the push is still the whole delivery");
  const offId = r.body.id;
  eq(printState(offId).print_status, null, "and 'off' is not a failed print");

  cfg('printer.transfer_print_on', 'nonsense-from-a-stale-client');
  r = await askTianhe();
  eq(prints.length, 1, 'an unrecognised value falls back to the default rather than switching paper off');
  cfg('printer.transfer_print_on', 'sent');

  section('Part E · the outcome is recorded, and the slip is reprintable');

  r = await askTianhe();
  const okId = r.body.id;
  eq(printState(okId).print_status, 'printed', 'a slip that printed is recorded as printed');
  ok(!!printState(okId).printed_at, 'with the time it printed');

  failNext = true;
  r = await askTianhe();
  const badId = r.body.id;
  eq(r.status, 200, 'a printer that refuses does NOT fail the request — the supplier still gets the row');
  eq(printState(badId).print_status, 'failed', 'the failure is recorded rather than swallowed');
  ok(/offline/.test(printState(badId).print_error || ''), 'with what the printer said');

  prints.length = 0;
  const rp = await call('POST', `/api/restock/${badId}/reprint`);
  eq(rp.status, 200, 'the reprint someone presses at the machine goes through');
  eq(prints.length, 1, 'and one slip is POSTed');
  eq(prints[0].sn, TIANHE_SN, 'to the supplier, as the automatic one did');
  eq(printState(badId).print_status, 'printed', 'clearing the failure it was pressed for');

  // A tenant that prints nothing automatically has not said a shop may never
  // reprint one — the same rule §51 wrote for the kitchen.
  cfg('printer.transfer_print_on', 'off');
  prints.length = 0;
  const forced = await call('POST', `/api/restock/${offId}/reprint`);
  eq(forced.status, 200, "reprint works even when transfer_print_on is 'off' — it is a person asking, now");
  eq(prints.length, 1, 'and it really prints');
  cfg('printer.transfer_print_on', 'sent');

  // A SUPPLIER WITH NO PRINTER IS NOT A FAILED PRINT. This is the one that
  // would put a red mark and a reprint button on a request nobody owed a slip.
  cfg('printer.by_store', { [String(YUEXIU)]: { sn: YUEXIU_SN, copies: 1, vendor: 'feie' } });
  r = await askTianhe();
  eq(prints.length, 0, 'a supplier with no printer posts nothing');
  eq(printState(r.body.id).print_status, null, 'and carries no print state at all');
  ok(!tprint.isPrintAttempt({ ok: false, msg: 'no_store_printer' }),
     'the module says so by name rather than by the absence of a stamp');

  // AND IT DOES NOT FALL BACK TO "the only printer configured". That fallback
  // exists for a paid order with no store on it, and it is exactly wrong here:
  // it would send Tianhe's pick list to Yuexiu's counter.
  eq(tprint.printerForSupplier(TIANHE, { by_store: { [String(YUEXIU)]: { sn: YUEXIU_SN } } }), null,
     'one printer configured elsewhere is not this supplier’s printer');
  bothPrinters();

  section('Part F · a draft sent later prints exactly as one sent on creation');

  prints.length = 0;
  r = await call('POST', '/api/restock', {
    status: 'draft', from_store_id: TIANHE, to_store_id: YUEXIU, items: ITEMS,
  });
  await settle();
  const draftId = r.body.id;
  eq(prints.length, 0, 'a draft prints nothing — nobody has been asked for anything yet');

  await call('PUT', `/api/restock/${draftId}/status`, { status: 'sent' });
  await settle();
  eq(prints.length, 1, 'and the slip prints when it is actually sent');
  eq(prints[0].sn, TIANHE_SN, 'at the supplier, by the same route');

  prints.length = 0;
  await call('PUT', `/api/restock/${draftId}/status`, { status: 'prepared' });
  await settle();
  eq(prints.length, 0,
     "'prepared' prints nothing: the goods have left, and the only readers would be whoever packed them");

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
