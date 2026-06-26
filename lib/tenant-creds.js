// Per-tenant credential storage + resolver (Platform readiness ① — FOUNDATION).
//
// The home for every secret a tenant's mini-app backend needs to operate on
// ITS OWN accounts: WeChat AppSecret, WeChat Pay merchant creds, and the
// courier/printer integration keys. Values are encrypted at rest (AES-256-GCM
// via lib/secret-box.js) in the shared roots.db control plane; getTenantCreds()
// hands consumers a ready-to-use bundle so auth (②), pay (③) and integrations
// (⑤) become "thread the creds through" jobs instead of reading global env.
//
// ── The Roots carve-out (why this is safe to land with zero behaviour change)
// Roots (tenant #1) runs on the shared OUT1N app and reads its creds from .env
// today. getTenantCreds(1) — and any unscoped/null tenant — therefore returns
// an ENV-backed bundle, identical to the current global constants. Only
// NON-Roots tenants read from the encrypted table, and they get NO env
// fallback: a tenant with no stored Pay creds resolves to devMode, never to
// Roots' merchant. (Falling back to env would be exactly the cross-tenant
// clobber/leak this foundation exists to prevent.) So until a consumer is
// migrated to call this resolver, nothing changes; once migrated, Roots still
// behaves as before and new tenants use their own secrets.

const crypto = require('crypto');
const mainDb = require('../database');
const box = require('./secret-box');
const { ROOTS_TENANT_ID } = require('./tenant-db');

// ── Schema (idempotent, control-plane → shared roots.db only) ────────────
// One row per (tenant, key); `value_enc` is a secret-box token. Absence of a
// row means "not configured" (we delete rather than store empty), so callers
// can treat missing === unset without decrypting.
mainDb.exec(`
  CREATE TABLE IF NOT EXISTS tenant_secrets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    key         TEXT NOT NULL,
    value_enc   TEXT NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, key),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );
`);

// Canonical key namespace. Consumers reference these constants, never raw
// strings, so a typo can't silently store an unread secret.
const KEYS = {
  WX_APP_SECRET:      'wechat.app_secret',
  PAY_MCH_ID:         'wechat.pay.mch_id',
  PAY_API_V3_KEY:     'wechat.pay.api_v3_key',
  PAY_PRIVATE_KEY:    'wechat.pay.private_key',
  PAY_SERIAL_NO:      'wechat.pay.serial_no',
  PAY_PLATFORM_PUB_KEY: 'wechat.pay.platform_pub_key',  // WeChat's platform PUBLIC key — verifies inbound notify signatures (⑩)
  KD100_CUSTOMER:     'kd100.customer',
  KD100_KEY:          'kd100.key',
  KD100_SECRET:       'kd100.secret',
  KD100_CALLBACK:     'kd100.callback',
  JD_APP_KEY:         'jd.app_key',
  JD_APP_SECRET:      'jd.app_secret',
  JD_ACCESS_TOKEN:    'jd.access_token',
  JD_CUSTOMER_CODE:   'jd.customer_code',
  JD_ENV:             'jd.env',
  // Cloud-print (面单云打印) is a SEPARATE open-platform app on JD's NEWER
  // api.jdl.com gateway — a different app_key/secret from the JOS waybill app
  // above. Storing the cloud-print app in the main JD_APP_KEY/SECRET slots
  // breaks waybill creation (api.jd.com → "key 信息无效"), so it gets its own
  // keys. Optional — each falls back to the main JD app when unset.
  JD_JDL_APP_KEY:      'jd.jdl_app_key',
  JD_JDL_APP_SECRET:   'jd.jdl_app_secret',
  // Cloud-print can also require its own access_token even when waybill creation
  // uses api.jd.com. Falls back to the main access_token when unset.
  JD_JDL_ACCESS_TOKEN: 'jd.jdl_access_token',
  // LOP-DN service-domain for cloud-print (ydy). JD provides the external value.
  JD_JDL_LOP_DN:       'jd.jdl_lop_dn',
  // Cloud-print gateway host. Overseas/HK callers use https://hk-proxy.jdl.com
  // (per JD); mainland default is https://api.jdl.com.
  JD_JDL_GATEWAY:      'jd.jdl_gateway',
  FEIE_USER:          'feie.user',
  FEIE_UKEY:          'feie.ukey',
  WECOM_CORP_ID:      'wecom_app.corp_id',
  WECOM_AGENT_ID:     'wecom_app.agent_id',
  WECOM_SECRET:       'wecom_app.secret',
  // 诺诺发票 (Nuonuo) e-fapiao issuance — auto-issue + Nuonuo emails the PDF.
  NUONUO_APP_KEY:     'nuonuo.app_key',
  NUONUO_APP_SECRET:  'nuonuo.app_secret',
  NUONUO_SALER_TAX:   'nuonuo.saler_tax',   // 销方税号
  NUONUO_ENV:         'nuonuo.env',         // 'sandbox' | 'production'
  // 阿里云短信 (Aliyun SMS) — "package delivered" notice for out-of-GZ orders.
  ALIYUN_SMS_AK_ID:     'aliyun_sms.ak_id',              // AccessKey ID
  ALIYUN_SMS_AK_SECRET: 'aliyun_sms.ak_secret',          // AccessKey Secret
  ALIYUN_SMS_SIGN:      'aliyun_sms.sign_name',          // approved 签名 text
  ALIYUN_SMS_TPL_DELIV: 'aliyun_sms.template_delivered', // approved 模板CODE (delivered)
  ALIYUN_SMS_TPL_OTP:   'aliyun_sms.template_otp',       // approved 模板CODE (login verification code)
  // Meituan browser-sync credentials — one pair per store, keyed by store code.
  // Roots reads from env (MEITUAN_TIANHE_USER / MEITUAN_TIANHE_PASS etc.);
  // other tenants store in tenant_secrets via these keys.
  MEITUAN_TIANHE_USER:  'meituan.tianhe.user',
  MEITUAN_TIANHE_PASS:  'meituan.tianhe.pass',
  MEITUAN_YUEXIU_USER:  'meituan.yuexiu.user',
  MEITUAN_YUEXIU_PASS:  'meituan.yuexiu.pass',
};
const ALL_KEYS = Object.values(KEYS);

// Normalize a PEM private key the way retail.js does for the env path: stored
// values may carry literal "\n" escapes; turn them into real newlines so
// crypto.sign() gets a valid PEM. No-op if newlines are already real.
function pem(v) { return v ? String(v).replace(/\\n/g, '\n') : ''; }

const isRoots = (id) => !Number(id) || Number(id) === ROOTS_TENANT_ID;

// ── DB-bundle cache (per non-Roots tenant), invalidated on every write ────
const cache = new Map();
function invalidate(tenantId) { cache.delete(Number(tenantId)); }

// ── Writers ──────────────────────────────────────────────────────────────
// Store (or, for empty input, clear) a single secret. Encryption happens here;
// plaintext never reaches the DB. Returns true if a value was written.
function setTenantSecret(tenantId, key, plaintext) {
  const id = Number(tenantId);
  if (!id) throw new Error('tenant id required');
  if (!ALL_KEYS.includes(key)) throw new Error('unknown credential key: ' + key);
  const v = plaintext == null ? '' : String(plaintext);
  if (v === '') { clearTenantSecret(id, key); return false; }
  const enc = box.encrypt(v);
  mainDb.prepare(
    `INSERT INTO tenant_secrets (tenant_id, key, value_enc, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tenant_id, key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = CURRENT_TIMESTAMP`
  ).run(id, key, enc);
  invalidate(id);
  return true;
}

// Bulk write { key: value, ... } in one transaction. Empty values clear.
function setTenantSecrets(tenantId, map) {
  const id = Number(tenantId);
  const tx = mainDb.transaction(() => {
    for (const [k, val] of Object.entries(map || {})) setTenantSecret(id, k, val);
  });
  tx();
  invalidate(id);
}

function clearTenantSecret(tenantId, key) {
  mainDb.prepare('DELETE FROM tenant_secrets WHERE tenant_id = ? AND key = ?').run(Number(tenantId), key);
  invalidate(tenantId);
}

function clearAllTenantSecrets(tenantId) {
  mainDb.prepare('DELETE FROM tenant_secrets WHERE tenant_id = ?').run(Number(tenantId));
  invalidate(tenantId);
}

// ── Low-level reads ───────────────────────────────────────────────────────
// Decrypt every stored secret for a tenant → { key: plaintext }. Best-effort
// per row: a value that fails to decrypt (e.g. orphaned after a key rotation)
// is skipped rather than crashing the whole bundle.
function rawSecrets(tenantId) {
  const rows = mainDb.prepare('SELECT key, value_enc FROM tenant_secrets WHERE tenant_id = ?').all(Number(tenantId));
  const out = {};
  for (const r of rows) {
    const v = box.tryDecrypt(r.value_enc);
    if (v != null && v !== '') out[r.key] = v;
  }
  return out;
}

// Which credential keys are populated for a tenant (no values exposed) — for
// onboarding status UIs.
function listConfiguredKeys(tenantId) {
  return mainDb.prepare('SELECT key FROM tenant_secrets WHERE tenant_id = ?').all(Number(tenantId)).map(r => r.key);
}

// ── Bundle builders ───────────────────────────────────────────────────────
function rootsEnvBundle(tenantId) {
  const appId     = process.env.WECHAT_APP_ID || '';
  const appSecret = process.env.WECHAT_APP_SECRET || '';
  const mchId     = process.env.WECHAT_PAY_MCH_ID || '';
  const apiV3Key  = process.env.WECHAT_PAY_API_V3_KEY || '';
  const privateKey = pem(process.env.WECHAT_PAY_PRIVATE_KEY || '');
  const serialNo  = process.env.WECHAT_PAY_SERIAL_NO || '';
  // WeChat's platform public key / cert (verifies inbound notify signatures, ⑩).
  // Raw value; retail.js normalises it to PEM at verify time. Honours the
  // long-documented WECHAT_PAY_PUBLIC_CERT env name.
  const platformPubKey = process.env.WECHAT_PAY_PUBLIC_CERT || process.env.WECHAT_PAY_PLATFORM_PUB_KEY || '';
  return {
    tenantId: Number(tenantId) || ROOTS_TENANT_ID,
    source: 'env',
    wxAppId: appId,
    wechat: { appId, appSecret, devMode: !appId || !appSecret },
    pay:    { mchId, apiV3Key, privateKey, serialNo, platformPubKey, devMode: !mchId || !privateKey || !appId },
    integrations: {
      kd100: { customer: process.env.KD100_CUSTOMER || '', key: process.env.KD100_KEY || '', secret: process.env.KD100_SECRET || '', callback: process.env.KD100_CALLBACK || '' },
      jd:    { appKey: process.env.JD_APP_KEY || '', appSecret: process.env.JD_APP_SECRET || '', accessToken: process.env.JD_ACCESS_TOKEN || '', customerCode: process.env.JD_CUSTOMER_CODE || '', env: process.env.JD_API_ENV || '', jdlAppKey: process.env.JD_JDL_APP_KEY || '', jdlAppSecret: process.env.JD_JDL_APP_SECRET || '', jdlAccessToken: process.env.JD_JDL_ACCESS_TOKEN || '', jdlLopDn: process.env.JD_JDL_LOP_DN || '', jdlGateway: process.env.JD_JDL_GATEWAY || '' },
      feie:  { user: process.env.FEIE_USER || '', ukey: process.env.FEIE_UKEY || '' },
      wecom_app: { corpId: process.env.WECOM_CORP_ID || '', agentId: process.env.WECOM_AGENT_ID || '', secret: process.env.WECOM_SECRET || '' },
      nuonuo: { appKey: process.env.NUONUO_APP_KEY || '', appSecret: process.env.NUONUO_APP_SECRET || '', salerTaxNum: process.env.NUONUO_SALER_TAX || '', env: process.env.NUONUO_ENV || '' },
      aliyun_sms: { accessKeyId: process.env.ALIYUN_SMS_AK_ID || '', accessKeySecret: process.env.ALIYUN_SMS_AK_SECRET || '', signName: process.env.ALIYUN_SMS_SIGN || '', templateDelivered: process.env.ALIYUN_SMS_TPL_DELIV || '', templateOtp: process.env.ALIYUN_SMS_TPL_OTP || '' },
      meituan: {
        tianhe: { user: process.env.MEITUAN_TIANHE_USER || '', pass: process.env.MEITUAN_TIANHE_PASS || '' },
        yuexiu: { user: process.env.MEITUAN_YUEXIU_USER || '', pass: process.env.MEITUAN_YUEXIU_PASS || '' },
      },
    },
  };
}

function dbBundle(tenantId) {
  const id = Number(tenantId);
  const s = rawSecrets(id);
  const trow = mainDb.prepare('SELECT wx_appid FROM tenants WHERE id = ?').get(id) || {};
  const appId      = trow.wx_appid || '';
  const appSecret  = s[KEYS.WX_APP_SECRET] || '';
  const mchId      = s[KEYS.PAY_MCH_ID] || '';
  const apiV3Key   = s[KEYS.PAY_API_V3_KEY] || '';
  const privateKey = pem(s[KEYS.PAY_PRIVATE_KEY] || '');
  const serialNo   = s[KEYS.PAY_SERIAL_NO] || '';
  const platformPubKey = s[KEYS.PAY_PLATFORM_PUB_KEY] || '';   // verifies inbound notify signatures (⑩)
  return {
    tenantId: id,
    source: 'db',
    wxAppId: appId,
    wechat: { appId, appSecret, devMode: !appId || !appSecret },
    pay:    { mchId, apiV3Key, privateKey, serialNo, platformPubKey, devMode: !mchId || !privateKey || !appId },
    integrations: {
      kd100: { customer: s[KEYS.KD100_CUSTOMER] || '', key: s[KEYS.KD100_KEY] || '', secret: s[KEYS.KD100_SECRET] || '', callback: s[KEYS.KD100_CALLBACK] || '' },
      jd:    { appKey: s[KEYS.JD_APP_KEY] || '', appSecret: s[KEYS.JD_APP_SECRET] || '', accessToken: s[KEYS.JD_ACCESS_TOKEN] || '', customerCode: s[KEYS.JD_CUSTOMER_CODE] || '', env: s[KEYS.JD_ENV] || '', jdlAppKey: s[KEYS.JD_JDL_APP_KEY] || '', jdlAppSecret: s[KEYS.JD_JDL_APP_SECRET] || '', jdlAccessToken: s[KEYS.JD_JDL_ACCESS_TOKEN] || '', jdlLopDn: s[KEYS.JD_JDL_LOP_DN] || '', jdlGateway: s[KEYS.JD_JDL_GATEWAY] || '' },
      feie:  { user: s[KEYS.FEIE_USER] || '', ukey: s[KEYS.FEIE_UKEY] || '' },
      wecom_app: { corpId: s[KEYS.WECOM_CORP_ID] || '', agentId: s[KEYS.WECOM_AGENT_ID] || '', secret: s[KEYS.WECOM_SECRET] || '' },
      nuonuo: { appKey: s[KEYS.NUONUO_APP_KEY] || '', appSecret: s[KEYS.NUONUO_APP_SECRET] || '', salerTaxNum: s[KEYS.NUONUO_SALER_TAX] || '', env: s[KEYS.NUONUO_ENV] || '' },
      aliyun_sms: { accessKeyId: s[KEYS.ALIYUN_SMS_AK_ID] || '', accessKeySecret: s[KEYS.ALIYUN_SMS_AK_SECRET] || '', signName: s[KEYS.ALIYUN_SMS_SIGN] || '', templateDelivered: s[KEYS.ALIYUN_SMS_TPL_DELIV] || '', templateOtp: s[KEYS.ALIYUN_SMS_TPL_OTP] || '' },
      meituan: {
        tianhe: { user: s[KEYS.MEITUAN_TIANHE_USER] || '', pass: s[KEYS.MEITUAN_TIANHE_PASS] || '' },
        yuexiu: { user: s[KEYS.MEITUAN_YUEXIU_USER] || '', pass: s[KEYS.MEITUAN_YUEXIU_PASS] || '' },
      },
    },
  };
}

// ── The resolver everything depends on ────────────────────────────────────
// Roots / unscoped → env bundle (unchanged behaviour). Any other tenant →
// its own encrypted secrets, cached until the next write. Never mixes the two.
function getTenantCreds(tenantId) {
  if (isRoots(tenantId)) return rootsEnvBundle(tenantId);
  const id = Number(tenantId);
  if (cache.has(id)) return cache.get(id);
  const bundle = dbBundle(id);
  cache.set(id, bundle);
  return bundle;
}

// Non-secret presence/health summary for onboarding dashboards — booleans
// only, never the underlying values.
function credsStatus(tenantId) {
  const c = getTenantCreds(tenantId);
  return {
    tenantId: Number(tenantId) || ROOTS_TENANT_ID,
    source: c.source,
    secretKeyConfigured: box.isConfigured(),
    wxAppIdSet: !!c.wxAppId,
    wechatLoginReady: !c.wechat.devMode,
    payReady: !c.pay.devMode,
    integrations: {
      kd100: !!(c.integrations.kd100.key && c.integrations.kd100.customer),
      jd:    !!(c.integrations.jd.appKey && c.integrations.jd.appSecret),
      feie:  !!(c.integrations.feie.user && c.integrations.feie.ukey),
      wecom_app: !!(c.integrations.wecom_app.corpId && c.integrations.wecom_app.agentId && c.integrations.wecom_app.secret),
      nuonuo: !!(c.integrations.nuonuo.appKey && c.integrations.nuonuo.appSecret && c.integrations.nuonuo.salerTaxNum),
    },
  };
}

module.exports = {
  KEYS, ALL_KEYS,
  getTenantCreds, credsStatus,
  setTenantSecret, setTenantSecrets, clearTenantSecret, clearAllTenantSecrets,
  listConfiguredKeys,
  invalidate,
};
