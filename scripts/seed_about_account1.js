#!/usr/bin/env node
/**
 * Give account #1 its own About page — audit D-04.
 *
 * WHY THIS EXISTS. public/shop.html carried an ABOUT_DEFAULTS object: the
 * manifesto, EST. 2017, MADE IN 广州, "From soil to soul", the founder's quote
 * and the in/out list. It was the FIRST TENANT's copy, and it was handed to
 * every merchant who had not written an About page — merged field by field, so
 * a merchant who wrote half a page published the other half of somebody else's
 * story to their own customers.
 *
 * The storefront no longer does that: what a shop has not written, its
 * customers do not see. But account #1 never "wrote" this copy either — it
 * only ever existed as a constant in the client — so removing the constant
 * would have blanked THEIR live About page as a side effect of fixing
 * everybody else's.
 *
 * So this puts it where it always belonged: in account #1's own
 * storefront_config, as their content, editable from the admin's About page
 * editor like any other shop's. After it runs, their page renders exactly as
 * it did before, from data instead of from a default.
 *
 * RUN IT ON THE SERVER, ONCE:
 *
 *     cd /root/roots-v2 && node scripts/seed_about_account1.js          # dry run
 *     cd /root/roots-v2 && node scripts/seed_about_account1.js --apply  # write
 *
 * IT REFUSES TO OVERWRITE. If account #1 has already written an About page,
 * theirs is the real one and this exits without touching it. Idempotent: a
 * second --apply run finds the row and stops.
 */
'use strict';

const path = require('path');

const APPLY = process.argv.includes('--apply');
const KEY = 'about.content';

/* The constant, verbatim from public/shop.html as it stood at d230ec0 — the
   last commit before it was removed. Copied rather than imported because the
   point of this script is that the client no longer has it. */
const ROOTS_ABOUT = {
  kicker_en:'WHO WE ARE',kicker_cn:'我们是谁',
  manifesto_en:'We exist to make **plant-based food** so mind blowing good it transforms how people eat, how they see plants, and how we create a better, more sustainable future — without ever giving up flavor, health, or joy!',
  manifesto_cn:'我们存在的意义,是把**植物食物**做到令人惊艳的好——好到改变人们的饮食方式、对植物的认知,也改变我们共同走向更可持续未来的方式——而风味、健康与快乐,一样也不放下。',
  stats:[{value_en:'2017',value_cn:'2017',label_en:'EST.',label_cn:'成立'},{value_en:'广州',value_cn:'广州',label_en:'MADE IN',label_cn:'产地'},{value_en:'50+',value_cn:'50+',label_en:'PRODUCTS',label_cn:'产品'},{value_en:'100%',value_cn:'100%',label_en:'PLANT',label_cn:'植物'}],
  founder_kicker_en:'MEET THE FOUNDER',founder_kicker_cn:'创始人',
  founder_name_en:'Founder Name',founder_name_cn:'创始人姓名',
  founder_title_en:'FOUNDER & CEO',founder_title_cn:'创始人兼首席执行官',
  founder_quote_en:'I started Roots because I wanted to prove that plants don\'t have to be the boring option.',
  founder_quote_cn:'我创立 Roots,是想证明植物从来不该是无聊的选择。',
  founder_photo_url:'',
  promise_kicker_en:'OUR PROMISE',promise_kicker_cn:'我们的承诺',
  in_items:[{en:'100% plant-based',cn:'100% 植物'},{en:'Made from scratch',cn:'原料自制'},{en:'Real fermentation',cn:'真发酵'},{en:'Whole ingredients',cn:'完整食材'},{en:'Small batch',cn:'小批量'},{en:'Seasonal',cn:'应季'},{en:'Local-first · 广州',cn:'本地优先'},{en:'Recyclable packaging',cn:'可回收包装'}],
  out_items:[{en:'Preservatives',cn:'防腐剂'},{en:'Refined sugar',cn:'精制糖'},{en:'Artificial color',cn:'人造色素'},{en:'Artificial flavor',cn:'人造香精'},{en:'Additives',cn:'添加剂'},{en:'GMO',cn:'转基因'},{en:'Animal products',cn:'动物产品'},{en:'Cutting corners',cn:'走捷径'}],
  outro_en:'From soil to soul.',outro_cn:'从土壤到灵魂',
  cta_en:'SHOP NOW',cta_cn:'立即购买',
};

/* The hero photograph was a hardcoded /assets/brand path in the same file: one
   shop's picture at the top of every shop's story. It is content now, so it is
   seeded here with the rest of theirs. */
ROOTS_ABOUT.hero_image_url = '/assets/brand/welcome-roots.jpg';

function main() {
  const db = require(path.join(__dirname, '..', 'database'));

  const existing = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(KEY);
  if (existing && String(existing.value_json || '').trim() && existing.value_json !== 'null') {
    console.log('Account #1 already has ' + KEY + ' — leaving it alone.');
    console.log('Nothing to do. (That row is their real About page; this script never overwrites one.)');
    return 0;
  }

  const blob = JSON.stringify(ROOTS_ABOUT);
  console.log('Account #1 has no ' + KEY + '.');
  console.log('Would write ' + blob.length + ' bytes: '
    + Object.keys(ROOTS_ABOUT).length + ' fields, including the manifesto, the founder and the in/out list.');

  if (!APPLY) {
    console.log('');
    console.log('DRY RUN — nothing written. Re-run with --apply to write it.');
    return 0;
  }

  db.prepare('INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES (?, ?)').run(KEY, blob);
  const back = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(KEY);
  if (!back || back.value_json !== blob) {
    console.error('FAIL: wrote the row but read back something else. Nothing else was changed.');
    return 1;
  }
  console.log('');
  console.log('Written and read back byte for byte. Account #1\'s About page is now their own content.');
  console.log('It renders exactly as it did before; the difference is that it is now editable.');
  return 0;
}

process.exit(main());
