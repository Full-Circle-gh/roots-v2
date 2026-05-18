// Subscribe-message helper. WeChat requires user-initiated calls to
// wx.requestSubscribeMessage — we wrap that flow here:
//   1. Pull template IDs from the live config (admin set them in mp console
//      and stored them via /retail-admin → Settings)
//   2. Show the system prompt
//   3. If accepted, POST our backend so it can fire later when status changes

const api    = require('./api');
const config = require('./config');

async function requestOrderStatusSubscription(orderId) {
  try {
    const cfg = await config.load();
    const tplId = cfg?.notifications?.order_status_template_id;
    if (!tplId) {
      // No template registered yet — silently skip the prompt
      console.log('[notify] no order_status_template_id set, skipping subscribe prompt');
      return { skipped: true };
    }
    const r = await new Promise((resolve, reject) =>
      wx.requestSubscribeMessage({ tmplIds: [tplId], success: resolve, fail: reject })
    );
    if (r[tplId] === 'accept') {
      // Record the consent server-side so the admin status transition can
      // fire the push when it happens.
      try {
        await api.post('/api/retail/notifications/subscribe', {
          template_id: tplId,
          order_id: orderId,
        });
        return { ok: true };
      } catch (e) {
        console.warn('[notify] subscribe record failed:', e.message);
        return { ok: false, reason: e.message };
      }
    }
    return { ok: false, reason: 'declined' };
  } catch (e) {
    console.warn('[notify] requestSubscribeMessage failed:', e?.errMsg || e?.message);
    return { ok: false, reason: 'error' };
  }
}

module.exports = { requestOrderStatusSubscription };
