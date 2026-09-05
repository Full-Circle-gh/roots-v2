// Credential-gated transactional email for web sign-in codes.
//
// Provider-agnostic and dependency-free: uses the global `fetch` (Node 18+) to
// hit a transactional-email HTTP API. Ships with a Resend driver (the simplest
// key-only HTTP provider); SMTP is intentionally NOT bundled because it would
// pull in nodemailer. Tenant creds (integ().email) override env. When nothing is
// configured every call returns { ok:false, error:'email_unconfigured' } and the
// route falls back to its dev-echo path — mirroring the SMS/OTP pattern.
//
// Env:
//   EMAIL_PROVIDER   'resend' (default when EMAIL_API_KEY is set)
//   EMAIL_API_KEY    provider API key
//   EMAIL_API_URL    override endpoint (default Resend's)
//   EMAIL_FROM       verified sender, e.g. "Roots <hello@yourdomain.com>"

function cfg(creds) {
  creds = creds || {};
  const key = creds.api_key || process.env.EMAIL_API_KEY || '';
  return {
    provider: creds.provider || process.env.EMAIL_PROVIDER || (key ? 'resend' : ''),
    apiKey:   key,
    apiUrl:   creds.api_url || process.env.EMAIL_API_URL || 'https://api.resend.com/emails',
    from:     creds.from || process.env.EMAIL_FROM || '',
  };
}

function isConfigured(creds) {
  const c = cfg(creds);
  return !!(c.provider && c.apiKey && c.from);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

async function sendOtpEmail(to, code, creds, opts) {
  const c = cfg(creds);
  // ── The delivery record (audit P-03 / P-02) ────────────────────────────
  // Every exit here returned { ok:false, error } and the caller dropped it: a
  // sign-in code that never arrived left no trace, so "I never got the email"
  // could not be checked against anything. One helper on every path, so a
  // return added later cannot slip past it.
  //
  // THE CODE IS NEVER LOGGED — only that a code was sent, and to whom. A log
  // holding live one-time passcodes is a worse problem than the one this fixes.
  // The address is masked for the same reason a phone number is: whoever can
  // open the screen can read the log, and this is the customer's address.
  // `opts.kind` separates the two things that use this one template — a sign-in
  // code and a forgotten-password code. They read identically in the log
  // otherwise, and they are not the same event to whoever is reading it.
  const kind = (opts && opts.kind) || 'signin_code';
  const _log = (res) => {
    try {
      require('./notify-log').logNotification({
        channel: 'email',
        kind,
        subject: kind === 'password_reset_code' ? 'Password reset code' : 'Sign-in code',
        recipient: _maskEmail(to),
        ok: !!(res && res.ok),
        error: res && res.ok ? null : ((res && res.error) || 'unknown'),
      });
    } catch (e) { /* the log must never be able to fail a send */ }
    return res;
  };
  if (!isConfigured(creds)) return _log({ ok: false, error: 'email_unconfigured' });
  const brand = (opts && opts.brand) || '';
  // Co-brand: an absolute, public logo URL (tenant-keyed) when the tenant has one.
  // Only http(s) is allowed so a stray data:/javascript: can't ride into the email.
  const logoUrl = (opts && opts.logoUrl && /^https?:\/\//i.test(opts.logoUrl)) ? opts.logoUrl : '';
  const safeCode = escapeHtml(code);
  const subject = (brand ? brand + ' — ' : '') + 'Your sign-in code: ' + code;
  const text = 'Your verification code is ' + code +
    '\nIt expires in 5 minutes. If you did not request this, you can ignore this email.';
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:440px;margin:0 auto;padding:28px 24px;color:#1a1a17">' +
      (logoUrl ? '<img src="' + escapeHtml(logoUrl) + '" alt="' + escapeHtml(brand) + '" style="max-height:40px;max-width:180px;display:block;margin:0 0 16px">' : '') +
      (brand ? '<p style="font-size:14px;font-weight:700;letter-spacing:.04em;margin:0 0 18px">' + escapeHtml(brand) + '</p>' : '') +
      '<p style="font-size:15px;color:#444;margin:0">Your verification code</p>' +
      '<p style="font-size:36px;font-weight:700;letter-spacing:.2em;margin:10px 0 4px">' + safeCode + '</p>' +
      '<p style="font-size:13px;color:#888;margin:14px 0 0">Expires in 5 minutes. If you did not request this, ignore this email.</p>' +
    '</div>';

  try {
    if (c.provider === 'resend') {
      const r = await fetch(c.apiUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: c.from, to: [to], subject, text, html }),
      });
      if (r.ok) return _log({ ok: true });
      const body = await r.text().catch(() => '');
      return _log({ ok: false, error: 'resend_' + r.status + ':' + body.slice(0, 140) });
    }
    return _log({ ok: false, error: 'unknown_provider:' + c.provider });
  } catch (e) {
    return _log({ ok: false, error: 'send_threw:' + e.message });
  }
}

// First character and domain only: "a•••@example.com". Enough to recognise
// which address a code went to; not a copy of the address book.
function _maskEmail(raw) {
  const s = String(raw == null ? '' : raw);
  const at = s.indexOf('@');
  if (at < 1) return s ? '•••' : null;
  return s[0] + '•••' + s.slice(at);
}

module.exports = { isConfigured, sendOtpEmail };
