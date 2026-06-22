// Playwright browser automation for Meituan merchant backend.
// Handles login, order polling, stock pushing for 天河 + 越秀 stores.
// Sessions are persisted to data/meituan-sessions/ so the browser stays logged
// in between runs. First run: launch in headed mode so staff can log in manually
// (Meituan may require WeChat QR scan). Subsequent runs: headless, auto-restore.

const path = require('path');
const fs   = require('fs');

const SESSION_DIR = path.join(__dirname, '../data/meituan-sessions');
const MERCHANT_URL = 'https://e.waimai.meituan.com';

let playwright;
function getPlaywright() {
  if (!playwright) playwright = require('playwright');
  return playwright;
}

class MeituanBrowser {
  constructor(storeCode) {
    this.storeCode   = storeCode; // 'tianhe' | 'yuexiu'
    this.sessionFile = path.join(SESSION_DIR, `${storeCode}-session.json`);
    this.browser     = null;
    this.context     = null;
    this.page        = null;
    this._loggedIn   = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init() {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { chromium } = getPlaywright();

    const hasSession = fs.existsSync(this.sessionFile);
    const storageState = hasSession
      ? JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))
      : undefined;

    // First run (no saved session): headed so staff can log in via WeChat QR
    const headless = hasSession;
    this._log(hasSession ? 'restoring session (headless)' : 'no session — launching headed for manual login');

    // On Windows prefer system Edge/Chrome; on Linux use bundled Chromium.
    const isWindows = process.platform === 'win32';
    const launchOpts = {
      headless,
      args: isWindows ? [] : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };
    if (isWindows) {
      // Use installed Microsoft Edge (always present on Windows 10/11)
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      const fs2 = require('fs');
      if (fs2.existsSync(edgePath)) launchOpts.executablePath = edgePath;
      else launchOpts.channel = 'msedge'; // fallback: let Playwright find Edge
    }
    this.browser = await chromium.launch(launchOpts);

    this.context = await this.browser.newContext({
      storageState,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });

    this.page = await this.context.newPage();
  }

  async ensureLoggedIn() {
    if (this._loggedIn) return true;

    await this.page.goto(MERCHANT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForTimeout(3000);

    const url = this.page.url();
    // Login confirmed when URL is on either meituan merchant domain with session params
    const isOnMerchant = (u) =>
      (u.includes('waimaie.meituan.com') || u.includes('e.waimai.meituan.com')) &&
      !u.includes('/login_gw') && !u.includes('/login?') && !u.includes('#/login');
    if (isOnMerchant(url)) {
      this._loggedIn = true;
      await this._saveSession();
      this._log('login confirmed');
      return true;
    }

    // Not logged in: if headed, wait up to 3 minutes for staff to scan QR
    const hasSession = fs.existsSync(this.sessionFile);
    if (!hasSession) {
      this._log('waiting for manual login (up to 3 min)...');
      try {
        await this.page.waitForURL(
          (u) => isOnMerchant(u.toString()),
          { timeout: 180000 }
        );
        this._loggedIn = true;
        await this._saveSession();
        this._log('manual login successful — session saved');
        return true;
      } catch {
        this._log('login timeout');
        return false;
      }
    }

    this._log('session expired — delete session file and re-run in headed mode');
    return false;
  }

  async close() {
    try { await this._saveSession(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.browser = this.context = this.page = null;
    this._loggedIn = false;
  }

  // ── Order polling ─────────────────────────────────────────────────────────

  // Returns array of pending order objects from 待接单 tab.
  async getPendingOrders() {
    if (!await this.ensureLoggedIn()) return [];

    // Navigate to orders section
    await this.page.goto(`${MERCHANT_URL}/#/order`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    const iframe = await this._getMainIframe();
    if (!iframe) return this._withFallback('getPendingOrders: no iframe', []);

    const orders = await iframe.evaluate(() => {
      // Collect all order cards visible on page
      const cards = Array.from(document.querySelectorAll('[class*="order-card"],[class*="orderCard"],[class*="order-item"],[class*="orderItem"]'));
      if (!cards.length) {
        // Fallback: find by data structure
        const all = Array.from(document.querySelectorAll('[data-order-id],[data-orderid]'));
        return all.map(el => ({
          meituanOrderNo: el.getAttribute('data-order-id') || el.getAttribute('data-orderid') || '',
          rawHtml: el.innerText.slice(0, 500),
        }));
      }
      return cards.map(card => {
        const text = card.innerText || '';
        const noMatch = text.match(/(?:订单号[：:]\s*)?(MT\d{18,}|\d{18,})/);
        const totalMatch = text.match(/¥\s*([\d.]+)/);
        const timeMatch  = text.match(/(\d{2}:\d{2})/);
        // Items: look for qty × name patterns
        const itemEls = card.querySelectorAll('[class*="item"],[class*="food"],[class*="dish"],[class*="product"]');
        const items = Array.from(itemEls).map(el => {
          const t = el.innerText || '';
          const m = t.match(/(\d+)\s*×\s*(.+)|(.+)\s*×\s*(\d+)/);
          return m ? { name: (m[2] || m[3] || '').trim(), qty: parseInt(m[1] || m[4]) } : null;
        }).filter(Boolean);

        return {
          meituanOrderNo: noMatch ? noMatch[1] : '',
          total: totalMatch ? parseFloat(totalMatch[1]) : 0,
          placedTime: timeMatch ? timeMatch[1] : '',
          items,
          rawText: text.slice(0, 800),
        };
      }).filter(o => o.meituanOrderNo || o.rawText.includes('¥'));
    });

    this._log(`found ${orders.length} order(s) on order page`);
    return orders;
  }

  // Accept a pending order on Meituan by order number. Returns true on success.
  async acceptOrder(meituanOrderNo) {
    if (!await this.ensureLoggedIn()) return false;
    const iframe = await this._getMainIframe();
    if (!iframe) return false;

    const clicked = await iframe.evaluate((no) => {
      // Find card containing this order number
      const cards = Array.from(document.querySelectorAll('[class*="order"]'));
      for (const card of cards) {
        if (card.innerText && card.innerText.includes(no)) {
          const buttons = card.querySelectorAll('button,span,div');
          for (const b of buttons) {
            if (b.innerText && (b.innerText.trim() === '接单' || b.innerText.trim() === '确认接单')) {
              b.click();
              return true;
            }
          }
        }
      }
      return false;
    }, meituanOrderNo);

    if (clicked) {
      await this.page.waitForTimeout(1500);
      this._log(`accepted order ${meituanOrderNo}`);
    } else {
      this._log(`could not find accept button for order ${meituanOrderNo}`);
    }
    return clicked;
  }

  // ── Stock push ────────────────────────────────────────────────────────────

  // Update stock for a product by its roots-v2 product name (name_cn or name_en).
  // Navigates to product list, finds the product, runs the 改库存 dialog.
  async updateStock(productNameCn, productNameEn, newQty) {
    if (!await this.ensureLoggedIn()) return false;

    await this.page.goto(
      `${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );
    await this.page.waitForTimeout(3000);

    const iframe = await this._getMainIframe();
    if (!iframe) return this._withFallback('updateStock: no iframe', false);

    // Find the product by matching its name input
    const found = await iframe.evaluate((cn, en) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const productInput = inputs.find(inp =>
        inp.value && inp.type === 'text' && inp.placeholder !== '搜索商品或规格名称' &&
        (inp.value.includes(cn) || (en && inp.value.toLowerCase().includes(en.toLowerCase())))
      );
      if (!productInput) return false;

      // Walk up to find the row containing this product's checkbox
      let row = productInput;
      const allInputs = inputs;
      for (let i = 0; i < 20; i++) {
        row = row.parentElement;
        if (!row) break;
        if (row.innerText && row.innerText.includes('库存')) {
          const checkbox = row.querySelector('input[type="checkbox"]');
          if (checkbox) {
            checkbox.click();
            return true;
          }
        }
      }
      return false;
    }, productNameCn || '', productNameEn || '');

    if (!found) {
      this._log(`product not found: ${productNameCn || productNameEn}`);
      return false;
    }

    await iframe.waitForTimeout(500);

    // Click 改库存 in the bulk action bar
    const barClicked = await iframe.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const btn = spans.find(s => s.innerText && s.innerText.trim() === '改库存');
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!barClicked) {
      this._log('改库存 button not found');
      return false;
    }

    await iframe.waitForTimeout(800);

    // Fill in the dialog
    const confirmed = await iframe.evaluate((qty) => {
      const dialogs = Array.from(document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]'));
      const stockDialog = dialogs.find(d =>
        d.offsetParent !== null && d.innerText && d.innerText.includes('批量修改库存')
      );
      if (!stockDialog) return false;

      const inputs = Array.from(stockDialog.querySelectorAll('input'));
      // Select 自定义库存 radio (value=3)
      const customRadio = inputs.find(i => i.type === 'radio' && i.value === '3');
      if (customRadio) customRadio.click();

      const stockInput = inputs.find(i => i.placeholder === '请填写剩余库存');
      if (!stockInput) return false;

      // Use native input setter to bypass React's synthetic event system
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(stockInput, String(qty));
      stockInput.dispatchEvent(new Event('input',  { bubbles: true }));
      stockInput.dispatchEvent(new Event('change', { bubbles: true }));

      const confirmBtn = Array.from(stockDialog.querySelectorAll('button,span,div'))
        .find(b => b.innerText && b.innerText.trim() === '确定');
      if (confirmBtn) { confirmBtn.click(); return true; }
      return false;
    }, newQty);

    if (confirmed) {
      await iframe.waitForTimeout(1000);
      this._log(`stock updated: ${productNameCn || productNameEn} → ${newQty}`);
    } else {
      this._log(`stock dialog confirm failed for ${productNameCn || productNameEn}`);
    }
    return confirmed;
  }

  // Batch update: push multiple products in one product-list visit.
  // items = [{ productNameCn, productNameEn, newQty }]
  async batchUpdateStock(items) {
    if (!items || !items.length) return { ok: 0, fail: 0 };
    let ok = 0, fail = 0;
    for (const item of items) {
      const success = await this.updateStock(item.productNameCn, item.productNameEn, item.newQty);
      if (success) ok++; else fail++;
      await this.page.waitForTimeout(500); // brief pause between products
    }
    this._log(`batchUpdateStock: ${ok} ok, ${fail} fail`);
    return { ok, fail };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async _getMainIframe() {
    // Give the page time to settle then find the merchant content iframe
    await this.page.waitForTimeout(1500);
    const frames = this.page.frames();
    // The merchant content frame is same-origin (waimaie.meituan.com)
    const contentFrame = frames.find(f =>
      f !== this.page.mainFrame() &&
      f.url().includes('meituan.com') &&
      !f.url().startsWith('about:')
    );
    if (contentFrame) return contentFrame;
    // Fallback: evaluate on main page which may embed via document.querySelectorAll('iframe')
    return null;
  }

  async _saveSession() {
    if (!this.context) return;
    const state = await this.context.storageState();
    fs.writeFileSync(this.sessionFile, JSON.stringify(state));
  }

  _log(msg) {
    console.log(`[meituan:${this.storeCode}] ${msg}`);
  }

  _withFallback(msg, fallback) {
    this._log(msg);
    return fallback;
  }
}

// ── Factory: get or create a browser instance per store ──────────────────────
const instances = {};

async function getBrowser(storeCode) {
  if (!instances[storeCode]) {
    const b = new MeituanBrowser(storeCode);
    await b.init();
    instances[storeCode] = b;
  }
  return instances[storeCode];
}

async function closeAll() {
  for (const b of Object.values(instances)) await b.close();
  for (const k of Object.keys(instances)) delete instances[k];
}

module.exports = { MeituanBrowser, getBrowser, closeAll };
