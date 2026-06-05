// Curated font library for AI Brand Studio (PROPOSAL — for your approval).
//
// The designer may only pick fonts that exist here, so every choice is one we
// can legally self-host on the already-whitelisted download domain
// (rootskitchenchina.com/assets/fonts/...). Bias toward SIL OFL / permissive
// licences so hosting is clean.
//
// `installed: true`  = already shipped in the app (miniapp/utils/fonts.js).
// `installed: false` = PROPOSED; needs the .woff2/.otf added under
//                      public/assets/fonts/ and registered in fonts.js before
//                      it can render. (M2 fast-follow: per-tenant custom upload.)
//
// scripts: 'latin' | 'cjk'. role: 'display' | 'body' | 'both'.

const FONT_LIBRARY = [
  // ── already installed (Roots) ──
  { family: 'Bear Serif',    role: 'display', scripts: ['latin'], license: 'proprietary', installed: true,  vibe: 'chunky editorial serif' },
  { family: 'Aleo',          role: 'body',    scripts: ['latin'], license: 'OFL',          installed: true,  vibe: 'warm slab serif' },
  { family: 'Toni Grotesk',  role: 'display', scripts: ['latin'], license: 'proprietary', installed: true,  vibe: 'tight uppercase grotesk' },
  { family: 'League Gothic', role: 'display', scripts: ['latin'], license: 'OFL',          installed: true,  vibe: 'tall condensed' },
  { family: 'Lilita One',    role: 'display', scripts: ['latin'], license: 'OFL',          installed: true,  vibe: 'rounded heavy poster' },
  { family: 'DF Yuan',       role: 'both',    scripts: ['cjk'],   license: 'proprietary', installed: true,  vibe: 'rounded Chinese sans' },

  // ── proposed Latin display (OFL / open) ──
  { family: 'Fraunces',          role: 'display', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'soft high-contrast serif, premium' },
  { family: 'Playfair Display',  role: 'display', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'classic elegant serif' },
  { family: 'Space Grotesk',     role: 'display', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'modern techy grotesk' },
  { family: 'Bricolage Grotesque', role: 'display', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'characterful contemporary' },
  { family: 'Syne',              role: 'display', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'arty, distinctive' },
  { family: 'DM Serif Display',  role: 'display', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'refined fashion serif' },
  { family: 'Archivo Black',     role: 'display', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'bold confident sans' },

  // ── proposed Latin body (OFL / open) ──
  { family: 'Inter',         role: 'body', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'neutral modern UI sans' },
  { family: 'Work Sans',     role: 'body', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'friendly geometric sans' },
  { family: 'Lora',          role: 'body', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'readable contemporary serif' },
  { family: 'Newsreader',    role: 'body', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'editorial reading serif' },
  { family: 'Manrope',       role: 'body', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'rounded modern sans' },
  { family: 'IBM Plex Sans', role: 'body', scripts: ['latin'], license: 'OFL', installed: false, vibe: 'corporate, precise' },

  // ── proposed CJK (open) — heavier files; subset for performance ──
  { family: 'Noto Sans SC',  role: 'both', scripts: ['cjk'], license: 'OFL', installed: false, vibe: 'neutral modern Chinese sans' },
  { family: 'Noto Serif SC', role: 'both', scripts: ['cjk'], license: 'OFL', installed: false, vibe: 'classic Chinese serif' },
  { family: 'LXGW WenKai',   role: 'both', scripts: ['cjk'], license: 'OFL', installed: false, vibe: 'warm handwritten kai' },
];

// Families currently renderable (installed) — the SAFE set the designer should
// prefer until proposed fonts are hosted. Pass to the prompt so the model
// doesn't pick a font that can't render yet.
function installedFamilies() {
  return FONT_LIBRARY.filter(f => f.installed).map(f => f.family);
}

// A compact, human-readable catalogue line for the system prompt.
function promptCatalogue({ installedOnly = true } = {}) {
  const list = FONT_LIBRARY.filter(f => !installedOnly || f.installed);
  return list.map(f => `${f.family} (${f.role}, ${f.scripts.join('/')}) — ${f.vibe}`).join('; ');
}

module.exports = { FONT_LIBRARY, installedFamilies, promptCatalogue };
