// gzgrocery's statement sheet — read it, and set it beside our own bill.
// docs/tacet-consolidation-decisions.md §430.
//
// ── WHAT THE SHEET IS ──────────────────────────────────────────────────────
// Every few days gzgrocery emails one .xlsx covering several days of orders
// combined. It is their copy of our whole catalogue, one row per product:
//   Product Name | SKU | 名称 | Price (GV website) | Discount | gzgrocery Price | Qty | Original Total | Subtotal
// Qty is filled in only for what they took. The price columns are formulas
// (gzgrocery Price = website price × (1 − discount)), so a cell holds both the
// formula and the value Excel last calculated; we read the value, and work it
// out ourselves only when the file carries none.
//
// Below the catalogue sits a second block — what WE owe THEM (fruit they
// added to a box, dry ice, delivery) and the final net total. Ash: "the
// bottom part need to ignore". It is ignored by construction: none of those
// rows carries one of our product codes, and only rows that do are read.
//
// There are no order numbers on the sheet, so the comparison is per product
// over a range of days. Where a product disagrees, our side lists the GZ-…
// orders its units came from, so the operator can find the one at fault.
//
// ── PRODUCT CODES ──────────────────────────────────────────────────────────
// Typed by hand and inconsistent: "GVF 1-10", "GVF-1-90", "GVF1-120",
// "GVF  1-370", "GV3-252", and one product is "GV 4-200" in the SKU column
// but "GVF 4-200" in 名称. The order reader already solves this for the same
// codes on their website (lib/gzgrocery-admin.js extractSku → "1-10"), and the
// sheet is read the same way, so a product matches here exactly when it would
// match there.

'use strict';

const ExcelJS = require('exceljs');
const { extractSku } = require('./gzgrocery-admin');

// Header cell text → field. Matched on a lowercased, space-collapsed prefix so
// "Price (GV website)", "Original Total " and "gzgrocery Price" all resolve.
const HEADERS = [
  ['product name', 'name'],
  ['sku', 'sku'],
  ['名称', 'name_cn'],
  ['price (gv', 'retail'],
  ['discount', 'discount'],
  ['gzgrocery price', 'gz_price'],
  ['qty', 'qty'],
  ['subtotal', 'subtotal'],
];
const OUR_CODE = /\bGVF?\s*[·\- ]?\s*\d+-\d+/i;
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

/** A cell's value as a plain number/string: a formula's cached result, rich text joined. */
function cellValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) return v.result == null ? null : cellValue(v.result);
    if ('formula' in v || 'sharedFormula' in v) return null;   // no cached value
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
  }
  return v;
}
function num(v) {
  v = cellValue(v);
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[¥￥,\s]/g, '');
  const pct = /%$/.test(s);
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Read one statement workbook.
 * @param buffer  the .xlsx file's bytes
 * @returns {{ lines: Array<{row,sku,name,name_cn,retail,discount,gz_price,qty,subtotal}>,
 *             skipped: Array<{row, reason, text}>, header_row: number }}
 *   `lines` holds only products they took (qty > 0) that carry one of our codes.
 * @throws Error with `.code = 'no_header'` when no header row is found.
 */
async function readStatement(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) { const e = new Error('empty workbook'); e.code = 'no_header'; throw e; }

  // The header: the first row that names both a product column and Qty.
  let headerRow = 0, cols = null;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (headerRow) return;
    const found = {};
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      const t = norm(cellValue(cell.value));
      for (const [h, field] of HEADERS) if (t.startsWith(h) && !(field in found)) found[field] = c;
    });
    if (found.qty && (found.sku || found.name_cn || found.name)) { headerRow = n; cols = found; }
  });
  if (!headerRow) { const e = new Error('no header row with Qty and SKU/名称'); e.code = 'no_header'; throw e; }

  const lines = [], skipped = [];
  const get = (row, field) => (cols[field] ? row.getCell(cols[field]).value : null);
  for (let n = headerRow + 1; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const qty = num(get(row, 'qty'));
    if (!qty) continue;                                  // not taken this time
    const skuText = cellValue(get(row, 'sku'));
    const cnText = cellValue(get(row, 'name_cn'));
    const name = String(cellValue(get(row, 'name')) || '').replace(/\u00a0/g, ' ').trim();
    // Ours only when a GV/GVF code is present — extractSku's own first test.
    const sku = OUR_CODE.test(String(skuText || '')) || OUR_CODE.test(String(cnText || ''))
      ? extractSku(skuText, cnText) : null;
    if (!sku) {
      // Not one of our products: the bottom block (fruit, dry ice, delivery).
      skipped.push({ row: n, reason: 'not_ours', text: String(cnText || name || skuText || '').trim() });
      continue;
    }
    const retail = num(get(row, 'retail'));
    const discount = num(get(row, 'discount'));
    let gz = num(get(row, 'gz_price'));
    if (gz == null && retail != null) gz = retail * (1 - (discount || 0));
    let subtotal = num(get(row, 'subtotal'));
    if (subtotal == null && gz != null) subtotal = gz * qty;
    lines.push({
      row: n, sku, name, name_cn: String(cnText || '').trim(),
      retail, discount,
      gz_price: gz == null ? null : round2(gz),
      qty,
      subtotal: subtotal == null ? null : round2(subtotal),
    });
  }
  return { lines, skipped, header_row: headerRow };
}

/**
 * Set their lines beside ours.
 * @param theirs  readStatement(...).lines
 * @param ours    lib/gzgrocery-billing.js billingRows(...) over the same days
 * @returns {{ rows, totals }}
 *   rows: one per product code on either side, mismatches first. `status` is
 *   'ok' | 'qty' | 'price' | 'qty_price' | 'only_theirs' | 'only_ours'.
 */
function compareStatement(theirs, ours) {
  const key = (sku) => String(sku || '').toUpperCase().replace(/\s+/g, '');
  const T = new Map(), O = new Map();
  for (const l of theirs) {
    const k = key(l.sku);
    const t = T.get(k) || { sku: l.sku, name: l.name || l.name_cn, qty: 0, amount: 0, unit: l.gz_price, rows: [] };
    t.qty += l.qty; t.amount += l.subtotal || 0; t.rows.push(l.row);
    if (t.unit !== l.gz_price) t.unit = l.gz_price;     // a product listed twice keeps the later price
    T.set(k, t);
  }
  for (const r of ours) {
    if (!r.units) continue;
    const k = key(r.sku);
    const o = O.get(k) || { sku: r.sku, name: [r.name_en, r.name_cn].filter(Boolean).join(' '), qty: 0, amount: 0, orders: new Set() };
    o.qty += r.units; o.amount += r.owed || 0;
    for (const no of String(r.orders || '').split(',').filter(Boolean)) o.orders.add(no);
    O.set(k, o);
  }

  const rows = [];
  for (const k of new Set([...T.keys(), ...O.keys()])) {
    const t = T.get(k), o = O.get(k);
    const ourUnit = o && o.qty ? round2(o.amount / o.qty) : null;
    let status;
    if (!o) status = 'only_theirs';
    else if (!t) status = 'only_ours';
    else {
      const qtyOff = t.qty !== o.qty;
      const priceOff = t.unit != null && ourUnit != null && Math.abs(t.unit - ourUnit) >= 0.01;
      status = qtyOff && priceOff ? 'qty_price' : qtyOff ? 'qty' : priceOff ? 'price' : 'ok';
    }
    rows.push({
      sku: (t || o).sku,
      name: (t && t.name) || (o && o.name) || '',
      their_qty: t ? t.qty : 0,
      our_qty: o ? o.qty : 0,
      their_unit: t ? t.unit : null,
      our_unit: ourUnit,
      their_amount: t ? round2(t.amount) : 0,
      our_amount: o ? round2(o.amount) : 0,
      orders: o ? [...o.orders].sort() : [],
      sheet_rows: t ? t.rows : [],
      status,
    });
  }
  const rank = (s) => (s === 'ok' ? 1 : 0);
  rows.sort((a, b) => rank(a.status) - rank(b.status) || String(a.sku).localeCompare(String(b.sku), 'en', { numeric: true }));

  const sum = (f) => round2(rows.reduce((s, r) => s + (r[f] || 0), 0));
  const totals = {
    their_units: sum('their_qty'), our_units: sum('our_qty'),
    their_amount: sum('their_amount'), our_amount: sum('our_amount'),
    mismatches: rows.filter((r) => r.status !== 'ok').length,
  };
  totals.difference = round2(totals.their_amount - totals.our_amount);
  return { rows, totals };
}

/**
 * The days a sheet covers, from its file name — gzgrocery names each file by
 * its range: "GV9.27~9.30.xlsx", "GV9-25+9-26", "GV4月1~4月3". Upload can
 * mangle the separators ("GV9_279_30_" is "GV9.27~9.30" with both dots and the
 * tilde replaced), so a run of digits with no separator left is not guessed at:
 * the operator's own date fields win, and this only fills them when empty.
 * @param name   the uploaded file name
 * @param today  'YYYY-MM-DD' in the shop's day; the year is taken from it, one
 *               year back when the range would otherwise end after today
 * @returns {{from, to} | null}
 */
function rangeFromFilename(name, today) {
  const m = /(\d{1,2})\s*[.\-月/]\s*(\d{1,2})\s*[日号]?\s*[~～\-+至到_]\s*(?:(\d{1,2})\s*[.\-月/]\s*)?(\d{1,2})/
    .exec(String(name || '').replace(/(^|\D)20\d{2}\s*[-年.]\s*/g, '$1'));   // a leading year is not a month
  if (!m) return null;
  const m1 = +m[1], d1 = +m[2], m2 = m[3] ? +m[3] : m1, d2 = +m[4];
  if (!(m1 >= 1 && m1 <= 12 && m2 >= 1 && m2 <= 12 && d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31)) return null;
  let y = +String(today).slice(0, 4);
  const p = (n) => String(n).padStart(2, '0');
  const ymd = (yy, mm, dd) => `${yy}-${p(mm)}-${p(dd)}`;
  if (ymd(y, m2, d2) > today) y -= 1;
  const from = ymd(m2 < m1 ? y - 1 : y, m1, d1), to = ymd(y, m2, d2);
  return from <= to ? { from, to } : null;
}

module.exports = { readStatement, compareStatement, rangeFromFilename };
