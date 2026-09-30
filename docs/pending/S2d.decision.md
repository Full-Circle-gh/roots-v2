## §NEW — "EVERYTHING ARRIVED" IS FOR AN ORDER ALREADY PLACED

**Built 2026-10-01 under §325** (Ash's answer to §302.7, recorded as §326 item 9).
§302 let an account holding only `purchasing:receive` mark a purchase order
Delivered and nothing else. §302.7 left one gap open for Ash: that account could
still mark a **draft** (Requested) order Delivered through the API, even though
no screen offers it. Ash has closed it. Now a receive-only account may mark an
order Delivered only when it is Ordered. Holders of `purchasing:edit` are
unchanged. As with every gate in `lib/cap-routes.js`, nothing changes for the
owner, for a shop with enforcement off, or while an operator's permissions
cannot be resolved.

1. **The rule reads the order's current status.**
   `purchaseStatusCap(status, current)` returns either permission for Delivered
   only when `current` is `Ordered`. From Requested, Cancelled or Delivered it
   returns `purchasing:edit`. Called without `current`, it answers as before;
   that is the check the handler makes before it has read the order.
2. **The handler asks twice.** It asks once on the body, as §302 does, and again
   once the order is read. Both checks come before anything is written. A refusal
   has §302's shape: `403 {error:'forbidden_capability', need:'purchasing:edit'}`.
   An order that does not exist is still a 404.
3. **A part-arrived order is not an Ordered order.** Both screens store it as
   `Delivered` from its first counted line on: the desktop's `puPartial` and the
   phone's `rcvPartial` read "Part arrived" off a Delivered order with lines still
   to come. So a receive-only account can no longer send a whole-order Delivered
   for it. They finish it line by line through Receive (`/purchases/:id/receive`,
   `purchasing:receive`), which this does not touch.
4. **Nothing a receiver can press is taken away.** The two screens that send this
   write draw it only on an Ordered order: the desktop's "All arrived as ordered"
   and the phone's "Everything arrived". The suite pins both.
5. **Tests.** `scripts/test_purchasing_cap_gates.js` gains 24 checks (91 in all).
   - **The rule:** Delivered from Ordered is either permission; from
     Requested, Cancelled or Delivered it is the buyer's.
   - **Receive-only account refused:** from a draft, a cancelled order and a
     Delivered order. Each order is left exactly as it was.
   - **Still allowed:** the buyer marking a draft Delivered, the owner, and a
     shop with enforcement off.
   - **Unchanged:** an order that does not exist is still a 404, and both screens
     still draw the button on Ordered only.
6. **Nothing composed.** No operator strings were added.
