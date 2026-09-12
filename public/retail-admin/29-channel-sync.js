/* eslint-disable no-undef */
// Channel sync — one verdict per item per channel, across Meituan, Eleme and
// GZ Grocery (§103). Read-only. The three channel tabs stay the repair shop;
// this page is the alarm, and every red row ends in a button that opens the
// right tab on the right item.
//
// Everything is painted from GET /api/retail-admin/channel-sync, which is
// lib/channel-sync-items.js — the same read the dashboard's "Channel sync"
// row counts, so the row and this page cannot disagree. The whole root is
// data-no-i18n and rendered in ONE language through cuT(); it repaints itself
// on an EN/CN flip like the Eleme tab does.
//
// The words are the channel tabs' own, on purpose: a state here and the same
// state on the Meituan or Eleme tab must read the same, or the operator has
// to learn two vocabularies for one fact.
(function () {
  'use strict';

  let _data = null;
  let _filter = 'att';      // which chip
  let _channel = '';        // '' = worst across channels; else that channel's own state
  let _q = '';
  let _open = null;         // product id whose row is expanded
  let _loading = null;
  let _langHooked = false;
  let _touched = false;     // has the operator picked a chip themselves
  let _pendingOpen = null;  // a product a Products-list dot asked us to open

  const CH_NAME = { meituan: ['Meituan', '美团'], eleme: ['Eleme', '饿了么'], guanyi: ['GZ Grocery', 'GZ Grocery'] };
  /* THE GLYPH IS A PAIR, NOT A CHARACTER. It was 美 / 饿 / GZ in both
     languages, so an operator reading the app in English got two Chinese
     characters in the Channels column and on the channel cards — reported by
     Ash. The Chinese side is unchanged; the English side is the initials of
     the channel's own English name, which is what the tooltip and the column
     header spell out in full. GZ Grocery is already Latin and needs no twin. */
  const GLYPH = { meituan: ['MT', '美'], eleme: ['EL', '饿'], guanyi: ['GZ', 'GZ'] };
  function chGlyph(k) { const g = GLYPH[k]; return g ? cuT(g[0], g[1]) : ''; }

  /* §103 step 5 — the words moved to 01-core.js's CH_STATE_WORD / CH_REASON_WORD,
     which the three channel tabs now read too. This file kept the only copy
     while it was the only surface; six files ask now, and a copy per file is
     how "Name not in catalogue" and "Listing not found" came to mean one thing
     in two places. These two are thin wrappers so the rest of the file, and the
     product editor that imports them, read unchanged. */
  function word(k) { return chStateWord(k); }
  function cellWord(ch, c) { return chWord(ch, c.k, c.reason); }
  // The sentence an opened row carries for an amber cell — what is wrong and
  // what fixes it. Nothing for a green or grey one.
  function why(ch, c) {
    const name = CH_NAME[ch] ? cuT(CH_NAME[ch][0], CH_NAME[ch][1]) : ch;
    switch (c.reason) {
      case 'push_failed':
        return cuT(`The last push to ${name} failed, so ${name} still shows the previous number.`,
                   `最近一次推送到${name}失败，${name}仍显示之前的数量。`);
      case 'wrong_number':
        return cuT(`${name} holds a different number from the shelf.`,
                   `${name}上的数量与货架不符。`);
      case 'never_synced':
        return cuT(`No push has ever landed on ${name} for this item.`,
                   `该商品从未成功推送到${name}。`);
      case 'no_name':
        return ch === 'meituan'
          ? cuT('No Meituan listing name is set, so stock stays frozen until one is typed.',
                '尚未填写美团商品名，填写前库存不会更新。')
          : cuT('This mapping has no Eleme listing name. A push falls back to the product’s own name, so it can land on the wrong listing or on none.',
                '该匹配没有饿了么商品名。推送会退回使用商品自身名称，可能对上错误商品或对不上。');
      case 'name_not_found':
        return cuT('No listing on this store carries this exact name, so every push resolves to nothing. Pick the name from the list rather than typing it.',
                   '该门店没有完全同名的商品，每次推送都会落空。请从列表中选择商品名，不要手动输入。');
      case 'no_option':
        return cuT('This listing holds several options and this product claims none, so a push would write a made-up number to every one of them.',
                   '该商品有多个规格而本商品未认领任何一个，推送会向每个规格写入编造的数量。');
      default: return '';
    }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function chName(k) { return CH_NAME[k] ? cuT(CH_NAME[k][0], CH_NAME[k][1]) : k; }
  function storeName(st) {
    return document.documentElement.dataset.uiLang === 'cn' ? (st.name || st.nameEn || st.code) : (st.nameEn || st.name || st.code);
  }
  function parseUtc(s) { const t = Date.parse(String(s || '').replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : NaN; }
  function ago(stamp) {
    const t = parseUtc(stamp);
    if (!Number.isFinite(t)) return '';
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1)   return cuT('just now', '刚刚');
    if (m < 60)  return cuT(`${m} min ago`, `${m} 分钟前`);
    const h = Math.round(m / 60);
    if (h < 48)  return cuT(`${h}h ago`, `${h} 小时前`);
    return cuT(`${Math.round(h / 24)}d ago`, `${Math.round(h / 24)} 天前`);
  }
  function clock(stamp) {
    const t = parseUtc(stamp);
    if (!Number.isFinite(t) || typeof tdWhen !== 'function') return '';
    const now = typeof dashNow === 'function' ? dashNow() : Date.now();
    const sameDay = tdWhen(new Date(t), 'machine') === tdWhen(new Date(now), 'machine');
    return tdWhen(new Date(t), sameDay ? 'time' : 'dateTime');
  }
  function itemName(p) {
    const cn = document.documentElement.dataset.uiLang === 'cn';
    const a = cn ? (p.name_cn || p.name_en) : (p.name_en || p.name_cn);
    return (a || ('#' + p.id)) + (p.variant_label ? ' (' + p.variant_label + ')' : '');
  }
  // "Last 18 · 1d ago" — the Meituan tab's footnote, verbatim shape.
  function lastLine(c) {
    if (c.last_pushed_at == null && c.last_pushed_qty == null) return '';
    const parts = [cuT('Last', '上次') + (c.last_pushed_qty != null ? ' ' + c.last_pushed_qty : '')];
    if (c.last_pushed_at) parts.push(ago(c.last_pushed_at));
    return parts.join(' · ');
  }

  // ── State per item, as the chips and the filter see it ─────────────────────
  function stateOf(p) { return _channel ? ((p.channels[_channel] || {}).k || 'none') : p.worst; }

  function visible() {
    const items = (_data && _data.items) || [];
    const q = _q.trim().toLowerCase();
    return items.filter(p => {
      const k = stateOf(p);
      if (_filter !== 'all' && k !== _filter) return false;
      if (!q) return true;
      return [p.name_cn, p.name_en, p.sku, p.variant_label].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }
  function countsFor() {
    const out = { ok: 0, att: 0, off: 0, unk: 0, none: 0, all: 0 };
    for (const p of ((_data && _data.items) || [])) { out[stateOf(p)]++; out.all++; }
    return out;
  }

  // ── Paint ──────────────────────────────────────────────────────────────────
  function render() {
    const root = document.getElementById('cs-root');
    if (!root) return;
    if (!_data) {
      root.innerHTML = '<div class="cs-empty">' + esc(cuT('Loading…', '加载中…')) + '</div>';
      return;
    }
    renderStatus();
    // A search box mid-typing must survive a repaint (the poll below repaints).
    const focused = document.activeElement && document.activeElement.id === 'cs-q';
    root.innerHTML = strip() + tools() + table();
    if (focused) { const q = document.getElementById('cs-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
  }

  function renderStatus() {
    const el = document.getElementById('cs-status');
    if (!el) return;
    const c = _data.counts;
    let html = esc(cuT(`${c.ok} synced`, `${c.ok} 个已同步`));
    if (c.att) html += ' · <span class="att">' + esc(cuT(`${c.att} need attention`, `${c.att} 个待处理`)) + '</span>';
    if (c.none) html += ' · ' + esc(cuT(`${c.none} not listed`, `${c.none} 个未上架`));
    const down = _data.channels.filter(ch => ch.stale);
    if (down.length) {
      html += ' · <span class="att">' + esc(cuT(down.map(ch => chName(ch.key)).join(', ') + ' not syncing',
                                              down.map(ch => chName(ch.key)).join('、') + ' 未同步')) + '</span>';
    } else if (!c.att) {
      html += ' · ' + esc(cuT('nothing needs you', '无需处理'));
    }
    el.innerHTML = html;
  }

  function strip() {
    return '<div class="cs-strip">' + _data.channels.map(ch => {
      const name = chName(ch.key);
      const down = !!ch.stale;
      const idle = !ch.trading;
      let st, sub;
      if (idle) {
        st = '<i class="cs-dot is-off"></i>' + esc(cuT('Not trading', '未营业'));
        sub = '';
      } else if (down) {
        const when = clock(ch.stale.oldest_at);
        st = '<i class="cs-dot is-down"></i>' + esc(cuT(`Not syncing since ${when}`, `自 ${when} 起未同步`));
        sub = esc(cuT(`${ch.stale.waiting_count} stock updates waiting — the numbers ${name} shows may be wrong.`,
                      `${ch.stale.waiting_count} 条库存更新等待中 — ${name}显示的数量可能有误。`));
      } else {
        const last = ch.last_push_at ? cuT(`last push ${ago(ch.last_push_at)}`, `上次推送 ${ago(ch.last_push_at)}`) : cuT('never synced', '从未同步');
        st = '<i class="cs-dot is-ok"></i>' + esc(cuT(`Syncing · ${last}`, `同步中 · ${last}`));
        const n = ch.counts;
        const bits = [cuT(`${n.ok} synced`, `${n.ok} 个已同步`)];
        if (n.att) bits.push(cuT(`${n.att} need attention`, `${n.att} 个待处理`));
        bits.push(cuT(`${n.none} not listed`, `${n.none} 个未上架`));
        if (ch.waiting) bits.push(cuT(`${ch.waiting} sending…`, `${ch.waiting} 发送中…`));
        sub = esc(bits.join(' · '));
      }
      const stores = ch.stores.map(s => {
        let t;
        if (!s.connected) t = cuT('Store not connected', '门店未关联');
        else if (s.catalogue && s.catalogue.count) t = cuT(`${s.catalogue.count} listings read`, `已读取 ${s.catalogue.count} 个商品`) + (s.catalogue.at ? ' · ' + ago(s.catalogue.at) : '');
        else t = cuT('no listings read yet', '尚未读取商品');
        return '<div class="cs-store"><i class="cs-dot ' + (s.connected ? 'is-ok' : 'is-none') + '"></i><span>' + esc(storeName(s) + ' · ' + t) + '</span></div>';
      }).join('');
      return '<div class="cs-ch' + (down ? ' is-down' : '') + (idle ? ' is-idle' : '') + '">' +
        '<div class="cs-nm"><span class="cs-glyph">' + esc(chGlyph(ch.key)) + '</span><span>' + esc(name) + '</span></div>' +
        '<div class="cs-st">' + st + '</div>' +
        (sub ? '<div class="cs-sub">' + sub + '</div>' : '') +
        (ch.stores.length > 1 || !ch.stores.every(s => s.connected) ? '<div class="cs-stores">' + stores + '</div>' : '') +
        '<div class="cs-act"><button type="button" class="btn btn-sm" onclick="goTab(\'' + ch.tab + '\')">' +
          esc(cuT(`Open ${name}`, `前往${name}`)) + '</button></div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function tools() {
    const c = countsFor();
    const chip = (id, label, n) =>
      '<button type="button" class="el-fchip' + (_filter === id ? ' on' : '') + '" onclick="csFilter(\'' + id + '\')">' +
        esc(label) + ' <span class="cs-c">' + n + '</span></button>';
    let chips = chip('att', word('att'), c.att) + chip('ok', word('ok'), c.ok) + chip('none', word('none'), c.none);
    if (c.off) chips += chip('off', word('off'), c.off);
    if (c.unk) chips += chip('unk', word('unk'), c.unk);
    chips += chip('all', cuT('All items', '全部商品'), c.all);
    const opt = (v, label) => '<option value="' + v + '"' + (_channel === v ? ' selected' : '') + '>' + esc(label) + '</option>';
    const sel = '<select id="cs-ch" onchange="csChannel(this.value)" aria-label="' + esc(cuT('Channel', '渠道')) + '">' +
      opt('', cuT('All channels', '全部渠道')) + _data.channels.map(ch => opt(ch.key, chName(ch.key))).join('') + '</select>';
    const search = '<input type="search" id="cs-q" value="' + esc(_q) + '" placeholder="' + esc(cuT('Search', '搜索')) + '" oninput="csSearch(this.value)">';
    return '<div class="cs-tools"><div class="el-chips">' + chips + '</div><span class="cs-grow"></span>' + sel + search + '</div>';
  }

  function cell(chKey, c) {
    let q = '';
    if (c.k === 'att' && (c.reason === 'wrong_number' || c.reason === 'push_failed') && c.last_pushed_qty != null) {
      q = '<span class="cs-q">' + esc(cuT(`last ${c.last_pushed_qty}`, `上次 ${c.last_pushed_qty}`)) + '</span>';
    } else if (c.k === 'ok' && c.reason === 'synced' && c.last_pushed_qty != null) {
      q = '<span class="cs-q">' + c.last_pushed_qty + '</span>';
    }
    return '<span class="cs-cell is-' + c.k + '"><i class="cs-dot is-' + c.k + '"></i><span class="cs-w">' + esc(cellWord(chKey, c)) + '</span>' + q + '</span>';
  }

  function table() {
    const rows = visible();
    if (!rows.length) {
      const msg = _filter === 'att' && !_q
        ? cuT('Nothing needs you.', '无需处理。')
        : cuT('Nothing here.', '暂无商品。');
      return '<div class="cs-wrap"><div class="cs-empty">' + esc(msg) + '</div></div>';
    }
    const head = '<tr><th>' + esc(cuT('Item', '商品')) + '</th><th class="cs-c">' + esc(cuT('Shelf', '库存')) + '</th>' +
      _data.channels.map(ch => '<th>' + esc(chName(ch.key)) + '</th>').join('') + '</tr>';
    const body = rows.map(p => {
      const open = _open === p.id;
      const shelf = Object.values(p.shelf || {});
      const shelfTxt = shelf.length ? shelf.reduce((a, b) => a + Number(b || 0), 0) : '—';
      return '<tr class="row" tabindex="0" data-pid="' + p.id + '" aria-expanded="' + open + '" onclick="csToggle(' + p.id + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();csToggle(' + p.id + ')}">' +
        '<td><div class="cs-item"><span class="cs-n">' + esc(itemName(p)) + '</span>' + (p.sku ? '<span class="cs-s">SKU ' + esc(p.sku) + '</span>' : '') + '</div></td>' +
        '<td class="cs-c cs-shelf">' + esc(String(shelfTxt)) + '</td>' +
        _data.channels.map(ch => '<td>' + cell(ch.key, p.channels[ch.key] || { k: 'none', reason: 'no_map' }) + '</td>').join('') +
        '</tr>' + (open ? detail(p) : '');
    }).join('');
    const foot = '<div class="cs-foot">' + esc(cuT(`${rows.length} items`, `${rows.length} 件商品`)) +
      (_data.channels.some(ch => ch.stale)
        ? ' · ' + esc(cuT('a channel that has stopped syncing is shown once, above, not on every item', '已停止同步的渠道只在上方显示一次，不逐个商品重复'))
        : '') + '</div>';
    return '<div class="cs-wrap"><table class="cs-tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' + foot;
  }

  function detail(p) {
    const cards = _data.channels.map(ch => {
      const c = p.channels[ch.key] || { k: 'none', reason: 'no_map', stores: [] };
      const name = chName(ch.key);
      const stores = (c.stores || []).length > 1
        ? (c.stores || []).map(s => '<div class="cs-store"><i class="cs-dot is-' + s.k + '"></i><span>' + esc(storeName(s) + ' · ' + cellWord(ch.key, s) + (lastLine(s) ? ' · ' + lastLine(s) : '')) + '</span></div>').join('')
        : '';
      const w = why(ch.key, c);
      const facts = [];
      if (!stores && lastLine(c)) facts.push(lastLine(c));
      if (c.k === 'att' && c.expected != null) facts.push(cuT(`shelf says ${c.expected}`, `货架为 ${c.expected}`));
      if (c.platform_qty != null) facts.push(cuT(`${name} holds ${c.platform_qty}`, `${name}库存 ${c.platform_qty}`));
      const err = c.error ? '<div class="cs-err">' + esc(cuT('Push failed', '推送失败') + ': ' + c.error) + '</div>' : '';
      const fix = c.k === 'att'
        ? '<div class="cs-fix"><button type="button" class="btn btn-sm" onclick="event.stopPropagation();csFix(\'' + ch.key + '\',' + p.id + ')">' + esc(cuT(`Open ${name}`, `前往${name}`)) + '</button></div>'
        : '';
      return '<div class="cs-dcard' + (c.k === 'att' ? ' is-att' : '') + '">' +
        '<div class="cs-h"><span>' + esc(name) + '</span>' + cell(ch.key, c) + '</div>' +
        (w ? '<div class="cs-why">' + esc(w) + '</div>' : '') + err +
        (facts.length ? '<div class="cs-facts">' + esc(facts.join(' · ')) + '</div>' : '') +
        stores + fix + '</div>';
    }).join('');
    return '<tr class="cs-detail"><td colspan="' + (2 + _data.channels.length) + '"><div class="cs-dgrid">' + cards + '</div></td></tr>';
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  async function load() {
    if (_loading) return _loading;
    _loading = (async () => {
      try {
        const r = await api('/api/retail-admin/channel-sync');
        _data = r.data || null;
        // Open on what needs you; with nothing needing you, open on everything —
        // an empty "Needs attention" list is the good news, and it is short.
        if (_data && !_data.counts.att && _filter === 'att' && !_touched) _filter = 'all';
      } catch (e) {
        const root = document.getElementById('cs-root');
        if (root) root.innerHTML = '<div class="cs-empty">' + esc(cuT('Could not read the channels', '无法读取渠道') + ' — ' + e.message) + '</div>';
        return;
      } finally { _loading = null; }
      render();
      if (_pendingOpen != null) { const pid = _pendingOpen; _pendingOpen = null; _csScrollTo(pid); }
    })();
    return _loading;
  }

  window.csAdminInit = async function () {
    if (!_langHooked && window.onLangChange) { _langHooked = true; onLangChange(render); }
    render();
    await load();
  };
  // The dashboard row lands here on its chip.
  window.csOpen = function (filter) {
    _touched = true;
    _filter = filter || 'att';
    _channel = '';
    goTab('channel-sync');
    if (_data) render();
  };
  /* Opened from a Products-list dot: land on THAT product rather than on the
     whole catalogue. The chip goes to All items because the operator asked
     about this row and it may well be a green one, and the row opens itself so
     the reason is on screen without a second click. */
  window.csOpenProduct = function (pid) {
    _touched = true; _filter = 'all'; _channel = ''; _q = ''; _open = Number(pid);
    goTab('channel-sync');
    if (_data) { render(); _csScrollTo(Number(pid)); } else { _pendingOpen = Number(pid); }
  };
  function _csScrollTo(pid) {
    const row = document.querySelector('#tab-channel-sync .cs-tbl tr.row[data-pid="' + pid + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* The two sentence-builders, shared with the product editor's Channels card
     (09-products.js pdLoadChannels) so one state cannot be worded two ways on
     two screens. `label` lets the caller pass the channel's display name
     without reaching into this module's own table. */
  window.csChannelName = function (ch) { return chName(ch); };
  window.csChannelGlyph = function (ch) { return chGlyph(ch); };
  window.csCellWordFor = function (ch, c) { return cellWord(ch, c || {}); };
  window.csWhyFor = function (ch, c) { return why(ch, c || {}); };

  window.csFilter = function (id) { _touched = true; _filter = id; _open = null; render(); };
  window.csChannel = function (v) { _touched = true; _channel = v || ''; _open = null; render(); };
  window.csSearch = function (v) { _q = v || ''; render(); };
  window.csToggle = function (pid) { _open = _open === pid ? null : pid; render(); };

  // Open the channel's own tab on this item. The Meituan and Eleme tabs select
  // by product id once their list has loaded; GZ Grocery's is a plain table
  // with a search box, so the item's SKU (or name) goes in the box. The poll
  // waits for the tab's own load rather than assuming it — an init that is
  // still fetching has no row to select yet.
  window.csFix = function (chKey, pid) {
    const p = (_data && _data.items || []).find(x => x.id === pid);
    goTab(chKey);
    let tries = 0;
    const tick = () => {
      tries++;
      if (chKey === 'meituan' && typeof window.mtSelect === 'function' && document.querySelector('#tab-meituan [data-pid="' + pid + '"]')) { mtSelect(pid); return; }
      if (chKey === 'eleme' && typeof window.elSelect === 'function' && document.querySelector('#tab-eleme [data-pid="' + pid + '"]')) { elSelect(pid); return; }
      if (chKey === 'guanyi') {
        const box = document.getElementById('gy-search');
        if (box && document.getElementById('gy-products-body') && p) {
          box.value = p.sku || p.name_en || p.name_cn || '';
          if (typeof window.gyFilterProducts === 'function') gyFilterProducts();
          return;
        }
      }
      if (tries < 40) setTimeout(tick, 150);
    };
    setTimeout(tick, 150);
  };
})();
