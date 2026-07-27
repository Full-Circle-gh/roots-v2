# Tacet — Marketing section addendum, 2026-07-20

> Slots into the canonical set next to the other handoffs (Sales, CMS,
> etc.). Method unchanged: mockups-first, Ash-is-not-a-dev (explain
> plainly; technical briefs stay precise but say in plain words what
> each does), briefs in their own code blocks, one yes/no at a time,
> survey-first. Claude Code = read-only surveys + urgent live fixes
> only. This records the Marketing group design work. **This is a save
> point, not a to-do list.**

## What Marketing is (the finding that shaped everything)
"Marketing" is NOT public landing pages — it's the **merchant-facing
admin control room**, a 7-tab group for running promotions. The tabs:
Coupons · Flash sales · Pop-ups · Affiliate · Share cards · Broadcasts ·
Social proof. Several move real money or write live customer-facing state
(coupon minting, flash prices hitting live shopper checkout, affiliate
payouts, channel open/close). Ash chose Marketing independently — it was
never on a batch list (same as Sales).

The group-wide finding: **no write control disables during its request**
(except one Broadcasts button), violating §1.12 uniformly — most
dangerous exactly where money is involved. §1.12 disable guards ride with
every Marketing build.

## Settled precedents (apply to ALL Marketing tabs, and likely beyond)
These were decided during Coupons/Flash/Pop-ups and are now law for the
group. Do not re-argue without a reason as good as the one that made them.

1. **One Dusk per page = the header CTA only.** Everything else zero
   Dusk. **Toggles are the MERCHANT acting → Graphite "on" state, never
   Dusk.** (Killed the Coupons "Applied for them" pill, the Affiliate
   "Still earning" badge is owed the same demotion, and drawer toggles
   that came back Dusk on Coupons were sent back to Graphite.)
2. **"Pause" is banned** — no such state exists. Off is off; say "hides
   it," never "pauses it." (Crept back three times: Coupons subtitle,
   Pop-ups list subtitle, Pop-ups editor toggle. Killed each time.)
3. **"Draft" is banned** — saving-without-turning-on just makes an OFF
   item; there is no draft state. Honest wording: "Save without turning
   on" / "Turning it on is separate from saving." (Coupons wizard,
   Pop-ups editor footer.)
4. **The dash "—" is banned as a value** — say the real thing ("No end
   date," "no limit"). (Sales-page precedent, applied to Coupons Ends.)
5. **Every "EN · 中文" is a SOURCE PAIR** — English only on screen, never
   glued. (§1.11 — the highest-consequence invisible rule.)
6. **Sentence case everywhere; no ALL-CAPS eyebrows** (§1.6). Shouting
   caps found and killed: "NEW COUPON," "DRAFT," "LIVE NOW," section
   headers.
7. **No toasts flying in** — inline notes/confirms only.
8. **Money / live-customer actions get a one-line blast-radius confirm**
   before firing, stating what the customer will experience. Confirm =
   Ink (merchant action, not AI). Turning something OFF needs no confirm.
9. **Dates use chips + a real calendar picker, never a free-text box.**
   (Flash sales composer set the pattern; Pop-ups editor was corrected
   to match — its Ends field was raw text.)
10. **Worst-case frames first.** Claude Design defaults to the calm state
    and skips the hard one — always demand the busy/failure frames
    explicitly (full pill stacks, two-live-sales, load-failed, etc.).
11. **Build files come back best SPLIT into 2** (a list file + a
    composer/editor file). One large single file tends to render blank —
    it did on Flash sales (the "missing flash-sales.js" false alarm).
12. **Claude Design CANNOT see the codebase.** Twice it started
    "surveying" — hunting for `flash-sales.js`, product data, APIs — and
    that is exactly when it invents. STOP it and redirect: it builds from
    briefs only. Surveying is Claude Code's job. Every drawn control must
    be real; an inert control is a decision nobody made.

## Per-tab state

### 1. Coupons — DESIGNED, in revision
Anchored to Orders (A) shell/type. Nine decisions locked:
1. "Save as draft" → "Save without turning on" (no new state — off
   coupons land in the Off filter, as they already did).
2. "Used up" pill (amber family, display-only) on a running coupon at
   used_count ≥ max_uses.
3. "Applied for them" pill → Graphite (was Dusk).
4. Grant-to-one → quiet inline "Granted · Undo" bar (no toast). Grant-
   to-all keeps its confirm.
5. Auto-apply toggle → one-line blast-radius confirm before arming.
6. Ends "—" → "No end date."
7. Expired + "Turn on" → refusal offers the fix directly (focus the
   date field), not a dead-end toast.
8. Wizard eyebrow "NEW COUPON" caps → sentence case.
9. Header CTA = Dusk (was Ink drift); the page's only Dusk.
Plus §1.12 disable guards (build).
**rev-1 sent:** drawer toggles came back Dusk → corrected to Graphite;
header subtitle over-explained ("turn one on... pause it") → trimmed to
one line.
**PARKED (survey-gated):** a "What customers see" preview pane for the
wizard — Flash/Pop-ups have one, Coupons doesn't. Worth adding for
consistency BUT a coupon's customer surface is plural (app card, checkout
line, wallet) and none has been surveyed. Do NOT design it until Claude
Code surveys the real customer-side coupon card — otherwise Claude Design
invents it and the invention becomes the spec.

### 2. Flash sales — DESIGNED, in revision
Highest stakes in the group — touches LIVE shopper prices. Honesty +
flow pass, shape kept. Decisions: header CTA Dusk; all-caps retired;
composer replacement warning (a sale is written onto the product — one
per product — so composing a new sale on a product that already has one
SILENTLY overwrites it; the composer now warns + button reads "Replace
the sale"); live-edit confirm ("shows to customers immediately");
end-early blast-radius confirm; stock visibility in composer ("In stock:
N") + out-of-stock warning; ended rows say WHY ("ended · timer" /
"ended · sold out"); sold-out live sale flips hero to sold-out-early;
two-live-sales rule (hero = soonest-ending, others as Live-pill rows);
scheduled rows show "starts in 3h"; loading + error states designed for
real (they rendered unstyled — CSS never existed).
**rev-1 (ready/sent):** composer showed cap 60 on a product with 23 in
stock WITHOUT the warning firing — fix to a clean cap or show the amber
note; "Change" product action → ghost text (not bordered button).
**Build notes owed (Claude Code):** confirm the composer's product fetch
includes stock numbers; confirm "product already has a sale" is cheaply
detectable; glued bilingual heading sits outside the i18n wrapper
(wrapper fix); the hero "DRAFT" literal's trigger is unclear (likely dead
code); `_fsTick` interval leak (never cleared on tab-leave); §1.12 guards
on Start/Replace, End early, Cancel.

### 3. Pop-ups — DESIGNED, CLOSED (both files verified 2026-07-20)
Two files: list + editor. Decisions: header CTA Dusk; **Ended filter tab**
added (was hidden inside Off) with honest toggle-refusal on ended cards
(pick a new date); filter-aware count (All 8 → Live 4 → Ended 2 —
verified); toggle-on confirm naming the pages; **neutral preview** (was
wearing the shop's green Roots branding — must read the same for every
merchant); **overlap warning** in editor (two pop-ups same page+window);
**editor summary line** (plain-language "Shows on Home, after 3s, once,
until Jul 30"); **quiet-rule nudge** at 3+ live ("4 pop-ups are live. Your
quietest app shows one at a time." — dismissible, dry, not scolding);
**shown/tapped metric** per card (CONDITIONAL — see below); ghost Change
action; caps retired.
**rev-1 verified in place:** only two triggers exist (Right away / After
N seconds) on BOTH surfaces from one shared vocabulary — "on scroll" and
"on exit" were Claude Design INVENTIONS, stripped; no "pause"; one-line
subtitle; summary keeps start-time and trigger in separate clauses; no
"draft"; both date fields chips + calendar (no raw text) with "No end
date" + helper retained.
**⚠️ CONDITIONAL — shown/tapped metric:** designed into the cards, but the
survey never confirmed impressions/taps are TRACKED (pop-ups are one
config blob; no view/tap logging seen). If Claude Code confirms it's not
logged, the metric must be REMOVED cleanly — it is NOT structurally load-
bearing. Don't let the mockup imply the data is free.

### 4. Affiliate — NOT STARTED (next session)
Survey done, no design yet. Feature-gated ("Referral program"). §11 fail-
open. Known footguns to design honesty around:
- No control disables on save → double-payout / double-void risk.
- A VOIDED referral still shows a live "Reward" button (no guard).
- Voided-then-restored referral loses "ordered" status forever.
- Empty "lifetime months" saves as 0 but reloads as 12 (silent flip).
- "Still earning" badge is a second Dusk surface → owed Graphite demotion.
- Ledger pageSize fixed 100, no pagination — rows beyond 100 dropped.
- Two different "open customer" functions (referrer vs invitee).
Right rail = settings (reward per order, referee reward, lifetime
rate/months, code prefix, share image), one Save. Left = stats tiles +
filter + search + ledger.

### 5–7. Share cards · Broadcasts · Social proof — NOT STARTED
From the survey:
- **Share cards:** 4 card types (home/product/voting/invite); invite
  syncs with Affiliate settings (flat keys, PATCH /affiliate/settings);
  hydrates from two sources; no client size/dimension guard on upload.
- **Broadcasts:** has the group's ONLY disable-on-write button (Send);
  has its own draft concept — check it's real vs the Coupons "draft lie."
- **Social proof:** ⚠️ lets merchants FABRICATE data (fake buyer names,
  inflated view/sold counts) applied to the live storefront instantly —
  a BRAND-VALUES question ("Trust is earned invisibly. Silent, never
  secretive."), not just a design one. Discuss with Ash before design.
  Also: checkout upsell is hidden inside this tab (two unrelated features,
  one feature-toggle hides both).

## §11 / PERMISSIONS_PLAN additions found across Marketing (record, don't fix)
`rbac_enforce` stays OFF. `/affiliate/*` fail-open. `/vouchers` grant/
mint money endpoints. `/flash-sale` PUT/DELETE (live price). `/config`
(pop-ups, share cards). All Marketing mutations inherit the group's §1.12
gap.

## Doc/version state
No canonical doc (rulebook/blueprint/brand) was edited this session —
everything above is mockup decisions in flight, not new rules. When
Marketing closes, the settled precedents (esp. #1 Dusk-on-toggles, #2/#3
pause/draft bans, #9 date-picker) are candidates to fold into the rulebook
proper. Until then this addendum is the record. brand-concept v1.2,
blueprint v2.1, rulebook per its own title line (README read-order table
still miswrites the rulebook version — known, unchanged).

## Reality check (house rule, unchanged)
Ash has never used most of these surfaces with real habits/data. Design
being done does NOT oblige build to be next. Worst-case figures in mockups
are invented for design. Every doc that disagreed with the code has lost,
every time — cite the symbol, not the line. Claude Design invents when it
"surveys"; Ash's "is this in my product?" is the catch that works — it
caught the invented on-scroll/on-exit triggers, the fabricated stock/cap
combination, and the green-branded preview this group alone.
