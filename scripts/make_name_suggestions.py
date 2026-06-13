# -*- coding: utf-8 -*-
"""Build an exportable workbook of Roots product-name options (EN + CN).
Source: scripts/products_import.json (catalog snapshot, May 9).
Output: Roots-Name-Suggestions.xlsx + .csv

Columns:
  Category | Current EN | Current CN | Suggested EN | Suggested CN
         | Fun EN (dialed up) | Fun CN (dialed up) | Why | Decision (dropdown)

Tiers:
  - Suggested = balanced: clear, punchy, fixes typos/accuracy/missing-CN. Keeps names that are already cool.
  - Fun       = dialed up: bolder wordplay, more personality (still understandable).
Decision dropdown is pre-filled with my recommendation; the team can override.
"""
import csv, openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation

KEEP = "Keep current"
SUG  = "Use suggested"
FUN  = "Use fun"
REV  = "Needs review"

# (Category, Cur EN, Cur CN, Sug EN, Sug CN, Fun EN, Fun CN, Why, Decision)
ROWS = [
# ── Beverages ─────────────────────────────────────────────
("Beverages","Organic Instant Soy Milk Powder","有机即溶豆奶粉",
 "Just-Add-Water Soy Milk","有机即溶豆奶粉","Splash-&-Go Soy Milk","一冲即饮豆奶粉",
 "Lead with the convenience promise.",SUG),

# ── Bites ─────────────────────────────────────────────────
("Bites","Premium Nutella Bars","巧克力榛棒",
 "Choco-Hazel Bars","巧克力榛果棒","Hazelnut Heaven Bars","榛子天堂棒",
 "Drop the Nutella trademark; keep the craving.",SUG),
("Bites","Medjool Boat","椰枣小船",
 "Medjool Date Boats","椰枣小船","Date Boats — All Aboard!","椰枣小船 起航",
 "'Boat' is already cute; tiny tweak adds 'date'.",KEEP),
("Bites","Lemon Bars","清新夏日柠檬棒",
 "Sunny Lemon Bars","夏日柠檬棒","Hello Sunshine Lemon Bars","夏日阳光柠檬棒",
 "Add a little sunshine.",SUG),
("Bites","Chocolate Hemp Protein Bites","巧克力蛋白球",
 "Choco Hemp Protein Bites","巧克力火麻蛋白球","Choco Power Balls","巧克力火麻能量球",
 "Name the hemp; 'power balls' is punchier.",SUG),
("Bites","Snickers","素士力架",
 "Snackers (Peanut-Caramel Bar)","花生焦糖棒","Snackers — Caramel Peanut Punch","焦糖花生暴击棒",
 "Ditch the Snickers trademark with a wink.",SUG),
("Bites","Energy Cubes","花生奇亚能量块",
 "Peanut-Chia Energy Cubes","花生奇亚能量块","Pocket Rocket Energy Cubes","花生奇亚小火箭",
 "Spell out what's inside; fun = pocket-sized punch.",SUG),
("Bites","Mango Protein Bites","芒果蛋白球",
 "Mango Protein Bites","芒果蛋白球","Mango Tango Protein Bites","芒果探戈蛋白球",
 "Already clear & punchy.",KEEP),

# ── Bread ─────────────────────────────────────────────────
("Bread","Corn Bread","玉米饼子",
 "Golden Corn Bread","黄金玉米面包","Sunshine Corn Bread","黄金玉米面包",
 "Warmer and more appetising.",SUG),
("Bread","GF Nuts＆Seeds Bread （Frozen）","无麸燕麦种子面包",
 "Nut & Seed Bread (GF, Frozen)","无麸 坚果种子面包（冷冻）","The Seedy Loaf (GF)","无麸 坚果种子面包（冷冻）",
 "Spell GF out; flag frozen.",SUG),
("Bread","Whole Wheat Rye Bread","全麦黑麦面包",
 "Hearty Rye & Wheat Bread","全麦黑麦面包","The Hearty Rye Loaf","全麦黑麦面包",
 "'Hearty' sells the loaf.",SUG),
("Bread","GF Buckwheat Bread （Sliced＆Frozen）","荞麦面包",
 "Buckwheat Bread (GF, Sliced & Frozen)","无麸 荞麦面包（切片·冷冻）","Buckwheat Boss (GF)","无麸 荞麦面包（切片·冷冻）",
 "Surface GF + format.",SUG),
("Bread","Whole Wheat Pita Bread （Frozen）","全麦皮塔面包",
 "Whole-Wheat Pita (Frozen)","全麦皮塔饼（冷冻）","Pocket Pita (Frozen)","全麦口袋皮塔饼（冷冻）",
 "'饼' reads better; 'pocket' is fun & true.",SUG),

# ── Cacao ─────────────────────────────────────────────────
("Cacao","Cacao Mass","可可液块",
 "Pure Cacao Mass","可可液块（纯可可）","100% Cacao Bricks","纯可可液块",
 "Reassure it's 100% cacao.",SUG),
("Cacao","Cacao Nibs","可可粒",
 "Cacao Nibs","可可粒","Cacao Nibs","可可粒",
 "Clean & correct.",KEEP),
("Cacao","Organic Cacao Powder","有机可可粉",
 "Organic Raw Cacao Powder","有机生可可粉","Organic Raw Cacao Powder","有机生可可粉",
 "'Raw' signals the good-for-you grade.",SUG),

# ── Coffee & Tea ──────────────────────────────────────────
("Coffee ＆ Tea","Yunnan Crisp","云南孟连娜允咖啡豆",
 "Yunnan Crisp (Menglian Beans)","云南孟连 · 娜允咖啡豆","Yunnan Crisp","云南孟连 · 娜允咖啡豆",
 "Cool name already; just anchor the origin.",KEEP),
("Coffee ＆ Tea","Black Plum","西双版纳易武咖啡豆",
 "Black Plum (Yiwu Beans)","西双版纳易武 · 咖啡豆","Black Plum","西双版纳易武 · 咖啡豆",
 "Evocative tasting-note name; keep it.",KEEP),
("Coffee ＆ Tea","Yunnan Bundle","云南咖啡套装",
 "Yunnan Coffee Trio","云南咖啡套装","Yunnan Coffee Flight","云南咖啡三重奏",
 "'Trio/Flight' beats 'Bundle'.",SUG),
("Coffee ＆ Tea","Sweat N Sour","云南炮仗山独水井咖啡豆",
 "Sweet 'n' Sour (Yunnan Beans)","云南炮仗山 · 咖啡豆","Sweet 'n' Sour Beans","云南炮仗山 · 咖啡豆",
 "Fix typo (Sweat→Sweet); tidy origin.",SUG),
("Coffee ＆ Tea","Hibiscus Flower Herbal Tea USDA Organic","玫瑰茄",
 "Hibiscus Bloom Tea (Organic)","有机洛神花茶","Ruby Hibiscus Bloom","有机洛神花茶",
 "'Bloom/Ruby' is prettier; CN to familiar 洛神花.",SUG),
("Coffee ＆ Tea","Mint Leaves （Herbal Tea）","薄荷茶",
 "Pure Mint Leaf Tea","纯薄荷叶茶","Cool Mint Leaf Tea","纯薄荷叶茶",
 "'Pure/Cool leaf' lifts it above a teabag.",SUG),

# ── Cooked Grains ─────────────────────────────────────────
("Cooked Grains","Cooked Mix Color Quinoa","现食藜麦",
 "Ready-to-Eat Tri-Colour Quinoa","即食三色藜麦","Quinoa, Ready When You Are","即食三色藜麦",
 "'Ready-to-eat' + colour pop.",SUG),
("Cooked Grains","Cooked Brown Rice","现食糙米饭",
 "Ready-to-Eat Brown Rice","即食糙米饭","Brown Rice, Ready When You Are","即食糙米饭",
 "Match the ready-to-eat framing.",SUG),

# ── Cosmetics ─────────────────────────────────────────────
("Cosmetics","Cloudy Puff Applicator","迷你美妆蛋",
 "Cloud Puff Applicator","迷你美妆蛋","Cloud Puff","云朵美妆蛋",
 "Drop the odd 'Cloudy'; keep dreamy.",SUG),
("Cosmetics","The Standard Natural Foudation","光感植物粉底液",
 "The Standard Natural Foundation","光感植物粉底液","The Standard Foundation","光感植物粉底液",
 "Fix typo (Foudation→Foundation).",SUG),
("Cosmetics","Reusable Natural Cleansing Pads","环保水洗双面卸妆巾",
 "Reusable Cleansing Pads","环保水洗卸妆巾","Wash-&-Wear Cleansing Pads","环保水洗卸妆巾",
 "Trim to essentials.",SUG),
("Cosmetics","Essential Natural Lipstick","植萃天然唇膏",
 "Essential Natural Lipstick","植萃天然唇膏","Essential Natural Lipstick","植萃天然唇膏",
 "Already on-voice.",KEEP),
("Cosmetics","Balmy Stick","—",
 "Balmy Lip Stick","润唇棒","Balmy Lip Stick","润唇棒",
 "Add 'lip' so it's clear; supply missing CN.",SUG),
("Cosmetics","The O.N.E Tinted Lip Oil","润色护唇油",
 "The O.N.E. Tinted Lip Oil","润色护唇油","The O.N.E. Tinted Lip Oil","润色护唇油",
 "Hero name; just tidy punctuation.",KEEP),

# ── Crackers ──────────────────────────────────────────────
("Crackers","Whole Wheat Crackers","哈素萌全麦薄脆",
 "Whole-Wheat Crisp Crackers","全麦薄脆饼","Snap-Happy Whole-Wheat Crackers","全麦薄脆饼",
 "'Crisp/Snap' adds crunch appeal.",SUG),
("Crackers","SuperSeed Crackers","SuperSeed Crackers",
 "Super-Seed Crackers","超级种子薄脆","Super-Seed Crackers","超级种子薄脆",
 "Give it a real Chinese name.",SUG),

# ── Creamery ──────────────────────────────────────────────
("Creamery","Nachos Dip","纯素咸芝士酱",
 "Nacho Cheese Dip","纯素奶酪蘸酱","Game-Night Nacho Cheese","纯素奶酪蘸酱",
 "Say 'cheese' — that's the craving.",SUG),
("Creamery","Cashew Camembert","卡门贝尔",
 "Cashew Camembert","腰果卡门贝尔","Cashew Camembert","腰果卡门贝尔",
 "Strong name; just name the cashew base in CN.",KEEP),

# ── Dairy Alternatives ────────────────────────────────────
("Dairy Alternatives","Oatly Strawberry Flavor","燕麦露草莓味",
 "Oatly Strawberry","Oatly 燕麦露 · 草莓味","Oatly Strawberry","Oatly 燕麦露 · 草莓味",
 "Brand name; just tidy format.",KEEP),
("Dairy Alternatives","Oatly Barista","Oatly 咖啡大师",
 "Oatly Barista","Oatly 咖啡大师","Oatly Barista","Oatly 咖啡大师",
 "Strong brand name.",KEEP),
("Dairy Alternatives","Oatly Chocolate Flavor","Oatly 燕麦露巧克力味",
 "Oatly Chocolate","Oatly 燕麦露 · 巧克力味","Oatly Chocolate","Oatly 燕麦露 · 巧克力味",
 "Trim 'Flavor'.",KEEP),
("Dairy Alternatives","Oatly Classic","Oatly 燕麦露原味",
 "Oatly Classic","Oatly 燕麦露 · 原味","Oatly Classic","Oatly 燕麦露 · 原味",
 "Keep.",KEEP),
("Dairy Alternatives","Kara Coconut Cream","佳乐高浓度椰浆",
 "Kara Coconut Cream","佳乐 高浓椰浆","Kara Coconut Cream","佳乐 高浓椰浆",
 "Brand stays; tighten CN.",KEEP),
("Dairy Alternatives","Coconut Milk （ No Xanthan Gum, No Guar Gum）","丽尔泰椰浆1L",
 "Clean Coconut Milk (No Gums)","丽尔泰椰浆 1L（无胶）","Clean Coconut Milk — Nothing Added","丽尔泰椰浆 1L（无胶）",
 "'Clean / No Gums' is the selling point.",SUG),

# ── Flavor Topping ────────────────────────────────────────
("Flavor Topping","Parmesnuts! （Parmesan）","纯素帕玛森芝士粉",
 "Parmesnuts! (Vegan Parmesan)","纯素帕玛森芝士粉","Parmesnuts!","纯素帕玛森芝士粉",
 "Brilliant pun — keep.",KEEP),
("Flavor Topping","Smokey Parmesan","烟熏版素芝士粉",
 "Smoky Parmesnuts!","烟熏纯素帕玛森粉","Smoky Parmesnuts!","烟熏纯素帕玛森粉",
 "Match the Parmesnuts family; fix 'Smokey'.",SUG),

# ── Flours ────────────────────────────────────────────────
("Flours","Almond Flour","杏仁面粉",
 "Almond Flour","杏仁粉","Almond Flour","杏仁粉",
 "'杏仁粉' reads cleaner.",KEEP),
("Flours","Vital Wheat Gluten Flour","谷朊粉",
 "Vital Wheat Gluten (Seitan Flour)","谷朊粉（面筋粉）","Seitan Flour (Vital Wheat Gluten)","谷朊粉（面筋粉）",
 "Tell people what it's FOR — seitan.",SUG),
("Flours","Chickpeas Flour","鹰嘴豆粉",
 "Chickpea Flour","鹰嘴豆粉","Chickpea Flour","鹰嘴豆粉",
 "Singular reads better.",KEEP),

# ── Frozen ────────────────────────────────────────────────
("Frozen","Frozen Mix Berries, Antioxidant Bomb !","混合莓果",
 "Frozen Mixed Berries — Antioxidant Bomb!","冷冻混合莓果","Antioxidant Bomb Berries","冷冻混合莓果",
 "Keep the fun; flag frozen in CN.",SUG),

# ── Fruits ────────────────────────────────────────────────
("Fruits","Jackfruit Chips","菠萝蜜干",
 "Jackfruit Chips","菠萝蜜干","Jackfruit Chips","菠萝蜜干",
 "Clean — keep.",KEEP),
("Fruits","Dehydrated Pineapple","菠萝干",
 "Dried Pineapple Rings","菠萝干","Pineapple Sunshine Rings","菠萝干",
 "'Dried' beats clinical 'dehydrated'.",SUG),
("Fruits","Deri Dates","椰枣 （Deri）",
 "Deri Dates","Deri 椰枣","Deri Dates","Deri 椰枣",
 "Tidy CN order.",KEEP),
("Fruits","Dehydrated Figs","芭劳奈无花果干",
 "Dried Figs","芭劳奈无花果干","Dried Figs","芭劳奈无花果干",
 "Simpler EN.",SUG),
("Fruits","Dehydrated Sweet Banana","香蕉干",
 "Dried Sweet Banana","香蕉干","Banana Chews","香蕉干",
 "Swap 'dehydrated' for 'dried'.",SUG),
("Fruits","Dehydrated Dragon Fruit","火龙果干",
 "Dried Dragon Fruit","火龙果干","Dried Dragon Fruit","火龙果干",
 "Same.",SUG),
("Fruits","Dehydrated Chinese Banana","芭蕉干",
 "Dried Baby Banana","芭蕉干","Baby Banana Chews","芭蕉干",
 "'Baby banana' is friendlier than 'Chinese'.",SUG),
("Fruits","Dehydrated Yu Mango","云南玉芒干",
 "Dried Yunnan Mango","云南玉芒干","Yunnan Mango Strips","云南玉芒干",
 "Lead with the Yunnan origin.",SUG),
("Fruits","Sun-Dried Apricots","阳光晒干杏脯",
 "Sun-Dried Apricots","阳光晒干杏脯","Sun-Dried Apricots","阳光晒干杏脯",
 "Lovely as is.",KEEP),
("Fruits","Soft Dehydrated Apples","脱水苹果干",
 "Soft Dried Apples","松软苹果干","Pillowy Apple Bites","松软苹果干",
 "'Soft/Pillowy' is the texture sell.",SUG),
("Fruits","Whole Unsweetened Dry Blueberries","蓝莓干",
 "Whole Dried Blueberries (No Sugar)","无糖蓝莓干","Wild Blueberries — No Sugar","无糖蓝莓干",
 "Push the no-sugar point.",SUG),
("Fruits","Turkish Figs","土耳其无花果干",
 "Turkish Dried Figs","土耳其无花果干","Turkish Dried Figs","土耳其无花果干",
 "Add 'dried' for clarity.",SUG),
("Fruits","Medjool Dates （Misfits）","丑丑帝王椰枣",
 "Medjool Dates — The Misfits","丑丑帝王椰枣","The Misfit Medjools","丑丑帝王椰枣",
 "Lean into the cute 'misfits' story.",SUG),
("Fruits","Medjool Dates （Jumbo Size）","以色列帝王椰枣",
 "Jumbo Medjool Dates","以色列帝王椰枣（大果）","Jumbo Medjools","以色列帝王椰枣（大果）",
 "Size up front; flag jumbo in CN.",SUG),
("Fruits","Dry Raisins （Unsweetened）","加州大葡萄干",
 "California Raisins (No Sugar)","加州大葡萄干（无糖）","California Raisins — No Sugar","加州大葡萄干（无糖）",
 "Origin + no-sugar.",SUG),
("Fruits","Whole Unsweetened Dry Cranberries","无糖大兴安岭蔓越莓干",
 "Whole Cranberries (No Sugar)","无糖蔓越莓干","Whole Cranberries — No Sugar","无糖蔓越莓干",
 "Trim the long EN; sharpen CN.",SUG),
("Fruits","Dehydrated Sweet Mango","凯特芒果干",
 "Dried Kent Mango","凯特芒果干","Dried Kent Mango","凯特芒果干",
 "Name the variety (Kent).",SUG),
("Fruits","USDA Organic Goji Berries","枸杞",
 "Organic Goji Berries","有机枸杞","Organic Goji Berries","有机枸杞",
 "Front-load 'organic'; add to CN.",SUG),
("Fruits","Crunchy Jujubes （Chinese Dates）","红枣片",
 "Crunchy Jujube Crisps","脆红枣片","Crunchy Jujube Crisps","脆红枣片",
 "'Crisps' nails the texture.",SUG),
("Fruits","Dehydrated Coconut Flakes","脱水椰子片",
 "Toasted Coconut Flakes","椰子脆片","Toasted Coconut Flakes","椰子脆片",
 "'Flakes/脆片' sounds snackable.",SUG),
("Fruits","Nour Dates","诺意椰枣",
 "Nour Dates","诺意椰枣","Nour Dates","诺意椰枣",
 "Keep.",KEEP),

# ── Gelato ────────────────────────────────────────────────
("Gelato","Raspberry Mango Sorbet","树莓芒果冰淇淋",
 "Raspberry-Mango Sorbet","树莓芒果雪葩","Raspberry-Mango Sorbet","树莓芒果雪葩",
 "Sorbet = 雪葩, not 冰淇淋 (accuracy).",SUG),

# ── Grains & Pasta ────────────────────────────────────────
("Grains ＆ Pasta","Whole Wheat Spaghetti","全麦意大利面",
 "Whole-Wheat Spaghetti","全麦意面","Whole-Wheat Spaghetti","全麦意面",
 "'意面' is the everyday word.",SUG),
("Grains ＆ Pasta","Whole Wheat Fusilli Pasta","螺旋意大利面",
 "Whole-Wheat Fusilli","全麦螺旋意面","Whole-Wheat Fusilli","全麦螺旋意面",
 "Add 'whole-wheat' to CN.",SUG),
("Grains ＆ Pasta","Mix Colored Quinoa","混合藜麦",
 "Tri-Colour Quinoa","三色藜麦","Tri-Colour Quinoa","三色藜麦",
 "More vivid & specific.",SUG),
("Grains ＆ Pasta","Organic Quick Cooking Oats","即食燕麦",
 "Organic Quick Oats","有机即食燕麦","Organic Quick Oats","有机即食燕麦",
 "Add 'organic' to CN.",SUG),
("Grains ＆ Pasta","Brown Rice  （Long Grain）","糙米",
 "Long-Grain Brown Rice","长粒糙米","Long-Grain Brown Rice","长粒糙米",
 "Specify long-grain in CN.",SUG),
("Grains ＆ Pasta","Old Fashioned Oats","传统快熟燕麦",
 "Old-Fashioned Rolled Oats","传统压片燕麦","Old-Fashioned Rolled Oats","传统压片燕麦",
 "'Rolled' clarifies the cut.",SUG),

# ── Granola ───────────────────────────────────────────────
("Granola","Anti Inflammatory Granola","无糖格兰诺拉荞麦片",
 "Calm Buckwheat Granola (No Sugar)","无糖荞麦格兰诺拉","Calm Buckwheat Granola","无糖荞麦格兰诺拉",
 "'Calm' > clunky 'anti-inflammatory'.",SUG),
("Granola","Crunchy Granola","格兰诺拉脆麦片",
 "Crunchy Granola","格兰诺拉脆麦片","Crunchy Cluster Granola","格兰诺拉脆麦片",
 "Does the job; clusters = texture.",KEEP),

# ── GrassRoots Cheese Alternatives ────────────────────────
("GrassRoots Cheese Alternatives","Mozarella Style Shred","马苏里拉素奶酪碎",
 "Mozzarella-Style Shreds","马苏里拉风味素奶酪碎","Melt-Me Mozzarella Shreds","马苏里拉风味素奶酪碎",
 "Fix 'Mozarella' spelling.",SUG),
("GrassRoots Cheese Alternatives","Colby Jack Style Shreds","混合素奶酪碎",
 "Colby Jack-Style Shreds","双色素奶酪碎","Colby Jack-Style Shreds","双色素奶酪碎",
 "Name the style in CN (双色).",SUG),
("GrassRoots Cheese Alternatives","Cheddar-Style Shreds","车达素奶酪碎",
 "Cheddar-Style Shreds","车达风味素奶酪碎","Cheddar-Style Shreds","车达风味素奶酪碎",
 "Add 风味 for consistency.",KEEP),

# ── House Care ────────────────────────────────────────────
("House Care","Essentials Bundle","天然精油系列套装",
 "Essential Oils Starter Set","天然精油入门套装","The Essentials Kit","天然精油入门套装",
 "'Starter set' invites first-timers.",SUG),
("House Care","Floor Cleaner","地板清洁液",
 "Floor Cleaner","地板清洁液","Floor Cleaner","地板清洁液",
 "Clear — keep.",KEEP),
("House Care","Kitchen Bundle","厨房清洁系列套装",
 "Kitchen Clean Set","厨房清洁套装","Kitchen Clean Kit","厨房清洁套装",
 "Tighten.",SUG),
("House Care","Complete Range Bundle","全套系列",
 "The Whole-Home Set","全屋清洁套装","The Whole-Home Kit","全屋清洁套装",
 "Says exactly what you get.",SUG),
("House Care","Laundry Bundle","衣物洗护系列套装",
 "Laundry Care Set","衣物洗护套装","Laundry Care Kit","衣物洗护套装",
 "Tighten.",SUG),
("House Care","Baby Bundle","婴幼儿套装",
 "Baby-Safe Set","婴幼儿呵护套装","Baby-Safe Kit","婴幼儿呵护套装",
 "'Safe' reassures parents.",SUG),
("House Care","Bathroom Bundle","浴室清洁系列套装",
 "Bathroom Clean Set","浴室清洁套装","Bathroom Clean Kit","浴室清洁套装",
 "Tighten.",SUG),
("House Care","Cream Cleaner","柑橘精油强力清洁乳",
 "Citrus Cream Cleaner","柑橘精油强力清洁乳","Citrus Cream Cleaner","柑橘精油强力清洁乳",
 "Name the citrus scent in EN.",SUG),
("House Care","Foaming Hand Soap （Lemongrass）","柠檬草精油泡沫洗手液",
 "Foaming Hand Soap — Lemongrass","柠檬草泡沫洗手液","Foaming Hand Soap — Lemongrass","柠檬草泡沫洗手液",
 "Scent up front.",SUG),
("House Care","Foaming Hand Soap （Mint）","薄荷精油泡沫洗手液",
 "Foaming Hand Soap — Mint","薄荷泡沫洗手液","Foaming Hand Soap — Mint","薄荷泡沫洗手液",
 "Same pattern.",SUG),
("House Care","Foaming Hand Soap 5L（Lemongrass）","柠檬草精油泡沫洗手液 5L",
 "Foaming Hand Soap 5L — Lemongrass","柠檬草泡沫洗手液 5L（补充装）","Hand Soap Refill 5L — Lemongrass","柠檬草泡沫洗手液 5L（补充装）",
 "Mark 5L as a refill.",SUG),
("House Care","Multi Purpose Spray","多用途喷雾",
 "Multi-Purpose Spray","多用途清洁喷雾","Multi-Purpose Spray","多用途清洁喷雾",
 "Add 清洁 for clarity.",SUG),
("House Care","Laundry Powder","洗衣粉",
 "Laundry Powder","洗衣粉","Laundry Powder","洗衣粉",
 "Keep.",KEEP),
("House Care","Glass Cleaner 5L","玻璃清洁液 5L",
 "Glass Cleaner 5L (Refill)","玻璃清洁液 5L（补充装）","Glass Cleaner Refill 5L","玻璃清洁液 5L（补充装）",
 "Flag refill size.",SUG),
("House Care","SoapNut Republic Dish Soap 5L","西柚精油洗碗液 5L",
 "SoapNut Republic Dish Soap 5L — Grapefruit","西柚精油洗碗液 5L（补充装）","SoapNut Dish Soap Refill 5L — Grapefruit","西柚精油洗碗液 5L（补充装）",
 "Brand stays; note scent + refill.",SUG),
("House Care","Fruit ＆ Vegetable Wash","果蔬清洗液",
 "Fruit & Veggie Wash","果蔬清洗液","Fruit & Veggie Spa Wash","果蔬清洗液",
 "Friendlier 'veggie'.",SUG),
("House Care","Foaming Hand Soap （Lavender）","薰衣草精油泡沫洗手液",
 "Foaming Hand Soap — Lavender","薰衣草泡沫洗手液","Foaming Hand Soap — Lavender","薰衣草泡沫洗手液",
 "Same pattern.",SUG),
("House Care","SoapNut Republic Laundry Liquid 5L","柠檬草精油洗衣液 5L",
 "SoapNut Republic Laundry Liquid 5L — Lemongrass","柠檬草精油洗衣液 5L（补充装）","SoapNut Laundry Liquid Refill 5L — Lemongrass","柠檬草精油洗衣液 5L（补充装）",
 "Brand + scent + refill.",SUG),
("House Care","Bathroom ＆ Shower Spray","柑橘精油浴室清洁液",
 "Bathroom & Shower Spray — Citrus","柑橘精油浴室喷雾","Bathroom & Shower Spray — Citrus","柑橘精油浴室喷雾",
 "Name the scent in EN.",SUG),
("House Care","Natural Stain Remover","天然强效污渍清洁液",
 "Natural Stain Remover","天然强效去渍液","Tough-Love Stain Remover","天然强效去渍液",
 "'去渍' is punchier in CN.",SUG),
("House Care","Hand Soap Trio","洗手液三件套",
 "Hand Soap Trio","洗手液三件套","Hand Soap Trio","洗手液三件套",
 "Already punchy.",KEEP),
("House Care","Dish Soap","西柚精油洗碗液",
 "Dish Soap — Grapefruit","西柚精油洗碗液","Dish Soap — Grapefruit","西柚精油洗碗液",
 "Name the scent in EN.",SUG),
("House Care","SoapNut Republic Floor Cleaner 5L","桉树精油地板清洁液 5L",
 "SoapNut Republic Floor Cleaner 5L — Eucalyptus","桉树精油地板清洁液 5L（补充装）","SoapNut Floor Cleaner Refill 5L — Eucalyptus","桉树精油地板清洁液 5L（补充装）",
 "Brand + scent + refill.",SUG),
("House Care","Glass Cleaner","玻璃清洁液",
 "Glass Cleaner","玻璃清洁液","Glass Cleaner","玻璃清洁液",
 "Keep.",KEEP),
("House Care","Laundry Soaker","浸泡粉",
 "Laundry Soaker","衣物浸泡粉","Laundry Pre-Soak","衣物浸泡粉",
 "Add 衣物 so it's clearly for laundry.",SUG),
("House Care","Toilet Cleaner","洗手间清洁液",
 "Toilet Cleaner","马桶清洁液","Toilet Cleaner","马桶清洁液",
 "'马桶' is the precise word.",SUG),
("House Care","Laundry Liquid","柠檬草精油洗衣液",
 "Laundry Liquid — Lemongrass","柠檬草精油洗衣液","Laundry Liquid — Lemongrass","柠檬草精油洗衣液",
 "Name the scent in EN.",SUG),

# ── Jams ──────────────────────────────────────────────────
("Jams","Apple Sauce","苹果酱",
 "Apple Sauce","苹果酱","Apple Sauce","苹果酱",
 "Keep.",KEEP),
("Jams","Blueberries Chia Jam","蓝莓奇亚籽果酱",
 "Blueberry Chia Jam","蓝莓奇亚籽果酱","Blueberry Chia Jam","蓝莓奇亚籽果酱",
 "Singular reads cleaner.",SUG),
("Jams","Strawberry Lemon Jam","草莓奇亚籽果酱",
 "Strawberry-Lemon Chia Jam","草莓柠檬奇亚籽果酱","Strawberry-Lemon Chia Jam","草莓柠檬奇亚籽果酱",
 "EN omits lemon→add; CN omits→add.",SUG),
("Jams","Cherry Ginger Jam","—",
 "Cherry-Ginger Jam","樱桃生姜果酱","Cherry-Ginger Jam","樱桃生姜果酱",
 "Supply the missing CN.",SUG),

# ── Juices ────────────────────────────────────────────────
("Juices","Cashew Strawberry Milk","草莓腰果奶",
 "Strawberry Cashew M*lk","草莓腰果奶","Strawberry Cashew M*lk","草莓腰果奶",
 "Match the playful M*lk styling.",SUG),
("Juices","Green Glow Juice","绿焕汁",
 "Green Glow Juice","绿焕汁","Green Glow-Up Juice","绿光焕活汁",
 "Cool name already; keep.",KEEP),
("Juices","Cashews Chocolate M*LK","可可腰果奶",
 "Chocolate Cashew M*lk","可可腰果奶","Chocolate Cashew M*lk","可可腰果奶",
 "Tidy word order.",SUG),
("Juices","Nutty L - GoVegan! Almond M!LK","清甜杏奶",
 "Nutty Almond M*lk","清甜杏奶","Nutty Almond M*lk","清甜杏奶",
 "Keep the fun, lose the clutter.",SUG),
("Juices","Celerybration Juice","青力果汁",
 "Celery-bration Juice","青力芹菜汁","Celery-bration Juice","青力芹菜汁",
 "Brilliant pun — keep; clarify celery in CN.",KEEP),
("Juices","Carrot Ginger Juice","姜红卜汁",
 "Carrot-Ginger Juice","胡萝卜生姜汁","Carrot-Ginger Zinger","胡萝卜生姜汁",
 "CN 姜红卜 is cryptic — make it clear.",SUG),

# ── Kombucha ──────────────────────────────────────────────
("Kombucha","Lemongrass Kombucha","香柠草康普茶",
 "Lemongrass Kombucha","香茅康普茶","Lemongrass Kombucha","香茅康普茶",
 "'香茅' is the standard term.",SUG),
("Kombucha","Mango Kombucha","芒果康普茶",
 "Mango Kombucha","芒果康普茶","Mango Kombucha","芒果康普茶",
 "Keep.",KEEP),
("Kombucha","Passion Fruit Kombucha","百香果康普茶",
 "Passion Fruit Kombucha","百香果康普茶","Passion Fruit Kombucha","百香果康普茶",
 "Keep.",KEEP),
("Kombucha","Pineapple Mint Kombucha","菠萝薄荷康普茶",
 "Pineapple-Mint Kombucha","菠萝薄荷康普茶","Pineapple-Mint Kombucha","菠萝薄荷康普茶",
 "Keep.",KEEP),
("Kombucha","DIY Kombucha Scooby + Starter Liquid","康普茶DIY套装（菌母 +菌液）",
 "Brew-Your-Own Kombucha Kit","康普茶自酿套装（菌母+菌液）","Brew-Your-Own Kombucha Kit","康普茶自酿套装（菌母+菌液）",
 "'Brew-your-own' is friendlier than SCOBY.",SUG),
("Kombucha","Mix Berries Kombucha","莓果康普茶",
 "Mixed Berry Kombucha","莓果康普茶","Mixed Berry Kombucha","莓果康普茶",
 "Grammar tidy.",SUG),

# ── Legumes ───────────────────────────────────────────────
("Legumes","Green Lentil","绿扁豆",
 "Green Lentils","绿扁豆","Green Lentils","绿扁豆",
 "Keep.",KEEP),
("Legumes","Chickpeas","鹰嘴豆",
 "Chickpeas","鹰嘴豆","Chickpeas","鹰嘴豆",
 "Keep.",KEEP),
("Legumes","Black Beans","黑芸豆",
 "Black Beans","黑豆","Black Beans","黑豆",
 "'黑豆' is the everyday word.",SUG),
("Legumes","Red Lentil","红扁豆",
 "Red Lentils","红扁豆","Red Lentils","红扁豆",
 "Keep.",KEEP),

# ── Meals ─────────────────────────────────────────────────
("Meals","Tom Yum","泰式冬阴功汤",
 "Tom Yum Soup","泰式冬阴功汤","Tom Yum Soup","泰式冬阴功汤",
 "Add 'soup' so it's obvious.",SUG),

# ── Nut Butters ───────────────────────────────────────────
("Nut Butters","81° Hazel Chocolate Spread","可可榛子酱",
 "Hazelnut-Chocolate Spread","可可榛子酱","Hazelnut-Chocolate Dream","可可榛子酱",
 "Drop the cryptic '81°'.",SUG),
("Nut Butters","Almond Butter Maple Cinnamon","肉桂枫糖杏仁酱",
 "Maple-Cinnamon Almond Butter","肉桂枫糖杏仁酱","Maple-Cinnamon Almond Butter","肉桂枫糖杏仁酱",
 "Lead with the flavour.",SUG),
("Nut Butters","Peanut Butter Bundle","花生酱套装",
 "Peanut Butter Duo","花生酱套装","Peanut Butter Duo","花生酱套装",
 "'Duo' is punchier.",SUG),
("Nut Butters","Peanut Butter （Classic）","哈素萌原味花生酱",
 "Classic Peanut Butter","原味花生酱","Classic Peanut Butter","原味花生酱",
 "Trim the house brand prefix.",SUG),
("Nut Butters","Almond Butter","哈素萌杏仁酱",
 "Smooth Almond Butter","杏仁酱","Smooth Almond Butter","杏仁酱",
 "'Smooth' adds texture appeal.",SUG),
("Nut Butters","Peanut Butter （Crunchy）","有点咸花生酱（内含花生碎）",
 "Crunchy Peanut Butter","松脆花生酱（含花生碎）","Crunchy Peanut Butter","松脆花生酱（含花生碎）",
 "Lead with 'crunchy' both ways.",SUG),
("Nut Butters","Roasted Hazelnut Butter","经典榛子酱",
 "Roasted Hazelnut Butter","烘烤榛子酱","Roasted Hazelnut Butter","烘烤榛子酱",
 "Bring 'roasted' into CN.",SUG),
("Nut Butters","Unhulled Sesame Tahini","中东生芝麻酱（未去皮）",
 "Whole Sesame Tahini (Unhulled)","中东芝麻酱（带皮）","Whole Sesame Tahini","中东芝麻酱（带皮）",
 "'Whole' is friendlier than 'unhulled'.",SUG),
("Nut Butters","Hulled Sesame Tahini","中东生芝麻酱（去皮）",
 "Smooth Sesame Tahini (Hulled)","中东芝麻酱（去皮）","Smooth Sesame Tahini","中东芝麻酱（去皮）",
 "'Smooth' pairs nicely with the whole one.",SUG),
("Nut Butters","Cashew Butter","腰果酱",
 "Creamy Cashew Butter","腰果酱","Creamy Cashew Butter","腰果酱",
 "'Creamy' sells the spread.",SUG),

# ── Nuts & Seeds ──────────────────────────────────────────
("Nuts ＆ Seeds","Roasted Hazelnuts","烤榛子",
 "Roasted Hazelnuts","烤榛子","Roasted Hazelnuts","烤榛子",
 "Keep.",KEEP),
("Nuts ＆ Seeds","Pumpkin Seeds （Raw, Unsalted）","南瓜子（无盐，生）",
 "Raw Pumpkin Seeds (Unsalted)","生南瓜子（无盐）","Raw Pumpkin Seeds (Unsalted)","生南瓜子（无盐）",
 "Lead with 'raw'.",SUG),
("Nuts ＆ Seeds","Sliced Almonds （Raw, Unsalted）","杏仁片（生，无盐）",
 "Raw Sliced Almonds (Unsalted)","生杏仁片（无盐）","Raw Sliced Almonds (Unsalted)","生杏仁片（无盐）",
 "Consistent format.",SUG),
("Nuts ＆ Seeds","Sunflower Seeds （Raw, Unsalted）","葵花籽、瓜子仁（无盐，生）",
 "Raw Sunflower Kernels (Unsalted)","生葵花籽仁（无盐）","Raw Sunflower Kernels (Unsalted)","生葵花籽仁（无盐）",
 "'Kernels' = shelled; tidy CN.",SUG),
("Nuts ＆ Seeds","Hemp Seeds","脱壳火麻仁",
 "Hulled Hemp Seeds","脱壳火麻仁","Hulled Hemp Seeds","脱壳火麻仁",
 "Add 'hulled' for accuracy.",SUG),
("Nuts ＆ Seeds","Walnuts （unsalted ,raw）","核桃（无盐，生）",
 "Raw Walnuts (Unsalted)","生核桃（无盐）","Raw Walnuts (Unsalted)","生核桃（无盐）",
 "Consistent format.",SUG),
("Nuts ＆ Seeds","Flaxseed","亚麻籽",
 "Flaxseed","亚麻籽","Flaxseed","亚麻籽",
 "Keep.",KEEP),
("Nuts ＆ Seeds","Golden Flaxseed","黄金亚麻籽",
 "Golden Flaxseed","黄金亚麻籽","Golden Flaxseed","黄金亚麻籽",
 "Already nice.",KEEP),
("Nuts ＆ Seeds","Cashews （Unsalted, Raw）","生腰果",
 "Raw Cashews (Unsalted)","生腰果（无盐）","Raw Cashews (Unsalted)","生腰果（无盐）",
 "Consistent format.",SUG),
("Nuts ＆ Seeds","Chia Seeds","奇亚籽",
 "Chia Seeds","奇亚籽","Chia Seeds","奇亚籽",
 "Keep.",KEEP),
("Nuts ＆ Seeds","Almonds （unsalted, raw）","美国巴旦木大杏仁（无盐，生）",
 "Raw Almonds (Unsalted)","生巴旦木大杏仁（无盐）","Raw Almonds (Unsalted)","生巴旦木大杏仁（无盐）",
 "Tidy; keep the prized origin.",SUG),

# ── Oils ──────────────────────────────────────────────────
("Oils","Extra Virgin Coconut Oil","初榨椰子油",
 "Extra-Virgin Coconut Oil","初榨椰子油","Extra-Virgin Coconut Oil","初榨椰子油",
 "Keep.",KEEP),
("Oils","Refined Coconut Oil （Cooking Oil）","精制椰子油（推荐烹饪使用）",
 "Refined Coconut Oil (for Cooking)","精制椰子油（适合烹饪）","Refined Coconut Oil (for Cooking)","精制椰子油（适合烹饪）",
 "Clear use-case both ways.",SUG),

# ── Other Beverages ───────────────────────────────────────
("Other Beverages","Masala Tea （Chai Latte）","香料柴茶拿铁",
 "Masala Chai Latte","印度香料柴茶拿铁","Masala Chai Latte","印度香料柴茶拿铁",
 "Cleaner EN; richer CN.",SUG),

# ── Other Supplements ─────────────────────────────────────
("Other Supplements","B12 Capsules","B12 素食胶囊",
 "Vegan B12 Capsules","维生素B12 素食胶囊","Vegan B12 Capsules","维生素B12 素食胶囊",
 "Spell out vitamin in CN.",SUG),
("Other Supplements","Prebiotic Fiber USDA Organic","益生元菊粉",
 "Organic Prebiotic Fibre","有机益生元菊粉","Organic Prebiotic Fibre","有机益生元菊粉",
 "Add 'organic' to CN.",SUG),
("Other Supplements","Iron, Double Strength, NOW Food","铁, 双倍功效,  NOW Foods",
 "NOW Foods Double-Strength Iron","NOW Foods 双倍铁元素","NOW Foods Double-Strength Iron","NOW Foods 双倍铁元素",
 "Brand-first; tidy.",SUG),
("Other Supplements","Pure Creatine Monohydrate, Unflavored","无香精肌酸一水合物",
 "Pure Creatine Monohydrate (Unflavoured)","无味肌酸一水合物","Pure Creatine Monohydrate (Unflavoured)","无味肌酸一水合物",
 "'无味' reads cleaner than '无香精'.",SUG),

# ── Others ────────────────────────────────────────────────
("Others","Carob Powder （Medium Roasted）","角豆粉（中度烘焙）",
 "Carob Powder (Medium Roast)","角豆粉（中度烘焙）","Carob Powder (Medium Roast)","角豆粉（中度烘焙）",
 "Tiny grammar tidy.",SUG),
("Others","Checkout requirements","下单选择",
 "[System — Checkout Options]","下单选择","[System — Checkout Options]","下单选择",
 "Not a product — likely a system/checkout entry. Confirm before exposing.",REV),
("Others","Fire Spice Cake （frozen）","Fire Spice Cake",
 "Fire Spice Cake (Frozen)","火辣香料蛋糕（冷冻）","Fire Spice Cake (Frozen)","火辣香料蛋糕（冷冻）",
 "Give it a real CN name.",SUG),
("Others","12pc Whole Wheat Wrap（XL - 10 inch）","全麦墨西哥卷饼皮",
 "Whole-Wheat Wraps — XL 10\" (12pc)","全麦墨西哥卷饼皮（10寸·12片）","Whole-Wheat Wraps — XL 10\" (12pc)","全麦墨西哥卷饼皮（10寸·12片）",
 "Surface size + count in CN.",SUG),
("Others","Organic Soy Sauce","有机酱油",
 "Organic Soy Sauce","有机酱油","Organic Soy Sauce","有机酱油",
 "Keep.",KEEP),
("Others","Tortilla Chips","玉米片",
 "Tortilla Chips","墨西哥玉米片","Tortilla Chips","墨西哥玉米片",
 "'墨西哥' makes the style clear.",SUG),
("Others","Nutritional Yeast","营养酵母",
 "Nutritional Yeast (Nooch)","营养酵母（芝士风味）","Cheesy Nooch (Nutritional Yeast)","营养酵母（芝士风味）",
 "Hint at the cheesy flavour.",SUG),
("Others","Apple Pie Overnight Oats","苹果绵绵燕麦",
 "Apple Pie Overnight Oats","苹果派隔夜燕麦","Apple Pie Overnight Oats","苹果派隔夜燕麦",
 "'苹果派隔夜' is clearer & tastier.",SUG),
("Others","The Last Batch – GoVegan Stickers","—",
 "GoVegan Stickers — Last Batch","GoVegan 贴纸（最后一批）","GoVegan Stickers — Last Batch","GoVegan 贴纸（最后一批）",
 "Supply CN; keep the fun.",SUG),

# ── Personal Care ─────────────────────────────────────────
("Personal Care","Puretonique Body Wash","香氛精油保湿沐浴露",
 "Puretonique Body Wash","Puretonique 香氛沐浴露","Puretonique Body Wash","Puretonique 香氛沐浴露",
 "Brand stays; trim CN.",SUG),
("Personal Care","Puretonique Shampoo","香氛精油柔亮洗发露",
 "Puretonique Shampoo","Puretonique 香氛洗发露","Puretonique Shampoo","Puretonique 香氛洗发露",
 "Brand stays; trim CN.",SUG),

# ── Pickles ───────────────────────────────────────────────
("Pickles","Onion Pickles","腌洋葱",
 "Pickled Onions","腌洋葱","Pickled Onions","腌洋葱",
 "Grammar tidy.",SUG),
("Pickles","Kalamata ＆ Green olives mix","希腊混合橄榄",
 "Kalamata & Green Olive Mix","希腊混合橄榄","Kalamata & Green Olive Mix","希腊混合橄榄",
 "Capitalise; keep.",SUG),
("Pickles","Jalapeño Pickles","腌墨西哥辣椒",
 "Pickled Jalapeños","腌墨西哥辣椒","Pickled Jalapeños","腌墨西哥辣椒",
 "Grammar tidy.",SUG),

# ── Plants Powders ────────────────────────────────────────
("Plants Powders","BioCurcumin+ USDA Organic","Bio姜黄素（60份）",
 "BioCurcumin+ (Organic)","有机姜黄素（60份）","BioCurcumin+ (Organic)","有机姜黄素（60份）",
 "Clear CN; keep brandy '+'.",SUG),
("Plants Powders","Mix Greens Power House Blend USDA Organic","超级绿",
 "Powerhouse Greens Blend","超级绿粉","Powerhouse Greens","超级绿粉",
 "Tidy EN; '粉' clarifies it's a powder.",SUG),
("Plants Powders","Turmeric Organic USDA","姜黄粉",
 "Organic Turmeric Powder","有机姜黄粉","Organic Turmeric Powder","有机姜黄粉",
 "Add organic to CN.",SUG),
("Plants Powders","Moringa Powder USDA Organic","辣木粉",
 "Organic Moringa Powder","有机辣木粉","Organic Moringa Powder","有机辣木粉",
 "Add organic to CN.",SUG),
("Plants Powders","Kale Powder USDA Organic","羽衣甘蓝粉",
 "Organic Kale Powder","有机羽衣甘蓝粉","Organic Kale Powder","有机羽衣甘蓝粉",
 "Add organic to CN.",SUG),
("Plants Powders","Alfalfa Powder USDA Organic","有机紫花苜蓿粉",
 "Organic Alfalfa Powder","有机紫花苜蓿粉","Organic Alfalfa Powder","有机紫花苜蓿粉",
 "Tidy EN.",SUG),
("Plants Powders","Berry Intelligence House Blend","超级莓粉",
 "Berry Brain Blend","超级莓粉","Berry Brain Blend","超级莓粉",
 "Witty — keep.",KEEP),
("Plants Powders","Maca Powder USDA Organic","云南有机玛卡粉玛咖粉",
 "Organic Maca Powder","云南有机玛卡粉","Organic Maca Powder","云南有机玛卡粉",
 "Drop the duplicate 玛咖.",SUG),
("Plants Powders","Wheatgrass Powder USDA Organic","小麦苗粉",
 "Organic Wheatgrass Powder","有机小麦苗粉","Organic Wheatgrass Powder","有机小麦苗粉",
 "Add organic to CN.",SUG),
("Plants Powders","Spirulina Powder USDA Organic","螺旋藻粉",
 "Organic Spirulina Powder","有机螺旋藻粉","Organic Spirulina Powder","有机螺旋藻粉",
 "Add organic to CN.",SUG),
("Plants Powders","Beetroot Powder USDA Organic","甜菜根粉",
 "Organic Beetroot Powder","有机甜菜根粉","Organic Beetroot Powder","有机甜菜根粉",
 "Add organic to CN.",SUG),
("Plants Powders","Acai Powder USDA Organic","巴西莓粉",
 "Organic Açaí Powder","有机巴西莓粉","Organic Açaí Powder","有机巴西莓粉",
 "Add organic to CN.",SUG),
("Plants Powders","Chlorella Powder USDA Organic","小球藻粉",
 "Organic Chlorella Powder","有机小球藻粉","Organic Chlorella Powder","有机小球藻粉",
 "Add organic to CN.",SUG),
("Plants Powders","Matcha Powder USDA Organic","抹茶粉",
 "Organic Matcha Powder","有机抹茶粉","Organic Matcha Powder","有机抹茶粉",
 "Add organic to CN.",SUG),
("Plants Powders","Reishi Powder USDA Organic","灵芝菌粉",
 "Organic Reishi Powder","有机灵芝粉","Organic Reishi Powder","有机灵芝粉",
 "Add organic; trim 菌.",SUG),

# ── Protein Powders ───────────────────────────────────────
("Protein Powders","Brown Rice Protein Powder","糙米蛋白粉",
 "Brown Rice Protein","糙米蛋白粉","Brown Rice Protein","糙米蛋白粉",
 "'Powder' is implied.",KEEP),
("Protein Powders","Pea Protein Powder USDA Organic","豌豆蛋白粉",
 "Organic Pea Protein","有机豌豆蛋白粉","Organic Pea Protein","有机豌豆蛋白粉",
 "Add organic to CN.",SUG),
("Protein Powders","Soy Protein Powder USDA Organic","大豆蛋白粉",
 "Organic Soy Protein","有机大豆蛋白粉","Organic Soy Protein","有机大豆蛋白粉",
 "Add organic to CN.",SUG),
("Protein Powders","Pumpkin Seed Protein Powder","南瓜籽蛋白粉",
 "Pumpkin Seed Protein","南瓜籽蛋白粉","Pumpkin Seed Protein","南瓜籽蛋白粉",
 "Trim 'powder'.",KEEP),
("Protein Powders","Hemp Protein Powder USDA Organic","火麻仁蛋白粉",
 "Organic Hemp Protein","有机火麻仁蛋白粉","Organic Hemp Protein","有机火麻仁蛋白粉",
 "Add organic to CN.",SUG),

# ── Protein Rich ──────────────────────────────────────────
("Protein Rich","Edamame Tempeh","青豆天贝",
 "Edamame Tempeh","毛豆天贝","Edamame Tempeh","毛豆天贝",
 "'毛豆' is the precise bean.",SUG),
("Protein Rich","Black Soy Beans Tempeh","黑豆天贝",
 "Black Soybean Tempeh","黑豆天贝","Black Soybean Tempeh","黑豆天贝",
 "Grammar tidy.",SUG),
("Protein Rich","Trio Bean Tempeh","杂豆天贝",
 "Three-Bean Tempeh","三豆天贝","Three-Bean Tempeh","三豆天贝",
 "'Three-bean' is concrete.",SUG),
("Protein Rich","Baked Falafel","法拉费小饼",
 "Baked Falafel","法拉费小饼","Baked Falafel","法拉费小饼",
 "Cute CN — keep.",KEEP),
("Protein Rich","Seitan","素肉排",
 "Seitan (Wheat 'Steak')","谷物素肉排","Seitan — Wheat 'Steak'","谷物素肉排",
 "Tell shoppers what seitan is.",SUG),
("Protein Rich","Chickpeas Tempeh","鹰嘴豆天贝",
 "Chickpea Tempeh","鹰嘴豆天贝","Chickpea Tempeh","鹰嘴豆天贝",
 "Singular tidy.",KEEP),
("Protein Rich","White Beans Tempeh","黄豆天贝",
 "White Bean Tempeh","白芸豆天贝","White Bean Tempeh","白芸豆天贝",
 "CN said 黄豆(soy)≠white bean — align to 白芸豆.",SUG),
("Protein Rich","Shawarma Mix","沙瓦玛素肉",
 "Shawarma-Spiced Strips","沙瓦玛风味素肉","Shawarma-Spiced Strips","沙瓦玛风味素肉",
 "'Spiced strips' is more appetising.",SUG),
("Protein Rich","Marinaded Tempeh","酱香天贝",
 "Marinated Tempeh","酱香天贝","Marinated Tempeh","酱香天贝",
 "Fix spelling (Marinaded→Marinated).",SUG),
("Protein Rich","TVP （ Texture Vegetable Protein ）","大豆组织蛋白",
 "Soy Protein Crumbles (TVP)","大豆组织蛋白（素肉碎）","Soy Crumbles (TVP)","大豆组织蛋白（素肉碎）",
 "'Crumbles' tells you how to use it.",SUG),
("Protein Rich","Quinoa Patties","酱香藜麦排",
 "Savoury Quinoa Patties","酱香藜麦排","Savoury Quinoa Patties","酱香藜麦排",
 "'Savoury' matches the 酱香 flavour.",SUG),
("Protein Rich","Chick EN Strips","素鸡肉条",
 "Chick'EN Strips","素鸡柳","Chick'EN Strips","素鸡柳",
 "Keep the pun; 鸡柳 sounds tastier.",SUG),
("Protein Rich","Mushroom Burger Pattie","香菇汉堡饼",
 "Mushroom Burger Patty","香菇汉堡饼","Mushroom Burger Patty","香菇汉堡饼",
 "Fix spelling (Pattie→Patty).",SUG),
("Protein Rich","Bolognese","意式番茄素肉酱",
 "Plant Bolognese","意式番茄素肉酱","Plant Bolognese","意式番茄素肉酱",
 "'Plant' flags it's meat-free.",SUG),
("Protein Rich","Ground Meat","素肉碎",
 "Plant Mince","素肉碎","Plant Mince","素肉碎",
 "'Plant mince' beats confusing 'Ground Meat'.",SUG),

# ── Salads & Bowls ────────────────────────────────────────
("Salads ＆ Bowls","Thai Buckwheat Noodles","泰式冷面沙拉",
 "Thai Buckwheat Noodle Salad","泰式荞麦冷面沙拉","Thai Buckwheat Noodle Salad","泰式荞麦冷面沙拉",
 "Name buckwheat in CN.",SUG),
("Salads ＆ Bowls","Beet Salad","甜菜根沙拉",
 "Roasted Beet Salad","烤甜菜根沙拉","Roasted Beet Salad","烤甜菜根沙拉",
 "'Roasted' adds flavour cue.",SUG),
("Salads ＆ Bowls","Tabbouleh Bowl","甜宝绿盒",
 "Tabbouleh Bowl","塔布勒香草沙拉","Tabbouleh Herb Bowl","塔布勒香草沙拉",
 "CN 甜宝绿盒 is cryptic — describe it.",SUG),
("Salads ＆ Bowls","Quinoa Salad","藜麦沙拉",
 "Quinoa Salad","藜麦沙拉","Quinoa Salad","藜麦沙拉",
 "Keep.",KEEP),

# ── Soups & Stews ─────────────────────────────────────────
("Soups ＆ Stews","Mushroom Soup","蘑菇汤",
 "Creamy Mushroom Soup","奶油蘑菇汤","Creamy Mushroom Soup","奶油蘑菇汤",
 "'Creamy' sells the bowl.",SUG),
("Soups ＆ Stews","Nourish Beans ＆ Veggie Soup","意式白豆甘蓝汤",
 "Nourish Bean & Veggie Soup","意式白豆甘蓝汤","Nourish Bean & Veggie Soup","意式白豆甘蓝汤",
 "Grammar tidy; keep 'Nourish'.",KEEP),
("Soups ＆ Stews","Red Lentils Soup","红扁豆汤",
 "Red Lentil Soup","红扁豆汤","Red Lentil Soup","红扁豆汤",
 "Singular tidy.",SUG),
("Soups ＆ Stews","Chinese Herbal Soup","药膳汤",
 "Herbal Nourish Soup","养生药膳汤","Herbal Nourish Soup","养生药膳汤",
 "'养生' lifts the appeal.",SUG),
("Soups ＆ Stews","Pumpkin Soup","香烤南瓜汤",
 "Roasted Pumpkin Soup","香烤南瓜汤","Roasted Pumpkin Soup","香烤南瓜汤",
 "Bring 'roasted' into EN.",SUG),
("Soups ＆ Stews","Sweet Potato Cauliflower Curry","红薯菜花咖喱",
 "Sweet Potato & Cauliflower Curry","红薯花菜咖喱","Sweet Potato & Cauliflower Curry","红薯花菜咖喱",
 "Tidy; 花菜 reads naturally.",SUG),

# ── Sour Creams ───────────────────────────────────────────
("Sour Creams","OliveN‘Cream","地中海橄榄酱",
 "Olive 'n' Cream","地中海橄榄酸奶酱","Olive 'n' Cream","地中海橄榄酸奶酱",
 "Tidy styling; note it's a sour cream.",SUG),
("Sour Creams","Camembert Walnut Spread","卡门贝尔核桃酱",
 "Camembert-Walnut Spread","卡门贝尔核桃酱","Camembert-Walnut Spread","卡门贝尔核桃酱",
 "Already good.",KEEP),
("Sour Creams","Garlic Dill Sour Cream","蒜香莳萝酸奶酪",
 "Garlic-Dill Sour Cream","蒜香莳萝酸奶油","Garlic-Dill Sour Cream","蒜香莳萝酸奶油",
 "'酸奶油' = sour cream (accuracy).",SUG),
("Sour Creams","Classic Sour Cream","纯腰果发酵奶酪",
 "Classic Cashew Sour Cream","经典腰果酸奶油","Classic Cashew Sour Cream","经典腰果酸奶油",
 "Name the cashew base + correct CN.",SUG),
("Sour Creams","Labneh Za‘atar","中东香料酸奶油",
 "Za'atar Labneh","扎塔香料酸奶酪","Za'atar Labneh","扎塔香料酸奶酪",
 "Keep the dish name; tidy.",SUG),

# ── Spices ────────────────────────────────────────────────
("Spices","Sumac","苏模粉/漆树果粉",
 "Sumac","苏模粉（漆树果）","Sumac","苏模粉（漆树果）",
 "Tidy the CN slash.",SUG),
("Spices","Za‘atar","绿百里香粉",
 "Za'atar Spice Blend","扎塔香料","Za'atar Spice Blend","扎塔香料",
 "'Blend' — it's not just thyme.",SUG),
("Spices","Black Salt （ Kala namak ）","印度喜马拉雅黑盐紫盐",
 "Black Salt (Kala Namak)","印度黑盐（喜马拉雅）","Black Salt (Kala Namak)","印度黑盐（喜马拉雅）",
 "Trim the doubled 黑盐紫盐.",SUG),
("Spices","Onion Powder Organic USDA","洋葱粉",
 "Organic Onion Powder","有机洋葱粉","Organic Onion Powder","有机洋葱粉",
 "Tidy EN; add organic CN.",SUG),
("Spices","Garlic Powder Organic USDA","大蒜粉",
 "Organic Garlic Powder","有机大蒜粉","Organic Garlic Powder","有机大蒜粉",
 "Tidy EN; add organic CN.",SUG),

# ── Spicy ─────────────────────────────────────────────────
("Spicy","Fermented Tofu （Oil Free）","素腐乳（无油）",
 "Fermented Tofu (Oil-Free)","素腐乳（无油）","Fermented Tofu (Oil-Free)","素腐乳（无油）",
 "Keep.",KEEP),
("Spicy","Harissa Paste","哈辣酱（北非辣椒酱）",
 "Harissa Chilli Paste","哈里萨辣椒酱（北非）","Harissa Chilli Paste","哈里萨辣椒酱（北非）",
 "Add 'chilli'; standard 哈里萨.",SUG),

# ── Spreads & Dips ────────────────────────────────────────
("Spreads ＆ Dips","Green Chili Dip - Zhoug","麻辣青辣椒酱",
 "Zhoug — Green Chilli Dip","麻辣青辣椒酱（Zhoug）","Zhoug — Fiery Green Dip","麻辣青辣椒酱（Zhoug）",
 "Lead with the dish name.",SUG),
("Spreads ＆ Dips","Blue Cheese （Limited Stock）","—",
 "Blue Cheese Dip (Limited)","纯素蓝纹芝士酱（限量）","Blue Cheese Dip (Limited)","纯素蓝纹芝士酱（限量）",
 "Supply CN; flag vegan + limited.",SUG),
("Spreads ＆ Dips","Fricassa Fiesta","Fricassa 风味盛宴",
 "Fricassé Fiesta","Fricassé 风味盛宴","Fricassé Fiesta","Fricassé 风味盛宴",
 "Tidy spelling; keep the party.",SUG),
("Spreads ＆ Dips","Turkish Salad","土耳其沙拉",
 "Turkish Tomato Salad","土耳其番茄沙拉","Turkish Tomato Salad","土耳其番茄沙拉",
 "Add 'tomato' so people know it.",SUG),
("Spreads ＆ Dips","Hummus Asli","中东鹰嘴豆泥",
 "Hummus Asli — The Original","中东经典鹰嘴豆泥","Hummus Asli — The Original","中东经典鹰嘴豆泥",
 "'The Original' explains 'Asli'.",SUG),
("Spreads ＆ Dips","Guacamole","墨西哥牛油果泥",
 "Guacamole","墨西哥牛油果酱","Guacamole","墨西哥牛油果酱",
 "'酱' sounds more spreadable.",KEEP),
("Spreads ＆ Dips","Epic Baba Ganoush","（全新）以色列茄子泥",
 "Epic Baba Ganoush","以色列烟熏茄子泥","Epic Baba Ganoush","以色列烟熏茄子泥",
 "Keep 'Epic'; '烟熏' makes CN mouthwater.",KEEP),
("Spreads ＆ Dips","Chickpeas Salad","美式豆泥蔬沙拉",
 "Chickpea Salad","美式鹰嘴豆沙拉","Chickpea Salad","美式鹰嘴豆沙拉",
 "Name the chickpea in CN.",SUG),
("Spreads ＆ Dips","Arugula Basil Pesto","阿古罗勒青酱",
 "Arugula-Basil Pesto","芝麻菜罗勒青酱","Arugula-Basil Pesto","芝麻菜罗勒青酱",
 "'芝麻菜' is the clear word for arugula.",SUG),

# ── Wines (Vegan Certified) ───────────────────────────────
("Wines （Vegan Certified）","Upper Galilee Cabernet - 2020","—",
 "Upper Galilee Cabernet 2020","上加利利 赤霞珠 2020","Upper Galilee Cabernet 2020","上加利利 赤霞珠 2020",
 "Supply CN; keep wine precision.",SUG),
("Wines （Vegan Certified）","Upper Galilee Merlot - 2020","—",
 "Upper Galilee Merlot 2020","上加利利 梅洛 2020","Upper Galilee Merlot 2020","上加利利 梅洛 2020",
 "Supply CN.",SUG),
("Wines （Vegan Certified）","Upper Galilee Syrah -  2020","—",
 "Upper Galilee Syrah 2020","上加利利 西拉 2020","Upper Galilee Syrah 2020","上加利利 西拉 2020",
 "Supply CN; fix spacing.",SUG),
("Wines （Vegan Certified）","Special Reserve Red - 2020","—",
 "Special Reserve Red 2020","特别珍藏 红葡萄酒 2020","Special Reserve Red 2020","特别珍藏 红葡萄酒 2020",
 "Supply CN.",SUG),
("Wines （Vegan Certified）","Reserve Carignan Wild Old Vines - 2021","—",
 "Reserve Carignan — Wild Old Vines 2021","珍藏 佳丽酿 老藤 2021","Reserve Carignan — Wild Old Vines 2021","珍藏 佳丽酿 老藤 2021",
 "Supply CN; keep 'old vines' story.",SUG),
("Wines （Vegan Certified）","Reserve Cabernet Sauvignon 2018","—",
 "Reserve Cabernet Sauvignon 2018","珍藏 赤霞珠 2018","Reserve Cabernet Sauvignon 2018","珍藏 赤霞珠 2018",
 "Supply CN.",SUG),
("Wines （Vegan Certified）","Petit Sirah Reserve  Jezreel Valley - 2021","—",
 "Petite Sirah Reserve — Jezreel Valley 2021","耶斯列谷 珍藏 小西拉 2021","Petite Sirah Reserve — Jezreel Valley 2021","耶斯列谷 珍藏 小西拉 2021",
 "Supply CN; fix spelling/spacing.",SUG),
("Wines （Vegan Certified）","Galilee Sauvignon Blanc - 2023","—",
 "Galilee Sauvignon Blanc 2023","加利利 长相思 2023","Galilee Sauvignon Blanc 2023","加利利 长相思 2023",
 "Supply CN.",SUG),
("Wines （Vegan Certified）","Fresh ＆ Young French Blend - 2023","—",
 "Fresh & Young French Blend 2023","清新 法式混酿 2023","Fresh & Young French Blend 2023","清新 法式混酿 2023",
 "Supply CN; keep lively name.",SUG),
("Wines （Vegan Certified）","Upper Galilee Chardonnay - 2022","—",
 "Upper Galilee Chardonnay 2022","上加利利 霞多丽 2022","Upper Galilee Chardonnay 2022","上加利利 霞多丽 2022",
 "Supply CN.",SUG),
("Wines （Vegan Certified）","Yasmin White - 2023","Recanati Winery Yasmin White - 2023",
 "Yasmin White 2023","蕾卡纳缇 茉莉白葡萄酒 2023","Yasmin White 2023","蕾卡纳缇 茉莉白葡萄酒 2023",
 "Tidy; keep winery brand.",SUG),

# ── Wraps & Sandwiches ────────────────────────────────────
("Wraps ＆ Sandwiches","Tofu Banh Mi Wrap","越式豆腐卷（无五辛）",
 "Tofu Banh Mi Wrap","越式豆腐卷（无五辛）","Tofu Banh Mi Wrap","越式豆腐卷（无五辛）",
 "Clear & specific — keep.",KEEP),
("Wraps ＆ Sandwiches","Shawarma Wrap","沙瓦玛卷",
 "Shawarma Wrap","沙瓦玛素肉卷","Shawarma Wrap","沙瓦玛素肉卷",
 "Add 素肉 so CN flags it's vegan.",SUG),
("Wraps ＆ Sandwiches","Chickpeas Salad Sandwich","鹰嘴豆泥三文治",
 "Chickpea Salad Sandwich","鹰嘴豆沙拉三明治","Chickpea Salad Sandwich","鹰嘴豆沙拉三明治",
 "'三明治' is the common spelling.",SUG),
("Wraps ＆ Sandwiches","Falafel Wrap","法拉费卷",
 "Falafel Wrap","法拉费卷","Falafel Wrap","法拉费卷",
 "Keep.",KEEP),
("Wraps ＆ Sandwiches","Pesto Wrap","纯素罗勒鸡肉卷",
 "Pesto 'Chicken' Wrap","纯素罗勒鸡肉卷","Pesto 'Chicken' Wrap","纯素罗勒鸡肉卷",
 "Quotes flag the chicken is plant-based.",SUG),

# ── Yogurts ───────────────────────────────────────────────
("Yogurts","Strawberry Coco Parfait","草莓椰椰芭菲",
 "Strawberry Coconut Parfait","草莓椰椰芭菲","Strawberry Coconut Parfait","草莓椰椰芭菲",
 "Spell out coconut; keep the cute CN.",SUG),
("Yogurts","Vanilla Yogurt Coconut Probiotic","纯素椰子酸奶 - 香草味",
 "Coconut Yogurt — Vanilla","纯素椰子酸奶 · 香草味","Coconut Yogurt — Vanilla","纯素椰子酸奶 · 香草味",
 "Lead with the product, flavour after.",SUG),
("Yogurts","Peach Yogurt Coconut Probiotic","纯素椰子酸奶-桃子味",
 "Coconut Yogurt — Peach","纯素椰子酸奶 · 桃子味","Coconut Yogurt — Peach","纯素椰子酸奶 · 桃子味",
 "Consistent pattern.",SUG),
("Yogurts","Tzatziki","莳萝柠檬酸奶酱",
 "Tzatziki","莳萝柠檬酸奶酱","Tzatziki","莳萝柠檬酸奶酱",
 "Well described — keep.",KEEP),
("Yogurts","Coconut Yogurt Probiotic","纯素椰子酸奶",
 "Coconut Yogurt — Plain","纯素椰子酸奶 · 原味","Coconut Yogurt — Plain","纯素椰子酸奶 · 原味",
 "Add 'Plain/原味' to anchor the range.",SUG),

# ── (Uncategorised) ───────────────────────────────────────
("(Uncategorised)","Quinoa Green Lentil Buddha Bowl","藜麦扁豆杂蔬碗",
 "Quinoa & Lentil Buddha Bowl","藜麦扁豆杂蔬碗","Quinoa & Lentil Buddha Bowl","藜麦扁豆杂蔬碗",
 "Already appetising — keep.",KEEP),
]

# ── Build workbook ────────────────────────────────────────
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Name Options"

HEAD = ["Category","Current EN","Current CN","Suggested EN","Suggested CN",
        "Fun EN (dialed up)","Fun CN (dialed up)","Why","Decision"]
green   = PatternFill("solid", fgColor="2E5D3B")
catfill = PatternFill("solid", fgColor="E3EFE3")
altfill = PatternFill("solid", fgColor="F4F8F4")
funfill = PatternFill("solid", fgColor="FFF6E9")   # warm tint for the fun columns
white   = Font(color="FFFFFF", bold=True, size=11)
sugfont = Font(color="1B5E20", bold=True)
funfont = Font(color="A65A00", bold=True)
decfont = Font(color="333333", bold=True)
thin = Side(style="thin", color="D7E2D7")
border = Border(left=thin,right=thin,top=thin,bottom=thin)

ws.append(HEAD)
for c in ws[1]:
    c.fill = green; c.font = white
    c.alignment = Alignment(vertical="center", horizontal="left")
ws.row_dimensions[1].height = 26

prev_cat = None
r = 2
for cat,en,cn,sen,scn,fen,fcn,why,dec in ROWS:
    ws.append([cat,en,cn,sen,scn,fen,fcn,why,dec])
    is_new_cat = cat != prev_cat
    prev_cat = cat
    for col in range(1,10):
        cell = ws.cell(row=r, column=col)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
        cell.border = border
        if is_new_cat:
            cell.fill = catfill
        elif col in (6,7):
            cell.fill = funfill
        elif r % 2 == 0:
            cell.fill = altfill
    ws.cell(row=r,column=4).font = sugfont
    ws.cell(row=r,column=5).font = sugfont
    ws.cell(row=r,column=6).font = funfont
    ws.cell(row=r,column=7).font = funfont
    ws.cell(row=r,column=9).font = decfont
    r += 1
last = r - 1

# Decision dropdown
dv = DataValidation(type="list",
                    formula1=f'"{KEEP},{SUG},{FUN},{REV}"',
                    allow_blank=True)
dv.add(f"I2:I{last}")
ws.add_data_validation(dv)

widths = {"A":20,"B":30,"C":24,"D":30,"E":24,"F":30,"G":24,"H":38,"I":16}
for col,w in widths.items():
    ws.column_dimensions[col].width = w
ws.freeze_panes = "B2"
ws.auto_filter.ref = f"A1:I{last}"

wb.save("Roots-Name-Suggestions.xlsx")

# CSV mirror (UTF-8 BOM so Excel reads Chinese). Fall back if the file is open/locked.
csv_path = "Roots-Name-Suggestions.csv"
try:
    f = open(csv_path,"w",newline="",encoding="utf-8-sig")
except PermissionError:
    csv_path = "Roots-Name-Suggestions-new.csv"
    f = open(csv_path,"w",newline="",encoding="utf-8-sig")
    print(f"(CSV was locked — wrote {csv_path} instead)")
with f:
    w = csv.writer(f)
    w.writerow(HEAD)
    w.writerows(ROWS)

keeps = sum(1 for x in ROWS if x[8]==KEEP)
sugs  = sum(1 for x in ROWS if x[8]==SUG)
revs  = sum(1 for x in ROWS if x[8]==REV)
print(f"OK — {len(ROWS)} products. Recommended: Keep={keeps}, Use suggested={sugs}, Needs review={revs}")
