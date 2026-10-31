#!/usr/bin/env node
'use strict';

/**
 * report_reject_codes.js — which platform refusal codes are actually happening,
 * and which of them nobody has written down yet. §106.
 *
 * WHY THIS EXISTS
 * ---------------
 * §106 set out to map Meituan's numeric `code` to a what-to-do line for the
 * operator. Every code the tree knows about turned out to be handled BEFORE an
 * operator can see it (lib/channel-push-reason.js, MEITUAN_CODES, says which
 * and where), so a mapping would have been three sentences nobody can reach.
 *
 * The honest half of that job is this: the codes are ALREADY BEING RECORDED —
 * `meituan_sync_log` keeps the daemon's own sentence for every terminal push
 * failure, and the queue row keeps it too — so the table can grow from what has
 * really been refused instead of from guesswork. This counts them and names the
 * ones missing from MEITUAN_CODES.
 *
 * IT WRITES NOTHING. It opens every database read-only and prints.
 *
 * USAGE
 *   node scripts/report_reject_codes.js                  # every tenant
 *   node scripts/report_reject_codes.js --db data/roots.db
 *   node scripts/report_reject_codes.js --days 30        # default: everything
 *
 * EXIT CODES
 *   0  read at least one database and printed the tally (unknown codes included
 *      — an unknown code is a finding, not a failure)
 *   2  REFUSED — nothing could be read, so "no unknown codes" would be a lie.
 *      §30 rule 4: a check that cannot run refuses rather than passes.
 */

const fs = require('fs');
const path = require('path');
const { MEITUAN_CODES, meituanCodeOf, classifyPushError } = require('../lib/channel-push-reason');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; };

const DAYS = at('--days') ? Number(at('--days')) : null;
if (DAYS != null && (!Number.isFinite(DAYS) || DAYS <= 0)) {
  console.error('[reject-codes] --days needs a positive number.');
  process.exit(2);
}

function refuse(msg) {
  console.error('');
  console.error('REFUSED — no database could be read, which is NOT the same as no refusals.');
  console.error('  ' + msg);
  process.exit(2);
}

// Every database this box carries: the shared file (tenant #1) and one file per
// other tenant. lib/tenant-db.js owns that layout; this only reads it.
function databases() {
  const one = at('--db');
  if (one) return [{ label: path.basename(one), file: path.resolve(ROOT, one) }];
  const out = [];
  const main = path.join(ROOT, 'data', 'roots.db');
  if (fs.existsSync(main)) out.push({ label: 'roots', file: main });
  const dir = path.join(ROOT, 'data', 'tenants');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.db')).sort()) {
      out.push({ label: 'tenant ' + f.replace(/\.db$/, ''), file: path.join(dir, f) });
    }
  }
  return out;
}

let Database;
try { Database = require('@libsql/client'); }
catch (e) { refuse(`better-sqlite3 will not load: ${e.message}`); }

// code -> { hits, first, last, msgs:Set, where:Set }. `null` is its own bucket:
// a refusal that carried no code at all is worth seeing beside the ones that did.
const tally = new Map();
function note(code, text, at_, where) {
  const key = code == null ? 'none' : String(code);
  let e = tally.get(key);
  if (!e) { e = { hits: 0, first: null, last: null, msgs: new Set(), where: new Set() }; tally.set(key, e); }
  e.hits += 1;
  if (at_ && (!e.first || String(at_) < e.first)) e.first = String(at_);
  if (at_ && (!e.last || String(at_) > e.last)) e.last = String(at_);
  if (e.msgs.size < 4) e.msgs.add(String(text || '').slice(0, 120));
  e.where.add(where);
}

const since = DAYS == null ? null
  : new Date(Date.now() - DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);

// Two sources, because they fail differently: the log keeps history the queue
// has already overwritten, and the queue keeps rows a log write may have missed.
const SOURCES = [
  { sql: (w) => `SELECT error_msg AS txt, created_at AS at FROM meituan_sync_log
                  WHERE status = 'error' AND error_msg IS NOT NULL ${w ? 'AND created_at >= ?' : ''}`,
    where: 'meituan_sync_log' },
  { sql: (w) => `SELECT last_error AS txt, processed_at AS at FROM meituan_sync_queue
                  WHERE status = 'error' AND last_error IS NOT NULL ${w ? 'AND processed_at >= ?' : ''}`,
    where: 'meituan_sync_queue' },
];

let read = 0;
for (const db of databases()) {
  if (!fs.existsSync(db.file)) continue;
  let conn;
  try { conn = new Database(db.file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.error(`  (skipped ${db.label}: ${e.message})`); continue; }
  let touched = false;
  for (const src of SOURCES) {
    let rows;
    try { rows = conn.prepare(src.sql(!!since)).all(...(since ? [since] : [])); }
    catch (e) { continue; }            // a table this tenant does not carry
    touched = true;
    for (const r of rows) {
      // Only a stated refusal carries a code worth tallying. "cannot reach" and
      // "retries exhausted" are ours, not the platform's.
      if (classifyPushError(r.txt).code !== 'rejected') continue;
      note(meituanCodeOf(r.txt), r.txt, r.at, db.label + ' · ' + src.where);
    }
  }
  if (touched) read += 1;
  conn.close();
}

if (!read) refuse('no database carried a meituan_sync_log or meituan_sync_queue table.');

const keys = [...tally.keys()].sort((a, b) => tally.get(b).hits - tally.get(a).hits);
console.log('');
console.log(`Meituan refusals${since ? ` since ${since}` : ''} — ${read} database(s) read, ${keys.length} distinct code(s).`);
console.log('');
if (!keys.length) console.log('  none recorded.');
const unknown = [];
for (const k of keys) {
  const e = tally.get(k);
  const known = k !== 'none' && Object.prototype.hasOwnProperty.call(MEITUAN_CODES, k);
  if (!known) unknown.push(k);
  console.log(`  code ${k.padEnd(8)} ${String(e.hits).padStart(6)} hit(s)  ${e.first || '?'} → ${e.last || '?'}`);
  console.log(`      ${known ? 'known: ' + MEITUAN_CODES[k].means : 'NOT IN MEITUAN_CODES'}`);
  for (const m of e.msgs) console.log(`      · ${m}`);
}
console.log('');
if (unknown.length) {
  console.log(`${unknown.length} code(s) not in lib/channel-push-reason.js MEITUAN_CODES: ${unknown.join(', ')}`);
  console.log('Add each one there with what it means and where it is handled — that table is');
  console.log('meant to grow from this output, and from nothing else.');
} else {
  console.log('Every code recorded is already described in MEITUAN_CODES.');
}
console.log('');
