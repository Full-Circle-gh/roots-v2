## §NEW — FOUR FOLLOW-UPS TO THE PHONE SAFETY STEPS: THE BANNER EDITOR'S KEYS, AN HONEST EMPTY LIBRARY, ALL OF §222 ON APPROVE, AND THE DESKTOP'S CUSTOMER SENTENCE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Four things the S1a–S1c reports named as outside their scope, now done. Phone (`public/m.html`)
and one desktop handler (`public/retail-admin/04-orders.js`); no server change.

1. **The category banner editor (§298) is drawn for the keys its writes need.** Every change
   saves the whole tree, `PUT /category-tree` → `categories:edit`; a new picture is also
   `POST /media/upload` → `media:upload`. So Add banner and Replace picture need both; the link,
   the dates and Remove need `categories:edit`; anyone else reads the banner (picture, status, the
   link's own label, the dates as text) and presses nothing. With no banner and nothing to press,
   the card is not drawn. The four commands refuse on the same keys. The rest of the Categories
   screen is unchanged; the whole-tree version check is S2's defect 11.
2. **The empty media library invites only when it can be taken up.** *Add photos from this phone,
   or upload them on desktop…* points at the header's Add photos button, which S1b drew only for
   `media:upload`. Without it the empty library says *Nothing in the library* and stops.
   `nothingYet()` now draws no empty line when it is given no message. Nothing composed.
3. **Approve refund carries all of §222's block, as the desktop draws it** (`04-orders.js`
   openRefundApproveDialog): the full or partial consequence line, the rider (S1c), and *Refunding
   never changes the delivery day…* — the line the block was written for (TC000823). A brick edge
   on a full approve, as there. "Full" is S1c's test (the server's gross-tender comparison). When
   the figures have not been read, neither consequence line is shown — the phone cannot say which —
   but the rider and the day line still are. Every sentence copied whole.
4. **The desktop's new-order form says "cannot create customers" only for that refusal.** That
   sentence is the handler's (`need: 'customers:edit'`, the save-as-customer step). A
   `forbidden_capability` from the choke point (no `orders:edit`), or naming no key, now gets the
   general TD_ERR sentence every other desktop screen gives, in the same top-of-form slot. This is
   the phone's S1a rule, on the desktop.
5. **Also in this step, test-only:** §329's `test_mobile_products_lists.js` (merged to main after
   S1b was cut) slices the catalogue row, which since S1b asks `prodCanEdit()`; the suite now lifts
   that function too (its own commit). Without it the suite fails once S1b and §329 are both on main.
6. **Tests.** `scripts/test_mobile_safety_followups.js` (fast shard, 16 checks): the banner card
   under each combination of keys and its commands (no write, no picker, no upload without them;
   the tree save with `categories:edit`); the media empty state; the approve block in each case and
   in Chinese, against the desktop's pairs; and the desktop `ordNewCreate` run against a fake
   server for the three refusals. `test_mobile_category_banner.js` gains an `mCan` stub.
