'use strict';

// The middle gap, in whole days. An even count averages the two middle gaps
// and rounds. A zero is not a gap: two orders on the same day say nothing
// about how often someone comes back.
function medianDays(gaps) {
  const xs = [];
  for (const n of gaps || []) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) xs.push(v);
  }
  xs.sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  const v = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return Math.round(v);
}

// Whole days from one YYYY-MM-DD to a later one. Null when either is missing.
function daysBetween(earlier, later) {
  if (!earlier || !later) return null;
  const a = Date.parse(String(earlier).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(later).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

module.exports = { medianDays, daysBetween };
