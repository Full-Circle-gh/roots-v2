// Page layouts: which CMS pages carry a layout, and where each block shows
// (`show_on`: the mini app, the web shop, or both). Moved out of
// routes/retail.js unchanged (decisions §477). The settings loader
// (lib/store-config.js) applies withShowOn to every published layout on the
// way out, and the CMS routes read the same whitelist.
'use strict';

// CMS-editable pages. Each has its own `<page>.layout` (live) and
// `cms.draft.<page>_layout` (draft) entries in storefront_config. Add a
// new page by appending to this whitelist — no schema change needed.
// `about` is a hardcoded mini app page (/pages/about/about), not CMS-driven —
// brand identity, intentionally pinned in code.
// `website` is the brand site (public/site.html), served on a domain the tenant
// marks `serves = 'site'`; the mini app receives it and draws nothing from it
// (decisions §503).
const ALLOWED_PAGES = new Set(['home', 'promotions', 'membership', 'categories', 'onboarding', 'website']);

// ── Where a block shows: `show_on` ─────────────────────────────────────────
// One layout feeds two customer surfaces — the WeChat mini app and the web
// shop (public/shop.html). `show_on` on a block says which of them draw it:
//   'both'    — the default for nearly every type
//   'miniapp' — the mini app only (the web shop skips it)
//   'web'     — the web shop only (the mini app skips it)
// The four types that default to 'miniapp' lead somewhere the web shop does
// not have yet: shop.html's ctaRoute() answers wallet / notifications / order
// targets with "coming soon", so a points, top-up, notification or order
// tracker block on the website is a promise the site cannot keep. The default
// is applied on the way OUT (readLayout for the editor, loadConfig for the
// customer surfaces, the two draft overlays) and never written back: publish,
// revert and brand-publish copy the STORED layout (readLayoutStored), so a
// block that never had the field keeps following this table if the table
// changes. A layout published before the field existed therefore behaves the
// same as one saved after it, and the four renderers (mini app, shop.html,
// storefront.html, the editor canvas) read one explicit value instead of each
// carrying a copy of this table. The editor
// carries the same four-type table for a block added and not yet saved; the
// test `scripts/test_cms_show_on.js` holds the two copies equal.
// Decided by Ash 2026-09-26 — docs/tacet-consolidation-decisions.md §272.
const SHOW_ON_VALUES = new Set(['both', 'miniapp', 'web']);
const SHOW_ON_DEFAULTS = Object.freeze({
  order_tracker: 'miniapp', notification_bar: 'miniapp',
  points_widget: 'miniapp', top_up: 'miniapp',
});
function showOnFor(block) {
  if (block && SHOW_ON_VALUES.has(block.show_on)) return block.show_on;
  return (block && SHOW_ON_DEFAULTS[block.type]) || 'both';
}
// Returns a copy of the layout with `show_on` explicit on every block.
function withShowOn(layout) {
  if (!Array.isArray(layout)) return layout;
  return layout.map(b => (b && typeof b === 'object') ? { ...b, show_on: showOnFor(b) } : b);
}

module.exports = { ALLOWED_PAGES, SHOW_ON_VALUES, SHOW_ON_DEFAULTS, showOnFor, withShowOn };
