// Second-pass OUT1N → store_products import.
// Fills DRAFT products (is_published=0) only. Safe: descriptions fill empty OR
// add images to a previously-image-stripped one; product images fill where
// missing; variant price/stock written ONLY for confident SIZE-variant matches.
// Images are downloaded from OUT1N CDN, resized (cap 1200px, JPEG q88) and
// embedded as base64. Usage: node scripts/import_full.js --dry | --apply
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');
let sharp; try { sharp = require('sharp'); } catch (e) { console.error('sharp missing'); process.exit(1); }

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
const out1n = require(path.join(__dirname, '..', 'data', 'fc_full.json'));
const drafts = require(path.join(__dirname, '..', 'data', 'store_drafts2.json'));
const APPLY = process.argv.includes('--apply');

const norm = s => (s || '').toLowerCase().replace(/＆/g, '&').replace(/[^a-z0-9]/g, '');
const isEmpty = s => !s || !String(s).replace(/<[^>]*>|&nbsp;|\s/g, '').trim();
const ALLOWED = new Set(['p','br','strong','b','em','i','u','ul','ol','li','h1','h2','h3','h4','h5','table','thead','tbody','tr','td','th','img']);

// keep <img> this time; clean junk/attrs; image src kept intact for fetching
function sanitize(h) {
  if (!h) return null;
  let s = h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/?([a-z0-9]+)\b([^>]*)>/gi, (m, tag, attrs) => {
    tag = tag.toLowerCase();
    if (!ALLOWED.has(tag)) return '';
    if (tag === 'img') { const src = (attrs.match(/\bsrc\s*=\s*("|')(.*?)\1/i) || [])[2]; return src ? `<img src="${src}">` : ''; }
    return m[1] === '/' ? `</${tag}>` : `<${tag}>`;
  });
  s = s.replace(/<br\s*\/?>/gi, '<br>').replace(/<p>\s*(<br>\s*)*<\/p>/gi, '').replace(/(<br>\s*){3,}/gi, '<br><br>').replace(/\s*\n\s*/g, '').trim();
  return isEmpty(s.replace(/<img[^>]*>/g, 'x')) ? null : s;
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(fetchBuffer(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
async function toResizedDataUri(url, cap = 1200, q = 88) {
  const buf = await fetchBuffer(url);
  const out = await sharp(buf).rotate().resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: q }).toBuffer();
  return 'data:image/jpeg;base64,' + out.toString('base64');
}

// ── Build OUT1N lookup ────────────────────────────────────────────────
const byNorm = {};
for (const r of out1n) { const n = norm(r.name); if (n && !byNorm[n]) byNorm[n] = r; }
const sizeVariantRecs = out1n.filter(r => (r.variants || []).some(v => /^(weight|size)\b/i.test(v.label || '')));

// extract a size token like "280g","500ml" or big/medium/small from text
const SIZE_RE = /(\d+\s?(?:g|kg|ml|l)\b)/i;
function sizeToken(s) { const m = (s || '').match(SIZE_RE); return m ? m[1].replace(/\s/g, '').toLowerCase() : null; }
function bigness(s) { s = (s || '').toLowerCase(); if (/\bbig|large|jumbo|大\b|（大）/.test(s)) return 'big'; if (/\bmedium|中\b|（中）/.test(s)) return 'med'; if (/\bsmall|mini|小\b|（小）/.test(s)) return 'small'; return null; }

const STOP = new Set(['the','and','for','size','flavor','flavour','new','with','plus']);
const tokenize = s => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
function matchDraft(d) {
  // 1) direct name match
  let rec = byNorm[norm(d.en)];
  let how = 'direct';
  if (!rec) {
    // 2) strip leading size words then match a size-variant parent
    const stripped = (d.en || '').replace(/\b(big size|medium size|large|big|medium|small size)\b/gi, '').replace(/\s+/g, ' ').trim();
    rec = byNorm[norm(stripped)] || sizeVariantRecs.find(r => norm(r.name) === norm(stripped));
    how = rec ? 'variant-parent' : null;
  }
  if (!rec) {
    // 3) flavor-aware subset match: every significant word of an OUT1N name
    // appears in the draft name. Pick the most specific (most words).
    const dw = tokenize(d.en);
    let best = null, bestLen = 0;
    for (const r of out1n) {
      const rw = tokenize(r.name);
      if (rw.length >= 2 && rw.every(w => dw.includes(w)) && rw.length > bestLen) { best = r; bestLen = rw.length; }
    }
    if (best) { rec = best; how = 'subset'; }
  }
  if (!rec) return { rec: null };
  // pick variant for size-variant records
  let variant = null, vWhy = null;
  const sizeVars = (rec.variants || []).filter(v => /^(weight|size)\b/i.test(v.label || ''));
  if (sizeVars.length) {
    const dTok = sizeToken(d.en) || sizeToken(d.cn);
    if (dTok) variant = sizeVars.find(v => (sizeToken(v.label) || '') === dTok) || null, vWhy = variant ? 'token:' + dTok : null;
    if (!variant) {
      const b = bigness(d.en) || bigness(d.cn);
      if (b) {
        const sorted = sizeVars.map(v => ({ v, n: parseFloat((sizeToken(v.label) || '0')) })).sort((a, z) => a.n - z.n);
        if (b === 'big') variant = sorted[sorted.length - 1].v; else if (b === 'small') variant = sorted[0].v; else if (b === 'med') variant = sorted[Math.floor(sorted.length / 2)].v;
        vWhy = variant ? 'bigness:' + b : null;
      }
    }
    if (!variant && sizeVars.length === 1) { variant = sizeVars[0]; vWhy = 'only-variant'; }
  }
  return { rec, how, variant, vWhy, hasSizeVars: sizeVars.length > 0 };
}

(async () => {
  const getRow = db.prepare('SELECT id,name_en,description_en,description_cn,description_format,image_data,retail_price,compare_at_price,retail_stock,weight FROM store_products WHERE id=?');
  let nDesc = 0, nImg = 0, nPrice = 0, nNoMatch = 0, imgFail = 0;
  const report = [], noMatch = [], variantReport = [];

  for (const d of drafts) {
    const cur = getRow.get(d.id);
    if (!cur) continue;
    const m = matchDraft(d);
    if (!m.rec) { noMatch.push(d.en); nNoMatch++; continue; }

    const planDescEn = sanitize(m.rec.en), planDescCn = sanitize(m.rec.cn);
    const curHasImgInDesc = /<img/.test(cur.description_en || '') || /<img/.test(cur.description_cn || '');
    const recHasImgInDesc = /<img/.test(m.rec.en || '') || /<img/.test(m.rec.cn || '');
    const willDesc = (isEmpty(cur.description_en) && planDescEn) || (isEmpty(cur.description_cn) && planDescCn) || (recHasImgInDesc && !curHasImgInDesc);
    const willImg = (!cur.image_data || cur.image_data.length < 100) && !!m.rec.pic;
    // Only auto-write price/stock for a CONFIDENT exact size-token match
    // (e.g. Walnuts 160g/280g). Approximate matches (yogurt 200g↔230g) are
    // reported for manual review, not written.
    const willPrice = !!m.variant && /^token:/.test(m.vWhy || '');

    if (willDesc) nDesc++;
    if (willImg) nImg++;
    if (willPrice) nPrice++;
    if (m.hasSizeVars) variantReport.push(`${willPrice ? '[PRICE SET]' : '[review]  '} ${d.id} ${d.en}  →  ${m.rec.name} :: ${m.variant ? m.variant.label + ' (¥' + m.variant.price + '/stk' + m.variant.stock + ') [' + m.vWhy + ']' : 'NO VARIANT MATCHED'}`);

    if (APPLY) {
      const sets = [], params = [];
      if (willDesc) {
        let en = (!isEmpty(cur.description_en) && !(recHasImgInDesc && !curHasImgInDesc)) ? cur.description_en : planDescEn;
        let cn = (!isEmpty(cur.description_cn) && !(recHasImgInDesc && !curHasImgInDesc)) ? cur.description_cn : planDescCn;
        // embed inline description images
        for (const html of [en, cn]) {}
        async function embed(html) {
          if (!html) return html;
          const urls = [...html.matchAll(/<img src="([^"]+)">/g)].map(x => x[1]);
          for (const u of urls) { try { const dataUri = await toResizedDataUri(u, 1000, 82); html = html.split(`<img src="${u}">`).join(`<img src="${dataUri}">`); } catch (e) { imgFail++; html = html.split(`<img src="${u}">`).join(''); } }
          return html;
        }
        en = await embed(en); cn = await embed(cn);
        sets.push('description_en=?', 'description_cn=?', "description_format='rich'"); params.push(en, cn);
      }
      if (willImg) { try { const di = await toResizedDataUri(m.rec.pic, 1200, 88); sets.push('image_data=?'); params.push(di); } catch (e) { imgFail++; } }
      if (willPrice) {
        sets.push('retail_price=?', 'compare_at_price=?', 'retail_stock=?'); params.push(m.variant.price, m.variant.comparePrice || null, m.variant.stock);
        if (m.variant.weight) { sets.push('weight=?'); params.push(m.variant.weight); }
      }
      if (sets.length) { params.push(d.id); db.prepare(`UPDATE store_products SET ${sets.join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...params); }
    }
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'} over ${drafts.length} drafts`);
  console.log(`  descriptions to fill/enrich: ${nDesc}`);
  console.log(`  product images to add:       ${nImg}`);
  console.log(`  size-variant price/stock set:${nPrice}`);
  console.log(`  no OUT1N match:              ${nNoMatch}`);
  if (APPLY) console.log(`  image fetch failures:        ${imgFail}`);
  console.log('\n── VARIANT DECISIONS (review these) ──');
  variantReport.forEach(l => console.log('  ' + l));
  console.log('\n── NO MATCH ──\n  ' + noMatch.join('\n  '));
})();
