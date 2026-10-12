#!/usr/bin/env node
/**
 * §153 on the QR MENU — the picker obeys the count, not just the endpoint.
 *
 *   node scripts/test_shop_menu_limits.js
 *
 * THE FINDING, reported by Ash from a live menu. A group headed *Choose 2
 * crunchy sides* was authored `min 2 / max 2` in the product editor, saved,
 * and the QR menu still took one side, or three.
 *
 * §153 built the limit in three of the four places it had to be:
 *
 *   the editor        two number boxes, saved and read back        ✓
 *   the endpoint      too_many_answers / too_few_answers           ✓
 *   the web shop      public/shop.html — hint, block               ✓
 *   THE QR MENU       routes/shop-menu.js — nothing at all         ✗
 *
 * The menu SERVED min and max to the page (they ride on each group in the
 * <template data-op>) and its own picker never read them. So the customer
 * ticked three sides, the sheet accepted it, and the ORDER ROUTE refused the
 * basket at checkout with a machine string nothing on screen could explain.
 * §153's own summary names that trap — "clamp one side and not the other and
 * the endpoint refuses the very order the page told the customer to place" —
 * and the comment left at the endpoint says the sheet enforces the ceiling
 * "with a greyed-out tick-box". That sentence was true of shop.html's sheet
 * and false of this one.
 *
 * WHY THIS SUITE RUNS THE REAL SCRIPT. A source grep would have passed on the
 * broken build: every string this picker needs was already in the file, just
 * never called. So the page is served from the REAL router over HTTP against a
 * REAL sqlite database, its inline script is executed, and the picker is
 * driven by CLICKS through the same delegated handler a thumb reaches. What is
 * asserted is the markup pkPaint actually produced and the refusal oAdd
 * actually wrote — not that a token appears somewhere in the source.
 *
 * The simulation honours `disabled` exactly as a browser does: a row the paint
 * disabled is never clicked. That is the whole mechanism under test, so a stub
 * that ignored it would be marking its own homework.
 *
 * Not a browser suite — no Chromium, no layout. It belongs in the fast shard,
 * and CLAUDE.md's standing instruction is that the slow shard is not run.
 *
 * WHAT THIS SUITE DOES NOT COVER, said out loud so the silence is not read as
 * coverage. pkLive() counts only answers that are still pickable, and replacing
 * it with a bare sel.length passes every case below. That is not a hole in the
 * suite so much as a state the page cannot reach: a sold-out answer never
 * enters the selection, because the paint renders its row disabled
 * (`(c.out||cap)?' disabled':''`) and the opener skips sold-out defaults
 * (`if(c.def&&!c.out)`). The filter is kept because pkMissing has always
 * measured the same way and two counters of one thing drift, but it is
 * defensive rather than load-bearing, and no test here proves it.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const vm      = require('vm');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of test_shop_menu_options.js's 94xx block.
const LOC      = 9461;
const CODE     = 'QPTSAAC7';
const P_PLATE  = 9571;   // "choose 2 of 3", every answer free and on the shelf
const P_OPEN   = 9572;   // a pick-any with NO limit — the shape that predates §153
const P_THIN   = 9573;   // floor of 2, but only ONE answer is still pickable
const A_GONE1  = 9574;   // an answer at zero
const A_GONE2  = 9575;   // another at zero

const IDS = [P_PLATE, P_OPEN, P_THIN, A_GONE1, A_GONE2];
const OPT = {}, CH = {};

function cleanup() {
  const orderIds = db.prepare('SELECT id FROM retail_orders WHERE store_id = ?').all(LOC).map(r => r.id);
  if (orderIds.length) {
    const oq = orderIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM retail_stock_reservations WHERE order_id IN (${oq})`).run(...orderIds);
    db.prepare(`DELETE FROM retail_order_items        WHERE order_id IN (${oq})`).run(...orderIds);
    db.prepare(`DELETE FROM retail_payments           WHERE order_id IN (${oq})`).run(...orderIds);
    db.prepare(`DELETE FROM retail_orders             WHERE id       IN (${oq})`).run(...orderIds);
  }
  const ph = IDS.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM retail_product_option_choices
      WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id IN (${ph}))`
  ).run(...IDS);
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  db.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  // §460: a QR order now commits its shelf lines on submit, which writes ledger
  // rows against these products — they go before the products do.
  db.prepare('DELETE FROM retail_stock_ledger WHERE store_id = ?').run(LOC);
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(LOC);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
     VALUES (?,?,?,?,1,97)`
  ).run(LOC, '__test_lims', 'Limits fixture', '测试数量店');

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
     VALUES (?,?,?,?,?,1,1,?)`
  );
  prod.run(P_PLATE, 'Fixture platter', '测试拼盘', '__L-71', 55, 'Food');
  prod.run(P_OPEN,  'Fixture bowl',    '测试碗',   '__L-72', 40, 'Food');
  prod.run(P_THIN,  'Fixture thin',    '测试少量', '__L-73', 44, 'Food');
  prod.run(A_GONE1, 'Fixture gone 1',  '测试缺一', '__L-74', 2,  'Food');
  prod.run(A_GONE2, 'Fixture gone 2',  '测试缺二', '__L-75', 2,  'Food');

  const shopId = db.prepare(
    'INSERT INTO shops (location_id, public_code, is_active) VALUES (?,?,1)'
  ).run(LOC, CODE).lastInsertRowid;

  const add = db.prepare(
    `INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
     VALUES (?,?,?,?,1,?)`
  );
  add.run(shopId, P_PLATE, 55, 'made_here', 0);
  add.run(shopId, P_OPEN,  40, 'made_here', 1);
  add.run(shopId, P_THIN,  44, 'made_here', 2);

  // Both linked answers are at ZERO, so the thin platter has one pickable side.
  const shelf = db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)`
  );
  shelf.run(LOC, A_GONE1, 0);
  shelf.run(LOC, A_GONE2, 0);

  const mkOpt = db.prepare(
    `INSERT INTO retail_product_options
       (product_id, question_en, question_cn, type, is_required, min_choices, max_choices, sort_order)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const mkCh = db.prepare(
    `INSERT INTO retail_product_option_choices
       (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,?,?,?,?,?,?)`
  );

  // The reported shape: three free sides, choose exactly two.
  OPT.sides   = mkOpt.run(P_PLATE, 'Choose 2 crunchy sides', '爽脆配菜', 'multi', 1, 2, 2, 0).lastInsertRowid;
  CH.crackers = mkCh.run(OPT.sides, 'Whole wheat crackers', '全麦饼干', 0, 0, null, 0).lastInsertRowid;
  CH.chips    = mkCh.run(OPT.sides, 'Tortilla corn chips',  '玉米片',   0, 0, null, 1).lastInsertRowid;
  CH.veg      = mkCh.run(OPT.sides, 'Veggie sticks',        '蔬菜条',   0, 0, null, 2).lastInsertRowid;

  // No limit at all — 0/0, which is every group authored before §153.
  OPT.open    = mkOpt.run(P_OPEN, 'Add extras', '加点配料', 'multi', 0, 0, 0, 0).lastInsertRowid;
  CH.oA       = mkCh.run(OPT.open, 'Extra A', '加料甲', 0, 0, null, 0).lastInsertRowid;
  CH.oB       = mkCh.run(OPT.open, 'Extra B', '加料乙', 0, 0, null, 1).lastInsertRowid;
  CH.oC       = mkCh.run(OPT.open, 'Extra C', '加料丙', 0, 0, null, 2).lastInsertRowid;

  // Floor of 2, two of the three answers gone: the floor must CLAMP to 1.
  OPT.thin    = mkOpt.run(P_THIN, 'Choose 2 sides', '配菜二选', 'multi', 1, 2, 2, 0).lastInsertRowid;
  CH.tLive    = mkCh.run(OPT.thin, 'Still here', '尚有',   0, 0, null,    0).lastInsertRowid;
  CH.tGone1   = mkCh.run(OPT.thin, 'Gone one',   '缺一',   0, 0, A_GONE1, 1).lastInsertRowid;
  CH.tGone2   = mkCh.run(OPT.thin, 'Gone two',   '缺二',   0, 0, A_GONE2, 2).lastInsertRowid;
}

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(router);
let PORT = 0, pass = 0, fail = 0;

const get = (u) => fetch(`http://127.0.0.1:${PORT}${u}`)
  .then(async r => ({ status: r.status, body: await r.text() }));
const post = (u, b) => fetch(`http://127.0.0.1:${PORT}${u}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const unesc = (s) => s
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The questions the page hands the picker, parsed back out of the template.
function optsOnCard(body, pid) {
  const m = body.match(new RegExp(`<template data-op="${pid}">([\\s\\S]*?)</template>`));
  return m ? JSON.parse(unesc(m[1])) : null;
}

/* ── The picker, actually running ──────────────────────────────────────────
   Enough DOM for the page's own script to load and for its delegated click
   handler to be reached. Deliberately NOT a DOM library: what is under test is
   the markup the picker writes, so the rows are read back out of that markup
   rather than out of a tree some other parser built from it. */
function openPicker(html, pid) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const src = scripts.find(s => s.includes('pkPaint'));
  assert.ok(src, 'no inline script on the page carries the option picker');

  const els = new Map();
  const mkEl = () => ({
    innerHTML: '', textContent: '', hidden: true, className: '', value: '', disabled: false,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    _a: {}, _h: {},
    getAttribute(k) { return k in this._a ? this._a[k] : null },
    setAttribute(k, v) { this._a[k] = v },
    removeAttribute(k) { delete this._a[k] },
    addEventListener(t, fn) { (this._h[t] || (this._h[t] = [])).push(fn) },
    removeEventListener() {}, focus() {}, blur() {}, click() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    appendChild() {}, removeChild() {}, insertBefore() {}, remove() {},
    closest() { return null }, querySelector: () => null, querySelectorAll: () => [],
    scrollTop: 0, offsetHeight: 0, parentNode: null, content: null, children: [],
  });
  const byId = (id) => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id) };

  const clicks = [];
  const doc = {
    documentElement: mkEl(), body: mkEl(), head: mkEl(),
    getElementById: byId,
    createElement: () => mkEl(),
    addEventListener(t, fn) { if (t === 'click') clicks.push(fn) },
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector(sel) {
      // The one query the picker genuinely depends on: its questions.
      const m = /^template\[data-op="(\d+)"\]$/.exec(sel);
      if (m) {
        const t = html.match(new RegExp(`<template data-op="${m[1]}">([\\s\\S]*?)</template>`));
        if (!t) return null;
        const e = mkEl(); e.textContent = unesc(t[1]); e.content = null; return e;
      }
      return mkEl();
    },
  };
  const sandbox = {
    document: doc, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname: `/s/${CODE}`, href: `/s/${CODE}`, search: '', replace() {}, assign() {} },
    history: { replaceState() {}, pushState() {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    IntersectionObserver: null, ResizeObserver: null, navigator: { userAgent: 'node' },
    alert() {}, scrollTo() {}, addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 5000 });
  assert.ok(clicks.length, 'the page script bound no delegated click handler');

  // A click that the page's own handler will resolve the way a thumb would.
  const fire = (el) => {
    const ev = { target: { closest: (sel) => el.matches(sel) ? el.node : null },
      preventDefault() {}, stopPropagation() {} };
    for (const h of clicks) h(ev);
  };

  // Open the sheet through the card's real + button.
  const addBtn = {
    node: Object.assign(mkEl(), { _a: {
      'data-add': String(pid), 'data-p': '55', 'data-ask': '1',
      'data-en': 'Fixture', 'data-cn': '测试' } }),
    matches: (sel) => sel === '.add',
  };
  addBtn.node.closest = (sel) => (sel === '.add' ? addBtn.node : null);
  fire(addBtn);

  const bodyEl = byId('sheetB'), errEl = byId('oErr'), addEl = byId('oAdd');
  assert.ok(/class="og"/.test(bodyEl.innerHTML),
    'the picker never painted — the stub is broken, not the code under test');

  // Read the rows back out of the markup the picker just wrote.
  const rows = () => [...bodyEl.innerHTML.matchAll(
    /<button type="button" class="(oc[^"]*)"( disabled)? data-og="(\d+)" data-oc="(\d+)">/g)]
    .map(m => ({ cls: m[1], disabled: !!m[2], og: Number(m[3]), oc: Number(m[4]),
      on: / on\b/.test(m[1]), cap: / cap\b/.test(m[1]), out: / out\b/.test(m[1]) }));

  const tick = (cid) => {
    const r = rows().find(x => x.oc === cid);
    assert.ok(r, `no row for choice ${cid}`);
    const node = Object.assign(mkEl(), { disabled: r.disabled,
      _a: { 'data-og': String(r.og), 'data-oc': String(r.oc) } });
    node.closest = (sel) => (sel === '.oc' ? node : null);
    fire({ node, matches: (sel) => sel === '.oc' });
    return r;
  };
  const submit = () => {
    errEl.hidden = true;
    for (const h of (addEl._h.click || [])) h({ preventDefault() {}, stopPropagation() {} });
    return { refused: !errEl.hidden, message: errEl.innerHTML };
  };
  return { html: () => bodyEl.innerHTML, rows, tick, submit, addLabel: () => addEl.innerHTML };
}

const text = (h) => h.replace(/<[^>]*>/g, '');
/* THE LIMIT LINE ALONE, never the heading above it. The fixture question is
   titled "Choose 2 crunchy sides" — Ash's own label — so a search of the whole
   sheet for "Choose 2" passes whether or not the picker rendered anything at
   all. It did pass that way once while this suite was being written, which is
   the reason this helper exists. */
const limLines = (h) => [...h.matchAll(/<div class="og-lim">([\s\S]*?)<\/div>/g)]
  .map(m => text(m[1]));

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  console.log('\n── 1 · the page is handed the numbers');

  await check('a limited group brings its floor and ceiling to the client', async () => {
    const { body } = await get(`/s/${CODE}`);
    const g = (optsOnCard(body, P_PLATE) || [])[0];
    assert.ok(g, 'no questions on the platter card');
    assert.strictEqual(g.min, 2, `min served as ${g.min}`);
    assert.strictEqual(g.max, 2, `max served as ${g.max}`);
  });

  await check('a group with no limit still serves 0/0 and is untouched', async () => {
    const { body } = await get(`/s/${CODE}`);
    const g = (optsOnCard(body, P_OPEN) || [])[0];
    assert.strictEqual(g.min, 0, `min served as ${g.min}`);
    assert.strictEqual(g.max, 0, `max served as ${g.max}`);
  });

  await check('the floor is CLAMPED to what is still pickable before it is served', async () => {
    const { body } = await get(`/s/${CODE}`);
    const g = (optsOnCard(body, P_THIN) || [])[0];
    assert.strictEqual(g.min, 1,
      `authored floor 2 with one pickable answer should serve 1, served ${g.min}`);
  });

  console.log('\n── 2 · the picker says how many, and means it');

  await check('the question carries "Choose 2 · 选 2 项" under its heading', async () => {
    const { body } = await get(`/s/${CODE}`);
    const p = openPicker(body, P_PLATE);
    const ls = limLines(p.html());
    assert.strictEqual(ls.length, 1, `expected one limit line, got ${ls.length}`);
    assert.ok(ls[0].includes('Choose 2'), `English hint reads: ${ls[0]}`);
    assert.ok(ls[0].includes('选 2 项'), `Chinese hint reads: ${ls[0]}`);
  });

  await check('a third side cannot be ticked once two are on', async () => {
    const { body } = await get(`/s/${CODE}`);
    const p = openPicker(body, P_PLATE);
    p.tick(CH.crackers); p.tick(CH.chips);
    const veg = p.rows().find(r => r.oc === CH.veg);
    assert.ok(veg.cap, 'the third row was not capped');
    assert.ok(veg.disabled, 'the third row was left tappable');
    p.tick(CH.veg);
    assert.strictEqual(p.rows().filter(r => r.on).length, 2,
      'the ceiling let a third answer on');
  });

  await check('the two already ticked stay live, so a mind can still be changed', async () => {
    const { body } = await get(`/s/${CODE}`);
    const p = openPicker(body, P_PLATE);
    p.tick(CH.crackers); p.tick(CH.chips);
    const on = p.rows().filter(r => r.on);
    assert.strictEqual(on.length, 2, 'expected two ticked');
    assert.ok(on.every(r => !r.disabled && !r.cap), 'a ticked row was capped — no way back');
    p.tick(CH.crackers);
    assert.strictEqual(p.rows().filter(r => r.on).length, 1, 'unticking did not work');
    assert.ok(!p.rows().find(r => r.oc === CH.veg).disabled,
      'dropping back under the ceiling did not reopen the third row');
  });

  await check('one side is refused at Add to basket, and the refusal names the count', async () => {
    const { body } = await get(`/s/${CODE}`);
    const p = openPicker(body, P_PLATE);
    p.tick(CH.crackers);
    const r = p.submit();
    assert.ok(r.refused, 'a single side was accepted under a floor of two');
    const t = text(r.message);
    assert.ok(t.includes('Choose 2'), `English count missing from refusal: ${t}`);
    assert.ok(t.includes('选 2 项'), `Chinese count missing from refusal: ${t}`);
    assert.ok(t.includes('Choose 2 crunchy sides'), `refusal does not name the question: ${t}`);
  });

  await check('two sides is accepted', async () => {
    const { body } = await get(`/s/${CODE}`);
    const p = openPicker(body, P_PLATE);
    p.tick(CH.crackers); p.tick(CH.chips);
    assert.strictEqual(p.submit().refused, false, 'the exact answer asked for was refused');
  });

  await check('nothing ticked is still refused, without a count it does not need', async () => {
    const { body } = await get(`/s/${CODE}`);
    const p = openPicker(body, P_THIN);   // floor clamped to 1
    const r = p.submit();
    assert.ok(r.refused, 'an unanswered required question was accepted');
    assert.ok(!text(r.message).includes('Choose 1'),
      'a floor of one names a count that tells the customer nothing');
  });

  console.log('\n── 3 · a group with no limit is the group it always was');

  await check('no hint, no cap, and every answer still tickable', async () => {
    const { body } = await get(`/s/${CODE}`);
    const p = openPicker(body, P_OPEN);
    assert.ok(!/og-lim/.test(p.html()), 'an unlimited group printed a limit line');
    p.tick(CH.oA); p.tick(CH.oB); p.tick(CH.oC);
    assert.strictEqual(p.rows().filter(r => r.on).length, 3,
      'an unlimited group refused a third answer');
    assert.ok(p.rows().every(r => !r.cap), 'an unlimited group capped a row');
    assert.strictEqual(p.submit().refused, false, 'an optional group blocked the button');
  });

  await check('a clamped group prints the rule it will actually enforce', async () => {
    const { body } = await get(`/s/${CODE}`);
    const p = openPicker(body, P_THIN);
    const ls = limLines(p.html());
    assert.strictEqual(ls.length, 1, `expected one limit line, got ${ls.length}`);
    // Authored 2/2 with one answer left. effectiveLimits lowers the floor to
    // what can be picked AND drops the ceiling, because a ceiling of two that
    // only one answer can reach is not a rule, it is noise. So the sentence is
    // the floor's own shape, not "Choose".
    assert.ok(ls[0].includes('At least 1'), `clamped hint reads: ${ls[0]}`);
    assert.ok(ls[0].includes('至少 1 项'), `clamped CN hint reads: ${ls[0]}`);
    assert.ok(!ls[0].includes('Choose 2') && !ls[0].includes('选 2 项'),
      `the sheet promised two answers when only one can be given: ${ls[0]}`);
  });

  console.log('\n── 4 · the page and the endpoint agree');

  await check('what the sheet refuses, the endpoint refuses too', async () => {
    const r = await post(`/s/${CODE}/order`, {
      name: 'Limit tester', place: 'T1',
      items: [{ store_product_id: P_PLATE, qty: 1, choices: [CH.crackers] }],
    });
    assert.strictEqual(r.status, 400, `expected a refusal, got ${r.status}`);
    assert.strictEqual(r.json && r.json.error, 'too_few_answers',
      `endpoint said ${r.json && r.json.error}`);
  });

  await check('and what it accepts, the endpoint accepts', async () => {
    for (const k of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) await router.orderLimiter.resetKey(k);
    const r = await post(`/s/${CODE}/order`, {
      name: 'Limit tester', place: 'T2',
      items: [{ store_product_id: P_PLATE, qty: 1, choices: [CH.crackers, CH.chips] }],
    });
    assert.strictEqual(r.status, 201, `the exact answer asked for was refused: ${JSON.stringify(r.json)}`);
  });

  server.close();
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
