// READ-ONLY: open a product's editor and dump the exact DOM of the 库存设置
// (stock) module, so we can see precisely how 剩余 / 最大 / auto-replenish are
// wired before writing any interaction. Performs NO writes.
//
// Usage on the HK box:
//   pm2 stop meituan-sync
//   node scripts/meituan-dump-stockdom.js tianhe "红扁豆汤"
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
  const name  = process.argv[3] || '红扁豆汤';
  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

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
  await frame.waitForTimeout(1500);
  const optSel = '.roo-autoComplete-option,[class*="autocomplete"] li,[class*="autoComplete"] [class*="option"],ul[role="listbox"] li,[class*="dropdown"] li';
  for (const oh of await frame.$$(optSel)) {
    const t = ((await oh.innerText().catch(()=> '')) || '').trim();
    if (t.includes(name)) { await oh.click({ timeout: 5000 }).catch(()=>{}); break; }
  }
  await frame.waitForSelector('input[class*="inventory-input"]', { timeout: 12000 }).catch(()=>{});
  await frame.waitForTimeout(800);

  const out = await frame.evaluate(() => {
    const inv = document.querySelector('input[class*="inventory-input"]');
    if (!inv) return { error: 'no inventory input' };
    // Walk up to the module that contains the 库存设置 label.
    let mod = inv;
    for (let i = 0; i < 14 && mod.parentElement; i++) {
      mod = mod.parentElement;
      if (/库存设置/.test(mod.innerText || '')) break;
    }
    // Full attribute dump of every form control inside the module.
    const controls = Array.from(mod.querySelectorAll('input,select,button,[role="radio"],[role="checkbox"],[class*="roo-switch"],[class*="roo-radio"],[class*="roo-checkbox"]'))
      .map(el => {
        const a = {};
        for (const at of el.attributes) a[at.name] = at.value.slice(0, 60);
        return { tag: el.tagName, text: (el.innerText||'').replace(/\s+/g,' ').trim().slice(0,30),
                 value: el.value, checked: el.checked, disabled: el.disabled, readOnly: el.readOnly, attrs: a };
      }).slice(0, 40);
    return {
      moduleClass: (mod.className||'').toString().slice(0,60),
      moduleText: (mod.innerText||'').replace(/\s+/g,' ').trim().slice(0,300),
      controls,
      html: mod.outerHTML.slice(0, 6000),
    };
  });

  console.log('───── STOCK MODULE TEXT ─────');
  console.log(out.moduleText);
  console.log('───── CONTROLS ─────');
  console.log(JSON.stringify(out.controls, null, 2));
  console.log('───── OUTER HTML (truncated 6k) ─────');
  console.log(out.html);
  console.log('─────────────────────────────');

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
