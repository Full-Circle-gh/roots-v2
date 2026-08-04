// READ-ONLY (闪购 / yuexiu): confirm the /common/businessStatus READ works from
// the live page and print yuexiu's current open/closed status. Tries a few
// encodings to see which the shangoue host accepts. NEVER calls change_status.
// Passive: attaches over CDP, no reload / navigation.

'use strict';
const path = require('path');
const fs = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}
require('../database');

(async () => {
  const { getShangouBrowser } = require('../lib/shangou-browser');
  const b = await getShangouBrowser('yuexiu');
  const page = b.page;
  const WMPOIID = process.env.SHANGOU_WMPOIID || '12866824';
  const REGION_ID = process.env.SHANGOU_REGION_ID || '1000440100';
  const REGION_VER = process.env.SHANGOU_REGION_VERSION || '1631517219';
  const CSEC = `region_id=${REGION_ID}&region_version=${REGION_VER}&yodaReady=h5&csecplatform=4&csecversion=4.2.4`;
  console.log(`[read:yuexiu] page=${page.url()} wmPoiId=${WMPOIID}`);

  const out = await page.evaluate(async ({ WMPOIID, CSEC }) => {
    const host = 'https://shangoue.meituan.com';
    const attempts = {};
    const call = async (label, url, opts) => {
      try {
        const r = await fetch(url, opts);
        const t = await r.text();
        attempts[label] = { status: r.status, body: t.slice(0, 500) };
      } catch (e) { attempts[label] = { err: String(e) }; }
    };
    // 1) form + csec (mirrors ShangouBrowser._api)
    await call('form+csec', `${host}/common/businessStatus?${CSEC}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `wmPoiId=${WMPOIID}`, credentials: 'include',
    });
    // 2) json body (mirrors the 外卖 captured shape)
    await call('json', `${host}/common/businessStatus?${CSEC}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wmPoiId: String(WMPOIID) }), credentials: 'include',
    });
    // 3) form, no csec
    await call('form', `${host}/common/businessStatus`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `wmPoiId=${WMPOIID}`, credentials: 'include',
    });
    return attempts;
  }, { WMPOIID, CSEC });

  console.log(JSON.stringify(out, null, 2));
  try { await b.close(); } catch {}
  process.exit(0);
})().catch(e => { console.error('[read:yuexiu] error:', e && e.stack || e); process.exit(1); });
