#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { advise, parseAdvice, stripCoords } = require('../lib/pin-advice');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, e) { fail++; console.log('  ✗ ' + m + '\n      ' + (e && e.message || e)); }

function it(name, fn) {
  try { fn(); ok(name); } catch (e) { bad(name, e); }
}
async function itAsync(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e); }
}

it('keeps a clear different verdict and drops a coordinate the model invented', () => {
  const out = parseAdvice('{"verdict":"different","en":"The pin is at 23.129110, 113.264400, a school.","cn":"这个点在学校。"}');
  assert.strictEqual(out.verdict, 'different');
  assert.ok(!/23\.129110/.test(out.en));
  assert.ok(/school/.test(out.en));
  assert.strictEqual(out.cn, '这个点在学校。');
});

it('an unknown verdict becomes unsure', () => {
  const out = parseAdvice('{"verdict":"yes","en":"fine","cn":"可以"}');
  assert.strictEqual(out.verdict, 'unsure');
});

it('prose around the JSON is ignored', () => {
  const out = parseAdvice('Sure.\n```json\n{"verdict":"same","en":"Same building.","cn":"同一栋楼。"}\n```');
  assert.strictEqual(out.verdict, 'same');
  assert.strictEqual(out.en, 'Same building.');
});

it('a broken reply does not invent a match', () => {
  const out = parseAdvice('I think it is fine');
  assert.strictEqual(out.verdict, 'unsure');
  assert.strictEqual(out.en, '');
});

it('strips a bare coordinate and keeps the words', () => {
  assert.strictEqual(stripCoords('near 113.320100 east'), 'near east');
});

(async () => {
  await itAsync('the model is shown the two labels and no coordinate', async () => {
    let seen = null;
    const out = await advise({
      typed: '广东省 广州市 海珠区 琶洲大道51号中国移动广州信息大厦南门',
      pinLabel: '广州市白云区 广附实验学校',
      pinDistrict: '白云区',
      call: async (req) => {
        seen = req;
        return { content_blocks: [{ type: 'text', text: '{"verdict":"different","en":"The map names a school in Baiyun.","cn":"地图写的是白云区的一所学校。"}' }] };
      },
    });
    assert.strictEqual(out.verdict, 'different');
    assert.ok(/中国移动/.test(seen.messages[0].content));
    assert.ok(/广附实验学校/.test(seen.messages[0].content));
    assert.ok(!/\d+\.\d{4,}/.test(seen.messages[0].content), 'the model is not handed a coordinate');
    assert.ok(/白云区的一所学校/.test(out.cn));
  });

  await itAsync('no pin label asks nothing', async () => {
    let called = false;
    const out = await advise({
      typed: '琶洲大道51号',
      pinLabel: '',
      call: async () => { called = true; return {}; },
    });
    assert.strictEqual(called, false);
    assert.strictEqual(out.verdict, 'unsure');
  });

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
