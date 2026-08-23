// Standalone, headed Eleme (饿了么) store login — run on a machine WITH a display
// so staff can log in and clear any risk-control challenge themselves. Does NOT
// touch the database, so it runs anywhere the repo is checked out (shopId is
// passed on the command line — look it up from the eleme_shops table). Reuses
// lib/eleme-browser, so it honours ELEME_PROXY_URL and applies the same Tier 1/2
// fingerprint the daemon uses — the session is therefore "born" under the exact
// identity the daemon will restore.
//
// Usage (from the repo root):
//   node scripts/eleme-login.js tianhe 1304930646 --fresh
//
// On success the session is written to data/eleme-sessions/<store>-session.json.
// Copy that file to the HK box's data/eleme-sessions/ and restart eleme-sync.

const fs   = require('fs');
const path = require('path');
const { ElemeBrowser } = require('../lib/eleme-browser');

(async () => {
  const store  = process.argv[2];
  const shopId = process.argv[3];
  if (!store || !shopId) {
    console.error('usage: node scripts/eleme-login.js <storeCode> <shopId> [--fresh]');
    process.exit(1);
  }
  const fresh = process.argv.includes('--fresh');
  const sessionFile = path.join(__dirname, '..', 'data', 'eleme-sessions', `${store}-session.json`);

  console.log(`[login:${store}] shopId = ${shopId}`);
  console.log(`[login:${store}] proxy = ${process.env.ELEME_PROXY_URL || '(none — DIRECT, or the shared meituan proxy-manager choice if set)'}`);
  if (fs.existsSync(sessionFile)) {
    console.log(`[login:${store}] note: an existing session is kept and only overwritten on success.`);
  }
  console.log(`[login:${store}] A browser window will open on the Eleme merchant login. Log in and`);
  console.log(`[login:${store}] clear any risk-control challenge if one shows. Window stays open ~6 min.`);

  const b = new ElemeBrowser(store, shopId);
  await b.init({ headed: true, ignoreSession: fresh }); // visible window; --fresh = ignore saved cookies (file untouched until success)
  const ok = await b.interactiveLogin();

  if (ok) {
    console.log(`[login:${store}] ✅ SUCCESS — session saved to ${sessionFile}`);
    console.log(`[login:${store}] next: scp this file to the HK box and restart eleme-sync.`);
  } else {
    console.log(`[login:${store}] ❌ login did not complete (timeout or still challenged).`);
  }
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('[login] error:', e); process.exit(1); });
