#!/usr/bin/env node
/**
 * AIR IS ALWAYS ON THE JD LABEL DIALOG'S LIST — marked, never hidden.
 *
 * WHAT THIS IS ABOUT. A ground parcel's label dialog used to filter the air
 * product (生鲜特快 / LL-SD-M) out of its radio list entirely, which turned a
 * DEFAULT into a LOCK: the one case where the operator knows something the
 * shipment plan does not had no way through the dialog. The server has always
 * accepted an explicit product on any parcel — `const product = reqProduct || …`
 * in the waybill route — so nothing here grants new power; it stops the screen
 * from hiding what the route already allows.
 *
 * WHAT IS NOT DELEGATED IS DOING IT SILENTLY. Where the parcel carries goods the
 * airline refuses (ship_modes = land only), the air row is badged, those goods
 * are NAMED on it, and picking it asks once before the waybill is booked. A
 * parcel with no such goods asks nothing — an operator who is warned every time
 * stops reading the warning, and that is the failure this file guards against as
 * much as the missing option was.
 *
 * THE PARCEL'S OWN MODE IS NEVER WRITTEN. Same rule as the Fujian / Guangxi
 * ground default (scripts/test_jd_waybill_land_default.js): a 'land' parcel that
 * books air STAYS a 'land' parcel, and only the product printed on its waybill
 * changes.
 *
 * The REAL public/retail-admin/04-orders.js is loaded into a VM context and the
 * REAL createJdLabel is called — the HTML asserted on below is the HTML the
 * screen builds, not a copy of it. Offline: no network, no install, no database.
 *   node scripts/test_jd_label_air_option.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// ── DOM stub ───────────────────────────────────────────────────────────────
// Only what the dialog touches. querySelector answers off the innerHTML the
// dialog actually produced, so the checked radio this reports is the one the
// operator would really see pre-selected — not a value the harness invented.
let SELECTED = null;          // what the operator clicks; null = leave the preset
function makeNode() {
  const clicks = [];
  const node = {
    className: '', innerHTML: '', style: {}, value: '', clicks,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(ev, fn) { if (ev === 'click') clicks.push(fn); },
    appendChild() {}, remove() { node.removed = true; },
    closest: () => node,
    querySelectorAll: () => [],
    querySelector(sel) {
      if (sel === '#jd-svc-submit') {
        if (!node._submit) node._submit = makeNode();
        return node._submit;
      }
      if (sel === '#jd-pieces') {
        if (!node._pieces) { node._pieces = makeNode(); node._pieces.value = '1'; }
        return node._pieces;
      }
      if (sel === 'input[name="jd-svc"]:checked') {
        if (SELECTED != null) return { value: SELECTED };
        const m = /<input type="radio" name="jd-svc" value="([^"]+)" checked/.exec(node.innerHTML);
        return m ? { value: m[1] } : null;
      }
      return null;
    },
  };
  return node;
}

// ── the screen's neighbours, faked ─────────────────────────────────────────
let MOUNTED = null;           // the dialog element, captured on mount
const ASKED = [];             // every confirmation actually put to the operator
const BOOKED = [];            // every waybill the dialog tried to create
let CONFIRM_ANSWER = true;    // what the operator answers when asked

// The screen's own language switch. cuT lives in 10-extras.js, which this
// suite does not load — so the harness supplies it, and every assertion below
// that reads a label says which language it is reading. The Chinese half is
// asserted in Chinese; asserting it against an English render would pass while
// the 中文 was missing entirely.
let LANG = 'en';

const sandbox = {
  console, Promise, Date, Math, JSON, Set, Map, Array, Object, Number, String,
  parseInt, parseFloat, isFinite, isNaN, RegExp, Error,
  encodeURIComponent, decodeURIComponent,
  // No-op timers: the file arms background polls on load (unseen-inbox, clock)
  // that would fire into a half-stubbed document after the assertions finish.
  // Nothing in the label dialog is on a timer.
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
  addEventListener: () => {}, removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: '', search: '' },
  navigator: {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  cuT: (en, cn) => (LANG === 'cn' ? cn : en),
  cuLang: () => LANG,
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  escapeAttr: s => String(s == null ? '' : s).replace(/"/g, '&quot;'),
  document: {
    createElement: () => makeNode(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList: { contains: () => false, add() {}, remove() {} }, appendChild() {} },
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8'),
                sandbox, { filename: '04-orders.js' });

// Overridden AFTER the load so the file's own definitions don't win.
vm.runInContext(`
  mountFloatingPuModal = (el) => { __mounted(el); };
  askConfirm = (opts) => __askConfirm(opts);
  submitJdLabel = (orderId, shipmentId, product, btn, pieces) => __booked(orderId, shipmentId, product, pieces);
  toast = () => {};
`, sandbox);
sandbox.__mounted = (el) => { MOUNTED = el; };
sandbox.__askConfirm = async (opts) => { ASKED.push(opts); return CONFIRM_ANSWER; };
sandbox.__booked = async (orderId, shipmentId, product, pieces) => {
  BOOKED.push({ orderId, shipmentId, product, pieces });
  return true;
};

// ── fixtures ───────────────────────────────────────────────────────────────
// ship_modes_arr is what the order GET hands the drawer (routes/retail.js runs
// every item through parseShipModes), so these are the real shapes.
const ANY     = { id: 1, name_en: 'Olive Oil',          name_cn: '橄榄油',   ship_modes_arr: ['air', 'land'] };
const NO_AIR  = { id: 2, name_en: 'Misfit Medjool Dates', name_cn: '次果椰枣', ship_modes_arr: ['land'] };
const NO_AIR2 = { id: 3, name_en: 'Tahini',             name_cn: '芝麻酱',   ship_modes_arr: ['land'] };
const AIRONLY = { id: 4, name_en: 'Fresh Wrap',         name_cn: '鲜卷',     ship_modes_arr: ['air'] };
const LOCAL   = { id: 5, name_en: 'Counter Cake',       name_cn: '柜台蛋糕', ship_modes_arr: ['local'] };
const NO_MODES= { id: 6, name_en: 'Unflagged',          name_cn: '未标记',   ship_modes_arr: null };

// Open the dialog the way the drawer does, and hand back what it produced.
function openDialog({ mode = 'land', isFresh = 0, items = [ANY], province = '北京市', lang = 'en' } = {}) {
  MOUNTED = null; ASKED.length = 0; BOOKED.length = 0; SELECTED = null; LANG = lang;
  const order = {
    id: 738,
    address: { province },
    shipments: [{ id: 91, mode, items }],
  };
  vm.runInContext('_OPEN_ORDER = __order;', Object.assign(sandbox, { __order: order }));
  sandbox.createJdLabel(738, 91, mode, isFresh, null);
  return MOUNTED;
}

// Press "Create & ship" on the open dialog, optionally clicking a row first.
async function createAndShip(dialog, pick) {
  SELECTED = pick != null ? pick : null;
  const submit = dialog.querySelector('#jd-svc-submit');
  await submit.clicks[0]({ currentTarget: submit });
}

// Which service codes the dialog offered, in the order it offered them.
function offered(dialog) {
  return (dialog.innerHTML.match(/name="jd-svc" value="([^"]+)"/g) || [])
    .map(s => /value="([^"]+)"/.exec(s)[1]);
}
function preselected(dialog) {
  const m = /<input type="radio" name="jd-svc" value="([^"]+)" checked/.exec(dialog.innerHTML);
  return m ? m[1] : null;
}

let pass = 0, fail = 0;
function it(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; });
}
const assert = require('assert');

async function main() {
  console.log('\nJD label dialog — air is on the list, marked when the airline refuses it\n');

  console.log('  1. a ground parcel now lists air');
  await it('a LAND parcel offers all three services, air last', () => {
    const d = openDialog({ mode: 'land', items: [ANY] });
    assert.deepStrictEqual(offered(d), ['LL-HD-M', 'ed-m-0001', 'LL-SD-M'],
      'the ground list is not [fresh-ground, ambient-ground, air] — air must be present and last');
  });

  await it('a LOCAL parcel offers the same three', () => {
    const d = openDialog({ mode: 'local', items: [ANY] });
    assert.ok(offered(d).includes('LL-SD-M'), 'a local parcel cannot reach air at all');
  });

  await it('the pre-selection is exactly what it was: ambient ground when nothing is fresh', () => {
    assert.strictEqual(preselected(openDialog({ mode: 'land', isFresh: 0, items: [ANY] })), 'ed-m-0001');
  });

  await it('the pre-selection is exactly what it was: fresh ground when the box holds ice', () => {
    assert.strictEqual(preselected(openDialog({ mode: 'land', isFresh: 1, items: [ANY] })), 'LL-HD-M');
  });

  console.log('\n  2. the mark, and who gets it');
  await it('a parcel carrying an airline-rejected item badges the air row and NAMES the item', () => {
    const d = openDialog({ mode: 'land', items: [ANY, NO_AIR] });
    assert.ok(/pack-badge land/.test(d.innerHTML), 'the air row carries no Land only badge');
    assert.ok(/airline rejected/.test(d.innerHTML), 'the reason is not on the row');
    assert.ok(d.innerHTML.includes('Misfit Medjool Dates'),
      'the rejected item is not named — a warning that does not say WHICH item cannot be acted on');
    assert.ok(!d.innerHTML.includes('Olive Oil'),
      'an item the airline accepts is listed as rejected');
  });

  await it('and says the same thing in 中文, in the register the drawer already uses', () => {
    const d = openDialog({ mode: 'land', items: [ANY, NO_AIR], lang: 'cn' });
    assert.ok(d.innerHTML.includes('仅陆运'), 'the badge has no 中文');
    assert.ok(d.innerHTML.includes('仅陆运 — 航空拒运'),
      'the reason line is not the live pair renderPackBadges already uses');
    assert.ok(d.innerHTML.includes('次果椰枣'), 'the item is named in English on a Chinese screen');
    assert.ok(!/airline rejected/.test(d.innerHTML), 'English leaked into the Chinese render');
  });

  await it('every rejected item is named, not just the first', () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR, NO_AIR2] });
    assert.ok(d.innerHTML.includes('Misfit Medjool Dates') && d.innerHTML.includes('Tahini'),
      'only some of the rejected items are named');
  });

  await it('a parcel with nothing rejected carries NO badge', () => {
    const d = openDialog({ mode: 'land', items: [ANY, AIRONLY] });
    assert.ok(!/pack-badge land/.test(d.innerHTML),
      'air is badged as rejected on a parcel that holds nothing the airline refuses — '
      + 'a warning shown every time is a warning nobody reads');
  });

  await it('an item with NO ship_modes is not claimed as an airline rejection', () => {
    // parseShipModes gives an unflagged item both modes; the drawer's own
    // fallback does the same. Neither is a rejection.
    const d = openDialog({ mode: 'land', items: [NO_MODES] });
    assert.ok(!/pack-badge land/.test(d.innerHTML), 'an unflagged item was treated as airline-rejected');
  });

  await it('a LOCAL-only item is not claimed as an airline rejection either', () => {
    const d = openDialog({ mode: 'local', items: [LOCAL] });
    assert.ok(!/pack-badge land/.test(d.innerHTML), 'a same-city item was treated as airline-rejected');
  });

  console.log('\n  3. what happens when the operator picks air');
  await it('air on a clean parcel books LL-SD-M and asks nothing', async () => {
    const d = openDialog({ mode: 'land', items: [ANY] });
    await createAndShip(d, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 0, 'the operator was asked about a parcel with nothing to warn about');
    assert.strictEqual(BOOKED.length, 1, 'no waybill was booked');
    assert.strictEqual(BOOKED[0].product, 'LL-SD-M', `booked ${BOOKED[0].product}, not air`);
  });

  await it('air on a rejected parcel ASKS, and names the item in the question', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    CONFIRM_ANSWER = true;
    await createAndShip(d, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 1, 'the operator was not asked');
    const q = JSON.stringify(ASKED[0]);
    assert.ok(q.includes('Misfit Medjool Dates'), 'the question does not say which item');
    // askConfirm takes the pair and picks a side itself, so BOTH halves must be
    // on the options object whatever language the screen is in.
    assert.ok(/航空拒运/.test(q), 'the question carries no 中文');
    assert.ok(/cannot ship by air/.test(q), 'the question carries no English');
    assert.ok(ASKED[0].danger === true, 'the question is not marked as the exception it is');
  });

  await it('and the operator saying yes books air — this is an override, not a block', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    CONFIRM_ANSWER = true;
    await createAndShip(d, 'LL-SD-M');
    assert.strictEqual(BOOKED.length, 1, 'the waybill was not booked after the operator insisted');
    assert.strictEqual(BOOKED[0].product, 'LL-SD-M', `booked ${BOOKED[0].product}, not air`);
  });

  await it('the operator saying no books NOTHING and leaves the dialog open', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    CONFIRM_ANSWER = false;
    await createAndShip(d, 'LL-SD-M');
    assert.strictEqual(BOOKED.length, 0, 'a waybill was booked after the operator backed out');
    assert.ok(!d.removed, 'the dialog closed on a cancelled confirmation, losing the pieces count');
    CONFIRM_ANSWER = true;
  });

  await it('GROUND on a rejected parcel asks nothing — the warning is about air only', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    await createAndShip(d);          // leave the preset alone
    assert.strictEqual(ASKED.length, 0, 'booking the ordinary ground product now asks a question');
    assert.strictEqual(BOOKED[0].product, 'ed-m-0001', `booked ${BOOKED[0].product}`);
  });

  await it('the pieces count still reaches the booking', async () => {
    const d = openDialog({ mode: 'land', items: [ANY] });
    d.querySelector('#jd-pieces').value = '3';
    await createAndShip(d);
    assert.strictEqual(BOOKED[0].pieces, 3, `booked ${BOOKED[0].pieces} pieces`);
  });

  console.log('\n  4. the cases that must NOT have changed');
  await it('a plain AIR parcel still asks nothing and books 生鲜特快', async () => {
    const d = openDialog({ mode: 'air', items: [AIRONLY], province: '北京市' });
    assert.deepStrictEqual(offered(d), [], 'an air parcel now asks a question it never asked');
    await createAndShip(d);
    assert.strictEqual(BOOKED[0].product, 'LL-SD-M', `booked ${BOOKED[0].product}`);
  });

  await it('an AIR parcel into 广西壮族自治区 still offers both fresh services, ground pre-selected', () => {
    const d = openDialog({ mode: 'air', items: [AIRONLY], province: '广西壮族自治区' });
    // JD_SERVICES' own order, which puts air first there; ground is the one
    // that is CHECKED. Unchanged by this file's work and asserted so it stays so.
    assert.deepStrictEqual(offered(d), ['LL-SD-M', 'LL-HD-M'], 'the land-default province list changed');
    assert.strictEqual(preselected(d), 'LL-HD-M', 'ground is no longer pre-selected there');
  });

  await it('the drawer with no open order still opens a usable dialog', () => {
    // openOrder populates _OPEN_ORDER; a dialog opened before it lands has no
    // items to read and must fall through to the plain list rather than throw.
    MOUNTED = null;
    vm.runInContext('_OPEN_ORDER = null;', sandbox);
    sandbox.createJdLabel(738, 91, 'land', 0, null);
    assert.ok(MOUNTED, 'no dialog was built');
    assert.ok(offered(MOUNTED).includes('LL-SD-M'), 'air is missing when the order is not loaded');
    assert.ok(!/pack-badge land/.test(MOUNTED.innerHTML),
      'an unknown parcel was claimed to be airline-rejected');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main();
