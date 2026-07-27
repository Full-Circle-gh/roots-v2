# Tacet — Editor group session addendum, 2026-07-20

> Slots into the canonical set next to the other handoffs/addendums. Method
> unchanged (mockups-first, Ash-is-not-a-dev, briefs in their own code blocks,
> one yes/no at a time, survey-first on every page). This records the Editor
> rail group work from this session. **The two actual editors (Mini App,
> Product Page) are surveyed-but-not-yet-designed — this is a save point, not
> a to-do list.**

## Rulebook / brand state at session start vs end
- Ran against **rulebook v1.9 → bumped to v2.0** this session (see below).
- **brand-concept v1.1 → v1.2** this session.
- README's own stale banner is correct: rulebook is authoritative by its title
  line, blueprint is v2.1. README read-order table still miswrites the rulebook
  as "v1.4" — fix to "see the file's title line" when Claude Code next touches
  docs (unchanged from last session; still owed).

## What the Editor group is (from the read-only Claude Code survey)
A single rail accordion `data-group="editor"`. Seven members, TWO architectures:
- **Five in-shell `<section>`s** — Copy, About, Media, Legal, FAQ — plain
  sections inside `retail-admin.html`, sharing the admin shell's tokens, i18n
  walker, tab router, `api()`. Cheap to restructure.
- **Two satellite iframe apps** — Mini App Editor (`/cms` → `public/cms.html` +
  `cms-mobile.html`) and Product Page Editor (`/product-editor`) — separate
  top-level HTML docs, own tokens/i18n/JS, self-auth, lazy-loaded, shell↔iframe
  via origin-checked `postMessage`. **Load-bearing walls** — not editable by
  touching sections. Product Page Editor has NO rail item; it swaps into the
  Mini App Editor's tab via `showProductSection`.

**The single most important structural fact:** Copy, About, Legal, FAQ have no
endpoints of their own — all four write through one shared
`PUT /api/retail-admin/config` (partial PUTs, dotted keys into
`storefront_config`). They are one wall, not four. Media has its own `/media/*`
family. The two iframes have their own routes.

**Save models found (the headline friction):** Mini App Editor = proper
draft→preview→publish. Copy/About/Legal/FAQ = one Save straight to live, no
confirm, no preview, NO history/undo (`storefront_config` has no version table).
Media = immediate mutations (upload/delete fire on the spot; delete confirms).

## Structural decisions locked this session
1. **Four content pages stay SEPARATE rail pages sharing ONE form pattern** —
   not merged into a tabbed "Content" mega-page. (One screen = one question;
   avoids the "which tab did I save?" trap.) Approved by Ash.
2. **The shared content-form pattern** (established on About, reused by Legal,
   FAQ, Copy): standard shell + §1.7 header; one Dusk "Save changes" CTA
   disabled-until-dirty, "Saving…" in flight; dirty indicator "Unsaved changes"
   ⇄ "All changes saved · [time]" (Sage when clean); ghost "Discard changes"
   (dirty-only) → Brick-outline confirm with explicit no-undo wording; caption
   "Changes appear in your shop within a minute of saving." No autosave, no
   publish, no per-section save. Bilingual CONTENT fields (each EN + 中文,
   separate labelled inputs — NEVER glued); page chrome English-only.
3. **Media is a library, not a form** — no Save button, no dirty state;
   uploads/edits/deletes are immediate and the design makes that honest.

## §1.8 clarification decided (owed to rulebook, not yet written)
**Save stays Dusk across all four content pages.** Rule as decided:
> Dusk = the page's single primary commit (Save) OR an AI-acted moment. Never a
> secondary merchant action (in-page modal confirms, discard, reorder). Profile
> stays zero-Dusk because its actions are security ops on a satellite, not
> content commits.
Fold into §1.8 at next rulebook edit.

## §1.1b amendment SHIPPED this session (rulebook → v2.0, brand → v1.2)
The one-tenant trap has two axes; v1.5 named only scale. Added the **usage
axis**: "I don't use it, so cut it" is the same mistake as "my numbers are
small, so cut it." Keep test: *would a plausible merchant segment need this
within their first year?* Valid cut reasons unchanged (broken · dishonest ·
unsafe · duplicated · unreachable — hold for every merchant). Usage evidence
informs priority, never existence. Briefs must tag each keep/cut as *broken*
(cut for all) or *merchant-need* (keep/shape for audience). Origin: Media tags,
nearly cut on "does Ash tag anything?" — kept. **Files delivered; Ash to drop
into folder AND update Claude Design's project instructions.**

## Over-functionality verdicts (Editor group), tagged
**Cut — broken (for every merchant):** FAQ manual category-ID editing (silently
orphans questions) · FAQ per-question ID field · Media SVG filter option (can
never match — SVG rejected on upload) · Media dimensions display (never
populated) · Legal decorative phone illustrations + monospace boxes · ALL-CAPS
and glued-bilingual default copy values baked in code (e.g. `CHECKOUT · 结账`).
**Don't build yet — machinery exists, no UI (leave buried):** Media folder
nesting + manual sort · FAQ helpfulness votes (customers' 👍/👎 collected, no
admin screen — genuine future feature, parked).
**Keep — merchant-need (NOT Ash's habits):** Media tags (kept under new rule) ·
Copy's 17-key catalogue (grouped by shop area) · About's five sections · Media
folders AND tags.

## Design state — Editor group

### About — APPROVED
Five stacked cards (Manifesto · Stat strip · Founder · In/out · Sign-off).
Revision 1 applied: **stat Value collapsed to a SINGLE field** (a number is a
number; live data confirmed all four values identical across EN/CN), label stays
bilingual; state-navigator moved off-canvas. Bilingual done right, worst case
real, zero Dusk but Save.
**ONE OPEN yes/no (never answered):** live behaviour "leave 中文 blank → hide
that Chinese paragraph from customers" — keep it (recommend yes) and add a quiet
caption, or drop it. Settle to fully close About.

### FAQ — built, REVISION 1 UNSENT
Two cards (Categories: label EN+中文, fixed-palette colour swatch, remove, add ·
Questions: category dropdown pick-never-type, Q+A EN+中文, up/down reorder,
remove, add). No IDs anywhere. Category-removal modal (move-to-dropdown OR delete
N questions — never silent orphan). Seven frames inc. honest fresh-store
("showing starter questions until you write your own" — admin seeds 0 but
mini-app hardcodes 12). **Revision 1 note READY TO SEND, consolidated:**
1. BUG: category dropdown closes on single click — can't assign questions.
2. BUG: "Remove this question?" confirm not centered, drifts, off after reopen.
   Fix: center in viewport, dim behind, same place every time.
3. Make the two removal confirms ONE shared component (differ only in words).
4. Keep destructive = Brick outline, category-modal primary = Ink (correct per
   zero-Dusk-on-merchant-action — do NOT revert to Dusk).
5. Category swatches stay flagged placeholder (real `REVIEW_TAG_COLOURS` wired
   at build).

### Legal — APPROVED (clean, no revision)
Two document cards (Privacy · Terms), each EN+中文 textareas, Inter not
monospace, no phone illustrations, quiet character counts (plain, no limit).
Caption correctly says "mini-app" (Legal is mini-app-only) — Claude Design did
NOT copy About's "your shop." Worst case real (multi-paragraph, scrolling,
proper CJK). Save shown in correct disabled/all-saved start state. Pattern now
proven 3×: About → FAQ → Legal. (EN/CN char counts differ — 1,577 vs 554 —
that's fine, Chinese is denser; counts are not meant to match.)

### Copy — BRIEFED, awaiting mockups
17 fixed snippets, EN+中文. **Grouped into SIX place-cards** (Cart 4 · Checkout 3
· Product 2 · Profile 2 · Order tracking 3 · Onboarding 3) — not a flat wall of
34 boxes, no tabs. Fixed set (no add/remove). Grouping approved by Ash (implied
via "next page"; reconfirm if doubted).

### Media — built, REVISION 1 UNSENT (8 points)
Library model (no Save). Left folders / toolbar / grid / bulk bar / drawer.
Deletion honesty is the centrepiece: never "Unused" (only "No uses found"),
three delete-confirm variants (uses-found · none-found · check-failed — because
the usage scan is best-effort and silently reads all-unused if it fails).
**Revision 1 note READY TO SEND, consolidated 8 points:**
1. Folder rows BROKEN — rebuild as ONE row each (name+count on line, ✎/× inside
   row at right edge on hover). Currently ✎/× float as loose stacked lines.
   Lumpy demo counts + one long truncating folder name.
2. Remove strays: purple "3" bubble, "0%" fragment, floating orange "Edit".
   One Dusk only = Upload.
3. Frame 1 (populated worst case) must be UNFILTERED: "Showing 60 of 214" +
   Load more. Filtered/seasonal view is a separate frame, not frame 1.
4. Keep usage wording, truncation, toolbar, honest delete confirms.
5. Drawer: remove orange "Edit" (fields edit directly on blur; no edit mode).
6. Drawer footer = exactly Delete (Brick outline) · Close, shown fully.
7. Add frame showing on-blur "Saved" tick (drawer's only save signal).
8. URL field read-only + Copy; long real path truncates middle-ellipsis.
9. Folder rename ✎ must WORK: click → inline editable field in the row
   (name pre-selected), Enter/blur confirms, Esc cancels. Show one frame
   mid-rename. (Added 2026-07-20 — ✎ was drawn inert.)

**Standing check — Claude Design draws controls dead.** Twice this session a
clickable control was drawn with no behaviour: the FAQ category dropdown
(closed on click) and the Media folder rename ✎ (did nothing). Pattern: it
renders the control and skips the interaction. **Every clickable thing in a
brief must have its behaviour specified explicitly**, or it ships inert — an
inert control is a decision nobody made (§8, "draws controls that don't work").

**Shared bug — modals appear off-position, then snap to center.** Seen on the
FAQ "Remove this question?" confirm and the Media "Delete N file?" confirm:
the dialog paints at a wrong spot (over its trigger / a corner) for one frame,
then a script recenters it. It must be **centered by layout from first paint**,
never positioned-then-corrected. Because ALL these confirms are meant to be one
shared component, fix it ONCE on that component — do not patch per page. Every
confirm in the group inherits: centered, backdrop dims the page, same place
every time regardless of trigger.

**✅ House confirm style DECIDED — the Media folder-delete confirm is the
template.** "Delete this folder?" lands correct: centered on first paint (no
jump), dim backdrop, Cancel (ghost) + Brick-outline primary, calm sentence-case
wording. This proves Claude Design CAN land it right. Fix instruction for the
others is therefore "match the folder-delete confirm" (a working example to
copy) rather than a description to interpret. Apply the same shell to: FAQ
remove-question · FAQ category-removal · Media delete-file. **Keep each
confirm's own wording** — folder-delete says "Nothing is deleted" (safe),
file-delete says "This can't be undone" (destructive). Same shell, honestly
different words — do not flatten to identical text.

**Shared bug family — Claude Design re-renders whole containers on small state
changes.** The modal position-flash and the Media drawer's add-tag flash are
the same smell: a small state change (open a dialog, add one tag) triggers a
full re-render/re-layout that blinks. **Media drawer add-tag:** clicking
"+ Add tag" flashes the whole drawer. Fix: adding/removing a tag updates ONLY
the tag list in place; preview/fields/URL/"Where it's used" stay still; the tag
row grows and content below reflows smoothly. Drawer must scroll internally
when tall (many tags + long "Where it's used"), not resize or clip. (URL
middle-ellipsis truncation from Media rev-1 point 8 is CONFIRMED applied —
`https://cdn.tacet.app/...-kraft-box.jpg` renders correctly.)

## Mini App Editor (/cms) — SURVEY SENT, mockups blocked until it returns
Highest-stakes surface: only real draft→publish model; publish blasts BOTH
mini-app AND web shop; up to 60 blocks × 5 pages (home, promotions, membership,
categories, onboarding). Full satellite survey brief sent to Claude Code (maps
architecture, block catalogue + per-type settings, the edit→preview→publish
loop, danger points, two-operator/lost-work, rot/caps/bilingual, mobile-twin
diff, usage evidence). **Bring the survey to the new chat.**

### Mini App Editor decisions LOCKED (before design)
1. **Unpublished-changes banner must be impossible to miss** — customers see the
   old version until Publish; say so loudly (bigger-stakes sibling of "Unsaved
   changes").
2. **Publish always confirms first** — "This goes live to your mini-app and web
   shop. Publish?" (same principle as the Meituan Sync-now blast-radius confirm).
3. **Block picker = A/B decision, Ash picks from mockups** — A: flat menu of all
   block types; B: common blocks first, rest behind inline "More". **A/B brief
   is WRITTEN and HELD** — do not send until the real block list is filled from
   the survey (no inventing block types).
4. **🔴 Block templates (new workstream):** block *functionality* is universal;
   block *visual design* is currently Roots-branded and leaks into the product
   as if it were the default. Tacet must ship a small set of NEUTRAL default
   templates for new merchants; Roots's look becomes one tenant's theme, never
   the factory setting. This is a §1.1b trap in visual form. **Scope/mechanics/
   count decided AFTER the survey shows how block styling works today** — if
   styling is already separated from blocks it's a design task; if Roots's look
   is hard-coded into each block's render it's its own engineering pass. Flag
   explicitly when survey returns (covered by survey §1 token layer + §2 render).

### The three questions the CMS design must answer (predictions to confirm)
1. Does the merchant always know live-vs-edited? (banner — decided loud.)
2. How scary is Publish? (decided: always confirm.)
3. Is the block catalogue honest? (usage evidence → picker placement, not cuts.)
Predicted ugliest finding: two-operator last-write-wins with no lock (flat config
surfaces had this) — if confirmed, build-list item + design shows who-edited-last.

### 🔴 LIVE EDITOR STRUCTURE — verified from an Ash screenshot (2026-07-20)
Ash showed the LIVE Mini App Editor. It is a **three-column workspace**, NOT a
click-picker:
- LEFT: "Add a block" panel — a **drag-source list**. Blocks are added by
  DRAGGING onto the phone; reordered by dragging one block onto another. ("Drag
  a block onto the phone to add it. Drag a block onto another to reorder.")
- CENTER: a **live iPhone preview** of the actual page (currently Roots-branded
  — confirms the template problem is real, not theoretical: "Roots Club" on the
  Points block, shop's own fonts/colours throughout).
- RIGHT: **selected-block settings** — sections Style · Content · Colours ·
  Frame, radius & width · Delete this block.
- TOPBAR: page selector (Home ▾) · "Unsaved changes" dot · Revert · Publish.
Real block list seen (order): Announcement bar · Hero banner · Category tabs ·
Featured item · Product grid · Spacer · Countdown timer · Flash sale · Coupon ·
Points · Top up · Review · Stores · Voting · (more below fold). Commerce-heavy
catalogue — richer than a typical builder.

**⚠️ The earlier A/B picker brief is based on a WRONG assumption** (it assumed a
click-to-add menu opening over the canvas). The real interaction is drag-from-a-
persistent-panel. **Do NOT send the old A/B picker brief.** The picker decision
still exists (which blocks sit top vs. lower in the drag panel) but must be
rewritten against the real three-column drag workspace AFTER the survey.

### Option A sketches — SENT to Claude Design (disposable, pre-survey)
Ash chose "show me options now" over waiting. A PRE-SURVEY sketch brief was sent
for three workspace **layout** directions (all marked "Concept — pre-survey",
mechanics not invented):
- Variant A "refined current shape" — persistent left picker · center phone ·
  always-present right settings panel.
- Variant B "canvas first" — larger center phone; picker opens as a left overlay
  on "+ Add block", closes after a drag; right settings panel.
- Variant C "one side, two modes" — single right panel swapping Add (drag-source)
  / Edit (settings) via a mode switch; phone gets more width.
Both decided behaviours shown in every variant (unmissable unpublished banner ·
Publish-always-confirms). Deliver 4 frames: A · A-with-publish-confirm · B
(picker open) · C (Edit mode). **These are disposable thinking-material — when
the survey lands, anything it contradicts, the survey wins.** React to furniture
only, ignore polish.

## Product Page Editor — not touched
Second satellite. Needs its own survey before design. Reachable two ways (swap-in
iframe + `pdOpenPageDesign()` / "Product editor ↗" in docked Products panel) —
flagged in survey as a duplicated-entry to reconcile.

## §11 / PERMISSIONS_PLAN additions found
(record, don't fix — `rbac_enforce` stays off)
- `PUT /api/retail-admin/config` — unmapped/fail-open; fans out to Copy, About,
  Legal, FAQ (already listed as `/config` but not enumerated as four editors).
- `POST /api/retail-admin/cms/media` — distinct unmapped prefix from `/media`.
- `/api/retail-admin/cms/*` (incl. `/cms/publish`, goes live to both storefronts
  gated by nothing).
- **NEW gap:** `POST` + `DELETE /api/retail-admin/page-templates` (Product Page
  Editor) — not listed anywhere in §11. Add it.

## Parked (Ash's call, not defaults)
- About "leave 中文 blank hides it" yes/no (only thing blocking About-closed).
- Send FAQ rev-1 + Media rev-1 (both ready).
- Legal + Copy mockups (awaiting Claude Design).
- CMS survey → analysis → picker A/B (real block list) → block-templates scope →
  design brief (likely split: canvas + block settings).
- Product Page Editor survey, then design.
- FAQ helpfulness votes surfacing (new feature).
- Real `REVIEW_TAG_COLOURS` palette wired at build.
- README read-order "v1.4" fix.
- §1.8 Dusk clarification into rulebook text; §1.1b amendment already in v2.0.

## Reality check (house rule, unchanged)
Ash has never used most of these surfaces with real habits/data. Design being
done does not oblige build to be next. Worst-case figures in mockups are
invented for design. Every doc that disagreed with the code has lost, every
time — cite the symbol, not the line; the live un-rebuilt page is the backlog,
not the reference (§1.1b two dead references).
