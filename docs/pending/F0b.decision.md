## §NEW — TWO PURCHASING WRITES NOW NEED THE BUYER'S KEY ON THE SERVER

**Built 2026-09-30 under §300** (Ash: *"yes , and keep going until you finish all .I approve all"*).
Step 0b of the parity survey's build order (`docs/tacet-phone-parity-recipes-purchasing-finance.md`
§3 defects 1 and 2). Two server permission gates in purchasing let the wrong person in. Both are
closed in `lib/cap-routes.js` and one handler, with no screen change. The desktop and the phone
already drew these buttons for the right people (the phone since F0); the server now agrees with
them. As with every gate in that file, nothing changes for a shop that has not switched
enforcement on, for the owner, or while an operator's permissions cannot be resolved.

1. **A receive-only account may mark an order "everything arrived", and nothing else.**
   `PUT /purchases/:id/status` accepted `purchasing:receive` for any status, so a store manager who
   can only receive could cancel an order, or send it back to draft, through the API. Now only
   `Delivered` takes either key; `Ordered`, `Requested` and `Cancelled` need `purchasing:edit`,
   matching the desktop's Place order / Back to draft / Cancel order buttons.
2. **The rule lives in the handler, because the path cannot carry it.** The target status is in the
   body, and the choke point (`requiredCapFor`) sees only method and path, so the path still lets
   either key through. The handler then asks `purchaseStatusCap(status)` (new, in
   `lib/cap-routes.js`) and refuses through `capDenied`, before it reads or writes anything. This is
   the pattern the order-status route already uses for a full refund. The refusal has the choke
   point's own shape: `403 {error:'forbidden_capability', need:'purchasing:edit'}`.
3. **`capDenied` now takes a list as well as one key** (hold any one), which are the two shapes
   `requiredCapFor` returns, read the way the choke point reads them. Every existing caller passes a
   single key, and those behave exactly as before.
4. **The phone's "Everything arrived" still works for a receive-only account.** It sends
   `PUT {status:'Delivered'}`, which is the one status left open to that key. It is tested end to
   end.
5. **Striking a kitchen-request line off needs `purchasing:edit`.**
   `PUT /material-requests/lines/:id/decline` sat under the kitchen's `production:request`, so the
   buyer the desktop draws the ✕ for was refused and any cook was allowed. It is the buyer's answer
   to the ask ("we are not buying this one", §174), so it takes the buyer's key. The rule matches
   that one path exactly and comes before the general material-requests rule.
6. **The cook keeps their own way to take an ask back.** Withdrawing the whole request
   (`PUT /material-requests/:id/archive`) and editing a draft (`PUT /material-requests/:id`) stay
   `production:request`, and so do raising and sending one. No screen calls withdraw today (the
   route exists; the phone's "Mine" list does not offer it), so nothing a cook uses was taken away.
   Striking a single line off was never theirs to do: §86's rule is that the kitchen withdraws and
   raises again.
7. **Deliberately not done:** a receive-only account may still mark a DRAFT (`Requested`) order
   Delivered, as the brief asked ("Delivered and nothing else"). No screen offers that — the phone
   and the desktop only draw "Everything arrived" on an order already placed — but the server does
   not refuse it either. Narrowing it to orders already placed would be a further, separate rule,
   and it is Ash's to ask for.
8. **Tests.** `scripts/test_purchasing_cap_gates.js` (fast shard) runs the real purchasing and
   material-request routers behind a copy of the choke point, and checks that copy against
   `routes/retail.js`'s source. It covers allow and refuse for the receiver, the buyer, a view-only
   account and a cook; the owner, enforcement off and unresolved permissions; the order untouched
   and the line still standing after each refusal; and the desktop's `data-cap` on the same controls.
9. **Nothing composed.** No operator strings were added.
