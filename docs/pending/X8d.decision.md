## §NEW — MEITUAN BUNDLES ON THE PHONE

**Built 2026-10-01 under §325.** This is step X8d on the Settings / Channels
/ Dashboard / Billing lane. The desktop Meituan page's Bundles tab is on the
phone (`11-meituan.js` `mtRenderBundles` … `mtDeleteBundle`). It is reached
from **Bundles** on the Meituan screen's upkeep card.

1. **The list**, as the desktop draws it:
   - title, store and components;
   - available now, the cap, whether sync is off, and the last push.
2. **Add and Edit** send `POST /meituan/bundles {id, storeId, storeCode,
   meituanName, maxQty, syncEnabled, components:[{productId, qty}]}`, the
   desktop's body key for key.
   - **The switch is carried through unchanged**, as the desktop now does.
     Fixing a component never switches a paused bundle back on.
   - **A blank cap is sent as null.**
   - **The title** is picked from the names read from Meituan for the chosen
     store, or is the title the bundle already holds. That is the desktop's
     `mtBundleNameCommit` rule, and the server's: it refuses anything else.
   - **The line under the title** says what it holds: pick from the list,
     matches a listing, a stored title that matches nothing, or nothing read
     to check against.
   - **Components** can be any product, paused ones included (the desktop
     reads products with `includeInactive`), each added once with a quantity.
   - **A refused title** is said under the field with the server's own
     sentence, and the screen stays open.
3. **Delete** asks the desktop's question, then sends
   `DELETE /meituan/bundles/:id`.
4. **Suggest bundles** finds the combo-looking titles read from Meituan that
   are not a bundle yet: 套餐 / Combo, or a + / & joiner (the desktop's
   `mtComboCandidates`). Each one opens Add with its title.
5. **Who can use it.** Every bundle write is `meituan:sync` on the server,
   so Add, Edit, Delete and Suggest are drawn for it and the editor's route
   needs it. The list itself reads for `meituan:view` or `meituan:sync`.
