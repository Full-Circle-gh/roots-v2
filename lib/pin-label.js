'use strict';

// Pick the label that best describes what sits at a delivery pin, and whether
// that label agrees with the typed address. Reverse-geocode formatted_address
// often names a neighbour compound in dense areas (two towers on one island);
// POIs returned for the same coordinate usually name the building under the dot.

const { addressFindable, placeCoversAddress } = require('./qingyun-payload');

function fold(s) {
  return String(s || '').trim().replace(/\s+/g, '').replace(/[A-Za-z]/g, (c) => c.toLowerCase());
}

function findableVariants(findable) {
  const s = String(findable || '').trim();
  if (!s) return [];
  const out = [s];
  const road = s.match(/^[\u4e00-\u9fa5A-Za-z0-9]{1,14}(?:路|街|大道|巷|弄|大街)(.*)$/u);
  if (road && road[1].trim().length >= 3) out.push(road[1].trim());
  return out;
}

// Longest substring of `a` with at least `minHan` Han characters that also
// appears in `b`. Used only for pin-advice — tighter than dispatch bar.
function sharedHanCore(a, b, minHan = 4) {
  const fa = fold(a);
  const fb = fold(b);
  if (!fa || !fb) return '';
  for (let len = Math.min(fa.length, 24); len >= minHan; len--) {
    for (let i = 0; i + len <= fa.length; i++) {
      const sub = fa.slice(i, i + len);
      const han = (sub.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (han < minHan) continue;
      if (fb.includes(sub)) return sub;
    }
  }
  return '';
}

function pinAdviceAgrees(findable, pinName) {
  if (!findable || !pinName) return false;
  for (const v of findableVariants(findable)) {
    if (placeCoversAddress(v, pinName)) return true;
  }
  return !!sharedHanCore(findable, pinName, 4);
}

function collectPinNames({ formatted, regeoPois, nearbyPois } = {}) {
  const names = [];
  const push = (n) => {
    const s = String(n || '').trim();
    if (s && !names.includes(s)) names.push(s);
  };
  for (const p of nearbyPois || []) push(p.name);
  for (const p of regeoPois || []) push(p.name);
  push(formatted);
  return names;
}

// Returns { pinLabel, agrees } — pinLabel is what staff should read; agrees
// means the dot and the typed address name the same building (skip AI warning).
function resolvePinLabel({ addr, formatted, regeoPois, nearbyPois } = {}) {
  const findable = addressFindable(addr || {});
  const names = collectPinNames({ formatted, regeoPois, nearbyPois });
  if (!names.length) return { pinLabel: '', agrees: false };

  if (findable) {
    for (const name of names) {
      if (pinAdviceAgrees(findable, name)) return { pinLabel: name, agrees: true };
    }
  }
  return { pinLabel: names[0] || String(formatted || ''), agrees: false };
}

module.exports = {
  resolvePinLabel,
  pinAdviceAgrees,
  sharedHanCore,
  findableVariants,
  collectPinNames,
};
