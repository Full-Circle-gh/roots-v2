'use strict';

// Sign a Qingyun store back in from a picture of its own browser (§484).
//
// Qingyun signs in by a QR code scanned with the 青云 App, so nobody needs to
// type into the login; they only need to see the code. Tacet already connects
// to each store's Qingyun browser over CDP (lib/qingyun-browser.js), so it
// takes the picture itself and nothing on the box changes.
//
// The one rule that matters: a picture is only ever taken after Qingyun has
// said the store is signed out, and only of the login page. The signed-in
// dashboard holds customers' addresses and phone numbers and is never shown.
//
// Who may do this is lib/channel-signin.js refusal(), the gate every channel
// sign-in passes (§250).

const { getQingyunBrowser } = require('./qingyun-browser');

// Two people watching the same store share one picture.
const PICTURE_MS = 1000;
const recent = {};   // store -> { at, out }
const inflight = {}; // store -> Promise

// Signed in means both reads the daemon trusts say so (#1222): the shop list,
// then one order-list page, which Qingyun can still refuse on its own.
async function signedIn(br) {
  if (!(await br.isLoggedIn())) return false;
  return br.orderListSignedIn();
}

// What the page shows now. One of:
//   { signedIn: true }
//   { signedIn: false, picture: <jpeg Buffer>, verify }   the code is up
//   { signedIn: false, noCode: true, verify }             not on the login page
// open: send the browser to the login page first if it is not on it.
// fresh: send it there even if it is (the code has expired).
async function look(store, opts = {}, deps = {}) {
  const get = deps.getBrowser || getQingyunBrowser;
  const br = await get(store);
  if (await signedIn(br)) return { signedIn: true };
  const verify = !!br.verificationRequired;
  if (opts.fresh || (opts.open && !br.onLoginPage())) {
    await br.openLoginPage();
    // A fresh document: whatever was pictured before is the old code.
    delete recent[store];
  }
  const picture = await br.loginPicture();
  if (!picture) return { signedIn: false, noCode: true, verify };
  return { signedIn: false, picture, verify };
}

// The picture the page polls for. It asks Qingyun first, every time it takes
// one, so the moment the scan lands it answers signed in instead.
async function picture(store, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const r = recent[store];
  if (r && now - r.at < PICTURE_MS) return r.out;
  if (!inflight[store]) {
    inflight[store] = look(store, {}, deps)
      .then((out) => { recent[store] = { at: deps.now ? deps.now() : Date.now(), out }; return out; })
      .finally(() => { delete inflight[store]; });
  }
  return inflight[store];
}

// Start, or Show a new code.
async function open(store, fresh, deps = {}) {
  delete recent[store];
  return look(store, { open: true, fresh: !!fresh }, deps);
}

function _reset() { for (const k of Object.keys(recent)) delete recent[k]; }

module.exports = { open, picture, PICTURE_MS, _reset };
