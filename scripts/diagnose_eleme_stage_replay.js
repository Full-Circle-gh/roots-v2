#!/usr/bin/env node
/**
 * Replay every ARCHIVED Eleme order payload through the NEW parser, and say what
 * the fixed reader would make of it: which field it takes the stage from, what
 * that stage maps to internally, and what it reads as the ETA.
 *
 * WHY THIS, AND WHY NOW. dd3ccaa taught lib/eleme-browser.js to read the order's
 * lifecycle stage instead of the "VALID" validity flag. But
 * diagnose_eleme_status_now.js has just shown that NOTHING has been re-read
 * since: the last order_import and the last channel_status write are both
 * 2026-09-03 09:37:16, and the live order list has come back with no rows on
 * every poll since the deploy — legitimately, because Eleme's in-progress tab is
 * empty when nothing is cooking. So the fix has not yet met a live order and
 * cannot be judged by the screen.
 *
 * The archive can judge it now. eleme_order_import.raw_payload is the verbatim
 * platform order row, and this runs the CHECKOUT's parser over it (the ro-query
 * workflow stages lib/ from the repository, not from the box), so what prints
 * below is what the deployed code will do to the next real order.
 *
 * IT ALSO HUNTS THE ETA, and that is not a side quest. channel_eta is NULL on
 * all five mirrored orders, which means ETA_KEYS misses Eleme's payload exactly
 * as STATUS_KEYS did — and /api/internal/eleme/auto-deliver-past-eta, the half of
 * the fix that lands an order after it drops off the in-progress tab, requires a
 * non-empty channel_eta. With none, that endpoint is inert by construction and an
 * order that ages off the tab stays wherever it was. So every timestamp-shaped
 * field in the payload is printed with its path: naming the real one is what
 * makes that sweep work rather than merely exist.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * PATHS AND SHAPES, NOT PEOPLE — the Tier 3 rule the other captures here follow.
 * A value is printed verbatim only when it is safely an enum, a timestamp, a
 * number or a boolean. Anything else is reported as its path plus a redaction
 * that states the shape, which is all these questions need.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_stage_replay.js
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
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

// The parser under test — from the CHECKOUT (ROOTS_HOME), which is the point.
const { ElemeBrowser } = require(path.join(HOME, 'lib', 'eleme-browser.js'));
const b = new ElemeBrowser('replay', '0');
b._log = () => {};

// internalStatusForChannel, lifted out of the route by source rather than
// required — requiring the route would pull in express and open the database
// through the seam. Same lift scripts/test_eleme_order_parse.js uses.
const fs = require('fs');
const SRC = fs.readFileSync(path.join(HOME, 'routes', 'eleme-internal.js'), 'utf8');
function lift(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('could not find ' + name);
  let depth = 0, i = SRC.indexOf('{', start);
  const open = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function('return function ' + name + '(desc) ' + SRC.slice(open, i + 1))();
}
const internalStatusForChannel = lift('internalStatusForChannel');
const isConfirmedVoid = lift('isConfirmedVoid');

console.log('db:   ' + DB_PATH);
console.log('code: ' + HOME + '  (the checkout under test)');
console.log('now:  ' + new Date().toISOString() + '\n');

// ── Redaction, same policy as diagnose_eleme_courier_status.js ──────────────
const TIMESTAMP = /^\d{4}[-/]\d{2}[-/]\d{2}([ T][\d:]+(\.\d+)?Z?)?$/;
const PERSON_KEY = /(name|contact|person|user|receiver|consignee|recipient|customer|buyer|phone|mobile|address|addr)/i;
const ORG_KEY = /(carrier|fleet|company|team|shop|store|brand|platform|channel|merchant)/i;
function render(key, v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (TIMESTAMP.test(s)) return JSON.stringify(s);
  if (PERSON_KEY.test(key) && !ORG_KEY.test(key)) return `«${s.length} chars under a *${key}* key, REDACTED»`;
  if (/^[A-Za-z][A-Za-z0-9_ -]{0,30}$/.test(s)) return JSON.stringify(s);   // an enum
  if (/^[一-鿿（）()·、,，:：\s]{1,24}$/.test(s)) return JSON.stringify(s); // a CN label
  if (/^\d{1,15}$/.test(s)) return JSON.stringify(s);
  return `«${s.length} chars, not an enum — REDACTED»`;
}

// Walk every leaf with its full path. Arrays take one representative element, so
// an eight-line basket cannot bury the order-level fields this is looking for.
function leaves(value, p, out) {
  if (value === undefined) return out;
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      if (value.length) leaves(value[0], `${p}[0]`, out);
      return out;
    }
    for (const [k, v] of Object.entries(value)) leaves(v, p ? `${p}.${k}` : k, out);
    return out;
  }
  out.push({ path: p, key: p.split('.').pop().replace(/\[0\]$/, ''), value });
  return out;
}

// A value that could be a delivery time: an ISO-ish stamp, or an epoch in
// seconds or milliseconds inside a plausible window (2020-2035).
function timeShaped(v) {
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n * 1000;
    if (ms > 1577836800000 && ms < 2051222400000) return new Date(ms).toISOString();
    return null;
  }
  const s = String(v);
  return TIMESTAMP.test(s) ? s : null;
}

const rows = db.prepare(`
  SELECT i.rowid, i.eleme_order_id, i.retail_order_id, i.store_code, i.status AS import_status,
         i.raw_payload, i.detail_json,
         o.order_no, o.status, o.channel_status, o.channel_eta, o.placed_at, o.delivered_at
    FROM eleme_order_import i
    LEFT JOIN retail_orders o ON o.id = i.retail_order_id
   ORDER BY i.rowid DESC
`).all();
console.log(`${rows.length} archived payload(s)\n`);

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

for (const r of rows) {
  console.log('═'.repeat(72));
  console.log(`${r.order_no || '(no order)'}  eleme_id=${r.eleme_order_id}  import=${r.import_status}  store=${r.store_code}`);
  console.log(`  STORED NOW:   status=${r.status}  channel_status=${JSON.stringify(r.channel_status)}  channel_eta=${r.channel_eta === null ? 'NULL' : JSON.stringify(r.channel_eta)}`);

  const raw = parse(r.raw_payload);
  if (!raw) {
    console.log(`  raw_payload does not parse (${r.raw_payload ? String(r.raw_payload).length + ' chars, likely truncated at the 20000 cap' : 'absent'}) — nothing to replay`);
    continue;
  }

  // The parser under test, on the real row.
  let o = null;
  try { o = b._normalizeOrder(raw); } catch (e) { console.log(`  _normalizeOrder threw: ${e.message}`); }
  if (o) {
    const mapped = internalStatusForChannel(o.statusDesc);
    console.log(`  NEW PARSER:   statusDesc=${JSON.stringify(o.statusDesc)}`);
    console.log(`                from ${o.statusKeyPath || '(nothing)'}   isStage=${o.statusIsStage}`);
    console.log(`                → internal status: ${mapped === null ? 'null (order would stay where it is)' : mapped}`
      + `   confirmedVoid=${isConfirmedVoid(o.statusDesc)}`);
    console.log(`                eta=${o.eta === null ? 'NULL' : JSON.stringify(o.eta)}   placedAt=${JSON.stringify(o.placedAt)}`);
  }

  // What the payload actually carries, for the two fields that decide all this.
  const all = leaves(raw, '', []);
  const statusish = all.filter(l => /(status|state|stage|node|phase|desc)/i.test(l.key));
  console.log(`  STATUS-SHAPED FIELDS (${statusish.length}):`);
  for (const l of statusish) console.log(`     ${l.path} = ${render(l.key, l.value)}`);

  const timeish = all.map(l => ({ ...l, iso: timeShaped(l.value) })).filter(l => l.iso);
  console.log(`  TIME-SHAPED FIELDS (${timeish.length}) — the ETA sweep needs one of these:`);
  for (const l of timeish) console.log(`     ${l.path} = ${l.iso}`);
  console.log('');
}

console.log('done.');
