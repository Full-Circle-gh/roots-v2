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
| `canvas.json` | Layout, notes, launch view |

## Rebuilding

Artboards are generated, not hand-edited — edit `src/` and run:

```
node src/pages-1.mjs && node src/pages-2.mjs && node src/pages-3.mjs
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

## Known gaps (batch two)

Customers and Products are still the live phone build; dark theme is drawn
only as a token swap, not rendered; Chinese is not rendered anywhere here
(source carries the pair, one language ships — §1.11); the co-brand slot has
no merchant artwork in this account, so it is drawn empty per §8b.
