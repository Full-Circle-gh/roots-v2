// ─────────────────────────────────────────────────────────────────────
// MODEL GATEWAY — the single, isolated boundary between this application
// and the upstream language-model API.
//
// EVERYTHING else in the codebase talks to the model through THIS module
// via neutral names (callModel / extractToolUse / extractText). The
// application's business logic contains no vendor identifiers; only this
// one file knows the upstream wire format. That is the white-label
// boundary: scrub the rest of the repo, guard this file.
//
// CONFIG — neutral env vars, with backward-compatible fallback to the
// legacy names so PRODUCTION KEEPS WORKING WITH NO .env CHANGE:
//   MODEL_API_URL     upstream endpoint   (fallback: ANTHROPIC_URL, then public default)
//   MODEL_API_KEY     upstream auth key   (fallback: ANTHROPIC_API_KEY)
//   MODEL_NAME        model identifier    (fallback: ANTHROPIC_MODEL, then DEFAULT_MODEL)
//   MODEL_API_SECRET  relay shared secret (fallback: ANTHROPIC_PROXY_SECRET)
// Rename the server's .env at leisure; until then the fallbacks keep the
// existing key working untouched.
//
// TIER 2 (recommended, removes ALL upstream tells from this repo): point
// MODEL_API_URL at a self-hosted relay that exposes a NEUTRAL request /
// response schema and translates to the upstream internally. Then even the
// version header + message shape below live only on the relay, and the
// whole application repo is free of any upstream-identifying format.
// ─────────────────────────────────────────────────────────────────────

// Last-resort model id when neither MODEL_NAME nor the legacy var is set.
// (To fully remove this single literal: set MODEL_NAME in .env, or adopt
// the Tier-2 relay above.)
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Upstream API version pin. Lives here only — the one unavoidable wire tell
// in Tier 1; the Tier-2 relay removes it from the repo entirely.
const UPSTREAM_API_VERSION = '2023-06-01';

const MODEL_API_URL =
  process.env.MODEL_API_URL ||
  process.env.ANTHROPIC_URL ||
  'https://api.anthropic.com/v1/messages';

function modelKey()    { return process.env.MODEL_API_KEY   || process.env.ANTHROPIC_API_KEY    || ''; }
function modelName()   { return process.env.MODEL_NAME      || process.env.ANTHROPIC_MODEL      || DEFAULT_MODEL; }
function relaySecret() { return process.env.MODEL_API_SECRET || process.env.ANTHROPIC_PROXY_SECRET || ''; }

// Cheap check so callers can render a "not configured" state without a
// billed request. Returns boolean only — never leaks which provider.
function isConfigured() { return !!modelKey(); }

// ── Core call ──────────────────────────────────────────────────────────
// Params (upstream-shaped, but the only place that matters):
//   system    string | { static, dynamic }  — `static` is prompt-cached
//   tools     array  — tool defs ({ name, description, input_schema })
//   messages  array  — conversation; content is a string or content blocks
//   max_tokens number
//
// Returns a NEUTRAL shape the rest of the app reads:
//   { content_blocks, truncated, usage, raw }
//
// PROMPT CACHING: the large stable `static` system text + the tool list are
// marked cache_control:ephemeral, so repeat calls within the cache window
// read those tokens at a fraction of cost and skip the per-minute input cap.
async function callModel({ system, tools, messages, max_tokens = 1500 }) {
  const key = modelKey();
  if (!key) {
    const err = new Error('model_not_configured');
    err.code = 'not_configured';
    throw err;
  }

  // System — cache the static chunk, leave the dynamic chunk uncached so a
  // changing per-request string doesn't bust the cache key.
  let systemPayload;
  if (typeof system === 'string') {
    systemPayload = system;
  } else if (system && typeof system === 'object') {
    const parts = [];
    if (system.static && system.static.trim()) {
      parts.push({ type: 'text', text: system.static, cache_control: { type: 'ephemeral' } });
    }
    if (system.dynamic && system.dynamic.trim()) {
      parts.push({ type: 'text', text: system.dynamic });
    }
    systemPayload = parts;
  }

  // Cache the whole tool list by marking the LAST tool.
  let toolsPayload = tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const last = tools.length - 1;
    toolsPayload = tools.map((t, i) => (i === last ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  }

  const secret = relaySecret();
  const r = await fetch(MODEL_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': UPSTREAM_API_VERSION,
      // Shared-secret header the self-hosted relay checks before forwarding.
      ...(secret ? { 'x-roots-proxy': secret } : {}),
    },
    body: JSON.stringify({
      model: modelName(),
      max_tokens,
      system: systemPayload,
      ...(toolsPayload ? { tools: toolsPayload } : {}),
      messages,
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    // White-label: the THROWN message is vendor-neutral and safe to log.
    // The raw upstream detail is attached as a private field for internal
    // diagnostics ONLY — callers must never forward it to a client.
    const err = new Error('model_request_failed');
    err.code = 'upstream_error';
    err.status = r.status;
    err._detail = String(detail).slice(0, 400);
    throw err;
  }

  const data = await r.json();
  return {
    content_blocks: data.content || [],
    truncated: data.stop_reason === 'max_tokens',
    usage: {
      input_tokens:                data.usage?.input_tokens                 || 0,
      output_tokens:               data.usage?.output_tokens                || 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens  || 0,
      cache_read_input_tokens:     data.usage?.cache_read_input_tokens      || 0,
    },
    raw: data,
  };
}

// ── Neutral helpers over the returned content_blocks ───────────────────
// Pull the input object of a forced tool call by name (or null).
function extractToolUse(content_blocks, toolName) {
  const b = (content_blocks || []).find(
    x => x && x.type === 'tool_use' && (!toolName || x.name === toolName)
  );
  return b ? (b.input || {}) : null;
}

// Join all text blocks into one string.
function extractText(content_blocks) {
  return (content_blocks || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text || '')
    .join('\n');
}

// Strip everything a client must never see from an internal result. Use
// before returning model output to a browser / mini-app.
function clientSafe(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { provider, usage, raw, _detail, ...safe } = obj;
  return safe;
}

module.exports = {
  callModel,
  isConfigured,
  extractToolUse,
  extractText,
  clientSafe,
  // exported for tests / diagnostics — never echo to a client
  _config: { modelName, isConfigured },
};
