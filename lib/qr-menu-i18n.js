// The QR menu's six languages.
//
// English and Chinese are the menu the office wrote. Spanish, Korean,
// Japanese and Arabic are written here for the buttons, and saved from the
// model for dish names and descriptions (lib/qr-menu-translate.js).
//
// A button is never sent to the model. An allergen word is never sent to
// the model: it comes from the list below, and a word that is not on the
// list stays in the language the office wrote.

'use strict';

const LANGS = ['en', 'cn', 'es', 'ko', 'ja', 'ar'];
const EXTRA = ['es', 'ko', 'ja', 'ar'];

const BTN = {
  en: 'EN', cn: '中', es: 'Español', ko: '한국어', ja: '日本語', ar: 'العربية',
};

// The sheet title is the one new Chinese pair. Everything else in UI reuses
// a line the menu already shows in English and Chinese.
const UI = {
  'Language': { cn: '语言', es: 'Idioma', ko: '언어', ja: '言語', ar: 'اللغة' },
  'Order': { cn: '订单号', es: 'Pedido', ko: '주문', ja: '注文', ar: 'الطلب' },
  'My orders': { cn: '我的订单', es: 'Mis pedidos', ko: '내 주문', ja: '注文履歴', ar: 'طلباتي' },
  'YOUR BASKET': { cn: '购物车', es: 'TU CESTA', ko: '장바구니', ja: 'カート', ar: 'سلتك' },
  'Add to basket': { cn: '加入购物车', es: 'Añadir a la cesta', ko: '장바구니에 담기', ja: 'カートに入れる', ar: 'أضف إلى السلة' },
  'Sold out': { cn: '售罄', es: 'Agotado', ko: '품절', ja: '売り切れ', ar: 'نفد' },
  'Choose your options': { cn: '选择选项', es: 'Elige las opciones', ko: '옵션 선택', ja: 'オプションを選ぶ', ar: 'اختر الخيارات' },
  'Choose a size': { cn: '选择规格', es: 'Elige un tamaño', ko: '사이즈 선택', ja: 'サイズを選ぶ', ar: 'اختر الحجم' },
  'Ranked by best sellers': { cn: '按热销排序', es: 'Los más pedidos', ko: '많이 팔린 순', ja: 'よく出る順', ar: 'الأكثر طلباً' },
  'No products yet.': { cn: '暂无商品', es: 'Aún no hay productos.', ko: '아직 상품이 없습니다.', ja: 'まだ商品がありません。', ar: 'لا توجد أصناف بعد.' },
  'Check back soon.': { cn: '请稍后再来', es: 'Vuelve pronto.', ko: '잠시 후 다시 와 주세요.', ja: 'また後で来てください。', ar: 'عد لاحقاً.' },
  'Search products': { cn: '搜索商品', es: 'Buscar', ko: '검색', ja: '検索', ar: 'بحث' },
  'Clear': { cn: '清除', es: 'Borrar', ko: '지우기', ja: 'クリア', ar: 'مسح' },
  'ALL': { cn: '全部', es: 'TODO', ko: '전체', ja: 'すべて', ar: 'الكل' },
  'Details': { cn: '详情', es: 'Detalles', ko: '상세', ja: '詳細', ar: 'التفاصيل' },
  'ADD TO BASKET': { cn: '加入购物车', es: 'AÑADIR A LA CESTA', ko: '장바구니에 담기', ja: 'カートに入れる', ar: 'أضف إلى السلة' },
  'CHOOSE A SIZE': { cn: '选择规格', es: 'ELIGE UN TAMAÑO', ko: '사이즈 선택', ja: 'サイズを選ぶ', ar: 'اختر الحجم' },
  'CHOOSE OPTIONS': { cn: '选择选项', es: 'ELIGE OPCIONES', ko: '옵션 선택', ja: 'オプションを選ぶ', ar: 'اختر الخيارات' },
  'Total': { cn: '合计', es: 'Total', ko: '합계', ja: '合計', ar: 'المجموع' },
  'Phone (optional)': { cn: '电话(选填)', es: 'Teléfono (opcional)', ko: '전화번호(선택)', ja: '電話（任意）', ar: 'الهاتف (اختياري)' },
  'Pay with': { cn: '支付方式', es: 'Pagar con', ko: '결제 수단', ja: '支払い方法', ar: 'طريقة الدفع' },
  'WeChat Pay': { cn: '微信支付', es: 'WeChat Pay', ko: 'WeChat Pay', ja: 'WeChat Pay', ar: 'WeChat Pay' },
  'Alipay': { cn: '支付宝', es: 'Alipay', ko: 'Alipay', ja: 'Alipay', ar: 'Alipay' },
  'Pay at the counter': { cn: '收银台付款', es: 'Pagar en caja', ko: '카운터에서 결제', ja: 'レジで支払う', ar: 'الدفع عند الصندوق' },
  'Place order →': { cn: '提交订单 →', es: 'Hacer pedido →', ko: '주문하기 →', ja: '注文する →', ar: 'تأكيد الطلب →' },
  'Please choose how to pay': { cn: '请选择 支付方式', es: 'Elige cómo pagar', ko: '결제 수단을 선택하세요', ja: '支払い方法を選んでください', ar: 'اختر طريقة الدفع' },
  'Scan with WeChat to pay': { cn: '微信扫码支付', es: 'Escanea con WeChat para pagar', ko: 'WeChat으로 스캔하여 결제', ja: 'WeChatで読み取って支払う', ar: 'امسح بـ WeChat للدفع' },
  'Scan the QR code with WeChat to open this menu.': { cn: '用微信扫一扫扫码进入。', es: 'Escanea el código con WeChat para abrir la carta.', ko: 'WeChat으로 QR을 스캔하면 메뉴가 열립니다.', ja: 'WeChatでQRを読み取るとメニューが開きます。', ar: 'امسح الرمز بـ WeChat لفتح القائمة.' },
  'Back': { cn: '返回', es: 'Volver', ko: '뒤로', ja: '戻る', ar: 'رجوع' },
  'Tap any product to see its details.': { cn: '点击商品查看详情。', es: 'Toca un producto para ver los detalles.', ko: '상품을 누르면 상세가 나옵니다.', ja: '商品をタップすると詳細が出ます。', ar: 'المس صنفاً لرؤية التفاصيل.' },
  'No products found.': { cn: '没有找到商品', es: 'No hay resultados.', ko: '찾은 상품이 없습니다.', ja: '商品が見つかりません。', ar: 'لا توجد نتائج.' },
  'Payment received!': { cn: '支付成功！', es: 'Pago recibido', ko: '결제되었습니다', ja: '支払いを受け付けました', ar: 'تم استلام الدفع' },
  'Order placed!': { cn: '下单成功！', es: 'Pedido hecho', ko: '주문되었습니다', ja: '注文しました', ar: 'تم الطلب' },
  'Pay at the counter.': { cn: '请到收银台付款。', es: 'Paga en caja.', ko: '카운터에서 결제하세요.', ja: 'レジで支払ってください。', ar: 'ادفع عند الصندوق.' },
  'Cancelled': { cn: '已取消', es: 'Cancelado', ko: '취소됨', ja: 'キャンセル済み', ar: 'أُلغي' },
  'Waiting for payment…': { cn: '等待付款确认…', es: 'Esperando el pago…', ko: '결제 확인 중…', ja: '支払いを確認しています…', ar: 'بانتظار الدفع…' },
  'Pay with Alipay': { cn: '支付宝支付', es: 'Pagar con Alipay', ko: 'Alipay로 결제', ja: 'Alipayで支払う', ar: 'الدفع عبر Alipay' },
  'Cancel order': { cn: '取消订单', es: 'Cancelar pedido', ko: '주문 취소', ja: '注文をキャンセル', ar: 'إلغاء الطلب' },
  'Cancel this order?': { cn: '取消此订单?', es: '¿Cancelar este pedido?', ko: '이 주문을 취소할까요?', ja: 'この注文をキャンセルしますか？', ar: 'إلغاء هذا الطلب؟' },
  'You can place a new one anytime.': { cn: '您可以随时重新下单。', es: 'Puedes pedir de nuevo cuando quieras.', ko: '언제든 다시 주문할 수 있습니다.', ja: 'いつでも注文し直せます。', ar: 'يمكنك الطلب من جديد في أي وقت.' },
  'Nutrition': { cn: '营养成分', es: 'Nutrición', ko: '영양 성분', ja: '栄養成分', ar: 'القيم الغذائية' },
  'Voucher': { cn: '优惠', es: 'Cupón', ko: '쿠폰', ja: 'クーポン', ar: 'قسيمة' },
  'Ingredients': { cn: '配料表', es: 'Ingredientes', ko: '재료', ja: '原材料', ar: 'المكونات' },
  'Allergens': { cn: '过敏原', es: 'Alérgenos', ko: '알레르기', ja: 'アレルギー', ar: 'مسببات الحساسية' },
  'Contains': { cn: '含有', es: 'Contiene', ko: '함유', ja: '含む', ar: 'يحتوي على' },
  'May contain traces of': { cn: '可能含有微量', es: 'Puede contener trazas de', ko: '흔적 가능', ja: '微量を含む可能性', ar: 'قد يحتوي على آثار' },
  'Made without': { cn: '配方不含', es: 'Elaborado sin', ko: '들어 있지 않음', ja: '使用していない', ar: 'صُنع بدون' },
  'None declared': { cn: '未声明', es: 'No declarado', ko: '표시 없음', ja: '申告なし', ar: 'غير مذكور' },
  '(shared facility)': { cn: '（共用生产环境）', es: '(mismo obrador)', ko: '(같은 작업장)', ja: '（同じ工房）', ar: '(مطبخ مشترك)' },
};

// {n} is the count the picker already computed. The Chinese is the live
// sentence the menu already builds: 选 N 项, 最多 N 项, 至少 N 项.
const LIMITS = {
  choose: { en: 'Choose {n}', cn: '选 {n} 项', es: 'Elige {n}', ko: '{n}개 선택', ja: '{n}つ選ぶ', ar: 'اختر {n}' },
  upto: { en: 'Up to {n}', cn: '最多 {n} 项', es: 'Hasta {n}', ko: '최대 {n}개', ja: '{n}つまで', ar: 'حتى {n}' },
  atleast: { en: 'At least {n}', cn: '至少 {n} 项', es: 'Al menos {n}', ko: '최소 {n}개', ja: '{n}つ以上', ar: '{n} على الأقل' },
};

// Whole chip, not a sentence. An unknown chip is left as written.
const GLOSS = {};
function addGloss(words, row) {
  for (const w of words) GLOSS[w.toLowerCase()] = row;
}
addGloss(['nuts', 'nut', '坚果'], { es: 'Frutos secos', ko: '견과류', ja: 'ナッツ', ar: 'مكسرات' });
addGloss(['tree nuts', 'tree nut'], { es: 'Frutos de cáscara', ko: '견과류', ja: '木の実', ar: 'مكسرات شجرية' });
addGloss(['soy', 'soya', 'soybean', '大豆'], { es: 'Soja', ko: '대두', ja: '大豆', ar: 'صويا' });
addGloss(['gluten', '麸质'], { es: 'Gluten', ko: '글루텐', ja: 'グルテン', ar: 'غلوتين' });
addGloss(['peanuts', 'peanut', '花生'], { es: 'Cacahuetes', ko: '땅콩', ja: 'ピーナッツ', ar: 'فول سوداني' });
addGloss(['sesame', '芝麻'], { es: 'Sésamo', ko: '참깨', ja: 'ごま', ar: 'سمسم' });
addGloss(['seeds', 'seed', '种子类', '种子'], { es: 'Semillas', ko: '씨앗', ja: '種子', ar: 'بذور' });
addGloss(['milk', '牛奶', '乳'], { es: 'Leche', ko: '우유', ja: '乳', ar: 'حليب' });
addGloss(['dairy', '乳制品'], { es: 'Lácteos', ko: '유제품', ja: '乳製品', ar: 'ألبان' });
addGloss(['egg', 'eggs', '鸡蛋', '蛋'], { es: 'Huevo', ko: '달걀', ja: '卵', ar: 'بيض' });
addGloss(['fish', '鱼'], { es: 'Pescado', ko: '생선', ja: '魚', ar: 'سمك' });
addGloss(['shellfish', 'crustacean', '甲壳类'], { es: 'Marisco', ko: '갑각류', ja: '甲殻類', ar: 'قشريات' });
addGloss(['wheat', '小麦'], { es: 'Trigo', ko: '밀', ja: '小麦', ar: 'قمح' });
addGloss(['almond', 'almonds', '杏仁'], { es: 'Almendra', ko: '아몬드', ja: 'アーモンド', ar: 'لوز' });
addGloss(['cashew', 'cashews', '腰果'], { es: 'Anacardo', ko: '캐슈', ja: 'カシュー', ar: 'كاجو' });
addGloss(['walnut', 'walnuts'], { es: 'Nuez', ko: '호두', ja: 'くるみ', ar: 'جوز' });
addGloss(['mustard'], { es: 'Mostaza', ko: '겨자', ja: 'マスタード', ar: 'خردل' });
addGloss(['celery'], { es: 'Apio', ko: '셀러리', ja: 'セロリ', ar: 'كرفس' });
addGloss(['sulphites', 'sulfites', 'sulphite', 'sulfite'], { es: 'Sulfitos', ko: '아황산염', ja: '亜硫酸塩', ar: 'كبريتيت' });
addGloss(['lupin'], { es: 'Altramuz', ko: '루핀', ja: 'ルピナス', ar: 'ترمس' });
addGloss(['mollusc', 'molluscs', 'mollusk', 'mollusks'], { es: 'Moluscos', ko: '연체동물', ja: '軟体動物', ar: 'رخويات' });

function gloss(text, lang) {
  const row = GLOSS[String(text || '').trim().toLowerCase()];
  return row ? (row[lang] || '') : '';
}

function sourceKey(en, cn) {
  return String(en) + '\u0001' + String(cn);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

// lookup(key) -> { es, ko, ja, ar } or null
// miss(key, en, cn) records a content pair the page still needs
function spans(en, cn, hooks) {
  const a = String(en == null ? '' : en).trim();
  const b = String(cn == null ? '' : cn).trim();
  const e = a || b;
  const c = b || a;
  if (!e && !c) return '';
  const ui = UI[e];
  const useUi = ui && ui.cn === c;
  let more = null;
  if (useUi) more = ui;
  else if (hooks && hooks.lookup) {
    const key = sourceKey(e, c);
    more = hooks.lookup(key) || null;
    const missing = !more || EXTRA.some((l) => !more[l]);
    if (missing && hooks.miss) hooks.miss(key, e, c);
  }
  const pick = (lang) => {
    if (lang === 'en') return e;
    if (lang === 'cn') return c;
    const v = more && more[lang] ? String(more[lang]).trim() : '';
    return v || e;
  };
  const sk = useUi ? '' : encodeURIComponent(sourceKey(e, c));
  // Names keep the counter's English underneath the selected translation.
  // Track each language separately: Spanish can equal English while Korean
  // differs, and missing translations must not produce a duplicate fallback.
  const name = hooks && hooks.name;
  const originals = name ? EXTRA.filter((lang) => pick(lang) !== e).join(' ') : '';
  const order = name ? LANGS.filter((lang) => lang !== 'en').concat('en') : LANGS;
  return order.map((lang) => {
    const attr = sk && lang !== 'en' && lang !== 'cn' ? ` data-sk="${esc(sk)}"` : '';
    const original = name && lang === 'en' ? ` data-original="${originals}"` : '';
    return `<span class="l-${lang}"${attr}${original}>${esc(pick(lang))}</span>`;
  }).join('');
}

// True when a saved translation of the name exists and is not just the English again.
function translated(en, cn, lookup) {
  const a = String(en == null ? '' : en).trim();
  const b = String(cn == null ? '' : cn).trim();
  const e = a || b;
  const c = b || a;
  if (!e || UI[e]) return false;
  const more = lookup ? lookup(sourceKey(e, c)) : null;
  if (!more) return false;
  return EXTRA.some((l) => more[l] && String(more[l]).trim() && String(more[l]).trim() !== e);
}

function htmlLang(lang) {
  if (lang === 'cn') return 'zh-CN';
  return LANGS.includes(lang) ? lang : 'en';
}

function askedLang(q) {
  const s = String(q || '');
  return LANGS.includes(s) ? s : 'en';
}

// The stylesheet hide rule. No angle brackets: the menu test forbids them
// inside the style element.
function hideCss() {
  const rules = [];
  for (const on of LANGS) {
    for (const off of LANGS) {
      if (on !== off) rules.push(`.lang-${on} .l-${off}`);
    }
  }
  return rules.join(',') + '{display:none}';
}

module.exports = {
  LANGS, EXTRA, BTN, UI, LIMITS, GLOSS,
  gloss, sourceKey, spans, translated, htmlLang, askedLang, hideCss, esc,
};
