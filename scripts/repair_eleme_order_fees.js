#!/usr/bin/env node
/**
 * Backfill the packaging and delivery fees on the two real Eleme orders.
 *
 * PR #200 taught the Eleme ingest to write foodInfo.packageFee and
 * foodInfo.deliveryFee into packing_fee / shipping_fee. It deliberately did not
 * touch history, so the only two real Eleme orders we hold still read 0 on both
 * columns — as if the customer had paid nothing to have the order packed or
 * brought to them. This writes those two rows, and nothing else, ever.
 *
 *   id 1538  EL20260901417897   packing_fee 1.5   shipping_fee 18
 *   id 1502  EL20260831339491   packing_fee 1.5   shipping_fee 18
 *                               channel_commission 14.95
 *                               channel_settle_amount 126.05
 *
 * 1502 also holds NULL for both economics columns while its payload carries
 * platformServiceFee 14.95 and expectedIncome 126.05, and 141 - 14.95 = 126.05.
 * Those are filled in the same pass rather than left for a second write against
 * the same two rows.
 *
 * WHERE THE NUMBERS COME FROM. raw_payload, not detail_json. detail_json is
 * 222 chars on both rows — the archive predates the fee fields being parsed, so
 * its packagingFee / deliveryFee are null and there is nothing to read. The raw
 * platform envelopes are 15271 and 15084 chars, both under safeJson's 20000-char
 * cap, so neither is truncated and both parse. moneyDivisor is read from
 * detail_json (which does carry it) and applied.
 *
 * THE GOODS FIGURE IS THE ROW'S OWN LINES, and this is the trap that has caught
 * every reader of this data so far. foodInfo.groups[].items[].total already
 * includes PER-FOOD packaging — Eleme prices 打包费 per item as well as per
 * order — so summing the payload's item totals double-counts the packaging and
 * lands 1.5 short of reconciling. scripts/diagnose_channel_money_gaps.js still
 * does exactly that and prints "does NOT reconcile (gap 1.5)" on both rows for
 * that reason alone. Our stored retail_order_items.line_total is the
 * packaging-free figure, and it is what subtotal sums, so it is what this uses.
 * (Correcting the diagnostic is a separate one-line change, deliberately not
 * made here — this script must not depend on a file it also edits.)
 *
 * SAFETY, in the order it runs:
 *   1. Scope is a hardcoded id IN (1502, 1538) and nothing else. NEVER
 *      `WHERE packing_fee = 0`: since PR #200 deployed, 0 is a value the ingest
 *      writes for a genuinely fee-free order, so it no longer means "never
 *      recorded" and can no longer be used to find rows needing this.
 *   2. Each row's order_no must match the one named here, or it aborts. An id
 *      that now points at a different order cannot be written by accident.
 *   3. Every figure is recomputed from the payload and must equal the value
 *      named above to the cent. A different divisor, a moved field or a
 *      re-archived payload aborts rather than writing whatever it found.
 *   4. --apply takes a backup with sqlite3's online .backup API — never cp,
 *      because roots.db carries a live WAL and a byte copy would be torn — then
 *      runs PRAGMA integrity_check on the copy and refuses to continue unless it
 *      answers "ok" AND the copy still holds both rows.
 *   5. Inside the transaction, per row, before the write:
 *        subtotal + packing + shipping - merchantActivity == total
 *      Any mismatch rolls the whole thing back.
 *   6. After each write, still inside the transaction, subtotal and total are
 *      re-read and must be byte-identical to what they were. This script has no
 *      business changing either, and proves it rather than promising it.
 *   7. Exactly 2 rows changed. Any other count rolls back.
 *
 * Dry run unless --apply is passed; the dry run prints exactly what --apply
 * would do, and takes no backup because it writes nothing.
 *
 * Usage, on the box (cd /root/roots-v2):
 *   node scripts/repair_eleme_order_fees.js            # survey, no write
 *   node scripts/repair_eleme_order_fees.js --apply    # back up, then write
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));

const APPLY = process.argv.slice(2).includes('--apply');

// The two, by id AND by order_no. The id is the scope; the order_no is the
// assertion that the id still means what it meant when these figures were read.
const TARGETS = [
  {
    id: 1538,
    orderNo: 'EL20260901417897',
    goods: 267, packingFee: 1.5, shippingFee: 18, discount: 17.5, total: 269,
    // Already recorded on this row — named so a surprise NULL is visible in the
    // report rather than silently filled by a script scoped to fees.
    commission: null, settleAmount: null,
  },
  {
    id: 1502,
    orderNo: 'EL20260831339491',
    goods: 135, packingFee: 1.5, shippingFee: 18, discount: 13.5, total: 141,
    commission: 14.95, settleAmount: 126.05,
  },
];
const EXPECT_COUNT = 2;

// Where each figure lives in Eleme's order envelope. Every one of these was
// confirmed against both stored payloads by the survey behind PR #200.
const P_PACK     = 'foodInfo.packageFee';
const P_DELIVER  = 'foodInfo.deliveryFee';
const P_DISCOUNT = 'settlementInfo.merchantActivityInfo.total';
const P_COMM     = 'settlementInfo.platformServiceFeeInfo.total';
const P_INCOME   = 'settlementInfo.expectedIncomeInfo.total';
const P_PAID     = 'settlementInfo.customerPaidInfo.total';

const r2  = (n) => Math.round(Number(n) * 100) / 100;
const eq  = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(a - b) < 0.005;
const die = (msg) => { console.error(`\nABORT: ${msg}`); process.exit(1); };
const show = (v) => (v === null || v === undefined ? 'NULL' : String(v));

const atPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

console.log(`repair_eleme_order_fees — ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no write)'}`);
console.log(`db: ${db.name}\n`);

// ── Survey ─────────────────────────────────────────────────────────────────
// Reads the row, reads its archive, recomputes every figure, and checks the
// arithmetic. Called once here and AGAIN inside the transaction, so the two can
// never drift into asking different questions.
function surveyOne(t) {
  const problems = [];
  const row = db.prepare(`
    SELECT id, order_no, channel, status, subtotal, total,
           packing_fee, shipping_fee, channel_commission, channel_settle_amount
      FROM retail_orders WHERE id = ?
  `).get(t.id);
  if (!row) return { t, row: null, problems: [`no retail_orders row with id ${t.id}`] };

  if (row.channel !== 'eleme')   problems.push(`channel is '${row.channel}', not eleme`);
  if (row.order_no !== t.orderNo) problems.push(`order_no is '${row.order_no}', expected '${t.orderNo}'`);

  // The goods: the row's own priced lines. Not the payload's item totals — see
  // the header. A line without a price makes the sum smaller than the basket,
  // which is a worse number than none, so it aborts instead.
  const lines = db.prepare(
    'SELECT line_total FROM retail_order_items WHERE order_id = ?'
  ).all(t.id);
  let goods = null;
  if (!lines.length) problems.push('has no line items — no goods figure to reconcile against');
  else if (!lines.every(l => Number(l.line_total) > 0)) problems.push(`has ${lines.filter(l => !(Number(l.line_total) > 0)).length} unpriced line(s)`);
  else goods = r2(lines.reduce((a, l) => a + Number(l.line_total), 0));

  const imp = db.prepare(
    'SELECT eleme_order_id, raw_payload, detail_json, LENGTH(raw_payload) AS raw_len FROM eleme_order_import WHERE retail_order_id = ?'
  ).get(t.id);
  if (!imp) return { t, row, goods, problems: problems.concat('no eleme_order_import row joined to it') };

  const raw = parseJson(imp.raw_payload);
  if (!raw) problems.push(`raw_payload does not parse (${imp.raw_len} chars — truncated at safeJson's 20000 cap?)`);

  // The divisor Eleme's own money scale was read at, from the archive that
  // carries it. detail_json holds no fees on these rows, but it does hold this.
  const det = parseJson(imp.detail_json);
  const divisor = det && Number(det.moneyDivisor) > 0 ? Number(det.moneyDivisor) : 1;
  const money = (v) => { const n = Number(v); return Number.isFinite(n) ? r2(n / divisor) : null; };

  const pack     = raw ? money(atPath(raw, P_PACK))     : null;
  const deliver  = raw ? money(atPath(raw, P_DELIVER))  : null;
  const discount = raw ? money(atPath(raw, P_DISCOUNT)) : null;
  const comm     = raw ? money(atPath(raw, P_COMM))     : null;
  const income   = raw ? money(atPath(raw, P_INCOME))   : null;
  const paid     = raw ? money(atPath(raw, P_PAID))     : null;

  // Every figure must be the one this script was written against. A payload that
  // now says something else is a reason to stop and look, not to write it.
  if (!eq(pack, t.packingFee))      problems.push(`${P_PACK} reads ${show(pack)}, expected ${t.packingFee}`);
  if (!eq(deliver, t.shippingFee))  problems.push(`${P_DELIVER} reads ${show(deliver)}, expected ${t.shippingFee}`);
  if (!eq(discount, t.discount))    problems.push(`${P_DISCOUNT} reads ${show(discount)}, expected ${t.discount}`);
  if (goods != null && !eq(goods, t.goods)) problems.push(`line_total sum is ${show(goods)}, expected ${t.goods}`);
  if (!eq(row.total, t.total))      problems.push(`row total is ${show(row.total)}, expected ${t.total}`);
  if (!eq(row.subtotal, t.goods))   problems.push(`row subtotal is ${show(row.subtotal)}, expected the goods ${t.goods}`);
  if (paid != null && !eq(paid, t.total)) problems.push(`${P_PAID} reads ${show(paid)}, expected the row total ${t.total}`);

  // THE reconciliation. goods + packaging + delivery - the shop's own promotion
  // is what the customer paid, and `total` is what the customer paid.
  const sum = goods == null ? null : r2(goods + (pack || 0) + (deliver || 0) - (discount || 0));
  if (sum == null || !eq(sum, row.total)) {
    problems.push(`${show(goods)} + ${show(pack)} + ${show(deliver)} - ${show(discount)} = ${show(sum)}, which is not the row total ${show(row.total)}`);
  }

  // The economics, filled only where the row holds NULL. A row that already has
  // a number keeps it: the import-time read was taken beside the money scale we
  // recorded, and this pass must not overwrite it with a differently-scaled one.
  const writeComm   = row.channel_commission === null    && comm   !== null;
  const writeSettle = row.channel_settle_amount === null && income !== null;
  if (writeComm !== (t.commission !== null)) {
    problems.push(`commission: row holds ${show(row.channel_commission)} and payload ${show(comm)}; this script expected ${t.commission === null ? 'to write nothing' : 'to write ' + t.commission}`);
  }
  if (writeSettle !== (t.settleAmount !== null)) {
    problems.push(`settle: row holds ${show(row.channel_settle_amount)} and payload ${show(income)}; this script expected ${t.settleAmount === null ? 'to write nothing' : 'to write ' + t.settleAmount}`);
  }
  if (writeComm && !eq(comm, t.commission))     problems.push(`${P_COMM} reads ${show(comm)}, expected ${t.commission}`);
  if (writeSettle && !eq(income, t.settleAmount)) problems.push(`${P_INCOME} reads ${show(income)}, expected ${t.settleAmount}`);
  // What the platform keeps and what reaches us have to add back up to what the
  // customer paid, or one of the two is not the figure it is labelled as.
  if (writeComm && writeSettle && !eq(r2(row.total - comm), income)) {
    problems.push(`${t.total} - commission ${show(comm)} = ${show(r2(row.total - comm))}, which is not expectedIncome ${show(income)}`);
  }

  return {
    t, row, imp, goods, divisor, rawLen: imp.raw_len,
    pack, deliver, discount, comm, income, paid, sum,
    writeComm, writeSettle, problems,
  };
}

// ── Before ─────────────────────────────────────────────────────────────────
const surveys = TARGETS.map(surveyOne);

console.log('── before ───────────────────────────────────────────────────');
for (const s of surveys) {
  if (!s.row) { console.log(`   id ${s.t.id}: ${s.problems.join('; ')}`); continue; }
  console.log(`   id ${s.row.id}  ${s.row.order_no}  ${s.row.status}  subtotal=${show(s.row.subtotal)}  total=${show(s.row.total)}`);
  console.log(`      packing_fee=${show(s.row.packing_fee)}  shipping_fee=${show(s.row.shipping_fee)}`
            + `  channel_commission=${show(s.row.channel_commission)}  channel_settle_amount=${show(s.row.channel_settle_amount)}`);
}
console.log('');

console.log('── the payload, recomputed ──────────────────────────────────');
for (const s of surveys) {
  if (!s.row || !s.imp) continue;
  console.log(`   id ${s.t.id}  raw_payload ${s.rawLen} chars  moneyDivisor=${s.divisor}`);
  console.log(`      goods (row line_total sum) = ${show(s.goods)}`
            + `   ${P_PACK}=${show(s.pack)}   ${P_DELIVER}=${show(s.deliver)}`);
  console.log(`      ${P_DISCOUNT}=${show(s.discount)}   ${P_PAID}=${show(s.paid)}`);
  console.log(`      ${show(s.goods)} + ${show(s.pack)} + ${show(s.deliver)} - ${show(s.discount)} = ${show(s.sum)}   vs total ${show(s.row.total)}`
            + `   → ${eq(s.sum, s.row.total) ? 'RECONCILES' : '*** does NOT reconcile ***'}`);
  if (s.writeComm || s.writeSettle) {
    console.log(`      ${P_COMM}=${show(s.comm)}   ${P_INCOME}=${show(s.income)}`
              + `   ${show(s.row.total)} - ${show(s.comm)} = ${show(r2(s.row.total - s.comm))}`
              + `   → ${eq(r2(s.row.total - s.comm), s.income) ? 'RECONCILES' : '*** does NOT reconcile ***'}`);
  }
}
console.log('');

const bad = surveys.filter(s => s.problems.length);
if (bad.length) {
  console.log('── problems ─────────────────────────────────────────────────');
  for (const s of bad) for (const p of s.problems) console.log(`   id ${s.t.id}: ${p}`);
  die(`${bad.length} of ${TARGETS.length} row(s) do not match the verified description — nothing written`);
}
console.log(`   both rows verified: [${TARGETS.map(t => t.id).join(', ')}]\n`);

// Where --apply puts the pre-write copy. Resolved up here rather than beside the
// backup itself so the dry run's plan names the path that would actually be used.
// ELEME_FEE_BACKUP_DIR exists only so the test harness can point it at a scratch
// directory; on the box it is unset and /root/backups is what runs, beside the
// hourly snapshots install-backup-cron.sh already writes there.
const BACKUP_DIR = process.env.ELEME_FEE_BACKUP_DIR || '/root/backups';

// ── The plan ───────────────────────────────────────────────────────────────
const plan = surveys.map(s => {
  const sets = { packing_fee: s.t.packingFee, shipping_fee: s.t.shippingFee };
  if (s.writeComm)   sets.channel_commission    = s.t.commission;
  if (s.writeSettle) sets.channel_settle_amount = s.t.settleAmount;
  return { s, sets };
});

console.log('── the write ────────────────────────────────────────────────');
for (const { s, sets } of plan) {
  for (const [col, val] of Object.entries(sets)) {
    console.log(`   id ${s.t.id}  ${col}: ${show(s.row[col])} → ${val}`);
  }
}
console.log('   subtotal and total: NOT written on either row, and re-read after the write to prove it\n');

if (!APPLY) {
  console.log('── what --apply would do ────────────────────────────────────');
  console.log(`   1. sqlite3 .backup of ${db.name} to ${path.join(BACKUP_DIR, 'pre-eleme-fee-backfill-<timestamp>.db')}`);
  console.log('   2. PRAGMA integrity_check on the copy; must answer "ok"');
  console.log('   3. confirm the copy holds both rows about to be written');
  console.log('   4. re-survey inside a transaction; roll back on any change');
  console.log('   5. assert subtotal + packing + shipping - discount == total, per row, before writing it');
  console.log('   6. UPDATE the columns above, guarded on the row still holding its current subtotal and total');
  console.log('   7. re-read subtotal and total after each write; roll back if either moved');
  console.log(`   8. require exactly ${EXPECT_COUNT} rows changed, else roll back`);
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to perform it.');
  process.exit(0);
}

// ── Backup ─────────────────────────────────────────────────────────────────
// sqlite3's online .backup API, exactly as scripts/repair_eleme_phantom_orders.js
// and scripts/install-backup-cron.sh do it. NEVER cp: roots.db runs in WAL mode,
// so a byte copy of the main file alone is torn or stale. If the sqlite3 CLI is
// missing this aborts rather than falling back — a weaker backup is not a backup.
const SRC = db.name;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const DEST = path.join(BACKUP_DIR, `pre-eleme-fee-backfill-${stamp}.db`);

try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) { die(`cannot create ${BACKUP_DIR}: ${e.message}`); }
try { execFileSync('sqlite3', ['--version'], { stdio: 'pipe' }); }
catch (e) { die('the sqlite3 CLI is not available — refusing to back up with cp, and refusing to write without a backup'); }

console.log('── backup ───────────────────────────────────────────────────');
try {
  execFileSync('sqlite3', [SRC, `.backup '${DEST}'`], { stdio: 'pipe' });
} catch (e) { die(`sqlite3 .backup failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
if (!fs.existsSync(DEST)) die(`backup file was not created at ${DEST}`);
console.log(`   backup: ${DEST}  (${fs.statSync(DEST).size} bytes)`);

let integrity = '';
try {
  integrity = String(execFileSync('sqlite3', [DEST, 'PRAGMA integrity_check;'], { stdio: 'pipe' })).trim();
} catch (e) { die(`integrity_check could not run on the backup: ${String(e.stderr || e.message).slice(0, 200)}`); }
console.log(`   PRAGMA integrity_check: ${integrity}`);
if (integrity !== 'ok') die(`integrity_check on the backup answered "${integrity}", not "ok" — nothing written`);

// A backup that doesn't hold the rows restores nothing. Prove it does.
const IDS = TARGETS.map(t => t.id);
let inBackup = '';
try {
  inBackup = String(execFileSync('sqlite3', [DEST,
    `SELECT COUNT(*) FROM retail_orders WHERE id IN (${IDS.join(',')});`], { stdio: 'pipe' })).trim();
} catch (e) { die(`could not read the backup back: ${String(e.stderr || e.message).slice(0, 200)}`); }
console.log(`   rows about to be written, present in the backup: ${inBackup}`);
if (Number(inBackup) !== EXPECT_COUNT) die(`the backup holds ${inBackup} of the ${EXPECT_COUNT} rows — it is not a usable pre-write copy`);
console.log('');

// ── Write ──────────────────────────────────────────────────────────────────
console.log('── write ────────────────────────────────────────────────────');
let changed = 0;
try {
  db.transaction(() => {
    for (const { s, sets } of plan) {
      // The same survey again, now inside the transaction, so a row that moved
      // between the read above and this statement takes the whole thing back.
      const re = surveyOne(s.t);
      if (!re.row || re.problems.length) {
        throw new Error(`re-check inside the transaction failed for id ${s.t.id}: ${(re.problems || []).join('; ') || 'row vanished'}`);
      }
      // The arithmetic, stated once more as its own assertion rather than left
      // implicit in the survey's problem list.
      const lhs = r2(re.row.subtotal + re.t.packingFee + re.t.shippingFee - re.discount);
      if (!eq(lhs, re.row.total)) {
        throw new Error(`id ${s.t.id}: subtotal ${re.row.subtotal} + packing ${re.t.packingFee} + shipping ${re.t.shippingFee} - discount ${re.discount} = ${lhs}, not the total ${re.row.total} — rolling back`);
      }

      const beforeSub = re.row.subtotal, beforeTot = re.row.total;
      const cols = Object.keys(sets);
      // Guarded on subtotal and total: a row whose money moved since the survey
      // matches zero rows here, which fails the count check below and rolls back.
      const info = db.prepare(`
        UPDATE retail_orders SET ${cols.map(c => `${c} = ?`).join(', ')}
         WHERE id = ? AND order_no = ? AND channel = 'eleme' AND subtotal = ? AND total = ?
      `).run(...cols.map(c => sets[c]), s.t.id, s.t.orderNo, beforeSub, beforeTot);
      if (info.changes !== 1) {
        throw new Error(`id ${s.t.id}: UPDATE changed ${info.changes} row(s), expected 1 — rolling back`);
      }
      changed += info.changes;

      // Neither of these is this script's to move. Proven, not promised.
      const after = db.prepare('SELECT subtotal, total FROM retail_orders WHERE id = ?').get(s.t.id);
      if (after.subtotal !== beforeSub) throw new Error(`id ${s.t.id}: subtotal moved ${beforeSub} → ${after.subtotal} — rolling back`);
      if (after.total !== beforeTot)    throw new Error(`id ${s.t.id}: total moved ${beforeTot} → ${after.total} — rolling back`);
    }
    if (changed !== EXPECT_COUNT) {
      throw new Error(`${changed} row(s) changed, expected exactly ${EXPECT_COUNT} — rolling back`);
    }
  })();
} catch (e) { die(`${e.message}\n        The transaction was rolled back. Backup kept at ${DEST}`); }
console.log(`   wrote ${changed} row(s)\n`);

// ── After ──────────────────────────────────────────────────────────────────
console.log('── after ────────────────────────────────────────────────────');
for (const t of TARGETS) {
  const r = db.prepare(`
    SELECT id, order_no, subtotal, total, packing_fee, shipping_fee,
           channel_commission, channel_settle_amount
      FROM retail_orders WHERE id = ?
  `).get(t.id);
  if (!r) { console.log(`   id ${t.id}: *** MISSING — investigate ***`); continue; }
  console.log(`   id ${r.id}  ${r.order_no}  subtotal=${show(r.subtotal)}  total=${show(r.total)}`);
  console.log(`      packing_fee=${show(r.packing_fee)}  shipping_fee=${show(r.shipping_fee)}`
            + `  channel_commission=${show(r.channel_commission)}  channel_settle_amount=${show(r.channel_settle_amount)}`);
  const s = surveys.find(x => x.t.id === t.id);
  const lhs = r2(r.subtotal + r.packing_fee + r.shipping_fee - s.discount);
  console.log(`      ${show(r.subtotal)} + ${show(r.packing_fee)} + ${show(r.shipping_fee)} - ${show(s.discount)} = ${show(lhs)}`
            + `   vs total ${show(r.total)}   → ${eq(lhs, r.total) ? 'RECONCILES' : '*** does NOT reconcile ***'}`);
}

// Nothing else in the channel moved. The five tombstoned eleme_order_import rows
// have retail_order_id NULL and no retail_orders row to write, so they are not
// reachable from a scope of id IN (1502, 1538) — checked rather than assumed.
const others = db.prepare(`
  SELECT COUNT(*) AS n FROM retail_orders
   WHERE channel = 'eleme' AND id NOT IN (${TARGETS.map(t => t.id).join(',')})
     AND (COALESCE(packing_fee,0) != 0 OR COALESCE(shipping_fee,0) != 0)
`).get().n;
console.log(`\n   other eleme rows carrying a non-zero fee: ${others} (expected 0 — nothing else was touched)`);
console.log(`\nDone. Backup: ${DEST}`);
