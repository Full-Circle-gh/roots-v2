## §NEW — A STORE'S STOCK-STAFF SIGN-INS NEED A PERMISSION

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Found by the settings lane. The endpoints under `/api/backend/stores/:storeId/staff`
(`routes/backend-team.js`) required only a signed-in session. So anyone signed in
to the back office could create a stock-clerk sign-in, remove one, or reset its
password, for any store in their shop. These routes are not under
`/api/retail-admin`, so the permission check that gates `/api/retail-admin` writes
(the "choke point", `requireRetailAdmin`) never saw them.

1. **The three writes are gated** (§325.3): add (`POST`), remove (`DELETE /:userId`)
   and reset password (`POST /:userId/password`). Each now needs any one of the
   permissions that open a screen making them today (`storeStaffCap()` in
   `lib/cap-routes.js`):
   - **The desktop's Settings → Operations → Stores list.** Its "Stock staff"
     button has no gate of its own, so these are the Settings tab's permissions:
     `settings:shop`, `settings:push`, `settings:payments`, `stores:view`,
     `shipping:config` and `delivery:view`.
   - **The phone's store screen**, which draws the control for `stores:edit` or
     `team:manage`. Both are admitted. At this merge the phone's call was not yet
     in main. The suite accepts the phone as a caller, and checks its gate once it
     arrives.
2. **The check holds whether or not the shop has turned enforcement on.**
   - It goes through `requireCap`, like every other write in this file (adding a
     team member, resetting a password, editing roles). These sign-ins are the
     same kind of power as those, and the Team page's writes have always been
     checked this way.
   - Nobody who can open a screen making these writes loses them. The screens are
     drawn from the same permissions with enforcement on or off.
   - The owner's permissions include all of these, so the owner is never refused.
   - A refusal comes back as 403 with this file's own wording, as the Team writes'
     refusals do.
3. **The list (`GET`) stays open to anyone signed in**, as the whole roster
   (`GET /api/backend/team`) is. Reads stay open across this product's permission
   checks: what a screen shows is decided by the client, and refusing a read can
   break a screen the operator is allowed to use. The list carries names, sign-in
   names and the last sign-in time. It carries no password and no money.
4. **Deliberately not done: holding a store-scoped operator to their own store.**
   - The desktop's store list is not filtered by store scope, so a store-scoped
     operator who can open Settings sees every store. That operator can manage
     another store's clerks today.
   - Refusing that would take something away from them. Whether those writes
     should follow the scope rule that `/stores/:id` writes follow under
     enforcement is Ash's decision.
5. **Who is refused now:** only an account that can open neither screen. For
   example, an orders-only, stock-count-only or no-permission account can no
   longer create, remove or reset a stock clerk's sign-in.
6. **Tests.** `scripts/test_store_staff_gates.js` (fast shard, 62 checks) runs the
   real `routes/backend-team.js` over a scratch database with real sessions. It
   checks:
   - **The rule:** which permissions are let through, and that the list stays a
     plain signed-in read.
   - **Refused:** an orders account and an account holding nothing, for all three
     writes. Each refusal leaves nothing made, the password unchanged and the
     clerk still active.
   - **Let through:** `settings:shop`, `stores:view`, `stores:edit`, `team:manage`
     and the owner, for all three writes, with the effect checked.
   - **The list:** still open to the orders account; still 401 when nobody is
     signed in.
   - **The callers:** the desktop Operations → Stores panel and its ungated
     button, plus the phone when it calls these.
7. **Nothing composed.** No operator strings were added.
