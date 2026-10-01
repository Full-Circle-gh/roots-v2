## §NEW — CHANNEL UPKEEP ON THE PHONE: SYNC NOW, THE CATALOGUE, AUTO-MATCH, SYNC FROM

**Built 2026-10-01 under §325.** This is step X8a, the first part of X8
(channel upkeep), on the Settings / Channels / Dashboard / Billing lane. The
channel tabs' maintenance buttons are on the phone's three channel screens
now. Each sends the desktop's own request.

1. **Meituan** (`11-meituan.js`).
   - **Sync now:** `POST /meituan/push-all {force:false}`. The phone has no
     emergency "push while closed", just as the desktop has no button for it.
   - **The catalogue line:** each store's count of listing names, and how
     old they are.
   - **Refresh catalogue:** `POST /meituan/listings/refresh`, then
     `GET /meituan/listings` every 3 s, for at most 3 minutes, until no job
     is running. It applies nothing. That is the whole difference from Match
     names, which comes with matching (X8c).
2. **Eleme** (`14-eleme.js`). **Push all stock:** `POST /eleme/push-all`.
3. **gzgrocery** (`12-guanyi.js`).
   - **The list line:** how many listings were read, and when.
   - **Refresh list:** `POST /guanyi/listings/refresh`, then a look every
     2 s, at most 30 times.
   - **Auto-match by SKU:** `POST /guanyi/auto-match`. It reports matched,
     ambiguous and unmatched. "Refresh first" is shown on the card, not as a
     toast.
   - **Push all stock:** `POST /guanyi/push-all`.
4. **Sync from, per store, on Meituan and Eleme.**
   - **What it sends:** `PATCH /stores/:id {sync_start_time}`, writing the
     store's own row as the desktop does.
   - **A blank box** says what it resolves to: "defaults to 08:00", or "no
     opening hours set — syncs all day". That is the daemon's own rule,
     including its clamp: a start later than opening reads as opening.
   - **Without `stores:edit`** the effective time is shown, not edited.
5. **Who can use each button.** Each is drawn only for the key the server
   asks of its request: `meituan:sync`, `eleme:sync`, `guanyi:sync`,
   `guanyi:map`, `stores:edit` (`lib/cap-routes.js`).
   - The desktop draws these buttons with no key at all. The phone was born
     closed, so it takes no access anyone had on the phone.
   - The screens themselves keep their existing gates.
6. **Two labels reuse words from elsewhere** instead of new Chinese. The
   gzgrocery push button is labelled with Eleme's `Push all stock · 推送全部库存`
   (the desktop's gzgrocery button is English-only, "Push all stock now").
   Its toast is Eleme's `Queued N product(s)` (the desktop's is "Queued N
   reconcile(s) to Guanyi"). Each queued reconcile is one product, so the words
   stay true.
7. **Next sub-steps.**
   - X8b: the channel-sync picker and search, and per-item sync on/off with
     §326.3's lasting-change confirm.
   - X8c: matching and claims (and Match names).
   - X8d: Meituan bundles.
   - X8e: gzgrocery analytics and export.
