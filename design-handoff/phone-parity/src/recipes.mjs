import { I, hdrTop, hdrPush, moreBtn, tabbar, chips, seg, search, pill, field, kv, li, qty, sw, tick, warn, sheet } from './kit.mjs';

const tabsR = (on) => `<div class="tabs">${[['Details', ''], ['Ingredients', '9'], ['Steps', '5'], ['Cost', '']].map(([l, n]) => `<button class="${l === on ? 'on' : ''}">${l}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>`;
const recHead = () => hdrPush('Garlic dill sour cream', { right: moreBtn });
const summary = `<div class="strip">
    <div><span class="k">Batch cost</span><span class="v">¥86.40</span></div>
    <div><span class="k">Per serving</span><span class="v">¥4.32</span></div>
    <div><span class="k">Sells for</span><span class="v">¥18</span></div>
    <div><span class="k">Margin</span><span class="v">76%</span></div>
  </div>`;

const LIST = `
  ${hdrTop('Recipes', { cta: '<button class="cta sm">New recipe</button>' })}
  <div class="scroll">
    <p class="status num">42 recipes · 3 need a cost</p>
    ${search('Name, 中文名 or SKU')}
    ${chips([['All', 42, true], ['Made', 31], ['Repacked', 11], [`Category ${I.down}`, ''], ['Archived', '']])}
    <div class="card" style="overflow:hidden">
      ${li('Garlic dill sour cream', '2,000 g · 20 servings', { r: '¥4.32', rs: 'per serving' })}
      ${li(`Tahini dressing`, `1,200 g · Material · ${'<span style="color:var(--dusk-ink)">backs a material</span>'}`, { r: '¥0.06', rs: 'per g' })}
      ${li('Tabbouleh', '<span style="color:var(--amber-ink)">2 lines have no cost</span>', { r: '—', rs: 'per serving' })}
      ${li('Hummus, classic', '3,000 g · 30 servings', { r: '¥2.95', rs: 'per serving' })}
      ${li('Za’atar flatbread', '<span style="color:var(--brick-ink)">Unit mismatch on 1 line</span>', { r: '¥3.10', rs: 'per serving' })}
      ${li('Pickled turnip', '5,000 g · Repacked', { r: '¥0.02', rs: 'per g' })}
      ${li('Lemon garlic chicken', '4,000 g · 16 servings', { r: '¥11.80', rs: 'per serving' })}
    </div>
    <p class="cap">Cost columns show only to people allowed to see costs. Everyone else sees the same list without money.</p>
  </div>
  ${tabbar('more')}`;

const DETAILS = `
  ${recHead()}
  <div class="scroll">
    <p class="status num">2,000 g · 20 servings · Saved</p>
    ${summary}
    ${tabsR('Details')}
    <div class="row2">${field('Name', 'Garlic dill sour cream')}${field('中文名', '蒜香莳萝酸奶油')}</div>
    <div class="row2">${field('SKU', 'TS-10')}${field('Category', 'Sauces', { icon: I.down })}</div>
    ${seg([['Made', true], ['Repacked', false]])}
    <div class="card">
      <div class="li" style="cursor:default"><span class="m"><span class="t">Batch size</span><span class="s">Adds up the lines that count toward weight</span></span><span class="r num">2,000 g</span>${sw(true)}</div>
      <div class="li" style="cursor:default"><span class="m"><span class="t">Servings</span><span class="s">Batch ÷ serving size</span></span><span class="r num">20</span>${sw(true)}</div>
    </div>
    <div class="row2">${field('Serving size', '100', { unit: 'g' })}${field('Shelf life', '5', { unit: 'days' })}</div>
    ${field('Storage', 'Chilled 0–4 °C', { icon: I.down })}
  </div>
  <div class="foot"><button class="btn2">${I.scale}Make it</button></div>`;

const ING = `
  ${recHead()}
  <div class="scroll">
    <p class="status num">9 ingredients · batch 2,000 g · Saving…</p>
    ${tabsR('Ingredients')}
    ${warn('brick', 'Unit mismatch on Dill, fresh: the recipe says bunch, the material is bought by g. Pick a unit it can convert.')}
    <div class="card" style="overflow:hidden">
      <div class="line"><div class="top"><span class="grip">${I.grip}</span><span class="nm">Sour cream 20%</span><span class="num cap">¥38.00</span></div>
        <div class="bot">${qty('1,500')}<span>g</span><span class="sp"></span><span>Counts to weight</span>${sw(true)}</div></div>
      <div class="line"><div class="top"><span class="grip">${I.grip}</span><span class="nm">Garlic confit ${pill('dusk', 'Recipe')}</span><span class="num cap">¥9.60</span></div>
        <div class="bot">${qty('120')}<span>g</span><span class="sp"></span><span>Counts to weight</span>${sw(true)}</div></div>
      <div class="line"><div class="top"><span class="grip">${I.grip}</span><span class="nm">Dill, fresh ${pill('brick', 'Unit mismatch')}</span><span class="num cap">—</span></div>
        <div class="bot">${qty('2')}<span>bunch</span><span class="sp"></span><span>Counts to weight</span>${sw(true)}</div></div>
      <div class="line"><div class="top"><span class="grip">${I.grip}</span><span class="nm">Lemon juice</span><span class="num cap">¥2.20</span></div>
        <div class="bot">${qty('60')}<span>ml</span><span class="sp"></span><span>Note: fresh only</span></div></div>
      <div class="line"><div class="top"><span class="grip">${I.grip}</span><span class="nm">Salt ${pill('amber', 'No cost')}</span><span class="num cap">—</span></div>
        <div class="bot">${qty('18')}<span>g</span><span class="sp"></span><button class="ghost" style="min-height:32px;color:var(--brick-ink)">Remove</button></div></div>
    </div>
    <button class="btn2">${I.plus}Add ingredient</button>
  </div>`;

const PICK = sheet(ING, 'Add ingredient', `
    ${search('dill')}
    <div class="card" style="overflow:hidden">
      ${li('Dill, fresh', 'Bought · by g · Guangzhou Greens', { r: '¥0.08', rs: 'per g', chev: false })}
      ${li('Dill, dried', 'Bought · by g', { r: '¥0.42', rs: 'per g', chev: false })}
      ${li('Garlic dill sour cream', 'Made by recipe · by g', { r: '¥0.04', rs: 'per g', chev: false })}
      ${li('Dill pickle brine', 'Made by recipe · by ml', { r: '¥0.01', rs: 'per ml', chev: false })}
    </div>
    <p class="cap">Not in the list? A new material is added under Materials, then picked here.</p>`, { h: 560 });

const STEPS = `
  ${recHead()}
  <div class="scroll">
    <p class="status num">5 steps · Saved</p>
    ${tabsR('Steps')}
    ${[['Mix the base', 'Whisk sour cream and lemon juice until smooth.'], ['Add the garlic', 'Fold in the garlic confit. Do not blend.'], ['Chop the dill', 'Fine chop, stalks out. Add last.'], ['Season', 'Salt to taste, 18 g is the start.']].map(([n, t], i) => `
    <div class="card pad" style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:8px"><span class="pill p-mute num">${i + 1}</span><span style="flex:1;font-weight:500">${n}</span>
        <button class="ico" aria-label="Move up" style="width:36px;height:36px">${I.up}</button><button class="ico" aria-label="Move down" style="width:36px;height:36px">${I.down}</button><button class="ico" aria-label="Remove step" style="width:36px;height:36px">${I.trash}</button></div>
      <div class="inp" style="min-height:52px;align-items:flex-start;padding-top:12px">${t}</div>
    </div>`).join('')}
    <button class="btn2">${I.plus}Add step</button>
  </div>`;

const COST = `
  ${recHead()}
  <div class="scroll">
    <p class="status num">Only people allowed to see costs see this tab</p>
    ${summary}
    ${tabsR('Cost')}
    <div class="row2">${field('Labour', '12.00', { unit: '¥ per batch' })}${field('Overhead', '8', { unit: '%' })}</div>
    <div class="row2">${field('Sell price', '18.00', { unit: '¥', focus: true })}${field('Target food cost', '30', { unit: '%' })}</div>
    <div class="card" style="overflow:hidden">
      ${kv('Ingredients', '¥66.20')}
      ${kv('Labour', '¥12.00')}
      ${kv('Overhead 8%', '¥8.20')}
      ${kv('Batch cost', '¥86.40', 'strong')}
      ${kv('Per serving (20)', '¥4.32')}
      ${kv('Food cost at ¥18', '24%')}
      ${kv('Suggested price at 30%', '¥14.40')}
    </div>
    ${warn('amber', '2 lines have no cost yet, so the batch cost is low by their share.')}
  </div>`;

const MENU = sheet(DETAILS, 'Garlic dill sour cream', `
    <div class="card" style="overflow:hidden">
      ${li('Duplicate', 'A copy opens as a new recipe', { lead: I.copy })}
      ${li('Print recipe card', 'Both languages, no money on it', { lead: I.printer })}
      ${li('Version history', '14 saved versions', { lead: I.history })}
      ${li('Stocked as a material', 'On · Garlic dill sour cream (g)', { lead: I.box })}
      ${li('Makes 2 products', 'Sour cream tub 200 g · Loaded fries', { lead: I.tag })}
    </div>
    <button class="danger">${I.archive}Archive recipe</button>
    <p class="cap">Archiving asks first and names the 2 recipes that use it as an ingredient.</p>`, { h: 560 });

const HISTORY = sheet(DETAILS, 'Version history', `
    <p class="cap" style="margin:0">Every save is kept. Restoring makes a new version; nothing is lost.</p>
    <div class="card" style="overflow:hidden">
      ${li('Today 14:02', 'Ash · changed Salt 15 → 18 g', { r: pill('sage', 'Current'), chev: false })}
      ${li('Today 11:40', 'Mei · added step “Season”', { r: '<button class="btn2 sm">Restore</button>', chev: false })}
      ${li('28 Sep 16:15', 'Ash · sell price ¥16 → ¥18', { r: '<button class="btn2 sm">Restore</button>', chev: false })}
      ${li('27 Sep 09:03', 'Mei · batch 1,800 → 2,000 g', { r: '<button class="btn2 sm">Restore</button>', chev: false })}
      ${li('20 Sep 10:22', 'Ash · created', { r: '<button class="btn2 sm">Restore</button>', chev: false })}
    </div>`, { h: 600 });

const MATS = `
  ${hdrTop('Materials', { cta: '<button class="cta sm">New material</button>' })}
  <div class="scroll">
    <p class="status num">186 materials · 4 without a price</p>
    ${seg([['Bought', true], ['Made', false], ['All', false]])}
    ${search('Name, SKU or supplier')}
    ${chips([['All kinds', '', true], ['Dairy', 24], ['Produce', 41], ['Dry goods', 58], ['Packaging', 33]])}
    <div class="card" style="overflow:hidden">
      ${li('Sour cream 20%', 'Dairy · M-0012 · Guangzhou Dairy', { r: '¥128', rs: '¥0.025 / g' })}
      ${li('Dill, fresh', 'Produce · M-0140 · Guangzhou Greens', { r: '¥8', rs: '¥0.08 / g' })}
      ${li('Tahini', 'Dry goods · M-0077 · Levant Foods', { r: '¥96', rs: '¥0.10 / g' })}
      ${li('Salt, fine', '<span style="color:var(--amber-ink)">No buy price yet</span>', { r: '—', rs: '' })}
      ${li('Tub 200 ml', 'Packaging · M-0301', { r: '¥0.45', rs: 'each' })}
    </div>
  </div>
  ${tabbar('more')}`;

const MAT = `
  ${hdrPush('Sour cream 20%', { right: moreBtn })}
  <div class="scroll">
    <p class="status num">Dairy · M-0012 · Saved</p>
    <div class="row2">${field('Name', 'Sour cream 20%')}${field('中文名', '酸奶油 20%')}</div>
    <div class="eyebrow">Buying and cost</div>
    <div class="row2">${field('Buy price', '128.00', { unit: '¥' })}${field('Buy unit', 'case', { icon: I.down })}</div>
    <div class="row2">${field('Contents per pack', '5,000', { unit: 'g' })}${field('Recipe unit', 'g', { icon: I.down })}</div>
    <div class="card" style="overflow:hidden">${kv('Cost per g', '¥0.0256', 'strong')}${kv('Last 3 buys', '¥124 · ¥128 · ¥128')}</div>
    ${field('Supplier', 'Guangzhou Dairy', { icon: I.down })}
    ${field('Allergens', 'Milk', { icon: I.down })}
    <div class="card" style="overflow:hidden">${li('Used in 6 recipes', 'Garlic dill sour cream · Tzatziki · …', { lead: I.utensils })}${li('Purchase history', '11 orders since August', { lead: I.history })}</div>
  </div>`;

const PRODUCT = `
  ${hdrPush('Sour cream tub 200 g', { right: moreBtn })}
  <div class="scroll">
    <p class="status num">Live · ¥18 · 3 stores</p>
    <div class="eyebrow">Made from</div>
    <div class="card" style="overflow:hidden">
      ${li('Garlic dill sour cream', 'Recipe · 200 g per tub', { lead: I.utensils, r: '¥8.64', rs: 'from recipe' })}
      <div class="li" style="cursor:default"><span class="m"><span class="t" style="font-weight:400">Change recipe</span></span><button class="btn2 sm">Change</button><button class="ghost" style="color:var(--brick-ink)">Unlink</button></div>
    </div>
    <div class="eyebrow">What goes into one</div>
    <div class="card" style="overflow:hidden">
      <div class="line"><div class="top"><span class="nm">Garlic dill sour cream</span><span class="num cap">¥8.64</span></div><div class="bot">${qty('200')}<span>g</span></div></div>
      <div class="line"><div class="top"><span class="nm">Tub 200 ml</span><span class="num cap">¥0.45</span></div><div class="bot">${qty('1')}<span>each</span></div></div>
      <div class="line"><div class="top"><span class="nm">Lid label</span><span class="num cap">¥0.08</span></div><div class="bot">${qty('1')}<span>each</span></div></div>
    </div>
    <button class="btn2">${I.plus}Add a material</button>
    <div class="card" style="overflow:hidden">${kv('Cost of one', '¥9.17', 'strong')}${kv('Margin at ¥18', '49%')}</div>
  </div>`;

export const RECIPES = [
  ['R01-RecipesList', 'Recipes · list', LIST],
  ['R02-RecipeDetails', 'Recipe · details (editable)', DETAILS],
  ['R03-RecipeIngredients', 'Recipe · ingredients (editable)', ING],
  ['R04-IngredientPicker', 'Recipe · add ingredient', PICK],
  ['R05-RecipeSteps', 'Recipe · steps (editable)', STEPS],
  ['R06-RecipeCost', 'Recipe · cost & pricing', COST],
  ['R07-RecipeMenu', 'Recipe · more actions', MENU],
  ['R08-RecipeHistory', 'Recipe · version history', HISTORY],
  ['R09-MaterialsList', 'Materials · list', MATS],
  ['R10-Material', 'Material · record', MAT],
  ['R11-ProductRecipeLink', 'Product · made from a recipe', PRODUCT],
];
