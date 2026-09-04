// Roles as tenant DATA — the per-tenant store behind Settings → Team → Roles.
//
// Until this file existed, what a role MEANT lived in a code literal (PRESETS,
// lib/capabilities.js). A tenant could change who held a role and tick boxes for
// one person; nobody could change what the role itself reached. Now each tenant
// owns its own set of role records, edited in place, and this module is the only
// thing that reads them.
//
// ── The hot-path problem, and the shape of the answer ─────────────────────
// presetCapsFor() is pure, synchronous, takes no tenant, and is reached from
// resolveCaps on EVERY request through requireRetailAdmin. Moving role
// definitions into the database puts a read on that path. So:
//
//   • lib/capabilities.js stays pure. It never learns what a tenant is.
//     resolveCaps takes an optional `baseCaps`; this module supplies it.
//   • The definitions are CACHED IN PROCESS, per tenant, and the cache is
//     invalidated by an integer — tenants.roles_version — that rides along on a
//     row requireRetailAdmin ALREADY reads (`SELECT * FROM tenants`). So a warm
//     request adds no query at all, and a stale one costs exactly one.
//   • A role write bumps that integer inside its own transaction. The next
//     request by anyone in that tenant sees the new number on the row it was
//     already fetching, reloads once, and resolves from the new definition.
//     That is the whole invalidation story: no TTL to tune, no pub/sub, no
//     cache-busting endpoint. It survives a restart and it works across workers
//     and instances, because the version lives in the database and not in
//     anyone's memory — a second process that never saw the write still sees
//     the bump on its next request.
//   • Nothing is cached in the SESSION, exactly as before, so there is never a
//     stale permission in a cookie to clear.
//
// That is the promise the editor makes out loud — "every change here reaches
// them on their next screen" — and it is literally true: the next screen is the
// next request, and the next request re-reads the version.
//
// ── Fail-OPEN, like the rest of this layer ────────────────────────────────
// Every read here is wrapped. No tenant_roles row, no table, a locked database,
// anything at all — and the caller falls back to presetCapsFor(role), which
// resolves byte-for-byte as it did before this file existed. That is what makes
// the deploy quiet for a tenant that has not been seeded yet, and it is why
// PRESETS must not be deleted with the migration.

'use strict';

// Routed through the database seam (lib/db-seam.js), like every other
// control-plane reader, so this file sits on the covered side of the boundary.
const { seam } = require('./db-seam');
const db = seam(require('../database'));
const caps = require('./capabilities');

// ── Schema ────────────────────────────────────────────────────────────────
// Called from routes/backend-auth.js right after the tenants/tenant_users DDL,
// so `tenants` is guaranteed to exist before the ALTER below. Also self-heals:
// any read that throws re-runs this once, in case module load order ever moves.
let _schemaReady = false;
function ensureSchema() {
  if (_schemaReady) return;
  _schemaReady = true;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_roles (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id      INTEGER NOT NULL,
        -- Stable slug, never shown. The NAME is what a tenant edits; the key is
        -- what tenant_users.role points at, so a rename is free. 'owner' is a
        -- reserved literal compared in six places across capabilities.js,
        -- retail.js, retail-recipes.js and backend-team.js — it never moves.
        role_key       TEXT NOT NULL,
        name_en        TEXT NOT NULL,
        name_cn        TEXT NOT NULL,
        desc_en        TEXT,
        desc_cn        TEXT,
        -- The role's own capability list. Ignored for owner, which is always ALL.
        caps_json      TEXT NOT NULL DEFAULT '[]',
        -- Which dashboard this role lands on. An ENUM over the boards that
        -- actually ship (default | store_manager | warehouse | customer_service
        -- | dispatch), because those boards are CSS and code, not data. Held
        -- here rather than derived from the name: renaming "Warehouse" used to
        -- silently take the warehouse board away and hand the operator the
        -- owner's glance page instead. The ~20 body.pos-* rules and the seven
        -- dashPos() branches are unchanged — only the source of the value moved.
        layout         TEXT NOT NULL DEFAULT 'default',
        -- Store pinning, likewise moved off the name. These were the hardcoded
        -- STORE_PINNED_ROLES / STORE_SCOPED_ROLES sets in backend-team.js; a
        -- rename used to stop a store-scoped operator's pin applying on the next
        -- save, quietly showing them every store's data.
        store_pinned   INTEGER NOT NULL DEFAULT 0,
        store_scoped   INTEGER NOT NULL DEFAULT 0,
        -- Quick Stock only — the app-wide lockdown at server.js. Was a hardcoded
        -- role-string test running as a DB read on every request in the app.
        stock_app_only INTEGER NOT NULL DEFAULT 0,
        -- 'team'  — listed on Settings → Team → People.
        -- 'store' — managed inside its store instead (Settings → Stores), which
        --           is why store_stock clerks have never appeared on the roster.
        roster         TEXT NOT NULL DEFAULT 'team',
        -- Owner. Not editable, not renameable, not deletable.
        is_fixed       INTEGER NOT NULL DEFAULT 0,
        sort_order     INTEGER NOT NULL DEFAULT 100,
        -- Which dashboard cards this role sees, as a JSON array — or NULL, the
        -- seeded default for every role, meaning "no override, fall back to
        -- the ~20 body.pos-<layout> CSS rules keyed on \`layout\` above". A
        -- tenant who has never opened the Roles editor's Dashboard cards field
        -- gets exactly today's fixed-per-layout behaviour; picking cards there
        -- writes an explicit array, which the client then applies as an inline
        -- style that beats those CSS rules regardless of \`layout\`. Keys come
        -- from the DASH_CARDS catalog below.
        dashboard_cards TEXT,
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_roles_key ON tenant_roles(tenant_id, role_key);
    `);
  } catch (e) { /* table not creatable here — every read below fails open */ }
  // The invalidation counter. Bumped by every role write; read for free off the
  // tenants row the request already fetched.
  try { db.exec('ALTER TABLE tenants ADD COLUMN roles_version INTEGER NOT NULL DEFAULT 0'); }
  catch (e) { /* already added */ }
  // dashboard_cards shipped after tenant_roles itself, so an already-created
  // table (every live tenant) needs the column added rather than declared —
  // the CREATE TABLE above only runs for a brand-new database.
  try { db.exec('ALTER TABLE tenant_roles ADD COLUMN dashboard_cards TEXT'); }
  catch (e) { /* already added */ }
}

// The dashboard-card catalog — every key a role's `dashboard_cards` override
// may name. 'needs' is the full-width Needs-you block, outside the card grid;
// the rest are #td-blocks' own data-block values (DASH_BLOCK_DEFAULT,
// public/retail-admin/03-dashboard.js). Shared between the save-path validator
// below and the role editor's checkbox list (RL_DASH_CATALOG, 02-settings-ops.js,
// populated from this list off GET /api/backend/roles rather than keeping its
// own copy) — the two would drift the day a card block was renamed.
const DASH_CARDS = ['needs', 'recap', 'orders', 'customers', 'unhandled', 'inventory', 'incoming', 'onroad', 'ready', 'delivery'];

// ── The cache ─────────────────────────────────────────────────────────────
// tenantId → { version, byKey: Map<role_key, record> }
const CACHE = new Map();

// The version this tenant's roles were last written at. Callers that already
// hold the tenants row pass it in and this never runs.
function versionFor(tenantId) {
  try {
    const r = db.prepare('SELECT roles_version FROM tenants WHERE id = ?').get(tenantId);
    return r ? (r.roles_version || 0) : 0;
  } catch (e) { return 0; }
}

function shape(row) {
  let list = [];
  try { const p = JSON.parse(row.caps_json || '[]'); if (Array.isArray(p)) list = p; } catch (e) {}
  // dashboard_cards: NULL/unparsable stays null ("no override"), never []. An
  // owner who wants a role to see NOTHING still has to say so with an actual
  // empty array on save — a read that can't tell "never set" from "cleared
  // deliberately" apart would let a bad parse silently blank someone's board.
  let dashCards = null;
  if (row.dashboard_cards != null) {
    try { const p = JSON.parse(row.dashboard_cards); if (Array.isArray(p)) dashCards = p; } catch (e) {}
  }
  return {
    id: row.id,
    key: row.role_key,
    nameEn: row.name_en,
    nameCn: row.name_cn,
    descEn: row.desc_en || '',
    descCn: row.desc_cn || '',
    caps: list,
    layout: row.layout || 'default',
    storePinned: !!row.store_pinned,
    storeScoped: !!row.store_scoped,
    stockAppOnly: !!row.stock_app_only,
    roster: row.roster || 'team',
    isFixed: !!row.is_fixed,
    sortOrder: row.sort_order == null ? 100 : row.sort_order,
    dashboardCards: dashCards,
  };
}

// The tenant's roles, from cache when the version matches. Returns null — never
// throws and never an empty bundle — when the store can't be read, so callers
// can tell "no roles here, fall back" apart from "this tenant has no roles",
// which cannot happen for a seeded tenant.
function bundle(tenantId, version) {
  if (!tenantId) return null;
  const tid = Number(tenantId);
  const v = version == null ? versionFor(tid) : Number(version) || 0;
  const hit = CACHE.get(tid);
  if (hit && hit.version === v) return hit;
  ensureSchema();
  let rows;
  try {
    rows = db.prepare('SELECT * FROM tenant_roles WHERE tenant_id = ? ORDER BY sort_order, id').all(tid);
  } catch (e) { return null; }
  if (!rows || !rows.length) return null;
  const byKey = new Map();
  for (const r of rows) byKey.set(r.role_key, shape(r));
  const built = { version: v, byKey };
  CACHE.set(tid, built);
  return built;
}

// One role record, or null. `version` is the tenants row's roles_version when
// the caller already has it (the hot path always does).
function recordFor(tenantId, roleKey, version) {
  if (!roleKey) return null;
  const b = bundle(tenantId, version);
  return b ? (b.byKey.get(roleKey) || null) : null;
}

// The role's own capability list, or NULL meaning "no record — use the preset".
// Null is not the same as an empty array: a tenant may legitimately have edited
// a role down to nothing, and that must not silently resolve to the shipped
// preset's caps.
function capsForRole(tenantId, roleKey, version) {
  const rec = recordFor(tenantId, roleKey, version);
  return rec ? rec.caps : null;
}

// Every role in this tenant, in display order.
function listRoles(tenantId, version) {
  const b = bundle(tenantId, version);
  return b ? [...b.byKey.values()] : [];
}

// Is this a role this tenant actually has? Used by the invite and edit paths,
// which both now reject an unknown role rather than one coercing it to 'staff'
// while the other 400s. Falls back to the shipped list for an unseeded tenant so
// the guard can never lock a tenant out of its own Team page.
function isKnownRole(tenantId, roleKey, version) {
  const b = bundle(tenantId, version);
  if (b) return b.byKey.has(roleKey);
  return Object.prototype.hasOwnProperty.call(caps.PRESETS, roleKey);
}

// Bump the counter. MUST be called inside the same transaction as the write it
// describes — a bump that lands without the write, or a write without the bump,
// is a cache that serves the wrong answer until something else happens to save.
function bumpVersion(tenantId) {
  try {
    db.prepare('UPDATE tenants SET roles_version = COALESCE(roles_version, 0) + 1 WHERE id = ?').run(tenantId);
  } catch (e) { /* column not there — the cache will miss on every read instead */ }
  CACHE.delete(Number(tenantId));
}

// Drop a tenant's cache without touching the counter. For the seeder, which
// writes before anyone has read.
function invalidate(tenantId) { CACHE.delete(Number(tenantId)); }

// ══════════════════════════════════════════════════════════════════════════
// SEEDING
//
// Every tenant starts with FOUR roles: Owner, Manager, Shop floor, Stockroom.
// They are stamped out of the shipped presets, and they keep the presets' KEYS
// — 'owner', 'admin', 'staff', 'warehouse'. That is deliberate and it is what
// makes the deploy a no-op: no live account's `tenant_users.role` has to change
// for the new names to appear, so seeding and migrating are separate events and
// the migration can wait for its counts.
//
// The other five shipped presets are CARRIED, not retired, and only into tenants
// that actually have somebody on them. A tenant with nobody on Dispatch never
// sees a Dispatch role. They are carried rather than folded into the four
// because folding is a silent change of access on live accounts: store_manager
// into Manager would take a holder from 27 capabilities to 98, and from one
// store to every store, without anyone asking.
// ══════════════════════════════════════════════════════════════════════════

// The four. `preset` is the PRESETS key the capability list is stamped from.
const STARTING_ROLES = [
  {
    key: 'owner', preset: 'owner', isFixed: 1, sort: 10,
    en: 'Owner', cn: '负责人',
    descEn: 'Full access, always. Cannot be narrowed.',
    descCn: '始终拥有完整权限,不可缩减。',
  },
  {
    key: 'admin', preset: 'admin', sort: 20,
    en: 'Manager', cn: '经理',
    descEn: 'Runs everything and manages the team. Can’t change billing, edit others’ permissions, or delete a store.',
    descCn: '负责全部运营并管理团队。不能更改账单、编辑他人权限或删除门店。',
  },
  {
    // The description is rewritten rather than carried, for the reason the
    // Stockroom one below was: it said "Moves no money", and this role now
    // holds `till:use` — it takes payment across the counter. A description
    // that reads as a reassurance has to be accurate.
    key: 'staff', preset: 'staff', sort: 30,
    en: 'Shop floor', cn: '门店',
    descEn: 'Day-to-day shop floor — orders, stock, customers, and the counter till. Takes payment at the till; cannot refund. Sees wallet balances and product cost.',
    descCn: '门店日常——订单、库存、顾客与前台收银。可在收银台收款,不能退款。可看到顾客余额与产品成本。',
  },
  {
    // Was 'warehouse'. The description is rewritten rather than carried: the old
    // one said "No revenue shown, anywhere", which is true and incomplete — the
    // money marker shows this role commits purchase spend and edits material
    // costs. A description that reads as a reassurance has to be accurate.
    key: 'warehouse', preset: 'warehouse', layout: 'warehouse', sort: 40,
    en: 'Stockroom', cn: '仓库',
    descEn: 'Deliveries, counts and stock pushes. Buys from suppliers; never shown revenue.',
    descCn: '收货、盘点与库存推送。可向供应商采购,任何地方都不显示营收。',
  },
];

// The five, carried per tenant only where somebody holds them.
const CARRIED_ROLES = [
  {
    key: 'store_manager', preset: 'store_manager', layout: 'store_manager',
    storePinned: 1, storeScoped: 1, sort: 50,
    en: 'Store manager', cn: '店长',
    descEn: 'Runs one store — its orders, stock and customers. Their home opens on that store.',
    descCn: '负责一家门店——该店的订单、库存与顾客,首页只看本店。',
  },
  {
    key: 'customer_service', preset: 'customer_service', layout: 'customer_service', sort: 60,
    en: 'Customer service', cn: '客服',
    descEn: 'Refunds, invoices, order fixes and customer feedback.',
    descCn: '处理退款、发票、订单问题与顾客反馈。',
  },
  {
    key: 'dispatch', preset: 'dispatch', layout: 'dispatch', sort: 70,
    en: 'Dispatch', cn: '配送调度',
    descEn: 'Keeps deliveries moving — orders waiting to go out and orders on the road.',
    descCn: '盯配送——待派单与在途订单。',
  },
  {
    key: 'kitchen', preset: 'kitchen', storePinned: 1, stockAppOnly: 1, sort: 80,
    en: 'Kitchen', cn: '后厨',
    descEn: 'The Add Stock app for one store, and the queue of what has been asked for.',
    descCn: '一家门店的“加库存”应用,以及待制作队列。',
  },
  {
    key: 'store_stock', preset: 'store_stock', storePinned: 1, stockAppOnly: 1,
    roster: 'store', sort: 90,
    en: 'Store stock', cn: '门店库存',
    descEn: 'Counts one store’s shelves, from the Quick Stock app. Managed inside that store, not on the Team page.',
    descCn: '在“快速库存”中盘点本店货架。在门店内管理,不出现在团队页。',
  },
];

const ALL_SEEDS = [...STARTING_ROLES, ...CARRIED_ROLES];

// ── The seed and the staged rename have to agree on what a role IS ────────
// scripts/migrate_role_keys.js renames three of the four starting keys to match
// the names they carry: admin → manager, staff → shop_floor, warehouse →
// stockroom. ('owner' never moves, and the carried five keep their keys.)
//
// The seed below stamps the OLD keys, because that is what makes the deploy a
// no-op for a tenant that has not migrated. But it only ever asked "does this
// tenant have a row on MY key?" — so the first boot after a tenant migrated,
// admin/staff/warehouse all looked missing and were seeded again, right beside
// the rows they had just been renamed from. That is the two Managers, two Shop
// floors and two Stockrooms on the Roles tab: one carrying the tenant's people,
// one freshly stamped and held by nobody. Owner and the carried five never
// doubled because their keys never moved.
//
// So a seed is satisfied by EITHER of its keys, and a tenant is "on" a carried
// role under either of them too.
const RENAMED_KEYS = { admin: 'manager', staff: 'shop_floor', warehouse: 'stockroom' };

// Every key one seed can legitimately be sitting under.
function seedKeys(s) {
  const to = RENAMED_KEYS[s.key];
  return to ? [s.key, to] : [s.key];
}

// The rename plan, so the migration script and the seed read the same map
// rather than each keeping their own copy of it: [from, to, the English name
// the seed gave it].
const RENAMES = STARTING_ROLES
  .filter(s => RENAMED_KEYS[s.key])
  .map(s => [s.key, RENAMED_KEYS[s.key], s.en]);

function insertSeed(tenantId, s) {
  // owner's caps_json is stored for completeness but never read — presetCapsFor
  // and resolveCaps both short-circuit on the reserved literal.
  const list = caps.presetCapsFor(s.preset);
  db.prepare(`INSERT OR IGNORE INTO tenant_roles
      (tenant_id, role_key, name_en, name_cn, desc_en, desc_cn, caps_json,
       layout, store_pinned, store_scoped, stock_app_only, roster, is_fixed, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(tenantId, s.key, s.en, s.cn, s.descEn, s.descCn, JSON.stringify(list),
      s.layout || 'default', s.storePinned || 0, s.storeScoped || 0,
      s.stockAppOnly || 0, s.roster || 'team', s.isFixed || 0, s.sort);
}

// Seed one tenant. Idempotent — INSERT OR IGNORE on (tenant_id, role_key), so
// running it again after a tenant has renamed a role changes nothing.
// Returns the number of rows created.
function seedTenant(tenantId) {
  ensureSchema();
  let made = 0, dropped = 0;
  try {
    const have = new Set(db.prepare('SELECT role_key FROM tenant_roles WHERE tenant_id = ?')
      .all(tenantId).map(r => r.role_key));
    // Which of the carried five this tenant actually has people on. Inactive
    // accounts count: deactivating somebody must not delete their job.
    let held = new Set();
    try {
      held = new Set(db.prepare('SELECT DISTINCT role FROM tenant_users WHERE tenant_id = ?')
        .all(tenantId).map(r => r.role));
    } catch (e) { /* no tenant_users yet — a brand new tenant gets the four */ }

    const wanted = ALL_SEEDS.filter(s =>
      STARTING_ROLES.indexOf(s) !== -1 || seedKeys(s).some(k => held.has(k)));

    const write = db.transaction(() => {
      for (const s of wanted) {
        if (seedKeys(s).some(k => have.has(k))) continue;
        insertSeed(tenantId, s); made++;
      }
      // Clear up after the boots that already ran with the bug above.
      for (const s of STARTING_ROLES) if (dropReseededTwin(tenantId, s, have, held)) dropped++;
      if (made || dropped) bumpVersion(tenantId);
    });
    write();
  } catch (e) { return 0; }
  invalidate(tenantId);
  return made + dropped;
}

// Delete the empty twin a pre-fix boot stamped beside a migrated role — and
// ONLY that. Every one of these has to hold or the row stays: both keys present,
// nobody on the old one, and the row still byte-for-byte what insertSeed wrote.
// A tenant who edited the duplicate made it theirs; an edit is never deleted to
// tidy up a list, so a touched row is left standing and shows as a duplicate
// until somebody decides what it is for.
function dropReseededTwin(tenantId, s, have, held) {
  const to = RENAMED_KEYS[s.key];
  if (!to || !have.has(s.key) || !have.has(to)) return false;
  if (held.has(s.key)) return false;   // people on the old key — not a leftover
  let row = null;
  try { row = db.prepare('SELECT * FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').get(tenantId, s.key); }
  catch (e) { return false; }
  // updated_at is stamped by every edit path, so NULL means untouched since the
  // seed wrote it.
  if (!row || row.updated_at) return false;
  if (row.name_en !== s.en || row.name_cn !== s.cn) return false;
  if (row.desc_en !== s.descEn || row.desc_cn !== s.descCn) return false;
  if (row.caps_json !== JSON.stringify(caps.presetCapsFor(s.preset))) return false;
  try {
    db.prepare('DELETE FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').run(tenantId, s.key);
  } catch (e) { return false; }
  have.delete(s.key);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// ONE-TIME GRANT — till:use to the roles that can already ring a counter sale.
//
// THIS RUNS AT BOOT BECAUSE THE DEPLOY CANNOT RUN A SCRIPT. Shipping a file and
// bouncing pm2 is the whole of this project's deploy (.github/workflows/
// deploy.yml → scripts/deploy-apply.sh); nothing in that path executes a
// migration. So a capability that needs one has exactly two options: a human
// remembering to SSH in at the right moment, or this.
//
// WITHOUT IT THE DEPLOY IS A LOCKOUT. Roles are tenant DATA: seedTenant stamps
// caps_json out of the presets once, under INSERT OR IGNORE, so a capability
// added to a preset later never reaches an already-seeded tenant. Only `owner`
// picks one up, via resolveCaps' short-circuit. The counter till's new gates —
// the rail row, the phone's More row, and till.html's own boot check — all read
// `till:use`. Ship them without this and every non-owner cashier in every live
// business opens the till mid-shift and is told they have no permission.
//
// THE RULE: a role is granted `till:use` if, and only if, it already holds
// `orders:edit`. Not "if its preset now lists it" — that would ignore every
// edit a tenant has made to its own roles, which is the entire point of this
// table. `orders:edit` is the honest measure of who can ring a counter sale
// TODAY: the till has never had a capability of its own, it writes through the
// ordinary manual-order endpoint, and lib/cap-routes.js gates that on
// `orders:edit`. Copying that line forward means nobody loses the till, nobody
// gains the ability to transact, and a role a tenant narrowed stays narrow.
//
// SAFE IN EITHER ORDER against the file ship, which matters because a pm2
// restart and an in-flight request are not coordinated: resolveCaps DROPS
// unknown keys (`baseCaps.filter(k => KEY_SET.has(k))`), so a row carrying
// `till:use` resolves byte-for-byte as before against code that has never heard
// of it. Running early is a no-op; running late is the grant.
//
// Guarded by the _migrations ledger, like every other backfill in this codebase
// (database.js), so it is once-only rather than merely idempotent — a tenant
// that ticks the capability back OFF after this ran must not have it handed
// back on the next restart. That is the difference between a migration and a
// policy, and this is a migration.
const TILL_CAP_MIGRATION = 'grant_till_use_to_order_editors_v1';

function migrateTillCap() {
  ensureSchema();
  let granted = 0;
  let touched = [];
  try {
    db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    if (db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(TILL_CAP_MIGRATION)) return 0;

    const rows = db.prepare('SELECT id, tenant_id, role_key, caps_json FROM tenant_roles').all();
    const writes = [];
    for (const r of rows) {
      if (r.role_key === 'owner') continue;              // resolves to ALL; caps_json unread
      let list = null;
      try { const p = JSON.parse(r.caps_json || '[]'); if (Array.isArray(p)) list = p; } catch (e) { list = null; }
      if (!list) continue;                                // unreadable — never guessed at
      if (list.indexOf('till:use') !== -1) continue;      // already has it (freshly seeded)
      if (list.indexOf('orders:edit') === -1) continue;   // cannot ring a sale today either
      // Append then sort: resolveCaps returns sorted arrays and the role editor
      // reads these back, so a stable order stops two identical roles diffing.
      writes.push({ id: r.id, tenant: r.tenant_id, caps: list.concat(['till:use']).sort() });
    }
    touched = [...new Set(writes.map(w => w.tenant))];

    // The ledger row is written INSIDE the transaction with the grants, so the
    // migration cannot be marked done by a run whose writes rolled back. The
    // version bumps ride along for the same reason bumpVersion insists on it:
    // a bump without its write serves the wrong answer until something else saves.
    db.transaction(() => {
      const upd = db.prepare("UPDATE tenant_roles SET caps_json = ?, updated_at = datetime('now') WHERE id = ?");
      for (const w of writes) upd.run(JSON.stringify(w.caps), w.id);
      const bump = db.prepare('UPDATE tenants SET roles_version = COALESCE(roles_version, 0) + 1 WHERE id = ?');
      for (const t of touched) bump.run(t);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(TILL_CAP_MIGRATION);
    })();
    granted = writes.length;
  } catch (e) {
    // Best-effort, exactly like the seed below it. A failure here leaves the
    // ledger row unwritten, so the next boot tries again — and leaves the till
    // hidden for the affected roles in the meantime, which is the safe way for
    // this to fail: a tool nobody can reach, not money nobody can account for.
    return 0;
  }
  for (const t of touched) invalidate(t);
  return granted;
}

// Seed every tenant. Called once at boot from routes/backend-auth.js. Cheap and
// idempotent: for an already-seeded tenant it is one indexed read per tenant and
// no writes at all.
function seedAllTenants() {
  ensureSchema();
  let tenants = [];
  try { tenants = db.prepare('SELECT id FROM tenants').all(); } catch (e) { return 0; }
  let total = 0;
  for (const t of tenants) total += seedTenant(t.id);
  return total;
}

module.exports = {
  RENAMED_KEYS,
  RENAMES,
  ensureSchema,
  bundle,
  recordFor,
  capsForRole,
  listRoles,
  isKnownRole,
  bumpVersion,
  invalidate,
  seedTenant,
  seedAllTenants,
  migrateTillCap,
  TILL_CAP_MIGRATION,
  STARTING_ROLES,
  CARRIED_ROLES,
  LAYOUTS: ['default', 'store_manager', 'warehouse', 'customer_service', 'dispatch'],
  DASH_CARDS,
};
