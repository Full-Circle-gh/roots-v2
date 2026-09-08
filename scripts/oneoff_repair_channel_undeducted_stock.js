#!/usr/bin/env node
/**
 * One-off: take the stock that channel orders sold and never deducted.
 *
 * Ash's instruction, 2026-09-08, on the list of findings from PR #393: "2-6 do
 * all those" — item 2 being "the stock already lost is still wrong on the shelf".
 *
 * ── WHAT HAPPENED ─────────────────────────────────────────────────────────
 * A channel order line that resolved to no product was skipped by the ingest's
 * deduction loop (routes/{eleme,meituan}-internal.js). The units left the shop;
 * the count never moved. 54 lines are in that state, all time
 * (scripts/diagnose_channel_stock_damage.js, ro-query run 34233754687).
 *
 * The over-count is not historical. It is the number pushed back to Eleme and
 * Meituan on the next sync, so every one of these keeps causing oversells until
 * it is corrected.
 *
 * ── WHAT THIS REPAIRS, AND WHAT IT REFUSES TO ─────────────────────────────
 * ONLY the lines whose product is decided by a code, never by a name. The line
 * carries an "N-N" SKU token — either as its own `sku` or written into the
 * listing title — and exactly one store_products row holds that SKU. There is
 * no judgement in that: the code says which product. PR #393 taught the Eleme
 * resolver to read those tokens, so these lines would resolve today and their
 * orders simply predate the fix.
 *
 * Everything else is left alone and printed:
 *   • no code in the title, name matches several products or none → which
 *     product the listing means is the merchant's call, and a repair that
 *     guessed would be worse than the over-count it fixed
 *   • a code matching no product, and not one of the three verified aliases
 *     below — reported with the product it WOULD name, so it can be corroborated
 *     the way those three were, rather than acted on because it looks right
 *   • cutlery and heating options (无需餐具, 加热 …) — not products at all, and
 *     nothing should ever be deducted for them
 *   • VOID orders. channel_stock_restored = 1, or a cancelled/refunded status,
 *     says the stock is deliberately NOT out of our count. "Repairing" one
 *     would take units for an order nobody was charged for.
 *
 * ── WHAT IT WRITES, per repaired line ─────────────────────────────────────
 *   retail_order_items   product_id, name_cn, name_en, sku  ← the line stops
 *                        reading as unresolved, so reports stop under-counting
 *   retail_store_stock   physical_qty − (qty × pack_units)
 *   retail_stock_ledger  one row, the channel's own reason ('eleme_order' /
 *                        'meituan_order') so every existing reader counts it as
 *                        the channel deduction it should always have been, with
 *                        ref_table/ref_id pointing at the order — provenance the
 *                        ingest itself never wrote (lib/inventory.js PROVENANCE)
 *                        and a note saying plainly that this was a backfill.
 *
 * unit_cost_at_sale is deliberately NOT filled. The only cost available now is
 * today's, and stamping it would claim to be the snapshot taken at the sale.
 * Margin on these lines stays honestly unknown.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 * It does not push the corrected numbers to the platforms. It writes no queue
 * rows, and it does not load lib/inventory (which would open the live database a
 * second time and run database.js's whole bootstrap from inside a repair). The
 * level-triggered drift sweep — lib/channel-drift-sweep.js, the backstop the
 * daemons already run — is what reconciles the shelf to the channels, and it
 * will carry these corrections out on its own next pass.
 *
 * IDEMPOTENT. Every line is re-checked at write time and skipped if it has
 * since acquired a product_id, or if a ledger row for this order and product
 * already exists. A second run reports "nothing to do".
 *
 * Run ON THE SERVER, against data/roots.db. Default is dry-run.
 *
 *   node scripts/oneoff_repair_channel_undeducted_stock.js          # prints the plan, writes nothing
 *   node scripts/oneoff_repair_channel_undeducted_stock.js --apply  # write
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const CHANNEL_REASON = { eleme: 'eleme_order', meituan: 'meituan_order' };

// ── THREE CODES THE PLATFORM AND THE CATALOGUE WRITE DIFFERENTLY ────────────
// Meituan sends "1-240s"; the catalogue holds "S(1-240)". The first dry run of
// this script (oneoff run 34234515945) printed every such pair with the product
// it would have chosen, and each one is corroborated by a SECOND, INDEPENDENT
// signal — the product's name matches the listing's, with no reference to the
// code at all:
//
//   3-251s → S(3-251)  #351 Whole-Wheat Pita (Frozen)  ← 皮塔饼（一个）Whole Wheat Pita（～80g）
//   1-220s → S(1-220)  #354 Pickled Onions             ← （小）腌红洋葱 Onion Pickles（20g）
//   1-240s → S(1-240)  #355 Harissa Chilli Paste       ← （小）哈里萨辣椒酱 Harrisa（～30g）
//
// Two signals agreeing is not an inference any more, so these deduct. An
// EXPLICIT LIST of three, not the general rule "strip a trailing s and wrap in
// S(…)": the general rule would also fire on codes nobody has looked at, and
// each of these was read one at a time against the product it names. A fourth
// pair appearing later gets the same treatment — printed by the dry run first,
// added here only once its name corroborates it.
//
// The LIVE resolver still cannot read these, so new orders carrying them will
// keep missing until routes/*-internal.js learns the same thing. That is a
// separate change; this one is about the stock already lost.
const VERIFIED_CODE_ALIASES = {
  '3-251s': 'S(3-251)',
  '1-220s': 'S(1-220)',
  '1-240s': 'S(1-240)',
};

console.log(`db: ${dbPath}`);
console.log(WRITE ? 'MODE: APPLY — this run writes\n' : 'MODE: dry run — nothing is written\n');

// ── Every channel line that resolved to nothing ──────────────────────────────
const lines = db.prepare(`
  SELECT oi.id AS line_id, oi.order_id, oi.name_cn, oi.name_en, oi.qty, oi.sku,
         COALESCE(oi.pack_units, 1) AS pack_units,
         o.order_no, o.channel, o.status, o.placed_at, o.store_id,
         o.channel_stock_restored
    FROM retail_order_items oi
    JOIN retail_orders o ON o.id = oi.order_id
   WHERE oi.product_id IS NULL
     AND o.channel IN ('eleme','meituan')
   ORDER BY o.id
`).all();

const bySku = db.prepare('SELECT id, name_cn, name_en, sku, is_active FROM store_products WHERE sku = ?');

const plan = [];
const skipped = [];
// The "S(1-240)" family, collected and reported but never acted on. Meituan
// sends a code like "1-240s" and the catalogue holds "S(1-240)" — the same
// thing written two ways, on the evidence of the listing names beside them.
// Reporting a correspondence is free; deducting on an inferred one is not.
const suffixCandidates = [];

for (const l of lines) {
  const name = l.name_en || l.name_cn || '(unnamed)';
  const want = (parseInt(l.qty, 10) || 0) * (parseInt(l.pack_units, 10) || 1);
  const voided = l.channel_stock_restored === 1 || l.status === 'cancelled' || l.status === 'refunded';
  if (voided) { skipped.push({ l, name, why: 'order is void — must not deduct' }); continue; }
  if (want <= 0) { skipped.push({ l, name, why: 'line has no quantity' }); continue; }

  const token = l.sku || (String(name).match(/\d+-\d+/) || [])[0] || null;
  if (!token) { skipped.push({ l, name, why: 'no code — needs a product map row (a decision)' }); continue; }

  const hits = bySku.all(token);
  if (hits.length === 1) { plan.push({ l, name, want, token, product: hits[0] }); continue; }
  if (hits.length > 1) { skipped.push({ l, name, why: `code ${token} matches ${hits.length} products` }); continue; }

  // No product holds that code as written. One of the three verified aliases?
  const alias = VERIFIED_CODE_ALIASES[String(token)];
  if (alias) {
    const viaAlias = bySku.all(alias);
    if (viaAlias.length === 1) {
      plan.push({ l, name, want, token: alias, viaAlias: token, product: viaAlias[0] });
      continue;
    }
    // The alias was verified against a product that is no longer the only one
    // holding that SKU. Do not deduct on a list entry the catalogue has moved on
    // from — say so instead.
    skipped.push({ l, name, why: `verified alias ${token} → ${alias} now matches ${viaAlias.length} products — re-check it` });
    continue;
  }

  // An "N-Ns" shape nobody has confirmed yet. Report the product it WOULD name,
  // so a person can corroborate it the way the three above were.
  const core = (String(token).match(/\d+-\d+/) || [])[0];
  if (core && /^\d+-\d+s$/i.test(token)) {
    const alt = bySku.all(`S(${core})`);
    if (alt.length === 1) suffixCandidates.push({ l, name, want, token, alt: alt[0] });
  }
  skipped.push({ l, name, why: `code ${token} matches no product` });
}

// ── The plan ─────────────────────────────────────────────────────────────────
console.log('='.repeat(78));
console.log(`REPAIRABLE — ${plan.length} line(s), each decided by a code and not a name\n`);
const net = new Map();
for (const p of plan) {
  const cur = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
    .get(p.l.store_id, p.product.id);
  const have = cur ? cur.physical_qty : 0;
  console.log(`  ${p.l.order_no} [${p.l.channel}] line #${p.l.line_id}  ${p.l.placed_at}`);
  console.log(`    "${p.name}" x${p.l.qty} pack=${p.l.pack_units}  → code ${p.token}` +
              (p.viaAlias ? `  (platform sent "${p.viaAlias}" — verified alias)` : ''));
  console.log(`    product #${p.product.id} ${p.product.name_en}${p.product.is_active ? '' : '  (INACTIVE)'}`);
  console.log(`    shelf ${have} − ${p.want}`);
  const k = `${p.l.store_id}:${p.product.id}`;
  net.set(k, (net.get(k) || 0) + p.want);
}
if (net.size) {
  console.log('\n  Net per product:');
  for (const [k, units] of net) {
    const [storeId, productId] = k.split(':');
    const cur = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(storeId, productId);
    const have = cur ? cur.physical_qty : 0;
    const p = db.prepare('SELECT name_en FROM store_products WHERE id = ?').get(productId);
    const after = have - units;
    console.log(`    store ${storeId} #${productId} ${p ? p.name_en : '?'}: ${have} − ${units} = ${after}` +
                (after < 0 ? '   ⚠ WOULD GO NEGATIVE' : ''));
  }
}

// A shelf that would go below zero means this repair is not the whole story for
// that product — refuse rather than write a number nobody has looked at.
let negative = false;
for (const [k, units] of net) {
  const [storeId, productId] = k.split(':');
  const cur = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(storeId, productId);
  if ((cur ? cur.physical_qty : 0) - units < 0) negative = true;
}
if (negative) {
  console.error('\nREFUSING: at least one product would go below zero. That is a real signal — the');
  console.error('shelf is already short of what these orders took — but it is not something this');
  console.error('script should decide alone. Look at those products first.');
  process.exit(1);
}

// ── What is deliberately left ────────────────────────────────────────────────
console.log('\n' + '='.repeat(78));
console.log(`LEFT ALONE — ${skipped.length} line(s)\n`);
const byWhy = new Map();
for (const s of skipped) {
  if (!byWhy.has(s.why)) byWhy.set(s.why, []);
  byWhy.get(s.why).push(s);
}
for (const [why, rows] of byWhy) {
  console.log(`  ${why}  (${rows.length})`);
  for (const r of rows.slice(0, 8)) console.log(`    ${r.l.order_no} "${r.name}" x${r.l.qty}`);
  if (rows.length > 8) console.log(`    … and ${rows.length - 8} more`);
  console.log('');
}

if (suffixCandidates.length) {
  console.log('='.repeat(78));
  console.log(`REPORTED, NOT REPAIRED — ${suffixCandidates.length} line(s) where the platform's code and`);
  console.log('the catalogue\'s look like the same thing written two ways ("1-240s" vs "S(1-240)").');
  console.log('If that correspondence is real, these can be repaired too — but it is an inference');
  console.log('about how SKUs are written here, and inferences do not move stock.\n');
  for (const c of suffixCandidates) {
    console.log(`  ${c.l.order_no} "${c.name}" x${c.l.qty}`);
    console.log(`    code ${c.token}  →  would be product #${c.alt.id} ${c.alt.name_en}  (sku ${c.alt.sku})`);
  }
  console.log('');
}

if (!plan.length) { console.log('Nothing to repair.'); process.exit(0); }
if (!WRITE) {
  console.log('='.repeat(78));
  console.log('Dry run — nothing written. Re-run with --apply to make the changes above.');
  process.exit(0);
}

// ── Write ────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().slice(0, 10);
const apply = db.transaction(() => {
  let repaired = 0, alreadyDone = 0;
  for (const p of plan) {
    // Re-checked HERE, inside the transaction, not trusted from the survey
    // above: a run that repeats must not deduct twice.
    const live = db.prepare('SELECT product_id FROM retail_order_items WHERE id = ?').get(p.l.line_id);
    if (!live || live.product_id != null) { alreadyDone++; continue; }
    const seen = db.prepare(`
      SELECT 1 FROM retail_stock_ledger
       WHERE ref_table = 'retail_orders' AND ref_id = ? AND product_id = ? AND reason = ?
       LIMIT 1
    `).get(p.l.order_id, p.product.id, CHANNEL_REASON[p.l.channel]);
    if (seen) { alreadyDone++; continue; }

    db.prepare(`
      UPDATE retail_order_items
         SET product_id = ?, name_cn = ?, name_en = ?, sku = ?
       WHERE id = ? AND product_id IS NULL
    `).run(p.product.id, p.product.name_cn, p.product.name_en, p.token, p.l.line_id);

    const cur = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
      .get(p.l.store_id, p.product.id);
    const have = cur ? cur.physical_qty : 0;
    const after = have - p.want;
    if (cur) {
      db.prepare('UPDATE retail_store_stock SET physical_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?')
        .run(after, p.l.store_id, p.product.id);
    } else {
      db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?, ?, ?)')
        .run(p.l.store_id, p.product.id, after);
    }
    db.prepare(`
      INSERT INTO retail_stock_ledger
        (store_id, product_id, delta, reason, ref_table, ref_id, balance_after,
         actor_user_id, channel, note)
      VALUES (?, ?, ?, ?, 'retail_orders', ?, ?, NULL, ?, ?)
    `).run(p.l.store_id, p.product.id, -p.want, CHANNEL_REASON[p.l.channel],
           p.l.order_id, after, p.l.channel,
           `BACKFILL ${stamp}: ${p.l.channel} ${p.l.order_no} (placed ${p.l.placed_at}) sold ` +
           `${p.name} x${p.l.qty} and never deducted — line resolved on code ${p.token}` +
           (p.viaAlias ? ` (platform sent "${p.viaAlias}")` : ''));
    repaired++;
  }
  return { repaired, alreadyDone };
});

const { repaired, alreadyDone } = apply();
console.log('='.repeat(78));
console.log(`WROTE: ${repaired} line(s) repaired` + (alreadyDone ? `, ${alreadyDone} already done (skipped)` : ''));
console.log('');
console.log('The shelf now says what it should. The corrected numbers reach Eleme and Meituan on');
console.log('the drift sweep\'s next pass (lib/channel-drift-sweep.js) — nothing is queued here.');
console.log('');
console.log('AFTER — the products touched:');
for (const [k] of net) {
  const [storeId, productId] = k.split(':');
  const cur = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(storeId, productId);
  const p = db.prepare('SELECT name_en FROM store_products WHERE id = ?').get(productId);
  console.log(`  store ${storeId} #${productId} ${p ? p.name_en : '?'}: ${cur ? cur.physical_qty : '(no row)'}`);
}
