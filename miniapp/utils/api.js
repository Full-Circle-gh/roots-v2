// Tiny fetch wrapper for the Roots backend. Centralizes:
//   • base URL (one constant to flip dev/staging/prod)
//   • Bearer-token auth header (read from globalData)
//   • JSON encode/decode
//   • { success: false, error } unwrapping so callers can `await api(...)`
//     and the resolved value is the data payload (or it throws).

const BASE = 'https://rootskitchenchina.com';

function request(path, opts = {}) {
  const app = getApp();
  const token = app?.globalData?.token || '';
  const headers = { 'Content-Type': 'application/json', ...(opts.header || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;

  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE + path,
      method: opts.method || 'GET',
      data: opts.data,
      header: headers,
      timeout: opts.timeout || 12000,
      success: (res) => {
        if (res.statusCode >= 500) return reject(new Error('server_error_' + res.statusCode));
        const body = res.data;
        if (res.statusCode === 401) {
          if (app) app.globalData.token = '';
          try { wx.removeStorageSync('token'); } catch {}
          return reject(new Error('unauthenticated'));
        }
        if (body && body.success === false) {
          // Attach the full response body so callers can read structured
          // info (e.g. needs_fallback_confirmation returns nearest +
          // fallback alongside the error code).
          const err = new Error(body.error || 'request_failed');
          err.body = body;
          err.status = res.statusCode;
          return reject(err);
        }
        if (res.statusCode >= 400) {
          const err = new Error('http_' + res.statusCode);
          err.body = body;
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(body?.data ?? body);
      },
      fail: (e) => reject(new Error('network_' + (e?.errMsg || 'unknown'))),
    });
  });
}

module.exports = {
  BASE,
  get:    (path, opts = {})       => request(path, { ...opts, method: 'GET' }),
  post:   (path, data, opts = {}) => request(path, { ...opts, method: 'POST', data }),
  put:    (path, data, opts = {}) => request(path, { ...opts, method: 'PUT',  data }),
  patch:  (path, data, opts = {}) => request(path, { ...opts, method: 'PATCH', data }),
  del:    (path, opts = {})       => request(path, { ...opts, method: 'DELETE' }),
  request,
};
