#!/usr/bin/env node
/**
 * §533 — CLOSING ELEME AT A STORE CLOSES THE SHOP ON ELEME.
 *
 *   node scripts/test_mobile_eleme_close_words.js
 *
 * Closing Eleme at a store writes the cell at once (the grid and the stock
 * gate) and queues channel_status.target_open. The Eleme daemon applies that
 * command on the shop and then clears it. The confirm says the same thing it
 * says for every other channel. The order poll stays gated on opening hours
 * only, so orders already placed still come in.
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

const ONE = 'No new orders arrive at this store on this channel. Orders already placed are not affected.';
const ONE_OPEN = 'New orders can arrive at this store again.';
const ALL = 'No new orders arrive on this channel at any store. Orders already placed are not affected.';
const ALL_OPEN = 'New orders can arrive on this channel again. A shop that is closed stays closed.';
const RETIRED = ['饿了么不会收到门店关闭的通知', '饿了么除外', 'Eleme is the exception', 'Eleme is not told'];

// ─── the phone, in a vm ──────────────────────────────────────────────────
const SRC = [
  line(M, 'function E(en, zh)'),
  slice(M, 'const PILL = {', '\n};') + '\n};',
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, 'const CHAN_META={', 'function statusSales(){'),
  slice(M, "reg('chanCell'", "/* The Sales board's own retry"),
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
function noRetired(body) {
  for (const s of RETIRED) assert.ok(!body.includes(s), 'retired sentence still shown: ' + s);
}

section('1 · what the server really does when Eleme is closed at a store');
it('the close writes the cell, queues the shop command, and drops that store\'s queued Eleme pushes — and only those', () => {
  const { setChannelOpen } = require(path.join(ROOT, 'lib', 'store-close'));
  db.prepare(`INSERT OR IGNORE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order) VALUES (1, 'tianhe', 'Tianhe', '天河', 1, 1)`).run();
  db.prepare(`INSERT OR IGNORE INTO store_products (id, name_en, name_cn, sku, sell_price) VALUES (1, 'Oat milk', '燕麦奶', 'S2M-1', 10)`).run();
  const q = (code, st) => db.prepare(`INSERT INTO eleme_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
                                       VALUES (1, 1, ?, 3, ?)`).run(code, st);
  q('tianhe', 'pending'); q('tianhe', 'error'); q('yuexiu', 'pending'); q('tianhe', 'done');
  const r = setChannelOpen(db, { channel: 'eleme', storeCode: 'tianhe', open: false, by: 'test' });
  assert.strictEqual(r.cleared, 2, 'the pending and the error row went');
  const closed = db.prepare("SELECT is_open, target_open FROM channel_status WHERE channel='eleme' AND store_code='tianhe'").get();
  assert.strictEqual(closed.is_open, 0, 'the cell flips at the tap');
  assert.strictEqual(closed.target_open, 0, 'and the daemon is told to close the shop');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM eleme_sync_queue WHERE store_code='yuexiu'").get().c, 1, 'the other store kept its push');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM eleme_sync_queue WHERE store_code='tianhe' AND status='done'").get().c, 1, 'history is kept');
  assert.ok(require(path.join(ROOT, 'lib', 'inventory')).channelClosedStores('eleme').has('tianhe'), 'and the store now reads closed for Eleme');
  assert.strictEqual(r.refilled, 0);
  const re = setChannelOpen(db, { channel: 'eleme', storeCode: 'tianhe', open: true, by: 'test' });
  assert.strictEqual(re.refilled, 0, 'reopening Eleme queues no fresh snapshot (Meituan only)');
  const opened = db.prepare("SELECT is_open, target_open FROM channel_status WHERE channel='eleme' AND store_code='tianhe'").get();
  assert.strictEqual(opened.is_open, 1);
  assert.strictEqual(opened.target_open, 1, 'reopening queues the shop open, before the daemon has run');
});
it('the daemon applies the shop command, and its order poll does not look at the switch', () => {
  const D = read('scripts/eleme-daemon.js');
  assert.ok(/channelClosedStores\('eleme'\)/.test(block(D, 'async function processStockQueue(')), 'pushes skip closed stores');
  const poll = block(D, 'async function pollOrders(');
  assert.ok(!/channel_status|channelClosedStores|isStoreTradingOnChannel/.test(poll), 'the order import never reads the close');
  const loop = block(D, 'async function main(');
  const pollLoop = loop.slice(loop.indexOf('if (ORDER_POLL_ON)'), loop.indexOf('lastDriftSweep'));
  assert.ok(/if \(!isStoreOpen\(code\)\)/.test(pollLoop) && !/channelClosedStores|channel_status|isStoreTradingOnChannel/.test(pollLoop), 'the poll is gated on opening hours only');
  assert.ok(/applyShopStatus\(/.test(loop), 'the loop tells Eleme');
  const apply = block(D, 'async function applyShopStatus(');
  assert.ok(/setBusinessStatus\(/.test(apply), 'through the browser session');
  const queued = apply.indexOf('left queued');
  const clear = apply.indexOf('target_open=NULL');
  assert.ok(queued >= 0 && clear > queued, 'a login or network miss leaves the command queued');
  assert.ok(/is_open=\?/.test(apply), 'a refusal puts the cell back');
});
it('the browser asks Eleme with the shop calls the merchant shell already names', () => {
  const B = read('lib/eleme-browser.js');
  assert.ok(B.includes("'openShop'"), 'ncp open');
  assert.ok(B.includes('updateShopBusyLevel') && /busyLevel:\s*2/.test(B), 'ncp close is 休息中');
  assert.ok(B.includes('xtop.shop.shopBusinessOperateTop.openShop'), 'xtop open');
  assert.ok(B.includes('xtop.shop.shopBusinessOperateTop.closeShop'), 'xtop close');
  assert.ok(B.includes('async setBusinessStatus(open)'), 'the daemon has a method to call');
});
it('a status payload says open or closed only when it really does', () => {
  const { shopLooksOpen } = require(path.join(ROOT, 'lib', 'eleme-browser'));
  assert.strictEqual(shopLooksOpen({ busyLevel: 0 }), true);
  assert.strictEqual(shopLooksOpen({ busyLevel: 2 }), false);
  assert.strictEqual(shopLooksOpen({ data: { shop: { busy_level: 2 } } }), false);
  assert.strictEqual(shopLooksOpen({ statusText: '营业中' }), true);
  assert.strictEqual(shopLooksOpen({ statusText: '休息中' }), false);
  assert.strictEqual(shopLooksOpen({ hours: '营业时间 10:00-22:00' }), null);
  assert.strictEqual(shopLooksOpen({ note: '未营业' }), null);
  assert.strictEqual(shopLooksOpen({}), null);
});

section('2 · the phone says what is true');
it('closing Eleme at one store uses the same sentence as every other channel', () => {
  const p = phone();
  p.CMD.chanCell('eleme', 'tianhe', 0);
  const a = p.ask();
  assert.strictEqual(a.title, 'Close Eleme at Tianhe?');
  assert.strictEqual(a.body, ONE);
  noRetired(a.body);
  assert.strictEqual(p.writes.length, 0);
});
it('every other channel keeps its sentence — Meituan really does close', () => {
  const p = phone();
  p.CMD.chanCell('meituan', 'tianhe', 0);
  assert.strictEqual(p.ask().body, ONE);
});
it('reopening Eleme at a store says orders can arrive again', () => {
  const p = phone();
  p.CMD.chanCell('eleme', 'yuexiu', 1);
  assert.strictEqual(p.ask().body, ONE_OPEN);
  noRetired(p.ask().body);
});
it('the whole channel, both ways, with no Eleme exception', () => {
  const p = phone();
  p.CMD.chanAll('eleme', 0);
  assert.strictEqual(p.ask().body, ALL);
  p.CMD.chanAll('eleme', 1);
  assert.strictEqual(p.ask().body, ALL_OPEN);
  p.CMD.chanAll('meituan', 0);
  assert.ok(p.ask().body.startsWith(ALL), 'other channels unchanged');
  assert.ok(p.ask().body.includes('Meituan follows within about a minute.'), 'Meituan still names its own delay');
});
it('closing a whole shop, or everything, does not call Eleme the exception', () => {
  const p = phone();
  p.CMD.shopOpen('tianhe', 0);
  noRetired(p.ask().body);
  assert.ok(p.ask().body.startsWith('Every sales channel at this shop closes'));
  p.CMD.ocMaster(0);
  noRetired(p.ask().body);
  assert.ok(p.ask().body.includes('every Meituan shop closes within about a minute'));
});
it('in Chinese', () => {
  const p = phone({ lang: 'zh' });
  p.CMD.chanCell('eleme', 'tianhe', 0);
  assert.ok(p.ask().body.includes('该门店在此渠道将不再接到新订单'));
  noRetired(p.ask().body);
  p.CMD.chanCell('eleme', 'yuexiu', 1);
  assert.strictEqual(p.ask().body, '这家门店可以重新接单。');
  p.CMD.shopOpen('tianhe', 0);
  noRetired(p.ask().body);
  p.CMD.ocMaster(0);
  noRetired(p.ask().body);
});
it('the Sales board keeps asking while a change is still queued', () => {
  const load = block(M, 'async function loadChannels(');
  assert.ok(load.includes('x.pending') && load.includes("top==='sales'") && load.includes(',4000'), 'polls every 4s on Sales while a cell is pending');
  assert.ok(load.indexOf('chanTried&&!force') < load.indexOf('_chanPoll'), 'a casual re-entry does not cancel that wait');
});

section('3 · the desktop says the same');
it('opening Eleme at a shut shop says orders can arrive again', () => {
  const C = read('public/retail-admin/01-core.js');
  assert.ok(!C.includes('Stock is sent to Eleme'));
  assert.ok(C.includes("cuT('New orders can arrive at this store again.', '这家门店可以重新接单。')"));
  assert.ok(!/=== 'meituan' && c\.pending/.test(C) && !/=== 'meituan' && x && x\.pending/.test(C), 'applying… is any queued change');
  assert.ok(C.includes("c.pending ? ' <span class=\"sales-ch-loc-note\">'"));
});
it('the open/close panel no longer says Eleme is the exception', () => {
  const H = read('public/retail-admin.html');
  assert.ok(H.includes('Closing pauses new orders.'));
  assert.ok(!H.includes('Eleme is the exception') && !H.includes('饿了么除外'));
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
