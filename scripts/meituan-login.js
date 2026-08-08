// Standalone, headed Meituan store login — run on a machine WITH a display so
// staff can scan the QR (and solve any 验证中心 slider) themselves. Does NOT
// touch the database, so it runs anywhere the repo is checked out. It reuses
// lib/meituan-browser, so it honours MEITUAN_PROXY_URL (route through the GZ
// proxy) and applies the same Tier 1/2 fingerprint the daemon uses — the
// session is therefore "born" under the exact identity the daemon will restore.
//
// Usage (from the repo root, with the GZ proxy reachable locally):
//   ssh -L 8888:8.163.120.72:8888 -N root@47.239.89.63        # in one terminal
//   MEITUAN_PROXY_URL=http://mtproxy:PASS@127.0.0.1:8888 \
//     node scripts/meituan-login.js tianhe --fresh             # in another
//
// On success the session is written to data/meituan-sessions/<store>-session.json.
// Copy that file to the HK box's data/meituan-sessions/ and restart the daemon.
//
// A login is only "successful" here when the session is also BOUND to the store
// (acctId/region live) — being signed in is not enough, and a session saved
// unbound just makes the daemon page ops again five minutes later. The window
// therefore stays open, telling you to switch stores, until a real bound call
// succeeds. See lib/meituan-browser.probeBinding.
//
//   --check   don't log in: restore the EXISTING session headless and report
//             whether it is still bound. Safe to run against a live store — one
//             order-list read, the same call the daemon already makes every
//             ~5 min. Exit 0 = bound, 1 = not bound / unknown.

const fs   = require('fs');
const path = require('path');
const { MeituanBrowser } = require('../lib/meituan-browser');

(async () => {
  const store = process.argv[2];
  const args  = process.argv.slice(3);
  const check = args.includes('--check');
  if (!store || !['tianhe', 'yuexiu'].includes(store)) {
    console.error('usage: node scripts/meituan-login.js <tianhe|yuexiu> [--check]');
    process.exit(1);
  }
  const sessionFile = path.join(__dirname, '..', 'data', 'meituan-sessions', `${store}-session.json`);
  const tag = check ? `[check:${store}]` : `[login:${store}]`;

  console.log(`${tag} proxy = ${process.env.MEITUAN_PROXY_URL || '(none — DIRECT)'}`);

  // ── --check: report on the session already on disk, change nothing ─────────
  if (check) {
    if (!fs.existsSync(sessionFile)) {
      console.log(`${tag} no session file at ${sessionFile} — never logged in on this machine.`);
      process.exit(1);
    }
    const b = new MeituanBrowser(store);
    await b.init();                       // restores the saved session (headless)
    const probe = await b.probeBinding();
    await b.close();                      // close() won't persist an unbound session
    if (probe.bound) {
      console.log(`${tag} ✅ session is signed in AND bound${probe.poi ? ` (wmPoiId=${probe.poi})` : ''} — sync should be working.`);
      process.exit(0);
    }
    if (probe.loggedIn === false)   console.log(`${tag} ❌ session is NOT signed in — run a full login.`);
    else if (probe.verify)          console.log(`${tag} ⚠️ risk-control challenge (验证中心) — binding UNKNOWN; a human must pass the captcha.`);
    else if (probe.unreachable)     console.log(`${tag} ⚠️ no reply from Meituan (network/proxy) — binding UNKNOWN; check the proxy first.`);
    else                            console.log(`${tag} ❌ signed in but NOT bound to the store (code=${probe.code} ${probe.msg || ''}) — re-login and re-select the store.`);
    process.exit(1);
  }

  // ── full interactive login ─────────────────────────────────────────────────
  if (fs.existsSync(sessionFile)) {
    console.log(`${tag} note: an existing session is kept and only overwritten on success.`);
  }
  console.log(`${tag} A browser window will open. WAIT ~5s — a Meituan login FORM appears`);
  console.log(`${tag} (loading mascot → brief blank → form; don't close it early).`);
  console.log(`${tag} Log in with 账号登录 (account + password) OR 验证码登录 (phone + SMS).`);
  console.log(`${tag} Solve the 验证中心 slider if it shows. Window stays open ~6 min.`);
  console.log(`${tag} THEN: make sure the store picker (门店切换, top-left) is on ${store} —`);
  console.log(`${tag} an account with several 门店 opens on whichever one it used last, and a`);
  console.log(`${tag} session that isn't on ${store} syncs nothing. The session is NOT saved`);
  console.log(`${tag} until a real ${store} order read succeeds, so just switch stores and wait.`);

  const b = new MeituanBrowser(store);
  await b.init({ headed: true, ignoreSession: true }); // visible window, fresh cookies, file untouched
  const ok = await b.interactiveLogin();               // keeps window open ~6 min for login + slider

  if (ok) {
    console.log(`${tag} ✅ SUCCESS — signed in, store binding verified, session saved to ${sessionFile}`);
    console.log(`${tag} next: scp this file to the HK box and restart meituan-sync.`);
  } else {
    console.log(`${tag} ❌ login did not complete (timeout, still challenged, or never bound to ${store}).`);
    console.log(`${tag} nothing was saved — the previous session file is untouched.`);
  }
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('[login] error:', e); process.exit(1); });
