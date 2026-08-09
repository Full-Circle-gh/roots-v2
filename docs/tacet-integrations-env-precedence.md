# Integration credentials — `.env` versus the database, v1.0

**2026-08-09 · DESIGN ONLY. Nothing here is built. No code changes accompany this file.**
The question: clearing an integration credential in the admin UI succeeds, and the next restart brings it back. This file answers why, how wide it is, and what should change. It recommends; it does not fix.

---

## THE MECHANISM, IN ONE PASS

Three things write `process.env` for these credentials, in this order at boot:

1. **`server.js:22`, the tiny `.env` loader.** It sets a key **only if the key is absent**: `if (!(key in process.env)) process.env[key] = val;`. It never overwrites.
2. **`database.js:3567`, boot hydration.** For each of its mapped keys it reads `storefront_config`, and **`if (!r) continue`** — no row, no action. Where a row exists it assigns unconditionally, so the database beats `.env`.
3. **`PUT /api/retail-admin/integrations`**, at save time, mirroring into the live process so a restart is not needed mid-session.

**The asymmetry is entirely in step 2.** A row present overrides `.env`. A row **absent** does nothing at all — and "absent" is exactly what clearing a credential produces. So a clear is honoured in the database, honoured in the live process, and then quietly reversed at the next boot by a value the operator cannot see from the admin UI.

**Absence is doing two jobs and cannot tell them apart: "never configured" and "deliberately revoked".** That is the whole defect. Everything below follows from it.

---

## 1. WHICH OF THE 23 ARE ALSO IN `.env`

**Four. Not all of them.** Measured on the live box against all 23 vars in `INTEGRATION_KEYS` across the six services:

| service | vars | in `.env` |
|---|---|---|
| `kd100` | 4 | **0** |
| `jd` | 5 | **4** — `JD_APP_KEY`, `JD_APP_SECRET`, `JD_ACCESS_TOKEN`, `JD_CUSTOMER_CODE` |
| `feie` | 2 | **0** |
| `wecom_app` | 3 | **0** |
| `nuonuo` | 4 | **0** |
| `aliyun_sms` | 5 | **0** |

**`JD_API_ENV` is NOT in `.env`**, so even within JD it is four of five. **The clear-path bug is confined to those four variables today.** Clearing a kd100, feie or aliyun_sms credential works correctly and stays cleared across a restart. Nothing else in the set can be resurrected, because there is nothing to resurrect it from.

**A SEPARATE AND WORSE GAP FOUND WHILE COUNTING: the hydration map covers 19 of the 23. All four `nuonuo` vars are missing from it.** `INTEGRATION_KEYS` defines `NUONUO_APP_KEY`, `NUONUO_APP_SECRET`, `NUONUO_SALER_TAX` and `NUONUO_ENV`; `database.js`'s `envMap` lists neither them nor anything else for that service. So a Nuonuo credential saved through the admin UI is written to `storefront_config`, mirrored into the live process, works — **and is gone at the next restart, permanently, with the row still sitting in the database.** This is the same silent-vanish shape as the transaction defect just fixed, arriving by a different route, and it is not caused by `.env`. It is unnoticed today because `storefront_config` holds no `nuonuo` rows: the service has never been configured. **The first person to configure Nuonuo will hit it.**

**Also worth stating: `wecom_app` has no rows and no `.env` entries**, so it is simply unconfigured — it is mapped correctly and would work.

**AND A NAMING TRAP FOR WHOEVER EDITS `.env`.** That file also holds `JD_JDL_APP_KEY`, `JD_JDL_APP_SECRET`, `JD_JDL_ACCESS_TOKEN`, `JD_JDL_GATEWAY` and `JD_JDL_REFRESH_TOKEN` — a **different** JD system, not in `INTEGRATION_KEYS`, not hydrated, and with no admin UI. Anything that removes "the JD lines" by pattern will take these too and break JDL. The four to be touched are the four named above and no others.

---

## 2. WHAT `.env` IS FOR NOW

**Load-bearing for the platform, and leftover for these four.** The two are different answers and the file deserves both.

`.env` holds **65 variables**. Fifty-nine of them have no admin surface anywhere and nothing else supplies them: `SESSION_SECRET`, the WeChat Pay key material, `TENANT_SECRET_KEY` (which decrypts every other tenant's credentials), the AMap keys, the proxy URLs, the Meituan and 闪购 wiring, `PORT`, and — newly — `TACET_PG_HOST` and its three companions. **The file is not legacy and is not going away.** Removing it would take the platform down.

**For the four JD integration credentials specifically, it is bootstrap residue.** They predate the Integrations tab. Every one of them now has a `storefront_config` row that is set and that already wins at boot, so the `.env` copies have had **no effect on a running system since the rows were first written**. They are inert except in exactly one circumstance — the clear path — where they are not inert at all. **A value that never matters until the moment you try to remove it is the worst kind of leftover**, because nothing about ordinary operation reveals that it is there.

**Bootstrap for a fresh box is a real use, but these four do not serve it.** A rebuilt box restores `storefront_config` from the same backup as everything else, so the rows come back with the data and hydrate normally. The `.env` copies would only matter on a box with a working `.env` and **no** database — which is not a state the recovery path produces.

---

## 3. WHEN BOTH DEFINE A VALUE, WHICH SHOULD WIN

**THE CASE FOR `.env`.** It is the break-glass surface. It is editable when the admin UI is unreachable — a broken session store, a bad deploy, an operator locked out — and it is the only channel that works before anyone can log in. Ops instinct everywhere else in this system is that a file on the box beats a row in a table, and `.env` is where every other secret lives.

**THE CASE FOR THE DATABASE.** It is the surface the operator actually uses, and the only one that shows them what is set. A UI that reports success and does not take effect is worse than having no UI at all: it manufactures false confidence, and here it does so about a **revoked credential**, which is the case where false confidence is most expensive. The database is also the only one of the two that is per-account, backed up, audited through `logActivity`, and carried by a restore.

**RECOMMENDATION: the database wins, and it should win on ABSENCE as well as on presence.** That is already true for presence; making it true for absence is the fix. The break-glass argument is real but is answered better by a deliberate override than by an accidental one — an ops escape hatch should be something you reach for, not something that fires because a row is missing. If a break-glass path is wanted later, it should be an explicit, loudly-logged variable (a `TACET_FORCE_ENV_CREDS=1` shape) rather than the current arrangement, where `.env` silently wins any argument the database declines to have.

---

## 4. CLEAR ON ABSENCE, OR STOP DEFINING THEM IN `.env`

Two fixes. Very different blast radii.

**FIX A — hydration actively clears a var whose row is absent.** One line in `database.js`: `if (!r) continue` becomes a `delete process.env[envKey]`. **Blast radius: all 19 mapped variables, on every boot, forever.** It also changes what "no row" means system-wide, from "nothing to say" to "must be unset". Two consequences follow immediately. It **destroys the bootstrap path** — on a genuinely fresh box, or any box whose `storefront_config` is empty, hydration would now delete the `.env` values that were the only way to start. And it does nothing for `nuonuo`, which is not in the map at all, so the worst hydration gap in the set survives the fix aimed at hydration. It is the more general change and it buys generality nobody has asked for, at the cost of making an empty table actively destructive.

**FIX B — remove the four JD lines from `.env`.** No code change. One file on one box, four lines, reversible in seconds by putting them back. **Blast radius: those four variables.** And critically — **it changes nothing about today's running behaviour**, because all four rows exist and already win at boot. It removes the only thing that can resurrect a cleared credential, and it removes it from the only four variables that have that problem.

**RECOMMENDATION: Fix B, and not Fix A.** B is the smaller change, it is exactly coextensive with the defect, it is verifiable by inspection (`grep` the four names, confirm the rows exist), and it fails safe — if it is wrong, the credential is missing and loudly not working, rather than silently the wrong value. A is a wide change to a mechanism that is currently correct wherever it acts, justified by a problem that exists in four places.

**Two things should ride along with B, both independent of the `.env` question:**

- **Add the four `nuonuo` entries to the hydration map.** This is an outright bug, it is unrelated to `.env`, and it will bite the first person to configure the service. It is four lines in an existing object.
- **Make absence explicit rather than inferred, if durable clearing is ever wanted beyond these four.** Storing a row with an empty value — a tombstone — lets hydration distinguish "revoked" from "never set" without giving "no row" a destructive meaning. That is the version of Fix A worth building, and it is not needed to close this defect.

**What NOT to do: fix this by having the admin UI write an empty string to `.env`.** It puts credential material back into a file that is outside git, outside the backup of record, and outside the account model.

---

## 5. DOES THIS CHANGE AT THE POSTGRES CUTOVER

**Yes, and in a way that matters more than the bug itself.**

**HYDRATION IS SYNCHRONOUS WORK AT MODULE LOAD, AND THAT SHAPE CANNOT SURVIVE.** It runs inside `database.js` as a side effect of `require`, using synchronous `better-sqlite3` calls. `pg` is asynchronous, so this becomes async work that must complete **before the process serves its first request** — and today "before the first request" is guaranteed for free by the fact that a `require` cannot be interrupted. After the cutover it has to be arranged deliberately. **A window in which the application is up and env is not yet hydrated is a new state that does not exist today**, and requests landing in it would read whatever `.env` supplied, or nothing. This is the same class as everything else recorded under Path A, and it should be converted with the rest rather than discovered at the flip.

**THE ASYMMETRY GETS WORSE, NOT BETTER, UNDER ROW-LEVEL SECURITY.** Today "no row" means "no row". Under one shared database with per-account isolation, a `SELECT` that returns nothing can also mean **"a row exists and this account cannot see it"**. A hydration that deletes on absence — Fix A — would then delete a live credential because of a policy mismatch, which is a failure with no error and no obvious cause. **This is the strongest argument against Fix A**, and it is an argument that only becomes visible if the question is asked now rather than at the cutover.

**AND `process.env` AS A SOURCE OF TRUTH IS A SINGLE-ACCOUNT ARTEFACT.** It is one global namespace in one process, so it cannot hold two accounts' credentials at once. The per-tenant path already knows this — it writes encrypted `tenant_secrets` and deliberately touches no env. **The Roots env bundle is the exception, not the pattern, and the cutover is where that exception stops being free.** Nothing here needs deciding today, but it should be recorded that the end state is per-account rows read at request time, with env holding only what is genuinely process-wide, and that every line added to the env mirror now is a line to be removed then.

---

## THE RECOMMENDATION, IN ORDER

1. **Remove `JD_APP_KEY`, `JD_APP_SECRET`, `JD_ACCESS_TOKEN` and `JD_CUSTOMER_CODE` from `.env` on the box.** Not `JD_JDL_*`. Confirm the four `storefront_config` rows are present first; restart; confirm the credentials still resolve. This closes the reported defect.
2. **Add the four `nuonuo` keys to the `database.js` hydration map.** Separate bug, same silent-vanish shape, currently latent only because the service is unconfigured.
3. **Do not make hydration clear on absence.** Revisit only with an explicit tombstone, and not before the Postgres cutover has settled what "no row" means under row-level security.
4. **Record the hydration conversion as Path A work**, so the synchronous-at-`require` shape is dealt with deliberately rather than at the flip.
