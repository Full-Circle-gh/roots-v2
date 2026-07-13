/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 17/17.
   New-tenant "Open your store" setup guide. Shares the ONE global scope (cuT,
   api, toast, goTab, salesGo live in earlier parts / the HTML). LOAD ORDER
   MATTERS — this loads last so every tab-open helper it routes into exists.

   The guide is a ROUTER, not a form: each step opens the real page/wizard that
   already exists (Products, the Delivery wizard, the payment config, …). The
   server reports which steps are already satisfied from real data, so steps
   tick themselves off — the operator never checks a box. Surfaces:
     • first login → land on the guide (welcome overlay, then the checklist)
     • a pinned sidebar entry with a live % badge (gone at 100%)
     • a "continue setup" card on top of the dashboard (gone at 100%)
   Nothing is hidden or locked; the rest of the backend stays exactly as it is. */

// Live status, cached between paints. null until the first fetch resolves.
let SETUP = null;

// ── Step catalogue ─────────────────────────────────────────────────────────
// One entry per required step (order = shopkeeper order). `go` routes into the
// real surface. `time` is an honest rough estimate. Copy is plain + concrete,
// one idea per line, bilingual via cuT (never glued into one label).
function suSteps() {
  return [
    { key: 'store', time: '2 min',
      en: 'Tell us about your store', cn: '填写店铺信息',
      subEn: 'Address, phone, opening hours', subCn: '地址、电话、营业时间',
      go: suGoStore },
    { key: 'products', time: '5 min',
      en: 'Add your products', cn: '上架商品',
      subEn: 'A name, a price and a photo is enough to start', subCn: '名称、价格和一张照片就够了',
      go: suGoProducts },
    { key: 'payment', time: '3 min',
      en: 'Choose how customers pay', cn: '选择收款方式',
      subEn: 'Alipay QR works today — WeChat Pay can come later', subCn: '支付宝收款码今天就能用，微信支付可以以后再加',
      go: suGoPayment },
    { key: 'fulfillment', time: '2 min',
      en: 'How customers get their order', cn: '顾客如何拿到货',
      subEn: 'Pickup is already on — turn on delivery too?', subCn: '到店自取已开启，也开通配送？',
      go: suGoFulfillment },
    { key: 'open', time: '1 min',
      en: 'Open the doors', cn: '正式开店',
      subEn: 'Your web store goes live — share the link anywhere', subCn: '网页商店上线，链接随处可分享',
      go: suGoOpen },
  ];
}
// Optional "nice to have" items — never block opening.
function suOptional() {
  return [
    { key: 'wechat', time: 'days',
      en: 'Sell inside WeChat', cn: '入驻微信小程序',
      subEn: 'Needs WeChat accounts and approval — set up when you’re ready', subCn: '需要微信账号和审核，准备好再设置',
      go: suGoWechat },
    { key: 'brand', time: '10 min',
      en: 'Make it look like you', cn: '换上你的品牌形象',
      subEn: 'Logo, brand colour, home page — a neutral look is already in place', subCn: 'Logo、品牌色、首页，默认已有一套中性外观',
      go: suGoBrand },
  ];
}

// ── Data ────────────────────────────────────────────────────────────────────
async function suLoad() {
  try { const j = await api('/api/retail-admin/setup'); SETUP = j.data; return SETUP; }
  catch (e) { return null; }
}
function suStepDone(key) {
  const all = [ ...(SETUP?.steps || []), ...(SETUP?.optional || []) ];
  return !!(all.find(s => s.key === key) || {}).done;
}
async function suSetFlag(patch) {
  try { const j = await api('/api/retail-admin/setup', { method: 'POST', body: patch }); SETUP = j.data; }
  catch (e) { /* leave last-known status on error */ }
  suRefreshChrome();
  return SETUP;
}

// ── Icons (monochrome line SVG, inherit currentColor) ────────────────────────
const SU_ICON = {
  store:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>',
  products:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7l-8-4-8 4v10l8 4 8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>',
  payment:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  fulfillment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h11v9H5z"/><path d="M16 11h3l2 3v3h-5"/><circle cx="8" cy="19" r="1.6"/><circle cx="18" cy="19" r="1.6"/></svg>',
  open:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  wechat:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  brand:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-2a2 2 0 0 1-2-2V6a2 2 0 0 0-2-2z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/></svg>',
  check:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  arrow:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

// Progress ring as inline SVG. r=27, circumference≈169.6.
function suRing(percent, size) {
  const p = Math.max(0, Math.min(100, percent || 0));
  const C = 169.6, off = C * (1 - p / 100);
  const s = size || 64;
  return `<div class="su-ring" style="width:${s}px;height:${s}px">
    <svg viewBox="0 0 64 64" style="width:${s}px;height:${s}px">
      <circle cx="32" cy="32" r="27" fill="none" stroke="var(--line,#e8e4da)" stroke-width="6"/>
      <circle cx="32" cy="32" r="27" fill="none" stroke="var(--brass)" stroke-width="6"
              stroke-dasharray="${C}" stroke-dashoffset="${off}" stroke-linecap="round"
              transform="rotate(-90 32 32)"/>
    </svg>
    <div class="su-ring-lbl" style="font-size:${Math.round(s*0.2)}px">${p}%</div>
  </div>`;
}

// ── The guide page (#tab-setup) ──────────────────────────────────────────────
function suRenderGuide() {
  const host = document.getElementById('setup-guide');
  if (!host) return;
  if (!SETUP) { host.innerHTML = `<div class="su-loading">${cuT('Loading…', '加载中…')}</div>`; return; }

  const done = SETUP.requiredDone, total = SETUP.requiredTotal;
  const next = suSteps().find(s => !suStepDone(s.key));
  const nextLine = SETUP.allDone
    ? cuT('Everything’s done — your store is open.', '全部完成 — 你的店已经开张。')
    : cuT('Next: ', '下一步：') + (next ? cuT(next.en, next.cn) : '');

  const rowHtml = (s, isOpt) => {
    const isDone = suStepDone(s.key);
    const isNext = !isOpt && !isDone && next && s.key === next.key;
    const cls = isDone ? 'done' : isNext ? 'now' : (isOpt ? 'opt' : '');
    const st = isDone
      ? `<div class="su-st">${SU_ICON.check}</div>`
      : `<div class="su-st">${SU_ICON[s.key] || ''}</div>`;
    const right = isDone
      ? `<span class="su-donechip">${SU_ICON.check}${cuT('Done', '已完成')}</span>`
      : `<span class="su-time">${s.time}</span>
         <button class="btn btn-sm${isNext ? ' btn-primary' : ''}" type="button" onclick="suRun('${s.key}')">${isNext ? cuT('Set up', '去设置') : cuT('Open', '打开')}</button>`;
    return `<div class="su-task ${cls}">
      ${st}
      <div class="su-tx"><b>${cuT(s.en, s.cn)}</b><span>${cuT(s.subEn, s.subCn)}</span></div>
      ${right}
    </div>`;
  };

  host.innerHTML = `
    <div class="su-card">
      <div class="su-ghead">
        <div>
          <h2 style="margin:0">${cuT('Open your store', '把店开起来')}</h2>
          <p class="su-sub">${done} ${cuT('of', '/')} ${total} ${cuT('done', '完成')}. ${escapeHtml(nextLine)}</p>
        </div>
        ${suRing(SETUP.percent, 64)}
      </div>
      <div class="su-tasks">
        ${suSteps().map(s => rowHtml(s, false)).join('')}
        <div class="su-divider">${cuT('Nice to have — do these anytime', '锦上添花 — 随时可做')}</div>
        ${suOptional().map(s => rowHtml(s, true)).join('')}
      </div>
    </div>`;
}

// Run a step: mark intent, route into the real surface. `open` and `fulfillment`
// have their own confirm-flows; the rest just navigate.
function suRun(key) {
  const step = [...suSteps(), ...suOptional()].find(s => s.key === key);
  if (step && typeof step.go === 'function') step.go();
}

// ── Routes into real surfaces ────────────────────────────────────────────────
// Each opens the page/wizard that already exists. Where a "back to guide" strip
// helps, we drop a one-shot hint the target page can show (suReturnHint).
function suReturnHint(msgEn, msgCn) {
  try { sessionStorage.setItem('su_return', JSON.stringify({ en: msgEn, cn: msgCn })); } catch (_) {}
}
function suGoStore() {
  // A brand-new operator used to be dropped into the full Settings → Operations
  // → Stores form (30+ fields, raw codes, GPS boxes) and had no idea what to do.
  // Instead we run a focused, one-question-at-a-time wizard. It creates/updates
  // the tenant's store from plain answers; the guide's `store` step then ticks
  // itself off from real data (a store row with an address).
  suStoreWizOpen();
}

// ── "Tell us about your store" wizard ────────────────────────────────────────
// Four short questions, asked one screen at a time. Name + where are required
// (an address is what makes the step count as done); phone + hours can be
// skipped for later. On finish it writes ONE store row via the existing
// /api/retail-admin/stores endpoint (which auto-geocodes the address into a map
// pin), and — when hours are given — the pickup.window checkout config too.
let STORE_WIZ = null;

// Prefill the wizard data from an existing store row, or blanks for a new one.
function suStoreWizData(t) {
  return {
    name_en: t?.name_en || '', name_cn: t?.name_cn || '',
    city: t?.city || '', district: t?.district || '', address: t?.address || '',
    phone: t?.phone || '',
    open: t?.open_time || '', close: t?.close_time || '',
    timezone: t?.timezone || '', onlineOnly: false,
    lat: (t && t.lat != null) ? t.lat : null, lng: (t && t.lng != null) ? t.lng : null,
    tzShown: !!(t && t.timezone),
  };
}
function suNewWizState(stores) {
  return {
    step: 1, total: 4, targetId: null, stores,
    existingCodes: stores.map(s => s.code), data: suStoreWizData(null),
    showMap: false, mapCfg: undefined,
  };
}

async function suStoreWizOpen() {
  let stores = [];
  try {
    const j = await api('/api/retail-admin/stores');
    stores = (j.data || []).filter(s => s.is_active !== 0 && s.is_active !== false);
  } catch (_) {}
  STORE_WIZ = suNewWizState(stores);
  // Already run more than one location? Don't silently edit the first — ask
  // which store this is for (or add a new one).
  if (stores.length >= 2) return suStoreWizPicker();
  // Zero or one store: go straight in, editing the one that exists (if any).
  const t = stores[0] || null;
  STORE_WIZ.targetId = t ? t.id : null;
  STORE_WIZ.data = suStoreWizData(t);
  suStoreWizRender();
}

// Common IANA timezones offered in the wizard. China first (the default).
const SU_TZ = [
  ['Asia/Shanghai', 'China · 中国 (UTC+8)'],
  ['Asia/Hong_Kong', 'Hong Kong · 香港 (UTC+8)'],
  ['Asia/Singapore', 'Singapore · 新加坡 (UTC+8)'],
  ['Asia/Tokyo', 'Japan · 日本 (UTC+9)'],
  ['Asia/Bangkok', 'Thailand · 泰国 (UTC+7)'],
  ['Asia/Kolkata', 'India · 印度 (UTC+5:30)'],
  ['Asia/Dubai', 'UAE · 阿联酋 (UTC+4)'],
  ['Europe/London', 'UK · 英国 (UTC+0/1)'],
  ['Europe/Paris', 'Central Europe · 欧洲中部 (UTC+1/2)'],
  ['America/New_York', 'US Eastern · 美东 (UTC-5/4)'],
  ['America/Los_Angeles', 'US Pacific · 美西 (UTC-8/7)'],
  ['Australia/Sydney', 'Sydney · 悉尼 (UTC+10/11)'],
];
function suTzLabel(tz) {
  const row = SU_TZ.find(r => r[0] === (tz || 'Asia/Shanghai'));
  return row ? row[1] : (tz || 'Asia/Shanghai');
}

// Map config (provider + JS key) for the pin-confirm preview. Cached on the
// wizard state; null when no maps JS key is set → the map preview stays hidden.
async function suStoreWizMapCfg() {
  const W = STORE_WIZ;
  if (!W) return null;
  if (W.mapCfg !== undefined) return W.mapCfg;
  let cfg = null;
  try { const j = await api('/api/retail/maps-config'); cfg = (j && j.data) || null; } catch (_) {}
  W.mapCfg = cfg;
  return cfg;
}

// Store picker — shown only when the tenant already has 2+ locations.
function suStoreWizPicker() {
  const stores = STORE_WIZ.stores || [];
  const rows = stores.map(s => `
    <button class="su-choice" type="button" style="flex-direction:row;align-items:center;gap:12px" onclick="suStoreWizPick(${s.id})">
      <span class="su-choice-ic" style="margin-bottom:0">${SU_ICON.store}</span>
      <span style="flex:1;min-width:0;text-align:left">
        <b style="display:block">${escapeHtml(s.name_en || s.name_cn || s.code)}</b>
        <span>${escapeHtml(s.address || cuT('No address yet', '还没有地址'))}</span>
      </span>
    </button>`).join('');
  suModal(`
    <div class="su-mhead">
      <div class="su-wiz-crumb">${cuT('Tell us about your store', '填写店铺信息')}</div>
      <button class="su-x" type="button" onclick="suStoreWizClose()">✕</button>
    </div>
    <div class="su-wiz-q">${cuT('Which store do you want to set up?', '你想设置哪家店？')}</div>
    <div class="su-choose" style="grid-template-columns:1fr;margin-top:12px">
      ${rows}
      <button class="su-choice" type="button" style="flex-direction:row;align-items:center;gap:12px" onclick="suStoreWizPick(null)">
        <span class="su-choice-ic" style="margin-bottom:0">${SU_ICON.arrow}</span>
        <span style="flex:1;min-width:0;text-align:left">
          <b style="display:block">${cuT('Add a new location', '新增一家门店')}</b>
          <span>${cuT('Set up another store', '设置另一家店')}</span>
        </span>
      </button>
    </div>`);
}
function suStoreWizPick(id) {
  const W = STORE_WIZ;
  const t = id != null ? (W.stores || []).find(s => s.id === id) : null;
  W.targetId = t ? t.id : null;
  W.data = suStoreWizData(t);
  W.step = 1;
  suStoreWizRender();
}

// One step → { q, html, skippable }. Copy is plain, concrete, one idea per line.
function suStoreWizStep(step) {
  const W = STORE_WIZ, d = W.data, A = s => escapeAttr(s || '');
  if (step === 1) return {
    skippable: false,
    q: cuT('What’s your store called?', '你的店叫什么名字？'),
    html: `
      <p class="su-mnote">${cuT('This is the name customers see.', '顾客会看到这个名字。')}</p>
      <input class="su-wiz-in" id="swz_name" value="${A(d.name_en)}"
             placeholder="${cuT('e.g. Green Leaf Grocer', '例如 绿叶生鲜')}">
      <div id="swz_name_cn_wrap" style="margin-top:12px;${d.name_cn ? '' : 'display:none'}">
        <label class="field-label">${cuT('Chinese name', '中文名')}
          <span style="color:var(--text-3);font-weight:400">— ${cuT('optional', '可选')}</span></label>
        <input class="su-wiz-in" id="swz_name_cn" value="${A(d.name_cn)}"
               placeholder="${cuT('e.g. 绿叶生鲜', '例如 绿叶生鲜')}">
      </div>
      ${d.name_cn ? '' : `<button type="button" class="su-wiz-link"
        onclick="document.getElementById('swz_name_cn_wrap').style.display='';this.style.display='none'">
        + ${cuT('Add a name in Chinese', '添加中文名')}</button>`}`,
  };
  if (step === 2) {
    const online = d.onlineOnly;
    const mapAvail = W.mapCfg && W.mapCfg.provider;   // undefined until first fetch → button shows, then self-hides
    return {
      skippable: false,
      q: cuT('Where is your store?', '你的店在哪里？'),
      html: `
        <p class="su-mnote">${cuT('We place you on the map so customers can find you and delivery works later.', '我们会在地图上定位，方便顾客找到你，也为日后的配送做准备。')}</p>
        <label class="su-wiz-check">
          <input type="checkbox" id="swz_online" ${online ? 'checked' : ''} onchange="suStoreWizToggleOnline(this.checked)">
          <span>${cuT('I don’t have a walk-in store (online / delivery only)', '我没有到店门店（仅线上/配送）')}</span>
        </label>
        <div id="swz_addr_block" style="${online ? 'display:none' : ''}">
          <div style="display:flex;gap:10px;margin-top:12px">
            <div style="flex:1"><label class="field-label">${cuT('City', '城市')}</label>
              <input class="su-wiz-in" id="swz_city" value="${A(d.city)}" placeholder="${cuT('e.g. Guangzhou', '例如 广州')}"></div>
            <div style="flex:1"><label class="field-label">${cuT('District', '区')}</label>
              <input class="su-wiz-in" id="swz_district" value="${A(d.district)}" placeholder="${cuT('e.g. Tianhe', '例如 天河区')}"></div>
          </div>
          <label class="field-label" style="margin-top:12px">${cuT('Street address', '详细地址')}</label>
          <input class="su-wiz-in" id="swz_address" value="${A(d.address)}"
                 placeholder="${cuT('Building, street and number', '门牌号、街道、楼栋')}">
          ${mapAvail && !W.showMap ? `<button type="button" class="su-wiz-link" onclick="suStoreWizShowMap()">
            + ${cuT('Check the pin on a map', '在地图上核对位置')}</button>` : ''}
          ${W.showMap ? `
            <div class="su-wiz-map" id="swz_map">
              <div class="su-wiz-map-canvas" id="swz_map_canvas"></div>
              <div class="su-wiz-map-pin">${SU_ICON.store}</div>
            </div>
            <div class="su-wiz-hint">${SU_ICON.check}
              <span>${cuT('Drag the map so the pin sits on your door.', '拖动地图，让图钉对准你的门店。')}
              <button type="button" class="su-wiz-link" style="margin-top:4px" onclick="suStoreWizRelocate()">${cuT('Re-locate from the address', '按地址重新定位')}</button></span></div>` : ''}
        </div>`,
    };
  }
  if (step === 3) return {
    skippable: true,
    q: cuT('A phone customers can call?', '顾客可以拨打的电话？'),
    html: `
      <p class="su-mnote">${cuT('For questions about an order. You can add this later.', '方便顾客咨询订单。也可以以后再填。')}</p>
      <input class="su-wiz-in" id="swz_phone" value="${A(d.phone)}" placeholder="020-XXXXXXXX">`,
  };
  return {
    skippable: true,
    q: cuT('When are you open?', '你的营业时间？'),
    html: `
      <p class="su-mnote">${cuT('These become your pickup hours at checkout.', '结账时的到店自取时段会用到它。')}</p>
      <div style="display:flex;gap:10px">
        <div style="flex:1"><label class="field-label">${cuT('Opens at', '开门')}</label>
          <input class="su-wiz-in" type="time" id="swz_open" value="${A(d.open)}"></div>
        <div style="flex:1"><label class="field-label">${cuT('Closes at', '关门')}</label>
          <input class="su-wiz-in" type="time" id="swz_close" value="${A(d.close)}"></div>
      </div>
      <div id="swz_tz_wrap" style="margin-top:12px">
        ${d.tzShown ? `
          <label class="field-label">${cuT('Time zone', '时区')}</label>
          <select class="su-wiz-in" id="swz_tz">
            ${SU_TZ.map(r => `<option value="${r[0]}"${(d.timezone || 'Asia/Shanghai') === r[0] ? ' selected' : ''}>${escapeHtml(r[1])}</option>`).join('')}
          </select>`
        : `<div class="su-wiz-tzline">${cuT('Time zone', '时区')}: <b>${escapeHtml(suTzLabel(d.timezone))}</b>
            <button type="button" class="su-wiz-link" onclick="suStoreWizShowTz()">${cuT('Change', '更改')}</button></div>`}
      </div>
      <div class="su-wiz-hint">${SU_ICON.check}
        <span>${cuT('Same hours every day for now — set different hours per day later in Settings.', '目前每天相同，之后可到设置里为每天单独设置。')}</span></div>`,
  };
}

function suStoreWizRender() {
  const W = STORE_WIZ;
  if (!W) return;
  const s = suStoreWizStep(W.step);
  const dots = Array.from({ length: W.total }, (_, i) =>
    `<span class="su-wiz-dot${i + 1 === W.step ? ' on' : ''}${i + 1 < W.step ? ' done' : ''}"></span>`).join('');
  const last = W.step === W.total;
  suModal(`
    <div class="su-mhead">
      <div class="su-wiz-crumb">${cuT('Tell us about your store', '填写店铺信息')} ·
        ${cuT('Step', '第')} ${W.step} ${cuT('of', '/')} ${W.total}</div>
      <button class="su-x" type="button" onclick="suStoreWizClose()">✕</button>
    </div>
    <div class="su-wiz-dots">${dots}</div>
    <div class="su-wiz-q">${s.q}</div>
    ${s.html}
    <div class="su-mfoot" style="justify-content:space-between">
      <div>${W.step > 1 ? `<button class="btn" type="button" onclick="suStoreWizBack()">${cuT('Back', '上一步')}</button>` : ''}</div>
      <div style="display:flex;gap:8px">
        ${s.skippable ? `<button class="btn" type="button" onclick="suStoreWizSkip()">${cuT('Skip for now', '暂时跳过')}</button>` : ''}
        <button class="btn btn-primary" type="button" onclick="${last ? 'suStoreWizFinish()' : 'suStoreWizNext()'}">
          ${last ? cuT('Save & finish', '保存并完成') : cuT('Next', '下一步')} ${SU_ICON.arrow}</button>
      </div>
    </div>`);
  // On the "where" step, resolve whether a map key exists (once) so the
  // "Check the pin on a map" button can appear; re-render when it lands.
  if (W.step === 2 && W.mapCfg === undefined) {
    suStoreWizMapCfg().then(() => { if (STORE_WIZ && STORE_WIZ.step === 2) suStoreWizRender(); });
  }
  // The map preview must init AFTER its container is in the DOM.
  if (W.step === 2 && W.showMap && !W.data.onlineOnly) setTimeout(suStoreWizInitMap, 30);
  setTimeout(() => { const el = document.querySelector('#su-modal .su-wiz-in'); if (el) el.focus(); }, 60);
}

// Read whatever inputs the current step shows back into the wizard state, so
// nothing typed is lost when moving between steps.
function suStoreWizCollect() {
  const W = STORE_WIZ;
  if (!W) return;
  const g = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const set = (k, id) => { const v = g(id); if (v !== undefined) W.data[k] = v; };
  set('name_en', 'swz_name'); set('name_cn', 'swz_name_cn');
  set('city', 'swz_city'); set('district', 'swz_district'); set('address', 'swz_address');
  set('phone', 'swz_phone'); set('open', 'swz_open'); set('close', 'swz_close');
  const online = document.getElementById('swz_online'); if (online) W.data.onlineOnly = online.checked;
  const tz = document.getElementById('swz_tz'); if (tz) W.data.timezone = tz.value;
}

// Step-2 controls.
function suStoreWizToggleOnline(on) {
  suStoreWizCollect();
  STORE_WIZ.data.onlineOnly = !!on;
  if (on) STORE_WIZ.showMap = false;
  suStoreWizRender();
}
function suStoreWizShowMap() {
  suStoreWizCollect();
  STORE_WIZ.data.lat = null; STORE_WIZ.data.lng = null;   // geocode fresh from the typed address
  STORE_WIZ.showMap = true;
  suStoreWizRender();
}
function suStoreWizRelocate() {
  suStoreWizCollect();
  STORE_WIZ.data.lat = null; STORE_WIZ.data.lng = null;
  suStoreWizRender();   // re-render re-inits the map → re-geocodes from the address
}
function suStoreWizShowTz() {
  suStoreWizCollect();
  STORE_WIZ.data.tzShown = true;
  if (!STORE_WIZ.data.timezone) STORE_WIZ.data.timezone = 'Asia/Shanghai';
  suStoreWizRender();
}

// Load the maps JS SDK once (amap or tencent), mirroring shop.html's picker.
let _suMapSdkP = null;
function suStoreWizLoadSdk(cfg) {
  if (_suMapSdkP) return _suMapSdkP;
  _suMapSdkP = new Promise((resolve, reject) => {
    const cb = '__suMapReady';
    window[cb] = () => resolve(cfg.provider);
    let src;
    if (cfg.provider === 'amap') {
      if (cfg.security) window._AMapSecurityConfig = { securityJsCode: cfg.security };
      src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(cfg.key) + '&callback=' + cb;
    } else {
      src = 'https://map.qq.com/api/gljs?v=1.exp&key=' + encodeURIComponent(cfg.key) + '&callback=' + cb;
    }
    const el = document.createElement('script'); el.src = src; el.async = true;
    el.onerror = () => { _suMapSdkP = null; reject(new Error('sdk_load_failed')); };
    document.head.appendChild(el);
  });
  return _suMapSdkP;
}
// Build the pin-confirm map: a fixed centre pin overlays the canvas, the map
// pans under it, and the centre coords become the store's lat/lng. Degrades to
// the auto-geocode-on-save fallback if anything is unavailable.
async function suStoreWizInitMap() {
  const W = STORE_WIZ;
  if (!W || !document.getElementById('swz_map_canvas')) return;
  const cfg = await suStoreWizMapCfg();
  if (!cfg || !cfg.provider) { W.showMap = false; if (STORE_WIZ) suStoreWizRender(); return; }
  let provider;
  try { provider = await suStoreWizLoadSdk(cfg); } catch (_) { W.showMap = false; return; }
  // The user may have navigated away while the SDK loaded.
  if (!STORE_WIZ || STORE_WIZ.step !== 2) return;
  let center = (W.data.lat != null && W.data.lng != null) ? { lat: +W.data.lat, lng: +W.data.lng } : null;
  if (!center) {
    try {
      const j = await api('/api/retail-admin/geocode', { method: 'POST', body: { city: W.data.city, district: W.data.district, address: W.data.address } });
      if (j && j.data && j.data.lat != null) center = { lat: j.data.lat, lng: j.data.lng };
    } catch (_) {}
  }
  if (!center) center = { lat: 23.1291, lng: 113.2644 };   // Guangzhou fallback
  W.data.lat = center.lat; W.data.lng = center.lng;
  const el = document.getElementById('swz_map_canvas');
  if (!el) return;
  try {
    if (provider === 'amap' && window.AMap) {
      const map = new AMap.Map(el, { zoom: 16, center: [center.lng, center.lat], resizeEnable: true });
      map.on('moveend', () => { const c = map.getCenter(); if (STORE_WIZ) { STORE_WIZ.data.lat = c.getLat(); STORE_WIZ.data.lng = c.getLng(); } });
    } else if (window.TMap) {
      const map = new TMap.Map(el, { zoom: 16, center: new TMap.LatLng(center.lat, center.lng) });
      map.on('center_changed', () => { const c = map.getCenter(); if (STORE_WIZ) { STORE_WIZ.data.lat = c.getLat(); STORE_WIZ.data.lng = c.getLng(); } });
    }
  } catch (_) { /* leave the auto-geocode-on-save fallback in place */ }
}

function suStoreWizNext() {
  suStoreWizCollect();
  const W = STORE_WIZ;
  if (W.step === 1 && !(W.data.name_en || '').trim()) return toast(cuT('Please enter a store name', '请填写店铺名称'), 'error');
  if (W.step === 2 && !W.data.onlineOnly && !(W.data.address || '').trim()) return toast(cuT('Please enter the street address', '请填写详细地址'), 'error');
  W.step = Math.min(W.total, W.step + 1);
  suStoreWizRender();
}
function suStoreWizBack() {
  suStoreWizCollect();
  STORE_WIZ.step = Math.max(1, STORE_WIZ.step - 1);
  suStoreWizRender();
}
function suStoreWizSkip() {
  const W = STORE_WIZ;
  suStoreWizCollect();
  if (W.step === 3) W.data.phone = '';
  if (W.step === 4) { W.data.open = ''; W.data.close = ''; }
  if (W.step === W.total) return suStoreWizFinish();
  W.step = Math.min(W.total, W.step + 1);
  suStoreWizRender();
}
function suStoreWizClose() {
  STORE_WIZ = null;
  suCloseModal();
}

// Pick a short unique code for a brand-new store ('main', else 'store-2', …).
function suStoreWizCode() {
  const taken = new Set(STORE_WIZ.existingCodes || []);
  if (!taken.has('main')) return 'main';
  let n = 2;
  while (taken.has('store-' + n)) n++;
  return 'store-' + n;
}

async function suStoreWizFinish() {
  suStoreWizCollect();
  const W = STORE_WIZ, d = W.data;
  const online = !!d.onlineOnly;
  // Safety: a name is always required; an address is required unless the seller
  // has no walk-in store. Jump back to whichever is missing.
  if (!(d.name_en || '').trim()) { W.step = 1; return suStoreWizRender(); }
  if (!online && !(d.address || '').trim()) { W.step = 2; return suStoreWizRender(); }
  const body = {
    name_en: d.name_en.trim(),
    name_cn: (d.name_cn || '').trim() || null,
    city: online ? null : ((d.city || '').trim() || null),
    district: online ? null : ((d.district || '').trim() || null),
    address: online ? null : d.address.trim(),
    phone: (d.phone || '').trim() || null,
    open_time: d.open || null,
    close_time: d.close || null,
    // Per-store hours now drive checkout directly; store the timezone they're
    // in so the pickup window validates against the store's local clock.
    timezone: (d.timezone || '').trim() || null,
    // Online/delivery-only sellers aren't a walk-in pickup point.
    pickup_enabled: !online,
  };
  // Only pin explicit coords when the operator actually confirmed them on the
  // map; otherwise omit lat/lng so the backend geocodes from the address.
  if (!online && W.showMap && d.lat != null && d.lng != null) {
    body.lat = d.lat; body.lng = d.lng;
  }
  try {
    if (W.targetId) {
      await api('/api/retail-admin/stores/' + W.targetId, { method: 'PATCH', body });
    } else {
      body.code = suStoreWizCode();
      await api('/api/retail-admin/stores', { method: 'POST', body });
    }
    // No street address to detect → mark the step done explicitly.
    if (online) { try { await api('/api/retail-admin/setup', { method: 'POST', body: { storeInfoDone: true } }); } catch (_) {} }
    toast(cuT('Store details saved', '店铺信息已保存'), 'ok');
    await suLoad();
    suRenderGuide();
    suRefreshChrome();
    // Multi-store tenants can add every location in one sitting.
    suStoreWizSavedPrompt();
  } catch (e) {
    toast(cuT('Save failed', '保存失败') + ': ' + e.message, 'error');
  }
}

// After a save, offer to add another location (a store chain sets them all up
// at once). "Done" just closes.
function suStoreWizSavedPrompt() {
  suModal(`
    <div class="su-done-hero" style="padding:10px 8px 2px">
      <div class="su-done-big">${SU_ICON.check}</div>
      <h3>${cuT('Store saved', '门店已保存')}</h3>
      <p>${cuT('Do you have another location to add?', '还有其他门店要添加吗？')}</p>
    </div>
    <div class="su-mfoot" style="justify-content:center">
      <button class="btn" type="button" onclick="suStoreWizClose()">${cuT('No, I’m done', '不用了，完成')}</button>
      <button class="btn btn-primary" type="button" onclick="suStoreWizAddAnother()">${cuT('Add another location', '再加一家')} ${SU_ICON.arrow}</button>
    </div>`);
}
async function suStoreWizAddAnother() {
  // Re-read the store list so the one just saved is in existingCodes (a new
  // location must get a fresh unique code), then start a blank pass.
  let stores = [];
  try {
    const j = await api('/api/retail-admin/stores');
    stores = (j.data || []).filter(s => s.is_active !== 0 && s.is_active !== false);
  } catch (_) {}
  const prevCfg = STORE_WIZ ? STORE_WIZ.mapCfg : undefined;
  STORE_WIZ = suNewWizState(stores);
  STORE_WIZ.mapCfg = prevCfg;   // keep the resolved map config across passes
  suStoreWizRender();
}
function suGoProducts() {
  // The Products tab already ships its own guided add-a-product wizard (pwOpen,
  // part 09) — a name, a price and a photo is enough. Open it straight away
  // instead of dropping the operator onto the raw product grid.
  suReturnHint('Add at least one product, then this step ticks itself off.', '上架至少一个商品，此步骤会自动完成。');
  goTab('products');
  setTimeout(() => { if (typeof pwOpen === 'function') try { pwOpen(); } catch (_) {} }, 300);
}
function suGoPayment() {
  // A brand-new operator lands on the manual-Alipay card buried in Settings and
  // has to know what to fill in. Instead run a tiny chooser: Alipay QR works the
  // same day; WeChat Pay needs a merchant account and approval, so it routes to
  // its own setup for later.
  suPayChooser();
}
function suGoFulfillment() {
  // Pickup is on by default; offer delivery (the 3-question wizard) or confirm
  // pickup-only. A tiny chooser keeps the guide honest without a new page.
  suFulfillChooser();
}
function suGoWechat() {
  // The Mini App credentials wizard (part 15).
  if (typeof igLaunchSetup === 'function') { igLaunchSetup('wechat_miniapp'); return; }
  if (typeof igMiniappConfig === 'function') { igMiniappConfig(); return; }
  salesGo('config');
}
function suGoBrand() {
  openMiniAppEditor && openMiniAppEditor();
}
function suGoOpen() { suOpenDoors(); }

// ── Payment wizard (Alipay QR first) ─────────────────────────────────────────
// Two live paths. Alipay QR = upload your收款码 image and you can take money the
// same day (no approval). WeChat Pay needs a merchant account + approval, so it
// routes to the payment settings to finish later. The step ticks itself off once
// either method is actually ready.
let PAY_WIZ = null;

async function suPayChooser() {
  // Currency is surfaced here (not in the store step) because it pairs with how
  // you get paid. Prefill from live config.
  let curCode = 'CNY';
  try { const j = await api('/api/retail-admin/config'); curCode = (j.data && j.data.currency && j.data.currency.code) || 'CNY'; } catch (_) {}
  const presets = (typeof CURRENCY_PRESETS !== 'undefined' && CURRENCY_PRESETS) || [{ code: 'CNY', label: 'Chinese Yuan · 人民币 (¥)' }];
  const opts = presets.map(p => `<option value="${p.code}"${p.code === curCode ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('');
  suModal(`
    <div class="su-mhead">
      <h3>${cuT('How do you want to get paid?', '你想怎么收款？')}</h3>
      <button class="su-x" type="button" onclick="suCloseModal()">✕</button>
    </div>
    <label class="field-label">${cuT('Currency you price in', '你的定价货币')}</label>
    <select class="su-wiz-in" id="su_pay_currency" onchange="suSaveCurrency(this.value)">${opts}</select>
    <div class="su-wiz-hint">${SU_ICON.check}
      <span>${cuT('WeChat Pay & Alipay still charge in RMB — this only sets how prices are shown.', '微信/支付宝仍以人民币收款，此项仅设置价格显示方式。')}</span></div>
    <p class="su-mnote" style="margin-top:16px">${cuT('Pick a payment method to start — you can add the other later.', '先选一种收款方式，另一种可以以后再加。')}</p>
    <div class="su-choose">
      <button class="su-choice" type="button" onclick="suPayAlipay()">
        <span class="su-choice-ic">${SU_ICON.payment}</span>
        <b>${cuT('Alipay QR code', '支付宝收款码')}</b>
        <span>${cuT('Works today — just upload your payment QR', '当天可用 — 上传收款码即可')}</span>
      </button>
      <button class="su-choice" type="button" onclick="suPayWechat()">
        <span class="su-choice-ic">${SU_ICON.wechat}</span>
        <b>${cuT('WeChat Pay', '微信支付')}</b>
        <span>${cuT('Needs a merchant account and approval', '需要商户号和审核')}</span>
      </button>
    </div>`);
}
// Save the chosen display currency from the guide's payment step (mirrors the
// Settings → Currency card; both write the same config.currency).
async function suSaveCurrency(code) {
  const presets = (typeof CURRENCY_PRESETS !== 'undefined' && CURRENCY_PRESETS) || [];
  const p = presets.find(x => x.code === code);
  if (!p) return;
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { currency: { code: p.code, symbol: p.symbol, decimals: p.decimals, position: p.position } } });
    toast(cuT('Currency saved', '货币已保存'), 'ok');
  } catch (e) { toast(cuT('Save failed', '保存失败') + ': ' + e.message, 'error'); }
}

function suPayAlipay() {
  PAY_WIZ = { qr: null, account: '' };
  suPayAlipayRender('');
}
function suPayAlipayRender(preview) {
  suModal(`
    <div class="su-mhead">
      <div class="su-wiz-crumb">${cuT('Get paid with Alipay', '用支付宝收款')}</div>
      <button class="su-x" type="button" onclick="suCloseModal()">✕</button>
    </div>
    <div class="su-wiz-q">${cuT('Upload your Alipay payment QR', '上传你的支付宝收款码')}</div>
    <p class="su-mnote">${cuT('In Alipay: Me → Receive money → save the QR image, then add it here. Customers scan it to pay.', '在支付宝里：我的 → 收钱 → 保存收款码图片，然后上传到这里。顾客扫码付款。')}</p>
    <input type="file" accept="image/*" id="swz_qr_file" style="display:none" onchange="suPayQrPick(event)">
    <div style="margin-top:12px;display:flex;flex-direction:column;align-items:center;gap:12px">
      <img id="swz_qr_prev" src="${escapeAttr(preview || '')}" alt="" style="${preview ? '' : 'display:none'};max-width:200px;border-radius:var(--r-md);border:1px solid var(--line)">
      <button class="btn" type="button" onclick="document.getElementById('swz_qr_file').click()">
        ${preview ? cuT('Choose a different image', '换一张图片') : cuT('Choose QR image', '选择收款码图片')}</button>
    </div>
    <label class="field-label" style="margin-top:14px">${cuT('Payee name', '收款人姓名')}
      <span style="color:var(--text-3);font-weight:400">— ${cuT('optional', '可选')}</span></label>
    <input class="su-wiz-in" id="swz_pay_account" value="${escapeAttr(PAY_WIZ ? PAY_WIZ.account : '')}"
           placeholder="${cuT('The name shown on your Alipay account', '你支付宝账户显示的姓名')}">
    <div class="su-mfoot" style="justify-content:space-between">
      <button class="btn" type="button" onclick="suPayChooser()">${cuT('Back', '上一步')}</button>
      <button class="btn btn-primary" type="button" onclick="suPayAlipaySave()">${cuT('Turn on Alipay', '开启支付宝收款')} ${SU_ICON.arrow}</button>
    </div>`);
}
function suPayCollectAccount() {
  const el = document.getElementById('swz_pay_account');
  if (el && PAY_WIZ) PAY_WIZ.account = el.value;
}
// Read the picked QR, downscale it to keep the base64 under the proxy body limit
// (a QR stays crisp well under 1000px), then re-render with the preview.
function suPayQrPick(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast(cuT('Image too large (max 10MB)', '图片过大(最大10MB)'), 'error'); event.target.value = ''; return; }
  suPayCollectAccount();
  const reader = new FileReader();
  reader.onload = () => {
    const done = (dataUrl) => { if (PAY_WIZ) PAY_WIZ.qr = dataUrl; suPayAlipayRender(dataUrl); };
    const img = new Image();
    img.onload = () => {
      let out = reader.result;
      try {
        const MAX = 1000;
        const scale = Math.min(1, MAX / Math.max(img.naturalWidth || MAX, img.naturalHeight || MAX));
        const w = Math.max(1, Math.round((img.naturalWidth || MAX) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || MAX) * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const jpg = c.toDataURL('image/jpeg', 0.85);
        if (jpg && jpg.length < reader.result.length) out = jpg;
      } catch (_) {}
      done(out);
    };
    img.onerror = () => done(reader.result);   // not decodable → send raw, server validates
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
async function suPayAlipaySave() {
  suPayCollectAccount();
  if (!PAY_WIZ || !PAY_WIZ.qr) return toast(cuT('Upload your QR image first', '请先上传收款码图片'), 'error');
  const body = { enabled: true, account: (PAY_WIZ.account || '').trim(), qr: PAY_WIZ.qr };
  try {
    const r = await fetch('/api/retail-admin/alipay-manual', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.error || 'save_failed');
    PAY_WIZ = null;
    suCloseModal();
    toast(cuT('Alipay is on — customers can pay now', '支付宝已开启 — 顾客现在可以付款'), 'ok');
    await suLoad();
    suRenderGuide();
    suRefreshChrome();
  } catch (e) {
    const msg = e.message === 'qr_required' || e.message === 'image_too_big'
      ? cuT('That image didn’t work — try a clearer, smaller QR', '这张图不行 — 换一张更清晰、更小的收款码')
      : cuT('Save failed', '保存失败') + ': ' + e.message;
    toast(msg, 'error');
  }
}
function suPayWechat() {
  // WeChat Pay merchant setup isn't same-day; send them to the payment settings
  // to finish when their account is approved.
  suCloseModal();
  suReturnHint('Turn on a payment method here, then this step ticks itself off.', '在这里开启一种收款方式，此步骤会自动完成。');
  goTab('config');
  const opsBtn = document.querySelector('#settings-nav button[data-sub="ops"]');
  if (opsBtn) opsBtn.click();
  suScrollTo('[data-pay-methods], #alipay-manual-enabled');
}

function suScrollTo(sel) {
  setTimeout(() => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 250);
}

// ── Fulfillment chooser ──────────────────────────────────────────────────────
async function suFulfillChooser() {
  // Prefill the pickup prep buffer from live config so it can be set right here.
  let lead = 0;
  try { const j = await api('/api/retail-admin/config'); lead = Math.max(0, Number(j.data && j.data.pickup && j.data.pickup.leadMinutes) || 0); } catch (_) {}
  const ov = suModal(`
    <div class="su-mhead">
      <h3>${cuT('How customers get their order', '顾客如何拿到货')}</h3>
      <button class="su-x" type="button" onclick="suCloseModal()">✕</button>
    </div>
    <p class="su-mnote">${cuT('Pickup at your store is already on. You can add delivery now, or keep pickup only for now.', '到店自取已开启。你可以现在开通配送，或暂时只做自取。')}</p>
    <div class="su-choose">
      <button class="su-choice" type="button" onclick="suCloseModal(); suStartDelivery()">
        <span class="su-choice-ic">${SU_ICON.fulfillment || SU_ICON.store}</span>
        <b>${cuT('Set up delivery', '开通配送')}</b>
        <span>${cuT('Three quick questions', '三个小问题')}</span>
      </button>
      <button class="su-choice" type="button" onclick="suConfirmPickup()">
        <span class="su-choice-ic">${SU_ICON.store}</span>
        <b>${cuT('Pickup only for now', '暂时只做自取')}</b>
        <span>${cuT('Customers collect at your store', '顾客到店自取')}</span>
      </button>
    </div>
    <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
      <label class="field-label">${cuT('Earliest pickup', '最早可取')}</label>
      <div style="display:flex;align-items:center;gap:8px">
        <input class="su-wiz-in" type="number" id="su_pickup_lead" min="0" step="5" value="${lead}" style="max-width:110px">
        <span style="font-size:13px;color:var(--text-3)">${cuT('min after ordering', '分钟后可取')}</span>
        <button class="btn btn-sm" type="button" onclick="suSavePickupLead()">${cuT('Save', '保存')}</button>
      </div>
      <div class="su-wiz-hint">${SU_ICON.check}
        <span>${cuT('Gives staff time to pack. 0 = customers can collect right away.', '让员工有时间备货。填 0 表示可立即自取。')}</span></div>
    </div>`);
  return ov;
}
async function suSavePickupLead() {
  const el = document.getElementById('su_pickup_lead');
  if (!el) return;
  const v = Math.max(0, Number(el.value) || 0);
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'pickup.leadMinutes': v } });
    toast(cuT('Saved', '已保存'), 'ok');
  } catch (e) { toast(cuT('Save failed', '保存失败') + ': ' + e.message, 'error'); }
}
function suStartDelivery() {
  suReturnHint('Finish the delivery questions, then this step ticks itself off.', '完成配送设置后，此步骤会自动完成。');
  goTab('delivery');
  // The Delivery tab shows its own new-user wizard when unconfigured (part 06).
  setTimeout(() => { if (typeof dlvWizOpen === 'function') try { dlvWizOpen(1); } catch (_) {} }, 300);
}
async function suConfirmPickup() {
  await suSetFlag({ pickupConfirmed: true });
  suCloseModal();
  toast(cuT('Pickup confirmed', '已确认自取'), 'ok');
  suRenderGuide();
}

// ── Open the doors ───────────────────────────────────────────────────────────
function suOpenDoors() {
  // Guard: opening before the essentials are done would put a broken store live.
  const blockers = suSteps().filter(s => s.key !== 'open' && !suStepDone(s.key));
  if (blockers.length) {
    const names = blockers.map(s => cuT(s.en, s.cn)).join(cuT(', ', '、'));
    suModal(`
      <div class="su-mhead"><h3>${cuT('Almost there', '就差一点')}</h3>
        <button class="su-x" type="button" onclick="suCloseModal()">✕</button></div>
      <p class="su-mnote">${cuT('Finish these first so customers get a working store:', '先完成这些，顾客才能看到一个可用的店：')}<br><b>${escapeHtml(names)}</b></p>
      <div class="su-mfoot"><button class="btn btn-primary" type="button" onclick="suCloseModal()">${cuT('OK', '好的')}</button></div>`);
    return;
  }
  suModal(`
    <div class="su-mhead"><h3>${cuT('Open your store now?', '现在开店？')}</h3>
      <button class="su-x" type="button" onclick="suCloseModal()">✕</button></div>
    <p class="su-mnote">${cuT('Your web store goes live and can take orders. You can keep editing anything afterwards.', '你的网页商店将上线并可接单。之后仍可继续编辑任何内容。')}</p>
    <div class="su-mfoot">
      <button class="btn" type="button" onclick="suCloseModal()">${cuT('Not yet', '还没')}</button>
      <button class="btn btn-primary" type="button" onclick="suDoOpen()">${cuT('Open the doors', '正式开店')}</button>
    </div>`);
}
async function suDoOpen() {
  await suSetFlag({ storeOpened: true });
  suCloseModal();
  suDoneScreen();
}

// ── Done screen ──────────────────────────────────────────────────────────────
function suDoneScreen() {
  const pending = suOptional().filter(s => !suStepDone(s.key));
  const pendHtml = pending.length ? `
    <div class="su-pend">
      <b>${cuT('Still waiting for you — whenever you’re ready', '还差这些 — 你随时可以补上')}</b>
      ${pending.map(s => `<div class="su-pend-row">
        ${SU_ICON.wechat}
        <span>${cuT(s.en, s.cn)}</span>
        <button class="btn btn-sm" type="button" onclick="suCloseModal(); suRun('${s.key}')">${cuT('Finish now', '现在完成')}</button>
      </div>`).join('')}
    </div>` : '';
  suModal(`
    <div class="su-done-hero">
      <div class="su-done-big">${SU_ICON.check}</div>
      <h3>${cuT('Your store is open', '你的店开张了')}</h3>
      <p>${cuT('Customers can browse, order and pay right now.', '顾客现在就能浏览、下单、付款。')}</p>
    </div>
    ${pendHtml}
    <div class="su-mfoot">
      <button class="btn" type="button" onclick="suCloseModal(); goTab('dashboard')">${cuT('Go to dashboard', '前往仪表板')}</button>
      <button class="btn btn-primary" type="button" onclick="suCloseModal(); goTab('setup')">${cuT('Back to guide', '返回引导')}</button>
    </div>`, { wide: false });
  suRefreshChrome();
}

// ── Welcome overlay (first login only) ───────────────────────────────────────
function suWelcome() {
  const steps = suSteps();
  suModal(`
    <div class="su-mhead">
      <h3>${cuT('Welcome — let’s open your store', '欢迎 — 一起把店开起来')}</h3>
      <button class="su-x" type="button" onclick="suDismissWelcome()">✕</button>
    </div>
    <p class="su-mnote">${cuT('Five short steps. Stop anytime and pick up where you left off.', '五个小步骤。随时可以暂停，下次接着做。')}</p>
    <div class="su-wsteps">
      ${steps.map(s => `<div class="su-wstep">
        <span class="su-wico">${SU_ICON[s.key] || ''}</span>
        <b>${cuT(s.en, s.cn)}</b><span class="su-wt">${s.time}</span>
      </div>`).join('')}
    </div>
    <div class="su-promise">${SU_ICON.check}
      <p>${cuT('Your web store can take its first order today — no approvals needed. Selling inside WeChat takes longer and can be set up later.', '网页商店今天就能接第一单，无需任何审批。微信小程序需要更长时间，可以以后再设置。')}</p>
    </div>
    <div class="su-mfoot">
      <button class="btn" type="button" onclick="suDismissWelcome()">${cuT('I’ll look around first', '我先随便看看')}</button>
      <button class="btn btn-primary" type="button" onclick="suStartFromWelcome()">${cuT('Start — step 1', '开始 — 第 1 步')} ${SU_ICON.arrow}</button>
    </div>`, { wide: true });
}
async function suDismissWelcome() {
  suCloseModal();
  await suSetFlag({ welcomeSeen: true });
}
async function suStartFromWelcome() {
  suCloseModal();
  await suSetFlag({ welcomeSeen: true });
  goTab('setup');
}

// ── Shared modal ─────────────────────────────────────────────────────────────
function suModal(innerHtml, opts) {
  suCloseModal();
  const ov = document.createElement('div');
  ov.id = 'su-modal';
  ov.className = 'su-modal-ov';
  ov.onclick = (e) => { if (e.target === ov) suCloseModal(); };
  ov.innerHTML = `<div class="su-modal${opts && opts.wide ? ' wide' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('open'));
  return ov;
}
function suCloseModal() { const ov = document.getElementById('su-modal'); if (ov) ov.remove(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') suCloseModal(); });

// ── Chrome: sidebar badge + dashboard card ───────────────────────────────────
// Both appear only while setup is unfinished, and vanish for good at 100%.
function suRefreshChrome() {
  const hide = !SETUP || SETUP.allDone;
  // Sidebar pinned entry.
  const nav = document.getElementById('setup-nav');
  if (nav) {
    nav.style.display = hide ? 'none' : '';
    const badge = document.getElementById('setup-nav-badge');
    if (badge && SETUP) badge.textContent = SETUP.percent + '%';
  }
  // Dashboard card.
  suRenderDashCard();
}
function suRenderDashCard() {
  const host = document.getElementById('setup-dash-card');
  if (!host) return;
  if (!SETUP || SETUP.allDone) { host.innerHTML = ''; host.style.display = 'none'; return; }
  const next = suSteps().find(s => !suStepDone(s.key));
  host.style.display = '';
  host.innerHTML = `
    <div class="su-dashcard">
      ${suRing(SETUP.percent, 52)}
      <div class="su-dashcard-tx">
        <b>${cuT('Your store isn’t open yet', '你的店还没开张')}</b>
        <span>${cuT('Next: ', '下一步：')}${next ? cuT(next.en, next.cn) : ''}${next ? ' · ' + next.time : ''}</span>
      </div>
      <button class="btn btn-primary" type="button" onclick="goTab('setup')">${cuT('Continue setup', '继续设置')} ${SU_ICON.arrow}</button>
    </div>`;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
// Called from the bootstrap (part 02). Loads status, wires the guide tab's
// lazy render, paints chrome, and — on genuine first login — lands the operator
// on the guide (with the welcome overlay). Re-render the guide whenever its tab
// is opened so it reflects freshly-completed steps.
let _suBooted = false;
async function suInit() {
  if (_suBooted) return; _suBooted = true;
  const nav = document.querySelector('.tabs [data-tab="setup"]');
  if (nav) nav.addEventListener('click', () => { suLoad().then(() => { suRenderGuide(); suRefreshChrome(); }); });
  await suLoad();
  if (!SETUP) return;
  suRefreshChrome();
  suRenderGuide();
  if (SETUP.firstLogin && !SETUP.allDone) {
    goTab('setup');
    suWelcome();
  }
  // Keep chrome honest after the operator finishes a step elsewhere and comes
  // back to the dashboard: cheap re-fetch when the dashboard tab is shown.
  const dashBtn = document.querySelector('.tabs [data-tab="dashboard"]');
  if (dashBtn) dashBtn.addEventListener('click', () => { suLoad().then(suRefreshChrome); });
}
window.suInit = suInit;
