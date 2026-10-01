## §NEW — THE ELEME PANEL'S OWN WRITE NEVER LEAVES A NAMELESS MAPPING SWITCHED ON

**Built 2026-10-01 under §325** (the second gap S2j recorded).
S2j made `setSync` refuse to switch on an Eleme mapping that has no listing name.
The Eleme panel's own write, `POST /api/retail-admin/eleme/products/:id/map`
(`routes/eleme-admin.js`), still allowed it in two ways:
- It accepted `syncEnabled: 1` with no name.
- When `syncEnabled` was not sent, it defaulted the mapping to ON, even for a
  new mapping with no name. That default is how the switch created nameless
  mappings (`docs/eleme-findings.md`, finding 8).

A nameless mapping that is ON pushes stock to whatever listing the product's own
Chinese name happens to match, or to none (finding 6).

1. **The rule now, after the stored name and the incoming one are merged and
   trimmed:**

   | Name | `syncEnabled` | Result |
   |---|---|---|
   | none | truthy | refused: `409 {error:'no_listing_name', stores:[storeCode]}`, the same code as S2j, nothing written |
   | none | not sent | stored OFF |
   | none | 0 | stored OFF, as asked |
   | present | not sent | ON, unchanged from today |
   | present | sent | as sent, unchanged from today |

   A name of only spaces counts as no name. Clearing the name while sending
   `syncEnabled: 1` is refused, and the mapping stays exactly as it was. Clearing
   it without sending `syncEnabled` turns the mapping OFF along with it.
2. **Every caller that creates or changes a mapping.** I checked each one; none
   relies on a nameless mapping being ON.
   - **Desktop panel switch (`elToggleSync`)** refuses to send ON when there is
     no name, before it writes anything (finding 8's fix). It always sends
     `syncEnabled` along with the stored name.
   - **Desktop name field (`elSetElemeName`)** is reached only through a check
     that lets through a name already in the catalogue and nothing else (empty
     reverts). It sends back the mapping's current switch setting, or 0 for a new
     mapping. Since a name always comes with it, the new rule never applies here.
   - **Desktop Remove** sends `remove: true`, which deletes the mapping rather
     than blanking it.
   - **Claim route (`/eleme/products/:id/claim`)** refuses when there is no listing
     name.
   - **Auto-match (`scripts/eleme-match-products.js --apply`) and the reviewed
     list (`scripts/eleme-apply-reviewed-matches.js --apply`)** write directly to
     the table. They turn mappings ON only with a matched catalogue name, so they
     are unaffected.
   - **The daemon** updates only push results (`last_pushed_qty`, `item_id`).
   - **The product spreadsheet import** writes no Eleme mapping.
   - **The phone** calls `/map` nowhere at this merge (X8b/X8c were not in main).
     When they arrive, a refusal comes back with the same `no_listing_name` code,
     which S2j already turned into the Eleme panel's own sentence in
     `csErrText`.
   - **What the desktop shows if refused.** If the server ever refuses the
     desktop's switch (only possible from a stale screen, since the screen blocks
     it first), the switch's catch reloads the list and the switch springs back.
     The on-screen block shows the words.
3. **Tests.** `scripts/test_eleme_map_nameless.js` (fast shard, 20 checks):
   - **Real route, scratch database:** every row of the table above, including
     that a refused request creates no mapping and leaves an existing one
     unchanged.
   - **Caller list, read from source:** the desktop switch's guard, the name
     field's catalogue check, Remove's delete, the claim refusal, the two match
     scripts' named-only writes, that the desktop panel is the only screen
     calling `/map`, and that no library writes a mapping's name or switch behind
     the route.
4. **Nothing composed.** No operator strings were added.
