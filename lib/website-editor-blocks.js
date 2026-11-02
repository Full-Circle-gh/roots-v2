// The brand website's facts strip and founder essay, as saved blocks.
//
// The strip used to be invented at draw time from About, and the essay
// used to be About's founder quote, so neither could be edited on the
// Website page. This is the one-shot copy those two layouts get, and the
// same rules the test runs. It does not draw anything.

const FOUNDER_KICKER_EN = "Founder's Story";
const FOUNDER_KICKER_CN = '创始人故事';

function isWebsiteStory(b) {
  if (!b || b.type !== 'recipe_story') return false;
  if (b.cta_target === 'story' || b.cta_target === 'about') return true;
  const k = String(b.kicker_en || b.kicker_cn || '');
  return /our story/i.test(k);
}

function statRows(about) {
  const raw = about && Array.isArray(about.stats) ? about.stats : [];
  return raw.filter(s => s && String(s.value_en || s.value_cn || '').trim()).slice(0, 4).map(s => ({
    value_en: String(s.value_en || ''),
    value_cn: String(s.value_cn || ''),
    label_en: String(s.label_en || ''),
    label_cn: String(s.label_cn || ''),
  }));
}

function freshId(blocks, base) {
  const ids = new Set((blocks || []).map(b => b && b.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(base + '-' + n)) n += 1;
  return base + '-' + n;
}

// Insert the strip after the first hero, which is where the page used to
// draw it. A layout that already has the block is returned as it was.
function withEditableFacts(layout, about) {
  const blocks = Array.isArray(layout) ? layout : [];
  if (!blocks.length) return blocks;
  if (blocks.some(b => b && b.type === 'about_stats')) return blocks;
  const stats = statRows(about);
  if (!stats.length) return blocks;
  const block = {
    id: freshId(blocks, 'about-stats'),
    type: 'about_stats',
    show_on: 'both',
    full_bleed: true,
    stats,
  };
  const next = blocks.slice();
  let hero = -1;
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] && next[i].type === 'hero_banner') { hero = i; break; }
  }
  next.splice(hero >= 0 ? hero + 1 : 0, 0, block);
  return next;
}

// The first Our story card keeps its body (that is the card) and gains the
// essay and the sign-off the popup was reading from About. The kicker visitors
// already see is written onto the card so a later edit in the editor is what
// the page shows.
function withEditableStory(layout, about) {
  const blocks = Array.isArray(layout) ? layout : [];
  const idx = blocks.findIndex(isWebsiteStory);
  if (idx < 0) return blocks;
  const b = blocks[idx];
  const c = about && typeof about === 'object' ? about : {};
  const next = Object.assign({}, b);
  let changed = false;
  if (!next.cta_target || next.cta_target === 'about') {
    next.cta_target = 'story';
    changed = true;
  }
  if (!String(next.kicker_en || '').trim() || /our story/i.test(String(next.kicker_en))) {
    if (next.kicker_en !== FOUNDER_KICKER_EN) { next.kicker_en = FOUNDER_KICKER_EN; changed = true; }
  }
  if (!String(next.kicker_cn || '').trim()) {
    next.kicker_cn = FOUNDER_KICKER_CN;
    changed = true;
  }
  if (next.essay_en == null && next.essay_cn == null) {
    const qe = String(c.founder_quote_en || '');
    const qc = String(c.founder_quote_cn || '');
    if (qe.trim() || qc.trim()) {
      next.essay_en = qe;
      next.essay_cn = qc;
      changed = true;
    }
  }
  if (next.signoff_en == null && next.signoff_cn == null) {
    const se = String(c.outro_en || '');
    const sc = String(c.outro_cn || '');
    if (se.trim() || sc.trim()) {
      next.signoff_en = se;
      next.signoff_cn = sc;
      changed = true;
    }
  }
  if (!changed) return blocks;
  const out = blocks.slice();
  out[idx] = next;
  return out;
}

module.exports = {
  FOUNDER_KICKER_EN,
  FOUNDER_KICKER_CN,
  isWebsiteStory,
  withEditableFacts,
  withEditableStory,
};
