// WHAT A PRODUCT PAGE SIGNS ITSELF WITH — one answer, for every surface.
//
// WHY THIS MODULE EXISTS (§158; §156 named this half as owed and more urgent).
//
// A Roots product page ends in a colophon: an illustrated character over a
// house line ("From Soil to Soul") over a name on a hairline rule ("Roots ·
// ESTD 2017"). All three were written as literals into the surfaces that draw
// them — the product page editor, and `miniapp/pages/product/product.js`.
//
// The mini app is published ONCE PER TENANT, each under its own WeChat AppID
// (see miniapp/utils/api.js), off this one shared codebase. So those literals
// were not Roots' own page signing itself: they were EVERY tenant's customer-
// facing product page signing itself as Roots. The category map below made it
// worse than a stray label — with no character chosen by anybody, it resolved
// to `soilsoul` and drew Roots' mascot onto a stranger's product by default.
//
// §156 fixed the editor and recorded the mini app as the more urgent half,
// because the editor's leak was seen by the office and this one is seen by the
// shopper. Fixing it needed the same answer on a SECOND surface, and a second
// copy of an answer is a second answer — which is the whole fault repeating.
// Hence one module, read by the admin route the editor asks and by the public
// config the mini app asks.
//
// THE ROOTS ANSWER IS BYTE-IDENTICAL to what both surfaces printed before, and
// scripts/test_brand_signature.js asserts that character for character. Nothing
// about Roots' pages changes; everybody else stops being signed as Roots.

// Roots' illustrated cast. The keys are the `colophon_character` values stored
// on products and the filenames under public/brand/ip-<key>.jpg, served at
// /assets/brand/ (server.js maps /assets to public/).
//
// Each file shows the drawing its label names (§504). Three drawings come
// twice, white line and black-filled; the black ones live under the three keys
// that never had a drawing of their own (soilsoul, kombucha-gang, hula). Keys
// are stored data, so they keep their names — read the label, not the key.
const ROOTS_CHARACTERS = [
  { key: 'soilsoul',      label: 'Onion (black)'    },
  { key: 'skater',        label: 'Skater'           },
  { key: 'kombucha-gang', label: 'Skater (black)'   },
  { key: 'flex',          label: 'Flex'             },
  { key: 'radishes',      label: 'Radishes'         },
  { key: 'mushroom',      label: 'Mushroom'         },
  { key: 'peas',          label: 'Peas'             },
  { key: 'onion',         label: 'Onion'            },
  { key: 'broccoli',      label: 'Broccoli'         },
  { key: 'hula',          label: 'Radishes (black)' },
];

// Which character a product gets when nobody has chosen one, by what the
// product IS. Roots' own filing of Roots' own cast — it means nothing to a shop
// that sells rugs, so it is only ever consulted for a tenant whose signature
// actually carries these characters, and `auto_map` is absent otherwise.
//
// Kept as [pattern, key] pairs of STRINGS rather than RegExp literals: this
// object is serialised to JSON for the mini app, and a RegExp does not survive
// that. Both readers compile them the same way, with the same flags.
const ROOTS_AUTO_MAP = [
  ['(sauce|dip|condiment|paste|chutney)', 'soilsoul'],
  ['(spread|butter|jam)',                 'skater'],
  ['(drink|kombucha|juice|beverage|tea)', 'skater'],
  ['(protein|powder|supplement|flour)',   'flex'],
  ['(root|tuber|carrot|radish|beet)',     'radishes'],
  ['(fungi|mushroom)',                    'mushroom'],
  ['(legume|bean|pea|lentil|chickpea)',   'peas'],
  ['(onion|allium|garlic|leek)',          'onion'],
  ['(broccoli|cabbage|leafy|green)',      'broccoli'],
];

const ROOTS_FALLBACK_CHARACTER = 'soilsoul';

/**
 * The signature for one tenant.
 *
 * @param {object|null} tenant  the row from `tenants`, or null/undefined for
 *   Roots. An ABSENT tenant and tenant #1 are the same answer, exactly as
 *   composeSystem(shop) in routes/ai.js already treats them: the kitchen realm
 *   carries no tenant row and the kitchen IS account #1.
 * @returns {{characters: Array, auto_map: Array, fallback_character: string,
 *            tagline_en: string, tagline_cn: string, house: string}}
 */
function signatureFor(tenant) {
  const isRoots = !tenant || Number(tenant.id) === 1;
  if (isRoots) {
    return {
      characters: ROOTS_CHARACTERS.map(c => ({ ...c })),
      auto_map: ROOTS_AUTO_MAP.map(p => p.slice()),
      fallback_character: ROOTS_FALLBACK_CHARACTER,
      tagline_en: 'From Soil to Soul',
      tagline_cn: '从土壤到灵魂',
      house: 'Roots · ESTD 2017',
    };
  }
  // EVERY OTHER SHOP GETS ITS OWN NAME AND NOTHING INVENTED. No cast, because
  // it has none and there is no per-tenant character store yet. No auto-map,
  // because there is nothing for it to pick from. No house line, because a
  // slogan is not something a platform can supply — and a colophon printing a
  // motto the platform made up is worse than a colophon with no line in it.
  // The name only if the tenant row carries one: a rule reading "undefined" is
  // worse than a rule with nothing on it.
  const house = String((tenant && (tenant.brand_name || tenant.name)) || '').trim();
  return {
    characters: [],
    auto_map: [],
    fallback_character: '',
    tagline_en: '', tagline_cn: '',
    house,
  };
}

/**
 * Resolve which character a product actually shows. Shared by every surface so
 * the phone, the preview and the thumbnail cannot disagree.
 *
 * THE ONE RULE: it can only ever return a character this shop HAS. An override
 * is honoured as-is — it is the product's stored choice and second-guessing it
 * would blank a page somebody deliberately signed — but an AUTO pick is checked
 * against the cast, and a shop with no cast gets no character at all.
 *
 * @param {object} signature  from signatureFor()
 * @param {string} override   products.colophon_character
 * @param {string} category   products.category
 * @returns {string} a character key, or '' for "draw no character"
 */
function resolveCharacter(signature, override, category) {
  const sig = signature || {};
  const chosen = String(override || '').trim();
  if (chosen) return chosen;
  const cast = Array.isArray(sig.characters) ? sig.characters : [];
  if (!cast.length) return '';
  const cat = String(category || '').toLowerCase();
  const map = Array.isArray(sig.auto_map) ? sig.auto_map : [];
  let key = '';
  for (const pair of map) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    let rx;
    try { rx = new RegExp(pair[0]); } catch (e) { continue; }
    if (rx.test(cat)) { key = String(pair[1]); break; }
  }
  if (!key) key = String(sig.fallback_character || '');
  return cast.some(c => c && c.key === key) ? key : '';
}

module.exports = {
  signatureFor, resolveCharacter,
  ROOTS_CHARACTERS, ROOTS_AUTO_MAP, ROOTS_FALLBACK_CHARACTER,
};
