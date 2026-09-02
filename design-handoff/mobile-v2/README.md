# Tacet mobile — batch one

The phone shell, Home (A6 Digest) and Orders (A1 Worklist), re-derived from
`docs/tacet-desktop-patterns.md` v4.6 and `docs/tacet-design-system.md` v1.3
rather than patched from the current phone build — the rulebook's own
instruction for mobile v2 (§9, "Mobile alignment").

Published canvas: https://claude.ai/code/artifact/59dd60e2-cf68-457a-b329-5e96da49d46a

## What is here

| File | Artboard |
|---|---|
| `Shell.dc.html` | Topbar + bottom nav — the chrome all 34 pages inherit |
| `Main.dc.html` | Home — The Recap → Needs you → Today |
| `Orders.dc.html` | Orders list — chips, order cards, unseen treatment |
| `OrderSheet.dc.html` | The order drawer as a phone sheet, header pinned |
| `MoreSheet.dc.html` | More — flat, grouped, no drill-down |
| `OrdersLoading/Empty/NoResults.dc.html` | Three of the six states |
| `WriteStates.dc.html` | In flight · error · silent refresh |
| `Customers.dc.html` | Customers — segments, tier chips, unopened records |
| `CustomerSheet.dc.html` | The customer record as a sheet: snapshot + accordions |
| `CustomersFiltered.dc.html` | "Found — but your filters are hiding her" |
| `Products.dc.html` | Catalogue — sub-view strip, stock states |
| `StockActivity.dc.html` | Stock activity — the second sub-view |
| `ProductSheet.dc.html` | The product record, with the hybrid's one door |
| `Inbox.dc.html` · `Reply.dc.html` · `InboxEmpty.dc.html` | Inbox — two Worklists behind one strip, and its one write flow |
| `Delivery.dc.html` | Delivery — A4 Console |
| `Sales.dc.html` · `ChannelDetail.dc.html` | Sales — A5 Board, and the marketplace pattern |
| `WasteMore.dc.html` | Where Waste lands in More — the A-vs-C argument, one row apart |
| `WasteList.dc.html` · `WasteRecord.dc.html` · `WasteEmpty.dc.html` | Waste option A — its own Worklist, its record sheet, its empty state |
| `WasteSubview.dc.html` | Waste option B — a fourth sub-view under Products |
| `WasteCapture.dc.html` | Waste option C — capture-first, the form is the screen |
| `canvas.json` | Layout, notes, launch view |

## Rebuilding

Artboards are generated, not hand-edited — edit `src/` and run:

```
node src/pages-1.mjs && node src/pages-2.mjs && node src/pages-3.mjs \
  && node src/pages-4.mjs && node src/pages-5.mjs && node src/pages-6.mjs \
  && node src/pages-7.mjs
```

`src/_shared.css` holds the tokens (lifted verbatim from the live `--td-*`
block) and every shared component; `src/build.mjs` holds the icon set, the
mark, the topbar and the bottom nav.

Then re-seed and republish the canvas with the `/design` skill's helper,
passing every artboard and `canvas.json`, and publish to the URL above.

## Decisions this batch settles

- **The header contract holds on a phone.** Title · status line · one Dusk
  CTA — so Orders' `New order` sits in the header and the floating button in
  the current prototype goes. A floating circle is not in the system.
- **A Worklist row becomes a card**, keeping every load-bearing column
  (channel, id, time, customer, ship-to, ship-by, status).
- **The unseen record replaces the "NEW" pill** on the phone as it did on
  desktop: `--td-unseen` surface + `inset 4px 0 0 --td-sage`, settling to
  Paper over 600ms. Inset shadow, never a border — a marker that resizes its
  row makes the list jump.
- **The drawer becomes a bottom sheet** and keeps §1.13a rule 4: two pinned
  rows, one status pill, and an action row rationed to three controls at this
  width — state action, the workhorse (Print receipt) holding the right edge,
  and `⋯`. Actions are Secondary; the sheet inherits the page's Dusk budget.
- **Chrome spends zero Dusk.** Unseen is one 6px Sage dot in both the topbar
  and the bottom nav — never a count, never red (the live phone nav ships
  `#dc2626` count badges today).
- **The phone's Today is a line, not a tile grid** — the A1 pulse rule's
  "tiles or a line" applied to a 390px screen.
- **No drill-down in More.** A five-item bar and a fourteen-row rail are
  different problems; More is one flat, grouped list.

## Decisions batch two settles

- **Customers keeps the title alone.** 693 records, none waiting on anyone —
  §1.7's work rule, with Customers as its reference case. The pulse takes its
  line render instead of tiles: four tiles cannot share a 390px row, and two
  of them would be an arbitrary subset.
- **Tier pills are neutral.** A tier is a fact about the customer, not a state
  needing attention; Sage and Amber are not spent on it. Blocked keeps Brick.
  Tiers are Tree · Root · Sprout · Seed, from `CU_TIER_LABEL`.
- **The unseen surface is for records that arrive** — Orders and Customers,
  one shared `seen_at`, meaning "nobody on this team has opened this". It never
  appears on Products, which the merchant authored.
- **Products carries the sub-view strip** under the header — Catalogue · Stock
  activity · Categories, Ink underline on the live one — and no status line:
  the chips already say running low and out of stock.
- **The product sheet is the hybrid**, with exactly one extra control (Open
  full page). Nothing else about it differs from the order sheet.

## Shipped

Batch one and two are implemented in `public/m.html` — the phone build
`server.js:625` serves to any mobile browser opening the backend. Four things
changed on contact with the product, and the artboards were updated to match:

| Design said | Ships as | Why |
|---|---|---|
| Orders header CTA "New order" | Empty Dusk slot | No create flow on a phone; §1.7 says the empty slot is the finished answer |
| Products header CTA "Add product" | Empty Dusk slot | Same — the catalogue is authored on desktop |
| Tier chips with counts | Tier chips, no counts | No endpoint returns them |
| Customer record with an action row | Read-only record | None of the write flows (points, wallet, block) exist here yet |

Also folded in while the shell was open: the last uppercase labels, the Dusk
setup meter (a progress bar is not an automation), the drawer's Dusk primary
(a drawer inherits the page's budget), and 24-hour English times.

## Decisions batch three settles

- **Inbox states the work once.** The status line carries "2 reviews need a
  reply", so the pulse slot stays empty rather than saying it twice. A review
  arrives, so an unopened one wears the unseen surface; "Replied" stays a pill,
  because that is a state the operator put it in.
- **Send reply is Secondary.** Writing a reply is the operator acting, and Dusk
  means one thing. Do not correct it to a Dusk button.
- **Delivery has no master switch**, because delivery cannot be turned off.
  Holiday mode sits in Timing with its consequence in words, which is what the
  master-switch rule is actually asking for. No Dusk anywhere on a Console —
  except the automation row's breathing dot, which reports rather than asks.
- **The Board carries no summary banner.** Five cards, one dot each: a banner
  saying "everything is in sync" is a fourth copy of what the dots say. Eleme
  keeps its slot while disconnected — an absent channel is information.
- **Invoices is not a page.** §4 absorbs fapiao into Orders as a filter; the
  phone's current Invoices screen is a leftover to fold in, not a page to design.

## Batch four asks a question rather than settling one

Waste, and it is the first batch drawn as **options to choose between** rather than as one
answer. The full argument, the evidence and a recommendation are in
`docs/tacet-waste-mobile-options.md`.

The finding behind it: **Waste is not on the phone at all.** `waste` appears zero times in
`public/m.html` — no More row, no `ROUTE_CAP` entry, no screen — while the `warehouse` and
`store_manager` presets both grant `waste:view` and `waste:record` by default. Granting the
permission today changes nothing a phone can see. A missing screen, not a permissions bug.

- **A** — its own More row and its own Worklist. Desktop parity, and the only option that
  answers "what did we lose this month" on a phone.
- **B** — a fourth sub-view under Products. Conceptually right (waste *is* a stock
  movement), but the strip overflows at 390px — measured 409px of content, Categories
  clipped — and it reaches waste through `products:view`, which is the coupling
  `routes/retail-waste.js` was written to break (survey hazard H13).
- **C** — capture-first: the form is the screen, today's entries under it, the ledger left
  on the desktop. Smallest build; gives up range, reason, history and void.

Everything all three inherit from the API — whole units, refuse-don't-clamp, the cost
snapshot, "No cost" never rendering as ¥0.00, void-by-reversal — is listed in the doc so the
build does not re-open it.

## Known gaps (batch five)

The customer record's action row waits on the phone write flows; dark theme is
specified as a token swap but not drawn; Chinese is not rendered
anywhere here (source carries the pair, one language ships — §1.11); Customers
and Products own the six states by inheritance from Orders but only two of
theirs are drawn; the co-brand slot has no merchant artwork in this account,
so it is drawn empty per §8b.
