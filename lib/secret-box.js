// Secrets-at-rest primitive (Platform readiness ① — credential storage).
//
// AES-256-GCM authenticated encryption for per-tenant credentials that must
// live in the DB (WeChat AppSecret, WeChat Pay APIv3 key + merchant private
// key, courier/printer API keys, …). Plaintext NEVER touches disk: callers
// hand us a string, we return an opaque token; on read we authenticate +
// decrypt. A tampered or truncated ciphertext fails the GCM tag check and
// throws rather than returning garbage.
//
// Token format (versioned so we can rotate the scheme later):
//     v1.<iv_b64>.<tag_b64>.<ciphertext_b64>
//
// Master key — process.env.TENANT_SECRET_KEY — accepted as:
//   • 64 hex chars            → used as the raw 32-byte key
//   • 44-char base64 (32 B)   → decoded to the raw 32-byte key
//   • anything else           → treated as a passphrase, stretched to 32
//                               bytes with scrypt (fixed salt; the key value
//                               itself is the secret, so a static salt is
//                               fine for a single master key).
//
// If the key is absent, isConfigured() is false and encrypt/decrypt throw a
// clear error. The credential resolver only ever decrypts for NON-Roots
// tenants that have stored secrets, so Roots (which reads its creds from .env)
// keeps working whether or not this key is set — see lib/tenant-creds.js.

const crypto = require('crypto');

const KEY_ENV = 'TENANT_SECRET_KEY';
const SCRYPT_SALT = 'roots-v2/tenant-secret-box/v1';  // static: key value is the secret
const PREFIX = 'v1';

let _key = null;          // memoized 32-byte Buffer
let _resolved = false;    // whether we've attempted resolution

// Resolve (and memoize) the 32-byte master key, or null if unconfigured.
function resolveKey() {
  if (_resolved) return _key;
  _resolved = true;
  const raw = String(process.env[KEY_ENV] || '').trim();
  if (!raw) { _key = null; return _key; }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    _key = Buffer.from(raw, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const b = Buffer.from(raw, 'base64');
    _key = b.length === 32 ? b : crypto.scryptSync(raw, SCRYPT_SALT, 32);
  } else {
    _key = crypto.scryptSync(raw, SCRYPT_SALT, 32);
  }
  return _key;
}

function getKey() {
  const k = resolveKey();
  if (!k) {
    throw new Error(
      `[secret-box] ${KEY_ENV} is not set — cannot encrypt/decrypt tenant secrets. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" ` +
      `and add it to .env, then restart.`
    );
  }
  return k;
}

// True if a usable master key is configured. Lets callers degrade gracefully
// (e.g. surface "secret storage not configured" instead of throwing).
function isConfigured() { return !!resolveKey(); }

// Encrypt a plaintext string → opaque token. Empty/nullish input returns null
// (we never store empty secrets — absence is meaningful).
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);                 // 96-bit nonce (GCM standard)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

// Decrypt a token → plaintext string. Throws on a missing key, malformed
// token, or failed authentication (tampered/wrong-key ciphertext).
function decrypt(token) {
  if (token == null || token === '') return null;
  const key = getKey();
  const parts = String(token).split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('[secret-box] malformed ciphertext token');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Best-effort decrypt: returns null instead of throwing (e.g. after a key
// rotation that orphaned old ciphertext). Use when a missing/garbled secret
// should degrade to "not configured" rather than crash a request.
function tryDecrypt(token) {
  try { return decrypt(token); } catch (_) { return null; }
}

// Short, non-reversible fingerprint of the active key — lets ops confirm two
// boxes share the same TENANT_SECRET_KEY without exposing it.
function keyFingerprint() {
  const k = resolveKey();
  if (!k) return null;
  return crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
}

// Convenience for provisioning/docs: a fresh random key as 64 hex chars.
function generateKey() { return crypto.randomBytes(32).toString('hex'); }

module.exports = { encrypt, decrypt, tryDecrypt, isConfigured, keyFingerprint, generateKey, KEY_ENV };
