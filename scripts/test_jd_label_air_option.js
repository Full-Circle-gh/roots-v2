#!/usr/bin/env node
/**
 * PICKING AIR ON A LAND PARCEL ASKS FIRST — on the click, off the parcel.
 *
 * WHAT THIS IS ABOUT. A ground parcel's label dialog used to filter the air
 * product (生鲜特快 / LL-SD-M) out of its radio list entirely, which turned a
 * DEFAULT into a LOCK. Air is on the list now, and picking it on a parcel the
 * system planned as LAND stops and asks before anything is booked.
 *
 * THE PARCEL IS THE TRIGGER, NOT THE PRODUCT, and that is the second ruling
 * here. The first version warned only where an item carried a land-only
 * ship_modes flag — so the ordinary case, a land parcel holding goods nobody
 * has flagged, booked air in silence, and getting the warning at all meant
 * editing a product. Ash's ruling (2026-09-16): the parcel already says it is a
 * land shipment and that is the whole condition. §3 below is where that lives;
 * a regression there is the exact bug that ruling was given to fix.
 *
 * ON THE CLICK, AND ONLY THERE. Ash chose the moment. Declining restores the
 * previously selected row, and there is deliberately NO second question at
 * Create & ship — two dialogs for one decision is how an operator learns to
 * click through both without reading either. §4 holds both halves.
 *
 * THE PARCEL'S OWN MODE IS NEVER WRITTEN. Same rule as the Fujian / Guangxi
 * ground default (scripts/test_jd_waybill_land_default.js): a 'land' parcel
 * that books air STAYS a 'land' parcel, and only the product printed on its
 * waybill changes.
 *
 * The REAL public/retail-admin/04-orders.js is loaded into a VM context and the
 * REAL createJdLabel is called — the HTML asserted on is the HTML the screen
 * builds, and the radios clicked below are the ones it built. Offline: no
 * network, no install, no database.
 *   node scripts/test_jd_label_air_option.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

// The screen's own language switch. cuT lives in 10-extras.js, which this suite
// does not load — so the harness supplies it, and every assertion below that
// reads a label says which language it is reading. The Chinese half is asserted
// in Chinese; asserting it against an English render would pass while the 中文
// was missing entirely.
let LANG = 'en';

// ── DOM stub ───────────────────────────────────────────────────────────────
// The radios are PARSED OUT OF THE INNERHTML the dialog produced, so the rows
// clicked below are the rows it really built, with the checked state it really
// set. A harness that invented its own radios would be testing itself.
function makeRadio(value, checked) {
  const handlers = [];
  return {
    value, checked, name: 'jd-svc',
    addEventListener(ev, fn) { if (ev === 'change') handlers.push(fn); },
    async fire() { for (const fn of handlers) await fn(); },
  };
}

function makeNode() {
  const clicks = [];
  let html = '';
  let radios = [];
  const node = {
    className: '', style: {}, value: '', clicks, removed: false,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(ev, fn) { if (ev === 'click') clicks.push(fn); },
    appendChild() {}, remove() { node.removed = true; },
    closest: () => node,
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = String(v);
      radios = [];
      const re = /<input type="radio" name="jd-svc" value="([^"]+)"( checked)?/g;
      let m;
      while ((m = re.exec(html))) radios.push(makeRadio(m[1], !!m[2]));
    },
    get radios() { return radios; },
    querySelectorAll(sel) {
      return sel === 'input[name="jd-svc"]' ? radios : [];
    },
    querySelector(sel) {
      if (sel === '#jd-svc-submit') {
        if (!node._submit) node._submit = makeNode();
        return node._submit;
      }
      if (sel === '#jd-pieces') {
        if (!node._pieces) { node._pieces = makeNode(); node._pieces.value = '1'; }
        return node._pieces;
      }
      if (sel === 'input[name="jd-svc"]:checked') return radios.find(r => r.checked) || null;
      const byValue = /^input\[name="jd-svc"\]\[value="([^"]+)"\]$/.exec(sel);
      if (byValue) return radios.find(r => r.value === byValue[1]) || null;
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
const ANY      = { id: 1, name_en: 'Olive Oil',            name_cn: '橄榄油',   ship_modes_arr: ['air', 'land'] };
const NO_AIR   = { id: 2, name_en: 'Misfit Medjool Dates', name_cn: '次果椰枣', ship_modes_arr: ['land'] };
const NO_AIR2  = { id: 3, name_en: 'Tahini',               name_cn: '芝麻酱',   ship_modes_arr: ['land'] };
const AIRONLY  = { id: 4, name_en: 'Fresh Wrap',           name_cn: '鲜卷',     ship_modes_arr: ['air'] };
const LOCAL    = { id: 5, name_en: 'Counter Cake',         name_cn: '柜台蛋糕', ship_modes_arr: ['local'] };
const NO_MODES = { id: 6, name_en: 'Unflagged',            name_cn: '未标记',   ship_modes_arr: null };
const SPARE    = { id: 7, name_en: 'Za\'atar',             name_cn: '香草料',   ship_modes_arr: ['air', 'land'] };

// Open the dialog the way the drawer does, and hand back what it produced.
function openDialog({ mode = 'land', isFresh = 0, items = [ANY], province = '北京市', lang = 'en' } = {}) {
  MOUNTED = null; ASKED.length = 0; BOOKED.length = 0; LANG = lang;
  const order = { id: 738, address: { province }, shipments: [{ id: 91, mode, items }] };
  vm.runInContext('_OPEN_ORDER = __order;', Object.assign(sandbox, { __order: order }));
  sandbox.createJdLabel(738, 91, mode, isFresh, null);
  return MOUNTED;
}

// Click a service row the way an operator does: the browser moves `checked`
// and THEN fires change, which is the order the handler is written against.
async function clickRow(dialog, code) {
  const radio = dialog.querySelector(`input[name="jd-svc"][value="${code}"]`);
  assert.ok(radio, `the dialog has no ${code} row to click`);
  dialog.radios.forEach(r => { r.checked = false; });
  radio.checked = true;
  await radio.fire();
}

// Press "Create & ship".
async function createAndShip(dialog) {
  const submit = dialog.querySelector('#jd-svc-submit');
  await submit.clicks[0]({ currentTarget: submit });
}

const offered = d => (d.innerHTML.match(/name="jd-svc" value="([^"]+)"/g) || [])
  .map(s => /value="([^"]+)"/.exec(s)[1]);
const preselected = d => (d.radios.find(r => r.checked) || {}).value || null;
const checkedNow = d => (d.radios.find(r => r.checked) || {}).value || null;

let pass = 0, fail = 0;
function it(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; });
}

async function main() {
  console.log('\nJD label dialog — air is on the list, and picking it on a land parcel asks first\n');

  console.log('  1. a ground parcel lists air');
  await it('a LAND parcel offers all three services, air last', () => {
    const d = openDialog({ mode: 'land', items: [ANY] });
    assert.deepStrictEqual(offered(d), ['LL-HD-M', 'ed-m-0001', 'LL-SD-M'],
      'the ground list is not [fresh-ground, ambient-ground, air] — air must be present and last');
  });

  await it('a LOCAL parcel offers the same three', () => {
    assert.ok(offered(openDialog({ mode: 'local', items: [ANY] })).includes('LL-SD-M'),
      'a local parcel cannot reach air at all');
  });

  await it('the pre-selection is exactly what it was: ambient ground when nothing is fresh', () => {
    assert.strictEqual(preselected(openDialog({ mode: 'land', isFresh: 0, items: [ANY] })), 'ed-m-0001');
  });

  await it('the pre-selection is exactly what it was: fresh ground when the box holds ice', () => {
    assert.strictEqual(preselected(openDialog({ mode: 'land', isFresh: 1, items: [ANY] })), 'LL-HD-M');
  });

  console.log('\n  2. the row badge — the airline REFUSES these, a stronger claim than the plan');
  await it('a parcel carrying an airline-rejected item badges the air row and NAMES the item', () => {
    const d = openDialog({ mode: 'land', items: [ANY, NO_AIR] });
    assert.ok(/pack-badge land/.test(d.innerHTML), 'the air row carries no Land only badge');
    assert.ok(/airline rejected/.test(d.innerHTML), 'the reason is not on the row');
    assert.ok(d.innerHTML.includes('Misfit Medjool Dates'), 'the rejected item is not named');
    assert.ok(!/Olive Oil[^<]*<\/span>\s*$/.test(d.innerHTML.split('LL-SD-M')[1] || ''),
      'an item the airline accepts is listed as rejected');
  });

  await it('and says the same thing in 中文, in the register the drawer already uses', () => {
    const d = openDialog({ mode: 'land', items: [ANY, NO_AIR], lang: 'cn' });
    assert.ok(d.innerHTML.includes('仅陆运 — 航空拒运'),
      'the reason line is not the live pair renderPackBadges already uses');
    assert.ok(d.innerHTML.includes('次果椰枣'), 'the item is named in English on a Chinese screen');
    assert.ok(!/airline rejected/.test(d.innerHTML), 'English leaked into the Chinese render');
  });

  await it('a parcel with nothing rejected carries NO badge', () => {
    assert.ok(!/pack-badge land/.test(openDialog({ mode: 'land', items: [ANY, AIRONLY] }).innerHTML),
      'air is badged as airline-rejected on a parcel holding nothing the airline refuses');
  });

  await it('an item with NO ship_modes is not claimed as an airline rejection', () => {
    assert.ok(!/pack-badge land/.test(openDialog({ mode: 'land', items: [NO_MODES] }).innerHTML),
      'an unflagged item was treated as airline-rejected');
  });

  await it('a LOCAL-only item is not claimed as an airline rejection either', () => {
    assert.ok(!/pack-badge land/.test(openDialog({ mode: 'local', items: [LOCAL] }).innerHTML),
      'a same-city item was treated as airline-rejected');
  });

  console.log('\n  3. THE RULING — the parcel asks, whatever the products say');
  await it('a plain LAND parcel with NOTHING flagged still asks when air is clicked', async () => {
    // The case the first version got wrong: no land-only item anywhere, so it
    // booked air in silence and the only way to be warned was to edit a product.
    const d = openDialog({ mode: 'land', items: [ANY] });
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 1,
      'an ordinary land parcel books air with no question — the parcel is the trigger, not the product');
  });

  await it('a LAND parcel of UNFLAGGED items asks too', async () => {
    const d = openDialog({ mode: 'land', items: [NO_MODES] });
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 1, 'an unflagged parcel was let through in silence');
  });

  await it('a LOCAL parcel asks as well', async () => {
    const d = openDialog({ mode: 'local', items: [LOCAL] });
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 1, 'a same-city parcel books air with no question');
  });

  await it('a parcel carrying a flagged item asks the same once, not twice', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 1, 'the flagged case asks a different number of times');
  });

  await it('picking a GROUND row never asks', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    await clickRow(d, 'LL-HD-M');
    await clickRow(d, 'ed-m-0001');
    assert.strictEqual(ASKED.length, 0, 'choosing the ordinary ground product now asks a question');
  });

  await it('an AIR parcel picking air asks NOTHING — air is what the plan asked for', async () => {
    const d = openDialog({ mode: 'air', items: [AIRONLY], province: '广西壮族自治区' });
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 0,
      'the Fujian / Guangxi list now questions the air option it exists to offer');
  });

  console.log('\n  4. the question, and what each answer does');
  await it('it names the parcel contents, and reads in both languages', async () => {
    const d = openDialog({ mode: 'land', items: [ANY, NO_AIR] });
    await clickRow(d, 'LL-SD-M');
    const q = JSON.stringify(ASKED[0]);
    assert.ok(q.includes('Olive Oil') && q.includes('Misfit Medjool Dates'),
      'the question does not name what is in the parcel');
    assert.ok(/仅陆运/.test(q), 'the question carries no 中文');
    assert.ok(/land shipping only/i.test(q), 'the question carries no English');
    assert.strictEqual(ASKED[0].danger, true, 'the question is not marked as the exception it is');
  });

  await it('a long parcel is capped at three names and counts the rest', async () => {
    const d = openDialog({ mode: 'land', items: [ANY, NO_AIR, NO_AIR2, AIRONLY, SPARE] });
    await clickRow(d, 'LL-SD-M');
    const body = ASKED[0].bodyEn;
    assert.ok(/\+2/.test(body), `the overflow is not counted: ${body}`);
    assert.ok(!body.includes('Fresh Wrap') && !body.includes("Za'atar"),
      'every name is listed — a dialog nobody reads to the end');
  });

  await it('a parcel whose items are unknown still asks, without a blank name', async () => {
    // openOrder populates _OPEN_ORDER; a dialog opened before it lands has no
    // items to read and must still put the question.
    MOUNTED = null; ASKED.length = 0; BOOKED.length = 0; LANG = 'en';
    vm.runInContext('_OPEN_ORDER = null;', sandbox);
    sandbox.createJdLabel(738, 91, 'land', 0, null);
    await clickRow(MOUNTED, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 1, 'no question was put when the order was not loaded');
    assert.ok(/This parcel is land shipping only/.test(ASKED[0].bodyEn),
      `the body names nothing and says so badly: ${ASKED[0].bodyEn}`);
    assert.ok(!/<b><\/b>/.test(ASKED[0].bodyEn), 'an empty name is rendered in bold');
  });

  await it('YES leaves air selected, and Create & ship books it with NO second question', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    CONFIRM_ANSWER = true;
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(checkedNow(d), 'LL-SD-M', 'air did not stay selected after the operator insisted');
    await createAndShip(d);
    assert.strictEqual(ASKED.length, 1,
      'the operator was asked twice for one decision — that is how both get clicked through unread');
    assert.strictEqual(BOOKED.length, 1, 'no waybill was booked');
    assert.strictEqual(BOOKED[0].product, 'LL-SD-M', `booked ${BOOKED[0].product}, not air`);
  });

  await it('NO puts the selection back where it was, and books nothing', async () => {
    const d = openDialog({ mode: 'land', isFresh: 0, items: [NO_AIR] });
    CONFIRM_ANSWER = false;
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(checkedNow(d), 'ed-m-0001',
      `the row stayed on ${checkedNow(d)} after the operator backed out — the next press would book air`);
    assert.strictEqual(BOOKED.length, 0, 'a waybill was booked from the click itself');
    assert.ok(!d.removed, 'the dialog closed on a declined question');
    CONFIRM_ANSWER = true;
  });

  await it('NO returns to the row the operator was actually on, not the preset', async () => {
    const d = openDialog({ mode: 'land', isFresh: 0, items: [NO_AIR] });
    await clickRow(d, 'LL-HD-M');              // moved off the ed-m-0001 preset
    CONFIRM_ANSWER = false;
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(checkedNow(d), 'LL-HD-M',
      `backing out landed on ${checkedNow(d)} — it must return to where the operator was`);
    CONFIRM_ANSWER = true;
  });

  await it('and then Create & ship books THAT row, not air', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    CONFIRM_ANSWER = false;
    await clickRow(d, 'LL-SD-M');
    CONFIRM_ANSWER = true;
    await createAndShip(d);
    assert.strictEqual(BOOKED[0].product, 'ed-m-0001', `booked ${BOOKED[0].product} after a declined question`);
  });

  console.log('\n  5. the cases that must NOT have changed');
  await it('a plain AIR parcel left on air asks nothing and books 生鲜特快', async () => {
    // Its list is no longer empty (§381, section 6 below), but air is still
    // pre-selected, and an operator who leaves it alone is never questioned.
    const d = openDialog({ mode: 'air', items: [AIRONLY], province: '北京市' });
    assert.strictEqual(preselected(d), 'LL-SD-M', 'an air parcel no longer pre-selects air');
    await createAndShip(d);
    assert.strictEqual(ASKED.length, 0, 'a plain air parcel was questioned');
    assert.strictEqual(BOOKED[0].product, 'LL-SD-M', `booked ${BOOKED[0].product}`);
  });

  await it('an AIR parcel into 广西壮族自治区 still offers both fresh services, ground pre-selected', () => {
    const d = openDialog({ mode: 'air', items: [AIRONLY], province: '广西壮族自治区' });
    // JD_SERVICES' own order, which puts air first there; ground is the one
    // that is CHECKED. Unchanged by this file's work and asserted so it stays so.
    assert.deepStrictEqual(offered(d), ['LL-SD-M', 'LL-HD-M'], 'the land-default province list changed');
    assert.strictEqual(preselected(d), 'LL-HD-M', 'ground is no longer pre-selected there');
  });

  await it('the pieces count still reaches the booking, and survives a declined question', async () => {
    const d = openDialog({ mode: 'land', items: [NO_AIR] });
    d.querySelector('#jd-pieces').value = '3';
    CONFIRM_ANSWER = false;
    await clickRow(d, 'LL-SD-M');
    CONFIRM_ANSWER = true;
    await createAndShip(d);
    assert.strictEqual(BOOKED[0].pieces, 3, `booked ${BOOKED[0].pieces} pieces`);
  });

  // §381 — the mirror. Ash (2026-10-01), on a combined parcel the plan made
  // air: "there should always be an option to select land transport if user
  // want and it comes with a warning". Before this, an air parcel's dialog
  // had no list at all and 生鲜特快 was the only thing it could book.
  console.log('\n  6. §381 — ground is on an AIR parcel\'s list, and picking it asks');
  await it('an AIR parcel offers all three services, air first and pre-selected', () => {
    const d = openDialog({ mode: 'air', items: [ANY, NO_AIR], province: '北京市' });
    assert.deepStrictEqual(offered(d), ['LL-SD-M', 'LL-HD-M', 'ed-m-0001'],
      'an air parcel cannot reach ground — the list must be [air, fresh-ground, ambient-ground]');
    assert.strictEqual(preselected(d), 'LL-SD-M', 'air is not pre-selected on an air parcel');
  });

  await it('picking fresh ground on an air parcel asks, and names the contents', async () => {
    const d = openDialog({ mode: 'air', items: [ANY, NO_AIR], province: '北京市' });
    await clickRow(d, 'LL-HD-M');
    assert.strictEqual(ASKED.length, 1, 'an air parcel moved to ground with no question');
    const q = ASKED[0];
    assert.ok(q.bodyEn.includes('Olive Oil') && q.bodyEn.includes('Misfit Medjool Dates'),
      `the question does not name what is in the parcel: ${q.bodyEn}`);
    assert.ok(/planned for air/.test(q.bodyEn) && /ground waybill anyway\?/.test(q.bodyEn),
      `the English does not say what is being overridden: ${q.bodyEn}`);
    assert.ok(q.bodyCn.includes('计划空运') && q.bodyCn.includes('仍要生成陆运运单吗?'),
      `the 中文 does not say it: ${q.bodyCn}`);
    assert.strictEqual(q.titleCn, '空运包裹', 'the title is not the dialog\'s own live 空运包裹');
    assert.strictEqual(q.confirmCn, '仍要生成陆运运单', 'the confirm button is not the body question without 吗?');
    assert.strictEqual(q.cancelCn, '暂不', 'the decline is not the live 暂不');
    assert.strictEqual(q.danger, true, 'the question is not marked as the exception it is');
  });

  await it('picking ambient ground on an air parcel asks too', async () => {
    const d = openDialog({ mode: 'air', items: [ANY], province: '北京市' });
    await clickRow(d, 'ed-m-0001');
    assert.strictEqual(ASKED.length, 1, 'ambient ground was let through in silence');
  });

  await it('an air parcel whose items are unknown still asks, without a blank name', async () => {
    MOUNTED = null; ASKED.length = 0; BOOKED.length = 0; LANG = 'en';
    vm.runInContext('_OPEN_ORDER = null;', sandbox);
    sandbox.createJdLabel(738, 91, 'air', 0, null);
    await clickRow(MOUNTED, 'LL-HD-M');
    assert.strictEqual(ASKED.length, 1, 'no question was put when the order was not loaded');
    assert.ok(/^This parcel is planned for air/.test(ASKED[0].bodyEn), ASKED[0].bodyEn);
    assert.ok(ASKED[0].bodyCn.startsWith('此包裹计划空运'), ASKED[0].bodyCn);
  });

  await it('YES keeps ground, books it, and asks no second question', async () => {
    const d = openDialog({ mode: 'air', items: [ANY], province: '北京市' });
    CONFIRM_ANSWER = true;
    await clickRow(d, 'LL-HD-M');
    assert.strictEqual(checkedNow(d), 'LL-HD-M', 'ground did not stay selected after the operator insisted');
    await createAndShip(d);
    assert.strictEqual(ASKED.length, 1, 'the operator was asked twice for one decision');
    assert.strictEqual(BOOKED[0].product, 'LL-HD-M', `booked ${BOOKED[0].product}, not fresh ground`);
  });

  await it('switching between the two ground rows after YES does not ask again', async () => {
    const d = openDialog({ mode: 'air', items: [ANY], province: '北京市' });
    await clickRow(d, 'LL-HD-M');
    await clickRow(d, 'ed-m-0001');
    assert.strictEqual(ASKED.length, 1, 'a second question for the same decision');
    await createAndShip(d);
    assert.strictEqual(BOOKED[0].product, 'ed-m-0001');
  });

  await it('NO puts air back, and Create & ship then books air', async () => {
    const d = openDialog({ mode: 'air', items: [ANY], province: '北京市' });
    CONFIRM_ANSWER = false;
    await clickRow(d, 'LL-HD-M');
    assert.strictEqual(checkedNow(d), 'LL-SD-M',
      `the row stayed on ${checkedNow(d)} after the operator backed out`);
    assert.strictEqual(BOOKED.length, 0, 'a waybill was booked from the click itself');
    CONFIRM_ANSWER = true;
    await createAndShip(d);
    assert.strictEqual(BOOKED[0].product, 'LL-SD-M', `booked ${BOOKED[0].product} after a declined question`);
  });

  await it('going back to air after YES asks nothing — air is what the plan asked for', async () => {
    const d = openDialog({ mode: 'air', items: [ANY], province: '北京市' });
    await clickRow(d, 'LL-HD-M');
    await clickRow(d, 'LL-SD-M');
    assert.strictEqual(ASKED.length, 1, 'returning to the planned mode asked a question');
  });

  await it('Fujian / Guangxi air parcels: ground is the default there, so ground asks nothing', async () => {
    const d = openDialog({ mode: 'air', items: [ANY], province: '福建省' });
    await clickRow(d, 'LL-SD-M');
    await clickRow(d, 'LL-HD-M');
    assert.strictEqual(ASKED.length, 0, 'the land-default provinces now question their own default');
  });

  await it('a combined AIR parcel holding a land-only item still asks nothing when left on air', async () => {
    // The screenshot's case. Leaving air is the plan's call and is not this
    // dialog's to second-guess; the question is for moving OFF the plan.
    const d = openDialog({ mode: 'air', items: [ANY, NO_AIR], province: '上海市' });
    // But the air row now carries the airline-rejected badge, naming the item,
    // which is the one place the operator can see the plan is wrong.
    assert.ok(/pack-badge land/.test(d.innerHTML), 'the air row on an air parcel carries no Land only badge');
    assert.ok(d.innerHTML.includes('Misfit Medjool Dates'), 'the rejected item is not named on the row');
    await createAndShip(d);
    assert.strictEqual(ASKED.length, 0);
    assert.strictEqual(BOOKED[0].product, 'LL-SD-M');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main();
