# Tacet — rail drill-down amendment

> ## ✅ ABSORBED — landed in the rulebook at v4.0, 2026-07-31
>
> **This is history, not a live instruction.** Everything this document asked of
> `tacet-desktop-patterns.md` — §7's *"§1.1, Rail row: replace the group behaviour; cite this
> document"* — now lives in the **Rail row of `tacet-desktop-patterns.md` §1.1**. That row is the
> rule. **Cite it, not this file.**
>
> Kept because the reasoning is worth reading and is not repeated in full in the rulebook: why
> drill-down and not an accordion (§0, a measurement not a taste call), why the parent had to be
> renamed rather than re-pointed and why `Content` rather than `Editorial` (§2.2), and why
> `product-editor` resolves to Content → Editor rather than root (§2.3). **Do not delete it** — the
> rulebook's Rail row cites it by name.
>
> **§5 is closed.** It asked for the `#railSeamFold` filing discrepancy to be resolved. Verified on
> the box 2026-07-31: it is **in the rail** (`.tabs` opens at `retail-admin.html:1249`, the button
> is at `:1273`, `.topbar` closes before it). §2.4's assumption holds; nothing owed.
>
> **§6 is closed** — the build shipped in code, including the flyout's `mouseenter`/`focusin`
> entry points being removed, which §6 did not name but which are destructive for drill-down.
>
> **§7 is closed.** Every amendment it lists has been made. `tacet-ia-blueprint.md` made all of
> them at **v2.4 on 2026-07-29** — §1, §3 (plus the map, now its §3.2), §4's CONTENT heading, §7's
> flatten-at-one, §8's corrected "one editor with two faces", the SWAP-IN line, the
> `product-editor` notes column, and §9 keeping rail-order under *Keep (structure)*.
> `tacet-editor-addendum.md` gained its header line on **2026-07-31**.
>
> **Read §7 below as a record of what was owed in July, not as a live queue.** It reads like a
> to-do list and has already been mistaken for one once.

**v1.0 · decided 2026-07-29 · Batch 0 (global shell).**
**Amends:** `tacet-ia-blueprint.md` §3 (navigation model — the rail) and §7 (gating), and the **Rail** row of `tacet-desktop-patterns.md` §1.1.

**What changes:** the three rail groups (`marketing`, `loyalty`, `editor`) stop opening a **flyout panel to the right of the rail** and start **replacing the rail's own contents** with their children. One column, one level at a time.

**What does not change:** rail order, group membership, the three-axis gating model, the topbar, the bottom nav, `goTab()`'s job of showing one section at a time. This is a change to *how the rail presents its own list*, nothing else.

---

## 0. Why drill-down and not an accordion

The other way to kill the flyout is an accordion — Marketing's seven children slide open *underneath* Marketing, pushing Loyalty, Editor, Settings and Team down the column.

**Rejected on measurement, not taste.** The rail is already 14 rows at root. Marketing open = 21 rows ≈ 980px of rail plus the 56px topbar. That scrolls on a 1080p laptop, which is the common merchant machine. Drill-down caps *any* level at 9 rows (7 children + back row + breathing room).

**Do not re-open this as a style question.** If a later pass wants the accordion, the thing to re-measure is the root rail's row count — the decision flips only if the rail gets substantially shorter.

---

## 1. The two states

```
ROOT                            DRILLED — Marketing
┌──────────────────────┐        ┌──────────────────────┐
│ ▣  Dashboard         │        │ ←  Marketing         │
│ ⌁  Reports           │        │ ──────────────────── │
│ ▤  Orders            │        │    Coupons           │
│ ⌾  Delivery          │  ────► │    Flash sales       │
│ ⌂  Sales             │        │    Pop-ups           │
│ ⬒  Products          │        │    Affiliate         │
│ ⛟  Purchasing        │        │    Share cards       │
│ ⚇  Customers         │        │    Broadcasts        │
│ ◁  Marketing       › │        │    Social proof      │
│ ✦  Loyalty & wallet › │       │                      │
│ ✎  Content         › │        │                      │
│ ☼  Settings          │        │                      │
│ ⚇  Manage team       │        │                      │
└──────────────────────┘        └──────────────────────┘
```

**Back row.** One row, not two. The `←` and the group name are the same control: `← Marketing` / `← 营销`. It is the level title *and* the way out. Sentence case (§1.6). Source pair, one language rendered (§1.11) — never glued.

**Chevron.** The trailing `›` on the three group rows stays exactly as it is today. It is the "this is a folder" mark and it is the only thing distinguishing a folder from a destination at root.

**Depth is one, permanently.** No group contains a group. Do not build a general recursive stack for a tree that is two levels deep and will stay that way.

---

## 2. The five settled decisions

### 2.1 The rail stays drilled after you pick a child

Click Marketing → click Coupons → **the rail keeps showing Marketing's children.** It does not snap back to root.

*Why:* Coupons → Flash sales is the common motion. Snapping back charges a re-drill on every hop inside a folder, which is exactly the tax the flyout already charges.

### 2.2 Clicking a group opens the folder and loads nothing

Marketing, Loyalty & wallet and Content are **containers with no page of their own.** Clicking Marketing changes the rail and leaves the content area on whatever was already there. For a moment the rail reads "Marketing" and the screen reads "Orders." That is correct and intended.

**Do not auto-load the first child.** Loading Coupons because the operator opened a folder discards the page they were reading and answers a question they did not ask.

> **⚠ The Editor group is renamed to Content, and its own page moves inside it. Decided 2026-07-29.**
>
> `Editor` was a group **and** a live destination: tab id `mini-app-editor`, cap `editor:view`, embedding `/cms`. It was the only group of the three with a page of its own, which broke the rule above.
>
> **Two changes, one step:**
>
> 1. **The group row is renamed `Content · 内容`.** It becomes a folder only — no page, no destination.
> 2. **Its page becomes an ordinary child row**, `Editor · 编辑器`, first in the list.
>
> ```
> ← Content
> ────────────────────
>    Editor
>    Copy
>    About page
>    Media
>    Legal pages
>    FAQ & help
> ```
>
> **Why the parent had to be renamed and not just re-pointed.** Leaving the folder called "Editor" puts the word inside itself — a folder named Editor whose first row is Mini App Editor. The rename removes the nesting collision instead of asking the operator to hold both meanings at once.
>
> **Why `Content` and not `Editorial`.** Editorial has no clean Chinese partner. `编辑` means *edit / editor* — the exact collision, reinstated in the Chinese view where nobody would catch it; `编辑部` is a newsroom department. Rail labels are source pairs and both halves have to work (§1.11). `Content · 内容` is clean on both sides and names five of the six children literally.
>
> **The capability moves with the page.** Today the group row carries `editor:view` while its children carry `content:view`, `media:view` and `content:view + feat faq`. When the row becomes a folder, `editor:view` must land on the **new Mini App Editor child row** — a folder row has no capability of its own, it only inherits the hide-if-empty rule (§2.5). If the cap does not move, the `/cms` embed ships ungated.
>
> *Consequence, and it is the right one:* an operator with `editor:view` but none of the content caps sees a folder with exactly one visible child, which flattens per §2.5. Their rail row reads **Editor** with the folder's icon — the word "Content" never appears for them. Intended, not a bug.
>
> **Internal names do not change. Rename the label only.** The rail group id stays `editor`, the tab id stays `mini-app-editor`, the capability strings stay `editor:view` / `content:view`. Those are invisible to the merchant and load-bearing for the bottom-nav `data-go` mirror, CSS selectors and `TAB_CAP`. Changing them buys nothing and risks the mirror. The command palette builds from the live DOM on open, so it picks up the new label with no work.
>
> **The child is named `Editor`, plainly.** The Product Page Editor is not a second destination. **A link inside the Mini App Editor swaps the same iframe from one editor to the other** — the page does not change, the tab does not change, only the iframe's contents (Ash, 2026-07-29). There is no independent route to it. So the rail has exactly one editor destination and nothing to disambiguate; a longer label like "Mini App Editor" would name a distinction the operator never encounters.
>
> Confirm at build that nothing calls `goTab('mini-app-editor')` expecting the *group* row to highlight.

### 2.3 The rail resolves its own level from the active section

This is the real build cost of the change and **it must ship in the same commit.**

Sections are reached from places that are not the rail:

- the ⌘K command palette jumps to any tab *and any individual setting card*
- Dashboard tiles and activity rows open Feedback, the order drawer, the product editor, a channel tab
- `salesGo(channel)` clicks the rail-less Meituan / gzgrocery / Eleme tabs
- Orders ⇄ Customers cross-links
- a page reload or deep link

In every one of those, the rail must **already be sitting at the right level when the operator arrives.** A rail that reports the wrong place is worse than the flyout it replaces.

**Mechanism:** one child→parent map, consulted by `goTab()` on every switch. Where the active tab has no rail row at all, the rail resolves to the **nearest ancestor that does have one**; where there is no such ancestor, it resolves to **root with nothing highlighted.**

```
CHILD TAB          →  RAIL LEVEL         ACTIVE ROW
─────────────────────────────────────────────────────────
vouchers           →  marketing          Coupons
flash              →  marketing          Flash sales
popups             →  marketing          Pop-ups
affiliate          →  marketing          Affiliate
sharing            →  marketing          Share cards
broadcasts         →  marketing          Broadcasts
social             →  marketing          Social proof

membership         →  loyalty            Membership & points
topup              →  loyalty            Top-up
leaderboard        →  loyalty            Leaderboard
voting             →  loyalty            Voting

mini-app-editor    →  editor  (Content)  Editor            ← group's own page, now a child
snippets           →  editor  (Content)  Copy
about              →  editor  (Content)  About page
media              →  editor  (Content)  Media
legal              →  editor  (Content)  Legal pages
faq                →  editor  (Content)  FAQ & help
product-editor     →  editor  (Content)  Editor            ← nested inside it; stays lit

dashboard reports orders delivery sales products
purchasing customers config team setup
                   →  root               (itself)

meituan            →  root               Sales      ← rail-less, reached by salesGo()
guanyi/gzgrocery   →  root               Sales
eleme              →  root               Sales

reviews            →  root               (nothing)  ← Inbox lives in the topbar
feedback           →  root               (nothing)
```

> **`product-editor` — resolved 2026-07-29, was contested.**
> An earlier draft filed it at **root / Products active**, reasoning that the operator arrives from a product listing. **That was wrong.** The Product Page Editor is reached by **a link inside the Mini App Editor that swaps the same iframe** — same tab, same page, different editor. An operator using it is inside Content → Editor and the rail must keep saying so. The rail row does not change when the iframe swaps.
>
> **The earlier survey question is closed.** There is no second door from the Products page. `tacet-ia-blueprint.md` files `product-editor` under `09-products.js`, which is where the *code* lives — not where the *entrance* is. Do not read the file listing as a route.

### 2.4 Clicking a group while the rail is folded unfolds and drills in one motion

`#railSeamFold` collapses the rail to icons. **The children have no icons** — Coupons, Flash sales and Pop-ups are words only. There is nothing to draw at a drilled level in the folded state, so that state does not exist.

- **Folded + click a group** → rail unfolds **and** drills, one gesture, one animation. It stays unfolded; the operator is now working inside a folder.
- **Drilled + fold** → the rail returns to root **first**, then folds. Same reason.

**Do not** invent child icons to make a folded drilled state possible. Six of the sixteen children would get invented glyphs to solve a problem nobody has.

### 2.5 Gating — a group with one visible child flattens; with none, it disappears

The count is taken **after all three gates** (capability, feature flag, data precondition) — a `feat`-off child is hidden from the rail, so Affiliate and Social proof drop out of Marketing's count when their flags are off. Recompute on every gate pass, wherever `applyCapGates()` runs.

| Visible children | Rail behaviour |
|---|---|
| **0** | Group row **absent entirely.** No chevron, no disabled row, nothing. This is already the live rule (`applyCapGates` collapses an empty group) — it survives the change unaltered. |
| **1** | Group row **flattens into a direct button to that child.** No folder, no drill. |
| **2+** | Folder, as designed. |

**How the flattened row reads:** it shows the **child's label with the parent's icon.** An operator who may only see Coupons gets a rail row that says `Coupons` with the Marketing megaphone. They never learn a folder existed, they click once instead of twice, and nothing on screen is untrue.

**Why not just always drill:** a folder containing one item is two clicks to reach one page, and it advertises the existence of six things the operator is not allowed to have. Silence is a feature (§1.9).

---

## 3. Motion, focus, keyboard

| | |
|---|---|
| **Transition** | Horizontal slide, **200ms ease-out.** Root slides left / children slide in from the right on drill; reversed on back. |
| **Why 200ms and not 350ms** | The drawer's 350ms settle is a heavier gesture over a longer distance, once per record. A rail level change is short, light and frequent. **Recorded so a later survey does not "correct" these into agreement** — they are deliberately different. |
| **Reduced motion** | `prefers-reduced-motion` → instant swap, no slide. |
| **Focus on drill** | Moves to the **first child row.** The operator is going forward; put them at the top of the new list. |
| **Focus on back** | Returns to **the group row they came from**, not the top of the rail. |
| **Esc** | **Not bound to the rail.** Esc closes drawers and modals (`tacet-desktop-patterns.md` §1.13). The rail is persistent navigation, not an overlay — overloading Esc means an operator with a drawer open over a drilled rail cannot predict what one keypress does. |
| **Screen readers** | The back row is a `<button>`, not a heading. Announce the level change (`aria-live="polite"`) — "Marketing, 7 items" — or the change is silent for anyone not looking at the column. |

---

## 4. Out of scope — do not touch

- **The topbar.** Locked: fixed 56px, no fold, no collapse. Brand stays in the topbar (§1.1c). This amendment gives no one a reason to revisit that.
- ~~**The phone bottom nav** (`#rm-bottomnav`).~~ **REMOVED 2026-08-24.** Phones have been served Tacet Mobile (`public/m.html`) since 2026-07-12 (`a19b70af`), so every `≤720px` layer inside `retail-admin` was unreachable from a phone; all of them are deleted. The bottom nav is gone with them. Phone navigation is Tacet Mobile's own, and the "don't make mobile consistent with the rail" rule now applies to `m.html` instead — a bottom bar and a 14-item column are still different problems.
- **Rail order.** The `order:9` collision (Products / Purchasing) and the gaps at 1, 5, 7, 13 stay exactly as they are. Renumber during Batch 1 as already planned, not here.
- **Group membership.** Nothing moves between folders in this change.

---

## 5. One thing to check on the box before building

`#railSeamFold` is filed in two places and the docs disagree. `tacet-topbar-correction.md` lists it as **topbar item 1** at `retail-admin.html:846`; `tacet-ia-blueprint.md` §2 says it moved to **the top of the rail** on 2026-07-24.

§2.4 above assumes **the rail**. If the survey finds it still physically inside `.topbar`, the fold behaviour still holds — but say so in the handoff, because "clicking a group unfolds the rail" is written on the assumption that the control and the thing it controls are the same component.

---

## 6. Build order for Claude Code

Ship 1–3 together. A rail that drills but does not resolve its own level is worse than no change at all.

1. **The map.** Add the child→parent table from §2.3 as a lookup, next to `TAB_CAP` in `01-core.js`.
2. **Level resolution.** `goTab()` sets the rail level from that map on every switch — including palette jumps, `salesGo()`, dashboard drill-through and first paint on reload.
3. **The rail itself.** Replace the flyout with the two-state column. Remove the flyout panel markup and its CSS; do not leave it hidden behind a flag.
4. **Content rename + Editor promotion** (§2.2) — relabel the group row `Content · 内容` (**label only** — group id, tab ids and capability strings all stay); `mini-app-editor` becomes a child row labelled `Editor · 编辑器`. **Move `editor:view` off the group row onto the new child row in the same step**, or `/cms` ships with no gate.
5. **Gate counting** (§2.5) — flatten at 1, hide at 0, inside the existing `applyCapGates()` pass.
6. **Motion and focus** (§3).

---

## 7. Amendments owed to the other documents

- **`tacet-ia-blueprint.md` §1** — "three collapsible dropdown groups" is no longer accurate; they are drill-down folders.
- **`tacet-ia-blueprint.md` §3** — replace the flyout description. The rail tree in that section stays correct as a *listing*; only its presentation changes. Add the §2.3 map. **Relabel rail entry 11 from `Editor · 编辑器` to `Content · 内容`, and add `Editor · 编辑器` as its first child.**
- **`tacet-ia-blueprint.md` §4** — the section table headed **EDITOR** becomes **CONTENT**. The rows under it are unchanged.
- **`tacet-ia-blueprint.md` §7** — extend gate 1 with the flatten-at-one rule.
- **`tacet-ia-blueprint.md` §8, line 231** — 🔴 **misleading as written.** "Editor hosts two editors: Mini App Editor (`/cms` embed) and Product Page Editor swap under one tab via `showProductSection` / postMessage" is mechanically true but reads as two peer entry points. There is one door and it is inside the other editor. **Replace with:**
  > **Content hosts one editor with two faces**: the Mini App Editor (`/cms` embed) is the tab's landing view; **a link inside it swaps the same iframe** to the Product Page Editor via `showProductSection` / postMessage. Same tab, same page, same iframe — only the contents change. **There is no independent route to `product-editor`**; it cannot be reached except from inside the Mini App Editor. `09-products.js` is where its code lives, not where its entrance is.
- **`tacet-ia-blueprint.md` line 84** — the SWAP-IN line says "under the Editor tab." **Replace with:** `SWAP-IN (no rail entry): Product Page Editor (product-editor) — opened by a link inside the Mini App Editor, swaps the same iframe. Under the Content tab.`
- **`tacet-ia-blueprint.md` line 140** — the table row is accurate; optionally add to its notes column: *entered from inside the Mini App Editor, never directly.*
- **`tacet-ia-blueprint.md` §9** — the "rail-order + group model" stays under **Keep (structure)**. This amendment changes skin and interaction, not structure.
- **`tacet-desktop-patterns.md` §1.1, Rail row** — replace the group behaviour; cite this document.
- **`tacet-editor-addendum.md`** — the **filename and internal ids stay as they are**; add a header line noting the group is now surfaced as **Content**. Renaming that file breaks every citation pointing at it.
