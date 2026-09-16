// The document layout writes each section's words into its OWN block (§144).
//
// WHY THIS FILE EXISTS, and it is one sentence: until §144 the editor showed
// ONE block's form at a time, so paBlocksSyncFromDOM could find the single
// [data-blockid] in the mount, sweep every [data-bkey] under that mount, and
// write them all onto that one block. With nine forms on screen at once that
// same sweep pours every section's words into whichever block renders first —
// silently, on a page nobody can see is wrong until a customer reads it.
//
// §142 is the same family of mistake eleven days younger: an inverted control
// riding a generic sync. That one shipped and wrote to live data. So this
// invariant is held by a test that actually RUNS the copier, not by a source
// assertion that a rename could satisfy vacuously.
//
// HOW IT RUNS WITHOUT A BROWSER. The fast shard has no DOM and the slow shard
// is not run at all (standing instruction, twice). So the copier is extracted
// from the page source and executed against a hand-built stand-in that
// implements exactly the four things it touches: getAttribute, closest,
// querySelectorAll and .type/.value/.checked. If the copier ever reaches for a
// fifth, this file throws rather than quietly passing.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/product-editor.html'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

function fnBody(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) return '';
  let i = m.index + m[0].length, depth = 1;
  for (; i < SRC.length && depth > 0; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') depth--;
  }
  return SRC.slice(m.index, i);
}
const anchored = (n) => {
  const b = fnBody(n);
  assert.ok(b, `${n}() not found — the anchor moved, so this check proves nothing`);
  return b;
};

// ── the stand-in DOM ──────────────────────────────────────────────────────
// A field. `owner` is the section it sits in, which is the whole point.
function field(owner, attrs, value, type) {
  const el = {
    type: type || 'text',
    value: value === undefined ? '' : value,
    checked: !!value,
    _attrs: attrs,
    _owner: owner,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    closest: (sel) => (sel === '[data-blockid]' ? owner : null),
  };
  owner._fields.push(el);
  return el;
}
function sectionEl(blockId) {
  const el = {
    _fields: [],
    getAttribute: (k) => (k === 'data-blockid' ? blockId : null),
    querySelectorAll: (sel) => {
      assert.strictEqual(sel, '[data-bkey]',
        'the copier queried "' + sel + '" — this stand-in only implements [data-bkey]');
      return el._fields;
    },
  };
  return el;
}

// The copier, lifted out of the page and given the two globals it reads.
function loadCopier(blocks) {
  const src = anchored('_paSyncOneSection');
  // A declaration, then return the name. Wrapping it in parens would make it a
  // function EXPRESSION, which never binds the name and fails at the return.
  const make = new Function('window', src + '\nreturn _paSyncOneSection;');
  return make({ _paBlocks: blocks });
}

section('One section’s words go into one section’s block');

check('two sections on screen: typing in one leaves the other untouched', () => {
  const blocks = [
    { id: 'b1', type: 'hero_intro', body_en: 'first', body_cn: '' },
    { id: 'b2', type: 'notes_callout', text_en: 'second', text_cn: '' },
  ];
  const sync = loadCopier(blocks);
  const s1 = sectionEl('b1');
  const s2 = sectionEl('b2');
  field(s1, { 'data-bkey': 'body_en' }, 'REWRITTEN ONE');
  field(s2, { 'data-bkey': 'text_en' }, 'REWRITTEN TWO');

  sync(s1);
  assert.strictEqual(blocks[0].body_en, 'REWRITTEN ONE', 'section one did not write its own field');
  assert.strictEqual(blocks[1].text_en, 'second',
    "section one's sweep reached into section two — this is the §144 failure");
  sync(s2);
  assert.strictEqual(blocks[1].text_en, 'REWRITTEN TWO', 'section two did not write its own field');
  assert.strictEqual(blocks[0].body_en, 'REWRITTEN ONE', 'section two clobbered section one');
});

check('a field claimed by another section is refused, not copied', () => {
  /* A field whose closest('[data-blockid]') is somebody else must be skipped.
     Nothing nests today; the guard is what stops a future nesting from
     silently re-creating the bug. */
  const blocks = [{ id: 'b1', type: 'hero_intro', body_en: 'keep me' }];
  const sync = loadCopier(blocks);
  const mine = sectionEl('b1');
  const other = sectionEl('b2');
  const stray = field(mine, { 'data-bkey': 'body_en' }, 'STRAY');
  stray.closest = () => other;        // it belongs to b2, it is merely inside b1
  sync(mine);
  assert.strictEqual(blocks[0].body_en, 'keep me',
    "a field owned by another section was copied into this one's block");
});

check('the whole document walk visits every section, not just the first', () => {
  const walk = anchored('paBlocksSyncFromDOM');
  assert.ok(/querySelectorAll\(/.test(walk),
    'paBlocksSyncFromDOM still picks a single element — with nine sections it will sync one');
  assert.ok(/\.pa-sec\[data-blockid\]/.test(walk),
    'the walk does not select the sections by their own marker');
  assert.ok(!/querySelector\(['"`]\[data-blockid\]/.test(walk),
    'the retired single-block lookup is still there');
});

section('The shapes the copier has always handled still work');

check('cells, rows and sub-objects still land where they belong', () => {
  const blocks = [
    { id: 'b1', type: 'spec_strip', cells: [{ k_en: 'Type' }] },
    { id: 'b2', type: 'why', rows: [{}, {}] },
    { id: 'b3', type: 'storage_box', left: { head_en: 'old' } },
  ];
  const sync = loadCopier(blocks);
  const s1 = sectionEl('b1'); field(s1, { 'data-bkey': 'v_en', 'data-cellidx': '0' }, '330 ml');
  const s2 = sectionEl('b2'); field(s2, { 'data-bkey': 'claim_en', 'data-rowidx': '1' }, 'second claim');
  const s3 = sectionEl('b3'); field(s3, { 'data-bkey': 'head_en', 'data-sub': 'left' }, 'Cold');
  sync(s1); sync(s2); sync(s3);
  assert.strictEqual(blocks[0].cells[0].v_en, '330 ml', 'a cell value did not land in its cell');
  assert.strictEqual(blocks[0].cells[0].k_en, 'Type', 'writing a cell dropped the rest of it');
  assert.strictEqual(blocks[1].rows[1].claim_en, 'second claim', 'a row value did not land in its row');
  assert.strictEqual(blocks[2].left.head_en, 'Cold', 'a sub-object value did not land');
});

check('a checkbox is still copied verbatim, never inverted', () => {
  /* The §142 rule, re-asserted where the copying now happens: this mechanism
     means "the field equals the input". An inverted control must stay out of
     it — which is why the QR switch carries no data-bkey. */
  const blocks = [{ id: 'b1', type: 'image_band' }];
  const sync = loadCopier(blocks);
  const s1 = sectionEl('b1');
  field(s1, { 'data-bkey': 'lead' }, true, 'checkbox');
  sync(s1);
  assert.strictEqual(blocks[0].lead, true, 'a ticked checkbox did not copy as true');
});

section('No stored block is moved by rendering it');

check('paDocEntries only ever INSERTS placeholders', () => {
  /* 71 distinct block orders are in use and only 56% of products sit inside
     the commonest, so an editor that re-ordered on render would rewrite 115
     live customer pages. The placeholders carry no stored position; the stored
     blocks must come back in the order they went in. */
  const body = anchored('paDocEntries');
  assert.ok(/\.splice\(at, 0, \{ missing: type \}\)/.test(body),
    'paDocEntries does something other than insert a placeholder — it may be moving stored blocks');
  assert.ok(!/\.sort\(/.test(body), 'paDocEntries sorts — that would reorder stored blocks on render');
  assert.ok(!/\.reverse\(/.test(body), 'paDocEntries reverses — that would reorder stored blocks on render');
});

check('putting a page in reading order is asked for, never automatic', () => {
  const body = anchored('paDocReorder');
  assert.ok(/confirm\(/.test(body),
    'the reorder happens without asking — 115 live pages would move on a click nobody meant');
  const render = anchored('paRenderDoc');
  assert.ok(!/paDocReorder\(/.test(render), 'rendering the document triggers a reorder');
  const collect = anchored('paBlocksCollect');
  assert.ok(!/PA_SPINE/.test(collect), 'the save applies the canonical order — it must persist what is there');
});

check('the spine is the nine the catalogue actually carries', () => {
  const m = /const PA_SPINE = \[([\s\S]*?)\];/.exec(SRC);
  assert.ok(m, 'PA_SPINE is gone');
  const types = m[1].match(/'[a-z_]+'/g).map(s => s.replace(/'/g, ''));
  assert.strictEqual(types.length, 9, 'the spine is no longer nine sections');
  for (const t of ['hero_intro', 'spec_strip', 'how_to_use', 'notes_callout', 'ingredients_chips',
                   'why', 'storage_box', 'big_stat', 'allergen_card']) {
    assert.ok(types.includes(t), `${t} is on 73-99% of live products and is not in the spine`);
  }
  assert.ok(!types.includes('nutrition_facts'),
    'nutrition_facts is on 8% of products — it belongs below the spine, not in it');
});

section('The frequency is measured, never asserted');

check('the editor asks for the number and prints nothing when it cannot get one', () => {
  const load = anchored('paLoadUsage');
  assert.ok(/products\/block-usage/.test(load), 'the editor no longer asks for the usage counts');
  assert.ok(/catch/.test(load), 'a failed fetch is unguarded — it would take the editor down with it');
  const pct = anchored('paUsagePct');
  assert.ok(/return null/.test(pct), 'paUsagePct invents a number when it has no data');
  const empty = anchored('_paSecEmpty');
  assert.ok(/pct === null \? '' :/.test(empty),
    'an unwritten section prints a percentage even when none was measured');
});

check('and the number is not hardcoded anywhere in the page', () => {
  const doc = anchored('paRenderDoc') + anchored('_paSecEmpty') + anchored('paDocEntries');
  assert.ok(!/\b(?:99|93|90|89|87|86|84|83|73)\s*%/.test(doc),
    'a measured percentage is compiled into the source — it will be wrong by next quarter');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
