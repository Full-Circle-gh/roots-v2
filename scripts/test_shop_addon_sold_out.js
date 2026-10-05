#!/usr/bin/env node
/**
 * The WEB SHOP's option sheet must not sell an extra the shelf has run out of.
 *
 *   node scripts/test_shop_addon_sold_out.js
 *
 * THE DEFECT THIS LOCKS DOWN. GET /api/retail/products/:id answers
 * `addon_available: false` on a stock-backed choice whose product is out
 * (test_addon_available.js locks that half). The mini app reads it
 * (product.js `sold_out`, product.wxml `op-extra-oos`) and greys the row out.
 * public/shop.html's option sheet — buildSheet inside wirePurchase — never
 * read it: the row stayed live, the customer ticked it, paid the price_delta
 * on screen, and checkout refused the basket (resolveAnswers in
 * lib/product-options.js) with nothing on the page to explain why.
 *
 * WHY THIS SUITE RUNS THE REAL SCRIPT. The wirePurchase block is cut out of
 * shop.html as text and executed against the REAL route's payload, over HTTP,
 * on a REAL sqlite database. The sheets it builds are parsed from the markup it
 * actually wrote, and driven through its own delegated click handler. A source
 * grep would pass on a build whose label never renders.
 *
 * Two kinds of tap, because they test two different things:
 *   tap()    honours `disabled` the way a browser does — a disabled row is
 *            never clicked. This is what a thumb gets.
 *   force()  delivers the click to the handler anyway. This is the guard
 *            inside the handler, which is what keeps a click that gets through
 *            (or a row a later re-enable woke up) from picking a sold-out extra.
 *
 * Not a browser suite — no Chromium. Fast shard.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const vm      = require('vm');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// Five-digit ids, clear of every 94xx–98xx block the other option suites use.
const STORE  = 87641;
const P_MAIN = 87642;   // the drink the options hang off
const A_OUT  = 87643;   // a stock-backed extra at ZERO
const A_IN   = 87644;   // a stock-backed extra with plenty on the shelf
const IDS = [P_MAIN, A_OUT, A_IN];
const CH = {};

function cleanup() {
  const ph = IDS.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM retail_product_option_choices
      WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id IN (${ph}))`
  ).run(...IDS);
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run(...IDS);
  db.prepare(`DELETE FROM retail_store_stock     WHERE product_id IN (${ph})`).run(...IDS);
  db.prepare(`DELETE FROM store_products         WHERE id         IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE, 'saso-shop', 'Sheet Shop', '选项店', '广州市', '天河区', 1);

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight, is_published, is_active)
     VALUES (?,?,?,?,?,?,1,1)`
  );
  prod.run(P_MAIN, 'Latte',    '拿铁',   'saso-0', 20, '350ml');
  prod.run(A_OUT,  'Oat Milk', '燕麦奶', 'saso-1',  3, '30ml');
  prod.run(A_IN,   'Soy Milk', '豆奶',   'saso-2',  3, '30ml');

  const stock = db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)`
  );
  stock.run(STORE, A_OUT, 0);
  stock.run(STORE, A_IN, 25);

  const opt = db.prepare(
    `INSERT INTO retail_product_options (product_id, question_en, question_cn, type, is_required, max_choices, sort_order)
     VALUES (?,?,?,?,?,?,?)`
  );
  const ch = db.prepare(
    `INSERT INTO retail_product_option_choices
       (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,?,?,?,0,?,?)`
  );
  // A radio whose FIRST answer is the sold-out one: the sheet used to pre-pick
  // the first answer blindly, so this is the shape that opens already wrong.
  const base = opt.run(P_MAIN, 'Base?', '基底?', 'single', 1, 0, 0).lastInsertRowid;
  CH.baseOat = ch.run(base, 'Oat base', '燕麦底', 0, A_OUT, 0).lastInsertRowid;
  CH.baseSoy = ch.run(base, 'Soy base', '豆奶底', 0, A_IN,  1).lastInsertRowid;
  // A pick-any capped at ONE, so ticking and unticking crosses the cap — the
  // moment the sheet re-enables the rest of the group.
  const extras = opt.run(P_MAIN, 'Extras?', '加料?', 'multi', 0, 1, 1).lastInsertRowid;
  CH.shotOat = ch.run(extras, 'Oat shot', '燕麦', 3, A_OUT, 0).lastInsertRowid;
  CH.shotSoy = ch.run(extras, 'Soy shot', '豆奶', 3, A_IN,  1).lastInsertRowid;
  CH.ice     = ch.run(extras, 'Ice',      '加冰', 0, null,  2).lastInsertRowid;
}

// ── The real wirePurchase, cut out of shop.html ────────────────────────────
const SHOP = fs.readFileSync(path.join(ROOT, 'public', 'shop.html'), 'utf8');
const START = SHOP.indexOf('(function wirePurchase(){');
const END   = SHOP.indexOf('\n  })();', START);
assert.ok(START > 0 && END > START, 'wirePurchase not found in public/shop.html — the suite cannot run');
const WIRE = SHOP.slice(START, END + '\n  })();'.length);

// ── A fake DOM just wide enough for buildSheet, fed by the markup it wrote ──
function classList(set) {
  return {
    contains: c => set.has(c),
    toggle(c, force) { const on = force === undefined ? !set.has(c) : !!force; on ? set.add(c) : set.delete(c); return on; },
  };
}
function parseSheet(mask, html) {
  mask.groups = []; mask.buttons = [];
  for (const chunk of html.split('<div class="op-group">').slice(1)) {
    const group = { buttons: [], querySelectorAll: s => (s === '.op-choice' ? group.buttons : []) };
    const re = /<button type="button" class="([^"]*)" data-oid="([^"]*)" data-cid="([^"]*)"([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(chunk))) {
      const [, cls, oid, cid, rest, inner] = m;
      const set = new Set(cls.split(/\s+/).filter(Boolean));
      const boxM = inner.match(/<span class="op-box">([^<]*)<\/span>/);
      const btn = {
        cid: Number(cid),
        classes: set,
        classList: classList(set),
        dataset: { oid, cid, ...(/data-oos="1"/.test(rest) ? { oos: '1' } : {}) },
        disabled: /\sdisabled(\s|$)/.test(rest),
        label: (inner.match(/<span class="op-cl">([^<]*)<\/span>/) || [])[1],
        oos:   (inner.match(/<span class="op-oos">([^<]*)<\/span>/) || [])[1],
        delta: (inner.match(/<span class="op-cd">([^<]*)<\/span>/) || [])[1],
        box: boxM ? { textContent: boxM[1] } : null,
        parentElement: group,
        querySelector(s) { return s === '.op-box' ? btn.box : null; },
        closest(s) { return s === '.op-choice' ? btn : s === '.op-group' ? group : null; },
      };
      group.buttons.push(btn); mask.buttons.push(btn);
    }
    mask.groups.push(group);
  }
  const addM = html.match(/data-add>([^<]*)</);
  mask.addBtn = addM ? { textContent: addM[1], closest: s => (s === '[data-add]' ? mask.addBtn : null) } : null;
}
function makeMask() {
  const mask = {
    className: '', removed: false, listeners: {},
    addEventListener(t, f) { mask.listeners[t] = f; },
    remove() { mask.removed = true; },
    querySelector(s) { return s === '[data-add]' ? mask.addBtn : null; },
  };
  Object.defineProperty(mask, 'innerHTML', { set(h) { parseSheet(mask, h); } });
  return mask;
}
const byCid = (mask, cid) => mask.buttons.find(b => b.cid === Number(cid));
const dispatch = (mask, target) => mask.listeners.click({ target });
const tap   = (mask, btn) => { if (!btn.disabled) dispatch(mask, btn); };   // what a browser does
const force = (mask, btn) => dispatch(mask, btn);                            // what the guard must stop
const confirm = mask => dispatch(mask, mask.addBtn);

function runPage(p, lang) {
  const sheets = [], cart = [], toasts = [];
  const els = {};
  const el = sel => (els[sel] ||= { textContent: '', listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } });
  const state = { lang };
  const ctx = {
    p, popts: Array.isArray(p.options) ? p.options : [], ss: { soldOut: false },
    hasVariants: false, variants: [], state,
    nowPrice: x => Number(x.price) || 0,   // shop.html's own, minus the flash arm (no flash seeded)
    money: v => '¥' + Number(v).toFixed(2),
    pick: (en, cn) => (state.lang === 'cn' ? (cn || en) : (en || cn)),
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    toast: t => toasts.push(t), cnShowNext: () => false, cartAdd: l => cart.push(l), thumb: () => '',
    slEff: () => 0, slStock: () => ({}), slMoney: v => v, slImg: () => '',
    $: el,
    document: { createElement: () => { const m = makeMask(); sheets.push(m); return m; }, body: { appendChild() {} } },
  };
  vm.createContext(ctx);
  vm.runInContext(WIRE, ctx, { filename: 'shop.html#wirePurchase' });
  el('#addBtn').listeners.click();   // the product page's Add button opens the first sheet
  return { sheets, cart, toasts };
}

// ── Run ─────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

(async () => {
  seed();
  const app = express(); app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const resp = await fetch(`http://127.0.0.1:${port}/api/retail/products/${P_MAIN}`)
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  server.close();
  const p = (resp.body && (resp.body.data || resp.body)) || {};

  console.log(`\nGET /api/retail/products/${P_MAIN} → ${resp.status}`);
  check('the route serves both groups, with the out extra flagged', () => {
    assert.strictEqual(resp.status, 200);
    assert.strictEqual((p.options || []).length, 2);
    const all = p.options.flatMap(o => o.choices);
    assert.strictEqual(all.find(c => c.id === CH.shotOat).addon_available, false);
    assert.strictEqual(all.find(c => c.id === CH.shotSoy).addon_available, true);
  });

  console.log('\n── First sheet (radio), English');
  const run = runPage(p, 'en');
  const s1 = run.sheets[0];
  check('the first sheet opened', () => assert.ok(s1 && s1.buttons.length === 2));

  check('a sold-out answer renders disabled, labelled "Sold out", with no price', () => {
    const b = byCid(s1, CH.baseOat);
    assert.strictEqual(b.disabled, true, 'the row still takes taps');
    assert.strictEqual(b.dataset.oos, '1');
    assert.ok(b.classes.has('sold-out'));
    assert.strictEqual(b.oos, 'Sold out');
  });

  check('the radio opens on the first PICKABLE answer, not the sold-out one', () => {
    assert.ok(!byCid(s1, CH.baseOat).classes.has('on'), 'the sheet opened with a sold-out answer picked');
    assert.ok(byCid(s1, CH.baseSoy).classes.has('on'));
  });

  check('a click that reaches a sold-out radio does nothing', () => {
    force(s1, byCid(s1, CH.baseOat));
    assert.ok(!byCid(s1, CH.baseOat).classes.has('on'));
    assert.ok(byCid(s1, CH.baseSoy).classes.has('on'), 'the live pick was dropped');
  });

  console.log('\n── Second sheet (pick-any, max 1)');
  confirm(s1);
  const s2 = run.sheets[1];
  check('Next opens the extras sheet', () => assert.ok(s1.removed && s2 && s2.buttons.length === 3));

  const oat = () => byCid(s2, CH.shotOat), soy = () => byCid(s2, CH.shotSoy), ice = () => byCid(s2, CH.ice);
  const foot0 = s2.addBtn && s2.addBtn.textContent;

  check('a sold-out extra renders disabled and labelled, its +¥3 replaced', () => {
    assert.strictEqual(oat().disabled, true);
    assert.strictEqual(oat().oos, 'Sold out');
    assert.strictEqual(oat().delta, undefined, 'the price still shows beside "Sold out"');
    assert.strictEqual(soy().delta, '+¥3.00', 'a live extra lost its price');
  });

  check('a free choice with no shelf is never sold out', () => {
    assert.strictEqual(ice().disabled, false);
    assert.strictEqual(ice().oos, undefined);
  });

  check('a click that reaches a sold-out extra neither ticks it nor bills it', () => {
    force(s2, oat());
    assert.ok(!oat().classes.has('on'));
    assert.strictEqual(oat().box.textContent, '');
    assert.strictEqual(s2.addBtn.textContent, foot0, 'the footer price moved');
  });

  check('reaching the cap closes the rest; the sold-out row stays closed', () => {
    tap(s2, soy());
    assert.ok(soy().classes.has('on'));
    assert.strictEqual(ice().disabled, true);
    assert.strictEqual(oat().disabled, true);
  });

  // THE QUIET ONE. Unticking below the cap re-enables the group; before the
  // fix that loop set disabled=false on every unticked row, sold-out included.
  check('dropping back under the cap re-opens the group but NOT the sold-out row', () => {
    tap(s2, soy());
    assert.ok(!soy().classes.has('on'));
    assert.strictEqual(ice().disabled, false);
    assert.strictEqual(oat().disabled, true, 'the cap re-enable woke the sold-out row');
    tap(s2, oat());
    assert.ok(!oat().classes.has('on'));
  });

  check('the basket line carries only pickable answers, at the base price', () => {
    tap(s2, ice());
    confirm(s2);
    assert.strictEqual(run.cart.length, 1, 'nothing was added: ' + run.toasts.join(' | '));
    const line = run.cart[0];
    // Array.from: the line was built inside the vm realm, whose Array is not ours.
    assert.deepStrictEqual(Array.from(line.choices, Number).sort(), [CH.baseSoy, CH.ice].map(Number).sort());
    assert.strictEqual(line.price, 20);
  });

  console.log('\n── Chinese');
  const cn = runPage(p, 'cn').sheets[0];
  check('the label is the live pair 售罄 (vocabulary soldOut, the size picker\'s own word)', () => {
    assert.strictEqual(byCid(cn, CH.baseOat).oos, '售罄');
  });

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
