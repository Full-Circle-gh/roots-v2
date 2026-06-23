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

  // FRAME INVENTORY — we can't see the browser, so dump every frame's input
  // inventory to pin down which frame actually holds the product list + search
  // box (and its real selector). _getMainIframe just grabs the FIRST meituan
  // frame, which may be a nav/header shell with no list in it.
  console.log('───── FRAME INVENTORY ─────');
  for (const fr of b.page.frames()) {
    let inv = null;
    try {
      inv = await fr.evaluate(() => {
        if (!document.body) return { noBody: true };
        const inputs = Array.from(document.querySelectorAll('input'));
        return {
          inputs: inputs.length,
          placeholders: inputs.map(i => i.placeholder || '').filter(Boolean).slice(0, 12),
          searchLike: inputs
            .filter(i => /搜索|search/i.test(i.placeholder || ''))
            .map(i => ({ ph: i.placeholder, cls: i.className })),
          productCards: document.querySelectorAll('[class*="product-card"]').length,
          rooInputs: document.querySelectorAll('input.roo-input').length,
          salesRows: (document.body.innerText.match(/月售/g) || []).length,
        };
      });
    } catch (e) { inv = { evalError: e.message }; }
    console.log(`  frame ${JSON.stringify(fr.url().slice(0, 90))} →`, JSON.stringify(inv));
  }
  console.log('───────────────────────────');

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
  // The product list lives in a SEPARATE content frame from the page shell
  // (the shell holds only the global ORDER search box). Pick the frame that
  // owns the PRODUCT search box (placeholder 搜索商品或规格名称) — that's the one
  // with the product cards. Fall back to _getMainIframe's frame if not found.
  let contentFrame = iframe;
  for (const fr of b.page.frames()) {
    const hasProductSearch = await fr.$('input[placeholder="搜索商品或规格名称"]').catch(() => null);
    if (hasProductSearch) {
      contentFrame = fr;
      console.log(`[probe] content frame = ${JSON.stringify(fr.url().slice(0, 90))}`);
      break;
    }
  }

  // Probe the SEARCH MECHANISM. The box is a roo-autoComplete, so typing may
  // open a suggestion dropdown rather than filter the list. Dump what appears
  // after typing, look for an explicit search button, then try Enter + button.
  if (term) {
    const sh = await contentFrame.$('input[placeholder="搜索商品或规格名称"]').catch(() => null);
    if (!sh) { console.log('[probe] product search box NOT found in content frame'); }
    else {
      await sh.click({ timeout: 8000 }).catch(e => console.log('[probe] search click failed:', e.message));
      await sh.fill('');
      await sh.type(coreQuery, { delay: 80 });
      await contentFrame.waitForTimeout(1500);

      // What opened after typing? (autocomplete dropdown items + any search button)
      const afterType = await contentFrame.evaluate(() => {
        const optSel = '.roo-autoComplete-option, [class*="autocomplete"] li, [class*="autoComplete"] [class*="option"], ul[role="listbox"] li, [class*="dropdown"] li';
        const opts = Array.from(document.querySelectorAll(optSel))
          .map(o => (o.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12);
        const btns = Array.from(document.querySelectorAll('button, .roo-btn, [class*="search"] [class*="btn"], span'))
          .filter(b => /^搜索$|搜 索/.test((b.innerText || '').trim()))
          .map(b => ({ t: (b.innerText || '').trim(), cls: (b.className || '').toString().slice(0, 50) }))
          .slice(0, 6);
        return { dropdownOptions: opts, searchButtons: btns };
      });
      console.log('[probe] afterType:', JSON.stringify(afterType));

      // The search is a roo-autoComplete: Enter does NOT filter the list — you
      // must CLICK the matching suggestion. Real Playwright click so React fires.
      const optSel = '.roo-autoComplete-option, [class*="autocomplete"] li, [class*="autoComplete"] [class*="option"], ul[role="listbox"] li, [class*="dropdown"] li';
      const optionHandles = await contentFrame.$$(optSel);
      let clicked = null;
      for (const oh of optionHandles) {
        const txt = ((await oh.innerText().catch(() => '')) || '').trim();
        if (txt.includes(coreQuery)) {
          await oh.click({ timeout: 5000 }).catch(e => console.log('[probe] option click failed:', e.message));
          clicked = txt;
          break;
        }
      }
      console.log('[probe] clicked suggestion:', JSON.stringify(clicked));
      if (!clicked) { await sh.press('Enter'); console.log('[probe] no suggestion matched — fell back to Enter'); }
    }
    await contentFrame.waitForTimeout(3000); // results may lazy-load after the filter
  }

  // STRUCTURAL DUMP — find where the target name actually lives in the DOM and
  // report the real row structure (class names, name source, checkbox) so we can
  // derive correct selectors for updateStock.
  const dump = await contentFrame.evaluate(({ cn }) => {
    if (!document.body) return { noBody: true };
    const body = document.body.innerText || '';
    const out = {
      salesRows: (body.match(/月售/g) || []).length,
      bodyHasTarget: body.includes(cn),
      rooInputValues: [],
      cardClassCounts: {},
      targetRow: null,
      monthSaleRows: [],
    };

    // All roo-input values on screen (the product name is usually an editable
    // roo-input; this shows whether the target is among them).
    out.rooInputValues = Array.from(document.querySelectorAll('input.roo-input'))
      .map(i => i.value).filter(Boolean).slice(0, 20);

    // Every product-card with its name + status line + checkbox presence.
    out.allCards = Array.from(document.querySelectorAll('[class*="product-card"]')).map(c => ({
      cls: (c.className || '').toString().slice(0, 40),
      name: (c.querySelector('input.roo-input') || {}).value
         || (c.querySelector('[title]') ? c.querySelector('[title]').getAttribute('title') : '') || '',
      status: (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70),
      hasCheckbox: !!c.querySelector('input[type=checkbox]'),
    })).slice(0, 20);

    // Top tabs (销售中 / 已售完 / 已下架 …) and which looks active.
    out.tabs = Array.from(document.querySelectorAll('[class*="tab"] , [role="tab"], [class*="Tab"] li'))
      .map(t => ({ t: (t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24),
                   active: /active|selected|current/i.test((t.className || '').toString()) }))
      .filter(x => x.t && x.t.length < 24).slice(0, 16);

    // Distinct class fragments of candidate card containers.
    for (const sel of ['product-card', 'card', 'item', 'list-row', 'sku']) {
      out.cardClassCounts[sel] = document.querySelectorAll(`[class*="${sel}"]`).length;
    }

    const describe = (el, depth) => {
      let node = el, chain = [];
      for (let i = 0; i < depth && node; i++) {
        chain.push({
          tag: node.tagName,
          cls: (node.className && node.className.toString) ? node.className.toString().slice(0, 60) : '',
          hasCheckbox: !!node.querySelector && !!node.querySelector('input[type=checkbox]'),
          rooInputVal: node.querySelector ? (node.querySelector('input.roo-input') || {}).value || '' : '',
          titleAttr: node.querySelector && node.querySelector('[title]') ? node.querySelector('[title]').getAttribute('title') : '',
        });
        node = node.parentElement;
      }
      return chain;
    };

    // Locate the target name anywhere (text node, input value, or title attr),
    // then walk up 8 ancestors to expose the row container + its checkbox.
    let hitEl = null;
    const inputHit = Array.from(document.querySelectorAll('input'))
      .find(i => (i.value || '').includes(cn) || (i.getAttribute('title') || '').includes(cn));
    if (inputHit) hitEl = inputHit;
    if (!hitEl) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.nodeValue && walker.currentNode.nodeValue.includes(cn)) {
          hitEl = walker.currentNode.parentElement; break;
        }
      }
    }
    if (hitEl) {
      out.targetRow = { foundVia: inputHit ? 'input' : 'text', ancestors: describe(hitEl, 8) };
    }

    // For each 月售 occurrence, expose its nearest ancestor that has a checkbox.
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      if (el.children.length === 0 && /月售/.test(el.textContent || '')) {
        let row = el;
        for (let i = 0; i < 12 && row; i++) {
          if (row.querySelector && row.querySelector('input[type=checkbox]')) {
            out.monthSaleRows.push({
              cls: (row.className || '').toString().slice(0, 60),
              name: (row.querySelector('input.roo-input') || {}).value
                 || (row.querySelector('[title]') ? row.querySelector('[title]').getAttribute('title') : '') || '',
              text: (row.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
            });
            break;
          }
          row = row.parentElement;
        }
      }
    }
    return out;
  }, { cn: term });

  console.log('───── PROBE RESULT ─────');
  console.log('searchedCore:', JSON.stringify(coreQuery));
  console.log(JSON.stringify(dump, null, 2));
  console.log('────────────────────────');

  // EDIT-PAGE STOCK FIELD — clicking the suggestion jumps to the product editor.
  // Locate the 库存 (stock) field + its input, and the 保存 (save) button.
  const editDump = await contentFrame.evaluate(() => {
    if (!document.body) return { noBody: true };
    const out = { onEditPage: !!document.querySelector('[class*="productNameWrapper"], [class*="module-item-wrap"]'),
                  stockFields: [], saveButtons: [], skuRows: [] };

    // Every field-wrapper whose label mentions 库存; report the input(s) inside.
    const wraps = document.querySelectorAll('[class*="field-wrapper"], [class*="module-item-wrap"], [class*="field-item"]');
    for (const w of wraps) {
      const label = (w.querySelector('[class*="field-label"], label, [class*="label"]') || {}).innerText || '';
      const txt = (w.innerText || '').replace(/\s+/g, ' ').trim();
      if (/库存/.test(label) || /库存/.test(txt.slice(0, 30))) {
        out.stockFields.push({
          label: label.replace(/\s+/g, ' ').trim().slice(0, 30),
          text: txt.slice(0, 80),
          inputs: Array.from(w.querySelectorAll('input')).map(i => ({
            cls: (i.className || '').toString().slice(0, 40),
            type: i.type, value: i.value, placeholder: i.placeholder, name: i.name,
          })).slice(0, 6),
        });
      }
    }

    // SKU rows often carry per-spec stock; dump any input near a 库存 column.
    const stockInputs = Array.from(document.querySelectorAll('input'))
      .filter(i => /库存|stock/i.test(i.placeholder || '') || /库存/.test((i.closest('[class*="field"], td, [class*="col"]') || {}).textContent || ''))
      .map(i => ({ cls: (i.className||'').toString().slice(0,40), value: i.value, placeholder: i.placeholder, type: i.type }))
      .slice(0, 8);
    out.skuRows = stockInputs;

    // Save buttons.
    out.saveButtons = Array.from(document.querySelectorAll('button, .roo-btn, span, div'))
      .map(b => (b.innerText || '').trim())
      .filter(t => /^保存$|^保存并上架$|^保存草稿$|^确定$/.test(t))
      .slice(0, 8);

    return out;
  });
  console.log('───── EDIT PAGE ─────');
  console.log(JSON.stringify(editDump, null, 2));
  console.log('─────────────────────');

  await b.close();
  process.exit(0);
})().catch(e => { console.error('[probe] error:', e); process.exit(1); });
