# Session addendum — 2026-07-17 (second session)

**Read this *with* `tacet-session-handoff.md`, not instead of it.** The handoff is still accurate on method, tools, and the §7 failure modes. This file records what changed after it was written — including two places where the handoff itself was wrong.

---

## 1. Shipped today

| Commit | What | Dark? |
|---|---|---|
| **(paying fix)** | `04-orders.js` + `sw.js` v590 — `paying` refund state: badge, labels, banner, non-actionable panel branch | n/a — pure FE display gap |
| **`041274e6`** | **Bundle A** — `lib/cap-routes.js` (six path-shape fixes) + `lib/capabilities.js` (`orders:dispatch_courier`) + `PERMISSIONS_PLAN.md` §11. 3 files, +109/−7 | ✅ **Dark.** `cap-routes.js` only runs inside `requireRetailAdmin`'s `rbac_enforce` branch, which is off everywhere |
| **`94e38c7`** | **Bundle B** — `lib/require-cap.js` (new) + `routes/backend-team.js` + `billing.js` + `billing-pay.js` + `backend-notices.js`. 5 files, +71/−28 | 🔴 **NOT dark. Enforces immediately.** `/api/backend/*` has nothing to do with `rbac_enforce` |
| **`4bb2f7b`** | **Bundle C** — `public/backend-account.html` + `public/retail-admin/02-settings-ops.js`. 2 files, +154/−49. Team-devices relocation + ⌘K read cap-gating + `cleanLabel` i18n fix | 🟡 **Takes effect immediately.** The ⌘K gating is client `can()`, not `rbac_enforce` — and per §11.2 it is **cosmetic, not a security boundary**. The GET endpoints stay open |
| **(sw bump)** | `public/sw.js` → `v591` — follow-up to `4bb2f7b`. See §6 item 7 | Closes a one-navigation cache desync |

**`rbac_enforce` is still off.** §11's three blockers remain unanswered. Bundle B did not change that — it operates in a different realm.

---

## 2. 🔴 Correction — the handoff was wrong about the tree

**The handoff (§5 item 2) said:** the auth fixes are "six path-shape fixes in `lib/cap-routes.js` + the new `orders:dispatch_courier` money cap in `lib/capabilities.js` + `PERMISSIONS_PLAN.md` §11. **In the working tree, uncommitted.**"

**That was Bundle A only.** The tree actually held **four bundles**:

- **Bundle A** — the three files above. ✅ Shipped `041274e6`, dark.
- **Bundle B** — RBAC server wiring the handoff didn't mention. ✅ Shipped `94e38c7`, **enforces immediately.**
- **Bundle C** — Team-devices relocation. ✅ Shipped `4bb2f7b`, takes effect immediately. See §4.
- **Bundle D** — 10 ad-hoc `scripts/*.js`, 122 reference mockups, one scratchpad file. Junk. Never ship.

**`lib/require-cap.js` is tracked and committed** as of `94e38c7`. Any note calling it untracked is stale.

**The lesson, which is §7's lesson again:** the handoff's account of the tree was a *description*, and descriptions go stale. `git status` is the tree. Ask before believing a note about uncommitted work — including a note written by the previous session in good faith.

---

## 3. What Bundle B did to live accounts

Queried from `tenant_users` on the box before shipping. **Tenant 1 (Roots) has 7 operators; every other tenant is owner-only**, so Bundle B affects nobody outside Roots.

| Role | Count | Who |
|---|---|---|
| owner | 1 | — |
| **admin** | **3** | **Jing** (`@jass`) · **Shun** (`@warehouse`) · **Mor Raviv** (`@morraviv-roots`) |
| kitchen | 2 | Aru, Xin — stock-locked |
| warehouse | 1 | Jonny (`@roots-warehouse`) |

`manager` role: **zero holders.**

**In effect as of `94e38c7`:**
- `team:manage` gates create / edit / reset-password — owner **and admin** hold it. The three admins keep these.
- `team:permissions` gates the permission matrix — **owner only.** **The three admins lost it.** Two (Jing, Shun) were logged in the day it shipped.
- `roleAboveCaps` blocks granting or resetting a role above the caller's own.
- `backend-notices` now also requires `session.tenantId` — harmless, set together at login.

**The hole this closed:** before `94e38c7`, *any signed-in operator* could create team members, reset passwords, and edit anyone's permissions — including the owner's. Session-only, no cap, no flag. That was live and worse than anything in §11, because §11's holes sit behind a flag that's off.

**⚠️ Owed: tell Jing, Shun, and Mor Raviv.** They lost a capability from a live account, mid-week.

---

## 4. Bundle C — shipped `4bb2f7b`

A must-ship-together pair (HTML alone → Team-devices vanishes with no replacement; JS alone → it renders in both places). **`02-settings-ops.js` mixed three unrelated concerns** that could not be split without hunk-level staging, so all three are named in the commit message.

**What each did to live operators:**

1. **Team-devices relocation** (~115 lines, `tmd*`). Account pop-up loses the My/Team toggle → becomes personal-devices-only. Manage Team gains a Devices card (`#tmDevCard`, gated `me.role === 'owner' || 'admin'`). Markup + CSS were already committed (`retail-admin.html:10089+`); only the JS was pending. Server routes existed (`backend-auth.js:782/824`).
   → **VISIBLE to owner + the 3 admins.** Same power, new home. Nobody else saw the old toggle.
2. **⌘K read cap-gating.** Each fetch wrapped in `may(k) = (typeof can !== 'function') || can(k)`.
   → **The only operator affected is Jonny (warehouse):** Orders and Customers stop appearing in ⌘K; Products still works. **This is an alignment, not a loss** — his Orders and Customers tabs were *already* hidden from his nav, so the palette had been inconsistently surfacing records for pages he cannot open. Owner and all three admins: zero change.
3. **`cleanLabel` i18n fix.** ⌘K titles no longer ingest both halves of an `EN · CN` pair on `data-no-i18n` buttons.
   → Cosmetic. **One edge worth knowing:** a *cross-language* ⌘K search (typing Chinese while in EN mode) no longer matches those specific bilingual buttons.

**⚠️ Owed: tell Jing, Shun, and Mor Raviv.** This is the **second** thing they notice this week without being told — after the permission matrix (§3). One message covers both.

---

## 5. ✅ Correction (applied 2026-07-17) — §1.11's walker rule was an over-statement

**Applied to §1.11 on 2026-07-17; the mechanism below is now in the rulebook.** What §1.11 *said* before: any free text containing a `·` looks like a translation pair to the walker; `data-no-i18n` is the shield.

**The code says otherwise.** Engine at `retail-admin.html:10534` (`processNode`), reached on dynamic DOM via a MutationObserver on `document.body` (`:10727`) — so drawers *are* walked on open.

```js
const idx = text.indexOf(' · ');          // FIRST occurrence, space-middot-space
const left = text.slice(0, idx);
const right = text.slice(idx + 3);
en = left.trim(); cn = right.trim();
if (!en || !cn) return;
if (!hasChinese(cn) || hasChinese(en)) return;   // ← :10548, the real guard
```

`hasChinese = /[一-鿿]/` (`:10515`). **A node is treated as a pair only when the left is Chinese-free AND the right contains Chinese.**

| Input | Result |
|---|---|
| `Orders · 订单` | Splits. EN: `Orders` · 中文: `订单` |
| `退款已批准 · 待打款` | **Untouched** — `hasChinese(en)` is true |
| `size · SKU · ×qty` | **Untouched** — no Chinese anywhere |
| `Refund approved — pay out · 退款已批准 · 待打款` | Splits on the **first** middot only. CN keeps its internal punctuation. Correct in both languages |

**The shape that gets eaten is Latin-left + Chinese-right.** That is narrower than "any `·`".

**Keep the authoring discipline** — `data-no-i18n` on external text (carrier strings, rider names, addresses) is still right, and the risk is real: an English carrier scan description followed by a Chinese status *would* match. But the rule as written is a safe over-warning, not a model of the code, and it should state the mechanism.

**How this surfaced, and it is §7 twice in one hour:**
- Claude Code reached the right conclusion (`no data-no-i18n` needed) from a **precedent** — "the existing `approved` banner has a second middot and ships fine." That reasoning was wrong; the middot count is not the mechanism.
- I then quoted the **rulebook** back as though it were the code, and was wrong in the other direction.
- Only reading `processNode` settled it. **Neither the live example nor the doc was the source of truth.**

---

## 6. New on the owed list

1. **`backend-team.js` writes no audit trail.** Team management is the surface where you most want to know who did what, and there is no record. Discovered while trying to prove whether the three admins had ever used the permission matrix — **it is unprovable from data.** (`activity_log`'s `update_permissions` rows are the *legacy kitchen* system: different realm, `entity_type="user"`, actor `user_id=1`. Not evidence either way. Second time today a plausible precedent was the wrong namespace.)
2. **The deploy path races itself.** The local hook and GitHub Actions CI both deploy and share `__stage__`. On **both `94e38c7` and `4bb2f7b`** the local hook's `scp` failed because CI had already cleaned the stage. **Harmless both times** — it failed at ship-to-stage, before install, so there was never a half-installed box, and CI completed the deploy correctly. **Twice in one session is a pattern, not a fluke.** *(Verified by reading the box directly both times, not by trusting either hook. That is the right instinct — keep it.)*
3. **Drawer language toggling is half-and-half.** The refund banner is `_reg`-registered and live-toggles; the in-progress note uses `cuT()` and bakes at render. Toggle language with a `paying` panel open → badge and banner flip, note doesn't until re-render. **This is the existing `cuT` convention across the whole drawer, not a new regression.** Orders v2 should decide: live-toggle or re-render. Not half of each.
4. **`§1.12`'s disable receipt is understated.** It names the primary status row. **Eight controls don't disable while they write** — and two of them (`combineParcels`, `splitParcels`) fail for a *different* reason: they call `adminWrite` without passing `btn`, so they look correct at the call site. Full list in the disable-audit specimen (owed).
5. **RBAC gating on Orders is nav-level and route-level only.** **No order button is wrapped in `can()`.** An operator lacking `orders:refund` still sees the button; the route 403s. Fine while `rbac_enforce` is off. **Not fine the moment it flips** — the operator gets a button that does nothing and an error they can't read. §1.9 already has the answer (*"inside a record: disable with a one-line reason"*), but this is Batch 1 design work and **it was not on the §5 owed list.**
6. **The `ship_pickup` / `fulfillment_type` split needs a count.** An order with `ship_pickup` set but `fulfillment_type` unset reads "Pickup" in the ship-to column and gets delivery-style dispatch buttons everywhere else (`04:2327` vs `04:2430`/`4640`/`2882`). **How many orders are in that state?** Zero → pick one flag, delete the other. Not zero → someone has been shipping pickup orders through the delivery flow.

7. **The `sw.js` rule is a doc, not a check — and it got missed.** `4bb2f7b` shipped admin JS **without** bumping `sw.js`, against the standing footgun rule ("admin JS needs `sw.js` in the same commit"). Fixed by a follow-up bump to `v591`.

   **The impact was small and self-healing** — HTML is network-first, JS is stale-while-revalidate, so a warm-cache owner/admin got one navigation where the account pop-up had already dropped Team-devices (new HTML) while `#tmDevCard` wasn't populated yet (old JS). Missing in both places for one load, then fine. Incognito/first-time clients were never affected.

   **The finding is not the miss — it's why.** `sw.js` was bumped correctly on the `paying` fix an hour earlier, so the rule is known, not forgotten. It got missed on the one commit that shipped *only* admin JS. **The rule lives in a doc and nothing enforces it.** Same shape as item 2: a process gap caught by attention rather than by a check. Two of them in one session.

   *(Claude Code caught and reported this unprompted, before being asked. That matches the handoff's §8 read — accurate, honest, flags its own gaps. The pattern held under pressure.)*

---

## 7. Decisions made today — do not re-litigate

1. **`paying` shares step 4 with `paid`.** Ladder stays `1.Requested → 2.Reviewing → 3.Approved → 4.Paid`. `4. Paying` is Dusk-tint + breathing dot; settles into `4. Paid` in Sage-tint. *Rationale: `paying` is a transient, not a step — but it can't hide inside Approved, because Approved is where the Payout button lives and `paying`'s one job is making clear that button is gone. Renumbering a shipped ladder that lives in two languages and in operators' heads costs more than the state is worth.* **Shipped.**
2. **`paid→dispatched` gets a drawer button.** Add `['dispatched', …]` to `NEXT_STATUS.paid` (`04:2403`). **Do not constrain the server.** *Rationale: three writers already use this transition — bulk tracking, JD label create, direct API. It is the normal path for a merchant processing a batch by pasting tracking numbers. It was already part of the product; it just had no button.* **Owed — belongs in Orders v2, not a one-off commit.** Must carry the modifiers: pickup relabels it; read-only channel orders never get it.

---

## 8. Documents

| File | Status |
|---|---|
| `tacet-orders-specimens.md` | **New, v1.2.** Status + refund specimens, every cell cited and verified against `origin/main`. Both decisions above recorded with rationale. **Two specimen tables still owed:** worst-case row (§1.10a) and disable audit. |
| `tacet-session-handoff.md` | **Current on method. Wrong on the tree** — see §2. §7's failure modes hold as method — they proved out repeatedly today — but its **topbar entry was an overcorrection, now amended** in the handoff. §8 and §9 hold as written. |
| `tacet-desktop-patterns.md` | **§1.11 walker amendment applied 2026-07-17 (§5 above). §1.12's disable receipt is still understated.** Otherwise current. |
| `tacet-ia-blueprint.md` · `tacet-design-system.md` · `tacet-brand-concept.md` | Unchanged today. |

**Three contradictions found at session start — status:**
1. **The topbar. ✅ RESOLVED 2026-07-17.** Handoff §7 said the topbar Claude specified doesn't exist — lang/theme/live-dot/sound live in Profile or the account menu, and `#tb-cluster` was a bad survey line. The gap: blueprint §2 and rulebook §1.1 **still specified it** — the correction had not reached either doc. It has now — §1.1, §2 (and its ASCII diagram) and handoff §7 were amended from `tacet-topbar-correction.md`. *The finding stands as the lesson: Batch 1 against the un-amended rulebook would have rebuilt the phantom topbar on day one — that risk is now closed.*
2. **`--td-*` line range.** Rulebook §1.2 and blueprint §9 cite `7906–7942`; blueprint's header cites `7906–7962`. Twenty lines, and the light-override block could live in the gap. One grep settles it.
3. **Page header component.** §1.7 cut the purpose line (three elements, no fourth). §3's component contract still lists "section label / bilingual title / **purpose** / CTA slot" — and "bilingual title" reads against §1.11 besides.

---

*Addendum written 2026-07-17. **Four commits shipped** — `paying` fix, Bundle A (dark), Bundle B (enforces immediately), Bundle C (+ `sw.js` v591). Two decisions recorded. Two doc corrections since applied (topbar §1.1/§2, walker §1.11). Seven items on the owed list. **The tree now holds only Bundle D — junk. Nothing owed is sitting uncommitted.***
