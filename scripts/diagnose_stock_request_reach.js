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
const Database = require('@libsql/client');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
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
         COALESCE(goods_state,'none') AS goods_state, dispatched_at,
         received_confirmed_at,
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
try { ({ resolveOperator } = require(path.join(HOME, 'lib', 'operator-caps.js'))); } catch (e) {
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
    `SELECT product_id, product_name, product_cn, sku, qty_requested, unit
       FROM restock_items WHERE restock_id = ? AND qty_requested > 0 ORDER BY id`).all(o.id);
  console.log(`   lines       ${items.length}`);
  /* PER LINE, BECAUSE THE LINE IS WHERE THE FAULT LIVES. A transfer moves only
     lines carrying a product_id; one without is unmovable and the whole
     dispatch is refused. The SKU is printed beside it because that is what the
     backfill matches on — a line with neither an id nor a SKU cannot be
     repaired automatically, and saying so is the difference between "it did
     not work" and knowing why. */
  for (const i of items) {
    const name = (i.product_cn || i.product_name || '?');
    const sku = String(i.sku || '').trim();
    console.log(`     ${String(i.qty_requested).padStart(4)} × ${name}`);
    console.log(`          product_id ${i.product_id == null ? 'NULL  !! unmovable — a dispatch skips this line' : i.product_id}` +
      `   sku ${sku ? sku : "(none)  !! and the SKU backfill has nothing to match on"}`);
    /* WHY THE REPAIR DID NOT TAKE, for a line still unlinked. The backfill
       matches an exact, unique, ACTIVE store_products SKU and refuses anything
       else. Which of those three it failed is the whole answer, and inferring
       it from the outside is exactly the guessing this file exists to stop. */
    if (i.product_id == null && sku) {
      try {
        const act = db.prepare(
          "SELECT id FROM store_products WHERE TRIM(sku) = ? AND COALESCE(is_active,1) = 1").all(sku);
        const any = db.prepare('SELECT id, COALESCE(is_active,1) AS act FROM store_products WHERE TRIM(sku) = ?').all(sku);
        if (act.length === 1) {
          console.log(`          -> SKU ${sku} matches product ${act[0].id} exactly once; the backfill SHOULD have linked it`);
        } else if (act.length > 1) {
          console.log(`          -> SKU ${sku} matches ${act.length} active products (${act.map(x => x.id).join(', ')}) — ambiguous, refused on purpose`);
        } else if (any.length) {
          console.log(`          -> SKU ${sku} exists but every match is INACTIVE (${any.map(x => x.id).join(', ')}) — refused`);
        } else {
          console.log(`          -> SKU ${sku} is in NO store_products row at all — nothing to link to`);
        }
      } catch (e) { console.log(`          -> sku probe failed: ${e.message}`); }
    }
  }

  /* WHERE THE GOODS THEMSELVES ARE — a SECOND fact from the status beside it,
     and the one the first run of this script could not answer.
     `status` is how far the PAPERWORK got; `goods_state` is whether the stock
     actually moved. They come apart, and the gap is a real failure mode the
     route names in as many words: a dispatch that rolled back leaves an order
     at status 'prepared' with goods_state 'none', and NOTHING reaches
     _applyDispatch again by itself. The Receive-from-another-shop screen
     filters on goods_state === 'in_transit', so such an order is invisible at
     the receiving end while its own paperwork says it was sent. */
  const GOODS = {
    none: 'not dispatched — the stock has not left the supplier',
    in_transit: 'dispatched — it should be on the Receive screen at the destination',
    settled: 'counted in at the destination',
  };
  console.log(`   goods       ${o.goods_state} — ${GOODS[o.goods_state] || 'unrecognised'}` +
    (o.dispatched_at ? `  (dispatched ${o.dispatched_at})` : '') +
    (o.received_confirmed_at ? `  (received ${o.received_confirmed_at})` : ''));
  if (o.status === 'prepared' && o.goods_state === 'none') {
    console.log('   !! STUCK: the paperwork says prepared, the stock never moved.');
    console.log('      This is the rolled-back dispatch routes/restock.js warns about. It shows');
    console.log('      nowhere at the receiving end. POST /api/restock/:id/retry-dispatch is the');
    console.log('      route built for exactly this.');
  }

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

// ── 1b · did the repair actually run ──────────────────────────────────────
// A migration that never ran and one that ran and matched nothing look
// identical from the rows, and they need opposite actions.
console.log('\n1b · the repair migration');
if (!hasTable('_migrations')) {
  console.log('   (_migrations table absent)');
} else {
  const mig = db.prepare('SELECT applied_at FROM _migrations WHERE name = ?')
    .get('restock_line_product_id_backfill_v1');
  console.log(`   restock_line_product_id_backfill_v1   ${mig ? 'ran ' + mig.applied_at : 'NOT RUN'}`);
  console.log('   NOTE: "ran" says it executed, NOT that it linked anything — it refuses');
  console.log('         every SKU that is absent, inactive or ambiguous, by design.');
}

/* WHAT THE REPAIR SEES TODAY, RUN VERBATIM. The clause is copied from
   database.js rather than described, because a description of a WHERE is not a
   WHERE: v1 ran, the banana's SKU matches exactly once, and the line was still
   skipped — so the question is which predicate excluded it, and the only
   honest way to ask is to ask the query. Each candidate is printed with the
   four order-level facts the clause turns on, so a row that is MISSING from
   this list can be read against the row above it. */
console.log('\n1c · the repair clause, as the migration itself writes it');
try {
  const cand = db.prepare(`
    SELECT ri.id AS line_id, ro.rs_number, TRIM(ri.sku) AS sku
      FROM restock_items ri
      JOIN restock_orders ro ON ro.id = ri.restock_id
     WHERE ri.product_id IS NULL
       AND ri.sku IS NOT NULL AND TRIM(ri.sku) <> ''
       AND ro.dispatched_at IS NULL
       AND COALESCE(ro.goods_state, 'none') = 'none'
       AND ro.stock_applied_at IS NULL
       AND COALESCE(ro.to_role, 'warehouse') <> 'kitchen'
       AND COALESCE(ro.from_role, 'store')   <> 'kitchen'
  `).all();
  console.log(`   ${cand.length} line(s) the clause would link right now`);
  for (const c of cand) console.log(`     ${c.rs_number}  line ${c.line_id}  sku ${c.sku}`);

  // Every unlinked line, with the four facts, so an ABSENCE above is explained.
  const unl = db.prepare(`
    SELECT ri.id AS line_id, ro.rs_number, TRIM(COALESCE(ri.sku,'')) AS sku,
           ro.dispatched_at, COALESCE(ro.goods_state,'none') AS goods_state,
           ro.stock_applied_at, ro.status
      FROM restock_items ri
      JOIN restock_orders ro ON ro.id = ri.restock_id
     WHERE ri.product_id IS NULL
       AND COALESCE(ro.to_role,'warehouse') <> 'kitchen'
     ORDER BY ri.id DESC LIMIT 10
  `).all();
  console.log(`   every unlinked non-kitchen line (newest 10):`);
  for (const u of unl) {
    console.log(`     ${u.rs_number}  line ${u.line_id}  status ${u.status}  sku ${u.sku || '(none)'}`);
    console.log(`        dispatched_at ${u.dispatched_at || 'NULL'}   goods ${u.goods_state}   stock_applied_at ${u.stock_applied_at || 'NULL'}`);
  }
} catch (e) { console.log(`   clause probe failed: ${e.message}`); }

/* THE FOREIGN KEY NOBODY MENTIONED, and the reason the repair could run and
   link nothing. `restock_items.product_id` REFERENCES products(id), and the id
   this system actually moves stock on is a `store_products` id — those are two
   tables. With `foreign_keys = ON`, writing a store_products id that has no
   products row throws, the migration's transaction rolls back, and it records
   itself as having run. It also decides whether the FORWARD fix is safe: the
   phone now sends that id on every new request. */
console.log('\n1d · the two catalogues, and the key between them');
try {
  const nP = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  const nS = db.prepare('SELECT COUNT(*) AS c FROM store_products').get().c;
  console.log(`   products ${nP}   store_products ${nS}`);
  const orphan = db.prepare(`
    SELECT COUNT(*) AS c FROM store_products sp
     WHERE COALESCE(sp.is_active,1) = 1
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = sp.id)`).get().c;
  console.log(`   active store_products with NO products row of the same id: ${orphan}`);
  /* THE COUNT IS A STANDING FACT, NOT A FAULT — since §201. A store-only
     product is the ordinary shape for anything the shop sells and the kitchen
     does not make. It was a fault only while `restock_items.product_id`
     pointed at the kitchen catalogue, when every one of these ids threw on
     insert; that key now names `store_products`, so the number below is
     inventory rather than an alarm. The check that matters is the key. */
  const fk = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='restock_items'").get();
  const pointsAtStore = !!fk && /REFERENCES\s+store_products\s*\(/i.test(fk.sql);
  console.log(`   restock_items.product_id references ${pointsAtStore ? 'store_products — correct' : 'products  !! WRONG (§201): every id above throws on insert'}`);
  for (const sku of ['A-3']) {
    const r = db.prepare('SELECT id FROM store_products WHERE TRIM(sku) = ?').get(sku);
    if (!r) { console.log(`   sku ${sku}: no store_products row`); continue; }
    const inP = db.prepare('SELECT 1 FROM products WHERE id = ?').get(r.id);
    console.log(`   sku ${sku} -> store_products ${r.id};  products row ${inP ? 'EXISTS' : 'MISSING  !! this is the one'}`);
  }
  console.log(`   PRAGMA foreign_keys = ${db.pragma('foreign_keys', { simple: true })}`);
} catch (e) { console.log(`   catalogue probe failed: ${e.message}`); }

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
