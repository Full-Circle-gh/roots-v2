## §NEW — PUTTING A DELETED RECORD BACK, AND THE MAPS BACKFILL, NEED A PERMISSION

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Two writes matched no rule in `lib/cap-routes.js`, so any signed-in operator
could make them, enforcement on or not. Both are now gated by §325.3: the keys
that open every screen calling them today. As with every gate in that file,
nothing changes for the owner, for a shop with enforcement off, or while an
operator's permissions cannot be resolved.

1. **Put a deleted record back** (`POST /deleted/:id/restore`) needs the key
   that edits that kind of record. These are the keys the phone draws "Put it
   back" on:

   | Kind | Key needed |
   |---|---|
   | delivery zone | `delivery:edit` |
   | ledger row (money in or out) | `finance:record` |
   | coupon | `coupons:edit` or `coupons:delete` |
   | draft purchase order | `purchasing:edit` |

   The path does not say which kind a copy is, so the choke point admits anyone
   holding any of these keys. `routes/recycle.js` then reads the stored copy and
   asks `restoreKindCap(kind)` (new) before anything is written. A refusal comes
   back as `403 {error:'forbidden_capability', need}`. A copy that does not exist
   still gets a 404.
2. **No desktop operator loses anything.** The desktop's Recently deleted list
   draws its button for `settings:edit`. That key does not exist, so the button
   is drawn for nobody who holds a real permission set.
3. **A new kind must be given a key.** The suite fails if `lib/recycle.js` gains a
   kind this table does not name. Until it is named, an unlisted kind takes the
   union of the keys above.
4. **Geocode every store and address now** (`POST /inventory/geocode-backfill`)
   uses up the maps quota. It needs one of the Settings tab's keys: `settings:shop`,
   `settings:push`, `settings:payments`, `stores:view`, `shipping:config` or
   `delivery:view`. Its only button is in desktop Settings → Operations, which has
   no gate of its own. The phone's Operations screen only reads the counts.
5. **The sweep: writes that still match no rule. Listed, not gated, for the
   coordinator to decide.** Every `router.(post|put|patch|delete)` under
   `/api/retail-admin` in `routes/*.js` was checked against `requiredCapFor`. The
   sweep found 40 with no rule. Two of those are false positives from the sweep's
   placeholder ids (the channel-sync push and sync routes, which are gated as
   `{channel}:sync` and `{channel}:map`). That leaves 38. Line numbers are as of
   this commit.
   - **Already gated another way:**
     - `PUT /config` (`routes/retail.js:23343`) is checked in its handler, key by
       key (S2a).
     - `POST /channel-signin/start|finish` (`routes/channel-signin.js:33, 89`)
       checks `integrations:signin` itself (`lib/channel-signin.js`).
     - The `/shops` writes check `stores:edit` (or `till:use` for sold-out) in
       their own handler (`routes/retail-shops.js:54`):
       - `POST /shops` (`retail-shops.js:186`)
       - `PATCH /shops/:id` (`:214`)
       - `POST /shops/:id/move` (`:256`)
       - `POST /shops/:id/listings` (`:405`)
       - `POST /shops/:id/listings/add-published` (`:459`)
       - `PATCH /shops/:id/listings/:lid` (`:486`)
       - `POST /shops/:id/listings/reorder` (`:564`)
       - `DELETE /shops/:id/listings/:lid` (`:576`)
   - **Open, in `routes/meituan-admin.js`:** opening and closing stores and
     channels.
     - `POST /store-status/online` (`:978`)
     - `POST /store-status/master` (`:999`)
     - `POST /store-status/store/:code` (`:1039`)
     - `POST /channel-status/cell` (`:1207`)
     - `POST /channel-status/channel` (`:1230`)
     - `POST /channel-status/location` (`:1251`)
   - **Open, settings and connections in `routes/retail.js`:**
     - `PUT /alipay-manual` (`:23587`): a payment QR code and an API key.
     - `PUT /fapiao-settings` (`:28749`)
     - `PUT /integrations` (`:31828`): credentials.
     - `PUT /printer` (`:32394`)
     - `POST /integrations/qingyun/autopush` (`:30483`)
     - `POST /integrations/qingyun/request` (`:31778`)
   - **Open, tests and probes that send something out but store nothing:**
     - `POST /system-alerts/test` (`retail.js:23542`)
     - `POST /wecom/test` (`:31804`)
     - `POST /integrations/jd/test` (`:31910`)
     - `POST /integrations/nuonuo/test` (`:31930`)
     - `POST /integrations/aliyun_sms/test` (`:31940`)
     - `POST /printer/test` (`:32534`)
     - `POST /integrations/kd100/test` (`:32608`)
     - `POST /poi-search` (`:10032`)
     - `POST /geocode` (`retail-inventory.js:231`)
   - **Open, other:**
     - `POST /setup` (`routes/retail-setup.js:156`): the setup guide's own flags.
     - `POST /page-templates` and `DELETE /page-templates/:id`
       (`routes/retail-page-templates.js:56, 108`).
     - `POST /views`, `PATCH /views/:id` and `DELETE /views/:id`
       (`routes/saved-views.js:103, 140, 166`): an operator's own saved filters.
6. **Tests.** `scripts/test_restore_geocode_gates.js` (fast shard, 38 checks)
   runs the real `routes/recycle.js` and `routes/retail-inventory.js` over a
   scratch database with enforcement on. It checks:
   - the rules, including that every kind `lib/recycle.js` keeps has a key;
   - a real delivery zone, deleted and captured: refused to a finance account
     with nothing written, and put back under its own id by `delivery:edit`;
   - each other kind, with the wrong key and the right key;
   - the owner, and a missing copy (404);
   - the backfill, with the wrong key and two Settings keys;
   - the callers, including that `settings:edit` is not a real key.
7. **Nothing composed.** No operator strings were added.
