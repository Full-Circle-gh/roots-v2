// English/pinyin shipping address → simplified Chinese.
//
// Chinese couriers read the address text on the waybill; a rider handed
// "Block 3, Pin Xiu Xing Yue Garden, Baiyun" has to guess. Worse, the mainland
// geocoders (Amap especially) reject or half-match Latin street text, so an
// English address also tends to resolve to a district centroid — a plausible
// looking pin kilometres from the door. Translating is therefore not cosmetic:
// it is what makes the coordinates trustworthy.
//
// Lives here (not in routes/retail.js) because THREE callers need the identical
// conversion:
//   • routes/retail.js  — address save (auto-heal) + the admin "Make address
//     Chinese" order tool;
//   • lib/qingyun-payload.js via its injected `translateCn` dep — last-resort
//     conversion at push time, so a legacy order whose snapshot is still
//     English never reaches a rider in English;
//   • scripts/qingyun-daemon.js — wires that dep in.
//
// Returns RAW parts (province/city/district/street). Canonicalization
// (normalizeChinaAddress + regionI18n) stays with the caller, because the web
// app has region tables the daemon doesn't.

'use strict';

const modelGateway = require('./model-gateway');

// Heuristic: does a string carry Latin letters (so it's worth translating)?
// Deliberately loose — a single English word in an otherwise Chinese address
// ('Room 901' tacked onto a Chinese estate name) is exactly the case that
// makes a geocoder fall back to a centroid.
function hasLatin(s) { return /[A-Za-z]/.test(String(s || '')); }

const ADDRESS_CN_TOOL = {
  name: 'chinese_address',
  description: 'Return the given Chinese-mainland shipping address as clean, fully simplified-Chinese mailing components. Translate any English or pinyin place and street names to their standard simplified-Chinese form (e.g. "Gongti North Rd" → "工体北路", "Sanlitun" → "三里屯", "Chaoyang District" → "朝阳区"). Use official administrative names. NEVER invent house, building, or unit numbers that are not present; keep any digits exactly as given. Leave a field empty only when it is genuinely absent.',
  input_schema: {
    type: 'object',
    properties: {
      province: { type: 'string', description: 'Province / municipality in Chinese, e.g. 北京 or 广东省' },
      city:     { type: 'string', description: 'City in Chinese, e.g. 北京市 or 广州市' },
      district: { type: 'string', description: 'District / county in Chinese, e.g. 朝阳区' },
      street:   { type: 'string', description: 'Everything below district level — road, building, apartment — in Chinese' },
    },
    required: ['street'],
  },
};

const SYSTEM = 'You convert a Chinese-mainland shipping address that contains English or pinyin into a clean, fully simplified-Chinese mailing address, split into province / city / district / street. Use official administrative names. Never invent numbers that are not present. Always answer by calling the chinese_address tool.';

function isConfigured() { return modelGateway.isConfigured(); }

// parts: { province, city, district, address, detail, full? }
// Returns Promise<{ province, city, district, street } | null>. Never throws —
// an unconfigured model or a bad answer is a soft miss, and callers keep the
// text they already had.
async function translateToChinese(parts = {}) {
  if (!modelGateway.isConfigured()) return null;
  const userMsg =
    `Current components:\n` +
    `province: ${parts.province || '(none)'}\n` +
    `city: ${parts.city || '(none)'}\n` +
    `district: ${parts.district || '(none)'}\n` +
    `street: ${parts.address || '(none)'}\n` +
    `detail: ${parts.detail || '(none)'}` +
    (parts.full ? `\n\nFull one-line address as entered:\n${parts.full}` : '');
  try {
    const out = await modelGateway.callModel({
      system: SYSTEM, tools: [ADDRESS_CN_TOOL],
      messages: [{ role: 'user', content: userMsg }], max_tokens: 500,
    });
    const ai = modelGateway.extractToolUse(out.content_blocks, 'chinese_address') || {};
    const pick = (s) => (s == null ? '' : String(s).trim().slice(0, 200));
    const street = pick(ai.street);
    if (!street) return null;
    return {
      province: pick(ai.province), city: pick(ai.city),
      district: pick(ai.district), street,
    };
  } catch (e) {
    console.warn('[address-cn]', e && (e.message || e));
    return null;
  }
}

module.exports = { hasLatin, translateToChinese, isConfigured, ADDRESS_CN_TOOL };
