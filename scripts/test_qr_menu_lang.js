// The QR menu's extra languages. Buttons are written. Dish text is saved
// once, and a number in the source has to survive the translation.
// No browser. No model.

'use strict';

const assert = require('assert');
const i18n = require('../lib/qr-menu-i18n');
const menuTr = require('../lib/qr-menu-translate');

// A stand-in for the one table. The suite that boots the menu uses the real
// database; this one only needs prepare/run/all, and the machine this file
// was written on has no compiled sqlite binding.
function fakeDb() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return {
        all(key) {
          const list = key ? rows.filter((r) => r.source_key === key) : rows.slice();
          if (/COUNT\(\*\)/.test(sql)) {
            return undefined;
          }
          return list.map((r) => ({ source_key: r.source_key, lang: r.lang, translated: r.translated }));
        },
        get(key) {
          const n = rows.filter((r) => r.source_key === key).length;
          return { n };
        },
        run(key, lang, translated) {
          const i = rows.findIndex((r) => r.source_key === key && r.lang === lang);
          if (i >= 0) rows[i].translated = translated;
          else rows.push({ source_key: key, lang, translated });
        },
      };
    },
    transaction(fn) { return () => fn(); },
  };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + (e && e.message));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + (e && e.message));
  }
}

check('sesame is a fixed word, not a sentence for the model', () => {
  assert.strictEqual(i18n.gloss('Sesame', 'ja'), 'ごま');
  assert.strictEqual(i18n.gloss('芝麻', 'ko'), '참깨');
  assert.strictEqual(i18n.gloss('Sesame', 'es'), 'Sésamo');
  assert.strictEqual(i18n.gloss('Sesame', 'ar'), 'سمسم');
  assert.strictEqual(i18n.gloss('moon cheese', 'es'), '');
});

check('a button is the written line, and a dish falls back to English', () => {
  const total = i18n.spans('Total', '合计', { lookup() { return null; } });
  assert.ok(total.includes('>合计<'), 'the Chinese total was replaced');
  assert.ok(total.includes('>합계<'), 'Korean total missing');
  assert.ok(!total.includes('data-sk'), 'a button was marked as dish text');

  let missed = null;
  const dish = i18n.spans('Hummus platter', '鹰嘴豆泥拼盘', {
    lookup() { return null; },
    miss(key, en, cn) { missed = { key, en, cn }; },
  });
  assert.ok(dish.includes('class="l-es"'), 'no Spanish span');
  assert.ok(dish.includes('>Hummus platter<'), 'missing Spanish did not fall back to English');
  assert.strictEqual(missed.en, 'Hummus platter');
  assert.strictEqual(missed.key, i18n.sourceKey('Hummus platter', '鹰嘴豆泥拼盘'));
});

check('a saved translation is what the Spanish span shows', () => {
  const key = i18n.sourceKey('Hummus platter', '鹰嘴豆泥拼盘');
  const html = i18n.spans('Hummus platter', '鹰嘴豆泥拼盘', {
    lookup(k) { return k === key ? { es: 'Bandeja de hummus', ko: '후무스', ja: 'フムス', ar: 'طبق حمص' } : null; },
  });
  assert.ok(html.includes('>Bandeja de hummus<'), html);
  assert.ok(i18n.translated('Hummus platter', '鹰嘴豆泥拼盘', () => ({ es: 'Bandeja de hummus' })));
  assert.ok(!i18n.translated('Total', '合计', () => ({ es: 'Total' })));
});

(async () => {
  await checkAsync('the model is asked once, and a changed number is not saved', async () => {
    assert.ok(/CREATE TABLE IF NOT EXISTS qr_menu_translations/.test(menuTr.SQL));
    const db = fakeDb();
    let calls = 0;
    const call = async () => {
      calls++;
      return {
        content_blocks: [{
          type: 'tool_use',
          name: 'menu_translations',
          input: {
            items: [
              { id: '0', es: 'Bandeja de hummus', ko: '후무스 플래터', ja: 'フムスの盛り合わせ', ar: 'طبق حمص' },
              { id: '1', es: 'Tostada de 99 g', ko: '99 g', ja: '99 g', ar: '99 g' },
            ],
          },
        }],
      };
    };
    const pairs = [
      { en: 'Hummus platter', cn: '鹰嘴豆泥拼盘' },
      { en: 'Almond toast 40g', cn: '杏仁吐司 40克' },
    ];
    await menuTr.fill(db, pairs, call);
    await menuTr.fill(db, pairs, call);
    assert.strictEqual(calls, 1, 'a saved line was sent to the model again');
    const hummus = db.prepare(
      'SELECT lang, translated FROM qr_menu_translations WHERE source_key = ? ORDER BY lang'
    ).all(i18n.sourceKey(pairs[0].en, pairs[0].cn));
    assert.strictEqual(hummus.length, 4);
    const bad = db.prepare(
      'SELECT COUNT(*) AS n FROM qr_menu_translations WHERE source_key = ?'
    ).get(i18n.sourceKey(pairs[1].en, pairs[1].cn));
    assert.strictEqual(bad.n, 0, 'a translation that changed 40 into 99 was saved');
    const posted = menuTr.pairsFromBody({
      need: [{ key: 'nope', en: pairs[0].en, cn: pairs[0].cn }, { key: i18n.sourceKey(pairs[0].en, pairs[0].cn), en: pairs[0].en, cn: pairs[0].cn }],
    });
    assert.strictEqual(posted.length, 1);
  });

  if (failed) {
    console.log(failed + ' failed');
    process.exit(1);
  }
  console.log('qr menu languages ok');
})();
