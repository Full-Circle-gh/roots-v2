## §NEW — CLOSING ELEME AT A STORE STOPS ITS STOCK, NOT ITS ORDERS, AND THE SCREENS NOW SAY SO

**Investigated and reworded 2026-10-01 under §325** (found while building X12).
The phone's confirm for closing Eleme at a store said "No new orders arrive at
this store on this channel". The code does something smaller, so the sentence
now says what is true. No behaviour changed.

1. **What closing Eleme at a store actually does** (the phone's
   `POST /channel-status/cell`, the desktop Sales grid's toggle, and the
   whole-channel and shop-wide closes that include Eleme):
   - **It writes the store's Eleme cell to closed.** This happens in
     `lib/store-close.js` setChannelOpen, in `channel_status`.
   - **It deletes that store's queued Eleme stock pushes.** Pending,
     processing and error rows go, and the deletion is logged.
   - **The Eleme daemon then skips that store's pushes.**
     `processStockQueue` skips it via `channelClosedStores('eleme')`. Stock
     changes made while it is closed wait in the queue and go out when it
     reopens.
   - **Reopening queues no fresh full snapshot.** Only Meituan does that.
2. **What it does NOT do:**
   - **Nothing tells Eleme the shop is shut.** No code anywhere writes an Eleme
     shop status (unlike Meituan's 置休). So the shop stays open on Eleme and
     customers can still order.
   - **The order poll does not read the close.** It is gated on opening hours
     only (`isStoreOpen`), and `pollOrders` never reads the close. So those
     orders are still brought in.
   - **Eleme keeps showing the last stock it was sent.** Pushes are dropped and
     paused, so a closed store can take Eleme orders against stale numbers.
3. **The words now say this, on both surfaces:**
   - **Phone, closing or opening Eleme at one store, or at every store:** its
     own sentences. Closing says what stops and that orders still come in.
     Opening says the stock comes back, not that orders can arrive again.
   - **Phone, closing a whole shop or Close everything:** these end with "Eleme
     is the exception: it is not told, so Eleme orders can still come in", but
     only when Eleme is live there.
   - **Desktop, opening Eleme at a shut shop:** says the stock comes back.
   - **Desktop, the open/close panel's line "Closing pauses new orders…":**
     gains the same exception.
   - Every other channel's sentence is unchanged. Meituan really is closed on
     Meituan, and the mini app, web store and till obey the close at checkout.
4. **Not decided here, for Ash:** whether closing Eleme should actually close
   the shop on Eleme. That would mean adding a shop-status write to the
   browser-automation daemon. Until it exists, closing Eleme at a store pauses
   the stock and nothing else.
