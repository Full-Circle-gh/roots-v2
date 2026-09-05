# Standing rules for sessions in this repo

Read in full at the start of every session. It is short on purpose: if it
grows past what can be read in one sitting, it stops working.

**What this file is.** The rules that hold for every brief, regardless of
project. They apply even when a brief does not mention them.

**What this file is not.** It carries no project state, no current work and
no dated snapshots. State lives in the handoff and decisions docs under
`docs/`. Keeping it out of here is what stops this file from becoming one
more document that goes stale. Where a rule already lives elsewhere, this
file points at it rather than restating it, so there is one source.

## Before touching anything

Base drift and concurrent sessions are how a brief stops matching the repo.
Four rules, in the order they fire:

1. **Enumerate other active sessions first.** Before any read of the tree
   beyond a fetch, list this account's sessions and report any that is
   running against this repo. Knowing another session is live is what makes
   serialising possible; after the fact it can only be inferred from CI
   timestamps.
2. **Base SHAs are pinned.** A brief states the main SHA, and any PR head
   SHAs, it was written against. Fetch and compare on entry. If any differs,
   stop and report what moved, then wait. Do not decide for yourself whether
   the drift is material: a commit outside the brief's scope can change what
   the brief meant.
3. **Re-fetch immediately before each state-changing step**, not only at the
   start. Never merge on a verification that predates the current head. A
   suite that ran against an older main is not evidence about the current
   one.
4. **Expected-head guards on every write.** Every merge and every branch
   update carries the head SHA that was actually verified. No exceptions. A
   refused write is the guard working.

## Working rules

- **All builds go on PRs. Never push directly to main.** A push to main
  deploys to production; the README's "Commits deploy to production" section
  says how.
- **Survey before building on an unfamiliar path.** Read-only first, the
  findings reported and confirmed, then code.
- **Stop and report rather than guess** when a brief is ambiguous, or when
  what the tree shows contradicts what the brief assumes.
- **One PR per change.** Unrelated changes are separate PRs.
- **Decisions before code.** Architectural decisions are recorded in
  `docs/tacet-consolidation-decisions.md` before the code that depends on
  them is written. Ash is the sole decision authority.
- **Changes to how sessions and builds work are never a silent side
  effect.** A change to `.gitignore`, CI configuration, or any other file
  governing how sessions and builds work is called out in the commit message
  and the PR description, or it is not made. This file could not exist for
  three days because one such line arrived unannounced inside an unrelated
  merge.
- **Code conventions** (bilingual UI mechanics, migrations, tenant scoping)
  are in the README's "Conventions" section. They are not repeated here.

## Citations

- **A finding filed as `file:line` is where it was found, not the extent of
  the problem.** Grep for the pattern before declaring any finding closed.
- **Line numbers in dated documents are historical coordinates.** They have
  drifted by thousands of lines in places while the prose beside them stayed
  true. Re-verify before use; never quote one as a current position. The
  house rule is stated at the head of `docs/tacet-consolidation-decisions.md`.

## Chinese strings

The rule is `docs/tacet-consolidation-decisions.md` §30, which carries the
lock, the source it points at, and the amendment for the case where no
locked source exists. Do not restate it; read it.

The one practical note that keeps being needed: prefer restructuring a label
so that an existing live string fits it over composing a new string. Where
nothing live fits, leave the string blocked for Ash and ship the control
without it. Never invent.

## Tests

A test that cannot run in CI protects nothing. A failing suite is never
resolved by skipping it, quarantining it, relaxing a required environment
flag, or moving it to a shard where it will not run. Fix the cause.

Worked example, 2026-09-05: a new browser suite looked for Chromium at a
fixed path and never read `CHROME_BIN`, which is the one place the workflow
says where the runner's browser is. It skipped on CI, the runner correctly
counted the skip as a failure under `REQUIRE_BROWSER=1`, and the fix was to
resolve the browser the way the shared helper does. Thirty-three sibling
suites in the same job had found it; the new one had looked in fewer places.
