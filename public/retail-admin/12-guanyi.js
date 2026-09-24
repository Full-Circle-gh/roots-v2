/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* Guanyi (gzgrocery) Sync admin tab — product mapping + status. */
/* namespace: gy* — mirrors 11-meituan.js but for the Guanyi C-ERP channel. */

(function () {
  'use strict';

  // esc() is defined per-tab in this codebase (not global); the shared helper is
  // escapeHtml() from 01-core.js. Alias it so our markup escaping works.
  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  // Stored timestamps are UTC (SQLite CURRENT_TIMESTAMP / ISO). Render them in
  // the viewer's local timezone so 02:07Z reads as 10:07 here. Tenant-neutral:
  // no hardcoded +8 offset — the browser supplies the zone.
  function gyLocalTime(t, withSeconds) {
    if (!t) return '';
    let s = String(t).trim().replace(' ', 'T');
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';   // bare value = stored UTC
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(t).replace('T', ' ').slice(0, withSeconds ? 19 : 16);
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}:${p(d.getMinutes())}${withSeconds ? ':' + p(d.getSeconds()) : ''}`;
    return `${date} ${time}`;
  }

  let _products = [];   // products + map + suggestion (+ our_qty)
  let _storeCode = '';
  let _initiated = false;
  let _productsLoaded = false;   // mapping table is deferred until its tab opens

  // ── Entry ────────────────────────────────────────────────────────────────
  window.gyAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    // Overview is the default panel: health strip + pickups + a billing snapshot.
    await Promise.all([gyLoadStatus(), gyLoadListings(), gyLoadPickups()]);
    gyLoadAnalytics(false);   // fetch summary for the teaser; don't build the table yet
    gyStartPolling();
    // Mapping's 189-row table stays unbuilt until the Mapping tab is opened.
  };

  // ── Sub-nav: Overview · Billing · Mapping (one panel mounted at a time) ───────
  window.gySubTab = function (name) {
    ['overview', 'billing', 'mapping'].forEach(n => {
      document.getElementById('gy-panel-' + n)?.classList.toggle('active', n === name);
      document.getElementById('gy-nav-' + n)?.classList.toggle('active', n === name);
    });
    // Lazy-build the heavy surfaces the first time they're needed.
    if (name === 'mapping' && !_productsLoaded) { _productsLoaded = true; gyLoadProducts(); }
    if (name === 'billing') { if (_gyAna.data) gyRenderAnalytics(_gyAna.data); else gyLoadAnalytics(); }
  };

  // ── Live refresh while the tab is visible ──────────────────────────────────
  let _pollTimer = null, _pollBusy = false;
  function gyTabVisible() {
    return !document.hidden && !!document.getElementById('tab-guanyi')?.classList.contains('active');
  }
  function gyStartPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(async () => {
      if (_pollBusy || !gyTabVisible()) return;
      _pollBusy = true;
      try { await Promise.all([gyLoadStatus(), gyLoadListings(true), gyLoadPickups(true)]); } catch (_) {}
      finally { _pollBusy = false; }
    }, 12000);
  }

  // Turn one raw sync-log row into a plain, human-readable line.
  // detail is {name, sku, target, was, delta, skipped}; never print raw JSON.
  //
  // We LEAD with what changed — "▲+2 → 28 in stock" — so the number (the whole
  // point) sits near the left edge and never gets lost at the end of a long
  // product name. The direction (▲ added / ▼ removed) comes straight from the
  // recorded delta (or was→target), since Guanyi reconciles by writing a doc for
  // the difference. The product name comes last.
  function gyFmtLogLine(l) {
    let d = {};
    try { d = l.detail ? JSON.parse(l.detail) : {}; } catch { d = {}; }
    const cn = document.documentElement.dataset.uiLang === 'cn';
    const noChange = l.status === 'ok' && d.skipped;
    const glyph = l.status === 'error' ? '✗'
      : l.status === 'skipped' ? '⊘'
      : noChange ? '–' : '✓';
    const time = gyLocalTime(l.created_at, true);

    let change = '';
    if (l.status === 'ok') {
      const tgt = d.target != null ? d.target : '?';
      let delta = d.delta;
      if (delta == null && d.was != null && d.target != null) delta = d.target - d.was;
      if (noChange) {
        change = cn ? `库存 ${tgt}(无变化)` : `${tgt} in stock (no change)`;
      } else if (delta != null && delta !== 0) {
        const arrow = delta > 0 ? '▲' : '▼';
        const sign  = delta > 0 ? `+${delta}` : `${delta}`;   // −1, +2…
        change = cn ? `${arrow}${sign} → 库存 ${tgt}` : `${arrow}${sign} → ${tgt} in stock`;
      } else {
        change = cn ? `库存 ${tgt}` : `${tgt} in stock`;
      }
    }
    const name = d.name || (d.sku ? '' : (cn ? '(无名称)' : '(no name)'));
    const prod = [name, d.sku ? `(${d.sku})` : ''].filter(Boolean).join(' ').trim();
    const reason = l.error_msg ? '  — ' + l.error_msg : '';
    const mid = [change, prod].filter(Boolean).join('  ·  ');
    return `${time}  ${glyph} ${l.store_code}  ${mid}${reason}`.replace(/\s+$/, '');
  }

  /* ── §123 · the page head, in the channel frame ───────────────────────────────
     Was a bespoke one-line health strip. It is now the same four parts the
     Meituan and Eleme pages carry, painted the way elRenderHead() paints them:
     a status line, three tiles, and one line for the product list.

     EVERY WORD HERE IS A LIVE PAIR, none composed. `Mapped · 已映射` and the
     three freshness phrases are this page's own, from the strip that stood
     here. `Need attention · 待处理` is chStateWord('att') — the one table the
     three channel tabs and the Channel sync page all read (§103 step 5).
     `Stock updates waiting · 待推送库存` is the Meituan and Eleme tile whose
     number means exactly this one.

     WHAT IS NOT SAID: "synced". `mappedCount` counts mappings with the switch
     on, which is NOT the same as items the channel holds the right number for —
     that figure is the Channel sync page's `ok` count. Calling this one Synced
     would put two different numbers behind one word on two screens, which is
     the defect §103 step 5 spent a step ending. It is called Mapped, because
     that is what it counts. */
  let _gySt = null;      // last /status
  let _gyLs = null;      // last /listings
  let _gyPk = null;      // last /pickups — the head counts its flagged drops
  let _gyRefreshing = false;   // a Refresh list click is in flight

  function gyRenderHead() {
    const st = _gySt || {};
    const pending = Number(st.queuePending || 0);
    const errors  = Number(st.queueError || 0);
    /* §127 — THE TILE COUNTED THE QUEUE AND THE PAGE COUNTED THE DROPS, so the
       head read "nothing needs you · Needs attention 0" above thirteen pickups
       waiting for a decision. §1.7's work rule is that the status line reports
       WORK WAITING; a flagged drop is work waiting on this operator and nothing
       else on the head knew about it.

       Ash, asked which of three ways to fix it, chose this one: the tile counts
       BOTH. `Needs attention` means *what is waiting on you on this page*, and
       what a page holds differs by page — the same way `Mapped` is a different
       number here and on Meituan. That is not §103 step 5's defect, which was
       two NAMES for one thing (Mapped vs Synced); this is one name for one
       meaning. No string changes: the number in the existing `N need attention`
       shape is just the honest one now, and the status line and the tile agree
       because they read the same total. */
    const flagged = ((_gyPk && _gyPk.flagged) || []).length;
    const attention = errors + flagged;

    const line = document.getElementById('gy-status');
    if (line) {
      const bits = [];
      if (attention) bits.push(cuT(`${attention} need attention`, `${attention} 个待处理`));
      if (pending) bits.push(cuT(`${pending} sending…`, `${pending} 发送中…`));
      // "nothing needs you" is false while the channel is stopped.
      const stopped = st.block && typeof chBlockSentence === 'function' ? chBlockSentence('guanyi', st.block.by) : '';
      if (stopped) {
        line.innerHTML = '<span class="att">' + esc(stopped) + '</span>' + (bits.length ? ' · ' + esc(bits.join(' · ')) : '');
      } else {
        if (!bits.length) bits.push(cuT('nothing needs you', '无需处理'));
        line.innerHTML = attention
          ? '<span class="att">' + esc(bits[0]) + '</span>' + (bits[1] ? ' · ' + esc(bits[1]) : '')
          : esc(bits.join(' · '));
      }
    }

    const tiles = document.getElementById('gy-tiles');
    if (tiles) {
      const tile = (k, v, warn) => '<div class="gy-tile"><div class="k">' + esc(k) + '</div>' +
        '<div class="v' + (warn ? ' att' : '') + '">' + esc(String(v)) + '</div></div>';
      tiles.innerHTML =
        tile(cuT('Mapped', '已映射'), st.mappedCount == null ? '—' : st.mappedCount, false) +
        tile(typeof chStateWord === 'function' ? chStateWord('att') : cuT('Needs attention', '待处理'), attention, attention > 0) +
        tile(cuT('Stock updates waiting', '待推送库存'), pending, false);
    }

    /* One line for the product list, not for a store: GZ Grocery has a single
       store and /status does not name it, so a line pretending to be per-store
       would be a label with nothing behind it. What the line carries is what an
       operator actually needs from it — how many listings were read, how fresh
       that read is, and the button that refreshes it — which is where Eleme
       puts the same three things. */
    const lines = document.getElementById('gy-storelines');
    if (lines) {
      const ls = _gyLs;
      const n = ls ? (ls.listings || []).length : null;
      const busy = _gyRefreshing || !!(ls && ls.running);
      const fresh = busy ? cuT('refreshing…', '刷新中')
        : !ls ? '…'
        : ls.job ? (ls.job.completed_at ? gyLocalTime(ls.job.completed_at, false) : cuT('cached', '已缓存'))
        : cuT('never refreshed', '未刷新');
      const read = n == null ? '' : cuT(`${n} listings read`, `已读取 ${n} 个商品`);
      // A stopped channel says why first, amber like the Meituan and Eleme lines.
      // Reading listings once proved nothing about being signed in now.
      const blk = st.block || null;
      const why = blk && typeof chBlockSentence === 'function' ? chBlockSentence('guanyi', blk.by) : '';
      lines.innerHTML =
        '<div class="gy-storeline' + (blk ? ' att' : '') + '"><span class="dot"></span>' +
        '<span class="nm">' + esc(typeof csChannelName === 'function' ? csChannelName('guanyi') : 'GZ Grocery') + '</span>' +
        '<span class="st">' + esc([why, read, fresh].filter(Boolean).join(' · ')) + '</span>' +
        '<button id="gy-refresh-btn" class="btn btn-sm" onclick="gyRefreshListings()"' +
        (busy ? ' disabled' : '') + '>' +
        esc(cuT('⟳ Refresh list', '⟳ 刷新')) + '</button></div>';
    }
  }

  window.gyLoadStatus = async function () {
    try {
      const r = await api('/api/retail-admin/guanyi/status');
      _gySt = r;
      setText('gy-nav-map-amt', r.mappedCount);
      gyRenderHead();
      // The sync log lives in the Activity tab now; keep the write conditional.
      const log = document.getElementById('gy-log');
      if (log) {
        log.textContent = (r.recentLogs || []).map(gyFmtLogLine).join('\n')
          || 'No activity yet · 暂无记录';
      }
    } catch (e) { console.warn('[guanyi] status', e); }
  };

  // ── Listings cache + refresh job ─────────────────────────────────────────────
  window.gyLoadListings = async function (silent) {
    try {
      const r = await api('/api/retail-admin/guanyi/listings');
      // §123 — the count, the freshness and the Refresh button are one line now,
      // painted by gyRenderHead() from this response. The disabled state rides
      // on that paint rather than being poked onto the button afterwards.
      _gyLs = r;
      gyRenderHead();
      return r;
    } catch (e) { if (!silent) console.warn('[guanyi] listings', e); }
  };

  // Refresh the Guanyi product list via the daemon, polling until the job lands.
  window.gyRefreshListings = async function () {
    /* §123 — THE BUTTON IS NOT HELD, A FLAG IS. This used to capture the button
       node and re-enable it in `finally`. The button now lives inside the store
       line, which gyRenderHead() REPAINTS on every poll below — so the captured
       node is detached within two seconds and the `finally` re-enabled a dead
       element. It happened to look right only because each repaint painted the
       correct state anyway; the day a repaint stopped, the button would have
       stayed disabled forever. The flag makes the render the single owner, and
       the disabled text is the line's own bilingual "refreshing…" rather than
       an English-only label poked onto the node. */
    _gyRefreshing = true;
    gyRenderHead();
    try {
      await api('/api/retail-admin/guanyi/listings/refresh', { method: 'POST' });
      // Poll the job up to ~60s.
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const r = await gyLoadListings(true);
        if (r && !r.running) break;
      }
      await gyLoadProducts();
      toast('Guanyi product list refreshed · 已刷新');
    } catch (e) {
      toast('Refresh failed: ' + e.message, 'error');
    } finally {
      _gyRefreshing = false;
      gyRenderHead();
    }
  };

  // ── Auto-match by SKU embedded in the Guanyi name ─────────────────────────────
  window.gyAutoMatch = async function () {
    try {
      const r = await api('/api/retail-admin/guanyi/auto-match', { method: 'POST' });
      if (r.note) { toast(r.note); return; }
      let msg = `Matched ${r.matched} product(s)`;
      if (r.ambiguous && r.ambiguous.length) msg += ` · ${r.ambiguous.length} ambiguous`;
      if (r.unmatched) msg += ` · ${r.unmatched} unmatched`;
      toast(msg);
      await Promise.all([gyLoadProducts(), gyLoadStatus()]);
    } catch (e) { toast('Auto-match failed: ' + e.message, 'error'); }
  };

  // ── Products + mapping table ──────────────────────────────────────────────────
  window.gyLoadProducts = async function () {
    // Whether each reconcile LANDED — see the twin in 11-meituan.js. Kicked
    // from the loader rather than the init because this table is not built
    // until the Mapping tab is opened. Non-blocking; repaints when it lands.
    chLoadVerdicts('guanyi').then(function () { gyRenderProducts(); });
    const body = document.getElementById('gy-products-body');
    if (body && !_products.length) body.innerHTML = '<tr><td colspan="6" class="gy-tblmsg">Loading…</td></tr>';
    try {
      const r = await api('/api/retail-admin/guanyi/products');
      _products = r.data || [];
      _storeCode = r.storeCode || '';
      gyRenderProducts();
    } catch (e) {
      if (body) body.innerHTML = `<tr><td colspan="6" class="gy-tblmsg">Error: ${esc(e.message)}</td></tr>`;
    }
  };

  function gyRenderProducts() {
    const body = document.getElementById('gy-products-body');
    if (!body) return;
    const term = (document.getElementById('gy-search')?.value || '').trim().toLowerCase();
    const unmappedOnly = !!document.getElementById('gy-show-unmapped')?.checked;

    const rows = _products.filter(p => {
      if (unmappedOnly && p.map) return false;
      if (!term) return true;
      return [p.name_cn, p.name_en, p.product_sku, p.map && p.map.guanyi_name]
        .filter(Boolean).join(' ').toLowerCase().includes(term);
    });

    setText('gy-count', `${rows.length} / ${_products.length}`);
    if (!rows.length) { body.innerHTML = '<tr><td colspan="6" class="gy-tblmsg">No products</td></tr>'; return; }

    body.innerHTML = rows.map(p => {
      const name = esc([p.name_cn, p.name_en].filter(Boolean).join(' '))
        + (p.variant_label ? ` <span class="muted">(${esc(p.variant_label)})</span>` : '');
      const sku = esc(p.product_sku || '—');
      const ourQty = Number(p.our_qty || 0);

      // Guanyi side: prefer the saved mapping, else the auto-match suggestion.
      const m = p.map, sg = p.suggestion;
      let gyCell, gyQty, sync, delta = '';
      // §103 step 5 — THIS TAB HAD NO VOCABULARY AT ALL. Its siblings each had
      // seven or eight state phrases; this one had "no match", a bind button and
      // a delta, none of which says whether the product is in step. So an
      // operator could read this screen top to bottom and not learn what the
      // other two tabs tell you at a glance. It gets the SAME four words, from
      // the same shared table (01-core.js chWord), and the same dot.
      //
      // The comparison is our shelf against what we last reconciled GZ Grocery
      // to — `last_pushed_qty`, which for this ERP is "the target we last
      // reconciled to" (database.js) and is exactly what lib/channel-sync-items
      // compares server-side. The Δ column beside it keeps showing the ERP's own
      // number, which is a different and also useful fact.
      const gLocal = (() => {
        if (!m || !m.guanyi_sku_id) return { k: 'none', reason: 'no_map' };
        if (Number(m.sync_enabled) !== 1) return { k: 'off', reason: 'sync_off' };
        if (m.last_pushed_qty == null) return { k: 'att', reason: 'never_synced' };
        return Number(m.last_pushed_qty) === ourQty
          ? { k: 'ok', reason: 'synced' } : { k: 'att', reason: 'wrong_number' };
      })();
      // …and whether the last reconcile actually landed is the server's to say.
      const gSt = chApplyVerdict('guanyi', p.id, _storeCode, gLocal) || gLocal;
      const stateCell = '<span class="gy-state" title="' + esc(typeof csWhyFor === 'function' ? csWhyFor('guanyi', gSt) : '')
        + '"><i class="cs-dot is-' + gSt.k + '"></i>' + esc(chWord('guanyi', gSt.k, gSt.reason)) + '</span>';
      if (m) {
        const gqty = sg ? Number(sg.current_qty) : null;
        gyCell = `<div>${esc(m.guanyi_name || '—')}</div>
          <div class="sub">${esc(m.guanyi_code || '')}
            <button class="btn btn-sm unbind" onclick="gyUnbind(${p.id})" title="Unbind">✕</button></div>`;
        gyQty = gqty == null ? '<span class="muted">?</span>' : String(gqty);
        if (gqty != null) {
          const d = ourQty - gqty;
          /* §1.10 — IF A COLOUR DOES NOT ENCODE A STATE, DO NOT USE IT. This
             was Sage for a match, Amber one way and Brick the other. Brick
             means error, and holding three more than Guanyi is the same state
             as holding three fewer — "out of step" — so one of the two was
             always lying. The State column beside it already carries that
             state, in the shared four words and the shared dot. The delta is
             the size of the gap, which is information: Graphite. */
          delta = `<span class="muted">${d === 0 ? '=' : (d > 0 ? '+' : '') + d}</span>`;
        }
        sync = `<label class="toggle-label" title="Enable/disable sync"><input type="checkbox" ${m.sync_enabled ? 'checked' : ''} onchange="gyToggleSync(${p.id}, this.checked)"></label>`;
      } else if (sg) {
        gyCell = `<div>${esc(sg.guanyi_name)}</div>
          <div class="sub"><button class="btn btn-sm" onclick="gyBind(${p.id}, '${esc(String(sg.sku_id))}')">Bind →</button></div>`;
        gyQty = sg.current_qty == null ? '<span class="muted">?</span>' : String(sg.current_qty);
        sync = '<span class="muted">—</span>';
      } else {
        gyCell = '<span class="muted">no match</span>';
        gyQty = '<span class="muted">—</span>';
        sync = '<span class="muted">—</span>';
      }

      return `<tr>
        <td>${name}<div class="sub">SKU ${sku}</div></td>
        <td class="ctr qty">${ourQty}</td>
        <td>${gyCell}</td>
        <td class="ctr">${gyQty} ${delta}</td>
        <td data-no-i18n>${stateCell}</td>
        <td class="ctr">${sync}</td>
      </tr>`;
    }).join('');
  }

  window.gyFilterProducts = gyRenderProducts;

  // ── Mapping actions ───────────────────────────────────────────────────────────
  async function gyMap(productId, payload, okMsg) {
    const r = await api('/api/retail-admin/guanyi/products/' + productId + '/map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (okMsg) toast(okMsg);
    return r;
  }

  window.gyBind = async function (productId, skuId) {
    try { await gyMap(productId, { skuId, syncEnabled: true }, 'Bound · 已绑定'); await Promise.all([gyLoadProducts(), gyLoadStatus()]); }
    catch (e) { toast('Bind failed: ' + e.message, 'error'); }
  };
  window.gyUnbind = async function (productId) {
    try { await gyMap(productId, { skuId: '' }, 'Unbound · 已解绑'); await Promise.all([gyLoadProducts(), gyLoadStatus()]); }
    catch (e) { toast('Unbind failed: ' + e.message, 'error'); }
  };
  window.gyToggleSync = async function (productId, checked) {
    try { await gyMap(productId, { syncEnabled: !!checked }); }
    catch (e) { toast('Update failed: ' + e.message, 'error'); }
  };

  window.gyPushAll = async function () {
    // The verdicts are about to change wholesale; re-read rather than serve
    // a cached answer from before the push.
    setTimeout(function () { chLoadVerdicts('guanyi', true); }, 4000);
    try {
      const r = await api('/api/retail-admin/guanyi/push-all', { method: 'POST' });
      toast(`Queued ${r.queued} reconcile(s) to Guanyi`);
      await gyLoadStatus();
    } catch (e) { toast('Push failed: ' + e.message, 'error'); }
  };

  // ── gzgrocery pickups (inferred from Guanyi stock drift) ──────────────────────
  window.gyLoadPickups = async function (silent) {
    const wrap = document.getElementById('gy-pickups');
    if (!wrap) return;
    try {
      const r = await api('/api/retail-admin/guanyi/pickups');
      gyRenderPickups(r);
    } catch (e) { if (!silent) console.warn('[guanyi] pickups', e); }
  };

  function gyRenderPickups(r) {
    const wrap = document.getElementById('gy-pickups');
    if (!wrap) return;
    // The head's attention count reads this response, so store it and repaint.
    _gyPk = r;
    gyRenderHead();
    const mode = r.mode || 'off';
    const flagged = r.flagged || [];
    const recent = r.recent || [];
    const sm = r.summary || {};
    const cn = document.documentElement.dataset.uiLang === 'cn';
    // One language only: Chinese name in the CN view, English name in the EN view.
    const pname = (x) => esc(
      (cn ? (x.name_cn || x.name_en) : (x.name_en || x.name_cn))
      || x.guanyi_name || ('#' + x.product_id)
    );
    const psku = (x) => x.product_sku ? `<span class="sku">${esc(x.product_sku)}</span>` : '';
    const when = (t) => gyLocalTime(t, false);

    /* §127 — WAS THE LOUDEST OBJECT ON A QUIET PAGE. The flagged list was a
       full amber field (a color-mix wash, an amber border, amber headings and,
       because #tab-guanyi remaps --brass onto Amber and carried no .btn-primary
       rule, amber Apply buttons too) sitting under a status line that read
       "nothing needs you". Amber is now spent where §1.10 spends it: a tinted
       PILL on the count, and nowhere else.

       THE BADGE IS DUSK, NOT SAGE. Pickup inference reads Guanyi's stock drift
       and lowers your shelf without being asked — it is an automation, and
       §1.10's row for "tacet acted" is --td-dusk-tint plus a breathing dot.
       Sage was wrong: Sage means all-clear, and this badge is not reporting
       that anything is clear, only that something is running. §1.8 rule 2
       exempts automation indicators from the one-Dusk budget, so this is the
       page's Dusk and it costs the header nothing (§1.7 leaves that slot empty
       here — there is no create action).

       EVERY BUTTON IS SECONDARY OR GHOST (§1.8 rule 4). There were thirteen
       filled Apply buttons down the page, one per row. Neither sibling page
       puts a filled button in a list row at all — Meituan has one, in a
       toolbar; Eleme has one, at the top — so the row buttons were not even
       the siblings' pattern, let alone the rulebook's. Apply is Secondary,
       Ignore is Ghost (§1.8: "Ghost — tertiary, in-row").

       NO NEW STRINGS. `Flagged drops · 待确认` is the head of the sentence that
       stood here — "13 flagged drop(s) need your decision · 待确认" — with the
       count lifted out into the pill beside it, where §1.4 puts a count and
       where this page's own sub-tabs already put one. A numeral needs no label. */
    const modeBadge = mode === 'live'
      ? '<span class="gy-pill auto"><i></i>Live</span>'
      : mode === 'shadow'
        ? '<span class="gy-pill idle" title="Detecting + logging only — not changing stock">Shadow</span>'
        : '<span class="gy-pill idle">Off</span>';

    let html = `<div class="gy-act-row">
      <span class="gy-act-h">Gzgrocery pickups · 提货扣减</span> ${modeBadge}
      <span class="gy-act-sum">${sm.appliedEvents24h || 0} applied · ${sm.appliedUnits24h || 0} units (24h)</span>
    </div>`;

    if (flagged.length) {
      html += `<div class="gy-card">
        <div class="gy-cardhead">Flagged drops · 待确认 <span class="gy-npill">${flagged.length}</span></div>`
        + flagged.map(f => {
          const drop = Math.abs(f.drift || 0);
          return `<div class="gy-row">
            <div class="who">
              <div class="nm">${pname(f)}${psku(f)}</div>
              <div class="sub">Guanyi ${f.baseline_qty}→${f.observed_qty} (drop ${drop}) · your stock now ${f.current_qty} · ${when(f.created_at)}</div>
            </div>
            <button class="btn btn-sm" onclick="gyApplyPickup(${f.id})" title="Yes, real sale — lower my stock by ${drop}">Apply −${drop}</button>
            <button class="btn btn-sm btn-ghost" onclick="gyIgnorePickup(${f.id})" title="Glitch — keep my stock, correct Guanyi back up">Ignore</button>
          </div>`;
        }).join('') + `</div>`;
    } else {
      html += `<div class="gy-empty">No flagged drops · 无待确认</div>`;
    }

    if (recent.length) {
      // Preserve the expanded state across the background poll's re-render —
      // otherwise the section snaps shut every refresh cycle.
      const wasOpen = !!wrap.querySelector('#gy-pickups-recent[open]');
      html += `<details class="gy-fold" id="gy-pickups-recent"${wasOpen ? ' open' : ''}><summary>Recent auto-applied pickups (${recent.length}) · 最近自动扣减</summary>
        <div class="gy-foldbody">`
        + recent.map(x => `<div class="gy-foldrow">
            <span class="n">−${x.inferred_pickup}</span>
            <span class="who">${pname(x)}${psku(x)}</span>
            <span class="when">${when(x.created_at)}</span>
          </div>`).join('')
        + `</div></details>`;
    }

    wrap.innerHTML = html;
  }

  window.gyApplyPickup = async function (id) {
    try {
      await api('/api/retail-admin/guanyi/pickups/' + id + '/apply', { method: 'POST' });
      toast('Applied · stock lowered · 已扣减');
      await Promise.all([gyLoadPickups(true), gyLoadProducts(), gyLoadStatus()]);
    } catch (e) { toast('Apply failed: ' + e.message, 'error'); }
  };
  window.gyIgnorePickup = async function (id) {
    try {
      await api('/api/retail-admin/guanyi/pickups/' + id + '/ignore', { method: 'POST' });
      toast('Ignored · Guanyi will be corrected · 已忽略');
      await gyLoadPickups(true);
    } catch (e) { toast('Ignore failed: ' + e.message, 'error'); }
  };

  // ── gzgrocery analytics & billing ─────────────────────────────────────────────
  // Reads the live /guanyi/analytics endpoint (billable units = applied pickups ×
  // imported gzgrocery pricing) and renders the dashboard + Statement CSV export.
  // period '' = no preset selected (all-time default view); Day/Week/Month set it.
  const _gyAna = { period: '', from: '', to: '', data: null };

  // Local YYYY-MM-DD (not UTC) so "today" matches the viewer's calendar day.
  function gyYmd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // Day/Week/Month are quick period presets: they re-scope the date range so the
  // summary cards reflect the chosen window (and the breakdown buckets by it too).
  function gyPeriodRange(p) {
    const now = new Date();
    const today = gyYmd(now);
    if (p === 'week') {
      const dow = (now.getDay() + 6) % 7;            // Mon=0 … Sun=6
      const mon = new Date(now); mon.setDate(now.getDate() - dow);
      return { from: gyYmd(mon), to: today };
    }
    if (p === 'month') {
      return { from: gyYmd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    }
    return { from: today, to: today };               // day
  }

  window.gySetAnaPeriod = function (p) {
    _gyAna.period = p;
    const r = gyPeriodRange(p);
    _gyAna.from = r.from; _gyAna.to = r.to;
    gyLoadAnalytics();
  };
  window.gyAnaSetRange = function () {
    _gyAna.from = (document.getElementById('gy-ana-from') || {}).value || '';
    _gyAna.to = (document.getElementById('gy-ana-to') || {}).value || '';
    gyLoadAnalytics();
  };

  // renderPanel=false → fetch just for the Overview teaser (skip building the
  // billing table). Defaults to true so period/date changes still redraw the panel.
  window.gyLoadAnalytics = async function (renderPanel) {
    if (renderPanel === undefined) renderPanel = true;
    const wrap = document.getElementById('gy-analytics');
    const qs = new URLSearchParams({ period: _gyAna.period });
    if (_gyAna.from) qs.set('from', _gyAna.from);
    if (_gyAna.to) qs.set('to', _gyAna.to);
    try {
      const r = await api('/api/retail-admin/guanyi/analytics?' + qs.toString());
      _gyAna.data = r;
      gyRenderTeaser(r);
      if (renderPanel && wrap) gyRenderAnalytics(r);
    } catch (e) {
      if (wrap) wrap.innerHTML = `<div class="gy-empty">Analytics error: ${esc(e.message)}</div>`;
    }
  };

  // The Overview "Billing snapshot" — headline numbers without the full table.
  function gyRenderTeaser(r) {
    const s = r.summary || {};
    const yuan = (n) => acWrap(Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    setText('gy-t-owed', yuan(s.owed));
    setText('gy-t-units', Number(s.units || 0).toLocaleString());
    setText('gy-t-products', s.products || 0);
    const amt = document.getElementById('gy-nav-bill-amt');
    if (amt) amt.textContent = acMoneyCompact(s.owed || 0);
  }

  function gyRenderAnalytics(r) {
    const wrap = document.getElementById('gy-analytics');
    if (!wrap) return;
    const yuan = (n) => acWrap(Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const s = r.summary || {};
    const prods = r.products || [];
    const ts = r.timeSeries || [];
    const per = r.period || 'day';
    const btn = (p, label) => `<button class="btn btn-sm ${per === p ? 'btn-primary' : ''}" onclick="gySetAnaPeriod('${p}')">${label}</button>`;

    /* §127 — the summary cards were 11px uppercase labels over 700-weight
       numbers in 8px-radius boxes: a fourth card style on a page that already
       had the frame's tile. They ARE tiles now — the same .gy-tile the head and
       the billing snapshot use — laid out on .gy-cards rather than .gy-tiles
       only because there are five of them and the frame's grid is a three-up
       shared with Meituan. Same for the bars, the fold and the table below:
       every size here is one the page already had. */
    const card = (label, val, sub) => `<div class="gy-tile"><div class="k">${label}</div>` +
      `<div class="v">${val}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;

    let html = `<div class="gy-tools">
      <span class="gy-lb">Period</span> ${btn('day', 'Day')} ${btn('week', 'Week')} ${btn('month', 'Month')}
      <span class="gy-grow"></span>
      <input type="date" class="gy-date" id="gy-ana-from" value="${esc(_gyAna.from)}" onchange="gyAnaSetRange()">
      <span class="gy-lb">→</span>
      <input type="date" class="gy-date" id="gy-ana-to" value="${esc(_gyAna.to)}" onchange="gyAnaSetRange()">
      <button class="btn btn-sm" onclick="gyExportStatement()" ${prods.length ? '' : 'disabled'} title="Download itemized statement as CSV">⤓ Statement CSV</button>
    </div>`;

    html += `<div class="gy-cards">
      ${card('Units ordered', Number(s.units || 0).toLocaleString())}
      ${card('They owe you', yuan(s.owed), 'gzgrocery price')}
      ${card('Retail value', yuan(s.retail))}
      ${card('Avg discount', ((s.avgDiscount || 0) * 100).toFixed(1) + '%')}
      ${card('Products', s.products || 0)}
    </div>`;

    if (r.unpriced && r.unpriced.length) {
      html += `<div class="gy-note">⚠ ${r.unpriced.length} ordered product(s) have no gzgrocery price yet — counted in units but billed at full retail: ${r.unpriced.slice(0, 6).map(u => esc(u.name || ('#' + u.product_id))).join(', ')}${r.unpriced.length > 6 ? '…' : ''}</div>`;
    }

    if (!prods.length) {
      html += `<div class="gy-empty mid">No gzgrocery orders in this range yet · 暂无订货<br>Pickups appear here automatically as gzgrocery sells.</div>`;
      wrap.innerHTML = html; return;
    }

    // simple per-bucket bar list
    if (ts.length) {
      const max = Math.max(...ts.map(t => t.owed)) || 1;
      html += `<details class="gy-fold"><summary>By ${per} (${ts.length})</summary>
        <div class="gy-foldbody">` + ts.map(t => `<div class="gy-foldrow">
          <span class="when" style="width:96px;flex:none">${esc(t.bucket)}</span>
          <span class="gy-bar" style="width:${Math.max(2, (t.owed / max) * 200)}px"></span>
          <span>${yuan(t.owed)}</span><span class="when">· ${t.units}u</span>
          <span class="who"></span>
        </div>`).join('') + `</div></details>`;
    }

    html += `<div class="gy-card"><table class="gy-table"><thead><tr>
      <th style="width:40%">Product</th><th class="num" style="width:15%">Units</th>
      <th class="num" style="width:15%">Owed</th><th class="num" style="width:15%">Retail</th><th class="num" style="width:15%">Disc</th></tr></thead><tbody>`
      + prods.slice(0, 50).map(p => `<tr>
        <td>${esc(p.name || ('#' + p.product_id))} <span class="muted">${esc(p.sku || '')}</span></td>
        <td class="num qty">${p.units}</td>
        <td class="num">${yuan(p.owed)}</td>
        <td class="num muted">${yuan(p.retail)}</td>
        <td class="num">${p.discount == null ? '<span class="muted">—</span>' : (p.discount * 100).toFixed(0) + '%'}</td>
      </tr>`).join('') + `</tbody></table></div>`;
    if (prods.length > 50) html += `<div class="gy-empty">Showing top 50 of ${prods.length} — full list in the CSV.</div>`;

    wrap.innerHTML = html;
  }

  window.gyExportStatement = function () {
    const r = _gyAna.data; if (!r || !r.products) return;
    const rangeLabel = `${r.range && r.range.from || 'start'}_to_${r.range && r.range.to || 'now'}`;
    const head = ['SKU', 'Product', 'Units', 'Unit gz price', 'Owed', 'Retail value', 'Discount %'];
    const lines = [head.join(',')];
    for (const p of r.products) {
      const unit = p.units ? (p.owed / p.units) : 0;
      const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      lines.push([cell(p.sku), cell(p.name), p.units, unit.toFixed(2), p.owed.toFixed(2), p.retail.toFixed(2), p.discount == null ? '' : (p.discount * 100).toFixed(0)].join(','));
    }
    const s = r.summary || {};
    lines.push(['', 'TOTAL', s.units || 0, '', (s.owed || 0).toFixed(2), (s.retail || 0).toFixed(2), ((s.avgDiscount || 0) * 100).toFixed(1)].join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gzgrocery-statement_${rangeLabel}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  // (Billing is now a sub-nav panel; gySubTab lazy-loads analytics on first open.)

  // ── tiny helpers ──────────────────────────────────────────────────────────────
  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = (v == null ? '—' : v); }
})();
