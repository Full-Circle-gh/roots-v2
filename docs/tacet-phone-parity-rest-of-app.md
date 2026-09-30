# Phone parity — the rest of the app (survey, 2026-10-01)

Read-only survey against `main` at `efa8740e`, by function and endpoint name.
Recipes, purchasing and finance were done under §300 (§301–§324) and are not
repeated here. Rule in force: §97 — the phone has the same capabilities as the
PC, not the same layout. Decision recording this plan: §325.

## Where each section stands

| Section | Phone today | What is missing |
|---|---|---|
| **Orders** | Nearly all daily work (status, cancel, refunds full/by amount, tracking, combine/split, photos, 发票) | Refund safeguards (amount/lines/points/note on approve, reject reason, "reviewing", payout reference/amount/store credit, refund by items, refund history); parcel recovery; supplier parcel delivered; rider/JD method; item-level split and the "save ¥X" suggestion; Qingyun rider operations; ship-to edit and "make address Chinese"; retell the customer; Alipay OCR re-run; reprint at a chosen store; pay-link tile and other order facts; missing status chips; CSV export; saved views; bulk status and bulk tracking; order drafts; the by-phone customer warning |
| **Customers** | At parity except below | Print statement; reset test account; "found but filtered out"; diagnostics detail |
| **Delivery** | Read-only summary + Resume | Holiday ON with its message; zones (on/off, add, edit, delete); default zone; fees and minimum order; same-day cut-off; kitchen address; pickup hours; pre-order wording; fresh-batch schedule; box label / bulk tracking switches; setup wizard |
| **Products** | Price, per-store stock, out-of-stock policy, pause | Every other field; description; photos; sizes; customer choices; bundles; new product; duplicate; delete; version history; sales panel; bulk edits; CSV export; list filters; product page designer; product page layout |
| **Categories** | Banner editing | Add, rename, delete, reorder; QR menu order; shelf product order and move |
| **Stock / waste** | Add stock, activity, waste record | Two recount answers; activity dates/search/CSV; waste void; waste date range |
| **Shop menus** | Nothing | Read, daily edits (on/off, price, add, remove), structure (create, rename, move) |
| **Channels** | Status, open/close per shop, push, Meituan and gzgrocery mirrors | Eleme screen; catalogue refresh / push-all / auto-match; product matching; Meituan bundles; sync start time; turn a channel on/off; close a channel everywhere; per-item sync (§124); channel-hub setup wizards |
| **Marketing** | Broadcasts, coupon on/off, flash-sale list, pop-up on/off | Coupons (create, edit, grant, take back); flash sales (create, edit, end); pop-up editor; broadcast "send again" and all regions; mini-app wording; social proof settings; share cards |
| **Loyalty** | Points / wallet adjust, top-up confirm | Membership tiers; points rules; top-up packages; affiliate settings, void/restore, chooser list |
| **Content** | Media upload, read-only FAQ/legal/about | FAQ, legal, about editing; media library (folders, search, details, move, tag, delete); reviews settings and tidy-up; voting poll editor; leaderboard settings |
| **Page editor** | `cms-mobile.html` exists | A door from the phone app; pictures, video, buttons/links; block pickers (product, category, coupon, poll, store); sizes; where a block shows; onboarding settings |
| **Settings** | Account, Team, a few switches | Store add/edit and per-store staff; printers; courier and printer keys; Qingyun request / auto-push; three missing feature switches; low-stock default and digest; recycle bin; change history; "what was sent"; tax; currency; Alipay manual QR; WeCom/SMS/alerts; customer service button; shop display; brand and brand studio; SKU code rules; team devices (§112) |
| **Dashboard** | Recap, needs-you, today | Needs-a-point and parcels-to-recover rows; "browsing now"; store lock on the needs-you counts |
| **Billing** | Nothing | Choose plan, checkout, invoices |

Not gaps (desktop mechanics): keyboard shortcuts, saved table views of the
desktop grid are covered by Orders "saved views", desktop install prompt,
dashboard card arranging, settings search, `store-admin.html` (platform back
office, not a shop page).

## Live defects found — fixed first

1. **A permission refusal logs the operator out.** `api()` / `apiWrite()` in
   `m.html` treat every 403 as a lost session. With permissions on, a refused
   tap sends a shift worker to the login page.
2. **Buttons drawn for people who cannot use them**: order actions and refunds,
   product save/switches, coupon switch, inbox moderation, media upload,
   broadcast cancel.
3. **Anyone signed in can change any setting on the server**: `PUT /config`
   (holiday, fees, tax, tiers, points rules, pop-ups, legal), `/polls`,
   `/voting/config`, `/leaderboard/config`, `/topup-packages`,
   `/topup-transactions/:id/finalize` (credits a wallet), `/affiliate/*`,
   `/cms/*` including publish. Flash-sale keys (`flash:*`) gate nothing.
4. **The dashboard endpoint ignores the store.** Desktop store picker and lock,
   and the phone Trend store picker (§317), show every store's figures while
   naming one. §317's "closes a leak" claim was wrong.
5. **Home ignores the store lock** on the needs-you counts.
6. **Reopening a channel at a shop skips the desktop's stock-publish check.**
7. **Approve refund on the phone leaves out the rider warning** (§222).
8. **Points adjust rounds silently** (`parseInt`).
9. **Out-of-stock policy changes one size, not the family.**
10. **A below-zero shelf cannot be corrected from the phone** (recount refusals unanswered).
11. **Category banner save can undo desktop edits** (`PUT /category-tree` has no version check; a reverted rename re-tags products). Same for the pop-up switch (`popups.list`).
12. **Resume delivery skips version history.**
13. **Legal and FAQ share one "open item" state**; stale "on desktop" notes (Invoices, Editor, Operations, Setup).
14. Desktop: bulk "Mark dispatched" skips the early-dispatch warning; removing a shop listing has no confirm.

## Holds that need Ash (§325 records the answers)

- §63: coupons and flash sales stay on desktop.
- Holiday ON, close a channel everywhere, turn Meituan/Eleme off, online-store
  open/close from the phone.
- §124: per-item channel sync switch and matching repairs.
- §116: print customer statement; reset test account.
- §112: team devices.
- Product spreadsheet import (§300.4 precedent says no); product page designer
  (needs a phone design).
- §97 exceptions: courier map, Qingyun point picker, JD label printer; plus the
  box-label printer.
- Billing on the phone.
- §302.7: receive-only account marking a draft Delivered.

## Build order

Safety first (no decision needed), then reads, then writes, riskiest last.
One PR per step, each write asserted on the request, every desktop confirm
carried over.

- **S1 phone safety**: defects 1, 2, 5, 6, 7, 8, 9, 10, 12, 13.
- **S2 server safety**: defect 3 (each write gated on the key that opens the
  desktop screen that makes it — nobody who can use that screen today loses
  it), defect 4, defect 11 (version checks).
- Then by area, four lanes in parallel: Orders & Customers & Delivery;
  Products & Categories & Stock & Shop menus; Marketing & Loyalty & Content &
  Page editor; Settings & Channels & Dashboard & Billing.
