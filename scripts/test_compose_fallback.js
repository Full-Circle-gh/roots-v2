#!/usr/bin/env node
/**
 * Smart paste was the one AI button still on the old model connection, and a
 * cut-off reply was thrown away even when the paste itself could be divided.
 * These checks are the paste from the dialog that failed, run through the
 * real divider and through the live handler with the model stubbed out.
 */
'use strict';

process.env.MODEL_API_KEY = 'sk-test-smart-paste';
process.env.MODEL_API_URL = 'https://model.example/v1/messages';
process.env.MODEL_NAME = 'claude-sonnet-4-6';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_URL;
delete process.env.AI_PROVIDER;
delete process.env.DEEPSEEK_API_KEY;

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'routes', 'ai.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

function sliceFn(open, close) {
  const a = SRC.indexOf(open);
  if (a < 0) throw new Error('not found in routes/ai.js: ' + open);
  const b = SRC.indexOf(close, a);
  if (b < 0) throw new Error('no end anchor after ' + open);
  return SRC.slice(a, b + close.length);
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  sliceFn('function _composePlain(s)', 'return null;\n}') +
  '\nthis.fallbackBlocks = fallbackBlocks;\nthis.composeRetryArgs = composeRetryArgs;',
  ctx);
const { fallbackBlocks, composeRetryArgs } = ctx;

const EN = [
  'each sip, balanced by the rounded tea flavour. A bold,',
  'comforting cup to take your time with.',
  '',
  '**Ingredients:** Yunnan black tea, ginger.',
].join('\n');
const CN = [
  '云南红茶与生姜一同浸泡，茶香醇厚，姜香鲜明。生姜的微辣缓缓展开，与红茶的温润相互衬托，入口饱满，回味带着轻轻的辛香。适合慢慢喝，给日常添一点暖意。',
  '',
  '**配料：** 云南红茶、生姜。',
].join('\n');

function expectGinger(blocks, label) {
  is(blocks.length, 2, label + ': a paragraph and the ingredient chips');
  is(blocks[0].type, 'hero_intro', label + ': the prose is the intro');
  yes(!/ingredients/i.test(blocks[0].body_en), label + ': the Ingredients heading is not left in the paragraph');
  yes(!String(blocks[0].body_cn).includes('配料'), label + ': the 配料 heading is not left in the paragraph');
  yes(blocks[0].body_en.includes('rounded tea flavour'), label + ': the English paragraph is the operator\'s words');
  yes(blocks[0].body_cn.startsWith('云南红茶与生姜一同浸泡'), label + ': the Chinese paragraph is the operator\'s words');
  is(blocks[1].type, 'ingredients_chips', label + ': the list is chips');
  is(blocks[1].items[0].name_en, 'Yunnan black tea', label + ': first English chip');
  is(blocks[1].items[0].name_cn, '云南红茶', label + ': first Chinese chip');
  is(blocks[1].items[0].lead, true, label + ': the first chip is the lead');
  is(blocks[1].items[1].name_en, 'ginger', label + ': second English chip, period stripped');
  is(blocks[1].items[1].name_cn, '生姜', label + ': second Chinese chip, full stop stripped');
  is(blocks[1].items[1].lead, false, label + ': only the first chip is the lead');
}

section('1 · the paste in the dialog divides on its own headings');
expectGinger(fallbackBlocks(EN, CN), 'dialog paste');

const wrapped = fallbackBlocks('**Ingredients:** Yunnan black\ntea, ginger.', '');
is(wrapped.length, 1, 'a heading with no paragraph is just the chips');
is(wrapped[0].items[0].name_en, 'Yunnan black tea', 'a wrapped line stays one ingredient');
is(wrapped[0].items[1].name_en, 'ginger', 'the comma, not the wrap, is the break');

const lined = fallbackBlocks('Intro.\n\nIngredients:\nYunnan black tea\nginger', '介绍。\n\n成分：\n云南红茶\n生姜');
is(lined[0].type, 'hero_intro', 'a line list still keeps the paragraph');
is(lined[0].body_en, 'Intro.', 'the paragraph stops at the heading');
is(lined[1].items.map(i => i.name_en).join('|'), 'Yunnan black tea|ginger', 'one name per line when there is no comma');
is(lined[1].items.map(i => i.name_cn).join('|'), '云南红茶|生姜', '成分： splits the same way 配料： does');

const plain = fallbackBlocks('Just a cup of tea.', '只是一杯茶。');
is(plain.length, 1, 'a paste with no heading is one section');
is(plain[0].type, 'hero_intro', '…and that section is the intro');
is(plain[0].body_en, 'Just a cup of tea.', 'the English is unchanged');
is(plain[0].body_cn, '只是一杯茶。', 'the Chinese is unchanged');
is(fallbackBlocks('', '').length, 0, 'nothing to paste is nothing to divide');
is(fallbackBlocks('   ', '  ').length, 0, 'blank boxes are nothing to divide');

section('2 · a 400 that names the request is a different request');
{
  const dropped = composeRetryArgs(
    { status: 400, _detail: 'thinking.type disabled is not supported' },
    { max_tokens: 12000, thinking: { type: 'disabled' }, messages: [] });
  yes(dropped && !('thinking' in dropped), 'a thinking rejection is retried with thinking omitted');
  is(dropped && dropped.max_tokens, 12000, '…and the token budget is left alone');
}
{
  const smaller = composeRetryArgs(
    { status: 400, message: 'max_tokens: 12000 > 8192' },
    { max_tokens: 12000, thinking: { type: 'disabled' } });
  is(smaller && smaller.max_tokens, 8000, 'a max_tokens rejection steps down to 8000');
  yes(smaller && smaller.thinking && smaller.thinking.type === 'disabled', '…and keeps the rest of the request');
}
is(composeRetryArgs(
  { status: 400, _detail: 'max_tokens too high' },
  { max_tokens: 8000 }), null, 'already at 8000 is not retried again');
is(composeRetryArgs(
  { status: 403, _detail: 'thinking disabled' },
  { max_tokens: 12000, thinking: { type: 'disabled' } }), null, 'a refusal that is not a 400 is not rewritten');

section('3 · the handler is wired to that divider, and DeepSeek stays where it was');
yes(/const result = await composeCall\(/.test(SRC), 'the compose pass calls composeCall');
yes(/composeConfigured\(_provider\)/.test(SRC), 'the configured check is the gateway\'s, not the old key name');
is(SRC.split('fallbackBlocks(textEn || textLegacy, textCn)').length - 1, 2,
  'both an empty reply and a thrown call divide the paste');
yes(/pickProvider\(\) === 'deepseek'\) return callLLM\(args\)/.test(SRC),
  'DeepSeek still uses the old adapter');
yes(/thinking: \{ type: 'disabled' \}/.test(SRC), 'the first gateway attempt turns thinking off');

const router = require('../routes/ai');
const modelGateway = require('../lib/model-gateway');
const layer = router.stack.find(l => l.route && l.route.path === '/api/retail-admin/ai/compose-blocks' && l.route.methods.post);
if (!layer) { bad('compose route is not mounted'); process.exit(1); }
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const MODEL_BLOCKS = [{
  type: 'hero_intro',
  body_en: 'From the model',
  body_cn: '来自模型',
  kicker_en: '', kicker_cn: '', highlight_en: '', highlight_cn: '',
}];

function http(status, payload, asText) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (asText != null ? asText : JSON.stringify(payload || {})),
    json: async () => payload,
  };
}
function toolReply(blocks, stop) {
  return http(200, {
    content: [{ type: 'tool_use', name: 'emit_blocks', input: { blocks } }],
    stop_reason: stop || 'end_turn',
    usage: { input_tokens: 3, output_tokens: 5 },
  });
}

async function drive(body, impl) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const parsed = JSON.parse(opts.body);
    calls.push({ url, body: parsed, headers: opts.headers });
    return impl(calls.length, parsed);
  };
  const req = {
    body,
    user: { id: 1, username: 'ash' },
    ip: '127.0.0.1',
    tenant: { id: 1 },
  };
  const out = await new Promise((resolve, reject) => {
    let statusCode = 200;
    const timer = setTimeout(() => reject(new Error('handler did not respond')), 8000);
    const res = {
      status(c) { statusCode = c; return this; },
      json(o) { clearTimeout(timer); resolve({ status: statusCode, body: o }); return this; },
    };
    Promise.resolve(handler(req, res)).catch(e => { clearTimeout(timer); reject(e); });
  });
  return { ...out, calls };
}

const PASTE = {
  text_en: EN,
  text_cn: CN,
  translate: false,
  product: { id: 9, name_en: 'Warm Ginger Black Tea', name_cn: '姜红茶' },
};

(async () => {
  try {
    section('4 · the gateway sends thinking only when a caller asks');
    {
      const seen = [];
      global.fetch = async (url, opts) => {
        seen.push(JSON.parse(opts.body));
        return http(200, { content: [], stop_reason: 'end_turn', usage: {} });
      };
      await modelGateway.callModel({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 });
      await modelGateway.callModel({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        thinking: { type: 'disabled' },
      });
      yes(!('thinking' in seen[0]), 'a caller that does not mention thinking sends the body it always sent');
      is(seen[1].thinking && seen[1].thinking.type, 'disabled', 'a caller that asks has it on the request');
      is(seen[0].model, 'claude-sonnet-4-6', 'the model name is the gateway\'s');
    }

    section('5 · a refused model call still returns the paste, divided');
    {
      const out = await drive(PASTE, () => http(403, {}, 'blocked in this region'));
      is(out.status, 200, 'the browser gets a normal answer');
      is(out.body.success, true, '…marked success, so the preview opens');
      expectGinger(out.body.blocks, 'refused model');
      is(out.calls.length, 1, 'one attempt, then the paste itself');
      is(out.calls[0].url, 'https://model.example/v1/messages', 'the call goes to MODEL_API_URL, not the public Anthropic host');
      is(out.calls[0].headers['x-api-key'], 'sk-test-smart-paste', 'the key is MODEL_API_KEY');
      is(out.calls[0].body.thinking && out.calls[0].body.thinking.type, 'disabled', 'thinking is asked off');
      yes(!JSON.stringify(out.body).includes('blocked'), 'the upstream detail is not sent to the browser');
      yes(!JSON.stringify(out.body).includes('_detail'), 'and neither is the private field');
    }

    section('6 · a real model answer is kept');
    {
      const out = await drive(PASTE, () => toolReply(MODEL_BLOCKS));
      is(out.status, 200, 'the model answer is a 200');
      is(out.body.blocks[0].body_en, 'From the model', 'the model\'s section is what the operator reviews');
      is(out.calls.length, 1, 'a usable answer is not replaced and not retried');
    }

    section('7 · a 400 that names thinking or the token cap is retried, then kept');
    {
      const out = await drive(PASTE, (n) => (
        n === 1 ? http(400, {}, 'thinking.type disabled is not supported') : toolReply(MODEL_BLOCKS)
      ));
      is(out.calls.length, 2, 'the thinking rejection gets one more try');
      yes(!('thinking' in out.calls[1].body), 'the retry omits thinking');
      is(out.body.blocks[0].body_en, 'From the model', 'the retry\'s sections are kept');
    }
    {
      const out = await drive(PASTE, (n) => (
        n === 1 ? http(400, {}, 'max_tokens: 12000 > 8192') : toolReply(MODEL_BLOCKS)
      ));
      is(out.calls[0].body.max_tokens, 12000, 'the first ask is the normal budget');
      is(out.calls[1].body.max_tokens, 8000, 'the retry fits the smaller ceiling');
      is(out.body.blocks[0].body_en, 'From the model', 'the smaller reply is kept');
    }

    section('8 · a cut-off reply is kept when it parsed, and asked again when it did not');
    {
      const out = await drive(PASTE, () => toolReply(MODEL_BLOCKS, 'max_tokens'));
      is(out.status, 200, 'a cut-off reply that still parsed is not a failure');
      is(out.body.blocks[0].body_en, 'From the model', 'those sections are the ones returned');
      is(out.calls.length, 1, 'no second ask when there is already something to review');
    }
    {
      const out = await drive(PASTE, (n) => (
        n === 1 ? toolReply([], 'max_tokens') : toolReply(MODEL_BLOCKS)
      ));
      is(out.calls.length, 2, 'a cut-off reply with nothing parsed is asked once more');
      is(out.calls[1].body.max_tokens, 32000, 'the second ask has room');
      is(out.body.blocks[0].body_en, 'From the model', 'the second reply is kept');
    }
    {
      const out = await drive(PASTE, () => toolReply([]));
      is(out.calls.length, 3, 'an empty reply is nudged, then tried in one language');
      is(out.status, 200, 'and the paste is still divided rather than failed');
      expectGinger(out.body.blocks, 'empty model');
    }

    section('9 · no key stays "not configured", and DeepSeek does not go through the gateway');
    {
      const saved = process.env.MODEL_API_KEY;
      delete process.env.MODEL_API_KEY;
      const out = await drive(PASTE, () => { throw new Error('fetch should not run'); });
      process.env.MODEL_API_KEY = saved;
      is(out.status, 503, 'with no key the paste is not silently divided');
      is(out.body.error, 'AI not configured · AI 未配置', 'the existing not-configured string');
      is(out.calls.length, 0, 'no model call is made');
    }
    {
      process.env.AI_PROVIDER = 'deepseek';
      delete process.env.DEEPSEEK_API_KEY;
      const out = await drive(PASTE, () => { throw new Error('fetch should not run'); });
      delete process.env.AI_PROVIDER;
      is(out.status, 503, 'DeepSeek with no key is still not configured');
      yes(String(out.body.detail).includes('DEEPSEEK_API_KEY'), 'the hint names the DeepSeek key');
      is(out.calls.length, 0, 'and no call is made');
    }
    {
      process.env.AI_PROVIDER = 'deepseek';
      process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
      const out = await drive(PASTE, () => http(200, {
        choices: [{
          finish_reason: 'stop',
          message: {
            content: '',
            tool_calls: [{
              id: 'call_1',
              function: { name: 'emit_blocks', arguments: JSON.stringify({ blocks: MODEL_BLOCKS }) },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
      delete process.env.AI_PROVIDER;
      delete process.env.DEEPSEEK_API_KEY;
      is(out.calls[0].url, 'https://api.deepseek.com/chat/completions', 'DeepSeek is called on its own adapter');
      yes(!('thinking' in out.calls[0].body), 'that adapter is not handed an Anthropic thinking field');
      is(out.body.blocks[0].body_en, 'From the model', 'its sections come back the same way');
    }
  } catch (e) {
    bad('the handler suite threw', e && e.stack);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
