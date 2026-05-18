#!/usr/bin/env node
/*
 * Convert a folder tree of GZGrocery XLSX/XLS sales sheets into the
 * periods[] format that scripts/import_gzgrocery.js consumes. Walks
 * every .xls/.xlsx, parses the sheet, infers a date range from the
 * filename + parent folder year, and writes the merged result into
 * scripts/gzgrocery_import.json — preserving the other top-level keys
 * (master_renames, master_joins, sku_aliases, new_variants).
 *
 * Run:
 *   node scripts/convert_gzgrocery_xlsx.js  /path/to/folder
 *   node scripts/convert_gzgrocery_xlsx.js  /path/to/folder  --dry
 *
 * Idempotent — repeated runs replace prior periods with the same date
 * range. Run with --dry to just preview without writing.
 */
const path = require('path');
const fs   = require('fs');
const XLSX = require('xlsx');

const ROOT = process.argv[2] || '/Users/ash/Desktop/gzgrocery超市';
const DRY  = process.argv.includes('--dry');
const CONFIG_PATH = path.join(__dirname, 'gzgrocery_import.json');

// ── Walk: collect every xls/xlsx file under ROOT ───────────────────
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.xlsx?$/i.test(e.name)) out.push(p);
  }
  return out;
}

// ── Year inference from any ancestor folder name (e.g. GV2025年9月份).
function inferYear(filePath) {
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    const m = part.match(/(\d{4})\s*年/);
    if (m) return parseInt(m[1], 10);
  }
  // Bare folders like "7月" / "8月超市" mean 2025 (the loose dump
  // predates the explicitly-yeared GV2025年9月份 folder and is older).
  return 2025;
}

// ── Filename → { from, to } as YYYY-MM-DD.
// Handles:
//   GV4月1~4月3.xlsx           → 4/1 .. 4/3
//   GV4月11号~4月14号.xlsx     → 4/11 .. 4/14
//   GV4月15~4月17.xlsx         → 4/15 .. 4/17
//   GV9-25+9-26.xlsx           → 9/25 .. 9/26
//   GV-9-20.xlsx               → 9/20 .. 9/20
//   GV9-1.xlsx                 → 9/1 .. 9/1
//   7-1.xls                    → 7/1 .. 7/1
//   7-14-15.xls                → 7/14 .. 7/15
//   12月31号.xlsx              → 12/31 .. 12/31
function parseDateRange(filePath) {
  const year = inferYear(filePath);
  let name = path.basename(filePath, path.extname(filePath));
  // Strip leading "GV" / "GVF" prefixes plus separators.
  name = name.replace(/^GVF?[\s\-_]*/, '').trim();
  // Strip trailing 模板 (template) marker if present.
  name = name.replace(/GV模板$/, '').trim();
  // Try patterns from most-specific to least.
  // (a0) YYYY-M-D号~M-D号  ("2026-2-22号~2-27号" — explicit year prefix)
  let m = name.match(/^(\d{4})-(\d{1,2})-(\d{1,2})号?\s*[~～\-]\s*(\d{1,2})-(\d{1,2})号?/);
  if (m) {
    return rangePair(+m[1], +m[2], +m[3], +m[1], +m[4], +m[5]);
  }
  // (a0b) YYYY-M-D  ("2026-2-28")
  m = name.match(/^(\d{4})-(\d{1,2})-(\d{1,2})号?/);
  if (m) {
    return rangePair(+m[1], +m[2], +m[3], +m[1], +m[2], +m[3]);
  }
  // (a) X月Y[号]~X月Z[号]
  m = name.match(/(\d{1,2})月(\d{1,2})号?\s*[~～\-]\s*(\d{1,2})月(\d{1,2})号?/);
  if (m) {
    const [, m1, d1, m2, d2] = m;
    return rangePair(year, +m1, +d1, year, +m2, +d2);
  }
  // (b) X月Y~Z  (same month on both sides)
  m = name.match(/(\d{1,2})月(\d{1,2})号?\s*[~～\-]\s*(\d{1,2})号?/);
  if (m) {
    const [, mm, d1, d2] = m;
    return rangePair(year, +mm, +d1, year, +mm, +d2);
  }
  // (b2) M-D号~D号  ("7-16号~20号" — month-dash-day-号 then range-end day-号)
  m = name.match(/^(\d{1,2})-(\d{1,2})号?\s*[~～]\s*(\d{1,2})号?$/);
  if (m) {
    const [, mm, d1, d2] = m;
    return rangePair(year, +mm, +d1, year, +mm, +d2);
  }
  // (c) X月Y号? (single day)
  m = name.match(/(\d{1,2})月(\d{1,2})号?$/);
  if (m) {
    return rangePair(year, +m[1], +m[2], year, +m[1], +m[2]);
  }
  // (d) M-D+M-D  ("9-25+9-26")
  m = name.match(/(\d{1,2})-(\d{1,2})\s*[+]\s*(\d{1,2})-(\d{1,2})/);
  if (m) {
    return rangePair(year, +m[1], +m[2], year, +m[3], +m[4]);
  }
  // (e) M-D~M-D  ("10-14~10-17")
  m = name.match(/(\d{1,2})-(\d{1,2})\s*[~～\-]\s*(\d{1,2})-(\d{1,2})/);
  if (m) {
    return rangePair(year, +m[1], +m[2], year, +m[3], +m[4]);
  }
  // (f) M-D-D (single dash range like "7-14-15" → m=7, d1=14, d2=15)
  m = name.match(/^(\d{1,2})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, mm, d1, d2] = m;
    // Heuristic: if d2 is reasonable as a day-of-month (<=31) and > d1, it's a range.
    if (+d2 <= 31 && +d2 > +d1) return rangePair(year, +mm, +d1, year, +mm, +d2);
  }
  // (g) M-D (single day, like "9-1" or "10-1")
  m = name.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return rangePair(year, +m[1], +m[2], year, +m[1], +m[2]);
  }
  return null;
}

function rangePair(y1, m1, d1, y2, m2, d2) {
  const pad = n => String(n).padStart(2, '0');
  const from = `${y1}-${pad(m1)}-${pad(d1)}`;
  const to   = `${y2}-${pad(m2)}-${pad(d2)}`;
  // midpoint = halfway between (used as the canonical date on sales_entries).
  const ms = (new Date(from + 'T00:00:00Z').getTime() + new Date(to + 'T00:00:00Z').getTime()) / 2;
  const mid = new Date(ms).toISOString().slice(0, 10);
  return { from, to, midpoint: mid };
}

// ── Parse the SKU out of the 名称 (Chinese name) column.
// Examples seen in the wild (after stripping the GVF / GV brand prefix):
//   "GVF 1-10中东鹰嘴豆泥"                  → 1-10
//   "GVF P-54 1-52 花椰菜红薯红咖喱+1-24"  → P-54  (prefer combo code over members)
//   "GV 1-225"                              → 1-225
//   "EXT-1229649 …"                         → EXT-1229649
function extractSku(cnName) {
  if (!cnName) return null;
  const s = String(cnName);
  // P-NNN (combo packs) — highest priority because the line represents the pack.
  const p = s.match(/\bP-(\d+)\b/);
  if (p) return 'P-' + p[1];
  // EXT-NNNNNN (external IDs from prior imports / Zoho).
  const ext = s.match(/\bEXT-(\d+)\b/);
  if (ext) return 'EXT-' + ext[1];
  // Standard N-N (catches "1-10", "1-225", "3-170", etc).
  const std = s.match(/\b(\d+)-(\d+)\b/);
  if (std) return std[1] + '-' + std[2];
  return null;
}

// ── Parse a money string like "¥38.0 " → 38.0
function money(s) {
  if (s === '' || s == null) return 0;
  const n = parseFloat(String(s).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : 0;
}
// Parse a percent string like "20%" → 0.2
function pct(s) {
  if (s === '' || s == null) return 0;
  const n = parseFloat(String(s).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n / 100 : 0;
}

// ── Parse one workbook → array of sale rows.
function parseWorkbook(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const sales = [];
  let headerSeen = false;
  for (const row of rows) {
    const a = String(row[0] || '').trim();
    const b = String(row[1] || '').trim();
    // Skip the header row (Product Name / 名称).
    if (!headerSeen) {
      if (a === 'Product Name' || b === '名称') { headerSeen = true; continue; }
    }
    // Skip total / blank lines.
    if (!a && !b) continue;
    if (b === 'Total' || a === 'Total') continue;
    const qtyRaw = row[5];
    const qty = parseFloat(qtyRaw);
    if (!isFinite(qty) || qty <= 0) continue;
    const sku = extractSku(b);
    if (!sku) continue;
    const priceOrig = money(row[2]);
    const discount  = pct(row[3]);
    const price     = money(row[4]);
    const subtotal  = money(row[7]);
    sales.push({
      sku,
      name_en: a || null,
      name_cn: b.replace(/^GVF?\s*/, '').replace(/^P-\d+\s*/, '').replace(/^\d+-\d+\s*/, '').trim() || null,
      price,
      price_orig: priceOrig,
      discount,
      qty,
      subtotal,
    });
  }
  return sales;
}

// ── Main.
const files = walk(ROOT);
console.log(`Found ${files.length} spreadsheet file(s) under ${ROOT}`);

const periodByKey = new Map();  // "from|to" → { from, to, midpoint, sales[], _sources[] }
const skipped = [];
for (const f of files) {
  const dr = parseDateRange(f);
  if (!dr) { skipped.push({ file: f, reason: 'no date range' }); continue; }
  let sales;
  try { sales = parseWorkbook(f); }
  catch (e) { skipped.push({ file: f, reason: 'parse error: ' + e.message }); continue; }
  if (sales.length === 0) { skipped.push({ file: f, reason: 'no rows with qty > 0' }); continue; }
  const key = dr.from + '|' + dr.to;
  let p = periodByKey.get(key);
  if (!p) {
    p = { ...dr, sales: [], _sources: [] };
    periodByKey.set(key, p);
  }
  p.sales.push(...sales);
  p._sources.push(path.basename(f));
}

const periods = [...periodByKey.values()]
  .sort((a, b) => a.from.localeCompare(b.from))
  .map(({ _sources, ...rest }) => rest);

console.log(`Parsed ${periods.length} period(s) from ${files.length - skipped.length} file(s).`);
if (skipped.length) {
  console.log(`Skipped ${skipped.length} file(s):`);
  skipped.forEach(s => console.log(`  · ${path.basename(s.file)} — ${s.reason}`));
}

// Coverage summary
let totalRows = 0, totalQty = 0, totalSubtotal = 0;
const skuSet = new Set();
for (const p of periods) {
  totalRows += p.sales.length;
  for (const s of p.sales) {
    totalQty += s.qty;
    totalSubtotal += s.subtotal;
    skuSet.add(s.sku);
  }
}
console.log(`\nTotals: ${totalRows} sale rows · ${totalQty} units · ¥${totalSubtotal.toFixed(2)}`);
console.log(`Distinct SKUs: ${skuSet.size}`);

// Show first few periods preview
console.log('\nFirst 5 periods:');
periods.slice(0, 5).forEach(p => console.log(`  ${p.from} → ${p.to} · ${p.sales.length} rows`));
if (periods.length > 5) console.log(`  … plus ${periods.length - 5} more`);

if (DRY) {
  console.log('\n[dry-run] not writing config file.');
  process.exit(0);
}

// Merge into existing config, replacing the periods array.
const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
existing.periods = periods;
fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2));
console.log(`\n✅ Wrote ${periods.length} period(s) to ${CONFIG_PATH}`);
console.log(`   Other config keys preserved: master_renames, sku_aliases, new_variants, …`);
