# Per‑User Permissions (RBAC) — Build Plan

Goal: the tenant **owner/admin controls, per user, exactly what each operator can see and do** — and the
"same app, different view" cases (Quick Stock kitchen‑mode vs store‑mode, store‑manager vs marketing
person) become **admin‑configurable presets** instead of code I hardcode.

This plan covers the **backend operator realm** (`tenant_users` → retail‑admin "mini app backend" +
Quick Stock). The kitchen realm (`users`/`permissions`) already has its own module gating and is left
alone. The customer‑facing storefront/mini‑app is unaffected.

---

## 1. The model (one mechanism, two outputs)

```
                ┌─────────────────────────────────────────────┐
   role preset  │  effective caps = (preset ∪ grants) − revokes │
   + overrides  │                    ∩ tenant‑enabled features   │  → req.caps  (Set)
   + scope      │  owner ⇒ ALL (superuser bypass)               │  → req.scopeStores
                └─────────────────────────────────────────────┘
                        │                              │
                 SERVER enforces                CLIENT renders
              (real gate, every route)      (hide nav + buttons)
                        │                              │
                  403 if missing            "different view of same app"
```

- **Capability** — one gateable thing, keyed `section:action` (e.g. `orders:refund`, `products:edit`,
  `meituan:sync`). The master list lives in **one shared module** so server and client agree.
- **Role preset** — a named bundle of capabilities. Picking a preset fills sane defaults.
- **Per‑user override** — admin toggles individual caps on top of the preset (grant or revoke).
- **Scope** — which store(s) the user is limited to (generalises today's `retail_store_id`).
- **Entitlement intersect** — a cap for a feature the tenant's plan doesn't include is treated as absent,
  so plan gating still holds. **Owner** always resolves to ALL caps (cannot be locked out).

Resolution is computed **fresh on every request** from the DB (session stores only IDs today — no stale
permissions in a cookie). Result is attached as `req.caps` + `req.scopeStores`.

---

## 2. Capability registry (the master list)

Defined once in **`lib/capabilities.js`**, required by the server (enforcement) and shipped to the client
(rendering). Grouped to match the admin sidebar IA (RUN / SELL / SET UP). Each entry carries `key`,
`section`, `action`, `labelEn`, `labelCn`, and `feature` (for the plan intersect).

> Granularity = **section + actions** (your choice). Most sections expose `view / create / edit / delete /
> export`; money/ops‑sensitive areas get extra verbs. The split below is the proposed default — every line
> is a tunable toggle, not locked.

### RUN
| Section | Capabilities |
|---|---|
| Dashboard | `dashboard:view` |
| Orders | `orders:view` · `orders:edit` (status/fulfil) · `orders:refund` · `orders:export` |
| Invoices | `invoices:view` · `invoices:manage` (upload/issue) · `invoices:export` |
| Customers | `customers:view` · `customers:edit` · `customers:adjust` (points/wallet) · `customers:block` · `customers:export` |
| Activity (stock ledger) | `activity:view` · `activity:export` |
| Quick Stock | `quickstock:add` (kitchen made‑count) · `quickstock:recount` (store absolute) |

### SELL
| Section | Capabilities |
|---|---|
| Products | `products:view` · `products:create` · `products:edit` · `products:delete` · `products:export` |
| Categories | `categories:view` · `categories:edit` |
| Editor (storefront / PDP) | `editor:view` · `editor:edit` |
| Coupons | `coupons:view` · `coupons:create` · `coupons:edit` · `coupons:delete` · `coupons:grant` (issue/revoke to customers) |
| Flash sales | `flash:view` · `flash:edit` · `flash:delete` |
| Pop‑ups | `popups:view` · `popups:edit` · `popups:delete` |
| Broadcasts | `broadcasts:view` · `broadcasts:send` |
| Share cards / Social / Affiliate | `sharing:edit` · `social:edit` · `affiliate:view` · `affiliate:edit` |
| Membership & points | `loyalty:view` · `loyalty:edit` |
| Top‑up / Leaderboard / Voting | `topup:edit` · `leaderboard:edit` · `voting:edit` |

### CONTENT / INBOX
| Section | Capabilities |
|---|---|
| Snippets / About / Legal / FAQ | `content:view` · `content:edit` |
| Media library | `media:view` · `media:upload` · `media:delete` |
| Reviews | `reviews:view` · `reviews:moderate` |
| Feedback | `feedback:view` · `feedback:moderate` · `feedback:export` |

### SET UP (high‑privilege)
| Section | Capabilities |
|---|---|
| Delivery | `delivery:view` · `delivery:edit` · `delivery:delete` |
| Meituan | `meituan:view` · `meituan:map` · `meituan:sync` (force‑push) |
| gzgrocery / Guanyi | `guanyi:view` · `guanyi:map` · `guanyi:sync` |
| Shipping (KD100 / JD / Feie) | `shipping:config` |
| Settings — Shop | `settings:shop` |
| Settings — Push | `settings:push` |
| Settings — Payments (Alipay/OCR key) | `settings:payments` |
| Stores | `stores:view` · `stores:edit` · `stores:delete` |
| **Team & permissions** | `team:view` · `team:manage` (add/role/password) · `team:permissions` (edit others' caps) |
| Billing | `billing:view` · `billing:pay` |
| AI Brand Studio | `ai:view` · `ai:generate` · `ai:publish` |
| Diagnostics | `diagnostics:view` |

~70 capabilities. The admin UI groups them so nobody scrolls a flat list of 70.

---

## 3. Built‑in presets (defaults the admin starts from)

| Preset | What it grants | Replaces today's |
|---|---|---|
| **Owner** | ALL (locked superuser; manages team + permissions + billing) | `owner` |
| **Manager** | All RUN + SELL + CONTENT + INBOX; `stores:view/edit`, channel view; **no** billing, **no** `team:permissions`, **no** `stores:delete` | `admin` (tightened) |
| **Store manager** | RUN (orders/customers/activity/quickstock) + products view/edit + inventory, scoped to their store(s); no settings/team/billing/marketing | — |
| **Marketing** | SELL marketing + loyalty + content + reviews; `dashboard:view`; no orders/settings/inventory write | — |
| **Fulfillment** | `orders:view/edit/refund`, `customers:view`, `activity:view`, `quickstock:recount` | — |
| **Kitchen stocker** | `quickstock:add` only, one store | `kitchen` |
| **Store stocker** | `quickstock:recount` only, one store | `store_stock` |
| **Channel operator** | `meituan:*`, `guanyi:*`, `activity:view` | — |
| **Custom** | empty — admin builds it toggle by toggle | — |

`staff` (current "full access" label) maps to **Manager** on migration; existing owner/admin → **Owner**.
So **day‑one behaviour is unchanged** — nobody loses access until you deliberately tighten a preset.

---

## 4. Data model

Lives in the same DB as `tenant_users`. Built‑in presets live in **code** (`lib/capabilities.js`); only
deviations and custom roles hit the DB — keeps it light.

```sql
-- per‑user grant/revoke deltas vs their preset
CREATE TABLE tenant_user_caps (
  tenant_id       INTEGER NOT NULL,
  tenant_user_id  INTEGER NOT NULL,
  capability_key  TEXT    NOT NULL,
  mode            TEXT    NOT NULL,         -- 'grant' | 'revoke'
  updated_by      INTEGER,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_user_id, capability_key)
);

-- multi‑store scope (supersedes single retail_store_id; keep that column for back‑compat read)
CREATE TABLE tenant_user_stores (
  tenant_user_id  INTEGER NOT NULL,
  store_id        INTEGER NOT NULL,
  PRIMARY KEY (tenant_user_id, store_id)
);
-- tenant_users gains: scope_all INTEGER DEFAULT 1   (1 = all stores, 0 = only rows in tenant_user_stores)

-- OPTIONAL (Phase 5): tenant‑defined custom presets
CREATE TABLE tenant_roles (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, key TEXT,
  label_en TEXT, label_cn TEXT, capabilities_json TEXT,
  UNIQUE(tenant_id, key)
);
```

`tenant_users.role` stays = the preset key. No destructive migration.

---

## 5. Enforcement — server (the real gate)

Two pieces, both in play:

1. **Resolve once per request.** In `requireRetailAdmin` (`routes/retail.js:~103`, where `req.backendUser`
   is built) compute and attach `req.caps` (Set) + `req.scopeStores`. One DB read of `tenant_user_caps` +
   the in‑code preset map.
2. **Gate centrally + by exception.**
   - A **route→capability map** applied as one middleware across `/api/retail-admin/*` and
     `/api/backend/*` — so we don't hand‑edit every route. (e.g. `PATCH /orders/:id → orders:edit`,
     `POST /orders/:id/refund → orders:refund`.)
   - A `requireCap('x')` factory for the handful of routes that need bespoke logic.
   - Store‑scoped writes additionally check `storeId ∈ req.scopeStores` (generalises the existing
     `retail_store_id` check in `retail-inventory.js`).
   - **The hardcoded stock‑lockdown in `server.js:245‑264` is retired** — kitchen/store_stock simply have
     tiny cap sets and the central gate produces the same result. (Keep it as a fast‑path during rollout,
     delete once enforcement is proven.)

Owner bypass + entitlement intersect are applied in the resolver, so every gate sees the final truth.

---

## 6. Enforcement — client (the "different view")

- `/api/backend/me` returns `caps: []`, `scopeStores: []`, `featureFlags: {}`.
- **`01-core.js`** gets a tiny `can('orders:refund')` helper + nav builder:
  - Hide any nav section whose `:view` cap is absent (RUN/SELL/SET UP groups collapse when empty).
  - Inside a section, hide/disable action buttons (`create/edit/delete/export/refund/sync…`) by cap.
  - Render a clean "You don't have access to this" panel instead of a broken page on deep links.
- **Quick Stock (`stock.html`)** reads `quickstock:add` vs `quickstock:recount` to choose its mode —
  this **replaces the role check** and is literally your kitchen‑vs‑store "same app, different view."
- The command palette (Ctrl‑K) indexes only visible sections automatically (it builds from the DOM).

Client gating is **cosmetic** — the server is the authority. A hidden button that gets called anyway
returns 403.

---

## 7. Admin UI — the permission editor

Extends the existing **Team** page (`/backend/team`, `backend-team.js`). Gated by `team:permissions`.

Per user row:
- **Preset dropdown** (instant sane defaults).
- **"Permissions" button → drawer**: the capability matrix, grouped RUN/SELL/CONTENT/SET UP, sections as
  rows, verb toggles across. Toggles that deviate from the preset are highlighted (so you see overrides at
  a glance). EN/CN labels, `data-no-i18n` on the matrix container.
- **Store‑scope picker**: All stores / pick specific stores.
- Optional **"Preview as this user"** — open the app shell with their cap set to sanity‑check the view.

Guard rails: can't remove the last owner; can't grant yourself caps you don't hold; can't edit someone
above your privilege; owner row is read‑only (always‑all).

---

## 8. How it integrates with every current feature

| Feature (today) | Capability gate | What changes |
|---|---|---|
| Dashboard | `dashboard:view` | Hidden if absent |
| Orders / Invoices | `orders:*`, `invoices:*` | Refund/edit/export split out; read‑only clerks possible |
| Customers (points/wallet) | `customers:*` incl. `:adjust`, `:block` | Granting free value gated separately from view |
| Products / Categories | `products:*`, `categories:*` | Marketing person can be view‑only on catalog |
| Editor (storefront/PDP) | `editor:edit` | Lock non‑designers out of layout |
| Marketing (coupons/flash/popups/broadcasts/social/affiliate) | `coupons:* …` | `coupons:grant` & `broadcasts:send` gated tightly (money/comms) |
| Loyalty (membership/topup/leaderboard/voting) | `loyalty:*`, `topup/leaderboard/voting:edit` | — |
| Content (about/legal/faq/snippets/media) | `content:*`, `media:*` | Media delete separable (published‑content risk) |
| Reviews / Feedback | `reviews:moderate`, `feedback:*` | Moderation as its own grant |
| Delivery zones | `delivery:*` | Delete gated (affects routing) |
| **Meituan** sync | `meituan:view/map/sync` | Channel operator role; force‑push gated |
| **gzgrocery / Guanyi** sync | `guanyi:view/map/sync` | Same pattern; mapping mistakes are costly → gated |
| **Quick Stock** | `quickstock:add` / `:recount` | Mode chosen by cap, not hardcoded role |
| Activity ledger | `activity:view/export` | — |
| Settings (shop/push/payments) | `settings:shop/push/payments` | Payments + OCR API key behind `settings:payments` |
| Shipping (KD100/JD/Feie) | `shipping:config` | Credential screens locked down |
| Stores mgmt | `stores:view/edit/delete` | Create/delete store gated from edit |
| Team mgmt | `team:view/manage/permissions` | Who can change roles vs just view roster |
| Billing | `billing:view/pay` | Only owner/finance touches money |
| AI Brand Studio | `ai:view/generate/publish` | Publish (customer‑facing) gated above generate |
| Diagnostics | `diagnostics:view` | — |
| Platform console (system.\*) | *out of scope* | Separate realm (`platform_admins`); unaffected |
| Customer storefront / mini‑app / web | *out of scope* | Customer‑facing; no operator caps |

Multi‑tenant fit: caps are per `tenant_user`, scoped to the tenant. Each tenant's owner manages their own
team — this slots straight into the platform‑readiness roadmap for onboarding the 2nd tenant.

---

## 9. Rollout (phased, deploy‑safe)

> Reminder: **commit to `main` = live deploy.** Do permission work on a branch, or land it dark
> (enforcement flag default OFF) so nothing changes for live operators until we flip it per tenant.
> retail‑admin JS parts each need the `/* eslint-disable */` header; `sw.js` needs no bump — the deploy
> ships and stamps it; EN/CN labels + `data-no-i18n` on the matrix.

- **Phase 0 — Foundation (dark).** `lib/capabilities.js` registry + resolver attaching `req.caps`.
  **Shadow mode**: compute but don't block; log what *would* be denied. Verify no current operator is hit.
- **Phase 1 — Client view.** `can()` helper + nav/button gating + Quick Stock mode‑by‑cap. Everyone maps
  to Owner/Manager = full, so **zero visible change**; pure plumbing.
- **Phase 2 — Server enforcement.** Route→cap map goes live behind a per‑tenant flag; enable on a test
  tenant first, then ours. Retire the `server.js` stock‑lockdown.
- **Phase 3 — Admin editor.** Permission matrix drawer on the Team page + scope picker.
- **Phase 4 — Presets.** Ship the built‑in presets; migrate kitchen/store_stock to preset‑driven.
- **Phase 5 — Power features.** Per‑user overrides UI polish, custom roles (`tenant_roles`), "preview as".

Each phase is independently shippable and reversible. Phases 0–1 are invisible and safe to land first.

---

## 10. Open decisions (defaults chosen; change if you disagree)
1. **`staff` → Manager (full‑minus‑billing/team‑perms)** on migration. Alternative: keep `staff` = full and
   only tighten when you explicitly edit them. *(Default: keep full on day one; you opt into tightening.)*
2. **Granularity** confirmed: section + actions. A few sub‑sections (coupons, broadcasts, media, stores)
   get extra verbs because they're money/risk‑sensitive.
3. **Scope** generalised to multi‑store now, not just single‑pin — small extra table, future‑proofs
   per‑store managers.

---

## 11. Blockers — resolve before flipping `rbac_enforce`

These are **not** "defaults chosen" like §10. They are open holes in the enforcement model. 11.1 now has
a decided *approach* (not yet built); 11.2 and 11.3 are still unresolved. **Do not flip `rbac_enforce`
for any tenant until all three are answered** — including 11.1's shadow run actually completing. A lock
switched on while `/cms/publish` and `/config` are open gives false confidence — you'd believe you were
protected. That is worse than shipping no lock at all.

### 11.1 Fail‑open on unmapped mutations — the map is guessing, not declaring

`lib/cap-routes.js` `requiredCapFor` returns `null` (**allowed**) for any mutation whose path the map
doesn't match. That makes the map's *completeness* a security boundary: a mutation nobody thought to map
is **open**, not closed. This has already been proven wrong repeatedly — the audit found and fixed six
path‑shape misses, four of them fully fail‑open:

- `/orders/:id/refund-reject` (hyphen alias missed the `/refund/` pattern → refund action at `orders:edit`)
- `/voucher-grants/:id` DELETE (`voucher-grants` ≠ `vouchers` → **null, ungated** revoke)
- `PUT /category-tree` (`category-tree` ≠ `categories` → **null, ungated** full‑tree rewrite)
- `/brand/*` generate/apply/publish (studio lives under `/brand`, cap area is `/ai` → **null, ungated**; `/brand/publish` goes LIVE to shoppers)
- `/media/bulk-delete` (POST, not DELETE → delete at `media:upload`)
- `/products/:id/duplicate` (creates a product at `products:edit`)

And whole mutation areas are **open** right now — unmapped, ungated, no distinction between the two at
runtime: `/cms/*` (the storefront page editor — `/cms/publish`, `/cms/layout/draft`), `/config`,
`/printer`, `/fapiao-settings`, `/topup-packages`, `/topup-transactions/:id/finalize`,
`/leaderboard/config`, `/voting/config`, `/polls`, `/affiliate/*`, `/alipay-manual`. Each has a cap
defined in `capabilities.js` (`editor:edit`, `topup:edit`, `voting:edit`, `affiliate:edit`, …) but no
rule wiring it — and this list was assembled **by hand**, which is exactly the problem: nobody knows what
else is missing.

The root cause is architectural: **caps are inferred from URL shape in a central map instead of declared
at the route where the handler is defined.** Every new route is a silent hole until someone eyeballs it.

**Decision (2026-07-17): both, in this order.** Not built in this pass — recorded here as the approach.

1. **Deny-by-default in shadow, first.** Flip the unmatched-mutation default from allow to **deny**, but
   run it in **shadow mode — log what *would* be blocked, don't block**. Let it ride real operator traffic
   for ~a week. This is the whole point: right now the unmapped list is a hand-assembled guess and *nobody
   knows what's missing*. Deny-by-default turns an unknowable audit into a concrete list of real 403s from
   real traffic — the map writes itself from what actually fires. Guessing at the remaining paths by eye is
   how we got here.
2. **Then per-route `requireCap`.** The durable end state: a route that declares its own cap at its
   definition **cannot be missed by a regex** — the central map stops being a guessing layer (the factory
   §5 already anticipates this). But it's a sweep across a ~20k-line `routes/retail.js`, and doing it blind
   means guessing which routes matter. Do it **after** shadow mode has told you which routes actually fire,
   not before.

The order matters: (1) is the cheap gate that makes the truth visible; (2) is the real fix, informed by
what (1) surfaced. Either way the default must become **deny** before `rbac_enforce` goes on — but neither
step is this pass. This pass delivered the six fixes above and this writeup; shipping the shadow flip is
its own tested pass, one concern at a time.

### 11.2 Reads open by design — scope, don't blanket

Every GET returns `null` → ungated (deliberate: the client hides sections, so a shared read like a store
picker or the order‑drawer customer lookup never 403s). Fine while `rbac_enforce=0` and caps resolve to
ALL. The day it flips, sensitive reads (customer PII export, revenue, credential read‑back) stay
fetchable server‑side while only the UI hides them. **Decision owed:** classify reads into *shared*
(stay open) vs *sensitive* (gate) — not blanket‑open, not blanket‑403.

### 11.3 `/integrations/*` credential config is intentionally open — write the decision, don't comment it

The channel map deliberately does **not** gate `/api/retail-admin/integrations/*` (payment keys, JD / SMS
/ courier credentials), justified only by an inline comment in `cap-routes.js` ("don't broaden this to
/integrations"). That is the **highest‑privilege write surface in the backend** — API secrets — sitting
ungated on the strength of a code comment. **Decision owed:** does credential config require
`integrations:manage` (or a dedicated `integrations:secrets`)? If yes, map it. If it is intentionally
open, that belongs here in writing with the reason — not buried in the map. Until decided, treat it as a
hole.
