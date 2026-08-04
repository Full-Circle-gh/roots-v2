// READ-ONLY recon for the Meituan business-status (营业 / 休息 / 打烊) endpoint.
//
// Goal: discover the API the merchant dashboard uses to READ and SET a store's
// open/closed (营业/置休) status, WITHOUT ever changing it. This script never
// clicks the toggle and never issues a write — it only:
//   1. loads the merchant home dashboard (which fires the status READ on load),
//   2. captures every non-asset XHR/fetch URL and flags status-shaped ones,
//   3. scans the page's own JS bundles for endpoint strings + Chinese keywords.
// The SET endpoint is almost always the r/→w/ sibling of the READ endpoint; the
// bundle scan confirms it.
//
// Usage on the box (/root/roots-v2). Pause the matching sync daemon first so only
// one session drives each store:
//   外卖 (tianhe):   pm2 stop meituan-sync  && node scripts/meituan-status-recon.js tianhe ; pm2 start meituan-sync
//   闪购 (yuexiu):   pm2 stop shangou-sync  && node scripts/meituan-status-recon.js yuexiu ; pm2 start shangou-sync
//
// yuexiu attaches to the live shangou-chrome over CDP and RESTORES its page URL
// afterwards, so the daemon resumes cleanly.

'use strict';

const path = require('path');
const fs   = require('fs');

// Load .env like the daemons (dotenv, else manual parse), then hydrate DB env.
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

// Status-shaped path/keyword detector, shared by capture + bundle scan.
const STATUS_RE = /(营业|休息|置休|打烊|自助营业|停业|歇业|businessStatus|poiStatus|busiStatus|openStatus|shopStatus|storeStatus|setRest|autoRest|autoStatus|selfStatus|shippingStatus|operatingStatus|poi\/.*(status|rest|open|close|business)|(status|rest|open|close|business).*\/poi|setPoiStatus|updatePoiStatus|changeStatus|switchStatus)/i;

// Extract quoted path-like string literals from JS bundle text.
function pathsFromText(text) {
  const out = [];
  const re = /['"`](\/[A-Za-z0-9_\-\/.]{4,}?)['"`]/g;
  let m;
  while ((m = re.exec(text))) out.push({ i: m.index, p: m[1] });
  return out;
}

// In-page bundle scan: fetch every loaded .js resource, pull path literals that
// look status-shaped, plus any path sitting within 500 chars of a Chinese
// 营业/休息 keyword. Runs in the page context so same-origin fetch is authorised.
async function scanBundles(evalTarget) {
  return await evalTarget.evaluate(async (statusSrc) => {
    const STATUS = new RegExp(statusSrc, 'i');
    const KW = /(营业|休息|置休|打烊|自助营业|停业|歇业)/g;
    const PATHS = /['"`](\/[A-Za-z0-9_\-\/.]{4,}?)['"`]/g;
    const scripts = performance.getEntriesByType('resource')
      .map(r => r.name).filter(n => /\.js(\?|$)/.test(n));
    const endpoints = new Set();
    const nearKw = new Set();
    let scanned = 0;
    for (const url of scripts.slice(0, 80)) {
      let text = '';
      try { text = await (await fetch(url, { credentials: 'include' })).text(); }
      catch (e) { continue; }
      scanned++;
      const paths = [];
      let m; PATHS.lastIndex = 0;
      while ((m = PATHS.exec(text))) paths.push({ i: m.index, p: m[1] });
      for (const { p } of paths) if (STATUS.test(p)) endpoints.add(p);
      // paths adjacent to a Chinese 营业/休息 keyword
      const kwIdx = []; let k; KW.lastIndex = 0;
      while ((k = KW.exec(text))) kwIdx.push(k.index);
      for (const ki of kwIdx) {
        for (const { i, p } of paths) {
          if (Math.abs(i - ki) < 500 && /(status|rest|open|close|business|poi|shop|store|营业|休息)/i.test(p)) nearKw.add(p);
        }
      }
    }
    return { scriptCount: scripts.length, scanned, endpoints: [...endpoints], nearKw: [...nearKw] };
  }, STATUS_RE.source);
}

function reportCapture(label, seen) {
  const uniq = [...new Set(seen.map(s => `${s.method} ${s.path}`))].sort();
  const candidates = uniq.filter(u => STATUS_RE.test(u));
  console.log(`\n───── ${label}: captured XHR/fetch (${uniq.length} unique) ─────`);
  console.log('◆ STATUS CANDIDATES:');
  console.log(candidates.length ? candidates.map(c => '   ' + c).join('\n') : '   (none matched status keywords)');
  console.log('◆ ALL API PATHS:');
  console.log(uniq.filter(u => /\/(r|w)\/|\/api\/|reuse|gw|poi|shop|business|waimai/i.test(u))
    .map(c => '   ' + c).join('\n') || '   (none)');
}

function isAsset(u) { return /\.(js|css|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|ico|mp4)(\?|$)/i.test(u); }

async function reconTianhe() {
  const { MeituanBrowser } = require('../lib/meituan-browser');
  const b = new MeituanBrowser('tianhe');
  await b.init(); // headless, restores saved session (read-only)
  if (!await b.ensureLoggedIn()) {
    console.log('[recon:tianhe] NOT logged in — re-run meituan-login.js first.');
    await b.close(); process.exit(1);
  }
  const seen = [];
  b.page.on('request', (req) => {
    try {
      const u = req.url();
      if (!u.includes('meituan.com') || isAsset(u)) return;
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      seen.push({ method: req.method(), path: u.split('?')[0].replace('https://', '') });
    } catch (e) {}
  });

  // Load the merchant home — the dashboard fires the 营业状态 read on load.
  console.log('[recon:tianhe] loading merchant home to trigger status read…');
  await b.page.goto('https://e.waimai.meituan.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await b.page.waitForTimeout(12000);

  reportCapture('tianhe (外卖)', seen);

  // Bundle scan in the content frame (falls back to the page).
  const frame = (await b._getMainIframe().catch(() => null)) || b.page.mainFrame();
  try {
    const scan = await scanBundles(frame);
    console.log(`\n───── tianhe (外卖): JS bundle scan (${scan.scanned}/${scan.scriptCount}) ─────`);
    console.log('◆ status-shaped endpoints:', JSON.stringify(scan.endpoints, null, 2));
    console.log('◆ paths near 营业/休息 keywords:', JSON.stringify(scan.nearKw, null, 2));
  } catch (e) { console.log('[recon:tianhe] bundle scan failed:', e.message); }

  await b.close();
}

async function reconYuexiu() {
  const { getShangouBrowser } = require('../lib/shangou-browser');
  const b = await getShangouBrowser('yuexiu');
  const page = b.page;
  const savedUrl = page.url();
  console.log(`[recon:yuexiu] attached; current page = ${savedUrl}`);

  const seen = [];
  page.on('request', (req) => {
    try {
      const u = req.url();
      if (!u.includes('meituan.com') || isAsset(u)) return;
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      seen.push({ method: req.method(), path: u.split('?')[0].replace('https://', '') });
    } catch (e) {}
  });

  // Reload the SAME page so the dashboard re-fires its status read (less invasive
  // than navigating away). shangou-sync must be paused so this doesn't race.
  console.log('[recon:yuexiu] reloading page to trigger status read…');
  try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { console.log('reload warn:', e.message); }
  await page.waitForTimeout(12000);

  reportCapture('yuexiu (闪购)', seen);

  try {
    const scan = await scanBundles(page);
    console.log(`\n───── yuexiu (闪购): JS bundle scan (${scan.scanned}/${scan.scriptCount}) ─────`);
    console.log('◆ status-shaped endpoints:', JSON.stringify(scan.endpoints, null, 2));
    console.log('◆ paths near 营业/休息 keywords:', JSON.stringify(scan.nearKw, null, 2));
  } catch (e) { console.log('[recon:yuexiu] bundle scan failed:', e.message); }

  // Restore the daemon's page URL if the reload changed it.
  try {
    if (page.url() !== savedUrl && savedUrl && !savedUrl.startsWith('about:')) {
      await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('[recon:yuexiu] restored page to', savedUrl);
    }
  } catch (e) { console.log('[recon:yuexiu] restore warn:', e.message); }
  // Detach CDP only — never close the genuine Chrome.
  try { await b.close(); } catch {}
}

(async () => {
  const store = process.argv[2] || 'tianhe';
  if (store === 'tianhe') await reconTianhe();
  else if (store === 'yuexiu') await reconYuexiu();
  else { console.error('usage: node scripts/meituan-status-recon.js <tianhe|yuexiu>'); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('[recon] error:', e && e.stack || e); process.exit(1); });
