#!/usr/bin/env node
/**
 * diagnose_channel_probe.js — the smallest question first: what is on this box?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_channel_probe.js
 *
 * READ-ONLY, and it proves that on the connection before reading anything.
 *
 * WHY THIS EXISTS, and why it is separate from
 * scripts/diagnose_channel_order_deduction.js
 * ------------------------------------------------------------------------
 * That survey answers "did these orders take stock". It could not be made to
 * finish: four runs against the live database, two cancelled at ten and fourteen
 * minutes, and every one of them told me nothing at all — the output arrives
 * only when the job ends, so a run that is killed takes its own explanation with
 * it. Tuning a query I could not time was guesswork, and I did it twice.
 *
 * So this file asks the cheapest questions that exist, in order, and PRINTS EACH
 * ANSWER AS IT ARRIVES with the seconds it took:
 *
 *   • which database files are here, and how big
 *   • how many rows in retail_orders, and what `channel` holds
 *   • how many rows in the ledger and the two sync logs
 *
 * Nothing here scans a table it has not already counted, every step is timed,
 * and the whole thing gives up on its own deadline rather than running until
 * something else kills it. When one of these numbers is the surprise, the survey
 * can be aimed properly instead of guessed at.
 *
 * SELF-TERMINATING, on purpose. `ssh host "node script"` without a tty does not
 * hand the remote process a SIGHUP when the client goes away, so a cancelled
 * Actions job leaves the query running against production, unattended and
 * unwatched. Every run here stops itself at PROBE_BUDGET_S seconds (default 90)
 * whatever it has reached, so cancelling the job is not how it ends.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP      = process.env.ROOTS_APP || '/root/roots-v2';
const BUDGET_S = parseInt(process.env.PROBE_BUDGET_S, 10) || 90;

// WHAT THE BUDGET CAN AND CANNOT DO, stated plainly because the difference is
// the whole reason this file is small. better-sqlite3 is synchronous: a single
// statement holds the thread, no timer gets a turn while it runs, and there is
// no way from here to interrupt one. So the deadline bounds the run BETWEEN
// steps, not inside one. That is exactly why every step below is a bounded
// question — a COUNT, a LIMIT 5, one GROUP BY — rather than something that
// might not come back.
const started = Date.now();
const left = () => BUDGET_S - (Date.now() - started) / 1000;

// Written before anything slow, so an aborted run still says where it got to.
const say = (s) => { process.stdout.write(s + '\n'); };
const secs = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

let Database;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (e) { console.error('cannot load better-sqlite3: ' + e.message); process.exit(2); }

// Fires at the first moment between statements after the budget is spent, and
// ends the process there. Not a guarantee against a statement that never
// returns — see above — but it is what stops a cancelled Actions job from
// leaving this running against production for as long as it likes.
const hardStop = setTimeout(() => {
  say(`\n*** budget of ${BUDGET_S}s spent — stopping here ***`);
  process.exit(3);
}, BUDGET_S * 1000);

function candidates() {
  const list = [process.env.ROOTS_DB || path.join(APP, 'data', 'roots.db')];
  try {
    const d = path.join(APP, 'data', 'tenants');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.db')) list.push(path.join(d, f));
  } catch (_) { /* single tenant */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
}

const mb = (f) => { try { return (fs.statSync(f).size / 1048576).toFixed(1) + ' MB'; } catch (_) { return '?'; } };

const files = candidates();
say(`Databases (${files.length}):`);
for (const f of files) say(`  ${f}  ${mb(f)}`);

for (const file of files) {
  if (left() < 5) { say(`\n*** ${(BUDGET_S - left()).toFixed(0)}s spent, stopping before ${file} ***`); break; }

  say(`\n${file}`);
  say('='.repeat(70));

  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { say(`  cannot open read-only: ${e.message}`); continue; }
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (_) { proven = true; }
  if (!proven) { say('  FATAL: this connection accepted a write — reading nothing'); try { db.close(); } catch (_) {} continue; }

  // Each read announces itself BEFORE it runs. If the run dies mid-step, the
  // last line printed names the step that was too slow — which is the one fact
  // four cancelled runs of the bigger survey could never produce.
  const timed = (label, fn) => {
    process.stdout.write(`  ${label} … `);
    const t = Date.now();
    try {
      const out = fn();
      say(`${out}   [${secs(t)}]`);
    } catch (e) {
      say(`FAILED after ${secs(t)}: ${e.message}`);
    }
  };

  const has = (t) => { try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t); } catch (_) { return false; } };

  // COUNT(*) with no WHERE is the cheapest full-table question SQLite answers —
  // it walks the smallest index rather than the row data — so it is the honest
  // first measure of "how big is this, really".
  for (const t of ['retail_orders', 'retail_order_items', 'retail_stock_ledger',
                   'eleme_sync_log', 'meituan_sync_log',
                   'eleme_order_import', 'meituan_order_import']) {
    if (!has(t)) { say(`  ${t}: (no such table)`); continue; }
    timed(`count ${t}`, () => String(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n));
  }

  if (has('retail_orders')) {
    timed('newest 5 order ids/channels', () => {
      const rows = db.prepare(
        'SELECT id, order_no, channel, created_at FROM retail_orders ORDER BY id DESC LIMIT 5'
      ).all();
      return rows.map(r => `#${r.id} ${r.order_no} [${r.channel || 'null'}]`).join(', ') || '(none)';
    });
    timed('channel census', () => {
      const rows = db.prepare(
        "SELECT COALESCE(channel,'(null)') channel, COUNT(*) n FROM retail_orders GROUP BY channel ORDER BY n DESC"
      ).all();
      return rows.map(r => `${r.channel}=${r.n}`).join(', ') || '(none)';
    });
  }

  try { db.close(); } catch (_) {}
}

say(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
clearTimeout(hardStop);
