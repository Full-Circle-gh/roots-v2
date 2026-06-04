// Visibility-scoped poller. Pages start it on onShow and stop it on
// onHide/onUnload so order status (paid → preparing → on the way …) updates
// on screen without the user pulling to refresh. The callback runs every
// intervalMs while the page is visible; rejections are swallowed so a flaky
// network never stacks unhandled errors.

function createPoller(fn, intervalMs = 15000) {
  let timer = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try { Promise.resolve(fn()).catch(() => {}); } catch {}
      }, intervalMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = { createPoller };
