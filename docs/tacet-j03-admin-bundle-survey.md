# J-03 re-verified — the admin bundle, and why lazy loading is blocked

**Read-only survey, 2026-09-06. No code changed.** Commissioned because J-03 is
the last unaddressed finding in `docs/tacet-audit-2026-09.md` whose suggested
direction is a refactor rather than a fix, and a refactor wants measuring before
it wants starting.

**Three headlines:**

1. **Half of J-03 is already closed.** `lib/static-assets.js` was written for
   this finding and is live. It cuts the wire cost 3.1× and, between deploys,
   to nothing.
2. **The bundle has grown since the audit, not shrunk** — 23 files to 28,
   57,218 lines to 61,976.
3. **The audit's suggested direction cannot be done as written.** Fourteen of
   the twenty-eight files form a single dependency *cycle*. `01-core.js`, the
   file every other file depends on, itself depends on seven of them. Nothing in
   that cycle can be loaded on demand, and it is **71% of the bytes**.

There is still a worthwhile change available — a 29% cut on first load that
touches the cycle not at all. It is at the bottom.

---

## The numbers, then and now

Measured at `6f81ba27`, which is main at `635679ae` plus this branch.

| | At the audit (`416c1d11`, 2026-09-04) | Today | |
|---|---|---|---|
| Files | 23 | **28** | +5 |
| Lines | 57,218 | **61,976** | +4,758 |
| Raw | 3.08 MB | **3.33 MB** | +259 KB |
| Gzipped | 995 KB | **1,092 KB** | +97 KB |
| `04-orders.js` raw | 558,191 B | **600,035 B** | +41 KB |

The five new files are `24-import.js`, `25-views.js`, `26-print.js`,
`27-keyboard.js`, `28-shops.js` — 93 KB raw of the 259 KB. The rest is growth
inside the original 23.

**Gzipped figures throughout this document are the sum of the files compressed
individually**, because that is how they are served: 28 separate requests, each
compressed on its own. Compressing the concatenation gives a smaller number
(1,065 KB today) that nothing on the wire ever sees.

### About the audit's "970 KB"

It is within 3% of the gzipped total at that commit (995 KB at level 6, 992 KB
at level 9), so it was almost certainly a gzipped measurement. The inconsistent
half is the body: *"Orders alone is 558 KB"* is `04-orders.js`'s **raw** size
(558,191 bytes). So the finding states its headline in compressed bytes and its
evidence in uncompressed ones, which is why the two never looked reconcilable.

**Neither figure being off makes the finding wrong** — a megabyte of gzipped
JavaScript on every post-deploy load is real either way. But quote the unit
along with the number.

---

## What `lib/static-assets.js` already did

Mounted at `server.js:194`, ahead of `express.static`. It was written for this
finding and says so. Two things:

- **It compresses.** Nothing did before: nginx in front does not gzip, and
  `server.js`'s own compression wraps `res.json` only — so the API was
  compressed and the code that called it was not. Measured across the 28 files:
  **3.33 MB → 1,092 KB, a 3.1× cut.** (The file's own header says "~5×"; 3.1× is
  what the JavaScript actually gives. The claim is not far off and not exact.)
- **It makes a `?v=`-stamped file cacheable `immutable`.** Between deploys the
  browser makes no request at all. It is safe precisely because the stamp
  changes on every deploy, so a stamped URL names a file that cannot change.

So the audit's *"every screen's code is loaded on every visit"* is no longer
true. It is loaded on the **first visit after each deploy**, compressed.

**One cheap thing left in this half:** the handler is gzip-only. Brotli on the
same files is a further ~9% for a `zlib.brotliCompressSync` call beside the
existing one, negotiated by the same `Accept-Encoding` header. That is a small,
self-contained change — unlike everything below.

> **DONE, and the estimate here was wrong.** This said "typically a further
> 15–20%", which is the figure quoted for brotli in general and not what these
> files give at a quality that can be served. Measured over the 28 parts:
>
> | | size | ratio | CPU |
> |---|---|---|---|
> | gzip 6 (before) | 1,092 KB | 3.12× | 3 ms/file |
> | **brotli 6 (now)** | **994 KB** | **3.43×** | **3 ms/file** |
> | brotli 11 | 884 KB | 3.86× | **147 ms/file** |
>
> So **9%, not 15–20%** — 19% exists only at quality 11, and `brotliCompressSync`
> blocks the event loop, so paying it for 28 files on the first load after a
> deploy would stall every other request in the process for about four seconds.
> q6 is the same CPU as the gzip it replaces. The reasoning is recorded in
> `lib/static-assets.js` beside the constant.

---

## Why the suggested direction is blocked

The audit suggests: *"load a section's code when the section is first opened."*
`lib/static-assets.js` names the obstacle in its own header — *"The 23 parts
share ONE global scope and call each other's functions by name; there is no
module boundary to load across, and a half-done version of it is a screen that
opens on a ReferenceError."*

That is right, and it is worse than it sounds. Measured rather than assumed:

### `01-core.js` is not a base layer

All 27 other files depend on it — and it **depends on seven of them**, by name,
at 26 sites:

| `01-core.js` reaches into | For |
|---|---|
| `02-settings-ops.js` | `loadOpsPanel`, `chLoad`, `nlLoad` |
| `03-dashboard.js` | `fcNum` (×11), `dashMoney` (×3), `dashAgeMins`, `dashSetDelta`, `DASH_OPS` |
| `04-orders.js` | `closeDrawer` (×2), `ordSetDelta` |
| `05-marketing.js` | `_cfgCache` (×4), `renderCurrencyControl`, `saveConfig` |
| `07-content-billing.js` | `reviewsTabInit`, `feedbackTabInit` |
| `08-customers.js` | `cuPtsSource` |
| `09-products.js` | `PA_CAT_TREE` (×2), `prodShowView` |

### Which makes a fourteen-file knot

Following those edges transitively, **fourteen files are one strongly connected
component** — every one of them reaches every other:

```
01-core  02-settings-ops  03-dashboard  04-orders  05-marketing  06-delivery
07-content-billing  08-customers  09-products  10-extras  13-activity
17-setup-guide  25-views  26-print
```

**771 KB gzipped — 71% of the bundle.** Loading any one of them requires all
fourteen. There is no order in which they can be loaded one at a time, so the
audit's direction is unavailable for 71% of the bytes until the cycle is broken.

### And cutting `01-core.js`'s edges alone does not break it

The obvious first move — make core stop reaching out, since it is only 26 sites
— was simulated by deleting those edges and recomputing. Core then pulls in
**one** file instead of fourteen. But the other thirteen still cycle among
themselves: `02` needs `09`, `09` needs `04`, `04` needs `08`, `08` needs `26`,
`26` needs `09`. The knot is not core's doing alone, and unpicking it is a
refactor of nine large screens, not of one small one.

### The coupling is not only function calls

`18-materials.js` reads a top-level variable called `_cats` that is declared in
`05-marketing.js`. `26-print.js` reads `PA_STORE`, `PA_STORES`, `PA_PRODUCTS`
and `PA_STOCK` from `09-products.js`, and `CU_CURRENT` from `08-customers.js`.
`27-keyboard.js` reads `TD` from `03-dashboard.js`.

**Shared mutable state across file boundaries is worse than shared functions.**
A lazily-loaded file that arrives after the variable was set reads a value; one
that arrives before reads `undefined`, and there is no error — just a wrong
screen. An analysis that counts only `foo()` call sites misses all of it and
reports a much rosier picture; an earlier pass in this session did exactly that
and had to be thrown away.

---

## What *is* available, without touching the cycle

If the fourteen-file cycle simply stays eager — loaded as it is today — then
**every one of the other fourteen files can be lazy immediately**, whatever it
depends on, because everything it depends on is already there.

| File | gz |
|---|---|
| `16-purchasing.js` | 75 KB |
| `19-recipes.js` | 47 KB |
| `11-meituan.js` | 36 KB |
| `14-eleme.js` | 26 KB |
| `15-integrations.js` | 26 KB |
| `18-materials.js` | 23 KB |
| `22-finance.js` | 17 KB |
| `21-product-build.js` | 16 KB |
| `23-sku.js` | 12 KB |
| `20-waste.js` | 12 KB |
| `24-import.js` | 11 KB |
| `12-guanyi.js` | 9 KB |
| `28-shops.js` | 9 KB |
| `27-keyboard.js` | 4 KB |
| **Total** | **322 KB** |

**First load goes from 1,092 KB to 771 KB gzipped — a 29% cut** — and an
operator who never opens Purchasing, Recipes, Meituan or Eleme never fetches
them at all. No file in the list is depended on by anything that loads eagerly,
which is the property that makes it safe; it was checked in both directions.

### The one hazard found, and it is small

`retail-admin.html` carries **306 inline `on*="..."` handlers**. Two of them
name functions that live in a file on the lazy list — `finLoad` and
`finTxRender`, both in `22-finance.js`. An inline handler fires whether or not
its function has loaded, so those two would need the loader to have run first,
or to be rewritten as listeners bound after load. Two, out of 306.

### What would still need care

- The loader has to be **awaited before the section paints**, not fired beside
  it, or the ReferenceError the static-assets header warns about is simply
  moved rather than avoided.
- `27-keyboard.js` binds global shortcuts and is 4 KB. It should stay eager —
  a shortcut that works only after you have visited the screen is worse than
  one that costs 4 KB.
- The gain is **only on the first load after a deploy**. Between deploys the
  cache already makes this free, so the honest description is "the post-deploy
  load gets 29% smaller", not "the admin gets 29% faster".

---

## Method, and what it does not see

Each file is scanned for top-level `function` declarations and top-level
`const`/`let`/`var` bindings at column 0. A name declared in two files is
discarded as ambiguous (there were none). Every other file's full text — code,
strings and embedded HTML alike — is then searched for those names, excluding
matches preceded by a dot, so `obj.foo(` is not counted as a call to a global
`foo`. Scanning the raw text rather than parsed code is deliberate: it catches
`onclick="paToggleShop()"` inside an HTML string, which is a real edge.

**It cannot see** a call made through `window[name]()` or any other computed
reference. If those exist, the cycle is larger than reported, never smaller —
so the fourteen-file figure is a floor.

Scripts are in this session's scratchpad only; nothing was added to the tree.

---

## Recommendation

1. **Amend J-03 in the audit.** Record that compression and caching are done,
   correct the file/line/size figures, drop the unreproducible 970 KB, and note
   that the suggested direction is blocked on a fourteen-file cycle. Otherwise
   the next reader re-derives this.
2. **Add brotli to `lib/static-assets.js`** if anything is done at all. Smallest
   change, no coupling risk, benefits every asset and not just the admin.
3. **Lazy-load the fourteen files above** — 29% off the post-deploy load, and
   the cycle is not touched. This is the only part with real work in it, and it
   is bounded: a loader, fourteen call sites, and two inline handlers.
4. **Do not start on the cycle.** Breaking it is a refactor of nine large
   screens with shared mutable state between them, its own plan, and its own
   test strategy. It should not begin as a side effect of a performance item.

**Nothing here is urgent.** J-03 is Medium, the compression that made it
survivable is live, and the remaining cost falls on one load per deploy.
