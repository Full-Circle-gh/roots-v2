#!/usr/bin/env node
/**
 * The phone's Waste ledger and its one write, asserted against
 * routes/retail-waste.js and public/retail-admin/20-waste.js.
 *
 *   node scripts/test_mobile_waste.js
 *
 * What it was: NOTHING. The string `waste` appeared zero times in public/m.html
 * while lib/capabilities.js handed waste:view and waste:record to the warehouse
 * and store_manager presets by default — so the permission an owner granted a
 * warehouse operator changed nothing they could see on a phone, and the loss
 * that happens on a shelf was only recordable at a desk. Option A of
 * docs/tacet-waste-mobile-options.md.
 *
 * The assertions below are the rules the API already settled, checked on the
 * surface that could most easily forget them:
 *
 *   • ZERO AND UNKNOWN MUST NOT LOOK ALIKE. An uncosted entry prints "No cost".
 *     A ¥0.00 there says the jar was free, which is a different fact.
 *   • CENTS ARE DIVIDED EXACTLY ONCE. 9600 is ¥96, not ¥9,600 and not ¥0.96.
 *     A second /100 somewhere is how one screen ends up a hundred times wrong.
 *   • THE UNCOSTED COUNT TRAVELS WITH THE TOTAL. A total shown alone reads as
 *     complete, and the whole point of the flag is that sometimes it is not.
 *   • A VOIDED ENTRY AND ITS REVERSAL STAY VISIBLE. A ledger that hides its own
 *     corrections is how one goes unnoticed.
 *   • EMPTY AND NO-RESULTS ARE TWO STATES AND TWO SENTENCES, and a load that
 *     FAILED is a third — it must never fall through to "nothing was wasted".
 *   • THE WRITE IS REFUSED BEFORE IT IS SENT for what sending it cannot fix:
 *     no reason picked, or `other` with no note — each names itself. Going
 *     over on-hand is NOT refused: the shelf count being wrong is why the
 *     record is being made, so it goes through and leaves the count visibly
 *     wrong rather than blocking the person who can see the shelf
 *     (docs/tacet-consolidation-decisions.md — negative stock is a signal).
 *   • waste:record GATES THE BUTTON, NOT THE SCREEN. A ledger reads fine
 *     without the write, so a view-only operator gets the title and an empty
 *     Dusk slot rather than a button that 403s.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const CAPS_FULL = `state.caps=['waste:view','waste:costs','waste:record'];`;
const CAPS_NOCOST = `state.caps=['waste:view','waste:record'];`;
const STORES = `state.stores=[{id:1,name_en:'Tianhe store',name_cn:'天河店'},{id:2,name_en:'Panyu store',name_cn:'番禺店'}];`;
const REASONS = `state.wst.reasons=[{code:'spoiled',en:'Spoiled',cn:'变质'},{code:'expired',en:'Expired',cn:'过期'},{code:'other',en:'Other',cn:'其他'}];`;

// Six rows and the totals that go with them: two costed, one uncosted, one
// voided loss and the reversal that cancelled it. The totals are the server's
// LIVE subset — the voided pair is excluded from the money and counted beside
// it, which is the arithmetic the route performs and the screen must not redo.
const LEDGER = `state.wst.tried=true; state.wst.loading=false;
  state.wst.totals={cost_total_cents:25600,qty_total:16,entries:6,uncosted_entries:1,voided_entries:1};
  state.wst.rows=[
    {id:6,qty:4,reason_code:'spoiled',business_date:'2026-09-02',cost_total_cents:9600,is_uncosted:0,product_name_en:'Oat milk 1L',product_name_cn:'燕麦奶',location_name_en:'Tianhe',location_name_cn:'天河店',note:'Left out of the chiller'},
    {id:5,qty:2,reason_code:'expired',business_date:'2026-09-02',cost_total_cents:3400,is_uncosted:0,product_name_en:'Sourdough loaf',product_name_cn:'酸种面包',location_name_en:'Tianhe',location_name_cn:'天河店'},
    {id:4,qty:1,reason_code:'other',business_date:'2026-09-01',cost_total_cents:null,is_uncosted:1,product_name_en:'Mixed nuts 250g',product_name_cn:'混合坚果',location_name_en:'Panyu',location_name_cn:'番禺店'},
    {id:2,qty:3,reason_code:'spoiled',business_date:'2026-08-31',cost_total_cents:4200,is_uncosted:0,voided_by_waste_id:7,product_name_en:'Organic carrots',product_name_cn:'有机胡萝卜',location_name_en:'Panyu',location_name_cn:'番禺店'},
    {id:7,qty:3,reason_code:'spoiled',business_date:'2026-08-31',cost_total_cents:4200,is_uncosted:0,reverses_waste_id:2,product_name_en:'Organic carrots',product_name_cn:'有机胡萝卜',location_name_en:'Panyu',location_name_cn:'番禺店'}];`;

const OPEN = `${CAPS_FULL}${STORES}${REASONS}${LEDGER}APP.cmd('push','waste');`;
// The sheet, filled in far enough to commit: one store, one product with 18 on
// the shelf, four of them going, a reason, and the cost the preview returned.
const FORM = `${OPEN}APP.cmd('wasteNew');
  state.wst.storeId=1; state.wst.picks=[];
  state.wst.pick={id:9,name_en:'Oat milk 1L',name_cn:'燕麦奶',sku:'10188',on_hand:18};
  state.wst.qty=4; state.wst.code='spoiled';
  state.wst.preview={cost_total_cents:9600,is_uncosted:0}; render();`;

const CASES = [
  ['the ledger', OPEN, [
    ['what was lost',            `txt('content').includes('Oat milk 1L')`],
    ['how many, why and where',  `txt('content').includes('4 × · Spoiled · Tianhe')`],
    ['what it cost',             `txt('content').includes('¥96')`],
    // 9600 cents is ¥96. The two ways to get this wrong both print a number
    // that looks plausible on its own, which is why both are named.
    ['divided once, not never',  `!txt('content').includes('¥9,600')`],
    ['divided once, not twice',  `!txt('content').includes('¥0.96')`],
    ['the note the operator left', `txt('content').includes('Left out of the chiller')`],
    ['and when',                 `txt('content').includes('Today')`],
  ]],
  ['a loss nobody could price', OPEN, [
    ['says so in words',         `txt('content').includes('No cost')`],
    ['never as free',            `!txt('content').includes('¥0.00')`],
    ['and the count rides with the total', `txt('content').includes('1 with no cost')`],
  ]],
  ['the pulse', OPEN, [
    ['the money',                `txt('content').includes('¥256 written off')`],
    ['and the corrections it excludes', `txt('content').includes('1 voided')`],
  ]],
  ['a correction stays on the record', OPEN, [
    ['the loss is marked voided', `txt('content').includes('Voided')`],
    ['and its reversal is named for what it is', `txt('content').includes('Reversal')`],
  ]],
  // Void is waste:void — an owner capability neither warehouse nor
  // store_manager holds. It is not on this surface at all, so the rows above
  // must not offer it.
  ['voiding is not offered here', OPEN, [
    ['no void control', `!txt('content').includes('Void this')`],
  ]],
  ['nothing wasted', `${STORES}state.wst.tried=true;state.wst.rows=[];state.wst.totals=null;APP.cmd('push','waste');`, [
    ['a compliment, not an apology', `txt('content').includes('Nothing wasted yet')`],
    ['and not a filter message',     `!txt('content').includes('Nothing matches')`],
  ]],
  ['filtered to nothing', `${STORES}${REASONS}state.wst.tried=true;state.wst.rows=[];state.wst.reason='expired';APP.cmd('push','waste');`, [
    ['names the state',        `txt('content').includes('Nothing matches those filters')`],
    ['offers the way out',     `txt('content').includes('Clear the filters')`],
    ['and never reads as good news', `!txt('content').includes('Nothing wasted yet')`],
  ]],
  // The rows and the pulse are the server's answer to ONE filter. Left on
  // screen while the next filter loads, they are a set that contradicts the
  // chips above it — and the pulse, being arithmetic, looks authoritative
  // while doing it.
  ['changing a filter drops what no longer matches it', `${OPEN}APP.cmd('wstReason','expired');`, [
    ['the old rows are gone',   `!txt('content').includes('Oat milk 1L')`],
    ['the old total with them', `!txt('content').includes('¥256 written off')`],
    ['it says it is loading',   `txt('content').includes('Loading')`],
    ['and the chips stay put',  `txt('content').includes('7 days')`],
  ]],
  ['it would not load', `${STORES}state.wst.tried=true;state.wst.err='Could not load waste records.';APP.cmd('push','waste');`, [
    ['says so',                `txt('content').includes('Could not load waste records')`],
    ['not "nothing was wasted"', `!txt('content').includes('Nothing wasted yet')`],
    ['and the range switch survives', `txt('content').includes('7 days')`],
  ]],
  ['the record sheet', FORM, [
    ['on-hand is shown while choosing, not at the refusal', `sheetText().includes('18 on hand')`],
    ['the cost before the commit', `sheetText().includes('Cost ¥96')`],
    ['and what the shelf drops to', `sheetText().includes('stock drops to 14')`],
    ['the button is live',         `!/disabled/.test(document.querySelector('.sheet .cta').outerHTML)`],
  ]],
  // Every refusal below is the API's, said first by the screen. wstBlocked()
  // is the single place that decides, and it always returns a sentence.
  ['more than is on the shelf — allowed, not refused', `${FORM}state.wst.qty=99;render();`, [
    ['no "only N on hand" refusal', `!sheetText().includes('on hand.')`],
    ['the button stays live',       `!/disabled/.test(document.querySelector('.sheet .cta').outerHTML)`],
    ['and the shelf figure goes negative, as the signal it is', `sheetText().includes('stock drops to -81')`],
  ]],
  ['no reason picked', `${FORM}state.wst.code='';render();`, [
    ['asks for one',   `sheetText().includes('Pick a reason')`],
    ['button dead',    `/disabled/.test(document.querySelector('.sheet .cta').outerHTML)`],
  ]],
  ['"other" with nothing said', `${FORM}state.wst.code='other';state.wst.note='';render();`, [
    ['asks what happened', `sheetText().includes('Tell us what happened')`],
    ['button dead',        `/disabled/.test(document.querySelector('.sheet .cta').outerHTML)`],
    ['and the note stops calling itself optional', `!sheetText().includes('Note · optional')`],
  ]],
  // A sheet that reopens carrying the last entry's product is how the second
  // jar of the morning gets logged against the first one's SKU.
  ['reopening starts clean', `${FORM}APP.cmd('wstClose');APP.cmd('wasteNew');`, [
    ['no product carried over', `state.wst.pick===null`],
    ['quantity back to one',    `state.wst.qty===1`],
    ['the note is gone',        `state.wst.note===''`],
    ['no reason pre-picked',    `state.wst.code===''`],
    ['but the shelf is remembered', `state.wst.storeId===1`],
  ]],
  ['a different shelf drops the product chosen on the last one', `${FORM}APP.cmd('wstPickStore',2);`, [
    ['product cleared', `state.wst.pick===null`],
    ['and its cost with it', `state.wst.preview===null`],
  ]],
  // waste:view is a real grant on its own — an owner reading what the shop lost
  // holds it without waste:record — so the SCREEN is view and the BUTTON is
  // record. §1.7: the empty slot is the finished answer.
  // Built from the parts rather than from OPEN, which seeds a full cap set of
  // its own — layering `state.caps=` in front of it would just be overwritten.
  ['view-only sees the ledger and no button',
   `state.caps=['waste:view'];${STORES}${REASONS}${LEDGER}APP.cmd('push','waste');`, [
    ['the rows are there',   `txt('content').includes('Oat milk 1L')`],
    ['and no way to write',  `txt('content').indexOf('Record')===-1`],
  ]],
  ['a recorder gets the button',
   `state.caps=['waste:view','waste:record'];${STORES}${REASONS}${LEDGER}APP.cmd('push','waste');`, [
    ['offered', `txt('content').includes('Record')`],
  ]],
  ['and an operator without waste never sees the row', `state.caps=['purchasing:view'];APP.cmd('tab','more');`, [
    ['not in More',      `txt('content').indexOf('Waste')===-1`],
    ['nor reachable by naming it', `(APP.cmd('push','waste'), !state.stack.length)`],
  ]],
  // ── The money gate ─────────────────────────────────────────────────────
  // `waste:view` opens the ledger; `waste:costs` reads the money in it. They
  // were ONE capability marked money:'shows', which is how the cost of every
  // loss in the business reached a warehouse phone. Five surfaces carry a
  // figure and all five are checked — a gate applied to four is not a gate.
  //
  // Decided per person by whoever manages the team, so the fixture is a
  // capability array and not a role name: a role list in the client was the
  // shape this replaced.
  ['a recorder without waste:costs sees the losses and none of the money',
   `${CAPS_NOCOST}${STORES}${REASONS}${LEDGER}APP.cmd('push','waste');`, [
    ['the rows are still there',   `txt('content').includes('Oat milk 1L')`],
    ['and still say what and why', `txt('content').includes('4 × · Spoiled · Tianhe')`],
    ['no cost on any row',         `!txt('content').includes('¥96')`],
    ['no total',                   `!txt('content').includes('written off')`],
    ['not even the currency mark', `txt('content').indexOf('¥')===-1`],
    // "No cost" is a statement about this product's costing — the same ledger
    // they may not read — so it is withheld with the figures, not left behind.
    ['nor the uncosted flag',      `!txt('content').includes('No cost')`],
    // An empty pulse would read as a summary that failed to load.
    ['the pulse still counts the work', `txt('content').includes('entries')`],
    ['and still names corrections',     `txt('content').includes('voided')`],
  ]],
  // The gate fails CLOSED, which is the opposite of mCan() everywhere else in
  // this file. A null cap set means "we could not resolve this operator", and
  // for navigation that resolves to allow; for money it must not.
  ['unresolved caps show no money at all',
   `state.caps=null;${STORES}${REASONS}${LEDGER}APP.cmd('push','waste');`, [
    ['the ledger still paints', `txt('content').includes('Oat milk 1L')`],
    ['and no figure with it',   `txt('content').indexOf('¥')===-1`],
  ]],
  ['the record sheet shows the shelf, not the cost',
   `${FORM}state.caps=['waste:view','waste:record'];render();`, [
    ['no cost preview',        `!sheetText().includes('Cost')`],
    ['no figure at all',       `sheetText().indexOf('¥')===-1`],
    // The half that IS theirs: what the shelf reads afterwards.
    ['what the shelf will say', `sheetText().includes('Stock drops to')`],
    ['and it can still be recorded', `!/disabled/.test(document.querySelector('.sheet .cta').outerHTML)`],
  ]],
  ['holding waste:costs, every figure is back', OPEN, [
    ['the total',         `txt('content').includes('¥256 written off')`],
    ['the rows',          `txt('content').includes('¥96')`],
    ['the uncosted flag', `txt('content').includes('No cost')`],
  ]],
  // The server strips the cost fields for a caller without the capability, so
  // a client that believed it could show them would render money(undefined) —
  // ¥0, which reads as "the jar was free" rather than "withheld".
  ['a stripped payload never prints as zero',
   `${CAPS_FULL}${STORES}${REASONS}state.wst.tried=true;
    state.wst.totals={entries:2,voided_entries:0};
    state.wst.rows=[{id:1,qty:1,reason_code:'spoiled',business_date:'2026-09-02',product_name_en:'Oat milk 1L',location_name_en:'Tianhe'}];
    APP.cmd('push','waste');`, [
    ['the row still reads',  `txt('content').includes('Oat milk 1L')`],
    ['no phantom zero',      `!txt('content').includes('¥0')`],
    ['and no phantom total', `!txt('content').includes('written off')`],
  ]],
  // render() rebuilds the app with innerHTML, so .sheet is a NEW node on every
  // tap and replays `animation:tSheetUp .4s` — the form slid up from the
  // bottom of the screen on every chip press. The guard is the flag; the
  // assertion is that a repaint after the open carries animation:none.
  ['the sheet enters once and then holds still', FORM, [
    ['armed after the first paint', `state.wst.mounted===true`],
    ['the sheet does not re-enter',  `/animation:\\s*none/.test(document.querySelector('.sheet').outerHTML)`],
    ['nor does the scrim',           `/animation:\\s*none/.test(document.querySelector('.scrim').outerHTML)`],
  ]],
  ['opening it fresh does animate', `${OPEN}APP.cmd('wasteNew');state.wst.mounted=false;render();`, [
    ['no suppression on the way in', `!/animation:\\s*none/.test(document.querySelector('.sheet').outerHTML)`],
  ]],
  // The form is taller than the sheet once a product is picked, so the reason
  // chips and the note sit below the fold. Without a named scroller, reaching
  // them and tapping one threw the sheet back to the top.
  ['the sheet body is named so its scroll survives a repaint', FORM, [
    ['it has an id',        `!!document.getElementById('mWstBody')`],
    ['and it is a scroller', `getComputedStyle(document.getElementById('mWstBody')).overflowY==='auto'`],
  ]],
  ['in Chinese', `LANG='zh';${OPEN}`, [
    ['the ledger',   `txt('content').includes('损耗')||txt('content').includes('燕麦奶')`],
    ['the reason',   `txt('content').includes('变质')`],
    ['and no English left in the pulse', `!txt('content').includes('written off')`],
  ]],
];

run('mobile waste', CASES);
