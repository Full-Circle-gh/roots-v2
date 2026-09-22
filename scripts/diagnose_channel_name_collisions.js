#!/usr/bin/env node
/**
 * diagnose_channel_name_collisions.js — every OTHER pair of listings the order
 * resolver could have confused, and the order lines that may have landed wrong.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_channel_name_collisions.js
 *
 * READ-ONLY, AND IT PROVES IT. Every database file is opened with
 * `readonly: true, fileMustExist: true`, and a write is attempted and REQUIRED to
 * fail before a single row is read. If any connection accepts a write the script
 * aborts with exit 2 rather than continuing. There is no UPDATE, DELETE, INSERT,
 * ALTER or CREATE anywhere in this file except that one probe, which exists to be
 * rejected. Same rule, same shape, as scripts/diagnose_channel_queue.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * docs/meituan-findings.md finding 21: a customer bought the 230g peach yogurt
 * and the 130g came off the shelf. `normName` deleted every half-width bracketed
 * run before comparing names, so two listings differing only by their grams were
 * one name, and the resolver took whichever row the database returned first.
 *
 * Fixing the code answers "will it happen again". It does not answer "who else
 * has this shape, and what already went wrong" — and that question is about DATA,
 * on a live box, which no test can reach. This is that question.
 *
 * WHAT IT REPORTS, per database, per channel, per store
 * -----------------------------------------------------
 *   1. WAS COLLIDING, NOW SEPARATED — mappings that were one name under the old
 *      rule and are two names under the new one. Every line that reached the map
 *      branch for one of these was a coin flip. This is the peach yogurt's group,
 *      and anyone else in its shape.
 *   2. STILL COLLIDING — mappings that are one name under BOTH rules. The size
 *      fix does not help these; what changes is that they are now REFUSED rather
 *      than guessed, so from the deploy on they surface as unresolved lines
 *      instead of silent wrong deductions. Each one needs a person: rename a
 *      listing, or point one mapping somewhere else.
 *   3. SUSPECT ORDER LINES — past channel order lines on a colliding product that
 *      carried NO 货号, so the name branch is the only branch that could have
 *      resolved them.
 *
 * WHAT (3) IS AND IS NOT. It is a SHORTLIST, not a verdict. We do not store the
 * channel's own line name, only the matched product's — so a line cannot be
 * replayed and no row here can be called wrong from the database alone. What can
 * be said is that it went through the branch that was choosing by row order, on a
 * product whose name had a twin. Check those orders against the merchant app; the
 * ones that are wrong will be wrong in the obvious way, a size apart.
 *
 * THE OLD RULE IS COPIED HERE ON PURPOSE. `oldNormName` below is the normaliser
 * as it stood before finding 21, and it no longer exists anywhere in the tree —
 * so it cannot be imported, and a diagnostic that says "this used to collide" has
 * to carry the rule it means. The NEW rule is REQUIRED from
 * lib/channel-name-match.js and never re-implemented: a local copy of that is
 * exactly how a diagnostic ends up disagreeing with the code it is diagnosing.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const HOME        = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH     = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');
const NOW         = Date.now();

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

// ── The rule under test, from lib/ ───────────────────────────────────────────
// Staged copy first (ro-query stages the CHECKOUT's lib/), deployed copy second.
// If neither loads we stop: re-implementing it here would make every "now
// separated" verdict a statement about this file rather than about the product.
let normListingName = null;
let normFrom = null;
for (const root of [HOME, DEPLOY_ROOT]) {
  try {
    ({ normListingName } = require(path.join(root, 'lib', 'channel-name-match.js')));
    if (normListingName) { normFrom = path.join(root, 'lib', 'channel-name-match.js'); break; }
  } catch (e) { /* try the next root */ }
}

// The normaliser as it stood BEFORE finding 21 — deleted from the tree by the
// fix, kept here because "this used to be one name" is meaningless without it.
// Do not tidy this into the shared lib: it is a historical record, and the day it
// tracks the lib is the day this script stops being able to tell the two apart.
function oldNormName(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\s　]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

const CHANNELS = [
  { key: 'meituan', map: 'meituan_product_map', nameCol: 'meituan_name' },
  { key: 'eleme',   map: 'eleme_product_map',   nameCol: 'eleme_name'   },
];

function candidates() {
  const dataDir = path.dirname(DB_PATH);
  const list = [DB_PATH];
  try {
    const tenants = path.join(dataDir, 'tenants');
    for (const f of fs.readdirSync(tenants)) if (f.endsWith('.db')) list.push(path.join(tenants, f));
  } catch (e) { /* single tenant — no tenants dir */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
}

const section = (t) => console.log('\n' + '═'.repeat(78) + '\n' + t + '\n' + '═'.repeat(78));

console.log('diagnose_channel_name_collisions.js — listings the order resolver could confuse');
console.log('run at (UTC):    ' + new Date(NOW).toISOString());
console.log('run at (+08):    ' + new Date(NOW + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
console.log('primary db:      ' + DB_PATH);
console.log('new rule from:   ' + (normFrom || 'NOT LOADED'));

if (!normListingName) {
  console.error('\nFATAL: could not load normListingName from lib/channel-name-match.js.');
  console.error('Refusing to re-implement it here — this script and the resolver must answer');
  console.error('"is this one name" with the same code or every verdict below is void.');
  process.exit(2);
}

const files = candidates();
console.log('\ndatabase files to scan (' + files.length + '):');
for (const f of files) console.log('   ' + f);
if (!files.length) {
  console.error('FATAL: no readable database file. Refusing to report zero collisions from nothing.');
  process.exit(2);
}

let examined = 0;
let totalWasColliding = 0;
let totalStillColliding = 0;
let totalSuspectLines = 0;

for (const file of files) {
  section('DATABASE  ' + file);

  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log('   cannot open: ' + e.message + ' — skipped'); continue; }

  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('   read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) {
    console.error('FATAL: the connection accepted a write on ' + file + '. Aborting.');
    process.exit(2);
  }
  examined++;

  const has = (t) => {
    try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
    catch (e) { return false; }
  };
  if (!has('store_products')) {
    console.log('   no store_products table — not an application database, skipped');
    db.close();
    continue;
  }

  for (const ch of CHANNELS) {
    console.log(`\n── ${ch.key} ──────────────────────────────────────────────────────`);
    if (!has(ch.map)) { console.log(`   no ${ch.map} table — channel not set up here`); continue; }

    // EXACTLY the resolver's own population: active products, a stored channel
    // name, scoped per store. Not filtered by sync_enabled, because the ORDER
    // path does not filter by it either — a mapping with sync off still answers
    // an incoming line, which is the whole reason this set is the right one.
    let rows;
    try {
      rows = db.prepare(`
        SELECT m.retail_store_id AS storeId, p.id AS pid, p.sku, p.name_cn, p.name_en,
               m.${ch.nameCol} AS chName
          FROM ${ch.map} m
          JOIN store_products p ON p.id = m.product_id
         WHERE p.is_active = 1 AND m.${ch.nameCol} IS NOT NULL AND TRIM(m.${ch.nameCol}) <> ''
         ORDER BY m.retail_store_id, p.id
      `).all();
    } catch (e) {
      console.log('   SECTION FAILED (mappings): ' + e.message);
      continue;
    }
    console.log(`   mappings the order resolver can see: ${rows.length}`);

    // Group by store, then by the OLD normalised name. A group of one was never
    // a collision; a group of two or more was a coin flip on every line that
    // reached the map branch.
    const byStore = new Map();
    for (const r of rows) {
      if (!byStore.has(r.storeId)) byStore.set(r.storeId, []);
      byStore.get(r.storeId).push(r);
    }

    for (const [storeId, list] of [...byStore.entries()].sort((a, b) => a[0] - b[0])) {
      const oldGroups = new Map();
      for (const r of list) {
        const k = oldNormName(r.chName);
        if (!k) continue;
        if (!oldGroups.has(k)) oldGroups.set(k, []);
        oldGroups.get(k).push(r);
      }

      const wasColliding = [...oldGroups.entries()].filter(([, g]) => g.length > 1);
      if (!wasColliding.length) {
        console.log(`   store ${storeId}: no collisions, old rule or new`);
        continue;
      }

      console.log(`\n   store ${storeId} — ${wasColliding.length} group(s) that were ONE name under the old rule`);

      for (const [oldKey, group] of wasColliding) {
        // Under the new rule, does the group split into distinct names?
        const newKeys = new Map();
        for (const r of group) {
          const k = normListingName(r.chName);
          if (!newKeys.has(k)) newKeys.set(k, []);
          newKeys.get(k).push(r);
        }
        const stillTied = [...newKeys.values()].filter(g => g.length > 1);
        const separated = stillTied.length === 0;

        if (separated) totalWasColliding++; else totalStillColliding++;

        console.log(`\n      ${separated ? '① WAS COLLIDING, NOW SEPARATED' : '② STILL COLLIDING — needs a person'}`);
        console.log(`         old name key: ${oldKey}`);
        for (const r of group) {
          console.log(`         · product ${r.pid} [${r.sku || 'no sku'}]  ${r.name_cn || r.name_en || ''}`);
          console.log(`             mapped to: ${r.chName}`);
          console.log(`             new key:   ${normListingName(r.chName)}`);
        }
        if (!separated) {
          console.log(`         → these will now be REFUSED (unresolved, reason ambiguous_map)`);
          console.log(`           rather than guessed. Rename one listing, or unmap one product.`);
        }

        // ── 3 · the suspect lines ───────────────────────────────────────────
        // Lines on these products, on THIS channel, that carried no 货号 — so
        // branches 0 and 1 could not have fired and the name branch is the only
        // one that could have resolved them.
        if (!has('retail_order_items') || !has('retail_orders')) continue;
        const ids = group.map(r => r.pid);
        const ph = ids.map(() => '?').join(',');
        let lines = [];
        try {
          lines = db.prepare(`
            SELECT o.order_no, o.placed_at, i.product_id, i.qty, i.name_cn
              FROM retail_order_items i
              JOIN retail_orders o ON o.id = i.order_id
             WHERE i.product_id IN (${ph})
               AND o.channel = ?
               AND COALESCE(TRIM(i.sku), '') = ''
             ORDER BY o.placed_at DESC
             LIMIT 25
          `).all(...ids, ch.key);
        } catch (e) {
          console.log(`         SECTION FAILED (suspect lines): ${e.message}`);
          continue;
        }
        totalSuspectLines += lines.length;
        if (!lines.length) {
          console.log(`         no past ${ch.key} line on these products went through the name branch`);
        } else {
          console.log(`         SUSPECT — ${lines.length} ${ch.key} line(s) with no 货号, newest first:`);
          for (const l of lines) {
            console.log(`           ${l.order_no}  ${String(l.placed_at || '').slice(0, 16)}  `
              + `×${l.qty}  → product ${l.product_id}  ${l.name_cn || ''}`);
          }
          console.log(`         (a shortlist, not a verdict — the channel's own line name is not`);
          console.log(`          stored, so these cannot be replayed. Check them in the merchant app.)`);
        }
      }
    }
  }

  db.close();
}

section('SUMMARY');
console.log(`databases examined:            ${examined}`);
console.log(`groups fixed by the size rule: ${totalWasColliding}`);
console.log(`groups STILL colliding:        ${totalStillColliding}   ← each needs a person`);
console.log(`suspect past lines listed:     ${totalSuspectLines}`);
if (!examined) {
  console.error('\nFATAL: no database was examined. The zeroes above are not evidence.');
  process.exit(2);
}
console.log('\nNothing was written. See docs/meituan-findings.md finding 21.');
