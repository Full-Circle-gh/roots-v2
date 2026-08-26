'use strict';

// The one place a Meituan mapping name is written, and the gate it must pass.
//
// WHY THIS IS A LIB AND NOT FOUR LINES IN THE ROUTE
// ------------------------------------------------
// Until 2026-08-26 the rule "a mapping name must be one the channel supplied"
// lived in the CLIENT — public/retail-admin/11-meituan.js checks it in
// mtNameCommit before it will save a typed name, and Match names only ever
// applies strings out of its own `_listings`. Both are real gates and neither is
// the route's. `routes/meituan-admin.js` took `meituanName`, trimmed it, and
// wrote it, so the rule held only for callers who chose to honour it.
//
// That is not a theoretical gap. `_listings` is a CLIENT-SIDE array, and the
// Paste escape hatch (`mtPasteApply`) assigns pasted text straight into it —
// at which point every downstream check agrees the pasted string is a catalogue
// name, because on the client it now is one. On 2026-06-22 that wrote 138
// mappings in under four minutes against a store whose scrape had failed that
// day, and one of them — `Recanati Winery Yasmin White - 2023` on product 254 —
// matches no listing this store has ever reported. It then produced a failing
// push every two hours for two months and held the store's drift alarm shut.
// See docs/meituan-findings.md findings 10 and 11.
//
// So the check moves to the write itself, where no caller can decline it, and
// it reads `meituan_listings` — the table only the scraping daemon fills. A
// pasted name cannot get into that table, which is precisely the point.
//
// §30 rule 3: a value binding our record to an external system is SELECTED from
// values that system supplied, never typed and never composed. This is that rule
// stated as code instead of as a convention.

// The catalogue's state for one store, so a refusal can say how old the thing it
// checked against is rather than only that it failed.
function catalogueState(db, storeCode) {
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS n, MAX(scraped_at) AS at
         FROM meituan_listings WHERE store_code = ?`
    ).get(storeCode);
    return { count: Number((r && r.n) || 0), scrapedAt: (r && r.at) || null };
  } catch (_) {
    return { count: 0, scrapedAt: null };
  }
}

// Is this exact string one the channel reported for this store?
//
// Exact, and deliberately not a fuzzy or normalised comparison. Every other
// matcher on this system is some flavour of substring, and each one of them can
// resolve a name onto a listing nobody chose — findings 1 and 11. The stored
// value must be the listing's own title, byte for byte, because that is the only
// form a later reader can check.
function catalogueHas(db, storeCode, name) {
  try {
    return !!db.prepare(
      `SELECT 1 FROM meituan_listings WHERE store_code = ? AND listing_name = ? LIMIT 1`
    ).get(storeCode, name);
  } catch (_) {
    return false;
  }
}

// Operator-facing refusal text.
//
// ENGLISH ON BOTH SIDES, on purpose. §30 rule 3 and
// docs/tacet-delivery-vocabulary.md Rules 4 forbid composing new Chinese; no
// sourced pair exists for either of these sentences. They live here rather than
// in the client because the ROUTE is what refuses, and a refusal that only the
// admin screen can phrase is a refusal every other caller receives bare.
// 11-meituan.js MT_PENDING_CN carries the same convention for the same reason.
const REFUSAL_PENDING_CN = {
  notInCatalogue: (storeCode, at) =>
    `That name is not one of the listings read from ${storeCode}. ` +
    `The catalogue was last read ${at ? 'on ' + at + ' UTC' : 'never'}, so it may be out of date — ` +
    `refresh the catalogue on the Meituan page, then pick the name from the list.`,
  notRead: (storeCode) =>
    `No listings have been read from ${storeCode} yet, so this name cannot be checked and was not saved. ` +
    `Refresh the catalogue on the Meituan page, then pick the name from the list.`,
};

// THE gate, as one function, because there are now two tables whose name column
// means "a listing on this store" — meituan_product_map.meituan_name and
// meituan_bundles.meituan_name — and two callers asking the same question.
//
// It lives here rather than being written twice for the reason the rest of this
// file exists: a rule stated in two places is a rule that will be true in one of
// them. `applyMapName` below calls it, and so does the bundles route.
//
// Returns null when the name may be written, or the refusal to hand back:
//   { code, message, catalogue }
//
// Two refusals, not one, because they are different facts about the world and
// the operator does different things about them. §30 rule 4 wants a check that
// cannot run to say so rather than return a verdict — so an unread catalogue
// gets its own answer instead of being reported as "wrong name", which is a
// verdict this code has no grounds to reach.
//
// There is no override, no force flag and no bypass parameter: a name that
// cannot be verified is not written, and the way forward is to make the
// catalogue current, not to argue with it.
function verifyName(db, storeCode, name) {
  const cat = catalogueState(db, storeCode);
  if (!cat.count) {
    return { code: 'catalogue_not_read',
             message: REFUSAL_PENDING_CN.notRead(storeCode), catalogue: cat };
  }
  if (!catalogueHas(db, storeCode, name)) {
    return { code: 'name_not_in_catalogue',
             message: REFUSAL_PENDING_CN.notInCatalogue(storeCode, cat.scrapedAt), catalogue: cat };
  }
  return null;
}

// Write (or clear) a product's mapping name for one store.
//
// Returns a plain result object rather than touching HTTP, so the whole
// behaviour — gate, write, audit payload — can be driven headless against a
// fixture. routes/meituan-admin.js is the only caller and turns this into a
// response; it adds no rule of its own.
//
//   { ok: true,  deleted: true }                    — name cleared, mapping removed
//   { ok: true,  specCleared: bool }                — name written
//   { ok: false, code, message, catalogue }         — refused, nothing written
//
// `audit` is called ONLY after a write actually happened, and only for a real
// change. It receives the payload the caller should hand to its audit writer.
function applyMapName(db, opts) {
  const {
    productId, storeId, storeCode,
    meituanName, syncEnabled,
    source = 'unknown',          // caller-declared: 'match_names' | 'manual' | 'remove'
    audit = null,
  } = opts || {};

  const name = String(meituanName == null ? '' : meituanName).trim();

  // What the mapping says NOW, read before anything changes it, so the audit
  // entry can carry the previous value. Nothing else in the system keeps one:
  // meituan_product_map is last-write-wins with no history, which is why the
  // wine's original name could not be recovered (findings 3 and 11).
  const cur = db.prepare(
    `SELECT meituan_name FROM meituan_product_map
      WHERE product_id = ? AND retail_store_id = ?
      ORDER BY spec_key = '' DESC, id LIMIT 1`
  ).get(productId, storeId);
  const prev = cur ? String(cur.meituan_name || '').trim() : null;

  // ── Clearing stays possible, and is checked FIRST ─────────────────────────
  // An empty name means "unmap this product", which is a removal, not a claim
  // about a listing — so there is nothing to verify and the gate must not stand
  // in its way. Putting this before the gate is what keeps a product with an
  // unverifiable stored name (product 254 today) removable rather than frozen.
  if (!name) {
    const r = db.prepare(
      'DELETE FROM meituan_product_map WHERE product_id = ? AND retail_store_id = ?'
    ).run(productId, storeId);
    if (audit && r.changes > 0) {
      audit({ action: 'meituan_map_clear', productId, storeCode,
              from: prev, to: null, source, rows: r.changes });
    }
    return { ok: true, deleted: true };
  }

  // ── The gate ──────────────────────────────────────────────────────────────
  // The rule itself is verifyName above — shared with the bundles route, which
  // asks the same question about the same table. Its two refusals and the
  // reasoning behind them are documented there.
  const refusal = verifyName(db, storeCode, name);
  if (refusal) return { ok: false, ...refusal };

  // ── The write, unchanged from what the route did before ───────────────────
  // A chosen 规格 belongs to the listing it was chosen on. Point the product at a
  // different listing and every option claim is about a listing it no longer
  // syncs to, so drop them rather than push stock at a stranger's option.
  // Same rule as eleme-admin.js mergeMapFields().
  const renamed = cur && prev !== name;

  db.transaction(() => {
    if (renamed) {
      db.prepare(`DELETE FROM meituan_product_map
                   WHERE product_id = ? AND retail_store_id = ? AND spec_key <> ''`)
        .run(productId, storeId);
    }
    // The name and the switch belong to the product on this store, so they go to
    // every claim it still holds.
    db.prepare(`UPDATE meituan_product_map
                   SET meituan_name = ?, store_code = ?, sync_enabled = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE product_id = ? AND retail_store_id = ?`)
      .run(name, storeCode, syncEnabled ? 1 : 0, productId, storeId);
    const left = db.prepare('SELECT COUNT(*) AS n FROM meituan_product_map WHERE product_id = ? AND retail_store_id = ?')
                   .get(productId, storeId).n;
    if (!left) {
      db.prepare(`
        INSERT INTO meituan_product_map
          (product_id, retail_store_id, store_code, meituan_name, spec_key, units_per_pack, sync_enabled, updated_at)
        VALUES (?, ?, ?, ?, '', 1, ?, CURRENT_TIMESTAMP)
      `).run(productId, storeId, storeCode, name, syncEnabled ? 1 : 0);
    }
  })();

  // Recorded whether or not the string changed: "someone re-confirmed this
  // mapping" and "nobody has touched it since June" are different facts, and
  // only one of them is currently knowable about any mapping on this system.
  if (audit) {
    audit({ action: prev == null ? 'meituan_map_create' : 'meituan_map_name',
            productId, storeCode, from: prev, to: name, source,
            syncEnabled: syncEnabled ? 1 : 0, specCleared: !!renamed });
  }

  return { ok: true, specCleared: !!renamed };
}

module.exports = { applyMapName, verifyName, catalogueState, catalogueHas, REFUSAL_PENDING_CN };
