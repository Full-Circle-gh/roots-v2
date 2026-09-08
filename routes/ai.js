// WHAT IS LEFT OF THIS FILE, AND WHAT IS NOT (§78).
//
// This was Sprout — a conversational agent with ~25 read-only database tools,
// its own memory and app-help stores, and an Anthropic⇄DeepSeek adapter. Ash
// scrapped it with the kitchen app, asked directly, including the "Ask Sprout"
// design check in the mini-app editor. The chat endpoint, the tool loop, the
// memory and app-help endpoints, `/api/ai/status` and `/api/ai/sales-analyze`
// all went with it — every one of them gated on requireAuth, the users realm,
// with public/app.html or public/cms.html as the only caller.
//
// ONE ROUTE SURVIVES and it is the reason the rest of this file does:
// `/api/retail-admin/ai/compose-blocks`, which writes product description
// blocks for the store product editor and retail-admin's products screen.
// Both are live Tacet surfaces on the backend-operator realm.
//
// So the PROVIDER ABSTRACTION below is not Sprout's leftovers — it is the
// composer's engine, and callLLM() has a real caller. It keeps its shape
// (swappable provider, Anthropic-flavoured internal format) because that shape
// was never Sprout-specific.
const express = require('express');
const { logActivity } = require('../middleware/auth');
// Shared lenient tool-argument recovery (relay can stringify / mis-escape a
// tool_use input or a nested field). This module is the canonical home; ai.js
// uses its own provider abstraction below but reuses these pure helpers.
const { parseToolInput, escapeStrayJsonQuotes } = require('../lib/model-gateway');
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────
// PROVIDER ABSTRACTION
// ─────────────────────────────────────────────────────────────────────
// Sprout's "brain" is swappable. Today: Anthropic (Claude) + DeepSeek.
// Tomorrow: Tongyi Qianwen, Moonshot Kimi, GPT, local Ollama — all
// behind the same callLLM() interface. AI_PROVIDER env var picks the
// active one; default = anthropic (the HK ECS can reach api.anthropic.com,
// and Claude's tool-use + vision quality is where we want Sprout to live).
// DeepSeek remains a one-env-var fallback for the mainland warm standby.
//
// Internal message format mirrors Anthropic's (content blocks: text /
// tool_use / tool_result) because it expresses tool calls naturally in
// a single ordered conversation. The DeepSeek adapter converts to/from
// OpenAI-compatible format at the provider boundary, so the agent loop
// in /api/ai/chat is provider-agnostic.

// ANTHROPIC_URL is overridable so the HK box can route through the Singapore
// nginx reverse proxy (api.anthropic.com is geo-blocked from HK/mainland).
// When proxying, ANTHROPIC_PROXY_SECRET must be set; the proxy enforces it
// via an X-Roots-Proxy header check before forwarding to Anthropic. Direct
// calls from a non-blocked region leave both env vars unset.
const ANTHROPIC_URL  = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const DEEPSEEK_URL   = 'https://api.deepseek.com/chat/completions';

function pickProvider() {
  const explicit = (process.env.AI_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'anthropic' || explicit === 'claude') return 'anthropic';
  if (explicit === 'deepseek')                            return 'deepseek';
  // No explicit choice — prefer Anthropic (better tool-use + vision,
  // reachable from the HK prod box), fall back to DeepSeek if only that
  // key is set (used by the mainland warm standby).
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.DEEPSEEK_API_KEY)  return 'deepseek';
  return 'anthropic';  // default that gives the clearest "not configured" message
}

function providerKey(p) {
  return p === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY
    : process.env.DEEPSEEK_API_KEY;
}

function providerModel(p) {
  if (p === 'anthropic') return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  // DeepSeek defaults to deepseek-chat (V3) — fast, cheap, fine for retrieval
  // questions. Override DEEPSEEK_MODEL=deepseek-reasoner for the chain-of-
  // thought R1 model when raw reasoning quality matters more than speed.
  if (p === 'deepseek')  return process.env.DEEPSEEK_MODEL  || 'deepseek-chat';
  return null;
}

// Unified LLM call. Parameters use Anthropic-flavored shape but adapters
// translate for non-Anthropic providers.
//
//   system    string        — system prompt
//   tools     array         — Anthropic-style tool defs ({name, description, input_schema})
//   messages  array         — conversation. Each msg: {role, content}
//                              content is either a string OR an array of blocks
//                              ({type:'text'|'tool_use'|'tool_result', ...})
//   max_tokens number       — output cap
//
// Returns { content_blocks: [...], usage: {input_tokens, output_tokens}, raw }
//   content_blocks is always Anthropic-shaped (text / tool_use blocks).
//   The agent loop only ever reads this unified shape.
async function callLLM({ system, tools, messages, max_tokens = 1500 }) {
  const provider = pickProvider();
  const key = providerKey(provider);
  if (!key) {
    const err = new Error(`No API key configured for provider "${provider}"`);
    err.code = 'no_key';
    err.provider = provider;
    throw err;
  }
  if (provider === 'anthropic') return _callAnthropic({ system, tools, messages, max_tokens, key });
  if (provider === 'deepseek')  return _callDeepSeek({ system, tools, messages, max_tokens, key });
  throw new Error('unknown provider: ' + provider);
}

// ── Anthropic adapter ──
// Native format. Pass-through with minimal massaging.
//
// PROMPT CACHING — to keep per-minute input-token usage off the rate limit,
// we mark the large stable chunks (the system prompt, tool definitions) with
// cache_control: ephemeral. After the first call writes the cache, every
// subsequent call within 5 minutes reads those tokens at 10% of base
// pricing and they DON'T count toward the 30k/min input-token rate cap.
// Dynamic per-request strings live in a SECOND non-cached system block so we
// don't bust the cache key when they change.
//
// This named Sprout's SPROUT_SYSTEM and its memory / page-context / language
// blocks until §78 deleted them. The mechanism is unchanged and still earns
// its place: the composer's system prompt is the stable half and the shop's
// own details are the dynamic one.
//
// `system` accepts either a plain string (legacy, no caching) or an object
// { static, dynamic } where static gets cached. Tools are always cached by
// putting cache_control on the LAST tool — caches the whole preceding list.
async function _callAnthropic({ system, tools, messages, max_tokens, key }) {
  const proxySecret = process.env.ANTHROPIC_PROXY_SECRET;

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

  let toolsPayload = tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const last = tools.length - 1;
    toolsPayload = tools.map((t, i) => i === last ? { ...t, cache_control: { type: 'ephemeral' } } : t);
  }

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...(proxySecret ? { 'x-roots-proxy': proxySecret } : {}),
    },
    body: JSON.stringify({
      model: providerModel('anthropic'),
      max_tokens,
      system: systemPayload,
      ...(toolsPayload ? { tools: toolsPayload } : {}),
      messages,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('Anthropic ' + r.status + ': ' + t.slice(0, 400));
    err.status = r.status;
    err.provider = 'anthropic';
    throw err;
  }
  const data = await r.json();
  return {
    content_blocks: data.content || [],
    // 'max_tokens' here means the model's reply was cut off mid-output.
    truncated: data.stop_reason === 'max_tokens',
    usage: {
      input_tokens:               data.usage?.input_tokens                || 0,
      output_tokens:              data.usage?.output_tokens               || 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens:    data.usage?.cache_read_input_tokens     || 0,
    },
    raw: data,
  };
}

// ── DeepSeek adapter ──
// DeepSeek implements the OpenAI Chat Completions schema. Convert
// Anthropic-shaped tools/messages → OpenAI shape, call the API, then
// convert the response back to Anthropic content blocks.
//
// Conversions:
//   • Tools:  {name, description, input_schema}
//             → {type:'function', function:{name, description, parameters}}
//   • Messages:
//       Anthropic tool_use block (assistant)
//         → OpenAI assistant.tool_calls array
//       Anthropic tool_result block (user)
//         → separate OpenAI {role:'tool', tool_call_id, content} message
//   • Response:
//       OpenAI assistant.tool_calls
//         → Anthropic-style tool_use content blocks
//       OpenAI assistant.content (string)
//         → Anthropic-style text content block
async function _callDeepSeek({ system, tools, messages, max_tokens, key }) {
  // 1) Tool defs.
  const oaiTools = (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));

  // 2) Messages — flatten Anthropic blocks to OpenAI messages.
  // System may arrive as { static, dynamic } from the caching path. DeepSeek
  // doesn't accept the structured form, so concatenate back into one string.
  let systemStr = system;
  if (system && typeof system === 'object' && !Array.isArray(system)) {
    systemStr = (system.static || '') + (system.dynamic ? '\n\n' + system.dynamic : '');
  }
  const oaiMessages = [];
  if (systemStr) oaiMessages.push({ role: 'system', content: systemStr });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      oaiMessages.push({ role: m.role, content: m.content });
      continue;
    }
    // Block content. For an assistant turn that contains tool_use blocks,
    // OpenAI expects ONE assistant message with content + tool_calls.
    // For a user turn with tool_result blocks, OpenAI wants SEPARATE
    // 'tool' role messages each carrying one result.
    if (m.role === 'assistant') {
      const text = (m.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
      const toolCalls = (m.content || [])
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      oaiMessages.push(msg);
    } else {
      // User turn with tool_result blocks → emit a 'tool' message per result.
      const blocks = m.content || [];
      const textBlocks  = blocks.filter(b => b.type === 'text');
      const toolResults = blocks.filter(b => b.type === 'tool_result');
      if (textBlocks.length) {
        oaiMessages.push({ role: 'user', content: textBlocks.map(b => b.text || '').join('\n') });
      }
      for (const tr of toolResults) {
        const c = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
        oaiMessages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: c });
      }
    }
  }

  // 3) Call the API.
  const body = {
    model: providerModel('deepseek'),
    max_tokens,
    messages: oaiMessages,
    ...(oaiTools.length ? { tools: oaiTools, tool_choice: 'auto' } : {}),
  };
  const r = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + key,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('DeepSeek ' + r.status + ': ' + t.slice(0, 400));
    err.status = r.status;
    err.provider = 'deepseek';
    throw err;
  }
  const data = await r.json();
  const choice = data.choices?.[0];
  const msg = choice?.message || {};

  // 4) Convert response → Anthropic content blocks.
  const blocks = [];
  if (msg.content && msg.content.trim()) {
    blocks.push({ type: 'text', text: msg.content });
  }
  for (const tc of (msg.tool_calls || [])) {
    let parsedInput = {};
    try { parsedInput = JSON.parse(tc.function?.arguments || '{}'); }
    catch { parsedInput = { _parse_error: tc.function?.arguments || '' }; }
    blocks.push({
      type: 'tool_use',
      id:   tc.id,
      name: tc.function?.name || '',
      input: parsedInput,
    });
  }

  return {
    content_blocks: blocks,
    // OpenAI-shape APIs report a cut-off reply as finish_reason 'length'.
    truncated: choice?.finish_reason === 'length',
    usage: {
      input_tokens:  data.usage?.prompt_tokens     || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
    raw: data,
  };
}

// TWO KITCHEN-REALM ENDPOINTS STOOD HERE AND ARE GONE (§78):
// `/api/ai/status`, which told app.html whether a key was configured so it
// could render a setup-needed view, and `/api/ai/sales-analyze`, which read
// six months of sales and waste for that app's analysis panel. Both were
// gated on requireAuth — the users realm — and public/app.html was the only
// caller of either. The provider abstraction above outlives them because the
// product-block composer below is a real caller of callLLM().

// ─────────────────────────────────────────────────────────────────────
// SMART PASTE → BLOCKS  (POST /api/ai/compose-blocks)
// ─────────────────────────────────────────────────────────────────────
// The product editor (/product-editor) lets the operator paste a wall of
// raw product copy and have Claude auto-divide it into the editor's typed,
// bilingual "description blocks". The model returns a block list via a
// forced tool call; we sanitise it against the known block types here
// before handing it back. The editor trusts the response shape, so the
// validation lives on this side of the wire, not in the browser.
//
// COMPOSE_SCHEMA mirrors PA_BLOCK_TYPES in public/product-editor.html —
// keep the two in sync when block types or their fields change.
const COMPOSE_SCHEMA = {
  spec_strip:        { arrays: { cells: ['k_en', 'k_cn', 'v_en', 'v_cn'] } },
  hero_intro:        { scalars: ['kicker_en', 'kicker_cn', 'body_en', 'body_cn', 'highlight_en', 'highlight_cn'] },
  why:               { arrays: { rows: ['claim_en', 'claim_cn'] } },
  ingredients_chips: { arrays: { items: ['name_en', 'name_cn', 'pct', 'lead'] } },
  ingredients_line:  { arrays: { items: ['name_en', 'name_cn', 'pct', 'lead'] } },
  allergen_card:     { scalars: ['contains_en', 'contains_cn', 'may_contain_en', 'may_contain_cn'] },
  how_to_use:        { arrays: { tiles: ['icon', 'label_en', 'label_cn', 'sub_en', 'sub_cn'] } },
  storage_box:       { scalars: ['note_en', 'note_cn'], objects: {
                         left:  ['icon', 'head_en', 'head_cn', 'num', 'unit_en', 'unit_cn', 'alt'],
                         right: ['icon', 'head_en', 'head_cn', 'num', 'unit_en', 'unit_cn', 'alt'] } },
  notes_callout:     { scalars: ['text_en', 'text_cn'] },
  big_stat:          { scalars: ['stat', 'what_en', 'what_cn', 'claim_en', 'claim_cn', 'bg'] },
  pull_quote:        { scalars: ['text_en', 'text_cn', 'who_en', 'who_cn'] },
  nutrition_facts:   { scalars: ['basis_en', 'basis_cn'], arrays: { rows: ['label_en', 'label_cn', 'value'] } },
};

// Coerce a model-emitted block down to ONLY the fields its type allows.
// Unknown types → dropped; unknown fields → ignored; everything stringified
// (except the known booleans) so the editor never sees a surprise shape.
function sanitizeComposedBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  const spec = COMPOSE_SCHEMA[type];
  if (!spec) return null;
  const str = v => (v == null ? '' : String(v));
  const out = { type };
  for (const k of (spec.scalars || [])) out[k] = str(raw[k]);
  for (const [arrKey, keys] of Object.entries(spec.arrays || {})) {
    const src = Array.isArray(raw[arrKey]) ? raw[arrKey] : [];
    out[arrKey] = src.map(item => {
      const o = {};
      for (const k of keys) o[k] = (k === 'lead') ? !!(item && item[k]) : str(item && item[k]);
      return o;
    });
  }
  for (const [objKey, keys] of Object.entries(spec.objects || {})) {
    const src = (raw[objKey] && typeof raw[objKey] === 'object') ? raw[objKey] : {};
    const o = {};
    for (const k of keys) o[k] = (k === 'alt') ? !!src[k] : str(src[k]);
    out[objKey] = o;
  }
  return out;
}

// Did the model actually put text in this block, or just emit an empty husk?
function composedBlockHasContent(b) {
  const spec = COMPOSE_SCHEMA[b.type];
  if (!spec) return false;
  const has = v => typeof v === 'string' && v.trim() !== '';
  for (const k of (spec.scalars || [])) if (has(b[k])) return true;
  for (const [arrKey, keys] of Object.entries(spec.arrays || {}))
    for (const it of (b[arrKey] || [])) for (const k of keys) if (has(it[k])) return true;
  for (const [objKey, keys] of Object.entries(spec.objects || {}))
    for (const k of keys) if (has((b[objKey] || {})[k])) return true;
  return false;
}

// Does the block have any non-empty field for a specific language ('en'|'cn')?
// Used for diagnostics and for the stacked-output merge below.
function composedBlockLangFilled(b, suffix) {
  const spec = COMPOSE_SCHEMA[b.type];
  if (!spec) return false;
  const has = v => typeof v === 'string' && v.trim() !== '';
  const ends = k => k.endsWith('_' + suffix);
  for (const k of (spec.scalars || [])) if (ends(k) && has(b[k])) return true;
  for (const [arrKey, keys] of Object.entries(spec.arrays || {}))
    for (const it of (b[arrKey] || [])) for (const k of keys) if (ends(k) && has(it[k])) return true;
  for (const [objKey, keys] of Object.entries(spec.objects || {}))
    for (const k of keys) if (ends(k) && has((b[objKey] || {})[k])) return true;
  return false;
}

// Combine one English-only block with the matching Chinese-only block of the
// same type into a single bilingual block: _en fields from `en`, _cn fields
// from `cn`, language-neutral fields (pct, num, value, icon, bg, stat…) from
// whichever has them. Arrays/objects are zipped element-by-element.
function mergeEnCnBlock(en, cn) {
  const spec = COMPOSE_SCHEMA[en.type] || {};
  const out = { type: en.type };
  const merge = (k, a, b) => k.endsWith('_cn') ? (b || a) : (a || b);
  for (const k of (spec.scalars || [])) out[k] = merge(k, en[k] || '', cn[k] || '');
  for (const [arrKey, keys] of Object.entries(spec.arrays || {})) {
    const ea = Array.isArray(en[arrKey]) ? en[arrKey] : [];
    const ca = Array.isArray(cn[arrKey]) ? cn[arrKey] : [];
    const n = Math.max(ea.length, ca.length);
    out[arrKey] = [];
    for (let i = 0; i < n; i++) {
      const e = ea[i] || {}, c = ca[i] || {}, o = {};
      for (const k of keys) o[k] = (k === 'lead') ? !!(e[k] || c[k]) : merge(k, e[k] || '', c[k] || '');
      out[arrKey].push(o);
    }
  }
  for (const [objKey, keys] of Object.entries(spec.objects || {})) {
    const e = en[objKey] || {}, c = cn[objKey] || {}, o = {};
    for (const k of keys) o[k] = (k === 'alt') ? !!(e[k] || c[k]) : merge(k, e[k] || '', c[k] || '');
    out[objKey] = o;
  }
  return out;
}

// The model often ignores "pair into one bilingual block" and instead emits
// every English block followed by a parallel run of Chinese blocks. Detect
// that clean stacked shape and zip the two halves back together. Conservative:
// only merges when every block is single-language and the EN-only and CN-only
// blocks form two equal, same-typed sequences — otherwise returns input as-is.
function mergeStackedBilingual(blocks) {
  if (blocks.length < 2) return blocks;
  const tag = b => {
    const en = composedBlockLangFilled(b, 'en'), cn = composedBlockLangFilled(b, 'cn');
    return en && cn ? 'both' : en ? 'en' : cn ? 'cn' : 'empty';
  };
  const tags = blocks.map(tag);
  if (tags.some(t => t === 'both' || t === 'empty')) return blocks;  // already paired / odd
  const enOnly = blocks.filter((_, i) => tags[i] === 'en');
  const cnOnly = blocks.filter((_, i) => tags[i] === 'cn');
  if (!enOnly.length || enOnly.length !== cnOnly.length) return blocks;
  if (enOnly.some((b, i) => b.type !== cnOnly[i].type)) return blocks;  // sequences don't line up
  return enOnly.map((en, i) => mergeEnCnBlock(en, cnOnly[i]));
}

// The emit_blocks `blocks` argument can arrive as a PRE-SERIALIZED JSON string
// (relay behavior) whose inner JSON sometimes has UNESCAPED double-quotes in a
// text value (e.g. a Chinese line like 这是给"…"准备的). JSON.parse then throws
// and the WHOLE design drops to zero blocks ("Couldn't build the design").
// Recover it via the shared escapeStrayJsonQuotes; always returns an array, so
// worst case is the same empty result as before.
function parseBlocksArg(blocks) {
  if (Array.isArray(blocks)) return blocks;
  if (typeof blocks !== 'string') return [];
  const tryParse = str => {
    try {
      const v = JSON.parse(str);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.blocks)) return v.blocks;
      return null;
    } catch (e) { return null; }
  };
  return tryParse(blocks) || tryParse(escapeStrayJsonQuotes(blocks)) || [];
}

const COMPOSE_TOOL = {
  name: 'emit_blocks',
  description: 'Return the product copy organised into ordered Roots description blocks.',
  input_schema: {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        description: 'Blocks in top-to-bottom display order. Each must have a "type" from the allowed list plus that type\'s fields.',
        items: {
          type: 'object',
          properties: { type: { type: 'string', enum: Object.keys(COMPOSE_SCHEMA) } },
          required: ['type'],
          additionalProperties: true,
        },
      },
    },
    required: ['blocks'],
  },
};

/* THE SHOP THIS IS WRITING FOR — and it is not always the same one.
   composeBlocksHandler below is mounted on TWO realms: /api/ai/compose-blocks
   (requireAuth — the kitchen app, which is Roots' own) and
   /api/retail-admin/ai/compose-blocks (requireRetailAdmin), which ANY merchant
   on the platform reaches from their product editor.

   Until now the prompt opened "You are the layout assistant for **Roots**, a
   small bilingual plant-based food brand in Guangzhou" and, four hundred words
   later, forbade the model from using an animal-product emoji because "the
   shop is fully vegan". Both were stated as fact. So a merchant selling
   anything else had their copy organised by an assistant that believed it
   worked for a Guangzhou plant-based brand — and a butcher could not be given
   a 🥩 for a product that is one.

   Two variants. THE ROOTS ONE IS BYTE-IDENTICAL to the string that shipped
   before this, which scripts/test_compose_prompt.js asserts character for
   character — a prompt is the one kind of code where a diff tells you almost
   nothing about the behaviour, so the guarantee has to be mechanical.

   Still cached, both of them: callLLM keys the cacheable half on its own text,
   so a second variant is a second cache rather than no cache. */
function composeSystem(shop) {
  const name = (shop && shop.name) ? shop.name : '';
  const who = name
    ? `You are the layout assistant for **${name}**`
    : 'You are the layout assistant for a small shop';
  const brand = (shop && shop.vegan)
    ? `${who}, a small bilingual (English + 中文) plant-based food brand in Guangzhou.`
    /* No category and no city for anybody else: the platform does not know
       either one, and a guess here becomes a claim in the copy. */
    : `${who}. It sells bilingually where the operator gives both languages.`;
  return brand + ` The operator pastes raw product copy — a label, a supplier blurb, scattered notes — and your job is to divide it into the product page's structured "blocks", choosing the right block type for each piece of content.

Return your answer ONLY by calling the \`emit_blocks\` tool. Do not write prose.

VOICE: warm, plain-spoken, editorial. Never marketing-fluff. Keep the operator's own wording where it's already good; tighten where it rambles.

BLOCK TYPES (pick the ones that fit — skip the rest, never force-fill):
- **spec_strip** — three quick meta facts (type, net weight, origin, shelf life). Fields: cells[] of { k_en, k_cn, v_en, v_cn } (k = label like "Net Wt", v = value). Use ~3 cells. NOT for nutrient values (energy/fat/carbohydrate/protein/sugar/sodium) — those go in nutrition_facts.
- **hero_intro** — the opening editorial paragraph. Fields: kicker_en/cn (tiny eyebrow line, optional), body_en/cn (the paragraph), highlight_en/cn (one pull-out phrase, optional).
- **why** — why people choose it, as short numbered claims. Fields: rows[] of { claim_en, claim_cn }. 3–5 rows.
- **ingredients_chips** — ingredient list as pills. Fields: items[] of { name_en, name_cn, pct (string % or ""), lead (boolean: true for a hero ingredient) }.
- **ingredients_line** — same data as a typographic run instead of pills. Only use ONE of chips/line, not both.
- **allergen_card** — Fields: contains_en/cn, may_contain_en/cn (comma-separated allergens).
- **how_to_use** — usage ideas as a grid. Fields: tiles[] of { icon (one emoji), label_en/cn, sub_en/cn (optional). 6 tiles ideal. ${(shop && shop.vegan) ? 'PLANT-BASED ONLY: the shop is fully vegan — never use an animal-product emoji (no 🥚🍳🧀🧈🥓🍖🍗🥩🐟🦐🍯 etc.); use plant/cookware glyphs (🥘🍲🥣🔥♨🌱🥗).' : 'Pick the emoji that matches what the product actually IS — never one for an ingredient the copy does not mention.'} For a microwave tile use ♨ (Unicode has no microwave emoji — never 📡).
- **storage_box** — storage conditions. Fields: left & right each { icon, head_en/cn, num (e.g. "0–4°"), unit_en/cn, alt (boolean) }; plus note_en/cn.
- **notes_callout** — fine-print note. Fields: text_en/cn.
- **big_stat** — one big number. Fields: stat (the number/figure), what_en/cn (what it measures), claim_en/cn (short line), bg ("lime").
- **pull_quote** — sourcing / provenance line. Fields: text_en/cn, who_en/cn (attribution, optional).
- **nutrition_facts** — nutrition information, whether laid out as a grid/table OR as a simple labelled list (e.g. a "Nutrition" / "营养信息" heading followed by lines like "Energy 98kcal", "Fat 9g", "Carbohydrate 3g", "Protein 3.4g"). Fields: basis_en/cn (the per-serving/per-100g basis, e.g. "Per 100g" / "Per 16g serving"), rows[] of { label_en, label_cn, value } — one row per nutrient (label = "Energy"/"能量", value = "98kcal"). These nutrient lines belong HERE, never in spec_strip.

RULES:
- COVER EVERYTHING. Walk the source top to bottom and map EVERY distinct section or heading to its best-fit block. Each meaningful chunk of copy must land in some block — never silently drop a section. A product with Description / Why / Ingredients / Allergens / How to use / Storage / Nutrition / Notes should produce a block for EACH of those, in that reading order. Under-covering a rich paste (emitting only the easy tabular blocks and skipping the prose) is the #1 failure — do not do it.
- Match by meaning, not exact wording. Typical headings → block types: an intro/overview paragraph → hero_intro; "why people choose it" / benefits → why; an ingredient list → ingredients_chips (or ingredients_line); "contains / may contain" → allergen_card; "how to use" / serving ideas → how_to_use; storage / shelf life → storage_box; "nutrition" / "nutrition facts" / "营养" / "营养信息" — including a plain list of nutrient lines like Energy/Fat/Carbohydrate/Protein — → nutrition_facts (NOT spec_strip); closing fine-print / "intended use" / disclaimers → notes_callout; meta facts (type, net weight, origin) → spec_strip.
- Order blocks the way they should read on the page (intro first, fine-print/notes last).
- Don't duplicate content across blocks. Each fact lives in one block.
- Don't fabricate: only emit a block type when the source genuinely has that content, and never pad a block with invented fields. This is NOT licence to skip sections that ARE present — when in doubt, include a block for a section you can see rather than omit it.
- pct is a string ("12%" or "") and lead/alt are booleans.`;
}

// Build the language directive from which source texts are present + whether
// the operator opted into drafting the empty side. Both texts present is the
// primary path: pair the SAME content across the two languages into one block.
function composeLangDirective(hasEn, hasCn, translate) {
  if (hasEn && hasCn) {
    return `

LANGUAGES — THIS IS THE MOST IMPORTANT RULE: You have the FULL English copy AND the FULL Chinese (中文) copy of the SAME product. They are translations of each other and cover the same facts. EVERY block you emit MUST be fully bilingual:
- For every _en field you fill, you MUST ALSO fill its matching _cn field (and vice-versa). A block with English but blank Chinese is WRONG.
- Get the Chinese from the Chinese copy — find the phrase that matches the English and put it in the _cn field. Use the operator's own Chinese wording; only translate yourself if that exact detail is genuinely absent from the Chinese copy.
- Pair the same piece of content into ONE bilingual block. NEVER emit a separate Chinese-only block next to an English one.
- Examples: spec_strip cell → fill k_en AND k_cn, v_en AND v_cn. why row → claim_en AND claim_cn. hero_intro → body_en AND body_cn. ingredients item → name_en AND name_cn.
Before calling emit_blocks, re-read your blocks and confirm NO _cn field is empty where its _en counterpart has text. If any is empty, fill it from the Chinese copy first.
- When a block has a LIST (spec_strip cells, ingredients items, why rows, how_to_use tiles), keep the items in the SAME order regardless of language — item 1 is the same fact in both _en and _cn.`;
  }
  if (hasEn) {
    return translate
      ? `

LANGUAGES: Only English copy is provided. Fill the _en fields from it, then WRITE the matching _cn fields yourself — as ORIGINAL Chinese brand copy, the way a native 中文 copywriter for Roots would write it from scratch.
- Carry the SAME facts, but in the brand VOICE above: warm, plain-spoken, editorial — never marketing fluff.
- Use natural, idiomatic 中文. Adapt phrasing, sentence rhythm, idioms and units the way a Chinese reader expects — NOT a literal word-for-word gloss of the English.
- A Chinese reader must not be able to tell this was drafted from English. If a sentence reads like translationese, rewrite it the way a person would actually say it in Chinese.`
      : `

LANGUAGES: Only English copy is provided. Fill the _en fields and leave every _cn field as an empty string (""). Do not invent Chinese — the operator will write it.`;
  }
  // Chinese only
  return translate
    ? `

LANGUAGES: Only Chinese copy is provided. Fill the _cn fields from it, then WRITE the matching _en fields yourself — as ORIGINAL English brand copy in the brand VOICE above (warm, plain-spoken, editorial), idiomatic and natural, NOT a literal word-for-word gloss of the Chinese. Carry the same facts.`
    : `

LANGUAGES: Only Chinese copy is provided. Fill the _cn fields and leave every _en field as an empty string (""). Do not invent English — the operator will write it.`;
}

const composeBlocksHandler = async (req, res) => {
  const _provider = pickProvider();
  if (!providerKey(_provider)) {
    return res.status(503).json({
      error: 'AI not configured · AI 未配置',
      detail: `Set ${_provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'DEEPSEEK_API_KEY'} in /root/roots-v2/.env then restart pm2.`,
    });
  }

  /* WHICH SHOP this paste belongs to. requireRetailAdmin puts the tenant row on
     the request; the kitchen realm (requireAuth) has none, and the kitchen IS
     account #1. So an absent tenant and account #1 are the same answer, which
     is the account this prompt was written for and whose wording it keeps
     exactly — the same reasoning the currency and timezone fallbacks use, where
     the default is account #1's value rather than the platform's. */
  const _t = req.tenant;
  const shop = (!_t || Number(_t.id) === 1)
    ? { name: 'Roots', vegan: true }
    : { name: String(_t.brand_name || _t.name || '').trim(), vegan: false };

  const textEn    = (req.body && req.body.text_en ? String(req.body.text_en) : '').trim();
  const textCn    = (req.body && req.body.text_cn ? String(req.body.text_cn) : '').trim();
  // Back-compat: an older client may still send a single `text` field.
  const textLegacy = (req.body && req.body.text ? String(req.body.text) : '').trim();
  const translate = !!(req.body && req.body.translate);
  const product   = (req.body && req.body.product && typeof req.body.product === 'object') ? req.body.product : {};
  const hasEn = !!(textEn || textLegacy);
  const hasCn = !!textCn;
  if (!hasEn && !hasCn) return res.status(400).json({ error: 'No text provided · 未提供文字' });

  try {
    const ctxBits = [product.name_en, product.name_cn, product.category].filter(Boolean).join(' · ');
    const parts = [];
    if (ctxBits) parts.push(`Product: ${ctxBits}`);
    if (textEn || textLegacy) parts.push('English copy:\n' + (textEn || textLegacy).slice(0, 9000));
    if (textCn)               parts.push('Chinese copy · 中文文案:\n' + textCn.slice(0, 9000));
    // Structured facts from the store backend's "Product details" boxes — fed in
    // as the source of truth so the spec_strip / nutrition come from the boxes,
    // not guessed from prose. Absent for kitchen-app callers (no such boxes).
    const _facts = (product.facts && typeof product.facts === 'object') ? product.facts : {};
    const _factLines = [];
    if (product.weight) _factLines.push('Net weight · 净含量: ' + String(product.weight).slice(0, 60));
    for (const [k, label] of [['origin', 'Origin · 产地'], ['ingredients', 'Ingredients · 配料'], ['storage', 'Storage · 储存方式'], ['shelf_life', 'Shelf life · 保质期'], ['serving', 'Serving suggestion · 食用建议']]) {
      const en = _facts[k + '_en'], cn = _facts[k + '_cn'];
      if (en || cn) _factLines.push(label + ': ' + [en, cn].filter(Boolean).join(' / ').slice(0, 600));
    }
    if (_factLines.length) parts.push('Structured product facts — use these as the source of truth. Build a spec_strip from net weight / origin / shelf life, and include ingredients, storage and serving as the appropriate blocks. Do not invent beyond them:\n' + _factLines.join('\n'));
    const userMsg = parts.join('\n\n') + '\n\nCall emit_blocks now with the organised blocks.';

    // One compose pass: call the model, pull the emit_blocks payload (robust to
    // the tool input arriving as either a parsed object OR a JSON string — some
    // relay paths hand it back un-parsed), sanitise + pair the blocks. Returns
    // the parsed shape so the orchestration below can retry on an empty result.
    // Long bilingual products (full EN + CN copy) easily exceed a few thousand
    // output tokens once expanded into paired blocks; 12k keeps the emit_blocks
    // tool call from truncating mid-JSON.
    const composeOnce = async (directive, userText, maxTok = 12000) => {
      const result = await callLLM({
        max_tokens: maxTok,
        system: { static: composeSystem(shop), dynamic: directive },
        tools: [COMPOSE_TOOL],
        messages: [{ role: 'user', content: userText }],
      });
      let rawBlocks = [];
      const toolUse = (result.content_blocks || []).find(b => b.type === 'tool_use' && b.name === 'emit_blocks');
      // The input may be a native object OR a (sometimes mis-escaped) JSON
      // string from a relay; parseToolInput normalizes that. `input.blocks` may
      // ITSELF be a stringified array — parseBlocksArg handles that second
      // layer and recovers stray quotes rather than dropping the design to zero.
      const input = parseToolInput(toolUse && toolUse.input);
      rawBlocks = parseBlocksArg(input.blocks);
      if (!rawBlocks.length) {
        // Fallback: a provider returned JSON as text instead of a tool call.
        const txt = (result.content_blocks || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { try { const o = JSON.parse(m[0]); if (Array.isArray(o.blocks)) rawBlocks = o.blocks; } catch (e) {} }
      }
      let blocks = rawBlocks.map(sanitizeComposedBlock).filter(b => b && composedBlockHasContent(b));
      // Repair the common "all-English blocks, then all-Chinese blocks" output
      // into properly paired bilingual blocks.
      if (hasEn && hasCn) blocks = mergeStackedBilingual(blocks);
      return { result, rawBlocks, blocks, hadToolUse: !!toolUse };
    };

    const baseDirective = composeLangDirective(hasEn, hasCn, translate);
    let a = await composeOnce(baseDirective, userMsg);

    // The model occasionally calls emit_blocks with an EMPTY list for a rich
    // paste (no truncation, just a bad pass). Self-correct: retry once telling
    // it that returning nothing was wrong.
    if (!a.result.truncated && !a.blocks.length) {
      const nudge = userMsg + '\n\nIMPORTANT: a previous attempt returned ZERO blocks, which is wrong — the copy above clearly contains several distinct sections (intro, why, ingredients, allergens, how to use, storage, nutrition, notes…). Emit one block per section now. Do NOT return an empty list.';
      a = await composeOnce(baseDirective, nudge);
    }
    // Last resort for bilingual input: the dual-language "every block must be
    // fully bilingual" pass is the most demanding and the most likely to come
    // back empty. Drop to a single-language pass (English primary) and let the
    // model draft the matching Chinese itself.
    if (!a.result.truncated && !a.blocks.length && hasEn && hasCn) {
      const soloMsg = parts.filter(p => !p.startsWith('Chinese copy')).join('\n\n') + '\n\nCall emit_blocks now with the organised blocks.';
      a = await composeOnce(composeLangDirective(true, false, true), soloMsg);
    }

    const { result, rawBlocks, blocks, hadToolUse } = a;

    // The reply was cut off mid-output — the tool call is partial, so any blocks
    // we did parse are unreliable. Surface this as its own error instead of the
    // misleading "no sections built", which reads as "the model emitted nothing"
    // and isn't retryable in the operator's mind.
    if (result.truncated) {
      console.warn('[compose-blocks] truncated reply (max_tokens hit)', {
        product: product.id || null, raw_count: rawBlocks.length, kept: blocks.length, usage: result.usage,
      });
      logActivity(req.user.id, req.user.username, 'ai_compose_blocks', 'product', product.id || null,
        { count: blocks.length, truncated: true, translate, tokens: result.usage, provider: _provider }, req.ip);
      return res.status(502).json({
        error: 'The description was too long to build in one pass — shorten it a little, or design the page in the Product Page Editor · 描述过长,无法一次生成,请精简后重试或在商品页编辑器中设计',
      });
    }
    if (!blocks.length) {
      console.warn('[compose-blocks] no usable blocks parsed', {
        product: product.id || null, raw_count: rawBlocks.length,
        had_tool_use: hadToolUse,
        stop_reason: result.raw && result.raw.stop_reason,
        output_tokens: result.usage && result.usage.output_tokens,
        text_preview: (result.content_blocks || []).filter(b => b.type === 'text').map(b => (b.text || '').slice(0, 200)).join(' | ').slice(0, 400),
      });
    }
    logActivity(req.user.id, req.user.username, 'ai_compose_blocks', 'product', product.id || null,
      { count: blocks.length, translate, tokens: result.usage, provider: _provider }, req.ip);
    res.json({ success: true, blocks, usage: result.usage, provider: _provider });
  } catch (e) {
    if (e.code === 'no_key') return res.status(503).json({ error: e.message });
    if (e.status)            return res.status(502).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
};
// The kitchen-realm twin of this route is GONE (§78). It was
// `/api/ai/compose-blocks`, gated on requireAuth + the `retail` permission,
// and public/app.html was its only caller. The live editors — the store
// product editor and retail-admin's products screen — have always called
// the backend-realm route below, so nothing that still exists lost a door.
// Mini App Backend realm — operators carry req.backendUser (req.session.backendUserId),
// NOT req.session.userId, so the kitchen-authed route above 401s "Not authenticated"
// for them. requireRetailAdmin accepts both realms and shims req.user from the tenant
// operator, so the shared handler's logActivity(req.user.id, …) still works. Lets the
// store product editor's "🎨 Design" auto-compose run for backend operators.
const { requireRetailAdmin } = require('./retail');
router.post('/api/retail-admin/ai/compose-blocks', requireRetailAdmin, express.json(), composeBlocksHandler);

module.exports = router;
