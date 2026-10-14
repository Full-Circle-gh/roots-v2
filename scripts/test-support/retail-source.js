// The text of routes/retail.js, every part split out of it, and the helpers it
// moved to lib/, as one string.
//
// WHY THIS EXISTS (decisions §470). About 45 suites read routes/retail.js as
// text and slice a handler out of it to check how it is written. When an area
// moves into routes/retail/<area>.js, a check that read retail.js alone would
// find nothing and fail, though nothing broke. Reading the whole family as one
// text lets a check follow the code it is about without being told where the
// code lives today. The check itself stays exactly as strict as it was.
//
// Parts are read in name order after retail.js, each separated by a blank line,
// so a slice that ends at '\n});' cannot run from one file into the next.
// Line endings are normalised to \n whatever the checkout wrote.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const PARTS_DIR = path.join(REPO, 'routes', 'retail');

function retailPartFiles() {
  if (!fs.existsSync(PARTS_DIR)) return [];
  return fs.readdirSync(PARTS_DIR).filter((f) => f.endsWith('.js')).sort()
    .map((f) => path.join('routes', 'retail', f));
}

// Helpers that left routes/retail.js for lib/ under decisions §477. A check that
// lifts one of them by name finds it here, the same way it finds a route that
// moved into a part. Each group that moves adds its file(s) to this list.
const RETAIL_LIBS = [
  'lib/public-origin.js', 'lib/wx-access-token.js', 'lib/wx-content-gate.js',
  'lib/store-config.js', 'lib/loyalty.js', 'lib/vouchers.js', 'lib/addresses.js',
  'lib/page-layout.js', 'lib/customer-notify.js', 'lib/signup-rewards.js', 'lib/referrals.js',
  'lib/shop-clock.js', 'lib/broadcast-audience.js', 'lib/customers.js',
  'lib/tenant-brand.js', 'lib/payment-gateways.js', 'lib/bundles.js', 'lib/cost-at-sale.js',
  'lib/fapiao.js',
];

function retailSource() {
  return ['routes/retail.js', ...retailPartFiles(), ...RETAIL_LIBS]
    .map((rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n'))
    .join('\n\n');
}

module.exports = { retailSource, retailPartFiles, RETAIL_LIBS };
