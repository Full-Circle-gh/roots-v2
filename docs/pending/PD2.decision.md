## §NEW — A PRODUCT'S SALES AND VERSION HISTORY, AND THE SHOP MENUS, READ ON THE PHONE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Three read-only records reached the phone. The product sheet now carries the
editor's Sales card (units, revenue and rank over 7 / 30 / 90 days or all
time, plus when the product last sold and on how many days) and a Version
history row that opens the list of saved versions. A new **Shop menu** row in
More lists every location's shop and opens one shop's record: its public
code, its QR picture, the address a scan opens, a Download link, and its
listings with price, kind and availability, under the desktop's menu filter.
Nothing on these screens writes. Version restore (PD7), shop menu daily edits
(PD4) and shop menu structure (PD13) come in their own steps, each with its
desktop confirm.

1. **Same endpoints, same windows, same sentences.** The Sales card calls
   `GET /products/:id/sales?days=` with the desktop's four windows, for the
   size on screen, and says "Last sale … · N selling days" exactly as
   `pdSalesContext` does. A newer window wins over a slower, older answer (the
   desktop's `_pdSalesSeq`). The card reads afresh each time the sheet opens.
2. **Revenue follows the phone's money rule on top of the desktop's.** The
   desktop shows revenue to anyone who can open a product, and so does the
   phone, except a warehouse, dispatch or customer-service board
   (`recapNoMoney`), which gets units and rank and no revenue tile at all, as
   Trend and Home already do.
3. **Version history is read-only until PD7.** The list shows Current on the
   newest, Original on the baseline, and who saved each version. It carries no
   Restore button yet: a row offering a write that is not built would be a
   control that does nothing. The desktop's "Roll this product back…" subline
   is left off for the same reason.
4. **The shop menu's door is a More row, beside Sales.** On the desktop the
   door is the Sales board's location card, and the board opens for any of
   five keys (`dashboard:view`, `meituan:view`, `guanyi:view`, `eleme:view`,
   `integrations:view`). The phone's Sales screen opens for `dashboard:view`
   alone, so a door there would shut out a Meituan-only operator who reaches
   the desktop page. The More row and both routes are gated on the board's
   own any-of. This is the 29th row under Operations.
5. **A location with no shop says "Not set up" and does not open.** There is
   nothing to read until a shop is created, and creating one is PD13's.
6. **The QR is the desktop's, including its honesty.** The picture is
   `qr.png`, and the address underneath comes from `GET /shops/:id/qr`. A
   tenant with no public domain gets "QR unavailable" and neither the picture
   nor a Download link that would only answer with a refusal. An inactive
   shop shows no QR and does not ask for one. The public code stays
   unlabelled, as on the desktop (no live Chinese source for "shop code").
7. **Prices on the menu are shown as the desktop shows them**: to anyone who
   reaches the page. They are catalogue-level prices, already shown on the
   phone's Products list.
