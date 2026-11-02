// The four facts from About (2017, city, product count, plants) sit on the
// front page, under the hero. Only a shop that wrote them gets the strip —
// an empty About never borrows another shop's numbers. The web shop has the
// same rule on ShopBlocks.withFrontFacts; the test checks they agree.

function hasValue(s) {
  return !!(s && String(s.value_en || s.value_cn || '').trim());
}

function withFrontFacts(layout, about) {
  const blocks = Array.isArray(layout) ? layout : [];
  if (!blocks.length) return blocks;
  const stats = about && Array.isArray(about.stats)
    ? about.stats.filter(hasValue).slice(0, 4)
    : [];
  if (!stats.length) return blocks;
  if (blocks.some(b => b && b.type === 'about_stats')) return blocks;
  const block = { id: 'about-stats', type: 'about_stats', stats, full_bleed: true };
  const hero = blocks.findIndex(b => b && b.type === 'hero_banner');
  const next = blocks.slice();
  next.splice(hero >= 0 ? hero + 1 : 0, 0, block);
  return next;
}

module.exports = { withFrontFacts };
