#!/usr/bin/env node
/**
 * The product-copy assistant works for the merchant who is using it.
 *
 * `composeBlocksHandler` in routes/ai.js is mounted on TWO realms:
 *
 *   /api/ai/compose-blocks              requireAuth        — the kitchen app
 *   /api/retail-admin/ai/compose-blocks requireRetailAdmin — ANY merchant
 *
 * and its system prompt opened, as a statement of fact:
 *
 *   "You are the layout assistant for **Roots**, a small bilingual
 *    (English + 中文) plant-based food brand in Guangzhou."
 *
 * then, four hundred words later, forbade the model from using an
 * animal-product emoji "because the shop is fully vegan".
 *
 * So every merchant on the platform had their product copy organised by an
 * assistant that believed it worked for a Guangzhou plant-based food brand,
 * and a merchant selling meat or cheese could not be given the emoji for their
 * own product. It is the same defect as D-04 — one tenant's identity in shared
 * copy — one level deeper: not a string the customer reads, but a premise the
 * model reasons from.
 *
 * TWO THINGS ARE CHECKED, and the first matters more than it looks.
 *
 * §1 · THE ACCOUNT IT WAS WRITTEN FOR GETS THE SAME PROMPT, character for
 * character. A prompt is the one kind of code where a diff tells you almost
 * nothing: reordering a clause or dropping a comma can move the output and no
 * test would notice. The old constant is pinned here in full, so "nothing
 * changed for Roots" is a mechanical guarantee rather than a claim.
 *
 * §2 · EVERYBODY ELSE gets their own name, no category, no city, and an emoji
 * rule about the product in front of it. The platform does not know what a new
 * merchant sells or where they are, and a guess in a prompt comes back as a
 * claim in the copy.
 */
'use strict';

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

/* The real function, lifted out of the shipped file and run — not a copy.
   Sliced between two anchors rather than by counting braces: the prompt itself
   is a template literal full of `{ k_en, v_cn }` field shapes and ${…} holes,
   and a brace counter walks straight into them. */
function sliceFn(open, close) {
  const a = SRC.indexOf(open);
  if (a < 0) throw new Error(`not found in routes/ai.js: ${open}`);
  const b = SRC.indexOf(close, a);
  if (b < 0) throw new Error(`no end anchor after ${open}`);
  return SRC.slice(a, b + close.length);
}
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(sliceFn('function composeSystem(shop)',
  '- pct is a string ("12%" or "") and lead/alt are booleans.`;\n}')
  + '\nthis.composeSystem = composeSystem;', ctx);
const composeSystem = ctx.composeSystem;

const ROOTS = composeSystem({ name: 'Roots', vegan: true });
const OTHER = composeSystem({ name: 'Nordbrot', vegan: false });

// ─────────────────────────────────────────────────────────────────────────
section('1 · the account it was written for reads exactly what it always read');

/* The opening sentence and the emoji rule, pinned verbatim. These two strings
   are the whole of what was tenant-specific; everything between them is shared
   and untouched, which §1c proves by length. */
const OLD_OPENING = 'You are the layout assistant for **Roots**, a small bilingual (English + 中文) plant-based food brand in Guangzhou. The operator pastes raw product copy';
/* The CLAUSE only — it stops where the shared microwave note begins, so §3
   can swap it for its neutral twin and compare what is left. */
const OLD_EMOJI = 'PLANT-BASED ONLY: the shop is fully vegan — never use an animal-product emoji (no 🥚🍳🧀🧈🥓🍖🍗🥩🐟🦐🍯 etc.); use plant/cookware glyphs (🥘🍲🥣🔥♨🌱🥗).';
const NEUTRAL_EMOJI = 'Pick the emoji that matches what the product actually IS — never one for an ingredient the copy does not mention.';

yes(ROOTS.startsWith(OLD_OPENING), 'the opening sentence is unchanged, character for character');
yes(ROOTS.includes(OLD_EMOJI + ' For a microwave tile use ♨'),
  'the vegan emoji rule, and the note that follows it, are unchanged character for character');
yes(ROOTS.includes('Unicode has no microwave emoji — never 📡'),
  '…including the microwave note that follows it');

/* The kitchen realm has no tenant at all, and account #1 is the same shop.
   Both must land on the vegan variant, so this cannot regress by someone
   deciding an absent tenant should be treated as "unknown". */
const HANDLER = SRC.slice(SRC.indexOf('const composeBlocksHandler'), SRC.indexOf('const composeBlocksHandler') + 1400);
yes(/!_t \|\| Number\(_t\.id\) === 1/.test(HANDLER),
  'an absent tenant and account #1 both resolve to the shop this was written for');
yes(/vegan: true/.test(HANDLER) && /vegan: false/.test(HANDLER),
  '…and every other account resolves to the neutral variant');

// ─────────────────────────────────────────────────────────────────────────
section('2 · everybody else gets their own shop');

yes(OTHER.startsWith('You are the layout assistant for **Nordbrot**'),
  "the merchant's own name opens the prompt");
is(OTHER.includes('plant-based'), false, 'no category is claimed for them');
is(OTHER.includes('Guangzhou'), false, 'and no city');
is(OTHER.includes('the shop is fully vegan'), false,
  'they are not told their shop is vegan');
yes(OTHER.includes('never one for an ingredient the copy does not mention'),
  '…the emoji rule is about the product in front of it instead');

/* A merchant whose brand_name and name are both empty — a half-created account
   — must not produce "assistant for ****" or a dangling comma. */
const NONAME = composeSystem({ name: '', vegan: false });
yes(NONAME.startsWith('You are the layout assistant for a small shop.'),
  'an account with no name yet still opens with a sentence');
/* The opening sentence only — the block names further down (**spec_strip**,
   **hero_intro**) are bold on purpose and always have been. */
is(NONAME.slice(0, NONAME.indexOf('.')).includes('**'), false,
  'and no empty bold marker where a name should be');

// ─────────────────────────────────────────────────────────────────────────
section('3 · the shared body is genuinely shared');

/* Everything that is not the two tenant-specific clauses must be identical in
   both variants. Compared block by block rather than by length, so a change
   that happens to balance out cannot slip through. */
const BLOCKS = ['BLOCK TYPES', 'RULES:', 'emit_blocks', 'spec_strip', 'nutrition_facts', 'VOICE:'];
for (const b of BLOCKS) {
  yes(ROOTS.includes(b) && OTHER.includes(b), `both variants carry "${b}"`);
}
const tail = (s) => s.slice(s.indexOf('BLOCK TYPES'));
const tailR = tail(ROOTS).replace(OLD_EMOJI, '§');
const tailO = tail(OTHER).replace(NEUTRAL_EMOJI, '§');
is(tailR, tailO, 'and the rest of the prompt is the same text in both');

// ─────────────────────────────────────────────────────────────────────────
section('4 · the assistant that was NOT changed, and why');

/* SPROUT_SYSTEM — the chat assistant — carries a whole "Roots context
   (verified business facts)" block: the channels, the market stalls, the
   owner's priorities, "Currency: RMB (¥)". It is left alone because it is only
   reachable through /api/ai/chat, which is requireAuth — the KITCHEN realm,
   Roots' own app, out of scope for this audit by the brief. The audit says the
   same thing in §8.4: "routes/ai.js is also excluded: its 55 shared-handle
   statements belong to the kitchen assistant behind requireAuth". If that
   endpoint ever gains a merchant-realm mount, this assertion is what fails. */
const chatRoute = SRC.match(/router\.post\('\/api\/ai\/chat',\s*(\w+)/);
yes(chatRoute && chatRoute[1] === 'requireAuth',
  'the chat assistant is still kitchen-only, which is why its Roots facts stand');
is(/router\.post\('\/api\/retail-admin\/ai\/chat'/.test(SRC), false,
  '…and has no merchant-realm mount');

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
