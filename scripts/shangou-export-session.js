// Export a logged-in 闪购 session from a GENUINE Chrome (over CDP) to a JSON file
// that scripts/shangou-inject.js can replay onto the box's Chrome.
//
// Run this on a machine where you've just logged into 闪购 in a real Chrome that
// was launched with a debug port + persistent profile, e.g.:
//
//   chrome.exe --remote-debugging-port=9333 ^
//     --user-data-dir="C:\Users\Asher\meituan-shangou-profile" ^
//     --no-first-run --no-default-browser-check https://shangoue.meituan.com/
//
// then, after logging in (account 19924756828, staff enters SMS/captcha):
//
//   node scripts/shangou-export-session.js            -> writes ./shangou-session.json
//   node scripts/shangou-export-session.js C:\tmp\s.json
//
// It connects to the SAME debug port (SHANGOU_CDP_URL, default :9333), grabs all
// meituan cookies, sanity-checks that the session is actually logged in, and
// writes { cookies: [...] }. NEVER writes a logged-out snapshot unless you pass
// --force (so you can't accidentally ship junk that wipes the good box session).

'use strict';
const fs = require('fs');
const pw = require('playwright');

const CDP   = process.env.SHANGOU_CDP_URL || 'http://127.0.0.1:9333';
const force = process.argv.includes('--force');
const out   = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'shangou-session.json';

(async () => {
  let browser;
  try {
    browser = await pw.chromium.connectOverCDP(CDP);
  } catch (e) {
    console.error(`could not attach to Chrome at ${CDP} — is it running with --remote-debugging-port? (${e.message})`);
    process.exit(1);
  }
  const ctx = browser.contexts()[0];
  if (!ctx) { console.error('no browser context on the CDP target'); process.exit(1); }

  // Grab every cookie, keep only meituan-domain ones (the session spans
  // .meituan.com / shangoue / waimaie / epassport).
  const all = await ctx.cookies();
  const cookies = all.filter(c => String(c.domain || '').includes('meituan'));
  console.log(`cookies: ${cookies.length} meituan (of ${all.length} total)`);

  // Sanity-check the session is logged in BEFORE writing, using the real lib path.
  let loggedIn = false;
  try {
    const { ShangouBrowser } = require('../lib/shangou-browser');
    const sb = new ShangouBrowser('yuexiu');
    await sb.connect();
    loggedIn = await sb.isLoggedIn();
  } catch (e) { console.log('login check error:', e.message); }
  console.log('loggedIn:', loggedIn, loggedIn ? '' : '(data API not returning code:0 — session may be logged out OR risk-flagged)');

  if (!loggedIn && !force) {
    console.error('REFUSING to write a session that is not confirmed logged in. Re-log in the Chrome, or pass --force to write anyway.');
    await browser.close().catch(() => {});
    process.exit(2);
  }

  fs.writeFileSync(out, JSON.stringify({ cookies }, null, 2));
  console.log(`wrote ${out} (${cookies.length} cookies)${loggedIn ? '' : ' [FORCED — unverified]'}`);
  await browser.close().catch(() => {});
  process.exit(0);
})().catch(e => { console.error('export error:', e.message); process.exit(1); });
