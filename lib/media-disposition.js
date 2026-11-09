// How a stored file is handed back. Images and fapiao PDFs render in the
// browser (Content-Disposition: inline). A fapiao the customer has to keep —
// reimbursement, the accountant, WeChat's in-app browser, which shows a PDF
// and no save control — asks for the same bytes as a download.
'use strict';

const EXT_FOR_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
};

// Our own media URLs only. A Nuonuo (or any other) link is left alone: we do
// not fetch it, and we do not tack a query onto someone else's address.
function fapiaoDownloadHref(url) {
  const u = String(url || '').trim();
  const m = u.match(/^(https?:\/\/[^/?#]+)?(\/api\/retail\/media\/\d+)(\?[^#]*)?(#.*)?$/);
  if (!m) return u;
  const q = m[3] || '';
  if (/(?:^|[?&])download=1(?:&|$)/.test(q)) return u;
  return (m[1] || '') + m[2] + (q ? q + '&download=1' : '?download=1') + (m[4] || '');
}

function wantsDownload(query) {
  const v = query && query.download;
  return v === '1' || v === 'true';
}

// attachment, with a filename the header cannot break out of. The stored name
// wins; a fapiao uploaded with none is still "fapiao.pdf".
function mediaContentDisposition(mime, filename) {
  const ext = EXT_FOR_MIME[mime] || 'bin';
  let base = String(filename || '').replace(/[\0\r\n]/g, '').split(/[/\\]/).pop().trim();
  if (!base || base === '.' || base === '..') base = 'fapiao.' + ext;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) base += '.' + ext;
  if (base.length > 180) base = base.slice(-180);
  const ascii = base.replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_');
  const star = encodeURIComponent(base).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

module.exports = { fapiaoDownloadHref, wantsDownload, mediaContentDisposition };
