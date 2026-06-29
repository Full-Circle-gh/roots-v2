// Seed a 闪购 session into the running genuine Chrome over CDP, then verify login.
// Lets us put a logged-in session onto the box WITHOUT a box-side interactive login
// (which a headless Xvfb box can't do): export cookies from a logged-in Chrome
// elsewhere (scripts/_export_session.js), scp the JSON, run this on the box.
//
//   node scripts/shangou-inject.js /path/to/shangou-session.json

'use strict';
const fs = require('fs');
const pw = require('playwright');
const CDP = process.env.SHANGOU_CDP_URL || 'http://127.0.0.1:9333';

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/shangou-inject.js <session.json>'); process.exit(1); }
  const sess = JSON.parse(fs.readFileSync(file, 'utf8'));

  const browser = await pw.chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];

  // Add cookies; fall back to one-by-one so a single malformed cookie can't abort all.
  try { await ctx.addCookies(sess.cookies); }
  catch (e) {
    let ok = 0;
    for (const c of sess.cookies) { try { await ctx.addCookies([c]); ok++; } catch (_) {} }
    console.log(`addCookies fell back to per-cookie: ${ok}/${sess.cookies.length} added (${e.message})`);
  }

  const page = ctx.pages().find(p => p.url().includes('meituan')) || ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://shangoue.meituan.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('nav:', e.message));
  await page.waitForTimeout(4000);
  console.log('url:', page.url(), '| webdriver:', await page.evaluate(() => navigator.webdriver));

  const { ShangouBrowser } = require('../lib/shangou-browser');
  const sb = new ShangouBrowser('yuexiu');
  await sb.connect();
  const loggedIn = await sb.isLoggedIn();
  console.log('loggedIn:', loggedIn);
  if (loggedIn) {
    const prods = await sb.getProducts();
    console.log(`getProducts: ${prods.length} skus (sample: ${prods.slice(0, 2).map(p => p.spuName).join(' | ')})`);
  }
  await browser.close().catch(() => {});
  process.exit(loggedIn ? 0 : 2);
})().catch(e => { console.error('inject error:', e.message); process.exit(1); });
