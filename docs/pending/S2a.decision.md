## §NEW — THE WRITES NO PERMISSION GATED ARE GATED, EACH ON THE SCREENS THAT MAKE IT

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Step S2a, the parity survey's defect 3 (`docs/tacet-phone-parity-rest-of-app.md`).
Settings, polls, the voting and leaderboard settings, top-up packages, marking a
top-up paid, the affiliate settings and referrals, and the whole mini-app editor
(publish included) matched no rule in `lib/cap-routes.js`, so they fell through
open: any signed-in operator could make them, enforcement on or not. The
flash-sale keys gated nothing, because a flash sale is written through
`/products/:id/flash-sale`, which answered `products:edit`. Each is now gated by
§325.3: on the keys that open every desktop and phone screen making that write
today, as an any-of. What this closes is the account that can open none of those
screens. As with every gate in that file, nothing changes for the owner, for a
shop with enforcement off, or while an operator's permissions cannot be resolved.
No screen changed.

1. **Settings (`PUT /config`) are gated per key family, in the handler.** One
   any-of for the whole route would be wrong both ways: about twenty screens
   write it, each its own keys, each opened by a different permission. A union
   wide enough to keep all of them working would let a pop-up editor set the tax
   rate. So `configKeyCap(key)` (new, `lib/cap-routes.js`) names each family's
   screens, and the handler checks every key in the body before it writes
   anything. This is §302's pattern: the choke point sees only the path, so it
   passes this route through on purpose. One refused key refuses the whole body,
   as `403 {error:'forbidden_capability', need, key}`.
2. **The families, and who writes them today** (desktop = `01-core.js` `TAB_CAP` or
   a `data-cap`; phone = `m.html` `ROUTE_CAP`):
   - **Settings tab** — `shop.*`, `customer_service.*`, `currency`, `tax.*`,
     `system_alerts.*`, the order-template id and webhook under `notifications.*`,
     `inventory.*`, `product_page.*`, and `features.waste|production|lowStockHints`.
     The desktop's Shop, Push, Customer service and Operations panels carry no gate
     of their own, so this is `TAB_CAP.config`: `settings:shop`, `settings:push`,
     `settings:payments`, `stores:view`, `shipping:config`, `delivery:view`.
   - **Delivery panel** — `delivery.*`, `fees.*`, `pickup.*`, `batch.*`, `fresh.*`,
     `notice.*`. Gated on `delivery:view` and `delivery:edit`: the desktop panel's
     `data-cap` and the phone's Delivery (Resume delivery). Also `settings:shop` and
     `stores:view`, the phone's Setup pair, because the desktop setup guide writes
     currency, the pickup lead time and the delivery wizard's keys.
     `PUT /config/gz-excluded-districts` (the Guangzhou district chips on the same
     panel) takes `delivery:view` or `delivery:edit`, on the path.
   - **Automatic updates** — `notifications.categories.*`: `broadcasts:view` (the
     desktop's Broadcasts) and `broadcasts:send` (the phone's Automatic updates).
   - **Pop-ups** — `popups.list`: `popups:view|edit|delete`. Desktop and phone both
     open on `popups:view`.
   - **Content** — `copy.*` (Snippets), `legal.*`, `faq.*`, `about.*`:
     `content:view|edit`.
   - **Social proof** — `social_proof` and `checkout.*` (the upsell card sits on
     that tab): `social:edit`.
   - **Share cards** — `sharing.*`: `sharing:edit`.
   - **Membership** — `points.*` and `roots_club.*`: `loyalty:view|edit`.
   - **Reviews** — `reviews.*`: `reviews:view|moderate`.
   - **Mini-app editor** — `theme.*`, `tabBar.*`, `brand.*`, `me_page.*`:
     `content:edit` (the gate `cms.html` and `cms-mobile.html` open on) or
     `editor:edit`.
   - **Product editor** — `cart_notices.*`: `products:edit`. The notice is written
     only after the product's own save, which already needs that permission.
   - **Features** — `features.<key>`: the feature's own page, plus the phone's
     Settings, which has a switch for six of them (membership, affiliate, reviews,
     feedback, social proof, FAQ). Feedback also takes `reviews:view`, because the
     phone's Inbox shows "Enable" for it.
   - **The Support button's Hide** (`support.hidden`) stays open. The floating
     Support panel draws it for every operator, whatever permissions they hold.
   - **A key no family names** takes the union of all of the above. So an unlisted
     key closes only the account that can open none of these screens.
3. **The other writes, on the path** (the same rule; each screen named is the only
   caller):
   - Polls (`POST /polls`, `PUT|DELETE /polls/:id`) and `PUT /voting/config` need
     `voting:edit` (desktop Voting and phone Voting).
   - `PUT /leaderboard/config` needs `leaderboard:edit`.
   - Top-up packages (`POST`, `PATCH`, `DELETE`) and
     `POST /topup-transactions/:id/finalize` (credits a wallet) need `topup:edit`
     (desktop Top-up and phone Wallet).
   - `PATCH /affiliate/settings` needs `affiliate:view`, `affiliate:edit` or
     `sharing:edit`: the Affiliate tab, and the invite card on Share cards.
   - `PATCH /affiliate/referrals/:id` needs `affiliate:view` or `affiliate:edit`.
   - The mini-app editor's routes (`/cms/*`, publish included) need `content:edit`
     or `editor:edit`. The picture upload (`POST /cms/media`) is shared, so it
     also takes every desktop screen that uploads through it: the category banner
     (`categories:view`), the customer-service QR (Settings), the pop-up picture
     (`popups:view`), the About page (`content:view`), and `media:upload`.
     Deleting an editor picture (`DELETE /cms/media/:id`) has no caller on any
     screen, so it closes to the editor's keys and `media:delete`.
4. **The flash-sale keys now gate the flash sale.**
   - Setting a sale (`PUT /products/:id/flash-sale`) takes `flash:edit` or
     `products:edit`.
   - Ending one (`DELETE`) takes `flash:delete` or `products:delete`.
   - The products key in each pair is the one that let the write through until
     today, so nobody who could set or end a sale loses it.
   - The `marketing` preset holds every flash permission and no `products:edit`,
     so until now it was refused on its own Flash sales screen. It is not refused
     any more.
   - The old `/flash` and `/popups` path rules gate no route. They are left in
     place, with a note saying so.
5. **Every caller was checked**: desktop modules, `m.html`, `cms.html`,
   `cms-mobile.html`, `product-editor.html` and `retail-admin.html`. The public
   pages only read `/api/retail/*`. The suite pins the file list for each route,
   so a new screen that writes one of them fails the suite until someone decides
   what that screen needs.
6. **Who is refused now who was not before:** only an account that can open none
   of the screens that make the write. For example, an orders-only or
   warehouse-only account can no longer change fees or pop-ups, credit a wallet
   top-up, or publish the mini app. One narrow case, flagged:
   - The desktop's setup guide row has no gate of its own (the note beside
     `TAB_CAP` explains why).
   - So on a shop that has not finished setup and has turned enforcement on, a
     narrowed operator holding none of the Settings or Delivery permissions could
     open it and set the currency or the pickup lead time. They are now refused
     those two.
   - The guide's store step already refused that operator (`stores:edit`).
   - The phone gates Setup on `settings:shop` or `stores:view`, and both are
     admitted.
7. **Open for Ash, not decided here.** Several of these gates are a `:view`
   permission, because that is what opens the screen:
   - `delivery:view` for fees;
   - `affiliate:view` for the affiliate settings;
   - `loyalty:view` for points and tiers;
   - `popups:view` for pop-ups;
   - `content:view` for legal text.

   Narrowing any of them to its `:edit` permission would take the write from
   people who can do it today. That is Ash's call, family by family. The families
   already include the `:edit` permission, so narrowing means removing one entry.
8. **Tests.** `scripts/test_settings_write_gates.js` (fast shard, 172 checks). It
   mounts the real `routes/retail.js` over a scratch database with enforcement
   on, and resolves each operator's permissions from real grants, so the shipped
   choke point and handler are what is tested, not a copy of them. It checks:
   - every path rule;
   - every family's allow for every screen that writes it;
   - that families do not overlap (a pop-up editor cannot set the tax rate);
   - refusals over HTTP, including that a refused body writes nothing;
   - the owner, and enforcement off;
   - the caller lists;
   - that each screen really opens on the permission its gate names.
9. **Nothing composed.** No operator strings were added.
