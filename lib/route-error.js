// The global error handler that server.js registers LAST, after every route.
//
// WHY IT LIVES HERE AND NOT INLINE IN server.js. So a test can run the real
// handler against a real express app. server.js cannot be required by a test
// without booting the whole application.
//
// WHY A BAD REQUEST IS NO LONGER A 500. This handler used to answer every error
// with a 500 and page ops. A request with a broken JSON body never reaches a
// route at all — express.json() rejects it first — yet it paged as
// "🔴 roots-v2 route error". The first one seen (2026-10-02) was a scanner
// probing POST /api/mdm/getAppInfo, a path this app has never had. Any bot
// sending junk could page ops, and a red alert that is usually noise teaches
// people to ignore red alerts.
//
// THE RULE. An error carrying a 4xx status (`status` or `statusCode`) says the
// request was bad. body-parser sets one on every rejection — malformed JSON 400,
// body too large 413, bad charset 415 — and so does app code that throws on bad
// input (normalizeDeeplink in routes/retail.js sets statusCode 400). Those get
// their own 4xx back, one log line, and no page. Everything else — no status,
// or a 5xx — is still ours: the stack logged, a 500, and a page, as before.
'use strict';

function clientErrorStatus(err) {
  if (!err || typeof err !== 'object') return 0;
  const s = Number(err.status != null ? err.status : err.statusCode);
  return Number.isInteger(s) && s >= 400 && s < 500 ? s : 0;
}

// `page(req, err)` sends the ops alert; server.js passes pageRouteError.
// The returned function MUST keep four parameters: express recognises error
// middleware by arity alone (see lib/express-async-guard.js).
function routeErrorHandler({ page }) {
  return function routeError(err, req, res, next) {
    const clientStatus = clientErrorStatus(err);
    if (clientStatus) {
      console.warn(`[route-client-error] ${clientStatus} ${req.method} ${req.originalUrl}: ${err.message}`);
      if (res.headersSent) return next(err);
      if (req.path.startsWith('/api/')) return res.status(clientStatus).json({ error: 'bad_request' });
      return res.status(clientStatus).send('Bad request');
    }
    console.error(`[route-error] ${req.method} ${req.originalUrl}:`, err && err.stack);
    page(req, err);
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error' });
    res.status(500).send('Server error');
  };
}

module.exports = { clientErrorStatus, routeErrorHandler };
