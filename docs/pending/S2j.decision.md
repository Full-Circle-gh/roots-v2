## §NEW — THE SERVER REFUSES TO SWITCH ON AN ELEME MAPPING THAT NAMES NO LISTING

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Eleme matches a stock push by the listing's name and nothing else. When a
mapping has no listing name, the Eleme daemon (`scripts/eleme-daemon.js`) fills
the gap with the product's own Chinese name. So a nameless mapping that is
switched on writes stock to whatever listing that name happens to match, or to
none (`docs/eleme-findings.md`, finding 6; finding 9 explains why a match is the
usual outcome). The Eleme panel refused this on screen only. The Channel sync
page, and the phone's sync switch (X8b), both go through
`lib/channel-sync-write.js` `setSync`, which switched it on.

1. **The refusal.** `setSync` now refuses to switch on an Eleme mapping whose
   listing name is empty or only spaces, before it writes anything.
   - **Response.** It answers `no_listing_name` and lists the stores whose
     mapping has no name. The route returns this as
     `409 {error:'no_listing_name', stores}`.
   - **All or nothing.** If any targeted store's mapping is nameless, no store
     is switched on. A store whose mapping does name a listing can still be
     switched on by itself.
   - **Switching off** is always allowed.
   - **Meituan and GZ Grocery** are unchanged.
2. **Both screens show it, in the Eleme panel's own words**, copied whole and
   not composed: *"Sync cannot be switched on until this mapping names an Eleme
   listing." · 未选择饿了么商品名前无法开启同步。*
   - **Desktop.** The code is added to `TD_ERR`. `api()` already throws the
     sentence for a refused write, and the Channel sync page already shows a
     write's error on that product's row.
   - **Phone.** It is added to `csErrText`, the phone's channel-sync refusal
     sentences. Before this, the phone would have said the generic "That did
     not go through… try again", which was wrong, because trying again cannot
     help.
   - **When X8b lands.** The phone's switch was not in main at this merge. If it
     shows its refusals through `csErrText`, as the Sync now button does, it
     gets this sentence with no further change.
3. **Not done here, and worth a decision.** The Eleme panel's own write,
   `POST /eleme/products/:id/map` (`routes/eleme-admin.js`), still accepts
   `syncEnabled: 1` with no name on the server. Worse, a new mapping created
   without `syncEnabled` defaults to on. The panel blocks this on screen (the
   finding 8 fix), but the server does not.
   - **Recommendation:** refuse in that route too, with the same code.
   - **Before doing so,** check every caller that creates mappings without a
     name, such as auto-match and import paths.
   - **Not done here,** because it changes a second write path and its default.
4. **Tests.** `scripts/test_channel_sync_listing_name.js` (fast shard, 17 checks).
   - **`setSync` on an in-memory table:** finding 6's product refused with the
     store named and nothing switched; the named store switched on alone; a name
     made only of spaces is no name; switching off is always allowed; once both
     stores are named, both switch on; `not_mapped` and Meituan are unchanged.
   - **The real route over a scratch database:** 409 with the code and the
     stores, and the mapping stays off.
   - **The desktop text:** the `TD_ERR` entry, how `api()` throws it, and the
     Channel sync row note.
   - **The phone text:** `csErrText`, sliced out of `m.html` and run.
5. **Nothing composed.** The one sentence is a live pair, copied whole.
