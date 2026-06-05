// AI Brand Studio — eval harness.   Run: node eval/brand/run.js
//
// Loads the frozen briefs, runs the REAL generation pipeline when a model key
// is configured (MODEL_API_KEY / ANTHROPIC_API_KEY via lib/model-gateway),
// scores each result with a deterministic rubric, and prints a report. The
// vision / brand-fit (LLM-judge on the rendered screenshot) dimension is a
// documented stub — added in M4 once the render path lands.

const fs = require('fs');
const path = require('path');
const gateway = require('../../lib/model-gateway');
const designer = require('../../lib/brand-designer');
const { runGates } = require('../../lib/brand-gates');

const briefs = JSON.parse(fs.readFileSync(path.join(__dirname, 'briefs.json'), 'utf8'));

// Deterministic score (0..100). Brand-fit/distinctiveness is NOT scored here
// (needs the vision judge); this measures the mechanical floor only.
function scoreDeterministic(result) {
  let s = 0; const notes = [];
  const gates = result.gates || runGates(result.theme, result.layout);
  if (gates.errors.length === 0) s += 30; else notes.push('contrast errors');
  s += Math.max(0, 10 - gates.warnings.length * 5);
  const pr = result.theme.palette || {};
  const roles = ['primary', 'accent', 'surface', 'ink', 'muted'].filter(r => pr[r]);
  s += Math.round((roles.length / 5) * 20);
  const types = (result.layout || []).map(b => b.type);
  if (types.length >= 4) s += 15; else notes.push('thin layout');
  if (types.some(t => t === 'hero_banner' || t === 'greeting')) s += 12; else notes.push('no lead block');
  if (types.some(t => t === 'product_grid' || t === 'featured_item')) s += 13; else notes.push('no product surface');
  return { score: s, notes };
}

async function main() {
  console.log(`AI Brand Studio eval — ${briefs.length} briefs\n`);
  if (!gateway.isConfigured()) {
    console.log('Model not configured (set MODEL_API_KEY or ANTHROPIC_API_KEY).');
    console.log('Briefs + rubric load OK; skipping live generation. Set the key and re-run.');
    return;
  }
  const rows = [];
  for (const b of briefs) {
    process.stdout.write('  ' + b.id.padEnd(26));
    try {
      const result = await designer.generate({ db: null, inputs: b.inputs });
      const { score, notes } = scoreDeterministic(result);
      rows.push({ id: b.id, score });
      console.log('score', String(score).padStart(3), notes.length ? '· ' + notes.join(', ') : '');
    } catch (e) {
      rows.push({ id: b.id, score: 0 });
      console.log('FAIL  ·', e.code || e.message);
    }
  }
  const avg = rows.reduce((a, r) => a + r.score, 0) / (rows.length || 1);
  console.log('\nAverage deterministic score:', avg.toFixed(1), '/ 100   (vision/brand-fit judge = M4)');
}

main().catch(e => { console.error(e); process.exit(1); });
