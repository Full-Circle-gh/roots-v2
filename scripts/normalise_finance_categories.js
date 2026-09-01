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
 * Four columns hold one vocabulary as free text, and Finance groups by that
 * text: ingredients.accounting_category, po_line_items.expense_category,
 * expense_entries.category and income_entries.category. Values that read
 * identically on screen but differ by one code point group as two categories
 * in every report.
 *
 * ── WHAT THE DRY RUN REPORTS (decisions §36, the categories subsection) ────
 * The plan is grouped BY THE VALUE BEING LANDED ON, not printed as a flat
 * FROM → TO list, because the collapse is the thing being decided and it
 * should not have to be spotted by eye. Each block names its sources, the
 * rows and money moving from each, and what the line totals afterwards.
 *
 * Money is summed for the two LEDGER tables only. po_line_items' amount is
 * qty × cost_per_unit and ingredients has none, so those report rows alone
 * rather than a number nobody could reconcile against a Summary line.
 *
 * INCOME HAS NO MASTER VOCABULARY, AND THAT IS NOT A DEGRADED MODE. The
 * picker list is the expense vocabulary — income categories live in each
 * browser's localStorage and have never been synced (decisions §36). So an
 * income value matches no master entry, falls to the glyph/whitespace repair
 * branch, and is normalised IN PLACE. Two spellings of one category collapse
 * because normalising makes them the same string; two genuinely different
 * categories do not, because nothing snaps them together. Income is never
 * snapped onto an expense category: the only way onto a master value is a
 * spacingKey match, and that is the whole vocabulary's decision, not a guess.
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
//
// `money` marks the two LEDGER tables, the only ones with a single amount per
// row. po_line_items' value is qty × cost_per_unit and ingredients has no
// amount at all, so those two report rows only — an invented money column on
// them would be a number nobody could reconcile against a Summary line.
const TARGETS = [
  { table: 'ingredients',    column: 'accounting_category', label: 'ingredients.accounting_category' },
  { table: 'po_line_items',  column: 'expense_category',    label: 'po_line_items.expense_category' },
  { table: 'expense_entries',column: 'category',            label: 'expense_entries.category', money: true },
  { table: 'income_entries', column: 'category',            label: 'income_entries.category',  money: true },
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
  // ── Refuse on a colliding master list ────────────────────────────────────
  // masterByKey is keyed on spacingKey, so two picker entries that differ only
  // by spacing or case share a key and the Map silently keeps the LAST one.
  // Every row matching that key would then snap onto an arbitrary winner with
  // nothing in the output saying which, or that a choice was made at all.
  //
  // This is a HARD REFUSAL and it fires on the DRY RUN too: a plan computed
  // against a colliding list is wrong whether or not anyone applies it, and a
  // warning buried in a long dry run is a warning nobody reads. The fix is to
  // clean the picker list, which is a human decision about the vocabulary.
  //
  // Null keys are skipped rather than compared — a picker entry that
  // normalises to nothing is malformed, but it is not a collision, and
  // masterByKey below is left exactly as it was so nothing about what the
  // script DECIDES changes here.
  const byKey = new Map();
  for (const name of master) {
    const k = spacingKey(name);
    if (k === null) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(name);
  }
  const collisions = [...byKey.entries()].filter(([, names]) => names.length > 1);
  if (collisions.length) {
    console.error('');
    console.error('  REFUSING TO RUN — the picker list has entries that differ only by');
    console.error('  spacing or case, so there is no single canonical value to snap onto.');
    console.error('');
    for (const [k, names] of collisions) {
      console.error(`  shared key ${JSON.stringify(k)}`);
      for (const n of names) {
        console.error(`      ${JSON.stringify(n)}`);
        console.error(`      ${hexOf(n)}`);
      }
      console.error('');
    }
    console.error('  No plan was produced. Resolve the duplicates in `categories`');
    console.error("  (kind='accounting') — which of them is the real category is a");
    console.error('  decision about the vocabulary, not one this script can make.');
    console.error('');
    db.close();
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
  const plan   = [];   // { label, table, column, from, to, rows, money, why }
  const review = [];   // { label, value, rows, money, why }   money: null off-ledger
  let totalRows = 0;

  // label → (value → { n, m }). Used to price the target line a collapse lands
  // on: the post-merge total is what moves PLUS what already sits there.
  const census = new Map();

  for (const t of TARGETS) {
    let rows;
    try {
      rows = db.prepare(
        `SELECT ${t.column} AS v, COUNT(*) AS n, ${t.money ? 'COALESCE(SUM(amount),0)' : 'NULL'} AS m
           FROM ${t.table}
          WHERE ${t.column} IS NOT NULL AND TRIM(${t.column}) <> ''
          GROUP BY ${t.column} ORDER BY n DESC`
      ).all();
    } catch (e) {
      console.log(`\n  ! ${t.label}: could not read (${e.message}) — skipped`);
      continue;
    }
    const seen = new Map();
    for (const r of rows) seen.set(r.v, { n: r.n, m: r.m });
    census.set(t.label, seen);
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
          plan.push({ ...t, from: current, to: norm, rows: r.n, money: r.m, why: 'glyph/whitespace repair only' });
          totalRows += r.n;
        } else {
          review.push({ label: t.label, value: current, rows: r.n, money: r.m, why: 'not in the picker list — left alone' });
        }
        continue;
      }
      if (canon === current) continue;                 // already canonical
      plan.push({ ...t, from: current, to: canon, rows: r.n, money: r.m, why: 'snapped to the picker list' });
      totalRows += r.n;
    }
  }

  // ── Print the plan ───────────────────────────────────────────────────────
  if (!plan.length) {
    console.log('\n  Nothing to change. Every value is already canonical.\n');
  } else {
    // Grouped by the value being landed on, because THE COLLAPSE IS THE THING
    // BEING DECIDED. A flat FROM → TO list makes the reader notice a merge by
    // eye, across pages of output; grouping states it.
    const groups = new Map();
    for (const p of plan) {
      const k = `${p.label}\u0000${p.to}`;
      if (!groups.has(k)) groups.set(k, { label: p.label, to: p.to, sources: [] });
      groups.get(k).sources.push(p);
    }
    const collapses = [...groups.values()].filter(g => g.sources.length > 1);
    console.log(`\n  ${plan.length} value(s) to rewrite, ${totalRows} row(s) total, ` +
                `landing on ${groups.size} target(s) — ${collapses.length} of them a collapse:\n`);

    for (const g of groups.values()) {
      const movedRows  = g.sources.reduce((s, p) => s + p.rows, 0);
      const hasMoney   = g.sources.some(p => p.money != null);
      const movedMoney = hasMoney ? g.sources.reduce((s, p) => s + (p.money || 0), 0) : null;
      const already    = (census.get(g.label) || new Map()).get(g.to) || { n: 0, m: 0 };

      console.log(`  ${g.label}  →  ${JSON.stringify(g.to)}`);
      console.log(g.sources.length > 1
        ? `      ${g.sources.length} values COLLAPSE into this line · ${tally(movedRows, movedMoney)} moving`
        : `      renamed in place, no collapse · ${tally(movedRows, movedMoney)} moving`);
      console.log('');
      for (const p of g.sources) {
        console.log(`      FROM  ${JSON.stringify(p.from)}   ${tally(p.rows, p.money)}   — ${p.why}`);
        console.log(`            ${hexOf(p.from)}`);
      }
      console.log(`      TO    ${JSON.stringify(g.to)}`);
      console.log(`            ${hexOf(g.to)}`);
      console.log('');
      console.log(`      This line after the pass: ${tally(movedRows + already.n,
        hasMoney ? movedMoney + (already.m || 0) : null)}` +
        `   (${tally(already.n, hasMoney ? (already.m || 0) : null)} already on it)`);
      console.log('');
    }
  }

  if (review.length) {
    console.log('  ' + '-'.repeat(74));
    console.log('  REVIEW — untouched, needs a human decision:\n');
    for (const r of review) {
      console.log(`  ${r.label}  ${JSON.stringify(r.value)}  ${tally(r.rows, r.money)} — ${r.why}`);
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

// "3 rows · ¥8,000.00", or "3 rows" where the table has no amount to sum.
// money is null for ingredients and po_line_items by design — see TARGETS.
function tally(rows, money) {
  const r = `${rows} row${rows === 1 ? '' : 's'}`;
  if (money == null) return r;
  return `${r} · ¥${Number(money).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

// Bytes of a string, so two values that look identical can be told apart in the
// terminal. This is the whole reason the defect went unread for months.
function hexOf(s) {
  return Buffer.from(String(s), 'utf8').toString('hex').toUpperCase().replace(/(.{2})/g, '$1 ').trim();
}

main();
