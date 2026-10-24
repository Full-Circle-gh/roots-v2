// QR menu: send the old shop address to the ICP-filed one (§496 rule 4).
//
// WeChat accepts a payment directory only on a filed domain, and
// shop.rootskitchenchina.com has none. Menus already printed and stuck to
// tables point at it, so once shop.tacetapp.cn serves the menu, GET requests
// for /s/... on the old host are sent across.
//
// OFF UNLESS SHOP_MENU_REDIRECT_TO IS SET. A push to main deploys to production,
// and a redirect to a host that does not answer yet would break every printed
// QR. The setting is the switch: unset (every environment until someone sets
// it) this is a no-op and nothing is to be rolled back.
//
// GET/HEAD ONLY. A customer who opened the menu before the switch is on the old
// origin; their order POST must still land there, because a 302 turns a POST
// into a GET and a cross-origin fetch cannot follow it. 302, not 301, so a
// browser never caches the move and turning the setting off puts things back.
'use strict';

const OLD_HOST = 'shop.rootskitchenchina.com';
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// `target` is the new bare hostname, or empty for "off". A value that is not a
// plain hostname is treated as off rather than built into a Location header.
function shopMenuRedirect(target, oldHost = OLD_HOST) {
  const to = String(target || '').trim().toLowerCase();
  const on = HOST_RE.test(to) && to !== oldHost;
  return function shopMenuRedirectMw(req, res, next) {
    if (!on) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if ((req.hostname || '').toLowerCase() !== oldHost) return next();
    if (!req.path.startsWith('/s/')) return next();
    return res.redirect(302, 'https://' + to + req.originalUrl);
  };
}

module.exports = { shopMenuRedirect, OLD_HOST };
