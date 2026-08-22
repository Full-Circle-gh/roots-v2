# Tacet mobile — parity with the desktop admin

**Audit, 2026-08-22, from source.** Read `public/m.html` (the phone build
`server.js:625` serves to every mobile browser) against the desktop modules
under `public/retail-admin/`. Every row below carries a file reference; nothing
here is inferred from a screenshot.

> **The finding, in one line: the phone is a monitoring app whose write
> controls are mockups.** Nine controls looked like they did something and
> wrote nothing. The order controls were fixed on 2026-08-22 (`9f84247`); the
> rest are listed here with what each would take.

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

### Media library (`07-content-billing.js`)

| Desktop capability | Phone |
|---|---|
| Browse the library | ✅ — `GET /media/list` |
| Add photos | ✅ — camera or roll, straight to `POST /media/upload`, the one thing the phone can do that the desktop cannot |
| Folders, tags, alt text, rename, delete, bulk move | ➖ — cataloguing work, and it says so |

### Sales, Delivery, Settings

| Desktop capability | Phone |
|---|---|
| Channel board with live status | ✅ |
| Channel detail (mirror + config) | ✅ read-only |
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

Nothing above needs a new endpoint. Every one of them needs the same three
states the rulebook already requires and the order actions now demonstrate:
the control disables and says what it is doing, a refusal renders where the
operator is looking and stays, and a toast confirms but never reports failure.
