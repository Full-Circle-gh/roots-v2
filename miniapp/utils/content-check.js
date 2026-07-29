// What the app says when WeChat's content check refuses something a customer
// wrote or picked. Shared by the profile, review and feedback forms so the
// wording can't drift between them.
//
// The server answers a refused save with
//   { success: false, error: 'content_violation', message_en, message_cn }
// and api.js turns that into an Error with `.message` = the error code and
// `.body` = the full response.

const api = require('./api');

function isContentViolation(err) {
  return !!err && err.message === 'content_violation';
}

// One plain sentence. WeChat only asks that the customer be told their content
// contains something not allowed — naming the category would just teach people
// how to word their way around it.
function showContentViolation(err, lang) {
  const body = (err && err.body) || {};
  const cn = lang === 'cn';
  wx.showModal({
    title: cn ? '无法发布' : "Can't publish",
    content: cn
      ? (body.message_cn || '内容含违规信息，请修改后重试。')
      : (body.message_en || 'That contains something we cannot publish. Please change it and try again.'),
    showCancel: false,
    confirmText: cn ? '知道了' : 'OK',
  });
}

// WeChat judges pictures asynchronously — the verdict lands a second or two
// after the upload. Wait for it while the customer is still looking at the
// picture they chose, so we can say "not that one" then and there instead of
// removing it from under them minutes later.
//
// Resolves 'pass' | 'risky' | 'skipped' | 'unknown'. 'unknown' means the wait
// ran out; the picture is used for now and the server pulls it if the verdict
// turns out bad.
async function waitForImageVerdict(mediaUrl, tries = 8) {
  const id = String(mediaUrl || '').split('/').pop();
  if (!id) return 'unknown';
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await api.get('/api/retail/media/' + id + '/sec-status');
      if (r && r.status && r.status !== 'pending') return r.status;
    } catch (e) {
      return 'unknown';   // a poll failure must not strand the save
    }
  }
  return 'unknown';
}

module.exports = { isContentViolation, showContentViolation, waitForImageVerdict };
