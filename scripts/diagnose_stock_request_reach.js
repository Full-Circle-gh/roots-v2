#!/usr/bin/env node
// READ-ONLY. A shop pressed "Ask for stock". Where did the request go?
//
//   node scripts/diagnose_stock_request_reach.js
//   node scripts/diagnose_stock_request_reach.js RS-260920-001
//
// THE REPORT THIS ANSWERS, from Ash on 2026-09-20: Yuexiu asked Tianhe for
// stock, nothing printed at Tianhe, and nothing appeared on the asking phone.
// The row is written either way — POST /api/restock never fails quietly — so
// the question is never "was it saved", it is WHO COULD HAVE SEEN IT.
//
// A store->store request reaches exactly one screen: the Pick screen in Tacet
// Mobile, filtered on `from_store_id` (the SUPPLIER). Five independent things
// can empty that screen, each silently, and any one alone is enough:
//
//   1. THE PAIR. from_store_id / to_store_id are what the Pick screen filters
//      on. A row with them NULL falls back to the role pair, which points at
//      "the warehouse" and not at a shop.
//   2. THE SWEEP. Every `tab=active` fetch archives any open non-kitchen
//      request whose creation day is earlier than today. A request raised in
//      the evening is gone from the supplier's list by morning.
//   3. THE CAPABILITY. The Pick screen and the 'sent' push both key on
//      `restock:pick`. The `store_stock` preset does NOT hold it — by design
//      ("dispatching a run to another location is the manager's call") — so a
//      shop staffed by shelf clerks has nobody who can open the screen.
//   4. THE SCOPE. An operator pinned to a set of stores is not told about work
//      at a store they cannot act on. A picker scoped away from the supplier
//      is skipped by the same rule that protects them from noise.
//   5. THE PHONE. A push needs VAPID keys AND a registered subscription. With
//      neither, sendPushToOperatorsWithCaps logs and returns, which nobody
//      reads.
//
// It reports all five per request, plus what the supplying shop's printer is
// set to, because "no paper" has its own answer: until §198 a transfer printed
// nowhere at all, by omission rather than by decision.
//
// Mutates nothing, and proves it: the connection is opened readonly and a
// write is attempted before anything else runs.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const WANTED = (process.argv[2] || '').trim();
const db = new Database(DB_PATH, { readonly: true });

try {
  db.prepare('CREATE TABLE IF NOT EXISTS _ro_probe_rs (x INTEGER)').run();
  console.log('!! ABORT: this connection accepted a write. Refusing to report.');
  process.exit(2);
} catch (e) {
  console.log(`read-only proven (${String(e.message).slice(0, 60)}…)\n`);
}

const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const cfg = (key, fallback = null) => {
  try {
    const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return r ? JSON.parse(r.value_json) : fallback;
  } catch (_) { return fallback; }
};
const storeName = (id) => {
  if (!id) return null;
  try {
    const r = db.prepare('SELECT code, name_en, name_cn FROM retail_stores WHERE id = ?').get(id);
    return r ? `${r.name_cn || r.name_en || r.code} (#${id})` : `#${id} — NO SUCH STORE`;
  } catch (_) { return `#${id}`; }
};

console.log(`DB : ${DB_PATH}`);
console.log('='.repeat(78));

// ── 0 · the shops, so every id below reads as a name ──────────────────────
console.log('\n0 · shops on this box');
const stores = db.prepare(
  'SELECT id, code, name_en, name_cn, is_active FROM retail_stores ORDER BY id').all();
for (const s of stores) {
  console.log(`   #${String(s.id).padEnd(3)} ${String(s.code || '').padEnd(12)} ` +
    `${(s.name_cn || '') + ' ' + (s.name_en || '')}`.padEnd(34) +
    (s.is_active ? '' : ' INACTIVE'));
}

// ── 1 · the requests themselves ───────────────────────────────────────────
// Non-kitchen only: a kitchen request carries no locations at all and is not
// what this report is about.
console.log('\n1 · recent stock requests (non-kitchen), newest first');
const rows = db.prepare(`
  SELECT id, rs_number, date, status, created_at, sent_at, archived_at,
         store_name, store_cn, created_by,
         from_store_id, to_store_id, print_status, print_error, printed_at,
         COALESCE(from_role,'store')   AS from_role,
         COALESCE(to_role,'warehouse') AS to_role
    FROM restock_orders
   WHERE COALESCE(to_role,'warehouse') != 'kitchen'
     AND COALESCE(from_role,'store')   != 'kitchen'
     ${WANTED ? 'AND rs_number = ?' : ''}
   ORDER BY id DESC
   LIMIT ${WANTED ? 5 : 15}
`).all(...(WANTED ? [WANTED] : []));

if (!rows.length) {
  console.log(WANTED ? `   no request numbered ${WANTED}` : '   none on this box');
}

// The capability resolution the server itself does, so this reports the same
// answer the request middleware would — never a guess off the preset table.
let resolveOperator = null;
try { ({ resolveOperator } = require('../lib/operator-caps')); } catch (e) {
  console.log(`   (operator-caps unavailable: ${e.message} — section 3 will be skipped)`);
}
let tenant = null;
try { tenant = db.prepare('SELECT * FROM tenants ORDER BY id LIMIT 1').get(); } catch (_) { tenant = null; }

const pickersAt = (storeId) => {
  if (!resolveOperator || !hasTable('tenant_users')) return null;
  const out = [];
  const users = db.prepare(
    'SELECT * FROM tenant_users WHERE is_active = 1 ORDER BY id').all();
  for (const u of users) {
    let r;
    try { r = resolveOperator(db, u, tenant); } catch (_) { continue; }
    const caps = new Set(r.caps || []);
    if (!caps.has('restock:pick')) continue;
    // null scopeStores = unscoped = every location.
    const scoped = Array.isArray(r.scopeStores);
    if (storeId && scoped && r.scopeStores.indexOf(storeId) === -1) continue;
    out.push({ id: u.id, name: u.display_name || u.username, role: u.role,
               scope: scoped ? r.scopeStores.join(',') : 'all' });
  }
  return out;
};

const subsFor = (tenantUserId) => {
  if (!hasTable('tenant_operator_push_subs')) return -1;
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM tenant_operator_push_subs WHERE tenant_user_id = ?')
      .get(tenantUserId).c;
  } catch (_) { return -1; }
};

for (const o of rows) {
  console.log('\n   ' + '-'.repeat(72));
  console.log(`   ${o.rs_number}   ${o.status.toUpperCase()}   raised ${o.created_at}`);
  console.log(`   direction   ${o.from_role} -> ${o.to_role}`);
  console.log(`   supplier    ${o.from_store_id ? storeName(o.from_store_id) : 'NOT NAMED — falls back to the role pair'}`);
  console.log(`   destination ${o.to_store_id ? storeName(o.to_store_id) : (o.store_cn || o.store_name || 'NOT NAMED')}`);
  const items = db.prepare(
    'SELECT product_name, product_cn, sku, qty_requested, unit FROM restock_items WHERE restock_id = ? AND qty_requested > 0 ORDER BY id').all(o.id);
  console.log(`   lines       ${items.length}` + (items.length
    ? ' — ' + items.slice(0, 4).map(i => `${i.qty_requested}×${i.product_cn || i.product_name}`).join(', ')
      + (items.length > 4 ? '…' : '')
    : ''));

  // 2 · the sweep
  if (o.archived_at) {
    console.log(`   !! ARCHIVED ${o.archived_at} — it is off every active list.`);
    console.log('      The nightly sweep in GET /api/restock does this to any open non-kitchen');
    console.log('      request raised before today. Nobody archived it by hand.');
  }

  // 3 + 4 · who could have picked it
  if (!o.from_store_id) {
    console.log('   !! NO SUPPLIER ID — the Pick screen filters on from_store_id, so this row');
    console.log('      reaches the screen only through the legacy store->warehouse fallback.');
  }
  const pickers = pickersAt(o.from_store_id);
  if (pickers === null) {
    console.log('   ?  pickers    (cannot resolve — see the note above)');
  } else if (!pickers.length) {
    console.log('   !! NOBODY AT THE SUPPLYING SHOP HOLDS restock:pick.');
    console.log('      The Pick screen is hidden for them and the \'sent\' push has no recipient.');
    console.log('      The `store_stock` preset excludes it deliberately (lib/capabilities.js).');
  } else {
    for (const p of pickers) {
      const n = subsFor(p.id);
      console.log(`   picker      ${String(p.name).padEnd(18)} role=${String(p.role).padEnd(12)} ` +
        `stores=${String(p.scope).padEnd(8)} phones=${n < 0 ? '?' : n}` +
        (n === 0 ? '   !! no phone registered — no push could be sent' : ''));
    }
  }

  // 5 · the paper
  console.log(`   print       ${o.print_status || '(never attempted)'}` +
    (o.print_error ? ` — ${o.print_error}` : '') +
    (o.printed_at ? ` at ${o.printed_at}` : ''));
}

// ── 2 · the push rail as a whole ──────────────────────────────────────────
console.log('\n2 · the push rail');
const vapid = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
console.log(`   VAPID keys in this shell        ${vapid ? 'present' : 'ABSENT — push is a no-op here'}`);
console.log('   (the server reads its own .env; absent here does not prove absent there)');
if (hasTable('tenant_operator_push_subs')) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM tenant_operator_push_subs').get().c;
  console.log(`   registered operator phones     ${n}` +
    (n === 0 ? '   !! nobody would be pushed, whatever the keys say' : ''));
} else {
  console.log('   tenant_operator_push_subs      MISSING');
}

// ── 3 · the paper rail at each shop ───────────────────────────────────────
console.log('\n3 · printers, per shop');
const byStore = cfg('printer.by_store', {}) || {};
const transferOn = cfg('printer.transfer_print_on', null);
for (const s of stores) {
  const p = byStore[String(s.id)] || null;
  const sn = p && String(p.sn || '').trim();
  console.log(`   ${String(s.name_cn || s.name_en || s.code).padEnd(16)} ` +
    (sn ? `SN ${sn}  copies=${p.copies || 1}  vendor=${p.vendor || 'feie'}`
        : 'NO PRINTER CONFIGURED'));
}
console.log(`   printer.transfer_print_on      ${transferOn === null ? "(unset — defaults to 'sent')" : transferOn}`);
console.log(`   printer.kitchen_sn             ${cfg('printer.kitchen_sn', '') || '(unset)'}`);

console.log('\n' + '='.repeat(78));
console.log('Read this bottom-up: a request nobody can pick is not fixed by a printer,');
console.log('and a printer with no SN is not fixed by a capability.');
