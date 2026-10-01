#!/usr/bin/env node
/**
 * §325 step S2m — WHAT CLOSING ELEME AT A STORE ACTUALLY DOES, AND THE WORDS
 * THAT SAY SO.
 *
 *   node scripts/test_mobile_eleme_close_words.js
 *
 * Closing Eleme at a store (the Sales screen, phone and desktop) writes its
 * channel_status cell and drops that store's queued Eleme stock pushes; the
 * Eleme daemon then skips the store's pushes. Nothing tells Eleme the shop is
 * shut and the order poll is gated on opening hours only, so Eleme customers
 * can still order and those orders still come in. The phone's confirm said
 * "No new orders arrive at this store on this channel" — the opposite. This
 * pins both halves: the server behaviour the new sentence describes (real
 * setChannelOpen on a scratch database, and the daemon's source), and the
 * sentence itself on every close that reaches Eleme, phone and desktop.
 * No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./test-support/tenant-fixture');

const h0 = F.harness();
const ROOT = h0.REPO;
const db = h0.db;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const M = read('public/m.html');

let pass = 0, fail = 0;
const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, 'slice not found: ' + from);
  return src.slice(a, b);
}
function block(src, anchor) {
  const a = src.indexOf(anchor);
  assert.ok(a >= 0, 'not found: ' + anchor);
  let d = 0;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced: ' + anchor);
}
const line = (src, anchor) => { const a = src.indexOf(anchor); assert.ok(a >= 0, anchor); return src.slice(a, src.indexOf('\n', a)); };

const ELEME_ONE = 'Stock stops being sent to Eleme for this store: updates already waiting are dropped, and new ones wait until it reopens. Eleme is not told the store is closed — customers can still order there, and those orders still come in.';
const ELEME_ALL = 'Stock stops being sent to Eleme for every store: updates already waiting are dropped, and new ones wait until it reopens. Eleme is not told the stores are closed — customers can still order there, and those orders still come in.';
const EXCEPT = 'Eleme is the exception: it is not told, so Eleme orders can still come in.';

// ─── the phone, in a vm ──────────────────────────────────────────────────
const SRC = [
  line(M, 'function E(en, zh)'),
  slice(M, 'const PILL = {', '\n};') + '\n};',
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, 'const CHAN_META={', 'function statusSales(){'),
  '/*' + slice(M, '§325 S2m — WHAT CLOSING ELEME ACTUALLY DOES', "/* The Sales board's own retry"),
].join('\n');
const cell = (code, open) => ({ storeCode: code, nameEn: code === 'tianhe' ? 'Tianhe' : 'Yuexiu', nameCn: code === 'tianhe' ? '天河店' : '越秀店', open });
function phone(opts = {}) {
  const writes = [];
  const CMD = {};
  const channels = [
    { channel: 'meituan', integrated: true, cells: [cell('tianhe', true), cell('yuexiu', true)] },
    { channel: 'eleme', integrated: opts.eleme !== false, cells: opts.eleme === false ? [] : [cell('tianhe', true), cell('yuexiu', false)] },
  ];
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s), ic: () => '',
    state: { caps: ['dashboard:view'], chan: { channels, locations: [{ storeCode: 'tianhe', nameEn: 'Tianhe', nameCn: '天河店', shopOpen: true }] },
      chanBusy: null, chanErr: null, shopBusy: null, shopErr: null, oc: { master: 'open', online: { online_open: true } },
      ocBusy: null, ocErr: null, mtCfg: null, mtCfgTried: false, chSwBusy: null, chSwErr: null, elm: { cfg: null }, ask: null },
    render: () => {}, reg: (n, f) => { CMD[n] = f; }, showToast: () => {}, loadChannels: () => {}, x8MtStatus: () => {},
    apiRaw: () => new Promise(() => {}),
    apiWrite: (p, body) => { writes.push({ p, body }); return new Promise(() => {}); },
    setTimeout: () => 0,
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC).runInContext(ctx);
  const ask = () => { assert.ok(ctx.state.ask, 'no confirm'); return { title: String(ctx.state.ask.title), body: String(ctx.state.ask.body) }; };
  return { ctx, CMD, writes, ask };
}

section('1 · what the server really does when Eleme is closed at a store');
it('the close writes the cell and drops that store\'s queued Eleme pushes — and only those', () => {
  const { setChannelOpen } = require(path.join(ROOT, 'lib', 'store-close'));
  db.prepare(`INSERT OR IGNORE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order) VALUES (1, 'tianhe', 'Tianhe', '天河', 1, 1)`).run();
  db.prepare(`INSERT OR IGNORE INTO store_products (id, name_en, name_cn, sku, sell_price) VALUES (1, 'Oat milk', '燕麦奶', 'S2M-1', 10)`).run();
  const q = (code, st) => db.prepare(`INSERT INTO eleme_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
                                       VALUES (1, 1, ?, 3, ?)`).run(code, st);
  q('tianhe', 'pending'); q('tianhe', 'error'); q('yuexiu', 'pending'); q('tianhe', 'done');
  const r = setChannelOpen(db, { channel: 'eleme', storeCode: 'tianhe', open: false, by: 'test' });
  assert.strictEqual(r.cleared, 2, 'the pending and the error row went');
  assert.strictEqual(db.prepare("SELECT is_open FROM channel_status WHERE channel='eleme' AND store_code='tianhe'").get().is_open, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM eleme_sync_queue WHERE store_code='yuexiu'").get().c, 1, 'the other store kept its push');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM eleme_sync_queue WHERE store_code='tianhe' AND status='done'").get().c, 1, 'history is kept');
  assert.ok(require(path.join(ROOT, 'lib', 'inventory')).channelClosedStores('eleme').has('tianhe'), 'and the store now reads closed for Eleme');
  assert.strictEqual(r.refilled, 0);
  const re = setChannelOpen(db, { channel: 'eleme', storeCode: 'tianhe', open: true, by: 'test' });
  assert.strictEqual(re.refilled, 0, 'reopening Eleme queues no fresh snapshot (Meituan only)');
});
it('the daemon skips a closed store\'s pushes, and its order poll does not look at the switch', () => {
  const D = read('scripts/eleme-daemon.js');
  assert.ok(/channelClosedStores\('eleme'\)/.test(block(D, 'async function processStockQueue(')), 'pushes skip closed stores');
  const poll = block(D, 'async function pollOrders(');
  assert.ok(!/channel_status|channelClosedStores|isStoreTradingOnChannel/.test(poll), 'the order import never reads the close');
  const loop = block(D, 'async function main(');
  assert.ok(/if \(!isStoreOpen\(code\)\)/.test(loop) && !/channelClosedStores|channel_status/.test(loop.slice(loop.indexOf('ORDER_POLL_ON) {'))), 'the poll is gated on opening hours only');
});
it('nothing anywhere tells Eleme a shop is shut', () => {
  for (const f of ['lib/eleme-browser.js', 'lib/eleme-client.js', 'scripts/eleme-daemon.js', 'routes/eleme-admin.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    assert.ok(!/置休|setShopStatus|setBusinessStatus|shop_status|business_status/.test(read(f)), f + ' has no Eleme shop-status write');
  }
});

section('2 · the phone says what is true');
it('closing Eleme at one store: what stops, and that orders still come in', () => {
  const p = phone();
  p.CMD.chanCell('eleme', 'tianhe', 0);
  const a = p.ask();
  assert.strictEqual(a.title, 'Close Eleme at Tianhe?');
  assert.strictEqual(a.body, ELEME_ONE);
  assert.ok(!a.body.includes('No new orders'), 'the old promise is gone for Eleme');
  assert.strictEqual(p.writes.length, 0);
});
it('every other channel keeps its sentence — Meituan really does close', () => {
  const p = phone();
  p.CMD.chanCell('meituan', 'tianhe', 0);
  assert.strictEqual(p.ask().body, 'No new orders arrive at this store on this channel. Orders already placed are not affected.');
});
it('reopening Eleme at a store says the stock comes back, not that orders can arrive again', () => {
  const p = phone();
  p.CMD.chanCell('eleme', 'yuexiu', 1);
  assert.strictEqual(p.ask().body, 'Stock is sent to Eleme for this store again.');
});
it('the whole channel, both ways', () => {
  const p = phone();
  p.CMD.chanAll('eleme', 0);
  assert.strictEqual(p.ask().body, ELEME_ALL);
  p.CMD.chanAll('eleme', 1);
  assert.strictEqual(p.ask().body, 'Stock is sent to Eleme again. A shop that is closed stays closed.');
  p.CMD.chanAll('meituan', 0);
  assert.ok(p.ask().body.startsWith('No new orders arrive on this channel at any store.'), 'other channels unchanged');
});
it('closing a whole shop, or everything, names Eleme as the exception — only where Eleme is live', () => {
  const p = phone();
  p.CMD.shopOpen('tianhe', 0);
  assert.ok(p.ask().body.endsWith(EXCEPT), 'the shop switch');
  p.CMD.ocMaster(0);
  assert.ok(p.ask().body.endsWith(EXCEPT), 'Close everything');
  const n = phone({ eleme: false });
  n.CMD.shopOpen('tianhe', 0);
  assert.ok(!n.ask().body.includes('Eleme'), 'no Eleme, no exception');
  n.CMD.ocMaster(0);
  assert.ok(!n.ask().body.includes('Eleme'));
});
it('in Chinese', () => {
  const p = phone({ lang: 'zh' });
  p.CMD.chanCell('eleme', 'tianhe', 0);
  assert.ok(p.ask().body.includes('饿了么不会收到门店关闭的通知'));
  p.CMD.shopOpen('tianhe', 0);
  assert.ok(p.ask().body.endsWith('饿了么除外：它不会收到通知，饿了么订单仍可能进来。'));
});

section('3 · the desktop says the same');
it('opening Eleme at a shut shop says the stock comes back', () => {
  const C = read('public/retail-admin/01-core.js');
  assert.ok(C.includes("body: ch === 'eleme' ? cuT('Stock is sent to Eleme for this store again.', '恢复向饿了么推送该门店的库存。')"));
  assert.ok(M.includes("openOne:['Stock is sent to Eleme for this store again.','恢复向饿了么推送该门店的库存。']"), 'the phone\'s live pair, word for word');
});
it('the open/close panel names Eleme as the exception, in the phone\'s words', () => {
  const H = read('public/retail-admin.html');
  assert.ok(H.includes('Closing pauses new orders.') && H.includes(EXCEPT + ' · ') && H.includes('饿了么除外：它不会收到通知，饿了么订单仍可能进来。'));
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
