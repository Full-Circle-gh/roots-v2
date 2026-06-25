// Remap House Care how_to_use tile icons (food emojis → cleaning icons, by label).
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');

const MAP = [
  [/dish/i, '🍽️'],
  [/glass|window|mirror|chrome|tapware/i, '🪟'],
  [/toilet/i, '🚽'],
  [/bathroom|shower|wet hands/i, '🚿'],
  [/floor/i, '🧹'],
  [/laundr|detergent|soaker|washer|loader|\bload\b|powder|whites|colou?rs/i, '🧺'],
  [/produce|fruit|veg/i, '🥬'],
  [/hand\s?wash|hand\s?soap|\bhands\b|lather/i, '🧼'],
  [/pump|foam/i, '🧴'],
  [/stain|brush|scrub/i, '🪥'],
  [/soak/i, '🪣'],
  [/spray/i, '🧴'],
  [/polish|streak|sparkle|shine|finish|booster|brighter|whiter/i, '✨'],
  [/wipe/i, '🧽'],
  [/rinse|dilute|\bfill\b|flush|moisten|\bwater\b|measure|\bmix\b/i, '💧'],
  [/scent|fresh/i, '🌿'],
  [/temperature|\bhot\b|\bcold\b|\bHE\b|adjust|any temp/i, '🌡️'],
  [/label|direction|refer|follow|check/i, '🏷️'],
  [/\bwait\b|\bmin\b/i, '⏱️'],
  [/repeat/i, '🔄'],
];
const DEFAULT = '🫧';
const FOOD = new Set(['🥘', '🥗', '🥣', '🔥', '🍲', '🍳', '🧁', '🥤', '🥄', '♨']);
function pick(label) {
  const l = label || '';
  for (const [re, ic] of MAP) if (re.test(l)) return ic;
  return DEFAULT;
}

const rows = db.prepare("SELECT id,name_en,description_blocks FROM store_products WHERE subcategory='House Care' AND is_published=1 ORDER BY name_en").all();
let n = 0; const rep = [];
for (const row of rows) {
  let b; try { b = JSON.parse(row.description_blocks || '[]'); } catch (e) { rep.push('!! BADJSON ' + row.id); continue; }
  let changed = false;
  const how = b.find(x => x.type === 'how_to_use');
  let preview = [];
  if (how && Array.isArray(how.tiles)) {
    for (const t of how.tiles) {
      const ni = pick(t.label_en);
      if (ni !== t.icon) { preview.push((t.icon || '?') + '→' + ni + ' ' + (t.label_en || '')); t.icon = ni; changed = true; }
    }
  }
  // storage icons: replace any food emoji with neutral
  const st = b.find(x => x.type === 'storage_box');
  if (st) { for (const side of ['left', 'right']) { if (st[side] && FOOD.has(st[side].icon)) { st[side].icon = side === 'left' ? '🧴' : '✨'; changed = true; } } }
  if (changed) {
    rep.push('#' + row.id + ' ' + (row.name_en || '').slice(0, 26).padEnd(27) + (preview.length ? (' [' + preview.join(', ') + ']') : ''));
    if (APPLY) {
      try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
      fs.writeFileSync('backups/hci_' + row.id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks }));
      db.prepare("UPDATE store_products SET description_blocks=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), row.id);
      n++;
    }
  } else { rep.push('#' + row.id + ' ' + (row.name_en || '').slice(0, 26) + ' (no change)'); }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' house-care icon fixes ==') : '== DRY (set APPLY=1) ==');
