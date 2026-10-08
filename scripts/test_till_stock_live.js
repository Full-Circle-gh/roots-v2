#!/usr/bin/env node
/**
 * The till's shelf follows the shelf.
 *
 *   node scripts/test_till_stock_live.js
 *
 * Reported from Yuexiu, 2026-10-08: Carrot-Ginger Juice still showed
 * "Out of stock" on the counter tablet after it was restocked on another
 * device, and only came back once the cashier left the till and reopened it.
 * The till read its catalogue once — at open and on a store switch — and
 * nothing ever read it again.
 *
 * No browser. The functions under test are cut out of public/till.html as
 * written and run here against stubs, the same way test_till_knock.js does, so
 * what passes is the shipped text and the suite stays in the fast shard.
 *
 *   • A STOCK RING RE-READS THE SHELF and repaints: Out of stock becomes 5.
 *   • A BURST OF RINGS IS ONE READ, not a stack of them.
 *   • A READ FOR A SHOP THE TILL JUST LEFT IS DROPPED, so it cannot paint the
 *     old shelf over the new one.
 *   • QUIET UNDER A TAKEOVER: the data updates, the settle screen is not
 *     repainted underneath.
 *   • THE ORDER RING DOES NOT RE-READ THE SHELF, and the stock ring does not
 *     re-read the order queue.
 *   • THE POLL IS THE FLOOR: a stale catalogue is re-read on the next tick, a
 *     fresh one is left alone.
 *   • COMING BACK TO THE FOREGROUND re-reads the shelf.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'till.html'), 'utf8');
const problems = [];
let checks = 0;
function ok(name, v) { checks++; if (!v) problems.push(name); }

function fn(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n');
  const m = src.match(re);
  if (!m) throw new Error('till.html has no function ' + name + '()');
  return m[0];
}
const floor = src.match(/\n  var CAT_FLOOR_MS = (\d+);/);
if (!floor) throw new Error('till.html has no CAT_FLOOR_MS');

const tick = () => new Promise((r) => setImmediate(r));
const row = (id, stock) => ({ product_id: id, name_en: 'P' + id, price: 10, stock });

function world() {
  const w = {
    S: { storeId: 1, view: 'till', stock: {}, products: [], cats: [] },
    renders: 0, catReads: 0, pendReads: 0, answer: [row(5, 0)],
    pending: [], es: null, interval: null, hidden: false,
  };
  const ctx = {
    S: w.S, String, Number, Array, Date, encodeURIComponent,
    document: { get hidden() { return w.hidden; } },
    // Held until released, so the tests decide when a read lands.
    api: (u) => {
      if (u.indexOf('counter-catalogue') < 0) return Promise.resolve({});
      w.catReads++;
      const answer = w.answer;
      return new Promise((resolve) => w.pending.push(() => resolve({ success: true, data: { rows: answer, shop_id: 3 } })));
    },
    render: () => { w.renders++; },
    loadPend: () => { w.pendReads++; },
    setInterval: (f) => { w.interval = f; return 1; },
    clearInterval: () => {},
    window: { EventSource: function (url) { w.es = this; this.url = url; this.h = {}; } },
  };
  ctx.window.EventSource.prototype.addEventListener = function (k, f) { this.h[k] = f; };
  ctx.window.EventSource.prototype.close = function () {};
  ctx.EventSource = ctx.window.EventSource;
  vm.createContext(ctx);
  vm.runInContext(
    'var CAT_FLOOR_MS = ' + floor[1] + ';' +
    fn('loadCatalogue') + fn('refreshCatalogue') + fn('openPendStream') + fn('startPendPoll'),
    ctx);
  w.ctx = ctx;
  w.release = async () => { const p = w.pending.splice(0); p.forEach((f) => f()); await tick(); await tick(); };
  return w;
}

(async function run() {
  // Boot: the till opens on an empty shelf.
  {
    const w = world();
    w.ctx.startPendPoll();
    ok('the till subscribes to its shop', w.es && /store_id=1/.test(w.es.url));
    ok('the stream listens for stock rings', typeof (w.es && w.es.h['shop-stock']) === 'function');

    w.ctx.loadCatalogue(); await w.release();
    ok('boot read: juice is out', w.S.stock[5] === 0);
    const rendersBefore = w.renders;

    // Restocked on another device: the server rings.
    w.answer = [row(5, 5)];
    w.es.h['shop-stock']();
    await w.release();
    ok('a stock ring re-reads the shelf', w.S.stock[5] === 5);
    ok('and repaints the tiles', w.renders > rendersBefore);

    // A burst of rings while one read is out is one read.
    const readsBefore = w.catReads;
    w.es.h['shop-stock'](); w.es.h['shop-stock'](); w.es.h['shop-stock']();
    ok('a burst of rings is one read in flight', w.catReads === readsBefore + 1);
    await w.release();
    w.es.h['shop-stock']();
    ok('the next ring after it lands reads again', w.catReads === readsBefore + 2);
    await w.release();

    // A failed read must not leave the till deaf for the rest of the shift.
    const reads2 = w.catReads;
    w.ctx.api = () => Promise.reject(new Error('net'));
    w.ctx.refreshCatalogue(); await tick(); await tick();
    w.ctx.api = () => { w.catReads++; return Promise.resolve({ success: true, data: { rows: [row(5, 2)] } }); };
    w.ctx.refreshCatalogue(); await tick(); await tick();
    ok('a failed read does not jam later ones', w.catReads === reads2 + 1 && w.S.stock[5] === 2);
  }

  // The rings are kept apart.
  {
    const w = world();
    w.ctx.openPendStream();
    w.es.h['shop-order']();
    ok('an order ring does not re-read the shelf', w.catReads === 0);
    ok('an order ring re-reads the queue', w.pendReads === 1);
    w.es.h['shop-stock']();
    ok('a stock ring does not re-read the queue', w.pendReads === 1);
  }

  // A reply for the shop the till just left is dropped.
  {
    const w = world();
    w.answer = [row(5, 9)];
    w.ctx.refreshCatalogue();
    w.S.storeId = 2;                    // switched while the read was out
    w.S.stock = { 5: 1 };
    await w.release();
    ok('a read for the shop just left is dropped', w.S.stock[5] === 1);
    ok('and paints nothing', w.renders === 0);
  }

  // Quiet under a takeover.
  {
    const w = world();
    w.S.view = 'settle';
    w.answer = [row(5, 4)];
    w.ctx.refreshCatalogue(); await w.release();
    ok('under a takeover the shelf still updates', w.S.stock[5] === 4);
    ok('but the settle screen is not repainted', w.renders === 0);
  }

  // The poll is the floor under a dropped socket.
  {
    const w = world();
    w.ctx.startPendPoll();
    w.ctx.loadCatalogue(); await w.release();
    const reads = w.catReads;
    w.interval();
    ok('a fresh catalogue is not re-read on every tick', w.catReads === reads);
    w.S.catAt = Date.now() - Number(floor[1]) - 1;
    w.interval();
    ok('a stale catalogue is re-read on the next tick', w.catReads === reads + 1);
    await w.release();
    w.hidden = true; w.S.catAt = 0;
    w.interval();
    ok('a hidden till does not poll the shelf', w.catReads === reads + 1);
  }

  // Coming back to the foreground: the anonymous handler, checked as text.
  {
    const m = src.match(/document\.addEventListener\('visibilitychange', function \(\) \{\n    if \(document\.hidden\) return;[\s\S]*?\n  \}\);/);
    ok('waking the till re-reads the shelf', !!m && /refreshCatalogue\(\)/.test(m[0]));
  }

  if (problems.length) {
    console.log('FAIL — ' + problems.length + ' of ' + checks + ':');
    problems.forEach((p) => console.log('  ✗ ' + p));
    process.exit(1);
  }
  console.log('PASS — ' + checks + ' checks: the till shelf follows the shelf');
})().catch((e) => { console.error(e); process.exit(1); });
