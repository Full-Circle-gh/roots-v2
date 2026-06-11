// Tiny fetch wrapper for the Roots backend. Centralizes:
//   • base URL (one constant to flip dev/staging/prod)
//   • Bearer-token auth header (read from globalData)
//   • JSON encode/decode
//   • { success: false, error } unwrapping so callers can `await api(...)`
//     and the resolved value is the data payload (or it throws).

const BASE = 'https://rootskitchenchina.com';

// This mini-app is published once per tenant, each under its OWN WeChat AppID.
// Sending that AppID on every call lets the multi-tenant backend route the
// request to the right tenant's storefront data + login/Pay credentials
// (Platform readiness ⑥). Roots' own build sends Roots' AppID, which the
// server maps back to the Roots tenant — i.e. behaviour is unchanged for Roots.
// getAccountInfoSync is synchronous + stable for the app's lifetime, so read
// it once and cache. Guarded so a non-WeChat runtime (devtools edge cases)
// never throws here.
let _wxAppId = '';
try { _wxAppId = (wx.getAccountInfoSync().miniProgram.appId) || ''; } catch (e) { _wxAppId = ''; }

function request(path, opts = {}, _retried = false) {
  const app = getApp();
  const token = app?.globalData?.token || '';
  const headers = { 'Content-Type': 'application/json', ...(opts.header || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (_wxAppId) headers['x-wx-appid'] = _wxAppId;

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
          // The token is gone server-side — expired, or an admin hit "force
          // logout" (which deletes every retail_auth_token row). The stale
          // token in globalData/storage will 401 on every subsequent call,
          // and nothing else re-runs wx.login mid-session, so without this
          // the customer is stuck on "unauthenticated" until they kill and
          // reopen the mini app. Recover transparently: run one fresh silent
          // login, then replay this request once. Give up only if re-login
          // fails (e.g. the account is also blocked) or the replay still 401s.
          const canReauth = !_retried && app && typeof app.reauth === 'function'
                            && path !== '/api/retail/auth';
          if (canReauth) {
            return app.reauth().then(
              () => request(path, opts, true).then(resolve, reject),
              (e) => reject(e instanceof Error ? e : new Error('unauthenticated')),
            );
          }
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
        // Default: unwrap to the data payload. opts.raw returns the FULL body
        // so callers can read fields that sit alongside `data` (e.g. `timing`).
        resolve(opts.raw ? body : (body?.data ?? body));
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
