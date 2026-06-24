// Standalone, headed Guanyi (gzgrocery) login — run on a machine WITH a display
// so a human can type the account + password themselves (we never automate
// credential entry). Does NOT touch the database; it only writes the session.
//
// Usage (from the repo root):
//   node scripts/guanyi-login.js tianhe
//
// On success the session is written to data/guanyi-sessions/<store>-session.json.
// Copy that file to the production box's data/guanyi-sessions/ and restart the
// daemon:  pm2 restart guanyi-sync  (or start it the first time).

const fs   = require('fs');
const path = require('path');
const { GuanyiBrowser } = require('../lib/guanyi-browser');

(async () => {
  const store = process.argv[2] || process.env.GUANYI_STORE_CODE || 'tianhe';
  const sessionFile = path.join(__dirname, '..', 'data', 'guanyi-sessions', `${store}-session.json`);

  console.log(`[guanyi-login:${store}] proxy = ${process.env.GUANYI_PROXY_URL || '(none — DIRECT)'}`);
  if (fs.existsSync(sessionFile)) {
    console.log(`[guanyi-login:${store}] note: an existing session is kept and only overwritten on success.`);
  }
  console.log(`[guanyi-login:${store}] A browser window will open at v2.guanyierp.com.`);
  console.log(`[guanyi-login:${store}] Log in with the Guanyi account + password (and SMS code if asked).`);
  console.log(`[guanyi-login:${store}] The window stays open ~6 min; it closes once the dashboard loads.`);

  const b = new GuanyiBrowser(store);
  await b.init({ headed: true, ignoreSession: true });  // visible, fresh cookies, file untouched until success
  const ok = await b.interactiveLogin();

  if (ok) {
    console.log(`[guanyi-login:${store}] ✅ SUCCESS — session saved to ${sessionFile}`);
    console.log(`[guanyi-login:${store}] next: scp this file to the box and restart guanyi-sync.`);
  } else {
    console.log(`[guanyi-login:${store}] ❌ login did not complete (timeout).`);
  }
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('[guanyi-login] error:', e); process.exit(1); });
