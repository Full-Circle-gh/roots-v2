#!/usr/bin/env node
/*
 * For every GZGrocery sales SKU that doesn't resolve in the products
 * table, suggest the closest existing product to alias it to — by
 * comparing the GZGrocery product name (EN + CN) against the products
 * table, then breaking ties by price.
 *
 * Output: writes scripts/gzgrocery_alias_suggestions.json AND prints
 * a human-readable report. Nothing is written to the products table.
 * The user reviews + edits, then we merge confirmed entries into
 * gzgrocery_import.json under `sku_aliases` and re-run the importer.
 *
 * Run on prod (where the live DB is):
 *   node scripts/suggest_gzgrocery_aliases.js
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const CONFIG_PATH = path.join(__dirname, 'gzgrocery_import.json');
const OUT_PATH    = path.join(__dirname, 'gzgrocery_alias_suggestions.json');
const DB_PATH     = path.join(__dirname, '..', 'data', 'roots.db');

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const db  = new Database(DB_PATH, { readonly: true });

const products = db.prepare(`
  SELECT id, sku, name_en, name_cn, sell_price
    FROM products
   WHERE COALESCE(is_active, 1) = 1
`).all();

// ── Aggregate the unresolved-SKU rows from the config ─────────────
// For each missing SKU we keep: total qty, avg price, all distinct
// EN names and CN names seen (so we can match against any of them).
const aliases = cfg.sku_aliases || {};
const products_by_sku = new Map(products.map(p => [p.sku, p]));
const variants = new Set((cfg.new_variants || []).map(v => v.sku));
const renames = new Set(Object.values(cfg.master_renames || {}));

function isResolvable(sku) {
  if (products_by_sku.has(sku)) return true;
  if (variants.has(sku)) return true;
  if (renames.has(sku)) return true;
  const aliased = aliases[sku];
  if (aliased && (products_by_sku.has(aliased) || variants.has(aliased))) return true;
  return false;
}

const skuStats = new Map();
for (const period of cfg.periods || []) {
  for (const s of period.sales || []) {
    const sku = s.sku;
    if (isResolvable(sku)) continue;
    let st = skuStats.get(sku);
    if (!st) {
      st = { sku, names_en: new Set(), names_cn: new Set(), prices: [], qty: 0, rows: 0 };
      skuStats.set(sku, st);
    }
    if (s.name_en) st.names_en.add(s.name_en);
    if (s.name_cn) st.names_cn.add(s.name_cn);
    if (s.price_orig > 0) st.prices.push(s.price_orig);
    else if (s.price > 0) st.prices.push(s.price);
    st.qty += s.qty || 0;
    st.rows += 1;
  }
}

console.log(`Unresolved SKUs in sales: ${skuStats.size}`);
console.log(`Products in catalogue: ${products.length}`);
console.log();

// ── Similarity scoring ────────────────────────────────────────────
// Token-based Jaccard for the English name (split on non-letters,
// lowercased), plus n-gram (2-3 char shingles) overlap for Chinese.
// Combined score weighted 60% language match + 40% price proximity.
function tokensEn(s) {
  if (!s) return new Set();
  return new Set(String(s).toLowerCase().match(/[a-z]+/g) || []);
}
function ngramsCn(s, n = 2) {
  if (!s) return new Set();
  // Strip parens / digits / whitespace / common noise words first
  const clean = String(s)
    .replace(/[（）()【】\[\]\d\s·,，.。]/g, '')
    .replace(/冷藏|冷冻|常温|无麸质|纯素|有机/g, '');
  const out = new Set();
  for (let i = 0; i + n <= clean.length; i++) out.add(clean.slice(i, i + n));
  return out;
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

function score(stat, prod) {
  // Best-of EN match across all EN names we saw for this SKU.
  let enScore = 0;
  const pEnT = tokensEn(prod.name_en);
  for (const name of stat.names_en) {
    const s = jaccard(tokensEn(name), pEnT);
    if (s > enScore) enScore = s;
  }
  // Best-of CN match (2-grams).
  let cnScore = 0;
  const pCnG = ngramsCn(prod.name_cn);
  for (const name of stat.names_cn) {
    const s = jaccard(ngramsCn(name), pCnG);
    if (s > cnScore) cnScore = s;
  }
  // Use the higher of the two (CN tends to be more reliable on this dataset).
  const lang = Math.max(enScore, cnScore);
  // Price proximity — only meaningful when both sides have a price.
  let priceMatch = 0;
  if (stat.prices.length && prod.sell_price > 0) {
    const avg = stat.prices.reduce((a, b) => a + b, 0) / stat.prices.length;
    const ratio = Math.min(avg, prod.sell_price) / Math.max(avg, prod.sell_price);
    priceMatch = ratio; // 1.0 = identical, 0.5 = 2x off, etc.
  }
  return {
    score: lang * 0.65 + priceMatch * 0.35,
    enScore, cnScore, priceMatch,
  };
}

// ── Pick best candidates for each unresolved SKU ──────────────────
const suggestions = [];
const sortedStats = [...skuStats.values()].sort((a, b) => b.qty - a.qty);
for (const stat of sortedStats) {
  const ranked = products
    .map(p => ({ p, ...score(stat, p) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const best = ranked[0];
  const avgPrice = stat.prices.length
    ? Math.round((stat.prices.reduce((a, b) => a + b, 0) / stat.prices.length) * 100) / 100
    : null;
  suggestions.push({
    gz_sku: stat.sku,
    qty: stat.qty,
    rows: stat.rows,
    gz_name_en: [...stat.names_en][0] || null,
    gz_name_cn: [...stat.names_cn][0] || null,
    gz_avg_price: avgPrice,
    top: ranked.map(r => ({
      sku: r.p.sku,
      name_en: r.p.name_en,
      name_cn: r.p.name_cn,
      sell_price: r.p.sell_price,
      score: Math.round(r.score * 1000) / 1000,
      enScore: Math.round(r.enScore * 1000) / 1000,
      cnScore: Math.round(r.cnScore * 1000) / 1000,
      priceMatch: Math.round(r.priceMatch * 1000) / 1000,
    })),
    suggested: best && best.score > 0.18
      ? { sku: best.p.sku, score: Math.round(best.score * 1000) / 1000 }
      : null,
  });
}

fs.writeFileSync(OUT_PATH, JSON.stringify({ generated_at: new Date().toISOString(), suggestions }, null, 2));

// ── Human-readable summary ────────────────────────────────────────
// Buckets: HIGH (score >= 0.5), MED (0.3–0.5), LOW (0.18–0.3),
// NONE (<0.18). The thresholds are tuned to be cautious — only HIGH
// auto-confirms; everything else needs eyeballs.
const high = [], med = [], low = [], none = [];
for (const s of suggestions) {
  const sc = s.suggested?.score || 0;
  if (sc >= 0.5)       high.push(s);
  else if (sc >= 0.3)  med.push(s);
  else if (sc >= 0.18) low.push(s);
  else                 none.push(s);
}
function fmtCandidate(t) {
  const sku = String(t.sku || '—').padEnd(8);
  const price = `¥${String((t.sell_price||0).toFixed(0)).padStart(4)}`;
  const en = String(t.name_en||'').slice(0,38).padEnd(38);
  const cn = String(t.name_cn||'');
  return `${sku} ${price}  ${en} ${cn}`;
}
function dump(bucket, label) {
  console.log(`\n── ${label} (${bucket.length}) ────────────────────────`);
  for (const s of bucket) {
    const headline = `${s.gz_sku.padEnd(7)} qty=${String(s.qty).padStart(3)} ¥${String(s.gz_avg_price||'?').padStart(5)} · ${(s.gz_name_en||'').slice(0,38)} / ${(s.gz_name_cn||'').slice(0,30)}`;
    console.log(headline);
    for (let i = 0; i < s.top.length; i++) {
      const c = s.top[i];
      const tag = i === 0 ? '★' : ' ';
      console.log(`  ${tag} score=${c.score.toFixed(3)} (cn=${c.cnScore.toFixed(2)} en=${c.enScore.toFixed(2)} px=${c.priceMatch.toFixed(2)})  ${fmtCandidate(c)}`);
    }
  }
}

dump(high, 'HIGH confidence — likely safe to auto-alias');
dump(med,  'MEDIUM confidence — eyeball each');
dump(low,  'LOW confidence — probably wrong, but here\'s the closest');
console.log(`\n── NO MATCH (${none.length}) — no candidate scored above 0.18 ──`);
for (const s of none) {
  console.log(`${s.gz_sku.padEnd(7)} qty=${String(s.qty).padStart(3)} ¥${String(s.gz_avg_price||'?').padStart(5)} · ${(s.gz_name_en||'').slice(0,50)} / ${(s.gz_name_cn||'').slice(0,30)}`);
}

console.log(`\nFull report written to ${OUT_PATH}`);
console.log(`Buckets: HIGH ${high.length} · MED ${med.length} · LOW ${low.length} · NONE ${none.length}`);
