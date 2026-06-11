// Apply OUT1N yogurt variant price/stock/weight onto the 6 store draft rows.
// Explicit mapping (small→130g, medium→230g, big→500g). Usage: --dry | --apply
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
const APPLY = process.argv.includes('--apply');

// id → {price, compare, stock, weight}  (from OUT1N detail priceExts)
const MAP = {
  260: { label: 'Plain 230g',   price: 44, compare: null, stock: 44, weight: 0.7 },
  261: { label: 'Plain 500g',   price: 83, compare: 95,   stock: 40, weight: 1.0 },
  262: { label: 'Vanilla 130g', price: 29, compare: null, stock: 40, weight: null },
  263: { label: 'Vanilla 230g', price: 48, compare: null, stock: 6,  weight: 0.5 },
  264: { label: 'Peach 130g',   price: 29, compare: null, stock: 67, weight: 0.5 },
  265: { label: 'Peach 230g',   price: 48, compare: null, stock: 70, weight: 0.5 },
};

const get = db.prepare('SELECT id,name_en,retail_price,compare_at_price,retail_stock,weight FROM store_products WHERE id=?');
for (const id of Object.keys(MAP)) {
  const m = MAP[id]; const cur = get.get(id);
  if (!cur) { console.log(id, 'NOT FOUND'); continue; }
  console.log(`${APPLY ? 'SET' : 'plan'} ${id} ${cur.name_en}  →  ${m.label}: ¥${m.price}${m.compare ? ' (was ¥' + m.compare + ')' : ''} stk${m.stock} wt${m.weight ?? '-'}`);
  if (APPLY) {
    const sets = ['retail_price=?', 'compare_at_price=?', 'retail_stock=?']; const params = [m.price, m.compare, m.stock];
    if (m.weight != null) { sets.push('weight=?'); params.push(m.weight); }
    params.push(id);
    db.prepare(`UPDATE store_products SET ${sets.join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...params);
  }
}
console.log(APPLY ? 'APPLIED' : 'DRY-RUN (no writes)');
