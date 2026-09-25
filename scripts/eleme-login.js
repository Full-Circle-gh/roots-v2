// Headed Eleme (饿了么 / 淘宝闪购) store login, for a human at a screen: the
// ops screen, Tacet's Sign in (§252, on the private display :98), or a laptop.
//
// §256 — IT OPENS A GENUINE CHROME, NOT A PLAYWRIGHT ONE. Alibaba's slider on the
// Eleme login rejected every human drag inside a Playwright-launched window
// ("验证失败，点击框体重试"), whatever the hand did: the automation switches and
// the driver's own CDP session are what it scores, not the drag. So this spawns
// the Chromium binary as a plain process (lib/genuine-chrome.js, the approach
// scripts/shangou-chrome.js already uses for 闪购), watches its tab list over
// Chrome's HTTP listing — which opens no CDP session, so nothing is attached while
// the human logs in — and only once the tab is on the shop dashboard does it
// attach, copy the storage state out, and close.
//
// The session file is the one lib/eleme-browser.js restores (its _saveSession
// writes context.storageState(), same shape). ksid is not stored: the daemon
// captures it from live traffic after restoring the cookies. The proxy is the one
// the daemon itself would use for this store (activeProxyRaw), so the session is
// born on the same exit IP it will be used from.
//
// Usage (from the repo root):
//   node scripts/eleme-login.js tianhe 1304930646
// Exit 0 once a session is saved, 1 otherwise. An existing session file is only
// overwritten on success. Window stays open ~6 min.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { activeProxyRaw, SESSION_DIR, MERCHANT_URL } = require('../lib/eleme-browser');
const { launchGenuineChrome, listTabs } = require('../lib/genuine-chrome');

const MAX_MS = 6 * 60 * 1000;
const POLL_MS = 2500;
const onShop = (u) => /\/app\/shop\/\d+/.test(u || '') && !/\/login/.test(u || '');

(async () => {
  const store = process.argv[2];
  const shopId = process.argv[3];
  if (!store || !/^[a-z0-9_-]{1,32}$/.test(store) || !shopId || !/^\d{1,20}$/.test(shopId)) {
    console.error('usage: node scripts/eleme-login.js <storeCode> <shopId>');
    process.exit(1);
  }
  const tag = `login:${store}`;
  const sessionFile = path.join(SESSION_DIR, `${store}-session.json`);
  // A fresh profile every time: a half-finished attempt must not carry over.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `eleme-login-${store}-`));
  const port = 9500 + Math.floor(Math.random() * 400);
  const chrome = launchGenuineChrome({
    startUrl: `${MERCHANT_URL}/app/shop/${shopId}`,
    profileDir, port, proxyPort: port + 1000,
    upstream: activeProxyRaw(store), tag,
  });

  let ok = false;
  const deadline = Date.now() + MAX_MS;
  try {
    console.log(`[${tag}] window open — log in and pass any slider; waiting for the shop dashboard…`);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (chrome.child.exitCode != null) { console.log(`[${tag}] the window was closed`); break; }
      const tabs = await listTabs(port);
      if (!tabs.some((t) => t.type === 'page' && onShop(t.url))) continue;

      // Logged in. Only now does anything attach to the browser.
      const { chromium } = require('playwright');
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      try {
        const ctx = browser.contexts()[0];
        const state = ctx ? await ctx.storageState() : null;
        if (!state || !Array.isArray(state.cookies) || !state.cookies.some((c) => /ele\.me$/.test(c.domain))) {
          console.log(`[${tag}] on the dashboard but no Eleme cookies yet — waiting`);
          continue;
        }
        if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.writeFileSync(sessionFile, JSON.stringify(state));
        ok = true;
        console.log(`[${tag}] ✅ SUCCESS — session saved to ${sessionFile}`);
      } finally {
        try { await browser.close(); } catch (_) { /* the attach is dropped with Chrome below */ }
      }
      break;
    }
    if (!ok && Date.now() >= deadline) console.log(`[${tag}] ❌ timed out waiting for the shop dashboard`);
  } catch (e) {
    console.error(`[${tag}] error: ${e.message}`);
  } finally {
    chrome.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { /* a temp dir; the OS clears it */ }
  }
  process.exit(ok ? 0 : 1);
})();
