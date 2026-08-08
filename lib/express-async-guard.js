// The async-error guard — STEP ZERO of the async conversion (decisions §24).
//
// WHY THIS EXISTS, AND WHY IT LANDS BEFORE ANY HANDLER BECOMES ASYNC
// ------------------------------------------------------------------
// Express 4 does NOT catch a rejected promise returned by a route handler. It
// calls the handler, ignores the return value, and moves on. So the moment a
// handler becomes `async`, any error inside it stops being a 500 and becomes an
// unhandled rejection: the request receives NO RESPONSE AT ALL and the client
// hangs until its own timeout. The process-level `unhandledRejection` guard in
// server.js logs and pages, but the request is already lost.
//
// 207 of routes/retail.js's 327 handlers contain no try/catch (measured by
// scripts/diagnose_async_conversion_scope.js). Converting any of them without
// this guard in place introduces exactly that failure, and it is a failure that
// only shows up under load or on an error path nobody exercised — spot-checking
// after a conversion will not find it.
//
// THIS FILE IS A NO-OP TODAY, BY DESIGN. Every handler in the application is
// currently synchronous, so nothing returns a promise and nothing below ever
// runs its promise branch. It is installed first, while it cannot change any
// behaviour, so that the protection is already proven and in place when the
// conversion starts.
//
// WHY GLOBAL RATHER THAN PER-ROUTE
// --------------------------------
// A per-route `asyncHandler(...)` wrapper can be forgotten — on one of 756
// existing handlers, or on the next handler somebody adds a year from now. The
// failure it prevents is silent. So the wrapping happens automatically at
// REGISTRATION time and there are no per-route call sites to maintain. The cost
// of that choice is that a reader of routes/*.js sees no wrapping and must know
// this file exists; that cost is paid by the comment in server.js where the
// routers are mounted.
//
// HOW IT WORKS — ONE CHOKE POINT, VERIFIED AGAINST express 4.22.1
// ----------------------------------------------------------------
// Both `router.get(path, ...handlers)` (lib/router/index.js:519) and
// `app.get(path, ...handlers)` (lib/application.js) delegate to
// `Route.prototype[method]` (lib/router/route.js:207). Patching Route.prototype
// therefore covers EVERY route handler registered either way, and — because
// `router.post(path, mwA, mwB, handler)` passes its middleware through the same
// call — it also covers per-route middleware such as requireRetailAdmin.
//
// Application-level middleware goes through `Router.use` instead, which
// `app.use` delegates to, so that is patched too.
//
// WHAT IS DELIBERATELY NOT WRAPPED, AND WHY EACH ONE MATTERS
// ----------------------------------------------------------
//   * FOUR-ARGUMENT FUNCTIONS. Express decides whether a function is error
//     middleware purely by its arity — `if (fn.length !== 4)` in
//     lib/router/layer.js:65. Wrapping one would change its arity, Express
//     would stop recognising it as an error handler, and the global handler in
//     server.js would silently never receive anything. This is the single most
//     dangerous thing this file could get wrong.
//   * ROUTERS AND SUB-APPS. `app.use(require('./routes/retail'))` passes a
//     router, which is itself a function. Wrapping it would break mounting.
//     Routers and apps are identified by having a `.handle` method.
//   * ANYTHING ALREADY WRAPPED. Marked with a symbol so double-installation or
//     re-registration cannot double-wrap.
//
// A SYNCHRONOUS THROW IS UNTOUCHED. The wrapper does not try/catch. A handler
// that throws synchronously throws straight through it, exactly as before, and
// Express's own Layer.handle_request try/catch turns it into next(err) as it
// always did. That is what makes this safe to install today.

'use strict';

const express = require('express');

// Marker on functions this module has already wrapped. Symbol.for so that two
// copies of this module loaded from different paths still recognise each other.
const GUARDED = Symbol.for('tacet.expressAsyncGuard');

// Route.prototype members that do not register handlers and must not be patched.
const NOT_HANDLER_REGISTRARS = new Set(['constructor', '_handles_method', 'dispatch', '_options']);

let wrappedCount = 0;

/** A mounted router or sub-app rather than a plain handler. */
function isRouterLike(fn) {
  return typeof fn === 'function' && typeof fn.handle === 'function';
}

/**
 * Wrap one handler so a rejected promise reaches Express's error path.
 * Returns the original function unchanged whenever wrapping would be unsafe.
 */
function wrapHandle(fn) {
  if (typeof fn !== 'function') return fn;
  if (fn[GUARDED]) return fn;              // already guarded
  if (fn.length === 4) return fn;          // error middleware — arity is load-bearing
  if (isRouterLike(fn)) return fn;         // a mounted router or sub-app

  const guarded = function (req, res, next) {
    // Call it exactly as Express would. No try/catch: a synchronous throw must
    // propagate untouched so Layer.handle_request handles it as it does today.
    const out = fn.apply(this, arguments);
    // Only a thenable gets the extra treatment. Sync handlers return undefined
    // and take this branch never, which is why today this is a no-op.
    if (out && typeof out.then === 'function' && typeof out.catch === 'function') {
      out.catch(next);
    }
    return out;
  };

  guarded[GUARDED] = true;
  guarded.__unguarded = fn;                 // for diagnostics and tests
  // Keep the name so stack traces and any name-based debugging still read true.
  try { Object.defineProperty(guarded, 'name', { value: fn.name, configurable: true }); }
  catch (e) { /* non-configurable name — cosmetic only, ignore */ }
  wrappedCount++;
  return guarded;
}

/** Map over registration arguments, wrapping functions and flattened arrays. */
function wrapArgs(args) {
  return args.map((a) => {
    if (Array.isArray(a)) return a.map(wrapHandle);
    if (typeof a === 'function') return wrapHandle(a);
    return a;                                // paths, option objects, etc.
  });
}

function install() {
  const RouteProto = express.Route && express.Route.prototype;
  const RouterProto = express.Router;        // in Express 4 the export IS the prototype

  if (!RouteProto || !RouterProto) {
    throw new Error('[express-async-guard] express.Route / express.Router not found — ' +
      'the Express internals this relies on have changed. Do NOT assume handlers are protected.');
  }

  // 1. Every handler-registering method on Route.prototype. Derived from the
  //    prototype itself rather than a hardcoded HTTP method list, so a method
  //    Express adds later is covered without an edit here.
  let patchedMethods = 0;
  for (const name of Object.getOwnPropertyNames(RouteProto)) {
    if (NOT_HANDLER_REGISTRARS.has(name)) continue;
    const original = RouteProto[name];
    if (typeof original !== 'function') continue;
    RouteProto[name] = function (...args) {
      return original.apply(this, wrapArgs(args));
    };
    patchedMethods++;
  }

  // 2. Application-level middleware. app.use delegates here, so one patch covers
  //    both router.use(...) and app.use(...).
  const originalUse = RouterProto.use;
  RouterProto.use = function use(...args) {
    return originalUse.apply(this, wrapArgs(args));
  };

  return { patchedMethods };
}

const result = install();

module.exports = {
  wrapHandle,
  patchedMethods: result.patchedMethods,
  /** How many handlers have been wrapped so far — for the coverage diagnostic. */
  wrappedCount: () => wrappedCount,
  GUARDED,
};
