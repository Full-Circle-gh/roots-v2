## §NEW — A WASTE ENTRY CAN BE VOIDED FROM THE PHONE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
The phone's Waste ledger gained the desktop's Void. On a live loss, an account
holding `waste:void` sees Void on the row. It asks the desktop's question,
which says what goes back into stock, then sends the desktop's request,
`POST /waste/:id/void` with an empty body. The server writes the reversal and
returns the stock; nothing about that changed. The rule this file's Waste
comment recorded, "No void" (it was an owner's key, rarely held in the aisle),
is retired: the key still decides, and the button is drawn only for whoever
holds it. A Back-order defect found in PD2 is fixed here too.

1. **Void is offered where the desktop offers it**: on a live loss only, never
   on a reversal and never on a row already voided, and only for `waste:void`
   (the desktop's `data-cap`). The server's own 409s back both rules.
2. **The confirm is the desktop's, word for word**: "Void this waste entry?",
   "N × product goes back into stock. The entry stays in the list, marked
   voided.", with no measure word in either language, because a waste entry
   is not always pieces. Nothing is sent before it is confirmed.
3. **While it is in flight the row says Voiding… and every Void waits.**
   Success is confirmed by a toast and the list is read again.
4. **A void that does not go through says so above the list and stays there**
   until the next void or filter, never in a toast. A permission refusal says
   why (§325's refusal words). A row already voided elsewhere shows the
   server's own sentence, as the desktop does, and the list is read again,
   because the screen was out of date. Anything else shows the phone's
   "Nothing has changed — try again".
5. **Back closes the "When it runs out" picker before the product sheet under
   it.** The Back stack listed the picker before the product, so Back took the
   product away and left the picker standing over nothing. It now follows the
   z-order, as the version list added in PD2 already did.
