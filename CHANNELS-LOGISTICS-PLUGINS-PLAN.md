# Channels & Logistics Plugins — Plan

Turn the bespoke Roots integrations (Meituan, Eleme, mini app, JD, Qingyun) and
multi-store setup (Tianhe / Yuexiu) into **self-service plugins** a new Full Circle
tenant can enable alone from the admin — with a built-in "we'll help you" escape
hatch on every step.

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
| Meituan | `lib/meituan-browser.js` Playwright scraper + `scripts/meituan-daemon.js` | Session logged in by hand on the server; creds from env; store codes hardcoded |
| Eleme | `lib/eleme-client.js` real OAuth API + `scripts/eleme-daemon.js` | `authorizeUrl()` exists but no tenant-facing connect flow; app key/secret from env; no `capabilities.js` section; still a "placeholder" in `channel_status` |
| JD logistics | `lib/jd.js` JOS signing scaffold | `createWaybill` guarded/disabled; creds from env for Roots; no setup form |
| Qingyun (青云聚信, rider tracking) | `lib/qingyun-browser.js` + daemon → `delivery_jobs` | Manual browser session; single-account assumption |
| Locations | `retail_stores` + per-store stock + `routeOrder()` in `lib/inventory.js` — already data-driven | No guided "Add location" flow; new store isn't prompted into connected channels; `tenant_creds` Meituan keys hardcode `tianhe`/`yuexiu` |
| Per-tenant secrets | `lib/tenant-creds.js` (AES-256-GCM via secret-box; Roots env carve-out) | Integrations don't all read through it yet; Meituan keys are per-Roots-store, not generic |

Three structural gaps, one plan: **(1)** no per-tenant credential threading in the
integrations, **(2)** no "integration" concept in the data model (no single row that
says *connected / error / last sync*), **(3)** setup knowledge lives in operators'
heads, not in wizards.

---

## Architecture

### 1. Integrations registry (the spine)

One table both the tenant settings hub and the saas-admin support dashboard read:

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
  capsSection: 'eleme' }
```

Secrets never live in this table — they go through `lib/tenant-creds.js`. This table
holds only status, mappings, and step progress.

**Per-step state machine** (shared with the wizard UI):
`pending → in_progress → waiting_external → failed(error) → done`, plus `done_by:
'tenant' | 'support'` so "✅ Completed by Full Circle support" renders honestly.

### 2. tenant-creds generalization (prerequisite fix)

`lib/tenant-creds.js` currently defines `MEITUAN_TIANHE_USER` / `MEITUAN_YUEXIU_PASS`
— Roots' store codes baked into the platform key namespace. Replace with **dynamic
per-store keys**: `meituan.<store_code>.user|pass` validated against the tenant's
`retail_stores.code` instead of the fixed `KEYS` whitelist. Add key families:

- `eleme.access_token` / `eleme.refresh_token` / `eleme.token_expires` (move out of the
  global `eleme_tokens` table, or scope that table by tenant — decide in build)
- `qingyun.user` / `qingyun.pass` (+ per-store variants if Qingyun accounts are per-POI)
- `eleme.app_key` / `eleme.app_secret` stay **platform-level** env (it's OUR open-platform
  app; tenants authorize into it) — document this asymmetry in the module header.

Roots keeps its env carve-out exactly as today (zero behaviour change).

### 3. Shared session manager for scraper-based integrations

Meituan and Qingyun are both "logged-in browser session" integrations. Build the
machinery **once** (`lib/integration-session.js`):

- Per-tenant (or per-tenant-store) persistent Playwright profiles/storage-state,
  keyed `data/sessions/<tenant>/<kind>[-<store>]`
- **Interactive login relay**: server-side Playwright drives the login; the tenant
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
  tenant's own egress (below).

### 3b. Scraper workers + per-tenant egress (phases 6–7 prerequisite)

Two separate risks, two separate mechanisms — neither means tenant-run servers
(a shop owner who needs a help button for an SMS code cannot operate a server;
tenant-run daemons would kill Model A and put credentials on unpatched machines):

**Compute — dedicated worker hosts.** Chromium is heavy (~150–300 MB RAM per live
logged-in context + CPU spikes); the main Node/SQLite box must never run it. The
scraper daemons (meituan / shangou / qingyun) move to cheap platform-operated
worker VPSes, ~10–20 tenants per worker, scaled horizontally. The daemons already
talk through queue tables (`meituan_sync_queue`, `qingyun_sync_log`, …), so the
split is "run the daemon loop on another box + a small authenticated internal API
back to the platform," not a rewrite. Roots' two stores become tenant #1's entries
on worker #1.

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
2. **GZ proxy server with per-tenant static IPs (fallback only).** Datacenter IPs
   are more detectable and only geo-match GZ merchants; used automatically when a
   tenant's box goes offline — sync limps instead of dying, card shows the warning.
3. **Commercial residential-proxy services: rejected.** Legally murky in China,
   often botnet-sourced — unacceptable while holding merchants' credentials.

Egress health feeds `health_json` with explicit states:
`box_online | box_offline_fallback | session_expired`, each with its own card
badge + re-auth / "check the box" guidance. Per-tenant fingerprint stays
consistent (UA, timezone, viewport) across restores.

### 4. Assisted self-service (help + take-over)

- **"Get help" button on every wizard step.** Creates a row in a new
  `integration_help_requests` table: tenant, kind, step_key, last error, attempt
  count, free-text note. Notifies platform ops (reuse the existing wecom/web-push
  plumbing).
- **Take-over mode in saas-admin**: a platform operator opens the tenant's *same*
  wizard, acting on their behalf. Needs an "operator acting as tenant" session
  concept + audit trail (`done_by: 'support'`, who/when). This is why Model A first
  is cheap: the customer wizard IS the internal tool — no parallel tooling.
- **Stuck-tenant dashboard** in saas-admin: all tenants × integrations × current
  step + days-stuck, so silent abandonment is visible before the customer gives up.

### 5. Settings hub UI — "Channels & Delivery"

New retail-admin section (new load-ordered file, e.g. `public/retail-admin/15-integrations.js`):
a card grid — Mini App, Eleme, Meituan, JD, Qingyun — each card shows status badge,
health line (last sync / error), and one primary action: **Set up** / **Fix** /
**Manage**. Clicking opens that plugin's step-wise wizard. Bilingual EN/CN like the
rest of the admin.

Capabilities additions (`lib/capabilities.js`, group `setup`):
`integrations:view`, `integrations:manage`, plus the missing `eleme:view/map/sync`
section (UI file `14-eleme.js` exists with no caps today). Extend the `channel`
preset accordingly.

---

## Per-plugin plans

### Locations (closest to done — do first)

`retail_stores` is already data-driven with routing, per-store stock, and channel
quotas. Missing is the guided flow:

1. **"Add location" wizard**: name EN/CN → address via existing
   `lib/geocode.js` + `china_districts.json` district picker (lat/lng auto) →
   pickup on/off → hours → initial delivery zones (reuse `retail_delivery_zones` UI).
2. **Channel-linking prompts**: on save, every *connected* channel integration gets
   a to-do on its card — "New location Yuexiu-2: link Meituan POI / Eleme shop /
   set channel quotas." Descriptor hook: `onStoreAdded(tenant, store)`.
3. Seed `channel_status` rows and default `retail_store_stock` quotas for the new store.

### Eleme (reference plugin — build second, sets the pattern)

The only channel with a real OAuth API; the flow is genuinely 100 % self-service:

1. Card → **Connect Eleme** → redirect to `authorizeUrl(state)` (exists,
   `lib/eleme-client.js:62`) → merchant logs into ele.me and approves → callback
   exchanges code (`exchangeCode`, exists) → tokens stored **per tenant**.
2. Wizard step 2: pull the merchant's shop list → map each Eleme shop to a
   `retail_stores` row (persist in `config_json` / `eleme_shops` scoped by tenant).
3. Step 3: product mapping into `eleme_product_map` (reuse the `14-eleme.js` mapping
   UI inside the wizard).
4. Step 4: enable sync → daemon picks up the tenant; card turns **connected**;
   token auto-refresh (`refreshToken`, exists) feeds `health_json`.
5. Finish the half-wiring: real `channel_status` participation (drop the
   "placeholder" path) + the missing capabilities section.

### JD logistics (finish the scaffold, then it's a form)

1. **Unblock `createWaybill`** — confirm the merchant endpoint against a real JOS
   app, remove the guard (a Roots task, but it gates the plugin).
2. Wizard: collect `jd.app_key/app_secret/customer_code` (+ optional JDL cloud-print
   keys — the namespace already exists in tenant-creds) → **live test call** (signed
   no-op / address query) → green on success, mapped error message on failure.
3. Other carriers (SF/ZTO/YTO/…) stay tracking-only via kd100 — no setup beyond
   picking a carrier on the order; kd100 keys get a simple credential form later.

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
   enable stock push + order mirroring. Shangou rides along as a toggle inside the
   same card (same session family, `lib/shangou-browser.js`).
5. If login relay fails twice → prominent **"We can connect Meituan for you"**
   handoff → help request with full context; support finishes via take-over.
   That's the plan working, not failing.
6. Multi-tenant daemon: `scripts/meituan-daemon.js` loops tenants × stores with
   per-tenant sessions on the worker fleet instead of the fixed two on the main box.

### Qingyun (rider tracking)

Same shape as Meituan — reuses the session manager, worker fleet, per-tenant
egress (same store box/tunnel — one box serves all of that tenant's scraper
sessions), and login relay wholesale. Wizard: credentials → session → map stores →
daemon adopts tenant → `delivery_jobs` rows become tenant-scoped. Build only after
Meituan proves the session machinery.

### Mini app (WeChat) — make the existing checklist interactive

`lib/onboarding-steps.js` + `tenant_onboarding` already model the A-to-Z. Upgrade,
don't replace:

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

1. **Foundation** — `tenant_integrations` table + registry + per-step state machine;
   tenant-creds Meituan key generalization; caps (`integrations:*`, `eleme:*`);
   Channels & Delivery card hub (cards render from registry, even if every action
   is still "coming soon").
2. **Locations wizard** + channel-linking prompts (smallest real wizard, no external
   dependency, immediately useful to Roots itself).
3. **Eleme self-service connect** end-to-end (reference plugin; also finishes
   Eleme's channel_status + caps wiring).
4. **Help + take-over** — help requests, saas-admin stuck-tenant dashboard,
   operator-acting-as-tenant with audit trail. (Deliberately after one real wizard
   exists to take over.)
5. **JD** — unblock waybill, credential form + live test.
6. **Scraper workers + egress layer, then Meituan** — worker-host split (daemons
   off the main server), store-box provisioning + reverse tunnel + per-context
   proxy routing + GZ fallback, THEN login relay, per-tenant sessions,
   multi-tenant daemon, POI/product mapping, Shangou toggle. Prototype the box
   tunnel + login relay first — they are the two hard unknowns.
7. **Qingyun** — reuse workers, egress, and session manager.
8. **Mini app checklist interactive** — credential forms + live verification +
   waiting_external states, surfaced as a hub card.

## Risks / notes

- **Meituan/Qingyun ToS + account safety**: scraping merchant portals on customers'
  behalf risks captchas, device checks, account flags. Mitigate: per-tenant egress
  IPs (store box §3b — the merchant appears to log in from their own shop),
  per-tenant isolated browser profiles + consistent fingerprints, human-paced
  automation, and the assisted fallback as the documented degraded mode.
  (Decision to accept this risk: made.)
- **The two hard unknowns are the login relay and the box tunnel** — SMS/captcha
  round-trips through a web UI with a headless browser holding state, and reliable
  reverse tunnels over NATed store broadband. Prototype both early in phase 6;
  nothing else depends on them before then.
- **Store-box operational load**: hardware shipping/provisioning, boxes unplugged
  by staff, store ISP changes. Mitigate: auto-fallback to the GZ proxy + explicit
  `box_offline_fallback` health state + "check the box" guidance on the card; keep
  a provisioning image so replacement = swap and plug in.
- **Daemons are single-tenant today** (meituan/eleme/qingyun) and run on the main
  server: each needs a tenant-loop refactor AND the move to worker hosts; keep
  Roots on its env carve-out (and migrate Roots to a worker last) to guarantee
  zero behaviour change during rollout.
- **`eleme_tokens` / `delivery_jobs` / `meituan_*` tables** need tenant scoping
  review before phase 3/6/7 — some predate multi-tenancy.
- **Commits deploy to production** (post-commit hook) — every phase must be dark
  behind the registry (`status: not_configured` renders nothing risky) and behind
  plan gating via `lib/features.js` where appropriate.
