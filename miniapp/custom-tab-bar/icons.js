// Inline SVG icon library for the custom tab bar.
//
// Each style provides 4 named glyphs (home/shop/cart/me) as SVG strings with
// the literal token {COLOR} where the stroke / fill goes. The component
// substitutes the colour and base64-encodes the result into a data URI.
//
// Add a new style by appending a key with all 4 glyphs; expose it in the
// editor by adding to STYLES in retail-admin.html.

const ICONS = {
  outline: {
    home: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h3v-7h6v7h3a1 1 0 0 0 1-1V10"/></svg>',
    shop: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l-1 12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
    cart: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.4 11a1.5 1.5 0 0 0 1.5 1.2h7.5a1.5 1.5 0 0 0 1.5-1.2L20 7H6"/></svg>',
    me:   '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
  },

  solid: {
    home: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="{COLOR}"><path d="M12 3l9 8h-2v9a1 1 0 0 1-1 1h-4v-7h-4v7H6a1 1 0 0 1-1-1v-9H3l9-8z"/></svg>',
    shop: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="{COLOR}" fill-rule="evenodd"><path d="M9 6a3 3 0 0 1 6 0v2h3.2l-1.1 13a1 1 0 0 1-1 .9H7.9a1 1 0 0 1-1-.9L5.8 8H9V6zm2 0v2h2V6a1 1 0 0 0-2 0z"/></svg>',
    cart: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="{COLOR}"><path d="M2.5 3.4h2.7l.7 3H21l-1.7 7.7a1.5 1.5 0 0 1-1.5 1.2H9.1a1.5 1.5 0 0 1-1.5-1.2L5.1 4.6 2.8 4.4z"/><circle cx="9.5" cy="20" r="1.7"/><circle cx="17" cy="20" r="1.7"/></svg>',
    me:   '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="{COLOR}"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8H4z"/></svg>',
  },

  rounded: {
    home: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="{COLOR}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l8-7 8 7"/><path d="M6 11v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/></svg>',
    shop: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="{COLOR}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9h14l-1 11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 9z"/><path d="M8 9V7a4 4 0 0 1 8 0v2"/></svg>',
    cart: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="{COLOR}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.7"/><circle cx="17" cy="20" r="1.7"/><path d="M3 4h2.5l2.4 11.2a1.4 1.4 0 0 0 1.4 1.1h7.4a1.4 1.4 0 0 0 1.4-1.1L20.5 7H6.5"/></svg>',
    me:   '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="{COLOR}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="4"/><path d="M5 21c1-4 4-6 7-6s6 2 7 6"/></svg>',
  },

  duotone: {
    home: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="{COLOR}" fill-opacity=".22" d="M5 12v9h14v-9l-7-6z"/><path fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3 11l9-8 9 8M5 10v10a1 1 0 0 0 1 1h3v-7h6v7h3a1 1 0 0 0 1-1V10"/></svg>',
    shop: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="{COLOR}" fill-opacity=".22" d="M6 8h12l-1 12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 8z"/><path fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M6 8h12l-1 12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 8z"/><path fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
    cart: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="{COLOR}" fill-opacity=".22" d="M6 7h14l-1.6 7.4A1.5 1.5 0 0 1 17 16H9a1.5 1.5 0 0 1-1.5-1.2L6 7z"/><path fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3 4h2l2.4 11a1.5 1.5 0 0 0 1.5 1.2h7.5a1.5 1.5 0 0 0 1.5-1.2L20 7H6"/><circle cx="9" cy="20" r="1.4" fill="{COLOR}"/><circle cx="17" cy="20" r="1.4" fill="{COLOR}"/></svg>',
    me:   '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="4" fill="{COLOR}" fill-opacity=".22"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="{COLOR}" fill-opacity=".22"/><circle cx="12" cy="8" r="4" fill="none" stroke="{COLOR}" stroke-width="1.7"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="none" stroke="{COLOR}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
};

// WeChat's base64 helper. Falls back to a tiny encoder for older runtimes.
function toBase64(str) {
  try { return wx.arrayBufferToBase64(new TextEncoder().encode(str).buffer); }
  catch {
    // crude utf-8 → base64 fallback (BMP only; SVGs are ASCII so this is fine)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < str.length; i += 3) {
      const a = str.charCodeAt(i);
      const b = str.charCodeAt(i + 1);
      const c = str.charCodeAt(i + 2);
      const n = (a << 16) | ((isNaN(b) ? 0 : b) << 8) | (isNaN(c) ? 0 : c);
      out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
      out += isNaN(b) ? '=' : chars[(n >> 6) & 63];
      out += isNaN(c) ? '=' : chars[n & 63];
    }
    return out;
  }
}

function dataUri(style, name, color) {
  const set = ICONS[style] || ICONS.outline;
  const svg = (set[name] || ICONS.outline[name]).replace(/\{COLOR\}/g, color);
  return 'data:image/svg+xml;base64,' + toBase64(svg);
}

module.exports = { ICONS, dataUri };
