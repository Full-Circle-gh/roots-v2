#!/usr/bin/env node
/**
 * diagnose_till_channel_backfill.js — the numbers Ash's backfill decision needs.
 *
 *   Actions → Read-only prod query → scripts/diagnose_till_channel_backfill.js
 *
 * WHY THIS EXISTS. §44 (amended 2026-09-07) moved the till from
 * channel='manual' to channel='shop' with shop_entry_method='till', and
 * deliberately did NOT backfill: historical rows keep the 'manual' they were
 * written with. **Whether to backfill them is a separate decision and it is
 * Ash's.** That decision needs a count, and the count needs the live database.
 *
 * THE SESSION THAT DID THE MIGRATION REPORTED THE COUNT AS UNOBTAINABLE, and
 * that was wrong. It said "there is no database in this container" — true —
 * and stopped there, when `.github/workflows/ro-query.yml` exists for exactly
 * this: it runs one committed `scripts/diagnose_*.js` read-only against the
 * live box and prints the output to the Actions log. The blocker was a missing
 * script, not a missing capability. Recorded here rather than quietly fixed,
 * because "I cannot check that from here" is a claim worth being suspicious of.
 *
 * ── WHAT MAKES THIS QUESTION AWKWARD, AND WHY A SINGLE COUNT WOULD MISLEAD ──
 *
 * `channel='manual'` holds TWO different things that no single column tells
 * apart, which is the whole reason the decision is not obvious:
 *
 *   · till sales   — a counter sale rung up on /till before the migration
 *   · phone orders — a typed order for delivery or collection, genuinely
 *                    manual, which KEEPS channel='manual' and must not move
 *
 * `fulfillment_type='counter'` is the only reliable discriminator on past rows.
 * So this prints the split rather than a total: a backfill that moved every
 * `manual` row would drag legacy phone orders into the shop channel with it.
 *
 * IT ALSO CHECKS THE THINGS THAT WOULD MAKE A BACKFILL UNSAFE, rather than
 * only sizing it — whether any historical row already carries a
 * shop_entry_method, whether counter rows exist under other channels, and what
 * the migration's own cut-over looks like in the data. All read-only.
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);
console.log('sqlite: ' + db.prepare('select sqlite_version() v').get().v);
console.log('');

const rows = (sql, ...a) => db.prepare(sql).all(...a);
const one  = (sql, ...a) => db.prepare(sql).get(...a);
const hr   = (t) => console.log('\n══ ' + t + ' ' + '═'.repeat(Math.max(0, 66 - t.length)));
const table = (rs, cols) => {
  if (!rs.length) { console.log('   (none)'); return; }
  const w = cols.map((c) => Math.max(c.length, ...rs.map((r) => String(r[c] ?? '').length)));
  console.log('   ' + cols.map((c, i) => c.padEnd(w[i])).join('  '));
  console.log('   ' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rs) console.log('   ' + cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
};

// ════════════════════════════════════════════════════════════════════════════
// 1 — THE DECISION NUMBER, split by the only discriminator that works
// ════════════════════════════════════════════════════════════════════════════
hr('1 · channel=manual, split by fulfilment type');
console.log('   counter = a till sale. Anything else = a genuinely manual order');
console.log('   that KEEPS channel=manual and must not be moved.\n');
table(rows(`
  SELECT COALESCE(fulfillment_type,'(null)') AS fulfillment_type,
         COUNT(*)                            AS rows,
         MIN(date(placed_at))                AS first_seen,
         MAX(date(placed_at))                AS last_seen,
         ROUND(COALESCE(SUM(total),0), 2)    AS total_value
    FROM retail_orders
   WHERE COALESCE(channel,'') = 'manual'
   GROUP BY COALESCE(fulfillment_type,'(null)')
   ORDER BY rows DESC`), ['fulfillment_type', 'rows', 'first_seen', 'last_seen', 'total_value']);

const backfillable = one(`
  SELECT COUNT(*) n, ROUND(COALESCE(SUM(total),0),2) v
    FROM retail_orders
   WHERE COALESCE(channel,'') = 'manual' AND fulfillment_type = 'counter'`);
console.log(`\n   → A backfill of channel='manual' AND fulfillment_type='counter' would move`);
console.log(`     ${backfillable.n} row(s), ¥${backfillable.v}.`);

// ════════════════════════════════════════════════════════════════════════════
// 2 — Would a backfill overwrite anything? (safety, not size)
// ════════════════════════════════════════════════════════════════════════════
hr('2 · does any candidate row already carry a door?');
console.log('   A non-null shop_entry_method on a historical row would mean the');
console.log('   backfill is not writing into empty space. Expect zero.\n');
table(rows(`
  SELECT COALESCE(shop_entry_method,'(null)') AS shop_entry_method, COUNT(*) AS rows
    FROM retail_orders
   WHERE COALESCE(channel,'') = 'manual' AND fulfillment_type = 'counter'
   GROUP BY COALESCE(shop_entry_method,'(null)')`), ['shop_entry_method', 'rows']);

// ════════════════════════════════════════════════════════════════════════════
// 3 — Counter sales under OTHER channels: is 'manual' even the whole set?
// ════════════════════════════════════════════════════════════════════════════
hr('3 · every channel that has counter sales');
console.log('   If counter rows sit under channels other than manual/shop, a');
console.log('   backfill scoped to manual would leave the set half-migrated.\n');
table(rows(`
  SELECT COALESCE(NULLIF(channel,''),'(null/wechat-default)') AS channel,
         COUNT(*)             AS rows,
         MIN(date(placed_at)) AS first_seen,
         MAX(date(placed_at)) AS last_seen
    FROM retail_orders
   WHERE fulfillment_type = 'counter'
   GROUP BY COALESCE(NULLIF(channel,''),'(null/wechat-default)')
   ORDER BY rows DESC`), ['channel', 'rows', 'first_seen', 'last_seen']);

// ════════════════════════════════════════════════════════════════════════════
// 4 — The cut-over, as the data actually shows it
// ════════════════════════════════════════════════════════════════════════════
hr('4 · the shop channel since the migration');
console.log('   Confirms the till is writing what §44 says, and shows the split');
console.log('   between the two doors. source must be NULL for qr, manual for till.\n');
table(rows(`
  SELECT COALESCE(shop_entry_method,'(null)') AS door,
         COALESCE(source,'(null)')            AS source,
         COUNT(*)                             AS rows,
         MIN(date(placed_at))                 AS first_seen,
         MAX(date(placed_at))                 AS last_seen
    FROM retail_orders
   WHERE COALESCE(channel,'') = 'shop'
   GROUP BY COALESCE(shop_entry_method,'(null)'), COALESCE(source,'(null)')
   ORDER BY rows DESC`), ['door', 'source', 'rows', 'first_seen', 'last_seen']);

// ════════════════════════════════════════════════════════════════════════════
// 5 — Leftovers of the closed source='qr' defect
// ════════════════════════════════════════════════════════════════════════════
hr('5 · rows still carrying the retired source=qr');
console.log('   §44 closed the defect for NEW rows and did not backfill these.');
console.log('   They stay identifiable by shop_entry_method, which is checked here.\n');
const qr = one(`
  SELECT COUNT(*) n,
         SUM(CASE WHEN shop_entry_method = 'qr' THEN 1 ELSE 0 END) AS with_door
    FROM retail_orders WHERE source = 'qr'`);
console.log(`   ${qr.n} row(s) with source='qr'; ${qr.with_door || 0} of them also carry`);
console.log(`   shop_entry_method='qr', so they remain identifiable without it.`);
if (qr.n && qr.n !== (qr.with_door || 0)) {
  console.log(`   ⚠  ${qr.n - (qr.with_door || 0)} row(s) have source='qr' but NOT the door —`);
  console.log(`      those would be lost to a future source cleanup. Worth a look.`);
}

hr('done');
console.log('Nothing was written. The decision this feeds is Ash\'s: §44 rules');
console.log('that the till moves and says nothing about historical rows.');
