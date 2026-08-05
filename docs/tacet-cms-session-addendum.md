# Tacet — CMS / Mini App Editor session addendum, 2026-07-20 (later)

> Slots into the canonical set next to tacet-editor-addendum.md (same
> date, earlier). Method unchanged: mockups-first, Ash-is-not-a-dev,
> briefs in their own code blocks, one yes/no at a time, survey-first.
> Claude Code = read-only surveys + urgent live fixes only. This records
> the Mini App Editor (/cms) design work done this session and lists the
> three PARKED items to resume. **This is a save point, not a to-do list.**

## What got done this session (Mini App Editor /cms)

The highest-stakes Editor surface. Started from surveys, ended with the
editor shell + block picker + block-settings PATTERN all designed and
approved. Decisions, in order:

1. **Editor layout = B ("canvas first").** Phone preview centre, settings
   pane right, block picker slides in from the pinned left rail when
   invoked and closes itself when a drag lands. (Rejected: A = always-open
   docked list; C = one-side/two-mode Add/Edit switch — killed, extra
   clicks, wastes width.)
2. **The rail is FOUR icons, not three** (survey finding, not assumed):
   + (add block) · droplet (Page style) · shield (Design check, carries a
   live Amber alert dot) · ? (keyboard shortcuts, pinned bottom). Panels
   mutually exclusive, one open at a time, Esc closes. Selecting a block
   does NOT close the drawer. Rail is canvas-layout-only.
3. **Block picker = variant B** (common-first). Six common blocks at full
   size, remaining 18 behind an inline "More blocks 18" that expands in
   place (never a second dialog). Uniform treatment in both tiers (density
   killed — see #5). Drag-onto-phone. Panel anchored to the real pinned
   rail, NOT a floating "+ Add block" button (that was a mock error, fixed).
4. **Common six = merchant-adjustable, edited INLINE in the panel** (ghost
   "Edit" on the section header, drag blocks in/out, "Done" exits). Ash's
   default six: **Hero banner · Greeting · Order tracker · Category tabs ·
   Product grid · Coupon**. BUILD NOTE: needs a per-merchant SERVER store —
   the existing picker-order store is `localStorage['cms.paletteOrder']`,
   per-device only, won't do. Drag UI reusable; persistence is new build.
5. **Descriptions: one per block, short enough to fit one line, wraps if it
   must, identical in both tiers, no truncation ever.** (Tier-specific
   density retired because a block must look the same when dragged between
   tiers.) 24 shortened one-liners already written and approved (in chat).
6. **Focus dim = keep** — selecting a block dims the rest of the phone
   preview; there's a "Focus" toggle. Tagged merchant-need, lives in the
   canvas/block-settings design.
7. **Publish always confirms**, and MUST be **page-aware**: "This goes live
   to your mini-app and web shop" is only true for HOME. promotions /
   membership / categories / onboarding are mini-app-only → "your mini-app"
   on those four. (Survey: shop.html reads only home.layout.)
8. **Unpublished-changes banner** must be loud (bigger sibling of "Unsaved
   changes"). Approved in mocks: "Your shop is showing an older version —
   you have unpublished changes."

## Block-settings PATTERN — APPROVED (the session's main deliverable)

The right-hand inspector, designed ONCE as a reusable pattern; all 24
blocks pour into it. Proven on 3 blocks: Spacer (simplest), WeCom (worst
case, 21 controls), Hero (the converted rebel). Locked rules:

1. **Accordion sections, fixed vocabulary + fixed order, every block:**
   Content → Style & layout → Colours → Behaviour → Frame, radius & width.
   Blocks skip sections they don't need but NEVER rename or reorder. No
   bespoke titles (live "Chat & QR setup", "Ranking & privacy", "Style"
   all fold in). No flat-plus-"More options" model — Hero and Flash conform.
2. **Content opens by default** (or first section if no Content). Never
   everything-closed (fixes the live one-wasted-click-per-block).
3. **Everyday fields first** inside each section; rare/advanced lower.
   Order replaces the old "More options" fold.
4. **Honest undo line**, Graphite caption at panel top: "Changes save to
   your draft as you type. Revert (top of page) is the only undo."
5. **Shared chrome:** icon + block name header · optional cream info-note ·
   sections · "Delete this block" (Brick outline). Section headers 13px
   Inter 500 sentence case — the live ALL-CAPS is CSS styling, retired.
6. **Field components, one look each:** text · number · language set (one
   stacked, separate, labelled input per configured language — today EN and
   中文 — NEVER glued; the set is per business, not fixed at two:
   `docs/tacet-consolidation-decisions.md` §0) · select ·
   colour (swatch chip → 14-token grid, NO free hex) · toggle (Graphite
   "on", zero Dusk) · image (thumb + Upload/Library/Clear) · repeater
   (collapsible rows, drag handle, ×, ghost Add) · linked-item picker
   (product/coupon/poll — honest empty-state note steering to the right
   admin page, never an empty dropdown).
7. **Zero Dusk anywhere in the panel** — editing is the merchant acting;
   the page's only Dusk is Publish.

**Rule logged in DECISIONS.md for the remaining 23 blocks:** customer-
visible fields = Content; Behaviour = switches/toggles only. (Established
by moving WeCom's QR image out of Behaviour into Content.)

## Live fix — STAGED, do NOT deploy alone

**Hero CTA add-handler shape fix.** Adding a new Hero button wrote a flat
`{label}` while the reader expects `{label_en, label_cn}`. Claude Code
confirmed the "renders blank" symptom is **masked** in the current build
by two read-side shims (`getCtas` + `block-renderer.js`), so customers are
NOT seeing blank labels today — it's a correctness tidy-up, not urgent.
- **Staged in `git stash@{0}`** with full rationale + deploy instruction.
- **Ship it WITH the Hero banner block build batch + a `sw.js` bump in the
  same push.** Do not give it its own deploy.
- If a future survey re-encounters the flat `label` key: it's THIS known
  staged fix, NOT a live bug to re-file.

## Surveys captured this session (for later design passes)
- **CMS block catalogue:** 24 reachable block types + 1 hidden legacy
  (`kitchen_status`) + 3 render-dead server-whitelist types (`wechat_oa`,
  `sticker_collage`, `progress_dots`). All 24 placeable on all 5 pages.
- **Rail + Page style + Design check** fully mapped (see below).
- **Block-settings inspector** fully mapped — shared frame, save model
  (instant per-keystroke, 800ms debounce, no per-field undo, NO
  validation), control vocabulary, all 24 field lists, rot list. The
  single ugliest inconsistency (now fixed by the pattern): Hero + Flash
  used a rival flat-plus-More model vs the other 22's accordion.

## Still owed on the Mini App Editor (real work, not pouring)
- **The ~21 remaining blocks** poured into the approved pattern. Suggested
  batching (blocks sharing components grouped):
  - B1 simple: Announcement bar · Points · Favorites · Notification bar ·
    Video banner (Spacer done)
  - B2 product/list: Featured item · Product grid · Category tabs · Bundle
  - B3 linked-to-system: Coupon · Voting · Flash sale · Top up · Order
    tracker (empty-list / deleted-item honesty matters here)
  - B4 content-heavy/repeater: Review · Store info · Recipe story ·
    Greeting · Leaderboard · Countdown · Refer a friend (Hero + WeCom done)
- **Page style + Design check panels** — own design pass. Owns two honesty
  gaps: (a) Page style changes (background/tab bar/accent) write straight
  to LIVE in ~60s, bypassing the block draft→publish model entirely — same
  editor, two safety models, nothing tells the merchant which is which;
  (b) Design check dot is stale (recomputes only on boot / panel-open /
  Sprout-apply, NOT on live edits) and Publish is NOT gated by it (can
  publish with any number of "critical" contrast fails). Design check is
  advisory-only, deterministic client-side (R1 contrast, R2 adjacent-muddy,
  R3 accent-count, R4 tab-bar) + a "Sprout AI" fix-suggestion layer.
- **Block templates (engineering pass, not design).** Blocks are Roots-
  branded by default and must ship NEUTRAL defaults for new merchants.
  Confirmed hard: colours resolve through a hardcoded Roots token→hex map
  duplicated across FOUR sites (`lib/brand-tokens.js`,
  `miniapp/utils/brand-tokens.js`, block-renderer inline `COLOR_MAP`,
  Design check `DC_HEX`) and consume NEITHER of the two existing per-account
  theme systems. Product has THREE disjoint colour systems (CMS flat
  `theme.*`; `brand-theme.js` nested `theme.palette.*`; hardcoded block
  maps) — none wired together. Pick a source of truth, wire blocks (+ the 4
  maps) to it, THEN design neutral default templates on top. Roots copy is
  also baked into factory defaults (e.g. "ROOTS CLUB", "by Roots Kitchen",
  "Roots · Tianhe", author "Linda", a real-looking phone number).
- **Product Page Editor** — second satellite (`/product-editor`), untouched.
  Needs its own read-only survey before any design. Reachable two ways
  (swap-in iframe + `pdOpenPageDesign()` / "Product editor ↗" in docked
  Products panel) — a duplicated-entry to reconcile. §11 gap: `POST` +
  `DELETE /api/retail-admin/page-templates` unmapped/fail-open.

## §11 / PERMISSIONS_PLAN additions found this session (record, don't fix)
`rbac_enforce` stays OFF. Add: `/api/retail-admin/cms/*` (incl.
`/cms/publish` — goes live to both online store surfaces, gated by nothing);
`/channel-status/*` and `/store-status/*` families (customer-facing
open/close, fail-open); `page-templates` POST/DELETE.

---

# ⬇️ THE THREE PARKED ITEMS — what this new chat is for

These are ready to act on NOW. All predate the CMS work; none blocked by it.

## 1. About — ONE yes/no to fully close it (only thing left)
About is APPROVED (five stacked cards: Manifesto · Stat strip · Founder ·
In/out · Sign-off; stat Value collapsed to a single field; zero Dusk but
Save). The ONLY open question, never answered:
> Live behaviour: "leave 中文 blank → hide that Chinese paragraph from
> customers." Keep it (recommend YES) + add a quiet caption explaining it,
> OR drop it.
Settle this one yes/no and About is closed.

## 2. FAQ — revision-1 note READY TO SEND to Claude Design
FAQ is built (two cards: Categories + Questions; no IDs anywhere;
category-removal modal that never silently orphans; seven frames inc.
honest fresh-store). The consolidated rev-1 note is READY — send it:
1. BUG: category dropdown closes on single click — can't assign questions.
2. BUG: "Remove this question?" confirm not centered, drifts, off after
   reopen. Fix: center in viewport, dim behind, same place every time.
3. Make the two removal confirms ONE shared component (differ only in words).
4. Keep destructive = Brick outline, category-modal primary = Ink (correct
   per zero-Dusk-on-merchant-action — do NOT revert to Dusk).
5. Category swatches stay flagged placeholder (real `REVIEW_TAG_COLOURS`
   wired at build).

## 3. Media — revision-1 note READY TO SEND to Claude Design
Media is built (library model, no Save; folders/toolbar/grid/bulk/drawer;
deletion honesty is the centrepiece — never "Unused", three delete-confirm
variants). The consolidated 8-point rev-1 note is READY — send it:
1. Folder rows BROKEN — rebuild as ONE row each (name+count on line, ✎/×
   inside row at right edge on hover). Currently ✎/× float as loose stacked
   lines. Lumpy demo counts + one long truncating folder name.
2. Remove strays: purple "3" bubble, "0%" fragment, floating orange "Edit".
   One Dusk only = Upload.
3. Frame 1 (populated worst case) must be UNFILTERED: "Showing 60 of 214" +
   Load more. Filtered/seasonal view is a separate frame, not frame 1.
4. Keep usage wording, truncation, toolbar, honest delete confirms.
5. Drawer: remove orange "Edit" (fields edit directly on blur; no edit mode).
6. Drawer footer = exactly Delete (Brick outline) · Close, shown fully.
7. Add frame showing on-blur "Saved" tick (drawer's only save signal).
8. URL field read-only + Copy; long real path truncates middle-ellipsis.

---

## Doc/version state (unchanged this session)
Rulebook `tacet-desktop-patterns.md` is v2.0 (authoritative by its title
line; README read-order table still miswrites it — the fix to "see the
file's title line" is still owed). brand-concept v1.2, blueprint v2.1.
Two rulebook edits still owed in text: §1.8 Dusk clarification (Save stays
Dusk on the four content pages) and confirm §1.1b usage-axis is folded in.

## Reality check (house rule, unchanged)
Ash has never used most of these surfaces with real habits/data. Design
being done does NOT oblige build to be next. Worst-case figures in mockups
are invented for design. Every doc that disagreed with the code has lost,
every time — cite the symbol, not the line; the live un-rebuilt page is the
backlog, not the reference. This session earned it twice: the survey's
"CTA renders blank" was masked (code won), and the floating "+ Add block"
button in early mocks was a mock error corrected against the real 4-icon rail.
