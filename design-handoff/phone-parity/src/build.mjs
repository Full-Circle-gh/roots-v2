/* Writes the phone-parity canvas: project/canvas.json + one .dc.html per frame.
   Usage: node build.mjs <outdir>   (files land in <outdir>/project/) */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { doc } from './kit.mjs';
import { RECIPES } from './recipes.mjs';
import { PURCHASING } from './purchasing.mjs';
import { FINANCE } from './finance.mjs';

const out = join(process.argv[2] || '.', 'project');
mkdirSync(out, { recursive: true });
const W = 390, H = 844, GX = 80, GY = 160, PER = 6;
const PAGES = [['recipes', 'Recipes', RECIPES], ['purchasing', 'Purchasing', PURCHASING], ['finance', 'Finance and accounting', FINANCE]];
const boards = {}, order = [], notes = {};
for (const [pid, pname, frames] of PAGES) {
  notes[`${pid}-title`] = { x: 0, y: -300, text: `${pname} · phone parity`, kind: 'title1', maxW: PER * (W + GX) - GX, page: pid };
  frames.forEach(([key, title, inner], i) => {
    const file = pid === 'recipes' && i === 0 ? 'Main.dc.html' : `${key}.dc.html`;
    writeFileSync(join(out, file), doc(title, inner));
    boards[file] = { x: (i % PER) * (W + GX), y: Math.floor(i / PER) * (H + GY), w: W, h: H, title: `${key.slice(0, 3)} · ${title}`, page: pid };
    order.push(file);
  });
}
const canvas = {
  v: 3, createdOnFiles: { v: 1, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
  title: 'Phone parity — Recipes, Purchasing, Finance',
  launch: { view: 'canvas', page: 'recipes' },
  pages: PAGES.map(([id, name]) => ({ id, name })),
  boards, order, notes, designSystems: [],
};
writeFileSync(join(out, 'canvas.json'), JSON.stringify(canvas, null, 2));
console.log(order.length, 'artboards →', out);
