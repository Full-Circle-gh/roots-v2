# Tacet mobile — parity with the desktop admin

**Audit, 2026-08-22, from source.** Read `public/m.html` (the phone build
`server.js:625` serves to every mobile browser) against the desktop modules
under `public/retail-admin/`. Every row below carries a file reference; nothing
here is inferred from a screenshot.

> **The finding, in one line: the phone was a monitoring app whose write
> controls were mockups, monitoring numbers it had made up.** Nine controls
> looked like they did something and wrote nothing. Eleven screens rendered
> content that came from the source rather than the server.

**Closed, 2026-08-22.** Every screen in `public/m.html` has now been read
against its desktop counterpart. What that turned up, by class:

| Class | Count | Now |
|---|---|---|
| Controls wired to `noop` — a row, a chevron, and nothing behind it | 9 | Gone. `noop` itself is deleted, and the sweep fails the build on the name |
| Screens rendering invented content — fake purchase orders, five stock movements that never happened, six categories in neither scheme, a `¥184,220` balance no endpoint returns | 11 | Gone. Every screen reads its server, and an empty answer looks empty |
| Loaders that assigned only `if (rows.length)`, so an empty server answer left the mock on the glass | 4 | Fixed |
| Status computed from one flag where the desktop resolves several from the dates — an expired coupon reading *Running*, a pop-up starting in December reading *Live* | 3 | Fixed |
| **Writes that reported success and sent nothing** | 1 | Fixed — `APP.cmd` forwarded one argument to a two-argument handler. Voting's Open/Close had never worked and always said it had |
| Health an operator can only see from a desk — a stuck Meituan queue, an exhausted maps quota, a gzgrocery decision queue, unpublished CMS drafts | 4 | Surfaced |

**What holds it:** `scripts/test_mobile_screens.js` renders every screen, warm
and cold, in both languages and both themes (208 renders), and carries five
static guards — a called-but-undefined helper, a missing `DB` key, a duplicate
or undeclared `state` key, a `noop` reference, and an `APP.cmd` call site
passing arguments the dispatcher would drop. Each was written *after* the bug
it describes shipped, and each is mutation-tested. Seven behavioural probes
(`test_mobile_inbox`, `_purchasing`, `_activity`, `_categories`, `_club`,
`_voting`, `_settings`, `_orders`) assert rendered text and, for the writes
with the worst failure modes, the request body.

---

## How the two surfaces differ by design

The phone is deliberately not the desktop. Authoring — a product with options
and variants, a coupon, a broadcast, a mini-app page — belongs to a keyboard
and a big screen, and the phone says so in its own words ("full authoring on
desktop"). What the phone owes an operator is the daily loop: see what needs
me, open a record, move it one step, and say something back to a customer.

So a missing capability is only a defect when it is part of that loop. Each row
below is judged on that, not on "the desktop has it."

---

## 1. The controls that pretended

Every one of these rendered a button, took a tap, showed a confirmation, and
sent nothing to the server.

| Control | Where | Was | Now |
|---|---|---|---|
| Mark delivered | order sheet | toast only — and offered from every state, so a **paid** order's only forward move skipped Preparing | **Fixed** — one step at a time, real `PATCH /orders/:id/status` |
| Reprint receipt | order sheet + ⋯ | toast only | **Fixed** — `POST /orders/:id/print`, reports the printer's real answer |
| Copy (ship-to, payment) | order sheet | toast said "Copied", clipboard untouched | **Fixed** — real clipboard write |
| Issue refund | order ⋯ | toast "Refund started" — on a money flow | **Removed** — a refund is full/partial and needs the chooser; desktop-only for now |
| Re-route order | order ⋯ | closed the menu | **Removed** |
| Save (product stock + price) | product sheet | toast "Saved" | **Fixed** — price via `PATCH /products/:id`, stock **per store** via `PATCH /stores/:id/stock/:pid` |
| Send reply (review / feedback) | reply sheet | toast "Reply sent" | **Fixed** — `PATCH /reviews/:id` · `POST /feedback/:id/reply` |
| Create (coupon / flash / broadcast) | create sheet | toast "Created" | **Still fake** — see §3 |
| Receive stock (PO) | purchase-order sheet | toast "Stock received" | **Still fake** — see §3 |
| Auto-print receipts | settings, delivery | flipped in memory; a reload undid it | **Fixed** — real value from `GET /printer`, written with `PUT /printer` |
| Auto-route, low-stock pause | settings, delivery | switches for settings that do not exist | **Removed** — routing is behaviour, not a preference; the page says so |
| Coupon on/off | Coupons | in-memory only | **Fixed** — `PATCH /vouchers/:id {is_active}` |
| Fapiao auto-issue | Operations | in-memory only | **Fixed** — `GET/PUT /fapiao-settings` |
| Create coupon / flash sale / broadcast | marketing screens | toast "Created" | **Removed** — authoring belongs on a keyboard; the lists stay, and a scheduled broadcast can now be **cancelled** (`POST /broadcasts/:id/recall`) |
| Quick stock (3 hardcoded products) | Quick stock | counted nothing | **Removed** — a product's stock is edited per store in Products, for real |
| Media library (9 fake tiles) | Media | `IMG_1000`…`IMG_1008` | **Fixed** — the real library from `GET /media/list` |
| Feature switches (membership, reviews, feedback, FAQ, affiliate) | settings, and the gates on those screens | in-memory only — **and the screens were gated on them**, so a store could see a feature it had switched off | **Fixed** — `features.<key>` in storefront_config, the same switch the desktop writes |
| Every settings switch | settings | rendered **below** its row — a `<button>` inside a `<button>` is invalid HTML, so the parser re-parented it | **Fixed** — the row is a div |
| "Owner · Growth plan" | settings | a plan nobody sold them | **Removed** — the real setup progress takes the line |
| Sign out | account menu | toast "Signed out"; the session stayed open | **Fixed** — `POST /api/backend/logout`, then the login page |
| Search | topbar | five hardcoded results; the input did nothing | **Fixed** — searches orders server-side (`q=`); the jump list is built from the real nav |

---

## 2. Page by page

✅ on the phone · ⚠ present but fake · ✖ missing, worth adding · ➖ missing,
desktop is the right home

### Home (desktop: Dashboard, `03-dashboard.js`)

| Desktop capability | Phone |
|---|---|
| The Recap, real away-window figures | ✅ |
| Needs-you rows, deep-linked | ✅ — the real `/dashboard/ops` fires now (delivery, payment mismatch, refunds, orders to start, awaiting restock, invoices, restock), Brick-first then oldest, each opening its filtered list |
| Today's KPIs with deltas | ✅ |
| **Also today: sessions, conversion, returning buyers, refunded** | ✅ — with the desktop's own honesty rules kept intact: under 20 sessions conversion shows the raw counts and no percentage; Returning names its denominator, because "New today" counts accounts created and this counts people who paid; a clean day says "nothing sent back", not 0% |
| ↳ the same money gate as the Recap | ✅ — a warehouse or dispatch account sees no revenue block at all |
| Orders waiting for a delivery point | ➖ — a same-city dispatch queue; the fires cover what needs a call |
| On the road / Ready to hand off / Drafts to send | ➖ — the Orders chips carry the same counts one tap away |
| Unhandled-orders card (paid, nobody started) | ✅ — "Orders to start" |
| Payment-mismatch fire | ✅ — "Payment doesn't match", opening the Pending list, with the brick mark on the row (and in the drawer) that says which order it is |
| Payments-to-confirm fire (amber) | ✅ — a proof on file that nobody has accepted; same door |
| The three proof states on the row | ✅ — rejected in brick; verified-but-unpaid and never-read in brass, mirroring `paymentCheckLine` |
| Low-stock drawer with per-store counts | ➖ |
| Activity feed ("Show the work") | ✅ — the same `/dashboard/activity` feed, the same sentences, opened in place under the Recap. Latest 40 rows, each tapping through to its order / customer / thread |
| The away-window boundary ("you left here") | ➖ — the phone's Recap window is computed client-side from the orders list, so there is no server `since` to draw the line at |
| Reports chapters | ➖ |

### Orders (`04-orders.js`)

| Desktop capability | Phone |
|---|---|
| Status + channel filter chips with live counts | ✅ — **server-side now**; they used to filter only the 50 rows already loaded, so "Delivered 15" could list three |
| Row → record, full detail | ✅ |
| Forward transition, one step at a time | ✅ (fixed today) |
| Pickup relabelling (ready for pickup / picked up) | ✅ (fixed today) |
| Undo dispatch / delivery | ✅ (fixed today) |
| Print receipt | ✅ (fixed today) |
| Read-only marketplace mirrors carry no actions | ✅ (fixed today) |
| Mark paid, with the tender recorded | ✅ — the phone asks which tender, so nothing lands as "unknown" |
| Refund: approve / reject a request, then pay it out | ✅ — approve and payout stay two acts, as on desktop; the payout asks how the money goes back |
| Refund: partial / line-level amounts | ➖ — approving takes what the customer asked for; editing lines is desktop work |
| Cancel + refund | ➖ |
| Edit ship-to address | ➖ — decided: desktop only. Seven fields with address matching behind them; a mistyped district is a failed delivery |
| Tracking number entry / parcel split | ➖ |
| Staff note | ➖ — no endpoint edits an existing order's note; it is written at creation only. Backend work, not a screen |
| Store filter (multi-store) | ✅ — a third chip row, shown only when the account has more than one store |
| Pagination | ✅ — 25 a page, "N of M", Load more |
| Search within orders | ✅ — server-side, from the topbar |
| Bulk tracking paste, CSV export | ➖ |

### Customers (`08-customers.js`)

| Desktop capability | Phone |
|---|---|
| Segments with real counts, tier filter | ✅ |
| Roster with the unopened treatment | ✅ |
| Record: ordered / orders / avg, points, wallet, recent orders, addresses, diagnostics | ✅ (read-only) |
| Adjust points | ✅ — with the reason the server requires |
| Top up wallet | ✅ |
| Block / unblock | ✅ |
| Message the customer | ✅ — `POST /customers/:id/message`; the desktop then opens the feedback thread, the phone says where the reply will land and refreshes the Inbox |
| Edit profile, addresses CRUD | ➖ |
| Force logout, reset test account, CSV export | ➖ |

### Products (`09-products.js`)

| Desktop capability | Phone |
|---|---|
| Catalogue, stock activity, categories as sub-views | ✅ |
| Stock + price quick edit | ✅ — price, and stock per store |
| Category filter, search | ✅ — search (name en/cn, SKU), category chips built from the catalogue's own top categories, and status chips that filter for real |
| Status buckets (Live / Draft / Low / Out) | ✅ — the desktop's own predicate: published first, supplier-direct never Low or Out, low line from `inventory.lowStockThreshold`. The phone previously called every well-stocked row "Live", drafts included |
| Whole catalogue in hand | ✅ — `/products?limit=500` on first open of the tab (boot still fetches 50 for Home) |
| Subcategory filter | ➖ — it exists on the desktop to scope drag-to-reorder, which the phone does not do |
| Assembled-bundle stock (min over components) | ➖ — the phone shows `effective_stock`; a bundle's buildable count stays desktop |
| Add product (wizard or blank), options, variants, photos, bulk edit, reorder | ➖ |

### Inbox — Reviews + Feedback (`10-extras.js`)

| Desktop capability | Phone |
|---|---|
| Two lists, unseen marking | ✅ |
| Reply to a review / feedback | ✅ |
| Hide / show a review | ✅ — `PATCH /reviews/:id {is_visible, source}`; hiding asks first, restoring does not |
| The product a review is about | ✅ — the phone showed only who wrote it |
| The live merchant reply, inline | ✅ — and the button reads "Edit reply" once there is one |
| Remove a seeded review | ➖ — a permanent delete, and only synthetic rows can take it. Desktop |
| Filter by rating / visibility / product | ➖ |

### Products — the second sweep

| Desktop card | Phone |
|---|---|
| **The product photo** | ✅ — the desktop's catalogue is a grid of pictures; the phone's was a list of names, which is the wrong way round for a small screen |
| **Variant families collapsed to one card** | ✅ — a product in three sizes was three near-identical rows. Now one card with its size chips, a price *range* when the sizes differ, and "1 out of stock" when a live size is empty |
| ↳ family photo inherited from a sibling | ✅ — the group owner is whichever size was created first, not necessarily the one anyone photographed |
| **On shop / Off shop switch** | ✅ — flips every size of a family at once, and puts itself back if the server refuses. The one product decision that is genuinely urgent |
| Bundle mark | ✅ |
| Draft mark | ✅ |
| Designed / Plain mark | ➖ — whether a product has authored page sections is an authoring fact, and authoring is desktop |
| Duplicate | ➖ |
| Drag-to-reorder, bulk edit, export | ➖ |
| Full product editor (photos, description, badge, category, thresholds) | ➖ decided: desktop. Price and per-store stock are the phone's two edits |

### Coupons (`05-marketing.js`)

| Desktop | Phone |
|---|---|
| **What the coupon gives** (¥ off / % off / free shipping) | ✅ — the phone showed a title, a code and a used count, so "20% off everything" and "¥5 off over ¥200" looked the same |
| **The rules** (minimum, per-customer limit, total cap) | ✅ — "every order" stated rather than left blank, since no limit is a decision |
| **Used / max** | ✅ |
| **Ends**, amber inside a week or once past | ✅ |
| **Pills**: auto-apply (naming *whose* checkout), in the app, new signups, given N/M | ✅ — auto-apply keeps its Dusk, since "the system does this for you" is what Dusk means |
| Running / Off / All segments with counts | ✅ |
| ↳ "N coupons are off — view" | ✅ |
| **Expired ≠ running** | ✅ — **a real bug fixed**: the phone read `is_active` alone, so a coupon that expired months ago sat at the top of the list with its switch on |
| Turn on / pause | ✅ — writes `is_active`; an expired coupon turned back on says Ended, because it is |
| Search by code or title | ➖ — the list is short and segmented |
| Create / edit a coupon, grant to a customer | ➖ — authoring, desktop |

### Flash sales (`05-marketing.js`)

| Desktop | Phone |
|---|---|
| **The flash price, the old price, the % off** | ✅ — the card showed a name, two clock times and a pill. A flash sale IS a price, and the price was the one thing missing |
| **Sold / limit, with how many are left** | ✅ — with a bar, and "sold out" in brick when the cap is hit |
| Product photo | ✅ |
| **The window with its dates** | ✅ — two bare times read as "today 12:00–14:00" on a sale that runs all week. Same-day shows the date once and both times; a multi-day sale shows both dates |
| **"Product is not on the shop"** | ✅ — a flash price on an unpublished product is a sale no customer can see, and nothing said so |
| "No coupons on top" | ✅ |
| Create / edit a flash sale | ➖ — authoring, desktop |

### Broadcasts (`05-marketing.js`)

| Desktop | Phone |
|---|---|
| **The message body** | ✅ — the phone let an operator CANCEL a scheduled send without showing what it said. A switch over a black box |
| **Who it goes to** (activity · tiers · regions) | ✅ — "Sent to 2,140" is a number with no population behind it. Composed in the desktop's own words, collapsing to "3 regions" past two |
| Deeplink | ✅ |
| Sent / scheduled / draft, with the date | ✅ — the scheduled line printed the raw column, so it read "Scheduled 2026-08-29 10:00:00" |
| Cancel a scheduled send | ✅ — only on scheduled ones; the server is the judge |
| Compose and send | ➖ — authoring, desktop |
| Audience-count preview while composing | ➖ — belongs to composing |

### Media library (`07-content-billing.js`)

| Desktop capability | Phone |
|---|---|
| Browse the library | ✅ — `GET /media/list` |
| Add photos | ✅ — camera or roll, straight to `POST /media/upload`, the one thing the phone can do that the desktop cannot |
| Folders, tags, alt text, rename, delete, bulk move | ➖ — cataloguing work, and it says so |

### Sales, Delivery, Settings

| Desktop capability | Phone |
|---|---|
| Channel board with live status | ✅ — the real channel × store grid from `/channel-status`: open, closed, or open at 2 of 3, naming which store is shut. The header line says it for the whole board |
| Today's per-channel orders and revenue | ✅ — `/sales/summary`, said as *today's* rather than as a bare number with no window on it |
| Channel detail (mirror + config) | ✅ read-only |
| Open / close a channel or a location | ➖ **open question** — the most phone-shaped write in the app ("we're slammed, close Meituan") and also the heaviest: it stops orders arriving. Left on the desktop until asked for |
| Delivery zones | ✅ count, from `/delivery-zones` |
| Store geocoding health | ✅ — replaced a "Routing · Nearest store" row that described behaviour as if it were a setting. A store with no coordinates can never be the nearest one, and now the phone says so |
| Fees, cut-off, couriers, pickup points | ➖ |
| Auto-print receipts | ✅ |
| Feature toggles (membership, reviews, feedback, FAQ, affiliate) | ✅ — all real, `PUT /config {features.<key>}` |
| Affiliate overview | ✅ — the real referral summary; it used to state "42 affiliates · ¥8,120 referred" |
| Invoices: real counts, working chips, open the issued file | ✅ — the counts ride the envelope beside `data`, which `api()` was discarding |
| Sign out | ✅ |

---

## 2b. The screens that invented their content

Worse than a button that does nothing: a screen that shows numbers an operator
will believe. Ten of them rendered sample data with no live source behind it.

| Screen | Showed | Now |
|---|---|---|
| Open your store (More card + screen) | "50% set up · 3 steps left" — the same for every store on earth | Real, from `GET /setup` |
| FAQ & help | three invented questions | The store's own `faq.questions` |
| Legal pages | "Terms of service · Updated 2026-05-01" | The real documents and their real dates, expandable to read |
| Pop-ups | a mocked-up "Welcome! Get ¥10 off" card | The real `popups.list`, with live/off and its window |
| About page | an invented tagline and an invented story, over a Save that saved nothing | The published about content, read-only |
| Delivery | "6 zones · JD · kd100 · 2 pickup points" — three numbers typed once | The real zone count; the two with no source are gone |
| Share cards | invented share counts | An honest "made on desktop" |
| Social proof | "12 people bought this today" and a toggle over nothing | An honest "set up on desktop" |
| Product stock | one flat number for a multi-store catalogue | Per store, from `GET /products/:id/store-stocks` |

**A regression net came with it.** `npm run test:mobile-screens` renders every
tab, every pushed screen, every sheet, both languages and both themes, and
fails on any uncaught error. It exists because of how this class of bug hides:
when a render throws, the previous screen stays on the glass, so the tap looks
ignored and a screenshot of the broken screen shows the working one. A missing
helper shipped that way during this very pass.

---

## 3. What it would take

Ordered by what an operator loses today, not by effort.

| # | Build | Endpoint | Notes |
|---|---|---|---|
| ~~1~~ | ~~Reply to a review / feedback~~ | | **Done** 2026-08-22 |
| ~~2~~ | ~~Product stock + price quick edit~~ | | **Done** — stock is per store, as it is on the desktop |
| ~~3~~ | ~~Sign out~~ | | **Done** |
| ~~4~~ | ~~Auto-print~~ | | **Done**; the rest of the toggles still owed, one endpoint each |
| ~~5~~ | ~~Refunds: approve / reject / pay out, and Mark paid~~ | | **Done** — each behind a confirm or a tender chooser |
| ~~6~~ | ~~Orders: store filter, pagination, real search~~ | | **Done** |
| ~~9~~ | ~~Coupon on/off, fapiao auto-issue, media, the channel mirrors~~ | | **Done** |
| ~~7~~ | ~~Customer: points, wallet, block~~ | | **Done** |
| — | ~~Edit ship-to~~ | | **Decided 2026-08-22: stays on desktop.** Seven fields with Chinese address matching behind them, and a mistyped district is a failed delivery. Not a phone job for now. |
| — | ~~Staff note~~ | | **Not a thing** — `staff_note` is written at order creation only; no endpoint edits it afterwards. Would need backend work. |
| ~~10~~ | ~~Products: search, category filter, real status chips~~ | | **Done 2026-08-22** — the chips were wired to `noop` and counted only the 50 rows boot had fetched |
| ~~11~~ | ~~Reviews: hide / restore~~ | | **Done 2026-08-22** — and reviews are keyed by source+id now, not by the writer's name, which two reviews from one customer used to share |
| ~~12~~ | ~~Message the customer~~ | | **Done 2026-08-22** |
| ~~13~~ | ~~The Recap's "Show the work" feed~~ | `/dashboard/activity` | **Done 2026-08-22** |
| ~~14~~ | ~~Media upload from the phone~~ | `POST /media/upload` | **Done 2026-08-22** |
| ~~9~~ | ~~The remaining feature toggles~~ | | **Done 2026-08-22** — the last two that wrote nothing (the Feedback empty state's Enable, the Affiliate screen's switch) now write `features.<key>`, and the local-only `sw` command is gone rather than left where the next person would reach for it |
| ~~15~~ | ~~Invented content: Affiliate overview, Invoice counts, the fapiao banner, the Recap's fallback~~ | | **Done 2026-08-22** |
| ~~16~~ | ~~Sales board on real channel status~~ | `/channel-status` + `/sales/summary` | **Done 2026-08-22** |

Nothing above needed a new endpoint, and as of 2026-08-22 every row is struck
through. Each was built to the same three states the rulebook requires and the
order actions demonstrate: the control disables and says what it is doing, a
refusal renders where the operator is looking and stays, and a toast confirms
but never reports failure.

## 3b. The second audit — fields, not just controls

The first audit asked "does this control work". It did not ask "does this row
say what the desktop's row says", and that is where the real losses were: a
phone card with a status pill and a price, next to a desktop row with ten
columns of fact. Reported from production, then swept column by column.

### Orders list — the desktop's ten columns

| Desktop column | Phone |
|---|---|
| Order # | ✅ |
| Channel | ✅ icon (the label is the icon here) |
| Customer | ✅ |
| **Store** + routing note + "needs restock" | ✅ — a two-store shop could not tell which store owed the work. Folded into one muted line with Items; suppressed on a single-store shop, where naming it on every row says nothing |
| Ship to | ✅ — and Counter is no longer called Pickup, which the desktop keeps apart on purpose |
| **Items** | ✅ |
| Total | ✅ |
| Status pill | ✅ |
| ↳ payment-proof line | ✅ (three states) |
| ↳ **add-on badge** ("items added after paying") | ✅ |
| ↳ **stock-pending badge** | ✅ |
| ↳ **invoice line** (owed / issued) | ✅ |
| ↳ **shipping-store-short warning** | ✅ |
| ↳ refund badge, partial vs full, with the amount | ➖ — the row's pill still says only "Refund requested"; the drawer now carries every figure, one tap away |
| **Delivery** (the merged tracking + ship-by cell) | ✅ — ported branch for branch: waybill + carrier state, the ten delivery states with problems first, the live courier stage, "No waybill yet" in brick, air-delay, local ETA, marketplace arrival/booked, and the ship-by plan with its urgency tag |
| ↳ ship-by label prettifiers | ⚠ the stored slot label is used as-is; the desktop humanises it. Raw, never wrong |
| Placed | ✅ — was a bare time, so an order from three days ago read "9:07 AM" |
| Split-parcel rollup | ✅ |

### Order drawer — the desktop's sections

| Desktop block | Phone |
|---|---|
| Order #, status, actions | ✅ |
| Head marks: placed, **partially shipped (n/total)**, **items added (+¥)**, **stock pending**, **print failed** | ✅ |
| Hoisted per-parcel tracking | ✅ (each parcel card carries its own) |
| Refund banner + panel (requested / approved / paid, reason) | ✅ — every state, the customer's own words, the lines they picked, the cash-vs-wallet split, the payout method and reference, the staff note, and the "paying" hold |
| Invoice block (type, title, tax id, email, file) | ✅ read-only — issuing stays desktop |
| Order total banner + breakdown | ✅ — **voucher** line added |
| Ship to / **Pickup (which store)** / **Counter sale** | ✅ |
| Address-changed note | ➖ |
| Customer tile + **link to their record** | ✅ |
| Payment method + status | ✅ |
| Pay-link tile (resend an unpaid order's link) | ➖ |
| **Voucher** | ✅ |
| Ship-by tile | ✅ — the promise the order was sold on, with its overdue/today/tomorrow mark. Absent on a counter sale, which promised nothing |
| Store + routing note + reroute-short + "routed by area" | ✅ — the rerouted order now names the products the nearer store was short of, and an address that could not be located says so |
| **Alipay proof screenshot** | ✅ — tap to open it whole |
| **Customer note** | ✅ — the single most obviously missing thing in the drawer |
| Split banner + merge/split parcel controls | ➖ — packing decisions, desktop |
| Items, grouped into parcels with their mode | ✅ |
| **Add-on timeline** (what was added, when) | ✅ |
| Reservations table | ➖ |
| Edit ship-to / make address Chinese | ➖ decided: desktop |

### The shell

| Desktop | Phone |
|---|---|
| Fixed rail + topbar | ✅ five-tab bar at the bottom; **one header** (canvas frame 4) — the bar carries the page's name, then search, inbox and the account, closed by a hairline; the status line sits below it in the scroll. The old bar spent 72 px on a wordmark and then repeated the page's name underneath itself; the chips now start at 103 px instead of 165 px |

### Customers — the second sweep

| Desktop | Phone |
|---|---|
| Stat strip: Buyers, Returning rate, Never ordered | ✅ as one line |
| ↳ New today | ➖ — the "New this week" chip carries its own count and covers the same question |
| ↳ Blocked count | ➖ — the Blocked chip appears only when there are any, which says it |
| Segments: All / New this week / Sleeping 60d+ / Blocked | ✅ |
| Tier filter | ✅ (single-select chips; the desktop's is multi-select) |
| Channel filter | ✅ |
| Search by name or phone | ✅ |
| **Sort** | ✅ — seven orderings, the endpoint's own. **Neither surface had a sort control**: the desktop sets `last_seen` once and never changes it, which is why "show me the newest customer" had no answer anywhere |
| Row: name, blocked, phone, tier, orders, spend, points, wallet, last seen | ✅ |
| ↳ Channel column | ✅ — named only when it is not the default, since a column reading "WeChat" 1,300 times is not information |
| ↳ the date on the row | ✅ — it now says whether it is a visit or a signup, and follows the sort |
| Pager with page-size picker | ✅ Load more, with a real total |

### Customer record — the drawer's eleven blocks

| Desktop block | Phone |
|---|---|
| Stats: orders, spend, avg, points, wallet, joined | ✅ |
| Recent orders | ✅ |
| Addresses | ✅ read-only |
| **Top items** | ✅ |
| **Points ledger** | ✅ — where each point came from |
| **Top-ups** | ✅ — with the bonus, and a failed one saying so |
| **Vouchers held / used** | ✅ |
| **Reviews written + average** | ✅ |
| **Referrals**: their code, who referred them, who they brought | ✅ |
| **Last order / last sign-in / devices signed in** | ✅ |
| Diagnostics | ✅ |
| Activity chart by month | ➖ — a chart is the desktop's affordance; the figures behind it are all on the phone |
| Message, Adjust points, Adjust wallet, Block | ✅ |
| Edit profile (name, email) | ✅ — **asked and answered 2026-08-22.** The phone number stays a desktop edit: it is the key customer records are deduped on, so a mistyped digit is a merge or a split, not a typo. The sheet says where it moved rather than leaving the field missing |
| Sign out all devices | ➖ — **asked and declined 2026-08-22.** The device count is on the record; ending the sessions stays on the desktop |
| Address edit / delete / set default | ➖ decided: desktop |

### Inbox — the second sweep (`07-content-billing.js`)

The Reviews half was audited in §2. The Feedback half had never been read
against `renderFeedbackRow` / `openFeedbackThread`, and it did not survive
that reading.

| Desktop capability | Phone |
|---|---|
| The list renders at all | ❌ → ✅ — `mapFeedback` was **called but never defined**: an edit to Broadcasts sliced a region of the file and took it with it. Every screen still painted, because the only two call sites sit behind a live fetch inside a `try/catch`, so the inbox just showed its sample data forever. `scripts/test_mobile_screens.js` now fails the build on a called-but-undefined `mapX`/`loadX`/`screenX`/`sheetX` |
| **The row leads with the newest turn** | ❌ → ✅ — the phone led with the thread root. On a thread the store started, the root is the operator's own opener, so the customer's answer appeared nowhere on this device |
| One clipped line of the root, once there are replies | ✅ |
| Who spoke last (Customer / the operator's name) | ✅ |
| `n replies` / `n 条往来` | ✅ |
| Needs reply / Replied status | ✅ |
| Page context + app version | ✅ — `checkout · v2.4.1`, one pill |
| ✉ Message — a thread the store started | ✅ — "We messaged them" |
| Attached photos | ✅ — up to four on the row, tap to open full size |
| `opened <date>` beside the last-activity stamp | ✅ |
| **Read the whole conversation** | ❌ → ✅ — the phone had a reply box, not a thread. Past the third message the middle of the conversation existed on the desktop and nowhere else. `openReply` on a feedback row now fetches `/feedback/:id` and renders every turn as a bubble, customer left / store right, with the composer pinned at the foot — and, as on the desktop, opening it stamps `admin_read_at` |
| Sending keeps you in the thread | ✅ — a public review reply is one shot and closes; a thread re-reads itself and shows the turn just sent |
| Where the reply lands is stated, per stream | ✅ — a review reply says "under the review"; a thread reply says "the customer's mini-app inbox". The phone said "under the review" for both |
| Lightbox | ➖ — photos open in the OS viewer, which is the phone's own affordance |
| Filter / search the inbox | ➖ |

`scripts/test_mobile_inbox.js` (30 assertions, 6 cases) locks all of the above
to rendered text rather than to source, including the thread's loading and
failed states. It was mutation-tested: reverting the row to lead with the root,
and the thread to show only its last turn, fails it.

### Purchasing (`16-purchasing.js`)

The phone's Purchasing screen was three hard-coded purchase orders — Fresh Co.
¥3,240 *Received*, Oat Works *In transit*, Nut House *Draft*. Two of those
statuses have never existed on the server (`PO_STATUSES` is Requested / Ordered
/ Delivered / Cancelled). A live prefetch did overwrite the list, but only
`if (rows.length)`, so a shop with an empty ledger saw three orders it had never
placed and a month's spend it had never made. And each row's tap called
`openOrder()` — the *customer* order sheet — with a PO number that sheet could
never find.

| Desktop capability | Phone |
|---|---|
| The ledger is the server's | ❌ → ✅ — `/purchases`, and an empty ledger now says it is empty |
| Open / Received / All, with counts | ✅ |
| Statline: open · late · spent this month | ✅ — suppliers count is on the desktop's suppliers screen, which has not moved |
| Row: number, date, supplier, store, lines (+ received), total, arrival, status | ✅ |
| **Late** — Ordered, with an arrival date already past | ✅ — amber on the row and the pill, same rule |
| Status words: Draft / Ordered / Received / Cancelled | ✅ — the phone had invented its own |
| Tapping a row opens the order | ❌ → ✅ — it opened the customer-order sheet on a row with no items, no customer and no status it understood. POs have their own sheet |
| Order sheet: supplier, store, dates, total, every line with qty/unit/cost | ✅ |
| Per-line shelf stock, received count, damage | ✅ read-only |
| Mark a draft Ordered | ✅ |
| **Tick a whole delivery in** | ✅ — `PUT /purchases/:id/status {Delivered}`, the server's own "everything arrived" path: every line counted in at the ordered quantity, stock applied, cost posted. It asks first and says both of those things, because it is not undoable from here |
| Per-line receive: short counts, damaged qty, tracking, invoice status | ➖ decided: desktop. It is a table of number inputs, and the sheet says so rather than pretending |
| New order wizard, suppliers, bills, reorder, price history, import | ➖ decided: desktop |
| Search / filter by month or store | ➖ |

`scripts/test_mobile_purchasing.js` — 40 assertions, 9 cases, including the
empty ledger, the failed load, and that the confirm asks before anything is
sent.

### Stock activity (`13-activity.js`)

Five rows hard-coded into `DB.activity` — "Organic carrots · Order RT-…047 ·
sold · −4" and four friends — overwritten by the live fetch only
`if (rows.length)`. A ledger is opened on the days you are *not* sure anything
moved, and on exactly those days it showed five movements that never happened.
It also threw away everything a ledger is for.

| Desktop capability | Phone |
|---|---|
| The rows are the server's | ❌ → ✅ — and a quiet range now says "Nothing moved in this range" |
| Time of the move | ❌ → ✅ — clock on a same-day window, month-day on a range, same rule |
| Channel it came through | ❌ → ✅ — including Meituan split per storefront (Tianhe / Yuexiu) |
| Store | ❌ → ✅ |
| Delta, and the **balance it left behind** | ❌ → ✅ — a zero balance is the only amber on this ledger |
| Who made a manual move, and the note | ❌ → ✅ |
| Date window: today / 7 days / 30 days | ❌ → ✅ — today is the default, which is what the endpoint defaults to |
| Channel tabs with event counts | ✅ — as chips. Counts come from the server's *unfiltered* summary, so they do not move when you switch channel |
| Caption: channel · events · out · in | ✅ |
| Digest "Hit zero" | ✅ |
| Digest "Big moves", crediting the person on a manual one | ✅ |
| Digest "By channel" | ➖ — the chips already carry every channel and its count, which is the same tally |
| Paging | ✅ — Show more, with how far in you are |
| CSV export | ➖ decided: desktop. It is a download, and a phone has nowhere to put it |
| Live 15s auto-refresh | ➖ — the desktop polls because the tab sits open all day |
| Free-text search, store filter | ➖ |

`scripts/test_mobile_activity.js` — 33 assertions, 8 cases.

### Categories (`catLoad`, `01-core.js`)

The phone was reading the wrong shelves. `/categories` is a **flat** list out of
the legacy `categories` table, counted over the legacy `store_products.category`
column. The shop does not run on that: the storefront renders a **two-level
tree** held in `storefront_config`, and every product is tagged with
`top_category` + `subcategory` from it. So the phone showed a different set of
shelves, with different counts, from the ones a shopper sees — and when the flat
list came back empty, six invented ones ("Fresh produce 24", "Bakery 12") that
were in neither scheme.

| Desktop capability | Phone |
|---|---|
| The shop's real tree | ❌ → ✅ — `/category-tree` + `/category-counts`, the pair the desktop editor reads |
| Top categories, and their subcategories | ❌ → ✅ — tap a top to drill in |
| Counts per node | ❌ → ✅ — and *published* vs total, which is the distinction that matters |
| **A shelf with products but none published is invisible in the shop** | ❌ → ✅ — named when there is one, counted when there are several, amber either way. A shelf with nothing on it reads "empty", which is a different thing and gets no amber |
| Status line: tops · subs · hidden shelves | ✅ |
| Rename / add / delete / drag to reorder, with autosave | ➖ decided: desktop. It is a drag-to-sort tree editor, and a rename migrates every product row that referenced the old name. The screen says so rather than offering a row that does nothing — which is what it used to do |
| Per-category product list | ➖ — the Products screen filters by category already |

`scripts/test_mobile_categories.js` — 24 assertions, 9 cases.

### Membership (`07-content-billing.js`, the tier cards)

| Desktop capability | Phone |
|---|---|
| The ladder is the shop's, from `roots_club.tiers` | ❌ → ✅ — the phone had a fixed four-rung ladder in its source |
| **A threshold is lifetime spend in ¥** | ❌ → ✅ — the phone read "≥ 2,000 pts". Wrong number *and* wrong unit |
| The bottom rung says everyone starts there | ✅ |
| Points multiplier per rung | ❌ → ✅ |
| Perks per rung, in the reading language | ❌ → ✅ — with "No perks yet" where there are none |
| Live member counts per rung (`/tier-counts`) | ✅ |
| Rungs in threshold order | ✅ |
| Add / rename / re-threshold / edit perks, with the key-stability and lowest-must-be-¥0 rules | ➖ decided: desktop |
| "Recent members" | ➖ removed — it was recent *signups* relabelled, and Customers already lists them |

### Top-up (`loadTopupTransactions`)

The screen led with **¥184,220 · 788 members** in 30px type. There is no
endpoint that returns either number; no fetch ever replaced them. And
`mapWallet` painted every row a green `+¥` with the label "Top-up" regardless
of `status`, so a pending or failed payment read as money in the till.

| Desktop capability | Phone |
|---|---|
| Invented balance headline | ❌ → removed |
| Transactions: when, who, phone, amount, bonus points, method | ✅ |
| **Status, and money coloured only when it is money** | ❌ → ✅ — Paid / Pending / Failed / Cancelled / Refunded; only a success is a green `+¥` |
| Pending work surfaced | ✅ — a line at the top counts what is waiting |
| **Mark a stuck top-up successful** | ✅ — `POST /topup-transactions/:id/finalize`. It credits a real wallet, so it asks first, names the amount and the bonus points, and says when to use it |
| Packages on offer, with their bonus | ✅ read-only — inactive ones are not shown, because they are not on offer |
| Create / price / activate a package | ➖ decided: desktop |
| `out_trade_no` | ➖ — a WeChat trace id is desktop support work |

### Leaderboard (`leaderboard.config`)

| Desktop capability | Phone |
|---|---|
| The board's title | ✅ |
| **Whether it is switched on at all** | ❌ → ✅ — the phone drew a board regardless. It now says Off, and that customers cannot see it |
| **The metric** — lifetime spend / points / orders | ❌ → ✅ — every value used to be labelled "pts". Money renders as money, orders as orders |
| The period, and top N | ✅ |
| Reveal mode | ✅ — the masked list is the one shown, and a note says that is what customers see |
| **Seeded placeholder entries** | ❌ → ✅ — amber, because customers are being shown invented names |
| Ranks, names, values | ✅ |
| Rewards copy, hidden-name list, editing the config | ➖ decided: desktop |

`scripts/test_mobile_club.js` — 46 assertions, 8 cases across all three.

### Voting (`10-extras.js`)

The phone drew one bar per poll: the leader's share and the leader's name.
A poll is a split — "62% · Leading: Matcha oat" says nothing about whether
second place was 38% or 4%, and the other options existed nowhere on the
device.

| Desktop capability | Phone |
|---|---|
| The polls are the server's | ❌ → ✅ — two invented ones sat in the source for whenever `/polls` came back empty |
| Status: Draft / Live / Closed | ✅ |
| **Every option, with its votes and its share** | ❌ → ✅ — tap "See results" |
| The winner, once one is chosen | ❌ → ✅ — sage bar, named as the winner |
| Options count, total votes | ✅ |
| Reward points | ❌ → ✅ |
| Closing time | ❌ → ✅ |
| Featured | ❌ → ✅ |
| A draft is invisible to customers | ❌ → ✅ — said on the card, before you open it |
| **`display_min_total`** — the floor customers are shown regardless of the real count | ❌ → ✅ — amber. An operator reading a poll needs to know the number on the shopper's screen is not the number in the ledger |
| Open / Close / Reopen | ✅ — one tap, reversible, so it does not ask |
| Write the question, options, colours, explainer, rewards; pick a winner; delete | ➖ decided: desktop |

`scripts/test_mobile_voting.js` — 25 assertions, 7 cases.

**With this, no screen on the phone renders invented content any more.**

Finishing the sweep turned up one last shape of the same bug, in the loaders
rather than the screens: four prefetches assigned only `if (rows.length)` —
coupons, flash sales, broadcasts and reviews. Every one of those screens
already had an honest empty state; none of them could ever reach it, because
an empty server answer left the sample rows in place. The mock outlived the
data it was standing in for, on exactly the shop least able to tell the
difference. They assign unconditionally now, and the Reviews tab got the empty
state it was missing.

The `DB` block is what remains: an offline fallback for the screens that have
one, every set overwritten by its fetch — including when that fetch says there
is nothing.

### Settings → Features (`02-settings-ops.js`, `lib/features.js`)

| Desktop capability | Phone |
|---|---|
| membership, affiliate, reviews, feedback, faq | ✅ |
| **socialProof** | ❌ → ✅ — decides whether shoppers see bought-counts, the recent-buyers ticker and the SOLD badge. Unreachable from a phone |
| **quickStock** | ❌ → ✅ — off means shop staff open `/stock` and get a closed screen |
| **kitchenAdd** | ❌ → ✅ — off means kitchen staff cannot log what they just made |
| The desktop's names | ✅ — "Referral program", not "Affiliate"; "Product reviews", not "Customer reviews" |
| **The entitlement ceiling** (`tenant.entitlements`) | ❌ → ✅ — a feature the tenant is not entitled to draws no switch, the same rule the desktop boots with. The phone would have written a preference nobody would ever honour |
| What turning one OFF does | ➕ — stated under the row while it is off. On a phone there is no hover, no help text and no second column, and "Quick Stock" alone does not tell you the staff app closes |

Two dead controls went with it: the store card was a button wired to `noop`
with a chevron on it, and the "Store profile" row drew a chevron and did
nothing. The card now opens the setup guide while setup is unfinished and is a
plain card once it is done; the row says where a profile is edited.

Also `state.sw` — a map that read like a feature-flag store (`membership`,
`affiliate`, `social`, `faq`, `feedback`, `autoprint`, `autoroute`, `lowstock`,
`popups`) and that nothing had looked at since those switches were wired to the
real config. Trimmed to the coupon switches it actually holds.

### Social proof

Was an honest "nothing about it can be read or changed from here" — which
stopped being true the moment its flag became reachable. It now states what the
flag is doing in shopper terms, with the switch on the card.

### Setup guide (`17-setup-guide.js`)

| Desktop capability | Phone |
|---|---|
| Progress over the five REQUIRED steps | ❌ → ✅ — the phone merged `steps` and `optional` into one list, so the two optional items counted against a percentage the server computes from the required five |
| Which step is next | ❌ → ✅ |
| Per-step detail the endpoint already returns | ❌ → ✅ — how many stores, how many products, which payment methods, delivery / pickup / both |
| Optional steps, marked optional and said not to gate opening | ❌ → ✅ |
| "Your store is open" once every required step is done | ✅ |
| Running any step | ➖ decided: desktop. Each one is a wizard — a store with an address, hours and a map pin; an Alipay QR upload; a delivery-or-pickup chooser; "open the doors". **Three controls used to pretend otherwise**: every step row was a button with a chevron wired to `noop`, and so was "Continue setup". They are gone, and the screen says where the work happens |

`scripts/test_mobile_settings.js` — 33 assertions, 9 cases across all three,
including that the step list contains no buttons at all.

### Delivery — the second sweep (`06-delivery.js`)

The phone said **Delivery zones · 7**. A bare total is the one number on that
screen that cannot go wrong, and it hides the one that can.

| Desktop capability | Phone |
|---|---|
| Zones **live**, not just total | ❌ → ✅ |
| Provinces covered | ❌ → ✅ |
| Same-day districts | ❌ → ✅ |
| **Zones switched off** | ❌ → ✅ — amber, and it says what it costs: an address inside an off zone does not match, so that customer is told you do not deliver there. This is the desktop KPI strip's only alert |
| **Holiday mode** | ❌ → ✅ — the switch that stops delivery altogether and puts a message in front of every shopper was not on the phone at all. It is now the first thing on the screen when it is on, in brick, quoting the message shoppers are being shown |
| Same-day cut-off | ❌ → ✅ |
| Stores located / missing coordinates | ✅ (already) |
| Turning holiday mode on or off | ➖ for now — same class of write as closing a sales channel: it stops orders. Added to §4 rather than decided here |
| Zone editor, fees, region picker, batch schedule, JD auto-print, box labels, bulk tracking | ➖ decided: desktop |

### The last dead control, and a guard for the class

`APP.cmd('noop')` is gone from the file, and so is the `noop` command itself.
It was the mechanism by which this app shipped controls that pretended: a row,
a chevron, a tap target, and nothing behind it — an operator taps and assumes
the screen is still loading. The last one was the Account row in the menu
sheet, which showed the *store's* name (not an account) behind a chevron that
went nowhere; it names whoever is signed in and goes to Settings, where Sign
out lives. `scripts/test_mobile_screens.js` now fails the build on any
reference to the name.

### Editor (`cms.html`)

This screen was a drawing. A grey wireframe of a phone, a hard-coded
**"Published"** pill, and four section names typed into the source — Hero
banner, Featured products, Categories, Flash sale strip — which a shop may or
may not have, in that or any other order. It told an operator their home page
was published without asking anything.

| Desktop capability | Phone |
|---|---|
| The live layout | ❌ → ✅ — `/cms/layout`, blocks in their real order, numbered |
| Block names | ❌ → ✅ — the composer's own `BLOCK_META` names, so the phone never invents a label for something placed under a different one |
| The title an operator wrote on a block | ➕ — it is how they will recognise which one it is |
| **Draft vs live** | ❌ → ✅ — the pill was hard-coded to "Published". When a saved draft does not match what shoppers see, it says so, names both block counts, and does **not** claim published |
| All five CMS pages | ❌ → ✅ — home, promotions, membership, categories, onboarding |
| Compose: add, drag, edit, publish, preview QR | ➖ decided: desktop. It is a drag-and-drop canvas |

`scripts/test_mobile_settings.js` now covers the whole operator group —
Settings, Setup, Social proof, Delivery, Editor — 63 assertions, 17 cases.

### Affiliate — the second sweep (`10-extras.js`)

The phone asked `/affiliate/referrals?pageSize=1` — the smallest page the
endpoint allows — read the summary off the envelope and discarded the rows. So
it had three numbers and no way to see a single referral. The rows ride the
same envelope as the summary; there was never a call being saved.

| Desktop capability | Phone |
|---|---|
| **The referral ledger** | ❌ → ✅ — referrer → friend, the code, the reward, when they joined |
| Status: Waiting for first order / Rewarded / **Still earning** / Voided | ❌ → ✅ — Still earning is its own state (the referrer is inside the lifetime-share window), in Dusk, as on the desktop |
| Why a referral was voided | ❌ → ✅ |
| Which order converted it | ❌ → ✅ |
| Filter by status | ❌ → ✅ |
| Friends joined, **against last month** | ❌ → ✅ — the phone had a bare total |
| First orders, **and the conversion rate** | ❌ → ✅ |
| Rewards paid, **including lifetime share** | ❌ → ✅ — the phone showed `paid_out` alone, which understates what the shop has actually paid out |
| Still earning | ❌ → ✅ |
| Referrals on/off | ✅ (already) |
| Adjust a reward, void, restore | ➖ decided: desktop — each is a money edit with a typed reason |
| Reward settings, lifetime rate and window, share image | ➖ decided: desktop |

### Operations (`02-settings-ops.js`)

Two toggles and a line saying "deeper config on desktop". Everything the
desktop's Operations panel exists to answer — is every store located, is the
maps key working, can customers pay by Alipay — was absent, and those are
exactly the questions you ask when you are away from your desk.

| Desktop capability | Phone |
|---|---|
| Auto-print receipts, fapiao auto-issue | ✅ (already) |
| **Manual Alipay** — on/off, and the payee name | ❌ → ✅. It is how customers pay when 当面付 is not available |
| Maps provider, and whether a key is configured | ❌ → ✅ |
| Stores geocoded | ✅ (was on Delivery) |
| **Customer addresses geocoded** | ❌ → ✅ — the phone only ever counted stores |
| **The geocoder's last error, and quota exhaustion** | ❌ → ✅ — brick. This is a silent failure: the key is still configured, nothing errors in front of a customer, and every new address quietly stops being locatable, so orders stop routing to the nearest store. The desktop shows it; the phone did not |
| Every store by name, with its city/district and whether it has coordinates | ❌ → ✅ read-only |
| Edit a store, assign stock staff, printer prefs per store, upload the Alipay QR, shipping integration keys | ➖ decided: desktop |

### Pop-ups (`05-marketing.js`)

The phone printed Live or Off from `enabled` alone — the same mistake the
coupon list used to make, with the same result. A pop-up scheduled to start in
December read **Live**. One whose end date passed in July read **Live**.

| Desktop capability | Phone |
|---|---|
| **Four states resolved from the dates** — Off / Starts *date* / Ended *date* / Live | ❌ → ✅ |
| How many are actually interrupting customers right now | ➕ |
| **Which pages it appears on** | ❌ → ✅ |
| **How often** — once / daily / once a session / every visit | ❌ → ✅ |
| **What its button opens** | ❌ → ✅ |
| The internal name leads the card | ❌ → ✅ — the phone led with the customer-facing title, which is not what an operator named it |
| Turn one on or off | ❌ → ✅ — and it stamps `updated_at`, because the mini app keys "seen" on `id + updated_at`. Without the bump, switching one back on would show it to nobody who had already dismissed it, and the switch would appear to work while doing nothing |
| Live phone preview of the pop-up | ➖ — the copy, pages, frequency and CTA are all on the card; a rendering of a rendering is desktop craft |
| Write, schedule, duplicate, delete, pick pages | ➖ decided: desktop |

### FAQ & help, and Legal (`07-content-billing.js`)

Both were already live and honest — what they dropped was shape.

| Desktop capability | Phone |
|---|---|
| Help is **two arrays** — `faq.categories` + `faq.questions`, each question carrying a `cat` — and the mini app's Help screen groups by them | ❌ → ✅. Thirty questions flat is a scroll; the same thirty under six headings is a page |
| Categories in the order the store put them | ✅ |
| A question whose category has been deleted | ➕ — still shown, under "Everything else". It is still visible to customers, so hiding it from the operator would be the wrong way round |
| Category colours, reordering, editing | ➖ decided: desktop |
| Terms / privacy, with their real published dates | ✅ (already) |
| **The document is clipped at 1,200 characters** | ➕ said. It always was, silently, so an operator could read a partial terms document believing it was the whole thing |

### The gzgrocery mirror (`12-guanyi.js`)

The daemon infers a pickup from a drop in gzgrocery's stock. A big or
suspicious drop is **capped** rather than applied, and waits for a person to
say whether it was a real sale. The phone read only `recent` — the drops
already applied automatically — so the answer to "is anything waiting on me"
was always no.

| Desktop capability | Phone |
|---|---|
| **The flagged queue** | ❌ → ✅ — with the numbers behind each one: what gzgrocery went from and to, the size of the drop, and what your own shelf says |
| **Apply** — it sold, take it off | ❌ → ✅ — asks first, because it lowers stock through the canonical path and the new number fans out to every other channel |
| **Ignore** — a glitch, leave it | ❌ → ✅ — asks first too, because it re-pushes your number back to gzgrocery to correct theirs |
| **The mode** — live / shadow / off | ❌ → ✅. "Shadow" means detecting and logging and changing nothing, so a list of pickups under it is a list of things that did **not** happen to your shelf. The phone stored the mode and never drew it |
| 24h applied events and units | ❌ → ✅ |
| Recent auto-applied pickups | ✅ (already) |
| Analytics, unpriced products, order-read config | ➖ decided: desktop |

### `APP.cmd` forwarded one argument

Found while wiring the queue above. The dispatcher was
`cmd:(n,a)=>CMD[n](a)` — a single argument — while two handlers took two. So
`APP.cmd('pollStatus', 7, 'closed')` arrived as `(7, undefined)`, the PUT body
became `{status: undefined}`, `JSON.stringify` dropped the key, the server saw
an empty patch and answered 200, and the phone reported **"Poll closed"**.

Voting's Open / Close / Reopen had never worked. Every assertion in
`test_mobile_voting.js` passed throughout, because they all read the card and
the card was right — the bug lived entirely in the request. The dispatcher is
variadic now, the sweep fails on any `APP.cmd` call site passing arguments it
cannot forward, and the voting probe stubs `fetch` and asserts the body.

### Reading the request, not the toast

`APP.cmd` taught something worth generalising: a write can report success and
send nothing, and no amount of reading the screen will find it. Three probes
now stub `fetch` and assert what actually goes over the wire:

| Write | What is pinned |
|---|---|
| Poll open / close | the body carries `status`, and is never `{}` |
| Pop-up on / off | the whole list goes, that pop-up is `enabled`, **its `updated_at` is stamped and the others' are not** |
| Flagged pickup Apply / Ignore | it posts to the endpoint it says it does, and never the other one |
| **Mark paid** | `status: paid` **and the tender that was picked** — the sheet promises "recording the tender keeps the day's takings split correctly", so a dropped `pay_method` would book an unknown tender under a green toast |
| Refund payout | the method the money actually went back by |
| Advance | the next status, never an empty patch |
| Cancelling a tender sheet | **no request at all** |

`scripts/test_mobile_orders.js` — 11 assertions, 5 cases.

### The Meituan mirror (`11-meituan.js`)

The phone showed the order ledger and nothing about the channel's health.

| Desktop capability | Phone |
|---|---|
| **A stuck stock queue** | ❌ → ✅ — the state worth naming. A queue mid-drain clears in seconds, so "107 sending…" and "107 stuck for 19 hours" are the same number on screen unless something reads how long the oldest push has waited. The desktop's own comment records a 19-hour stock freeze presenting as a normal tile. Same 30-minute line here, and it says what it costs: what Meituan shows is out of date |
| Failed pushes, scoped to the last day | ❌ → ✅ |
| A queue that is merely busy | ❌ → ✅ — reads "sending…", not an alarm |
| **The sync service being unreachable** | ❌ → ✅ — the answer to "why has nothing come in". Fetched separately from the orders, so a cached order list cannot mask it |
| Last order imported, products synced | ❌ → ✅ |
| Order ledger | ✅ (already) |
| Product matching, bundles, sync toggles, push-now, logs | ➖ decided: desktop |

### Share cards (`10-extras.js`)

Previously an honest "made on desktop" note — the fake share counts it replaced
deserved deleting. But designing a card and **checking** one are different
jobs, and the second is a phone job.

| Desktop capability | Phone |
|---|---|
| The four forwardable pages: home, product, voting, invite | ❌ → ✅ |
| **Set vs Default** per page, and the picture itself | ❌ → ✅. "Did the invite card ever get set" is a question with a picture for an answer |
| The custom title, or a note saying the page titles itself | ❌ → ✅ |
| What each card is for | ❌ → ✅ — the desktop's own blurbs |
| Upload a picture, write a title, live WeChat-chat preview | ➖ decided: desktop |

### Home — the third sweep

Two defects, neither of them a broken control, on the first screen the app
opens.

| Finding | Now |
|---|---|
| **The "Today" tile fell back to `¥12,840 · 37 orders · ¥347 · 1,204 visitors`** — four numbers typed into a mockup, under a heading that says *Today*. Any slow or failed `/dashboard` call put invented money in front of an operator, in the worst possible place for it | Removed. The tile keeps its four labels and shows `—` until the figure arrives |
| **Quick actions offered "Add product", "Create coupon", "Send broadcast"** — three verbs the phone cannot perform, each opening a read-only list. Not wired to `noop`, which is why they outlived that sweep, but they make the same promise and break it the same way | Replaced with three things the phone genuinely does in one tap: answer the inbox, tick a delivery in, fix a price or a count |
| `opsFires` read `o.<key>.items` inline, and arguments are evaluated before `add()` looks at its condition — so a `/dashboard/ops` payload missing any key threw mid-render. A render that throws leaves the *previous* screen on the glass, so Home would have looked stale rather than broken | Defensive, and pinned by a test |

The needs-you queue itself was already the ops snapshot and stays: delivery,
payment mismatch, payments to confirm, refunds, orders to start, awaiting
restock, invoices, stock — ranked brick before amber, then by how long the
oldest thing in each queue has waited.

`scripts/test_mobile_home.js` — 23 assertions, 6 cases, each fake figure
asserted absent by its own value.

### Orders and Customers — the mock outliving the fetch, again

Home's invented "Today" figures turned out to be one instance of a wider
pattern on the two busiest screens.

| Finding | Now |
|---|---|
| **`ordersFiltered()` was `state.ordersView \|\| DB.orders`** — the substitution was not in the catch block, it was on this line, at render time, on every paint where the live list was null: while loading, and permanently after a failed fetch. Five sample orders with real-looking numbers, tappable, with nothing on screen saying so | The list is the server's or it is empty |
| A failed orders fetch swapped in the sample set and called it honest because it suppressed the counts | Says it failed, reassures that the orders themselves are fine, and offers a retry |
| A failed customers fetch did the same with five sample customers | Same |
| **Every filter chip carried a fallback count typed into the source** — Pending 3, Paid 8, Preparing 6, Dispatched 11, Delivered 15, Mini app 28, All 47 — shown until the counts endpoint answered and forever if it did not. A badge on a chip is read as a fact about this shop | A badge is the server's number or it is not drawn. **Delivered** never had one: the endpoint has never sent that key, so it was 15 every time |
| `ordersStatusLine()` counted `DB.orders` when the live figure was missing, so a shop with nothing waiting read "2 waiting to ship" | Only the server's figure |
| `/products` assigned only `if (rows.length)`, so a shop with no catalogue kept the mock's six products | Assigns unconditionally |

`scripts/test_mobile_home.js` — 38 assertions, 10 cases.

### The sample data is gone

Rather than keep hunting the places where a mock outlived a fetch, the mock is
deleted. `DB` shipped 45 sample rows — five orders at ¥312 with customer names
and addresses, five products, three coupons, two flash sales, two broadcasts,
three reviews, two feedback threads, three invoices, five customers — and every
screen rendered them on first paint, before any fetch, and went on rendering
them wherever a loader assigned only `if (rows.length)`. `DB` is now nine empty
arrays: the runtime store and nothing else.

That closed the whole class in one move, and opened a smaller one in the other
direction: with an empty store and no way to tell *nothing yet* from *not asked
yet*, each of those screens said a confident "none" for the length of a fetch.
Four now carry a loaded flag — coupons, flash sales, broadcasts, the inbox —
joining the three that already had one. Each says "Loading…" until its own
answer arrives, and its empty state only after.

The tests carry their own rows now, which is where a test's fixtures belong.

### Products — the third sweep: the shapes with no stock of their own

The desktop catalogue treats three shapes differently, and for the same reason
each time: a number typed into their stock cell would mean nothing. The phone
drew a per-store stepper for all three, and the save would have written it
through the canonical inventory path.

| Shape | Desktop | Phone |
|---|---|---|
| **Supplier-direct** (`ship_from_supplier`) | An availability badge, never a count — it ships from the supplier, holds none of your stock, and never runs out | ❌ → ✅ read-only, and says why |
| **Paused supplier item** (`supplier_paused`) | Red badge: paused, not orderable | ❌ → ✅ — the phone showed it as **Live**, which is the one thing it is not. It is now Paused in the list and on the sheet, and never "Out", because it has no stock of ours to be out of |
| **Assembled bundle** (`is_bundle`) | The derived count, read-only — stock follows the parts | ❌ → ✅ |
| An ordinary product | Per-store count, editable | ✅ (unchanged) |

The save path carries the same rule as a belt, so a stepper value left over
from a previous product's sheet cannot be written to one of these.

`scripts/test_mobile_products.js` — 16 assertions, 5 cases.

## 3b. Looking at it

Everything above was found by reading the desktop and asserting on text. This
section is what a different method found: 339 screenshots — every screen, both
themes, both languages — read one at a time.

The tooling is `scripts/shoot_mobile.js` (the camera, which takes its case list
from the sweep so a screen cannot be photographed in a state the sweep never
renders) and `scripts/test_mobile_geometry.js` (five measurements at 390px).
Both matter, and neither substitutes for the other: measurements found nothing
this round — no overflow, no sub-11px type, no clipped text, no tap target on an
edge — while looking found twenty-odd real defects, none of which any assertion
on text could have failed on.

Two things about the camera are worth knowing before trusting a shot. Chrome
clamps `--window-size` to a 500px minimum, so a true 390px viewport needs the
app inside a 390px iframe pinned left. And Lucide is a CDN script this container
cannot reach, so for most of this pass **every icon was invisible** — `ic()`
emitted an empty `<svg>` of the right size. The geometry stayed honest; the
reading did not, and I chased a chevron-down dropdown and an overflow button as
bugs before working out they were holes. The camera stubs the icon set now.

### The dark theme was never given its own colours

The four `--*-tint` tokens were declared once, in `:root`, and never in the dark
block — so a Sage icon tile, an Amber count badge and a Brick warning banner all
kept their paper-coloured fill on a near-black page. Home drew seven cream slabs
down the side of "Needs you".

Twenty hardcoded `#5F7357` / `#8A6425` / `#B07E31` hexes had the same problem
from the other side: `#5F7357` on a `#182236` card is 2.6:1, so every "3
delivered", every amber warning and every success pill went nearly invisible the
moment the phone switched to dark.

Both are tokens now — `--sage-ink`, `--amber-ink`, `--brick-ink`, `--dusk-ink` —
carrying the values `public/stock.html` had already settled on, so the two phone
surfaces are one palette. Every text use of a hue became its ink (88 of them);
`--amber` and `--brick` are fills only. **A static guard fails the build when a
tint or ink is defined for one theme only, and when a hue is used as text on its
own tint** — the second half caught six more sites that were wrong in the LIGHT
theme too, Amber #C9954A on Amber-tint being 2.2:1.

The off toggle was `--border-strong`, which is Graphite: a near-black slab with a
white knob in it, reading as a second ON in a different colour.

### Dates arrived as columns and stayed that way

Purchasing printed four raw `YYYY-MM-DD`s, Pop-ups printed one twice — in the
pill and again three lines below it — and a flash sale starting today read
"12:00 PM · 12:00 PM–2:00 PM", because `fmtDay` collapses to a bare time when
the date is today. §1.18 says English reads Aug 16.

`_date` was itself inconsistent: a bare date parsed as UTC midnight while a
timestamp parsed as local, so a promised ship date sat on the wrong calendar day
for anyone west of Greenwich.

**The sweep reads the painted text of all 113 screens and fails on a
`\d{4}-\d{2}-\d{2}`.**

### Said twice

| Where | What it said twice |
|---|---|
| Coupons | The discount, once as the title (a fallback when the coupon has no name) and once as the fact |
| Coupons | "Applied for new signups" and "New signups", two pills a word apart |
| Invoices | The order number, as the headline and again as the subtitle — and none of the invoice title, tax ID or type the desktop leads with, so you could not tell whose invoice was waiting |
| Purchasing | "Late" in a pill and "· late" nine pixels below it |
| Order sheet | "Today · today" — the urgency pill echoing a date that now renders as a word |
| Pop-ups | "Ended 2026-07-01" in the pill, "2026-07-01" three lines down |

### One switch in three places

Auto-print receipts was in Settings → Automation, in Operations, and in Delivery
— where printing receipts has nothing to do with delivery zones. Flipping it in
one left the other two stale until the next render. Operations owns it, as the
desktop's printer settings do.

### The status line, on every page

The user's own note, on a screenshot of Orders: *"this line should be part of
the top bar under orders, same for every page I think it's the right thing"*.
§1.7 agrees. But `SUBS` had no way to declare one, so every pushed screen opened
with its summary as the first grey row of the BODY — indistinguishable from
content, and pushing the real content down a line. `SUBS` entries carry
`status()` now: Purchasing, Pop-ups, Categories, Editor, Top-up and Customers.

The Editor's case was the clearest: a published page's card held two facts and
nothing else — "3 blocks live" and a Published pill — which is a status line
wearing a card's clothes. Only an unpublished draft gets a card now, because
only it has something to explain.

### The rest

| Screen | What looking found |
|---|---|
| Home | The ops queue glued "oldest" onto a sentence: "oldest 1 couldn't be read" |
| Meituan | Empty state said "No pickups recorded yet" about a channel that has orders |
| Both mirrors | The read-only note sat stranded between two cards, appearing to annotate whichever one it landed under; the record list had no heading, so the first card read as an orphan |
| Inbox | A feedback thread put the bare word "Customer" on a line of its own, and clipped the report that opened the thread to one line at 80% opacity while a follow-up message got the emphasis |
| Order sheet | A missing address and a missing routing reason each rendered as a lone em dash on its own line |
| Purchasing | Both store names and both product names joined with a dot — the only two places in the app that did not resolve a bilingual pair by language |
| Top-up | The tender printed as the raw enum, `wechat`, long after the order sheet had learned to say WeChat |
| Customers | The sort control sat right-aligned and alone on an otherwise empty row, reading as a stray label rather than a control |
| Media, Customers, Order sheet | "1 images", "1 orders", "1 parcels" |

### A form that said Created and sent nothing

The create sheet — new coupon, new flash sale, new broadcast — had a submit
handler that read, in full:

```js
reg('submitCreate', ()=>{ state.createKind=null; showToast('Created'); });
```

It closed itself, said Created, and sent nothing anywhere. The only reason it
never lied to an operator is that **nothing in the file called
`APP.cmd('create')`** — the sheet could not be opened at all. That is not a safe
place to leave a form: the next person adds a "+" button and ships it. §4 has
already settled that authoring stays on the desktop, so the sheet has no
destination to be wired to. It is deleted, with all six of its commands.

`saveStock` was the same shape: a Receive stock button whose handler was one
`showToast`, reachable only through `isPO`, which no order mapper sets.
Receiving happens in `sheetPO` now, which asks first and PUTs. `qsInc`/`qsDec`
went too — Quick stock has counted in Products since the parity sweep.

**A static guard now fails the build on a registered command nothing can
reach.** It is the mirror of the `noop` check, and the more useful half: `noop`
catches a control wired to nothing, this catches a handler waiting for a
control. A command's name reaches its handler as a string, so the check is on
strings — a name that appears only at its own `reg()` has no way in, which
covers the template-built call sites too.

### Sales had never been looked at

`SUBS.sales` is assigned to the SUBS object *after* its literal — it moved there
when Customers and Products took the bottom nav — and both the sweep and the
camera discovered screens by matching keys **inside** the literal. So Sales was
never rendered by the sweep, never measured by the geometry check, never
photographed, and had no probe. Neither did the Inbox, which had explicit cases
written by hand and so looked covered.

Both harnesses match the assignment form too now, and the sweep counts 115
screens where it counted 113. `scripts/test_mobile_sales.js` is the screen's
first test — 15 assertions.

What the fixture was hiding, once the screen finally rendered: it sent `stores`
where `GET /channel-status` sends `cells`, so every card read "No stores", and
it listed three of the six channels in `GRID_CHANNELS`. And `loadChannels`
fetched `{channels, summary}` and kept only `channels` — so the day's total,
the one number this screen is opened for, was fetched and thrown away on every
open. It is the header's status line now.

### And the fake server, three more times

`scripts/lib/m-fakeserver.js` got another three column names wrong —
`retail_vouchers` is `type`/`value`/`min_subtotal`/`title_en`, the invoices route
returns `placed_at`/`invoice_issued_at`/`invoice_file_url`, and its counts are
`{requested, issued}`. Every coupon rendered "¥0 off" with no rule and no title;
every invoice date rendered as an em dash. Both looked exactly like the app
failing to map a row.

That is nine times now. The rule at the top of that file stands and is worth
restating: **copy the column name from the route's SELECT, never from what the
phone happens to read.** A fake server answering in the phone's own vocabulary
hides the bugs it exists to find, and — worse — invents ones that are not there.

## 4. Open questions

Not gaps — decisions that are the shop's to make, not this file's.

| Question | Why it is not decided here |
|---|---|
| Should the phone be able to open and close a sales channel? | It is the most phone-shaped write in the whole app — you are standing in a slammed kitchen and you want Meituan off — and also the heaviest, because it stops orders arriving. Reading the state is shipped; the switch is not. |
| Should the phone be able to turn holiday mode on? | Same class as the channel switch above: it stops delivery for everyone and puts a message in front of every shopper. Reading the state is shipped — it is now the loudest thing on the Delivery screen when it is on. |
| Should marking an off-app payment as paid move to the phone? | It records WHICH tender the money came in as. A phone that cannot ask would put "unknown" on the books, so it needs a tender chooser designed before it moves. |

Settled already, and recorded above rather than re-litigated: editing a ship-to
address stays on the desktop (seven fields with Chinese address matching behind
them); the staff note needs backend work before any surface can edit it;
line-level refund amounts stay on the desktop.
