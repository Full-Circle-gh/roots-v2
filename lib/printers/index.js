// Printer vendor registry — which brands of cloud printer this product can
// print to, and how a saved printer row finds its adapter (decisions §171).
//
// WHY THIS EXISTS. A tenant arrives with the printer already screwed to the
// counter. "Buy a different brand" is not something an onboarding can say, so
// the vendor is configuration rather than a constant — per store, because a
// four-shop tenant buys printers one shop at a time and may well run three
// Feie and one Shangpeng.
//
// THE CONTRACT IS TWO FUNCTIONS, ON PURPOSE.
//   enabled(creds)                              → is this vendor configured?
//   printContent(content, { sn, copies }, creds) → { ok, msg }
// `content` is always HOUSE MARKUP — Feie's <CB>/<B>/<L>/<BOLD>/<C> tag set,
// which every slip in lib/feie.js is rendered in exactly once. An adapter
// translates it on the way out. Label printing, order-status polling and
// queue clearing are NOT in the contract: both vendors expose them, nothing
// in this product asks for them, and an interface widened for a feature
// nobody wants is how it gets fixed wrong before the third vendor arrives.
//
// ADDING A THIRD VENDOR is: one file beside these two, one line in VENDORS,
// and its credential shape declared in `credFields` so the Integrations panel
// and the boot-time env hydration both pick it up without being edited.

'use strict';

const feie = require('./feie');
const spyun = require('./spyun');

// Order matters only for the admin picker. Feie first — it is what every row
// saved before §171 is, and what most tenants already own.
const VENDORS = [feie, spyun];

const BY_ID = Object.fromEntries(VENDORS.map(v => [v.id, v]));

// A printer row saved before §171 carries no `vendor`, and every one of them
// is a Feie. That is the whole back-compat story: no migration, no backfill,
// and a tenant who never opens this screen notices nothing.
const DEFAULT_VENDOR = 'feie';

function resolve(vendorId) {
  return BY_ID[String(vendorId || DEFAULT_VENDOR)] || BY_ID[DEFAULT_VENDOR];
}

function isVendorId(v) {
  return Object.prototype.hasOwnProperty.call(BY_ID, String(v));
}

// The creds for one vendor out of a tenant's `integrations` bag. Keyed by
// vendor id, which is also the integrations key — feie → integrations.feie,
// spyun → integrations.spyun.
function credsFor(vendorId, integrations) {
  return (integrations || {})[resolve(vendorId).id] || {};
}

// Is ANY vendor configured for this tenant? This is the global "printing is
// switched on" gate, and it must not be `feieEnabled` — a Shangpeng-only
// tenant would be told printing is unconfigured while their printer sits
// there working.
function anyEnabled(integrations) {
  return VENDORS.some(v => v.enabled(credsFor(v.id, integrations)));
}

// Print one pre-rendered slip at one printer. `printer` is a saved row —
// { sn, copies, vendor? } — from `printer.by_store`, or the kitchen's
// equivalent. Resolves rather than throws, like everything on this rail.
function printContent(content, printer, integrations) {
  const p = printer || {};
  if (!p.sn) return Promise.resolve({ ok: false, msg: 'no_sn' });
  const vendor = resolve(p.vendor);
  const creds = credsFor(vendor.id, integrations);
  if (!vendor.enabled(creds)) return Promise.resolve({ ok: false, msg: 'not_configured' });
  return vendor.printContent(content, { sn: p.sn, copies: p.copies || 1 }, creds);
}

// What the admin picker renders. Names are the vendors' own registered names,
// so nothing here is composed (decisions §171, vocabulary Rule 4 not engaged).
function vendorOptions() {
  return VENDORS.map(v => ({ id: v.id, label_en: v.label_en, label_cn: v.label_cn }));
}

// Every credential field every vendor declares, for the Integrations panel and
// for the boot-time storefront_config → process.env hydration.
function allCredFields() {
  return VENDORS.flatMap(v => v.credFields.map(f => ({ ...f, vendor: v.id })));
}

module.exports = {
  VENDORS,
  DEFAULT_VENDOR,
  resolve,
  isVendorId,
  credsFor,
  anyEnabled,
  printContent,
  vendorOptions,
  allCredFields,
};
