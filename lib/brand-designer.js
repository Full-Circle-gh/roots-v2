// AI Brand Studio — generation engine.
//
// Pure-ish: takes a tenant db handle explicitly so it is unit-testable
// without the HTTP/tenant-ALS layer. The route wrappers in routes/retail.js
// pass tdb(). Talks to the model ONLY through lib/model-gateway (the single
// vendor boundary) — no vendor identifiers appear in this file.
//
// Flow:
//   composeBrief(inputs)        — deterministic brand_brief from quiz/upload
//   gatherCatalogSummary(db)    — real-content conditioning (what they sell)
//   generate({db,inputs})       — one model call -> {theme, layout} -> sanitize -> gates
//   job store                   — async run + poll (background generation)

const gateway   = require('./model-gateway');
const brandTheme = require('./brand-theme');
const { runGates } = require('./brand-gates');
const fonts = require('./brand-fonts');

// Curated set of blocks the designer may compose with (the good ones; skips
// deprecated/niche types). The route's validateBlocks() is the final guard.
const DESIGN_BLOCK_TYPES = [
  'announcement_bar', 'hero_banner', 'category_tabs', 'featured_item',
  'product_grid', 'spacer', 'flash_sale_strip', 'coupon_block',
  'points_widget', 'review_card', 'store_info', 'bundle', 'recipe_story',
  'greeting', 'kitchen_status',
];

const MAX_LAYOUT_BLOCKS = 14;
const DANGEROUS_URL_RE = /(?:^|[\s"'`(])\s*(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;

// ── Real-content conditioning ──────────────────────────────────────────
// Summarise what the tenant actually sells so the model composes a layout
// that fits reality (don't pick a 4-col grid for 3 products, lead with text
// when photos are thin, etc.). Every query is defensive: a schema mismatch
// degrades to a safe default rather than crashing generation.
function gatherCatalogSummary(db) {
  const summary = {
    productCount: 0, withImagePct: 0, categories: [],
    hasReviews: false, hasFlashSales: false, sampleNames: [],
  };
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  summary.productCount = safe(() =>
    db.prepare("SELECT COUNT(*) n FROM products WHERE COALESCE(is_active,1)=1").get().n, 0);

  if (summary.productCount > 0) {
    const withImg = safe(() =>
      db.prepare("SELECT COUNT(*) n FROM products WHERE COALESCE(is_active,1)=1 AND (image_url IS NOT NULL AND image_url<>'' OR image_data IS NOT NULL AND image_data<>'')").get().n, 0);
    summary.withImagePct = Math.round((withImg / summary.productCount) * 100);

    summary.categories = safe(() =>
      db.prepare("SELECT COALESCE(top_category, category, 'Uncategorised') c, COUNT(*) n FROM products WHERE COALESCE(is_active,1)=1 GROUP BY c ORDER BY n DESC LIMIT 12")
        .all().map(r => ({ name: r.c, count: r.n })), []);

    summary.sampleNames = safe(() =>
      db.prepare("SELECT COALESCE(name_en, name_cn) nm FROM products WHERE COALESCE(is_active,1)=1 AND nm IS NOT NULL LIMIT 8")
        .all().map(r => r.nm).filter(Boolean), []);
  }

  summary.hasReviews   = safe(() => db.prepare("SELECT 1 FROM retail_reviews LIMIT 1").get() ? true : false, false);
  summary.hasFlashSales = safe(() => db.prepare("SELECT 1 FROM products WHERE COALESCE(is_on_flash,0)=1 LIMIT 1").get() ? true : false, false);
  return summary;
}

// ── Stage 1: brand_brief ───────────────────────────────────────────────
// v1 assembles the brief deterministically from the structured quiz answers
// (and any has-brand colours/fonts). A model-based enrichment pass (PDF /
// adaptive follow-ups) is a later hook — kept out so the common path needs
// only ONE model call.
function composeBrief(inputs = {}) {
  const i = inputs || {};
  const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  return {
    about:        String(i.about || '').slice(0, 800),
    audience:     ['chinese', 'international', 'mixed'].includes(i.audience) ? i.audience : 'mixed',
    customerType: arr(i.customerType).slice(0, 6),
    words:        arr(i.words).slice(0, 8),
    sliders:      (i.sliders && typeof i.sliders === 'object') ? i.sliders : {},
    colourDirection: String(i.colourDirection || '').slice(0, 60),
    mustHaveColour:  String(i.mustHaveColour || '').slice(0, 40),
    avoidColour:     String(i.avoidColour || '').slice(0, 40),
    typographyFeel:  String(i.typographyFeel || '').slice(0, 60),
    language:     ['en', 'cn', 'bilingual'].includes(i.language) ? i.language : 'bilingual',
    // has-brand inputs (verbatim)
    brandColours: arr(i.brandColours).slice(0, 8),
    brandFonts:   (i.brandFonts && typeof i.brandFonts === 'object') ? i.brandFonts : null,
    notes:        String(i.notes || '').slice(0, 600),
  };
}

// ── The opinionated house-style system prompt (cacheable static) ────────
function buildSystemPrompt() {
  return `You are the in-house brand designer for a WeChat mini-app storefront platform. You turn a brand brief into a concrete storefront THEME and a HOME page LAYOUT, by configuring an existing, well-crafted block system. You are an opinionated art director, not a theory lecturer.

OUTPUT CONTRACT: respond ONLY by calling the tool emit_brand_design. No prose.

THEME you produce:
- palette: hex values for primary, accent, surface, ink, muted. Build a COHERENT palette (3-5 roles, harmonious). 'surface' is the page background, 'ink' is body text — they MUST have strong contrast (>= 4.5:1). 'primary' is the main brand colour, 'accent' a brighter pop, 'muted' a soft secondary.
- fonts: choose display + body from intent. Use {source:'library', family:'<name>'}. Pair a characterful display with a readable body; never two loud display faces.
- shape: radius (sharp|subtle|rounded) and energy (refined|balanced|bold) to match the brand's temperament.
- density: compact|normal|airy.
- audience: echo the brief's audience.

LAYOUT you produce (Home page): an ordered list of blocks chosen from the allowed types, styled to the palette. Compose like a designer:
- Lead with a hero_banner or greeting; use category_tabs to navigate; product_grid for the catalogue; spacer for rhythm; add coupon_block / points_widget / review_card / store_info / bundle / recipe_story only when they fit the brand and the real catalogue.
- FIT THE REAL CATALOGUE (provided): don't use a multi-column grid for very few products; lead text-forward when few products have photos; only add review_card if they have reviews, flash_sale_strip if they run flash sales.
- Per block, set colour fields (bg_color, fg_color, accent_color, etc.) to hex values drawn from the palette. Keep the system consistent — reuse palette roles, don't introduce many off-palette colours. Set corner_radius and energy consistent with the theme.
- Light placeholder copy only (short, editable headings/labels), bilingual where the language setting calls for it.

PRINCIPLES (apply judgement, don't recite):
- Restraint reads premium; clutter reads cheap. Establish a clear hierarchy.
- Distinctiveness over the generic default — make a deliberate, brand-specific choice, not the safe average.

AUDIENCE REGISTER (this is a VARIABLE, never a default):
- 'international' leans cleaner/more whitespace; 'chinese' can carry more information density and warmth; 'mixed' is an internationally-neutral register that reads well to BOTH.
- AVOID cultural stereotypes (NOT "chinese = busy/red"). Judge by what reads premium/trustworthy/clean for the stated audience.
- For bilingual brands the ONE design must hold up under both English and Chinese text — don't tune a layout so tightly it breaks when the other language renders.

If the brief supplies must-have or to-avoid colours, honour them. If it supplies verbatim brand colours/fonts (has-brand), use them as given.`;
}

// ── The forced tool ────────────────────────────────────────────────────
function buildDesignTool() {
  return {
    name: 'emit_brand_design',
    description: 'Return the storefront theme and the composed Home layout.',
    input_schema: {
      type: 'object',
      properties: {
        theme: {
          type: 'object',
          properties: {
            palette: {
              type: 'object',
              properties: {
                primary: { type: 'string' }, accent: { type: 'string' },
                surface: { type: 'string' }, ink: { type: 'string' }, muted: { type: 'string' },
              },
              required: ['primary', 'accent', 'surface', 'ink'],
            },
            fonts: {
              type: 'object',
              properties: {
                display: { type: 'object', properties: { source: { type: 'string' }, family: { type: 'string' } } },
                body:    { type: 'object', properties: { source: { type: 'string' }, family: { type: 'string' } } },
              },
            },
            shape:   { type: 'object', properties: { radius: { type: 'string' }, energy: { type: 'string' } } },
            density: { type: 'string' },
            audience: { type: 'string' },
          },
          required: ['palette'],
        },
        layout: {
          type: 'array',
          description: 'Home blocks in top-to-bottom order.',
          items: {
            type: 'object',
            properties: { type: { type: 'string', enum: DESIGN_BLOCK_TYPES } },
            required: ['type'],
            additionalProperties: true,
          },
        },
      },
      required: ['theme', 'layout'],
    },
  };
}

function buildUserMessage(brief, catalog) {
  return [
    'BRAND BRIEF:',
    JSON.stringify(brief, null, 2),
    '',
    'REAL CATALOGUE (condition the layout on this):',
    JSON.stringify(catalog, null, 2),
    '',
    'AVAILABLE FONTS — choose display + body ONLY from these (use the exact family name):',
    fonts.promptCatalogue({ installedOnly: true }),
    '',
    'Call emit_brand_design now.',
  ].join('\n');
}

// Guard: a library font the model picks must actually be installed (hostable),
// else fall back to the default; an upload font keeps its self-hosted url.
function coerceFonts(theme) {
  const ok = new Set(fonts.installedFamilies());
  const d = brandTheme.defaultTheme().fonts;
  const fix = (slot, def) => {
    const f = theme.fonts && theme.fonts[slot];
    if (!f) return def;
    if (f.source === 'upload' && f.url) return f;
    return ok.has(f.family) ? f : def;
  };
  theme.fonts = { display: fix('display', d.display), body: fix('body', d.body) };
  return theme;
}

// ── Block sanitation (engine-side, light) ──────────────────────────────
// The route's validateBlocks() is the authoritative guard; here we just
// ensure ids/types and strip obviously hostile strings so the result is
// well-formed for preview.
let _idc = 0;
function blockId() { return 'bd' + Date.now().toString(36) + (_idc++).toString(36); }

function hasDangerous(val, depth = 0) {
  if (depth > 8) return true;
  if (typeof val === 'string') return DANGEROUS_URL_RE.test(val);
  if (Array.isArray(val)) return val.some(v => hasDangerous(v, depth + 1));
  if (val && typeof val === 'object') return Object.values(val).some(v => hasDangerous(v, depth + 1));
  return false;
}

function sanitizeLayout(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    if (!DESIGN_BLOCK_TYPES.includes(b.type)) continue;
    if (hasDangerous(b)) continue;
    out.push({ ...b, id: typeof b.id === 'string' && b.id ? b.id : blockId() });
    if (out.length >= MAX_LAYOUT_BLOCKS) break;
  }
  return out;
}

// ── Generate ───────────────────────────────────────────────────────────
async function generate({ db, inputs, maxTokens = 6000 }) {
  if (!gateway.isConfigured()) {
    const err = new Error('design_service_unavailable');
    err.code = 'not_configured';
    throw err;
  }
  const brief   = composeBrief(inputs);
  const catalog = db ? gatherCatalogSummary(db) : {};

  const result = await gateway.callModel({
    max_tokens: maxTokens,
    system: { static: buildSystemPrompt(), dynamic: `Storefront language: ${brief.language}. Audience: ${brief.audience}.` },
    tools: [buildDesignTool()],
    messages: [{ role: 'user', content: buildUserMessage(brief, catalog) }],
  });

  const emitted = gateway.extractToolUse(result.content_blocks, 'emit_brand_design');
  if (!emitted) {
    const err = new Error('design_generation_empty');
    err.code = 'empty';
    throw err;
  }

  const theme  = coerceFonts(brandTheme.sanitizeTheme(emitted.theme));
  const layout = sanitizeLayout(emitted.layout);
  const gates  = runGates(theme, layout, { audience: theme.audience });

  return {
    theme,
    layout,
    gates,
    brief,
    catalog,
    truncated: result.truncated,
    _usage: result.usage,   // internal only — never returned to a client
  };
}

// ── Async job store (in-memory, TTL) ───────────────────────────────────
const JOBS = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

function _sweep() {
  const now = Date.now();
  for (const [id, j] of JOBS) if (now - j.updatedAt > JOB_TTL_MS) JOBS.delete(id);
}

function startJob({ db, inputs }) {
  _sweep();
  const id = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = { id, state: 'designing', progress: 'Designing your storefront…', createdAt: Date.now(), updatedAt: Date.now(), result: null, error: null };
  JOBS.set(id, job);
  // Fire-and-forget; the request returns immediately with the id.
  Promise.resolve()
    .then(() => generate({ db, inputs }))
    .then((res) => { job.state = 'ready'; job.progress = 'Ready'; job.result = res; job.updatedAt = Date.now(); })
    .catch((e) => { job.state = 'error'; job.error = e.code || 'error'; job.updatedAt = Date.now(); });
  return job;
}

// Client-safe view of a job — strips internal usage / raw model data.
function jobPublic(job) {
  if (!job) return null;
  const view = { id: job.id, state: job.state, progress: job.progress };
  if (job.state === 'error') view.error = friendlyError(job.error);
  if (job.state === 'ready' && job.result) {
    view.result = {
      theme: job.result.theme,
      layout: job.result.layout,
      warnings: job.result.gates.warnings,
      truncated: job.result.truncated,
    };
  }
  return view;
}

function getJob(id) { return JOBS.get(id) || null; }

// Map internal error codes to generic, vendor-free customer copy.
function friendlyError(code) {
  switch (code) {
    case 'not_configured': return 'The design service is not available right now. Please try again later.';
    case 'empty':          return 'We could not put a design together this time — please try again.';
    default:               return 'The design service is busy — please try again in a moment.';
  }
}

module.exports = {
  composeBrief,
  gatherCatalogSummary,
  generate,
  sanitizeLayout,
  startJob,
  getJob,
  jobPublic,
  friendlyError,
  DESIGN_BLOCK_TYPES,
  buildSystemPrompt,
  buildDesignTool,
};
