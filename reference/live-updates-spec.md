# Live Updates — Platform Standard

Status: proposed · Owner: platform · Last updated: 2026-07-16

How a backend state change reaches every open client automatically, without a
refresh. This is the one recipe every feature follows. It is **not** a list of
features to build — it defines the mechanism, then features opt in one write at
a time.

---

## 1. Problem this fixes

A mutation on one client is invisible to other open clients until they reload.
The reported case: change the display name on mobile, and a desktop session
already open still shows the old name until refresh.

Root causes found in the current code:

1. The save emits no event. `PUT /api/backend/profile`
   (`routes/backend-auth.js:519`) writes `display_name` and returns nothing live.
2. The live channel doesn't watch identity. The retail-admin stream's 5s
   change-detector (`_dashActivitySignature`, `routes/retail.js:12313`) only
   looks at orders / customers / stock. A `tenant_users` write is invisible.
3. The "live-sync" that shipped is single-browser only: `window.parent.postMessage`
   from `public/backend-account.html:1010` to `public/retail-admin/02-settings-ops.js:1781`.
   It crosses iframes in one tab; it can never reach another device.

The name field is one symptom. The standard below removes the class of bug.

---

## 2. What already exists (build on this, don't replace it)

The platform already has the primitive. This work standardizes it, it is not
greenfield.

- **Retail-admin SSE** — `GET /api/retail-admin/stream` (`routes/retail.js:12358`),
  per-tenant, auth-scoped via `requireRetailAdmin`. Nudge model: tells the client
  "something changed, refetch." Client: one shared `EventSource` in
  `public/retail-admin/01-core.js:1444` with a subscribe/fan-out registry
  (`retailLiveSubscribe`, `:1435`).
- **Kitchen SSE** — `GET /api/events` (`routes/events.js:30`) with
  `broadcast(kind, payload, target)`, filtered by user / role / permission.
  Payload model: sends the data inline. Client: `public/app.html:3500`.
- **Web Push / VAPID** — `routes/push.js`, real OS notifications for a closed app.
- **Polling backstops** — visibility-scoped `setInterval` refetch loops in most
  pages, plus `miniapp/utils/livepoll.js`.

Two SSE models drifted apart (nudge vs payload). The job is to pick one contract
and make every mutation feed it.

---

## 3. Decisions

### 3.1 Transport → SSE. No WebSockets.

SSE is already chosen, deployed, and proxy-aware (both streams set
`X-Accel-Buffering: no` and 25s keepalives to survive the nginx idle timeout).
It is one-directional, which is the exact shape of "server tells clients state
changed" — client writes still go over normal REST. WebSockets would need an
`Upgrade` block added to the server-side nginx config, which is not even in this
repo. Keep visibility-scoped polling as the automatic fallback when `EventSource`
fails or is unsupported.

### 3.2 Event contract → typed nudge, not payload push.

Standardize on the **nudge** model (retail), not payload push (kitchen). The
client refetches through its existing authenticated, tenant-scoped endpoint.
Consequences:

- Cannot leak over-scoped or stale data to the wrong client — the refetch runs
  under the client's own auth.
- No second serialization path to keep in sync with the REST reader.
- Invalidation is trivial and always correct.

Reserve inline-payload push for genuinely latency-critical, non-sensitive cases
only (e.g. a live order-count tick), and mark them explicitly.

Nudge shape:

```
event: live
data: { "entity": "identity", "action": "update", "scope": { "userId": 42 }, "ids": [42], "ts": 1721145600000 }
```

- `entity` — registry key (see §5). Required.
- `action` — `create` | `update` | `delete`. Advisory; the client decides.
- `scope` — narrows who cares: `{ userId }`, `{ storeId }`, or omitted = whole tenant.
- `ids` — optional; lets a client skip a refetch if it isn't showing those rows.
- `ts` — server timestamp, for ordering / de-dupe.

No sensitive data ever rides in `data`. If a client needs the new value, it
refetches.

### 3.3 Invalidation → emit at the write seam, keyed by (tenant, entity).

One server helper, called immediately after a committed mutation:

```
liveBump(entity, { tenantId, scope, ids, action })
```

It does two things:
1. Fan the nudge out to that tenant's SSE subscribers.
2. Bust the matching server memo cache (`dashMemoBust` already exists,
   `routes/retail.js:11008`).

The 5s watermark tick (`_dashActivitySignature`) stays as a **safety net** for
writes from separate daemon processes (Meituan / Guanyi sync), so cross-process
changes still trigger a refetch even though they never call `liveBump`. But the
primary path is emit-at-write, so it works for any entity without widening a
signature query each time a new entity is added.

---

## 4. Auth & tenant scoping

- A socket only ever receives nudges for its own tenant. Reuse the existing
  `requireRetailAdmin` session → tenant resolution (`routes/retail.js:86`,
  session key `backendUserId` → `tenant_users` → `tenants`). This is already how
  the retail stream scopes.
- Kitchen (`users`) and tenant-operator (`tenant_users`) are separate auth
  realms with identity in different tables. Keep the two SSE endpoints separate,
  but give them the **same event contract and the same client helper**. Do not
  merge the realms.
- `scope.userId` filtering happens server-side before fan-out, matching the
  existing `broadcast(kind, payload, target)` filter in `routes/events.js:69`.

---

## 5. Entity registry

One list, the source of truth for `entity` values. Each entry: key, which tables
back it, which client renders it, default scope.

| entity     | backing write                              | rendered by                                   | scope   |
|------------|--------------------------------------------|-----------------------------------------------|---------|
| `identity` | `tenant_users` / `users` (name, avatar)    | topbar `#acctName`, dashboard `#td-greeting`, kitchen `#userName`, cms `#who` | userId  |
| `orders`   | `retail_orders`                            | orders list, dashboard                        | tenant  |
| `stock`    | `retail_stock_ledger`                      | products, dashboard                           | tenant  |
| `settings` | tenant settings tables                     | settings pages, feature toggles               | tenant  |
| `customers`| `retail_customers`                         | customers list, dashboard                     | tenant  |

Extend this table as entities are wired. Adding an entity = one row here + one
`liveBump` call at its write seam + (usually) reusing an existing client
subscription.

---

## 6. Client helper

One shared helper per realm, wrapping the existing `EventSource`:

- Retail: extend `retailLiveSubscribe` (`public/retail-admin/01-core.js:1435`)
  to route by `entity`. A feature calls
  `liveSubscribe('identity', ids => refetchAndRender())`.
- Kitchen (`app.html`): add the same helper over its existing
  `EventSource('/api/events')` (`public/app.html:3500`), and bring its profile
  editor onto the `identity` bus — today it uses a separate `PUT /api/auth/profile`
  and updates `#userName` locally only (`app.html:25842`).
- CMS (`cms.html`): add the shared client; subscribe `identity` for `#who`.
- Optional optimization: use `BroadcastChannel` so multiple tabs of the same
  browser share one SSE connection and one refetch, instead of each opening its
  own stream.

The existing in-browser `postMessage` echo (`backend-account.html:1010`) can stay
as an instant optimistic update for the editing tab; it becomes redundant for
correctness once the SSE nudge lands, but it makes the editing tab feel instant.

---

## 7. Web Push boundary (do not conflate)

Web Push / VAPID (`routes/push.js`) is for **notifications to a closed or
backgrounded app** (new-order alert, buzzer). It is not the in-app state-sync
channel. In-app sync is SSE. Different lifetimes, different cost. Keep them
separate.

---

## 8. Phased delivery

Design once (this doc). Wire per-action, incrementally.

- **Phase 0 — profile name + avatar** (fixes the reported bug, proves the standard).
  - Add `liveBump('identity', …)` to `PUT /api/backend/profile`
    (`routes/backend-auth.js:519`), `PUT /api/backend/avatar`, and kitchen
    `PUT /api/auth/profile` (`routes/auth.js:133`).
  - Point the existing `ACCT_USER` → `acctRenderMeta()` + `tdGreetRender()` sink
    at the SSE nudge, not only the postMessage bus.
  - Bring `app.html` onto the `identity` bus.
- **Phase 1 — converge existing live surfaces** (orders, stock, settings) onto the
  typed-nudge contract; keep the watermark as backstop.
- **Phase 2 — long tail**: catalogue remaining user-visible entities; each
  mutation calls `liveBump`. One row in §5 + one call each.

---

## 9. Acceptance test (Phase 0)

1. Two devices signed into the same tenant, both on the dashboard.
2. Change the display name on device A.
3. Device B updates the greeting and topbar name within a few seconds, no reload.
4. Kill the SSE connection (offline device B): the name still updates on the next
   poll/visibility change — backstop intact.
5. A second tenant's session sees nothing.
