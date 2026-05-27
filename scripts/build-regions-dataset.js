// Regenerate lib/china_districts.json — { cityNameCn: [{name_cn, name_en}] }.
//
// Sources (current + complete Chinese, with bilingual English):
//   • uiwjs/province-city-china  — current & complete Chinese admin divisions
//   • khaeru/gb2260              — English names by GB/T 2260 code (older subset)
//   • pinyin-pro                 — pinyin romanization fallback for the rest
//   • reference/china_regions.json — curated English overlay (Guangzhou districts)
//
// To regenerate:
//   mkdir -p reference/_tmp
//   curl -s -o reference/_tmp/uiwjs_province.json https://raw.githubusercontent.com/uiwjs/province-city-china/master/packages/core/dist/province.json
//   curl -s -o reference/_tmp/uiwjs_city.json     https://raw.githubusercontent.com/uiwjs/province-city-china/master/packages/core/dist/city.json
//   curl -s -o reference/_tmp/uiwjs_area.json     https://raw.githubusercontent.com/uiwjs/province-city-china/master/packages/core/dist/area.json
//   curl -s -o reference/_tmp/gb2260.csv          https://raw.githubusercontent.com/khaeru/gb2260/master/gb2260/data/unified.csv
//   npm install --no-save pinyin-pro
//   node scripts/build-regions-dataset.js
//   rm -rf reference/_tmp
const fs = require('fs');
const T = 'reference/_tmp/';
const provinces = JSON.parse(fs.readFileSync(T + 'uiwjs_province.json', 'utf8'));
const cities    = JSON.parse(fs.readFileSync(T + 'uiwjs_city.json', 'utf8'));
const areas     = JSON.parse(fs.readFileSync(T + 'uiwjs_area.json', 'utf8'));

// gb2260 English by 6-digit code
const csv = fs.readFileSync(T + 'gb2260.csv', 'utf8').split(/\r?\n/).filter(Boolean);
const head = csv.shift().split(',');
const cC = head.indexOf('code'), cE = head.indexOf('name_en');
const enByCode = new Map();
for (const line of csv) {
  const f = line.split(',');
  if (f[cE] && !/city area/i.test(f[cE])) enByCode.set(f[cC], f[cE]);
}

let pinyin = null;
try { pinyin = require('pinyin-pro').pinyin; } catch {}
function toEnglish(nameCn) {
  // strip the admin suffix, romanize the rest
  const stem = nameCn.replace(/(区|县|市|旗|盟|自治州|自治县|特区|林区)$/u, '');
  if (!pinyin) return null;
  const py = pinyin(stem, { toneType: 'none', type: 'array' }).join('');
  return py ? py.charAt(0).toUpperCase() + py.slice(1) : null;
}

const provName = new Map(provinces.map(p => [p.code.slice(0, 2), p.name]));
const cityName = new Map(cities.map(c => [c.code.slice(0, 4), c.name]));

const out = {};
let total = 0, fromGb = 0, fromPy = 0, noEn = 0;
for (const a of areas) {
  // Skip non-district wrapper rows that some datasets carry at the area level.
  if (/^(市辖区|县|市本级|省直辖县级行政区划|省直辖)$/u.test(a.name)) continue;
  const prov = a.code.slice(0, 2);
  const cKey = a.code.slice(0, 4);
  let city = cityName.get(cKey);
  if (!city || city === '市辖区' || city === '县') city = provName.get(prov);
  if (!city) continue;
  let en = enByCode.get(a.code);
  if (en) fromGb++; else { en = toEnglish(a.name); if (en) fromPy++; else noEn++; }
  (out[city] = out[city] || []).push({ name_cn: a.name, name_en: en || a.name });
  total++;
}

// Overlay curated English from the existing catalogue (better than pinyin for
// the areas it covers — notably the Guangzhou districts: Huadu not Huadou).
try {
  const cr = require('../reference/china_regions.json');
  const curated = new Map((cr.guangzhou_districts || []).map(d => [d.name_cn, d.name_en]));
  for (const d of (out['广州市'] || [])) {
    if (curated.has(d.name_cn)) d.name_en = curated.get(d.name_cn);
  }
} catch {}

fs.writeFileSync('lib/china_districts.json', JSON.stringify(out), 'utf8');
console.log('cities:', Object.keys(out).length, '| districts:', total, '| english from gb2260:', fromGb, '| from pinyin:', fromPy, '| none:', noEn);
console.log('size (KB):', Math.round(fs.statSync('lib/china_districts.json').size / 1024));
