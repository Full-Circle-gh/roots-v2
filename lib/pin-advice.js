'use strict';

// Advice only. Compares the address typed on the order with the place name
// the map gives for the pin a courier will navigate to. It never chooses a
// coordinate: the courier follows the pin, and a model does not have a better
// map than the one that produced it.

const SYSTEM = [
  'You compare a typed delivery address with the place name a map gives for the pin a courier will navigate to.',
  'You do not know a better coordinate. Never output a latitude, a longitude, or a new pin.',
  'Reply with one JSON object only, no markdown:',
  '{"verdict":"same"|"different"|"unsure","en":"...","cn":"..."}',
  'same: a courier standing on the pin is at the building the typed address names. A door, gate, or floor inside that same building is still same.',
  'different: the pin label and the typed address name different districts, roads, or buildings.',
  'unsure: the pin label is only a city, district, or road and does not name the building, so you cannot tell.',
  'Each sentence is one line, names the map place, and does not tell anyone to move a pin.',
].join('\n');

function stripCoords(s) {
  return String(s || '')
    .replace(/-?\d{1,3}\.\d{3,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function parseAdvice(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  let obj = null;
  if (a >= 0 && b > a) {
    try { obj = JSON.parse(raw.slice(a, b + 1)); } catch { obj = null; }
  }
  const verdict = obj && (obj.verdict === 'same' || obj.verdict === 'different' || obj.verdict === 'unsure')
    ? obj.verdict : 'unsure';
  return {
    verdict,
    en: stripCoords(obj && obj.en),
    cn: stripCoords(obj && obj.cn),
  };
}

function replyText(result) {
  const blocks = result && result.content_blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
}

// `call` is the model gateway. It receives the two labels and nothing else.
async function advise({ typed, pinLabel, pinDistrict, call } = {}) {
  const typedS = String(typed || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const pinS = String(pinLabel || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const district = String(pinDistrict || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!typedS || !pinS) return { verdict: 'unsure', en: '', cn: '' };
  if (typeof call !== 'function') throw new Error('pin_advice_no_model');
  const result = await call({
    system: SYSTEM,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Typed address:\n${typedS}\n\nMap label for the pin:\n${pinS}\nMap district: ${district}`,
    }],
  });
  return parseAdvice(replyText(result));
}

module.exports = { advise, parseAdvice, stripCoords, SYSTEM };
