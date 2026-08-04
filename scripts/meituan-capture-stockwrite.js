// Capture the REAL payload Meituan uses to save MULTI-SPEC stock — WITHOUT
// persisting anything. Opens the product editor (the flow that reliably reaches
// the per-spec inventory inputs), sets two specs to distinct markers, clicks
// save, and intercepts every write POST (/w/ path): it LOGS the body and ABORTS
// the request, so nothing is actually written. Reads (editView/v2 etc.) pass
// through so the editor still loads.
//
//   pm2 stop meituan-sync
//   node scripts/meituan-capture-stockwrite.js tianhe "纯素椰子酸奶"
//   pm2 start meituan-sync
'use strict';

const path = require('path');
const fs   = require('fs');
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
require('../database');
const { MeituanBrowser } = require('../lib/meituan-browser');
const MERCHANT_URL = 'https://e.waimai.meituan.com';

function coreOf(term) {
  const m = term.match(/^[一-鿿]+/) || term.match(/^[A-Za-z][A-Za-z ]*[A-Za-z]/) || term.match(/^[A-Za-z]+/);
  const c = m ? m[0].trim() : term;
  return c.length >= 2 ? c : term;
}
async function productFrame(b) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await b.page.waitForTimeout(700);
    const frames = b.page.frames().filter(f =>
      f !== b.page.mainFrame() && f.url().includes('meituan.com') &&
      !f.url().startsWith('about:') && !f.url().includes('imChat'));
    for (const f of frames) {
      const hit = await f.$('input[placeholder="搜索商品或规格名称"]').catch(() => null);
      if (hit) return f;
    }
    const byUrl = frames.find(f => f.url().includes('region_id'));
    if (byUrl) return byUrl;
  }
  return null;
}

(async () => {
  const store = process.argv[2] || 'tianhe';
  const name  = process.argv[3] || '纯素椰子酸奶';
  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  // Intercept writes: log + abort every POST on a /w/ path (Meituan writes),
  // EXCEPT nothing — reads use /r/, so /w/ is always a write we want to block.
  const writes = [];
  await b.context.route('**/*', (route) => {
    const req = route.request();
    try {
      if (req.method() === 'POST' && /\/w\//.test(req.url())) {
        writes.push({ url: req.url().split('?')[0], body: req.postData() });
        console.log('\n>>> BLOCKED WRITE', req.url().split('?')[0]);
        console.log('BODY:', req.postData());
        return route.abort();
      }
    } catch (e) {}
    return route.continue();
  });

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await b.page.waitForTimeout(3500);
  const frame = await productFrame(b);
  if (!frame) { console.log('no content frame'); await b.close(); process.exit(1); }
  await frame.evaluate(() => {
    const SAFE = ['我知道了','知道了','跳过','以后再说','关闭','下次再说','取消'];
    for (const el of document.querySelectorAll('button,.roo-btn,span,a,i')) {
      if (SAFE.includes((el.innerText||'').trim())) { try { el.click(); } catch(e){} }
    }
    for (const el of document.querySelectorAll('.roo-modal,[class*="backdrop"]')) { el.style.display='none'; }
  }).catch(()=>{});

  const sh = await frame.$('input[placeholder="搜索商品或规格名称"]');
  await sh.click({ timeout: 8000 }).catch(()=>{});
  await sh.fill('');
  await sh.type(coreOf(name), { delay: 80 });
  await frame.waitForTimeout(1600);
  const optSel = '.roo-autoComplete-option,[class*="autocomplete"] li,[class*="autoComplete"] [class*="option"],ul[role="listbox"] li,[class*="dropdown"] li';
  let picked = false;
  for (const oh of await frame.$$(optSel)) {
    const t = ((await oh.innerText().catch(()=> '')) || '').trim();
    if (t.includes(name) || /椰子酸奶/.test(t)) { await oh.click({ timeout: 5000 }).catch(()=>{}); picked = true; console.log('[cap] picked suggestion:', t.slice(0,40)); break; }
  }
  if (!picked) console.log('[cap] no autocomplete match — editor may not open');

  await frame.waitForSelector('input[class*="inventory-input"]', { timeout: 15000 }).catch(()=>{});
  await frame.waitForTimeout(1000);

  // Set the per-spec inventory inputs to distinct markers.
  const invCount = await frame.locator('input[class*="inventory-input"]').count();
  console.log('[cap] inventory inputs found:', invCount);
  const markers = ['77', '33', '11', '22'];
  for (let i = 0; i < invCount && i < markers.length; i++) {
    try {
      const el = frame.locator('input[class*="inventory-input"]').nth(i);
      await el.click({ timeout: 4000 });
      await el.fill(markers[i]);
      console.log(`[cap] spec #${i} input -> ${markers[i]}`);
    } catch (e) { console.log('[cap] input set failed #' + i, String(e.message).slice(0,60)); }
  }
  await frame.waitForTimeout(800);

  // Click the editor's save button (write will be blocked + logged).
  let saved = false;
  for (const label of ['保存并上架','保存','提交','确定','保存商品']) {
    try {
      const btn = frame.locator(`text=${label}`).last();
      if (await btn.count() === 0) continue;
      await btn.click({ timeout: 4000 });
      console.log('[cap] clicked save button:', label);
      saved = true;
      break;
    } catch (e) {}
  }
  if (!saved) console.log('[cap] no save button clicked');

  await frame.waitForTimeout(4000);
  console.log('\n[cap] === blocked write POSTs:', writes.length, '===');
  for (const w of writes) console.log('\nURL:', w.url, '\nBODY:', w.body);

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
