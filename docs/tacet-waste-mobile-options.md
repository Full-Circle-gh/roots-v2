# Waste on a phone — three options, drawn to be chosen between

> **DECIDED 2026-09-02: OPTION A**, chosen by Ash from the three below. Built the same day
> in `public/m.html` — More → Operations gains a Waste row gated `waste:view`, opening the
> Worklist in §3's option A with the record sheet on its Dusk CTA. §6 records what shipped
> and the two things it deliberately leaves out. §§0–5 are kept unchanged, as the argument
> the decision was made on.

**Written 2026-09-02 as a design pass**, before anything was built: six artboards added to
`design-handoff/mobile-v2/` and the canvas re-seeded, so the choice could be made once, in
the open, rather than inherited from whichever option somebody started. It was answered the
same day — see the note above and §6 — and everything between here and §5 is left as it was
written, because a decision record whose losing options have been tidied away afterwards
cannot be re-checked.

---

## 0 — The one-paragraph answer

Waste is **not on the phone at all**. The string `waste` appears **zero times** in
`public/m.html` — no More row, no `ROUTE_CAP` entry, no screen function, no route. The
`warehouse` and `store_manager` presets **both already grant `waste:view` and
`waste:record`** (`lib/capabilities.js:380`, `:397`), so granting the permission to a
warehouse operator today changes nothing they can see on a phone, because there is no
screen there to gate. **This is a missing screen, not a permissions bug**, and no
permission change will fix it.

---

## 1 — What was verified

| Claim | Evidence |
|---|---|
| Waste ships on the desktop | `public/retail-admin/20-waste.js` (621 lines); tab wired at `public/retail-admin.html:1331`, section at `:11493` |
| The API is complete and phone-ready | `routes/retail-waste.js` — `GET /reasons`, `GET /products` (picker, with `on_hand`), `GET /preview`, `GET /` (list + totals), `POST /`, `POST /:id/void` |
| Desktop nav is capability-gated | `public/retail-admin/01-core.js:232` — `waste: 'waste:view'` |
| The three capabilities exist | `lib/capabilities.js:122-124` — `waste:view`, `waste:record`, `waste:void` |
| Warehouse holds two of them | `lib/capabilities.js:397` — `'waste:view', 'waste:record'`. **Not** `waste:void`: voiding removes a recorded loss from every total, so it stays with the owner |
| Store manager holds the same two | `lib/capabilities.js:380` |
| The phone has no waste anywhere | `grep -n waste public/m.html` → no matches |
| The phone does gate its nav | `public/m.html:7181` `ROUTE_CAP` + `canRoute()` at `:7216`; **a route with no entry is ungated**, so adding the screen also means adding `waste:'waste:view'` — otherwise it shows to everyone |
| The phone already carries write flows | `screenStockAdd` (`quickstock:add`) and `screenReceiving` (`purchasing:receive`) — a phone write flow is not a new idea here |

The account-level switch is also already read (`wasteEnabled()`, `routes/retail-waste.js:106`)
and has **no Settings UI yet**. Whichever option ships inherits the same `waste_disabled`
403 the desktop does, and should render it as the "switched off for the shop" state the
phone already uses for Add stock.

---

## 2 — What every option inherits, because the API already decided it

These are not open questions and should not be re-opened in the build:

1. **Whole units only.** A fractional quantity is refused (`qty_whole_units_required`) —
   the stock column is an integer and a waste row disagreeing with its own movement is a
   defect by design. So the quantity control is a stepper, not a free number field.
2. **Refuse, don't clamp.** More than on-hand is a `409` naming the figure we hold. So
   on-hand is shown **while choosing**, never at the refusal.
3. **The cost is a snapshot**, taken once, never recomputed. A product with no cost on file
   records as **"No cost"** — never `¥0.00`, never a dash. Zero and unknown must not look
   alike (§32 rule 10).
4. **The uncosted count travels with the total, always.** A total shown alone reads as
   complete, and the whole point of the flag is that sometimes it is not.
5. **Void is a reversal, never an edit or a delete.** Both rows stay visible; totals are
   always the live subset. `waste:void` is a separate capability neither warehouse nor
   store_manager holds, so on a phone the Void control is normally **absent, not disabled**.
6. **Seven reason codes**, served by `GET /waste/reasons`. Fixed this phase, not
   account-editable. `staff_consumption` and `sampling` are deliberately their own codes.
7. **`Other` requires a note**, enforced both client- and server-side.

And two design rules the desktop screen already settled, which hold on a phone:

- **No status line.** Nothing in a waste ledger is *waiting* on an operator — every row is
  finished business (§1.7's work rule).
- **No unseen surface.** A waste entry does not *arrive*; a colleague wrote it.

---

## 3 — The three options

Artboards: `design-handoff/mobile-v2/Waste*.dc.html`, batch four on the canvas.

### A — Its own More row, its own Worklist
`WasteMore` · `WasteList` · `WasteRecord` · `WasteEmpty`

More → Operations gains a **Waste** row after Receiving, gated `waste:view`. It opens an A1
Worklist: title, no status line, one Dusk **Record** CTA gated `waste:record`; the pulse as
one line; two chip rows (range, then reason); entries as cards; the record flow as a sheet.

The desktop's two date inputs become **three range chips** (Today · 7 days · 30 days). A
native date picker twice over, to ask "this week", is four taps and a keyboard for a
question with three usual answers. The range a preset cannot express stays on the desktop.

- **For:** the only option that answers *"what did we lose this month"* on a phone. Full
  parity with the desktop vocabulary, so nothing has to be re-learned. Reason and range
  filters both survive. Voided rows stay visible, greyed.
- **Against:** the largest build — a list screen, a filter pair and a sheet. One more row in
  a More list that is already long.

### B — A fourth sub-view under Products
`WasteSubview` (+ `WasteRecord`, `WasteEmpty`)

Products' strip becomes Catalogue · Stock activity · **Waste** · Categories. Waste *is* a
stock movement, so it sits beside Stock activity. Costs nothing in More and nothing in the
tab bar.

- **For:** conceptually right — the ledger belongs next to the other stock ledger. Cheapest
  in navigation.
- **Against, and it is heavy:**
  1. **The strip no longer fits.** Measured in Chromium at 390px: `Catalogue` 76 +
     `Stock activity` 102 + `Waste` 46 + `Categories` 81, three 24px gaps and 32px of
     gutter = **409px of content in a 390px screen**. Categories is clipped 8px past the
     edge with nothing to indicate more is there. Fixing it means a scrolling strip (a nav
     that hides its own last item), a shorter label, or dropping one — each a change to
     Products made to accommodate Waste.
  2. **The header's Dusk CTA changes with the sub-view** — empty on Catalogue, Dusk on
     Waste, under one unchanged title.
  3. **It reaches waste through `products:view`.** The API deliberately does not: the waste
     picker is gated on the waste capability *alone*, precisely because the kitchen screen's
     picker sat behind `products` and handed a waste-only operator an empty list with no
     error — hazard **H13** in `docs/tacet-waste-survey.md`, and `routes/retail-waste.js:25-30`
     says so in as many words. Nothing breaks today, since every preset granting waste also
     grants `products:view`. But this option makes true in the navigation the coupling the
     API was written to break.

### C — Capture-first: the form *is* the screen
`WasteCapture`

More → Operations gains **Record waste** — a verb, beside Add stock, which is the tool it is
actually a sibling of. The row lands on the form. Under it, **today at this store** and
nothing else. "All entries" is one line at the foot and opens the desktop screen.

Steppers are 56px, matching `screenStockAdd` — the same thumb, the same posture, the same
aisle. The search field collapses into the product card once one is picked; the card's ×
puts it back.

- **For:** smallest build, one screen. Matches the premise that on a phone the loss is in
  front of you and you are holding the jar. Reading a 30-day ledger is a desk job.
- **Against:** no range filter, no reason filter, no history past today, no void. If the
  phone must answer *"what did we lose this month"*, this is the wrong option.

---

## 4 — Recommendation

**A, with C's row label reconsidered later if the ledger goes unread.**

A is the only option that does not take something away, and it is the one that makes the
already-granted permission mean what it says. B's strip overflow is a measured fact rather
than a taste, and the `products:view` coupling walks back a fix the API made on purpose. C
is the cheapest and is genuinely closer to how a warehouse operator uses a phone — but it
answers a narrower question than the permission implies, and A's screen contains C's flow
anyway: if the ledger turns out to be unread, A's row can be relabelled and its list demoted
without rebuilding anything.

Whichever ships, **the `ROUTE_CAP` entry is not optional** (`waste:'waste:view'`), or the row
appears for every operator — the phone's map fails open on an unmapped route by design.

---

## 5 — Not decided here

- **Chinese.** Every string above is English. Source carries the pair, one language ships
  (§1.11); the phone bakes both through `T()`. The reason labels have Chinese in
  `routes/retail-waste.js` already; the rest needs the same pass the desktop screen took.
- **Dark theme.** A token swap, as everywhere else, and not drawn.
- **The Settings switch** for `features.waste`. The reader exists, the control does not,
  on either surface.
- **Material waste.** Refused by the API today, with a message saying why. Nothing on a
  phone should offer it.

## 6 — What shipped (2026-09-02)

Option A, in `public/m.html`. Four seams, and nothing else in the file moved:

| Seam | What was added |
|---|---|
| `ROUTE_CAP` | `waste:'waste:view'` — **not optional**: an unmapped route fails open by design, so without this the row shows to every operator |
| `MORE_GROUPS` | `['waste','trash-2','Waste','损耗']` in Operations, after Receiving |
| `SUBS.waste` | Title, no status line, and a `cta` that renders only for `mCan('waste:record')` |
| `state.wst` | One namespaced object, `qs`-style — the ledger half persists, the form half is reset by `wasteNew` on every open |

The screen is `screenWaste()` and the record flow is `sheetWaste()`, both beside Stock
activity in the file — waste is the other stock ledger and reads next to it.

**Two deliberate omissions**, both drawn that way in the artboards:

1. **No void.** It is `waste:void`, which neither `warehouse` nor `store_manager` holds — a
   control almost nobody standing in an aisle can press. Voided entries and their reversals
   still **list**, greyed and labelled: a ledger that hides its own corrections is how one
   goes unnoticed, and that is as true on a phone as on a desk. Voiding stays on the desktop.
2. **No free date range.** Three range chips (Today · 7 days · 30 days) on the same
   Guangzhou day boundary Stock activity uses, instead of two native date pickers. The range
   a preset cannot express stays on the desktop.

**Proof:** `scripts/test_mobile_waste.js` — 75 assertions across 26 cases, wired into
`npm run test:mobile`. It holds the API's rules on the surface most likely to forget them:
cents divided exactly once, `No cost` never rendering as `¥0.00`, the uncosted count
travelling with the total, empty/no-results/failed as three separate states, every refusal
named before it is sent, and `waste:record` gating the button while `waste:view` gates the
screen.

## 7 — Cost is not for every role (2026-09-02, after first contact)

**Ash, on seeing it live: a warehouse or store operator recording waste must not see what
it cost.** They record what spoiled; what the business lost by it is not their line to read.

The screen now runs every money figure through `wstShowMoney()`, which is the app's
existing gate — `recapNoMoney()`, i.e. `RECAP_NO_MONEY = ['warehouse','dispatch',
'customer_service']` — and not a new concept. **Five surfaces carry a figure and all five
are gated**, because a gate applied to four is not a gate:

1. the pulse total, 2. the uncosted count that travels with it, 3. each row's cost cell,
4. the record sheet's cost preview, and 5. **the toast after a save** — the one that gets
forgotten, because the screen behind it can be perfect and the toast still announces the
number.

A money-blind operator is not left with a blanked-out screen. The pulse counts entries
instead of yuan, the rows keep what and why and when, and the sheet still says
*"Stock drops to 14"* — the half of the consequence that is theirs, and the more useful
half to somebody standing in front of the shelf. `No cost` is withheld **with** the
figures: it is a statement about that product's costing, which is the same ledger.

### Answered the same day — `waste:costs` (2026-09-02)

**Ash: who may see the cost is the admin's decision, per person — not a role list
in a phone build.** The gate below shipped first as `recapNoMoney()`; it is now a
capability, and the role list is gone.

| | |
|---|---|
| **`waste:view`** | Opens the ledger. **No money marker any more.** What was lost, how many, why, where, when. |
| **`waste:costs`** | Reads the money in it. Carries `money: 'shows'` and the note that was on `waste:view`. |

**Preset matrix after the split** (verified in `test_tenant_roles.js`):

| Role | view | costs | record | void |
|---|---|---|---|---|
| owner · admin · manager | ✓ | ✓ | ✓ | ✓ |
| store_manager · warehouse | ✓ | — | ✓ | — |
| staff · customer_service · dispatch | — | — | — | — |

**Existing tenants.** `resolveCaps` lets a stored role record win over the shipped
preset, so a custom-edited role's list is frozen — a new key is simply absent from
it and lands **off**. That is the safe direction and the one chosen: nothing is
silently granted money. Owners are unaffected (`owner` always resolves to every
capability). The cost is that an owner-defined custom role which *should* read waste
cost needs it ticked once in the permission matrix, where it now appears
automatically — `backend-team.js` serves the whole registry, so no UI work was
needed.

**Enforced on the wire, not just on the screens.** A screen that hides a number it
was sent is a screen, not a permission — the figure is still in the JSON. So
`routes/retail-waste.js` does not *send* a cost to a caller without the capability,
across all six responses that can carry one: the ledger's rows, its totals, the
picker's `unit_cost` (which neither client renders and both were sent anyway), the
preview, the record response, and the void response. Keys are **deleted**, not
zeroed — a null cost beside `is_uncosted` would render as "No cost", a claim we are
not making — and `costs_hidden: true` on the envelope tells a client the difference
between withheld and absent.

**It fails closed**, alone among the cap checks in this product. Everywhere else a
null cap set means "unknown, allow", because an operator locked out of their own app
by a resolution hiccup is worse than one shown a control they cannot use. Money
inverts the trade: a figure missing for one render is recoverable; a figure shown to
someone who may not read one is not. `01-core.js` already said as much — *"do NOT
gate anything that leaks money/PII on caps alone without a reliable fallback"* — and
the server strip is that fallback.

**Both clients gate their own layout too**, which is not redundancy: it is what keeps
the desktop's Cost column from becoming an empty gap under a "Cost" header (the
column, its `<col>` and its cells are removed, with a second set of widths that sum
to 100), and the phone's row from leaving a hole. Where the two disagree, the payload
wins — every reader handles an absent figure rather than trusting the gate to have
hidden it.

**Proof:** `scripts/test_waste_cost_visibility.js` — 36 assertions on the wire, one
section per response shape plus the fail-closed rule. Client halves in
`test_mobile_waste.js` (79 assertions), preset matrix in `test_tenant_roles.js`.

### The open question this exposed

`lib/capabilities.js` marked **`waste:view` itself `money: 'shows'`** — *"Waste is
totalled in money."* That is why the cost reached a warehouse phone in the first
place. The marker has moved to `waste:costs` and the note with it, so the registry
now says what is true.

**`store_manager` is settled by the same change.** It holds `waste:view` and
`waste:record` and **not** `waste:costs`, which is what Ash asked for — "warehouse
and store employee that dealing with waste shouldn't see cost there". This does not
touch the separate, still-standing decision that a store manager sees *revenue*
(dashboard pulse and Reports): that is their own store's takings, which is their
business. What they lose is the cost of a loss, which is the company's margin.

**Materials: done, 2026-09-03.** `materials:costs`, the same shape as
`waste:costs` and for the same reason — the Materials list carries two money
columns (Buy price, Cost per unit), so the warehouse and store_manager presets
read what every supplier charges and the cost basis of every margin. The same
warehouse operator had just been stopped from seeing what a dropped jar cost;
leaving them every ingredient's buy price was the same fact by another door.

Four read payloads carry money on that API and all four are stripped: the list
rows, the record, its price history, and the PO lines it arrived on. Two things
were worth more than the disclosure fix:

- **A write hazard that was data loss, not privacy.** The editor omits the Buy
  price field for a cost-blind operator, `readBody()` turns an absent field into
  `0`, and the UPDATE wrote it unconditionally — so *renaming* a material would
  have wiped its price, written a price-history row recording the wipe, and
  fired a >5% change alert. The server now carries the stored price through.
- **`sect('materials')` in the warehouse preset.** It means "every verb in this
  section", so the moment the new key existed it would have handed that role
  every buy price straight back — as a side effect of the change made to take
  them away. Now listed explicitly, with a test asserting no preset expands the
  section blindly.

`materials:edit` **keeps** its `money: 'moves'` marker, and that is not an
oversight: cost per unit is derived from the buy price **and the pack size**, so
an editor without `materials:costs` still moves every margin by halving a
recorded pack.

Proof: `scripts/test_material_cost_visibility.js` — 34 assertions, four read
sections plus the write and the fail-closed rule.

**Products: done, 2026-09-03** (Ash: *"do products"*). `products:costs`, the third
and widest of the three, and the one the other two were rehearsal for.
`products:view` carried `money: 'shows'` with the note *"The product list shows
unit cost and margin"*, and **five presets hold it** — including `staff`,
commented in `lib/capabilities.js` as having "no money-sensitive powers", and
`marketing`, "no operations/money". Both read a margin **percentage** on every
row of the catalogue.

**The design question first, as the note above said to.** `products:edit` has to
*set* a cost, so this was never a simple hide. The answer: **the two are
separate, and a store manager keeps the edit.** They set what customers are
charged for their store; they do it without seeing what we paid. Pricing is
their job, the cost basis is not — so `store_manager` and `warehouse` keep
`products:edit` and lose `products:costs`.

| Role | view | costs | edit |
|---|---|---|---|
| owner · admin · manager | ✓ | ✓ | ✓ |
| store_manager · warehouse | ✓ | — | ✓ |
| staff · marketing | ✓ | — | — |

**Sell price is not what moves.** What a customer is charged is on the
storefront; withholding it would break the catalogue for no gain. What goes is
`unit_cost` — what we pay — the margin derived from it, and `cost_incomplete`,
which travels with the figure because it is a statement *about* that figure.

**A module, where the other two are inline.** `routes/retail-waste.js` and
`routes/retail-materials.js` each keep the three functions inside the route,
because each is small enough for a test to mount on a bare express app.
`routes/retail.js` is ~32,000 lines with the whole product surface in it and
cannot be stood up that way, so the rules live in
`lib/product-cost-visibility.js` and are held to the same contract there. The
route requires it; nothing re-implements it.

Four read payloads stripped — the grid, the record, the post-save row, and the
**CSV export**, which drops the Unit cost column and the bundle roll-up that
fills it rather than exporting a blank one.

**And the same write hazard, a third time.** The editor hides the Cost field,
its `g()` helper returns `''` for a missing element, and `''` is parsed to NULL
on the way in — so editing a product's **name** would have wiped its cost,
blanked the margin everywhere it is read, and cleared the `cost_incomplete` tag
with it. `stripProductCostWrites` deletes the keys, and every branch that writes
a cost is already guarded by `'unit_cost' in body`, so "absent" means "not
touched" through the contract that was already there.

**The grid re-lays out rather than leaving a gap.** The Margin column, its
`<col>` and its cells are removed together, and `[data-nocost]` carries a second
set of name-column widths. Measured in Chromium, not added up: the Product
column goes 292px → 473px, absorbing the 181px Margin column exactly, at every
one of the five breakpoints and in reorder mode.

Proof: `scripts/test_product_cost_visibility.js` — 36 assertions. Two client
tests moved with it: `test_role_editor_client.js` (a fixture asserted
`products:view` shows money) and `test_cost_incomplete_flag.js` (its sandbox had
no `CAPS`, so the fail-closed helper correctly dropped the field).

**Still open — `recipes:view`, and it should be left alone.** No preset outside
owner/admin/manager grants it, so splitting it adds a permission nobody would
untick on a screen no floor role can open. Revisit only if a preset ever hands
recipes to a floor role.
