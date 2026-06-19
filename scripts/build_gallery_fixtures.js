/* Rebuild public/shop/_gallery.fixtures.js from the _wsf_fixtures/ snapshots.
 *
 * The block-gallery (public/shop/_gallery.html) renders every home block type
 * at multiple viewport widths so we can eyeball desktop layout without a running
 * server. It loads its data from a plain <script> global (works from file://,
 * no fetch/CORS), which this script generates from the captured fixtures.
 *
 * Re-run after refreshing _wsf_fixtures/:  node scripts/build_gallery_fixtures.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const data = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')).data;

const bundle = {
  config:   data('_wsf_fixtures/config.json'),
  products: data('_wsf_fixtures/products.json'),
  cats:     data('_wsf_fixtures/cats.json'),
  flash:    data('_wsf_fixtures/flash.json'),
};

const out =
  '/* AUTO-GENERATED from _wsf_fixtures/ by scripts/build_gallery_fixtures.js — do not edit. */\n' +
  'window.__WSF__ = ' + JSON.stringify(bundle) + ';\n';

const dest = path.join(root, 'public/shop/_gallery.fixtures.js');
fs.writeFileSync(dest, out);
console.log('wrote', path.relative(root, dest), (out.length / 1024).toFixed(0) + 'KB',
  '·', bundle.config.home.layout.length, 'home blocks');
