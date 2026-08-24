#!/usr/bin/env node
/**
 * Collapse the finance-category variant families onto their canonical value.
 *
 * READ-ONLY BY DEFAULT. Prints a dry-run plan and writes nothing. Pass --apply
 * to write; --apply takes a backup first and runs every change in ONE
 * transaction, so the database is either fully converted or untouched.
 *
 *   node scripts/normalise_finance_categories.js            # dry run (default)
 *   node scripts/normalise_finance_categories.js --apply    # take backup, then write
 *
 * ── WHAT IT FIXES ─────────────────────────────────────────────────────────
 * Three columns hold one vocabulary as free text, and Finance groups by that
 * text: ingredients.accounting_category, po_line_items.expense_category and
 * expense_entries.category. Values that read identically on screen but differ
 * by one code point group as two categories in every report.
 *
 * Measured on production 2026-08-24:
 *
 *   FAMILY 1 — canonical  Ingredients(Kitchen+Retail Use) 原材料（厨房及零售通用）
 *              variant    Ingredients (Kitchen + Retail Use) 原材料（厨房及零售通⽤）
 *   FAMILY 2 — canonical  Retail-Only Goods(Not Used in Kitchen) 零售商品（厨房不使用）
 *              variant    Retail-Only Goods (Not Used in Kitchen) 零售商品（厨房不使⽤）
 *
 * Each variant differs from its canonical in exactly two ways: ASCII spaces
 * around `(` and `+`, and U+2F64 ⽤ KANGXI RADICAL USE in place of U+7528 用.
 *
 * ── HOW CANONICAL IS DECIDED — NOT BY THIS SCRIPT ─────────────────────────
 * The canonical value is whichever member of the family EXISTS IN THE TENANT'S
 * OWN PICKER LIST — `categories` where kind='accounting'. That list is the
 * vocabulary the ingredient form and the PO line offer, and it is clean: zero
 * of its 31 rows carry a radical. Every bad value in the data arrived from
 * somewhere that is not the picker.
 *
 * So the script does not rank variants, guess at majorities, or prefer the
 * commoner spelling. It asks the picker. A family whose members are ALL absent
 * from the picker is reported and NOT changed — there is nothing to snap to.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TOUCH ───────────────────────────────────
 * Values that differ in their ENGLISH WORDS are not folded together, however
 * obviously related they look:
 *
 *   fresh veggie 蔬菜        vs  Vegetables 蔬菜        (master)
 *   dried fruits 果干  /  果干  vs  Dried Fruits 果干      (master)
 *
 * Same Chinese, different English. Deciding those are one category is a
 * judgement about the business, not the repair of a paste, and it is not this
 * script's to make. They are listed under REVIEW.
 *
 * Likewise NOT merged, and this one matters: BOTH of these are in the master
 * list and both are legitimate, separate categories —
 *
 *   Kitchen low cost & non-durable equipment 厨房低值易耗品
 *   low cost & non-durable equipment 低值易耗品
 *
 * They differ by the word "Kitchen"/厨房, which is a real distinction between a
 * kitchen consumable and a general one. Folding them would destroy a split the
 * bookkeeper is relying on.
 *
 * ── RE-RUNNABLE ───────────────────────────────────────────────────────────
 * The plan is computed from the current data every run. A second run finds
 * nothing to do and says so. Interrupting a run leaves the transaction rolled
 * back, so a retry starts from the same place.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { normaliseCategory, spacingKey } = require('../lib/category-text');

const APPLY   = process.argv.includes('--apply');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');

// column → its table, keyed for reporting.
const TARGETS = [
  { table: 'ingredients',    column: 'accounting_category', label: 'ingredients.accounting_category' },
  { table: 'po_line_items',  column: 'expense_category',    label: 'po_line_items.expense_category' },
  { table: 'expense_entries',column: 'category',            label: 'expense_entries.category' },
];

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Set ROOTS_DB to override.`);
    process.exit(1);
  }
  // Opened read-only for the dry run so a plan can never write by accident.
  const db = new Database(DB_PATH, APPLY ? {} : { readonly: true });
  db.pragma('foreign_keys = ON');

  // ── The authority: the tenant's own picker list ──────────────────────────
  let master = [];
  try {
    master = db.prepare("SELECT name FROM categories WHERE kind = 'accounting' ORDER BY name").all().map(r => r.name);
  } catch (e) {
    console.error('Could not read the categories master list:', e.message);
    console.error('Refusing to run — canonical values come from that list and nowhere else.');
    process.exit(1);
  }
  if (!master.length) {
    console.error('The categories master list (kind=accounting) is EMPTY.');
    console.error('Refusing to run — there is nothing to snap onto, and guessing a canonical');
    console.error('value from the data is exactly what this script exists not to do.');
    process.exit(1);
  }
  const masterByKey = new Map();
  for (const name of master) masterByKey.set(spacingKey(name), name);

  console.log('='.repeat(78));
  console.log(`  Finance category normalisation — ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`);
  console.log(`  Database : ${DB_PATH}`);
  console.log(`  Master   : ${master.length} categories in the picker list (kind='accounting')`);
  console.log('='.repeat(78));

  // ── Build the plan ───────────────────────────────────────────────────────
  const plan   = [];   // { label, table, column, from, to, rows }
  const review = [];   // { label, value, rows, why }
  let totalRows = 0;

  for (const t of TARGETS) {
    let rows;
    try {
      rows = db.prepare(
        `SELECT ${t.column} AS v, COUNT(*) AS n FROM ${t.table}
          WHERE ${t.column} IS NOT NULL AND TRIM(${t.column}) <> ''
          GROUP BY ${t.column} ORDER BY n DESC`
      ).all();
    } catch (e) {
      console.log(`\n  ! ${t.label}: could not read (${e.message}) — skipped`);
      continue;
    }
    for (const r of rows) {
      const current = r.v;
      const key     = spacingKey(current);
      const canon   = masterByKey.get(key);
      if (canon === undefined) {
        // No master entry differs only by spacing/case/radical. Either it is a
        // category the picker does not carry, or it differs in its words.
        const norm = normaliseCategory(current);
        if (norm !== current) {
          // Still worth repairing the bytes even with nothing to snap to.
          plan.push({ ...t, from: current, to: norm, rows: r.n, why: 'glyph/whitespace repair only' });
          totalRows += r.n;
        } else {
          review.push({ label: t.label, value: current, rows: r.n, why: 'not in the picker list — left alone' });
        }
        continue;
      }
      if (canon === current) continue;                 // already canonical
      plan.push({ ...t, from: current, to: canon, rows: r.n, why: 'snapped to the picker list' });
      totalRows += r.n;
    }
  }

  // ── Print the plan ───────────────────────────────────────────────────────
  if (!plan.length) {
    console.log('\n  Nothing to change. Every value is already canonical.\n');
  } else {
    console.log(`\n  ${plan.length} value(s) to rewrite, ${totalRows} row(s) total:\n`);
    for (const p of plan) {
      console.log(`  ${p.label}   (${p.rows} row${p.rows === 1 ? '' : 's'})   — ${p.why}`);
      console.log(`      FROM  ${JSON.stringify(p.from)}`);
      console.log(`            ${hexOf(p.from)}`);
      console.log(`      TO    ${JSON.stringify(p.to)}`);
      console.log(`            ${hexOf(p.to)}`);
      console.log('');
    }
  }

  if (review.length) {
    console.log('  ' + '-'.repeat(74));
    console.log('  REVIEW — untouched, needs a human decision:\n');
    for (const r of review) {
      console.log(`  ${r.label}  ${JSON.stringify(r.value)}  (${r.rows} row${r.rows === 1 ? '' : 's'}) — ${r.why}`);
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('  ' + '-'.repeat(74));
    console.log('  DRY RUN — nothing was written. Re-run with --apply to make these changes.');
    console.log('');
    db.close();
    return;
  }
  if (!plan.length) { db.close(); return; }

  // ── Backup, then one transaction ─────────────────────────────────────────
  const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DB_PATH}.pre-category-normalise.${stamp}.bak`;
  console.log(`  Backing up to ${backup} …`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');          // fold the WAL in first
  fs.copyFileSync(DB_PATH, backup);
  const size = fs.statSync(backup).size;
  if (size < 1024) {
    console.error(`  Backup is only ${size} bytes — refusing to continue.`);
    db.close();
    process.exit(1);
  }
  console.log(`  Backup written, ${(size / 1048576).toFixed(1)} MB.\n`);

  const applied = [];
  const tx = db.transaction(() => {
    for (const p of plan) {
      const r = db.prepare(`UPDATE ${p.table} SET ${p.column} = ? WHERE ${p.column} = ?`).run(p.to, p.from);
      applied.push({ label: p.label, expected: p.rows, changed: r.changes });
      if (r.changes !== p.rows) {
        throw new Error(
          `${p.label}: expected to change ${p.rows} row(s), changed ${r.changes}. ` +
          `The data moved between the plan and the write. Rolled back; re-run the dry run.`
        );
      }
    }
  });

  try {
    tx();
  } catch (e) {
    console.error(`\n  ROLLED BACK — nothing was written.\n  ${e.message}\n`);
    console.error(`  The database is unchanged. The backup at ${backup} is still valid.`);
    db.close();
    process.exit(1);
  }

  console.log('  Applied:');
  let n = 0;
  for (const a of applied) { console.log(`    ${a.label}: ${a.changed} row(s)`); n += a.changed; }
  console.log(`\n  ${n} row(s) rewritten in one transaction. Backup: ${backup}\n`);
  db.close();
}

// Bytes of a string, so two values that look identical can be told apart in the
// terminal. This is the whole reason the defect went unread for months.
function hexOf(s) {
  return Buffer.from(String(s), 'utf8').toString('hex').toUpperCase().replace(/(.{2})/g, '$1 ').trim();
}

main();
