#!/usr/bin/env node
/**
 * Backfill channel_discount on the two real Eleme orders.
 *
 * This PR taught routes/eleme-internal.js to write
 * settlementInfo.merchantActivityInfo.total into retail_orders.channel_discount.
 * Like PR #200 before it, it deliberately does not touch history, so the two
 * real Eleme orders we hold still have the shop's own promotion recorded
 * nowhere — and with it missing their four money columns add up to MORE than
 * `total`, with nothing on the row to say why:
 *
 *   id 1538  EL20260901417897   channel_discount 17.5   (267 + 1.5 + 18 - 17.5 = 269)
 *   id 1502  EL20260831339491   channel_discount 13.5   (135 + 1.5 + 18 - 13.5 = 141)
 *
 * WHAT THIS DOES NOT DO, AND WHY. The task this comes from also asked for the
 * courier fields and the platform status label to be retrofitted onto these two
 * rows. Neither is here, and neither was guessed:
 *
 *   • COURIER. Whether Eleme's payload carries a rider at all — a name, a phone,
 *     anything — is not known. lib/eleme-browser.js harvests no rider field (its
 *     only phone is phoneMasked, the CUSTOMER's 隐私号), so the parser proves
 *     nothing either way, and the archive that would settle it lives on the box.
 *     scripts/diagnose_eleme_courier_status.js is the read-only capture that
 *     answers it. Until it has been run there is no verified value to write, and
 *     a placeholder rider phone is the one thing this must never invent — staff
 *     would tap it.
 *   • STATUS. channel_status holds the literal string "VALID" on these rows,
 *     which is an order-validity flag rather than a lifecycle stage. Mapping the
 *     one value anybody can guess would encode the wrong model; the same capture
 *     collects the full vocabulary first.
 *
 * So this script is the discount and nothing else. When the capture comes back,
 * the courier and status retrofit is a second pass over the same two ids, and it
 * can reuse every guard below.
 *
 * WHERE THE NUMBER COMES FROM. raw_payload, not detail_json — exactly as
 * scripts/repair_eleme_order_fees.js explains at length: detail_json is 222
 * chars on both rows (the archive predates the fee fields being parsed) while
 * the raw platform envelopes are 15271 and 15084 chars, both under safeJson's
 * 20000-char cap, so neither is truncated and both parse. moneyDivisor is read
 * from detail_json (which does carry it) and applied.
 *
 * RUN THE FEE BACKFILL FIRST. The reconciliation below is
 * `subtotal + packing_fee + shipping_fee - discount == total` off the ROW's own
 * columns, so it cannot pass while packing_fee and shipping_fee are still 0.
 * If they are, this aborts and says so by name rather than reporting a generic
 * mismatch: the fix is `node scripts/repair_eleme_order_fees.js --apply`, and
 * writing a discount onto a row whose fees are still missing would leave it just
 * as unreconciled, in a way that is harder to see.
 *
 * SAFETY, in the order it runs — the same seven the fee backfill uses, because
 * this writes to the same two production rows:
 *   1. Scope is a hardcoded id IN (1502, 1538) and nothing else. NEVER
 *      `WHERE channel_discount IS NULL`: since this PR deployed, the ingest and
 *      the /update-order-status heal both write that column, so its emptiness no
 *      longer identifies the rows needing this.
 *   2. Each row's order_no must match the one named here, or it aborts. An id
 *      that now points at a different order cannot be written by accident.
 *   3. The figure is recomputed from the payload and must equal the value named
 *      above to the cent. A different divisor, a moved field or a re-archived
 *      payload aborts rather than writing whatever it found.
 *   4. --apply takes a backup with sqlite3's online .backup API — never cp,
 *      because roots.db carries a live WAL and a byte copy would be torn — then
 *      runs PRAGMA integrity_check on the copy and refuses to continue unless it
 *      answers "ok" AND the copy still holds both rows.
 *   5. Inside the transaction, per row, before the write:
 *        subtotal + packing_fee + shipping_fee - discount == total
 *      Any mismatch rolls the whole thing back.
 *   6. After each write, still inside the transaction, subtotal and total are
 *      re-read and must be byte-identical to what they were. This script has no
 *      business changing either, and proves it rather than promising it.
 *   7. Exactly 2 rows changed. Any other count rolls back.
 *
 * ALREADY DONE IS NOT A FAILURE. If both rows already carry the right discount —
 * the daemon's status refresh now fills that blank too, so it can genuinely get
 * there first — this exits 0 having written nothing. A row carrying a DIFFERENT
 * figure aborts, because that is a disagreement and not a no-op.
 *
 * Dry run unless --apply is passed; the dry run prints exactly what --apply
 * would do, and takes no backup because it writes nothing.
 *
 * Usage, on the box (cd /root/roots-v2):
 *   node scripts/repair_eleme_ingest_backfill.js            # survey, no write
 *   node scripts/repair_eleme_ingest_backfill.js --apply    # back up, then write
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
  { id: 1538, orderNo: 'EL20260901417897', goods: 267, packingFee: 1.5, shippingFee: 18, discount: 17.5, total: 269 },
  { id: 1502, orderNo: 'EL20260831339491', goods: 135, packingFee: 1.5, shippingFee: 18, discount: 13.5, total: 141 },
];
const EXPECT_COUNT = 2;

// Where the figure lives in Eleme's order envelope. Confirmed against both
// stored payloads by the survey behind PR #200, and read by the same path the
// ingest now reads (lib/eleme-browser.js SHOP_DISC_PATHS).
const P_DISCOUNT = 'settlementInfo.merchantActivityInfo.total';
const P_PAID     = 'settlementInfo.customerPaidInfo.total';

const r2  = (n) => Math.round(Number(n) * 100) / 100;
const eq  = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(a - b) < 0.005;
const die = (msg) => { console.error(`\nABORT: ${msg}`); process.exit(1); };
const show = (v) => (v === null || v === undefined ? 'NULL' : String(v));

const atPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

console.log(`repair_eleme_ingest_backfill — ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no write)'}`);
console.log(`db: ${db.name}\n`);

// ── Survey ─────────────────────────────────────────────────────────────────
// Reads the row, reads its archive, recomputes the figure, and checks the
// arithmetic. Called once here and AGAIN inside the transaction, so the two can
// never drift into asking different questions.
function surveyOne(t) {
  const problems = [];
  const row = db.prepare(`
    SELECT id, order_no, channel, status, subtotal, total,
           packing_fee, shipping_fee, channel_discount
      FROM retail_orders WHERE id = ?
  `).get(t.id);
  if (!row) return { t, row: null, problems: [`no retail_orders row with id ${t.id}`] };

  if (row.channel !== 'eleme')    problems.push(`channel is '${row.channel}', not eleme`);
  if (row.order_no !== t.orderNo) problems.push(`order_no is '${row.order_no}', expected '${t.orderNo}'`);

  const imp = db.prepare(
    'SELECT eleme_order_id, raw_payload, detail_json, LENGTH(raw_payload) AS raw_len FROM eleme_order_import WHERE retail_order_id = ?'
  ).get(t.id);
  if (!imp) return { t, row, problems: problems.concat('no eleme_order_import row joined to it') };

  const raw = parseJson(imp.raw_payload);
  if (!raw) problems.push(`raw_payload does not parse (${imp.raw_len} chars — truncated at safeJson's 20000 cap?)`);

  // The divisor Eleme's own money scale was read at, from the archive that
  // carries it. detail_json holds no fees on these rows, but it does hold this.
  const det = parseJson(imp.detail_json);
  const divisor = det && Number(det.moneyDivisor) > 0 ? Number(det.moneyDivisor) : 1;
  const money = (v) => { const n = Number(v); return Number.isFinite(n) ? r2(n / divisor) : null; };

  const discount = raw ? money(atPath(raw, P_DISCOUNT)) : null;
  const paid     = raw ? money(atPath(raw, P_PAID))     : null;

  // Every figure must be the one this script was written against.
  if (!eq(discount, t.discount))  problems.push(`${P_DISCOUNT} reads ${show(discount)}, expected ${t.discount}`);
  if (!eq(row.total, t.total))    problems.push(`row total is ${show(row.total)}, expected ${t.total}`);
  if (!eq(row.subtotal, t.goods)) problems.push(`row subtotal is ${show(row.subtotal)}, expected the goods ${t.goods}`);
  if (paid != null && !eq(paid, t.total)) problems.push(`${P_PAID} reads ${show(paid)}, expected the row total ${t.total}`);

  // The prerequisite, named rather than left to surface as an arithmetic gap.
  // A row still holding 0/0 here has not had PR #200's fee backfill applied, and
  // a discount written onto it would leave it just as unreconciled.
  const feesMissing = !eq(row.packing_fee, t.packingFee) || !eq(row.shipping_fee, t.shippingFee);
  if (feesMissing) {
    problems.push(`packing_fee=${show(row.packing_fee)} shipping_fee=${show(row.shipping_fee)}, expected ${t.packingFee}/${t.shippingFee}`
      + ' — run `node scripts/repair_eleme_order_fees.js --apply` FIRST; this script cannot reconcile a row whose fees are still missing');
  }

  // THE reconciliation, off the row's own columns. goods + packaging + delivery
  // less the shop's own promotion is what the customer paid, and `total` is what
  // the customer paid.
  const sum = feesMissing ? null : r2(row.subtotal + row.packing_fee + row.shipping_fee - discount);
  if (!feesMissing && (sum == null || !eq(sum, row.total))) {
    problems.push(`${show(row.subtotal)} + ${show(row.packing_fee)} + ${show(row.shipping_fee)} - ${show(discount)} = ${show(sum)}, which is not the row total ${show(row.total)}`);
  }

  // Already carrying the figure is a no-op, not a failure — the ingest's heal
  // path writes this column too and can legitimately get here first. Carrying a
  // DIFFERENT one is a disagreement, and aborts.
  const already = row.channel_discount !== null;
  if (already && !eq(row.channel_discount, t.discount)) {
    problems.push(`channel_discount already holds ${show(row.channel_discount)}, which is not the ${t.discount} this script would write`);
  }

  return { t, row, imp, divisor, rawLen: imp.raw_len, discount, paid, sum, already, problems };
}

// ── Before ─────────────────────────────────────────────────────────────────
const surveys = TARGETS.map(surveyOne);

console.log('── before ───────────────────────────────────────────────────');
for (const s of surveys) {
  if (!s.row) { console.log(`   id ${s.t.id}: ${s.problems.join('; ')}`); continue; }
  console.log(`   id ${s.row.id}  ${s.row.order_no}  ${s.row.status}  subtotal=${show(s.row.subtotal)}  total=${show(s.row.total)}`);
  console.log(`      packing_fee=${show(s.row.packing_fee)}  shipping_fee=${show(s.row.shipping_fee)}`
            + `  channel_discount=${show(s.row.channel_discount)}`);
}
console.log('');

console.log('── the payload, recomputed ──────────────────────────────────');
for (const s of surveys) {
  if (!s.row || !s.imp) continue;
  console.log(`   id ${s.t.id}  raw_payload ${s.rawLen} chars  moneyDivisor=${s.divisor}`);
  console.log(`      ${P_DISCOUNT}=${show(s.discount)}   ${P_PAID}=${show(s.paid)}`);
  console.log(`      ${show(s.row.subtotal)} + ${show(s.row.packing_fee)} + ${show(s.row.shipping_fee)} - ${show(s.discount)} = ${show(s.sum)}`
            + `   vs total ${show(s.row.total)}   → ${eq(s.sum, s.row.total) ? 'RECONCILES' : '*** does NOT reconcile ***'}`);
}
console.log('');

const bad = surveys.filter(s => s.problems.length);
if (bad.length) {
  console.log('── problems ─────────────────────────────────────────────────');
  for (const s of bad) for (const p of s.problems) console.log(`   id ${s.t.id}: ${p}`);
  die(`${bad.length} of ${TARGETS.length} row(s) do not match the verified description — nothing written`);
}
console.log(`   both rows verified: [${TARGETS.map(t => t.id).join(', ')}]\n`);

// Nothing left to do. Not an abort: this is the state the script exists to
// produce, and reaching it by another route is success.
if (surveys.every(s => s.already)) {
  console.log('Both rows already carry the discount this would write — nothing to do.');
  process.exit(0);
}
// One of two, and the other verified clean, means the count check below can
// never see 2. Say which, and stop, rather than writing half.
if (surveys.some(s => s.already)) {
  const done = surveys.filter(s => s.already).map(s => s.t.id).join(', ');
  die(`id ${done} already carries its discount while the other does not — this script writes both or neither.\n`
    + '        Nothing is wrong with the data; the remaining row needs a one-row write, deliberately not automated here.');
}

// Where --apply puts the pre-write copy. Resolved up here rather than beside the
// backup itself so the dry run's plan names the path that would actually be used.
// ELEME_FEE_BACKUP_DIR is shared with repair_eleme_order_fees.js and exists only
// so a test harness can point it at a scratch directory; on the box it is unset
// and /root/backups is what runs, beside the hourly snapshots
// install-backup-cron.sh already writes there.
const BACKUP_DIR = process.env.ELEME_FEE_BACKUP_DIR || '/root/backups';

// ── The plan ───────────────────────────────────────────────────────────────
console.log('── the write ────────────────────────────────────────────────');
for (const s of surveys) {
  console.log(`   id ${s.t.id}  channel_discount: ${show(s.row.channel_discount)} → ${s.t.discount}`);
}
console.log('   subtotal and total: NOT written on either row, and re-read after the write to prove it');
console.log('   packing_fee and shipping_fee: NOT written — they are repair_eleme_order_fees.js\'s\n');

if (!APPLY) {
  console.log('── what --apply would do ────────────────────────────────────');
  console.log(`   1. sqlite3 .backup of ${db.name} to ${path.join(BACKUP_DIR, 'pre-eleme-ingest-backfill-<timestamp>.db')}`);
  console.log('   2. PRAGMA integrity_check on the copy; must answer "ok"');
  console.log('   3. confirm the copy holds both rows about to be written');
  console.log('   4. re-survey inside a transaction; roll back on any change');
  console.log('   5. assert subtotal + packing + shipping - discount == total, per row, before writing it');
  console.log('   6. UPDATE channel_discount, guarded on the row still holding its current subtotal and total');
  console.log('   7. re-read subtotal and total after each write; roll back if either moved');
  console.log(`   8. require exactly ${EXPECT_COUNT} rows changed, else roll back`);
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to perform it.');
  process.exit(0);
}

// ── Backup ─────────────────────────────────────────────────────────────────
// sqlite3's online .backup API, exactly as scripts/repair_eleme_order_fees.js
// and scripts/install-backup-cron.sh do it. NEVER cp: roots.db runs in WAL mode,
// so a byte copy of the main file alone is torn or stale. If the sqlite3 CLI is
// missing this aborts rather than falling back — a weaker backup is not a backup.
const SRC = db.name;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const DEST = path.join(BACKUP_DIR, `pre-eleme-ingest-backfill-${stamp}.db`);

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
    for (const s of surveys) {
      // The same survey again, now inside the transaction, so a row that moved
      // between the read above and this statement takes the whole thing back.
      const re = surveyOne(s.t);
      if (!re.row || re.problems.length) {
        throw new Error(`re-check inside the transaction failed for id ${s.t.id}: ${(re.problems || []).join('; ') || 'row vanished'}`);
      }
      if (re.already) {
        throw new Error(`id ${s.t.id}: channel_discount was filled between the survey and the write — rolling back`);
      }
      // The arithmetic, stated once more as its own assertion rather than left
      // implicit in the survey's problem list.
      const lhs = r2(re.row.subtotal + re.row.packing_fee + re.row.shipping_fee - re.t.discount);
      if (!eq(lhs, re.row.total)) {
        throw new Error(`id ${s.t.id}: subtotal ${re.row.subtotal} + packing ${re.row.packing_fee} + shipping ${re.row.shipping_fee} - discount ${re.t.discount} = ${lhs}, not the total ${re.row.total} — rolling back`);
      }

      const beforeSub = re.row.subtotal, beforeTot = re.row.total;
      // Guarded on subtotal and total: a row whose money moved since the survey
      // matches zero rows here, which fails the count check below and rolls back.
      // Guarded on channel_discount IS NULL as well, so a concurrent heal cannot
      // be overwritten — it would match zero rows and roll the whole thing back.
      const info = db.prepare(`
        UPDATE retail_orders SET channel_discount = ?
         WHERE id = ? AND order_no = ? AND channel = 'eleme'
           AND subtotal = ? AND total = ? AND channel_discount IS NULL
      `).run(s.t.discount, s.t.id, s.t.orderNo, beforeSub, beforeTot);
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
    SELECT id, order_no, subtotal, total, packing_fee, shipping_fee, channel_discount
      FROM retail_orders WHERE id = ?
  `).get(t.id);
  if (!r) { console.log(`   id ${t.id}: *** MISSING — investigate ***`); continue; }
  console.log(`   id ${r.id}  ${r.order_no}  subtotal=${show(r.subtotal)}  total=${show(r.total)}`);
  console.log(`      packing_fee=${show(r.packing_fee)}  shipping_fee=${show(r.shipping_fee)}  channel_discount=${show(r.channel_discount)}`);
  const lhs = r2(r.subtotal + r.packing_fee + r.shipping_fee - r.channel_discount);
  console.log(`      ${show(r.subtotal)} + ${show(r.packing_fee)} + ${show(r.shipping_fee)} - ${show(r.channel_discount)} = ${show(lhs)}`
            + `   vs total ${show(r.total)}   → ${eq(lhs, r.total) ? 'RECONCILES' : '*** does NOT reconcile ***'}`);
}

// Nothing else in the channel moved. The five tombstoned eleme_order_import rows
// have retail_order_id NULL and no retail_orders row to write, so they are not
// reachable from a scope of id IN (1502, 1538) — checked rather than assumed.
const others = db.prepare(`
  SELECT COUNT(*) AS n FROM retail_orders
   WHERE channel = 'eleme' AND id NOT IN (${TARGETS.map(t => t.id).join(',')})
     AND channel_discount IS NOT NULL
`).get().n;
console.log(`\n   other eleme rows carrying a discount: ${others} (any such row was written by the ingest, not by this script)`);
console.log(`\nDone. Backup: ${DEST}`);
