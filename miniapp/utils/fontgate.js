// Drives a page's `fontsReady` data flag so brand-font content can fade in once
// the brand fonts are available — avoiding the first-launch flash where text
// paints in a system font and then snaps to the brand face.
//
// Usage: give the page `fontsReady: true` in its data, call gate(this) in
// onLoad, and wrap the brand-font content in:
//   <view class="font-gate {{fontsReady ? '' : 'fonts-pending'}}">…</view>
//
// On every launch after the first, utils/fonts.js loads the fonts from the
// on-device cache, so app.globalData.fontsReady is already true (or flips in a
// few ms) and there's no perceptible hold.

function gate(page, cap = 1200) {
  const app = getApp();

  // Already loaded (cached launch) — show immediately, no fade.
  if (!app || app.globalData.fontsReady) {
    page.setData({ fontsReady: true });
    return;
  }

  page.setData({ fontsReady: false });

  let done = false;
  const reveal = () => {
    if (done) return;
    done = true;
    // The page may have unloaded while we waited.
    try { page.setData({ fontsReady: true }); } catch {}
  };

  if (app.fontsReady && app.fontsReady.then) app.fontsReady.then(reveal);
  // Safety cap: never leave brand text hidden if a font download stalls/fails.
  setTimeout(reveal, cap);
}

module.exports = { gate };
