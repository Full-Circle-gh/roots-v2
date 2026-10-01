## §NEW — MATCHING AND CLAIMS ON THE PHONE: ONE PRODUCT ON ONE CHANNEL

**Built 2026-10-01 under §325.** This is step X8c, the third part of X8,
on the Settings / Channels / Dashboard / Billing lane. Until now, a Channel
sync card whose fix needed product matching said "Fix this on the desktop".
These are the reasons with no listing name, a name the listing does not
carry, or no option picked. Such a card now has the desktop's **Open
Meituan / Open Eleme** button. It opens that channel's product panel on this
product, which is what the desktop's `csFix` does. Without a matching key
the sentence stays.

1. **Meituan** (`11-meituan.js` `mtPanelStore`).
   - **The delivery store** (the desktop's own guess: code `tianhe` or a
     name containing 天河, else the first store):
     - the listing name, picked by searching the names read from Meituan
       and tapping one;
     - nothing typed is ever sent; the server refuses anything else too
       (`lib/meituan-map-write.js`);
     - **Remove**, which asks first with the name;
     - on a listing several products share, which options this product is
       and how many units each sells;
     - an add-on listing says where the count goes, with nothing to pick.
   - **The 闪购 store** is read-only. It links by 货号, and says so when no
     listing carries the SKU.
   - **Writes:** `POST /meituan/products/:id/map {storeId, storeCode,
     meituanName, syncEnabled, source}` and `POST …/claim {storeId,
     storeCode, specSkuId, specLabel, units, on}`.
2. **Eleme** (`14-eleme.js` `elPanelStore`).
   - **Each linked store:** the listing name from that store's catalogue,
     **Remove**, and the options with units.
   - **Remove deletes the mapping.** It asks first, in the desktop's words,
     which tell the difference from switching sync off.
   - **A store with no Eleme shop linked** says why nothing can be matched.
     It still offers Remove for a leftover mapping, as the desktop does.
   - **Writes:** `POST /eleme/products/:id/map {storeId, storeCode,
     elemeName, syncEnabled}` or `{…, remove:true}`, and `POST …/claim
     {storeId, storeCode, elemeName, specId, specName, units, on}`.
3. **GZ Grocery** (`12-guanyi.js`).
   - **Bind** to the listing the SKU suggests, with sync on, as the desktop
     does: `{skuId, syncEnabled:true}`.
   - **Unbind** (`{skuId:''}`).
   - With no suggestion, it says where to refresh the list.
4. **Naming never moves the sync switch.** Meituan keeps the stored switch
   (the desktop's `mtKeepSync`). Eleme passes the stored value through, so a
   new mapping starts off. Naming and switching sync on stay two separate acts.
5. **Who sees each control.** Each is drawn for the key the server asks of
   its path (`lib/cap-routes.js`):
   - `{channel}:map` for the name, Remove and the GZ Grocery binding;
   - `{channel}:sync` for the option claims.
   - The screen opens for any of the five keys.
   - Every write reads the product again, because claiming an option
     releases it from whichever product held it before. A refusal is said
     where it happened.
6. **Not built here; candidates for a later step.**
   - Meituan's **Match names** guided flow: read the catalogue, apply every
     confident match, then review the ambiguous and unmatched ones.
   - **Paste names**, and **Clear all**.
   - Linking an Eleme store to its shop id (`elSetShop`).
   - The panels' own sync switches are not repeated here; the Channel sync
     switch (X8b) is the phone's.

**Open for Ash (SERVER).** The Channel sync switch, on the desktop page and
now the phone, writes through `lib/channel-sync-write.js` `setSync`. That
code does not refuse a nameless Eleme mapping. The Eleme panel refuses to
switch a nameless mapping on, because the daemon then pushes at the
product's own Chinese name (`docs/eleme-findings.md` finding 6). Closing
this server-side would cover both screens.
