# Runbook — 美团外卖 lost store binding (acctId/region)

**The alert:** `🔴 美团外卖 <store> 掉了门店绑定（acctId/区域丢失）…`
(`scripts/meituan-daemon.js`, `noteBindingResult`)

This is **not** a logout and **not** a captcha. Meituan keeps two things apart:

| | what it is | how it fails |
|---|---|---|
| **auth** | cookies / token | session expires → login page |
| **store context** | `acctId` + region (the poi the session points at) | dropped on its own — cookies stay perfectly valid |

When only the second one goes, the session still looks signed in everywhere that
checks auth, but every call that needs a store fails: order reads return
`code 10002 / SET REGION QUERY ERROR`, stock writes return
`code 30000 / 参数异常:acctId, 当前acctId为：【null】`. **Nothing syncs.** The store
keeps selling on Meituan against stock we can no longer update.

`_isBindingError` (`lib/meituan-browser.js`) matches exactly those two
signatures, deliberately narrowly, so a normal per-product rejection never trips
it. The daemon pages only after it has persisted 5 minutes, then re-nags every
`MEITUAN_BINDING_RENAG_MIN` (default 120) while the store is open.

## Why it happens

1. **The exit IP moved.** Both Meituan channels prefer the residential path
   (`lib/proxy-manager.js`); when it flaps, the watchdog fails 外卖 over to
   GZ→direct and 闪购 to direct. The same cookies then speak from a different IP
   and region. 闪购 answers that with a hard 403, 外卖 by dropping the region
   context. **Two channels degrading within the same few minutes is this.**
2. **The account was used elsewhere.** The same merchant login on the 商家版 app,
   a store tablet or the owner's PC moves the account's current 门店. Our session
   is left pointing nowhere. Nothing in our code re-selects a store — we inherit
   whatever poi the account last had.
3. **Server-side expiry** of the poi context on a long-lived session. Cookies
   rotate and get re-persisted every 30 min; the region context doesn't.

## Diagnose (2 minutes, on the box)

```sh
node scripts/meituan-login.js tianhe --check   # is it bound right now? (read-only)
cat data/proxy-active.json                     # did the exit IP move? → cause 1
pm2 logs meituan-sync --lines 2000 | grep -iE "binding|acctId|SET REGION|proxy switched"
```

A `proxy switched …` line just before the first binding error confirms cause 1. A
bare 10002 with no proxy event points at 2 or 3.

## Fix

**Order matters — fix the path before the login.** A session born on a datacenter
IP is what earns 验证中心/403 in the first place.

1. **Check the proxy is healthy** (`data/proxy-active.json`, the proxy-watchdog
   bot). If residential is down, deal with that first.
2. **Re-login, headed, through the same proxy the daemon uses** — Meituan needs a
   human for the QR/slider, so this runs on a machine with a display:
   ```sh
   ssh -L 8888:<gz-proxy>:8888 -N root@<box>
   MEITUAN_PROXY_URL=http://mtproxy:PASS@127.0.0.1:8888 node scripts/meituan-login.js tianhe
   ```
3. **Re-select the store.** After the QR, check the store picker (门店切换,
   top-left) is on the right 门店. This is the step the whole incident turns on:
   an account with several stores opens on whichever it used last. The script
   will not save the session until a real order read for that store succeeds, and
   it prints what to do if you're on the wrong one — so wait for
   `✅ SUCCESS — signed in, store binding verified`.
4. **Ship it:** `scp data/meituan-sessions/<store>-session.json` to the box's
   `data/meituan-sessions/`, then `pm2 restart meituan-sync`.
5. **Then stop.** Recovery verifies itself: the ~5 min order poll is the probe,
   a clean read clears the latch and posts `✅ 门店绑定已恢复`. Queued stock rows
   flush on their own — they were requeued `pending` with the attempt refunded, so
   nothing was lost, only delayed.

**Don't** delete session files or start fresh logins for other stores while you're
in there. A fresh login is the riskiest event on this integration.

## What the UI shows

While a store is unbound, its Channel Hub row reads **门店未绑定 / Store not
linked** with the re-select instruction — not "Signed in". That row is driven by
the `binding_lost` / `binding_cleared` events as a latch, not by timestamps: the
business-status endpoint answers off the `wmPoiId` cookie and keeps refreshing
`store_business_status.read_at` right through the outage, which is what used to
make a dead store render as healthy.

## Tests

`npm run test:meituan-binding` — offline, no browser. Covers the two live error
signatures, the four probe verdicts (bound / unbound / captcha / unreachable),
the rule that a login is never saved unbound, and the asymmetry that a
business-status read may flag a lost binding but never clear one.
