#!/usr/bin/env node
/**
 * test_province_for_city.js — a city alone is enough to fill in its province.
 *
 *   node scripts/test_province_for_city.js
 *
 * WHAT IT GUARDS. A plain 'city' delivery zone stores only the city, so an
 * address picked inside one arrives as 佛山市 with no 省. normalizeChinaAddress
 * fills the province in from provinceForCity (lib/addresses.js), a table built
 * once from reference/china_regions.json. Couriers and waybills read that
 * province. Until this suite, nothing failed if the table broke: a deliberate
 * break while moving it to lib/ (decisions §477) went unnoticed by every suite.
 *
 * Behaviour only, no code read as text: the real module over the real dataset,
 * on a scratch database (the module loads lib/tenant-db, which opens one).
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

F.harness();
const ROOT = path.join(__dirname, '..');
const { provinceForCity, normalizeChinaAddress } = require(path.join(ROOT, 'lib', 'addresses'));
const REGIONS = require(path.join(ROOT, 'reference', 'china_regions.json'));

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
};

console.log('\n1. every city in the dataset finds its own province');
const cities = (REGIONS.cities || []).filter((c) => c.name_cn && c.province_cn);
ok(cities.length > 300, `the dataset is the full list (${cities.length} cities)`);
const SUFFIX = /(市|自治州|地区|盟)$/u;
const wrong = cities.filter((c) => provinceForCity(c.name_cn) !== c.province_cn);
ok(wrong.length === 0, 'by its full name',
  wrong.slice(0, 5).map((c) => `${c.name_cn} → ${provinceForCity(c.name_cn)}, want ${c.province_cn}`).join(' · '));
const wrongBare = cities.filter((c) => provinceForCity(c.name_cn.replace(SUFFIX, '')) !== c.province_cn);
ok(wrongBare.length === 0, 'and without its 市/自治州/地区/盟 suffix',
  wrongBare.slice(0, 5).map((c) => `${c.name_cn.replace(SUFFIX, '')} → ${provinceForCity(c.name_cn.replace(SUFFIX, ''))}`).join(' · '));

console.log('\n2. each suffix the table strips, by example');
for (const [city, want] of [
  ['佛山市', '广东省'], ['佛山', '广东省'],
  ['延边朝鲜族自治州', '吉林省'],
  ['大兴安岭地区', '黑龙江省'],
  ['锡林郭勒盟', '内蒙古自治区'],
  ['北京', '北京市'],
]) ok(provinceForCity(city) === want, `${city} → ${want}`, `got ${provinceForCity(city)}`);

console.log('\n3. nothing is invented');
ok(provinceForCity('') === null, 'an empty city gives no province');
ok(provinceForCity(null) === null, 'a missing city gives no province');
ok(provinceForCity('Foshan') === null, 'an English name is not guessed at');
ok(provinceForCity('不存在市') === null, 'a city not in the dataset gives no province');

console.log('\n4. the address cleaner uses it');
const filled = normalizeChinaAddress({ province: '', city: '佛山市', district: '禅城区', address: '季华五路1号' });
ok(filled.province === '广东省', 'a city-only address gets its province filled in', JSON.stringify(filled));
const kept = normalizeChinaAddress({ province: '广东省', city: '佛山市', district: '禅城区', address: '季华五路1号' });
ok(kept.province === '广东省', 'a province the customer gave is kept', JSON.stringify(kept));
const unknown = normalizeChinaAddress({ province: '', city: '不存在市', district: '', address: 'x' });
ok(!unknown.province, 'an unknown city leaves the province empty', JSON.stringify(unknown));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
