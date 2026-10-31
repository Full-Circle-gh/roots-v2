#!/usr/bin/env node
/**
 * Multi-period gzgrocery import.
 *
 * Stages:
 *   0. master_renames — rename SKU on a few existing master products
 *      (Guacamole EXT-1261354 → 3-170, Prebiotic Fiber （4-530）→ 4-530).
 *   1. master_joins — add EXISTING master products into a variant group
 *      anchored on ANOTHER existing master (so e.g. EXT-1229548 Maple
 *      Cinnamon Almond Butter joins the Almond Butter group anchored on
 *      EXT-1229660 Classic, as a flavor variant).
 *   2. new_variants — insert/update gzgrocery SKUs as new product rows
 *      grouped under their master parent.
 *   3. periods — one block per file. For each period, wipe prior rows
 *      tagged with that period and re-insert the sales projection into
 *      sales_entries (channel='gzgrocery'). Idempotent.
 *
 * sku_aliases — at sales-lookup time, if a gzgrocery SKU is in the
 * alias map, look up the aliased SKU instead. Used for Quinoa Patties
 * (gzgrocery 3-50 → master 2-2).
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');
const DRY = process.argv.includes('--dry-run');

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
db.pragma('journal_mode = WAL');

const SRC = JSON.parse(fs.readFileSync(path.join(__dirname, 'gzgrocery_import.json'), 'utf8'));
const { channel, master_renames = {}, master_joins = [], sku_aliases = {},
        dissolve_groups = [], new_variants = [], periods = [] } = SRC;

const findBySku = db.prepare('SELECT id, sku, name_en, name_cn, variant_group_id, variant_label FROM products WHERE sku = ?');
const renameSku = db.prepare('UPDATE products SET sku = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
// SQLite treats "..." as an identifier, NOT a string literal — must use single
// quotes for the empty-string sentinel inside NULLIF.
const setGroup  = db.prepare("UPDATE products SET variant_group_id = ?, variant_label = COALESCE(NULLIF(?,''), variant_label), updated_at = CURRENT_TIMESTAMP WHERE id = ?");
const insertProd = db.prepare(`INSERT INTO products
  (sku, name_en, name_cn, sell_price, status, is_active, variant_group_id, variant_label, notes)
  VALUES (?, ?, ?, ?, 'Active', 1, ?, ?, ?)`);
const updateProd = db.prepare(`UPDATE products SET
  name_en = COALESCE(NULLIF(?,''), name_en),
  name_cn = COALESCE(NULLIF(?,''), name_cn),
  sell_price = COALESCE(NULLIF(?, 0), sell_price),
  variant_group_id = ?, variant_label = ?, notes = COALESCE(NULLIF(?,''), notes),
  updated_at = CURRENT_TIMESTAMP
  WHERE id = ?`);

// Resolve a parent's group_id; if it has none, use parent's own id and
// also set its variant_group_id so siblings can find it.
function resolveGroup(parentSku) {
  const parent = findBySku.get(parentSku);
  if (!parent) return null;
  if (parent.variant_group_id) return { gid: parent.variant_group_id, parent };
  // Anchor: parent.id becomes the group_id.
  setGroup.run(parent.id, '', parent.id);
  return { gid: parent.id, parent };
}

const stats = {
  renamesDone: 0, renamesSkipped: 0,
  joinsDone: 0, joinsSkipped: 0,
  variantsInserted: 0, variantsUpdated: 0, variantsSkipped: 0,
  salesInserted: 0, salesSkipped: 0, periodsProcessed: 0,
};

const tx = db.transaction(() => {
  // ── Stage -1: dissolve existing groups when restructuring (e.g. switching
  // from a flavor-axis combined group into per-flavor groups). Members
  // listed by SKU get their group_id + label cleared. Run BEFORE rename
  // so SKUs match what's in the snapshot.
  for (const g of dissolve_groups) {
    for (const sku of (g.parent_skus || [])) {
      const row = findBySku.get(sku);
      if (!row || !row.variant_group_id) continue;
      const gid = row.variant_group_id;
      const r = db.prepare('UPDATE products SET variant_group_id = NULL, variant_label = NULL, updated_at = CURRENT_TIMESTAMP WHERE variant_group_id = ?').run(gid);
      console.log(`  ↻ dissolved group ${gid} (${r.changes} members) — ${g.reason}`);
    }
  }

  // ── Stage 0: rename master SKUs
  for (const [oldSku, newSku] of Object.entries(master_renames)) {
    const row = findBySku.get(oldSku);
    if (!row) { console.log(`  ⚠ rename skip — '${oldSku}' not in DB`); stats.renamesSkipped++; continue; }
    // If a different product already owns the target SKU, skip (don't trample).
    const occupant = findBySku.get(newSku);
    if (occupant && occupant.id !== row.id) {
      console.log(`  ⚠ rename skip — '${newSku}' is already owned by id=${occupant.id} '${occupant.name_en}'`);
      stats.renamesSkipped++; continue;
    }
    if (row.sku !== newSku) {
      renameSku.run(newSku, row.id);
      console.log(`  ✓ renamed sku '${oldSku}' → '${newSku}' (id=${row.id})`);
      stats.renamesDone++;
    } else { stats.renamesSkipped++; }
  }

  // ── Stage 1: master_joins (existing master joining a variant group)
  for (const j of master_joins) {
    const row = findBySku.get(j.sku);
    if (!row) { stats.joinsSkipped++; continue; }
    const grp = resolveGroup(j.parent);
    if (!grp) { stats.joinsSkipped++; continue; }
    setGroup.run(grp.gid, j.label || '', row.id);
    console.log(`  ✓ joined ${j.sku} → group ${grp.gid} (parent ${j.parent}) label='${j.label}'`);
    stats.joinsDone++;
  }

  // ── Stage 2: new variants (gzgrocery SKUs as new products in groups)
  for (const v of new_variants) {
    const grp = resolveGroup(v.parent_sku);
    if (!grp) {
      console.log(`  ⚠ variant skip — parent ${v.parent_sku} not in DB`);
      stats.variantsSkipped++; continue;
    }
    const existing = findBySku.get(v.sku);
    if (existing) {
      updateProd.run(v.name_en, v.name_cn, v.sell_price || 0, grp.gid, v.variant_label, v.notes, existing.id);
      stats.variantsUpdated++;
    } else {
      insertProd.run(v.sku, v.name_en, v.name_cn, v.sell_price || 0, grp.gid, v.variant_label, v.notes);
      stats.variantsInserted++;
    }
  }

  // ── Stage 3: per-period sales projection
  const findId = db.prepare('SELECT id FROM products WHERE sku = ?');
  for (const period of periods) {
    const refTagPrefix = `[gzgrocery:${period.from}..${period.to}:`;
    // Wipe prior import for this exact period (idempotent re-runs)
    db.prepare(`DELETE FROM sales_entries WHERE channel = 'gzgrocery' AND notes LIKE ?`)
      .run(refTagPrefix + '%');
    const insertSale = db.prepare(`INSERT INTO sales_entries
      (date, product_id, product_name, channel, qty, unit_price, total, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of period.sales) {
      // Apply sku alias if defined
      const lookupSku = sku_aliases[s.sku] || s.sku;
      const row = findId.get(lookupSku);
      if (!row) { stats.salesSkipped++; continue; }
      const display = s.name_en || s.name_cn || s.sku;
      const tag = `${refTagPrefix}${s.sku}]`;
      const extras = [];
      if (s.discount && s.discount > 0) extras.push(`Discount: ${(s.discount*100).toFixed(0)}%`);
      if (s.price_orig && s.price_orig > 0 && s.price_orig !== s.price) extras.push(`Orig ¥${s.price_orig}`);
      if (lookupSku !== s.sku) extras.push(`(aliased from ${s.sku})`);
      insertSale.run(period.midpoint, row.id, display, channel, s.qty, s.price || 0, s.subtotal || 0,
                     `${tag} ${extras.join(' · ')}`.trim());
      stats.salesInserted++;
    }
    stats.periodsProcessed++;
  }
});

if (DRY) {
  console.log(`DRY-RUN — would import ${periods.length} period(s):`);
  let total = 0;
  for (const p of periods) {
    console.log(`  ${p.from} → ${p.to}: ${p.sales.length} rows`);
    total += p.sales.length;
  }
  console.log(`  Total sales rows: ${total}`);
  console.log(`  Master renames:   ${Object.keys(master_renames).length}`);
  console.log(`  Master joins:     ${master_joins.length}`);
  console.log(`  New variants:     ${new_variants.length}`);
  console.log(`  Aliases:          ${Object.keys(sku_aliases).length}  (${Object.entries(sku_aliases).map(([a,b]) => a+'→'+b).join(', ')})`);
  // Resolution preview: how many would resolve after variant insertion
  const allSkus = new Set();
  for (const p of periods) for (const s of p.sales) allSkus.add(s.sku);
  let resolvable = 0, missing = [];
  for (const sku of allSkus) {
    const lookup = sku_aliases[sku] || sku;
    if (findBySku.get(lookup)) { resolvable++; continue; }
    if (new_variants.find(v => v.sku === lookup)) { resolvable++; continue; }
    if (Object.values(master_renames).includes(lookup)) { resolvable++; continue; }
    missing.push(sku);
  }
  console.log(`  Distinct SKUs in sales: ${allSkus.size}`);
  console.log(`  Will resolve after import: ${resolvable}`);
  if (missing.length) console.log(`  ⚠ Will NOT resolve: ${missing.join(', ')}`);
  process.exit(0);
}

tx();
console.log(`✅ gzgrocery import complete`);
console.log(`  Master SKU renames:    ${stats.renamesDone} (${stats.renamesSkipped} skipped)`);
console.log(`  Group joins:           ${stats.joinsDone} (${stats.joinsSkipped} skipped)`);
console.log(`  Variants inserted:     ${stats.variantsInserted}`);
console.log(`  Variants updated:      ${stats.variantsUpdated}`);
console.log(`  Variants skipped:      ${stats.variantsSkipped}`);
console.log(`  Periods processed:     ${stats.periodsProcessed}`);
console.log(`  Sales rows inserted:   ${stats.salesInserted}`);
console.log(`  Sales skipped:         ${stats.salesSkipped}`);
