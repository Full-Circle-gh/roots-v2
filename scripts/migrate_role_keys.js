#!/usr/bin/env node
// STAGED. Renames the four starting roles' KEYS to match the names they now
// carry. Nothing about this is required for the Roles tab to work — it is a
// tidy-up, and it is the only part of the roles work that touches live people,
// so it does not run until its counts have been read and approved.
//
//   node scripts/migrate_role_keys.js --survey   # READ-ONLY. Who holds what,
//                                                # who carries exceptions, and
//                                                # any role nothing recognises.
//   node scripts/migrate_role_keys.js            # DRY RUN — prints the plan
//   node scripts/migrate_role_keys.js --apply    # writes, one transaction per tenant
//   node scripts/migrate_role_keys.js --tenant 3 # limit to one tenant
//
// --survey writes nothing and reads nothing but tenant_users, tenant_roles and
// tenant_user_caps. It exists because the DRY RUN answers a narrower question
// than the one that has to be answered first: the plan only lists roles it
// intends to rename, so an account sitting on a role string nothing recognises
// — the case most worth knowing about before any of this runs — is invisible
// to it. The survey names that case explicitly, and reads as empty when there
// is nothing to say.
//
// ── What this is, and what it is not ──────────────────────────────────────
// The seed deliberately kept the shipped presets' keys: a tenant's four roles
// are ('owner', 'admin', 'staff', 'warehouse') named Owner, Manager, Shop floor
// and Stockroom. That is what made the deploy a no-op — no live account's
// tenant_users.role had to change for the new names to appear, and every
// operator resolved to exactly the capabilities they had the day before.
//
// So by the time this script runs, nobody is "on a retired role" in any sense a
// person can see: the nine names are gone from the product, each of the nine is
// an ordinary per-tenant row that can be renamed, re-scoped or deleted, and a
// tenant onboarded today gets four. What is left is that three internal keys
// still read 'admin', 'staff' and 'warehouse'. This aligns them.
//
//   admin     → manager
//   staff     → shop_floor
//   warehouse → stockroom
//
// 'owner' NEVER MOVES. It is a reserved literal compared in six places across
// lib/capabilities.js, routes/retail.js, routes/retail-recipes.js and
// routes/backend-team.js, and renaming it would silently strip every owner in
// the system of superuser resolution. The five carried roles (store_manager,
// customer_service, dispatch, kitchen, store_stock) keep their keys too: they
// already carry their own names and nothing in the four maps onto them.
//
// ── Why it is safe, and where it stops ────────────────────────────────────
// Both writes happen in ONE transaction per tenant: the tenant_roles row and
// every tenant_users row pointing at it move together, so there is no instant
// at which an account points at a key with no record. Per-user overrides are
// keyed on tenant_user_id, not on the role, so nobody's exceptions are touched.
//
// It REFUSES rather than guesses when:
//   • the destination key already exists in that tenant (somebody has already
//     made a 'manager' role by hand) — renaming into it would merge two roles
//     and silently change what their people can do;
//   • the source role has been renamed by the tenant to something that is no
//     longer the seeded name — that is a tenant who has made this role their
//     own, and quietly rekeying it is not this script's business.
// Both cases are reported and skipped; the rest of the tenant still migrates.
//
// ── One consequence worth knowing before you run it ───────────────────────
// The fail-open fallback in lib/operator-caps.js resolves an unreadable role
// from presetCapsFor(role). 'staff' has a preset; 'shop_floor' does not. So
// after this runs, a tenant whose tenant_roles rows became unreadable would
// resolve its Shop floor people to NOTHING rather than to the nine shipped
// capabilities — the client hides everything and the server (which does not
// reject on capabilities) behaves as it does today.
//
// That is the safer direction and it is the same answer an unknown role already
// gets, but it IS a change: before this script, the fallback for these three
// keys was a working capability set; after it, it is an empty one. The
// fallback only fires when the roles table is missing or unreadable, which
// seeding makes a non-state — but it is the reason this script is a tidy-up
// with a real cost rather than a pure rename, and the reason it is optional.

'use strict';

const db = require('../database');
const roles = require('../lib/roles');

const APPLY = process.argv.includes('--apply');
const SURVEY = process.argv.includes('--survey');
const tArg = process.argv.indexOf('--tenant');
const ONLY = tArg !== -1 ? Number(process.argv[tArg + 1]) : null;

// from → [to, the English name the seed gave it]. Owned by lib/roles.js, which
// needs the same map to know that a migrated 'manager' row already satisfies
// the 'admin' seed — two copies of it is how a tenant ended up with two
// Managers on the Roles tab.
const RENAMES = roles.RENAMES;

// The nine role strings that existed before roles became data. Anything outside
// this list AND without a tenant_roles row is an account pointing at nothing.
const SHIPPED = ['owner', 'admin', 'staff', 'store_manager', 'warehouse',
  'customer_service', 'dispatch', 'kitchen', 'store_stock'];

// READ-ONLY. Three questions, in the order they matter: who holds what, whose
// permissions are not simply their role's, and whether anyone is stranded.
function survey(tenants) {
  console.log('── SURVEY — read-only, nothing is written ──');

  const known = new Set(SHIPPED);
  try { for (const r of db.prepare('SELECT DISTINCT role_key FROM tenant_roles').all()) known.add(r.role_key); }
  catch (e) { /* no roles table yet — the shipped nine are the whole list */ }

  let people = 0, stranded = [];
  for (const t of tenants) {
    const rows = db.prepare(
      `SELECT role,
              COUNT(*)                          AS people,
              SUM(COALESCE(is_active,0))        AS active,
              SUM(retail_store_id IS NOT NULL)  AS pinned,
              SUM(COALESCE(scope_all,1) = 0)    AS scoped
         FROM tenant_users WHERE tenant_id = ?
        GROUP BY role ORDER BY COUNT(*) DESC`).all(t.id);
    if (!rows.length) continue;

    console.log('');
    console.log('tenant ' + t.id + ' · ' + t.name);
    console.log('   role              people  active  pinned  scoped  exceptions');
    for (const r of rows) {
      let exc = 0;
      try {
        exc = db.prepare(
          `SELECT COUNT(DISTINCT c.tenant_user_id) n
             FROM tenant_user_caps c JOIN tenant_users u ON u.id = c.tenant_user_id
            WHERE u.tenant_id = ? AND u.role = ?`).get(t.id, r.role).n;
      } catch (e) { exc = 0; }
      const hasRecord = !!roleRecord(t.id, r.role);
      console.log('   ' + String(r.role).padEnd(17)
        + String(r.people).padStart(6) + String(r.active).padStart(8)
        + String(r.pinned).padStart(8) + String(r.scoped).padStart(8)
        + String(exc).padStart(12)
        + (hasRecord ? '' : '   ← NO ROLE RECORD'));
      people += r.people;
      if (!hasRecord) stranded.push({ tenant: t.id, role: r.role, people: r.people });
    }
  }

  console.log('');
  console.log('── ' + people + ' account(s) across ' + tenants.length + ' tenant(s) ──');
  if (stranded.length) {
    // These resolve to NO capabilities today: presetCapsFor returns [] for a
    // role it doesn't know, and there is no record to read instead. The client
    // hides everything; the server does not reject, so nobody has necessarily
    // noticed. Worth fixing before the rename, not after.
    console.log('');
    console.log('STRANDED — a role string with no record and no shipped preset:');
    for (const x of stranded) {
      console.log('   tenant ' + x.tenant + ' · ' + x.role + ' · ' + x.people
        + (x.people === 1 ? ' account' : ' accounts'));
    }
    console.log('These resolve to no capabilities at all. Give them a role before renaming anything.');
  } else {
    console.log('No stranded accounts — every role string in use has a record or a shipped preset.');
  }
}

function roleRecord(tenantId, key) {
  try { return db.prepare('SELECT 1 FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').get(tenantId, key) || null; }
  catch (e) { return null; }
}

function main() {
  roles.ensureSchema();

  let tenants;
  try {
    tenants = ONLY
      ? db.prepare('SELECT id, name FROM tenants WHERE id = ?').all(ONLY)
      : db.prepare('SELECT id, name FROM tenants ORDER BY id').all();
  } catch (e) {
    console.error('No tenants table — nothing to migrate.');
    process.exit(1);
  }
  if (!tenants.length) { console.log('No tenants matched.'); return; }

  if (SURVEY) { survey(tenants); return; }

  console.log(APPLY ? '── APPLYING ──' : '── DRY RUN — nothing is written ──');
  console.log('');

  let totalRoles = 0, totalPeople = 0, totalSkipped = 0;

  for (const t of tenants) {
    const plan = [];
    const skips = [];
    for (const [from, to, seededName] of RENAMES) {
      const src = db.prepare('SELECT * FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').get(t.id, from);
      if (!src) continue;                              // tenant never had it
      const clash = db.prepare('SELECT 1 FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').get(t.id, to);
      if (clash) { skips.push(from + ' → ' + to + ': destination key already exists'); continue; }
      if (src.name_en !== seededName) {
        skips.push(from + ' → ' + to + ': renamed by the tenant to “' + src.name_en + '” — left alone');
        continue;
      }
      const people = db.prepare('SELECT COUNT(*) c FROM tenant_users WHERE tenant_id = ? AND role = ?').get(t.id, from).c;
      let exceptions = 0;
      try {
        exceptions = db.prepare(
          `SELECT COUNT(DISTINCT c.tenant_user_id) n
             FROM tenant_user_caps c JOIN tenant_users u ON u.id = c.tenant_user_id
            WHERE u.tenant_id = ? AND u.role = ?`).get(t.id, from).n;
      } catch (e) { exceptions = 0; }
      plan.push({ from, to, people, exceptions });
    }

    if (!plan.length && !skips.length) continue;

    console.log('tenant ' + t.id + ' · ' + t.name);
    for (const p of plan) {
      console.log('   ' + p.from.padEnd(10) + ' → ' + p.to.padEnd(11)
        + String(p.people).padStart(3) + ' ' + (p.people === 1 ? 'person' : 'people')
        + (p.exceptions ? '  (' + p.exceptions + ' with exceptions, preserved)' : ''));
      totalRoles++; totalPeople += p.people;
    }
    for (const sk of skips) { console.log('   SKIP ' + sk); totalSkipped++; }

    if (APPLY && plan.length) {
      const write = db.transaction(() => {
        for (const p of plan) {
          // The record and everyone pointing at it move together, so there is
          // never an instant where an account points at a key with no row.
          db.prepare('UPDATE tenant_roles SET role_key = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND role_key = ?')
            .run(p.to, t.id, p.from);
          db.prepare('UPDATE tenant_users SET role = ? WHERE tenant_id = ? AND role = ?')
            .run(p.to, t.id, p.from);
        }
        roles.bumpVersion(t.id);
      });
      write();
      console.log('   written.');
    }
    console.log('');
  }

  console.log('── ' + totalRoles + ' role(s), ' + totalPeople + ' account(s)'
    + (totalSkipped ? ', ' + totalSkipped + ' skipped' : '') + ' ──');
  if (!APPLY) {
    console.log('');
    console.log('Dry run. Re-run with --apply to write.');
    console.log('Back the database up first — .backup, not cp: this database runs in WAL');
    console.log('mode, so a plain copy silently omits the newest committed writes.');
  }
}

main();
