#!/usr/bin/env node
/**
 * Settings cards that save themselves — decisions §279, batch 2 onwards.
 *
 *   node scripts/test_settings_card_autosave.js
 *
 * No network, no DB, no browser. autosaveCard is SLICED OUT of the shipped
 * public/retail-admin/01-core.js and driven with the REAL engine
 * (public/tacet-autosave.js) against a stub card, so these assertions move
 * when the real helper does. Then the Delivery page's six cards are checked
 * against the rules the helper exists to keep, and the server's per-card
 * history against its own.
 *
 * What it locks down:
 *   1. NOTHING IS SENT BEFORE start(). A card whose load failed shows empty
 *      boxes; saving on the first keystroke would write them over the real
 *      settings — the §144 race shape.
 *   2. A text box saves on the pause; a number, switch or data-as-commit field
 *      only when it is left (a `change`), so a half-typed number never goes.
 *   3. Every write names its card for the history; Undo and restore say so.
 *   4. The Delivery cards: no Save buttons left, every card started only after
 *      its fields are filled, and a pending edit sent before a refill.
 *   5. The server records exactly the body's keys, before and after, per card.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const is = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const section = (t) => console.log('\n' + t);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const CORE = read('public/retail-admin/01-core.js');
const a = CORE.indexOf('// ── A settings card that saves itself (decisions §279)');
const b = CORE.indexOf('// ── Tenant display currency', a);
if (a === -1 || b === -1) { console.error('Could not slice autosaveCard out of 01-core.js'); process.exit(1); }
const helper = CORE.slice(a, b);

// ── A stub card: a root that remembers its listeners, and fields ─────────
const listeners = {};
const root = { _asWired: false, addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
const fire = (type, target) => (listeners[type] || []).forEach(fn => fn({ target }));
const field = (kind) => ({ matches: (sel) => kind !== 'text' && sel.includes(kind) });
const TEXT = field('text'), NUMBER = field('input[type="number"]');
const SENT = [];
const FORM = { msg: 'Closed for the holiday', on: true, mins: 10 };
const sandbox = {
  console, setTimeout, clearTimeout, queueMicrotask,
  TacetAutosave: require('../public/tacet-autosave.js'),
  cuT: (en) => en, escapeHtml: (s) => String(s), toast: () => {},
  document: { querySelector: () => null },
  api: async (url, opts) => { SENT.push({ url, method: opts && opts.method, body: opts && opts.body }); return { success: true }; },
  autosaveRegister: () => {}, autosavePickVersion: async () => null,
  ROOT_EL: root, FORM,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(helper + `
  var APPLIED = [];
  var CARD = autosaveCard({
    card: 'delivery.holiday', root: ROOT_EL,
    read: () => ({ 'delivery.holidayMode': FORM.on, 'delivery.holidayMessage': { en: FORM.msg }, 'delivery.mins': FORM.mins }),
    apply: (b) => { APPLIED.push(b); FORM.on = b['delivery.holidayMode']; FORM.msg = b['delivery.holidayMessage'].en; FORM.mins = b['delivery.mins']; },
  });`, sandbox);
const run = (src) => vm.runInContext(src, sandbox);

(async () => {
  console.log('settings cards — §279');

  section('1 · nothing is sent before the card has loaded');
  FORM.msg = '';                       // what a failed load leaves in the box
  fire('input', TEXT);
  await wait(900);
  is(SENT.length, 0, 'typing into a card that never loaded sends nothing');
  FORM.msg = 'Closed for the holiday';
  run('CARD.start()');

  section('2 · text on the pause, numbers when left');
  FORM.msg = 'Closed until the 8th';
  fire('input', TEXT);
  await wait(900);
  is(SENT.length, 1, 'a text edit is one write after the pause');
  is(SENT[0] && SENT[0].url, '/api/retail-admin/config?history=delivery.holiday', 'to the settings, naming its card');
  is(SENT[0] && SENT[0].method, 'PUT', 'a PUT');
  is(SENT[0] && SENT[0].body, { 'delivery.holidayMode': true, 'delivery.holidayMessage': { en: 'Closed until the 8th' }, 'delivery.mins': 10 },
    'carrying every key the card owns, in its fixed order');
  SENT.length = 0;
  FORM.mins = 1;
  fire('input', NUMBER);
  await wait(900);
  is(SENT.length, 0, 'a number being typed is not sent');
  FORM.mins = 15;
  fire('change', NUMBER);
  await wait(900);
  is(SENT.length, 1, 'it goes once the box is left');
  is(SENT[0] && SENT[0].body['delivery.mins'], 15, 'with the number as finished');

  section('3 · Undo and restore say what they are');
  SENT.length = 0;
  run('CARD.undo()');
  await wait(50);
  is(SENT.length, 1, 'Undo is one write');
  is(SENT[0] && SENT[0].url, '/api/retail-admin/config?history=delivery.holiday&note=undo', 'filed as an undo');
  is(SENT[0] && SENT[0].body['delivery.holidayMessage'], { en: 'Closed for the holiday' }, 'with the card as it was when loaded');
  is(FORM.msg, 'Closed for the holiday', 'and the fields are put back too');

  section('3b · an edit the page writes into its state AFTER the event is still sent');
  // The social-proof rows write their edit on document, further up the bubble
  // than the card's root: the card must read the page after that, not before.
  SENT.length = 0;
  fire('input', TEXT);
  FORM.msg = 'Written by a handler further up';
  await wait(900);
  is(SENT.length, 1, 'one write');
  is(SENT[0] && SENT[0].body['delivery.holidayMessage'], { en: 'Written by a handler further up' }, 'carrying what the later handler wrote');

  section('4 · the Delivery page');
  const HTML = read('public/retail-admin.html');
  const DLV = read('public/retail-admin/06-delivery.js');
  for (const fn of ['saveDeliveryDefaults()', 'saveCutoffSettings()', 'saveBulkTrackingSetting()', 'saveBoxLabelSetting()', 'savePreorderNotice()']) {
    yes(!HTML.includes('onclick="' + fn + '"'), 'no Save button calls ' + fn);
  }
  yes(!/onclick="saveHolidayMode\(\)"/.test(HTML), 'nor the holiday card’s');
  for (const c of ['delivery.kitchen', 'delivery.holiday', 'delivery.cutoff', 'delivery.preorder', 'delivery.bulktracking', 'delivery.boxlabel']) {
    yes(HTML.includes('data-as-foot="' + c + '"'), 'the ' + c + ' card wears the foot');
    yes(DLV.includes("card: '" + c + "'"), 'and is an autosaving card');
  }
  yes(/id="dlv-kitchen-address" data-as-commit/.test(HTML), 'the kitchen address saves when it is left, not mid-word');
  const load = DLV.slice(DLV.indexOf('async function loadDeliveryZones() {'));
  const loadFn = load.slice(0, load.indexOf('\n}\n'));
  const iFlush = loadFn.indexOf('.flush()'), iFetch = loadFn.indexOf("api('/api/retail-admin/config')");
  const iFill = loadFn.indexOf("$('#dlv-holiday-mode').checked = hMode"), iStart = loadFn.indexOf('c.start()');
  yes(iFlush !== -1 && iFlush < iFetch, 'a pending edit is sent before the fields are refilled');
  yes(iStart > iFill, 'the cards start only after their fields are filled');
  yes(loadFn.lastIndexOf('c.start()') < loadFn.indexOf('} catch {}'), 'and only inside the try — a failed load never starts them');

  section('4b · the shop wording pages (batch 3)');
  const MKT = read('public/retail-admin/05-marketing.js');
  const CONTENT = read('public/retail-admin/07-content-billing.js');
  const EXTRAS = read('public/retail-admin/10-extras.js');
  const ALLJS = MKT + CONTENT + EXTRAS;
  const PAGES = [
    // card, file, the loader that must start it, the line in that loader it must follow
    ['copy.snippets', MKT, 'async function loadSnippets', 'snippetsRender();', 'SNIP_CARD.start()'],
    ['reviews.tags', CONTENT, 'async function loadReviewTags', 'renderReviewTagsTable();', 'RTAGS_CARD.start()'],
    ['faq', CONTENT, 'async function loadFaq', 'renderFaqQs();', 'FAQ_CARD.start()'],
    ['about', EXTRAS, 'async function loadAbout', 'ABOUT_READY = true;', 'ABOUT_CARD.start()'],
    ['leaderboard', EXTRAS, 'async function lbLoad', 'lbApplyConfigToForm(body.data);', 'LB_CARD.start()'],
    ['voting', EXTRAS, 'async function votLoad', 'votRenderAll();', 'VOT_CARD.start()'],
    ['legal', MKT, 'async function loadConfig', 'applyFeePreviews();', 'CFG_CARDS().forEach(k => k.start())'],
    ['checkout.upsell', MKT, 'async function loadConfig', 'applyFeePreviews();', 'CFG_CARDS().forEach(k => k.start())'],
    ['social_proof', MKT, 'async function loadConfig', 'applyFeePreviews();', 'CFG_CARDS().forEach(k => k.start())'],
  ];
  for (const [card, src, loader, fill, start] of PAGES) {
    yes(HTML.includes('data-as-foot="' + card + '"'), card + ': the page wears the foot');
    yes(src.includes("card: '" + card + "'"), card + ': and is an autosaving card');
    const body = src.slice(src.indexOf(loader), src.indexOf('\n}\n', src.indexOf(loader)));
    const iFill = body.indexOf(fill), iStart = body.indexOf(start), iCatch = body.lastIndexOf('} catch');   // the loader's own catch, not a nested one
    yes(iFill !== -1 && iStart > iFill && (iCatch === -1 || iStart < iCatch), card + ': it starts only after its fields are filled, never from the catch');
  }
  for (const gone of ['saveSnippets', 'saveReviewTags', 'saveFaq', 'saveLegal', 'saveAbout', 'saveCheckoutUpsell',
    'saveSocialProof', 'saveLeaderboardConfig', 'votSaveConfig', 'scSave']) {
    yes(!new RegExp('function ' + gone + '\\(').test(ALLJS) && !HTML.includes(gone + '('), gone + ' and its button are gone');
  }
  yes(/const VOT_CARD[\s\S]*?if \(cfgRes && cfgRes\.data\) VOT_CARD\.start\(\)/.test(EXTRAS) || /if \(cfgRes && cfgRes\.data\) VOT_CARD\.start\(\)/.test(EXTRAS),
    'voting starts only when its settings actually arrived (that read may fail quietly)');
  yes(/\['home', 'product', 'voting'\]\.forEach\(k => SC_CARDS\[k\]\.start\(\)\)/.test(EXTRAS) && /SC_CARDS\.invite\.start\(\)/.test(EXTRAS),
    'each share card starts only when its own source loaded');
  yes(/data-as-commit value="\$\{escapeAttr\(t\.id\)\}"/.test(CONTENT), 'a review tag’s id saves when it is left, not mid-word');
  yes((CONTENT.match(/data-as-commit value="\$\{escapeAttr\((c|q)\.id\)\}"/g) || []).length === 2, 'and so do the FAQ category and question ids');

  section('4c · records you edit (batch 4)');
  const OPS = read('public/retail-admin/02-settings-ops.js');
  const PUR = read('public/retail-admin/16-purchasing.js');
  const INV = read('routes/retail-inventory.js');
  const RETAIL_SRC = read('routes/retail.js');
  const PURR = read('routes/retail-purchasing.js');
  // Each editor saves itself only for a record that EXISTS; a new one keeps Save.
  yes(/isEdit\s*\?\s*`<div data-as-foot="store\.\$\{s\.id\}"/.test(OPS) && /_opsStoreSave\(null\)/.test(OPS),
    'store: an existing store saves itself, a new one keeps Save (it creates the store)');
  yes(/data-as-commit value="\$\{val\(s\?\.address\)\}"/.test(OPS) && /id="osf_city" data-as-commit/.test(OPS) && /id="osf_district" data-as-commit/.test(OPS),
    'store: the address fields save when left — each save of them can re-locate the store');
  yes(/_opsStorePin\(/.test(OPS) && !/lat:/.test(OPS.slice(OPS.indexOf('function _opsStoreBody'), OPS.indexOf('function _opsStoreApply'))),
    'store: the manual GPS pin is its own Save, and never rides the autosave');
  yes(/const typing = document\.activeElement && document\.activeElement\.id === 'ops-store-q'/.test(OPS) && (OPS.match(/if \(typing\) _opsRestoreFocus\(\)/g) || []).length === 2,
    'store: repainting the list no longer pulls the caret out of the form');
  yes(/String\(req\.body\[k\] \?\? ''\) !== String\(existing\[k\] \?\? ''\)/.test(INV),
    'store route: the address is re-located only when it CHANGED (or the store has no coordinates) — not on every save that carries it');
  yes(/data-as-foot="supplier\.\$\{s\.id\}"/.test(PUR) && /onclick="puSupSave\(\)"/.test(PUR),
    'supplier: an existing supplier saves itself, a new one keeps Save');
  yes(/hold: \(b\) => \(b\.name \? '' : T\('Name is required', '名称必填'\)\)/.test(PUR), 'supplier: a blank name holds the save');
  yes(/if \(_supCard\) \{ _supCard\.flush\(\); _supCard = null; \}/.test(PUR), 'supplier: a repaint sends the open form first');
  yes(/if \(_supCard\) _supCard\.touch\(\);/.test(PUR), 'supplier: a pick from the payment suggestions counts as an edit');
  const ML = CONTENT.slice(CONTENT.indexOf('function openMediaDrawer'), CONTENT.indexOf('async function deleteMediaFromDrawer'));
  yes(ML.indexOf('ML_CARD.flush()') < ML.indexOf('_mlEditId = id;') && ML.indexOf('ML_CARD.start()') > ML.indexOf("$('#ml-edit-tag-input').value = '';"),
    'photo: the previous photo is sent before the drawer refills, and the card starts after it is filled');
  yes(/url: \(\) => '\/api\/retail-admin\/media\/' \+ _mlEditId/.test(CONTENT), 'photo: every send names the photo open at that moment');
  const PU = MKT.slice(MKT.indexOf('function openPopupEditor'), MKT.indexOf('function closePopupEditor'));
  yes(PU.indexOf('PU_CARD.flush()') !== -1 && PU.indexOf('PU_CARD.flush()') < PU.indexOf("_popups.find(x => x.id === id)"),
    'pop-up: the one open before is sent before the drawer refills');
  yes(/if \(id\) PU_CARD\.start\(\);/.test(PU), 'pop-up: only an existing pop-up saves itself');
  yes(/updated_at: _puOpenStamp/.test(MKT) && /beforeSend: \(b\) => \{/.test(MKT),
    'pop-up: the timestamp is stamped on what is SENT, never on what is compared (or every read is an edit)');
  const DEL = MKT.slice(MKT.indexOf('async function deletePopup'), MKT.indexOf('async function savePopupsArray'));
  yes(DEL.indexOf('PU_CARD.stop()') !== -1 && DEL.indexOf('PU_CARD.stop()') < DEL.indexOf('_popups = _popups.filter'),
    'pop-up: a delete stops the card before the list loses it — a late pause cannot write it back');
  yes(/fromSnapshot: \(snap\) => \{[\s\S]*?_popups\.map\(p => \(p\.id === id && old \? old : p\)\)/.test(MKT),
    'pop-up: restoring a version takes only THIS pop-up from it; the others stay as they are');
  yes(/router\.get\('\/api\/retail-admin\/stores\/:id\/history'/.test(INV) && /router\.get\('\/api\/retail-admin\/suppliers\/:id\/history'/.test(PURR)
    && /router\.get\('\/api\/retail-admin\/media\/:id\/history'/.test(RETAIL_SRC), 'the three records read their history back');
  for (const [src, type] of [[INV, 'store'], [PURR, 'supplier'], [RETAIL_SRC, 'media']]) {
    yes(new RegExp("editHistory\\.around\\(tdb\\(\\), [^,]+, '" + type + "'").test(src) && /editHistory\.fromQuery\(req\.query\)/.test(src),
      type + ' route: recorded around its write, only when the editor asks (?history)');
  }

  section('4d · mixed screens split (batch 5)');
  {
    const MK = read('public/retail-admin/05-marketing.js');
    const DV = read('public/retail-admin/06-delivery.js');
    const CORE2 = read('public/retail-admin/01-core.js');
    const H = read('public/retail-admin.html');
    const sc = MK.slice(MK.indexOf('async function saveConfig() {'), MK.indexOf('// §279 — Shop layout & filters, and Customer service, save themselves.'));
    yes(!/'shop\./.test(sc) && !/'customer_service\./.test(sc), 'the shared Save no longer sends the shop or customer-service keys');
    yes(/'notifications\.order_status_template_id'/.test(sc) && /saveAlipayManualInline/.test(sc) && /'system_alerts\.wecom_webhook'/.test(sc),
      'it keeps the template id, the webhooks and the manual-Alipay card — keys and money');
    yes(/_saveBar\.style\.display = sub === 'push' \? '' : 'none'/.test(CORE2) && /<div class="save-bar" style="display: none;">/.test(H),
      'the bar shows on Notifications only, and starts hidden (Shop is the panel open on arrival)');
    for (const c of ['shop.display', 'customer_service', 'pickup']) {
      yes(H.includes('data-as-foot="' + c + '"') && MK.includes("card: '" + c + "'"), c + ' saves itself');
    }
    yes(/function CFG_CARDS\(\) \{ return \[LEGAL_CARD, UPSELL_CARD, SOCIAL_CARD, SHOP_CARD, CS_CARD, PICKUP_CARD\]; \}/.test(MK),
      'and all three start only when loadConfig has filled them');
    const df = DV.slice(DV.indexOf('async function saveDeliveryFees() {'), DV.indexOf('\n}\n', DV.indexOf('async function saveDeliveryFees() {')));
    yes(!/pickup\.window|pickup\.leadMinutes/.test(df) && /fees\.pickupPackingFee/.test(df), 'the fees Save sends money only — the pickup hours left it');
    yes(/CS_CARD\.touch\(\)/.test(MK), 'a customer-service QR upload or clear counts as an edit');
  }

  section('5 · the server keeps each card’s history');
  const RETAIL = read('routes/retail.js');
  const put = RETAIL.slice(RETAIL.indexOf("router.put('/api/retail-admin/config'"));
  const putFn = put.slice(0, put.indexOf('\n});'));
  const iB = putFn.indexOf("editHistory.before(tdb(), historyTenantId(), 'config', histCard"),
    iW = putFn.indexOf('INSERT INTO storefront_config'), iA = putFn.indexOf("editHistory.after(tdb(), historyTenantId(), 'config', histCard");
  yes(iB !== -1 && iB < iW && iA > iW, 'the card’s keys are recorded before and after the write');
  yes(/configSnapshot\(entries\.map\(e => e\[0\]\)\)/.test(putFn), 'exactly the keys in the body');
  yes(/\^\[a-z0-9\._-\]\{1,60\}\$\/i\.test\(String\(q\.history/.test(putFn), 'a card name is checked before it is used');
  yes(/CONFIG_HISTORY_NOTES\.has\(q\.note\)/.test(putFn), 'and only a known note is filed');
  yes(/router\.get\('\/api\/retail-admin\/config\/history', requireRetailAdmin/.test(RETAIL), 'the history reads back per card, behind the admin gate');
  for (const [route, key] of [["router.put('/api/retail-admin/leaderboard/config'", "['leaderboard.config']"],
    ["router.put('/api/retail-admin/voting/config'", "['voting.config']"],
    ["router.patch('/api/retail-admin/affiliate/settings'", 'writes.map(w => w[0])']]) {
    const r = RETAIL.slice(RETAIL.indexOf(route)); const fn = r.slice(0, r.indexOf('\n});'));
    yes(fn.includes('withConfigHistory(req, ' + key), route.split("'")[1] + ' records its card around its own write');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
