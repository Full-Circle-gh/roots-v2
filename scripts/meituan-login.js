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

const fs   = require('fs');
const path = require('path');
const { MeituanBrowser } = require('../lib/meituan-browser');

(async () => {
  const store = process.argv[2];
  if (!store || !['tianhe', 'yuexiu'].includes(store)) {
    console.error('usage: node scripts/meituan-login.js <tianhe|yuexiu>');
    process.exit(1);
  }
  const sessionFile = path.join(__dirname, '..', 'data', 'meituan-sessions', `${store}-session.json`);

  console.log(`[login:${store}] proxy = ${process.env.MEITUAN_PROXY_URL || '(none — DIRECT)'}`);
  if (fs.existsSync(sessionFile)) {
    console.log(`[login:${store}] note: an existing session is kept and only overwritten on success.`);
  }
  console.log(`[login:${store}] A browser window will open. WAIT ~5s — a Meituan login FORM appears`);
  console.log(`[login:${store}] (loading mascot → brief blank → form; don't close it early).`);
  console.log(`[login:${store}] Log in with 账号登录 (account + password) OR 验证码登录 (phone + SMS).`);
  console.log(`[login:${store}] Solve the 验证中心 slider if it shows. Window stays open ~6 min.`);

  const b = new MeituanBrowser(store);
  await b.init({ headed: true, ignoreSession: true }); // visible window, fresh cookies, file untouched
  const ok = await b.interactiveLogin();               // keeps window open ~6 min for login + slider

  if (ok) {
    console.log(`[login:${store}] ✅ SUCCESS — session saved to ${sessionFile}`);
    console.log(`[login:${store}] next: scp this file to the HK box and restart meituan-sync.`);
  } else {
    console.log(`[login:${store}] ❌ login did not complete (timeout or still challenged).`);
  }
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('[login] error:', e); process.exit(1); });
