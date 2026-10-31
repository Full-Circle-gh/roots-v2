// Bring the national-fallback delivery zone's lead in line with the new
// outside-GZ rule: earliest = today + 1 (to match the "Express delivery
// (1–2 days)" copy shown at checkout).
//
// matchDeliveryZone() synthesizes the "Rest of China" zone from the
// `delivery.defaultZone` config row (storefront_config). The route code now
// defaults a missing min_lead_days to 1, but if the stored JSON pins an older
// value (e.g. 3) that wins — so patch the stored value too.
//
// Idempotent: re-running just re-asserts min_lead_days=1. No-ops if the config
// row is absent or already 1. Backs up the DB first.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

const row = db.prepare(
  "SELECT value_json FROM storefront_config WHERE key = 'delivery.defaultZone'"
).get();

if (!row) {
  console.log('No delivery.defaultZone config row — nothing to patch (code default is 1).');
  process.exit(0);
}

let cfg;
try { cfg = JSON.parse(row.value_json); }
catch (e) { console.error('Could not parse delivery.defaultZone JSON:', e.message); process.exit(1); }

const before = cfg.min_lead_days;
if (before === 1) {
  console.log('delivery.defaultZone.min_lead_days already 1 — no change.');
  process.exit(0);
}

const backup = DB_PATH.replace(/\.db$/, `-pre-defzonelead-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

cfg.min_lead_days = 1;
db.prepare(
  "UPDATE storefront_config SET value_json = ? WHERE key = 'delivery.defaultZone'"
).run(JSON.stringify(cfg));

console.log(`Patched delivery.defaultZone.min_lead_days: ${before == null ? '(unset)' : before} → 1`);
