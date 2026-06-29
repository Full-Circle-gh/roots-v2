'use strict';

// 闪购 order-endpoint sniffer (temporary diagnostic).
//
// The yuexiu 闪购 order importer was never finished because we don't know the real
// order-list / order-history API path — every guessed path returns code:10000 NOT
// FOUND, and headless navigation doesn't surface the SPA's list call. This process
// attaches over CDP to the SAME genuine Chrome the daemon drives (read-only: it only
// listens, never navigates or fetches) and appends every /gw/api/* call whose URL
// mentions "order" to logs/shangou-order-endpoints.log — full URL, request body, and
// response body. Leave it running; the next time a real yuexiu order is opened on the
// box's Chrome screen, its list/detail endpoints land in the log and we wire them up.
//
// Start: pm2 start scripts/shangou-order-sniffer.js --name shangou-order-sniff
// Read:  tail -f /root/roots-v2/logs/shangou-order-endpoints.log
// Stop:  pm2 delete shangou-order-sniff   (remove once endpoint captured)

const fs   = require('fs');
const path = require('path');
const playwright = require('playwright');

const CDP_URL  = process.env.SHANGOU_CDP_URL || 'http://127.0.0.1:9333';
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'shangou-order-endpoints.log');
const MATCH    = /\/gw\/api\/.*order/i;   // any gateway call mentioning "order"
const MAX_BODY = 4000;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function write(line) {
  const stamp = new Date().toISOString();
  try { fs.appendFileSync(LOG_FILE, `${stamp} ${line}\n`); } catch {}
  console.log(line);
}

const wired = new WeakSet();

function wirePage(page) {
  if (wired.has(page)) return;
  wired.add(page);

  page.on('request', req => {
    const u = req.url();
    if (!MATCH.test(u)) return;
    let body = '';
    try { body = req.postData() || ''; } catch {}
    write(`REQ ${req.method()} ${u}`);
    if (body) write(`    body: ${body.slice(0, MAX_BODY)}`);
  });

  page.on('response', async resp => {
    const u = resp.url();
    if (!MATCH.test(u)) return;
    let text = '';
    try { text = await resp.text(); } catch {}
    write(`RESP ${resp.status()} ${u.split('?')[0]}`);
    if (text) write(`    resp: ${text.slice(0, MAX_BODY)}`);
  });
}

async function main() {
  write(`[sniffer] starting — CDP ${CDP_URL}`);
  let browser;
  while (true) {
    try {
      browser = await playwright.chromium.connectOverCDP(CDP_URL);
      write('[sniffer] attached to Chrome over CDP');
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) wirePage(p);
        ctx.on('page', p => { write(`[sniffer] new page ${p.url()}`); wirePage(p); });
      }
      // Hold the connection open; if Chrome restarts, reconnect.
      await new Promise((resolve) => {
        browser.on('disconnected', () => { write('[sniffer] CDP disconnected — will retry'); resolve(); });
      });
    } catch (e) {
      write(`[sniffer] connect error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch(e => { write(`[sniffer] fatal: ${e.message}`); process.exit(1); });
