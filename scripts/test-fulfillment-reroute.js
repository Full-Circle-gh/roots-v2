// Non-destructive test of the Phase 2 fulfillment reroute. routeOrder is a pure
// decision function (no order is created), so this only flips fulfillment_open in
// the DB for a few milliseconds, observes routing, and ALWAYS restores both stores
// to open in a finally. Run on the box: node scripts/test-fulfillment-reroute.js
'use strict';
const path = require('path'); const fs = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch { if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile,'utf8').split('\n')) { const m=l.match(/^([^#=\s][^=]*)=(.*)$/); if(m) process.env[m[1].trim()]=m[2].trim().replace(/^['"]|['"]$/g,''); } }

const db = require('../database');
const inventory = require('../lib/inventory');

const setFul = (code, v) => db.prepare('UPDATE store_business_status SET fulfillment_open=? WHERE store_code=?').run(v, code);
const route = async (label, addr) => {
  const r = await inventory.routeOrder({ address: addr, items: [], ignoreStock: true });
  console.log('  ' + label.padEnd(18), '→', r.error ? ('ERROR ' + r.error) : ((r.store && r.store.code) + '  (' + (r.reason || '') + ')'));
};
const gz = { district: '天河区', city: '广州市' };
const bj = { district: '朝阳区', city: '北京市' };

(async () => {
  try {
    console.log('=== baseline (both open) ===');            await route('GZ 天河区', gz); await route('out-of-city 北京', bj);
    console.log('=== tianhe fulfillment CLOSED ===');        setFul('tianhe', 0); await route('GZ 天河区', gz); await route('out-of-city 北京', bj);
    console.log('=== BOTH closed (expect no_active_store) ==='); setFul('yuexiu', 0); await route('GZ 天河区', gz); await route('out-of-city 北京', bj);
  } finally {
    setFul('tianhe', 1); setFul('yuexiu', 1);
    const after = db.prepare('SELECT store_code, fulfillment_open FROM store_business_status ORDER BY store_code').all();
    console.log('restored →', JSON.stringify(after));
  }
  process.exit(0);
})();
