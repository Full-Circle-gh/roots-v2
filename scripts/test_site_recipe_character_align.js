#!/usr/bin/env node
/**
 * Brand site (§503 rule 43): on a phone a story IP character sits in the
 * kicker row; the headline starts below. alignRecipeStoryCharacters pins the
 * drawing after layout when the photo height is not fixed.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SITE = fs.readFileSync(path.join(__dirname, '../public/site.html'), 'utf8');
const fnBlock = SITE.match(/function alignRecipeStoryCharacters[\s\S]*?^}/m);
if (!fnBlock) {
  console.error('alignRecipeStoryCharacters not found in public/site.html');
  process.exit(1);
}

const pageHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#F2E7DF;font-family:serif;}
.shop-blocks{width:390px;margin:0 auto;}
.sb-blk-outer{position:relative;}
.sb-rcp-img img{width:100%;height:auto;display:block;}
.sb-rcp-body{padding:16px 22px 32px;}
.sb-rcp-kicker{font:700 16px sans-serif;letter-spacing:.08em;color:#6A6E2D;min-height:80px;padding-right:112px;display:flex;align-items:center;}
.sb-rcp-headline{font-size:32px;line-height:1.05;margin-top:0;font-family:serif;}
.sb-char{position:absolute;height:72px;width:auto;max-width:96px;right:12px;top:16px;}
</style></head><body>
<div class="shop-blocks"><div class="sb-blk-outer" data-block-type="recipe_story">
<div class="sb-recipe-blk"><div class="sb-rcp-img"><img id="photo" alt=""></div>
<div class="sb-rcp-body"><div class="sb-rcp-kicker">OUR STORY</div>
<div class="sb-rcp-headline">The Roots of It All</div></div></div>
<img class="sb-char" src="/assets/brand/cutout/ip-peas.png" alt=""></div></div>
<script>
${fnBlock[0]}
window.addEventListener('load',()=>alignRecipeStoryCharacters(document.body));
</script></body></html>`;

function rectsOverlap(a, b) {
  return a.bottom > b.top + 2 && a.right > b.left + 20;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.setContent(pageHtml, { waitUntil: 'load' });
  await page.evaluate(() => {
    const img = document.getElementById('photo');
    img.src = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="520"><rect fill="#ccc" width="100%" height="100%"/></svg>'
    );
  });
  await page.waitForFunction(() => {
    const img = document.getElementById('photo');
    return img && img.offsetHeight > 400;
  });
  await page.evaluate(() => alignRecipeStoryCharacters(document.body));

  const shot = path.join('/opt/cursor/artifacts', 'ip-character-align-after.png');
  await page.locator('.sb-blk-outer[data-block-type="recipe_story"]').screenshot({ path: shot });

  const m = await page.evaluate(() => {
    const outer = document.querySelector('.sb-blk-outer[data-block-type="recipe_story"]');
    const ch = outer.querySelector(':scope > .sb-char');
    const kicker = outer.querySelector('.sb-rcp-kicker');
    const headline = outer.querySelector('.sb-rcp-headline');
    const body = outer.querySelector('.sb-rcp-body');
    const r = (el) => el.getBoundingClientRect();
    const cr = r(ch), kr = r(kicker), hr = r(headline);
    return {
      inlineTop: ch.style.top,
      expectedTop: body.offsetTop + parseFloat(getComputedStyle(body).paddingTop || 0),
      charTop: Math.round(cr.top),
      kickerTop: Math.round(kr.top),
      headlineTop: Math.round(hr.top),
      charBottom: Math.round(cr.bottom),
      overlapHeadline: cr.bottom > hr.top + 2 && cr.right > hr.left + 20,
      charInKickerRow: cr.top >= kr.top - 4 && cr.top <= kr.bottom - 8,
    };
  });

  await browser.close();

  let failed = 0;
  function ok(cond, msg) {
    if (cond) console.log('  ✓', msg);
    else { console.log('  ✗', msg); failed++; }
  }

  console.log('\nSite recipe story character align');
  ok(m.inlineTop === (m.expectedTop + 'px'), 'character top matches body offset + 16px');
  ok(!m.overlapHeadline, 'character does not overlap the headline');
  ok(m.charBottom <= m.headlineTop + 2, 'character ends at or above the headline');
  ok(m.charInKickerRow, 'character sits in the kicker row');

  if (failed) process.exit(1);
  console.log('\nAll checks passed. Screenshot:', shot);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
