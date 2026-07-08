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
  if (!isConfigured(creds)) return { ok: false, error: 'email_unconfigured' };
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
      if (r.ok) return { ok: true };
      const body = await r.text().catch(() => '');
      return { ok: false, error: 'resend_' + r.status + ':' + body.slice(0, 140) };
    }
    return { ok: false, error: 'unknown_provider:' + c.provider };
  } catch (e) {
    return { ok: false, error: 'send_threw:' + e.message };
  }
}

module.exports = { isConfigured, sendOtpEmail };
