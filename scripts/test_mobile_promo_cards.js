#!/usr/bin/env node
/**
 * §299 — PROMO CARDS, EDITED FROM THE PHONE.
 *
 *   node scripts/test_mobile_promo_cards.js
 *
 * Ash, 2026-09-30, on the phone editor: promo cards (§296) could be placed but
 * not edited there — its quick-edit sheet takes text fields and sends pictures
 * to desktop, and a promo card is nothing but a picture, a link and two days.
 * The sheet now gives the block its own small editor.
 *
 * The code is RUN, sliced out of public/cms-mobile.html into a sandbox with a
 * minimal stand-in for the page (no browser: this suite stays in the fast
 * shard). What it pins:
 *   1. per card: picture, status, link, start / end, move, remove; add up to 5
 *      and then no Add;
 *   2. every change sends the WHOLE `cards` list through the bridge's 'patch'
 *      (the desktop editor underneath saves and redraws it);
 *   3. a link set on desktop that the phone list does not offer is kept;
 *   4. an upload lands on the card it was picked for; a refusal says so and
 *      changes nothing;
 *   5. the "images are tuned on desktop" note is not shown for this block.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_ALL = fs.readFileSync(path.join(ROOT, 'public/cms-mobile.html'), 'utf8');
const start = SRC_ALL.indexOf('const PROMO_MAX = 5;');
const end = SRC_ALL.indexOf('/* ── DESIGN sheet (page background)');
const SRC = SRC_ALL.slice(start, end);

let passed = 0, failed = 0;
const queue = [];
function section(t) { queue.push(() => console.log('\n' + t)); }
function it(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}

// A stand-in element: keeps its HTML, hands out one control per data-a="…".
function el() {
  const e = {
    html: '', kids: [], controls: {}, style: {}, textContent: '',
    set innerHTML(v) { this.html = v; this.kids = []; this.controls = {}; },
    get innerHTML() { return this.html; },
    appendChild(k) { this.kids.push(k); },
    querySelector(sel) {
      const m = sel.match(/\[data-a=([a-z]+)\]/);
      const k = m && m[1];
      if (!k) return null;
      if (!this.controls[k]) this.controls[k] = { onclick: null, onchange: null };
      return this.controls[k];
    },
  };
  return e;
}
function mk(opts = {}) {
  const sent = [];
  let renders = 0;
  const ctx = {
    M: { lang: 'en', editId: 'p1' },
    cuT: (en) => en,
    esc: (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    send: (cmd, x) => sent.push({ cmd, x: JSON.parse(JSON.stringify(x)) }),
    renderEdit: () => { renders++; },
    fetch: async (u) => {
      if (/category-tree/.test(u)) return { json: async () => ({ data: opts.tops || [] }) };
      return opts.upload;
    },
    FormData: class { append() {} },
    createImageBitmap: async () => { throw new Error('no canvas'); },
    document: { createElement: () => el() },
    location: {},
    Object, Math, Date, JSON, Promise, String, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, sent, renders: () => renders };
}
const CARD = (o) => Object.assign({ id: 'a', image_url: '/api/retail/media/1', target: '', start_at: '', end_at: '' }, o);
const draw = (ctx, blk) => { const body = el(); ctx.renderPromoEdit(body, blk); return body; };
const tick = () => new Promise((r) => setImmediate(r));

section('1 · the sheet');
{
  it('the block is where it was, and the sheet routes promo_cards to it', () => {
    assert.ok(start > 0 && end > start);
    assert.ok(/else if \(type === 'promo_cards'\) \{\s*renderPromoEdit\(body, blk\);/.test(SRC_ALL));
  });
  it('the "images are tuned on desktop" note is skipped for this block', () => {
    assert.ok(/if \(type === 'promo_cards'\) return;\s*body\.insertAdjacentHTML\('beforeend',/.test(SRC_ALL));
  });
  it('each card: picture, status, link, dates, move, remove', () => {
    const { ctx } = mk();
    const body = draw(ctx, { id: 'p1', cards: [CARD(), CARD({ id: 'b', end_at: '2000-01-01' })] });
    assert.strictEqual(body.kids.filter((k) => /pc-card/.test(k.className || '')).length, 2);
    const [c1, c2] = body.kids;
    assert.ok(/<img src="\/api\/retail\/media\/1"/.test(c1.html));
    assert.ok(/pc-stat">Live</.test(c1.html));
    assert.ok(/pc-stat off">Ended 2000-01-01</.test(c2.html));
    assert.ok(/data-a="up" aria-label="Move up" disabled/.test(c1.html), 'the first cannot move up');
    assert.ok(/data-a="down" aria-label="Move down" disabled/.test(c2.html), 'the last cannot move down');
    assert.ok(/Replace picture/.test(c1.html) && /type="date" data-a="start"/.test(c1.html));
  });
  it('add up to five, then no Add', () => {
    const { ctx } = mk();
    const four = draw(ctx, { id: 'p1', cards: [CARD(), CARD(), CARD(), CARD()] });
    assert.ok(/\+ Add card \(4 of 5\)/.test(four.kids[four.kids.length - 1].textContent));
    const five = draw(ctx, { id: 'p1', cards: [CARD(), CARD(), CARD(), CARD(), CARD()] });
    assert.ok(!five.kids.some((k) => /Add card/.test(k.textContent || '')));
  });
}

section('2 · every change patches the WHOLE list');
{
  it('a link, a day, a move, a remove, an add', () => {
    const { ctx, sent } = mk();
    const blk = { id: 'p1', cards: [CARD({ id: 'a' }), CARD({ id: 'b' })] };
    let body = draw(ctx, blk);
    body.kids[0].controls.link.onchange({ target: { value: 'coupons' } });
    assert.deepStrictEqual(sent[0], { cmd: 'patch', x: { id: 'p1', patch: { cards: [CARD({ id: 'a', target: 'coupons' }), CARD({ id: 'b' })] } } });
    body = draw(ctx, blk);
    body.kids[1].controls.end.onchange({ target: { value: '2026-10-31' } });
    assert.strictEqual(sent[1].x.patch.cards[1].end_at, '2026-10-31');
    body = draw(ctx, blk);
    body.kids[1].controls.up.onclick();
    assert.deepStrictEqual(sent[2].x.patch.cards.map((c) => c.id), ['b', 'a']);
    body = draw(ctx, blk);
    body.kids[0].controls.rm.onclick();
    assert.deepStrictEqual(sent[3].x.patch.cards.map((c) => c.id), ['a']);
    body = draw(ctx, blk);
    body.kids[body.kids.length - 1].onclick();
    assert.strictEqual(sent[4].x.patch.cards.length, 2);
    assert.deepStrictEqual(Object.keys(sent[4].x.patch.cards[1]).sort(), ['end_at', 'id', 'image_url', 'start_at', 'target']);
  });
}

section('3 · the link list');
{
  it('pages, the shop\'s top categories, and picture only', async () => {
    const { ctx } = mk({ tops: [{ id: 'ready', name: 'Ready to Eat', name_cn: '即食' }] });
    ctx.loadPromoTops(); await tick(); await tick();
    const html = ctx.promoLinkOptions('category:ready');
    assert.ok(/<option value="">Picture only<\/option>/.test(html));
    assert.ok(/<option value="promotions">Promotions page<\/option>/.test(html));
    assert.ok(/<option value="category:ready" selected>Ready to Eat<\/option>/.test(html));
  });
  it('a product link set on desktop is kept, named by its number', () => {
    const { ctx } = mk();
    assert.ok(/<option value="product:42" selected>Product #42<\/option>/.test(ctx.promoLinkOptions('product:42')));
  });
}

section('4 · uploading a picture');
{
  it('lands on the card it was picked for', async () => {
    const ok = { status: 200, json: async () => ({ success: true, data: { url: '/api/retail/media/77' } }) };
    const { ctx, sent } = mk({ upload: ok });
    const blk = { id: 'p1', cards: [CARD({ id: 'a' }), CARD({ id: 'b', image_url: '' })] };
    await ctx.promoUpload(blk, 1, {});
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].x.patch.cards[1].image_url, '/api/retail/media/77');
    assert.strictEqual(sent[0].x.patch.cards[0].image_url, '/api/retail/media/1', 'the other card is untouched');
  });
  it('a refused upload says so and changes nothing', async () => {
    const no = { status: 400, json: async () => ({ success: false, error: 'too_large' }) };
    const { ctx, sent } = mk({ upload: no });
    await ctx.promoUpload({ id: 'p1', cards: [CARD()] }, 0, {});
    assert.strictEqual(sent.length, 0);
    const body = draw(ctx, { id: 'p1', cards: [CARD()] });
    assert.ok(/pc-err">Upload failed: too_large</.test(body.html));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
