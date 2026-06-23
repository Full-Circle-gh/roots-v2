// Standalone Meituan product-list PROBE — for fast, iterative DOM diagnosis
// without touching the daemon's push loop. Restores the saved session
// (read-only: never overwrites it), opens the product list, searches for a
// product by name, and dumps everything needed to locate a row: the rendered
// candidate titles, whether the name is present, and the raw HTML of a row.
//
// Usage on the HK box (stop the daemon first so only one session is live):
//   pm2 stop meituan-sync
//   node scripts/meituan-probe.js tianhe "红扁豆汤Red Lentils Soup"
//   pm2 start meituan-sync
//
// It honours MEITUAN_PROXY_URL + the Tier 1/2 fingerprint via lib/meituan-browser,
// exactly like the daemon, so what it sees is what the daemon would see.

'use strict';

const path = require('path');
const fs   = require('fs');

// Load .env the same way the daemon does (dotenv, else manual parse).
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}
require('../database'); // hydrates integration env vars (proxy etc.) as a side effect

const { MeituanBrowser } = require('../lib/meituan-browser');
const MERCHANT_URL = 'https://e.waimai.meituan.com';

(async () => {
  const store = process.argv[2] || 'tianhe';
  const term  = process.argv[3] || '';
  if (!['tianhe', 'yuexiu'].includes(store)) {
    console.error('usage: node scripts/meituan-probe.js <tianhe|yuexiu> "<product name>"');
    process.exit(1);
  }
  console.log(`[probe:${store}] proxy = ${process.env.MEITUAN_PROXY_URL || '(none — DIRECT)'}`);
  console.log(`[probe:${store}] search term = ${JSON.stringify(term)}`);

  const b = new MeituanBrowser(store);
  await b.init(); // headless, restores saved session (not overwritten)

  if (!await b.ensureLoggedIn()) {
    console.log(`[probe:${store}] NOT logged in (session expired / challenged). Re-run meituan-login.js.`);
    await b.close(); process.exit(1);
  }

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await b.page.waitForTimeout(3500);

  const iframe = await b._getMainIframe();
  if (!iframe) { console.log(`[probe:${store}] no content iframe`); await b.close(); process.exit(1); }

  // A roo-modal (e.g. the 商品助手 promo) opens on load and its backdrop
  // intercepts every click. Inspect it, then dismiss it (safe buttons + close
  // icons) and neutralise any leftover backdrop so the page is interactable.
  const modalInfo = await iframe.evaluate(() => {
    const info = { backdrops: 0, modalText: '', buttons: [] };
    const bds = document.querySelectorAll('.roo-modal.backdrop, .roo-modal-backdrop, [class*="backdrop"]');
    info.backdrops = bds.length;
    const modal = document.querySelector('.roo-modal, [class*="modal"][class*="content"], [role="dialog"]');
    if (modal) {
      info.modalText = (modal.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      info.buttons = Array.from(modal.querySelectorAll('button, .roo-btn'))
        .map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 8);
    }
    return info;
  });
  console.log('[probe] modalInfo:', JSON.stringify(modalInfo));

  await iframe.evaluate(() => {
    const SAFE = ['我知道了','知道了','跳过','以后再说','关闭','下次再说','取消'];
    for (const el of document.querySelectorAll('button, .roo-btn, span, a, i')) {
      const t = (el.innerText || '').trim();
      if (SAFE.includes(t)) { try { el.click(); } catch (e) {} }
    }
    for (const ic of document.querySelectorAll('.roo-modal .roo-icon-close, .roo-modal-close, [class*="close"]')) {
      try { ic.click(); } catch (e) {}
    }
  });
  await iframe.waitForTimeout(700);
  // Hard fallback: hide any remaining modal/backdrop so it can't eat clicks.
  await iframe.evaluate(() => {
    for (const el of document.querySelectorAll('.roo-modal, [class*="backdrop"]')) {
      el.style.pointerEvents = 'none';
      el.style.display = 'none';
    }
  });
  await iframe.waitForTimeout(300);

  // Drive the search box with REAL Playwright keystrokes — synthetic input/Enter
  // events dispatched via evaluate don't trigger Meituan's (React) search, so the
  // list stays on the default category and the target never renders.
  // Search query = the leading same-script run of the name (CJK or Latin), so a
  // mapping like "红扁豆汤Red Lentils Soup" still searches "红扁豆汤" — Meituan's
  // search matches a substring of the title; an over-long query finds nothing.
  const coreQuery = (() => {
    const m = term.match(/^[一-鿿]+/) || term.match(/^[A-Za-z][A-Za-z ]*[A-Za-z]/) || term.match(/^[A-Za-z]+/);
    const c = m ? m[0].trim() : term;
    return c.length >= 2 ? c : term;
  })();
  if (term) {
    const sh = await iframe.$('input[placeholder="搜索商品或规格名称"]');
    if (!sh) { console.log('[probe] search box NOT found'); }
    else {
      await sh.click({ timeout: 8000 }).catch(e => console.log('[probe] search click failed:', e.message));
      await sh.fill('');               // clear any prior text
      await sh.type(coreQuery, { delay: 60 });
      await sh.press('Enter');
      console.log(`[probe] searched "${coreQuery}" (from "${term}") via Playwright`);
    }
    await iframe.waitForTimeout(3000); // results may lazy-load after the filter
  }

  // Run the PROPOSED matcher (read-only — does NOT click anything). Each product
  // card is div.product-card_*; its name is input.roo-input.value or the parent
  // [title]. Report every rendered product name and which card the matcher picks.
  const dump = await iframe.evaluate(({ cn, en }) => {
    const body = document.body.innerText || '';
    const out = {
      salesRows: (body.match(/月售/g) || []).length,
      productCards: [],
      matched: null,
    };
    const cardName = (card) => {
      const inp = card.querySelector('input.roo-input');
      if (inp && inp.value) return inp.value.trim();
      const tw = card.querySelector('[title]');
      return tw ? (tw.getAttribute('title') || '').trim() : '';
    };
    const cards = document.querySelectorAll('[class*="product-card"]');
    for (const card of cards) {
      const name = cardName(card);
      const hasCb = !!card.querySelector('input[type=checkbox]');
      if (name) out.productCards.push(name);
      const hit = name && (name.includes(cn) || (en && name.toLowerCase().includes(en.toLowerCase())));
      if (hit && !out.matched) out.matched = { name, hasCheckbox: hasCb };
    }
    return out;
  }, { cn: term, en: '' });

  console.log('───── PROBE RESULT ─────');
  console.log('searchedCore:', JSON.stringify(coreQuery));
  console.log('salesRows:', dump.salesRows);
  console.log('productCards rendered:', JSON.stringify(dump.productCards, null, 2));
  console.log('matched:', JSON.stringify(dump.matched));
  console.log('────────────────────────');

  await b.close();
  process.exit(0);
})().catch(e => { console.error('[probe] error:', e); process.exit(1); });
