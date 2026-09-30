## §NEW — THE PRODUCTS, STOCK ACTIVITY AND WASTE LISTS NARROW AND EXPORT AS THE DESKTOP'S DO

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
The phone's three stock lists gained the desktop's remaining ways to narrow
and to take a list away. The Products catalogue now has a subcategory row, a
store switch that makes Low, Out and each card's stock answer for one store,
the *Going nowhere* and *On promotion* chips, and *Export CSV*. Stock activity
has a Custom window, a search, and *Export CSV* of the view on screen. Waste
has a Custom window. Nothing on the server changed: every read is an endpoint
the desktop already calls, with the desktop's parameters. The desktop's
*Count sheet* print is not in this step (it was not in PD1's scope) and is
still a gap.

1. **Subcategories follow the desktop's picker (`paFillSubFilter`).** The row
   appears only once a category is picked and only when its products carry a
   subcategory. Order and Chinese names come from the category tree (read the
   first time a category is picked, as the desktop reads it); a subcategory a
   product carries that the tree no longer names comes after, A–Z. Picking
   another category, or *Clear the filters*, resets it.
2. **The store switch is a view, not a filter.** With a store picked, each
   product's stock is that store's shelf, judged against the product's own
   low line, then the store's, then the shop's (`paLowThreshold`'s order); an
   assembled bundle counts the whole sets its parts make at that store
   (`_paBundleStock`). Every product stays listed, and the phone's product
   lookup (`DB.products`) is never rewritten — a store pick is computed over
   it. Stock figures come from `GET /inventory/grid`, the desktop's read.
3. **The switch is offered only where it can answer**: two stores or more, a
   shop that keeps its own stock (not an upstream-catalogue tenant, which the
   desktop also exempts), and a grid read that came back whole. The phone
   asks for up to the endpoint's 5,000-row ceiling rather than the desktop's
   1,000, because the phone holds the whole catalogue and the desktop only its
   first 500; if even that comes back `truncated`, there is no switch rather
   than a store view calling every product past the cut sold out. A failed
   read is the desktop's answer too: the shop-wide figures.
4. **Going nowhere and On promotion are two more status chips**, each the
   server's count and the server's own id set from `/products/highlights`, so
   the number and the list agree. Each shows only while its count is above
   zero, as the desktop tiles hide at zero. If one disappears while lit, its
   filter goes with it — a list must not stay narrowed by a chip nobody can
   see.
5. **Both Export CSV buttons are gated on the export keys the registry
   declares — `products:export` and `activity:export`** — which the desktop
   does not enforce anywhere (its two buttons carry no `data-cap`). The
   presets say what those keys are for: the Stockroom preset takes activity
   "view + export", the Shop floor preset takes view alone. Nobody loses a
   phone control by this; there was no phone export before. The desktop's
   missing gate is reported, not fixed here. The catalogue file is always the
   whole catalogue (`paExportCsv`'s rule); the ledger file is exactly the view
   on screen — window, channel and search — as the desktop's caption promises.
6. **The ledger's search runs on Enter, not per keystroke** — it is the
   server's search (`q`: SKU, either name, or the note, which holds the order
   number), and Customers' rule for a server search keeps the keyboard up.
   The box stays on screen while its answer loads and if it fails.
7. **Custom windows use the ask-sheet Finance and Trend already use**: two
   dates filled with the window on screen, a missing day or an inverted pair
   refused in the sheet, and a pick that equals a preset lights the preset.
   The chosen days are shown under the switch. A one-day Custom window shows
   times alone, as a one-day preset does (`actFmtClock` follows the window,
   not the chip).
8. **Two phone rules written in earlier comments are retired**: "CSV export
   stays on the desktop" (Stock activity) and "No free date range" (Waste).
   §97 had already overruled both.
9. **Not done, deliberately:** the store switch does not follow the operator's
   store lock, because the desktop's does not; a store-locked operator can
   still read another store's shelf, as on the desktop. Waste void is PD3.
