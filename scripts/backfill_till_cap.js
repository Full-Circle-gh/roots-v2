#!/usr/bin/env node
/**
 * Grant `till:use` to the roles that can already ring a counter sale.
 *
 * READ-ONLY BY DEFAULT. Prints what it would do and writes nothing. Pass
 * --apply to write; --apply takes a backup first and runs in ONE transaction.
 *
 *   node scripts/backfill_till_cap.js            # dry run (default)
 *   node scripts/backfill_till_cap.js --apply    # take backup, then write
 *
 * ── WHY THIS SCRIPT HAS TO EXIST ──────────────────────────────────────────
 * A tenant's roles are DATA, not code. `lib/roles.js` seeds `tenant_roles` once
 * per tenant by stamping `caps_json` out of the shipped presets in
 * lib/capabilities.js, and seeding is idempotent — `INSERT OR IGNORE` on
 * (tenant_id, role_key). So a capability key added to a preset AFTER a tenant
 * was seeded never reaches that tenant. Its stored role rows are a frozen
 * snapshot of the presets on the day they were stamped.
 *
 * `owner` is the exception and the only one: resolveCaps() short-circuits it to
 * ALL_KEYS, so an owner picks up a new capability the moment it is registered.
 *
 * Which means that WITHOUT this script, adding `till:use` and gating the till's
 * new rail row / More row on it would take the counter away from every
 * non-owner on every live tenant, silently, as a side effect of a change made
 * to make the till easier to reach. That is precisely the failure mode
 * lib/cap-routes.js warns about in its affiliate note: "a lockout shipped as a
 * side effect of an unrelated feature".
 *
 * ── THE RULE, AND WHY IT IS NOT "WHAT THE PRESET SAYS" ────────────────────
 * A role is granted `till:use` if, and only if, it ALREADY HOLDS `orders:edit`.
 *
 * Not "if its shipped preset now lists till:use". That would be the wrong
 * question twice over: it would ignore every edit a tenant has made to its own
 * roles (the entire point of the roles table), and it would hand the till to
 * roles that cannot use it anyway.
 *
 * `orders:edit` is the honest measure of who can ring a counter sale TODAY.
 * The till has never had a capability of its own — it writes through the
 * ordinary manual-order endpoint, POST /api/retail-admin/orders, and
 * lib/cap-routes.js maps that to `orders:edit`. So a role holding `orders:edit`
 * can transact at the counter right now, and a role without it already cannot,
 * enforcement on. Copying that line forward means:
 *
 *   • nobody LOSES the till who has it today,
 *   • nobody GAINS the ability to transact who could not before,
 *   • a role a tenant deliberately narrowed stays narrow.
 *
 * The new cap is therefore a door on a room people were already allowed in,
 * not a new grant. After this runs, an owner can take the till away from a role
 * without also taking away its order editing — which is the control the change
 * adds and the reason it is worth a migration at all.
 *
 * ── THE ROLE THAT WILL LOOK WRONG IN THE OUTPUT, AND IS NOT ───────────────
 * `dispatch` — "keeps deliveries moving, orders in motion, nothing else" — is
 * granted the till by this rule, because it holds `orders:edit`. A dispatcher
 * has no business behind a counter, and it is tempting to correct that here.
 *
 * DON'T. A dispatcher can ring a counter sale TODAY: the till has no capability
 * of its own, so the only thing standing between that role and the counter is
 * that nobody has sent them the URL. Withholding the cap would not close a door
 * — it would leave the door open and remove the handle an owner could use to
 * shut it. Granting it writes the existing access down where it can be seen and
 * unticked, which is the first time that has ever been possible.
 *
 * So: a migration records what is true, and the correction is a decision for
 * each business to make on its own Roles screen afterwards. Shipping somebody
 * else's org chart inside a schema change is not this script's job. (The
 * shipped `dispatch` PRESET does not list till:use, so new tenants start
 * without it — which is the opinion, expressed where it costs nobody access.)
 *
 * ── WHAT IT DOES NOT TOUCH ────────────────────────────────────────────────
 *   • `owner` rows. They resolve to ALL and their caps_json is never read.
 *   • Per-user grants/revokes (tenant_users overrides). A user who was revoked
 *     `orders:edit` individually still cannot transact; this only moves role
 *     definitions, which is the layer the lockout would happen at.
 *   • Any role already holding `till:use` — re-running changes nothing.
 *
 * Bumps tenants.roles_version for every tenant it writes to, inside the same
 * transaction as the write, exactly as lib/roles.js requires — so the in-process
 * cache on every worker invalidates on its next request rather than serving a
 * stale definition until something else happens to save.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APPLY   = process.argv.includes('--apply');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');

const NEW_CAP     = 'till:use';
const REQUIRES    = 'orders:edit';   // the cap that already means "can ring a sale"
const OWNER_KEY   = 'owner';         // reserved literal — resolves to ALL, caps_json unread

function parseCaps(json) {
  try { const p = JSON.parse(json || '[]'); return Array.isArray(p) ? p : null; }
  catch (e) { return null; }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Set ROOTS_DB to override.`);
    process.exit(1);
  }
  const db = new Database(DB_PATH, APPLY ? {} : { readonly: true });

  console.log('='.repeat(78));
  console.log(`  till:use backfill — ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`);
  console.log(`  Database : ${DB_PATH}`);
  console.log('='.repeat(78));

  let rows;
  try {
    rows = db.prepare(
      'SELECT id, tenant_id, role_key, name_en, caps_json FROM tenant_roles ORDER BY tenant_id, sort_order, id'
    ).all();
  } catch (e) {
    console.log('\n  No tenant_roles table in this database — nothing to migrate.');
    console.log('  An unseeded tenant falls back to presetCapsFor(), which already');
    console.log('  carries till:use. Nothing to do.\n');
    db.close();
    return;
  }

  if (!rows.length) {
    console.log('\n  tenant_roles is empty — no tenant has been seeded yet.');
    console.log('  Seeding stamps the current presets, which include till:use. Nothing to do.\n');
    db.close();
    return;
  }

  // ── Sort every row into one of four buckets ──────────────────────────────
  const grant   = [];   // holds orders:edit, lacks till:use  → the migration
  const already = [];   // holds till:use                     → re-run, or freshly seeded
  const skipped = [];   // no orders:edit                     → cannot transact today either
  const owner   = [];   // reserved                           → resolves to ALL regardless
  const broken  = [];   // caps_json unparsable               → reported, never guessed at

  for (const r of rows) {
    if (r.role_key === OWNER_KEY) { owner.push(r); continue; }
    const caps = parseCaps(r.caps_json);
    if (caps === null) { broken.push(r); continue; }
    if (caps.indexOf(NEW_CAP) !== -1)  { already.push(r); continue; }
    if (caps.indexOf(REQUIRES) === -1) { skipped.push(r); continue; }
    grant.push({ row: r, caps });
  }

  const tenantCount = new Set(rows.map(r => r.tenant_id)).size;
  console.log(`\n  tenant_roles rows ...... ${rows.length}  across ${tenantCount} tenant(s)`);
  console.log(`  owner (always ALL) ..... ${owner.length}`);
  console.log(`  already hold ${NEW_CAP} .. ${already.length}`);
  console.log(`  no ${REQUIRES} ......... ${skipped.length}   (cannot ring a sale today either)`);
  console.log(`  TO GRANT ............... ${grant.length}`);
  if (broken.length) console.log(`  UNREADABLE caps_json ... ${broken.length}   (left alone — see below)`);

  if (skipped.length) {
    console.log(`\n  Roles left WITHOUT the till (they hold no ${REQUIRES}, so the counter's`);
    console.log('  Confirm would 403 for them under rbac_enforce anyway):\n');
    for (const r of skipped) {
      console.log(`    tenant ${String(r.tenant_id).padStart(4)}  ${r.role_key.padEnd(18)} ${r.name_en || ''}`);
    }
  }

  if (broken.length) {
    console.log('\n  Rows whose caps_json could not be parsed. NOT touched — a role whose');
    console.log('  stored permissions cannot be read is a question for a human, and');
    console.log('  rewriting one from a guess would silently replace a definition:\n');
    for (const r of broken) {
      console.log(`    tenant ${String(r.tenant_id).padStart(4)}  ${r.role_key.padEnd(18)} row #${r.id}`);
    }
  }

  if (!grant.length) {
    console.log('\n  Nothing to grant. Every role that can ring a counter sale already');
    console.log(`  holds ${NEW_CAP}, or holds no ${REQUIRES} to inherit it from.\n`);
    db.close();
    return;
  }

  console.log(`\n  Would grant ${NEW_CAP} to:\n`);
  for (const g of grant) {
    console.log(`    tenant ${String(g.row.tenant_id).padStart(4)}  ${g.row.role_key.padEnd(18)} ${g.row.name_en || ''}`);
  }

  if (!APPLY) {
    console.log('\n  ' + '-'.repeat(74));
    console.log('  DRY RUN — nothing was written. Re-run with --apply to make these changes.\n');
    db.close();
    return;
  }

  // ── Backup, then one transaction ─────────────────────────────────────────
  const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DB_PATH}.pre-till-cap.${stamp}.bak`;
  console.log(`\n  Backing up to ${backup} …`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB_PATH, backup);
  const size = fs.statSync(backup).size;
  if (size < 1024) {
    console.error(`  Backup is only ${size} bytes — refusing to continue.`);
    db.close();
    process.exit(1);
  }
  console.log(`  Backup written, ${(size / 1048576).toFixed(1)} MB.\n`);

  const touchedTenants = [...new Set(grant.map(g => g.row.tenant_id))];

  try {
    db.transaction(() => {
      const upd = db.prepare(
        "UPDATE tenant_roles SET caps_json = ?, updated_at = datetime('now') WHERE id = ?"
      );
      for (const g of grant) {
        // Append, then sort — resolveCaps() returns a sorted array and the role
        // editor reads these lists back; keeping the stored order stable stops
        // a later diff of two identical roles looking like a change.
        const next = g.caps.concat([NEW_CAP]).sort();
        const r = upd.run(JSON.stringify(next), g.row.id);
        if (r.changes !== 1) throw new Error(`row #${g.row.id} did not update. Rolled back.`);
      }
      // The cache invalidation. MUST be in this transaction — a bump without the
      // write, or a write without the bump, is a cache serving the wrong answer
      // until something else happens to save (lib/roles.js bumpVersion).
      const bump = db.prepare(
        'UPDATE tenants SET roles_version = COALESCE(roles_version, 0) + 1 WHERE id = ?'
      );
      for (const t of touchedTenants) bump.run(t);
    })();
  } catch (e) {
    console.error(`\n  FAILED: ${e.message}`);
    console.error('  Nothing was written — the transaction rolled back.');
    console.error(`  The database is unchanged. Backup is at ${backup}\n`);
    db.close();
    process.exit(1);
  }

  console.log(`  Granted ${NEW_CAP} to ${grant.length} role(s) across ${touchedTenants.length} tenant(s).`);
  console.log(`  Bumped roles_version on tenant(s): ${touchedTenants.join(', ')}`);
  console.log('  Every worker picks the new definitions up on its next request.\n');
  db.close();
}

main();
