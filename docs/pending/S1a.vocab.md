HEADLINE: A REFUSAL ON THE PHONE — NOTHING COMPOSED, EVERY PAIR COPIED WHOLE.

## A refusal on the phone, said in words (§NEW)

**Nothing composed, 2026-10-01.** Operator register only (Rule 1): the phone admin
(`public/m.html`), wherever a request comes back 403. The three coded refusals are
the desktop's own pairs from `01-core.js` TD_ERR, copied whole, so both surfaces
answer the same refusal with the same sentence:
`Your role does not include this action. An owner can grant it on the Team page. ·
你的角色不包含此操作。可由负责人在团队页授权。` (`forbidden_capability`),
`You can only do that in a location you are assigned to. · 只能在你被分配的门店执行该操作。`
(`forbidden_store`) and `You are not assigned to that location. · 你未被分配到该门店。`
(`store_not_assigned`). A 403 that carries nothing readable gets
`lib/require-cap.js`'s own `You don’t have permission for this · 你没有此操作的权限`.
A 403 that carries its own bilingual sentence (the backend team and role routes)
is shown as the server wrote it, one half per language. The new-order form's
`forbidden_capability` sentence (*Your account cannot create customers…*) is
unchanged and now shown only for the refusal it names (`need: customers:edit`).
