'use strict';

// WHAT A PRODUCT ASKS, AND WHETHER THE ANSWER IS ALLOWED — one module, two
// doors (§183).
//
// "Hot or iced? Extra shot? How much sugar?" lives in `retail_product_options`
// + `retail_product_option_choices`. Until §183 exactly one surface could ask
// those questions — the QR menu, via §120 — and every rule about them lived
// inside routes/shop-menu.js: which choices a product still offers, how many a
// pick-any group takes, what an answer costs, what gets snapshotted onto the
// order line. The counter till asked nothing, and could not have recorded an
// answer if it had (routes/retail.js resolveManualOrderLines never read one and
// the manual-order INSERT had no options_json in its column list).
//
// THE RULES MOVED HERE RATHER THAN BEING COPIED, and that is the whole point of
// the file. These are money-and-stock rules: what an extra shot adds to a
// price, and which oat milk comes off which shelf. A second copy inside the
// till's endpoint would have drifted from the first, and the shape that drift
// takes is a counter charging a different price from the QR menu for the same
// coffee — invisible until the month's margin does not reconcile. §181's
// sibling lesson is the same one: one rule, stated once, or it is not a rule.
//
// NOTHING HERE TRUSTS THE CALLER'S NUMBERS. A post body carries choice IDS and
// nothing else. Every label, every question, every price delta and every shelf
// link is read back out of this tenant's own tables. A delta that arrived from
// a phone — or from a till — is not a delta.
//
// WHAT IS DELIBERATELY NOT HERE: availability. Whether a stock-backed extra has
// run out is a question about ONE location's shelf, and the two callers reach
// that answer differently (the QR menu has a shop and its location; the till
// has a store id and its own catalogue read). So both entry points take the
// sold-out verdict as a caller-supplied predicate and neither queries inventory
// from in here. §47's rule — an absent shelf record IS sold out, not "untracked"
// — is therefore enforced by the callers, in the one shape each already had.

const optionLimits = require('./option-limits');

// A single line may not carry an unbounded answer set. Mirrors the ceiling
// routes/shop-menu.js has applied at its own door since §120; stated here so
// the till inherits it rather than having to remember it.
const MAX_CHOICES_PER_LINE = 40;

// The two types a client can render. 'text' exists in the column and is
// half-built — no client draws an input for it and selection state everywhere is
// choice-id keyed, so it can only ever collect nothing. Excluded at every read
// and every write, exactly as the QR menu excludes it.
const ASKABLE_TYPES = ['single', 'multi'];

/* ── READ: what does this product ask? ──────────────────────────────────────
   Returns Map<product_id, [question]>, where a question is the shape both
   clients already render:

     { id, q_en, q_cn, multi, req, min, max, choices: [{ id, en, cn, d, def, out }] }

   `isChoiceSoldOut(choice)` is the caller's shelf. Called once per choice that
   carries a stock_product_id; a sugar level has no shelf and is never asked
   about. Omit it and nothing is sold out, which is the right answer for a
   read that is not location-scoped (a catalogue preview, a test).            */
function questionsForProducts(handle, productIds, { isChoiceSoldOut, withStockLink = false } = {}) {
  const out = new Map();
  const pids = [...new Set((productIds || []).map(n => parseInt(n, 10)).filter(Boolean))];
  if (!pids.length) return out;

  const ph = pids.map(() => '?').join(',');
  const qmarks = ASKABLE_TYPES.map(() => '?').join(',');
  const options = handle.prepare(
    `SELECT id, product_id, question_en, question_cn, type, is_required,
            min_choices, max_choices, sort_order
       FROM retail_product_options
      WHERE product_id IN (${ph}) AND type IN (${qmarks})
      ORDER BY sort_order ASC, id ASC`
  ).all(...pids, ...ASKABLE_TYPES);
  if (!options.length) return out;

  const oph = options.map(() => '?').join(',');
  const choices = handle.prepare(
    `SELECT id, option_id, label_en, label_cn, price_delta, is_default,
            stock_product_id, sort_order
       FROM retail_product_option_choices
      WHERE option_id IN (${oph})
      ORDER BY sort_order ASC, id ASC`
  ).all(...options.map(o => o.id));
  if (!choices.length) return out;

  const dead = (c) => (c.stock_product_id && isChoiceSoldOut ? !!isChoiceSoldOut(c) : false);

  const byOpt = new Map();
  for (const c of choices) {
    if (!byOpt.has(c.option_id)) byOpt.set(c.option_id, []);
    byOpt.get(c.option_id).push({
      id: c.id,
      en: c.label_en || c.label_cn || '',
      cn: c.label_cn || c.label_en || '',
      d: Number(c.price_delta) || 0,
      def: c.is_default ? 1 : 0,
      out: dead(c) ? 1 : 0,
      // WHICH SHELF THIS EXTRA COMES OFF, and OFF by default. The QR menu's
      // payload is served to the public, and an internal product id has no
      // business on a page anybody can open — it is not needed there either,
      // because the shelf that matters is re-read server-side at submit. The
      // counter till asks for it (§183) because it mirrors the shelf locally
      // between catalogue reads, so an oat milk that is also sold as a product
      // of its own has its own tile to keep honest after a sale.
      ...(withStockLink ? { stock_product_id: c.stock_product_id || null } : {}),
    });
  }

  for (const o of options) {
    const cs = byOpt.get(o.id) || [];
    // A QUESTION WITH NOTHING TO ANSWER IT IS NOT ASKED. An option whose
    // choices were all deleted would otherwise render as a heading with empty
    // space under it, and — if it were required — as an order that can never
    // be placed.
    if (!cs.length) continue;
    // HOW MANY of a pick-any group may be ticked, clamped here and NOT on the
    // client. The floor is measured against the choices still pickable, so a
    // "choose 2" whose stock-backed extras have sold down to one asks for one
    // rather than becoming unanswerable — lib/option-limits.js carries the rule.
    const lim = optionLimits.effectiveLimits(o, cs.filter(c => !c.out).length);
    if (!out.has(o.product_id)) out.set(o.product_id, []);
    out.get(o.product_id).push({
      id: o.id,
      q_en: o.question_en || o.question_cn || '',
      q_cn: o.question_cn || o.question_en || '',
      multi: o.type === 'multi' ? 1 : 0,
      // A floor of 1 or more IS required; the flag and the floor agree on save,
      // and the clamp above can only lower the floor, never the flag.
      req: (o.is_required || lim.min > 0) ? 1 : 0,
      min: lim.min,
      max: lim.max,
      choices: cs,
    });
  }
  return out;
}

// Does this product carry a required question that has run out of every answer?
// Such a product cannot be made, and the honest answer on a menu or a tile is
// sold out — NOT a picker the buyer cannot satisfy. §120's rule 1A stops here
// and this is the one place it stops: an OPTIONAL question losing its last
// stock-backed extra greys that extra and sells the drink regardless.
function requiredQuestionIsUnanswerable(questions) {
  return (questions || []).some(q => q.req && q.choices.every(c => c.out));
}

/* ── WRITE: is this answer allowed, what does it cost, what comes off a shelf?
   `lines` is [{ product_id, qty, choices: number[] }] in the caller's own order.

   Returns either

     { error: '<code>', product_id }                     — refuse, naming the line
     { lines: [{ options, delta }], addonWant: Map }     — accept

   `options` is the array that goes into retail_order_items.options_json. It is
   a SNAPSHOT in both languages, so a line still reads "Heat up?: Yes" on the
   ticket, the order page and the till after the option is edited or deleted.
   `label` (not label_en) is the key lib/feie.js reads.

   `delta` is what the answers add to ONE unit of that line. The caller adds it
   to its own base — a shop listing's price, or a till's catalogue price — and
   clamps the result, because which base applies is the caller's question (§42
   puts the price on the listing) and this module does not know it.

   `addonWant` aggregates stock-backed extras across every line, one per unit
   bought, which is how expandStockLines has always counted them. Two sugar
   levels of the same latte are two lines and one shelf.

   `isChoiceSoldOut` is the caller's shelf again, used for the pick-any floor —
   the same clamp the read side applied, so this cannot refuse an order the page
   itself told the buyer to place ("choose 2 sides" with two of three gone is
   served, and accepted, as "choose 1").                                      */
function resolveAnswers(handle, lines, { isChoiceSoldOut } = {}) {
  const rows = (lines || []).map(l => ({
    pid: parseInt(l.product_id, 10),
    qty: Number(l.qty) || 0,
    choices: normaliseChoiceIds(l.choices),
  }));

  for (const r of rows) {
    if (r.choices === null) return { error: 'bad_choice', product_id: r.pid || null };
    if (r.choices.length > MAX_CHOICES_PER_LINE) {
      return { error: 'too_many_choices', product_id: r.pid || null };
    }
  }

  const postedChoiceIds = [...new Set(rows.flatMap(r => r.choices))];
  const orderedPids = [...new Set(rows.map(r => r.pid).filter(Boolean))];

  // Nothing was answered and nothing is asked of these products — the common
  // case for a shelf item, and it must cost no queries at all.
  if (!postedChoiceIds.length && !orderedPids.length) {
    return { lines: rows.map(() => ({ options: [], delta: 0 })), addonWant: new Map() };
  }

  // EVERYTHING BELOW IS ASKED OF THE DATABASE, never of the post body: which
  // product a choice belongs to, what it costs, whether its question was
  // required, and whether the thing it promises is still on a shelf.
  const choiceById = new Map();
  if (postedChoiceIds.length) {
    const cph = postedChoiceIds.map(() => '?').join(',');
    for (const c of handle.prepare(
      `SELECT c.id, c.option_id, c.label_en, c.label_cn, c.price_delta, c.stock_product_id,
              o.product_id, o.type, o.is_required, o.min_choices, o.max_choices,
              o.question_en, o.question_cn
         FROM retail_product_option_choices c
         JOIN retail_product_options o ON o.id = c.option_id
        WHERE c.id IN (${cph})`
    ).all(...postedChoiceIds)) choiceById.set(c.id, c);
  }

  // Every question the products on this order carry, so a REQUIRED one that was
  // simply left out of the post body is caught. Both clients block on it too,
  // and neither client is the thing being trusted.
  const pph = orderedPids.map(() => '?').join(',');
  const qmarks = ASKABLE_TYPES.map(() => '?').join(',');
  const questions = orderedPids.length ? handle.prepare(
    `SELECT id, product_id, type, is_required, min_choices, max_choices,
            question_en, question_cn
       FROM retail_product_options
      WHERE product_id IN (${pph}) AND type IN (${qmarks})`
  ).all(...orderedPids, ...ASKABLE_TYPES) : [];

  const liveChoiceCount = new Map();
  // PICKABLE choices, not merely existing ones — a stock-backed extra that has
  // run out is not an answer anybody could have given.
  const pickableChoiceCount = new Map();
  if (questions.length) {
    const qph = questions.map(() => '?').join(',');
    const qChoices = handle.prepare(
      `SELECT option_id, id, stock_product_id FROM retail_product_option_choices
        WHERE option_id IN (${qph})`
    ).all(...questions.map(q => q.id));
    for (const c of qChoices) {
      liveChoiceCount.set(c.option_id, (liveChoiceCount.get(c.option_id) || 0) + 1);
      if (c.stock_product_id && isChoiceSoldOut && isChoiceSoldOut(c)) continue;
      pickableChoiceCount.set(c.option_id, (pickableChoiceCount.get(c.option_id) || 0) + 1);
    }
  }

  const questionsFor = new Map();
  for (const q of questions) {
    // A question with no answers left is not asked — the same rule the read side
    // renders by, and without it a required one could make the product
    // impossible to order rather than merely unanswerable.
    if (!(liveChoiceCount.get(q.id) > 0)) continue;
    if (!questionsFor.has(q.product_id)) questionsFor.set(q.product_id, []);
    questionsFor.get(q.product_id).push(q);
  }

  const addonWant = new Map();
  const out = [];
  for (const r of rows) {
    const seenOpt = new Set();
    // Answers per question on THIS line, so a pick-any group's ceiling can be
    // counted. A duplicate choice id counts once: the tick-box it came from can
    // only be on or off, so posting it twice is not two sides, it is one.
    const answerCount = new Map();
    for (const cid of r.choices) {
      const c = choiceById.get(cid);
      if (!c) return { error: 'bad_choice', product_id: r.pid };
      if (c.product_id !== r.pid) return { error: 'choice_wrong_product', product_id: r.pid };
      if (!ASKABLE_TYPES.includes(c.type)) return { error: 'bad_choice', product_id: r.pid };
      // A single-answer question takes ONE answer. Two would be a price built
      // from a question nobody was shown twice.
      if (c.type === 'single') {
        if (seenOpt.has(c.option_id)) return { error: 'too_many_answers', product_id: r.pid };
        seenOpt.add(c.option_id);
      }
      if (!answerCount.has(c.option_id)) answerCount.set(c.option_id, new Set());
      answerCount.get(c.option_id).add(c.id);
      if (c.stock_product_id) {
        addonWant.set(c.stock_product_id, (addonWant.get(c.stock_product_id) || 0) + r.qty);
      }
    }

    // RULE 2B, SERVER SIDE. Both clients block first and name the question;
    // this is the same rule where it cannot be skipped by posting straight at
    // the endpoint.
    const answered = new Set(r.choices.map(cid => choiceById.get(cid).option_id));
    for (const q of (questionsFor.get(r.pid) || [])) {
      const lim = optionLimits.effectiveLimits(q, pickableChoiceCount.get(q.id) || 0);
      const n = (answerCount.get(q.id) || new Set()).size;
      // The refusal NAMES THE QUESTION as well as the line. "Please choose:
      // Whole-Wheat Pita" reads as nonsense to a customer who already chose the
      // pita; "Please choose: Sliced or whole?" tells them what is missing.
      const named = { product_id: r.pid, question_en: q.question_en || null, question_cn: q.question_cn || null };
      if (lim.max && n > lim.max) return { error: 'too_many_answers', ...named };
      if (lim.min && n < lim.min) return { error: 'too_few_answers', ...named };
      if (q.is_required && !answered.has(q.id)) return { error: 'choice_required', ...named };
    }

    // THE SNAPSHOT AND THE SUM. The answers keep the order they were posted in,
    // which is the order the questions were asked.
    let delta = 0;
    const options = r.choices.map(cid => {
      const c = choiceById.get(cid);
      delta = Math.round((delta + (Number(c.price_delta) || 0)) * 100) / 100;
      return {
        option_id: c.option_id, choice_id: c.id,
        label: c.label_en, label_cn: c.label_cn || null,
        question_en: c.question_en || null, question_cn: c.question_cn || null,
        delta: Number(c.price_delta) || 0,
        stock_product_id: c.stock_product_id || null,
      };
    });
    out.push({ options, delta });
  }

  return { lines: out, addonWant };
}

// Posted ids, cleaned. Returns null — not [] — when one of them is not an id at
// all, so the caller can tell "answered nothing" from "answered nonsense".
// De-duplicated, because a tick-box is on or off and posting it twice is one
// answer written twice.
function normaliseChoiceIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const c of raw) {
    const cid = parseInt(c, 10);
    if (!Number.isInteger(cid) || cid < 1) return null;
    if (out.indexOf(cid) < 0) out.push(cid);
  }
  return out;
}

/* ── QUICK ADD: must this product ask before it goes in the cart? ───────────
   The `has_options` flag every list ships (§435, §438) means exactly this, and
   since §440 it is NOT "has any options". A product whose only questions are
   optional pick-any groups — the dips' "Add extras?" — goes straight in from a
   +, a favourite, "Buy again" or a bundle; its extras stay on its own page.

   A product asks first when any askable group is:
     - pick-one (a dressing, "heat up?") — required or not, a pick-one is a
       real question, which is why the soups still ask;
     - required, or has a minimum, on a pick-any;
     - carrying a default choice: the sheet pre-ticks it, a quick add would
       silently leave it out.
   'text' groups are never asked (see ASKABLE_TYPES) so never count.

   `productIdExpr` is a trusted SQL column reference ('p.id'), never input.  */
const ASKS_FIRST_WHERE = (o) =>
  `${o}.type IN ('single','multi')
     AND (${o}.type = 'single' OR ${o}.is_required = 1 OR COALESCE(${o}.min_choices, 0) > 0
          OR EXISTS(SELECT 1 FROM retail_product_option_choices c_ask
                     WHERE c_ask.option_id = ${o}.id AND c_ask.is_default = 1))`;

function asksFirstSql(productIdExpr) {
  return `EXISTS(SELECT 1 FROM retail_product_options o_ask
                  WHERE o_ask.product_id = ${productIdExpr} AND ${ASKS_FIRST_WHERE('o_ask')})`;
}

module.exports = {
  ASKS_FIRST_WHERE,
  asksFirstSql,
  MAX_CHOICES_PER_LINE,
  ASKABLE_TYPES,
  questionsForProducts,
  requiredQuestionIsUnanswerable,
  resolveAnswers,
  normaliseChoiceIds,
};
