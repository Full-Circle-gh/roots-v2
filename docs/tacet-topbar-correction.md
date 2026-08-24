# Correction — the topbar

**2026-07-17 · settled from the live shell, not from prose. Amends `tacet-desktop-patterns.md` §1.1 and `tacet-ia-blueprint.md` §2.**

---

## The three accounts

| | Rulebook §1.1 | Handoff §7 | **The code** |
|---|---|---|---|
| Topbar exists? | yes | **no** | **YES** — `.topbar`, `retail-admin.html:835` |
| Language | topbar | Profile | **Profile iframe** — `backend-account.html:327` |
| Sound | topbar | Profile | **Profile → Notifications** — `backend-account.html:456` |
| Theme | topbar | Profile | **Neither — avatar dropdown** — `retail-admin.html:965` |
| Live-poll dot | topbar | Profile | **Neither — not global chrome at all** |

**Both docs are wrong, and differently.** The rulebook lists four things that aren't there. The handoff was right that they aren't there and concluded the topbar was imaginary — it isn't. It is one of the most substantial elements in the shell.

---

## Where the error came from

`retail-admin.html:1202` — a **code comment** — says `.tb-cluster` holds the live-poll dot and sound toggle.

The actual `.tb-cluster` markup (`:917–941`) holds **only the Inbox**.

The comment is stale. A survey read the comment instead of the markup, the survey's phrasing became a rule, and the rule outlived the thing it described. **A stale code comment, laundered through a survey, into §1.1.**

This is `tacet-session-handoff.md` §7's failure mode with an extra hop: the survey didn't summarise an element into a noun — it summarised *a comment about* an element into a noun. Nothing in the chain touched the DOM.

**`#tb-cluster` was half-right.** There is no `id="tb-cluster"` anywhere in the shell (grep: zero). There **is** `class="tb-cluster"` at `:917`. The selector was wrong; the element is real. The `:1202` comment mis-writes it with a `#` too. `tb-cluster` also appears in three `reference/products-topbar-*.html` **mockups** — mockup-only, not the live selector.

---

## What the topbar actually contains

`<div class="topbar">` — `retail-admin.html:835`. DOM order:

| # | Element | Selector | Line |
|---|---|---|---|
| 1 | Rail-fold control (chevron seam dot) | `.seam-fold#railSeamFold` | `:846` |
| 2 | Brand — co-brand logo, waveform mark, "tacet" wordmark | `.brand` | `:855` (logo `:859`, mark `:860`, name `:866`) |
| 3 | **Page identity** | `.tb-page#tb-page` | `:879` |
| 3a | └ crumb | `.tb-crumb#tb-crumb` | `:880` |
| 3b | └ Products sub-views — Catalogue / Stock activity (`#tb-stk-dot`) / Categories | `#tb-subviews` | `:881` (`:883–885`) |
| 3c | └ Purchasing sub-views — Orders / Suppliers / Bills / Reorder | `#tb-pu-subviews` | `:892` (`:894–897`) |
| 3d | └ page-help ⓘ | `.pa-info-wrap#tb-info-wrap` | `:899` |
| 4 | Spacer | `.grow` | `:906` |
| 5 | **Search** → opens ⌘K palette | `.topbar-ico#gsearch-trigger` | `:909` |
| 6 | **`.tb-cluster` — Inbox only** | `.tb-cluster` | `:917` |
| 6a | └ trigger + badge | `.acct#tbInbox` / `#tbInboxBtn` / `#inboxTriggerBadge` | `:918–922` |
| 6b | └ dropdown — Reviews, Feedback | `#tbInboxMenu` | `:924` (`:925`, `:930`) |
| 7 | **Account / avatar** | `.acct#acct` | `:943` |
| 7a | └ trigger | `#acctBtn` / `#acctCircle` | `:944` |
| 7b | └ dropdown — name head, **Profile**, **Appearance (theme)**, **Sign out** | `#acctMenu` | `:947` (`#acctProfileBtn:954`, `#acctTheme:965`, `#acctSignout:971`) |
| 8 | Account pop-up modal — lazy-loads `/backend/account` | `.prof-modal#profModal` / `#profFrame` | `:981`, `:985` |

`:987–997` is **comments only** — recording that the old loose theme/language toggles and Live Preview were removed. **That removal is why the rulebook is stale:** the buttons went, the rule didn't.

---

## Where the four actually live

- **Language** — `#langToggle` (`.langrow`), `backend-account.html:327`, wired `:1211`. **Profile iframe.** The old topbar `#lang-toggle` was removed (`retail-admin.html:987–992`). The i18n engine's `updateBtn` still probes `#lang-toggle` (`:10699`) — **a guarded no-op**, dead code pointing at a deleted element.
- **Theme** — `#acctTheme` ("Appearance · 外观"), `retail-admin.html:965`. **Inside the avatar dropdown**, not a loose topbar button. The Profile iframe deliberately has **no** in-panel theme toggle (`backend-account.html:1194`).
- **Sound** — `#ntfSound` (role=switch) + test-play `#ntfSoundTest`, `backend-account.html:456` (label `:447`, key `tacet-orders-sound-on` `:845`). **Profile → Notifications.** Posts `fc-play-order-chime` to the parent when embedded (`:870`).
- **Live-poll dot** — **does not exist as global chrome.** The only live indicator is the dashboard presence pill `#td-live` / `.td-live-dot` (`retail-admin.html:1455`), inside `.td-sec-foot` — **dashboard content, not shell.** `retailLiveOn` (`01-core.js:1446`) is SSE plumbing with no chrome UI.

---

## 🔑 The docs' topbar exists — on mobile

~~The phone shell's **"More" sheet** (`buildMore` / `rm-sheet-ctl`) carried **Theme** and **EN / 中文**.~~ **REMOVED 2026-08-24.** Phones have been served Tacet Mobile (`public/m.html`) since 2026-07-12 (`a19b70af`), so `retail-admin`'s own phone chrome was unreachable from a phone; the bottom nav and the More sheet are deleted. Theme and language now live only where the desktop topbar puts them.

**So §1.1 isn't describing a fiction. It's describing the mobile More sheet and attributing it to desktop.** Two real surfaces, collapsed into one wrong rule.

---

## The actual global chrome — what Batch 1 builds against

Persistent across every page:

1. **Rail-fold control** — `#railSeamFold` `:846`
2. **Brand** — logo + "tacet" wordmark — `:855`
3. **Page identity** — crumb + Products/Purchasing sub-view switches + ⓘ — `#tb-page:879`. *Content-driven but always present.*
4. **Search** — `#gsearch-trigger:909` → ⌘K palette
5. **Inbox** — `#tbInbox:918` → Reviews / Feedback
6. **Account / avatar** — `#acct:943` → Profile / Appearance(theme) / Sign out; opens My Info modal `#profModal:981`
7. **Left rail nav** — `.tabs` column (brand head `:1001`). **Manage team now lives here**, moved off the account dropdown (`:1209`)
8. ~~**Mobile only** — `#rm-bottomnav` (Home / Orders / Customers / Products / More), theme + language in the More sheet~~ — **REMOVED 2026-08-24**, see above

**Not global chrome:** language, sound (both Profile iframe), live-poll dot (doesn't exist).
**Global, but inside the avatar menu, not loose:** theme.

---

## Amendments owed

**`tacet-desktop-patterns.md` §1.1** — replace the topbar contract. Currently: *"Search pill · Inbox · Account · Lang · Theme · live-poll dot + sound."* Should be the eight-item list above, with language/sound/live-dot explicitly named as **not** topbar, and theme named as **inside `#acctMenu`**. Cite `:835` and the child lines.

**`tacet-ia-blueprint.md` §2** — same correction to the global chrome inventory.

**`tacet-session-handoff.md` §7** — the "topbar doesn't exist" entry is an **overcorrection**. It was right that the four aren't there. It was wrong that the topbar is the phantom. Keep the lesson (`#tb-cluster` was a bad survey line — true, the `#` is wrong); fix the conclusion.

**Optional, for Claude Code:** `retail-admin.html:1202`'s comment is stale and is the origin of this whole error. `:913` too. And `updateBtn`'s `#lang-toggle` probe (`:10699`) is dead code. None are bugs; all three are the kind of thing the next survey reads and believes.

---

## The lesson, which is §7's lesson one hop out

Three documents described this topbar. **All three were wrong.** The rulebook, the handoff, and the code's own comments.

The comment was wrong first; everything downstream inherited it. Nothing in the chain read the markup until now.

**Comments are prose.** They live in the code file, which makes them feel like code. They are not. `git blame` a comment and you get the day someone's *intention* was true.

---

*Written 2026-07-17 from a read-only survey of the live shell. Every line cited. Reference mockups (`reference/products-topbar-*.html`) held separate throughout.*
