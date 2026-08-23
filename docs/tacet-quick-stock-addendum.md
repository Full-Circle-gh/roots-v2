# Tacet — Quick stock addendum, 2026-08-23

> **What this records:** `public/stock.html` — the phone PWA shop staff use to
> count shelves — rebuilt against `docs/tacet-design-system.md` v1.3 and
> `docs/tacet-desktop-patterns.md` v4.6. It was the last surface still wearing
> the pre-rebrand skin: lime `#ccd900` on charcoal `#16161a`, 800-weight type,
> four radii, red-and-green steppers. It is now a Tacet surface, and it says so
> in the chrome.
>
> Built from the rulebook, not patched from the old page — §9's instruction for
> mobile. `public/m.html` (the shipped phone build) is the sibling this page is
> kept 1:1 with on tokens and components, so the two cannot drift.

## What Quick stock is

One screen, one question: **what is on the shelf, and what does it say now?**
Staff open it on a phone in a kitchen or a shop floor, walk the aisle, and set
a number per product. Two modes, decided by the server (`quick-stock/context`):

- **Recount** (warehouse / store staff) — the number IS the shelf count.
- **Add** (kitchen) — the number is *how many you just made*, committed as a
  delta. The shelf total is never rendered in this mode, deliberately.

**Archetype: A1 Worklist**, at 390px. Filter chips with live counts, records as
cards rather than rows, one control per record. Everything in §1 of the rulebook
applies; the notes below are only where this page had to decide something.

---

## 1. The Dusk budget is zero, and that is the finished answer

**Nothing on this page is tacet acting.** Every write is a staffer counting
their own shelf: the steppers, the keypad, the commit. §1.8 rule 5 (a modal
spends nothing — its primary is Ink) and rule 6 (config isn't the AI acting)
point the same way, and the mobile batch-three decision — *"Send reply is
Secondary. Writing a reply is the operator acting, and Dusk means one thing"* —
is the same call on the same axis.

So:

| Element | Was | Is |
|---|---|---|
| Keypad commit | lime slab | **Ink fill, Paper text** |
| Active filter chip | lime fill | **Ink fill, Paper text** — selection, not a CTA |
| Store tick | lime | **Ink** — the operator's current selection |
| Header CTA slot | — | **empty**, and stays empty: nothing is created here (§1.7) |
| Focus ring | lime + 3px glow | **Dusk border, no glow** — rule 3, exempt |

The only Dusk on the page is the focus border, the avatar's tint, and the dot at
the end of the mark. `scripts/test_stock_screens.js` fails the build on a Dusk
fill, so the budget stays spent-at-zero rather than drifting back a button at a
time.

## 2. The header carries a title and nothing else

Title · status line · one Dusk CTA (§1.7). Both of the other two slots are
empty here, and each for its own reason:

- **No CTA** — there is no create action on this page. The slot stays empty;
  §1.7 forbids filling it with a secondary.
- **No status line** — it would have to say "42 running low · 17 sold out",
  which is what the Low and Out chips say two rows below. §1.7's non-duplication
  rule sends that to the title alone, and its honesty rule forbids inventing a
  second fact to avoid the empty slot. **Customers is the reference case**: a
  header with the title alone is finished, not a gap.

`Signed in as Asher` was a fourth element under the title. It is real and it
matters on a shared device, so it moved into the account sheet behind the
avatar — where it reads as a fact about the session rather than a subtitle of
the page.

## 3. The chrome went from four buttons to one

The old topbar carried **language · theme · refresh · sign out** as four icon
buttons, next to a title, a subtitle and a store pill: nine controls before a
single product. Now the topbar is the **tacet mark** and an **avatar**
(rounded square, 8px, Dusk tint — §1.14, never a circle). Language and
appearance are two rows in the account sheet; sign out is at its foot.

Two things fell out of that:

- **The refresh button is gone**, because A1 says so: *"No refresh button, no
  live indicator. The list updates itself."* It now re-reads on a 60s backstop
  and whenever the phone returns to the foreground or the network comes back,
  and it **repaints in place** — same rows, new numbers, no scroll jump
  (§1.12, silent refresh). The poll stands down while a sheet is open, while a
  write is pending, while a row is showing an error, and while the operator is
  in the search box: a list that overwrites a half-finished count is worse than
  a stale one.
- **Sign out is reachable from the gated screens.** The old build hid the whole
  header behind "Quick stock is off" and "No store assigned" — the two screens a
  staffer is most likely to be stuck on — which made signing out impossible. The
  shell now stays.

## 4. The store picker disappears when there is one store

§1.9, data precondition: *self-hide. No empty state, no placeholder — just
absence.* The old build rendered a dead, un-tappable pill naming the only store
the account can see. A staffer with one store now sees no picker at all; two or
more brings it back as a Secondary control in the toolbar row.

## 5. Status colour, and what a well-stocked product wears

**Nothing.** A pill is drawn only where colour encodes a state (§1.10):

| State | Treatment |
|---|---|
| Sold out | Brick-tint pill · **the count itself renders Brick** |
| Running low | Amber-tint pill |
| In stock | **no pill** — the number already says it |

190 Sage pills on one screen would be decoration, and the phone build already
reached this answer on the catalogue: *"the pill is drawn only when it says
something the switch cannot: Low, Out, or Paused."* Sold out takes Brick rather
than Amber because for a shop it is a lost sale, not a warning — recorded here
so a later pass does not "correct" it to Amber on the strength of the word
*attention*.

**The 2px Brick border around a sold-out card is gone.** It changed the card's
padding, so a row that sold out got *taller* than its neighbours and the list
jumped as counts landed — the exact failure §1.13a rule 2 and the unseen-row
rule both exist to prevent. The pill and the Brick count carry it instead.

**The steppers are Ink.** They were Brick (−) and Sage (+), which encodes
nothing: minus is not an error and plus is not an all-clear. §1.10, first line.

## 6. Type, space, shape, motion

| | Was | Is |
|---|---|---|
| Product name | 21px / 800 | 18px Inter 500 |
| The count | 38px / 800 | 30px Inter 500, tabular |
| Status text | 13.5px / 700 | 13px pill |
| Radii | 16 · 13 · 12 · 11px | 14px cards · 8px controls · 999px pills |
| Resting card | `0 1px 2px` shadow | hairline, no shadow |
| Press feedback | `transform: scale(.94)` | background settles, 200ms |
| Sheet entry | 260ms `cubic-bezier(.2,.8,.2,1)` | 350ms `cubic-bezier(0.16,1,0.3,1)` |
| Card entry | none | 8px rise + fade, once |

Two weights, 400 and 500. Six type steps, no others. Every number tabular. The
`text-transform: uppercase` on the sheet header is gone (§1.6). All of it is
grepped by the test, so a half-pixel or a 12px radius fails the build rather
than a review.

## 7. All six states, and the two that were missing

- **Loading** — a skeleton at `--td-raised`. **The two spinners are gone**
  (§1.12: no spinners). The first paint of the app gets the **settling
  waveform** — one of its three licensed places (app launch, hero, page-level
  load), and never a refresh.
- **Silent refresh** — §3 above.
- **Empty** — *"Nothing to count here yet. Products added in the back office
  settle in here."* Names what will arrive, with the flat waveform beneath. The
  old copy was "Nothing here", which the rulebook bans by name.
- **No results** — a different sentence: *"No products match “pesto”."* +
  `Clear search`, or *"No products are sold out."* + `Show all` when a chip is
  doing the filtering. The old build showed "No matches" and offered nothing.
- **In flight** — the row says `Saving` (or `Adding`) from the tap until the
  server answers, and the count sits in Graphite while it does. **The steppers
  stay live on purpose:** the write is an absolute set, so a second tap replaces
  the first rather than double-submitting it, and freezing the buttons mid-count
  would cost the operator more than it protects. The keypad's commit closes its
  sheet, which is a stronger disable than greying it.
- **Error** — **inline, in the row, and it stays until acted on.** A failed
  save reverts the count to what the server holds (showing an unsaved number as
  if it were stock is the dishonesty §1.17 forbids), says *"Didn't save. The
  shelf still shows 11."*, and offers `Retry` with the count the operator meant.
  A failed load renders a Brick-tint banner with `Try again`. **Toasts confirm
  and never report a failure** — `toast()` lost its `kind` argument so the old
  shape cannot come back.

## 8. Voice and language

Sentence case everywhere, so the page is **Quick stock** and **Add stock** — the
installed app keeps its `Quick Stock · 库存` manifest name, which is an install
identity outside the switchable surface (§1.11's scope note). No exclamation
marks. One human moment, at most, per screen.

One language at a time, unchanged from the old build: UI and product names
render together in the reader's language, and the **only** pair on screen is the
toggle itself (`EN · 中文`) — the one exception §1.11 licenses. The test fails on
a `t('English', 'English')` pair, because a pair whose Chinese half is English
reaches half the staff as English, silently, on one row.

## 9. The mark, the icon, the manifest

- **The mark alone, never the wordmark** — Fraunces is the marketing voice and
  never appears in product UI (§1.3), and §8 puts the mark on its own below 24px
  anyway. It renders 58×20. *(It sat in a topbar of its own for one day; §14
  moved it into the account sheet.)*
- **The stroke is optical.** `vector-effect: non-scaling-stroke` holds it at
  **1.6px** (§8a). The spec's 3.5 viewBox units resolve to 0.64px at this size,
  and a mark that isn't there looks like a spacing choice. `m.html` ships the
  scaled version and owes the same fix.
- **The app icon** is now the system's own: Ink rounded square (radius 22% of
  width), Paper wave — the mark's path verbatim — Dusk dot. The old icon was a
  lime box-and-arrows glyph from the previous brand.
- **The manifest and `theme-color`** are Paper `#FBF9F4` light / Ink `#111A2B`
  dark, so the OS chrome around an installed Quick stock stops being charcoal.

## 10. Two deviations, both deliberate

1. **Dark-mode functional inks are lifted.** `#8A6425` amber text on the
   `#182236` dark card is under 3:1, and this page is read at arm's length in a
   kitchen. Dark mode swaps Paper and Ink and *"every other colour holds its
   role"* — the role holds here; only the value moves (`--amber-ink` →
   `#D9A55E`, `--brick-ink` → `#DE8B77`). If a future pass unifies dark-mode
   functional inks product-wide, take the values from here or replace them
   deliberately; do not silently restore the light-mode ones.
2. **The font stylesheet is loaded non-blocking** (`media="print"`, flipped on
   load). These phones sit behind a firewall that can null-route Google's font
   hosts, and a blocking stylesheet there costs the staffer a blank screen until
   the socket times out. The fallback stack is PingFang SC / system-ui, so the
   page is legible from the first paint and settles into Inter if the request
   lands. `m.html` blocks on it and should adopt this.

## 11. Fixed on contact with the code

Three bugs, none of them cosmetic, found while rebuilding:

1. **A failed save reverted to the number that failed.** `setQty` captured its
   baseline *after* mutating the item, so on a product's first edit the baseline
   was the new value — the catch block then "restored" the count to exactly what
   the server had rejected, and the operator was never told the number on screen
   was fiction. The baseline is now captured before the mutation, and the row
   says what happened.
2. **Sign out was unreachable** on the off / no-store / error screens (§3).
3. **`hidden` lost to an inline `display:flex`**, so the sign-out confirmation
   stood open under the button that asks for it. `[hidden]{display:none
   !important}` is now stated once, at the top of the sheet. Caught by the
   render pass, not by reading — which is the argument for the render pass.

## 12. What holds it

`scripts/test_stock_screens.js` — `npm run test:stock-screens`. Twenty renders
in headless Chromium (list, both languages, both themes, both modes, empty,
no-results, both gated screens, three failure states, all three sheets, the
in-flight and error rows), each asserted on what the staffer actually sees —
`innerText`, not the DOM dump, because a dump matches its own comments and every
sheet parked off-screen.

Plus ten static passes for the rules a render cannot see: the dead palette,
uppercase, half-pixels, weights above 500, off-scale sizes, off-system radii, a
Dusk fill, a bilingual pair with no Chinese, a native dialog, a failure sent out
as a toast, a refresh button, and the mark's optical stroke. Each was
mutation-tested when it was written.

## 13. Open, deliberately

- **No artboard.** `design-handoff/mobile-v2/` has no Quick stock file — this
  page was derived from the rulebook directly. If the canvas is re-seeded, draw
  it from the shipped page rather than re-deciding it.
- **Add mode carries no per-row hint.** The old build repeated *"How many
  made?"* under every product; the `+` prefix and the page title carry it now,
  and the keypad still asks in words. If kitchen staff read `+0` as a stock
  count, put the sentence back **once**, not 249 times.
- **The 60s poll interval** is a guess that has never been measured against a
  shop's actual pace. It is one constant, at the top of the loading section.

---

## 14. The chrome pass — 2026-08-23, same day

> Raised by Ash from the live phone, in two sentences: *"search product bar
> touching the top"* and *"no need the top bar with the logo, waste of space."*
> Both were right, and one of them was a bug shipped that morning.

### The search bar really was on the edge

`.band` — search plus chips — shipped with **no top padding**. At rest that is
invisible, because the head sits above it. The moment it pins, the input's own
border is flush against the chrome above it and the cards slide under a naked
control. This is the failure `tacet-desktop-patterns.md` §1.13a keeps returning
to, and the phone build had just landed its own version of it ("the account
button's tap target was flush with the right edge of the screen").

The band now carries `calc(var(--sa-top) + 12px)` of top space and a hairline
that closes it. **The inset is on the BAND, not on the page**, and that is
measured rather than assumed: with `padding-top` on `<html>`, a sticky child
still pins at `y = 0`, i.e. under the status bar. The head cancels the inset
while it is on screen with a matching negative bottom margin, so the gap reads
as 12px in a browser and 12px on a notched phone, and nothing moves when the
band takes over.

### The topbar was rent

56px — a fifteenth of a 844px phone — for a mark the operator taps on their own
home screen to open this app, and one avatar. **This reverses the call made in
§9 the same morning** ("Quick stock is a tacet surface and says so"): identity
in the chrome is worth paying for on a 34-page shell where the bar also
navigates. On a one-screen tool it is decoration with a rent bill, and the tool
is used one-handed in a kitchen. The mark now opens the account sheet instead —
one tap, zero pixels.

Three layouts were built as working code and photographed at 390×844 before
choosing (`v-now`, `A`, `B`, `C` in the session's mockup set). Measured chrome —
everything above the first card:

| | at rest | scrolling | |
|---|---|---|---|
| shipped that morning | 298px | 168px | topbar + head + store row + band |
| **A** — one head | 212px | 125px | account scrolls away with the head |
| **B** — head folds | **212px** | **125px** | account rides into the pinned band |
| C — search first | 125px | 125px | no title, and the store name off screen |

**B was chosen by Ash.** C is the densest and was rejected for a real reason:
on a two-store account the store name disappears entirely, and counting the
wrong store's shelf is a worse failure than a tall header.

### What B is, mechanically

- **One head**: title, the store as its second line (a 44px target dressed as a
  text line — the store is *state*, not an action, so it stopped being a
  bordered control row), and the account button in the header's right slot.
  §1.7's Dusk CTA slot stays empty; the account button is the *shell's* control,
  not the page's, and with no topbar there is nowhere else for it to live.
- **The head scrolls away like content.** Nothing is hidden, collapsed or
  resized, so the page height never changes and the list cannot jump under a
  counting finger. The only thing the fold does is **fade in the account button
  inside the pinned band** — whose space is reserved at rest, so the search
  field never changes width.
- **The threshold is cached** (`head.offsetTop + head.offsetHeight`, re-measured
  on language change and resize) rather than read per scroll event: reading
  layout on every frame of a 250-row list is how a phone starts stuttering.

### The lesson the test suite paid for

The fold is scroll-driven, and **scroll events, `requestAnimationFrame` and
`IntersectionObserver` all fire during the browser's rendering step — which
headless Chrome under `--virtual-time-budget` does not perform after load.** A
real `window.scrollTo(0, 400)` in that environment moves the page and notifies
nobody. The first version of the check went red about half the time; the second
(rAF-throttled) went red more often, and the third told the truth:

- the app applies the fold **straight from the scroll listener**, with no rAF —
  there is no layout read left to defer, and a rAF that never runs leaves the
  fold stuck;
- the test **dispatches the scroll event itself** after scrolling. The position
  is real; only the notification is the test's.

Two new guards, both mutation-tested: `folded` (the head folds, the account
button becomes visible) and a geometry assertion on **every** case —
`data-mintop`, the smallest distance from the top of the screen to any control.
Removing the band's top padding, i.e. re-introducing the exact bug Ash reported,
fails it with *"a control renders 0px from the top of the screen"*.
