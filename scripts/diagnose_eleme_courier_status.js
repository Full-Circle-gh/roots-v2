#!/usr/bin/env node
/**
 * Print the COURIER-BEARING and STATUS-BEARING SHAPE of the archived Eleme order
 * payloads: every field whose key names a rider, a courier, a delivery leg or a
 * status, with the full path that reaches it.
 *
 * WHY THIS EXISTS. scripts/diagnose_eleme_payload_shape.js captured the MONEY
 * shape of these same payloads and nothing else — by design, its filter is
 * `(fee|amount|total|price|pay|income|discount|subsidy)` and it counts every
 * other key without showing it. That capture settled the total-vs-fee bug and
 * PR #200's fee columns. It cannot answer either of the two questions now
 * holding up PR #208, because both are about keys it deliberately never prints:
 *
 *   1. Does Eleme's payload carry a RIDER — a name, a phone, a status, an ETA —
 *      and at exactly which paths? routes/eleme-internal.js writes no rider
 *      field at all, and lib/eleme-browser.js's _normalizeOrder harvests none:
 *      its only phone is `phoneMasked` (PHONE_KEYS), which is the CUSTOMER's
 *      隐私号, not a rider's. So "the parser has no rider field" is already
 *      known and proves nothing about the payload — the parser reads ~20 keys
 *      out of a 15,000-char envelope. Only the archive can say.
 *
 *   2. What is the FULL SET of status strings Eleme actually sends? The live
 *      rows hold the literal string "VALID" in channel_status, which
 *      channelStatusMeta (public/retail-admin/04-orders.js:320) matches against
 *      neither MT_STATUS nor any of its Chinese keyword arms, so it falls
 *      through to the default and renders "In progress" on a delivered order.
 *      Mapping needs the whole vocabulary, not the one value we happened to see.
 *
 * WHERE IT LOOKS. `eleme_order_import.raw_payload` is `safeJson(order.raw)` —
 * the verbatim Tier 0 LIST envelope for that order, capped at 20000 chars
 * (scripts/eleme-daemon.js:134, :360). `detail_json` is the parsed field set,
 * and carries the Tier 1 DETAIL envelope under `.detail` only when a detail read
 * succeeded — on ids 1502/1538 detail_json is 222 chars, i.e. `detail` is null
 * and the list envelope is the only payload there is. Both are walked here, and
 * each hit is labelled with which of the two it came from, because "Eleme does
 * not send a rider" and "we never archived the call that would have carried one"
 * are different findings with different fixes.
 *
 * PATHS AND SHAPES, NOT PEOPLE. The Tier 3 rule in scripts/eleme-daemon.js's
 * header applies here exactly as it does in the money capture. A value is
 * printed verbatim ONLY when it is safely an enum, a number, a boolean or a
 * timestamp. Anything phone-shaped or name-shaped is reported as its PATH plus a
 * redaction that states the shape — «phone-shaped, 11 digits, REDACTED» — which
 * is the whole of what question 1 needs: whether a rider phone exists, and where.
 * Nobody has to see the number to answer that, so nobody does. Status values ARE
 * printed in full: platform status vocabulary is not personal data, and question
 * 2 is unanswerable without it.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs. The five tombstoned
 * eleme_order_import rows (retail_order_id NULL) are READ, and clearly labelled
 * as such — they are extra payloads bearing on the same question and reading
 * them writes nothing.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_courier_status.js
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH + '\n');

// ── What counts as a hit ────────────────────────────────────────────────────
// Deliberately generous, and deliberately NOT the candidate lists in
// lib/eleme-browser.js: the point is to find the field nobody guessed, so the
// filter must not encode the same guesses that missed it. Both the English and
// the Chinese vocabulary, because Eleme's envelopes mix them.
const COURIER_KEY = /(rider|knight|courier|carrier|deliver|delivery|logistic|transport|shipper|dispatch|fleet|driver|骑手|配送|运力|送餐|派送)/i;
const STATUS_KEY  = /(status|state|stage|phase|desc|label|node|progress)/i;
// A key that names a courier but holds money — the money capture already owns
// those, and re-printing deliveryFee here buries the fields this exists to find.
const COURIER_MONEY = /(fee|amount|price|total|pay|income|discount|subsidy)/i;

// ── Redaction ───────────────────────────────────────────────────────────────
// A CN mobile, a landline, or a 隐私号 (a masked number, often with a `,`/`-`
// extension). Matched on the digits so a formatted number cannot slip through.
function phoneShaped(s) {
  const digits = String(s).replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 20) return null;
  if (/^1[3-9]\d{9}$/.test(digits)) return `phone-shaped, CN mobile, ${digits.length} digits`;
  if (/[,\-#转]/.test(String(s)) && digits.length >= 9) return `phone-shaped, masked/extension, ${digits.length} digits`;
  if (/^\d{7,12}$/.test(digits) && /^[\d\s()+,\-#]+$/.test(String(s))) return `phone-shaped, ${digits.length} digits`;
  return null;
}
// A timestamp. Checked BEFORE the phone rule, because "2026-09-01 12:40:00" has
// fourteen digits and an ETA is not a phone number.
const TIMESTAMP = /^\d{4}[-/]\d{2}[-/]\d{2}([ T][\d:]+(\.\d+)?Z?)?$/;
// A key naming a PERSON. These are the only keys whose short value is assumed to
// be somebody's name — the shape cannot decide it, because 已送达 and 王师傅 are
// both three CJK characters and only one of them is a person.
const PERSON_KEY = /(name|contact|person|user|receiver|consignee|recipient|customer|buyer)/i;
// …except where the same key names an ORGANISATION. 蜂鸟专送 is a fleet, not a
// courier's name, and withholding it costs the report a real fact for no gain.
const ORG_KEY = /(carrier|fleet|company|team|shop|store|brand|platform|channel|merchant)/i;
// A platform status LABEL: short, and either an ASCII enum or a Chinese phrase.
function statusLabel(s) {
  return s.length <= 24 && (/^[A-Za-z][A-Za-z0-9_ -]*$/.test(s) || /^[一-鿿（）()·、,，]{2,24}$/.test(s));
}
// Safe to print verbatim whatever the key: an enum, a timestamp, a bare number.
function safeVerbatim(s) {
  if (s.length > 40) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(s)) return true;   // VALID, ORDER_COMPLETED
  if (TIMESTAMP.test(s)) return true;
  if (/^\d+$/.test(s)) return true;               // a numeric code
  return false;
}
// One value, rendered for the console under the redaction rules above. The ORDER
// of these arms IS the policy: a timestamp can look like a phone, and a status
// label can look like a name, so the key decides where the shape cannot.
function render(key, v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (TIMESTAMP.test(s)) return JSON.stringify(s);
  // A person-named key is never printed, whatever it holds.
  if (PERSON_KEY.test(key) && !ORG_KEY.test(key)) {
    const ph = phoneShaped(s);
    return `«${ph || `name-shaped (under a *${key}* key), ${s.length} chars`}, REDACTED»`;
  }
  const ph = phoneShaped(s);
  if (ph) return `«${ph}, REDACTED»`;
  // A status- or organisation-named key holding a label: printed, because
  // platform status vocabulary is the whole of what question 2 is asking for
  // and it is not personal data.
  if ((STATUS_KEY.test(key) || ORG_KEY.test(key)) && statusLabel(s)) return JSON.stringify(s);
  if (safeVerbatim(s)) return JSON.stringify(s);
  return `«${s.length} chars, not an enum — REDACTED»`;
}

// Walk every leaf, keeping the full path. Arrays take one representative element
// (as the money capture does) so an eight-line basket cannot bury the
// order-level fields this exists to find.
function leaves(value, path, out) {
  if (value === undefined) return out;
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      if (value.length) leaves(value[0], `${path}[0]`, out);
      if (value.length > 1) out.arraysCollapsed++;
      return out;
    }
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
    return out;
  }
  const key = path.split('.').pop().replace(/\[0\]$/, '');
  out.total++;
  if (COURIER_KEY.test(key) && !COURIER_MONEY.test(key)) out.courier.push({ path, key, value });
  else if (STATUS_KEY.test(key)) out.status.push({ path, key, value });
  return out;
}
const fresh = () => ({ courier: [], status: [], total: 0, arraysCollapsed: 0 });
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ── The rows ────────────────────────────────────────────────────────────────
// Every Eleme order with an archive, plus the import rows that never became an
// order. LEFT JOIN from the import side so a tombstoned row (retail_order_id
// NULL) is included: it is another payload bearing on the same question, and
// reading it changes nothing.
const rows = db.prepare(`
  SELECT i.rowid            AS import_rowid,
         i.eleme_order_id,
         i.retail_order_id,
         i.store_code,
         i.status           AS import_status,
         i.raw_payload,
         i.detail_json,
         LENGTH(i.raw_payload) AS raw_len,
         LENGTH(i.detail_json) AS det_len,
         o.id, o.order_no, o.status, o.channel_status, o.channel_status_at,
         o.channel_eta, o.channel_preorder_at,
         o.channel_rider_name, o.channel_rider_status, o.channel_rider_status_code,
         o.channel_rider_assigned_at, o.channel_rider_fetched_at,
         o.recipient_name, o.recipient_phone
    FROM eleme_order_import i
    LEFT JOIN retail_orders o ON o.id = i.retail_order_id
   ORDER BY i.retail_order_id IS NULL, i.retail_order_id DESC
`).all();

console.log(`${rows.length} eleme_order_import row(s)`
  + ` — ${rows.filter(r => r.retail_order_id != null).length} joined to an order,`
  + ` ${rows.filter(r => r.retail_order_id == null).length} tombstoned (retail_order_id NULL)\n`);

// Across every payload: which courier path appeared, how often, and in what
// shape. This table is the answer to question 1.
const courierPaths = new Map();
// Every distinct status VALUE, with the paths that carried it. This table is the
// answer to question 2.
const statusValues = new Map();

// A live delivery_jobs row is what renderReadonlyOrder's courier card is
// actually gated on (routes/retail.js builds `o.courier` from one, and nothing
// else). Counted here so the report says outright whether any Eleme order has
// one, rather than leaving it to be inferred from the payload.
const jobStmt = db.prepare('SELECT COUNT(*) AS n FROM delivery_jobs WHERE retail_order_id = ?');

for (const r of rows) {
  const label = r.retail_order_id == null
    ? `(tombstoned import — eleme_order_id ${r.eleme_order_id}, no retail_orders row, READ ONLY)`
    : `${r.order_no}  (id ${r.id}, ${r.status})`;
  console.log(label);

  if (r.retail_order_id != null) {
    let jobs = 'n/a';
    try { jobs = String(jobStmt.get(r.retail_order_id).n); }
    catch (e) { jobs = 'delivery_jobs unreadable'; }
    console.log(`  what the ROW holds today:`);
    console.log(`    channel_status = ${render('channel_status', r.channel_status)}`
              + `   channel_eta = ${render('channel_eta', r.channel_eta)}`);
    console.log(`    channel_rider_name = ${render('name', r.channel_rider_name)}`
              + `   channel_rider_status = ${render('status', r.channel_rider_status)}`
              + `   channel_rider_status_code = ${render('code', r.channel_rider_status_code)}`);
    console.log(`    recipient_phone = ${render('phone', r.recipient_phone)}`
              + `   delivery_jobs rows = ${jobs}`
              + `   ${jobs === '0' ? '  <<< no waybill — renderReadonlyOrder shows NO courier card' : ''}`);
  }

  console.log(`  raw_payload: ${r.raw_len == null ? 'NULL' : r.raw_len + ' chars'}`
    + (r.raw_len >= 20000 ? '  ** AT THE 20000-CHAR CAP — TRUNCATED, fields may be missing **' : '')
    + `   detail_json: ${r.det_len == null ? 'NULL' : r.det_len + ' chars'}`);

  const sources = [];
  const raw = parseJson(r.raw_payload);
  if (r.raw_payload && !raw) console.log('  (raw_payload did not parse — truncation, most likely)');
  if (raw) sources.push({ src: 'raw', doc: raw });
  const det = parseJson(r.detail_json);
  // The Tier 1 detail envelope, when one was archived. Walked separately and
  // labelled `detail`, because a rider that appears ONLY here means the field
  // exists but the list poll never sees it — a different fix from "Eleme sends
  // no rider at all".
  if (det && det.detail) sources.push({ src: 'detail', doc: det.detail });
  else if (det) console.log('  (detail_json carries no `.detail` — the Tier 1 envelope was never archived on this row)');

  if (!sources.length) { console.log(''); continue; }

  for (const { src, doc } of sources) {
    const out = leaves(doc, src, fresh());
    console.log(`  ${src}: ${out.total} leaf value(s), ${out.courier.length} courier-named, ${out.status.length} status-named`
      + (out.arraysCollapsed ? `, ${out.arraysCollapsed} array element(s) collapsed` : ''));
    for (const h of out.courier.sort((a, b) => a.path.localeCompare(b.path))) {
      const shown = render(h.key, h.value);
      console.log(`    COURIER  ${h.path} = ${shown}`);
      const e = courierPaths.get(h.path) || { n: 0, shapes: new Set() };
      e.n++; e.shapes.add(shown.startsWith('«') ? shown.slice(1, -1) : typeof h.value);
      courierPaths.set(h.path, e);
    }
    for (const h of out.status.sort((a, b) => a.path.localeCompare(b.path))) {
      const shown = render(h.key, h.value);
      console.log(`    STATUS   ${h.path} = ${shown}`);
      // Only a value we were willing to print is a value worth tallying as
      // vocabulary — a redacted one is not a status label.
      if (!shown.startsWith('«')) {
        const e = statusValues.get(shown) || { n: 0, paths: new Set() };
        e.n++; e.paths.add(h.path);
        statusValues.set(shown, e);
      }
    }
  }
  console.log('');
}

// ── Question 1: is there a rider, and where ─────────────────────────────────
console.log('── every courier-named path, across all payloads ─────────────');
if (!courierPaths.size) {
  console.log('   NONE. No key naming a rider, courier, delivery leg or dispatch');
  console.log('   appears anywhere in any archived Eleme payload.');
  console.log('   → Eleme sends us no rider. There is no phone to surface, and no');
  console.log('     placeholder may be invented for one. Report this before #208 ships.');
} else {
  console.log('   seen   path                                        shape');
  for (const [path, e] of [...courierPaths.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
    console.log(`   ${String(e.n).padStart(4)}   ${path.padEnd(43)} ${[...e.shapes].join(' | ')}`);
  }
  console.log('');
  console.log('   A row reading "phone-shaped … REDACTED" IS a rider phone: the path is');
  console.log('   real and the value was withheld on purpose. Nothing above needs to be');
  console.log('   un-redacted to decide whether the capability exists.');
}
console.log('');

// ── Question 2: the whole status vocabulary ─────────────────────────────────
console.log('── every distinct status value, across all payloads ──────────');
if (!statusValues.size) {
  console.log('   NONE printable.');
} else {
  console.log('   seen   value                     paths');
  for (const [val, e] of [...statusValues.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
    console.log(`   ${String(e.n).padStart(4)}   ${val.padEnd(25)} ${[...e.paths].join(', ')}`);
  }
}
console.log('');
console.log('This is the vocabulary a status map has to cover — all of it, not the');
console.log('subset anyone can guess. lib/eleme-browser.js STATUS_KEYS ends in the bare');
console.log('`status`, and pick() tries every candidate at each sub-object before');
console.log('descending, so whichever `status` sits shallowest is what reached');
console.log('channel_status — the same position-beats-priority read that made a');
console.log('discount the order total. The paths column above says which one won.');
