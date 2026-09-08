#!/usr/bin/env node
/**
 * test_mobile_catalogue_count.js — the phone's catalogue is the catalogue.
 *
 *   node scripts/test_mobile_catalogue_count.js
 *
 * THE FINDING, reported from a live shop: "real product count is 249, the
 * moment you refresh it counts 50." Two screenshots a minute apart, the same
 * screen: All 249 / Live 192 / Draft 7 / Low 27, then All 50 / Live 40 /
 * Draft 0 / Low 6. Maple Cinnamon lost its "2 sizes" mark and its ¥57–¥89
 * range and came back as a single ¥57 row; Peanut Butter did the same.
 *
 * WHY. `DB.products` had three writers and only one of them read the whole
 * catalogue. loadLive's boot read and the product sheet's post-save re-read
 * both asked for `?limit=50` and wrote the answer over the array, and
 * loadCatalogue's `catalogueTried` latch meant the full read never ran again —
 * so whichever fifty-row page landed last was the catalogue for the rest of
 * the session. Pull-to-refresh calls loadLive, which is why a pull was all it
 * took. The counts came off `DB.products.length`, so a page of fifty announced
 * itself as a shop of fifty; prodUnits() groups variants by walking the same
 * array, so a family whose siblings fell off the page stopped being a family.
 *
 * THE RULE, in three parts, one per section below:
 *   1. loadCatalogue is the only writer of the whole catalogue, it can be
 *      asked again (a refresh must be able to refresh), and the answer to the
 *      newest request wins even when an older one lands after it.
 *   2. Pull-to-refresh re-reads the catalogue instead of letting loadLive's
 *      page stand in for it.
 *   3. Nothing else claims a page IS the catalogue — the boot seed stands
 *      aside once the real read owns the array and never sets the flag the
 *      count chips read.
 *
 * No browser: the loaders are lifted out of m.html and driven in a sandbox
 * against a fake fetch, which is where "which response wins" can actually be
 * made to go red. The render assertions that need a DOM live in
 * test_mobile_products.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

/* Lift one top-level `function name(...)` out of the file by brace-matching.
   Braces inside strings and comments would break a naive count, so the scan
   skips quotes, template literals, regex-free comment forms — enough for the
   two small functions this suite drives, and it fails loudly rather than
   silently returning half a function. */
function lift(name) {
  const start = M.indexOf('\nfunction ' + name + '(') + 1;
  if (start === 0) throw new Error('cannot find function ' + name + ' in m.html');
  let i = M.indexOf('{', start), depth = 0, q = null;
  for (; i < M.length; i++) {
    const c = M[i];
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && M[i + 1] === '/') { i = M.indexOf('\n', i); continue; }
    if (c === '/' && M[i + 1] === '*') { i = M.indexOf('*/', i) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return M.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces lifting ' + name);
}

// ── §1 · loadCatalogue owns the catalogue ──────────────────────────────────
section('§1 · loadCatalogue is the only writer of the whole catalogue');

const SRC_CATALOGUE = 'let _catSeq=0;\n' + lift('loadCatalogue');

/* A sandbox holding just what loadCatalogue touches. `deferred` hands back the
   resolver so a test can decide WHEN each read answers, which is the only way
   to put two of them in flight and land them out of order. */
function makeBox() {
  const box = {
    state: { catalogueTried: false, catalogueLoading: false, cataloguePromise: null,
             prodTotal: null, liveProductsLoaded: false },
    DB: { products: [] },
    calls: [],
    renders: 0,
    pending: [],
    render() { box.renders++; },
    mapProduct: (r) => ({ sku: r.sku }),
    apiRaw(p) {
      box.calls.push(p);
      return new Promise((res, rej) => box.pending.push({ res, rej }));
    },
    /* The sandbox answers to api() as well as apiRaw(), so a loader that goes
       back to the unwrapped helper fails on an ASSERTION here — "the count is
       the server's total" — rather than on a ReferenceError that says nothing
       about what broke. api() unwraps the envelope, exactly as m.html's does. */
    api(p) {
      box.calls.push(p);
      return new Promise((res, rej) => box.pending.push({
        res: (j) => res(j && j.data !== undefined ? j.data : j), rej }));
    },
    Promise, Number, Array, console,
  };
  vm.createContext(box);
  vm.runInContext(SRC_CATALOGUE, box);
  return box;
}
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  {
    const b = makeBox();
    b.loadCatalogue();
    is(b.calls.length, 1, 'opening Products reads the catalogue once');
    yes(/limit=500/.test(b.calls[0]) && !/limit=50\b/.test(b.calls[0]),
      'it asks for the whole catalogue, not a page of fifty', b.calls[0]);

    b.pending[0].res({ data: [{ sku: 'A' }, { sku: 'B' }], total: 249 });
    await settle();
    is(b.DB.products.length, 2, 'the rows land');
    is(b.state.prodTotal, 249,
      "the count is the SERVER's total, not the length of what arrived");
    is(b.state.liveProductsLoaded, true, 'and the counts are allowed to show');
  }

  {
    const b = makeBox();
    b.loadCatalogue();
    b.pending[0].res({ data: [{ sku: 'A' }], total: 1 });
    await settle();
    b.loadCatalogue();              // the render loop, asking again
    is(b.calls.length, 1, 'an unforced second call does not re-read');
    b.loadCatalogue(true);          // a refresh, asking again
    is(b.calls.length, 2, 'a FORCED call does re-read — a refresh can refresh');
  }

  {
    // The whole point of the sequence guard: a save forces a read while a
    // refresh's read is still out. The save's answer must win whenever it
    // lands, and the older read must not put the older catalogue back.
    const b = makeBox();
    b.loadCatalogue();                                   // read #1 (refresh)
    b.loadCatalogue(true);                               // read #2 (post-save)
    is(b.calls.length, 2, 'a forced read goes out even with one in flight');
    /* Guarded rather than assumed: when the forced read is the one that is
       broken there is no second request to land, and this suite should print
       every rule that is being broken instead of dying on the first. */
    if (b.pending.length === 2) {
      b.pending[1].res({ data: [{ sku: 'NEW' }], total: 1 });   // #2 answers first
      await settle();
      b.pending[0].res({ data: [{ sku: 'OLD' }, { sku: 'OLD2' }], total: 2 }); // #1, late
      await settle();
      is(b.DB.products.length, 1, 'the superseded read cannot overwrite the newer one');
      is(b.state.prodTotal, 1, 'nor put the older count back');
      is(b.state.catalogueLoading, false, 'and the screen is not left loading');
    } else {
      bad('the superseded read cannot overwrite the newer one',
          'no second read went out, so ordering could not be tested');
    }
  }

  {
    const b = makeBox();
    b.loadCatalogue();
    b.pending[0].res({ data: [], total: 0 });
    await settle();
    is(b.DB.products.length, 0, 'a shop with no products sees no products');
    is(b.state.prodTotal, 0, 'and is told it has none');
  }

  {
    const b = makeBox();
    b.loadCatalogue();
    b.pending[0].rej(new Error('offline'));
    await settle();
    is(b.state.catalogueLoading, false, 'a failed read stops saying it is loading');
    is(b.DB.products.length, 0, 'and leaves the array alone');
  }

  // ── §2 · pull-to-refresh refreshes the catalogue ─────────────────────────
  section('§2 · pull-to-refresh re-reads the catalogue');

  const SRC_REFRESH = lift('refreshNow');
  function refreshBox(catalogueTried, tab) {
    const box = {
      state: { refreshing: false, catalogueTried, tab },
      forced: [], render() {}, setTimeout,
      loadLive: () => Promise.resolve(),
      loadOrdersPage: () => Promise.resolve(),
      loadCustomers: () => Promise.resolve(),
      loadCatalogue: (f) => { box.forced.push(!!f); return Promise.resolve(); },
      Promise, console,
    };
    vm.createContext(box);
    vm.runInContext(SRC_REFRESH, box);
    box.refreshNow();
    return box;
  }
  is(refreshBox(true, 'products').forced.join(), 'true',
    'with the catalogue loaded, a pull re-reads it — forced');
  is(refreshBox(true, 'home').forced.join(), 'true',
    'from any tab: Products is reachable as a pushed screen too');
  is(refreshBox(false, 'home').forced.length, 0,
    'and it is not fetched for a screen nobody has opened');

  // ── §3 · nothing else claims a page is the catalogue ─────────────────────
  section('§3 · the boot seed never stands in for the catalogue');

  /* Source assertions, because this half is inline in loadLive and cannot be
     lifted. They are written against the RULE ("no fifty-row read sets the
     flag") rather than against today's wording, so a future page read is
     caught by the same lines. */
  const pageReads = M.match(/api\('\/products\?limit=50'\)/g) || [];
  is(pageReads.length, 1, 'exactly one cheap page read remains — the boot seed');

  const seed = M.slice(M.indexOf("api('/products?limit=50')") - 400,
                       M.indexOf("api('/products?limit=50')") + 400);
  yes(/if\(!state\.catalogueTried\)/.test(seed),
    'the seed stands aside once the real read owns the array');
  yes(/!state\.catalogueTried\)\s*DB\.products=/.test(seed),
    'and re-checks after its own await, so it cannot land on top of it');
  yes(!/liveProductsLoaded/.test(seed),
    'a page of fifty NEVER sets the flag the count chips read');

  yes(!/const rows=await api\('\/products\?limit=50'\); if\(Array\.isArray\(rows\)\)/.test(M),
    'the post-save re-read no longer truncates the list behind the sheet');
  const save = M.slice(M.indexOf('async function saveProductEdits'));
  yes(/await loadCatalogue\(true\)/.test(save.slice(0, save.indexOf('\nasync function', 1))),
    'it re-reads through the catalogue loader instead');

  /* The assignment, not the word: the comment that replaced it says the word
     `liveAttn.low` in order to record what was removed and why. */
  yes(!/\blow:\s*(DB\.products|null)/.test(M) && !/\{low:DB\.products/.test(M),
    'the low-stock count derived from that page is gone, not left wrong');

  // ── §4 · the count is a fact about the shop ──────────────────────────────
  section('§4 · the All chip counts the shop, not the array');

  /* Anchored on the PRODUCTS chip row — five other screens open a chip row
     with the same `{key:'all',...}` literal, and the first match in the file
     is the Orders one. */
  const cdAt = M.indexOf("const cd=[{key:'all',en:'All'");
  yes(cdAt > -1, "the products chip row is where it is expected");
  const chip = M.slice(cdAt, cdAt + 240);
  yes(/count:L\?\(state\.prodTotal!=null\?state\.prodTotal:P\.length\):null/.test(chip),
    "All reads the server's total, falling back to the array only if it is missing");
  yes(/count:L\?/.test(chip) && /:null/.test(chip),
    'and still shows no count at all until there is a real one');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
