## §NEW — A PERMISSION REFUSAL ON THE PHONE IS SAID IN WORDS, NOT ANSWERED WITH THE LOGIN PAGE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Live defect 1 of the whole-app survey (`docs/tacet-phone-parity-rest-of-app.md`). The phone's three
request helpers in `public/m.html` — `api()`, `apiRaw()` and `apiWrite()` — and its two photo uploads
sent every 403 to `/backend/login` exactly as they sent a 401. With permissions switched on, one refused
tap threw a shift worker out of the app, and whatever they had typed went with it. Now only a 401 (the
session is gone) leaves for the login page; a 403 is an error the screen shows. Phone only: no server
change, no new screen.

1. **A 401 still goes to the login page, from every helper and both uploads.** The server answers every
   "who are you?" with 401 on purpose (`requireRetailAdmin`, `lib/require-cap.js`), so that is the one
   status that means the session is lost.
2. **A 403 throws the refusal into the caller's own error path** — the same path a 500 already took, so
   every busy flag comes back and the refusal renders where that caller renders its failures (the order
   sheet, the product sheet, the review row, the ask sheet, the card). The error keeps the server's
   `code` and `body` as `apiWrite` always did, and carries the sentence as its message.
3. **The words are the desktop's.** `forbidden_capability`, `forbidden_store` and `store_not_assigned`
   are `01-core.js` TD_ERR's own pairs, copied whole. A 403 that brings its own bilingual sentence
   ("… · …", the backend team and role routes' shape) keeps it, one language shown. A 403 with nothing
   readable gets `lib/require-cap.js`'s own pair, *You don’t have permission for this · 你没有此操作的权限*.
   Nothing composed.
4. **Deliberately not the new-order form's sentence for every refusal.** The brief pointed at the
   phone's existing `onwErrText` sentence for `forbidden_capability`; that sentence is *"Your account
   cannot create customers. Turn off 'Also save as a customer'…"*, which is true only for the handler's
   refusal with `need: 'customers:edit'`. It now reaches the operator for exactly that case (it was
   unreachable while a 403 logged them out). Every other refusal on that form, and everywhere else, is
   the desktop's general sentence — telling somebody without `orders:edit` to untick the customer box
   would send them to change something that fixes nothing.
5. **"Try again" is not the answer to a refusal.** Thirty-three write catches ended in a fixed "That did
   not save / send / go through — try again", and seven error-text helpers (`orderErrorText`,
   `csErrText`, `recvErrText`, `pwErrFor`, `pkErrFor`, `pinvErrFor`, `psupErrMsg`) plus `custWrite`'s
   chain fell back to it too. Each now says the refusal first and keeps its own words for every other
   failure. Stored errors use `E()`, so they follow a language switch. Catches that already showed the
   server's message (`finTxWords`, `acctWords`, autosave, `rcpActFail`, the stock rows) show the
   refusal as they are. Reads that fail on a refusal (a store outside the operator's scope) show their
   existing "Could not load" line — surfaced, and not reworded here.
6. **The media upload stops at the first refusal** — the next photo would be refused the same way — and
   says how many landed before it, then why. The category banner upload says the refusal on its card.
7. **Comments that justified a gate by "a 403 logs you out"** are corrected in place (channel sync,
   the customer header and action row). The gates stay: a button drawn for somebody the server refuses
   is still a dead end, which is step S1b.
8. **Tests.** `scripts/test_mobile_refusal_not_logout.js` (fast shard, 24 checks) runs the helpers and
   three callers with a fake fetch: 401 still redirects from all three helpers and the upload; 403 does
   not, and throws the code, body and sentence; the words in both languages against the desktop's file
   and `lib/require-cap.js`; the order sheet, a review switch and the media upload showing the refusal
   with their busy flags reset and the request as sent; and a guard that no write catch answers a
   refusal with a "did not save" sentence. `scripts/test_mobile_channel_sync_repair.js` pinned the old
   rule ("apiWrite sends 403 to the login page"); that check now pins the new one.
