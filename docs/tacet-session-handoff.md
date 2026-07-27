# Tacet desktop rebuild — session handoff

> ## 🔴 Read this first — corrections, 2026-07-17 evening
>
> **This handoff is still right about the method, the tools, and §7's failure modes. That is the part worth reading, and it has aged well.** Its account of *state* is now wrong in five places:
>
> | This doc says | Actually |
> |---|---|
> | "Batch 0 complete, Batch 1 next" | **Orders is closed** — design *and* code. No Orders v2 (§2's "anchored on Orders v2" language is retired). |
> | "§1.11 splits any `·`" | Only when left is Chinese-free **and** right has Chinese. Over-shielding a real pair **breaks** the toggle. |
> | "§1.12 — Orders' primary row doesn't disable" | **13 controls didn't**, across Orders *and* Customers, in **four** shapes. All shipped. |
> | "Specimen matrices owed" | Shipped — `tacet-orders-specimens.md` v1.9. |
> | "Auth fixes uncommitted in the tree" | Shipped this morning. See the addendum. |
>
> **§7's "the topbar doesn't exist" is an overcorrection** — corrected in `tacet-topbar-correction.md`. The topbar is real; the four controls §1.1 put in it are not.
>
> **New since: rulebook §1.1a** — the page shell contract. It exists because Orders' design was finalized and *nobody wrote down what it decided*, so three consecutive briefs re-derived it wrong from memory. Read it before writing any brief.

**Written 2026-07-17, end of a long day.** Paste this into a new session as the first message. It's the state of play, what's decided, what's owed, and — most importantly — what we got *wrong* and how, because that's the part that keeps repeating.

---

## 1. What this project is

Ash runs **Tacet** — a B2B admin dashboard for e-commerce merchants (WeChat Mini-Programs, websites, apps), unified control plus silent AI automations. Also runs the store it was built for (GO VEGAN! 哈素萌, Guangzhou). Tacet is a **rebrand of an older internal build ("Full Circle")** and the rebrand is roughly 30% done.

**The job:** rebuild all 34 desktop admin pages against one written rulebook, so page 1 and page 34 feel like the same product. Batch 0 (Orders + the shell) is **complete**. Batch 1 is next.

**The loop, and it's the whole method:**

```
Claude Code surveys a page  →  Ash pastes it here
      ↓
I write a brief             →  Ash pastes it into Claude Design
      ↓
Claude Design builds        →  Ash pastes screenshots here
      ↓
I check it against the rulebook; Ash checks it against his live product
```

Ash is the wire between three tools that can't talk to each other. **He is not a developer.** Explain things plainly, no jargon, and tell him exactly what to send where.

---

## 2. The documents

| File | Status |
|---|---|
| `tacet-design-system.md` | **Current.** How it looks. The authority. |
| `tacet-brand-concept.md` | **v1.1, current.** How it sounds. Naming rule amended today. |
| `tacet-ia-blueprint.md` | **v2.0.** 34 sections. §2 (global chrome) corrected 2026-07-17. |
| `tacet-desktop-patterns.md` | **v1.4, the rulebook. Read §1.1a first** — the page shell contract. Still the one that goes stale fastest. |
| `tacet-orders-design-brief.md` | Done, Orders shipped. |
| `orders-drawer-brief.md` | Done, drawer shipped. |
| `shell-brief.md` | Done, shell shipped. |
| ~~`tacet-tokens.css`~~ | **Superseded** by the live `--td-*` block. Never use. |
| ~~`full-circle-design-system.md`~~ | **Retired.** The dead brand. Never use. |
| ~~`tacet-orders.md`~~ | **Stale.** Documents removed features. Never use as a parity baseline. |
| ~~`tacet-mobile-patterns.md`~~ | **Stale.** Needs v2 — but its anchor is now stable, since Orders' design is final. |

**Into Claude Design's project instructions, in this order:** design-system → brand-concept → ia-blueprint → **desktop-patterns (last, it's the tiebreaker)**. Briefs go in the **chat**, not the instructions.

---

## 3. The rulebook's hard-won rules

Every one of these came from something real pushing back. Don't relax them without a reason as good as the one that created them.

- **§1.2 Tokens.** The live `--td-*` `:root` block (`retail-admin.css:7906–7942`) is the colour contract. **Dark-first**: `:root` is dark, `[data-theme="light"]` is the opt-in — inverted from both the brand doc and the old tokens file. Don't "fix" it. `--td-*` is **colour only**; space/shape/motion/type aren't tokenised yet.
- **§1.6 No uppercase. Anywhere.** 109 instances live. It's the reference build's mono eyebrow *without* the mono face (`--f-mono` is remapped to Inter). Replacement: 13px Inter 500, Graphite, sentence case.
- **§1.7 Page header = eyebrow · title · one Dusk CTA. Three elements, no fourth.** The purpose line was cut today: *if a page needs a sentence explaining it, the page is wrong.*
- **§1.8 One Dusk.** Header CTA has first claim. **Modal owns its Dusk; drawer inherits.** The test: *can the operator still act on what's behind it?*
- **§1.10a Badge stacks.** Max 3 pills + 2 note-lines. Orders routinely shows 5 marks. The test: *would you filter by it? pill. Only notice it once the row's in front of you? note-line.*
- **§1.11 One language on screen. Never glued.** `Orders · 订单` is a **source pair**, not a display string. **And there is a live DOM-walker** (`processNode`, `retail-admin.html:10534`): it splits an `English · 中文` node **only when the left is Chinese-free AND the right has Chinese** (guard at `:10548`) — **not** "any `·`". The real hazard is **Latin-left + Chinese-right** outside-system text (a carrier scan line, a rider name), which `data-no-i18n` shields — but don't over-shield: wrapping a genuine bilingual label breaks its toggle and glues both languages. Restructure a card and the wrapper must travel with the text, or the events blank in the language you don't have open. **This is the highest-consequence invisible rule in the product.**
- **§1.12 Six states**: loading · **in-flight** · empty · **no-results** · error · populated. Empty ≠ no-results (live Orders conflates them). **Every write control disables while it writes** — live Orders' primary row doesn't, and it's the most-clicked thing in the product.
- **§1.16 Retire a control, retire its storage key.** Two dead popovers left two stranded keys; operators are rendering layouts nobody else can see with no UI to escape.

---

## 4. The archetypes

Seven: **Worklist · Library · Composer · Console · Board · Digest · Report.** All 34 pages mapped in `tacet-desktop-patterns.md` §4.

**A1 Worklist is proven** — Orders was the anchor. Two theses died on contact:
1. **Columns can't collapse into the drawer.** Store, Items, Ship-to are load-bearing. This killed direction B.
2. **The pulse must scale** — tiles where there's a real pulse (Orders, Products, Customers, Purchasing), one summary line where there isn't (`8 reviews · 3 need reply` — Reviews, Feedback). Same slot, same component. **Never empty tiles to fake density.**

**The winner is A** ("instrument panel"), with the scaling pulse. Not because it's calmest — because Orders can't be compressed. Say that honestly; don't let it get relabelled.

---

## 5. What's owed

**1. Specimen matrices** (Orders, before Claude Code handoff)
8 action rows × 4 modifiers, 6 refund states. Nobody builds **`rider_pickup`** (no forward action at all) or **`withdrawn`** (no button produces it — it's customer-initiated) from prose. Claude Design called them "pattern repeats." They aren't.

**2. Ship the auth fixes** — one reviewed commit, its own pass
Six path-shape fixes in `lib/cap-routes.js` + the new `orders:dispatch_courier` money cap in `lib/capabilities.js` + `PERMISSIONS_PLAN.md` §11. **In the working tree, uncommitted.**

**3. Shadow mode** — its own pass, later
Deny-by-default, log-don't-block, ~a week of real traffic. **The reasoning, which is the point:** the unmapped list is a hand-assembled guess; nobody knows what's missing. Shadow turns an unknowable audit into real 403s. Then per-route `requireCap` — after shadow says which routes matter, not by guessing.

**4. Batch 1** — Dashboard · Reports · Customers · Products · Settings · Team
The briefs get short: the rulebook's tested, the layout's proven. **Survey first, always.**

**5. Profile** — `/backend/account`, an iframe to a standalone four-pane app
Its own `:root` tokens (a fifth palette), its own i18n engine, the entire auth surface (password, 2FA email + SMS, sessions). Needs a blueprint entry, an archetype, a token audit.

---

## 6. 🔴 The auth gate — do not flip `rbac_enforce`

**`PERMISSIONS_PLAN.md` §11, three blockers, all must be answered first:**

- **11.1 Fail-open on unmapped mutations.** Caps are matched by **URL pattern**, not declared per route. So `voucher-grants` ≠ `vouchers`, `category-tree` ≠ `categories`, `brand` ≠ `ai` — three fail-open holes found by reading. **`/brand/publish` goes live to shoppers and was ungated.** Still open today: `/cms/publish`, `/config`, `/printer`, `/topup-packages`, `/affiliate/*`, `/voting/config`, `/polls`, `/fapiao-settings`, `/alipay-manual`. *Approach decided (shadow-deny then per-route); not built.*
- **11.2 Reads open server-side.** `cap-routes.js:25` returns `null` for every GET, by design — "the client hides sections." The palette punches through: ⌘K returns customer nicknames and phone digits regardless of caps. `fetchData` is now client-gated, **which stops the palette asking, not anyone asking.**
- **11.3 `/integrations/*`** — credential config, deliberately open. Needs to be a written decision, not a comment.

**Flipping the flag with these open is worse than leaving it off — you'd believe you were protected.**

---

## 7. What I got wrong, and how

**Read this part.** Every one of these cost a round, and the pattern repeats.

- **I read screenshots and guessed.** ~5 times. Live vs mockup, especially. **Ask which it is.**
- **I trusted survey prose over code.** Two surveys of the same file contradicted each other on `ODV`; only a grep settled it. The wrong one sounded *more* authoritative.
- **"A manifest"** — one word that hid thumbnails, line numbers, SKUs, option notes, bundles, refund pills, pack badges, and a qty that bolds at >1. **Never let a survey summarise an element into a noun.**
- **I said the topbar doesn't exist — that was an overcorrection.** The topbar is real and substantial (`.topbar`, `retail-admin.html:835`, eight children). What's wrong is the *four things* §1.1 put in it — language, theme, live-poll dot, sound: none are loose topbar controls (language + sound live in the Profile iframe, theme is inside the avatar menu `#acctMenu`, the live-poll dot isn't chrome at all). The `#tb-cluster` survey line was still a bad line — but because the `#` is wrong (it's `class="tb-cluster"`, not an ID), not because the element is absent. Lesson stands; conclusion corrected.
- **I wrote a rule that armed a bug.** §1.11's `data-no-i18n` would have broken the command palette's index. Found only because Claude Code checked.
- **I said `mn` should match `Zhao Min`.** It's `m-i-n`. Claude Design fixed the matching rather than bending the data — the *second* time; the first time it invented a fake `@mn` handle.

**The question that works:** *"What did you leave out because it seemed obvious?"* It surfaced the DOM-walker. Ask it in every survey.

**Added 2026-07-17 — four more, each of which cost a round:**

- **I cited line numbers from a doc instead of the file.** Twice, ~10–20 lines low each time, and Claude Code caught it both times. **The doc had drifted — including from our own commits that same day.** A line number in a doc is a hint, never an address. **Cite the symbol.** Names have never been wrong; only numbers have.
- **I read a live un-rebuilt page as precedent.** Three Customers briefs drifted this way — chips where Orders has a dropdown, no KPI tiles, a two-line header. **A live page that hasn't been rebuilt is the backlog, not the reference.** Now §1.1a.
- **I summarised a data structure into what one reader does with it.** I called `NEXT_STATUS.paid` "a list of buttons." It's shared data with **two** consumers — desktop maps over it, mobile takes `[0]` — so insertion order was load-bearing. That's *"a manifest"* again, one level up.
- **I wrote a rule that protected a thing without checking the thing worked.** The deploy rule said "don't delete work CI doesn't do." The hook's unique work was a lint gate — **bypassed by the script two lines above it, and it had never once gated.** Ask whether it works before you protect it.

**The check that works:** Ash opens his live product next to the mockup. He found the missing columns, the missing thumbnails, `ROOTS` in the collapsed rail, the buried language toggle, a whole standalone auth app three surveys were structurally blind to — and on 2026-07-17, **Sarah's points ledger**, which explained a ¥1,124/¥0 gap that two greps had mis-attributed to refunds, and **five invented patterns in one round** of Customers mockups. **The greps find what exists; only he finds what's reachable.**

---

## 8. How the tools behave

**Claude Design** is excellent at whatever it's pointed at and abandons whatever it was pointed at before. **One thing at a time, finished.** It also:
- **Builds the calm state and skips the hard one.** One pill instead of five. An empty palette. Every line `×1`. **Always ask for the worst case explicitly.**
- **Invents things to make demos work** — a Tweaks panel nobody asked for (which was the deleted View popover), a fake `@mn` handle, a role chip. Ash's *"is this in my product?"* catches these.
- **Draws controls that don't work.** The mockup is the spec Claude Code implements; an inert control is a decision nobody made.
- **Argues well.** Its Graphite-not-Dusk reasoning for the courier route (*"a rider going somewhere isn't the AI acting"*) was §1.8 applied to a case the rulebook never named. Take its arguments seriously; check its facts.
- **When words fail** — four rounds on a chevron — **make it build options and pick.** That worked in one round.

**Claude Code** is accurate and honest, flags its own gaps, and refuses to overclaim. It also drifts into adjacent scope (mobile, twice). Its instinct to survey before touching is right; let it.

---

## 9. Ash

Not a developer. Explain plainly. Tell him exactly what to send and where.

He is also the reason this hasn't gone off the rails: he kept scope tight when the tools wanted to widen it, and he found by looking what three code surveys missed. **When he says "that's not in my product" or "this looks wrong," he's right.** Every time today, he was right.

---

*Handoff written 2026-07-17 morning; state updated 2026-07-18 evening. **Method is current; state lives in the README.** As of 2026-07-18: Orders closed, Customers designed, deploy race fixed, **Dashboard shipped** (6 commits, owner/warehouse/dispatch/CS). Next: Reports · Products · Settings · Team — survey first. One live-render check owed: dispatch/CS Recaps when the first such operator exists (see README).*
