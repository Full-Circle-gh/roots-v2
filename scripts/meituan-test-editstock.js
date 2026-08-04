// Standalone WRITE test for the edit-page stock flow discovered via the probe.
// Verifies the full path on a real product, then RESTORES the original value:
//   list → product content frame → type name → click autocomplete suggestion →
//   product editor → set 剩余 (remaining) inventory input → 保存.
//
// Usage on the HK box (stop the daemon first so only one session is live):
//   pm2 stop meituan-sync
//   node scripts/meituan-test-editstock.js tianhe "红扁豆汤" 9999
//   pm2 start meituan-sync
//
// The 3rd arg is the TEST value to write; the script reads the current value,
// writes the test value, confirms it persisted, then writes the original back.
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

// ── helpers reused from the probe ───────────────────────────────────────────
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
  // Diagnostic on timeout: show what frames actually loaded.
  try {
    console.log('[test] productFrame TIMEOUT. page.url=', b.page.url());
    console.log('[test] frames:', JSON.stringify(b.page.frames().map(f => f.url().slice(0, 80))));
  } catch (e) {}
  return null;
}

async function dismissModal(frame) {
  await frame.evaluate(() => {
    const SAFE = ['我知道了','知道了','跳过','以后再说','关闭','下次再说','取消'];
    for (const el of document.querySelectorAll('button, .roo-btn, span, a, i')) {
      const t = (el.innerText || '').trim();
      if (SAFE.includes(t)) { try { el.click(); } catch (e) {} }
    }
    for (const el of document.querySelectorAll('.roo-modal, [class*="backdrop"]')) {
      el.style.pointerEvents = 'none'; el.style.display = 'none';
    }
  }).catch(() => {});
}

// Navigate list → search → click suggestion → wait for editor. Returns the frame.
async function openEditor(b, cn) {
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await b.page.waitForTimeout(3500);
  let frame = await productFrame(b);
  if (!frame) {
    // Coming from editView, the hash change may not reload the content iframe —
    // force a hard reload and try once more.
    console.log('[test] content frame missing — hard reloading…');
    await b.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await b.page.waitForTimeout(3500);
    frame = await productFrame(b);
  }
  if (!frame) { console.log('[test] no product content frame'); return null; }
  await dismissModal(frame);

  const sh = await frame.$('input[placeholder="搜索商品或规格名称"]').catch(() => null);
  if (!sh) { console.log('[test] product search box not found'); return null; }
  await sh.click({ timeout: 8000 }).catch(() => {});
  await sh.fill('');
  await sh.type(coreOf(cn), { delay: 80 });
  await frame.waitForTimeout(1500);

  const optSel = '.roo-autoComplete-option, [class*="autocomplete"] li, [class*="autoComplete"] [class*="option"], ul[role="listbox"] li, [class*="dropdown"] li';
  const opts = await frame.$$(optSel);
  let clicked = null;
  for (const oh of opts) {
    const txt = ((await oh.innerText().catch(() => '')) || '').trim();
    if (txt.includes(cn)) { await oh.click({ timeout: 5000 }).catch(() => {}); clicked = txt; break; }
  }
  if (!clicked) { console.log('[test] no autocomplete suggestion matched', JSON.stringify(cn)); return null; }
  console.log('[test] opened editor via suggestion:', JSON.stringify(clicked.replace(/\s+/g, ' ')));

  // Wait for the editor's inventory input to appear.
  try {
    await frame.waitForSelector('input[class*="inventory-input"]', { timeout: 12000 });
  } catch { console.log('[test] inventory input never appeared'); return null; }
  return frame;
}

// Read the first inventory input (剩余 / remaining).
async function readStock(frame) {
  return frame.evaluate(() => {
    const inp = document.querySelector('input[class*="inventory-input"]');
    return inp ? inp.value : null;
  });
}

// Full inventory field state for diagnosis.
async function readFields(frame) {
  return frame.evaluate(() => {
    const wrap = document.querySelector('[class*="field-wrapper"]') &&
      Array.from(document.querySelectorAll('[class*="field-wrapper"]'))
        .find(w => /库存/.test(w.innerText || ''));
    const invs = Array.from(document.querySelectorAll('input[class*="inventory-input"]'))
      .map(i => ({ cls: (i.className||'').toString().slice(0,40), value: i.value, disabled: i.disabled }));
    const radios = Array.from(document.querySelectorAll('input.roo-radio-input'))
      .map(r => ({ value: r.value, checked: r.checked }));
    const checks = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .map(c => ({ checked: c.checked }));
    return {
      label: wrap ? (wrap.innerText || '').replace(/\s+/g,' ').trim().slice(0,120) : '',
      inventoryInputs: invs, radios, checkboxes: checks,
    };
  });
}

// Set 剩余 to qty using REAL Playwright keystrokes (faithfully triggers React),
// WITHOUT touching the 按总数/按日期 radio, then click 保存.
async function setStockAndSave(frame, qty) {
  // Set BOTH inventory inputs (剩余 = remaining, 最大 = replenish cap). Setting
  // only 剩余 reverts because 自动补足 (auto-replenish) refills it back up to 最大,
  // so we set 最大 = qty too. Triple-click select-all + type to replace each.
  // Turn OFF 自动补足 (auto-replenish) so 剩余 is a plain manual number that won't
  // snap back to 最大. It's a roo custom checkbox (the real <input> is hidden), so
  // we must click the <label>, not the input.
  const autoCb = await frame.$('[class*="auto-refresh"] input[type="checkbox"]');
  const wasChecked = autoCb ? await autoCb.isChecked().catch(() => false) : false;
  // roo custom checkbox: the real <input> is hidden; clicking the LABEL doesn't
  // toggle it. Click the VISUAL .custom-checkbox span. Retry a couple of ways.
  let nowChecked = wasChecked;
  for (const sel of ['[class*="auto-refresh"] .custom-checkbox',
                     '[class*="auto-refresh"] .custom-checkbox-label',
                     '[class*="auto-refresh"] label']) {
    if (!nowChecked) break;
    const el = await frame.$(sel);
    if (el) {
      await el.click({ timeout: 5000, force: true }).catch(e => console.log(`[test] click ${sel} failed:`, e.message));
      await frame.waitForTimeout(400);
      nowChecked = autoCb ? await autoCb.isChecked().catch(() => null) : null;
    }
  }
  console.log(`[test] auto-replenish: was ${wasChecked} → now ${nowChecked}`);

  // Set 剩余 (first inventory input) with real keystrokes. Triple-click selects
  // the whole value; typing over the selection replaces it (no Backspace — an
  // empty 最大/剩余 field defaults to the -1 "unlimited" sentinel).
  const inputs = await frame.$$('input[class*="inventory-input"]');
  if (!inputs.length) { console.log('[test] no inventory input'); return false; }
  const el = inputs[0]; // 剩余 (remaining)
  await el.click({ clickCount: 3, timeout: 6000 }).catch(() => {});
  await frame.waitForTimeout(120);
  await el.press('Control+A').catch(() => {});
  await el.type(String(qty), { delay: 80 }).catch(() => {});
  await el.press('Tab').catch(() => {});
  await frame.waitForTimeout(300);
  const vals = await frame.evaluate(() =>
    Array.from(document.querySelectorAll('input[class*="inventory-input"]')).map(i => i.value));
  console.log('[test] inventory inputs now read:', JSON.stringify(vals));
  if (String(vals[0]) !== String(qty)) {
    console.log('[test] ⚠ 剩余 did not hold the new value — skipping save');
    return false;
  }
  await frame.waitForTimeout(500);

  // Click 保存 (a real Playwright click on the visible one).
  const saveBtns = await frame.$$('button, .roo-btn');
  let saved = false;
  for (const sb of saveBtns) {
    const t = ((await sb.innerText().catch(() => '')) || '').trim();
    if (t === '保存') {
      const vis = await sb.isVisible().catch(() => false);
      if (vis) { await sb.click({ timeout: 6000 }).catch(e => console.log('[test] save click failed:', e.message)); saved = true; break; }
    }
  }
  if (!saved) { console.log('[test] no visible 保存 button'); return false; }
  console.log('[test] clicked 保存, waiting…');

  // Poll for ~6s capturing any toast/dialog the moment it appears (toasts vanish).
  let after = null;
  for (let i = 0; i < 12; i++) {
    await frame.waitForTimeout(500);
    after = await frame.evaluate(() => {
      // Only read ACTUAL transient toast/notification elements — NOT static body
      // text (the page is full of help copy mentioning 超过/库存 that is noise).
      const toastEls = Array.from(document.querySelectorAll(
        '.roo-toast, [class*="roo-toast"], [class*="Toast"], [class*="toast"], [class*="notify"], [class*="Notify"], [role="alert"]'))
        .map(e => (e.innerText || '').replace(/\s+/g,' ').trim())
        .filter(t => t && t.length < 50).slice(0, 6);
      const toast = []; const fullMsgs = toastEls;
      const dlg = document.querySelector('[class*="modal"],[role="dialog"]');
      let dialogText = '', confirmBtns = [];
      if (dlg && dlg.offsetParent !== null) {
        dialogText = (dlg.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        confirmBtns = Array.from(dlg.querySelectorAll('button,.roo-btn')).map(b => (b.innerText||'').trim()).filter(Boolean);
      }
      const inp = document.querySelector('input[class*="inventory-input"]');
      return { toastHits: Array.from(new Set(toast)), fullMsgs: Array.from(new Set(fullMsgs)).slice(0,8), toastEls, dialogText, confirmBtns,
               inputStillThere: !!inp, inputVal: inp ? inp.value : null, url: location.href.slice(0, 90) };
    });
    if (after.toastEls.length || after.dialogText || after.toastHits.length) break;
  }
  console.log('[test] after-save signals:', JSON.stringify(after));
  // If a confirm dialog popped (e.g. 确定 to proceed), click it.
  if (after.confirmBtns.includes('确定')) {
    const dlgBtns = await frame.$$('[class*="modal"] button, [role="dialog"] button, .roo-modal .roo-btn');
    for (const db of dlgBtns) {
      const t = ((await db.innerText().catch(() => '')) || '').trim();
      if (t === '确定') { await db.click({ timeout: 5000 }).catch(() => {}); console.log('[test] clicked 确定 in dialog'); break; }
    }
    await frame.waitForTimeout(2000);
  }
  return true;
}

(async () => {
  const store = process.argv[2] || 'tianhe';
  const name  = process.argv[3] || '红扁豆汤';
  const testVal = process.argv[4] || '9999';

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('[test] not logged in'); await b.close(); process.exit(1); }

  // 1) open editor, read original
  let frame = await openEditor(b, name);
  if (!frame) { await b.close(); process.exit(1); }
  const original = await readStock(frame);
  console.log('[test] ORIGINAL 剩余 =', JSON.stringify(original));
  console.log('[test] FIELD STATE:', JSON.stringify(await readFields(frame)));
  if (original === null) { console.log('[test] could not read original stock'); await b.close(); process.exit(1); }

  // 2) write test value + save
  const writeVal = (String(original) === String(testVal)) ? String(Number(testVal) - 1) : String(testVal);
  console.log(`[test] writing TEST value ${writeVal} …`);
  await setStockAndSave(frame, writeVal);

  // 3) re-open editor, confirm persisted
  await b.page.waitForTimeout(1500);
  frame = await openEditor(b, name);
  if (!frame) { console.log('[test] could not reopen editor to verify'); await b.close(); process.exit(1); }
  const afterWrite = await readStock(frame);
  console.log(`[test] AFTER WRITE 剩余 = ${JSON.stringify(afterWrite)} (expected ${writeVal}) → ${String(afterWrite) === writeVal ? 'PERSISTED ✓' : 'NOT persisted ✗'}`);

  // 4) restore original
  console.log(`[test] restoring original ${original} …`);
  await setStockAndSave(frame, original);
  await b.page.waitForTimeout(1500);
  frame = await openEditor(b, name);
  const restored = frame ? await readStock(frame) : null;
  console.log(`[test] RESTORED 剩余 = ${JSON.stringify(restored)} → ${String(restored) === String(original) ? 'OK ✓' : 'CHECK MANUALLY ✗'}`);

  await b.close();
  process.exit(0);
})().catch(e => { console.error('[test] error:', e); process.exit(1); });
