#!/usr/bin/env node
// One-shot: set the Full Circle brand colours on the existing HOME-page
// mini-app CMS blocks. Writes the DRAFT layout only — review in /cms and
// hit Publish to go live. Idempotent: re-running produces the same result.
//
// Usage:
//   node scripts/apply_home_brand_colors.js --dry      # preview, no write
//   node scripts/apply_home_brand_colors.js            # write the draft
//   node scripts/apply_home_brand_colors.js --db /path/to/roots.db
//
// Only colour fields are touched; every other block field is preserved.
// Only block types listed in MAP are modified; anything else is left alone.

const path = require('path');
const Database = require('better-sqlite3');

const DRAFT_KEY = 'cms.draft.home_layout';
const LIVE_KEY  = 'home.layout';
const BY = 'brand-color-script';

// Brand-token → field map per block type. Values are brand tokens the
// renderer resolves to hex (block-renderer.js), except raw hex (#FFFFFF)
// which the renderer passes through — used for the white featured card,
// since the palette has no pure-white token.
const MAP = {
  announcement_bar: { bg_color: 'forest-kale', fg_color: 'oat-milk' },
  greeting:         { bg_color: 'forest-kale', fg_color: 'oat-milk', accent_color: 'lime-leaf' },
  hero_banner:      { panel_bg_color: 'lime-leaf', panel_fg_color: 'ink' }, // applies in Split layout
  category_tabs:    { bg_color: 'oat-milk' },
  featured_item:    { bg_color: 'oat-milk', card_bg_color: '#FFFFFF', card_fg_color: 'ink' },
  product_grid:     { bg_color: 'oat-milk' },
  bundle:           { bg_color: 'forest-kale', fg_color: 'oat-milk', accent_color: 'lime-leaf' },
  flash_sale_strip: { bg_color: 'carrot-blaze', fg_color: 'ink' },
  coupon_block:     { bg_color: 'berry-punch', fg_color: 'ink', accent_color: 'ink' },
  recipe_story:     { bg_color: 'oat-milk', fg_color: 'ink' },
  points_widget:    { bg_color: 'lime-leaf', fg_color: 'ink', accent_color: 'ink' },
  order_tracker:    { accent_color: 'lime-leaf' }, // progress bar + action button
  review_card:      { bg_color: 'forest-kale', fg_color: 'oat-milk' },
  affiliate_block:  { bg_color: 'forest-kale', fg_color: 'oat-milk', accent_color: 'lime-leaf' },
  wecom_contact:    { bg_color: 'forest-kale', fg_color: 'oat-milk', accent_color: 'lime-leaf' },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry');
const DB_PATH = arg('--db', path.join(__dirname, '..', 'data', 'roots.db'));

const db = new Database(DB_PATH);

function readLayout(key) {
  const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return null;
  try { const v = JSON.parse(row.value_json); return Array.isArray(v) ? v : null; }
  catch { return null; }
}

// Base off the draft if it has blocks, else the published layout.
let base = readLayout(DRAFT_KEY);
let source = DRAFT_KEY;
if (!base || !base.length) { base = readLayout(LIVE_KEY); source = LIVE_KEY; }
if (!base) { console.error(`No home layout found (neither ${DRAFT_KEY} nor ${LIVE_KEY}).`); process.exit(1); }

console.log(`DB: ${DB_PATH}`);
console.log(`Base layout: ${source} (${base.length} blocks)\n`);
console.log('Block types found on Home:');
console.log('  ' + base.map(b => b.type).join('\n  ') + '\n');

let touched = 0;
const next = base.map(b => {
  const fields = MAP[b.type];
  if (!fields) return b;
  const changes = [];
  const patched = { ...b };
  for (const [k, v] of Object.entries(fields)) {
    if (patched[k] !== v) changes.push(`${k}: ${patched[k] ?? '∅'} → ${v}`);
    patched[k] = v;
  }
  if (changes.length) {
    touched++;
    console.log(`• ${b.type} (${b.id})`);
    changes.forEach(c => console.log(`    ${c}`));
  }
  return patched;
});

const skipped = [...new Set(base.filter(b => !MAP[b.type]).map(b => b.type))];
if (skipped.length) console.log(`\nLeft untouched (no colour rule): ${skipped.join(', ')}`);

console.log(`\n${touched} block(s) would change.`);

if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }

db.prepare(
  `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
   VALUES (?, ?, CURRENT_TIMESTAMP, ?)
   ON CONFLICT(key) DO UPDATE SET
     value_json = excluded.value_json,
     updated_at = CURRENT_TIMESTAMP,
     updated_by = excluded.updated_by`
).run(DRAFT_KEY, JSON.stringify(next), BY);

console.log(`\nWrote DRAFT → ${DRAFT_KEY}. Review in /cms and hit Publish to go live.`);
