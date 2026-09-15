/* Which block fields does anybody actually fill in?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Ash, on the mini app editor: *"at the mini app editor there are too many
 * functions per block maybe? or different way to present it so it will be
 * easy?"* — with the "maybe" doing real work. Before folding a field away or
 * deleting it, it is worth knowing whether anyone has ever used it. A field
 * nobody has filled in is a field to REMOVE; a field everybody fills is an
 * essential and must stay at the top. Only the data can tell the two apart,
 * and guessing from the editor's source cannot.
 *
 * It also answers the same question for the product page editor, which was
 * not asked about but is about to be redesigned beside it.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   mini app pages   storefront_config, the `*.layout` and `cms.draft.*_layout`
 *                    keys — the published and draft block stacks per page.
 *   product pages    store_products.description_blocks.
 * Both are the office's own layout choices. NO CUSTOMER DATA of any kind is
 * read: no orders, names, addresses or payments.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 * Per block type, every field the editor OFFERS, with how many placed blocks
 * carry a non-empty value for it, sorted commonest first. Three verdicts:
 *
 *   KEEP UP TOP   filled on most of the blocks that use this type
 *   FOLD          filled sometimes — belongs under "More options"
 *   NEVER USED    offered by the editor, filled by nobody, ever
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It changes nothing, and it does not decide anything. NEVER USED is a
 * candidate for deletion, not a verdict: a field can be new, or seasonal, or
 * the one thing that matters to the one shop that uses it. Read the list with
 * somebody who knows the shops.
 *
 *   node scripts/diagnose_block_field_usage.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
// Prove the handle cannot write before reading a single row, the way
// diagnose_qr_menu_detail_blocks.js does. A diagnostic that merely INTENDS to
// be read-only is a diagnostic somebody will later add a write to.
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
  console.log('WARNING: this handle accepted a write. Stopping rather than reading live data.');
  process.exit(1);
} catch (e) {
  console.log('read-only proven — write rejected: ' + String(e.message).split('\n')[0] + '\n');
}

// ── What the editors OFFER ────────────────────────────────────────────────
// cms.html writes every field through updateBlock(b.id, { field: … }) inside
// one buildXForm per block type, so the offered set is readable from source.
// Reading it from source rather than hardcoding a list means a field added
// tomorrow shows up here as NEVER USED instead of silently not being counted.
function offeredByMiniApp() {
  const src = fs.readFileSync(path.join(HOME, 'public/cms.html'), 'utf8');
  const out = {};
  for (const m of src.matchAll(/case '([a-z_]+)':\s*(build\w+Form)\(/g)) {
    const [, type, fn] = m;
    const i = src.indexOf('function ' + fn + '(');
    if (i < 0) continue;
    const open = src.indexOf('{', i);
    let depth = 0, k = open;
    for (; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}' && --depth === 0) break;
    }
    const body = src.slice(open, k);
    out[type] = new Set([...body.matchAll(/updateBlock\(b\.id,\s*\{\s*([a-z_0-9]+)/g)].map(x => x[1]));
  }
  return out;
}

// ── What the data USES ────────────────────────────────────────────────────
const filled = (v) => {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'boolean') return v === true;   // false is "not set"
  return true;                                      // a number, including 0
};

function tally(blocks, into) {
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || !b.type) continue;
    const t = (into[b.type] ||= { placed: 0, fields: {} });
    t.placed++;
    for (const [k, v] of Object.entries(b)) {
      if (k === 'type' || k === 'id') continue;
      t.fields[k] ||= 0;
      if (filled(v)) t.fields[k]++;
    }
  }
}

const parse = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

const miniApp = {};
let layoutKeys = 0;
try {
  for (const r of db.prepare(
    `SELECT key, value_json FROM storefront_config
      WHERE key LIKE '%.layout' OR key LIKE 'cms.draft.%_layout'`).all()) {
    layoutKeys++;
    tally(parse(r.value_json), miniApp);
  }
} catch (e) {
  console.log('could not read storefront_config: ' + e.message + '\n');
}

const product = {};
let productRows = 0;
try {
  for (const r of db.prepare(
    `SELECT description_blocks AS b FROM store_products WHERE description_blocks IS NOT NULL`).all()) {
    productRows++;
    tally(parse(r.b), product);
  }
} catch (e) {
  console.log('could not read store_products: ' + e.message + '\n');
}

// ── Report ────────────────────────────────────────────────────────────────
function report(title, tallies, offered, note) {
  const types = Object.keys(tallies).sort();
  console.log('\n' + '═'.repeat(74) + '\n' + title + '\n' + note + '\n' + '═'.repeat(74));
  if (!types.length) { console.log('  no blocks found'); return; }
  let neverUsedTotal = 0, fieldTotal = 0, thinTypes = 0;
  for (const type of types) {
    const t = tallies[type];
    const off = offered && offered[type];
    const names = new Set([...Object.keys(t.fields), ...(off || [])]);
    fieldTotal += names.size;
    const rows = [...names].map(f => ({ f, n: t.fields[f] || 0 }))
      .sort((a, b) => b.n - a.n || a.f.localeCompare(b.f));
    /* A TYPE PLACED TWICE PROVES NOTHING, and saying "NEVER USED" about it
       would be the report lying with a straight face. Below the floor every
       verdict is withheld rather than softened: the honest answer to "should
       we delete this field?" on a sample of two is "this cannot tell you". */
    const THIN = 5;
    const thin = t.placed < THIN;
    if (thin) thinTypes++;
    console.log(`\n  ${type}   — placed ${t.placed}\u00d7, ${names.size} fields` +
                (thin ? `   (too few to judge — under ${THIN} placements)` : ''));
    for (const { f, n } of rows) {
      const pct = t.placed ? Math.round((n / t.placed) * 100) : 0;
      let verdict;
      if (thin) verdict = n === 0 ? 'unused here, sample too small' : 'used';
      else if (n === 0) { verdict = 'NEVER USED'; neverUsedTotal++; }
      else if (pct >= 60) verdict = 'keep up top';
      else verdict = 'fold';
      const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·');
      console.log(`    ${f.padEnd(22)} ${String(n).padStart(4)}/${String(t.placed).padEnd(4)} ` +
                  `${String(pct).padStart(3)}%  ${bar}  ${verdict}`);
    }
  }
  console.log(`\n  ${neverUsedTotal} of ${fieldTotal} offered fields have never been filled in by anybody` +
              (thinTypes ? `, across the ${types.length - thinTypes} type(s) placed often enough to say.` : '.'));
  if (thinTypes) {
    console.log(`  ${thinTypes} type(s) are placed too rarely to judge at all — listed, not scored.`);
  }
}

report('MINI APP PAGES  (public/cms.html)',
  miniApp, offeredByMiniApp(),
  `  read from ${layoutKeys} layout key(s) in storefront_config — published and draft`);
report('PRODUCT PAGES  (public/product-editor.html)',
  product, null,
  `  read from ${productRows} product(s) carrying description_blocks\n` +
  `  offered-field list not extracted for this editor: its inspector is one\n` +
  `  branching function rather than one per type, so only USED fields appear`);

console.log('\nNothing was changed. NEVER USED is a candidate for deletion, not a verdict —\n' +
            'read it with somebody who knows the shops before cutting anything.\n');
