#!/usr/bin/env node
// ONE-OFF — switch on the fresh pre-order window (§74/§80 + §85).
//
//   node scripts/oneoff_preorder_settings.js            # dry run (default)
//   node scripts/oneoff_preorder_settings.js --apply    # write
//
// WHY THIS EXISTS RATHER THAN THE SETTINGS SCREEN. Every value below is one an
// operator sets in Mini App Backend → Delivery → Fresh batches. Ash asked for it
// to be set up while away from that screen, so this writes the same object the
// card's PUT writes, with the same shape, and prints the before and after.
//
// ── WHAT IT CHANGES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
//
// It MERGES into the live `batch.schedule`. The card's own save replaces that
// object wholesale, and doing that here would drop the operator copy fields
// (the popup kicker/title/message pairs) that this script has no business
// knowing about. Read, merge four keys, write back.
//
//   ready_hour        11  — §74/§80's off switch. UNSET ON THE LIVE BOX TODAY,
//                           which means the mini-app pre-order rule Ash
//                           announced to staff is not actually running. Setting
//                           it turns that on as well as the platform half.
//   lock_hour       null  — deliberately not set. It falls back to ready_hour,
//                           so the two stay in step at 11:00 and an operator
//                           who later moves the ready hour does not leave a
//                           stale lock behind.
//   preorder_qty       5  — how many of each fresh item each SHOP may sell
//                           beyond its shelf during a window.
//   preorder_channels     — meituan, eleme, gzgrocery.
//   cutoff_hour       20  — written EXPLICITLY at the value the server already
//                           defaults to when it is absent, which it is today.
//                           No behaviour changes. It is written because
//                           saveBatchSchedule() REFUSES a non-numeric cutoff
//                           while the switch is on, so a card opened and saved
//                           by hand would otherwise refuse until someone typed
//                           a number they never chose.
//
// ── THE EXPOSURE THIS CREATES, STATED IN UNITS ────────────────────────────
//
// The allowance is per SHOP per PRODUCT, and the shelf it sits on top of is
// shared by every channel — so three channels do not mean three times the
// allowance. They compete for the same five.
//
// With 9 fresh products live: up to 45 pre-ordered units per shop per batch
// morning, which the kitchen must add to that morning's batch. They see it on
// 厨房制作队列 (§84). Raise or lower the number on the card once a real morning
// has been through it.

'use strict';

const path = require('path');
const Database = require('@libsql/client');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');

const TARGET = {
  ready_hour: 11,
  lock_hour: null,
  preorder_qty: 5,
  preorder_channels: ['meituan', 'eleme', 'gzgrocery'],
  cutoff_hour: 20,
};

const db = new Database(DB_PATH, { readonly: !APPLY, fileMustExist: true });
console.log(`DB   : ${DB_PATH}`);
console.log(`MODE : ${APPLY ? 'APPLY — this will write' : 'DRY RUN — nothing will be written'}\n`);

const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'batch.schedule'").get();
if (!row) {
  console.log('!! ABORT: there is no batch.schedule row.');
  console.log('   This script only ever MERGES into an existing schedule — it will not');
  console.log('   invent a cadence. Set the batch days on the Fresh batches card first.');
  process.exit(1);
}

let current;
try { current = JSON.parse(row.value_json); }
catch (e) { console.log(`!! ABORT: batch.schedule is not valid JSON (${e.message}).`); process.exit(1); }

if (!current || !current.enabled) {
  console.log('!! ABORT: batch.schedule is present but not enabled. Nothing would ever open.');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(current.anchor_date || ''))) {
  console.log(`!! ABORT: anchor_date is ${JSON.stringify(current.anchor_date)} — no cadence to work from.`);
  process.exit(1);
}

// ── What is about to change, key by key ────────────────────────────────────
const next = { ...current, ...TARGET };
const KEYS = ['enabled', 'anchor_date', 'interval_days', 'cutoff_hour', 'ready_hour',
              'lock_hour', 'preorder_qty', 'preorder_channels'];
const j = (v) => (v === undefined ? '(unset)' : JSON.stringify(v));
console.log('key                  before              after');
console.log('-'.repeat(66));
let changes = 0;
for (const k of KEYS) {
  const a = j(current[k]), b = j(next[k]);
  const moved = a !== b;
  if (moved) changes++;
  console.log(`${k.padEnd(20)} ${a.padEnd(19)} ${b}${moved ? '   ←' : ''}`);
}
const skips = Array.isArray(current.skip_dates) ? current.skip_dates : [];
console.log(`${'skip_dates'.padEnd(20)} ${String(skips.length + ' date(s)').padEnd(19)} unchanged`);
console.log('-'.repeat(66));
console.log(`${changes} key(s) would change.\n`);

// Every operator copy field is carried through untouched — the whole reason
// this merges rather than replacing. Say so explicitly rather than implying it.
const carried = Object.keys(current).filter((k) => !KEYS.includes(k) && k !== 'skip_dates');
console.log(`carried through unchanged: ${carried.length ? carried.join(', ') : '(none)'}\n`);

// ── What it will mean tomorrow morning ─────────────────────────────────────
const fresh = db.prepare(
  'SELECT COUNT(*) AS n FROM store_products WHERE COALESCE(is_batch_made,0)=1 AND COALESCE(is_active,1)=1'
).get().n;
const perChannel = db.prepare(`
  SELECT (SELECT COUNT(*) FROM meituan_product_map m JOIN store_products p ON p.id=m.product_id
           WHERE m.sync_enabled=1 AND COALESCE(p.is_batch_made,0)=1 AND COALESCE(p.is_active,1)=1) AS meituan,
         (SELECT COUNT(*) FROM eleme_product_map m JOIN store_products p ON p.id=m.product_id
           WHERE m.sync_enabled=1 AND COALESCE(p.is_batch_made,0)=1 AND COALESCE(p.is_active,1)=1) AS eleme,
         (SELECT COUNT(*) FROM guanyi_product_map m JOIN store_products p ON p.id=m.product_id
           WHERE m.sync_enabled=1 AND COALESCE(p.is_batch_made,0)=1 AND COALESCE(p.is_active,1)=1) AS gzgrocery
`).get();
console.log(`${fresh} active fresh product(s); live fresh listings — ` +
            `meituan ${perChannel.meituan}, eleme ${perChannel.eleme}, gzgrocery ${perChannel.gzgrocery}`);
console.log(`allowance ${TARGET.preorder_qty} per shop per product, SHARED across the channels above.`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with apply=true if the table above reads right.');
  process.exit(0);
}

// ── Write ──────────────────────────────────────────────────────────────────
const before = row.value_json;
const info = db.prepare(
  "UPDATE storefront_config SET value_json = ? WHERE key = 'batch.schedule' AND value_json = ?"
).run(JSON.stringify(next), before);

// The guard is the point: if anything changed the row between the read above
// and this write — an operator saving the card from a phone, another script —
// zero rows match and nothing is overwritten.
if (info.changes !== 1) {
  console.log('\n!! NOTHING WRITTEN: batch.schedule changed underneath this run.');
  console.log('   Re-run the dry run and look again before applying.');
  process.exit(1);
}

const after = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'batch.schedule'").get();
const check = JSON.parse(after.value_json);
const ok = check.ready_hour === 11
        && check.preorder_qty === 5
        && Array.isArray(check.preorder_channels)
        && check.preorder_channels.join(',') === 'meituan,eleme,gzgrocery'
        && check.anchor_date === current.anchor_date
        && check.enabled === true;
console.log(`\nWRITTEN. read-back ${ok ? 'MATCHES' : 'DOES NOT MATCH — look at this'}:`);
console.log(`  ${after.value_json}`);
process.exit(ok ? 0 : 1);
