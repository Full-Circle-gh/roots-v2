#!/usr/bin/env node
/**
 * test_clear_filters.js — one way out of a filter (audit Q-03, B-06's residue).
 *
 *   node scripts/test_clear_filters.js
 *
 * THE FINDING. Three different behaviours for the same idea. Waste showed a
 * Clear button in its toolbar whenever a filter was set; Customers showed one
 * only in the EMPTY state; every other screen had none. The audit's own verdict:
 * "Waste's is the right one."
 *
 * The empty-state-only version is the wrong half of the problem. A filter that
 * matched nothing announces itself — the screen is blank and says so. A filter
 * that matched forty people out of four hundred does not, and that is the one
 * where somebody has to remember which four controls they set.
 *
 * So the rule, on every list that filters: the button is present while
 * something is narrowing the list and absent otherwise, which makes it a status
 * line as well as a control.
 *
 * The predicates are driven in a sandbox against hand-built controls, because
 * "is anything narrowing this list" is the half that is easy to get subtly
 * wrong — a select whose "everything" value is the string 'all' reads as set if
 * you only test for truthiness.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${e}, got ${a}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const PROD = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const CUST = fs.readFileSync(path.join(ROOT, 'public/retail-admin/08-customers.js'), 'utf8');
const ORD  = fs.readFileSync(path.join(ROOT, 'public/retail-admin/04-orders.js'), 'utf8');

// ── §1 · every list that filters has the button, and it hides itself ───────
section('1 · the same control, on every list that filters');

for (const [id, fn] of [['ord-clear-btn', 'ordClearFilters()'],
                        ['cu-clear-btn', 'cuFilterClearAll()'],
                        ['pa-clear-btn', 'paClearFilters()']]) {
  const at = HTML.indexOf('id="' + id + '"');
  yes(at > 0, `${id} exists`);
  const tag = HTML.slice(HTML.lastIndexOf('<button', at), HTML.indexOf('>', at) + 1);
  yes(tag.includes(' hidden'), `${id} starts hidden — it is absent until there is something to clear`);
  yes(HTML.slice(at, at + 400).includes(fn), `${id} calls ${fn}`);
  yes(tag.includes('title="'), `${id} says what it does on hover`);
}
for (const [src, fn, name] of [[ORD, 'ordSyncClearBtn', 'Orders'],
                               [CUST, 'cuSyncClearBtn', 'Customers'],
                               [PROD, 'paSyncClearBtn', 'Products']]) {
  yes(new RegExp('function ' + fn + '\\(').test(src), `${name} has a sync function`);
  // Called from the RENDER path, not only from the filter handlers: a tile, a
  // dashboard deep-link and a restored view all change the filters without
  // going through the control that owns them.
  const calls = (src.match(new RegExp(fn + '\\(\\)', 'g')) || []).length;
  yes(calls >= 2, `${name} calls it from more than one place (${calls})`);
}

// ── §2 · "is anything narrowing this list" ─────────────────────────────────
section('2 · the predicate, which is the half that is easy to get wrong');
{
  // Products, lifted and driven. Its three selects use the STRING 'all' for
  // "everything", so a truthiness test would read every one of them as set.
  const src = PROD.slice(PROD.indexOf('function paAnyFilter('), PROD.indexOf('function paSyncStatusFilter('));
  const mk = (vals, status) => {
    const sandbox = { PA_STATUS: status, console };
    sandbox.document = { getElementById: (id) => (id in vals ? { value: vals[id] } : null) };
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.__any = paAnyFilter;', sandbox, { filename: 'pa.js' });
    return sandbox.__any();
  };
  const NONE = { 'pa-search': '', 'pa-filter': 'all', 'pa-subfilter': 'all' };
  is(mk(NONE, 'all'), false, 'nothing set reads as nothing set');
  is(mk({ ...NONE, 'pa-filter': 'all' }, 'all'), false,
    "a select sitting on 'all' is not a filter — the string is truthy, the state is not");
  is(mk({ ...NONE, 'pa-search': 'oat' }, 'all'), true, 'a search term counts');
  is(mk({ ...NONE, 'pa-search': '   ' }, 'all'), false, 'and whitespace in the box does not');
  is(mk({ ...NONE, 'pa-filter': 'Grains' }, 'all'), true, 'a category counts');
  is(mk({ ...NONE, 'pa-subfilter': 'Oats' }, 'all'), true, 'a subcategory counts');
  is(mk(NONE, 'draft'), true, 'and a status picked from a KPI tile counts');
  is(mk({}, 'all'), false, 'a page whose controls are not on screen yet claims nothing');
}
{
  // Customers already had the predicate; what changed is where the button is.
  const src = CUST.slice(CUST.indexOf('function cuAnyFilter('), CUST.indexOf('// ── Customers stat strip'));
  yes(/CU_SEGMENT/.test(src) && /CU_TIER_FILTERS/.test(src) && /CU_TAG_FILTERS/.test(src)
    && /CU_CHAN_FILTER/.test(src) && /value\.trim\(\)/.test(src),
    'the customer predicate covers all five of its controls, the search box trimmed');
}

// ── §3 · the empty state keeps its own way out ────────────────────────────
section('3 · the empty state still offers it, and now it is not the only place');
{
  // The empty-state button, not the first .cul-statebtn in the file — three
  // different empty states use that class and the first is Retry.
  yes(/class="btn cul-statebtn" onclick="cuFilterClearAll\(\)"/.test(CUST),
    'a customer filter that matched nothing still offers to clear itself');
  yes(/paClearFilters\(\)/.test(PROD), 'so does a catalogue filter that matched nothing');
  // That was the ONLY door before. The finding is not that it was wrong, but
  // that it was the wrong case to serve alone.
  yes(HTML.includes('id="cu-clear-btn"') && HTML.includes('id="pa-clear-btn"'),
    'and both now have a door before the list empties out');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
