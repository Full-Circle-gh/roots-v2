# Channels & Logistics Plugins — Plan

Turn the bespoke Roots integrations (Meituan, Eleme, mini app, JD, Qingyun) and
multi-store setup (Tianhe / Yuexiu) into **self-service plugins** a new Full Circle
tenant can enable alone from the admin — with a built-in "we'll help you" escape
hatch on every step.

> **v2 — audited against the codebase.** Corrections from the audit are marked
> inline; the biggest ones: multi-tenancy is DB-per-tenant (not tenant_id
> columns), the daemons are more DB-coupled than v1 assumed (worker split needs
> a real internal API), the JD/kd100 credential forms and the channel×store
> close matrix already exist in the admin, and features.js has no plan tiers or
> integration keys yet.

## Decisions already made

| Question | Decision |
|---|---|
| Operating model for setup | **Model A (self-service) with assisted escape hatch** — every wizard step has a "Get help" button; platform support can take over and finish any tenant's setup in the same UI. |
| Holding merchants' Meituan credentials / running scraper sessions on their behalf | Yes — acceptable. |
| Guanyi / gzgrocery (管易) | **Roots-only.** Stays out of the tenant-facing plugin list; never generalized. |
| Shangou (美团闪购) | **Folds into the Meituan plugin** — one "Meituan" card covers waimai + shangou. |
| Where scraper daemons run | **Platform-operated worker hosts** (never tenant-run servers — that would kill Model A). Scraper compute moves OFF the main Roots server onto dedicated Playwright worker VPSes. |
| Egress / ban risk | **Per-tenant egress IPs**: a residential **store box** (small ARM device on the merchant's own store broadband, reverse tunnel) as the primary route; a GZ proxy server with per-tenant IPs as the degraded fallback. No commercial residential-proxy services. |

## What exists today (and what's wrong with it for new tenants)

Every integration already *works* — for Roots. None is set-up-able by anyone else:

| Piece | Works via | Blocker for a new tenant |
|---|---|---|
| Mini app (WeChat) | `miniapp/`, full first-party channel | Needs their own 小程序 + WeChat Pay — already modeled in `lib/onboarding-steps.js` + `tenant_onboarding`, but checklist is passive (status only, no interactive credential collection/validation) |
| Meituan | `lib/meituan-browser.js` Playwright scraper + `scripts/meituan-daemon.js` | Session logged in by hand on the server. Store list is already data-driven from `retail_stores` (audit: better than v1 assumed) — but creds come from env keyed `MEITUAN_<CODE>_USER/PASS`, and Roots' opening hours are hardcoded (`STORE_HOURS = {yuexiu, tianhe}`, daemon line ~75) |
| Eleme | `lib/eleme-client.js` real OAuth API + `scripts/eleme-daemon.js` | `authorizeUrl()`/`exchangeCode()`/`refreshToken()` exist but no tenant-facing connect flow; platform app key/secret from env; no `capabilities.js` section; still a "placeholder" in the channel-close matrix (`01-core.js:405`) |
| JD logistics | `lib/jd.js` JOS signing scaffold; **credential form already exists** in Settings → Operations (app_key/secret/token/customer_code + sandbox toggle, `retail-admin.html` ~3775) | `createWaybill` guarded/disabled; form writes Roots' global config, not tenant-creds; no live "Save & test" verification |
| Qingyun (青云聚信, rider tracking) | `lib/qingyun-browser.js` + daemon (CDP-attach to real Chrome under Xvfb) → `delivery_jobs` | Manual browser session; store list from env `QINGYUN_STORES`; single-account assumption |
| Locations | `retail_stores` + per-store stock + `routeOrder()` in `lib/inventory.js`; **Add/Edit store form already exists** (Settings → Operations → Stores) | No guided wizard; a new store isn't prompted into connected channels; no quota/zone defaults seeding |
| Channel × store close matrix | `channel_status` table + working UI (`01-core.js:307-426`, per-cell dots, per-location master close) | Meituan lives separately in `store_business_status`; Eleme cells are placeholder |
| Per-tenant secrets | `lib/tenant-creds.js` (AES-256-GCM via secret-box; Roots env carve-out) | Integrations don't read through it yet; Meituan key names hardcode `tianhe`/`yuexiu` |

Three structural gaps, one plan: **(1)** no per-tenant credential threading in the
integrations, **(2)** no "integration" concept in the data model (no single row that
says *connected / error / last sync*), **(3)** setup knowledge lives in operators'
heads, not in wizards.

---

## Architecture

### 0. Multi-tenancy reality: DB-per-tenant (audit finding)

`database.js` has **zero `tenant_id` columns** — by design. `lib/tenant-db.js`
gives every non-Roots tenant its own SQLite file (`data/tenants/<id>.db`),
schema-cloned from the main DB; Roots (tenant #1) stays on the shared `roots.db`
unchanged. Consequences for this plan:

- **Data-plane tables need no schema change for tenancy.** `eleme_tokens`
  (keyed by store_code), `eleme_shops`, `meituan_*` sync tables, `delivery_jobs`,
  `qingyun_status`, `channel_status` all exist inside each tenant's own DB file
  already. v1's "tenant scoping review" is replaced by a simpler question per
  table: data plane (cloned per tenant) or control plane (shared)?
- **Control-plane placement is the real decision.** The new registry +
  help-request tables (below) must live in the shared `roots.db` and be added to
  `CONTROL_PLANE_TABLES` in `lib/tenant-db.js`, because saas-admin needs
  cross-tenant views of them.
- **Remote workers can never open these DB files** — SQLite over the network is
  not a thing, and tenant DBs are separate files anyway. This makes the worker
  API (§3b) mandatory, not optional.

### 1. Integrations registry (the spine)

One **control-plane** table both the tenant settings hub and the saas-admin
support dashboard read:

```sql
CREATE TABLE tenant_integrations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  kind         TEXT NOT NULL,   -- 'eleme' | 'meituan' | 'jd' | 'qingyun' | 'wechat_miniapp'
  status       TEXT NOT NULL DEFAULT 'not_configured',
    -- not_configured | in_setup | connecting | connected | error | paused
  config_json  TEXT,            -- non-secret config (shop ids, store mappings, toggles)
  health_json  TEXT,            -- last_sync_at, last_error, session_expires_at, counters
  setup_state  TEXT,            -- JSON: step_key -> { status, error, updated_at, by }
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, kind)
);
```

Each plugin registers a **descriptor** in a new `lib/integrations/registry.js`:

```js
{ kind: 'eleme', labelEn/Cn, category: 'channel' | 'logistics',
  steps: [...],            // wizard step definitions (same shape as onboarding-steps)
  credKeys: [...],         // tenant-creds keys it needs
  healthCheck(tenant),     // → { ok, detail } — powers the card badge
  verify(tenant),          // smoke test — final wizard step, every plugin has one
  disconnect(tenant),      // teardown hook (below)
  onStoreAdded(tenant, store),  // channel-linking prompt hook
  capsSection: 'eleme' }
```

Secrets never live in this table — they go through `lib/tenant-creds.js`. This table
holds only status, mappings, and step progress.

**Per-step state machine** (shared with the wizard UI):
`pending → in_progress → waiting_external → failed(error) → done`, plus `done_by:
'tenant' | 'support'` so "✅ Completed by Full Circle support" renders honestly.
Reuse the `en/cn/owner/status` step shape from `lib/onboarding-steps.js` so **one
wizard renderer** serves both the mini-app checklist and integration wizards.

**Lifecycle beyond setup (new in v2)** — every card gets three quiet actions:
- **Pause**: stop sync, keep all config/creds — one click to resume.
- **Disconnect**: revoke tokens where the platform supports it (Eleme), clear the
  plugin's tenant-creds keys (`clearTenantSecret`), de-adopt from daemons/workers,
  keep mappings for a 30-day grace, then prune.
- **Reconnect** after error — re-runs only the failed step, not the whole wizard.

**Verification step (new in v2)** — every wizard ends with a live smoke test:
JD = signed test call; Eleme = fetch shop info with the new token; Meituan =
read today's order list; Qingyun = poll one status page; mini app = the existing
order→pay→refund smoke test from the go-live checklist. A plugin is never
"connected" on faith.

### 2. tenant-creds generalization (prerequisite fix)

`lib/tenant-creds.js` currently defines `MEITUAN_TIANHE_USER` / `MEITUAN_YUEXIU_PASS`
— Roots' store codes baked into the platform key namespace. Replace with **dynamic
per-store keys**: `meituan.<store_code>.user|pass` validated against the tenant's
`retail_stores.code` instead of the fixed `KEYS` whitelist. Also:

- `qingyun.user` / `qingyun.pass` (+ per-store variants if accounts are per-POI);
  the daemon's env `QINGYUN_STORES` list becomes data-driven like Meituan's.
- Eleme merchant tokens stay in the data-plane `eleme_tokens` table (per-store,
  inside each tenant's own DB — audit confirmed no schema change needed).
  `eleme.app_key/app_secret` stay **platform-level** env (it's OUR open-platform
  app; tenants authorize into it) — document this asymmetry in the module header.
- Roots keeps its env carve-out exactly as today (zero behaviour change).
- Kill the remaining Roots constants in daemons: `STORE_HOURS` moves to a
  `retail_stores` column (or config), env cred lookup goes through
  `getTenantCreds`.

### 3. Shared session manager for scraper-based integrations

Meituan and Qingyun are both "logged-in browser session" integrations. Build the
machinery **once** (`lib/integration-session.js`):

- Per-tenant (or per-tenant-store) persistent Playwright profiles/storage-state,
  keyed `<tenant>/<kind>[-<store>]`, living on the worker host that owns the tenant
- **Interactive login relay**: worker-side Playwright drives the login; the tenant
  types username/password and the **SMS code into our wizard UI**; the wizard
  long-polls a login-attempt state (`awaiting_sms`, `captcha`, `failed`, `ok`).
  This is the one genuinely new hard component in the plan.
- **Expiry detection → re-auth flow**: daemons already notice dead sessions; route
  that signal into `health_json` so the card flips to "⚠️ session expired — re-verify"
  and the same login relay re-runs. Session health is a first-class feature —
  it is the *recurring* pain, more important than first-time setup.
- **Session hibernation**: between polls, persist the browser storage-state and
  close the context — idle tenants cost ~0 RAM; pay a few seconds of restore per
  poll. Only the login relay (setup / re-auth) holds a continuously live browser.
- **One Chromium, many contexts**: Playwright supports per-context proxy settings,
  so one browser process serves multiple tenants, each context routed through that
  tenant's own egress (below). (Qingyun today CDP-attaches to a real headful
  Chrome under Xvfb — whether that survives contextization needs a phase-7 spike.)

### 3b. Scraper workers + per-tenant egress (phases 6–7 prerequisite)

Two separate risks, two separate mechanisms — neither means tenant-run servers
(a shop owner who needs a help button for an SMS code cannot operate a server;
tenant-run daemons would kill Model A and put credentials on unpatched machines):

**Compute — dedicated worker hosts.** Chromium is heavy (~150–300 MB RAM per live
logged-in context + CPU spikes); the main Node/SQLite box must never run it. The
scraper daemons (meituan / shangou / qingyun) move to cheap platform-operated
worker VPSes, ~10–20 tenants per worker, scaled horizontally.

> **Audit correction — this is bigger than v1 said.** Today all three daemons
> run pm2-alongside server.js and open the SQLite file **directly** via
> `require('../database')` (running full schema migrations on load!), reading and
> writing dozens of tables by direct SQL (`meituan_sync_queue`, `meituan_listings`,
> `store_business_status`, `delivery_jobs`, …); only order-ingest already goes over
> localhost HTTP (`/api/internal/*/ingest-order`, `X-Internal-Secret`). A remote
> worker cannot open these files at all (§0). So phase 6 includes building a real
> **worker API** on the main server, tenant-routed via `getTenantDb`:
> queue lease/ack (stock-push + listing jobs), session/storage-state read+write,
> business-status + health heartbeats, and the existing ingest endpoints.
> Bounded, enumerable — but a work package of its own, not "a small API."

Roots' two stores become tenant #1's entries on worker #1 — migrated **last**,
after the API proves itself with new tenants.

**Egress — what Meituan sees is the IP + fingerprint, not the server.** N merchant
accounts logging in from one datacenter IP is the ban pattern; per-tenant egress is
non-negotiable:

1. **Store box (primary, default).** Small ARM device (~¥200–400) on the merchant's
   own store broadband. To Meituan the merchant logs in from their own shop — right
   city, right district, genuinely residential — the most natural fingerprint
   possible, and it auto-solves geo-match for future non-GZ tenants. China store
   broadband is NATed with no public IP, so the box **dials out** (WireGuard/frp
   reverse tunnel) and the worker routes that tenant's browser context back through
   the tunnel as SOCKS. Shipped as a Meituan-plugin onboarding step ("plug it in,
   the light turns green") and honestly chargeable as a hardware add-on; can later
   host other in-store roles (print relay, POS failover).
   **Pilot: Roots' own Tianhe + Yuexiu stores run the first two boxes** before any
   customer ships — real-world burn-in on our own accounts.
2. **GZ proxy server with per-tenant static IPs (fallback only).** Datacenter IPs
   are more detectable and only geo-match GZ merchants; used automatically when a
   tenant's box goes offline — sync limps instead of dying, card shows the warning.
   (The daemons already health-gate on a GZ proxy via `lib/proxy-manager` — this
   generalizes that, it doesn't invent it.)
3. **Commercial residential-proxy services: rejected.** Legally murky in China,
   often botnet-sourced — unacceptable while holding merchants' credentials.

Egress health feeds `health_json` with explicit states:
`box_online | box_offline_fallback | session_expired`, each with its own card
badge + re-auth / "check the box" guidance. Per-tenant fingerprint stays
consistent (UA, timezone, viewport) across restores.

### 4. Assisted self-service (help, take-over, alerting)

- **"Get help" button on every wizard step.** Creates a row in a new
  **control-plane** `integration_help_requests` table: tenant, kind, step_key,
  last error, attempt count, free-text note, status
  (`open | in_progress | resolved`). Present from **phase 1** — it's cheap and
  every later wizard inherits it.
- **Operator notification** — audit correction: `lib/ops-alert.js` is Roots' own
  single-WeCom-group broadcast (keyed off `storefront_config`), and web-push is
  app-user-keyed; neither is a drop-in per-tenant notifier. New-but-small: a
  platform-level ops webhook (same WeCom-robot pattern, platform config not
  tenant config) that fires on help requests and integration errors.
- **Tenant-facing alerting (new in v2)**: when a session expires or a box goes
  offline, the *tenant* is told too — via their existing Settings → Push
  notifications channels (their WeCom new-order alert app / web-push), not just
  the card badge they may not be looking at. Ops sees it; the tenant sees it;
  nobody discovers it three days later via lost orders.
- **Take-over mode in saas-admin**: a platform operator opens the tenant's *same*
  wizard, acting on their behalf. Needs an "operator acting as tenant" session
  concept + audit trail (`done_by: 'support'`, who/when). Support never sees
  stored plaintext secrets — take-over *uses* creds via the same server-side
  resolvers, it doesn't display them.
- **Stuck-tenant dashboard** in saas-admin: all tenants × integrations × current
  step + days-stuck + open help requests, so silent abandonment is visible before
  the customer gives up.

### 5. Settings hub UI — "Channels & Delivery"

New retail-admin section (new load-ordered file, `public/retail-admin/15-integrations.js`,
following the `14-eleme.js` init/poll/onLangChange pattern): a card grid — Mini App,
Eleme, Meituan, JD, Qingyun — each card shows status badge, health line (last sync /
error), per-store state pills (the admin convention is stores side-by-side, never a
global store switcher), and one primary action: **Set up** / **Fix** / **Manage**.
Bilingual `EN · 中文` labels like the rest of the admin.

Placement + de-duplication (audit findings):
- The **channel × store close matrix already exists** on the Sales page
  (`01-core.js:307-426`) — new channels join it (Eleme drops its "placeholder"
  cell; Meituan keeps its separate `store_business_status` 置休 mechanism but
  surfaces it in the same grid).
- The **JD + kd100 credential forms already exist** in Settings → Operations —
  they become the JD card's wizard body (moved/linked, not duplicated), rewired
  from global config to tenant-creds, plus the missing "Save & test" live call.

Capabilities + entitlements (audit corrections):
- `lib/capabilities.js` additions: `integrations:view`, `integrations:manage`,
  plus the missing `eleme:view/map/sync` section (UI file exists with no caps
  today). Extend the `channel` preset.
- `lib/features.js` has **no plan tiers and no integration keys** today — its 6
  keys are all customer-facing app features. Add entitlement keys
  (`channel_meituan`, `channel_eleme`, `logistics_jd`, `tracking_qingyun`) so a
  plugin can be plan-gated / sold as an add-on; the saas-admin entitlement UI is
  net-new work (small). Meituan's hardware fee can reuse the existing
  `POST /api/saas-admin/tenants/:id/setup-invoice` billing path.

---

## Per-plugin plans

### Locations (closest to done — do first)

`retail_stores` is already data-driven with routing, per-store stock, and channel
quotas; the Add/Edit store form already exists in Settings → Operations. The work
is the *guided* wrapper:

1. **"Add location" wizard** wrapping the existing form: name EN/CN → address via
   existing `lib/geocode.js` + `china_districts.json` district picker (lat/lng
   auto) → pickup on/off → hours → initial delivery zones (reuse
   `retail_delivery_zones` UI).
2. **Channel-linking prompts**: on save, every *connected* channel integration gets
   a to-do on its card — "New location: link Meituan POI / Eleme shop / set channel
   quotas." Descriptor hook: `onStoreAdded(tenant, store)`.
3. Seed `channel_status` rows and default `retail_store_stock` quotas for the new
   store.

### Eleme (reference plugin — build second, sets the pattern)

The only channel with a real OAuth API; the flow is genuinely 100 % self-service:

1. Card → **Connect Eleme** → redirect to `authorizeUrl(state)` (exists,
   `lib/eleme-client.js:62`) → merchant logs into ele.me and approves → callback
   exchanges code (`exchangeCode`, exists) → tokens land in the tenant's own
   `eleme_tokens` (per-store, data plane — no schema change).
2. Wizard step 2: pull the merchant's shop list → map each Eleme shop to a
   `retail_stores` row (persist in `eleme_shops`).
3. Step 3: product mapping into `eleme_product_map` (reuse the `14-eleme.js`
   mapping UI inside the wizard).
4. Step 4: **verify** (fetch shop info with the new token) → enable sync → daemon
   picks up the tenant; card turns **connected**; token auto-refresh
   (`refreshToken`, exists) feeds `health_json`.
5. Finish the half-wiring: real `channel_status` participation (drop the
   placeholder cell in the close matrix) + the missing capabilities section.

### JD logistics (smaller than v1 thought — the form exists)

1. **Unblock `createWaybill`** — confirm the merchant endpoint against a real JOS
   app, remove the guard (a Roots task, but it gates the plugin).
2. Move the existing Settings → Operations JD form behind the JD card as its
   wizard; rewire writes from global config to tenant-creds (`jd.*` keys already
   defined); add the missing **"Save & test"** live signed call with mapped error
   messages.
3. Other carriers (SF/ZTO/YTO/…) stay tracking-only via kd100 — its existing
   credential form gets the same tenant-creds rewire, no wizard needed.

### Meituan (+ Shangou) — flagship "assisted" plugin

No official API; it's the session-based scraper. Self-service flow, with help
expected and designed-in:

1. **Store box onboarding step**: we ship the box; merchant plugs it into store
   power + network; wizard waits for the reverse tunnel to come up ("light turns
   green" → step done). Support escape hatch: proceed on the GZ fallback proxy
   with a visible "degraded" note if the box is delayed.
2. Wizard collects the merchant's 美团商家版 credentials per store → encrypted
   per-tenant, per-store (`meituan.<store_code>.user/pass` after the tenant-creds fix).
3. **Login relay** (shared session manager, running on a scraper worker, egressing
   through that tenant's box): worker Playwright logs in; tenant types the SMS code
   into the wizard; on success the session persists and the daemon adopts the tenant.
4. Map Meituan POIs (门店) → `retail_stores`; map products → `meituan_product_map`;
   enable stock push + order mirroring; **verify** (read today's order list).
   Shangou rides along as a toggle inside the same card (same session family,
   `lib/shangou-browser.js`).
5. If login relay fails twice → prominent **"We can connect Meituan for you"**
   handoff → help request with full context; support finishes via take-over.
   That's the plan working, not failing.
6. Multi-tenant daemon: the loop generalizes per tenant × store on the worker
   fleet (store list is already data-driven; the env-cred convention and
   `STORE_HOURS` constants are what die).

### Qingyun (rider tracking)

Same shape as Meituan — reuses the session manager, worker fleet, per-tenant
egress (same store box/tunnel — one box serves all of that tenant's scraper
sessions), and login relay wholesale. Wizard: credentials → session → map stores
(env `QINGYUN_STORES` becomes data-driven) → **verify** → daemon adopts tenant.
Build only after Meituan proves the session machinery; spike early whether the
CDP-attach headful-Chrome approach survives per-context proxies.

### Mini app (WeChat) — make the existing checklist interactive

`lib/onboarding-steps.js` + `tenant_onboarding` already model the A-to-Z, with
working saas-admin endpoints (`GET/PATCH /api/saas-admin/tenants/:id/onboarding*`).
Upgrade, don't replace:

1. Steps that collect credentials (`appid`, `pay_creds`) become **forms writing to
   tenant-creds**, each with a live verification call ("✅ AppID+secret valid",
   "❌ Pay cert rejected: …") — `credsStatus()` already exposes the booleans.
2. Mark steps `waiting_external` when on WeChat's clock (review, verification) so the
   checklist shows *whose move it is*.
3. Surface the checklist as the "Mini App" card in the same Channels hub, so a new
   tenant sees one place for everything.
4. Model B ('managed') keeps working unchanged — same checklist, `owner: 'us'` steps
   are simply support-driven from day one.

---

## Build order

Each phase ships alone and is useful alone:

1. **Foundation** — `tenant_integrations` + `integration_help_requests`
   control-plane tables (+ `CONTROL_PLANE_TABLES` registration) + registry +
   per-step state machine; tenant-creds Meituan key generalization; caps
   (`integrations:*`, `eleme:*`) + features.js integration keys; Channels &
   Delivery card hub; **basic Get-help capture + platform ops webhook** (moved up
   from phase 4 — cheap, and every later wizard inherits it).
2. **Locations wizard** + channel-linking prompts (smallest real wizard, no external
   dependency, immediately useful to Roots itself).
3. **Eleme self-service connect** end-to-end (reference plugin; also finishes
   Eleme's channel_status + caps wiring).
4. **Take-over + dashboards + alerting** — operator-acting-as-tenant with audit
   trail, saas-admin stuck-tenant dashboard, tenant-facing session/box alerts.
   (Deliberately after one real wizard exists to take over.)
5. **JD** — unblock waybill, move the existing form behind the card, tenant-creds
   rewire, live "Save & test".
6. **Scraper workers + egress layer, then Meituan** — the **worker API**
   (queue lease/ack, session state, status writes, heartbeats — the audit-corrected
   scope), worker-host split, store-box provisioning + reverse tunnel + per-context
   proxy routing + GZ fallback, THEN login relay, per-tenant sessions,
   multi-tenant daemon, POI/product mapping, Shangou toggle. **Prototype the box
   tunnel + login relay first — they are the two hard unknowns.** Pilot boxes in
   Roots' own Tianhe/Yuexiu stores; migrate Roots' daemon to a worker last.
7. **Qingyun** — reuse workers, egress, and session manager (+ the CDP/context spike).
8. **Mini app checklist interactive** — credential forms + live verification +
   waiting_external states, surfaced as a hub card.

**Success metric per plugin** (measured from `setup_state` timestamps): median
time from "Set up" click to *verified connected*, and % completing without a help
request. Targets to beat: Eleme < 15 min fully alone; JD < 10 min; Meituan < 48 h
including box shipping, with the SMS step < 10 min once the box is live.

## Risks / notes

- **Meituan/Qingyun ToS + account safety**: scraping merchant portals on customers'
  behalf risks captchas, device checks, account flags. Mitigate: per-tenant egress
  IPs (store box §3b — the merchant appears to log in from their own shop),
  per-tenant isolated browser profiles + consistent fingerprints, human-paced
  automation (the daemon's existing anti-bot machinery — verify cooldowns, jitter,
  session latches — carries over), and the assisted fallback as the documented
  degraded mode. (Decision to accept this risk: made.)
- **The two hard unknowns are the login relay and the box tunnel** — SMS/captcha
  round-trips through a web UI with a headless browser holding state, and reliable
  reverse tunnels over NATed store broadband. Prototype both early in phase 6;
  nothing else depends on them before then.
- **Worker API scope (audit)**: the daemons' direct-SQL surface is wide; enumerate
  it table-by-table before estimating phase 6. It is bounded and mechanical, but
  it is its own work package.
- **Store-box operational load**: hardware shipping/provisioning, boxes unplugged
  by staff, store ISP changes. Mitigate: auto-fallback to the GZ proxy + explicit
  `box_offline_fallback` health state + "check the box" guidance on the card; keep
  a provisioning image so replacement = swap and plug in.
- **Control-plane vs data-plane placement** must be decided per new table at
  creation time (§0) — a registry row accidentally cloned into tenant DBs, or
  channel data accidentally in the shared DB, are both painful to unwind.
- **Commits deploy to production** (post-commit hook) — every phase must be dark
  behind the registry (`status: not_configured` renders nothing risky) and behind
  the new features.js entitlement keys.
