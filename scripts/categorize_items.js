#!/usr/bin/env node
/**
 * One-shot migration: assign every row in `ingredients` to the right
 * item_kind and category. Idempotent.
 *
 * Usage:
 *   node scripts/categorize_items.js            # dry-run, prints diff
 *   node scripts/categorize_items.js --apply    # actually writes
 *
 * Flow per row:
 *   1. If packaging with non-empty category — leave alone (existing 5 buckets).
 *   2. Run REKIND rules — items obviously in the wrong kind get flipped.
 *      After flipping, classify within the new kind.
 *   3. Otherwise classify within current kind via per-kind rule list.
 *   4. Fallback to "Other / Misc" category for the kind.
 */
const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.argv.find(a => a.startsWith('--db='))?.slice(5)
             || path.join(__dirname, '..', 'data', 'roots.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const lc = s => (s || '').toLowerCase();
const has = (hay, ...needles) => needles.some(n => hay && hay.includes(n));

// =======================================================================
// REKIND rules — flip item to the correct kind. Called only on rows whose
// name strongly indicates they live in the wrong kind. Each returns the
// new `kind` (string) or null. Category is then assigned by the per-kind
// classifier.
// =======================================================================
const REKIND_RULES = [
  // → packaging
  (it) => {
    if (has(it.name_en_lc, 'sticker', 'label paper', 'expiration date', 'date printing', 'thermal paper',
                          'fragile', 'ink for sticker', 'manual coding', 'circle stickers',
                          'plastic wrap', 'packing tape', 'sealing strip', 'winding film',
                          'air column bag', 'honeycomb paper', 'leak proof paper', 'vacuum bag',
                          '#63 black lids', 'black lids', 'pastry bag', 'gel ice pack', 'garbage bag')
       || has(it.name_cn, '标贴','标价纸','标签贴','珍珠棉','封箱','封口膜','蜂窝纸','气柱袋','保鲜膜',
                          '真空袋','缠绕膜','保温冰盒','纸垫','黑色盖子','裱花袋','黑色大垃圾袋','垃圾袋')
       || it.name_en === '245*180')
      return 'packaging';
    return null;
  },

  // → food (food items mistakenly kinded as other / retail / equipment)
  (it) => {
    const currKind = it.item_kind;
    if (currKind === 'food' || currKind === 'packaging') return null;
    if (has(it.name_en_lc, 'french flour', 'whole wheat penne', 'chilli powder', 'chili powder',
                          'frozen edamame', 'edamame', 'organic hibiscus', 'organic pea protein',
                          'rehydrated tofu', 'star anise', 'corn bread', 'lemon zest',
                          'pineapple juice', 'organic soy milk powder', 'soy milk powder',
                          'tortilla chips', 'lemon')
        && currKind !== 'retail')   // tempehs and coffee in retail are SHELF products, leave alone
      return 'food';
    if (currKind === 'other' && (has(it.name_cn, '低筋面粉','脱水无花果','黄柠檬','玫瑰茄','豌豆蛋白',
                                                 '泡发腐竹','八角','辣椒粉','青豆','毛豆','法国王后','面粉')))
      return 'food';
    return null;
  },

  // → equipment (forks miskinded as food)
  (it) => {
    if (it.item_kind === 'food' && (has(it.name_en_lc, 'forks') || it.name_cn === '叉子')) return 'equipment';
    return null;
  },
];

// =======================================================================
// PER-KIND CLASSIFIERS — each returns the category string, or null to
// fall through to the "Other / Misc" fallback for that kind.
// =======================================================================

function classifyFood(it) {
  const en = it.name_en_lc, cn = it.name_cn;

  // Frozen first
  if (en.startsWith('frozen ') || en === 'frozen' || cn.startsWith('冷冻'))
    return 'Frozen 冷冻';

  // Plant Proteins
  if (has(en, 'tempeh','seitan','tofu','yuba','tvp','wheat gluten','textured soy',
              'texture vegetable protein','texture soy protein')
   || has(cn, '天贝','豆腐','腐竹','豆制品','谷朊粉','大豆组织蛋白','素肉','豆干','豆泡','素鸡'))
    return 'Plant Proteins 植物蛋白';

  // Functional Powders & Supplements
  if (has(en, 'biocurcumin','creatine','spirulina','chlorella','matcha','maca powder','moringa',
              'wheatgrass','acai','acerola','reishi','inulin','psyllium','sunflower lechitin',
              'soy protein','hemp protein','pumpkin seed protein','pea protein','probiotic powder',
              'activated carbon','b12','vitamin c','vitamin e','agar','citric acid','alfafa powder',
              'beetroot powder','blackberry powder','raspberry powder','strawberry powder','kale powder',
              'lemon juice powder','organic turmeric powder','organic garlic powder','organic onion powder',
              'carob powder','nutritional yeast','baking soda','unsweetened cocoa','cocoa brick','organic cacao powder')
   || has(cn, '维生素','蛋白粉','螺旋藻','巴西莓粉','小球藻粉','辣木粉','针叶樱桃汁粉','小麦苗粉',
              '黑莓果粉','草莓果粉','树莓粉','苜蓿粉','甜菜根粉','羽衣甘蓝粉','柠檬汁粉','玛卡粉',
              '抹茶粉','灵芝','益生元','菊粉','洋车前','卵磷脂','一水肌酸','琼脂','角豆粉',
              '柠檬酸','活性炭','酸奶发酵粉','营养酵母','姜黄+胡椒碱','Bio姜黄素','面包酵母',
              '小苏打','无糖可可块','有机可可粉','有机姜黄粉'))
    return 'Functional Powders & Supplements 功能粉与营养品';

  // Tea & Coffee (incl. hibiscus tea)
  if (has(en, 'coffee','black tea','green tea','organic mint','organic rose','chai','tea powder','hibiscus')
   || has(cn, '咖啡','红茶','绿茶','玫瑰花茶','薄荷茶','玫瑰茄'))
    return 'Tea & Coffee 茶与咖啡';

  // Plant Milks & Juices
  if (has(en, 'oatly','barista','coconut milk','coconut cream','soy milk','almond milk','plant milk',
              'lemon juice','lime juice','orange juice','pineapple juice','passion fruit juice',
              'peach juice','strawberry juice','ginger juice','tamarind juice','nfc','avocado puree')
   || has(cn, '椰浆','燕麦饮','豆奶','柠檬汁','青柠汁','菠萝汁','百香果汁','水蜜桃','达川草莓浆',
              '姜汁','酸角汁','牛油果泥'))
    return 'Plant Milks & Juices 植物奶与果汁';

  // Oils & Vinegars
  if (/(camillia|coconut|olive|sesame|sunflower|mct)\s*oil/.test(en)
   || /(apple cider|distilled|red wine|rice|white)\s*vinegar/.test(en)
   || has(cn, '山茶油','椰子油','橄榄油','芝麻油','葵花籽油','苹果醋','白醋','红酒醋','糙米醋'))
    return 'Oils & Vinegars 油与醋';

  // Sweeteners
  if (has(en, 'agave','maple','coconut sugar','white sugar','brown sugar')
   || has(cn, '龙舌兰','枫糖','椰子花糖','白糖'))
    return 'Sweeteners 甜味剂';

  // Sauces, Pastes & Pickles
  if (has(en, 'soy sauce','liquid aminos','sciracha','sriracha','miso','curry paste','tomato paste',
              'canned tomato','liquid smoke','dijon','mirin','vegetable broth','fermented tofu','olives',
              'pickles','harissa','mushroom msg')
   || has(cn, '酱油','氨基酸','辣椒酱','味噌','咖喱膏','咖喱酱','番茄酱','番茄罐头','烧烤酱',
              '液体熏制','芥末','味淋','五行蔬菜汤','腐乳','橄榄','酸黄瓜','哈辣酱','香菇粉'))
    return 'Sauces, Pastes & Pickles 酱料与腌渍';

  // Spices, Herbs & Salt
  if (has(en, 'pepper','salt','cinnamon','cardamon','cardamom','cloves','coriander seeds','cumin',
              'curry powder','five spice','garam','garlic powder','ginger powder','onion powder','paprika',
              'mustard seeds','nutmeg','oregano','chili flakes','chilli flakes','star anise','sumac','thyme',
              'turmeric powder','vanilla','sage','rosemary','marjoram','bay leaves','basil leaves','dry mint',
              'dry parsley','shawarma','zatar','italian herb','sichuan','smoked paprika','all spice','allspice',
              'kaffir','galangal','chilli powder','chili powder','dill','cinnamon sticks',
              'big chili pepper','medium chili pepper','small chili pepper','asiabell','chinese angelica')
   || has(cn, '胡椒','盐','肉桂','豆蔻','丁香','香菜籽','孜然','咖喱粉','五香粉','印度综合香料',
              '蒜头粉','大蒜粉','姜粉','洋葱粉','红甜椒粉','芥菜籽','肉豆蒄','皮萨草','辣椒','八角',
              '苏模','百里香','姜黄粉','香草豆荚','香草精','鼠尾草','迷迭香','甘牛至','月桂',
              '罗勒叶','干薄荷','干欧芹','夏威玛','阿拉伯面包调味','意大利香料','麻椒','烟熏辣椒',
              '甘椒粉','泰国柠檬叶','高良姜','莳萝','党参','当归'))
    return 'Spices, Herbs & Salt 香料香草盐';

  // Nuts & Seeds (incl. coconut flake/floss)
  if (has(en, 'almond','cashew','chia seeds','flaxseed','flax seed','hemp seeds','macadamia',
              'pecans','pinenuts','pine nuts','pistachios','pumpkin seeds','peanut','sunflower seeds',
              'walnut','sesame seed','hazelnut','tiger nut','coconut flake','coconut floss')
   || has(cn, '杏仁','腰果','奇亚籽','亚麻籽','火麻仁','夏威夷果','碧根果','雪松仁','开心果','南瓜子',
              '葵花籽','核桃','芝麻','榛子','花生','油莎豆','椰子片','椰蓉'))
    return 'Nuts & Seeds 坚果种子';

  // Dried Fruit & Dates
  if (has(en, 'date','dehydrated','jujube','raisin','dry apple','dry blueberr','dry cranberr','dry prune',
              'dry longan','goji','lotus seed','turkish fig','jackfruit chip','unsweetened apricots',
              'small figs','ugly date','dry jujube','crunchy jujube')
   || has(cn, '椰枣','红枣','葡萄干','桂圆','蓝莓干','蔓越莓干','西梅干','蜜蜜果苹果圈','枸杞',
              '莲子','无花果干','菠萝蜜干','杏干','国产小无花果','土耳其无花果','丑枣','芭蕉干',
              '菠萝干','火龙果干','玉芒干','凯特芒干','香蕉干','混合无花果干','脱水无花果'))
    return 'Dried Fruit & Dates 干果与椰枣';

  // Pantry — Grains, Flours & Beans
  if (has(en, 'oats','oatmeal','rolled oat','buckwheat','rice','quinoa','millet','bulgur','flour','starch',
              'arrowroot','noodle','pasta','penne','fusilli','spaghetti','wrap 10 inch','whole wheat wrap',
              'tapioca','lentil','chickpea','black bean','red kidney bean','cannellini','mung bean',
              'green lentil','red lentil')
   || has(cn, '燕麦','荞麦','米','藜麦','小米','棕麦','面粉','淀粉','葛粉','竹薯粉','面条','意大利面',
              '螺旋面','全麦','西米','扁豆','鹰嘴豆','黑芸豆','红芸豆','小白豆','绿豆芽','紫糯米',
              '低筋面粉'))
    return 'Pantry — Grains, Flours & Beans 谷物豆类与面粉';

  // Fresh Produce (broadest — keep last)
  if (has(en, 'apple','banana','beets','cabbage','carrot','celery','cherry tomato','cilantro','corn',
              'cucumber','eggplant','fresh mint','garlic','ginger','green onion','green apple','jalapeno',
              'kale','kiwi','lemongrass','lemon','lime','lettuce','mango','mushroom','napa','onion',
              'oregano leaf','parsley','potato','purple cabbage','radish','red bell','green bell',
              'yellow bell','shallot','spinach','sweet potato','tomato','zucchini','cauliflower','basil',
              'pepper','sesame leaf','red leaf','fanqian','jinbuhuan','asparagus','edamame')
   || has(cn, '苹果','香蕉','甜菜根','卷心菜','胡萝卜','西芹','樱桃番茄','香菜','玉米','青瓜','茄子',
              '薄荷叶','蒜头','姜','葱','青苹果','墨西哥辣椒','羽衣甘蓝','猕猴桃','香茅','柠檬',
              '青柠檬','生菜','芒果','蘑菇','杏鲍菇','平菇','白玉菇','蟹味菇','白菜','洋葱','牛至叶',
              '欧芹','土豆','紫色包菜','紫色生菜','樱桃萝卜','灯笼椒','圆椒','红葱头','菠菜','红薯',
              '西红柿','云南小瓜','花椰菜','罗勒','番茜','金不换','芝麻菜','番薯叶','红叶','黑茄子',
              '木耳','海带','小米辣','芦笋','毛豆','青豆','黄柠檬'))
    return 'Fresh Produce 新鲜蔬果';

  return null;
}

function classifyEquipment(it) {
  const en = it.name_en_lc, cn = it.name_cn;

  if (has(en, 'bleach','cleaning cloth','dish soap','dishwashing','kitchen paper','tissue','toilet paper',
              'ethyl alcohol','pipe cleaner','sourcing pad','white board brush','fragrance')
   || has(cn, '漂白','抹布','厕纸','卫生纸','厨房用纸巾','抽纸','洗洁精','酒精','管道疏通','百洁布','白板刷'))
    return 'Cleaning & Hygiene 清洁卫生';

  if (has(en, 'ant repellant','cockroach','mosquito') || has(cn, '蚂蚁药','蟑螂药','灭蚊'))
    return 'Pest Control 除虫防虫';

  if (has(en, 'glass jar') || has(cn, '玻璃瓶'))
    return 'Storage Containers 储物容器';

  if (has(en, 'pvc gloves','disposable') || has(cn, '一次性','餐饮级手套'))
    return 'Disposables 一次性用品';

  if (has(en, 'water filter','cable tie','thermal pad','floor drain','adhesive bracket')
   || has(cn, '净水器','过滤器','地漏','扎带','支架','垫片'))
    return 'Maintenance & Parts 维修配件';

  if (has(en, 'bakeware','knife','scissors','powder scoop','clip','steamer','steam','forks')
   || has(cn, '烤盘','烤盆','剪刀','量勺','大夹子','蒸笼','刀','叉子','厨房筷子'))
    return 'Tools & Cookware 工具与厨具';

  return null;
}

function classifyRetail(it) {
  const en = it.name_en_lc, cn = it.name_cn;

  if (has(en, 'tempeh') || has(cn, '天贝'))                       return 'Plant Proteins 植物蛋白';

  if (has(en, 'luuna','period cup','tampons','pads','panty liners')
   || has(cn, '卫生巾','月经杯','卫生护垫','卫生棉条'))           return 'Feminine Care 女性护理';

  if (has(en, 'lipstick','lip oil','cleansing balm','cleansing pads','puff','sober beauty','tinted')
   || has(cn, '唇膏','唇油','卸妆','美妆蛋'))                     return 'Cosmetics & Beauty 彩妆护肤';

  if (has(en, 'cleaner','cleaning','laundry','hand soap','dish soap','fruit & vegetable wash',
              'toilet cleaner','stain remover','glass clean','bathroom & shower','multiple purpose')
   || has(cn, '清洁','洗衣','洗手液','马桶','果蔬清','除污','多用途喷雾'))                                       return 'Home Care 家居清洁';

  if (has(en, 'b12','iron') || has(cn, '铁'))                    return 'Supplements 营养品';

  if (has(en, 'coffee','cacao nibs','tortilla','soy milk powder','pineapple juice','lemon zest','corn bread')
   || has(cn, '咖啡','可可碎','玉米片','豆浆粉','菠萝汁','柠檬皮','玉米卷'))                                  return 'Pantry & Beverages 杂货与饮品';

  return null;
}

function classifyOther(it) {
  if (has(it.name_cn, '梯','储物架','厨房帽','厨房筷','样品'))
    return 'Office & Warehouse 办公与仓储';
  return null;
}

function classifyPackaging(it) {
  const en = it.name_en_lc, cn = it.name_cn;
  if (has(en, 'sticker','label','fragile','expiration date','date printing','ink for sticker',
              'manual coding','thermal paper','circle sticker')
   || has(cn, '标贴','标价纸','标签贴'))
    return 'Labels 标签';

  if (has(en, 'plastic wrap','packing tape','sealing strip','winding film','air column bag','honeycomb',
              'leak proof paper','vacuum bag','pastry bag','garbage bag','wrap')
   || has(cn, '珍珠棉','封箱','封口膜','蜂窝纸','气柱袋','保鲜膜','真空袋','缠绕膜','纸垫','裱花袋',
              '黑色大垃圾袋','垃圾袋'))
    return 'Bags & Wraps 袋装';

  if (has(en, 'lid','jar') || has(cn, '盖子','保温冰盒'))
    return 'Containers 容器';

  return null;
}

// =======================================================================
// Main classify
// =======================================================================

const FALLBACK = {
  food:       'Other Food 其他食材',
  equipment:  'Other Equipment 其他设备',
  retail:     'Other Retail 其他',
  other:      'Misc 杂项',
  packaging:  'Other Packaging 其他包装',
};

function classify(row) {
  const it = {
    item_kind:  row.item_kind,
    category:   row.category || '',
    name_en:    row.name_en || '',
    name_en_lc: lc(row.name_en),
    name_cn:    row.name_cn || '',
  };

  // 1. Packaging with existing category — leave alone
  if (it.item_kind === 'packaging' && it.category) {
    return { kind: 'packaging', category: it.category };
  }

  // 2. Run REKIND rules
  for (const rule of REKIND_RULES) {
    const newKind = rule(it);
    if (newKind && newKind !== it.item_kind) {
      it.item_kind = newKind;
      break;
    }
  }

  // 3. Classify within (possibly new) kind
  let cat = null;
  if (it.item_kind === 'food')      cat = classifyFood(it);
  else if (it.item_kind === 'equipment') cat = classifyEquipment(it);
  else if (it.item_kind === 'retail')    cat = classifyRetail(it);
  else if (it.item_kind === 'other')     cat = classifyOther(it);
  else if (it.item_kind === 'packaging') cat = classifyPackaging(it);

  return { kind: it.item_kind, category: cat || FALLBACK[it.item_kind] };
}

// =======================================================================
// Run
// =======================================================================

const rows = db.prepare('SELECT id, item_kind, category, name_en, name_cn FROM ingredients ORDER BY id').all();
console.log(`Loaded ${rows.length} items from ${DB_PATH}`);

const changes = [];
const distribution = {};
for (const row of rows) {
  const next = classify(row);
  const kindChanged = next.kind !== row.item_kind;
  const catChanged  = (next.category || '') !== (row.category || '');
  if (!kindChanged && !catChanged) continue;
  changes.push({ row, next });
  const k = `${next.kind} → ${next.category}`;
  distribution[k] = (distribution[k] || 0) + 1;
}

console.log(`\nProposed changes: ${changes.length} of ${rows.length} items`);
console.log('\nDistribution (changed rows only):');
Object.entries(distribution).sort((a,b)=>b[1]-a[1]).forEach(([k,n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));

const kindFlips = changes.filter(c => c.next.kind !== c.row.item_kind);
console.log(`\nKind flips: ${kindFlips.length}`);
kindFlips.forEach(c => console.log(`  [${c.row.id}] ${c.row.item_kind} → ${c.next.kind}   ${c.row.name_en || ''} ｜ ${c.row.name_cn || ''}`));

const orphans = changes.filter(c => /Other (Food|Equipment|Retail|Packaging)|Misc/.test(c.next.category));
console.log(`\nLanded in "Other/Misc": ${orphans.length}`);
orphans.forEach(c => console.log(`  [${c.row.id}] (${c.next.kind} → ${c.next.category})  ${c.row.name_en || ''} ｜ ${c.row.name_cn || ''}`));

if (!APPLY) {
  console.log('\n(dry-run — no changes written. Re-run with --apply to commit.)');
  process.exit(0);
}

const upd = db.prepare('UPDATE ingredients SET item_kind = ?, category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
const tx  = db.transaction(cs => cs.forEach(c => upd.run(c.next.kind, c.next.category, c.row.id)));
tx(changes);
console.log(`\nApplied ${changes.length} updates.`);
