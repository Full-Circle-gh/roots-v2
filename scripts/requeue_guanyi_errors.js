#!/usr/bin/env node
/**
 * Re-queue stranded Guanyi (gzgrocery) stock-sync rows that errored.
 *
 * Errored guanyi_sync_queue rows are TERMINAL: the daemon only ever processes
 * status='pending', so anything that flipped to 'error' (e.g. a batch whose
 * shared 库存调整单 approve failed) sits there forever. This flips them back to
 * 'pending' with attempts reset so the daemon picks them up again.
 *
 * SAFE / idempotent: the daemon re-reads Guanyi's LIVE on-hand for each batch
 * and writes only (target − current), so a row that actually did commit will
 * recompute delta=0 and be skipped — re-pushing never double-applies stock.
 *
 * Run ON THE SERVER, against data/roots.db. Defaults to a dry run:
 *   node scripts/requeue_guanyi_errors.js              # preview only
 *   node scripts/requeue_guanyi_errors.js --commit     # actually re-queue
 *   node scripts/requeue_guanyi_errors.js --commit --reason "document create/approve failed"
 *       (only re-queue rows whose last_error matches; default = all error rows)
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const ri = argv.indexOf('--reason');
const REASON = ri >= 0 && argv[ri + 1] ? argv[ri + 1] : null;

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));

const where = REASON ? `status='error' AND last_error = ?` : `status='error'`;
const params = REASON ? [REASON] : [];

const before = db.prepare(`SELECT COUNT(*) n FROM guanyi_sync_queue WHERE ${where}`).get(...params).n;
console.log(`\nErrored rows matching ${REASON ? `last_error="${REASON}"` : '(any reason)'}: ${before}`);

if (!before) { console.log('Nothing to re-queue.'); db.close(); process.exit(0); }

if (!COMMIT) {
  console.log('\nDRY RUN — nothing changed. Re-run with --commit to re-queue them to pending.');
  db.close(); process.exit(0);
}

const res = db.prepare(`
  UPDATE guanyi_sync_queue
     SET status='pending', attempts=0, last_error=NULL, processed_at=NULL
   WHERE ${where}
`).run(...params);

console.log(`\n✅ Re-queued ${res.changes} row(s) to pending (attempts=0).`);
console.log('The guanyi-sync daemon will pick them up within ~10s. Watch:');
console.log('  pm2 logs guanyi-sync --lines 50');
db.close();
