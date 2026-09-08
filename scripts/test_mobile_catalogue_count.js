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
 * THE SECOND HALF, added with §64. That fix closed the fifty-row hole and left
 * the same hole one order of magnitude up, deliberately and in writing: the
 * endpoint caps at 500 rows and took no page number, so a shop with nine
 * hundred products had exactly the reported defect again — four chips counting
 * 500 of 900, a search that could not reach the last four hundred, a variant
 * family cut in half at the boundary, and an order line's SKU chip refusing to
 * open anything past the cap. loadCatalogue now WALKS the catalogue through the
 * endpoint's new `offset`, and where the walk stops short the screen says so
 * instead of drawing four counts about a prefix.
 *
 * THE RULE, in six parts, one per section below:
 *   1. loadCatalogue is the only writer of the whole catalogue, it can be
 *      asked again (a refresh must be able to refresh), and the answer to the
 *      newest request wins even when an older one lands after it.
 *   2. Pull-to-refresh re-reads the catalogue instead of letting loadLive's
 *      page stand in for it.
 *   3. Nothing else claims a page IS the catalogue — the boot seed stands
 *      aside once the real read owns the array and never sets the flag the
 *      count chips read.
 *   4. The All chip counts the shop, not the array.
 *   5. The walk reaches the end of the shelf, and knows when it did not.
 *   6. A count got by walking the array is drawn only while the array is the
 *      whole shelf; where it is not, the screen says which fraction it is.
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

/* The page size and the runaway guard are LIFTED, not retyped. A suite that
   hardcodes 500 goes quietly wrong the day the constant moves — it would keep
   passing while testing a page size the app no longer uses. */
function liftConst(name) {
  const m = M.match(new RegExp('^const ' + name + '=\\d+;', 'm'));
  if (!m) throw new Error('cannot find const ' + name + ' in m.html');
  return m[0];
}
const SRC_CONSTS  = liftConst('CAT_PAGE') + '\n' + liftConst('CAT_MAX_PAGES') + '\n';
const CAT_PAGE      = Number(/=(\d+)/.exec(liftConst('CAT_PAGE'))[1]);
const CAT_MAX_PAGES = Number(/=(\d+)/.exec(liftConst('CAT_MAX_PAGES'))[1]);
const SRC_CATALOGUE = SRC_CONSTS + 'let _catSeq=0;\n' + lift('loadCatalogue');

/* A sandbox holding just what loadCatalogue touches. By default `apiRaw` hands
   back the RESOLVER so a test can decide WHEN each read answers, which is the
   only way to put two walks in flight and land them out of order. Pass
   `answer` and the reads resolve themselves instead, which is what a
   multi-page walk needs — a walk asks for its next page only after the last
   one landed, so holding every page open by hand reads as noise. */
function makeBox(answer) {
  const box = {
    state: { catalogueTried: false, catalogueLoading: false, cataloguePromise: null,
             prodTotal: null, liveProductsLoaded: false, catalogueComplete: false },
    DB: { products: [] },
    calls: [],
    renders: 0,
    pending: [],
    /* Every array the app was holding at each paint. A refresh that shrinks a
       complete catalogue to a page for one round trip is invisible to an
       end-state assertion and is exactly the defect the publish guard exists
       for, so the sizes are recorded as they happen. */
    seenLengths: [],
    render() { box.renders++; box.seenLengths.push((box.DB.products || []).length); },
    mapProduct: (r) => ({ id: r.id, sku: r.sku }),
    apiRaw(p) {
      box.calls.push(p);
      if (!answer) return new Promise((res, rej) => box.pending.push({ res, rej }));
      return Promise.resolve().then(() => answer(p, box.calls.length - 1));
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
    Promise, Number, Array, Set, console,
  };
  vm.createContext(box);
  vm.runInContext(SRC_CATALOGUE, box);
  return box;
}
/* The loader is an async function now, so its first request goes out on a
   microtask rather than on the calling line, and a multi-page walk needs one
   turn per page. Flushing a fixed handful of turns keeps every call site
   reading as `await settle()` regardless of how many pages ran. */
const settle = async () => { for (let i = 0; i < CAT_MAX_PAGES + 4; i++) await new Promise((r) => setImmediate(r)); };

/* A shop of `n` products, and a server that serves it a page at a time exactly
   as routes/retail.js does: `total` is the whole shelf, `data` is at most
   `limit` rows from `offset`. */
const shop = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, sku: 'P' + (i + 1) }));
function serveFrom(rows, opts) {
  const o = opts || {};
  return (p, nth) => {
    if (o.failAt != null && nth === o.failAt) throw new Error('offline');
    const off = Number((/offset=(\d+)/.exec(p) || [])[1] || 0);
    const lim = Number((/limit=(\d+)/.exec(p) || [])[1] || rows.length);
    const data = rows.slice(off, off + lim);
    return { success: true, data, total: o.total != null ? o.total : rows.length,
             limit: lim, offset: off, truncated: off + data.length < rows.length };
  };
}

(async () => {
  {
    const b = makeBox();
    b.loadCatalogue();
    await settle();
    is(b.calls.length, 1, 'opening Products reads the catalogue once');
    yes(/limit=500/.test(b.calls[0]) && !/limit=50\b/.test(b.calls[0]),
      'it asks for the whole catalogue, not a page of fifty', b.calls[0]);
    yes(/offset=0\b/.test(b.calls[0]),
      'and says where it is starting, so a second page can follow', b.calls[0]);

    b.pending[0].res({ data: [{ id: 1, sku: 'A' }, { id: 2, sku: 'B' }], total: 249 });
    await settle();
    is(b.DB.products.length, 2, 'the rows land');
    is(b.state.prodTotal, 249,
      "the count is the SERVER's total, not the length of what arrived");
    is(b.state.liveProductsLoaded, true, 'and the counts are allowed to show');
  }

  {
    const b = makeBox(serveFrom(shop(1)));
    b.loadCatalogue();
    await settle();
    b.loadCatalogue();              // the render loop, asking again
    await settle();
    is(b.calls.length, 1, 'an unforced second call does not re-read');
    b.loadCatalogue(true);          // a refresh, asking again
    await settle();
    is(b.calls.length, 2, 'a FORCED call does re-read — a refresh can refresh');
  }

  {
    // The whole point of the sequence guard: a save forces a read while a
    // refresh's read is still out. The save's answer must win whenever it
    // lands, and the older read must not put the older catalogue back.
    const b = makeBox();
    b.loadCatalogue();                                   // read #1 (refresh)
    b.loadCatalogue(true);                               // read #2 (post-save)
    await settle();
    is(b.calls.length, 2, 'a forced read goes out even with one in flight');
    /* Guarded rather than assumed: when the forced read is the one that is
       broken there is no second request to land, and this suite should print
       every rule that is being broken instead of dying on the first. */
    if (b.pending.length === 2) {
      b.pending[1].res({ data: [{ id: 9, sku: 'NEW' }], total: 1 });   // #2 answers first
      await settle();
      b.pending[0].res({ data: [{ id: 1, sku: 'OLD' }, { id: 2, sku: 'OLD2' }], total: 2 }); // #1, late
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
    const b = makeBox(serveFrom(shop(0)));
    b.loadCatalogue();
    await settle();
    is(b.DB.products.length, 0, 'a shop with no products sees no products');
    is(b.state.prodTotal, 0, 'and is told it has none');
    is(b.state.catalogueComplete, true,
      'an empty shelf is a WHOLE shelf — the counts are allowed to say zero');
  }

  {
    const b = makeBox();
    b.loadCatalogue();
    await settle();
    b.pending[0].rej(new Error('offline'));
    await settle();
    is(b.state.catalogueLoading, false, 'a failed read stops saying it is loading');
    is(b.DB.products.length, 0, 'and leaves the array alone');
    /* The difference between "this shop has no products" and "this phone could
       not ask". Publishing an empty catalogue here would set the flag the All
       chip reads and announce a shop of zero to a shop that is merely offline —
       the same substitution as a page standing in for the shelf, at the other
       end of the scale. */
    is(b.state.liveProductsLoaded, false,
      'a read that reached nothing does not license a count of zero');
    is(b.state.catalogueComplete, false, 'nor claim the array is the whole shelf');
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
  const chip = M.slice(cdAt, cdAt + 260);
  yes(/count:L\?\(state\.prodTotal!=null\?state\.prodTotal:\(C\?P\.length:null\)\):null/.test(chip),
    "All reads the server's total, falling back to the array only if it is missing AND whole");
  yes(/count:L\?/.test(chip) && /:null/.test(chip),
    'and still shows no count at all until there is a real one');

  // ── §5 · the walk reaches the end of the shelf ───────────────────────────
  section('§5 · the catalogue is read to its end, and the phone knows when it was not');

  {
    // Nine hundred products through a five-hundred-row window: the size the
    // previous fix named as still broken and left open on purpose.
    const b = makeBox(serveFrom(shop(900)));
    b.loadCatalogue();
    await settle();
    is(b.calls.length, 2, 'a catalogue past the cap is read in as many pages as it takes');
    yes(/offset=0\b/.test(b.calls[0]) && new RegExp('offset=' + CAT_PAGE + '\\b').test(b.calls[1]),
      'the second page starts where the first ended', b.calls.join(' | '));
    is(b.DB.products.length, 900, 'and the phone ends up holding all nine hundred');
    is(b.state.prodTotal, 900, 'the shop total agrees with the array now, rather than despite it');
    is(b.state.catalogueComplete, true, 'the array is the whole shelf, so the four counts may draw');
  }

  {
    // Exactly the page size. The server's own total says the shelf is finished,
    // so a second request would be a round trip that can only return nothing.
    const b = makeBox(serveFrom(shop(CAT_PAGE)));
    b.loadCatalogue();
    await settle();
    is(b.calls.length, 1, 'a catalogue of exactly one page costs exactly one request');
    is(b.DB.products.length, CAT_PAGE, 'and all of it arrives');
    is(b.state.catalogueComplete, true, 'and it is known to be whole');
  }

  {
    /* THE HONEST PARTIAL. Page two never arrives. What page one brought is kept
       — half a catalogue an operator can see beats an empty screen — but it is
       marked as half, and `prodTotal` still says how big the shelf really is so
       the screen can name the shortfall in both figures. */
    const b = makeBox(serveFrom(shop(900), { failAt: 1 }));
    b.loadCatalogue();
    await settle();
    is(b.DB.products.length, CAT_PAGE, 'a page that fails leaves the pages before it in hand');
    is(b.state.catalogueComplete, false, 'and the array does not claim to be the shelf');
    is(b.state.prodTotal, 900, "while the shop's real size is still known");
    is(b.state.catalogueLoading, false, 'and the screen is not left loading forever');
  }

  {
    /* A product created underneath the walk shifts every row after it, so the
       same product can arrive on two pages. It must be stored once — a
       duplicated row is a duplicated card and a double count. And the offset
       must still advance by what the SERVER sent: advancing by what survived
       the filter would re-ask for the row that was just dropped, and the walk
       would sit on the spot until the runaway guard stopped it. */
    const rows = shop(900);
    const dupServer = (p, nth) => {
      const off = Number((/offset=(\d+)/.exec(p) || [])[1] || 0);
      const data = rows.slice(off, off + CAT_PAGE);
      // Page two repeats the last row of page one, as a mid-walk insert does.
      if (nth === 1) data.unshift(rows[CAT_PAGE - 1]);
      return { success: true, data, total: 900 };
    };
    const b = makeBox(dupServer);
    b.loadCatalogue();
    await settle();
    const ids = b.DB.products.map((r) => r.id);
    is(new Set(ids).size, ids.length, 'a row served on two pages is stored once');
    yes(b.calls.length <= 3, 'and the walk moves on rather than stalling on the duplicate',
      b.calls.join(' | '));
  }

  {
    /* THE RUNAWAY GUARD. A server that keeps answering full pages against a
       total it never reaches — rows being deleted underneath the walk is the
       real shape of it. The loop must stop, and what it stops with must not
       claim to be the whole catalogue. */
    const endless = () => ({ success: true, data: shop(CAT_PAGE), total: 999999 });
    const b = makeBox(endless);
    b.loadCatalogue();
    await settle();
    is(b.calls.length, CAT_MAX_PAGES, 'the walk cannot run past its ceiling');
    is(b.state.catalogueComplete, false, 'and what it stopped with is not called the shelf');
    is(b.state.catalogueLoading, false, 'and it does stop');
  }

  {
    /* A REFRESH MUST NOT SHRINK A CATALOGUE IT ALREADY HAS. Page one of a
       nine-hundred-product walk is five hundred rows, and publishing it would
       replace a complete array with a prefix for the length of a round trip —
       during which `openProduct` and the SKU chip on an order line, which both
       resolve against this same array, would fail for every product past the
       cap. That is the defect this loader exists to prevent, reintroduced as a
       flicker, and an end-state assertion cannot see it. */
    const b = makeBox(serveFrom(shop(900)));
    b.loadCatalogue();
    await settle();
    is(b.DB.products.length, 900, 'the first walk fills the shelf');
    b.seenLengths.length = 0;
    b.loadCatalogue(true);                       // pull-to-refresh
    await settle();
    is(b.seenLengths.filter((n) => n < 900).length, 0,
      'a refresh never paints fewer products than it already had');
    is(b.DB.products.length, 900, 'and ends where it started');
  }

  {
    /* …and the unconditional final publish is what keeps that guard from
       becoming a different bug: a catalogue that genuinely SHRANK, because
       products were deleted between two reads, must still land. */
    const b = makeBox(serveFrom(shop(900)));
    b.loadCatalogue();
    await settle();
    b.answer = null;
    const smaller = makeBox(serveFrom(shop(300)));
    smaller.DB.products = b.DB.products.slice();      // start holding the old 900
    smaller.state.catalogueComplete = true;
    smaller.loadCatalogue(true);
    await settle();
    is(smaller.DB.products.length, 300, 'a catalogue that got smaller still lands');
    is(smaller.state.catalogueComplete, true, 'and is known to be whole at its new size');
  }

  // ── §6 · a count off the array is drawn only while the array is the shelf ─
  section('§6 · the screen says which fraction it is holding');

  const prodScreen = M.slice(M.indexOf("products:{title:['Products','产品']"),
                             M.indexOf("categories:{title:['Categories','分类']"));
  yes(prodScreen.length > 400, 'the Products sub-view is where it is expected');

  yes(/const n=k=>\(L&&C\)\?P\.filter/.test(prodScreen),
    'Live / Draft / Low / Out are drawn only while the array is the whole shelf');
  yes(/const C=state\.catalogueComplete/.test(prodScreen),
    'and the flag they read is the one the loader sets on the array it published');

  /* The bar is drawn from the two figures disagreeing, never from the flag
     alone: with no `total` in the envelope the loader falls back to the length
     of what it holds, and a bar reading "the first 500 of 500" would invent a
     shortfall it cannot see. */
  yes(/state\.prodTotal!=null&&state\.prodTotal>P\.length/.test(prodScreen),
    'the "not all of it" bar needs a real total that is bigger than what is held');
  yes(/catRetry/.test(prodScreen) && /reg\('catRetry'/.test(M),
    'and it offers the read again rather than only naming the shortfall');
  yes(/loadCatalogue\(true\)/.test(M.slice(M.indexOf("reg('catRetry'"), M.indexOf("reg('catRetry'") + 200)),
    'the retry is FORCED — an unforced one is latched and would do nothing');

  // ── §7 · the server can be asked for the second page ─────────────────────
  section('§7 · the endpoint takes an offset, and pages cannot overlap');

  const R = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  const ep = R.slice(R.indexOf("router.get('/api/retail-admin/products'"));
  const epBody = ep.slice(0, ep.indexOf("router.get('/api/retail-admin/products/:id/image'"));

  yes(/const off = Math\.max\(0, parseInt\(req\.query\.offset, 10\) \|\| 0\)/.test(epBody),
    'the products list reads an offset');
  yes(/OFFSET '? ?\+ off|OFFSET ' \+ off/.test(epBody) || /LIMIT ' \+ lim \+ ' OFFSET ' \+ off/.test(epBody),
    'and applies it to the query');
  /* WITHOUT THIS THE PAGING IS UNSOUND, not merely untidy. The three sort keys
     are not unique between them, and SQLite may order tied rows differently in
     two statements — across LIMIT/OFFSET a tied row can then land on both pages
     or on neither, so a two-request read silently gains a duplicate or loses a
     product. */
  yes(/ORDER BY is_published DESC, sort_order ASC, name_en ASC, id ASC/.test(epBody),
    'the sort ends in a unique key, so page two begins exactly where page one ended');
  yes(/truncated: off \+ rows\.length < total/.test(epBody),
    '"there is more" is measured from the end of the page, not from its length');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
