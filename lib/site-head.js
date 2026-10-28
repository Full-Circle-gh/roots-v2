// The brand website's <head> tags for search and sharing (decisions §503
// rules 15–17). Link previews (WeChat, Facebook, WhatsApp) and ad crawlers read
// the raw HTML and do not run the page's scripts, so the title, description
// and share picture have to be in the page as the server sends it.
// public/site.html carries the placeholder below; serveSite (server.js)
// replaces it with what buildSiteHead returns.
'use strict';

const PLACEHOLDER = '<title>Website</title>';

const WEBSITE_META_MAX = { title: 80, description: 200, url: 300 };

function metaStr(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

// A picture is a path on this site or an https address; nothing else gets in.
function metaImage(v) {
  const u = String(v == null ? '' : v).trim().slice(0, WEBSITE_META_MAX.url);
  if (/^\/[^\s"'<>]*$/.test(u) && !u.startsWith('//')) return u;
  return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : '';
}

// The stored shape, cleaned. Used on the way in (the editor's PUT) and again
// on the way out, so a hand-edited row cannot put markup in the page.
function normalizeWebsiteMeta(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  return {
    title_en: metaStr(r.title_en, WEBSITE_META_MAX.title),
    title_cn: metaStr(r.title_cn, WEBSITE_META_MAX.title),
    description_en: metaStr(r.description_en, WEBSITE_META_MAX.description),
    description_cn: metaStr(r.description_cn, WEBSITE_META_MAX.description),
    image_url: metaImage(r.image_url),
  };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// cfg is the public config (lib/store-config loadConfig). English first: the
// site is for visitors from abroad (§503). host is the request's hostname.
function buildSiteHead(cfg, { host, preview } = {}) {
  const c = cfg || {};
  const meta = normalizeWebsiteMeta(c.website && c.website.meta);
  const site = (c.web && c.web.site) || {};
  const brand = metaStr(c.brand && c.brand.me_footer && c.brand.me_footer.wordmark_text, WEBSITE_META_MAX.title);
  const title = meta.title_en || meta.title_cn || metaStr(site.title_en || site.title_cn, WEBSITE_META_MAX.title) || brand || 'Website';
  const desc = meta.description_en || meta.description_cn || metaStr(site.description_en || site.description_cn, WEBSITE_META_MAX.description);
  let image = meta.image_url;
  if (!image) {
    const layout = (c.website && Array.isArray(c.website.layout)) ? c.website.layout : [];
    const first = layout.find(b => b && b.show_on !== 'miniapp' && metaImage(b.image_url));
    image = first ? metaImage(first.image_url) : '';
  }
  const origin = host ? 'https://' + String(host).toLowerCase().replace(/[^a-z0-9.\-]/g, '') : '';
  if (image && image.startsWith('/')) image = origin ? origin + image : '';

  const tags = ['<title>' + esc(title) + '</title>'];
  if (desc) tags.push('<meta name="description" content="' + esc(desc) + '">');
  tags.push('<meta property="og:type" content="website">');
  tags.push('<meta property="og:title" content="' + esc(title) + '">');
  if (desc) tags.push('<meta property="og:description" content="' + esc(desc) + '">');
  if (brand) tags.push('<meta property="og:site_name" content="' + esc(brand) + '">');
  if (image) tags.push('<meta property="og:image" content="' + esc(image) + '">');
  tags.push('<meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '">');
  if (preview) {
    tags.push('<meta name="robots" content="noindex">');
  } else if (origin) {
    tags.push('<link rel="canonical" href="' + esc(origin + '/') + '">');
    tags.push('<meta property="og:url" content="' + esc(origin + '/') + '">');
  }
  return tags.join('\n');
}

module.exports = { PLACEHOLDER, WEBSITE_META_MAX, normalizeWebsiteMeta, buildSiteHead };
