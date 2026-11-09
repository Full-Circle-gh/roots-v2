// The customer's fapiao file. View opens it. Download asks our media route to
// send it as a file (WeChat's PDF viewer has no save control unless the menu
// is on, and a chat file is what finance actually keeps).
// fapiaoDownloadHref is the same function as lib/media-disposition.js — the
// mini app cannot require that file. scripts/test_fapiao_download.js checks
// the two copies still match.

function fapiaoDownloadHref(url) {
  const u = String(url || '').trim();
  const m = u.match(/^(https?:\/\/[^/?#]+)?(\/api\/retail\/media\/\d+)(\?[^#]*)?(#.*)?$/);
  if (!m) return u;
  const q = m[3] || '';
  if (/(?:^|[?&])download=1(?:&|$)/.test(q)) return u;
  return (m[1] || '') + m[2] + (q ? q + '&download=1' : '?download=1') + (m[4] || '');
}

function absFapiaoUrl(url, base) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (String(url).startsWith('/')) return String(base || '') + url;
  return url;
}

function fapiaoKind(url, filePath) {
  const s = (String(filePath || '') + ' ' + String(url || '')).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)(?:\?|$|\s)/.test(s)) return 'image';
  return 'pdf';
}

// download: offer the file to a chat (the way a fapiao is forwarded), and if
// that sheet cannot open, the viewer with its menu — forward, save, open in
// another app. A cancelled share stays cancelled.
function openCustomerFapiao(url, opts) {
  const download = !!(opts && opts.download);
  const base = opts && opts.base;
  const onFail = (opts && opts.onFail) || function () {};
  const target = download ? fapiaoDownloadHref(url) : url;
  const full = absFapiaoUrl(target, base);
  if (!full || typeof wx === 'undefined') { onFail(full); return; }
  wx.showLoading({ title: '' });
  wx.downloadFile({
    url: full,
    success(res) {
      wx.hideLoading();
      if (!res || res.statusCode !== 200 || !res.tempFilePath) { onFail(full); return; }
      const kind = fapiaoKind(url, res.tempFilePath);
      if (kind === 'image' && !download) {
        wx.previewImage({ urls: [res.tempFilePath], fail: () => onFail(full) });
        return;
      }
      const open = () => {
        if (kind === 'image') {
          wx.previewImage({ urls: [res.tempFilePath], fail: () => onFail(full) });
          return;
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          showMenu: true,
          fileType: 'pdf',
          fail: () => onFail(full),
        });
      };
      if (download && typeof wx.shareFileMessage === 'function') {
        wx.shareFileMessage({
          filePath: res.tempFilePath,
          fileName: kind === 'image' ? 'fapiao.jpg' : 'fapiao.pdf',
          fail(err) {
            const msg = String(err && err.errMsg || '');
            if (/cancel/i.test(msg)) return;
            open();
          },
        });
      } else {
        open();
      }
    },
    fail() { wx.hideLoading(); onFail(full); },
  });
}

module.exports = { fapiaoDownloadHref, absFapiaoUrl, openCustomerFapiao };
