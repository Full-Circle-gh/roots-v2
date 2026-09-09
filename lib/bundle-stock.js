'use strict';

// Shared per-store stock derivation for channel pushes.
//
// A roots BUNDLE is a normal store_products row whose `bundle_items` JSON lists
// the component products it is made of ([{id, qty}] per-unit quantities). It has
// its own retail_store_stock row, but NOTHING moves that row: a bundle sale is
// expanded to component demand by routes/retail.js expandStockLines() before the
// inventory layer ever sees it, so the reservation, the commit and the ledger all
// land on components. The bundle's own physical_qty is therefore vestigial — on
// most rows it is still the 2026-05-17 migration seed, which was written directly
// with no ledger entry and has never moved since.
//
// The storefront and the operator catalogue both already know this and derive the
// real figure from components:
//   • storefront — decorateBundleRow()   routes/retail.js
//   • catalogue  — _paBundleStock()      public/retail-admin/09-products.js
// The channel sync libs did not, so Meituan/Eleme/Guanyi were being told the
// vestigial number. This module is the one place that derivation lives for
// server-side callers, so the shop and the channels cannot disagree again.
//
// SCOPE NOTE — this is deliberately PER STORE. decorateBundleRow's components
// carry inventory.sellableStockSql(), which is a SUM ACROSS OPEN STORES, so the
// storefront's bundle figure is one cross-store number. A channel listing belongs
// to ONE store (a Meituan 天河 listing needs 天河's assemblable count), so the
// per-store form is the correct analogue here — the same arithmetic _paBundleStock
// does with each column's own store. The two agree per store and differ only in
// how many stores they aggregate, which is what each caller needs.
//
// Takes the tenant db handle so it stays multi-tenant safe, and requires nothing
// from lib/inventory — the channel libs are lazily required FROM inventory, so a
// top-level import back would close a cycle.

// parseBundleItems → the clean [{id, qty}] array (or [] when not a bundle).
// Mirrors routes/retail.js parseBundleItems exactly, including the de-dupe on id
// and the "unreadable / non-positive qty becomes 1" rule. Kept as its own copy
// rather than imported: routes/retail.js is an Express router that pulls in the
// whole storefront on require, and the channel daemons must not load that.
function parseBundleItems(v) {
  if (!v) return [];
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const id = parseInt(it && (it.id != null ? it.id : it.product_id), 10);
    let qty  = parseInt(it && it.qty, 10);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;
    seen.add(id);
    out.push({ id, qty });
  }
  return out;
}

// The raw shelf count for one (store, product) — exactly the query every channel
// lib ran inline before this module existed. A missing row reads 0 and is NOT
// created, matching getAvailable's "read as zero, never create on read" rule.
function rawStockAt(db, storeId, productId) {
  const row = db.prepare(
    'SELECT COALESCE(physical_qty, 0) AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
  ).get(storeId, productId);
  return row ? row.q : 0;
}

// This product's component recipe, or [] when it is not a bundle.
function componentsOf(db, productId) {
  const row = db.prepare('SELECT bundle_items FROM store_products WHERE id = ?').get(productId);
  return row ? parseBundleItems(row.bundle_items) : [];
}

// THE HELPER. How many units of `productId` a channel may be told this store has.
//
//   not a bundle → COALESCE(physical_qty, 0), floored at 0 — see below.
//   a bundle     → min over components of floor(component shelf count / per-unit
//                  qty), floored at 0. Same arithmetic as _paBundleStock and
//                  decorateBundleRow.
//
// A bundle whose recipe is present but whose components are all missing reads 0,
// which is the honest answer: nothing can be assembled.
//
// ─── §84 · THE FLOOR LIVES HERE, AND ONLY HERE ─────────────────────────────
// Every caller of this function is publishing a number OUTWARD — the Meituan,
// Eleme and Guanyi sync queues, their drift sweeps, the store-close sweep and
// the admin's "push all now". None of them is asking what the shelf holds; they
// are asking what a platform may sell, and the answer to that is never less
// than nothing.
//
// This matters now because §84 stopped the channel ingests clamping: the shelf
// is allowed to read −18, and −18 is TRUE ("eighteen were sold that were never
// held"). What must not happen is that number reaching a platform, which is
// what the un-floored non-bundle path would have done — it returned the raw
// column, and the bundle path beside it had been floored since it was written.
//
// The floor belongs on THIS side and not at the ingest, and the difference is
// the whole of §84: clamping where the debt is INCURRED destroys the fact,
// clamping where it is PUBLISHED merely declines to export it. Our ledger is
// allowed to carry a debt; a platform cannot hold one.
//
// The header above used to say the non-bundle path "must never change". It was
// written when nothing could drive a shelf negative on a channel path, and it
// was never true of the other paths that could — adjustStock has had no floor
// since §39, so a transfer or a correction could already put a negative number
// on this wire. This is that latent bug closed, not only a §84 consequence.
// The same figure BEFORE the floor — which is to say, the true one, negatives
// and all. Split out for §85: the pre-order window publishes
// `max(0, shelf + allowance)`, and flooring the shelf FIRST would answer 20 on
// a shelf of −3 where the truth is 17. A debt already taken has to be paid out
// of the allowance before any of it is offered again.
//
// Not a channel-facing function and deliberately not named like one. Callers
// that publish want sellableAt (below) or lib/channel-publish.js; this is for
// whoever needs the arithmetic without the promise.
function unflooredSellableAt(db, storeId, productId) {
  const comps = componentsOf(db, productId);
  if (!comps.length) return rawStockAt(db, storeId, productId);
  let min = Infinity;
  for (const c of comps) {
    const have = rawStockAt(db, storeId, c.id);
    const per  = c.qty > 0 ? c.qty : 1;
    min = Math.min(min, Math.floor(have / per));
  }
  // An empty recipe stays 0 rather than −Infinity or a negative: nothing can be
  // assembled, which is not the same fact as a debt.
  return Number.isFinite(min) ? min : 0;
}

function sellableAt(db, storeId, productId) {
  return Math.max(0, unflooredSellableAt(db, storeId, productId));
}

// True when this product row carries a component recipe. Cheap gate for callers
// that want to branch without paying for the full derivation.
function isBundle(db, productId) {
  return componentsOf(db, productId).length > 0;
}

// Every LIVE bundle product that lists `productId` among its components.
//
// This is what makes a bundle re-push when a component moves: a bundle sale (or
// any other component movement) touches component rows only, so without this the
// bundle's channel row is never marked dirty and the queue keeps re-confirming a
// stale figure.
//
// Soft-deleted rows are excluded — an is_active = 0 bundle is not being sold, and
// pushing for it would resurrect a listing the operator archived.
//
// The scan is over bundle rows only (the WHERE keeps it to rows that actually
// carry a recipe — 10 of them on the live catalogue today), then parsed in JS
// because the membership test is inside JSON. Small enough to run per component
// movement without a second thought.
function bundlesContaining(db, productId) {
  const pid = parseInt(productId, 10);
  if (!Number.isFinite(pid) || pid <= 0) return [];
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, bundle_items
        FROM store_products
       WHERE bundle_items IS NOT NULL
         AND TRIM(bundle_items) NOT IN ('', '[]')
         AND COALESCE(is_active, 1) = 1
    `).all();
  } catch (_) { return []; }
  const out = [];
  for (const r of rows) {
    if (r.id === pid) continue;                       // a bundle is never its own component
    if (parseBundleItems(r.bundle_items).some(c => c.id === pid)) out.push(r.id);
  }
  return out;
}

module.exports = { parseBundleItems, rawStockAt, componentsOf, sellableAt, unflooredSellableAt, isBundle, bundlesContaining };
