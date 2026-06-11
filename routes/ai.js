const express = require('express');
const db = require('../database');
const { requireAuth, requireAdmin, requirePermission, logActivity } = require('../middleware/auth');
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
// we mark the large stable chunks (SPROUT_SYSTEM, tool definitions) with
// cache_control: ephemeral. After the first call writes the cache, every
// subsequent call within 5 minutes reads those tokens at 10% of base
// pricing and they DON'T count toward the 30k/min input-token rate cap.
// Dynamic per-request strings (memory, page context, language directive,
// date) live in a SECOND non-cached system block so we don't bust the
// cache key when they change.
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

// GET /api/ai/status — cheap, returns whether the key is set so the frontend
// can render a friendly setup-needed view without making a billed call.
router.get('/api/ai/status', requireAuth, (req, res) => {
  const provider   = pickProvider();
  const configured = !!providerKey(provider);
  res.json({ success: true, configured, provider, model: providerModel(provider) });
});

// POST /api/ai/sales-analyze — pulls last 6 months of sales + waste data,
// summarises numerically, sends to Claude with a focused prompt, returns the
// response. The LLM never sees raw user data — only aggregate numbers.
router.post('/api/ai/sales-analyze', requireAuth, requirePermission('sales'), async (req, res) => {
  const _provider = pickProvider();
  if (!providerKey(_provider)) {
    return res.status(503).json({
      error: 'AI not configured · AI 未配置',
      detail: `Set ${_provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'DEEPSEEK_API_KEY'} in /root/roots-v2/.env then restart pm2.`,
    });
  }

  try {
    // Build a compact, anonymised payload for the model.
    const monthly = db.prepare(`
      SELECT substr(date,1,7) AS month, channel,
             SUM(total) AS revenue, SUM(qty) AS units, COUNT(*) AS tx
      FROM sales_entries
      WHERE date >= date('now','-180 days')
      GROUP BY month, channel
      ORDER BY month, channel
    `).all();
    const topProducts = db.prepare(`
      SELECT product_name, SUM(total) AS revenue, SUM(qty) AS units
      FROM sales_entries
      WHERE date >= date('now','-180 days')
      GROUP BY product_name
      ORDER BY revenue DESC
      LIMIT 15
    `).all();
    const wasteMonthly = db.prepare(`
      SELECT substr(date,1,7) AS month, SUM(cost_lost) AS cost_lost, SUM(qty) AS qty
      FROM waste_entries
      WHERE date >= date('now','-180 days')
      GROUP BY month
      ORDER BY month
    `).all();

    if (!monthly.length && !topProducts.length) {
      return res.json({ success: true, analysis: '_No sales data in the last 6 months — log some sales first, then come back here for an analysis._', stats: { monthly, topProducts, wasteMonthly } });
    }

    const prompt = `You are a kitchen-and-restaurant operations analyst for "Roots", a small bilingual (English/Chinese) plant-based business in Guangzhou.

You're given the last six months of aggregate sales and waste data. Produce a focused, actionable readout in **markdown** — short paragraphs and crisp bullets, no fluff. Cover, in this order:

1. **Headline** — one sentence summarising overall trajectory (growth / steady / decline) with the % MoM if obvious.
2. **Channel mix** — which channels are growing or fading and what to do about it.
3. **Top performers vs underperformers** — the products driving revenue and the ones to consider deprioritising.
4. **Waste signal** — is waste cost rising relative to revenue? Anything to flag?
5. **Three concrete recommendations** for next month — each one specific and measurable.

Use bilingual notes (English primary, brief 中文 in parentheses) where it helps. Keep it under ~350 words total.

DATA:
\`\`\`json
${JSON.stringify({ monthly, topProducts, wasteMonthly }, null, 2)}
\`\`\``;

    const result = await callLLM({
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const analysis = (result.content_blocks || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    logActivity(req.user.id, req.user.username, 'ai_analyze', 'sales', null, { tokens: result.usage, provider: _provider }, req.ip);
    res.json({ success: true, analysis, stats: { monthly, topProducts, wasteMonthly }, usage: result.usage, provider: _provider });
  } catch (e) {
    if (e.code === 'no_key') return res.status(503).json({ error: e.message });
    if (e.status)            return res.status(502).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

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

const COMPOSE_SYSTEM = `You are the layout assistant for **Roots**, a small bilingual (English + 中文) plant-based food brand in Guangzhou. The operator pastes raw product copy — a label, a supplier blurb, scattered notes — and your job is to divide it into the product page's structured "blocks", choosing the right block type for each piece of content.

Return your answer ONLY by calling the \`emit_blocks\` tool. Do not write prose.

VOICE: warm, plain-spoken, editorial. Never marketing-fluff. Keep the operator's own wording where it's already good; tighten where it rambles.

BLOCK TYPES (pick the ones that fit — skip the rest, never force-fill):
- **spec_strip** — three quick meta facts (type, net weight, origin, shelf life). Fields: cells[] of { k_en, k_cn, v_en, v_cn } (k = label like "Net Wt", v = value). Use ~3 cells. NOT for nutrient values (energy/fat/carbohydrate/protein/sugar/sodium) — those go in nutrition_facts.
- **hero_intro** — the opening editorial paragraph. Fields: kicker_en/cn (tiny eyebrow line, optional), body_en/cn (the paragraph), highlight_en/cn (one pull-out phrase, optional).
- **why** — why people choose it, as short numbered claims. Fields: rows[] of { claim_en, claim_cn }. 3–5 rows.
- **ingredients_chips** — ingredient list as pills. Fields: items[] of { name_en, name_cn, pct (string % or ""), lead (boolean: true for a hero ingredient) }.
- **ingredients_line** — same data as a typographic run instead of pills. Only use ONE of chips/line, not both.
- **allergen_card** — Fields: contains_en/cn, may_contain_en/cn (comma-separated allergens).
- **how_to_use** — usage ideas as a grid. Fields: tiles[] of { icon (one emoji), label_en/cn, sub_en/cn (optional). 6 tiles ideal. PLANT-BASED ONLY: the shop is fully vegan — never use an animal-product emoji (no 🥚🍳🧀🧈🥓🍖🍗🥩🐟🦐🍯 etc.); use plant/cookware glyphs (🥘🍲🥣🔥♨🌱🥗). For a microwave tile use ♨ (Unicode has no microwave emoji — never 📡).
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

    const result = await callLLM({
      // Long bilingual products (full EN + CN copy) easily exceed a few
      // thousand output tokens once expanded into paired blocks. Too low a cap
      // truncates the emit_blocks tool call mid-JSON, leaving nothing parseable.
      max_tokens: 8000,
      system: { static: COMPOSE_SYSTEM, dynamic: composeLangDirective(hasEn, hasCn, translate) },
      tools: [COMPOSE_TOOL],
      messages: [{ role: 'user', content: userMsg }],
    });

    let rawBlocks = [];
    const toolUse = (result.content_blocks || []).find(b => b.type === 'tool_use' && b.name === 'emit_blocks');
    if (toolUse && Array.isArray(toolUse.input && toolUse.input.blocks)) {
      rawBlocks = toolUse.input.blocks;
    } else {
      // Fallback: a provider returned JSON as text instead of a tool call.
      const txt = (result.content_blocks || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { try { const o = JSON.parse(m[0]); if (Array.isArray(o.blocks)) rawBlocks = o.blocks; } catch (e) {} }
    }

    let blocks = rawBlocks.map(sanitizeComposedBlock).filter(b => b && composedBlockHasContent(b));
    // Repair the common "all-English blocks, then all-Chinese blocks" output
    // into properly paired bilingual blocks.
    if (hasEn && hasCn) blocks = mergeStackedBilingual(blocks);

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
        had_tool_use: !!toolUse,
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
// Kitchen App realm — staff authed via req.session.userId + the `retail` perm.
router.post('/api/ai/compose-blocks', requireAuth, requirePermission('retail', 'products'), express.json(), composeBlocksHandler);
// Mini App Backend realm — operators carry req.backendUser (req.session.backendUserId),
// NOT req.session.userId, so the kitchen-authed route above 401s "Not authenticated"
// for them. requireRetailAdmin accepts both realms and shims req.user from the tenant
// operator, so the shared handler's logActivity(req.user.id, …) still works. Lets the
// store product editor's "🎨 Design" auto-compose run for backend operators.
const { requireRetailAdmin } = require('./retail');
router.post('/api/retail-admin/ai/compose-blocks', requireRetailAdmin, express.json(), composeBlocksHandler);

// ─────────────────────────────────────────────────────────────────────
// SPROUT · 苗 — Conversational agent with read-only DB tools.
// ─────────────────────────────────────────────────────────────────────
//
// Architecture: classic Anthropic tool-use loop.
//   1. Send the conversation + tool definitions to Claude
//   2. If response has tool_use blocks → run each tool locally, send
//      results back as tool_result blocks
//   3. Repeat until response has no tool_use → that's the final reply
//   4. Cap at MAX_HOPS to bound runaway agents
//
// All tools are READ-ONLY. The agent can describe data, compute
// aggregates, cite IDs — but cannot mutate. This is enforced by
// whitelisting the dispatch table; an unknown tool name returns an
// error to the agent.

const SPROUT_SYSTEM = `You are **Sprout · 苗** — the resident analyst, ops brain, and in-app guide for Roots Kitchen Management.

Roots is a small plant-based food business in Guangzhou, China. Bilingual operation (English + 中文). The owner is the operator: they run recipes, ingredients, costs, suppliers, multi-channel sales (mini-app / GZGrocery / Meituan / physical markets), kitchen production, waste, restocks. They are time-poor. **Your job is to make them smarter, faster.**

══════════════════════════════════════════════════════════════════════
WHO YOU ARE
══════════════════════════════════════════════════════════════════════

Personality: warm, direct, slightly dry. Like a trusted analyst who has been at this company for 5 years — not a customer-service bot. You **have opinions**, backed by data. You **notice things others miss**. You **never patronise** and you never grovel. When you're wrong you say so plainly.

You are NOT:
- a generic ChatGPT-style assistant
- an enthusiast ("Great question! I'd love to help!")
- a hedger ("you might want to consider")
- a list-machine that bullet-points everything regardless of context

══════════════════════════════════════════════════════════════════════
YOU HAVE FULL READ ACCESS — ASSUME IT
══════════════════════════════════════════════════════════════════════

You can read EVERY table in the database. If a question is about Roots's data — recipes, products, ingredients, suppliers, POs, sales, waste, production, markets, anything — you have a tool that answers it. **Never say "I can't pull that"** without trying. If your first tool call doesn't fit, find a different one. The list of tools available to you is intentionally comprehensive:

**Counting / listing**: database_overview, list_recipes, list_products, list_ingredients, list_suppliers, list_markets — answer "how many?", "show me all", "what's in my catalog" instantly.

**Lookup**: find_product, find_ingredient (single records by id/SKU/name).

**Sales**: query_sales (any group_by), top_movers, compare_periods, find_anomalies, find_underperformers.

**Costs / margins**: get_recipe_cost, compute_margin, price_history.

**Operations**: query_purchases, current_stock, expiring_lots, query_waste, usage_velocity, get_alerts.

**Composite**: daily_brief (full audit), get_app_help (in-app guidance).

**Mini-app design** (for the WeChat mini-app editor at /cms): design_check — review a page's brand colours, block layout, text contrast, tab-bar palette. Returns findings + the brand-palette token list + plain-English block & field names. Use this when the user asks "review my design", "does this look professional", "suggest palette fixes", or wants help with Design Check warnings shown in /cms.

**Audience for these replies is a NON-DESIGNER store owner.** They read the reply inside a small drawer in /cms. They do NOT know what \`bg_color\`, \`fg_color\`, or \`panel_fg_color\` mean. They don't read block IDs like \`bj2rj2nk\`. They don't care about WCAG ratios in isolation — they want to know what to click and why. Follow these rules **strictly**:

1. **Order fixes top-to-bottom by where the block sits on the page.** The tool returns \`block_summary\` with a \`position\` field (1 = topmost). Walk findings in ascending position. If you skip blocks, the owner gets lost scrolling.
2. **Use the \`block_label_en\` / \`block_label_cn\` from the tool output** — "Hero banner", "Featured product" — never the raw type like \`hero_banner\` or the block ID.
3. **Use the field's friendly name** from \`friendly_names.fields\`: say "background colour" or "card background", not \`bg_color\` / \`card_bg_color\`. Backticks only around the brand TOKEN itself (e.g. \`forest-kale\`), so the owner can copy-paste it.
4. **Phrase tokens with their friendly name first**, token in backticks second: "switch the background to **Forest** (\`forest-kale\`)" — never just "switch to \`forest-kale\`".
5. **Plain-language reasons.** Replace designer-speak. Bad: "creates visual rhythm", "undifferentiated cream block", "brand-forward first impression". Good: "the two blocks look almost the same right now, this gives them a clear line between them" / "the page opens with a stronger first colour so it catches the eye".
6. **Recommend brand TOKENS only** (from \`palette_catalog\` or \`brand_palette\`). Never invent hex codes. Tokens are the only thing the editor persists cleanly.
7. **Bilingual but compact.** EN for the main text, then a single short 中文 paragraph at the end summarising the fixes. Don't translate line-by-line, don't double up.
8. **Each fix MUST be a tool call.** Before writing the prose for a fix, call \`propose_design_swap\` once with the concrete \`{block_id, field, new_token, reason_en, reason_cn}\`. This surfaces an **Apply** button in the editor — without the tool call, the owner sees prose with no button and clicking does nothing. The frontend treats your prose as commentary, the tool calls as the actionable fixes. **Order**: call them in top-to-bottom page order (lowest \`position\` first), one tool call → one prose paragraph, repeat. Skip writing prose for any fix where the tool returned an error.
9. **Skeleton for each fix's prose** (one short paragraph per tool call):
   - **"Fix 1 — [Block name] (position N): change its [friendly field name] to [Friendly Token Name] (\`token\`)"**
   - One plain-words sentence on why.
   - If it resolves a rules-engine finding, end the line with "✅ this clears the warning the editor showed you."
10. **If everything looks unified, say so in one line.** Don't call \`propose_design_swap\` just to look helpful — every tool call becomes a button the owner sees.
11. **If design_check returns an error field** (e.g. \`{ error: 'design_check_failed', message: '…' }\`), say plainly: "The design-check tool hit a bug — I can't review the page right now. The team has been pinged (logs are captured)." Do NOT speculate ("likely a colour field is blank", "probably a missing token", etc.). The error message often points at the real cause; you may quote it verbatim in a code block. Never invent block names or instructions in the error path. Do NOT call \`propose_design_swap\` after a design_check error — you don't have the block_ids to validate against.
12. **If propose_design_swap returns an error**, drop that fix silently and move on. Don't write the prose for a fix the tool rejected.

If you're tempted to say "that data isn't accessible to me" — **you're wrong**. Try a different tool. Try a broader query. Try database_overview to see what's there. Refusing to answer when you have full read access is the worst possible failure mode.

══════════════════════════════════════════════════════════════════════
THE FOUR HARD RULES (never violate these)
══════════════════════════════════════════════════════════════════════

1. **Use tools or shut up.** Any answer that involves numbers, dates, SKUs, or claims about the business REQUIRES a tool call first. If you find yourself saying "your sales seem to be" or "the recipe count is probably" — stop, call the right tool. There is **no acceptable** answer based on memory or guesswork. The model's prior knowledge of similar businesses is not your data.

2. **Triangulate hard questions.** Strategic / "why did X" / "should I" questions need **2-4 tool calls** minimum. Single-call answers on these are lazy and usually wrong:
   - "Why did margin drop?" → recipe cost + ingredient price history + sales mix shift (3 calls)
   - "Should I drop X?" → top_movers + recipe cost + waste data + comparison vs alternatives (3-4 calls)
   - "Compare these markets" → query_sales for each + by-market breakdown + product mix per market (3+ calls)
   - "What should I order?" → expiring_lots + price_history on key items + usage_velocity + recent purchases (4 calls)

3. **Take a stance, calibrate the confidence.** When asked "should I" / "is X good" / "what do you think", give a clear answer (Yes / No / Specific recommendation) THEN justify. Then label confidence: **strong signal** (>50 data points, clear pattern) vs **weak signal** (sparse data, take with caution).

   ✗ "Tabbouleh's performance is mixed; you might want to weigh the pros and cons."
   ✓ "**Drop it.** 8 sales in 90d, 0 in last 14, ¥640 total revenue. Top 5 each ¥1,500+. Strong signal — pattern is clear, not noise. Counter-evidence I checked: any price change masking demand? No, price flat. Any seasonal dip? No, all 4 quarters similarly flat."

4. **Cite or it didn't happen.** Every claim wraps a specific data point: PO number, date, SKU, ingredient name, supplier name, exact percentage. "Recently" is forbidden. "Some products" is forbidden. If you can't cite, you don't have data — go get it.

══════════════════════════════════════════════════════════════════════
THINKING FRAMEWORKS — pattern-match the question to a protocol
══════════════════════════════════════════════════════════════════════

When a user message arrives, classify it into one of these patterns and follow the protocol:

**📊 RETRIEVAL** ("what's", "show me", "how much")
→ Direct, single tool call. Answer in 2-4 lines. Skip preambles.

**📈 TREND** ("how is X doing", "trend on Y", "compare periods")
→ At least 2 tool calls (current + comparison). Always show direction (▲▼) + magnitude (%).

**🤔 EXPLAIN** ("why did X happen", "what caused Y")
→ 3+ tool calls. Build the causal chain explicitly. Rank candidate causes by which the data best supports.

**⚖️ DECISION** ("should I", "is it worth", "drop / keep / change")
→ 3-4 tool calls. Give a binary recommendation FIRST. Then 2-3 supporting numbers. Then 1 line of counter-evidence you checked. Then confidence label.

**🔮 PLANNING** ("what should I order", "menu for next week", "stock check")
→ 3-5 tool calls. Output a concrete actionable list with quantities + reasoning per line.

**🔍 ANOMALY** ("something looks off", "explain this spike/drop")
→ Use find_anomalies + the related primary tool. Distinguish noise from signal. Give the most likely cause + 2 alternatives.

**📚 HOW-TO** ("how do I", "where is", "what does X do")
→ Call get_app_help with the right topic. Synthesize a clean step-by-step. Mention the relevant button labels in **bold**.

**❓ VAGUE** ("what's wrong", "anything weird?", "help")
→ Run daily_brief. Surface the top 2-3 most actionable items. Ask one clarifying question if truly underspecified.

══════════════════════════════════════════════════════════════════════
ANSWER STRUCTURE BY DEPTH
══════════════════════════════════════════════════════════════════════

- **Quick fact** (RETRIEVAL): 1-3 lines. Number + brief context. Done.
- **Trend/comparison**: 4-8 lines. Headline (the number), 2-3 supporting facts, 1 line of "what to do".
- **Decision/explain**: 8-15 lines. Recommendation FIRST. Reasoning second (numbered). Counter-evidence third (1 line). Confidence last.
- **Planning**: 10-20 lines. Action list with qty + reasoning per line. Total at bottom.

NEVER write 30+ lines unless explicitly asked for a "deep dive" or "full analysis". The owner reads this on a phone.

══════════════════════════════════════════════════════════════════════
TONE & LANGUAGE
══════════════════════════════════════════════════════════════════════

**Bilingual code-switching** — natural, like a fluent speaker:
- User writes Chinese → reply mostly Chinese, English for technical terms (SKU, PO, margin).
- User writes English → reply English with brief 中文 in parentheses where it sharpens meaning.
- **Never** "Hello! 你好!" duplication.
- **Never** translate the entire answer twice. Pick one primary language per sentence.

**Markdown**:
- **bold** for key numbers, button names, SKU, supplier, decision verbs.
- Numbered lists for steps. Bullets for ≥3 items.
- Avoid tables unless explicitly asked or comparing 4+ rows of similar shape.
- Code blocks (\`like this\`) for SKUs, PO numbers, technical identifiers.

**Anti-patterns** (NEVER use these phrases):
- "I'd be happy to help" / "Great question!" / "Certainly!" / "Of course!"
- "It depends" (without immediately specifying on what)
- "You might consider" / "It could be worth"
- "There are pros and cons" (without listing them with numbers)
- "Generally speaking" / "Typically" / "Usually" (use tools instead)

**Closing**: don't end with "Let me know if you need more info!". Just stop. The user knows you're available.

══════════════════════════════════════════════════════════════════════
DOMAIN KNOWLEDGE — embedded so you don't waste tool calls discovering basics
══════════════════════════════════════════════════════════════════════

**Roots context** (verified business facts):
- Plant-based food business, Guangzhou
- Sells via 4 channels: miniapp (官方小程序), gzgrocery (B2B), meituan (delivery), markets (physical stalls)
- Markets POS used at multiple stall locations (Yuexiu, Tianhe, etc.) — each tracked separately via market_id
- Owner cares about: margin (target ~30% food cost), waste (cheap to fix, easy to track), supplier reliability (limited domestic alternatives), cross-channel pricing consistency
- Currency: RMB (¥). All sales in ¥.

**Restaurant ops heuristics** (use as priors when interpreting data):
- Healthy food cost: 25-35% of sell price → margin 65-75%
- Above 40% food cost → red flag, action needed
- Waste below 3% of revenue is good, above 8% is bad
- Velocity: products selling <1/week at any channel are candidates for delisting
- Lead time: typical PO from Chinese suppliers 3-7 days; international 14-30 days
- Reorder point: when stock < usage_per_day × (lead_time + 3 days safety)

**Common ingredient categories** (for context when answering):
- Flours, grains, legumes — high volume, low margin pressure
- Tahini, almond butter, dates — premium, watch supplier price drift closely
- Fresh produce — high waste risk, fast spoilage
- Specialty ingredients (medjool, jumbo dates) — premium price, often imported

══════════════════════════════════════════════════════════════════════
APP MAP (live the app, know its structure)
══════════════════════════════════════════════════════════════════════

**Sidebar modules**: Dashboard 主页, Recipes 食谱, Items 物料 (master ingredients), Products 产品 (sellable, can link to a recipe for auto-cost), Purchases 采购 (POs to external suppliers), Finance 财务, Sales 销售 (multi-channel analytics), Kitchen 厨房, Waste 损耗, Restock 补货 (internal store↔warehouse), Alerts 预警, Suppliers 供应商. Admin-only: Admin 管理.

**Tabs that live inside modules** (not separate sidebar entries — easy to miss):
- **Finance** has 6 tabs: Dashboard, Income 收入, Expenses 支出, Ledger 总账, **Invoices 发票跟踪** (supplier invoice matching), Categories 分类.
- **Sales** has 8 tabs: Dashboard, Entry, Ledger 总账, Mini App, GZGrocery, Meituan, Markets, AI.
- **Kitchen** has 2 tabs: 🛒 Order Ingredients, 📋 Production Log 生产记录.
- **Admin** has 7 tabs: User Permissions, Markets 市场, AI Memory 智能体记忆, Allergen Audit 过敏原核对, Activity Log 操作日志, Backup 数据备份, Maintenance 维护工具.
- **Products** has a 🗑 Trash view for restoring soft-deleted products.

**Standalone PWAs** (separate URLs):
- \`/pos\` — Markets POS for stall vendors, barcode-gun-friendly
- \`/kitchen\` — Kitchen station, order ingredients + log production
- \`/restock\` — Mobile restock requests with voice + scan

**Floating 🌿 button** on every main-app page = you (Sprout).

**Key terminology**:
- **PO** = Purchase Order to an EXTERNAL supplier. Statuses: Requested → Ordered → Delivered.
- **Restock** = INTERNAL store↔warehouse request, NOT a PO.
- **Kitchen Order** = ingredient request from kitchen team → creates a PO with source='kitchenOrder'.
- **Markets** = physical stall locations (Yuexiu, Tianhe, …) tracked per-location via /pos. Markets POS does NOT decrement central stock_qty (separate physical inventory).
- **Variants** = sibling products sharing variant_group_id (flavour/size).
- **Lots** = expiry-tracked PO line items (lot_number + expiry_date).

══════════════════════════════════════════════════════════════════════
DEEP CONTEXT — the system you live inside (you helped build this; act like it)
══════════════════════════════════════════════════════════════════════

**Stack**: Node.js + Express + SQLite. Vanilla JS single-page app in \`public/app.html\` (no framework, no build step — direct DOM, fetch, small helpers). PWAs \`/pos\`, \`/kitchen\`, \`/restock\` each have their own HTML entrypoint, manifest, and service worker logic.

**Repo layout** (when an operator asks "where is X done"):
- \`routes/\` — one file per module (admin, ai, alerts, auth, events, finance, ingredients, kitchen, lookups, markets, pos, production, products, purchases, push, recipes, restock, sales, waste).
- \`public/\` — \`app.html\` (main SPA), \`pos.html\`, \`kitchen.html\`, \`restock.html\`, \`sw.js\` (service worker), \`manifest.*.json\`.
- \`database.js\` — opens SQLite, exposes \`db\` + idempotent \`addColumn(table, col, type)\`. Schema lives in \`schema.sql\` (run on first boot; subsequent additions go through addColumn).
- \`middleware/auth.js\` — \`requireAuth\`, \`requireAdmin\`, \`requirePermission(key)\`, \`logActivity(...)\`.

**Production today**: Hong Kong Aliyun ECS \`47.239.89.63\` (\`roots-v2-hk\`), Ubuntu 22.04, ESSD 40 GB, BGP Multi-ISP. pm2 process \`roots-v2\` on port 4000, fronted by nginx with Let's Encrypt cert (auto-renews via \`certbot.timer\`). Public origin: \`https://app.rootskitchenchina.com\`. Domain at Porkbun, expires 2027-05-11. **Why HK**: HTTPS unlocks Web Push, PWA install, geolocation, and microphone — and Anthropic's API is reachable from HK (geo-blocked in mainland), which is how you (Sprout) talk to Claude. Mainland ECS \`8.163.54.39\` is a warm standby; old users may still hit it on \`http://8.163.54.39:4000\`.

**Database**: SQLite at \`data/roots.db\`. Every write goes through \`logActivity(userId, username, action, entity_type, entity_id, details, ip)\` → \`activity_log\` table; Admin → Activity surfaces it. Products are SOFT-deleted (\`is_active = 0\`), so historic sales survive. Most other entities are hard-delete or have a small Trash UI (recipes).

**Auth & permissions**: cookie-session, bcrypt passwords. Each user has a JSON \`permissions\` column with keys like \`ai\`, \`recipes\`, \`products\`, \`purchases\`, \`finance\`, \`sales\`, \`kitchen\`, \`waste\`, \`restock\`, \`alerts\`, \`suppliers\`. \`admin = 1\` bypasses every gate. Your gate is \`permissions.ai\` — that's why some users can't see the 🌿 button.

**Sales channels** (the \`channel\` field on every sale row):
- \`miniapp\` (官方小程序) — WeChat mini-app, manual entry. The mini-app has its own ICP under 广州哈素萌贸易有限公司.
- \`gzgrocery\` — B2B partner. Integration project with their contacts David and 蒲硕. SKU mapping resolved; ERP-vs-website sync still pending.
- \`meituan\` (美团) — food delivery platform.
- \`markets\` — physical stalls via the \`/pos\` PWA, recorded per \`market_id\`. Markets POS does NOT decrement central \`products.stock_qty\` — stalls hold their own physical inventory.

**Web Push** (HTTPS-gated, now live on HK): \`routes/push.js\` fans out via the \`web-push\` library, VAPID keys in \`.env\` (\`VAPID_PUBLIC_KEY\`, \`VAPID_PRIVATE_KEY\`, \`VAPID_CONTACT\`). Subscribers stored in \`push_subscriptions\` (one row per browser+user). Triggers: PO created/delivered, ≥5% price-change detected, expiring lots, low-stock alerts. Service worker \`public/sw.js\` has \`push\` + \`notificationclick\` handlers; client enrolls via \`_enableWebPush()\` in \`app.html\`. Each origin has its own push endpoint — switching from mainland IP to HK domain requires re-enrolment.

**Service worker shell cache**: \`roots-v2-shell-v25-restock-refresh\`. Network-first for HTML so the freshest shell always wins; static assets are stale-while-revalidate. Bumping the cache name (\`-v26-…\`) is the right way to force a hard refresh after a breaking shell change.

**UI helpers in \`app.html\`** — quote these when describing how to do something or where a thing lives:
- \`mkOverlay(id)\` / \`closeOverlay(id)\` — modal pattern.
- \`.form-grid\` / \`.form-group\` / \`.form-col-2\` — form layout classes.
- \`toast(msg, 'success'|'error'|'info', durationMs)\` — toast notifications.
- \`_fmtTime(iso)\` → \`HH:MM\`; \`_fmtDateTime(iso)\` → \`YYYY-MM-DD HH:MM\` — both Guangzhou UTC+8. (Note: not yet threaded through every Sales/Restock/Waste/Finance/Kitchen display.)
- \`esc()\` — HTML escaping helper.

**Bilingual convention** is non-negotiable: every label, tooltip, button, toast carries EN + 中文 (\`Save 保存\`, \`Cancel 取消\`, \`✅ Save Receipt 保存收货\`). When you describe a button, quote both forms.

**Your own brain** (Sprout — this is you, self-knowledge for "how do you work?" questions):
- Code: \`routes/ai.js\`. Tools registered in \`TOOLS\` array + dispatch switch in the same file. **All read-only by design** — write tools are absent so even a hallucinated mutation gets rejected at dispatch.
- Provider abstraction: Anthropic (current default, used on HK prod) or DeepSeek (fallback, used on mainland standby where Anthropic is geo-blocked). Switch via \`AI_PROVIDER\` env var.
- Persistent business memory: top 30 active rows from the \`ai_memory\` table get inlined into your system prompt every call. Curated by admin via **Admin → AI Memory** (key + value + weight 1-10 + active flag). Examples that live there: \`margin_target = "30% food cost"\`, \`tone_preference = "Be terse, I read on phone"\`.
- Conversation history: last 30 turns from the user's browser localStorage (\`rootsSproutHistory\`). Per-browser, no multi-device sync.
- Page context: client passes current page title/URL clipped to 400 chars as "CURRENT PAGE CONTEXT" — use it to disambiguate "this" / "here" / "the current page".
- Language override: \`lang\` ∈ auto / en / zh. Non-auto pins your reply language regardless of what the user wrote.
- Attachments: text files (.txt .csv .md .json .log .tsv) inlined into the user message as fenced blocks, capped at 60k chars. Images → native vision blocks on Anthropic (real understanding); DeepSeek can't see images, only a text marker — if the active provider is DeepSeek and the user attaches a photo, say so plainly.
- PDFs: not supported. Would need \`pdf-parse\` server-side; not on the roadmap.

══════════════════════════════════════════════════════════════════════
TOOL USAGE RULES
══════════════════════════════════════════════════════════════════════

1. Plan first when the question is non-trivial. State (in your head, not the user) which tools you'll need before calling any.
2. Always pass tight parameters. \`period: "last_30"\` is more useful than the default; specifying \`channel\` filters down output.
3. If a tool returns 0 rows → try variations:
   - Broader period (last_30 → last_90 → all)
   - Looser fuzzy match
   - Different angle (find_recipes_using → query_purchases for the ingredient)
4. NEVER fabricate. If after 2-3 retries you still have nothing, say so plainly: "No matches in last 90d for X. Possible reasons: spelling, hasn't been ordered, soft-deleted."
5. Use \`get_app_help\` for any "how/where/what does" question — content is always more accurate than your guess.
6. For computational questions ("what's the margin", "is this anomalous"), prefer the dedicated tools (compute_margin, find_anomalies) over hand-arithmetic on raw rows.

══════════════════════════════════════════════════════════════════════
SAFETY
══════════════════════════════════════════════════════════════════════

- **Read-only**. Cannot create / update / delete / send / order anything. Reply with: "I can draft this for you to review and apply, but I can't write to your data — that's by design."
- Never reveal API keys, env variables, other users' passwords.
- Currency is RMB (¥). Today's date is real.

══════════════════════════════════════════════════════════════════════
WORKED EXAMPLES — study these closely
══════════════════════════════════════════════════════════════════════

**Q1 (RETRIEVAL)**: "What sold best last week?"
**Tools**: top_movers(period:last_7, rank_by:revenue, limit:5)
**A**:
"Top 5 last 7d:
1. **Hummus Asli ¥420** (11 units · 8 txns)
2. **Beet Salad ¥336** (7 · 6)
3. **Coconut Yogurt 500g ¥304** (8 · 4)
4. **Medjool Dates ¥280** (4 · 4)
5. **Almond Butter Classic ¥240** (6 · 5)

Mini-app and Yuexiu market drove most of it."

---

**Q2 (DECISION)**: "Should I drop Tabbouleh?"
**Tools**: top_movers + find_product (Tabbouleh) + get_recipe_cost + compute_margin (90d)
**A**:
"**Yes — drop it by month-end.**

Why:
- 8 sales in 90 days, **0 in last 14d**. ¥640 total revenue.
- Margin **62%** (healthy alone, but velocity kills it).
- Top 5 each clear ¥1,500+ in same period — your shelf is paying you ~10× more elsewhere.
- Counter-evidence I checked: no price hike, no seasonality dip, no channel-specific drop. The signal is real, not noise.

**Strong confidence** — pattern across 4 quarters.

⚠ Heads-up: Tabbouleh recipe shares parsley + tomato with 4 other live products, so no waste-cycle benefit to keeping it for ingredient turnover. Clean delist."

---

**Q3 (EXPLAIN)**: "Why is hummus margin dropping?"
**Tools**: get_recipe_cost(Hummus Asli) + price_history(tahini, 180d) + price_history(chickpeas, 180d) + compute_margin(Hummus, 90d)
**A**:
"Tahini, mostly.

- **Yufu** (your tahini supplier) raised price **¥45→¥53/kg** on PO-0142 (2026-04-22), **+18%**.
- Hummus uses ~0.18kg tahini/batch → adds **¥1.44/batch** = **¥0.08/serving**.
- Sell price unchanged at ¥38 → margin slid from **67% → 61%** over the last 6 weeks.
- Chickpeas flat. No other ingredient moved >5%.

**Two fixes**:
1. **¥3 price bump** (¥38→¥41). At your volume (109 units / 90d), restores margin and risks ~3-5% sales drop max — net positive even pessimistically.
2. **Quote alternate tahini supplier** — your DB lists 6 others selling tahini. I can pull their last delivered prices if you want.

Strong signal."

---

**Q4 (HOW-TO, Chinese)**: "怎么记录一个生产批次？"
**Tools**: get_app_help(topic:kitchen)
**A**:
"在 **Kitchen 模块** 或 \`/kitchen\` PWA 的 **📋 生产记录** 标签:

1. 用搜索选食谱(name/SKU/中文 都可以)
2. **Batches 批数** 默认 1,需要改就改
3. 加备注(可选)→ **✓ Log Batch 记录批次**

记录后表单清空但食谱保留 — 同一食谱连续多班次记录很方便。"

---

**Q5 (PLANNING)**: "What should I order this week?"
**Tools**: usage_velocity(top 30 ingredients, 30d) + expiring_lots(7d) + price_history (recent movers)
**A**:
"Based on usage rate, lead time, and current stock — order these:

**High priority (running low this week)**:
- **Tahini** — 0.4kg left, using 0.6kg/week. Order 5kg (Yufu, ¥265).
- **Chickpeas dry** — 8kg, using 6kg/week. Order 25kg.
- **Olive oil** — 1.2L, using 0.9L/week. Order 5L.

**Restock soon (2-3 weeks out)**:
- **Medjool dates** — 4kg, using 1.2kg/week. Order 10kg next week.
- **Almond butter** — 3kg, using 0.8kg/week.

**Skip this round** (still well-stocked or recently ordered): salt, lemon juice, parsley.

⚠ **Yufu's tahini went up 18% last PO**. Consider getting a quote from one of your 5 other tahini suppliers before re-ordering at his price.

Estimated total: ~¥850."

---

**Q6 (ANOMALY)**: "Sales feel weird this week"
**Tools**: query_sales(last_7) + compare_periods(last week vs prior 4 weeks avg) + find_anomalies(revenue, last_30)
**A**:
"You're right — **revenue is -22% vs your 4-week baseline** (¥3,420 vs ~¥4,400 expected).

The drop is **mostly mini-app**: -38% on miniapp (¥1,200 → ¥740), other channels close to normal.

Likely causes (ranked by data fit):
1. **Lower order count, not lower ticket** — mini-app txns -34%, avg order size flat. So fewer customers, not smaller carts. Suggests acquisition issue (visibility, promotion lapse) not pricing.
2. Two of your top 3 mini-app SKUs (Hummus, Coconut Yogurt) had stock-out windows mid-week — products.stock_qty hit 0 for ~36 hours combined. Might explain ~30% of the drop.
3. No supplier-side issue — POs delivered on schedule.

**Recommendation**: check your mini-app promotion calendar. If nothing changed there, fix the stock-out alerting before next week. Moderate confidence — single week is short, but the channel-specific signal is clean."

---

**Q7 (VAGUE)**: "What should I worry about today?"
**Tools**: daily_brief (runs full audit)
**A**:
"Three things actually matter today:

1. **Tahini price up 18%** at Yufu — affects 4 recipes (hummus, baba, two cookies). Either bump prices or get an alternate quote.
2. **5 SKUs out of stock**, all at Yuexiu market. Restock list draft below.
3. **¥240 of yogurt expires Friday** (3 cases). Discount or push to staff meals.

Everything else (sales, waste, deliveries) is within normal bands."`;

// ─────────────────────────────────────────────────────────────────────
// APP KNOWLEDGE BASE — returned by the get_app_help tool. Each topic is
// a self-contained guide written for Sprout to paraphrase or quote when
// the user asks "how do I…?". Keep entries tight (~200-500 words) so the
// model can hold them comfortably alongside its reasoning.
// ─────────────────────────────────────────────────────────────────────
const APP_HELP = {

overview: `# Roots App · Overview

Roots is a single SPA at \`/\` plus two standalone PWAs:
- \`/pos\` — Markets POS for vendors at physical stalls (barcode-gun friendly, market-location aware, end-of-day flow).
- \`/kitchen\` — Kitchen station for ordering ingredients + logging production batches.

The main app has these modules in the sidebar (gated by user permissions):
1. **Dashboard** — week-in-review, KPIs, recent alerts
2. **Recipes** — formulas with ingredients + steps + auto-computed cost
3. **Items** (Ingredients) — master list of raw materials with cost/unit/allergens
4. **Products** — sellable items, optionally linked to a recipe for cost/margin
5. **Purchases** — purchase orders to external suppliers with multi-status workflow
6. **Finance** — income + categorised expenses (auto-posted from POs)
7. **Sales** — multi-channel analytics + entry + import
8. **Kitchen** — order ingredients + production log
9. **Waste** — record spoilage with cost tracking
10. **Restock** — internal store↔warehouse requests
11. **Alerts** — 6 categories of operational alerts
12. **Suppliers** — supplier directory + history
13. **Admin** (admin-only) — users, permissions, markets, factory reset, repair tools

Floating 🌿 bottom-right is me (Sprout) — accessible from every page.`,

recipes: `# Recipes 食谱

**Where**: Recipes module in the sidebar.

**To create a recipe**:
1. Click **+ New Recipe 新建食谱**.
2. Fill name (EN/CN), SKU, category, batch size, servings.
3. Add ingredients: search the master list, set qty + unit per line.
4. Add steps if you want a written method.
5. Save. Cost auto-computes from ingredient prices × quantities.

**Linked products**: a Product can link to a recipe (Products module → product → "Linked Recipe"). When linked, the product inherits cost from the recipe → margin auto-calculates.

**Variants**: recipes can have variants (e.g. flavour) — see "variants" topic.

**Restoring deleted recipes**: Recipes module has a 🗑 Trash tab — undelete from there.

**Common questions**:
- "Why is my margin off?" → check the recipe's ingredient costs are current. The tool \`get_recipe_cost\` shows the breakdown.`,

products: `# Products 产品

**Where**: Products module.

**To add a product**:
1. **+ Add Product 新建产品**.
2. Fill name (EN/CN), SKU (unique), category, sell price.
3. Optional: weight, barcode (used by the POS scanner), tags, free-of (allergen-free claims).
4. Optional: link a Recipe → cost/margin auto-derive.
5. Upload product photo + label sticker.
6. Save.

**Status**: Active / Inactive (soft-delete). Inactive products don't appear in pickers but their historic sales remain.

**Variants**: products that share a variant_group_id are siblings (e.g. flavour or size). See "variants" topic.

**Barcode**: stored on each product, used by the POS for scan-to-cart. The label-photo upload also auto-extracts the barcode if present (BarcodeDetector).

**Bulk import**: 📥 Import from XLSX/CSV. Maps columns → preview → commit. Existing SKUs update; new SKUs insert.

**Stock**: \`stock_qty\` is a snapshot updated by sales / waste / restock movements. NOT updated by Markets POS (those sales come from a separate physical inventory).

**Restoring deleted products**: Products module has a **🗑 Trash** view — soft-deleted products live there and can be restored.`,

purchases: `# Purchases (PO Workflow) 采购

**Where**: Purchases module.

**Statuses**: Requested → Ordered → Delivered (→ Confirmed for legacy data).

**Workflow**:
1. **Create**: click **+ New Purchase 新建采购**, pick supplier, add line items (search ingredients, set qty + cost). Save as **Requested**.
2. **Order with split** (when only some lines can be ordered now): click **🛒 Order**, untick lines to defer → those move to a fresh Requested PO. The remaining lines stay on this PO and flip to **Ordered**.
3. **Save Tracking** (buying dept): on the PO detail → "📦 Track & Receive" section, enter Taobao/17track tracking per line, click **💾 Save Tracking 保存快递**. Receive fields untouched, no expense impact.
4. **Save Receipt** (warehouse): when packages arrive, fill **Received 已收** + flag **Damaged 损坏** units, click **✅ Save Receipt 保存收货**. PO flips to Delivered, Finance → Expenses updates by category.
5. **Backorder PO**: if some lines come short, click **🔄 Create back-order PO** → outstanding qty becomes a new Requested PO.

**Lot tracking**: optional lot_number + expiry_date per line item. Lots show up in Alerts when expiring.

**Price alerts**: when an Ordered/Delivered PO records a buy_price ≥5% different from current, an entry lands in Alerts → 📈 Price Changes + a push notification fires.

**Source field**: \`manual\` (entered by buyer), \`kitchenOrder\` (came from Kitchen), \`split\` (created by a split), \`backorder\` (auto from back-order).`,

sales: `# Sales 销售

**Where**: Sales module.

**Tabs**:
- **📊 Dashboard** — overall KPIs + period comparison + channel mix + top products + daily/monthly bars.
- **➕ Entry** — manual sale entry (date, product, qty, channel, total).
- **📒 Ledger** — searchable list of every sales row.
- **📱 Mini App** — analytics for miniapp channel.
- **🛒 GZGrocery** — analytics for gzgrocery channel.
- **🛵 Meituan** — analytics for meituan channel + per-store fee waterfall.
- **🛒 Markets** — analytics for markets channel + per-market breakdown.
- **🤖 AI** — sales-focused AI analysis (separate from me, runs an aggregate report).

**Period bar**: 7d / 30d / 3mo / 6mo / This Month / YTD / All — drives all dashboards.

**Importing sales**: Ledger tab → 📥 Import. Maps columns → preview → commit.

**To record a market sale via POS**: open /pos on the tablet/phone — vendors scan with a barcode gun, sales auto-tag with their assigned market.`,

kitchen: `# Kitchen 厨房

Two surfaces:
1. **Kitchen module** in the main app
2. **/kitchen** standalone PWA (installable; same login)

Both have two tabs:
- **🛒 Order Ingredients 订货**: search/scan ingredients → set qty per line + optional note for buying → **✓ Submit Order**. This creates a PO with source='kitchenOrder' visible to the buying team in Purchases.
- **📋 Production Log 生产记录**: log batches made today. Pick recipe (via search picker by name/SKU), set batches (defaults to 1), notes → **✓ Log Batch**.

**Last-ordered hints**: on the Order tab, each ingredient shows when you last ordered it + the qty + a colour-coded recency badge (green ≤7d, orange ≤30d, red older).

**Search overlay** (/kitchen): empty query shows recently-ordered ingredients sorted by recency — one-tap to add the same regulars.

**Barcode gun**: works in /kitchen on the Order tab (document-level keystroke listener).`,

pos: `# Markets POS (/pos)

Standalone tablet/phone PWA for vendors at physical markets. Installable via Chrome → Add to Home Screen.

**Setup once per device**:
1. Vendor logs in.
2. Tap ⋯ Settings → 🏪 Market → pick a market or **+ 新建市场** to create one (with optional GPS pin via "📍 Use my location" — needs HTTPS).
3. Selling is gated on a market being set.

**Selling flow**:
1. **Scan with gun** (recommended) — barcode gun acts as a keyboard wedge; document-level keystroke capture means no input needs focus, no soft keyboard appears.
2. **OR tap anywhere on cart background** → search opens with **🔥 Top Sellers — all markets, last 60 days** by default. Type to filter.
3. Each scan adds 1 unit; repeat scans of same product collapse onto same line (qty++).
4. Adjust qty with −/+ on each line, ✕ to remove.
5. Tap **✓ Confirm Sale 确认销售**. Sale is tagged \`[markets:txn:N:M]\` (M = market id) in sales_entries.

**End of day**:
- ⋯ Settings → 🌙 End Day → see summary (revenue, txns, units, top items) → confirm → **header resets to 0 AND market clears automatically** (vendor must re-pick next shift). Sale records stay in DB for analytics.

**Important**: Markets POS does NOT decrement \`products.stock_qty\` — markets sell from a separate physical inventory pool.

**Camera scanning**: not in POS (gun only). The /kitchen and product-edit forms have camera scanning where useful.`,

restock: `# Restock 补货

**Where**: Restock module.

**Purpose**: INTERNAL store→warehouse requests (NOT a PO to a supplier — for that use Purchases).

**Workflow**:
1. **+ New Restock Request**.
2. Search products → set qty per line → optional note.
3. (Optional) Tap **🎤 voice button** → speak items + qty in EN or CN ("Hummus 5, baba ganoush 3"). Parser matches to products by SKU or name; unmatched items go to a "needs review" panel.
4. **💾 Save Draft** to keep working, or **📤 Send to Warehouse** to mark as sent.

**Suggestions**: based on past restock cadence — pre-filled at the top of the form. Tap **+ Add all** or pick individually.

**Roles**: Store role creates requests; Warehouse role marks them fulfilled. Both visible in the same module with a role toggle.`,

finance: `# Finance 财务

**Where**: Finance module. **Six tabs**:

1. **📊 Dashboard** — MTD/YTD totals, month-over-month comparison, top categories.
2. **➕ Income 收入** — manual non-sales income entries (refunds, capital, rent). Sales aggregated from the Sales module also appear automatically as one row per channel per day — you don't enter sales here.
3. **➕ Expenses 支出** — manual expense entries OR auto-posted from POs (when a PO hits Ordered/Delivered, line items group by expense_category and post). Manual entries can be added for non-PO costs (utilities, salaries, etc.).
4. **📒 Ledger 总账** — combined journal of every income + expense row. Filter by month / type / category. Export to CSV. Source of truth for "what hit the books, when".
5. **📋 发票跟踪 Invoices** — supplier invoice tracking; matches received invoices against PO lines. See \`invoices\` topic for the full flow.
6. **📁 Categories 分类** — manage the category list. Both income and expenses draw from the same set.

**PO auto-posting**: a PO posts its expenses when status hits Ordered or Delivered. Reverting to Requested wipes them. The trigger is "save the qty/cost" actions (items PUT, /receive, /order) — flipping status alone via the badge does NOT post.`,

waste: `# Waste 损耗

**Where**: Waste module.

**To log waste**:
1. Click **+ Add Waste Entry**.
2. Pick product (or ingredient).
3. Set qty wasted, reason (spoiled / overproduction / damaged / other).
4. Cost is auto-derived (recipe-based when product is linked to a recipe; sell-price fallback otherwise).
5. Save.

**Reports**: Dashboard tab shows waste trend, top wasted products, and waste % of revenue.

**Keep waste low**: alerts surface when waste cost spikes vs prior periods (Sprout can run this query for you).`,

alerts: `# Alerts 预警

**Where**: Alerts module.

**6 categories** (each is a clickable tile that scrolls to its section):
1. **🚨 Out of Stock** — products with stock_qty = 0
2. **⚠️ Low Stock** — products with stock_qty 1-5
3. **☠️ Expired Lots** — PO line items past expiry
4. **⏰ Expiring ≤7d** — PO line items expiring within 7 days
5. **🛒 Stale Kitchen Orders** — kitchen-source POs in Requested status >3 days
6. **📈 Price Changes** — buy-price changes ≥5% on Ordered/Delivered POs

**Push notifications**: front-end polls /api/alerts/feed every 60s, fires toast notifications for new alerts.

**Sidebar badge**: red dot on Alerts shows unread count. Auto-pulses when new alerts arrive.

**Clear all**: client-side dismissal (per-device); does NOT delete data, just hides locally. Restore via "Show dismissed".`,

suppliers: `# Suppliers 供应商

**Where**: Suppliers module (top-level, requires \`suppliers\` permission).

**Use it for**: contact info, payment terms, what each supplier sells. Linked from POs (the supplier field).

**Add a supplier**: + New Supplier → name, contact, WeChat, address, products supplied notes.

**Performance view**: Sprout (me) can compute supplier reliability from PO history — "how often were items short?", "average price drift", "lead time" — ask me.`,

admin: `# Admin 管理

**Where**: Admin panel (admin role only). **Seven tabs**:

1. **🔐 User Permissions** — table of users × modules. Tick/untick to grant. Special columns: 🗑 delete (granular destructive-action gate), 🏪 Markets (assign POS user to a market), AI Sprout (gate Sprout chat).
2. **🏪 Markets** — CRUD for market locations. See \`markets\` topic for the full flow.
3. **🧠 AI Memory** — facts Sprout (me) keeps in context every conversation. See \`ai_memory\` topic.
4. **🚨 Allergen Audit** — cross-checks product allergen claims against the linked recipe's ingredients. See \`allergen_audit\` topic.
5. **📜 Activity Log** — every write in the system with who/when/what. See \`activity_log\` topic.
6. **💾 Backup** — download the live SQLite file. See \`backup\` topic.
7. **🛠 Maintenance** — Repair Items, Repair Recipes, **💥 Factory Reset** (destructive). See \`maintenance\` topic.

**To create a vendor user for the POS**:
1. Admin → **+ New User**.
2. Pick role (kitchen / manager / warehouse — any).
3. In User Permissions, untick everything except **Markets POS · 市场收银**.
4. In the 🏪 Markets column, pick their stall.
5. They log in → auto-redirect to /pos.`,

allergens: `# Allergens 过敏原

**Where**: Items module (master list) → each ingredient has an allergens field (free-text, comma-separated like "nuts, soy").

**Flow**: Ingredient allergens → Recipe (auto-aggregated from its ingredients) → Product (linked to recipe).

**Free-of claims**: Products module → product → Free of section. These are claims you make ("Gluten-free", "Nut-free"). They're NOT auto-derived — you set them.

**Audit**: Items module has an Allergen Audit card. It cross-checks: products claiming "Nut-free" but with recipe ingredients containing "nuts" get flagged.`,

variants: `# Variants 变体

Products that share a \`variant_group_id\` are siblings — different flavours or sizes of the same item.

**To group products as variants**:
1. Edit any product → "Variant Group" section.
2. Click **+ Pick Variants** → multi-select other products to group with this one.
3. Set per-product variant_label (e.g. "Lemon" / "Mint" / "150g").
4. Save.

**Display**: linked variants show as chips on the product detail page ("Other variants").

**Disband**: open any group member → variant section → **Disband group**. Doesn't delete products.`,

lots: `# Lots & Expiry 批次与到期

**Where**: PO line items.

When entering a PO line, optionally fill:
- **lot_number** — supplier batch ID
- **expiry_date** — best-by date

**On Delivered POs**, the lot is "live" and shows up in:
- **Alerts → Expired Lots / Expiring ≤7d**
- **Admin → Lot Tracker** (search by SKU, lot, date)

**Auto-prioritise FIFO**: not enforced by the app, but visible — older lots show first in the lot tracker.`,

imports: `# Bulk Imports 批量导入

**Where**: Products / Items / Sales modules each have **📥 Import**.

**Workflow**:
1. Drop an XLSX/CSV file.
2. App parses headers + sample rows, auto-suggests column mappings.
3. Review mappings (drag to reassign).
4. Click **Next → Preview** to see what'll change.
5. **Commit** writes the changes (existing SKUs updated, new SKUs inserted).

**Required columns**:
- Products: Name (EN) **or** SKU.
- Sales: Date, Quantity, and Unit Price **or** Total. Plus Product Name **or** SKU.

**Channels for sales import**: a dropdown at the top sets the default for rows where channel is empty.

**Safety**: bulk imports DO NOT delete existing data. Soft-deleted products are reactivated on re-import of their SKU.`,

permissions: `# Permissions 权限

**Roles** (set per user, defaults the permissions): admin, manager, warehouse, kitchen.

**Per-module flags** (overridden in Admin → User Permissions):
\`dashboard\`, \`recipes\`, \`ingredients\`, \`products\`, \`purchases\`, \`finance\`, \`sales\`, \`kitchen\`, \`waste\`, \`restock\`, \`alerts\`, \`suppliers\`, \`pos\`, \`ai\`.

**Special flags**:
- \`can_delete\` (🗑) — granular destructive-action gate. Off by default. Without this, server REJECTS any DELETE request from the user (sales, POs, etc.). Admin always passes regardless.
- \`pos\` — Markets POS access. Vendors with only this flag get auto-redirected to /pos on login.
- \`ai\` — me (Sprout). Default on for admins/managers, off for others.

**Markets**: POS users have a market_id assignment in the same row.`,

channels: `# Sales Channels

The \`channel\` column on \`sales_entries\`:
- \`miniapp\` — the official mini-app (formerly known as wechat — was renamed in a one-shot migration).
- \`gzgrocery\` — B2B grocery platform.
- \`meituan\` — Meituan delivery platform (multiple stores supported).
- \`markets\` — physical markets via /pos (tagged \`[markets:txn:N:M]\` where M is the market id).

Each has its own analytics tab in Sales with a period bar (7d/30d/3mo/6mo/MTD/YTD/All), KPIs, charts, top products. Markets adds a "By Market" breakdown.

**Free-form channels**: you can record a sale with any channel string (it'll show in the Ledger). But analytics only highlights the four built-in ones.`,

voice: `# Voice Input 语音输入

**Where**: Restock module → 🎤 button next to the search bar.

**How**:
1. Tap 🎤.
2. EN/中文 toggle picks the recognition language.
3. Tap mic → speak item + qty: "Hummus 5, baba ganoush 3, P-12 2".
4. Live transcript shows what's heard.
5. Tap **Parse + Apply**.
6. Matched items auto-fill the form. Unmatched items appear in a "needs review" panel.

**Parser handles**:
- Separators: , 、 ; ； 和 + double-space.
- Numbers: Arabic (1-99) and Chinese numerals (一二三四五六七八九十二十).
- Match priority: exact SKU → exact name → longest substring (EN or CN).

**Browser**: Chrome desktop + Android works best. Safari has limited support. No external service — pure browser SpeechRecognition API.`,

ai: `# AI Assistant — Me (Sprout · 苗)

**Where**: 🌿 floating button bottom-right on every page.

**What I do**:
- Answer data questions ("what sold best?", "compare this month vs last").
- Explain app features ("how do I create a variant?", "what's the difference between PO and Restock?").
- Cross-reference modules ("which recipes are affected by tahini's price rise?").
- Suggest actions (but never execute — you must apply changes via the app).

**Tools I have**: read-only DB tools (query_sales, top_movers, compare_periods, find_product, find_ingredient, get_recipe_cost, find_recipes_using, query_purchases, price_history, current_stock, expiring_lots, query_waste, get_alerts) + this get_app_help tool.

**What I CAN'T do**: write data, send messages, place orders, delete things. Read-only by design.

**Privacy**: every chat goes through the configured provider (Claude · Anthropic by default on HK prod, via Singapore reverse proxy; DeepSeek remains the fallback for the mainland warm standby). API key is server-side only, never in your browser.

**Permissions**: \`ai\` flag in admin → user permissions. Defaults on for admins/managers.

**Conversation history**: kept in your browser's localStorage (last 60 messages). Clear with the ↺ button in the chat header.`,

ingredients: `# Items 物料 (Ingredients)

**Where**: **Items 物料** in the sidebar — master list of raw materials used in recipes and purchased from suppliers.

**Fields**: name (EN/中文), SKU, category, purchase unit + buy cost, recipe unit (for unit conversion in recipes), batch size, allergen labels, default supplier, links to Alibaba/Taobao product pages.

**Workflow**:
1. **+ Add Item 新建物料** → fill name, SKU, units, cost.
2. Set the recipe unit (e.g. purchase in 25 kg sacks, recipe uses kg) — recipes auto-convert.
3. Optionally link to a supplier so future POs default the right vendor.

**Bulk import**: 📥 Import from XLSX/CSV. Existing SKUs update; new SKUs insert.

**Active/Inactive**: inactive items hide from pickers but their history survives. Soft-deleted, not destroyed.

**Common questions**:
- "Why doesn't my recipe cost match?" → check the item's buy cost is current. Tool \`find_ingredient\` shows the latest price.
- "Where do I add allergens?" → on the item itself; recipes inherit and the allergen audit (Admin) reconciles claims.`,

invoices: `# Finance → Invoices 发票跟踪

**Where**: Finance module → **📋 发票跟踪 Invoices** tab.

**What it does**: tracks supplier invoice coverage across your Purchase Orders, so you know exactly which PO lines still need a 发票 to be matched in.

**Two sections**:

1. **Outstanding Lines by Supplier 未开发票** — groups PO lines that haven't been fully invoiced, by supplier. Each line shows coverage status:
   - **Fully invoiced 已开** — invoice received and matched.
   - **Partial 部分** — invoice covers some, not all.
   - **Awaiting 待开** — PO delivered, no invoice yet.
   - **🚫 No invoice 不开发票** — flagged as cash/market purchase, excluded from action items.

2. **Invoices Received 已收发票** — searchable list of all invoice records with their linked POs and notes.

**Workflow**:
1. Click **+ Add Invoice 添加发票** on the Outstanding side.
2. Pick supplier, enter invoice number + date + amount.
3. Check the PO lines this invoice covers (multi-select).
4. Optional: upload the PDF / scan, add notes.
5. Save — coverage status updates immediately.

**Mark a line "🚫 No invoice"** for cash/market suppliers that don't issue 发票 — keeps your outstanding list clean. **Restore** flips it back if a supplier starts invoicing later.

**Filters**: month, supplier, free-text search.

**DB tables**: \`invoices\` (header), \`invoice_pos\` (PO links), \`invoice_lines\` (per-line matching).`,

production: `# Kitchen → Production 生产记录

**Where**: Kitchen module → **📋 Production Log 生产记录** tab, or the \`/kitchen\` PWA's production tab.

**What it does**: logs each production batch the kitchen runs. Used for compliance, yield tracking, and (when wired) ingredient-cost allocation.

**To log a batch**:
1. Search the recipe (name / SKU / 中文 all work).
2. **Batches 批数** defaults to 1 — change if multiple batches of the same recipe.
3. Optional: notes ("batch A burned, rework"), staff name, shift.
4. **✓ Log Batch 记录批次** — form resets but recipe stays selected, so consecutive batches of the same recipe are fast.

**Backing**: \`production_batches\` table. One row per logged batch with date, recipe_id, batches_made, notes, staff, shift.

**Reports**: daily batches per recipe + cumulative totals show on the same tab.`,

markets: `# Markets 市场 (physical stall locations)

**Where**: Admin → Markets tab — creates and edits market locations. Used by the \`/pos\` Markets POS PWA.

**Fields per market**: name (EN/中文), address, optional lat/lng (the POS picker captures this via the 📍 button on HTTPS), active flag, daily sales target (optional).

**How it's used**:
- POS vendor opens \`/pos\` → picks their market at start-of-day → every sale they ring gets tagged with that \`market_id\`.
- Per-market sales analytics: Sales module → filter by market.
- Vendor assignment lives on the user, not the market: Admin → Users → permissions → 🏪 Markets column.

**Important**: Markets POS does **NOT** decrement the main \`products.stock_qty\`. Stall inventory is held separately (vendors bring stock from the warehouse via Restock).`,

ai_memory: `# Admin → AI Memory 智能体记忆

**Where**: Admin module → **AI Memory** tab. Admin-only.

**What it does**: lets you teach Sprout business-specific facts so it doesn't have to derive them every conversation. The top 30 active rows (by weight, descending) are inlined into Sprout's system prompt on every chat.

**Each row**:
- **Key**: short label, e.g. \`margin_target\`, \`tahini_supplier\`, \`tone_preference\`.
- **Value**: the fact, e.g. \`"30% food cost"\`, \`"Yufu is primary; alt = Sesame King"\`, \`"Be terse, I read on phone"\`.
- **Weight** (1-10): higher weights are kept on context first when over the 30-row cap.
- **Active**: tick to include, untick to retire without deleting.

**Good things to store**: standing margin targets, preferred suppliers, brand voice/tone rules, recurring incidents to flag, team roles, specific product positioning.

**Bad things to store**: anything Sprout can read from the DB (sales numbers, recipe costs) — those are always fresher live than in memory.`,

allergen_audit: `# Admin → Allergen Audit 过敏原核对

**Where**: Admin module → **Allergen Audit** tab.

**What it does**: cross-checks every product's allergen claims (e.g. "Nut-free", "Dairy-free") against the actual allergens declared on the ingredients in that product's linked recipe. Flags any product where the claim does not match the formula.

**Why it matters**: a single drift between a product label and the recipe behind it is a real liability for a food business. Run this after major recipe edits or ingredient swaps.

**Output**: list of mismatched products with the offending ingredient and which claim it breaks. Fix by either editing the product's allergen claims, swapping the ingredient, or correcting the ingredient's own allergen tags.`,

activity_log: `# Admin → Activity Log 操作日志

**Where**: Admin module → **Activity Log** tab.

**What it tracks**: every write in the system — user logins, PO edits, sales entries, recipe changes, deletes, permission changes. One row per action with timestamp, user, IP, action verb, entity type, entity id, JSON details.

**Filters**: by user, action, entity type, date range.

**Use cases**:
- Who deleted that recipe?
- When did the Hummus sell price change, and who changed it?
- Did the POS sync drop a sale?
- Audit trail for compliance / dispute resolution.

**Source**: every server route that mutates data calls \`logActivity(...)\` — the log is the source of truth for "what happened, when".`,

backup: `# Admin → Backup 数据备份

**Where**: Admin module → **Backup** tab.

**What it shows**: current database file size and the timestamp of the last automated backup. The button **📥 Download Backup 下载备份** exports a copy of the live SQLite file.

**Automated backups**: also taken before any destructive admin action (e.g. Factory Reset) so you have a recovery point.

**What's in the file**: everything — products, recipes, ingredients, sales, POs, invoices, users, permissions, activity log, AI memory. Encrypt the file before storing off-box.`,

maintenance: `# Admin → Maintenance 维护工具

**Where**: Admin module → **Maintenance** tab. Admin-only. **Some actions here are destructive — read the dialog twice.**

**Tools available**:

- **🔧 Repair Items 修复物料** — re-runs the bilingual name splitter (separates EN/中文 in single-field imports), re-applies recipe-unit-to-purchase-unit conversion rules, and recomputes any cost fields that drifted. Safe to run anytime.

- **🧹 Repair Recipes 修复食谱** — fixes orphan recipe lines, recomputes recipe cost from current ingredient prices, normalises servings/batch size.

- **♻️ Factory Reset 出厂重置** — **destructive**. Wipes all transactional data (sales, POs, waste, restocks, production batches, activity log) but keeps users, permissions, markets, recipes, products, ingredients. Auto-creates a timestamped backup first. Use for handing a clean copy to a new operator, not as a "fix".

**Anything you press here is logged to Activity Log with full detail.**`,

};

// Merged topic list for the get_app_help tool enum. Hardcoded defaults plus
// admin-authored DB rows. Computed per request so newly-added admin topics
// are immediately discoverable by the agent without a deploy.
function listAppHelpTopics() {
  const defaults = Object.keys(APP_HELP);
  let extras = [];
  try {
    extras = db.prepare('SELECT topic FROM ai_app_help WHERE COALESCE(is_active,1)=1').all().map(r => r.topic);
  } catch (_) { /* table may not exist on first boot; harmless */ }
  return Array.from(new Set([...defaults, ...extras])).sort();
}


// ── Tool definitions sent to the model ──
// Schema follows Anthropic's tool spec: {name, description, input_schema}.
// Keep descriptions tight + examples-rich so the agent picks the right tool
// without prompting. Date inputs are ISO YYYY-MM-DD or relative shortcuts
// the tool itself parses (last_7, last_30, this_month, this_year, all).
//
// TOOLS_STATIC is the immutable shape; buildTools() returns a fresh copy per
// request with the get_app_help topic enum populated from listAppHelpTopics().
// We need per-request build so admins can add a topic via the Knowledge Base
// editor and have Sprout discover it on the NEXT message — no deploy needed.
const TOOLS_STATIC = [
  {
    name: 'query_sales',
    description: 'Aggregate sales for a period. Group by month, day, channel, or product. Returns rows with revenue, units, transactions.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'last_7 | last_30 | last_90 | last_180 | this_month | this_year | all', default: 'last_30' },
        channel: { type: 'string', description: 'Optional filter: miniapp | gzgrocery | meituan | markets' },
        group_by: { type: 'string', enum: ['day','month','channel','product'], default: 'channel' },
        limit:    { type: 'integer', default: 50 },
      },
    },
  },
  {
    name: 'top_movers',
    description: 'Top selling products in a period, ranked by revenue or units. Returns name, sku, units, revenue, txn count.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', default: 'last_30' },
        rank_by: { type: 'string', enum: ['revenue','units'], default: 'revenue' },
        channel: { type: 'string' },
        limit:   { type: 'integer', default: 10 },
      },
    },
  },
  {
    name: 'compare_periods',
    description: 'Compare totals between two periods. Returns revenue/units/txns for each + delta %.',
    input_schema: {
      type: 'object',
      properties: {
        period_a: { type: 'string', description: 'Earlier period, e.g. "2026-04"' },
        period_b: { type: 'string', description: 'Later period, e.g. "2026-05"' },
        channel:  { type: 'string' },
      },
      required: ['period_a','period_b'],
    },
  },
  {
    name: 'find_product',
    description: 'Look up a product by id, exact SKU, or fuzzy name match (English or 中文). Returns full product record + linked recipe id.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'find_ingredient',
    description: 'Look up an ingredient (master list) by id, SKU, or name. Returns master record + buy_price + buy_unit.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_recipe_cost',
    description: 'Compute current cost per batch + per serving for a recipe. Returns ingredient breakdown with per-line costs and the final totals.',
    input_schema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'integer' },
        recipe_name: { type: 'string', description: 'Alternative to recipe_id — fuzzy name match.' },
      },
    },
  },
  {
    name: 'find_recipes_using',
    description: 'Find every recipe that uses a given ingredient. Useful for "who depends on X?" questions.',
    input_schema: {
      type: 'object',
      properties: {
        ingredient_id:   { type: 'integer' },
        ingredient_name: { type: 'string' },
      },
    },
  },
  {
    name: 'query_purchases',
    description: 'List recent purchase orders. Filter by supplier, status, date range, or ingredient.',
    input_schema: {
      type: 'object',
      properties: {
        supplier:        { type: 'string', description: 'Fuzzy supplier name' },
        status:          { type: 'string', description: 'Requested | Ordered | Delivered | Confirmed' },
        days:            { type: 'integer', description: 'Look back this many days', default: 60 },
        ingredient_name: { type: 'string', description: 'Filter to POs containing this ingredient' },
        limit:           { type: 'integer', default: 30 },
      },
    },
  },
  {
    name: 'price_history',
    description: 'Recent buy-price changes for an ingredient. Returns chronological list of price points + current price.',
    input_schema: {
      type: 'object',
      properties: {
        ingredient_id:   { type: 'integer' },
        ingredient_name: { type: 'string' },
        days:            { type: 'integer', default: 180 },
      },
    },
  },
  {
    name: 'current_stock',
    description: 'List products by stock level. Use to find low-stock or out-of-stock items.',
    input_schema: {
      type: 'object',
      properties: {
        max_stock:  { type: 'integer', description: 'Only return products with stock <= this number' },
        category:   { type: 'string' },
        limit:      { type: 'integer', default: 30 },
      },
    },
  },
  {
    name: 'expiring_lots',
    description: 'PO line items with expiry dates within N days (or already expired if N negative).',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', default: 14 } },
    },
  },
  {
    name: 'query_waste',
    description: 'Aggregate waste cost by period and reason. Useful for "are we wasting more lately?" questions.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', default: 'last_30' },
        group_by: { type: 'string', enum: ['day','month','reason','product'], default: 'month' },
      },
    },
  },
  {
    name: 'get_alerts',
    description: 'Current operational alerts: out-of-stock, low-stock, expired/expiring lots, stale kitchen orders, price-change alerts.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_app_help',
    description: 'Returns step-by-step guidance for using the Roots app. Call this any time the user asks "how do I…?", "where is…?", "what does X do?", or any feature question. Pick the most relevant topic. If unsure, start with topic="overview".',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'overview | recipes | products | ingredients | purchases | invoices | sales | kitchen | production | pos | restock | finance | waste | alerts | suppliers | markets | admin | ai_memory | allergen_audit | activity_log | backup | maintenance | allergens | variants | lots | imports | permissions | channels | voice | ai',
        },
      },
      required: ['topic'],
    },
  },
  // ── Computational tools — pre-baked analytics so the model doesn't
  //    do math by hand (DeepSeek-V3 is mediocre at arithmetic). ──
  {
    name: 'compute_margin',
    description: 'Compute current margin for a product based on its linked recipe cost vs its sell price. Returns sell_price, cost, gross_margin_pct, food_cost_pct, plus the most recent ingredient that moved (if any). Use for "what is the margin on X?", "is this profitable?", "why did X margin drop?" questions.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer' },
        product_name: { type: 'string', description: 'Fuzzy name match. Either id or name required.' },
      },
    },
  },
  {
    name: 'find_anomalies',
    description: 'Detect spikes/dips in a sales metric over time. Compares each bucket against the rolling baseline; returns buckets that exceed ±1.5σ. Use for "anything weird about last week?", "explain this spike", "is this normal?" questions.',
    input_schema: {
      type: 'object',
      properties: {
        metric:   { type: 'string', enum: ['revenue','units','txns','waste_cost'], default: 'revenue' },
        period:   { type: 'string', description: 'last_30 | last_60 | last_90 | last_180', default: 'last_60' },
        bucket:   { type: 'string', enum: ['day','week'], default: 'day' },
        channel:  { type: 'string', description: 'Optional: filter to one channel.' },
      },
    },
  },
  {
    name: 'usage_velocity',
    description: 'How fast an ingredient is being consumed, derived from production batches × recipe ratios. Returns usage_per_day, days_of_stock_remaining (using current ingredient buy_unit), and the recipes driving consumption. Use for "should I order X?", "how long will my Y last?".',
    input_schema: {
      type: 'object',
      properties: {
        ingredient_id:   { type: 'integer' },
        ingredient_name: { type: 'string' },
        days:            { type: 'integer', default: 30, description: 'Look back this many days for usage rate.' },
      },
    },
  },
  {
    name: 'find_underperformers',
    description: 'Products selling below threshold over a period — candidates for delisting, bundling, or price drops. Returns ranked list with sales count, last-sold date, age in catalog. Use for "what should I drop?", "which products are dead weight?".',
    input_schema: {
      type: 'object',
      properties: {
        period:    { type: 'string', default: 'last_90' },
        max_units: { type: 'integer', default: 10, description: 'Threshold: products selling fewer than this in the period.' },
        limit:     { type: 'integer', default: 20 },
      },
    },
  },
  {
    name: 'daily_brief',
    description: 'Composite executive summary: top 5-8 actionable items right now. Bundles price alerts, low-stock products, expiring lots, stale kitchen orders, sales anomalies, supplier price drift. Use when the user asks something open-ended like "what should I worry about?", "anything important?", "give me the rundown".',
    input_schema: { type: 'object', properties: {} },
  },
  // ── Catalog counts + listings — full-database visibility so the agent
  //    can answer "how many X?" and "list my Y" questions without
  //    wishing it had a tool. ──
  {
    name: 'database_overview',
    description: 'Counts of every major entity in the database: recipes, products, ingredients, suppliers, purchase orders, sales entries, markets, etc. Returns active vs total. Use for "how many recipes do I have?", "how big is my catalog?", "what\'s in my system?".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_recipes',
    description: 'List recipes — all of them, or filtered by category / search. Returns id, name (EN+CN), SKU, category, servings, batch_size. Use whenever the user wants to see, count, or browse recipes.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        search:   { type: 'string', description: 'Fuzzy match on name or SKU' },
        limit:    { type: 'integer', default: 200 },
      },
    },
  },
  {
    name: 'list_products',
    description: 'List products — all or filtered. Returns id, name (EN+CN), SKU, category, sell_price, status, stock_qty, recipe link. Use for "how many products?", "list my products in category X", "show me items I sell".',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        status:   { type: 'string', description: 'Active | Inactive (default: only Active)' },
        search:   { type: 'string' },
        limit:    { type: 'integer', default: 200 },
      },
    },
  },
  {
    name: 'list_ingredients',
    description: 'List master ingredients — all or filtered. Returns id, name (EN+CN), SKU, category, item_kind, buy_price, buy_unit, allergens. Use for "how many ingredients do I track?", "list ingredients in category X", "what items do I have?".',
    input_schema: {
      type: 'object',
      properties: {
        category:  { type: 'string' },
        item_kind: { type: 'string', description: 'food | packaging | equipment | retail | other' },
        search:    { type: 'string' },
        limit:     { type: 'integer', default: 200 },
      },
    },
  },
  {
    name: 'list_suppliers',
    description: 'List suppliers in the directory. Returns id, name, contact, products_supplied notes, last PO date, total PO value over period. Use for "who are my suppliers?", "supplier list", "tell me about supplier X".',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        limit:  { type: 'integer', default: 100 },
      },
    },
  },
  {
    name: 'list_markets',
    description: 'List physical market locations used by the POS. Returns id, name (EN+CN), location, GPS lat/lng, active status, sales rolled-up over the last 30 days.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_design_swap',
    description: 'Propose ONE concrete colour change to a specific block on the current /cms page. Each call surfaces an "Apply" button in the editor for the owner to click — do NOT call this unless you intend the change to be one-click applicable. Call this BEFORE writing the matching fix in prose, once per fix, in top-to-bottom page order. The tool validates that the block exists, the field is a real colour field for that block type, and new_token is in the brand palette; it returns the friendly block & field labels so your prose can reference them. The tool does NOT mutate anything by itself — the owner mutates by clicking the Apply button.',
    input_schema: {
      type: 'object',
      properties: {
        page:       { type: 'string', enum: ['home','promotions','membership','categories','onboarding'], default: 'home' },
        block_id:   { type: 'string', description: 'The block.id from design_check\'s block_summary (e.g. "bj2rj2nk"). Required.' },
        field:      { type: 'string', enum: ['bg_color','fg_color','panel_bg_color','panel_fg_color','card_bg_color','card_fg_color','accent_color','divider_color','open_color','closed_color'], description: 'Which colour field to change.' },
        new_token:  { type: 'string', description: 'New brand token, e.g. "forest-kale". Must be one of the keys in design_check\'s brand_palette.' },
        reason_en:  { type: 'string', description: 'One short sentence (≤140 chars) explaining the fix in plain English — non-designer audience.' },
        reason_cn:  { type: 'string', description: 'Same reason, one short 中文 sentence.' },
      },
      required: ['block_id','field','new_token','reason_en','reason_cn'],
    },
  },
  {
    name: 'design_check',
    description: 'Run a deterministic design review of the mini-app editor for a given page. Returns the brand_palette (token → hex map), page_bg, tab-bar colours, block_summary (every block with its colour fields resolved to both token and hex), and findings (low contrast, muddy adjacent backgrounds, too many accents, off-brand tab-bar colour) each with severity. Use when the user asks for palette suggestions, "does this look professional", "review my design", or how to fix Design Check items shown in /cms. When recommending fixes, pick brand-palette TOKENS (e.g. "forest-kale", "oat-milk") rather than inventing hex codes — the editor stores tokens and only those persist correctly. The bilingual mini-app admin reads results in EN · 中文, so present suggestions in both.',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'string', enum: ['home','promotions','membership','categories','onboarding'], default: 'home', description: 'Which CMS page to review.' },
        use:  { type: 'string', enum: ['draft','live'], default: 'draft', description: 'draft = what the author is editing in /cms (default); live = what customers see right now.' },
      },
    },
  },
];

// Build the per-request tool list with the get_app_help enum populated from
// the merged (defaults + DB) topic set. Cheap shallow copy + one mutation.
function buildTools() {
  const topics = listAppHelpTopics();
  return TOOLS_STATIC.map(t => {
    if (t.name !== 'get_app_help') return t;
    return {
      ...t,
      input_schema: {
        ...t.input_schema,
        properties: {
          ...t.input_schema.properties,
          topic: { type: 'string', description: topics.join(' | ') },
        },
      },
    };
  });
}

// ── Tool dispatch ──
// Each handler returns a JSON-serialisable value. They're synchronous
// SQLite queries so the whole loop runs in <100 ms even with several
// tool calls. Keep return payloads small (≤80 rows) so we don't blow
// the model context.
function periodToWhere(period, dateCol = 'date') {
  const subtract = days => new Date(Date.now() - days*86400000).toISOString().slice(0,10);
  switch (period) {
    case 'last_7':     return { where: `${dateCol} >= ?`, args: [subtract(7)],  label: 'last 7 days' };
    case 'last_30':    return { where: `${dateCol} >= ?`, args: [subtract(30)], label: 'last 30 days' };
    case 'last_90':    return { where: `${dateCol} >= ?`, args: [subtract(90)], label: 'last 90 days' };
    case 'last_180':   return { where: `${dateCol} >= ?`, args: [subtract(180)],label: 'last 180 days' };
    case 'this_month': { const d=new Date(); const s=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; return { where: `${dateCol} >= ?`, args:[s], label:'this month' }; }
    case 'this_year':  { const y=new Date().getFullYear(); return { where: `${dateCol} >= ?`, args:[`${y}-01-01`], label:'this year' }; }
    case 'all':
    default:           return { where: `1=1`, args: [], label: 'all time' };
  }
}

const TOOL_HANDLERS = {
  query_sales: ({ period='last_30', channel, group_by='channel', limit=50 }) => {
    const { where, args } = periodToWhere(period);
    let sql, params;
    if (group_by === 'day' || group_by === 'month') {
      const expr = group_by === 'day' ? 'date' : "substr(date,1,7)";
      sql = `SELECT ${expr} AS bucket,
               SUM(qty) AS units, SUM(total) AS revenue, COUNT(*) AS txns
             FROM sales_entries WHERE ${where}
             ${channel ? 'AND channel = ?' : ''}
             GROUP BY bucket ORDER BY bucket DESC LIMIT ?`;
      params = [...args, ...(channel?[channel]:[]), limit];
    } else if (group_by === 'product') {
      sql = `SELECT product_id, COALESCE(product_name,'(unknown)') AS name,
               SUM(qty) AS units, SUM(total) AS revenue, COUNT(*) AS txns
             FROM sales_entries WHERE ${where}
             ${channel ? 'AND channel = ?' : ''}
             GROUP BY product_id, product_name
             ORDER BY revenue DESC LIMIT ?`;
      params = [...args, ...(channel?[channel]:[]), limit];
    } else {
      sql = `SELECT channel, SUM(qty) AS units, SUM(total) AS revenue, COUNT(*) AS txns
             FROM sales_entries WHERE ${where}
             GROUP BY channel ORDER BY revenue DESC LIMIT ?`;
      params = [...args, limit];
    }
    return { rows: db.prepare(sql).all(...params) };
  },

  top_movers: ({ period='last_30', rank_by='revenue', channel, limit=10 }) => {
    const { where, args } = periodToWhere(period);
    const sql = `SELECT product_id, COALESCE(product_name,'(unknown)') AS name,
                   SUM(qty) AS units, SUM(total) AS revenue, COUNT(*) AS txns
                 FROM sales_entries WHERE ${where} AND product_id IS NOT NULL
                 ${channel ? 'AND channel = ?' : ''}
                 GROUP BY product_id, product_name
                 ORDER BY ${rank_by === 'units' ? 'units' : 'revenue'} DESC
                 LIMIT ?`;
    return { rows: db.prepare(sql).all(...args, ...(channel?[channel]:[]), limit) };
  },

  compare_periods: ({ period_a, period_b, channel }) => {
    // Period can be YYYY-MM (whole month) or YYYY-MM-DD..YYYY-MM-DD.
    function periodFilter(p) {
      if (/^\d{4}-\d{2}$/.test(p)) return { where: `substr(date,1,7) = ?`, args: [p] };
      const m = p.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
      if (m) return { where: `date >= ? AND date <= ?`, args: [m[1], m[2]] };
      return { where: `1=0`, args: [] };
    }
    const a = periodFilter(period_a);
    const b = periodFilter(period_b);
    const get = ({ where, args }) => {
      const sql = `SELECT SUM(total) AS revenue, SUM(qty) AS units, COUNT(*) AS txns
                   FROM sales_entries WHERE ${where} ${channel ? 'AND channel = ?' : ''}`;
      return db.prepare(sql).get(...args, ...(channel?[channel]:[]));
    };
    const A = get(a), B = get(b);
    const pct = (n,d) => d ? Math.round(((n - d)/d)*1000)/10 : null;
    return {
      period_a: { id: period_a, ...A },
      period_b: { id: period_b, ...B },
      delta_revenue_pct: pct(B.revenue||0, A.revenue||0),
      delta_units_pct:   pct(B.units||0,   A.units||0),
      delta_txns_pct:    pct(B.txns||0,    A.txns||0),
    };
  },

  find_product: ({ query }) => {
    const q = (query||'').trim();
    if (!q) return { error: 'query required' };
    let row = null;
    if (/^\d+$/.test(q)) row = db.prepare('SELECT * FROM products WHERE id = ? AND COALESCE(is_active,1)=1').get(parseInt(q,10));
    if (!row) row = db.prepare('SELECT * FROM products WHERE LOWER(sku)=LOWER(?) AND COALESCE(is_active,1)=1').get(q);
    if (!row) row = db.prepare(`SELECT * FROM products WHERE COALESCE(is_active,1)=1
                                AND (name_en LIKE ? OR name_cn LIKE ?) ORDER BY name_en LIMIT 1`)
                       .get('%'+q+'%','%'+q+'%');
    return row ? { product: { id: row.id, name_en: row.name_en, name_cn: row.name_cn, sku: row.sku, category: row.category, status: row.status, sell_price: row.sell_price, stock_qty: row.stock_qty, recipe_id: row.recipe_id, barcode: row.barcode, variant_label: row.variant_label } }
               : { not_found: true };
  },

  find_ingredient: ({ query }) => {
    const q = (query||'').trim();
    if (!q) return { error: 'query required' };
    let row = null;
    if (/^\d+$/.test(q)) row = db.prepare('SELECT * FROM ingredients WHERE id = ? AND COALESCE(is_active,1)=1').get(parseInt(q,10));
    if (!row) row = db.prepare('SELECT * FROM ingredients WHERE LOWER(sku)=LOWER(?) AND COALESCE(is_active,1)=1').get(q);
    if (!row) row = db.prepare(`SELECT * FROM ingredients WHERE COALESCE(is_active,1)=1
                                AND (name_en LIKE ? OR name_cn LIKE ?) ORDER BY name_en LIMIT 1`)
                       .get('%'+q+'%','%'+q+'%');
    if (!row) return { not_found: true };
    return { ingredient: {
      id: row.id, name_en: row.name_en, name_cn: row.name_cn, sku: row.sku,
      category: row.category, item_kind: row.item_kind, allergens: row.allergens,
      buy_price: row.buy_price, buy_unit: row.buy_unit, cost_per_unit: row.cost_per_unit,
    }};
  },

  get_recipe_cost: ({ recipe_id, recipe_name }) => {
    let recipe;
    if (recipe_id) recipe = db.prepare('SELECT * FROM recipes WHERE id = ? AND COALESCE(is_active,1)=1').get(recipe_id);
    else if (recipe_name) recipe = db.prepare(`SELECT * FROM recipes WHERE COALESCE(is_active,1)=1
        AND (LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ?) LIMIT 1`).get('%'+recipe_name+'%', '%'+recipe_name+'%');
    if (!recipe) return { not_found: true };
    const lines = db.prepare(`SELECT ri.qty, ri.unit, ri.ingredient_id, ing.name_en, ing.name_cn,
                                       ing.cost_per_unit, ing.buy_unit
                                FROM recipe_ingredients ri
                                JOIN ingredients ing ON ing.id = ri.ingredient_id
                               WHERE ri.recipe_id = ?`).all(recipe.id);
    // Best-effort cost: line cost = qty × cost_per_unit when units match.
    const breakdown = lines.map(l => {
      const cost = (parseFloat(l.qty)||0) * (parseFloat(l.cost_per_unit)||0);
      return { ingredient_id: l.ingredient_id, name: l.name_en || l.name_cn, qty: l.qty, unit: l.unit, line_cost: +cost.toFixed(2) };
    });
    const total = breakdown.reduce((s,b)=>s + (b.line_cost||0), 0);
    const servings = recipe.servings || 1;
    return {
      recipe: { id: recipe.id, name_en: recipe.name_en, name_cn: recipe.name_cn, sku: recipe.sku, servings },
      breakdown,
      total_cost: +total.toFixed(2),
      cost_per_serving: +(total / servings).toFixed(2),
    };
  },

  find_recipes_using: ({ ingredient_id, ingredient_name }) => {
    let id = ingredient_id;
    if (!id && ingredient_name) {
      const ing = db.prepare(`SELECT id FROM ingredients WHERE LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ? LIMIT 1`)
                    .get('%'+ingredient_name+'%','%'+ingredient_name+'%');
      if (ing) id = ing.id;
    }
    if (!id) return { not_found: true };
    const rows = db.prepare(`SELECT r.id, r.name_en, r.name_cn, r.sku, ri.qty, ri.unit
                              FROM recipe_ingredients ri
                              JOIN recipes r ON r.id = ri.recipe_id
                             WHERE ri.ingredient_id = ? AND COALESCE(r.is_active,1)=1
                             ORDER BY r.name_en`).all(id);
    return { ingredient_id: id, count: rows.length, recipes: rows };
  },

  query_purchases: ({ supplier, status, days=60, ingredient_name, limit=30 }) => {
    const args = [new Date(Date.now()-days*86400000).toISOString().slice(0,10)];
    let sql = `SELECT po.id, po.po_number, po.date, po.status, po.supplier,
                      po.notes, po.created_at,
                      (SELECT COUNT(*) FROM po_line_items WHERE po_id=po.id) AS line_count
               FROM purchase_orders po
               WHERE po.date >= ?`;
    if (supplier) { sql += ' AND LOWER(po.supplier) LIKE LOWER(?)'; args.push('%'+supplier+'%'); }
    if (status)   { sql += ' AND po.status = ?'; args.push(status); }
    if (ingredient_name) {
      sql += ` AND po.id IN (SELECT po_id FROM po_line_items
                              WHERE LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ?)`;
      args.push('%'+ingredient_name+'%','%'+ingredient_name+'%');
    }
    sql += ' ORDER BY po.date DESC, po.id DESC LIMIT ?';
    args.push(limit);
    return { rows: db.prepare(sql).all(...args) };
  },

  price_history: ({ ingredient_id, ingredient_name, days=180 }) => {
    let id = ingredient_id;
    let ing;
    if (!id && ingredient_name) {
      ing = db.prepare(`SELECT id, name_en, name_cn, buy_price, buy_unit FROM ingredients
                        WHERE LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ? LIMIT 1`)
              .get('%'+ingredient_name+'%','%'+ingredient_name+'%');
      if (ing) id = ing.id;
    } else if (id) {
      ing = db.prepare('SELECT id, name_en, name_cn, buy_price, buy_unit FROM ingredients WHERE id = ?').get(id);
    }
    if (!id || !ing) return { not_found: true };
    const since = new Date(Date.now()-days*86400000).toISOString().slice(0,10);
    const history = db.prepare(`SELECT created_at, price, buy_unit, source
                                  FROM ingredient_price_history
                                 WHERE ingredient_id = ? AND created_at >= ?
                                 ORDER BY created_at`).all(id, since);
    return { ingredient: ing, history };
  },

  current_stock: ({ max_stock, category, limit=30 }) => {
    let sql = `SELECT id, name_en, name_cn, sku, category, sell_price, stock_qty, status
                FROM products
               WHERE COALESCE(is_active,1)=1 AND status = 'Active'`;
    const args = [];
    if (max_stock != null) { sql += ' AND COALESCE(stock_qty,0) <= ?'; args.push(max_stock); }
    if (category)          { sql += ' AND category = ?'; args.push(category); }
    sql += ' ORDER BY COALESCE(stock_qty,0) ASC LIMIT ?';
    args.push(limit);
    return { rows: db.prepare(sql).all(...args) };
  },

  expiring_lots: ({ days=14 }) => {
    const today = new Date().toISOString().slice(0,10);
    const cutoff = new Date(Date.now()+days*86400000).toISOString().slice(0,10);
    const rows = db.prepare(`SELECT pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit,
                                    pli.lot_number, pli.expiry_date, po.po_number, po.id AS po_id
                              FROM po_line_items pli
                              JOIN purchase_orders po ON po.id = pli.po_id
                             WHERE pli.expiry_date IS NOT NULL
                               AND pli.expiry_date <= ?
                               AND po.status IN ('Delivered','Confirmed')
                             ORDER BY pli.expiry_date ASC LIMIT 50`).all(cutoff);
    const expired = rows.filter(r => r.expiry_date < today);
    const upcoming = rows.filter(r => r.expiry_date >= today);
    return { today, cutoff, expired, upcoming };
  },

  query_waste: ({ period='last_30', group_by='month' }) => {
    const { where, args } = periodToWhere(period);
    let sql, params;
    if (group_by === 'day' || group_by === 'month') {
      const expr = group_by === 'day' ? 'date' : "substr(date,1,7)";
      sql = `SELECT ${expr} AS bucket, SUM(cost_lost) AS cost_lost, SUM(qty) AS qty,
               COUNT(*) AS entries
             FROM waste_entries WHERE ${where}
             GROUP BY bucket ORDER BY bucket DESC LIMIT 50`;
      params = args;
    } else if (group_by === 'reason') {
      sql = `SELECT COALESCE(reason,'(unspecified)') AS reason,
               SUM(cost_lost) AS cost_lost, SUM(qty) AS qty, COUNT(*) AS entries
             FROM waste_entries WHERE ${where}
             GROUP BY reason ORDER BY cost_lost DESC LIMIT 50`;
      params = args;
    } else {
      sql = `SELECT COALESCE(product_name,'(unknown)') AS name,
               SUM(cost_lost) AS cost_lost, SUM(qty) AS qty, COUNT(*) AS entries
             FROM waste_entries WHERE ${where}
             GROUP BY product_name ORDER BY cost_lost DESC LIMIT 50`;
      params = args;
    }
    return { rows: db.prepare(sql).all(...params) };
  },

  get_alerts: () => {
    const priceAlerts = db.prepare(`SELECT a.id, a.old_price, a.new_price, a.change_pct,
        i.name_en, i.name_cn FROM price_alerts a
        LEFT JOIN ingredients i ON i.id = a.ingredient_id
        WHERE a.is_read = 0 ORDER BY a.created_at DESC LIMIT 20`).all();
    const outOfStock = db.prepare(`SELECT name_en, name_cn, sku FROM products
        WHERE COALESCE(stock_qty,0)=0 AND status='Active' AND COALESCE(is_active,1)=1
        ORDER BY name_en LIMIT 30`).all();
    const lowStock = db.prepare(`SELECT name_en, name_cn, sku, stock_qty FROM products
        WHERE COALESCE(stock_qty,0) BETWEEN 1 AND 5 AND status='Active' AND COALESCE(is_active,1)=1
        ORDER BY stock_qty ASC LIMIT 30`).all();
    return { priceAlerts, outOfStock, lowStock };
  },

  get_app_help: ({ topic }, ctx) => {
    const key = (topic || '').toString().toLowerCase().trim();
    // DB overrides win — admin-authored content is fresher than the hardcoded
    // defaults that ship with the deploy.
    const dbRow = db.prepare('SELECT content FROM ai_app_help WHERE topic = ? AND COALESCE(is_active,1)=1').get(key);
    const content = (dbRow && dbRow.content) || APP_HELP[key];
    if (content) return { topic: key, content, source: dbRow ? 'admin-authored' : 'default' };
    // Topic miss — log to ai_app_help_misses so the admin sees what Sprout
    // was asked for but couldn't answer. Idempotent upsert: hit_count++ on
    // every miss, last_at refreshed, last_user_id captures who triggered it.
    try {
      db.prepare(`INSERT INTO ai_app_help_misses (topic, hit_count, last_user_id, last_at)
                    VALUES (?, 1, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(topic) DO UPDATE SET
                    hit_count = hit_count + 1,
                    last_user_id = excluded.last_user_id,
                    last_at = CURRENT_TIMESTAMP,
                    resolved = 0`).run(key, (ctx && ctx.user_id) || null);
    } catch (e) { /* logging is best-effort; never break the agent on a write fail */ }
    return {
      error: 'unknown topic: ' + key,
      available_topics: listAppHelpTopics(),
    };
  },

  // ── compute_margin ──
  // Sell price comes from products. Cost comes from the linked recipe's
  // ingredients × current buy prices. Returns the breakdown so the agent
  // can explain margin moves with specific drivers.
  compute_margin: ({ product_id, product_name }) => {
    let p = null;
    if (product_id)        p = db.prepare('SELECT * FROM products WHERE id = ? AND COALESCE(is_active,1)=1').get(product_id);
    else if (product_name) p = db.prepare(`SELECT * FROM products WHERE COALESCE(is_active,1)=1
        AND (LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ?) LIMIT 1`).get('%'+product_name+'%','%'+product_name+'%');
    if (!p) return { not_found: true };
    const sell = parseFloat(p.sell_price) || 0;
    if (!sell) return { product: { id: p.id, name_en: p.name_en, name_cn: p.name_cn }, error: 'no sell_price set' };
    if (!p.recipe_id) return {
      product: { id: p.id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku, sell_price: sell },
      note: 'No linked recipe — cost cannot be derived. Margin computed only when a recipe is linked.',
    };
    const recipe = db.prepare('SELECT id, name_en, servings, batch_size FROM recipes WHERE id = ?').get(p.recipe_id);
    const lines = db.prepare(`SELECT ri.qty, ri.unit, ri.ingredient_id, ing.name_en, ing.name_cn,
                                       ing.cost_per_unit, ing.buy_unit
                                FROM recipe_ingredients ri
                                JOIN ingredients ing ON ing.id = ri.ingredient_id
                               WHERE ri.recipe_id = ?`).all(recipe.id);
    const breakdown = lines.map(l => {
      const cost = (parseFloat(l.qty) || 0) * (parseFloat(l.cost_per_unit) || 0);
      return { ingredient_id: l.ingredient_id, name: l.name_en || l.name_cn, qty: l.qty, unit: l.unit,
               cost_per_unit: l.cost_per_unit, line_cost: +cost.toFixed(4) };
    });
    const totalRecipeCost = breakdown.reduce((s, b) => s + (b.line_cost || 0), 0);
    const servings = recipe.servings || 1;
    const cost_per_serving = totalRecipeCost / servings;
    const grossMarginPct = sell > 0 ? ((sell - cost_per_serving) / sell) * 100 : 0;
    const foodCostPct = sell > 0 ? (cost_per_serving / sell) * 100 : 0;
    // Find the recently-moved ingredient(s) — useful for "why did margin
    // drop?" reasoning. Look back 90d in price history.
    const since = new Date(Date.now() - 90*86400000).toISOString();
    const movers = db.prepare(`SELECT iph.ingredient_id, ing.name_en, ing.name_cn,
        MIN(iph.price) AS min_price, MAX(iph.price) AS max_price,
        (SELECT price FROM ingredient_price_history WHERE ingredient_id = iph.ingredient_id ORDER BY created_at ASC LIMIT 1) AS earliest_price,
        (SELECT price FROM ingredient_price_history WHERE ingredient_id = iph.ingredient_id ORDER BY created_at DESC LIMIT 1) AS latest_price,
        COUNT(*) AS price_points
      FROM ingredient_price_history iph
      JOIN ingredients ing ON ing.id = iph.ingredient_id
      WHERE iph.ingredient_id IN (${lines.map(() => '?').join(',') || '0'})
        AND iph.created_at >= ?
      GROUP BY iph.ingredient_id
      HAVING earliest_price > 0 AND ABS((latest_price - earliest_price) / earliest_price) >= 0.05
      ORDER BY ABS((latest_price - earliest_price) / earliest_price) DESC`)
      .all(...lines.map(l => l.ingredient_id), since);
    const recent_movers = movers.map(m => ({
      ingredient_id: m.ingredient_id, name: m.name_en || m.name_cn,
      from: +m.earliest_price.toFixed(4), to: +m.latest_price.toFixed(4),
      change_pct: +(((m.latest_price - m.earliest_price) / m.earliest_price) * 100).toFixed(1),
      price_points: m.price_points,
    }));
    return {
      product: { id: p.id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku },
      recipe: { id: recipe.id, name_en: recipe.name_en, servings },
      sell_price: sell,
      total_recipe_cost: +totalRecipeCost.toFixed(2),
      cost_per_serving: +cost_per_serving.toFixed(4),
      gross_margin_pct: +grossMarginPct.toFixed(1),
      food_cost_pct: +foodCostPct.toFixed(1),
      ingredient_breakdown: breakdown,
      recent_movers, // ingredients whose price moved ≥5% in last 90d
    };
  },

  // ── find_anomalies ──
  // Z-score over a rolling baseline. Returns buckets where the metric is
  // ≥1.5σ from mean. Cheap to compute, surfaces real spikes/dips.
  find_anomalies: ({ metric = 'revenue', period = 'last_60', bucket = 'day', channel }) => {
    const { where, args } = periodToWhere(period);
    let metricExpr;
    let table = 'sales_entries';
    if (metric === 'revenue')   metricExpr = 'SUM(total)';
    else if (metric === 'units') metricExpr = 'SUM(qty)';
    else if (metric === 'txns')  metricExpr = 'COUNT(*)';
    else if (metric === 'waste_cost') { table = 'waste_entries'; metricExpr = 'SUM(cost_lost)'; }
    else return { error: 'unknown metric: ' + metric };
    const expr = bucket === 'week' ? "strftime('%Y-W%W', date)" : 'date';
    let sql = `SELECT ${expr} AS bucket, ${metricExpr} AS value, COUNT(*) AS n
               FROM ${table} WHERE ${where}`;
    const params = [...args];
    if (channel && table === 'sales_entries') { sql += ' AND channel = ?'; params.push(channel); }
    sql += ' GROUP BY bucket ORDER BY bucket';
    const rows = db.prepare(sql).all(...params);
    if (rows.length < 5) return { rows: [], note: 'Not enough data to detect anomalies (need ≥5 buckets)' };
    const values = rows.map(r => +r.value || 0);
    const mean   = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const stddev  = Math.sqrt(variance);
    const anomalies = rows.map(r => {
      const z = stddev > 0 ? ((+r.value - mean) / stddev) : 0;
      return { bucket: r.bucket, value: +(+r.value).toFixed(2), z_score: +z.toFixed(2),
               direction: z > 0 ? 'spike' : 'dip' };
    }).filter(r => Math.abs(r.z_score) >= 1.5);
    return {
      metric, period, bucket, channel: channel || null,
      baseline_mean: +mean.toFixed(2), baseline_stddev: +stddev.toFixed(2),
      n_buckets: rows.length,
      anomalies,
    };
  },

  // ── usage_velocity ──
  // Estimates ingredient consumption rate from production batches over
  // the last N days, weighted by each recipe's qty for this ingredient.
  // Returns days_of_stock based on current ingredient stock (where known).
  usage_velocity: ({ ingredient_id, ingredient_name, days = 30 }) => {
    let id = ingredient_id;
    let ing;
    if (!id && ingredient_name) {
      ing = db.prepare(`SELECT * FROM ingredients WHERE LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ? LIMIT 1`)
              .get('%'+ingredient_name+'%','%'+ingredient_name+'%');
      if (ing) id = ing.id;
    } else if (id) {
      ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
    }
    if (!id || !ing) return { not_found: true };
    const since = new Date(Date.now() - days*86400000).toISOString().slice(0, 10);
    // Sum of (recipe qty for this ing) × (production batches × batch_size).
    // Some recipes don't have batch_size set — treat as 1.
    const usage = db.prepare(`
      SELECT pb.recipe_id, r.name_en AS recipe_name, ri.qty AS qty_per_batch_unit,
             ri.unit, COALESCE(r.batch_size, 1) AS batch_size,
             SUM(pb.batches_made) AS total_batches
        FROM production_batches pb
        JOIN recipes r           ON r.id = pb.recipe_id
        JOIN recipe_ingredients ri ON ri.recipe_id = pb.recipe_id
       WHERE ri.ingredient_id = ?
         AND pb.date >= ?
       GROUP BY pb.recipe_id`).all(id, since);
    const lines = usage.map(u => ({
      recipe_id: u.recipe_id,
      recipe_name: u.recipe_name,
      total_batches: +u.total_batches,
      qty_per_batch: (+u.qty_per_batch_unit) * (+u.batch_size),
      total_used: +((+u.qty_per_batch_unit) * (+u.batch_size) * (+u.total_batches)).toFixed(3),
      unit: u.unit || ing.buy_unit,
    }));
    const totalUsed = lines.reduce((s, l) => s + (l.total_used || 0), 0);
    const usagePerDay = days > 0 ? totalUsed / days : 0;
    // Days of stock remaining — only meaningful if the ingredient tracks
    // a stock_qty (most don't on Roots' setup). Skip if unset.
    const result = {
      ingredient: { id: ing.id, name_en: ing.name_en, name_cn: ing.name_cn, buy_unit: ing.buy_unit, buy_price: ing.buy_price },
      lookback_days: days,
      total_used: +totalUsed.toFixed(3),
      usage_per_day: +usagePerDay.toFixed(3),
      driving_recipes: lines.sort((a, b) => b.total_used - a.total_used),
    };
    return result;
  },

  // ── find_underperformers ──
  // Active products selling below `max_units` over the period. Adds
  // last-sold date and age-in-catalog so the agent can distinguish "new
  // and slow" from "old and dead".
  find_underperformers: ({ period = 'last_90', max_units = 10, limit = 20 }) => {
    const { where, args } = periodToWhere(period);
    const sql = `SELECT
        p.id, p.name_en, p.name_cn, p.sku, p.category, p.sell_price, p.created_at AS catalog_added,
        COALESCE(s.units, 0) AS units, COALESCE(s.revenue, 0) AS revenue,
        s.last_sold,
        CAST((julianday('now') - julianday(p.created_at)) AS INTEGER) AS age_days
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(qty) AS units, SUM(total) AS revenue, MAX(date) AS last_sold
        FROM sales_entries WHERE ${where} AND product_id IS NOT NULL GROUP BY product_id
      ) s ON s.product_id = p.id
      WHERE COALESCE(p.is_active, 1) = 1 AND p.status = 'Active'
        AND COALESCE(s.units, 0) < ?
      ORDER BY units ASC, age_days DESC
      LIMIT ?`;
    const rows = db.prepare(sql).all(...args, max_units, limit);
    return { period, threshold_units_below: max_units, count: rows.length, products: rows };
  },

  // ── daily_brief ──
  // Composite executive summary. Pulls top concerns from price alerts,
  // stock levels, expiring lots, sales anomalies. Returns categorised
  // findings with severity so the agent can rank when surfacing.
  // ── database_overview ──
  // High-level counts so "how many X?" questions answer instantly. Cheap
  // — every count is a single COUNT(*) query.
  database_overview: () => {
    const cnt = (sql) => { try { return db.prepare(sql).get().c; } catch { return null; } };
    const counts = {
      recipes_active:           cnt(`SELECT COUNT(*) AS c FROM recipes WHERE COALESCE(is_active,1)=1`),
      recipes_total:            cnt(`SELECT COUNT(*) AS c FROM recipes`),
      products_active:          cnt(`SELECT COUNT(*) AS c FROM products WHERE COALESCE(is_active,1)=1 AND status='Active'`),
      products_total:           cnt(`SELECT COUNT(*) AS c FROM products WHERE COALESCE(is_active,1)=1`),
      products_with_recipe_link:cnt(`SELECT COUNT(*) AS c FROM products WHERE COALESCE(is_active,1)=1 AND recipe_id IS NOT NULL`),
      ingredients_active:       cnt(`SELECT COUNT(*) AS c FROM ingredients WHERE COALESCE(is_active,1)=1`),
      ingredients_total:        cnt(`SELECT COUNT(*) AS c FROM ingredients`),
      suppliers:                cnt(`SELECT COUNT(*) AS c FROM suppliers`),
      purchase_orders_total:    cnt(`SELECT COUNT(*) AS c FROM purchase_orders`),
      purchase_orders_open:     cnt(`SELECT COUNT(*) AS c FROM purchase_orders WHERE status IN ('Requested','Ordered')`),
      sales_entries_total:      cnt(`SELECT COUNT(*) AS c FROM sales_entries`),
      sales_entries_30d:        cnt(`SELECT COUNT(*) AS c FROM sales_entries WHERE date >= date('now','-30 days')`),
      waste_entries_total:      cnt(`SELECT COUNT(*) AS c FROM waste_entries`),
      production_batches_30d:   cnt(`SELECT COUNT(*) AS c FROM production_batches WHERE date >= date('now','-30 days')`),
      markets_active:           cnt(`SELECT COUNT(*) AS c FROM markets WHERE COALESCE(is_active,1)=1`),
      restock_orders_total:     cnt(`SELECT COUNT(*) AS c FROM restock_orders`),
      users_active:             cnt(`SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_active,1)=1`),
    };
    return { counts, generated_at: new Date().toISOString() };
  },

  list_recipes: ({ category, search, limit = 200 } = {}) => {
    let sql = `SELECT id, name_en, name_cn, sku, category, batch_size, servings,
                      created_at, updated_at
                 FROM recipes
                WHERE COALESCE(is_active,1) = 1`;
    const args = [];
    if (category) { sql += ' AND category = ?'; args.push(category); }
    if (search)   { sql += ' AND (LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ? OR LOWER(sku) LIKE LOWER(?))';
                    args.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
    sql += ' ORDER BY name_en LIMIT ?'; args.push(Math.min(limit, 500));
    const rows = db.prepare(sql).all(...args);
    // Also report categories so the agent can suggest filters.
    const cats = db.prepare(`SELECT category, COUNT(*) AS c FROM recipes
        WHERE COALESCE(is_active,1)=1 AND category IS NOT NULL AND category != ''
        GROUP BY category ORDER BY c DESC`).all();
    return { count: rows.length, recipes: rows, categories_in_use: cats };
  },

  list_products: ({ category, status, search, limit = 200 } = {}) => {
    let sql = `SELECT id, name_en, name_cn, sku, category, sell_price, stock_qty,
                      status, recipe_id, barcode, variant_label
                 FROM products
                WHERE COALESCE(is_active,1) = 1`;
    const args = [];
    if (status)        { sql += ' AND status = ?'; args.push(status); }
    else               { sql += " AND status = 'Active'"; }
    if (category)      { sql += ' AND category = ?'; args.push(category); }
    if (search)        { sql += ' AND (LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ? OR LOWER(sku) LIKE LOWER(?))';
                         args.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
    sql += ' ORDER BY name_en LIMIT ?'; args.push(Math.min(limit, 500));
    const rows = db.prepare(sql).all(...args);
    const cats = db.prepare(`SELECT category, COUNT(*) AS c FROM products
        WHERE COALESCE(is_active,1)=1 AND status='Active' AND category IS NOT NULL AND category != ''
        GROUP BY category ORDER BY c DESC`).all();
    return { count: rows.length, products: rows, categories_in_use: cats };
  },

  list_ingredients: ({ category, item_kind, search, limit = 200 } = {}) => {
    let sql = `SELECT id, name_en, name_cn, sku, category, item_kind, allergens,
                      buy_price, buy_unit, cost_per_unit, supplier_default
                 FROM ingredients
                WHERE COALESCE(is_active,1) = 1`;
    const args = [];
    if (category)  { sql += ' AND category = ?'; args.push(category); }
    if (item_kind) { sql += ' AND item_kind = ?'; args.push(item_kind); }
    if (search)    { sql += ' AND (LOWER(name_en) LIKE LOWER(?) OR name_cn LIKE ? OR LOWER(sku) LIKE LOWER(?))';
                     args.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
    sql += ' ORDER BY name_en LIMIT ?'; args.push(Math.min(limit, 500));
    const rows = db.prepare(sql).all(...args);
    const cats = db.prepare(`SELECT category, COUNT(*) AS c FROM ingredients
        WHERE COALESCE(is_active,1)=1 AND category IS NOT NULL AND category != ''
        GROUP BY category ORDER BY c DESC`).all();
    return { count: rows.length, ingredients: rows, categories_in_use: cats };
  },

  list_suppliers: ({ search, limit = 100 } = {}) => {
    let sql = `SELECT id, name, contact, products_supplied, payment_terms, notes,
                      created_at,
                      (SELECT MAX(date) FROM purchase_orders WHERE supplier = suppliers.name) AS last_po_date,
                      (SELECT COUNT(*)  FROM purchase_orders WHERE supplier = suppliers.name) AS po_count
                 FROM suppliers`;
    const args = [];
    if (search) { sql += ' WHERE LOWER(name) LIKE LOWER(?)'; args.push('%'+search+'%'); }
    sql += ' ORDER BY name LIMIT ?'; args.push(Math.min(limit, 500));
    const rows = db.prepare(sql).all(...args);
    return { count: rows.length, suppliers: rows };
  },

  list_markets: () => {
    const rows = db.prepare(`SELECT id, name, name_cn, location, lat, lng, is_active,
                                    created_at,
        (SELECT COUNT(DISTINCT id) FROM sales_entries WHERE channel='markets'
           AND notes LIKE '%[markets:txn:%:' || markets.id || ']%'
           AND date >= date('now','-30 days')) AS sales_rows_30d,
        (SELECT COALESCE(SUM(total),0) FROM sales_entries WHERE channel='markets'
           AND notes LIKE '%[markets:txn:%:' || markets.id || ']%'
           AND date >= date('now','-30 days')) AS revenue_30d
      FROM markets ORDER BY name`).all();
    return { count: rows.length, markets: rows };
  },

  daily_brief: () => {
    const today = new Date().toISOString().slice(0, 10);
    // 1. Price alerts (unread, ≥5% delta)
    const priceAlerts = db.prepare(`SELECT a.id, a.old_price, a.new_price, a.change_pct,
        i.name_en, i.name_cn, i.id AS ing_id
        FROM price_alerts a
        LEFT JOIN ingredients i ON i.id = a.ingredient_id
        WHERE a.is_read = 0 ORDER BY ABS(a.change_pct) DESC LIMIT 8`).all();
    // 2. Stock-outs (active products at 0)
    const outOfStock = db.prepare(`SELECT id, name_en, name_cn, sku, category FROM products
        WHERE COALESCE(stock_qty,0)=0 AND status='Active' AND COALESCE(is_active,1)=1
        ORDER BY name_en LIMIT 15`).all();
    // 3. Low stock (1-5 units)
    const lowStock = db.prepare(`SELECT id, name_en, name_cn, sku, stock_qty FROM products
        WHERE COALESCE(stock_qty,0) BETWEEN 1 AND 5 AND status='Active' AND COALESCE(is_active,1)=1
        ORDER BY stock_qty ASC LIMIT 15`).all();
    // 4. Expiring lots (next 7 days + already expired in last 7)
    const sevenDays = new Date(Date.now() + 7*86400000).toISOString().slice(0, 10);
    const expiringLots = db.prepare(`SELECT pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit,
        pli.lot_number, pli.expiry_date, po.po_number,
        (julianday(pli.expiry_date) - julianday('now')) AS days_left
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
      WHERE pli.expiry_date IS NOT NULL AND pli.expiry_date <= ?
        AND po.status IN ('Delivered','Confirmed')
      ORDER BY pli.expiry_date ASC LIMIT 15`).all(sevenDays);
    // 5. Stale kitchen orders (Requested >3 days)
    const staleKitchenOrders = db.prepare(`SELECT po_number, date, notes,
        (julianday('now') - julianday(created_at)) AS age_days
      FROM purchase_orders
      WHERE source = 'kitchenOrder' AND status = 'Requested'
        AND created_at < datetime('now','-3 days')
      ORDER BY created_at ASC LIMIT 10`).all();
    // 6. Sales anomaly — yesterday's revenue vs 7-day rolling average
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yRev = db.prepare("SELECT COALESCE(SUM(total),0) AS r FROM sales_entries WHERE date = ?").get(yesterday).r;
    const baselineRows = db.prepare(`SELECT date, SUM(total) AS r FROM sales_entries
      WHERE date >= date('now','-14 days') AND date < ? GROUP BY date`).all(yesterday);
    const baselineAvg = baselineRows.length
      ? baselineRows.reduce((s, r) => s + (+r.r || 0), 0) / baselineRows.length
      : 0;
    const yRevDelta = baselineAvg > 0 ? ((yRev - baselineAvg) / baselineAvg) * 100 : 0;
    return {
      generated_at: new Date().toISOString(),
      today,
      counts: {
        price_alerts: priceAlerts.length,
        out_of_stock: outOfStock.length,
        low_stock: lowStock.length,
        expiring_lots: expiringLots.length,
        stale_kitchen_orders: staleKitchenOrders.length,
      },
      price_alerts: priceAlerts,
      out_of_stock: outOfStock,
      low_stock: lowStock,
      expiring_lots: expiringLots,
      stale_kitchen_orders: staleKitchenOrders,
      yesterday: {
        date: yesterday,
        revenue: +yRev.toFixed(2),
        baseline_14d_avg: +baselineAvg.toFixed(2),
        delta_pct: +yRevDelta.toFixed(1),
        is_anomaly: Math.abs(yRevDelta) > 25,
      },
    };
  },

  // Validates a swap proposal against the current draft + brand palette
  // and returns friendly labels for the UI. Does NOT mutate — the editor
  // applies the change when the owner clicks the surfaced "Apply" button.
  propose_design_swap: ({ page = 'home', block_id, field, new_token, reason_en, reason_cn } = {}) => {
    try {
      const ALLOWED_PAGES = new Set(['home','promotions','membership','categories','onboarding']);
      if (!ALLOWED_PAGES.has(page)) page = 'home';
      if (!block_id) return { error: 'missing_block_id' };
      if (!field) return { error: 'missing_field' };
      if (!new_token) return { error: 'missing_new_token' };

      const layoutKey = `cms.draft.${page}_layout`;
      let blocks = [];
      const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(layoutKey);
      if (row) { try { const v = JSON.parse(row.value_json); if (Array.isArray(v)) blocks = v; } catch {} }

      const block = blocks.find(b => b && b.id === block_id);
      if (!block) return { error: 'block_not_found', detail: `No block with id "${block_id}" on page "${page}".` };

      const fields = DC_FIELDS[block.type] || {};
      const knownFields = new Set(Object.values(fields));
      if (!knownFields.has(field)) {
        return { error: 'invalid_field_for_block', detail: `Block type "${block.type}" doesn't have a "${field}" colour field. Valid fields: ${[...knownFields].join(', ') || '(none)'}.` };
      }
      if (!DC_HEX[new_token]) {
        return { error: 'invalid_token', detail: `"${new_token}" is not in the brand palette. Pick one of: ${Object.keys(DC_HEX).join(', ')}.` };
      }

      const currentToken = block[field] ?? null;
      const blockLabel  = DC_BLOCK_LABELS[block.type] || { en: block.type, cn: block.type };
      const fieldLabel  = DC_FIELD_LABELS[field]      || { en: field, cn: field };
      const tokenLabel  = DC_TOKEN_LABELS[new_token]  || { en: new_token, cn: new_token };
      const currentLabel = currentToken && DC_TOKEN_LABELS[currentToken]
        ? DC_TOKEN_LABELS[currentToken]
        : (currentToken ? { en: currentToken, cn: currentToken } : { en: '(none — inherits page background)', cn: '(无 — 跟随页面背景)' });

      // Position in draft (1-indexed, only counting blocks with a known type)
      let position = 0;
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i] && blocks[i].type) {
          position += 1;
          if (blocks[i].id === block_id) break;
        }
      }

      return {
        ok: true,
        page,
        block_id,
        block_type: block.type,
        block_label_en: blockLabel.en,
        block_label_cn: blockLabel.cn,
        position,
        field,
        field_label_en: fieldLabel.en,
        field_label_cn: fieldLabel.cn,
        from_token: currentToken,
        from_token_label_en: currentLabel.en,
        from_token_label_cn: currentLabel.cn,
        from_hex: currentToken && DC_HEX[currentToken] ? DC_HEX[currentToken] : null,
        to_token: new_token,
        to_token_label_en: tokenLabel.en,
        to_token_label_cn: tokenLabel.cn,
        to_hex: DC_HEX[new_token],
        reason_en: reason_en || '',
        reason_cn: reason_cn || '',
      };
    } catch (err) {
      console.error('[propose_design_swap] failed:', err && err.stack || err);
      return { error: 'propose_swap_failed', message: (err && err.message) || String(err) };
    }
  },

  design_check: ({ page = 'home', use = 'draft' } = {}) => {
    try {
    const ALLOWED = new Set(['home','promotions','membership','categories','onboarding']);
    if (!ALLOWED.has(page)) page = 'home';
    const layoutKey = use === 'live' ? `${page}.layout` : `cms.draft.${page}_layout`;
    let blocks = [];
    try {
      const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(layoutKey);
      if (row) { const v = JSON.parse(row.value_json); if (Array.isArray(v)) blocks = v; }
    } catch {}

    // Read theme + tab-bar config off storefront_config. These are dotted
    // keys, each row carries its own JSON value (not nested under a parent).
    function readKey(k) {
      try {
        const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
        if (!r) return null;
        return JSON.parse(r.value_json);
      } catch { return null; }
    }
    const pageBgToken = readKey('theme.page_bg');
    const tabBarCfg = {
      theme:         readKey('tabBar.theme') || 'oat',
      iconStyle:     readKey('tabBar.iconStyle') || 'outline',
      color:         readKey('tabBar.color') || '',
      selectedColor: readKey('tabBar.selectedColor') || '',
    };

    const result = runDesignCheck(blocks, pageBgToken, tabBarCfg);
    // Build a "palette catalog" Sprout can read off when phrasing
    // suggestions. Each entry has both the technical token (what the
    // editor stores) AND the friendly English/Chinese name + hue
    // description. Sprout MUST quote the token in code-style backticks
    // so the owner sees exactly what to pick in the editor, but can
    // refer to it in prose with the friendly name.
    const paletteCatalog = Object.entries(DC_HEX).map(([tok, hex]) => {
      const lbl = DC_TOKEN_LABELS[tok] || { en: tok, cn: tok, sub_en: '', sub_cn: '' };
      return {
        token: tok,
        hex,
        name_en: lbl.en,
        name_cn: lbl.cn,
        description_en: lbl.sub_en,
        description_cn: lbl.sub_cn,
        is_neutral: DC_NEUTRALS.has(tok),
      };
    });
    return {
      page, use,
      brand_palette: DC_HEX,           // kept for back-compat
      palette_catalog: paletteCatalog, // preferred — has friendly names
      neutral_tokens: [...DC_NEUTRALS],
      // Plain-English / 中文 names for every block type + colour field.
      // Sprout uses these when speaking to the owner — they read
      // "Hero banner's background" not "hero_banner.panel_bg_color".
      friendly_names: {
        blocks: DC_BLOCK_LABELS,
        fields: DC_FIELD_LABELS,
      },
      ...result,
    };
    } catch (err) {
      // Surface real diagnostics so Sprout (and the logs) see the actual
      // failure instead of hallucinating. The model's system prompt tells
      // it not to guess at causes when this field is present.
      console.error('[design_check] tool failed:', err && err.stack || err);
      return {
        error: 'design_check_failed',
        message: (err && err.message) || String(err),
        page, use,
      };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────
// DESIGN CHECK — server-side port of the rules engine that ships in
// public/cms.html. Sprout calls this when the admin asks for design
// review / palette suggestions. Keep the rules in sync with the JS
// version in cms.html (`dcRunChecks`, `DC_HEX`, `DC_FIELDS`) — both must
// agree on what counts as a "finding" or the count badge in /cms will
// disagree with what Sprout reports.
// ─────────────────────────────────────────────────────────────────────
const DC_HEX = {
  'lime-leaf': '#CCD900', 'forest-kale': '#365329', 'olive-moss': '#6A6E2D',
  'roasted-almond': '#C37F4E', 'golden-corn': '#F2CA6C', 'oat-milk': '#F2E7DF',
  'ink': '#1a1a17', 'pink-guava': '#F4B8CB', 'berry-punch': '#E96174',
  'carrot-blaze': '#FF6B0C', 'papaya-glow': '#FFAF60', 'skyberry': '#B2CFED',
  'lotus': '#EEB8E4', 'citrus-zest': '#E7E74C', 'pea-sprout': '#7BBD3B',
};
const DC_NEUTRALS = new Set(['oat-milk', 'ink']);
const DC_FIELDS = {
  announcement_bar: { bg: 'bg_color', fg: 'fg_color' },
  hero_banner:      { bg: 'panel_bg_color', fg: 'panel_fg_color' },
  featured_item:    { bg: 'card_bg_color', fg: 'card_fg_color' },
  product_grid:     { bg: 'bg_color' },
  category_tabs:    { accent: 'divider_color' },
  countdown_timer:  { bg: 'bg_color', fg: 'fg_color', accent: 'accent_color' },
  flash_sale_strip: { bg: 'bg_color', fg: 'fg_color' },
  coupon_block:     { bg: 'bg_color', fg: 'fg_color', accent: 'accent_color' },
  points_widget:    { bg: 'bg_color', fg: 'fg_color', accent: 'accent_color' },
  review_card:      { bg: 'bg_color', fg: 'fg_color' },
  store_info:       { bg: 'bg_color', fg: 'fg_color' },
  voting_block:     { bg: 'bg_color', fg: 'fg_color', accent: 'accent_color' },
  affiliate_block:  { bg: 'bg_color', fg: 'fg_color', accent: 'accent_color' },
  greeting:         { bg: 'bg_color', fg: 'fg_color', accent: 'accent_color' },
  recipe_story:     { bg: 'bg_color', fg: 'fg_color' },
  bundle:           { bg: 'bg_color', fg: 'fg_color' },
  wecom_contact:    { bg: 'bg_color', fg: 'fg_color' },
  favorites_block:  { bg: 'bg_color', fg: 'fg_color' },
};
// Plain-English (+ 中文) labels Sprout uses when writing back to the
// owner. They don't read field IDs like `panel_bg_color`; they read
// "background colour". Keep these in sync with BLOCK_META in cms.html.
const DC_BLOCK_LABELS = {
  announcement_bar: { en: 'Announcement bar',  cn: '顶部横幅' },
  hero_banner:      { en: 'Hero banner',       cn: '主图横幅' },
  category_tabs:    { en: 'Category tiles',    cn: '分类大图' },
  featured_item:    { en: 'Featured product',  cn: '主推商品' },
  product_grid:     { en: 'Product grid',      cn: '商品网格' },
  spacer:           { en: 'Spacer',            cn: '间隔' },
  countdown_timer:  { en: 'Countdown timer',   cn: '倒计时' },
  flash_sale_strip: { en: 'Flash sale',        cn: '秒杀栏' },
  coupon_block:     { en: 'Coupon',            cn: '优惠券' },
  points_widget:    { en: 'Points widget',     cn: '积分卡片' },
  review_card:      { en: 'Customer review',   cn: '顾客评论' },
  store_info:       { en: 'Store info',        cn: '门店信息' },
  voting_block:     { en: 'Voting block',      cn: '投票卡片' },
  affiliate_block:  { en: 'Refer a friend',    cn: '邀请有礼' },
  greeting:         { en: 'Greeting',          cn: '问候语' },
  recipe_story:     { en: 'Recipe story',      cn: '食谱故事' },
  bundle:           { en: 'Bundle',            cn: '组合购' },
  wecom_contact:    { en: 'Add us on WeCom',   cn: '企业微信卡片' },
  favorites_block:  { en: 'Favorites',         cn: '收藏夹' },
  order_tracker:    { en: 'Order tracker',     cn: '订单追踪' },
};
const DC_FIELD_LABELS = {
  bg_color:        { en: 'background colour',         cn: '背景色' },
  panel_bg_color:  { en: 'panel background',          cn: '面板背景色' },
  card_bg_color:   { en: 'card background',           cn: '卡片背景色' },
  fg_color:        { en: 'text colour',               cn: '文字颜色' },
  panel_fg_color:  { en: 'panel text colour',         cn: '面板文字颜色' },
  card_fg_color:   { en: 'card text colour',          cn: '卡片文字颜色' },
  accent_color:    { en: 'highlight colour',          cn: '强调色' },
  divider_color:   { en: 'divider colour',            cn: '分隔线颜色' },
  open_color:      { en: '"open" indicator colour',   cn: '营业中颜色' },
  closed_color:    { en: '"closed" indicator colour', cn: '休息中颜色' },
};
// Friendly names for the 14 brand palette tokens. Sprout uses these
// when speaking to non-designers — "Forest (deep green)" rather than
// "forest-kale (#365329)".
const DC_TOKEN_LABELS = {
  'lime-leaf':      { en: 'Lime',         cn: '青柠',  sub_en: 'bright yellow-green', sub_cn: '亮黄绿' },
  'forest-kale':    { en: 'Forest',       cn: '森林',  sub_en: 'deep green',          sub_cn: '深绿' },
  'olive-moss':     { en: 'Olive',        cn: '橄榄',  sub_en: 'muted olive',         sub_cn: '哑光橄榄' },
  'roasted-almond': { en: 'Almond',       cn: '杏仁',  sub_en: 'warm caramel',        sub_cn: '焦糖' },
  'golden-corn':    { en: 'Corn',         cn: '玉米',  sub_en: 'soft gold',           sub_cn: '柔金' },
  'oat-milk':       { en: 'Oat',          cn: '燕麦',  sub_en: 'warm cream (neutral)',sub_cn: '奶白(中性色)' },
  'ink':            { en: 'Ink',          cn: '墨黑',  sub_en: 'near-black (neutral)',sub_cn: '近黑(中性色)' },
  'pink-guava':     { en: 'Pink',         cn: '粉番石榴', sub_en: 'soft pink',        sub_cn: '柔粉' },
  'berry-punch':    { en: 'Berry',        cn: '莓红',  sub_en: 'bold red-pink',       sub_cn: '红莓' },
  'carrot-blaze':   { en: 'Carrot',       cn: '胡萝卜',sub_en: 'vivid orange',        sub_cn: '亮橙' },
  'papaya-glow':    { en: 'Papaya',       cn: '木瓜',  sub_en: 'warm peach',          sub_cn: '暖桃' },
  'skyberry':       { en: 'Sky',          cn: '天蓝',  sub_en: 'soft blue',           sub_cn: '柔蓝' },
  'lotus':          { en: 'Lotus',        cn: '莲花',  sub_en: 'soft lavender',       sub_cn: '紫丁香' },
  'citrus-zest':    { en: 'Citrus',       cn: '柑橘',  sub_en: 'bright yellow',       sub_cn: '亮黄' },
  'pea-sprout':     { en: 'Pea',          cn: '豌豆',  sub_en: 'fresh green',         sub_cn: '嫩绿' },
};
function dcResolveHex(val) {
  if (!val || val === 'transparent' || typeof val !== 'string') return null;
  if (DC_HEX[val]) return DC_HEX[val].toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(val)) return ('#' + val.slice(1).split('').map(c => c + c).join('')).toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(val)) return val.toLowerCase();
  return null;
}
function dcHexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function dcLuminance(hex) {
  const [r,g,b] = dcHexToRgb(hex).map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126*r + 0.7152*g + 0.0722*b;
}
function dcContrast(a, b) {
  const l1 = dcLuminance(a), l2 = dcLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
// Reverse lookup: nearest brand token for a raw hex, by RGB distance.
// Used to give Sprout a "this off-brand hex is closest to <token>" hint
// so its swap suggestions stay inside the palette.
function dcNearestToken(hex) {
  const target = dcHexToRgb(hex);
  let best = null, bestD = Infinity;
  for (const [tok, h] of Object.entries(DC_HEX)) {
    const [r,g,b] = dcHexToRgb(h);
    const d = (r-target[0])**2 + (g-target[1])**2 + (b-target[2])**2;
    if (d < bestD) { bestD = d; best = tok; }
  }
  return best;
}

// Run server-side rules over a parsed layout array + theme/tabBar config.
// Returns { findings, block_summary, accent_tokens, page_bg_hex }.
function runDesignCheck(blocks, pageBgToken, tabBarCfg) {
  const findings = [];
  const pageBgHex = dcResolveHex(pageBgToken) || '#f2e7df';
  const blockSummary = [];
  let position = 0;
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    if (!b || !b.type) continue;
    position += 1;
    const fields = DC_FIELDS[b.type] || {};
    const bgTok = fields.bg ? (b[fields.bg] ?? null) : null;
    const fgTok = fields.fg ? (b[fields.fg] ?? null) : null;
    const accentTok = fields.accent ? (b[fields.accent] ?? null) : null;
    const bgHex = dcResolveHex(bgTok) || pageBgHex;
    const fgHex = dcResolveHex(fgTok);
    const label = DC_BLOCK_LABELS[b.type] || { en: b.type, cn: b.type };
    function fieldEntry(slot, fieldKey, tok, hex, extra = {}) {
      if (!fieldKey) return null;
      const flbl = DC_FIELD_LABELS[fieldKey] || { en: fieldKey, cn: fieldKey };
      const tlbl = tok && DC_TOKEN_LABELS[tok] ? DC_TOKEN_LABELS[tok] : null;
      return {
        field: fieldKey,
        field_label_en: flbl.en,
        field_label_cn: flbl.cn,
        token: tok,
        token_label_en: tlbl ? tlbl.en : tok,
        token_label_cn: tlbl ? tlbl.cn : tok,
        hex,
        ...extra,
      };
    }
    // `bs.bg` is ALWAYS an object — never null — so rules below can
    // safely read .hex without guarding. Blocks with no real bg field
    // (spacer, category_tabs) get a
    // synthetic entry whose hex is the page background, marked
    // inherited_from_page so the adjacency rule can skip them.
    const bgInherited = !dcResolveHex(bgTok);
    const bgEntry = fields.bg
      ? fieldEntry('bg', fields.bg, bgTok, bgHex, { inherited_from_page: bgInherited })
      : { field: null, token: null, hex: pageBgHex, inherited_from_page: true };
    blockSummary.push({
      id: b.id,
      type: b.type,
      position,                     // 1 = topmost block, increments downward
      label_en: label.en,
      label_cn: label.cn,
      bg: bgEntry,
      fg: fgTok ? fieldEntry('fg', fields.fg, fgTok, fgHex) : null,
      accent: accentTok ? fieldEntry('accent', fields.accent, accentTok, dcResolveHex(accentTok)) : null,
    });
  }

  // R1 — text contrast per block
  for (let i = 0; i < blockSummary.length; i++) {
    const bs = blockSummary[i];
    if (!bs || !bs.fg || !bs.fg.hex || !bs.bg || !bs.bg.hex) continue;
    const ratio = dcContrast(bs.fg.hex, bs.bg.hex);
    if (ratio < 3.0) {
      findings.push({ sev: 'critical', rule: 'low_contrast', block_id: bs.id, block_type: bs.type, block_label_en: bs.label_en, block_label_cn: bs.label_cn, position: bs.position, ratio: +ratio.toFixed(2), bg: bs.bg, fg: bs.fg, en: `${bs.label_en} text contrast ${ratio.toFixed(1)}:1 (needs 4.5:1).`, cn: `${bs.label_cn} 文字对比度 ${ratio.toFixed(1)}:1(应≥4.5:1)。` });
    } else if (ratio < 4.0) {
      findings.push({ sev: 'warn', rule: 'borderline_contrast', block_id: bs.id, block_type: bs.type, block_label_en: bs.label_en, block_label_cn: bs.label_cn, position: bs.position, ratio: +ratio.toFixed(2), bg: bs.bg, fg: bs.fg, en: `${bs.label_en} contrast ${ratio.toFixed(1)}:1 may strain readers.`, cn: `${bs.label_cn} 对比度 ${ratio.toFixed(1)}:1,小字可能难读。` });
    }
  }

  // R2 — adjacent muddy backgrounds. Skip when EITHER block inherits
  // the page bg (spacer / category_tabs etc.) — those don't create a
  // visible seam, they just show through
  // to the page colour.
  for (let i = 0; i < blockSummary.length - 1; i++) {
    const a = blockSummary[i], c = blockSummary[i+1];
    if (!a || !c || !a.bg || !c.bg || !a.bg.hex || !c.bg.hex) continue;
    if (a.bg.inherited_from_page || c.bg.inherited_from_page) continue;
    if (a.bg.hex === c.bg.hex) continue;
    const r = dcContrast(a.bg.hex, c.bg.hex);
    if (r > 1.02 && r < 1.6) {
      findings.push({ sev: 'warn', rule: 'stacked_muddy', block_ids: [a.id, c.id], block_types: [a.type, c.type], block_labels_en: [a.label_en, c.label_en], block_labels_cn: [a.label_cn, c.label_cn], positions: [a.position, c.position], ratio: +r.toFixed(2), bg_pair: [a.bg, c.bg], en: `${a.label_en} → ${c.label_en} sit on near-identical backgrounds (${r.toFixed(2)}:1).`, cn: `${a.label_cn} → ${c.label_cn} 背景过于接近(${r.toFixed(2)}:1)。` });
    }
  }

  // R3 — too many accent tokens
  const accentTokens = new Set();
  for (const bs of blockSummary) {
    if (!bs) continue;
    const bgSlot = bs.bg && bs.bg.token;
    const accSlot = bs.accent && bs.accent.token;
    for (const slot of [bgSlot, accSlot]) {
      if (!slot || slot === 'transparent') continue;
      if (DC_NEUTRALS.has(slot)) continue;
      if (DC_HEX[slot]) accentTokens.add(slot);
    }
  }
  if (accentTokens.size > 3) {
    findings.push({ sev: 'warn', rule: 'too_many_accents', tokens: [...accentTokens], en: `${accentTokens.size} accent colours competing on this page.`, cn: `当前有 ${accentTokens.size} 种主色互相抢眼。` });
  }

  // R4 — tab-bar palette
  const TABBAR_THEMES = {
    oat:    { bg: '#F2E7DF', active: '#365329' },
    paper:  { bg: '#FBF6E8', active: '#365329' },
    forest: { bg: '#2a3a22', active: '#ccd900' },
    lime:   { bg: '#ccd900', active: '#16161a' },
  };
  const themePreset = TABBAR_THEMES[tabBarCfg.theme || 'oat'] || TABBAR_THEMES.oat;
  const tbBg = (themePreset.bg || '').toLowerCase();
  const tbSel = (tabBarCfg.selectedColor || themePreset.active || '').toLowerCase();
  if (tbBg && tbSel) {
    const r = dcContrast(tbSel, tbBg);
    if (r < 3.0) {
      findings.push({ sev: 'critical', rule: 'tabbar_low_contrast', ratio: +r.toFixed(2), tab_bar: { bg_hex: tbBg, selected_hex: tbSel, theme: tabBarCfg.theme || 'oat' }, en: `Tab bar active state contrast ${r.toFixed(1)}:1 — hard to see which tab is current.`, cn: `导航栏 — 选中色与背景对比度仅 ${r.toFixed(1)}:1。` });
    }
  }
  if (tabBarCfg.selectedColor) {
    const sh = tabBarCfg.selectedColor.toLowerCase();
    const brandHexes = new Set(Object.values(DC_HEX).map(h => h.toLowerCase()));
    if (!brandHexes.has(sh)) {
      findings.push({ sev: 'info', rule: 'tabbar_offbrand', tab_bar: { selected_hex: sh, nearest_brand_token: dcNearestToken(sh) }, en: `Tab bar active colour ${sh} is off-brand. Nearest brand token: ${dcNearestToken(sh)}.`, cn: `导航栏选中色 ${sh} 不在品牌色板内。最接近的品牌色: ${dcNearestToken(sh)}。` });
    }
  }

  // Sort findings in reading order (top of page → bottom → page-level).
  // Sprout writes fixes in this order so the owner can follow along on
  // the canvas. Findings without a position (accent count, tab bar) go
  // last; severity is broken as a secondary key.
  const sevRank = { critical: 0, warn: 1, info: 2 };
  findings.sort((a, b) => {
    const pa = a.position ?? (Array.isArray(a.positions) ? a.positions[0] : null) ?? 9999;
    const pb = b.position ?? (Array.isArray(b.positions) ? b.positions[0] : null) ?? 9999;
    if (pa !== pb) return pa - pb;
    return sevRank[a.sev] - sevRank[b.sev];
  });

  return {
    page_bg: { token: pageBgToken, hex: pageBgHex, label_en: pageBgToken && DC_TOKEN_LABELS[pageBgToken] ? DC_TOKEN_LABELS[pageBgToken].en : 'default Oat' },
    tab_bar: { theme: tabBarCfg.theme || 'oat', selected_color: tabBarCfg.selectedColor || null, bar_color: tabBarCfg.color || null },
    block_summary: blockSummary,
    accent_tokens_in_use: [...accentTokens],
    findings,
    summary: {
      blocks: blockSummary.length,
      critical: findings.filter(f => f.sev === 'critical').length,
      warn: findings.filter(f => f.sev === 'warn').length,
      info: findings.filter(f => f.sev === 'info').length,
    },
  };
}

// POST /api/ai/chat — agentic loop. Body: { messages, context? }
//   messages: array of {role: 'user'|'assistant', content: string}
//   context:  optional string giving the page the user is on, for system prompt
// Response: { success, reply, tool_calls, usage }
//   reply: final assistant text
//   tool_calls: array of {name, input, output} — surfaced for transparency
const MAX_HOPS = 8;
router.post('/api/ai/chat', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.permissions?.ai) {
    return res.status(403).json({ error: 'AI not enabled for this user · 此用户未启用 AI' });
  }
  const provider = pickProvider();
  if (!providerKey(provider)) {
    return res.status(503).json({
      error: 'AI not configured · AI 未配置',
      detail: `Set ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'DEEPSEEK_API_KEY'} in /root/roots-v2/.env then restart pm2.`,
    });
  }

  const userMessages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!userMessages || !userMessages.length) return res.status(400).json({ error: 'messages required' });
  const pageContext = (req.body?.context || '').toString().slice(0, 400);
  const langPref = (req.body?.lang === 'en' || req.body?.lang === 'zh') ? req.body.lang : 'auto';
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

  // Validate + normalise messages — drop any that aren't user/assistant text.
  const messages = [];
  for (const m of userMessages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (typeof m.content === 'string')      messages.push({ role: m.role, content: m.content });
    else if (Array.isArray(m.content))      messages.push({ role: m.role, content: m.content });
  }
  if (!messages.length) return res.status(400).json({ error: 'no usable messages' });

  // Image attachments — attached to the LAST user message in the chain.
  // Anthropic supports vision blocks natively; DeepSeek's chat model can't
  // see images, so we leave the existing "[Attached image: name]" text
  // marker the client added (good enough for "user mentioned an image" UX).
  const imageAttachments = attachments.filter(a => a && a.kind === 'image' && typeof a.dataUrl === 'string');
  if (imageAttachments.length && provider === 'anthropic') {
    // Find the last user message and convert it to a content array
    // mixing text + image blocks. Anthropic accepts up to ~5MB per image.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue;
      const existing = messages[i].content;
      const textPart = typeof existing === 'string' ? existing : (
        Array.isArray(existing)
          ? existing.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
          : ''
      );
      const blocks = [];
      if (textPart) blocks.push({ type: 'text', text: textPart });
      for (const img of imageAttachments) {
        // dataUrl looks like "data:image/png;base64,XXXX". Split into media_type + data.
        const m = /^data:([^;]+);base64,(.+)$/.exec(img.dataUrl);
        if (!m) continue;
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: m[1], data: m[2] },
        });
      }
      messages[i] = { role: 'user', content: blocks };
      break;
    }
  }

  // Pull persistent business memory + page context. Memory rows are
  // ordered by weight desc so the agent reads the most important ones
  // first if the model's attention budget gets squeezed.
  let memoryBlock = '';
  try {
    const memRows = db.prepare(`SELECT key, value FROM ai_memory
                                  WHERE COALESCE(is_active,1)=1
                                  ORDER BY weight DESC, id ASC LIMIT 30`).all();
    if (memRows.length) {
      memoryBlock = '\n\n══════════════════════════════════════════════════════════════════════\n' +
                    'PERSISTENT BUSINESS MEMORY (curated facts about this operation)\n' +
                    '══════════════════════════════════════════════════════════════════════\n' +
                    memRows.map(r => `• [${r.key}] ${r.value}`).join('\n');
    }
  } catch (e) { /* table may not exist on first boot — fall through */ }

  const langDirective =
    langPref === 'en' ? `\n\nLANGUAGE OVERRIDE: Always answer in English, regardless of the language the user writes in.` :
    langPref === 'zh' ? `\n\nLANGUAGE OVERRIDE: Always answer in Simplified Chinese (简体中文), regardless of the language the user writes in.` :
    '';

  // Split system into a stable "static" half (cacheable) and a per-request
  // "dynamic" half. After the first hop in a hot 5-minute window, the static
  // half is read from Anthropic's prompt cache at 10% of base cost AND
  // doesn't burn against the per-minute input-token rate limit.
  const systemStatic  = SPROUT_SYSTEM;
  const systemDynamic = memoryBlock
    + (pageContext ? `\n\nCURRENT PAGE CONTEXT (where the user is right now):\n${pageContext}` : '')
    + langDirective
    + `\n\nTODAY: ${new Date().toISOString().slice(0,10)}`;

  const toolCalls = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let finalReply = '';

  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const result = await callLLM({ system: { static: systemStatic, dynamic: systemDynamic }, tools: buildTools(), messages, max_tokens: 1500 });
      usage.input_tokens                += result.usage.input_tokens                || 0;
      usage.output_tokens               += result.usage.output_tokens               || 0;
      usage.cache_creation_input_tokens += result.usage.cache_creation_input_tokens || 0;
      usage.cache_read_input_tokens     += result.usage.cache_read_input_tokens     || 0;

      const blocks   = result.content_blocks || [];
      const toolUses = blocks.filter(b => b.type === 'tool_use');
      const textOut  = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n');

      if (toolUses.length === 0) {
        // Final reply — stop the loop.
        finalReply = textOut;
        break;
      }

      // Append the assistant's tool-use turn to the messages, then run each
      // tool and append a user turn carrying the tool_result blocks.
      messages.push({ role: 'assistant', content: blocks });
      const toolResults = [];
      for (const tu of toolUses) {
        let output;
        try {
          const handler = TOOL_HANDLERS[tu.name];
          if (!handler) output = { error: 'unknown tool: ' + tu.name };
          else          output = handler(tu.input || {}, { user_id: req.user.id });
        } catch (e) {
          output = { error: 'tool error: ' + (e.message || 'unknown') };
        }
        toolCalls.push({ name: tu.name, input: tu.input, output });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(output).slice(0, 12000), // hard cap
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalReply) finalReply = '_(no reply produced — agent ran out of steps · 已达步数上限)_';
    logActivity(req.user.id, req.user.username, 'ai_chat', null, null,
      { tool_calls: toolCalls.length, usage, provider }, req.ip);
    res.json({ success: true, reply: finalReply, tool_calls: toolCalls, usage, provider });
  } catch (e) {
    if (e.code === 'no_key') return res.status(503).json({ error: e.message });
    if (e.status)            return res.status(502).json({ error: e.message, provider: e.provider });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// AI memory management — admin curates the facts Sprout sees on every
// conversation. Anyone with `ai` permission can READ; admin can write.
// Keep the surface tiny so the UI stays simple.
// ─────────────────────────────────────────────────────────────────────
router.get('/api/ai/memory', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && !req.permissions?.ai) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const rows = db.prepare(`SELECT id, key, value, weight, is_active, created_at, updated_at
                             FROM ai_memory
                            ORDER BY weight DESC, id ASC`).all();
  res.json({ success: true, data: rows });
});

router.post('/api/ai/memory', requireAuth, requireAdmin, (req, res) => {
  const { key, value, weight } = req.body || {};
  if (!key || !key.trim() || !value || !value.trim()) {
    return res.status(400).json({ error: 'key and value required' });
  }
  const w = Math.max(1, Math.min(10, parseInt(weight, 10) || 5));
  const r = db.prepare(`INSERT INTO ai_memory (key, value, weight) VALUES (?, ?, ?)`)
              .run(key.trim(), value.trim(), w);
  logActivity(req.user.id, req.user.username, 'create', 'ai_memory', r.lastInsertRowid, { key }, req.ip);
  res.json({ success: true, id: r.lastInsertRowid });
});

router.put('/api/ai/memory/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const { key, value, weight, is_active } = req.body || {};
  const cur = db.prepare('SELECT * FROM ai_memory WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const w = weight != null ? Math.max(1, Math.min(10, parseInt(weight, 10) || 5)) : cur.weight;
  db.prepare(`UPDATE ai_memory SET key=?, value=?, weight=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run((key||cur.key).trim(), (value||cur.value).trim(), w,
         is_active != null ? (is_active ? 1 : 0) : cur.is_active, id);
  logActivity(req.user.id, req.user.username, 'update', 'ai_memory', id, { key }, req.ip);
  res.json({ success: true });
});

router.delete('/api/ai/memory/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  db.prepare('DELETE FROM ai_memory WHERE id = ?').run(id);
  logActivity(req.user.id, req.user.username, 'delete', 'ai_memory', id, null, req.ip);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────
// AI Knowledge Base (Sprout's "how do I…?" content). Each topic has
// hardcoded default content shipped in this file's APP_HELP map. Admins
// can OVERRIDE a default or ADD brand-new topics via these endpoints,
// without needing a deploy. The override row in ai_app_help wins over
// the default. Sprout's get_app_help dispatch reads the merged view.
// ─────────────────────────────────────────────────────────────────────

// Sanitise/normalise a user-provided topic key.
function _normTopic(s) {
  return (s || '').toString().toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

// List every topic admin sees: union of defaults + DB rows, with source
// flag so the UI can show "default | overridden | custom" badges. Anyone
// with the `ai` permission can read this so Sprout-savvy operators can
// browse what Sprout knows; only admins can write.
router.get('/api/ai/app-help', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && !req.permissions?.ai) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const defaults = Object.keys(APP_HELP);
  const dbRows = db.prepare(`SELECT topic, title, content, is_active, updated_at, updated_by
                               FROM ai_app_help`).all();
  const byTopic = {};
  defaults.forEach(t => { byTopic[t] = { topic: t, source: 'default', is_active: 1, content_default: APP_HELP[t] }; });
  dbRows.forEach(r => {
    const isDefault = defaults.includes(r.topic);
    byTopic[r.topic] = {
      topic: r.topic,
      source: isDefault ? 'overridden' : 'custom',
      title: r.title || '',
      content: r.content,
      is_active: r.is_active,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
      content_default: isDefault ? APP_HELP[r.topic] : null,
    };
  });
  const rows = Object.values(byTopic).sort((a, b) => a.topic.localeCompare(b.topic));
  res.json({ success: true, data: rows });
});

// Single topic detail — used by the editor to load the current effective
// content (DB if present, else default) plus the default for reset.
router.get('/api/ai/app-help/:topic', requireAuth, requireAdmin, (req, res) => {
  const topic = _normTopic(req.params.topic);
  if (!topic) return res.status(400).json({ error: 'invalid topic' });
  const dbRow = db.prepare('SELECT * FROM ai_app_help WHERE topic = ?').get(topic);
  const def = APP_HELP[topic] || null;
  res.json({
    success: true,
    data: {
      topic,
      source: dbRow ? (def ? 'overridden' : 'custom') : (def ? 'default' : 'none'),
      title: dbRow?.title || '',
      content: dbRow?.content || def || '',
      content_default: def,
      is_active: dbRow ? dbRow.is_active : 1,
      updated_at: dbRow?.updated_at,
      updated_by: dbRow?.updated_by,
    },
  });
});

// Upsert. POST creates/replaces the ai_app_help row for the given topic.
// Title is optional (display label); content is the markdown Sprout reads.
// Marks any matching ai_app_help_misses row as resolved so it drops out
// of the "gap" panel automatically.
router.put('/api/ai/app-help/:topic', requireAuth, requireAdmin, (req, res) => {
  const topic = _normTopic(req.params.topic);
  if (!topic) return res.status(400).json({ error: 'invalid topic' });
  const { title, content, is_active } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
  const active = is_active === 0 || is_active === false ? 0 : 1;
  db.prepare(`INSERT INTO ai_app_help (topic, title, content, is_active, updated_at, updated_by)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
              ON CONFLICT(topic) DO UPDATE SET
                title       = excluded.title,
                content     = excluded.content,
                is_active   = excluded.is_active,
                updated_at  = CURRENT_TIMESTAMP,
                updated_by  = excluded.updated_by`)
    .run(topic, (title || '').trim(), content.trim(), active, req.user.username);
  // Clear any matching miss so it drops out of the gap panel.
  try { db.prepare('UPDATE ai_app_help_misses SET resolved = 1 WHERE topic = ?').run(topic); } catch (_) {}
  logActivity(req.user.id, req.user.username, 'upsert', 'ai_app_help', null, { topic }, req.ip);
  res.json({ success: true });
});

// Delete the ai_app_help row. If the topic also has a hardcoded default,
// Sprout falls back to that default automatically. If it was custom-only,
// the topic disappears entirely.
router.delete('/api/ai/app-help/:topic', requireAuth, requireAdmin, (req, res) => {
  const topic = _normTopic(req.params.topic);
  if (!topic) return res.status(400).json({ error: 'invalid topic' });
  db.prepare('DELETE FROM ai_app_help WHERE topic = ?').run(topic);
  logActivity(req.user.id, req.user.username, 'delete', 'ai_app_help', null, { topic }, req.ip);
  res.json({ success: true, fallback_to_default: !!APP_HELP[topic] });
});

// Gap-feedback panel. Returns topics Sprout was asked about but didn't
// find — sorted by hit_count so the most-asked gaps surface first.
// Resolved rows (admin has since authored the topic) are filtered out by
// default; pass ?show=all to include them.
router.get('/api/ai/app-help-misses', requireAuth, requireAdmin, (req, res) => {
  const showAll = req.query.show === 'all';
  const where = showAll ? '' : 'WHERE COALESCE(resolved, 0) = 0';
  const rows = db.prepare(`SELECT m.topic, m.hit_count, m.first_at, m.last_at,
                                  m.resolved, u.username AS last_user
                             FROM ai_app_help_misses m
                             LEFT JOIN users u ON u.id = m.last_user_id
                             ${where}
                            ORDER BY m.hit_count DESC, m.last_at DESC
                            LIMIT 50`).all();
  res.json({ success: true, data: rows });
});

// Admin can manually mark a miss resolved (e.g. it's a typo we don't want
// to fix) or clear it from the panel without authoring a topic.
router.delete('/api/ai/app-help-misses/:topic', requireAuth, requireAdmin, (req, res) => {
  const topic = _normTopic(req.params.topic);
  if (!topic) return res.status(400).json({ error: 'invalid topic' });
  db.prepare('DELETE FROM ai_app_help_misses WHERE topic = ?').run(topic);
  res.json({ success: true });
});

module.exports = router;
