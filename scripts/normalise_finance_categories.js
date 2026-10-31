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
 * ── EACH TARGET SNAPS AGAINST ITS OWN LIST, NEVER THE OTHER ONE'S ──────────
 * Three columns share one vocabulary — `categories` where kind='accounting',
 * the picker the ingredient form and the PO line offer. `income_entries.category`
 * does not: income categories moved server-side onto the same `categories`
 * table under kind='income' (decisions §36, *Income categories move
 * server-side*), a list of its own, doing a different job. Before this fix the
 * script read ONE master (kind='accounting') and matched all four columns
 * against it — so an income value one spacing/radical edit away from an
 * expense category would snap onto the expense spelling, moving it onto the
 * wrong list's vocabulary. That is the exact collision the server-side move
 * exists to prevent, found building it (§36 v4.119) and never applied: the
 * script is dry-run by default and had never been run with --apply. Each
 * target now reads its OWN master by its OWN `kind`, and the two are never
 * compared against each other.
 *
 * ── THE INCOME MASTER SHIPS EMPTY, AND EMPTY IS NOT A FAULT ────────────────
 * §36 ships `kind='income'` empty by decision — no defaults seeded, so a
 * dropdown never offers a wrong option (the ¥152,309 Mini App mis-filing was
 * exactly that). An empty accounting master IS a fault: the script's whole
 * purpose is to snap known variant families onto that list, so having none
 * means it cannot do its job at all, and it refuses to run, exactly as
 * before. An empty INCOME master is not the same failure — it is the shipped,
 * intended state — so income_entries.category is SKIPPED rather than
 * refused: printed as its own block, plainly, with the row count and the
 * reason, and every other target still runs. Ash's ruling, 2026-09-02: not
 * refuse, not proceed silently, not treat an empty master as an error. The
 * moment a tenant creates their first income category, the master stops
 * being empty and this same script starts evaluating it exactly like any
 * other target — nothing here is a one-time carve-out.
 *
 * A COLLIDING income master — two entries differing only by spacing or case,
 * so there is no single canonical value — is treated exactly like a colliding
 * accounting master: a hard refusal, because that is a genuine fault (a
 * decision about the vocabulary nobody made yet), not the shipped empty
 * state. Ash's ruling was about EMPTY specifically; this extends the
 * PRE-EXISTING collision refusal to the income list on the same terms it
 * already applies to the accounting one, rather than inventing a second rule.
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
 * The canonical value is whichever member of the family EXISTS IN THE TARGET'S
 * OWN PICKER LIST — `categories` where kind matches the column: kind='accounting'
 * for the three expense-side columns, kind='income' for income_entries.category.
 * The accounting list is the vocabulary the ingredient form and the PO line
 * offer, and it is clean: zero of its 31 rows carry a radical. Every bad value
 * in the data arrived from somewhere that is not the picker.
 *
 * So the script does not rank variants, guess at majorities, or prefer the
 * commoner spelling. It asks the picker — EACH COLUMN'S OWN PICKER. A family
 * whose members are ALL absent from its target's picker is reported and NOT
 * changed — there is nothing to snap to.
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
//
// `kind` is which `categories` list the column snaps against — the master-list
// bug this file exists to fix. The three expense-side columns share the
// tenant's accounting vocabulary; income_entries.category has its own, server
// -side since decisions §36 *Income categories move server-side*, and the two
// must never be compared against each other.
const TARGETS = [
  { table: 'ingredients',    column: 'accounting_category', label: 'ingredients.accounting_category', kind: 'accounting' },
  { table: 'po_line_items',  column: 'expense_category',    label: 'po_line_items.expense_category',  kind: 'accounting' },
  { table: 'expense_entries',column: 'category',            label: 'expense_entries.category', money: true, kind: 'accounting' },
  { table: 'income_entries', column: 'category',            label: 'income_entries.category',  money: true, kind: 'income' },
];

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Set ROOTS_DB to override.`);
    process.exit(1);
  }
  // Opened read-only for the dry run so a plan can never write by accident.
  const db = new Database(DB_PATH, APPLY ? {} : { readonly: true });
  db.pragma('foreign_keys = ON');

  // ── The authority: EACH target's own picker list, never the other one's ──
  // loadMaster reads `categories` for one `kind` and returns its rows plus a
  // spacingKey → name map, keyed the same way normaliseCategory's caller reads
  // it below. Called once per kind actually used by TARGETS — today that is
  // 'accounting' and 'income' — so a future kind added to TARGETS is read
  // automatically rather than needing a second copy of this block.
  function loadMaster(kind) {
    const list = db.prepare('SELECT name FROM categories WHERE kind = ? ORDER BY name').all(kind).map(r => r.name);
    // Keyed on spacingKey, so two picker entries that differ only by spacing or
    // case share a key — collected here rather than silently overwritten, so
    // the caller can refuse rather than let the Map keep an arbitrary winner.
    const grouped = new Map();
    for (const name of list) {
      const k = spacingKey(name);
      if (k === null) continue;   // malformed, not a collision — see below
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(name);
    }
    const collisions = [...grouped.entries()].filter(([, names]) => names.length > 1);
    const byKey = new Map();
    for (const name of list) byKey.set(spacingKey(name), name);
    return { kind, list, byKey, collisions };
  }

  // Prints the same "REFUSING TO RUN" block the accounting master has always
  // produced on a collision, parameterised so the income master can be refused
  // on identical terms — a colliding master is a genuine fault (a vocabulary
  // decision nobody made yet) regardless of which kind it is, so this is the
  // one existing rule applied twice, not a second rule invented for income.
  function refuseOnCollision(m) {
    console.error('');
    console.error('  REFUSING TO RUN — the picker list has entries that differ only by');
    console.error('  spacing or case, so there is no single canonical value to snap onto.');
    console.error('');
    for (const [k, names] of m.collisions) {
      console.error(`  shared key ${JSON.stringify(k)}`);
      for (const n of names) {
        console.error(`      ${JSON.stringify(n)}`);
        console.error(`      ${hexOf(n)}`);
      }
      console.error('');
    }
    console.error('  No plan was produced. Resolve the duplicates in `categories`');
    console.error(`  (kind='${m.kind}') — which of them is the real category is a`);
    console.error('  decision about the vocabulary, not one this script can make.');
    console.error('');
    db.close();
    process.exit(1);
  }

  let accounting, income;
  try {
    accounting = loadMaster('accounting');
    income     = loadMaster('income');
  } catch (e) {
    console.error('Could not read the categories master list:', e.message);
    console.error('Refusing to run — canonical values come from that list and nowhere else.');
    process.exit(1);
  }

  // ── The accounting master: unchanged from before this fix ────────────────
  // Empty or colliding blocks the whole run, exactly as it always has — this
  // is the well-established list the script's own purpose depends on, and
  // that behaviour is not what §36 v4.119 asked to change.
  if (!accounting.list.length) {
    console.error('The categories master list (kind=accounting) is EMPTY.');
    console.error('Refusing to run — there is nothing to snap onto, and guessing a canonical');
    console.error('value from the data is exactly what this script exists not to do.');
    process.exit(1);
  }
  if (accounting.collisions.length) refuseOnCollision(accounting);

  // ── The income master: empty is the SHIPPED state, not a fault ───────────
  // §36 v4.119 / Ash, 2026-09-02: skip income_entries.category entirely while
  // its master is empty — not a refusal, not silent, not an error. A colliding
  // income master is a different thing (a real fault, not the intended empty
  // state) and is refused on the same terms as the accounting list above.
  let incomeSkipReason = null;
  if (income.collisions.length) {
    refuseOnCollision(income);
  } else if (!income.list.length) {
    incomeSkipReason = "the income master list (kind='income') is empty — §36 ships it "
      + 'that way by decision, so this is the shipped state and not a fault. There is '
      + 'nothing to snap income onto yet; this target is left entirely untouched until '
      + 'a tenant creates its first income category, at which point it is evaluated like '
      + 'any other target.';
  }

  const mastersByKind = { accounting: accounting.byKey, income: income.byKey };

  console.log('='.repeat(78));
  console.log(`  Finance category normalisation — ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`);
  console.log(`  Database : ${DB_PATH}`);
  console.log(`  Accounting master : ${accounting.list.length} categories (kind='accounting')`
    + ' — ingredients, po_line_items, expense_entries');
  console.log(`  Income master     : ${income.list.length} categories (kind='income') — income_entries`
    + (incomeSkipReason ? '  [SKIPPED — see below]' : ''));
  console.log('='.repeat(78));

  // ── Build the plan ───────────────────────────────────────────────────────
  const plan    = [];   // { label, table, column, from, to, rows, money, why }
  const review  = [];   // { label, value, rows, money, why }   money: null off-ledger
  const skipped = [];   // { label, rows, why } — a whole target, not evaluated
  let totalRows = 0;

  // label → (value → { n, m }). Used to price the target line a collapse lands
  // on: the post-merge total is what moves PLUS what already sits there.
  const census = new Map();

  for (const t of TARGETS) {
    // A target whose kind is skipped (today: income, while its master is
    // empty) is not evaluated AT ALL — no snap attempt, no glyph/whitespace
    // repair, nothing added to plan, review or census. Only its row count is
    // read, so the SKIPPED block below can say plainly how much was left
    // alone and why, per Ash's ruling: not silent, not an error.
    if (t.kind === 'income' && incomeSkipReason) {
      let n = 0;
      try {
        n = db.prepare(
          `SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.column} IS NOT NULL AND TRIM(${t.column}) <> ''`
        ).get().n;
      } catch (e) {
        // The count is informational only; a read failure here does not
        // escalate to a refusal — the skip notice still explains why nothing
        // ran, just without a row count.
      }
      skipped.push({ label: t.label, rows: n, why: incomeSkipReason });
      continue;
    }
    const masterByKey = mastersByKind[t.kind];
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

  // Printed BEFORE review: a skip is a statement about a whole target, made
  // before this run even looked at its values, and reads differently from a
  // per-value question the pass DID look at and could not resolve.
  if (skipped.length) {
    console.log('  ' + '-'.repeat(74));
    console.log('  SKIPPED — not evaluated. Not a refusal, not an error:\n');
    for (const s of skipped) {
      console.log(`  ${s.label}  ${tally(s.rows, null)}`);
      console.log(`      ${s.why}`);
    }
    console.log('');
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
