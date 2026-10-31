#!/usr/bin/env node
// READ-ONLY. Why is "Ask to buy" not on the kitchen's phone?
//
//   node scripts/diagnose_material_request_reach.js
//
// §86 shipped a screen the kitchen role is supposed to reach, and on the live
// box it is not in the More list. Three independent things can hide that row,
// each silently, and any one of them alone is enough:
//
//   1. THE TABLES. If material_requests / material_request_items are not there,
//      the boot migration did not run and nothing else matters.
//   2. THE CAPABILITY. `canRoute('askbuy')` reads `production:request`, which
//      comes from the tenant's OWN tenant_roles row — not from the preset in
//      lib/capabilities.js. kitchen_role_can_request_materials_v1 grants it
//      only to a role still holding EXACTLY the three keys the preset shipped
//      with last, and leaves a hand-edited role alone on purpose. A kitchen
//      role that has been given, say, purchasing:receive is edited, so it was
//      skipped — correctly by the migration's own rule, and invisibly.
//   3. THE FEATURE SWITCH. The row carries `production` as its module gate;
//      `features.production` set false hides it whatever the capability says.
//
// This reports all three, plus the migration ledger, so the answer is a fact
// rather than an inference. It also prints WHAT each kitchen role actually
// holds, because "edited" is the likely finding and the edit is the evidence.
//
// Mutates nothing, and proves it: the connection is opened readonly and a write
// is attempted before anything else runs.

const path = require('path');
const Database = require('@libsql/client');

const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true });

try {
  db.prepare('CREATE TABLE IF NOT EXISTS _ro_probe_mreq (x INTEGER)').run();
  console.log('!! ABORT: this connection accepted a write. Refusing to report.');
  process.exit(2);
} catch (e) {
  console.log(`read-only proven (${String(e.message).slice(0, 60)}…)\n`);
}

const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const cfg = (key) => {
  try {
    const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return r ? JSON.parse(r.value_json) : null;
  } catch (_) { return null; }
};

console.log(`DB : ${DB_PATH}`);
console.log('='.repeat(78));

// ── 1 · did the boot migration build the tables ───────────────────────────
console.log('\n1 · the tables §86 added');
for (const t of ['material_requests', 'material_request_items']) {
  if (!has(t)) { console.log(`   ${t.padEnd(24)} MISSING`); continue; }
  const n = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  console.log(`   ${t.padEnd(24)} present, ${n} row(s)`);
}

// ── 2 · the migration ledger ──────────────────────────────────────────────
console.log('\n2 · migration ledger');
if (!has('_migrations')) {
  console.log('   (_migrations table absent)');
} else {
  for (const name of ['kitchen_role_can_request_materials_v1',
                      'kitchen_role_can_log_production_v1',
                      'kitchen_role_can_fulfil_v1']) {
    const r = db.prepare('SELECT applied_at FROM _migrations WHERE name = ?').get(name);
    console.log(`   ${name.padEnd(38)} ${r ? 'ran ' + r.applied_at : 'NOT RUN'}`);
  }
}
console.log('   NOTE: "ran" says the migration executed, NOT that it granted anything.');
console.log('         It skips a hand-edited role by design and records nothing per role.');

// ── 3 · what each kitchen role ACTUALLY holds ─────────────────────────────
// This is the one that usually answers it. The preset in lib/capabilities.js is
// the SEED; a live operator's base set comes from this table.
console.log('\n3 · tenant_roles — every kitchen role on this box');
const PRESET_AT_LAST_MIGRATION = ['quickstock:add', 'restock:fulfil', 'production:log'];
if (!has('tenant_roles')) {
  console.log('   (tenant_roles absent — roles are not tenant data on this box)');
} else {
  const rows = db.prepare(
    "SELECT tenant_id, role_key, caps_json FROM tenant_roles WHERE role_key = 'kitchen' ORDER BY tenant_id").all();
  if (!rows.length) console.log('   (no kitchen role rows at all)');
  for (const r of rows) {
    let list = null;
    try { const p = JSON.parse(r.caps_json || 'null'); if (Array.isArray(p)) list = p; } catch (_) {}
    console.log(`\n   tenant ${r.tenant_id}`);
    if (!list) { console.log(`      caps_json unreadable: ${String(r.caps_json).slice(0, 120)}`); continue; }
    console.log(`      holds ${list.length}: ${list.join(', ')}`);
    const hasIt = list.indexOf('production:request') >= 0;
    console.log(`      production:request  ${hasIt ? 'YES — the row should appear' : 'NO  — this is why the row is missing'}`);
    if (!hasIt) {
      const same = list.length === PRESET_AT_LAST_MIGRATION.length
                && PRESET_AT_LAST_MIGRATION.every(k => list.indexOf(k) >= 0);
      const extra = list.filter(k => PRESET_AT_LAST_MIGRATION.indexOf(k) < 0);
      const missing = PRESET_AT_LAST_MIGRATION.filter(k => list.indexOf(k) < 0);
      console.log(`      why skipped: ${same
        ? 'NOT SKIPPED by the shape rule — the migration should have granted it. Check whether it ran BEFORE this role existed.'
        : 'HAND-EDITED, so the migration left it alone (its own rule).'}`);
      if (extra.length)   console.log(`         extra beyond the old preset : ${extra.join(', ')}`);
      if (missing.length) console.log(`         missing from the old preset : ${missing.join(', ')}`);
    }
  }
}

// ── 4 · the module gate ───────────────────────────────────────────────────
console.log('\n4 · features.production — the row’s module gate');
const prod = cfg('features.production');
console.log(`   stored value : ${JSON.stringify(prod)}`);
console.log(`   row is ${prod === false ? 'HIDDEN by this switch' : 'not hidden by this switch'} `
          + `(absent or anything but false reads as ON)`);

// ── 5 · who would see it ──────────────────────────────────────────────────
console.log('\n5 · the operators on a kitchen role');
if (has('tenant_users')) {
  const us = db.prepare(
    "SELECT id, username, display_name, role, tenant_id, is_active FROM tenant_users WHERE role = 'kitchen' ORDER BY tenant_id, id").all();
  if (!us.length) console.log('   (nobody is on the kitchen role)');
  for (const u of us) {
    console.log(`   #${u.id} ${String(u.username || '').padEnd(18)} ${(u.display_name || '').padEnd(16)} `
              + `tenant ${u.tenant_id}${u.is_active ? '' : '  (INACTIVE)'}`);
  }
} else {
  console.log('   (tenant_users absent)');
}

// ── 6 · is RBAC even enforced ─────────────────────────────────────────────
// Worth printing because it changes what a missing capability MEANS: with
// enforcement off the server would allow the write anyway, and the row is
// hidden purely by the client's own gate.
console.log('\n6 · rbac_enforce per tenant');
if (has('tenants')) {
  for (const t of db.prepare('SELECT id, name, rbac_enforce FROM tenants ORDER BY id').all()) {
    console.log(`   tenant ${t.id} ${String(t.name || '').padEnd(24)} rbac_enforce=${JSON.stringify(t.rbac_enforce)}`);
  }
}

console.log('\n' + '='.repeat(78));
console.log('Read-only. Nothing was written.');
