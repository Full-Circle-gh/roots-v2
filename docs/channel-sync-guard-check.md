# Channel Sync — Guard Check

**Read-only. Nothing was changed, started, stopped or fixed.**

**Scope.** Are the safety guards that depend on environment variables actually
holding in production *right now*? This is a today problem. It is separate from
`docs/channel-sync-architecture.md`, which describes replacing these guards with
structural ones; nothing in that plan helps until it ships.

---

## 0. What I can and cannot see — read this first

**I cannot see the production environment from this repository.** Verified:

| Checked | Result |
|---|---|
| `.env`, `.env.production`, any `*.env` | **Not present** anywhere in the tree |
| `data/` directory / `roots.db` | **Not present** — no live database in this checkout |
| `docker-compose*`, `Dockerfile` | **Do not exist** in this project |
| systemd unit files | **None in the repo** |
| PM2 ecosystem file | **Does not exist.** Confirmed by search; every daemon's start command lives only in a comment in its own header |
| CI/CD secrets | `.github/workflows/deploy.yml` and `ro-query.yml` use `DEPLOY_HOST` and `DEPLOY_SSH_KEY` only. **Neither workflow sets or reads any of the guard variables** |

**So every guard value in this document is reported as CANNOT DETERMINE unless
I have positive evidence from somewhere other than the environment.** Two
guards do have such evidence, and they are called out.

**How the values actually reach the daemons.** Each daemon loads
`/root/roots-v2/.env` itself at startup — `require('dotenv').config()` with a
hand-rolled parser fallback (e.g. `scripts/meituan-daemon.js:29-40`, identical
blocks in the other four). PM2 also captures the environment at process start
and `deploy-apply.sh` restarts with `--update-env` (`scripts/deploy-apply.sh:97`,
`:251`). **This means the file on disk and the value inside a running process can
disagree** — if `.env` was edited without a restart, the running daemon is still
on the old value. Any check must read both. The commands in §2 do.

Production paths, from `.github/workflows/ro-query.yml`: app root
`/root/roots-v2`, database `/root/roots-v2/data/roots.db`.

---

## 1. The guards

Every guard that depends on an environment variable, config flag or deployment
setting rather than a database constraint or a lock.

### 1.1 The 外卖 / 闪购 daemon-split guard

Two variables, on two different processes, that must agree.

| | |
|---|---|
| **Variables** | `MEITUAN_SKIP_STORES` (on `meituan-sync`), `SHANGOU_STORES` (on `shangou-sync`) |
| **Read at** | `scripts/meituan-daemon.js:62-63`; `scripts/shangou-daemon.js:54-55` |
| **Protects against** | The two Meituan daemons both claiming the same rows in the shared `meituan_sync_queue` and `meituan_order_import` tables for the store `yuexiu`, which was migrated from 外卖 to 闪购. |

```js
// scripts/meituan-daemon.js:62
const SKIP_STORES = (process.env.MEITUAN_SKIP_STORES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// scripts/shangou-daemon.js:54
const SHANGOU_STORES = (process.env.SHANGOU_STORES || 'yuexiu')
  .split(',').map(s => s.trim()).filter(Boolean);
```

**The two halves fail in opposite directions, and this asymmetry is the single
most important fact in this document.**

| Condition | `SHANGOU_STORES` (闪购) | `MEITUAN_SKIP_STORES` (外卖) |
|---|---|---|
| Unset | Falls back to `'yuexiu'` — **correct for Roots today** | Falls back to `''` → `filter(Boolean)` → **empty list → nothing is skipped → the 外卖 daemon includes `yuexiu`** |
| Empty string | Same as unset, `'yuexiu'` | Same as unset — **no guard** |
| Misspelled variable name | Same as unset, `'yuexiu'` | Same as unset — **no guard** |
| Typo in the value (`yeuxiu`) | 闪购 daemon manages a store that does not exist → 闪购 does nothing at all | 外卖 daemon skips nothing real → **no guard** |
| Set correctly | Guard holds | Guard holds |

`SHANGOU_STORES` **fails safe**. `MEITUAN_SKIP_STORES` **fails open**, silently,
in four of the five failure modes. There is no startup check that the two agree,
no warning, and no log line that would tell you.

### 1.2 The gzgrocery double-count guard

| | |
|---|---|
| **Variables** | `GZGROCERY_ORDER_MODE` (on `gzgrocery-orders`), `GUANYI_PICKUP_MODE` (on `guanyi-sync`) |
| **Read at** | `scripts/gzgrocery-order-daemon.js:50-51`; `scripts/guanyi-daemon.js:70-71` |
| **Protects against** | The same gzgrocery sale being deducted twice — once when the order reader sees the paid order, and again later when gzgrocery fulfils it, the Guanyi number drops, and the pickup inference reads that drop as a second sale. |

The rule exists only as a comment (`scripts/gzgrocery-order-daemon.js:17-22`):

> ⚠ DOUBLE-COUNT GUARD: once this is in `live`, set `GUANYI_PICKUP_MODE=shadow`
> in the guanyi-sync daemon. Otherwise, when gzgrocery later fulfills and the
> Guanyi number finally drops, the drift detector would decrement the SAME sale a
> second time.

Both variables are validated only against their own allowed set:

```js
// scripts/gzgrocery-order-daemon.js:50
let MODE = (process.env.GZGROCERY_ORDER_MODE || 'off').toLowerCase();
if (!['off', 'shadow', 'live'].includes(MODE)) MODE = 'off';

// scripts/guanyi-daemon.js:70
let PICKUP_MODE = (process.env.GUANYI_PICKUP_MODE || 'off').toLowerCase();
if (!['off', 'shadow', 'live'].includes(PICKUP_MODE)) PICKUP_MODE = 'off';
```

**Neither process can see the other's value.** They are separate PM2 processes
reading the same file into separate memory. Nothing compares them — not at
startup, not per cycle, not ever. The dangerous combination is
`GZGROCERY_ORDER_MODE=live` **and** `GUANYI_PICKUP_MODE=live` together, and it
would produce no warning of any kind.

| Condition | Effect |
|---|---|
| Either unset / empty / misspelled variable name | Falls back to `off` — **fails safe** for that half |
| Unexpected value (`Live`, `LIVE`, `true`, `1`, `yes`) | `.toLowerCase()` saves `Live`/`LIVE`; everything else fails the whitelist and becomes `off` — **fails safe**, but silently: a typo turns the feature off with no error |
| Both `live` | **Double-deduction of every gzgrocery sale.** No alert, no log distinguishing it |

### 1.3 `GZGROCERY_ORDER_MODE` on its own

Beyond the guard above, this variable is the entire on/off switch for the
OpenCart order reader.

```js
// scripts/gzgrocery-order-daemon.js:548
async function runCycle() {
  if (MODE === 'off') { if (ONCE) log('MODE=off — nothing to do'); return; }
```

At `off`, `runCycle()` returns **before `new GzGroceryAdmin()` is ever
constructed** (`:563`). No login, no HTTP request, no order read. The process
runs, sleeps 60 seconds, and does nothing, forever, with one log line per start.

`shadow` and `live` differ in exactly one place — `adjustStock` is wrapped in
`if (MODE === 'live')` (`scripts/gzgrocery-order-daemon.js:494`). **Everything
else runs in both modes:** the order is upserted into `gzgrocery_orders` with
`decremented: 1`, the WeCom card is pushed (`notifyOrder`, `:507`), and the
display mirror row is written into `retail_orders` (`ensureGzMirror`, `:510`).
This matters for §4.

### 1.4 Which daemons start at all

**Nothing in the repository controls this.** There is no ecosystem file, no
systemd unit, no compose file. Daemons are started by hand with `pm2 start`, and
the start command exists only as a comment in each daemon's header.

`scripts/deploy-apply.sh` **restarts** daemons it finds and **never starts one it
does not** (`:256`):

```
echo "note: no $key daemon in pm2 — nothing to bounce (start it with: pm2 start $script)"
```

It also deliberately leaves a manually-stopped daemon stopped, and says so once
per deploy (`:311-320`): *"a daemon someone stopped and forgot about stays
stopped through every future deploy, silently, possibly for weeks."*

The canonical set it knows about (`scripts/deploy-apply.sh:303-310`):
`proxy-watchdog`, `qingyun`, `guanyi`, `meituan`, `eleme`, `shangou`,
`gzgrocery`. Browser holders (`scripts/*-chrome.js`) are excluded on purpose.

**Consequence:** a daemon that is not running is indistinguishable, from the
repository, from one that is. Only `pm2 list` on the box can answer it.

### 1.5 The others

| Variable | Read at | Protects against / controls | On unset |
|---|---|---|---|
| `GZGROCERY_ADMIN_USER` / `_PASS` | `lib/gzgrocery-admin.js:34-35` | The order reader having no credentials | Logged once at startup — `⚠ GZGROCERY_ADMIN_USER/PASS not set — cannot log in` (`scripts/gzgrocery-order-daemon.js:623-625`) — then **it carries on anyway** unless `--once`. Every cycle then throws on login |
| `GZGROCERY_ADMIN_URL` | `lib/gzgrocery-admin.js:33` | Pointing at nothing | **Throws in the constructor** — the one genuinely fail-closed check in this set |
| `MEITUAN_AUTO_ACCEPT` | `scripts/meituan-daemon.js:81` | Clicking 接单 on the live merchant account | Off unless exactly `'1'` — **fails safe** |
| `MEITUAN_WRITEBACK` | `routes/retail.js:23538`, `:23574` | Admin-queued accept actions being executed | Off unless exactly `'1'` — **fails safe** |
| `ELEME_SKIP_STORES` | `scripts/eleme-daemon.js:133` | Same shape as `MEITUAN_SKIP_STORES` | Empty → nothing skipped. Currently harmless (only one Eleme daemon exists) but **fails open by the same mechanism** |
| `GUANYI_AUTOHEAL` | `scripts/guanyi-daemon.js:95` | — | Defaults **on** |
| `GZGROCERY_MIRROR_ORDERS` | `scripts/gzgrocery-order-daemon.js:171` | Mirror rows in the orders list | Defaults **on** |
| `GZGROCERY_ACTIVE_STATUSES` / `_VOID_STATUSES` | `scripts/gzgrocery-order-daemon.js:58-62` | Misreading order state | Falls back to a hardcoded list. A status in **neither** list silently never decrements |
| `GUANYI_PICKUP_CAP` | `scripts/guanyi-daemon.js:74` | A single huge inferred drop being applied | Defaults to 50 |
| `TENANT_SECRET_KEY` | `lib/secret-box.js:28` | Encrypted credentials being readable | `isConfigured()` false; encrypt/decrypt throw. Roots reads its own creds from `.env`, so Roots keeps working either way |
| `storefront_config 'meituan.enabled'` / `'eleme.enabled'` | `routes/meituan-admin.js:318-320`; `lib/eleme-sync.js:15-21` | — | Database flags, not env. Default false when the row is absent |

---

## 2. The live values — I cannot read them; here is how

**I cannot see any of these values.** No `.env` exists in this checkout and there
is no path from here to the box. Reported honestly rather than inferred.

There is a sanctioned read-only route to production —
`.github/workflows/ro-query.yml`, manual dispatch, which copies one
`scripts/diagnose_*.js` to the box, runs it, and deletes it. **It cannot help
here without a code change:** it accepts only `scripts/diagnose_*.js`, and no
existing diagnostic prints these variables. Writing one is a code change, which
this task excludes.

So: run these on the server. **None of the guard variables is a secret**, so
their values can be printed directly. The commands below never print anything
else.

### 2a. What is in the file on disk

```bash
cd /root/roots-v2
for v in MEITUAN_SKIP_STORES SHANGOU_STORES ELEME_SKIP_STORES \
         GZGROCERY_ORDER_MODE GUANYI_PICKUP_MODE \
         GZGROCERY_STORE_CODE GUANYI_STORE_CODE \
         MEITUAN_AUTO_ACCEPT MEITUAN_WRITEBACK \
         GZGROCERY_MIRROR_ORDERS GUANYI_AUTOHEAL; do
  printf '%-24s %s\n' "$v" "$(grep -m1 "^${v}=" .env 2>/dev/null || echo '(UNSET)')"
done
```

Prints one line per guard, `(UNSET)` where absent. Reads nothing else from
`.env`.

### 2b. What the running processes actually hold

This is the authoritative answer — a `.env` edited without a restart has not
reached the daemon.

```bash
pm2 jlist | node -e '
const want = ["MEITUAN_SKIP_STORES","SHANGOU_STORES","ELEME_SKIP_STORES",
              "GZGROCERY_ORDER_MODE","GUANYI_PICKUP_MODE",
              "MEITUAN_AUTO_ACCEPT","MEITUAN_WRITEBACK"];
const d = JSON.parse(require("fs").readFileSync(0,"utf8"));
for (const p of d) {
  const e = p.pm2_env || {};
  const hits = want.filter(k => e[k] !== undefined);
  console.log(`${p.name}  [${e.status}]  uptime=${e.pm_uptime ? new Date(e.pm_uptime).toISOString() : "?"}`);
  for (const k of want) console.log(`    ${k.padEnd(24)} ${e[k] === undefined ? "(not in process env)" : JSON.stringify(e[k])}`);
}'
```

Whitelisted to those seven names — no other environment value is read or
printed.

### 2c. Which daemons are actually running

```bash
pm2 list
```

Expect, if everything is up: `roots-v2`, `meituan-sync`, `shangou-sync`,
`eleme-sync`, `guanyi-sync`, `gzgrocery-orders`, `qingyun-sync`,
`proxy-watchdog`, plus the `shangou-chrome` / `qingyun-chrome` holders. Note
anything `stopped` or missing.

**Which wins at runtime, if a value appears in more than one place:** the
process environment (2b) wins over the file (2a). Within the file, the daemons'
own parser takes the **first** match — `dotenv` does not overwrite an existing
`process.env` key, and the manual fallback assigns in file order, so a duplicated
key later in `.env` is ignored by dotenv and applied by the fallback. If 2a shows
a duplicate, treat 2b as the truth.

---

## 3. Verdict per guard

| Guard | Verdict | Evidence |
|---|---|---|
| **闪购 side — `SHANGOU_STORES`** | **HOLDING** | Defaults to `'yuexiu'` at `scripts/shangou-daemon.js:54`, which is the correct value for Roots' current shape. It holds whether or not it is set, and every failure mode either preserves it or makes 闪购 do nothing (safe). |
| **外卖 side — `MEITUAN_SKIP_STORES`** | **CANNOT DETERMINE** | The value is not visible from the repository. Stated per the rule that a missing value is not holding: **if 2a/2b return `(UNSET)`, this guard is NOT HOLDING** — the default is empty, and empty means the 外卖 daemon includes `yuexiu`. This is the highest-risk unknown in this document. |
| **gzgrocery double-count guard** | **CANNOT DETERMINE** | Requires both values. Note that it is only *engaged at all* when `GZGROCERY_ORDER_MODE=live`; at `shadow` no stock moves from the order reader, so the pickup inference cannot double anything. |
| **`GZGROCERY_ORDER_MODE`** | **NOT `off`** — determined | See §4. The operator's report of arriving orders is only possible if the daemon ran a cycle, which is impossible at `off`. Whether it is `shadow` or `live` is **CANNOT DETERMINE**. |
| **`GUANYI_PICKUP_MODE`** | **CANNOT DETERMINE**, but **not `off`** on the balance of evidence | The pickup-inference bad-read guard fired twice on 2026-08-29 (operator screenshots, 10:55 and 18:07, tianhe, 184 products). That code path sits inside `processPickupReconcile()`, which the daemon only enters when the mode is not `off`. Confirm with 2a/2b. |
| **Which daemons are running** | **CANNOT DETERMINE** | No ecosystem file, no unit files, no repo-side record. `pm2 list` (2c) is the only source. |
| **`ELEME_SKIP_STORES`** | **HOLDING (vacuously)** | Fails open by the same mechanism as `MEITUAN_SKIP_STORES`, but there is only one Eleme daemon, so there is nothing for it to collide with today. It becomes a real guard the moment a second Eleme process exists. |
| **`MEITUAN_AUTO_ACCEPT`** | **HOLDING** | Requires the exact string `'1'`. Every other state, including unset, leaves it off. |
| **`MEITUAN_WRITEBACK`** | **HOLDING** | Same construction. |
| **`GZGROCERY_ADMIN_URL`** | **HOLDING** | The only guard that throws rather than degrading (`lib/gzgrocery-admin.js:38`). |
| **`GZGROCERY_ADMIN_USER` / `_PASS`** | **CANNOT DETERMINE** | If absent, the daemon logs a warning at startup and then runs anyway, failing every cycle at login. §4's evidence implies they are set. |

---

## 4. Has the OpenCart login ever run?

**Yes. It is running now.** This is a determination, not an inference from
configuration.

**The chain.** At `GZGROCERY_ORDER_MODE=off`, `runCycle()` returns at
`scripts/gzgrocery-order-daemon.js:548`, fifteen lines before
`new GzGroceryAdmin()` at `:563`. No client, no login, no HTTP request. So if
anything at all has reached our system from gzgrocery's OpenCart admin, the mode
is not `off`.

**The operator reports gzgrocery orders are arriving.** Orders can only arrive
through this daemon. The OpenCart client is the only code in the tree that reads
gzgrocery's storefront, and the two things an operator would see —
the WeCom order card (`notifyOrder`, `:507`) and the row in the combined orders
list (`ensureGzMirror`, `:510`) — are both written inside `processOrder`, which
is only reachable from `runCycle`.

**So: `GZGROCERY_ORDER_MODE` is `shadow` or `live`. It is not `off`.** The
OpenCart login path has executed in production, successfully, at least once.

**The two do not disagree — but the reconciliation narrows less than it looks.**
Both signals the operator sees are written **regardless of mode**:

```js
// scripts/gzgrocery-order-daemon.js:493-511 — only adjustStock is gated
if (MODE === 'live') {
  adjustStock({ storeId, productId: it.product_id, newPhysicalQty: next, ... });
}
...
upsert({ decremented: 1, note: `${MODE}: decremented ${applied.join(', ')}` });
notifyOrder(o, ...)          // fires in shadow too
ensureGzMirror({ ... })      // fires in shadow too
```

**Arriving orders therefore prove the daemon is running. They prove nothing
about whether stock is moving.** In `shadow` the operator sees exactly the same
cards and exactly the same order rows, and no stock is deducted at all. The
distinction is invisible from the surfaces an operator looks at, and it is
precisely the distinction that decides whether the double-count guard is
engaged.

**Correction to an earlier claim of mine.** `docs/channel-sync-audit.md` §3.2 and
`docs/channel-sync-architecture.md` §6b both state that on the default
configuration this login has never run. That statement was conditional on the
default being in force. **The default is not in force**, and both documents
should be read with that correction. What remains true, and is unaffected, is
the separate point that a *successful re-login after an expiry* leaves no trace —
`login()` is called silently from `_get()` with no log line, counter or audit
row — so "the login works" and "the login recovers unaided from an expiry"
remain two different claims, and only the first is now established.

---

## 5. Exposure

Two guards could currently be failing. Here is what each would mean, and how to
check whether it actually happened.

### 5.1 If `MEITUAN_SKIP_STORES` is unset

**What would be happening.** The 外卖 daemon (`meituan-sync`) includes `yuexiu`
in its store list, alongside the 闪购 daemon which owns it. Two processes then
work the same rows in `meituan_sync_queue` and read the same orders. Since the
audit found **no lock anywhere** and a non-atomic select-then-claim in both
(`scripts/meituan-daemon.js:845` then `:902`), nothing stops them.

**How long.** Since `yuexiu` was migrated to 闪购 — the schema comment dates the
Meituan sync to 2026-06-22 and the 闪购 daemon exists because of a later forced
migration, so potentially months. Unknowable without the value and a deploy
history.

**Most likely damage: a stock freeze, not a double-count.** `yuexiu`'s 外卖
session is logged out by definition — that is why it moved to 闪购. So the 外卖
daemon would claim a `yuexiu` queue row, set it to `processing`,
`attempts=attempts+1`, fail the push against a dead session, and burn the row to
terminal `error` after three tries. The 闪购 daemon never gets it. That product's
stock then sits frozen on 闪购 until the 30-minute drift sweep re-queues it — and
the race repeats.

**A real double-deduction path also exists, and it is worth naming even though
it is less likely here.** Order import is check-then-act with a slow async call
in the middle (`scripts/meituan-daemon.js:600-630`):

```js
const existing = db.prepare('SELECT id FROM meituan_order_import WHERE meituan_order_no = ?').get(order.meituanOrderNo);
if (existing) { await refreshOrderStatus(storeCode, order); continue; }
...
const rootsOrderId = await ingestOrder(storeId, storeCode, order);   // creates order, DEDUCTS STOCK
db.prepare(`INSERT OR IGNORE INTO meituan_order_import ...`).run(...);
```

The `UNIQUE` constraint on `meituan_order_no` protects the *ledger row*, not the
*work*. Two daemons seeing the same new order both pass the `SELECT`, both call
`ingestOrder` — **two `retail_orders` rows, stock deducted twice** — and then one
`INSERT OR IGNORE` wins and the other is silently discarded, leaving an orphaned
duplicate order that nothing points at. This requires the 外卖 daemon to actually
read the order, which a dead session prevents, so it is a latent rather than an
active risk on `yuexiu` — but it is live for any store both daemons can read.

**Read-only checks.** Run on the box; `-readonly` is enforced by SQLite itself.

Orphaned duplicate channel orders — a `retail_orders` row for a channel that no
import ledger row references:

```bash
sqlite3 -readonly /root/roots-v2/data/roots.db "
SELECT o.id, o.order_no, o.store_id, o.placed_at, o.total
  FROM retail_orders o
 WHERE o.channel = 'meituan'
   AND o.id NOT IN (SELECT retail_order_id FROM meituan_order_import WHERE retail_order_id IS NOT NULL)
 ORDER BY o.placed_at DESC LIMIT 50;"
```

Near-identical Meituan orders at one store — the shape a double ingest leaves:

```bash
sqlite3 -readonly /root/roots-v2/data/roots.db "
SELECT store_id, placed_at, total, COUNT(*) AS n, GROUP_CONCAT(order_no) AS order_nos
  FROM retail_orders
 WHERE channel = 'meituan'
 GROUP BY store_id, placed_at, total
HAVING n > 1
 ORDER BY placed_at DESC LIMIT 50;"
```

Two ledger deductions against the same order:

```bash
sqlite3 -readonly /root/roots-v2/data/roots.db "
SELECT ref_table, ref_id, product_id, COUNT(*) AS n, SUM(delta) AS total_delta
  FROM retail_stock_ledger
 WHERE ref_table = 'retail_orders' AND delta < 0
 GROUP BY ref_table, ref_id, product_id
HAVING n > 1
 ORDER BY ref_id DESC LIMIT 50;"
```

Queue rows that went terminal on the contested store:

```bash
sqlite3 -readonly /root/roots-v2/data/roots.db "
SELECT store_code, status, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(processed_at) AS newest
  FROM meituan_sync_queue
 GROUP BY store_code, status
 ORDER BY store_code, status;"
```

A cluster of `status='error'` rows on `yuexiu` with `last_error` mentioning login
or session would be the signature of the two daemons colliding.

**Results: not run.** I have no database access from this environment.

### 5.2 If both gzgrocery modes are `live`

**What would be happening.** Every gzgrocery sale deducted twice — once when the
order reader sees the paid order, again when gzgrocery fulfils it, the Guanyi
on-hand drops, and the pickup inference reads that drop as a fresh sale. Stock
would drift steadily low, and because the corrected number is pushed onward to
Meituan and Eleme, the error would propagate to every channel.

**How long.** Since whenever the order reader was moved off `off`. Not
determinable from the repository.

**A partial mitigation exists and would blunt but not prevent it.**
`GUANYI_PICKUP_CAP` (default 50, `scripts/guanyi-daemon.js:74`) flags rather than
applies a single drop larger than the cap, and the settle window
(`GUANYI_SETTLE_TIMEOUT_MS`, default 180 s) suppresses inference against a number
our own push has not yet settled. Neither addresses a genuine second reading of a
real sale, which is what this failure produces.

**Read-only checks.**

Both deduction reasons hitting the same product on the same day is the signature:

```bash
sqlite3 -readonly /root/roots-v2/data/roots.db "
SELECT DATE(created_at) AS day, product_id,
       SUM(CASE WHEN reason = 'gzgrocery_order' THEN -delta ELSE 0 END) AS from_order_read,
       SUM(CASE WHEN reason LIKE '%pickup%'     THEN -delta ELSE 0 END) AS from_drift
  FROM retail_stock_ledger
 WHERE delta < 0
   AND (reason = 'gzgrocery_order' OR reason LIKE '%pickup%')
   AND created_at >= DATE('now','-30 day')
 GROUP BY day, product_id
HAVING from_order_read > 0 AND from_drift > 0
 ORDER BY day DESC LIMIT 100;"
```

Any row with both columns non-zero is a candidate double-count.

What the pickup inference has actually applied, by mode:

```bash
sqlite3 -readonly /root/roots-v2/data/roots.db "
SELECT mode, action, COUNT(*) AS n, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
  FROM guanyi_pickup_log
 WHERE created_at >= DATE('now','-30 day')
 GROUP BY mode, action ORDER BY mode, action;"
```

`mode='live'` with `action='decremented'` means it is moving stock. `mode='shadow'`
with `action='would_decrement'` means it is not. **This query also answers
`GUANYI_PICKUP_MODE` directly from the data**, without reading the environment.

What the order reader has applied, by mode — the same trick for the other half:

```bash
sqlite3 -readonly /root/roots-v2/data/roots.db "
SELECT mode, action, COUNT(*) AS n, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
  FROM gzgrocery_order_log
 WHERE created_at >= DATE('now','-30 day')
 GROUP BY mode, action ORDER BY mode, action;"
```

`action='decremented'` ⇒ `live`. `action='would_decrement'` ⇒ `shadow`. Between
them, these two queries settle the double-count guard from the database alone —
**run these first; they are faster and more trustworthy than reading `.env`,
because they record what the code actually did rather than what it was told.**

Impossible stock, as a blunt check for drift of any cause:

```bash
sqlite3 -readonly /root/roots-v2/data/roots.db "
SELECT store_id, product_id, physical_qty
  FROM retail_store_stock
 WHERE physical_qty < 0
 ORDER BY physical_qty ASC LIMIT 50;"
```

Note this may return nothing even if double-counting occurred: the order reader
clamps at zero (`Math.max(0, cur - it.qty)`, `:493`) and so does the pickup
inference. **A clean result here is not evidence of absence.**

**Results: not run.** No database access from this environment.

---

## 6. Defaults audit — fresh deploy, nothing set

**It fails open, with two narrow exceptions.**

| What | Fresh-deploy behaviour | Code path |
|---|---|---|
| Daemons starting | **Nothing starts.** No ecosystem file; `deploy-apply.sh` only restarts what already exists (`:256`). A fresh box runs no daemons until someone types `pm2 start` six times | fail-closed, but by absence rather than design |
| 外卖 / 闪购 split | **FAILS OPEN.** `MEITUAN_SKIP_STORES` defaults to empty → 外卖 daemon claims every active store including any on 闪购 | `scripts/meituan-daemon.js:62` |
| 闪购 scope | Fails safe — defaults to `'yuexiu'`, which on a fresh non-Roots deploy means it manages a store that does not exist and does nothing | `scripts/shangou-daemon.js:54` |
| gzgrocery order reader | Fails safe — `off` | `scripts/gzgrocery-order-daemon.js:50` |
| Guanyi pickup inference | Fails safe — `off` | `scripts/guanyi-daemon.js:70` |
| Meituan auto-accept / writeback | Fail safe — require exact `'1'` | `scripts/meituan-daemon.js:81`; `routes/retail.js:23538` |
| gzgrocery admin URL | **Fails closed** — throws | `lib/gzgrocery-admin.js:38` |
| gzgrocery admin credentials | Fails open — warns once, then runs and fails every cycle | `scripts/gzgrocery-order-daemon.js:623-625` |
| Channel feature switches | Fail safe — absent config row reads false | `routes/meituan-admin.js:318`; `lib/eleme-sync.js:15` |

**The pattern.** Guards that turn a feature *on* fail safe, because their default
is off. The one guard that partitions work between two processes — the only guard
here whose job is mutual exclusion — fails **open**, because its default is an
empty list and an empty exclusion list excludes nothing.

**There is no startup validation anywhere.** No daemon checks that its
configuration is coherent, that a paired daemon agrees with it, or that a store
code it was handed exists. `GZGROCERY_ADMIN_URL` throwing is the only
configuration error in this set that stops anything.

---

## 7. Two loose threads

### 7a. Commit `b83fd15` — what was silenced

**Commit:** `b83fd15d4509de7d511441dae4eb3b54734c12bc`, *"Stop paging WeCom for
the Guanyi bad-read-guard resync notice"*, 2026-08-30 13:10:56 UTC.
**Diff: `scripts/guanyi-daemon.js` only, 5 insertions, 4 deletions.** One
`sendOpsAlert(...)` call removed, replaced by a five-line comment.

Removed verbatim:

```js
sendOpsAlert(
  `🟠 管易 ${storeCode} 取货推断基准已重置:${rebased} 个商品(连续 ${trips} 次读数一致,未推断任何取货)\n` +
  `Guanyi ${storeCode} pickup baselines re-synced to live stock — ${rebased} product(s) after ${trips} identical reads; no pickup was inferred from the gap.`
);
```

**This is the exact message in the operator's 2026-08-29 screenshots** — which
also dates them: they predate this commit by about a day, when the notice was
still paging.

**Was anything else silenced? No.** The commit touches one file and removes one
call. `log()` and `logSync(storeCode, 'pickup_guard', 'resync', …)` on the two
preceding lines are untouched, so the event still reaches the server log and
`guanyi_sync_log`. The `pickup_guard`/`skip` branch above it and every other
`sendOpsAlert` in the daemon are unchanged.

**Deliberate or incidental? Deliberate, and reasoned.** The commit message gives
the rationale, and a comment was added in place of the call stating the same
thing — that this branch is the guard working as intended, nothing was lost, and
no action is available to an operator, unlike a channel disconnect or proxy
outage.

**One consequence worth stating plainly, without disputing the reasoning.** The
argument is about *this notice*, and it is sound on its own terms. But the notice
was, in practice, the only thing making the pickup inference's activity visible
to a person — it is what put those screenshots in front of the operator. After
this commit, the inference re-baselining after a session gap is a
`guanyi_sync_log` row that nothing surfaces: the Guanyi admin tab shows the last
20 log rows with no filter for this, and the dashboard has no row for it. So the
mechanism is unchanged and now unobserved. That matters because
`docs/channel-sync-architecture.md` §6b schedules the inference for retirement
and requires it to run in shadow as the *control* for measuring the order
reader's coverage — a control nobody can see is not much of a control.

### 7b. `tianhe_qty` → `tacet_qty` — resolved: do not rename

The rename targets `guanyi_pickup_log.tianhe_qty`
(`scripts/guanyi-daemon.js:55`). That table belongs to the pickup inference,
which §6b of the architecture spec schedules for deletion.

**Resolution recorded: do not perform the rename. The table is being deleted.**
`docs/channel-sync-architecture.md` §18 has been updated to say so — the one
documentation edit made in this pass, per the brief. Everything else here is
report-only.

---

## ACT NOW

Ordered by risk. This list is not empty.

1. **Read `MEITUAN_SKIP_STORES` on the running `meituan-sync` process** (§2b). If
   it does not contain `yuexiu`, the 外卖 and 闪购 daemons have been contending for
   the same queue rows and the same orders, unguarded, for an unknown period.
   This is the only guard in the system whose job is mutual exclusion and whose
   default is to exclude nothing.

2. **Run the two log-mode queries in §5.2** — `gzgrocery_order_log` and
   `guanyi_pickup_log` grouped by `mode` and `action`. They settle the
   double-count guard from what the code actually did, which is better evidence
   than `.env`. If both show live decrements in the same period, gzgrocery sales
   have been counted twice and the stock error has propagated to Meituan and
   Eleme.

3. **Run the two duplicate-order queries in §5.1** regardless of what item 1
   returns. They cost nothing and they close out the check-then-act window in the
   order import, which is a real defect independent of any environment variable.

4. **Run `pm2 list`** (§2c) and confirm all six daemons plus the two browser
   holders are `online`. A daemon someone stopped stays stopped through every
   deploy, by design and by default, and `deploy-apply.sh` reports SUCCESS
   anyway.

5. **Decide whether the pickup-inference re-baseline needs a quieter home rather
   than none** (§7a). Silencing it was reasonable; leaving it entirely unobserved
   while it is also the designated control for retiring the inference is not.

Items 1–4 are read-only and can be done in a few minutes. Nothing here should be
fixed before it is measured — three of the five may well come back clean, and
which ones do changes what the fix is.
